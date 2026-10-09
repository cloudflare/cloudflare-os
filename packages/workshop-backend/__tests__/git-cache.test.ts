import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { deflate } from "pako";
import type { GitPullHints, GitOid } from "@gadgets/workshop-shared/gatekeeper";
import { READ_FILES_RESPONSE_BUDGET } from "@gadgets/workshop-shared/api";
import { makeMockStorage } from "./mock-storage";
import {
  EAGER_BLOB_LIMIT,
  GitCacheImpl,
  GitObjectTooLargeError,
  MAX_GIT_OBJECT_SIZE,
  WorkspaceGitCache,
} from "../src/git-cache";
import { buildSnapshotRelease } from "../src/blueprint-release";
import { GITDIR, GitStore, blobOid, makeGitObjectsFs } from "../src/git-store";
import { makeOverseerStorage } from "../src/storage-schema/overseer-storage";
import {
  buildPackBytes,
  concatBytes,
  encodeGitTree,
  encodeLooseObject,
  gitObjectOid,
  parseGitTree,
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
    // As isomorphic-git writes a loose object, through the fs that GitStore hands it.
    route: "a GitStore write",
    deliver: async (t, object) => {
      let oid = await gitObjectOid(object.type, object.payload);
      await makeGitObjectsFs(t.storage.gitObjects).promises.writeFile(
          `${GITDIR}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`,
          encodeLooseObject(object.type, object.payload));
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
    let store = new GitStore(t.storage.gitObjects);
    await store.writeFilesAsCommit(new Map([["a.txt", "a\n"], ["dir/b.txt", "b\n"]]), {
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

  it("consumes a pack another Worker streams in, as a gatekeeper's arrives", async () => {
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
            send(cache, pack) {
              let pos = 0;
              return cache.consumePack(new ReadableStream({
                pull(controller) {
                  if (pos < pack.byteLength) controller.enqueue(pack.slice(pos, pos += 100));
                  else controller.close();
                },
              }));
            }
          }`,
      },
    })).getEntrypoint();
    let stored = await sender.send(new GitCacheImpl(t.cache, G1), b64Bytes(PACK_OFS_DELTA));
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
    let commit = commitPayload(await gitObjectOid("tree", tree), [], "bad mode\n");
    let pack = concatBytes(await buildPackBytes(
        [{ type: "commit", payload: commit }, { type: "tree", payload: tree }]));
    await expect(new GitCacheImpl(t.cache, G1).consumePack(byteStream(pack)))
        .rejects.toThrow(/corrupt tree object/);
    expect(t.cache.hasLocalObject(await gitObjectOid("commit", commit))).toBe(false);
  });

  it("measures an oversized entry, skips storing it, and omits it from the result", async () => {
    let t = makeCache();
    let big = new Uint8Array(MAX_GIT_OBJECT_SIZE + 5).fill(0x7a);
    let bigOid = await gitObjectOid("blob", big);
    let small = new TextEncoder().encode("small\n");
    let smallOid = await gitObjectOid("blob", small);
    let pack = concatBytes(await buildPackBytes(
        [{ type: "blob", payload: big }, { type: "blob", payload: small }]));

    let stored = await new GitCacheImpl(t.cache, G1).consumePack(byteStream(pack));
    expect(stored).toStrictEqual([smallOid]);
    expect(t.cache.hasLocalObject(bigOid)).toBe(false);
    let meta = t.storage.gitObjectMetadata.get(bigOid)!;
    expect(meta.size).toBe(MAX_GIT_OBJECT_SIZE + 5);
    expect(meta.onRemote).toStrictEqual([G1]);
  });

  it("resolves a delta against an oversized base it declines to store", async () => {
    // How git packs a file similar to a large one (e.g. a second lockfile in a whole-tree blob
    // pull), hand-built: the large blob, then a ref-delta copying its first 16 bytes.
    let t = makeCache();
    let big = new Uint8Array(MAX_GIT_OBJECT_SIZE + 5).fill(0x7a);
    let bigOid = await gitObjectOid("blob", big);
    // A one-blob pack minus its trailer, recounted to two entries.
    let prefix = concatBytes(await buildPackBytes([{ type: "blob", payload: big }])).slice(0, -20);
    new DataView(prefix.buffer).setUint32(8, 2);
    // Delta: base size 0x100005 and target size 16 (varints), then a 16-byte copy from offset 0.
    let delta = new Uint8Array([0x85, 0x80, 0x40, 16, 0x90, 16]);
    let body = concatBytes([prefix, new Uint8Array([(7 << 4) | delta.length]),
      Uint8Array.from(bigOid.match(/../g)!, h => parseInt(h, 16)), deflate(delta)]);
    let pack = concatBytes([body, new Uint8Array(await crypto.subtle.digest("SHA-1", body))]);

    let target = big.subarray(0, 16);
    let stored = await new GitCacheImpl(t.cache, G1).consumePack(byteStream(pack));
    expect(stored).toStrictEqual([await gitObjectOid("blob", target)]);
    expect(t.cache.readLocalObject(stored[0])!.payload).toStrictEqual(target);
    expect(t.storage.gitObjectMetadata.get(bigOid)!.size).toBe(big.byteLength);
  });
});

// =======================================================================================

describe("importObjects", () => {
  const FILES = new Map([["client.js", "render();\n"], ["lib/util.js", "export {};\n"]]);

  it("stores a release's objects, invisible to every gatekeeper's scoped view", async () => {
    let t = makeCache();
    let { commitId, objects } = await buildSnapshotRelease(FILES);
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
    let { objects } = await buildSnapshotRelease(FILES);
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
    let { objects } = await buildSnapshotRelease(FILES);
    let puts = countPuts(t);
    let put = t.storage.gitObjects.put;
    t.storage.gitObjects.put = record => {
      if (puts.count === objects.size - 1) throw new Error("storage refused the record");
      put(record);
    };
    await expect(t.cache.importObjects(objects.values())).rejects.toThrow(/storage refused/);
    expect(puts.count).toBe(objects.size - 1);
    expect(Array.from(t.storage.gitObjects.list())).toStrictEqual([]);
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

  it("reports binary and oversized content per file, tolerating oversized blobs in the batch",
      async () => {
    let t = makeCache();
    // Three blobs: one measured oversized (a rejected put recorded its size), one the source
    // omits under the pull's filter (never measured), one ordinary; plus a binary one.
    let measured = new Uint8Array(MAX_GIT_OBJECT_SIZE + 1).fill(0x61);
    let measuredOid = await t.cache.putFromGatekeeper(G1, "blob", measured).catch(
        (err: GitObjectTooLargeError) => err.oid);
    let omitted = new Uint8Array(MAX_GIT_OBJECT_SIZE + 1).fill(0x62);
    let omittedOid = await gitObjectOid("blob", omitted);
    let text = new TextEncoder().encode("hello\n");
    let textOid = await gitObjectOid("blob", text);
    let binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    let binaryOid = await gitObjectOid("blob", binary);
    t.sources.set(G1, async (oids, hints) => {
      for (let oid of oids) {
        let payload = oid === omittedOid ? omitted : oid === textOid ? text
            : oid === binaryOid ? binary : undefined;
        if (payload === undefined) throw new Error(`test: unexpected want ${oid}`);
        if (hints.filterBlobSize !== undefined && payload.byteLength >= hints.filterBlobSize) {
          continue;
        }
        await t.cache.putFromGatekeeper(G1, "blob", payload);
      }
    });
    let tree = await t.cache.putFromGatekeeper(G1, "tree", treePayload([
      { mode: "100644", name: "binary.png", oid: binaryOid },
      { mode: "100644", name: "huge-measured.txt", oid: measuredOid },
      { mode: "100644", name: "huge-omitted.txt", oid: omittedOid },
      { mode: "100644", name: "text.txt", oid: textOid },
    ]));
    let commit = await t.cache.putFromGatekeeper(G1, "commit", commitPayload(tree, [], "mixed"));
    t.pulls.length = 0;

    let result = await t.cache.readFilesAtCommit(
        commit, ["huge-measured.txt", "text.txt", "huge-omitted.txt", "binary.png"]);
    expect(result).toStrictEqual([
      ["huge-measured.txt", { kind: "unreadable", message:
          `huge-measured.txt is too large to read (over ${MAX_GIT_OBJECT_SIZE} bytes)` }],
      ["text.txt", { kind: "text", text: "hello\n" }],
      ["huge-omitted.txt", { kind: "unreadable", message:
          `huge-omitted.txt is too large to read (over ${MAX_GIT_OBJECT_SIZE} bytes)` }],
      ["binary.png", { kind: "unreadable", message: "binary.png is not a text file" }],
    ]);
    // The measured blob failed fast before any pull; the omitted one dropped out of the one
    // batch that did go out, and the rest were local after it -- no retry round trip.
    expect(t.pulls).toHaveLength(1);
    expect([...t.pulls[0].oids].toSorted())
        .toStrictEqual([omittedOid, textOid, binaryOid].toSorted());
  });

  it("stops after the response budget, omitting the rest for the client to re-request",
      async () => {
    let t = makeCache();
    let blob = await storeLocal(t.storage,
        { type: "blob", payload: new Uint8Array(MAX_GIT_OBJECT_SIZE).fill(0x61) });
    let names = Array.from({ length: 10 }, (_, i) => `f${i}.txt`);
    let tree = await storeLocal(t.storage, {
      type: "tree",
      payload: treePayload(names.map(name => ({ mode: "100644", name, oid: blob }))),
    });
    let commit = await storeLocal(t.storage,
        { type: "commit", payload: commitPayload(tree, [], "big") });

    // 8 MiB of text is within budget; the ninth file pushes past it and is still delivered;
    // the tenth is omitted (not reported absent).
    let result = await t.cache.readFilesAtCommit(commit, names);
    expect(READ_FILES_RESPONSE_BUDGET).toBe(8 * MAX_GIT_OBJECT_SIZE);
    expect(result.map(([path]) => path)).toStrictEqual(names.slice(0, 9));
    expect(result.every(([, file]) =>
        file.kind === "text" && file.text.length === MAX_GIT_OBJECT_SIZE)).toBe(true);
    expect(t.pulls).toHaveLength(0);
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
    expect(read.oid).toBe(await blobOid(read.text));
    expect(await t.cache.fileOidAtCommit(COMMIT_1, "README.md")).toBe(read.oid);
    expect(t.pulls.some(pull => pull.oids.includes(read.oid))).toBe(true);  // the read pulled it
    let main = (await t.cache.fileOidAtCommit(COMMIT_1, "src/main.js"))!;
    expect(t.pulls.some(pull => pull.oids.includes(main))).toBe(false);  // the blob: never read
    expect(t.cache.hasLocalObject(main)).toBe(false);

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
