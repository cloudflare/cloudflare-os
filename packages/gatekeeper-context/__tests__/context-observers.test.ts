import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ObserverKv } from "@gadgets/gatekeeper-kit/observers";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import {
  CONTEXT_OBSERVER_DENIED, contextObserverAccessVerifier, contextObserverStrategy,
} from "../src/context-observers.js";
import { domainName } from "../src/domain.js";
import { ContextVerifier } from "../src/library-gatekeeper.js";

function makeKv(): ObserverKv & { map: Map<string, unknown> } {
  let map = new Map<string, unknown>();
  return {
    map,
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, value),
    delete: (key: string) => map.delete(key),
    list: <T>({ prefix }: { prefix?: string } = {}) =>
      [...map.entries()].filter(([key]) => key.startsWith(prefix ?? "")) as Iterable<[string, T]>,
  } as ObserverKv & { map: Map<string, unknown> };
}

function verifier(allowed: string[]) {
  let calls: Array<{ sharingDomain: string; collectionIds: string[] }> = [];
  let user = {
    async hasCollectionsAccess(sharingDomain: string, collectionIds: string[]) {
      calls.push({ sharingDomain, collectionIds });
      return collectionIds.map(id => allowed.includes(id));
    },
  } as unknown as Fetcher<GatekeeperUserVerifier>;
  return { user, calls };
}

describe("contextObserverStrategy", () => {
  it("keeps enforcing collections recorded before reads reported them as subresources", async () => {
    for (let legacy of [true, "observed", "pending"]) {
      let kv = makeKv();
      kv.put("observedCollection:private", legacy);
      let strategy = contextObserverStrategy(kv, "workshop.example");

      await expect(strategy.addObserver("denied", verifier([]).user))
        .rejects.toThrow(CONTEXT_OBSERVER_DENIED);
      let allowed = verifier(["private"]);
      await strategy.addObserver("allowed", allowed.user);
      expect(allowed.calls).toEqual([
        { sharingDomain: "workshop.example", collectionIds: ["private"] },
      ]);
    }
  });

  it("refuses without disclosing which collection the collaborator cannot read", async () => {
    let kv = makeKv();
    let strategy = contextObserverStrategy(kv, "workshop.example");
    let check = await strategy.prepare!(["private-collection-id"]);
    check.commit();

    let denial = strategy.addObserver("denied", verifier([]).user);
    await expect(denial).rejects.toThrow(CONTEXT_OBSERVER_DENIED);
    await expect(denial).rejects.not.toThrow(/private-collection-id/);
  });
});

describe("contextObserverAccessVerifier", () => {
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

  async function createCollection(id: string, visibility: "private" | "public") {
    let now = new Date();
    await collection(id).initialize({
      id, title: id, description: "", visibility,
      created: now, lastUpdated: now, documentCount: 0, content: { source: "web" },
    }, domain, visibility === "private" ? "alice" : "");
  }

  // An observer as the Workshop hands it over: their account's own verifier. The test runner's
  // exports hold only the Durable Objects, so the verifier gets a context giving it theirs.
  const observer = (accountId: string, sharingDomain = domain) => ({
    id: accountId,
    verifier: new ContextVerifier({
      props: { sharingDomain, accountId },
      exports: { ContextCollectionDurableObject: collections },
    } as unknown as ConstructorParameters<typeof ContextVerifier>[0], env as Cloudflare.Env) as
      unknown as Fetcher<GatekeeperUserVerifier>,
  });

  const allowed = async (accountIds: string[], collectionIds: string[]) =>
    (await contextObserverAccessVerifier(domain)(
      accountIds.map(accountId => observer(accountId)), collectionIds)).allowedObserverIds;

  it("allows exactly the observers whose account can read every collection now", async () => {
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
    expect((await contextObserverAccessVerifier(domain)(
      [observer("alice", "elsewhere.example")], ["public"])).allowedObserverIds).toEqual([]);
  });

  it("denies an observer as soon as their access is revoked", async () => {
    await createCollection("shared", "private");
    await collection("shared").share("alice", [{ accountId: "bob", displayName: "bob" }], "viewer");
    expect(await allowed(["bob"], ["shared"])).toEqual(["bob"]);

    await collection("shared").removeMember("alice", "bob");

    expect(await allowed(["bob"], ["shared"])).toEqual([]);
  });
});
