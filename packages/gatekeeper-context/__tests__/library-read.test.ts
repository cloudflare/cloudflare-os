import type { RpcStub } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  ObservationAuthorizer, TrackedObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import { LibraryReadSession } from "../src/library-read.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import { domainName } from "../src/domain.js";

const DOMAIN = "workshop.example";

const DOCUMENT = {
  path: "plan.md",
  name: "plan.md",
  description: "Launch plan",
  contentType: "text/markdown",
  body: "Ship it.",
};

// The owner's library: one public collection and one private collection.
function makeSession({ publicDiscoveryFails = false, publicAccessFails = false, refusal }: {
  publicDiscoveryFails?: boolean; publicAccessFails?: boolean; refusal?: Error;
} = {}) {
  let authorized: TrackedObservationDescription[] = [];
  // Only authorizeTrackedObservation() and disposal are reached by the read session.
  let authorizer = {
    async authorizeTrackedObservation(description: TrackedObservationDescription) {
      if (refusal) throw refusal;
      authorized.push(description);
    },
    [Symbol.dispose]() {},
  } as unknown as RpcStub<ObservationAuthorizer>;
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
  let session = new LibraryReadSession(env, collections, userLibraries, DOMAIN, "owner", authorizer);
  return { session, authorized };
}

describe("LibraryReadSession observations", () => {
  it("lists every collection without depending on any of them", async () => {
    let { session, authorized } = makeSession();

    let listing = await session.list();

    expect(listing.entries.map(entry => entry.type === "collection" && entry.id))
      .toEqual(["private", "public"]);
    expect(authorized.map(description => description.subresources)).toEqual([[]]);
  });

  it("depends on a private collection once its contents are listed or read", async () => {
    for (let reveal of [
      (session: LibraryReadSession) => session.list({ collectionId: "private" }),
      (session: LibraryReadSession) => session.read("private/plan.md"),
    ]) {
      let { session, authorized } = makeSession();

      await reveal(session);

      expect(authorized.map(description => description.subresources)).toEqual([["private"]]);
    }
  });

  it("depends only on the collections a search returned results from", async () => {
    let { session, authorized } = makeSession();

    expect((await session.search("plan", { limit: 1 })).map(result => result.docId))
      .toEqual(["private/plan.md"]);
    expect(await session.search("plan")).toHaveLength(2);

    expect(authorized.map(description => description.subresources))
      .toEqual([["private"], ["private", "public"]]);
  });

  it("returns nothing a refused observation covered", async () => {
    let refusal = new Error("This workspace may not read that.");
    let { session } = makeSession({ refusal });

    await expect(session.read("private/plan.md")).rejects.toBe(refusal);
    await expect(session.list({ collectionId: "private" })).rejects.toBe(refusal);
    await expect(session.search("plan")).rejects.toBe(refusal);
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
