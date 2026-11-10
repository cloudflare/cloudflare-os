// The kernel side of worktree replicas (workshop-shared/worktree-replica.ts): snapshots of a
// worktree's current files as Git trees, and the command handles that submit a replica's tree
// back. A submission becomes part of the running execution's step as a re-root of the worktree's
// chat pin (WorktreeTurnAccess.reRoot), at a hidden commit of the submitted tree, three-way
// merged with whatever the execution changed in the worktree since the snapshot. So it is saved
// with the step's transcript, or lost with it.
//
// One WorktreeReplicas serves one code execution (see OverseerImpl.executeCodeMode), and keeps
// everything in memory: the trees the execution handed out (the only trees gitPull serves by
// ID), the paths its submissions merged with conflicts (named in the executeCode result), and
// each worktree's queue of submissions. A snapshot tree is stored like any other Git object and
// nothing else records it; one no submission builds on is garbage for a future collection.
//
// A gatekeeper reaches these through a WorktreeReplicatorImpl, which outlives executions: it is
// restored from a persistent stub, and serves whichever execution is running in the chat.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { AiChatAuthorInfo, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { GitOid, GitPullTransfer } from "@gadgets/workshop-shared/gatekeeper";
import type {
  WorktreeCommand, WorktreeGitPullHints, WorktreeReplicator, WorktreeSnapshot, WorktreeState,
} from "@gadgets/workshop-shared/worktree-replica";
import type { WorktreeTurnAccess } from "./agent";
import {
  commitIdentityForAuthor, TreeShapeError, UnreadableContentError, type FileEntry,
} from "./git-cache";
import { encodeGitTree, parseGitTree, validateGitOid, type GitTreeEntry } from "./git-codec";
import { threeWayMerge } from "./three-way-merge";
import { worktreeChanges, type WorktreeSessionHost } from "./worktree-session";

/** A file entry on one side of a tree diff, with the tree holding it (for pull hints). */
type DiffEntry = FileEntry & { referencedBy: GitOid };

/** One file path that differs between two trees: its entry on each side, absent where none. */
type DiffChange = { from?: DiffEntry, to?: DiffEntry };

/** The replica state of one code execution; see the module doc. */
export class WorktreeReplicas {
  #trees = new Map<WorkpieceId, Set<GitOid>>();
  #queues = new Map<WorkpieceId, Promise<unknown>>();

  /** The paths each worktree's submissions merged with conflicts. */
  readonly conflicts = new Map<WorkpieceId, Set<string>>();

  /**
   * `turn` is the execution's worktree state, `isLive` says whether the execution is still the
   * running one, and `author` is who the hidden commits are attributed to.
   */
  constructor(private host: WorktreeSessionHost, private turn: WorktreeTurnAccess,
              private isLive: () => boolean, private author: AiChatAuthorInfo) {}

  /** The trees handed out for the worktree, which gitPull serves by ID. */
  fetchableTrees(worktreeId: WorkpieceId): ReadonlySet<GitOid> {
    return this.#trees.get(worktreeId) ?? new Set();
  }

  /** Throws unless the execution is still the running one. */
  requireLive(): void {
    if (!this.isLive()) {
      throw new Error("The code execution this command belongs to has ended.");
    }
  }

  /** `WorktreeReplicator.snapshot()`. */
  async snapshot(worktreeId: WorkpieceId): Promise<WorktreeSnapshot> {
    this.requireLive();
    let { tree } = await this.#currentTree(worktreeId);
    this.requireLive();
    return { ...this.#state(worktreeId, tree),
             command: new WorktreeCommandImpl(this, worktreeId, tree) };
  }

  /** `WorktreeCommand.submit()` for a snapshot of `from`, run after the worktree's earlier ones. */
  submit(worktreeId: WorkpieceId, from: GitOid, tree: GitOid, pack: ReadableStream<Uint8Array>)
      : Promise<WorktreeState> {
    let result = (this.#queues.get(worktreeId) ?? Promise.resolve()).catch(() => {})
        .then(() => this.#submit(worktreeId, from, tree, pack));
    this.#queues.set(worktreeId, result);
    return result;
  }

  async #submit(worktreeId: WorkpieceId, from: GitOid, tree: GitOid,
                pack: ReadableStream<Uint8Array>): Promise<WorktreeState> {
    validateGitOid(tree);
    this.requireLive();
    let packed = new Set(await this.host.gitCache.consumePackFromGatekeeper(null, pack, true));
    this.requireLive();
    let submitted = await this.#diff(from, tree, packed);
    for (;;) {
      let current = await this.#currentTree(worktreeId);
      let result = current.tree === from ? { tree, conflicts: [] }
          : await this.#merge(from, tree, submitted, current.tree);
      let commit = result.tree === current.tree ? undefined
          : this.host.gitCache.writeCommitForTree(result.tree, {
            parents: [current.base], author: commitIdentityForAuthor(this.author),
            message: "Command result", timestamp: new Date(),
          });

      // From here to the return, nothing awaits, so nothing can change the turn in between. The
      // execution may have ended meanwhile, and its code may have changed the worktree: then
      // merge again, with the new current files.
      this.requireLive();
      if (this.turn.getRevision(worktreeId) !== current.revision ||
          this.turn.getBaseCommit(worktreeId) !== current.base) {
        continue;
      }
      if (commit !== undefined) this.turn.reRoot(worktreeId, commit);
      if (result.conflicts.length > 0) {
        let paths = this.conflicts.get(worktreeId) ?? new Set();
        for (let path of result.conflicts) paths.add(path);
        this.conflicts.set(worktreeId, paths);
      }
      return this.#state(worktreeId, result.tree);
    }
  }

  // The tree of the worktree's current files, written to the Git store, with the base and
  // revision it was built at.
  async #currentTree(worktreeId: WorkpieceId)
      : Promise<{ base: string, revision: number, tree: GitOid }> {
    let base = this.turn.getBaseCommit(worktreeId);
    if (base === undefined) throw new Error("This worktree is not part of the current session.");
    let revision = this.turn.getRevision(worktreeId);
    let tree = await this.host.gitCache.writeChangedTree(
        base, worktreeChanges(this.turn, worktreeId));
    return { base, revision, tree };
  }

  // Hands out `tree` as the worktree's state, so gitPull serves it.
  #state(worktreeId: WorkpieceId, tree: GitOid): WorktreeState {
    let trees = this.#trees.get(worktreeId) ?? new Set();
    this.#trees.set(worktreeId, trees.add(tree));
    return { tree, head: this.turn.getBufferedHead(worktreeId)
        ?? this.host.getWorktreeRecord(worktreeId).headCommit };
  }

  // Merges the submitted tree, which changed `submitted` from `from`, with `current`, the
  // worktree's files now: three-way, with `from` as the base, on just the paths both changed.
  // The result builds on the submitted tree, so where only it changed nothing needs writing.
  async #merge(from: GitOid, tree: GitOid, submitted: Map<string, DiffChange>, current: GitOid)
      : Promise<{ tree: GitOid, conflicts: string[] }> {
    let changes = new Map<string, FileEntry | null>();
    let conflicts: string[] = [];
    let sides = [new Map<string, string>(), new Map<string, string>(), new Map<string, string>()];
    let texts: { path: string, mode: FileEntry["mode"] }[] = [];
    for (let [path, ours] of await this.#diff(from, current)) {
      let theirs = submitted.get(path);
      if (theirs === undefined) {
        changes.set(path, ours.to ? fileEntry(ours.to) : null);
        continue;
      }
      if (theirs.to?.oid === ours.to?.oid && theirs.to?.mode === ours.to?.mode) continue;
      let kept = theirs.to ?? ours.to!;
      if ((theirs.to === undefined || ours.to === undefined) && kept.oid === ours.from?.oid) {
        // One side deleted the file and the other changed only its mode, which the text merge
        // can't see: keep the change, as against any deletion.
        changes.set(path, fileEntry(kept));
        conflicts.push(path);
        continue;
      }
      // A mode merges on its own: one side's change of it survives the other's edit.
      let mode = theirs.to?.mode === ours.from?.mode ? ours.to?.mode ?? theirs.to?.mode
          : theirs.to?.mode ?? ours.to!.mode;
      let versions = await Promise.all(
          [ours.from, ours.to, theirs.to].map(entry => this.#readText(entry, path)));
      if (versions.includes(null)) {
        // Binary: the command's version, unless it deleted what the workspace changed.
        changes.set(path, { mode: mode!, oid: (theirs.to ?? ours.to)!.oid });
        conflicts.push(path);
        continue;
      }
      versions.forEach((text, side) => { if (text !== undefined) sides[side].set(path, text!); });
      texts.push({ path, mode: mode! });
    }
    let merged = threeWayMerge(sides[0], sides[1], sides[2],
                               { base: "snapshot", ours: "workspace", theirs: "command" });
    for (let { path, mode } of texts) {
      let text = merged.files.get(path);
      let blob = text === undefined ? undefined
          : this.host.gitCache.writeBlob(new TextEncoder().encode(text));
      changes.set(path, blob === undefined ? null : { mode, oid: blob.oid });
    }
    conflicts.push(...merged.conflictPaths);
    try {
      // Deletions first, so that a file the workspace replaced with a directory, or a directory
      // with a file, is gone before its replacement is written.
      let deletions = new Map([...changes].filter(([, entry]) => entry === null));
      let deleted = await this.host.gitCache.writeChangedTreeOf(tree, deletions);
      let writes = new Map([...changes].filter(([, entry]) => entry !== null));
      return { tree: await this.host.gitCache.writeChangedTreeOf(deleted, writes), conflicts };
    } catch (error) {
      if (!(error instanceof TreeShapeError)) throw error;
      throw new Error("The command's result can't be merged with the worktree's concurrent " +
          "edits: it would make a path both a file and a directory. Take a new snapshot and run " +
          "the command again.", { cause: error });
    }
  }

  // A file's text, undefined if absent, or null if it is not readable as text.
  async #readText(entry: DiffEntry | undefined, path: string): Promise<string | undefined | null> {
    if (entry === undefined) return undefined;
    try {
      return await this.host.gitCache.readTextBlob(entry.oid, entry.referencedBy, path);
    } catch (error) {
      if (error instanceof UnreadableContentError) return null;
      throw error;
    }
  }

  // The file paths that differ between trees `a` and `b`, descending only into subtrees that
  // differ, and faulting in trees the store lacks, as reads do. A changed symlink or submodule is
  // refused, as the file tools refuse them, and so is a `.git` entry in `b`. If `packed` is
  // given, `b` is a submitted tree and `packed` the objects its pack held: each object `b` has
  // that `a` lacks at the same path must be one of them, or else reachable from `a` (e.g. a file
  // the command moved). The workspace holds other worktrees' objects too, so a submission
  // naming one is refused, or it would hand the submitter that object's content.
  async #diff(a: GitOid, b: GitOid, packed?: ReadonlySet<GitOid>)
      : Promise<Map<string, DiffChange>> {
    let submitted = packed !== undefined;
    let changes = new Map<string, DiffChange>();
    let cache = this.host.gitCache;
    let missing = new Set<GitOid>();
    // Read only if the pack leaves something out, which needs every tree of `a`.
    let reachable: Promise<Set<GitOid>> | undefined;
    let require = async (oid: GitOid) => {
      if (packed?.has(oid) || (await (reachable ??= this.#treeObjects(a))).has(oid)) return;
      throw new Error(
          `The submitted tree refers to ${oid}, which is neither in its pack nor in the snapshot.`);
    };
    let entries = async (oid: GitOid | undefined, referencedBy: GitOid | undefined,
                         checked: boolean) => {
      if (oid === undefined) return new Map<string, GitTreeEntry>();
      if (checked) await require(oid);
      let tree = await cache.ensureObject(
          oid, { type: "tree", ...(referencedBy && { referencedBy }), eagerTree: true });
      let parsed = parseGitTree(tree.payload, oid);
      // A tree from a pack must be well formed: no entry names a tree can't hold (`..`, `a/b`),
      // and nothing else that writing its entries again wouldn't reproduce.
      if (checked && !canonicalTree(parsed, tree.payload)) {
        throw new Error(`The submitted tree ${oid} is malformed.`);
      }
      return new Map(parsed.map(entry => [entry.name, entry]));
    };
    let walk = async (aTree: GitOid | undefined, bTree: GitOid | undefined, prefix: string,
                      aRef?: GitOid, bRef?: GitOid): Promise<void> => {
      if (aTree === bTree) return;
      let before = await entries(aTree, aRef, false);
      let after = await entries(bTree, bRef, submitted);
      for (let name of new Set([...before.keys(), ...after.keys()])) {
        let x = before.get(name), y = after.get(name);
        if (x?.oid === y?.oid && x?.mode === y?.mode) continue;
        let path = prefix + name;
        if (y !== undefined && name.toLowerCase() === ".git") {
          throw new Error(`${path}: a worktree can't hold a .git entry.`);
        }
        for (let entry of [x, y]) {
          if (entry?.mode === "120000" || entry?.mode === "160000") {
            throw new Error(`${path}: symlinks and submodules in a worktree can't be changed.`);
          }
        }
        let dir = (entry: typeof x) => entry?.mode === "40000" ? entry.oid : undefined;
        if (dir(x) !== undefined || dir(y) !== undefined) {
          await walk(dir(x), dir(y), `${path}/`, aTree, bTree);
        }
        let file = (entry: typeof x, tree: GitOid | undefined): DiffEntry | undefined =>
            entry?.mode === "100644" || entry?.mode === "100755"
                ? { mode: entry.mode, oid: entry.oid, referencedBy: tree! } : undefined;
        let change = { from: file(x, aTree), to: file(y, bTree) };
        if (change.from === undefined && change.to === undefined) continue;
        if (submitted && change.to !== undefined) {
          await require(change.to.oid);
          // A stored blob's type is checked without reading it (blobSize throws for another
          // type); the rest, from the snapshot, are pulled together below.
          if (cache.blobSize(change.to.oid) === undefined) missing.add(change.to.oid);
        }
        changes.set(path, change);
      }
    };
    await walk(a, b, "");
    await cache.ensureBlobs(missing);
    return changes;
  }

  // Every object reachable from tree `root`, reading only trees.
  async #treeObjects(root: GitOid): Promise<Set<GitOid>> {
    let objects = new Set([root]);
    let stack: { oid: GitOid, referencedBy?: GitOid }[] = [{ oid: root }];
    while (stack.length > 0) {
      let { oid, referencedBy } = stack.pop()!;
      let tree = await this.host.gitCache.ensureObject(
          oid, { type: "tree", ...(referencedBy && { referencedBy }), eagerTree: true });
      for (let entry of parseGitTree(tree.payload, oid)) {
        if (entry.mode === "160000" || objects.has(entry.oid)) continue;
        objects.add(entry.oid);
        if (entry.mode === "40000") stack.push({ oid: entry.oid, referencedBy: oid });
      }
    }
    return objects;
  }
}

// Whether `payload` is the tree git itself would write for `entries`.
function canonicalTree(entries: GitTreeEntry[], payload: Uint8Array): boolean {
  let encoded: Uint8Array;
  try {
    encoded = encodeGitTree(entries);
  } catch {
    return false;
  }
  return encoded.length === payload.length && encoded.every((byte, i) => byte === payload[i]);
}

// A diff entry as the entry a merged tree is written with.
function fileEntry({ mode, oid }: DiffEntry): FileEntry {
  return { mode, oid };
}

/**
 * What a WorktreeReplicator needs from the overseer, whose methods throw once the worktree is
 * deleted. Structurally satisfied by OverseerImpl.
 */
export interface WorktreeReplicatorHost {
  worktreeSnapshot(worktreeId: WorkpieceId): Promise<WorktreeSnapshot>;
  worktreeGitHead(worktreeId: WorkpieceId): GitOid;
  worktreeGitPull(worktreeId: WorkpieceId, oids: GitOid[],
                  hints: WorktreeGitPullHints): Promise<GitPullTransfer>;
}

/**
 * `WorktreeReplicator`: a gatekeeper's lasting replica access to a worktree, restored
 * from persistent stubs (see ReplicableWorktree.getReplicator()).
 */
@validateRpc()
export class WorktreeReplicatorImpl extends RpcTarget implements WorktreeReplicator {
  constructor(private host: WorktreeReplicatorHost, private worktreeId: WorkpieceId) {
    super();
  }

  async snapshot(): Promise<WorktreeSnapshot> {
    return this.host.worktreeSnapshot(this.worktreeId);
  }

  async gitHead(): Promise<GitOid> {
    return this.host.worktreeGitHead(this.worktreeId);
  }

  async gitPull(oids: GitOid[], hints: WorktreeGitPullHints): Promise<GitPullTransfer> {
    return this.host.worktreeGitPull(this.worktreeId, oids, hints);
  }
}

/** `WorktreeCommand`: one snapshot's handle; see the interface doc. */
@validateRpc()
class WorktreeCommandImpl extends RpcTarget implements WorktreeCommand {
  #submission?: { tree: GitOid, result: Promise<WorktreeState> };

  constructor(private replicas: WorktreeReplicas, private worktreeId: WorkpieceId,
              private from: GitOid) {
    super();
  }

  async submit(tree: GitOid, pack: ReadableStream<Uint8Array>): Promise<WorktreeState> {
    this.replicas.requireLive();
    let submission = this.#submission;
    if (submission !== undefined) {
      await pack.cancel();
      if (submission.tree !== tree) {
        throw new Error("This command's result was already submitted. Take a new snapshot " +
            "for another command.");
      }
      return await submission.result;
    }
    submission = { tree, result: this.replicas.submit(this.worktreeId, this.from, tree, pack) };
    this.#submission = submission;
    try {
      return await submission.result;
    } catch (error) {
      // A failed submission installed nothing, so the handle may be used again.
      if (this.#submission === submission) this.#submission = undefined;
      throw error;
    }
  }
}
