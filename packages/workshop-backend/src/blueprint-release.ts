// Blueprint releases: the commit a blueprint version is, the packfile it ships in, the check
// that decides what such a pack may bring into a workspace, and the header with which a gadget's
// commit marks a release it merged.
//
// A blueprint version is a *release commit*: a synthetic commit whose tree is the source gadget's
// at the moment of publishing. Its first parent is the blueprint's previous release and its other
// parents are the upstream releases merged into the gadget since, so releases form a public graph
// in which a first-parent chain is one blueprint's own history -- its *lineage*.
//
// A release ships as a pack carrying three things:
// - the release's whole tree;
// - every ancestor commit, without its tree, which makes the graph walkable by whoever holds the
//   pack and so lets them find the release they have in common with it;
// - for each *other* lineage in that ancestry, the whole tree of its newest release there. That
//   release is where the blueprint forked from the other lineage, and a three-way merge against
//   it needs its files, not just its id.
//
// Packs arrive from uploads and from storage any uploader can write, so `validateReleaseObjects()`
// admits only what this module could itself have written. It is the one definition of a valid
// release: reading applies it to what a pack holds and publishing to what a pack is about to
// hold, so a blueprint that publishes always instantiates.
//
// Everything here is pure computation over byte arrays and an object lookup: no storage, no RPC,
// no `cloudflare:*` imports. The same code serves the Overseer, the bundled-blueprint installer
// and the import script.

import type { CommitIdentity } from "@gadgets/workshop-shared/api";
import { MAX_FILE_PATH_LENGTH, MAX_FILE_TEXT_LENGTH } from "@gadgets/workshop-shared/code-change";
import type { GitObjectType, GitOid } from "@gadgets/workshop-shared/gatekeeper";
import {
  buildPackBytes,
  concatBytes,
  decodePackStream,
  encodeGitCommit,
  encodeGitTree,
  gitObjectOid,
  parseGitCommitRefs,
  parseGitTree,
  readGitCommitHeader,
  scanGitTree,
  signatureSafe,
  type GitCommitHeader,
  type GitCommitRefs,
  type GitTreeEntry,
  type PackableObject,
} from "./git-codec";

const ENCODER = new TextEncoder();

// Strict, and keeping a leading BOM as content, for the reason parseGitTree() gives: a lossy
// decode would not re-encode to the bytes it came from.
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Largest pack a release may ship in. Equal to the `.gadget` archive's content cap
 * (blueprint-archive.ts), so that every stored pack can be downloaded and uploaded again.
 */
export const MAX_RELEASE_PACK_BYTES = 32 * 1024 * 1024;

/**
 * Largest object a release pack may hold: the longest UTF-8 encoding of a file of
 * `MAX_FILE_TEXT_LENGTH`, at three bytes per UTF-16 code unit.
 */
export const MAX_RELEASE_OBJECT_BYTES = 3 * MAX_FILE_TEXT_LENGTH;

/**
 * Most commits a release's history may hold, the release included. Each publish adds one commit
 * to its blueprint's lineage, and a derived blueprint inherits the lineages it merged.
 */
export const MAX_RELEASE_COMMITS = 10_000;

/** Git objects by oid. */
export type GitObjectMap = Map<GitOid, PackableObject>;

/** Reads one object from wherever the caller keeps them, or returns undefined if it is not held. */
export type GitObjectLookup = (oid: GitOid) => PackableObject | undefined;

function invalid(message: string): Error {
  return new Error(`invalid blueprint release: ${message}`);
}

// =======================================================================================
// Writing release commits

/** What `encodeReleaseCommit()` writes a release commit from. */
export interface Release {
  /** The released tree: the source gadget's, at the moment of publishing. */
  tree: GitOid;

  /**
   * The blueprint's previous release first (or, for a derived blueprint's first release, its own
   * empty root), then each upstream release merged into the source gadget since. Empty for an
   * original blueprint's first release, and for an empty root, which is written as a release
   * too: version 0, of the empty tree.
   */
  parents: GitOid[];

  /** The publisher: the same identity the blueprint's metadata names as its author. */
  author: CommitIdentity;

  /** The blueprint's title at the time of this release. */
  title: string;

  /** The blueprint's version counter at this release (`BlueprintMetadata.version`). */
  version: number;

  /** When the release was published. */
  timestamp: Date;
}

/**
 * Encodes a release commit's payload. The source gadget's own history is deliberately not part
 * of it: that history's messages hold chat titles and its authors include collaborators.
 *
 * The author is whatever the publisher calls themselves, so the characters a commit's signature
 * cannot hold are dropped from it, as git drops them, rather than refused.
 */
export function encodeReleaseCommit(release: Release): Uint8Array {
  let signature = {
    name: signatureSafe(release.author.name),
    email: signatureSafe(release.author.email),
    timestamp: release.timestamp,
    utcOffsetMinutes: 0,
  };
  return encodeGitCommit({
    tree: release.tree,
    parents: release.parents,
    author: signature,
    committer: signature,
    message: `Release ${release.version}: ${release.title}`,
  });
}

// The identity, time and message of every snapshot release. These are part of each one's commit
// id, so they can never change.
const SNAPSHOT_SIGNATURE = {
  name: "Blueprint",
  email: "blueprint@gadgets.invalid",
  timestamp: new Date(0),
  utcOffsetMinutes: 0,
};
const SNAPSHOT_MESSAGE = "Blueprint snapshot";

/**
 * Builds the release for content that is nothing but its files: a blueprint stored before
 * releases were commits, or one the deployment bundles. It is a parentless commit that depends on
 * the files alone, so every workspace and every deployment derives the same commit id from the
 * same content, and so finds that release in common with anyone else who did.
 *
 * Returns the commit along with the trees and blobs beneath it. Throws on a path git cannot
 * represent; the result is otherwise unchecked (see `validateReleaseObjects()`).
 */
export async function buildSnapshotRelease(files: ReadonlyMap<string, string>):
    Promise<{ commitId: GitOid, objects: GitObjectMap }> {
  let objects: GitObjectMap = new Map();
  let commitId = await addObject(objects, "commit", encodeGitCommit({
    tree: await addFileTree(objects, files),
    parents: [],
    author: SNAPSHOT_SIGNATURE,
    committer: SNAPSHOT_SIGNATURE,
    message: SNAPSHOT_MESSAGE,
  }));
  return { commitId, objects };
}

async function addObject(objects: GitObjectMap, type: GitObjectType, payload: Uint8Array):
    Promise<GitOid> {
  let oid = await gitObjectOid(type, payload);
  objects.set(oid, { type, payload });
  return oid;
}

// Adds the tree for a `path -> text` map, and everything beneath it, returning the tree's oid:
// the same tree GitStore.writeFilesAsCommit() writes for those files.
async function addFileTree(objects: GitObjectMap, files: ReadonlyMap<string, string>):
    Promise<GitOid> {
  let entries: GitTreeEntry[] = [];
  let directories = new Map<string, Map<string, string>>();
  for (let [path, text] of files) {
    let slash = path.indexOf("/");
    if (slash < 0) {
      let oid = await addObject(objects, "blob", ENCODER.encode(text));
      entries.push({ mode: "100644", name: path, oid });
    } else {
      let name = path.slice(0, slash);
      let directory = directories.get(name) ?? new Map<string, string>();
      directories.set(name, directory.set(path.slice(slash + 1), text));
    }
  }
  for (let [name, directory] of directories) {
    entries.push({ mode: "40000", name, oid: await addFileTree(objects, directory) });
  }
  // encodeGitTree() is what refuses an empty or dot segment, and a path that is both a file and
  // a directory.
  return await addObject(objects, "tree", encodeGitTree(entries));
}

// =======================================================================================
// Merging releases
//
// A gadget's commit that merges a release has the release among its parents, and names it in a
// header after `committer`:
//
//     blueprint-release <release commit>
//
// Not every parent of a gadget's commit but the first is a release: one can be a chat's own
// files, merged with mainline when the chat is brought up to date. So nothing takes a parent for
// a release unless the header marks it as one. A release's parents are published along with the
// history beneath them, and a gadget's own commit among them would publish what its chats hold.
//
// Nothing a user types can write the header. A commit message cannot reach the headers, and
// encodeGitCommit() refuses a name or email that could. Nor can a pack bring a marked commit
// in: validateReleaseObjects() admits commits only in the form a release has, which carries no
// header of its own.

const RELEASE_HEADER = "blueprint-release";

/** The header that marks a commit as merging `release`, which must be one of its parents. */
export function releaseMergeHeader(release: GitOid): GitCommitHeader {
  return { name: RELEASE_HEADER, value: release };
}

/**
 * The releases that a commit merged: those its header marks as merged that are among its
 * parents other than the first, in the order of its parents. A mark naming the first parent,
 * which is the gadget's own previous state, or naming no parent at all, marks nothing.
 */
export function releasesMergedBy(payload: Uint8Array, commitId?: GitOid): GitOid[] {
  let marked = new Set(readGitCommitHeader(payload, RELEASE_HEADER));
  let { parents } = parseGitCommitRefs(payload, commitId);
  return parents.slice(1).filter(parent => marked.has(parent));
}

// =======================================================================================
// Validation

// The header of a commit exactly as encodeGitCommit() writes it. What follows is the message.
const SIGNATURE_SHAPE = String.raw`[^<>\n\0]* <[^<>\n\0]*> \d+ [+-]\d{4}`;
const COMMIT_SHAPE = new RegExp(
    String.raw`^tree [0-9a-f]{40}\n(?:parent [0-9a-f]{40}\n)*` +
    String.raw`author ${SIGNATURE_SHAPE}\ncommitter ${SIGNATURE_SHAPE}\n\n`);

/**
 * Throws unless `objects` is exactly what a pack for the release `commitId` may hold:
 *
 * - The release commit is present, and so is every ancestor: history is closed. There are at
 *   most `MAX_RELEASE_COMMITS` commits, each in the form `encodeGitCommit()` writes.
 * - The release's tree is complete. Any other commit's tree is complete or absent, where absent
 *   means its root tree object is.
 * - Every tree is in the form `encodeGitTree()` writes, and holds only subtrees and mode-100644
 *   blobs under names `GitStore` can read back. Every blob is UTF-8 text of at most
 *   `MAX_FILE_TEXT_LENGTH`, at a path of at most `MAX_FILE_PATH_LENGTH`.
 * - No object exceeds `MAX_RELEASE_OBJECT_BYTES`, and there is no object besides these.
 *
 * Together these make every file the objects describe readable by `GitStore.readCommitFiles()`
 * and editable by a code change, and every commit readable by `GitStore.readCommitLog()`. The
 * keys are trusted to be each object's true oid.
 */
export function validateReleaseObjects(
    objects: ReadonlyMap<GitOid, PackableObject>, commitId: GitOid): void {
  let reached = new Set<GitOid>();
  let take = (oid: GitOid, type: GitObjectType): Uint8Array => {
    let object = objects.get(oid);
    if (object === undefined) throw invalid(`${type} ${oid} is missing`);
    if (object.type !== type) throw invalid(`object ${oid} is a ${object.type}, not a ${type}`);
    if (object.payload.byteLength > MAX_RELEASE_OBJECT_BYTES) {
      throw invalid(`${type} ${oid} is larger than ${MAX_RELEASE_OBJECT_BYTES} bytes`);
    }
    reached.add(oid);
    return object.payload;
  };

  // Commits. `trees` lists each one's tree, the release's own first.
  let trees: GitOid[] = [];
  let pending = [commitId];
  for (let oid of pending) {  // sees the parents pushed below
    if (reached.has(oid)) continue;
    if (trees.length === MAX_RELEASE_COMMITS) {
      throw invalid(`its history holds more than ${MAX_RELEASE_COMMITS} commits`);
    }
    let payload = take(oid, "commit");
    if (!COMMIT_SHAPE.test(decodeText(payload, `commit ${oid}`))) {
      throw invalid(`commit ${oid} is not in canonical form`);
    }
    let refs = parseGitCommitRefs(payload, oid);
    trees.push(refs.tree);
    pending.push(...refs.parents);
  }

  let blobs = new Set<GitOid>();
  let checkBlob = (oid: GitOid): void => {
    if (blobs.has(oid)) return;
    if (decodeText(take(oid, "blob"), `blob ${oid}`).length > MAX_FILE_TEXT_LENGTH) {
      throw invalid(`blob ${oid} is longer than ${MAX_FILE_TEXT_LENGTH} characters`);
    }
    blobs.add(oid);
  };

  // Checks the tree and everything beneath it, given the length of the path leading to it, and
  // returns the length of the longest path within it. A tree's contents are checked once however
  // many places it appears in; only the path length depends on the place.
  let pathTooLong = `a file path is longer than ${MAX_FILE_PATH_LENGTH} characters`;
  let longestPaths = new Map<GitOid, number>();
  let checkTree = (oid: GitOid, prefix: number): number => {
    let longest = longestPaths.get(oid);
    if (longest !== undefined) {
      if (prefix + longest > MAX_FILE_PATH_LENGTH) throw invalid(pathTooLong);
      return longest;
    }
    let payload = take(oid, "tree");
    let entries = parseGitTree(payload, oid);
    if (!isCanonicalTree(entries, payload)) throw invalid(`tree ${oid} is not in canonical form`);
    longest = 0;
    for (let { mode, name, oid: child } of entries) {
      // First, because it bounds both the name the next check scans and how deep this recurses.
      if (prefix + name.length > MAX_FILE_PATH_LENGTH) throw invalid(pathTooLong);
      if (!isReadableName(name)) {
        throw invalid(`tree ${oid} holds the reserved name ${JSON.stringify(name)}`);
      }
      if (mode === "40000") {
        let within = checkTree(child, prefix + name.length + 1);
        longest = Math.max(longest, name.length + 1 + within);
      } else if (mode === "100644") {
        checkBlob(child);
        longest = Math.max(longest, name.length);
      } else {
        throw invalid(`tree ${oid} holds ${JSON.stringify(name)} with unsupported mode ${mode}`);
      }
    }
    longestPaths.set(oid, longest);
    return longest;
  };
  trees.forEach((tree, index) => {
    if (index === 0 || objects.has(tree)) checkTree(tree, 0);
  });

  for (let [oid, object] of objects) {
    if (!reached.has(oid)) throw invalid(`${object.type} ${oid} is not part of the release`);
  }
}

function decodeText(payload: Uint8Array, what: string): string {
  try {
    return DECODER.decode(payload);
  } catch {
    throw invalid(`${what} is not valid UTF-8`);
  }
}

// Whether the tree is byte for byte what encodeGitTree() writes for its entries: sorted, with
// each name once and none that git cannot represent.
function isCanonicalTree(entries: GitTreeEntry[], payload: Uint8Array): boolean {
  let canonical: Uint8Array;
  try {
    canonical = encodeGitTree(entries);
  } catch {
    return false;  // it refuses these entries outright
  }
  return canonical.byteLength === payload.byteLength &&
      canonical.every((byte, index) => byte === payload[index]);
}

// Whether GitStore can read a tree holding this name. It reads through isomorphic-git, which
// refuses, as git's own verify_path() does, a name containing a backslash or one that some
// filesystem would resolve to `.`, `..` or `.git`: ignoring case, HFS+'s ignorable characters,
// NTFS's trailing dots and spaces, its `:stream` suffixes and its `git~1` short names.
function isReadableName(name: string): boolean {
  let hfs = name.replace(/[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/g, "");
  let ntfs = hfs.split(":")[0].toLowerCase().replace(/[. ]+$/, "");
  return !(name.includes("\\") || hfs === "." || hfs === ".." || ntfs === ".git" ||
      /^\.?git~[1-9]$/.test(ntfs));
}

// =======================================================================================
// Packs

/**
 * Builds the pack for the release `commitId` from the publisher's objects: the release's whole
 * tree, every ancestor commit, and the tree of each other lineage's newest release (see the top
 * of this file). The same objects always yield the same bytes.
 *
 * The publisher holds every ancestor commit, because each pack it merged carried them all. It
 * holds a fork-point tree if it merged that release itself or a pack it merged carried the tree;
 * one it does not wholly hold is left out, which costs only the ability to merge against it.
 *
 * Throws if the store lacks a commit or any of the release's own tree, if the objects fail
 * `validateReleaseObjects()`, or if the pack exceeds `MAX_RELEASE_PACK_BYTES`.
 *
 * (Output verified against real git. A parentless release's pack passes `git index-pack
 * --strict` and `git fsck --strict`. One with history passes `git index-pack --fsck-objects`,
 * and `git merge-base` finds the shared release across two of them; `--strict` cannot apply,
 * since it demands the ancestors' trees that such a pack leaves out by design.)
 */
export async function buildReleasePack(lookup: GitObjectLookup, commitId: GitOid):
    Promise<Uint8Array> {
  let objects: GitObjectMap = new Map();

  let commits = new Map<GitOid, GitCommitRefs>();
  let pending = [commitId];
  for (let oid of pending) {  // sees the parents pushed below
    if (commits.has(oid)) continue;
    let commit = lookup(oid);
    if (commit === undefined) throw new Error(`cannot pack release: commit ${oid} is not held`);
    objects.set(oid, commit);
    let refs = parseGitCommitRefs(commit.payload, oid);
    commits.set(oid, refs);
    pending.push(...refs.parents);
  }

  // A lineage is a first-parent chain, so its newest release in this history is whichever
  // commit of it is no other's first parent: for the release's own lineage, the release itself.
  let firstParents = new Set([...commits.values()].flatMap(refs => refs.parents.slice(0, 1)));
  for (let [oid, refs] of commits) {
    if (firstParents.has(oid)) continue;
    let tree: GitObjectMap = new Map();
    if (collectTree(lookup, refs.tree, tree)) {
      for (let [treeOid, object] of tree) objects.set(treeOid, object);
    } else if (oid === commitId) {
      throw new Error(`cannot pack release: the tree of commit ${commitId} is not wholly held`);
    }
  }

  validateReleaseObjects(objects, commitId);
  let pack = concatBytes(await buildPackBytes([...objects.values()]));
  if (pack.byteLength > MAX_RELEASE_PACK_BYTES) {
    throw invalid(`its pack is larger than ${MAX_RELEASE_PACK_BYTES} bytes`);
  }
  return pack;
}

// Adds a tree and everything beneath it to `into`, or returns false, leaving `into` with part of
// it, if the store does not hold it all.
function collectTree(lookup: GitObjectLookup, tree: GitOid, into: GitObjectMap): boolean {
  let object = lookup(tree);
  if (object === undefined) return false;
  into.set(tree, object);
  // Names are not decoded here: a tree this cannot ship is the validator's to refuse.
  for (let { mode, oid } of scanGitTree(object.payload, tree)) {
    if (into.has(oid)) continue;
    if (mode === "40000") {
      if (!collectTree(lookup, oid, into)) return false;
    } else {
      let blob = lookup(oid);
      if (blob === undefined) return false;
      into.set(oid, blob);
    }
  }
  return true;
}

/**
 * Decodes a release pack and returns its objects, keyed by oids computed from their content,
 * after checking them with `validateReleaseObjects()`. `commitId` is the release the pack is
 * claimed to be for (`BlueprintMetadata.commitId`).
 *
 * The pack must stand alone: a delta is refused unless its base comes earlier in the same pack.
 */
export async function readReleasePack(pack: Uint8Array, commitId: GitOid):
    Promise<GitObjectMap> {
  if (pack.byteLength > MAX_RELEASE_PACK_BYTES) {
    throw invalid(`its pack is larger than ${MAX_RELEASE_PACK_BYTES} bytes`);
  }
  let objects: GitObjectMap = new Map();
  let decoded = decodePackStream(new Blob([pack]).stream(), {
    maxPackSize: MAX_RELEASE_PACK_BYTES,
    maxObjectSize: MAX_RELEASE_OBJECT_BYTES,
    resolveBase: oid => objects.get(oid),
  });
  for await (let { oid, ...object } of decoded) objects.set(oid, object);
  validateReleaseObjects(objects, commitId);
  return objects;
}

/**
 * Lists the files of a commit as a `path -> text` map, for a caller with objects but no object
 * store. `objects` must have passed `validateReleaseObjects()` and must hold the commit's tree,
 * as it always does for the release itself.
 */
export function listReleaseFiles(
    objects: ReadonlyMap<GitOid, PackableObject>, commitId: GitOid): Map<string, string> {
  let payload = (oid: GitOid): Uint8Array => {
    let object = objects.get(oid);
    if (object === undefined) throw new Error(`git object ${oid} is missing`);
    return object.payload;
  };
  let files = new Map<string, string>();
  let list = (tree: GitOid, prefix: string): void => {
    for (let { mode, name, oid } of parseGitTree(payload(tree), tree)) {
      if (mode === "40000") {
        list(oid, `${prefix}${name}/`);
      } else {
        files.set(prefix + name, DECODER.decode(payload(oid)));
      }
    }
  };
  list(parseGitCommitRefs(payload(commitId), commitId).tree, "");
  return files;
}
