// Domain model shared by the server (tutor) and the web client (diagram).

export const COMPONENT_KINDS = [
  "client",
  "dns",
  "cdn",
  "load_balancer",
  "api_gateway",
  "service",
  "cache",
  "queue",
  "stream",
  "worker",
  "database",
  "object_storage",
  "search",
  "external",
] as const;

export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export interface Component {
  id: string;
  kind: ComponentKind;
  label: string;
  /** Concrete technology, e.g. "PostgreSQL", "Redis", "Kafka". */
  tech?: string;
  /** Number of identical instances / read replicas. Defaults to 1. */
  replicas?: number;
  /** Number of shards / partitions. Defaults to 1. */
  shards?: number;
  shardKey?: string;
  notes?: string;
}

export interface Edge {
  from: string;
  to: string;
  label?: string;
  /** Asynchronous hop (queue publish, event, fire-and-forget). */
  async?: boolean;
}

export interface Scale {
  dau?: number;
  readQps?: number;
  writeQps?: number;
  storageTb?: number;
}

export interface Requirements {
  functional: string[];
  nonFunctional: string[];
  scale: Scale;
}

export const PHASES = ["requirements", "estimation", "high_level", "deep_dive", "scaling", "wrap_up"] as const;
export type Phase = (typeof PHASES)[number];

export type Severity = "probe" | "concern" | "critical";

export interface Challenge {
  id: string;
  question: string;
  severity: Severity;
  targetIds: string[];
  status: "open" | "addressed" | "dismissed";
  resolution?: string;
}

export interface Design {
  title: string;
  phase: Phase;
  requirements: Requirements;
  components: Component[];
  edges: Edge[];
  challenges: Challenge[];
}

export type DesignOp =
  | { op: "add_component"; component: Component }
  | {
      op: "update_component";
      id: string;
      patch: Partial<Omit<Component, "id">>;
    }
  | { op: "remove_component"; id: string }
  | { op: "connect"; edge: Edge }
  | { op: "disconnect"; from: string; to: string }
  | {
      op: "set_requirements";
      functional?: string[];
      nonFunctional?: string[];
      scale?: Scale;
    }
  | { op: "set_phase"; phase: Phase }
  | { op: "add_challenge"; challenge: Omit<Challenge, "id" | "status"> }
  | {
      op: "resolve_challenge";
      id: string;
      status: "addressed" | "dismissed";
      resolution: string;
    };

export interface ChatEntry {
  role: "user" | "tutor" | "system";
  text: string;
}

/** Events streamed from server to browser over SSE. */
export type TutorEvent =
  | { type: "text"; delta: string }
  | { type: "design"; design: Design; changed: string[] }
  | { type: "turn_end" }
  | { type: "error"; message: string };

export interface SessionSnapshot {
  id: string;
  mode: "claude" | "offline";
  design: Design;
  transcript: ChatEntry[];
}

export function emptyDesign(title: string): Design {
  return {
    title,
    phase: "requirements",
    requirements: { functional: [], nonFunctional: [], scale: {} },
    components: [],
    edges: [],
    challenges: [],
  };
}
