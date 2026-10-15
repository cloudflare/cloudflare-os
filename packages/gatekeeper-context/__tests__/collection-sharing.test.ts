import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { GatekeeperUserSelectionExchange } from "@gadgets/workshop-shared/gatekeeper";
import { ContextApiImpl } from "../src/context-api.js";
import { canReadCollection, collectionPermissions } from "../src/collection-access.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import type { LibraryRegistryDurableObject } from "../src/registry-do.js";
import { domainName } from "../src/domain.js";

// Storage persists across the file's tests, so each gets its own sharing domain.
let domain = "";
let domains = 0;
beforeEach(() => {
  domain = `workshop-${domains++}.example`;
});

// A rejected Durable Object RPC promise is a proxy that assertions would probe into further,
// unhandled, calls; settle it into a plain promise first.
function settled(rpc: PromiseLike<unknown>): Promise<unknown> {
  let { promise, resolve, reject } = Promise.withResolvers<unknown>();
  rpc.then(resolve, reject);
  return promise;
}

type TestEnv = {
  COLLECTIONS: DurableObjectNamespace<ContextCollectionDurableObject>;
  USER_LIBRARIES: DurableObjectNamespace<UserLibraryDurableObject>;
  REGISTRIES: DurableObjectNamespace<LibraryRegistryDurableObject>;
};
const testEnv = env as unknown as TestEnv & Cloudflare.Env;

const collection = (id: string) =>
  testEnv.COLLECTIONS.get(testEnv.COLLECTIONS.idFromName(domainName(domain, id)));
const library = (accountId: string) =>
  testEnv.USER_LIBRARIES.get(testEnv.USER_LIBRARIES.idFromName(domainName(domain, accountId)));

let nextId = 0;

/** A private web collection created by `owner`, as the management API creates one. */
async function createCollection(owner: string): Promise<string> {
  let id = `collection-${nextId++}`;
  let now = new Date();
  await collection(id).initialize({
    id, title: "Runbooks", description: "", visibility: "private",
    created: now, lastUpdated: now, documentCount: 0, content: { source: "web" },
  }, domain, owner);
  await library(owner).createOwnedCollection(id, "Runbooks", "");
  return id;
}

async function libraryIds(accountId: string): Promise<string[]> {
  return (await library(accountId).listLibrary(domain, accountId)).map(entry => entry.id);
}

async function permissions(id: string, accountId: string) {
  return collectionPermissions(await collection(id).getAccess(accountId), false);
}

/** A management API for `accountId` whose user picker resolves tickets to `accounts`. */
function api(accountId: string, accounts: { domain: string; accountId: string }[]) {
  let exchange = {
    async redeem() {
      return accounts.map(account => ({
        verifier: {
          async getAccountId(sharingDomain: string) {
            if (sharingDomain !== account.domain) throw new Error("other domain");
            return account.accountId;
          },
        },
        profile: { displayName: account.accountId },
      }));
    },
  } as unknown as Fetcher<GatekeeperUserSelectionExchange>;
  return new ContextApiImpl(
    testEnv, domain, accountId, false,
    testEnv.COLLECTIONS, testEnv.USER_LIBRARIES, testEnv.REGISTRIES, exchange);
}

describe("collection sharing", () => {
  it("lets a viewer read everything but change nothing", async () => {
    let id = await createCollection("alice");
    await api("alice", [{ domain, accountId: "bob" }])
      .shareContextCollection(id, "ticket", "viewer");

    expect(await libraryIds("bob")).toEqual([id]);
    expect((await library("bob").listLibrary(domain, "bob"))[0]?.membership)
      .toEqual({ role: "viewer", shared: true });
    expect(canReadCollection(await collection(id).getAccess("bob"))).toBe(true);
    expect(await permissions(id, "bob")).toEqual({
      canEdit: false, canShare: false, canManageOwners: false, canDelete: false,
    });
    await expect(api("bob", []).putContextDocument(id, "a.md", { description: "", body: "x" }))
      .rejects.toThrow("Collection not found or you don't have access.");
    await expect(settled(collection(id).share("bob", "carol", "viewer", "carol")))
      .rejects.toThrow("Only editors and owners");
  });

  it("lets a viewer leave, after which it is gone from their library", async () => {
    let id = await createCollection("alice");
    await collection(id).share("alice", "bob", "viewer", "bob");
    await api("bob", []).leaveContextCollection(id);

    expect(await libraryIds("bob")).toEqual([]);
    expect(canReadCollection(await collection(id).getAccess("bob"))).toBe(false);
    expect((await collection(id).getSharing("alice")).members.map(member => member.memberId))
      .toEqual(["alice"]);
  });

  it("refuses a recipient with no Context account in this sharing domain", async () => {
    let id = await createCollection("alice");
    await expect(api("alice", [{ domain: "elsewhere", accountId: "bob" }])
      .shareContextCollection(id, "ticket", "viewer"))
      .rejects.toThrow("hasn't turned on Skills yet");
    await expect(api("alice", []).shareContextCollection(id, "ticket", "viewer"))
      .rejects.toThrow("hasn't turned on Skills yet");
    expect(await libraryIds("bob")).toEqual([]);
  });

  it("lets editors share as viewer or editor but not touch ownership", async () => {
    let id = await createCollection("alice");
    await collection(id).share("alice", "bob", "editor", "bob");

    await collection(id).share("bob", "carol", "editor", "carol");
    expect(await permissions(id, "carol")).toMatchObject({ canEdit: true, canDelete: false });
    await expect(settled(collection(id).share("bob", "dave", "owner", "dave")))
      .rejects.toThrow("Only owners can change who owns this collection.");
    await expect(settled(collection(id).setMemberRole("bob", "alice", "editor")))
      .rejects.toThrow("Only owners can change who owns this collection.");
    await expect(settled(collection(id).removeMember("bob", "alice")))
      .rejects.toThrow("Only owners can change who owns this collection.");
  });

  it("keeps an owner, and transfers ownership by granting then leaving", async () => {
    let id = await createCollection("alice");
    await expect(settled(collection(id).removeMember("alice", "alice")))
      .rejects.toThrow("A collection needs an owner.");
    await expect(settled(collection(id).setMemberRole("alice", "alice", "editor")))
      .rejects.toThrow("A collection needs an owner.");

    await collection(id).share("alice", "bob", "owner", "bob");
    await collection(id).removeMember("alice", "alice");

    expect(await libraryIds("alice")).toEqual([]);
    expect(canReadCollection(await collection(id).getAccess("alice"))).toBe(false);
    expect(await permissions(id, "bob")).toMatchObject({ canManageOwners: true, canDelete: true });
    // Owners are peers: the new owner may remove another owner, but never the last one.
    await collection(id).share("bob", "carol", "owner", "carol");
    await collection(id).removeMember("carol", "bob");
    expect((await collection(id).getSharing("carol")).members.map(member => member.memberId))
      .toEqual(["carol"]);
  });

  it("revokes access despite a stale library entry", async () => {
    let id = await createCollection("alice");
    await collection(id).share("alice", "bob", "viewer", "bob");
    await collection(id).removeMember("alice", "bob");
    // A library write that failed or raced leaves an entry behind; listings must ignore it.
    await library("bob").addSharedCollection(id);

    expect(await libraryIds("bob")).toEqual([]);
    expect(await library("bob").hasLibraryCollection(domain, "bob", id)).toBe(false);
    expect(canReadCollection(await collection(id).getAccess("bob"))).toBe(false);
  });

  it("makes everyone-viewable a read permission only, independent of grants", async () => {
    let id = await createCollection("alice");
    await collection(id).share("alice", "bob", "viewer", "bob");
    await collection(id).setEveryoneCanView("alice", true);

    expect(canReadCollection(await collection(id).getAccess("stranger"))).toBe(true);
    expect(await permissions(id, "stranger")).toMatchObject({ canEdit: false });
    expect(await libraryIds("stranger")).toEqual([]);
    await expect(settled(collection(id).getSharing("stranger"))).rejects.toThrow();

    await collection(id).setEveryoneCanView("alice", false);
    expect(canReadCollection(await collection(id).getAccess("stranger"))).toBe(false);
    expect(canReadCollection(await collection(id).getAccess("bob"))).toBe(true);
  });

  it("deletes a disconnected owner's unshared collection", async () => {
    let id = await createCollection("alice");
    await collection(id).removeAccount("alice");

    expect((await collection(id).getAccess("alice")).exists).toBe(false);
  });

  it("keeps a disconnected last owner's shared collection for its members", async () => {
    let id = await createCollection("alice");
    await collection(id).share("alice", "bob", "editor", "bob");
    await collection(id).removeAccount("alice");

    let access = await collection(id).getAccess("bob");
    expect(access).toMatchObject({ exists: true, hasOwner: false, role: "editor" });
    expect(await permissions(id, "bob")).toMatchObject({ canManageOwners: true, canDelete: true });
    expect(await libraryIds("bob")).toEqual([id]);

    // Once its last member leaves, nobody can reach it, so it is gone.
    await collection(id).removeMember("bob", "bob");
    expect((await collection(id).getAccess("bob")).exists).toBe(false);
  });

  it("leaves a collection unchanged when one of several owners disconnects", async () => {
    let id = await createCollection("alice");
    await collection(id).share("alice", "bob", "owner", "bob");
    await collection(id).removeAccount("alice");

    expect(await collection(id).getAccess("bob")).toMatchObject({ hasOwner: true, role: "owner" });
  });

  it("makes the creator of a collection from before sharing its owner", async () => {
    let id = await createCollection("alice");
    await runInDurableObject(collection(id), (_instance, state) => {
      for (let [key] of state.storage.kv.list({ prefix: "grants:" })) state.storage.kv.delete(key);
      state.storage.kv.delete("aclVersion");
    });

    expect(await collection(id).getAccess("alice")).toMatchObject({ role: "owner", hasOwner: true });
  });
});
