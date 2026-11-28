// Branch identity (plans/forking-reality.md): the view a gatekeeper session is handed, and the
// index of pending actions by branch.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { collection, createTypedStorage } from "@gadgets/typed-storage";
import type { BranchView } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "./test-worker";
import {
  STAGING_KEY, makeOverseerStorage, type ActionRecord, type GatekeeperCaller,
} from "../src/storage-schema/overseer-storage.js";
import {
  migrateToBranchIndex, migrateToHeldStaging, migrateToRejectedOrphans,
  type OverseerMigrationHost,
} from "../src/storage-schema/overseer-migrations.js";
import { createWorkshopLogger } from "../src/observability.js";
import { makeMockStorage } from "./mock-storage.js";

const testEnv = env as Cloudflare.Env & {
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
};

// Each caller the kernel records, and the branch its actions join.
const CALLERS: [GatekeeperCaller, string | null][] = [
  [{from: "agent", chatId: 3}, "chat:3"],
  [{from: "gadget", chatId: 3, gadgetId: 9}, "chat:3"],
  [{from: "gadget", gadgetId: 9}, null],
  [{from: "hook", gadgetId: 9}, null],
  [{from: "user", chatId: 4}, "chat:4"],
  [{from: "user"}, null],
];

describe("a gatekeeper session's view", () => {
  it("is handed to startSession() with the queue, which reports the same", async () => {
    await runInDurableObject(testEnv.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
      for (let [caller, branch] of CALLERS) {
        let {queue, view} = await instance.impl.openGatekeeperSession(7, {
          startSession: (queue: {getBranch(): Promise<BranchView>}, view: BranchView) => ({queue, view}),
        } as never, caller) as unknown as {queue: {getBranch(): Promise<BranchView>}, view: BranchView};
        expect([view, await queue.getBranch()]).toEqual([{branch}, {branch}]);
      }
    });
  });
});

function pendingAction(id: number, caller: GatekeeperCaller, state: ActionRecord["state"] = "pending") {
  return {
    id, gatekeeperId: 7, caller, createdAt: new Date(0), state, type: "action", action: id,
    description: {title: `Action ${id}`, description: "", autoApprovable: false},
  } as ActionRecord;
}

const idsOn = (storage: ReturnType<typeof makeOverseerStorage>, key: string) =>
  [...storage.actions.pendingByBranch.get(key)].map(record => record.id);

describe("pendingByBranch", () => {
  it("lists each branch's pending actions, and staging's, in ID order", () => {
    let storage = makeOverseerStorage(makeMockStorage());
    CALLERS.forEach(([caller], i) => storage.actions.put(pendingAction(i + 1, caller)));
    storage.actions.put(pendingAction(7, {from: "agent", chatId: 3}, "approved"));

    expect(idsOn(storage, "chat:3")).toEqual([1, 2]);
    expect(idsOn(storage, "chat:4")).toEqual([5]);
    expect(idsOn(storage, STAGING_KEY)).toEqual([3, 4, 6]);

    // A decided action leaves the index.
    storage.actions.put(pendingAction(1, {from: "agent", chatId: 3}, "rejected"));
    expect(idsOn(storage, "chat:3")).toEqual([2]);
  });

  it("is backfilled by the version-8 migration", () => {
    let raw = makeMockStorage();
    // Records written before the index existed.
    let before = createTypedStorage(raw, {
      collections: {actions: collection<ActionRecord>()({primaryKey: "id"})},
    });
    CALLERS.forEach(([caller], i) => before.actions.put(pendingAction(i + 1, caller)));
    let storage = makeOverseerStorage(raw);
    storage.version.put(7);
    expect(idsOn(storage, "chat:3")).toEqual([]);

    migrateToBranchIndex({
      storage, ctx: {storage: raw}, logger: createWorkshopLogger("test.branch-index-migration"),
    } as OverseerMigrationHost);

    expect(storage.version.get()).toBe(8);
    expect(idsOn(storage, "chat:3")).toEqual([1, 2]);
    expect(idsOn(storage, STAGING_KEY)).toEqual([3, 4, 6]);
  });
});

describe("the orphan rejection migration", () => {
  it("rejects the pending actions of removed connections, and only those", () => {
    let raw = makeMockStorage();
    let storage = makeOverseerStorage(raw);
    storage.gatekeepers.put({id: 7, class: {} as never});
    storage.actions.put(pendingAction(1, {from: "user", chatId: 3}));
    storage.actions.put({...pendingAction(2, {from: "user"}), gatekeeperId: 8} as ActionRecord);
    storage.actions.put({...pendingAction(3, {from: "user", chatId: 3}), gatekeeperId: 8} as ActionRecord);
    storage.version.put(8);

    migrateToRejectedOrphans({
      storage, ctx: {storage: raw}, logger: createWorkshopLogger("test.orphan-rejection-migration"),
    } as OverseerMigrationHost);

    expect(storage.version.get()).toBe(9);
    expect([1, 2, 3].map(id => storage.actions.get(id)?.state))
        .toEqual(["pending", "rejected", "rejected"]);
    expect(idsOn(storage, "chat:3")).toEqual([1]);
  });
});

describe("the staging hold migration", () => {
  const migrate = (raw: ReturnType<typeof makeMockStorage>) => {
    let storage = makeOverseerStorage(raw);
    storage.version.put(9);
    migrateToHeldStaging({
      storage, ctx: {storage: raw}, logger: createWorkshopLogger("test.staging-hold-migration"),
    } as OverseerMigrationHost);
    expect(storage.version.get()).toBe(10);
    return storage;
  };

  it("marks the staged actions still pending, and only those", () => {
    let raw = makeMockStorage();
    let storage = makeOverseerStorage(raw);
    CALLERS.forEach(([caller], i) => storage.actions.put(pendingAction(i + 1, caller)));
    storage.actions.put(pendingAction(7, {from: "user"}, "approved"));
    storage.actions.put(pendingAction(8, {from: "hook", gadgetId: 9}, "rejected"));

    migrate(raw);

    let held = [...storage.actions.list()]
        .filter(record => record.type === "action" && record.heldForReview);
    expect(held.map(record => record.id)).toEqual([3, 4, 6]);
    expect(idsOn(storage, STAGING_KEY)).toEqual([3, 4, 6]);
  });

  it("leaves a workspace with nothing staged as it was", () => {
    let raw = makeMockStorage();
    let storage = makeOverseerStorage(raw);
    storage.actions.put(pendingAction(1, {from: "agent", chatId: 3}));
    storage.actions.put(pendingAction(2, {from: "user"}, "approved"));
    let before = [...storage.actions.list()];

    migrate(raw);

    expect([...storage.actions.list()]).toEqual(before);
  });

  it("puts every chat in Review, with changes pending or not", () => {
    let raw = makeMockStorage();
    let storage = makeOverseerStorage(raw);
    for (let id of [1, 2]) {
      storage.chatMeta.put({id, title: `Chat ${id}`, mode: "auto", started: new Date(0), lastActive: new Date(id)});
    }
    storage.actions.put(pendingAction(1, {from: "agent", chatId: 1}));

    migrate(raw);

    expect([1, 2].map(id => storage.chatMeta.get(id)?.mode)).toEqual(["review", "review"]);
  });
});
