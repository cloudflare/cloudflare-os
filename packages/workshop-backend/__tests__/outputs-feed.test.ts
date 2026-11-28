// The output index in the User DO, served through subscribeToOutputs(): a snapshot, then each
// workspace's outputs as its Overseer pushes them or the user's listing changes. Runs against real
// Overseer and User DOs.

import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { expect, it, vi } from "vitest";
import type { CollaboratorRole, OutputSummary, OutputsSubscriber } from "@gadgets/workshop-shared/api";
import { UserDurableObject } from "../src/user.js";
import { OverseerDurableObject } from "../src/overseer.js";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations.js";
import type { WorkspaceListing } from "../src/workspace-listing.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type Impl = OverseerDurableObject["impl"];
const withImpl = <T>(stub: DurableObjectStub<OverseerDurableObject>, fn: (impl: Impl) => Promise<T> | T) =>
  runInDurableObject(env.TEST_OVERSEER.get(stub.id), instance => fn(instance.impl));

const newUser = async (name: string) => {
  const id = `${name}-${crypto.randomUUID()}`;
  const user = env.TEST_USER.getByName(id);
  await runInDurableObject(user, (_instance, ctx) => {
    let storage = makeUserStorage(ctx.storage);
    storage.profile.put({type: "user", id, name});
    // Nothing predates the index here.
    storage.outputsBackfilled.put(true);
  });
  return user;
};

// An owner with one workspace whose Overseer pushes to them.
const setup = async () => {
  const user = await newUser("Owner");
  const workspace = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const workspaceId = workspace.id.toString();
  await user.newWorkspace(workspaceId, "Workspace");
  await user.setWorkspaceLastActive(workspaceId, new Date(), undefined);
  await withImpl(workspace, impl => {
    impl.storage.version.put(OVERSEER_STORAGE_VERSION);
    impl.storage.ownerId.put(user.id.toString());
    impl.ownerId = user.id.toString();
  });
  return {user, workspace, workspaceId};
};

const putGadget = (impl: Impl, id: number, title: string) =>
  impl.storage.gadgets.put({type: "gadget", id, title, created: new Date(0), bindingName: `G${id}`, bindings: {}});

class OutputUpdates extends RpcTarget implements OutputsSubscriber {
  readonly snapshots: [OutputSummary[], boolean][] = [];
  readonly updates: [string, OutputSummary[]][] = [];
  async snapshot(outputs: OutputSummary[], catchingUp: boolean) { this.snapshots.push([outputs, catchingUp]); }
  async updated(workspaceId: string, outputs: OutputSummary[]) { this.updates.push([workspaceId, outputs]); }
}

it("pushes an output added or renamed in a workspace to a subscribed user", async () => {
  const {user, workspace, workspaceId} = await setup();
  const updates = new OutputUpdates();
  using callback = new RpcStub(updates);
  using _subscription = await user.subscribeToOutputs(callback);
  await vi.waitFor(() => expect(updates.snapshots).toEqual([[[], false]]));

  await withImpl(workspace, impl => putGadget(impl, 10, "Dashboard"));
  await vi.waitFor(() => expect(updates.updates.at(-1)).toMatchObject([workspaceId, [{workpieceId: 10, title: "Dashboard"}]]));

  await withImpl(workspace, impl => putGadget(impl, 10, "Report"));
  await vi.waitFor(() => expect(updates.updates.at(-1)).toMatchObject([workspaceId, [{workpieceId: 10, title: "Report"}]]));

  const before = updates.updates.length;
  await user.updatePinned(workspaceId, true);
  await user.setWorkspaceNotificationMute(workspaceId, {indefinite: true});

  // The workspace renamed in the user's list: its outputs carry the new title.
  await user.syncWorkspaceListing(workspaceId, {listingRev: Number.MAX_SAFE_INTEGER, title: "Renamed"});
  await vi.waitFor(() => expect(updates.updates.at(-1)).toMatchObject([workspaceId, [{workspaceTitle: "Renamed"}]]));
  expect(updates.updates.slice(before)).toEqual([[workspaceId, [expect.objectContaining({workspaceTitle: "Renamed"})]]]);
});

it("drops a shared workspace's outputs when access is revoked", async () => {
  const {user: owner, workspaceId} = await setup();
  const reader = await newUser("Reader");
  const outputs = [{workpieceId: 10, title: "Dashboard", created: new Date(0)}];
  // Not listed until first opened.
  await reader.syncWorkspaceListing(workspaceId, {listingRev: 1, outputs});
  expect((await reader.listOutputs()).outputs).toEqual([]);
  await reader.recordSharedWorkspaceOpen(workspaceId, "Workspace", await owner.whoami(), "build", []);
  await reader.setWorkspaceLastActive(workspaceId, new Date(), undefined);
  await reader.syncWorkspaceListing(workspaceId, {listingRev: 1, outputs});

  const updates = new OutputUpdates();
  using callback = new RpcStub(updates);
  using _subscription = await reader.subscribeToOutputs(callback);
  await vi.waitFor(() => expect(updates.snapshots).toMatchObject([[[{workspaceId, workpieceId: 10}], false]]));

  await reader.forgetSharedWorkspace(workspaceId);
  await vi.waitFor(() => expect(updates.updates.at(-1)).toEqual([workspaceId, []]));
});

it("retries from the alarm a push that failed, though the next change leaves the outputs as that push had them", async () => {
  const {user, workspace} = await setup();
  await withImpl(workspace, impl => putGadget(impl, 10, "Dashboard"));
  await vi.waitFor(async () => expect(await listed(user)).toEqual([10]));

  await withImpl(workspace, async impl => {
    const users = impl.users;
    const attempted = Promise.withResolvers<void>();
    replaceUser(impl, user.id.toString(), () => ({
      syncWorkspaceListing: async () => {
        attempted.resolve();
        throw new Error("User DO handoff timed out.");
      },
    }));
    impl.storage.gadgets.delete(10);
    await attempted.promise;
    impl.users = users;
    // Provisional to a chat, so no output.
    impl.storage.gadgets.put({type: "gadget", id: 11, title: "Draft", created: new Date(0), bindingName: "G11",
      bindings: {}, pending: {chatId: 1}});
    await impl.deliverUserUpdates();
  });
  expect(await runDurableObjectAlarm(workspace)).toBe(true);
  await vi.waitFor(async () => expect(await listed(user)).toEqual([]));
});

it("sends again a value its recipient took from a push that timed out", async () => {
  const {user, workspace} = await setup();
  await withImpl(workspace, impl => putGadget(impl, 10, "Dashboard"));
  await vi.waitFor(async () => expect(await listed(user)).toEqual([10]));

  await withImpl(workspace, async impl => {
    const users = impl.users;
    const applied = Promise.withResolvers<void>();
    // The push of gadget 12 lands, but its sender gives up on it.
    replaceUser(impl, user.id.toString(), owner => ({
      syncWorkspaceListing: async (workspaceId: string, listing: WorkspaceListing) => {
        await owner.syncWorkspaceListing(workspaceId, listing);
        applied.resolve();
        throw new Error("User DO handoff timed out.");
      },
    }));
    putGadget(impl, 12, "Report");
    await applied.promise;
    await impl.deliverUserUpdates();
    impl.users = users;
    // Back to the outputs last acknowledged.
    impl.storage.gadgets.delete(12);
    await impl.deliverUserUpdates();
  });
  expect(await runDurableObjectAlarm(workspace)).toBe(true);
  await vi.waitFor(async () => expect(await listed(user)).toEqual([10]));
});

it("delivers a change whose delivery a restart interrupted once the workspace wakes", async () => {
  const {user, workspace} = await setup();
  await withImpl(workspace, async impl => {
    // The owner's User DO never takes the listing while this instance lasts.
    const unanswered = Promise.withResolvers<void>().promise;
    replaceUser(impl, user.id.toString(), owner => new Proxy(owner, {get: (target, key) =>
      key === "syncWorkspaceListing" ? () => unanswered : Reflect.get(target, key)}));
    putGadget(impl, 10, "Dashboard");
    await impl.ctx.storage.sync();
  });
  await expect(runInDurableObject(workspace, (_instance, ctx) => ctx.abort("Reset before delivery")))
    .rejects.toThrow("Reset before delivery");
  expect(await listed(user)).toEqual([]);
  // (The aborted stub is broken; a new one reaches the next instance.)
  expect(await runDurableObjectAlarm(env.TEST_OVERSEER.get(workspace.id))).toBe(true);
  expect(await listed(user)).toEqual([10]);
});

// A collaborator the owner gave `gadgetIds` of the workspace's gadgets 10 and 11 to use.
const shareGadgets = async ({user, workspace}: {user: DurableObjectStub<UserDurableObject>,
    workspace: DurableObjectStub<OverseerDurableObject>}, gadgetIds: number[]) => {
  const reader = await newUser("Reader");
  const profile = await reader.whoami();
  const sharer = (await user.whoami()).id;
  await withImpl(workspace, impl => {
    putGadget(impl, 10, "Dashboard");
    putGadget(impl, 11, "Report");
    impl.storage.collaborators.put({profile, addedBy: gadgetIds.map(gadgetId =>
      ({type: "user", sharer, role: "use", gadgetId, created: new Date(0)}))});
  });
  return {reader, profile, readerId: reader.id.toString(), sharer};
};

// The gadgets of the user's outputs index.
const listed = async (user: DurableObjectStub<UserDurableObject>) =>
  (await user.listOutputs()).outputs.map(output => output.workpieceId).toSorted();

// The Overseer's User DOs, with the collaborator's replaced by `stub`, which is given theirs.
const replaceUser = (impl: Impl, userId: string,
    stub: (user: DurableObjectStub<UserDurableObject>) => object) => {
  const users = impl.users;
  impl.users = {
    idFromName: (name: string) => users.idFromName(name),
    idFromString: (id: string) => users.idFromString(id),
    get: (id: DurableObjectId) => id.toString() === userId ? stub(users.get(id)) : users.get(id),
  } as unknown as Impl["users"];
};

it("lists what a collaborator may use once they open the workspace, even if they leave at once", async () => {
  const fixture = await setup();
  const {reader, profile, readerId} = await shareGadgets(fixture, [10]);
  // Left before the listing the open starts is recorded, which ends the session's fan-out.
  await runInDurableObject(env.TEST_OVERSEER.get(fixture.workspace.id), async (instance: OverseerDurableObject) => {
    // No account provides anything here, and this environment has no deployment settings to say.
    instance["impl"].ensureAmbientCapsules = async () => {};
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using _session = await instance.open(readerId, profile.id, notifyClosed);
  });
  await vi.waitFor(async () => expect(await listed(reader)).toEqual([10]));
});

it("narrows a collaborator's outputs to the gadgets they keep, which no push from before undoes", async () => {
  const fixture = await setup();
  const {reader, profile, readerId, sharer} = await shareGadgets(fixture, [10, 11]);
  await reader.recordSharedWorkspaceOpen(fixture.workspaceId, "Workspace", await fixture.user.whoami(), "use", []);
  // A push of both while they use them, which lands only after the narrowing.
  let slow: WorkspaceListing | undefined;
  await withImpl(fixture.workspace, impl => {
    replaceUser(impl, readerId, user => ({
      syncWorkspaceListing: async (workspaceId: string, listing: WorkspaceListing) => {
        if (!slow && listing.outputs) slow = listing;
        else await user.syncWorkspaceListing(workspaceId, listing);
      },
      updateSharedWorkspaceRole: (workspaceId: string, role: CollaboratorRole) =>
        user.updateSharedWorkspaceRole(workspaceId, role),
    }));
    impl.joinOutputsFanout(readerId);
    impl.resyncListingTo(readerId, profile.id);
  });
  await vi.waitFor(() => expect(slow?.outputs?.map(output => output.workpieceId)).toEqual([10, 11]));

  await withImpl(fixture.workspace, async impl => {
    const sharing = await impl.getSharingManager();
    await impl.refreshAffectedCollaboratorListings(
      sharing.removeCollaborator({profileId: sharer, isOwner: true}, profile.id, [], 11));
  });
  await vi.waitFor(async () => expect(await listed(reader)).toEqual([10]));
  await reader.syncWorkspaceListing(fixture.workspaceId, slow!);
  expect(await listed(reader)).toEqual([10]);
});

it("narrows the outputs of a collaborator it could not reach once the workspace restarts", async () => {
  const fixture = await setup();
  const {reader, profile, readerId, sharer} = await shareGadgets(fixture, [10, 11]);
  await reader.recordSharedWorkspaceOpen(fixture.workspaceId, "Workspace", await fixture.user.whoami(), "use", []);
  await reader.syncWorkspaceListing(fixture.workspaceId, {listingRev: 1, outputs: [
    {workpieceId: 10, title: "Dashboard", created: new Date(0)},
    {workpieceId: 11, title: "Report", created: new Date(0)},
  ]});

  await withImpl(fixture.workspace, async impl => {
    // Their role is updated, but their outputs cannot be, while this instance lasts.
    replaceUser(impl, readerId, user => ({
      syncWorkspaceListing: async () => { throw new Error("User DO handoff timed out."); },
      updateSharedWorkspaceRole: (workspaceId: string, role: CollaboratorRole) =>
        user.updateSharedWorkspaceRole(workspaceId, role),
    }));
    const sharing = await impl.getSharingManager();
    await impl.refreshAffectedCollaboratorListings(
      sharing.removeCollaborator({profileId: sharer, isOwner: true}, profile.id, [], 11));
  });
  expect(await listed(reader)).toEqual([10, 11]);

  await evictDurableObject(fixture.workspace);
  expect(await runDurableObjectAlarm(fixture.workspace)).toBe(true);
  expect(await listed(reader)).toEqual([10]);
});

it("never undoes a change made while a narrowing was in flight, even when the narrowing's push lands last", async () => {
  const fixture = await setup();
  const {reader, profile, readerId, sharer} = await shareGadgets(fixture, [10, 11]);
  await reader.recordSharedWorkspaceOpen(fixture.workspaceId, "Workspace", await fixture.user.whoami(), "use", []);
  await reader.syncWorkspaceListing(fixture.workspaceId, {listingRev: 1, outputs: [
    {workpieceId: 10, title: "Dashboard", created: new Date(0)},
    {workpieceId: 11, title: "Report", created: new Date(0)},
  ]});
  const titles = async () => (await reader.listOutputs()).outputs.map(output => [output.workpieceId, output.title]);

  // The narrowing's outputs, read before gadget 10 is renamed, time out and land after the rename.
  let late: WorkspaceListing | undefined;
  await withImpl(fixture.workspace, async impl => {
    const roleSent = Promise.withResolvers<void>(), renamed = Promise.withResolvers<void>();
    replaceUser(impl, readerId, user => ({
      updateSharedWorkspaceRole: async (workspaceId: string, role: CollaboratorRole) => {
        await user.updateSharedWorkspaceRole(workspaceId, role);
        roleSent.resolve();
        await renamed.promise;
      },
      syncWorkspaceListing: async (workspaceId: string, listing: WorkspaceListing) => {
        if (late || !listing.outputs?.some(output => output.title === "Dashboard")) {
          return user.syncWorkspaceListing(workspaceId, listing);
        }
        late = listing;
        throw new Error("User DO handoff timed out.");
      },
    }));
    impl.joinOutputsFanout(readerId);
    const sharing = await impl.getSharingManager();
    const refresh = impl.refreshAffectedCollaboratorListings(
      sharing.removeCollaborator({profileId: sharer, isOwner: true}, profile.id, [], 11));
    await roleSent.promise;
    putGadget(impl, 10, "Board");
    renamed.resolve();
    await refresh;
    // The narrowing's push failed, so the alarm sends what it was owed again.
    await impl.runAlarmTasks();
  });
  expect(late?.outputs?.map(output => [output.workpieceId, output.title])).toEqual([[10, "Dashboard"]]);
  await vi.waitFor(async () => expect(await titles()).toEqual([[10, "Board"]]));
  await reader.syncWorkspaceListing(fixture.workspaceId, late!);
  expect(await titles()).toEqual([[10, "Board"]]);
});

it("takes no push from before a collaborator's removal once they are re-admitted with less", async () => {
  const fixture = await setup();
  const {reader, profile, readerId, sharer} = await shareGadgets(fixture, [10, 11]);
  await reader.recordSharedWorkspaceOpen(fixture.workspaceId, "Workspace", await fixture.user.whoami(), "use", []);
  // A push of both while they use them, delayed until just after the open that re-admits them.
  let delayed: WorkspaceListing | undefined;
  let readmitted: number[] | undefined;
  await withImpl(fixture.workspace, async impl => {
    replaceUser(impl, readerId, user => new Proxy(user, {get: (target, key) => {
      if (key === "syncWorkspaceListing") {
        return async (workspaceId: string, listing: WorkspaceListing) => {
          if (delayed || !listing.outputs) return target.syncWorkspaceListing(workspaceId, listing);
          delayed = listing;
        };
      }
      if (key === "recordSharedWorkspaceOpen") {
        return async (...args: Parameters<UserDurableObject["recordSharedWorkspaceOpen"]>) => {
          await target.recordSharedWorkspaceOpen(...args);
          await target.syncWorkspaceListing(fixture.workspaceId, delayed!);
          readmitted = await listed(target);
        };
      }
      return Reflect.get(target, key);
    }}));
    impl.resyncListingTo(readerId, profile.id);
    await vi.waitFor(() => expect(delayed?.outputs?.map(output => output.workpieceId)).toEqual([10, 11]));

    const sharing = await impl.getSharingManager();
    await impl.refreshAffectedCollaboratorListings(
      sharing.removeCollaborator({profileId: sharer, isOwner: true}, profile.id, []));
    impl.storage.collaborators.put({profile, addedBy: [{type: "user", sharer, role: "use", gadgetId: 10, created: new Date(0)}]});
  });
  expect(await reader.getWorkspace(fixture.workspaceId)).toBeNull();

  await runInDurableObject(env.TEST_OVERSEER.get(fixture.workspace.id), async (instance: OverseerDurableObject) => {
    instance["impl"].ensureAmbientCapsules = async () => {};
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using _session = await instance.open(readerId, profile.id, notifyClosed);
  });
  await vi.waitFor(async () => expect(await listed(reader)).toEqual([10]));
  expect(readmitted).toEqual([]);
});

it("never restores an output removed while the backfill was reading", async () => {
  const {user, workspaceId} = await setup();
  await runInDurableObject(user, (_instance, ctx) => makeUserStorage(ctx.storage).outputsBackfilled.put(false));
  const finish = Promise.withResolvers<void>();
  const stale = [{workpieceId: 10, title: "Removed", created: new Date(0)}];
  using read = vi.spyOn(OverseerDurableObject.prototype, "getOutputsForOwnerBackfill").mockImplementation(async () => {
    await finish.promise;
    return stale;
  });

  const updates = new OutputUpdates();
  using callback = new RpcStub(updates);
  using _subscription = await user.subscribeToOutputs(callback);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  try {
    await user.syncWorkspaceListing(workspaceId, {outputs: []});
    await vi.waitFor(() => expect(updates.updates).toEqual([[workspaceId, []]]));
  } finally { finish.resolve(); }

  await vi.waitFor(() => expect(updates.snapshots).toEqual([[[], true], [[], false]]));
  expect(await user.listOutputs()).toEqual({outputs: [], catchingUp: false});
  expect(read).toHaveBeenCalledTimes(1);
});

it("reads a backfill page once for a listOutputs() that asks while the subscription reads it", async () => {
  const {user, workspaceId} = await setup();
  await runInDurableObject(user, (_instance, ctx) => makeUserStorage(ctx.storage).outputsBackfilled.put(false));
  const finish = Promise.withResolvers<void>();
  using read = vi.spyOn(OverseerDurableObject.prototype, "getOutputsForOwnerBackfill").mockImplementationOnce(async () => {
    await finish.promise;
    return [{workpieceId: 10, title: "Healthy", created: new Date(0)}];
  }).mockRejectedValueOnce(new Error("unavailable"));

  const updates = new OutputUpdates();
  using callback = new RpcStub(updates);
  using _subscription = await user.subscribeToOutputs(callback);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  const listing = await runInDurableObject(user, async (instance: UserDurableObject) => {
    const result = instance.listOutputs();
    finish.resolve();
    return result;
  });

  expect(listing).toMatchObject({outputs: [{workspaceId, workpieceId: 10}], catchingUp: false});
  await vi.waitFor(() => expect(updates.snapshots.at(-1)).toMatchObject([[{workspaceId, workpieceId: 10}], false]));
  expect(read).toHaveBeenCalledTimes(1);
});

it("ends the sweep at a page where every workspace failed, and resumes it on the next subscription", async () => {
  const {user, workspaceId} = await setup();
  await runInDurableObject(user, (_instance, ctx) => {
    let storage = makeUserStorage(ctx.storage);
    storage.outputsBackfilled.put(false);
    // Invalid IDs sort before the healthy workspace and make every read on the first page fail.
    for (let i = 0; i < 16; i++) storage.gadgets.put({
      id: `!unavailable-${i}`, title: "Unavailable", created: new Date(0), lastActive: new Date(0),
    });
  });
  using read = vi.spyOn(OverseerDurableObject.prototype, "getOutputsForOwnerBackfill").mockResolvedValueOnce([
    {workpieceId: 10, title: "Healthy", created: new Date(0)},
  ]);
  const first = new OutputUpdates();
  using firstCallback = new RpcStub(first);
  using _firstSubscription = await user.subscribeToOutputs(firstCallback);
  await vi.waitFor(() => expect(first.snapshots).toEqual([[[], true], [[], false]]));
  expect(read).not.toHaveBeenCalled();

  const next = new OutputUpdates();
  using nextCallback = new RpcStub(next);
  using _nextSubscription = await user.subscribeToOutputs(nextCallback);
  await vi.waitFor(() => {
    expect(next.snapshots[0]).toEqual([[], true]);
    const [outputs, catchingUp] = next.snapshots.at(-1)!;
    expect(catchingUp).toBe(false);
    expect(outputs).toMatchObject([{workspaceId, workpieceId: 10, title: "Healthy"}]);
  });
  expect(read).toHaveBeenCalledTimes(1);
});
