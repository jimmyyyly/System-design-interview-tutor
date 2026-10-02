import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/index.js";
import type { SessionSnapshot, TutorEvent } from "../src/shared/types.js";

let base = "";
let close = () => {};

beforeAll(async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

async function stream(id: string, body: object): Promise<TutorEvent[]> {
  const res = await fetch(`${base}/api/sessions/${id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
  const raw = await res.text();
  return raw
    .split("\n\n")
    .filter((c) => c.startsWith("data: "))
    .map((c) => JSON.parse(c.slice(6)) as TutorEvent);
}

describe("HTTP API", () => {
  it("creates an offline session and streams turns over SSE", async () => {
    const res = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Design a URL shortener",
        mode: "offline",
      }),
    });
    expect(res.status).toBe(201);
    const snap = (await res.json()) as SessionSnapshot;
    expect(snap.mode).toBe("offline");

    const opening = await stream(snap.id, {});
    expect(opening.at(-1)).toEqual({ type: "turn_end" });
    expect(opening.some((e) => e.type === "text")).toBe(true);

    await stream(snap.id, { text: "shorten and redirect" });
    const events = await stream(snap.id, {
      text: "10M DAU, 1k reads/s, 10 writes/s",
    });
    expect(events.some((e) => e.type === "design")).toBe(true);

    const after = (await (await fetch(`${base}/api/sessions/${snap.id}`)).json()) as SessionSnapshot;
    expect(after.transcript.map((m) => m.role)).toEqual(["tutor", "user", "tutor", "user", "tutor"]);
    expect(after.design.requirements.scale.readQps).toBe(1_000);
  });

  it("validates input", async () => {
    const bad = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/api/sessions/nope`)).status).toBe(404);
  });
});
