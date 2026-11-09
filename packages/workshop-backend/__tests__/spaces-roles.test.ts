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
import { SpaceDurableObject, SpaceModel, spaceById } from "../src/spaces.js";
import { makeSpaceStorage, type SpaceLease } from "../src/storage-schema/space-storage.js";
import { makeUserStorage, type GadgetRecord } from "../src/storage-schema/user-storage.js";
import { UserDurableObject } from "../src/user.js";
import { makeMockStorage } from "./mock-storage.js";
// Load the whole backend up front, so that its slow load is not billed to the first test.
import "./test-worker.js";

// `impl` with connection 1, which the observations here are made through, on record: the ledger
// refuses an observation through a connection the workspace does not hold.
function connected(impl: any): any {
  if (!impl.storage.gatekeepers.get(1)) {
    impl.storage.gatekeepers.put({ id: 1, resourceTitle: "Connection 1", class: {} });
  }
  return impl;
}

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
type Member = [Account, SpaceMemberRole];

const DENIED = "You don't have access to this workspace.";
const NO_SHARING = "You do not have permission to share this workspace.";
const NO_AGENT = "You do not have access to interact with this workspace through its agent.";
const REVOKED = "Gadget restarted because a member's access through its space changed.";
const NARROWED = "Gadget restarted to revoke access for people the owner did not add directly.";
const DELETED = "Gadget restarted because the workspace was deleted.";
// Shorter than the test timeout, so that a wait which runs out fails with its own assertion.
const WAIT = { timeout: 4_000 };
const DAY = new Date("2026-01-01");
// The revocations one run of a space's alarm attempts.
const REVOCATION_BATCH = 16;
const unique = () => crypto.randomUUID().slice(0, 8);
const pair = (lease: SpaceLease) => `${lease.workspace}:${lease.profile}`;
const space = (id: string) => spaceById(env.TEST_SPACE, id);
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
  let personal = env.TEST_SPACE.idFromName(id).toString();
  return { profile, user, userId: user.id.toString(), personal };
}

// A team space, created by `admin`.
async function teamSpace(admin: Account, ...members: Member[]): Promise<string> {
  let spaceId = env.TEST_SPACE.newUniqueId().toString();
  expect(await space(spaceId).create({ name: "Team", kind: "team" }, admin.profile)).toBe(true);
  for (let [{ profile }, role] of members) {
    await space(spaceId).setMemberRole(admin.profile.id, profile.id, role);
  }
  return spaceId;
}

// Writes one of the owner's records of a workspace: active unless `record` says otherwise.
function plant(owner: Account, record: Partial<GadgetRecord> & { id: string }): Promise<void> {
  return runInDurableObject(owner.user, (_instance, state) => makeUserStorage(state.storage)
      .gadgets.put({ title: "Untitled", created: DAY, lastActive: DAY, ...record }));
}

// A workspace of `owner`'s that team space `spaceId`, or with none their personal space, lists.
// Deleting a workspace the owner has no record of waits out the sync that lists this one.
async function listedWorkspace(owner: Account, spaceId?: string, id = workspaceId()) {
  await owner.user.newWorkspace(id, "Untitled", spaceId);
  await owner.user.setWorkspaceLastActive(id, DAY, undefined);
  await owner.user.deleteWorkspace("ws-none");
  return id;
}

// The revocations a space has queued, oldest first, and when its alarm is set for.
const queue = (spaceId: string) => runInDurableObject(space(spaceId), (_instance, state) =>
    [...makeSpaceStorage(state.storage).revocations.list()].map(pair));
const alarm = (spaceId: string) =>
    runInDurableObject(space(spaceId), (_instance, state) => state.storage.getAlarm());

// A real, listed workspace of `owner`'s. `run` acts inside its Overseer, on its OverseerImpl,
// with the owner planted rather than established by a first open; the restarts it schedules are
// recorded in `restarts` instead of taking the object from under the test.
async function workspace(owner: Account, spaceId?: string) {
  let stub = env.TEST_OVERSEER.get(env.TEST_OVERSEER.newUniqueId());
  let id = await listedWorkspace(owner, spaceId, stub.id.toString());
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
  let spaceId = await teamSpace(alice, [bob, "build"], [carol, "use"]);
  return { alice, bob, carol, mallory, spaceId, ws: await workspace(alice, spaceId) };
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

// The owner adds `to` to the workspace's own sharing: to build, or to use gadget `gadgetId`, or
// with none every gadget, which is what a stored grant that names no gadget means.
function share(impl: any, owner: Account, to: Account, role: CollaboratorRole,
               gadgetId?: number): void {
  impl.storage.collaborators.put({
    profile: to.profile,
    addedBy: [{ type: "user", sharer: owner.profile.id, created: DAY, role,
                ...(gadgetId === undefined ? {} : { gadgetId }) }],
  });
}

// A permanent gadget of the workspace, binding each name in `bindings` to a connection.
function gadget(impl: any, id: number, bindings: Record<string, number> = {}): void {
  impl.storage.gadgets.put({
    type: "gadget", id, title: `Gadget ${id}`, created: DAY, bindingName: `G${id}`,
    bindings: Object.fromEntries(
        Object.entries(bindings).map(([name, target]) => [name, { target }])),
  });
}

// What the workspace's sharing reports of a collaborator who used it and was removed.
const lostAccess = (of: Account) =>
    [{ profile: of.profile, oldAccess: { role: "use", gadgetIds: "all" }, newAccess: null }];

// Every lookup an Overseer makes of a space role, which goes to its owner's User DO.
const lookups = () => vi.spyOn(UserDurableObject.prototype, "workspaceRoleInSpace");

// An observation that states `flag` of the workspace: that it holds restricted data, or that it
// is owner-invites-only.
const flagging = (impl: any, flag: string): Promise<void> => connected(impl).authorizeObservation(
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
  let observe = (): Promise<void> => connected(impl).authorizeObservation(1, {
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
    let model = new SpaceModel(storage, "eng");
    model.create({ name: "Engineering", kind: "team" }, ALICE);
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
      let retrying = new SpaceModel(storage, "eng");
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
  let spaceId = await teamSpace(alice, [bob, "build"]);
  let ids = Array.from({ length: workspaces }, workspaceId).toSorted();
  await space(spaceId).attachWorkspaces(
      alice.profile, ids.map(id => ({ id, title: "Untitled", created: DAY })));
  for (let id of ids) {
    expect(await space(spaceId).workspaceRole(id, alice.profile.id, bob.profile.id)).toBe("build");
  }
  return { alice, bob, spaceId, ids };
}

describe("a space's alarm", () => {
  it("tells each workspace of a revocation, and is not set again once none is queued",
      async () => {
    let { alice, bob, spaceId, ids } = await leased(2);
    let revoke = vi.spyOn(OverseerDurableObject.prototype, "revokeSpaceAccess");
    await space(spaceId).removeMember(alice.profile.id, bob.profile.id);
    await vi.waitFor(async () => expect(await queue(spaceId)).toEqual([]), WAIT);
    expect(revoke.mock.calls).toEqual([[bob.profile.id], [bob.profile.id]]);
    expect(revoke.mock.contexts.map(objectId).toSorted()).toEqual(ids);
    await vi.waitFor(async () => expect(await alarm(spaceId)).toBeNull(), WAIT);
    expect(await runDurableObjectAlarm(space(spaceId))).toBe(false);
  });

  it("keeps a revocation its workspace did not answer, and delivers it on a later run",
      async () => {
    let { alice, bob, spaceId, ids: [id] } = await leased(1);
    // The workspace's Overseer cannot be reached until the test says so.
    let reachable = false;
    let revoke = revocationsReaching(() => reachable);
    await space(spaceId).removeMember(alice.profile.id, bob.profile.id);
    // A run that fails leaves the revocation queued and sets the next run for later.
    await vi.waitFor(async () => {
      expect(revoke).toHaveBeenCalled();
      expect(await alarm(spaceId)).toBeGreaterThan(Date.now());
    }, WAIT);
    expect(await queue(spaceId)).toEqual([`${id}:${bob.profile.id}`]);

    let failed = revoke.mock.calls.length;
    reachable = true;
    await vi.waitFor(async () => expect(await queue(spaceId)).toEqual([]), WAIT);
    await vi.waitFor(async () => expect(await alarm(spaceId)).toBeNull(), WAIT);
    expect(revoke).toHaveBeenCalledTimes(failed + 1);
  });

  it("attempts so many in a run, and in the next reaches one queued behind those that failed",
      async () => {
    let { alice, bob, spaceId, ids } = await leased(17);
    // Queued in the order of their workspaces' ids. Only the last can be delivered, and no
    // workspace answers until the test has seen how many were asked at once.
    let last = ids.at(-1)!;
    let overseers = { answer: false };
    onTestFinished(() => { overseers.answer = true; });
    let revoke = revocationsReaching(async id => {
      while (!overseers.answer) await scheduler.wait(10);
      return id === last;
    });
    await space(spaceId).removeMember(alice.profile.id, bob.profile.id);
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledTimes(REVOCATION_BATCH), WAIT);
    // Long enough for a seventeenth call of the same run to have arrived.
    await scheduler.wait(50);
    expect(revoke.mock.contexts.map(objectId).toSorted()).toEqual(ids.slice(0, REVOCATION_BATCH));
    overseers.answer = true;
    await vi.waitFor(async () => expect(await queue(spaceId)).toHaveLength(REVOCATION_BATCH), WAIT);
    expect(await queue(spaceId)).not.toContain(`${last}:${bob.profile.id}`);
  });

  it("delivers a new revocation at once, behind however many that keep failing", async () => {
    let { alice, bob, spaceId, ids: [id] } = await leased(1);
    // A batch of revocations that have failed for long enough to wait their longest, the next
    // attempt an hour away, in a space whose memory holds nothing of them.
    let hour = Date.now() + 60 * 60_000;
    let failing = Array.from({ length: REVOCATION_BATCH }, workspaceId);
    await runInDurableObject(space(spaceId), async (_instance, state) => {
      let storage = makeSpaceStorage(state.storage);
      for (let seq = 0; seq < REVOCATION_BATCH; seq++) {
        storage.revocations.put(
            { seq, workspace: failing[seq], profile: "gone", due: hour, retryMs: 5 * 60_000 });
      }
      storage.nextRevocation.put(REVOCATION_BATCH);
      await state.storage.setAlarm(hour);
    });
    let revoke = vi.spyOn(OverseerDurableObject.prototype, "revokeSpaceAccess");
    await space(spaceId).removeMember(alice.profile.id, bob.profile.id);
    await vi.waitFor(async () => expect(await queue(spaceId)).toHaveLength(REVOCATION_BATCH), WAIT);
    // The spy is on the Overseer of every workspace, and the alarm of a space that an earlier
    // test left revocations in can run during this one. Only this space's workspaces count.
    let queued = [...failing, id];
    expect(revoke.mock.contexts.map(objectId).filter(told => queued.includes(told))).toEqual([id]);
    // The alarm then waits for the others, none of which was attempted early.
    await vi.waitFor(async () => expect(await alarm(spaceId)).toBe(hour), WAIT);
    expect(await queue(spaceId)).not.toContain(`${id}:${bob.profile.id}`);
  });
});

describe("the owner's User DO, asked which role a space gives on a workspace", () => {
  it("asks no space about a workspace that is provisional, shared with the user or unknown to them",
      async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    // Bob would hold "build" on anything this team space of Alice's listed.
    let spaceId = await teamSpace(alice, [bob, "build"]);
    let [provisional, shared] = Array.from({ length: 2 }, workspaceId);
    await alice.user.newWorkspace(provisional, "Untitled", spaceId);
    await plant(alice, { id: shared, owner: bob.profile, role: "build", spaceId });

    let asked = vi.spyOn(SpaceDurableObject.prototype, "workspaceRole");
    for (let id of [provisional, shared, workspaceId()]) {
      expect(await alice.user.workspaceRoleInSpace(id, bob.profile.id)).toBeNull();
    }
    expect(asked).not.toHaveBeenCalled();
  });

  it("asks the team space its record points at, as the owner, and no space for a personal one",
      async () => {
    let [alice, bob, mallory, dana] = await Promise.all(
        [signUp("alice"), signUp("bob"), signUp("mallory"), signUp("dana", false)]);
    let spaceId = await teamSpace(alice, [bob, "use"]);
    let inTeam = await listedWorkspace(alice, spaceId);
    let inPersonal = await listedWorkspace(alice);
    // One of a user whose personal space was never created.
    let danas = workspaceId();
    await plant(dana, { id: danas });

    let asked = vi.spyOn(SpaceDurableObject.prototype, "workspaceRole");
    expect(await alice.user.workspaceRoleInSpace(inTeam, bob.profile.id)).toBe("use");
    expect(await alice.user.workspaceRoleInSpace(inPersonal, bob.profile.id)).toBeNull();
    expect(await alice.user.workspaceRoleInSpace(inTeam, mallory.profile.id)).toBeNull();
    expect(await dana.user.workspaceRoleInSpace(danas, bob.profile.id)).toBeNull();
    expect(asked.mock.calls).toEqual([
      [inTeam, alice.profile.id, bob.profile.id], [inTeam, alice.profile.id, mallory.profile.id],
    ]);
    expect(asked.mock.contexts.map(objectId)).toEqual([spaceId, spaceId]);
    expect(await spaceById(env.TEST_SPACE, dana.personal).open(dana.profile.id)).toBeNull();

    // The record still points at the space, which no longer lists the workspace: no role.
    await space(spaceId).detachWorkspace(inTeam, alice.profile.id);
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

  it("gives a member their role whichever flag is set, asking the space as for any workspace",
      async () => {
    let { alice, bob, carol, mallory, spaceId } = await team();
    let asked = lookups();
    for (let flag of ["containsRestrictedData", "ownerInvitesOnly"]) {
      let ws = await workspace(alice, spaceId);
      asked.mockClear();
      await ws.run(async (impl, instance) => {
        impl.storage[flag].put(true);
        expect(await opening(instance, bob)).toBe("build");
        expect(await opening(instance, carol)).toBe("use");
        expect(await opening(instance, mallory)).toBe(DENIED);
      });
      expect(asked).toHaveBeenCalledTimes(3);
    }
  });

  it("trusts no lookup that the role was taken away under, and asks again only at an open",
      async () => {
    let { alice, bob, carol, mallory, spaceId } = await team();
    let { asked, hold } = heldLookups();
    // What happens during each lookup of Bob's role in turn, which the space answers with
    // "build" every time: his role is revoked, the roles of others that the workspace gave
    // nobody are, or an observation sets the flag named. Then what opening as him, or an
    // observation that excludes him, comes to, and how often the space was asked. The others'
    // revocations, of which a space sends one for every lease it holds on a workspace it stops
    // listing, overtake nothing, and neither does either flag, which takes no role away: Bob
    // still builds, and so has to be verified against the connection the flag's observation was
    // made through.
    let overtaken: [string, string[], string | RegExp, number][] = [
      ["open", ["revoke"], "build", 2],
      ["open", ["revoke", "revoke"], DENIED, 2],
      ["open", ["others"], "build", 1],
      ["open", ["containsRestrictedData"], /must choose connected accounts/, 1],
      ["open", ["ownerInvitesOnly"], /must choose connected accounts/, 1],
      ["observe", ["revoke"], /could not be confirmed/, 1],
      ["observe", ["others"], /not permitted to see/, 1],
      ["observe", ["containsRestrictedData"], /not permitted to see/, 1],
      ["observe", ["ownerInvitesOnly"], /not permitted to see/, 1],
    ];
    for (let [act, overtakes, outcome, lookedUp] of overtaken) {
      let ws = await workspace(alice, spaceId);
      asked.mockClear();
      hold.through = 0;
      await ws.run(async (impl, instance) => {
        let parked = act === "open"
            ? opening(instance, bob) : observing(excluding(impl, bob).observe());
        for (let [nth, overtake] of overtakes.entries()) {
          await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(nth + 1), WAIT);
          let revoked = overtake === "others" ? [carol, mallory] : overtake === "revoke" ? [bob] : [];
          for (let { profile } of revoked) await instance.revokeSpaceAccess(profile.id);
          if (overtake !== "others" && overtake !== "revoke") {
            if (act === "open") excluding(impl);
            await flagging(impl, overtake);
          }
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
    let asked = lookups();
    await ws.run(async (impl, instance) => {
      let { removals, observerIds } = excluding(impl, bob, mallory);
      for (let collaborator of [bob, mallory]) share(impl, alice, collaborator, "use");
      let owner = await open(instance, alice);
      // The removal tears down behind its answer, so the same decision is also made here, where
      // it can be awaited: each asks the space about Bob.
      expect(await owner.removeCollaborator(bob.profile.id, [])).toMatchObject(lostAccess(bob));
      await impl.tearDownLostObservers(lostAccess(bob));
      await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(2), WAIT);
      expect(impl.storage.observers.get(bob.profile.id)).toBeDefined();
      // Nor is the record of someone whose space role could not be asked for torn down.
      impl.storage.collaborators.delete(mallory.profile.id);
      asked.mockRejectedValueOnce(new Error("user object unavailable"));
      await impl.tearDownLostObservers(lostAccess(mallory));
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
    let { alice, bob, spaceId } = await team();
    // What ends the role Bob opened the workspace with, and what opening it again comes to.
    let changes: [(id: string) => Promise<unknown>, string][] = [
      [id => alice.user.setWorkspaceSpace(id, null), DENIED],
      [() => space(spaceId).setMemberRole(alice.profile.id, bob.profile.id, "use"), "use"],
      [() => space(spaceId).removeMember(alice.profile.id, bob.profile.id), DENIED],
    ];
    for (let [change, reopened] of changes) {
      let ws = await workspace(alice, spaceId);
      await ws.run((_impl, instance) => open(instance, bob));
      await change(ws.id);
      await vi.waitFor(() => expect(ws.restarts).toEqual([REVOKED]), WAIT);
      await ws.run(async (_impl, instance) => expect(await opening(instance, bob)).toBe(reopened));
    }
  });

  it("keeps the roles its space gives when an observation first sets a flag, and restarts nothing",
      async () => {
    let { alice, bob, carol, spaceId } = await team();
    let asked = lookups();
    for (let flag of ["containsRestrictedData", "ownerInvitesOnly"]) {
      let ws = await workspace(alice, spaceId);
      await ws.run(async (impl, instance) => {
        await open(instance, bob);
        await open(instance, carol);
        // The connection the observation is made through, which nobody has been verified against.
        excluding(impl);
        await flagging(impl, flag);
        expect(impl.storage[flag].get()).toBe(true);
        expect(ws.restarts).toEqual([]);
        // Each role is still remembered as given, so its space can take each back.
        await instance.revokeSpaceAccess(carol.profile.id);
        expect(ws.restarts).toEqual([REVOKED]);
        await instance.revokeSpaceAccess(bob.profile.id);
        expect(ws.restarts).toEqual([REVOKED, REVOKED]);
        // The space, where nothing changed, is asked again at the next open and answers as
        // before: Carol uses, and Bob builds, for which he is verified against that connection.
        asked.mockClear();
        expect(await opening(instance, carol)).toBe("use");
        expect(await opening(instance, bob)).toMatch(/must choose connected accounts/);
        expect(asked).toHaveBeenCalledTimes(2);
      });
    }
  });

  it("restarts when owner-invites-only narrows its sharing, and reopens for whoever is a member",
      async () => {
    let { alice, bob, carol, mallory, ws } = await team();
    await ws.run(async (impl, instance) => {
      // Bob builds by the owner's grant, and added Carol and Mallory, which the flag undoes.
      share(impl, alice, bob, "build");
      for (let to of [carol, mallory]) share(impl, bob, to, "use");
      let { removals, observerIds } = excluding(impl, carol, mallory);
      expect(await opening(instance, mallory)).toBe("use");
      await flagging(impl, "ownerInvitesOnly");
      expect(ws.restarts).toEqual([NARROWED]);
      // Carol is a member of the space, which still gives her a role: she opens, and stays set
      // up to observe. Mallory reached the workspace through Bob alone.
      expect(await opening(instance, carol)).toBe("use");
      expect(await opening(instance, mallory)).toBe(DENIED);
      await vi.waitFor(() => expect(removals).toEqual([`1:${observerIds[1]}`]), WAIT);
      expect(impl.storage.observers.get(carol.profile.id)).toBeDefined();
      expect(impl.storage.observers.get(mallory.profile.id)).toBeUndefined();
    });
  });

  it("verifies a member under either flag as it verifies a collaborator with that access",
      async () => {
    let { alice, bob, carol, mallory, spaceId } = await team();
    for (let flag of ["containsRestrictedData", "ownerInvitesOnly"]) {
      let ws = await workspace(alice, spaceId);
      await ws.run(async (impl, instance) => {
        // The observation that sets the flag is made through the workspace's one connection,
        // which gadget 100 binds. Whoever reaches it has to be verified against it, which an
        // open with no way to choose an account cannot be.
        excluding(impl);
        gadget(impl, 100, { THING: 1 });
        await flagging(impl, flag);
        expect(await opening(instance, bob)).toMatch(/must choose connected accounts/);
        let viewer = await open(instance, carol);
        expect(await roleOf(viewer)).toBe("use");
        await expect(viewer.getGadget(100)).rejects.toThrow(/must choose connected accounts/);
        // A collaborator the owner added to build is turned away with the same words.
        share(impl, alice, mallory, "build");
        expect(await opening(instance, mallory)).toMatch(/must choose connected accounts/);
        expect(ws.restarts).toEqual([]);
      });
    }
  });

  it("counts a member among the observers an observation excludes, under either flag",
      async () => {
    let { alice, bob, spaceId, ws } = await team();
    let asked = lookups();
    await ws.run(async impl => {
      // Bob's role is remembered from an observation that excluded him, which it blocked, and
      // a flag set afterwards forgets nothing: the next one is blocked with no space asked.
      let { observe, removals } = excluding(impl, bob);
      await expect(observe()).rejects.toThrow(/not permitted to see/);
      await flagging(impl, "containsRestrictedData");
      expect(ws.restarts).toEqual([]);
      await expect(observe()).rejects.toThrow(/not permitted to see/);
      expect(asked).toHaveBeenCalledTimes(1);
      expect(removals).toEqual([]);
      expect(impl.storage.observers.get(bob.profile.id)).toBeDefined();
    });
    // With a flag set before anything is remembered of him, the space is asked about him.
    for (let flag of ["containsRestrictedData", "ownerInvitesOnly"]) {
      let flagged = await workspace(alice, spaceId);
      asked.mockClear();
      await flagged.run(async impl => {
        impl.storage[flag].put(true);
        await expect(excluding(impl, bob).observe()).rejects.toThrow(/not permitted to see/);
        expect(impl.storage.observers.get(bob.profile.id)).toBeDefined();
      });
      expect(asked).toHaveBeenCalledTimes(1);
    }
  });

  it("blocks an observation that excludes an observer who reaches it through the space",
      async () => {
    let { alice, bob, spaceId, ws } = await team();
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
    await space(spaceId).removeMember(alice.profile.id, bob.profile.id);
    await vi.waitFor(async () => expect(await queue(spaceId)).toEqual([]), WAIT);
    await ws.run(async impl => {
      let { observe, removals, observerIds } = excluding(impl, bob);
      await observe();
      expect(removals).toEqual(observerIds.map(id => `1:${id}`));
      expect(impl.storage.observers.get(bob.profile.id)).toBeUndefined();
    });
  });

  it("counts an excluded observer at the higher of their two roles", async () => {
    let { alice, bob, carol, spaceId, ws } = await team();
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
    await space(spaceId).setMemberRole(alice.profile.id, carol.profile.id, "build");
    await ws.run(async impl => {
      await expect(excluding(impl, carol).observe()).rejects.toThrow(/not permitted to see/);
    });
  });

  it("counts a member at the role they were lowered from until the space's revocation arrives",
      async () => {
    let { alice, bob, spaceId, ws } = await team();
    revocationsReaching(() => false);
    await ws.run(async (impl, instance) => {
      // Bob's session builds, and outlives his being lowered for as long as the workspace is
      // not told: a later answer of "use" must not lower what is remembered of him.
      expect(await opening(instance, bob)).toBe("build");
      await space(spaceId).setMemberRole(alice.profile.id, bob.profile.id, "use");
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
      gadget(impl, 100);
      let member = await open(instance, bob);
      expect(await roleOf(member)).toBe("build");
      await expect(member.addCollaborator(mallory.profile.id, "workspace"))
          .rejects.toThrow(NO_SHARING);
      await expect(member.addCollaborator(mallory.profile.id, { gadgetId: 100 }))
          .rejects.toThrow(NO_SHARING);
      await expect(member.createShareLink("workspace")).rejects.toThrow(NO_SHARING);
      await expect(member.createShareLink({ gadgetId: 100 })).rejects.toThrow(NO_SHARING);
      expect(await member.listCollaborators()).toEqual([]);
      await expect(member.moveToSpace(null)).rejects.toThrow("Only the workspace owner can move");
      await expect(member.deleteSelf()).rejects.toThrow("Only the workspace owner can delete");

      // A collaborator who uses and builds as a member still grants nothing: only "build" from
      // the workspace's own sharing does.
      share(impl, alice, bob, "use");
      let both = await open(instance, bob);
      expect(await roleOf(both)).toBe("build");
      await expect(both.addCollaborator(mallory.profile.id, "workspace"))
          .rejects.toThrow(NO_SHARING);

      share(impl, alice, bob, "build");
      let sharer = await open(instance, bob);
      expect(await sharer.addCollaborator(mallory.profile.id, "workspace"))
          .toMatchObject({ access: { role: "build" } });
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
    await vi.waitFor(async () => expect(await carol.user.getWorkspace(ws.id))
        .toMatchObject({ owner: alice.profile, role: "use" }), WAIT);
    expect(await bob.user.getWorkspace(ws.id)).toBeNull();
  });

  it("records the workspace in the role its sharing gives a collaborator, whatever they open it in",
      async () => {
    let { alice, bob, ws } = await team();
    await ws.run(async (impl, instance) => {
      share(impl, alice, bob, "use");
      expect(await opening(instance, bob)).toBe("build");
    });
    await vi.waitFor(async () => expect(await bob.user.getWorkspace(ws.id))
        .toMatchObject({ owner: alice.profile, role: "use" }), WAIT);
  });

  it("hands a member who uses any gadget, verifying them for it", async () => {
    let { carol, ws } = await team();
    await ws.run(async (impl, instance) => {
      // Gadget 100 binds nothing; 101 binds the workspace's one connection, which whoever gets
      // it has to be verified against, and an open with no way to choose an account cannot be.
      gadget(impl, 100);
      excluding(impl);
      gadget(impl, 101, { THING: 1 });
      let asked = lookups();
      let viewer = await open(instance, carol);
      expect(await roleOf(viewer)).toBe("use");
      expect(await (await viewer.getGadget(100)).getId()).toBe(100);
      await expect(viewer.getGadget(101)).rejects.toThrow(/must choose connected accounts/);
      await expect(viewer.getGadget(999)).rejects.toThrow("No such gadget: 999");
      // Asked at the open and again for each gadget: a session's access is read live.
      expect(asked).toHaveBeenCalledTimes(4);
    });
  });

  it("joins a member's use of every gadget with the one gadget its sharing gives them",
      async () => {
    let { alice, carol, mallory, spaceId, ws } = await team();
    let reachable = false;
    revocationsReaching(() => reachable);
    let gets = async (session: Overseer, id: number) =>
        (await session.getGadget(id)).getId().then(got => got, (error: Error) => error.message);
    await ws.run(async (impl, instance) => {
      gadget(impl, 100);
      gadget(impl, 101);
      for (let to of [carol, mallory]) share(impl, alice, to, "use", 100);
      let graphOnly = await open(instance, mallory);
      expect(await gets(graphOnly, 100)).toBe(100);
      await expect(graphOnly.getGadget(101)).rejects.toThrow("No such gadget: 101");
      let member = await open(instance, carol);
      expect(await roleOf(member)).toBe("use");
      expect(await gets(member, 100)).toBe(100);
      expect(await gets(member, 101)).toBe(101);
      // Out of the space, with the revocation yet to arrive: the session she holds is authorized
      // afresh for each gadget, by what the space answers and not by the role remembered of her.
      await space(spaceId).removeMember(alice.profile.id, carol.profile.id);
      await expect(member.getGadget(101)).rejects.toThrow("No such gadget: 101");
      expect(await gets(member, 100)).toBe(100);
      expect(ws.restarts).toEqual([]);
    });
    reachable = true;
    await vi.waitFor(() => expect(ws.restarts).toEqual([REVOKED]), WAIT);
    await ws.run(async (_impl, instance) => {
      let reopened = await open(instance, carol);
      expect(await roleOf(reopened)).toBe("use");
      expect(await gets(reopened, 100)).toBe(100);
      await expect(reopened.getGadget(101)).rejects.toThrow("No such gadget: 101");
    });
  });

  it("asks the space about everyone a sharing change dropped at once", async () => {
    let { bob, carol, mallory, ws } = await team();
    let { asked, hold } = heldLookups();
    await ws.run(async impl => {
      // The teardown has the moment before a restart: it waits on one round of lookups, not on
      // one after another. Mallory, in no space of Alice's, is the only one left with nothing.
      let { removals, observerIds } = excluding(impl, bob, carol, mallory);
      let parked = impl.tearDownLostObservers([bob, carol, mallory].flatMap(lostAccess));
      await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(3), WAIT);
      expect(removals).toEqual([]);
      hold.through = Infinity;
      await parked;
      expect(removals).toEqual([`1:${observerIds[2]}`]);
      expect(impl.storage.observers.get(bob.profile.id)).toBeDefined();
      expect(impl.storage.observers.get(carol.profile.id)).toBeDefined();
    });
  });

  it("blocks an observation that excludes a member who uses, once a gadget reaches its connection",
      async () => {
    let { alice, carol, spaceId } = await team();
    let ws = await workspace(alice, spaceId);
    await ws.run(async impl => {
      // Her role gives her every gadget, so one that binds the connection puts it in her reach.
      let { observe, removals } = excluding(impl, carol);
      gadget(impl, 100, { THING: 1 });
      await expect(observe()).rejects.toThrow(/not permitted to see/);
      expect(removals).toEqual([]);
    });
  });

  it("takes no revocation while it is being deleted, and restarts once its removals are tried",
      async () => {
    let { alice, bob, mallory, ws } = await team();
    // The revocations that have reached a workspace and been answered.
    let { revokeSpaceAccess } = OverseerDurableObject.prototype;
    let revoked = 0;
    vi.spyOn(OverseerDurableObject.prototype, "revokeSpaceAccess")
        .mockImplementation(async function (this: OverseerDurableObject, profileId) {
          await revokeSpaceAccess.call(this, profileId);
          revoked++;
        });
    // Mallory's User DO, a second reader's, keeps the deletion waiting for as long as it is held.
    let { workspaceRemoved } = UserDurableObject.prototype;
    let removal = { held: true };
    onTestFinished(() => { removal.held = false; });
    vi.spyOn(UserDurableObject.prototype, "workspaceRemoved")
        .mockImplementation(async function (this: UserDurableObject, id) {
          while (removal.held && objectId(this) === mallory.userId) await scheduler.wait(10);
          return workspaceRemoved.call(this, id);
        });
    await ws.run(async (impl, instance) => {
      share(impl, alice, mallory, "build");
      expect(await opening(instance, bob)).toBe("build");
      let owner = Object.assign(await open(instance, alice), { notifyClosed: async () => {} });
      let deleted = owner.deleteSelf();
      // The owner's record has left the space, which revokes the role Bob opened with.
      await vi.waitFor(() => expect(revoked).toBe(1), WAIT);
      // His session stands until the deletion's own restart, and so does what is remembered of
      // him: what the workspace reads meanwhile is still kept from him.
      await expect(excluding(impl, bob).observe()).rejects.toThrow(/not permitted to see/);
      removal.held = false;
      await deleted;
    });
    expect(ws.restarts).toEqual([DELETED]);
  });
});
