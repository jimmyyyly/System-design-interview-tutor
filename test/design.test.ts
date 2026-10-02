import { describe, expect, it } from "vitest";
import { applyOp, DesignOpError, describeDesign } from "../src/shared/design.js";
import { emptyDesign, type Design, type DesignOp } from "../src/shared/types.js";

function build(...ops: DesignOp[]): Design {
  return ops.reduce((d, op) => applyOp(d, op).design, emptyDesign("test"));
}

describe("applyOp", () => {
  it("adds components and reports them as changed", () => {
    const { design, changed } = applyOp(emptyDesign("t"), {
      op: "add_component",
      component: { id: "lb", kind: "load_balancer", label: "LB" },
    });
    expect(design.components).toHaveLength(1);
    expect(changed).toEqual(["lb"]);
  });

  it("rejects duplicate and malformed ids", () => {
    const d = build({
      op: "add_component",
      component: { id: "db", kind: "database", label: "DB" },
    });
    expect(() =>
      applyOp(d, {
        op: "add_component",
        component: { id: "db", kind: "cache", label: "x" },
      }),
    ).toThrow(DesignOpError);
    expect(() =>
      applyOp(d, {
        op: "add_component",
        component: { id: "Bad Id", kind: "cache", label: "x" },
      }),
    ).toThrow(/Invalid id/);
  });

  it("rejects edges to unknown components and lists known ids", () => {
    const d = build({
      op: "add_component",
      component: { id: "db", kind: "database", label: "DB" },
    });
    expect(() => applyOp(d, { op: "connect", edge: { from: "app", to: "db" } })).toThrow(/Known ids: db/);
  });

  it("replaces an existing edge instead of duplicating it", () => {
    const d = build(
      {
        op: "add_component",
        component: { id: "a", kind: "service", label: "A" },
      },
      {
        op: "add_component",
        component: { id: "b", kind: "database", label: "B" },
      },
      { op: "connect", edge: { from: "a", to: "b" } },
      { op: "connect", edge: { from: "a", to: "b", label: "writes" } },
    );
    expect(d.edges).toEqual([{ from: "a", to: "b", label: "writes" }]);
  });

  it("removing a component drops its edges and challenge targets", () => {
    let d = build(
      {
        op: "add_component",
        component: { id: "a", kind: "service", label: "A" },
      },
      {
        op: "add_component",
        component: { id: "b", kind: "database", label: "B" },
      },
      { op: "connect", edge: { from: "a", to: "b" } },
      {
        op: "add_challenge",
        challenge: {
          question: "What if B dies?",
          severity: "concern",
          targetIds: ["a", "b"],
        },
      },
    );
    d = applyOp(d, { op: "remove_component", id: "b" }).design;
    expect(d.edges).toEqual([]);
    expect(d.challenges[0]!.targetIds).toEqual(["a"]);
  });

  it("validates replica and shard counts", () => {
    const d = build({
      op: "add_component",
      component: { id: "db", kind: "database", label: "DB" },
    });
    expect(() => applyOp(d, { op: "update_component", id: "db", patch: { replicas: 0 } })).toThrow(/replicas/);
    expect(
      applyOp(d, {
        op: "update_component",
        id: "db",
        patch: { shards: 8, shardKey: "user_id" },
      }).design.components[0],
    ).toMatchObject({
      shards: 8,
      shardKey: "user_id",
    });
  });

  it("merges scale estimates and keeps unspecified requirement lists", () => {
    const d = build(
      { op: "set_requirements", functional: ["shorten"], scale: { dau: 1000 } },
      { op: "set_requirements", scale: { writeQps: 5 } },
    );
    expect(d.requirements.functional).toEqual(["shorten"]);
    expect(d.requirements.scale).toEqual({ dau: 1000, writeQps: 5 });
  });

  it("numbers challenges and resolves them", () => {
    let d = build({
      op: "add_challenge",
      challenge: { question: "10x writes?", severity: "probe", targetIds: [] },
    });
    expect(d.challenges[0]).toMatchObject({ id: "c1", status: "open" });
    d = applyOp(d, {
      op: "resolve_challenge",
      id: "c1",
      status: "addressed",
      resolution: "sharded",
    }).design;
    expect(d.challenges[0]).toMatchObject({
      status: "addressed",
      resolution: "sharded",
    });
    expect(() =>
      applyOp(d, {
        op: "resolve_challenge",
        id: "c9",
        status: "addressed",
        resolution: "",
      }),
    ).toThrow();
  });

  it("describes the design for the model", () => {
    const d = build(
      {
        op: "add_component",
        component: {
          id: "db",
          kind: "database",
          label: "URLs",
          tech: "PostgreSQL",
          replicas: 3,
        },
      },
      { op: "set_requirements", scale: { readQps: 100 } },
    );
    const text = describeDesign(d);
    expect(text).toContain('db [database] "URLs" (PostgreSQL; x3 replicas)');
    expect(text).toContain("read QPS=100");
  });
});
