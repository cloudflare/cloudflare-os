// Sub-spaces: a space created inside another, whose members are also those of the spaces it is
// inside. The role a profile holds in one, who may create one or change its members, and what a
// space lends the spaces below it are SpaceModel's, over a Map-backed storage, handed the role
// the profile inherits. Everything else runs against real Durable Objects: a sub-space asking
// each of its ancestors, which calls that takes, how a revocation reaches a workspace several
// levels down, and what becomes of an answer in flight.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { AiChatAuthorInfo, SpaceMemberRole } from "@gadgets/workshop-shared/api";
import { OverseerDurableObject } from "../src/overseer.js";
import { MAX_SPACE_DEPTH, SpaceDurableObject, SpaceModel, spaceById } from "../src/spaces.js";
import {
  makeSpaceStorage, type SpaceLease, type SpaceRecord,
} from "../src/storage-schema/space-storage.js";
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

// A user: `id` is their profile id, and `personal` the id of their personal space.
type Account = {
  profile: AiChatAuthorInfo; user: DurableObjectStub<UserDurableObject>; id: string;
  personal: string;
};

const NO_SUCH_SPACE = "No such space, or you are not a member of it.";
const ADMINS_ONLY = "Only an admin of this space can change its members.";
const REMOVE_OTHERS = "Only an admin of this space can remove other members.";
const LAST_ADMIN = "A space must keep at least one admin.";
const NO_MEMBERS = "A personal space has no members.";
const BUILDERS_ONLY = "Only an admin or a build member of this space can create a sub-space.";
const TOO_DEEP = `A space can be nested at most ${MAX_SPACE_DEPTH} levels deep.`;
const OVERTAKEN = "This space's inherited roles changed while one was being looked up.";
const NEEDS_CREATOR = "A space inside no other needs a creator.";
const SPACE_NAME_RULE = "A space name is 1 to 100 characters.";
// What an ancestor that cannot be asked fails with here.
const OUT_OF_REACH = "This space is out of reach.";
// Shorter than the test timeout, so that a wait which runs out fails with its own assertion.
const WAIT = { timeout: 4_000 };
const DAY = new Date("2026-01-01");
// No role, then the three from the lowest to the highest.
const ROLES: (SpaceMemberRole | undefined)[] = [undefined, "use", "build", "admin"];
const unique = () => crypto.randomUUID().slice(0, 8);
const pair = (lease: SpaceLease) =>
    `${"space" in lease ? `space:${lease.space}` : lease.workspace}:${lease.profile}`;
const space = (id: string) => spaceById(env.TEST_SPACE, id);
// An id that names a workspace's Overseer, which a revocation has to be able to reach.
const workspaceId = () => env.TEST_OVERSEER.newUniqueId().toString();
// The id of the object a spy on one of its methods was called on.
const objectId = (object: unknown) => (object as { ctx: DurableObjectState }).ctx.id.toString();

afterEach(() => {
  vi.restoreAllMocks();
});

// Await a stub call's rejection with a single handler: expect(...).rejects forks the underlying
// JsRpcPromise, and the leftover copy is reported as an unhandled rejection.
async function expectRejection(call: PromiseLike<unknown>, message: string): Promise<void> {
  let caught: unknown;
  let rejected = false;
  try { await call; } catch (err) { rejected = true; caught = err; }
  expect(rejected).toBe(true);
  expect(String(caught)).toContain(message);
}

async function signUp(name: string): Promise<Account> {
  let id = `${name}-${unique()}`;
  let user = env.TEST_USER.getByName(id);
  await user.authenticateFromCfAccess(id, true);
  await user.listSpaces();
  let personal = env.TEST_SPACE.idFromName(id).toString();
  return { profile: { type: "user", id, name: id }, user, id, personal };
}

// One account for each of `names`.
function signUps<const Names extends string[]>(...names: Names) {
  return Promise.all(names.map(name => signUp(name))) as
      Promise<{ [Name in keyof Names]: Account }>;
}

// A root of `admin`'s and `levels` sub-spaces, each created inside the last by `admin`, who is
// given no role in any of them: their ids, the root first.
async function chain(admin: Account, levels: number): Promise<string[]> {
  let ids = [env.TEST_SPACE.newUniqueId().toString()];
  expect(await space(ids[0]!).create({ name: "Root", kind: "team" }, admin.profile)).toBe(true);
  for (let level = 1; level <= levels; level++) {
    ids.push((await space(ids.at(-1)!).createSubspace(admin.id, `Level ${level}`)).id);
  }
  return ids;
}

// A workspace of `owner`'s that has reported neither flag and that space `spaceId`, or with
// none their personal space, lists. Deleting a workspace the owner has no record of waits out
// the sync that lists this one.
async function listedWorkspace(owner: Account, spaceId?: string, id = workspaceId()) {
  await owner.user.newWorkspace(id, "Untitled", spaceId);
  await owner.user.setWorkspaceLastActive(id, DAY, undefined);
  await owner.user.deleteWorkspace("ws-none");
  return id;
}

// Whether `caller` can open a space, whose capability is dropped at once.
async function opens(spaceId: string, caller: Account): Promise<boolean> {
  using opened = await space(spaceId).open(caller.id);
  return opened !== null;
}

// The leases a space holds, those of `profile` alone if one is given; the revocations it has
// queued, oldest first; when its alarm is set for; and the ancestors its record holds.
const leases = (spaceId: string, profile?: Account) =>
    runInDurableObject(space(spaceId), (_instance, state) =>
        [...makeSpaceStorage(state.storage).leases.list()]
            .filter(lease => !profile || lease.profile === profile.id).map(pair));
const queue = (spaceId: string) => runInDurableObject(space(spaceId), (_instance, state) =>
    [...makeSpaceStorage(state.storage).revocations.list()].map(pair));
const alarm = (spaceId: string) =>
    runInDurableObject(space(spaceId), (_instance, state) => state.storage.getAlarm());
const ancestorsOf = (spaceId: string) => runInDurableObject(space(spaceId), (_instance, state) =>
    makeSpaceStorage(state.storage).info.get()?.ancestors);

// Each call a spy on a space's method saw: "<the space called>" or, with `from`, "<the space
// that asked> > <the space called>", the asker being what `roleFor` is told first. Ancestors
// are asked side by side, so the list is sorted: no order of theirs means anything.
const callsOf = (spy: { mock: { contexts: unknown[]; calls: unknown[][] } }, from = false) =>
    spy.mock.contexts.map((object, call) =>
        from ? `${String(spy.mock.calls[call]![0])} > ${objectId(object)}` : objectId(object))
        .toSorted();

const [ALICE, BOB, CAROL, DANA] = ["alice", "bob", "carol", "dana"]
    .map((id): AiChatAuthorInfo => ({ type: "user", id, name: id })) as
    [AiChatAuthorInfo, AiChatAuthorInfo, AiChatAuthorInfo, AiChatAuthorInfo];

// A model of the space `id`, created with `record`, and what it holds of leases and revocations.
function modelOf(id: string, record: Pick<SpaceRecord, "name" | "kind" | "ancestors">,
                 creator?: AiChatAuthorInfo) {
  let storage = makeSpaceStorage(makeMockStorage());
  let model = new SpaceModel(storage, id);
  expect(model.create(record, creator)).toBe(true);
  let held = () => [...storage.leases.list()].map(pair);
  return { model, storage, held, queued: () => [...storage.revocations.list()].map(pair) };
}

// Alice's team space "eng", inside no other; the sub-space "platform", which is inside
// `ancestors`, nearest first, and has no member of its own; and Alice's personal space.
const root = () => modelOf("eng", { name: "Engineering", kind: "team" }, ALICE);
const sub = (ancestors = ["eng"]) =>
    modelOf("platform", { name: "Platform", kind: "team", ancestors });
const personal = () => modelOf("alice-home", { name: "Alice", kind: "personal" }, ALICE);
// `count` ids of spaces a sub-space is inside.
const above = (count: number) => Array.from({ length: count }, (_, level) => `above-${level}`);
// A registration of workspace `id`.
const registration = (id: string) => ({ id, title: id, created: DAY });

describe("the role a member holds in a sub-space", () => {
  it("is the higher of their own and the one they inherit, for every pair", () => {
    for (let own of ROLES) {
      for (let inherited of ROLES) {
        let { model, storage, held } = sub();
        expect(model.attachWorkspaces(ALICE, [registration("w")], "admin")).toBe(true);
        if (own) storage.members.put({ profile: BOB, role: own, added: DAY });
        let higher = ROLES[Math.max(ROLES.indexOf(own), ROLES.indexOf(inherited))];
        let onWorkspace = higher === "admin" ? "build" : higher;
        let given = `own ${own}, inherited ${inherited}`;

        expect(model.roleOf(BOB.id, inherited), given).toBe(higher);
        expect(model.infoFor(BOB.id, inherited)?.role, given).toBe(higher);
        expect(model.workspaceRole("w", ALICE.id, BOB.id, inherited), given).toBe(onWorkspace);
        expect(held(), given).toEqual(onWorkspace ? ["w:bob"] : []);
      }
    }
  });

  it("is not lowered by a role given in the sub-space", () => {
    let { model } = sub();
    model.setMemberRole(ALICE.id, ALICE, "use", "admin");
    expect(model.roleOf(ALICE.id, "admin")).toBe("admin");
    expect(model.listMembers(ALICE.id, "admin").map(member => [member.profile.id, member.role]))
        .toEqual([["alice", "use"]]);
    // What was given there is all they hold once nothing is inherited.
    expect(model.roleOf(ALICE.id)).toBe("use");
  });

  it("tells a sub-space's parent only to someone who inherits a role, and never its ancestors",
      () => {
    let { model, storage } = sub(["eng", "top"]);
    storage.members.put({ profile: BOB, role: "build", added: DAY });
    let given = model.infoFor(BOB.id)!;
    expect(given).toEqual({ id: "platform", name: "Platform", kind: "team", role: "build" });
    expect(given).not.toHaveProperty("parent");
    let inheriting = model.infoFor(ALICE.id, "admin")!;
    expect(inheriting)
        .toEqual({ id: "platform", name: "Platform", kind: "team", parent: "eng", role: "admin" });
    // Bob too, once he inherits a role, however low.
    expect(model.infoFor(BOB.id, "use")).toMatchObject({ parent: "eng", role: "build" });
    for (let info of [given, inheriting]) expect(info).not.toHaveProperty("ancestors");
    expect(model.info!.ancestors).toEqual(["eng", "top"]);
  });
});

describe("SpaceModel sub-spaces", () => {
  it("creates a sub-space with no member, a root with its creator as admin, and no root "
      + "without one", () => {
    let { model } = sub();
    expect(model.listMembers(ALICE.id, "admin")).toEqual([]);
    expect(model.roleOf(ALICE.id)).toBeUndefined();
    // A space that exists is not created again, with other ancestors or for a creator.
    expect(model.create({ name: "Taken", kind: "team", ancestors: ["elsewhere"] })).toBe(false);
    expect(model.create({ name: "Taken", kind: "team" }, BOB)).toBe(false);
    expect(model.info).toEqual({ name: "Platform", kind: "team", ancestors: ["eng"] });
    expect(model.listMembers(ALICE.id, "admin")).toEqual([]);

    let team = root().model;
    expect(team.info).toEqual({ name: "Engineering", kind: "team" });
    expect(team.listMembers(ALICE.id).map(member => [member.profile.id, member.role]))
        .toEqual([["alice", "admin"]]);

    let orphan = new SpaceModel(makeSpaceStorage(makeMockStorage()), "eng");
    expect(() => orphan.create({ name: "Engineering", kind: "team" })).toThrow(NEEDS_CREATOR);
    expect(orphan.info).toBeUndefined();
  });

  it("lets an admin or a build member create a sub-space, own or inherited, and no one else",
      () => {
    for (let [make, ancestors] of [
      [root, ["eng"]], [() => sub(["eng", "top"]), ["platform", "eng", "top"]],
    ] as const) {
      let { model, storage } = make();
      storage.members.put({ profile: ALICE, role: "admin", added: DAY });
      storage.members.put({ profile: BOB, role: "build", added: DAY });
      storage.members.put({ profile: CAROL, role: "use", added: DAY });
      let record = { name: "Tools", kind: "team", ancestors };
      expect(model.newSubspace(ALICE.id, "Tools")).toEqual(record);
      expect(model.newSubspace(BOB.id, "Tools")).toEqual(record);
      expect(model.newSubspace(DANA.id, "Tools", "admin")).toEqual(record);
      expect(model.newSubspace(DANA.id, "Tools", "build")).toEqual(record);
      // A role that is too low where it was given is enough once a higher one is inherited.
      expect(model.newSubspace(CAROL.id, "Tools", "build")).toEqual(record);

      expect(() => model.newSubspace(CAROL.id, "Tools")).toThrow(BUILDERS_ONLY);
      expect(() => model.newSubspace(DANA.id, "Tools", "use")).toThrow(BUILDERS_ONLY);
      expect(() => model.newSubspace(DANA.id, "Tools")).toThrow(NO_SUCH_SPACE);

      // The record is all it makes: a sub-space is listed once it exists.
      expect(model.listSubspaces(ALICE.id)).toEqual([]);
      let child = { id: "tools", name: "Tools" };
      expect(model.addSubspace(child)).toBe(child);
      expect(model.listSubspaces(ALICE.id)).toEqual([child]);
    }
  });

  it("nests MAX_SPACE_DEPTH levels and refuses one more, whoever asks", () => {
    let { model } = sub(above(MAX_SPACE_DEPTH - 1));
    expect(model.newSubspace(ALICE.id, "Deepest", "admin").ancestors)
        .toEqual(["platform", ...above(MAX_SPACE_DEPTH - 1)]);

    let { model: deepest } = sub(above(MAX_SPACE_DEPTH));
    expect(() => deepest.newSubspace(ALICE.id, "Deeper", "admin")).toThrow(TOO_DEEP);
    expect(() => deepest.newSubspace(ALICE.id, "Deeper", "build")).toThrow(TOO_DEEP);
    // Someone who may not create one is not told how deep the space is.
    expect(() => deepest.newSubspace(BOB.id, "Deeper", "use")).toThrow(BUILDERS_ONLY);
    expect(() => deepest.newSubspace(CAROL.id, "Deeper")).toThrow(NO_SUCH_SPACE);
  });

  it("lists its sub-spaces by name to whoever holds a role", () => {
    let { model } = root();
    for (let [id, name] of [["c", "Tools"], ["b", "Apps"], ["a", "Tools"]] as const) {
      model.addSubspace({ id, name });
    }
    // Two of one name come in the order of their ids.
    let listed = [
      { id: "b", name: "Apps" }, { id: "a", name: "Tools" }, { id: "c", name: "Tools" },
    ];
    expect(model.listSubspaces(ALICE.id)).toEqual(listed);
    expect(model.listSubspaces(BOB.id, "use")).toEqual(listed);
    expect(() => model.listSubspaces(BOB.id)).toThrow(NO_SUCH_SPACE);
  });

  it("lets only an admin, own or inherited, change a sub-space's members", () => {
    let { model } = sub();
    expect(model.setMemberRole(ALICE.id, BOB, "build", "admin")).toMatchObject({ role: "build" });
    expect(model.roleOf(BOB.id)).toBe("build");
    for (let inherited of ["build", "use"] as const) {
      expect(() => model.setMemberRole(ALICE.id, CAROL, "use", inherited)).toThrow(ADMINS_ONLY);
    }
    expect(() => model.setMemberRole(BOB.id, CAROL, "use")).toThrow(ADMINS_ONLY);
    expect(() => model.setMemberRole(DANA.id, CAROL, "use")).toThrow(NO_SUCH_SPACE);
    expect(model.roleOf(CAROL.id)).toBeUndefined();
    // An admin of the sub-space itself needs nothing inherited.
    model.setMemberRole(ALICE.id, BOB, "admin", "admin");
    expect(model.setMemberRole(BOB.id, CAROL, "use")).toMatchObject({ role: "use" });

    // A personal space takes no members, whatever role is inherited in it.
    let { model: home } = personal();
    expect(() => home.setMemberRole(ALICE.id, BOB, "use", "admin")).toThrow(NO_MEMBERS);
    expect(() => home.setMemberRole(DANA.id, BOB, "use", "admin")).toThrow(NO_MEMBERS);
  });

  it("removes only a member of the space itself, and lets one leave", () => {
    let { model, held, queued } = sub();
    model.setMemberRole(ALICE.id, BOB, "build", "admin");
    model.setMemberRole(ALICE.id, CAROL, "use", "admin");
    model.attachWorkspaces(ALICE, [registration("w")], "admin");
    // Dana holds a role here by inheritance alone.
    for (let member of [BOB, CAROL]) model.workspaceRole("w", ALICE.id, member.id);
    expect(model.workspaceRole("w", ALICE.id, DANA.id, "build")).toBe("build");

    // Only an admin removes another, and a role inherited below admin is not one.
    expect(() => model.removeMember(BOB.id, CAROL.id)).toThrow(REMOVE_OTHERS);
    expect(() => model.removeMember(DANA.id, CAROL.id, "build")).toThrow(REMOVE_OTHERS);
    expect(queued()).toEqual([]);

    expect(model.removeMember(BOB.id, BOB.id)).toBe(true);
    expect(model.removeMember(ALICE.id, CAROL.id, "admin")).toBe(true);
    expect(queued()).toEqual(["w:bob", "w:carol"]);
    // Nothing given here to take away: the role she inherits ends where it was given.
    expect(model.removeMember(ALICE.id, DANA.id, "admin")).toBe(false);
    expect(model.removeMember(DANA.id, DANA.id, "build")).toBe(false);
    expect(queued()).toEqual(["w:bob", "w:carol"]);
    expect(held()).toEqual(["w:dana"]);
    expect(model.listMembers(ALICE.id, "admin")).toEqual([]);
  });

  it("keeps an admin in a root and needs none in a sub-space", () => {
    let { model } = sub();
    model.setMemberRole(ALICE.id, BOB, "admin", "admin");
    // Its only admin of its own lowers himself, and then leaves, with nothing inherited.
    expect(model.setMemberRole(BOB.id, BOB, "build")).toMatchObject({ role: "build" });
    model.setMemberRole(ALICE.id, BOB, "admin", "admin");
    expect(model.removeMember(BOB.id, BOB.id)).toBe(true);
    expect(model.listMembers(ALICE.id, "admin")).toEqual([]);

    let { model: team } = root();
    expect(() => team.setMemberRole(ALICE.id, ALICE, "build")).toThrow(LAST_ADMIN);
    expect(() => team.removeMember(ALICE.id, ALICE.id)).toThrow(LAST_ADMIN);
    // An admin role inherited there, which no root has, would not stand in for one of its own.
    expect(() => team.removeMember(ALICE.id, ALICE.id, "admin")).toThrow(LAST_ADMIN);
  });

  it("takes workspaces from whoever holds a role, own or inherited", () => {
    let { model } = sub();
    expect(model.canAddWorkspaces(ALICE.id)).toBe(false);
    expect(model.attachWorkspaces(ALICE, [registration("w1")])).toBe(false);
    expect(model.attachWorkspaces(ALICE, [registration("w1")], "use")).toBe(true);
    model.setMemberRole(ALICE.id, BOB, "use", "admin");
    expect(model.attachWorkspaces(BOB, [registration("w2")])).toBe(true);
    expect(model.listWorkspaces(ALICE.id, "use").map(workspace => workspace.id).toSorted())
        .toEqual(["w1", "w2"]);
    // One the space lists is updated for its owner, who needs no role for that.
    expect(model.attachWorkspaces(ALICE, [{ ...registration("w1"), title: "Renamed" }])).toBe(true);

    // A personal space takes its owner's alone, whatever anyone inherits.
    let { model: home } = personal();
    expect(home.canAddWorkspaces(BOB.id, "admin")).toBe(false);
    expect(home.attachWorkspaces(BOB, [registration("w3")], "admin")).toBe(false);
    expect(home.attachWorkspaces(ALICE, [registration("w3")])).toBe(true);
  });
});

describe("what a space lends the spaces below it", () => {
  // Alice's root with Bob as a "build" member and Carol as a "use" member.
  function lender() {
    let made = root();
    made.model.setMemberRole(ALICE.id, BOB, "build");
    made.model.setMemberRole(ALICE.id, CAROL, "use");
    return made;
  }

  it("answers from its own members alone, with a lease for each role it gives", () => {
    let { model, held } = lender();
    expect(model.lend("s", ALICE.id)).toBe("admin");
    expect(model.lend("s", BOB.id)).toBe("build");
    expect(model.lend("s", CAROL.id)).toBe("use");
    expect(held()).toEqual(["space:s:alice", "space:s:bob", "space:s:carol"]);
    expect(model.lend("s", DANA.id)).toBeUndefined();
    // Whichever space says it asks is answered: nothing here knows the spaces below this one.
    expect(model.lend("never-created", BOB.id)).toBe("build");
    expect(held())
        .toEqual(["space:never-created:bob", "space:s:alice", "space:s:bob", "space:s:carol"]);

    // A sub-space lends what was given in it, never what its members inherit.
    let below = sub();
    below.model.setMemberRole(ALICE.id, BOB, "use", "admin");
    expect(below.model.lend("s", ALICE.id)).toBeUndefined();
    expect(below.model.lend("s", BOB.id)).toBe("use");
    expect(below.held()).toEqual(["space:s:bob"]);
  });

  it("takes a descendant's leases back when the member is removed or lowered to use, and not "
      + "when they are raised", () => {
    let { model, held, queued } = lender();
    model.setMemberRole(ALICE.id, DANA, "admin");
    for (let descendant of ["s1", "s2"]) {
      for (let member of [BOB, CAROL, DANA]) model.lend(descendant, member.id);
    }

    // Raised, and moved between the two roles that give "build": nothing is taken back.
    model.setMemberRole(ALICE.id, CAROL, "build");
    model.setMemberRole(ALICE.id, BOB, "admin");
    model.setMemberRole(ALICE.id, BOB, "build");
    expect(queued()).toEqual([]);

    model.setMemberRole(ALICE.id, DANA, "use");
    expect(queued()).toEqual(["space:s1:dana", "space:s2:dana"]);
    model.removeMember(BOB.id, BOB.id);
    expect(queued())
        .toEqual(["space:s1:dana", "space:s2:dana", "space:s1:bob", "space:s2:bob"]);
    expect(held()).toEqual(["space:s1:carol", "space:s2:carol"]);

    // A role lent again is a new lease, and the revocation of the old one still goes out.
    expect(model.lend("s1", DANA.id)).toBe("use");
    expect(held()).toEqual(["space:s1:carol", "space:s1:dana", "space:s2:carol"]);
    expect(queued()).toHaveLength(4);
  });

  it("takes back the workspace leases of a profile whose inherited role ended, and nothing "
      + "else", () => {
    let { model, held, queued } = sub();
    model.setMemberRole(ALICE.id, BOB, "use", "admin");
    model.setMemberRole(ALICE.id, CAROL, "use", "admin");
    model.attachWorkspaces(ALICE, [registration("w1")], "admin");
    for (let member of [BOB, CAROL]) {
      expect(model.workspaceRole("w1", ALICE.id, member.id, "build")).toBe("build");
      expect(model.lend("deeper", member.id)).toBe("use");
    }

    model.revokeInherited(BOB.id);
    expect(queued()).toEqual(["w1:bob"]);
    // What it lent the space below stands, and so does everything of Carol's.
    expect(held()).toEqual(["space:deeper:bob", "space:deeper:carol", "w1:carol"]);
    model.revokeInherited(DANA.id);
    expect(queued()).toEqual(["w1:bob"]);

    // Whoever asks again is answered with what Bob still holds, on a lease of its own.
    expect(model.workspaceRole("w1", ALICE.id, BOB.id)).toBe("use");
    expect(held()).toEqual(["space:deeper:bob", "space:deeper:carol", "w1:bob", "w1:carol"]);

    // A role of his own that gives as much does not spare the lease.
    model.setMemberRole(ALICE.id, BOB, "build", "admin");
    expect(model.workspaceRole("w1", ALICE.id, BOB.id)).toBe("build");
    model.revokeInherited(BOB.id);
    expect(queued()).toEqual(["w1:bob", "w1:bob"]);
    expect(held()).toEqual(["space:deeper:bob", "space:deeper:carol", "w1:carol"]);
  });

  it("drops a workspace's leases with it and leaves the spaces' alone", () => {
    let { model, held, queued } = lender();
    model.attachWorkspaces(ALICE, [registration("w1"), registration("w2")]);
    for (let member of [ALICE, BOB]) {
      model.workspaceRole("w1", ALICE.id, member.id);
      model.lend("s", member.id);
    }
    model.workspaceRole("w2", ALICE.id, BOB.id);
    model.detachWorkspace("w1", ALICE.id);
    expect(queued()).toEqual(["w1:alice", "w1:bob"]);
    expect(held()).toEqual(["space:s:alice", "space:s:bob", "w2:bob"]);
  });
});

describe("SpaceDurableObject sub-spaces", () => {
  it("creates a sub-space that its parent lists, with its ancestors and no member", async () => {
    let [alice, bob, mallory] = await signUps("alice", "bob", "mallory");
    let [r] = await chain(alice, 0) as [string];
    await space(r).setMemberRole(alice.id, bob.id, "use");

    let created = await space(r).createSubspace(alice.id, "  Platform ");
    let s = created.id;
    expect(created).toEqual({ id: expect.any(String), name: "Platform" });
    expect(await space(r).listSubspaces(alice.id)).toEqual([created]);
    let below = await space(s).createSubspace(alice.id, "Tools");
    expect([await ancestorsOf(r), await ancestorsOf(s), await ancestorsOf(below.id)])
        .toEqual([undefined, [r], [s, r]]);

    // Its creator holds in it the role she inherits, and was given none.
    expect(await space(s).getInfo(alice.id))
        .toEqual({ id: s, name: "Platform", kind: "team", parent: r, role: "admin" });
    expect(await space(s).listMembers(alice.id)).toEqual([]);
    expect((await alice.user.listSpaces()).map(info => info.id)).not.toContain(s);

    await expectRejection(space(r).createSubspace(alice.id, "   "), SPACE_NAME_RULE);
    await expectRejection(space(r).createSubspace(bob.id, "Tools"), BUILDERS_ONLY);
    await expectRejection(space(r).createSubspace(mallory.id, "Tools"), NO_SUCH_SPACE);
    expect(await space(r).listSubspaces(bob.id)).toEqual([created]);
  });

  it("opens a sub-space to whoever holds a role above it, in at least that role", async () => {
    let [alice, bob, ben] = await signUps("alice", "bob", "ben");
    let [r, s] = await chain(alice, 1) as [string, string];
    await space(r).setMemberRole(alice.id, bob.id, "use");
    let info = { id: s, name: "Level 1", kind: "team", parent: r };

    expect(await space(s).getInfo(bob.id)).toEqual({ ...info, role: "use" });
    expect(await opens(s, bob)).toBe(true);
    // He reads all of it, and is not listed among the members it has of its own.
    expect(await space(s).listMembers(bob.id)).toEqual([]);
    expect(await space(s).listSubspaces(bob.id)).toEqual([]);
    expect(await space(s).listWorkspaces(bob.id)).toEqual([]);
    expect((await bob.user.listSpaces()).map(entry => entry.id)).toEqual([bob.personal, r]);

    // A role given in the sub-space is the one his list shows, with nothing about its parent.
    await space(s).setMemberRole(alice.id, bob.id, "build");
    expect(await space(s).getInfo(bob.id)).toEqual({ ...info, role: "build" });
    let listed = (await bob.user.listSpaces()).find(entry => entry.id === s)!;
    expect(listed).toEqual({ id: s, name: "Level 1", kind: "team", role: "build" });
    expect(listed).not.toHaveProperty("parent");
    // And one lower than the role inherited changes nothing of what its holder may do.
    await space(s).setMemberRole(alice.id, alice.id, "build");
    expect(await space(s).getInfo(alice.id)).toEqual({ ...info, role: "admin" });

    // The role counts from any level above, and gives nothing above where it was given.
    let [top, first, second, third] = await chain(alice, 3) as [string, string, string, string];
    await space(first).setMemberRole(alice.id, ben.id, "build");
    expect(await space(third).getInfo(ben.id))
        .toEqual({ id: third, name: "Level 3", kind: "team", parent: second, role: "build" });
    await expectRejection(space(top).getInfo(ben.id), NO_SUCH_SPACE);
  });

  it("gives the highest of the roles the spaces above give, whichever of them is nearer",
      async () => {
    let [alice, bob, carol, uma] = await signUps("alice", "bob", "carol", "uma");
    let [top, first, , third] = await chain(alice, 3) as [string, string, string, string];
    // Bob's higher role is the one given farther up, and Carol's the one given nearer.
    await space(top).setMemberRole(alice.id, bob.id, "admin");
    await space(first).setMemberRole(alice.id, bob.id, "use");
    await space(top).setMemberRole(alice.id, carol.id, "use");
    await space(first).setMemberRole(alice.id, carol.id, "build");
    let ws = await listedWorkspace(alice, third);

    expect(await space(third).getInfo(bob.id)).toMatchObject({ role: "admin" });
    expect(await space(third).setMemberRole(bob.id, uma.id, "use")).toMatchObject({ role: "use" });
    expect(await alice.user.workspaceRoleInSpace(ws, bob.id)).toBe("build");

    expect(await space(third).getInfo(carol.id)).toMatchObject({ role: "build" });
    expect(await space(third).createSubspace(carol.id, "Tools")).toMatchObject({ name: "Tools" });
    await expectRejection(space(third).setMemberRole(carol.id, uma.id, "build"), ADMINS_ONLY);
  });

  it("shows someone added only to a sub-space neither its parent nor a sub-space beside it",
      async () => {
    let [alice, bob, carol] = await signUps("alice", "bob", "carol");
    let [r] = await chain(alice, 0) as [string];
    let a = (await space(r).createSubspace(alice.id, "A")).id;
    let b = (await space(r).createSubspace(alice.id, "B")).id;
    await space(a).setMemberRole(alice.id, carol.id, "build");

    let info = await space(a).getInfo(carol.id);
    expect(info).toEqual({ id: a, name: "A", kind: "team", role: "build" });
    expect(info).not.toHaveProperty("parent");
    // The parent and the sub-space beside hers answer her as an id that names no space does.
    let nowhere = env.TEST_SPACE.newUniqueId().toString();
    for (let id of [r, b, nowhere]) {
      expect(await opens(id, carol)).toBe(false);
      await expectRejection(space(id).getInfo(carol.id), NO_SUCH_SPACE);
      await expectRejection(space(id).listSubspaces(carol.id), NO_SUCH_SPACE);
    }

    // In her sub-space she does what a "build" member does, and no more.
    let tools = await space(a).createSubspace(carol.id, "Tools");
    expect(await ancestorsOf(tools.id)).toEqual([a, r]);
    expect(await space(tools.id).getInfo(carol.id)).toMatchObject({ parent: a, role: "build" });
    await expectRejection(space(a).setMemberRole(carol.id, bob.id, "use"), ADMINS_ONLY);
    let spaces = await carol.user.listSpaces();
    expect(spaces.map(entry => entry.id)).toEqual([carol.personal, a]);
    expect(spaces[1]).toEqual(info);

    // A workspace of hers goes where she holds a role, and not above it.
    let mine = await listedWorkspace(carol);
    await expectRejection(carol.user.setWorkspaceSpace(mine, r), NO_SUCH_SPACE);
    await carol.user.setWorkspaceSpace(mine, a);
    expect((await space(a).listWorkspaces(alice.id)).map(workspace => workspace.id))
        .toEqual([mine]);
    expect(await space(r).listWorkspaces(alice.id)).toEqual([]);
  });

  it("gives a sub-space of a personal space members, and the personal space none", async () => {
    let [alice, carol] = await signUps("alice", "carol");
    let shared = (await space(alice.personal).createSubspace(alice.id, "Shared")).id;
    let info = { id: shared, name: "Shared", kind: "team" };
    expect(await space(shared).getInfo(alice.id))
        .toEqual({ ...info, parent: alice.personal, role: "admin" });

    expect(await space(shared).setMemberRole(alice.id, carol.id, "use"))
        .toMatchObject({ role: "use" });
    expect(await opens(shared, carol)).toBe(true);
    expect(await space(shared).getInfo(carol.id)).toEqual({ ...info, role: "use" });
    await expectRejection(
        space(alice.personal).setMemberRole(alice.id, carol.id, "use"), NO_MEMBERS);
    expect(await opens(alice.personal, carol)).toBe(false);

    // A workspace its owner placed there is open to the sub-space's member.
    let ws = await listedWorkspace(alice, shared);
    expect(await alice.user.workspaceRoleInSpace(ws, carol.id)).toBe("use");

    // Carol leaves: with no member and no admin of its own, it still answers its owner.
    await space(shared).removeMember(carol.id, carol.id);
    expect(await alice.user.workspaceRoleInSpace(ws, carol.id)).toBeNull();
    expect(await space(shared).listMembers(alice.id)).toEqual([]);
    expect(await space(shared).workspaceRole(ws, alice.id, alice.id)).toBe("build");
    expect((await space(shared).createSubspace(alice.id, "Deeper")).name).toBe("Deeper");
  });
});

// A change that makes one space ask on another's behalf lengthens the chain of calls behind a
// decision with the depth, which no test of a deep space working could show: these fail on it.
describe("the shape of the calls", () => {
  it("asks each ancestor once at the deepest level, and none of them asks a space", async () => {
    let [alice, bob] = await signUps("alice", "bob");
    let ids = await chain(alice, MAX_SPACE_DEPTH);
    let [top, deepest] = [ids[0]!, ids.at(-1)!];
    let ancestors = ids.slice(0, -1).toReversed();
    for (let [level, id] of ids.entries()) {
      expect(await ancestorsOf(id)).toEqual(level ? ids.slice(0, level).toReversed() : undefined);
    }
    await expectRejection(space(deepest).createSubspace(alice.id, "Deeper"), TOO_DEEP);
    await space(top).setMemberRole(alice.id, bob.id, "use");
    let ws = await listedWorkspace(alice, deepest);

    let asked = vi.spyOn(SpaceDurableObject.prototype, "roleFor");
    let told = vi.spyOn(SpaceDurableObject.prototype, "revokeInherited");
    // Every call is made by the deepest sub-space, on one of its ancestors, each of them once.
    // A call any other space made would be an ancestor asking on.
    let each = ancestors.map(ancestor => `${deepest} > ${ancestor}`).toSorted();
    expect(await alice.user.workspaceRoleInSpace(ws, bob.id)).toBe("use");
    expect(asked).toHaveBeenCalledTimes(MAX_SPACE_DEPTH);
    expect(callsOf(asked, true)).toEqual(each);
    expect(told).not.toHaveBeenCalled();
    // Only the ancestor that gave a role remembers it, and the workspace's space what it gave.
    expect(await leases(top, bob)).toEqual([`space:${deepest}:${bob.id}`]);
    for (let between of ids.slice(1, -1)) expect(await leases(between, bob)).toEqual([]);
    expect(await leases(deepest, bob)).toEqual([`${ws}:${bob.id}`]);

    asked.mockClear();
    expect(await space(deepest).getInfo(bob.id))
        .toMatchObject({ parent: ancestors[0], role: "use" });
    expect(callsOf(asked, true)).toEqual(each);

    // An ancestor answers from its own members, of whom Alice is none here, and asks nobody.
    asked.mockClear();
    let between = ids[2]!;
    expect(await space(between).roleFor(deepest, alice.id)).toBeNull();
    expect(callsOf(asked, true)).toEqual([`${deepest} > ${between}`]);
    expect(told).not.toHaveBeenCalled();
  });

  it("asks nobody when the profile's own role settles the question", async () => {
    let [alice, ben, uma] = await signUps("alice", "ben", "uma");
    let [r, s1, s2] = await chain(alice, 2) as [string, string, string];
    await space(s2).setMemberRole(alice.id, ben.id, "build");
    await space(s2).setMemberRole(alice.id, uma.id, "use");
    let [wr, w2] = [await listedWorkspace(alice, r), await listedWorkspace(alice, s2)];
    let nobody = `nobody-${unique()}`;
    let memberOf = async (user: Account) => (await user.user.listSpaces()).map(info => info.id);

    let asked = vi.spyOn(SpaceDurableObject.prototype, "roleFor");
    // The spaces asked since the last look.
    let who = () => {
      let spaces = callsOf(asked);
      asked.mockClear();
      return spaces;
    };
    let none: string[] = [];
    let [both, twice] = [[r, s1].toSorted(), [r, r, s1, s1].toSorted()];

    // Ben's "build" settles everything but what only an admin may do, and what he is shown.
    expect(await space(s2).workspaceRole(w2, alice.id, ben.id)).toBe("build");
    expect(who()).toEqual(none);
    expect(await space(s2).listMembers(ben.id)).toHaveLength(2);
    expect(who()).toEqual(none);
    expect(await space(s2).listWorkspaces(ben.id)).toHaveLength(1);
    expect(who()).toEqual(none);
    expect(await space(s2).listSubspaces(ben.id)).toEqual([]);
    expect(who()).toEqual(none);
    expect(await opens(s2, ben)).toBe(true);
    expect(who()).toEqual(none);
    expect(await space(s2).createSubspace(ben.id, "Tools")).toMatchObject({ name: "Tools" });
    expect(who()).toEqual(none);
    let info = await space(s2).getInfo(ben.id);
    expect(info).toEqual({ id: s2, name: "Level 2", kind: "team", role: "build" });
    expect(info).not.toHaveProperty("parent");
    expect(who()).toEqual(both);
    await expectRejection(space(s2).setMemberRole(ben.id, uma.id, "build"), ADMINS_ONLY);
    expect(who()).toEqual(both);
    await expectRejection(space(s2).removeMember(ben.id, uma.id), REMOVE_OTHERS);
    expect(who()).toEqual(both);

    // Uma's "use" settles what any member may do.
    expect(await space(s2).listMembers(uma.id)).toHaveLength(2);
    expect(who()).toEqual(none);
    expect(await opens(s2, uma)).toBe(true);
    expect(who()).toEqual(none);
    expect(await space(s2).attachWorkspaces(uma.profile, [registration(workspaceId())]))
        .toBe(true);
    expect(who()).toEqual(none);
    expect(await space(s2).workspaceRole(w2, alice.id, uma.id)).toBe("use");
    expect(who()).toEqual(both);
    await expectRejection(space(s2).createSubspace(uma.id, "Tools"), BUILDERS_ONLY);
    expect(who()).toEqual(both);

    // Alice is an admin by inheritance alone: asked about before the username is looked up,
    // and again for the write, which a username that names no account never reaches.
    expect(await space(s2).setMemberRole(alice.id, uma.id, "use")).toMatchObject({ role: "use" });
    expect(who()).toEqual(twice);
    expect(await space(s2).setMemberRole(alice.id, nobody, "use")).toBeNull();
    expect(who()).toEqual(both);
    expect(await space(s1).listSubspaces(alice.id)).toHaveLength(1);
    expect(who()).toEqual([r]);

    // A space inside no other has nobody to ask.
    expect(await space(r).getInfo(alice.id)).toMatchObject({ role: "admin" });
    expect(await space(r).listMembers(alice.id)).toHaveLength(1);
    expect(await space(r).workspaceRole(wr, alice.id, alice.id)).toBe("build");
    expect(await space(r).createSubspace(alice.id, "Beside")).toMatchObject({ name: "Beside" });
    expect(who()).toEqual(none);

    // Leaving takes any role, which Ben's own is; removing another takes an admin, which
    // Alice is by what she inherits. Both reach the mirror of whoever went.
    expect([await memberOf(ben), await memberOf(uma)])
        .toEqual([[ben.personal, s2], [uma.personal, s2]]);
    await space(s2).removeMember(ben.id, ben.id);
    expect(who()).toEqual(none);
    await space(s2).removeMember(alice.id, uma.id);
    expect(who()).toEqual(both);
    expect([await memberOf(ben), await memberOf(uma)]).toEqual([[ben.personal], [uma.personal]]);
    expect(await space(s2).listMembers(alice.id)).toEqual([]);
  });

  it("asks about an admin of the sub-space itself only to tell them its parent", async () => {
    let [alice, carol, dave, uma] = await signUps("alice", "carol", "dave", "uma");
    let [r, s1, s2] = await chain(alice, 2) as [string, string, string];
    // Both are admins of the sub-space; Carol alone holds a role above it.
    await space(r).setMemberRole(alice.id, carol.id, "use");
    await space(s2).setMemberRole(alice.id, carol.id, "admin");
    await space(s2).setMemberRole(alice.id, dave.id, "admin");
    let ws = await listedWorkspace(alice, s2);
    let info = { id: s2, name: "Level 2", kind: "team", role: "admin" };
    let both = [r, s1].toSorted();

    let asked = vi.spyOn(SpaceDurableObject.prototype, "roleFor");
    // Their own role is the one shown either way: the answer decides what `parent` they see.
    expect(await space(s2).getInfo(carol.id)).toEqual({ ...info, parent: s1 });
    expect(callsOf(asked)).toEqual(both);
    asked.mockClear();
    let alone = await space(s2).getInfo(dave.id);
    expect(alone).toEqual(info);
    expect(alone).not.toHaveProperty("parent");
    expect(callsOf(asked)).toEqual(both);

    // Nothing else an admin does there asks.
    asked.mockClear();
    expect(await opens(s2, dave)).toBe(true);
    expect(await space(s2).listMembers(dave.id)).toHaveLength(2);
    expect(await space(s2).setMemberRole(dave.id, uma.id, "use")).toMatchObject({ role: "use" });
    await space(s2).removeMember(dave.id, uma.id);
    expect(await space(s2).createSubspace(dave.id, "Tools")).toMatchObject({ name: "Tools" });
    expect(await space(s2).workspaceRole(ws, alice.id, dave.id)).toBe("build");
    expect(asked).not.toHaveBeenCalled();
  });
});

describe("revocation across levels", () => {
  // Each time a spy on a workspace's revocation saw `profile`'s, as "<workspace>:<profile>".
  const revoked = (spy: { mock: { contexts: unknown[]; calls: unknown[][] } }) =>
      spy.mock.calls.map(([profile], call) => `${objectId(spy.mock.contexts[call])}:${profile}`);

  it("tells a workspace several levels down by one delivery from the root", async () => {
    for (let [role, left] of [[undefined, null], ["use", "use"]] as const) {
      let [alice, bob] = await signUps("alice", "bob");
      let [r, s1, s2, s3] = await chain(alice, 3) as [string, string, string, string];
      await space(r).setMemberRole(alice.id, bob.id, "build");
      let ws = await listedWorkspace(alice, s3);
      expect(await alice.user.workspaceRoleInSpace(ws, bob.id)).toBe("build");
      // The root answered the workspace's space itself: no space in between holds anything.
      expect(await leases(r, bob)).toEqual([`space:${s3}:${bob.id}`]);
      expect([await leases(s1, bob), await leases(s2, bob)]).toEqual([[], []]);

      let told = vi.spyOn(SpaceDurableObject.prototype, "revokeInherited");
      let revoke = vi.spyOn(OverseerDurableObject.prototype, "revokeSpaceAccess");
      // Bob is removed from the root, or lowered in it.
      await (role ? space(r).setMemberRole(alice.id, bob.id, role)
          : space(r).removeMember(alice.id, bob.id));
      await vi.waitFor(async () => {
        expect(revoked(revoke)).toEqual([`${ws}:${bob.id}`]);
        expect(await Promise.all([r, s1, s2, s3].map(queue))).toEqual([[], [], [], []]);
      }, WAIT);
      // One call, from the root to the workspace's space: the two in between heard nothing.
      expect(callsOf(told)).toEqual([s3]);
      expect(told.mock.calls).toEqual([[bob.id]]);
      expect(await leases(s3, bob)).toEqual([]);
      expect(await alice.user.workspaceRoleInSpace(ws, bob.id)).toBe(left);
      vi.restoreAllMocks();
    }
  });

  it("leaves standing what the told space lent its own descendants", async () => {
    let [alice, carol] = await signUps("alice", "carol");
    let [r, s1, s2] = await chain(alice, 2) as [string, string, string];
    await space(r).setMemberRole(alice.id, carol.id, "use");
    await space(s1).setMemberRole(alice.id, carol.id, "build");
    let ws = await listedWorkspace(alice, s2);
    expect(await alice.user.workspaceRoleInSpace(ws, carol.id)).toBe("build");
    expect(await space(s1).getInfo(carol.id)).toMatchObject({ parent: r, role: "build" });
    // The root answered both sub-spaces, and the first answered the second.
    expect(await leases(r, carol))
        .toEqual([`space:${s1}:${carol.id}`, `space:${s2}:${carol.id}`].toSorted());
    expect(await leases(s1, carol)).toEqual([`space:${s2}:${carol.id}`]);

    let told = vi.spyOn(SpaceDurableObject.prototype, "revokeInherited");
    let revoke = vi.spyOn(OverseerDurableObject.prototype, "revokeSpaceAccess");
    await space(r).removeMember(alice.id, carol.id);
    await vi.waitFor(async () => {
      expect(revoked(revoke)).toEqual([`${ws}:${carol.id}`]);
      expect(await Promise.all([r, s1, s2].map(queue))).toEqual([[], [], []]);
    }, WAIT);
    // Each was told once, by the root: the first passed nothing on to the second, and what it
    // told the second still holds, since it rests on its own member list.
    expect(callsOf(told)).toEqual([s1, s2].toSorted());
    expect(await leases(s1, carol)).toEqual([`space:${s2}:${carol.id}`]);
    expect(await alice.user.workspaceRoleInSpace(ws, carol.id)).toBe("build");
    expect(await leases(r, carol)).toEqual([]);
  });

  it("delivers a space's revocation from the alarm, and keeps one it did not answer",
      async () => {
    let [alice, bob] = await signUps("alice", "bob");
    let [r, s] = await chain(alice, 1) as [string, string];
    await space(r).setMemberRole(alice.id, bob.id, "use");
    let ws = await listedWorkspace(alice, s);
    expect(await alice.user.workspaceRoleInSpace(ws, bob.id)).toBe("use");
    // The sub-space cannot be reached until the test says so.
    let reachable = false;
    let { revokeInherited } = SpaceDurableObject.prototype;
    let told = vi.spyOn(SpaceDurableObject.prototype, "revokeInherited")
        .mockImplementation(async function (this: SpaceDurableObject, profileId) {
          if (!reachable) throw new Error(OUT_OF_REACH);
          return revokeInherited.call(this, profileId);
        });
    await space(r).removeMember(alice.id, bob.id);
    // A run that fails leaves the revocation queued and sets the next run for later.
    await vi.waitFor(async () => {
      expect(told).toHaveBeenCalled();
      expect(await alarm(r)).toBeGreaterThan(Date.now());
    }, WAIT);
    expect(await queue(r)).toEqual([`space:${s}:${bob.id}`]);
    expect(await leases(s, bob)).toEqual([`${ws}:${bob.id}`]);

    let failed = told.mock.calls.length;
    reachable = true;
    await vi.waitFor(async () => expect(await queue(r)).toEqual([]), WAIT);
    await vi.waitFor(async () => expect(await alarm(r)).toBeNull(), WAIT);
    expect(told).toHaveBeenCalledTimes(failed + 1);
    expect(new Set(callsOf(told))).toEqual(new Set([s]));
    // Once told, the sub-space takes back what it gave him on its workspace.
    expect(await leases(s, bob)).toEqual([]);
  });
});

describe("answers in flight", () => {
  // Has the root `r` hold back each answer it has given, so that its lease is written and the
  // sub-space that asked still waits. `hold.round` counts the rounds of asking by the calls
  // that reach the root, and a round waits while `hold.through` is below its number.
  function heldAnswers(r: string) {
    let { roleFor } = SpaceDurableObject.prototype;
    let hold = { through: 0, round: 0 };
    onTestFinished(() => { hold.through = Infinity; });
    let asked = vi.spyOn(SpaceDurableObject.prototype, "roleFor")
        .mockImplementation(async function (this: SpaceDurableObject, ...ask) {
          let role = await roleFor.apply(this, ask);
          if (objectId(this) !== r) return role;
          let round = ++hold.round;
          while (hold.through < round) await scheduler.wait(10);
          return role;
        });
    return { hold, asked };
  }

  // Alice's root, two sub-spaces down to `s`, which lists a workspace of hers, and Bob, a
  // "use" member of the root alone.
  async function twoBelow() {
    let [alice, bob] = await signUps("alice", "bob");
    let [r, s1, s] = await chain(alice, 2) as [string, string, string];
    await space(r).setMemberRole(alice.id, bob.id, "use");
    return { alice, bob, r, s1, s, ws: await listedWorkspace(alice, s) };
  }

  it("does not trust answers that a revocation for the same profile overtook", async () => {
    let { alice, bob, r, s1, s, ws } = await twoBelow();
    let { hold, asked } = heldAnswers(r);
    let pending = space(s).workspaceRole(ws, alice.id, bob.id);
    await vi.waitFor(async () => {
      expect(await leases(r, bob)).toEqual([`space:${s}:${bob.id}`]);
    }, WAIT);
    // Bob is removed, and the sub-space told so, while the answer that he is a member waits.
    await space(r).removeMember(alice.id, bob.id);
    await vi.waitFor(async () => expect(await queue(r)).toEqual([]), WAIT);
    hold.through = Infinity;

    // The answers of that round are dropped and each ancestor is asked once more.
    expect(await pending).toBeNull();
    expect(callsOf(asked)).toEqual([r, r, s1, s1].toSorted());
    expect(await leases(s, bob)).toEqual([]);
  });

  it("throws rather than answer when overtaken twice, and is not overtaken by another "
      + "profile's revocation", async () => {
    let { alice, bob, r, s, ws } = await twoBelow();
    let { hold } = heldAnswers(r);
    // Bob stays a "use" member throughout: an answer of "no role" would be as wrong as a
    // role resting on answers that may be stale.
    let twice = expectRejection(space(s).workspaceRole(ws, alice.id, bob.id), OVERTAKEN);
    await vi.waitFor(() => expect(hold.round).toBe(1), WAIT);
    await space(s).revokeInherited(bob.id);
    hold.through = 1;
    await vi.waitFor(() => expect(hold.round).toBe(2), WAIT);
    await space(s).revokeInherited(bob.id);
    hold.through = 2;
    await twice;
    expect(hold.round).toBe(2);
    expect(await leases(s, bob)).toEqual([]);

    let other = space(s).workspaceRole(ws, alice.id, bob.id);
    await vi.waitFor(() => expect(hold.round).toBe(3), WAIT);
    await space(s).revokeInherited(alice.id);
    hold.through = Infinity;
    expect(await other).toBe("use");
    expect(hold.round).toBe(3);
    expect(await leases(s, bob)).toEqual([`${ws}:${bob.id}`]);
  });

  it("fails, and gives no role, when an ancestor cannot be asked", async () => {
    let [alice, bob, carol] = await signUps("alice", "bob", "carol");
    let [r, s1, s] = await chain(alice, 2) as [string, string, string];
    await space(s1).setMemberRole(alice.id, bob.id, "use");
    await space(s).setMemberRole(alice.id, carol.id, "build");
    let ws = await listedWorkspace(alice, s);
    let { roleFor } = SpaceDurableObject.prototype;
    // Only the root is out of reach. The nearer ancestor answers "use", which must not stand
    // in for the answer that is missing.
    let asked = vi.spyOn(SpaceDurableObject.prototype, "roleFor")
        .mockImplementation(async function (this: SpaceDurableObject, ...ask) {
          if (objectId(this) === r) throw new Error(OUT_OF_REACH);
          return roleFor.apply(this, ask);
        });

    // Each fails with the ancestor's own error: none resolves, as "no role" would.
    for (let call of [
      () => space(s).workspaceRole(ws, alice.id, bob.id),
      () => space(s).open(bob.id),
      () => space(s).getInfo(bob.id),
      () => space(s).listWorkspaces(bob.id),
      () => space(s).attachWorkspaces(bob.profile, [registration(workspaceId())]),
      // As the workspace's Overseer asks, through its owner's account.
      () => alice.user.workspaceRoleInSpace(ws, bob.id),
    ]) {
      await expectRejection(call(), OUT_OF_REACH);
    }
    expect(await leases(s, bob)).toEqual([]);

    // Carol's own role settles the question, so nobody is asked and she is answered.
    asked.mockClear();
    expect(await space(s).workspaceRole(ws, alice.id, carol.id)).toBe("build");
    expect(asked).not.toHaveBeenCalled();

    // Once the root answers, so is Bob, none of whose workspaces was listed meanwhile.
    asked.mockRestore();
    expect(await space(s).workspaceRole(ws, alice.id, bob.id)).toBe("use");
    expect((await space(s).listWorkspaces(alice.id)).map(workspace => workspace.owner.id))
        .toEqual([alice.id]);
  });

  it("asks the ancestors again before it writes a member, and writes none on a role that "
      + "ended meanwhile", async () => {
    let [alice, dana, carol] = await signUps("alice", "dana", "carol");
    let [r, s] = await chain(alice, 1) as [string, string];
    // Dana is an admin of the sub-space by inheritance alone.
    await space(r).setMemberRole(alice.id, dana.id, "admin");
    let asked = vi.spyOn(SpaceDurableObject.prototype, "roleFor");

    expect(await space(s).setMemberRole(dana.id, carol.id, "use")).toMatchObject({ role: "use" });
    expect(callsOf(asked)).toEqual([r, r]);
    asked.mockClear();
    expect(await space(s).setMemberRole(dana.id, `nobody-${unique()}`, "use")).toBeNull();
    expect(callsOf(asked)).toEqual([r]);
    await space(s).removeMember(alice.id, carol.id);

    // Holds the first username lookup made since the spy was cleared, once it has its answer.
    // Changing Dana's role in the root makes a lookup of its own, which passes.
    let { whoamiIfExists } = UserDurableObject.prototype;
    let hold = { on: false };
    onTestFinished(() => { hold.on = false; });
    let lookedUp = vi.spyOn(UserDurableObject.prototype, "whoamiIfExists")
        .mockImplementation(async function (this: UserDurableObject) {
          let first = lookedUp.mock.calls.length === 1;
          let profile = await whoamiIfExists.apply(this);
          if (first) {
            while (hold.on) await scheduler.wait(10);
          }
          return profile;
        });
    for (let [end, refusal] of [
      // Lowered to "build", which takes back no lease: only asking again can see it.
      [() => space(r).setMemberRole(alice.id, dana.id, "build"), ADMINS_ONLY],
      [() => space(r).removeMember(alice.id, dana.id), NO_SUCH_SPACE],
    ] as const) {
      await space(r).setMemberRole(alice.id, dana.id, "admin");
      hold.on = true;
      asked.mockClear();
      lookedUp.mockClear();
      let refused = expectRejection(space(s).setMemberRole(dana.id, carol.id, "build"), refusal);
      await vi.waitFor(() => expect(lookedUp).toHaveBeenCalledTimes(1), WAIT);
      expect(callsOf(asked)).toEqual([r]);
      // Her role above ends while the lookup it allowed is still out.
      await end();
      // The root tells the sub-space of a removal on its alarm's schedule. Delivered while the
      // lookup is out, it finds no asking in flight; during the second round of asking it would
      // have the sub-space ask a third time.
      await vi.waitFor(async () => expect(await queue(r)).toEqual([]), WAIT);
      hold.on = false;
      await refused;
      expect(callsOf(asked)).toEqual([r, r]);
      expect(await space(s).listMembers(alice.id)).toEqual([]);
      expect((await carol.user.listSpaces()).map(info => info.id)).toEqual([carol.personal]);
    }
  });
});
