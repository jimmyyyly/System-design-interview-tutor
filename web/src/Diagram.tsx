import { useEffect, useMemo, useRef, useState } from "react";
import type { LoadReport } from "../../src/shared/analysis.js";
import type { Component, ComponentKind, Design, Severity } from "../../src/shared/types.js";
import { edgePath, layoutDesign, NODE_H, NODE_W, type Orientation } from "./layout.js";

const KIND_LABEL: Record<ComponentKind, string> = {
  client: "client",
  dns: "dns",
  cdn: "cdn",
  load_balancer: "load balancer",
  api_gateway: "api gateway",
  service: "service",
  cache: "cache",
  queue: "queue",
  stream: "stream",
  worker: "workers",
  database: "database",
  object_storage: "object store",
  search: "search",
  external: "external",
};

const SEVERITY_RANK: Record<Severity, number> = {
  probe: 0,
  concern: 1,
  critical: 2,
};

export function utilClass(u: number | undefined) {
  if (u === undefined) return "";
  if (u >= 1) return "hot";
  if (u >= 0.7) return "warm";
  return "cool";
}

function fmtPct(u: number) {
  return u >= 10 ? `${Math.round(u)}x` : `${Math.round(u * 100)}%`;
}

interface Props {
  design: Design;
  load: LoadReport | null;
  highlighted: Set<string>;
  selected: string | null;
  onSelect: (id: string | null) => void;
}

export function Diagram({ design, load, highlighted, selected, onSelect }: Props) {
  // Lay out top-to-bottom when the board is narrow (phones), left-to-right otherwise.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [orientation, setOrientation] = useState<Orientation>("horizontal");
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      setOrientation(width < 640 && height > width * 0.6 ? "vertical" : "horizontal");
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const layout = useMemo(() => layoutDesign(design, orientation), [design, orientation]);
  const flagged = useMemo(() => {
    const m = new Map<string, Severity>();
    for (const ch of design.challenges) {
      if (ch.status !== "open") continue;
      for (const id of ch.targetIds) {
        const prev = m.get(id);
        if (!prev || SEVERITY_RANK[ch.severity] > SEVERITY_RANK[prev]) m.set(id, ch.severity);
      }
    }
    return m;
  }, [design.challenges]);

  // Smoothly animate node positions when the layout changes.
  const [shown, setShown] = useState(layout);
  const prev = useRef(layout);
  useEffect(() => {
    const from = prev.current;
    prev.current = layout;
    const start = performance.now();
    let frame = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / 320);
      const e = 1 - Math.pow(1 - k, 3);
      const nodes = new Map(
        [...layout.nodes].map(([id, p]) => {
          const f = from.nodes.get(id) ?? p;
          return [id, { ...p, x: f.x + (p.x - f.x) * e, y: f.y + (p.y - f.y) * e }];
        }),
      );
      setShown({
        orientation: layout.orientation,
        nodes,
        width: from.width + (layout.width - from.width) * e,
        height: from.height + (layout.height - from.height) * e,
      });
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [layout]);

  const byId = new Map(design.components.map((c) => [c.id, c]));

  return (
    <div className="diagram-wrap" ref={wrapRef}>
      {design.components.length === 0 ? (
        <div className="diagram-empty">
          <p>The whiteboard is empty.</p>
          <p className="muted">Components appear here as you and the tutor agree on them.</p>
        </div>
      ) : (
        <svg
          className="diagram"
          viewBox={`0 0 ${Math.max(shown.width, 320)} ${Math.max(shown.height, 200)}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Architecture diagram"
          onClick={() => onSelect(null)}
        >
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="arrowhead" />
            </marker>
          </defs>
          <g className="edges">
            {design.edges.map((e) => {
              const a = shown.nodes.get(e.from);
              const b = shown.nodes.get(e.to);
              if (!a || !b) return null;
              const { d, mx, my } = edgePath(a, b, shown.orientation);
              const active = selected === e.from || selected === e.to;
              return (
                <g key={`${e.from}->${e.to}`} className={`edge${e.async ? " async" : ""}${active ? " active" : ""}`}>
                  <path d={d} markerEnd="url(#arrow)" />
                  {e.label && (
                    <text x={mx} y={my - 6} textAnchor="middle" className="edge-label">
                      {e.label}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
          <g className="nodes">
            {design.components.map((c) => {
              const p = shown.nodes.get(c.id);
              if (!p) return null;
              return (
                <Node
                  key={c.id}
                  c={c}
                  x={p.x}
                  y={p.y}
                  util={load?.components[c.id]?.utilization}
                  flag={flagged.get(c.id)}
                  isNew={highlighted.has(c.id)}
                  selected={selected === c.id}
                  onSelect={onSelect}
                  dimmed={selected !== null && selected !== c.id && !isNeighbour(design, selected, c.id, byId)}
                />
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}

function isNeighbour(design: Design, a: string, b: string, byId: Map<string, Component>) {
  if (!byId.has(a)) return true;
  return design.edges.some((e) => (e.from === a && e.to === b) || (e.to === a && e.from === b));
}

interface NodeProps {
  c: Component;
  x: number;
  y: number;
  util?: number;
  flag?: Severity;
  isNew: boolean;
  selected: boolean;
  dimmed: boolean;
  onSelect: (id: string) => void;
}

function Node({ c, x, y, util, flag, isNew, selected, dimmed, onSelect }: NodeProps) {
  const replicas = c.replicas ?? 1;
  const shards = c.shards ?? 1;
  const stack = Math.min(2, replicas - 1);
  const badges = [replicas > 1 && `×${replicas}`, shards > 1 && `${shards} shards`].filter(Boolean).join(" · ");
  const cls = [
    "node",
    `kind-${c.kind}`,
    utilClass(util),
    flag ? `flag-${flag}` : "",
    isNew ? "fresh" : "",
    selected ? "selected" : "",
    dimmed ? "dimmed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <g
      className={cls}
      transform={`translate(${x},${y})`}
      onClick={(ev) => {
        ev.stopPropagation();
        onSelect(c.id);
      }}
      tabIndex={0}
      role="button"
      aria-label={`${c.label} (${KIND_LABEL[c.kind]})`}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" || ev.key === " ") onSelect(c.id);
      }}
    >
      <title>{[c.label, c.tech, c.notes].filter(Boolean).join(" — ")}</title>
      {Array.from({ length: stack }, (_, i) => (
        <rect key={i} className="stack" x={(stack - i) * 5} y={-(stack - i) * 5} width={NODE_W} height={NODE_H} rx={10} />
      ))}
      {flag && <rect className="flag-ring" x={-5} y={-5} width={NODE_W + 10} height={NODE_H + 10} rx={14} />}
      <rect className="body" width={NODE_W} height={NODE_H} rx={10} />
      <rect className="accent" width={5} height={NODE_H - 16} x={8} y={8} rx={2.5} />
      <text className="kind" x={22} y={20}>
        {KIND_LABEL[c.kind].toUpperCase()}
      </text>
      <text className={`label${c.label.length > 15 ? " long" : ""}`} x={22} y={40}>
        {truncate(c.label, 20)}
      </text>
      <text className="tech" x={22} y={58}>
        {truncate([c.tech, badges].filter(Boolean).join(" · "), 26)}
      </text>
      {util !== undefined && (
        <g className="util">
          <rect className="util-track" x={NODE_W - 46} y={10} width={36} height={14} rx={7} />
          <text className="util-text" x={NODE_W - 28} y={21} textAnchor="middle">
            {fmtPct(util)}
          </text>
        </g>
      )}
    </g>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
