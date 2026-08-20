import { describe, expect, it, vi } from "vitest";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import type { Overseer } from "@gadgets/workshop-shared/api";
import {
  HISTORY_PAGE_DEFAULT_LIMIT, HISTORY_PAGE_MAX_LIMIT, HISTORY_PAGE_SCAN_CAP,
  OverseerDurableObject, PENDING_SCAN_PAGE_SIZE,
} from "../src/overseer.js";
import type { ActionRecord } from "../src/overseer.js";
import { makeMockStorage } from "./mock-storage.js";

vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

function makeStorage() {
  return createTypedStorage(makeMockStorage(), {
    singletons: { nextActionId: 0 },
    collections: { actions: collection<ActionRecord>()({ primaryKey: "id" }) },
  });
}

type TestStorage = ReturnType<typeof makeStorage>;

// Puts a record and keeps nextActionId ahead of it, as the real allocator does.
function putAction(storage: TestStorage, id: number, opts: {
    state?: ActionRecord["state"], type?: ActionRecord["type"] } = {}) {
  let base = {
    id,
    gatekeeperId: 1,
    caller: { from: "agent", chatId: 1 } as const,
    resourceTitle: `Resource ${id}`,
    createdAt: new Date(1700000000000 + id),
    state: opts.state ?? "pending",
  };
  let description = { title: `Action ${id}`, description: "test" };
  let type = opts.type ?? "action";
  storage.actions.put(
      type === "action" ? { ...base, type, action: id, description: { ...description, implementsRevert: true } }
    : type === "observation" ? { ...base, type, description }
    : { ...base, type, description, enabled: true });
  if (id >= storage.nextActionId.get()) storage.nextActionId.put(id + 1);
}

function resolve(storage: TestStorage, id: number, state: "approved" | "rejected" = "approved") {
  let record = storage.actions.get(id)!;
  record.state = state;
  if (record.type === "action") record.appliedAt = new Date();
  storage.actions.put(record);
}

// Forges a client interface over the mock storage via open(), mirroring
// overseer-hooks.test.ts's makeTargetOverseer. `role` picks the returned interface class.
async function makeClient(storage: TestStorage, role: "build" | "use" = "build"): Promise<Overseer> {
  let ownerId = "owner-id";
  let userId = role === "build" ? ownerId : "viewer-id";
  let overseer = {
    open: OverseerDurableObject.prototype.open,
    impl: {
      ownerId,
      ensureAmbientCapsules: async () => {},
      markOutputsDirty: () => {},
      joinPresence: () => () => {},
      joinOutputsFanout: () => () => {},
      ensureObserver: async () => {},
      syncOutputsTo: async () => {},
      getSharingManager: async () => ({ getEffectiveRole: () => role }),
      ctx: { id: { toString: () => "workspace-id" } },
      users: {
        idFromString: (id: string) => id,
        get: () => ({
          whoami: async () => ({ id: "profile-id", name: "Test User" }),
          recordSharedGadgetOpen: async () => {},
        }),
      },
      storage: Object.assign(storage, {
        prohibitAllSharing: { get: () => false },
        title: { get: () => "Test Workspace" },
      }),
    },
  } satisfies Pick<OverseerDurableObject, "open"> & { impl: object };
  return overseer.open(userId, `${userId}-profile`, new NativeRpcStub<() => void>(() => {}));
}

describe("scanPendingActions", () => {
  it("returns an empty terminal page for an empty log", async () => {
    let client = await makeClient(makeStorage());

    expect(await client.scanPendingActions()).toEqual({ entries: [], throughId: 0 });
  });

  it("returns only pending records, of any type, ascending", async () => {
    let storage = makeStorage();
    putAction(storage, 0);                                          // pending action
    putAction(storage, 1, { state: "approved" });
    putAction(storage, 2, { type: "observation", state: "approved" });
    putAction(storage, 3, { type: "bindHook", state: "pending" });  // pending, non-action type
    putAction(storage, 4, { state: "rejected" });
    putAction(storage, 5);
    let client = await makeClient(storage);

    let page = await client.scanPendingActions();
    expect(page.entries.map(e => e.id)).toEqual([0, 3, 5]);
    expect(page.throughId).toBe(6);
    expect(page.nextCursor).toBeUndefined();
  });

  it("pages through a large log without gaps or duplicates", async () => {
    let storage = makeStorage();
    let expected: number[] = [];
    for (let id = 0; id < PENDING_SCAN_PAGE_SIZE * 2 + 40; id++) {
      let pending = id % 3 !== 0;
      putAction(storage, id, { state: pending ? "pending" : "approved" });
      if (pending) expected.push(id);
    }
    let client = await makeClient(storage);

    let ids: number[] = [];
    let pages = 0;
    let page = await client.scanPendingActions();
    let throughId = page.throughId;
    for (;;) {
      pages++;
      ids.push(...page.entries.map(e => e.id));
      if (page.nextCursor === undefined) break;
      page = await client.scanPendingActions({ cursor: page.nextCursor, throughId });
      expect(page.throughId).toBe(throughId);
    }

    expect(pages).toBe(3);
    expect(ids).toEqual(expected);
  });

  it("yields one trailing empty terminal page on an exact page boundary", async () => {
    let storage = makeStorage();
    for (let id = 0; id < PENDING_SCAN_PAGE_SIZE; id++) putAction(storage, id);
    let client = await makeClient(storage);

    let first = await client.scanPendingActions();
    expect(first.entries.length).toBe(PENDING_SCAN_PAGE_SIZE);
    expect(first.nextCursor).toBe(PENDING_SCAN_PAGE_SIZE - 1);

    let last = await client.scanPendingActions(
        { cursor: first.nextCursor, throughId: first.throughId });
    expect(last).toEqual({ entries: [], throughId: first.throughId });
  });

  it("excludes records created after the scan started", async () => {
    let storage = makeStorage();
    for (let id = 0; id < PENDING_SCAN_PAGE_SIZE + 1; id++) putAction(storage, id);
    let client = await makeClient(storage);

    let first = await client.scanPendingActions();
    putAction(storage, PENDING_SCAN_PAGE_SIZE + 1);  // arrives mid-scan
    let second = await client.scanPendingActions(
        { cursor: first.nextCursor, throughId: first.throughId });

    expect(second.entries.map(e => e.id)).toEqual([PENDING_SCAN_PAGE_SIZE]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("reports records resolved between pages at their read-time state", async () => {
    let storage = makeStorage();
    for (let id = 0; id < PENDING_SCAN_PAGE_SIZE + 2; id++) putAction(storage, id);
    let client = await makeClient(storage);

    let first = await client.scanPendingActions();
    resolve(storage, PENDING_SCAN_PAGE_SIZE);  // resolved before its page is read
    let second = await client.scanPendingActions(
        { cursor: first.nextCursor, throughId: first.throughId });

    expect(second.entries.map(e => e.id)).toEqual([PENDING_SCAN_PAGE_SIZE + 1]);
  });

  it.each([
    ["cursor without throughId", { cursor: 5 }],
    ["negative cursor", { cursor: -1, throughId: 3 }],
    ["non-integer throughId", { throughId: 1.5 }],
  ])("rejects %s", async (_name, options) => {
    let storage = makeStorage();
    putAction(storage, 0);
    let client = await makeClient(storage);

    await expect(client.scanPendingActions(options)).rejects.toThrow(TypeError);
  });

  it("rejects a throughId beyond nextActionId", async () => {
    let storage = makeStorage();
    putAction(storage, 0);
    let client = await makeClient(storage);

    await expect(client.scanPendingActions({ throughId: 2 })).rejects.toThrow("Invalid throughId");
  });
});

describe("listActions", () => {
  it("returns resolved records newest-first, excluding pending", async () => {
    let storage = makeStorage();
    putAction(storage, 0, { state: "approved" });
    putAction(storage, 1);  // pending
    putAction(storage, 2, { state: "rejected" });
    putAction(storage, 3, { type: "observation", state: "approved" });
    let client = await makeClient(storage);

    let page = await client.listActions();
    expect(page.entries.map(e => e.id)).toEqual([3, 2, 0]);
    expect(page.nextBeforeId).toBeUndefined();
  });

  it("filters by record type", async () => {
    let storage = makeStorage();
    putAction(storage, 0, { state: "approved" });
    putAction(storage, 1, { type: "observation", state: "approved" });
    putAction(storage, 2, { type: "bindHook", state: "approved" });
    let client = await makeClient(storage);

    let page = await client.listActions({ filter: "observation" });
    expect(page.entries.map(e => e.id)).toEqual([1]);
  });

  it("applies the default limit and reports more history", async () => {
    let storage = makeStorage();
    let total = HISTORY_PAGE_DEFAULT_LIMIT + 10;
    for (let id = 0; id < total; id++) putAction(storage, id, { state: "approved" });
    let client = await makeClient(storage);

    let first = await client.listActions();
    expect(first.entries.length).toBe(HISTORY_PAGE_DEFAULT_LIMIT);
    expect(first.nextBeforeId).toBe(total - HISTORY_PAGE_DEFAULT_LIMIT);

    let second = await client.listActions({ beforeId: first.nextBeforeId });
    expect(second.entries.length).toBe(10);
    expect(second.nextBeforeId).toBeUndefined();
  });

  it("clamps the limit to the hard max", async () => {
    let storage = makeStorage();
    for (let id = 0; id < HISTORY_PAGE_MAX_LIMIT + 20; id++) {
      putAction(storage, id, { state: "approved" });
    }
    let client = await makeClient(storage);

    let page = await client.listActions({ limit: 10000 });
    expect(page.entries.length).toBe(HISTORY_PAGE_MAX_LIMIT);
  });

  it("caps raw records scanned, returning a short page with a cursor", async () => {
    let storage = makeStorage();
    // Old resolved records buried under more than a scan-cap of pending ones.
    for (let id = 0; id < 10; id++) putAction(storage, id, { state: "approved" });
    for (let id = 10; id < 10 + HISTORY_PAGE_SCAN_CAP + 20; id++) putAction(storage, id);
    let client = await makeClient(storage);

    let first = await client.listActions();
    expect(first.entries).toEqual([]);
    expect(first.nextBeforeId).toBe(30);

    let second = await client.listActions({ beforeId: first.nextBeforeId });
    expect(second.entries.map(e => e.id)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(second.nextBeforeId).toBeUndefined();
  });

  it("pages without overlap or gaps", async () => {
    let storage = makeStorage();
    let expected: number[] = [];
    for (let id = 0; id < 130; id++) {
      let resolved = id % 4 !== 0;
      putAction(storage, id, { state: resolved ? "approved" : "pending" });
      if (resolved) expected.unshift(id);
    }
    let client = await makeClient(storage);

    let ids: number[] = [];
    let beforeId: number | undefined;
    do {
      let page = await client.listActions({ beforeId, limit: 25 });
      ids.push(...page.entries.map(e => e.id));
      beforeId = page.nextBeforeId;
    } while (beforeId !== undefined);

    expect(ids).toEqual(expected);
  });

  it("rejects an invalid beforeId", async () => {
    let client = await makeClient(makeStorage());

    await expect(client.listActions({ beforeId: -1 })).rejects.toThrow("Invalid beforeId");
  });
});

describe("UseOverseerInterface", () => {
  it("answers both paged reads with empty terminal pages", async () => {
    let storage = makeStorage();
    putAction(storage, 0);
    putAction(storage, 1, { state: "approved" });
    let client = await makeClient(storage, "use");

    expect(await client.scanPendingActions()).toEqual({ entries: [], throughId: 0 });
    expect(await client.listActions()).toEqual({ entries: [] });
  });
});
