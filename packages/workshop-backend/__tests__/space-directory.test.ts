// The space directory: what SpaceDirectoryDurableObject keeps of each space and the pages it
// lists them in; then what a space records for it, over a Map-backed storage; then the real
// Durable Objects -- which changes list or unlist a space, the alarm that pushes and retries
// beside the revocations it delivers, a space stored before the directory existed -- and
// AuthenticatedApi.listPublishedSpaces.

import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AiChatAuthorInfo, PublicApi, PublishedSpaceInfo,
} from "@gadgets/workshop-shared/api";
import { OverseerDurableObject } from "../src/overseer.js";
import worker from "../src/server.js";
import { SpaceDirectoryDurableObject } from "../src/space-directory.js";
import {
  SpaceModel, teamSpaceClaim, type SpaceDurableObject, type WorkspaceRegistration,
} from "../src/spaces.js";
import {
  makeSpaceStorage, SPACE_STORAGE_VERSION, type SpaceWorkspaceRecord,
} from "../src/storage-schema/space-storage.js";
import type { UserDurableObject } from "../src/user.js";
import { makeMockStorage } from "./mock-storage.js";
// Load the whole backend up front, so that its slow load is not billed to the first test.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_SPACE: DurableObjectNamespace<SpaceDurableObject>;
    TEST_SPACE_DIRECTORY: DurableObjectNamespace<SpaceDirectoryDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const CREATED = new Date("2026-01-01");
// Shorter than the test timeout, so that a wait which runs out fails with its own assertion.
const WAIT = { timeout: 4_000 };
const unique = () => crypto.randomUUID().slice(0, 8);
const profile = (id: string, name = id): AiChatAuthorInfo => ({ type: "user", id, name });
const ALICE = profile("alice", "Alice");

afterEach(() => {
  vi.restoreAllMocks();
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

// =======================================================================================
// The directory

// A directory of its own, which no space pushes to.
const directory = () => env.TEST_SPACE_DIRECTORY.getByName(`directory-${crypto.randomUUID()}`);
const team = (key: string, name = key): PublishedSpaceInfo => ({ key, name, kind: "team" });
const keysOf = (page: { spaces: PublishedSpaceInfo[] }) => page.spaces.map(space => space.key);
// The key of the nth of many spaces, which sort by it.
const nth = (n: number) => `s${String(n).padStart(3, "0")}`;

describe("SpaceDirectoryDurableObject", () => {
  it("lists a space as the newest push says, whatever order the pushes arrive in", async () => {
    let stub = directory();
    let listed = async () => keysOf(await stub.listSpaces());
    await stub.syncSpace(team("eng"), true, 2);
    expect(await listed()).toEqual(["eng"]);
    // An older push, and a replay of the newest, are both ignored.
    await stub.syncSpace(team("eng"), false, 1);
    await stub.syncSpace(team("eng"), false, 2);
    expect(await listed()).toEqual(["eng"]);

    await stub.syncSpace(team("eng"), false, 3);
    expect(await listed()).toEqual([]);
    // The row stays, unlisted, holding its revision: a push that lost the race lists nothing.
    await stub.syncSpace(team("eng"), true, 2);
    expect(await listed()).toEqual([]);
    await stub.syncSpace(team("eng"), true, 4);
    expect(await listed()).toEqual(["eng"]);
  });

  it("keeps of a personal space's owner the id and display name alone, and of a team space none",
      async () => {
    let stub = directory();
    let ada = { ...profile("ada@example.com", "Ada"), commitEmail: "a@example.org" };
    await stub.syncSpace({ key: "~ada", name: "Ada", kind: "personal", owner: ada }, true, 1);
    await stub.syncSpace(team("eng", "Engineering"), true, 1);

    let { spaces } = await stub.listSpaces();
    expect(spaces).toEqual([
      { key: "~ada", name: "Ada", kind: "personal", owner: profile("ada@example.com", "Ada") },
      { key: "eng", name: "Engineering", kind: "team" },
    ]);
    expect(spaces[1]).not.toHaveProperty("owner");
  });

  it("searches the key, the name and the owner's display name, ignoring case, and nothing else",
      async () => {
    let stub = directory();
    await stub.syncSpace(team("eng", "Engineering"), true, 1);
    await stub.syncSpace(
        { key: "~ada", name: "Ada", kind: "personal", owner: profile("ada@x.example", "Lovelace") },
        true, 1);
    await stub.syncSpace(team("ops", "100% Uptime"), true, 1);
    await stub.syncSpace(team("old", "Engines"), false, 1);
    let search = async (query: string) => keysOf(await stub.listSpaces(query));

    expect(await search("ENGIN")).toEqual(["eng"]);
    expect(await search("~ad")).toEqual(["~ada"]);
    expect(await search("lovelace")).toEqual(["~ada"]);
    expect(await search("uptime")).toEqual(["ops"]);
    expect(await search("%")).toEqual(["ops"]);
    expect(await search("_")).toEqual([]);
    // The owner's id is not searched.
    expect(await search("x.example")).toEqual([]);
    // A blank query lists every listed space.
    expect(await search("  ")).toEqual(["ops", "~ada", "eng"]);
  });

  it("orders by name, ignoring case, then by key, leaving out the spaces not listed", async () => {
    let stub = directory();
    await stub.syncSpace(team("k2", "Alpha"), true, 1);
    await stub.syncSpace(team("k3", "beta"), true, 1);
    await stub.syncSpace(team("k0", "Zeta"), true, 1);
    await stub.syncSpace(team("k1", "alpha"), true, 1);
    await stub.syncSpace(team("k4", "Aardvark"), false, 1);
    expect(keysOf(await stub.listSpaces())).toEqual(["k1", "k2", "k3", "k0"]);
  });

  it("pages fifty at a time, each continuing after the last space of the one before", async () => {
    let stub = directory();
    await Promise.all(Array.from({ length: 120 }, (_, n) =>
        stub.syncSpace(team(nth(n), `Space ${nth(n)}`), true, 1)));
    let range = (from: number, to: number) =>
        Array.from({ length: to - from }, (_, n) => nth(from + n));

    let first = await stub.listSpaces();
    expect(keysOf(first)).toEqual(range(0, 50));
    expect(first.cursor).toBeDefined();
    // Within a search too, where a last page that is full has no cursor.
    let searched = await stub.listSpaces("space s0");
    expect(keysOf(searched)).toEqual(range(0, 50));
    let rest = await stub.listSpaces("space s0", searched.cursor);
    expect(keysOf(rest)).toEqual(range(50, 100));
    expect(rest).not.toHaveProperty("cursor");

    // The space a cursor came from stops being listed: the next page starts after it all the
    // same.
    await stub.syncSpace(team(nth(49), `Space ${nth(49)}`), false, 2);
    let second = await stub.listSpaces(undefined, first.cursor);
    expect(keysOf(second)).toEqual(range(50, 100));
    let third = await stub.listSpaces(undefined, second.cursor);
    expect(keysOf(third)).toEqual(range(100, 120));
    expect(third).not.toHaveProperty("cursor");
  });

  it("takes a cursor for a place in the order, so that it tells nothing of a space not listed",
      async () => {
    let stub = directory();
    await stub.syncSpace(team("a", "Alpha"), true, 1);
    await stub.syncSpace(team("hidden", "Beta"), false, 1);
    await stub.syncSpace(team("c", "Gamma"), true, 1);
    // A key alone is refused alike, whether a space was ever listed under it or not ...
    await expectRejection(stub.listSpaces(undefined, "hidden"), "Invalid cursor.");
    await expectRejection(stub.listSpaces(undefined, "nowhere"), "Invalid cursor.");
    // ... and a place continues alike, whether a space sits at it or not.
    let rest = { spaces: [team("c", "Gamma")] };
    expect(await stub.listSpaces(undefined, "hidden\nBeta")).toEqual(rest);
    expect(await stub.listSpaces(undefined, "nowhere\nBeta")).toEqual(rest);
  });

  it("continues a page between names that differ only in case", async () => {
    let stub = directory();
    await Promise.all(Array.from({ length: 49 }, (_, n) =>
        stub.syncSpace(team(nth(n), `aa${nth(n)}`), true, 1)));
    // Last on the first page, and first on the second, in the order of their keys.
    await stub.syncSpace(team("upper", "Alpha"), true, 1);
    await stub.syncSpace(team("lower", "alpha"), true, 1);

    let first = await stub.listSpaces();
    expect(keysOf(first).slice(-2)).toEqual([nth(48), "lower"]);
    expect(await stub.listSpaces(undefined, first.cursor)).toEqual(
        { spaces: [team("upper", "Alpha")] });
  });

  it("bounds the query and refuses a line break in it", async () => {
    let stub = directory();
    await stub.syncSpace(team("eng", "Engineering"), true, 1);
    expect(await stub.listSpaces("a".repeat(1000))).toEqual({ spaces: [] });
    await expectRejection(stub.listSpaces("a".repeat(1001)), "at most 1000 characters");
    // The searched fields are stored joined by line breaks.
    await expectRejection(stub.listSpaces("eng\nengineering"), "no line breaks");
    await expectRejection(stub.listSpaces("eng\rengineering"), "no line breaks");
  });
});

// =======================================================================================
// What a space records for the directory

// A registration of workspace `id`, at the top of the tree or under `parentId`, published or not.
const ws = (id: string, parentId?: string, more: Partial<WorkspaceRegistration> = {})
    : WorkspaceRegistration =>
    ({ id, title: id, created: CREATED, placement: { parentId }, ...more });
const published = (id: string, parentId?: string) => ws(id, parentId, { published: "use" });
const unpublished = (id: string) => ws(id);

function teamModel() {
  let storage = makeSpaceStorage(makeMockStorage());
  let model = new SpaceModel(storage);
  model.claim(teamSpaceClaim("eng", "Engineering"), ALICE);
  return { model, storage, state: () => storage.directory.get() };
}

describe("a space's state for the directory", () => {
  it("is recorded on each change that lists or unlists the space, and on no other", () => {
    let { model, state } = teamModel();
    model.attachWorkspaces(ALICE, [ws("root"), published("child", "root")]);
    expect(model.listed).toBe(false);
    expect(state()).toBeUndefined();

    model.attachWorkspaces(ALICE, [published("root")]);
    expect(model.listed).toBe(true);
    expect(state()).toEqual({ listed: true, rev: 1, pushed: false, due: 0, retryMs: 0 });
    // Neither a second published root, nor its slug, nor its detach changes the answer.
    model.attachWorkspaces(ALICE, [published("other")]);
    model.setWorkspaceSlug(ALICE.id, "other", "elsewhere");
    model.detachWorkspace("other", ALICE.id);
    expect(state()).toMatchObject({ listed: true, rev: 1 });

    // Its only published root moved under an unpublished entry, the space is unlisted ...
    model.attachWorkspaces(ALICE, [ws("folder")]);
    model.moveWorkspace(ALICE.id, "root", "folder");
    expect(state()).toEqual({ listed: false, rev: 2, pushed: false, due: 0, retryMs: 0 });
    // ... and listed again when that entry leaves and its own entries move up into its place.
    model.detachWorkspace("folder", ALICE.id);
    expect(state()).toMatchObject({ listed: true, rev: 3, pushed: false });
    model.attachWorkspaces(ALICE, [unpublished("root")]);
    expect(state()).toMatchObject({ listed: false, rev: 4, pushed: false });
  });

  it("is pushed once, or kept for an attempt that waits longer each time, unless a newer one "
      + "is recorded meanwhile", () => {
    let { model, state } = teamModel();
    model.attachWorkspaces(ALICE, [published("root")]);
    let first = model.pendingDirectoryPush!;
    expect(first).toEqual(state());

    let now = 0;
    let waits: number[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      model.directoryPushDeferred(model.pendingDirectoryPush!, now);
      waits.push(model.pendingDirectoryPush!.due - now);
      now = model.pendingDirectoryPush!.due;
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 300].map(seconds => seconds * 1_000));

    // A newer state is due at once, and what becomes of the push of an older one leaves it alone.
    let older = model.pendingDirectoryPush!;
    model.attachWorkspaces(ALICE, [unpublished("root")]);
    model.directoryPushDeferred(older, now);
    model.directoryPushed(older);
    let newer = model.pendingDirectoryPush!;
    expect(newer).toEqual({ listed: false, rev: 2, pushed: false, due: 0, retryMs: 0 });

    model.directoryPushed(newer);
    expect(model.pendingDirectoryPush).toBeUndefined();
    expect(state()).toEqual({ ...newer, pushed: true });
  });
});

// =======================================================================================
// The real Durable Objects

const space = (key: string) => env.TEST_SPACE.getByName(key);
// The deployment's own directory, which every space pushes to.
const deployment = () => env.TEST_SPACE_DIRECTORY.getByName("");
// Whether the deployment's directory lists space `key`, whose key no other space's contains.
const inDirectory = async (key: string) =>
    keysOf(await deployment().listSpaces(key)).includes(key);
const stateOf = (key: string) => runInDurableObject(space(key), (_instance, state) =>
    makeSpaceStorage(state.storage).directory.get());
const alarmOf = (key: string) =>
    runInDurableObject(space(key), (_instance, state) => state.storage.getAlarm());
// An id that names a workspace's Overseer, which a revocation has to be able to reach.
const workspaceId = () => env.TEST_OVERSEER.newUniqueId().toString();
// The id of the object a spy on one of its methods was called on.
const objectId = (object: unknown) => (object as { ctx: DurableObjectState }).ctx.id.toString();

// A team space under a fresh key, created by `admin`.
async function teamSpace(admin = ALICE): Promise<string> {
  let key = `team-${unique()}`;
  expect(await space(key).claim(teamSpaceClaim(key, "Team"), admin)).toBe(true);
  return key;
}

// Waits for space `key` to be listed in the directory, or not, as its state says it pushed.
async function settled(key: string, listed: boolean) {
  await vi.waitFor(async () => {
    expect(await inDirectory(key)).toBe(listed);
    expect(await stateOf(key)).toMatchObject({ listed, pushed: true });
  }, WAIT);
  await vi.waitFor(async () => expect(await alarmOf(key)).toBeNull(), WAIT);
}

// Every push to a directory, passed through unless `reachable` refuses the space it is for.
function pushes(reachable: (key: string) => boolean = () => true) {
  let { syncSpace } = SpaceDirectoryDurableObject.prototype;
  let spy = vi.spyOn(SpaceDirectoryDurableObject.prototype, "syncSpace")
      .mockImplementation(function (this: SpaceDirectoryDurableObject, ...push) {
        if (!reachable(push[0].key)) throw new Error("directory unavailable");
        return syncSpace.apply(this, push);
      });
  return { spy, of: (key: string) => spy.mock.calls.filter(([pushed]) => pushed.key === key) };
}

// Holds every push to a directory for space `key` until it is released, as a directory that
// does not answer would.
function heldPushes(key: string) {
  let release!: () => void;
  let held = new Promise<void>(resolve => { release = resolve; });
  let { syncSpace } = SpaceDirectoryDurableObject.prototype;
  let spy = vi.spyOn(SpaceDirectoryDurableObject.prototype, "syncSpace")
      .mockImplementation(async function (this: SpaceDirectoryDurableObject, ...push) {
        if (push[0].key === key) await held;
        return syncSpace.apply(this, push);
      });
  return { attempted: () => spy.mock.calls.some(([pushed]) => pushed.key === key), release };
}

// A signed-in user, whose display name is their id.
async function signUp(name: string): Promise<AiChatAuthorInfo> {
  let id = `${name}-${unique()}`;
  await env.TEST_USER.getByName(id).authenticateFromCfAccess(id, true);
  return profile(id);
}

describe("a space, for the directory", () => {
  it("is listed once a published workspace sits at the top of its tree, and not for one under "
      + "an unpublished workspace", async () => {
    let key = await teamSpace();
    let { of } = pushes();
    expect(await space(key).attachWorkspaces(ALICE, [ws("root"), published("child", "root")]))
        .toBe(true);
    expect(await stateOf(key)).toBeUndefined();
    expect(await alarmOf(key)).toBeNull();

    expect(await space(key).attachWorkspaces(ALICE, [published("root")])).toBe(true);
    await settled(key, true);
    expect(of(key).map(([, listed, rev]) => [listed, rev])).toEqual([[true, 1]]);
    expect(await deployment().listSpaces(key)).toEqual({ spaces: [team(key, "Team")] });
  });

  it("is unlisted once its last published root is not published, and only then", async () => {
    let key = await teamSpace();
    let { of } = pushes();
    await space(key).attachWorkspaces(ALICE, [published("a"), published("b")]);
    await settled(key, true);

    await space(key).attachWorkspaces(ALICE, [unpublished("a")]);
    expect(await stateOf(key)).toMatchObject({ listed: true, rev: 1, pushed: true });
    await space(key).attachWorkspaces(ALICE, [unpublished("b")]);
    await settled(key, false);
    expect(of(key).map(([, listed, rev]) => [listed, rev])).toEqual([[true, 1], [false, 2]]);
  });

  it("is unlisted when its only published root is moved under an unpublished workspace",
      async () => {
    let key = await teamSpace();
    await space(key).attachWorkspaces(ALICE, [ws("folder"), published("root")]);
    await settled(key, true);
    await space(key).moveWorkspace(ALICE.id, "root", "folder");
    await settled(key, false);
    expect(await stateOf(key)).toMatchObject({ rev: 2 });
  });

  it("is listed when an unpublished workspace leaves and the published one under it moves up",
      async () => {
    let key = await teamSpace();
    await space(key).attachWorkspaces(ALICE, [ws("folder"), published("child", "folder")]);
    expect(await stateOf(key)).toBeUndefined();
    await space(key).detachWorkspace("folder", ALICE.id);
    await settled(key, true);
    expect(await stateOf(key)).toMatchObject({ rev: 1 });
  });

  it("leaves the push to its alarm, so the change that lists it never waits on the directory",
      async () => {
    let key = await teamSpace();
    let { attempted, release } = heldPushes(key);
    try {
      expect(await space(key).attachWorkspaces(ALICE, [published("root")])).toBe(true);
      expect(await stateOf(key)).toMatchObject({ listed: true, rev: 1, pushed: false });
      await vi.waitFor(() => expect(attempted()).toBe(true), WAIT);
      expect(await inDirectory(key)).toBe(false);
    } finally {
      release();
    }
    await settled(key, true);
  });

  it("pushes again, after a wait, what the directory did not take, until it lands", async () => {
    let key = await teamSpace();
    let refusals = 1;
    let { of } = pushes(pushed => pushed !== key || refusals-- <= 0);
    await space(key).attachWorkspaces(ALICE, [published("root")]);
    await vi.waitFor(async () => {
      expect(of(key)).toHaveLength(1);
      expect(await stateOf(key)).toMatchObject(
          { listed: true, rev: 1, pushed: false, retryMs: 1_000 });
    }, WAIT);
    expect(await alarmOf(key)).toBeGreaterThan(Date.now());
    expect(await inDirectory(key)).toBe(false);

    await settled(key, true);
    expect(of(key)).toHaveLength(2);
  });

  it("delivers a revocation while the directory cannot be reached, and pushes once it can",
      async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    let key = await teamSpace(alice);
    await space(key).setMemberRole(alice.id, bob.id, "build");
    let id = workspaceId();
    await space(key).attachWorkspaces(alice, [published(id)]);
    await settled(key, true);
    expect(await space(key).workspaceRole(id, alice.id, bob.id)).toBe("build");

    let reachable = false;
    pushes(pushed => pushed !== key || reachable);
    let revoke = vi.spyOn(OverseerDurableObject.prototype, "revokeSpaceAccess");
    await space(key).detachWorkspace(id, alice.id);
    await vi.waitFor(() => expect(revoke.mock.contexts.map(objectId)).toContain(id), WAIT);
    expect(await stateOf(key)).toMatchObject({ listed: false, pushed: false });
    expect(await inDirectory(key)).toBe(true);

    reachable = true;
    await settled(key, false);
  });

  it("delivers a revocation queued while the directory does not answer a push", async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    let key = await teamSpace(alice);
    await space(key).setMemberRole(alice.id, bob.id, "build");
    let id = workspaceId();
    await space(key).attachWorkspaces(alice, [ws(id)]);
    expect(await space(key).workspaceRole(id, alice.id, bob.id)).toBe("build");

    let { attempted, release } = heldPushes(key);
    let revoke = vi.spyOn(OverseerDurableObject.prototype, "revokeSpaceAccess");
    try {
      await space(key).attachWorkspaces(alice, [published(id)]);
      await vi.waitFor(() => expect(attempted()).toBe(true), WAIT);
      await space(key).removeMember(alice.id, bob.id);
      // Longer than the alarm waits on the directory before it counts a push as not taken.
      await vi.waitFor(() => expect(revoke.mock.contexts.map(objectId)).toContain(id),
          { timeout: 8_000 });
    } finally {
      release();
    }
    await settled(key, true);
  }, 15_000);

  it("pushes to the directory while a revocation cannot be delivered", async () => {
    let [alice, bob] = await Promise.all([signUp("alice"), signUp("bob")]);
    let key = await teamSpace(alice);
    await space(key).setMemberRole(alice.id, bob.id, "build");
    let id = workspaceId();
    await space(key).attachWorkspaces(alice, [ws(id)]);
    expect(await space(key).workspaceRole(id, alice.id, bob.id)).toBe("build");

    let { revokeSpaceAccess } = OverseerDurableObject.prototype;
    let reachable = false;
    vi.spyOn(OverseerDurableObject.prototype, "revokeSpaceAccess")
        .mockImplementation(async function (this: OverseerDurableObject, profileId) {
          if (objectId(this) === id && !reachable) throw new Error("workspace unavailable");
          return revokeSpaceAccess.call(this, profileId);
        });
    let queued = () => runInDurableObject(space(key), (_instance, state) =>
        [...makeSpaceStorage(state.storage).revocations.list()].map(r => r.workspace));
    await space(key).removeMember(alice.id, bob.id);
    await space(key).attachWorkspaces(alice, [published(id)]);
    await vi.waitFor(async () => {
      expect(await inDirectory(key)).toBe(true);
      expect(await stateOf(key)).toMatchObject({ listed: true, pushed: true });
    }, WAIT);
    expect(await queued()).toEqual([id]);

    reachable = true;
    await vi.waitFor(async () => expect(await queued()).toEqual([]), WAIT);
  });
});

describe("a space stored before the directory existed", () => {
  it("is listed once, as it wakes, if a published workspace sits at the top of its tree",
      async () => {
    let [listed, unlisted] = await Promise.all([teamSpace(), teamSpace()]);
    // As a space was stored then: its entries as they are now, at the version before.
    for (let [key, publishedAs] of [[listed, "use"], [unlisted, undefined]] as const) {
      await runInDurableObject(space(key), (_instance, state) => {
        let storage = makeSpaceStorage(state.storage);
        let entry: SpaceWorkspaceRecord = {
          id: "root", title: "Root", slug: "root", owner: ALICE, created: CREATED,
          ...(publishedAs && { published: publishedAs }),
        };
        storage.workspaces.put(entry);
        storage.version.put(1);
      });
    }
    let { of } = pushes();

    await Promise.all([evictDurableObject(space(listed)), evictDurableObject(space(unlisted))]);
    // Waking is what migrates a space's storage, before the call that woke it is delivered.
    expect(await stateOf(listed)).toMatchObject({ listed: true, rev: 1 });
    await settled(listed, true);
    expect(of(listed).map(([, isListed, rev]) => [isListed, rev])).toEqual([[true, 1]]);
    expect(await stateOf(unlisted)).toBeUndefined();
    expect(await alarmOf(unlisted)).toBeNull();
    expect(of(unlisted)).toEqual([]);
    for (let key of [listed, unlisted]) {
      expect(await runInDurableObject(space(key), (_instance, state) =>
          makeSpaceStorage(state.storage).version.get())).toBe(SPACE_STORAGE_VERSION);
    }

    // Woken again, it pushes nothing more.
    await evictDurableObject(space(listed));
    expect(await alarmOf(listed)).toBeNull();
    expect(of(listed)).toHaveLength(1);
  });

  it("keeps the state it holds for the directory, recorded by a change before it was brought "
      + "up to date", async () => {
    let key = await teamSpace();
    let held = { listed: true, rev: 3, pushed: true, due: 0, retryMs: 0 };
    await runInDurableObject(space(key), (_instance, state) => {
      let storage = makeSpaceStorage(state.storage);
      storage.workspaces.put({
        id: "root", title: "Root", slug: "root", owner: ALICE, created: CREATED, published: "use",
      });
      storage.directory.put(held);
      storage.version.put(1);
    });
    let { of } = pushes();

    await evictDurableObject(space(key));
    expect(await stateOf(key)).toEqual(held);
    expect(await alarmOf(key)).toBeNull();
    expect(of(key)).toEqual([]);
  });
});

describe("AuthenticatedApi.listPublishedSpaces", () => {
  it("lists the spaces open to visitors, the caller's own among them", async () => {
    let username = `viewer${unique()}`;
    let viewer = env.TEST_USER.getByName(username);
    let token = await viewer.createAccount(username, "Viewer", new Uint8Array(32));
    let key = await teamSpace(profile(username, "Viewer"));
    await space(key).attachWorkspaces(profile(username, "Viewer"), [published("root")]);
    await settled(key, true);

    // The pool binds no AdminSettings namespace (see admin-settings-models.test.ts), so the
    // request's context stands in for the install of the bundled blueprints that a request to
    // the API starts, and passes every other export through to the Worker's own.
    let ctx = {
      waitUntil() {}, passThroughOnException() {}, props: {},
      exports: new Proxy(exports, {
        get: (target, name) => name !== "AdminSettings" ? Reflect.get(target, name)
            : { getByName: () => ({ ensureBundledBlueprintsInstalled: async () => true }) },
      }),
    } as unknown as ExecutionContext;
    let response = await worker.fetch!(new Request(
        "https://workshop.example/api", { headers: { Upgrade: "websocket" } }), env, ctx);
    let socket = response.webSocket!;
    socket.accept();
    try {
      using publicApi = newWebSocketRpcSession<PublicApi>(socket);
      using api = await publicApi.authenticate(`${username}:${token}`);
      expect(await api.listPublishedSpaces(key)).toEqual({ spaces: [team(key, "Team")] });
      expect(await api.listPublishedSpaces(`${key}-not`)).toEqual({ spaces: [] });
    } finally {
      socket.close();
    }
  });
});
