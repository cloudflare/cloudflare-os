import { describe, expect, it } from "vite-plus/test";
import {
  ContextObserverTracker, type ContextVerifierApi,
} from "../src/context-observers.js";

type TrackerKv = ConstructorParameters<typeof ContextObserverTracker>[0];

function makeKv(): TrackerKv {
  let map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, value),
    delete: (key: string) => void map.delete(key),
    list: <T>({ prefix }: { prefix: string }) =>
      [...map.entries()].filter(([key]) => key.startsWith(prefix)) as [string, T][],
  };
}

function verifier(allowed: string[]) {
  let calls: Array<{ sharingDomain: string; collectionId: string }> = [];
  let api = {
    async hasCollectionAccess(sharingDomain: string, collectionId: string) {
      calls.push({ sharingDomain, collectionId });
      return allowed.includes(collectionId);
    },
  } as unknown as Fetcher<ContextVerifierApi>;
  return { api, calls };
}

async function observe(tracker: ContextObserverTracker, collectionIds: string[]) {
  let check = await tracker.prepareObservation(collectionIds);
  check.commit();
  return check.excludeObservers;
}

describe("ContextObserverTracker", () => {
  it("checks every past collection before storing an observer", async () => {
    let tracker = new ContextObserverTracker(makeKv(), "workshop.example");
    await observe(tracker, ["public", "private"]);
    let denied = verifier(["private"]);

    await expect(tracker.addObserver("observer", denied.api)).rejects.toThrow(
      /does not have access to a Context collection/,
    );
    expect(denied.calls).toEqual([
      { sharingDomain: "workshop.example", collectionId: "public" },
      { sharingDomain: "workshop.example", collectionId: "private" },
    ]);

    await observe(tracker, ["later"]);
    expect(denied.calls).toHaveLength(2);
  });

  it("excludes observers from new collections and removes them idempotently", async () => {
    let tracker = new ContextObserverTracker(makeKv(), "workshop.example");
    let allowed = verifier(["first", "second", "third"]);
    let limited = verifier(["first"]);
    await tracker.addObserver("allowed", allowed.api);
    await tracker.addObserver("limited", limited.api);

    expect(await observe(tracker, ["first"])).toBeUndefined();
    expect(await observe(tracker, ["second", "second"])).toEqual(["limited"]);
    expect(await observe(tracker, ["second"])).toBeUndefined();

    tracker.removeObserver("limited");
    tracker.removeObserver("limited");
    expect(await observe(tracker, ["third"])).toBeUndefined();
    expect(limited.calls.map(call => call.collectionId)).toEqual(["first", "second"]);
  });

  it("keeps blocked collections pending and rechecks them on retry", async () => {
    let kv = makeKv();
    let tracker = new ContextObserverTracker(kv, "workshop.example");
    let limited = verifier([]);
    await tracker.addObserver("limited", limited.api);

    let first = await tracker.prepareObservation(["private"]);
    expect(first.excludeObservers).toEqual(["limited"]);
    expect(kv.get("observedCollection:private")).toBe("pending");

    let retry = await tracker.prepareObservation(["private"]);
    expect(retry.excludeObservers).toEqual(["limited"]);
    tracker.removeObserver("limited");
    let allowedRetry = await tracker.prepareObservation(["private"]);
    expect(allowedRetry.excludeObservers).toBeUndefined();
    allowedRetry.commit();
    expect(kv.get("observedCollection:private")).toBe("observed");
    expect(limited.calls.map(call => call.collectionId)).toEqual(["private", "private"]);
  });

  it("checks pending collections when admitting a concurrent observer", async () => {
    let kv = makeKv();
    let tracker = new ContextObserverTracker(kv, "workshop.example");
    let release!: () => void;
    let waiting = new Promise<void>(resolve => { release = resolve; });
    let current = {
      async hasCollectionAccess() { await waiting; return true; },
    } as unknown as Fetcher<ContextVerifierApi>;
    await tracker.addObserver("current", current);

    let preparing = tracker.prepareObservation(["new"]);
    expect(kv.get("observedCollection:new")).toBe("pending");
    let denied = verifier([]);
    await expect(tracker.addObserver("new", denied.api)).rejects.toThrow(/does not have access/);
    release();
    (await preparing).commit();
    expect(denied.calls.map(call => call.collectionId)).toEqual(["new"]);
  });

  it("rechecks collections added while observer admission is awaiting", async () => {
    let tracker = new ContextObserverTracker(makeKv(), "workshop.example");
    await observe(tracker, ["old"]);
    let release!: () => void;
    let waiting = new Promise<void>(resolve => { release = resolve; });
    let calls: string[] = [];
    let candidate = {
      async hasCollectionAccess(_domain: string, collectionId: string) {
        calls.push(collectionId);
        if (collectionId === "old") await waiting;
        return collectionId === "old";
      },
    } as unknown as Fetcher<ContextVerifierApi>;

    let admission = tracker.addObserver("candidate", candidate);
    await tracker.prepareObservation(["new"]);
    release();
    await expect(admission).rejects.toThrow(/does not have access/);
    expect(calls).toEqual(["old", "new"]);
  });

  it("handles concurrent mixed collection attempts and legacy markers", async () => {
    let kv = makeKv();
    kv.put("observedCollection:legacy", true);
    let tracker = new ContextObserverTracker(kv, "workshop.example");
    let limited = verifier(["legacy"]);
    await tracker.addObserver("limited", limited.api);

    let first = tracker.prepareObservation(["pending"]);
    let concurrent = tracker.prepareObservation(["pending"]);
    expect((await first).excludeObservers).toEqual(["limited"]);
    expect((await concurrent).excludeObservers).toEqual(["limited"]);

    let mixed = await tracker.prepareObservation(["legacy", "pending", "new", "new"]);
    expect(mixed.pendingCollections).toEqual(["pending", "new"]);
    expect(mixed.excludeObservers).toEqual(["limited"]);
    mixed.commit();
    expect((await tracker.prepareObservation(["legacy", "pending", "new"]))
      .pendingCollections).toEqual([]);
  });
});
