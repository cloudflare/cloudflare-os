import { describe, expect, it } from "vitest";
import { createDeflate, createInflate, deflateSync, inflateSync } from "node:zlib";
import {
  GIT_DEFLATE_LEVEL,
  GitDeltaApplier,
  applyGitDelta,
  bytesDeltaBase,
  buildPackBytes,
  concatBytes,
  decodeLooseObject,
  decodePackStream,
  encodeGitCommit,
  encodeGitTree,
  encodeLooseObject,
  gitObjectOid,
  parseGitCommit,
  parseGitCommitRefs,
  parseGitTree,
  readGitCommitHeader,
  scanGitTree,
  signatureSafe,
  validateGitOid,
  type GitCommit,
  type DecodedPackObject,
  type DeltaBase,
  type GitTreeEntry,
  type PackableObject,
} from "../src/git-codec";
import {
  BlobReader,
  BlobWriter,
  CHUNK_MAX_SIZE,
  isChunkedBlobRecord,
  type ChunkStore,
} from "../src/git-chunked-blob";
import type { GitObjectType, GitOid } from "@gadgets/workshop-shared/gatekeeper";
import type {
  GitInlineObjectRecord,
  GitObjectRecord,
} from "../src/storage-schema/overseer-storage";
import { makeLocalGitCache } from "./local-git-cache";
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
  byteStream,
  decodePack,
} from "./git-cache-fixtures";

function fixture(oid: string): PackableObject {
  let object = FIXTURE_OBJECTS.find(o => o.oid === oid);
  if (!object) throw new Error(`no fixture object ${oid}`);
  return { type: object.type, payload: b64Bytes(object.payload) };
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
 * Encodes a `path -> text` map as nested trees, laid out as `WorkspaceGitCache.writeFilesAsCommit()`
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

/** `size` pseudo-random (so incompressible) bytes, the same for the same seed. */
function randomBytes(size: number, seed = 1): Uint8Array {
  let out = new Uint8Array(size);
  let state = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

/** `bytes` deflated, as a plain Uint8Array (a Buffer's slice() would alias, not copy). */
function deflate(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(deflateSync(bytes));
}

/** A pack entry, raw: its type code, the size its header declares, and its compressed data. */
interface RawPackEntry {
  typeCode: number;
  size: number;
  data: Uint8Array;
}

/** A blob entry of `payload`, deflated as git's own encoder would, declaring its true size. */
function blobEntry(payload: Uint8Array): RawPackEntry {
  return { typeCode: 3, size: payload.byteLength, data: deflate(payload) };
}

/** A pack entry's type-and-size varint. */
function entryHeader(typeCode: number, size: number): Uint8Array {
  let bytes = [(typeCode << 4) | (size & 0x0f)];
  for (size = Math.floor(size / 16); size > 0; size = Math.floor(size / 128)) {
    bytes[bytes.length - 1] |= 0x80;
    bytes.push(size & 0x7f);
  }
  return Uint8Array.from(bytes);
}

/** A pack of the given raw entries, with a valid trailer, and where each entry starts. */
async function rawPack(entries: RawPackEntry[]): Promise<{ pack: Uint8Array, offsets: number[] }> {
  let header = new Uint8Array(12);
  header.set(new TextEncoder().encode("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, entries.length);
  let parts = [header];
  let offsets: number[] = [];
  let offset = header.byteLength;
  for (let { typeCode, size, data } of entries) {
    offsets.push(offset);
    let entry = concatBytes([entryHeader(typeCode, size), data]);
    parts.push(entry);
    offset += entry.byteLength;
  }
  let body = concatBytes(parts);
  let trailer = new Uint8Array(await crypto.subtle.digest("SHA-1", body));
  return { pack: concatBytes([body, trailer]), offsets };
}

// Mirrors git-codec.ts's (private) zlibBound() and PackReader's read size.
const ZLIB_BOUND_SLACK = 13 + 6;
const PACK_READ_SIZE = 64 << 10;

// Mirrors git-codec.ts's (private) PACK_SYNC_INFLATE_LIMIT: entries above it are inflated as a
// stream.
const SYNC_INFLATE_LIMIT = 1 << 20;

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
    expect(() => decodeLooseObject(deflateSync(new TextEncoder().encode("blob 5\0abc"))))
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
    // U+FF5E (ef bd 9e) in git's order and precedes it in JavaScript's. Oid from real
    // `git mktree`.
    let payload = encodeGitTree([
      { mode: "100644", name: "\u{1F600}", oid: X_BLOB },
      { mode: "100644", name: "\uFF5E", oid: X_BLOB },
    ]);
    expect(parseGitTree(payload).map(e => e.name)).toStrictEqual(["\uFF5E", "\u{1F600}"]);
    expect(await gitObjectOid("tree", payload)).toBe("bb40f9cf9c37cab4cee8cbe15ff5dd0df3ddbb9e");
  });

  it("writes the same tree ids as the git store", async () => {
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
    let store = makeLocalGitCache();
    let commit = await store.writeFilesAsCommit(
        files, { parents: [], author: ALICE, message: "files", timestamp: new Date(0) });
    // Which isomorphic-git's tree writer wrote for the same files, frozen when it was dropped.
    expect(store.commitTree(commit)).toBe("9ec6a82169e39db089693f084d2159caa2175e8b");
    expect(await fileTreeOid(files)).toBe(store.commitTree(commit));
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

  it("reads every field of real-git commits, past a multi-line gpgsig", () => {
    expect(parseGitCommit(fixture(COMMIT_3).payload, COMMIT_3)).toStrictEqual({
      tree: "d8aa5286650240f9fc758910506e5cc39d3eef2c",
      parents: [COMMIT_2],
      author: { ...ALICE, ...at(1700000200) },
      committer: { ...ALICE, ...at(1700000200) },
      message: "third commit\n",
    });
    expect(parseGitCommit(fixture(GPGSIG_COMMIT).payload, GPGSIG_COMMIT)).toStrictEqual({
      tree: TREE_1,
      parents: [COMMIT_1],
      author: { ...ALICE, ...at(1700000300) },
      committer: { ...ALICE, ...at(1700000300) },
      message: "signed commit\n",
    });
  });

  it("reads back what the encoder writes, UTC offsets included", () => {
    let commit: GitCommit = {
      tree: TREE_1,
      parents: [COMMIT_1, COMMIT_2],
      author: { ...ALICE, ...at(1700000100, -300) },
      committer: { ...BOB, ...at(1700000200, 330) },
      headers: [{ name: "x-extra", value: "ignored" }],
      message: "Merge things\n\nBody line.\n",
    };
    let { headers: _, ...fields } = commit;
    expect(parseGitCommit(encodeGitCommit(commit))).toStrictEqual(fields);
  });

  it("normalizes the message and an offset of -0000 as git does", () => {
    let payload = new TextEncoder().encode(
        `tree ${TREE_1}\nauthor A <a@b> 1 -0000\ncommitter B <> 2 -0130\n\n\n\r\nsubject\r\n\n\n`);
    expect(parseGitCommit(payload)).toStrictEqual({
      tree: TREE_1,
      parents: [],
      author: { name: "A", email: "a@b", timestamp: new Date(1000), utcOffsetMinutes: 0 },
      committer: { name: "B", email: "", timestamp: new Date(2000), utcOffsetMinutes: -90 },
      message: "subject\n",
    });
    expect(Object.is(parseGitCommit(payload).author.utcOffsetMinutes, -0)).toBe(false);
  });

  it("rejects a commit whose author or committer cannot be read", () => {
    let noCommitter = `tree ${TREE_1}\nauthor A <a@b> 1 +0000\n\nmessage\n`;
    expect(() => parseGitCommit(new TextEncoder().encode(noCommitter), "0".repeat(40)))
        .toThrow(/0{40}: malformed committer header/);
    let noBrackets = `tree ${TREE_1}\nauthor A a@b 1 +0000\ncommitter A <a@b> 1 +0000\n\nm\n`;
    expect(() => parseGitCommit(new TextEncoder().encode(noBrackets)))
        .toThrow(/malformed author header/);
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
    // The ids isomorphic-git 1.42's writer wrote for the same commits, frozen when it was
    // dropped: every commit written before then keeps its id.
    let timestamp = new Date(1700000000_999);  // recorded in whole seconds, rounded down
    let cases: { parents: string[], message: string, committer?: typeof BOB, oid: string }[] = [
      { parents: [], message: "root",
        oid: "2a90a3e550c357e8e84229cb70af6349572c0d5f" },
      { parents: [COMMIT_1], message: "one parent\n",
        oid: "1da9157898656d60eaec98e2fbed4a3430586ec6" },
      { parents: [COMMIT_2, COMMIT_1], message: "two parents", committer: BOB,
        oid: "cc3afcecfc28e6520ce817093ea52f2921fd7e6c" },
      { parents: [COMMIT_1, COMMIT_2, COMMIT_3], message: "subject\n\nbody one\nbody two\n",
        oid: "7ce81be0fa8e066165003af6f5ba0ba67202d8ec" },
      { parents: [], message: "",
        oid: "0aff7a588695e4d435bef93621a004e65f9502b5" },
      { parents: [], message: "\n\n",
        oid: "0aff7a588695e4d435bef93621a004e65f9502b5" },
      { parents: [], message: "trailing blank lines\n\n\n",
        oid: "945786dfed9d28fa643ddc56a3273f6a190eaa51" },
      { parents: [], message: "\n\nleading blank lines",
        oid: "7feb2b83c97380eceb98ac092f0336b844322819" },
      { parents: [], message: "windows\r\n\r\nline endings\r\n",
        oid: "5c97ef83a94a333a240aad01828bd26da3ca4cda" },
      { parents: [], message: "  spaces and a \t tab are kept  \n",
        oid: "89331460b88453f44dfff7d79728e8e065e00271" },
      { parents: [], message: "caf\u00e9 \u{1F600}",
        oid: "917211f2ade148e59060eb2c444df86708a2962a" },
    ];
    // Every way a message is normalized is among them.
    for (let { parents, message, committer, oid } of cases) {
      let payload = encodeGitCommit({
        tree: TREE_1,
        parents,
        author: { ...ALICE, timestamp, utcOffsetMinutes: 0 },
        committer: { ...(committer ?? ALICE), timestamp, utcOffsetMinutes: 0 },
        message,
      });
      expect(await gitObjectOid("commit", payload), JSON.stringify(message)).toBe(oid);
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
    let body = concatBytes([header, entryHeader, oidBytes, deflateSync(delta)]);
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

// What the pack decoder relies on from workerd's own node:zlib.
describe("node:zlib", () => {
  const PAYLOAD = new TextEncoder().encode("all work and no play makes jack a dull boy\n".repeat(500));
  const STREAM = deflate(PAYLOAD);
  const TRAILING = Uint8Array.of(0x78, 0x9c, 1, 2, 3, 4, 5, 6, 7, 8);

  /** Feeds `inflater` `bytes` in `step`-byte writes; resolves on its end, with what it emitted. */
  async function feed(bytes: Uint8Array, step: number): Promise<Uint8Array> {
    let inflater = createInflate();
    let pieces: Uint8Array[] = [];
    let ended = new Promise<void>((resolve, reject) => {
      inflater.on("data", (piece: Uint8Array) => pieces.push(piece));
      inflater.on("end", resolve);
      inflater.on("error", reject);
    });
    for (let pos = 0; pos < bytes.byteLength; pos += step) {
      inflater.write(bytes.subarray(pos, pos + step));
    }
    await ended;
    expect(inflater.bytesWritten).toBe(STREAM.byteLength);
    return concatBytes(pieces);
  }

  it("inflateSync stops at the end of the zlib stream and reports the input it consumed", () => {
    let { buffer, engine } = inflateSync(concatBytes([STREAM, TRAILING]), { info: true }) as
        unknown as { buffer: Uint8Array, engine: { bytesWritten: number } };
    expect(new Uint8Array(buffer)).toStrictEqual(PAYLOAD);
    expect(engine.bytesWritten).toBe(STREAM.byteLength);
  });

  it("inflateSync fails truncated input with Z_BUF_ERROR, and only truncated input", () => {
    expect(() => inflateSync(STREAM.subarray(0, -1), { info: true }))
        .toThrow(expect.objectContaining({ code: "Z_BUF_ERROR" }));
    let corrupt = STREAM.slice();
    corrupt[corrupt.byteLength - 1] ^= 0xff;  // the Adler-32 check
    expect(() => inflateSync(corrupt, { info: true }))
        .toThrow(expect.not.objectContaining({ code: "Z_BUF_ERROR" }));
  });

  it("inflateSync honors maxOutputLength with a RangeError", () => {
    expect(inflateSync(STREAM, { maxOutputLength: PAYLOAD.byteLength }).byteLength)
        .toBe(PAYLOAD.byteLength);
    expect(() => inflateSync(STREAM, { info: true, maxOutputLength: PAYLOAD.byteLength - 1 }))
        .toThrow(RangeError);
  });

  it("createInflate ends at the end of the zlib stream, however its input is split", async () => {
    for (let step of [1, 7, 100, STREAM.byteLength, STREAM.byteLength + TRAILING.byteLength]) {
      expect(await feed(concatBytes([STREAM, TRAILING]), step)).toStrictEqual(PAYLOAD);
    }
    // Ending exactly at a write's end, it ends on the next write, consuming none of it.
    let inflater = createInflate();
    let ended = false;
    inflater.on("data", () => {});
    inflater.on("end", () => { ended = true; });
    await new Promise(resolve => inflater.write(STREAM, resolve));
    expect(inflater.bytesWritten).toBe(STREAM.byteLength);
    await new Promise(resolve => inflater.write(TRAILING, resolve));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ended).toBe(true);
    expect(inflater.bytesWritten).toBe(STREAM.byteLength);
  });

  it("createDeflate at GIT_DEFLATE_LEVEL, written in pieces, round-trips", async () => {
    let deflater = createDeflate({ level: GIT_DEFLATE_LEVEL });
    let pieces: Uint8Array[] = [];
    let ended = new Promise<void>((resolve, reject) => {
      deflater.on("data", (piece: Uint8Array) => pieces.push(piece));
      deflater.on("end", resolve);
      deflater.on("error", reject);
    });
    for (let pos = 0; pos < PAYLOAD.byteLength; pos += 1000) {
      deflater.write(PAYLOAD.subarray(pos, pos + 1000));
    }
    deflater.end();
    await ended;
    expect(new Uint8Array(inflateSync(concatBytes(pieces)))).toStrictEqual(PAYLOAD);
  });
});

describe("pack entry inflation", () => {
  const LARGE = randomBytes(SYNC_INFLATE_LIMIT + (512 << 10), 7);

  /** Decodes `pack` and checks it yields exactly `payloads`, as blobs. */
  async function expectBlobs(pack: Uint8Array, payloads: Uint8Array[], step?: number) {
    let objects = await decodePack(pack, { step });
    expect(objects.length).toBe(payloads.length);
    for (let [i, object] of objects.entries()) {
      expect(object.type).toBe("blob");
      expect(object.oid).toBe(await gitObjectOid("blob", payloads[i]));
      // Not toStrictEqual: a megabyte-long diff of a mismatch is no help.
      expect(object.payload.byteLength).toBe(payloads[i].byteLength);
      expect(compareBytesEqual(object.payload, payloads[i])).toBe(true);
    }
  }

  function compareBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
  }

  it("decodes entries spanning reads, including a header split across two", async () => {
    // Size the first blob so that the second entry's 3-byte header starts one byte before the
    // first read boundary.
    let target = PACK_READ_SIZE - 1;
    let size = target - 64;
    for (let tries = 0; ; tries++) {
      expect(tries).toBeLessThan(50);
      let end = 12 + entryHeader(3, size).byteLength + deflateSync(randomBytes(size, 1)).byteLength;
      if (end === target) break;
      size += Math.sign(target - end);
    }
    let payloads = [randomBytes(size, 1), randomBytes(200 << 10, 2), randomBytes(100, 3)];
    let { pack, offsets } = await rawPack(payloads.map(blobEntry));
    expect(offsets[1]).toBe(target);
    expect(entryHeader(3, payloads[1].byteLength).byteLength).toBe(3);
    for (let step of [undefined, 1000, 4097]) await expectBlobs(pack, payloads, step);
  });

  it("holds only its window of a large entry, however short the source's reads", async () => {
    // A read's view retains its whole read buffer: were each read of the window kept whole,
    // these 1-byte reads would hold a 64 KiB buffer apiece, some 64 GiB in all.
    let payloads = [randomBytes(SYNC_INFLATE_LIMIT, 4), new TextEncoder().encode("after")];
    let { pack } = await rawPack(payloads.map(blobEntry));
    await expectBlobs(pack, payloads, 1);
  }, 60_000);

  it("decodes a zero-length blob", async () => {
    let payloads = [new Uint8Array(0), new TextEncoder().encode("after"), new Uint8Array(0)];
    let pack = concatBytes(await buildPackBytes(payloads.map(payload => ({ type: "blob", payload }))));
    for (let step of [undefined, 1]) await expectBlobs(pack, payloads, step);
  });

  it("decodes an entry whose stream is longer than any zlib would write", async () => {
    // Empty stored blocks after the zlib header: valid, but past the window the synchronous
    // inflate is given, so the entry is decoded again as a stream.
    let payload = new TextEncoder().encode("padded");
    let stream = deflate(payload);
    let padding = new Uint8Array(5 * 20);
    for (let i = 0; i < padding.byteLength; i += 5) padding.set([0, 0, 0, 0xff, 0xff], i);
    let padded = concatBytes([stream.subarray(0, 2), padding, stream.subarray(2)]);
    expect(padded.byteLength).toBeGreaterThan(payload.byteLength + ZLIB_BOUND_SLACK);
    expect(new Uint8Array(inflateSync(padded))).toStrictEqual(payload);

    let after = new TextEncoder().encode("after");
    let { pack, offsets } = await rawPack(
        [{ typeCode: 3, size: payload.byteLength, data: padded }, blobEntry(after)]);
    for (let step of [undefined, 1]) await expectBlobs(pack, [payload, after], step);

    // Truncated within the padding, it is a truncated pack.
    await expect(decodePack(pack.subarray(0, offsets[0] + 40)))
        .rejects.toThrow("invalid packfile: truncated");
  });

  it("decodes an entry too large to inflate whole, wherever its stream ends", async () => {
    let after = new TextEncoder().encode("after");
    let { pack, offsets } = await rawPack([blobEntry(LARGE), blobEntry(after)]);
    // With `offsets[1]` as the step, the large entry's stream ends exactly at a read's end.
    for (let step of [undefined, offsets[1], 4097]) {
      await expectBlobs(pack, [LARGE, after], step);
    }
  });

  for (let [path, payload] of [["synchronous", randomBytes(100, 5)], ["streaming", LARGE]] as const) {
    it(`rejects a lying size header (${path})`, async () => {
      let { data } = blobEntry(payload);
      let over = await rawPack([{ typeCode: 3, size: payload.byteLength - 1, data }]);
      await expect(decodePack(over.pack))
          .rejects.toThrow("invalid packfile: object larger than its declared size");
      let under = await rawPack([{ typeCode: 3, size: payload.byteLength + 1, data }]);
      await expect(decodePack(under.pack))
          .rejects.toThrow("invalid packfile: object smaller than its declared size");
    });

    it(`rejects a pack truncated inside an entry (${path})`, async () => {
      let { pack, offsets } = await rawPack([blobEntry(payload)]);
      let cut = offsets[0] + Math.floor(payload.byteLength / 2);
      for (let step of [undefined, 1000]) {
        await expect(decodePack(pack.subarray(0, cut), { step }))
            .rejects.toThrow("invalid packfile: truncated");
      }
    });

    it(`rejects corrupt entry data (${path})`, async () => {
      let { data } = blobEntry(payload);
      for (let at of [0, data.byteLength - 1]) {  // the zlib header, and the Adler-32 check
        let corrupt = data.slice();
        corrupt[at] ^= 0xff;
        let { pack } = await rawPack([{ typeCode: 3, size: payload.byteLength, data: corrupt }]);
        await expect(decodePack(pack)).rejects.toThrow(/invalid packfile: corrupt object data/);
      }
    });
  }

  it("rejects a 0-byte entry that inflates to more", async () => {
    let { pack } = await rawPack([{ typeCode: 3, size: 0, data: deflate(Uint8Array.of(1)) }]);
    await expect(decodePack(pack))
        .rejects.toThrow("invalid packfile: object larger than its declared size");
  });

  it("decodes a repository-sized pack of many small objects to the same oids", async () => {
    let encoder = new TextEncoder();
    let objects: PackableObject[] = [];
    let entries: GitTreeEntry[] = [];
    for (let i = 0; i < 3000; i++) {
      let payload = encoder.encode(`file ${i}\n`.repeat(i % 40));
      objects.push({ type: "blob", payload });
      entries.push({ mode: "100644", name: `f${i}`, oid: await gitObjectOid("blob", payload) });
    }
    objects.push({ type: "tree", payload: encodeGitTree(entries) });
    let expected = await Promise.all(objects.map(o => gitObjectOid(o.type, o.payload)));
    let pack = concatBytes(await buildPackBytes(objects));
    for (let step of [undefined, 1000]) {
      expect((await decodePack(pack, { step })).map(o => o.oid)).toStrictEqual(expected);
    }
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

// The delta applier as it was before GitDeltaApplier, whole-buffer: the reference the streaming
// one must match byte for byte.
function referenceApplyDelta(delta: Uint8Array, base: Uint8Array): Uint8Array {
  let pos = 0;
  let varint = () => {
    let value = 0;
    for (let factor = 1, byte = 0x80; byte & 0x80; factor *= 128) {
      if (pos >= delta.length) throw new Error("invalid delta: truncated size");
      byte = delta[pos++];
      value += (byte & 0x7f) * factor;
    }
    return value;
  };
  if (varint() !== base.length) throw new Error("invalid delta: base size mismatch");
  let target = new Uint8Array(varint());
  let written = 0;
  while (pos < delta.length) {
    let op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 7; i++) {
        if (!(op & (1 << i))) continue;
        if (pos >= delta.length) throw new Error("invalid delta: truncated copy op");
        if (i < 4) offset += delta[pos++] * 2 ** (8 * i);
        else size += delta[pos++] * 2 ** (8 * (i - 4));
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length || written + size > target.length) {
        throw new Error("invalid delta: copy out of range");
      }
      target.set(base.subarray(offset, offset + size), written);
      written += size;
    } else if (op > 0) {
      if (pos + op > delta.length || written + op > target.length) {
        throw new Error("invalid delta: insert out of range");
      }
      target.set(delta.subarray(pos, pos + op), written);
      pos += op;
      written += op;
    } else {
      throw new Error("invalid delta: reserved zero op");
    }
  }
  if (written !== target.length) throw new Error("invalid delta: result size mismatch");
  return target;
}

function deltaVarint(n: number): number[] {
  let out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    out.push(n > 0 ? byte | 0x80 : byte);
  } while (n > 0);
  return out;
}

// A copy instruction as git encodes one: only the nonzero bytes of offset and size are present,
// and a size of 0x10000 may be written as none at all. Splits a copy git could not encode in one.
function copyOps(offset: number, size: number): number[] {
  let out: number[] = [];
  while (size > 0) {
    let take = Math.min(size, 0xffffff);
    let op = 0x80;
    let args: number[] = [];
    for (let i = 0; i < 4; i++) {
      let byte = Math.floor(offset / 2 ** (8 * i)) & 0xff;
      if (byte !== 0) { op |= 1 << i; args.push(byte); }
    }
    if (take !== 0x10000) {
      for (let i = 0; i < 3; i++) {
        let byte = (take >> (8 * i)) & 0xff;
        if (byte !== 0) { op |= 0x10 << i; args.push(byte); }
      }
    }
    out.push(op, ...args);
    offset += take;
    size -= take;
  }
  return out;
}

function insertOps(bytes: Uint8Array): number[] {
  let out: number[] = [];
  for (let pos = 0; pos < bytes.length; pos += 127) {
    let piece = bytes.subarray(pos, pos + 127);
    out.push(piece.length, ...piece);
  }
  return out;
}

// A delta turning `base` into `base` with `inserted` spliced in at `where`, and the target.
function spliceDelta(base: Uint8Array, where: number, inserted: Uint8Array)
    : { delta: Uint8Array, target: Uint8Array } {
  let target = concatBytes([base.subarray(0, where), inserted, base.subarray(where)]);
  let delta = Uint8Array.from([
    ...deltaVarint(base.length), ...deltaVarint(target.length),
    ...copyOps(0, where), ...insertOps(inserted), ...copyOps(where, base.length - where),
  ]);
  return { delta, target };
}

// A random valid delta over `base`: copies (some of 0x10000, encoded without size bytes) and
// inserts, in random order.
function randomDelta(base: Uint8Array, seed: number): Uint8Array {
  let noise = randomBytes(4096, seed);
  let n = 0;
  let next = () => noise[n++ % noise.length];
  let ops: number[] = [];
  let targetSize = 0;
  for (let i = 0; i < 60; i++) {
    if (next() & 1) {
      let size = next() % 7 === 0 && base.length >= 0x10000 ? 0x10000
          : 1 + ((next() << 8 | next()) % Math.min(base.length, 3000));
      let offset = (next() << 16 | next() << 8 | next()) % (base.length - size + 1);
      ops.push(...copyOps(offset, size));
      targetSize += size;
    } else {
      let inserted = randomBytes(1 + next() % 300, seed * 1000 + i);
      ops.push(...insertOps(inserted));
      targetSize += inserted.length;
    }
  }
  return Uint8Array.from([...deltaVarint(base.length), ...deltaVarint(targetSize), ...ops]);
}

// Applies a delta through GitDeltaApplier, pushed in pieces of `step` bytes, collecting the
// result (copied, as its pieces are borrowed).
function applyInSteps(delta: Uint8Array, base: DeltaBase, step: number): Uint8Array {
  let pieces: Uint8Array[] = [];
  let applier = new GitDeltaApplier(base, () => piece => { pieces.push(piece.slice()); });
  for (let pos = 0; pos < delta.length; pos += step) applier.push(delta.subarray(pos, pos + step));
  applier.finish();
  return concatBytes(pieces);
}

describe("GitDeltaApplier", () => {
  const BASE = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");
  const VECTORS = [
    new Uint8Array([BASE.length, 15, 0x91, 4, 5, 5, 0x20, 0x72, 0x65, 0x64, 0x20, 0x91, 10, 5]),
    new Uint8Array([BASE.length, 0]),
    new Uint8Array([BASE.length, BASE.length, 0x90, BASE.length]),
  ];
  const MALFORMED: [Uint8Array, RegExp][] = [
    [new Uint8Array([1, 0]), /base size mismatch/],
    [new Uint8Array([BASE.length, 10, 0x91, 40, 10]), /copy out of range/],
    [new Uint8Array([BASE.length, 4, 0x90, 5]), /copy out of range/],
    [new Uint8Array([BASE.length, 1, 0]), /reserved zero op/],
    [new Uint8Array([BASE.length]), /truncated size/],
    [new Uint8Array([BASE.length, 0x80]), /truncated size/],
    [new Uint8Array([BASE.length, 5, 0x91, 4]), /truncated copy op/],
    [new Uint8Array([BASE.length, 5, 5, 0x61, 0x62]), /insert out of range/],
    [new Uint8Array([BASE.length, 2, 3, 0x61, 0x62, 0x63]), /insert out of range/],
    [new Uint8Array([BASE.length, 6, 0x91, 4, 5]), /result size mismatch/],
  ];

  it("matches the whole-buffer applier on every split of the delta", () => {
    let large = randomBytes(80_000, 3);
    let cases = [
      ...VECTORS.map(delta => ({ delta, base: BASE })),
      ...[1, 2, 3, 4].map(seed => ({ delta: randomDelta(large, seed), base: large })),
    ];
    for (let { delta, base } of cases) {
      let expected = referenceApplyDelta(delta, base);
      for (let step of [1, 2, 7, delta.length]) {
        expect(sameBytes(applyInSteps(delta, bytesDeltaBase(base), step), expected)).toBe(true);
      }
      expect(sameBytes(applyGitDelta(delta, base), expected)).toBe(true);
    }
  });

  it("rejects every malformed delta the whole-buffer applier rejects, however split", () => {
    for (let [delta, error] of MALFORMED) {
      expect(() => referenceApplyDelta(delta, BASE)).toThrow(error);
      for (let step of [1, delta.length]) {
        expect(() => applyInSteps(delta, bytesDeltaBase(BASE), step)).toThrow(error);
      }
    }
  });

  it("knows the target size once the header is read, before any output", () => {
    let sizes: number[] = [];
    let applier = new GitDeltaApplier(bytesDeltaBase(BASE), size => {
      sizes.push(size);
      return () => {};
    });
    applier.push(VECTORS[0].subarray(0, 1));
    expect(applier.targetSize).toBeUndefined();
    applier.push(VECTORS[0].subarray(1, 2));
    expect(applier.targetSize).toBe(15);
    expect(sizes).toStrictEqual([15]);
  });

  it("copies from a chunked base, across chunk boundaries, in bounded pieces", () => {
    let store = mapChunkStore();
    let base = randomBytes(5 * 1024 * 1024, 4);
    let writer = new BlobWriter(store, base.length);
    writer.write(base);
    let { record } = writer.finish();
    let reader = BlobReader.open(store, record!);
    let { delta, target } = spliceDelta(base, 2_500_001, randomBytes(1000, 5));
    let pieces: number[] = [];
    let out: Uint8Array[] = [];
    let applier = new GitDeltaApplier(reader, () => piece => {
      pieces.push(piece.length);
      out.push(piece.slice());
    });
    applier.push(delta);
    applier.finish();
    expect(sameBytes(concatBytes(out), target)).toBe(true);
    expect(Math.max(...pieces)).toBeLessThanOrEqual(1 << 20);
  });
});

// Whether two byte arrays are equal. (toStrictEqual on a multi-megabyte array exhausts the
// test's memory.)
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength)
      .equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

function mapChunkStore(): ChunkStore & { rows: Map<string, GitObjectRecord> } {
  let rows = new Map<string, GitObjectRecord>();
  return { rows, get: oid => rows.get(oid), put: record => { rows.set(record.oid, record); } };
}

// Decodes as consumePack does: blobs over CHUNK_MAX_SIZE stream into `store`.
async function decodeStreaming(pack: Uint8Array, store = mapChunkStore()) {
  let held = new Map<GitOid, PackableObject>();
  let out: DecodedPackObject[] = [];
  for await (let object of decodePackStream(byteStream(pack, 65536), {
    resolveBase: oid => held.get(oid),
    resolveLargeBase: oid => {
      let record = store.rows.get(oid);
      return record === undefined ? undefined : BlobReader.open(store, record);
    },
    openBlobSink: size => {
      if (size <= CHUNK_MAX_SIZE) return undefined;
      let writer = new BlobWriter(store, size);
      return {
        write: piece => writer.write(piece),
        finish: () => {
          let { oid, record } = writer.finish();
          store.put(record! as unknown as GitInlineObjectRecord);
          return oid;
        },
      };
    },
  })) {
    if (!object.stored) held.set(object.oid, object);
    out.push(object);
  }
  return { out, store };
}

function readStored(store: ReturnType<typeof mapChunkStore>, oid: GitOid): Uint8Array {
  let reader = BlobReader.open(store, store.rows.get(oid)!);
  return reader.read(0, reader.size);
}

// Pack decoding with large blobs streamed into a chunk store, as the git store decodes.
describe("pack decoding, streaming large blobs", () => {
  const MiB = 1024 * 1024;

  // Builds a pack whose entries may be deltas against earlier entries (by index, ofs or ref)
  // or against an outside oid.
  type Entry =
    | { payload: Uint8Array, type?: GitObjectType }
    | { delta: Uint8Array, ofs: number }
    | { delta: Uint8Array, ref: GitOid };
  async function buildPack(entries: Entry[]): Promise<Uint8Array> {
    let header = new Uint8Array(12);
    header.set(new TextEncoder().encode("PACK"));
    new DataView(header.buffer).setUint32(4, 2);
    new DataView(header.buffer).setUint32(8, entries.length);
    let parts = [header];
    let offsets: number[] = [];
    let offset = 12;
    for (let spec of entries) {
      offsets.push(offset);
      let bytes: Uint8Array;
      if ("payload" in spec) {
        let code = { commit: 1, tree: 2, blob: 3, tag: 4 }[spec.type ?? "blob"];
        bytes = concatBytes([entryHeader(code, spec.payload.length), deflate(spec.payload)]);
      } else if ("ofs" in spec) {
        let rel = offset - offsets[spec.ofs];
        let rev = [rel & 0x7f];
        while ((rel = Math.floor(rel / 128)) > 0) {
          rel--;
          rev.push(0x80 | (rel & 0x7f));
        }
        bytes = concatBytes([entryHeader(6, spec.delta.length), Uint8Array.from(rev.toReversed()),
          deflate(spec.delta)]);
      } else {
        bytes = concatBytes([entryHeader(7, spec.delta.length),
          Uint8Array.from(spec.ref.match(/../g)!, h => parseInt(h, 16)), deflate(spec.delta)]);
      }
      parts.push(bytes);
      offset += bytes.length;
    }
    let body = concatBytes(parts);
    return concatBytes([body, new Uint8Array(await crypto.subtle.digest("SHA-1", body))]);
  }

  it("streams a 20 MiB blob into chunks, verifying its oid", async () => {
    let big = randomBytes(20 * MiB, 6);
    let small = new TextEncoder().encode("small\n");
    let tree = encodeGitTree([{ mode: "100644", name: "small", oid: await gitObjectOid("blob", small) }]);
    let pack = await buildPack([{ payload: big }, { payload: small }, { payload: tree, type: "tree" }]);
    let { out, store } = await decodeStreaming(pack);
    let bigOid = await gitObjectOid("blob", big);
    expect(out[0]).toStrictEqual({ oid: bigOid, type: "blob", size: big.length, stored: true });
    expect(isChunkedBlobRecord(store.rows.get(bigOid)!)).toBe(true);
    expect(sameBytes(readStored(store, bigOid), big)).toBe(true);
    // Small blobs and trees come back whole, as without a sink.
    expect(out[1]).toStrictEqual({ oid: await gitObjectOid("blob", small), type: "blob", payload: small });
    expect(out[2]).toStrictEqual({ oid: await gitObjectOid("tree", tree), type: "tree", payload: tree });
  });

  it("applies ofs- and ref-deltas, and a chain of them, against large blobs", async () => {
    let b0 = randomBytes(6 * MiB, 7);
    let d1 = spliceDelta(b0, 3 * MiB, randomBytes(100, 8));
    let d2 = spliceDelta(d1.target, 17, randomBytes(5000, 9));
    let d3 = spliceDelta(d2.target, d2.target.length - 3, randomBytes(1, 10));
    let oids = await Promise.all([b0, d1.target, d2.target, d3.target]
        .map(payload => gitObjectOid("blob", payload)));
    let pack = await buildPack([
      { payload: b0 },
      { delta: d1.delta, ofs: 0 },
      { delta: d2.delta, ref: oids[1] },
      { delta: d3.delta, ofs: 2 },
    ]);
    let { out, store } = await decodeStreaming(pack);
    expect(out.map(o => o.oid)).toStrictEqual(oids);
    expect(out.every(o => o.stored)).toBe(true);
    expect(sameBytes(readStored(store, oids[3]), d3.target)).toBe(true);
  });

  it("applies a delta against a large blob already in storage", async () => {
    let base = randomBytes(3 * MiB, 11);
    let baseOid = await gitObjectOid("blob", base);
    let { store } = await decodeStreaming(await buildPack([{ payload: base }]));
    let large = spliceDelta(base, 12345, randomBytes(10, 12));
    // A small target from the large base is buffered.
    let small = new Uint8Array([...deltaVarint(base.length), 16, ...copyOps(MiB, 16)]);
    let pack = await buildPack([{ delta: large.delta, ref: baseOid }, { delta: small, ref: baseOid }]);
    let { out } = await decodeStreaming(pack, store);
    expect(out[0]).toStrictEqual(
        { oid: await gitObjectOid("blob", large.target), type: "blob", size: large.target.length,
          stored: true });
    let target = base.subarray(MiB, MiB + 16);
    expect(out[1]).toStrictEqual({ oid: await gitObjectOid("blob", target), type: "blob", payload: target });
  });

  it("still fails a trailer mismatch", async () => {
    let pack = await buildPack([{ payload: randomBytes(2 * MiB, 13) }]);
    pack[pack.length - 1] ^= 1;
    await expect(decodeStreaming(pack)).rejects.toThrow(/trailer SHA-1 mismatch/);
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
