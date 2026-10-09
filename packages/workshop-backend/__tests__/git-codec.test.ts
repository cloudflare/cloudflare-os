import { describe, expect, it } from "vitest";
import { deflate } from "pako";
import {
  applyGitDelta,
  buildPackBytes,
  concatBytes,
  decodeLooseObject,
  decodePackStream,
  encodeGitCommit,
  encodeGitTree,
  encodeLooseObject,
  gitObjectOid,
  parseGitCommitRefs,
  parseGitTree,
  readGitCommitHeader,
  scanGitTree,
  signatureSafe,
  validateGitOid,
  type GitCommit,
  type GitTreeEntry,
  type PackableObject,
} from "../src/git-codec";
import { writeCommit } from "isomorphic-git";
import { GITDIR, GitStore, makeGitObjectsFs } from "../src/git-store";
import { makeOverseerStorage } from "../src/storage-schema/overseer-storage";
import { makeMockStorage } from "./mock-storage";
import {
  BAD_NAME_TREE,
  COMMIT_1,
  COMMIT_2,
  COMMIT_3,
  FIXTURE_OBJECTS,
  GITLINK_TARGET,
  GPGSIG_COMMIT,
  PACKED_OIDS,
  PACK_NO_DELTA,
  PACK_OFS_DELTA,
  PACK_REF_DELTA,
  TREE_1,
  b64Bytes,
  decodePack,
} from "./git-cache-fixtures";

function fixture(oid: string): PackableObject {
  let object = FIXTURE_OBJECTS.find(o => o.oid === oid);
  if (!object) throw new Error(`no fixture object ${oid}`);
  return { type: object.type, payload: b64Bytes(object.payload) };
}

function newGitStore(): GitStore {
  return new GitStore(makeOverseerStorage(makeMockStorage()).gitObjects);
}

const ALICE = { name: "Alice Example", email: "alice@example.com" };
const BOB = { name: "Bob Builder", email: "bob@localhost" };

/** `echo x | git hash-object --stdin` */
const X_BLOB = "587be6b4c3f93f93c489c0111bba5596147a26cb";

/** `git mktree </dev/null` */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** A tree entry for a file named `file`, but for the fields given. */
function entry(fields: Partial<GitTreeEntry>): GitTreeEntry {
  return { mode: "100644", name: "file", oid: X_BLOB, ...fields };
}

/** The when of a commit signature. */
function at(seconds: number, utcOffsetMinutes = 0) {
  return { timestamp: new Date(seconds * 1000), utcOffsetMinutes };
}

/**
 * Encodes a `path -> text` map as nested trees, laid out as `GitStore.writeFilesAsCommit()`
 * lays them out, and returns the root tree's oid.
 */
async function fileTreeOid(files: ReadonlyMap<string, string>): Promise<string> {
  let entries: GitTreeEntry[] = [];
  let directories = new Map<string, Map<string, string>>();
  for (let [path, text] of files) {
    let slash = path.indexOf("/");
    if (slash < 0) {
      let oid = await gitObjectOid("blob", new TextEncoder().encode(text));
      entries.push({ mode: "100644", name: path, oid });
    } else {
      let name = path.slice(0, slash);
      let directory = directories.get(name) ?? new Map<string, string>();
      directories.set(name, directory.set(path.slice(slash + 1), text));
    }
  }
  for (let [name, directory] of directories) {
    entries.push({ mode: "40000", name, oid: await fileTreeOid(directory) });
  }
  return await gitObjectOid("tree", encodeGitTree(entries));
}

describe("loose object codec", () => {
  it("computes the same oids as real git for every fixture object", async () => {
    for (let object of FIXTURE_OBJECTS) {
      expect(await gitObjectOid(object.type, b64Bytes(object.payload))).toBe(object.oid);
    }
  });

  it("computes the well-known oid of a canonical blob", async () => {
    // `echo 'hello world' | git hash-object --stdin`
    expect(await gitObjectOid("blob", new TextEncoder().encode("hello world\n")))
        .toBe("3b18e512dba79e4c8300dd08aeb37f8e728b8dad");
  });

  it("round-trips every fixture object through encode/decode", () => {
    for (let object of FIXTURE_OBJECTS) {
      let payload = b64Bytes(object.payload);
      let decoded = decodeLooseObject(encodeLooseObject(object.type, payload));
      expect(decoded.type).toBe(object.type);
      expect(decoded.payload).toStrictEqual(payload);
    }
  });

  it("rejects garbage bytes", () => {
    expect(() => decodeLooseObject(new Uint8Array([1, 2, 3, 4])))
        .toThrow(/corrupt loose git object/);
  });

  it("rejects a header whose size disagrees with the payload", () => {
    // Deflate the lying bytes directly (encodeLooseObject would write a correct header).
    expect(() => decodeLooseObject(deflate(new TextEncoder().encode("blob 5\0abc"))))
        .toThrow(/header size does not match payload/);
  });
});

describe("tree parser", () => {
  it("parses all five entry modes from the real-git fixture tree", () => {
    let entries = parseGitTree(fixture(TREE_1).payload, TREE_1);
    expect(entries.map(e => [e.name, e.mode])).toStrictEqual([
      ["README.md", "100644"],
      ["docs", "40000"],
      ["link.md", "120000"],
      ["run.sh", "100755"],
      ["src", "40000"],
      ["vendored", "160000"],
    ]);
    expect(entries.find(e => e.name === "vendored")!.oid).toBe(GITLINK_TARGET);
  });

  it("decodes a non-ASCII UTF-8 entry name byte-identically", () => {
    let docs = parseGitTree(fixture(TREE_1).payload, TREE_1).find(e => e.name === "docs")!;
    let entries = parseGitTree(fixture(docs.oid).payload, docs.oid);
    expect(entries.map(e => e.name)).toStrictEqual(["naïve.md"]);
  });

  it("scans a tree with a non-UTF-8 entry name structurally", () => {
    let entries = scanGitTree(fixture(BAD_NAME_TREE).payload, BAD_NAME_TREE);
    expect(entries).toHaveLength(1);
    expect(entries[0].mode).toBe("100644");
    expect(Array.from(entries[0].nameBytes)).toStrictEqual([0xff, 0xfe, 0x2e, 0x74, 0x78, 0x74]);
  });

  it("fails a strict parse of a non-UTF-8 entry name, naming the tree and the bytes", () => {
    expect(() => parseGitTree(fixture(BAD_NAME_TREE).payload, BAD_NAME_TREE))
        .toThrow(new RegExp(`${BAD_NAME_TREE}.*not valid UTF-8.*fffe2e747874`));
  });

  it("rejects an unsupported entry mode rather than misreading it", () => {
    // A hand-built tree entry with the ancient group-writable mode 100664.
    let oidBytes = new Uint8Array(20).fill(0xab);
    let payload = concatBytes([new TextEncoder().encode("100664 f\0"), oidBytes]);
    expect(() => scanGitTree(payload, "0".repeat(40))).toThrow(/unsupported entry mode 100664/);
  });
});

describe("tree encoder", () => {
  it("re-encodes every real-git fixture tree byte-identically, whatever the input order", () => {
    // Between them these cover all five entry modes and a non-ASCII name.
    let trees = FIXTURE_OBJECTS.filter(o => o.type === "tree" && o.oid !== BAD_NAME_TREE);
    expect(trees.length).toBeGreaterThan(1);
    for (let tree of trees) {
      let payload = b64Bytes(tree.payload);
      let entries = parseGitTree(payload, tree.oid);
      expect(encodeGitTree(entries)).toStrictEqual(payload);
      expect(encodeGitTree(entries.toReversed())).toStrictEqual(payload);
    }
  });

  it("encodes no entries as git's empty tree", async () => {
    expect(await gitObjectOid("tree", encodeGitTree([]))).toBe(EMPTY_TREE);
  });

  it("sorts a directory as if its name ended in a slash", async () => {
    // As plain names these sort foo, foo-bar, foo.txt, foo0. Oids from real `git mktree`.
    let inner = encodeGitTree([{ mode: "100644", name: "inner.js", oid: X_BLOB }]);
    expect(await gitObjectOid("tree", inner)).toBe("64be24e236917bb0d154adf86bd899d5d182716c");
    let payload = encodeGitTree([
      { mode: "40000", name: "foo", oid: "64be24e236917bb0d154adf86bd899d5d182716c" },
      { mode: "100644", name: "foo-bar", oid: X_BLOB },
      { mode: "100644", name: "foo.txt", oid: X_BLOB },
      { mode: "100644", name: "foo0", oid: X_BLOB },
    ]);
    expect(parseGitTree(payload).map(e => e.name))
        .toStrictEqual(["foo-bar", "foo.txt", "foo", "foo0"]);
    expect(await gitObjectOid("tree", payload)).toBe("6174f963cab6a6776c96ce52ec8faca7462a54f1");
  });

  it("sorts names by their UTF-8 bytes, not their UTF-16 code units", async () => {
    // U+1F600 is f0 9f 98 80 in UTF-8 but the surrogates d83d de00 in UTF-16, so it follows
    // U+FF5E (ef bd 9e) in git's order and precedes it in JavaScript's. isomorphic-git sorts by
    // the latter, so GitStore writes this tree in an order real git rejects: the one input for
    // which the two encoders are not meant to agree. Oid from real `git mktree`.
    let payload = encodeGitTree([
      { mode: "100644", name: "\u{1F600}", oid: X_BLOB },
      { mode: "100644", name: "\uFF5E", oid: X_BLOB },
    ]);
    expect(parseGitTree(payload).map(e => e.name)).toStrictEqual(["\uFF5E", "\u{1F600}"]);
    expect(await gitObjectOid("tree", payload)).toBe("bb40f9cf9c37cab4cee8cbe15ff5dd0df3ddbb9e");
  });

  it("writes the same tree ids as GitStore", async () => {
    let files = new Map([
      ["README.md", "# Test Gadget\n"],
      // Names that sort differently as files and as directories, at two depths.
      ["foo/inner.js", "inner\n"],
      ["foo-bar", "dash\n"],
      ["foo.txt", "dot\n"],
      ["foo0", "zero\n"],
      ["lib/a/deep/leaf.js", "leaf\n"],
      ["lib/a-b.js", "dash\n"],
      ["lib/a.js", "dot\n"],
      ["lib/a_b.js", "underscore\n"],
      ["docs/na\u00efve.md", "caf\u00e9\n"],
      ["empty.txt", ""],
    ]);
    let store = newGitStore();
    let commit = await store.writeFilesAsCommit(
        files, { parents: [], author: ALICE, message: "files", timestamp: new Date(0) });
    expect(await fileTreeOid(files)).toBe(await store.commitTree(commit));
  });

  it("rejects entries that would not parse back as given", () => {
    for (let name of ["", ".", "..", "a/b", "a\0b", "\ud83d"]) {
      expect(() => encodeGitTree([entry({ name })])).toThrow(/invalid entry name/);
    }
    // A file and a directory cannot share a name either, though they do not sort together.
    expect(() => encodeGitTree([entry({}), entry({ name: "file.txt" }), entry({ mode: "40000" })]))
        .toThrow(/duplicate entry name "file"/);
    expect(() => encodeGitTree([entry({ oid: X_BLOB.slice(1) })])).toThrow(/Invalid git object id/);
    expect(() => encodeGitTree([entry({ mode: "040000" as GitTreeEntry["mode"] })]))
        .toThrow(/unsupported entry mode 040000/);
  });
});

describe("commit parser", () => {
  it("extracts tree and parents from real-git commits", () => {
    expect(parseGitCommitRefs(fixture(COMMIT_1).payload, COMMIT_1)).toStrictEqual({
      tree: TREE_1,
      parents: [],
    });
    expect(parseGitCommitRefs(fixture(COMMIT_3).payload, COMMIT_3).parents)
        .toStrictEqual([COMMIT_2]);
  });

  it("skips multi-line gpgsig continuation lines", () => {
    expect(parseGitCommitRefs(fixture(GPGSIG_COMMIT).payload, GPGSIG_COMMIT)).toStrictEqual({
      tree: TREE_1,
      parents: [COMMIT_1],
    });
  });

  it("rejects a commit without a tree header", () => {
    let payload = new TextEncoder().encode("author A <a@b> 1 +0000\n\nmessage\n");
    expect(() => parseGitCommitRefs(payload, "0".repeat(40))).toThrow(/missing tree header/);
  });
});

describe("commit encoder", () => {
  it("re-encodes real-git fixture commits byte-identically", () => {
    let alice = { ...ALICE, ...at(1700000000) };
    expect(encodeGitCommit({
      tree: TREE_1, parents: [], author: alice, committer: alice, message: "initial commit",
    })).toStrictEqual(fixture(COMMIT_1).payload);

    let later = { ...ALICE, ...at(1700000200) };
    expect(encodeGitCommit({
      ...parseGitCommitRefs(fixture(COMMIT_3).payload),
      author: later, committer: later, message: "third commit\n",
    })).toStrictEqual(fixture(COMMIT_3).payload);
  });

  it("encodes a merge with a distinct committer and UTC offsets as real git does", async () => {
    // Oid from real `git commit-tree -p <first> -p <second>`, with GIT_AUTHOR_DATE
    // "1700000100 -0500" and GIT_COMMITTER_DATE "1700000200 +0530".
    let commit: GitCommit = {
      tree: "6174f963cab6a6776c96ce52ec8faca7462a54f1",
      parents: [
        "eac7a4244b9bcd6c151d155b5c51bcd83ad0741a",
        "6963e2d1831aa09174f34fbfbdb6429f9691ef63",
      ],
      author: { ...ALICE, ...at(1700000100, -300) },
      committer: { ...BOB, ...at(1700000200, 330) },
      message: "Merge things\n\nBody line.\n",
    };
    let payload = encodeGitCommit(commit);
    expect(await gitObjectOid("commit", payload)).toBe("e5173d47b86cd826a08d49f1c8b6795726ad1967");
    expect(parseGitCommitRefs(payload))
        .toStrictEqual({ tree: commit.tree, parents: commit.parents });

    // Parent order is part of the commit's identity.
    let swapped = encodeGitCommit({ ...commit, parents: commit.parents.toReversed() });
    expect(await gitObjectOid("commit", swapped)).not.toBe(await gitObjectOid("commit", payload));
  });

  it("writes the same commit ids as isomorphic-git", async () => {
    let fs = makeGitObjectsFs(makeOverseerStorage(makeMockStorage()).gitObjects);
    let timestamp = new Date(1700000000_999);  // recorded in whole seconds, rounded down
    let cases: { parents: string[], message: string, committer?: typeof BOB }[] = [
      { parents: [], message: "root" },
      { parents: [COMMIT_1], message: "one parent\n" },
      { parents: [COMMIT_2, COMMIT_1], message: "two parents", committer: BOB },
      { parents: [COMMIT_1, COMMIT_2, COMMIT_3], message: "subject\n\nbody one\nbody two\n" },
      // Every way a message is normalized.
      { parents: [], message: "" },
      { parents: [], message: "\n\n" },
      { parents: [], message: "trailing blank lines\n\n\n" },
      { parents: [], message: "\n\nleading blank lines" },
      { parents: [], message: "windows\r\n\r\nline endings\r\n" },
      { parents: [], message: "  spaces and a \t tab are kept  \n" },
      { parents: [], message: "caf\u00e9 \u{1F600}" },
    ];
    for (let { parents, message, committer } of cases) {
      let when = { timestamp: Math.floor(timestamp.getTime() / 1000), timezoneOffset: 0 };
      let viaIsomorphicGit = await writeCommit({ fs, gitdir: GITDIR, commit: {
        message,
        tree: TREE_1,
        parent: parents,
        author: { ...ALICE, ...when },
        committer: { ...(committer ?? ALICE), ...when },
      } });
      let payload = encodeGitCommit({
        tree: TREE_1,
        parents,
        author: { ...ALICE, timestamp, utcOffsetMinutes: 0 },
        committer: { ...(committer ?? ALICE), timestamp, utcOffsetMinutes: 0 },
        message,
      });
      expect(await gitObjectOid("commit", payload), JSON.stringify(message))
          .toBe(viaIsomorphicGit);
    }
  });

  it("writes extra headers after the committer, as real git accepts them", async () => {
    // Real git: `git hash-object -t commit -w` of these bytes passes `git fsck --strict` with
    // both parents in the repository (git 2.43). Ahead of `author`, hash-object refuses them.
    let gadget = "47caa62e2dd9ea679f286c7b5d8a7391b9426482";
    let release = "bb6b82bd9ec51b3a7c98afc47ddabe027e40eaa0";
    let alice = { ...ALICE, ...at(1700000000) };
    let commit: GitCommit = {
      tree: EMPTY_TREE,
      parents: [gadget, release],
      author: alice,
      committer: alice,
      headers: [{ name: "blueprint-release", value: release }],
      message: "Merge blueprint: Notes v1",
    };
    let payload = encodeGitCommit(commit);
    expect(new TextDecoder().decode(payload)).toBe(
        `tree ${EMPTY_TREE}\nparent ${gadget}\nparent ${release}\n` +
        "author Alice Example <alice@example.com> 1700000000 +0000\n" +
        "committer Alice Example <alice@example.com> 1700000000 +0000\n" +
        `blueprint-release ${release}\n\nMerge blueprint: Notes v1\n`);
    expect(await gitObjectOid("commit", payload)).toBe("eadc807f8f8b0675263e44f01bd234ebb49e9ae6");

    // It round-trips: the commit's own fields are as they were, and the header reads back.
    expect(parseGitCommitRefs(payload))
        .toStrictEqual({ tree: EMPTY_TREE, parents: [gadget, release] });
    expect(readGitCommitHeader(payload, "blueprint-release")).toStrictEqual([release]);
    expect(readGitCommitHeader(payload, "blueprint")).toStrictEqual([]);
    expect(readGitCommitHeader(payload, "parent")).toStrictEqual([gadget, release]);

    // Several are written in the order given, and a name may repeat.
    let several = encodeGitCommit({ ...commit, headers: [
      { name: "x-one", value: "b" }, { name: "x-two", value: "" }, { name: "x-one", value: "a" },
    ] });
    expect(readGitCommitHeader(several, "x-one")).toStrictEqual(["b", "a"]);
    expect(readGitCommitHeader(several, "x-two")).toStrictEqual([""]);
    expect(new TextDecoder().decode(several))
        .toMatch(/\ncommitter [^\n]*\nx-one b\nx-two \nx-one a\n\n/);
  });

  it("reads a header's value across continuation lines, and never from the message", () => {
    let gpgsig = readGitCommitHeader(fixture(GPGSIG_COMMIT).payload, "gpgsig");
    expect(gpgsig).toHaveLength(1);
    expect(gpgsig[0]).toMatch(/^-----BEGIN PGP SIGNATURE-----\n/);
    expect(gpgsig[0]).toMatch(/\n-----END PGP SIGNATURE-----$/);

    let alice = { ...ALICE, ...at(1700000000) };
    let payload = encodeGitCommit({
      tree: TREE_1, parents: [], author: alice, committer: alice,
      message: `subject\n\nblueprint-release ${COMMIT_1}\n`,
    });
    expect(readGitCommitHeader(payload, "blueprint-release")).toStrictEqual([]);
  });

  it("rejects fields that would not parse back as given", () => {
    let alice = { ...ALICE, ...at(1700000000) };
    let commit: GitCommit =
        { tree: TREE_1, parents: [COMMIT_1], author: alice, committer: alice, message: "m" };
    expect(() => encodeGitCommit({ ...commit, tree: "HEAD" })).toThrow(/Invalid git object id/);
    expect(() => encodeGitCommit({ ...commit, parents: [COMMIT_1, ""] }))
        .toThrow(/Invalid git object id/);

    // A newline in a name would otherwise let it write headers of its own.
    let forged = `Mallory <m@example.com> 1 +0000\nparent ${COMMIT_2}\nauthor Mallory`;
    for (let name of [forged, "a<b", "a>b", "a\0b"]) {
      expect(() => encodeGitCommit({ ...commit, author: { ...alice, name } }))
          .toThrow(/name or email contains/);
      expect(() => encodeGitCommit({ ...commit, committer: { ...alice, email: name } }))
          .toThrow(/name or email contains/);
    }

    for (let timestamp of [new Date(NaN), new Date(-1)]) {
      expect(() => encodeGitCommit({ ...commit, author: { ...alice, timestamp } }))
          .toThrow(/timestamp is invalid/);
    }
    for (let utcOffsetMinutes of [0.5, NaN, 6000, -6000]) {
      expect(() => encodeGitCommit({ ...commit, committer: { ...alice, utcOffsetMinutes } }))
          .toThrow(/invalid UTC offset/);
    }

    // What signatureSafe() leaves is always taken.
    let unsafe = forged + "<a>\0";
    expect(signatureSafe(unsafe)).not.toMatch(/[<>\n\0]/);
    encodeGitCommit({ ...commit, author: { ...alice, name: signatureSafe(unsafe) } });

    // An extra header can neither be one of git's own nor write any other.
    for (let name of ["parent", "tree", "Author", "committer", "gpgsig", "mergetag", "encoding",
                      "", "two words", "x\ny", "-x", "1x", "x:y"]) {
      expect(() => encodeGitCommit({ ...commit, headers: [{ name, value: "v" }] }), name)
          .toThrow(/invalid header name/);
    }
    for (let value of [`${COMMIT_2}\nparent ${COMMIT_3}`, "a\n", "a\0b"]) {
      expect(() => encodeGitCommit({ ...commit, headers: [{ name: "x-mark", value }] }))
          .toThrow(/contains a newline or NUL/);
    }
  });
});

describe("pack decoding", () => {
  const PACKS: [string, string][] = [
    ["no-delta", PACK_NO_DELTA],
    ["ofs-delta", PACK_OFS_DELTA],
    ["ref-delta", PACK_REF_DELTA],
  ];

  for (let [name, packB64] of PACKS) {
    for (let step of [undefined, 1]) {
      it(`decodes the real \`git pack-objects\` ${name} pack to the exact objects` +
          (step ? ", byte by byte" : ""), async () => {
        let objects = await decodePack(b64Bytes(packB64), { step });
        expect(objects.map(o => o.oid).toSorted()).toStrictEqual(PACKED_OIDS.toSorted());
        for (let { oid, type, payload } of objects) {
          expect({ type, payload }).toStrictEqual(fixture(oid));
        }
      });
    }
  }

  it("rejects bad magic", async () => {
    let pack = b64Bytes(PACK_NO_DELTA).slice();
    pack[0] = 0x51;
    await expect(decodePack(pack)).rejects.toThrow(/bad magic/);
  });

  it("rejects a truncated pack", async () => {
    let pack = b64Bytes(PACK_NO_DELTA);
    await expect(decodePack(pack.subarray(0, pack.length - 40)))
        .rejects.toThrow(/invalid packfile/);
  });

  it("rejects a corrupted trailer, however the pack is chunked", async () => {
    let pack = b64Bytes(PACK_NO_DELTA).slice();
    pack[pack.length - 1] ^= 0xff;
    for (let step of [undefined, 1]) {
      await expect(decodePack(pack, { step })).rejects.toThrow(/trailer SHA-1 mismatch/);
    }
  });

  it("rejects a pack declaring fewer objects than it carries (trailing garbage)", async () => {
    let pack = b64Bytes(PACK_NO_DELTA).slice();
    new DataView(pack.buffer).setUint32(8, PACKED_OIDS.length - 1);
    // Byte by byte, the garbage arrives only after the trailer's chunk has been consumed.
    for (let step of [undefined, 1]) {
      await expect(decodePack(pack, { step })).rejects.toThrow(/trailing garbage/);
    }
  });

  it("rejects a pack declaring more objects than it carries", async () => {
    let pack = b64Bytes(PACK_NO_DELTA).slice();
    new DataView(pack.buffer).setUint32(8, PACKED_OIDS.length + 1);
    await expect(decodePack(pack)).rejects.toThrow(/invalid packfile/);
  });

  it("enforces the object size cap while decoding", async () => {
    await expect(decodePack(b64Bytes(PACK_NO_DELTA), { maxObjectSize: 64 }))
        .rejects.toThrow(/exceeds the 64-byte limit/);
  });

  it("rejects an entry whose size varint is long enough to overflow", async () => {
    // Its zero digits overflow the multiplier, leaving a NaN size that no cap comparison rejects.
    let pack = concatBytes(await buildPackBytes([{ type: "blob", payload: new Uint8Array(3) }]));
    let entry = pack.subarray(12, -20);
    let body = concatBytes([pack.subarray(0, 12), Uint8Array.of(entry[0] | 0x80),
      new Uint8Array(160).fill(0x80), Uint8Array.of(0), entry.subarray(1)]);
    let bytes = concatBytes([body, new Uint8Array(await crypto.subtle.digest("SHA-1", body))]);
    await expect(decodePack(bytes, { maxObjectSize: 64 }))
        .rejects.toThrow(/entry size exceeds the 64-byte limit/);
  });

  it("enforces the pack size cap", async () => {
    let pack = b64Bytes(PACK_NO_DELTA);
    await expect(decodePack(pack, { maxPackSize: pack.length - 1 }))
        .rejects.toThrow(`packfile exceeds the ${pack.length - 1}-byte limit`);
  });

  it("cancels the source when decoding fails", async () => {
    // An upstream still sending (a fetch body) must not be left open by a failed pull.
    let cancelled = false;
    let pack = new ReadableStream({
      type: "bytes",
      pull: controller => controller.enqueue(new TextEncoder().encode("not a pack")),
      cancel: () => { cancelled = true; },
    });
    let options = { maxPackSize: Infinity, maxObjectSize: 1, resolveBase: () => undefined };
    await expect(decodePackStream(pack, options).next()).rejects.toThrow(/bad magic/);
    expect(cancelled).toBe(true);
  });

  it("fails a ref-delta whose base is nowhere, and resolves it via resolveBase", async () => {
    // Hand-build a one-entry thin pack: a ref-delta against an external base.
    let base = new TextEncoder().encode("hello base content");
    let baseOid = await gitObjectOid("blob", base);
    // Delta: baseSize, targetSize, then one copy op (offset byte + size byte) over the base.
    let delta = new Uint8Array([base.length, base.length, 0x91, 0, base.length]);
    let entryHeader = new Uint8Array([(7 << 4) | (delta.length & 0x0f)]);
    expect(delta.length).toBeLessThan(16);  // single-byte size header
    let oidBytes = Uint8Array.from(baseOid.match(/../g)!.map(h => parseInt(h, 16)));
    let header = new Uint8Array(12);
    header.set(new TextEncoder().encode("PACK"));
    new DataView(header.buffer).setUint32(4, 2);
    new DataView(header.buffer).setUint32(8, 1);
    let body = concatBytes([header, entryHeader, oidBytes, deflate(delta)]);
    let trailer = new Uint8Array(await crypto.subtle.digest("SHA-1", body));
    let pack = concatBytes([body, trailer]);

    await expect(decodePack(pack, { maxObjectSize: 1 << 20 }))
        .rejects.toThrow(new RegExp(`delta base ${baseOid} is unavailable`));

    let objects = await decodePack(pack, {
      maxObjectSize: 1 << 20,
      resolveBase: oid => oid === baseOid ? { type: "blob", payload: base } : undefined,
    });
    expect(objects).toHaveLength(1);
    expect(objects[0].type).toBe("blob");
    expect(objects[0].payload).toStrictEqual(base);
  });
});

describe("pack encoding", () => {
  it("round-trips all fixture objects through buildPackBytes/decodePackStream", async () => {
    let pack = concatBytes(await buildPackBytes(PACKED_OIDS.map(fixture)));
    expect((await decodePack(pack)).map(o => o.oid)).toStrictEqual(PACKED_OIDS);
  });

  it("round-trips an empty pack", async () => {
    let pack = concatBytes(await buildPackBytes([]));
    expect(pack.byteLength).toBe(12 + 20);
    expect(await decodePack(pack)).toStrictEqual([]);
  });
});

describe("applyGitDelta", () => {
  const BASE = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");

  it("applies copy and insert ops", () => {
    // target = base[4..9] ("quick") + " red " + base[10..15] ("brown")
    let delta = new Uint8Array([
      BASE.length,        // base size
      15,                 // target size
      0x90 | 0x01, 4, 5,  // copy offset=4 size=5
      5, 0x20, 0x72, 0x65, 0x64, 0x20,  // insert " red "
      0x90 | 0x01, 10, 5, // copy offset=10 size=5
    ]);
    expect(new TextDecoder().decode(applyGitDelta(delta, BASE, 1024))).toBe("quick red brown");
  });

  it("rejects a base size mismatch", () => {
    let delta = new Uint8Array([1, 0]);
    expect(() => applyGitDelta(delta, BASE, 1024)).toThrow(/base size mismatch/);
  });

  it("rejects out-of-range copies", () => {
    let delta = new Uint8Array([BASE.length, 10, 0x90 | 0x01, 40, 10]);
    expect(() => applyGitDelta(delta, BASE, 1024)).toThrow(/copy out of range/);
  });

  it("rejects a result over the cap before allocating it", () => {
    let delta = new Uint8Array([BASE.length, 100, 0x90, 0]);
    expect(() => applyGitDelta(delta, BASE, 10)).toThrow(/exceeds the 10-byte limit/);
  });

  it("rejects the reserved zero op", () => {
    let delta = new Uint8Array([BASE.length, 1, 0]);
    expect(() => applyGitDelta(delta, BASE, 1024)).toThrow(/reserved zero op/);
  });
});

describe("validateGitOid", () => {
  it("accepts 40-hex and rejects everything else", () => {
    expect(validateGitOid(COMMIT_1)).toBe(COMMIT_1);
    expect(() => validateGitOid(COMMIT_1.slice(0, 39))).toThrow(/Invalid git object id/);
    expect(() => validateGitOid(COMMIT_1.toUpperCase())).toThrow(/Invalid git object id/);
    expect(() => validateGitOid("")).toThrow(/Invalid git object id/);
  });
});
