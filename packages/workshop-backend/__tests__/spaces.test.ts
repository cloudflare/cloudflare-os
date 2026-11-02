// Spaces: the key grammar and SpaceModel's membership and listing rules over a Map-backed
// storage, then the real Durable Objects -- a space, and the users whose memberships it mirrors.
// The users' side of the listing is spaces-workspaces.test.ts.

import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  isValidSpaceKey, isValidTeamSpaceKey, type AiChatAuthorInfo, type SpaceInfo,
} from "@gadgets/workshop-shared/api";
import {
  SpaceModel, checkSpaceKey, personalSpaceClaim, teamSpaceClaim, type SpaceDurableObject,
} from "../src/spaces.js";
import { makeSpaceStorage } from "../src/storage-schema/space-storage.js";
import { UserDurableObject } from "../src/user.js";
import { makeMockStorage } from "./mock-storage.js";
// Load the whole backend (the pool's `main`) up front. Otherwise the pool loads it on the first
// RPC into a Durable Object, and that slow load counts against the first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_SPACE: DurableObjectNamespace<SpaceDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const NO_SUCH_SPACE = "No such space, or you are not a member of it.";
const ADMINS_ONLY = "Only an admin of this space can change its members.";
const LAST_ADMIN = "A space must keep at least one admin.";

function profile(id: string, name = id): AiChatAuthorInfo {
  return { type: "user", id, name };
}

const ALICE = profile("alice", "Alice");
const BOB = profile("bob", "Bob");
const CAROL = profile("carol", "Carol");

function teamSpace(storage = makeSpaceStorage(makeMockStorage())): SpaceModel {
  let model = new SpaceModel(storage);
  expect(model.claim(teamSpaceClaim("eng", "Engineering"), ALICE)).toBe(true);
  return model;
}

function personalSpace(): SpaceModel {
  let model = new SpaceModel(makeSpaceStorage(makeMockStorage()));
  expect(model.claim(personalSpaceClaim(ALICE, 1), ALICE)).toBe(true);
  return model;
}

function roles(model: SpaceModel): Record<string, string> {
  return Object.fromEntries(model.listMembers(ALICE.id).map(m => [m.profile.id, m.role]));
}

describe("space keys", () => {
  it.each(["eng", "my-team", "a1", "search", "x".repeat(32)])("accepts team key %j", key => {
    expect(isValidTeamSpaceKey(key)).toBe(true);
    expect(isValidSpaceKey(key)).toBe(true);
    expect(teamSpaceClaim(key, "  Team  ")).toEqual({ key, name: "Team", kind: "team" });
  });

  it.each(["", "a", "-eng", "Eng", "eng team", "x".repeat(33), "~alice"])(
      "rejects team key %j", key => {
    expect(isValidTeamSpaceKey(key)).toBe(false);
    expect(() => teamSpaceClaim(key, "Team")).toThrow(/A space key is 2 to 32/);
  });

  it("recognizes personal keys, which no team key can collide with", () => {
    for (let key of ["~alice", "~alice-2", "~search"]) {
      expect(isValidSpaceKey(key)).toBe(true);
      expect(isValidTeamSpaceKey(key)).toBe(false);
      checkSpaceKey(key);
    }
    for (let key of ["~", "~a", "~Alice", "~-alice", "~~alice", "alice~", ""]) {
      expect(isValidSpaceKey(key)).toBe(false);
      expect(() => checkSpaceKey(key)).toThrow("Invalid space key.");
    }
  });

  it("bounds a team space's name once trimmed", () => {
    expect(teamSpaceClaim("eng", "n".repeat(100)).name).toHaveLength(100);
    for (let name of ["", "   ", "n".repeat(101)]) {
      expect(() => teamSpaceClaim("eng", name)).toThrow("A space name is 1 to 100 characters.");
    }
  });

  it("derives a personal key from the local part of the profile id", () => {
    let keyFor = (id: string, attempt = 1) => personalSpaceClaim(profile(id), attempt).key;
    expect(keyFor("maximo@example.com")).toBe("~maximo");
    expect(keyFor("Maximo Guk")).toBe("~maximo-guk");
    expect(keyFor("josé.núñez@example.com")).toBe("~jose-nunez");
    expect(keyFor("_x_@example.com")).toBe("~x0");
    expect(keyFor("@x")).toBe("~x0");
    expect(keyFor("日本")).toBe("~00");
    expect(keyFor("maximo@example.com", 2)).toBe("~maximo-2");
    expect(personalSpaceClaim(profile("maximo@example.com", "Maximo Guk"), 3))
        .toEqual({ key: "~maximo-3", name: "Maximo Guk", kind: "personal" });
  });

  it("keeps every attempt at a personal key inside the grammar", () => {
    let long = profile("a".repeat(40) + "-" + "b".repeat(40) + "@example.com");
    expect(personalSpaceClaim(long, 1).key).toBe("~" + "a".repeat(32));
    expect(personalSpaceClaim(long, 2).key).toBe("~" + "a".repeat(30) + "-2");
    expect(personalSpaceClaim(long, 12345).key).toBe("~" + "a".repeat(26) + "-12345");
    for (let id of ["x", "日本", "a".repeat(31) + "-b", long.id]) {
      for (let attempt of [1, 2, 99, 100, 12345]) {
        expect(isValidSpaceKey(personalSpaceClaim(profile(id), attempt).key)).toBe(true);
      }
    }
  });
});

describe("SpaceModel.claim", () => {
  it("gives a team key to its first claimant and to nobody after", () => {
    let model = new SpaceModel(makeSpaceStorage(makeMockStorage()));
    expect(model.info).toBeUndefined();
    expect(model.infoFor(ALICE.id)).toBeUndefined();

    expect(model.claim(teamSpaceClaim("eng", "Engineering"), ALICE)).toBe(true);
    expect(model.infoFor(ALICE.id))
        .toEqual({ key: "eng", name: "Engineering", kind: "team", role: "admin" });
    let members = model.listMembers(ALICE.id);
    expect(members).toMatchObject([{ profile: ALICE, role: "admin" }]);

    // Neither another user nor the creator can claim it again, as either kind.
    expect(model.claim(teamSpaceClaim("eng", "Hijacked"), BOB)).toBe(false);
    expect(model.claim(teamSpaceClaim("eng", "Renamed"), ALICE)).toBe(false);
    expect(model.claim({ key: "eng", name: "Mine", kind: "personal" }, ALICE)).toBe(false);
    expect(model.info).toEqual({ key: "eng", name: "Engineering", kind: "team" });
    expect(model.listMembers(ALICE.id)).toEqual(members);
    expect(model.roleOf(BOB.id)).toBeUndefined();
  });

  it("grants a personal space again to its owner only, changing nothing", () => {
    let model = personalSpace();
    expect(model.info).toEqual({ key: "~alice", name: "Alice", kind: "personal", owner: ALICE });
    model.setMemberRole(ALICE.id, BOB, "build");
    let members = model.listMembers(ALICE.id);
    expect(members).toMatchObject([{ profile: ALICE, role: "admin" }, { profile: BOB, role: "build" }]);

    // The owner's retry is granted. A claim under a name they have since changed leaves the
    // space as it was first claimed.
    expect(model.claim(personalSpaceClaim(profile("alice", "Alice II"), 1), ALICE)).toBe(true);
    // Nobody else's is, whether a member or not, and the owner cannot turn it into a team space.
    expect(model.claim(personalSpaceClaim(ALICE, 1), BOB)).toBe(false);
    expect(model.claim(personalSpaceClaim(ALICE, 1), CAROL)).toBe(false);
    expect(model.claim({ key: "~alice", name: "Team", kind: "team" }, ALICE)).toBe(false);

    expect(model.info).toEqual({ key: "~alice", name: "Alice", kind: "personal", owner: ALICE });
    expect(model.listMembers(ALICE.id)).toEqual(members);
  });

  it("leaves the key unclaimed when it cannot make the creator an admin", () => {
    let storage = makeSpaceStorage(makeMockStorage());
    let model = new SpaceModel(storage);
    vi.spyOn(storage.members, "put").mockImplementationOnce(() => { throw new Error("too big"); });
    expect(() => model.claim(teamSpaceClaim("eng", "Alice's"), ALICE)).toThrow("too big");

    expect(model.info).toBeUndefined();
    expect(model.claim(teamSpaceClaim("eng", "Bob's"), BOB)).toBe(true);
    expect(model.listMembers(BOB.id)).toMatchObject([{ profile: BOB, role: "admin" }]);
  });
});

describe("SpaceModel membership", () => {
  it("refuses anyone but an admin before a username is looked up", () => {
    let model = teamSpace();
    model.setMemberRole(ALICE.id, BOB, "build");
    model.requireAdmin(ALICE.id);
    expect(() => model.requireAdmin(BOB.id)).toThrow(ADMINS_ONLY);
    expect(() => model.requireAdmin(CAROL.id)).toThrow(NO_SUCH_SPACE);
    expect(() => model.setMemberRole(BOB.id, CAROL, "use")).toThrow(ADMINS_ONLY);
    expect(() => model.setMemberRole(CAROL.id, CAROL, "admin")).toThrow(NO_SUCH_SPACE);
    expect(roles(model)).toEqual({ alice: "admin", bob: "build" });
  });

  it("sets a role exactly: adds, raises and lowers, keeping when the member was added", () => {
    let storage = makeSpaceStorage(makeMockStorage());
    let model = teamSpace(storage);
    expect(model.setMemberRole(ALICE.id, BOB, "use")).toMatchObject({ profile: BOB, role: "use" });
    expect(model.infoFor(BOB.id)).toMatchObject({ key: "eng", role: "use" });

    // As if he had been added long ago, so that a role change stamping the date anew would show.
    let added = new Date("2020-01-01");
    storage.members.put({ profile: BOB, role: "use", added });
    expect(model.setMemberRole(ALICE.id, profile("bob", "Robert"), "admin"))
        .toEqual({ profile: profile("bob", "Robert"), role: "admin", added });
    expect(model.setMemberRole(ALICE.id, BOB, "build")).toEqual({ profile: BOB, role: "build", added });
    expect(model.roleOf(BOB.id)).toBe("build");
    // Any member lists the members, and nobody else does.
    expect(model.listMembers(BOB.id).map(m => m.profile.id)).toEqual(["alice", "bob"]);
    expect(() => model.listMembers(CAROL.id)).toThrow(NO_SUCH_SPACE);
  });

  it("lets an admin remove anyone and any other member only themself", () => {
    let model = teamSpace();
    model.setMemberRole(ALICE.id, BOB, "build");
    model.setMemberRole(ALICE.id, CAROL, "use");

    expect(() => model.removeMember(BOB.id, CAROL.id))
        .toThrow("Only an admin of this space can remove other members.");
    expect(model.removeMember(BOB.id, BOB.id)).toBe(true);
    // Having left, they are a stranger: even removing themself again is refused.
    expect(() => model.removeMember(BOB.id, BOB.id)).toThrow(NO_SUCH_SPACE);
    // Removing someone who is not a member does nothing.
    expect(model.removeMember(ALICE.id, BOB.id)).toBe(false);
    expect(model.removeMember(ALICE.id, CAROL.id)).toBe(true);
    expect(roles(model)).toEqual({ alice: "admin" });
  });

  it("never demotes or removes a space's last admin", () => {
    let model = teamSpace();
    model.setMemberRole(ALICE.id, BOB, "build");
    expect(() => model.setMemberRole(ALICE.id, ALICE, "build")).toThrow(LAST_ADMIN);
    expect(() => model.removeMember(ALICE.id, ALICE.id)).toThrow(LAST_ADMIN);
    expect(roles(model)).toEqual({ alice: "admin", bob: "build" });

    // With a second admin either of them can step down or leave.
    model.setMemberRole(ALICE.id, BOB, "admin");
    model.setMemberRole(BOB.id, ALICE, "use");
    expect(() => model.removeMember(BOB.id, BOB.id)).toThrow(LAST_ADMIN);
    expect(model.removeMember(ALICE.id, ALICE.id)).toBe(true);
    expect(model.listMembers(BOB.id)).toMatchObject([{ profile: BOB, role: "admin" }]);
  });

  it("keeps a personal space's owner as its only admin", () => {
    let model = personalSpace();
    expect(model.setMemberRole(ALICE.id, BOB, "build")).toMatchObject({ role: "build" });
    expect(() => model.setMemberRole(ALICE.id, BOB, "admin"))
        .toThrow("The owner of a personal space is its only admin.");
    expect(() => model.setMemberRole(ALICE.id, ALICE, "build")).toThrow(LAST_ADMIN);
    expect(() => model.removeMember(ALICE.id, ALICE.id)).toThrow(LAST_ADMIN);
    // Setting the owner to the role they hold is allowed and changes nothing.
    expect(model.setMemberRole(ALICE.id, ALICE, "admin")).toMatchObject({ role: "admin" });
    expect(roles(model)).toEqual({ alice: "admin", bob: "build" });

    // Its other members are ordinary: they see the member list and can leave.
    expect(model.infoFor(BOB.id)).toMatchObject({ kind: "personal", owner: ALICE, role: "build" });
    expect(model.removeMember(BOB.id, BOB.id)).toBe(true);
    expect(roles(model)).toEqual({ alice: "admin" });
  });
});

// A registration of workspace `id`, and what a space lists as "owner: title" by workspace id.
const ws = (id: string, title = id, created = new Date("2026-01-01")) => ({ id, title, created });
const titles = (model: SpaceModel) =>
    Object.fromEntries(model.listWorkspaces(ALICE.id).map(w => [w.id, `${w.owner.id}: ${w.title}`]));

describe("SpaceModel workspaces", () => {
  it("takes workspaces from any member of a team space and only the owner of a personal one", () => {
    let team = teamSpace();
    team.setMemberRole(ALICE.id, BOB, "use");
    expect(team.attachWorkspaces(BOB, [ws("b1")])).toBe(true);
    expect(team.canAddWorkspaces(CAROL.id)).toBe(false);
    expect(team.attachWorkspaces(CAROL, [ws("c1")])).toBe(false);
    expect(titles(team)).toEqual({ b1: "bob: b1" });

    let personal = personalSpace();
    personal.setMemberRole(ALICE.id, BOB, "build");
    expect(personal.attachWorkspaces(ALICE, [ws("a1")])).toBe(true);
    expect(personal.attachWorkspaces(BOB, [ws("b1")])).toBe(false);
    expect(titles(personal)).toEqual({ a1: "alice: a1" });

    // A key nobody has claimed lists nothing for anyone.
    let unclaimed = new SpaceModel(makeSpaceStorage(makeMockStorage()));
    expect(unclaimed.attachWorkspaces(ALICE, [ws("a1")])).toBe(false);
  });

  it("refuses a whole call, changing nothing, over one workspace listed under someone else", () => {
    let model = teamSpace();
    model.setMemberRole(ALICE.id, BOB, "build");
    expect(model.attachWorkspaces(ALICE, [ws("a1", "Alice's")])).toBe(true);
    expect(model.attachWorkspaces(BOB, [ws("b1"), ws("a1", "Taken over")])).toBe(false);
    expect(titles(model)).toEqual({ a1: "alice: Alice's" });
  });

  it("keeps updating a workspace for an owner who has left, and takes nothing new from them", () => {
    let model = teamSpace();
    model.setMemberRole(ALICE.id, BOB, "build");
    expect(model.attachWorkspaces(BOB, [ws("b1", "Before")])).toBe(true);
    model.removeMember(ALICE.id, BOB.id);

    expect(model.attachWorkspaces(BOB, [ws("b1", "After")])).toBe(true);
    expect(model.attachWorkspaces(BOB, [ws("b1", "Smuggled"), ws("b2")])).toBe(false);
    expect(titles(model)).toEqual({ b1: "bob: After" });
  });

  it("detaches a workspace only for the owner it is listed under", () => {
    let model = teamSpace();
    model.setMemberRole(ALICE.id, BOB, "build");
    model.attachWorkspaces(BOB, [ws("b1")]);
    model.detachWorkspace("b1", ALICE.id);
    model.detachWorkspace("never-listed", BOB.id);
    expect(titles(model)).toEqual({ b1: "bob: b1" });
    model.detachWorkspace("b1", BOB.id);
    expect(titles(model)).toEqual({});
  });

  it("lists workspaces newest first, to members only", () => {
    let model = teamSpace();
    model.setMemberRole(ALICE.id, BOB, "use");
    model.attachWorkspaces(ALICE, [
      ws("mid", "Mid", new Date("2026-02-01")), ws("new", "New", new Date("2026-03-01")),
      ws("old", "Old", new Date("2026-01-01")),
    ]);
    expect(model.listWorkspaces(BOB.id)[0])
        .toEqual({ id: "new", title: "New", owner: ALICE, created: new Date("2026-03-01") });
    expect(model.listWorkspaces(BOB.id).map(w => w.id)).toEqual(["new", "mid", "old"]);
    expect(() => model.listWorkspaces(CAROL.id)).toThrow(NO_SUCH_SPACE);
  });
});

// =======================================================================================
// The real Durable Objects

function unique(): string {
  return crypto.randomUUID().slice(0, 8);
}

// A signed-in user under `id`, in the User DO the kernel addresses by that profile id.
async function signUp(id: string): Promise<AiChatAuthorInfo> {
  await env.TEST_USER.getByName(id).authenticateFromCfAccess(id, true);
  return profile(id, id.split("@")[0]);
}

// A team space under a fresh key, claimed by `creator` the way AuthenticatedApi.createSpace does.
async function createTeamSpace(creator: AiChatAuthorInfo): Promise<string> {
  let key = `team-${unique()}`;
  expect(await env.TEST_SPACE.getByName(key).claim(teamSpaceClaim(key, "Team"), creator)).toBe(true);
  return key;
}

// The space as `profileId` opens it, which a member can.
async function open(key: string, profileId: string) {
  let space = await env.TEST_SPACE.getByName(key).open(profileId);
  if (!space) throw new Error(`${profileId} could not open ${key}.`);
  return space;
}

// What `profileId`'s own listing holds for the space, if anything.
async function listed(profileId: string, key: string): Promise<SpaceInfo | undefined> {
  return (await env.TEST_USER.getByName(profileId).listSpaces()).find(space => space.key === key);
}

// Await a stub call's rejection with a single handler: expect(...).rejects forks the underlying
// JsRpcPromise, and the leftover copy is reported as an unhandled rejection (see
// user-directory.test.ts).
async function expectRejection(call: PromiseLike<unknown>, message: string): Promise<void> {
  let caught: unknown;
  let rejected = false;
  try { await call; } catch (err) { rejected = true; caught = err; }
  expect(rejected).toBe(true);
  expect(String(caught)).toContain(message);
}

// Makes `change` while every push of the given kind to a member's mirror is lost.
async function withLostPush<T>(
    push: "recordSpaceMembership" | "forgetSpace", change: () => Promise<T>): Promise<T> {
  let lost = vi.spyOn(UserDurableObject.prototype, push)
      .mockRejectedValue(new Error("user DO unavailable"));
  try {
    return await change();
  } finally {
    lost.mockRestore();
  }
}

describe("SpaceDurableObject", () => {
  it("gives a key claimed twice at once to exactly one claimant", async () => {
    let [alice, bob] = await Promise.all([signUp(`alice-${unique()}`), signUp(`bob-${unique()}`)]);
    let key = `team-${unique()}`;
    let stub = env.TEST_SPACE.getByName(key);
    let granted = await Promise.all([
      stub.claim(teamSpaceClaim(key, "Alice's"), alice),
      stub.claim(teamSpaceClaim(key, "Bob's"), bob),
    ]);
    expect(granted.filter(Boolean)).toHaveLength(1);
    let [winner, loser] = granted[0] ? [alice, bob] : [bob, alice];

    expect(await stub.open(loser.id)).toBeNull();
    using space = await open(key, winner.id);
    expect(await space.getInfo()).toEqual(
        { key, name: granted[0] ? "Alice's" : "Bob's", kind: "team", role: "admin" });
    expect(await space.listMembers()).toMatchObject([{ profile: winner, role: "admin" }]);
  });

  it("answers a non-member and an unclaimed key alike", async () => {
    let [alice, bob] = await Promise.all([signUp(`alice-${unique()}`), signUp(`bob-${unique()}`)]);
    let key = await createTeamSpace(alice);
    expect(await env.TEST_SPACE.getByName(key).open(bob.id)).toBeNull();
    expect(await env.TEST_SPACE.getByName(`team-${unique()}`).open(bob.id)).toBeNull();

    // Past open() the two still share one refusal, whatever the method.
    for (let space of [key, `team-${unique()}`].map(k => env.TEST_SPACE.getByName(k))) {
      await expectRejection(space.getInfo(bob.id), NO_SUCH_SPACE);
      await expectRejection(space.listMembers(bob.id), NO_SUCH_SPACE);
      await expectRejection(space.listWorkspaces(bob.id), NO_SUCH_SPACE);
      await expectRejection(space.setMemberRole(bob.id, bob.id, "admin"), NO_SUCH_SPACE);
      await expectRejection(space.removeMember(bob.id, bob.id), NO_SUCH_SPACE);
    }
    expect(await listed(bob.id, key)).toBeUndefined();
  });

  it("resolves a username only for an admin, and to null when no account has it", async () => {
    let [alice, bob] = await Promise.all([signUp(`alice-${unique()}`), signUp(`bob-${unique()}`)]);
    let key = await createTeamSpace(alice);
    using asAlice = await open(key, alice.id);
    expect(await asAlice.setMemberRole(bob.id, "use")).toMatchObject({ profile: bob, role: "use" });
    using asBob = await open(key, bob.id);

    // A member who is not an admin gets the same refusal whether or not the account exists.
    let nobody = `nobody-${unique()}`;
    await expectRejection(asBob.setMemberRole(nobody, "use"), ADMINS_ONLY);
    await expectRejection(asBob.setMemberRole(alice.id, "use"), ADMINS_ONLY);
    expect(await asAlice.setMemberRole(nobody, "use")).toBeNull();
    expect((await asAlice.listMembers()).map(m => m.profile.id).toSorted())
        .toEqual([alice.id, bob.id].toSorted());
  });

  it("takes a live stub's powers away the moment its member is removed or demoted", async () => {
    let [alice, bob, carol] = await Promise.all(
        [signUp(`alice-${unique()}`), signUp(`bob-${unique()}`), signUp(`carol-${unique()}`)]);
    let key = await createTeamSpace(alice);
    using asAlice = await open(key, alice.id);
    await asAlice.setMemberRole(bob.id, "admin");
    await asAlice.setMemberRole(carol.id, "use");
    using asBob = await open(key, bob.id);
    using asCarol = await open(key, carol.id);

    // Demoted: still a member, no longer an admin.
    await asAlice.setMemberRole(bob.id, "build");
    expect(await asBob.getInfo()).toMatchObject({ key, role: "build" });
    await expectRejection(asBob.setMemberRole(carol.id, "build"), ADMINS_ONLY);
    await expectRejection(asBob.removeMember(carol.id),
        "Only an admin of this space can remove other members.");

    // Removed: every method refuses, as it would a stranger.
    await asAlice.removeMember(carol.id);
    await expectRejection(asCarol.getInfo(), NO_SUCH_SPACE);
    await expectRejection(asCarol.listMembers(), NO_SUCH_SPACE);
    await expectRejection(asCarol.listWorkspaces(), NO_SUCH_SPACE);
    await expectRejection(asCarol.setMemberRole(carol.id, "use"), NO_SUCH_SPACE);
    await expectRejection(asCarol.removeMember(carol.id), NO_SUCH_SPACE);
    expect(await env.TEST_SPACE.getByName(key).open(carol.id)).toBeNull();
  });

  it("mirrors a membership to its member: added, changed and removed", async () => {
    let [alice, bob] = await Promise.all([signUp(`alice-${unique()}`), signUp(`bob-${unique()}`)]);
    let key = await createTeamSpace(alice);
    // Claiming records nothing; the creator's listing gets the space when they open it.
    expect(await listed(alice.id, key)).toBeUndefined();
    using asAlice = await open(key, alice.id);
    expect(await listed(alice.id, key)).toEqual({ key, name: "Team", kind: "team", role: "admin" });

    let added = await asAlice.setMemberRole(bob.id, "use");
    expect(await listed(bob.id, key)).toEqual({ key, name: "Team", kind: "team", role: "use" });
    let changed = await asAlice.setMemberRole(bob.id, "build");
    expect(changed).toEqual({ ...added, role: "build" });
    expect(await listed(bob.id, key)).toMatchObject({ role: "build" });

    using asBob = await open(key, bob.id);
    await asBob.removeMember(bob.id);
    expect(await listed(bob.id, key)).toBeUndefined();
    expect(await listed(alice.id, key)).toMatchObject({ role: "admin" });
  });

  it("keeps a membership change whose mirror push fails, and heals the mirror on the next open",
      async () => {
    let [alice, bob] = await Promise.all([signUp(`alice-${unique()}`), signUp(`bob-${unique()}`)]);
    let key = await createTeamSpace(alice);
    using asAlice = await open(key, alice.id);

    // The member list is the authority: he opens a space his listing never heard of, and opening
    // it is what lists it.
    expect(await withLostPush("recordSpaceMembership", () => asAlice.setMemberRole(bob.id, "use")))
        .toMatchObject({ profile: bob, role: "use" });
    expect(await listed(bob.id, key)).toBeUndefined();
    using asBob = await open(key, bob.id);
    expect(await listed(bob.id, key)).toMatchObject({ role: "use" });

    // Removed all the same, and the refusal is what drops the entry his listing still holds.
    await withLostPush("forgetSpace", () => asAlice.removeMember(bob.id));
    expect(await listed(bob.id, key)).toMatchObject({ role: "use" });
    await expectRejection(asBob.getInfo(), NO_SUCH_SPACE);
    expect(await env.TEST_SPACE.getByName(key).open(bob.id)).toBeNull();
    expect(await listed(bob.id, key)).toBeUndefined();
  });
});

describe("personal space allocation", () => {
  it("claims one personal space per user, however many callers ask at once", async () => {
    let name = `dana-${unique()}`;
    let dana = await signUp(`${name}@a.example`);
    let user = env.TEST_USER.getByName(dana.id);
    let personal = { key: `~${name}`, name, kind: "personal", owner: dana, role: "admin" };
    expect(await Promise.all([user.listSpaces(), user.listSpaces(), user.listSpaces()]))
        .toEqual([[personal], [personal], [personal]]);
    expect(await user.listSpaces()).toEqual([personal]);

    using space = await open(personal.key, dana.id);
    expect(await space.getInfo()).toEqual(personal);
    expect(await space.listMembers()).toMatchObject([{ profile: dana, role: "admin" }]);
    // The next candidate was never touched.
    expect(await env.TEST_SPACE.getByName(`~${name}-2`).open(dana.id)).toBeNull();
  });

  it("gives a user whose key is taken the next one, and lists other spaces after their own", async () => {
    let name = `sam-${unique()}`;
    let first = await signUp(`${name}@a.example`);
    let second = await signUp(`${name}@b.example`);
    expect((await env.TEST_USER.getByName(first.id).listSpaces()).map(s => s.key)).toEqual([`~${name}`]);

    // The second user is a member of the first's personal space and of two team spaces before
    // their own exists; it still comes first, and the rest follow by name.
    using asFirst = await open(`~${name}`, first.id);
    await asFirst.setMemberRole(second.id, "build");
    for (let teamName of ["Zebra", "Aardvark"]) {
      let key = `team-${unique()}`;
      await env.TEST_SPACE.getByName(key).claim(teamSpaceClaim(key, teamName), second);
      (await open(key, second.id))[Symbol.dispose]();
    }
    let spaces = await env.TEST_USER.getByName(second.id).listSpaces();
    expect(spaces.map(s => s.name)).toEqual([name, "Aardvark", name, "Zebra"]);
    expect(spaces[0]).toEqual(
        { key: `~${name}-2`, name, kind: "personal", owner: second, role: "admin" });
    expect(spaces[2]).toEqual(
        { key: `~${name}`, name, kind: "personal", owner: first, role: "build" });
    expect(await env.TEST_SPACE.getByName(`~${name}`).claim(personalSpaceClaim(second, 1), second))
        .toBe(false);
  });

  it("resumes an allocation that claimed a key and never recorded it", async () => {
    let name = `erin-${unique()}`;
    let erin = await signUp(`${name}@a.example`);
    // What a User DO leaves behind when it stops between the claim and remembering the key.
    let claim = personalSpaceClaim(erin, 1);
    expect(await env.TEST_SPACE.getByName(claim.key).claim(claim, erin)).toBe(true);

    expect(await env.TEST_USER.getByName(erin.id).listSpaces())
        .toEqual([{ ...claim, owner: erin, role: "admin" }]);
    expect(await env.TEST_SPACE.getByName(`~${name}-2`).open(erin.id)).toBeNull();
  });
});
