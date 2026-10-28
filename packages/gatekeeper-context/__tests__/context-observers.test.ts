import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ObserverKv } from "@gadgets/gatekeeper-kit/observers";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import {
  legacyObservedCollections, observersWithAccess, retireLegacyObserver,
} from "../src/context-observers.js";
import { domainName } from "../src/domain.js";
import { ContextVerifier } from "../src/library-gatekeeper.js";

// The miniflare bindings vitest.config.ts declares, which Cloudflare.Env does not.
const testEnv = env as unknown as { COLLECTIONS: DurableObjectNamespace<ContextCollectionDurableObject> };
const collections = testEnv.COLLECTIONS;

// Storage persists across the file's tests, so each gets its own sharing domain.
let domain = "";
let domains = 0;
beforeEach(() => {
  domain = `observers-${domains++}.example`;
});

const collection = (id: string) => collections.get(collections.idFromName(domainName(domain, id)));

async function createCollection(id: string, visibility: "private" | "public", owner = "alice") {
  let now = new Date();
  await collection(id).initialize({
    id, title: id, description: "", visibility,
    created: now, lastUpdated: now, documentCount: 0, content: { source: "web" },
  }, domain, visibility === "private" ? owner : "");
}

// An observer as the Workshop hands it over: the account's own verifier. The test runner's exports
// hold only the Durable Objects, so the verifier is built around a context giving it theirs.
const observer = (accountId: string, sharingDomain = domain) => ({
  id: accountId,
  verifier: new ContextVerifier({
    props: { sharingDomain, accountId },
    exports: { ContextCollectionDurableObject: collections },
  } as unknown as ConstructorParameters<typeof ContextVerifier>[0], env as Cloudflare.Env) as
    unknown as Fetcher<GatekeeperUserVerifier>,
});

const allowed = (accountIds: string[], collectionIds: string[]) =>
  observersWithAccess(domain, accountIds.map(accountId => observer(accountId)), collectionIds);

describe("observersWithAccess", () => {
  it("allows exactly the observers who can read every collection now", async () => {
    await createCollection("shared", "private");
    await collection("shared").share("alice", [{ accountId: "bob", displayName: "bob" }], "viewer");
    await createCollection("everyone", "private");
    await collection("everyone").setEveryoneCanView("alice", true);
    await createCollection("public", "public");
    await createCollection("unshared", "private");
    await createCollection("deleted", "private");
    await collection("deleted").removeAccount("alice");

    let everyone = ["alice", "bob", "carol"];
    expect(await allowed(everyone, ["everyone", "public"])).toEqual(everyone);
    expect(await allowed(everyone, ["shared", "everyone", "public"])).toEqual(["alice", "bob"]);
    expect(await allowed(everyone, ["unshared", "public"])).toEqual(["alice"]);
    expect(await allowed(everyone, ["deleted"])).toEqual([]);
    expect(await allowed(everyone, ["never-created"])).toEqual([]);
    // Another sharing domain's account, even one with the same ID, reads none of this domain.
    expect(await observersWithAccess(domain, [observer("alice", "elsewhere.example")], ["public"]))
      .toEqual([]);
  });

  it("denies an observer as soon as their access is revoked", async () => {
    await createCollection("shared", "private");
    await collection("shared").share("alice", [{ accountId: "bob", displayName: "bob" }], "viewer");
    expect(await allowed(["bob"], ["shared"])).toEqual(["bob"]);

    await collection("shared").removeMember("alice", "bob");

    expect(await allowed(["bob"], ["shared", "shared"])).toEqual([]);
  });
});

describe("legacy observer tracking", () => {
  it("exports every collection the binding's own tracker recorded, after retiring its observers", () => {
    // The layout the kit tracker left in a binding's storage: one marker per collection a read
    // revealed, beside each admitted observer and each admission in flight.
    let storage = new Map<string, unknown>([
      ["observedCollection:unshared", true],
      ["observedCollection:shared", "observed"],
      ["observedCollection:uncertain", "pending"],
      ["observer:collaborator", "verifier"],
      ["observer-attempt:candidate", { verifier: "verifier", at: Date.now() }],
      ["observer-nonce:candidate", "nonce"],
    ]);
    let kv: ObserverKv = {
      get: <T>(key: string) => storage.get(key) as T | undefined,
      put: (key, value) => void storage.set(key, value),
      delete: key => storage.delete(key),
      list: <T>({ prefix = "" }: { prefix?: string } = {}) =>
        [...storage].filter(([key]) => key.startsWith(prefix)) as [string, T][],
    };

    retireLegacyObserver(kv, "collaborator");
    retireLegacyObserver(kv, "candidate");

    expect([...storage.keys()].every(key => key.startsWith("observedCollection:"))).toBe(true);
    // Repeatable: the Workshop asks again if its import does not commit.
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(legacyObservedCollections(kv).toSorted()).toEqual(["shared", "uncertain", "unshared"]);
    }
  });
});
