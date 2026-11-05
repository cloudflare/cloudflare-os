import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MAX_DIRECTORY_TEXT_LENGTH } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";
// Load the whole backend (the pool's `main`) up front. Otherwise the pool loads it on the first
// RPC into the Durable Object, and that slow load counts against the first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
  }
}

function directory(name: string) {
  return env.TEST_USER_DIRECTORY.getByName(`${name}-${crypto.randomUUID()}`);
}

function user(id: string, name: string) {
  return { id, name };
}

// Await a stub call's rejection with a single handler: expect(...).rejects forks the underlying
// JsRpcPromise (each .then mints a fresh RPC continuation), and the leftover copy is reported as
// an unhandled rejection (see overseer-hooks.test.ts).
async function expectRejection(call: Promise<unknown>, message: string): Promise<void> {
  let caught: unknown;
  let rejected = false;
  try { await call; } catch (err) { rejected = true; caught = err; }
  expect(rejected).toBe(true);
  expect(String(caught)).toContain(message);
}

describe("UserDirectoryDurableObject", () => {
  it("upserts profiles, matches name or id case-insensitively, and excludes requested users", async () => {
    const stub = directory("upsert");
    await stub.syncUser(user("ada@example.com", "Ada Lovelace"), 0);
    await stub.syncUser(user("grace@example.com", "Grace Hopper"), 0);

    await expect(stub.searchUsers("LOVE", [])).resolves.toEqual([
      user("ada@example.com", "Ada Lovelace"),
    ]);
    await expect(stub.searchUsers("love", ["ada@example.com"])).resolves.toEqual([]);
    await expect(stub.searchUsers("grace@", ["ada@example.com"])).resolves.toEqual([
      user("grace@example.com", "Grace Hopper"),
    ]);

    await stub.syncUser(user("ada@example.com", "Augusta Ada King"), 1);
    await expect(stub.searchUsers("lovelace", [])).resolves.toEqual([]);
    await expect(stub.searchUsers("augusta", [])).resolves.toEqual([
      user("ada@example.com", "Augusta Ada King"),
    ]);
  });

  it("keeps the highest revision when syncs arrive out of order", async () => {
    const stub = directory("revision");
    await stub.syncUser(user("ada@example.com", "Newest"), 2);
    // A stale sync (an older snapshot that lost the race) and a replay of the same revision are
    // both ignored; only a higher revision replaces the record.
    await stub.syncUser(user("ada@example.com", "Stale"), 1);
    await stub.syncUser(user("ada@example.com", "Replay"), 2);
    await expect(stub.searchUsers("ada@", [])).resolves.toEqual([
      user("ada@example.com", "Newest"),
    ]);

    await stub.syncUser(user("ada@example.com", "Newer Still"), 3);
    await expect(stub.searchUsers("ada@", [])).resolves.toEqual([
      user("ada@example.com", "Newer Still"),
    ]);
  });

  it("ranks the earliest match first and treats pattern characters literally", async () => {
    const stub = directory("rank");
    await stub.syncUser(user("al@example.com", "Al Li"), 0);
    await stub.syncUser(user("sally@example.com", "Sally"), 0);
    await stub.syncUser(user("%percent", "Percent"), 0);
    await stub.syncUser(user("q@example.com", "A \"Quoted\" AND Person"), 0);

    await expect(stub.searchUsers("al", [])).resolves.toEqual([
      user("al@example.com", "Al Li"),
      user("sally@example.com", "Sally"),
    ]);
    await expect(stub.searchUsers("%", [])).resolves.toEqual([
      user("%percent", "Percent"),
    ]);
    await expect(stub.searchUsers("\"Quoted\" AND", [])).resolves.toEqual([
      user("q@example.com", "A \"Quoted\" AND Person"),
    ]);
    await expect(stub.searchUsers("  ", [])).resolves.toEqual([]);
  });

  it("ranks an exact canonical id ahead of an identical display name", async () => {
    const stub = directory("exact-id-rank");
    await stub.syncUser(user("attacker@example.com", "victim@example.com"), 0);
    await stub.syncUser(user("victim@example.com", "Real Victim"), 0);

    await expect(stub.searchUsers("victim@example.com", [])).resolves.toEqual([
      user("victim@example.com", "Real Victim"),
      user("attacker@example.com", "victim@example.com"),
    ]);
  });

  it("does not match across the name/id boundary", async () => {
    const stub = directory("boundary");
    await stub.syncUser(user("ada@example.com", "Grace"), 0);

    await expect(stub.searchUsers("ceada", [])).resolves.toEqual([]);
    await expect(stub.searchUsers("grace", [])).resolves.toEqual([
      user("ada@example.com", "Grace"),
    ]);
    // The stored id and name are separated by a newline, so a query may not contain one.
    await expectRejection(stub.searchUsers("com\ngra", []), "no line breaks");
    await expectRejection(stub.searchUsers("com\rgra", []), "no line breaks");
  });

  it("bounds the query length and the distinct exclusions", async () => {
    const stub = directory("bounds");
    await stub.syncUser(user("ada@example.com", "Ada"), 0);

    await expect(stub.searchUsers("a".repeat(1000), [])).resolves.toEqual([]);
    await expectRejection(stub.searchUsers("a".repeat(1001), []), "at most 1000 characters");

    const distinct = Array.from({ length: 1000 }, (_, index) => `user${index}`);
    await expect(stub.searchUsers("ada", distinct)).resolves.toEqual([user("ada@example.com", "Ada")]);
    // Duplicates collapse before the limit applies; one more distinct id is over it.
    await expect(stub.searchUsers("ada", [...distinct, ...distinct])).resolves.toEqual([
      user("ada@example.com", "Ada"),
    ]);
    await expectRejection(stub.searchUsers("ada", [...distinct, "user1000"]), "At most 1000 users");
  });

  it("applies exclusions before capping broad matches at ten results", async () => {
    const stub = directory("limit");
    await Promise.all(Array.from({ length: 12 }, (_, index) => stub.syncUser(user(
      `user${index.toString().padStart(2, "0")}@example.com`,
      `Common Person ${index.toString().padStart(2, "0")}`,
    ), 0)));

    const results = await stub.searchUsers("common", [
      "user00@example.com",
      "user01@example.com",
    ]);
    expect(results).toHaveLength(10);
    expect(results.map(result => result.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `user${(index + 2).toString().padStart(2, "0")}@example.com`),
    );
  });
});

// Reads the directory's own tables, to check what a row holds rather than what a read returns.
function stored<T extends Record<string, SqlStorageValue>>(
    stub: DurableObjectStub<UserDirectoryDurableObject>, query: string): Promise<T[]> {
  return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<T>(query).toArray());
}

const HOUR = 60 * 60_000;

describe("UserDirectoryDurableObject activity", () => {
  it("keeps the first creation time and only advances the last login", async () => {
    const stub = directory("activity");
    const created = new Date(1_000 * HOUR);
    await stub.syncUser(user("ada@example.com", "Ada"), 0, { created, lastLogin: new Date(1_001 * HOUR) });
    await stub.syncUser(user("ada@example.com", "Ada"), 0, {
      created: new Date(2_000 * HOUR), lastLogin: new Date(1_000 * HOUR),
    });
    await expect(stub.listUsers({ limit: 10 })).resolves.toEqual({
      users: [{ id: "ada@example.com", name: "Ada", created, lastLogin: new Date(1_001 * HOUR) }],
    });

    // A stale profile revision leaves the name alone, but its activity still merges.
    await stub.syncUser(user("ada@example.com", "Augusta"), 1);
    await stub.syncUser(user("ada@example.com", "Stale"), 0, { lastLogin: new Date(1_005 * HOUR) });
    await expect(stub.listUsers({ limit: 10 })).resolves.toEqual({
      users: [{ id: "ada@example.com", name: "Augusta", created, lastLogin: new Date(1_005 * HOUR) }],
    });
  });

  it("omits activity it has not been told", async () => {
    const stub = directory("no-activity");
    await stub.syncUser(user("ada@example.com", "Ada"), 0);
    await stub.syncUser(user("grace@example.com", "Grace"), 0, { lastLogin: new Date(HOUR) });
    const { users } = await stub.listUsers({ limit: 10 });
    expect(users).toEqual([
      { id: "ada@example.com", name: "Ada" },
      { id: "grace@example.com", name: "Grace", lastLogin: new Date(HOUR) },
    ]);
    expect(Object.keys(users[0])).toEqual(["id", "name"]);
  });
});

describe("UserDirectoryDurableObject.listUsers", () => {
  it("pages in id order", async () => {
    const stub = directory("list-users");
    for (const id of ["e", "c", "a", "d", "b"]) await stub.syncUser(user(id, id.toUpperCase()), 0);

    const first = await stub.listUsers({ limit: 2 });
    expect(first).toEqual({ users: [user("a", "A"), user("b", "B")], nextCursor: "b" });
    const second = await stub.listUsers({ cursor: first.nextCursor, limit: 2 });
    expect(second).toEqual({ users: [user("c", "C"), user("d", "D")], nextCursor: "d" });
    const last = await stub.listUsers({ cursor: second.nextCursor, limit: 2 });
    expect(last).toEqual({ users: [user("e", "E")] });
    // A page that ends exactly at the last user has no cursor either.
    await expect(stub.listUsers({ cursor: "c", limit: 2 })).resolves.toEqual({
      users: [user("d", "D"), user("e", "E")],
    });
  });

  it("matches a query against name or id and validates its options", async () => {
    const stub = directory("list-users-query");
    await stub.syncUser(user("ada@example.com", "Ada Lovelace"), 0);
    await stub.syncUser(user("grace@example.com", "Grace Hopper"), 0);

    await expect(stub.listUsers({ query: "  ", limit: 10 })).resolves.toEqual({
      users: [user("ada@example.com", "Ada Lovelace"), user("grace@example.com", "Grace Hopper")],
    });
    await expect(stub.listUsers({ query: "HOPPER", limit: 10 })).resolves.toEqual({
      users: [user("grace@example.com", "Grace Hopper")],
    });
    await expect(stub.listUsers({ query: "ADA@", limit: 10 })).resolves.toEqual({
      users: [user("ada@example.com", "Ada Lovelace")],
    });
    await expectRejection(stub.listUsers({ query: "a".repeat(1001), limit: 10 }), "at most 1000 characters");
    await expectRejection(stub.listUsers({ query: "ada\nlove", limit: 10 }), "no line breaks");
    await expectRejection(stub.listUsers({ limit: 0 }), "positive whole number");
    await expectRejection(stub.listUsers({ limit: 1.5 }), "positive whole number");
    // A cursor is a previous page's last id, which has no length limit.
    await expect(stub.listUsers({ cursor: "a".repeat(300_000), limit: 10 })).resolves.toEqual({
      users: [user("ada@example.com", "Ada Lovelace"), user("grace@example.com", "Grace Hopper")],
    });
  });
});

function workspace(id: string, title: string, ownerId: string,
    dates: { created?: Date; lastActive?: Date } = {}) {
  return { id, title, ownerId, ...dates };
}

describe("UserDirectoryDurableObject workspaces", () => {
  it("lets a higher revision replace the title and owner, and merges dates whatever the revision", async () => {
    const stub = directory("sync-workspace");
    await stub.syncWorkspace(workspace("w1", "First", "ada"), 10);
    await stub.syncWorkspace(workspace("w1", "Stale", "grace"), 9);
    await stub.syncWorkspace(workspace("w1", "Replay", "grace"), 10);
    await expect(stub.workspaceListing("w1")).resolves.toEqual({ title: "First", ownerId: "ada" });

    // A stale sync fills a missing creation time, and nothing else.
    await stub.syncWorkspace(workspace("w1", "Stale", "grace", { created: new Date(HOUR) }), 9);
    await stub.syncWorkspace(workspace("w1", "Stale", "grace", { created: new Date(2 * HOUR) }), 9);
    // The last activity advances and never regresses, whatever the revision.
    await stub.syncWorkspace(workspace("w1", "Stale", "grace", { lastActive: new Date(5 * HOUR) }), 9);
    await stub.syncWorkspace(workspace("w1", "First", "ada", { lastActive: new Date(4 * HOUR) }), 10);
    await expect(stub.listWorkspaces({ limit: 10 })).resolves.toEqual({
      workspaces: [{
        id: "w1", title: "First", owner: user("ada", "ada"),
        created: new Date(HOUR), lastActive: new Date(5 * HOUR),
      }],
    });

    // A reinitialised workspace outranks its earlier life.
    await stub.syncWorkspace(workspace("w1", "Reborn", "grace", { created: new Date(9 * HOUR) }), 11);
    await expect(stub.listWorkspaces({ limit: 10 })).resolves.toEqual({
      workspaces: [{
        id: "w1", title: "Reborn", owner: user("grace", "grace"),
        created: new Date(9 * HOUR), lastActive: new Date(5 * HOUR),
      }],
    });
    // A higher revision without a creation time keeps the stored one.
    await stub.syncWorkspace(workspace("w1", "Renamed", "grace"), 12);
    const { workspaces } = await stub.listWorkspaces({ limit: 10 });
    expect(workspaces[0]).toMatchObject({ title: "Renamed", created: new Date(9 * HOUR) });
  });

  it("filters by owner and query, joins owner names, pages and forgets", async () => {
    const stub = directory("list-workspaces");
    await stub.syncUser(user("ada@example.com", "Ada Lovelace"), 0);
    await stub.syncWorkspace(workspace("w1", "Engine notes", "ada@example.com"), 1);
    await stub.syncWorkspace(workspace("w2", "Compiler", "grace@example.com"), 1);
    await stub.syncWorkspace(workspace("w3", "Analytical", "ada@example.com"), 1);
    const w1 = { id: "w1", title: "Engine notes", owner: user("ada@example.com", "Ada Lovelace") };
    // An owner the directory has no user for is named by their id.
    const w2 = { id: "w2", title: "Compiler", owner: user("grace@example.com", "grace@example.com") };
    const w3 = { id: "w3", title: "Analytical", owner: user("ada@example.com", "Ada Lovelace") };

    await expect(stub.listWorkspaces({ owner: "ada@example.com", limit: 10 })).resolves.toEqual({
      workspaces: [w1, w3],
    });
    await expect(stub.listWorkspaces({ owner: "ada", limit: 10 })).resolves.toEqual({ workspaces: [] });
    await expect(stub.listWorkspaces({ query: "ENGINE", limit: 10 })).resolves.toEqual({ workspaces: [w1] });
    await expect(stub.listWorkspaces({ query: "w2", limit: 10 })).resolves.toEqual({ workspaces: [w2] });
    await expect(stub.listWorkspaces({ query: "grace@", limit: 10 })).resolves.toEqual({ workspaces: [w2] });
    // A query matches the owner's id, not their display name.
    await expect(stub.listWorkspaces({ query: "lovelace", limit: 10 })).resolves.toEqual({ workspaces: [] });

    const first = await stub.listWorkspaces({ limit: 2 });
    expect(first).toEqual({ workspaces: [w1, w2], nextCursor: "w2" });
    await expect(stub.listWorkspaces({ cursor: first.nextCursor, limit: 2 })).resolves.toEqual({
      workspaces: [w3],
    });

    await stub.removeWorkspace("w2");
    await expect(stub.listWorkspaces({ limit: 10 })).resolves.toEqual({ workspaces: [w1, w3] });
    await expect(stub.workspaceListing("w2")).resolves.toBeNull();

    await expectRejection(stub.listWorkspaces({ query: "a".repeat(1001), limit: 10 }), "at most 1000 characters");
    await expectRejection(stub.listWorkspaces({ query: "a\rb", limit: 10 }), "no line breaks");
    await expectRejection(stub.listWorkspaces({ limit: -1 }), "positive whole number");
    // Neither a cursor nor an owner filter is capped: both are ids.
    await expect(stub.listWorkspaces({ owner: "a".repeat(300_000), limit: 10 })).resolves.toEqual({
      workspaces: [],
    });
    await expect(stub.listWorkspaces({ cursor: "a".repeat(300_000), limit: 10 })).resolves.toEqual({
      workspaces: [w1, w3],
    });
  });

  it("looks up a workspace's title and owner", async () => {
    const stub = directory("workspace-title");
    await stub.syncWorkspace(workspace("w1", "Engine notes", "ada"), 1);
    await expect(stub.workspaceListing("w1")).resolves.toEqual({ title: "Engine notes", ownerId: "ada" });
    await expect(stub.workspaceListing("w9")).resolves.toBeNull();
    await expect(stub.workspaceListing("a".repeat(1000))).resolves.toBeNull();
    await expectRejection(stub.workspaceListing("a".repeat(1001)), "at most 1000 characters");
  });
});

describe("UserDirectoryDurableObject text bounds", () => {
  it("keeps and lists a long name as its first MAX_DIRECTORY_TEXT_LENGTH characters", async () => {
    const stub = directory("clamp-name");
    const name = "Ada " + "x".repeat(3 * 2 ** 20);
    await stub.syncUser(user("ada@example.com", name), 0);
    const clamped = name.slice(0, MAX_DIRECTORY_TEXT_LENGTH);

    await expect(stub.listUsers({ limit: 10 })).resolves.toEqual({
      users: [user("ada@example.com", clamped)],
    });
    await expect(stub.searchUsers("ada xx", [])).resolves.toEqual([user("ada@example.com", clamped)]);
    const [row] = await stored<{ name: number; search_text: number }>(stub,
      "SELECT length(name) AS name, length(search_text) AS search_text FROM users");
    expect(row.name).toBeLessThanOrEqual(2 * MAX_DIRECTORY_TEXT_LENGTH + 1);
    expect(row.search_text).toBeLessThanOrEqual(2 * MAX_DIRECTORY_TEXT_LENGTH + 1);
  });

  it("keeps a name of exactly the limit whole, and never keeps half a surrogate pair", async () => {
    const stub = directory("clamp-edges");
    const exact = "e".repeat(MAX_DIRECTORY_TEXT_LENGTH);
    // "😀" is two UTF-16 code units, the first at the last kept position.
    const straddling = "s".repeat(MAX_DIRECTORY_TEXT_LENGTH - 1) + "😀tail";
    await stub.syncUser(user("exact", exact), 0);
    await stub.syncUser(user("straddling", straddling), 0);

    await expect(stub.listUsers({ limit: 10 })).resolves.toEqual({
      users: [user("exact", exact), user("straddling", "s".repeat(MAX_DIRECTORY_TEXT_LENGTH - 1))],
    });
  });

  it("keeps and lists a long title clamped, with its owner's clamped name", async () => {
    const stub = directory("clamp-title");
    const name = "n".repeat(3 * 2 ** 20);
    const title = "t".repeat(3 * 2 ** 20);
    await stub.syncUser(user("ada", name), 0);
    await stub.syncWorkspace({ id: "w1", title, ownerId: "ada" }, 1);

    await expect(stub.listWorkspaces({ limit: 10 })).resolves.toEqual({
      workspaces: [{
        id: "w1",
        title: title.slice(0, MAX_DIRECTORY_TEXT_LENGTH),
        owner: user("ada", name.slice(0, MAX_DIRECTORY_TEXT_LENGTH)),
      }],
    });
    await expect(stub.workspaceListing("w1"))
        .resolves.toEqual({ title: title.slice(0, MAX_DIRECTORY_TEXT_LENGTH), ownerId: "ada" });
  });

  it("clamps the names of rows stored before the directory clamped them", async () => {
    const stub = directory("clamp-read");
    const name = "Old " + "o".repeat(4_996);
    // Stands for a row stored before names were clamped.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO users (id, name, search_text, rev) VALUES (?, ?, ?, 0)",
        "old", name, `old\n${name}`.toLowerCase());
    });
    await stub.syncWorkspace({ id: "w1", title: "Old work", ownerId: "old" }, 1);
    const clamped = user("old", name.slice(0, MAX_DIRECTORY_TEXT_LENGTH));

    await expect(stub.listUsers({ limit: 10 })).resolves.toEqual({ users: [clamped] });
    await expect(stub.listWorkspaces({ limit: 10 })).resolves.toEqual({
      workspaces: [{ id: "w1", title: "Old work", owner: clamped }],
    });
    await expect(stub.searchUsers("old o", [])).resolves.toEqual([clamped]);
  });

  it("stops a page early once its ids would pass a million characters", async () => {
    const stub = directory("page-budget");
    const ids = ["a", "b", "c", "d", "e"].map(letter => letter.repeat(300_000));
    for (const id of ids) await stub.syncUser(user(id, "N"), 0);

    const first = await stub.listUsers({ limit: 50 });
    expect(first.users.map(listed => listed.id)).toEqual(ids.slice(0, 3));
    expect(first.nextCursor).toBe(ids[2]);
    const second = await stub.listUsers({ cursor: first.nextCursor, limit: 50 });
    expect(second.users.map(listed => listed.id)).toEqual(ids.slice(3));
    expect(second.nextCursor).toBeUndefined();
  });

  it("lists a user whose id alone passes the budget on a page of its own", async () => {
    const stub = directory("page-budget-huge");
    const huge = "a".repeat(1_200_000);
    await stub.syncUser(user(huge, "Huge"), 0);
    await stub.syncUser(user("b", "B"), 0);

    const first = await stub.listUsers({ limit: 50 });
    expect(first.users.map(listed => listed.id)).toEqual([huge]);
    expect(first.nextCursor).toBe(huge);
    await expect(stub.listUsers({ cursor: first.nextCursor, limit: 50 })).resolves.toEqual({
      users: [user("b", "B")],
    });
  });

  it("bounds a page of workspaces by their owners' ids too", async () => {
    const stub = directory("page-budget-workspaces");
    const owners = ["a", "b", "c", "d", "e"].map(letter => letter.repeat(300_000));
    for (const [index, owner] of owners.entries()) {
      await stub.syncUser(user(owner, "N"), 0);
      await stub.syncWorkspace({ id: `w${index}`, title: "T", ownerId: owner }, 1);
    }

    const first = await stub.listWorkspaces({ limit: 50 });
    expect(first.workspaces.map(listed => listed.id)).toEqual(["w0", "w1", "w2"]);
    expect(first.nextCursor).toBe("w2");
    const second = await stub.listWorkspaces({ cursor: first.nextCursor, limit: 50 });
    expect(second.workspaces.map(listed => listed.id)).toEqual(["w3", "w4"]);
    expect(second.nextCursor).toBeUndefined();
  });
});
