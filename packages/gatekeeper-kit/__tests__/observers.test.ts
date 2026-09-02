import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalQueue, GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import type { RpcStub } from "cloudflare:workers";
import {
  aclObservers,
  escapeObservationValue,
  ObservationGate,
  OBSERVER_ATTEMPT_LIFETIME_MS,
  OBSERVER_DENIED,
  OBSERVER_WITHHELD,
  ObserverTracker,
  openObservers,
  privateObservers,
  trackedSetObservers,
  type ObserverKv,
  type ObserverStrategy,
  type ObserverTrackerOptions,
} from "../src/observers";
import { fakeKv } from "./fake-kv";

function makeKv(): ObserverKv {
  return fakeKv();
}

// Fixed ACL verifier that records each batched check.
type V = { allowed: string[]; batches: (readonly string[])[] };

function verifier(...allowed: string[]): V {
  return { allowed, batches: [] };
}

function tracker(kv: ObserverKv = makeKv(), options: Partial<ObserverTrackerOptions<V>> = {}) {
  return new ObserverTracker<V>({
    kv,
    hasSetAccess: async (value, setIds) => {
      value.batches.push(setIds);
      return setIds.map(setId => value.allowed.includes(setId));
    },
    ...options,
  });
}

async function observe(instance: ObserverTracker<V>, sets: string[]) {
  const check = await instance.prepareObservation(sets);
  check.commit();
  return check.excludeObservers;
}

// Approval queue fake that records authorization requests.
function fakeQueue(authorizeObservation = vi.fn(async () => {})) {
  return { authorizeObservation } as unknown as RpcStub<ApprovalQueue>;
}

const someUser = {} as Fetcher<GatekeeperUserVerifier>;

afterEach(() => void vi.useRealTimers());

describe("ObserverTracker", () => {
  it("verifies every observed set before storing an observer, in one batched call", async () => {
    const instance = tracker();
    await observe(instance, ["a", "b"]);

    const denied = verifier("a");
    await expect(instance.addObserver("x", denied)).rejects.toThrow(/does not have access/);

    const allowed = verifier("a", "b");
    await instance.addObserver("y", allowed);
    expect(allowed.batches).toEqual([["a", "b"]]);
  });

  it("excludes stored observers from newly observed sets and removes idempotently", async () => {
    const instance = tracker();
    await instance.addObserver("full", verifier("a", "b", "c"));
    await instance.addObserver("limited", verifier("a"));

    expect(await observe(instance, ["a"])).toBeUndefined();
    expect(await observe(instance, ["b"])).toEqual(["limited"]);
    // Already observed, but still re-verified: the verdict is not cached in the set's state.
    expect(await observe(instance, ["b"])).toEqual(["limited"]);
    instance.removeObserver("limited");
    instance.removeObserver("limited");
    expect(await observe(instance, ["c"])).toBeUndefined();
  });

  it("excludes an observer that lost access to a set it was already shown", async () => {
    // A verdict recorded at first disclosure must not outlive a provider-side ACL revocation.
    let revoked = false;
    const instance = tracker(makeKv(), { hasSetAccess: async () => [!revoked] });
    await instance.addObserver("x", verifier("a"));
    expect(await observe(instance, ["a"])).toBeUndefined();

    revoked = true;
    expect(await observe(instance, ["a"])).toEqual(["x"]);
  });

  it("rechecks a blocked pending set until an observation commits it", async () => {
    const kv = makeKv();
    const instance = tracker(kv);
    await instance.addObserver("limited", verifier());

    const first = await instance.prepareObservation(["secret"]);
    expect(first.excludeObservers).toEqual(["limited"]);
    expect(kv.get("observed:secret")).toBe("pending");
    expect((await instance.prepareObservation(["secret"])).excludeObservers).toEqual(["limited"]);

    instance.removeObserver("limited");
    const allowed = await instance.prepareObservation(["secret"]);
    expect(allowed.excludeObservers).toBeUndefined();
    allowed.commit();
    expect(kv.get("observed:secret")).toBe("observed");
  });

  it("verifies an observer admitted while a set is still pending", async () => {
    const kv = makeKv();
    const instance = tracker(kv);
    const preparing = instance.prepareObservation(["new"]);
    expect(kv.get("observed:new")).toBe("pending");

    const denied = verifier();
    await expect(instance.addObserver("late", denied)).rejects.toThrow(/does not have access/);
    (await preparing).commit();
    expect(denied.batches).toEqual([["new"]]);
  });

  it("leaves the pending records of a read that never disclosed", async () => {
    // A pending record means the read never committed, so nothing was shown. Keeping it costs a
    // tracking slot and denies an observer a set nobody saw, which the whole corpus accepts.
    const kv = makeKv();
    const instance = tracker(kv);
    const refused = await instance.prepareObservation(["secret"]);
    expect(kv.get("observed:secret")).toBe("pending");

    refused.discard?.();
    expect(kv.get("observed:secret")).toBe("pending");

    // Still admission-relevant, and promoted by the next read that does commit.
    const denied = verifier();
    await expect(instance.addObserver("late", denied)).rejects.toThrow(/does not have access/);
    expect(denied.batches).toEqual([["secret"]]);
    (await instance.prepareObservation(["secret"])).commit();
    expect(kv.get("observed:secret")).toBe("observed");
  });

  it("refuses an observer past the cap, and still re-admits one it already answers for", async () => {
    // Every observer costs a verifier call per read, and a request may make only 32 Worker
    // invocations, so admission is where the ceiling has to be legible.
    const kv = makeKv();
    const instance = tracker(kv, { maxObservers: 2 });
    await instance.addObserver("x", verifier());
    await instance.addObserver("y", verifier());

    await expect(instance.addObserver("z", verifier())).rejects.toThrow(/already answers for 2/);
    await expect(instance.addObserver("x", verifier())).resolves.toBeUndefined();
  });

  it("reclaims the slot of an admission a crash stranded, once the attempt ages out", async () => {
    vi.useFakeTimers();
    const kv = makeKv();
    const gate = Promise.withResolvers<void>();
    let batches = 0;
    const instance = tracker(kv, {
      maxObservers: 1,
      hasSetAccess: async (value, setIds) => {
        if (++batches === 1) await gate.promise;
        return setIds.map(setId => value.allowed.includes(setId));
      },
    });
    await observe(instance, ["a"]);

    // The ghost's activation "dies" parked in its ACL check, holding the only slot.
    const stranded = instance.addObserver("ghost", verifier("a"));
    vi.advanceTimersByTime(OBSERVER_ATTEMPT_LIFETIME_MS);

    await instance.addObserver("next", verifier("a"));
    expect(instance.observerIds()).toEqual(["next"]);
    expect(kv.get("observer-nonce:ghost")).toBeUndefined();

    // Were the ghost still alive, the sweep merely failed it closed at its next nonce check.
    gate.resolve();
    await expect(stranded).rejects.toThrow(/was removed while being admitted/);
  });

  it("sweeps a stale attempt's nonce first, so a failed sweep still cancels its admission", async () => {
    const kv = makeKv();
    // The half-failure: the nonce delete lands, the attempt delete does not.
    const flaky: ObserverKv = {
      ...kv,
      delete: (key: string) => {
        if (key === "observer-attempt:ghost") throw new Error("storage unavailable");
        kv.delete(key);
      },
    };
    const instance = tracker(flaky);
    kv.put("observer-attempt:ghost", { verifier: verifier(), at: 0 });
    kv.put("observer-nonce:ghost", "stale");

    await expect(instance.addObserver("next", verifier())).rejects.toThrow("storage unavailable");
    // The cancellation landed even though the removal did not, so the surviving attempt still
    // holds its slot and the stale admission fails closed at its next nonce check.
    expect(kv.get("observer-nonce:ghost")).toBeUndefined();
    expect(kv.get("observer-attempt:ghost")).toBeDefined();
  });

  it("keeps a fresh in-flight admission counted against the cap", async () => {
    const gate = Promise.withResolvers<void>();
    let batches = 0;
    const instance = tracker(makeKv(), {
      maxObservers: 1,
      hasSetAccess: async (value, setIds) => {
        if (++batches === 1) await gate.promise;
        return setIds.map(setId => value.allowed.includes(setId));
      },
    });
    await observe(instance, ["a"]);

    const admitting = instance.addObserver("first", verifier("a"));
    await expect(instance.addObserver("second", verifier("a")))
      .rejects.toThrow(/already answers for 1/);
    gate.resolve();
    await admitting;
    expect(instance.observerIds()).toEqual(["first"]);
  });

  it("leaves a set alone once another read has revealed it", async () => {
    const kv = makeKv();
    const instance = tracker(kv);
    const refused = await instance.prepareObservation(["secret"]);
    const disclosed = await instance.prepareObservation(["secret"]);

    disclosed.commit();
    refused.discard?.();

    expect(kv.get("observed:secret")).toBe("observed");
  });

  it("denies an observer when a set appears while its first ACL batch is in flight", async () => {
    const kv = makeKv();
    const gate = Promise.withResolvers<void>();
    let batches = 0;
    const instance = new ObserverTracker<V>({
      kv,
      hasSetAccess: async (value, setIds) => {
        value.batches.push(setIds);
        if (++batches === 1) await gate.promise;
        return setIds.map(setId => value.allowed.includes(setId));
      },
    });
    await observe(tracker(kv), ["first"]);

    // Admission is checking "first"; "second" becomes tracked before it can persist the verifier.
    const candidate = verifier("first");
    const admitting = instance.addObserver("x", candidate);
    await observe(tracker(kv), ["second"]);
    gate.resolve();

    await expect(admitting).rejects.toThrow(/does not have access/);
    expect(candidate.batches).toEqual([["first"], ["second"]]);
    expect(kv.get("observer:x")).toBeUndefined();
  });

  it("propagates a throwing baseline check before consulting any set", async () => {
    const instance = tracker(makeKv(), {
      verifyBaseline: async () => { throw new Error("not a member"); },
    });
    await observe(instance, ["a"]);

    const candidate = verifier("a");
    await expect(instance.addObserver("x", candidate)).rejects.toThrow("not a member");
    expect(candidate.batches).toEqual([]);
  });

  it("hands the failing set to denyMessage, whose returned text stays generic", async () => {
    // The message reaches the denied collaborator verbatim; the set id is for diagnostics only.
    const denied: string[] = [];
    const instance = tracker(makeKv(), {
      denyMessage: setId => (denied.push(setId), OBSERVER_DENIED),
    });
    await observe(instance, ["a", "b"]);

    await expect(instance.addObserver("x", verifier("a"))).rejects.toThrow(OBSERVER_DENIED);
    expect(denied).toEqual(["b"]);
  });

  it("treats a legacy `true` marker as observed", async () => {
    const kv = makeKv();
    kv.put("observed:old", true);
    const asked: string[][] = [];
    const instance = tracker(kv, {
      hasSetAccess: async (_value, setIds) => (asked.push([...setIds]), setIds.map(() => true)),
    });

    // The set counts as already revealed, so an incoming observer is checked against it...
    await instance.addObserver("x", verifier("old"));

    // ...and reading it again re-verifies it, but is not a fresh reveal, so nothing is rewritten.
    expect(await observe(instance, ["old"])).toBeUndefined();
    expect(asked).toEqual([["old"], ["old"]]);
    expect(kv.get("observed:old")).toBe(true);
  });

  it("excludes an observer when the oracle answers its exclusion check malformed", async () => {
    const kv = makeKv();
    const admitted = tracker(kv);
    await admitted.addObserver("x", verifier());

    const ragged = new ObserverTracker<V>({ kv, hasSetAccess: async () => [] });
    expect((await ragged.prepareObservation(["secret"])).excludeObservers).toEqual(["x"]);
  });

  it("gives each verifier its own batch, so a destructive oracle checks every observer", async () => {
    // Chunking the batch destructively is a legal oracle -- one verdict per set, in order. Shared,
    // the emptied array would make the exclusion check compare zero verdicts against zero sets and
    // admit "second" to a set nothing verified it against.
    const kv = makeKv();
    const chunking = new ObserverTracker<V>({
      kv,
      hasSetAccess: async (value, setIds) => {
        const batch = setIds as string[];
        const verdicts: boolean[] = [];
        while (batch.length > 0) {
          for (const setId of batch.splice(0, 2)) verdicts.push(value.allowed.includes(setId));
        }
        return verdicts;
      },
    });
    await chunking.addObserver("first", verifier("a", "b", "c"));
    await chunking.addObserver("second", verifier("a"));

    const check = await chunking.prepareObservation(["a", "b", "c"]);
    expect(check.excludeObservers).toEqual(["second"]);
    check.commit();
    expect(kv.get("observed:c")).toBe("observed");
  });

  it("excludes an observer whose verifier throws, rather than failing the read", async () => {
    // A stored verifier outlives the workspace that supplied it, and rejecting the batch would
    // take down every observation this binding makes from then on.
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const kv = makeKv();
      const admitted = tracker(kv);
      await admitted.addObserver("dead", verifier("secret"));
      await admitted.addObserver("live", verifier("secret"));

      const broken = new ObserverTracker<V>({
        kv,
        vendorId: "acme",
        hasSetAccess: async () => { throw new Error("no such Durable Object"); },
      });

      const check = await broken.prepareObservation(["secret"]);
      expect(check.excludeObservers).toEqual(["dead", "live"]);
      check.commit();

      // Withheld, but never silently.
      expect(logged).toHaveBeenCalledTimes(2);
      expect(logged.mock.calls.map(([entry]) => {
        const { event, observerId, vendorId } =
          entry as { event: string; observerId: string; vendorId: string };
        return { event, observerId, vendorId };
      })).toEqual([
        { event: "observers.access.check.failed", observerId: "dead", vendorId: "acme" },
        { event: "observers.access.check.failed", observerId: "live", vendorId: "acme" },
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it("refuses an admission a removal overtook, rather than reinstating the observer", async () => {
    // `addObserver` awaits its ACL checks with the input gate open, so a removal can land between.
    const kv = makeKv();
    const gate = Promise.withResolvers<void>();
    const instance = tracker(kv, {
      hasSetAccess: async (value, setIds) => {
        await gate.promise;
        return setIds.map(setId => value.allowed.includes(setId));
      },
    });
    await observe(instance, ["a"]);

    const admitting = instance.addObserver("x", verifier("a"));
    instance.removeObserver("x");
    gate.resolve();

    await expect(admitting).rejects.toThrow(/was removed while being admitted/);
    expect(instance.observerIds()).toEqual([]);
    // The nonce is rotated per attempt, not consumed, so a later admission is unaffected.
    await instance.addObserver("x", verifier("a"));
    expect(instance.observerIds()).toEqual(["x"]);
  });

  it("keeps the observed-set key family a port already has in storage", async () => {
    const kv = makeKv();
    const instance = tracker(kv, { setPrefix: "observedProject:" });
    await instance.addObserver("x", verifier("p1"));
    await observe(instance, ["p1"]);

    expect(kv.get("observer:x")).toBeDefined();
    expect(kv.get("observedProject:p1")).toBe("observed");
  });

  it("refuses a set prefix overlapping the observer family, either direction", () => {
    // Under an observer prefix, containing one, and the empty prefix that scans every family.
    for (const setPrefix of ["observer:sets:", "observer-attempt:x", "obs", ""]) {
      expect(() => new ObserverTracker<V>({ kv: makeKv(), setPrefix, hasSetAccess: async () => [] }))
        .toThrow(/overlaps the reserved prefix/);
    }
  });

  it("denies when the oracle answers fewer sets than it was asked about", async () => {
    const kv = makeKv();
    await observe(tracker(kv), ["a"]);
    const short = new ObserverTracker<V>({ kv, hasSetAccess: async () => [] });

    await expect(short.addObserver("x", verifier("a"))).rejects.toThrow(/does not have access/);
  });

  it("denies when the oracle answers MORE sets than it was asked about", async () => {
    const kv = makeKv();
    await observe(tracker(kv), ["a"]);
    // One set asked about, three verdicts back. Read positionally this admits on `[0]`, and the
    // extra entries — including a `false` — are never looked at. A length the oracle disagrees
    // about means the verdicts are not the answers to these questions.
    const overlong = new ObserverTracker<V>({
      kv, hasSetAccess: async () => [true, true, false],
    });

    await expect(overlong.addObserver("x", verifier("a"))).rejects.toThrow(/does not have access/);
    expect(kv.get("observer:x")).toBeUndefined();
  });

  it("excludes an observer whose exclusion verdicts are overlong", async () => {
    const kv = makeKv();
    const admitted = tracker(kv);
    await admitted.addObserver("x", verifier());

    const overlong = new ObserverTracker<V>({
      kv, hasSetAccess: async () => [true, true],
    });
    expect((await overlong.prepareObservation(["secret"])).excludeObservers).toEqual(["x"]);
  });

  it("refuses to reveal more sets than it can keep verifiable", async () => {
    const kv = makeKv();
    const instance = tracker(kv, { maxTrackedSets: 2 });
    await observe(instance, ["a", "b"]);

    await expect(instance.prepareObservation(["c"])).rejects.toThrow(/most it can track/);
    // At the cap the binding still reveals what it already tracks, and still admits observers:
    // capping admission instead would lock out the collaborators already relying on it.
    expect(await observe(instance, ["a"])).toBeUndefined();
    await expect(instance.addObserver("x", verifier("a", "b"))).resolves.toBeUndefined();
  });

  it("bounds how many verifiers it consults at once", async () => {
    const kv = makeKv();
    let inFlight = 0;
    let peak = 0;
    const instance = new ObserverTracker<V>({
      kv,
      concurrency: 2,
      hasSetAccess: async (_verifier, setIds) => {
        peak = Math.max(peak, ++inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return setIds.map(() => true);
      },
    });
    // Admitted before anything is tracked, so no oracle call happens here.
    for (const id of ["a", "b", "c", "d", "e"]) await instance.addObserver(id, verifier());

    await instance.prepareObservation(["secret"]);
    expect(peak).toBe(2);
  });

  it("refuses a cap or window that cannot make progress", () => {
    for (const options of [{ maxTrackedSets: 0 }, { concurrency: 0 }, { concurrency: 1.5 }]) {
      expect(() => tracker(makeKv(), options)).toThrow(/must be a positive integer/);
    }
  });

  it("lists admitted observers, for a read no set id describes", async () => {
    const instance = tracker();
    await instance.addObserver("x", verifier());
    await instance.addObserver("y", verifier());

    expect(instance.observerIds().toSorted()).toEqual(["x", "y"]);
    instance.removeObserver("x");
    expect(instance.observerIds()).toEqual(["y"]);
  });

  it("canonicalizes a set id everywhere one spelling has to win", async () => {
    const kv = makeKv();
    const asked: string[][] = [];
    const instance = tracker(kv, {
      setPrefix: "observedItem:",
      canonicalSetId: setId => setId.replaceAll("-", ""),
      hasSetAccess: async (_value, setIds) => (asked.push([...setIds]), setIds.map(() => true)),
    });

    // The hyphenated and bare spellings of one id are the same tracked set, not two.
    expect(await observe(instance, ["ab-cd", "abcd"])).toBeUndefined();
    expect(kv.get("observedItem:abcd")).toBe("observed");
    expect(kv.get("observedItem:ab-cd")).toBeUndefined();

    // Admission and every later check ask about the stored spelling, not the caller's.
    await instance.addObserver("x", verifier("abcd"));
    expect(await observe(instance, ["ab-cd"])).toBeUndefined();
    expect(asked).toEqual([["abcd"], ["abcd"]]);
  });

  it("canonicalizes exactly once, so even a non-idempotent transform agrees with itself", async () => {
    const kv = makeKv();
    // Encoding twice would store `a%252Fb` while the forward check asked about `a%2Fb`.
    const instance = tracker(kv, { setPrefix: "observedFile:", canonicalSetId: encodeURIComponent });

    const observer = verifier("a%2Fb");
    await instance.addObserver("x", observer);
    expect(await observe(instance, ["a/b"])).toBeUndefined();
    expect(kv.get("observedFile:a%2Fb")).toBe("observed");

    // Admission reads the stored key back, so it must ask about that same spelling.
    const joining = verifier("a%2Fb");
    await instance.addObserver("y", joining);
    expect(joining.batches).toEqual([["a%2Fb"]]);
  });
});

describe("observer strategies", () => {
  it("A: private bindings refuse every observer", async () => {
    const strategy = privateObservers("This mailbox cannot be shared.");
    await expect(strategy.addObserver("x", someUser)).rejects.toThrow("This mailbox cannot be shared.");
    await expect(strategy.removeObserver("x")).resolves.toBeUndefined();
    expect(strategy.prepare).toBeUndefined();
    // Vacuously owner-only: nobody is ever admitted, so an owner-only read excludes nobody.
    expect(strategy.prepareWithheld().excludeObservers).toBeUndefined();
  });

  it("B: ACL bindings deny on a negative answer and track nothing", async () => {
    const hasAccess = vi.fn(async () => false);
    const strategy = aclObservers({ hasAccess, denyMessage: "no access to the project" });

    await expect(strategy.addObserver("x", someUser)).rejects.toThrow("no access to the project");
    expect(hasAccess).toHaveBeenCalledOnce();
    expect(strategy.prepare).toBeUndefined();
    expect(strategy.observerIds).toBeUndefined();
  });

  it("B: ACL bindings admit on a positive answer, and share one default denial", async () => {
    await expect(aclObservers({ hasAccess: async () => true }).addObserver("x", someUser))
      .resolves.toBeUndefined();
    await expect(aclObservers({ hasAccess: async () => false }).addObserver("x", someUser))
      .rejects.toThrow(OBSERVER_DENIED);
  });

  it("B: ACL bindings deny a malformed answer rather than admitting it", async () => {
    // A hand-written oracle that resolves to a non-boolean must not be read as access, which is how
    // C treats a ragged answer from the same kind of API.
    const hasAccess = async () => "false" as unknown as boolean;
    await expect(aclObservers({ hasAccess }).addObserver("x", someUser))
      .rejects.toThrow(OBSERVER_DENIED);
  });

  it("C: tracked-set bindings expose the tracker's prepare()", async () => {
    const strategy = trackedSetObservers<V>({
      kv: makeKv(),
      hasSetAccess: async (_v, setIds) => setIds.map(() => false),
    });
    await strategy.addObserver("x", someUser);

    expect((await strategy.prepare!(["a"])).excludeObservers).toEqual(["x"]);
    expect(strategy.observerIds!()).toEqual(["x"]);
    await strategy.removeObserver("x");
    expect((await strategy.prepare!(["b"])).excludeObservers).toBeUndefined();
  });

  it("D: open bindings admit everyone", async () => {
    const strategy = openObservers();
    await expect(strategy.addObserver("x", someUser)).resolves.toBeUndefined();
    expect(strategy.prepare).toBeUndefined();
    expect(() => strategy.prepareWithheld()).toThrow(/shares every read/);
  });
});

describe("escapeObservationValue", () => {
  it("flattens each run of newlines to one space", () => {
    expect(escapeObservationValue("one\r\n\r\ntwo\n\nthree")).toBe("one two three");
  });

  it("escapes every Markdown control character", () => {
    const controls = "\\`*_{}[]()#+.!|>~-";
    expect(escapeObservationValue(controls)).toBe(
      [...controls].map(character => `\\${character}`).join(""),
    );
  });

  it("leaves plain prose unchanged", () => {
    expect(escapeObservationValue("A provider title")).toBe("A provider title");
  });

  it("returns an empty string unchanged", () => {
    expect(escapeObservationValue("")).toBe("");
  });
});

describe("ObservationGate", () => {
  const read = { title: "Read", description: "Read a row" };

  it("authorizes with the strategy's exclusions, then commits", async () => {
    const order: string[] = [];
    const authorizeObservation = vi.fn(async () => void order.push("authorize"));
    // `prepare` parks rather than resolving synchronously, so "authorize came second" is a real
    // observation. A prepare that resolves without yielding cannot catch an implementation that
    // authorizes first and awaits the check afterwards -- the ordering would look identical.
    const preparing = Promise.withResolvers<void>();
    const strategy: ObserverStrategy = {
      addObserver: async () => {},
      removeObserver: async () => {},
      prepareWithheld: () => ({ commit() {} }),
      prepare: async setIds => {
        order.push(`prepare:start:${setIds.join(",")}`);
        await preparing.promise;
        order.push("prepare:end");
        return {
          excludeObservers: ["limited"],
          commit: () => void order.push("commit"),
          discard: () => void order.push("discard"),
        };
      },
    };

    const authorizing = new ObservationGate(fakeQueue(authorizeObservation), strategy)
      .authorize(read, { kind: "sets", ids: ["p1"] });

    // `prepare` ran synchronously up to its await, and nothing else may have happened yet.
    expect(order).toEqual(["prepare:start:p1"]);
    expect(authorizeObservation).not.toHaveBeenCalled();

    preparing.resolve();
    await authorizing;

    expect(order).toEqual(["prepare:start:p1", "prepare:end", "authorize", "commit"]);
    expect(authorizeObservation).toHaveBeenCalledWith({ ...read, excludeObservers: ["limited"] });
  });

  it("releases the queue dup it was handed", () => {
    const dispose = vi.fn();
    const queue = { authorizeObservation: async () => {}, [Symbol.dispose]: dispose } as unknown as
      RpcStub<ApprovalQueue>;

    new ObservationGate(queue, openObservers())[Symbol.dispose]();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("shares its stub so a session staging actions needs no second dup", () => {
    const queue = { authorizeObservation: async () => {} } as unknown as RpcStub<ApprovalQueue>;
    const gate = new ObservationGate(queue, openObservers());

    // The same reference, not a dup: ownership (and release) stays with the gate. The type is
    // narrowed to actions only, so observations cannot skip the strategy's exclusions.
    expect(gate.actions).toBe(queue);
  });

  it("discards rather than commits when the overseer refuses, keeping its error", async () => {
    const commit = vi.fn();
    const discard = vi.fn();
    const strategy: ObserverStrategy = {
      addObserver: async () => {},
      removeObserver: async () => {},
      prepareWithheld: () => ({ commit() {} }),
      prepare: async () => ({ excludeObservers: ["limited"], commit, discard }),
    };
    const authorizeObservation = vi.fn(async () => { throw new Error("cannot hide observation"); });

    await expect(
      new ObservationGate(fakeQueue(authorizeObservation), strategy)
        .authorize(read, { kind: "sets", ids: ["p1"] }),
    ).rejects.toThrow("cannot hide observation");
    expect(commit).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledOnce();
  });

  it("passes the description through untouched for a strategy that tracks nothing", async () => {
    const authorizeObservation = vi.fn(async () => {});
    // The caller's own object, so a copy that added or dropped a field fails this.
    const description = { title: "Read", description: "Read a row" };

    await new ObservationGate(fakeQueue(authorizeObservation), openObservers())
      .authorize(description, { kind: "sets", ids: ["p1"] });

    expect(authorizeObservation).toHaveBeenCalledWith(description);
  });

  it("refuses a sets scope naming no set, which meant two opposite things in the corpus", async () => {
    const authorizeObservation = vi.fn(async () => {});
    const strategy = trackedSetObservers<V>({ kv: makeKv(), hasSetAccess: async () => [] });

    await expect(new ObservationGate(fakeQueue(authorizeObservation), strategy)
      .authorize(read, { kind: "sets", ids: [] })).rejects.toThrow(/at least one set id/);
    expect(authorizeObservation).not.toHaveBeenCalled();
  });

  it("asks the strategy nothing for a read the admission baseline covers", async () => {
    const authorizeObservation = vi.fn(async () => {});
    const hasSetAccess = vi.fn(async (_v: V, setIds: readonly string[]) => setIds.map(() => false));
    const strategy = trackedSetObservers<V>({ kv: makeKv(), hasSetAccess });
    await strategy.addObserver("x", someUser);

    await new ObservationGate(fakeQueue(authorizeObservation), strategy)
      .authorize(read, { kind: "baseline" });

    expect(authorizeObservation).toHaveBeenCalledWith(read);
    expect(hasSetAccess).not.toHaveBeenCalled();
  });

  it("withholds a read no set id describes from every admitted observer", async () => {
    const authorizeObservation = vi.fn(async () => {});
    const strategy = trackedSetObservers<V>({ kv: makeKv(), hasSetAccess: async () => [] });
    await strategy.addObserver("x", someUser);
    await strategy.addObserver("y", someUser);

    await new ObservationGate(fakeQueue(authorizeObservation), strategy)
      .authorize(read, { kind: "withholdFromObservers" });

    expect(authorizeObservation).toHaveBeenCalledWith({ ...read, excludeObservers: ["x", "y"] });
  });

  it("withholds from a candidate still being admitted, which it cannot see settle", async () => {
    // The gate reads the observer list, then awaits the overseer. An admission landing inside that
    // round trip sees a read it was promised nobody would.
    const authorizeObservation = vi.fn(async () => {});
    const gate = Promise.withResolvers<void>();
    let admissions = 0;
    const strategy = trackedSetObservers<V>({
      kv: makeKv(),
      verifyBaseline: async () => { if (++admissions === 2) await gate.promise; },
      hasSetAccess: async () => [],
    });
    await strategy.addObserver("settled", someUser);

    const joining = strategy.addObserver("late", someUser);
    await new ObservationGate(fakeQueue(authorizeObservation), strategy)
      .authorize(read, { kind: "withholdFromObservers" });

    expect(authorizeObservation)
      .toHaveBeenCalledWith({ ...read, excludeObservers: ["settled", "late"] });
    gate.resolve();
    await joining;
  });

  it("closes admission after a withheld read, which no later verification can clear", async () => {
    // The read registered no set, so nothing can establish a later candidate was entitled to it.
    const kv = makeKv();
    const strategy = trackedSetObservers<V>({ kv, hasSetAccess: async () => [] });

    await new ObservationGate(fakeQueue(), strategy)
      .authorize(read, { kind: "withholdFromObservers" });

    await expect(strategy.addObserver("late", someUser)).rejects.toThrow(OBSERVER_WITHHELD);
    // Durable, and it stages no attempt record a concurrent read would have to withhold from.
    expect(new ObserverTracker<V>({ kv, hasSetAccess: async () => [] }).observerIds()).toEqual([]);
  });

  it("reopens admission when the overseer refuses a withheld read", async () => {
    // The overseer refuses whenever an excluded observer is still a collaborator, so this is the
    // ordinary answer, not an outage. Nothing was disclosed, so nothing may be latched.
    const kv = makeKv();
    const strategy = trackedSetObservers<V>({ kv, hasSetAccess: async () => [] });
    const refusing = fakeQueue(vi.fn(async () => {
      throw new Error("a collaborator may not see this");
    }));

    await expect(new ObservationGate(refusing, strategy)
      .authorize(read, { kind: "withholdFromObservers" }))
      .rejects.toThrow("a collaborator may not see this");

    await expect(strategy.addObserver("late", someUser)).resolves.toBeUndefined();
  });

  it("fences admission while a withheld read is still awaiting the overseer", async () => {
    // The exclusion list went out before this candidate existed.
    const kv = makeKv();
    const strategy = trackedSetObservers<V>({ kv, hasSetAccess: async () => [] });
    const overseer = Promise.withResolvers<void>();

    const authorizing = new ObservationGate(fakeQueue(vi.fn(() => overseer.promise)), strategy)
      .authorize(read, { kind: "withholdFromObservers" });

    await expect(strategy.addObserver("late", someUser)).rejects.toThrow(OBSERVER_WITHHELD);
    overseer.resolve();
    await authorizing;
  });

  it("holds the fence for a second withheld read when the first is refused", async () => {
    const kv = makeKv();
    const strategy = trackedSetObservers<V>({ kv, hasSetAccess: async () => [] });
    const refusal = Promise.withResolvers<void>();
    const overseer = Promise.withResolvers<void>();

    const refused = new ObservationGate(fakeQueue(vi.fn(() => refusal.promise)), strategy)
      .authorize(read, { kind: "withholdFromObservers" });
    const surviving = new ObservationGate(fakeQueue(vi.fn(() => overseer.promise)), strategy)
      .authorize(read, { kind: "withholdFromObservers" });

    refusal.reject(new Error("a collaborator may not see this"));
    await expect(refused).rejects.toThrow("a collaborator may not see this");

    // The second read is still awaiting the overseer, so its fence must have survived the first.
    await expect(strategy.addObserver("late", someUser)).rejects.toThrow(OBSERVER_WITHHELD);
    overseer.resolve();
    await surviving;
  });

  it("keeps the fence when the latch write fails", async () => {
    // The read threw, but the overseer had already authorized -- and recorded -- the description,
    // so the marker is the only fence left between that record and a later admission.
    const kv = makeKv();
    const failing: ObserverKv = {
      ...kv,
      put: (key, value) => {
        if (key === "observer-withheld") throw new Error("storage unavailable");
        kv.put(key, value);
      },
    };
    const strategy = trackedSetObservers<V>({ kv: failing, hasSetAccess: async () => [] });

    await expect(new ObservationGate(fakeQueue(vi.fn(async () => {})), strategy)
      .authorize(read, { kind: "withholdFromObservers" })).rejects.toThrow("storage unavailable");

    await expect(strategy.addObserver("later", someUser)).rejects.toThrow(OBSERVER_WITHHELD);
  });

  it("fences admission durably before the overseer is asked", async () => {
    // The overseer records the description before its reply reaches us, so an activation dying
    // mid-authorize must leave admission closed for whatever isolate comes next.
    const kv = makeKv();
    const strategy = trackedSetObservers<V>({ kv, hasSetAccess: async () => [] });
    strategy.prepareWithheld();  // Never settled: the activation died awaiting the overseer.

    // A fresh tracker over another handle on the same storage: only a durable fence reaches it.
    const revived = trackedSetObservers<V>({ kv: { ...kv }, hasSetAccess: async () => [] });
    await expect(revived.addObserver("late", someUser)).rejects.toThrow(OBSERVER_WITHHELD);
  });

  it("takes no fence when enumerating observers fails", async () => {
    const kv = makeKv();
    let scan = true;
    const failing: ObserverKv = {
      ...kv,
      list: options => {
        if (scan) throw new Error("storage unavailable");
        return kv.list(options);
      },
    };
    const strategy = trackedSetObservers<V>({ kv: failing, hasSetAccess: async () => [] });

    await expect(new ObservationGate(fakeQueue(vi.fn(async () => {})), strategy)
      .authorize(read, { kind: "withholdFromObservers" })).rejects.toThrow("storage unavailable");

    scan = false;
    await expect(strategy.addObserver("later", someUser)).resolves.toBeUndefined();
  });

  it("refuses an owner-only read where the strategy shares every read", async () => {
    // B's premise is that an admitted observer can read everything read here, so a read declared
    // owner-only contradicts the strategy choice -- fail closed rather than silently disclose.
    const authorizeObservation = vi.fn(async () => {});
    const strategy = aclObservers({ hasAccess: async () => true });
    await strategy.addObserver("x", someUser);

    await expect(new ObservationGate(fakeQueue(authorizeObservation), strategy)
      .authorize(read, { kind: "withholdFromObservers" })).rejects.toThrow(/shares every read/);

    expect(authorizeObservation).not.toHaveBeenCalled();
  });

  it("leaves the caller's prohibitAllSharing alone, being a gadget-wide escalation", async () => {
    const authorizeObservation = vi.fn(async () => {});
    const strategy: ObserverStrategy = {
      addObserver: async () => {},
      removeObserver: async () => {},
      prepareWithheld: () => ({ commit() {} }),
      prepare: async () => ({ excludeObservers: ["limited"], commit() {}, discard() {} }),
    };

    await new ObservationGate(fakeQueue(authorizeObservation), strategy)
      .authorize({ ...read, prohibitAllSharing: true }, { kind: "sets", ids: ["p1"] });

    expect(authorizeObservation).toHaveBeenCalledWith({
      ...read,
      prohibitAllSharing: true,
      excludeObservers: ["limited"],
    });
  });
});
