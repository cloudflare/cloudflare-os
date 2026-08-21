import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObserverTracker } from "../src/observers";
import type { ObserverKv } from "../src/observers";

/** An in-memory stand-in for a Durable Object's `ctx.storage.kv`, preserving insertion order. */
class FakeKv implements ObserverKv {
  entries = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.entries.get(key) as T | undefined;
  }
  put<T>(key: string, value: T): void {
    this.entries.set(key, value);
  }
  delete(key: string): void {
    this.entries.delete(key);
  }
  list<T>({ prefix }: { prefix: string }): Iterable<[string, T]> {
    return [...this.entries]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key, value as T]);
  }
}

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
    hasAccess: overrides.hasAccess ?? ((verifier, value) => verifier.check(value)),
    deniedMessage: value => `no access to ${value}`,
    ...overrides,
  });
}

const allow = (...values: string[]) => new FakeVerifier(new Set(values));
const states = () => [...kv.list<string>({ prefix: "set:" })];

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
