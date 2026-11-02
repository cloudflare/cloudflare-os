// The tree of a space's listing: where a space places a new entry, how an entry moves, what
// becomes of the entries under one that leaves, the order the listing comes in, and what a
// visitor sees of it. SpaceModel's rules over a Map-backed storage first, then the real Durable
// Objects: the users whose workspaces a space lists, and a space whose entries were stored
// before it had a tree.

import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { collection, createTypedStorage } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo, SpaceWorkspaceInfo } from "@gadgets/workshop-shared/api";
import {
  SpaceDurableObject, SpaceModel, teamSpaceClaim, type WorkspaceRegistration,
} from "../src/spaces.js";
import {
  makeSpaceStorage, SPACE_STORAGE_VERSION, type SpaceStorage, type SpaceWorkspaceRecord,
} from "../src/storage-schema/space-storage.js";
import {
  makeUserStorage, type GadgetRecord, type WorkspaceRestrictions,
} from "../src/storage-schema/user-storage.js";
import type { UserDurableObject } from "../src/user.js";
import { makeMockStorage } from "./mock-storage.js";
// Load the whole backend up front, so that its slow load is not billed to the first test.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_SPACE: DurableObjectNamespace<SpaceDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const NO_SUCH_SPACE = "No such space, or you are not a member of it.";
const NO_PARENT = "No such parent workspace in this space.";
const UNDER_ITSELF = "A workspace cannot be moved under itself.";
const NOT_LISTED = "This space does not list that workspace.";
const NOT_YOURS = "Only a workspace's owner or an admin of this space can move it.";
const CYCLIC = "The space's tree is cyclic.";
const CREATED = new Date("2026-01-01");

const profile = (id: string): AiChatAuthorInfo => ({ type: "user", id, name: id });
// An admin, a member who builds, a member who uses, and someone who is not a member.
const [ALICE, BOB, CAROL, DAVE] = ["alice", "bob", "carol", "dave"].map(profile);

// A team space with the members above.
function teamSpace() {
  let storage = makeSpaceStorage(makeMockStorage());
  let model = new SpaceModel(storage);
  expect(model.claim(teamSpaceClaim("eng", "Engineering"), ALICE)).toBe(true);
  model.setMemberRole(ALICE.id, BOB, "build");
  model.setMemberRole(ALICE.id, CAROL, "use");
  return { model, storage };
}

// A registration of workspace `id`, titled (and so addressed) by its id, asking to be placed
// under `parentId`, or with none at the top of the tree.
const ws = (id: string, parentId?: string, more: Partial<WorkspaceRegistration> = {})
    : WorkspaceRegistration =>
    ({ id, title: id, created: CREATED, placement: { parentId }, ...more });
const published = (id: string, parentId?: string) => ws(id, parentId, { published: "use" });
// A registration of workspace `id`, created in `month` of 2026, that asks for no place.
const unplaced = (id: string, month: number): WorkspaceRegistration =>
    ({ id, title: id, created: new Date(2026, month - 1, 1) });

// A listing, each entry as the path of ids down to it. Each entry's path is built from its
// parent's, so a parent listed after its child would show as "undefined/...".
function outlineOf(listing: SpaceWorkspaceInfo[]): string[] {
  let paths = new Map<string, string>();
  return listing.map(({ id, parentId }) => {
    let path = parentId === undefined ? id : `${paths.get(parentId)}/${id}`;
    paths.set(id, path);
    return path;
  });
}
// The listing as `viewer` is shown it, as above.
const outline = (model: SpaceModel, viewer = ALICE) => outlineOf(model.listWorkspaces(viewer.id));
// The stored position of every entry, by id.
const positions = (storage: SpaceStorage) => Object.fromEntries(
    [...storage.workspaces.list()].map(entry => [entry.id, entry.position]));
// Everything the listing stores, to compare before and after a call that must change nothing.
const snapshot = (storage: SpaceStorage) => [...storage.workspaces.list()];

describe("SpaceModel's tree", () => {
  it("appends a new entry under the parent it registers with if the space lists that one, and "
      + "at the top otherwise", () => {
    let { model, storage } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a"), ws("b")]);
    model.attachWorkspaces(BOB, [ws("c", "a"), ws("d", "nowhere"), ws("e", "a"), ws("f", "f")]);
    // A parent registered earlier in the same call is listed by then.
    model.attachWorkspaces(CAROL, [ws("g"), ws("h", "g")]);
    expect(outline(model)).toEqual(["a", "a/c", "a/e", "b", "d", "f", "g", "g/h"]);
    expect(positions(storage)).toEqual({ a: 0, b: 1, c: 0, d: 2, e: 1, f: 3, g: 4, h: 0 });
  });

  it("never moves an entry that a later registration names another parent for", () => {
    let { model, storage } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a"), ws("b"), ws("c", "a")]);
    model.attachWorkspaces(BOB, [ws("c"), ws("c", "b"), ws("c", "b", { title: "Renamed" })]);
    expect(outline(model)).toEqual(["a", "a/c", "b"]);
    expect(storage.workspaces.get("c"))
        .toMatchObject({ parentId: "a", position: 0, title: "Renamed" });
  });

  it("moves an entry immediately before the sibling it names", () => {
    let { model, storage } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a"), ws("b"), ws("c"), ws("d", "a")]);
    model.moveWorkspace(BOB.id, "c", null, "a");
    expect(outline(model)).toEqual(["c", "a", "a/d", "b"]);
    model.moveWorkspace(BOB.id, "b", "a", "d");
    expect(outline(model)).toEqual(["c", "a", "a/b", "a/d"]);
    expect(positions(storage)).toEqual({ a: 1, b: 0, c: 0, d: 1 });
  });

  it("moves an entry after its last sibling when it names no sibling to go before", () => {
    let { model, storage } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a"), ws("b"), ws("c"), ws("x", "c")]);
    model.moveWorkspace(BOB.id, "b", null);
    expect(outline(model)).toEqual(["a", "c", "c/x", "b"]);
    // An anchor that is gone, one under another parent, and the entry itself.
    model.moveWorkspace(BOB.id, "a", null, "gone");
    expect(outline(model)).toEqual(["c", "c/x", "b", "a"]);
    model.moveWorkspace(BOB.id, "c", null, "x");
    expect(outline(model)).toEqual(["b", "a", "c", "c/x"]);
    model.moveWorkspace(BOB.id, "b", null, "b");
    expect(outline(model)).toEqual(["a", "c", "c/x", "b"]);
    // Under a parent, an anchor at the top is not a sibling either.
    model.moveWorkspace(BOB.id, "a", "c", "b");
    expect(outline(model)).toEqual(["c", "c/x", "c/a", "b"]);
    expect(positions(storage)).toEqual({ a: 1, b: 1, c: 0, x: 0 });
  });

  it("moves an entry with everything under it, and closes the gap it leaves", () => {
    let { model, storage } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a"), ws("b", "a"), ws("c", "b"), ws("d", "a"), ws("e")]);
    model.moveWorkspace(BOB.id, "b", "e");
    expect(outline(model)).toEqual(["a", "a/d", "e", "e/b", "e/b/c"]);
    expect(positions(storage)).toEqual({ a: 0, b: 0, c: 0, d: 0, e: 1 });
  });

  it("refuses a parent it does not list, the entry itself and an entry under it, changing "
      + "nothing", () => {
    let { model, storage } = teamSpace();
    model.attachWorkspaces(BOB, [ws("a"), ws("b", "a"), ws("c", "b"), ws("d")]);
    let before = snapshot(storage);
    expect(() => model.moveWorkspace(ALICE.id, "a", "nowhere")).toThrow(NO_PARENT);
    expect(() => model.moveWorkspace(ALICE.id, "a", "a", "d")).toThrow(UNDER_ITSELF);
    expect(() => model.moveWorkspace(ALICE.id, "a", "b")).toThrow(UNDER_ITSELF);
    expect(() => model.moveWorkspace(ALICE.id, "a", "c")).toThrow(UNDER_ITSELF);
    expect(() => model.moveWorkspace(ALICE.id, "nowhere", null)).toThrow(NOT_LISTED);
    expect(snapshot(storage)).toEqual(before);
    expect(outline(model)).toEqual(["a", "a/b", "a/b/c", "d"]);
  });

  it("lets the owner an entry is listed under and an admin move it, and nobody else", () => {
    let { model, storage } = teamSpace();
    // Published at the top of the tree, so that the space is open to Dave as a visitor.
    model.attachWorkspaces(BOB, [published("a"), ws("b")]);
    let before = snapshot(storage);
    expect(() => model.moveWorkspace(CAROL.id, "a", "b")).toThrow(NOT_YOURS);
    for (let id of ["a", "nowhere"]) {
      expect(() => model.moveWorkspace(DAVE.id, id, null)).toThrow(NO_SUCH_SPACE);
    }
    expect(snapshot(storage)).toEqual(before);

    model.moveWorkspace(BOB.id, "a", "b");
    model.moveWorkspace(ALICE.id, "a", null, "b");
    expect(outline(model)).toEqual(["a", "b"]);
    // Both are looked up at the time of the call: an owner who has left is a stranger, and a
    // member made admin since may.
    model.removeMember(ALICE.id, BOB.id);
    expect(() => model.moveWorkspace(BOB.id, "a", "b")).toThrow(NO_SUCH_SPACE);
    model.setMemberRole(ALICE.id, CAROL, "admin");
    model.moveWorkspace(CAROL.id, "a", "b");
    expect(outline(model)).toEqual(["b", "b/a"]);
  });

  it("moves the entries under a detached one into its place, in their order", () => {
    let { model, storage } = teamSpace();
    model.attachWorkspaces(BOB, [
      ws("a"), ws("b"), ws("c", "b"), ws("x", "c"), ws("d", "b"), ws("e"),
      ws("p", "a"), ws("q", "a"), ws("r", "q"), ws("s", "q"), ws("t", "a"),
    ]);
    model.detachWorkspace("b", BOB.id);
    expect(outline(model)).toEqual(
        ["a", "a/p", "a/q", "a/q/r", "a/q/s", "a/t", "c", "c/x", "d", "e"]);
    model.detachWorkspace("q", BOB.id);
    expect(outline(model)).toEqual(["a", "a/p", "a/r", "a/s", "a/t", "c", "c/x", "d", "e"]);
    expect(positions(storage))
        .toEqual({ a: 0, c: 1, d: 2, e: 3, p: 0, r: 1, s: 2, t: 3, x: 0 });
  });

  it("leaves a new entry that asks for no place unpositioned, orders those after the others, "
      + "newest first, and positions them all when it next renumbers them", () => {
    let { model, storage } = teamSpace();
    model.attachWorkspaces(BOB, [ws("p"), unplaced("jan", 1), unplaced("mar", 3)]);
    // An update asking for a place does not place an entry the space never positioned either.
    model.attachWorkspaces(BOB, [unplaced("feb", 2), ws("jan", "p")]);
    expect(outline(model)).toEqual(["p", "mar", "feb", "jan"]);
    // A new entry goes after the positioned ones, at the count of its siblings.
    model.attachWorkspaces(BOB, [ws("new")]);
    expect(outline(model)).toEqual(["p", "new", "mar", "feb", "jan"]);
    expect(positions(storage)).toEqual(
        { p: 0, new: 4, jan: undefined, feb: undefined, mar: undefined });

    model.moveWorkspace(BOB.id, "p", null);
    expect(outline(model)).toEqual(["new", "mar", "feb", "jan", "p"]);
    expect(positions(storage)).toEqual({ new: 0, mar: 1, feb: 2, jan: 3, p: 4 });
  });

  it("lists entries in depth-first pre-order, each with its parent and position", () => {
    let { model } = teamSpace();
    model.attachWorkspaces(BOB, [ws("e"), ws("a"), ws("f", "e"), ws("b", "a")]);
    model.attachWorkspaces(CAROL, [ws("d", "a"), ws("c", "b")]);
    model.moveWorkspace(ALICE.id, "a", null, "e");
    expect(outline(model)).toEqual(["a", "a/b", "a/b/c", "a/d", "e", "e/f"]);
    expect(model.listWorkspaces(CAROL.id).map(({ id, parentId, position }) =>
        ({ id, parentId, position }))).toEqual([
      { id: "a", parentId: undefined, position: 0 },
      { id: "b", parentId: "a", position: 0 },
      { id: "c", parentId: "b", position: 0 },
      { id: "d", parentId: "a", position: 1 },
      { id: "e", parentId: undefined, position: 1 },
      { id: "f", parentId: "e", position: 0 },
    ]);
  });
});

// A tree where d, f and h are published under an unpublished entry, c, e and g.
function visited() {
  let { model, storage } = teamSpace();
  model.attachWorkspaces(BOB, [
    published("a"), published("b", "a"), ws("c", "b"), published("d", "c"),
    ws("e", "a"), published("f", "e"), ws("g"), published("h", "g"),
  ]);
  return { model, storage };
}

describe("SpaceModel's tree, to a visitor", () => {
  it("shows only the published entries with nothing unpublished above them", () => {
    let { model } = visited();
    expect(outline(model, CAROL))
        .toEqual(["a", "a/b", "a/b/c", "a/b/c/d", "a/e", "a/e/f", "g", "g/h"]);
    expect(outline(model, DAVE)).toEqual(["a", "a/b"]);
  });

  it("positions what it shows a visitor among the siblings they are shown", () => {
    let { model, storage } = teamSpace();
    model.attachWorkspaces(BOB, [
      ws("hidden"), published("x"), ws("y", "x"), published("z", "x"), published("w"),
      { ...unplaced("legacy", 1), published: "use" },
    ]);
    expect(positions(storage))
        .toEqual({ hidden: 0, x: 1, y: 0, z: 1, w: 2, legacy: undefined });
    let shown = (viewer: AiChatAuthorInfo) => model.listWorkspaces(viewer.id)
        .map(({ id, position }) => ({ id, position }));
    expect(shown(DAVE)).toEqual([
      { id: "x", position: 0 }, { id: "z", position: 0 }, { id: "w", position: 1 },
      { id: "legacy", position: undefined },
    ]);
    expect(shown(CAROL).map(({ position }) => position)).toEqual([0, 1, 0, 1, 2, undefined]);
    // A slug resolves to the entry as the listing shows it.
    expect(model.resolveWorkspace(DAVE.id, "w")?.workspace.position).toBe(1);
    expect(model.resolveWorkspace(DAVE.id, "z")?.workspace.position).toBe(0);
    expect(model.resolveWorkspace(CAROL.id, "w")?.workspace.position).toBe(2);
    expect(storage.workspaces.get("w")?.position).toBe(2);
  });

  it("resolves for a visitor only the slugs, current or former, of the entries it shows them",
      () => {
    let { model } = visited();
    model.setWorkspaceSlug(BOB.id, "b", "b2");
    model.setWorkspaceSlug(BOB.id, "d", "d2");
    let resolve = (viewer: AiChatAuthorInfo, slug: string) => {
      let found = model.resolveWorkspace(viewer.id, slug);
      return found && `${found.workspace.id}${found.canonical ? "" : " (former)"}`;
    };
    let slugs = ["a", "b2", "b", "d2", "d", "f", "h", "c"];
    expect(slugs.map(slug => resolve(DAVE, slug)))
        .toEqual(["a", "b", "b (former)", null, null, null, null, null]);
    expect(slugs.map(slug => resolve(CAROL, slug)))
        .toEqual(["a", "b", "b (former)", "d", "d (former)", "f", "h", "c"]);
  });

  it("opens to a visitor only while a published entry sits at the top of the tree", () => {
    let { model } = teamSpace();
    model.attachWorkspaces(BOB, [ws("r"), published("s", "r"), ws("u")]);
    let open = () => model.infoFor(DAVE.id) !== undefined;
    expect(open()).toBe(false);
    expect(() => model.listWorkspaces(DAVE.id)).toThrow(NO_SUCH_SPACE);
    expect(() => model.resolveWorkspace(DAVE.id, "s")).toThrow(NO_SUCH_SPACE);

    model.attachWorkspaces(BOB, [published("r")]);
    expect(open()).toBe(true);
    expect(outline(model, DAVE)).toEqual(["r", "r/s"]);
    // Moved under an unpublished entry, it no longer sits at the top, and back it does.
    model.moveWorkspace(BOB.id, "r", "u");
    expect(open()).toBe(false);
    model.moveWorkspace(BOB.id, "r", null);
    expect(open()).toBe(true);
    // Left alone at the top once the entry above it leaves, a published entry opens the space.
    model.attachWorkspaces(BOB, [ws("r")]);
    expect(open()).toBe(false);
    model.detachWorkspace("r", BOB.id);
    expect(open()).toBe(true);
    expect(outline(model, DAVE)).toEqual(["s"]);
    model.attachWorkspaces(BOB, [ws("s")]);
    expect(open()).toBe(false);
  });
});

describe("SpaceModel's tree over corrupt storage", () => {
  it("shows an entry whose parent it does not hold at the top, and stops a walk round a cycle",
      () => {
    let { model, storage } = teamSpace();
    model.attachWorkspaces(BOB, [published("a")]);
    let corrupt = (id: string, parentId: string): SpaceWorkspaceRecord =>
        ({ id, title: id, slug: id, owner: BOB, created: CREATED, parentId, published: "use" });
    storage.workspaces.put(corrupt("x", "y"));
    storage.workspaces.put(corrupt("y", "x"));
    storage.workspaces.put(corrupt("z", "gone"));

    // A cycle is reached from no entry at the top, so its entries are left out of the listing.
    expect(outline(model)).toEqual(["a", "z"]);
    expect(outline(model, DAVE)).toEqual(["a", "z"]);
    expect(model.resolveWorkspace(DAVE.id, "x")).toBeNull();
    expect(() => model.moveWorkspace(BOB.id, "a", "x")).toThrow(CYCLIC);
    // A move puts the entry back in the tree.
    model.moveWorkspace(BOB.id, "z", null);
    expect(storage.workspaces.get("z")).toMatchObject({ position: 1 });
    expect(storage.workspaces.get("z")).not.toHaveProperty("parentId");
  });
});

// =======================================================================================
// The real Durable Objects

type Account = {
  profile: AiChatAuthorInfo;
  user: DurableObjectStub<UserDurableObject>;
  /** The key of their personal space. */
  personal: string;
};

const UNRESTRICTED: WorkspaceRestrictions =
    { containsRestrictedData: false, ownerInvitesOnly: false };
// Shorter than the test timeout, so that a wait which runs out fails with its own assertion.
const WAIT = { timeout: 4_000 };
const unique = () => crypto.randomUUID().slice(0, 8);
const space = (key: string) => env.TEST_SPACE.getByName(key);

// A signed-in user. Unless told not to they list their spaces, which spends their object's one
// catch-up while they have no workspace.
async function signUp(name: string, listSpaces = true): Promise<Account> {
  let id = `${name}-${unique()}`;
  let user = env.TEST_USER.getByName(id);
  await user.authenticateFromCfAccess(id, true);
  if (listSpaces) await user.listSpaces();
  return { profile: profile(id), user, personal: `~${id}` };
}

// A team space under a fresh key, created by `admin`.
async function createTeamSpace(admin: Account): Promise<string> {
  let key = `team-${unique()}`;
  expect(await space(key).claim(teamSpaceClaim(key, "Team"), admin.profile)).toBe(true);
  return key;
}

// A workspace as AuthenticatedApi.newGadget leaves it: provisional, belonging to team space
// `spaceKey` or with none to its owner's personal space, and placed under `parentId` if given.
async function newWorkspace(owner: Account, spaceKey?: string, parentId?: string) {
  let id = `ws-${unique()}`;
  await owner.user.newGadget(id, "Untitled", spaceKey, parentId);
  return id;
}
function touch(owner: Account, id: string, restrictions = UNRESTRICTED): Promise<void> {
  return owner.user.setGadgetLastActive(id, new Date(), undefined, restrictions);
}
function move(owner: Account, id: string, spaceKey: string | null): Promise<boolean> {
  return owner.user.setGadgetSpace(id, spaceKey, UNRESTRICTED);
}
function stored(owner: Account, id: string): Promise<GadgetRecord | undefined> {
  return runInDurableObject(owner.user, (_instance, state) =>
      makeUserStorage(state.storage).gadgets.get(id));
}
// Waits for a detached sync to leave the workspace acknowledged by `spaceKey`.
async function synced(owner: Account, id: string, spaceKey: string) {
  await vi.waitFor(async () => expect((await stored(owner, id))?.registered)
      .toEqual({ spaceKey, title: "Untitled" }), WAIT);
}
// A workspace that has seen activity and is listed by its space.
async function listedWorkspace(owner: Account, spaceKey?: string, parentId?: string) {
  let id = await newWorkspace(owner, spaceKey, parentId);
  await touch(owner, id);
  await synced(owner, id, spaceKey ?? owner.personal);
  return id;
}
const listing = async (key: string, viewer: Account) =>
    outlineOf(await space(key).listWorkspaces(viewer.profile.id));

describe("a workspace's place in its space's tree", () => {
  it("is under the parent it was created under if its space lists that one, and at the top "
      + "otherwise", async () => {
    let alice = await signUp("alice");
    let team = await createTeamSpace(alice);
    let parent = await listedWorkspace(alice);
    let child = await listedWorkspace(alice, undefined, parent);
    let orphan = await listedWorkspace(alice, undefined, "ws-nowhere");
    let elsewhere = await listedWorkspace(alice, team, parent);
    expect(await listing(alice.personal, alice)).toEqual([parent, `${parent}/${child}`, orphan]);
    expect(await listing(team, alice)).toEqual([elsewhere]);
    // Once listed, the record holds no placement.
    expect(await stored(alice, child)).not.toHaveProperty("placement");
  });

  it("keeps its placement through a registration that fails, and never hands it to a caller",
      async () => {
    let alice = await signUp("alice");
    let parent = await listedWorkspace(alice);
    let id = await newWorkspace(alice, undefined, parent);
    expect(await stored(alice, id)).toMatchObject({ placement: { parentId: parent } });
    expect(await alice.user.getGadget(id)).not.toHaveProperty("placement");

    let attach = vi.spyOn(SpaceDurableObject.prototype, "attachWorkspaces")
        .mockRejectedValueOnce(new Error("space unavailable"));
    try {
      await touch(alice, id);
      await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1), WAIT);
    } finally {
      attach.mockRestore();
    }
    expect(await stored(alice, id)).toMatchObject({ placement: { parentId: parent } });
    let gadget = (await alice.user.listGadgets()).find(listed => listed.id === id);
    expect(gadget).toBeDefined();
    expect(gadget).not.toHaveProperty("placement");

    await touch(alice, id);
    await synced(alice, id, alice.personal);
    expect(await listing(alice.personal, alice)).toEqual([parent, `${parent}/${id}`]);
    expect(await stored(alice, id)).not.toHaveProperty("placement");
  });

  it("is at the top of the tree when the workspace is moved away and back", async () => {
    let alice = await signUp("alice");
    let team = await createTeamSpace(alice);
    let parent = await listedWorkspace(alice);
    let child = await listedWorkspace(alice, undefined, parent);
    await move(alice, child, team);
    expect(await listing(team, alice)).toEqual([child]);
    await move(alice, child, null);
    expect(await listing(alice.personal, alice)).toEqual([parent, child]);

    // One moved away and back before any space listed it goes to the top all the same.
    let early = await newWorkspace(alice, undefined, parent);
    await move(alice, early, team);
    await move(alice, early, null);
    expect(await stored(alice, early)).toHaveProperty("placement", {});
    await touch(alice, early);
    await synced(alice, early, alice.personal);
    expect(await listing(alice.personal, alice)).toEqual([parent, child, early]);
    // Each was appended, as any workspace a space lists anew.
    let entries = await space(alice.personal).listWorkspaces(alice.profile.id);
    expect(entries.map(entry => entry.position)).toEqual([0, 1, 2]);
  });

  it("is not positioned for a workspace that never asked for one, whichever sync lists it",
      async () => {
    let dana = await signUp("dana", false);
    // Workspaces whose records hold no placement, created in an order their ids do not follow.
    let months = { "ws-c": 1, "ws-a": 5, "ws-e": 2, "ws-b": 4, "ws-d": 3, "ws-f": 6 };
    await runInDurableObject(dana.user, (_instance, state) => {
      let { gadgets } = makeUserStorage(state.storage);
      for (let [id, month] of Object.entries(months)) {
        let created = new Date(2026, month - 1, 1);
        gadgets.put({ id, title: "Untitled", created, lastActive: created, ...UNRESTRICTED });
      }
    });
    // One registers through its own activity, and the rest through the catch-up.
    await touch(dana, "ws-f");
    await synced(dana, "ws-f", dana.personal);
    await dana.user.listSpaces();
    let legacy = ["ws-f", "ws-a", "ws-b", "ws-d", "ws-e", "ws-c"];
    await vi.waitFor(async () => expect(await listing(dana.personal, dana)).toEqual(legacy), WAIT);
    let entries = await space(dana.personal).listWorkspaces(dana.profile.id);
    expect(entries.map(entry => entry.position)).toEqual(Array(6).fill(undefined));

    // A workspace created since asks for a place, and so comes first, the only one positioned.
    let fresh = await listedWorkspace(dana);
    expect(await listing(dana.personal, dana)).toEqual([fresh, ...legacy]);
    await space(dana.personal).moveWorkspace(dana.profile.id, "ws-c", null, "ws-f");
    expect(await listing(dana.personal, dana))
        .toEqual([fresh, "ws-c", "ws-f", "ws-a", "ws-b", "ws-d", "ws-e"]);
    entries = await space(dana.personal).listWorkspaces(dana.profile.id);
    expect(entries.map(entry => entry.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("is placed by the catch-up as by a sync, and used up once the space acknowledges it",
      async () => {
    let erin = await signUp("erin", false);
    // Workspaces that have seen activity and that no space lists yet, asking for places.
    await runInDurableObject(erin.user, (_instance, state) => {
      let { gadgets } = makeUserStorage(state.storage);
      let active = { title: "Untitled", created: CREATED, lastActive: CREATED, ...UNRESTRICTED };
      gadgets.put({ id: "ws-a", ...active, placement: {} });
      gadgets.put({ id: "ws-b", ...active, placement: { parentId: "ws-a" } });
    });
    let attach = vi.spyOn(SpaceDurableObject.prototype, "attachWorkspaces");
    try {
      await erin.user.listSpaces();
      await synced(erin, "ws-a", erin.personal);
      await synced(erin, "ws-b", erin.personal);
      // Both went in one page of the catch-up, and no sync followed it.
      expect(attach.mock.calls.map(([, page]) => page.map(({ id }) => id)))
          .toEqual([["ws-a", "ws-b"]]);
    } finally {
      attach.mockRestore();
    }
    expect(await listing(erin.personal, erin)).toEqual(["ws-a", "ws-a/ws-b"]);
    expect(await stored(erin, "ws-a")).not.toHaveProperty("placement");
    expect(await stored(erin, "ws-b")).not.toHaveProperty("placement");
  });

  it.each(["deleted", "moved to another space", "come to hold restricted data"] as const)(
      "gives its place to the workspaces under it once it is %s", async leaving => {
    let alice = await signUp("alice");
    let team = await createTeamSpace(alice);
    let first = await listedWorkspace(alice);
    let parent = await listedWorkspace(alice);
    let one = await listedWorkspace(alice, undefined, parent);
    let two = await listedWorkspace(alice, undefined, parent);
    let last = await listedWorkspace(alice);
    expect(await listing(alice.personal, alice))
        .toEqual([first, parent, `${parent}/${one}`, `${parent}/${two}`, last]);

    if (leaving === "deleted") {
      await alice.user.deleteGadget(parent, UNRESTRICTED);
    } else if (leaving === "moved to another space") {
      await move(alice, parent, team);
      expect(await listing(team, alice)).toEqual([parent]);
    } else {
      await touch(alice, parent, { ...UNRESTRICTED, containsRestrictedData: true });
    }
    await vi.waitFor(async () => expect(await listing(alice.personal, alice))
        .toEqual([first, one, two, last]), WAIT);
  });

  it("moves through a member's capability, and refuses a visitor's", async () => {
    let [alice, mallory] = await Promise.all([signUp("alice"), signUp("mallory")]);
    let team = await createTeamSpace(alice);
    let stub = space(team);
    expect(await stub.attachWorkspaces(alice.profile,
        [published("a"), published("b"), published("c", "a")])).toBe(true);
    using member = (await stub.open(alice.profile.id))!;
    expect(await member.moveWorkspace("b", "a", "c")).toBeUndefined();
    expect(outlineOf(await member.listWorkspaces())).toEqual(["a", "a/b", "a/c"]);

    using visitor = (await stub.open(mallory.profile.id))!;
    expect(outlineOf(await visitor.listWorkspaces())).toEqual(["a", "a/b", "a/c"]);
    let refused = await visitor.moveWorkspace("b", null).then(
        () => "moved", (error: Error) => error.message);
    expect(refused).toBe(NO_SUCH_SPACE);
    expect(outlineOf(await member.listWorkspaces())).toEqual(["a", "a/b", "a/c"]);
  });
});

// The listing as it was stored before entries had a place in a tree: no `parentId` or
// `position` on an entry, and the indexes of that time.
function legacyStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      workspaces: collection<SpaceWorkspaceRecord>()({
        primaryKey: "id",
        uniqueIndexes: {
          bySlug(record: SpaceWorkspaceRecord) { return record.slug ?? null; },
        },
        nonUniqueIndexes: {
          byFormerSlug(record: SpaceWorkspaceRecord) { return record.formerSlugs ?? []; },
          byPublished(record: SpaceWorkspaceRecord) { return record.published ?? null; },
        },
      }),
    },
  });
}

describe("a space whose entries were stored before it had a tree", () => {
  it("builds its tree's indexes over them once, when it wakes, and then lists, places and "
      + "shows a visitor the right ones", async () => {
    let [alice, mallory] = await Promise.all([signUp("alice"), signUp("mallory")]);
    let key = await createTeamSpace(alice);
    let legacy = (id: string, month: number, publishedAs?: "use"): SpaceWorkspaceRecord => ({
      id, title: id, slug: id, owner: alice.profile, created: new Date(2026, month - 1, 1),
      ...(publishedAs && { published: publishedAs }),
    });
    let writeLegacy = (...entries: SpaceWorkspaceRecord[]) =>
        runInDurableObject(space(key), (_instance, state) => {
          let before = legacyStorage(state.storage);
          for (let entry of entries) before.workspaces.put(entry);
        });
    // As a space claimed before it had a tree, which stored no version.
    await runInDurableObject(space(key), (_instance, state) => {
      makeSpaceStorage(state.storage).version.put(0);
    });
    await writeLegacy(legacy("jan", 1, "use"), legacy("feb", 2), legacy("mar", 3, "use"));
    let tree = () => runInDurableObject(space(key), (_instance, state) => {
      let storage = makeSpaceStorage(state.storage);
      return {
        version: storage.version.get(),
        roots: [...storage.workspaces.byParent.get("")].map(entry => entry.id).toSorted(),
        publishedRoots: [...storage.workspaces.byPublishedRoot.list()].map(entry => entry.id)
            .toSorted(),
      };
    });
    // The object that took the claim was awake before the entries were stored.
    expect(await tree()).toEqual({ version: 0, roots: [], publishedRoots: [] });
    expect(await space(key).open(mallory.profile.id)).toBeNull();

    await evictDurableObject(space(key));
    expect(await tree()).toEqual({
      version: SPACE_STORAGE_VERSION, roots: ["feb", "jan", "mar"], publishedRoots: ["jan", "mar"],
    });
    expect(await listing(key, alice)).toEqual(["mar", "feb", "jan"]);
    expect(await listing(key, mallory)).toEqual(["mar", "jan"]);

    expect(await space(key).attachWorkspaces(alice.profile, [ws("new", "feb")])).toBe(true);
    expect(await listing(key, alice)).toEqual(["mar", "feb", "feb/new", "jan"]);
    await space(key).detachWorkspace("feb", alice.profile.id);
    expect(await listing(key, alice)).toEqual(["mar", "new", "jan"]);
    await space(key).moveWorkspace(alice.profile.id, "jan", null, "mar");
    expect(await listing(key, alice)).toEqual(["jan", "mar", "new"]);

    // Woken again, it builds nothing: an entry stored the old way since stays out of the index.
    await writeLegacy(legacy("apr", 4));
    await evictDurableObject(space(key));
    expect(await tree())
        .toMatchObject({ version: SPACE_STORAGE_VERSION, roots: ["jan", "mar", "new"] });
  });

  it("stores a space it claims at the current version, so that it has nothing to build",
      async () => {
    let alice = await signUp("alice");
    let team = await createTeamSpace(alice);
    for (let key of [alice.personal, team]) {
      expect(await runInDurableObject(space(key), (_instance, state) =>
          makeSpaceStorage(state.storage).version.get())).toBe(SPACE_STORAGE_VERSION);
    }
  });

  it("writes nothing to the storage of a key nobody has claimed", async () => {
    let key = `team-${unique()}`;
    let mallory = await signUp("mallory");
    expect(await space(key).open(mallory.profile.id)).toBeNull();
    expect(await runInDurableObject(space(key), (_instance, state) =>
        [...state.storage.kv.list()])).toEqual([]);
  });
});
