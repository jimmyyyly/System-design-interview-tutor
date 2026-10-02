// Tools the tutor model uses to edit the shared design. Each tool maps 1:1 onto a
// DesignOp so the browser diagram and the model always see the same state.

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { COMPONENT_KINDS, PHASES, type DesignOp } from "../../shared/types.js";

const id = z.string().describe("Short lowercase slug, e.g. 'url-db' or 'redirect-svc'");
const count = z.number().int().min(1).max(1024);

const componentFields = {
  kind: z.enum(COMPONENT_KINDS),
  label: z.string().min(1).max(40).describe("Human-readable name shown on the diagram"),
  tech: z.string().max(40).optional().describe("Concrete technology, e.g. 'PostgreSQL', 'Redis', 'Kafka'"),
  replicas: count.optional().describe("Instances / read replicas (default 1)"),
  shards: count.optional().describe("Shards / partitions (default 1)"),
  shard_key: z.string().max(60).optional(),
  notes: z.string().max(200).optional().describe("One-line rationale or detail, shown on hover"),
};

interface ToolSpec<S extends z.ZodType> {
  description: string;
  schema: S;
  toOp: (input: z.infer<S>) => DesignOp;
}

function spec<S extends z.ZodType>(s: ToolSpec<S>): ToolSpec<S> {
  return s;
}

export const TOOL_SPECS = {
  set_requirements: spec({
    description:
      "Record agreed requirements and scale estimates. Call once the candidate has stated or agreed to them. Omitted fields keep their previous value; lists replace the previous list.",
    schema: z.object({
      functional: z.array(z.string().max(120)).max(12).optional(),
      non_functional: z.array(z.string().max(120)).max(12).optional(),
      dau: z.number().nonnegative().optional().describe("Daily active users"),
      read_qps: z.number().nonnegative().optional().describe("Average read requests/sec"),
      write_qps: z.number().nonnegative().optional().describe("Average write requests/sec"),
      storage_tb: z.number().nonnegative().optional().describe("Total storage over the planning horizon, TB"),
    }),
    toOp: (i) => ({
      op: "set_requirements",
      functional: i.functional,
      nonFunctional: i.non_functional,
      scale: {
        dau: i.dau,
        readQps: i.read_qps,
        writeQps: i.write_qps,
        storageTb: i.storage_tb,
      },
    }),
  }),
  set_phase: spec({
    description: "Move the interview to a new phase. Shown to the candidate as a progress indicator.",
    schema: z.object({ phase: z.enum(PHASES) }),
    toOp: (i) => ({ op: "set_phase", phase: i.phase }),
  }),
  add_component: spec({
    description:
      "Add a box to the architecture diagram. Only add what the candidate proposed or agreed to; never sneak in your own fixes.",
    schema: z.object({ id, ...componentFields }),
    toOp: ({ id, shard_key, ...rest }) => ({
      op: "add_component",
      component: { id, shardKey: shard_key, ...rest },
    }),
  }),
  update_component: spec({
    description: "Change an existing component (e.g. add replicas, shard it, pick a technology). Omitted fields are unchanged.",
    schema: z.object({
      id,
      kind: componentFields.kind.optional(),
      label: componentFields.label.optional(),
      tech: componentFields.tech,
      replicas: componentFields.replicas,
      shards: componentFields.shards,
      shard_key: componentFields.shard_key,
      notes: componentFields.notes,
    }),
    toOp: ({ id, shard_key, ...rest }) => ({
      op: "update_component",
      id,
      patch: { ...rest, shardKey: shard_key },
    }),
  }),
  remove_component: spec({
    description: "Remove a component and all its connections.",
    schema: z.object({ id }),
    toOp: (i) => ({ op: "remove_component", id: i.id }),
  }),
  connect: spec({
    description: "Draw a request/data-flow arrow between two existing components.",
    schema: z.object({
      from: id,
      to: id,
      label: z.string().max(40).optional().describe("What flows, e.g. 'GET /:code' or 'cache-aside'"),
      async: z.boolean().optional().describe("True for queue publishes, events, fire-and-forget"),
    }),
    toOp: (i) => ({
      op: "connect",
      edge: { from: i.from, to: i.to, label: i.label, async: i.async },
    }),
  }),
  disconnect: spec({
    description: "Remove an arrow between two components.",
    schema: z.object({ from: id, to: id }),
    toOp: (i) => ({ op: "disconnect", from: i.from, to: i.to }),
  }),
  challenge: spec({
    description:
      "Pin a pushback question to the board (e.g. 'What happens at 10x write volume?'). Use for the pointed questions you want the candidate to answer; also ask it in your reply.",
    schema: z.object({
      question: z.string().min(5).max(300),
      severity: z.enum(["probe", "concern", "critical"]),
      target_ids: z.array(id).max(6).optional().describe("Components the question is about; they get highlighted"),
    }),
    toOp: (i) => ({
      op: "add_challenge",
      challenge: {
        question: i.question,
        severity: i.severity,
        targetIds: i.target_ids ?? [],
      },
    }),
  }),
  resolve_challenge: spec({
    description:
      "Close a pinned challenge once the candidate has answered it well (addressed) or it no longer applies (dismissed).",
    schema: z.object({
      id: z.string().describe("Challenge id, e.g. 'c2'"),
      status: z.enum(["addressed", "dismissed"]),
      resolution: z.string().max(200).describe("One-line summary of the answer"),
    }),
    toOp: (i) => ({
      op: "resolve_challenge",
      id: i.id,
      status: i.status,
      resolution: i.resolution,
    }),
  }),
} as const;

export type ToolName = keyof typeof TOOL_SPECS;

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOL_SPECS, name);
}

/** Validate a model-supplied tool input and convert it to a DesignOp. */
export function toolInputToOp(name: ToolName, input: unknown): { ok: true; op: DesignOp } | { ok: false; error: string } {
  const s = TOOL_SPECS[name] as ToolSpec<z.ZodType>;
  const parsed = s.schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid input for ${name}: ${z.prettifyError(parsed.error)}`,
    };
  }
  return { ok: true, op: s.toOp(parsed.data) };
}

export function anthropicTools(): Anthropic.Beta.BetaTool[] {
  return Object.entries(TOOL_SPECS).map(([name, s]) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(s.schema) as Record<string, unknown>;
    return {
      name,
      description: s.description,
      input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
      eager_input_streaming: true,
    };
  });
}
