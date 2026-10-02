import type { SessionSnapshot, TutorEvent } from "../../src/shared/types.js";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function getConfig(): Promise<{
  defaultMode: "claude" | "offline";
}> {
  return json(await fetch("/api/config"));
}

export async function createSession(prompt: string, mode: "claude" | "offline"): Promise<SessionSnapshot> {
  return json(
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, mode }),
    }),
  );
}

export async function getSession(id: string): Promise<SessionSnapshot> {
  return json(await fetch(`/api/sessions/${encodeURIComponent(id)}`));
}

/** Run one tutor turn, invoking `onEvent` for each streamed event. */
export async function sendMessage(
  id: string,
  text: string | null,
  onEvent: (e: TutorEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(text === null ? {} : { text }),
    signal,
  });
  if (!res.ok || !res.body) await json(res);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)) as TutorEvent);
      }
    }
  }
}
