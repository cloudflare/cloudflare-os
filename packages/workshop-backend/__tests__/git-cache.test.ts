import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { deflateSync } from "node:zlib";
import {
  MAX_BUFFERED_BLOB_SIZE,
  MAX_RESTRICTED_PUSH_COMMITS,
  MAX_RESTRICTED_PUSH_FILES,
  MAX_RESTRICTED_PUSH_PATHS,
  MAX_RESTRICTED_PUSH_TEXT_SIZE,
  type GitPullHints,
  type GitOid,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  MAX_PUSH_REVIEW_CURSOR,
  MAX_PUSH_REVIEW_WALK_BYTES,
  MAX_PUSH_REVIEW_WALK_OBJECTS,
  PUSH_REVIEW_PAGE_SIZE,
  READ_FILES_RESPONSE_BUDGET,
  type PushReviewEntry,
  type PushReviewParentEntry,
  type PushReviewSent,
  type PushReviewTreeEntry,
} from "@gadgets/workshop-shared/api";
import { makeMockStorage } from "./mock-storage";
import {
  EAGER_BLOB_LIMIT,
  GitCacheImpl,
  UnreadableContentError,
  WorkspaceGitCache,
} from "../src/git-cache";
import { BlobReader, CHUNK_MAX_SIZE } from "../src/git-chunked-blob";
import { buildSnapshotRelease } from "../src/blueprint-release";
import { makeOverseerStorage } from "../src/storage-schema/overseer-storage";
import {
  EMPTY_TREE_OID,
  blobOid,
  buildPackBytes,
  concatBytes,
  encodeGitTree,
  encodeLooseObject,
  gitObjectOid,
  parseGitTree,
  scanGitTree,
  type GitTreeEntry,
  type PackableObject,
} from "../src/git-codec";
import {
  BAD_NAME_TREE,
  COMMIT_1,
  COMMIT_2,
  COMMIT_3,
  FIXTURE_OBJECTS,
  GITLINK_TARGET,
  GPGSIG_COMMIT,
  PACKED_OIDS,
  PACK_OFS_DELTA,
  TREE_1,
  b64Bytes,
  byteStream,
  decodePack,
} from "./git-cache-fixtures";

// Gatekeeper workpiece ids and action ids used throughout.
const G1 = 7;
const G2 = 8;
const G3 = 9;
const ACTION = 101;
const OTHER_ACTION = 102;

function fixture(oid: string): PackableObject {
  let object = FIXTURE_OBJECTS.find(o => o.oid === oid);
  if (!object) throw new Error(`no fixture object ${oid}`);
  return { type: object.type, payload: b64Bytes(object.payload) };
}

function makeStorage() {
  return makeOverseerStorage(makeMockStorage());
}

// Storage for a test over thousands of objects. The mock copies the whole store at the start
// of every transaction, to roll it back, and every metadata write is one: here they run
// without the copy, so nothing rolls back.
function makeLargeStorage() {
  let raw = makeMockStorage();
  raw.transactionSync = callback => callback();
  return makeOverseerStorage(raw);
}

type TestStorage = ReturnType<typeof makeStorage>;
type PullHandler = (oids: GitOid[], hints: GitPullHints) => Promise<void>;

interface TestCache {
  storage: TestStorage;
  cache: WorkspaceGitCache;
  pulls: { gatekeeperId: number, oids: GitOid[], hints: GitPullHints }[];
  sources: Map<number, PullHandler>;
}

function makeCache(storage = makeStorage()): TestCache {
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
  let oid = gitObjectOid(object.type, object.payload);
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

// Stores a commit locally, distinguished from every other by its message.
async function storeCommit(t: TestCache, message: string, parents: GitOid[] = [])
    : Promise<GitOid> {
  return await storeLocal(
      t.storage, { type: "commit", payload: commitPayload(TREE_1, parents, message) });
}

// Counts the object records written from here on.
function countPuts(t: TestCache): { count: number } {
  let puts = { count: 0 };
  let put = t.storage.gitObjects.put.bind(t.storage.gitObjects);
  t.storage.gitObjects.put = record => {
    puts.count++;
    put(record);
  };
  return puts;
}

// Records the oid of every object record read from here on.
function countReads(t: TestCache): GitOid[] {
  let reads: GitOid[] = [];
  let get = t.storage.gitObjects.get.bind(t.storage.gitObjects);
  t.storage.gitObjects.get = oid => {
    reads.push(oid);
    return get(oid);
  };
  return reads;
}

function treePayload(entries: { mode: string, name: string, oid: GitOid }[]): Uint8Array {
  return concatBytes(entries.flatMap(entry => [
    new TextEncoder().encode(`${entry.mode} ${entry.name}\0`),
    Uint8Array.from(entry.oid.match(/../g)!.map(h => parseInt(h, 16))),
  ]));
}

// Every way an object reaches the store. `by` is the gatekeeper whose remote the arrival proves
// has the object, if it proves that of any.
const ARRIVALS: {
  route: string,
  by?: number,
  deliver: (t: TestCache, object: PackableObject) => Promise<unknown>,
}[] = [
  {
    route: "a gatekeeper's put",
    by: G3,
    deliver: (t, object) => t.cache.putFromGatekeeper(G3, object.type, object.payload),
  },
  {
    route: "an import",
    deliver: (t, object) => t.cache.importObjects([object]),
  },
  {
    // As a commit authored here writes a tree: by rebuilding a base that lacks one of the tree's
    // regular files, adding the file back.
    route: "a commit written here",
    deliver: async (t, object) => {
      let entries = parseGitTree(object.payload);
      let file = entries.find(entry => entry.mode === "100644")!;
      let rest = encodeGitTree(entries.filter(entry => entry !== file));
      await t.cache.importObjects([{ type: "tree", payload: rest }]);
      let base = await t.cache.writeCommitForTree(gitObjectOid("tree", rest), {
        parents: [], author: { name: "A", email: "a@b" }, message: "m", timestamp: new Date(0),
      });
      let text = new TextDecoder().decode(fixture(file.oid).payload);
      expect(await t.cache.writeChangedTree(base, new Map([[file.name, text]])))
          .toBe(gitObjectOid("tree", object.payload));
    },
  },
];

// TREE_1's `docs` subtree and the one file in it: an object two levels beneath the tree.
const DOCS_TREE = "59d380616a33d90ddb4d4b887032e13d37590bf4";
const DOCS_FILE = "78a3978560a66a1d3c14215ecbf2be19d70c5c43";

function listMarks(storage: TestStorage, actionId: number): GitOid[] {
  return Array.from(storage.gitObjectMetadata.byPendingPushAction.get(actionId))
      .map(record => record.oid);
}

function pendingPushOf(storage: TestStorage, oid: GitOid) {
  return storage.gitObjectMetadata.get(oid)?.pendingPush ?? [];
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

  for (let { route, by, deliver } of ARRIVALS) {
    it(`extends an absent object's sources to its referents when it arrives by ${route}`,
        async () => {
      let t = makeCache();
      // Two remotes are recorded as having TREE_1, by commits of theirs that refer to it.
      await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);
      await t.cache.putFromGatekeeper(G2, "commit", commitPayload(TREE_1, [], "same tree"));
      let entries = parseGitTree(fixture(TREE_1).payload, TREE_1)
          .filter(entry => entry.mode !== "160000");
      for (let entry of entries) {
        expect(t.storage.gitObjectMetadata.get(entry.oid)).toBeUndefined();
      }
      let expectSourcesOfEntries = (sources: number[]) => {
        for (let entry of entries) {
          let meta = t.storage.gitObjectMetadata.get(entry.oid)!;
          expect(meta.pullableFrom.toSorted()).toStrictEqual(sources);
          expect(meta.onRemote).toStrictEqual([]);  // a claim, however sure its origin
        }
      };

      // Whoever has the tree has its entries, wherever these bytes came from.
      await deliver(t, fixture(TREE_1));
      expectSourcesOfEntries(by === undefined ? [G1, G2] : [G1, G2, by]);
      expect(t.storage.gitObjectMetadata.get(GITLINK_TARGET)).toBeUndefined();
      expect(t.storage.gitObjectMetadata.get(TREE_1)!.onRemote)
          .toStrictEqual(by === undefined ? [] : [by]);

      // So does a remote later proven to have the tree, though the tree is already here.
      await t.cache.putFromGatekeeper(G3, "tree", fixture(TREE_1).payload);
      expectSourcesOfEntries([G1, G2, G3]);
    });
  }

  for (let { route, by, deliver } of ARRIVALS) {
    it(`extends sources through an object that arrived before its parent, by ${route}`,
        async () => {
      let t = makeCache();
      t.sources.set(G1, fixtureSource(t, G1));
      await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);

      // The subtree comes first, as a pack is free to order it, when nothing yet says that
      // G1 has it. Then the tree that G1 is recorded as having.
      await deliver(t, fixture(DOCS_TREE));
      await deliver(t, fixture(TREE_1));
      expect(t.storage.gitObjectMetadata.get(DOCS_FILE)!.pullableFrom.toSorted())
          .toStrictEqual(by === undefined ? [G1] : [G1, by]);
      // Which is what lets the file be pulled at all.
      expect((await t.cache.ensureObject(DOCS_FILE, { type: "blob" })).type).toBe("blob");
    });
  }

  it("extends a source that a held object gains later, as far down as objects are held",
      async () => {
    let t = makeCache();
    await t.cache.importObjects([fixture(COMMIT_1), fixture(TREE_1), fixture(DOCS_TREE)]);
    expect(Array.from(t.storage.gitObjectMetadata.list())).toStrictEqual([]);

    t.cache.advertiseCommit(G1, COMMIT_1);
    let entries = parseGitTree(fixture(TREE_1).payload, TREE_1)
        .filter(entry => entry.mode !== "160000");
    for (let oid of [COMMIT_1, TREE_1, ...entries.map(entry => entry.oid), DOCS_FILE]) {
      expect(t.storage.gitObjectMetadata.get(oid)!.pullableFrom).toStrictEqual([G1]);
    }
    // `src` is not held, so nothing can be said yet about what is in it.
    let src = entries.find(entry => entry.name === "src")!;
    for (let entry of parseGitTree(fixture(src.oid).payload, src.oid)) {
      expect(t.storage.gitObjectMetadata.get(entry.oid)).toBeUndefined();
    }
  });

  it("does not walk again beneath an object the gatekeeper is already a source of", async () => {
    let t = makeCache();
    await t.cache.importObjects([fixture(COMMIT_1), fixture(TREE_1), fixture(DOCS_TREE)]);
    t.cache.advertiseCommit(G1, COMMIT_1);
    await t.cache.putFromGatekeeper(G2, "tree", fixture(TREE_1).payload);

    let reads = 0;
    let get = t.storage.gitObjects.get.bind(t.storage.gitObjects);
    t.storage.gitObjects.get = oid => {
      reads++;
      return get(oid);
    };
    // G1 is a source of the commit by claim, and G2 of its tree by proof.
    t.cache.advertiseCommit(G1, COMMIT_1);
    await t.cache.putFromGatekeeper(G2, "commit", commitPayload(TREE_1, [], "same tree"));
    expect(reads).toBe(0);
    // The hint itself is still recorded on the tree; it is the walk beneath it that is spared.
    expect(t.storage.gitObjectMetadata.get(TREE_1)!.pullableFrom).toStrictEqual([G1, G2]);
  });

  it("looks inside an arriving object whatever type it was claimed to be", async () => {
    let t = makeCache();
    // G1's tree lists TREE_1 as a file, which is all that is recorded about it.
    await t.cache.putFromGatekeeper(
        G1, "tree", treePayload([{ mode: "100644", name: "not-a-file", oid: TREE_1 }]));
    expect(t.storage.gitObjectMetadata.get(TREE_1)!.type).toBe("blob");

    await t.cache.importObjects([fixture(TREE_1)]);
    let readme = parseGitTree(fixture(TREE_1).payload, TREE_1)[0];
    expect(t.storage.gitObjectMetadata.get(readme.oid)!.pullableFrom).toStrictEqual([G1]);
  });

  it("records nothing about what an object refers to when nothing is recorded about it",
      async () => {
    let t = makeCache();
    await t.cache.writeFilesAsCommit(new Map([["a.txt", "a\n"], ["dir/b.txt", "b\n"]]), {
      parents: [], author: { name: "A", email: "a@b" }, message: "m", timestamp: new Date(0),
    });
    expect(Array.from(t.storage.gitObjects.list())).toHaveLength(5);
    expect(Array.from(t.storage.gitObjectMetadata.list())).toStrictEqual([]);
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

  it("stores a put of any size, chunking a large blob", async () => {
    let t = makeCache();
    let big = new Uint8Array(9_000_000).fill(0x61);
    let oid = await t.cache.putFromGatekeeper(G1, "blob", big);
    expect(oid).toBe(gitObjectOid("blob", big));
    expect(t.storage.gitObjects.get(oid)).toHaveProperty("chunks");
    let meta = t.storage.gitObjectMetadata.get(oid)!;
    expect(meta).toMatchObject({ type: "blob", size: big.byteLength, onRemote: [G1] });
    expect(sameBytes(t.cache.readBlob(oid, big.byteLength), big)).toBe(true);
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

  it("fails a blob still missing after a successful pull, which asked for it unfiltered",
      async () => {
    let t = makeCache();
    let bigOid = "b".repeat(40);
    // G1 proves a tree referencing the blob, so the blob is pullable from G1...
    await t.cache.putFromGatekeeper(
        G1, "tree", treePayload([{ mode: "100644", name: "big.bin", oid: bigOid }]));
    // ...but serves nothing for it.
    t.sources.set(G1, async () => {});

    await expect(t.cache.ensureObject(bigOid, { type: "blob" }))
        .rejects.toThrow(/Could not pull git object .*a pull completed without providing it/);
    expect(t.pulls).toHaveLength(1);
    expect(t.pulls[0].hints.filterBlobSize).toBeUndefined();
    // Absence is gatekeeper behavior, not a measurement: nothing recorded, so the next read
    // retries (self-healing if the omission was a bug).
    expect(t.storage.gitObjectMetadata.get(bigOid)!.size).toBeUndefined();
    await expect(t.cache.ensureObject(bigOid, { type: "blob" })).rejects.toThrow(/Could not pull/);
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

describe("mergeBases", () => {
  it("is the older of two commits on one line of history", async () => {
    let t = makeCache();
    let root = await storeCommit(t, "root");
    let mid = await storeCommit(t, "mid", [root]);
    let head = await storeCommit(t, "head", [mid]);
    expect(t.cache.mergeBases(mid, head)).toStrictEqual([mid]);
    expect(t.cache.mergeBases(head, mid)).toStrictEqual([mid]);
    expect(t.cache.mergeBases(head, head)).toStrictEqual([head]);
  });

  it("is where two histories forked, not what came before", async () => {
    let t = makeCache();
    let root = await storeCommit(t, "root");
    let fork = await storeCommit(t, "fork", [root]);
    let left = await storeCommit(t, "left 2", [await storeCommit(t, "left 1", [fork])]);
    let right = await storeCommit(t, "right", [fork]);
    expect(t.cache.mergeBases(left, right)).toStrictEqual([fork]);
  });

  it("finds the release two lineages share, then the one a merge recorded", async () => {
    // The git-blueprints plan's picture. Carol's gadget took Alice's a3 and switches to Bob's
    // blueprint, whose b1 was built on a2.
    let t = makeCache();
    let a1 = await storeCommit(t, "a1");
    let a2 = await storeCommit(t, "a2", [a1]);
    let a3 = await storeCommit(t, "a3", [a2]);
    let b1 = await storeCommit(t, "b1", [await storeCommit(t, "b0"), a2]);
    let instantiated = await storeCommit(t, "i", [await storeCommit(t, "e"), a3]);
    let c1 = await storeCommit(t, "c1", [instantiated]);
    expect(t.cache.mergeBases(c1, b1)).toStrictEqual([a2]);

    // Her accept writes [c1, b1], so the next update from Bob is based on b1.
    let merged = await storeCommit(t, "m", [c1, b1]);
    let b2 = await storeCommit(t, "b2", [b1]);
    expect(t.cache.mergeBases(merged, b2)).toStrictEqual([b1]);
    // And b1 itself is now simply an ancestor.
    expect(t.cache.mergeBases(merged, b1)).toStrictEqual([b1]);
  });

  it("returns every best common ancestor of a criss-cross", async () => {
    let t = makeCache();
    let root = await storeCommit(t, "root");
    let x1 = await storeCommit(t, "x1", [root]);
    let y1 = await storeCommit(t, "y1", [root]);
    let x2 = await storeCommit(t, "x2", [x1, y1]);
    let y2 = await storeCommit(t, "y2", [y1, x1]);
    expect(t.cache.mergeBases(x2, y2).toSorted()).toStrictEqual([x1, y1].toSorted());
  });

  it("returns nothing for histories with no commit in common", async () => {
    let t = makeCache();
    let left = await storeCommit(t, "left", [await storeCommit(t, "left root")]);
    let right = await storeCommit(t, "right", [await storeCommit(t, "right root")]);
    expect(t.cache.mergeBases(left, right)).toStrictEqual([]);
  });

  it("stops where a chain leaves the cache, and never pulls", async () => {
    let t = makeCache();
    // Both sides name a parent that is not held, though G1 advertises it.
    let absent = "d".repeat(40);
    t.cache.advertiseCommit(G1, absent);
    let left = await storeCommit(t, "left", [absent]);
    let right = await storeCommit(t, "right", [absent]);
    expect(t.cache.mergeBases(left, right)).toStrictEqual([absent]);
    // What lies beyond it is unseen, so nothing connects these two.
    let other = await storeCommit(t, "other", ["e".repeat(40)]);
    expect(t.cache.mergeBases(left, other)).toStrictEqual([]);
    expect(t.pulls).toHaveLength(0);
  });

  it("throws when either commit is not a locally cached commit", async () => {
    let t = makeCache();
    let head = await storeCommit(t, "head");
    let blob = await storeLocal(t.storage, { type: "blob", payload: new Uint8Array() });
    for (let other of ["a".repeat(40), blob]) {
      expect(() => t.cache.mergeBases(head, other))
          .toThrow(`${other} is not a commit in the workspace's git cache`);
      expect(() => t.cache.mergeBases(other, head))
          .toThrow(`${other} is not a commit in the workspace's git cache`);
    }
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

  for (let { route, deliver } of ARRIVALS) {
    it(`propagates marks lazily when a marked-absent object arrives by ${route}`, async () => {
      let t = await setupCrossRemote({ materializeTree: false });
      t.cache.markPushClosure(G2, ACTION, [t.child]);
      // Only the child and the absent TREE_1 could be marked so far.
      expect(new Set(listMarks(t.storage, ACTION))).toStrictEqual(new Set([t.child, TREE_1]));

      // TREE_1 arrives: its children become visible and inherit the mark.
      await deliver(t, fixture(TREE_1));
      let marked = new Set(listMarks(t.storage, ACTION));
      for (let entry of parseGitTree(fixture(TREE_1).payload, TREE_1)) {
        expect(marked.has(entry.oid)).toBe(entry.mode !== "160000");
      }
    });
  }

  for (let { route, deliver } of ARRIVALS) {
    it(`marks through an object that arrived before its marked parent, by ${route}`,
        async () => {
      let t = await setupCrossRemote({ materializeTree: false });
      t.cache.markPushClosure(G2, ACTION, [t.child]);
      await deliver(t, fixture(DOCS_TREE));
      expect(pendingPushOf(t.storage, DOCS_FILE)).toStrictEqual([]);
      await deliver(t, fixture(TREE_1));
      expect(pendingPushOf(t.storage, DOCS_FILE))
          .toStrictEqual([{ gatekeeperId: G2, actionId: ACTION }]);
    });
  }

  it("does not mark what the destination is recorded as having, as an object arrives",
      async () => {
    let t = await setupCrossRemote({ materializeTree: false });
    t.cache.markPushClosure(G2, ACTION, [t.child]);
    // The destination turns out to have TREE_1 after all, so has everything in it.
    await t.cache.putFromGatekeeper(G2, "commit", commitPayload(TREE_1, [], "dest has tree"));
    await t.cache.importObjects([fixture(TREE_1)]);
    expect(new Set(listMarks(t.storage, ACTION))).toStrictEqual(new Set([t.child, TREE_1]));
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
    let oids = new Set((await decodePack(pack)).map(o => o.oid));
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
    let stored = await t2.cache.consumePackFromGatekeeper(G2, byteStream(pack));
    expect(new Set(stored)).toStrictEqual(oids);
    expect(t2.cache.readLocalObject(t.child)!.type).toBe("commit");
  });

  it("packs the whole closure though a marked tree arrived outside any pull", async () => {
    let t = await setupCrossRemote({ materializeTree: false });
    t.cache.markPushClosure(G2, ACTION, [t.child]);
    // The same tree turns up in, say, a blueprint. The pack still needs everything under it,
    // which is still to be pulled from where the tree was recorded as being.
    await t.cache.importObjects([fixture(TREE_1)]);

    let pack = await collect(await new GitCacheImpl(t.cache, G2, ACTION).buildPack());
    expect(await decodePack(pack)).toHaveLength(11);
    expect(t.pulls.every(pull => pull.gatekeeperId === G1)).toBe(true);
    expect(t.pulls.some(pull => pull.oids.includes(TREE_1))).toBe(false);
  });

  it("builds an empty pack when the whole declaration is already remote-known", async () => {
    let t = await setupCrossRemote();
    t.cache.markPushClosure(G2, ACTION, [t.ancestor]);  // already onRemote: nothing marked
    let pack = await collect(await new GitCacheImpl(t.cache, G2, ACTION).buildPack());
    expect(await decodePack(pack)).toStrictEqual([]);
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

const utf8 = (text: string) => new TextEncoder().encode(text);

const treeEntry = (mode: GitTreeEntry["mode"]) =>
    (name: string, oid: GitOid): GitTreeEntry => ({ mode, name, oid });
const fileAt = treeEntry("100644");
const executableAt = treeEntry("100755");
const dirAt = treeEntry("40000");
const linkAt = treeEntry("120000");
const submoduleAt = treeEntry("160000");

// Objects as an agent leaves them in the store: nothing recorded about them.
const localBlob = (t: TestCache, content: string | Uint8Array) => storeLocal(t.storage,
    { type: "blob", payload: typeof content === "string" ? utf8(content) : content });
const localTree = (t: TestCache, entries: GitTreeEntry[]) =>
    storeLocal(t.storage, { type: "tree", payload: encodeGitTree(entries) });
const localCommit = (t: TestCache, tree: GitOid, parents: GitOid[], message = "change") =>
    storeLocal(t.storage, { type: "commit", payload: commitPayload(tree, parents, message) });

// A commit G1's remote has, with its tree. The blobs and subtrees it names are G1's to put.
async function remoteCommit(t: TestCache, entries: GitTreeEntry[], parents: GitOid[] = [],
                            message = "base") {
  let tree = await t.cache.putFromGatekeeper(G1, "tree", encodeGitTree(entries));
  let commit = await t.cache.putFromGatekeeper(
      G1, "commit", commitPayload(tree, parents, message));
  return { tree, commit };
}

// A store whose remote G1 has one commit, `base`, holding README.md alone.
async function setupReview(t = makeCache()) {
  let readme = await t.cache.putFromGatekeeper(G1, "blob", utf8("# Base\n"));
  let { tree, commit } = await remoteCommit(t, [fileAt("README.md", readme)]);
  return { ...t, readme, baseTree: tree, base: commit };
}

const sizeOf = (t: TestCache, oid: GitOid) => t.cache.readLocalObject(oid)!.payload.byteLength;

// The whole review of a queued push, page by page. Checks what every review must hold: no
// call stopped at the walk's budget, the commits, the paths that send an object and the
// objects listed by id name exactly the action's marks, and reading them pulled nothing.
function readReview(t: TestCache, heads: GitOid[], actionId = ACTION) {
  let pulls = t.pulls.length;
  let page = t.cache.readPushReview(actionId, heads);
  let entries = [...page.entries];
  while (page.next !== undefined) {
    expect(page.truncated).toBeUndefined();
    page = t.cache.readPushReview(actionId, heads, page.next);
    entries.push(...page.entries);
  }
  expect(page.truncated).toBeUndefined();
  let sent = entries.flatMap(entry =>
      entry.kind !== "path" ? [entry.oid] : entry.sent ? [entry.entry!.oid] : []);
  expect([...new Set(sent)].toSorted()).toStrictEqual(listMarks(t.storage, actionId).toSorted());
  expect(page.objectCount).toBe(listMarks(t.storage, actionId).length);
  expect(t.pulls.length).toBe(pulls);
  return { entries, objectCount: page.objectCount, stackedOn: page.stackedOn };
}

function pathRow(commit: GitOid, path: string, entry: PushReviewTreeEntry | undefined,
                 parents: PushReviewParentEntry[], sent?: PushReviewSent): PushReviewEntry {
  return { kind: "path", commit, path, ...(entry && { entry }), parents, ...(sent && { sent }) };
}

const NONE: PushReviewParentEntry = { kind: "none" };
const UNKNOWN: PushReviewParentEntry = { kind: "unknown" };
const entryOf = (kind: PushReviewTreeEntry["kind"]) =>
    (oid: GitOid): PushReviewTreeEntry => ({ kind, oid });
const aFile = entryOf("file");
const aDir = entryOf("dir");

// The review's rows that are not commits, as `path kind` (or `path -` for a deletion), for
// the tests that are about which paths are listed.
const listed = (entries: PushReviewEntry[]) => entries.flatMap(entry =>
    entry.kind === "path" ? [`${entry.path} ${entry.entry?.kind ?? "-"}`]
        : entry.kind === "object" ? [`object ${entry.type}`] : []);

// Trees no encoder writes, stored as an agent can store them: nothing checks a tree's form.
const UNLISTABLE: [string, (a: GitOid, b: GitOid) => GitTreeEntry[]][] = [
  ["a name twice", (a, b) => [fileAt("notes.txt", a), fileAt("notes.txt", b)]],
  ["the name .", a => [fileAt(".", a)]],
  ["the name ..", a => [fileAt("..", a)]],
  ["entries out of order", (a, b) => [fileAt("b", a), fileAt("a", b)]],
];

describe("push review", () => {
  it("lists a file under the commit that adds it and under the one that changes it",
      async () => {
    let t = await setupReview();
    let one = await localBlob(t, "one\n"), two = await localBlob(t, "one\ntwo\n");
    let other = await localBlob(t, "untouched\n");
    let tree1 = await localTree(t,
        [fileAt("README.md", t.readme), fileAt("notes.txt", one), fileAt("other.txt", other)]);
    let tree2 = await localTree(t,
        [fileAt("README.md", t.readme), fileAt("notes.txt", two), fileAt("other.txt", other)]);
    let commit1 = await localCommit(t, tree1, [t.base], "add");
    let commit2 = await localCommit(t, tree2, [commit1], "change");
    t.cache.markPushClosure(G1, ACTION, [commit2]);

    let review = readReview(t, [commit2]);
    expect(review.entries).toStrictEqual([
      { kind: "commit", oid: commit1, parents: [t.base], size: sizeOf(t, commit1),
        text: new TextDecoder().decode(commitPayload(tree1, [t.base], "add")) },
      pathRow(commit1, "", aDir(tree1), [aDir(t.baseTree)],
          { kind: "dir", size: sizeOf(t, tree1) }),
      pathRow(commit1, "notes.txt", aFile(one), [NONE], { kind: "text", size: 4 }),
      pathRow(commit1, "other.txt", aFile(other), [NONE], { kind: "text", size: 10 }),
      { kind: "commit", oid: commit2, parents: [commit1], size: sizeOf(t, commit2),
        text: new TextDecoder().decode(commitPayload(tree2, [commit1], "change")) },
      pathRow(commit2, "", aDir(tree2), [aDir(tree1)], { kind: "dir", size: sizeOf(t, tree2) }),
      pathRow(commit2, "notes.txt", aFile(two), [aFile(one)], { kind: "text", size: 8 }),
    ]);
    expect(review.objectCount).toBe(7);
    expect(review.stackedOn).toStrictEqual([]);
  });

  it("lists a root commit's every path with no parent", async () => {
    let t = makeCache();
    let blob = await localBlob(t, "text\n");
    let docs = await localTree(t, [fileAt("guide.md", blob)]);
    let tree = await localTree(t, [dirAt("docs", docs), fileAt("a.txt", blob)]);
    let commit = await localCommit(t, tree, []);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries.slice(1)).toStrictEqual([
      pathRow(commit, "", aDir(tree), [], { kind: "dir", size: sizeOf(t, tree) }),
      pathRow(commit, "a.txt", aFile(blob), [], { kind: "text", size: 5 }),
      pathRow(commit, "docs", aDir(docs), [], { kind: "dir", size: sizeOf(t, docs) }),
      pathRow(commit, "docs/guide.md", aFile(blob), [], { kind: "text", size: 5 }),
    ]);
  });

  it("compares a merge's paths with each parent", async () => {
    let t = await setupReview();
    let ours = await localBlob(t, "ours\n"), theirs = await localBlob(t, "theirs\n");
    let merged = await localBlob(t, "ours\ntheirs\n");
    let side = async (blob: GitOid, name: string) => {
      let sub = await localTree(t, [fileAt(name, blob)]);
      let tree = await localTree(t, [
        fileAt("README.md", t.readme), fileAt("both.txt", blob), fileAt(name, blob),
        dirAt("d", sub),
      ]);
      return { sub, tree, commit: await localCommit(t, tree, [t.base], name) };
    };
    let left = await side(ours, "left.txt"), right = await side(theirs, "right.txt");
    // Each side's own file is taken as it is, and `d` holds one file of each side.
    let sub = await localTree(t, [fileAt("left.txt", ours), fileAt("right.txt", theirs)]);
    let tree = await localTree(t, [
      fileAt("README.md", t.readme), fileAt("both.txt", merged), fileAt("left.txt", ours),
      fileAt("right.txt", theirs), dirAt("d", sub),
    ]);
    let merge = await localCommit(t, tree, [left.commit, right.commit], "merge");
    t.cache.markPushClosure(G1, ACTION, [merge]);

    let review = readReview(t, [merge]);
    expect(review.entries.filter(entry => entry.kind === "commit").map(entry => entry.oid))
        .toStrictEqual([left.commit, right.commit, merge]);
    expect(review.entries.filter(entry => entry.kind === "path" && entry.commit === merge))
        .toStrictEqual([
          pathRow(merge, "", aDir(tree), [aDir(left.tree), aDir(right.tree)],
              { kind: "dir", size: sizeOf(t, tree) }),
          pathRow(merge, "both.txt", aFile(merged), [aFile(ours), aFile(theirs)],
              { kind: "text", size: 12 }),
          pathRow(merge, "d", aDir(sub), [aDir(left.sub), aDir(right.sub)],
              { kind: "dir", size: sizeOf(t, sub) }),
        ]);
  });

  it("lists what a merge lacks only where every parent has it, in name order", async () => {
    let t = await setupReview();
    let blob = await localBlob(t, "text\n");
    let sub = await localTree(t, [fileAt("x", blob)]);
    // The left side deleted README.md and the right side kept it. Both have `gone` and
    // `gone.txt`, which a tree orders one way where `gone` is a directory (left) and the
    // other way where it is a file (right).
    let leftTree = await localTree(t, [dirAt("gone", sub), fileAt("gone.txt", blob)]);
    let rightTree = await localTree(t,
        [fileAt("README.md", t.readme), fileAt("gone", blob), fileAt("gone.txt", blob)]);
    let left = await localCommit(t, leftTree, [t.base], "left");
    let right = await localCommit(t, rightTree, [t.base], "right");
    let tree = await localTree(t, [fileAt("merged.txt", blob)]);
    let merge = await localCommit(t, tree, [left, right], "merge");
    t.cache.markPushClosure(G1, ACTION, [merge]);

    expect(parseGitTree(t.cache.readLocalObject(leftTree)!.payload, leftTree)
        .map(entry => entry.name)).toStrictEqual(["gone.txt", "gone"]);
    let review = readReview(t, [merge]);
    expect(review.entries.filter(entry => entry.kind === "path" && entry.commit === left))
        .toContainEqual(pathRow(left, "README.md", undefined, [aFile(t.readme)]));
    // README.md is as the left side has it, so the merge does not list it.
    expect(review.entries.filter(entry => entry.kind === "path" && entry.commit === merge))
        .toStrictEqual([
          pathRow(merge, "", aDir(tree), [aDir(leftTree), aDir(rightTree)],
              { kind: "dir", size: sizeOf(t, tree) }),
          pathRow(merge, "merged.txt", aFile(blob), [NONE, NONE], { kind: "text", size: 5 }),
          pathRow(merge, "gone", undefined, [aDir(sub), aFile(blob)]),
          pathRow(merge, "gone.txt", undefined, [aFile(blob), aFile(blob)]),
        ]);
  });

  it("lists a change of mode alone as an entry that sends nothing", async () => {
    let t = await setupReview();
    let tree = await localTree(t, [executableAt("README.md", t.readme)]);
    let commit = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries.slice(1)).toStrictEqual([
      pathRow(commit, "", aDir(tree), [aDir(t.baseTree)], { kind: "dir", size: sizeOf(t, tree) }),
      pathRow(commit, "README.md", { kind: "executable", oid: t.readme }, [aFile(t.readme)]),
    ]);
  });

  it("says a parent's file was executable where a commit takes that mode away", async () => {
    let t = makeCache();
    let script = await t.cache.putFromGatekeeper(G1, "blob", utf8("#!/bin/sh\n"));
    let base = await remoteCommit(t, [executableAt("run.sh", script)]);
    let tree = await localTree(t, [fileAt("run.sh", script)]);
    let commit = await localCommit(t, tree, [base.commit]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries.slice(1)).toStrictEqual([
      pathRow(commit, "", aDir(tree), [aDir(base.tree)], { kind: "dir", size: sizeOf(t, tree) }),
      pathRow(commit, "run.sh", aFile(script), [{ kind: "executable", oid: script }]),
    ]);
  });

  it("lists a deleted file and a deleted directory as one row each", async () => {
    let t = makeCache();
    let blob = await t.cache.putFromGatekeeper(G1, "blob", utf8("text\n"));
    let docs = await t.cache.putFromGatekeeper(
        G1, "tree", encodeGitTree([fileAt("a.md", blob), fileAt("b.md", blob)]));
    let base = await remoteCommit(t,
        [dirAt("docs", docs), fileAt("gone.txt", blob), fileAt("kept.txt", blob)]);
    let tree = await localTree(t, [fileAt("kept.txt", blob)]);
    let commit = await localCommit(t, tree, [base.commit]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries.slice(1)).toStrictEqual([
      pathRow(commit, "", aDir(tree), [aDir(base.tree)], { kind: "dir", size: sizeOf(t, tree) }),
      pathRow(commit, "docs", undefined, [aDir(docs)]),
      pathRow(commit, "gone.txt", undefined, [aFile(blob)]),
    ]);
  });

  it("lists a file replaced by a directory, and a directory by a file, as that path's row",
      async () => {
    let t = makeCache();
    let blob = await t.cache.putFromGatekeeper(G1, "blob", utf8("text\n"));
    let was = await t.cache.putFromGatekeeper(G1, "tree", encodeGitTree([fileAt("x", blob)]));
    let base = await remoteCommit(t, [fileAt("a", blob), dirAt("b", was)]);
    let fresh = await localBlob(t, "fresh\n");
    let now = await localTree(t, [fileAt("y", fresh), fileAt("z", blob)]);
    let tree = await localTree(t, [dirAt("a", now), fileAt("b", fresh)]);
    let commit = await localCommit(t, tree, [base.commit]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries.slice(1)).toStrictEqual([
      pathRow(commit, "", aDir(tree), [aDir(base.tree)], { kind: "dir", size: sizeOf(t, tree) }),
      pathRow(commit, "a", aDir(now), [aFile(blob)], { kind: "dir", size: sizeOf(t, now) }),
      pathRow(commit, "a/y", aFile(fresh), [NONE], { kind: "text", size: 6 }),
      pathRow(commit, "a/z", aFile(blob), [NONE]),
      pathRow(commit, "b", aFile(fresh), [aDir(was)], { kind: "text", size: 6 }),
    ]);
  });

  it("compares a path with the first entry of its name in a parent's directory", async () => {
    let t = makeCache();
    let a = await t.cache.putFromGatekeeper(G1, "blob", utf8("a\n"));
    let b = await t.cache.putFromGatekeeper(G1, "blob", utf8("b\n"));
    // A parent's directory may hold a name twice: nothing checks the form of a tree the
    // remote has. A read by path resolves the first, so that is what the row is against.
    let odd = await t.cache.putFromGatekeeper(
        G1, "tree", treePayload([fileAt("notes.txt", a), fileAt("notes.txt", b)]));
    let base = await t.cache.putFromGatekeeper(G1, "commit", commitPayload(odd, [], "base"));
    let fresh = await localBlob(t, "fresh\n");
    let tree = await localTree(t, [fileAt("notes.txt", fresh)]);
    let commit = await localCommit(t, tree, [base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect((await t.cache.pathEntryAtCommit(base, "notes.txt"))?.oid).toBe(a);
    expect(readReview(t, [commit]).entries.slice(1)).toStrictEqual([
      pathRow(commit, "", aDir(tree), [aDir(odd)], { kind: "dir", size: sizeOf(t, tree) }),
      pathRow(commit, "notes.txt", aFile(fresh), [aFile(a)], { kind: "text", size: 6 }),
    ]);
  });

  it("lists a path once when a parent's directory has a name that is not one path segment",
      async () => {
    let t = await setupReview();
    let a = await localBlob(t, "a\n");
    let b = await t.cache.putFromGatekeeper(G1, "blob", utf8("b\n"));
    // No path reaches the parent's `a/b`, `.` or `..`, so none is a deletion: `a/b` is the
    // path of the file this commit adds, and a read of `.` or `..` is refused.
    let odd = await t.cache.putFromGatekeeper(G1, "tree",
        treePayload([fileAt("a/b", b), fileAt(".", b), fileAt("..", b), fileAt("kept", b)]));
    let remote = await t.cache.putFromGatekeeper(G1, "commit", commitPayload(odd, [], "odd"));
    let inner = await localTree(t, [fileAt("b", a)]);
    let tree = await localTree(t, [dirAt("a", inner)]);
    let commit = await localCommit(t, tree, [remote]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries.slice(1)).toStrictEqual([
      pathRow(commit, "", aDir(tree), [aDir(odd)], { kind: "dir", size: sizeOf(t, tree) }),
      pathRow(commit, "a", aDir(inner), [NONE], { kind: "dir", size: sizeOf(t, inner) }),
      pathRow(commit, "a/b", aFile(a), [NONE], { kind: "text", size: 2 }),
      pathRow(commit, "kept", undefined, [aFile(b)]),
    ]);
  });

  it("compares a path with a parent's entry whose name begins with a dot", async () => {
    let t = await setupReview();
    let a = await localBlob(t, "a\n");
    let b = await t.cache.putFromGatekeeper(G1, "blob", utf8("b\n"));
    // Unlike `.` and `..`, the names `...`, `.gitignore` and `.kept` are path segments like
    // any other.
    let dotted = await t.cache.putFromGatekeeper(G1, "tree", encodeGitTree(
        [fileAt("...", b), fileAt(".gitignore", b), fileAt(".kept", b)]));
    let remote = await t.cache.putFromGatekeeper(
        G1, "commit", commitPayload(dotted, [], "dotted"));
    let tree = await localTree(t, [fileAt(".gitignore", a)]);
    let commit = await localCommit(t, tree, [remote]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries.slice(1)).toStrictEqual([
      pathRow(commit, "", aDir(tree), [aDir(dotted)], { kind: "dir", size: sizeOf(t, tree) }),
      pathRow(commit, ".gitignore", aFile(a), [aFile(b)], { kind: "text", size: 2 }),
      pathRow(commit, "...", undefined, [aFile(b)]),
      pathRow(commit, ".kept", undefined, [aFile(b)]),
    ]);
  });

  it("says a parent's entry is unknown under a directory of the parent that is not held",
      async () => {
    let t = makeCache();
    let blob = await t.cache.putFromGatekeeper(G1, "blob", utf8("text\n"));
    // The remote has `docs`, and the store was never given that tree.
    let docs = gitObjectOid("tree", encodeGitTree([fileAt("old.md", blob)]));
    let base = await remoteCommit(t, [dirAt("docs", docs)]);
    let fresh = await localBlob(t, "fresh\n");
    let deep = await localTree(t, [fileAt("b.md", fresh)]);
    let now = await localTree(t, [fileAt("a.md", fresh), dirAt("deep", deep)]);
    let tree = await localTree(t, [dirAt("docs", now)]);
    let commit = await localCommit(t, tree, [base.commit]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    // Nothing says what the parent had under `docs`: no path below it is compared, at any
    // depth, and none is listed as deleted.
    expect(readReview(t, [commit]).entries.slice(1)).toStrictEqual([
      pathRow(commit, "", aDir(tree), [aDir(base.tree)], { kind: "dir", size: sizeOf(t, tree) }),
      pathRow(commit, "docs", aDir(now), [aDir(docs)], { kind: "dir", size: sizeOf(t, now) }),
      pathRow(commit, "docs/a.md", aFile(fresh), [UNKNOWN], { kind: "text", size: 6 }),
      pathRow(commit, "docs/deep", aDir(deep), [UNKNOWN], { kind: "dir", size: sizeOf(t, deep) }),
      pathRow(commit, "docs/deep/b.md", aFile(fresh), [UNKNOWN], { kind: "text", size: 6 }),
    ]);
  });

  it("says a parent's entry is unknown under a directory entry of the parent that names no tree",
      async () => {
    let t = makeCache();
    // The parent's `d` is a directory entry that names the empty blob, whose payload would
    // parse as a directory with nothing in it.
    let empty = await t.cache.putFromGatekeeper(G1, "blob", new Uint8Array());
    let base = await remoteCommit(t, [dirAt("d", empty)]);
    let blob = await localBlob(t, "x\n");
    let sub = await localTree(t, [fileAt("x", blob)]);
    let tree = await localTree(t, [dirAt("d", sub)]);
    let commit = await localCommit(t, tree, [base.commit]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries.slice(1)).toStrictEqual([
      pathRow(commit, "", aDir(tree), [aDir(base.tree)], { kind: "dir", size: sizeOf(t, tree) }),
      pathRow(commit, "d", aDir(sub), [aDir(empty)], { kind: "dir", size: sizeOf(t, sub) }),
      pathRow(commit, "d/x", aFile(blob), [UNKNOWN], { kind: "text", size: 2 }),
    ]);
  });

  it("says a parent's entry is unknown under a directory of the parent that does not parse",
      async () => {
    let t = makeCache();
    // The parent's `docs` holds a name that is not UTF-8, so its entries cannot be named.
    await t.cache.putFromGatekeeper(G1, "tree", fixture(BAD_NAME_TREE).payload);
    let base = await remoteCommit(t, [dirAt("docs", BAD_NAME_TREE)]);
    let blob = await localBlob(t, "x\n");
    let docs = await localTree(t, [fileAt("x", blob)]);
    let tree = await localTree(t, [dirAt("docs", docs)]);
    let commit = await localCommit(t, tree, [base.commit]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries.slice(1)).toStrictEqual([
      pathRow(commit, "", aDir(tree), [aDir(base.tree)], { kind: "dir", size: sizeOf(t, tree) }),
      pathRow(commit, "docs", aDir(docs), [aDir(BAD_NAME_TREE)],
          { kind: "dir", size: sizeOf(t, docs) }),
      pathRow(commit, "docs/x", aFile(blob), [UNKNOWN], { kind: "text", size: 2 }),
    ]);
  });

  it("lists what a merge lacks beside a parent whose directory is not held", async () => {
    let t = makeCache();
    let blob = await t.cache.putFromGatekeeper(G1, "blob", utf8("text\n"));
    // The remote has `docs` on both sides, and the store was never given the left side's.
    let lost = gitObjectOid("tree", encodeGitTree([fileAt("left.md", blob)]));
    let left = await remoteCommit(t, [dirAt("docs", lost)], [], "left");
    let held = await t.cache.putFromGatekeeper(
        G1, "tree", encodeGitTree([fileAt("a.md", blob), fileAt("old.md", blob)]));
    let right = await remoteCommit(t, [dirAt("docs", held)], [], "right");
    let docs = await localTree(t, [fileAt("a.md", blob)]);
    let tree = await localTree(t, [dirAt("docs", docs)]);
    let merge = await localCommit(t, tree, [left.commit, right.commit], "merge");
    t.cache.markPushClosure(G1, ACTION, [merge]);

    // a.md is as the right side has it, so it is not listed. old.md is gone from what the
    // right side has, and nothing says whether the left side had it.
    expect(readReview(t, [merge]).entries.slice(1)).toStrictEqual([
      pathRow(merge, "", aDir(tree), [aDir(left.tree), aDir(right.tree)],
          { kind: "dir", size: sizeOf(t, tree) }),
      pathRow(merge, "docs", aDir(docs), [aDir(lost), aDir(held)],
          { kind: "dir", size: sizeOf(t, docs) }),
      pathRow(merge, "docs/old.md", undefined, [UNKNOWN, aFile(blob)]),
    ]);
  });

  it("lists a symbolic link where it is added, with its target when the push sends it",
      async () => {
    let t = await setupReview();
    let target = await localBlob(t, "README.md");
    let tree1 = await localTree(t, [
      fileAt("README.md", t.readme), linkAt("sent-link", target), linkAt("held-link", t.readme),
    ]);
    let commit1 = await localCommit(t, tree1, [t.base], "links");
    let other = await localBlob(t, "other\n");
    let tree2 = await localTree(t, [
      fileAt("README.md", t.readme), linkAt("sent-link", target), linkAt("held-link", t.readme),
      fileAt("other.txt", other),
    ]);
    let commit2 = await localCommit(t, tree2, [commit1], "more");
    t.cache.markPushClosure(G1, ACTION, [commit2]);

    let review = readReview(t, [commit2]);
    expect(review.entries.filter(entry => entry.kind === "path")).toStrictEqual([
      pathRow(commit1, "", aDir(tree1), [aDir(t.baseTree)],
          { kind: "dir", size: sizeOf(t, tree1) }),
      pathRow(commit1, "held-link", { kind: "symlink", oid: t.readme }, [NONE]),
      pathRow(commit1, "sent-link", { kind: "symlink", oid: target }, [NONE],
          { kind: "text", size: 9 }),
      pathRow(commit2, "", aDir(tree2), [aDir(tree1)], { kind: "dir", size: sizeOf(t, tree2) }),
      pathRow(commit2, "other.txt", aFile(other), [NONE], { kind: "text", size: 6 }),
    ]);
  });

  it("says a symbolic link whose target is not text is binary", async () => {
    let t = await setupReview();
    let target = await localBlob(t, Uint8Array.of(0x61, 0xff, 0x62));
    let tree = await localTree(t, [fileAt("README.md", t.readme), linkAt("link", target)]);
    let commit = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries.at(-1)).toStrictEqual(
        pathRow(commit, "link", { kind: "symlink", oid: target }, [NONE],
            { kind: "binary", size: 3 }));
  });

  it("says a symbolic link that names a directory is mistyped, and one over the buffered " +
      "size large", async () => {
    let t = await setupReview();
    let blob = await localBlob(t, "under\n");
    let sub = await localTree(t, [fileAt("x", blob)]);
    let long = t.cache.writeBlob(new Uint8Array(MAX_BUFFERED_BLOB_SIZE + 1).fill(0x61)).oid;
    let tree = await localTree(t,
        [fileAt("README.md", t.readme), linkAt("link", sub), linkAt("long", long)]);
    let commit = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries.slice(2)).toStrictEqual([
      pathRow(commit, "link", { kind: "symlink", oid: sub }, [NONE],
          { kind: "mistyped", type: "tree", size: sizeOf(t, sub) }),
      pathRow(commit, "long", { kind: "symlink", oid: long }, [NONE],
          { kind: "large", size: MAX_BUFFERED_BLOB_SIZE + 1 }),
      { kind: "object", oid: blob, type: "blob", size: 6 },
    ]);
  });

  it("lists a submodule entry that is added or changed, and never as sent", async () => {
    let t = makeCache();
    let blob = await t.cache.putFromGatekeeper(G1, "blob", utf8("text\n"));
    let other = "2".repeat(40);
    let base = await remoteCommit(t,
        [fileAt("a.txt", blob), submoduleAt("changed", GITLINK_TARGET),
         submoduleAt("kept", GITLINK_TARGET)]);
    let sub = await localTree(t, [submoduleAt("nested", other)]);
    let tree = await localTree(t, [
      fileAt("a.txt", blob), submoduleAt("added", other), submoduleAt("changed", other),
      submoduleAt("kept", GITLINK_TARGET), dirAt("lib", sub),
    ]);
    let commit = await localCommit(t, tree, [base.commit]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    let gitlink = entryOf("submodule");
    expect(readReview(t, [commit]).entries.slice(1)).toStrictEqual([
      pathRow(commit, "", aDir(tree), [aDir(base.tree)], { kind: "dir", size: sizeOf(t, tree) }),
      pathRow(commit, "added", gitlink(other), [NONE]),
      pathRow(commit, "changed", gitlink(other), [gitlink(GITLINK_TARGET)]),
      pathRow(commit, "lib", aDir(sub), [NONE], { kind: "dir", size: sizeOf(t, sub) }),
      pathRow(commit, "lib/nested", gitlink(other), [NONE]),
    ]);
  });

  it("lists a submodule entry that names an object the push sends as sending nothing",
      async () => {
    let t = await setupReview();
    let blob = await localBlob(t, "added\n");
    let tree1 = await localTree(t, [fileAt("README.md", t.readme), fileAt("a.txt", blob)]);
    let commit1 = await localCommit(t, tree1, [t.base], "add");
    // The entries name this push's own commit and a file it sends. Neither is sent for them.
    let tree2 = await localTree(t, [
      fileAt("README.md", t.readme), fileAt("a.txt", blob), submoduleAt("mod-blob", blob),
      submoduleAt("mod-commit", commit1),
    ]);
    let commit2 = await localCommit(t, tree2, [commit1], "submodules");
    t.cache.markPushClosure(G1, ACTION, [commit2]);

    let gitlink = entryOf("submodule");
    let review = readReview(t, [commit2]);
    expect(review.entries.filter(entry => entry.kind === "path" && entry.commit === commit2))
        .toStrictEqual([
          pathRow(commit2, "", aDir(tree2), [aDir(tree1)], { kind: "dir", size: sizeOf(t, tree2) }),
          pathRow(commit2, "mod-blob", gitlink(blob), [NONE]),
          pathRow(commit2, "mod-commit", gitlink(commit1), [NONE]),
        ]);
  });

  it("lists by id an object the push sends that only a submodule entry names", async () => {
    let t = await setupReview();
    let stray = await localBlob(t, "stray\n");
    let tree = await localTree(t, [fileAt("README.md", t.readme), submoduleAt("mod", stray)]);
    let commit = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);
    // The walk marks nothing a submodule entry names: only a mark made some other way sends it.
    t.storage.gitObjectMetadata.put({
      oid: stray, type: "blob", onRemote: [], pullableFrom: [],
      pendingPush: [{ gatekeeperId: G1, actionId: ACTION }],
    });

    expect(readReview(t, [commit]).entries.slice(1)).toStrictEqual([
      pathRow(commit, "", aDir(tree), [aDir(t.baseTree)], { kind: "dir", size: sizeOf(t, tree) }),
      pathRow(commit, "mod", { kind: "submodule", oid: stray }, [NONE]),
      { kind: "object", oid: stray, type: "blob", size: 6 },
    ]);
  });

  it("says what each file it sends is, without reading one over the buffered size", async () => {
    let t = await setupReview();
    let exact = new Uint8Array(MAX_BUFFERED_BLOB_SIZE).fill(0x61);
    let blobs = {
      nul: await localBlob(t, Uint8Array.of(0x61, 0, 0x62)),
      invalid: await localBlob(t, Uint8Array.of(0x61, 0xff, 0xfe)),
      exact: await localBlob(t, exact),
      over: t.cache.writeBlob(new Uint8Array(MAX_BUFFERED_BLOB_SIZE + 1).fill(0x62)).oid,
      absent: gitObjectOid("blob", utf8("never stored\n")),
      twice: await localBlob(t, "twice\n"),
    };
    let absentTree = gitObjectOid("tree", encodeGitTree([fileAt("x", blobs.twice)]));
    let tree = await localTree(t, [
      fileAt("README.md", t.readme), fileAt("a-nul", blobs.nul),
      fileAt("b-invalid", blobs.invalid), fileAt("c-exact", blobs.exact),
      fileAt("d-over", blobs.over), fileAt("e-absent", blobs.absent),
      fileAt("f-twice", blobs.twice), fileAt("g-twice", blobs.twice),
      dirAt("h-absent", absentTree), dirAt("i-empty", EMPTY_TREE_OID),
    ]);
    let commit = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    let reads = countReads(t);
    let review = readReview(t, [commit]);
    expect(review.entries.slice(2)).toStrictEqual([
      pathRow(commit, "a-nul", aFile(blobs.nul), [NONE], { kind: "binary", size: 3 }),
      pathRow(commit, "b-invalid", aFile(blobs.invalid), [NONE], { kind: "binary", size: 3 }),
      pathRow(commit, "c-exact", aFile(blobs.exact), [NONE],
          { kind: "text", size: MAX_BUFFERED_BLOB_SIZE }),
      pathRow(commit, "d-over", aFile(blobs.over), [NONE],
          { kind: "large", size: MAX_BUFFERED_BLOB_SIZE + 1 }),
      pathRow(commit, "e-absent", aFile(blobs.absent), [NONE], { kind: "absent" }),
      pathRow(commit, "f-twice", aFile(blobs.twice), [NONE], { kind: "text", size: 6 }),
      pathRow(commit, "g-twice", aFile(blobs.twice), [NONE], { kind: "text", size: 6 }),
      pathRow(commit, "h-absent", aDir(absentTree), [NONE], { kind: "absent" }),
      pathRow(commit, "i-empty", aDir(EMPTY_TREE_OID), [NONE], { kind: "dir", size: 0 }),
    ]);
    // The large file's index row says how large it is; none of its chunks was read.
    let chunks = chunksOf(t, blobs.over);
    expect(chunks.length).toBeGreaterThan(1);
    expect(reads.filter(oid => chunks.includes(oid))).toStrictEqual([]);
  });

  for (let [what, entries] of UNLISTABLE) {
    it(`does not list a directory with ${what}`, async () => {
      let t = await setupReview();
      let a = await localBlob(t, "a\n"), b = await localBlob(t, "b\n");
      let payload = treePayload(entries(a, b));
      let [odd] = await t.cache.consumePackFromGatekeeper(null,
          byteStream(concatBytes(await buildPackBytes([{ type: "tree", payload }]))));
      let tree = await localTree(t, [fileAt("README.md", t.readme), dirAt("odd", odd)]);
      let commit = await localCommit(t, tree, [t.base]);
      t.cache.markPushClosure(G1, ACTION, [commit]);

      let review = readReview(t, [commit]);
      expect(review.entries.slice(2)).toStrictEqual([
        pathRow(commit, "odd", aDir(odd), [NONE],
            { kind: "unlistable", size: payload.byteLength }),
        ...[...new Set(entries(a, b).map(entry => entry.oid))].toSorted()
            .map(oid => ({ kind: "object", oid, type: "blob", size: 2 })),
      ]);
    });
  }

  it("does not list a directory with a name that is not UTF-8", async () => {
    let t = await setupReview();
    await storeLocal(t.storage, fixture(BAD_NAME_TREE));
    let [{ oid: blob }] = scanGitTree(fixture(BAD_NAME_TREE).payload);
    await storeLocal(t.storage, fixture(blob));
    let tree = await localTree(t, [fileAt("README.md", t.readme), dirAt("odd", BAD_NAME_TREE)]);
    let commit = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries.slice(2)).toStrictEqual([
      pathRow(commit, "odd", aDir(BAD_NAME_TREE), [NONE],
          { kind: "unlistable", size: sizeOf(t, BAD_NAME_TREE) }),
      { kind: "object", oid: blob, type: "blob", size: sizeOf(t, blob) },
    ]);
  });

  it("does not list a root directory with a name holding a slash", async () => {
    let t = await setupReview();
    let a = await localBlob(t, "a\n"), b = await localBlob(t, "b\n");
    let inner = await localTree(t, [fileAt("b", a)]);
    // `a/b` names two entries here: the root's own, and the one in the directory `a`.
    let payload = treePayload([fileAt("a/b", b), dirAt("a", inner)]);
    let tree = await storeLocal(t.storage, { type: "tree", payload });
    let commit = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries.slice(1)).toStrictEqual([
      pathRow(commit, "", aDir(tree), [aDir(t.baseTree)],
          { kind: "unlistable", size: payload.byteLength }),
      ...[
        { kind: "object", oid: a, type: "blob", size: 2 },
        { kind: "object", oid: b, type: "blob", size: 2 },
        { kind: "object", oid: inner, type: "tree", size: sizeOf(t, inner) },
      ].toSorted((x, y) => x.oid < y.oid ? -1 : 1),
    ]);
  });

  it("says a commit's tree that is a blob is mistyped", async () => {
    let t = await setupReview();
    let blob = await localBlob(t, "not a tree\n");
    let commit = await localCommit(t, blob, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries.slice(1)).toStrictEqual([
      pathRow(commit, "", aDir(blob), [aDir(t.baseTree)],
          { kind: "mistyped", type: "blob", size: 11 }),
    ]);
  });

  it("says a directory entry that names a blob is mistyped", async () => {
    let t = await setupReview();
    let blob = await localBlob(t, "not a tree\n");
    let tree = await storeLocal(t.storage,
        { type: "tree", payload: treePayload([fileAt("README.md", t.readme), dirAt("d", blob)]) });
    let commit = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries.slice(2)).toStrictEqual([
      pathRow(commit, "d", aDir(blob), [NONE], { kind: "mistyped", type: "blob", size: 11 }),
    ]);
  });

  it("says a file entry that names a tree is mistyped, and lists what is under it by id",
      async () => {
    let t = await setupReview();
    let blob = await localBlob(t, "under\n");
    let inner = await localTree(t, [fileAt("x", blob)]);
    let tree = await localTree(t, [fileAt("README.md", t.readme), fileAt("f", inner)]);
    let commit = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries.slice(2)).toStrictEqual([
      pathRow(commit, "f", aFile(inner), [NONE],
          { kind: "mistyped", type: "tree", size: sizeOf(t, inner) }),
      { kind: "object", oid: blob, type: "blob", size: 6 },
    ]);
  });

  it("says a file entry that names a commit is mistyped, and lists that commit's content by id",
      async () => {
    let t = await setupReview();
    let blob = await localBlob(t, "under\n");
    let inner = await localTree(t, [fileAt("x", blob)]);
    let hidden = await localCommit(t, inner, [], "hidden");
    let tree = await localTree(t, [fileAt("README.md", t.readme), fileAt("f", hidden)]);
    let commit = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    let review = readReview(t, [commit]);
    expect(review.entries.filter(entry => entry.kind === "commit").map(entry => entry.oid))
        .toStrictEqual([commit]);
    expect(review.entries.slice(2)).toStrictEqual([
      pathRow(commit, "f", aFile(hidden), [NONE],
          { kind: "mistyped", type: "commit", size: sizeOf(t, hidden) }),
      ...[
        { kind: "object", oid: blob, type: "blob", size: 6 },
        { kind: "object", oid: inner, type: "tree", size: sizeOf(t, inner) },
      ].toSorted((x, y) => x.oid < y.oid ? -1 : 1),
    ]);
  });

  it("lists a marked parent that is not a commit by id, as what it is", async () => {
    let t = await setupReview();
    let blob = await localBlob(t, "not a commit\n");
    let commit = await localCommit(t, t.baseTree, [blob]);
    // Straight to the marks: the ancestry check refuses this push before it is queued.
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries).toStrictEqual([
      { kind: "commit", oid: commit, parents: [blob], size: sizeOf(t, commit),
        text: new TextDecoder().decode(commitPayload(t.baseTree, [blob], "change")) },
      pathRow(commit, "", aDir(t.baseTree), [UNKNOWN]),
      { kind: "object", oid: blob, type: "blob", size: 13 },
    ]);
  });

  it("lists the root alone when a commit returns to a tree the remote has", async () => {
    let t = await setupReview();
    let blob = await t.cache.putFromGatekeeper(G1, "blob", utf8("later\n"));
    let later = await remoteCommit(t, [fileAt("README.md", blob)], [t.base], "later");
    let revert = await localCommit(t, t.baseTree, [later.commit], "revert");
    let empty = await localCommit(t, t.baseTree, [revert], "empty");
    t.cache.markPushClosure(G1, ACTION, [empty]);

    expect(readReview(t, [empty]).entries).toStrictEqual([
      expect.objectContaining({ kind: "commit", oid: revert }),
      pathRow(revert, "", aDir(t.baseTree), [aDir(later.tree)]),
      expect.objectContaining({ kind: "commit", oid: empty }),
    ]);
  });

  it("lists nothing for a push whose head the remote already has", async () => {
    let t = await setupReview();
    t.cache.markPushClosure(G1, ACTION, [t.base]);
    expect(t.cache.readPushReview(ACTION, [t.base]))
        .toStrictEqual({ entries: [], objectCount: 0, stackedOn: [] });
  });

  it("returns a commit's payload as written, or says it is unreadable", async () => {
    let t = makeCache();
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);
    await storeLocal(t.storage, fixture(GPGSIG_COMMIT));
    let headers = `tree ${TREE_1}\nparent ${GPGSIG_COMMIT}\n` +
        "author A U Thor <a@example.com> 1700000000 -0730\n" +
        "committer C O Mitter <c@example.com> 1700000001 +0100\n";
    let commits = [GPGSIG_COMMIT];
    let payloads = [
      utf8(`${headers}encoding UTF-8\nx-extra one\n two\n\n\n\n  subject \r\nbody\r\n\n\n`),
      utf8(`${headers}\n${"word ".repeat(100 * 1024 / 5)}\n`),
      concatBytes([utf8(`${headers}\ninvalid `), Uint8Array.of(0xff, 0x0a)]),
      utf8(`${headers}\nnul \0\n`),
      utf8(`${headers}\n${"x".repeat(MAX_BUFFERED_BLOB_SIZE)}\n`),
    ];
    for (let payload of payloads) {
      commits.push(await storeLocal(t.storage, { type: "commit", payload }));
    }
    t.cache.markPushClosure(G1, ACTION, commits);

    let text = (payload: Uint8Array) => new TextDecoder().decode(payload);
    let row = (index: number, readable: boolean) => ({
      kind: "commit", oid: commits[index + 1], parents: [GPGSIG_COMMIT],
      size: payloads[index].byteLength, ...(readable && { text: text(payloads[index]) }),
    });
    expect(readReview(t, commits).entries).toStrictEqual([
      { kind: "commit", oid: GPGSIG_COMMIT, parents: [COMMIT_1],
        size: fixture(GPGSIG_COMMIT).payload.byteLength,
        text: text(fixture(GPGSIG_COMMIT).payload) },
      row(0, true), row(1, true), row(2, false), row(3, false), row(4, false),
    ]);
    expect(text(fixture(GPGSIG_COMMIT).payload)).toMatch(/\ngpgsig -----BEGIN[^]*\n \n/);
  });

  it("lists a marked commit the store does not hold with no size and no parents", async () => {
    let t = await setupReview();
    let absent = gitObjectOid("commit", commitPayload(t.baseTree, [t.base], "never stored"));
    let commit = await localCommit(t, t.baseTree, [absent]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries).toStrictEqual([
      { kind: "commit", oid: absent, parents: [] },
      expect.objectContaining({ kind: "commit", oid: commit, parents: [absent] }),
      pathRow(commit, "", aDir(t.baseTree), [UNKNOWN]),
    ]);
  });

  it("lists by id a marked object that no commit or path accounts for", async () => {
    let t = await setupReview();
    let blob = await localBlob(t, "added\n");
    let tree = await localTree(t, [fileAt("README.md", t.readme), fileAt("a.txt", blob)]);
    let commit = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);
    let stray = await localBlob(t, "stray\n");
    t.storage.gitObjectMetadata.put({
      oid: stray, type: "tree", onRemote: [], pullableFrom: [],
      pendingPush: [{ gatekeeperId: G1, actionId: ACTION }],
    });

    expect(readReview(t, [commit]).entries.slice(3))
        .toStrictEqual([{ kind: "object", oid: stray, type: "blob", size: 6 }]);
  });

  it("lists by id an object the store does not hold, as what its referrer says it is",
      async () => {
    let t = await setupReview();
    let blob = await localBlob(t, "a\n");
    let absent = gitObjectOid("tree", encodeGitTree([fileAt("x", blob)]));
    // A directory whose entries are out of order is not opened, so what it names is listed
    // by id: a subdirectory the store lacks, and a file.
    let payload = treePayload([dirAt("b", absent), fileAt("a", blob)]);
    let [odd] = await t.cache.consumePackFromGatekeeper(null,
        byteStream(concatBytes(await buildPackBytes([{ type: "tree", payload }]))));
    let tree = await localTree(t, [fileAt("README.md", t.readme), dirAt("odd", odd)]);
    let commit = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    expect(readReview(t, [commit]).entries.slice(2)).toStrictEqual([
      pathRow(commit, "odd", aDir(odd), [NONE], { kind: "unlistable", size: payload.byteLength }),
      ...[
        { kind: "object", oid: absent, type: "tree" },
        { kind: "object", oid: blob, type: "blob", size: 2 },
      ].toSorted((a, b) => a.oid < b.oid ? -1 : 1),
    ]);
  });

  for (let other of [G1, G2]) {
    it(`says which earlier push a push is stacked on, on connection ${other}`, async () => {
      let t = await setupReview();
      // Both remotes have the base.
      await t.cache.putFromGatekeeper(G2, "blob", utf8("# Base\n"));
      await t.cache.putFromGatekeeper(G2, "tree", encodeGitTree([fileAt("README.md", t.readme)]));
      await t.cache.putFromGatekeeper(G2, "commit", commitPayload(t.baseTree, [], "base"));
      let blob = await localBlob(t, "first\n");
      let tree = await localTree(t, [fileAt("README.md", t.readme), fileAt("a.txt", blob)]);
      let first = await localCommit(t, tree, [t.base], "first");
      let second = await localCommit(t, t.baseTree, [first], "second");
      t.cache.markPushClosure(G1, ACTION, [first]);
      t.cache.markPushClosure(other, OTHER_ACTION, [second]);

      let earlier = readReview(t, [first]);
      expect(earlier.stackedOn).toStrictEqual([]);
      let later = readReview(t, [second], OTHER_ACTION);
      expect(later.stackedOn).toStrictEqual([ACTION]);
      expect(later.entries.slice(0, earlier.entries.length)).toStrictEqual(earlier.entries);
      expect(later.entries.length).toBeGreaterThan(earlier.entries.length);

      // Rejecting the earlier push takes nothing out of the later one.
      t.cache.clearPushMarks(ACTION);
      expect(readReview(t, [second], OTHER_ACTION)).toStrictEqual({ ...later, stackedOn: [] });
    });
  }

  it("names the earlier pushes a push is stacked on in ascending order", async () => {
    let t = await setupReview();
    let blob = await localBlob(t, "first\n");
    let tree = await localTree(t, [fileAt("README.md", t.readme), fileAt("a.txt", blob)]);
    let first = await localCommit(t, tree, [t.base], "first");
    let second = await localCommit(t, t.baseTree, [first], "second");
    // The higher action marks the shared objects before the lower one does.
    let [low, high] = [ACTION, OTHER_ACTION].toSorted((a, b) => a - b);
    t.cache.markPushClosure(G1, high, [first]);
    t.cache.markPushClosure(G1, low, [first]);
    t.cache.markPushClosure(G1, high + 1, [second]);

    expect(readReview(t, [second], high + 1).stackedOn).toStrictEqual([low, high]);
  });

  // A commit whose payload is exactly `size` bytes.
  function paddedCommit(tree: GitOid, parents: GitOid[], size: number): Uint8Array {
    let bare = commitPayload(tree, parents, "").byteLength;
    return commitPayload(tree, parents, "x".repeat(size - bare));
  }

  it("pages a long review, each page reading the text of its own files alone", async () => {
    let t = await setupReview();
    let blobs: GitOid[] = [];
    for (let i = 0; i < PUSH_REVIEW_PAGE_SIZE + 20; i++) blobs.push(await localBlob(t, `${i}\n`));
    let name = (i: number) => `f${String(i).padStart(3, "0")}`;
    let tree = await localTree(t,
        [fileAt("README.md", t.readme), ...blobs.map((oid, i) => fileAt(name(i), oid))]);
    let commit = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    let first = t.cache.readPushReview(ACTION, [commit]);
    expect(first.entries.length).toBe(PUSH_REVIEW_PAGE_SIZE);
    expect(first.next).toBe(PUSH_REVIEW_PAGE_SIZE);
    let reads = countReads(t);
    let second = t.cache.readPushReview(ACTION, [commit], first.next);
    expect(second.next).toBeUndefined();
    expect(second.objectCount).toBe(first.objectCount);
    expect(first.objectCount).toBe(listMarks(t.storage, ACTION).length);
    // The commit and the root, then the files in order: the second page starts where the
    // first ended.
    expect([...first.entries, ...second.entries].slice(2)).toStrictEqual(blobs.map((oid, i) =>
        pathRow(commit, name(i), aFile(oid), [NONE], { kind: "text", size: `${i}\n`.length })));
    // It fetches a file of the first page once, for its size, and its own twice: the second
    // time for their text.
    let fetches = (oid: GitOid) => reads.filter(read => read === oid).length;
    expect(blobs.map(fetches)).toStrictEqual(
        blobs.map((_, i) => i < PUSH_REVIEW_PAGE_SIZE - 2 ? 1 : 2));
    expect(readReview(t, [commit]).entries).toStrictEqual([...first.entries, ...second.entries]);
  });

  it("leaves `next` off a last page that is exactly full", async () => {
    let t = await setupReview();
    // The commit, the root and as many files as fill two pages exactly.
    let blobs: GitOid[] = [];
    for (let i = 0; i < 2 * PUSH_REVIEW_PAGE_SIZE - 2; i++) {
      blobs.push(await localBlob(t, `${i}\n`));
    }
    let tree = await localTree(t, [
      fileAt("README.md", t.readme),
      ...blobs.map((oid, i) => fileAt(`f${String(i).padStart(3, "0")}`, oid)),
    ]);
    let commit = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    let first = t.cache.readPushReview(ACTION, [commit]);
    expect(first.next).toBe(PUSH_REVIEW_PAGE_SIZE);
    let second = t.cache.readPushReview(ACTION, [commit], first.next);
    expect(second.entries.length).toBe(PUSH_REVIEW_PAGE_SIZE);
    expect(second.next).toBeUndefined();
  });

  it("ends a page once the files read for it pass the response budget", async () => {
    let t = await setupReview();
    // Every other file is not text. It is read whole to find that out, so it counts the same.
    let blobs: GitOid[] = [];
    for (let i = 0; i < 20; i++) {
      let content = new Uint8Array(MAX_BUFFERED_BLOB_SIZE).fill(0x41 + i);
      if (i % 2 === 1) content[0] = 0;
      blobs.push(await localBlob(t, content));
    }
    let tree = await localTree(t,
        [fileAt("README.md", t.readme), ...blobs.map((oid, i) => fileAt(`f${i + 10}`, oid))]);
    let commit = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    // The page holds the file that takes it past the budget, and no more.
    let files = Math.ceil(READ_FILES_RESPONSE_BUDGET / MAX_BUFFERED_BLOB_SIZE);
    let reads = countReads(t);
    let first = t.cache.readPushReview(ACTION, [commit]);
    expect(first.entries.length).toBe(2 + files);
    expect(first.next).toBe(2 + files);
    expect(first.entries.slice(2).map(entry => entry.kind === "path" && entry.sent?.kind))
        .toStrictEqual(blobs.slice(0, files).map((_, i) => i % 2 === 1 ? "binary" : "text"));
    // Each file of the page is fetched for its size and then for its text, and the file
    // after them for its size alone: the rest are not touched.
    let fetched = reads.filter(oid => blobs.includes(oid));
    expect(new Set(fetched).size).toBe(files + 1);
    expect(fetched.length).toBe(2 * files + 1);
    expect(readReview(t, [commit]).entries.length).toBe(2 + blobs.length);
  });

  it("counts nothing toward a page for a file over the buffered size, which it does not read",
      async () => {
    let t = await setupReview();
    // More such files than the budget holds, were their sizes counted.
    let count = Math.ceil(READ_FILES_RESPONSE_BUDGET / MAX_BUFFERED_BLOB_SIZE) + 2;
    let blobs = Array.from({ length: count }, (_, i) =>
        t.cache.writeBlob(new Uint8Array(MAX_BUFFERED_BLOB_SIZE + 1).fill(65 + i)).oid);
    let tree = await localTree(t, [
      fileAt("README.md", t.readme),
      ...blobs.map((oid, i) => fileAt(`big${String(i).padStart(2, "0")}`, oid)),
    ]);
    let commit = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    let page = t.cache.readPushReview(ACTION, [commit]);
    expect(page.next).toBeUndefined();
    expect(page.entries.slice(2).map(entry => entry.kind === "path" && entry.sent?.kind))
        .toStrictEqual(blobs.map(() => "large"));
  });

  it("ends a page once the parents its entries name pass the response budget", async () => {
    let t = makeCache(makeLargeStorage());
    let before = await t.cache.putFromGatekeeper(G1, "blob", utf8("before\n"));
    let paths = Array.from({ length: 150 }, (_, i) => `f${i + 100}`);
    let baseTree = await t.cache.putFromGatekeeper(
        G1, "tree", encodeGitTree(paths.map(path => fileAt(path, before))));
    let parents: GitOid[] = [];
    for (let i = 0; i < 2000; i++) {
      parents.push(await t.cache.putFromGatekeeper(
          G1, "commit", commitPayload(baseTree, [], `side ${i}`)));
    }
    let after = await localBlob(t, "after\n");
    let tree = await localTree(t, paths.map(path => fileAt(path, after)));
    let merge = await localCommit(t, tree, parents, "octopus");
    t.cache.markPushClosure(G1, ACTION, [merge]);

    let first = t.cache.readPushReview(ACTION, [merge]);
    expect(first.entries.length).toBeLessThan(PUSH_REVIEW_PAGE_SIZE);
    expect(first.next).toBe(first.entries.length);
    // Every parent an entry names is at least an oid in the response.
    let named = first.entries.reduce((sum, entry) =>
        sum + (entry.kind === "object" ? 0 : entry.parents.length), 0);
    expect((named - parents.length) * 40).toBeLessThanOrEqual(READ_FILES_RESPONSE_BUDGET);
    let review = readReview(t, [merge]);
    expect(review.entries.length).toBe(2 + paths.length);
    expect(review.entries[2]).toStrictEqual(pathRow(merge, paths[0], aFile(after),
        parents.map(() => aFile(before)), { kind: "text", size: 6 }));

    // A commit's own parents count as a path's do. Each of these merges changes no file, so
    // it is one row: its payload, and at least an oid for each parent it names.
    let merges = [await localCommit(t, baseTree, parents, "merge 000")];
    let least = sizeOf(t, merges[0]) + parents.length * 40;
    let fit = Math.floor(READ_FILES_RESPONSE_BUDGET / least) + 1;
    while (merges.length <= fit) {
      merges.push(await localCommit(t, baseTree, parents,
          `merge ${String(merges.length).padStart(3, "0")}`));
    }
    t.cache.markPushClosure(G1, OTHER_ACTION, merges);
    let page = t.cache.readPushReview(OTHER_ACTION, merges);
    expect(page.entries.length).toBeLessThanOrEqual(fit);
    expect(page.next).toBe(page.entries.length);
    expect(page.entries.map(entry => entry.kind === "commit" && entry.oid))
        .toStrictEqual(merges.slice(0, page.entries.length));
  });

  it("ends a page once the commits read for it pass the response budget", async () => {
    let t = await setupReview();
    // The first three are a byte over the size a commit is read at: they are not read, and
    // count as their rows alone.
    let unread = 3, commits: GitOid[] = [];
    for (let i = 0; i < unread + 10; i++) {
      commits.push(await storeLocal(t.storage, {
        type: "commit",
        payload: paddedCommit(t.baseTree, [commits.at(-1) ?? t.base],
            MAX_BUFFERED_BLOB_SIZE + (i < unread ? 1 : 0)),
      }));
    }
    t.cache.markPushClosure(G1, ACTION, [commits.at(-1)!]);

    let first = t.cache.readPushReview(ACTION, [commits.at(-1)!]);
    let held = unread + Math.ceil(READ_FILES_RESPONSE_BUDGET / MAX_BUFFERED_BLOB_SIZE);
    expect(held).toBeLessThan(commits.length);
    expect(first.entries.map(entry => entry.kind === "commit" && entry.oid))
        .toStrictEqual(commits.slice(0, held));
    expect(first.next).toBe(held);
    let review = readReview(t, [commits.at(-1)!]);
    expect(review.entries.map(entry => entry.kind === "commit" && entry.text?.length))
        .toStrictEqual(commits.map((_, i) => i < unread ? undefined : MAX_BUFFERED_BLOB_SIZE));
  });

  it("counts a path toward a page in bytes", async () => {
    // Files under a directory with a long name, of the same number of UTF-16 units either
    // way, each one byte or three. The page ends on the bytes of its paths.
    let pathsOnPage = async (unit: string) => {
      let t = await setupReview();
      let blob = await localBlob(t, "text\n");
      let long = unit.repeat(Math.ceil(READ_FILES_RESPONSE_BUDGET / 60));
      let inner = await localTree(t,
          Array.from({ length: PUSH_REVIEW_PAGE_SIZE }, (_, i) => fileAt(`${i + 100}`, blob)));
      let tree = await localTree(t, [dirAt(long, inner)]);
      let commit = await localCommit(t, tree, [t.base]);
      t.cache.markPushClosure(G1, ACTION, [commit]);
      let page = t.cache.readPushReview(ACTION, [commit]);
      expect(page.next).toBe(page.entries.length);
      return page.entries.filter(entry => entry.kind === "path" && entry.path !== "").length;
    };
    let ascii = await pathsOnPage("a"), wide = await pathsOnPage("\u20ac");
    expect(ascii).toBeLessThan(PUSH_REVIEW_PAGE_SIZE - 2);
    expect(Math.abs(ascii / 3 - wide)).toBeLessThanOrEqual(1);
  });

  it("walks a long history and a deep tree without recursion", async () => {
    let t = await setupReview(makeCache(makeLargeStorage()));
    let head = t.base;
    for (let i = 0; i < 20000; i++) head = await localCommit(t, t.baseTree, [head], `${i}`);
    t.cache.markPushClosure(G1, ACTION, [head]);
    let page = t.cache.readPushReview(ACTION, [head]);
    expect(page.entries.length).toBe(PUSH_REVIEW_PAGE_SIZE);
    expect(page.objectCount).toBe(20000);

    let tree = await localTree(t, [fileAt("leaf", await localBlob(t, "leaf\n"))]);
    for (let i = 0; i < 5000; i++) tree = await localTree(t, [dirAt("d", tree)]);
    let deep = await localCommit(t, tree, [t.base], "deep");
    t.cache.markPushClosure(G1, OTHER_ACTION, [deep]);
    // The commit, the root, the five thousand directories and the file at the bottom, then
    // what the root no longer has.
    page = t.cache.readPushReview(OTHER_ACTION, [deep], 5001);
    expect(page.next).toBeUndefined();
    expect(page.entries.map(entry => entry.kind === "path" && entry.path.length))
        .toStrictEqual([2 * 5000 - 1, 2 * 5000 + "leaf".length, "README.md".length]);
    expect(page.entries.map(entry => entry.kind === "path" && entry.sent?.kind))
        .toStrictEqual(["dir", "text", undefined]);
  });

  it("stops a call that has read as many objects as one may, and says so", async () => {
    let t = await setupReview(makeCache(makeLargeStorage()));
    // Each commit is read to order the chain, before the first is listed, and each one listed
    // reads its parent for its root. So a first page reads the chain and a page of parents:
    // here, exactly what a call may read. Beyond those it reads the text of its own commits.
    let within = MAX_PUSH_REVIEW_WALK_OBJECTS - PUSH_REVIEW_PAGE_SIZE;
    let head = t.base;
    for (let i = 0; i < within; i++) head = await localCommit(t, t.baseTree, [head], `${i}`);
    t.cache.markPushClosure(G1, ACTION, [head]);
    let reads = countReads(t);
    let page = t.cache.readPushReview(ACTION, [head]);
    expect(page.truncated).toBeUndefined();
    expect(page.entries).toHaveLength(PUSH_REVIEW_PAGE_SIZE);
    expect(page.next).toBe(PUSH_REVIEW_PAGE_SIZE);
    expect(reads).toHaveLength(MAX_PUSH_REVIEW_WALK_OBJECTS + PUSH_REVIEW_PAGE_SIZE);

    // The same call from further on needs one parent more: it stops, with what it listed
    // until then.
    reads.length = 0;
    page = t.cache.readPushReview(ACTION, [head], PUSH_REVIEW_PAGE_SIZE / 2);
    expect(page.truncated).toBe(true);
    expect(page.next).toBeUndefined();
    expect(page.entries).toHaveLength(PUSH_REVIEW_PAGE_SIZE / 2 + 1);
    expect(reads).toHaveLength(MAX_PUSH_REVIEW_WALK_OBJECTS + page.entries.length);

    // A chain longer than a call may read is never ordered: the call lists nothing, having
    // read as many objects as it may and none after.
    let longer = await localCommit(t, t.baseTree, [head], "one more");
    for (let i = 0; i < PUSH_REVIEW_PAGE_SIZE; i++) {
      longer = await localCommit(t, t.baseTree, [longer], `more ${i}`);
    }
    t.cache.markPushClosure(G1, OTHER_ACTION, [longer]);
    reads.length = 0;
    expect(t.cache.readPushReview(OTHER_ACTION, [longer])).toStrictEqual({
      entries: [], objectCount: MAX_PUSH_REVIEW_WALK_OBJECTS + 1, stackedOn: [ACTION],
      truncated: true,
    });
    expect(reads).toHaveLength(MAX_PUSH_REVIEW_WALK_OBJECTS);
  });

  it("stops a call that has read as many bytes as one may, in wide directories that list " +
      "little", async () => {
    let t = makeCache(makeLargeStorage());
    let blob = await t.cache.putFromGatekeeper(G1, "blob", utf8("same\n"));
    // A directory of about a mebibyte that every commit changes by one entry: each commit
    // lists three rows, and reads its own directory twice and its parent's once.
    let wide = Array.from({ length: 4096 }, (_, i) => fileAt(`${i}`.padStart(230, "n"), blob));
    let listingOf = (i: number) => encodeGitTree([...wide, fileAt(`changed-${i}`, blob)]);
    let size = listingOf(0).byteLength;
    expect(size).toBeGreaterThan(MAX_BUFFERED_BLOB_SIZE);
    let head = (await remoteCommit(t, wide)).commit, commits: GitOid[] = [];
    let count = Math.ceil(MAX_PUSH_REVIEW_WALK_BYTES / size);
    for (let i = 0; i < count; i++) {
      let tree = await storeLocal(t.storage, { type: "tree", payload: listingOf(i) });
      commits.push(head = await localCommit(t, tree, [head], `${i}`));
    }
    t.cache.markPushClosure(G1, ACTION, [head]);

    let reads = countReads(t);
    let page = t.cache.readPushReview(ACTION, [head]);
    expect(page.truncated).toBe(true);
    expect(page.next).toBeUndefined();
    // It lists the commits whose directories it could read, whole, and then stops: the next
    // directory is the last object it reads.
    let listedCommits = page.entries.filter(entry => entry.kind === "commit");
    expect(listedCommits.map(entry => entry.oid))
        .toStrictEqual(commits.slice(0, listedCommits.length));
    expect(page.entries.length).toBeGreaterThanOrEqual(3 * (listedCommits.length - 1));
    expect(listedCommits.length).toBeGreaterThan(count / 4);
    expect(listedCommits.length).toBeLessThan(count / 2);
    let inflated = reads.reduce((sum, oid) => sum + sizeOf(t, oid), 0);
    expect(inflated).toBeGreaterThan(MAX_PUSH_REVIEW_WALK_BYTES);
    expect(inflated).toBeLessThanOrEqual(MAX_PUSH_REVIEW_WALK_BYTES + size);
  });

  it("lists other entries once a marked directory arrives between two pages", async () => {
    let t = await setupReview();
    let shared = await localBlob(t, "shared\n");
    let inner = [await localBlob(t, "x\n"), await localBlob(t, "y\n"), await localBlob(t, "z\n")];
    let late = encodeGitTree(inner.map((oid, i) => fileAt(`${i}`, oid)));
    let lateOid = await storeLocal(t.storage, { type: "tree", payload: late });
    let names = Array.from({ length: 120 }, (_, i) => `b${i + 100}`);
    let tree = await localTree(t,
        [dirAt("a", lateOid), ...names.map(name => fileAt(name, shared))]);
    let commit = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [commit]);

    // The directory is not there for the first page, so what is under it is listed by id,
    // at the end. Its entries are marked already.
    t.storage.gitObjects.delete(lateOid);
    let first = t.cache.readPushReview(ACTION, [commit]);
    t.cache.importObjects([{ type: "tree", payload: late }]);
    let second = t.cache.readPushReview(ACTION, [commit], first.next);
    expect(second.objectCount).toBe(first.objectCount);
    expect(second.next).toBeUndefined();

    // The pages no longer fit together: the directory's files are in neither, and the paths
    // that moved down past the cursor are in both.
    let paths = [...first.entries, ...second.entries]
        .flatMap(entry => entry.kind === "path" ? [entry.path] : []);
    expect(paths.filter(path => path.startsWith("a/"))).toStrictEqual([]);
    expect(paths.length - new Set(paths).size).toBe(inner.length);
    // A read from the start lists each marked object once.
    expect(listed(readReview(t, [commit]).entries).slice(1, 6))
        .toStrictEqual(["a dir", "a/0 file", "a/1 file", "a/2 file", "b100 file"]);
  });
});

// =======================================================================================

type ReviewSetup = Awaited<ReturnType<typeof setupReview>>;

const REFUSAL = new RegExp(
    "^This workspace has observed sensitive data, so a push is accepted only when its approver " +
    "can read everything it will send\\. This push was not queued: (.*)\\. Change the commits " +
    "and push again\\.$", "s");

// The reason assertPushReadable gives for refusing a marked push, or undefined when it accepts
// the push.
function refusalOf(t: TestCache, heads: GitOid[], actionId = ACTION): string | undefined {
  try {
    t.cache.assertPushReadable(actionId, heads);
    return undefined;
  } catch (error) {
    let match = REFUSAL.exec((error as Error).message);
    if (match === null) throw error;
    return match[1];
  }
}

// Marks a push of one head, as submitAction does, and judges it.
function judge(t: TestCache, head: GitOid): string | undefined {
  t.cache.markPushClosure(G1, ACTION, [head]);
  return refusalOf(t, [head]);
}

// A path of a commit, as a refusal names it.
const at = (path: string, commit: GitOid) =>
    `${path === "" ? "the root directory" : JSON.stringify(path)} in commit ${commit}`;

const NOT_HELD = " is not in the workspace's git store";
const NOT_IN_FORM = " is not in the form git writes: an entry name is not valid UTF-8, is " +
    "repeated, is out of order or is not a single path segment";
const notComparable = (parent: GitOid) => ` cannot be compared with parent ${parent}, which is ` +
    "not in the workspace's git store as far as that path. Read that directory at the parent " +
    "commit, then push again";

// A local commit, on `parents`, of a tree written here with these entries.
async function snapshot(t: TestCache, entries: GitTreeEntry[], parents: GitOid[],
                        message?: string): Promise<GitOid> {
  return await localCommit(t, await localTree(t, entries), parents, message);
}

// A commit the remote G1 is known to have and the store does not hold: the parent of a commit
// G1 put. `supply` stores it.
async function unheldRemoteCommit(t: ReviewSetup) {
  let payload = commitPayload(t.baseTree, [t.base], "not fetched");
  let commit = gitObjectOid("commit", payload);
  await t.cache.putFromGatekeeper(G1, "commit", commitPayload(t.baseTree, [commit], "tip"));
  return { commit, supply: () => t.cache.putFromGatekeeper(G1, "commit", payload) };
}

describe("assertPushReadable", () => {
  const ACCEPTED: [string, (t: ReviewSetup) => Promise<GitOid>][] = [
    ["a file added in one commit and changed in the next", async t => {
      let first = await snapshot(t,
          [fileAt("README.md", t.readme), fileAt("notes.txt", await localBlob(t, "one\n"))],
          [t.base], "add");
      return await snapshot(t,
          [fileAt("README.md", t.readme), fileAt("notes.txt", await localBlob(t, "one\ntwo\n"))],
          [first], "change");
    }],
    ["a file that begins with a UTF-8 byte order mark", async t => snapshot(t,
        [fileAt("bom.txt", await localBlob(t, Uint8Array.of(0xef, 0xbb, 0xbf, 0x61, 0x0a)))],
        [t.base])],
    ["a file of exactly the buffered size", async t => {
      let blob = await localBlob(t, new Uint8Array(MAX_BUFFERED_BLOB_SIZE).fill(0x61));
      return await snapshot(t, [fileAt("exact.txt", blob)], [t.base]);
    }],
    ["an empty file", async t =>
        snapshot(t, [fileAt("empty.txt", await localBlob(t, ""))], [t.base])],
    ["an empty directory", t =>
        snapshot(t, [fileAt("README.md", t.readme), dirAt("empty", EMPTY_TREE_OID)], [t.base])],
    ["a deletion", t => snapshot(t, [], [t.base])],
    ["a change of mode alone", t => snapshot(t, [executableAt("README.md", t.readme)], [t.base])],
    ["an unchanged submodule entry and an unchanged symbolic link beside a changed file",
     async t => {
      await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);
      await t.cache.putFromGatekeeper(G1, "tree", fixture(TREE_1).payload);
      let entries = parseGitTree(fixture(TREE_1).payload);
      expect(entries.map(entry => entry.name))
          .toStrictEqual(expect.arrayContaining(["README.md", "link.md", "vendored"]));
      let changed = await localBlob(t, "changed\n");
      return await snapshot(t,
          entries.map(entry => entry.name === "README.md" ? fileAt("README.md", changed) : entry),
          [COMMIT_1]);
    }],
    ["a symbolic link to a file the remote has", t =>
        snapshot(t, [fileAt("README.md", t.readme), linkAt("link", t.readme)], [t.base])],
    ["a file turned into a symbolic link over the same content", t =>
        snapshot(t, [linkAt("README.md", t.readme)], [t.base])],
    ["a return to a tree the remote has", async t => {
      let blob = await t.cache.putFromGatekeeper(G1, "blob", utf8("later\n"));
      let later = await remoteCommit(t, [fileAt("README.md", blob)], [t.base], "later");
      return await localCommit(t, t.baseTree, [later.commit], "revert");
    }],
    ["a head the remote already has", async t => t.base],
    ["a merge whose root is one parent's, the other parent not in the store", async t =>
        localCommit(t, t.baseTree, [t.base, (await unheldRemoteCommit(t)).commit], "merge")],
  ];
  for (let [what, build] of ACCEPTED) {
    it(`accepts ${what}`, async () => {
      let t = await setupReview();
      expect(judge(t, await build(t))).toBeUndefined();
    });
  }

  // Each builds a push that breaks one rule, and says what the refusal names.
  const withFile = async (t: ReviewSetup, name: string, content: Uint8Array) =>
      snapshot(t, [fileAt("README.md", t.readme), fileAt(name, await localBlob(t, content))],
          [t.base]);
  const withCommit = (t: ReviewSetup, payload: Uint8Array) =>
      storeLocal(t.storage, { type: "commit", payload });
  const notText = (commit: GitOid) =>
      `commit ${commit} is not UTF-8 text of at most ${MAX_BUFFERED_BLOB_SIZE} bytes`;
  const SUBMODULE = " adds or changes a submodule entry";
  const SENT_LINK = " is a symbolic link whose target this push sends";
  const REFUSED: [string, (t: ReviewSetup) => Promise<{ head: GitOid, reason: string }>][] = [
    ["a commit the store does not hold", async t => {
      let head = gitObjectOid("commit", commitPayload(t.baseTree, [t.base], "never stored"));
      return { head, reason: `commit ${head}${NOT_HELD}` };
    }],
    ["a root directory the store does not hold", async t => {
      let tree = gitObjectOid("tree", encodeGitTree([fileAt("x", t.readme)]));
      let head = await localCommit(t, tree, [t.base]);
      return { head, reason: at("", head) + NOT_HELD };
    }],
    ["a file the store does not hold", async t => {
      let absent = gitObjectOid("blob", utf8("never stored\n"));
      let head = await snapshot(t, [fileAt("gone.txt", absent)], [t.base]);
      return { head, reason: at("gone.txt", head) + NOT_HELD };
    }],

    ["a commit whose tree is a file", async t => {
      let head = await localCommit(t, await localBlob(t, "not a tree\n"), [t.base]);
      return { head, reason: `${at("", head)} names a blob where a tree is expected` };
    }],
    ["a directory entry that names a file", async t => {
      let head = await snapshot(t, [dirAt("d", await localBlob(t, "not a tree\n"))], [t.base]);
      return { head, reason: `${at("d", head)} names a blob where a tree is expected` };
    }],
    ["a file entry that names a directory", async t => {
      let sub = await localTree(t, [fileAt("x", t.readme)]);
      let head = await snapshot(t, [fileAt("f", sub)], [t.base]);
      return { head, reason: `${at("f", head)} names a tree where a blob is expected` };
    }],
    ["a file entry that names a commit", async t => {
      let other = await localCommit(t, t.baseTree, [t.base], "other");
      let head = await snapshot(t, [fileAt("f", other)], [t.base]);
      return { head, reason: `${at("f", head)} names a commit where a blob is expected` };
    }],

    ...[...UNLISTABLE, ["a name holding a slash", a => [fileAt("a/b", a)]] as typeof UNLISTABLE[0]]
        .map(([what, entries]): typeof REFUSED[0] => [`a directory with ${what}`, async t => {
          let payload = treePayload(entries(await localBlob(t, "a\n"), await localBlob(t, "b\n")));
          let odd = await storeLocal(t.storage, { type: "tree", payload });
          let head = await snapshot(t,
              [fileAt("README.md", t.readme), dirAt("odd", odd)], [t.base]);
          return { head, reason: `the directory ${at("odd", head)}${NOT_IN_FORM}` };
        }]),
    ["a root directory with a name holding a slash", async t => {
      let payload = treePayload([fileAt("a/b", await localBlob(t, "a\n"))]);
      let head = await localCommit(t, await storeLocal(t.storage, { type: "tree", payload }),
          [t.base]);
      return { head, reason: at("", head) + NOT_IN_FORM };
    }],
    ["a directory with a name that is not UTF-8", async t => {
      await storeLocal(t.storage, fixture(BAD_NAME_TREE));
      await storeLocal(t.storage, fixture(scanGitTree(fixture(BAD_NAME_TREE).payload)[0].oid));
      let head = await snapshot(t, [dirAt("odd", BAD_NAME_TREE)], [t.base]);
      return { head, reason: `the directory ${at("odd", head)}${NOT_IN_FORM}` };
    }],

    ["a file with a NUL", async t => {
      let head = await withFile(t, "a.bin", Uint8Array.of(0x61, 0, 0x62));
      return { head, reason: `${at("a.bin", head)} is not UTF-8 text` };
    }],
    // The name is written as JSON, so that no character of it can pass for the refusal's own
    // words.
    ["a file that is not text, whose name holds a quote and a line break", async t => {
      let name = 'a"\nb.bin';
      let head = await withFile(t, name, Uint8Array.of(0x61, 0, 0x62));
      expect(at(name, head)).toBe(String.raw`"a\"\nb.bin" in commit ` + head);
      return { head, reason: `${at(name, head)} is not UTF-8 text` };
    }],
    ["a file that is not valid UTF-8", async t => {
      let head = await withFile(t, "latin1.txt", Uint8Array.of(0x63, 0x61, 0x66, 0xe9, 0x0a));
      return { head, reason: `${at("latin1.txt", head)} is not UTF-8 text` };
    }],
    ["a file of UTF-16 text with a byte order mark", async t => {
      let head = await withFile(t, "wide.txt", Uint8Array.of(0xff, 0xfe, 0x68, 0, 0x69, 0));
      return { head, reason: `${at("wide.txt", head)} is not UTF-8 text` };
    }],

    ["a symbolic link whose target it sends", async t => {
      let target = await localBlob(t, "README.md");
      let head = await snapshot(t, [fileAt("README.md", t.readme), linkAt("link", target)],
          [t.base]);
      return { head, reason: at("link", head) + SENT_LINK };
    }],
    ["such a link under the commit that adds it, where a later commit keeps it", async t => {
      let link = linkAt("link", await localBlob(t, "README.md"));
      let first = await snapshot(t, [fileAt("README.md", t.readme), link], [t.base], "link");
      let head = await snapshot(t,
          [fileAt("README.md", t.readme), link, fileAt("more.txt", await localBlob(t, "more\n"))],
          [first], "more");
      return { head, reason: at("link", first) + SENT_LINK };
    }],

    ["a submodule entry it adds", async t => {
      let head = await snapshot(t,
          [fileAt("README.md", t.readme), submoduleAt("mod", GITLINK_TARGET)], [t.base]);
      return { head, reason: at("mod", head) + SUBMODULE };
    }],
    ["a submodule entry whose target it changes", async t => {
      let base = await remoteCommit(t, [submoduleAt("mod", GITLINK_TARGET)], [t.base], "mod");
      let head = await snapshot(t, [submoduleAt("mod", "2".repeat(40))], [base.commit]);
      return { head, reason: at("mod", head) + SUBMODULE };
    }],
    ["a submodule entry in a subdirectory", async t => {
      let lib = await localTree(t, [submoduleAt("nested", GITLINK_TARGET)]);
      let head = await snapshot(t, [fileAt("README.md", t.readme), dirAt("lib", lib)], [t.base]);
      return { head, reason: at("lib/nested", head) + SUBMODULE };
    }],
    ["a submodule entry where the parent's directory is not in the store", async t => {
      // The remote's tree may hold this very entry, and nothing held here shows that it does.
      let entries = [submoduleAt("mod", GITLINK_TARGET)];
      let remote = await t.cache.putFromGatekeeper(G1, "commit",
          commitPayload(gitObjectOid("tree", encodeGitTree(entries)), [], "remote"));
      let head = await snapshot(t, [...entries, fileAt("new.txt", t.readme)], [remote]);
      return { head, reason: at("mod", head) + SUBMODULE };
    }],

    ["a commit that is not valid UTF-8", async t => {
      let head = await withCommit(t, concatBytes(
          [commitPayload(t.baseTree, [t.base], "invalid"), Uint8Array.of(0xff, 0x0a)]));
      return { head, reason: notText(head) };
    }],
    ["a commit with a NUL", async t => {
      let head = await withCommit(t, commitPayload(t.baseTree, [t.base], "nul \0"));
      return { head, reason: notText(head) };
    }],
    ["a commit over the buffered size", async t => {
      let head = await withCommit(t,
          commitPayload(t.baseTree, [t.base], "x".repeat(MAX_BUFFERED_BLOB_SIZE)));
      return { head, reason: notText(head) };
    }],

    ["an object marked for it that is at no path of its commits", async t => {
      let stray = await localBlob(t, "stray\n");
      t.storage.gitObjectMetadata.put({
        oid: stray, type: "blob", onRemote: [], pullableFrom: [],
        pendingPush: [{ gatekeeperId: G1, actionId: ACTION }],
      });
      let head = await withFile(t, "a.txt", utf8("text\n"));
      return {
        head,
        reason: `object ${stray} is sent but is neither a commit of this push nor at a path of one`,
      };
    }],
    ["a parent that is not a commit", async t => {
      // Straight to the marks: the ancestry check refuses this push before it is queued.
      let blob = await localBlob(t, "not a commit\n");
      let head = await localCommit(t, t.baseTree, [t.base, blob]);
      return {
        head,
        reason: `object ${blob} is sent but is neither a commit of this push nor at a path of one`,
      };
    }],
  ];
  for (let [what, build] of REFUSED) {
    it(`refuses ${what}`, async () => {
      let t = await setupReview();
      let { head, reason } = await build(t);
      expect(judge(t, head)).toBe(reason);
    });
  }

  it("refuses a directory with a name twice whichever of its two files is text", async () => {
    for (let textFirst of [true, false]) {
      let t = await setupReview();
      let blobs = [await localBlob(t, "benign\n"), await localBlob(t, Uint8Array.of(0, 1, 2))];
      if (!textFirst) blobs.reverse();
      let odd = await storeLocal(t.storage, {
        type: "tree",
        payload: treePayload([fileAt("notes.txt", blobs[0]), fileAt("notes.txt", blobs[1])]),
      });
      let head = await snapshot(t, [fileAt("README.md", t.readme), dirAt("odd", odd)], [t.base]);
      expect(judge(t, head)).toBe(`the directory ${at("odd", head)}${NOT_IN_FORM}`);
    }
  });

  it("refuses a file over the buffered size without reading it", async () => {
    let t = await setupReview();
    let over = t.cache.writeBlob(new Uint8Array(MAX_BUFFERED_BLOB_SIZE + 1).fill(0x61)).oid;
    let head = await snapshot(t, [fileAt("README.md", t.readme), fileAt("big.txt", over)],
        [t.base]);
    t.cache.markPushClosure(G1, ACTION, [head]);

    let reads = countReads(t);
    expect(refusalOf(t, [head]))
        .toBe(`${at("big.txt", head)} is larger than ${MAX_BUFFERED_BLOB_SIZE} bytes`);
    let chunks = chunksOf(t, over);
    expect(chunks.length).toBeGreaterThan(1);
    expect(reads.filter(oid => chunks.includes(oid))).toStrictEqual([]);
  });

  // A push whose commit cannot be compared with a parent, and what stores the missing object.
  const INCOMPARABLE: [string, (t: ReviewSetup) => Promise<
      { head: GitOid, reason: string, supply: () => unknown }>][] = [
    ["a commit whose parent is not in the store", async t => {
      let parent = await unheldRemoteCommit(t);
      let head = await snapshot(t,
          [fileAt("README.md", t.readme), fileAt("a.txt", await localBlob(t, "a\n"))],
          [parent.commit]);
      return { head, reason: at("", head) + notComparable(parent.commit), supply: parent.supply };
    }],
    ...([
      ["a changed file", "old.md", (t: ReviewSetup) => localBlob(t, "fresh\n")],
      ["an entry over a file the remote has", "renamed.md", async (t: ReviewSetup) => t.readme],
    ] as const).map(([what, name, blob]): typeof INCOMPARABLE[0] =>
        [`${what} under a directory the parent's tree for which is not in the store`, async t => {
          let docs = encodeGitTree([fileAt("old.md", t.readme)]);
          let base = await remoteCommit(t, [dirAt("docs", gitObjectOid("tree", docs))], [], "docs");
          let now = await localTree(t, [fileAt(name, await blob(t))]);
          let head = await snapshot(t, [dirAt("docs", now)], [base.commit]);
          return {
            head,
            reason: at(`docs/${name}`, head) + notComparable(base.commit),
            supply: () => t.cache.putFromGatekeeper(G1, "tree", docs),
          };
        }]),
    ["a merge that differs from a parent in the store and one that is not", async t => {
      let parent = await unheldRemoteCommit(t);
      let head = await snapshot(t,
          [fileAt("README.md", t.readme), fileAt("m.txt", await localBlob(t, "merged\n"))],
          [t.base, parent.commit], "merge");
      return { head, reason: at("", head) + notComparable(parent.commit), supply: parent.supply };
    }],
  ];
  for (let [what, build] of INCOMPARABLE) {
    it(`refuses ${what}, and accepts it once that is stored`, async () => {
      let t = await setupReview();
      let { head, reason, supply } = await build(t);
      expect(judge(t, head)).toBe(reason);

      await supply();
      let review = t.cache.readPushReview(ACTION, [head]);
      expect(JSON.stringify(review)).not.toContain('"unknown"');
      expect(refusalOf(t, [head])).toBeUndefined();
      expect(t.cache.readPushReview(ACTION, [head])).toStrictEqual(review);
    });
  }
  // The one way an accepted push's review changes while the push waits: an empty directory
  // has no entry to compare, so nothing shows that the parent's directory there is not held.
  it("accepts an empty directory over a parent's directory that is not in the store, and " +
     "lists what that deletes once it is", async () => {
    let t = await setupReview();
    let docs = encodeGitTree([fileAt("old.md", t.readme), fileAt("plan.md", t.readme)]);
    let base = await remoteCommit(t,
        [fileAt("README.md", t.readme), dirAt("docs", gitObjectOid("tree", docs))], [], "docs");
    let head = await snapshot(t,
        [fileAt("README.md", t.readme), dirAt("docs", EMPTY_TREE_OID)], [base.commit]);
    expect(judge(t, head)).toBeUndefined();
    let before = readReview(t, [head]);
    expect(listed(before.entries)).toStrictEqual([" dir", "docs dir"]);
    expect(JSON.stringify(before)).not.toContain('"unknown"');

    await t.cache.putFromGatekeeper(G1, "tree", docs);
    let after = readReview(t, [head]);
    expect(after.entries).toStrictEqual([
      ...before.entries,
      pathRow(head, "docs/old.md", undefined, [aFile(t.readme)]),
      pathRow(head, "docs/plan.md", undefined, [aFile(t.readme)]),
    ]);
    expect(refusalOf(t, [head])).toBeUndefined();
  });

  // `count` file entries, over one blob or over one each.
  const spread = (count: number, oid: (index: number) => GitOid) => Array.from(
      { length: count }, (_, index) => fileAt(`f${String(index).padStart(3, "0")}`, oid(index)));
  const TOO_MUCH_TEXT = `it sends more than ${MAX_RESTRICTED_PUSH_TEXT_SIZE} bytes of text`;

  // Each builds a push of a given size in what one bound counts, the largest it allows and
  // the reason one more gives.
  const BOUNDS: [string, number, string, (t: ReviewSetup, size: number) => Promise<GitOid>][] = [
    ["commits", MAX_RESTRICTED_PUSH_COMMITS,
     `it sends more than ${MAX_RESTRICTED_PUSH_COMMITS} commits`, async (t, size) => {
      let head = t.base;
      for (let i = 0; i < size; i++) head = await localCommit(t, t.baseTree, [head], `${i}`);
      return head;
    }],
    ["files", MAX_RESTRICTED_PUSH_FILES,
     `it sends more than ${MAX_RESTRICTED_PUSH_FILES} files`, async (t, size) => {
      let blobs: GitOid[] = [];
      for (let i = 0; i < size; i++) blobs.push(await localBlob(t, `${i}\n`));
      return await snapshot(t, spread(size, index => blobs[index]), [t.base]);
    }],
    // The root, a directory and its entries, each over a file the remote has: no file is sent.
    ["paths", MAX_RESTRICTED_PUSH_PATHS,
     `its commits change more than ${MAX_RESTRICTED_PUSH_PATHS} paths`, async (t, size) => {
      let inner = await localTree(t, spread(size - 2, () => t.readme));
      return await snapshot(t, [fileAt("README.md", t.readme), dirAt("d", inner)], [t.base]);
    }],
    // The same under a merge, whose every path is compared with two parents and counts twice.
    ["paths of a merge", MAX_RESTRICTED_PUSH_PATHS / 2,
     `its commits change more than ${MAX_RESTRICTED_PUSH_PATHS} paths`, async (t, size) => {
      let other = await remoteCommit(t, [fileAt("other.txt", t.readme)], [], "other");
      let inner = await localTree(t, spread(size - 2, () => t.readme));
      return await snapshot(t, [dirAt("d", inner)], [t.base, other.commit], "merge");
    }],
    // A commit with no parent, marked directly since the ancestry check refuses to queue one
    // the remote does not have: its paths are compared with nothing and each counts once.
    ["paths of a parentless commit", MAX_RESTRICTED_PUSH_PATHS,
     `its commits change more than ${MAX_RESTRICTED_PUSH_PATHS} paths`, (t, size) =>
        snapshot(t, spread(size - 1, () => t.readme), [])],
  ];
  for (let [what, most, reason, build] of BOUNDS) {
    it(`accepts ${most} ${what} and refuses one more`, async () => {
      let t = await setupReview();
      expect(judge(t, await build(t, most))).toBeUndefined();
      t = await setupReview();
      expect(judge(t, await build(t, most + 1))).toBe(reason);
    });
  }

  it("counts a file once, at however many paths it is", async () => {
    let t = await setupReview();
    // One of them is half the text bound, so that counting it at both its paths would pass it.
    let blobs = [await localBlob(t, new Uint8Array(MAX_BUFFERED_BLOB_SIZE).fill(0x61))];
    for (let i = 1; i < MAX_RESTRICTED_PUSH_FILES; i++) blobs.push(await localBlob(t, `${i}\n`));
    let head = await snapshot(t,
        spread(2 * MAX_RESTRICTED_PUSH_FILES, index => blobs[index % blobs.length]), [t.base]);
    expect(judge(t, head)).toBeUndefined();
  });

  // The text a push puts before its approver, counted from its review as
  // MAX_RESTRICTED_PUSH_TEXT_SIZE says: commits, paths, listings and each file once.
  function reviewText(t: TestCache, head: GitOid): number {
    let files = new Map<GitOid, number>(), text = 0;
    for (let entry of readReview(t, [head]).entries) {
      if (entry.kind === "commit") text += entry.size!;
      if (entry.kind !== "path") continue;
      text += utf8(entry.path).byteLength;
      if (entry.sent?.kind === "dir") text += entry.sent.size;
      if (entry.sent?.kind === "text") files.set(entry.entry!.oid, entry.sent.size);
    }
    return text + [...files.values()].reduce((sum, size) => sum + size, 0);
  }

  // Trees that come close to the text bound by one kind of text. The commit's message makes
  // up the rest, to the byte.
  const NEAR_TEXT_BOUND: [string, (t: ReviewSetup) => Promise<GitTreeEntry[]>][] = [
    ["its files", async t => [
      fileAt("a.txt", await localBlob(t, new Uint8Array(MAX_BUFFERED_BLOB_SIZE).fill(0x61))),
      fileAt("b.txt", await localBlob(t, new Uint8Array(
          MAX_RESTRICTED_PUSH_TEXT_SIZE - MAX_BUFFERED_BLOB_SIZE - 4096).fill(0x62))),
    ]],
    // Four names over a file the remote has, each written in the listing and as a path.
    ["the long names of a directory's listing", async t => Array.from({ length: 4 }, (_, i) =>
        fileAt(`${i}`.padEnd(MAX_RESTRICTED_PUSH_TEXT_SIZE / 8 - 2048, "n"), t.readme))],
    // Three directories with long names, one in the other, whose listings are small. The
    // paths of the entries in the last repeat all three names.
    ["its paths alone", async t => {
      let tree = await localTree(t, spread(340, () => t.readme));
      for (let name of ["c", "b", "a"]) {
        tree = await localTree(t, [dirAt(name.repeat(2000), tree)]);
      }
      return parseGitTree(t.cache.readLocalObject(tree)!.payload);
    }],
  ];
  for (let [what, entries] of NEAR_TEXT_BOUND) {
    it(`counts ${what} toward the text bound, exactly`, async () => {
      let push = async (pad: number) => {
        let t = await setupReview();
        let head = await snapshot(t, await entries(t), [t.base], "x".repeat(pad));
        t.cache.markPushClosure(G1, ACTION, [head]);
        return { t, head };
      };
      let bare = await push(0);
      let slack = MAX_RESTRICTED_PUSH_TEXT_SIZE - reviewText(bare.t, bare.head);
      expect(slack).toBeGreaterThan(0);
      expect(slack).toBeLessThan(64 * 1024);

      let exact = await push(slack);
      expect(reviewText(exact.t, exact.head)).toBe(MAX_RESTRICTED_PUSH_TEXT_SIZE);
      expect(refusalOf(exact.t, [exact.head])).toBeUndefined();
      let over = await push(slack + 1);
      expect(refusalOf(over.t, [over.head])).toBe(TOO_MUCH_TEXT);
    });
  }

  it("counts a path in bytes: names of three-byte characters reach the text bound at a " +
      "third of the length", async () => {
    // Ten entries over a file the remote has, in a directory with a long name: the name is
    // written in the listing above it, as its own path and in the path of each entry.
    let refusal = async (unit: string, length: number) => {
      let t = await setupReview();
      let inner = await localTree(t,
          Array.from({ length: 10 }, (_, i) => fileAt(`${i}`, t.readme)));
      return judge(t, await snapshot(t, [dirAt(unit.repeat(length), inner)], [t.base]));
    };
    let ascii = Math.floor((MAX_RESTRICTED_PUSH_TEXT_SIZE - 1024) / 12);
    expect(await refusal("a", ascii)).toBeUndefined();
    expect(await refusal("a", ascii + 100)).toBe(TOO_MUCH_TEXT);
    expect(await refusal("€", Math.floor(ascii / 3))).toBeUndefined();
    expect(await refusal("€", Math.floor(ascii / 3) + 34)).toBe(TOO_MUCH_TEXT);
  });

  it("refuses more objects than the bounds allow before it reads one", async () => {
    let t = await setupReview(makeCache(makeLargeStorage()));
    let most = MAX_RESTRICTED_PUSH_COMMITS + MAX_RESTRICTED_PUSH_PATHS;
    let head = t.base;
    for (let i = 0; i < most; i++) head = await localCommit(t, t.baseTree, [head], `${i}`);
    // As many objects as the bounds allow are walked, and refused by the bound they break.
    t.cache.markPushClosure(G1, OTHER_ACTION, [head]);
    expect(listMarks(t.storage, OTHER_ACTION).length).toBe(most);
    expect(refusalOf(t, [head], OTHER_ACTION))
        .toBe(`it sends more than ${MAX_RESTRICTED_PUSH_COMMITS} commits`);

    head = await localCommit(t, t.baseTree, [head], "one more");
    t.cache.markPushClosure(G1, ACTION, [head]);
    expect(listMarks(t.storage, ACTION).length).toBe(most + 1);

    let reads = countReads(t);
    expect(refusalOf(t, [head])).toBe(
        `it sends more objects than ${MAX_RESTRICTED_PUSH_COMMITS} commits changing ` +
        `${MAX_RESTRICTED_PUSH_PATHS} paths can`);
    expect(reads).toStrictEqual([]);
  });

  // A directory thirty levels deep in which every level names the level below twice: some
  // thirty objects, and two to the power of thirty paths.
  async function treeBomb(leaf: GitTreeEntry,
                          store: (payload: Uint8Array) => GitOid | Promise<GitOid>) {
    let tree = await store(encodeGitTree([leaf]));
    for (let i = 0; i < 30; i++) {
      tree = await store(encodeGitTree([dirAt("a", tree), dirAt("b", tree)]));
    }
    return tree;
  }
  const local = (t: TestCache) => (payload: Uint8Array) =>
      storeLocal(t.storage, { type: "tree", payload });
  const PATHS_REASON = `its commits change more than ${MAX_RESTRICTED_PUSH_PATHS} paths`;

  it("stops at the paths bound in a tree of few objects and many paths", async () => {
    let t = await setupReview();
    let tree = await treeBomb(fileAt("x", await localBlob(t, "x\n")), local(t));
    let head = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [head]);
    expect(listMarks(t.storage, ACTION).length).toBeLessThan(40);

    let reads = countReads(t);
    expect(refusalOf(t, [head])).toBe(PATHS_REASON);
    expect(reads.length).toBeLessThanOrEqual(3 * MAX_RESTRICTED_PUSH_PATHS);
  });

  it("stops at the paths bound in a merge of such trees that sends no file", async () => {
    let t = await setupReview();
    let remote = (payload: Uint8Array) => t.cache.putFromGatekeeper(G1, "tree", payload);
    let sides: GitOid[] = [];
    for (let name of ["left", "right"]) {
      let tree = await treeBomb(fileAt(name, t.readme), remote);
      sides.push(await t.cache.putFromGatekeeper(G1, "commit", commitPayload(tree, [], name)));
    }
    // Every directory of the merge differs from both sides', down to an entry over a file the
    // remote has.
    let tree = await treeBomb(fileAt("merged", t.readme), local(t));
    let head = await localCommit(t, tree, sides, "merge");
    t.cache.markPushClosure(G1, ACTION, [head]);

    let reads = countReads(t);
    expect(refusalOf(t, [head])).toBe(PATHS_REASON);
    expect(reads.length).toBeLessThanOrEqual(3 * MAX_RESTRICTED_PUSH_PATHS);
  });

  it("refuses a cursor past the ceiling before it walks such a tree", async () => {
    let t = await setupReview();
    let tree = await treeBomb(fileAt("x", await localBlob(t, "x\n")), local(t));
    let head = await localCommit(t, tree, [t.base]);
    t.cache.markPushClosure(G1, ACTION, [head]);

    let reads = countReads(t);
    expect(() => t.cache.readPushReview(ACTION, [head], MAX_PUSH_REVIEW_CURSOR + 1))
        .toThrow(`A push review cannot be read past ${MAX_PUSH_REVIEW_CURSOR} entries.`);
    expect(reads).toStrictEqual([]);
    expect(t.cache.readPushReview(ACTION, [head], PUSH_REVIEW_PAGE_SIZE).entries)
        .toHaveLength(PUSH_REVIEW_PAGE_SIZE);
  });

  it("reads a file once for its size and once for its text, however many paths name it",
     async () => {
    let t = await setupReview();
    let blob = await localBlob(t, "same\n");
    // The root, README.md's deletion and every path of the file: the most paths a push may change.
    let head = await snapshot(t, spread(MAX_RESTRICTED_PUSH_PATHS - 2, () => blob), [t.base]);
    t.cache.markPushClosure(G1, ACTION, [head]);

    let reads = countReads(t);
    expect(refusalOf(t, [head])).toBeUndefined();
    expect(reads.filter(read => read === blob)).toHaveLength(2);
  });

  it("reads a parent once, however often a commit names it", async () => {
    let t = await setupReview();
    let head = await localCommit(t, t.baseTree, Array<GitOid>(1000).fill(t.base));
    t.cache.markPushClosure(G1, ACTION, [head]);

    let reads = countReads(t);
    expect(refusalOf(t, [head])).toBeUndefined();
    expect(reads.filter(read => read === t.base)).toHaveLength(1);
    reads.length = 0;
    expect(readReview(t, [head]).entries).toHaveLength(1);
    expect(reads.filter(read => read === t.base)).toHaveLength(1);
  });

  it("accepts a push at every bound at once, and no call for its review stops short",
     async () => {
    let t = await setupReview();
    // Each commit changes the root, a directory and every file in it, to one of two files of
    // its own: with the commits before it, all the paths, and nearly all the text, a push may
    // have.
    let perCommit = MAX_RESTRICTED_PUSH_PATHS / MAX_RESTRICTED_PUSH_COMMITS - 2;
    let fileSize = Math.floor(
        (MAX_RESTRICTED_PUSH_TEXT_SIZE - 128 * 1024) / (2 * MAX_RESTRICTED_PUSH_COMMITS));
    let head = t.base;
    for (let i = 0; i < MAX_RESTRICTED_PUSH_COMMITS; i++) {
      let pair = [
        await localBlob(t, `${i}a`.padEnd(fileSize, "a")),
        await localBlob(t, `${i}b`.padEnd(fileSize, "b")),
      ];
      let inner = await localTree(t, spread(perCommit, index => pair[index % 2]));
      head = await snapshot(t, [fileAt("README.md", t.readme), dirAt("d", inner)], [head], `${i}`);
    }
    t.cache.markPushClosure(G1, ACTION, [head]);

    let reads = countReads(t);
    expect(refusalOf(t, [head])).toBeUndefined();
    // The pass read every row and the text of every file, in a small part of what a call may.
    expect(reads.length).toBeLessThan(MAX_PUSH_REVIEW_WALK_OBJECTS / 10);
    expect(reads.reduce((sum, oid) => sum + sizeOf(t, oid), 0))
        .toBeLessThan(MAX_PUSH_REVIEW_WALK_BYTES / 4);

    let review = readReview(t, [head]);
    let paths = review.entries.filter(entry => entry.kind === "path");
    expect(review.entries.length - paths.length).toBe(MAX_RESTRICTED_PUSH_COMMITS);
    expect(paths).toHaveLength(MAX_RESTRICTED_PUSH_PATHS);
    expect(reviewText(t, head)).toBeGreaterThan(MAX_RESTRICTED_PUSH_TEXT_SIZE - 256 * 1024);
  });

  it("refuses a push that no call could list whole, for what its parents' directories hold",
     async () => {
    // A merge whose every parent has its own version of one wide directory. The merge sends
    // the root and its version of that directory, within every bound, and lists them and the
    // one entry no parent has; finding that entry reads each parent's version.
    let merge = async (parents: number) => {
      let t = await setupReview(makeCache(makeLargeStorage()));
      let wide = Array.from(
          { length: 4096 }, (_, i) => fileAt(`${i}`.padStart(230, "n"), t.readme));
      let version = (name: string) => localTree(t, [...wide, fileAt(name, t.readme)]);
      let sides: GitOid[] = [];
      for (let i = 0; i < parents; i++) {
        let tree = await localTree(t, [dirAt("d", await version(`side-${i}`))]);
        sides.push(await t.cache.putFromGatekeeper(
            G1, "commit", commitPayload(tree, [], `side ${i}`)));
      }
      let head = await snapshot(t, [dirAt("d", await version("merged"))], sides, "merge");
      return { t, head, size: sizeOf(t, await version("merged")) };
    };

    let within = await merge(Math.floor(MAX_PUSH_REVIEW_WALK_BYTES / (1024 * 1024)) - 4);
    expect(judge(within.t, within.head)).toBeUndefined();
    expect(listed(readReview(within.t, [within.head]).entries))
        .toStrictEqual([" dir", "d dir", "d/merged file"]);

    let over = await merge(Math.ceil(MAX_PUSH_REVIEW_WALK_BYTES / (1024 * 1024)));
    expect(over.size).toBeGreaterThan(1024 * 1024);
    over.t.cache.markPushClosure(G1, ACTION, [over.head]);
    let reads = countReads(over.t);
    expect(refusalOf(over.t, [over.head])).toBe(
        `listing it reads more than ${MAX_PUSH_REVIEW_WALK_OBJECTS} objects, or more than ` +
        `${MAX_PUSH_REVIEW_WALK_BYTES} bytes of them: its commits and directories and those ` +
        "of their parents");
    expect(reads.reduce((sum, oid) => sum + sizeOf(over.t, oid), 0))
        .toBeLessThanOrEqual(MAX_PUSH_REVIEW_WALK_BYTES + over.size);
    // Its review says the same of itself.
    let page = over.t.cache.readPushReview(ACTION, [over.head]);
    expect(page.truncated).toBe(true);
    expect(listed(page.entries)).toStrictEqual([" dir", "d dir"]);
  });

  it("reads no file past the files bound", async () => {
    let t = await setupReview();
    let blobs: GitOid[] = [];
    for (let i = 0; i <= MAX_RESTRICTED_PUSH_FILES; i++) blobs.push(await localBlob(t, `${i}\n`));
    let head = await snapshot(t, spread(blobs.length, index => blobs[index]), [t.base]);
    t.cache.markPushClosure(G1, ACTION, [head]);

    let reads = countReads(t);
    expect(refusalOf(t, [head])).toBe(`it sends more than ${MAX_RESTRICTED_PUSH_FILES} files`);
    // The walk looks up each file's size as it lists it, and the pass then reads the file for
    // its text. The file that trips the bound is looked up and not read, and none follows it.
    let timesRead = blobs.map(oid => reads.filter(read => read === oid).length);
    expect(timesRead).toStrictEqual([...blobs.slice(1).map(() => 2), 1]);
  });
});

// =======================================================================================

describe("consumePack", () => {
  it("stores a real-git pack exactly like the equivalent puts", async () => {
    let t = makeCache();
    let stub = new GitCacheImpl(t.cache, G1);
    let stored = await stub.consumePack(byteStream(b64Bytes(PACK_OFS_DELTA)));
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

  it("extends sources whatever order the pack delivers its objects in", async () => {
    let t = makeCache();
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);
    // G2's pack has the subtree ahead of the tree that G1 is recorded as having.
    let pack = concatBytes(await buildPackBytes([fixture(DOCS_TREE), fixture(TREE_1)]));
    await t.cache.consumePackFromGatekeeper(G2, byteStream(pack));
    expect(t.storage.gitObjectMetadata.get(DOCS_FILE)!.pullableFrom.toSorted())
        .toStrictEqual([G1, G2]);
  });

  it("consumes a raw pack returned by another Worker, preserving its provenance", async () => {
    // The other tests build a byte stream. A gatekeeper sends a default stream, which the
    // decoder's BYOB reader refuses when handed one directly ("This ReadableStream does not
    // support BYOB reads"); it works only because Workers RPC delivers it as a byte stream.
    let t = makeCache();
    let sender = env.LOADER.get("pack-sender", () => ({
      compatibilityDate: "2026-09-04",
      mainModule: "sender.js",
      modules: {
        "sender.js": `
          import { WorkerEntrypoint } from "cloudflare:workers";
          export default class extends WorkerEntrypoint {
            gitPull(pack) {
              let pos = 0;
              return new ReadableStream({
                pull(controller) {
                  if (pos < pack.byteLength) controller.enqueue(pack.slice(pos, pos += 100));
                  else controller.close();
                },
              });
            }
          }`,
      },
    })).getEntrypoint();
    let stored = await t.cache.consumePackFromGatekeeper(G1,
      await sender.gitPull(b64Bytes(PACK_OFS_DELTA)));
    expect(new Set(stored)).toStrictEqual(new Set(PACKED_OIDS));
    for (let oid of PACKED_OIDS) {
      expect(t.cache.readLocalObject(oid)).toStrictEqual(fixture(oid));
    }
  });

  it("writes nothing when the same gatekeeper sends a pack again", async () => {
    // A pull sends no `have`s, so a retried one, or one for another commit of a mounted
    // repository, delivers again what is already stored.
    let t = makeCache();
    let stub = new GitCacheImpl(t.cache, G1);
    let stored = await stub.consumePack(byteStream(b64Bytes(PACK_OFS_DELTA)));
    let objectPuts = vi.spyOn(t.storage.gitObjects, "put");
    let metadataPuts = vi.spyOn(t.storage.gitObjectMetadata, "put");
    expect(await stub.consumePack(byteStream(b64Bytes(PACK_OFS_DELTA)))).toStrictEqual(stored);
    expect(objectPuts).not.toHaveBeenCalled();
    expect(metadataPuts).not.toHaveBeenCalled();

    // Another gatekeeper's copy still records its own proof of possession.
    await new GitCacheImpl(t.cache, G2).consumePack(byteStream(b64Bytes(PACK_OFS_DELTA)));
    expect(t.storage.gitObjectMetadata.get(stored[0])!.onRemote).toStrictEqual([G1, G2]);
  });

  it("rejects corrupt input without storing its commits or trees", async () => {
    let t = makeCache();
    let bytes = b64Bytes(PACK_OFS_DELTA).slice();
    bytes[bytes.length - 3] ^= 0x55;
    await expect(new GitCacheImpl(t.cache, G1).consumePack(byteStream(bytes)))
        .rejects.toThrow(/invalid packfile/);
    // The commits and trees must wait for the trailer: a present commit is treated as mounted.
    for (let oid of PACKED_OIDS.filter(o => fixture(o).type !== "blob")) {
      expect(t.cache.hasLocalObject(oid)).toBe(false);
    }
  });

  it("stores no commit when one of its trees fails to store", async () => {
    // Git only reports mode 100664 as informational, so real histories carry it, but the cache
    // refuses it. The commit comes first, as in the packs git sends.
    let t = makeCache();
    let tree = treePayload([{ mode: "100664", name: "a.txt", oid: "a".repeat(40) }]);
    let commit = commitPayload(gitObjectOid("tree", tree), [], "bad mode\n");
    let pack = concatBytes(await buildPackBytes(
        [{ type: "commit", payload: commit }, { type: "tree", payload: tree }]));
    await expect(new GitCacheImpl(t.cache, G1).consumePack(byteStream(pack)))
        .rejects.toThrow(/corrupt tree object/);
    expect(t.cache.hasLocalObject(gitObjectOid("commit", commit))).toBe(false);
  });

  it("stores an entry of any size, streaming a large blob into chunks", async () => {
    let t = makeCache();
    let big = randomBytes(20 * 1024 * 1024, 11);
    let bigOid = gitObjectOid("blob", big);
    let small = new TextEncoder().encode("small\n");
    let smallOid = gitObjectOid("blob", small);
    let pack = concatBytes(await buildPackBytes(
        [{ type: "blob", payload: big }, { type: "blob", payload: small }]));

    let stored = await new GitCacheImpl(t.cache, G1).consumePack(byteStream(pack, 65536));
    expect(stored).toStrictEqual([bigOid, smallOid]);
    expect(chunksOf(t, bigOid).length).toBeGreaterThan(20);
    expect(sameBytes(t.cache.readBlob(bigOid, big.byteLength), big)).toBe(true);
    let meta = t.storage.gitObjectMetadata.get(bigOid)!;
    expect(meta.size).toBe(big.byteLength);
    expect(meta.onRemote).toStrictEqual([G1]);
    // Chunks are invisible to provenance.
    for (let chunk of chunksOf(t, bigOid)) {
      expect(t.storage.gitObjectMetadata.get(chunk)).toBeUndefined();
    }
  }, 10_000);

  it("writes a streamed blob's chunks outside any transaction", async () => {
    let t = makeCache();
    let big = randomBytes(3 * 1024 * 1024, 12);
    let pack = concatBytes(await buildPackBytes([{ type: "blob", payload: big }]));
    let inTransaction = 0;
    let chunkPutsInTransaction = 0;
    let transaction = t.storage.transaction.bind(t.storage);
    t.storage.transaction = callback => {
      inTransaction++;
      try { return transaction(callback); } finally { inTransaction--; }
    };
    let put = t.storage.gitObjects.put.bind(t.storage.gitObjects);
    t.storage.gitObjects.put = record => {
      if (inTransaction > 0 && !("chunks" in record)) chunkPutsInTransaction++;
      put(record);
    };
    let [oid] = await t.cache.consumePackFromGatekeeper(G1, byteStream(pack));
    expect(chunksOf(t, oid).length).toBeGreaterThan(3);
    expect(chunkPutsInTransaction).toBe(0);
  });

  it("resolves deltas against a large blob, in the pack or already stored", async () => {
    // How git packs a file similar to a large one (e.g. a second lockfile in a whole-tree blob
    // pull), hand-built: the large blob, then a ref-delta copying its first 16 bytes.
    let t = makeCache();
    let big = new Uint8Array(9_000_005).fill(0x7a);
    let bigOid = gitObjectOid("blob", big);
    // A one-blob pack minus its trailer, recounted to two entries.
    let prefix = concatBytes(await buildPackBytes([{ type: "blob", payload: big }])).slice(0, -20);
    new DataView(prefix.buffer).setUint32(8, 2);
    // Delta: base size and target size 16 (varints), then a 16-byte copy from offset 0.
    let varint = (n: number): number[] => n < 0x80 ? [n] : [(n & 0x7f) | 0x80, ...varint(n >>> 7)];
    let delta = new Uint8Array([...varint(big.byteLength), 16, 0x90, 16]);
    let body = concatBytes([prefix, new Uint8Array([(7 << 4) | delta.length]),
      Uint8Array.from(bigOid.match(/../g)!, h => parseInt(h, 16)), deflateSync(delta)]);
    let pack = concatBytes([body, new Uint8Array(await crypto.subtle.digest("SHA-1", body))]);

    let target = big.subarray(0, 16);
    let targetOid = gitObjectOid("blob", target);
    let stored = await new GitCacheImpl(t.cache, G1).consumePack(byteStream(pack));
    expect(stored).toStrictEqual([bigOid, targetOid]);
    expect(t.storage.gitObjects.get(bigOid)).toHaveProperty("chunks");
    expect(t.cache.readLocalObject(targetOid)!.payload).toStrictEqual(target);
    expect(t.storage.gitObjectMetadata.get(bigOid)!.size).toBe(big.byteLength);

    // A thin pack of the delta alone, against the base now in storage.
    let thin = concatBytes([pack.subarray(0, 12), body.subarray(prefix.length)]);
    new DataView(thin.buffer).setUint32(8, 1);
    thin = concatBytes([thin, new Uint8Array(await crypto.subtle.digest("SHA-1", thin))]);
    let u = makeCache();
    await u.cache.putFromGatekeeper(G1, "blob", big);
    expect(await u.cache.consumePackFromGatekeeper(G1, byteStream(thin))).toStrictEqual([targetOid]);
  });
});

// =======================================================================================

describe("importObjects", () => {
  const FILES = new Map([["client.js", "render();\n"], ["lib/util.js", "export {};\n"]]);

  it("stores a release's objects, invisible to every gatekeeper's scoped view", async () => {
    let t = makeCache();
    let { commitId, objects } = buildSnapshotRelease(FILES);
    await t.cache.importObjects(objects.values());

    for (let [oid, object] of objects) {
      expect(t.cache.readLocalObject(oid)).toStrictEqual(object);
      for (let gatekeeperId of [G1, G2]) {
        let stub = new GitCacheImpl(t.cache, gatekeeperId);
        expect(await stub.get(oid)).toBeNull();
        expect(await stub.has(oid)).toBe(false);
        expect(await stub.stat(oid)).toBeNull();
      }
    }
    expect(Array.from(t.storage.gitObjectMetadata.list())).toStrictEqual([]);
    // The workspace's own reads see them like any commit authored here.
    expect(await t.cache.readFileAtCommit(commitId, "lib/util.js")).toBe("export {};\n");
    expect(t.pulls).toHaveLength(0);
  });

  it("leaves an object already held, and its metadata, as they are", async () => {
    let t = makeCache();
    let { objects } = buildSnapshotRelease(FILES);
    let shared = await t.cache.putFromGatekeeper(
        G1, "blob", new TextEncoder().encode("render();\n"));
    expect(objects.has(shared)).toBe(true);
    let metadata = Array.from(t.storage.gitObjectMetadata.list());

    let puts = countPuts(t);
    await t.cache.importObjects(objects.values());
    expect(puts.count).toBe(objects.size - 1);
    expect(Array.from(t.storage.gitObjectMetadata.list())).toStrictEqual(metadata);
    expect(await new GitCacheImpl(t.cache, G1).has(shared)).toBe(true);
    expect(await new GitCacheImpl(t.cache, G2).has(shared)).toBe(false);

    // Importing it all again, each object twice over, writes nothing.
    await t.cache.importObjects([...objects.values(), ...objects.values()]);
    expect(puts.count).toBe(objects.size - 1);
  });

  it("stores each object under the oid of its content", async () => {
    let t = makeCache();
    let payload = new TextEncoder().encode("hello world\n");
    await t.cache.importObjects([{ type: "blob", payload }]);
    // `echo 'hello world' | git hash-object --stdin`
    expect(Array.from(t.storage.gitObjects.list(), record => record.oid))
        .toStrictEqual(["3b18e512dba79e4c8300dd08aeb37f8e728b8dad"]);
  });

  it("imports everything or nothing", async () => {
    let t = makeCache();
    let { objects } = buildSnapshotRelease(FILES);
    let puts = countPuts(t);
    let put = t.storage.gitObjects.put;
    t.storage.gitObjects.put = record => {
      if (puts.count === objects.size - 1) throw new Error("storage refused the record");
      put(record);
    };
    expect(() => t.cache.importObjects(objects.values())).toThrow(/storage refused/);
    expect(puts.count).toBe(objects.size - 1);
    expect(Array.from(t.storage.gitObjects.list())).toStrictEqual([]);
  });
});

// =======================================================================================

describe("lazy walker reads", () => {
  it("reads files and listings that the local history writers wrote", async () => {
    let t = makeCache();
    let files = new Map([
      ["README.md", "# Hello\n"],
      ["src/app.js", "console.log('hi');\n"],
      ["src/lib/util.js", "export const x = 1;\n"],
    ]);
    let commit = await t.cache.writeFilesAsCommit(files, {
      parents: [],
      author: { name: "Alice Example", email: "alice@example.com" },
      message: "initial commit",
      timestamp: new Date(1700000000_000),
    });
    // The id isomorphic-git, which once wrote these, wrote for them.
    expect(commit).toBe("1def0e8e0b443f6fa2b3a9c84f25eb469979ecd1");

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
    expect(t.pulls[0].hints.filterBlobSize).toBeUndefined();

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

  it("pins a file in a cold tree without fetching any blobs, leaving its bytes for a click", async () => {
    const t = makeCache();
    t.sources.set(G1, async (oids, hints) => {
      const objects = hints.filterTreeDepth !== undefined || hints.type === "blob"
          ? oids.map(fixture)
          : FIXTURE_OBJECTS.filter(o => PACKED_OIDS.includes(o.oid))
              .map(o => ({type: o.type, payload: b64Bytes(o.payload)}));
      for (const object of objects) {
        if (object.type === "blob" && hints.filterBlobSize !== undefined &&
            object.payload.byteLength >= hints.filterBlobSize) continue;
        await t.cache.putFromGatekeeper(G1, object.type, object.payload);
      }
    });
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);
    const oid = await t.cache.fileOidAtCommit(COMMIT_1, "src/util.js");
    expect(oid).toBeDefined();
    expect(t.pulls.every(pull => pull.hints.type === "tree")).toBe(true);
    expect(FIXTURE_OBJECTS.filter(o => o.type === "blob").map(o => t.cache.hasLocalObject(o.oid)))
        .not.toContain(true);
    expect(t.storage.gitObjectMetadata.get(oid!)!.pullableFrom).toContain(G1);
    const reader = await t.cache.openBlob(oid!);
    expect(reader.read(0, reader.size)).toEqual(fixture(oid!).payload);
    expect(t.pulls.at(-1)!.oids).toEqual([oid]);
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

  it("pulls a blob that an old oversize rejection measured, like any other", async () => {
    let t = makeCache();
    let big = new Uint8Array(9_000_000).fill(0x61);
    let bigOid = gitObjectOid("blob", big);
    // A metadata row as a rejected put used to leave it: measured, proven, but not stored.
    t.storage.gitObjectMetadata.put({
      oid: bigOid, type: "blob", size: big.byteLength, onRemote: [G1], pullableFrom: [],
      pendingPush: [],
    });
    t.sources.set(G1, async (oids, hints) => {
      expect(oids).toStrictEqual([bigOid]);
      expect(hints.filterBlobSize).toBeUndefined();
      let pack = concatBytes(await buildPackBytes([{ type: "blob", payload: big }]));
      await t.cache.consumePackFromGatekeeper(G1, byteStream(pack, 65536));
    });
    let commit = await commitWithFile(t, "huge.txt", bigOid);
    expect(await t.cache.readFileAtCommit(commit, "huge.txt")).toBe("a".repeat(big.byteLength));
    expect(t.pulls).toHaveLength(1);
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

describe("client-facing reads (readCommitTree / readFilesAtCommit)", () => {
  // The fixture repo with its trees local and every blob still remote, as after a
  // creation-style filtered pull; blob faults are what the tests count.
  async function fixtureWithRemoteBlobs(): Promise<TestCache> {
    let t = makeCache();
    t.sources.set(G1, fixtureSource(t, G1));
    for (let object of FIXTURE_OBJECTS.filter(o => o.type !== "blob")) {
      if (PACKED_OIDS.includes(object.oid)) {
        await t.cache.putFromGatekeeper(G1, object.type, b64Bytes(object.payload));
      }
    }
    return t;
  }

  it("nests the tree in git order with all five kinds, touching no blobs", async () => {
    let t = await fixtureWithRemoteBlobs();
    expect(await t.cache.readCommitTree(COMMIT_1)).toStrictEqual([
      { name: "README.md", kind: "file" },
      { name: "docs", kind: "dir", children: [{ name: "naïve.md", kind: "file" }] },
      { name: "link.md", kind: "symlink" },
      { name: "run.sh", kind: "executable" },
      { name: "src", kind: "dir", children: [
        { name: "big.txt", kind: "file" },
        { name: "main.js", kind: "file" },
        { name: "util.js", kind: "file" },
      ] },
      { name: "vendored", kind: "submodule" },
    ]);
    expect(t.pulls).toHaveLength(0);
  });

  it("faults missing trees eagerly, still without blobs", async () => {
    let t = makeCache();
    t.sources.set(G1, fixtureSource(t, G1));
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);
    let tree = await t.cache.readCommitTree(COMMIT_1);
    expect(tree.map(node => node.name))
        .toStrictEqual(["README.md", "docs", "link.md", "run.sh", "src", "vendored"]);
    expect(t.pulls.length).toBeGreaterThan(0);
    expect(t.pulls.every(pull => pull.hints.type === "tree")).toBe(true);
  });

  it("answers every requested path in request order, pulling all blobs in one batch",
      async () => {
    let t = await fixtureWithRemoteBlobs();
    let paths = ["src/util.js", "nope.txt", "src", "link.md", "vendored", "docs/naïve.md",
                 "no/such/dir/file.txt", "README.md/child", "README.md", "src/util.js"];
    let result = await t.cache.readFilesAtCommit(COMMIT_1, paths);
    expect(result).toStrictEqual([
      ["src/util.js", { kind: "text", text: "export const answer = 42;\n" }],
      ["nope.txt", { kind: "absent" }],
      ["src", { kind: "absent" }],
      ["link.md", { kind: "unreadable", message: "link.md is a symlink to README.md" }],
      ["vendored", { kind: "unreadable", message:
          `vendored is a submodule (gitlink) pointing at commit ${GITLINK_TARGET}` }],
      ["docs/naïve.md", { kind: "text", text: "naïve UTF-8 name\n" }],
      ["no/such/dir/file.txt", { kind: "absent" }],
      ["README.md/child", { kind: "absent" }],
      ["README.md", { kind: "text", text: "# Fixture\n" }],
      // A duplicate answers twice.
      ["src/util.js", { kind: "text", text: "export const answer = 42;\n" }],
    ]);
    // One blob pull for the four blobs (util.js, the symlink target, naïve.md, README.md).
    expect(t.pulls).toHaveLength(1);
    expect(t.pulls[0].hints.type).toBe("blob");
    expect([...t.pulls[0].oids].toSorted()).toStrictEqual([
      "42061c01a1c70097d1e4579f29a5adf40abdec95",  // link.md -> "README.md"
      "64a32fd291e405a963aacf964a021809dd206c46",  // src/util.js
      "78a3978560a66a1d3c14215ecbf2be19d70c5c43",  // docs/naïve.md
      "ca69e6d08b5b8bb4f11a74f9695e329c203cbfd8",  // README.md
    ]);
    // Everything is local now: a second read faults nothing.
    await t.cache.readFilesAtCommit(COMMIT_1, ["README.md", "src/main.js"]);
    expect(t.pulls).toHaveLength(2);  // main.js was not in the first batch
    await t.cache.readFilesAtCommit(COMMIT_1, ["README.md", "src/main.js"]);
    expect(t.pulls).toHaveLength(2);
  });

  it("names binary content and a large file by their blobs", async () => {
    let t = makeCache();
    let huge = new Uint8Array(9_000_000).fill(0x61);
    let hugeOid = gitObjectOid("blob", huge);
    let text = new TextEncoder().encode("hello\n");
    let textOid = gitObjectOid("blob", text);
    let binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    let binaryOid = gitObjectOid("blob", binary);
    t.sources.set(G1, async (oids, hints) => {
      expect(hints.filterBlobSize).toBeUndefined();
      for (let oid of oids) {
        let payload = oid === hugeOid ? huge : oid === textOid ? text
            : oid === binaryOid ? binary : undefined;
        if (payload === undefined) throw new Error(`test: unexpected want ${oid}`);
        await t.cache.putFromGatekeeper(G1, "blob", payload);
      }
    });
    let tree = await t.cache.putFromGatekeeper(G1, "tree", treePayload([
      { mode: "100644", name: "binary.png", oid: binaryOid },
      { mode: "100644", name: "huge.txt", oid: hugeOid },
      { mode: "100644", name: "text.txt", oid: textOid },
    ]));
    let commit = await t.cache.putFromGatekeeper(G1, "commit", commitPayload(tree, [], "mixed"));
    t.pulls.length = 0;

    expect(await t.cache.readFilesAtCommit(commit, ["text.txt", "binary.png", "huge.txt"]))
        .toStrictEqual([
      ["text.txt", { kind: "text", text: "hello\n" }],
      ["binary.png", { kind: "blob", blob: { oid: binaryOid, byteLength: binary.byteLength } }],
      ["huge.txt", { kind: "blob", blob: { oid: hugeOid, byteLength: huge.byteLength } }],
    ]);
    // One batch, no retry round trip.
    expect(t.pulls).toHaveLength(1);
    expect([...t.pulls[0].oids].toSorted())
        .toStrictEqual([hugeOid, textOid, binaryOid].toSorted());
  });

  it("stops after the response budget, omitting the rest for the client to re-request",
      async () => {
    let t = makeCache();
    const FILE_SIZE = READ_FILES_RESPONSE_BUDGET / 8;
    let blob = await storeLocal(t.storage,
        { type: "blob", payload: new Uint8Array(FILE_SIZE).fill(0x61) });
    let names = Array.from({ length: 10 }, (_, i) => `f${i}.txt`);
    let tree = await storeLocal(t.storage, {
      type: "tree",
      payload: treePayload(names.map(name => ({ mode: "100644", name, oid: blob }))),
    });
    let commit = await storeLocal(t.storage,
        { type: "commit", payload: commitPayload(tree, [], "big") });

    // Eight files fill the budget exactly; the ninth pushes past it and is still delivered;
    // the tenth is omitted (not reported absent).
    let result = await t.cache.readFilesAtCommit(commit, names);
    expect(result.map(([path]) => path)).toStrictEqual(names.slice(0, 9));
    expect(result.every(([, file]) =>
        file.kind === "text" && file.text.length === FILE_SIZE)).toBe(true);
    expect(t.pulls).toHaveLength(0);
  });

  it("names a file just over MAX_BUFFERED_BLOB_SIZE by its blob, outside the response budget",
      async () => {
    let t = makeCache();
    let exact = new Uint8Array(MAX_BUFFERED_BLOB_SIZE).fill(0x62);
    // Text, but over the limit, so it is not decoded.
    let over = new Uint8Array(MAX_BUFFERED_BLOB_SIZE + 1).fill(0x63);
    let exactOid = await storeLocal(t.storage, { type: "blob", payload: exact });
    let overOid = await storeLocal(t.storage, { type: "blob", payload: over });
    // Eight buffered files fill the budget exactly, so a ninth would be the last one answered;
    // the named ones in between do not count.
    let entries = [
      ...Array.from({ length: 8 }, (_, i) => ({ mode: "100644" as const, name: `a${i}`, oid: exactOid })),
      ...Array.from({ length: 4 }, (_, i) => ({ mode: "100644" as const, name: `b${i}`, oid: overOid })),
      { mode: "100644" as const, name: "c", oid: exactOid },
      { mode: "100644" as const, name: "d", oid: exactOid },
    ];
    let tree = await storeLocal(t.storage, { type: "tree", payload: treePayload(entries) });
    let commit = await storeLocal(t.storage,
        { type: "commit", payload: commitPayload(tree, [], "sizes") });
    let names = entries.map(entry => entry.name);
    let result = await t.cache.readFilesAtCommit(commit, names);
    expect(result.map(([path, file]) => [path, file.kind])).toStrictEqual([
      ...names.slice(0, 8).map(name => [name, "text"]),
      ...names.slice(8, 12).map(name => [name, "blob"]),
      ["c", "text"],
    ]);
    for (let [, file] of result.slice(8, 12)) {
      expect(file).toStrictEqual({ kind: "blob", blob: { oid: overOid, byteLength: over.length } });
    }
  });

  it("fails the whole call on a pull failure rather than answering per file", async () => {
    let t = await fixtureWithRemoteBlobs();
    t.sources.delete(G1);  // provenance loss: the only source is gone
    await expect(t.cache.readFilesAtCommit(COMMIT_1, ["README.md", "nope.txt"]))
        .rejects.toThrow(/Could not pull git object/);
  });
});

// =======================================================================================

describe("changedFilePathsBetween", () => {
  // A tree, described as nested objects: a string is a regular file's text, an object a
  // directory. An `Executable` is a file of mode 100755, and a `Subtree` names a tree by id,
  // stored or not.
  class Executable { constructor(readonly text: string) {} }
  class Subtree { constructor(readonly oid: GitOid) {} }
  type TreeSpec = { [name: string]: string | Executable | Subtree | TreeSpec };

  async function storeTree(t: TestCache, spec: TreeSpec): Promise<GitOid> {
    let storeBlob = async (text: string) =>
        await storeLocal(t.storage, { type: "blob", payload: new TextEncoder().encode(text) });
    let entries: GitTreeEntry[] = [];
    for (let [name, value] of Object.entries(spec)) {
      if (typeof value === "string") {
        entries.push({ mode: "100644", name, oid: await storeBlob(value) });
      } else if (value instanceof Executable) {
        entries.push({ mode: "100755", name, oid: await storeBlob(value.text) });
      } else if (value instanceof Subtree) {
        entries.push({ mode: "40000", name, oid: value.oid });
      } else {
        entries.push({ mode: "40000", name, oid: await storeTree(t, value) });
      }
    }
    return await storeLocal(t.storage, { type: "tree", payload: encodeGitTree(entries) });
  }
  async function storeTreeCommit(t: TestCache, spec: TreeSpec): Promise<GitOid> {
    return await storeLocal(t.storage,
        { type: "commit", payload: commitPayload(await storeTree(t, spec), [], "tree commit") });
  }

  it("lists added, removed and changed files at any depth, and a change of mode", async () => {
    let t = makeCache();
    let before = await storeTreeCommit(t, {
      "keep.js": "keep\n",
      "edit.js": "edit\n",
      "gone.js": "gone\n",
      "run.sh": "#!/bin/sh\n",
      "src": { "top.js": "top\n", "lib": { "deep.js": "deep\n", "same.js": "same\n" } },
      "docs": { "old.md": "old\n" },
      "shape": "a file\n",
    });
    let after = await storeTreeCommit(t, {
      "keep.js": "keep\n",
      "edit.js": "edited\n",
      "run.sh": new Executable("#!/bin/sh\n"),
      "new.js": "new\n",
      "src": { "top.js": "top\n",
               "lib": { "deep.js": "deeper\n", "same.js": "same\n", "added.js": "added\n" } },
      "shape": { "inner.js": "a file\n" },
    });
    let expected = new Set([
      "edit.js", "gone.js", "run.sh", "new.js", "src/lib/deep.js", "src/lib/added.js",
      "docs/old.md", "shape", "shape/inner.js",
    ]);
    expect(await t.cache.changedFilePathsBetween(before, after)).toStrictEqual(expected);
    expect(await t.cache.changedFilePathsBetween(after, before)).toStrictEqual(expected);
    // The local-only form walks the same trees.
    expect(await t.cache.changedLocalFilePathsBetween(before, after)).toStrictEqual(expected);
    expect(await t.cache.changedLocalFilePathsBetween(after, before)).toStrictEqual(expected);
    expect(t.pulls).toHaveLength(0);
  });

  it("does not read a subtree that is the same on both sides", async () => {
    let t = makeCache();
    // Held nowhere: reading it would fail, as there is no source to pull it from.
    let unheld = "ab".repeat(20);
    let before = await storeTreeCommit(t, { "a.js": "a\n", "vendor": new Subtree(unheld) });
    let after = await storeTreeCommit(t, { "a.js": "A\n", "vendor": new Subtree(unheld) });
    expect(await t.cache.changedFilePathsBetween(before, after)).toStrictEqual(new Set(["a.js"]));
    // Nor is a commit compared with itself read at all.
    expect(await t.cache.changedFilePathsBetween(unheld, unheld)).toStrictEqual(new Set());
    expect(t.pulls).toHaveLength(0);
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

  it("readFileAtCommitWithOid / fileOidAtCommit report the blob's content address", async () => {
    let t = makeCache();
    t.sources.set(G1, fixtureSource(t, G1));
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);

    // The read's oid is the content's address: computable from the text alone, and equal to
    // what fileOidAtCommit reports for the same path -- with no blob read on that side.
    let read = (await t.cache.readFileAtCommitWithOid(COMMIT_1, "README.md"))!;
    expect(read.text).toBe("# Fixture\n");
    expect(read.oid).toBe(blobOid(read.text));
    expect(await t.cache.fileOidAtCommit(COMMIT_1, "README.md")).toBe(read.oid);
    expect(t.pulls.some(pull => pull.oids.includes(read.oid))).toBe(true);  // the read pulled it
    let main = (await t.cache.fileOidAtCommit(COMMIT_1, "src/main.js"))!;
    expect(t.pulls.some(pull => pull.oids.includes(main))).toBe(false);  // the blob: never read
    expect(t.cache.hasLocalObject(main)).toBe(false);

    // A saved message needs only this OID: the existing metadata survives the path changing,
    // and the download RPC's openBlob pulls the exact bytes when the viewer clicks.
    expect(t.storage.gitObjectMetadata.get(main)!.pullableFrom).toContain(G1);
    let reader = await t.cache.openBlob(main);
    expect(reader.read(0, reader.size)).toEqual(fixture(main).payload);
    expect(t.pulls.some(pull => pull.oids.includes(main))).toBe(true);

    // Commit 2 rewrote README.md and left src/main.js alone: the freshness question an edit
    // asks, answered per file by oid equality.
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_2).payload);
    expect(await t.cache.fileOidAtCommit(COMMIT_2, "README.md")).not.toBe(read.oid);
    expect(await t.cache.fileOidAtCommit(COMMIT_2, "src/main.js")).toBe(main);

    // Only regular files have an oid here: absent, directory, symlink, gitlink are undefined.
    for (let path of ["nope.txt", "src", "link.md", "vendored"]) {
      expect(await t.cache.fileOidAtCommit(COMMIT_1, path)).toBeUndefined();
    }
    expect(await t.cache.readFileAtCommitWithOid(COMMIT_1, "nope.txt")).toBeUndefined();
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

  it("assertWorktreePathWritable passes a base blob it never reads (a set needs no base)",
      async () => {
    let t = makeCache();
    let bigOid = "b".repeat(40);
    let tree = await storeLocal(t.storage, {
      type: "tree",
      payload: treePayload([{ mode: "100644", name: "huge.txt", oid: bigOid }]),
    });
    let commit = await storeLocal(t.storage,
        { type: "commit", payload: commitPayload(tree, [], "huge") });
    await t.cache.assertWorktreePathWritable(commit, "huge.txt");
  });
});

describe("resolveCommitId", () => {
  it("resolves only full, exact commit ids", async () => {
    let t = makeCache();
    let tree = await storeLocal(t.storage, { type: "tree", payload: treePayload([]) });
    let commit = await storeLocal(t.storage,
        { type: "commit", payload: commitPayload(tree, [], "local") });
    let remote = "aaaa1111".padEnd(40, "0");
    t.storage.gitObjectMetadata.put(
        { oid: remote, type: "blob", onRemote: [G1], pullableFrom: [], pendingPush: [] });

    expect(t.cache.resolveCommitId(commit)).toBe(commit);
    // The reader rule: an id known only from metadata resolves regardless of its recorded type
    // (the caller's pull lets the decoded bytes decide).
    expect(t.cache.resolveCommitId(remote)).toBe(remote);
    for (let id of [commit.slice(0, 8), commit.slice(0, 39), commit.toUpperCase(), "main"]) {
      expect(() => t.cache.resolveCommitId(id)).toThrow(/not a full git commit id/);
    }
    expect(() => t.cache.resolveCommitId("feed".repeat(10))).toThrow(/not known/);
    expect(() => t.cache.resolveCommitId(tree)).toThrow(`${tree} is a tree, not a commit.`);
  });
});

// Deterministic pseudo-random bytes (xorshift32, top byte of each state).
function randomBytes(size: number, seed: number): Uint8Array {
  let out = new Uint8Array(size);
  let s = seed >>> 0;
  for (let i = 0; i < size; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = s >>> 24;
  }
  return out;
}

async function contentBytes(content: Uint8Array | ReadableStream<Uint8Array>)
    : Promise<Uint8Array> {
  if (content instanceof Uint8Array) return content;
  return new Uint8Array(await new Response(content).arrayBuffer());
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength)
      .equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

function chunksOf(t: TestCache, oid: GitOid): GitOid[] {
  let record = t.storage.gitObjects.get(oid);
  if (record === undefined || !("chunks" in record)) throw new Error(`${oid} is not chunked`);
  return record.chunks.map(chunk => chunk.oid);
}

// A commit whose tree holds one file, `name`, with the given blob.
async function commitWithFile(t: TestCache, name: string, blob: GitOid): Promise<GitOid> {
  let tree = await storeLocal(t.storage, {
    type: "tree",
    payload: treePayload([{ mode: "100644", name, oid: blob }]),
  });
  return await storeLocal(t.storage, { type: "commit", payload: commitPayload(tree, [], name) });
}

describe("chunked blob storage", () => {
  const MiB = 1024 * 1024;

  // A stream of `data` in pieces of `piece` bytes, plus whether it was cancelled.
  function streamOf(data: Uint8Array, piece: number) {
    let state = { cancelled: false };
    let pos = 0;
    let stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pos >= data.length) controller.close();
        else controller.enqueue(data.slice(pos, pos += piece));
      },
      cancel() { state.cancelled = true; },
    });
    return { stream, state };
  }

  it("writes a stream as the same blob writeBlob writes, with or without its length",
      async () => {
    for (let size of [0, 10, CHUNK_MAX_SIZE, CHUNK_MAX_SIZE + 1, 7 * MiB + 3]) {
      let t = makeCache();
      let data = randomBytes(size, size);
      let expected = { oid: gitObjectOid("blob", data), byteLength: size };
      expect(await t.cache.writeBlobStream(streamOf(data, 333_333).stream, size)).toEqual(expected);
      expect(await t.cache.writeBlobStream(streamOf(data, 1_000_003).stream)).toEqual(expected);
      expect(await t.cache.writeBlob(data)).toEqual(expected);
      expect(sameBytes(t.cache.readBlob(expected.oid, size), data)).toBe(true);
      expect(t.storage.gitObjects.get(expected.oid) !== undefined &&
          "chunks" in t.storage.gitObjects.get(expected.oid)!).toBe(size > CHUNK_MAX_SIZE);
    }
  });

  it("fails a stream that ends short of or runs past its length, storing no blob", async () => {
    let t = makeCache();
    let data = randomBytes(3 * MiB, 4);
    let oid = gitObjectOid("blob", data);
    await expect(t.cache.writeBlobStream(streamOf(data, 100_000).stream, data.length + 1))
        .rejects.toThrow("smaller than its declared size");
    let long = streamOf(data, 100_000);
    await expect(t.cache.writeBlobStream(long.stream, MiB))
        .rejects.toThrow("larger than its declared size");
    expect(long.state.cancelled).toBe(true);  // read no further than the overrun
    expect(t.cache.hasLocalObject(oid)).toBe(false);
  });

  it("opens a file at a commit for reading in pieces, with the path rules of a text read",
      async () => {
    let t = makeCache();
    let data = randomBytes(3 * MiB, 5);
    data[17] = 0;  // binary: no content rule applies
    let blob = await storeLocal(t.storage, { type: "blob", payload: data });
    let commit = await commitWithFile(t, "big.bin", blob);
    let opened = (await t.cache.openFileAtCommit(commit, "big.bin"))!;
    expect(opened.oid).toBe(blob);
    expect(sameBytes(opened.reader.read(MiB, 10), data.subarray(MiB, MiB + 10))).toBe(true);
    expect(await t.cache.openFileAtCommit(commit, "nope")).toBeUndefined();
    await expect(t.cache.readFileAtCommitWithOid(commit, "big.bin"))
        .rejects.toThrow("big.bin is not a text file");
    expect((await t.cache.openBlob(blob)).size).toBe(data.length);
  });

  it("writes a repeated large blob once, and shares chunks between edited versions", async () => {
    let t = makeCache();
    let data = randomBytes(6 * MiB, 1);
    let ref = await t.cache.writeBlob(data);
    let chunks = chunksOf(t, ref.oid);
    expect(chunks.length).toBeGreaterThan(10);
    let rows = [...t.storage.gitObjects.list()].length;
    expect(rows).toBe(new Set(chunks).size + 1);

    let puts = countPuts(t);
    expect(await t.cache.writeBlob(data)).toEqual(ref);
    expect(puts.count).toBe(0);

    let mid = 3 * MiB + 777;
    let edited = concatBytes([data.subarray(0, mid), randomBytes(100, 2), data.subarray(mid)]);
    let editedRef = await t.cache.writeBlob(edited);
    let shared = chunksOf(t, editedRef.oid).filter(oid => chunks.includes(oid)).length;
    expect(shared).toBeGreaterThanOrEqual(chunksOf(t, editedRef.oid).length - 3);
    expect(puts.count).toBeLessThanOrEqual(4);  // at most 3 new chunks, plus the index row
    expect(sameBytes(t.cache.readBlob(editedRef.oid), edited)).toBe(true);
  });

  it("reads a legacy 8 MB inline row whole and in pieces", async () => {
    let t = makeCache();
    let data = randomBytes(8_000_000, 3);
    let oid = await storeLocal(t.storage, { type: "blob", payload: data });
    expect(t.storage.gitObjects.get(oid)).toHaveProperty("data");
    expect(sameBytes(t.cache.readLocalObject(oid)!.payload, data)).toBe(true);
    let reader = t.cache.openLocalBlob(oid)!;
    expect(reader.size).toBe(data.length);
    expect(sameBytes(reader.read(5_000_000, 1000), data.subarray(5_000_000, 5_001_000)))
        .toBe(true);
    expect(t.cache.blobSize(oid)).toBe(data.length);
    expect(t.cache.localObjectType(oid)).toBe("blob");
  });

  it("reads a legacy inline blob over 8 MB whole: stored data is readable", async () => {
    let t = makeCache();
    // Compressible, so it fit one row before chunking existed.
    let text = "a".repeat(8_000_001);
    let data = new TextEncoder().encode(text);
    let oid = await storeLocal(t.storage, { type: "blob", payload: data });
    expect(t.storage.gitObjects.get(oid)).toHaveProperty("data");
    expect(t.cache.readLocalObject(oid)!.payload.byteLength).toBe(data.length);
    expect(t.cache.readBlob(oid, data.length).byteLength).toBe(data.length);
    expect(t.cache.blobSize(oid)).toBe(data.length);

    let commit = await commitWithFile(t, "big.txt", oid);
    expect(await t.cache.readFileAtCommit(commit, "big.txt")).toBe(text);
    expect(await t.cache.readTextBlob(oid, undefined, "big.txt")).toBe(text);
    expect(await t.cache.readFilesAtCommit(commit, ["big.txt"]))
        .toStrictEqual([["big.txt", { kind: "blob", blob: { oid, byteLength: data.length } }]]);
    expect(await t.cache.fileBytesAtCommit(commit, "big.txt"))
        .toEqual({ oid, byteLength: data.length });
    expect(t.pulls).toHaveLength(0);
  });

  it("reads a large chunked blob whole and in pieces, and walks past it without reading it",
      async () => {
    let t = makeCache();
    let data = randomBytes(9 * MiB, 4);
    let { oid } = await t.cache.writeBlob(data);
    expect(sameBytes(t.cache.readLocalObject(oid)!.payload, data)).toBe(true);
    expect(t.cache.hasLocalObject(oid)).toBe(true);
    expect(t.cache.localObjectType(oid)).toBe("blob");
    expect(t.cache.blobSize(oid)).toBe(data.length);

    let commit = await commitWithFile(t, "big.bin", oid);
    expect(await t.cache.readFileAtCommit(commit, "big.bin")
        .catch((err: Error) => err.message)).toBe("big.bin is not a text file");
    expect(await t.cache.fileBytesAtCommit(commit, "big.bin"))
        .toEqual({ oid, byteLength: data.length });

    // Walks over arbitrary oids see it as a blob without assembling it.
    let get = t.storage.gitObjects.get.bind(t.storage.gitObjects);
    let chunkReads = 0;
    let chunks = new Set(chunksOf(t, oid));
    t.storage.gitObjects.get = key => {
      if (chunks.has(key)) chunkReads++;
      return get(key);
    };
    expect(() => t.cache.resolveCommitId(oid)).toThrow(`${oid} is a blob, not a commit.`);
    expect(() => t.cache.isAncestor(commit, oid)).toThrow(/not a commit/);
    expect(t.cache.isAncestor(oid, commit)).toBe(false);
    await expect(t.cache.ensureObject(oid, { type: "tree" })).rejects.toThrow(/is a blob/);
    expect(t.cache.blobSize(oid)).toBe(data.length);
    expect(chunkReads).toBe(0);
  });

  it("marks a commit holding a large blob for push without throwing, and no chunk", async () => {
    let t = makeCache();
    let data = randomBytes(3 * MiB, 5);
    let ref = await t.cache.writeBlob(data);
    let commit = await t.cache.writeFilesAsCommit(new Map([["big.bin", ref]]), {
      parents: [], author: { name: "A", email: "a@b" }, message: "m", timestamp: new Date(0),
    });
    t.cache.markPushClosure(G2, ACTION, [commit]);
    let marks = listMarks(t.storage, ACTION);
    expect(marks).toContain(ref.oid);
    expect(marks).toHaveLength(3);  // the commit, its tree, the blob
    for (let chunk of chunksOf(t, ref.oid)) {
      expect(t.storage.gitObjectMetadata.get(chunk)).toBeUndefined();
    }
  });

  it("serves a gatekeeper's chunked blob, but never its chunks", async () => {
    let t = makeCache();
    let data = randomBytes(3 * MiB, 6);
    let stub = new GitCacheImpl(t.cache, G1);
    let oid = await stub.put("blob", data);
    expect(t.storage.gitObjects.get(oid)).toHaveProperty("chunks");
    expect(sameBytes(await contentBytes((await stub.get(oid))!.content), data)).toBe(true);
    expect(await stub.has(oid)).toBe(true);
    expect(await stub.stat(oid)).toEqual({ type: "blob", size: data.length });
    for (let chunk of chunksOf(t, oid)) {
      expect(t.cache.hasLocalObject(chunk)).toBe(true);
      expect(await stub.get(chunk)).toBeNull();
      expect(await stub.has(chunk)).toBe(false);
      expect(await stub.stat(chunk)).toBeNull();
      expect(t.storage.gitObjectMetadata.get(chunk)).toBeUndefined();
    }
  });

  it("stores a large blob from a pack chunked", async () => {
    let t = makeCache();
    let data = randomBytes(3 * MiB, 7);
    let oid = gitObjectOid("blob", data);
    let pack = concatBytes(await buildPackBytes([{ type: "blob", payload: data }]));
    expect(await t.cache.consumePackFromGatekeeper(G1, byteStream(pack, 65536)))
        .toStrictEqual([oid]);
    expect(chunksOf(t, oid).length).toBeGreaterThan(3);
    expect(sameBytes(t.cache.readBlob(oid, data.length), data)).toBe(true);
    expect(t.storage.gitObjectMetadata.get(oid)).toMatchObject({ onRemote: [G1], size: data.length });
  });

  it("streams a pushed chunked blob into the pack without assembling it", async () => {
    let t = makeCache();
    let data = randomBytes(5 * MiB, 8);
    let ref = await t.cache.writeBlob(data);
    let commit = await t.cache.writeFilesAsCommit(new Map([["big.bin", ref]]), {
      parents: [], author: { name: "A", email: "a@b" }, message: "m", timestamp: new Date(0),
    });
    t.cache.markPushClosure(G2, ACTION, [commit]);
    let read = vi.spyOn(BlobReader.prototype, "read");
    let pack = await collect(await new GitCacheImpl(t.cache, G2, ACTION).buildPack());
    expect(read.mock.calls.filter(([, length]) => length > CHUNK_MAX_SIZE)).toStrictEqual([]);
    read.mockRestore();

    let u = makeCache();
    let stored = await u.cache.consumePackFromGatekeeper(G2, byteStream(pack, 65536));
    expect(new Set(stored)).toStrictEqual(new Set(listMarks(t.storage, ACTION)));
    expect(stored).toContain(ref.oid);
    expect(sameBytes(u.cache.readBlob(ref.oid, data.length), data)).toBe(true);
  });

  it("gets a blob buffered up to MAX_BUFFERED_BLOB_SIZE, and streamed over it", async () => {
    expect(MAX_BUFFERED_BLOB_SIZE).toBe(CHUNK_MAX_SIZE);
    let t = makeCache();
    let stub = new GitCacheImpl(t.cache, G1);
    let exact = randomBytes(MAX_BUFFERED_BLOB_SIZE, 9);
    let over = randomBytes(MAX_BUFFERED_BLOB_SIZE + 1, 10);
    let exactOid = await stub.put("blob", exact);
    let overOid = await stub.put("blob", over);
    expect(t.storage.gitObjects.get(overOid)).toHaveProperty("chunks");
    // A legacy inline row over the size streams too: the rule is by size, not storage form.
    let legacy = randomBytes(3_000_000, 11);
    let legacyOid = await storeLocal(t.storage, { type: "blob", payload: legacy });
    t.storage.gitObjectMetadata.put({ oid: legacyOid, type: "blob", size: legacy.length,
      onRemote: [G1], pullableFrom: [], pendingPush: [] });

    let exactGot = (await stub.get(exactOid))!;
    expect(exactGot.content).toBeInstanceOf(Uint8Array);
    expect(sameBytes(exactGot.content as Uint8Array, exact)).toBe(true);
    for (let [oid, data] of [[overOid, over], [legacyOid, legacy]] as const) {
      let got = (await stub.get(oid))!;
      expect(got.type).toBe("blob");
      expect(got.content).toBeInstanceOf(ReadableStream);
      expect(sameBytes(await contentBytes(got.content), data)).toBe(true);
    }
  });

  it("answers has() and stat() of a chunked blob without reading its chunks", async () => {
    let t = makeCache();
    let data = randomBytes(4 * MiB, 12);
    let stub = new GitCacheImpl(t.cache, G1);
    let oid = await stub.put("blob", data);
    let chunks = new Set(chunksOf(t, oid));
    let chunkReads = 0;
    let get = t.storage.gitObjects.get.bind(t.storage.gitObjects);
    t.storage.gitObjects.get = key => {
      if (chunks.has(key)) chunkReads++;
      return get(key);
    };
    expect(await stub.has(oid)).toBe(true);
    expect(await stub.stat(oid)).toEqual({ type: "blob", size: data.length });
    expect(chunkReads).toBe(0);
    // A get() hands back a stream, which reads chunks only as it is consumed.
    let got = (await stub.get(oid))!;
    expect(chunkReads).toBe(0);
    await (got.content as ReadableStream<Uint8Array>).cancel();
  });
});

// The message of what `read` throws, or rejects with.
async function thrownBy(read: () => unknown): Promise<string> {
  try {
    await read();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a throw");
}

// What a local-only read throws for an object the store does not hold.
const notStored = (oid: GitOid) => `${oid} is not in the workspace's git store.`;

describe("local-only reads", () => {
  // The fixture repo stored whole, every object attributed to G1, which could serve them again.
  async function fixtureStoredLocally(): Promise<TestCache> {
    let t = makeCache();
    t.sources.set(G1, fixtureSource(t, G1));
    for (let object of FIXTURE_OBJECTS) {
      if (PACKED_OIDS.includes(object.oid)) {
        await t.cache.putFromGatekeeper(G1, object.type, b64Bytes(object.payload));
      }
    }
    return t;
  }

  it("give a commit's tree as the pulling read gives it, without pulling", async () => {
    let t = await fixtureStoredLocally();
    expect(t.cache.readLocalCommitTree(COMMIT_1))
        .toStrictEqual(await t.cache.readCommitTree(COMMIT_1));
    expect(t.pulls).toStrictEqual([]);
  });

  it("throw naming a missing tree, rather than pulling it from a source that has it",
      async () => {
    // Only the commit is stored, its tree pullable from G1.
    let t = makeCache();
    t.sources.set(G1, fixtureSource(t, G1));
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);
    expect(() => t.cache.readLocalCommitTree(COMMIT_1))
        .toThrow(`The tree ${TREE_1} is not in the workspace's git store.`);

    // The trees stored, every blob still pullable from G1: a tree read needs none of them.
    for (let object of FIXTURE_OBJECTS.filter(o => o.type === "tree")) {
      if (PACKED_OIDS.includes(object.oid)) {
        await t.cache.putFromGatekeeper(G1, object.type, b64Bytes(object.payload));
      }
    }
    expect(t.cache.readLocalCommitTree(COMMIT_1).map(node => node.name))
        .toStrictEqual(["README.md", "docs", "link.md", "run.sh", "src", "vendored"]);
    expect(t.pulls).toStrictEqual([]);
  });

  it("read a file's text and a path's entry as the pulling reads do, without pulling",
      async () => {
    let t = await fixtureStoredLocally();
    let readable = ["README.md", "src/util.js", "nope.txt", "no/such/file.txt", "README.md/child",
                    "src", "run.sh"];
    for (let path of readable) {
      expect(t.cache.readLocalFileAtCommitIfExists(COMMIT_1, path))
          .toBe(await t.cache.readFileAtCommitIfExists(COMMIT_1, path));
    }
    // The rest name nothing, run through a file, or name a directory.
    expect(readable.filter(
        path => t.cache.readLocalFileAtCommitIfExists(COMMIT_1, path) !== undefined))
        .toStrictEqual(["README.md", "src/util.js", "run.sh"]);

    expect(await thrownBy(() => t.cache.readLocalFileAtCommitIfExists(COMMIT_1, "vendored")))
        .toBe(await thrownBy(() => t.cache.readFileAtCommitIfExists(COMMIT_1, "vendored")));
    expect(() => t.cache.readLocalFileAtCommitIfExists(COMMIT_1, "vendored"))
        .toThrow(`vendored is a submodule (gitlink) pointing at commit ${GITLINK_TARGET}`);

    let paths = [...readable, "link.md", "vendored"];
    for (let path of paths) {
      let pulled = await t.cache.pathEntryAtCommit(COMMIT_1, path);
      expect(t.cache.localPathEntryAtCommit(COMMIT_1, path))
          .toStrictEqual(pulled && { kind: pulled.kind, oid: pulled.oid });
    }
    expect(paths.map(path => t.cache.localPathEntryAtCommit(COMMIT_1, path)?.kind)).toStrictEqual(
        ["file", "file", undefined, undefined, undefined, "dir", "executable", "symlink",
         "submodule"]);
    expect(t.pulls).toStrictEqual([]);
  });

  it("read one file for an admin: text, a stream, absent or unreadable, without pulling",
      async () => {
    let t = await fixtureStoredLocally();
    expect(t.cache.readLocalFileAtCommit(COMMIT_1, "README.md")).toStrictEqual(
        { kind: "text", text: await t.cache.readFileAtCommitIfExists(COMMIT_1, "README.md") });
    expect(t.cache.readLocalFileAtCommit(COMMIT_1, "run.sh")).toStrictEqual(
        { kind: "text", text: await t.cache.readFileAtCommitIfExists(COMMIT_1, "run.sh") });
    // A path naming nothing, one that runs through a file, and a directory.
    for (let path of ["nope.txt", "no/such/file.txt", "README.md/child", "src"]) {
      expect(t.cache.readLocalFileAtCommit(COMMIT_1, path), path)
          .toStrictEqual({ kind: "absent" });
    }
    // What the pulling read reports of a symlink and of a submodule, the link's target quoted.
    let pulled = new Map(await t.cache.readFilesAtCommit(COMMIT_1, ["link.md", "vendored"]));
    expect(t.cache.readLocalFileAtCommit(COMMIT_1, "link.md")).toStrictEqual(
        { kind: "unreadable", message: "link.md is a symlink to README.md" });
    expect(t.cache.readLocalFileAtCommit(COMMIT_1, "link.md")).toStrictEqual(pulled.get("link.md"));
    expect(t.cache.readLocalFileAtCommit(COMMIT_1, "vendored")).toStrictEqual({
      kind: "unreadable",
      message: `vendored is a submodule (gitlink) pointing at commit ${GITLINK_TARGET}`,
    });
    expect(t.cache.readLocalFileAtCommit(COMMIT_1, "vendored"))
        .toStrictEqual(pulled.get("vendored"));
    for (let path of ["../escape", "src//util.js", "", "./README.md"]) {
      expect(() => t.cache.readLocalFileAtCommit(COMMIT_1, path), path)
          .toThrow(/invalid file path/);
    }
    expect(t.pulls).toStrictEqual([]);
  });

  it("stream for an admin a file over MAX_BUFFERED_BLOB_SIZE or one that is not text, " +
      "reading whole only a file at most that size", async () => {
    let t = makeCache();
    let exact = new Uint8Array(MAX_BUFFERED_BLOB_SIZE).fill(0x62);
    // Text, but over the size a file is read whole at: never decoded, so never held whole.
    let over = new Uint8Array(MAX_BUFFERED_BLOB_SIZE + 1).fill(0x63);
    let binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    let invalid = new Uint8Array([0xff, 0xfe, 0x41]);
    let blob = (payload: Uint8Array) => storeLocal(t.storage, { type: "blob", payload });
    let tree = await storeLocal(t.storage, {
      type: "tree",
      payload: treePayload([
        { mode: "100644", name: "exact.txt", oid: await blob(exact) },
        { mode: "100644", name: "image.png", oid: await blob(binary) },
        { mode: "100644", name: "latin.txt", oid: await blob(invalid) },
        { mode: "100644", name: "over.txt", oid: await blob(over) },
        { mode: "100644", name: "small.txt", oid: await blob(new TextEncoder().encode("ten bytes\n")) },
      ]),
    });
    let commit = await storeLocal(t.storage,
        { type: "commit", payload: commitPayload(tree, [], "sizes") });

    let read = vi.spyOn(BlobReader.prototype, "read");
    try {
      expect(t.cache.readLocalFileAtCommit(commit, "small.txt"))
          .toStrictEqual({ kind: "text", text: "ten bytes\n" });
      expect(t.cache.readLocalFileAtCommit(commit, "exact.txt"))
          .toStrictEqual({ kind: "text", text: "b".repeat(MAX_BUFFERED_BLOB_SIZE) });
      for (let [path, bytes] of [["over.txt", over], ["image.png", binary], ["latin.txt", invalid]] as const) {
        let file = t.cache.readLocalFileAtCommit(commit, path);
        if (file.kind !== "stream") throw new Error(`expected a stream for ${path}`);
        expect(file.byteLength, path).toBe(bytes.length);
        expect(sameBytes(await contentBytes(file.content), bytes), path).toBe(true);
      }
      // No single read took more than a file read whole may hold.
      expect(read.mock.calls.map(([, length]) => length).filter(
          length => length > MAX_BUFFERED_BLOB_SIZE)).toStrictEqual([]);
    } finally {
      read.mockRestore();
    }
    expect(t.pulls).toStrictEqual([]);
  });

  it("name for an admin a symlink whose blob is over MAX_BUFFERED_BLOB_SIZE without its target, " +
      "never reading it whole", async () => {
    let t = makeCache();
    // A tree can name any blob as a link, whatever its size.
    let exact = t.cache.writeBlob(new Uint8Array(MAX_BUFFERED_BLOB_SIZE).fill(0x62));
    let over = t.cache.writeBlob(new Uint8Array(MAX_BUFFERED_BLOB_SIZE + 1).fill(0x63));
    expect(chunksOf(t, over.oid).length).toBeGreaterThan(1);
    let tree = await storeLocal(t.storage, {
      type: "tree",
      payload: treePayload([
        { mode: "120000", name: "exact.lnk", oid: exact.oid },
        { mode: "120000", name: "over.lnk", oid: over.oid },
      ]),
    });
    let commit = await storeLocal(t.storage,
        { type: "commit", payload: commitPayload(tree, [], "links") });

    let read = vi.spyOn(BlobReader.prototype, "read");
    try {
      let quoted = t.cache.readLocalFileAtCommit(commit, "exact.lnk");
      // Compared outside expect(), which would print the megabyte on a mismatch.
      expect(quoted.kind === "unreadable" && quoted.message ===
          `exact.lnk is a symlink to ${"b".repeat(MAX_BUFFERED_BLOB_SIZE)}`).toBe(true);
      expect(t.cache.readLocalFileAtCommit(commit, "over.lnk"))
          .toStrictEqual({ kind: "unreadable", message: "over.lnk is a symlink" });
      // The link over the limit was not read at all, and no read took more than the limit.
      expect(read.mock.calls.map(([, length]) => length))
          .toStrictEqual([MAX_BUFFERED_BLOB_SIZE]);
    } finally {
      read.mockRestore();
    }
    expect(t.pulls).toStrictEqual([]);
  });

  it("throw for an admin's read of a file naming the object it lacks, rather than pulling it",
      async () => {
    // Only the commit is stored, its tree pullable from G1.
    let t = makeCache();
    t.sources.set(G1, fixtureSource(t, G1));
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);
    expect(() => t.cache.readLocalFileAtCommit(COMMIT_1, "README.md")).toThrow(notStored(TREE_1));

    // The trees stored, every blob still pullable from G1.
    for (let object of FIXTURE_OBJECTS.filter(o => o.type === "tree")) {
      if (PACKED_OIDS.includes(object.oid)) {
        await t.cache.putFromGatekeeper(G1, object.type, b64Bytes(object.payload));
      }
    }
    let readmeBlob = "ca69e6d08b5b8bb4f11a74f9695e329c203cbfd8";
    let linkBlob = "42061c01a1c70097d1e4579f29a5adf40abdec95";  // link.md -> "README.md"
    expect(() => t.cache.readLocalFileAtCommit(COMMIT_1, "README.md"))
        .toThrow(notStored(readmeBlob));
    // A symlink's message quotes its target, which is its blob.
    expect(() => t.cache.readLocalFileAtCommit(COMMIT_1, "link.md")).toThrow(notStored(linkBlob));
    // A submodule and a directory are told from the tree alone.
    expect(t.cache.readLocalFileAtCommit(COMMIT_1, "vendored").kind).toBe("unreadable");
    expect(t.cache.readLocalFileAtCommit(COMMIT_1, "src")).toStrictEqual({ kind: "absent" });
    expect(t.pulls).toStrictEqual([]);
  });

  it("name a symlink without its target, which the pulling read names", async () => {
    let t = await fixtureStoredLocally();
    expect(await thrownBy(() => t.cache.readFileAtCommitIfExists(COMMIT_1, "link.md")))
        .toBe("link.md is a symlink to README.md");
    let message = await thrownBy(() => t.cache.readLocalFileAtCommitIfExists(COMMIT_1, "link.md"));
    expect(message).toBe("link.md is a symlink");
    expect(message).not.toContain("README.md");
    expect(t.pulls).toStrictEqual([]);
  });

  it("throw naming the object a text, entry or diff read lacks, rather than pulling it",
      async () => {
    // Only COMMIT_1 is stored, everything beneath it and COMMIT_2 pullable from G1.
    let t = makeCache();
    t.sources.set(G1, fixtureSource(t, G1));
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);
    expect(() => t.cache.readLocalFileAtCommitIfExists(COMMIT_1, "README.md"))
        .toThrow(notStored(TREE_1));
    expect(() => t.cache.localPathEntryAtCommit(COMMIT_1, "README.md"))
        .toThrow(notStored(TREE_1));
    // The diff names the commit it lacks, and with that stored, the first tree.
    await expect(t.cache.changedLocalFilePathsBetween(COMMIT_1, COMMIT_2))
        .rejects.toThrow(notStored(COMMIT_2));
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_2).payload);
    await expect(t.cache.changedLocalFilePathsBetween(COMMIT_1, COMMIT_2))
        .rejects.toThrow(notStored(TREE_1));

    // The trees stored, every blob still pullable from G1.
    for (let object of FIXTURE_OBJECTS.filter(o => o.type === "tree")) {
      if (PACKED_OIDS.includes(object.oid)) {
        await t.cache.putFromGatekeeper(G1, object.type, b64Bytes(object.payload));
      }
    }
    let readmeBlob = "ca69e6d08b5b8bb4f11a74f9695e329c203cbfd8";
    let linkBlob = "42061c01a1c70097d1e4579f29a5adf40abdec95";  // link.md -> "README.md"
    expect(() => t.cache.readLocalFileAtCommitIfExists(COMMIT_1, "README.md"))
        .toThrow(notStored(readmeBlob));
    // A symlink is named from its tree entry: its blob, the target, is never read.
    expect(await thrownBy(() => t.cache.readLocalFileAtCommitIfExists(COMMIT_1, "link.md")))
        .toBe("link.md is a symlink");
    // An entry and a diff are read from trees alone, so neither needs a blob.
    expect(t.cache.localPathEntryAtCommit(COMMIT_1, "README.md"))
        .toStrictEqual({ kind: "file", oid: readmeBlob });
    expect(t.cache.localPathEntryAtCommit(COMMIT_1, "link.md"))
        .toStrictEqual({ kind: "symlink", oid: linkBlob });
    expect(await t.cache.changedLocalFilePathsBetween(COMMIT_1, COMMIT_2))
        .toStrictEqual(new Set(["README.md", "src/big.txt", "src/util.js", "vendored"]));
    expect(t.pulls).toStrictEqual([]);
  });

  it("throw for a file whose content is not text, while its entry is still reported", async () => {
    let t = makeCache();
    let binary = await storeLocal(t.storage,
        { type: "blob", payload: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) });
    let commit = await commitWithFile(t, "image.png", binary);
    let read = () => t.cache.readLocalFileAtCommitIfExists(commit, "image.png");
    expect(read).toThrow(UnreadableContentError);
    expect(read).toThrow("image.png is not a text file");
    expect(t.cache.localPathEntryAtCommit(commit, "image.png"))
        .toStrictEqual({ kind: "file", oid: binary });
  });

  it("read a text file over MAX_BUFFERED_BLOB_SIZE whole", async () => {
    let t = makeCache();
    let text = "c".repeat(MAX_BUFFERED_BLOB_SIZE + 1);
    let blob = t.cache.writeBlob(new TextEncoder().encode(text));
    expect(chunksOf(t, blob.oid).length).toBeGreaterThan(1);
    let commit = await commitWithFile(t, "big.txt", blob.oid);

    // Compared outside expect(), which would print both megabytes on a mismatch.
    expect(t.cache.readLocalFileAtCommitIfExists(commit, "big.txt") === text).toBe(true);
    expect(t.pulls).toStrictEqual([]);
  });

  it("reject an invalid path from the text and entry reads, the empty path included",
      async () => {
    let t = await fixtureStoredLocally();
    for (let path of ["../escape", "src//util.js", "", "./README.md"]) {
      expect(() => t.cache.readLocalFileAtCommitIfExists(COMMIT_1, path))
          .toThrow(/invalid file path/);
      expect(() => t.cache.localPathEntryAtCommit(COMMIT_1, path)).toThrow(/invalid file path/);
    }
    // The one path on which localPathEntryAtCommit() and pathEntryAtCommit() differ: there the
    // empty path names the root directory.
    expect(await t.cache.pathEntryAtCommit(COMMIT_1, ""))
        .toStrictEqual({ kind: "dir", oid: TREE_1, referencedBy: COMMIT_1 });
  });

  it("list the paths that differ between two commits as changedFilePathsBetween() does",
      async () => {
    let t = await fixtureStoredLocally();
    for (let [a, b] of [[COMMIT_1, COMMIT_2], [COMMIT_2, COMMIT_3]]) {
      let expected = await t.cache.changedFilePathsBetween(a, b);
      expect(expected.size).toBeGreaterThan(0);
      expect(await t.cache.changedLocalFilePathsBetween(a, b)).toStrictEqual(expected);
      expect(await t.cache.changedLocalFilePathsBetween(b, a))
          .toStrictEqual(await t.cache.changedFilePathsBetween(b, a));
    }
    expect(await t.cache.changedLocalFilePathsBetween(COMMIT_2, COMMIT_3))
        .toStrictEqual(new Set(["src/big.txt"]));
    expect(await t.cache.changedLocalFilePathsBetween(COMMIT_1, COMMIT_1)).toStrictEqual(new Set());
    expect(t.pulls).toStrictEqual([]);
  });

  it("fail a diff on a tree the store lacks, which changedFilePathsBetween() pulls", async () => {
    // Both commits are stored, every tree beneath them pullable from G1.
    let t = makeCache();
    t.sources.set(G1, fixtureSource(t, G1));
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_1).payload);
    await t.cache.putFromGatekeeper(G1, "commit", fixture(COMMIT_2).payload);
    await expect(t.cache.changedLocalFilePathsBetween(COMMIT_1, COMMIT_2))
        .rejects.toThrow(notStored(TREE_1));
    expect(t.pulls).toStrictEqual([]);

    // The pulling diff faults in each tree it reads, from a source that serves only the objects
    // asked for: the two roots, then the two `src` directories. Each pull names the object that
    // references the tree, and has the shape of a fault against a worktree's base, which asks
    // for the whole tree and every blob under EAGER_BLOB_LIMIT.
    expect(await t.cache.changedFilePathsBetween(COMMIT_1, COMMIT_2))
        .toStrictEqual(new Set(["README.md", "src/big.txt", "src/util.js", "vendored"]));
    let tree2 = (await t.cache.pathEntryAtCommit(COMMIT_2, ""))!.oid;
    let src = (commit: GitOid) => t.cache.localPathEntryAtCommit(commit, "src")!.oid;
    expect(t.pulls).toStrictEqual([
      [TREE_1, COMMIT_1], [tree2, COMMIT_2], [src(COMMIT_1), TREE_1], [src(COMMIT_2), tree2],
    ].map(([oid, referencedBy]) => ({
      gatekeeperId: G1,
      oids: [oid],
      hints: { type: "tree", referencedBy, commitHistory: { kind: "depth", depth: 1 },
               filterBlobSize: EAGER_BLOB_LIMIT },
    })));
  });

  it("read no subtree that both commits share, and no commit compared with itself", async () => {
    let t = makeCache();
    // A commit whose tree holds a.js with `text`, and a `vendor` directory that is `vendor`.
    let commitOf = async (text: string, vendor: GitOid) => {
      let file = await storeLocal(
          t.storage, { type: "blob", payload: new TextEncoder().encode(text) });
      let tree = await storeLocal(t.storage, {
        type: "tree",
        payload: treePayload([
          { mode: "100644", name: "a.js", oid: file },
          { mode: "40000", name: "vendor", oid: vendor },
        ]),
      });
      return await storeLocal(
          t.storage, { type: "commit", payload: commitPayload(tree, [], text) });
    };
    // Held nowhere: reading it throws.
    let unheld = "ab".repeat(20);
    let before = await commitOf("a\n", unheld);
    let after = await commitOf("A\n", unheld);
    expect(await t.cache.changedLocalFilePathsBetween(before, after))
        .toStrictEqual(new Set(["a.js"]));
    expect(await t.cache.changedLocalFilePathsBetween(unheld, unheld)).toStrictEqual(new Set());

    // A subtree that differs is read, so one that is not stored fails the diff.
    let other = await commitOf("a\n", "cd".repeat(20));
    await expect(t.cache.changedLocalFilePathsBetween(before, other))
        .rejects.toThrow(notStored(unheld));
    expect(t.pulls).toStrictEqual([]);
  });
});
