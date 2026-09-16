import { describe, expect, it } from "vitest";
import { deserialize, serialize } from "capnweb";
import { createTypedStorage } from "@gadgets/typed-storage";
import {
  GITDIR, GitStore, commitIdentityForAuthor, gitObjectsCollection, makeGitObjectsFs,
  threeWayMerge,
} from "../src/git-store";
import { makeMockStorage } from "./mock-storage";
import { decodeLooseObject, encodeLooseObject, parseGitCommitRefs, parseGitTree }
  from "../src/git-codec";
import { COMMIT_1, COMMIT_3, FIXTURE_OBJECTS, b64Bytes } from "./git-cache-fixtures";

function makeObjects() {
  return createTypedStorage(makeMockStorage(), {
    collections: { gitObjects: gitObjectsCollection() },
  }).gitObjects;
}

// ---------------------------------------------------------------------------------------
// Fixtures whose oids were produced by real `git` (init/add/commit with the same authors,
// timestamps, and messages, then `git rev-parse`). The byte-identity of our store with git's
// on-disk object format is the load-bearing property for future GitHub export/import and git
// protocol support, so these tests pin exact hashes, not just round-trip consistency.

const ALICE = { name: "Alice Example", email: "alice@example.com" };

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

async function writeFixtureHistory(store: GitStore): Promise<void> {
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

describe("GitStore", () => {
  it("writes commits byte-identical to real git", async () => {
    // writeFixtureHistory asserts the known-good oids, including a nested tree (lib/util.js), a
    // parent link, and a bare-username author.
    await writeFixtureHistory(new GitStore(makeObjects()));
  });

  it("content-addressed writes are idempotent", async () => {
    let objects = makeObjects();
    let store = new GitStore(objects);
    await writeFixtureHistory(store);
    let count = [...objects.list()].length;

    await writeFixtureHistory(store);
    expect([...objects.list()].length).toBe(count);
  });

  it("round-trips file maps through commits, flattening nested trees", async () => {
    let store = new GitStore(makeObjects());
    await writeFixtureHistory(store);

    expect(await store.readCommitFiles(INITIAL_COMMIT_OID)).toEqual(INITIAL_FILES);
    expect(await store.readCommitFiles(SECOND_COMMIT_OID)).toEqual(SECOND_FILES);
  });

  it("survives Cap'n Web in Overseer.getCodeAtCommit's entry-list shape", async () => {
    // A tree may legitimately name a file after an Object.prototype member, so getCodeAtCommit
    // ships [path, content] pairs rather than a path-keyed object: Cap'n Web can't serialize a
    // null-prototype object at all, and deletes prototype-shadowing keys (and "toJSON") from
    // every ordinary object it deserializes -- either way such files would vanish on the wire.
    let store = new GitStore(makeObjects());
    let files = new Map(
        ["__proto__", "constructor", "toString", "toJSON", "lib/hasOwnProperty"]
            .map((name, i) => [name, `v${i}\n`] as const));
    let oid = await store.writeFilesAsCommit(files, {
      parents: [], author: ALICE, message: "exotic names", timestamp: new Date(1700000000_000),
    });

    let wire: [path: string, content: string][] = [...await store.readCommitFiles(oid)];
    expect(new Map(deserialize(serialize(wire)) as typeof wire)).toEqual(files);
  });

  it("reads per-file blob oids without content, deduplicated across commits", async () => {
    let store = new GitStore(makeObjects());
    await writeFixtureHistory(store);

    let first = await store.commitFileOids(INITIAL_COMMIT_OID);
    let second = await store.commitFileOids(SECOND_COMMIT_OID);
    expect([...first.keys()].toSorted()).toEqual(["README.md", "client.js", "lib/util.js"]);
    // Content addressing: unchanged files keep their blob oid across commits; changed ones don't.
    expect(second.get("README.md")).toBe(first.get("README.md"));
    expect(second.get("lib/util.js")).toBe(first.get("lib/util.js"));
    expect(second.get("client.js")).not.toBe(first.get("client.js"));
  });

  it("diffs commits by path with changedPaths", async () => {
    let store = new GitStore(makeObjects());
    await writeFixtureHistory(store);
    let third = await store.writeFilesAsCommit(new Map([
      ["README.md", "# Test Gadget\n"],          // unchanged from SECOND
      ["lib/util.js", "export const answer = 43;\n"],  // changed within a subtree
      ["extra.txt", "new\n"],                    // added; client.js removed
    ]), {
      parents: [SECOND_COMMIT_OID],
      author: ALICE,
      message: "third commit",
      timestamp: new Date(1700000200_000),
    });

    expect(await store.changedPaths(SECOND_COMMIT_OID, SECOND_COMMIT_OID)).toEqual(new Set());
    expect(await store.changedPaths(INITIAL_COMMIT_OID, SECOND_COMMIT_OID))
        .toEqual(new Set(["client.js"]));
    expect(await store.changedPaths(SECOND_COMMIT_OID, third))
        .toEqual(new Set(["client.js", "lib/util.js", "extra.txt"]));
    // An undefined side is an empty tree, so a one-sided diff lists the whole tree.
    expect(await store.changedPaths(undefined, INITIAL_COMMIT_OID))
        .toEqual(new Set(INITIAL_FILES.keys()));
    expect(await store.changedPaths(INITIAL_COMMIT_OID, undefined))
        .toEqual(new Set(INITIAL_FILES.keys()));
  });

  it("reports blob-vs-tree replacements at both paths", async () => {
    let store = new GitStore(makeObjects());
    let blobShape = await store.writeFilesAsCommit(new Map([["x", "file\n"]]), {
      parents: [], author: ALICE, message: "blob", timestamp: new Date(1700000000_000),
    });
    let treeShape = await store.writeFilesAsCommit(new Map([["x/y", "nested\n"]]), {
      parents: [blobShape], author: ALICE, message: "tree", timestamp: new Date(1700000100_000),
    });
    expect(await store.changedPaths(blobShape, treeShape)).toEqual(new Set(["x", "x/y"]));
  });

  it("walks commit ancestry with readCommitLog", async () => {
    let store = new GitStore(makeObjects());
    await writeFixtureHistory(store);

    let history = await store.readCommitLog(SECOND_COMMIT_OID);
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

    let limited = await store.readCommitLog(SECOND_COMMIT_OID, { depth: 1 });
    expect(limited.map(entry => entry.oid)).toEqual([SECOND_COMMIT_OID]);
  });

  it("writes and round-trips an empty-tree commit", async () => {
    // An accepted gadget creation with no files yet commits an empty tree (see mergeChanges),
    // so the empty map must produce a valid commit -- byte-identical to real git's, over the
    // canonical empty tree (4b825dc...) -- and read back as zero files.
    let store = new GitStore(makeObjects());
    let oid = await store.writeFilesAsCommit(new Map(), {
      parents: [], author: ALICE, message: "create gadget", timestamp: new Date(1700000000_000),
    });
    expect(oid).toBe("bb4cb778675f2b2a4e442e89256aa6da72fd09a2");  // real `git commit-tree` oid
    expect((await store.readCommitFiles(oid)).size).toBe(0);
  });

  it("rejects reads of unknown commits", async () => {
    let store = new GitStore(makeObjects());
    await expect(store.readCommitFiles("deadbeef".repeat(5))).rejects.toThrow();
  });

  it("rejects malformed file paths", async () => {
    let store = new GitStore(makeObjects());
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
    let objects = makeObjects();
    for (let object of FIXTURE_OBJECTS) {
      objects.put({
        oid: object.oid,
        data: encodeLooseObject(object.type, b64Bytes(object.payload)),
      });
    }
    return { objects, store: new GitStore(objects) };
  }

  // Decodes the entries of a commit's tree (or of a subdirectory of it) via the raw codec.
  function entriesOf(objects: ReturnType<typeof makeObjects>, commitOid: string, path?: string) {
    let read = (oid: string) => decodeLooseObject(objects.get(oid)!.data);
    let treeOid = parseGitCommitRefs(read(commitOid).payload).tree;
    for (let segment of path?.split("/") ?? []) {
      let entry = parseGitTree(read(treeOid).payload).find(e => e.name === segment)!;
      treeOid = entry.oid;
    }
    return { treeOid, entries: parseGitTree(read(treeOid).payload) };
  }

  it("applies edits while reusing unchanged subtree oids verbatim", async () => {
    let { objects, store } = makeFixtureStore();
    let commit = await store.writeChangedFilesAsCommit(new Map([
      ["README.md", "rewritten\n"],
      ["src/util.js", "export const answer = 43;\n"],
    ]), OPTIONS);

    expect(await store.changedPaths(COMMIT_1, commit))
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
    expect(await store.changedPaths(COMMIT_1, commit))
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
    expect(await store.changedPaths(COMMIT_1, again)).toStrictEqual(new Set());
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

  it("produces an empty tree when every file is deleted", async () => {
    let objects = makeObjects();
    let store = new GitStore(objects);
    await writeFixtureHistory(store);
    let commit = await store.writeChangedFilesAsCommit(
        new Map([...INITIAL_FILES.keys()].map(path => [path, null])),
        { parents: [INITIAL_COMMIT_OID], author: ALICE, message: "wipe",
          timestamp: new Date(1700001000_000), treeBase: INITIAL_COMMIT_OID });
    expect((await store.readCommitFiles(commit)).size).toBe(0);
  });
});

describe("threeWayMerge", () => {
  const files = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it("merges disjoint changes cleanly", () => {
    let result = threeWayMerge(
        files({ "a.js": "a\nb\nc\nd\ne\n", "same.js": "s\n" }),
        files({ "a.js": "A\nb\nc\nd\ne\n", "same.js": "s\n", "added.js": "new\n" }),
        files({ "a.js": "a\nb\nc\nd\nE\n", "same.js": "s\n" }));
    expect(result.conflictPaths).toEqual([]);
    expect(result.files).toEqual(files({
      "a.js": "A\nb\nc\nd\nE\n",  // line edits from both sides, merged by diff3
      "same.js": "s\n",
      "added.js": "new\n",
    }));
  });

  it("lets a lone side win, including deletions", () => {
    let result = threeWayMerge(
        files({ "mod.js": "old\n", "deleted-by-ours.js": "x\n", "deleted-by-theirs.js": "y\n" }),
        files({ "mod.js": "new\n", "deleted-by-theirs.js": "y\n" }),
        files({ "mod.js": "old\n", "deleted-by-ours.js": "x\n" }));
    expect(result.conflictPaths).toEqual([]);
    expect(result.files).toEqual(files({ "mod.js": "new\n" }));
  });

  it("treats identical changes on both sides as clean", () => {
    let result = threeWayMerge(
        files({ "a.js": "old\n" }),
        files({ "a.js": "new\n", "added.js": "same\n" }),
        files({ "a.js": "new\n", "added.js": "same\n" }));
    expect(result.conflictPaths).toEqual([]);
    expect(result.files).toEqual(files({ "a.js": "new\n", "added.js": "same\n" }));
  });

  it("marks overlapping edits with 3-way conflict markers", () => {
    let result = threeWayMerge(
        files({ "a.js": "line1\nline2\nline3\n" }),
        files({ "a.js": "line1\nOURS\nline3\n" }),
        files({ "a.js": "line1\nTHEIRS\nline3\n" }),
        { ours: "mainline", theirs: "chat", base: "merged" });
    expect(result.conflictPaths).toEqual(["a.js"]);
    expect(result.files.get("a.js")).toBe(
        "line1\n" +
        "<<<<<<< mainline\n" +
        "OURS\n" +
        "||||||| merged\n" +
        "line2\n" +
        "=======\n" +
        "THEIRS\n" +
        ">>>>>>> chat\n" +
        "line3\n");
  });

  it("marks both-sides-added files as conflicts", () => {
    // The case isomorphic-git's own merge throws MergeNotSupportedError on.
    let result = threeWayMerge(
        files({}),
        files({ "new.js": "foo\n" }),
        files({ "new.js": "bar\n" }));
    expect(result.conflictPaths).toEqual(["new.js"]);
    expect(result.files.get("new.js")).toBe(
        "<<<<<<< ours\n" +
        "foo\n" +
        "||||||| base\n" +
        "=======\n" +
        "bar\n" +
        ">>>>>>> theirs\n");
  });

  it("keeps modified content on delete-vs-modify conflicts", () => {
    let result = threeWayMerge(
        files({ "a.js": "x\n", "b.js": "x\n" }),
        files({ "b.js": "ours\n" }),                    // ours deleted a.js, modified b.js
        files({ "a.js": "theirs\n" }));                 // theirs modified a.js, deleted b.js
    expect(result.conflictPaths).toEqual(["a.js", "b.js"]);
    expect(result.files).toEqual(files({ "a.js": "theirs\n", "b.js": "ours\n" }));
  });

  it("preserves bare \\r and U+2028/U+2029, which are not line boundaries here", () => {
    // A lossy line split (one that treats these as boundaries but drops them) would corrupt
    // merged content; splitLines keeps them inside their line instead, merely coarsening the
    // merge granularity for such files.
    let result = threeWayMerge(
        files({ "a.js": "one\rtwo\u2028three\nmid\nend\n" }),
        files({ "a.js": "one\rtwo\u2028three\nmid\nEND\n" }),
        files({ "a.js": "ONE\rtwo\u2028three\nmid\nend\n" }));
    expect(result.conflictPaths).toEqual([]);
    expect(result.files.get("a.js")).toBe("ONE\rtwo\u2028three\nmid\nEND\n");
  });

  it("terminates unterminated conflict hunks with a newline", () => {
    let result = threeWayMerge(
        files({ "a.js": "x" }), files({ "a.js": "y" }), files({ "a.js": "z" }));
    expect(result.conflictPaths).toEqual(["a.js"]);
    expect(result.files.get("a.js")).toBe(
        "<<<<<<< ours\ny\n||||||| base\nx\n=======\nz\n>>>>>>> theirs\n");
  });
});

describe("makeGitObjectsFs", () => {
  const oid = "0123456789abcdef0123456789abcdef01234567";
  const loosePath = `${GITDIR}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;

  it("returns a rejected promise from the promise-style detection probe", async () => {
    let fs = makeGitObjectsFs(makeObjects());
    // isomorphic-git calls readFile() with no arguments to detect a promise-style fs; a
    // synchronous throw would misclassify this as a callback-style fs.
    let probe = (fs.promises.readFile as () => Promise<unknown>)();
    expect(probe).toBeInstanceOf(Promise);
    await expect(probe).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips loose objects and reports them via stat", async () => {
    let fs = makeGitObjectsFs(makeObjects());
    let data = new Uint8Array([1, 2, 3]);
    await fs.promises.writeFile(loosePath, data);
    expect(await fs.promises.readFile(loosePath)).toEqual(data);
    let stat = await fs.promises.stat(loosePath);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBe(3);
  });

  it("rejects paths outside the loose-object layout", async () => {
    let fs = makeGitObjectsFs(makeObjects());
    await expect(fs.promises.readFile(`${GITDIR}/config`))
        .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.promises.stat(GITDIR)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.promises.writeFile(`${GITDIR}/refs/heads/main`, new Uint8Array()))
        .rejects.toMatchObject({ code: "EPERM" });
    await expect(fs.promises.readdir(`${GITDIR}/refs`))
        .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.promises.lstat(loosePath)).rejects.toMatchObject({ code: "ENOSYS" });
  });

  it("reports missing objects and an empty pack directory", async () => {
    let fs = makeGitObjectsFs(makeObjects());
    await expect(fs.promises.readFile(loosePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.promises.stat(loosePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.promises.readdir(`${GITDIR}/objects/pack`)).toEqual([]);
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
});
