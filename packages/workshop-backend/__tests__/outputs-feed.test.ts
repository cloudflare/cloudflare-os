// The output index in the User DO, served through subscribeToOutputs(): a snapshot, then each
// workspace's outputs as its Overseer pushes them or the user's listing changes. Runs against real
// Overseer and User DOs.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { expect, it, vi } from "vitest";
import type { OutputSummary, OutputsSubscriber } from "@gadgets/workshop-shared/api";
import { UserDurableObject } from "../src/user.js";
import { OverseerDurableObject } from "../src/overseer.js";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations.js";

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
  await user.syncWorkspaceListing(workspaceId, {title: {title: "Renamed", titleRev: 1}});
  await vi.waitFor(() => expect(updates.updates.at(-1)).toMatchObject([workspaceId, [{workspaceTitle: "Renamed"}]]));
  expect(updates.updates.slice(before)).toEqual([[workspaceId, [expect.objectContaining({workspaceTitle: "Renamed"})]]]);
});

it("drops a shared workspace's outputs when access is revoked", async () => {
  const {user: owner, workspaceId} = await setup();
  const reader = await newUser("Reader");
  const outputs = [{workpieceId: 10, title: "Dashboard", created: new Date(0)}];
  // Not listed until first opened.
  await reader.syncWorkspaceListing(workspaceId, {outputs});
  expect((await reader.listOutputs()).outputs).toEqual([]);
  await reader.recordSharedWorkspaceOpen(workspaceId, "Workspace", await owner.whoami(), "build", []);
  await reader.setWorkspaceLastActive(workspaceId, new Date(), undefined);
  await reader.syncWorkspaceListing(workspaceId, {outputs});

  const updates = new OutputUpdates();
  using callback = new RpcStub(updates);
  using _subscription = await reader.subscribeToOutputs(callback);
  await vi.waitFor(() => expect(updates.snapshots).toMatchObject([[[{workspaceId, workpieceId: 10}], false]]));

  await reader.forgetSharedWorkspace(workspaceId);
  await vi.waitFor(() => expect(updates.updates.at(-1)).toEqual([workspaceId, []]));
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
