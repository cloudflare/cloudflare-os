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
//    `mountWorktree(env.REPO, "repo")`) and stores it. The stub is persistent, so the mount can
//    outlast the agent turn and Durable Object restarts. It clones the worktree with `gitPull()`,
//    which native Git reaches through gatekeeper-kit's `serveGitUploadPack()`.
// 2. Before running a command, it calls `snapshot()`. The workspace writes a Git tree of the
//    worktree's current files, including uncommitted edits, and returns its ID along with a
//    handle for this command. If the replica's files already have that tree, they are in sync.
//    Otherwise the gatekeeper fetches the tree with `gitPull()` and updates its files to it.
// 3. After the command, it writes a tree of its files and submits it through the handle. The tree
//    becomes the worktree's content in the chat, three-way merged with any edits made in the
//    workspace meanwhile. If the resulting tree differs from the submitted one, the gatekeeper
//    updates its files to it.
//
// `snapshot()` works only while an agent's code execution (an `executeCode` call) is running in
// the worktree's chat, and the handle only until that execution ends. The submitted edits become
// part of that execution's step: they are saved together with the step's transcript, and are lost
// with it if the step never completes (for example because the workspace restarted mid-command),
// so that an agent never resumes on top of a half-finished command. Background commands are not
// supported.
//
// Snapshot trees are hidden: neither the user nor the agent sees them. Since Git objects are
// content-addressed, two states match exactly when their tree IDs do.
//
// See docs/worktree-replicas.md for more detail, including what a container implementation must
// do to keep its replica correct.

import type { RpcTarget } from "cloudflare:workers";
import type { GitOid, GitPullHints, GitPullTransfer } from "./gatekeeper";

/** The worktree's state: its current files, and its Git head. */
export interface WorktreeState {
  /**
   * A Git tree of the worktree's files: the chat's accepted content plus its uncommitted edits,
   * including edits made earlier in the current execution. Fetch it with
   * `ReplicableWorktree.gitPull()` (natively, `git fetch origin <tree>`) during the execution that
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

/** The worktree's state before a command, from `ReplicableWorktree.snapshot()`. */
export interface WorktreeSnapshot extends WorktreeState {
  /** The handle through which this command's result is submitted (a stub, once received). */
  command: WorktreeCommand;
}

/**
 * One command's handle, from `ReplicableWorktree.snapshot()`. It lives in memory, bound to the
 * agent's code execution that was running when the snapshot was taken: it stops working when that
 * execution ends, and a workspace restart breaks it. If that happens while a command runs, stop
 * the command and everything it started, since its edits can no longer be submitted; the next
 * snapshot's checkout restores the files.
 *
 * Run one command at a time per checkout, from `snapshot()` through updating the files after
 * `submit()`: a snapshot's checkout would otherwise overwrite files another command is still
 * writing. Commands that run in parallel need separate checkouts.
 */
export interface WorktreeCommand extends RpcTarget {
  /**
   * Send the replica's files back to the workspace after the command, as the Git tree `tree`.
   * `tree` becomes the worktree's content in the chat, as a change made by the running execution,
   * and the user reviews it like the agent's other edits. If the worktree also changed since the
   * snapshot (e.g. the agent's code wrote files while the command ran), the two are three-way
   * merged with the snapshot's tree as the base. Conflicting hunks get diff3-style conflict
   * markers, a file deleted on one side and changed on the other keeps the change, and a binary
   * file changed on both sides keeps the command's version; the agent is told which files
   * conflicted. Returns the resulting state. Its tree equals `tree` unless there were such
   * concurrent edits, in which case update the replica's files to it.
   *
   * `pack` is a Git packfile holding every object reachable from `tree` that isn't reachable
   * from the snapshot's tree, and must not rely on objects outside itself (no thin packs); see
   * docs/worktree-replicas.md for the Git command. Files of any size are accepted.
   *
   * File modes are kept. The call fails if a changed entry is a symlink or a submodule, if
   * `tree` contains a `.git` entry, or if merging would make a path both a file and a directory;
   * in that case, take a new snapshot and run the command again.
   *
   * A handle accepts one submission. Calling again with the same `tree` (e.g. after a lost reply)
   * returns the first result without applying anything twice; a different `tree` is refused. A
   * submission that failed applied nothing, and may be retried.
   */
  submit(tree: GitOid, pack: ReadableStream<Uint8Array>): Promise<WorktreeState>;
}

/**
 * Methods a Worktree stub offers to gatekeepers that keep a replica of it. These sit alongside
 * the ordinary file methods (readFile(), writeFile(), commit(), ...) on the same stub.
 *
 * Unlike the file methods, which work only while the agent's code execution that received the
 * stub is running, these keep working afterwards: passing a Worktree stub to a gatekeeper hands
 * it lasting access to that one worktree. The stub is persistent, so store it along with the
 * replica. Access ends when the worktree or its chat is deleted. (The agent's own description of
 * the Worktree API omits these methods, because agents don't need them; that omission is not a
 * security boundary.)
 */
export interface ReplicableWorktree extends RpcTarget {
  /**
   * Write a Git tree of the worktree's current files and return it, with a handle for submitting
   * the command's result (see `WorktreeSnapshot`). Call this before each command, and update the
   * replica's files to the snapshot unless they already have its tree. If `head` changed, fetch
   * it too.
   *
   * Fails unless an agent's code execution is running in the worktree's chat.
   */
  snapshot(): Promise<WorktreeSnapshot>;

  /**
   * The worktree's Git head (its latest explicit commit), which a clone checks out. Like
   * `gitPull()`, this works at any time.
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
   * The trees returned by `snapshot()` and `WorktreeCommand.submit()` can be fetched by ID during
   * the execution that received them; no other tree can. Fetch such trees on their own, from a
   * replica that holds some commit of the head's history (e.g. after the clone), passing that
   * commit in `haves`: the pack leaves out what its tree already has.
   *
   * Passing a Worktree stub permits fetching any commit in its head's history, including history
   * beyond the cutoff (e.g. a build script running `git fetch --depth=1 origin <sha>`, or
   * `git fetch --deepen=10`): such a fetch is served by a connected repository that has the
   * history, once it confirms the commit is in it. Other commits are refused. So is a single
   * fetch that needs both commits only the workspace has and more history from a connected
   * repository; fetching the current head first avoids that. (A clone deeper than the cutoff is
   * given less history instead.)
   *
   * Filters may be ignored: the pack may hold more than they ask for.
   */
  gitPull(oids: GitOid[], hints: WorktreeGitPullHints): Promise<GitPullTransfer>;
}

/**
 * What `ReplicableWorktree.gitPull()` should send, as for `Gatekeeper.gitPull()`, less what only
 * the workspace's own cache uses: the type of the objects wanted (a native Git client doesn't
 * know it) and the object that referenced them.
 */
export type WorktreeGitPullHints = Omit<GitPullHints, "type" | "referencedBy">;
