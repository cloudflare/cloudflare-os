import { describe, expect, it } from "vitest";
import { ObservationGate, type ObserverKv } from "@gadgets/gatekeeper-kit/observers";
import type {
  GatekeeperUserVerifier, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { CONTEXT_OBSERVER_DENIED, contextObserverStrategy } from "../src/context-observers.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import { LibraryReadSession } from "../src/library-read.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import { domainName } from "../src/domain.js";

const DOMAIN = "workshop.example";

function makeKv(): ObserverKv {
  let map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, value),
    delete: (key: string) => void map.delete(key),
    list: <T>({ prefix }: { prefix: string }) =>
      [...map.entries()].filter(([key]) => key.startsWith(prefix)) as [string, T][],
  };
}

function verifier(allowed: string[]): Fetcher<GatekeeperUserVerifier> {
  return {
    async hasCollectionsAccess(_sharingDomain: string, collectionIds: string[]) {
      return collectionIds.map(id => allowed.includes(id));
    },
  } as unknown as Fetcher<GatekeeperUserVerifier>;
}

const DOCUMENT = {
  path: "plan.md",
  name: "plan.md",
  description: "Launch plan",
  contentType: "text/markdown",
  body: "Ship it.",
};

// The owner's library: one public collection and one private collection.
function makeSession({ publicDiscoveryFails = false, publicAccessFails = false } = {}) {
  let kv = makeKv();
  let strategy = contextObserverStrategy(kv, DOMAIN);
  let authorized: ObservationDescription[] = [];
  let authorizer = {
    async authorizeObservation(description: ObservationDescription) {
      authorized.push(description);
    },
    [Symbol.dispose]() {},
  };
  let collections = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      async getAccess() {
        if (publicAccessFails && name === domainName(DOMAIN, "unavailable")) {
          throw new Error("Public collection is unavailable.");
        }
        return { exists: true, visibility: "public" };
      },
      async getMetadata() {
        let id = name.split(":").at(-1);
        return { title: `${id} title`, description: `${id} description`, documentCount: 1 };
      },
      async listContextDocuments() { return [DOCUMENT]; },
      async getContextDocument() { return DOCUMENT; },
      async search() {
        return [{ path: DOCUMENT.path, name: DOCUMENT.name, description: DOCUMENT.description, score: 1 }];
      },
    }),
  } as unknown as DurableObjectNamespace<ContextCollectionDurableObject>;
  let userLibraries = {
    idFromName: (name: string) => name,
    get: () => ({
      async listPrivateLibrary() {
        return [{ id: "private" }];
      },
      async hasPrivateLibraryCollection(_domain: string, _accountId: string, id: string) {
        return id === "private";
      },
    }),
  } as unknown as DurableObjectNamespace<UserLibraryDurableObject>;
  let env = {
    CONTEXT_COLLECTIONS: {
      async get() {
        if (publicDiscoveryFails) throw new Error("Public discovery is unavailable.");
        let ids = publicAccessFails ? ["public", "unavailable"] : ["public"];
        return JSON.stringify(ids.map(id => ({ id, lastUpdated: new Date() })));
      },
    },
  } as unknown as Pick<Cloudflare.Env, "CONTEXT_COLLECTIONS">;
  let session = new LibraryReadSession(
    env, collections, userLibraries, DOMAIN, "owner",
    new ObservationGate(
      authorizer as unknown as ConstructorParameters<typeof ObservationGate>[0], strategy));
  return { session, strategy, authorized };
}

describe("LibraryReadSession sharing", () => {
  it("lists every collection without restricting who may open the workspace", async () => {
    let { session, strategy, authorized } = makeSession();
    await strategy.addObserver("existing", verifier(["public"]));

    let listing = await session.list();

    expect(listing.entries.map(entry => entry.type === "collection" && entry.id))
      .toEqual(["private", "public"]);
    expect(authorized).toHaveLength(1);
    expect(authorized[0].excludeObservers).toBeUndefined();
    await strategy.addObserver("later", verifier(["public"]));
  });

  it("restricts sharing once a private collection's contents are listed or read", async () => {
    for (let reveal of [
      (session: LibraryReadSession) => session.list({ collectionId: "private" }),
      (session: LibraryReadSession) => session.read("private/plan.md"),
    ]) {
      let { session, strategy, authorized } = makeSession();
      await strategy.addObserver("existing", verifier(["public"]));

      await reveal(session);

      expect(authorized[0].excludeObservers).toEqual(["existing"]);
      await expect(strategy.addObserver("later", verifier(["public"])))
        .rejects.toThrow(CONTEXT_OBSERVER_DENIED);
      await strategy.addObserver("owner-account", verifier(["public", "private"]));
    }
  });

  it("keeps healthy private and public results when another public collection is unavailable", async () => {
    using session = makeSession({ publicAccessFails: true }).session;

    expect((await session.list()).entries.map(entry => entry.type === "collection" && entry.id))
      .toEqual(["private", "public"]);
    expect((await session.search("plan")).map(result => result.docId))
      .toEqual(["private/plan.md", "public/plan.md"]);
  });

  it("reads, lists and searches a private collection while public discovery is unavailable", async () => {
    let { session } = makeSession({ publicDiscoveryFails: true });

    expect(await session.read("private/plan.md")).toMatchObject({
      docId: "private/plan.md", content: "Ship it.",
    });
    expect((await session.list({ collectionId: "private" })).entries)
      .toMatchObject([{ path: "plan.md", type: "document" }]);
    expect(await session.search("plan", { collectionId: "private" }))
      .toMatchObject([{ docId: "private/plan.md", collectionId: "private" }]);
  });
});
