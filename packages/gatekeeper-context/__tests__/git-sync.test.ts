import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ContextCollectionDurableObject } from "../src/context-collection.js";
import { MAX_DOCUMENT_BODY_BYTES, type ContextCollectionMetadata } from "../src/context-types.js";
import { domainName } from "../src/domain.js";
import { FakeGitRepo, artifactsError } from "./fake-git-repo.js";

const DOMAIN = "workshop.example";

type TestEnv = { COLLECTIONS: DurableObjectNamespace<ContextCollectionDurableObject> };
const testEnv = env as unknown as TestEnv & Cloudflare.Env;

// The storage fields these tests read or age; the object keeps them private.
type SyncStorage = {
  gitSyncAttempts: { get(): number };
  gitSyncBackoffFrom: { put(at: Date): void };
  metadata: { get(): ContextCollectionMetadata; put(meta: ContextCollectionMetadata): void };
  documents: {
    list(): Iterable<{ path: string; gitBlobHash?: string }>;
    put(record: object): void;
  };
  gitStaged: { list(): Iterable<{ path: string }> };
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

// Moves the time the backoff delay is counted from `ms` into the past.
function attemptStartedAgo(instance: ContextCollectionDurableObject, ms: number): void {
  storageOf(instance).gitSyncBackoffFrom.put(new Date(Date.now() - ms));
}

// Lets a background sync against the in-memory fake, which does no I/O, run to completion.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// Collects the fields of each warning that a sync is emptying a collection that held documents.
function watchEmptiedWarnings() {
  let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return {
    calls: () => warn.mock.calls.map(([fields]) => fields as { event?: string })
      .filter(fields => fields.event === "context.collection.git.branch.empty"),
    restore: () => warn.mockRestore(),
  };
}

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

  it("reads every file back into a collection emptied while its branch could not be found", async () => {
    let fake = new FakeGitRepo();
    let stub = await createGitCollection(fake);
    let commit = await fake.push("main", { "a.md": "# A", "skills/deploys/SKILL.md": skill });
    await stub.syncArtifactSource();
    fake.branches.delete("main");
    let warnings = watchEmptiedWarnings();
    try {
      await stub.syncArtifactSource();
      expect((await stub.getMetadata()).documentCount).toBe(0);
      expect(warnings.calls()).toEqual([expect.objectContaining({ branch: "main", commit, documentCount: 2 })]);
    } finally {
      warnings.restore();
    }

    fake.resetBranch("main", commit);
    await stub.syncArtifactSource();

    expect((await stub.listContextDocuments()).map(doc => doc.path))
      .toEqual(["a.md", "skills/deploys/SKILL.md"]);
    expect((await stub.getMetadata()).documentCount).toBe(2);
    expect((await stub.listAgentSkills()).map(entry => entry.skillName)).toEqual(["deploys"]);
  });

  it("warns when switching to a branch that has no commits empties the collection", async () => {
    let fake = new FakeGitRepo();
    let stub = await createGitCollection(fake);
    let warnings = watchEmptiedWarnings();
    try {
      // A collection with nothing in it has nothing to lose.
      await stub.syncArtifactSource();
      expect(warnings.calls()).toEqual([]);

      await fake.push("main", { "a.md": "# A" });
      await stub.syncArtifactSource();
      await stub.updateMetadata({ branch: "missing" });
      await stub.syncArtifactSource();

      expect((await stub.getMetadata()).documentCount).toBe(0);
      expect(warnings.calls()).toEqual([expect.objectContaining({ branch: "missing", documentCount: 1 })]);
    } finally {
      warnings.restore();
    }
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

  it("keeps the old documents until a commit is read in full, then resumes where it stopped", async () => {
    let fake = new FakeGitRepo();
    let stub = await createGitCollection(fake);
    await fake.push("main", { "a.md": "# A", "b.md": "# B" });
    await stub.syncArtifactSource();
    await fake.push("main", { "a.md": "# A, edited", "b.md": "# B, edited", "c.md": "# C" });
    fake.blobErrors.set(await fake.hashOf("# C"), artifactsError("INTERNAL_ERROR"));

    await expect(settled(stub.syncArtifactSource())).rejects.toThrow("INTERNAL_ERROR");
    expect((await stub.listContextDocuments()).map(doc => doc.path)).toEqual(["a.md", "b.md"]);
    expect((await stub.getContextDocument("a.md"))?.body).toBe("# A");

    fake.blobErrors.clear();
    fake.blobReads = [];
    await stub.syncArtifactSource();

    expect(fake.blobReads).toEqual([await fake.hashOf("# C")]);
    expect((await stub.listContextDocuments()).map(doc => doc.path)).toEqual(["a.md", "b.md", "c.md"]);
    expect((await stub.getContextDocument("a.md"))?.body).toBe("# A, edited");
    await runInDurableObject(stub, (instance: ContextCollectionDurableObject) => {
      expect([...storageOf(instance).gitStaged.list()]).toEqual([]);
    });
  });

  it("keeps a document whose published copy matches, even with a stale copy staged", async () => {
    let fake = new FakeGitRepo();
    let stub = await createGitCollection(fake);
    await fake.push("main", { "a.md": "# A", "b.md": "# B" });
    await stub.syncArtifactSource();
    let before = (await stub.listContextDocuments()).find(doc => doc.path === "a.md");
    // A sync stages an edited a.md, then fails on c.md.
    await fake.push("main", { "a.md": "# A, edited", "b.md": "# B", "c.md": "# C" });
    fake.blobErrors.set(await fake.hashOf("# C"), artifactsError("INTERNAL_ERROR"));
    await expect(settled(stub.syncArtifactSource())).rejects.toThrow("INTERNAL_ERROR");

    // The next commit restores a.md and edits b.md.
    await fake.push("main", { "a.md": "# A", "b.md": "# B, edited" });
    fake.blobReads = [];
    await stub.syncArtifactSource();

    expect(fake.blobReads).toEqual([await fake.hashOf("# B, edited")]);
    let after = (await stub.listContextDocuments()).find(doc => doc.path === "a.md");
    expect(after?.lastUpdated).toEqual(before?.lastUpdated);
    expect((await stub.getContextDocument("a.md"))?.body).toBe("# A");
  });

  it("clears what a failed sync staged once the branch is back at the published commit", async () => {
    let fake = new FakeGitRepo();
    let stub = await createGitCollection(fake);
    let published = await fake.push("main", { "a.md": "# A" });
    await stub.syncArtifactSource();
    await fake.push("main", { "a.md": "# A, edited", "b.md": "# B" });
    fake.blobErrors.set(await fake.hashOf("# B"), artifactsError("INTERNAL_ERROR"));
    await expect(settled(stub.syncArtifactSource())).rejects.toThrow("INTERNAL_ERROR");

    fake.resetBranch("main", published);
    await stub.syncArtifactSource();

    await runInDurableObject(stub, (instance: ContextCollectionDurableObject) => {
      expect([...storageOf(instance).gitStaged.list()]).toEqual([]);
    });
  });

  it("drops a file that grew too large to keep", async () => {
    let fake = new FakeGitRepo();
    let stub = await createGitCollection(fake);
    await fake.push("main", { "a.md": "# A", "data.bin": "small" });
    await stub.syncArtifactSource();

    await fake.push("main", { "a.md": "# A", "data.bin": new Uint8Array(MAX_DOCUMENT_BODY_BYTES + 1) });
    await stub.syncArtifactSource();

    expect((await stub.listContextDocuments()).map(doc => doc.path)).toEqual(["a.md"]);
    expect((await stub.getMetadata()).documentCount).toBe(1);
  });

  it("stores nothing a sync reads once its collection's deletion has begun", async () => {
    let fake = new FakeGitRepo();
    let stub = await createGitCollection(fake);
    await fake.push("main", { "a.md": "# A" });
    let hold = Promise.withResolvers<void>();
    fake.blobDelay = () => hold.promise;
    let sync = settled(stub.syncArtifactSource());
    await vi.waitFor(() => expect(fake.blobReads).toHaveLength(1));

    await stub.deleteSelf("owner", false);
    hold.resolve();

    await expect(sync).rejects.toThrow("deleted during its git sync");
    await runInDurableObject(stub, (_instance: ContextCollectionDurableObject, state) => {
      expect([...state.storage.kv.list()]).toEqual([]);
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

  it("counts the wait after a slow failed sync from when it failed", async () => {
    let fake = new FakeGitRepo();
    let stub = await createGitCollection(fake);
    await fake.push("main", { "a.md": "# A" });
    let hold = Promise.withResolvers<void>();
    fake.blobDelay = () => hold.promise;
    fake.blobErrors.set(await fake.hashOf("# A"), artifactsError("INTERNAL_ERROR"));

    await runInDurableObject(stub, async (instance: ContextCollectionDurableObject) => {
      let sync = instance.syncArtifactSource().catch(() => {});
      await vi.waitFor(() => expect(fake.blobReads).toHaveLength(1));
      // The sync has been running for over a minute when it fails.
      attemptStartedAgo(instance, 61_000);
      hold.resolve();
      await sync;

      makeStale(instance);
      await instance.listContextDocuments();
      expect(fake.logRefs).toHaveLength(1);
    });
  });

  it("syncs a newly chosen branch without waiting out the old one's failures", async () => {
    let fake = new FakeGitRepo();
    let stub = await createGitCollection(fake);
    await fake.push("main", { "a.md": "# A" });
    await fake.push("next", { "b.md": "# B" });
    fake.failNextLog = new Error("Artifacts is unavailable.");
    await expect(settled(stub.syncArtifactSource())).rejects.toThrow("Artifacts is unavailable.");

    await stub.updateMetadata({ branch: "next" });

    await runInDurableObject(stub, async (instance: ContextCollectionDurableObject) => {
      expect(storageOf(instance).gitSyncAttempts.get()).toBe(0);
      makeStale(instance);
      await instance.listContextDocuments();
      await settle();
      expect(fake.logRefs.at(-1)).toBe("next");
      expect((await instance.listContextDocuments()).map(doc => doc.path)).toEqual(["b.md"]);
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
