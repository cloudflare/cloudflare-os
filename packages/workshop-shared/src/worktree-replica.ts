// APIs for keeping a copy of a worktree's files outside the workspace, synced as Git trees.
//
// A worktree is a file tree, rooted at a Git commit, that an agent creates in a chat (for example
// by checking out a connected repository) and edits with its file tools. Some tools need those
// files on a real filesystem. The motivating case is a container gatekeeper that runs shell
// commands like `pnpm test` or `prettier --write .` against a repository, including the agent's
// not-yet-accepted edits. Such a gatekeeper keeps a *replica*: a copy of the worktree's files on
// its own disk, in a Git repository it owns.
//
// The workspace is always the source of truth. The replica syncs with it only at the edges of a
// command, and each sync is a Git tree:
// 1. The gatekeeper receives a Worktree stub (e.g. through a call like
//    `mountWorktree(env.REPO, "repo")`), calls its `getReplicator()`, and stores the
//    `WorktreeReplicator` it returns. The Worktree stub itself works only during the agent's code
//    execution that passed it, but the replicator is persistent, so the mount can outlast the
//    agent turn and Durable Object restarts. It clones the worktree with `gitPull()`, which native
//    Git reaches through gatekeeper-kit's `serveGitUploadPack()`.
// 2. Before running a command, it calls `snapshot()` with the ApprovalQueue of the gatekeeper
//    session the agent's code called it through, which ties the command to that code execution.
//    The workspace writes a Git tree of the worktree's current files, including uncommitted
//    edits, and returns its ID. If the replica's files already have that tree, they are in sync.
//    Otherwise the gatekeeper fetches the tree with `gitPull()` and updates its files to it.
// 3. After the command, it writes a tree of its files and submits it with `submit()`, along with
//    the same queue and the tree it started from. The tree becomes the worktree's content in the
//    chat, three-way merged with any edits made in the workspace meanwhile. If the resulting tree
//    differs from the submitted one, the gatekeeper updates its files to it.
//
// `snapshot()` and `submit()` work only while the queue's execution (an `executeCode` call) is
// running in the worktree's chat. The submitted edits become part of that execution's step: they
// are saved together with the step's transcript, and are lost with it if the step never
// completes (for example because the workspace restarted mid-command), so that an agent never
// resumes on top of a half-finished command. Background commands are not supported.
//
// Snapshot trees are hidden: neither the user nor the agent sees them. Since Git objects are
// content-addressed, two states match exactly when their tree IDs do.
//
// See docs/worktree-replicas.md for more detail, including what a container implementation must
// do to keep its replica correct.

import type { RpcStub, RpcTarget } from "cloudflare:workers";
import type { GitOid, ObservationAuthorizer, GitPullHints, GitPullTransfer } from "./gatekeeper";

/** The worktree's state: its current files, and its Git head. */
export interface WorktreeState {
  /**
   * A Git tree of the worktree's files: the chat's accepted content plus its uncommitted edits,
   * including edits made earlier in the current execution. Fetch it with
   * `WorktreeReplicator.gitPull()` (natively, `git fetch origin <tree>`) during the execution that
   * received it, and update the files to it from the tree they actually have, not the last tree synced (a
   * command cut off by a restart may have left them changed). docs/worktree-replicas.md gives the
   * Git commands.
   */
  tree: GitOid;

  /**
   * The worktree's Git head (its latest explicit commit). A replica's HEAD and index should point
   * here, not at `tree`, so that `git status` and `git diff` show the uncommitted changes, as the
   * workspace would.
   */
  head: GitOid;
}

/**
 * What a Worktree stub offers to gatekeepers that keep a replica of it, alongside the ordinary
 * file methods (readFile(), writeFile(), commit(), ...) on the same stub. (The agent's own
 * description of the Worktree API omits it, because agents don't need it; that omission is not a
 * security boundary.)
 */
export interface ReplicableWorktree extends RpcTarget {
  /**
   * The worktree's replicator, through which a gatekeeper keeps a replica of it. Like the file
   * methods, this works only while the agent's code execution that received the stub is running,
   * so call it when the stub is passed in.
   */
  getReplicator(): Promise<WorktreeReplicator>;
}

/**
 * A gatekeeper's lasting access to one worktree, for keeping a replica of it, from
 * `ReplicableWorktree.getReplicator()`. Passing a Worktree stub to a gatekeeper hands it this.
 * The stub is persistent, so store it along with the replica. Access ends when the worktree or
 * its chat is deleted.
 */
export interface WorktreeReplicator extends RpcTarget {
  /**
   * Write a Git tree of the worktree's current files and return it. Call this before each
   * command, and update the replica's files to it unless they already have its tree. If `head`
   * changed, fetch it too.
   *
   * `queue` is the ApprovalQueue that `Gatekeeper.startSession()` received for the session
   * through which the agent's code asked for the command. The call fails unless that session came
   * from the code execution now running in the worktree's chat. (It is typed by the queue's base
   * interface because workers-types can't map ApprovalQueue's generic `bindHook()` through a
   * stub: a stub of the full queue wouldn't be assignable to it.)
   */
  snapshot(queue: RpcStub<ObservationAuthorizer>): Promise<WorktreeState>;

  /**
   * Send the replica's files back to the workspace after a command, as the Git tree `tree`.
   * `tree` becomes the worktree's content in the chat, as a change made by the queue's
   * execution, and the user reviews it like the agent's other edits. `queue` is as for
   * `snapshot()`, and should be the same one.
   *
   * `base` is the tree the replica's files had before the command: a tree that `snapshot()` or
   * `submit()` returned during the queue's execution, or one this execution submitted (for a
   * replica that submits again before updating its files to a merged result). Other trees are
   * refused. If the worktree also changed since `base` (e.g. the agent's code wrote files while
   * the command ran), the two are three-way merged with `base` as the merge base, so name the
   * tree the files were actually at: an older one would merge its later changes in again.
   * Conflicting hunks get diff3-style conflict markers, a file deleted on one side and changed on
   * the other keeps the change, and a binary file changed on both sides keeps the command's
   * version; the agent is told which files conflicted. Returns the resulting state. Its tree
   * equals `tree` unless there were such concurrent edits, in which case update the replica's
   * files to it.
   *
   * `pack` is a Git packfile holding every object reachable from `tree` that isn't reachable
   * from `base`, and must not rely on objects outside itself (no thin packs); see
   * docs/worktree-replicas.md for the Git command. Files of any size are accepted.
   *
   * File modes are kept. The call fails if a changed entry is a symlink or a submodule, if
   * `tree` contains a `.git` entry, or if merging would make a path both a file and a directory;
   * in that case, take a new snapshot and run the command again. A submission that failed
   * applied nothing. Submissions to a worktree apply in the order they were made.
   *
   * Run one command at a time per checkout, from `snapshot()` through updating the files after
   * `submit()`: a snapshot's checkout would otherwise overwrite files another command is still
   * writing. Commands that run in parallel need separate checkouts. If the execution ends while
   * a command runs, stop the command and everything it started, since its edits can no longer be
   * submitted; the next snapshot's checkout restores the files.
   */
  submit(queue: RpcStub<ObservationAuthorizer>, base: GitOid, tree: GitOid,
         pack: ReadableStream<Uint8Array>): Promise<WorktreeState>;

  /**
   * The worktree's Git head (its latest explicit commit), which a clone checks out. Like
   * `gitPull()`, this works at any time, with no queue.
   */
  gitHead(): Promise<GitOid>;

  /**
   * Fetch the worktree's Git objects: a pack of `oids` and what they reach, leaving out what
   * `hints.haves` reach, as `Gatekeeper.gitPull()` returns one. Unlike `snapshot()`, this works at
   * any time. Native Git is served by gatekeeper-kit's `serveGitUploadPack()`, which translates
   * its smart-HTTP requests into calls to this and `gitHead()`.
   *
   * The repository has a single branch, whose head is `gitHead()`, including commits created in
   * the workspace that haven't been pushed anywhere. If the worktree came from a connected
   * repository, it is served as a shallow clone, with history cut off where it reaches commits
   * that repository has: the commit the worktree was created at, or a later one that was pushed
   * or merged in. Those commits' files are streamed from the repository's provider rather than
   * stored in the workspace. So `commitHistory` of kind `full` means the history down to that
   * cutoff, as a clone without `--depth` gets.
   *
   * A pull of commits only the workspace has always reaches exactly that cutoff, whatever
   * `commitHistory` asks for: a shallower request (e.g. `git clone --depth=1`) still gets all of
   * them, and a deeper one gets no more. Keeping the replica's shallow boundary at the cutoff lets
   * later fetches of older history be served whole by the connected repository. The transfer's
   * `shallowInfo()` reports the boundary the client got, as Git's `shallow-info` does.
   *
   * The trees returned by `snapshot()` and `submit()` can be fetched by ID during the execution
   * that received them; no other tree can. Fetch such trees on their own, from a
   * replica that holds some commit of the head's history (e.g. after the clone), passing that
   * commit in `haves`: the pack leaves out what its tree already has.
   *
   * Any commit in the head's history can be fetched, including history beyond the cutoff (e.g. a
   * build script running `git fetch --depth=1 origin <sha>`, or `git fetch --deepen=10`): such a
   * fetch is served by a connected repository that has the history, once it confirms the commit
   * is in it. Other commits are refused. So is a single fetch that needs both commits only the
   * workspace has and more history from a connected repository; fetching the current head first
   * avoids that.
   *
   * Filters may be ignored: the pack may hold more than they ask for.
   */
  gitPull(oids: GitOid[], hints: WorktreeGitPullHints): Promise<GitPullTransfer>;
}

/**
 * What `WorktreeReplicator.gitPull()` should send, as for `Gatekeeper.gitPull()`, less what only
 * the workspace's own cache uses: the type of the objects wanted (a native Git client doesn't
 * know it) and the object that referenced them.
 */
export type WorktreeGitPullHints = Omit<GitPullHints, "type" | "referencedBy">;
