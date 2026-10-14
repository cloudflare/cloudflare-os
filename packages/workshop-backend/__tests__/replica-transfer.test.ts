/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readCommit, readTree, writeBlob, writeTree } from "isomorphic-git";
import type { TestReplicaTransfer } from "./replica-transfer-worker";
import type { OverseerDurableObject } from "./test-worker";
import { GITDIR, makeGitObjectsFs } from "../src/git-store";

const testEnv = env as Cloudflare.Env & {
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  TEST_REPLICA_TRANSFER: DurableObjectNamespace<TestReplicaTransfer>;
};

async function fixture() {
  const owner = testEnv.TEST_OVERSEER.getByName(crypto.randomUUID());
  const leaseId = await runInDurableObject(owner, async instance => {
    const impl = instance["impl"];
    impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"worktreeReplica":true}}';
    impl.storage.chatMeta.put({ id: 1, title: "Transfer", started: new Date(), lastActive: new Date() });
    // More than one metadata page; identical blobs must remain readable across RPC transfers.
    const files = new Map(Array.from({ length: 140 }, (_, index) =>
      [`src/file-${index.toString().padStart(3, "0")}.txt`, "some repeated source\n".repeat(200)]));
    files.set("empty", "");
    files.set("nul.bin", "\0binary\0data");
    files.set("unicode.txt", "😀 café 漢字\n".repeat(400));
    const options = {
      parents: [], author: { name: "Test", email: "test@example.com" },
      message: "Constrained import", timestamp: new Date(0),
    };
    let commit = await impl.gitStore.writeFilesAsCommit(files, options);
    const fs = makeGitObjectsFs(impl.storage.gitObjects);
    const base = await readCommit({ fs, gitdir: GITDIR, oid: commit });
    const root = await readTree({ fs, gitdir: GITDIR, oid: base.commit.tree });
    const raw = await writeBlob({ fs, gitdir: GITDIR,
      blob: Uint8Array.from({ length: 256 }, (_, byte) => byte) });
    const link = await writeBlob({ fs, gitdir: GITDIR,
      blob: new TextEncoder().encode("src/file-000.txt") });
    root.tree.push({ path: "raw.bin", mode: "100644", type: "blob", oid: raw },
      { path: "link", mode: "120000", type: "blob", oid: link });
    const baseTree = await writeTree({ fs, gitdir: GITDIR, tree: root.tree });
    commit = await impl.gitStore.writeCommitForTree(baseTree, options);
    const tree = await impl.createWorktree("Repo", 1, commit);
    impl.storage.chatContext.put({ chatId: 1, bindings: { REPO: tree.id } });
    impl.storage.gatekeepers.put({ id: 31, class: impl.ctx.exports.AgentSpawnerGatekeeper({ props: {
      overseerId: impl.ctx.id.toString(), config: { displayName: "Transfer", modelId: null, env: {} },
    }}), creationSpec: { type: "ambient", vendorId: "container", accountId: 1 } });
    await impl.beginAgentIntegrationTurn(1);
    const origin = impl.captureIntegrationOrigin({ from: "agent", chatId: 1 })!;
    await impl.getIntegrationContext(31, origin)!.openWorktreeReplica();
    return [...impl.storage.worktreeReplicaLeases.list()][0].id;
  });
  const replica = await owner.testReplicaEndpoint(leaseId);
  return { owner, replica, guest: testEnv.TEST_REPLICA_TRANSFER.getByName(crypto.randomUUID()) };
}

describe("production kernel export to a separate Miniflare Worker and DO", () => {
  it("keeps binary source streams readable while guest dispatch delays consumption", async () => {
    const { replica, guest } = await fixture();
    try {
      const result = await guest.transfer(replica, undefined, 10);
      expect(result.error).toBeUndefined();
      expect(result.files).toHaveLength(145);
      expect(result.files.every(file => file.verified)).toBe(true);
      expect(result.maxActive).toBe(1);
    } finally { await replica.release(); }
  }, 20_000);

  it("transfers multiple cursor pages and repeated, empty, binary and Unicode blobs", async () => {
    const { replica, guest } = await fixture();
    try {
      const result = await guest.transfer(replica);
      expect(result.error).toBeUndefined();
      expect(result.files).toHaveLength(145);
      expect(result.files.every(file => file.verified)).toBe(true);
      expect(result.files.find(file => file.path === "raw.bin")).toMatchObject({ bytes: 256 });
      expect(result.files.find(file => file.path === "link")).toMatchObject({ mode: "120000" });
      expect(result.maxActive).toBe(1);
      console.info("local replica transfer", { files: result.files.length, elapsedMs: result.elapsedMs,
        slowestFile: result.slowestFile });
    } finally { await replica.release(); }
  }, 20_000);

  it("settles an interrupted stdin transfer and can re-export the same checkpoint", async () => {
    const { replica, guest } = await fixture();
    try {
      const failed = await guest.transfer(replica, 3);
      console.info("local interrupted transfer", { files: failed.files.length, elapsedMs: failed.elapsedMs, error: failed.error });
      expect(failed.error).toContain("Injected guest stdin failure");
      expect(failed.files).toHaveLength(3);
      const retried = await guest.transfer(replica);
      console.info("local retried transfer", { files: retried.files.length, elapsedMs: retried.elapsedMs,
        slowestFile: retried.slowestFile });
      expect(retried.error).toBeUndefined();
      expect(retried.files).toHaveLength(145);
      expect(retried.files.every(file => file.verified)).toBe(true);
    } finally { await replica.release(); }
  }, 20_000);
});
