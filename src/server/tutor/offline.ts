// Offline tutor: a scripted, rule-based interviewer used when no Claude credentials
// are configured (and in tests). It recognises common components in the candidate's
// messages, wires them onto the board, and pushes back using the deterministic critic.
// It's far less flexible than the Claude tutor, but it runs anywhere.

import { computeLoad, critique, type Finding } from "../../shared/analysis.js";
import type { Component, ComponentKind, Design, DesignOp, Scale } from "../../shared/types.js";
import type { Emit, Session, TutorEngine } from "../session.js";

interface Template {
  match: RegExp;
  name: string;
  functional: string[];
  nonFunctional: string[];
  scale: Scale;
}

const TEMPLATES: Template[] = [
  {
    match: /url|link|short|tiny|bit\.?ly/i,
    name: "URL shortener",
    functional: ["Create a short code for a long URL", "Redirect short code to the long URL", "Optional custom alias and expiry"],
    nonFunctional: ["Redirect p99 < 50ms", "99.99% availability for redirects", "Codes are unguessable and never reused"],
    scale: { dau: 20_000_000, readQps: 20_000, writeQps: 200, storageTb: 5 },
  },
  {
    match: /discord|slack|chat|whatsapp|messenger|messag/i,
    name: "chat system",
    functional: ["Send and receive messages in channels and DMs in real time", "Persistent message history", "Online presence"],
    nonFunctional: ["Delivery latency < 200ms", "Messages are never lost", "Per-channel ordering"],
    scale: {
      dau: 50_000_000,
      readQps: 300_000,
      writeQps: 50_000,
      storageTb: 2_000,
    },
  },
  {
    match: /twitter|feed|instagram|facebook|timeline|news ?feed|social/i,
    name: "news feed",
    functional: ["Post content", "Follow users", "Home timeline of followed users' posts"],
    nonFunctional: ["Timeline load p99 < 300ms", "Eventual consistency is fine for timelines", "Highly available reads"],
    scale: {
      dau: 200_000_000,
      readQps: 400_000,
      writeQps: 6_000,
      storageTb: 1_000,
    },
  },
  {
    match: /youtube|netflix|video|stream/i,
    name: "video platform",
    functional: ["Upload videos", "Transcode to multiple resolutions", "Stream playback"],
    nonFunctional: ["Playback starts < 2s", "Uploads are durable", "Global audience"],
    scale: {
      dau: 100_000_000,
      readQps: 100_000,
      writeQps: 500,
      storageTb: 50_000,
    },
  },
  {
    match: /uber|lyft|ride|taxi|delivery|doordash/i,
    name: "ride-hailing system",
    functional: ["Drivers stream their location", "Riders request a ride and get matched", "Trip tracking"],
    nonFunctional: ["Match within seconds", "Location freshness < 5s", "No double-booking a driver"],
    scale: {
      dau: 10_000_000,
      readQps: 50_000,
      writeQps: 250_000,
      storageTb: 100,
    },
  },
];

const GENERIC: Template = {
  match: /.*/,
  name: "system",
  functional: ["Core user-facing read path", "Core write path"],
  nonFunctional: ["Highly available", "Low latency reads"],
  scale: { dau: 10_000_000, readQps: 10_000, writeQps: 1_000, storageTb: 10 },
};

interface Detected {
  kind: ComponentKind;
  id: string;
  label: string;
  tech?: string;
}

// Order matters: specific patterns first; later ones skip ids already detected.
const DETECTORS: { re: RegExp; make: (m: RegExpMatchArray) => Detected }[] = [
  {
    re: /\b(cdn|cloudfront|akamai|fastly)\b/i,
    make: (m) => ({
      kind: "cdn",
      id: "cdn",
      label: "CDN",
      tech: techName(m[1]),
    }),
  },
  {
    re: /\b(load ?balancers?|lb|nginx|haproxy|elb|alb)\b/i,
    make: (m) => ({
      kind: "load_balancer",
      id: "lb",
      label: "Load balancer",
      tech: techName(m[1]),
    }),
  },
  {
    re: /\bapi ?gateway\b/i,
    make: () => ({ kind: "api_gateway", id: "gateway", label: "API gateway" }),
  },
  {
    re: /\b(websockets?|realtime gateway|connection servers?|ws gateway)\b/i,
    make: () => ({
      kind: "service",
      id: "ws-gateway",
      label: "WebSocket gateway",
    }),
  },
  {
    re: /\b(redis|memcached?|cach(e|ing))\b/i,
    make: (m) => ({
      kind: "cache",
      id: "cache",
      label: "Cache",
      tech: techName(m[1]),
    }),
  },
  {
    re: /\b(postgres(?:ql)?|mysql|aurora|rds|sql database|relational)\b/i,
    make: (m) => ({
      kind: "database",
      id: "db",
      label: "Database",
      tech: techName(m[1]),
    }),
  },
  {
    re: /\b(cassandra|dynamo(?:db)?|mongo(?:db)?|scylla(?:db)?|bigtable|hbase|nosql|key[- ]value store)\b/i,
    make: (m) => ({
      kind: "database",
      id: "db",
      label: "Database",
      tech: techName(m[1]),
    }),
  },
  {
    re: /\b(database|db)\b/i,
    make: () => ({ kind: "database", id: "db", label: "Database" }),
  },
  {
    re: /\b(kafka|kinesis|pulsar|event stream)\b/i,
    make: (m) => ({
      kind: "stream",
      id: "stream",
      label: "Event stream",
      tech: techName(m[1]),
    }),
  },
  {
    re: /\b(queues?|sqs|rabbitmq|rabbit)\b/i,
    make: (m) => ({
      kind: "queue",
      id: "queue",
      label: "Queue",
      tech: techName(m[1]),
    }),
  },
  {
    re: /\b(s3|blob store|blob storage|object stor(?:e|age)|gcs)\b/i,
    make: (m) => ({
      kind: "object_storage",
      id: "blob",
      label: "Object storage",
      tech: techName(m[1]),
    }),
  },
  {
    re: /\b(elasticsearch|opensearch|search index|full[- ]text search)\b/i,
    make: (m) => ({
      kind: "search",
      id: "search",
      label: "Search index",
      tech: techName(m[1]),
    }),
  },
  {
    re: /\b(workers?|consumers?|background jobs?)\b/i,
    make: () => ({ kind: "worker", id: "worker", label: "Workers" }),
  },
  {
    re: /\b(services?|servers?|backend|app tier|api)\b/i,
    make: () => ({ kind: "service", id: "app", label: "App service" }),
  },
];

const TECH_NAMES: Record<string, string> = {
  redis: "Redis",
  memcache: "Memcached",
  memcached: "Memcached",
  postgres: "PostgreSQL",
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  aurora: "Aurora",
  rds: "RDS",
  cassandra: "Cassandra",
  dynamo: "DynamoDB",
  dynamodb: "DynamoDB",
  mongo: "MongoDB",
  mongodb: "MongoDB",
  scylla: "ScyllaDB",
  scylladb: "ScyllaDB",
  bigtable: "Bigtable",
  hbase: "HBase",
  kafka: "Kafka",
  kinesis: "Kinesis",
  pulsar: "Pulsar",
  sqs: "SQS",
  rabbitmq: "RabbitMQ",
  rabbit: "RabbitMQ",
  s3: "S3",
  gcs: "GCS",
  elasticsearch: "Elasticsearch",
  opensearch: "OpenSearch",
  nginx: "NGINX",
  haproxy: "HAProxy",
  elb: "ELB",
  alb: "ALB",
  cloudfront: "CloudFront",
  akamai: "Akamai",
  fastly: "Fastly",
};

function techName(word: string | undefined): string | undefined {
  return word ? TECH_NAMES[word.toLowerCase()] : undefined;
}

const NUM = String.raw`(\d+(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?`;

function toNumber(n: string, unit?: string): number {
  const base = parseFloat(n);
  const u = (unit ?? "").toLowerCase();
  const mult = u === "k" || u === "thousand" ? 1e3 : u === "m" || u === "million" ? 1e6 : u === "b" || u === "billion" ? 1e9 : 1;
  return Math.round(base * mult);
}

/** Pull scale numbers ("10M DAU", "5k writes/s", "100k QPS") out of free text. */
export function parseScale(text: string): Scale {
  const s: Scale = {};
  const dau = text.match(new RegExp(`${NUM}\\s*(?:dau|daily (?:active )?users|users(?: per| a| each)? day)`, "i"));
  if (dau) s.dau = toNumber(dau[1]!, dau[2]);
  const rw = new RegExp(
    `${NUM}\\s*(reads?|writes?)\\s*(?:qps|rps|(?:requests?\\s*)?(?:/\\s*s(?:ec)?\\b|per sec\\w*|a sec\\w*))`,
    "gi",
  );
  for (const m of text.matchAll(rw)) {
    if (/read/i.test(m[3]!)) s.readQps = toNumber(m[1]!, m[2]);
    else s.writeQps = toNumber(m[1]!, m[2]);
  }
  const qps = text.match(new RegExp(`${NUM}\\s*(?:qps|rps|requests? (?:per|a) sec(?:ond)?)`, "i"));
  if (qps && s.readQps === undefined && s.writeQps === undefined) s.readQps = toNumber(qps[1]!, qps[2]);
  const tb = text.match(new RegExp(`${NUM}\\s*(tb|pb)\\b`, "i"));
  if (tb) s.storageTb = toNumber(tb[1]!, tb[2]) * (/pb/i.test(tb[3]!) ? 1000 : 1);
  return s;
}

export function detectComponents(text: string): Detected[] {
  const found = new Map<string, Detected>();
  for (const { re, make } of DETECTORS) {
    const m = text.match(re);
    if (!m) continue;
    const d = make(m);
    if (!found.has(d.id)) found.set(d.id, d);
  }
  // "db" from a generic word shouldn't shadow a specific tech match; Map keeps the first (specific) one.
  return [...found.values()];
}

interface OfflineState {
  stage: "requirements" | "estimation" | "build";
  template: Template;
  raised: string[];
  stressAsked: number;
}

const STRESS_QUESTIONS: ((d: Design) => { q: string; targets: string[] } | null)[] = [
  (d) => {
    const ten = computeLoad(d, { read: 1, write: 10 });
    if (!ten) return null;
    const worst = Object.values(ten.components).sort((a, b) => b.utilization - a.utilization)[0];
    if (!worst) return null;
    const c = d.components.find((x) => x.id === worst.id)!;
    return {
      q: `What happens at 10x write volume? My rough model says ${c.label} would be at ~${Math.round(worst.utilization * 100)}% of capacity. What breaks first, and what do you change?`,
      targets: [c.id],
    };
  },
  (d) => {
    const cache = d.components.find((c) => c.kind === "cache");
    return cache
      ? {
          q: `A celebrity key goes viral and one ${cache.label} node takes 50x its normal traffic. How do you handle hot keys and a cache stampede on expiry?`,
          targets: [cache.id],
        }
      : null;
  },
  (d) => {
    const db = d.components.find((c) => c.kind === "database");
    return db
      ? {
          q: `Walk me through the data model in ${db.label}: tables or collections, primary keys, and the access pattern each one serves.`,
          targets: [db.id],
        }
      : null;
  },
  (d) => {
    const db = d.components.find((c) => c.kind === "database");
    return db
      ? {
          q: `Your primary region goes down. What's the failover story for ${db.label}, and what's your RPO and RTO?`,
          targets: [db.id],
        }
      : null;
  },
];

const HINTS: [RegExp, string][] = [
  [
    /^direct-/,
    "Think about what sits between clients and a pool of stateless servers: something that health-checks instances and spreads traffic.",
  ],
  [
    /^spof-/,
    "Consider replication: a primary with replicas (sync or async?), or multiple nodes behind a health check. What do you lose with async replication?",
  ],
  [
    /^no-cache/,
    "Reads dominate. A cache-aside layer keyed by the lookup key absorbs most of them. Think about TTLs and what happens on a write.",
  ],
  [
    /^overload-|^10x-/,
    "Writes don't scale with read replicas. You need to split the write load: shard by a key with good spread, or buffer and batch through a log or queue.",
  ],
  [
    /^noconsumer-/,
    "Something has to drain the queue: a worker pool that processes messages idempotently, with retries and a dead-letter queue.",
  ],
  [
    /^chain-/,
    "Each synchronous hop adds latency and a failure mode. Could some calls be async events, or the data be denormalised or cached closer to the caller?",
  ],
  [
    /^shardkey-/,
    "Pick the key that most queries filter on and that spreads evenly. Hashing it avoids hot ranges, but range scans get harder.",
  ],
  [/^orphan-/, "Draw the request path end to end: who calls this component, and what does it call?"],
];

export class OfflineTutor implements TutorEngine {
  async runTurn(session: Session, userText: string | null, emit: Emit, _signal?: AbortSignal): Promise<void> {
    const st = this.state(session);
    const say: string[] = [];
    const apply = (op: DesignOp) => {
      const err = session.apply(op, emit);
      if (err) throw new Error(err);
    };

    if (userText === null) {
      say.push(
        `Let's design a ${st.template.name === "system" ? `system for "${session.prompt}"` : st.template.name}. I'm running in offline mode, so I'm a scripted interviewer: I react to the components you name and push back on weak spots.`,
        "Start with requirements. What are the core features, what's out of scope, and roughly how many users and requests per second should we plan for?",
      );
      return this.finish(session, say, emit);
    }

    const text = userText;
    const scale = parseScale(text);
    const wantsHint = /\b(hint|stuck|help|not sure|no idea|don'?t know)\b/i.test(text);

    if (st.stage === "requirements") {
      apply({
        op: "set_requirements",
        functional: st.template.functional,
        nonFunctional: st.template.nonFunctional,
        scale,
      });
      apply({ op: "set_phase", phase: "estimation" });
      st.stage = "estimation";
      say.push(`Good. I've written the scope on the board: ${st.template.functional.join("; ")}.`);
      if (scale.readQps !== undefined || scale.writeQps !== undefined || scale.dau !== undefined) {
        say.push(
          "You already gave me some numbers. Can you also split them into read vs write QPS and estimate storage over five years?",
        );
      } else {
        say.push(
          "Now estimate. How many daily active users, what's the read QPS and write QPS, and how much storage do we need over five years?",
        );
      }
      return this.finish(session, say, emit);
    }

    if (st.stage === "estimation") {
      const merged = {
        ...st.template.scale,
        ...session.design.requirements.scale,
        ...scale,
      };
      apply({ op: "set_requirements", scale: merged });
      apply({ op: "set_phase", phase: "high_level" });
      st.stage = "build";
      const gave = Object.keys(scale).length > 0;
      say.push(
        gave ? `Recorded: ${fmtScale(merged)}.` : `I'll assume ${fmtScale(merged)}. Push back if you disagree.`,
        `That's roughly ${Math.round((merged.readQps ?? 0) / Math.max(1, merged.writeQps ?? 1))}:1 reads to writes, which should shape everything that follows.`,
        "Let's sketch the high-level design. What sits between the client and your data? Name the components (load balancer, services, databases, caches, queues...) and I'll draw them.",
      );
      // Numbers given in the same message may also come with components.
      if (detectComponents(text).length === 0) return this.finish(session, say, emit);
      say.length = 0;
    }

    // Build stage.
    if (Object.keys(scale).length) apply({ op: "set_requirements", scale });
    const before = new Set(critique(session.design).map((f) => f.id));
    const changes = this.applyDesignChanges(session, text, apply);
    if (changes.length) say.push(`Updated the board: ${changes.join(", ")}.`);

    const findings = critique(session.design);
    const findingIds = new Set(findings.map((f) => f.id));

    // Resolve pinned challenges whose underlying finding has gone away.
    for (const ch of session.design.challenges) {
      const fid = st.raised.find((r) => r.endsWith(`|${ch.id}`))?.split("|")[0];
      if (ch.status === "open" && fid && before.has(fid) && !findingIds.has(fid)) {
        apply({
          op: "resolve_challenge",
          id: ch.id,
          status: "addressed",
          resolution: changes.join(", ") || "addressed",
        });
        say.push(`That addresses ${ch.id}.`);
      }
    }

    const open = session.design.challenges.filter((c) => c.status === "open");
    if (wantsHint && open.length) {
      const last = open.at(-1)!;
      const fid = st.raised.find((r) => r.endsWith(`|${last.id}`))?.split("|")[0] ?? "";
      const hint =
        HINTS.find(([re]) => re.test(fid))?.[1] ?? "Start from the request path and ask what fails, or what saturates, first.";
      say.push(`Hint for "${last.question}": ${hint}`);
      return this.finish(session, say, emit);
    }

    if (changes.length === 0 && !wantsHint && session.design.components.length === 0) {
      say.push(
        'I didn\'t catch any components there. Try naming them, e.g. "clients hit a load balancer in front of stateless API servers backed by PostgreSQL".',
      );
      return this.finish(session, say, emit);
    }

    const next = this.pickFinding(findings, st);
    if (next) {
      if (session.design.phase === "high_level" && session.design.components.length >= 5)
        apply({ op: "set_phase", phase: "deep_dive" });
      apply({
        op: "add_challenge",
        challenge: {
          question: next.message,
          severity: next.severity,
          targetIds: next.targetIds.filter((t) => session.design.components.some((c) => c.id === t)),
        },
      });
      st.raised.push(`${next.id}|${session.design.challenges.at(-1)!.id}`);
      say.push(next.message);
      return this.finish(session, say, emit);
    }

    // Nothing obviously wrong: stress-test it.
    while (st.stressAsked < STRESS_QUESTIONS.length) {
      const q = STRESS_QUESTIONS[st.stressAsked++]!(session.design);
      if (!q) continue;
      if (session.design.phase !== "scaling") apply({ op: "set_phase", phase: "scaling" });
      apply({
        op: "add_challenge",
        challenge: { question: q.q, severity: "probe", targetIds: q.targets },
      });
      say.push(q.q);
      return this.finish(session, say, emit);
    }

    apply({ op: "set_phase", phase: "wrap_up" });
    say.push(
      "I'm out of scripted questions. That's a solid design. For a deeper, adaptive interview, run the tutor with Claude (set ANTHROPIC_API_KEY). Summarise your design in 3 sentences as you would to close an interview.",
    );
    return this.finish(session, say, emit);
  }

  private state(session: Session): OfflineState {
    if (!session.scratch.offline) {
      session.scratch.offline = {
        stage: "requirements",
        template: TEMPLATES.find((t) => t.match.test(session.prompt)) ?? GENERIC,
        raised: [],
        stressAsked: 0,
      } satisfies OfflineState;
    }
    return session.scratch.offline as OfflineState;
  }

  private pickFinding(findings: Finding[], st: OfflineState): Finding | undefined {
    const rank = { critical: 0, concern: 1, probe: 2 } as const;
    return findings
      .filter((f) => !st.raised.some((r) => r.startsWith(`${f.id}|`)))
      .sort((a, b) => rank[a.severity] - rank[b.severity])[0];
  }

  private finish(session: Session, say: string[], emit: Emit) {
    const text = say.join(" ");
    emit({ type: "text", delta: text });
    session.transcript.push({ role: "tutor", text });
  }

  /** Interpret the candidate's message as design edits. Returns human-readable change notes. */
  private applyDesignChanges(session: Session, text: string, apply: (op: DesignOp) => void): string[] {
    const notes: string[] = [];
    const d = () => session.design;
    const has = (id: string) => d().components.some((c) => c.id === id);
    const ofKind = (k: ComponentKind) => d().components.filter((c) => c.kind === k);

    // Removals: "remove the cache", "drop the queue".
    const removeMatch = text.match(/\b(?:remove|drop|get rid of|delete)\s+(?:the\s+)?(.+?)(?:[.,;]|$)/i);
    const removed = new Set<string>();
    if (removeMatch) {
      for (const det of detectComponents(removeMatch[1]!)) {
        const target = d().components.find((c) => c.id === det.id) ?? ofKind(det.kind)[0];
        if (target) {
          apply({ op: "remove_component", id: target.id });
          removed.add(det.id);
          notes.push(`removed ${target.label}`);
        }
      }
    }

    const detected = detectComponents(removeMatch ? text.replace(removeMatch[0], " ") : text).filter((x) => !removed.has(x.id));
    if (detected.length && !has("client")) {
      apply({
        op: "add_component",
        component: { id: "client", kind: "client", label: "Clients" },
      });
    }
    const added: Component[] = [];
    for (const det of detected) {
      const existing = d().components.find((c) => c.id === det.id);
      if (existing) {
        if (det.tech && existing.tech !== det.tech) {
          apply({
            op: "update_component",
            id: existing.id,
            patch: { tech: det.tech },
          });
          notes.push(`${existing.label} -> ${det.tech}`);
        }
        continue;
      }
      const component: Component = {
        id: det.id,
        kind: det.kind,
        label: det.label,
        ...(det.tech ? { tech: det.tech } : {}),
      };
      apply({ op: "add_component", component });
      added.push(component);
      notes.push(`added ${det.tech ? `${det.label} (${det.tech})` : det.label}`);
    }
    if (added.length) this.autoWire(session, apply);

    // Modifiers, applied per sentence to the components it mentions.
    for (const sentence of text.split(/(?<=[.;!?])\s+|\n+/)) {
      const targets = detectComponents(sentence)
        .map((det) => d().components.find((c) => c.id === det.id) ?? ofKind(det.kind)[0])
        .filter((c): c is Component => !!c);
      const replicaM = sentence.match(
        /(?:(\d+)\s*(?:[a-z-]+\s+)?(?:read\s+)?(?:replicas?|instances?|nodes?|servers?|copies))|\b(replicat\w*|replicas?|multi-?az|failover|standby|autoscal\w*|horizontal\w*|redundan\w*)\b/i,
      );
      if (replicaM) {
        const n = replicaM[1] ? parseInt(replicaM[1], 10) : 3;
        const tgts = targets.length ? targets : ofKind("database");
        for (const t of tgts) {
          if (t.kind === "client") continue;
          if ((t.replicas ?? 1) !== n && n >= 1 && n <= 1024) {
            apply({ op: "update_component", id: t.id, patch: { replicas: n } });
            notes.push(`${t.label} x${n}`);
          }
        }
      }
      const shardM = sentence.match(
        /\b(?:shard\w*|partition\w*)\b(?:[^.]*?\b(?:into|across)\s+(\d+))?(?:[^.]*?\bby\s+([\w-]+(?:\s+[\w-]+)?))?/i,
      );
      if (shardM) {
        const n = shardM[1] ? parseInt(shardM[1], 10) : 8;
        const key = shardM[2]?.replace(/\b(hash|the|a)\b/gi, "").trim() || undefined;
        const tgts = targets.filter(
          (t) => t.kind === "database" || t.kind === "cache" || t.kind === "stream" || t.kind === "queue" || t.kind === "search",
        );
        for (const t of tgts.length ? tgts : ofKind("database")) {
          apply({
            op: "update_component",
            id: t.id,
            patch: { shards: n, ...(key ? { shardKey: key } : {}) },
          });
          notes.push(`${t.label} sharded x${n}${key ? ` by ${key}` : ""}`);
        }
      }
    }
    return notes;
  }

  /** Connect components along conventional request/data paths, without duplicating edges. */
  private autoWire(session: Session, apply: (op: DesignOp) => void) {
    const d = () => session.design;
    const ids = (k: ComponentKind) =>
      d()
        .components.filter((c) => c.kind === k)
        .map((c) => c.id);
    const edge = (from: string, to: string) => d().edges.some((e) => e.from === from && e.to === to);
    const link = (from: string, to: string, label?: string, async?: boolean) => {
      if (!edge(from, to))
        apply({
          op: "connect",
          edge: {
            from,
            to,
            ...(label ? { label } : {}),
            ...(async ? { async } : {}),
          },
        });
    };
    const unlink = (from: string, to: string) => {
      if (edge(from, to)) apply({ op: "disconnect", from, to });
    };

    const services = ids("service");
    const entry = [...ids("load_balancer"), ...ids("api_gateway")];
    for (const cdn of ids("cdn")) link("client", cdn, "static assets");
    if (entry.length) {
      for (const e of entry) link("client", e);
      for (const s of services) {
        unlink("client", s);
        for (const e of entry) link(e, s);
      }
    } else {
      for (const s of services) link("client", s);
    }
    for (const s of services) {
      for (const c of ids("cache")) link(s, c, "cache-aside");
      for (const db of ids("database")) link(s, db);
      for (const q of [...ids("queue"), ...ids("stream")]) link(s, q, "publish", true);
      for (const b of ids("object_storage")) link(s, b);
      for (const se of ids("search")) link(s, se, "query");
    }
    for (const q of [...ids("queue"), ...ids("stream")]) for (const w of ids("worker")) link(q, w, "consume", true);
    for (const w of ids("worker")) {
      for (const db of ids("database")) link(w, db);
      for (const se of ids("search")) link(w, se, "index");
    }
    for (const cdn of ids("cdn")) for (const b of ids("object_storage")) link(cdn, b, "origin");
  }
}

function fmtScale(s: Scale): string {
  const n = (x: number) => (x >= 1e6 ? `${+(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${+(x / 1e3).toFixed(1)}k` : `${x}`);
  return [
    s.dau !== undefined && `${n(s.dau)} DAU`,
    s.readQps !== undefined && `${n(s.readQps)} reads/s`,
    s.writeQps !== undefined && `${n(s.writeQps)} writes/s`,
    s.storageTb !== undefined && `${n(s.storageTb)} TB storage`,
  ]
    .filter(Boolean)
    .join(", ");
}
