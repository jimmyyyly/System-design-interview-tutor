// Layered layout: one layer per architectural tier (left-to-right, or top-to-bottom
// on narrow screens), with nodes inside a layer ordered by the average position of
// their upstream neighbours to keep edges from crossing.

import type { ComponentKind, Design } from "../../src/shared/types.js";

export const NODE_W = 172;
export const NODE_H = 72;
const PAD = 28;

const TIER: Record<ComponentKind, number> = {
  client: 0,
  dns: 1,
  cdn: 1,
  load_balancer: 2,
  api_gateway: 2,
  service: 3,
  cache: 4,
  queue: 4,
  stream: 4,
  search: 5,
  worker: 5,
  database: 6,
  object_storage: 6,
  external: 6,
};

export type Orientation = "horizontal" | "vertical";

export interface NodePos {
  id: string;
  x: number;
  y: number;
  layer: number;
}

export interface Layout {
  orientation: Orientation;
  nodes: Map<string, NodePos>;
  width: number;
  height: number;
}

export function layoutDesign(design: Design, orientation: Orientation = "horizontal"): Layout {
  const horizontal = orientation === "horizontal";
  // Size of a node along the layer axis and across it, and the gaps between them.
  const along = horizontal ? NODE_W : NODE_H;
  const across = horizontal ? NODE_H : NODE_W;
  const layerGap = horizontal ? 92 : 56;
  const crossGap = horizontal ? 34 : 20;

  // Collapse empty tiers so the diagram stays compact while it's small.
  const usedTiers = [...new Set(design.components.map((c) => TIER[c.kind]))].sort((a, b) => a - b);
  const layerOf = new Map(usedTiers.map((t, i) => [t, i]));
  const layers: string[][] = usedTiers.map(() => []);
  for (const c of design.components) layers[layerOf.get(TIER[c.kind])!]!.push(c.id);

  const slot = new Map<string, number>();
  layers.forEach((layer) => layer.forEach((id, i) => slot.set(id, i)));
  const parents = (id: string) => design.edges.filter((e) => e.to === id).map((e) => e.from);

  // Two barycenter sweeps are plenty for interview-sized diagrams.
  for (let sweep = 0; sweep < 2; sweep++) {
    for (const layer of layers.slice(1)) {
      const score = (id: string) => {
        const ps = parents(id).filter((p) => slot.has(p));
        return ps.length ? ps.reduce((s, p) => s + slot.get(p)!, 0) / ps.length : slot.get(id)!;
      };
      layer.sort((a, b) => score(a) - score(b));
      layer.forEach((id, i) => slot.set(id, i));
    }
  }

  const widest = Math.max(1, ...layers.map((l) => l.length));
  const crossExtent = PAD * 2 + widest * across + (widest - 1) * crossGap;
  const layerExtent = PAD * 2 + Math.max(1, layers.length) * along + Math.max(0, layers.length - 1) * layerGap;
  const nodes = new Map<string, NodePos>();
  layers.forEach((layer, li) => {
    const span = layer.length * across + (layer.length - 1) * crossGap;
    const start = (crossExtent - span) / 2;
    layer.forEach((id, i) => {
      const a = PAD + li * (along + layerGap);
      const c = start + i * (across + crossGap);
      nodes.set(id, horizontal ? { id, x: a, y: c, layer: li } : { id, x: c, y: a, layer: li });
    });
  });
  return horizontal
    ? { orientation, nodes, width: layerExtent, height: crossExtent }
    : { orientation, nodes, width: crossExtent, height: layerExtent };
}

/**
 * Cubic path between two nodes. Edges that skip layers bow outwards so they don't run
 * through the nodes in between; same-layer and backward edges loop around.
 */
export function edgePath(a: NodePos, b: NodePos, orientation: Orientation): { d: string; mx: number; my: number } {
  // Work in (u = along layers, v = across) coordinates, then map back.
  const h = orientation === "horizontal";
  const along = h ? NODE_W : NODE_H;
  const across = h ? NODE_H : NODE_W;
  const toXY = (u: number, v: number) => (h ? [u, v] : [v, u]) as [number, number];
  const au = h ? a.x : a.y;
  const av = (h ? a.y : a.x) + across / 2;
  const bu = h ? b.x : b.y;
  const bv = (h ? b.y : b.x) + across / 2;

  let p0: [number, number], c1: [number, number], c2: [number, number], p3: [number, number];
  if (b.layer > a.layer) {
    const u1 = au + along;
    const u2 = bu;
    const du = Math.max(36, (u2 - u1) / 2);
    const skip = b.layer - a.layer - 1;
    const bow = skip > 0 ? -(across * 0.75 + skip * 14) : 0;
    p0 = [u1, av];
    c1 = [u1 + du, av + bow];
    c2 = [u2 - du, bv + bow];
    p3 = [u2, bv];
  } else if (b.layer === a.layer) {
    const u = au + along;
    const bulge = 46;
    p0 = [u, av];
    c1 = [u + bulge, av];
    c2 = [u + bulge, bv];
    p3 = [u, bv];
  } else {
    const u1 = au;
    const u2 = bu + along;
    const du = Math.max(36, (u1 - u2) / 2);
    p0 = [u1, av];
    c1 = [u1 - du, av + across];
    c2 = [u2 + du, bv + across];
    p3 = [u2, bv];
  }
  // Midpoint of the cubic at t = 0.5, for the label.
  const mid = (i: 0 | 1) => (p0[i] + 3 * c1[i] + 3 * c2[i] + p3[i]) / 8;
  const [x0, y0] = toXY(...p0);
  const [x1, y1] = toXY(...c1);
  const [x2, y2] = toXY(...c2);
  const [x3, y3] = toXY(...p3);
  const [mx, my] = toXY(mid(0), mid(1));
  return { d: `M${x0},${y0} C${x1},${y1} ${x2},${y2} ${x3},${y3}`, mx, my };
}
