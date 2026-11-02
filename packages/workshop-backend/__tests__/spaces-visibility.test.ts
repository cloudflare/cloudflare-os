// A workspace's publication is in effect only while the workspace is visible in its space: listed
// there, and published as is every entry above it in the space's tree. What the space answers,
// the publication leases it keeps of those answers and when it takes them back are SpaceModel's,
// over a Map-backed storage. Everything else runs against real Durable Objects: the owner's User
// DO, which a workspace asks; the space's alarm, which tells the workspace when an answer no
// longer holds; and the workspace's Overseer, which counts the publication only while one stands.

import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createOpenGadgetError, getOpenGadgetErrorCode, OPEN_GADGET_ERROR_CODES,
  type AiChatAuthorInfo, type CollaboratorRole, type Overseer, type SpaceWorkspaceInfo,
} from "@gadgets/workshop-shared/api";
import { OverseerDurableObject } from "../src/overseer.js";
import {
  SpaceDurableObject, SpaceModel, teamSpaceClaim, type WorkspaceRegistration,
} from "../src/spaces.js";
import {
  makeSpaceStorage, PUBLICATION_LEASE, type SpaceLease,
} from "../src/storage-schema/space-storage.js";
import type { WorkspaceRestrictions } from "../src/storage-schema/user-storage.js";
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

const NEITHER: WorkspaceRestrictions = { containsRestrictedData: false, ownerInvitesOnly: false };
const NOT_VISIBLE = createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceNotVisible).message;
const HIDDEN = "Gadget restarted because it is no longer visible to everyone signed in.";
const REMOVED = "Gadget restarted to revoke access for a removed collaborator.";
const NO_AGENT = "You do not have access to interact with this workspace through its agent.";
// Shorter than the test timeout, so that a wait which runs out fails with its own assertion.
const WAIT = { timeout: 4_000 };
const DAY = new Date("2026-01-01");
const unique = () => crypto.randomUUID().slice(0, 8);
const pair = (lease: SpaceLease) => `${lease.workspace}:${lease.profile}`;
const space = (key: string) => env.TEST_SPACE.getByName(key);
const author = (id: string): AiChatAuthorInfo => ({ type: "user", id, name: id });
// What a listing names as hiding each entry, by id.
const hiddenByOf = (listing: SpaceWorkspaceInfo[]) =>
    Object.fromEntries(listing.map(({ id, hiddenBy }) => [id, hiddenBy]));

// A registration of workspace `id` under `parentId`, or at the top of the tree, published at
// `published` or not at all.
const ws = (id: string, parentId?: string, published?: CollaboratorRole): WorkspaceRegistration =>
    ({ id, title: id, created: DAY, placement: { parentId }, ...(published && { published }) });
// The same registration with `published` changed, as an update its owner's User DO sends.
const republished = (id: string, published?: CollaboratorRole): WorkspaceRegistration =>
    ({ id, title: id, created: DAY, ...(published && { published }) });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SpaceModel's answer whether a workspace is visible", () => {
  // An admin, a member who uses, and someone who is not a member.
  const [ALICE, BOB, DAVE] = ["alice", "bob", "dave"].map(author);

  // Alice's team space with Bob as a "use" member, listing `registrations` of hers.
  function teamModel(...registrations: WorkspaceRegistration[]) {
    let storage = makeSpaceStorage(makeMockStorage());
    let model = new SpaceModel(storage);
    model.claim(teamSpaceClaim("eng", "Engineering"), ALICE);
    model.setMemberRole(ALICE.id, BOB, "use");
    model.attachWorkspaces(ALICE, registrations);
    let leases = () => [...storage.leases.list()].map(pair);
    let queued = () => [...storage.revocations.list()].map(pair);
    // Answers for each of `ids` in turn, as their Overseers would ask.
    let visible = (...ids: string[]) => ids.map(id => model.workspaceVisible(id, ALICE.id));
    return { model, storage, leases, queued, visible };
  }

  it("is yes for a listed, published entry under published entries alone, with a publication "
      + "lease that no member's leases include", () => {
    let { model, storage, leases, queued, visible } = teamModel(
        ws("a", undefined, "use"), ws("b", "a", "build"), ws("c"), ws("d", "c", "use"));
    expect(visible("a", "b", "c", "d", "nowhere")).toEqual([true, true, false, false, false]);
    // Listed under Alice, so not for Bob's User DO to ask about.
    expect(model.workspaceVisible("a", BOB.id)).toBe(false);
    expect(leases()).toEqual([`a:${PUBLICATION_LEASE}`, `b:${PUBLICATION_LEASE}`]);
    // No member has the publication lease's profile, so removing one by it takes nothing back.
    expect(model.removeMember(ALICE.id, PUBLICATION_LEASE)).toBe(false);
    expect(queued()).toEqual([]);

    // A member's leases are their own: removing Bob takes back his and leaves the space's word.
    expect(model.workspaceRole("a", ALICE.id, BOB.id)).toBe("use");
    expect([...storage.leases.byProfile.get(BOB.id)].map(pair)).toEqual(["a:bob"]);
    model.removeMember(ALICE.id, BOB.id);
    expect(queued()).toEqual(["a:bob"]);
    expect(leases()).toEqual(["a:", "b:"]);
  });

  it("is taken back for an entry that stops being published and every entry under it, and for "
      + "none when one is published in a lower role", () => {
    let { model, leases, queued, visible } = teamModel(
        ws("a", undefined, "build"), ws("b", "a", "use"), ws("c", "b", "use"),
        ws("d", undefined, "use"));
    expect(visible("a", "b", "c", "d")).toEqual([true, true, true, true]);
    model.attachWorkspaces(ALICE, [republished("a", "use")]);
    expect(queued()).toEqual([]);
    model.attachWorkspaces(ALICE, [republished("a")]);
    expect(queued()).toEqual(["a:", "b:", "c:"]);
    expect(leases()).toEqual(["d:"]);
    expect(visible("a", "b", "c")).toEqual([false, false, false]);
    // Published again, they are visible at the next answer, which nothing has to announce.
    model.attachWorkspaces(ALICE, [republished("a", "use")]);
    expect(visible("a", "b", "c")).toEqual([true, true, true]);
    expect(queued()).toHaveLength(3);
  });

  it("is taken back for a subtree moved under an unpublished entry, and for none moved under a "
      + "published one, to the top or among its siblings", () => {
    let { model, leases, queued, visible } = teamModel(
        ws("a", undefined, "use"), ws("b", "a", "use"), ws("p", undefined, "use"), ws("u"),
        ws("v", "u", "use"));
    expect(visible("a", "b")).toEqual([true, true]);
    model.moveWorkspace(ALICE.id, "a", "p");
    model.moveWorkspace(ALICE.id, "a", null, "p");
    model.moveWorkspace(ALICE.id, "a", null);
    expect(queued()).toEqual([]);
    model.moveWorkspace(ALICE.id, "a", "u");
    expect(queued()).toEqual(["a:", "b:"]);
    expect(leases()).toEqual([]);
    // Moved within the unpublished one's subtree, nothing is left to take back.
    expect(visible("a", "b", "v")).toEqual([false, false, false]);
    model.moveWorkspace(ALICE.id, "a", "v");
    expect(queued()).toHaveLength(2);
  });

  it("is taken back with the rest of a leaving entry's leases, and never for the entries that "
      + "take its place", () => {
    let { model, leases, queued, visible } = teamModel(
        ws("p", undefined, "use"), ws("a", "p", "use"), ws("b", "a", "use"), ws("x"),
        ws("y", "x", "use"));
    expect(visible("p", "a", "b", "y")).toEqual([true, true, true, false]);
    model.workspaceRole("a", ALICE.id, BOB.id);
    model.detachWorkspace("a", ALICE.id);
    expect(queued().toSorted()).toEqual(["a:", "a:bob"]);
    expect(leases()).toEqual(["b:", "p:"]);
    // An unpublished entry leaving makes visible the entries it hid.
    model.detachWorkspace("x", ALICE.id);
    expect(visible("b", "y")).toEqual([true, true]);
    expect(queued()).toHaveLength(2);
  });

  it("names, in a member's listing, the nearest unpublished entry above a published one, and "
      + "never shows a visitor such an entry", () => {
    let { model } = teamModel(
        ws("r"), ws("s", "r", "use"), ws("t", "s"), ws("v", "t", "use"), ws("w", "v", "build"),
        ws("q", undefined, "use"), ws("q2", "q", "use"));
    for (let member of [ALICE, BOB]) {
      expect(hiddenByOf(model.listWorkspaces(member.id))).toEqual({
        r: undefined, s: "r", t: undefined, v: "t", w: "t", q: undefined, q2: undefined,
      });
    }
    expect(model.resolveWorkspace(BOB.id, "w")?.workspace)
        .toMatchObject({ id: "w", hiddenBy: "t" });
    expect(model.resolveWorkspace(BOB.id, "t")?.workspace).not.toHaveProperty("hiddenBy");

    let visitor = model.listWorkspaces(DAVE.id);
    expect(hiddenByOf(visitor)).toEqual({ q: undefined, q2: undefined });
    expect(visitor.every(entry => !("hiddenBy" in entry))).toBe(true);
    expect(model.resolveWorkspace(DAVE.id, "q2")?.workspace).not.toHaveProperty("hiddenBy");
    expect(model.resolveWorkspace(DAVE.id, "w")).toBeNull();
  });
});

async function signUp(name: string): Promise<Account> {
  let id = `${name}-${unique()}`;
  let user = env.TEST_USER.getByName(id);
  await user.authenticateFromCfAccess(id, true);
  await user.listSpaces();
  let profile: AiChatAuthorInfo = { type: "user", id, name: id };
  return { profile, user, userId: user.id.toString(), personal: `~${id}` };
}

// A real workspace of `owner`'s, titled `title`, that team space `spaceKey`, or with none their
// personal space, lists under `parentId`, or at the top of its tree. `run` acts inside its Overseer, on its OverseerImpl,
// with the owner planted rather than established by a first open; the restarts it schedules are
// recorded in `restarts` instead of taking the object from under the test. `state` has the
// owner's User DO record that the workspace is published at `role`, or not at all, as its
// Overseer would state, and the space follow: enough for a workspace that is only an ancestor.
async function workspace(
    owner: Account, spaceKey: string | undefined, title: string, parentId?: string) {
  let stub = env.TEST_OVERSEER.get(env.TEST_OVERSEER.newUniqueId());
  let id = stub.id.toString();
  await owner.user.newGadget(id, title, spaceKey, parentId);
  await owner.user.setGadgetLastActive(id, DAY, undefined, NEITHER);
  // Deleting a workspace the owner has no record of waits out the sync that lists this one.
  await owner.user.deleteGadget("ws-none", NEITHER);
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
  let state = (role?: CollaboratorRole) =>
      owner.user.setGadgetPublicAccess(id, { ...NEITHER, publicAccess: role });
  await run(() => {});
  return { id, run, restarts, state };
}

// Alice's team space, where Bob is a "use" member, listing an unpublished workspace of hers,
// "Parent", and under it "Child", published at `role` by its owner through its Overseer; Carol,
// whom Child's sharing gives "build"; and Mallory and Dave, who are in no space of Alice's and
// whom its sharing gives nothing.
async function hidden(role: CollaboratorRole = "use") {
  let [alice, bob, carol, mallory, dave] =
      await Promise.all(["alice", "bob", "carol", "mallory", "dave"].map(signUp));
  let key = `team-${unique()}`;
  expect(await space(key).claim(teamSpaceClaim(key, "Team"), alice.profile)).toBe(true);
  await space(key).setMemberRole(alice.profile.id, bob.profile.id, "use");
  let parent = await workspace(alice, key, "Parent");
  let child = await workspace(alice, key, "Child", parent.id);
  await child.run(async (impl, instance) => {
    share(impl, alice, carol, "build");
    await publish(instance, alice, role);
  });
  return { alice, bob, carol, mallory, dave, key, parent, child };
}

const open = (instance: OverseerDurableObject, as: Account): Promise<Overseer> =>
    instance.open(as.userId, as.profile.id, new NativeRpcStub<() => void>(() => {}));
// What opening the workspace as `as` comes to: the role of their session, or the refusal.
const opening = (instance: OverseerDurableObject, as: Account) => open(instance, as)
    .then(async session => (await session.getMetadata()).role, (error: Error) => error.message);
// The code of the refusal opening the workspace as `as` comes to, if it is refused.
const refusal = (instance: OverseerDurableObject, as: Account) => open(instance, as)
    .then(() => undefined, (error: unknown) => getOpenGadgetErrorCode(error));
// The owner publishes the workspace at `role`, or with null withdraws that.
const publish = async (
    instance: OverseerDurableObject, owner: Account, role: CollaboratorRole | null) =>
    (await open(instance, owner)).setPublicAccess(role);

// The owner adds `to` to the workspace's own sharing, in `role`.
function share(impl: any, owner: Account, to: Account, role: CollaboratorRole): void {
  impl.storage.collaborators.put({
    profile: to.profile,
    addedBy: [{ type: "user", sharer: owner.profile.id, created: DAY, role }],
  });
}

// Every lookup a workspace's Overseer makes of whether it is visible, which goes to its owner's
// User DO.
const lookups = () => vi.spyOn(UserDurableObject.prototype, "workspaceVisibility");

// Makes each of `observers` an observer of the workspace's one connection, which no gadget binds,
// so that whoever builds reaches what it reads and whoever only uses does not, and returns what
// an observation from it that names them all as excluded comes to.
function excluding(impl: any, ...observers: Account[]) {
  impl.storage.gatekeepers.put({
    id: 1, resourceTitle: "Connection", class: {},
    creationSpec: {
      type: "gatekeeper", vendorId: "testvendor", resourceUrl: "https://example.com/1",
      typeUrlPattern: "https://*",
    },
  });
  for (let { profile } of observers) {
    impl.storage.observers.put(
        { profileId: profile.id, observerId: `obs-${profile.id}`, accountChoices: { 1: 10 } });
  }
  impl.getGatekeeperFacet = () => ({ removeObserver: async () => {} });
  return (impl.authorizeObservation(1, {
    title: "Observation", description: "One the gatekeeper keeps from its observers.",
    excludeObservers: observers.map(({ profile }) => `obs-${profile.id}`),
  }, { from: "agent", chatId: 1 }) as Promise<void>)
      .then(() => "admitted", (error: Error) => error.message);
}

describe("the owner's User DO, asked whether a workspace is visible", () => {
  it("asks the space its record points at once that space has listed it, personal or not, and "
      + "no space for a workspace that none lists", async () => {
    let [alice, bob] = await Promise.all(["alice", "bob"].map(signUp));
    let key = `team-${unique()}`;
    await space(key).claim(teamSpaceClaim(key, "Team"), alice.profile);
    let personal = await workspace(alice, undefined, "Personal");
    let team = await workspace(alice, key, "Team");
    await Promise.all([personal.state("use"), team.state("build")]);
    let asked = vi.spyOn(SpaceDurableObject.prototype, "workspaceVisible");
    expect(await alice.user.workspaceVisibility(personal.id)).toBe(true);
    expect(await alice.user.workspaceVisibility(team.id)).toBe(true);
    await team.state();
    expect(await alice.user.workspaceVisibility(team.id)).toBe(false);
    expect(asked).toHaveBeenCalledTimes(3);

    // Provisional, under a flag, or not the user's own: no space lists it, and none is asked.
    asked.mockClear();
    let provisional = crypto.randomUUID();
    await alice.user.newGadget(provisional, "Untitled", key);
    await alice.user.setGadgetPublicAccess(personal.id,
        { containsRestrictedData: true, ownerInvitesOnly: false, publicAccess: "use" });
    for (let [owner, id] of [[alice, provisional], [alice, personal.id], [bob, team.id]] as const) {
      expect(await owner.user.workspaceVisibility(id)).toBe(false);
    }
    expect(asked).not.toHaveBeenCalled();
  });
});

describe("a published workspace's Overseer, as its space's tree has it", () => {
  it("admits nobody through the publication while an entry above it is unpublished, with a "
      + "reason that names none, and does once that one is published", async () => {
    let { alice, mallory, parent, child } = await hidden();
    await child.run(async (_impl, instance) => {
      expect(await refusal(instance, mallory)).toBe(OPEN_GADGET_ERROR_CODES.workspaceNotVisible);
      let reason = await opening(instance, mallory);
      expect(reason).toBe(NOT_VISIBLE);
      for (let named of ["Parent", parent.id]) expect(reason).not.toContain(named);
    });
    await parent.state("use");
    await child.run(async (_impl, instance) => {
      expect(await opening(instance, mallory)).toBe("use");
    });
    // Withdrawn, the workspace refuses her as one that was never published does.
    await child.run(async (_impl, instance) => {
      await publish(instance, alice, null);
      expect(await refusal(instance, mallory)).toBe(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
    });
  });

  it("still opens for anyone signed in under entries that are all published, and asks its space "
      + "once", async () => {
    let [alice, mallory, dave] = await Promise.all(["alice", "mallory", "dave"].map(signUp));
    let key = `team-${unique()}`;
    await space(key).claim(teamSpaceClaim(key, "Team"), alice.profile);
    let top = await workspace(alice, key, "Top");
    let middle = await workspace(alice, key, "Middle", top.id);
    await Promise.all([top.state("use"), middle.state("build")]);
    let child = await workspace(alice, key, "Child", middle.id);
    let asked = lookups();
    await child.run(async (_impl, instance) => {
      await publish(instance, alice, "use");
      expect(await opening(instance, mallory)).toBe("use");
      expect(await opening(instance, dave)).toBe("use");
      expect(asked).toHaveBeenCalledTimes(1);
    });
  });

  it("opens for a member of its space and a collaborator in their own roles, asking nothing of "
      + "the tree while those reach the published role", async () => {
    let { bob, carol, child } = await hidden();
    let asked = lookups();
    await child.run(async (_impl, instance) => {
      expect(await opening(instance, bob)).toBe("use");
      expect(await opening(instance, carol)).toBe("build");
      expect(asked).not.toHaveBeenCalled();
    });
    // Published to build, the publication would give Bob more than his membership does, so the
    // space is asked, and he opens in the role his membership gives all the same.
    let built = await hidden("build");
    await built.child.run(async (_impl, instance) => {
      expect(await opening(instance, built.bob)).toBe("use");
      expect(await opening(instance, built.carol)).toBe("build");
      expect(await opening(instance, built.mallory)).toBe(NOT_VISIBLE);
    });
  });

  it("admits nobody through the publication when the lookup fails, and nobody else is turned "
      + "away", async () => {
    let { bob, carol, mallory, parent, child } = await hidden("build");
    await parent.state("use");
    lookups().mockRejectedValue(new Error("user object unavailable"));
    await child.run(async (_impl, instance) => {
      expect(await refusal(instance, mallory))
          .toBe(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
      expect(await opening(instance, bob)).toBe("use");
      expect(await opening(instance, carol)).toBe("build");
    });
    vi.restoreAllMocks();
    await child.run(async (_impl, instance) => {
      expect(await opening(instance, mallory)).toBe("build");
    });
  });

  it("is restarted when an entry above it is unpublished, if a visitor opened it through the "
      + "publication, and never otherwise", async () => {
    let { mallory, parent, child } = await hidden();
    await parent.state("use");
    await child.run(async (_impl, instance) => {
      expect(await opening(instance, mallory)).toBe("use");
    });
    await parent.state();
    await vi.waitFor(() => expect(child.restarts).toEqual([HIDDEN]), WAIT);
    await child.run(async (_impl, instance) => {
      expect(await opening(instance, mallory)).toBe(NOT_VISIBLE);
    });

    // A member and a collaborator open it in their own roles: the space was never asked, and
    // has nothing to take back.
    let quiet = await hidden();
    await quiet.parent.state("use");
    await quiet.child.run(async (_impl, instance) => {
      await open(instance, quiet.bob);
      await open(instance, quiet.carol);
    });
    await quiet.parent.state();
    await vi.waitFor(async () => expect(await queue(quiet.key)).toEqual([]), WAIT);
    // Told anyway, it has nothing of the publication's to end.
    await quiet.child.run(async (_impl, instance) => {
      await instance.revokeSpaceAccess(PUBLICATION_LEASE);
      expect(await opening(instance, quiet.bob)).toBe("use");
    });
    expect(quiet.child.restarts).toEqual([]);
  });

  it("is restarted when a move puts it under an unpublished entry, if a visitor opened it "
      + "through the publication", async () => {
    let { alice, mallory, key, parent, child } = await hidden();
    await parent.state("use");
    let other = await workspace(alice, key, "Other");
    await other.state("build");
    await child.run(async (_impl, instance) => {
      expect(await opening(instance, mallory)).toBe("use");
    });
    // Under another published entry, and at the top, it stays visible.
    await space(key).moveWorkspace(alice.profile.id, child.id, other.id);
    await space(key).moveWorkspace(alice.profile.id, child.id, null);
    await vi.waitFor(async () => expect(await queue(key)).toEqual([]), WAIT);
    expect(child.restarts).toEqual([]);

    let unpublished = await workspace(alice, key, "Unpublished");
    await space(key).moveWorkspace(alice.profile.id, child.id, unpublished.id);
    await vi.waitFor(() => expect(child.restarts).toEqual([HIDDEN]), WAIT);
    await child.run(async (_impl, instance) => {
      expect(await opening(instance, mallory)).toBe(NOT_VISIBLE);
    });
    // Moved back to the top, it is visible again at the next open.
    await space(key).moveWorkspace(alice.profile.id, child.id, null);
    await child.run(async (_impl, instance) => {
      expect(await opening(instance, mallory)).toBe("use");
    });
  });

  it("keeps counting the publication for an excluded observer from being told it may no longer "
      + "be visible until the restart that ends the sessions it admitted", async () => {
    let { mallory, dave, parent, child } = await hidden("build");
    await parent.state("use");
    await child.run(async (impl, instance) => {
      expect(await opening(instance, dave)).toBe("build");
      // The restart is pending (the test only records it), and Dave's session with it.
      await instance.revokeSpaceAccess(PUBLICATION_LEASE);
      expect(child.restarts).toEqual([HIDDEN]);
      expect(await excluding(impl, mallory)).toMatch(/not permitted to see/);
      expect(impl.storage.observers.get(mallory.profile.id)).toBeDefined();
    });
  });

  it("asks again whether it is visible once its owner has moved it, though the space it left "
      + "took back no answer", async () => {
    let [alice, mallory] = await Promise.all(["alice", "mallory"].map(signUp));
    let [from, to] = [`team-${unique()}`, `team-${unique()}`];
    for (let key of [from, to]) await space(key).claim(teamSpaceClaim(key, "Team"), alice.profile);
    let moved = await workspace(alice, from, "Moved");
    let asked = lookups();
    await moved.run(async (_impl, instance) => {
      await publish(instance, alice, "use");
      expect(await opening(instance, mallory)).toBe("use");
      // The space it leaves is never told, so it revokes nothing; the space it joins lists it,
      // and has acknowledged nothing the workspace could have been told.
      vi.spyOn(SpaceDurableObject.prototype, "detachWorkspace")
          .mockRejectedValue(new Error("space unavailable"));
      await expect((await open(instance, alice)).moveToSpace(to)).rejects.toThrow();
      expect(moved.restarts).toEqual([HIDDEN]);
      expect(await opening(instance, mallory)).toBe(NOT_VISIBLE);
      expect(asked).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps its answer that it is visible through a move that is refused, and drops it once a "
      + "move goes through", async () => {
    let [alice, mallory] = await Promise.all(["alice", "mallory"].map(signUp));
    let [from, to] = [`team-${unique()}`, `team-${unique()}`];
    for (let key of [from, to]) await space(key).claim(teamSpaceClaim(key, "Team"), alice.profile);
    let moved = await workspace(alice, from, "Moved");
    let asked = lookups();
    // The space it leaves revokes its lease too, which would drop the answer on its own.
    vi.spyOn(OverseerDurableObject.prototype, "revokeSpaceAccess").mockResolvedValue();
    await moved.run(async (_impl, instance) => {
      await publish(instance, alice, "use");
      expect(await opening(instance, mallory)).toBe("use");
      let owner = await open(instance, alice);
      // A malformed key, and a space that is nobody's, which refuses the workspace.
      for (let key of ["Bad Key", `team-${unique()}`]) {
        await expect(owner.moveToSpace(key)).rejects.toThrow();
      }
      expect(moved.restarts).toEqual([]);
      expect(await opening(instance, mallory)).toBe("use");
      expect(asked).toHaveBeenCalledTimes(1);

      await owner.moveToSpace(to);
      expect(moved.restarts).toEqual([HIDDEN]);
      expect(await opening(instance, mallory)).toBe("use");
      expect(asked).toHaveBeenCalledTimes(2);
    });
  });

  it("refuses a message for its agent from a visitor while the publication admits nobody, with "
      + "the reason an open is refused for", async () => {
    let { mallory, child } = await hidden("build");
    await child.run(async (_impl, instance) => {
      expect(await instance.receiveExternalMessage({
        callerEmail: mallory.profile.id, externalChatKey: "k", idempotencyKey: "i",
        prompt: "hello", chatGatewayRpcTarget: {} as any, title: "T",
      })).toEqual({ accepted: false, message: NOT_VISIBLE });
    });
  });

  it("asks nothing of its space for a message for its agent that its publication could not "
      + "admit", async () => {
    let { mallory, child } = await hidden("use");
    let asked = lookups();
    await child.run(async (_impl, instance) => {
      expect(await instance.receiveExternalMessage({
        callerEmail: mallory.profile.id, externalChatKey: "k", idempotencyKey: "i",
        prompt: "hello", chatGatewayRpcTarget: {} as any, title: "T",
      })).toEqual({ accepted: false, message: NO_AGENT });
    });
    expect(asked).not.toHaveBeenCalled();
  });

  it("trusts no answer that the space took back while it was in flight", async () => {
    let { mallory, parent, child } = await hidden();
    await parent.state("use");
    let { workspaceVisibility } = UserDurableObject.prototype;
    let release = { held: true };
    onTestFinished(() => { release.held = false; });
    let asked = lookups().mockImplementation(async function (this: UserDurableObject, id) {
      let visible = await workspaceVisibility.call(this, id);
      while (release.held) await scheduler.wait(10);
      return visible;
    });
    await child.run(async (_impl, instance) => {
      let parked = refusal(instance, mallory);
      await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1), WAIT);
      await instance.revokeSpaceAccess(PUBLICATION_LEASE);
      release.held = false;
      expect(await parked).toBe(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
      expect(await asked.mock.results[0].value).toBe(true);
      // The next open asks again, and is answered afresh.
      expect(await opening(instance, mallory)).toBe("use");
      expect(asked).toHaveBeenCalledTimes(2);
    });
    expect(child.restarts).toEqual([]);
  });

  it("counts no publication its space has not said is in effect, when a removal tears down "
      + "observers or an observation excludes one", async () => {
    let { alice, carol, mallory, dave, parent, child } = await hidden("build");
    await parent.state("use");
    await child.run(async (impl, instance) => {
      // Visible, but nobody has opened it through the publication: Carol, removed, is cut off.
      excluding(impl, carol);
      let owner = await open(instance, alice);
      expect(await owner.removeCollaborator(carol.profile.id, []))
          .toMatchObject([{ profile: carol.profile, oldRole: "build", newRole: null }]);
      expect(child.restarts).toEqual([REMOVED]);
      expect(impl.storage.observers.get(carol.profile.id)).toBeUndefined();
      // Nor does it count for Mallory, whose observer record is torn down by an observation.
      expect(await excluding(impl, mallory)).toBe("admitted");
      expect(impl.storage.observers.get(mallory.profile.id)).toBeUndefined();
      // Nor did the removal leave anyone holding a session through it, so withdrawing it
      // restarts nothing.
      await owner.setPublicAccess(null);
      expect(child.restarts).toEqual([REMOVED]);
    });
    // Once Dave has opened it through the publication, the space has said it is in effect.
    let confirmed = await hidden("build");
    await confirmed.parent.state("use");
    await confirmed.child.run(async (impl, instance) => {
      expect(await opening(instance, dave)).toBe("build");
      expect(await excluding(impl, mallory)).toMatch(/not permitted to see/);
      let owner = await open(instance, confirmed.alice);
      expect(await owner.removeCollaborator(confirmed.carol.profile.id, [])).toEqual([]);
    });
    expect(confirmed.child.restarts).toEqual([]);
  });

  it("tells the members of its space which entry hides it, and a visitor nothing of either",
      async () => {
    let { alice, bob, mallory, key, parent, child } = await hidden();
    let top = await workspace(alice, key, "Top");
    await top.state("use");
    await space(key).moveWorkspace(alice.profile.id, parent.id, top.id);
    let hiddenBy = async (viewer: Account) =>
        hiddenByOf(await space(key).listWorkspaces(viewer.profile.id));
    for (let member of [alice, bob]) {
      expect(await hiddenBy(member))
          .toEqual({ [top.id]: undefined, [parent.id]: undefined, [child.id]: parent.id });
    }
    expect(await hiddenBy(mallory)).toEqual({ [top.id]: undefined });
    await parent.state("use");
    expect(await hiddenBy(alice))
        .toEqual({ [top.id]: undefined, [parent.id]: undefined, [child.id]: undefined });
    expect(await hiddenBy(mallory))
        .toEqual({ [top.id]: undefined, [parent.id]: undefined, [child.id]: undefined });
  });
});

// The revocations a space has queued, oldest first.
const queue = (key: string) => runInDurableObject(space(key), (_instance, state) =>
    [...makeSpaceStorage(state.storage).revocations.list()].map(pair));
