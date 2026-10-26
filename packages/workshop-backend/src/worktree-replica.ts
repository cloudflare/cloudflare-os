import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { FileChangeByPath, WorktreeWriteback } from "@gadgets/workshop-shared/agent-integration";
import { codeChangeSerializedSize, validateCodeChangeSchema, type CodeChange }
  from "@gadgets/workshop-shared/code-change";
import type { WorktreeReplicaLease, WorktreeReplicaCommit } from "./storage-schema/overseer-storage";
export type { WorktreeReplicaLease, WorktreeReplicaCommit } from "./storage-schema/overseer-storage";

/** Kernel durability plumbing for a single command, not a second replication protocol. */
export interface WorktreeWritebackHost {
  lease(id: string, receiptOnly?: boolean): WorktreeReplicaLease;
  receipt(id: string): WorktreeReplicaCommit | undefined;
  flush(lease: WorktreeReplicaLease): Promise<boolean>;
  version(lease: WorktreeReplicaLease): string;
  assertPathWritable(lease: WorktreeReplicaLease, path: string): Promise<void>;
  commit(lease: WorktreeReplicaLease, version: string, change: CodeChange,
    receipt: WorktreeReplicaCommit): Promise<boolean>;
}

/** Private Git metadata and filesystem aliases are never worktree paths. */
export function requireReplicaPath(path: string): void {
  if (!path || path.length > 4096 || path.includes("\0") || path.includes("\\") ||
      path.split("/").some(part => !part || part === "." || part === ".." || part === ".git")) {
    throw new Error("Invalid worktree path.");
  }
}

/** The one-way writeback endpoint always re-enters the authoritative Durable Object. */
@validateRpc()
export class WorktreeWritebackSession extends RpcTarget implements Pick<WorktreeWriteback, "submitChanges"> {
  constructor(private host: WorktreeWritebackHost, private leaseId: string) { super(); }

  async submitChanges(batchId: string, changes: FileChangeByPath[], final: boolean): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(batchId) || changes.length > 128)
      throw new Error("Worktree batch exceeds its budget.");
    const lease = this.host.lease(this.leaseId, true);
    const change: CodeChange = changes.length
      ? {[lease.worktree.checkoutId]: changes.map(({path, change}) => [path, change])} : {};
    validateCodeChangeSchema(change);
    if (codeChangeSerializedSize(change) > 1024 * 1024)
      throw new Error("Worktree batch exceeds its budget.");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(JSON.stringify({changes, final})))).toHex();
    const id = `${this.leaseId}:${batchId}`;
    const accepted = () => {
      const prior = this.host.receipt(id);
      if (!prior) return false;
      if (prior.digest !== digest) throw new Error("Worktree batch ID was reused with a different payload.");
      if (!prior.final) this.host.lease(this.leaseId);
      return true; // Includes a lost final ACK: no new effect, authority, or shell execution.
    };
    if (accepted()) return;
    try {
      this.host.lease(this.leaseId);
      if (!await this.host.flush(lease) || this.host.version(lease) !== lease.version)
        throw new Error("Workspace changed during the container command; concurrent writers are not supported.");
      const seen = new Set<string>();
      for (const {path, change} of changes) {
        requireReplicaPath(path);
        if (seen.has(path)) throw new Error("Duplicate worktree path.");
        seen.add(path);
        if ("setBytes" in change) throw new Error("Binary writeback is not supported by this endpoint yet.");
        await this.host.assertPathWritable(lease, path);
      }
      this.host.lease(this.leaseId);
      if (!await this.host.commit(lease, lease.version, change, {id, leaseId: lease.id, digest, final}))
        throw new Error("Workspace changed during the container command; concurrent writers are not supported.");
    } catch (error) {
      // Concurrent retries may finish while this call awaits validation or the persistence queue.
      if (!accepted()) throw error;
    }
  }
}
