import { describe, expect, it } from "vitest";
import { deflate } from "pako";
import { MAX_FILE_PATH_LENGTH, MAX_FILE_TEXT_LENGTH } from "@gadgets/workshop-shared/code-change";
import {
  MAX_RELEASE_COMMITS,
  MAX_RELEASE_OBJECT_BYTES,
  MAX_RELEASE_PACK_BYTES,
  buildReleasePack,
  buildSnapshotRelease,
  encodeReleaseCommit,
  listReleaseFiles,
  readReleasePack,
  releaseMergeHeader,
  releasesMergedBy,
  validateReleaseObjects,
  type GitObjectMap,
} from "../src/blueprint-release";
import {
  buildPackBytes,
  concatBytes,
  encodeGitCommit,
  encodeGitTree,
  gitObjectOid,
  parseGitCommitRefs,
  type GitTreeEntry,
  type PackableObject,
} from "../src/git-codec";
import { GitStore } from "../src/git-store";
import { makeOverseerStorage } from "../src/storage-schema/overseer-storage";
import { makeMockStorage } from "./mock-storage";

const ALICE = { name: "Alice Example", email: "alice@example.com" };
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ABSENT = "0".repeat(40);

const FILES = new Map([
  ["client.js", 'console.log("hi");\n'],
  ["lib/util.js", "export const answer = 42;\n"],
  ["README.md", "# Test\n"],
]);

// What real git makes of FILES: `git write-tree`, then `git commit-tree` as
// "Blueprint <blueprint@gadgets.invalid>" at "@0 +0000" with the message "Blueprint snapshot".
const FILES_TREE = "829070f889a299f596027dafefb1b0b2105ebd93";
const FILES_SNAPSHOT = "755287a465f407365e2c4a3ec17403e5efb814ce";

const bytes = (text: string) => new TextEncoder().encode(text);

/** An in-memory object store: what a publisher's workspace holds. */
class Repo {
  objects: GitObjectMap = new Map();
  hidden = new Set<string>();
  #clock = 1700000000;

  /** The lookup a publisher gives `buildReleasePack()`, minus whatever `hidden` names. */
  lookup = (oid: string) => this.hidden.has(oid) ? undefined : this.objects.get(oid);

  async add(type: PackableObject["type"], payload: Uint8Array): Promise<string> {
    let oid = await gitObjectOid(type, payload);
    this.objects.set(oid, { type, payload });
    return oid;
  }

  /** Adds the tree for a file map, and everything beneath it. */
  async tree(files: Iterable<[string, string]>): Promise<string> {
    let { commitId, objects } = await buildSnapshotRelease(new Map(files));
    let tree = this.treeOf(objects.get(commitId)!);
    objects.delete(commitId);
    for (let [oid, object] of objects) this.objects.set(oid, object);
    return tree;
  }

  /** Adds a release commit, each one a second later than the last. */
  async release(tree: string, parents: string[] = []): Promise<string> {
    return await this.add("commit", encodeReleaseCommit({
      tree, parents, author: ALICE, title: "Test Gadget", version: parents.length + 1,
      timestamp: new Date(this.#clock++ * 1000),
    }));
  }

  /** Adds the empty-tree root a derived blueprint's lineage starts from. */
  async root(): Promise<string> {
    let signature = { ...ALICE, timestamp: new Date(this.#clock++ * 1000), utcOffsetMinutes: 0 };
    return await this.add("commit", encodeGitCommit({
      tree: EMPTY_TREE, parents: [], author: signature, committer: signature, message: "Root",
    }));
  }

  treeOf(commit: string | PackableObject): string {
    let object = typeof commit === "string" ? this.objects.get(commit)! : commit;
    return parseGitCommitRefs(object.payload).tree;
  }
}

/** One version of a gadget's files. Every version shares `lib/`, as real ones share most files. */
const version = (name: string): [string, string][] =>
    [["client.js", `// ${name}\n`], ["lib/util.js", "export const answer = 42;\n"]];

async function packOf(objects: Iterable<PackableObject>): Promise<Uint8Array> {
  return concatBytes(await buildPackBytes([...objects]));
}

const blobOid = (text: string) => gitObjectOid("blob", bytes(text));

/**
 * A release with one ancestor, as the objects its pack holds: both commits and the release's
 * tree. `previousTree` is the ancestor's, which the pack leaves out.
 */
async function validRelease() {
  let repo = new Repo();
  let previous = await repo.release(await repo.tree(version("previous")));
  let release = await repo.release(await repo.tree(version("release")), [previous]);
  let objects = await readReleasePack(await buildReleasePack(repo.lookup, release), release);
  return {
    repo, objects, release, previous,
    tree: repo.treeOf(release),
    previousTree: repo.treeOf(previous),
    clientBlob: await blobOid("// release\n"),
    libTree: await repo.tree([["util.js", "export const answer = 42;\n"]]),
  };
}

/** Reads a pack of `objects`, plus a release commit for `tree` when one is given. */
async function read(objects: Iterable<PackableObject>, release: string | { tree: string }) {
  let all = [...objects];
  if (typeof release !== "string") {
    let repo = new Repo();
    release = await repo.release(release.tree);
    all.push(repo.objects.get(release)!);
  }
  return await readReleasePack(await packOf(all), release);
}

/** Reads a pack of a release whose tree has this payload, given whatever the tree refers to. */
async function readTree(payload: Uint8Array, ...referents: PackableObject[]) {
  let tree = await gitObjectOid("tree", payload);
  return await read([{ type: "tree", payload }, ...referents], { tree });
}

/** Reads a pack of a release whose one file, `f`, is a blob with this payload. */
async function readFile(payload: Uint8Array) {
  let oid = await gitObjectOid("blob", payload);
  return await readTree(
      encodeGitTree([{ mode: "100644", name: "f", oid }]), { type: "blob", payload });
}

/** A tree payload written exactly as given: unsorted and unchecked. */
function rawTree(entries: GitTreeEntry[]): Uint8Array {
  return concatBytes(entries.flatMap(({ mode, name, oid }) =>
      [bytes(`${mode} ${name}\0`), Uint8Array.fromHex(oid)]));
}

describe("release commits", () => {
  it("encodes a release as real git does", async () => {
    // Oid from real `git commit-tree -p <root> -p <snapshot>`, as Alice at "@1700000000 +0000".
    let payload = encodeReleaseCommit({
      tree: FILES_TREE,
      parents: ["aaaa63bcb7157648163feb00500efdf02fc1c6fa", FILES_SNAPSHOT],
      author: ALICE,
      title: "Test Gadget",
      version: 3,
      timestamp: new Date(1700000000_000),
    });
    expect(new TextDecoder().decode(payload)).toMatch(/\n\nRelease 3: Test Gadget\n$/);
    expect(await gitObjectOid("commit", payload)).toBe("266b1913956214e72bb544b76d94d76a67100407");
  });

  it("drops from the author what a signature cannot hold, as real git does", async () => {
    // Oid from real `git commit-tree` on the empty tree, given this name and email.
    let payload = encodeReleaseCommit({
      tree: EMPTY_TREE,
      parents: [],
      author: { name: "Al<ice> Ex\nample", email: "al<i>ce@example.com\0" },
      title: "Test Gadget",
      version: 1,
      timestamp: new Date(1700000000_000),
    });
    let commitId = await gitObjectOid("commit", payload);
    expect(commitId).toBe("d0ad880962e5d52af57e21ca611da200c5ef34de");

    // So a release by any publisher passes the check on what a pack may hold.
    validateReleaseObjects(new Map([
      [commitId, { type: "commit", payload }],
      [EMPTY_TREE, { type: "tree", payload: new Uint8Array() }],
    ]), commitId);
  });
});

/** A commit of the empty tree with these parents, marking these releases as merged. */
function mergeCommit(parents: string[], marks: string[], message = "Merge"): Uint8Array {
  let signature = { ...ALICE, timestamp: new Date(1700000000_000), utcOffsetMinutes: 0 };
  return encodeGitCommit({
    tree: EMPTY_TREE, parents, author: signature, committer: signature,
    headers: marks.map(releaseMergeHeader), message,
  });
}

describe("merging releases", () => {
  const H = "1".repeat(40);
  const R = "2".repeat(40);
  const S = "3".repeat(40);

  it("finds a release that a commit marks as one of its other parents", () => {
    expect(new TextDecoder().decode(mergeCommit([H, R], [R])))
        .toMatch(new RegExp(`\ncommitter [^\n]*\nblueprint-release ${R}\n\nMerge\n$`));
    expect(releasesMergedBy(mergeCommit([H, R], [R]))).toStrictEqual([R]);
    // In the order of the parents, not of the marks.
    expect(releasesMergedBy(mergeCommit([H, S, R], [R, S]))).toStrictEqual([S, R]);
    expect(releasesMergedBy(mergeCommit([H, S, R], [R]))).toStrictEqual([R]);
  });

  it("takes no parent for a release unless it is marked as one", () => {
    expect(releasesMergedBy(mergeCommit([H, S], []))).toStrictEqual([]);
    // A mark naming the first parent, which is the gadget's own previous state.
    expect(releasesMergedBy(mergeCommit([H, S], [H]))).toStrictEqual([]);
    // Or naming a commit that is no parent at all.
    expect(releasesMergedBy(mergeCommit([H, S], [R]))).toStrictEqual([]);
    expect(releasesMergedBy(mergeCommit([], [R]))).toStrictEqual([]);
  });

  it("is never read from the message", () => {
    let message = `Accept changes from chat: x\n\nblueprint-release ${R}\n`;
    expect(releasesMergedBy(mergeCommit([H, R], [], message))).toStrictEqual([]);
  });
});

describe("snapshot releases", () => {
  it("derives a fixed, known commit id from the files alone", async () => {
    let { commitId, objects } = await buildSnapshotRelease(FILES);
    expect(commitId).toBe(FILES_SNAPSHOT);
    expect(parseGitCommitRefs(objects.get(commitId)!.payload))
        .toStrictEqual({ tree: FILES_TREE, parents: [] });

    // Neither the order the files are given in nor when or where this runs is part of it.
    let reordered = await buildSnapshotRelease(new Map([...FILES].toReversed()));
    expect(reordered.commitId).toBe(FILES_SNAPSHOT);
  });

  it("writes the tree GitStore writes for the same files, and lists them back", async () => {
    let files = new Map([
      ...FILES,
      ["foo/inner.js", "inner\n"],
      ["foo-bar", "dash\n"],
      ["foo.txt", "dot\n"],
      ["lib/a/deep/leaf.js", "leaf\n"],
      ["docs/na\u00efve.md", "caf\u00e9 \u{1F600}\n"],
      ["bom.txt", "\ufeffkept"],
      ["empty.txt", ""],
    ]);
    let store = new GitStore(makeOverseerStorage(makeMockStorage()).gitObjects);
    let viaStore = await store.writeFilesAsCommit(
        files, { parents: [], author: ALICE, message: "files", timestamp: new Date(0) });

    let { commitId, objects } = await buildSnapshotRelease(files);
    expect(parseGitCommitRefs(objects.get(commitId)!.payload).tree)
        .toBe(await store.commitTree(viaStore));
    validateReleaseObjects(objects, commitId);
    expect(listReleaseFiles(objects, commitId)).toStrictEqual(files);
  });

  it("refuses paths git cannot represent", async () => {
    for (let path of ["", "/a", "a/", "a//b", "./a", "a/../b"]) {
      await expect(buildSnapshotRelease(new Map([[path, ""]])))
          .rejects.toThrow(/invalid entry name/);
    }
    await expect(buildSnapshotRelease(new Map([["a", ""], ["a/b", ""]])))
        .rejects.toThrow(/duplicate entry name "a"/);
  });
});

describe("release packs", () => {
  it("round-trips a release with its ancestor commits but not their trees", async () => {
    let repo = new Repo();
    let a1 = await repo.release(await repo.tree(version("a1")));
    let a2 = await repo.release(await repo.tree(version("a2")), [a1]);
    let a3 = await repo.release(await repo.tree(version("a3")), [a2]);

    let pack = await buildReleasePack(repo.lookup, a3);
    let objects = await readReleasePack(pack, a3);

    // Three commits, and a3's two trees and two files.
    expect(objects.size).toBe(7);
    for (let [oid, object] of objects) expect(object).toStrictEqual(repo.objects.get(oid));
    expect([...objects.values()].filter(o => o.type === "commit")).toHaveLength(3);
    expect(listReleaseFiles(objects, a3)).toStrictEqual(new Map(version("a3")));
    // A tree is absent when its root is, even though `lib/` is here as part of a3's.
    expect(objects.has(repo.treeOf(a2))).toBe(false);
    expect(objects.has(repo.treeOf(a1))).toBe(false);

    // Retrying a publish sends the same bytes.
    expect(await buildReleasePack(repo.lookup, a3)).toStrictEqual(pack);
  });

  it("carries the tree of each other lineage's newest release", async () => {
    // The plan's picture, and a blueprint derived from each derived one:
    //   Alice   a1 ── a2 ── a3
    //   Bob     b0 ── b1          b1 = [b0, a2]
    //   Carol   c0 ── c1          c1 = [c0, a3, b1]
    //   Dave    d0 ── d1          d1 = [d0, b1]
    let repo = new Repo();
    let a1 = await repo.release(await repo.tree(version("a1")));
    let a2 = await repo.release(await repo.tree(version("a2")), [a1]);
    let a3 = await repo.release(await repo.tree(version("a3")), [a2]);
    let b0 = await repo.root();
    let b1 = await repo.release(await repo.tree(version("b1")), [b0, a2]);
    let c1 = await repo.release(await repo.tree(version("c1")), [await repo.root(), a3, b1]);
    let d1 = await repo.release(await repo.tree(version("d1")), [await repo.root(), b1]);

    // The releases whose trees the pack for `release` carries, of those above.
    let treesCarried = async (release: string) => {
      let objects = await readReleasePack(await buildReleasePack(repo.lookup, release), release);
      let carried = Object.entries({ a1, a2, a3, b0, b1, c1, d1 })
          .filter(([, commit]) => objects.has(repo.treeOf(commit)));
      for (let [name, commit] of carried) {
        expect(listReleaseFiles(objects, commit)).toStrictEqual(new Map(version(name)));
      }
      return carried.map(([name]) => name);
    };

    // Bob forked from Alice at a2, so that is what a switch to Bob's blueprint merges against.
    expect(await treesCarried(b1)).toStrictEqual(["a2", "b1"]);
    // Carol merged both. a2 is not Alice's newest release in her ancestry, so it is left out:
    // whoever needs it as a base took a release from Alice or from Bob, and holds it already.
    expect(await treesCarried(c1)).toStrictEqual(["a3", "b1", "c1"]);
    // Dave never merged Alice's blueprint himself, but Bob's pack gave him a2's tree to pass on.
    expect(await treesCarried(d1)).toStrictEqual(["a2", "b1", "d1"]);
  });

  it("carries each newest release of a lineage that forked", async () => {
    // Two blueprints republished from the same legacy content share its snapshot as their root.
    let repo = new Repo();
    let snapshot = await buildSnapshotRelease(FILES);
    for (let [oid, object] of snapshot.objects) repo.objects.set(oid, object);
    let x1 = await repo.release(await repo.tree(version("x1")), [snapshot.commitId]);
    let y1 = await repo.release(await repo.tree(version("y1")), [snapshot.commitId]);
    let r1 = await repo.release(await repo.tree(version("r1")), [await repo.root(), x1, y1]);

    let objects = await readReleasePack(await buildReleasePack(repo.lookup, r1), r1);
    expect(objects.has(repo.treeOf(x1))).toBe(true);
    expect(objects.has(repo.treeOf(y1))).toBe(true);
    expect(objects.has(FILES_TREE)).toBe(false);
  });

  it("leaves out a fork-point tree the publisher does not wholly hold", async () => {
    let repo = new Repo();
    let a1 = await repo.release(await repo.tree(version("a1")));
    let b1 = await repo.release(await repo.tree(version("b1")), [await repo.root(), a1]);
    repo.hidden.add(await blobOid("// a1\n"));

    let objects = await readReleasePack(await buildReleasePack(repo.lookup, b1), b1);
    expect(objects.has(a1)).toBe(true);
    expect(objects.has(repo.treeOf(a1))).toBe(false);
    expect(listReleaseFiles(objects, b1)).toStrictEqual(new Map(version("b1")));
  });

  it("refuses to pack a release the publisher cannot ship whole", async () => {
    let repo = new Repo();
    let a1 = await repo.release(await repo.tree(version("a1")));
    let a2 = await repo.release(await repo.tree(version("a2")), [a1]);

    repo.hidden = new Set([a1]);
    await expect(buildReleasePack(repo.lookup, a2)).rejects.toThrow(`commit ${a1} is not held`);
    repo.hidden = new Set([await blobOid("// a2\n")]);
    await expect(buildReleasePack(repo.lookup, a2)).rejects.toThrow(/not wholly held/);
    repo.hidden = new Set();

    // And one whose pack would then fail to instantiate: here, an executable file.
    let blob = await repo.add("blob", bytes("#!/bin/sh\n"));
    let script = encodeGitTree([{ mode: "100755", name: "run.sh", oid: blob }]);
    let release = await repo.release(await repo.add("tree", script), [a2]);
    await expect(buildReleasePack(repo.lookup, release))
        .rejects.toThrow(/invalid blueprint release: .*unsupported mode 100755/);
  });

  it("admits a file of the greatest length in its longest encoding", async () => {
    let repo = new Repo();
    let files = new Map([["big.txt", "\u20ac".repeat(MAX_FILE_TEXT_LENGTH)]]);
    let release = await repo.release(await repo.tree(files));
    let objects = await readReleasePack(await buildReleasePack(repo.lookup, release), release);
    expect(Math.max(...[...objects.values()].map(o => o.payload.byteLength)))
        .toBe(MAX_RELEASE_OBJECT_BYTES);
    expect(listReleaseFiles(objects, release)).toStrictEqual(files);
  });
});

describe("release pack validation", () => {
  it("refuses a pack over the size cap", async () => {
    await expect(readReleasePack(new Uint8Array(MAX_RELEASE_PACK_BYTES + 1), ABSENT))
        .rejects.toThrow(/pack is larger than/);
  });

  it("refuses an object over the size cap", async () => {
    let { objects, release } = await validRelease();
    let payload = new Uint8Array(MAX_RELEASE_OBJECT_BYTES + 1);
    await expect(read([...objects.values(), { type: "blob", payload }], release))
        .rejects.toThrow(/exceeds the .*limit/);
  });

  it("refuses a delta against an object outside the pack", async () => {
    // One ref-delta entry, copying the whole of a base the pack does not carry.
    let base = bytes("a base held elsewhere");
    let delta = new Uint8Array([base.length, base.length, 0x91, 0, base.length]);
    let header = new Uint8Array(12);
    header.set(bytes("PACK"));
    new DataView(header.buffer).setUint32(4, 2);
    new DataView(header.buffer).setUint32(8, 1);
    let body = concatBytes([
      header, new Uint8Array([(7 << 4) | delta.length]),
      Uint8Array.fromHex(await gitObjectOid("blob", base)), deflate(delta),
    ]);
    let pack = concatBytes([body, new Uint8Array(await crypto.subtle.digest("SHA-1", body))]);
    await expect(readReleasePack(pack, ABSENT)).rejects.toThrow(/delta base .* is unavailable/);
  });

  it("refuses a pack without the release commit", async () => {
    let { objects, tree } = await validRelease();
    await expect(read(objects.values(), ABSENT)).rejects.toThrow(`commit ${ABSENT} is missing`);
    await expect(read(objects.values(), tree)).rejects.toThrow(/is a tree, not a commit/);
  });

  it("refuses history that is not closed", async () => {
    let { objects, release, previous } = await validRelease();
    objects.delete(previous);
    await expect(read(objects.values(), release)).rejects.toThrow(`commit ${previous} is missing`);
  });

  it("refuses more commits than the bound", async () => {
    let objects: GitObjectMap = new Map();
    let signature = { ...ALICE, timestamp: new Date(0), utcOffsetMinutes: 0 };
    let add = async (type: PackableObject["type"], payload: Uint8Array) => {
      let oid = await gitObjectOid(type, payload);
      objects.set(oid, { type, payload });
      return oid;
    };
    let tree = await add("tree", encodeGitTree([]));
    let chain: string[] = [];
    for (let i = 0; i <= MAX_RELEASE_COMMITS; i++) {
      if (i === MAX_RELEASE_COMMITS) validateReleaseObjects(objects, chain.at(-1)!);
      chain.push(await add("commit", encodeGitCommit({
        tree, parents: chain.slice(-1), author: signature, committer: signature, message: "",
      })));
    }
    expect(() => validateReleaseObjects(objects, chain.at(-1)!))
        .toThrow(/holds more than 10000 commits/);
  });

  it("refuses a release whose tree is absent or incomplete", async () => {
    let { objects, release, tree, clientBlob, libTree } = await validRelease();
    for (let [missing, type] of [[tree, "tree"], [libTree, "tree"], [clientBlob, "blob"]]) {
      let partial = new Map(objects);
      partial.delete(missing);
      await expect(read(partial.values(), release))
          .rejects.toThrow(`${type} ${missing} is missing`);
    }
  });

  it("refuses an ancestor's tree that is present but incomplete", async () => {
    let { repo, objects, release, previousTree } = await validRelease();
    let missing = await blobOid("// previous\n");
    let withRoot = [...objects.values(), repo.objects.get(previousTree)!];
    await expect(read(withRoot, release)).rejects.toThrow(`blob ${missing} is missing`);
    // Whole, it is welcome: that is what a fork-point tree is.
    await read([...withRoot, repo.objects.get(missing)!], release);
  });

  it("refuses tree entries that are not plain files or directories", async () => {
    let blob: PackableObject = { type: "blob", payload: bytes("x\n") };
    let oid = await gitObjectOid("blob", blob.payload);
    for (let mode of ["100755", "120000", "160000"] as const) {
      await expect(readTree(encodeGitTree([{ mode, name: "f", oid }]), blob))
          .rejects.toThrow(`unsupported mode ${mode}`);
    }

    // Nor may an entry's mode misstate what it names, even an object the tree rightly holds.
    let directory: PackableObject = {
      type: "tree", payload: encodeGitTree([{ mode: "100644", name: "f", oid }]),
    };
    let directoryOid = await gitObjectOid("tree", directory.payload);
    await expect(readTree(encodeGitTree([
      { mode: "40000", name: "d", oid: directoryOid },
      { mode: "100644", name: "e", oid: directoryOid },
    ]), directory, blob)).rejects.toThrow(`object ${directoryOid} is a tree, not a blob`);
    await expect(readTree(encodeGitTree([
      { mode: "100644", name: "e", oid },
      { mode: "40000", name: "g", oid },
    ]), blob)).rejects.toThrow(`object ${oid} is a blob, not a tree`);
  });

  it("refuses a file that is not UTF-8, or is too long", async () => {
    await expect(readFile(new Uint8Array([0x66, 0xff, 0xfe])))
        .rejects.toThrow(/blob .* is not valid UTF-8/);
    await expect(readFile(bytes("x".repeat(MAX_FILE_TEXT_LENGTH + 1))))
        .rejects.toThrow(/blob .* is longer than/);
    await readFile(bytes("x".repeat(MAX_FILE_TEXT_LENGTH)));
  });

  it("refuses a path that is too long, wherever its tree appears", async () => {
    let repo = new Repo();
    let directory = "d".repeat(MAX_FILE_PATH_LENGTH - 2);
    let fits = await repo.release(await repo.tree([["a/f", ""], [`${directory}/f`, ""]]));
    await readReleasePack(await buildReleasePack(repo.lookup, fits), fits);

    // `a` and the long directory are one tree: checked under `a`, then met again too deep.
    let tooLong = await repo.release(await repo.tree([["a/ff", ""], [`${directory}/ff`, ""]]));
    await expect(buildReleasePack(repo.lookup, tooLong))
        .rejects.toThrow(/file path is longer than/);
    // And a name that is too long by itself, which no directory need be read to see.
    let name = await repo.release(await repo.tree([["f".repeat(MAX_FILE_PATH_LENGTH + 1), ""]]));
    await expect(buildReleasePack(repo.lookup, name))
        .rejects.toThrow(/file path is longer than/);
  });

  it("refuses anything the release does not need", async () => {
    let { repo, objects, release } = await validRelease();
    let extras: PackableObject[] = [
      { type: "blob", payload: bytes("stray\n") },
      { type: "tag", payload: bytes(`object ${release}\ntype commit\ntag v1\n\nmessage\n`) },
      repo.objects.get(await repo.root())!,
    ];
    for (let extra of extras) {
      await expect(read([...objects.values(), extra], release))
          .rejects.toThrow(new RegExp(`${extra.type} .* is not part of the release`));
    }
  });

  it("refuses a tree that is not in canonical form", async () => {
    let blob: PackableObject = { type: "blob", payload: bytes("x\n") };
    let oid = await gitObjectOid("blob", blob.payload);
    let file = (name: string): GitTreeEntry => ({ mode: "100644", name, oid });
    for (let entries of [
      [file("b"), file("a")],   // unsorted
      [file("a"), file("a")],   // the same name twice
      [file("a/b")],            // a path, not a name
      [file("..")],
    ]) {
      await expect(readTree(rawTree(entries), blob))
          .rejects.toThrow(/tree .* is not in canonical form/);
    }
  });

  it("refuses exactly the names GitStore cannot read back", async () => {
    let names = [
      ".git", ".GIT", ".git. ", ".git:stream", ".git\u200d", "git~1", ".git~1", "GIT~2", "a\\b",
      ".\u200c", "..\ufeff",
      ".gitignore", "x.git", "git", "git~0", "~git", "a:b", "a b", "\ufeffx", "...",
    ];
    for (let name of names) {
      let files = new Map([[`dir/${name}`, "x\n"]]);
      let store = new GitStore(makeOverseerStorage(makeMockStorage()).gitObjects);
      let commit = await store.writeFilesAsCommit(
          files, { parents: [], author: ALICE, message: "m", timestamp: new Date(0) });
      let readable = await store.readCommitFiles(commit).then(() => true, () => false);

      let snapshot = await buildSnapshotRelease(files);
      let validate = () => validateReleaseObjects(snapshot.objects, snapshot.commitId);
      if (readable) {
        expect(validate, name).not.toThrow();
      } else {
        expect(validate, name).toThrow(/holds the reserved name/);
      }
    }
  });

  it("refuses a commit that marks a release as merged", async () => {
    // A release says what it merged by its parents alone. A mark, in a pack, could only be an
    // attempt to have a gadget's commit taken for a release.
    let repo = new Repo();
    let upstream = await repo.release(await repo.tree(version("upstream")));
    let previous = await repo.release(await repo.tree(version("previous")));
    let tree = await repo.tree(version("release"));
    let release = await repo.release(tree, [previous, upstream]);
    let objects = await readReleasePack(await buildReleasePack(repo.lookup, release), release);

    let signature = { ...ALICE, timestamp: new Date(1700000100_000), utcOffsetMinutes: 0 };
    let payload = encodeGitCommit({
      tree, parents: [previous, upstream], author: signature, committer: signature,
      headers: [releaseMergeHeader(upstream)], message: "Release 2: Test Gadget",
    });
    let marked = await gitObjectOid("commit", payload);
    objects.delete(release);
    await expect(read([...objects.values(), { type: "commit", payload }], marked))
        .rejects.toThrow(new RegExp(`commit ${marked} is not in canonical form`));
  });

  it("refuses a commit that is not in canonical form", async () => {
    let { objects, release, tree } = await validRelease();
    let canonical = new TextDecoder().decode(objects.get(release)!.payload);
    objects.delete(release);
    let readWith = async (payload: Uint8Array) =>
        await read([...objects.values(), { type: "commit", payload }],
            await gitObjectOid("commit", payload));
    for (let [from, to] of [
      [/^committer .*\n/m, ""],
      [/\n\n/, "\nencoding ISO-8859-1\n\n"],
      [/\n\n/, "\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\n"],
      [/^author .*$/m, "author Alice Example alice@example.com 1700000000 +0000"],
      [/^author .*$/m, "author Alice Example <alice@example.com> yesterday"],
      [`tree ${tree}\n`, `tree ${tree}\ntree ${tree}\n`],
    ] as const) {
      let changed = canonical.replace(from, to);
      expect(changed).not.toBe(canonical);
      await expect(readWith(bytes(changed))).rejects.toThrow(/commit .* is not in canonical form/);
    }
    await expect(readWith(concatBytes([bytes(canonical), new Uint8Array([0xff])])))
        .rejects.toThrow(/commit .* is not valid UTF-8/);
    await readWith(bytes(canonical));
  });
});
