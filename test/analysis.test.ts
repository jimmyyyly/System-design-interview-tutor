import { describe, expect, it } from "vitest";
import { computeLoad, critique } from "../src/shared/analysis.js";
import { emptyDesign, type Component, type Design, type Edge } from "../src/shared/types.js";

function design(components: Component[], edges: Edge[] = [], scale: Design["requirements"]["scale"] = {}): Design {
  return {
    ...emptyDesign("t"),
    components,
    edges,
    requirements: { functional: [], nonFunctional: [], scale },
  };
}

const client: Component = { id: "client", kind: "client", label: "Clients" };
const lb: Component = {
  id: "lb",
  kind: "load_balancer",
  label: "LB",
  replicas: 2,
};
const app: Component = {
  id: "app",
  kind: "service",
  label: "App",
  replicas: 10,
};
const db: Component = { id: "db", kind: "database", label: "DB", replicas: 3 };
const cache: Component = {
  id: "cache",
  kind: "cache",
  label: "Cache",
  replicas: 3,
};

describe("computeLoad", () => {
  it("returns null without scale estimates", () => {
    expect(computeLoad(design([db]))).toBeNull();
  });

  it("derives QPS from DAU when not given", () => {
    const load = computeLoad(design([db], [], { dau: 86_400_000 }))!;
    expect(load.readQps).toBe(20_000);
    expect(load.writeQps).toBe(2_000);
  });

  it("read replicas add read capacity but not write capacity; shards add both", () => {
    const scale = { readQps: 1_000, writeQps: 6_000 };
    const replicated = computeLoad(design([{ ...db, replicas: 5 }], [], scale))!.components.db!;
    expect(replicated.utilization).toBeCloseTo(2); // 6k writes / 3k per primary
    expect(replicated.bottleneck).toBe("writes");
    const sharded = computeLoad(design([{ ...db, replicas: 1, shards: 4 }], [], scale))!.components.db!;
    expect(sharded.utilization).toBeCloseTo(0.5);
  });

  it("a cache absorbs most database reads", () => {
    const scale = { readQps: 50_000, writeQps: 100 };
    const without = computeLoad(design([db], [], scale))!.components.db!;
    const withCache = computeLoad(design([db, cache], [], scale))!.components.db!;
    expect(withCache.readDemand).toBeCloseTo(without.readDemand * 0.2);
  });

  it("applies read/write multipliers", () => {
    const load = computeLoad(design([db], [], { readQps: 100, writeQps: 100 }), { read: 1, write: 10 })!;
    expect(load.writeQps).toBe(1_000);
    expect(load.components.db!.writeDemand).toBe(1_000);
  });

  it("routes traffic to read- or write-named services", () => {
    const load = computeLoad(
      design(
        [
          { id: "redirect-svc", kind: "service", label: "Redirect" },
          { id: "shorten-svc", kind: "service", label: "Shorten" },
        ],
        [],
        { readQps: 1_000, writeQps: 10 },
      ),
    )!;
    expect(load.components["redirect-svc"]!.readDemand).toBe(1_000);
    expect(load.components["redirect-svc"]!.writeDemand).toBe(0);
    expect(load.components["shorten-svc"]!.writeDemand).toBe(10);
  });
});

describe("critique", () => {
  const ids = (d: Design) => critique(d).map((f) => f.id);

  it("is quiet on an empty board", () => {
    expect(critique(design([]))).toEqual([]);
  });

  it("flags clients calling services directly", () => {
    expect(ids(design([client, app], [{ from: "client", to: "app" }]))).toContain("direct-app");
  });

  it("flags single points of failure once the design has substance", () => {
    const d = design([client, lb, app, { ...db, replicas: 1 }]);
    const f = critique(d).find((x) => x.id === "spof-db");
    expect(f?.severity).toBe("critical");
    expect(ids(design([client, { ...db, replicas: 1 }]))).not.toContain("spof-db");
  });

  it("suggests a cache for read-heavy designs and stops once one exists", () => {
    const scale = { readQps: 10_000, writeQps: 100 };
    expect(ids(design([client, lb, app, db], [], scale))).toContain("no-cache");
    expect(ids(design([client, lb, app, db, cache], [], scale))).not.toContain("no-cache");
  });

  it("flags queues with no consumer", () => {
    const q: Component = {
      id: "q",
      kind: "queue",
      label: "Queue",
      replicas: 3,
    };
    expect(ids(design([app, q], [{ from: "app", to: "q", async: true }]))).toContain("noconsumer-q");
  });

  it("asks what happens at 10x writes when a component would saturate", () => {
    const d = design([client, lb, app, db, cache], [], {
      readQps: 1_000,
      writeQps: 1_000,
    });
    expect(ids(d)).toContain("10x-db");
    expect(
      ids(design([client, lb, app, { ...db, shards: 16, shardKey: "id" }, cache], [], { readQps: 1_000, writeQps: 1_000 })),
    ).not.toContain("10x-db");
  });

  it("flags overloaded components", () => {
    expect(
      ids(
        design([client, lb, { ...app, replicas: 1 }, db, cache], [], {
          readQps: 5_000,
          writeQps: 10,
        }),
      ),
    ).toContain("overload-app");
  });

  it("asks for a shard key", () => {
    expect(ids(design([{ ...db, shards: 4 }]))).toContain("shardkey-db");
  });

  it("flags long synchronous service chains", () => {
    const s = (id: string): Component => ({
      id,
      kind: "service",
      label: id,
      replicas: 2,
    });
    const d = design(
      [s("a"), s("b"), s("c")],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    );
    expect(ids(d)).toContain("chain-a");
    const asyncHop = design(
      [s("a"), s("b"), s("c")],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c", async: true },
      ],
    );
    expect(ids(asyncHop)).not.toContain("chain-a");
  });
});
