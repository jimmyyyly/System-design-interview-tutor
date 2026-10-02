import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { Session } from "../src/server/session.js";
import { ClaudeTutor } from "../src/server/tutor/claude.js";
import type { TutorEvent } from "../src/shared/types.js";

type Block = Anthropic.Beta.BetaContentBlock;

/** Minimal stand-in for client.beta.messages.stream that replays scripted responses. */
function fakeClient(responses: { content: Block[]; stop_reason: Anthropic.Beta.BetaStopReason }[]) {
  const requests: Anthropic.Beta.MessageCreateParams[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Anthropic.Beta.MessageCreateParams) {
          requests.push(structuredClone(params));
          const res = responses.shift();
          if (!res) throw new Error("no more scripted responses");
          const handlers: Record<string, ((x: unknown) => void)[]> = {};
          return {
            on(event: string, cb: (x: unknown) => void) {
              (handlers[event] ??= []).push(cb);
              return this;
            },
            async finalMessage() {
              for (const b of res.content) {
                handlers.streamEvent?.forEach((cb) => cb({ type: "content_block_start", content_block: b }));
                if (b.type === "text") handlers.text?.forEach((cb) => cb(b.text));
              }
              return {
                id: "msg",
                type: "message",
                role: "assistant",
                model: "m",
                content: res.content,
                stop_reason: res.stop_reason,
              };
            },
          };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

const text = (t: string): Block => ({ type: "text", text: t, citations: null }) as Block;
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input }) as Block;

async function turn(tutor: ClaudeTutor, session: Session, msg: string | null) {
  const events: TutorEvent[] = [];
  await tutor.runTurn(session, msg, (e) => events.push(e), new AbortController().signal);
  return events;
}

describe("ClaudeTutor", () => {
  it("applies tool calls to the design and loops until the model stops", async () => {
    const { client, requests } = fakeClient([
      {
        stop_reason: "tool_use",
        content: [
          text("Good start. Drawing that."),
          toolUse("t1", "add_component", {
            id: "lb",
            kind: "load_balancer",
            label: "LB",
          }),
          toolUse("t2", "add_component", {
            id: "app",
            kind: "service",
            label: "App",
            replicas: 3,
          }),
          toolUse("t3", "connect", { from: "lb", to: "app" }),
          toolUse("t4", "connect", { from: "lb", to: "nope" }),
          toolUse("t5", "challenge", {
            question: "What happens when the LB dies?",
            severity: "concern",
            target_ids: ["lb"],
          }),
        ],
      },
      {
        stop_reason: "end_turn",
        content: [text("What happens when the LB dies?")],
      },
    ]);
    const tutor = new ClaudeTutor({ client });
    const session = new Session("Design a URL shortener", "claude");
    const events = await turn(tutor, session, "LB in front of 3 app servers");

    expect(session.design.components.map((c) => c.id)).toEqual(["lb", "app"]);
    expect(session.design.edges).toEqual([{ from: "lb", to: "app" }]);
    expect(session.design.challenges[0]).toMatchObject({
      id: "c1",
      targetIds: ["lb"],
    });
    expect(events.filter((e) => e.type === "design")).toHaveLength(4);

    // Second request carries the tool results, including the error for the bad edge.
    const results = requests[1]!.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results.map((r) => r.tool_use_id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(results[3]).toMatchObject({ is_error: true });
    expect(String(results[3]!.content)).toMatch(/No component with id "nope"/);
    expect(results[4]!.content).toBe("ok (pinned as c1)");

    // Text from both iterations streams, separated, and lands in the transcript.
    const streamed = events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(streamed).toBe("Good start. Drawing that.\n\nWhat happens when the LB dies?");
    expect(session.transcript.at(-1)).toEqual({
      role: "tutor",
      text: streamed,
    });
  });

  it("sends the whiteboard and reviewer notes with each candidate message, append-only", async () => {
    const { client, requests } = fakeClient([
      { stop_reason: "end_turn", content: [text("Let's scope it.")] },
      { stop_reason: "end_turn", content: [text("Numbers?")] },
    ]);
    const tutor = new ClaudeTutor({ client, effort: "high" });
    const session = new Session("Design Discord", "claude");
    await turn(tutor, session, null);
    await turn(tutor, session, "Messaging and presence");

    const first = requests[0]!;
    expect(first.model).toBe("claude-opus-5-5");
    expect(first.output_config).toEqual({ effort: "high" });
    expect(first.fallbacks).toBe("default");
    const opener = first.messages[0]!.content as Anthropic.Beta.BetaTextBlockParam[];
    expect(opener[0]!.text).toContain('"Design Discord"');
    expect(opener[1]!.text).toContain("<whiteboard>");

    // The second request starts with exactly the first request's messages plus the reply.
    const second = requests[1]!;
    expect(second.messages.slice(0, 1)).toEqual(first.messages);
    expect(second.messages[1]!.role).toBe("assistant");
    expect(second.messages).toHaveLength(3);
  });

  it("reports refusals without appending the turn", async () => {
    const { client } = fakeClient([{ stop_reason: "refusal", content: [] }]);
    const session = new Session("x", "claude");
    const events = await turn(new ClaudeTutor({ client }), session, "hi");
    expect(events).toContainEqual(expect.objectContaining({ type: "error" }));
    expect(session.messages).toHaveLength(1);
  });
});
