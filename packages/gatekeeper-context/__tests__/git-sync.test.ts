import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ContextCollectionDurableObject } from "../src/context-collection.js";
import type { ContextCollectionMetadata } from "../src/context-types.js";
import { domainName } from "../src/domain.js";
import { FakeGitRepo } from "./fake-git-repo.js";

const DOMAIN = "workshop.example";

type TestEnv = { COLLECTIONS: DurableObjectNamespace<ContextCollectionDurableObject> };
const testEnv = env as unknown as TestEnv & Cloudflare.Env;

// The storage fields these tests read or age; the object keeps them private.
type SyncStorage = {
  gitSyncAttempts: { get(): number };
  gitSyncStartedAt: { put(at: Date): void };
  metadata: { get(): ContextCollectionMetadata; put(meta: ContextCollectionMetadata): void };
  documents: {
    list(): Iterable<{ path: string; gitBlobHash?: string }>;
    put(record: object): void;
  };
};
const storageOf = (instance: ContextCollectionDurableObject) =>
  (instance as unknown as { storage: SyncStorage }).storage;

// A rejected Durable Object RPC promise is a proxy that assertions would probe into further,
// unhandled, calls; settle it into a plain promise first.
function settled(rpc: PromiseLike<unknown>): Promise<unknown> {
  let { promise, resolve, reject } = Promise.withResolvers<unknown>();
  rpc.then(resolve, reject);
  return promise;
}

let nextId = 0;

async function createGitCollection(fake: FakeGitRepo) {
  let id = `git-sync-${nextId++}`;
  let stub = testEnv.COLLECTIONS.get(testEnv.COLLECTIONS.idFromName(domainName(DOMAIN, id)));
  await runInDurableObject(stub, (instance: ContextCollectionDurableObject) => {
    let object = instance as unknown as { env: Cloudflare.Env };
    object.env = { ...object.env, ARTIFACTS: fake.binding() };
  });
  let now = new Date();
  await stub.initialize({
    id, title: "Mirror", description: "", visibility: "private",
    created: now, lastUpdated: now, documentCount: 0,
    content: { source: "git", remote: "", branch: "main", lastRefreshedAt: now },
  }, DOMAIN, "owner");
  return stub;
}

// Makes the last successful sync old enough that the next read starts a background sync.
function makeStale(instance: ContextCollectionDurableObject): void {
  let storage = storageOf(instance);
  let meta = storage.metadata.get();
  if (meta.content.source !== "git") throw new Error("Expected a git collection.");
  storage.metadata.put({ ...meta, content: { ...meta.content, lastRefreshedAt: new Date(0) } });
}

// Moves the latest sync attempt's start `ms` into the past.
function attemptStartedAgo(instance: ContextCollectionDurableObject, ms: number): void {
  storageOf(instance).gitSyncStartedAt.put(new Date(Date.now() - ms));
}

// Lets a background sync against the in-memory fake, which does no I/O, run to completion.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const skill = "---\nname: deploys\ndescription: How to deploy.\n---\n# Deploys\n";

describe("git-backed collection sync", () => {
  it("rewrites only the files a push changed", async () => {
    let fake = new FakeGitRepo();
    let stub = await createGitCollection(fake);
    await fake.push("main", { "a.md": "# A", "docs/b.md": "# B", "skills/deploys/SKILL.md": skill });
    await stub.syncArtifactSource();
    let before = await stub.listContextDocuments();

    await fake.push("main", { "a.md": "# A", "c.md": "# C", "skills/deploys/SKILL.md": skill });
    fake.blobReads = [];
    await stub.syncArtifactSource();

    expect(fake.blobReads).toEqual([await fake.hashOf("# C")]);
    let after = await stub.listContextDocuments();
    expect(after.map(doc => doc.path)).toEqual(["a.md", "c.md", "skills/deploys/SKILL.md"]);
    expect(after.find(doc => doc.path === "a.md")?.lastUpdated)
      .toEqual(before.find(doc => doc.path === "a.md")?.lastUpdated);
    expect((await stub.getMetadata()).documentCount).toBe(3);
    expect((await stub.listAgentSkills()).map(entry => entry.skillName)).toEqual(["deploys"]);
  });

  it("works out hashes for documents stored before they were kept", async () => {
    let fake = new FakeGitRepo();
    let stub = await createGitCollection(fake);
    await fake.push("main", { "a.md": "# A", "b.md": "# B" });
    await stub.syncArtifactSource();
    await runInDurableObject(stub, (instance: ContextCollectionDurableObject) => {
      let { documents } = storageOf(instance);
      // Read the records before writing to the same storage collection.
      for (let record of Array.from(documents.list())) {
        // The oldest records hold text as a string, which can't be hashed.
        let body = record.path === "a.md" ? "# A" : (record as { body: Uint8Array }).body;
        documents.put({ ...record, body, gitBlobHash: undefined });
      }
    });

    await fake.push("main", { "a.md": "# A", "b.md": "# B", "c.md": "# C" });
    fake.blobReads = [];
    await stub.syncArtifactSource();

    expect(fake.blobReads.toSorted())
      .toEqual([await fake.hashOf("# A"), await fake.hashOf("# C")].toSorted());
    await runInDurableObject(stub, (instance: ContextCollectionDurableObject) => {
      expect([...storageOf(instance).documents.list()].every(record => record.gitBlobHash)).toBe(true);
    });
  });

  it("backs off after failed syncs, doubling the wait, until one succeeds", async () => {
    let fake = new FakeGitRepo();
    let stub = await createGitCollection(fake);
    await fake.push("main", { "a.md": "# A" });
    fake.failNextLog = new Error("Artifacts is unavailable.");
    await expect(settled(stub.syncArtifactSource())).rejects.toThrow("Artifacts is unavailable.");

    await runInDurableObject(stub, async (instance: ContextCollectionDurableObject) => {
      let attempts = () => storageOf(instance).gitSyncAttempts.get();
      expect(attempts()).toBe(1);
      makeStale(instance);

      // One failure: reads wait a minute before trying again.
      attemptStartedAgo(instance, 30_000);
      await instance.listContextDocuments();
      expect(fake.logRefs).toHaveLength(1);
      attemptStartedAgo(instance, 61_000);
      fake.failNextLog = new Error("Artifacts is unavailable.");
      await instance.listContextDocuments();
      await settle();
      expect(fake.logRefs).toHaveLength(2);
      expect(attempts()).toBe(2);

      // Two failures: two minutes.
      attemptStartedAgo(instance, 90_000);
      await instance.listContextDocuments();
      expect(fake.logRefs).toHaveLength(2);
      attemptStartedAgo(instance, 121_000);
      await instance.listContextDocuments();
      await settle();
      expect(fake.logRefs).toHaveLength(3);
      expect(attempts()).toBe(0);
      expect((await instance.listContextDocuments()).map(doc => doc.path)).toEqual(["a.md"]);
    });
  });

  it("counts a sync the object never finished against the next attempt", async () => {
    let fake = new FakeGitRepo();
    let stub = await createGitCollection(fake);
    await fake.push("main", { "a.md": "# A" });
    let hold = Promise.withResolvers<void>();
    fake.treeGate = hold.promise;

    await runInDurableObject(stub, async (instance: ContextCollectionDurableObject, state) => {
      void instance.syncArtifactSource().catch(() => {});
      await vi.waitFor(() => expect(fake.treeReads).toHaveLength(1));
      expect(storageOf(instance).gitSyncAttempts.get()).toBe(1);

      // The object resets mid-sync: a new instance finds the attempt recorded and waits it out.
      let restarted = new ContextCollectionDurableObject(state, { ...testEnv, ARTIFACTS: fake.binding() });
      makeStale(restarted);
      await restarted.listContextDocuments();
      expect(fake.logRefs).toHaveLength(1);

      hold.resolve();
      fake.treeGate = undefined;
      await vi.waitFor(() => expect(storageOf(instance).gitSyncAttempts.get()).toBe(0));
    });
  });
});
