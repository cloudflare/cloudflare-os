import type { RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { FileChange } from "./code-change";
import type { BytesRef, ByteValue } from "./byte-change";
import type { ActionDescription, Cursor, GitCache } from "./gatekeeper";

/** Fresh capabilities supplied when applying an action after an arbitrary approval delay. */
export interface GatekeeperActionContext extends RpcTarget {
  /** The same provenance- and action-scoped Git cache that legacy applyAction receives. */
  getGitCache(): Promise<GitCache>;
  /** Originating logical turn, or null for non-agent actions; never a later unrelated turn. */
  getAgentContext(): Promise<AgentContext | null>;
  /**
   * Queue a further approval needed by this already-authorized action, using its original binding
   * and logical turn. Only awaited, recoverable contextual agent actions support this. Submission is
   * durably deduplicated by the gatekeeper's action ID and description; it grants no permission.
   * The context is ephemeral: after a reset, recovery redelivers the parent with a fresh context.
   */
  submitAction(action: number, description: ActionDescription): Promise<void>;
}

/** Ephemeral invocation context; only participant and replica capabilities may be persisted. */
export interface AgentContext extends RpcTarget {
  /** Read turn identity and execution phase without exposing user identity. */
  getTurn(): Promise<AgentTurnInfo>;
  /**
   * Register a persistent, binding-scoped callback. Registration and event retries are idempotent.
   * Lifecycle access must be granted independently by trusted deployment configuration.
   */
  participate(participant: Fetcher<AgentTurnParticipant>): Promise<void>;
  /**
   * Acquire an expiring, revocable replica of the captured worktree selection. Requires a separate
   * trusted grant; never freezes ordinary DO operations. Unsupported deployments fail closed.
   */
  openWorktreeReplica(): Promise<Fetcher<WorkspaceReplica>>;
}

/** One logical turn can suspend for approval and resume in a new invocation segment. */
export interface AgentTurnInfo {
  /** Stable opaque ID across resumptions; a new user request starts a different turn. */
  turnId: string;
  /** Opaque chat identity, not an account or cross-workspace lookup key. */
  chatId: string;
  /** Changes on each execution segment. */
  segmentId: string;
  /** Finishing/suspending contexts permit cleanup, not new user commands. */
  phase: "running" | "applyingAction" | "suspending" | "finishing";
}

/** Retry-safe, at-least-once lifecycle notification. */
export type AgentTurnEvent = {
  /** Persisted idempotency key; retries retain this ID. */
  eventId: string;
  /** Logical turn this event belongs to. */
  turnId: string;
  /** Segment this event belongs to. */
  segmentId: string;
} & (
  | { /** Entry or continuation, including late participant registration. */ kind: "started" | "resumed" }
  | { /** Temporary pause. */ kind: "suspended";
      /** Condition that must be resolved before the next segment. */ reason: "approval" | "connection" }
  | { /** Terminal turn disposition. */ kind: "finished";
      /** Completion or recovery outcome. */ reason: "completed" | "canceled" | "failed" | "abandoned" }
);

/** Persistent Worker entrypoint, reinstantiated with account/workspace-bound props. */
export interface AgentTurnParticipant extends WorkerEntrypoint {
  /** Awaited bounded notification with fresh context; cleanup must tolerate repeated event IDs. */
  onAgentTurnEvent(event: AgentTurnEvent, context: RpcStub<AgentContext>): Promise<void>;
}

/** Persistent kernel endpoint scoped by a durable, expiring replica grant and epoch. */
export interface WorkspaceReplica extends WorkerEntrypoint {
  /** Begin or resume raw-byte staging under this lease; does not mutate visible files. */
  beginUpload(uploadId: string, description: ByteUploadDescription): Promise<ByteUploadStatus>;
  /** Append/replay raw bytes at a durable offset; conflicting retries fail closed. */
  writeUpload(uploadId: string, offset: number, stream: ReadableStream<Uint8Array>): Promise<number>;
  /** Read a durable offset/finish receipt after eviction or a lost response. */
  getUploadStatus(uploadId: string): Promise<ByteUploadStatus>;
  /** Verify the frozen payload, publish its Git blob, and return the OID before any batch uses it. */
  finishUpload(uploadId: string): Promise<BytesRef>;
  /** Stream only references staged by this lease or visible in its selected canonical worktrees. */
  readBytes(ref: BytesRef, range?: {offset: number; length: number}): Promise<ReadableStream<Uint8Array>>;
  /** Resolve a byte-coordinate anchor at a consumed cursor; authority remains path/lease scoped. */
  readByteAnchor(checkoutId: number, path: string, cursor: string): Promise<{value: ByteValue | null; version: string | null}>;
  /** Capture immutable bases and a consistent pending-transform overlay for granted mounts. */
  checkpoint(): Promise<WorkspaceCheckpoint>;
  /** Enumerate only this checkpoint's immutable base entries. */
  listBaseEntries(checkpointId: string, checkoutId: number): Promise<Cursor<WorktreeBaseEntry>>;
  /** Stream enumerated immutable base content without applying OTs; Gitlinks have no content. */
  readBaseFile(checkpointId: string, checkoutId: number, path: string): Promise<ReadableStream<Uint8Array>>;
  /** Bootstrap-only, commit-scoped Git v2 fetch; streams the provider pack without caching it. */
  readGitPack(checkpointId: string, checkoutId: number, request: Uint8Array): Promise<ReadableStream<Uint8Array>>;
  /** Bootstrap-only pack of the captured local heads above the base; no arbitrary OID requests. */
  readCommitPack(checkpointId: string, checkoutId: number): Promise<ReadableStream<Uint8Array>>;
  /** Irreversibly close Git bootstrap for this lease before exposing the guest to agent commands. */
  closeGitBootstrap(checkpointId: string): Promise<void>;
  /** Enumerate pending transforms above the captured accepted commit, not a moving HEAD. */
  readOverlay(checkpointId: string): Promise<Cursor<WorktreeChange>>;
  /** Page canonical OTs. An invalidated epoch requires a new lease/checkpoint, never an empty success. */
  changesSince(cursor: string, limit: number): Promise<WorktreeChangesPage>;
  /** Validate anchors and scope, reconcile with existing OTs, and atomically persist a receipt. */
  submitBatch(batch: WorktreeReplicaBatch): Promise<WorktreeReplicaReceipt>;
  /** Renew within grant/turn bounds; cannot resurrect expired or revoked epochs. */
  renew(): Promise<void>;
  /** Fence future requests from this epoch without undoing already accepted transforms. */
  release(): Promise<void>;
}

/** Digest of the frozen upload, not of a mutable live source file. */
export interface ByteUploadDescription {
  /** Exact total bytes, with no arbitrary per-file cap. */
  byteLength: number;
  /** Lowercase SHA-256 of the complete payload. */
  sha256: string;
}

/** Durable staging receipt; finished references are immutable, but still confer no read authority. */
export interface ByteUploadStatus {
  /** Next durable append offset; retries may replay already stored matching bytes. */
  offset: number;
  /** Present only after complete length/digest verification. */
  finished?: BytesRef;
}

/** Consistent, scoped bootstrap anchor; required journal history is retained while its lease is live. */
export interface WorkspaceCheckpoint {
  /** Opaque checkpoint identity, not an arbitrary Git object capability. */
  checkpointId: string;
  /** Canonical cursor after all transforms included in this checkpoint. */
  cursor: string;
  /** Immutable bases; filesystem layout is the integration's policy. */
  worktrees: WorktreeBase[];
}

/** Metadata needed for materialization; excludes source credentials and unrelated grants. */
export interface WorktreeBase {
  /** Checkout identity meaningful only within the replica capability. */
  checkoutId: number;
  /** Agent-visible binding name. */
  binding: string;
  /** Immutable base commit, or null for an empty worktree. */
  baseCommit: string | null;
  /** Immutable root tree, or null for an empty worktree. */
  baseTree: string | null;
  /** Accepted content checkpoint, absent on legacy checkpoints; not necessarily explicit Git history. */
  acceptedCommit?: string | null;
  /** Last explicit Git commit, absent on legacy checkpoints; may differ from accepted content. */
  headCommit?: string | null;
  /** Source category; private source URLs and credentials are not exported. */
  source: "repository" | "attachments" | "gadget";
}

/** Immutable Git metadata, including modes whose mutations are unsupported in rev 0. */
export interface WorktreeBaseEntry {
  /** Normalized relative path excluding .git, traversal and aliases. */
  path: string;
  /** Regular, executable, symlink or Gitlink mode. */
  mode: "100644" | "100755" | "120000" | "160000";
  /** Provenance-scoped consistency identity, not a readable global-OID capability. */
  oid: string;
}

/** Existing canonical FileChange, not a second transform representation. */
export interface WorktreeChange {
  /** Checkout within the granted selection. */
  checkoutId: number;
  /** Normalized worktree-relative path. */
  path: string;
  /** Canonical set/edit/remove transform. */
  change: FileChange;
}

/** One ordered canonical transaction with echo provenance. */
export interface WorktreeChangeEvent {
  /** Opaque sequence marker, never a client wall-clock timestamp. */
  cursor: string;
  /** This replica's originating batch, absent for DO edits and other replicas' edits. */
  sourceBatchId?: string;
  /** Atomically accepted transforms, in canonical order. */
  changes: WorktreeChange[];
}

/** Bounded canonical stream page. */
export interface WorktreeChangesPage {
  /** Transactions in canonical order. */
  events: WorktreeChangeEvent[];
  /** Cursor after exactly these events, never after omitted transactions. */
  cursor: string;
  /** Whether additional transactions are immediately available. */
  hasMore: boolean;
}

/** Frozen, bounded text writes anchored to previously supplied canonical content. */
export interface WorktreeReplicaBatch {
  /** Unique bounded ID, durably bound to the lease epoch and payload digest. */
  batchId: string;
  /** Last fully consumed canonical stream cursor. */
  baseCursor: string;
  /** Replica-produced transforms, calculated by the integration rather than re-diffed in core. */
  files: {
    /** Checkout within the grant. */ checkoutId: number;
    /** Normalized relative path. */ path: string;
    /** Text SHA-256 or opaque byte-version identity; null denotes absence, not an empty file. */ baseHash: string | null;
    /** Frozen text/byte mutation; null captures an unchanged requested path. */ change: FileChange | null;
  }[];
}

/** Durable atomic acceptance; this receipt alone must not advance a replay cursor. */
export interface WorktreeReplicaReceipt {
  /** Accepted batch ID. */
  batchId: string;
  /** Acceptance marker, not a substitute for paginating changesSince(). */
  committedAt: string;
  /** Transforms from frozen local content to accepted canonical content. */
  corrections: WorktreeChange[];
  /** Accepted anchors for touched paths only. */
  accepted: {
    /** Granted checkout. */ checkoutId: number;
    /** Normalized touched path. */ path: string;
    /** Text SHA-256 or opaque byte-version identity; null denotes absence. */ hash: string | null;
    /** Byte postimage for updating the replica's metadata anchor without reading/hashing the file. */ bytes?: ByteValue;
  }[];
}
