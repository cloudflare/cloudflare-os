import type { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { FileChange } from "./code-change";

/** Ephemeral context of an explicitly granted integration in the original agent session. */
export interface AgentContext extends RpcTarget {
  /** Read this session's identity; throws after the session expires or access is revoked. */
  getTurn(): Promise<AgentTurnInfo>;
  /**
   * Capture one agent-visible worktree for a command. Import the raw Git packs in order,
   * check out head, then apply pendingChanges. No subsequent DO changes are delivered.
   */
  mountWorktree(binding: string): Promise<WorktreeMount>;
}

/** Identity of the existing agent execution, not a separate lifecycle subscription. */
export interface AgentTurnInfo {
  /** Stable through approval pauses and Durable Object resets. */
  turnId: string;
  /** Opaque workspace-local chat identity. */
  chatId: string;
  /** Changes on resumption; contexts from earlier invocations expire. */
  segmentId: string;
  /** Only a live agent session may start a command. */
  phase: "running";
}

/** One worktree's frozen contents and command-scoped, write-only return capability. */
export interface WorktreeMount {
  /**
   * Command-scoped smart HTTP. Send the canonical /info/refs or /git-upload-pack request
   * with x-workshop-git-binding naming a captured repository binding. Credentials stay upstream.
   */
  git?: Fetcher;
  /** Authorized remotes; source marks the mounted worktree's origin, when available. */
  gitRepositories?: CommandGitRepository[];
  /** Commit to check out after importing packs; null for an empty worktree. */
  head: string | null;
  /** Raw, shallow Git packs, including source objects and any DO-local commits. */
  packs: ReadableStream<Uint8Array>[];
  /** Uncommitted transforms above head, captured once at mount time. */
  pendingChanges: FileChangeByPath[];
  /** Persistable capability for this command only; never reused by a later command. */
  writeback: Fetcher<WorktreeWriteback>;
}

/** A connected repository available to this command, without credentials. */
export interface CommandGitRepository {
  /** Original agent-visible repository binding name. */
  binding: string;
  /** Canonical HTTPS clone URL; used only to route guest Git requests to the binding. */
  url: string;
  /** Whether this repository provided the mounted worktree. */
  source: boolean;
}

/** An existing file transform scoped to the mounted worktree, not an alternate OT format. */
export interface FileChangeByPath {
  /** Normalized, worktree-relative path excluding private Git metadata. */
  path: string;
  /** Lightweight text OT, deletion, or supported whole-file replacement. */
  change: FileChange;
}

/** Command-scoped return path; no reads, polling, renewal, or multi-master reconciliation. */
export interface WorktreeWriteback extends WorkerEntrypoint {
  /**
   * Durably accept an ordered batch. Retry a lost reply with the identical ID and payload.
   * final closes write authority atomically with the batch. Completion must await its ACK.
   * Concurrent DO edits fail explicitly rather than being merged or sent to the container.
   */
  submitChanges(batchId: string, changes: FileChangeByPath[], final: boolean): Promise<void>;
}
