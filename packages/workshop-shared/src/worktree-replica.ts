// APIs for keeping a copy of a worktree's files outside the workspace.
//
// A worktree is a file tree, rooted at a Git commit, that an agent creates in a chat (for example
// by checking out a connected repository) and edits with its file tools. Some tools need those
// files on a real filesystem. The motivating case is a container gatekeeper that runs shell
// commands like `pnpm test` against a repository. Such a gatekeeper keeps a *replica*: a copy of
// the worktree's files on its own disk, in a Git repository it owns.
//
// The gatekeeper receives a Worktree stub (e.g. through a call like
// `mountWorktree(env.REPO, "repo")`). It clones the worktree, and later fetches its new commits,
// by running native Git against `gitPull()`.
//
// For now a replica is read-only, and only sees the worktree's commits: the chat's uncommitted
// edits don't reach it, and files a command changes don't flow back into the workspace.
//
// See docs/worktree-replicas.md for more detail.

import type { RpcTarget } from "cloudflare:workers";

/**
 * Methods a Worktree stub offers to gatekeepers that keep a replica of it. These sit alongside the
 * ordinary file methods (readFile(), writeFile(), commit(), ...) on the same stub.
 *
 * Access is scoped to one worktree, and ends when the worktree or its chat is deleted. The stub
 * the agent's code passes on is tied to its code execution, though: once that execution ends,
 * calls through it fail, so a gatekeeper must fetch while handling the call that passed it.
 * (The agent's own description of the Worktree API omits these methods, because agents don't
 * need them; that omission is not a security boundary.)
 */
export interface ReplicableWorktree extends RpcTarget {
  /**
   * Fetch the worktree's Git objects, using Git's smart-HTTP protocol (version 2, read-only).
   * The intended client is native Git: point a remote at a made-up URL, forward the requests
   * `git fetch` makes to this method, and pass the responses back unchanged. Each request's URL
   * path must be exactly `/info/refs?service=git-upload-pack` (GET) or `/git-upload-pack`
   * (POST), so strip the made-up remote's own path first; the host is ignored. Requests must
   * carry the `Git-Protocol: version=2` header. Use `git clone`.
   *
   * The repository has a single branch, whose head (HEAD) is the worktree's Git head (its latest
   * explicit commit), including commits created in the workspace that haven't been pushed
   * anywhere. If the worktree came from a connected repository, it is served as a shallow clone,
   * with history cut off at the commit the worktree was created at. Its files are streamed from
   * that repository's provider rather than stored in the workspace.
   *
   * Passing a Worktree stub permits fetching any commit in its head's history, including
   * history beyond the shallow cutoff (e.g. a build script running
   * `git fetch --depth=1 origin <sha>`, or `git fetch --deepen=10`): such a fetch is served by
   * a connected repository that has the history, once it confirms the commit is in it. Other
   * refs and commits are refused. So is a single fetch that needs both commits only the
   * workspace has and history only a connected repository has; fetching the current head first
   * avoids that.
   */
  gitPull(request: Request): Promise<Response>;
}
