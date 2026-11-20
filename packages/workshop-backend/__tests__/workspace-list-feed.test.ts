// The user's workspace list is served live from their User DO through subscribeToWorkspaces():
// their own marks on a workspace (pin, mute) reach their own feed alone, and a rename in a shared
// workspace is mirrored by its Overseer into each collaborator's listing.
// Runs against real Overseer and User DOs.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { expect, it, vi } from "vitest";
import type { AiChatAuthorInfo, WorkspaceMetadataWithTimestamps, WorkspacesSubscriber } from "@gadgets/workshop-shared/api";
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

const withImpl = <T>(stub: DurableObjectStub<OverseerDurableObject>,
    fn: (impl: OverseerDurableObject["impl"]) => Promise<T> | T) =>
  runInDurableObject(env.TEST_OVERSEER.get(stub.id), instance => fn(instance.impl));

const newUser = async (name: string) => {
  const profile: AiChatAuthorInfo = {type: "user", id: `${name}-${crypto.randomUUID()}`, name};
  const user = env.TEST_USER.getByName(profile.id);
  await runInDurableObject(user, (_instance, ctx) => makeUserStorage(ctx.storage).profile.put(profile));
  return {user, profile};
};

// An owner's workspace, listed (no longer provisional), and shared with a builder who has opened it.
const setup = async () => {
  const {user: owner, profile: ownerProfile} = await newUser("owner");
  const {user: reader, profile: readerProfile} = await newUser("reader");
  const workspace = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const workspaceId = workspace.id.toString();
  await owner.newWorkspace(workspaceId, "Plans");
  await owner.setWorkspaceLastActive(workspaceId, new Date(), undefined);
  await withImpl(workspace, impl => {
    impl.storage.version.put(OVERSEER_STORAGE_VERSION);
    impl.storage.ownerId.put(owner.id.toString());
    impl.ownerId = owner.id.toString();
    impl.storage.title.put("Plans");
    impl.storage.collaborators.put({profile: readerProfile,
      addedBy: [{type: "user", sharer: ownerProfile.id, role: "build", created: new Date()}]});
  });
  await reader.recordSharedWorkspaceOpen(workspaceId, "Plans", ownerProfile, "build", []);
  return {owner, reader, workspace, workspaceId};
};

class ListUpdates extends RpcTarget implements WorkspacesSubscriber {
  readonly snapshots: WorkspaceMetadataWithTimestamps[][] = [];
  readonly updates: [string, WorkspaceMetadataWithTimestamps | null][] = [];
  async snapshot(workspaces: WorkspaceMetadataWithTimestamps[]) { this.snapshots.push(workspaces); }
  async updated(workspaceId: string, workspace: WorkspaceMetadataWithTimestamps | null) {
    this.updates.push([workspaceId, workspace]);
  }
}

const subscribed = async (user: DurableObjectStub<UserDurableObject>) => {
  const updates = new ListUpdates();
  const callback = new RpcStub(updates);
  const subscription = await user.subscribeToWorkspaces(callback);
  await vi.waitFor(() => expect(updates.snapshots).toHaveLength(1));
  return {updates, [Symbol.dispose]: () => { subscription[Symbol.dispose](); callback[Symbol.dispose](); }};
};

it("lists a workspace once it is no longer provisional, and mirrors the owner's rename to a collaborator", async () => {
  const {owner, reader, workspace, workspaceId} = await setup();
  using ownerFeed = await subscribed(owner);
  using readerFeed = await subscribed(reader);
  expect(readerFeed.updates.snapshots[0]).toMatchObject([{id: workspaceId, title: "Plans", role: "build"}]);

  const fresh = crypto.randomUUID();
  await owner.newWorkspace(fresh, "Untitled Workspace");
  expect(ownerFeed.updates.updates).toEqual([]);
  await owner.setWorkspaceLastActive(fresh, new Date(), undefined);
  await vi.waitFor(() => expect(ownerFeed.updates.updates).toMatchObject([[fresh, {id: fresh}]]));

  await withImpl(workspace, impl => impl.storage.title.put("Roadmap"));
  await vi.waitFor(() => expect(readerFeed.updates.updates.at(-1))
    .toMatchObject([workspaceId, {id: workspaceId, title: "Roadmap"}]));
});

it("mirrors the workspace's rename and activity to its owner", async () => {
  const {owner, workspace, workspaceId} = await setup();
  using ownerFeed = await subscribed(owner);
  const lastActive = new Date(Date.now() + 60_000);
  await withImpl(workspace, impl => {
    impl.storage.totalCost.put(2.5);
    impl.storage.title.put("Roadmap");
    impl.bumpLastActive(lastActive);
  });
  await vi.waitFor(() => expect(ownerFeed.updates.updates.at(-1))
    .toMatchObject([workspaceId, {id: workspaceId, title: "Roadmap"}]));
  await vi.waitFor(async () => expect(await owner.getWorkspace(workspaceId))
    .toMatchObject({title: "Roadmap", lastActive, totalCost: 2.5}));
});

it("keeps a newer mirrored title when a shared-open write arrives late", async () => {
  const {owner, reader, workspace, workspaceId} = await setup();
  using readerFeed = await subscribed(reader);
  const olderRevision = await withImpl(workspace, impl => impl.storage.titleRev.get());
  await withImpl(workspace, impl => impl.storage.title.put("Roadmap"));
  await vi.waitFor(() => expect(readerFeed.updates.updates.at(-1))
    .toMatchObject([workspaceId, {title: "Roadmap"}]));

  await reader.recordSharedWorkspaceOpen(workspaceId, "Plans", await owner.whoami(), "build", [], olderRevision);
  // A delayed push of the older title is taken as already there.
  await reader.syncWorkspaceListing(workspaceId, {title: {title: "Plans", titleRev: olderRevision}});
  const [listing] = await reader.listWorkspaces();
  expect(listing).toMatchObject({id: workspaceId, title: "Roadmap"});
  expect(listing).not.toHaveProperty("sharedTitleRev");
  expect(readerFeed.updates.updates.at(-1)?.[1]).not.toHaveProperty("sharedTitleRev");
});

it("sends the user's own pin and mute to their feed alone", async () => {
  const {owner, reader, workspaceId} = await setup();
  using ownerFeed = await subscribed(owner);
  using readerFeed = await subscribed(reader);
  const latest = () => ownerFeed.updates.updates.findLast(([updated]) => updated === workspaceId)?.[1];

  await owner.updatePinned(workspaceId, true);
  await owner.setWorkspaceNotificationMute(workspaceId, {indefinite: true});
  await vi.waitFor(() => expect(latest()).toMatchObject({pinned: true, notificationMute: {indefinite: true}}));

  await owner.updatePinned(workspaceId, false);
  await vi.waitFor(() => expect(latest()).toMatchObject({pinned: false}));

  // None of it is the collaborator's.
  expect(readerFeed.updates.updates).toEqual([]);
  expect((await reader.listWorkspaces())[0]).not.toHaveProperty("notificationMute");
});

it("says a workspace left the list when it is dismissed or deleted", async () => {
  const {owner, reader, workspaceId} = await setup();
  using ownerFeed = await subscribed(owner);
  using readerFeed = await subscribed(reader);

  await reader.forgetSharedWorkspace(workspaceId);
  await vi.waitFor(() => expect(readerFeed.updates.updates).toEqual([[workspaceId, null]]));

  await owner.workspaceRemoved(workspaceId);
  await vi.waitFor(() => expect(ownerFeed.updates.updates).toEqual([[workspaceId, null]]));
});
