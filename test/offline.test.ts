import { describe, expect, it } from "vitest";
import { Session } from "../src/server/session.js";
import { detectComponents, OfflineTutor, parseScale } from "../src/server/tutor/offline.js";
import type { TutorEvent } from "../src/shared/types.js";

describe("parseScale", () => {
  it("parses DAU, read/write QPS and storage", () => {
    expect(parseScale("100M DAU, 40k reads/s and 400 writes per second, about 10 TB")).toEqual({
      dau: 100_000_000,
      readQps: 40_000,
      writeQps: 400,
      storageTb: 10,
    });
  });
  it("treats bare QPS as reads and converts PB", () => {
    expect(parseScale("around 2.5k qps, 3 PB")).toEqual({
      readQps: 2_500,
      storageTb: 3_000,
    });
  });
  it("does not mistake replica counts for QPS", () => {
    expect(parseScale("Postgres with 3 read replicas")).toEqual({});
  });
});

describe("detectComponents", () => {
  it("recognises technologies and maps them to kinds", () => {
    const found = detectComponents("nginx in front of API servers, Redis cache, Cassandra, Kafka to workers, S3 for blobs");
    expect(found.map((d) => [d.id, d.kind, d.tech])).toEqual([
      ["lb", "load_balancer", "NGINX"],
      ["cache", "cache", "Redis"],
      ["db", "database", "Cassandra"],
      ["stream", "stream", "Kafka"],
      ["blob", "object_storage", "S3"],
      ["worker", "worker", undefined],
      ["app", "service", undefined],
    ]);
  });
});

async function run(session: Session, tutor: OfflineTutor, text: string | null) {
  const events: TutorEvent[] = [];
  await tutor.runTurn(session, text, (e) => events.push(e), new AbortController().signal);
  return events
    .filter((e) => e.type === "text")
    .map((e) => (e as { delta: string }).delta)
    .join("");
}

describe("OfflineTutor", () => {
  it("runs an interview: scope, estimate, build, push back, resolve", async () => {
    const s = new Session("Design a URL shortener", "offline");
    const t = new OfflineTutor();
    expect(await run(s, t, null)).toMatch(/URL shortener/);
    await run(s, t, "Shorten and redirect; analytics out of scope");
    expect(s.design.phase).toBe("estimation");
    expect(s.design.requirements.functional.length).toBeGreaterThan(0);
    await run(s, t, "100M DAU, 40k reads/s, 400 writes/s");
    expect(s.design.requirements.scale).toMatchObject({
      readQps: 40_000,
      writeQps: 400,
    });
    expect(s.design.phase).toBe("high_level");

    const reply = await run(s, t, "Clients hit API servers backed by PostgreSQL.");
    expect(s.design.components.map((c) => c.id).sort()).toEqual(["app", "client", "db"]);
    expect(s.design.edges).toEqual(
      expect.arrayContaining([
        { from: "client", to: "app" },
        { from: "app", to: "db" },
      ]),
    );
    expect(s.design.challenges).toHaveLength(1);
    expect(reply).toContain(s.design.challenges[0]!.question);

    // Adding a load balancer reroutes clients through it.
    await run(s, t, "Put an nginx load balancer in front of 30 app servers.");
    expect(s.design.edges).not.toContainEqual({ from: "client", to: "app" });
    expect(s.design.edges).toContainEqual({ from: "lb", to: "app" });
    expect(s.design.components.find((c) => c.id === "app")!.replicas).toBe(30);

    await run(s, t, "PostgreSQL with 3 read replicas and automatic failover.");
    await run(s, t, "Add a Redis cache in front of the database.");
    const resolved = s.design.challenges.filter((c) => c.status === "addressed");
    expect(resolved.length).toBeGreaterThanOrEqual(1);
  });

  it("applies each count in a sentence to the component it describes", async () => {
    const s = new Session("Design a URL shortener", "offline");
    const t = new OfflineTutor();
    for (const m of [null, "shorten and redirect", "100M DAU, 40k reads/s, 400 writes/s"]) await run(s, t, m);
    await run(
      s,
      t,
      "Clients hit an nginx load balancer in front of 30 app servers backed by PostgreSQL with 3 read replicas and failover.",
    );
    const replicas = Object.fromEntries(s.design.components.map((c) => [c.id, c.replicas ?? 1]));
    expect(replicas).toEqual({ client: 1, lb: 1, app: 30, db: 3 });
    // A redundancy word without a number doesn't shrink a larger count.
    await run(s, t, "The app servers autoscale.");
    expect(s.design.components.find((c) => c.id === "app")!.replicas).toBe(30);
  });

  it("gives a hint for the open challenge", async () => {
    const s = new Session("Design a URL shortener", "offline");
    const t = new OfflineTutor();
    for (const m of [null, "shorten and redirect", "10M DAU", "clients hit an app server with a postgres db"]) await run(s, t, m);
    expect(await run(s, t, "I'm stuck, hint?")).toMatch(/^Hint for/);
  });

  it("shards with a key from free text", async () => {
    const s = new Session("Design Twitter", "offline");
    const t = new OfflineTutor();
    for (const m of [null, "post and timeline", "200M DAU", "load balancer, app servers, Cassandra"]) await run(s, t, m);
    await run(s, t, "Shard Cassandra into 16 partitions by user_id.");
    expect(s.design.components.find((c) => c.id === "db")).toMatchObject({
      shards: 16,
      shardKey: "user_id",
    });
  });
});
