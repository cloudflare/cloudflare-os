import { describe, expect, it } from "vitest";
import {
  ProvisionalIds,
  createSimulationView,
  replaySimulation,
  type SimulationKv,
  type SimulationRecord,
} from "../src/simulation";
import { fakeKv } from "./fake-kv";

type Action = { name: string; targets: string[] };

function record(id: number, name: string, ...targets: string[]): SimulationRecord<Action> {
  return { id, action: { name, targets } };
}

function makeKv(): SimulationKv {
  return fakeKv();
}

describe("createSimulationView", () => {
  it("orders once and indexes each action under every target", () => {
    const records = [
      record(3, "third", "a"),
      record(1, "first", "a", "b"),
      record(2, "second", "b", "b"),
    ];
    const view = createSimulationView(records, action => action.targets);

    expect(view.all().map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(view.forTarget("a").map(({ id }) => id)).toEqual([1, 3]);
    expect(view.forTarget("b").map(({ id }) => id)).toEqual([1, 2]);
    expect(view.forTarget("absent")).toEqual([]);
    expect(Object.isFrozen(view.all())).toBe(true);
    expect(Object.isFrozen(view.forTarget("a"))).toBe(true);
    expect(records.map(({ id }) => id)).toEqual([3, 1, 2]);
  });

  it("coalesces provisional and real targets when the caller resolves them", () => {
    const ids = new ProvisionalIds<string>(makeKv(), { namespace: "pages:" });
    ids.bind("~1", "real-1");
    const view = createSimulationView(
      [record(2, "real", "real-1"), record(1, "provisional", "~1")],
      action => action.targets.map(target => ids.resolve(target)),
    );

    expect(view.forTarget("real-1").map(({ id }) => id)).toEqual([1, 2]);
  });

  it("refuses a bare target at the type level", () => {
    // Every simulating gatekeeper's target is a scalar string, so this is the spelling a port
    // reaches for. Under `Iterable<Target>` it compiled and `forTarget` then found nothing.
    type Records = { id: number; action: { target: string } };
    const records: Records[] = [{ id: 1, action: { target: "page-123" } }];

    // @ts-expect-error - a bare target is not an array of targets.
    createSimulationView<Records, string>(records, action => action.target);
    // @ts-expect-error - nor is a nullable one, the shape `actionPageId` returns.
    createSimulationView<Records, string>(records, action => action.target || null);

    const view = createSimulationView<Records, string>(records, action => [action.target]);
    expect(view.forTarget("page-123").map(({ id }) => id)).toEqual([1]);
  });
});

describe("replaySimulation", () => {
  const records = [record(1, "increment"), record(2, "noop"), record(3, "double")];

  it("continues through known non-effects", () => {
    expect(
      replaySimulation(1, records, (value, { action }) => {
        if (action.name === "noop") return { kind: "known-no-effect" };
        return { kind: "applied", value: action.name === "increment" ? value + 1 : value * 2 };
      }),
    ).toEqual({ kind: "complete", value: 4, appliedCount: 2 });
  });

  it("stops at the first unsupported relevant action", () => {
    expect(
      replaySimulation(0, records, (value, item) =>
        item.action.name === "noop"
          ? { kind: "unsupported", reason: "provider effect is not predictable" }
          : { kind: "applied", value: value + 1 },
      ),
    ).toEqual({
      kind: "incomplete",
      partial: 1,
      appliedCount: 1,
      unsupported: records[1],
      reason: "provider effect is not predictable",
    });
  });
});

describe("ProvisionalIds", () => {
  it("allocates formatted monotonic IDs durably", () => {
    const kv = makeKv();
    const first = new ProvisionalIds<string>(kv, { namespace: "issues:" });
    expect(first.allocate(sequence => `ENG-PENDING-${sequence}`)).toBe("ENG-PENDING-1");
    expect(first.allocate(sequence => `ENG-PENDING-${sequence}`)).toBe("ENG-PENDING-2");

    const restarted = new ProvisionalIds<string>(kv, { namespace: "issues:" });
    expect(restarted.allocate(sequence => `ENG-PENDING-${sequence}`)).toBe("ENG-PENDING-3");
  });

  it("retains bindings and isolates namespaces", () => {
    const kv = makeKv();
    const pages = new ProvisionalIds<string>(kv, { namespace: "pages:" });
    const issues = new ProvisionalIds<string>(kv, { namespace: "issues:" });
    pages.bind("~1", "real-page");

    expect(new ProvisionalIds<string>(kv, { namespace: "pages:" }).resolve("~1")).toBe("real-page");
    expect(pages.isResolved("~1")).toBe(true);
    expect(pages.isResolved("~2")).toBe(false);
    expect(issues.resolve("~1")).toBe("~1");
  });

  it("refuses to hand an unapplied provisional ID to the provider", () => {
    const ids = new ProvisionalIds<string>(makeKv(), {
      namespace: "issues:",
      isProvisional: id => id.startsWith("~"),
    });
    ids.bind("~1", "real-1");

    expect(ids.requireResolved("~1")).toBe("real-1");
    expect(ids.requireResolved("real-9")).toBe("real-9");
    expect(() => ids.requireResolved("~2")).toThrow(/has not been created yet/);
  });

  it("can adopt existing unnamespaced provisional keys without migration", () => {
    const kv = makeKv();
    kv.put("seq:provisional", 7);
    kv.put("prov:~6", "real-6");
    const ids = new ProvisionalIds<string>(kv, { namespace: "" });

    expect(ids.resolve("~6")).toBe("real-6");
    expect(ids.allocate(sequence => `~${sequence}`)).toBe("~7");
  });

  it("rejects a formatter whose output is not classifiable as provisional", () => {
    const kv = makeKv();
    const ids = new ProvisionalIds<string>(kv, {
      namespace: "issues:",
      isProvisional: id => id.startsWith("~"),
    });

    // Plausible provider IDs. Minted, these are indistinguishable from real ones, and `resolve()`
    // would hand an unbound one straight to the provider as though it were ready.
    expect(() => ids.allocate(sequence => `${sequence}`)).toThrow(/does not classify/);
    expect(() => ids.allocate(sequence => `ISSUE-${sequence}`)).toThrow(/does not classify/);
    // The sequence is not consumed by a rejected allocation.
    expect(ids.allocate(sequence => `~${sequence}`)).toBe("~1");
  });

  it("rejects a binding in either wrong direction", () => {
    const ids = new ProvisionalIds<string>(makeKv(), {
      namespace: "issues:",
      isProvisional: id => id.startsWith("~"),
    });

    // A real ID as the key shadows that provider ID for every later resolve().
    expect(() => ids.bind("real-1", "real-2")).toThrow(/not a provisional ID/);
    // A provisional as the value resolves one provisional to another, defeating requireResolved.
    expect(() => ids.bind("~1", "~2")).toThrow(/target is also provisional/);
    expect(ids.resolve("real-1")).toBe("real-1");
    expect(ids.isResolved("~1")).toBe(false);
  });

  it("refuses to retarget a provisional ID an at-least-once retry created twice", () => {
    // No classifier: the guard is about the stored binding, not the shape of the IDs.
    const ids = new ProvisionalIds<string>(makeKv(), { namespace: "issues:" });
    ids.bind("~1", "real-1");

    // The retry's own re-bind is the ordinary path.
    expect(() => ids.bind("~1", "real-1")).not.toThrow();
    // A second provider entity is not: taking it would aim every queued action at the duplicate.
    expect(() => ids.bind("~1", "real-2")).toThrow(/already bound to real-1, not real-2/);
    expect(ids.resolve("~1")).toBe("real-1");
  });

  it("skips both checks when no classifier is supplied", () => {
    // A consumer that never calls requireResolved pays nothing for the guards.
    const ids = new ProvisionalIds<string>(makeKv(), { namespace: "issues:" });
    expect(ids.allocate(sequence => `${sequence}`)).toBe("1");
    expect(() => ids.bind("anything", "else")).not.toThrow();
  });

  it("refuses a provisional-to-provisional pair a classifierless instance stored", () => {
    const kv = makeKv();
    // `bind` validates only where a classifier exists, so this pair is writable.
    new ProvisionalIds<string>(kv, { namespace: "issues:" }).bind("~1", "~2");

    const guarded = new ProvisionalIds<string>(kv, {
      namespace: "issues:",
      isProvisional: id => id.startsWith("~"),
    });
    expect(guarded.resolve("~1")).toBe("~2");
    expect(() => guarded.requireResolved("~1")).toThrow(/bound to ~2, which has not been created/);
  });

  it("ignores a binding whose key is already a provider ID", () => {
    const kv = makeKv();
    // Same shape, the other way round: a classifierless instance shadowed a real ID.
    new ProvisionalIds<string>(kv, { namespace: "issues:" }).bind("real-1", "real-2");

    const guarded = new ProvisionalIds<string>(kv, {
      namespace: "issues:",
      isProvisional: id => id.startsWith("~"),
    });
    expect(guarded.resolve("real-1")).toBe("real-1");
    expect(guarded.requireResolved("real-1")).toBe("real-1");
  });

  it("persists optional kind tags across instances", () => {
    const kv = makeKv();
    const ids = new ProvisionalIds<string>(kv, { namespace: "issues:" });
    const page = ids.allocate(sequence => `~${sequence}`, { kind: "page" });
    const untagged = ids.allocate(sequence => `~${sequence}`);

    expect(ids.kindOf(page)).toBe("page");
    expect(ids.kindOf(untagged)).toBeUndefined();
    expect(new ProvisionalIds<string>(kv, { namespace: "issues:" }).kindOf(page)).toBe("page");
  });

  it("rejects a mismatched kind before checking whether the provisional is bound", () => {
    const ids = new ProvisionalIds<string>(makeKv(), {
      namespace: "issues:",
      isProvisional: id => id.startsWith("~"),
    });
    const page = ids.allocate(sequence => `~${sequence}`, { kind: "page" });

    expect(() => ids.requireResolved(page, { expectedKind: "comment" })).toThrow(
      "~1 is a page, not a comment.",
    );
  });

  it("resolves matching kinds and passes through real provider IDs without recorded kinds", () => {
    const ids = new ProvisionalIds<string>(makeKv(), {
      namespace: "issues:",
      isProvisional: id => id.startsWith("~"),
    });
    const comment = ids.allocate(sequence => `~${sequence}`, { kind: "comment" });
    ids.bind(comment, "real-1");

    expect(ids.requireResolved(comment, { expectedKind: "comment" })).toBe("real-1");
    expect(ids.requireResolved("real-2", { expectedKind: "comment" })).toBe("real-2");
  });
});
