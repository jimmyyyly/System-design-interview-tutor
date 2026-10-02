import type { Component, Design, DesignOp } from "./types.js";

export class DesignOpError extends Error {}

export interface ApplyResult {
  design: Design;
  /** Component ids touched by the op (used to highlight the diagram). */
  changed: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function findComponent(design: Design, id: string): Component | undefined {
  return design.components.find((c) => c.id === id);
}

function requireComponent(design: Design, id: string): Component {
  const c = findComponent(design, id);
  if (!c) {
    const known = design.components.map((x) => x.id).join(", ") || "(none)";
    throw new DesignOpError(`No component with id "${id}". Known ids: ${known}`);
  }
  return c;
}

function checkCounts(c: Partial<Component>) {
  for (const key of ["replicas", "shards"] as const) {
    const v = c[key];
    if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > 1024)) {
      throw new DesignOpError(`${key} must be an integer between 1 and 1024`);
    }
  }
}

/** Pure reducer: returns a new design, or throws DesignOpError with a message suitable for the model. */
export function applyOp(design: Design, op: DesignOp): ApplyResult {
  switch (op.op) {
    case "add_component": {
      const c = op.component;
      if (!ID_RE.test(c.id)) {
        throw new DesignOpError(`Invalid id "${c.id}": use lowercase letters, digits, - or _ (max 40 chars)`);
      }
      if (findComponent(design, c.id)) {
        throw new DesignOpError(`Component "${c.id}" already exists; use update_component to change it`);
      }
      checkCounts(c);
      return {
        design: { ...design, components: [...design.components, { ...c }] },
        changed: [c.id],
      };
    }
    case "update_component": {
      const existing = requireComponent(design, op.id);
      checkCounts(op.patch);
      const updated: Component = { ...existing, ...stripUndefined(op.patch) };
      return {
        design: {
          ...design,
          components: design.components.map((c) => (c.id === op.id ? updated : c)),
        },
        changed: [op.id],
      };
    }
    case "remove_component": {
      requireComponent(design, op.id);
      const neighbours = design.edges
        .filter((e) => e.from === op.id || e.to === op.id)
        .map((e) => (e.from === op.id ? e.to : e.from));
      return {
        design: {
          ...design,
          components: design.components.filter((c) => c.id !== op.id),
          edges: design.edges.filter((e) => e.from !== op.id && e.to !== op.id),
          challenges: design.challenges.map((ch) => ({
            ...ch,
            targetIds: ch.targetIds.filter((t) => t !== op.id),
          })),
        },
        changed: neighbours,
      };
    }
    case "connect": {
      const { from, to } = op.edge;
      requireComponent(design, from);
      requireComponent(design, to);
      if (from === to) throw new DesignOpError("Cannot connect a component to itself");
      const rest = design.edges.filter((e) => !(e.from === from && e.to === to));
      return {
        design: { ...design, edges: [...rest, { ...op.edge }] },
        changed: [from, to],
      };
    }
    case "disconnect": {
      const exists = design.edges.some((e) => e.from === op.from && e.to === op.to);
      if (!exists) throw new DesignOpError(`No edge ${op.from} -> ${op.to}`);
      return {
        design: {
          ...design,
          edges: design.edges.filter((e) => !(e.from === op.from && e.to === op.to)),
        },
        changed: [op.from, op.to],
      };
    }
    case "set_requirements": {
      const r = design.requirements;
      return {
        design: {
          ...design,
          requirements: {
            functional: op.functional ?? r.functional,
            nonFunctional: op.nonFunctional ?? r.nonFunctional,
            scale: { ...r.scale, ...stripUndefined(op.scale ?? {}) },
          },
        },
        changed: [],
      };
    }
    case "set_phase":
      return { design: { ...design, phase: op.phase }, changed: [] };
    case "add_challenge": {
      for (const id of op.challenge.targetIds) requireComponent(design, id);
      const id = `c${design.challenges.length + 1}`;
      return {
        design: {
          ...design,
          challenges: [...design.challenges, { ...op.challenge, id, status: "open" }],
        },
        changed: op.challenge.targetIds,
      };
    }
    case "resolve_challenge": {
      const ch = design.challenges.find((c) => c.id === op.id);
      if (!ch) throw new DesignOpError(`No challenge with id "${op.id}"`);
      return {
        design: {
          ...design,
          challenges: design.challenges.map((c) => (c.id === op.id ? { ...c, status: op.status, resolution: op.resolution } : c)),
        },
        changed: [],
      };
    }
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Compact, model-readable rendering of the current design. */
export function describeDesign(design: Design): string {
  const lines: string[] = [];
  const r = design.requirements;
  lines.push(`Phase: ${design.phase}`);
  if (r.functional.length) lines.push(`Functional: ${r.functional.join("; ")}`);
  if (r.nonFunctional.length) lines.push(`Non-functional: ${r.nonFunctional.join("; ")}`);
  const s = r.scale;
  const scaleParts = [
    s.dau !== undefined && `DAU=${s.dau}`,
    s.readQps !== undefined && `read QPS=${s.readQps}`,
    s.writeQps !== undefined && `write QPS=${s.writeQps}`,
    s.storageTb !== undefined && `storage=${s.storageTb}TB`,
  ].filter(Boolean);
  if (scaleParts.length) lines.push(`Scale: ${scaleParts.join(", ")}`);
  lines.push("Components:");
  if (!design.components.length) lines.push("  (none yet)");
  for (const c of design.components) {
    const extras = [
      c.tech,
      (c.replicas ?? 1) > 1 && `x${c.replicas} replicas`,
      (c.shards ?? 1) > 1 && `${c.shards} shards${c.shardKey ? ` by ${c.shardKey}` : ""}`,
      c.notes,
    ].filter(Boolean);
    lines.push(`  - ${c.id} [${c.kind}] "${c.label}"${extras.length ? ` (${extras.join("; ")})` : ""}`);
  }
  lines.push("Edges:");
  if (!design.edges.length) lines.push("  (none yet)");
  for (const e of design.edges) {
    lines.push(`  - ${e.from} ${e.async ? "~~>" : "-->"} ${e.to}${e.label ? ` (${e.label})` : ""}`);
  }
  const open = design.challenges.filter((c) => c.status === "open");
  if (open.length) {
    lines.push("Open challenges:");
    for (const c of open) lines.push(`  - ${c.id} [${c.severity}] ${c.question}`);
  }
  return lines.join("\n");
}
