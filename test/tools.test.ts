import { describe, expect, it } from "vitest";
import { anthropicTools, toolInputToOp } from "../src/server/tutor/tools.js";

describe("tutor tools", () => {
  it("exposes object JSON schemas without a $schema key", () => {
    const tools = anthropicTools();
    expect(tools.map((t) => t.name)).toEqual([
      "set_requirements",
      "set_phase",
      "add_component",
      "update_component",
      "remove_component",
      "connect",
      "disconnect",
      "challenge",
      "resolve_challenge",
    ]);
    for (const t of tools) {
      expect(t.input_schema.type).toBe("object");
      expect(t.input_schema).not.toHaveProperty("$schema");
    }
    const add = tools.find((t) => t.name === "add_component")!;
    expect(add.input_schema.required).toEqual(expect.arrayContaining(["id", "kind", "label"]));
  });

  it("converts snake_case tool input into design ops", () => {
    expect(
      toolInputToOp("add_component", {
        id: "db",
        kind: "database",
        label: "URLs",
        shards: 4,
        shard_key: "code",
      }),
    ).toEqual({
      ok: true,
      op: {
        op: "add_component",
        component: {
          id: "db",
          kind: "database",
          label: "URLs",
          shards: 4,
          shardKey: "code",
        },
      },
    });
    expect(toolInputToOp("set_requirements", { read_qps: 100, functional: ["a"] })).toMatchObject({
      ok: true,
      op: {
        op: "set_requirements",
        functional: ["a"],
        scale: { readQps: 100 },
      },
    });
    expect(
      toolInputToOp("challenge", {
        question: "What happens at 10x writes?",
        severity: "probe",
      }),
    ).toMatchObject({
      ok: true,
      op: { op: "add_challenge", challenge: { targetIds: [] } },
    });
  });

  it("returns readable validation errors", () => {
    const r = toolInputToOp("add_component", {
      id: "x",
      kind: "mainframe",
      label: "X",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Invalid input for add_component/);
  });
});
