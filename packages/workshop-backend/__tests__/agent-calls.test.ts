// Calls to a callable agent (the `self` object in executeCode, or a spawnCallable() stub) are
// durable jobs: deliverAgentCallback records the call in `pendingAgentCalls` before its promise
// resolves, and drainPendingAgentCalls moves recorded calls into the chat log -- as agentCallback
// messages plus agentCallbackArgs records -- whenever the chat is idle: immediately, at the end of
// a running turn, or on the next DO construction if the previous instance went away first.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding). The initiator's user DO
// is replaced with a fake whose model config makes the turn fail before any network access, so
// the real turn machinery -- including the `finally` that drains -- runs without a model.

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { keyString } from "@gadgets/typed-storage";
import type { AgentSpawnerConfig, AiChatAuthorInfo, AiChatMessage } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { AgentSpawnerBinding } from "../src/agent-spawner-binding";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER_USER_ID = "owner-user-do";
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const MODEL: AiChatAuthorInfo = { type: "agent", id: "broken-model", name: "Broken Model" };
const CHAT_ID = 1;

// A Workers AI model with no credentials: getModel() throws synchronously, so a turn started with
// it fails immediately after the turn-start bookkeeping, then runs its `finally`.
const BROKEN_MODEL_CONFIG = { provider: "cloudflare", model: "@cf/test/model", apiToken: "" };

let doCounter = 0;

async function withImpl(
    name: string,
    fn: (impl: any, instance: OverseerDurableObject) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(name);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as { impl: any }).impl, instance);
  });
}

function freshImpl(fn: (impl: any, instance: OverseerDurableObject) => Promise<void>) {
  return withImpl(`agent-calls-${++doCounter}`, fn);
}

function seedChat(impl: any): void {
  impl.ownerId = OWNER_USER_ID;
  impl.storage.chatMeta.put(
      { id: CHAT_ID, title: "Callable agent", started: new Date(0), lastActive: new Date(0) });
}

// Replaces the user DO namespace with a fake that resolves the owner's profile and, when asked
// for a model, the broken one above.
function fakeUsers(impl: any): void {
  impl.users = {
    idFromString: (id: string) => id,
    get: () => ({
      getChatContext: async (modelId: string | null) => ({
        profile: OWNER,
        ...(modelId ? { aiModel: { profile: MODEL, config: BROKEN_MODEL_CONFIG } } : {}),
      }),
    }),
  };
}

// fakeUsers, but with the model lookup held until the returned function is called, so a test can
// observe the recorded call before the drain gets to it.
function gatedFakeUsers(impl: any): () => void {
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  fakeUsers(impl);
  let realGet = impl.users.get;
  impl.users.get = () => {
    let user = realGet();
    return { getChatContext: async (modelId: string | null) => {
      await gate;
      return user.getChatContext(modelId);
    } };
  };
  return release;
}

function messages(impl: any): AiChatMessage[] {
  return [...impl.storage.chats.list()];
}

function pendingCalls(impl: any): any[] {
  return [...impl.storage.pendingAgentCalls.list()];
}

// Polls until `cond` holds; the drain and the turn are fire-and-forget, so tests observe their
// effects rather than awaiting them.
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("condition not met in time");
}

function deliver(impl: any, method: string, args: unknown[], modelId: string | null = "m") {
  return impl.deliverAgentCallback(CHAT_ID, method, args, OWNER_USER_ID, modelId);
}

function callbackNames(impl: any): [string, string | undefined][] {
  return messages(impl).flatMap(msg =>
      msg.type === "agentCallback" ? [[msg.methodName, msg.bindingName]] : []);
}

const SPAWNER_CONFIG: AgentSpawnerConfig = { displayName: "Spawner", modelId: "m", env: {} };
const SPAWNER_TYPES = {
  types: "/** Drafts replies. */\ninterface Drafter { composeEmail(to: string): void; }",
  mainType: "Drafter",
};

// The binding a gadget holds, as the gadget would reach it: the spawner gatekeeper instantiated
// as one of this overseer's facets (the only way to reach a DurableObject class carrying props),
// then its session. Calls made through it go over RPC back into the overseer.
async function spawnerBinding(impl: any, config = SPAWNER_CONFIG): Promise<AgentSpawnerBinding> {
  let cls = impl.ctx.exports.AgentSpawnerGatekeeper({ props: {
    overseerId: impl.ctx.id.toString(), config, creatorUserId: OWNER_USER_ID,
  } });
  return impl.getGatekeeperFacet(900, cls).startSession(undefined);
}

describe("durable agent calls", () => {
  it("a call to an idle chat is recorded, then appended and the agent started",
      () => freshImpl(async impl => {
    seedChat(impl);
    let release = gatedFakeUsers(impl);
    let started: unknown[][] = [];
    impl.startAgent = (...args: unknown[]) => { started.push(args); };

    await deliver(impl, "composeEmail", [{ to: "a@example.com" }, 42]);

    // The promise resolved once the call was recorded; delivery is asynchronous.
    expect(pendingCalls(impl)).toMatchObject([{
      chatId: CHAT_ID, callId: 0, methodName: "composeEmail", args: [{ to: "a@example.com" }, 42],
      initiatorUserId: OWNER_USER_ID, initiatorModelId: "m",
    }]);
    expect(impl.storage.nextAgentCallId.get()).toBe(1);
    expect(messages(impl)).toEqual([]);

    release();
    await waitFor(() => started.length > 0);

    // Drained: the call is in the chat log, its args in the side table, the record gone.
    expect(pendingCalls(impl)).toEqual([]);
    let [msg] = messages(impl);
    expect(msg).toMatchObject({
      type: "agentCallback", methodName: "composeEmail", author: { type: "gadget", id: OWNER.id },
    });
    expect(impl.storage.agentCallbackArgs.get(`${keyString(CHAT_ID)}.${keyString(msg.sequence)}`).args)
        .toEqual([{ to: "a@example.com" }, 42]);
    expect(impl.storage.chatMeta.get(CHAT_ID).activeAgent).toEqual(MODEL);
    expect(started[0].slice(0, 4)).toEqual([
      CHAT_ID, { profile: MODEL, config: BROKEN_MODEL_CONFIG }, msg.author, OWNER_USER_ID,
    ]);
  }));

  it("several calls recorded before the drain are appended in one batch, in order",
      () => freshImpl(async impl => {
    seedChat(impl);
    // Hold the drain at its model lookup so a second call lands while the first is still pending.
    let release = gatedFakeUsers(impl);
    impl.startAgent = () => {};

    await deliver(impl, "first", [1]);
    await deliver(impl, "second", [2]);
    expect(pendingCalls(impl).map(call => call.methodName)).toEqual(["first", "second"]);

    release();
    await waitFor(() => pendingCalls(impl).length === 0);

    expect(messages(impl).map(msg => msg.type === "agentCallback" && msg.methodName))
        .toEqual(["first", "second"]);
  }));

  it("a call during a turn waits in storage and is delivered when the turn ends",
      () => freshImpl(async impl => {
    seedChat(impl);
    fakeUsers(impl);
    // Hold the (real) turn open at its first await so the second call arrives mid-turn.
    let release!: () => void;
    let held: Promise<void> | undefined = new Promise<void>(resolve => { release = resolve; });
    impl.reconcilePendingGadgets = async () => { await held; };

    await deliver(impl, "first", []);
    await waitFor(() => impl.storage.chatMeta.get(CHAT_ID).activeAgent !== undefined);

    await deliver(impl, "second", []);
    // Recorded but not appended: the running turn must not see it.
    expect(pendingCalls(impl).map(call => call.methodName)).toEqual(["second"]);
    expect(messages(impl).filter(msg => msg.type === "agentCallback").length).toBe(1);

    held = undefined;
    release();
    // The first turn fails at getModel(), its finally drains, and a second turn runs (and fails
    // the same way).
    await waitFor(() => pendingCalls(impl).length === 0 &&
        messages(impl).filter(msg => msg.type === "error").length === 2 &&
        impl.storage.chatMeta.get(CHAT_ID).activeAgent === undefined);

    expect(messages(impl).map(msg => msg.type === "agentCallback" ? msg.methodName : msg.type))
        .toEqual(["first", "error", "second", "error"]);
    expect([...impl.storage.activeAgents.list()]).toEqual([]);
  }));

  it("a call recorded while a message is being prepared is delivered when the reservation ends",
      () => freshImpl(async impl => {
    seedChat(impl);
    fakeUsers(impl);
    let started = 0;
    impl.startAgent = () => { started++; };

    let reservation = impl.reserveChatMessagePreparation(CHAT_ID);
    await deliver(impl, "duringPrep", []);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(pendingCalls(impl).length).toBe(1);
    expect(started).toBe(0);

    reservation[Symbol.dispose]();
    await waitFor(() => started > 0);
    expect(pendingCalls(impl)).toEqual([]);
    expect(messages(impl).map(msg => msg.type)).toEqual(["agentCallback"]);
  }));

  it("a non-persistent stub in the arguments is rejected and nothing is recorded",
      () => freshImpl(async impl => {
    seedChat(impl);
    fakeUsers(impl);
    impl.startAgent = () => { throw new Error("must not start"); };

    using stub = new NativeRpcStub({ notify: async () => {} } as any);
    await expect(deliver(impl, "withStub", [stub]))
        .rejects.toThrow(/must be storable.*ctx\.restore\(\)/);

    expect(pendingCalls(impl)).toEqual([]);
    expect(impl.storage.nextAgentCallId.get()).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(messages(impl)).toEqual([]);
  }));

  it("a call to an unknown chat is refused", () => freshImpl(async impl => {
    impl.ownerId = OWNER_USER_ID;
    await expect(deliver(impl, "foo", [])).rejects.toThrow(/No such chatId/);
    expect(pendingCalls(impl)).toEqual([]);
  }));

  it("with no model, the call is appended for a human and no agent starts",
      () => freshImpl(async impl => {
    seedChat(impl);
    fakeUsers(impl);
    impl.startAgent = () => { throw new Error("must not start"); };

    await deliver(impl, "noModel", ["x"], null);
    await waitFor(() => pendingCalls(impl).length === 0);

    expect(messages(impl)).toMatchObject([{ type: "agentCallback", methodName: "noModel" }]);
    expect(impl.storage.chatMeta.get(CHAT_ID).activeAgent).toBeUndefined();
  }));

  it("a model that no longer resolves is final: the calls are appended with an error, no agent",
      () => freshImpl(async impl => {
    seedChat(impl);
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({ getChatContext: async (modelId: string | null) => {
        if (modelId) throw new Error(`No such model: ${modelId}`);
        return { profile: OWNER };
      } }),
    };
    impl.startAgent = () => { throw new Error("must not start"); };

    await deliver(impl, "modelGone", []);
    await waitFor(() => pendingCalls(impl).length === 0);

    // Retrying would never help, so the calls land in the chat for a human, and nothing is left
    // to keep the backstop alarm re-arming.
    expect(messages(impl).map(msg => msg.type === "agentCallback" ? msg.methodName : msg.message))
        .toEqual(["modelGone", expect.stringMatching(/Could not start.*No such model: m/)]);
    expect(impl.storage.chatMeta.get(CHAT_ID).activeAgent).toBeUndefined();
    expect(await impl.ctx.storage.getAlarm()).toBeNull();
  }));

  it("an unreachable user DO leaves the calls recorded, with the alarm armed to retry",
      () => freshImpl(async (impl, instance) => {
    seedChat(impl);
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({ getChatContext: async () => { throw new Error("user DO unreachable"); } }),
    };

    expect(await impl.ctx.storage.getAlarm()).toBeNull();
    await deliver(impl, "retryLater", []);
    await new Promise(resolve => setTimeout(resolve, 20));

    // Nothing was lost and nothing misleading was appended...
    expect(pendingCalls(impl).map(call => call.methodName)).toEqual(["retryLater"]);
    expect(messages(impl)).toEqual([]);
    // ...and a wake-up is scheduled, so the retry doesn't depend on some other event arriving.
    expect(await impl.ctx.storage.getAlarm()).not.toBeNull();

    // The alarm handler is that retry: it drains under the alarm's own retry semantics.
    fakeUsers(impl);
    impl.startAgent = () => {};
    await instance.alarm();
    expect(pendingCalls(impl)).toEqual([]);
    expect(messages(impl).map(msg => msg.type)).toEqual(["agentCallback"]);
    expect(await impl.ctx.storage.getAlarm()).toBeNull();
  }));

  it("the alarm handler holds the DO until a turn its own drain started has ended",
      () => freshImpl(async (impl, instance) => {
    seedChat(impl);
    fakeUsers(impl);
    let release!: () => void;
    let held: Promise<void> | undefined = new Promise<void>(resolve => { release = resolve; });
    impl.reconcilePendingGadgets = async () => { await held; };
    // A call recorded but not drained -- as after a crash mid-drain -- when the alarm fires.
    impl.storage.pendingAgentCalls.put({
      chatId: CHAT_ID, callId: 0, methodName: "afterCrash", args: [], argsSummary: "",
      initiatorUserId: OWNER_USER_ID, initiatorModelId: "m",
    });
    impl.storage.nextAgentCallId.put(1);

    let settled = false;
    let handler = instance.alarm().finally(() => { settled = true; });
    await waitFor(() => impl.storage.chatMeta.get(CHAT_ID).activeAgent !== undefined);
    await new Promise(resolve => setTimeout(resolve, 20));
    // No agent was running when the handler began, so a single pass would have returned here and
    // left the turn the drain started with nothing holding the DO open.
    expect(settled).toBe(false);

    held = undefined;
    release();
    await handler;
    expect(impl.storage.chatMeta.get(CHAT_ID).activeAgent).toBeUndefined();
    expect(messages(impl).map(msg => msg.type)).toEqual(["agentCallback", "error"]);
    expect(await impl.ctx.storage.getAlarm()).toBeNull();
  }));

  it("the alarm handler holds the DO across the drain between two chained turns",
      () => freshImpl(async (impl, instance) => {
    seedChat(impl);
    fakeUsers(impl);
    // The second model lookup (the drain that turn A's end kicks) is held, so the state "no turn
    // running, drain in flight" can be observed.
    let lookups = 0;
    let releaseLookup!: () => void;
    let lookupGate = new Promise<void>(resolve => { releaseLookup = resolve; });
    let realGet = impl.users.get;
    impl.users.get = () => {
      let user = realGet();
      return { getChatContext: async (modelId: string | null) => {
        if (++lookups === 2) await lookupGate;
        return user.getChatContext(modelId);
      } };
    };
    // Each turn is held at its start until released.
    let gates: Promise<void>[] = [];
    let releases: (() => void)[] = [];
    for (let i = 0; i < 2; i++) {
      gates.push(new Promise<void>(resolve => { releases.push(resolve); }));
    }
    let reconciles = 0;
    impl.reconcilePendingGadgets = async () => {
      if (reconciles++ % 2 === 0) await gates.shift();
    };

    // Turn A is running with a call recorded behind it when the alarm fires.
    await deliver(impl, "first", []);
    await waitFor(() => impl.storage.chatMeta.get(CHAT_ID).activeAgent !== undefined);
    await deliver(impl, "second", []);
    let settled = false;
    let handler = instance.alarm().finally(() => { settled = true; });

    // A ends; its finally kicks the drain for "second", which parks on the model lookup. Nothing
    // is running, but the handler must not return: the DO would be left with a drain in flight
    // and a turn about to start, and nothing holding it open.
    releases[0]();
    await waitFor(() => lookups === 2 &&
        impl.storage.chatMeta.get(CHAT_ID).activeAgent === undefined);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    // The drain completes and turn B starts; still held.
    releaseLookup();
    await waitFor(() => impl.storage.chatMeta.get(CHAT_ID).activeAgent !== undefined);
    expect(settled).toBe(false);

    releases[1]();
    await handler;
    expect(messages(impl).map(msg => msg.type === "agentCallback" ? msg.methodName : msg.type))
        .toEqual(["first", "error", "second", "error"]);
    expect(await impl.ctx.storage.getAlarm()).toBeNull();
  }));

  it("a retry that fails again re-arms a fresh keep-alive period rather than re-firing at once",
      () => freshImpl(async (impl, instance) => {
    seedChat(impl);
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({ getChatContext: async () => { throw new Error("user DO unreachable"); } }),
    };
    await deliver(impl, "stillUnreachable", []);
    await new Promise(resolve => setTimeout(resolve, 20));
    let armedAtRecord = await impl.ctx.storage.getAlarm();

    // Nothing is set from inside the handler; one recompute at its end, from a settled state.
    await new Promise(resolve => setTimeout(resolve, 5));
    await instance.alarm();

    expect(pendingCalls(impl).map(call => call.methodName)).toEqual(["stillUnreachable"]);
    let rearmed = await impl.ctx.storage.getAlarm();
    // The keep-alive time is held fixed while work is outstanding, but the handler having run is
    // where a new period starts: re-using the old time would fire again immediately, forever.
    expect(rearmed).toBeGreaterThan(armedAtRecord);
    expect(rearmed).toBeGreaterThan(Date.now());
  }));

  it("agent work holds one fixed keep-alive time from first outstanding until none remains",
      () => freshImpl(async impl => {
    seedChat(impl);
    fakeUsers(impl);
    // Each turn is held at its first await until released, so the states between turns can be
    // observed deterministically. (The turn reconciles at its start and again in its finally;
    // only the start is gated.)
    let gates: Promise<void>[] = [];
    let releases: (() => void)[] = [];
    for (let i = 0; i < 2; i++) {
      gates.push(new Promise<void>(resolve => { releases.push(resolve); }));
    }
    let reconciles = 0;
    impl.reconcilePendingGadgets = async () => {
      if (reconciles++ % 2 === 0) await gates.shift();
    };

    await deliver(impl, "first", []);
    await waitFor(() => impl.storage.chatMeta.get(CHAT_ID).activeAgent !== undefined);
    let keepAliveTime = await impl.ctx.storage.getAlarm();
    expect(keepAliveTime).not.toBeNull();

    // More work arriving mid-turn recomputes the alarm but must not push that time out: it is
    // when the DO starts to risk eviction with nothing but background work in flight, so the
    // handler has to be running by then.
    await new Promise(resolve => setTimeout(resolve, 20));
    await deliver(impl, "second", []);
    expect(await impl.ctx.storage.getAlarm()).toBe(keepAliveTime);

    // The first turn ends, its finally drains "second", and the second turn starts (and blocks on
    // its gate). Across that whole hand-off the work was never done, so the time is unchanged.
    releases[0]();
    await waitFor(() => pendingCalls(impl).length === 0 &&
        messages(impl).filter(msg => msg.type === "error").length === 1);
    expect(impl.storage.chatMeta.get(CHAT_ID).activeAgent).toEqual(MODEL);
    expect(await impl.ctx.storage.getAlarm()).toBe(keepAliveTime);

    // Once no turn runs and no call is recorded, the alarm is gone...
    releases[1]();
    await waitFor(() => impl.storage.chatMeta.get(CHAT_ID).activeAgent === undefined &&
        messages(impl).filter(msg => msg.type === "error").length === 2);
    expect(await impl.ctx.storage.getAlarm()).toBeNull();

    // ...and the next work to become outstanding gets a fresh time, not the stale one.
    let release = gatedFakeUsers(impl);
    impl.startAgent = () => {};
    await deliver(impl, "third", []);
    let next = await impl.ctx.storage.getAlarm();
    expect(next).not.toBeNull();
    expect(next).toBeGreaterThan(keepAliveTime);
    release();
    await waitFor(() => pendingCalls(impl).length === 0);
  }));

  it("the alarm is armed while a call is recorded and cleared once it is delivered",
      () => freshImpl(async impl => {
    seedChat(impl);
    let release = gatedFakeUsers(impl);
    impl.startAgent = () => {};

    await deliver(impl, "armed", [], null);
    // Recorded, drain in flight: if the DO died now, only the alarm would bring it back.
    expect(await impl.ctx.storage.getAlarm()).not.toBeNull();

    release();
    await waitFor(() => pendingCalls(impl).length === 0);
    // Delivered with no turn to start (no model), so nothing needs a wake-up any more.
    expect(await impl.ctx.storage.getAlarm()).toBeNull();
  }));

  it("a delivered call's arguments are bound under <method>_ARGS, suffixed on collision",
      () => freshImpl(async impl => {
    seedChat(impl);
    let release = gatedFakeUsers(impl);
    // A seed binding already holds the first name `report` would get.
    impl.storage.chatContext.put({ chatId: CHAT_ID, bindings: { report_ARGS: 5 } });

    // All recorded before the drain gets to its lookup, so one batch names them all. (No model,
    // so no turn starts and the chat is idle again for the second drain below.)
    await deliver(impl, "composeEmail", ["a@example.com"], null);
    await deliver(impl, "composeEmail", ["b@example.com"], null);
    await deliver(impl, "report", [], null);
    await deliver(impl, "foo-bar", [], null);  // not an identifier
    await deliver(impl, "foo-baz", [], null);
    release();
    await waitFor(() => pendingCalls(impl).length === 0);

    expect(callbackNames(impl)).toEqual([
      ["composeEmail", "composeEmail_ARGS"],
      ["composeEmail", "composeEmail_ARGS_2"],
      ["report", "report_ARGS_2"],
      ["foo-bar", "CALL_ARGS"],
      ["foo-baz", "CALL_ARGS_2"],
    ]);
    // The names are in the chat's scope from now on, so a later drain keeps suffixing...
    expect(impl.chatScopeNames(CHAT_ID)).toEqual(new Set([
      "report_ARGS", "composeEmail_ARGS", "composeEmail_ARGS_2", "report_ARGS_2",
      "CALL_ARGS", "CALL_ARGS_2",
    ]));
    await deliver(impl, "composeEmail", [], null);
    await waitFor(() => pendingCalls(impl).length === 0);
    expect(callbackNames(impl).at(-1)).toEqual(["composeEmail", "composeEmail_ARGS_3"]);
  }));

  it("a callback from before durable calls binds nothing", () => freshImpl(async impl => {
    seedChat(impl);
    fakeUsers(impl);
    // Its arguments were transient and are gone; the message stays in the log for display.
    impl.storage.chats.put({
      chatId: CHAT_ID, sequence: impl.nextChatSequence(CHAT_ID), timestamp: new Date(0),
      author: OWNER, type: "agentCallback", methodName: "legacy", argsSummary: "[0]: 1",
    });
    expect(impl.chatScopeNames(CHAT_ID)).toEqual(new Set());

    // Nor does it take part in naming: a new call to the same method gets the unsuffixed name.
    await deliver(impl, "legacy", [2], null);
    await waitFor(() => pendingCalls(impl).length === 0);
    expect(callbackNames(impl)).toEqual([["legacy", undefined], ["legacy", "legacy_ARGS"]]);
  }));

  it("spawnCallable(title, prompt) is refused with the migration message",
      () => freshImpl(async impl => {
    impl.ownerId = OWNER_USER_ID;
    fakeUsers(impl);
    let binding = await spawnerBinding(impl);

    let outcome = "ok";
    try {
      await (binding as any).spawnCallable("Drafts", "You draft emails.");
    } catch (err) {
      outcome = (err as Error).message;
    }
    expect(outcome).toMatch(/replaced by spawnCallable\(title, \{types, mainType\}\)/);
    expect([...impl.storage.chatMeta.list()]).toEqual([]);
  }));

  // The stub spawnCallable() returns is an AgentSelfLoopback, whose every method is a Proxy trap
  // that forwards to deliverAgentCallback. The test pool's RPC emulation resolves methods on the
  // class prototype only, so calls through the stub can't be exercised here; these tests deliver
  // to the spawned chat the way the stub does.
  it("spawnCallable() creates an empty chat, which the first call starts",
      () => freshImpl(async impl => {
    impl.ownerId = OWNER_USER_ID;
    fakeUsers(impl);
    let started: unknown[][] = [];
    impl.startAgent = (...args: unknown[]) => { started.push(args); };
    let binding = await spawnerBinding(impl);

    let agent = await binding.spawnCallable("Drafts", SPAWNER_TYPES);
    expect(agent).toBeDefined();

    // The chat exists, idle, with the declarations frozen on its context and no prompt message.
    let [meta] = [...impl.storage.chatMeta.list()];
    expect(meta).toMatchObject({ title: "Drafts", spawnerName: "Spawner" });
    expect(meta.activeAgent).toBeUndefined();
    expect(impl.storage.chatContext.get(meta.id)).toEqual({
      chatId: meta.id, spawnerConfig: SPAWNER_CONFIG, spawnerTypes: SPAWNER_TYPES, bindings: {},
    });
    expect([...impl.storage.chats.list()]).toEqual([]);
    expect(started).toEqual([]);

    // The call resolves once recorded; the drain then appends it and starts the agent.
    await impl.deliverAgentCallback(meta.id, "composeEmail", ["a@example.com"], OWNER_USER_ID, "m");
    await waitFor(() => started.length > 0);
    expect([...impl.storage.chats.list()]).toMatchObject([{
      chatId: meta.id, type: "agentCallback", methodName: "composeEmail",
      argsSummary: '[0]: "a@example.com"', bindingName: "composeEmail_ARGS",
    }]);
    expect(started[0].slice(0, 4)).toEqual([
      meta.id, { profile: MODEL, config: BROKEN_MODEL_CONFIG },
      { type: "gadget", id: OWNER.id, name: impl.storage.title.get() }, OWNER_USER_ID,
    ]);
  }));

  it("spawnCallable() with no model still records calls, for a human", () => freshImpl(async impl => {
    impl.ownerId = OWNER_USER_ID;
    fakeUsers(impl);
    impl.startAgent = () => { throw new Error("must not start"); };
    let binding = await spawnerBinding(impl, { ...SPAWNER_CONFIG, modelId: null });

    await binding.spawnCallable("Drafts", SPAWNER_TYPES);
    let [meta] = [...impl.storage.chatMeta.list()];
    await impl.deliverAgentCallback(meta.id, "composeEmail", ["a@example.com"], OWNER_USER_ID, null);
    await waitFor(() => pendingCalls(impl).length === 0);

    expect(callbackNames(impl)).toEqual([["composeEmail", "composeEmail_ARGS"]]);
    expect(impl.storage.chatMeta.get(meta.id).activeAgent).toBeUndefined();
  }));

  it("calls recorded before a restart are delivered when the DO is next constructed", async () => {
    let name = `agent-calls-restart-${++doCounter}`;
    let userId!: string;
    await withImpl(name, async impl => {
      seedChat(impl);
      // The real user DO answers the drain after the restart (its default profile, no model), so
      // the record must name a genuine id in its namespace.
      userId = impl.users.newUniqueId().toString();
      impl.storage.pendingAgentCalls.put({
        chatId: CHAT_ID, callId: 0, methodName: "survivor", args: [7], argsSummary: "[7]",
        initiatorUserId: userId, initiatorModelId: null,
      });
      impl.storage.nextAgentCallId.put(1);
    });

    await abortAllDurableObjects();

    await withImpl(name, async impl => {
      // #resumeInterruptedAgents found the record with no turn running and kicked the drain.
      await waitFor(() => pendingCalls(impl).length === 0);
      let [msg] = messages(impl);
      expect(msg).toMatchObject({ type: "agentCallback", methodName: "survivor" });
      expect(impl.storage.agentCallbackArgs.get(`${keyString(CHAT_ID)}.${keyString(msg.sequence)}`).args)
          .toEqual([7]);
      expect(impl.storage.chatMeta.get(CHAT_ID).activeAgent).toBeUndefined();
    });
  });

  it("a call queued behind a turn that cannot be resumed is still delivered", async () => {
    let name = `agent-calls-unresumable-${++doCounter}`;
    await withImpl(name, async impl => {
      seedChat(impl);
      let userId = impl.users.newUniqueId().toString();
      // A turn interrupted by the restart, whose model the real user DO no longer knows...
      impl.storage.chatMeta.put({ ...impl.storage.chatMeta.get(CHAT_ID), activeAgent: MODEL });
      impl.storage.activeAgents.put({
        chatId: CHAT_ID, initiatorUserId: userId, modelId: "gone-model", initiator: OWNER,
        callbackInitiated: false,
      });
      // ...and a call recorded while it was running.
      impl.storage.pendingAgentCalls.put({
        chatId: CHAT_ID, callId: 0, methodName: "queuedBehind", args: [], argsSummary: "",
        initiatorUserId: userId, initiatorModelId: null,
      });
      impl.storage.nextAgentCallId.put(1);
    });

    await abortAllDurableObjects();

    await withImpl(name, async impl => {
      // The resume fails on the model lookup and tears the turn down; that path hands off to the
      // drain like a completed turn does, rather than leaving the call recorded until the next
      // event happens to arrive.
      await waitFor(() => pendingCalls(impl).length === 0);
      expect(messages(impl).map(msg => msg.type === "agentCallback" ? msg.methodName : msg.type))
          .toEqual(["error", "queuedBehind"]);
      expect(impl.storage.chatMeta.get(CHAT_ID).activeAgent).toBeUndefined();
      expect([...impl.storage.activeAgents.list()]).toEqual([]);
    });
  });
});
