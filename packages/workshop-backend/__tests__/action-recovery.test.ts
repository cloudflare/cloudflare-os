import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { OverseerDurableObject } from "../src/overseer";
import type { ActionRecord } from "../src/storage-schema/overseer-storage";
import type { IntegrationTestActionGatekeeper } from "./test-worker";

declare module "cloudflare:workers" {
  interface ProvidedEnv { TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>; }
}
type Impl = OverseerDurableObject["impl"];
type TestExports = Cloudflare.Exports & {
  IntegrationTestActionGatekeeper(options: { props: Record<string, never> }):
    DurableObjectClass<IntegrationTestActionGatekeeper>;
};
const APPROVER = { type: "user" as const, id: "original-approver", name: "Approver" };
const GRANT = '{"container":{"lifecycle":true,"contextualActions":true,"recoverableActions":true}}';
function facet(impl: Impl) {
  const handler = impl.ctx.facets.get<IntegrationTestActionGatekeeper>("recovery-actions", () => ({
    class: (impl.ctx.exports as TestExports).IntegrationTestActionGatekeeper({ props: {} }),
  }));
  impl.getGatekeeperFacet = async () => handler;
  return handler;
}
function action(impl: Impl): ActionRecord & { type: "action" } {
  const record = [...impl.storage.actions.list()][0];
  if (record?.type !== "action") throw new Error("Missing fixture action");
  return record;
}
async function prepare(impl: Impl, recoverable = true, awaited = false) {
  impl.storage.chatMeta.put({id: 1, title: "Recovery", createdAt: new Date(), lastActive: new Date()});
  impl.env.AGENT_INTEGRATION_GRANTS = recoverable ? GRANT : '{"container":{"contextualActions":true}}';
  impl.storage.gatekeepers.put({ id: 31, class: impl.ctx.exports.AgentSpawnerGatekeeper({ props: {
    overseerId: impl.ctx.id.toString(), config: { displayName: "Fixture", modelId: null, env: {} },
  }}), creationSpec: { type: "ambient", vendorId: "container" } });
  const handler = facet(impl);
  await handler.setRecoverable();
  await impl.beginAgentIntegrationTurn(1);
  await impl.submitAction(31, 42, { title: "Run", description: "Run command", implementsRevert: false, awaitDecision: awaited },
    { from: "agent", chatId: 1 }, impl.captureIntegrationOrigin({ from: "agent", chatId: 1 }));
  impl.addChatMessages(1, {type: "agent", id: "fixture", name: "Fixture"}, [{type: "action", actionId: action(impl).id}]);
  await impl.closeAgentIntegrationTurn(1, "approval");
  return handler;
}
const reset = () => Object.assign(new Error("Injected lost reply"), { durableObjectReset: true });

describe("durable approved-action recovery", () => {
  it.each([false, true])("auto-approves an awaited follow-up while its auto-approved=%s parent is still applying", async autoParent => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
      const impl = instance.impl, handler = await prepare(impl, true, true);
      let release!: () => void;
      const childApplied = new Promise<void>(resolve => { release = resolve; });
      let childStarted = false;
      try {
        // This test owns the approval/effect barrier, not model inference after the decision.
        impl.resumePausedAgent = async () => {};
        impl.storage.autoApproveTags.put({gatekeeperId: 31, actionKind: {tag: "network", label: "Network"}, enabledBy: APPROVER});
        await handler.setFollowup({title: "Allow network", description: "Exact destination", implementsRevert: false,
          autoApprovable: true, actionKind: {tag: "network", label: "Network"}, awaitDecision: true});
        impl.getGatekeeperFacet = async () => new Proxy(handler, {get(target, key) {
          if (key === "applyActionInContext") return async (...args: Parameters<typeof target.applyActionInContext>) => {
            await target.applyActionInContext(...args);
            if (args[0] === 42) await childApplied;
            else {
              expect(action(impl).state).toBe("pending");
              childStarted = true;
              release();
            }
          };
          return Reflect.get(target, key);
        }});
        const parent = action(impl);
        if (autoParent) {
          impl.storage.autoApproveTags.put({gatekeeperId: 31, actionKind: {tag: "run", label: "Run"}, enabledBy: APPROVER});
          impl.storage.actions.put({...parent, description: {...parent.description, autoApprovable: true,
            actionKind: {tag: "run", label: "Run"}}});
        }
        const applying = autoParent ? impl.drainAutoApprovals(31) : impl.applyPendingAction(parent, APPROVER, false);
        try { await vi.waitFor(() => expect(childStarted).toBe(true), {timeout: 500}); }
        finally { release(); await applying; }
        expect((await handler.calls()).map(call => call.action)).toEqual([42, 43]);
        expect([...impl.storage.actions.list()].filter(record => record.type === "action").map(record => record.state))
          .toEqual(["approved", "approved"]);
      } finally { release(); delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

  it("rechecks recovery permission during active-agent restoration even before retryAt", async () => {
    const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
    let grantSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await runInDurableObject(stub, async instance => {
        const impl = instance.impl;
        await prepare(impl);
        const parent = action(impl);
        impl.storage.gatekeepers.put({...impl.storage.gatekeepers.get(31)!,
          class: (impl.ctx.exports as TestExports).IntegrationTestActionGatekeeper({props: {}})});
        impl.storage.actionApplications.put({id: parent.id, resolvedBy: APPROVER, autoApproved: false,
          phase: "apply", retryAt: Date.now() + 60_000});
        impl.storage.activeAgents.put({chatId: 1, initiatorUserId: "invalid-do-id", modelId: "missing",
          initiator: APPROVER, callbackInitiated: false, continuationId: crypto.randomUUID()});
        grantSpy = vi.spyOn(Object.getPrototypeOf(impl), "integrationGrant").mockReturnValue({
          lifecycle: true, contextualActions: true, recoverableActions: false, worktreeReplica: false,
        });
        await impl.ctx.storage.sync();
      });
      await evictDurableObject(stub);
      await runInDurableObject(stub, async instance => {
        const impl = instance.impl;
        await impl.waitForAllAgentsToComplete();
        const handler = await impl.getGatekeeperFacet(31) as Fetcher<IntegrationTestActionGatekeeper>;
        expect(await handler.calls()).toEqual([]);
        expect(action(impl).state).toBe("pending");
        expect([...impl.storage.actionApplications.list()]).toEqual([]);
      });
    } finally { grantSpy?.mockRestore(); delete env.AGENT_INTEGRATION_GRANTS; }
  });

  it("publishes an in-flight follow-up through the real context, with durable deduplication and original scope", async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
      const impl = instance.impl, handler = await prepare(impl, true, true);
      try {
        await handler.setFollowup({title: "Allow network", description: "Exact destination", implementsRevert: false,
          autoApprovable: false, awaitDecision: true});
        await impl.applyPendingAction(action(impl), APPROVER, false);
        const records = [...impl.storage.actions.list()].filter(record => record.type === "action");
        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({state: "approved", followupActionIds: [records[1]!.id]});
        expect(records[1]).toMatchObject({state: "pending", gatekeeperId: 31, action: 43,
          caller: {from: "agent", chatId: 1}, integrationOrigin: records[0]!.integrationOrigin,
          description: {autoApprovable: false, awaitDecision: true}});
        expect([...impl.storage.chats.list()].filter(message => message.type === "action" &&
          message.actionId === records[1]!.id)).toHaveLength(1);
        await expect(impl.submitAction(31, 44, {title: "Late", description: "Late", implementsRevert: false},
          {from: "agent", chatId: 1}, records[0]!.integrationOrigin, records[0]!.id)).rejects.toThrow(/originating action/);
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

  it.each(["different-description", "revoked", "new-turn", "closed-turn", "no-approved-intent"])(
    "refuses follow-up submission with %s", async edge => {
      await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
        const impl = instance.impl;
        await prepare(impl, true, true);
        try {
          const parent = action(impl);
          impl.storage.actionApplications.put({id: parent.id, phase: "apply", resolvedBy: APPROVER,
            autoApproved: false, retryAt: Date.now() + 60_000});
          const description = {title: "Network", description: "Public HTTPS", implementsRevert: false,
            autoApprovable: false, awaitDecision: true};
          const submit = (desc = description) => impl.submitAction(31, 43, desc,
            {from: "agent", chatId: 1}, parent.integrationOrigin, parent.id);
          await submit();
          const turn = impl.storage.agentIntegrationTurns.get(1)!;
          if (edge === "revoked") impl.env.AGENT_INTEGRATION_GRANTS = '{}';
          else if (edge === "new-turn") impl.storage.agentIntegrationTurns.put({...turn, turnId: "different-turn"});
          else if (edge === "closed-turn") impl.storage.agentIntegrationTurns.put({...turn, state: "finished"});
          else if (edge === "no-approved-intent") impl.storage.actionApplications.delete(parent.id);
          await expect(submit(edge === "different-description" ? {...description, description: "Changed"} : description))
            .rejects.toThrow();
          expect([...impl.storage.actions.list()]).toHaveLength(2);
        } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
      });
    });

  it("deduplicates a committed follow-up after real kernel eviction, even if the child was approved", async () => {
    const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
    const description = {title: "Network", description: "Public HTTPS", implementsRevert: false,
      autoApprovable: false, awaitDecision: true};
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      await prepare(impl, true, true);
      const parent = action(impl);
      impl.storage.actionApplications.put({id: parent.id, phase: "apply", resolvedBy: APPROVER,
        autoApproved: false, retryAt: Date.now() + 60_000});
      await impl.submitAction(31, 43, description, parent.caller, parent.integrationOrigin, parent.id);
      const child = impl.storage.actions.get(action(impl).followupActionIds![0]!);
      if (child?.type !== "action") throw new Error("Missing follow-up");
      impl.storage.actions.put({...child, state: "approved"});
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
      try {
        const parent = action(impl);
        await impl.submitAction(31, 43, description, parent.caller, parent.integrationOrigin, parent.id);
        expect([...impl.storage.actions.list()]).toHaveLength(2);
        expect([...impl.storage.chats.list()].filter(message => message.type === "action")).toHaveLength(2);
        let resumed = 0;
        impl.resumePausedAgent = async () => { ++resumed; };
        await impl.resumeAfterActionDecision(1, parent.followupActionIds![0]!, APPROVER);
        // The shell's pending parent still blocks inference; a destination grant isn't completion.
        expect(resumed).toBe(0);
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

  it("survives real Overseer eviction after the effect but before its acknowledgement", async () => {
    const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl, handler = await prepare(impl);
      impl.getGatekeeperFacet = async () => new Proxy(handler, { get(target, key) {
        if (key === "applyActionInContext") return async (...args: Parameters<typeof target.applyActionInContext>) => {
          // Intent was persisted before crossing into a real, persistent native facet.
          expect([...impl.storage.actionApplications.list()]).toHaveLength(1);
          await target.applyActionInContext(...args);
          throw reset();
        };
        return Reflect.get(target, key);
      }});
      await expect(impl.applyPendingAction(action(impl), APPROVER, true)).rejects.toThrow("lost reply");
      expect(await handler.calls()).toHaveLength(1);
      const application = [...impl.storage.actionApplications.list()][0];
      expect(application).toMatchObject({ phase: "apply", resolvedBy: APPROVER, autoApproved: true });
      // Keep constructor recovery out of the fixture's grant/facet installation window.
      impl.storage.actionApplications.put({ ...application, retryAt: Date.now() + 60_000 });
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
      const handler = facet(impl);
      const applications = [...impl.storage.actionApplications.list()];
      for (const application of applications)
        impl.storage.actionApplications.put({ ...application, retryAt: Date.now() });
      await impl.recoverActionApplications();
      expect(action(impl)).toMatchObject({ state: "approved", resolvedBy: APPROVER, autoApproved: true });
      expect(await handler.calls()).toHaveLength(1); // Receipt, not a second effect.
      expect([...impl.storage.actionApplications.list()]).toEqual([]);
      delete impl.env.AGENT_INTEGRATION_GRANTS;
    });
  });

  it("deduplicates concurrent manual and auto approval in the same incarnation", async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
      const impl = instance.impl, handler = await prepare(impl);
      try {
        await Promise.all([impl.applyPendingAction(action(impl), APPROVER, false),
          impl.applyPendingAction(action(impl), { ...APPROVER, id: "other" }, true)]);
        expect(await handler.calls()).toHaveLength(1);
        expect(action(impl)).toMatchObject({ resolvedBy: APPROVER, autoApproved: false });
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

  it("recovers terminal teardown after eviction without resolving a model or restarting inference", async () => {
    const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      await prepare(impl);
      await impl.closeAgentIntegrationTurn(1, "completed");
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, activeAgent: {id: "missing", name: "Missing"}});
      impl.storage.activeAgents.put({chatId: 1, initiatorUserId: "invalid-do-id", modelId: "missing",
        initiator: APPROVER, callbackInitiated: false, continuationId: "completed-turn"});
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      for (let attempts = 0; impl.storage.activeAgents.get(1) && attempts < 100; ++attempts) await scheduler.wait(5);
      expect(impl.storage.activeAgents.get(1)).toBeUndefined();
      expect(impl.storage.chatMeta.get(1)?.activeAgent).toBeUndefined();
      expect([...impl.storage.chats.list()].filter(message => message.type === "message" &&
        message.text.includes("could not be resumed"))).toEqual([]);
      expect(impl.storage.agentIntegrationTurns.get(1)?.state).toBe("finished");
      delete impl.env.AGENT_INTEGRATION_GRANTS;
    });
  });

  it.each(["revoked", "legacy"])("never redelivers an effect with %s authority", async mode => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
      const impl = instance.impl, handler = await prepare(impl, mode !== "legacy");
      try {
        impl.getGatekeeperFacet = async () => new Proxy(handler, { get(target, key) {
          if (key === "applyActionInContext") return async () => { throw reset(); };
          return Reflect.get(target, key);
        }});
        await expect(impl.applyPendingAction(action(impl), APPROVER, false)).rejects.toThrow("lost reply");
        facet(impl);
        impl.env.AGENT_INTEGRATION_GRANTS = '{}';
        const applications = [...impl.storage.actionApplications.list()];
        for (const application of applications)
          impl.storage.actionApplications.put({ ...application, retryAt: Date.now() });
        await impl.recoverActionApplications();
        expect(action(impl).state).toBe("pending");
        expect(await handler.calls()).toEqual([]);
        expect([...impl.storage.actionApplications.list()]).toEqual([]);
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

  it("deduplicates the decision note if resumption loses its acknowledgement", async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
      const impl = instance.impl;
      await prepare(impl);
      try {
        const record = action(impl);
        impl.storage.actions.put({ ...record, state: "approved", description: { ...record.description, awaitDecision: true } });
        let resumed = 0;
        impl.resumePausedAgent = async () => { throw reset(); };
        await expect(impl.resumeAfterActionDecision(1, record.id, APPROVER))
          .rejects.toThrow("lost reply");
        impl.resumePausedAgent = async () => { ++resumed; };
        await impl.resumeAfterActionDecision(1, record.id, APPROVER);
        expect(resumed).toBe(1);
        expect([...impl.storage.chats.list()].filter(message => message.type === "agentNudge")).toHaveLength(1);
        expect(action(impl).decisionNotified).toBe(true);
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

  it.each(["canceled", "new-prompt", "sibling-pending", "sibling-denied"])("does not resume after %s", async edge => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
      const impl = instance.impl;
      await prepare(impl);
      try {
        const record = action(impl);
        impl.storage.actions.put({ ...record, state: "approved", description: { ...record.description, awaitDecision: true } });
        if (edge === "canceled") impl.cancelAgent(1);
        if (edge === "new-prompt") impl.addChatMessages(1, APPROVER, [{type: "message", text: "A different request"}]);
        if (edge.startsWith("sibling")) {
          impl.storage.actions.put({ ...record, id: record.id + 1,
            state: edge === "sibling-denied" ? "rejected" : "pending",
            description: { ...record.description, awaitDecision: true } });
          impl.addChatMessages(1, APPROVER, [{type: "action", actionId: record.id + 1}]);
        }
        let resumed = 0;
        impl.resumePausedAgent = async () => { ++resumed; };
        await impl.resumeAfterActionDecision(1, record.id, APPROVER);
        expect(resumed).toBe(0);
        expect([...impl.storage.chats.list()].filter(message => message.type === "agentNudge")).toHaveLength(0);
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });
});
