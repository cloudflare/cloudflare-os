import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
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
  await library(owner).createOwnedCollection(id);
  return id;
}

async function libraryIds(accountId: string): Promise<string[]> {
  return (await library(accountId).listLibrary(domain, accountId)).map(entry => entry.id);
}

/** Every collection ID in an account's library index, whether or not the account still has access. */
async function indexedIds(accountId: string): Promise<string[]> {
  return runInDurableObject(library(accountId), (_instance, state) =>
    ["ownedCollections:", "sharedCollections:"]
      .flatMap(prefix => [...state.storage.kv.list({ prefix })].map(([key]) => key.slice(prefix.length)))
      .toSorted());
}

async function permissions(id: string, accountId: string) {
  return collectionPermissions(await collection(id).getAccess(accountId), false);
}

/**
 * A management API for `accountId` whose user picker resolves tickets to `accounts`. An
 * `unreachable` account's verifier fails as an outage would.
 */
function api(
    accountId: string, accounts: { domain: string; accountId: string; unreachable?: true }[]) {
  let exchange = {
    async redeem() {
      return accounts.map(account => ({
        verifier: {
          async getAccountId(sharingDomain: string) {
            if (account.unreachable) throw new Error("Verifier unavailable.");
            return sharingDomain === account.domain ? account.accountId : null;
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

/** An Artifacts binding whose token mints can be held, and whose revocations can be made to fail. */
function fakeArtifacts() {
  let minted = 0;
  let mintGate = Promise.resolve();
  let fake = {
    revoked: [] as string[],
    activeTokens: new Set<string>(),
    failDeletion: false,
    failRevocations: false,
    /** Hold token mints until the returned function is called. */
    holdMints() {
      let { promise, resolve } = Promise.withResolvers<void>();
      mintGate = promise;
      return () => resolve();
    },
    binding: undefined as unknown as Artifacts,
  };
  let repo = {
    async createToken() {
      await mintGate;
      let token = { id: `token-${minted++}`, plaintext: "secret" };
      fake.activeTokens.add(token.id);
      return token;
    },
    async revokeToken(tokenId: string) {
      if (fake.failRevocations) throw new Error("Artifacts is unavailable.");
      fake.revoked.push(tokenId);
      fake.activeTokens.delete(tokenId);
      return true;
    },
    async listTokens() {
      if (fake.failRevocations) throw new Error("Artifacts is unavailable.");
      return {
        tokens: [...fake.activeTokens].map(id => ({
          id, scope: "write", state: "active", expiresAt: new Date().toISOString(),
        })),
      };
    },
  };
  fake.binding = {
    async create(name: string) {
      return { remote: `https://artifacts.example/${name}.git`, token: "initial" };
    },
    async get() { return repo; },
    async delete() {
      if (fake.failDeletion) throw new Error("Artifacts is unavailable.");
      fake.activeTokens.clear();
    },
  } as unknown as Artifacts;
  return fake;
}

/** A private git collection owned by alice and edited by bob, backed by `artifacts`. */
async function createGitCollection(artifacts: Artifacts) {
  let id = `collection-${nextId++}`;
  let stub = collection(id);
  await runInDurableObject(stub, (instance: ContextCollectionDurableObject) => {
    let object = instance as unknown as { env: Cloudflare.Env };
    object.env = { ...object.env, ARTIFACTS: artifacts };
  });
  let now = new Date();
  await stub.initialize({
    id, title: "Mirror", description: "", visibility: "private",
    created: now, lastUpdated: now, documentCount: 0,
    content: { source: "git", remote: "", branch: "main", lastRefreshedAt: now },
  }, domain, "alice");
  await library("alice").createOwnedCollection(id);
  await stub.share("alice", [{ accountId: "bob", displayName: "bob" }], "editor");
  return stub;
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
    await expect(settled(collection(id).share("bob", [{ accountId: "carol", displayName: "carol" }], "viewer")))
      .rejects.toThrow("Only editors and owners");
  });

  it("lets a viewer leave, after which it is gone from their library", async () => {
    let id = await createCollection("alice");
    await collection(id).share("alice", [{ accountId: "bob", displayName: "bob" }], "viewer");
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
    await collection(id).share("alice", [{ accountId: "bob", displayName: "bob" }], "editor");

    await collection(id).share("bob", [{ accountId: "carol", displayName: "carol" }], "editor");
    expect(await permissions(id, "carol")).toMatchObject({ canEdit: true, canDelete: false });
    await expect(settled(collection(id).share("bob", [{ accountId: "dave", displayName: "dave" }], "owner")))
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

    await collection(id).share("alice", [{ accountId: "bob", displayName: "bob" }], "owner");
    await collection(id).removeMember("alice", "alice");

    expect(await libraryIds("alice")).toEqual([]);
    expect(canReadCollection(await collection(id).getAccess("alice"))).toBe(false);
    expect(await permissions(id, "bob")).toMatchObject({ canManageOwners: true, canDelete: true });
    // Owners are peers: the new owner may remove another owner, but never the last one.
    await collection(id).share("bob", [{ accountId: "carol", displayName: "carol" }], "owner");
    await collection(id).removeMember("carol", "bob");
    expect((await collection(id).getSharing("carol")).members.map(member => member.memberId))
      .toEqual(["carol"]);
  });

  it("revokes access despite a stale library entry", async () => {
    let id = await createCollection("alice");
    await collection(id).share("alice", [{ accountId: "bob", displayName: "bob" }], "viewer");
    await collection(id).removeMember("alice", "bob");
    // A library write that failed or raced leaves an entry behind; listings must ignore it.
    await library("bob").addSharedCollection(id);

    expect(await libraryIds("bob")).toEqual([]);
    expect(await library("bob").hasPrivateLibraryCollection(domain, "bob", id)).toBe(false);
    expect(canReadCollection(await collection(id).getAccess("bob"))).toBe(false);
  });

  it("makes everyone-viewable a read permission only, independent of grants", async () => {
    let id = await createCollection("alice");
    await collection(id).share("alice", [{ accountId: "bob", displayName: "bob" }], "viewer");
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
    await collection(id).share("alice", [{ accountId: "bob", displayName: "bob" }], "editor");
    await collection(id).removeAccount("alice");

    let access = await collection(id).getAccess("bob");
    expect(access).toMatchObject({ exists: true, hasOwner: false, role: "editor" });
    expect(await permissions(id, "bob")).toEqual({
      canEdit: true, canShare: true, canManageOwners: false, canDelete: false,
    });
    await expect(settled(collection(id).share("bob", [{ accountId: "bob", displayName: "bob" }], "owner")))
      .rejects.toThrow("Only owners can change who owns this collection.");
    await expect(api("bob", []).deleteContextCollection(id)).rejects.toThrow();
    expect(await libraryIds("bob")).toEqual([id]);

    // Once its last member leaves, nobody can reach it, so it is gone.
    await collection(id).removeMember("bob", "bob");
    expect((await collection(id).getAccess("bob")).exists).toBe(false);
  });

  it("leaves a collection unchanged when one of several owners disconnects", async () => {
    let id = await createCollection("alice");
    await collection(id).share("alice", [{ accountId: "bob", displayName: "bob" }], "owner");
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

  it("keeps a member's grant and library entry in step when re-sharing races removal", async () => {
    let id = await createCollection("alice");
    await collection(id).share("alice", [{ accountId: "bob", displayName: "bob" }], "viewer");
    await runInDurableObject(collection(id), (instance: ContextCollectionDurableObject) =>
      Promise.all([
        instance.share("alice", [{ accountId: "bob", displayName: "bob" }], "editor"),
        instance.removeMember("alice", "bob"),
      ]));

    expect((await collection(id).getAccess("bob")).role).toBeNull();
    expect(await indexedIds("bob")).toEqual([]);
  });

  it("deletes an everyone-viewable collection once its last member is gone", async () => {
    let disconnected = await createCollection("alice");
    await collection(disconnected).setEveryoneCanView("alice", true);
    await collection(disconnected).removeAccount("alice");
    expect((await collection(disconnected).getAccess("stranger")).exists).toBe(false);

    let left = await createCollection("alice");
    await collection(left).share("alice", [{ accountId: "bob", displayName: "bob" }], "editor");
    await collection(left).setEveryoneCanView("bob", true);
    await collection(left).removeAccount("alice");
    await collection(left).removeMember("bob", "bob");
    expect((await collection(left).getAccess("stranger")).exists).toBe(false);
  });

  it("forgets entries of deleted collections, and lists the rest when one can't be reached", async () => {
    let gone = await createCollection("alice");
    let kept = await createCollection("alice");
    let unreachable = await createCollection("alice");
    await collection(gone).deleteSelf();
    // As a share racing the deletion would leave it.
    await library("alice").addSharedCollection(gone);
    await runInDurableObject(collection(unreachable), (instance: ContextCollectionDurableObject) => {
      instance.getLibraryEntry = () => { throw new Error("Collection unavailable."); };
    });

    expect(await libraryIds("alice")).toEqual([kept]);
    expect(await indexedIds("alice")).toEqual([kept, unreachable].toSorted());
  });

  it("refuses a share that lands while the recipient is disconnecting", async () => {
    let id = await createCollection("alice");
    let bob = [{ accountId: "bob", displayName: "bob" }];
    expect(await library("bob").beginDisconnect()).toEqual([]);
    await expect(settled(collection(id).share("alice", bob, "viewer"))).rejects.toThrow("disconnected");
    await library("bob").finishDisconnect();
    await expect(settled(collection(id).share("alice", bob, "viewer"))).rejects.toThrow("disconnected");

    expect((await collection(id).getAccess("bob")).role).toBeNull();
    expect(await indexedIds("bob")).toEqual([]);
  });

  it("shares with all of a person's accounts or none", async () => {
    let id = await createCollection("alice");
    await library("carol").beginDisconnect();
    await expect(api("alice", [{ domain, accountId: "bob" }, { domain, accountId: "carol" }])
      .shareContextCollection(id, "ticket", "viewer")).rejects.toThrow("disconnected");
    expect((await collection(id).getAccess("bob")).role).toBeNull();

    // A verifier that can't be asked is an error to retry, not a person without Skills.
    await expect(api("alice", [{ domain, accountId: "bob", unreachable: true }])
      .shareContextCollection(id, "ticket", "viewer")).rejects.toThrow("Verifier unavailable.");
  });
});

describe("git tokens of members who lose write access", () => {
  it.each(["leave", "disconnect", "delete"] as const)(
    "retains cleanup state through an Artifacts outage during %s", async (operation) => {
      let artifacts = fakeArtifacts();
      let stub = await createGitCollection(artifacts.binding);
      let token = await stub.createGitToken("bob");
      if (operation !== "delete") await stub.removeAccount("alice");

      artifacts.failRevocations = true;
      artifacts.failDeletion = true;
      let deletion = operation === "leave" ? stub.removeMember("bob", "bob")
        : operation === "disconnect" ? stub.removeAccount("bob") : stub.deleteSelf();
      await expect(settled(deletion)).rejects.toThrow("Artifacts is unavailable.");
      expect(artifacts.activeTokens.has(token.id)).toBe(true);
      expect(canReadCollection(await stub.getAccess("bob"))).toBe(false);
      await runInDurableObject(stub, async (_instance, state) => {
        expect(await state.storage.getAlarm()).not.toBeNull();
      });

      await expect(runDurableObjectAlarm(stub)).rejects.toThrow("Artifacts is unavailable.");
      artifacts.failRevocations = false;
      artifacts.failDeletion = false;
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(artifacts.activeTokens.has(token.id)).toBe(false);
      await runInDurableObject(stub, async (_instance, state) => {
        expect((await state.storage.list()).size).toBe(0);
        expect(await state.storage.getAlarm()).toBeNull();
      });
    });

  it("revokes a token minted while its issuer was being removed", async () => {
    let artifacts = fakeArtifacts();
    let stub = await createGitCollection(artifacts.binding);
    await runInDurableObject(stub, async (instance: ContextCollectionDurableObject) => {
      let releaseMint = artifacts.holdMints();
      let mint = instance.createGitToken("bob");
      let removal = instance.removeMember("alice", "bob");
      // Give the removal every chance to finish while the mint is held.
      await Promise.race([removal, scheduler.wait(100)]);
      releaseMint();
      let token = await mint;
      await removal;
      expect(artifacts.revoked).toContain(token.id);
    });

    await expect(settled(stub.createGitToken("bob"))).rejects.toThrow("Only editors and owners");
  });

  it("reports a failed revocation on removal and retries it from an alarm", async () => {
    let artifacts = fakeArtifacts();
    let stub = await createGitCollection(artifacts.binding);
    let token = await stub.createGitToken("bob");

    artifacts.failRevocations = true;
    await expect(settled(stub.removeMember("alice", "bob"))).rejects.toThrow("could not be revoked yet");
    expect((await stub.getAccess("bob")).role).toBeNull();
    // Repeating it retries, though the grant is already gone.
    await expect(settled(stub.removeMember("alice", "bob"))).rejects.toThrow("could not be revoked yet");
    expect(artifacts.revoked).not.toContain(token.id);

    artifacts.failRevocations = false;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(artifacts.revoked).toContain(token.id);
    await stub.removeMember("alice", "bob");
  });

  it("retries a failed revocation when a demotion is repeated", async () => {
    let artifacts = fakeArtifacts();
    let stub = await createGitCollection(artifacts.binding);
    let token = await stub.createGitToken("bob");

    artifacts.failRevocations = true;
    await expect(settled(stub.setMemberRole("alice", "bob", "viewer")))
      .rejects.toThrow("could not be revoked yet");
    expect((await stub.getAccess("bob")).role).toBe("viewer");

    artifacts.failRevocations = false;
    await stub.setMemberRole("alice", "bob", "viewer");
    expect(artifacts.revoked).toContain(token.id);
  });

  it("revokes the creator's tokens from before sharing once the creator loses write access", async () => {
    let artifacts = fakeArtifacts();
    let stub = await createGitCollection(artifacts.binding);
    // Minted before sharing existed, so it has no issuer record.
    artifacts.activeTokens.add("legacy-token");
    let bobToken = await stub.createGitToken("bob");

    await stub.setMemberRole("alice", "bob", "owner");
    expect(artifacts.activeTokens.has("legacy-token")).toBe(true);

    await stub.setMemberRole("bob", "alice", "viewer");
    expect(artifacts.revoked).toContain("legacy-token");
    expect(artifacts.activeTokens.has(bobToken.id)).toBe(true);
  });

  it("finishes a pending mint before deleting, and mints nothing afterwards", async () => {
    let artifacts = fakeArtifacts();
    let stub = await createGitCollection(artifacts.binding);
    await runInDurableObject(stub, async (instance: ContextCollectionDurableObject, state) => {
      let releaseMint = artifacts.holdMints();
      let mint = instance.createGitToken("bob");
      let deletion = instance.deleteSelf();
      await Promise.race([deletion, scheduler.wait(100)]);
      releaseMint();
      let token = await mint;
      await deletion;
      expect(artifacts.activeTokens.has(token.id)).toBe(false);
      expect((await state.storage.list()).size).toBe(0);
    });

    await expect(settled(stub.createGitToken("bob"))).rejects.toThrow("Collection not found");
  });
});
