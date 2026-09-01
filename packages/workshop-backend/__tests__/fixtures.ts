// Shared fixtures for the action-log test suites: the production overseer storage over a mock,
// a putAction record factory, and a fake overseer client forged over
// OverseerDurableObject.prototype.open.

import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import type { Collection, Singleton } from "@gadgets/typed-storage";
import type { Overseer } from "@gadgets/workshop-shared/api";
import { OverseerDurableObject, makeOverseerStorage } from "../src/overseer.js";
import type { ActionRecord } from "../src/overseer.js";
import { makeMockStorage } from "./mock-storage.js";

/**
 * The production schema over mock storage, so the action suites (auto-approval drain, pending
 * history query) exercise the shipped actions collection and pendingByGatekeeper index rather
 * than a copy.
 */
export function makeActionStorage(mockStorage = makeMockStorage()) {
  return makeOverseerStorage(mockStorage);
}

export type ActionTestStorage = ReturnType<typeof makeActionStorage>;

/**
 * Storage over the same records but without the index declared, for simulating a workspace
 * written before the index existed (see the migration-backfill tests).
 */
export function makePreIndexActionStorage(mockStorage: DurableObjectStorage) {
  return createTypedStorage(mockStorage, {
    singletons: { nextActionId: 0 },
    collections: { actions: collection<ActionRecord>()({ primaryKey: "id" }) },
  });
}

/** Base timestamp for fixture records: putAction stamps createdAt = FIXTURE_EPOCH + id. */
export const FIXTURE_EPOCH = 1700000000000;

/** Puts a record and keeps nextActionId ahead of it, as the real allocator does. */
export function putAction(
    storage: { actions: Collection<ActionRecord, number>, nextActionId: Singleton<number> },
    id: number,
    opts: { state?: ActionRecord["state"], type?: ActionRecord["type"], gatekeeperId?: number,
            actionTag?: string, autoApprovable?: boolean, createdAt?: Date,
            appliedAt?: Date } = {}) {
  let base = {
    id,
    gatekeeperId: opts.gatekeeperId ?? 1,
    caller: { from: "agent", chatId: 1 } as const,
    resourceTitle: `Resource ${id}`,
    createdAt: opts.createdAt ?? new Date(FIXTURE_EPOCH + id),
    ...(opts.appliedAt !== undefined ? { appliedAt: opts.appliedAt } : {}),
    state: opts.state ?? "pending",
  };
  let description = { title: `Action ${id}`, description: `Action ${id} description` };
  let type = opts.type ?? "action";
  storage.actions.put(
      type === "action" ? { ...base, type, action: id, description: {
        ...description,
        implementsRevert: true,
        actionKind: { tag: opts.actionTag ?? "edit", label: "Edits" },
        autoApprovable: opts.autoApprovable ?? true,
      } }
    : type === "observation" ? { ...base, type, description }
    : { ...base, type, description, enabled: true });
  if (id >= storage.nextActionId.get()) storage.nextActionId.put(id + 1);
}

/**
 * Forges a client interface over the given storage via open(). `role` picks the returned
 * interface class ("build" opens as the owner); `exports` supplies any ctx.exports entries the
 * exercised paths dereference; `impl` overrides individual members of the forged impl (e.g. to
 * delegate one method to a real OverseerImpl under test).
 */
export async function openFakeOverseer(
    storage: object,
    opts: { role?: "build" | "use", exports?: object, impl?: object } = {}): Promise<Overseer> {
  let role = opts.role ?? "build";
  let ownerId = "owner-id";
  let userId = role === "build" ? ownerId : "viewer-id";
  let overseer = {
    open: OverseerDurableObject.prototype.open,
    impl: {
      ownerId,
      assertGatekeeperUsable: () => {},
      ensureAmbientCapsules: async () => {},
      markOutputsDirty: () => {},
      joinSession: () => () => {},
      joinPresence: () => () => {},
      joinOutputsFanout: () => () => {},
      ensureObserver: async () => {},
      syncOutputsTo: async () => {},
      // What open() consults for a non-owner's role: the permission-graph lookup and observer
      // verification in one. The sharing manager is still reached, but only to redeem a share key,
      // which these tests never pass.
      authorizeCollaborator: async () => role,
      getSharingManager: async () => ({}),
      ctx: { id: { toString: () => "workspace-id" }, exports: opts.exports ?? {} },
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
      ...opts.impl,
    },
  } satisfies Pick<OverseerDurableObject, "open"> & { impl: object };
  return overseer.open(userId, `${userId}-profile`, new NativeRpcStub<() => void>(() => {}));
}
