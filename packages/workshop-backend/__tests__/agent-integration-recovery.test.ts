import {env, RpcStub} from "cloudflare:workers";
import {evictDurableObject, runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {OverseerDurableObject} from "../src/overseer";
import {UserDurableObject} from "../src/user";
import type {IntegrationTestActionGatekeeper, IntegrationTestParticipant} from "./test-worker";
import {openFakeOverseer} from "./fixtures";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}
type Impl = OverseerDurableObject["impl"];
type TestExports = Cloudflare.Exports & {
  IntegrationTestParticipant(options: {props: {name: string}}): Fetcher<IntegrationTestParticipant>;
  IntegrationTestActionGatekeeper(options: {props: Record<string, never>}): DurableObjectClass<IntegrationTestActionGatekeeper>;
};
const GRANT = '{"container":{"lifecycle":true}}';
const USER = {type: "user" as const, id: "test-user", name: "Test"};
const MODEL = {profile: {type: "agent" as const, id: "recovery-model", name: "Recovery"},
  config: {provider: "anthropic" as const, model: "recovery-model", apiToken: "test-key", apiUrl: "https://recovery.test"}};

async function prepare(impl: Impl, name: string) {
  impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
  const timestamp = impl.getChatTimestamp();
  impl.storage.chatMeta.put({id: 1, title: "Recovery", started: timestamp, lastActive: timestamp});
  impl.addChatMessages(1, USER, [{type: "message", message: "First prompt."}]);
  impl.storage.gatekeepers.put({id: 31, class: impl.ctx.exports.AgentSpawnerGatekeeper({props: {
    overseerId: impl.ctx.id.toString(), config: {displayName: "Integration fixture", modelId: null, env: {}},
  }}), creationSpec: {type: "ambient", vendorId: "container"}});
  impl.storage.chatContext.put({chatId: 1, bindings: {}, alwaysAvailableCapsuleIds: []});
  await impl.beginAgentIntegrationTurn(1);
  const participant = (impl.ctx.exports as TestExports).IntegrationTestParticipant({props: {name}});
  await impl.registerIntegrationParticipant(31, impl.captureIntegrationOrigin({from: "agent", chatId: 1})!, "running", participant);
  return participant;
}

function providerReply(): Response {
  const events = [
    {type: "message_start", message: {id: "msg_recovery", type: "message", role: "assistant",
      model: "recovery-model", content: [], stop_reason: null, stop_sequence: null,
      usage: {input_tokens: 1, output_tokens: 1}}},
    {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
    {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: "Recovered new prompt."}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "end_turn", stop_sequence: null}, usage: {output_tokens: 1}},
    {type: "message_stop"},
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    {headers: {"content-type": "text/event-stream"}});
}

describe("integration cleanup at agent recovery boundaries", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each([
    {boundary: "lookup", recover: false, siblings: false}, {boundary: "lookup", recover: true, siblings: false},
    {boundary: "entry", recover: false, siblings: false}, {boundary: "entry", recover: true, siblings: false},
    {boundary: "lookup", recover: true, siblings: true},
  ])("consumes a browser approval once during $boundary, with overlapping recovery $recover and sibling actions $siblings, without waking the next undecided segment", async ({boundary, recover, siblings}) => {
    const name = crypto.randomUUID(), stub = env.TEST_OVERSEER.getByName(name);
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    await runInDurableObject(user, instance => {
      instance["storage"].profile.put(USER);
      instance["storage"].aiModels.put(MODEL);
    });
    let requests = 0, submit!: (action: number) => Promise<void>;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== MODEL.config.apiUrl) return realFetch(input, init);
      if (++requests <= 2) {
        await submit(41 + requests);
        if (requests === 1 && siblings) await submit(44);
      }
      return providerReply();
    });
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl, participant = await prepare(impl, name);
      impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"lifecycle":true,"contextualActions":true,"recoverableActions":true}}';
      const handler = impl.ctx.facets.get<IntegrationTestActionGatekeeper>("decision-actions", () => ({
        class: (impl.ctx.exports as TestExports).IntegrationTestActionGatekeeper({props: {}}),
      }));
      await handler.setRecoverable();
      impl.getGatekeeperFacet = async () => handler;
      submit = action => impl.submitAction(31, action, {title: `Run ${action}`, description: "Command", implementsRevert: false, awaitDecision: true},
        {from: "agent", chatId: 1}, impl.captureIntegrationOrigin({from: "agent", chatId: 1}));
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, activeAgent: MODEL.profile});
      impl.startAgent(1, MODEL, USER, user.id.toString());
      await impl.waitForAllAgentsToComplete();
      expect(requests).toBe(1);
      const action = [...impl.storage.actions.list()].find(record => record.type === "action")!;
      await participant.block("resumed");
      let lookupEntered = false, releaseLookup = () => {};
      if (boundary === "lookup") {
        const getContext = UserDurableObject.prototype.getChatContext;
        const lookupBarrier = new Promise<void>(resolve => { releaseLookup = resolve; });
        vi.spyOn(UserDurableObject.prototype, "getChatContext").mockImplementation(async function(modelId) {
          lookupEntered = true;
          await lookupBarrier;
          return getContext.call(this, modelId);
        });
      }
      try {
        using client = new RpcStub(await openFakeOverseer({actions: impl.storage.actions, chats: impl.storage.chats,
          chatMeta: impl.storage.chatMeta, gatekeepers: impl.storage.gatekeepers,
          pausedAgents: impl.storage.pausedAgents, activeAgents: impl.storage.activeAgents}, {impl: {
          ctx: impl.ctx, users: {idFromString: () => user.id, get: () => impl.users.get(impl.users.idFromString(user.id.toString()))},
          applyPendingAction: impl.applyPendingAction.bind(impl),
          resumeAfterActionDecision: impl.resumeAfterActionDecision.bind(impl),
          drainAutoApprovals: impl.drainAutoApprovals.bind(impl),
          resumePausedAgent: impl.resumePausedAgent.bind(impl),
        }}));
        await client.approveAction(action.id);
        if (siblings) {
          expect(requests).toBe(1);
          expect(impl.storage.pausedAgents.get(1)).not.toHaveProperty("resumeRequested");
          const sibling = [...impl.storage.actions.list()].find(record => record.state === "pending")!;
          await client.approveAction(sibling.id);
        }
        if (boundary === "lookup") await vi.waitFor(() => expect(lookupEntered).toBe(true));
        else await vi.waitFor(async () => expect((await participant.calls()).some(call => call.event.kind === "resumed")).toBe(true));
        if (recover) {
          // Recovery and a browser decision can both finish the same durable application.
          impl.storage.actionApplications.put({id: action.id, resolvedBy: USER, autoApproved: false,
            phase: "resume", retryAt: Date.now()});
          await Promise.all([impl.recoverActionApplications(),
            expect((async () => { await client.approveAction(action.id); })()).rejects.toThrow(/not pending/)]);
        }
        expect(impl.storage.actions.get(action.id)).toMatchObject({decisionResumed: true});
        expect(impl.storage.activeAgents.get(1)).not.toHaveProperty("resumeRequested");
        releaseLookup();
        await participant.releaseBlock();
        await impl.waitForAllAgentsToComplete();
        expect(requests).toBe(2);
        expect(impl.storage.pausedAgents.get(1)).not.toHaveProperty("resumeRequested");
        expect([...impl.storage.actions.list()].filter(record => record.type === "action").map(record => record.state))
          .toEqual(siblings ? ["approved", "approved", "pending"] : ["approved", "pending"]);
        expect(await handler.calls()).toHaveLength(siblings ? 2 : 1);
        expect([...impl.storage.chats.list()].filter(message => message.type === "agentNudge")).toHaveLength(1);
      } finally {
        releaseLookup();
        await participant.releaseBlock();
        await impl.waitForAllAgentsToComplete();
        delete impl.env.AGENT_INTEGRATION_GRANTS;
      }
    });
  });

  it("retains a decision during real suspension cleanup across eviction without effect-recovery permission", async () => {
    const name = crypto.randomUUID(), stub = env.TEST_OVERSEER.getByName(name);
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    await runInDurableObject(user, instance => {
      instance["storage"].profile.put(USER);
      instance["storage"].aiModels.put(MODEL);
    });
    let requests = 0, submit!: () => Promise<void>;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== MODEL.config.apiUrl) return realFetch(input, init);
      if (++requests === 1) await submit();
      return providerReply();
    });
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl, participant = await prepare(impl, name);
      impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"lifecycle":true,"contextualActions":true}}';
      const handler = impl.ctx.facets.get<IntegrationTestActionGatekeeper>("decision-actions", () => ({
        class: (impl.ctx.exports as TestExports).IntegrationTestActionGatekeeper({props: {}}),
      }));
      impl.getGatekeeperFacet = async () => handler;
      const resume = impl.resumePausedAgent.bind(impl);
      impl.resumePausedAgent = async (...args) => {
        if (impl.storage.chatMeta.get(args[0])?.activeAgent) await resume(...args);
        // Fault the queued hand-off after cleanup, before it consumes the durable wake-up.
      };
      submit = () => impl.submitAction(31, 42, {title: "Run", description: "Command", implementsRevert: false, awaitDecision: true},
        {from: "agent", chatId: 1}, impl.captureIntegrationOrigin({from: "agent", chatId: 1}));
      await participant.block("suspended");
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, activeAgent: MODEL.profile});
      impl.startAgent(1, MODEL, USER, user.id.toString());
      try {
        await vi.waitFor(async () => expect((await participant.calls()).some(call => call.event.kind === "suspended")).toBe(true));
        const action = [...impl.storage.actions.list()].find(record => record.type === "action")!;
        if (action.type !== "action") throw new Error("Missing action");
        await impl.applyPendingAction(action, USER, false);
        expect(await impl.resumeAfterActionDecision(1, action.id, USER)).toBe(true);
        expect(impl.storage.pausedAgents.get(1)).toMatchObject({resumeRequested: true});
        expect(impl.storage.actions.get(action.id)).toMatchObject({state: "approved", decisionNotified: true, decisionResumed: true});
        expect([...impl.storage.actionApplications.list()]).toEqual([]);
        expect(await handler.calls()).toHaveLength(1);
        expect(requests).toBe(1);
        await participant.releaseBlock();
        await impl.waitForAllAgentsToComplete();
        expect(impl.storage.activeAgents.get(1)).toBeUndefined();
        expect(impl.storage.pausedAgents.get(1)).toMatchObject({resumeRequested: true});
        await impl.ctx.storage.sync();
      } catch (error) {
        await participant.releaseBlock();
        await impl.waitForAllAgentsToComplete();
        delete impl.env.AGENT_INTEGRATION_GRANTS;
        throw error;
      }
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"lifecycle":true,"contextualActions":true}}';
      try {
        const participant = (impl.ctx.exports as TestExports).IntegrationTestParticipant({props: {name}});
        await participant.releaseBlock();
        await impl.waitForAllAgentsToComplete();
        expect(requests).toBe(2);
        expect(impl.storage.activeAgents.get(1)).toBeUndefined();
        expect(impl.storage.pausedAgents.get(1)).toBeUndefined();
        expect([...impl.storage.chats.list()].filter(message => message.type === "agentNudge")).toHaveLength(1);
        const handler = impl.ctx.facets.get<IntegrationTestActionGatekeeper>("decision-actions", () => ({
          class: (impl.ctx.exports as TestExports).IntegrationTestActionGatekeeper({props: {}}),
        }));
        expect(await handler.calls()).toHaveLength(1);
        expect([...impl.storage.actionApplications.list()]).toEqual([]);
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

  it("does not resurrect a canceled segment after waiting for the suspended callback", async () => {
    const name = crypto.randomUUID(), stub = env.TEST_OVERSEER.getByName(name);
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl, participant = await prepare(impl, name);
      impl.env.AGENT_INTEGRATION_GRANTS = '{"container":{"lifecycle":true,"worktreeReplica":true}}';
      const commit = await impl.gitStore.writeFilesAsCommit(new Map([["a.txt", "base"]]), {
        parents: [], author: {name: "Test", email: "test@example.com"}, message: "Base", timestamp: new Date(0),
      });
      const tree = await impl.createWorktree("Repo", 1, commit);
      impl.storage.chatContext.put({chatId: 1, bindings: {REPO: tree.id}, alwaysAvailableCapsuleIds: []});
      const origin = impl.captureIntegrationOrigin({from: "agent", chatId: 1})!;
      const replica = await impl.getIntegrationContext(31, origin)!.openWorktreeReplica();
      const leaseId = (await replica.checkpoint()).cursor.split(":")[0];
      const turn = impl.storage.agentIntegrationTurns.get(1)!;
      const turnId = turn.turnId;
      impl.storage.activeAgents.put({chatId: 1, initiatorUserId: "unused", modelId: MODEL.profile.id,
        initiator: USER, callbackInitiated: false, continuationId: crypto.randomUUID(), requestKey: turn.requestKey});
      await participant.block("suspended");
      const closing = impl.closeAgentIntegrationTurn(1, "approval");
      await vi.waitFor(async () => expect((await participant.calls()).some(call => call.event.kind === "suspended")).toBe(true));
      const beginning = expect(impl.beginAgentIntegrationTurn(1, turn.requestKey)).rejects.toThrow(/canceled|superseded/);
      impl.cancelAgent(1);
      await participant.releaseBlock();
      await closing;
      await beginning;
      await impl.closeAgentIntegrationTurn(1, "canceled");
      expect(impl.storage.agentIntegrationTurns.get(1)).toMatchObject({turnId, state: "finished", closing: {reason: "canceled"}});
      await expect(impl.getWorkspaceReplicaSession(leaseId).renew()).rejects.toThrow(/expired|termination/);
      expect((await participant.calls()).filter(call => call.event.kind === "resumed")).toEqual([]);
      expect([...impl.storage.agentIntegrationParticipants.list()]).toEqual([]);
      await impl.ctx.storage.sync();
      delete impl.env.AGENT_INTEGRATION_GRANTS;
    });
  });

  it("accepts an older connection card without waking a newer undecided continuation", async () => {
    const name = crypto.randomUUID(), stub = env.TEST_OVERSEER.getByName(name);
    let continuationId: string;
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      await prepare(impl, name);
      impl.addChatMessages(1, MODEL.profile, [{type: "connectionRequest", requestId: "1:old",
        vendorId: "github", vendorName: "GitHub", reason: "Earlier repo", state: "pending"}]);
      impl.addChatMessages(1, USER, [{type: "message", message: "Second request"}]);
      await impl.beginAgentIntegrationTurn(1);
      const turn = impl.storage.agentIntegrationTurns.get(1)!;
      continuationId = crypto.randomUUID();
      const record = {chatId: 1, initiatorUserId: "unused", modelId: MODEL.profile.id,
        initiator: USER, callbackInitiated: false, continuationId, requestKey: turn.requestKey};
      impl.storage.activeAgents.put(record);
      impl.storage.pausedAgents.put(record);
      impl.storage.agentIntegrationTurns.put({...turn, continuationId});
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, activeAgent: MODEL.profile});
      impl.storage.actions.put({id: 900, type: "action", action: 42, gatekeeperId: 31, createdAt: new Date(), state: "pending",
        caller: {from: "agent", chatId: 1}, description: {title: "New command", description: "Pending", implementsRevert: false, awaitDecision: true}});
      impl.addChatMessages(1, MODEL.profile, [{type: "action", actionId: 900}]);
      await impl.closeAgentIntegrationTurn(1, "approval");
      using client = new RpcStub(await openFakeOverseer({chats: impl.storage.chats, chatMeta: impl.storage.chatMeta,
        pausedAgents: impl.storage.pausedAgents, activeAgents: impl.storage.activeAgents}, {impl: {
          resumePausedAgent: impl.resumePausedAgent.bind(impl), getChatTimestamp: impl.getChatTimestamp.bind(impl)}}));
      await client.acceptConnectionRequest("1:old", {gatekeeperId: 31});
      expect([...impl.storage.chats.list()].find(message => message.type === "connectionRequest"))
        .toMatchObject({state: "accepted"});
      expect(impl.storage.pausedAgents.get(1)).not.toHaveProperty("resumeRequested");
      expect(impl.storage.activeAgents.get(1)).not.toHaveProperty("resumeRequested");
      expect(impl.storage.actions.get(900)?.state).toBe("pending");
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => {
      await instance.impl.waitForAllAgentsToComplete();
      expect(instance.impl.storage.pausedAgents.get(1)).toMatchObject({continuationId});
      expect(instance.impl.storage.pausedAgents.get(1)).not.toHaveProperty("resumeRequested");
      expect(instance.impl.storage.actions.get(900)?.state).toBe("pending");
      delete instance.impl.env.AGENT_INTEGRATION_GRANTS;
    });
  });

  it.each(["before suspension", "during cleanup", "after teardown"] as const)("recovers an accepted connection wake-up %s across eviction", async boundary => {
    const name = crypto.randomUUID(), stub = env.TEST_OVERSEER.getByName(name);
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    await runInDurableObject(user, instance => {
      instance["storage"].profile.put(USER);
      instance["storage"].aiModels.put(MODEL);
    });
    let requests = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== MODEL.config.apiUrl) return realFetch(input, init);
      ++requests;
      return Promise.resolve(providerReply());
    });
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl, participant = await prepare(impl, name);
      const turn = impl.storage.agentIntegrationTurns.get(1)!;
      const continuationId = crypto.randomUUID();
      const record = {chatId: 1, initiatorUserId: user.id.toString(), modelId: MODEL.profile.id,
        initiator: USER, callbackInitiated: false, continuationId, requestKey: turn.requestKey};
      impl.storage.activeAgents.put(record);
      if (boundary !== "before suspension") impl.storage.pausedAgents.put(record);
      impl.storage.agentIntegrationTurns.put({...turn, continuationId});
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, activeAgent: MODEL.profile});
      impl.addChatMessages(1, MODEL.profile, [{type: "connectionRequest", requestId: "1:connection",
        vendorId: "github", vendorName: "GitHub", reason: "Read repo", state: "pending"}]);
      await participant.setFailure(true);
      if (boundary !== "before suspension") {
        await expect(impl.closeAgentIntegrationTurn(1, "connection")).rejects.toThrow(/unavailable/);
      }
      using client = new RpcStub(await openFakeOverseer({chats: impl.storage.chats, chatMeta: impl.storage.chatMeta,
        pausedAgents: impl.storage.pausedAgents, activeAgents: impl.storage.activeAgents}, {impl: {resumePausedAgent: impl.resumePausedAgent.bind(impl),
          getChatTimestamp: impl.getChatTimestamp.bind(impl)}}));
      await client.acceptConnectionRequest("1:connection", {gatekeeperId: 31});
      expect([...impl.storage.chats.list()].find(message => message.type === "connectionRequest"))
        .toMatchObject({state: "accepted"});
      expect(impl.storage.pausedAgents.get(1) ?? impl.storage.activeAgents.get(1))
        .toMatchObject({continuationId, resumeRequested: true});
      expect(requests).toBe(0);
      if (boundary === "before suspension") {
        // The ordinary turn finally copies its active record into the pause before callback I/O.
        impl.storage.pausedAgents.put(impl.storage.activeAgents.get(1)!);
        await expect(impl.closeAgentIntegrationTurn(1, "connection")).rejects.toThrow(/unavailable/);
      }
      await participant.setFailure(false);
      if (boundary === "after teardown") {
        await impl.closeAgentIntegrationTurn(1, "connection");
        // Fault between clearing the busy record and dispatching the queued wake-up.
        impl.storage.activeAgents.delete(1);
        const meta = impl.storage.chatMeta.get(1)!;
        delete meta.activeAgent;
        impl.storage.chatMeta.put(meta);
      }
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
      try {
        // Constructor wake-up may still be waiting for message-preparation's microtask.
        await vi.waitFor(() => expect(requests).toBe(1));
        await impl.waitForAllAgentsToComplete();
        expect(requests).toBe(1);
        expect(impl.storage.activeAgents.get(1)).toBeUndefined();
        expect(impl.storage.pausedAgents.get(1)).toBeUndefined();
        expect(impl.storage.chatMeta.get(1)?.activeAgent).toBeUndefined();
        expect(impl.storage.agentIntegrationTurns.get(1)?.closing?.kind).toBe("finished");
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

  it.each(["approval", "connection"] as const)("recovers interrupted %s teardown without inferring until an authorized wake-up", async reason => {
    const name = crypto.randomUUID(), stub = env.TEST_OVERSEER.getByName(name);
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    await runInDurableObject(user, instance => {
      instance["storage"].profile.put(USER);
      instance["storage"].aiModels.put(MODEL);
    });
    let requests = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== MODEL.config.apiUrl) return realFetch(input, init);
      ++requests;
      return Promise.resolve(providerReply());
    });
    let continuationId: string, closingId: string;
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl, participant = await prepare(impl, name);
      const turn = impl.storage.agentIntegrationTurns.get(1)!;
      continuationId = crypto.randomUUID();
      const record = {chatId: 1, initiatorUserId: user.id.toString(), modelId: MODEL.profile.id,
        initiator: USER, callbackInitiated: false, continuationId, requestKey: turn.requestKey};
      impl.storage.activeAgents.put(record);
      impl.storage.pausedAgents.put(record);
      impl.storage.agentIntegrationTurns.put({...turn, continuationId});
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, activeAgent: MODEL.profile});
      await participant.setFailure(true);
      await expect(impl.closeAgentIntegrationTurn(1, reason)).rejects.toThrow(/unavailable/);
      closingId = impl.storage.agentIntegrationTurns.get(1)!.closing!.eventId;
      await participant.setFailure(false);
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
      try {
        await impl.waitForAllAgentsToComplete();
        expect(requests).toBe(0);
        expect(impl.storage.activeAgents.get(1)).toBeUndefined();
        expect(impl.storage.chatMeta.get(1)?.activeAgent).toBeUndefined();
        expect(impl.storage.pausedAgents.get(1)?.continuationId).toBe(continuationId);
        expect(impl.storage.agentIntegrationTurns.get(1)).toMatchObject({state: "suspended",
          closing: {kind: "suspended", reason, eventId: closingId}});
        expect([...impl.storage.agentIntegrationParticipants.list()][0].pending).toEqual([]);
        // The decision handler's wake-up removes the paused marker before recovery.
        await impl.resumePausedAgent(1);
        await impl.waitForAllAgentsToComplete();
        expect(requests).toBe(1);
        expect(impl.storage.pausedAgents.get(1)).toBeUndefined();
        expect(impl.storage.agentIntegrationTurns.get(1)?.closing?.kind).toBe("finished");
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

  it("clears busy bookkeeping when canceled during recovery's model lookup", async () => {
    const name = crypto.randomUUID(), stub = env.TEST_OVERSEER.getByName(name);
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    let entered = false, canceled = false, release: () => void;
    const getContext = UserDurableObject.prototype.getChatContext;
    vi.spyOn(UserDurableObject.prototype, "getChatContext").mockImplementation(async function(modelId) {
      entered = true;
      await new Promise<void>(resolve => { release = resolve; });
      return getContext.call(this, modelId);
    });
    await runInDurableObject(user, instance => {
      instance["storage"].profile.put(USER);
      instance["storage"].aiModels.put(MODEL);
    });
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      await prepare(impl, name);
      const turn = impl.storage.agentIntegrationTurns.get(1)!;
      impl.storage.activeAgents.put({chatId: 1, initiatorUserId: user.id.toString(), modelId: MODEL.profile.id,
        initiator: USER, callbackInitiated: false, continuationId: crypto.randomUUID(), requestKey: turn.requestKey});
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, activeAgent: MODEL.profile});
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(stub);
    const completed = runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
      try {
        await vi.waitFor(() => expect(entered).toBe(true));
        impl.cancelAgent(1);
        canceled = true;
        await impl.waitForAllAgentsToComplete();
        expect(impl.storage.activeAgents.get(1)).toBeUndefined();
        expect(impl.storage.pausedAgents.get(1)).toBeUndefined();
        expect(impl.storage.chatMeta.get(1)?.activeAgent).toBeUndefined();
        expect(impl.storage.agentIntegrationTurns.get(1)).toMatchObject({state: "finished", closing: {reason: "canceled"}});
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
    await vi.waitFor(() => expect(canceled).toBe(true));
    await runInDurableObject(user, () => release());
    await completed;
  });

  it.each(["new request", "same request"])("does not discard a newer execution of a %s during previous cleanup", async request => {
    const name = crypto.randomUUID(), stub = env.TEST_OVERSEER.getByName(name);
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    await runInDurableObject(user, instance => {
      instance["storage"].profile.put(USER);
      instance["storage"].aiModels.put(MODEL);
    });
    let requests = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== MODEL.config.apiUrl) return realFetch(input, init);
      ++requests;
      return Promise.resolve(providerReply());
    });
    let firstTurnId: string;
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl, participant = await prepare(impl, name);
      const first = impl.storage.agentIntegrationTurns.get(1)!;
      firstTurnId = first.turnId;
      impl.storage.agentIntegrationTurns.put({...first, continuationId: crypto.randomUUID()});
      await participant.setFailure(true);
      await expect(impl.closeAgentIntegrationTurn(1, "completed")).rejects.toThrow(/unavailable/);
      if (request === "new request") impl.addChatMessages(1, USER, [{type: "message", message: "Second prompt."}]);
      const requestKey = String([...impl.storage.chats.list()].at(-1)!.sequence);
      const meta = impl.storage.chatMeta.get(1)!;
      meta.activeAgent = MODEL.profile;
      impl.storage.chatMeta.put(meta);
      const begin = impl.beginAgentIntegrationTurn.bind(impl);
      impl.beginAgentIntegrationTurn = async (chatId, key) => {
        try { await begin(chatId, key); }
        catch {
          // Lose the invocation at the actual old-cleanup await, then evict the real DO.
          throw Object.assign(new Error("Injected reset during prior cleanup"), {durableObjectReset: true});
        }
      };
      impl.startAgent(1, MODEL, USER, user.id.toString());
      await vi.waitFor(async () => expect((await participant.calls()).length).toBeGreaterThanOrEqual(3));
      expect(impl.storage.activeAgents.get(1)?.requestKey).toBe(requestKey);
      expect(impl.storage.agentIntegrationTurns.get(1)?.turnId).toBe(firstTurnId);
      expect(requests).toBe(0);
      await participant.setFailure(false);
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
      try {
        await impl.waitForAllAgentsToComplete();
        expect(requests).toBe(1);
        expect([...impl.storage.chats.list()].some(message => message.type === "message" &&
          message.author.type === "agent" && message.message === "Recovered new prompt.")).toBe(true);
        expect(impl.storage.agentIntegrationTurns.get(1)).toMatchObject({state: "finished", closing: {reason: "completed"}});
        expect(impl.storage.agentIntegrationTurns.get(1)?.turnId).not.toBe(firstTurnId);
        expect(impl.storage.activeAgents.get(1)).toBeUndefined();
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });

  it("journals failed cleanup before discarding an interrupted turn whose model was removed", async () => {
    const name = crypto.randomUUID(), stub = env.TEST_OVERSEER.getByName(name);
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl, participant = await prepare(impl, name);
      await participant.setFailure(true);
      const turn = impl.storage.agentIntegrationTurns.get(1)!;
      impl.storage.activeAgents.put({chatId: 1, initiatorUserId: user.id.toString(), modelId: "removed-model",
        initiator: USER, callbackInitiated: false, continuationId: crypto.randomUUID(), requestKey: turn.requestKey});
      const meta = impl.storage.chatMeta.get(1)!;
      meta.activeAgent = MODEL.profile;
      impl.storage.chatMeta.put(meta);
      await impl.ctx.storage.sync();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      impl.env.AGENT_INTEGRATION_GRANTS = GRANT;
      try {
        await impl.waitForAllAgentsToComplete();
        expect(impl.storage.activeAgents.get(1)).toBeUndefined();
        expect(impl.storage.chatMeta.get(1)?.activeAgent).toBeUndefined();
        expect(impl.storage.agentIntegrationTurns.get(1)).toMatchObject({state: "finished", closing: {kind: "finished", reason: "failed"}});
        const pending = [...impl.storage.agentIntegrationParticipants.list()][0];
        expect(pending.pending).toHaveLength(1);
        expect(pending.retryAt).toBeTypeOf("number");
        const participant = (impl.ctx.exports as TestExports).IntegrationTestParticipant({props: {name}});
        await participant.setFailure(false);
        impl.storage.agentIntegrationParticipants.put({...pending, retryAt: Date.now()});
        await impl.retryAgentIntegrationEvents();
        const calls = (await participant.calls()).filter(call => call.event.kind === "finished");
        expect(calls).toHaveLength(2);
        expect(calls[0].event.eventId).toBe(calls[1].event.eventId);
        expect([...impl.storage.agentIntegrationParticipants.list()]).toEqual([]);
      } finally { delete impl.env.AGENT_INTEGRATION_GRANTS; }
    });
  });
});
