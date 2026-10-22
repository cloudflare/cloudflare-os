import { describe, expect, it } from "vitest";
import { deserialize, serialize } from "capnweb";
import { commitIdentityForAuthor, type WorkspaceGitCache } from "../src/git-cache";
import { makeOverseerStorage } from "../src/storage-schema/overseer-storage";
import { makeMockStorage } from "./mock-storage";
import { makeLocalGitCache } from "./local-git-cache";
import {
  EMPTY_TREE_OID, blobOid, decodeLooseObject, encodeGitTree, encodeLooseObject, gitObjectOid,
  parseGitCommitRefs, parseGitTree, readGitCommitHeader,
} from "../src/git-codec";
import {
  BAD_NAME_TREE, COMMIT_1, COMMIT_3, FIXTURE_OBJECTS, b64Bytes,
} from "./git-cache-fixtures";

// The workspace's own history through WorkspaceGitCache: the writers, and the local reads that
// never pull. (The lazy reads and the gatekeeper-facing machinery are git-cache.test.ts's.)

/** A store over fresh mock storage, with the `gitObjects` collection beneath it. */
function makeStore() {
  let storage = makeOverseerStorage(makeMockStorage());
  return { objects: storage.gitObjects, store: makeLocalGitCache(storage) };
}

// ---------------------------------------------------------------------------------------
// Fixtures whose oids were produced by real `git` (init/add/commit with the same authors,
// timestamps, and messages, then `git rev-parse`). The byte-identity of our store with git's
// on-disk object format is the load-bearing property for future GitHub export/import and git
// protocol support, so these tests pin exact hashes, not just round-trip consistency.

const ALICE = { name: "Alice Example", email: "alice@example.com" };

/** `git mktree </dev/null` */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const INITIAL_FILES = new Map([
  ["README.md", "# Test Gadget\n"],
  ["client.js", 'console.log("hello");\n'],
  ["lib/util.js", "export const answer = 42;\n"],
]);
const INITIAL_COMMIT_OID = "a0fcf634015d2547942455ca5785a2b7273c5431";

const SECOND_FILES = new Map([
  ["README.md", "# Test Gadget\n"],
  ["client.js", 'console.log("hello, world");\n'],
  ["lib/util.js", "export const answer = 42;\n"],
]);
const SECOND_COMMIT_OID = "2352e13eb6af1e9edd23b5d7f3b4272ea12c30d4";

async function writeFixtureHistory(store: WorkspaceGitCache): Promise<void> {
  let first = await store.writeFilesAsCommit(INITIAL_FILES, {
    parents: [],
    author: ALICE,
    message: "initial commit",
    timestamp: new Date(1700000000_000),
  });
  expect(first).toBe(INITIAL_COMMIT_OID);

  let second = await store.writeFilesAsCommit(SECOND_FILES, {
    parents: [first],
    author: commitIdentityForAuthor({ type: "user", id: "bob", name: "Bob Builder" }),
    message: "second commit",
    timestamp: new Date(1700000100_000),
  });
  expect(second).toBe(SECOND_COMMIT_OID);
}

describe("local history", () => {
  it("writes commits byte-identical to real git", async () => {
    // writeFixtureHistory asserts the known-good oids, including a nested tree (lib/util.js), a
    // parent link, and a bare-username author.
    await writeFixtureHistory(makeStore().store);
  });

  it("content-addressed writes are idempotent", async () => {
    let { objects, store } = makeStore();
    await writeFixtureHistory(store);
    let count = [...objects.list()].length;

    await writeFixtureHistory(store);
    expect([...objects.list()].length).toBe(count);
  });

  it("round-trips file maps through commits, flattening nested trees", async () => {
    let store = makeStore().store;
    await writeFixtureHistory(store);

    expect(store.readCommitFiles(INITIAL_COMMIT_OID)).toEqual(INITIAL_FILES);
    expect(store.readCommitFiles(SECOND_COMMIT_OID)).toEqual(SECOND_FILES);
  });

  it("survives Cap'n Web in Overseer.readFilesAtCommit's entry-list shape", async () => {
    // A tree may legitimately name a file after an Object.prototype member, so the commit reads
    // ship [path, content] pairs rather than a path-keyed object: Cap'n Web can't serialize a
    // null-prototype object at all, and deletes prototype-shadowing keys (and "toJSON") from
    // every ordinary object it deserializes -- either way such files would vanish on the wire.
    let store = makeStore().store;
    let files = new Map(
        ["__proto__", "constructor", "toString", "toJSON", "lib/hasOwnProperty"]
            .map((name, i) => [name, `v${i}\n`] as const));
    let oid = await store.writeFilesAsCommit(files, {
      parents: [], author: ALICE, message: "exotic names", timestamp: new Date(1700000000_000),
    });

    let wire: [path: string, content: string][] = [...store.readCommitFiles(oid)];
    expect(new Map(deserialize(serialize(wire)) as typeof wire)).toEqual(files);
  });

  it("blobOid is the content address a written file gets, computed without writing", async () => {
    let { objects, store } = makeStore();
    await writeFixtureHistory(store);
    let count = [...objects.list()].length;

    let oid = await blobOid('console.log("hello");\n');
    expect([...objects.list()].length).toBe(count);  // nothing written
    let tree = parseGitCommitRefs(decodeLooseObject(objects.get(INITIAL_COMMIT_OID)!.data).payload)
        .tree;
    let root = parseGitTree(decodeLooseObject(objects.get(tree)!.data).payload);
    expect(root.find(e => e.name === "client.js")!.oid).toBe(oid);
    // Distinct content, distinct oid (a trailing newline is content).
    expect(await blobOid('console.log("hello");')).not.toBe(oid);
  });

  it("walks commit ancestry with readCommitLog", async () => {
    let store = makeStore().store;
    await writeFixtureHistory(store);

    let history = store.readCommitLog(SECOND_COMMIT_OID);
    expect(history).toEqual([
      {
        oid: SECOND_COMMIT_OID,
        parents: [INITIAL_COMMIT_OID],
        message: "second commit\n",
        author: { name: "Bob Builder", email: "bob@localhost" },
        timestamp: new Date(1700000100_000),
      },
      {
        oid: INITIAL_COMMIT_OID,
        parents: [],
        message: "initial commit\n",
        author: ALICE,
        timestamp: new Date(1700000000_000),
      },
    ]);

    let limited = store.readCommitLog(SECOND_COMMIT_OID, { depth: 1 });
    expect(limited.map(entry => entry.oid)).toEqual([SECOND_COMMIT_OID]);
  });

  it("lists a commit that two lines of history share once, in readCommitLog", async () => {
    // The shape of a gadget's history once it has merged a blueprint built on a release that
    // its own blueprint also has: the walk reaches `shared` from both sides of `merge`.
    let store = makeStore().store;
    let commit = (message: string, parents: string[], seconds: number) =>
        store.writeFilesAsCommit(new Map(), {
          parents, author: ALICE, message, timestamp: new Date(seconds * 1000),
        });
    let messages = async (oid: string, depth?: number) =>
        store.readCommitLog(oid, { depth }).map(entry => entry.message.trimEnd());

    // Written within one second of each other, as publishing and then instantiating can be. Of
    // commits no newer than one another, the first that the walk reached comes first.
    let root = await commit("root", [], 100);
    let shared = await commit("shared", [root], 100);
    let merge = await commit("merge", [
      await commit("left", [shared], 100), await commit("right", [shared], 100),
    ], 100);
    expect(await messages(merge)).toEqual(["merge", "left", "right", "shared", "root"]);
    expect(await messages(merge, 4)).toEqual(["merge", "left", "right", "shared"]);

    // And with a clock that ran behind on one side, so that a commit is newer than one that was
    // built on it.
    let skewed = await commit("merge", [
      await commit("left", [shared], 300), await commit("right", [shared], 50),
    ], 400);
    expect(await messages(skewed)).toEqual(["merge", "left", "shared", "root", "right"]);
  });

  it("writes and round-trips an empty-tree commit", async () => {
    // An accepted gadget creation with no files yet commits an empty tree (see mergeChanges),
    // so the empty map must produce a valid commit -- byte-identical to real git's, over the
    // canonical empty tree (4b825dc...) -- and read back as zero files.
    let store = makeStore().store;
    let oid = await store.writeFilesAsCommit(new Map(), {
      parents: [], author: ALICE, message: "create gadget", timestamp: new Date(1700000000_000),
    });
    expect(oid).toBe("bb4cb778675f2b2a4e442e89256aa6da72fd09a2");  // real `git commit-tree` oid
    expect(store.readCommitFiles(oid).size).toBe(0);
  });

  it("writes the commit ids isomorphic-git's writer wrote for the same inputs", async () => {
    // Commits were once written with isomorphic-git, and every id it wrote then is still the id
    // of the commit written now. The ids are isomorphic-git 1.42's, frozen when it was dropped.
    let store = makeStore().store;
    let bob = commitIdentityForAuthor({ type: "user", id: "bob", name: "Bob Builder" });
    let timestamp = new Date(1700000000_999);
    let cases = [
      { parents: [], committer: undefined, message: "root",
        oid: "eac7a4244b9bcd6c151d155b5c51bcd83ad0741a" },
      { parents: [COMMIT_1], committer: bob, message: "\r\nsubject\r\n\r\nbody\n\n",
        oid: "c8ba320c9d0e2a31591aebf03f65f4a964c3652d" },
      { parents: [COMMIT_1, COMMIT_3], committer: undefined, message: "caf\u00e9 \u{1F600}",
        oid: "a30b04aba954490e6c15b805ad75ebc3b48c8e23" },
    ];
    for (let { parents, committer, message, oid } of cases) {
      expect(await store.writeFilesAsCommit(
          new Map(), { parents, author: ALICE, committer, message, timestamp }))
          .toBe(oid);
      expect(await store.writeCommitForTree(
          EMPTY_TREE, { parents, author: ALICE, committer, message, timestamp }))
          .toBe(oid);
    }
  });

  it("writes extra headers, and reads a commit that has them through every reader", async () => {
    let { objects, store } = makeStore();
    await writeFixtureHistory(store);
    let marked = await store.writeFilesAsCommit(SECOND_FILES, {
      parents: [SECOND_COMMIT_OID, INITIAL_COMMIT_OID],
      author: ALICE,
      message: "merge",
      timestamp: new Date(1700000200_000),
      headers: [{ name: "x-merged", value: INITIAL_COMMIT_OID }],
    });
    let payload = decodeLooseObject(objects.get(marked)!.data).payload;
    expect(readGitCommitHeader(payload, "x-merged")).toEqual([INITIAL_COMMIT_OID]);

    let commit = store.readCommitObject(marked);
    expect(commit.parents).toEqual([SECOND_COMMIT_OID, INITIAL_COMMIT_OID]);
    expect(commit.message).toBe("merge\n");
    expect(commit.author)
        .toStrictEqual({ ...ALICE, timestamp: new Date(1700000200_000), utcOffsetMinutes: 0 });
    expect(store.readCommitFiles(marked)).toEqual(SECOND_FILES);
    expect(store.readCommitLog(marked).map(entry => entry.oid))
        .toEqual([marked, SECOND_COMMIT_OID, INITIAL_COMMIT_OID]);
    expect(store.readCommitLog(marked)[0]).toEqual({
      oid: marked,
      parents: [SECOND_COMMIT_OID, INITIAL_COMMIT_OID],
      message: "merge\n",
      author: ALICE,
      timestamp: new Date(1700000200_000),
    });
  });

  it("refuses a name that would write header lines of its own", async () => {
    let store = makeStore().store;
    let forged = `Mallory <m@example.com> 1 +0000\nblueprint-release ${COMMIT_1}\nx Mallory`;
    await expect(store.writeFilesAsCommit(new Map(), {
      parents: [], author: { name: forged, email: "m@example.com" }, message: "m",
      timestamp: new Date(1700000000_000),
    })).rejects.toThrow(/name or email contains/);
  });

  it("writes a file of any size, chunking a large one's blob", async () => {
    let { objects, store } = makeStore();
    let random = Array.from({ length: 3 * 1024 * 1024 },
        () => Math.random().toString(36)[2]).join("");
    let options = { parents: [], author: ALICE, message: "m", timestamp: new Date(0) };
    let commit = await store.writeFilesAsCommit(new Map([["lib/big.js", random]]), options);
    expect(store.readCommitFiles(commit)).toEqual(new Map([["lib/big.js", random]]));
    let blob = await blobOid(random);
    expect(objects.get(blob)).toHaveProperty("chunks");
  });

  it("rejects reads of unknown commits", async () => {
    let store = makeStore().store;
    expect(() => store.readCommitFiles("deadbeef".repeat(5))).toThrow();
  });

  it("rejects malformed file paths", async () => {
    let store = makeStore().store;
    let options = {
      parents: [], author: ALICE, message: "bad", timestamp: new Date(1700000000_000),
    };
    for (let path of ["a//b", "/a", "a/", ".", "a/../b"]) {
      await expect(store.writeFilesAsCommit(new Map([[path, "x"]]), options))
          .rejects.toThrow("invalid file path");
    }
    let collision = new Map([["a", "file"], ["a/b", "dir entry"]]);
    await expect(store.writeFilesAsCommit(collision, options))
        .rejects.toThrow("conflicting file paths");
  });

  it("refuses the names git reserves, as a file or a directory", async () => {
    let { objects, store } = makeStore();
    let options = {
      parents: [], author: ALICE, message: "bad", timestamp: new Date(1700000000_000),
    };
    for (let path of [".git/config", "src/.GIT", "a/git~1/b", "a\\b", ".git. /x", ".git\u200d"]) {
      await expect(store.writeFilesAsCommit(new Map([[path, "x\n"]]), options), path)
          .rejects.toThrow(/^invalid file path: .*git does not allow the name/);
    }
    expect([...objects.list()].filter(record =>
        decodeLooseObject(record.data).type !== "blob")).toStrictEqual([]);
    // Names that merely resemble them are ordinary.
    for (let path of [".gitignore", "x.git", "git", "git~0", ".github/workflows/ci.yml"]) {
      await store.writeFilesAsCommit(new Map([[path, "x\n"]]), options);
    }
  });

  it("sorts a tree's entries by their UTF-8 bytes, as real git does", async () => {
    // U+1F600 follows U+FF5E in UTF-8 but precedes it in UTF-16. Oid from real `git mktree`.
    let store = makeStore().store;
    let commit = await store.writeFilesAsCommit(
        new Map([["\u{1F600}", "x\n"], ["\uFF5E", "x\n"]]),
        { parents: [], author: ALICE, message: "m", timestamp: new Date(0) });
    expect(store.commitTree(commit)).toBe("bb40f9cf9c37cab4cee8cbe15ff5dd0df3ddbb9e");
  });

  it("holds the empty tree whether or not it was ever stored", async () => {
    // As git does. Release 0 of a blueprint has the empty tree, and is written with no tree.
    let { objects, store } = makeStore();
    let commit = await store.writeCommitForTree(EMPTY_TREE_OID, {
      parents: [], author: ALICE, message: "release 0", timestamp: new Date(0),
    });
    expect(objects.get(EMPTY_TREE_OID)).toBeUndefined();
    expect(store.readCommitFilesIfHeld(commit)).toStrictEqual(new Map());
    expect(store.readCommitFiles(commit)).toStrictEqual(new Map());
    expect(store.readLocalObject(EMPTY_TREE_OID)).toStrictEqual(
        { type: "tree", payload: new Uint8Array() });
  });

  it("reads files only where the whole tree is held", async () => {
    let { objects, store } = makeStore();
    await writeFixtureHistory(store);
    let readme = parseGitTree(decodeLooseObject(objects.get(
        store.commitTree(INITIAL_COMMIT_OID))!.data).payload)
        .find(entry => entry.name === "README.md")!;
    objects.delete(readme.oid);
    expect(store.readCommitFilesIfHeld(INITIAL_COMMIT_OID)).toBeUndefined();
    expect(() => store.readCommitFiles(INITIAL_COMMIT_OID))
        .toThrow(/not in the workspace's git store/);
    expect(store.readCommitFilesIfHeld("deadbeef".repeat(5))).toBeUndefined();
  });
});

describe("writeChangedFilesAsCommit", () => {
  // These tests run over the real-git fixture repo (git-cache-fixtures.ts) because its tree
  // exercises all five entry modes -- the property under test is that a changed-files commit
  // rebuilds only the touched subtrees and copies everything else through verbatim.

  const OPTIONS = {
    parents: [COMMIT_1],
    author: ALICE,
    message: "edit",
    timestamp: new Date(1700001000_000),
    treeBase: COMMIT_1,
  };

  function makeFixtureStore() {
    let { objects, store } = makeStore();
    for (let object of FIXTURE_OBJECTS) {
      objects.put({
        oid: object.oid,
        data: encodeLooseObject(object.type, b64Bytes(object.payload)),
      });
    }
    return { objects, store };
  }

  type Objects = ReturnType<typeof makeStore>["objects"];

  // Decodes the entries of a commit's tree (or of a subdirectory of it) via the raw codec.
  function entriesOf(objects: Objects, commitOid: string, path?: string) {
    let read = (oid: string) => decodeLooseObject(objects.get(oid)!.data);
    let treeOid = parseGitCommitRefs(read(commitOid).payload).tree;
    for (let segment of path?.split("/") ?? []) {
      let entry = parseGitTree(read(treeOid).payload).find(e => e.name === segment)!;
      treeOid = entry.oid;
    }
    return { treeOid, entries: parseGitTree(read(treeOid).payload) };
  }

  // The paths whose entry (oid or mode) differs between two commits' trees, via the raw codec.
  function changedPaths(objects: Objects, a: string, b: string) {
    let flatten = (commitOid: string) => {
      let out = new Map<string, string>();
      let walk = (treeOid: string, prefix: string) => {
        for (let entry of parseGitTree(decodeLooseObject(objects.get(treeOid)!.data).payload)) {
          if (entry.mode === "40000") walk(entry.oid, `${prefix}${entry.name}/`);
          else out.set(prefix + entry.name, `${entry.mode}:${entry.oid}`);
        }
      };
      walk(parseGitCommitRefs(decodeLooseObject(objects.get(commitOid)!.data).payload).tree, "");
      return out;
    };
    let [left, right] = [flatten(a), flatten(b)];
    return new Set([...new Set([...left.keys(), ...right.keys()])]
        .filter(path => left.get(path) !== right.get(path)));
  }

  it("applies edits while reusing unchanged subtree oids verbatim", async () => {
    let { objects, store } = makeFixtureStore();
    let commit = await store.writeChangedFilesAsCommit(new Map([
      ["README.md", "rewritten\n"],
      ["src/util.js", "export const answer = 43;\n"],
    ]), OPTIONS);

    expect(changedPaths(objects, COMMIT_1, commit))
        .toStrictEqual(new Set(["README.md", "src/util.js"]));
    // The untouched docs subtree is the *same object*, not an equal rebuild.
    let base = entriesOf(objects, COMMIT_1);
    let next = entriesOf(objects, commit);
    expect(next.entries.find(e => e.name === "docs")!.oid)
        .toBe(base.entries.find(e => e.name === "docs")!.oid);
    // And the parent is as declared.
    expect(parseGitCommitRefs(decodeLooseObject(objects.get(commit)!.data).payload).parents)
        .toStrictEqual([COMMIT_1]);
  });

  it("separates treeBase from parents (squash semantics)", async () => {
    let { objects, store } = makeFixtureStore();
    let commit = await store.writeChangedFilesAsCommit(
        new Map([["README.md", "squashed\n"]]),
        { ...OPTIONS, parents: [COMMIT_3] });  // tree from COMMIT_1, parent COMMIT_3
    expect(parseGitCommitRefs(decodeLooseObject(objects.get(commit)!.data).payload).parents)
        .toStrictEqual([COMMIT_3]);
    expect(changedPaths(objects, COMMIT_1, commit))
        .toStrictEqual(new Set(["README.md"]));
  });

  it("preserves an edited executable's mode and defaults new files to 100644", async () => {
    let { objects, store } = makeFixtureStore();
    let commit = await store.writeChangedFilesAsCommit(new Map([
      ["run.sh", "#!/bin/sh\necho changed\n"],
      ["new.txt", "brand new\n"],
    ]), OPTIONS);

    let base = entriesOf(objects, COMMIT_1);
    let next = entriesOf(objects, commit);
    let runSh = next.entries.find(e => e.name === "run.sh")!;
    expect(runSh.mode).toBe("100755");
    expect(runSh.oid).not.toBe(base.entries.find(e => e.name === "run.sh")!.oid);
    expect(next.entries.find(e => e.name === "new.txt")!.mode).toBe("100644");
    // Untouched symlink and gitlink entries ride through with mode and oid intact.
    expect(next.entries.find(e => e.name === "link.md"))
        .toStrictEqual(base.entries.find(e => e.name === "link.md"));
    expect(next.entries.find(e => e.name === "vendored"))
        .toStrictEqual(base.entries.find(e => e.name === "vendored"));
  });

  it("rejects changes landing on non-regular-file entries", async () => {
    let { store } = makeFixtureStore();
    await expect(store.writeChangedFilesAsCommit(new Map([["link.md", "x"]]), OPTIONS))
        .rejects.toThrow("cannot write link.md: not a regular file");
    await expect(store.writeChangedFilesAsCommit(new Map([["vendored", "x"]]), OPTIONS))
        .rejects.toThrow("cannot write vendored: not a regular file");
    await expect(store.writeChangedFilesAsCommit(new Map([["src", "x"]]), OPTIONS))
        .rejects.toThrow("cannot write src: not a regular file");
    await expect(store.writeChangedFilesAsCommit(new Map([["src", null]]), OPTIONS))
        .rejects.toThrow("cannot delete src: it is a directory");
    await expect(store.writeChangedFilesAsCommit(new Map([["README.md/x", "y"]]), OPTIONS))
        .rejects.toThrow("conflicting file paths at: README.md");
  });

  it("prunes directories emptied by deletions and creates new nested ones", async () => {
    let { objects, store } = makeFixtureStore();
    let commit = await store.writeChangedFilesAsCommit(new Map([
      ["docs/naïve.md", null],
      ["a/deep/new.txt", "nested\n"],
    ]), OPTIONS);

    let next = entriesOf(objects, commit);
    expect(next.entries.find(e => e.name === "docs")).toBeUndefined();
    expect(entriesOf(objects, commit, "a/deep").entries.map(e => e.name))
        .toStrictEqual(["new.txt"]);
    // The prune cascades: deleting a nested directory's last file drops every directory the
    // deletion emptied, all the way up.
    let cascade = await store.writeChangedFilesAsCommit(
        new Map([["a/deep/new.txt", null]]),
        { ...OPTIONS, treeBase: commit, parents: [commit] });
    expect(entriesOf(objects, cascade).entries.find(e => e.name === "a")).toBeUndefined();
    // Deleting an absent file is a no-op, not an error.
    let again = await store.writeChangedFilesAsCommit(
        new Map([["never-existed.txt", null]]), OPTIONS);
    expect(changedPaths(objects, COMMIT_1, again)).toStrictEqual(new Set());
  });

  it("round-trips non-ASCII UTF-8 names byte-identically through parse + rebuild", async () => {
    let { objects, store } = makeFixtureStore();
    // Rewriting the same content rebuilds the docs tree through parse + re-serialize; landing
    // on the identical oid proves the name (and everything else) survived byte-for-byte.
    let commit = await store.writeChangedFilesAsCommit(
        new Map([["docs/naïve.md", "naïve UTF-8 name\n"]]), OPTIONS);
    let base = entriesOf(objects, COMMIT_1);
    let next = entriesOf(objects, commit);
    expect(next.entries.find(e => e.name === "docs")!.oid)
        .toBe(base.entries.find(e => e.name === "docs")!.oid);
    expect(next.treeOid).toBe(base.treeOid);
  });

  it("copies a reserved name in the base through, but refuses to add one", async () => {
    // A tree from elsewhere may hold a name that the store would not write itself.
    let store = makeStore().store;
    let blob = await store.writeBlob(new TextEncoder().encode("x\n"));
    let tree = encodeGitTree([{ mode: "100644", name: "a\\b.txt", oid: blob.oid }]);
    await store.importObjects([{ type: "tree", payload: tree }]);
    let base = await store.writeCommitForTree(await gitObjectOid("tree", tree), OPTIONS);
    let rebuilt = await store.writeChangedFilesAsCommit(
        new Map([["a\\b.txt", "edited\n"], ["b.txt", "b\n"]]), { ...OPTIONS, treeBase: base });
    expect(store.readCommitFiles(rebuilt))
        .toStrictEqual(new Map([["a\\b.txt", "edited\n"], ["b.txt", "b\n"]]));
    await expect(store.writeChangedFilesAsCommit(
        new Map([["c\\d.txt", "x"]]), { ...OPTIONS, treeBase: base }))
        .rejects.toThrow("git does not allow the name");
  });

  it("refuses to rebuild a tree whose entry name is not UTF-8, rather than rename it", async () => {
    let { store } = makeFixtureStore();
    let base = await store.writeCommitForTree(BAD_NAME_TREE, OPTIONS);
    await expect(store.writeChangedFilesAsCommit(new Map([["new.txt", "x"]]),
                                                 { ...OPTIONS, treeBase: base }))
        .rejects.toThrow(/not valid UTF-8/);
  });

  it("produces an empty tree when every file is deleted", async () => {
    let store = makeStore().store;
    await writeFixtureHistory(store);
    let commit = await store.writeChangedFilesAsCommit(
        new Map([...INITIAL_FILES.keys()].map(path => [path, null])),
        { parents: [INITIAL_COMMIT_OID], author: ALICE, message: "wipe",
          timestamp: new Date(1700001000_000), treeBase: INITIAL_COMMIT_OID });
    expect(store.readCommitFiles(commit).size).toBe(0);
  });
});

describe("commitIdentityForAuthor", () => {
  it("uses the display name and an email profile ID directly", () => {
    expect(commitIdentityForAuthor(
        { type: "user", id: "alice@example.com", name: "Alice Example" }))
        .toEqual({ name: "Alice Example", email: "alice@example.com" });
  });

  it("gives bare-username profile IDs a placeholder host", () => {
    expect(commitIdentityForAuthor({ type: "user", id: "bob", name: "Bob Builder" }))
        .toEqual({ name: "Bob Builder", email: "bob@localhost" });
  });

  it("drops what a signature cannot hold, so no header can be written through it", async () => {
    let forged = `Mallory\nblueprint-release ${COMMIT_1}\nx <Mallory>\0`;
    let identity = commitIdentityForAuthor(
        { type: "user", id: "m@example.com", name: forged, commitEmail: `<${forged}>` });
    expect(identity).toEqual({
      name: `Malloryblueprint-release ${COMMIT_1}x Mallory`,
      email: `Malloryblueprint-release ${COMMIT_1}x Mallory`,
    });

    let { objects, store } = makeStore();
    let oid = await store.writeFilesAsCommit(new Map(), {
      parents: [], author: identity, message: "m", timestamp: new Date(1700000000_000),
    });
    let payload = decodeLooseObject(objects.get(oid)!.data).payload;
    expect(readGitCommitHeader(payload, "blueprint-release")).toEqual([]);
    expect(new TextDecoder().decode(payload).split("\n\n")[0].split("\n").map(line =>
        line.split(" ")[0])).toEqual(["tree", "author", "committer"]);
  });

  it("prefers the author's commit email over the profile ID", () => {
    expect(commitIdentityForAuthor(
        { type: "user", id: "bob", name: "Bob Builder", commitEmail: "bob@builder.example" }))
        .toEqual({ name: "Bob Builder", email: "bob@builder.example" });
  });
});
