import { describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type { ActionLogEntry, ActionsSubscriber } from "@gadgets/workshop-shared/api";
import {
  ACTION_HISTORY_PAGE_DEFAULT_LIMIT, ACTION_REPLAY_PAGE_SIZE,
} from "../src/overseer.js";
import { makeMockStorage } from "./mock-storage.js";
import {
  FIXTURE_EPOCH, makeActionStorage, makePreIndexActionStorage, openFakeOverseer, putAction,
} from "./fixtures.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

// Hand-rolled ActionsSubscriber stub. `events` interleaves entry ids with "ready", so tests can
// assert both content and ordering of the delivered stream.
function makeSubscriber(entry?: (record: ActionLogEntry) => Promise<void>) {
  let events: Array<number | "ready"> = [];
  let subscriber = {
    entry: entry ?? (async (record: ActionLogEntry) => { events.push(record.id); }),
    ready: async () => { events.push("ready"); },
    dup: () => subscriber,
    onRpcBroken: () => {},
    [Symbol.dispose]: () => {},
  };
  return { subscriber: subscriber as unknown as RpcStub<ActionsSubscriber>, events };
}

describe("subscribeToActions", () => {
  it("delivers no pre-existing records: ready fires immediately", async () => {
    // Live deltas only — the current pending set is queried via listActions({filter: "pending"}).
    let storage = makeActionStorage();
    putAction(storage, 0);                                          // pending action
    putAction(storage, 1, { state: "approved" });
    putAction(storage, 2, { type: "bindHook", state: "pending" });  // pending, non-action type
    let client = await openFakeOverseer(storage);
    let { subscriber, events } = makeSubscriber();

    using _sub = await client.subscribeToActions(subscriber);
    expect(events).toEqual(["ready"]);
  });

  it("delivers adds and resolutions live, in stream order", async () => {
    let storage = makeActionStorage();
    let client = await openFakeOverseer(storage);
    let { subscriber, events } = makeSubscriber();

    using _sub = await client.subscribeToActions(subscriber);
    putAction(storage, 0);
    let record = storage.actions.get(0)!;
    record.state = "approved";
    storage.actions.put(record);

    expect(events).toEqual(["ready", 0, 0]);  // the add, then the resolving update
  });

  it("replays every record, resolved included, for an epoch startAfter", async () => {
    let storage = makeActionStorage();
    putAction(storage, 0);
    putAction(storage, 1, { state: "approved" });
    putAction(storage, 2, { type: "observation", state: "rejected" });
    putAction(storage, 3, { type: "bindHook", state: "pending" });
    let client = await openFakeOverseer(storage);
    let { subscriber, events } = makeSubscriber();

    using _sub = await client.subscribeToActions(subscriber, new Date(0));
    expect(events).toEqual([0, 1, 2, 3, "ready"]);
  });

  it("replays only records whose last state change postdates startAfter", async () => {
    // putAction stamps createdAt = FIXTURE_EPOCH + id, so the cutoff falls mid-log.
    let storage = makeActionStorage();
    putAction(storage, 0);
    putAction(storage, 1, { state: "approved" });
    putAction(storage, 2, { state: "rejected" });
    putAction(storage, 3);
    let client = await openFakeOverseer(storage);
    let { subscriber, events } = makeSubscriber();

    using _sub = await client.subscribeToActions(subscriber, new Date(FIXTURE_EPOCH + 1));
    expect(events).toEqual([2, 3, "ready"]);
  });

  it("replays a record created before the cutoff but resolved after it", async () => {
    let storage = makeActionStorage();
    putAction(storage, 0, { state: "approved", appliedAt: new Date(FIXTURE_EPOCH + 500) });
    putAction(storage, 1, { state: "approved" });  // both created and resolved before the cutoff
    let client = await openFakeOverseer(storage);
    let { subscriber, events } = makeSubscriber();

    using _sub = await client.subscribeToActions(subscriber, new Date(FIXTURE_EPOCH + 100));
    expect(events).toEqual([0, "ready"]);
  });

  it("replays a hook toggled after the cutoff, carrying the toggled state", async () => {
    let storage = makeActionStorage();
    putAction(storage, 0, { type: "bindHook", state: "pending" });
    // The mock kv structuredClones every write, which a live controller stub wouldn't survive,
    // so serve disableHook()'s boundHooks reads from a hand-rolled view instead.
    let hook = {
      id: 7, actionId: 0, gatekeeperId: 1, enabled: true,
      controller: { disable: async () => {} },
    };
    let client = await openFakeOverseer({
      ...storage,
      boundHooks: {
        get: (id: number) => (id === hook.id ? hook : undefined),
        put: (record: typeof hook) => Object.assign(hook, record),
      },
    });
    await client.disableHook(hook.id);  // stamps appliedAt = now on the bindHook action record

    let entries: ActionLogEntry[] = [];
    let { subscriber } = makeSubscriber(async record => { entries.push(record); });
    // Cutoff after creation (fixture epoch) but before the toggle (wall clock).
    using _sub = await client.subscribeToActions(subscriber, new Date(FIXTURE_EPOCH + 100));
    expect(entries.map(e => e.id)).toEqual([0]);
    expect(entries[0]).toMatchObject({ type: "bindHook", enabled: false });
  });

  it("rejects the resume replay when the subscriber fails mid-sweep", async () => {
    let storage = makeActionStorage();
    // More than one page, so the failure must also stop the sweep from advancing.
    for (let id = 0; id <= ACTION_REPLAY_PAGE_SIZE; id++) putAction(storage, id);
    let client = await openFakeOverseer(storage);
    let entries = 0;
    let { subscriber, events } = makeSubscriber(async () => {
      ++entries;
      throw new Error("entry failed");
    });

    // Each page's delivery is awaited, so the rejection surfaces directly, before ready().
    await expect(client.subscribeToActions(subscriber, new Date(0)))
        .rejects.toThrow("entry failed");
    expect(events).not.toContain("ready");
    expect(entries).toBeLessThanOrEqual(ACTION_REPLAY_PAGE_SIZE);
  });

  it("stops delivering after the subscription is disposed", async () => {
    let storage = makeActionStorage();
    putAction(storage, 0);
    let client = await openFakeOverseer(storage);
    let { subscriber, events } = makeSubscriber();

    let sub = await client.subscribeToActions(subscriber);
    sub[Symbol.dispose]();
    await scheduler.wait(0);  // let the stub's disposer run
    putAction(storage, 1);

    expect(events).toEqual(["ready"]);
  });
});

describe("listActions", () => {
  it("returns records newest-first, pending included", async () => {
    let storage = makeActionStorage();
    putAction(storage, 0, { state: "approved" });
    putAction(storage, 1);  // pending
    putAction(storage, 2, { state: "rejected" });
    putAction(storage, 3, { type: "observation", state: "approved" });
    let client = await openFakeOverseer(storage);

    let page = await client.listActions();
    expect(page.entries.map(e => e.id)).toEqual([3, 2, 1, 0]);
    expect(page.nextBeforeId).toBeUndefined();
  });

  it("filters by record type, pending included", async () => {
    let storage = makeActionStorage();
    putAction(storage, 0, { state: "approved" });
    putAction(storage, 1, { type: "observation", state: "approved" });
    putAction(storage, 2, { type: "bindHook", state: "approved" });
    putAction(storage, 3, { type: "observation", state: "pending" });
    let client = await openFakeOverseer(storage);

    let page = await client.listActions({ filter: "observation" });
    expect(page.entries.map(e => e.id)).toEqual([3, 1]);
  });

  it("applies the default limit and reports more history", async () => {
    let storage = makeActionStorage();
    let total = ACTION_HISTORY_PAGE_DEFAULT_LIMIT + 10;
    for (let id = 0; id < total; id++) putAction(storage, id, { state: "approved" });
    let client = await openFakeOverseer(storage);

    let first = await client.listActions();
    expect(first.entries.length).toBe(ACTION_HISTORY_PAGE_DEFAULT_LIMIT);
    expect(first.nextBeforeId).toBe(total - ACTION_HISTORY_PAGE_DEFAULT_LIMIT);

    let second = await client.listActions({ beforeId: first.nextBeforeId });
    expect(second.entries.length).toBe(10);
    expect(second.nextBeforeId).toBeUndefined();
  });

  it("returns sparse matches in one full page, however much history buries them", async () => {
    let storage = makeActionStorage();
    // A few observations buried under far more history than the old design's per-call scan cap:
    // the index-backed read must surface them in ONE call, with no cursor dance.
    putAction(storage, 0, { type: "observation", state: "approved" });
    putAction(storage, 1, { type: "observation", state: "rejected" });
    for (let id = 2; id < 550; id++) putAction(storage, id, { state: "approved" });
    let client = await openFakeOverseer(storage);

    let page = await client.listActions({ filter: "observation" });
    expect(page.entries.map(e => e.id)).toEqual([1, 0]);
    expect(page.nextBeforeId).toBeUndefined();
  });

  it("pages without overlap or gaps", async () => {
    let storage = makeActionStorage();
    let expected: number[] = [];
    for (let id = 0; id < 130; id++) {
      // Pending records carry different index keys but the same "all" membership.
      putAction(storage, id, { state: id % 4 === 0 ? "pending" : "approved" });
      expected.unshift(id);
    }
    let client = await openFakeOverseer(storage);

    let ids: number[] = [];
    let beforeId: number | undefined;
    do {
      let page = await client.listActions({ beforeId });
      ids.push(...page.entries.map(e => e.id));
      beforeId = page.nextBeforeId;
    } while (beforeId !== undefined);

    expect(ids).toEqual(expected);
  });

  it("rejects an invalid beforeId", async () => {
    let client = await openFakeOverseer(makeActionStorage());

    await expect(client.listActions({ beforeId: -1 })).rejects.toThrow("Invalid beforeId");
  });
});

describe("listActions with the pending filter", () => {
  it("returns pendings of any type newest-first across gatekeepers, excluding resolved",
      async () => {
    let storage = makeActionStorage();
    putAction(storage, 0, { gatekeeperId: 2 });
    putAction(storage, 1, { state: "approved" });
    putAction(storage, 2, { type: "bindHook", state: "pending", gatekeeperId: 1 });
    putAction(storage, 3, { state: "rejected" });
    putAction(storage, 4, { gatekeeperId: 3 });
    let client = await openFakeOverseer(storage);

    // The index groups by gatekeeper; the page must still be one id-ordered (descending) stream.
    let page = await client.listActions({ filter: "pending" });
    expect(page.entries.map(e => e.id)).toEqual([4, 2, 0]);
    expect(page.nextBeforeId).toBeUndefined();
  });

  it("pages to exhaustion without overlap or gaps", async () => {
    let storage = makeActionStorage();
    let expected: number[] = [];
    for (let id = 0; id < ACTION_HISTORY_PAGE_DEFAULT_LIMIT * 2 + 30; id++) {
      let pending = id % 3 !== 0;
      putAction(storage, id, { state: pending ? "pending" : "approved", gatekeeperId: id % 4 });
      if (pending) expected.unshift(id);
    }
    let client = await openFakeOverseer(storage);

    let ids: number[] = [];
    let beforeId: number | undefined;
    do {
      let page = await client.listActions({ filter: "pending", beforeId });
      expect(page.entries.length).toBeLessThanOrEqual(ACTION_HISTORY_PAGE_DEFAULT_LIMIT);
      ids.push(...page.entries.map(e => e.id));
      beforeId = page.nextBeforeId;
    } while (beforeId !== undefined);

    expect(ids).toEqual(expected);
  });

  it("reflects a resolution between pages: the record stops appearing", async () => {
    let storage = makeActionStorage();
    let total = ACTION_HISTORY_PAGE_DEFAULT_LIMIT + 10;
    for (let id = 0; id < total; id++) putAction(storage, id);
    let client = await openFakeOverseer(storage);

    let first = await client.listActions({ filter: "pending" });
    expect(first.entries.length).toBe(ACTION_HISTORY_PAGE_DEFAULT_LIMIT);
    expect(first.nextBeforeId).toBe(10);

    // Resolve a record that would have been on the second page.
    let record = storage.actions.get(5)!;
    record.state = "approved";
    storage.actions.put(record);

    let second = await client.listActions({ filter: "pending", beforeId: first.nextBeforeId });
    expect(second.entries.map(e => e.id)).toEqual([9, 8, 7, 6, 4, 3, 2, 1, 0]);
    expect(second.nextBeforeId).toBeUndefined();
  });

  it("sees records written before the indexes existed once a rebuild backfills them", async () => {
    // Mirrors the version-3/4 migrations: records predate both index declarations, so each
    // starts empty until its migration's rebuild() runs.
    let mock = makeMockStorage();
    let legacy = makePreIndexActionStorage(mock);
    putAction(legacy, 0);
    putAction(legacy, 1, { state: "approved" });
    putAction(legacy, 2);
    putAction(legacy, 3, { type: "observation", state: "rejected" });

    let storage = makeActionStorage(mock);
    storage.actions.pendingByGatekeeper.rebuild();
    storage.actions.byHistoryFilter.rebuild();
    let client = await openFakeOverseer(storage);

    // Every filter serves the legacy records.
    expect((await client.listActions({ filter: "pending" })).entries.map(e => e.id))
        .toEqual([2, 0]);
    expect((await client.listActions()).entries.map(e => e.id)).toEqual([3, 2, 1, 0]);
    expect((await client.listActions({ filter: "action" })).entries.map(e => e.id))
        .toEqual([2, 1, 0]);
    expect((await client.listActions({ filter: "observation" })).entries.map(e => e.id))
        .toEqual([3]);

    // Resolving a backfilled record must not throw on either index's update.
    let record = storage.actions.get(2)!;
    record.state = "approved";
    storage.actions.put(record);
    expect((await client.listActions({ filter: "pending" })).entries.map(e => e.id)).toEqual([0]);
    expect((await client.listActions()).entries.map(e => e.id)).toEqual([3, 2, 1, 0]);
  });
});

describe("UseOverseerInterface", () => {
  it("answers listActions with an empty terminal page and the subscription inertly", async () => {
    let storage = makeActionStorage();
    putAction(storage, 0);
    putAction(storage, 1, { state: "approved" });
    let client = await openFakeOverseer(storage, { role: "use" });
    let { subscriber, events } = makeSubscriber();

    expect(await client.listActions()).toEqual({ entries: [] });
    expect(await client.listActions({ filter: "pending" })).toEqual({ entries: [] });

    using _sub = await client.subscribeToActions(subscriber);
    putAction(storage, 2);
    expect(events).toEqual(["ready"]);  // settled empty; nothing replayed or delivered
  });
});
