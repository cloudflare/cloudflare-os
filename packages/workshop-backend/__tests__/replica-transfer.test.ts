import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {expect, it} from "vitest";
import {beginReplicaTurn, pauseReplicaTurn} from "./replica-fixtures";
import type {OverseerDurableObject} from "./test-worker";
import type {TestReplicaTransfer} from "./replica-transfer-worker";

const testEnv = env as Cloudflare.Env & {
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  TEST_REPLICA_TRANSFER: DurableObjectNamespace<TestReplicaTransfer>;
};
it("streams Git packs to another Worker and accepts its one-way return", async () => {
  const owner = testEnv.TEST_OVERSEER.getByName(crypto.randomUUID());
  const fixture = await runInDurableObject(owner, async instance => {
    const impl = instance["impl"];
    impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"worktreeReplica":true}}';
    impl.storage.chatMeta.put({id: 1, title: "Transfer", started: Date.now(), lastActive: Date.now()});
      const commit = await impl.gitStore.writeFilesAsCommit(new Map([
        ["a.txt", "hello"], ["raw.bin", "\0\xff\0"],
      ]), {parents: [], author: {name: "Test", email: "test@example.com"}, message: "Base", timestamp: new Date(0)});
      const tree = await impl.createWorktree("Repo", 1, commit);
      impl.storage.chatContext.put({chatId: 1, bindings: {REPO: tree.id}});
      impl.storage.gatekeepers.put({id: 31, class: impl.ctx.exports.AgentSpawnerGatekeeper({props: {
        overseerId: impl.ctx.id.toString(), config: {displayName: "Transfer", modelId: null, env: {}},
      }}), creationSpec: {type: "ambient", vendorId: "container"}});
      await beginReplicaTurn(impl, 1);
      return {commit, treeId: tree.id, origin: impl.captureIntegrationOrigin({from: "agent", chatId: 1}, 31)!};
  });
  try {
    const mount = await owner.testMountWorktree(31, fixture.origin, "REPO");
    const guest = testEnv.TEST_REPLICA_TRANSFER.getByName(crypto.randomUUID());
    const result = await guest.transfer(mount);
    expect(result.head).toBe(fixture.commit);
    expect(result.objects.some(object => object.binary && object.type === "blob")).toBe(true);
    await runInDurableObject(owner, async instance => {
      const impl = instance["impl"];
      expect((await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).get(fixture.treeId)?.get("return.txt"))
        .toBe("from other Worker");
    });
  } finally {
    await runInDurableObject(owner, async instance => {
      pauseReplicaTurn(instance["impl"], 1); delete instance["impl"].env.AGENT_INTEGRATION_GRANTS;
    });
  }
});
