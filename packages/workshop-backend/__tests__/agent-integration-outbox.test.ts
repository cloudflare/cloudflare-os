import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { OverseerDurableObject } from "../src/overseer";
import type { IntegrationTestParticipant, IntegrationTestActionGatekeeper } from "./test-worker";
import type { ActionRecord } from "../src/storage-schema/overseer-storage";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";

declare module "cloudflare:workers" {
  interface ProvidedEnv { TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>; }
}

type Impl = OverseerDurableObject["impl"];
type Participant = Fetcher<IntegrationTestParticipant>;
type TestExports = Cloudflare.Exports & {
  IntegrationTestParticipant(options: { props: { name: string } }): Participant;
  IntegrationTestActionGatekeeper(options: { props: Record<string, never> }):
    DurableObjectClass<IntegrationTestActionGatekeeper>;
};
const GATEKEEPER = 31;
const CHAT = 1;
const CONFIG = '{"container":{"lifecycle":true,"contextualActions":true}}';
async function inKernel(test: (impl: Impl, participant: Participant) => Promise<void>, name = crypto.randomUUID()) {
  await runInDurableObject(env.TEST_OVERSEER.getByName(name), async instance => {
    const impl = instance["impl"];
    impl.env.AGENT_INTEGRATION_GRANTS = CONFIG;
    impl.storage.gatekeepers.put({ id: GATEKEEPER, class: impl.ctx.exports.AgentSpawnerGatekeeper({
      props: { overseerId: impl.ctx.id.toString(), config: { displayName: "Integration fixture", modelId: null, env: {} } },
    }),
      creationSpec: { type: "ambient", vendorId: "container" } });
    const participant = (impl.ctx.exports as TestExports).IntegrationTestParticipant({ props: { name } });
    try { await test(impl, participant); }
    finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
  });
}
function origin(impl: Impl) {
  const captured = impl.captureIntegrationOrigin({ from: "agent", chatId: CHAT });
  if (!captured) throw new Error("Test did not start a turn");
  return captured;
}
function dueNow(impl: Impl) {
  // Updating the retry index starts a nested kv.list(), which invalidates a live iterator.
  const records = [...impl.storage.agentIntegrationParticipants.list()];
  for (const record of records) {
    impl.storage.agentIntegrationParticipants.put({ ...record, retryAt: Date.now() });
  }
}
function action(impl: Impl): ActionRecord & { type: "action" } {
  const record = [...impl.storage.actions.list()].find(candidate => candidate.type === "action");
  if (!record || record.type !== "action") throw new Error("Action missing");
  return record;
}
function actionFacet(impl: Impl) {
  const original = impl.getGatekeeperFacet;
  const facet = impl.ctx.facets.get<IntegrationTestActionGatekeeper>("integration-actions", () => ({
    class: (impl.ctx.exports as TestExports).IntegrationTestActionGatekeeper({ props: {} }),
  }));
  impl.getGatekeeperFacet = async () => facet;
  return { facet, restore() { impl.getGatekeeperFacet = original; } };
}
const COMMAND: ActionDescription = { title: "Command", description: "Run pwd", implementsRevert: false };
const APPROVER = { type: "user" as const, id: "approver", name: "Approver" };

describe("agent integration over persistent native RPC", () => {
  it("retains registration-scoped worktrees in started and resumed callbacks after eviction", async () => {
    const name = crypto.randomUUID();
    let checkoutId: number;
    await inKernel(async (impl, participant) => {
      impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"lifecycle":true,"worktreeReplica":true}}';
      const timestamp = impl.getChatTimestamp();
      impl.storage.chatMeta.put({id: CHAT, title: "Callbacks", started: timestamp, lastActive: timestamp});
      const commit = await impl.gitStore.writeFilesAsCommit(new Map([["a.txt", "base"]]), {
        parents: [], author: {name: "Test", email: "test@example.com"}, message: "Base", timestamp: new Date(0),
      });
      const tree = await impl.createWorktree("Repo", CHAT, commit);
      checkoutId = tree.id;
      impl.storage.chatContext.put({chatId: CHAT, bindings: {REPO: tree.id}});
      impl.addChatMessages(CHAT, APPROVER, [{type: "message", message: "Work with REPO."}]);
      await impl.beginAgentIntegrationTurn(CHAT);
      await participant.setCaptureReplica(true);
      await impl.registerIntegrationParticipant(GATEKEEPER, origin(impl), "running", participant);
      await impl.closeAgentIntegrationTurn(CHAT, "approval");
      const later = await impl.createWorktree("Later repo", CHAT, commit);
      impl.storage.chatContext.put({chatId: CHAT, bindings: {REPO: tree.id, LATER: later.id}});
      await impl.ctx.storage.sync();
    }, name);
    await evictDurableObject(env.TEST_OVERSEER.getByName(name));
    await inKernel(async (impl, participant) => {
      impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"lifecycle":true,"worktreeReplica":true}}';
      await impl.beginAgentIntegrationTurn(CHAT);
      const calls = (await participant.calls()).filter(call => call.checkoutIds !== undefined);
      expect(calls.map(call => call.event.kind)).toEqual(["started", "resumed"]);
      expect(calls.map(call => call.checkoutIds)).toEqual([[checkoutId], [checkoutId]]);
      await impl.closeAgentIntegrationTurn(CHAT, "completed");
    }, name);
  });

  it("passes the real approval queue's context into a native gatekeeper session", async () => inKernel(async impl => {
    const handler = actionFacet(impl);
    try {
      await impl.beginAgentIntegrationTurn(CHAT);
      const first = origin(impl);
      using session = await impl.openGatekeeperSession(GATEKEEPER, handler.facet, { from: "agent", chatId: CHAT });
      expect(session.turn).toEqual({ turnId: first.turnId, segmentId: first.segmentId,
        chatId: String(CHAT), phase: "running" });
      await impl.closeAgentIntegrationTurn(CHAT, "completed");
    } finally { handler.restore(); }
  }));

  it("registers once, suspends, resumes with a fresh segment, and finishes", async () => inKernel(async (impl, participant) => {
    await impl.beginAgentIntegrationTurn(CHAT);
    const first = origin(impl);
    await impl.registerIntegrationParticipant(GATEKEEPER, first, "running", participant);
    await impl.registerIntegrationParticipant(GATEKEEPER, first, "running", participant);
    await impl.closeAgentIntegrationTurn(CHAT, "approval");
    await impl.beginAgentIntegrationTurn(CHAT);
    const second = origin(impl);
    expect(second.turnId).toBe(first.turnId);
    expect(second.segmentId).not.toBe(first.segmentId);
    await impl.closeAgentIntegrationTurn(CHAT, "completed");
    const calls = await participant.calls();
    expect(calls.map(call => call.event.kind)).toEqual(["started", "suspended", "resumed", "finished"]);
    expect(calls.map(call => call.turn.phase)).toEqual(["running", "suspending", "running", "finishing"]);
    expect([...impl.storage.agentIntegrationParticipants.list()]).toEqual([]);
  }));

  it("supplies context for a replica-only grant without granting lifecycle participation", async () => inKernel(async (impl, participant) => {
    const handler = actionFacet(impl);
    impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"worktreeReplica":true}}';
    try {
      await impl.beginAgentIntegrationTurn(CHAT);
      using session = await impl.openGatekeeperSession(GATEKEEPER, handler.facet, {from: "agent", chatId: CHAT});
      expect(session.turn?.turnId).toBe(origin(impl).turnId);
      await expect(impl.registerIntegrationParticipant(GATEKEEPER, origin(impl), "running", participant))
        .rejects.toThrow(/not been granted/);
    } finally { handler.restore(); }
  }));

  it("starts a new turn for an independent callback, but resumes approval nudges", async () => inKernel(async (impl, participant) => {
    const timestamp = impl.getChatTimestamp();
    impl.storage.chatMeta.put({id: CHAT, title: "Callbacks", started: timestamp, lastActive: timestamp});
    impl.addChatMessages(CHAT, APPROVER, [{type: "message", message: "first request"}]);
    await impl.beginAgentIntegrationTurn(CHAT);
    const first = origin(impl);
    const oldContext = impl.getIntegrationContext(GATEKEEPER, first)!;
    await impl.registerIntegrationParticipant(GATEKEEPER, first, "running", participant);
    await impl.closeAgentIntegrationTurn(CHAT, "approval");
    impl.addChatMessages(CHAT, {type: "agent", id: "agent", name: "Agent"}, [{type: "agentNudge", text: "approval ready"}]);
    await impl.beginAgentIntegrationTurn(CHAT);
    expect(origin(impl).turnId).toBe(first.turnId);
    await impl.closeAgentIntegrationTurn(CHAT, "approval");
    impl.addChatMessages(CHAT, {type: "gadget", id: "gadget", name: "Gadget"}, [
      {type: "agentCallback", callId: 0, methodName: "newRequest", argsSummary: "independent callback"},
    ]);
    await impl.beginAgentIntegrationTurn(CHAT);
    expect(origin(impl).turnId).not.toBe(first.turnId);
    expect((await participant.calls()).at(-1)?.event).toMatchObject({kind: "finished", reason: "abandoned"});
    await expect(oldContext.getTurn()).rejects.toThrow(/expired/);
  }));

  it("persists failed delivery and retries the same event id before advancing a segment", async () => inKernel(async (impl, participant) => {
    await impl.beginAgentIntegrationTurn(CHAT);
    await participant.setFailure(true);
    await expect(impl.registerIntegrationParticipant(GATEKEEPER, origin(impl), "running", participant)).rejects.toThrow(/unavailable/);
    const saved = [...impl.storage.agentIntegrationParticipants.list()][0];
    expect(saved.retryAt).toBeTypeOf("number");
    expect(saved.participant).toBeDefined();
    await expect(impl.beginAgentIntegrationTurn(CHAT)).rejects.toThrow(/unavailable/);
    expect(origin(impl).segmentId).toBe(saved.pending[0].segmentId);
    await participant.setFailure(false);
    dueNow(impl);
    await impl.retryAgentIntegrationEvents();
    const calls = await participant.calls();
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(call => call.event.eventId)).size).toBe(1);
    expect([...impl.storage.agentIntegrationParticipants.list()][0].pending).toEqual([]);
    await impl.closeAgentIntegrationTurn(CHAT, "completed");
  }));

  it("can drain an entry retry after the turn finished, without reopening running authority", async () => inKernel(async (impl, participant) => {
    await impl.beginAgentIntegrationTurn(CHAT);
    await participant.setFailure(true);
    await expect(impl.registerIntegrationParticipant(GATEKEEPER, origin(impl), "running", participant)).rejects.toThrow(/unavailable/);
    await expect(impl.closeAgentIntegrationTurn(CHAT, "failed")).rejects.toThrow(/unavailable/);
    await participant.setFailure(false);
    dueNow(impl);
    await impl.retryAgentIntegrationEvents();
    const calls = await participant.calls();
    expect(calls.slice(-2).map(call => [call.event.kind, call.turn.phase])).toEqual([
      ["started", "finishing"], ["finished", "finishing"],
    ]);
    expect([...impl.storage.agentIntegrationParticipants.list()]).toEqual([]);
  }));

  it("closes and retries multiple indexed participants without invalidating storage iteration", async () => inKernel(async (impl, participant) => {
    const binding = impl.storage.gatekeepers.get(GATEKEEPER);
    if (!binding) throw new Error("Fixture binding missing");
    impl.storage.gatekeepers.put({ ...binding, id: GATEKEEPER + 1 });
    await impl.beginAgentIntegrationTurn(CHAT);
    await participant.setFailure(true);
    for (const id of [GATEKEEPER, GATEKEEPER + 1]) {
      await expect(impl.registerIntegrationParticipant(id, origin(impl), "running", participant))
        .rejects.toThrow(/unavailable/);
    }
    await expect(impl.closeAgentIntegrationTurn(CHAT, "failed")).rejects.toThrow(/unavailable/);
    const pending = [...impl.storage.agentIntegrationParticipants.list()];
    expect(pending).toHaveLength(2);
    expect(pending.every(record => record.pending.length === 2)).toBe(true);
    await participant.setFailure(false);
    dueNow(impl);
    await impl.retryAgentIntegrationEvents();
    const delivered = (await participant.calls()).slice(-4);
    expect(delivered.every(call => call.turn.phase === "finishing")).toBe(true);
    expect(delivered.map(call => call.event.kind).toSorted()).toEqual(["finished", "finished", "started", "started"]);
    expect([...impl.storage.agentIntegrationParticipants.list()]).toEqual([]);
  }));

  it("revokes work authority but still delivers terminal cleanup", async () => inKernel(async (impl, participant) => {
    await impl.beginAgentIntegrationTurn(CHAT);
    const context = impl.getIntegrationContext(GATEKEEPER, origin(impl));
    expect(context).not.toBeNull();
    await impl.registerIntegrationParticipant(GATEKEEPER, origin(impl), "running", participant);
    impl.env.AGENT_INTEGRATION_GRANTS = '{}';
    await expect(context!.getTurn()).rejects.toThrow(/revoked/);
    await impl.closeAgentIntegrationTurn(CHAT, "completed");
    expect((await participant.calls()).map(call => [call.event.kind, call.turn.phase]))
      .toEqual([["started", "running"], ["finished", "finishing"]]);
    expect([...impl.storage.agentIntegrationParticipants.list()]).toEqual([]);
  }));

  it("retries cleanup after binding deletion without replaying an undelivered entry", async () => inKernel(async (impl, participant) => {
    await impl.beginAgentIntegrationTurn(CHAT);
    await participant.setFailure(true);
    await expect(impl.registerIntegrationParticipant(GATEKEEPER, origin(impl), "running", participant))
      .rejects.toThrow(/unavailable/);
    impl.storage.gatekeepers.delete(GATEKEEPER);
    await expect(impl.closeAgentIntegrationTurn(CHAT, "failed")).rejects.toThrow(/unavailable/);
    expect([...impl.storage.agentIntegrationParticipants.list()]).toHaveLength(1);
    await participant.setFailure(false);
    dueNow(impl);
    await impl.retryAgentIntegrationEvents();
    expect((await participant.calls()).map(call => call.event.kind)).toEqual(["started", "finished", "finished"]);
    expect([...impl.storage.agentIntegrationParticipants.list()]).toEqual([]);
  }));

  it("never widens an old context or delayed action to an unrelated prompt", async () => inKernel(async (impl, participant) => {
    await impl.beginAgentIntegrationTurn(CHAT);
    const first = origin(impl);
    const context = impl.getIntegrationContext(GATEKEEPER, first);
    await impl.registerIntegrationParticipant(GATEKEEPER, first, "running", participant);
    await impl.closeAgentIntegrationTurn(CHAT, "approval");
    // With no chat messages, this sequence is the request identity used by the harness.
    impl.nextChatSequence(CHAT);
    await impl.beginAgentIntegrationTurn(CHAT);
    expect(origin(impl).turnId).not.toBe(first.turnId);
    expect((await participant.calls()).map(call => call.event.kind)).toEqual(["started", "suspended", "finished"]);
    await expect(context!.getTurn()).rejects.toThrow(/expired/);
    expect(() => impl.getIntegrationContext(GATEKEEPER, first, "applyingAction")).toThrow(/expired/);
    await expect(impl.submitAction(GATEKEEPER, 1, { title: "Old command", description: "Old request", implementsRevert: false },
      { from: "agent", chatId: CHAT }, first)).rejects.toThrow(/expired/);
    await impl.closeAgentIntegrationTurn(CHAT, "completed");
  }));

  it("requires a separate explicit grant for worktree replication", async () => inKernel(async (impl, participant) => {
    await impl.beginAgentIntegrationTurn(CHAT);
    const first = origin(impl);
    expect(impl.getIntegrationContext(GATEKEEPER, undefined)).toBeNull();
    await expect(impl.getIntegrationContext(GATEKEEPER, first)!.openWorktreeReplica()).rejects.toThrow(/not been granted/);
    impl.env.AGENT_INTEGRATION_GRANTS = '{}';
    expect(impl.getIntegrationContext(GATEKEEPER, first)).toBeNull();
    await expect(impl.registerIntegrationParticipant(GATEKEEPER, first, "running", participant)).rejects.toThrow(/not been granted/);
    await impl.closeAgentIntegrationTurn(CHAT, "completed");
  }));

  it("captures the action origin and supplies a fresh context while approval is suspended", async () => inKernel(async impl => {
    const handler = actionFacet(impl);
    try {
      await impl.beginAgentIntegrationTurn(CHAT);
      const first = origin(impl);
      await impl.submitAction(GATEKEEPER, 42, COMMAND, { from: "agent", chatId: CHAT }, first);
      const queued = action(impl);
      expect(queued.integrationOrigin).toEqual(first);
      expect(queued.contextualApply).toBe(true);
      await impl.closeAgentIntegrationTurn(CHAT, "approval");
      await impl.applyPendingAction(queued, APPROVER, false);
      expect(await handler.facet.calls()).toEqual([{ action: 42, handler: "contextual", turn: {
        turnId: first.turnId, segmentId: first.segmentId, chatId: String(CHAT), phase: "applyingAction",
      } }]);
      expect(action(impl).state).toBe("approved");
      await impl.beginAgentIntegrationTurn(CHAT);
      await impl.closeAgentIntegrationTurn(CHAT, "completed");
    } finally { handler.restore(); }
  }));

  it("retries approval in a fresh segment of the same turn without reviving the old session", async () => inKernel(async impl => {
    const handler = actionFacet(impl);
    try {
      await impl.beginAgentIntegrationTurn(CHAT);
      const first = origin(impl);
      const oldContext = impl.getIntegrationContext(GATEKEEPER, first);
      await impl.submitAction(GATEKEEPER, 42, COMMAND, { from: "agent", chatId: CHAT }, first);
      await impl.closeAgentIntegrationTurn(CHAT, "approval");
      await impl.beginAgentIntegrationTurn(CHAT);
      const resumed = origin(impl);
      expect(resumed.turnId).toBe(first.turnId);
      expect(resumed.segmentId).not.toBe(first.segmentId);
      await expect(oldContext!.getTurn()).rejects.toThrow(/expired/);
      await impl.applyPendingAction(action(impl), APPROVER, false);
      expect(await handler.facet.calls()).toEqual([{ action: 42, handler: "contextual", turn: {
        turnId: first.turnId, segmentId: resumed.segmentId, chatId: String(CHAT), phase: "applyingAction",
      } }]);
      expect(action(impl).integrationOrigin).toEqual(first);
      expect(action(impl).state).toBe("approved");
      await impl.closeAgentIntegrationTurn(CHAT, "completed");
    } finally { handler.restore(); }
  }));

  it("does not fall back or mark approved when contextual apply fails", async () => inKernel(async impl => {
    const handler = actionFacet(impl);
    try {
      await impl.beginAgentIntegrationTurn(CHAT);
      await impl.submitAction(GATEKEEPER, 42, COMMAND, { from: "agent", chatId: CHAT }, origin(impl));
      await handler.facet.setFailure(true);
      await expect(impl.applyPendingAction(action(impl), APPROVER, false)).rejects.toThrow(/handler failed/);
      expect((await handler.facet.calls()).map(call => call.handler)).toEqual(["contextual"]);
      expect(action(impl).state).toBe("pending");
      impl.env.AGENT_INTEGRATION_GRANTS = '{}';
      await expect(impl.applyPendingAction(action(impl), APPROVER, false)).rejects.toThrow(/revoked/);
      expect(await handler.facet.calls()).toHaveLength(1);
      await impl.closeAgentIntegrationTurn(CHAT, "failed");
    } finally { handler.restore(); }
  }));

  it("keeps legacy queue-time dispatch even if integration permissions are granted later", async () => inKernel(async impl => {
    const handler = actionFacet(impl);
    try {
      impl.env.AGENT_INTEGRATION_GRANTS = '{}';
      await impl.submitAction(GATEKEEPER, 42, COMMAND, { from: "agent", chatId: CHAT });
      expect(action(impl).contextualApply).toBe(false);
      impl.env.AGENT_INTEGRATION_GRANTS = CONFIG;
      await impl.applyPendingAction(action(impl), APPROVER, true);
      expect(await handler.facet.calls()).toEqual([{ action: 42, handler: "legacy" }]);
      expect(action(impl).autoApproved).toBe(true);
    } finally { handler.restore(); }
  }));
});
