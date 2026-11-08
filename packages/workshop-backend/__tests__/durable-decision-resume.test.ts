import { env, RpcStub } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import * as fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionState, AiChatAuthorInfo, UserNotification } from "@gadgets/workshop-shared/api";
import { PROPERTY_RUN_OPTIONS } from "@gadgets/scripts/property-runs";
import type { OverseerDurableObject } from "../src/overseer";
import { UserDurableObject } from "../src/user";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations";
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

// Answers each model request with "Done.", or, while `stages()` holds, with an executeCode call.
function inference(gate?: Promise<void>, stages = () => false) {
  let count = 0;
  const fetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== MODEL.config.apiUrl) return fetch(input, init);
    count++;
    const call = stages();
    const events = [
      {type: "message_start", message: {id: "resume", type: "message", role: "assistant",
        model: MODEL.profile.id, content: [], stop_reason: null, stop_sequence: null,
        usage: {input_tokens: 1, output_tokens: 1}}},
      {type: "content_block_start", index: 0, content_block: call
        ? {type: "tool_use", id: `stage-${count}`, name: "executeCode", input: {}} : {type: "text", text: ""}},
      {type: "content_block_delta", index: 0, delta: call
        ? {type: "input_json_delta", partial_json: `{"code": "stage"}`} : {type: "text_delta", text: "Done."}},
      {type: "content_block_stop", index: 0},
      {type: "message_delta", delta: {stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null},
        usage: {output_tokens: 1}},
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

async function scenario(kind: Kind | null = "connection", active = false, initiator: AiChatAuthorInfo = USER) {
  const stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const user = env.TEST_USER.getByName(crypto.randomUUID());
  await runInDurableObject(user, instance => {
    instance["storage"].profile.put(USER);
    instance["storage"].aiModels.put(MODEL);
  });
  await user.newWorkspace(stub.id.toString(), "Resume");
  const visit = <T>(fn: (impl: Impl) => T | Promise<T>) =>
    runInDurableObject(env.TEST_OVERSEER.get(stub.id), ({impl}) => fn(impl));
  await visit(impl => {
    impl.storage.version.put(OVERSEER_STORAGE_VERSION);
    impl.storage.ownerId.put(user.id.toString());
    impl.ownerId = user.id.toString();
  });
  await visit(impl => {
    const timestamp = impl.getChatTimestamp();
    impl.storage.chatMeta.put({id: CHAT, title: "Resume", started: timestamp, lastActive: timestamp,
      ...(active ? {activeAgent: MODEL.profile} : {})});
    impl.storage.chatContext.put({chatId: CHAT, bindings: {}, alwaysAvailableCapsuleIds: []});
    if (!kind) return;  // A new chat.
    impl.addChatMessages(CHAT, USER, [{type: "message", message: "Do the work"}]);
    request(impl, kind);
    impl.storage.activeAgents.put({chatId: CHAT, modelId: MODEL.profile.id,
      initiatorUserId: user.id.toString(), initiator, callbackInitiated: initiator.type === "gadget"});
  });
  return {stub, user, visit};
}

async function reset(stub: DurableObjectStub<OverseerDurableObject>) {
  // Crash the source even if owned-workspace background I/O is still in flight. Idle eviction
  // waits for that I/O; these cases exercise recovery of the committed execution row instead.
  await expect(runInDurableObject(env.TEST_OVERSEER.get(stub.id), (_, ctx) => {
    ctx.abort("Injected decision recovery reset");
  })).rejects.toThrow("Injected decision recovery reset");
}

// A gatekeeper class cannot be minted in a test: record connection 31 with one the workspace
// never instantiates, and answer what a decision asks of its facet.
function fakeGatekeeper(impl: Impl, applyAction: () => Promise<void> = async () => {}) {
  impl.storage.gatekeepers.put({id: 31, class: {} as any});
  vi.spyOn(impl, "getGatekeeperFacet").mockResolvedValue({applyAction, rejectAction: async () => {}} as
      unknown as Awaited<ReturnType<Impl["getGatekeeperFacet"]>>);
}

function decisionClient(impl: Impl, profile = USER, overrides: object = {}) {
  const userId = profile.id === USER.id ? impl.ownerId : env.TEST_USER.idFromName(profile.id).toString();
  return openFakeOverseer(impl.storage, {ownerId: impl.ownerId, userId, impl: {
    users: {idFromString: (id: string) => id,
      get: (id: string) => ({id: {toString: () => id}, whoami: async () => profile,
        getChatContext: async () => ({profile: USER, aiModel: MODEL}), recordSharedWorkspaceOpen: async () => {}})},
    nextChatSequencePeek: impl.nextChatSequencePeek.bind(impl),
    chatHead: impl.chatHead.bind(impl),
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
  impl.users = new Proxy(impl.users, {
    get(target, key) {
      if (key === "idFromString") return (id: string) => target.idFromString(id);
      if (key === "get") return (id: DurableObjectId) => new Proxy(target.get(id), {
        get(user, method) {
          if (method === "getChatContext") return lookup;
          if (method === "publishNotification") return async () => {};
          return Reflect.get(user, method);
        },
      });
      return Reflect.get(target, key);
    },
  });
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
      await reset(s.stub);
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
      fakeGatekeeper(impl);
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
      impl.storage.collaborators.put({profile: approver,
        addedBy: [{type: "user", sharer: USER.id, role: "build", created: new Date()}]});
      modelLookup(impl, async () => { await gate.promise; return {profile: USER, aiModel: MODEL}; });
      using client = await decisionClient(impl, approver);
      await client.acceptConnectionRequest("1:connection", {gatekeeperId: 31});
      const record = impl.storage.activeAgents.get(CHAT)!;
      expect(record.initiator).toEqual(legacy ? approver : USER);
      expect(record.initiatorUserId).toBe(legacy
        ? env.TEST_USER.idFromName(approver.id).toString() : s.user.id.toString());
      expect(env.TEST_USER.idFromName(approver.id).toString()).not.toBe(s.user.id.toString());
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
      expect(authorize).toHaveBeenCalledWith(USER.id, expect.anything(), {requireBuild: true});
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
    // Idle eviction after crash recovery must not announce the same pause again.
    for (let i = 0; i < 2; i++) {
      if (i === 0) await reset(s.stub);
      else await evictDurableObject(s.stub);
      await s.visit(async impl => {
        await impl.waitForAllAgentsToComplete();
        expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
        expect(impl.storage.activeAgents.get(CHAT)?.initiatorUserId).toBe(s.user.id.toString());
        await impl.deliverDirtyChats();
        expect(await impl.ctx.storage.getAlarm()).toBeNull();
      });
    }
    await vi.waitFor(() => expect(notifications.filter(([, event]) => event.workspaceId === s.stub.id.toString()))
      .toEqual([[s.user.id.toString(), expect.objectContaining({
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
    await reset(s.stub);
    await s.visit(async impl => {
      await impl.waitForAllAgentsToComplete();
      expect(impl.storage.chatMeta.get(CHAT)?.activeAgent).toBeUndefined();
      expect(impl.storage.activeAgents.get(CHAT)).toBeUndefined();
      expect([...impl.storage.chats.list()].at(-1)).toEqual(expect.objectContaining({
        type: "message", message: "Already done.",
      }));
    });
    if (initiator.type === "user") {
      await vi.waitFor(() => expect(notifications.filter(([, event]) => event.workspaceId === s.stub.id.toString()))
        .toEqual([[s.user.id.toString(), expect.objectContaining({
        kind: "taskCompleted", workspaceId: s.stub.id.toString(), chatId: CHAT, chatTitle: "Resume",
      })]]));
    } else {
      expect(notifications.filter(([, event]) => event.workspaceId === s.stub.id.toString())).toEqual([]);
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
    await reset(s.stub);
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
    await reset(s.stub);
    await s.visit(async impl => {
      await impl.waitForAllAgentsToComplete();
      const log = [...impl.storage.chats.list()];
      expect(log.filter(m => m.type === "agentNudge")).toEqual([]);
      expect(log.at(-1)).toEqual(expect.objectContaining({type: "message", message: "Done."}));
    });
    expect(requests()).toBe(1);
  });

  it.each(["final response", "pending decision"] as const)(
      "recovers /compact after reset without inheriting the preceding %s", async previous => {
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
    await reset(s.stub);
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
      // The shared alarm may still cover unread fanout, independently of the cancelled agent.
      await impl.deliverDirtyChats();
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
      // Set the platform alarm after unrelated unread delivery has settled.
      await impl.deliverDirtyChats();
      await impl.ctx.storage.setAlarm(scheduled);
    });
    await reset(s.stub);
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
      fakeGatekeeper(impl, apply);
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

// ---------------------------------------------------------------------------------------------
// Property: a turn that staged writes carries on exactly once. fast-check generates what a user
// does around a chat whose agent writes through one connection: prompt it (the turn stages one to
// three awaited writes, each auto-approvable or not), approve or reject a pending write, in any
// order, and switch the connection's "always approve" rule on or off, in sessions with a workspace
// restart between them, while the provider may fail an apply. Each step goes through the session's
// RPC interface. After every step the model requests made, the "approved" notes sent to the agent
// and every write's state are checked against a model: a hung chat is a request that never came,
// a double resume one too many.
//
// The model keeps the writes in submission order, the rule, and the writes the latest turn waits
// on. Writes apply as auto-approval.ts documents: an approval applies its own write; after it, and
// after a rejection, the rule being switched on, or an auto-approvable write being staged under
// it, the pending writes the rule covers apply in order, up to the first that needs a person or
// fails. A turn makes one more request once everything it staged is approved: within its step and
// without a note if that all auto-applies, whether before the step ends or after; else as a resume,
// when the last approval lands. A rejected write ends the wait for good, as does a newer prompt.
//
// Left out: concurrent decisions (pinned in integration-tests' workshop-agent-actions.test.ts),
// and an apply that fails while the step that staged its write still runs, whose turn carries on
// regardless (see #drainAutoApprovalsAndResume). Scenarios a seed might miss are pinned as
// `examples`.

const EDITS = {tag: "edit", label: "Edits"};

// `writes` holds each staged write's auto-approval verdict. `late` lands the auto-applies after
// the step that staged them has ended, rather than while its tool still runs. `pick` chooses among
// the pending writes, oldest first, modulo their count. `fail` is which of the step's apply
// attempts the provider fails, from 1 (0: none).
type Step =
  | {kind: "prompt"; writes: boolean[]; late: boolean}
  | {kind: "approve" | "reject"; pick: number; fail: number}
  | {kind: "rule"; on: boolean; fail: number};

class ResumeModel {
  states: ActionState[] = [];
  auto: boolean[] = [];
  rule = false;
  /** The writes the latest turn is suspended on. */
  waiting: number[] = [];
  requests = 0;
  nudges = 0;
  fail = 0;

  #apply(i: number): boolean {
    if (--this.fail === 0) return false;
    this.states[i] = "approved";
    return true;
  }

  #drain() {
    for (const [i, state] of this.states.entries()) {
      if (state === "pending" && !(this.rule && this.auto[i] && this.#apply(i))) return;
    }
  }

  #carryOn(resumed: boolean) {
    if (this.waiting.some(i => this.states[i] === "rejected")) {
      this.waiting = [];
    } else if (this.waiting.length && this.waiting.every(i => this.states[i] === "approved")) {
      this.waiting = [];
      this.requests++;
      if (resumed) this.nudges++;
    }
  }

  prompt(writes: boolean[]) {
    this.requests++;  // The step that stages the writes.
    this.waiting = writes.map((_, i) => this.states.length + i);
    for (const auto of writes) {
      this.states.push("pending");
      this.auto.push(auto);
      if (this.rule && auto) this.#drain();
    }
    this.#carryOn(false);
  }

  /** False when the provider failed the approval, which leaves the write pending. */
  approve(i: number): boolean {
    const applied = this.#apply(i);
    if (applied) this.#drain();
    this.#carryOn(true);
    return applied;
  }

  reject(i: number) {
    this.states[i] = "rejected";
    this.#drain();
    this.#carryOn(true);
  }

  setRule(on: boolean) {
    this.rule = on;
    if (on) this.#drain();
    this.#carryOn(true);
  }
}

// Replays a run, one session after another, on a fresh workspace and account.
async function replayDecisions(sessions: Step[][]) {
  vi.unstubAllGlobals();  // The previous run's provider.
  const s = await scenario(null), model = new ResumeModel();
  // The writes the next executeCode call stages. Until it has, the provider answers with that call.
  let staged: boolean[] | undefined;
  let landing: PromiseWithResolvers<void> | undefined, fail = 0, at = 0;
  const requests = inference(undefined, () => staged !== undefined);
  // A decision finishes in the background (the drain, and the turn it resumes), so a check first
  // waits for everything the workspace has started.
  const background: Promise<unknown>[] = [];
  const check = (label: string) => s.visit(async impl => {
    await impl.waitForAllAgentsToComplete();  // A late apply lands once its step is over.
    landing?.resolve();
    landing = undefined;
    do {
      await Promise.allSettled(background.splice(0));
      await impl.waitForAllAgentsToComplete();
    } while (background.length);
    expect({
      states: [...impl.storage.actions.list()].map(action => action.state),
      requests: requests(),
      nudges: [...impl.storage.chats.list()].filter(m => m.type === "agentNudge").length,
      busy: impl.storage.chatMeta.get(CHAT)?.activeAgent !== undefined,
    }, label).toEqual({states: model.states, requests: model.requests, nudges: model.nudges, busy: false});
  });

  for (const [session, steps] of sessions.entries()) {
    if (session) await reset(s.stub);
    await s.visit(impl => {
      const waitUntil = impl.ctx.waitUntil.bind(impl.ctx);
      vi.spyOn(impl.ctx, "waitUntil").mockImplementation(task => { background.push(task); waitUntil(task); });
      fakeGatekeeper(impl, async () => {
        await landing?.promise;
        if (--fail === 0) throw new Error("The provider failed.");
      });
      // Stands in for the sandbox and the connection's session, which stage through submitAction.
      vi.spyOn(impl, "executeCodeMode").mockImplementation(async chatId => {
        const writes = staged!.entries(), started = background.length;
        staged = undefined;
        for (const [action, autoApprovable] of writes) {
          await impl.submitAction(31, action, {title: `Write ${action}`, description: "",
            implementsRevert: false, awaitDecision: true, autoApprovable, actionKind: EDITS},
            {from: "agent", chatId});
        }
        if (!landing) await Promise.allSettled(background.slice(started));
        return "Staged.";
      });
    });
    using closed = new RpcStub(() => {});
    using client = await env.TEST_OVERSEER.get(s.stub.id).open(s.user.id.toString(), USER.id, closed);
    await check(`session ${session} opens`);
    for (const step of steps) {
      const label = `step ${at++} ${JSON.stringify(step)}`;
      const pending = model.states.flatMap((state, i) => state === "pending" ? [i] : []);
      model.fail = fail = step.kind === "prompt" ? 0 : step.fail;
      if (step.kind === "prompt") {
        staged = step.writes;
        if (step.late) landing = Promise.withResolvers();
        await client.sendChatMessage(CHAT, "Write it.", MODEL.profile.id);
        model.prompt(step.writes);
      } else if (step.kind === "rule") {
        await (step.on ? client.setAutoApprovedActionKind(31, EDITS)
            : client.removeAutoApprovedActionKind(31, EDITS.tag));
        model.setRule(step.on);
      } else if (pending.length) {
        const nth = step.pick % pending.length, write = pending[nth];
        // The ledger lists the newest first, under ids of its own.
        const {id} = (await client.listActions({filter: "pending"})).entries.toReversed()[nth];
        if (step.kind === "approve") {
          expect(await client.approveAction(id).then(() => true, () => false), `${label}: applied`)
              .toBe(model.approve(write));
        } else {
          await client.rejectAction(id);
          model.reject(write);
        }
      }
      await check(label);
    }
    await s.visit(impl => impl.ctx.storage.sync());  // What a restart must not lose.
  }
}

describe("decisions on a turn's staged writes, for generated sessions", () => {
  const RULE_ON: Step = {kind: "rule", on: true, fail: 0};
  const fail = fc.constantFrom(0, 0, 0, 0, 1, 2);
  const pick = fc.nat({max: 5});
  const prompt = fc.record({kind: fc.constant("prompt" as const),
    writes: fc.array(fc.boolean(), {minLength: 1, maxLength: 3}), late: fc.boolean()});
  // Mostly approvals, so that waits often run to their resume.
  const step: fc.Arbitrary<Step> = fc.oneof(
    {weight: 8, arbitrary: fc.record({kind: fc.constant("approve" as const), pick, fail})},
    {weight: 1, arbitrary: fc.record({kind: fc.constant("reject" as const), pick, fail})},
    {weight: 3, arbitrary: fc.record({kind: fc.constant("rule" as const),
      on: fc.constantFrom(true, true, false), fail})},
    {weight: 2, arbitrary: prompt},
  );
  // A run opens on a prompt, as often as not with the rule already on, so that turns whose writes
  // all auto-apply are common. The workspace restarts between a run's sessions.
  const sessions = fc.tuple(fc.boolean(), prompt,
      fc.array(fc.array(step, {maxLength: 6}), {minLength: 1, maxLength: 3}))
      .map(([ruled, first, [session, ...later]]): Step[][] =>
          [[...ruled ? [RULE_ON] : [], first, ...session], ...later]);

  const examples: [Step[][]][] = [
    // "Always approve" applies the first of two held writes and fails on the second, which the
    // user approves after a restart: one resume, at the second.
    [[
      [{kind: "prompt", writes: [true, true], late: false}, {kind: "rule", on: true, fail: 2}],
      [{kind: "approve", pick: 0, fail: 0}],
    ]],
    // A newer turn's auto-approvable write queues behind an older turn's held one, so that turn
    // suspends too. Rejecting the older write applies the newer and resumes its turn.
    [[[
      {kind: "prompt", writes: [false], late: false}, RULE_ON,
      {kind: "prompt", writes: [true], late: true}, {kind: "reject", pick: 0, fail: 0},
    ]]],
    // A rejection ends the wait: after a restart, neither approving another of the turn's writes,
    // at the second attempt, nor always-approving the last resumes it.
    [[
      [{kind: "prompt", writes: [false, true, true], late: false}, {kind: "reject", pick: 0, fail: 0}],
      [{kind: "approve", pick: 0, fail: 1}, {kind: "approve", pick: 0, fail: 0}, RULE_ON],
    ]],
    // Writes that all auto-apply after their step ended never suspended it. Of two later turns,
    // approving the newer one's write resumes it, and then the older one's resumes nothing.
    [[[
      RULE_ON, {kind: "prompt", writes: [true, true], late: true},
      {kind: "prompt", writes: [false], late: false}, {kind: "prompt", writes: [false], late: false},
      {kind: "approve", pick: 1, fail: 0}, {kind: "approve", pick: 0, fail: 0},
    ]]],
  ];

  it("resumes a suspended turn once, when the last write it waits on is approved", async () => {
    await fc.assert(fc.asyncProperty(sessions, replayDecisions),
        {...PROPERTY_RUN_OPTIONS, numRuns: 50, examples});
  }, 120_000);
});
