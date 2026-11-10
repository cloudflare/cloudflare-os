// To its space, a workspace that holds restricted data or is owner-invites-only is a workspace
// like any other: listed once it has seen activity, under its current title, wherever its owner
// may place it. Against real Durable Objects: the workspace's Overseer, which holds the two
// flags, its owner's User DO, which keeps no copy of them, and the spaces. What a member's role
// opens on such a workspace is in spaces-roles.test.ts, and what the registrar does with any
// workspace in spaces-workspaces.test.ts.

import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiChatAuthorInfo, BlueprintMetadata, Overseer } from "@gadgets/workshop-shared/api";
import { blueprintContentKey } from "../src/blueprint-archive.js";
import { buildReleasePack, buildSnapshotRelease } from "../src/blueprint-release.js";
import { OverseerDurableObject } from "../src/overseer.js";
import { SpaceDurableObject, spaceById } from "../src/spaces.js";
import { makeUserStorage, type GadgetRecord } from "../src/storage-schema/user-storage.js";
import { UserDurableObject } from "../src/user.js";
// Load the whole backend up front, so that its slow load is not billed to the first test.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_SPACE: DurableObjectNamespace<SpaceDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

// A user: their id as a workspace's Overseer holds it, and the id of their personal space.
type Account = {
  profile: AiChatAuthorInfo; user: DurableObjectStub<UserDurableObject>; userId: string;
  personal: string;
};

// The two one-way flags of a workspace, as its Overseer stores them and an observation states them.
const FLAGS = ["containsRestrictedData", "ownerInvitesOnly"] as const;
const NO_SUCH_SPACE = "No such space, or you are not a member of it.";
// Shorter than the test timeout, so that a wait which runs out fails with its own assertion.
const WAIT = { timeout: 4_000 };
const unique = () => crypto.randomUUID().slice(0, 8);

// A user with an account, who has listed their spaces: that spends their object's one catch-up
// while they have no workspace, so what a test then observes was done by the call it made.
async function signUp(name: string): Promise<Account> {
  let id = `${name}-${unique()}`;
  let user = env.TEST_USER.getByName(id);
  await user.authenticateFromCfAccess(id, true);
  await user.listSpaces();
  let profile: AiChatAuthorInfo = { type: "user", id, name: id };
  let personal = env.TEST_SPACE.idFromName(id).toString();
  return { profile, user, userId: user.id.toString(), personal };
}

// A team space, created by `admin` and with `members` in the lowest role.
async function teamSpace(admin: Account, ...members: Account[]): Promise<string> {
  let spaceId = env.TEST_SPACE.newUniqueId().toString();
  let space = spaceById(env.TEST_SPACE, spaceId);
  expect(await space.create({ name: "Team", kind: "team" }, admin.profile)).toBe(true);
  for (let { profile } of members) await space.setMemberRole(admin.profile.id, profile.id, "use");
  return spaceId;
}

// Waits out every sync the owner's object has been asked for so far, detached ones included:
// deleting a workspace it has no record of takes its turn after them and touches no space.
const settled = (owner: Account) => owner.user.deleteWorkspace("ws-none");

// The owner's stored record of a workspace, with the marker that no caller is handed.
const stored = (owner: Account, id: string): Promise<GadgetRecord | undefined> =>
    runInDurableObject(owner.user, (_instance, state) =>
        makeUserStorage(state.storage).gadgets.get(id));

// Waits for space `spaceId`, or with none the owner's personal space, to have acknowledged the
// workspace under `title`.
async function listed(owner: Account, id: string, spaceId = owner.personal, title = "Untitled") {
  await vi.waitFor(async () =>
      expect((await stored(owner, id))?.registered).toEqual({ spaceId, title }), WAIT);
}

// The title of each workspace the space lists, by id, as its member `viewer` is shown them.
async function listing(spaceId: string, viewer: Account): Promise<Record<string, string>> {
  let entries = await spaceById(env.TEST_SPACE, spaceId).listWorkspaces(viewer.profile.id);
  return Object.fromEntries(entries.map(entry => [entry.id, entry.title]));
}

// Everything the registrar asks of any space from here on.
function spaceCalls() {
  let attach = vi.spyOn(SpaceDurableObject.prototype, "attachWorkspaces");
  return { attach, detach: vi.spyOn(SpaceDurableObject.prototype, "detachWorkspace") };
}

// A real workspace of `owner`'s, provisional in their records, in team space `spaceId` or with
// none in their personal space. `run` acts inside it on its OverseerImpl, and `open` gives its
// client interface as the owner holds it. The owner is planted rather than established by a
// first open, and the two calls an open makes to the owner's object besides the ones under test
// are stubbed, as in worktrees.test.ts.
async function workspace({ user, userId, profile }: Account, spaceId?: string) {
  let stub = env.TEST_OVERSEER.get(env.TEST_OVERSEER.newUniqueId());
  let id = stub.id.toString();
  await user.newWorkspace(id, "Untitled", spaceId);
  let run = (act: (impl: any, open: () => Promise<Overseer>) => unknown) =>
      runInDurableObject(stub, async (instance: OverseerDurableObject) => {
        let impl = (instance as unknown as { impl: any }).impl;
        impl.storage.ownerId.put(userId);
        impl.ownerId = userId;
        impl.ensureAmbientCapsules = async () => {};
        impl.markOutputsDirty = () => {};
        let notifyClosed = new NativeRpcStub<() => void>(() => {});
        await act(impl, () => instance.open(userId, profile.id, notifyClosed));
      });
  await run(() => {});
  return { id, stub, run };
}

// Has the workspace's Overseer authorize an observation that states `flags`, through a
// connection put on record for it: the ledger refuses one through a connection the workspace
// does not hold.
function observe(impl: any, ...flags: (typeof FLAGS)[number][]): Promise<void> {
  if (!impl.storage.gatekeepers.get(1)) {
    impl.storage.gatekeepers.put({ id: 1, resourceTitle: "Connection 1", class: {} });
  }
  return impl.authorizeObservation(1, {
    title: "Read a thing", description: "The test read a thing.",
    ...Object.fromEntries(flags.map(flag => [flag, true])),
  }, { from: "user" });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a workspace that holds restricted data or is owner-invites-only", () => {
  it("stays listed by its space, under its current title, when an observation sets a flag",
      async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    let team = await teamSpace(alice, bob);
    for (let flag of FLAGS) {
      let { id, run } = await workspace(alice, team);
      await run(impl => impl.bumpLastActive());
      await listed(alice, id, team);
      let { detach } = spaceCalls();
      let reported = vi.spyOn(UserDurableObject.prototype, "setWorkspaceLastActive");

      // The observation tells the owner's object nothing: the report just made holds the next
      // one back for a minute, and none is sent for the flag.
      await run(async impl => {
        await observe(impl, flag);
        expect(impl.storage[flag].get()).toBe(true);
      });
      await settled(alice);
      expect(reported).not.toHaveBeenCalled();
      expect(await listing(team, bob)).toMatchObject({ [id]: "Untitled" });

      // A title it is given afterwards reaches the listing, as any workspace's does.
      await run(async (_impl, open) => (await open()).setTitle("Quarterly numbers"));
      await listed(alice, id, team, "Quarterly numbers");
      expect(await listing(team, bob)).toMatchObject({ [id]: "Quarterly numbers" });
      expect(detach).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it("is listed once it has seen activity, created in a team space or moved to one", async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    let team = await teamSpace(alice, bob);
    // Instantiating a blueprint ends with an activity report, here the first a workspace makes.
    let { commitId, objects } = await buildSnapshotRelease(new Map([["index.js", "export {};"]]));
    let made: BlueprintMetadata = {
      title: "Made", description: "", author: alice.profile, created: new Date(), version: 1,
      lastUpdated: new Date(), commitId, bindings: {},
    };
    let blueprintId = `bp-${crypto.randomUUID()}`;
    await env.BLUEPRINT_CONTENT.put(blueprintContentKey(blueprintId, made),
        await buildReleasePack(oid => objects.get(oid), commitId));

    for (let flag of FLAGS) {
      // Each holds the flag before its owner's object first hears of any activity.
      let [created, instantiated, moved] = await Promise.all(
          [workspace(alice, team), workspace(alice, team), workspace(alice)]);
      for (let { run } of [created, instantiated, moved]) {
        await run(impl => impl.storage[flag].put(true));
      }
      await created.run(impl => impl.bumpLastActive());
      await instantiated.stub.initializeFromBlueprint(blueprintId, made);
      await moved.run(impl => impl.bumpLastActive());
      await listed(alice, created.id, team);
      await listed(alice, instantiated.id, team);
      await listed(alice, moved.id);

      await moved.run(async (_impl, open) => (await open()).moveToSpace(team));
      expect(await stored(alice, moved.id)).toMatchObject(
          { spaceId: team, registered: { spaceId: team, title: "Untitled" } });
      expect(await listing(team, bob)).toMatchObject(
          { [created.id]: "Untitled", [instantiated.id]: "Untitled", [moved.id]: "Untitled" });
      expect(await listing(alice.personal, alice)).not.toHaveProperty(moved.id);
    }
  });

  it("is refused a move its owner may not make, as any workspace is", async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    // Bob is no member of this space, and Alice's personal space is hers alone.
    let team = await teamSpace(alice);
    for (let flag of FLAGS) {
      let { id, run } = await workspace(bob);
      await run(impl => {
        impl.storage[flag].put(true);
        return impl.bumpLastActive();
      });
      await listed(bob, id);
      let { attach } = spaceCalls();
      await run(async (_impl, open) => {
        let session = await open();
        for (let spaceId of [team, alice.personal, env.TEST_SPACE.newUniqueId().toString()]) {
          await expect(session.moveToSpace(spaceId)).rejects.toThrow(NO_SUCH_SPACE);
        }
        await expect(session.moveToSpace("not-an-id")).rejects.toThrow("Invalid space id.");
      });
      // Each of the three spaces was asked, and refused: the workspace is where it was.
      expect(attach).toHaveBeenCalledTimes(3);
      let record = await stored(bob, id);
      expect(record).not.toHaveProperty("spaceId");
      expect(record?.registered).toEqual({ spaceId: bob.personal, title: "Untitled" });
      expect(await listing(team, alice)).toEqual({});
      expect(await listing(bob.personal, bob)).toMatchObject({ [id]: "Untitled" });
      vi.restoreAllMocks();
    }
  });

  it("has its flags on its Overseer alone: its owner's record of it holds neither", async () => {
    let alice = await signUp("alice");
    let team = await teamSpace(alice);
    let { id, run } = await workspace(alice, team);
    await run(impl => impl.bumpLastActive());
    await listed(alice, id, team);
    // An observation that sets both, then each call of the Overseer's that reaches the record.
    await run(async (impl, open) => {
      await observe(impl, ...FLAGS);
      let session = await open();
      await session.setTitle("Plan");
      await session.moveToSpace(null);
      await session.moveToSpace(team);
      expect(await session.getMetadata())
          .toMatchObject({ containsRestrictedData: true, ownerInvitesOnly: true });
    });
    for (let flag of FLAGS) expect(await stored(alice, id)).not.toHaveProperty(flag);
    expect(await alice.user.listWorkspaces()).toEqual([{
      id, title: "Plan", created: expect.any(Date), lastActive: expect.any(Date), spaceId: team,
    }]);
  });

  it("is dropped from its space when deleted, its owner's object repeating until the space answers",
      async () => {
    let alice = await signUp("alice");
    let { id, run } = await workspace(alice);
    await run(impl => {
      impl.storage.containsRestrictedData.put(true);
      return impl.bumpLastActive();
    });
    await listed(alice, id);
    let { attach, detach } = spaceCalls();
    detach.mockRejectedValueOnce(new Error("space unavailable"));

    // A delete ends by telling its caller's session and restarting the workspace's object. Here
    // the session is a function of this object's own, which cannot be called while the delete
    // holds the object, and the restart would take the object from under the test.
    await run(async (impl, open) => {
      impl.scheduleAccessRestart = async () => {};
      let session = Object.assign(await open(), { notifyClosed: async () => {} });
      await session.deleteSelf();
      // Its space was out of reach, so the owner's record stands, and the removal is repeated
      // as the workspace's alarm would repeat it. The record is read through a stub of this
      // object's own, since one made by the test cannot be called from in here.
      expect(await env.TEST_USER.getByName(alice.profile.id).getWorkspace(id)).not.toBeNull();
      await impl.deliverUserUpdates();
    });
    expect(await alice.user.getWorkspace(id)).toBeNull();
    expect(await listing(alice.personal, alice)).toEqual({});
    expect(detach).toHaveBeenCalledTimes(2);
    expect(attach).not.toHaveBeenCalled();
  });
});
