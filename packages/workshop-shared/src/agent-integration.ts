import type { WorkerEntrypoint } from "cloudflare:workers";
import type { FileChange } from "./code-change";

/** One worktree's frozen contents and command-scoped, write-only return capability. */
export interface WorktreeExport {
  /** Opaque identity of this command export, also used to recover a lost mount reply. */
  id: string;
  /** Agent-visible name of the exported worktree. */
  binding: string;
  /**
   * Command-scoped smart HTTP. Send the canonical /info/refs or /git-upload-pack request
   * with x-workshop-git-binding naming a captured repository binding. Credentials stay upstream.
   */
  git?: Fetcher;
  /** Authorized remotes; source marks the mounted worktree's origin, when available. */
  gitRepositories?: CommandGitRepository[];
  /** Commit to check out after importing packs; null for an empty worktree. */
  head: string | null;
  /** Raw, shallow Git pack readers. Fetch each once, in order, when preparing the command. */
  packs: Fetcher[];
  /** Uncommitted transforms above head, captured once at export time. */
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
   * Concurrent DO edits are unsupported and may be overwritten, not merged or sent back.
   */
  submitChanges(batchId: string, changes: FileChangeByPath[], final: boolean): Promise<void>;
}
