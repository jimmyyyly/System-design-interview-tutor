import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TutorEvent } from "../shared/types.js";
import { Session, type TutorEngine } from "./session.js";
import { ClaudeTutor, EFFORTS } from "./tutor/claude.js";
import { OfflineTutor } from "./tutor/offline.js";

const PORT = Number(process.env.PORT ?? 8787);
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_MESSAGE_CHARS = 4000;

type Mode = "claude" | "offline";

function defaultMode(): Mode {
  const forced = process.env.TUTOR_MODE;
  if (forced === "claude" || forced === "offline") return forced;
  return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? "claude" : "offline";
}

const engines: Record<Mode, () => TutorEngine> = (() => {
  let claude: ClaudeTutor | undefined;
  const offline = new OfflineTutor();
  return {
    claude: () =>
      (claude ??= new ClaudeTutor({
        model: process.env.TUTOR_MODEL,
        effort: EFFORTS.find((e) => e === process.env.TUTOR_EFFORT),
      })),
    offline: () => offline,
  };
})();

const sessions = new Map<string, Session>();
setInterval(
  () => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, s] of sessions) if (s.lastActive < cutoff && !s.busy) sessions.delete(id);
  },
  10 * 60 * 1000,
).unref();

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return "The Claude API rejected the credentials. Set ANTHROPIC_API_KEY, or start a new session in offline mode.";
  }
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Claude API. Wait a moment and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Claude API. Check your network and try again.";
  if (err instanceof Anthropic.APIError) return `Claude API error${err.status ? ` ${err.status}` : ""}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "64kb" }));

  app.get("/api/config", (_req, res) => {
    res.json({ defaultMode: defaultMode() });
  });

  app.post("/api/sessions", (req, res) => {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim().slice(0, 200) : "";
    if (!prompt) return void res.status(400).json({ error: "prompt is required" });
    const mode: Mode = req.body?.mode === "offline" || req.body?.mode === "claude" ? req.body.mode : defaultMode();
    const session = new Session(prompt, mode);
    sessions.set(session.id, session);
    res.status(201).json(session.snapshot());
  });

  app.get("/api/sessions/:id", (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return void res.status(404).json({ error: "session not found" });
    res.json(session.snapshot());
  });

  // One tutor turn, streamed as server-sent events. Omit `text` for the opening turn.
  app.post("/api/sessions/:id/messages", async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return void res.status(404).json({ error: "session not found" });
    const raw = req.body?.text;
    const text = typeof raw === "string" ? raw.trim().slice(0, MAX_MESSAGE_CHARS) : null;
    if (text === "" || (text === null && session.transcript.length > 0)) {
      return void res.status(400).json({ error: "text is required" });
    }
    if (session.busy) return void res.status(409).json({ error: "the tutor is still responding" });

    session.busy = true;
    session.lastActive = Date.now();
    if (text !== null) session.transcript.push({ role: "user", text });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    const emit = (event: TutorEvent) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await engines[session.mode]().runTurn(session, text, emit, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error(err);
        emit({ type: "error", message: describeError(err) });
      }
    } finally {
      session.busy = false;
      session.lastActive = Date.now();
      emit({ type: "turn_end" });
      res.end();
    }
  });

  // Serve the built web client in production.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dist = path.resolve(here, "../../dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createApp().listen(PORT, () => {
    console.log(`System design tutor API on http://localhost:${PORT} (default mode: ${defaultMode()})`);
  });
}
