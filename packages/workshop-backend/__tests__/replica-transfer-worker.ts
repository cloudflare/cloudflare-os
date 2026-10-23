import { DurableObject } from "cloudflare:workers";
import type { WorkspaceReplica, WorktreeBaseEntry } from "@gadgets/workshop-shared/agent-integration";

/** Independent raw-binary RPC consumer; Linux framing is tested in the integration, not the kernel. */
export class TestReplicaTransfer extends DurableObject {
  async transfer(replica: Fetcher<WorkspaceReplica>, failAt?: number, execDelayMs = 0) {
    const started = performance.now();
    const checkpoint = await replica.checkpoint();
    const files: (WorktreeBaseEntry & { bytes: number; verified: boolean })[] = [];
    let active = 0, maxActive = 0;
    let slowestFile = { path: "", elapsedMs: 0, renewMs: 0, readMs: 0, copyMs: 0 };
    let renewedAt = 0;
    // Match the runner's lease heartbeat, rather than adding a durable write for every blob.
    const renew = async () => {
      if (Date.now() - renewedAt < 20_000) return;
      await replica.renew();
      renewedAt = Date.now();
    };
    try {
      for (const tree of checkpoint.worktrees) {
        using entries = await replica.listBaseEntries(checkpoint.checkpointId, tree.checkoutId);
        for (;;) {
          const page = await entries.next();
          if (page === null) break;
          for (const entry of page) {
            const fileStarted = performance.now();
            await renew();
            const renewed = performance.now();
            const source = await replica.readBaseFile(checkpoint.checkpointId, tree.checkoutId, entry.path);
            const opened = performance.now();
            const copy = async () => {
              // Live guest dispatch is slow: the returned RPC stream must survive this gap.
              if (execDelayMs) await new Promise(resolve => setTimeout(resolve, execDelayMs));
              ++active;
              maxActive = Math.max(maxActive, active);
              const chunks: Uint8Array[] = [];
              try {
                await source.pipeTo(new WritableStream<Uint8Array>({
                  async write(chunk) {
                    if (files.length === failAt) {
                      const error = new Error("Injected guest stdin failure");
                      throw error;
                    }
                    chunks.push(chunk);
                  },
                  async close() {
                    const bytes = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
                    const header = new TextEncoder().encode(`blob ${bytes}\0`);
                    // Only this constrained fixture buffers a single blob to verify its Git hash.
                    const object = new Uint8Array(header.length + bytes);
                    object.set(header);
                    let offset = header.length;
                    for (const chunk of chunks) { object.set(chunk, offset); offset += chunk.length; }
                    const oid = new Uint8Array(await crypto.subtle.digest("SHA-1", object)).toHex();
                    files.push({ ...entry, bytes, verified: oid === entry.oid });
                  },
                }));
              } finally { --active; }
            };
            await copy();
            const finished = performance.now();
            if (finished - fileStarted > slowestFile.elapsedMs) {
              slowestFile = { path: entry.path, elapsedMs: finished - fileStarted,
                renewMs: renewed - fileStarted, readMs: opened - renewed, copyMs: finished - opened };
            }
          }
        }
      }
      return { files, maxActive, slowestFile, elapsedMs: performance.now() - started };
    } catch (error) {
      return { files, maxActive, slowestFile, elapsedMs: performance.now() - started, error: String(error) };
    }
  }
}
