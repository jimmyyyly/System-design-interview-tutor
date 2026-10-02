import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { applyOp, DesignOpError } from "../shared/design.js";
import {
  emptyDesign,
  type ChatEntry,
  type Design,
  type DesignOp,
  type SessionSnapshot,
  type TutorEvent,
} from "../shared/types.js";

export type Emit = (event: TutorEvent) => void;

export class Session {
  readonly id = randomUUID();
  design: Design;
  transcript: ChatEntry[] = [];
  /** Model conversation, append-only (Claude engine only). */
  messages: Anthropic.Beta.BetaMessageParam[] = [];
  /** Free-form per-engine state (offline engine). */
  scratch: Record<string, unknown> = {};
  busy = false;
  lastActive = Date.now();

  constructor(
    readonly prompt: string,
    readonly mode: "claude" | "offline",
  ) {
    this.design = emptyDesign(prompt);
  }

  /** Apply an op, emitting the new design. Returns an error string instead of throwing. */
  apply(op: DesignOp, emit: Emit): string | null {
    try {
      const { design, changed } = applyOp(this.design, op);
      this.design = design;
      emit({ type: "design", design, changed });
      return null;
    } catch (err) {
      if (err instanceof DesignOpError) return err.message;
      throw err;
    }
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      mode: this.mode,
      design: this.design,
      transcript: this.transcript,
    };
  }
}

export interface TutorEngine {
  /** Run one tutor turn in response to `userText` (or the opening turn when `userText` is null). */
  runTurn(session: Session, userText: string | null, emit: Emit, signal: AbortSignal): Promise<void>;
}
