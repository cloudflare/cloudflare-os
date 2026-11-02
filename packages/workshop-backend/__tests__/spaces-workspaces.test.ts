// Workspaces in spaces: the registrar in UserDurableObject against real Durable Objects -- a
// user's records of their workspaces, and the spaces that list them. The rules a space applies
// to its listing are SpaceModel's, in spaces.test.ts.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { SpaceDurableObject, teamSpaceClaim } from "../src/spaces.js";
import { makeUserStorage, type GadgetRecord } from "../src/storage-schema/user-storage.js";
import type { UserDurableObject } from "../src/user.js";
// Load the whole backend up front, so that its slow load is not billed to the first test.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_SPACE: DurableObjectNamespace<SpaceDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

type Account = {
  profile: AiChatAuthorInfo;
  user: DurableObjectStub<UserDurableObject>;
  /** The key of their personal space. */
  personal: string;
};

const NO_SUCH_SPACE = "No such space, or you are not a member of it.";
// Shorter than the test timeout, so that a wait which runs out fails with its own assertion.
const WAIT = { timeout: 4_000 };
const unique = () => crypto.randomUUID().slice(0, 8);

// A signed-in user. Listing their spaces allocates their personal space and also spends their
// object's one catch-up while they have no workspace, so that whatever a test then observes was
// done by the sync it caused.
async function signUp(name: string): Promise<Account> {
  let id = `${name}-${unique()}`;
  let user = env.TEST_USER.getByName(id);
  await user.authenticateFromCfAccess(id, true);
  let [personal] = await user.listSpaces();
  return { profile: { type: "user", id, name: id }, user, personal: personal.key };
}

// A team space under a fresh key, created by `admin` and with `members` in the lowest role.
async function teamSpace(admin: Account, ...members: Account[]): Promise<string> {
  let key = `team-${unique()}`;
  let space = env.TEST_SPACE.getByName(key);
  expect(await space.claim(teamSpaceClaim(key, "Team"), admin.profile)).toBe(true);
  for (let member of members) {
    await space.setMemberRole(admin.profile.id, member.profile.id, "use");
  }
  return key;
}

// A workspace as AuthenticatedApi.newGadget leaves it: provisional, and belonging to team space
// `spaceKey` or with none to its owner's personal space.
async function newWorkspace(owner: Account, spaceKey?: string): Promise<string> {
  let id = `ws-${unique()}`;
  await owner.user.newGadget(id, "Untitled", spaceKey);
  return id;
}

// What a workspace's Overseer reports when it sees activity. The sync this starts is detached.
function touch(owner: Account, id: string): Promise<void> {
  return owner.user.setGadgetLastActive(id, new Date(), undefined);
}

// The owner's stored record of a workspace, with the marker that no caller is handed.
function stored(owner: Account, id: string): Promise<GadgetRecord | undefined> {
  return runInDurableObject(owner.user, (_instance, state) =>
      makeUserStorage(state.storage).gadgets.get(id));
}

// Waits for a detached sync to leave the workspace acknowledged by `spaceKey` under `title`.
async function synced(owner: Account, id: string, spaceKey: string, title = "Untitled") {
  await vi.waitFor(async () =>
      expect((await stored(owner, id))?.registered).toEqual({ spaceKey, title }), WAIT);
}

// A workspace that has seen activity and is listed by the space it belongs to.
async function listedWorkspace(owner: Account, spaceKey?: string): Promise<string> {
  let id = await newWorkspace(owner, spaceKey);
  await touch(owner, id);
  await synced(owner, id, spaceKey ?? owner.personal);
  return id;
}

// The title of every workspace the space lists, by id, as its member `viewer` is shown them.
async function listing(key: string, viewer: Account): Promise<Record<string, string>> {
  let workspaces = await env.TEST_SPACE.getByName(key).listWorkspaces(viewer.profile.id);
  return Object.fromEntries(workspaces.map(workspace => [workspace.id, workspace.title]));
}

// Runs `act` while the next call of that kind any space gets fails, as if that space were out of
// reach, and expects `act` to fail with it.
async function whileNextFails(
    call: "attachWorkspaces" | "detachWorkspace", act: () => PromiseLike<unknown>) {
  let failing = vi.spyOn(SpaceDurableObject.prototype, call)
      .mockRejectedValueOnce(new Error("space unavailable"));
  try {
    await expectRejection(act(), "space unavailable");
  } finally {
    failing.mockRestore();
  }
}
const whileDetachFails = (act: () => PromiseLike<unknown>) =>
    whileNextFails("detachWorkspace", act);

// Await a stub call's rejection with a single handler (see spaces.test.ts).
async function expectRejection(call: PromiseLike<unknown>, message: string): Promise<void> {
  let caught: unknown;
  let rejected = false;
  try { await call; } catch (err) { rejected = true; caught = err; }
  expect(rejected).toBe(true);
  expect(String(caught)).toContain(message);
}

describe("a workspace's place in a space", () => {
  it("is listed on first activity and never while provisional", async () => {
    let alice = await signUp("alice");
    let provisional = await newWorkspace(alice);
    await alice.user.updateTitle(provisional, "Draft");
    let active = await listedWorkspace(alice);
    // Syncs run in the order they were asked for, so the one the rename asked for is done.
    expect(await listing(alice.personal, alice)).toEqual({ [active]: "Untitled" });
    expect((await stored(alice, provisional))?.registered).toBeUndefined();

    await touch(alice, provisional);
    await synced(alice, provisional, alice.personal, "Draft");
    using space = (await env.TEST_SPACE.getByName(alice.personal).open(alice.profile.id))!;
    let workspaces = await space.listWorkspaces();
    expect(workspaces.map(workspace => workspace.id).toSorted()).toEqual([provisional, active].toSorted());
    expect(workspaces.find(workspace => workspace.id === active)).toEqual(
        { id: active, title: "Untitled", owner: alice.profile, created: expect.any(Date) });
  });

  it("mirrors a change of title", async () => {
    let alice = await signUp("alice");
    let id = await listedWorkspace(alice);
    await alice.user.updateTitle(id, "Roadmap");
    await synced(alice, id, alice.personal, "Roadmap");
    expect(await listing(alice.personal, alice)).toEqual({ [id]: "Roadmap" });
  });

  it("never fails the activity or the rename whose sync could not reach its space", async () => {
    let alice = await signUp("alice");
    let id = await newWorkspace(alice);
    let attach = vi.spyOn(SpaceDurableObject.prototype, "attachWorkspaces")
        .mockRejectedValue(new Error("space unavailable"));
    try {
      await touch(alice, id);
      await alice.user.updateTitle(id, "Roadmap");
      await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2), WAIT);
    } finally {
      attach.mockRestore();
    }
    // What neither sync could do, the next one does.
    await touch(alice, id);
    await synced(alice, id, alice.personal, "Roadmap");
    expect(await listing(alice.personal, alice)).toEqual({ [id]: "Roadmap" });
  });

  it("never hands the marker to a caller", async () => {
    let alice = await signUp("alice");
    let id = await listedWorkspace(alice);
    expect(await alice.user.listGadgets()).toEqual(
        [{ id, title: "Untitled", created: expect.any(Date), lastActive: expect.any(Date) }]);
    expect(await alice.user.getGadget(id)).not.toHaveProperty("registered");
  });

  it("registers with the team space it was created in, or falls back to the personal one",
      async () => {
    let [alice, bob, carol] = await Promise.all([signUp("alice"), signUp("bob"), signUp("carol")]);
    let team = await teamSpace(alice, bob);

    let inTeam = await listedWorkspace(bob, team);
    expect(await listing(team, alice)).toEqual({ [inTeam]: "Untitled" });
    expect(await listing(bob.personal, bob)).toEqual({});
    expect(await bob.user.listGadgets()).toMatchObject([{ id: inTeam, spaceKey: team }]);

    // Carol is no member. Her workspace was created all the same, and is hers alone once active.
    let stray = await newWorkspace(carol, team);
    await touch(carol, stray);
    await synced(carol, stray, carol.personal);
    expect(await stored(carol, stray)).not.toHaveProperty("spaceKey");
    expect(await listing(carol.personal, carol)).toEqual({ [stray]: "Untitled" });
    expect(await listing(team, alice)).toEqual({ [inTeam]: "Untitled" });
  });

  it("moves only where its owner may add workspaces", async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    let team = await teamSpace(alice);
    let id = await listedWorkspace(bob);

    await expectRejection(bob.user.setGadgetSpace(id, team), NO_SUCH_SPACE);
    await expectRejection(bob.user.setGadgetSpace(id, alice.personal), "A space key is 2 to 32");
    expect(await stored(bob, id)).not.toHaveProperty("spaceKey");
    expect(await listing(team, alice)).toEqual({});
    expect(await listing(bob.personal, bob)).toEqual({ [id]: "Untitled" });
    // A provisional workspace is listed nowhere, so its move is only recorded.
    let provisional = await newWorkspace(bob);
    await bob.user.setGadgetSpace(provisional, team);
    expect(await stored(bob, provisional)).toMatchObject({ spaceKey: team });

    await env.TEST_SPACE.getByName(team).setMemberRole(alice.profile.id, bob.profile.id, "use");
    await bob.user.setGadgetSpace(id, team);
    expect(await stored(bob, id))
        .toMatchObject({ spaceKey: team, registered: { spaceKey: team, title: "Untitled" } });
    expect(await listing(team, alice)).toEqual({ [id]: "Untitled" });
    expect(await listing(bob.personal, bob)).toEqual({});

    await bob.user.setGadgetSpace(id, null);
    expect(await stored(bob, id)).not.toHaveProperty("spaceKey");
    expect(await listing(team, alice)).toEqual({});
    expect(await listing(bob.personal, bob)).toEqual({ [id]: "Untitled" });
  });

  it("ends up in one space, listed once, however many moves race", async () => {
    let alice = await signUp("alice");
    let [first, second] = await Promise.all([teamSpace(alice), teamSpace(alice)]);
    let id = await listedWorkspace(alice);
    await Promise.all([first, second, null, second, first, null, second].map(key =>
        env.TEST_USER.getByName(alice.profile.id).setGadgetSpace(id, key)));

    let record = (await stored(alice, id))!;
    let home = record.spaceKey ?? alice.personal;
    expect(record.registered).toEqual({ spaceKey: home, title: "Untitled" });
    for (let key of [first, second, alice.personal]) {
      expect(await listing(key, alice)).toEqual(key === home ? { [id]: "Untitled" } : {});
    }
  });

  it("finishes on the next sync a move whose detach failed", async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    let team = await teamSpace(alice, bob);
    let id = await listedWorkspace(bob, team);

    await whileDetachFails(() => bob.user.setGadgetSpace(id, null));
    // Listed where it is going, not yet dropped where it was, and the marker says so.
    expect(await stored(bob, id)).not.toHaveProperty("spaceKey");
    expect((await stored(bob, id))?.registered).toEqual({ spaceKey: team, title: "Untitled" });
    expect(await listing(bob.personal, bob)).toEqual({ [id]: "Untitled" });
    expect(await listing(team, alice)).toEqual({ [id]: "Untitled" });

    await touch(bob, id);
    await synced(bob, id, bob.personal);
    expect(await listing(team, alice)).toEqual({});
    expect(await listing(bob.personal, bob)).toEqual({ [id]: "Untitled" });
  });

  it("is listed once after a move that follows one whose detach failed", async () => {
    let alice = await signUp("alice");
    let [first, second, third] =
        await Promise.all([teamSpace(alice), teamSpace(alice), teamSpace(alice)]);
    // On to a third space, and back to the one it had not left yet.
    for (let target of [third, first]) {
      let id = await listedWorkspace(alice, first);
      await whileDetachFails(() => alice.user.setGadgetSpace(id, second));
      await alice.user.setGadgetSpace(id, target);
      expect(await stored(alice, id)).toMatchObject({ registered: { spaceKey: target } });
      for (let key of [first, second, third]) {
        expect(await listing(key, alice)).toEqual(key === target ? { [id]: "Untitled" } : {});
      }
      await alice.user.deleteGadget(id);
    }
  });

  it("stays where it was when a move that got no answer turns out to be refused", async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    let [team, closed] = await Promise.all([teamSpace(alice, bob), teamSpace(alice)]);
    let id = await listedWorkspace(bob, team);
    await whileNextFails("attachWorkspaces", () => bob.user.setGadgetSpace(id, closed));
    expect(await stored(bob, id)).toMatchObject({ spaceKey: closed });

    await touch(bob, id);
    await vi.waitFor(async () =>
        expect(await stored(bob, id)).toMatchObject({ spaceKey: team }), WAIT);
    expect(await listing(team, alice)).toEqual({ [id]: "Untitled" });
    expect(await listing(bob.personal, bob)).toEqual({});
  });

  it("is dropped from every space that may list it when deleted, or is kept and listed again",
      async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    let team = await teamSpace(alice, bob);
    let id = await listedWorkspace(bob, team);

    // A delete that fails keeps the record without its marker, for the next sync to list anew.
    await whileDetachFails(() => bob.user.deleteGadget(id));
    expect((await bob.user.listGadgets()).map(gadget => gadget.id)).toEqual([id]);
    expect((await stored(bob, id))?.registered).toBeUndefined();
    await touch(bob, id);
    await synced(bob, id, team);

    // A move home that stopped half way, so that both spaces list it.
    await whileDetachFails(() => bob.user.setGadgetSpace(id, null));
    await bob.user.deleteGadget(id);
    expect(await bob.user.listGadgets()).toEqual([]);
    expect(await listing(team, alice)).toEqual({});
    expect(await listing(bob.personal, bob)).toEqual({});
  });

  it("is listed again after a failed delete whose detach the space had carried out", async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    let [team, closed] = await Promise.all([teamSpace(alice, bob), teamSpace(alice)]);
    let id = await listedWorkspace(bob, team);
    // A move that got no answer, to a space that will refuse it.
    await whileNextFails("attachWorkspaces", () => bob.user.setGadgetSpace(id, closed));

    let detachWorkspace = SpaceDurableObject.prototype.detachWorkspace;
    let detach = vi.spyOn(SpaceDurableObject.prototype, "detachWorkspace")
        .mockImplementationOnce(async function (this: SpaceDurableObject, workspace, ownerId) {
          await detachWorkspace.call(this, workspace, ownerId);
          throw new Error("space unavailable");
        });
    try {
      await expectRejection(bob.user.deleteGadget(id), "space unavailable");
    } finally {
      detach.mockRestore();
    }
    expect(await listing(team, alice)).toEqual({});

    await touch(bob, id);
    await synced(bob, id, team);
    expect(await listing(team, alice)).toEqual({ [id]: "Untitled" });
  });

  it("is deleted only after a sync under way, and dropped from the listing that sync made",
      async () => {
    let alice = await signUp("alice");
    let id = await newWorkspace(alice);
    // The space takes its time over the workspace's first registration.
    let attachWorkspaces = SpaceDurableObject.prototype.attachWorkspaces;
    let registration = { held: true };
    let attach = vi.spyOn(SpaceDurableObject.prototype, "attachWorkspaces")
        .mockImplementationOnce(async function (this: SpaceDurableObject, owner, registrations) {
          while (registration.held) await scheduler.wait(10);
          return attachWorkspaces.call(this, owner, registrations);
        });
    try {
      await touch(alice, id);
      await vi.waitFor(() => expect(attach).toHaveBeenCalled(), WAIT);
      let deleted = alice.user.deleteGadget(id);
      // Given the time to get ahead of the sync, the delete has not.
      await scheduler.wait(100);
      expect(await alice.user.getGadget(id)).not.toBeNull();
      registration.held = false;
      await deleted;
    } finally {
      registration.held = false;
      attach.mockRestore();
    }
    expect(await alice.user.getGadget(id)).toBeNull();
    expect(await listing(alice.personal, alice)).toEqual({});
  });

  it("is never registered by a user it is shared with", async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    let id = await listedWorkspace(alice);
    await bob.user.recordSharedGadgetOpen(id, "Untitled", alice.profile, "build");

    // Everything that syncs a workspace of his own leaves this one alone.
    await bob.user.updateTitle(id, "Mine now");
    await touch(bob, id);
    await expectRejection(bob.user.setGadgetSpace(id, null), "No such workspace belonging to user.");
    let own = await listedWorkspace(bob);
    expect(await listing(bob.personal, bob)).toEqual({ [own]: "Untitled" });
    expect(await listing(alice.personal, alice)).toEqual({ [id]: "Untitled" });
    expect((await stored(bob, id))?.registered).toBeUndefined();
  });

  it("keeps its place, and its title current, after its owner leaves the space", async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    let team = await teamSpace(alice, bob);
    let id = await listedWorkspace(bob, team);
    await env.TEST_SPACE.getByName(team).removeMember(alice.profile.id, bob.profile.id);

    await bob.user.updateTitle(id, "Still here");
    await synced(bob, id, team, "Still here");
    expect(await listing(team, alice)).toEqual({ [id]: "Still here" });
    expect(await stored(bob, id)).toMatchObject({ spaceKey: team });
  });
});

describe("the catch-up for workspaces no space has acknowledged", () => {
  it("registers them in pages, and resumes after a failure with only what is left", async () => {
    let name = `dana-${unique()}`;
    let user = env.TEST_USER.getByName(name);
    await user.authenticateFromCfAccess(name, true);
    let dana: Account = { profile: { type: "user", id: name, name }, user, personal: `~${name}` };

    // Workspaces as they stood before any registered with a space, among records that are not
    // the catch-up's to register, and two left pointing at a team space nobody has created.
    let ids = Array.from({ length: 300 }, (_, index) => `ws-${String(index).padStart(3, "0")}`);
    let created = new Date("2026-01-01");
    await runInDurableObject(user, (_instance, state) => {
      let { gadgets } = makeUserStorage(state.storage);
      for (let id of ids) gadgets.put({ id, title: `Title ${id}`, created, lastActive: created });
      gadgets.put({ id: "ws-provisional", title: "Untitled", created });
      gadgets.put({ id: "ws-shared", title: "Theirs", owner: { type: "user", id: "eve", name: "Eve" },
          created, lastActive: created });
      for (let id of ["ws-stray-a", "ws-stray-b"]) {
        let spaceKey = `team-${unique()}`;
        gadgets.put({ id, title: "Stray", created, lastActive: created, spaceKey });
      }
    });

    // The second page never arrives, and nor does the first stray workspace at its team space.
    let attachWorkspaces = SpaceDurableObject.prototype.attachWorkspaces;
    let attach = vi.spyOn(SpaceDurableObject.prototype, "attachWorkspaces")
        .mockImplementationOnce(attachWorkspaces)
        .mockRejectedValueOnce(new Error("space unavailable"))
        .mockImplementationOnce(attachWorkspaces)
        .mockImplementationOnce(attachWorkspaces)
        .mockRejectedValueOnce(new Error("space unavailable"));
    try {
      expect((await user.listSpaces()).map(space => space.key)).toEqual([dana.personal]);
      await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2), WAIT);
      expect(Object.keys(await listing(dana.personal, dana)).toSorted()).toEqual(ids.slice(0, 128));

      // A failed catch-up starts over the next time the spaces are listed.
      let expected = Object.fromEntries(ids.map(id => [id, `Title ${id}`]));
      await vi.waitFor(async () => {
        await user.listSpaces();
        expect(await listing(dana.personal, dana))
            .toEqual({ ...expected, "ws-stray-a": "Stray", "ws-stray-b": "Stray" });
      }, WAIT);
      expect(await stored(dana, "ws-stray-a")).not.toHaveProperty("spaceKey");

      // What the spaces were sent: the first page once, the lost page again, the rest, and then
      // the stray ones, each refused by its team space before the personal space took it. The
      // first one failing did not keep the second from its turn in the same catch-up.
      let [a, b] = [["ws-stray-a"], ["ws-stray-b"]];
      let sent = attach.mock.calls.map(([, registrations]) => registrations.map(r => r.id));
      expect(sent).toEqual([
        ids.slice(0, 128), ids.slice(128, 256), ids.slice(128, 256), ids.slice(256), a, b, b, a, a,
      ]);

      // A catch-up that reached its end is not started again by this object: a workspace it
      // never saw waits for its own activity. The move waits out whatever listing spaces started.
      await runInDurableObject(user, (_instance, state) => makeUserStorage(state.storage).gadgets
          .put({ id: "ws-late", title: "Late", created, lastActive: created }));
      await user.listSpaces();
      await user.setGadgetSpace(ids[0], null);
      expect(attach).toHaveBeenCalledTimes(sent.length);
    } finally {
      attach.mockRestore();
    }
  });
});
