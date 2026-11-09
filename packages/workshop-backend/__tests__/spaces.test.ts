// Spaces: space ids and SpaceModel's membership and listing rules over a Map-backed storage,
// then the real Durable Objects -- a space, and the users whose memberships it mirrors. The
// users' side of the listing is spaces-workspaces.test.ts.

import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { describe, expect, it, vi } from "vitest";
import type { AiChatAuthorInfo, PublicApi, SpaceInfo } from "@gadgets/workshop-shared/api";
import server from "../src/server.js";
import {
  SpaceModel, spaceById, teamSpaceName, type SpaceDurableObject,
} from "../src/spaces.js";
import { makeSpaceStorage } from "../src/storage-schema/space-storage.js";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";
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

const INVALID_SPACE_ID = "Invalid space id.";
const NO_SUCH_SPACE = "No such space, or you are not a member of it.";
const ADMINS_ONLY = "Only an admin of this space can change its members.";
const LAST_ADMIN = "A space must keep at least one admin.";
const NO_MEMBERS = "A personal space has no members.";
const SPACE_NAME_RULE = "A space name is 1 to 100 characters.";

function profile(id: string, name = id): AiChatAuthorInfo {
  return { type: "user", id, name };
}

const ALICE = profile("alice", "Alice");
const BOB = profile("bob", "Bob");
const CAROL = profile("carol", "Carol");

function teamSpace(storage = makeSpaceStorage(makeMockStorage())): SpaceModel {
  let model = new SpaceModel(storage, "eng");
  expect(model.create({ name: "Engineering", kind: "team" }, ALICE)).toBe(true);
  return model;
}

function personalSpace(): SpaceModel {
  let model = new SpaceModel(makeSpaceStorage(makeMockStorage()), "alice-home");
  expect(model.create({ name: "Alice", kind: "personal" }, ALICE)).toBe(true);
  return model;
}

function roles(model: SpaceModel): Record<string, string> {
  return Object.fromEntries(model.listMembers(ALICE.id).map(m => [m.profile.id, m.role]));
}

describe("space ids", () => {
  it("refuses whatever is not an id of the spaces namespace, with one error", () => {
    let id = env.TEST_SPACE.newUniqueId().toString();
    let malformed = ["", "eng", "Design", "not-an-id", id.slice(1), `${id}0`, ` ${id}`];
    // Well formed, and of no space: ids are checked against the namespace they are opened in.
    let foreign = [
      "0".repeat(64), env.TEST_USER.newUniqueId().toString(),
      env.TEST_USER.idFromName("alice").toString(),
    ];
    for (let bad of [...malformed, ...foreign]) {
      expect(() => spaceById(env.TEST_SPACE, bad), JSON.stringify(bad)).toThrow(INVALID_SPACE_ID);
    }
  });

  it("addresses a space by any spelling of its id", () => {
    for (let id of [env.TEST_SPACE.newUniqueId(), env.TEST_SPACE.idFromName("alice")].map(String)) {
      expect(spaceById(env.TEST_SPACE, id).id.toString()).toBe(id);
      expect(spaceById(env.TEST_SPACE, id.toUpperCase()).id.toString()).toBe(id);
    }
  });

  it("bounds a team space's name once trimmed", () => {
    expect(teamSpaceName("  Team  ")).toBe("Team");
    expect(teamSpaceName("n".repeat(100))).toHaveLength(100);
    for (let name of ["", "   ", "n".repeat(101)]) {
      expect(() => teamSpaceName(name)).toThrow(SPACE_NAME_RULE);
    }
  });
});

describe("SpaceModel.create", () => {
  it("creates a space once and changes nothing after", () => {
    let model = new SpaceModel(makeSpaceStorage(makeMockStorage()), "eng");
    expect(model.info).toBeUndefined();
    expect(model.infoFor(ALICE.id)).toBeUndefined();

    expect(model.create({ name: "Engineering", kind: "team" }, ALICE)).toBe(true);
    expect(model.infoFor(ALICE.id))
        .toEqual({ id: "eng", name: "Engineering", kind: "team", role: "admin" });
    // The id is the model's to report, and no part of what the space stores.
    expect(model.info).toEqual({ name: "Engineering", kind: "team" });
    let members = model.listMembers(ALICE.id);
    expect(members).toMatchObject([{ profile: ALICE, role: "admin" }]);

    // Neither another user nor the creator creates it again, as either kind: a team space was
    // created for nobody in particular.
    expect(model.create({ name: "Hijacked", kind: "team" }, BOB)).toBe(false);
    expect(model.create({ name: "Renamed", kind: "team" }, ALICE)).toBe(false);
    expect(model.create({ name: "Mine", kind: "personal" }, ALICE)).toBe(false);
    expect(model.info).toEqual({ name: "Engineering", kind: "team" });
    expect(model.listMembers(ALICE.id)).toEqual(members);
    expect(model.roleOf(BOB.id)).toBeUndefined();
  });

  it("reports a personal space as created for its owner, any number of times", () => {
    let model = personalSpace();
    expect(model.info).toEqual({ name: "Alice", kind: "personal", owner: ALICE });
    let members = model.listMembers(ALICE.id);
    expect(members).toMatchObject([{ profile: ALICE, role: "admin" }]);

    // It is the owner's whatever they ask for, and stays as it was first created: under the
    // name they had then, and personal.
    expect(model.create({ name: "Alice II", kind: "personal" }, ALICE)).toBe(true);
    expect(model.create({ name: "Team", kind: "team" }, ALICE)).toBe(true);
    // It is nobody else's.
    expect(model.create({ name: "Alice", kind: "personal" }, BOB)).toBe(false);
    expect(model.create({ name: "Carol", kind: "personal" }, CAROL)).toBe(false);

    expect(model.info).toEqual({ name: "Alice", kind: "personal", owner: ALICE });
    expect(model.listMembers(ALICE.id)).toEqual(members);
  });

  it("leaves no space when it cannot make the creator an admin", () => {
    let storage = makeSpaceStorage(makeMockStorage());
    let model = new SpaceModel(storage, "eng");
    vi.spyOn(storage.members, "put").mockImplementationOnce(() => { throw new Error("too big"); });
    expect(() => model.create({ name: "Alice's", kind: "team" }, ALICE)).toThrow("too big");

    expect(model.info).toBeUndefined();
    expect(model.create({ name: "Bob's", kind: "team" }, BOB)).toBe(true);
    expect(model.listMembers(BOB.id)).toMatchObject([{ profile: BOB, role: "admin" }]);
  });
});

describe("SpaceModel membership", () => {
  it("refuses anyone but an admin before a username is looked up", () => {
    let model = teamSpace();
    model.setMemberRole(ALICE.id, BOB, "build");
    model.requireMembershipAdmin(ALICE.id);
    expect(() => model.requireMembershipAdmin(BOB.id)).toThrow(ADMINS_ONLY);
    expect(() => model.requireMembershipAdmin(CAROL.id)).toThrow(NO_SUCH_SPACE);
    expect(() => model.setMemberRole(BOB.id, CAROL, "use")).toThrow(ADMINS_ONLY);
    expect(() => model.setMemberRole(CAROL.id, CAROL, "admin")).toThrow(NO_SUCH_SPACE);
    expect(roles(model)).toEqual({ alice: "admin", bob: "build" });
  });

  it("sets a role exactly: adds, raises and lowers, keeping when the member was added", () => {
    let storage = makeSpaceStorage(makeMockStorage());
    let model = teamSpace(storage);
    expect(model.setMemberRole(ALICE.id, BOB, "use")).toMatchObject({ profile: BOB, role: "use" });
    expect(model.infoFor(BOB.id)).toMatchObject({ id: "eng", role: "use" });

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

  it("gives a personal space no member besides its owner, whoever the target and role", () => {
    let model = personalSpace();
    for (let target of [BOB, ALICE]) {
      for (let role of ["admin", "build", "use"] as const) {
        expect(() => model.setMemberRole(ALICE.id, target, role)).toThrow(NO_MEMBERS);
      }
    }
    // Refused before any username is looked up, and to anyone else as to a stranger.
    expect(() => model.requireMembershipAdmin(ALICE.id)).toThrow(NO_MEMBERS);
    expect(() => model.requireMembershipAdmin(BOB.id)).toThrow(NO_SUCH_SPACE);
    expect(() => model.setMemberRole(BOB.id, BOB, "admin")).toThrow(NO_SUCH_SPACE);
    // Its owner, its only admin, can neither leave nor be removed.
    expect(() => model.removeMember(ALICE.id, ALICE.id)).toThrow(LAST_ADMIN);
    expect(roles(model)).toEqual({ alice: "admin" });
    expect(model.infoFor(ALICE.id))
        .toMatchObject({ kind: "personal", owner: ALICE, role: "admin" });
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
    expect(personal.attachWorkspaces(ALICE, [ws("a1")])).toBe(true);
    expect(personal.attachWorkspaces(BOB, [ws("b1")])).toBe(false);
    expect(titles(personal)).toEqual({ a1: "alice: a1" });

    // A space never created lists nothing for anyone.
    let none = new SpaceModel(makeSpaceStorage(makeMockStorage()), "none");
    expect(none.attachWorkspaces(ALICE, [ws("a1")])).toBe(false);
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

// A team space, created by `creator` under an id made for it, the way
// AuthenticatedApi.createSpace does.
async function createTeamSpace(creator: AiChatAuthorInfo): Promise<string> {
  let id = env.TEST_SPACE.newUniqueId().toString();
  expect(await spaceById(env.TEST_SPACE, id).create({ name: "Team", kind: "team" }, creator))
      .toBe(true);
  return id;
}

// The space as `profileId` opens it, which a member can.
async function open(id: string, profileId: string) {
  let space = await spaceById(env.TEST_SPACE, id).open(profileId);
  if (!space) throw new Error(`${profileId} could not open ${id}.`);
  return space;
}

// What `profileId`'s own listing holds for the space, if anything.
async function listed(profileId: string, id: string): Promise<SpaceInfo | undefined> {
  return (await env.TEST_USER.getByName(profileId).listSpaces()).find(space => space.id === id);
}

// What `profileId`'s own Durable Object stores of their spaces and workspaces, read as it is:
// no method is called that would create a space or leave a record out.
const storedBy = (profileId: string) => runInDurableObject(env.TEST_USER.getByName(profileId),
    (_instance, state) => {
      let { spaces, gadgets } = makeUserStorage(state.storage);
      return { spaces: [...spaces.list()], workspaces: [...gadgets.list()] };
    });

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
  it("creates one space however many creations race for its id", async () => {
    let [alice, bob] = await Promise.all([signUp(`alice-${unique()}`), signUp(`bob-${unique()}`)]);
    let id = env.TEST_SPACE.newUniqueId().toString();
    let stub = spaceById(env.TEST_SPACE, id);
    let created = await Promise.all([
      stub.create({ name: "Alice's", kind: "team" }, alice),
      stub.create({ name: "Bob's", kind: "team" }, bob),
    ]);
    expect(created.filter(Boolean)).toHaveLength(1);
    let [winner, loser] = created[0] ? [alice, bob] : [bob, alice];

    expect(await stub.open(loser.id)).toBeNull();
    using space = await open(id, winner.id);
    expect(await space.getInfo()).toEqual(
        { id, name: created[0] ? "Alice's" : "Bob's", kind: "team", role: "admin" });
    expect(await space.listMembers()).toMatchObject([{ profile: winner, role: "admin" }]);
  });

  it("answers a non-member, another user's personal space and a space never created alike",
      async () => {
    let [alice, bob] = await Promise.all([signUp(`alice-${unique()}`), signUp(`bob-${unique()}`)]);
    let team = await createTeamSpace(alice);
    let [{ id: personal }] = await env.TEST_USER.getByName(alice.id).listSpaces();
    expect(personal).toBe(env.TEST_SPACE.idFromName(alice.id).toString());
    let ids = [team, personal, env.TEST_SPACE.newUniqueId().toString()];

    for (let space of ids.map(id => spaceById(env.TEST_SPACE, id))) {
      expect(await space.open(bob.id)).toBeNull();
      // Past open() they still share one refusal, whatever the method.
      await expectRejection(space.getInfo(bob.id), NO_SUCH_SPACE);
      await expectRejection(space.listMembers(bob.id), NO_SUCH_SPACE);
      await expectRejection(space.listWorkspaces(bob.id), NO_SUCH_SPACE);
      await expectRejection(space.setMemberRole(bob.id, bob.id, "admin"), NO_SUCH_SPACE);
      await expectRejection(space.removeMember(bob.id, bob.id), NO_SUCH_SPACE);
    }
    for (let id of ids) expect(await listed(bob.id, id)).toBeUndefined();
  });

  it("takes its id from its own object", async () => {
    let alice = await signUp(`alice-${unique()}`);
    let id = await createTeamSpace(alice);
    // Addressed in another spelling, the space reports its id as it always does, to its member
    // and to the listing that opening it records it in.
    using space = await open(id.toUpperCase(), alice.id);
    expect(await space.getInfo()).toEqual({ id, name: "Team", kind: "team", role: "admin" });
    expect(await listed(alice.id, id)).toEqual({ id, name: "Team", kind: "team", role: "admin" });
    expect(await listed(alice.id, id.toUpperCase())).toBeUndefined();
  });

  it("resolves a username only for an admin, and to null when no account has it", async () => {
    let [alice, bob] = await Promise.all([signUp(`alice-${unique()}`), signUp(`bob-${unique()}`)]);
    let id = await createTeamSpace(alice);
    using asAlice = await open(id, alice.id);
    expect(await asAlice.setMemberRole(bob.id, "use")).toMatchObject({ profile: bob, role: "use" });
    using asBob = await open(id, bob.id);

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
    let id = await createTeamSpace(alice);
    using asAlice = await open(id, alice.id);
    await asAlice.setMemberRole(bob.id, "admin");
    await asAlice.setMemberRole(carol.id, "use");
    using asBob = await open(id, bob.id);
    using asCarol = await open(id, carol.id);

    // Demoted: still a member, no longer an admin.
    await asAlice.setMemberRole(bob.id, "build");
    expect(await asBob.getInfo()).toMatchObject({ id, role: "build" });
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
    expect(await spaceById(env.TEST_SPACE, id).open(carol.id)).toBeNull();
  });

  it("mirrors a membership to its member: added, changed and removed", async () => {
    let [alice, bob] = await Promise.all([signUp(`alice-${unique()}`), signUp(`bob-${unique()}`)]);
    let id = await createTeamSpace(alice);
    // Creating records nothing; the creator's listing gets the space when they open it.
    expect(await listed(alice.id, id)).toBeUndefined();
    using asAlice = await open(id, alice.id);
    expect(await listed(alice.id, id)).toEqual({ id, name: "Team", kind: "team", role: "admin" });

    let added = await asAlice.setMemberRole(bob.id, "use");
    expect(await listed(bob.id, id)).toEqual({ id, name: "Team", kind: "team", role: "use" });
    let changed = await asAlice.setMemberRole(bob.id, "build");
    expect(changed).toEqual({ ...added, role: "build" });
    expect(await listed(bob.id, id)).toMatchObject({ role: "build" });

    using asBob = await open(id, bob.id);
    await asBob.removeMember(bob.id);
    expect(await listed(bob.id, id)).toBeUndefined();
    expect(await listed(alice.id, id)).toMatchObject({ role: "admin" });
  });

  it("keeps a membership change whose mirror push fails, and heals the mirror on the next open",
      async () => {
    let [alice, bob] = await Promise.all([signUp(`alice-${unique()}`), signUp(`bob-${unique()}`)]);
    let id = await createTeamSpace(alice);
    using asAlice = await open(id, alice.id);

    // The member list is the authority: he opens a space his listing never heard of, and opening
    // it is what lists it.
    expect(await withLostPush("recordSpaceMembership", () => asAlice.setMemberRole(bob.id, "use")))
        .toMatchObject({ profile: bob, role: "use" });
    expect(await listed(bob.id, id)).toBeUndefined();
    using asBob = await open(id, bob.id);
    expect(await listed(bob.id, id)).toMatchObject({ role: "use" });

    // Removed all the same, and the refusal is what drops the entry his listing still holds.
    await withLostPush("forgetSpace", () => asAlice.removeMember(bob.id));
    expect(await listed(bob.id, id)).toMatchObject({ role: "use" });
    await expectRejection(asBob.getInfo(), NO_SUCH_SPACE);
    expect(await spaceById(env.TEST_SPACE, id).open(bob.id)).toBeNull();
    expect(await listed(bob.id, id)).toBeUndefined();
  });
});

describe("personal spaces", () => {
  it("gives a user one personal space, whose id is derived from their profile id, however many callers ask at once",
      async () => {
    let name = `dana-${unique()}`;
    let dana = await signUp(`${name}@a.example`);
    let user = env.TEST_USER.getByName(dana.id);
    let id = env.TEST_SPACE.idFromName(dana.id).toString();
    let personal = { id, name, kind: "personal", owner: dana, role: "admin" };
    // The id names no space until the first of them asks.
    expect(await spaceById(env.TEST_SPACE, id).open(dana.id)).toBeNull();
    expect(await Promise.all([user.listSpaces(), user.listSpaces(), user.listSpaces()]))
        .toEqual([[personal], [personal], [personal]]);
    expect(await user.listSpaces()).toEqual([personal]);

    using space = await open(id, dana.id);
    expect(await space.getInfo()).toEqual(personal);
    expect(await space.listMembers()).toMatchObject([{ profile: dana, role: "admin" }]);
  });

  it("refuses every member change of a personal space, before any username is looked up",
      async () => {
    let name = `fay-${unique()}`;
    let [fay, bob] = await Promise.all([signUp(`${name}@a.example`), signUp(`bob-${unique()}`)]);
    let [{ id }] = await env.TEST_USER.getByName(fay.id).listSpaces();
    using space = await open(id, fay.id);
    let lookups = vi.spyOn(UserDurableObject.prototype, "whoamiIfExists");
    try {
      for (let username of [bob.id, fay.id, `nobody-${unique()}`]) {
        for (let role of ["admin", "build", "use"] as const) {
          await expectRejection(space.setMemberRole(username, role), NO_MEMBERS);
        }
      }
      expect(lookups).not.toHaveBeenCalled();
    } finally {
      lookups.mockRestore();
    }
    expect(await space.listMembers()).toMatchObject([{ profile: fay, role: "admin" }]);
    expect(await listed(bob.id, id)).toBeUndefined();
  });

  it("lists the personal space first and the others by name, whatever they are called",
      async () => {
    let name = `sam-${unique()}`;
    let [sam, twin] =
        await Promise.all([signUp(`${name}@a.example`), signUp(`${name}@b.example`)]);

    // Sam is in three team spaces before their own exists, one named as their own is; it still
    // comes first, and the rest follow by name.
    let named: Record<string, string> = {};
    for (let teamName of ["Zebra", name, "Aardvark"]) {
      let id = named[teamName] = env.TEST_SPACE.newUniqueId().toString();
      let space = spaceById(env.TEST_SPACE, id);
      expect(await space.create({ name: teamName, kind: "team" }, sam)).toBe(true);
      (await open(id, sam.id))[Symbol.dispose]();
    }
    let personal = env.TEST_SPACE.idFromName(sam.id).toString();
    let spaces = await env.TEST_USER.getByName(sam.id).listSpaces();
    expect(spaces.map(s => s.name)).toEqual([name, "Aardvark", name, "Zebra"]);
    expect(spaces[0]).toEqual({ id: personal, name, kind: "personal", owner: sam, role: "admin" });
    expect(spaces[2]).toEqual({ id: named[name], name, kind: "team", role: "admin" });

    // A user whose profile id shares its local part, and so the name, has a space of their own.
    let theirs = env.TEST_SPACE.idFromName(twin.id).toString();
    expect(theirs).not.toBe(personal);
    expect(await env.TEST_USER.getByName(twin.id).listSpaces())
        .toEqual([{ id: theirs, name, kind: "personal", owner: twin, role: "admin" }]);
  });

  it("creates the personal space again when its own record of it is gone, changing nothing",
      async () => {
    let name = `erin-${unique()}`;
    let erin = await signUp(`${name}@a.example`);
    let id = env.TEST_SPACE.idFromName(erin.id).toString();
    // What a User DO leaves behind when it stops between creating the space and recording it.
    let space = spaceById(env.TEST_SPACE, id);
    expect(await space.create({ name, kind: "personal" }, erin)).toBe(true);
    expect((await storedBy(erin.id)).spaces).toEqual([]);

    expect(await env.TEST_USER.getByName(erin.id).listSpaces())
        .toEqual([{ id, name, kind: "personal", owner: erin, role: "admin" }]);
    expect(await space.listMembers(erin.id)).toMatchObject([{ profile: erin, role: "admin" }]);
  });

  it("refuses a personal space that was created for someone else, and records none", async () => {
    let [gil, other] = await Promise.all([signUp(`gil-${unique()}`), signUp(`other-${unique()}`)]);
    let id = env.TEST_SPACE.idFromName(gil.id).toString();
    // No call of the API puts a space at an id derived from a user it was not created for: a
    // team space gets a unique id of its own. This one is planted, straight on the object.
    let space = spaceById(env.TEST_SPACE, id);
    expect(await space.create({ name: "Team", kind: "team" }, other)).toBe(true);

    let user = env.TEST_USER.getByName(gil.id);
    let refused = "This user's personal space was created for someone else.";
    await expectRejection(user.listSpaces(), refused);
    await expectRejection(user.listSpaces(), refused);
    expect((await storedBy(gil.id)).spaces).toEqual([]);

    // The space is as it was: creating it again took nothing over.
    expect(await space.open(gil.id)).toBeNull();
    expect(await space.getInfo(other.id)).toEqual({ id, name: "Team", kind: "team", role: "admin" });
    expect(await space.listMembers(other.id)).toMatchObject([{ profile: other, role: "admin" }]);
  });
});

// =======================================================================================
// The API a client calls

const ORIGIN = "https://workshop.example";
// No admin config is stored: every read of it gets the defaults.
const BLUEPRINTS = { get: async () => null } as unknown as KVNamespace;

// A PublicApi session over the Worker's own /api endpoint.
async function connect(): Promise<RpcStub<PublicApi>> {
  // The first /api request installs the bundled blueprints, which needs storage this test lacks.
  let ctx = createExecutionContext();
  Object.defineProperty(ctx, "exports", { value: Object.create(ctx.exports, {
    AdminSettings: { value: { getByName: () => ({ ensureBundledBlueprintsInstalled: async () => true }) } },
  }) });
  let response = await server.fetch(
      new Request(`${ORIGIN}/api`, { headers: { Upgrade: "websocket", Origin: ORIGIN } }),
      { ...env, BLUEPRINTS, ADMINS: [] } as Cloudflare.Env, ctx);
  expect(response.status).toBe(101);
  let socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

// The session token of a password account under `username`, made directly in its User DO.
async function account(username: string): Promise<string> {
  let secret = await env.TEST_USER.getByName(username)
      .createAccount(username, username, new Uint8Array([1, 2, 3]));
  if (secret === null) throw new Error(`${username} exists already.`);
  return `${username}:${secret}`;
}

// The message a call is refused with.
async function refusal(call: PromiseLike<unknown>): Promise<string> {
  try { await call; } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error("Expected the call to be refused.");
}

describe("AuthenticatedApi", () => {
  it("creates a space under an id of the server's each time, and opens only by an id", async () => {
    let [aliceName, bobName] = [`alice${unique()}`, `bob${unique()}`];
    using api = await connect();
    // Not awaited: every call below is pipelined on the sign-in.
    using alice = api.authenticate(await account(aliceName));
    using bob = api.authenticate(await account(bobName));

    // A name is trimmed and need not be unique: each creation is another space.
    using first = await alice.createSpace("  Design  ");
    using second = await alice.createSpace("Design");
    let [a, b] = [await first.getInfo(), await second.getInfo()];
    let anId = expect.stringMatching(/^[0-9a-f]{64}$/);
    expect(a).toEqual({ id: anId, name: "Design", kind: "team", role: "admin" });
    expect(b).toEqual({ ...a, id: anId });
    expect(b.id).not.toBe(a.id);
    let spaces = await alice.listSpaces();
    expect(spaces[0]).toMatchObject(
        { id: env.TEST_SPACE.idFromName(aliceName).toString(), kind: "personal", role: "admin" });
    expect(spaces.slice(1).map(space => space.id).toSorted()).toEqual([a.id, b.id].toSorted());
    expect(await refusal(alice.createSpace("   "))).toContain(SPACE_NAME_RULE);
    expect((await alice.listSpaces()).map(space => space.id)).toEqual(spaces.map(space => space.id));

    using again = await alice.openSpace(a.id.toUpperCase());
    expect((await again.getInfo()).id).toBe(a.id);

    // An id is not a capability: a space he is no member of, her personal space and an id that
    // names no space refuse him alike.
    let stranger = await refusal(bob.openSpace(a.id));
    expect(stranger).toContain(NO_SUCH_SPACE);
    expect(await refusal(bob.openSpace(spaces[0].id))).toBe(stranger);
    expect(await refusal(bob.openSpace(env.TEST_SPACE.newUniqueId().toString()))).toBe(stranger);
    // So does the id of his own personal space, until he lists his spaces, which creates it.
    let bobsOwn = env.TEST_SPACE.idFromName(bobName).toString();
    expect(await refusal(bob.openSpace(bobsOwn))).toBe(stranger);
    expect((await storedBy(bobName)).spaces).toEqual([]);
    expect((await bob.listSpaces()).map(space => space.id)).toEqual([bobsOwn]);
    using own = await bob.openSpace(bobsOwn);
    expect(await own.getInfo()).toMatchObject({ id: bobsOwn, kind: "personal", role: "admin" });

    // A string that is no space id is refused in one way wherever it is checked: by the Worker
    // for a space to open, by the account for a workspace to create. A space's name is no id.
    let invalid = await refusal(alice.openSpace("not-an-id"));
    expect(invalid).toContain(INVALID_SPACE_ID);
    let notIds = ["", "eng", "Design", "not-an-id", "0".repeat(64),
        env.TEST_USER.newUniqueId().toString()];
    for (let bad of notIds) {
      expect(await refusal(alice.openSpace(bad)), JSON.stringify(bad)).toBe(invalid);
      expect(await refusal(alice.newWorkspace(bad)), JSON.stringify(bad)).toBe(invalid);
    }
    // And records nothing: the account holds no record of a workspace, provisional or not.
    // (listWorkspaces() leaves a provisional one out, so it could not show one.)
    expect((await storedBy(aliceName)).workspaces).toEqual([]);
  });
});
