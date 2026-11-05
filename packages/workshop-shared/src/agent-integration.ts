import type { RpcStub, RpcTarget } from "cloudflare:workers";
import type { FileChange } from "./code-change";
import type { GitOid } from "./gatekeeper";

/** Opaque position in the workspace's existing canonical OT stream. */
export type WorktreeRevision = string;

/** One transform in a worktree; paths never name private Git metadata. */
export interface FileChangeByPath {
  /** Normalized path relative to the worktree root. */
  path: string;
  /** Existing text OT, deletion, or whole-file Git-blob replacement. */
  change: FileChange;
}

/** Integration methods on a Worktree capability, independent of its host or recipient. */
export interface WorktreeIntegration extends RpcTarget {
  /** Open a persistable session for this worktree, not an agent-turn or command lease. */
  getSyncSession(): Promise<RpcStub<WorktreeSyncSession>>;
  /** Read-only Git protocol v2; the workspace chooses local and upstream object sources. */
  gitPull(request: Request): Promise<Response>;
}

/** A mounted replica's persistable return and subscription capability. */
export interface WorktreeSyncSession extends RpcTarget {
  /**
   * Join the ordered stream and await initial catch-up. Reconnect with the last applied
   * revision; an expired cursor supplies a fresh base and pending transforms instead.
   * A new subscription replaces this session's prior subscriber.
   */
  subscribe(subscriber: RpcStub<WorktreeSubscriber>, after?: WorktreeRevision): Promise<RpcStub<WorktreeSubscription>>;
  /**
   * Transform edits from baseRevision into canonical order, accepting the OTs and receipt
   * atomically. Identical retries return the original revision; ID/payload reuse rejects.
   * The gatekeeper awaits these ACKs and canonical application before completing exec().
   */
  submitChanges(batchId: string, baseRevision: WorktreeRevision,
    changes: FileChangeByPath[]): Promise<{revision: WorktreeRevision}>;
}

/** Persistable receiver; acknowledge only after applying and recording the update. */
export interface WorktreeSubscriber extends RpcTarget {
  /**
   * Establish the commit underlying the canonical file state, or advance that base at an
   * already-applied checkpoint. Git HEAD is discovered through gitPull's ordinary refs;
   * this file base need not equal HEAD and must not reset a live guest's files.
   */
  setBaseCommit(state: {revision: WorktreeRevision; head: GitOid | null;
    shallowCommit: GitOid | null}): Promise<void>;
  /** Ordered canonical OTs; the submitting replica recognizes its own batchId echo. */
  change(revision: WorktreeRevision, batchId: string, changes: FileChangeByPath[]): Promise<void>;
}

/** Explicit subscription lifetime, owned by the mounted integration rather than an agent turn. */
export interface WorktreeSubscription extends RpcTarget {
  /** Stop delivery. A stale handle cannot unsubscribe a replacement subscription. */
  unsubscribe(): Promise<void>;
}
