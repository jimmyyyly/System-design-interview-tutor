// Claude-backed tutor: a streaming manual tool-use loop. The model edits the
// whiteboard through tools; text deltas stream straight to the browser.

import Anthropic from "@anthropic-ai/sdk";
import type { Emit, Session, TutorEngine } from "../session.js";
import { SYSTEM_PROMPT, whiteboardContext } from "./prompt.js";
import { anthropicTools, isToolName, toolInputToOp } from "./tools.js";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ClaudeTutorOptions {
  client?: Anthropic;
  model?: string;
  effort?: Effort;
  /** Safety valve on tool-use iterations within one candidate turn. */
  maxIterations?: number;
}

export class ClaudeTutor implements TutorEngine {
  private readonly client: Anthropic;
  private readonly tools = anthropicTools();
  private readonly model: string;
  private readonly effort: Effort;
  private readonly maxIterations: number;

  constructor(opts: ClaudeTutorOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? "claude-opus-5-5";
    this.effort = opts.effort ?? "medium";
    this.maxIterations = opts.maxIterations ?? 12;
  }

  async runTurn(session: Session, userText: string | null, emit: Emit, signal: AbortSignal): Promise<void> {
    const opener =
      userText === null
        ? `The candidate's prompt: "${session.prompt}". Open the interview: briefly frame the problem and start the requirements phase.`
        : userText;
    // Append-only history: the whiteboard snapshot rides along with each candidate message.
    session.messages.push({
      role: "user",
      content: [
        { type: "text", text: opener },
        { type: "text", text: whiteboardContext(session.design) },
      ],
    });

    let turnText = "";
    const emitText = (delta: string) => {
      turnText += delta;
      emit({ type: "text", delta });
    };
    let jsonRetries = 0;

    try {
      for (let iteration = 0; iteration < this.maxIterations; iteration++) {
        const stream = this.client.beta.messages.stream(
          {
            model: this.model,
            max_tokens: 64000,
            system: SYSTEM_PROMPT,
            tools: this.tools,
            messages: session.messages,
            cache_control: { type: "ephemeral" },
            output_config: { effort: this.effort },
            // Opt into server-side refusal fallbacks routed by category.
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          },
          { signal },
        );
        stream.on("streamEvent", (event) => {
          // Separate text produced on either side of tool calls.
          if (
            event.type === "content_block_start" &&
            event.content_block.type === "text" &&
            turnText &&
            !turnText.endsWith("\n\n")
          ) {
            emitText("\n\n");
          }
        });
        stream.on("text", emitText);

        let message: Anthropic.Beta.BetaMessage;
        try {
          message = await stream.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          // Eager input streaming: a tool input that isn't parseable JSON rejects the
          // stream. Re-issue the turn (nothing was appended); rethrow API errors.
          if (err instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= 2) throw err;
          continue;
        }

        if (message.stop_reason === "refusal") {
          emit({
            type: "error",
            message: "The tutor declined to continue this turn. Try rephrasing.",
          });
          return;
        }
        if (message.stop_reason === "pause_turn") {
          session.messages.push({
            role: "assistant",
            content: message.content,
          });
          continue;
        }

        const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        if (toolUses.length === 0) {
          session.messages.push({
            role: "assistant",
            content: message.content,
          });
          return;
        }
        if (message.stop_reason === "max_tokens") {
          // A truncated tool input can still parse; don't run it.
          emit({
            type: "error",
            message: "The tutor's response was cut off. Please send your message again.",
          });
          return;
        }

        session.messages.push({ role: "assistant", content: message.content });
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((tu) => {
          if (!isToolName(tu.name)) {
            return {
              type: "tool_result",
              tool_use_id: tu.id,
              is_error: true,
              content: `Unknown tool ${tu.name}`,
            };
          }
          const parsed = toolInputToOp(tu.name, tu.input);
          if (!parsed.ok)
            return {
              type: "tool_result",
              tool_use_id: tu.id,
              is_error: true,
              content: parsed.error,
            };
          const error = session.apply(parsed.op, emit);
          if (error)
            return {
              type: "tool_result",
              tool_use_id: tu.id,
              is_error: true,
              content: error,
            };
          const created = parsed.op.op === "add_challenge" ? ` (pinned as ${session.design.challenges.at(-1)!.id})` : "";
          return {
            type: "tool_result",
            tool_use_id: tu.id,
            content: `ok${created}`,
          };
        });
        session.messages.push({ role: "user", content: results });
      }
      emit({
        type: "error",
        message: "The tutor hit its per-turn step limit. Send another message to continue.",
      });
    } finally {
      if (turnText.trim()) session.transcript.push({ role: "tutor", text: turnText.trim() });
    }
  }
}
