import { describe, expect, it } from "vitest";
import { createTypedStorage } from "@gadgets/typed-storage";
import type { GitPullHints, GitOid } from "@gadgets/workshop-shared/gatekeeper";
import { makeMockStorage } from "./mock-storage";
import {
  EAGER_BLOB_LIMIT,
  GitCacheImpl,
  GitObjectTooLargeError,
  MAX_GIT_OBJECT_SIZE,
  WorkspaceGitCache,
  gitObjectMetadataCollection,
} from "../src/git-cache";
import { GitStore, gitObjectsCollection } from "../src/git-store";
import {
  buildPackBytes,
  concatBytes,
  decodePackBytes,
  encodeLooseObject,
  gitObjectOid,
  parseGitTree,
  type PackableObject,
} from "../src/git-codec";
import {
  BAD_NAME_TREE,
  COMMIT_1,
  COMMIT_3,
  FIXTURE_OBJECTS,
  GITLINK_TARGET,
  PACKED_OIDS,
  PACK_OFS_DELTA,
  TREE_1,
  b64Bytes,
} from "./git-cache-fixtures";

// Gatekeeper workpiece ids and action ids used throughout.
const G1 = 7;
const G2 = 8;
const ACTION = 101;
const OTHER_ACTION = 102;

function fixture(oid: string): PackableObject {
  let object = FIXTURE_OBJECTS.find(o => o.oid === oid);
  if (!object) throw new Error(`no fixture object ${oid}`);
  return { type: object.type, payload: b64Bytes(object.payload) };
}

function makeStorage() {
  return createTypedStorage(makeMockStorage(), {
    collections: {
      gitObjects: gitObjectsCollection(),
      gitObjectMetadata: gitObjectMetadataCollection(),
    },
  });
}

type TestStorage = ReturnType<typeof makeStorage>;
type PullHandler = (oids: GitOid[], hints: GitPullHints) => Promise<void>;

interface TestCache {
  storage: TestStorage;
  cache: WorkspaceGitCache;
  pulls: { gatekeeperId: number, oids: GitOid[], hints: GitPullHints }[];
  sources: Map<number, PullHandler>;
}

function makeCache(): TestCache {
  let storage = makeStorage();
  let pulls: TestCache["pulls"] = [];
  let sources = new Map<number, PullHandler>();
  let cache = new WorkspaceGitCache(storage, {
    pull: async (gatekeeperId, oids, hints) => {
      pulls.push({ gatekeeperId, oids, hints });
      let handler = sources.get(gatekeeperId);
      if (!handler) throw new Error(`test: gatekeeper ${gatekeeperId} is unreachable`);
      await handler(oids, hints);
    },
  });
  return { storage, cache, pulls, sources };
}

// A pull handler that serves fixture objects on demand, honoring a blob filter like a real
// filtered fetch would (an omitted blob is simply not delivered; the call still succeeds).
function fixtureSource(t: TestCache, gatekeeperId: number): PullHandler {
  return async (oids, hints) => {
    for (let oid of oids) {
      let object = fixture(oid);
      if (object.type === "blob" && hints.filterBlobSize !== undefined &&
          object.payload.byteLength >= hints.filterBlobSize) {
        continue;
      }
      await t.cache.putFromGatekeeper(gatekeeperId, object.type, object.payload);
    }
  };
}

// Stores an object directly in the store with no gatekeeper attribution -- how locally-authored
// objects (agent commits, gadget history) exist.
async function storeLocal(storage: TestStorage, object: PackableObject): Promise<GitOid> {
  let oid = await gitObjectOid(object.type, object.payload);
  storage.gitObjects.put({ oid, data: encodeLooseObject(object.type, object.payload) });
  return oid;
}

function commitPayload(tree: GitOid, parents: GitOid[], message: string): Uint8Array {
  let text = [
    `tree ${tree}`,
    ...parents.map(parent => `parent ${parent}`),
    "author Test <test@example.com> 1700000000 +0000",
    "committer Test <test@example.com> 1700000000 +0000",
    "",
    `${message}\n`,
  ].join("\n");
  return new TextEncoder().encode(text);
}

function treePayload(entries: { mode: string, name: string, oid: GitOid }[]): Uint8Array {
  return concatBytes(entries.flatMap(entry => [
    new TextEncoder().encode(`${entry.mode} ${entry.name}\0`),
    Uint8Array.from(entry.oid.match(/../g)!.map(h => parseInt(h, 16))),
  ]));
}

function listMarks(storage: TestStorage, actionId: number): GitOid[] {
  return Array.from(storage.gitObjectMetadata.byPendingPushAction.get(actionId))
      .map(record => record.oid);
}

function pendingPushOf(storage: TestStorage, oid: GitOid) {
  return storage.gitObjectMetadata.get(oid)?.pendingPush ?? [];
}

async function streamOf(chunks: Uint8Array[]): Promise<ReadableStream<Uint8Array>> {
  return new ReadableStream({
    start(controller) {
      for (let chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  let chunks: Uint8Array[] = [];
  let reader = stream.getReader();
  for (;;) {
    let { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concatBytes(chunks);
}

// The standard cross-remote scenario: G1 is the *source* remote (serves the fixture repo), G2
// the *destination*. The destination has proven possession of a root "ancestor" commit; a
// locally-authored commit `child` sits on top of it, with TREE_1 (G1's) as its tree.
async function setupCrossRemote(options: { materializeTree?: boolean } = {}) {
  let t = makeCache();
  t.sources.set(G1, fixtureSource(t, G1));

  let ancestorTree = await t.cache.putFromGatekeeper(G2, "tree", treePayload([]));
  let ancestor = await t.cache.putFromGatekeeper(
      G2, "commit", commitPayload(ancestorTree, [], "ancestor"));

  // G1 proves COMMIT_1, whose tree is TREE_1 -- recording TREE_1 as pullable from G1.
  await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);
  if (options.materializeTree ?? true) {
    await t.cache.ensureObject(TREE_1, { type: "tree" });
  }

  let child = await storeLocal(t.storage, {
    type: "commit",
    payload: commitPayload(TREE_1, [ancestor], "child"),
  });
  return { ...t, ancestor, ancestorTree, child };
}

// =======================================================================================

describe("puts and metadata recording", () => {
  it("stores hash-verified objects under real git oids with proof of possession", async () => {
    let t = makeCache();
    let readme = fixture("ca69e6d08b5b8bb4f11a74f9695e329c203cbfd8");  // README.md v1
    let oid = await t.cache.putFromGatekeeper(G1, "blob", readme.payload);
    expect(oid).toBe("ca69e6d08b5b8bb4f11a74f9695e329c203cbfd8");
    expect(t.cache.readLocalObject(oid)).toStrictEqual({ type: "blob", payload: readme.payload });

    let meta = t.storage.gitObjectMetadata.get(oid)!;
    expect(meta.onRemote).toStrictEqual([G1]);
    expect(meta.pullableFrom).toStrictEqual([]);
    expect(meta.pendingPush).toStrictEqual([]);
    expect(meta.type).toBe("blob");
    expect(meta.size).toBe(readme.payload.byteLength);
  });

  it("records referent pull-routing rows for a tree's entries, skipping gitlinks", async () => {
    let t = makeCache();
    await t.cache.putFromGatekeeper(G1, "tree", fixture(TREE_1).payload);
    let entries = parseGitTree(fixture(TREE_1).payload, TREE_1);
    for (let entry of entries) {
      let meta = t.storage.gitObjectMetadata.get(entry.oid);
      if (entry.mode === "160000") {
        expect(meta).toBeUndefined();  // a gitlink's foreign commit is never pull-routed
      } else {
        expect(meta!.pullableFrom).toStrictEqual([G1]);
        expect(meta!.onRemote).toStrictEqual([]);
        expect(meta!.type).toBe(entry.mode === "40000" ? "tree" : "blob");
        expect(meta!.size).toBeUndefined();  // sizes only from measured bytes
      }
    }
    expect(t.storage.gitObjectMetadata.get(GITLINK_TARGET)).toBeUndefined();
  });

  it("records referent rows for a commit's tree and parents", async () => {
    let t = makeCache();
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_3).payload);
    let treeOid = "d8aa5286650240f9fc758910506e5cc39d3eef2c";  // COMMIT_3's tree
    expect(t.storage.gitObjectMetadata.get(treeOid)!.pullableFrom).toStrictEqual([G1]);
    expect(t.storage.gitObjectMetadata.get(treeOid)!.type).toBe("tree");
    let parent = t.storage.gitObjectMetadata.get("3ce192c633c20aae321cbeef73bdaed35ff0771a")!;
    expect(parent.pullableFrom).toStrictEqual([G1]);
    expect(parent.type).toBe("commit");
  });

  it("records advertisements as assertion-grade hints, distinct from proof", async () => {
    let t = makeCache();
    t.cache.advertiseCommit(G1, COMMIT_1);
    let meta = t.storage.gitObjectMetadata.get(COMMIT_1)!;
    expect(meta.pullableFrom).toStrictEqual([G1]);
    expect(meta.onRemote).toStrictEqual([]);
    expect(meta.type).toBe("commit");
    expect(() => t.cache.advertiseCommit(G1, "nonsense")).toThrow(/Invalid git object id/);
  });

  it("rejects an oversized put but records its measured size for fail-fast reads", async () => {
    let t = makeCache();
    let big = new Uint8Array(MAX_GIT_OBJECT_SIZE + 1).fill(0x61);
    let oid = await gitObjectOid("blob", big);
    await expect(t.cache.putFromGatekeeper(G1, "blob", big))
        .rejects.toThrow(GitObjectTooLargeError);

    let meta = t.storage.gitObjectMetadata.get(oid)!;
    expect(meta.size).toBe(MAX_GIT_OBJECT_SIZE + 1);
    expect(meta.type).toBe("blob");
    expect(meta.onRemote).toStrictEqual([G1]);  // the bytes were hash-verified, just not kept
    expect(t.cache.hasLocalObject(oid)).toBe(false);

    // Later reads fail fast on the recorded measurement, without re-downloading.
    await expect(t.cache.ensureObject(oid, { type: "blob" }))
        .rejects.toThrow(GitObjectTooLargeError);
    expect(t.pulls).toHaveLength(0);
  });
});

// =======================================================================================

describe("type claim reconciliation", () => {
  it("corrects an asserted type when measured bytes arrive", async () => {
    let t = makeCache();
    t.cache.advertiseCommit(G1, TREE_1);  // a false claim: TREE_1 is a tree
    expect(t.storage.gitObjectMetadata.get(TREE_1)!.type).toBe("commit");

    await t.cache.putFromGatekeeper(G1, "tree", fixture(TREE_1).payload);
    let meta = t.storage.gitObjectMetadata.get(TREE_1)!;
    expect(meta.type).toBe("tree");
    expect(meta.size).toBe(fixture(TREE_1).payload.byteLength);
  });

  it("never lets an assertion override a measured type, but keeps the routing hint", async () => {
    let t = makeCache();
    await t.cache.putFromGatekeeper(G1, "tree", fixture(TREE_1).payload);

    // A false advertisement leaves the measurement alone; the pullableFrom hint is still
    // recorded, since routing value (pulls want by SHA) is independent of the type claim.
    t.cache.advertiseCommit(G2, TREE_1);
    let meta = t.storage.gitObjectMetadata.get(TREE_1)!;
    expect(meta.type).toBe("tree");
    expect(meta.pullableFrom).toStrictEqual([G2]);

    // Same for a forged commit naming the measured tree as its *parent*.
    await t.cache.putFromGatekeeper(
        G1, "commit", commitPayload(TREE_1, [TREE_1], "forged parent"));
    expect(t.storage.gitObjectMetadata.get(TREE_1)!.type).toBe("tree");
  });

  it("upgrades a conflicting assertion to commit -- commit-ness unlocks operations", async () => {
    let t = makeCache();
    let x = "e".repeat(40);
    // A tree entry introduces X as a blob (assertion-grade)...
    await t.cache.putFromGatekeeper(
        G1, "tree", treePayload([{ mode: "100644", name: "x", oid: x }]));
    expect(t.storage.gitObjectMetadata.get(x)!.type).toBe("blob");

    // ...then an advertisement claims it is a commit: the commit claim wins, and persists even
    // though the advertiser's routing hint was already recorded (nothing else changed the row).
    t.cache.advertiseCommit(G1, x);
    let meta = t.storage.gitObjectMetadata.get(x)!;
    expect(meta.type).toBe("commit");
    expect(meta.pullableFrom).toStrictEqual([G1]);
  });

  it("otherwise keeps the first asserted claim", async () => {
    let t = makeCache();
    // An existing commit claim is not displaced by a later blob claim...
    let x = "e".repeat(40);
    t.cache.advertiseCommit(G1, x);
    await t.cache.putFromGatekeeper(
        G1, "tree", treePayload([{ mode: "100644", name: "x", oid: x }]));
    expect(t.storage.gitObjectMetadata.get(x)!.type).toBe("commit");

    // ...and between two non-commit assertions, the first wins.
    let y = "d".repeat(40);
    await t.cache.putFromGatekeeper(
        G2, "tree", treePayload([{ mode: "100644", name: "y", oid: y }]));  // claims blob
    await t.cache.putFromGatekeeper(
        G2, "commit", commitPayload(y, [], "claims y is my tree"));  // claims tree
    expect(t.storage.gitObjectMetadata.get(y)!.type).toBe("blob");
  });
});

// =======================================================================================

describe("the scoped gatekeeper view (get/has/stat)", () => {
  it("serves onRemote objects to their gatekeeper and nulls to everyone else", async () => {
    let t = makeCache();
    let readme = fixture("ca69e6d08b5b8bb4f11a74f9695e329c203cbfd8");
    let oid = await t.cache.putFromGatekeeper(G1, "blob", readme.payload);

    let mine = new GitCacheImpl(t.cache, G1);
    expect((await mine.get(oid))!.content).toStrictEqual(readme.payload);
    expect(await mine.has(oid)).toBe(true);
    expect(await mine.stat(oid)).toStrictEqual({ type: "blob", size: readme.payload.byteLength });

    // Uniformly null for a gatekeeper the object has nothing to do with, even though it is
    // sitting right there in the local store.
    let other = new GitCacheImpl(t.cache, G2);
    expect(await other.get(oid)).toBeNull();
    expect(await other.has(oid)).toBe(false);
    expect(await other.stat(oid)).toBeNull();
    expect(t.pulls).toHaveLength(0);
  });

  it("does not pull through for an evicted onRemote object (ask your own remote)", async () => {
    let t = makeCache();
    let readme = fixture("ca69e6d08b5b8bb4f11a74f9695e329c203cbfd8");
    let oid = await t.cache.putFromGatekeeper(G1, "blob", readme.payload);
    t.storage.gitObjects.delete(oid);  // simulate eviction

    let stub = new GitCacheImpl(t.cache, G1);
    expect(await stub.get(oid)).toBeNull();
    expect(await stub.has(oid)).toBe(false);
    expect(await stub.stat(oid)).toBeNull();
    expect(t.pulls).toHaveLength(0);
  });

  it("an advertisement grants no reads", async () => {
    let t = makeCache();
    let oid = await storeLocal(t.storage, fixture(COMMIT_1));
    t.cache.advertiseCommit(G1, oid);
    expect(await new GitCacheImpl(t.cache, G1).get(oid)).toBeNull();
  });

  it("pulls a pending-push object through from its recorded source on demand", async () => {
    let t = await setupCrossRemote({ materializeTree: false });
    t.cache.markPushClosure(G2, ACTION, [t.child]);

    // TREE_1 is marked pending push to G2 but locally absent; G2's read pulls it from G1.
    let stub = new GitCacheImpl(t.cache, G2);
    let result = await stub.get(TREE_1);
    expect(result!.type).toBe("tree");
    expect(result!.content).toStrictEqual(fixture(TREE_1).payload);
    expect(t.pulls).toHaveLength(1);
    expect(t.pulls[0].gatekeeperId).toBe(G1);
    expect(t.pulls[0].oids).toStrictEqual([TREE_1]);
    // Default exact-object hints for a tree want.
    expect(t.pulls[0].hints.type).toBe("tree");
    expect(t.pulls[0].hints.filterTreeDepth).toBe(1);
    expect(t.pulls[0].hints.commitHistory).toStrictEqual({ kind: "depth", depth: 1 });
  });

  it("passes caller-provided hints through to the pull", async () => {
    let t = await setupCrossRemote({ materializeTree: false });
    t.cache.markPushClosure(G2, ACTION, [t.child]);
    let hints: GitPullHints = {
      type: "tree",
      commitHistory: { kind: "depth", depth: 3 },
      filterTreeDepth: 5,
    };
    await new GitCacheImpl(t.cache, G2).get(TREE_1, hints);
    expect(t.pulls[0].hints).toStrictEqual(hints);
  });
});

// =======================================================================================

describe("pull driver", () => {
  it("faults a missing object in and parses it", async () => {
    let t = makeCache();
    t.sources.set(G1, fixtureSource(t, G1));
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);
    let tree = await t.cache.ensureObject(TREE_1, { type: "tree", referencedBy: COMMIT_1 });
    expect(tree.payload).toStrictEqual(fixture(TREE_1).payload);
    expect(t.pulls).toHaveLength(1);
    expect(t.pulls[0].hints.referencedBy).toBe(COMMIT_1);
  });

  it("tries each recorded source in turn when one fails", async () => {
    let t = makeCache();
    // TREE_1 becomes pullable from both G1 and G2 (each proved a commit referencing it).
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);
    await t.cache.putFromGatekeeper(
        G2, "commit", commitPayload(TREE_1, [], "other remote's commit"));
    t.sources.set(G1, async () => { throw new Error("G1 is down"); });
    t.sources.set(G2, fixtureSource(t, G2));

    let tree = await t.cache.ensureObject(TREE_1, { type: "tree" });
    expect(tree.type).toBe("tree");
    expect(t.pulls.map(p => p.gatekeeperId)).toStrictEqual([G1, G2]);
  });

  it("reports an object with no viable source, naming the last failure", async () => {
    let t = makeCache();
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);
    t.sources.set(G1, async () => { throw new Error("connection deleted; reconnect it"); });
    await expect(t.cache.ensureObject(TREE_1, { type: "tree" }))
        .rejects.toThrow(/Could not pull git object .* reconnect it/s);

    await expect(t.cache.ensureObject("f".repeat(40), { type: "blob" }))
        .rejects.toThrow(/no connection is known to provide it/);
  });

  it("treats a blob its own filter suppressed as too large, recording nothing", async () => {
    let t = makeCache();
    let bigOid = "b".repeat(40);
    // G1 proves a tree referencing the blob, so the blob is pullable from G1...
    await t.cache.putFromGatekeeper(
        G1, "tree", treePayload([{ mode: "100644", name: "big.bin", oid: bigOid }]));
    // ...but serves nothing for it (as a filtered fetch would for an oversized blob).
    t.sources.set(G1, async () => {});

    await expect(t.cache.ensureObject(bigOid, { type: "blob" }))
        .rejects.toThrow(GitObjectTooLargeError);
    // Absence is gatekeeper behavior, not a measurement: nothing recorded, so the next read
    // retries (self-healing if the omission was a bug).
    expect(t.storage.gitObjectMetadata.get(bigOid)!.size).toBeUndefined();
    await expect(t.cache.ensureObject(bigOid, { type: "blob" }))
        .rejects.toThrow(GitObjectTooLargeError);
    expect(t.pulls).toHaveLength(2);
  });
});

// =======================================================================================

describe("push ancestry verification", () => {
  it("passes when every chain reaches a commit proven on the destination", async () => {
    let t = await setupCrossRemote();
    expect(() => t.cache.verifyPushAncestry(G2, [t.child])).not.toThrow();
  });

  it("trivially passes pushing derived work back to its origin", async () => {
    let t = makeCache();
    t.sources.set(G1, fixtureSource(t, G1));
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);
    let child = await storeLocal(t.storage, {
      type: "commit",
      payload: commitPayload(TREE_1, [COMMIT_1], "derived work"),
    });
    expect(() => t.cache.verifyPushAncestry(G1, [child])).not.toThrow();
  });

  it("rejects when an ancestor commit is absent from the cache", async () => {
    let t = makeCache();
    let missingParent = "d".repeat(40);
    let child = await storeLocal(t.storage, {
      type: "commit",
      payload: commitPayload(TREE_1, [missingParent], "child of missing"),
    });
    expect(() => t.cache.verifyPushAncestry(G1, [child]))
        .toThrow(new RegExp(`commit ${missingParent}.*not available`, "s"));
  });

  it("rejects a root commit that is not itself proven -- no vacuous pass", async () => {
    let t = makeCache();
    let root = await storeLocal(t.storage, {
      type: "commit",
      payload: commitPayload(TREE_1, [], "local root"),
    });
    expect(() => t.cache.verifyPushAncestry(G1, [root]))
        .toThrow(new RegExp(`root commit ${root}.*not known to the destination`, "s"));
  });

  it("rejects on an advertisement where a put would pass -- assertion is not proof", async () => {
    let t = makeCache();
    let rootPayload = commitPayload(TREE_1, [], "the base");
    let root = await storeLocal(t.storage, { type: "commit", payload: rootPayload });
    t.cache.advertiseCommit(G1, root);
    expect(() => t.cache.verifyPushAncestry(G1, [root])).toThrow(/root commit/);

    await t.cache.putFromGatekeeper(G1, "commit", rootPayload);
    expect(() => t.cache.verifyPushAncestry(G1, [root])).not.toThrow();
  });

  it("rejects a non-commit oid", async () => {
    let t = makeCache();
    let blob = await storeLocal(t.storage, {
      type: "blob",
      payload: new TextEncoder().encode("not a commit"),
    });
    expect(() => t.cache.verifyPushAncestry(G1, [blob]))
        .toThrow(new RegExp(`${blob}: it is a blob, not a commit`));
  });

  it("judges a proven object by its local bytes, not its recorded type", async () => {
    let t = makeCache();
    // A wrong assertion-grade type on an onRemote row (e.g. a marking-walk stamp fed a forged
    // referent, converted after an applied push) must not fail ancestry when the decoded bytes
    // prove the object is a commit.
    let ancestor = await storeLocal(t.storage, {
      type: "commit", payload: commitPayload(TREE_1, [], "local ancestor"),
    });
    t.storage.gitObjectMetadata.put(
        { oid: ancestor, type: "tree", onRemote: [G1], pullableFrom: [], pendingPush: [] });
    let child = await storeLocal(t.storage, {
      type: "commit", payload: commitPayload(TREE_1, [ancestor], "child"),
    });
    expect(() => t.cache.verifyPushAncestry(G1, [child])).not.toThrow();

    // Conversely, local bytes proving a non-commit reject it even if the row claims "commit".
    let tree = await storeLocal(t.storage, fixture(TREE_1));
    t.storage.gitObjectMetadata.put(
        { oid: tree, type: "commit", onRemote: [G1], pullableFrom: [], pendingPush: [] });
    expect(() => t.cache.verifyPushAncestry(G1, [tree]))
        .toThrow(new RegExp(`${tree}: it is a tree, not a commit`));
  });
});

// =======================================================================================

describe("isAncestor", () => {
  // Builds and stores the chain root <- mid <- head locally (no gatekeeper attribution -- the
  // shape of agent-authored commits, which is what the pre-submit fast-forward check walks).
  async function storeChain(t: TestCache) {
    let root = await storeLocal(t.storage, {
      type: "commit", payload: commitPayload(TREE_1, [], "root"),
    });
    let mid = await storeLocal(t.storage, {
      type: "commit", payload: commitPayload(TREE_1, [root], "mid"),
    });
    let head = await storeLocal(t.storage, {
      type: "commit", payload: commitPayload(TREE_1, [mid], "head"),
    });
    return { root, mid, head };
  }

  it("finds an ancestor over locally cached commits, regardless of any gatekeeper view", async () => {
    let t = makeCache();
    let { root, mid, head } = await storeChain(t);
    expect(t.cache.isAncestor(root, head)).toBe(true);
    expect(t.cache.isAncestor(mid, head)).toBe(true);
    // Inclusive, like `git merge-base --is-ancestor`: a commit is its own ancestor.
    expect(t.cache.isAncestor(head, head)).toBe(true);
    // Not symmetric.
    expect(t.cache.isAncestor(head, root)).toBe(false);
  });

  it("walks all parents of a merge commit", async () => {
    let t = makeCache();
    let { root, head } = await storeChain(t);
    let side = await storeLocal(t.storage, {
      type: "commit", payload: commitPayload(TREE_1, [], "side root"),
    });
    let merge = await storeLocal(t.storage, {
      type: "commit", payload: commitPayload(TREE_1, [head, side], "merge"),
    });
    expect(t.cache.isAncestor(root, merge)).toBe(true);
    expect(t.cache.isAncestor(side, merge)).toBe(true);
  });

  it("returns false when the chain leaves the cache before reaching the ancestor", async () => {
    let t = makeCache();
    let missingParent = "d".repeat(40);
    let head = await storeLocal(t.storage, {
      type: "commit", payload: commitPayload(TREE_1, [missingParent], "shallow head"),
    });
    // The truth is unknowable over cached history; the answer is the verifiable "false", not an
    // error -- a queue-time fast-forward check should fail closed here.
    expect(t.cache.isAncestor("e".repeat(40), head)).toBe(false);
  });

  it("throws when the descendant is not a locally cached commit", async () => {
    let t = makeCache();
    expect(() => t.cache.isAncestor("a".repeat(40), "b".repeat(40)))
        .toThrow(/not a commit in the workspace's git cache/);
    let blob = await storeLocal(t.storage, {
      type: "blob", payload: new TextEncoder().encode("not a commit"),
    });
    expect(() => t.cache.isAncestor("a".repeat(40), blob))
        .toThrow(/not a commit in the workspace's git cache/);
  });

  it("is exposed on the per-gatekeeper stub without scope restriction", async () => {
    let t = makeCache();
    let { root, head } = await storeChain(t);
    // G1 has never seen these commits; the stub still answers (see the interface doc's
    // deliberate-unscoping note).
    let stub = new GitCacheImpl(t.cache, G1);
    expect(await stub.isAncestor(root, head)).toBe(true);
    expect(await stub.isAncestor(head, root)).toBe(false);
  });
});

// =======================================================================================

describe("the marking walk", () => {
  it("marks the closure, skipping remote-known objects without descending", async () => {
    let t = await setupCrossRemote();
    // Make TREE_1 remote-known to the destination via a G2-proven commit referencing it.
    await t.cache.putFromGatekeeper(G2, "commit", commitPayload(TREE_1, [], "dest has tree"));

    t.cache.markPushClosure(G2, ACTION, [t.child]);
    expect(listMarks(t.storage, ACTION)).toStrictEqual([t.child]);
    // TREE_1 itself is unmarked, and nothing beneath it was descended into.
    expect(pendingPushOf(t.storage, TREE_1)).toStrictEqual([]);
    for (let entry of parseGitTree(fixture(TREE_1).payload, TREE_1)) {
      expect(pendingPushOf(t.storage, entry.oid)).toStrictEqual([]);
    }
  });

  it("marks through containment, skipping gitlinks and the proven ancestor", async () => {
    let t = await setupCrossRemote();
    t.cache.markPushClosure(G2, ACTION, [t.child]);

    let marked = new Set(listMarks(t.storage, ACTION));
    expect(marked.has(t.child)).toBe(true);
    expect(marked.has(TREE_1)).toBe(true);
    for (let entry of parseGitTree(fixture(TREE_1).payload, TREE_1)) {
      expect(marked.has(entry.oid)).toBe(entry.mode !== "160000");
    }
    expect(marked.has(GITLINK_TARGET)).toBe(false);
    expect(marked.has(t.ancestor)).toBe(false);  // onRemote at the destination

    // Absent objects (the subtrees' children were never fetched) are marked too, with their
    // types recorded from the referencing context.
    let docsTree = parseGitTree(fixture(TREE_1).payload, TREE_1).find(e => e.name === "docs")!;
    let naive = parseGitTree(fixture(docsTree.oid).payload).find(e => e.name === "naïve.md")!;
    expect(marked.has(naive.oid)).toBe(false);  // docs' *children* not yet visible...
    expect(t.cache.hasLocalObject(docsTree.oid)).toBe(false);
    expect(pendingPushOf(t.storage, docsTree.oid)).toStrictEqual(
        [{ gatekeeperId: G2, actionId: ACTION }]);
  });

  it("is idempotent per action and independent across actions", async () => {
    let t = await setupCrossRemote();
    t.cache.markPushClosure(G2, ACTION, [t.child]);
    let first = listMarks(t.storage, ACTION);
    t.cache.markPushClosure(G2, ACTION, [t.child]);
    expect(listMarks(t.storage, ACTION)).toStrictEqual(first);

    t.cache.markPushClosure(G2, OTHER_ACTION, [t.child]);
    expect(listMarks(t.storage, OTHER_ACTION).toSorted()).toStrictEqual(first.toSorted());
    expect(pendingPushOf(t.storage, t.child)).toStrictEqual([
      { gatekeeperId: G2, actionId: ACTION },
      { gatekeeperId: G2, actionId: OTHER_ACTION },
    ]);
  });

  it("propagates marks lazily when a marked-absent object's bytes arrive", async () => {
    let t = await setupCrossRemote({ materializeTree: false });
    t.cache.markPushClosure(G2, ACTION, [t.child]);
    // Only the child and the absent TREE_1 could be marked so far.
    expect(new Set(listMarks(t.storage, ACTION))).toStrictEqual(new Set([t.child, TREE_1]));

    // TREE_1 arrives (any gatekeeper): its children become visible and inherit the mark.
    await t.cache.putFromGatekeeper(G1, "tree", fixture(TREE_1).payload);
    let marked = new Set(listMarks(t.storage, ACTION));
    for (let entry of parseGitTree(fixture(TREE_1).payload, TREE_1)) {
      expect(marked.has(entry.oid)).toBe(entry.mode !== "160000");
    }
  });
});

// =======================================================================================

describe("mark lifecycle", () => {
  it("converts marks to onRemote on apply, idempotently", async () => {
    let t = await setupCrossRemote();
    t.cache.markPushClosure(G2, ACTION, [t.child]);
    let marked = listMarks(t.storage, ACTION);
    expect(marked.length).toBeGreaterThan(2);

    t.storage.transaction(() => t.cache.convertPushMarksToOnRemote(ACTION));
    expect(listMarks(t.storage, ACTION)).toStrictEqual([]);
    for (let oid of marked) {
      let meta = t.storage.gitObjectMetadata.get(oid)!;
      expect(meta.onRemote).toContain(G2);
      expect(meta.pendingPush).toStrictEqual([]);
    }
    // Idempotent: a second conversion (crash-retry) is a no-op.
    t.storage.transaction(() => t.cache.convertPushMarksToOnRemote(ACTION));
    expect(t.storage.gitObjectMetadata.get(t.child)!.onRemote).toStrictEqual([G2]);
  });

  it("rolls back atomically with its enclosing transaction (crash between push and record)",
      async () => {
    let t = await setupCrossRemote();
    t.cache.markPushClosure(G2, ACTION, [t.child]);
    let before = listMarks(t.storage, ACTION);
    expect(() => t.storage.transaction(() => {
      t.cache.convertPushMarksToOnRemote(ACTION);
      throw new Error("crash before the completion record persists");
    })).toThrow(/crash/);
    // Nothing stranded: the marks are intact, and a later retry converts them all.
    expect(listMarks(t.storage, ACTION)).toStrictEqual(before);
    expect(t.storage.gitObjectMetadata.get(t.child)!.onRemote).toStrictEqual([]);
    t.storage.transaction(() => t.cache.convertPushMarksToOnRemote(ACTION));
    expect(t.storage.gitObjectMetadata.get(t.child)!.onRemote).toStrictEqual([G2]);
  });

  it("clears marks on rejection without conversion, dropping empty metadata rows", async () => {
    let t = await setupCrossRemote();
    t.cache.markPushClosure(G2, ACTION, [t.child]);

    t.storage.transaction(() => t.cache.clearPushMarks(ACTION));
    expect(listMarks(t.storage, ACTION)).toStrictEqual([]);
    // The locally-authored child had no other metadata: its row is gone entirely.
    expect(t.storage.gitObjectMetadata.get(t.child)).toBeUndefined();
    // TREE_1 keeps its row: it is still pullable from G1, just no longer pending push.
    let tree = t.storage.gitObjectMetadata.get(TREE_1)!;
    expect(tree.pendingPush).toStrictEqual([]);
    expect(tree.pullableFrom).toStrictEqual([G1]);
    expect(tree.onRemote).not.toContain(G2);
  });

  it("clears only the named action's marks", async () => {
    let t = await setupCrossRemote();
    t.cache.markPushClosure(G2, ACTION, [t.child]);
    t.cache.markPushClosure(G2, OTHER_ACTION, [t.child]);
    t.cache.clearPushMarks(ACTION);
    expect(listMarks(t.storage, ACTION)).toStrictEqual([]);
    expect(listMarks(t.storage, OTHER_ACTION)).not.toStrictEqual([]);
    expect(pendingPushOf(t.storage, t.child))
        .toStrictEqual([{ gatekeeperId: G2, actionId: OTHER_ACTION }]);
  });
});

// =======================================================================================

describe("buildPack", () => {
  it("is unavailable on a session-scoped stub", async () => {
    let t = makeCache();
    await expect(new GitCacheImpl(t.cache, G1).buildPack())
        .rejects.toThrow(/action-scoped/);
  });

  it("completes the closure by batched faulting and emits a valid pack", async () => {
    let t = await setupCrossRemote({ materializeTree: false });
    t.cache.markPushClosure(G2, ACTION, [t.child]);

    let stub = new GitCacheImpl(t.cache, G2, ACTION);
    let pack = await collect(await stub.buildPack());
    let objects = await decodePackBytes(pack, { maxObjectSize: 1 << 26 });

    // The pack carries exactly the closure: the child commit, TREE_1, and every non-gitlink
    // object beneath it (5 root entries, docs' file, src's three files).
    let oids = new Set(await Promise.all(
        objects.map(o => gitObjectOid(o.type, o.payload))));
    expect(oids.size).toBe(11);
    expect(oids.has(t.child)).toBe(true);
    expect(oids.has(TREE_1)).toBe(true);
    expect(oids.has(GITLINK_TARGET)).toBe(false);
    expect(oids.has(t.ancestor)).toBe(false);

    // Faults were batched: the tree fetch cascade never pulled one object at a time when
    // several of the same type were missing.
    let blobBatches = t.pulls.filter(p => p.hints.type === "blob");
    expect(blobBatches.length).toBeLessThan(6);  // 7 blobs in far fewer calls
    expect(Math.max(...blobBatches.map(p => p.oids.length))).toBeGreaterThan(1);

    // Cross-check: a fresh cache consumes the pack byte-for-byte.
    let t2 = makeCache();
    let stored = await t2.cache.consumePackFromGatekeeper(G2, await streamOf([pack]));
    expect(new Set(stored)).toStrictEqual(oids);
    expect(t2.cache.readLocalObject(t.child)!.type).toBe("commit");
  });

  it("builds an empty pack when the whole declaration is already remote-known", async () => {
    let t = await setupCrossRemote();
    t.cache.markPushClosure(G2, ACTION, [t.ancestor]);  // already onRemote: nothing marked
    let pack = await collect(await new GitCacheImpl(t.cache, G2, ACTION).buildPack());
    expect(await decodePackBytes(pack, { maxObjectSize: 1 })).toStrictEqual([]);
  });

  it("fails the apply with the source's error on provenance loss", async () => {
    let t = await setupCrossRemote({ materializeTree: false });
    t.cache.markPushClosure(G2, ACTION, [t.child]);
    t.sources.delete(G1);  // the source connection is gone
    await expect(new GitCacheImpl(t.cache, G2, ACTION).buildPack())
        .rejects.toThrow(/unreachable/);
  });
});

// =======================================================================================

describe("consumePack", () => {
  it("stores a real-git pack exactly like the equivalent puts", async () => {
    let t = makeCache();
    let stub = new GitCacheImpl(t.cache, G1);
    let stored = await stub.consumePack(await streamOf([b64Bytes(PACK_OFS_DELTA)]));
    expect(new Set(stored)).toStrictEqual(new Set(PACKED_OIDS));

    for (let oid of PACKED_OIDS) {
      let expected = fixture(oid);
      expect(t.cache.readLocalObject(oid)).toStrictEqual(
          { type: expected.type, payload: expected.payload });
      let meta = t.storage.gitObjectMetadata.get(oid)!;
      expect(meta.onRemote).toStrictEqual([G1]);
      expect(meta.size).toBe(expected.payload.byteLength);
    }
    // Referent recording ran: the gitlink target still has no row.
    expect(t.storage.gitObjectMetadata.get(GITLINK_TARGET)).toBeUndefined();
  });

  it("rejects corrupt input", async () => {
    let t = makeCache();
    let bytes = b64Bytes(PACK_OFS_DELTA).slice();
    bytes[bytes.length - 3] ^= 0x55;
    await expect(new GitCacheImpl(t.cache, G1).consumePack(await streamOf([bytes])))
        .rejects.toThrow(/invalid packfile/);
    expect(Array.from(t.storage.gitObjects.list())).toStrictEqual([]);
  });

  it("measures an oversized entry, skips storing it, and omits it from the result", async () => {
    let t = makeCache();
    let big = new Uint8Array(MAX_GIT_OBJECT_SIZE + 5).fill(0x7a);
    let bigOid = await gitObjectOid("blob", big);
    let small = new TextEncoder().encode("small\n");
    let smallOid = await gitObjectOid("blob", small);
    let pack = concatBytes(await buildPackBytes(
        [{ type: "blob", payload: big }, { type: "blob", payload: small }]));

    let stored = await new GitCacheImpl(t.cache, G1).consumePack(await streamOf([pack]));
    expect(stored).toStrictEqual([smallOid]);
    expect(t.cache.hasLocalObject(bigOid)).toBe(false);
    let meta = t.storage.gitObjectMetadata.get(bigOid)!;
    expect(meta.size).toBe(MAX_GIT_OBJECT_SIZE + 5);
    expect(meta.onRemote).toStrictEqual([G1]);
  });
});

// =======================================================================================

describe("lazy walker reads", () => {
  it("reads files and listings that isomorphic-git wrote (codec cross-verification)", async () => {
    let t = makeCache();
    let store = new GitStore(t.storage.gitObjects);
    let files = new Map([
      ["README.md", "# Hello\n"],
      ["src/app.js", "console.log('hi');\n"],
      ["src/lib/util.js", "export const x = 1;\n"],
    ]);
    let commit = await store.writeFilesAsCommit(files, {
      parents: [],
      author: { name: "Alice Example", email: "alice@example.com" },
      message: "initial commit",
      timestamp: new Date(1700000000_000),
    });

    for (let [path, text] of files) {
      expect(await t.cache.readFileAtCommit(commit, path)).toBe(text);
    }
    expect((await t.cache.listTreeEntries(commit)).map(e => [e.name, e.kind])).toStrictEqual([
      ["README.md", "file"],
      ["src", "dir"],
    ]);
    expect((await t.cache.listTreeEntries(commit, "src/lib")).map(e => e.name))
        .toStrictEqual(["util.js"]);
    expect(t.pulls).toHaveLength(0);  // gadget-history-style reads never fault
  });

  it("reads the real-git fixture repo, faulting blobs lazily", async () => {
    let t = makeCache();
    t.sources.set(G1, fixtureSource(t, G1));
    // Seed only the commits and trees (as a creation-style filtered pull would).
    for (let object of FIXTURE_OBJECTS.filter(o => o.type !== "blob")) {
      if (PACKED_OIDS.includes(object.oid)) {
        await t.cache.putFromGatekeeper(G1, object.type, b64Bytes(object.payload));
      }
    }

    expect(await t.cache.readFileAtCommit(COMMIT_3, "src/util.js"))
        .toBe('export const answer = 42;\nexport const question = "unknown";\n');
    expect(t.pulls).toHaveLength(1);
    expect(t.pulls[0].hints.type).toBe("blob");
    expect(t.pulls[0].hints.filterBlobSize).toBe(MAX_GIT_OBJECT_SIZE + 1);

    // Non-ASCII UTF-8 names resolve.
    expect(await t.cache.readFileAtCommit(COMMIT_1, "docs/naïve.md")).toBe("naïve UTF-8 name\n");
  });

  it("a fault against a worktree base pulls the whole tree and small blobs in one round trip",
      async () => {
    let t = makeCache();
    // A closure-serving source, like a real protocol fetch: everything the filter spec admits.
    // (fixtureSource serves exact objects only, which would mask the difference between one
    // eager pull and a serial per-segment walk.)
    t.sources.set(G1, async (oids, hints) => {
      if (hints.filterTreeDepth !== undefined) {
        // An exact-object fetch shape: serve just the wants.
        for (let oid of oids) {
          await t.cache.putFromGatekeeper(G1, fixture(oid).type, fixture(oid).payload);
        }
        return;
      }
      for (let object of FIXTURE_OBJECTS) {
        if (!PACKED_OIDS.includes(object.oid)) continue;
        let payload = b64Bytes(object.payload);
        if (object.type === "blob" && hints.filterBlobSize !== undefined &&
            payload.byteLength >= hints.filterBlobSize) {
          continue;
        }
        await t.cache.putFromGatekeeper(G1, object.type, payload);
      }
    });
    // Only the commit itself is local -- a worktree created on an already-local commit whose
    // trees were never pulled (creation's ensureGitObjects no-ops when the commit is present).
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);
    t.pulls.length = 0;

    expect(await t.cache.readFileAtCommitIfExists(COMMIT_1, "src/util.js")).toBeDefined();
    expect(t.pulls).toHaveLength(1);
    expect(t.pulls[0].hints.type).toBe("tree");
    expect(t.pulls[0].hints.filterTreeDepth).toBeUndefined();
    expect(t.pulls[0].hints.filterBlobSize).toBe(EAGER_BLOB_LIMIT);

    // The eager pull brought the whole tree structure and every small blob: reads elsewhere in
    // the tree fault nothing further.
    expect(await t.cache.readFileAtCommitIfExists(COMMIT_1, "README.md")).toBe("# Fixture\n");
    expect(await t.cache.readFileAtCommitIfExists(COMMIT_1, "docs/naïve.md"))
        .toBe("naïve UTF-8 name\n");
    expect(t.pulls).toHaveLength(1);
  });

  it("surfaces all five entry kinds from the fixture tree", async () => {
    let t = makeCache();
    t.sources.set(G1, fixtureSource(t, G1));
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);

    expect((await t.cache.listTreeEntries(COMMIT_1)).map(e => [e.name, e.kind])).toStrictEqual([
      ["README.md", "file"],
      ["docs", "dir"],
      ["link.md", "symlink"],
      ["run.sh", "executable"],
      ["src", "dir"],
      ["vendored", "submodule"],
    ]);
  });

  it("throws descriptive errors for symlinks, gitlinks, directories, and misses", async () => {
    let t = makeCache();
    t.sources.set(G1, fixtureSource(t, G1));
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);

    await expect(t.cache.readFileAtCommit(COMMIT_1, "link.md"))
        .rejects.toThrow("link.md is a symlink to README.md");
    await expect(t.cache.readFileAtCommit(COMMIT_1, "vendored"))
        .rejects.toThrow(`vendored is a submodule (gitlink) pointing at commit ${GITLINK_TARGET}`);
    await expect(t.cache.readFileAtCommit(COMMIT_1, "src"))
        .rejects.toThrow("src: no such file");
    await expect(t.cache.readFileAtCommit(COMMIT_1, "no/such/file.txt"))
        .rejects.toThrow("no/such/file.txt: no such file");
    await expect(t.cache.readFileAtCommit(COMMIT_1, "../escape"))
        .rejects.toThrow(/invalid file path/);
  });

  it("rejects binary content cleanly", async () => {
    let t = makeCache();
    let binary = await storeLocal(t.storage,
        { type: "blob", payload: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) });
    let tree = await storeLocal(t.storage, {
      type: "tree",
      payload: treePayload([{ mode: "100644", name: "logo.png", oid: binary }]),
    });
    let commit = await storeLocal(t.storage,
        { type: "commit", payload: commitPayload(tree, [], "binary") });
    await expect(t.cache.readFileAtCommit(commit, "logo.png"))
        .rejects.toThrow("logo.png is not a text file");
  });

  it("fails a read of a measured-oversized blob fast, with a path-specific error", async () => {
    let t = makeCache();
    let big = new Uint8Array(MAX_GIT_OBJECT_SIZE + 1).fill(0x61);
    let bigOid = await gitObjectOid("blob", big);
    await t.cache.putFromGatekeeper(G1, "blob", big).catch(() => {});  // records the measurement
    let tree = await storeLocal(t.storage, {
      type: "tree",
      payload: treePayload([{ mode: "100644", name: "huge.txt", oid: bigOid }]),
    });
    let commit = await storeLocal(t.storage,
        { type: "commit", payload: commitPayload(tree, [], "huge") });
    await expect(t.cache.readFileAtCommit(commit, "huge.txt"))
        .rejects.toThrow(/huge\.txt is too large to read/);
    expect(t.pulls).toHaveLength(0);
  });

  it("fails parsing a tree with a non-UTF-8 entry name, naming the tree", async () => {
    let t = makeCache();
    await storeLocal(t.storage, fixture(BAD_NAME_TREE));
    let commit = await storeLocal(t.storage,
        { type: "commit", payload: commitPayload(BAD_NAME_TREE, [], "bad name") });
    await expect(t.cache.listTreeEntries(commit))
        .rejects.toThrow(new RegExp(`${BAD_NAME_TREE}.*not valid UTF-8`));
    await expect(t.cache.readFileAtCommit(commit, "anything.txt"))
        .rejects.toThrow(/not valid UTF-8/);
  });
});

// =======================================================================================

describe("worktree read/write helpers", () => {
  it("readFileAtCommitIfExists returns undefined for absent paths and text otherwise", async () => {
    let t = makeCache();
    t.sources.set(G1, fixtureSource(t, G1));
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);

    expect(await t.cache.readFileAtCommitIfExists(COMMIT_1, "README.md"))
        .toBe("# Fixture\n");
    // Absence in all its shapes: missing leaf, missing intermediate, non-directory
    // intermediate, and a directory path.
    expect(await t.cache.readFileAtCommitIfExists(COMMIT_1, "nope.txt")).toBeUndefined();
    expect(await t.cache.readFileAtCommitIfExists(COMMIT_1, "no/such/file.txt")).toBeUndefined();
    expect(await t.cache.readFileAtCommitIfExists(COMMIT_1, "README.md/child")).toBeUndefined();
    expect(await t.cache.readFileAtCommitIfExists(COMMIT_1, "src")).toBeUndefined();
    // The descriptive errors still throw: absence is the only softened case.
    await expect(t.cache.readFileAtCommitIfExists(COMMIT_1, "link.md"))
        .rejects.toThrow("link.md is a symlink to README.md");
    await expect(t.cache.readFileAtCommitIfExists(COMMIT_1, "vendored"))
        .rejects.toThrow("vendored is a submodule");
  });

  it("assertWorktreePathWritable rejects symlink, gitlink, and directory paths, passes the rest",
      async () => {
    let t = makeCache();
    t.sources.set(G1, fixtureSource(t, G1));
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);

    await expect(t.cache.assertWorktreePathWritable(COMMIT_1, "link.md"))
        .rejects.toThrow("link.md is a symlink to README.md");
    await expect(t.cache.assertWorktreePathWritable(COMMIT_1, "vendored"))
        .rejects.toThrow(`vendored is a submodule (gitlink) pointing at commit ${GITLINK_TARGET}`);
    // A write at a directory-named path could never commit (a git tree cannot hold a file and
    // a directory of one name), so it fails here, next to its cause.
    await expect(t.cache.assertWorktreePathWritable(COMMIT_1, "src"))
        .rejects.toThrow("src is a directory");
    // Regular files (either mode) and new paths -- including under a base directory -- pass.
    await t.cache.assertWorktreePathWritable(COMMIT_1, "README.md");
    await t.cache.assertWorktreePathWritable(COMMIT_1, "run.sh");
    await t.cache.assertWorktreePathWritable(COMMIT_1, "brand-new.txt");
    await t.cache.assertWorktreePathWritable(COMMIT_1, "src/brand-new.txt");
  });

  it("assertWorktreePathWritable passes an oversized base blob (a set needs no readable base)",
      async () => {
    let t = makeCache();
    let big = new Uint8Array(MAX_GIT_OBJECT_SIZE + 1).fill(0x61);
    let bigOid = await gitObjectOid("blob", big);
    let tree = await storeLocal(t.storage, {
      type: "tree",
      payload: treePayload([{ mode: "100644", name: "huge.txt", oid: bigOid }]),
    });
    let commit = await storeLocal(t.storage,
        { type: "commit", payload: commitPayload(tree, [], "huge") });
    await t.cache.assertWorktreePathWritable(commit, "huge.txt");
  });
});

describe("resolveCommitRef", () => {
  it("resolves full oids and unambiguous prefixes of local commits", async () => {
    let t = makeCache();
    let tree = await storeLocal(t.storage, { type: "tree", payload: treePayload([]) });
    let commit = await storeLocal(t.storage,
        { type: "commit", payload: commitPayload(tree, [], "local") });

    expect(t.cache.resolveCommitRef(commit)).toBe(commit);
    expect(t.cache.resolveCommitRef(commit.slice(0, 8))).toBe(commit);
    expect(t.cache.resolveCommitRef(commit.slice(0, 8).toUpperCase())).toBe(commit);
    // The tree shares no 8-hex prefix with the commit (vanishingly unlikely), and a prefix
    // matching only non-commits resolves to nothing.
    expect(() => t.cache.resolveCommitRef(tree.slice(0, 8)))
        .toThrow(/not known to this workspace/);
    // A locally-present non-commit named in full is rejected by its decoded type.
    expect(() => t.cache.resolveCommitRef(tree)).toThrow(`${tree} is a tree, not a commit.`);
  });

  it("rejects malformed, unknown, and ambiguous refs", async () => {
    let t = makeCache();
    // Fabricated metadata rows steer prefix matching without any stored objects.
    let put = (oid: GitOid, type: "commit" | "blob") => t.storage.gitObjectMetadata.put(
        { oid, type, onRemote: [G1], pullableFrom: [], pendingPush: [] });
    put("aaaa1111".padEnd(40, "0"), "commit");
    put("aaaa2222".padEnd(40, "0"), "commit");
    put("bbbb1111".padEnd(40, "0"), "blob");

    expect(() => t.cache.resolveCommitRef("xyz")).toThrow(/not a git commit id/);
    expect(() => t.cache.resolveCommitRef("abc")).toThrow(/not a git commit id/);  // too short
    expect(() => t.cache.resolveCommitRef("cccc")).toThrow(/not known to this workspace/);
    expect(() => t.cache.resolveCommitRef("aaaa"))
        .toThrow(/ambiguous between: aaaa1111.*aaaa2222/);
    expect(t.cache.resolveCommitRef("aaaa1")).toBe("aaaa1111".padEnd(40, "0"));
    // An asserted non-commit is filtered from prefix candidates (commit-bias makes the tag
    // trustworthy for refusal-free filtering)...
    expect(() => t.cache.resolveCommitRef("bbbb")).toThrow(/not known to this workspace/);
    // ...but a full oid resolves regardless of its assertion-grade tag (the reader rule: the
    // caller's pull lets the decoded bytes decide).
    expect(t.cache.resolveCommitRef("bbbb1111".padEnd(40, "0")))
        .toBe("bbbb1111".padEnd(40, "0"));
  });
});
