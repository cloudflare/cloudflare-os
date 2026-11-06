// APIs for keeping a copy of a worktree's files in sync outside the workspace.
//
// A worktree is a file tree, rooted at a Git commit, that an agent creates in a chat (for example
// by checking out a connected repository) and edits with its file tools. Some tools need those
// files on a real filesystem. The motivating case is a container gatekeeper that runs shell
// commands like `pnpm test` against a repository, including the agent's not-yet-accepted edits.
// Such a gatekeeper keeps a *replica*: a complete copy of the worktree's files on its own disk.
// While commands run, the replica stays in sync in both directions. Edits made in the workspace
// (by the agent or a user) flow into the replica, and files a command changes flow back into the
// workspace as ordinary chat edits.
//
// The workspace is always the source of truth. Its view of a worktree has two parts:
// - The *base commit*: the worktree's content as of the chat's last accept. (A new worktree's
//   base is the commit it was created at.)
// - The chat's *uncommitted changes* on top of that base: the same ordered stream of file edits
//   the Workshop UI shows, and that accepting the chat's changes commits. A position in this
//   stream is a `WorktreeRevision`. Edits are operational transforms (OTs; see `FileChange`), so
//   edits made concurrently in different places can be merged instead of overwriting each other.
//
// A replica typically works like this:
// 1. The gatekeeper receives a Worktree stub (e.g. through a call like
//    `mountWorktree(env.REPO, "repo")`) and calls `getSyncSession()` on it.
// 2. It calls `subscribe()`, passing its own `WorktreeSubscriber`. The workspace first tells the
//    subscriber the base commit (`setBaseCommit()`). The subscriber fetches that commit by
//    running native Git against `gitPull()`, which speaks Git's smart-HTTP protocol, and writes
//    its files to disk. The workspace then sends every pending uncommitted change (`change()`),
//    which the subscriber applies on top, and from then on sends each new change as it happens.
//    `subscribe()` returns once the subscriber has caught up.
// 3. When a command changes local files, it sends the edits with `submitChanges()`. The workspace
//    merges them into the stream and then delivers them back to the subscriber, like any other
//    change, so that every party sees the same order of edits.
//
// All of these objects are persistent RPC stubs (see `ctx.restore()`): either side can store
// them and keep using them after its Durable Object restarts. Access is scoped to one worktree.
// It does not depend on an agent turn being in progress, and lasts until the worktree's chat is
// deleted or the connection the worktree came from is removed.
//
// See docs/agent-worktree-replicas.md for more detail, including what a container
// implementation must do to keep its replica correct.

import type { RpcStub, RpcTarget } from "cloudflare:workers";
import type { BytesRef, FileChange } from "./code-change";
import type { GitOid } from "./gatekeeper";

/**
 * A position in the worktree's chat's stream of uncommitted changes: "everything up to and
 * including this change". Each `change()` delivery carries the revision it brings the replica
 * to, and `submitChanges()` takes the revision the replica's edits were made against.
 *
 * Treat it as an opaque string: compare revisions only for equality, and store the latest one
 * your replica has applied so you can resume from it with `subscribe(subscriber, after)`.
 * Revisions are per chat, not per worktree, so the stream also advances for edits that touched
 * only other workpieces in the chat.
 */
export type WorktreeRevision = string;

/** An edit to one file of a worktree. */
export interface FileChangeByPath {
  /**
   * The file's path relative to the worktree root, using "/" separators, e.g. "src/index.ts".
   * Must not contain empty, "." or ".." segments, and must not point into the `.git` directory:
   * a replica's Git metadata is its own and never syncs.
   */
  path: string;

  /**
   * What happens to the file: a text edit (an OT against its current text), a deletion, or
   * replacement of its whole content -- as text, or as a reference to a Git blob for binary
   * content. See `FileChange` for details.
   */
  change: FileChange;
}

/**
 * Methods a Worktree stub offers to gatekeepers that need to keep a replica of it. These sit
 * alongside the ordinary file methods (readFile(), writeFile(), commit(), ...) on the same stub.
 *
 * Unlike the file methods, which work only while the agent's code execution that received the
 * stub is running, these keep working after it ends: passing a Worktree stub to a gatekeeper
 * hands it lasting access to that one worktree. (The agent's own description of the Worktree
 * API omits these methods, because agents don't need them; that omission is not a security
 * boundary.)
 */
export interface WorktreeIntegration extends RpcTarget {
  /**
   * Create a new sync session: the handle a replica uses to receive and submit changes. The
   * returned stub is persistent, so store it along with the replica. Each call creates an
   * independent session; use one session per replica.
   */
  getSyncSession(): Promise<RpcStub<WorktreeSyncSession>>;

  /**
   * Fetch the worktree's Git objects, using Git's smart-HTTP protocol (version 2, read-only).
   * The intended client is native Git: point a remote at a made-up URL, forward the requests
   * `git fetch` makes to this method, and pass the responses back unchanged. Each request's URL
   * path must be exactly `/info/refs?service=git-upload-pack` (GET) or `/git-upload-pack`
   * (POST), so strip the made-up remote's own path first; the host is ignored. Requests must
   * carry the `Git-Protocol: version=2` header.
   *
   * The repository has a single branch, whose head (HEAD) is the worktree's latest commit,
   * including commits created in the workspace that haven't been pushed anywhere. If the
   * worktree came from a connected repository, it is served as a shallow clone, with history
   * cut off at the commit the worktree was created at. That head can differ from the base commit given to `setBaseCommit()`, just
   * as a Git checkout's working files can differ from HEAD. The base commit and the Git blobs
   * referenced by delivered changes can be fetched by object ID too. When the worktree came from
   * a connected repository, its files are streamed from that repository's provider rather than
   * stored in the workspace, and a fetch of other commits by ID (e.g. a build script running
   * `git fetch --depth=1 origin <sha>`) is forwarded to that provider.
   */
  gitPull(request: Request): Promise<Response>;
}

/**
 * One replica's connection to a worktree, from `WorktreeIntegration.getSyncSession()`. Use it to
 * receive the workspace's changes (`subscribe()`) and to send the replica's own edits back
 * (`submitChanges()`).
 */
export interface WorktreeSyncSession extends RpcTarget {
  /**
   * Store a whole-file raw payload in the workspace Git store (at most 8,000,000 bytes).
   * Returns the immutable blob reference for a later `setBytes` change; this call alone does
   * not change any file. Identical bytes return the same reference, so a lost reply is safe
   * to retry. This capability shares the session's worktree scope and reset/revocation rules.
   */
  putBlob(bytes: Uint8Array): Promise<BytesRef>;

  /**
   * Start receiving the worktree's changes through `subscriber`. Resolves once the subscriber
   * has caught up -- it has received and acknowledged everything up to the current revision --
   * so a replica can wait for this before running a command.
   *
   * On a fresh start (no `after`), the subscriber first receives `setBaseCommit()` and then a
   * single `change()` holding all of the chat's pending edits to this worktree. Delivery then
   * continues with each new change, in order, for as long as the subscription lasts.
   *
   * To resume after a disconnect or restart, pass the last revision the replica applied as
   * `after`: delivery resumes with the changes after it. If the workspace can no longer replay
   * from that point -- e.g. the chat's changes were reverted or discarded -- you get a fresh
   * start instead. The workspace never resets your files itself: first retry any submissions
   * whose results you never saw (so you know which of your edits it has), then reconcile your
   * local files with the fresh state. If this happens while already subscribed, deliveries stop
   * and `submitChanges()` fails with a "cursor expired" error; subscribe again to recover.
   *
   * A session has at most one subscriber; subscribing again replaces the previous one.
   */
  subscribe(subscriber: RpcStub<WorktreeSubscriber>, after?: WorktreeRevision): Promise<RpcStub<WorktreeSubscription>>;

  /**
   * Send edits made to the replica's files back to the workspace, where they become ordinary
   * chat edits, attributed to the user whose agent turn provided the Worktree stub.
   *
   * `baseRevision` is the last revision the replica had applied when the edits were made. If
   * other changes have been accepted since then, the workspace transforms these edits over
   * them before accepting them -- just as concurrent edits by two users in the Workshop editor
   * are merged. The returned revision is where the edits landed in the stream. The subscriber
   * will also receive them as a `change()` delivery carrying the same `batchId`, so the replica
   * can recognize its own edits rather than apply them twice.
   *
   * `batchId` is a unique ID of the replica's choosing (1-64 characters: letters, digits, "_",
   * "-") that makes this call safe to retry. If the response is lost, call again with the same
   * arguments: if the batch was already accepted, you get its original revision back and
   * nothing is applied twice. Reusing a `batchId` with different arguments is an error.
   *
   * A batch may touch at most 128 files and 1 MiB of serialized edits. Before referencing a
   * new Git blob with `setBytes`, store it with `putBlob()`.
   */
  submitChanges(batchId: string, baseRevision: WorktreeRevision,
    changes: FileChangeByPath[]): Promise<{revision: WorktreeRevision}>;
}

/**
 * Implemented by the replica, and passed to `WorktreeSyncSession.subscribe()`: the callbacks
 * through which the workspace delivers the worktree's base commit and changes.
 *
 * Deliveries arrive one at a time, in order: the workspace waits for each call to return
 * before making the next, so a slow replica is never flooded. Return only after the update is
 * applied and the new revision is recorded durably, because returning is what acknowledges it.
 * If a call throws, or its acknowledgment is lost (e.g. the workspace restarted), the workspace
 * retries the same delivery later, so applying an update you already applied must be harmless.
 *
 * Must be a persistent stub (see `ctx.restore()`), since the workspace stores it to continue
 * delivery after a restart.
 */
export interface WorktreeSubscriber extends RpcTarget {
  /**
   * Sets the commit that the chat's uncommitted changes apply on top of.
   *
   * On a fresh start, this is the first call, before any changes: fetch `head` with
   * `WorktreeIntegration.gitPull()` and use its files as the starting point. Later calls
   * happen when the base moves without the files changing -- typically when the user accepts
   * the chat's changes, which turns the pending edits into a new commit. By then the replica's
   * files already include those edits, so update your record of the base, but do not reset any
   * files.
   *
   * - `revision`: the revision the base applies at. Later changes are relative to it.
   * - `head`: the base commit, or null if there is none.
   * - `shallowCommit`: when the worktree came from a connected repository, the commit it was
   *   created at, beyond which history is not available (as in a shallow clone); null when the
   *   worktree's whole history is stored in the workspace.
   */
  setBaseCommit(state: {revision: WorktreeRevision; head: GitOid | null;
    shallowCommit: GitOid | null}): Promise<void>;

  /**
   * Delivers the next change to the worktree's files, bringing the replica to `revision`.
   * `changes` may be empty: revisions count every change in the chat, including ones that
   * touched only other workpieces.
   *
   * `batchId` identifies where the change came from. For a batch this session submitted with
   * `submitChanges()`, it is that batch's ID: the replica already has these edits locally, so
   * reconcile rather than apply them twice. Other changes have IDs the workspace generates,
   * which never collide with valid submitted batch IDs.
   */
  change(revision: WorktreeRevision, batchId: string, changes: FileChangeByPath[]): Promise<void>;
}

/** A handle to an active subscription, from `WorktreeSyncSession.subscribe()`. */
export interface WorktreeSubscription extends RpcTarget {
  /**
   * Stop delivering changes to this subscription's subscriber. Does nothing if the session has
   * since been subscribed again: an old handle can never cancel a newer subscription.
   */
  unsubscribe(): Promise<void>;
}
