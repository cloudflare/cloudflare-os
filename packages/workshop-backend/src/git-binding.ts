// The `env.GIT` binding: the RpcTarget behind the `Git` interface (worktree-binding.d.ts defines
// the agent-facing contract), present in every gadget's env and in the agent's executeCode env.
//
// Minted per loopback session by the overseer's binding-loopback dispatch (startGatekeeperSession,
// target type "git"). It grants nothing its callers couldn't already reach: reading a commit
// requires knowing its full id (never a guessable abbreviation; see
// WorkspaceGitCache.resolveCommitId), and writing only adds content-addressed objects to the
// workspace's git store, never moving anything that names a commit.
//
// Its worktrees are the same WorktreeSessionImpl the agent's worktree bindings use, over an
// InMemoryWorktree in place of the agent turn's state: uncommitted content lives in the session
// object and dies with it, while commit() writes through the workspace's GitStore like any other
// worktree commit, leaving the commit id as the only durable handle.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { CommitMetadata, CommitSignature, Git, Worktree } from "./worktree-binding";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { applyCodeChange, type FileChange } from "@gadgets/workshop-shared/code-change";
import type { CommitObject } from "isomorphic-git";

import type { WorkspaceGitCache } from "./git-cache";
import type { GitStore } from "./git-store";
import type { WorktreeTurnAccess } from "./agent";
import { WorktreeSessionImpl, type WorktreeRecordView, type WorktreeSessionHost }
  from "./worktree-session";

/** What the binding needs from the overseer: the workspace's git plumbing. */
export interface GitBindingHost {
  gitCache: WorkspaceGitCache;
  gitStore: GitStore;
}

// The WorktreeTurnAccess methods all take a worktree id, but an InMemoryWorktree is a single
// worktree with no registry record, so the id is meaningless: it only keys the one-entry change
// applyCodeChange takes.
const IN_MEMORY_WORKTREE_ID = 0;

/**
 * One in-memory worktree's state, supplying both halves a WorktreeSessionImpl resolves against:
 * the turn half (overlay, removals, buffered effects) and the host half (git plumbing, and the
 * head a registry record would otherwise hold). Changes apply immediately and commits advance the
 * head immediately -- there is no step barrier to buffer for. Like the agent turn's content, the
 * overlay and removal maps are replaced rather than mutated, so a session operation iterating one
 * across an await sees a consistent snapshot.
 */
class InMemoryWorktree implements WorktreeTurnAccess, WorktreeSessionHost {
  #head: string;
  #files = new Map<string, string>();  // replaced, never mutated
  #removed = new Set<string>();  // likewise

  constructor(readonly gitCache: WorkspaceGitCache, readonly gitStore: GitStore,
              private base: string) {
    this.#head = base;
  }

  // WorktreeSessionHost (beyond the git plumbing above)

  getWorktreeRecord(): WorktreeRecordView {
    return { headCommit: this.#head };
  }

  // WorktreeTurnAccess

  getBaseCommit(): string {
    return this.base;
  }

  getBufferedHead(): undefined {
    // Commits advance the head immediately (see getWorktreeRecord); nothing is ever buffered.
    return undefined;
  }

  getOverlayFiles(): ReadonlyMap<string, string> {
    return this.#files;
  }

  getRemovedPaths(): ReadonlySet<string> {
    return this.#removed;
  }

  async readFile(_worktreeId: unknown, path: string): Promise<string | undefined> {
    let existing = this.#files.get(path);
    if (existing !== undefined) return existing;
    if (this.#removed.has(path)) return undefined;
    let text = await this.gitCache.readFileAtCommitIfExists(this.base, path);
    // A concurrent call may have written or deleted the file while the read was in flight;
    // its change wins over the base text.
    if (this.#files.has(path)) return this.#files.get(path);
    if (this.#removed.has(path) || text === undefined) return undefined;
    // Fault the base text into the overlay, so a following edit applies against it.
    this.#files = new Map(this.#files).set(path, text);
    return text;
  }

  appendChange(_worktreeId: unknown, path: string, change: FileChange): void {
    let content = applyCodeChange(new Map([[IN_MEMORY_WORKTREE_ID, this.#files]]),
                                  { [IN_MEMORY_WORKTREE_ID]: [[path, change]] });
    this.#files = content.get(IN_MEMORY_WORKTREE_ID)!;
    let removed = new Set(this.#removed);
    if ("remove" in change) {
      removed.add(path);
    } else {
      removed.delete(path);
    }
    this.#removed = removed;
  }

  appendCommit(_worktreeId: unknown, commit: string): void {
    this.#head = commit;
  }
}

/** The `env.GIT` binding. */
@validateRpc()
export class GitImpl extends RpcTarget implements Git {
  /**
   * `author` resolves the identity commits are attributed to, matching how the caller's commits
   * through the agent's own worktree bindings would be. Called only when a worktree commits.
   */
  constructor(private host: GitBindingHost, private author: () => Promise<AiChatAuthorInfo>) {
    super();
  }

  async newWorktree(commitId: string): Promise<Worktree> {
    let base = await this.host.gitCache.fetchCommit(commitId);
    let worktree = new InMemoryWorktree(this.host.gitCache, this.host.gitStore, base);
    return new WorktreeSessionImpl(worktree, IN_MEMORY_WORKTREE_ID, worktree, this.author);
  }

  async readCommit(commitId: string): Promise<CommitMetadata> {
    let oid = this.host.gitCache.resolveCommitId(commitId);
    // Pulls only the commit object itself, if absent -- unlike newWorktree, which wants the tree.
    await this.host.gitCache.ensureObject(oid, { type: "commit" });
    let commit = await this.host.gitStore.readCommitObject(oid);
    return {
      parents: commit.parent,
      message: commit.message,
      author: toSignature(commit.author),
      committer: toSignature(commit.committer),
    };
  }
}

function toSignature(person: CommitObject["author"]): CommitSignature {
  return {
    name: person.name,
    email: person.email,
    timestamp: new Date(person.timestamp * 1000),
    // isomorphic-git follows Date.getTimezoneOffset(): minutes *behind* UTC. (`|| 0` avoids -0.)
    utcOffsetMinutes: -person.timezoneOffset || 0,
  };
}
