import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ObserverBatchResult, ObserverTracker } from "../src/observers";
import { FakeKv } from "./fake-kv";

/** A verifier that grants access to a fixed allow-list, and records what it was asked. */
class FakeVerifier {
  asked: string[] = [];
  constructor(public allowed: Set<string>) {}
  async check(value: string): Promise<boolean> {
    this.asked.push(value);
    return this.allowed.has(value);
  }
}

let kv: FakeKv;

function makeTracker(overrides: Partial<{
  maxTrackedSets: number;
  concurrency: number;
  recordObservers: boolean;
  hasAccess: (verifier: FakeVerifier, value: string) => Promise<boolean>;
}> = {}) {
  return new ObserverTracker<string, FakeVerifier>(kv, {
    setPrefix: "set:",
    encode: value => encodeURIComponent(value),
    decode: encoded => decodeURIComponent(encoded),
    hasAccess: overrides.hasAccess ?? (async (verifier, value) => {
      verifier.asked.push(value);
      return verifier.allowed.has(value);
    }),
    deniedMessage: value => `no access to ${value}`,
    ...overrides,
  });
}

const allow = (...values: string[]) => new FakeVerifier(new Set(values));
const states = () => [...kv.list<string>({ prefix: "set:" })];
const nonceKeys = () => [...kv.list({ prefix: "observer-nonce:" })];
const attemptKeys = () => [...kv.list({ prefix: "observer-attempt:" })];

beforeEach(() => { kv = new FakeKv(); });

describe("construction", () => {
  it("refuses a set prefix that would collide with the observer records", () => {
    expect(() => new ObserverTracker<string, FakeVerifier>(kv, {
      setPrefix: "observer:",
      encode: v => v,
      decode: v => v,
      hasAccess: async () => true,
      deniedMessage: () => "denied",
    })).toThrow(/must not collide/);
  });

  it("refuses a bulk verifier that does not record observers", () => {
    expect(() => new ObserverTracker<string, FakeVerifier>(kv, {
      setPrefix: "set:",
      encode: v => v,
      decode: v => v,
      verifyBatch: async () => ({ baselineAllowed: true, allowed: [] }),
      baselineDeniedMessage: "no Drive grant",
      deniedMessage: () => "denied",
      recordObservers: false,
    })).toThrow(/must record observers/);
  });

  it("refuses both a per-set and a bulk verifier", () => {
    expect(() => new ObserverTracker<string, FakeVerifier>(kv, {
      setPrefix: "set:",
      encode: v => v,
      decode: v => v,
      hasAccess: async () => true,
      verifyBatch: async () => ({ baselineAllowed: true, allowed: [] }),
      baselineDeniedMessage: "no Drive grant",
      deniedMessage: () => "denied",
    })).toThrow(/exactly one/);
  });

  it("refuses a bulk verifier without a baseline denial message", () => {
    expect(() => new ObserverTracker<string, FakeVerifier>(kv, {
      setPrefix: "set:",
      encode: v => v,
      decode: v => v,
      verifyBatch: async () => ({ baselineAllowed: true, allowed: [] }),
      deniedMessage: () => "denied",
    })).toThrow(/baselineDeniedMessage/);
  });
});

describe("prepareObservation", () => {
  it("marks unknown sets pending and reports them", async () => {
    let check = await makeTracker().prepareObservation(["a", "b"]);
    expect(check.pendingSets).toEqual(["a", "b"]);
    expect(states()).toEqual([["set:a", "pending"], ["set:b", "pending"]]);
  });

  it("deduplicates repeated values", async () => {
    let check = await makeTracker().prepareObservation(["a", "a", "b", "a"]);
    expect(check.pendingSets).toEqual(["a", "b"]);
  });

  it("promotes pending to observed only on commit", async () => {
    let tracker = makeTracker();
    let check = await tracker.prepareObservation(["a"]);
    expect(states()).toEqual([["set:a", "pending"]]);
    check.commit();
    expect(states()).toEqual([["set:a", "observed"]]);
  });

  // A read that was never authorized must not permanently narrow who may observe this binding.
  it("re-reports a set left pending by an unauthorized read", async () => {
    let tracker = makeTracker();
    await tracker.prepareObservation(["a"]);
    expect((await tracker.prepareObservation(["a"])).pendingSets).toEqual(["a"]);
  });

  it("skips a set already observed", async () => {
    let tracker = makeTracker();
    (await tracker.prepareObservation(["a"])).commit();
    let check = await tracker.prepareObservation(["a", "b"]);
    expect(check.pendingSets).toEqual(["b"]);
  });

  it("treats the legacy `true` state as observed", async () => {
    kv.put("set:a", true);
    expect((await makeTracker().prepareObservation(["a"])).pendingSets).toEqual([]);
  });

  it("reports no exclusions and does not write when nothing is new", async () => {
    let tracker = makeTracker();
    (await tracker.prepareObservation(["a"])).commit();
    let verifier = allow("a");
    await tracker.addObserver("obs", verifier);
    verifier.asked.length = 0;

    let check = await tracker.prepareObservation(["a"]);
    expect(check.excludeObservers).toBeUndefined();
    expect(verifier.asked).toEqual([]);
  });

  describe("forward exclusion", () => {
    it("excludes an existing observer who cannot reach a newly-read set", async () => {
      let tracker = makeTracker();
      await tracker.addObserver("reader", allow("a"));
      await tracker.addObserver("outsider", allow());

      let check = await tracker.prepareObservation(["a"]);
      expect(check.excludeObservers).toEqual(["outsider"]);
    });

    it("keeps an observer who can reach every pending set", async () => {
      let tracker = makeTracker();
      await tracker.addObserver("reader", allow("a", "b"));

      let check = await tracker.prepareObservation(["a", "b"]);
      expect(check.excludeObservers).toBeUndefined();
    });

    it("excludes an observer missing any one of several pending sets", async () => {
      let tracker = makeTracker();
      await tracker.addObserver("partial", allow("a"));

      let check = await tracker.prepareObservation(["a", "b"]);
      expect(check.excludeObservers).toEqual(["partial"]);
    });

    it("reports each excluded observer once", async () => {
      let tracker = makeTracker();
      await tracker.addObserver("outsider", allow());

      let check = await tracker.prepareObservation(["a", "b", "c"]);
      expect(check.excludeObservers).toEqual(["outsider"]);
    });
  });
});

describe("addObserver", () => {
  it("admits and records an observer who can reach every tracked set", async () => {
    let tracker = makeTracker();
    (await tracker.prepareObservation(["a", "b"])).commit();

    await tracker.addObserver("reader", allow("a", "b"));
    expect([...tracker.observers()].map(([id]) => id)).toEqual(["reader"]);
  });

  it("admits against an empty tracked set without asking anything", async () => {
    let verifier = allow();
    await makeTracker().addObserver("reader", verifier);
    expect(verifier.asked).toEqual([]);
  });

  it("throws naming the first set the observer cannot reach", async () => {
    let tracker = makeTracker();
    (await tracker.prepareObservation(["a", "b"])).commit();

    await expect(tracker.addObserver("outsider", allow("a")))
      .rejects.toThrow("no access to b");
    expect([...tracker.observers()]).toEqual([]);
  });

  // Sets left pending by an in-flight read still count: the data may yet be disclosed.
  it("verifies against pending sets, not just observed ones", async () => {
    let tracker = makeTracker();
    await tracker.prepareObservation(["a"]);
    await expect(tracker.addObserver("outsider", allow())).rejects.toThrow("no access to a");
  });

  // The overseer re-runs addObserver on every open, which is what makes revocation take effect.
  it("re-checks every tracked set on each call rather than caching", async () => {
    let tracker = makeTracker();
    (await tracker.prepareObservation(["a"])).commit();
    let verifier = allow("a");

    await tracker.addObserver("reader", verifier);
    await tracker.addObserver("reader", verifier);
    expect(verifier.asked).toEqual(["a", "a"]);

    verifier.allowed.delete("a");
    await expect(tracker.addObserver("reader", verifier)).rejects.toThrow("no access to a");
  });

  // Otherwise a set first read during the round trip would never be verified for this observer.
  it("picks up a set that became tracked while it was awaiting", async () => {
    let tracker = makeTracker();
    (await tracker.prepareObservation(["a"])).commit();

    let verifier = allow("a");
    let injected = false;
    let racy = makeTracker({
      hasAccess: async (v, value) => {
        if (!injected) {
          injected = true;
          kv.put("set:b", "observed");
        }
        return v.check(value);
      },
    });

    await expect(racy.addObserver("reader", verifier)).rejects.toThrow("no access to b");
  });

  it("does not re-ask about sets already checked in this call", async () => {
    let tracker = makeTracker();
    (await tracker.prepareObservation(["a", "b"])).commit();
    let verifier = allow("a", "b");

    await tracker.addObserver("reader", verifier);
    expect(verifier.asked.toSorted()).toEqual(["a", "b"]);
  });

  it("omits the observer record when the caller has nobody to forward-exclude", async () => {
    let tracker = makeTracker({ recordObservers: false });
    await tracker.addObserver("reader", allow());
    expect([...tracker.observers()]).toEqual([]);
  });

  describe("cardinality cap", () => {
    let fill = (count: number) => {
      for (let i = 0; i < count; i++) kv.put(`set:s${i}`, "observed");
    };

    // The cap bounds what addObserver has to verify, but enforcing it there would deny every
    // collaborator on every reopen once passed -- including the ones already using the gadget,
    // with no way back, since tracked sets are never dropped. So the read is what fails.
    it("refuses to record a read that would pass the cap, naming the remedy", async () => {
      fill(3);
      let tracker = makeTracker({ maxTrackedSets: 3 });
      await expect(tracker.prepareObservation(["extra"]))
        .rejects.toThrow(/read 3 distinct items.*Bind a narrower scope/s);
    });

    it("records a read that lands exactly on the cap", async () => {
      fill(2);
      let tracker = makeTracker({ maxTrackedSets: 3 });
      expect((await tracker.prepareObservation(["extra"])).pendingSets).toEqual(["extra"]);
    });

    it("counts the whole batch, not one set at a time", async () => {
      fill(2);
      let tracker = makeTracker({ maxTrackedSets: 3 });
      await expect(tracker.prepareObservation(["x", "y"])).rejects.toThrow(/narrower scope/);
      expect(kv.get("set:x")).toBeUndefined();
      expect(kv.get("set:y")).toBeUndefined();
    });

    // Re-reading what the binding already tracks costs nothing new, so the cap must not turn a
    // binding sitting on the limit into one that can no longer read its own data.
    it("keeps serving reads of sets it already tracks", async () => {
      fill(3);
      let tracker = makeTracker({ maxTrackedSets: 3 });
      expect((await tracker.prepareObservation(["s0", "s1"])).pendingSets).toEqual([]);
    });

    it("does not count a duplicate within one batch twice", async () => {
      fill(2);
      let tracker = makeTracker({ maxTrackedSets: 3 });
      expect((await tracker.prepareObservation(["dup", "dup"])).pendingSets).toEqual(["dup"]);
    });

    // A binding at the cap is still shareable -- that is the whole point of capping the read.
    it("admits observers at the cap", async () => {
      fill(3);
      let tracker = makeTracker({ maxTrackedSets: 3 });
      await expect(tracker.addObserver("reader", allow("s0", "s1", "s2"))).resolves.toBeUndefined();
    });
});
});

describe("bulk verification", () => {
  function makeBulkTracker(verifyBatch: (
    verifier: FakeVerifier, values: readonly string[],
  ) => Promise<ObserverBatchResult>) {
    return new ObserverTracker<string, FakeVerifier>(kv, {
      setPrefix: "set:",
      encode: value => encodeURIComponent(value),
      decode: encoded => decodeURIComponent(encoded),
      verifyBatch,
      deniedMessage: value => `no access to ${value}`,
      baselineDeniedMessage: "no Drive grant",
    });
  }

  it("checks every tracked set in one verifier call on open", async () => {
    kv.put("set:a", "observed");
    kv.put("set:b", "pending");
    let verifyBatch = vi.fn(async (_verifier: FakeVerifier, values: readonly string[]) => ({
      baselineAllowed: true, allowed: values.map(() => true),
    }));

    await makeBulkTracker(verifyBatch).addObserver("reader", allow());
    expect(verifyBatch).toHaveBeenCalledTimes(1);
    expect(verifyBatch).toHaveBeenCalledWith(expect.any(FakeVerifier), ["a", "b"]);
  });

  it("checks the Drive grant even when no files have been observed", async () => {
    let verifyBatch = vi.fn(async () => ({ baselineAllowed: false, allowed: [] }));
    await expect(makeBulkTracker(verifyBatch).addObserver("reader", allow()))
      .rejects.toThrow("no Drive grant");
    expect(verifyBatch).toHaveBeenCalledOnce();
    expect(verifyBatch).toHaveBeenCalledWith(expect.any(FakeVerifier), []);
    expect([...makeBulkTracker(verifyBatch).observers()]).toEqual([]);
    expect(nonceKeys()).toEqual([]);
  });

  it("leaves no observer or nonce after a per-file denial", async () => {
    kv.put("set:a", "observed");
    let tracker = makeBulkTracker(async () => ({ baselineAllowed: true, allowed: [false] }));
    await expect(tracker.addObserver("reader", allow())).rejects.toThrow("no access to a");
    expect([...tracker.observers()]).toEqual([]);
    expect(nonceKeys()).toEqual([]);
  });

  it("records a successful admission and deletes the nonce", async () => {
    kv.put("set:a", "observed");
    let tracker = makeBulkTracker(async () => ({ baselineAllowed: true, allowed: [true] }));
    await tracker.addObserver("reader", allow());
    expect([...tracker.observers()].map(([id]) => id)).toEqual(["reader"]);
    expect(nonceKeys()).toEqual([]);
  });

  it("keeps a newer same-ID admission authoritative when the older attempt finishes first", async () => {
    kv.put("set:a", "observed");
    let releaseA!: (result: ObserverBatchResult) => void;
    let releaseB!: (result: ObserverBatchResult) => void;
    let resultA = new Promise<ObserverBatchResult>(resolve => { releaseA = resolve; });
    let resultB = new Promise<ObserverBatchResult>(resolve => { releaseB = resolve; });
    let verifierA = allow();
    let verifierB = allow();
    let verifyBatch = vi.fn(async (verifier: FakeVerifier) =>
      verifier === verifierA ? resultA : resultB);
    let tracker = makeBulkTracker(verifyBatch);

    let admissionA = tracker.addObserver("reader", verifierA);
    await vi.waitFor(() => expect(verifyBatch).toHaveBeenCalledWith(verifierA, ["a"]));
    let admissionB = tracker.addObserver("reader", verifierB);
    await vi.waitFor(() => expect(verifyBatch).toHaveBeenCalledWith(verifierB, ["a"]));

    releaseA({ baselineAllowed: true, allowed: [true] });
    await expect(admissionA).rejects.toThrow(
      "Observer admission was superseded by a newer attempt");
    releaseB({ baselineAllowed: true, allowed: [false] });
    await expect(admissionB).rejects.toThrow("no access to a");
    expect([...tracker.observers()]).toEqual([]);
    expect(nonceKeys()).toEqual([]);
  });

  it("rechecks files tracked while bulk admission is awaiting", async () => {
    kv.put("set:a", "observed");
    let release!: () => void;
    let started!: () => void;
    let opening = new Promise<void>(resolve => { release = resolve; });
    let firstCall = new Promise<void>(resolve => { started = resolve; });
    let verifyBatch = vi.fn(async (_verifier: FakeVerifier, values: readonly string[]) => {
      if (values.includes("a")) {
        started();
        await opening;
      }
      return { baselineAllowed: true, allowed: values.map(value => value !== "b") };
    });
    let tracker = makeBulkTracker(verifyBatch);

    let admission = tracker.addObserver("reader", allow());
    await firstCall;
    expect([...tracker.observers()].map(([id]) => id)).toEqual(["reader"]);
    expect((await tracker.prepareObservation(["b"])).excludeObservers).toEqual(["reader"]);
    release();

    await expect(admission).rejects.toThrow("no access to b");
    expect(verifyBatch.mock.calls.filter(call => call[1].includes("b"))).toHaveLength(2);
    expect([...tracker.observers()]).toEqual([]);
    expect(attemptKeys()).toEqual([]);
    expect(nonceKeys()).toEqual([]);
  });

  it("checks one pending batch per existing observer", async () => {
    let verifyBatch = vi.fn(async (_verifier: FakeVerifier, values: readonly string[]) => ({
      baselineAllowed: true, allowed: values.map(() => true),
    }));
    let tracker = makeBulkTracker(verifyBatch);
    await tracker.addObserver("one", allow());
    await tracker.addObserver("two", allow());
    verifyBatch.mockClear();

    await tracker.prepareObservation(["a", "b"]);
    expect(verifyBatch).toHaveBeenCalledTimes(2);
    expect(verifyBatch.mock.calls.map(call => call[1])).toEqual([["a", "b"], ["a", "b"]]);
  });

  it("preserves the canonical verifier when same-ID re-verification fails", async () => {
    kv.put("set:a", "observed");
    let tracker = makeBulkTracker(async (verifier, values) => ({
      baselineAllowed: true, allowed: values.map(value => verifier.allowed.has(value)),
    }));
    await tracker.addObserver("reader", allow("a", "b"));

    await expect(tracker.addObserver("reader", allow()))
      .rejects.toThrow("no access to a");

    expect([...tracker.observers()].map(([id]) => id)).toEqual(["reader"]);
    expect((await tracker.prepareObservation(["b"])).excludeObservers).toBeUndefined();
    expect(attemptKeys()).toEqual([]);
    expect(nonceKeys()).toEqual([]);
  });

  it("checks canonical and staged verifiers but excludes one observer ID", async () => {
    kv.put("set:a", "observed");
    let release!: () => void;
    let started!: () => void;
    let opening = new Promise<void>(resolve => { release = resolve; });
    let newStarted = new Promise<void>(resolve => { started = resolve; });
    let calls: {tag: string, values: readonly string[]}[] = [];
    let blockNew = false;
    let tracker = makeBulkTracker(async (verifier, values) => {
      let tag = verifier.allowed.has("new") ? "new" : "old";
      calls.push({ tag, values: [...values] });
      if (blockNew && tag === "new" && values.includes("a")) {
        started();
        await opening;
      }
      return { baselineAllowed: true, allowed: values.map(value => verifier.allowed.has(value)) };
    });
    await tracker.addObserver("reader", allow("old", "a"));
    blockNew = true;

    let admission = tracker.addObserver("reader", allow("new", "a"));
    await newStarted;
    expect((await tracker.prepareObservation(["b"])).excludeObservers).toEqual(["reader"]);
    expect(calls.filter(call => call.values.includes("b")).map(call => call.tag).toSorted())
      .toEqual(["new", "old"]);
    release();
    await expect(admission).rejects.toThrow("no access to b");
  });

  it("does not let a superseded attempt overwrite the newer verifier", async () => {
    kv.put("set:a", "observed");
    let releaseA!: (result: ObserverBatchResult) => void;
    let releaseB!: (result: ObserverBatchResult) => void;
    let startedA!: () => void;
    let startedB!: () => void;
    let resultA = new Promise<ObserverBatchResult>(resolve => { releaseA = resolve; });
    let resultB = new Promise<ObserverBatchResult>(resolve => { releaseB = resolve; });
    let seenA = new Promise<void>(resolve => { startedA = resolve; });
    let seenB = new Promise<void>(resolve => { startedB = resolve; });
    let verifierA = allow("a");
    let verifierB = allow("a", "new");
    let tracker = makeBulkTracker(async verifier => {
      if (verifier === verifierA) { startedA(); return resultA; }
      startedB();
      return resultB;
    });

    let admissionA = tracker.addObserver("reader", verifierA);
    await seenA;
    let admissionB = tracker.addObserver("reader", verifierB);
    await seenB;
    releaseB({ baselineAllowed: true, allowed: [true] });
    await expect(admissionB).resolves.toBeUndefined();
    releaseA({ baselineAllowed: true, allowed: [true] });
    await expect(admissionA).rejects.toThrow(/superseded/);

    let observers = [...tracker.observers()];
    expect(observers).toHaveLength(1);
    expect(observers[0][1].allowed).toEqual(new Set(["a", "new"]));
    expect(attemptKeys()).toEqual([]);
    expect(nonceKeys()).toEqual([]);
  });

  it("lets removeObserver win over an in-flight admission", async () => {
    let release!: (result: ObserverBatchResult) => void;
    let started!: () => void;
    let result = new Promise<ObserverBatchResult>(resolve => { release = resolve; });
    let seen = new Promise<void>(resolve => { started = resolve; });
    let tracker = makeBulkTracker(async () => { started(); return result; });

    let admission = tracker.addObserver("reader", allow());
    await seen;
    tracker.removeObserver("reader");
    release({ baselineAllowed: true, allowed: [] });

    await expect(admission).rejects.toThrow(/superseded/);
    expect([...tracker.observers()]).toEqual([]);
    expect(attemptKeys()).toEqual([]);
    expect(nonceKeys()).toEqual([]);
  });

  it("rejects malformed cardinality in a second stable-set batch", async () => {
    kv.put("set:a", "observed");
    let release!: () => void;
    let started!: () => void;
    let opening = new Promise<void>(resolve => { release = resolve; });
    let seen = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    let tracker = makeBulkTracker(async (_verifier, values) => {
      if (calls++ === 0) { started(); await opening; }
      return { baselineAllowed: true, allowed: calls === 1 ? values.map(() => true) : [] };
    });

    let admission = tracker.addObserver("reader", allow());
    await seen;
    kv.put("set:b", "pending");
    release();

    await expect(admission).rejects.toThrow(/one result per set/);
    expect(attemptKeys()).toEqual([]);
    expect(nonceKeys()).toEqual([]);
  });
  it("rejects a malformed verifier result rather than admitting unchecked files", async () => {
    kv.put("set:a", "observed");
    let tracker = makeBulkTracker(async () => ({ baselineAllowed: true, allowed: [] }));
    await expect(tracker.addObserver("reader", allow())).rejects.toThrow(/one result per set/);
    expect([...tracker.observers()]).toEqual([]);
    expect(nonceKeys()).toEqual([]);
  });
});

describe("removeObserver", () => {
  it("drops the record and stops forward-excluding them", async () => {
    let tracker = makeTracker();
    await tracker.addObserver("outsider", allow());
    tracker.removeObserver("outsider");

    expect([...tracker.observers()]).toEqual([]);
    expect((await tracker.prepareObservation(["a"])).excludeObservers).toBeUndefined();
  });

  it("is a no-op for an unknown id", () => {
    expect(() => makeTracker().removeObserver("nobody")).not.toThrow();
  });
});

describe("listTracked", () => {
  it("round-trips values through encode and decode", async () => {
    let tracker = makeTracker();
    (await tracker.prepareObservation(["a/b", "c d", "e:f"])).commit();
    expect(tracker.listTracked()).toEqual(["a/b", "c d", "e:f"]);
  });

  it("does not confuse observer records for tracked sets", async () => {
    let tracker = makeTracker();
    await tracker.addObserver("reader", allow());
    expect(tracker.listTracked()).toEqual([]);
  });
});

describe("concurrency", () => {
  /** Counts peak overlap of `hasAccess` calls. */
  function tracking(limit: number) {
    let inFlight = 0;
    let peak = 0;
    let tracker = makeTracker({
      concurrency: limit,
      hasAccess: async () => {
        peak = Math.max(peak, ++inFlight);
        await Promise.resolve();
        inFlight--;
        return true;
      },
    });
    return { tracker, peak: () => peak };
  }

  it("bounds the fan-out when verifying a joining observer", async () => {
    for (let i = 0; i < 20; i++) kv.put(`set:s${i}`, "observed");
    let { tracker, peak } = tracking(4);
    await tracker.addObserver("reader", allow());
    expect(peak()).toBeLessThanOrEqual(4);
  });

  // The pairs are observers x sets, so nesting two unbounded Promise.alls multiplies out.
  it("bounds the fan-out across observers and pending sets together", async () => {
    let seed = makeTracker();
    for (let i = 0; i < 5; i++) await seed.addObserver(`obs${i}`, allow());

    let { tracker, peak } = tracking(4);
    await tracker.prepareObservation(Array.from({ length: 6 }, (_, i) => `s${i}`));
    expect(peak()).toBeLessThanOrEqual(4);
  });

  it("still checks every pair", async () => {
    let seed = makeTracker();
    for (let i = 0; i < 3; i++) await seed.addObserver(`obs${i}`, allow("a", "b"));

    let hasAccess = vi.fn(async () => true);
    let tracker = makeTracker({ concurrency: 2, hasAccess });
    await tracker.prepareObservation(["a", "b"]);
    expect(hasAccess).toHaveBeenCalledTimes(6);
  });
});
