// The workspace git cache: provenance tracking and push authorization over the git object store.
//
// This layers gatekeeper-facing semantics onto the `gitObjects` collection (git-store.ts):
//
// - `GitCacheImpl` is the per-gatekeeper `GitCache` RPC stub (workshop-shared/gatekeeper.ts).
//   Every stub is scoped to the gatekeeper it was minted for; the stub passed to `applyAction()`
//   is additionally bound to the applying action, which is what enables `buildPack()`.
// - `gitObjectMetadata` records, per oid, which gatekeepers' remotes provably possess the object
//   (`onRemote`), which merely claim to (`pullableFrom`), and which queued actions plan to push
//   it (`pendingPush`). The two source sets differ in evidentiary grade: `onRemote` is entered
//   only by a hash-verified put()/push, `pullableFrom` by advertisements and referent recording.
//   Metadata routinely exists for objects the store does NOT hold (advertised commits,
//   filtered-out tree entries, oversized blobs we declined to store), which is one of the two
//   reasons it is a separate collection -- the other being that reading a `gitObjects` row means
//   reading the whole object content.
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
//
// The lazy read paths here (`ensureObject`, `readFileAtCommit`, `listTreeEntries`) parse git
// objects via the hand-rolled codec (git-codec.ts) rather than isomorphic-git, because each step
// must know the expected type and the referencing object to shape `GitPullHints`. Writes never
// fault and stay in git-store.ts on isomorphic-git.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { collection, type Collection, type NonUniqueIndex } from "@gadgets/typed-storage";
import type {
  GitCache,
  GitObjectType,
  GitOid,
  GitPullHints,
} from "@gadgets/workshop-shared/gatekeeper";
import type { WorkpieceId } from "@gadgets/workshop-shared/api";
import type { GitObjectRecord } from "./git-store";
import {
  buildPackBytes,
  concatBytes,
  decodeLooseObject,
  decodePackBytes,
  encodeLooseObject,
  gitObjectOid,
  parseGitCommitRefs,
  parseGitTree,
  scanGitTree,
  treeEntryObjectType,
  validateGitObjectType,
  validateGitOid,
  type GitTreeEntry,
  type PackableObject,
} from "./git-codec";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.git-cache");

// =======================================================================================
// Constants

/**
 * Maximum payload size of a single git object the cache will store, aligned with the store's
 * record constraints (a deflated object must fit a ~2MB storage record) and the intended
 * ~1MB per-file support cap for worktrees. A put() beyond this is rejected -- but measured
 * first, so the size lands in metadata and later reads of the object fail fast instead of
 * re-downloading it.
 */
export const MAX_GIT_OBJECT_SIZE = 1 << 20;

/**
 * Maximum byte size of a packfile accepted by `consumePack()` (matching the transfer-size
 * limiter gatekeepers are expected to apply to fetch bodies), and the hard per-object
 * inflation bound while decoding one.
 */
export const MAX_GIT_PACK_BYTES = 64 << 20;

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
// Storage schema

/**
 * Per-oid metadata relating a git object to gatekeepers' remotes. One row per oid with source
 * *arrays* (rather than one row per pair, the idiomatic typed-storage shape); a row may exist
 * for an object the store does not hold.
 */
export interface GitObjectMetadataRecord {
  oid: GitOid;

  /**
   * The object's type. Always known at write time: *measured* from hash-verified bytes
   * (put/consumePack, including oversize rejections), or *asserted* by the referencing context
   * that introduced the oid (a tree entry's mode, a commit's tree/parent headers, an
   * advertisement) -- which is how it can exist for objects never fetched. The two grades are
   * distinguished by `size`: measured writers always record both together, so `size !==
   * undefined` iff the type is proof-grade. Conflicting claims (always a forged object or a
   * gatekeeper bug) are reconciled by `#metaFor`: measured wins unconditionally, an assertion
   * never overrides a measured type, and among assertions "commit" wins, otherwise first claim
   * kept. Readers must never hard-reject an operation based on an assertion-grade type --
   * decode local bytes or pull first; asserted types only shape advisory pull hints.
   */
  type: GitObjectType;

  /**
   * The payload byte size. Recorded ONLY from bytes actually measured: a stored put(), or a
   * put()/pack entry rejected for exceeding MAX_GIT_OBJECT_SIZE (the content was in hand, so
   * the measurement is proof-grade and lets later reads fail fast). Never inferred from an
   * object's *absence* -- an omitted blob's size is unknowable, and an absence-based record
   * would durably trust gatekeeper behavior as if it were a measurement. Doubles as `type`'s
   * evidentiary grade (see its doc).
   */
  size?: number;

  /**
   * Gatekeepers whose remote *provably* possesses this object: entered only by a hash-verified
   * put() from that gatekeeper or by a successfully applied push to it. This is what the scoped
   * read view serves, what push ancestry verification terminates on, and what the marking walk
   * skips.
   */
  onRemote: WorkpieceId[];

  /**
   * Unproven pull-routing hints: gatekeepers that advertised this commit or put() an object
   * referencing this one. Used to route pulls and to bound the marking walk; grants no reads.
   * A wrong claim only misroutes a pull (the next recorded source is tried).
   */
  pullableFrom: WorkpieceId[];

  /**
   * Queued pushes that include this object, written by the marking walk at submitAction and
   * keyed to the action (via the `byPendingPushAction` index) for cleanup. This is the read
   * grant that lets the destination gatekeeper simulate a queued push as if it had already
   * landed.
   */
  pendingPush: { gatekeeperId: WorkpieceId, actionId: number }[];
}

/**
 * Typed-storage schema for the `gitObjectMetadata` collection. Shared with tests.
 *
 * `byPendingPushAction` is the pending-push marks index: one entry per `pendingPush` element,
 * keyed by action id, so an action's lifecycle transitions (apply-converts, reject-cleans)
 * iterate exactly its marked oids without re-walking the object graph. Being derived from the
 * record at write time, it can never disagree with the `pendingPush` arrays.
 */
export function gitObjectMetadataCollection() {
  return collection<GitObjectMetadataRecord>()({
    primaryKey: "oid",
    nonUniqueIndexes: {
      byPendingPushAction(record: GitObjectMetadataRecord) {
        return record.pendingPush.map(entry => entry.actionId);
      },
    },
  });
}

/** The slice of the Overseer's typed storage the git cache operates on. */
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
   * Invoke `Gatekeeper.gitPull(oids, cache, hints)` on the given gatekeeper, passing it a cache
   * stub scoped to itself. Must throw if the gatekeeper record no longer exists (provenance
   * loss: the error should tell the user to reconnect) or if the pull fails.
   */
  pull(gatekeeperId: WorkpieceId, oids: GitOid[], hints: GitPullHints): Promise<void>;
}

// =======================================================================================
// Errors

/**
 * A git blob (or other object) is beyond MAX_GIT_OBJECT_SIZE, either measured (a rejected put
 * recorded its exact size) or inferred from a blob-filtered pull that omitted it. Read paths
 * translate this into a path-specific "file is too large" error.
 */
export class GitObjectTooLargeError extends Error {
  constructor(public readonly oid: GitOid, size?: number) {
    super(size !== undefined
        ? `git object ${oid} is ${size} bytes, over the ${MAX_GIT_OBJECT_SIZE}-byte limit`
        : `git object ${oid} exceeds the ${MAX_GIT_OBJECT_SIZE}-byte limit`);
  }
}

/**
 * A worktree file's *content* cannot be presented as text: the blob is over the support cap
 * (oversized) or is not valid UTF-8 text (binary). The message is the agent-visible, path-
 * flavored description. Distinct from path-shape errors (symlink/gitlink/directory) and from
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

const MODE_KINDS: Record<GitTreeEntry["mode"], GitTreeEntryKind> = {
  "100644": "file",
  "100755": "executable",
  "40000": "dir",
  "120000": "symlink",
  "160000": "submodule",
};

// =======================================================================================
// WorkspaceGitCache

const TEXT_DECODER_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The overseer-side core of the git cache. One instance per Overseer, wrapping the typed
 * storage collections; `GitCacheImpl` stubs and the overseer's own paths (submitAction, lazy
 * reads) all funnel through it.
 */
export class WorkspaceGitCache {
  constructor(private storage: GitCacheStorage, private puller: GitPullDelegate) {}

  // -------------------------------------------------------------------------------------
  // Local object access

  /** Whether the store holds the object locally (no view scoping, no pulls). */
  hasLocalObject(oid: GitOid): boolean {
    return this.storage.gitObjects.get(oid) !== undefined;
  }

  /** Reads and decodes a locally-stored object, or undefined (no view scoping, no pulls). */
  readLocalObject(oid: GitOid): PackableObject | undefined {
    let record = this.storage.gitObjects.get(oid);
    return record === undefined ? undefined : decodeLooseObject(record.data);
  }

  // -------------------------------------------------------------------------------------
  // Gatekeeper writes

  /**
   * `GitCache.put()`: store a hash-verified object on behalf of a gatekeeper. Records proof of
   * possession (`onRemote`), referent pull-routing rows for a tree's entries or a commit's
   * tree/parents, and propagates any pending-push marks to the newly-visible referents. An
   * object over MAX_GIT_OBJECT_SIZE is measured (type + size recorded) but not stored, and the
   * call throws.
   */
  async putFromGatekeeper(gatekeeperId: WorkpieceId, type: GitObjectType, payload: Uint8Array)
      : Promise<GitOid> {
    validateGitObjectType(type);
    let oid = await gitObjectOid(type, payload);
    if (payload.byteLength > MAX_GIT_OBJECT_SIZE) {
      this.storage.transaction(
          () => this.#recordOversized(gatekeeperId, oid, type, payload.byteLength));
      throw new GitObjectTooLargeError(oid, payload.byteLength);
    }
    let data = encodeLooseObject(type, payload);
    this.storage.transaction(
        () => this.#storeVerifiedObject(gatekeeperId, oid, type, payload, data));
    return oid;
  }

  /**
   * `GitCache.advertiseCommit()`: record the assertion-grade "my remote has this commit" hint.
   * No observation is involved: an advertisement is workspace-internal pull-routing metadata,
   * not a read.
   */
  advertiseCommit(gatekeeperId: WorkpieceId, commitId: GitOid): void {
    validateGitOid(commitId);
    this.storage.transaction(() => this.#recordPullable(gatekeeperId, commitId, "commit"));
  }

  /**
   * `GitCache.consumePack()`: decode a packfile and store every contained object exactly as the
   * equivalent sequence of put()s would -- same hash-derived oids (poison-proof by
   * construction), same metadata recording and mark propagation, same size-cap handling (an
   * oversized entry is measured, recorded, and skipped rather than stored; it is then also
   * absent from the returned list, which is how a gitPull implementation notices). Returns the
   * stored oids in pack order.
   */
  async consumePackFromGatekeeper(gatekeeperId: WorkpieceId, pack: ReadableStream<Uint8Array>)
      : Promise<GitOid[]> {
    let bytes = await collectByteStream(pack, MAX_GIT_PACK_BYTES);
    let objects = await decodePackBytes(bytes, {
      maxObjectSize: MAX_GIT_PACK_BYTES,
      resolveBase: oid => this.readLocalObject(oid),
    });
    // Hash and deflate outside the storage transaction (hashing is async; deflate is just CPU
    // that needn't run under the write lock).
    let entries = await Promise.all(objects.map(async object => ({
      ...object,
      oid: await gitObjectOid(object.type, object.payload),
      data: object.payload.byteLength <= MAX_GIT_OBJECT_SIZE
          ? encodeLooseObject(object.type, object.payload) : undefined,
    })));

    let stored: GitOid[] = [];
    let seen = new Set<GitOid>();
    this.storage.transaction(() => {
      for (let entry of entries) {
        if (seen.has(entry.oid)) continue;
        seen.add(entry.oid);
        if (entry.data === undefined) {
          this.#recordOversized(gatekeeperId, entry.oid, entry.type, entry.payload.byteLength);
          continue;
        }
        this.#storeVerifiedObject(gatekeeperId, entry.oid, entry.type, entry.payload, entry.data);
        stored.push(entry.oid);
      }
    });
    return stored;
  }

  // -------------------------------------------------------------------------------------
  // The scoped gatekeeper read view

  /**
   * The single read behind `GitCache.get()`/`has()`/`stat()`: answers exactly
   * `onRemote(G) ∪ pendingPush(G)` for gatekeeper G and null for everything else. A pendingPush
   * object that is locally absent is pulled through from its recorded sources on demand (that
   * is what lets G simulate a queued cross-remote push); an absent onRemote object is not
   * pulled -- G's own remote has it, and null tells G to ask its remote itself.
   */
  async readForGatekeeper(gatekeeperId: WorkpieceId, oid: GitOid, hints?: GitPullHints)
      : Promise<PackableObject | null> {
    validateGitOid(oid);
    let meta = this.storage.gitObjectMetadata.get(oid);
    if (meta === undefined) return null;
    let onRemote = meta.onRemote.includes(gatekeeperId);
    let pendingPush = meta.pendingPush.some(p => p.gatekeeperId === gatekeeperId);
    if (!onRemote && !pendingPush) return null;

    let local = this.readLocalObject(oid);
    if (local === undefined && pendingPush) {
      await this.ensureGitObjects([oid], hints ?? this.#exactObjectHints(meta.type));
      local = this.readLocalObject(oid);
    }
    return local ?? null;
  }

  // -------------------------------------------------------------------------------------
  // Pull driver + lazy walker

  /**
   * Ensures the given objects are locally present, pulling any that are missing from their
   * recorded sources (`onRemote ∪ pullableFrom`, trying each recorded gatekeeper on failure).
   * All requests in one call share `hints` (batch callers group by expected type).
   *
   * Throws if an object cannot be obtained -- with one deliberate exception folded into the
   * error type: a requested *blob* still absent after a successful pull whose hints carried a
   * blob filter is reported as GitObjectTooLargeError ("unavailable at the supported size")
   * rather than as a pull failure. Nothing is recorded for it, so a later read simply retries;
   * a gatekeeper bug that wrongly omits a blob self-heals instead of wedging the file.
   */
  async ensureGitObjects(oids: GitOid[], hints: GitPullHints): Promise<void> {
    let missing = [...new Set(oids)].filter(oid => !this.hasLocalObject(oid));
    if (missing.length === 0) return;

    // Fail fast on objects whose measured size already proves them unstorable.
    for (let oid of missing) {
      let size = this.storage.gitObjectMetadata.get(oid)?.size;
      if (size !== undefined && size > MAX_GIT_OBJECT_SIZE) {
        throw new GitObjectTooLargeError(oid, size);
      }
    }

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
        // The filtered-omission carve-out: a blob the pull's own filter suppressed is "too
        // large", not "pull failed" (see the method doc).
        if (hints.type === "blob" && hints.filterBlobSize !== undefined) {
          let omitted = groupOids.find(oid => !this.hasLocalObject(oid));
          if (omitted !== undefined) throw new GitObjectTooLargeError(omitted);
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
    let local = this.readLocalObject(oid);
    if (local === undefined) {
      await this.ensureGitObjects([oid],
          expected.eagerTree && expected.type !== "blob"
              ? { type: expected.type,
                  ...(expected.referencedBy !== undefined
                      ? { referencedBy: expected.referencedBy } : {}),
                  commitHistory: { kind: "depth", depth: 1 },
                  filterBlobSize: EAGER_BLOB_LIMIT }
              : this.#exactObjectHints(expected.type, expected.referencedBy));
      local = this.readLocalObject(oid);
      if (local === undefined) {
        // ensureGitObjects throws on failure; this is a defensive backstop.
        throw new Error(`git object ${oid} is unavailable`);
      }
    }
    if (local.type !== expected.type) {
      throw new Error(`git object ${oid} is a ${local.type}, but a ${expected.type} was expected`);
    }
    return local;
  }

  // The pull-hint defaults for an exact-object fault: depth-1 (never deepen history), tree:0
  // alongside a commit want, tree:1 alongside a tree want (which already excludes the entries'
  // blobs), and a blob filter at the storable limit alongside a blob want -- so an oversized
  // blob either never arrives (the filter honored: the carve-out surfaces "too large") or
  // arrives huge (put()'s size rejection measures and records it). Either way, no absence-based
  // bookkeeping.
  #exactObjectHints(type: GitObjectType, referencedBy?: GitOid): GitPullHints {
    return {
      type,
      ...(referencedBy !== undefined ? { referencedBy } : {}),
      commitHistory: { kind: "depth", depth: 1 },
      ...(type === "commit" ? { filterTreeDepth: 0 } : {}),
      ...(type === "tree" ? { filterTreeDepth: 1 } : {}),
      ...(type === "blob" ? { filterBlobSize: MAX_GIT_OBJECT_SIZE + 1 } : {}),
    };
  }

  /**
   * Reads one file of a commit's tree by path, walking only the trees along the path (no
   * full-tree materialization) and fault-pulling whatever is missing. Regular files only:
   * a symlink or submodule (gitlink) path throws a descriptive error naming its target, a
   * directory path or absent entry throws "no such file", and oversized or binary (non-UTF-8 /
   * NUL-bearing) content throws a clean, path-specific error.
   */
  async readFileAtCommit(commitOid: GitOid, path: string): Promise<string> {
    let text = await this.readFileAtCommitIfExists(commitOid, path);
    if (text === undefined) throw new Error(`${path}: no such file`);
    return text;
  }

  /**
   * Like `readFileAtCommit`, but an absent path (including a path whose leading segments don't
   * resolve to directories, or one naming a directory) returns undefined instead of throwing.
   * Every other failure -- symlink/gitlink paths, oversized or binary content, a pull failure --
   * still throws its descriptive error. This is the lazy base resolver behind worktree session
   * content: "no base text" is an ordinary state there ("edit of absent file" is then the
   * change's own validation error), while the throwing errors describe the file itself.
   */
  async readFileAtCommitIfExists(commitOid: GitOid, path: string): Promise<string | undefined> {
    let { tree, entry } = await this.#resolveEntryAt(commitOid, path);
    if (entry === undefined || entry.mode === "40000") return undefined;
    switch (entry.mode) {
      case "160000":
        throw new Error(`${path} is a submodule (gitlink) pointing at commit ${entry.oid}`);
      case "120000": {
        // The symlink target *is* the blob's content, so the error tells the agent everything.
        let blob = await this.#readBlob(entry.oid, tree, path);
        throw new Error(`${path} is a symlink to ${new TextDecoder().decode(blob)}`);
      }
      default:
        return decodeBlobText(await this.#readBlob(entry.oid, tree, path), path);
    }
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
   * walk fault in as needed; blob content is never read. `referencedBy` is the object whose
   * payload holds the entry -- its containing tree, or the commit itself for the root -- the
   * hint a later read of the entry's object should carry.
   */
  async pathEntryAtCommit(commitOid: GitOid, path: string)
      : Promise<{ kind: GitTreeEntryKind, oid: GitOid, referencedBy: GitOid } | undefined> {
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
   * The set of paths whose non-directory entry differs between two commits' trees (added,
   * removed, or changed in oid or mode), walking only differing subtrees and fault-pulling
   * whatever is missing -- the lazy, worktree-scale sibling of `GitStore.changedPaths`. Blob
   * content is never read. Symlink and gitlink entries are reported like files (callers render
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
   * pass -- including files whose *content* is unreadable (oversized/binary), since a
   * whole-file write is coherent against any base. Base entries only: a conflicting shape the
   * overlay itself creates (`set a/b` then `set a`) is caught by commit-time tree building,
   * the backstop for everything this write-time check can't see.
   */
  async assertWorktreePathWritable(commitOid: GitOid, path: string): Promise<void> {
    let { tree, entry } = await this.#resolveEntryAt(commitOid, path);
    if (entry?.mode === "120000") {
      // The target is the blob's content; the message tells the agent everything (same as reads).
      let blob = await this.#readBlob(entry.oid, tree, path);
      throw new Error(`${path} is a symlink to ${new TextDecoder().decode(blob)}`);
    }
    if (entry?.mode === "160000") {
      throw new Error(`${path} is a submodule (gitlink) pointing at commit ${entry.oid}`);
    }
    if (entry?.mode === "40000") {
      throw new Error(`${path} is a directory`);
    }
  }

  /**
   * Resolves a commit reference -- a full 40-hex oid or an unambiguous prefix of at least 4 hex
   * digits -- against *local knowledge only*: the object store plus the metadata rows written by
   * gatekeepers' puts and advertisements. Never a remote lookup (remote truncated-id resolution
   * is a gatekeeper API, e.g. GitHub's getCommit, which returns and advertises the full oid).
   * Returns the full oid without pulling anything; the caller decides whether to fetch.
   *
   * Errors are agent-readable: malformed refs, an ambiguous prefix (listing the candidates), an
   * unknown ref ("look it up via the connection first"), and a locally-present non-commit.
   * Prefix candidates are filtered by locally-decoded types (measured) or the metadata type tag
   * (assertion-grade -- sound to filter on, because any commit id a gatekeeper handed the agent
   * was advertised, which forces its tag to "commit" under the reconciliation policy's commit
   * bias). A *full* oid is the reader-rule exception: an assertion-grade non-commit tag must not
   * refuse the operation without pulling, so a full oid known only from metadata resolves
   * regardless of its recorded type and the caller's pull lets the decoded bytes decide.
   */
  resolveCommitRef(ref: string): GitOid {
    let normalized = ref.toLowerCase();
    if (!/^[0-9a-f]{4,40}$/.test(normalized)) {
      throw new Error(
          `"${ref}" is not a git commit id: expected a 40-hex SHA-1, or a prefix of at least ` +
          `4 hex digits.`);
    }
    let unknown = () => new Error(
        `Commit ${ref} is not known to this workspace. Look it up through the connection that ` +
        `provides the repository first (e.g. its commit or branch APIs), which makes it ` +
        `available here.`);

    if (normalized.length === 40) {
      let local = this.readLocalObject(normalized);
      if (local !== undefined) {
        if (local.type !== "commit") {
          throw new Error(`${normalized} is a ${local.type}, not a commit.`);
        }
        return normalized;
      }
      if (this.storage.gitObjectMetadata.get(normalized) === undefined) throw unknown();
      return normalized;
    }

    // Prefix: gather candidates from both sources; a locally-decoded type (measured) wins over
    // the metadata tag for the same oid.
    let candidates = new Map<GitOid, boolean>();
    for (let record of this.storage.gitObjects.list({ prefix: normalized })) {
      candidates.set(record.oid, decodeLooseObject(record.data).type === "commit");
    }
    for (let meta of this.storage.gitObjectMetadata.list({ prefix: normalized })) {
      if (!candidates.has(meta.oid)) candidates.set(meta.oid, meta.type === "commit");
    }
    let commits = [...candidates.entries()].filter(([, isCommit]) => isCommit).map(([oid]) => oid);
    if (commits.length === 1) return commits[0];
    if (commits.length > 1) {
      throw new Error(
          `Commit id prefix ${ref} is ambiguous between: ${commits.toSorted().join(", ")}. ` +
          `Use a longer prefix.`);
    }
    throw unknown();
  }

  /**
   * Reads a blob as UTF-8 text under the file-content rules every worktree read applies --
   * UnreadableContentError, path-flavored, for oversized or binary content -- fault-pulling the
   * blob on a miss (`referencedBy` shapes the pull hints; `path` names the file in errors).
   * For batch callers (grep) that ensured the blobs beforehand, this is a local read.
   */
  async readTextBlob(oid: GitOid, referencedBy: GitOid, path: string): Promise<string> {
    return decodeBlobText(await this.#readBlob(oid, referencedBy, path), path);
  }

  // Reads a blob for a file path, translating unavailable-at-size into the path-specific error.
  async #readBlob(oid: GitOid, referencedBy: GitOid, path: string): Promise<Uint8Array> {
    let blob: PackableObject;
    try {
      blob = await this.ensureObject(oid, { type: "blob", referencedBy });
    } catch (err) {
      if (err instanceof GitObjectTooLargeError) {
        throw new UnreadableContentError(
            `${path} is too large to read (over ${MAX_GIT_OBJECT_SIZE} bytes)`, { cause: err });
      }
      throw err;
    }
    if (blob.payload.byteLength > MAX_GIT_OBJECT_SIZE) {
      // Locally-present but over the cap (e.g. written before the cap existed).
      throw new UnreadableContentError(
          `${path} is too large to read (over ${MAX_GIT_OBJECT_SIZE} bytes)`);
    }
    return blob.payload;
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
        let type = this.readLocalObject(oid)?.type ?? meta.type;
        if (type !== "commit") {
          throw new Error(`Cannot push ${oid}: it is a ${type}, not a commit.`);
        }
        continue;  // proven on the destination
      }
      let local = this.readLocalObject(oid);
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
    let start = this.readLocalObject(descendant);
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
      let local = this.readLocalObject(oid);
      // An absent or non-commit parent ends this path: the walk answers over cached commit
      // history only. (A non-commit parent oid means a forged commit; not this method's problem.)
      if (local === undefined || local.type !== "commit") continue;
      stack.push(...parseGitCommitRefs(local.payload, oid).parents);
    }
    return false;
  }

  /**
   * Marks the push closure of a verified `pushedCommits` declaration: walks from the heads
   * through parents and containment (commit → tree → entries), stamping every visited object
   * `pendingPush {gatekeeperId, actionId}` -- skipping, without descending, objects the remote
   * already knows (`onRemote ∪ pullableFrom`; remotes are closed under containment) and
   * skipping gitlink entries entirely (a submodule commit belongs to a foreign repo). An
   * absent tree/blob that isn't remote-known is still marked; when its bytes later arrive, the
   * mark propagates to its referents under the same rules (see `#storeVerifiedObject`).
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
      let local = this.readLocalObject(oid);
      if (local !== undefined) stack.push(...this.#referentEntries(oid, local));
    }
  }

  // The containment edges of an object, for the marking walk and mark propagation: a commit
  // points at its tree and parents, a tree at its non-gitlink entries. Gitlink targets are
  // foreign repos' commits and are never walked, pulled, or pushed.
  #referentEntries(oid: GitOid, object: PackableObject): { oid: GitOid, type: GitObjectType }[] {
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

    let objects = this.#recordsMarkedFor(actionId).map(mark => this.readLocalObject(mark.oid)!);
    let chunks = await buildPackBytes(objects);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (let chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
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

  // Records an assertion-grade pull-routing hint (advertisement or put-referent).
  #recordPullable(gatekeeperId: WorkpieceId, oid: GitOid, type: GitObjectType): void {
    let { meta, dirty } = this.#metaFor(gatekeeperId, oid, type, "asserted");
    if (addUnique(meta.pullableFrom, gatekeeperId) || dirty) {
      this.storage.gitObjectMetadata.put(meta);
    }
  }

  // Records the measurement of an object too large to store: type and exact size (proof-grade,
  // from bytes in hand) plus possession -- the bytes were hash-verified even though declined.
  #recordOversized(gatekeeperId: WorkpieceId, oid: GitOid, type: GitObjectType, size: number)
      : void {
    let { meta } = this.#metaFor(gatekeeperId, oid, type, "measured");
    meta.size = size;
    addUnique(meta.onRemote, gatekeeperId);
    this.storage.gitObjectMetadata.put(meta);
  }

  // The shared put()-equivalent store step (callers wrap in a transaction): store the object,
  // record proof of possession and referent pull-routing rows, and propagate pending-push marks
  // to the referents now that they are visible.
  #storeVerifiedObject(gatekeeperId: WorkpieceId, oid: GitOid, type: GitObjectType,
                       payload: Uint8Array, data: Uint8Array): void {
    this.storage.gitObjects.put({ oid, data });
    let { meta } = this.#metaFor(gatekeeperId, oid, type, "measured");
    addUnique(meta.onRemote, gatekeeperId);
    meta.size = payload.byteLength;
    this.storage.gitObjectMetadata.put(meta);

    let referents = this.#referentEntries(oid, { type, payload });
    for (let referent of referents) {
      this.#recordPullable(gatekeeperId, referent.oid, referent.type);
    }
    // Lazy mark propagation: if this object was marked pending-push while absent, its referents
    // become markable now. (Re-read the row: the puts above rewrote it.)
    for (let mark of this.storage.gitObjectMetadata.get(oid)?.pendingPush ?? []) {
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
      : Promise<{ type: GitObjectType, content: Uint8Array } | null> {
    let object = await this.cache.readForGatekeeper(this.gatekeeperId, id, hints);
    return object === null ? null : { type: object.type, content: object.payload };
  }

  async has(id: GitOid): Promise<boolean> {
    return await this.cache.readForGatekeeper(this.gatekeeperId, id) !== null;
  }

  async stat(id: GitOid): Promise<{ type: GitObjectType, size: number } | null> {
    let object = await this.cache.readForGatekeeper(this.gatekeeperId, id);
    return object === null ? null : { type: object.type, size: object.payload.byteLength };
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

// Decodes a blob's payload as strict UTF-8 text, throwing the path-flavored
// UnreadableContentError for binary content (NUL bytes or invalid UTF-8).
function decodeBlobText(payload: Uint8Array, path: string): string {
  if (payload.includes(0)) throw new UnreadableContentError(`${path} is not a text file`);
  try {
    return TEXT_DECODER_STRICT.decode(payload);
  } catch {
    throw new UnreadableContentError(`${path} is not a text file`);
  }
}

// Splits and validates a file path against the same shape rules git-store enforces on writes:
// no empty segments, no "." or "..".
function splitTreePath(path: string): string[] {
  let segments = path.split("/");
  for (let segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`invalid file path: ${path}`);
    }
  }
  return segments;
}

// Collects a byte stream into one buffer, enforcing a size cap as chunks arrive.
async function collectByteStream(stream: ReadableStream<Uint8Array>, maxBytes: number)
    : Promise<Uint8Array> {
  let chunks: Uint8Array[] = [];
  let total = 0;
  let reader = stream.getReader();
  try {
    for (;;) {
      let { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("expected a byte stream");
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`packfile exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatBytes(chunks);
}
