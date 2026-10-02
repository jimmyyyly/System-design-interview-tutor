// Deterministic heuristics over a design: a back-of-the-envelope load model and a
// rule-based critic. The tutor uses these as "reviewer notes" to decide where to
// push back; the UI uses them to colour the diagram and list weak spots.
// The numbers are deliberately rough interview-grade estimates, not benchmarks.

import type { Component, ComponentKind, Design, Severity } from "./types.js";

/** Approximate sustained ops/sec one instance (or shard) of each kind can handle. */
export const CAPACITY: Partial<Record<ComponentKind, { read: number; write: number }>> = {
  load_balancer: { read: 100_000, write: 100_000 },
  api_gateway: { read: 50_000, write: 50_000 },
  service: { read: 2_000, write: 2_000 },
  worker: { read: 1_000, write: 1_000 },
  cache: { read: 100_000, write: 100_000 },
  database: { read: 10_000, write: 3_000 },
  queue: { read: 50_000, write: 50_000 },
  stream: { read: 100_000, write: 100_000 },
  search: { read: 5_000, write: 2_000 },
};

export const CACHE_HIT_RATE = 0.8;

export interface LoadMultiplier {
  read: number;
  write: number;
}

export interface ComponentLoad {
  id: string;
  readDemand: number;
  writeDemand: number;
  readCapacity: number;
  writeCapacity: number;
  /** max(read utilisation, write utilisation); 1.0 = saturated. */
  utilization: number;
  bottleneck: "reads" | "writes";
}

export interface LoadReport {
  readQps: number;
  writeQps: number;
  components: Record<string, ComponentLoad>;
}

const READISH = /read|redirect|feed|query|fetch|get|view|timeline|lookup|search|download|serve/i;
const WRITEISH = /write|create|upload|post|ingest|publish|send|shorten|compose|insert/i;

function trafficRole(c: Component): "read" | "write" | "both" {
  const text = `${c.id} ${c.label}`;
  const r = READISH.test(text);
  const w = WRITEISH.test(text);
  if (r && !w) return "read";
  if (w && !r) return "write";
  return "both";
}

/** Base QPS from explicit numbers, or derived from DAU with typical per-user activity. */
export function baseQps(design: Design): { readQps: number; writeQps: number } | null {
  const s = design.requirements.scale;
  let readQps = s.readQps;
  let writeQps = s.writeQps;
  if (s.dau !== undefined) {
    readQps ??= Math.round((s.dau * 20) / 86_400);
    writeQps ??= Math.round((s.dau * 2) / 86_400);
  }
  if (readQps === undefined && writeQps === undefined) return null;
  return { readQps: readQps ?? 0, writeQps: writeQps ?? 0 };
}

function instances(c: Component) {
  return Math.max(1, c.replicas ?? 1);
}
function shards(c: Component) {
  return Math.max(1, c.shards ?? 1);
}

/** Split `total` evenly across the components that serve that kind of traffic. */
function splitByRole(cs: Component[], R: number, W: number) {
  const readers = cs.filter((c) => trafficRole(c) !== "write");
  const writers = cs.filter((c) => trafficRole(c) !== "read");
  const out = new Map<string, { r: number; w: number }>();
  for (const c of cs) {
    out.set(c.id, {
      r: readers.includes(c) ? R / readers.length : 0,
      w: writers.includes(c) ? W / writers.length : 0,
    });
  }
  return out;
}

export function computeLoad(design: Design, mult: LoadMultiplier = { read: 1, write: 1 }): LoadReport | null {
  const base = baseQps(design);
  if (!base) return null;
  const R = base.readQps * mult.read;
  const W = base.writeQps * mult.write;
  const byKind = (k: ComponentKind) => design.components.filter((c) => c.kind === k);
  const hasCache = byKind("cache").length > 0;

  const demand = new Map<string, { r: number; w: number }>();
  const put = (m: Map<string, { r: number; w: number }>) => m.forEach((v, k) => demand.set(k, v));

  // Entry tiers see everything; parallel LBs/gateways share it.
  put(splitByRole(byKind("load_balancer"), R, W));
  put(splitByRole(byKind("api_gateway"), R, W));
  put(splitByRole(byKind("service"), R, W));
  put(splitByRole(byKind("cache"), R, hasCache ? W * 0.5 : 0)); // invalidations / write-through
  put(splitByRole(byKind("queue"), 0, W));
  put(splitByRole(byKind("stream"), 0, W));
  put(splitByRole(byKind("worker"), 0, W));
  put(splitByRole(byKind("search"), R * 0.3, W));
  // Databases: a cache absorbs most reads. Queues in front smooth write bursts but the
  // steady-state write rate still lands on the database.
  put(splitByRole(byKind("database"), hasCache ? R * (1 - CACHE_HIT_RATE) : R, W));

  const components: Record<string, ComponentLoad> = {};
  for (const c of design.components) {
    const cap = CAPACITY[c.kind];
    const d = demand.get(c.id);
    if (!cap || !d) continue;
    let readCapacity: number;
    let writeCapacity: number;
    if (c.kind === "database" || c.kind === "search") {
      // Replicas (incl. primary) serve reads; only shards add write capacity.
      readCapacity = cap.read * shards(c) * instances(c);
      writeCapacity = cap.write * shards(c);
    } else {
      const n = instances(c) * shards(c);
      readCapacity = cap.read * n;
      writeCapacity = cap.write * n;
    }
    // Generic services handle mixed traffic out of one pool.
    const mixed = c.kind !== "database" && c.kind !== "search";
    const readUtil = mixed ? (d.r + d.w) / readCapacity : d.r / readCapacity;
    const writeUtil = mixed ? 0 : d.w / writeCapacity;
    components[c.id] = {
      id: c.id,
      readDemand: d.r,
      writeDemand: d.w,
      readCapacity,
      writeCapacity,
      utilization: Math.max(readUtil, writeUtil),
      bottleneck: writeUtil > readUtil || (mixed && d.w > d.r) ? "writes" : "reads",
    };
  }
  return { readQps: R, writeQps: W, components };
}

export interface Finding {
  id: string;
  severity: Severity;
  message: string;
  targetIds: string[];
}

const STATEFUL_OR_CHOKEPOINT: ComponentKind[] = ["load_balancer", "api_gateway", "database", "cache", "queue", "stream"];

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${Math.round(n)}`;
}

export function critique(design: Design): Finding[] {
  const out: Finding[] = [];
  const cs = design.components;
  const byId = new Map(cs.map((c) => [c.id, c]));
  const outgoing = (id: string) => design.edges.filter((e) => e.from === id);
  const incoming = (id: string) => design.edges.filter((e) => e.to === id);

  if (cs.length === 0) return out;

  // 1. Clients talking straight to application servers.
  for (const e of design.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (a?.kind === "client" && (b?.kind === "service" || b?.kind === "database")) {
      out.push({
        id: `direct-${b.id}`,
        severity: "concern",
        message: `Clients call ${b.label} directly. How do you add instances, deploy without downtime, or survive one box dying? Consider a load balancer or API gateway in front.`,
        targetIds: [b.id],
      });
    }
  }

  // 2. Single points of failure (only once the sketch has some substance).
  if (cs.length >= 4) {
    for (const c of cs) {
      if (STATEFUL_OR_CHOKEPOINT.includes(c.kind) && (c.replicas ?? 1) <= 1) {
        out.push({
          id: `spof-${c.id}`,
          severity: c.kind === "database" ? "critical" : "concern",
          message: `${c.label} is a single instance. What happens to the system when it fails, and how long is recovery?`,
          targetIds: [c.id],
        });
      }
    }
  }

  // 3. Dangling components.
  for (const c of cs) {
    if (c.kind !== "client" && outgoing(c.id).length === 0 && incoming(c.id).length === 0) {
      out.push({
        id: `orphan-${c.id}`,
        severity: "probe",
        message: `${c.label} isn't connected to anything. What talks to it, and what does it talk to?`,
        targetIds: [c.id],
      });
    }
  }
  for (const c of cs) {
    if ((c.kind === "queue" || c.kind === "stream") && outgoing(c.id).length === 0 && incoming(c.id).length > 0) {
      out.push({
        id: `noconsumer-${c.id}`,
        severity: "concern",
        message: `Messages go into ${c.label} but nothing consumes them. Who processes them, and what happens on consumer failure (retries, DLQ, idempotency)?`,
        targetIds: [c.id],
      });
    }
  }

  // 4. Long synchronous service chains.
  const svc = cs.filter((c) => c.kind === "service");
  const syncSvcChildren = (id: string) =>
    outgoing(id)
      .filter((e) => !e.async && byId.get(e.to)?.kind === "service")
      .map((e) => e.to);
  const depth = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    return 1 + Math.max(0, ...syncSvcChildren(id).map((c) => depth(c, new Set(seen))));
  };
  for (const s of svc) {
    if (incoming(s.id).some((e) => byId.get(e.from)?.kind === "service")) continue;
    if (depth(s.id, new Set()) >= 3) {
      out.push({
        id: `chain-${s.id}`,
        severity: "concern",
        message: `Requests through ${s.label} fan through 3+ synchronous service hops. Latency adds up and one slow dependency cascades. Which hops could be async, cached, or collapsed?`,
        targetIds: [s.id, ...syncSvcChildren(s.id)],
      });
    }
  }

  // 5. Read-heavy without a cache.
  const base = baseQps(design);
  const dbs = cs.filter((c) => c.kind === "database");
  if (base && dbs.length && !cs.some((c) => c.kind === "cache") && base.readQps >= 5 * Math.max(1, base.writeQps)) {
    out.push({
      id: "no-cache",
      severity: "concern",
      message: `Reads outnumber writes ~${Math.round(base.readQps / Math.max(1, base.writeQps))}:1 and every read hits the database. Where would a cache go, what's the key, and how do you keep it fresh?`,
      targetIds: dbs.map((d) => d.id),
    });
  }

  // 6. Capacity: saturated now, or saturated at 10x writes.
  const now = computeLoad(design);
  const tenX = computeLoad(design, { read: 1, write: 10 });
  if (now && tenX) {
    for (const c of cs) {
      const l = now.components[c.id];
      const l10 = tenX.components[c.id];
      if (!l || !l10) continue;
      if (l.utilization > 1) {
        out.push({
          id: `overload-${c.id}`,
          severity: "critical",
          message: `${c.label} is already over capacity: ~${fmt(l.bottleneck === "writes" ? l.writeDemand : l.readDemand)} ${l.bottleneck}/s against ~${fmt(l.bottleneck === "writes" ? l.writeCapacity : l.readCapacity)}/s. How do you scale it?`,
          targetIds: [c.id],
        });
      } else if (l10.utilization > 1 && l10.bottleneck === "writes") {
        out.push({
          id: `10x-${c.id}`,
          severity: "probe",
          message: `At 10x write volume (~${fmt(l10.writeDemand)} writes/s) ${c.label} saturates (capacity ~${fmt(l10.writeCapacity)}/s). What changes: sharding, batching, a write-optimised store, async ingestion?`,
          targetIds: [c.id],
        });
      }
    }
  }

  // 7. Shards without a key.
  for (const c of cs) {
    if ((c.shards ?? 1) > 1 && !c.shardKey) {
      out.push({
        id: `shardkey-${c.id}`,
        severity: "probe",
        message: `${c.label} has ${c.shards} shards but no shard key. What do you partition on, and what does that do to hot keys and cross-shard queries?`,
        targetIds: [c.id],
      });
    }
  }

  return out;
}
