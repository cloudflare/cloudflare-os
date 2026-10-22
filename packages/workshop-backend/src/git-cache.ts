// The workspace git store: the workspace's git object database, and the gatekeeper-facing
// provenance tracking and push authorization over it.
//
// Each workspace's Overseer DO holds a real git object database -- SHA-1, zlib-deflated loose
// objects, byte-identical to what `git` itself would write -- stored in the `gitObjects`
// typed-storage collection. It holds two kinds of history, side by side and deduplicated at the
// blob/tree level: the workspace's own (gadget code, blueprint releases, worktree commits), and
// whatever gatekeepers have brought in from their remotes. `WorkspaceGitCache` is the only code
// that reads or writes the collection, and every object is parsed and encoded by git-codec.ts.
//
// There is deliberately no ref layer: no branches, tags, or HEAD. Our "refs" are the gadget
// records, blueprint records, chats' pinned commits and worktree records, all managed by the
// Overseer's own workflow. Because the store is content-addressed and refless, unrelated
// histories coexist freely in the same collection.
//
// Storage notes:
// - One collection record per object, keyed by oid: a loose object (a zlib'd whole object), or,
//   for a blob over CHUNK_MAX_SIZE (1 MiB), a chunked blob -- an index row naming chunks that
//   are themselves ordinary loose blob rows (see git-chunked-blob.ts). Packs a gatekeeper sends
//   are unpacked as they are consumed. Dedup comes from content addressing, not deltas; chunks,
//   whose boundaries are content-defined, extend it to the unchanged parts of an edited file.
// - Chunking is invisible above `#putObject` and the local reads: a chunked blob's oid is the
//   whole blob's, and chunks carry no metadata. A chunk's oid gets a `gitObjectMetadata` row
//   only if some gatekeeper sent a real blob with exactly its bytes, which is then the same
//   object; so no gatekeeper's scoped view answers for a chunk merely because it is one.
// - No size is bounded, neither of what is written (locally or from a remote) nor of what is
//   read: whatever is stored is returned, inline or chunked, whatever its size. What bounds a row
//   is chunking, which keeps every row written now within about CHUNK_MAX_SIZE; what bounds
//   memory is streaming, which pulls (consumePack), pushes (buildPack), `GitCache.get()`,
//   `readFilesAtCommit()`, streamed writes (`writeBlobStream`) and ranged reads (`openBlob`,
//   `openFileAtCommit`) do for a large blob. Every caller writes objects before moving any
//   record to name them, and a chunked blob's chunks are written before its index row, so a
//   failure only leaves earlier objects dangling.
// - No GC. Uploads and discarded raw-byte writes can leave blobs dangling, as can accepted
//   merges, imports, migration, loading a blueprint's release (whose objects are stored whether
//   or not anything comes to refer to them), and the merge commits of a chat that is then
//   discarded (an update from mainline commits the chat's files and the merge result, see
//   updateChatFromMainline, and applying a blueprint commits its merge, see applyBlueprint). A
//   future GC needs a retention policy for uploaded-but-unreferenced blobs. Its roots are
//   enumerable: gadget records (their heads and the blueprint releases they follow), blueprint
//   gadget records (the commits they exported and the releases minted from those), worktree
//   records (`headCommit`/`pinBase`/`baseCommit`), live chats' pinned commits, the pin
//   declarations in chat logs and compaction checkpoints (closed epochs are reconstructed from
//   them), and the `observedOid` blob stamps (and legacy `observedCommit` stamps) on chats'
//   readFile tool calls, attachment originals, and whole-file `setBytes` references in live chat
//   changes. A future GC must root read stamps or let agent replay tolerate a missing object by
//   eliding the read. Objects pulled from remotes are re-pullable through their metadata. A
//   chunked blob's index row keeps its chunk rows alive: a chunk is live iff it is reachable
//   as an object in its own right, or is named by a live index row.
//
// Reads come in two kinds. The *local history* reads (`readCommitFiles`, `readCommitLog`, ...)
// serve the workspace's own history, which is always wholly held, and never pull. The *lazy*
// reads (`readFileAtCommit`, `listTreeEntries`, ...) serve worktrees, whose bases come from
// remotes, and fault in whatever is missing (see "Pull driver + lazy walker" below).
//
// Over this store sit the gatekeeper-facing semantics:
//
// - `GitCacheImpl` is the per-gatekeeper `GitCache` RPC stub (workshop-shared/gatekeeper.ts).
//   Every stub is scoped to the gatekeeper it was minted for; the stub passed to `applyAction()`
//   is additionally bound to the applying action, which is what enables `buildPack()`.
// - `gitObjectMetadata` records, per oid, which gatekeepers' remotes provably possess the object
//   (`onRemote`), which merely claim to (`pullableFrom`), and which queued actions plan to push
//   it (`pendingPush`). The two source sets differ in evidentiary grade: `onRemote` is entered
//   only by a hash-verified put()/push, `pullableFrom` by advertisements and referent recording.
//   An object's sources and its `pendingPush` marks extend to what it refers to as the object
//   is stored, whatever stores it and in whatever order (see `#extendToReferents`).
//   Metadata routinely exists for objects the store does NOT hold (advertised commits,
//   filtered-out tree entries), which is one of the two reasons it is a separate collection --
//   the other being that reading a `gitObjects` row means reading the whole object content.
// - `ensureGitObjects()` is the pull driver: it routes a fault to the recorded sources and calls
//   `Gatekeeper.gitPull()` through the overseer-provided delegate. It is reachable only from
//   overseer-initiated paths (lazy reads and the pending-push pull-through), so a gatekeeper can
//   never direct a pull of anything outside a verified queued push.
// - `verifyPushAncestry()`/`markPushClosure()` implement `ActionDescription.pushedCommits`
//   authorization at the `submitAction` chokepoint, and the mark lifecycle helpers convert or
//   clear the marks when the action applies, is rejected, or its gatekeeper is deleted.
//
// Trust model note (do not document the view as a confinement boundary): oids are capabilities
// and gatekeepers are trusted with the objects whose oids they know. The scoped read view and
// the ancestry rule are a mistake-safeguard and a simulation aid -- they fail an *accidental*
// push to an unrelated remote closed at queue time -- not defenses against a hostile gatekeeper.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { Collection, NonUniqueIndex } from "@gadgets/typed-storage";
import {
  MAX_BUFFERED_BLOB_SIZE,
  type GitCache,
  type GitObjectType,
  type GitOid,
  type GitPullHints,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  READ_FILES_RESPONSE_BUDGET,
  type AiChatAuthorInfo,
  type CommitIdentity,
  type CommitInfo,
  type FileAtCommit,
  type TreeNode,
  type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import type {
  GitChunkedBlobRecord,
  GitObjectMetadataRecord,
  GitObjectRecord,
} from "./storage-schema/overseer-storage";
import type { BytesRef, FileContent } from "@gadgets/workshop-shared/code-change";
import {
  EMPTY_TREE_OID,
  buildPackStream,
  decodeLooseObject,
  decodePackStream,
  encodeGitCommit,
  encodeGitTree,
  encodeLooseObject,
  gitObjectOid,
  isReservedTreeEntryName,
  parseGitCommit,
  parseGitCommitRefs,
  parseGitTree,
  scanGitTree,
  signatureSafe,
  treeEntryObjectType,
  validateGitObjectType,
  validateGitOid,
  type GitCommitFields,
  type GitCommitHeader,
  type GitTreeEntry,
  type PackEntrySource,
  type PackableObject,
} from "./git-codec";
import {
  BlobReader,
  BlobWriter,
  CHUNK_MAX_SIZE,
  blobByteStream,
  isChunkedBlobRecord,
  readStreamPieces,
} from "./git-chunked-blob";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.git-cache");

// =======================================================================================
// Constants

/**
 * Blob size fetched eagerly when pulling a worktree base: the pull requests the base commit with
 * `filterBlobSize: EAGER_BLOB_LIMIT`, so the commit, its full tree structure, and every blob
 * under this limit arrive in one fetch, and only genuinely large files pay a lazy fault's
 * latency on first access. Both the worktree-creation pull and a later fault against a base
 * whose trees are missing (a commit known only locally at creation; see #resolveEntryAt) use
 * this shape.
 */
export const EAGER_BLOB_LIMIT = 64 * 1024;

// =======================================================================================
// Storage

/** The slice of the Overseer's typed storage the git store operates on. */
export interface GitCacheStorage {
  gitObjects: Collection<GitObjectRecord, string>;
  gitObjectMetadata: Collection<GitObjectMetadataRecord, string> & {
    byPendingPushAction: NonUniqueIndex<GitObjectMetadataRecord, number>;
  };
  transaction<T>(callback: () => T): T;
}

/**
 * How the cache reaches a gatekeeper to pull objects. Implemented by the overseer over
 * `getGatekeeperFacet()` + `Gatekeeper.gitPull()`; injected so the cache stays testable with a
 * mock and so this module needs no facet plumbing.
 */
export interface GitPullDelegate {
  /**
   * Invoke `Gatekeeper.gitPull(oids, hints)` and consume its pack with that source's provenance.
   * Must throw if the gatekeeper record no longer exists (provenance loss: the error should tell
   * the user to reconnect) or if the pull fails.
   */
  pull(gatekeeperId: WorkpieceId, oids: GitOid[], hints: GitPullHints): Promise<void>;
}

// =======================================================================================
// Errors

/**
 * A worktree file's *content* cannot be presented as text: it is binary (holds a NUL) or is not
 * valid UTF-8. Never a matter of size. The message is the agent-visible, path-flavored
 * description. Distinct from path-shape errors (symlink/gitlink/directory) and from
 * transient pull failures so callers can tell "fine to overwrite whole, but unreadable and
 * undiffable" apart from errors that must propagate: the Worktree binding's writeFile falls
 * back to a whole-file `set` on this error (and only this error), and its grep/diff render it
 * as a skip note.
 */
export class UnreadableContentError extends Error {}

// =======================================================================================
// Tree entry kinds (the agent-facing vocabulary for the five git modes)

/** What a tree entry is, as surfaced to file listings. */
export type GitTreeEntryKind = "file" | "executable" | "dir" | "symlink" | "submodule";

/** One entry of a directory listing produced by `listTreeEntries()`. */
export interface GitTreeDirEntry {
  name: string;
  kind: GitTreeEntryKind;
  oid: GitOid;
}

/** One entry of a path-keyed listing produced by `listCommitTreePaths()`. */
export interface GitTreePathEntry {
  /** Full path from the commit's tree root. */
  path: string;
  kind: GitTreeEntryKind;
  oid: GitOid;
}

/** The entry at one path of a commit's tree, as resolved by `pathEntryAtCommit()`. */
export interface GitPathEntry {
  kind: GitTreeEntryKind;
  oid: GitOid;
  /**
   * The object whose payload holds the entry -- its containing tree, or the commit itself for
   * the root -- the hint a later read of the entry's object should carry.
   */
  referencedBy: GitOid;
}

const MODE_KINDS: Record<GitTreeEntry["mode"], GitTreeEntryKind> = {
  "100644": "file",
  "100755": "executable",
  "40000": "dir",
  "120000": "symlink",
  "160000": "submodule",
};

// =======================================================================================
// WorkspaceGitCache

// A locally held object as `#readLocalShallow()` returns it: whole, but for a chunked blob,
// which has no payload here.
type ShallowObject = PackableObject | { type: "blob", payload?: undefined };

// An object for `#putObject()` to store: whole, or a blob whose chunk rows a BlobWriter has
// already written, leaving its index row to put.
type StorableObject =
  | PackableObject
  | { type: "blob", record: GitChunkedBlobRecord, payload?: undefined };

/**
 * An object `readForGatekeeper()` returns: whole, or a blob to read in pieces. A chunked blob
 * comes as a reader, which is never assembled.
 */
export type GatekeeperObject =
  | PackableObject
  | { type: "blob", reader: BlobReader, payload?: undefined };

const TEXT_DECODER_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The workspace's git store. One instance per Overseer, wrapping the typed storage collections;
 * the overseer's own reads and writes of history, `GitCacheImpl` stubs, and the overseer's
 * gatekeeper-facing paths (submitAction, lazy reads) all funnel through it.
 */
export class WorkspaceGitCache {
  constructor(private storage: GitCacheStorage, private puller: GitPullDelegate) {}

  // -------------------------------------------------------------------------------------
  // Local object access

  /**
   * Whether the store holds the object locally (no view scoping, no pulls). The empty tree is
   * always held (see EMPTY_TREE_OID). For a chunked blob this reads only the index row.
   */
  hasLocalObject(oid: GitOid): boolean {
    return oid === EMPTY_TREE_OID || this.storage.gitObjects.get(oid) !== undefined;
  }

  /** The type of a locally held object, or undefined (no view scoping, no pulls). */
  localObjectType(oid: GitOid): GitObjectType | undefined {
    return this.#statLocal(oid)?.type;
  }

  /**
   * The payload size of a locally held blob, or undefined if the store does not hold it (no
   * view scoping, no pulls). Throws if the object is not a blob.
   */
  blobSize(oid: GitOid): number | undefined {
    let stat = this.#statLocal(oid);
    if (stat !== undefined && stat.type !== "blob") {
      throw new Error(`git object ${oid} is a ${stat.type}, not a blob`);
    }
    return stat?.size;
  }

  /**
   * Opens a locally held blob for reading in pieces, whatever its size, or returns undefined if
   * the store does not hold it (no view scoping, no pulls). Throws if the object is not a blob.
   */
  openLocalBlob(oid: GitOid): BlobReader | undefined {
    if (oid === EMPTY_TREE_OID) throw new Error(`git object ${oid} is a tree, not a blob`);
    let record = this.storage.gitObjects.get(oid);
    return record === undefined ? undefined : BlobReader.open(this.storage.gitObjects, record);
  }

  /**
   * Reads and decodes a locally-held object, or undefined (no view scoping, no pulls). A
   * chunked blob is assembled whole, whatever its size.
   */
  readLocalObject(oid: GitOid): PackableObject | undefined {
    let local = this.#readLocalShallow(oid);
    return local === undefined ? undefined : this.#wholeObject(oid, local);
  }

  // A locally held object, for a walk that follows commits and trees and needs only to know a
  // blob is one: decoded once, but a chunked blob is never materialized and comes back without
  // its payload, and no blob is refused for its size.
  #readLocalShallow(oid: GitOid): ShallowObject | undefined {
    let record = this.storage.gitObjects.get(oid);
    if (record === undefined) {
      return oid === EMPTY_TREE_OID ? { type: "tree", payload: new Uint8Array() } : undefined;
    }
    return isChunkedBlobRecord(record) ? { type: "blob" } : decodeLooseObject(record.data);
  }

  // The whole object behind a shallow read: a chunked blob is assembled.
  #wholeObject(oid: GitOid, local: ShallowObject): PackableObject {
    if (local.payload !== undefined) return local;
    let reader = this.openLocalBlob(oid)!;
    return { type: "blob", payload: reader.read(0, reader.size) };
  }

  // The type and payload size of a locally held object, never materializing a chunked blob. An
  // inline row is decoded whole for its header; such rows are at most CHUNK_MAX_SIZE when
  // written now, and at most 8 MB when legacy, so that is acceptable.
  #statLocal(oid: GitOid): { type: GitObjectType, size: number } | undefined {
    let record = this.storage.gitObjects.get(oid);
    if (record === undefined) return oid === EMPTY_TREE_OID ? { type: "tree", size: 0 } : undefined;
    if (isChunkedBlobRecord(record)) return { type: "blob", size: record.size };
    let { type, payload } = decodeLooseObject(record.data);
    return { type, size: payload.byteLength };
  }

  // Every write of an object's row to `gitObjects` is this one (callers wrap it in a
  // transaction): it stores the object and extends what is recorded about it to its referents
  // (see `#extendToReferents`). A blob over CHUNK_MAX_SIZE is stored chunked: a BlobWriter puts
  // its chunk rows through the chunk store, before this puts the index row. Given a whole
  // payload, those chunk puts land inside the caller's transaction, which stays bounded because
  // the payload is already whole in memory (a buffered local write, or a `GitCache.put()`,
  // bounded by its RPC message). A blob streamed from a pack arrives with its chunks already
  // written, outside any transaction (see consumePackFromGatekeeper), so only its index row is
  // put here.
  #putObject(oid: GitOid, object: StorableObject): void {
    if (object.payload === undefined) {
      if (object.record.oid !== oid) {
        throw new Error(`chunked blob ${object.record.oid} is not ${oid}`);
      }
      this.storage.gitObjects.put(object.record);
    } else if (object.type === "blob" && object.payload.byteLength > CHUNK_MAX_SIZE) {
      let writer = new BlobWriter(this.storage.gitObjects, object.payload.byteLength);
      writer.write(object.payload);
      let blob = writer.finish();
      if (blob.record === undefined || blob.oid !== oid) {
        throw new Error(`chunking blob ${oid} produced ${blob.oid}`);
      }
      this.storage.gitObjects.put(blob.record);
    } else {
      this.storage.gitObjects.put({ oid, data: encodeLooseObject(object.type, object.payload) });
    }
    this.#extendToReferents(oid, object);
  }

  // Stores an object authored here -- a file's blob, a tree, a commit -- unless it is already
  // held, and returns its oid.
  async #storeLocalObject(type: GitObjectType, payload: Uint8Array): Promise<GitOid> {
    let oid = await gitObjectOid(type, payload);
    if (!this.hasLocalObject(oid)) {
      this.storage.transaction(() => this.#putObject(oid, { type, payload }));
    }
    return oid;
  }

  // -------------------------------------------------------------------------------------
  // Local history
  //
  // The workspace's own history: gadget code, blueprint releases, worktree commits. Files are
  // presented as flat `path -> text` maps; paths may contain `/`, which maps to nested trees so
  // stored history stays interoperable with real git tooling. Reads here never pull: this
  // history is always wholly held, but for the ancestors of a blueprint release, which arrive
  // as commits alone (hence the `IfHeld` variant). Writes are content-addressed, so rewriting
  // identical content is a cheap no-op that produces the same oids.

  /**
   * Store a raw payload, of any size, as an ordinary Git blob, returning its immutable
   * reference.
   */
  async writeBlob(content: Uint8Array): Promise<BytesRef> {
    return { oid: await this.#storeLocalObject("blob", content), byteLength: content.byteLength };
  }

  /**
   * Store a byte stream, of any size, as an ordinary Git blob, returning its reference once it
   * is wholly stored. The stream is never held whole: its chunk rows are written as they are
   * cut, outside any transaction, so a failure partway leaves only unreferenced chunks. With
   * `byteLength`, the blob is hashed as it arrives, and a stream that ends short of it or runs
   * past it throws, storing no blob; without, it is hashed in a second pass over its chunks.
   */
  async writeBlobStream(stream: ReadableStream<Uint8Array>, byteLength?: number)
      : Promise<BytesRef> {
    let writer = new BlobWriter(this.storage.gitObjects, byteLength);
    for await (let piece of readStreamPieces(stream)) writer.write(piece);
    let blob = writer.finish();
    if (!this.hasLocalObject(blob.oid)) {
      this.storage.transaction(() => this.#putObject(blob.oid, blob.record === undefined
          ? { type: "blob", payload: blob.payload } : { type: "blob", record: blob.record }));
    }
    return { oid: blob.oid, byteLength: blob.size };
  }

  /**
   * Read a locally held Git blob by its OID capability, optionally checking a whole-file OT's
   * length (checked before the blob is read). Never pulls.
   */
  readBlob(oid: string, byteLength?: number): Uint8Array {
    const reader = this.openBlobRef(oid, byteLength);
    return reader.read(0, reader.size);
  }

  /**
   * Checks that a Git blob OID capability names a locally held blob of `byteLength` bytes, as
   * `readBlob()` does, but without reading the blob whole. Never pulls.
   */
  assertBlob(oid: string, byteLength: number): void {
    this.openBlobRef(oid, byteLength);
  }

  /**
   * Opens a locally held Git blob by its OID capability for reading in pieces, with `readBlob()`'s
   * checks, but without reading it whole. Never pulls.
   */
  openBlobRef(oid: string, byteLength: number | undefined): BlobReader {
    let reader = this.openLocalBlob(oid);
    if (reader === undefined) throw new Error("Unknown Git blob.");
    if (byteLength !== undefined && reader.size !== byteLength) {
      throw new Error("Git blob length does not match its reference.");
    }
    return reader;
  }

  /**
   * Writes `files` (a `path -> text` map) as a commit, returning the commit oid. Every file is
   * written mode 100644. Throws on a path git cannot represent or reserves (see
   * `isReservedTreeEntryName()`), and on a path that is both a file and a directory.
   */
  async writeFilesAsCommit(
      files: ReadonlyMap<string, FileContent>, options: WriteCommitOptions): Promise<string> {
    let tree = await this.#rebuildTree(undefined, buildChangeNode(files), "") ?? EMPTY_TREE_OID;
    return await this.writeCommitForTree(tree, options);
  }

  /**
   * Writes a commit whose tree is `treeBase`'s tree with `changes` applied (`null` = delete),
   * returning the commit oid. `treeBase` (a commit oid) and `parents` are deliberately separate:
   * an explicit worktree commit builds its tree from the chat pin's base but parents on the last
   * explicit head (squash semantics).
   *
   * The tree is rebuilt top-down along changed paths only, so committing at repo scale never
   * materializes the full file map: every untouched entry -- of *any* mode, symlinks and
   * gitlinks included -- is copied through with mode and oid verbatim, and equal subtrees reuse
   * their base oids. A changed file keeps its base entry's mode (editing an executable must not
   * clear 100755); only genuinely new files default to 100644. A change that lands on a
   * non-regular-file entry (a directory, symlink, or gitlink) is rejected -- callers gate those
   * paths with descriptive errors before committing -- and so is a new entry whose name git
   * reserves. Directories emptied by deletions are pruned, as git requires. The trees along the
   * changed paths fault in if missing, as the lazy reads' do.
   */
  async writeChangedFilesAsCommit(
      changes: ReadonlyMap<string, FileContent | null>,
      options: WriteCommitOptions & { treeBase: string }): Promise<string> {
    return await this.writeCommitForTree(
        await this.writeChangedTree(options.treeBase, changes), options);
  }

  /**
   * The tree half of `writeChangedFilesAsCommit` (same rebuild rules; see there): writes the
   * tree objects for `treeBase`'s tree with `changes` applied and returns the new root tree oid
   * (the empty tree when everything was deleted), without writing a commit. Exposed separately
   * so the accept-time epoch reset can compare the flattened tree against the pin base's and
   * head's trees -- deciding "clean", "reuse headCommit", or "auto-commit" -- before deciding
   * to write any commit at all.
   */
  async writeChangedTree(
      treeBase: string, changes: ReadonlyMap<string, FileContent | null>): Promise<string> {
    let commit = await this.ensureObject(treeBase, { type: "commit" });
    let baseTree = parseGitCommitRefs(commit.payload, treeBase).tree;
    // No changes: the base's tree, by oid, without reading it.
    if (changes.size === 0) return baseTree;
    return await this.#rebuildTree(
        { oid: baseTree, referencedBy: treeBase }, buildChangeNode(changes), "") ?? EMPTY_TREE_OID;
  }

  /**
   * The commit half of `writeChangedFilesAsCommit`: writes a commit for an existing tree oid.
   * Every commit the workspace authors is written by `encodeGitCommit()`, here or in
   * blueprint-release.ts, which throws on a name or email that a signature cannot hold rather
   * than let it add header lines.
   */
  async writeCommitForTree(tree: string, options: WriteCommitOptions): Promise<string> {
    let signature = ({ name, email }: CommitIdentity) =>
        ({ name, email, timestamp: options.timestamp, utcOffsetMinutes: 0 });
    return await this.#storeLocalObject("commit", encodeGitCommit({
      tree,
      parents: options.parents,
      author: signature(options.author),
      committer: signature(options.committer ?? options.author),
      headers: options.headers,
      message: options.message,
    }));
  }

  // Rebuilds one tree level for the writers above: base entries are copied through untouched
  // (mode + oid verbatim) except where the change node names them. Returns the new tree oid, or
  // undefined when the resulting tree is empty (the entry is then pruned).
  async #rebuildTree(base: { oid: GitOid, referencedBy: GitOid } | undefined, node: ChangeNode,
                     prefix: string): Promise<GitOid | undefined> {
    let entries = new Map<string, GitTreeEntry>();
    if (base !== undefined) {
      let tree = await this.ensureObject(base.oid, { type: "tree", referencedBy: base.referencedBy });
      for (let entry of parseGitTree(tree.payload, base.oid)) entries.set(entry.name, entry);
    }
    for (let [name, child] of node) {
      let path = prefix + name;
      let existing = entries.get(name);
      if (existing === undefined && child !== null && isReservedTreeEntryName(name)) {
        throw new Error(`invalid file path: ${path} (git does not allow the name ` +
            `${JSON.stringify(name)})`);
      }
      if (child instanceof Map) {
        if (existing !== undefined && existing.mode !== "40000") {
          throw new Error(`conflicting file paths at: ${path}`);
        }
        let sub = await this.#rebuildTree(
            existing && { oid: existing.oid, referencedBy: base!.oid }, child, `${path}/`);
        if (sub === undefined) {
          entries.delete(name);
        } else {
          entries.set(name, { mode: "40000", name, oid: sub });
        }
      } else if (child === null) {
        if (existing?.mode === "40000") throw new Error(`cannot delete ${path}: it is a directory`);
        entries.delete(name);  // deleting an absent file is a no-op
      } else {
        if (existing !== undefined && existing.mode !== "100644" && existing.mode !== "100755") {
          throw new Error(`cannot write ${path}: not a regular file`);
        }
        let oid = await this.#writeFileBlob(child);
        // A changed file keeps its base entry's mode; only new files default to 100644.
        entries.set(name, { mode: existing?.mode ?? "100644", name, oid });
      }
    }
    if (entries.size === 0) return undefined;
    return await this.#storeLocalObject("tree", encodeGitTree([...entries.values()]));
  }

  // Writes a file's text as a blob, or checks that a byte reference names a held blob.
  async #writeFileBlob(content: FileContent): Promise<GitOid> {
    if (typeof content !== "string") {
      this.assertBlob(content.oid, content.byteLength);
      return content.oid;
    }
    return await this.#storeLocalObject("blob", new TextEncoder().encode(content));
  }

  /**
   * Reads back the full file map of a commit: the inverse of `writeFilesAsCommit()`, with nested
   * trees flattened to `/`-joined paths, in git's tree order.
   *
   * Only regular-file blobs (modes 100644/100755) are supported; symlinks and submodules --
   * which we never write, but an imported history could contain -- are rejected rather than
   * misread. Throws if the store does not hold the commit with its whole tree.
   */
  readCommitFiles(oid: string): Map<string, string> {
    let files = this.readCommitFilesIfHeld(oid);
    if (files === undefined) {
      throw new Error(`The files of commit ${oid} are not in the workspace's git store.`);
    }
    return files;
  }

  /**
   * Like `readCommitFiles()`, but returns undefined if the store does not hold the commit with
   * its whole tree. A blueprint release's ancestors arrive as commits alone, most of them, so
   * holding a commit says nothing about holding its files.
   */
  readCommitFilesIfHeld(oid: string): Map<string, string> | undefined {
    let commit = this.#heldPayload(oid, "commit");
    if (commit === undefined) return undefined;
    let files = new Map<string, string>();
    let collect = (treeOid: GitOid, prefix: string): boolean => {
      let tree = this.#heldPayload(treeOid, "tree");
      if (tree === undefined) return false;
      for (let entry of parseGitTree(tree, treeOid)) {
        let path = prefix + entry.name;
        if (entry.mode === "40000") {
          if (!collect(entry.oid, `${path}/`)) return false;
        } else if (entry.mode === "100644" || entry.mode === "100755") {
          let blob = this.#heldPayload(entry.oid, "blob");
          if (blob === undefined) return false;
          files.set(path, decodeBlobText(blob, path));
        } else {
          throw new Error(`unsupported tree entry at ${path}: mode ${entry.mode}`);
        }
      }
      return true;
    };
    return collect(parseGitCommitRefs(commit, oid).tree, "") ? files : undefined;
  }

  /**
   * Walks the commit graph from `oid` (the commit itself first, then its ancestry), returning up
   * to `depth` commits' metadata, each commit once. Traversal order for merge commits follows
   * git log's default (reverse chronological).
   */
  readCommitLog(oid: string, options: { depth?: number } = {}): CommitInfo[] {
    // A commit that two parents of a merge both lead to is listed once, however its date
    // compares with the commits between: commits written in the same second tie. A gadget that
    // has merged releases of blueprints has such commits: the releases that those were built on.
    let entries: CommitInfo[] = [];
    let reached = new Set([oid]);
    let tips = [{ oid, commit: this.readCommitObject(oid) }];
    while (tips.length > 0) {
      // The newest by commit date, as git orders them, and of several the first reached.
      let next = tips.reduce((newest, tip) =>
          tip.commit.committer.timestamp > newest.commit.committer.timestamp ? tip : newest);
      tips.splice(tips.indexOf(next), 1);
      entries.push({
        oid: next.oid,
        parents: next.commit.parents,
        message: next.commit.message,
        author: { name: next.commit.author.name, email: next.commit.author.email },
        timestamp: next.commit.author.timestamp,
      });
      if (entries.length === options.depth) break;

      for (let parent of next.commit.parents) {
        if (reached.has(parent)) continue;
        reached.add(parent);
        tips.push({ oid: parent, commit: this.readCommitObject(parent) });
      }
    }
    return entries;
  }

  /** The tree oid of a locally held commit. */
  commitTree(oid: string): string {
    return parseGitCommitRefs(this.#requireHeld(oid, "commit"), oid).tree;
  }

  /**
   * Reads a locally held commit object's fields. Unlike `readCommitLog()`, carries the committer
   * and timezone offsets, and never touches any other object.
   */
  readCommitObject(oid: string): GitCommitFields {
    return parseGitCommit(this.#requireHeld(oid, "commit"), oid);
  }

  /**
   * Walks a commit's first-parent chain, the commit itself first. A first parent is the same
   * line's previous state and any other is something merged into it, so this is a gadget's own
   * history, or one blueprint's releases. Reads commit objects only.
   */
  *firstParentChain(oid: string): Generator<{ oid: string, commit: GitCommitFields }> {
    for (let next: string | undefined = oid; next !== undefined;) {
      let commit: GitCommitFields = this.readCommitObject(next);
      yield { oid: next, commit };
      next = commit.parents[0];
    }
  }

  // The payload of a locally held object, which must be of the expected type, or undefined if
  // the store does not hold it.
  #heldPayload(oid: GitOid, type: GitObjectType): Uint8Array | undefined {
    let object = this.readLocalObject(oid);
    if (object !== undefined && object.type !== type) {
      throw new Error(`git object ${oid} is a ${object.type}, but a ${type} was expected`);
    }
    return object?.payload;
  }

  #requireHeld(oid: GitOid, type: GitObjectType): Uint8Array {
    let payload = this.#heldPayload(oid, type);
    if (payload === undefined) {
      throw new Error(`The ${type} ${oid} is not in the workspace's git store.`);
    }
    return payload;
  }

  /**
   * Stores objects that came from no gatekeeper -- a blueprint release's -- in one storage
   * transaction. Each goes under the oid computed here from its content, so nothing a caller
   * passes can poison the store. The objects are attributed to no remote: one that nothing was
   * recorded about stays that way, like a commit authored here, so no gatekeeper's scoped view
   * answers for it. An object already held is left as it is, along with whatever metadata it
   * has.
   *
   * There is no size cap; the caller bounds what it imports.
   */
  async importObjects(objects: Iterable<PackableObject>): Promise<void> {
    let entries = await Promise.all(Array.from(objects, async object =>
        ({ ...object, oid: await gitObjectOid(object.type, object.payload) })));
    this.storage.transaction(() => {
      for (let { oid, type, payload } of entries) {
        if (!this.hasLocalObject(oid)) this.#putObject(oid, { type, payload });
      }
    });
  }

  // -------------------------------------------------------------------------------------
  // Gatekeeper writes

  /**
   * `GitCache.put()`: store a hash-verified object, of any size, on behalf of a gatekeeper.
   * Records proof of possession (`onRemote`), referent pull-routing rows for a tree's entries or
   * a commit's tree/parents, and propagates any pending-push marks to the newly-visible
   * referents. The payload arrives whole, and a large blob is chunked within one transaction,
   * which the RPC message carrying it bounds.
   */
  async putFromGatekeeper(gatekeeperId: WorkpieceId, type: GitObjectType, payload: Uint8Array)
      : Promise<GitOid> {
    validateGitObjectType(type);
    let oid = await gitObjectOid(type, payload);
    this.storage.transaction(
        () => this.#storeVerifiedObject(gatekeeperId, oid, { type, payload }));
    return oid;
  }

  /**
   * `GitCache.advertiseCommit()`: record the assertion-grade "my remote has this commit" hint.
   * No observation is involved: an advertisement is workspace-internal pull-routing metadata,
   * not a read.
   */
  advertiseCommit(gatekeeperId: WorkpieceId, commitId: GitOid): void {
    validateGitOid(commitId);
    this.storage.transaction(
        () => this.#recordPullable(gatekeeperId, [{ oid: commitId, type: "commit" }]));
  }

  /**
   * `GitCache.consumePack()`: decode a packfile and store every contained object exactly as the
   * equivalent sequence of put()s would -- same hash-derived oids (poison-proof by
   * construction), same metadata recording and mark propagation. Returns the stored oids: every
   * object the pack carries, of any size.
   *
   * The pack streams through: blobs, the bulk of a checkout, are stored as they arrive. A blob
   * over CHUNK_MAX_SIZE is never held whole: it streams through a BlobWriter, whose chunk rows
   * are written as they are cut, outside any transaction (one around them would grow with the
   * blob), and its index row and metadata are then stored in one transaction. Every other object
   * is held until the whole pack has verified, then stored the same way, one object per
   * transaction, with commits last: a commit's local presence is what lets `fetchCommit` mount
   * it and skip ever pulling it again, so no commit is stored before every other held object is.
   * A store that throws rolls back only its own object, so a failure partway can leave verified
   * trees, the root tree included, with no commit: nothing treats those as mounted, and lazy
   * reads fault around them. No await separates these stores, so they still reach disk
   * together; one transaction around them all would also undo the earlier objects when a later
   * one throws, but in production it nearly doubled a vscode-size mount's CPU.
   *
   * A delta's base comes from the held objects, else from the store: whole if inline, or by
   * range from a chunked blob (which includes one this pack streamed in earlier).
   */
  async consumePackFromGatekeeper(gatekeeperId: WorkpieceId, pack: ReadableStream<Uint8Array>)
      : Promise<GitOid[]> {
    let held = new Map<GitOid, PackableObject>();
    let stored: GitOid[] = [];
    let objects = decodePackStream(pack, {
      resolveBase: oid => {
        let object = held.get(oid) ?? this.#readLocalShallow(oid);
        return object?.payload === undefined ? undefined : object;
      },
      resolveLargeBase: oid => this.openLocalBlob(oid),
      openBlobSink: size => {
        if (size <= CHUNK_MAX_SIZE) return undefined;
        let writer = new BlobWriter(this.storage.gitObjects, size);
        return {
          write: piece => writer.write(piece),
          finish: () => {
            let { oid, record } = writer.finish();
            this.storage.transaction(() =>
                this.#storeVerifiedObject(gatekeeperId, oid, { type: "blob", record: record! }));
            return oid;
          },
        };
      },
    });
    for await (let { oid, ...object } of objects) {
      if (object.stored) {
        stored.push(oid);
      } else if (object.type === "blob") {
        this.storage.transaction(() => this.#storeVerifiedObject(gatekeeperId, oid, object));
        stored.push(oid);
      } else {
        held.set(oid, object);
      }
    }
    let commitsLast = [...held].toSorted(([, a], [, b]) =>
        Number(a.type === "commit") - Number(b.type === "commit"));
    for (let [oid, object] of commitsLast) {
      this.storage.transaction(() => this.#storeVerifiedObject(gatekeeperId, oid, object));
      stored.push(oid);
    }
    return stored;
  }

  // -------------------------------------------------------------------------------------
  // The scoped gatekeeper read view

  /**
   * The read behind `GitCache.get()` (and, via `statForGatekeeper()`, `has()`/`stat()`), the
   * gatekeeper's scoped view: answers exactly
   * `onRemote(G) ∪ pendingPush(G)` for gatekeeper G and null for everything else. A pendingPush
   * object that is locally absent is pulled through from its recorded sources on demand (that
   * is what lets G simulate a queued cross-remote push); an absent onRemote object is not
   * pulled -- G's own remote has it, and null tells G to ask its remote itself.
   *
   * A blob over MAX_BUFFERED_BLOB_SIZE comes back as a reader, never assembled: a chunked one,
   * and a legacy inline one too, since `GitCache.get()` streams by size.
   */
  async readForGatekeeper(gatekeeperId: WorkpieceId, oid: GitOid, hints?: GitPullHints)
      : Promise<GatekeeperObject | null> {
    if (!await this.#heldForGatekeeper(gatekeeperId, oid, hints)) return null;
    let object = this.#readLocalShallow(oid);
    if (object === undefined) return null;
    if (object.type === "blob" &&
        (object.payload === undefined || object.payload.byteLength > MAX_BUFFERED_BLOB_SIZE)) {
      return { type: "blob", reader: this.openLocalBlob(oid)! };
    }
    return object;
  }

  /**
   * `GitCache.stat()`/`has()`: `readForGatekeeper()`'s view, answering type and size without
   * reading the object whole (a chunked blob's come from its index row).
   */
  async statForGatekeeper(gatekeeperId: WorkpieceId, oid: GitOid)
      : Promise<{ type: GitObjectType, size: number } | null> {
    return await this.#heldForGatekeeper(gatekeeperId, oid)
        ? this.#statLocal(oid) ?? null : null;
  }

  // Whether an object is in the gatekeeper's view and held, after pulling it through if it is
  // a pendingPush object (see readForGatekeeper).
  async #heldForGatekeeper(gatekeeperId: WorkpieceId, oid: GitOid, hints?: GitPullHints)
      : Promise<boolean> {
    validateGitOid(oid);
    let meta = this.storage.gitObjectMetadata.get(oid);
    if (meta === undefined) return false;
    let onRemote = meta.onRemote.includes(gatekeeperId);
    let pendingPush = meta.pendingPush.some(p => p.gatekeeperId === gatekeeperId);
    if (!onRemote && !pendingPush) return false;

    if (!this.hasLocalObject(oid) && pendingPush) {
      await this.ensureGitObjects([oid], hints ?? this.#exactObjectHints(meta.type));
    }
    return this.hasLocalObject(oid);
  }

  // -------------------------------------------------------------------------------------
  // Pull driver + lazy walker

  /**
   * Ensures the given objects are locally present, pulling any that are missing from their
   * recorded sources (`onRemote ∪ pullableFrom`, trying each recorded gatekeeper on failure).
   * All requests in one call share `hints` (batch callers group by expected type).
   *
   * Throws if an object cannot be obtained. No object is ever refused for its size.
   */
  async ensureGitObjects(oids: GitOid[], hints: GitPullHints): Promise<void> {
    let missing = [...new Set(oids)].filter(oid => !this.hasLocalObject(oid));
    if (missing.length === 0) return;

    let triedSources = new Map<GitOid, Set<WorkpieceId>>();
    let lastError: unknown;
    while (true) {
      missing = missing.filter(oid => !this.hasLocalObject(oid));
      if (missing.length === 0) return;

      // Group the still-missing objects by each one's next untried recorded source.
      let groups = new Map<WorkpieceId, GitOid[]>();
      for (let oid of missing) {
        let meta = this.storage.gitObjectMetadata.get(oid);
        let sources = [...new Set([...(meta?.onRemote ?? []), ...(meta?.pullableFrom ?? [])])];
        let tried = triedSources.get(oid) ?? new Set();
        let next = sources.find(source => !tried.has(source));
        if (next === undefined) {
          throw new Error(
              `Could not pull git object ${oid}: ` +
              (sources.length === 0
                  ? "no connection is known to provide it."
                  : `every connection that could provide it failed. Last error: ` +
                    `${lastError instanceof Error ? lastError.message : String(lastError)}`));
        }
        let group = groups.get(next);
        if (group === undefined) groups.set(next, group = []);
        group.push(oid);
      }

      for (let [gatekeeperId, groupOids] of groups) {
        for (let oid of groupOids) {
          let tried = triedSources.get(oid);
          if (tried === undefined) triedSources.set(oid, tried = new Set());
          tried.add(gatekeeperId);
        }
        try {
          await this.puller.pull(gatekeeperId, groupOids, hints);
        } catch (err) {
          lastError = err;
          logger.warn("git pull from source failed", {
            event: "git.pull.source.failed", gatekeeperId, oidCount: groupOids.length,
            error: err,
          });
          continue;
        }
        if (groupOids.some(oid => !this.hasLocalObject(oid))) {
          lastError = new Error("a pull completed without providing it");
        }
      }
    }
  }

  /**
   * The lazy walker's fault-and-parse step: returns the object, pulling it on a miss with
   * exact-object hints shaped from the expected type and the referencing object. Throws if the
   * object cannot be obtained or is not of the expected type.
   *
   * `eagerTree` widens a commit/tree miss into the worktree-creation pull shape -- the whole
   * tree closure plus blobs up to EAGER_BLOB_LIMIT in one round trip (see #resolveEntryAt) --
   * instead of one object per fault. It changes only how much a *miss* pulls; a locally present
   * object never pulls anything.
   */
  async ensureObject(oid: GitOid,
                     expected: { type: GitObjectType, referencedBy?: GitOid, eagerTree?: boolean })
      : Promise<PackableObject> {
    let local = this.#readLocalShallow(oid);
    if (local === undefined) {
      await this.ensureGitObjects([oid],
          expected.eagerTree && expected.type !== "blob"
              ? { type: expected.type,
                  ...(expected.referencedBy !== undefined
                      ? { referencedBy: expected.referencedBy } : {}),
                  commitHistory: { kind: "depth", depth: 1 },
                  filterBlobSize: EAGER_BLOB_LIMIT }
              : this.#exactObjectHints(expected.type, expected.referencedBy));
      local = this.#readLocalShallow(oid);
      if (local === undefined) {
        // ensureGitObjects throws on failure; this is a defensive backstop.
        throw new Error(`git object ${oid} is unavailable`);
      }
    }
    if (local.type !== expected.type) {
      throw new Error(`git object ${oid} is a ${local.type}, but a ${expected.type} was expected`);
    }
    // A chunked blob is assembled only once it is known to be what was asked for.
    return this.#wholeObject(oid, local);
  }

  // The pull-hint defaults for an exact-object fault: depth-1 (never deepen history), tree:0
  // alongside a commit want, and tree:1 alongside a tree want (which already excludes the
  // entries' blobs). A blob want carries no filter: a blob of any size is stored.
  #exactObjectHints(type: GitObjectType, referencedBy?: GitOid): GitPullHints {
    return {
      type,
      ...(referencedBy !== undefined ? { referencedBy } : {}),
      commitHistory: { kind: "depth", depth: 1 },
      ...(type === "commit" ? { filterTreeDepth: 0 } : {}),
      ...(type === "tree" ? { filterTreeDepth: 1 } : {}),
    };
  }

  /**
   * Reads one file of a commit's tree by path, walking only the trees along the path (no
   * full-tree materialization) and fault-pulling whatever is missing. Regular files only:
   * a symlink or submodule (gitlink) path throws a descriptive error naming its target, a
   * directory path or absent entry throws "no such file", and binary (non-UTF-8 / NUL-bearing)
   * content throws a clean, path-specific error. A file of any size is read whole.
   */
  async readFileAtCommit(commitOid: GitOid, path: string): Promise<string> {
    let text = await this.readFileAtCommitIfExists(commitOid, path);
    if (text === undefined) throw new Error(`${path}: no such file`);
    return text;
  }

  /**
   * Like `readFileAtCommit`, but an absent path (including a path whose leading segments don't
   * resolve to directories, or one naming a directory) returns undefined instead of throwing.
   * Every other failure -- symlink/gitlink paths, binary content, a pull failure -- still
   * throws its descriptive error. This is the lazy base resolver behind worktree session
   * content: "no base text" is an ordinary state there ("edit of absent file" is then the
   * change's own validation error), while the throwing errors describe the file itself.
   */
  async readFileAtCommitIfExists(commitOid: GitOid, path: string): Promise<string | undefined> {
    return (await this.readFileAtCommitWithOid(commitOid, path))?.text;
  }

  /**
   * Resolve one regular file to its existing immutable Git blob reference, fault-pulling the
   * blob if missing but never reading it whole.
   */
  async fileBytesAtCommit(commitOid: GitOid, path: string): Promise<BytesRef | undefined> {
    const {tree, entry} = await this.#resolveEntryAt(commitOid, path);
    if (!entry) return undefined;
    if (entry.mode === "40000") throw new Error(`${path} is a directory`);
    if (entry.mode === "160000") throw new Error(submoduleMessage(path, entry.oid));
    if (entry.mode === "120000") {
      throw new Error(symlinkMessage(path, await this.#ensureFileBlob(entry.oid, tree)));
    }
    await this.#faultFileBlob(entry.oid, tree);
    const byteLength = this.blobSize(entry.oid);
    // #faultFileBlob throws on failure; this is a defensive backstop.
    if (byteLength === undefined) throw new Error(`git object ${entry.oid} is unavailable`);
    return {oid: entry.oid, byteLength};
  }

  /**
   * `readFileAtCommitIfExists` that also reports the blob's oid -- the file's content address,
   * which a later `fileOidAtCommit` on another commit compares equal iff the content is
   * byte-identical. Same rules and errors otherwise.
   */
  async readFileAtCommitWithOid(commitOid: GitOid, path: string)
      : Promise<{ text: string, oid: GitOid } | undefined> {
    let file = await this.openFileAtCommit(commitOid, path);
    return file && { text: decodeBlobText(file.reader.read(0, file.reader.size), path),
                     oid: file.oid };
  }

  /**
   * `readFileAtCommitWithOid`, but opening the file's blob for reading in pieces rather than
   * decoding it: same path rules and errors, but no content rules, and the blob is never read
   * whole. Faults the blob in if missing.
   */
  async openFileAtCommit(commitOid: GitOid, path: string)
      : Promise<{ oid: GitOid, reader: BlobReader } | undefined> {
    let { tree, entry } = await this.#resolveEntryAt(commitOid, path);
    if (entry === undefined || entry.mode === "40000") return undefined;
    switch (entry.mode) {
      case "160000":
        throw new Error(submoduleMessage(path, entry.oid));
      case "120000":
        // The symlink target *is* the blob's content, so the error tells the agent everything.
        throw new Error(symlinkMessage(path, await this.#ensureFileBlob(entry.oid, tree)));
      default:
        return { oid: entry.oid, reader: await this.openBlob(entry.oid, tree) };
    }
  }

  /**
   * Opens a blob for reading in pieces, whatever its size, fault-pulling it on a miss
   * (`referencedBy` shapes the pull hints, as for `readTextBlob`). Never reads it whole. Throws
   * if it cannot be obtained or is not a blob.
   */
  async openBlob(oid: GitOid, referencedBy?: GitOid): Promise<BlobReader> {
    await this.#faultFileBlob(oid, referencedBy);
    let reader = this.openLocalBlob(oid);
    // #faultFileBlob throws on failure; this is a defensive backstop.
    if (reader === undefined) throw new Error(`git object ${oid} is unavailable`);
    return reader;
  }

  /**
   * The blob oid of the regular file at `path` in a commit's tree, or undefined when the path is
   * absent or names anything else (directory, symlink, gitlink). Walks only the trees along the
   * path and never reads the blob, so it answers "is this file still the content I saw?" -- by
   * comparison with a stamp from `readFileAtCommitWithOid` or `blobOid` -- at tree-walk cost.
   */
  async fileOidAtCommit(commitOid: GitOid, path: string): Promise<GitOid | undefined> {
    let { entry } = await this.#resolveEntryAt(commitOid, path);
    return entry?.mode === "100644" || entry?.mode === "100755" ? entry.oid : undefined;
  }

  /**
   * Lists one directory of a commit's tree (the root when `path` is omitted), surfacing every
   * entry with its kind per the five-mode vocabulary. Trees along the path fault in if missing;
   * blobs are never touched.
   */
  async listTreeEntries(commitOid: GitOid, path?: string): Promise<GitTreeDirEntry[]> {
    let treeOid: GitOid;
    let referencedBy: GitOid;
    if (path === undefined || path === "") {
      let commit = await this.ensureObject(commitOid, { type: "commit" });
      treeOid = parseGitCommitRefs(commit.payload, commitOid).tree;
      referencedBy = commitOid;
    } else {
      let resolved = await this.#resolveEntryAt(commitOid, path);
      if (resolved.entry === undefined || resolved.entry.mode !== "40000") {
        throw new Error(`${path}: no such directory`);
      }
      treeOid = resolved.entry.oid;
      referencedBy = resolved.tree;
    }
    let tree = await this.ensureObject(treeOid, { type: "tree", referencedBy });
    return parseGitTree(tree.payload, treeOid).map(entry => ({
      name: entry.name,
      kind: MODE_KINDS[entry.mode],
      oid: entry.oid,
    }));
  }

  // Walks a commit's tree along `path`, returning the tree containing the final segment and
  // that segment's entry. `entry` is undefined when the path doesn't resolve -- the final
  // segment is absent, or an intermediate segment is absent or not a directory (absence takes
  // one shape so readFileAtCommitIfExists can report "no base text" uniformly).
  //
  // This is the worktree base resolver, so a miss anywhere along the walk pulls eagerly
  // (`eagerTree`): the first fault against a base commit brings the whole tree closure and
  // every small blob in one round trip -- the same shape as the worktree-creation pull --
  // rather than one gatekeeper round trip per path segment. Reads that follow hit locally.
  async #resolveEntryAt(commitOid: GitOid, path: string)
      : Promise<{ tree: GitOid, entry: GitTreeEntry | undefined }> {
    let segments = splitTreePath(path);
    let name = segments.pop()!;
    let commit = await this.ensureObject(commitOid, { type: "commit", eagerTree: true });
    let treeOid = parseGitCommitRefs(commit.payload, commitOid).tree;
    let referencedBy = commitOid;
    for (let segment of segments) {
      let tree = await this.ensureObject(treeOid, { type: "tree", referencedBy, eagerTree: true });
      let entry = parseGitTree(tree.payload, treeOid).find(e => e.name === segment);
      if (entry === undefined || entry.mode !== "40000") {
        return { tree: treeOid, entry: undefined };
      }
      referencedBy = treeOid;
      treeOid = entry.oid;
    }
    let tree = await this.ensureObject(treeOid, { type: "tree", referencedBy, eagerTree: true });
    return { tree: treeOid, entry: parseGitTree(tree.payload, treeOid).find(e => e.name === name) };
  }

  /**
   * The kind and oid of the entry at `path` in a commit's tree, or undefined when the path
   * doesn't resolve. `""` names the root directory (whose oid is the root tree). Trees along the
   * walk fault in as needed; blob content is never read.
   */
  async pathEntryAtCommit(commitOid: GitOid, path: string): Promise<GitPathEntry | undefined> {
    if (path === "") {
      let commit = await this.ensureObject(commitOid, { type: "commit", eagerTree: true });
      return { kind: "dir", oid: parseGitCommitRefs(commit.payload, commitOid).tree,
               referencedBy: commitOid };
    }
    let { tree, entry } = await this.#resolveEntryAt(commitOid, path);
    return entry === undefined ? undefined
        : { kind: MODE_KINDS[entry.mode], oid: entry.oid, referencedBy: tree };
  }

  /**
   * Lists a commit's tree by full path: the entries of the directory at `path` (the root when
   * omitted or `""`), each with its five-mode kind, descending into subdirectories when
   * `recursive`. Throws "no such directory" when `path` doesn't name a directory. Trees fault in
   * as needed (eagerly, like every worktree base walk); blob content is never read, so listings
   * carry no sizes.
   */
  async listCommitTreePaths(commitOid: GitOid, path?: string, options?: { recursive?: boolean })
      : Promise<GitTreePathEntry[]> {
    let scope = path ?? "";
    let root = await this.pathEntryAtCommit(commitOid, scope);
    if (root === undefined || root.kind !== "dir") {
      throw new Error(`${scope}: no such directory`);
    }
    let out: GitTreePathEntry[] = [];
    let walk = async (treeOid: GitOid, referencedBy: GitOid, prefix: string): Promise<void> => {
      let tree = await this.ensureObject(treeOid, { type: "tree", referencedBy, eagerTree: true });
      for (let entry of parseGitTree(tree.payload, treeOid)) {
        let entryPath = prefix + entry.name;
        out.push({ path: entryPath, kind: MODE_KINDS[entry.mode], oid: entry.oid });
        if (options?.recursive && entry.mode === "40000") {
          await walk(entry.oid, treeOid, `${entryPath}/`);
        }
      }
    };
    await walk(root.oid, root.referencedBy, scope === "" ? "" : `${scope}/`);
    return out;
  }

  /**
   * A commit's whole tree as nested `TreeNode`s (the client-facing shape behind
   * `Overseer.listTree`): each directory's entries in `parseGitTree` order, names not paths, no
   * oids. The nested sibling of `listCommitTreePaths`: the same eager-tree walk, emitting nodes
   * instead of prefixed paths. Blob content is never read.
   */
  async readCommitTree(commitOid: GitOid): Promise<TreeNode[]> {
    let commit = await this.ensureObject(commitOid, { type: "commit", eagerTree: true });
    let walk = async (treeOid: GitOid, referencedBy: GitOid): Promise<TreeNode[]> => {
      let tree = await this.ensureObject(treeOid, { type: "tree", referencedBy, eagerTree: true });
      let nodes: TreeNode[] = [];
      for (let entry of parseGitTree(tree.payload, treeOid)) {
        let kind = MODE_KINDS[entry.mode];
        nodes.push(kind === "dir"
            ? { name: entry.name, kind, children: await walk(entry.oid, treeOid) }
            : { name: entry.name, kind });
      }
      return nodes;
    };
    return walk(parseGitCommitRefs(commit.payload, commitOid).tree, commitOid);
  }

  /**
   * The content of several files at a commit in one round trip (the read behind
   * `Overseer.readFilesAtCommit`; see its doc for the contract). Entries resolve along the
   * eager-tree walk, every missing blob is pulled in one batch (`ensureBlobs`), and the results
   * come back in request order -- stopping once the accumulated blob bytes exceed
   * READ_FILES_RESPONSE_BUDGET, so the remaining paths are simply omitted. Per-file conditions
   * become `absent`/`unreadable` entries; a pull failure throws. A regular file over
   * MAX_BUFFERED_BLOB_SIZE comes back as a `stream` of its raw bytes, never read whole here and
   * not counted toward the budget; a smaller one is decoded as text.
   */
  async readFilesAtCommit(commitOid: GitOid, paths: string[])
      : Promise<[path: string, FileAtCommit][]> {
    let entries = new Map<string, GitPathEntry | undefined>();
    for (let path of paths) {
      if (!entries.has(path)) entries.set(path, await this.pathEntryAtCommit(commitOid, path));
    }
    // Symlink blobs are fetched too: the target *is* the blob, and it names the link in the
    // unreadable message, as every other read of a symlink does.
    let blobs: GitOid[] = [];
    for (let entry of entries.values()) {
      if (entry !== undefined && entry.kind !== "dir" && entry.kind !== "submodule") {
        blobs.push(entry.oid);
      }
    }
    await this.ensureBlobs(blobs);

    let out: [path: string, FileAtCommit][] = [];
    let bytes = 0;
    for (let path of paths) {
      if (bytes > READ_FILES_RESPONSE_BUDGET) break;
      let entry = entries.get(path);
      if (entry === undefined || entry.kind === "dir") {
        out.push([path, { kind: "absent" }]);
      } else if (entry.kind === "submodule") {
        out.push([path, { kind: "unreadable", message: submoduleMessage(path, entry.oid) }]);
      } else {
        try {
          // Local by now (ensureBlobs), so this opens the blob, never faults.
          let reader = await this.openBlob(entry.oid, entry.referencedBy);
          if (entry.kind !== "symlink" && reader.size > MAX_BUFFERED_BLOB_SIZE) {
            // Its bytes travel outside the response message, so they count against no budget.
            out.push([path, { kind: "stream", byteLength: reader.size,
                              content: blobByteStream(reader) }]);
            continue;
          }
          let payload = reader.read(0, reader.size);
          if (entry.kind === "symlink") {
            out.push([path, { kind: "unreadable", message: symlinkMessage(path, payload) }]);
          } else {
            let text = decodeBlobText(payload, path);
            bytes += payload.byteLength;
            out.push([path, { kind: "text", text }]);
          }
        } catch (err) {
          if (!(err instanceof UnreadableContentError)) throw err;
          out.push([path, { kind: "unreadable", message: err.message }]);
        }
      }
    }
    return out;
  }

  /**
   * The set of paths whose non-directory entry differs between two commits' trees (added,
   * removed, or changed in oid or mode), walking only differing subtrees and fault-pulling
   * whatever is missing. Blob content is never read. Symlink and gitlink entries are reported like files (callers render
   * them with their descriptive errors), and a name that is a file on one side and a directory
   * on the other contributes both the file path and the directory's differing contents.
   */
  async changedFilePathsBetween(aCommit: GitOid, bCommit: GitOid): Promise<Set<string>> {
    let out = new Set<string>();
    if (aCommit === bCommit) return out;
    let treeOf = async (oid: GitOid) => {
      let commit = await this.ensureObject(oid, { type: "commit", eagerTree: true });
      return parseGitCommitRefs(commit.payload, oid).tree;
    };
    await this.#diffTreesLazy(
        await treeOf(aCommit), aCommit, await treeOf(bCommit), bCommit, "", out);
    return out;
  }

  // Accumulates the differing non-directory paths of two trees (either may be absent) into
  // `out`. `aRef`/`bRef` are the referencing objects for pull hints.
  async #diffTreesLazy(aOid: GitOid | undefined, aRef: GitOid, bOid: GitOid | undefined,
                       bRef: GitOid, prefix: string, out: Set<string>): Promise<void> {
    if (aOid === bOid) return;
    let entriesOf = async (oid: GitOid | undefined, referencedBy: GitOid) => {
      if (oid === undefined) return new Map<string, GitTreeEntry>();
      let tree = await this.ensureObject(oid, { type: "tree", referencedBy, eagerTree: true });
      return new Map(parseGitTree(tree.payload, oid).map(entry => [entry.name, entry]));
    };
    let aEntries = await entriesOf(aOid, aRef);
    let bEntries = await entriesOf(bOid, bRef);
    for (let name of new Set([...aEntries.keys(), ...bEntries.keys()])) {
      let a = aEntries.get(name);
      let b = bEntries.get(name);
      if (a?.oid === b?.oid && a?.mode === b?.mode) continue;
      let path = prefix + name;
      let aDir = a?.mode === "40000";
      let bDir = b?.mode === "40000";
      if (aDir || bDir) {
        // Descend the tree side(s); a non-tree entry opposite a tree is one more difference.
        await this.#diffTreesLazy(aDir ? a!.oid : undefined, aOid ?? aRef,
                                  bDir ? b!.oid : undefined, bOid ?? bRef, `${path}/`, out);
        if ((a !== undefined && !aDir) || (b !== undefined && !bDir)) out.add(path);
      } else {
        out.add(path);
      }
    }
  }

  /**
   * Enforces the write side of the tree-entry modes decision on a worktree path: writing over a
   * symlink or submodule (gitlink) throws the same descriptive error reading one does, and a
   * path naming a base *directory* throws too -- a write there could never commit (git trees
   * cannot hold a file and a directory of one name; writeChangedFilesAsCommit rejects the
   * shape), so failing at the write keeps the error next to its cause instead of surfacing at
   * a far-away commit or accept. An absent path (a new file) and a regular file of either mode
   * pass -- including files whose *content* is unreadable (binary), since a whole-file write is
   * coherent against any base. Base entries only: a conflicting shape the
   * overlay itself creates (`set a/b` then `set a`) is caught by commit-time tree building,
   * the backstop for everything this write-time check can't see.
   */
  async assertWorktreePathWritable(commitOid: GitOid, path: string): Promise<void> {
    let { tree, entry } = await this.#resolveEntryAt(commitOid, path);
    if (entry?.mode === "120000") {
      // The target is the blob's content; the message tells the agent everything (same as reads).
      throw new Error(symlinkMessage(path, await this.#ensureFileBlob(entry.oid, tree)));
    }
    if (entry?.mode === "160000") {
      throw new Error(submoduleMessage(path, entry.oid));
    }
    if (entry?.mode === "40000") {
      throw new Error(`${path} is a directory`);
    }
  }

  /**
   * Resolves a commit id -- exactly 40 lowercase hex digits, as git itself emits them -- against
   * *local knowledge only*: the object store plus the metadata rows written by gatekeepers' puts
   * and advertisements. Never a remote lookup. Returns the oid without pulling anything; the
   * caller decides whether to fetch.
   *
   * Abbreviated ids are deliberately not accepted: knowing a commit's id is the capability to
   * read the commit, and a short prefix is guessable. (Remote truncated-id resolution, where a
   * human supplied one, is a gatekeeper API, e.g. GitHub's getCommit, which returns and
   * advertises the full oid.)
   *
   * Errors are agent-readable: a malformed id, an unknown commit ("look it up via the connection
   * first"), and a locally-present non-commit. An id known only from metadata resolves regardless
   * of its recorded type (the reader rule: an assertion-grade non-commit tag must not refuse the
   * operation without pulling, so the caller's pull lets the decoded bytes decide).
   */
  resolveCommitId(id: string): GitOid {
    if (!/^[0-9a-f]{40}$/.test(id)) {
      throw new Error(
          `${JSON.stringify(id)} is not a full git commit id: expected 40 lowercase hex digits.`);
    }
    let localType = this.localObjectType(id);
    if (localType !== undefined) {
      if (localType !== "commit") {
        throw new Error(`${id} is a ${localType}, not a commit.`);
      }
      return id;
    }
    if (this.storage.gitObjectMetadata.get(id) === undefined) {
      throw new Error(
          `Commit ${id} is not known to this workspace. Look it up through the connection that ` +
          `provides the repository first (e.g. its commit or branch APIs), which makes it ` +
          `available here.`);
    }
    return id;
  }

  /**
   * Resolves a commit id (see resolveCommitId) to a commit a worktree can be rooted at.
   * When the commit is absent locally but a gatekeeper is recorded as a source, performs the
   * *initial pull* -- one fetch for the commit, its full tree structure, and every blob under
   * EAGER_BLOB_LIMIT -- so ordinary reads never fault. Any locally-present commit works with no
   * gatekeeper at all (a gadget's history, another worktree's commit).
   */
  async fetchCommit(commitId: string): Promise<GitOid> {
    let commit = this.resolveCommitId(commitId);
    if (!this.hasLocalObject(commit)) {
      // Known only from gatekeeper metadata: pull eagerly. (A locally-present commit skips this;
      // any of its tree/blob objects missing locally fault in lazily on first read.)
      await this.ensureGitObjects([commit], {
        type: "commit",
        commitHistory: { kind: "depth", depth: 1 },
        filterBlobSize: EAGER_BLOB_LIMIT,
      });
    }
    let localType = this.localObjectType(commit);
    if (localType === undefined) {
      // ensureGitObjects throws on failure; defensive backstop.
      throw new Error(`Commit ${commit} could not be fetched.`);
    }
    if (localType !== "commit") {
      // The reader rule let an assertion-grade metadata row through resolveCommitId; the pulled
      // bytes have now decided.
      throw new Error(`${commit} is a ${localType}, not a commit.`);
    }
    return commit;
  }

  /**
   * Reads a blob as UTF-8 text under the file-content rules every worktree read applies --
   * UnreadableContentError, path-flavored, for binary content -- fault-pulling the blob on a
   * miss (`referencedBy` shapes the pull hints; `path` names the file in errors). For batch
   * callers (grep) that ensured the blobs beforehand -- and for re-reading a blob an earlier read
   * already pulled, where no referencing object is known -- this is a local read.
   */
  async readTextBlob(oid: GitOid, referencedBy: GitOid | undefined, path: string)
      : Promise<string> {
    return decodeBlobText(await this.#ensureFileBlob(oid, referencedBy), path);
  }

  /**
   * Ensures a batch of blobs is locally present in one pull, for readers that then decode them
   * locally (`readTextBlob`/`#ensureFileBlob` on a present blob never faults). Throws if any
   * cannot be obtained. Never a serial walk-and-fetch: this is the reason batch readers gather
   * their oids first.
   */
  async ensureBlobs(oids: Iterable<GitOid>): Promise<void> {
    await this.ensureGitObjects([...oids], this.#exactObjectHints("blob"));
  }

  // Reads a blob for a file path, whole, whatever its size, fault-pulling it if missing.
  async #ensureFileBlob(oid: GitOid, referencedBy: GitOid | undefined): Promise<Uint8Array> {
    return (await this.ensureObject(oid, { type: "blob", referencedBy })).payload;
  }

  // Faults a file's blob in if missing, as #ensureFileBlob does, without reading it.
  async #faultFileBlob(oid: GitOid, referencedBy: GitOid | undefined): Promise<void> {
    await this.ensureGitObjects([oid], this.#exactObjectHints("blob", referencedBy));
  }

  // -------------------------------------------------------------------------------------
  // Push authorization (the `ActionDescription.pushedCommits` machinery)

  /**
   * Verifies that every parent chain from each declared head reaches a commit *proven* on the
   * gatekeeper's remote (`onRemote` -- an advertisement never qualifies), walking cached commit
   * objects only. Throws an agent-visible error for an absent ancestor and for a parentless
   * root that isn't itself proven (no vacuous pass for roots): this is the safeguard that makes
   * an accidental push to an unrelated remote fail closed at queue time. Read-only; call before
   * `markPushClosure()`.
   */
  verifyPushAncestry(gatekeeperId: WorkpieceId, heads: GitOid[]): void {
    let visited = new Set<GitOid>();
    let stack = heads.map(validateGitOid);
    while (stack.length > 0) {
      let oid = stack.pop()!;
      if (visited.has(oid)) continue;
      visited.add(oid);
      let meta = this.storage.gitObjectMetadata.get(oid);
      if (meta?.onRemote.includes(gatekeeperId)) {
        // Prefer the decoded local type over the recorded one: an onRemote row's type is
        // usually measured, but marks converted after an applied push carry the walk's
        // assertion-grade stamp, and an assertion must never decide this check when the
        // bytes themselves are on hand.
        let type = this.localObjectType(oid) ?? meta.type;
        if (type !== "commit") {
          throw new Error(`Cannot push ${oid}: it is a ${type}, not a commit.`);
        }
        continue;  // proven on the destination
      }
      let local = this.#readLocalShallow(oid);
      if (local === undefined) {
        throw new Error(
            `Cannot push: commit ${oid} in the pushed history is not available in the ` +
            `workspace's git cache, so the history cannot be verified against the destination. ` +
            `A push requires the commit chain from each pushed head down to a commit pulled ` +
            `from (or already pushed to) the destination to be locally available -- in ` +
            `practice, commits authored here on top of a base pulled from that destination. ` +
            `Pushing a pre-existing branch whose intermediate history was never pulled is not ` +
            `supported yet.`);
      }
      if (local.type !== "commit") {
        throw new Error(`Cannot push ${oid}: it is a ${local.type}, not a commit.`);
      }
      let refs = parseGitCommitRefs(local.payload, oid);
      if (refs.parents.length === 0) {
        throw new Error(
            `Cannot push: the pushed history reaches root commit ${oid}, which is not known ` +
            `to the destination. Pushing a history unrelated to the destination is not ` +
            `supported (this protects against accidentally pushing to the wrong repository). ` +
            `If the repositories are genuinely related, first pull a shared ancestor commit ` +
            `from the destination.`);
      }
      stack.push(...refs.parents);
    }
  }

  /**
   * `GitCache.isAncestor()`: whether `ancestor` is reachable from `descendant` (inclusive) by
   * following parent links over locally cached commits. The walk never pulls; a parent chain
   * that leaves the cache simply stops, so false means "not verifiable as an ancestor over
   * cached history". Throws if `descendant` is not itself a locally cached commit, so callers
   * can distinguish "verified not an ancestor" from "history not available". Deliberately not
   * scoped to any gatekeeper's view (see the interface doc): this is what lets a gatekeeper
   * run a fast-forward check before submitting the push that would put the commits in view.
   */
  isAncestor(ancestor: GitOid, descendant: GitOid): boolean {
    validateGitOid(ancestor);
    validateGitOid(descendant);
    let start = this.#readLocalShallow(descendant);
    if (start === undefined || start.type !== "commit") {
      throw new Error(
          `Cannot check ancestry: ${descendant} is not a commit in the workspace's git cache.`);
    }
    if (ancestor === descendant) return true;
    let visited = new Set<GitOid>([descendant]);
    let stack = [...parseGitCommitRefs(start.payload, descendant).parents];
    while (stack.length > 0) {
      let oid = stack.pop()!;
      if (visited.has(oid)) continue;
      visited.add(oid);
      if (oid === ancestor) return true;
      let local = this.#readLocalShallow(oid);
      // An absent or non-commit parent ends this path: the walk answers over cached commit
      // history only. (A non-commit parent oid means a forged commit; not this method's problem.)
      if (local === undefined || local.type !== "commit") continue;
      stack.push(...parseGitCommitRefs(local.payload, oid).parents);
    }
    return false;
  }

  /**
   * The best common ancestors of two commits, as `git merge-base --all` defines them: every
   * commit reachable from both (a commit reaches itself) that is not reachable from another
   * such commit, in no particular order. Usually there is one, the base for a three-way merge
   * of the two. A criss-cross history has several, and unrelated histories have none.
   *
   * Like `isAncestor()`, this walks locally cached commits and never pulls. A parent chain that
   * leaves the cache stops at the first commit not held: that commit still counts as an
   * ancestor, since a held commit names it, but its own ancestors go unseen. So the answer is
   * exact wherever both histories are wholly held, as a gadget's and a blueprint release's are.
   * Throws if either commit is not itself a locally cached commit.
   */
  mergeBases(a: GitOid, b: GitOid): GitOid[] {
    let ancestryOfA = this.#cachedAncestry(a);
    let ancestryOfB = this.#cachedAncestry(b);
    let common = [...ancestryOfA.keys()].filter(oid => ancestryOfB.has(oid));
    // Every parent of a common ancestor is a common ancestor too, so one of them is reachable
    // from another exactly when it is the parent of one.
    let reachable = new Set(common.flatMap(oid => ancestryOfA.get(oid)!));
    return common.filter(oid => !reachable.has(oid));
  }

  // Every commit reachable from `start`, itself included, over cached history, each with its
  // parents -- or with none, if it is not a locally cached commit and the walk stops there.
  #cachedAncestry(start: GitOid): Map<GitOid, GitOid[]> {
    validateGitOid(start);
    let ancestry = new Map<GitOid, GitOid[]>();
    let stack = [start];
    while (stack.length > 0) {
      let oid = stack.pop()!;
      if (ancestry.has(oid)) continue;
      let local = this.#readLocalShallow(oid);
      let parents: GitOid[] = [];
      if (local?.type === "commit") {
        parents = parseGitCommitRefs(local.payload, oid).parents;
      } else if (oid === start) {
        throw new Error(
            `Cannot find merge bases: ${start} is not a commit in the workspace's git cache.`);
      }
      ancestry.set(oid, parents);
      stack.push(...parents);
    }
    return ancestry;
  }

  /**
   * Marks the push closure of a verified `pushedCommits` declaration: walks from the heads
   * through parents and containment (commit → tree → entries), stamping every visited object
   * `pendingPush {gatekeeperId, actionId}` -- skipping, without descending, objects the remote
   * already knows (`onRemote ∪ pullableFrom`; remotes are closed under containment) and
   * skipping gitlink entries entirely (a submodule commit belongs to a foreign repo). An
   * absent tree/blob that isn't remote-known is still marked; when its bytes later arrive, the
   * mark propagates to its referents under the same rules (see `#extendToReferents`).
   *
   * Callers run this inside the same transaction that persists the action record, so a failed
   * submit strands no marks.
   */
  markPushClosure(gatekeeperId: WorkpieceId, actionId: number, heads: GitOid[]): void {
    this.#markForPush(gatekeeperId, actionId,
        heads.map(oid => ({ oid: validateGitOid(oid), type: "commit" as GitObjectType })));
  }

  // The marking walk worker, shared by markPushClosure (from the declared heads) and lazy
  // propagation at object arrival (from a marked object's referents). Each entry's type comes
  // from its referencing context (assertion-grade).
  #markForPush(gatekeeperId: WorkpieceId, actionId: number,
               initial: { oid: GitOid, type: GitObjectType }[]): void {
    let stack = [...initial];
    while (stack.length > 0) {
      let { oid, type } = stack.pop()!;
      let { meta, dirty } = this.#metaFor(gatekeeperId, oid, type, "asserted");
      if (meta.onRemote.includes(gatekeeperId) || meta.pullableFrom.includes(gatekeeperId) ||
          meta.pendingPush.some(p => p.actionId === actionId)) {
        // Remote-known (skip without descending) or already visited; still persist a type
        // reconciliation so the log never claims a correction that didn't land.
        if (dirty) this.storage.gitObjectMetadata.put(meta);
        continue;
      }
      meta.pendingPush.push({ gatekeeperId, actionId });
      this.storage.gitObjectMetadata.put(meta);  // also lands in byPendingPushAction
      // A chunked blob is never materialized for this: a blob refers to nothing.
      let local = this.#readLocalShallow(oid);
      if (local !== undefined) stack.push(...this.#referentEntries(oid, local));
    }
  }

  // The containment edges of an object, for the marking walk and mark propagation: a commit
  // points at its tree and parents, a tree at its non-gitlink entries. Gitlink targets are
  // foreign repos' commits and are never walked, pulled, or pushed.
  #referentEntries(oid: GitOid, object: ShallowObject): { oid: GitOid, type: GitObjectType }[] {
    if (object.type === "commit") {
      let refs = parseGitCommitRefs(object.payload, oid);
      return [
        { oid: refs.tree, type: "tree" },
        ...refs.parents.map(parent => ({ oid: parent, type: "commit" as GitObjectType })),
      ];
    } else if (object.type === "tree") {
      return scanGitTree(object.payload, oid)
          .filter(entry => entry.mode !== "160000")
          .map(entry => ({ oid: entry.oid, type: treeEntryObjectType(entry.mode) }));
    }
    return [];
  }

  /**
   * Converts an applied action's pending-push marks into `onRemote` proof: the remote genuinely
   * received the objects (they also become re-pullable from it). Idempotent; run it in the same
   * transaction as the action's completion record, so a crash between the push and the
   * conversion strands nothing locally.
   */
  convertPushMarksToOnRemote(actionId: number): void {
    for (let meta of this.#recordsMarkedFor(actionId)) {
      let converted = meta.pendingPush.filter(p => p.actionId === actionId);
      meta.pendingPush = meta.pendingPush.filter(p => p.actionId !== actionId);
      for (let entry of converted) addUnique(meta.onRemote, entry.gatekeeperId);
      this.storage.gitObjectMetadata.put(meta);  // the index entry drops with the array element
    }
  }

  /**
   * Removes a queued push's marks without conversion: the action was rejected, or its
   * gatekeeper was deleted with the push still queued. (A *reverted* applied push keeps
   * `onRemote` -- the remote received the objects; the ref merely rolled back -- so reverts
   * call nothing here.)
   */
  clearPushMarks(actionId: number): void {
    for (let meta of this.#recordsMarkedFor(actionId)) {
      meta.pendingPush = meta.pendingPush.filter(p => p.actionId !== actionId);
      if (meta.pendingPush.length === 0 && meta.onRemote.length === 0 &&
          meta.pullableFrom.length === 0 && meta.size === undefined) {
        this.storage.gitObjectMetadata.delete(meta.oid);
      } else {
        this.storage.gitObjectMetadata.put(meta);
      }
    }
  }

  // The metadata records marked pending-push for one action, materialized before iteration:
  // the callers mutate the collection (and hence the index) mid-loop.
  #recordsMarkedFor(actionId: number): GitObjectMetadataRecord[] {
    return Array.from(this.storage.gitObjectMetadata.byPendingPushAction.get(actionId));
  }

  /**
   * `GitCache.buildPack()`: composes the undeltified packfile carrying the applying action's
   * full pending-push closure. Completes the closure first: any marked object absent from the
   * store is faulted in from its recorded sources (batched by type), and a faulted tree's
   * arrival propagates marks to its children, which may fault in turn -- repeating until no
   * marked object is absent. A mid-stream provenance loss fails the apply with the "reconnect"
   * error from the pull delegate.
   */
  async buildPackForAction(gatekeeperId: WorkpieceId, actionId: number)
      : Promise<ReadableStream<Uint8Array>> {
    for (;;) {
      let missing = this.#recordsMarkedFor(actionId)
          .filter(mark => !this.hasLocalObject(mark.oid));
      if (missing.length === 0) break;
      // One batched fetch per expected type (a fetch's hints carry a single type).
      let byType = new Map<GitObjectType, GitOid[]>();
      for (let mark of missing) {
        let group = byType.get(mark.type);
        if (group === undefined) byType.set(mark.type, group = []);
        group.push(mark.oid);
      }
      for (let [type, oids] of byType) {
        await this.ensureGitObjects(oids, this.#exactObjectHints(type));
      }
      // Arrivals may have propagated marks to newly-visible children; loop until closed. The
      // marked set grows monotonically toward the finite closure, and ensureGitObjects throws
      // rather than silently not delivering, so this terminates.
    }

    const marks = this.#recordsMarkedFor(actionId), cache = this;
    async function* objects(): AsyncGenerator<PackEntrySource> {
      for (const mark of marks) {
        // A large blob streams into the pack from its reader; it is never assembled.
        const reader = mark.type === "blob" ? cache.openLocalBlob(mark.oid) : undefined;
        if (reader !== undefined && reader.size > MAX_BUFFERED_BLOB_SIZE) {
          yield { type: "blob", size: reader.size, pieces: () => reader.pieces() };
        } else if (reader !== undefined) {
          yield { type: "blob", payload: reader.read(0, reader.size) };
        } else {
          yield await cache.ensureObject(mark.oid, {type: mark.type});
        }
      }
    }
    return buildPackStream(marks.length, objects());
  }

  // -------------------------------------------------------------------------------------
  // Metadata plumbing

  // Fetches or creates the metadata row for an oid, reconciling the caller's knowledge of the
  // object's type with what is already recorded. `grade` is the claim's evidentiary grade:
  // "measured" means the type comes from hash-verified bytes in hand, and always wins (two
  // measurements can never conflict -- the oid covers the type header); "asserted" means it
  // comes from a referencing context or an advertisement, and never overrides a measured type
  // (measured iff `size` is recorded -- see the field docs). Among conflicting assertions,
  // "commit" wins and otherwise the first claim is kept: commit-ness is what unlocks operations
  // (worktree creation, push heads), and a false non-commit tag could steer a reader into
  // refusing before pulling, while a false commit tag just makes us pull and discover the
  // truth. Any conflict indicates a forged object or a gatekeeper bug, so all are logged; none
  // is fatal -- a wrong type only mis-shapes advisory pull hints until measured bytes correct
  // it. `dirty` reports a type correction on an existing row, so callers that otherwise skip
  // redundant puts still persist it.
  #metaFor(gatekeeperId: WorkpieceId, oid: GitOid, type: GitObjectType,
           grade: "measured" | "asserted")
      : { meta: GitObjectMetadataRecord, dirty: boolean } {
    let meta = this.storage.gitObjectMetadata.get(oid);
    if (meta === undefined) {
      return { meta: { oid, type, onRemote: [], pullableFrom: [], pendingPush: [] },
               dirty: false };
    }
    let dirty = false;
    if (meta.type !== type) {
      let wins = grade === "measured" || (meta.size === undefined && type === "commit");
      logger.warn(wins ? "correcting git object type from conflicting claim"
                       : "ignoring conflicting git object type claim", {
        event: wins ? "git.metadata.type.corrected" : "git.metadata.type.conflict",
        gatekeeperId,
        oidPrefix: oid.slice(0, 12),  // truncated: full oids are capabilities, keep them out
        recordedType: meta.type,
        claimedType: type,
      });
      if (wins) {
        meta.type = type;
        dirty = true;
      }
    }
    return { meta, dirty };
  }

  // Records an assertion-grade pull-routing hint, for an advertised commit or for the referents
  // of an object the gatekeeper is a source of. Like the marking walk, this descends through
  // objects that are held, whose referents the remote must have as well. That is what makes
  // the order objects arrive in immaterial: one stored before its parent could not be given a
  // hint that only the parent's arrival brings. The walk stops at an object the gatekeeper was
  // already a source of, whose referents were given the hint when it became one.
  #recordPullable(gatekeeperId: WorkpieceId, initial: { oid: GitOid, type: GitObjectType }[])
      : void {
    let stack = [...initial];
    while (stack.length > 0) {
      let { oid, type } = stack.pop()!;
      let { meta, dirty } = this.#metaFor(gatekeeperId, oid, type, "asserted");
      let wasSource =
          meta.onRemote.includes(gatekeeperId) || meta.pullableFrom.includes(gatekeeperId);
      if (addUnique(meta.pullableFrom, gatekeeperId) || dirty) {
        this.storage.gitObjectMetadata.put(meta);
      }
      if (wasSource) continue;
      // A chunked blob is never materialized for this: a blob refers to nothing.
      let local = this.#readLocalShallow(oid);
      if (local !== undefined) stack.push(...this.#referentEntries(oid, local));
    }
  }

  // The shared put()-equivalent store step (callers wrap in a transaction): records proof of
  // possession, measured type and size, and then stores the object, which extends that proof to
  // its referents as pull routing (see `#extendToReferents`). An object already present,
  // measured, and proven for this gatekeeper is left as it is: a pull sends no `have`s, so a
  // retried one, or one for another commit of a mounted repository, carries mostly such objects.
  #storeVerifiedObject(gatekeeperId: WorkpieceId, oid: GitOid, object: StorableObject): void {
    let { meta } = this.#metaFor(gatekeeperId, oid, object.type, "measured");
    if (meta.size !== undefined && meta.onRemote.includes(gatekeeperId) &&
        this.hasLocalObject(oid)) {
      return;
    }
    addUnique(meta.onRemote, gatekeeperId);
    meta.size = object.payload === undefined ? object.record.size : object.payload.byteLength;
    this.storage.gitObjectMetadata.put(meta);
    this.#putObject(oid, object);
  }

  // Extends what is recorded about an object to the objects it refers to. This can only happen
  // once the object's bytes are here to say what those are, so it runs as the object is stored,
  // inside the storing transaction, whatever is storing it (see `#putObject`):
  // - Every gatekeeper recorded as a source of the object, by proof or by claim, becomes a pull
  //   source for its referents, and on through those of them that are held. Remotes are closed
  //   under containment, so a remote that has the object has them too, whichever way these
  //   bytes arrived.
  // - Every queued push that includes the object includes its referents, under the marking
  //   walk's rules. The walk could mark the object while it was absent, but not see past it.
  #extendToReferents(oid: GitOid, object: StorableObject): void {
    // Nothing is recorded about most objects authored here, and a blob refers to nothing.
    if (object.type === "blob" || object.payload === undefined) return;
    let meta = this.storage.gitObjectMetadata.get(oid);
    if (meta === undefined) return;

    let referents = this.#referentEntries(oid, object);
    for (let gatekeeperId of new Set([...meta.onRemote, ...meta.pullableFrom])) {
      this.#recordPullable(gatekeeperId, referents);
    }
    // After the sources, so that a push skips what its destination is now known to have.
    for (let mark of meta.pendingPush) {
      this.#markForPush(mark.gatekeeperId, mark.actionId, referents);
    }
  }
}

// =======================================================================================
// The RPC stub

/**
 * The `GitCache` stub handed to gatekeepers (see workshop-shared/gatekeeper.ts for the
 * interface contract). Minted per gatekeeper -- the identity scopes both metadata attribution
 * (put/advertise record this gatekeeper as the source) and the read view. The overseer
 * additionally binds the stub passed to `applyAction()` to the applying action, which is what
 * makes `buildPack()` available; session-scoped stubs (from
 * `ObservationAuthorizer.getGitCache()`) have no action and `buildPack()` throws.
 */
@validateRpc()
export class GitCacheImpl extends RpcTarget implements GitCache {
  constructor(private cache: WorkspaceGitCache, private gatekeeperId: WorkpieceId,
              private actionId?: number) {
    super();
  }

  async get(id: GitOid, hints?: GitPullHints)
      : Promise<{ type: GitObjectType, content: Uint8Array | ReadableStream<Uint8Array> } | null> {
    let object = await this.cache.readForGatekeeper(this.gatekeeperId, id, hints);
    if (object === null) return null;
    // A Uint8Array iff at most MAX_BUFFERED_BLOB_SIZE, as the interface promises. Over it is a
    // blob's reader, or, rarely, a whole tree of a very large directory.
    if (object.payload === undefined) {
      return { type: object.type, content: blobByteStream(object.reader) };
    } else if (object.payload.byteLength > MAX_BUFFERED_BLOB_SIZE) {
      return { type: object.type, content: new Blob([object.payload]).stream() };
    }
    return { type: object.type, content: object.payload };
  }

  async has(id: GitOid): Promise<boolean> {
    return await this.cache.statForGatekeeper(this.gatekeeperId, id) !== null;
  }

  async stat(id: GitOid): Promise<{ type: GitObjectType, size: number } | null> {
    return await this.cache.statForGatekeeper(this.gatekeeperId, id);
  }

  async put(type: GitObjectType, content: Uint8Array): Promise<GitOid> {
    return this.cache.putFromGatekeeper(this.gatekeeperId, type, content);
  }

  async advertiseCommit(commitId: GitOid): Promise<void> {
    this.cache.advertiseCommit(this.gatekeeperId, commitId);
  }

  async buildPack(): Promise<ReadableStream<Uint8Array>> {
    if (this.actionId === undefined) {
      throw new Error(
          "buildPack() is only available on the action-scoped GitCache stub passed to " +
          "applyAction(); a session-time stub has no action.");
    }
    return this.cache.buildPackForAction(this.gatekeeperId, this.actionId);
  }

  async consumePack(pack: ReadableStream<Uint8Array>): Promise<GitOid[]> {
    return this.cache.consumePackFromGatekeeper(this.gatekeeperId, pack);
  }

  async isAncestor(ancestor: GitOid, descendant: GitOid): Promise<boolean> {
    return this.cache.isAncestor(ancestor, descendant);
  }
}

// =======================================================================================
// Small helpers

function addUnique<T>(array: T[], value: T): boolean {
  if (array.includes(value)) return false;
  array.push(value);
  return true;
}

// The path-flavored descriptions of the three entry shapes that have no readable text. Shared
// by the throwing reads (the message is the error) and readFilesAtCommit (it is the
// `unreadable` entry), so both surfaces say the same thing.
function symlinkMessage(path: string, target: Uint8Array): string {
  return `${path} is a symlink to ${new TextDecoder().decode(target)}`;
}

function submoduleMessage(path: string, target: GitOid): string {
  return `${path} is a submodule (gitlink) pointing at commit ${target}`;
}

/** Decode a Git blob payload as strict text. */
export function decodeBlobText(payload: Uint8Array, path: string): string {
  if (payload.includes(0)) throw new UnreadableContentError(`${path} is not a text file`);
  try {
    return TEXT_DECODER_STRICT.decode(payload);
  } catch {
    throw new UnreadableContentError(`${path} is not a text file`);
  }
}

// Splits and validates a file path, for reads and writes alike: no empty segments, no "." or
// "..". (Writes also refuse the names git reserves; see #rebuildTree.)
function splitTreePath(path: string): string[] {
  let segments = path.split("/");
  for (let segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`invalid file path: ${path}`);
    }
  }
  return segments;
}

// A parsed-but-unwritten change set: new file contents (or null = delete) at the leaves,
// touched subtrees within.
type ChangeNode = Map<string, ChangeNode | FileContent | null>;

// Converts a flat `path -> content | null` change map into nested nodes, validating path shape:
// a path can't be both a file and a directory.
function buildChangeNode(changes: ReadonlyMap<string, FileContent | null>): ChangeNode {
  let root: ChangeNode = new Map();
  for (let [path, content] of changes) {
    let segments = splitTreePath(path);
    let node = root;
    for (let [i, segment] of segments.entries()) {
      let existing = node.get(segment);
      if (i === segments.length - 1) {
        if (existing !== undefined) throw new Error(`conflicting file paths at: ${path}`);
        node.set(segment, content);
      } else {
        if (existing === undefined) {
          existing = new Map();
          node.set(segment, existing);
        } else if (!(existing instanceof Map)) {
          throw new Error(`conflicting file paths at: ${path}`);
        }
        node = existing;
      }
    }
  }
  return root;
}

// =======================================================================================
// Commit identity

/** Options for `WorkspaceGitCache.writeFilesAsCommit()` and the other commit writers. */
export interface WriteCommitOptions {
  /** Parent commit oids; empty for a root commit. */
  parents: string[];

  /** Commit author. Also used as the committer unless `committer` is given. */
  author: CommitIdentity;

  /** Committer, when distinct from the author. */
  committer?: CommitIdentity;

  /** Commit message. Normalized git-style to end with exactly one newline. */
  message: string;

  /** Author and committer timestamp. Recorded in UTC (timezone offset 0). */
  timestamp: Date;

  /** Further headers, written after `committer` in the order given (see `GitCommit.headers`). */
  headers?: readonly GitCommitHeader[];
}

/**
 * Derives a git commit identity from a chat author: the display name becomes the commit name,
 * and the email is the author's preferred `commitEmail` if set, else the profile ID. Profile IDs
 * are typically email addresses; in username/password mode they may be bare usernames, which
 * become `<username>@localhost`.
 *
 * The characters a commit's signature cannot hold are dropped (see `signatureSafe()`), so that a
 * display name with a line break in it neither fails the commit nor writes header lines of its
 * own into it.
 */
export function commitIdentityForAuthor(author: AiChatAuthorInfo): CommitIdentity {
  return {
    name: signatureSafe(author.name),
    email: signatureSafe(author.commitEmail ??
        (author.id.includes("@") ? author.id : `${author.id}@localhost`)),
  };
}
