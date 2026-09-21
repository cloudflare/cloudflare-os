import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";

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

// The first RPC into the DO pays for instantiating the whole backend bundle in its isolate (~5s
// on a dev machine when the pool is contended, as vitest.integration.config.ts also notes); the
// remaining calls take milliseconds.
describe("UserDirectoryDurableObject", { timeout: 30_000 }, () => {
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
