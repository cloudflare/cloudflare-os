import { describe, expect, it } from "vitest";
import { ObservationGate, type ObserverKv } from "@gadgets/gatekeeper-kit/observers";
import type {
  GatekeeperUserVerifier, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { CONTEXT_OBSERVER_DENIED, contextObserverStrategy } from "../src/context-observers.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import { LibraryReadSession } from "../src/library-read.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";

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
function makeSession() {
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
      async getMetadata() {
        let id = name.split(":").at(-1);
        return { title: `${id} title`, description: `${id} description`, documentCount: 1 };
      },
      async listContextDocuments() { return [DOCUMENT]; },
      async getContextDocument() { return DOCUMENT; },
    }),
  } as unknown as DurableObjectNamespace<ContextCollectionDurableObject>;
  let userLibraries = {
    idFromName: (name: string) => name,
    get: () => ({
      async getEnabledCollections() {
        return new Map([["public", "public"], ["private", "private"]]);
      },
    }),
  } as unknown as DurableObjectNamespace<UserLibraryDurableObject>;
  let session = new LibraryReadSession(
    collections, userLibraries, DOMAIN, "owner",
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
      .toEqual(["public", "private"]);
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
});
