// A member's role in a space applies to the workspaces that space lists. The role a space gives
// and the leases and revocations it keeps of what it gave are SpaceModel's, over a Map-backed
// storage. Everything else runs against real Durable Objects: the space's alarm, which delivers
// the revocations; the owner's User DO, which a workspace asks; and the workspace's Overseer,
// which combines the answer with its own sharing.

import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  AiChatAuthorInfo, CollaboratorRole, Overseer, SpaceMemberRole,
} from "@gadgets/workshop-shared/api";
import { OverseerDurableObject } from "../src/overseer.js";
import { SpaceDurableObject, SpaceModel, teamSpaceClaim } from "../src/spaces.js";
import { makeSpaceStorage, type SpaceLease } from "../src/storage-schema/space-storage.js";
import {
  makeUserStorage, type GadgetRecord, type WorkspaceRestrictions,
} from "../src/storage-schema/user-storage.js";
import { UserDurableObject } from "../src/user.js";
import { makeMockStorage } from "./mock-storage.js";
// Load the whole backend up front, so that its slow load is not billed to the first test.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_SPACE: DurableObjectNamespace<SpaceDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

// A user: their id as a workspace's Overseer holds it, and the key of their personal space.
type Account = {
  profile: AiChatAuthorInfo; user: DurableObjectStub<UserDurableObject>; userId: string;
  personal: string;
};
type Member = [Account, SpaceMemberRole];

const NEITHER: WorkspaceRestrictions = { containsRestrictedData: false, ownerInvitesOnly: false };
const DENIED = "You don't have access to this workspace.";
const NO_SHARING = "You do not have permission to share this workspace.";
const ABOVE_OWN_ROLE = "You cannot grant a role higher than your own.";
const NO_AGENT = "You do not have access to interact with this workspace through its agent.";
const REVOKED = "Gadget restarted because a member's access through its space changed.";
const FLAGGED = "Gadget restarted because it is no longer open to the members of its space.";
// Shorter than the test timeout, so that a wait which runs out fails with its own assertion.
const WAIT = { timeout: 4_000 };
const DAY = new Date("2026-01-01");
// The revocations one run of a space's alarm attempts.
const REVOCATION_BATCH = 16;
const unique = () => crypto.randomUUID().slice(0, 8);
const pair = (lease: SpaceLease) => `${lease.workspace}:${lease.profile}`;
const space = (key: string) => env.TEST_SPACE.getByName(key);
// An id that names a workspace's Overseer, which a revocation has to be able to reach.
const workspaceId = () => env.TEST_OVERSEER.newUniqueId().toString();
// The id of the object a spy on one of its methods was called on.
const objectId = (object: unknown) => (object as { ctx: DurableObjectState }).ctx.id.toString();

async function signUp(name: string, listSpaces = true): Promise<Account> {
  let id = `${name}-${unique()}`;
  let user = env.TEST_USER.getByName(id);
  await user.authenticateFromCfAccess(id, true);
  if (listSpaces) await user.listSpaces();
  let profile: AiChatAuthorInfo = { type: "user", id, name: id };
  return { profile, user, userId: user.id.toString(), personal: `~${id}` };
}

// A team space under a fresh key, created by `admin`.
async function teamSpace(admin: Account, ...members: Member[]): Promise<string> {
  let key = `team-${unique()}`;
  expect(await space(key).claim(teamSpaceClaim(key, "Team"), admin.profile)).toBe(true);
  for (let [{ profile }, role] of members) {
    await space(key).setMemberRole(admin.profile.id, profile.id, role);
  }
  return key;
}

// Writes one of the owner's records of a workspace: active unless `record` says otherwise.
function plant(owner: Account, record: Partial<GadgetRecord> & { id: string }): Promise<void> {
  return runInDurableObject(owner.user, (_instance, state) => makeUserStorage(state.storage)
      .gadgets.put({ title: "Untitled", created: DAY, lastActive: DAY, ...record }));
}

// A workspace of `owner`'s that has reported neither flag and that team space `spaceKey`, or
// with none their personal space, lists. Deleting a workspace the owner has no record of waits
// out the sync that lists this one.
async function listedWorkspace(owner: Account, spaceKey?: string, id = workspaceId()) {
  await owner.user.newGadget(id, "Untitled", spaceKey);
  await owner.user.setGadgetLastActive(id, DAY, undefined, NEITHER);
  await owner.user.deleteGadget("ws-none", NEITHER);
  return id;
}

// The revocations a space has queued, oldest first, and when its alarm is set for.
const queue = (key: string) => runInDurableObject(space(key), (_instance, state) =>
    [...makeSpaceStorage(state.storage).revocations.list()].map(pair));
const alarm = (key: string) =>
    runInDurableObject(space(key), (_instance, state) => state.storage.getAlarm());

// A real, listed workspace of `owner`'s. `run` acts inside its Overseer, on its OverseerImpl,
// with the owner planted rather than established by a first open; the restarts it schedules are
// recorded in `restarts` instead of taking the object from under the test.
async function workspace(owner: Account, spaceKey?: string) {
  let stub = env.TEST_OVERSEER.get(env.TEST_OVERSEER.newUniqueId());
  let id = await listedWorkspace(owner, spaceKey, stub.id.toString());
  let restarts: string[] = [];
  let run = (act: (impl: any, instance: OverseerDurableObject) => unknown) =>
      runInDurableObject(stub, async (instance: OverseerDurableObject) => {
        let impl = (instance as unknown as { impl: any }).impl;
        impl.storage.ownerId.put(owner.userId);
        impl.ownerId = owner.userId;
        impl.ensureAmbientCapsules = async () => {};
        impl.markOutputsDirty = () => {};
        impl.scheduleAccessRestart = async (reason: string) => { restarts.push(reason); };
        await act(impl, instance);
      });
  await run(() => {});
  return { id, run, restarts };
}

// Alice's workspace in a team space of hers where Bob is a "build" member and Carol a "use"
// member, and Mallory, who is in no space of Alice's.
async function team() {
  let [alice, bob, carol, mallory] =
      await Promise.all(["alice", "bob", "carol", "mallory"].map(name => signUp(name)));
  let key = await teamSpace(alice, [bob, "build"], [carol, "use"]);
  return { alice, bob, carol, mallory, key, ws: await workspace(alice, key) };
}

// Opens the workspace as `as`, and the role the session they get has.
const open = (instance: OverseerDurableObject, as: Account): Promise<Overseer> =>
    instance.open(as.userId, as.profile.id, new NativeRpcStub<() => void>(() => {}));
const roleOf = async (session: Overseer) => (await session.getMetadata()).role;
// What opening the workspace as `as` comes to: the role of their session, or the refusal.
const opening = (instance: OverseerDurableObject, as: Account) =>
    open(instance, as).then(roleOf, (error: Error) => error.message);
// What an observation comes to: "admitted", or the reason it was blocked.
const observing = (observation: Promise<void>) =>
    observation.then(() => "admitted", (error: Error) => error.message);

// The owner adds `to` to the workspace's own sharing, in `role`.
function share(impl: any, owner: Account, to: Account, role: CollaboratorRole): void {
  impl.storage.collaborators.put({
    profile: to.profile,
    addedBy: [{ type: "user", sharer: owner.profile.id, created: DAY, role }],
  });
}

// What the workspace's sharing reports of a collaborator who used it and was removed.
const lostAccess = (of: Account) => [{ profile: of.profile, oldRole: "use", newRole: null }];

// Every lookup an Overseer makes of a space role, which goes to its owner's User DO.
const lookups = () => vi.spyOn(UserDurableObject.prototype, "workspaceRoleInSpace");

// An observation that states `flag` of the workspace, one of the two under which no space role
// counts.
const flagging = (impl: any, flag: string): Promise<void> => impl.authorizeObservation(
    1, { title: "Read", description: "The test read a thing.", [flag]: true }, { from: "user" });

// The same, with the space's answer to the nth lookup kept from the Overseer until
// `hold.through` reaches n, so that a test decides what happens while a lookup is in flight.
function heldLookups() {
  let { workspaceRoleInSpace } = UserDurableObject.prototype;
  let hold = { through: 0 };
  onTestFinished(() => { hold.through = Infinity; });
  let asked = lookups().mockImplementation(async function (this: UserDurableObject, ...ask) {
    let nth = asked.mock.calls.length;
    let role = await workspaceRoleInSpace.apply(this, ask);
    while (hold.through < nth) await scheduler.wait(10);
    return role;
  });
  return { asked, hold };
}

// Makes each of `observers` an observer of the workspace's one connection, which no gadget
// binds, and returns what an observation from it that names them all as excluded does, with the
// removals its facet saw.
function excluding(impl: any, ...observers: Account[]) {
  let observerIds = observers.map(observer => `obs-${observer.profile.id}`);
  let removals: string[] = [];
  impl.storage.gatekeepers.put({
    id: 1, resourceTitle: "Connection", class: {},
    creationSpec: {
      type: "gatekeeper", vendorId: "testvendor", resourceUrl: "https://example.com/1",
      typeUrlPattern: "https://*",
    },
  });
  for (let [nth, { profile }] of observers.entries()) {
    impl.storage.observers.put(
        { profileId: profile.id, observerId: observerIds[nth], accountChoices: { 1: 10 } });
  }
  impl.getGatekeeperFacet = (id: number) => ({
    removeObserver: async (removed: string) => { removals.push(`${id}:${removed}`); },
  });
  let observe = (): Promise<void> => impl.authorizeObservation(1, {
    title: "Observation", description: "One the gatekeeper keeps from its observers.",
    excludeObservers: observerIds,
  }, { from: "agent", chatId: 1 });
  return { observe, removals, observerIds };
}

// Has a revocation fail at every workspace's Overseer that `reachable` does not let it reach.
function revocationsReaching(reachable: (workspace: string) => boolean | Promise<boolean>) {
  let { revokeSpaceAccess } = OverseerDurableObject.prototype;
  return vi.spyOn(OverseerDurableObject.prototype, "revokeSpaceAccess")
      .mockImplementation(async function (this: OverseerDurableObject, profileId) {
        if (!await reachable(objectId(this))) throw new Error("workspace unavailable");
        return revokeSpaceAccess.call(this, profileId);
      });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the role a space gives its members on the workspaces it lists", () => {
  const [ALICE, BOB, CAROL, DANA] = ["alice", "bob", "carol", "dana"]
      .map((id): AiChatAuthorInfo => ({ type: "user", id, name: id }));

  // Alice's team space with Bob as a "build" member and Carol as a "use" member, listing two
  // workspaces of Alice's.
  function teamModel() {
    let storage = makeSpaceStorage(makeMockStorage());
    let model = new SpaceModel(storage);
    model.claim(teamSpaceClaim("eng", "Engineering"), ALICE);
    model.setMemberRole(ALICE.id, BOB, "build");
    model.setMemberRole(ALICE.id, CAROL, "use");
    model.attachWorkspaces(ALICE, ["w1", "w2"].map(id => ({ id, title: id, created: DAY })));
    let leases = () => [...storage.leases.list()].map(pair);
    return { model, storage, leases, queued: () => [...storage.revocations.list()].map(pair) };
  }

  it("is build for an admin and a build member, use for a use member, each with a lease", () => {
    let { model, leases, queued } = teamModel();
    expect(model.workspaceRole("w1", ALICE.id, ALICE.id)).toBe("build");
    expect(model.workspaceRole("w1", ALICE.id, BOB.id)).toBe("build");
    expect(model.workspaceRole("w2", ALICE.id, CAROL.id)).toBe("use");
    expect(leases()).toEqual(["w1:alice", "w1:bob", "w2:carol"]);
    expect(queued()).toEqual([]);
  });

  it("is none, and leaves no lease, without a member, a listing and the owner it is listed under",
      () => {
    let { model, leases } = teamModel();
    expect(model.workspaceRole("w1", ALICE.id, DANA.id)).toBeUndefined();
    expect(model.workspaceRole("w3", ALICE.id, BOB.id)).toBeUndefined();
    // Listed under Alice, so not for Bob's User DO to ask about, whoever it asks for.
    expect(model.workspaceRole("w1", BOB.id, CAROL.id)).toBeUndefined();
    expect(leases()).toEqual([]);
  });

  it("is none, and leaves no lease, for a member whose stored role is none of the three", () => {
    let { model, storage, leases } = teamModel();
    storage.members.put({ profile: DANA, role: "owner" as SpaceMemberRole, added: DAY });
    expect(model.workspaceRole("w1", ALICE.id, DANA.id)).toBeUndefined();
    expect(leases()).toEqual([]);
  });

  it("revokes the leases a removal, a lowering or a detach ends, and none on a promotion", () => {
    let { model, leases, queued } = teamModel();
    model.setMemberRole(ALICE.id, DANA, "admin");
    for (let id of ["w1", "w2"]) {
      for (let member of [BOB, CAROL, DANA]) model.workspaceRole(id, ALICE.id, member.id);
    }

    // Raised, and moved between the two roles that give "build": nothing is taken back.
    model.setMemberRole(ALICE.id, CAROL, "build");
    model.setMemberRole(ALICE.id, BOB, "admin");
    model.setMemberRole(ALICE.id, BOB, "build");
    expect(queued()).toEqual([]);

    model.setMemberRole(ALICE.id, DANA, "use");
    expect(queued()).toEqual(["w1:dana", "w2:dana"]);
    // Whoever removes a member, here himself.
    model.removeMember(BOB.id, BOB.id);
    expect(queued()).toEqual(["w1:dana", "w2:dana", "w1:bob", "w2:bob"]);
    // Only the owner an entry is listed under drops it, and its leases go with it.
    model.detachWorkspace("w2", BOB.id);
    expect(queued()).toHaveLength(4);
    model.detachWorkspace("w2", ALICE.id);
    expect(queued()).toEqual(["w1:dana", "w2:dana", "w1:bob", "w2:bob", "w2:carol"]);
    expect(leases()).toEqual(["w1:carol"]);

    // A role given again is a new lease, and the revocation of the old one still goes out.
    expect(model.workspaceRole("w1", ALICE.id, DANA.id)).toBe("use");
    expect(leases()).toEqual(["w1:carol", "w1:dana"]);
    expect(queued()).toHaveLength(5);
  });

  it("attempts a revocation at once, and one that failed after a wait that doubles to a limit",
      () => {
    let { model, storage, queued } = teamModel();
    for (let id of ["w1", "w2"]) {
      for (let member of [BOB, CAROL]) model.workspaceRole(id, ALICE.id, member.id);
    }
    model.removeMember(ALICE.id, BOB.id);
    // Queued together they are due together, and a run still takes no more than its batch.
    let [delivered, ...rest] = model.dueRevocations(0, 1);
    expect([pair(delivered), rest]).toEqual(["w1:bob", []]);
    model.delivered(delivered);
    expect(queued()).toEqual(["w2:bob"]);

    // The wait is the revocation's own and is stored with it, so nothing a space holds in memory
    // decides it: here every attempt is made by a model that has seen none of the others.
    let now = 0;
    let waits: number[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      let retrying = new SpaceModel(storage);
      let [failed] = retrying.dueRevocations(now, REVOCATION_BATCH);
      retrying.deferred(failed, now);
      expect(retrying.dueRevocations(now, REVOCATION_BATCH)).toEqual([]);
      waits.push(retrying.nextRevocationDue()! - now);
      now = retrying.nextRevocationDue()!;
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 300].map(seconds => seconds * 1_000));

    // One queued meanwhile is due at once and comes first, however long another has failed.
    model.removeMember(ALICE.id, CAROL.id);
    expect(model.nextRevocationDue()).toBe(0);
    expect(model.dueRevocations(now - 1, REVOCATION_BATCH).map(pair))
        .toEqual(["w1:carol", "w2:carol"]);
    expect(model.dueRevocations(now, REVOCATION_BATCH).map(pair))
        .toEqual(["w1:carol", "w2:carol", "w2:bob"]);
  });
});

// Alice's team space, listing workspaces of hers that Bob has been given "build" on.
async function leased(workspaces: number) {
  let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
  let key = await teamSpace(alice, [bob, "build"]);
  let ids = Array.from({ length: workspaces }, workspaceId).toSorted();
  await space(key).attachWorkspaces(
      alice.profile, ids.map(id => ({ id, title: "Untitled", created: DAY })));
  for (let id of ids) {
    expect(await space(key).workspaceRole(id, alice.profile.id, bob.profile.id)).toBe("build");
  }
  return { alice, bob, key, ids };
}

describe("a space's alarm", () => {
  it("tells each workspace of a revocation, and is not set again once none is queued",
      async () => {
    let { alice, bob, key, ids } = await leased(2);
    let revoke = vi.spyOn(OverseerDurableObject.prototype, "revokeSpaceAccess");
    await space(key).removeMember(alice.profile.id, bob.profile.id);
    await vi.waitFor(async () => expect(await queue(key)).toEqual([]), WAIT);
    expect(revoke.mock.calls).toEqual([[bob.profile.id], [bob.profile.id]]);
    expect(revoke.mock.contexts.map(objectId).toSorted()).toEqual(ids);
    await vi.waitFor(async () => expect(await alarm(key)).toBeNull(), WAIT);
    expect(await runDurableObjectAlarm(space(key))).toBe(false);
  });

  it("keeps a revocation its workspace did not answer, and delivers it on a later run",
      async () => {
    let { alice, bob, key, ids: [id] } = await leased(1);
    // The workspace's Overseer cannot be reached until the test says so.
    let reachable = false;
    let revoke = revocationsReaching(() => reachable);
    await space(key).removeMember(alice.profile.id, bob.profile.id);
    // A run that fails leaves the revocation queued and sets the next run for later.
    await vi.waitFor(async () => {
      expect(revoke).toHaveBeenCalled();
      expect(await alarm(key)).toBeGreaterThan(Date.now());
    }, WAIT);
    expect(await queue(key)).toEqual([`${id}:${bob.profile.id}`]);

    let failed = revoke.mock.calls.length;
    reachable = true;
    await vi.waitFor(async () => expect(await queue(key)).toEqual([]), WAIT);
    await vi.waitFor(async () => expect(await alarm(key)).toBeNull(), WAIT);
    expect(revoke).toHaveBeenCalledTimes(failed + 1);
  });

  it("attempts so many in a run, and in the next reaches one queued behind those that failed",
      async () => {
    let { alice, bob, key, ids } = await leased(17);
    // Queued in the order of their workspaces' ids. Only the last can be delivered, and no
    // workspace answers until the test has seen how many were asked at once.
    let last = ids.at(-1)!;
    let overseers = { answer: false };
    onTestFinished(() => { overseers.answer = true; });
    let revoke = revocationsReaching(async id => {
      while (!overseers.answer) await scheduler.wait(10);
      return id === last;
    });
    await space(key).removeMember(alice.profile.id, bob.profile.id);
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledTimes(REVOCATION_BATCH), WAIT);
    // Long enough for a seventeenth call of the same run to have arrived.
    await scheduler.wait(50);
    expect(revoke.mock.contexts.map(objectId).toSorted()).toEqual(ids.slice(0, REVOCATION_BATCH));
    overseers.answer = true;
    await vi.waitFor(async () => expect(await queue(key)).toHaveLength(REVOCATION_BATCH), WAIT);
    expect(await queue(key)).not.toContain(`${last}:${bob.profile.id}`);
  });

  it("delivers a new revocation at once, behind however many that keep failing", async () => {
    let { alice, bob, key, ids: [id] } = await leased(1);
    // A batch of revocations that have failed for long enough to wait their longest, the next
    // attempt an hour away, in a space whose memory holds nothing of them.
    let hour = Date.now() + 60 * 60_000;
    let failing = Array.from({ length: REVOCATION_BATCH }, workspaceId);
    await runInDurableObject(space(key), async (_instance, state) => {
      let storage = makeSpaceStorage(state.storage);
      for (let seq = 0; seq < REVOCATION_BATCH; seq++) {
        storage.revocations.put(
            { seq, workspace: failing[seq], profile: "gone", due: hour, retryMs: 5 * 60_000 });
      }
      storage.nextRevocation.put(REVOCATION_BATCH);
      await state.storage.setAlarm(hour);
    });
    let revoke = vi.spyOn(OverseerDurableObject.prototype, "revokeSpaceAccess");
    await space(key).removeMember(alice.profile.id, bob.profile.id);
    await vi.waitFor(async () => expect(await queue(key)).toHaveLength(REVOCATION_BATCH), WAIT);
    // The spy is on the Overseer of every workspace, and the alarm of a space that an earlier
    // test left revocations in can run during this one. Only this space's workspaces count.
    let queued = [...failing, id];
    expect(revoke.mock.contexts.map(objectId).filter(told => queued.includes(told))).toEqual([id]);
    // The alarm then waits for the others, none of which was attempted early.
    await vi.waitFor(async () => expect(await alarm(key)).toBe(hour), WAIT);
    expect(await queue(key)).not.toContain(`${id}:${bob.profile.id}`);
  });
});

describe("the owner's User DO, asked which role a space gives on a workspace", () => {
  it("asks no space about a workspace that none may list", async () => {
    let [alice, bob, dana] =
        await Promise.all([signUp("alice"), signUp("bob"), signUp("dana", false)]);
    // Bob would hold "build" on anything Alice's personal space listed.
    await space(alice.personal).setMemberRole(alice.profile.id, bob.profile.id, "build");
    let [provisional, shared, unknown, restricted, invitesOnly, danas] =
        Array.from({ length: 6 }, workspaceId);
    await alice.user.newGadget(provisional, "Untitled");
    // Someone else's, with the flags that would let a space list it were it Alice's own.
    await plant(alice, { id: shared, owner: bob.profile, role: "build", ...NEITHER });
    await plant(alice, { id: unknown });
    await plant(alice, { id: restricted, ...NEITHER, containsRestrictedData: true });
    await plant(alice, { id: invitesOnly, ...NEITHER, ownerInvitesOnly: true });
    // One that a space may list, of a user for whom no personal space was ever allocated.
    await plant(dana, { id: danas, ...NEITHER });

    let asked = vi.spyOn(SpaceDurableObject.prototype, "workspaceRole");
    for (let id of [provisional, shared, unknown, restricted, invitesOnly, workspaceId()]) {
      expect(await alice.user.workspaceRoleInSpace(id, bob.profile.id)).toBeNull();
    }
    expect(await dana.user.workspaceRoleInSpace(danas, bob.profile.id)).toBeNull();
    expect(asked).not.toHaveBeenCalled();
    expect(await runInDurableObject(dana.user, (_instance, state) =>
        makeUserStorage(state.storage).personalSpaceKey.get())).toBeNull();
  });

  it("asks the space its record points at, as the workspace's owner", async () => {
    let [alice, bob, mallory] = await Promise.all(["alice", "bob", "mallory"].map(n => signUp(n)));
    let key = await teamSpace(alice, [bob, "use"]);
    await space(alice.personal).setMemberRole(alice.profile.id, bob.profile.id, "build");
    let inTeam = await listedWorkspace(alice, key);
    let inPersonal = await listedWorkspace(alice);

    let asked = vi.spyOn(SpaceDurableObject.prototype, "workspaceRole");
    expect(await alice.user.workspaceRoleInSpace(inTeam, bob.profile.id)).toBe("use");
    expect(await alice.user.workspaceRoleInSpace(inPersonal, bob.profile.id)).toBe("build");
    expect(await alice.user.workspaceRoleInSpace(inTeam, mallory.profile.id)).toBeNull();
    expect(asked.mock.calls).toEqual([
      [inTeam, alice.profile.id, bob.profile.id], [inPersonal, alice.profile.id, bob.profile.id],
      [inTeam, alice.profile.id, mallory.profile.id],
    ]);
    expect(asked.mock.contexts.map(objectId)).toEqual(
        [key, alice.personal, key].map(name => env.TEST_SPACE.idFromName(name).toString()));

    // The record still points at the space, which no longer lists the workspace: no role.
    await space(key).detachWorkspace(inTeam, alice.profile.id);
    expect(await alice.user.workspaceRoleInSpace(inTeam, bob.profile.id)).toBeNull();
  });
});

describe("a workspace's Overseer", () => {
  it("opens for a member of its space in the role their membership gives, and for no one else",
      async () => {
    let { bob, carol, mallory, ws } = await team();
    await ws.run(async (_impl, instance) => {
      expect(await roleOf(await open(instance, bob))).toBe("build");
      let viewer = await open(instance, carol);
      expect(await roleOf(viewer)).toBe("use");
      await expect(viewer.listCollaborators()).rejects.toThrow("Unauthorized");
      await expect(open(instance, mallory)).rejects.toThrow(DENIED);
    });
  });

  it("takes a message for its agent from a member who builds, and from no other", async () => {
    let { bob, carol, mallory, ws } = await team();
    // What the call does next for a caller it has authorized, which is as far as this goes.
    vi.spyOn(UserDurableObject.prototype, "getExternalMessageChatContext")
        .mockRejectedValue(new Error("authorized"));
    await ws.run(async (_impl, instance) => {
      let send = (as: Account) => instance.receiveExternalMessage({
        callerEmail: as.profile.id, externalChatKey: "k", idempotencyKey: "i", prompt: "hello",
        chatGatewayRpcTarget: {} as any, title: "T",
      }).then(result => result.message, (error: Error) => error.message);
      expect(await send(bob)).toBe("authorized");
      for (let other of [carol, mallory]) expect(await send(other)).toBe(NO_AGENT);
    });
  });

  it("gives the higher of the two roles, and asks no space once its sharing gives build",
      async () => {
    let { alice, bob, carol, ws } = await team();
    let asked = lookups();
    await ws.run(async (impl, instance) => {
      share(impl, alice, carol, "build");
      share(impl, alice, bob, "use");
      expect(await roleOf(await open(instance, carol))).toBe("build");
      expect(asked).not.toHaveBeenCalled();
      expect(await roleOf(await open(instance, bob))).toBe("build");
      expect(asked).toHaveBeenCalledTimes(1);
    });
  });

  it("reads the role its sharing gives again once the space has answered", async () => {
    let { alice, mallory, ws } = await team();
    let { asked, hold } = heldLookups();
    await ws.run(async (impl, instance) => {
      // Mallory, who is in no space of Alice's, uses by the workspace's sharing, and is taken
      // off it while the space is asked: the role read before the lookup admits nobody.
      share(impl, alice, mallory, "use");
      let parked = opening(instance, mallory);
      await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1), WAIT);
      impl.storage.collaborators.delete(mallory.profile.id);
      hold.through = Infinity;
      expect(await parked).toBe(DENIED);
    });
  });

  it("takes a lookup that fails as no space role, which lowers no role its sharing gives",
      async () => {
    let { alice, bob, carol, ws } = await team();
    lookups().mockRejectedValue(new Error("user object unavailable"));
    await ws.run(async (impl, instance) => {
      share(impl, alice, carol, "use");
      expect(await roleOf(await open(instance, carol))).toBe("use");
      await expect(open(instance, bob)).rejects.toThrow(DENIED);
    });
  });

  it("gives no space role under either flag, and asks nobody", async () => {
    let { alice, bob, key } = await team();
    let asked = lookups();
    // Set on the Overseer alone: its owner's record and the space still say the member has one.
    for (let flag of ["containsRestrictedData", "ownerInvitesOnly"]) {
      let ws = await workspace(alice, key);
      await ws.run(async (impl, instance) => {
        impl.storage[flag].put(true);
        await expect(open(instance, bob)).rejects.toThrow(DENIED);
      });
    }
    expect(asked).not.toHaveBeenCalled();
  });

  it("trusts no lookup that the role was taken away under, and asks again only at an open",
      async () => {
    let { alice, bob, carol, mallory, key } = await team();
    let { asked, hold } = heldLookups();
    // What happens during each lookup of Bob's role in turn, which the space answers with
    // "build" every time: his role is revoked, the roles of others that the workspace gave
    // nobody are, or the workspace comes under a flag. Then what opening as him, or an
    // observation that excludes him, comes to, and how often the space was asked. The others'
    // revocations, of which a space sends one for every lease it holds on a workspace it stops
    // listing, overtake nothing. Once a flag is set, nobody is asked again.
    let overtaken: [string, string[], string | RegExp, number][] = [
      ["open", ["revoke"], "build", 2],
      ["open", ["revoke", "revoke"], DENIED, 2],
      ["open", ["others"], "build", 1],
      ["open", ["flag"], DENIED, 1],
      ["observe", ["revoke"], /could not be confirmed/, 1],
      ["observe", ["others"], /not permitted to see/, 1],
      ["observe", ["flag"], /could not be confirmed/, 1],
    ];
    for (let [act, overtakes, outcome, lookedUp] of overtaken) {
      let ws = await workspace(alice, key);
      asked.mockClear();
      hold.through = 0;
      await ws.run(async (impl, instance) => {
        let parked = act === "open"
            ? opening(instance, bob) : observing(excluding(impl, bob).observe());
        for (let [nth, overtake] of overtakes.entries()) {
          await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(nth + 1), WAIT);
          let revoked = overtake === "others" ? [carol, mallory] : overtake === "revoke" ? [bob] : [];
          for (let { profile } of revoked) await instance.revokeSpaceAccess(profile.id);
          if (overtake === "flag") await flagging(impl, "ownerInvitesOnly");
          hold.through = nth + 1;
        }
        hold.through = Infinity;
        expect(await parked).toMatch(outcome);
        expect(asked).toHaveBeenCalledTimes(lookedUp);
        for (let { value } of asked.mock.results) expect(await value).toBe("build");
      });
    }
  });

  it("restarts on the revocation of a role it gave, whatever is still open, and of no other",
      async () => {
    let { alice, bob, carol, ws } = await team();
    await ws.run(async (_impl, instance) => {
      await open(instance, alice);
      let session = await open(instance, bob);
      // Carol was given no role here: with Bob's session live, revoking hers ends nothing.
      await instance.revokeSpaceAccess(carol.profile.id);
      expect(ws.restarts).toEqual([]);
      // Bob closes his session, and may have kept anything it handed out to him.
      (session as unknown as Disposable)[Symbol.dispose]();
      await instance.revokeSpaceAccess(bob.profile.id);
      expect(ws.restarts).toEqual([REVOKED]);
      // Told again, the workspace has nothing of his left to end.
      await instance.revokeSpaceAccess(bob.profile.id);
      expect(ws.restarts).toEqual([REVOKED]);
    });
  });

  it("verifies a member as an observer for the higher of their two roles", async () => {
    let { alice, bob, carol, ws } = await team();
    await ws.run(async (impl, instance) => {
      // A connection that no gadget binds: whoever builds has to be verified against it, which
      // an open with no way to choose an account cannot be, and whoever only uses does not.
      excluding(impl);
      expect(await opening(instance, carol)).toBe("use");
      expect(await opening(instance, bob)).toMatch(/must choose connected accounts/);
      // Nor as a collaborator who uses: he builds as a member, and is verified for that.
      share(impl, alice, bob, "use");
      expect(await opening(instance, bob)).toMatch(/must choose connected accounts/);
    });
  });

  it("keeps the observer record of a removed collaborator whom the space still gives a role",
      async () => {
    let { alice, bob, mallory, ws } = await team();
    await ws.run(async (impl, instance) => {
      let { removals, observerIds } = excluding(impl, bob, mallory);
      for (let collaborator of [bob, mallory]) share(impl, alice, collaborator, "use");
      let owner = await open(instance, alice);
      expect(await owner.removeCollaborator(bob.profile.id, [])).toMatchObject(lostAccess(bob));
      expect(impl.storage.observers.get(bob.profile.id)).toBeDefined();
      // Nor is the record of someone whose space role could not be asked for torn down.
      lookups().mockRejectedValueOnce(new Error("user object unavailable"));
      expect(await owner.removeCollaborator(mallory.profile.id, []))
          .toMatchObject(lostAccess(mallory));
      expect(impl.storage.observers.get(mallory.profile.id)).toBeDefined();
      expect(removals).toEqual([]);

      // Mallory is in no space of Alice's: once that can be learned, nothing is left to her.
      await impl.tearDownLostObservers(lostAccess(mallory));
      expect(impl.storage.observers.get(mallory.profile.id)).toBeUndefined();
      expect(removals).toEqual([`1:${observerIds[1]}`]);
    });
  });

  it("is restarted by its space when it leaves the listing, or a member with a session open "
      + "is lowered or removed", async () => {
    let { alice, bob, key } = await team();
    // What ends the role Bob opened the workspace with, and what opening it again comes to.
    let changes: [(id: string) => Promise<unknown>, string][] = [
      [id => alice.user.setGadgetSpace(id, null, NEITHER), DENIED],
      [() => space(key).setMemberRole(alice.profile.id, bob.profile.id, "use"), "use"],
      [() => space(key).removeMember(alice.profile.id, bob.profile.id), DENIED],
    ];
    for (let [change, reopened] of changes) {
      let ws = await workspace(alice, key);
      await ws.run((_impl, instance) => open(instance, bob));
      await change(ws.id);
      await vi.waitFor(() => expect(ws.restarts).toEqual([REVOKED]), WAIT);
      await ws.run(async (_impl, instance) => expect(await opening(instance, bob)).toBe(reopened));
    }
  });

  it("ends every space role when an observation first sets a flag, once the flag is stored",
      async () => {
    let { alice, bob, mallory, key, ws } = await team();
    let asked = lookups();
    for (let flag of ["containsRestrictedData", "ownerInvitesOnly"]) {
      let flagged = await workspace(alice, key);
      await flagged.run(async (impl, instance) => {
        await open(instance, bob);
        let stored: unknown[] = [];
        impl.scheduleAccessRestart = async (reason: string) => {
          stored.push([reason, impl.storage[flag].get()]);
        };
        await flagging(impl, flag);
        expect(stored).toEqual([[FLAGGED, true]]);
        asked.mockClear();
        await expect(open(instance, bob)).rejects.toThrow(DENIED);
        expect(asked).not.toHaveBeenCalled();
      });
    }
    // A workspace that nobody has a space role on keeps its collaborators' sessions.
    await ws.run(async (impl, instance) => {
      share(impl, alice, mallory, "use");
      await open(instance, mallory);
      await flagging(impl, "containsRestrictedData");
      expect(ws.restarts).toEqual([]);
    });
  });

  it("forgets the space roles it remembers when a flag is set, with no session counted live",
      async () => {
    let { bob, ws } = await team();
    await ws.run(async impl => {
      // Bob's role is remembered from an observation that excluded him, which it blocked.
      let { observe, removals, observerIds } = excluding(impl, bob);
      await expect(observe()).rejects.toThrow(/not permitted to see/);
      await flagging(impl, "containsRestrictedData");
      expect(ws.restarts).toEqual([FLAGGED]);
      // Under the flag he has no role left, so the same observation is admitted.
      await observe();
      expect(removals).toEqual(observerIds.map(id => `1:${id}`));
      expect(impl.storage.observers.get(bob.profile.id)).toBeUndefined();
    });
  });

  it("blocks an observation that excludes an observer who reaches it through the space",
      async () => {
    let { alice, bob, key, ws } = await team();
    let asked = lookups();
    await ws.run(async impl => {
      let { observe, removals } = excluding(impl, bob);
      await expect(observe()).rejects.toThrow(/not permitted to see/);
      // The role is remembered: the next observation asks nobody.
      await expect(observe()).rejects.toThrow(/not permitted to see/);
      expect(asked).toHaveBeenCalledTimes(1);
      expect(removals).toEqual([]);
      expect(impl.storage.observers.get(bob.profile.id)).toBeDefined();
    });

    // Removed from the space, and the revocation delivered, Bob has no role left: the
    // observation is admitted and he is no longer set up to observe.
    await space(key).removeMember(alice.profile.id, bob.profile.id);
    await vi.waitFor(async () => expect(await queue(key)).toEqual([]), WAIT);
    await ws.run(async impl => {
      let { observe, removals, observerIds } = excluding(impl, bob);
      await observe();
      expect(removals).toEqual(observerIds.map(id => `1:${id}`));
      expect(impl.storage.observers.get(bob.profile.id)).toBeUndefined();
    });
  });

  it("counts an excluded observer at the higher of their two roles", async () => {
    let { alice, bob, carol, key, ws } = await team();
    await ws.run(async impl => {
      // A member who uses does not reach a connection that no gadget binds: the observation is
      // admitted, and she stays an observer of everything else.
      let { observe, removals, observerIds } = excluding(impl, carol);
      await observe();
      expect(removals).toEqual(observerIds.map(id => `1:${id}`));
      expect(impl.storage.observers.get(carol.profile.id)).toBeDefined();
      // A collaborator who uses and builds as a member does.
      share(impl, alice, bob, "use");
      await expect(excluding(impl, bob).observe()).rejects.toThrow(/not permitted to see/);
    });

    // Raised to build in the space, which tells the workspace nothing, Carol reaches it too: the
    // "use" remembered of her is asked for again.
    await space(key).setMemberRole(alice.profile.id, carol.profile.id, "build");
    await ws.run(async impl => {
      await expect(excluding(impl, carol).observe()).rejects.toThrow(/not permitted to see/);
    });
  });

  it("counts a member at the role they were lowered from until the space's revocation arrives",
      async () => {
    let { alice, bob, key, ws } = await team();
    revocationsReaching(() => false);
    await ws.run(async (impl, instance) => {
      // Bob's session builds, and outlives his being lowered for as long as the workspace is
      // not told: a later answer of "use" must not lower what is remembered of him.
      expect(await opening(instance, bob)).toBe("build");
      await space(key).setMemberRole(alice.profile.id, bob.profile.id, "use");
      expect(await opening(instance, bob)).toBe("use");
      await expect(excluding(impl, bob).observe()).rejects.toThrow(/not permitted to see/);
    });
  });

  it("blocks an observation whose excluded observer loses a sharing role while the space is asked",
      async () => {
    let { alice, bob, carol, ws } = await team();
    let { asked, hold } = heldLookups();
    await ws.run(async impl => {
      // Bob builds by the workspace's sharing, so only Carol's role is asked for at first.
      share(impl, alice, bob, "build");
      let { observe, removals } = excluding(impl, bob, carol);
      let parked = observing(observe());
      await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1), WAIT);
      // While it is, Bob is left with the role his membership gives him, which nobody asked for.
      impl.storage.collaborators.delete(bob.profile.id);
      hold.through = Infinity;
      expect(await parked).toMatch(/not permitted to see/);
      expect(asked.mock.calls.map(([, profileId]) => profileId))
          .toEqual([carol.profile.id, bob.profile.id]);
      expect(removals).toEqual([]);
      expect(impl.storage.observers.get(bob.profile.id)).toBeDefined();
    });
  });

  it("blocks an observation when the role of an observer it excludes cannot be looked up",
      async () => {
    let { bob, ws } = await team();
    lookups().mockRejectedValue(new Error("user object unavailable"));
    await ws.run(async impl => {
      let { observe, removals } = excluding(impl, bob);
      await expect(observe()).rejects.toThrow(/could not be confirmed/);
      expect(removals).toEqual([]);
      expect(impl.storage.observers.get(bob.profile.id)).toBeDefined();
      expect([...impl.storage.actions.list()]).toEqual([]);
    });
  });

  it("gives a member no power to share beyond what its sharing gives them", async () => {
    let { alice, bob, mallory, ws } = await team();
    await ws.run(async (impl, instance) => {
      let member = await open(instance, bob);
      expect(await roleOf(member)).toBe("build");
      await expect(member.addCollaborator(mallory.profile.id, "use")).rejects.toThrow(NO_SHARING);
      await expect(member.createShareLink("use")).rejects.toThrow(NO_SHARING);
      expect(await member.listCollaborators()).toEqual([]);
      await expect(member.moveToSpace(null)).rejects.toThrow("Only the workspace owner can move");
      await expect(member.deleteSelf()).rejects.toThrow("Only the workspace owner can delete");

      // A collaborator at "use" who builds as a member grants "use" and no more.
      share(impl, alice, bob, "use");
      let both = await open(instance, bob);
      expect(await roleOf(both)).toBe("build");
      await expect(both.addCollaborator(mallory.profile.id, "build")).rejects.toThrow(ABOVE_OWN_ROLE);
      await expect(both.createShareLink("build")).rejects.toThrow(ABOVE_OWN_ROLE);
      expect(await both.addCollaborator(mallory.profile.id, "use")).toMatchObject({ role: "use" });
    });
  });

  it("records the workspace as shared with a collaborator, not with a member who is none",
      async () => {
    let { alice, bob, carol, ws } = await team();
    await ws.run(async (impl, instance) => {
      share(impl, alice, carol, "use");
      await open(instance, bob);
      await open(instance, carol);
    });
    await vi.waitFor(async () => expect(await carol.user.getGadget(ws.id))
        .toMatchObject({ owner: alice.profile, role: "use" }), WAIT);
    expect(await bob.user.getGadget(ws.id)).toBeNull();
  });

  it("records the workspace in the role its sharing gives a collaborator, whatever they open it in",
      async () => {
    let { alice, bob, ws } = await team();
    await ws.run(async (impl, instance) => {
      share(impl, alice, bob, "use");
      expect(await opening(instance, bob)).toBe("build");
    });
    await vi.waitFor(async () => expect(await bob.user.getGadget(ws.id))
        .toMatchObject({ owner: alice.profile, role: "use" }), WAIT);
  });
});
