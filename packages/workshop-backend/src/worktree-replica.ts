import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { Cursor } from "@gadgets/workshop-shared/gatekeeper";
import type { WorktreeBaseEntry, WorktreeChange, WorktreeChangesPage,
  WorktreeReplicaBatch, WorktreeReplicaReceipt, WorkspaceCheckpoint, WorkspaceReplica }
  from "@gadgets/workshop-shared/agent-integration";
import { applyCodeChange, composeCodeChange, codeChangeSerializedSize, type CodeChange }
  from "@gadgets/workshop-shared/code-change";
import { mergeReplicaBatch, replicaTextHash, type ReplicaBatch } from "./workspace-replica";

import type { WorktreeReplicaLease, WorktreeReplicaCommit } from "./storage-schema/overseer-storage";
export type { WorktreeReplicaLease, WorktreeReplicaCommit } from "./storage-schema/overseer-storage";

/** Kernel storage/OT plumbing, not a parallel RPC interface. */
export interface WorktreeReplicaHost {
  requireLease(id: string): WorktreeReplicaLease;
  saveLease(lease: WorktreeReplicaLease): void;
  capture(lease: WorktreeReplicaLease): Promise<{ cursor: string; overlay: WorktreeChange[]; pendingOverlay?: WorktreeChange[] }>;
  entries(lease: WorktreeReplicaLease, checkoutId: number): Promise<WorktreeBaseEntry[]>;
  baseFile(lease: WorktreeReplicaLease, checkoutId: number, path: string): Promise<Uint8Array>;
  /** Read one anchor from the captured accepted commit, without flattening its cumulative OTs. */
  anchorFile?(lease: WorktreeReplicaLease, checkoutId: number, path: string): Promise<string | null>;
  /** Reuse ordinary file-tool checks against the immutable tree, including directory entries. */
  assertPathWritable(lease: WorktreeReplicaLease, checkoutId: number, path: string): Promise<void>;
  /** Fetch only a lease-selected immutable repository commit, without storing its blobs. */
  gitPack?(lease: WorktreeReplicaLease, checkoutId: number, request: Uint8Array): Promise<ReadableStream<Uint8Array>>;
  /** Export only local commit identities captured by this checkpoint. */
  commitPack?(lease: WorktreeReplicaLease, checkoutId: number): Promise<ReadableStream<Uint8Array>>;
  events(lease: WorktreeReplicaLease, cursor: string, limit: number): WorktreeChangesPage;
  /** Publish buffered DO operations through the ordinary step barrier before reconciliation. */
  flush(lease: WorktreeReplicaLease): Promise<boolean>;
  version(lease: WorktreeReplicaLease): string;
  getCommit(id: string): WorktreeReplicaCommit | undefined;
  commit(lease: WorktreeReplicaLease, version: string, change: CodeChange,
    receipt: WorktreeReplicaCommit): Promise<boolean>;
}

/** Filesystem aliases/private Git metadata must never become OID-store capabilities. */
export function requireReplicaPath(path: string): void {
  if (!path || path.length > 4096 || path.includes("\0") || path.includes("\\") ||
      path.split("/").some(part => !part || part === "." || part === ".." || part === ".git")) {
    throw new Error("Invalid replica path.");
  }
}

/** Fresh native session behind the persistent, lease-scoped entrypoint. */
@validateRpc()
export class WorktreeReplicaSession extends RpcTarget implements Pick<WorkspaceReplica,
  "checkpoint" | "listBaseEntries" | "readBaseFile" | "readOverlay" | "changesSince" |
  "readGitPack" | "readCommitPack" | "closeGitBootstrap" | "submitBatch" | "renew" | "release"> {
  constructor(private host: WorktreeReplicaHost, private leaseId: string) { super(); }

  async checkpoint(): Promise<WorkspaceCheckpoint> {
    let lease = this.host.requireLease(this.leaseId);
    if (!lease.checkpoint) {
      const captured = await this.host.capture(lease);
      // Capture awaits source pulls. Revocation/expiry must still win at the publication barrier.
      lease = this.host.requireLease(this.leaseId);
      lease.checkpoint ??= { checkpointId: crypto.randomUUID(), cursor: captured.cursor,
        worktrees: lease.worktrees, overlay: captured.overlay, pendingOverlay: captured.pendingOverlay };
      this.host.saveLease(lease);
    }
    const { overlay: _overlay, pendingOverlay: _pendingOverlay, ...checkpoint } = lease.checkpoint;
    return checkpoint;
  }

  async listBaseEntries(checkpointId: string, checkoutId: number): Promise<Cursor<WorktreeBaseEntry>> {
    const lease = this.#checkpoint(checkpointId, checkoutId);
    const entries = await this.host.entries(lease, checkoutId);
    this.host.requireLease(this.leaseId);
    return new ReplicaCursor(entries, () => this.host.requireLease(this.leaseId));
  }

  async readBaseFile(checkpointId: string, checkoutId: number, path: string): Promise<ReadableStream<Uint8Array>> {
    requireReplicaPath(path);
    const lease = this.#checkpoint(checkpointId, checkoutId);
    const bytes = await this.host.baseFile(lease, checkoutId, path);
    this.host.requireLease(this.leaseId);
    // One bounded blob per request; no whole-repository content in an RPC return value.
    return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  }

  async readOverlay(checkpointId: string): Promise<Cursor<WorktreeChange>> {
    const lease = this.#checkpoint(checkpointId);
    return new ReplicaCursor(lease.checkpoint!.pendingOverlay ?? lease.checkpoint!.overlay,
      () => this.host.requireLease(this.leaseId));
  }

  async readCommitPack(checkpointId: string, checkoutId: number): Promise<ReadableStream<Uint8Array>> {
    const lease = this.#checkpoint(checkpointId, checkoutId);
    if (lease.gitBootstrapClosed) throw new Error("Git bootstrap is closed.");
    if (!this.host.commitPack) throw new Error("Local commit export is unsupported.");
    return this.host.commitPack(lease, checkoutId);
  }

  async readGitPack(checkpointId: string, checkoutId: number, request: Uint8Array): Promise<ReadableStream<Uint8Array>> {
    const lease = this.#checkpoint(checkpointId, checkoutId);
    if (lease.gitBootstrapClosed || request.byteLength > 64 * 1024 ||
        lease.worktrees.find(tree => tree.checkoutId === checkoutId)?.source !== "repository") {
      throw new Error("Git bootstrap is closed or outside the granted repository.");
    }
    if (!this.host.gitPack) throw new Error("This repository source does not support native Git hydration.");
    const stream = await this.host.gitPack(lease, checkoutId, request);
    try {
      if (this.host.requireLease(this.leaseId).gitBootstrapClosed) throw new Error("Git bootstrap was revoked.");
    } catch (error) {
      await stream.cancel().catch(() => {});
      throw error;
    }
    return stream;
  }

  async closeGitBootstrap(checkpointId: string): Promise<void> {
    const lease = this.#checkpoint(checkpointId);
    lease.gitBootstrapClosed = true;
    this.host.saveLease(lease);
  }

  async changesSince(cursor: string, limit: number): Promise<WorktreeChangesPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error("Invalid replica page limit.");
    const lease = this.host.requireLease(this.leaseId);
    if (!lease.checkpoint) throw new Error("Replica needs a checkpoint.");
    return this.host.events(lease, cursor, limit);
  }

  async submitBatch(batch: WorktreeReplicaBatch): Promise<WorktreeReplicaReceipt> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(batch.batchId) || batch.files.length > 128 ||
        JSON.stringify(batch).length > 1024 * 1024) throw new Error("Replica batch exceeds its budget.");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(JSON.stringify(batch)))).toHex();
    const commitId = `${this.leaseId}:${batch.batchId}`;
    for (let retry = 0; retry < 8; ++retry) {
      const lease = this.host.requireLease(this.leaseId);
      const prior = this.host.getCommit(commitId);
      if (prior) {
        if (prior.digest !== digest) throw new Error("Replica batch ID was reused with a different payload.");
        return prior.receipt;
      }
      if (!lease.checkpoint) throw new Error("Replica needs a checkpoint.");
      if (!await this.host.flush(lease)) continue;
      const version = this.host.version(lease);
      const remote = this.#changes(lease, batch.baseCursor, batch.files);
      const seen = new Set<string>();
      let change: CodeChange = {};
      const receipt: WorktreeReplicaReceipt = { batchId: batch.batchId, committedAt: crypto.randomUUID(),
        corrections: [], accepted: [] };
      for (const tree of lease.worktrees) {
        const files = batch.files.filter(file => file.checkoutId === tree.checkoutId);
        const anchored: ReplicaBatch["files"] = [];
        for (const file of files) {
          requireReplicaPath(file.path);
          const key = `${file.checkoutId}:${file.path}`;
          if (seen.has(key)) throw new Error("Duplicate replica path.");
          seen.add(key);
          await this.host.assertPathWritable(lease, file.checkoutId, file.path);
          // Reconstruct exactly the anchor the caller claims, never trust a supplied 'before'.
          const anchor = await this.#anchor(lease, file.checkoutId, file.path, batch.baseCursor);
          if (await replicaTextHash(anchor) !== file.baseHash)
            throw new Error("Replica anchor does not match the consumed canonical cursor.");
          anchored.push({path: file.path, before: anchor, change: file.change});
        }
        if (!files.length) continue;
        const merged = await mergeReplicaBatch(tree.checkoutId, { batchId: batch.batchId, files: anchored },
          remote[tree.checkoutId] ? {[tree.checkoutId]: remote[tree.checkoutId]} : {});
        change = composeCodeChange(change, merged.change);
        receipt.corrections.push(...merged.ack.changes.map(([path, correction]) => ({ checkoutId: tree.checkoutId, path, change: correction })));
        for (const [path, content] of merged.ack.accepted)
          receipt.accepted.push({checkoutId: tree.checkoutId, path, hash: await replicaTextHash(content)});
      }
      if (seen.size !== batch.files.length) throw new Error("Replica batch names an ungranted checkout.");
      if (codeChangeSerializedSize(change) > 1024 * 1024) throw new Error("Replica OT transaction exceeds its budget.");
      // A tiny incoming OT can need large canonical corrections. Bound the durable receipt too,
      // before entering the step barrier; a storage-size failure there would poison later writes.
      // Reuse the conservative V8 OT estimate and allow ample framing for each receipt object.
      const receiptBytes = 512 + 2 * (commitId.length + lease.id.length + digest.length +
          receipt.batchId.length + receipt.committedAt.length) +
        receipt.accepted.reduce((bytes, file) => bytes + 128 + 2 * (file.path.length + (file.hash?.length ?? 0)), 0) +
        receipt.corrections.reduce((bytes, file) => bytes + 128 +
          codeChangeSerializedSize({[file.checkoutId]: [[file.path, file.change]]}), 0);
      if (receiptBytes > 1024 * 1024) {
        throw new Error("Replica receipt exceeds its budget; consume canonical changes or submit fewer paths.");
      }
      this.host.requireLease(this.leaseId);
      if (await this.host.commit(lease, version, change, { id: commitId, leaseId: lease.id, digest, receipt })) return receipt;
    }
    throw new Error("Workspace kept changing during replica reconciliation; retry the same batch.");
  }

  async renew(): Promise<void> {
    const lease = this.host.requireLease(this.leaseId);
    this.host.saveLease({ ...lease, expiresAt: Date.now() + 60_000 });
  }
  async release(): Promise<void> {
    const lease = this.host.requireLease(this.leaseId);
    this.host.saveLease({ ...lease, released: true });
  }

  #checkpoint(checkpointId: string, checkoutId?: number): WorktreeReplicaLease {
    const lease = this.host.requireLease(this.leaseId);
    if (lease.checkpoint?.checkpointId !== checkpointId) throw new Error("Unknown replica checkpoint.");
    if (checkoutId !== undefined && !lease.worktrees.some(tree => tree.checkoutId === checkoutId)) {
      throw new Error("Checkout is outside this replica grant.");
    }
    return lease;
  }

  async #anchor(lease: WorktreeReplicaLease, checkoutId: number, path: string, cursor: string): Promise<string | null> {
    if (this.host.anchorFile && lease.checkpoint!.pendingOverlay !== undefined) {
      const text = await this.host.anchorFile(lease, checkoutId, path);
      let content = new Map([[checkoutId, new Map(text === null ? [] : [[path, text]])]]);
      for (const item of lease.checkpoint!.pendingOverlay) if (item.checkoutId === checkoutId && item.path === path) {
        content = applyCodeChange(content, {[checkoutId]: [[path, item.change]]});
      }
      content = applyCodeChange(content, this.#changes(lease, lease.checkpoint!.cursor,
        [{checkoutId, path}], cursor));
      return content.get(checkoutId)?.get(path) ?? null;
    }
    // Legacy checkpoints and hosts retain the original upstream-anchored operations.
    let bytes: Uint8Array;
    try { bytes = await this.host.baseFile(lease, checkoutId, path); }
    catch (error) {
      // Absence is determined by tree metadata, not by swallowing authorization/pull errors.
      if ((await this.host.entries(lease, checkoutId)).some(entry => entry.path === path)) throw error;
      bytes = new Uint8Array();
    }
    const exists = (await this.host.entries(lease, checkoutId)).some(entry => entry.path === path);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("Replica mutations of binary files are unsupported.");
    let content = new Map([[checkoutId, new Map(exists ? [[path, text]] : [])]]);
    const apply = (changes: WorktreeChange[]) => {
      for (const item of changes) if (item.checkoutId === checkoutId && item.path === path) {
        content = applyCodeChange(content, { [checkoutId]: [[path, item.change]] });
      }
    };
    apply(lease.checkpoint!.overlay);
    content = applyCodeChange(content, this.#changes(lease, lease.checkpoint!.cursor,
      [{checkoutId, path}], cursor));
    return content.get(checkoutId)?.get(path) ?? null;
  }

  #changes(lease: WorktreeReplicaLease, from: string,
      paths: Pick<WorktreeChange, "checkoutId" | "path">[], through?: string): CodeChange {
    const selected = new Set(paths.map(item => `${item.checkoutId}:${item.path}`));
    let change: CodeChange = {}, position = from;
    while (position !== through) {
      const page = this.host.events(lease, position, 128);
      for (const event of page.events) {
        for (const item of event.changes) if (selected.has(`${item.checkoutId}:${item.path}`)) {
          change = composeCodeChange(change, {[item.checkoutId]: [[item.path, item.change]]});
        }
        position = event.cursor;
        if (position === through) return change;
      }
      if (!page.hasMore) {
        if (through !== undefined) throw new Error("Unknown replica anchor cursor.");
        return change;
      }
      if (!page.events.length) throw new Error("Replica journal made no progress.");
    }
    return change;
  }
}

@validateRpc()
class ReplicaCursor<T extends WorktreeBaseEntry | WorktreeChange> extends RpcTarget implements Cursor<T> {
  #index = 0;
  constructor(private items: T[], private requireLive: () => unknown) { super(); }
  async next(): Promise<T[] | null> {
    this.requireLive();
    if (this.#index >= this.items.length) return null;
    const page = this.items.slice(this.#index, this.#index + 128);
    this.#index += page.length;
    return page;
  }
}
