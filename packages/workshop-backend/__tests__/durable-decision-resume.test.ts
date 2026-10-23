import { env, type RpcStub } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiChatAuthorInfo, UserNotification } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer";
import { UserDurableObject } from "../src/user";
import { openFakeOverseer } from "./fixtures";
import type { FakeChatResponseTarget } from "./response-target";

const CHAT = 1;
const USER = {type: "user" as const, id: "original-user", name: "Original user"};
const MODEL = {
  profile: {type: "agent" as const, id: "resume-model", name: "Resume model"},
  config: {provider: "anthropic" as const, model: "resume-model", apiToken: "test-key",
    apiUrl: "https://decision-resume.test"},
};
type Impl = OverseerDurableObject["impl"];
type Kind = "connection" | "action";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function inference(gate?: Promise<void>) {
  let count = 0;
  const fetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== MODEL.config.apiUrl) return fetch(input, init);
    count++;
    const events = [
      {type: "message_start", message: {id: "resume", type: "message", role: "assistant",
        model: MODEL.profile.id, content: [], stop_reason: null, stop_sequence: null,
        usage: {input_tokens: 1, output_tokens: 1}}},
      {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
      {type: "content_block_delta", index: 0, delta: {type: "text_delta", text: "Done."}},
      {type: "content_block_stop", index: 0},
      {type: "message_delta", delta: {stop_reason: "end_turn", stop_sequence: null}, usage: {output_tokens: 1}},
      {type: "message_stop"},
    ];
    const response = new Response(events.map(e =>
      `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
      {headers: {"content-type": "text/event-stream"}});
    return gate ? gate.then(() => response) : Promise.resolve(response);
  });
  return () => count;
}

function request(impl: Impl, kind: Kind, requestId = "1:connection") {
  if (kind === "connection") {
    impl.addChatMessages(CHAT, MODEL.profile, [{type: "connectionRequest", requestId,
      vendorId: "calendar", vendorName: "Calendar", reason: "Read events", state: "pending"}]);
  } else {
    impl.storage.actions.put({id: 7, gatekeeperId: 31, type: "action", action: 42,
      createdAt: new Date(), state: "pending", caller: {from: "agent", chatId: CHAT},
      description: {title: "Edit", description: "Edit", implementsRevert: false, awaitDecision: true}});
    impl.addChatMessages(CHAT, MODEL.profile, [{type: "action", actionId: 7}]);
  }
}

function decide(impl: Impl, kind: Kind) {
  if (kind === "action") {
    const action = impl.storage.actions.get(7)!;
    impl.storage.actions.put({...action, state: "approved"});
  } else {
    const msg = [...impl.storage.chats.list()].findLast(m => m.type === "connectionRequest")!;
    if (msg.type !== "connectionRequest") throw new Error("Missing request");
    impl.storage.chats.put({...msg, state: "accepted", gatekeeperId: 31});
  }
}

async function scenario(kind: Kind = "connection", active = false, initiator: AiChatAuthorInfo = USER) {
  const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const user = env.TEST_USER.getByName(crypto.randomUUID());
  await runInDurableObject(user, instance => {
    instance["storage"].profile.put(USER);
    instance["storage"].aiModels.put(MODEL);
  });
  const visit = <T>(fn: (impl: Impl) => T | Promise<T>) =>
    runInDurableObject(env.TEST_OVERSEER.get(stub.id), ({impl}) => fn(impl));
  await visit(impl => {
    const timestamp = impl.getChatTimestamp();
    impl.storage.chatMeta.put({id: CHAT, title: "Resume", started: timestamp, lastActive: timestamp,
      ...(active ? {activeAgent: MODEL.profile} : {})});
    impl.storage.chatContext.put({chatId: CHAT, bindings: {}, alwaysAvailableCapsuleIds: []});
    impl.addChatMessages(CHAT, USER, [{type: "message", message: "Do the work"}]);
    request(impl, kind);
    impl.storage.activeAgents.put({chatId: CHAT, modelId: MODEL.profile.id,
      initiatorUserId: user.id.toString(), initiator, callbackInitiated: initiator.type === "gadget"});
  });
  return {stub, user, visit};
}

function decisionClient(impl: Impl, profile = USER, overrides: object = {}) {
  const userId = impl.storage.activeAgents.get(CHAT)?.initiatorUserId;
  return openFakeOverseer(impl.storage, {impl: {
    users: {idFromString: (id: string) => id,
      get: (id: string) => ({id: {toString: () => userId ?? id}, whoami: async () => profile,
        getChatContext: async () => ({profile: USER, aiModel: MODEL})})},
    rememberDecisionInitiator: impl.rememberDecisionInitiator.bind(impl),
    resumeAgentAfterDecision: impl.resumeAgentAfterDecision.bind(impl),
    getChatTimestamp: impl.getChatTimestamp.bind(impl),
    assertChatNotActive: impl.assertChatNotActive.bind(impl),
    materializeChatChanges: impl.materializeChatChanges.bind(impl),
    addChatMessages: impl.addChatMessages.bind(impl),
    startAgent: impl.startAgent.bind(impl),
    drainAutoApprovals: impl.drainAutoApprovals.bind(impl),
    ...overrides,
  }});
}

function modelLookup(impl: Impl, lookup: () => Promise<{profile: typeof USER, aiModel: typeof MODEL}>) {
  // Hold/fail the caller-side read, without an unrelated user-DO RPC keeping an eviction alive.
  impl.users = {idFromString: (id: string) => id,
    get: () => ({getChatContext: lookup, publishNotification: async () => {}})} as
      unknown as typeof impl.users;
}

function recordNotifications() {
  const notifications: [string, UserNotification][] = [];
  vi.spyOn(UserDurableObject.prototype, "publishNotification").mockImplementation(async function(notification) {
    notifications.push([this.ctx.id.toString(), notification]);
  });
  return notifications;
}

describe("decision handoff using the existing execution row", () => {
  it.each(["connection", "action"] as const)("recovers a committed %s decision, before or after teardown", async kind => {
    const requests = inference();
    for (const active of [false, true]) {
      const s = await scenario(kind, active);
      await s.visit(async impl => {
        decide(impl, kind); // Simulate the boundary immediately before the resume claim.
        await impl.ctx.storage.sync();
      });
      await evictDurableObject(s.stub);
      await s.visit(async impl => {
        await impl.waitForAllAgentsToComplete();
        expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
        expect(impl.storage.activeAgents.get(CHAT)).toBeUndefined();
        expect([...impl.storage.chats.list()].filter(m => m.type === "agentNudge")).toHaveLength(1);
      });
    }
    expect(requests()).toBe(2);
  });

  it("claims the row, note, busy state and alarm before model lookup; recovery needs no browser", async () => {
    const requests = inference(), s = await scenario();
    const gate = Promise.withResolvers<void>();
    const lookup = vi.fn(async () => {
      await gate.promise;
      return {profile: USER, aiModel: MODEL};
    });
    await expect(s.visit(async impl => {
      modelLookup(impl, lookup);
      using client = await decisionClient(impl);
      await client.acceptConnectionRequest("1:connection", {gatekeeperId: 31});
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toEqual(MODEL.profile);
      expect(impl.storage.activeAgents.get(CHAT)?.initiatorUserId).toBe(s.user.id.toString());
      expect(await impl.ctx.storage.getAlarm()).not.toBeNull();
      expect([...impl.storage.chats.list()].filter(m => m.type === "agentNudge")).toHaveLength(1);
      await impl.ctx.storage.sync();
      expect(lookup).toHaveBeenCalledTimes(1);
      impl.ctx.abort("Injected reset after synchronous claim");
    })).rejects.toThrow(/Injected reset/);
    gate.resolve();
    await s.visit(async impl => {
      await impl.waitForAllAgentsToComplete();
      expect(impl.storage.activeAgents.get(CHAT)).toBeUndefined();
    });
    expect(requests()).toBe(1);
  });

  it("adopts a legacy pause and reports a missing/disabled model without failing its decision", async () => {
    const s = await scenario();
    const reason = "This model was disabled by an administrator.";
    await s.visit(async impl => {
      impl.storage.activeAgents.delete(CHAT); // The format main used for paused chats.
      modelLookup(impl, vi.fn().mockRejectedValue(new Error(reason)));
      using client = await decisionClient(impl);
      await expect(client.acceptConnectionRequest("1:connection", {gatekeeperId: 31})).resolves.toBeUndefined();
      await impl.waitForAllAgentsToComplete();
      expect([...impl.storage.chats.list()]).toContainEqual(expect.objectContaining({
        type: "connectionRequest", state: "accepted", gatekeeperId: 31,
      }));
      expect([...impl.storage.chats.list()]).toContainEqual(expect.objectContaining({
        type: "error", message: expect.stringContaining(reason),
      }));
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
      expect(impl.storage.activeAgents.get(CHAT)).toBeUndefined();
    });
  });

  it.each([1, 2])("always-approve drains and resumes a legacy pause with %i pending actions", async count => {
    const s = await scenario("action"), requests = inference();
    await s.visit(async impl => {
      impl.storage.activeAgents.delete(CHAT);
      modelLookup(impl, async () => ({profile: USER, aiModel: MODEL}));
      // Only the rule-setting path reads this record; applying the external effect is stubbed below.
      impl.storage.gatekeepers.put({id: 31, class: {} as any});
      const action = impl.storage.actions.get(7)!;
      if (action.type !== "action") throw new Error("Missing action");
      const actionKind = {tag: "edit", label: "Edits"};
      for (let i = 0; i < count; i++) {
        impl.storage.actions.put({...action, id: 7 + i, description: {
          ...action.description, autoApprovable: true, actionKind,
        }});
        if (i) impl.addChatMessages(CHAT, MODEL.profile, [{type: "action", actionId: 7 + i}]);
      }
      const apply = vi.spyOn(impl, "applyPendingAction").mockImplementation(async record => {
        impl.storage.actions.put({...record, state: "approved"});
      });
      let background: Promise<unknown> | undefined;
      using client = await decisionClient(impl, USER, {ctx: {
        id: impl.ctx.id, exports: impl.ctx.exports,
        waitUntil: (task: Promise<unknown>) => {
          background = task;
          void task.catch(() => {}); // Assert background failures through the captured promise.
        },
      }});
      await client.setAutoApprovedActionKind(31, actionKind);
      await background;
      expect(impl.storage.autoApproveTags.get("31:edit")?.enabledBy).toEqual(USER);
      expect(apply).toHaveBeenCalledTimes(count);
      await impl.waitForAllAgentsToComplete();
      expect([...impl.storage.actions.pendingByGatekeeper.get(31)]).toEqual([]);
      expect([...impl.storage.chats.list()].filter(m => m.type === "agentNudge")).toHaveLength(1);
      expect(impl.storage.activeAgents.get(CHAT)).toBeUndefined();
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
    });
    expect(requests()).toBe(1);
  });

  it("records a connection decision with no agent author without attempting a model lookup", async () => {
    const s = await scenario();
    await s.visit(async impl => {
      impl.storage.activeAgents.delete(CHAT);
      for (const msg of impl.storage.chats.list()) {
        if (msg.type === "connectionRequest") impl.storage.chats.put({...msg, author: USER});
      }
      const lookup = vi.fn(); modelLookup(impl, lookup);
      using client = await decisionClient(impl);
      await client.acceptConnectionRequest("1:connection", {gatekeeperId: 31});
      expect(lookup).not.toHaveBeenCalled();
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
    });
  });

  it.each([false, true])("keeps caller and model authority together (legacy pause: %s)", async legacy => {
    const s = await scenario(), requests = inference();
    await s.visit(async impl => {
      if (legacy) impl.storage.activeAgents.delete(CHAT);
      const gate = Promise.withResolvers<void>();
      const approver = {...USER, id: "approver", name: "Approver"};
      modelLookup(impl, async () => { await gate.promise; return {profile: USER, aiModel: MODEL}; });
      using client = await decisionClient(impl, approver);
      await client.acceptConnectionRequest("1:connection", {gatekeeperId: 31});
      const record = impl.storage.activeAgents.get(CHAT)!;
      expect(record.initiator).toEqual(legacy ? approver : USER);
      expect(record.initiatorUserId).toBe(legacy ? "owner-id" : s.user.id.toString());
      gate.resolve();
      await impl.waitForAllAgentsToComplete();
    });
    expect(requests()).toBe(1);
  });

  it("does not resume a collaborator whose original build authority was revoked", async () => {
    const s = await scenario(), requests = inference();
    await s.visit(async impl => {
      impl.ownerId = "another-user";
      const authorize = vi.spyOn(impl, "authorizeCollaborator").mockResolvedValue(null);
      decide(impl, "connection"); impl.resumeAgentAfterDecision(CHAT);
      await impl.waitForAllAgentsToComplete();
      expect(authorize).toHaveBeenCalledWith(USER.id, expect.anything(), {requireRole: "build"});
      expect(impl.storage.activeAgents.get(CHAT)).toBeUndefined();
      expect([...impl.storage.chats.list()]).toContainEqual(expect.objectContaining({
        type: "error", message: expect.stringContaining("no longer has build access"),
      }));
    });
    expect(requests()).toBe(0);
  });

  it("a stale model lookup cannot clear a successor's execution or post its error", async () => {
    const s = await scenario(), requests = inference();
    await s.visit(async impl => {
      const gate = Promise.withResolvers<void>(), setup = Promise.withResolvers<void>();
      const lookup = vi.fn(async () => { await gate.promise; throw new Error("Old model unavailable"); });
      modelLookup(impl, lookup);
      decide(impl, "connection"); impl.resumeAgentAfterDecision(CHAT);
      impl.destroyLiveChat(CHAT);
      const successor = {...MODEL, profile: {...MODEL.profile, id: "successor-model"}};
      const meta = impl.storage.chatMeta.get(CHAT)!;
      impl.storage.chatMeta.put({...meta, activeAgent: successor.profile});
      vi.spyOn(impl, "reconcilePendingGadgets").mockImplementationOnce(() => setup.promise);
      const errors = vi.spyOn(impl.logger, "error");
      impl.startAgent(CHAT, successor, USER, s.user.id.toString());
      gate.resolve();
      await vi.waitFor(() => expect(errors).toHaveBeenCalled());
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toEqual(successor.profile);
      expect(impl.storage.activeAgents.get(CHAT)?.modelId).toBe(successor.profile.id);
      expect([...impl.storage.chats.list()].filter(m => m.type === "error")).toEqual([]);
      setup.resolve();
      await impl.waitForAllAgentsToComplete();
    });
    expect(requests()).toBe(1);
  });

  it.each([
    {kind: "connection", initiator: USER},
    {kind: "action", initiator: USER},
    {kind: "connection", initiator: {type: "gadget", id: "source", name: "Source"}},
  ] as const)("recovers a $kind pause from a $initiator.type turn and notifies its original caller",
      async ({kind, initiator}) => {
    const notifications = recordNotifications(), requests = inference();
    const s = await scenario(kind, true, initiator);
    // A second eviction of an already-idle pause must not announce it again.
    for (let i = 0; i < 2; i++) {
      await evictDurableObject(s.stub);
      await s.visit(async impl => {
        await impl.waitForAllAgentsToComplete();
        expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
        expect(impl.storage.activeAgents.get(CHAT)?.initiatorUserId).toBe(s.user.id.toString());
        expect(await impl.ctx.storage.getAlarm()).toBeNull();
      });
    }
    await vi.waitFor(() => expect(notifications).toEqual([[s.user.id.toString(), expect.objectContaining({
      kind: "permissionRequested", workspaceId: s.stub.id.toString(), chatId: CHAT, chatTitle: "Resume",
    })]]));
    expect(requests()).toBe(0);
  });

  it.each([USER, {type: "gadget" as const, id: "source", name: "Source"}])(
      "recovers a $type turn's final response, notifying only a person, without inference", async initiator => {
    const notifications = recordNotifications(), requests = inference();
    const s = await scenario("connection", true, initiator);
    await s.visit(impl => {
      decide(impl, "connection");
      impl.addChatMessages(CHAT, MODEL.profile, [{type: "message", message: "Already done."}]);
    });
    await evictDurableObject(s.stub);
    await s.visit(async impl => {
      await impl.waitForAllAgentsToComplete();
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
      expect(impl.storage.activeAgents.get(CHAT)).toBeUndefined();
      expect([...impl.storage.chats.list()].at(-1)).toEqual(expect.objectContaining({
        type: "message", message: "Already done.",
      }));
    });
    if (initiator.type === "user") {
      await vi.waitFor(() => expect(notifications).toEqual([[s.user.id.toString(), expect.objectContaining({
        kind: "taskCompleted", workspaceId: s.stub.id.toString(), chatId: CHAT, chatTitle: "Resume",
      })]]));
    } else {
      expect(notifications).toEqual([]);
    }
    expect(requests()).toBe(0);
  });

  it("recovers a final response with steers it never read by answering them", async () => {
    const requests = inference(), s = await scenario("connection", true);
    await s.visit(impl => {
      decide(impl, "connection");
      impl.addChatMessages(CHAT, MODEL.profile, [{type: "message", message: "Already done."}]);
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(CHAT)!,
        queuedSteers: [{text: "Make it dark.", author: USER}]});
    });
    await evictDurableObject(s.stub);
    await s.visit(async impl => {
      await impl.waitForAllAgentsToComplete();
      const [steer, answer] = [...impl.storage.chats.list()].slice(-2);
      expect(steer).toEqual(expect.objectContaining({type: "message", author: USER, message: "Make it dark."}));
      expect(steer).not.toHaveProperty("steered");
      expect(answer).toEqual(expect.objectContaining({type: "message", message: "Done."}));
      expect(impl.storage.chatMeta.get(CHAT)?.queuedSteers).toBeUndefined();
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
    });
    expect(requests()).toBe(1);
  });

  it("recovers a steer read after the final response without replaying an earlier approval", async () => {
    const requests = inference(), s = await scenario("action", true);
    await s.visit(impl => {
      decide(impl, "action");
      impl.addChatMessages(CHAT, MODEL.profile, [{type: "message", message: "Already done."}]);
      impl.addChatMessages(CHAT, USER, [{type: "message", message: "Make it dark.", steered: true}]);
    });
    await evictDurableObject(s.stub);
    await s.visit(async impl => {
      await impl.waitForAllAgentsToComplete();
      const log = [...impl.storage.chats.list()];
      expect(log.filter(m => m.type === "agentNudge")).toEqual([]);
      expect(log.at(-1)).toEqual(expect.objectContaining({type: "message", message: "Done."}));
    });
    expect(requests()).toBe(1);
  });

  it.each(["final response", "pending decision"] as const)(
      "recovers /compact after eviction without inheriting the preceding %s", async previous => {
    const s = await scenario("connection", true), requests = inference();
    await s.visit(impl => {
      if (previous === "final response") {
        decide(impl, "connection");
        impl.addChatMessages(CHAT, MODEL.profile, [{type: "message", message: "Already done."}]);
      }
      // Built-in commands commit a slashCommand event with no accompanying user message.
      impl.addChatMessages(CHAT, USER, [{type: "slashCommand",
        request: {id: {builtin: true, commandId: "compact"}, args: ""}}]);
    });
    await evictDurableObject(s.stub);
    await s.visit(async impl => {
      await impl.waitForAllAgentsToComplete();
      // An unresolved decision still protects its history from compaction, but must not make
      // this new command recover as the old paused execution.
      expect(impl.getActiveChatCompaction(CHAT)?.summary).toBe(
          previous === "final response" ? "Done." : undefined);
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
      expect(impl.storage.activeAgents.get(CHAT)).toBeUndefined();
      expect([...impl.storage.chats.list()].filter(m => m.type === "error")).toEqual([]);
    });
    expect(requests()).toBe(previous === "final response" ? 1 : 0); // Summary only, if compactable.
  });

  it("waits for both kinds of decision and consumes the handoff only once", async () => {
    const requests = inference(), s = await scenario("action");
    await s.visit(async impl => {
      request(impl, "connection");
      decide(impl, "action"); impl.resumeAgentAfterDecision(CHAT, 7);
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
      decide(impl, "connection"); impl.resumeAgentAfterDecision(CHAT, "1:connection");
      impl.resumeAgentAfterDecision(CHAT, 7);
      await impl.waitForAllAgentsToComplete();
      impl.resumeAgentAfterDecision(CHAT, "1:connection");
      expect([...impl.storage.chats.list()].filter(m => m.type === "agentNudge")).toHaveLength(1);
    });
    expect(requests()).toBe(1);
  });

  it("claims an early approval as teardown releases the previous execution", async () => {
    const requests = inference(), s = await scenario();
    await s.visit(async impl => {
      // A completed request step has committed; hold the turn's final reconciliation open.
      const reconcile = impl.reconcilePendingGadgets.bind(impl);
      const commit = impl.commitAgentStep.bind(impl);
      const cleanup = Promise.withResolvers<void>();
      let committed = false, held = false;
      vi.spyOn(impl, "commitAgentStep").mockImplementation(async (...args) => {
        await commit(...args);
        if (!committed) { committed = true; request(impl, "connection", "1:second"); }
      });
      vi.spyOn(impl, "reconcilePendingGadgets").mockImplementation(async id => {
        if (committed && !held) { held = true; await cleanup.promise; }
        await reconcile(id);
      });
      // Start after consuming the fixture's old request, as a genuine resumed execution would.
      decide(impl, "connection"); impl.resumeAgentAfterDecision(CHAT);
      await vi.waitFor(() => expect(held).toBe(true));
      decide(impl, "connection"); impl.resumeAgentAfterDecision(CHAT);
      expect(requests()).toBe(1);
      cleanup.resolve();
      await impl.waitForAllAgentsToComplete();
      expect(requests()).toBe(2);
      expect(impl.storage.activeAgents.get(CHAT)).toBeUndefined();
    });
  });

  it.each(["stop", "delete"] as const)("does not revive after %s during model lookup", async operation => {
    const requests = inference(), s = await scenario();
    const gate = Promise.withResolvers<void>();
    const lookup = vi.fn(async () => {
      await gate.promise; return {profile: USER, aiModel: MODEL};
    });
    await s.visit(async impl => {
      modelLookup(impl, lookup);
      decide(impl, "connection"); impl.resumeAgentAfterDecision(CHAT);
      await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
      if (operation === "stop") impl.cancelAgent(CHAT);
      else { impl.storage.chatMeta.delete(CHAT); impl.destroyLiveChat(CHAT); }
      gate.resolve();
      await impl.waitForAllAgentsToComplete();
      expect(impl.storage.activeAgents.get(CHAT)).toBeUndefined();
      impl.resumeAgentAfterDecision(CHAT);
    });
    expect(requests()).toBe(0);
  });

  it("caps lookup failures even when unrelated activity resets the alarm retry count", async () => {
    const s = await scenario();
    const error = Object.assign(new Error("reset"), {durableObjectReset: true});
    const lookup = vi.fn().mockRejectedValue(error);
    await s.visit(async impl => {
      modelLookup(impl, lookup);
      decide(impl, "connection"); impl.resumeAgentAfterDecision(CHAT);
      await impl.waitForAllAgentsToComplete();
      expect(impl.storage.activeAgents.get(CHAT)?.resumeAttempts).toBe(1);
      for (let attempt = 2; attempt <= 4; attempt++) {
        await impl.ctx.storage.deleteAlarm(); // The platform consumed the scheduled alarm.
        if (attempt < 4) {
          await expect(impl.runAlarmTasks(0)).rejects.toThrow("reset");
          expect(impl.storage.activeAgents.get(CHAT)?.resumeAttempts).toBe(attempt);
          // An unrelated response-delivery pass recomputes the shared alarm, resetting its
          // platform retry count. It must not reset this execution's budget.
          await impl.deliverReadyExternalMessageResponses();
          expect(await impl.ctx.storage.getAlarm()).not.toBeNull();
        } else {
          await expect(impl.runAlarmTasks(0)).resolves.toBeUndefined();
        }
      }
      expect(impl.storage.activeAgents.get(CHAT)).toBeUndefined();
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
      expect(lookup).toHaveBeenCalledTimes(8); // One fresh-stub read retry per attempt.
    });
  });

  it("does not retry a live object shedding load", async () => {
    const s = await scenario();
    const lookup = vi.fn().mockRejectedValue(
        Object.assign(new Error("overloaded"), {retryable: true, overloaded: true}));
    await s.visit(async impl => {
      modelLookup(impl, lookup);
      decide(impl, "connection"); impl.resumeAgentAfterDecision(CHAT);
      await impl.waitForAllAgentsToComplete();
      expect(impl.storage.activeAgents.get(CHAT)).toBeUndefined();
      expect(lookup).toHaveBeenCalledTimes(1);
    });
  });

  it("clears the lookup budget before running inference", async () => {
    const s = await scenario(), gate = Promise.withResolvers<void>(), requests = inference(gate.promise);
    await s.visit(async impl => {
      const error = Object.assign(new Error("reset"), {durableObjectReset: true});
      modelLookup(impl, vi.fn().mockRejectedValueOnce(error).mockRejectedValueOnce(error)
        .mockResolvedValue({profile: USER, aiModel: MODEL}));
      decide(impl, "connection"); impl.resumeAgentAfterDecision(CHAT);
      await impl.waitForAllAgentsToComplete();
      expect(impl.storage.activeAgents.get(CHAT)?.resumeAttempts).toBe(1);
      const alarm = impl.runAlarmTasks();
      await vi.waitFor(() => expect(requests()).toBe(1));
      expect(impl.storage.activeAgents.get(CHAT)?.resumeAttempts).toBeUndefined();
      gate.resolve();
      await alarm;
    });
  });

  it("Stop clears a retry handoff that no longer has a running task", async () => {
    const s = await scenario();
    await s.visit(async impl => {
      modelLookup(impl, vi.fn().mockRejectedValue(
          Object.assign(new Error("reset"), {durableObjectReset: true})));
      decide(impl, "connection"); impl.resumeAgentAfterDecision(CHAT);
      await impl.waitForAllAgentsToComplete();
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeDefined();
      impl.cancelAgent(CHAT);
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
      expect(impl.storage.activeAgents.get(CHAT)).toBeUndefined();
      expect(await impl.ctx.storage.getAlarm()).toBeNull();
      await expect(impl.runAlarmTasks()).resolves.toBeUndefined();
    });
  });

  it("honors the execution's budget when its lookup started before the alarm", async () => {
    const s = await scenario();
    await s.visit(async impl => {
      const gate = Promise.withResolvers<void>();
      const lookup = vi.fn(async () => {
        await gate.promise;
        throw Object.assign(new Error("reset"), {durableObjectReset: true});
      });
      modelLookup(impl, lookup);
      impl.storage.activeAgents.put({...impl.storage.activeAgents.get(CHAT)!, resumeAttempts: 3});
      decide(impl, "connection"); impl.resumeAgentAfterDecision(CHAT);
      const alarm = impl.runAlarmTasks(0);
      gate.resolve();
      await alarm;
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(impl.storage.activeAgents.get(CHAT)).toBeUndefined();
    });
  });

  it("persists the attempt before lookup and bounds retries across a real reset", async () => {
    const s = await scenario(), requests = inference(), gate = Promise.withResolvers<void>();
    await expect(s.visit(async impl => {
      impl.storage.activeAgents.put({...impl.storage.activeAgents.get(CHAT)!, resumeAttempts: 3});
      modelLookup(impl, async () => { await gate.promise; return {profile: USER, aiModel: MODEL}; });
      decide(impl, "connection"); impl.resumeAgentAfterDecision(CHAT);
      expect(impl.storage.activeAgents.get(CHAT)?.resumeAttempts).toBe(4);
      await impl.ctx.storage.sync();
      impl.ctx.abort("Injected reset during last model lookup");
    })).rejects.toThrow(/Injected reset/);
    gate.resolve();
    await s.visit(async impl => {
      await impl.waitForAllAgentsToComplete();
      expect(impl.storage.activeAgents.get(CHAT)).toBeUndefined();
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
      expect([...impl.storage.chats.list()]).toContainEqual(expect.objectContaining({
        type: "error", message: expect.stringContaining("interrupted too many times"),
      }));
    });
    expect(requests()).toBe(0);
  });

  it("clears a stopped lookup's orphaned busy marker after a real reset", async () => {
    const s = await scenario(), requests = inference(), gate = Promise.withResolvers<void>();
    await expect(s.visit(async impl => {
      modelLookup(impl, async () => { await gate.promise; return {profile: USER, aiModel: MODEL}; });
      decide(impl, "connection"); impl.resumeAgentAfterDecision(CHAT);
      impl.cancelAgent(CHAT);
      expect(impl.storage.activeAgents.get(CHAT)).toBeUndefined();
      await impl.ctx.storage.sync();
      impl.ctx.abort("Injected reset before stopped lookup cleanup");
    })).rejects.toThrow(/Injected reset/);
    gate.resolve();
    await s.visit(impl => {
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
      expect(() => impl.assertChatNotActive(CHAT)).not.toThrow();
    });
    expect(requests()).toBe(0);
  });

  it("re-arms failed response delivery after the platform's last retry, then recovers", async () => {
    const s = await scenario(), name = crypto.randomUUID();
    await s.visit(async impl => {
      impl.storage.activeAgents.delete(CHAT);
      // Mint in the storing DO's invocation, not through a test-pool wrapper or another DO.
      using target: RpcStub<FakeChatResponseTarget> = await impl.ctx.restore({
        type: "test-response-target", name,
      });
      await target.setAvailable(false);
      impl.storage.gadgetResponseDeliveries.put({idempotencyKey: "external-response", chatId: CHAT,
        promptSequence: 0, createdAt: Date.now(), status: "ready", responseText: "Done.",
        chatGatewayRpcTarget: target});
      for (let retry = 0; retry <= 6; retry++) {
        await impl.ctx.storage.deleteAlarm();
        await expect(impl.runAlarmTasks(retry)).rejects.toThrow("Response target unavailable");
        expect(impl.storage.gadgetResponseDeliveries.get("external-response")?.status).toBe("ready");
      }
      const next = await impl.ctx.storage.getAlarm();
      expect(next).toBeGreaterThan(Date.now()); // Avoid an immediate failure loop.
      await target.setAvailable(true);
      await impl.runAlarmTasks();
      expect(await target.calls()).toBe(8);
      expect(impl.storage.gadgetResponseDeliveries.get("external-response")?.status).toBe("delivered");
      expect(await impl.ctx.storage.getAlarm()).toBeGreaterThan(next!); // Retention sweep only.
    });
  });

  it("preserves the scheduled alarm while constructor recovery is running", async () => {
    const s = await scenario("connection", true), gate = Promise.withResolvers<void>();
    const requests = inference(gate.promise);
    const scheduled = Date.now() + 5000;
    await s.visit(async impl => {
      decide(impl, "connection");
      impl.addChatMessages(CHAT, USER, [{type: "agentNudge", text: "Continue."}]);
      await impl.ctx.storage.setAlarm(scheduled);
    });
    await evictDurableObject(s.stub);
    await s.visit(async impl => {
      await vi.waitFor(() => expect(requests()).toBe(1));
      expect(await impl.ctx.storage.getAlarm()).toBe(scheduled);
      gate.resolve();
      await impl.waitForAllAgentsToComplete();
    });
  });

  it("an explicit retry does not recover the previous segment's unanswered request", async () => {
    const s = await scenario(), requests = inference();
    const setup = Promise.withResolvers<void>();
    await expect(s.visit(async impl => {
      vi.spyOn(impl, "reconcilePendingGadgets").mockImplementationOnce(() => setup.promise);
      using client = await decisionClient(impl);
      await client.retryAgent(CHAT, MODEL.profile.id);
      expect([...impl.storage.chats.list()].at(-1)?.type).toBe("agentNudge");
      await impl.ctx.storage.sync();
      impl.ctx.abort("Injected reset after explicit retry");
    })).rejects.toThrow(/Injected reset/);
    setup.resolve();
    await s.visit(async impl => {
      await impl.waitForAllAgentsToComplete();
      expect(impl.storage.activeAgents.get(CHAT)).toBeUndefined();
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
    });
    expect(requests()).toBe(1);
  });

  it.each([false, true])("claims an awaited action inside the apply path (auto-approved: %s)", async auto => {
    const s = await scenario("action"), requests = inference();
    await s.visit(async impl => {
      const gate = Promise.withResolvers<void>();
      modelLookup(impl, async () => { await gate.promise; return {profile: USER, aiModel: MODEL}; });
      const apply = vi.fn(async () => {});
      vi.spyOn(impl, "getGatekeeperFacet").mockResolvedValue({applyAction: apply} as unknown as
          Awaited<ReturnType<Impl["getGatekeeperFacet"]>>);
      const action = impl.storage.actions.get(7)!;
      if (action.type !== "action") throw new Error("Missing action");
      await impl.applyPendingAction(action, USER, auto);
      expect(impl.storage.actions.get(7)?.state).toBe("approved");
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toEqual(MODEL.profile);
      expect([...impl.storage.chats.list()].at(-1)?.type).toBe("agentNudge");
      expect(apply).toHaveBeenCalledTimes(1);
      gate.resolve();
      await impl.waitForAllAgentsToComplete();
    });
    expect(requests()).toBe(1);
  });
});
