import type { RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { FileChange } from "./code-change";
import type { Cursor } from "./gatekeeper";
/** Ephemeral turn capability; only the participant, not this context, may be persisted. */
export interface AgentContext extends RpcTarget {
  /** Read opaque identity and current authority without exposing the user's identity. */
  getTurn(): Promise<AgentTurnInfo>;
  /**
   * Durably register one participant per connection and turn. Repeated registration is a no-op;
   * it does not replace the original participant or await its callback. The receiver must
   * initialize lazily when first used; registration does not send a started notification.
   */
  participate(participant: Fetcher<AgentTurnParticipant>): Promise<void>;
  /**
   * Acquire an expiring, revocable replica of the captured worktree selection. Requires a separate
   * trusted grant; never freezes ordinary DO operations. Unsupported deployments fail closed.
   */
  openWorktreeReplica(): Promise<Fetcher<WorkspaceReplica>>;
}

/** Identity of an existing durable execution, not a second workflow state machine. */
export interface AgentTurnInfo {
  /** Stable through decision pauses and Durable Object resets. */
  turnId: string;
  /** Opaque workspace-local chat identity, not a user or account ID. */
  chatId: string;
  /** Changes on resumption/reset; capabilities from earlier segments expire. */
  segmentId: string;
  /** Closing contexts authorize cleanup only, never new commands. */
  phase: "running" | "suspending" | "finishing";
}

/** Ordered, at-least-once notification; receivers must durably deduplicate eventId. */
export interface AgentTurnEvent {
  /** Retries retain the same persisted ID, including after a lost acknowledgement. */
  eventId: string;
  /** Original logical turn. */
  turnId: string;
  /** Segment which produced the event. */
  segmentId: string;
  /** Finished requests required cleanup before the logical turn can be released. */
  kind: "resumed" | "suspended" | "finished";
}

/** Persistent, account/workspace-bound Worker entrypoint supplied by a trusted integration. */
export interface AgentTurnParticipant extends WorkerEntrypoint {
  /**
   * For resumed/suspended, acknowledge durable receipt promptly; work proceeds independently
   * of inference. For finished, return only after required cleanup is complete: this is the
   * sole blocking lifecycle boundary, including on Stop. Delivery is retried after failure or
   * a lost reply. A delivery wait timeout does not cancel the receiver, so retries may overlap:
   * durably deduplicate and serialize/coalesce attempts for the same eventId.
   * Read the fresh context's phase before acting:
   * delayed notifications may already have cleanup-only authority.
   */
  onAgentTurnEvent(event: AgentTurnEvent, context: RpcStub<AgentContext>): Promise<void>;
}

/** Persistent kernel endpoint scoped by a durable, expiring replica grant and epoch. */
export interface WorkspaceReplica extends WorkerEntrypoint {
  /** Capture immutable bases and a consistent pending-transform overlay for granted mounts. */
  checkpoint(): Promise<WorkspaceCheckpoint>;
  /** Enumerate only this checkpoint's immutable base entries. */
  listBaseEntries(checkpointId: string, checkoutId: number): Promise<Cursor<WorktreeBaseEntry>>;
  /** Stream enumerated immutable base content without applying OTs; Gitlinks have no content. */
  readBaseFile(checkpointId: string, checkoutId: number, path: string): Promise<ReadableStream<Uint8Array>>;
  /**
   * Bootstrap-only raw PACK for the checkpoint's immutable repository commit, without DO caching.
   * Includes complete trees/blobs at depth one; native import must record that shallow boundary.
   */
  readGitPack(checkpointId: string, checkoutId: number): Promise<ReadableStream<Uint8Array>>;
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
    /** SHA-256 of acknowledged UTF-8 text; null denotes absence, not an empty file. */ baseHash: string | null;
    /** Frozen UTF-16 set/edit/remove OT; null captures an unchanged requested path. */ change: FileChange | null;
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
    /** SHA-256 of accepted UTF-8 text; null denotes absence. */ hash: string | null;
  }[];
}
