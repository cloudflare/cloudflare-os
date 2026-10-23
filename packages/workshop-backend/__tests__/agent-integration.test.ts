import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentIntegrationGrant } from "../src/agent-integration";
import type { OverseerDurableObject } from "../src/overseer";
import { lifecycleExports } from "./lifecycle-fixtures";
import { openFakeOverseer } from "./fixtures";

type Impl = OverseerDurableObject["impl"];
const AGENT = {type: "agent" as const, id: "model", name: "Model"};
const USER = {type: "user" as const, id: "user", name: "User"};
const grants = '{"test":{"lifecycle":true}}';
const originalGrants = env.AGENT_INTEGRATION_GRANTS;
afterEach(() => { vi.restoreAllMocks(); env.AGENT_INTEGRATION_GRANTS = originalGrants; });

function participant(impl: Impl, name: string) {
  return lifecycleExports(impl).TestLifecycleParticipant({props: {name}});
}

function seed(impl: Impl) {
  impl.env.AGENT_INTEGRATION_GRANTS = grants;
  const timestamp = impl.getChatTimestamp();
  impl.storage.chatMeta.put({id: 1, title: "Lifecycle", started: timestamp, lastActive: timestamp, activeAgent: AGENT});
  impl.storage.activeAgents.put({chatId: 1, initiatorUserId: "unused", modelId: AGENT.id,
    initiator: USER, callbackInitiated: false});
  impl.storage.gatekeepers.put({id: 7, class: lifecycleExports(impl).TestLifecycleGatekeeper({props: {}}),
    creationSpec: {type: "ambient", vendorId: "test", accountId: 1}});
  return impl.integrations.capture(1)!;
}

async function fixture() {
  const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const visit = <T>(fn: (impl: Impl) => T | Promise<T>) =>
    runInDurableObject(env.TEST_OVERSEER.get(stub.id), ({impl}) => fn(impl));
  return {stub, visit};
}

async function deletionClient(impl: Impl) {
  return openFakeOverseer(impl.storage, {impl: {
    ctx: impl.ctx, logger: impl.logger, integrations: impl.integrations,
    beginDeletion: impl.beginDeletion.bind(impl),
    users: {idFromString: (id: string) => id,
      get: () => ({deleteGadget: async () => { throw new Error("Owner deletion failed"); }})},
  }});
}

describe("trusted integration grants", () => {
  it("is exact, independent of ambience, and fails closed on malformed/unknown grants", () => {
    expect(agentIntegrationGrant(grants, "test")).toBe(true);
    expect(agentIntegrationGrant(grants, "TEST")).toBe(false);
    for (const config of [undefined, "invalid", "null", "[]", '{"test":true}',
      '{"test":{"lifecycle":"true"}}', '{"test":{"recoverableActions":true}}']) {
      expect(agentIntegrationGrant(config, "test")).toBe(false);
    }
  });
});

describe("lifecycle outbox", () => {
  it.each(["segment", "stop"] as const)("keeps callback re-registration a no-op across %s cleanup", async change => {
    const {visit} = await fixture();
    await visit(async impl => {
      // Drive delivery explicitly; an alarm would also try to recover this synthetic model.
      vi.spyOn(impl.ctx.storage, "setAlarm").mockResolvedValue();
      const origin = seed(impl), receiver = participant(impl, crypto.randomUUID());
      await receiver.setReregister();
      const context = impl.integrations.context(7, origin)!;
      await context.participate(receiver);
      await context.participate(receiver);
      await impl.integrations.drain(1);
      expect(await receiver.calls()).toEqual([]); // Registration sends no started notification.
      expect([...impl.storage.agentParticipants.list()]).toHaveLength(1);
      await receiver.hold("resumed");
      impl.integrations.emit(impl.storage.activeAgents.get(1)!, "resumed");
      const draining = impl.integrations.drain(1);
      // Observe rejection immediately so the deliberately failing pre-fix run cannot leak it.
      const outcome = draining.then(() => null, (error: unknown) => error);
      await receiver.waitUntilHeld();
      try {
        if (change === "segment") {
          const row = impl.storage.activeAgents.get(1)!;
          row.integration!.segmentId = crypto.randomUUID();
          impl.storage.activeAgents.put(row);
        }
        else impl.storage.activeAgents.delete(1);
        expect((await receiver.release())?.phase).toBe(change === "segment" ? "suspending" : "finishing");
      } finally { await receiver.release(); }
      expect(await outcome).toBeNull();
      expect((await receiver.calls()).map(c => c.event.kind)).toEqual(
        change === "segment" ? ["resumed"] : ["resumed", "finished"]);
      impl.storage.activeAgents.delete(1);
      await impl.integrations.drain(1);
      expect([...impl.storage.agentParticipants.list()]).toHaveLength(0);
    });
  });

  it.each(["grant", "connection"] as const)("revokes retained contexts and downgrades in-flight delivery after %s removal", async change => {
    const {visit} = await fixture();
    await visit(async impl => {
      vi.spyOn(impl.ctx.storage, "setAlarm").mockResolvedValue();
      const origin = seed(impl), receiver = participant(impl, crypto.randomUUID());
      const context = impl.integrations.context(7, origin)!;
      await receiver.hold("resumed");
      await context.participate(receiver);
      impl.integrations.emit(impl.storage.activeAgents.get(1)!, "resumed");
      const draining = impl.integrations.drain(1);
      await receiver.waitUntilHeld();
      try {
        expect((await receiver.calls())[0].turn.phase).toBe("running");
        if (change === "grant") impl.env.AGENT_INTEGRATION_GRANTS = '{"test":{}}';
        else impl.storage.gatekeepers.delete(7);
        await expect(context.getTurn()).rejects.toThrow("revoked");
        await expect(context.participate(receiver)).rejects.toThrow("revoked");
        expect((await receiver.release())?.phase).toBe("finishing");
        await draining; // Complete this notification before queueing a distinct terminal drain.
      } finally {
        impl.storage.activeAgents.delete(1);
        await receiver.release();
        await draining;
        await impl.integrations.drain(1);
      }
      expect((await receiver.calls()).at(-1)?.turn.phase).toBe("finishing");
      expect([...impl.storage.agentParticipants.list()]).toHaveLength(0);
    });
  });

  it("keeps retained and in-flight contexts fail-closed until a scope-widening restart lands", async () => {
    const {visit} = await fixture();
    await visit(async impl => {
      vi.spyOn(impl.ctx.storage, "setAlarm").mockResolvedValue();
      const restarting = vi.spyOn(impl, "scheduleAccessRestart").mockResolvedValue();
      const origin = seed(impl), receiver = participant(impl, crypto.randomUUID());
      const context = impl.integrations.context(7, origin)!;
      await context.participate(receiver);
      await receiver.hold("resumed");
      impl.integrations.emit(impl.storage.activeAgents.get(1)!, "resumed");
      const draining = impl.integrations.drain(1);
      await receiver.waitUntilHeld();
      const leave = impl.joinSession("use");
      try {
        impl.storage.gadgets.put({type: "gadget", id: 100, title: "Probe", created: new Date(0),
          bindingName: "PROBE", bindings: {}});
        impl.bindWorkpiece(100, "CONNECTION", 7);
        expect(restarting).toHaveBeenCalledOnce();
        // Env construction remains possible; neither retained nor newly used contexts gain authority.
        expect(() => impl.captureIntegrationOrigin({from: "agent", chatId: 1}, 7)).not.toThrow();
        await expect(context.getTurn()).rejects.toThrow("restarting");
        expect((await receiver.release())?.phase).toBe("finishing");
        await draining;
      } finally {
        leave();
        await receiver.release();
        await draining;
        impl.storage.activeAgents.delete(1);
        await impl.integrations.drain(1);
      }
    });
  });

  it("keeps the same event ID across a lost reply, real eviction, deletion and revocation", async () => {
    const {stub, visit} = await fixture();
    const name = crypto.randomUUID();
    const ids = await visit(async impl => {
      const origin = seed(impl), receiver = participant(impl, name);
      await receiver.setFailure(true);
      await impl.integrations.context(7, origin)!.participate(receiver);
      impl.integrations.emit(impl.storage.activeAgents.get(1)!, "resumed");
      await expect(impl.integrations.drain(1)).rejects.toThrow("Reply lost");
      impl.storage.activeAgents.delete(1);
      impl.storage.chatMeta.delete(1);
      impl.storage.gatekeepers.delete(7);
      return [...impl.storage.agentParticipants.list()][0].pending.map(e => e.eventId);
    });
    await evictDurableObject(stub);
    await visit(async impl => {
      const receiver = participant(impl, name);
      await receiver.setFailure(false);
      await impl.integrations.drain(1);
      const calls = await receiver.calls();
      expect(calls.filter(c => c.event.kind === "resumed").length).toBeGreaterThanOrEqual(2);
      expect(calls.every(c => ids.includes(c.event.eventId))).toBe(true);
      expect(calls.at(-1)?.event.eventId).toBe(ids[1]);
      expect(calls.at(-1)?.turn.phase).toBe("finishing");
      expect([...impl.storage.agentParticipants.list()]).toHaveLength(0);
    });
  });

  it.each([false, true])("retains failed deletion cleanup after connector removal (reset: %s)", async reset => {
    const {stub, visit} = await fixture();
    const name = crypto.randomUUID();
    const pending = await visit(async impl => {
      const origin = seed(impl), receiver = participant(impl, name);
      await impl.integrations.context(7, origin)!.participate(receiver);
      await impl.integrations.drain();
      await receiver.setFailure(true);
      using client = await deletionClient(impl);
      await expect(client.deleteSelf()).rejects.toThrow("Reply lost");
      expect(impl.storage.deleting.get()).toBe(true);
      expect(impl.storage.activeAgents.get(1)).toBeUndefined();
      expect(() => impl.startAgent(1, {} as any, USER, "unused")).toThrow("deletion");
      const pending = [...impl.storage.agentParticipants.list()][0].pending;
      impl.removeGatekeeper(7);
      expect(impl.storage.gatekeepers.get(7)).toBeUndefined();
      await expect(impl.integrations.drain()).rejects.toThrow("Reply lost");
      expect([...impl.storage.agentParticipants.list()][0].pending).toEqual(pending);
      return pending;
    });
    if (reset) await evictDurableObject(stub);
    await visit(async impl => {
      expect(impl.storage.deleting.get()).toBe(true);
      await expect(impl.deliverAgentCallback(1, "late", [], "unused", null)).rejects.toThrow("deleted");
      const receiver = participant(impl, name);
      await expect(impl.integrations.drain()).rejects.toThrow("Reply lost");
      expect([...impl.storage.agentParticipants.list()][0].pending).toEqual(pending);
      expect((await receiver.calls()).at(-1)?.turn.phase).toBe("finishing");
      await receiver.setFailure(false);
      const [receipt] = impl.storage.agentParticipants.list();
      impl.storage.agentParticipants.put({...receipt, retryAt: Date.now() - 1});
      await impl.integrations.deliverDue();
      expect([...impl.storage.agentParticipants.list()]).toHaveLength(0);
      expect(impl.storage.deleting.get()).toBe(false);
    });
  });

  it("releases the deletion fence after a post-cleanup owner failure resets the DO", async () => {
    const {visit} = await fixture();
    await expect(visit(async impl => {
      seed(impl);
      using client = await deletionClient(impl);
      await client.deleteSelf();
    })).rejects.toThrow();
    await visit(impl => {
      expect(impl.storage.deleting.get()).toBe(false);
      expect(impl.storage.activeAgents.get(1)).toBeUndefined();
      expect(() => impl.assertChatNotActive(1)).not.toThrow();
    });
  });
});
