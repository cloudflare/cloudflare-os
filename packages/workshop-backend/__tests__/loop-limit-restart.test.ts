// The runtime refuses a call once the loop counter behind it is exhausted, and a workspace object's
// outgoing channels can hold an exhausted counter with nothing recursing: every call it makes to a
// user object is then refused until the instance is replaced. So the workspace restarts itself
// (scheduleAccessRestart) when one of its own user-object calls is refused that way -- at most
// once per instance, and never while the instance is young, which bounds how often a restart that
// did not clear the condition can repeat.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding). Local workerd has no loop
// limit, so the user object is a fake whose calls reject. scheduleAccessRestart is replaced with a
// recorder: a real ctx.abort() would kill the test DO.

import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import { openFakeOverseer } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER_ID = "owner-user-id";

const LOOP_LIMIT_MESSAGE =
    "Subrequest depth limit exceeded. This request looped back into the Workers runtime too " +
    "many times. This can happen e.g. if you have a Worker or Durable Object that calls other " +
    "Workers or objects recursively.";

// The runtime's message for a different counter, which a restart does not help.
const STAGE_LIMIT_MESSAGE =
    "Subrequest depth limit exceeded. This request passed through too many Workers stages " +
    "within the Workers runtime while being handled.";

// The age an instance must reach before a loop-limit rejection restarts it.
const MIN_AGE_MS = 60_000;

const RESTART_REASON = "Gadget restarted because its subrequest depth was exhausted.";

let doCounter = 0;

// Runs `fn` against a fresh workspace whose instance is `ageMs` old, with every restart it
// schedules recorded instead of performed.
async function withImpl(
    fn: (impl: any, restarts: string[]) => Promise<void>, ageMs = MIN_AGE_MS): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`loop-limit-restart-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = OWNER_ID;
    let restarts: string[] = [];
    impl.scheduleAccessRestart = async (reason: string) => { restarts.push(reason); };
    // streamGeneration is the instance's creation time, so pinning the clock pins its age.
    vi.spyOn(Date, "now").mockReturnValue(impl.streamGeneration + ageMs);
    await fn(impl, restarts);
  });
}

// Replaces the user namespace with one whose every user object rejects each call with `error`.
// Returns the names of the calls made, so a test that expects no restart can still show that the
// rejection happened.
function rejectUserCalls(impl: any, error: unknown): string[] {
  let calls: string[] = [];
  let reject = (method: string) => async () => {
    calls.push(method);
    throw error;
  };
  let user = {
    id: { toString: () => OWNER_ID },
    setGadgetLastActive: reject("setGadgetLastActive"),
    syncWorkspaceOutputs: reject("syncWorkspaceOutputs"),
    listProvidedAccounts: reject("listProvidedAccounts"),
    updatePinned: reject("updatePinned"),
    getChatContext: reject("getChatContext"),
  };
  impl.users = { idFromString: (id: string) => id, get: () => user };
  return calls;
}

// The entries the logger wrote for `event` through the spied console method.
function logged(spy: ReturnType<typeof vi.spyOn>, event: string): Record<string, unknown>[] {
  return spy.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .filter(entry => entry.event === event);
}

// The last-active bump is fire-and-forget; give its rejection a turn to be handled.
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe("restarting a workspace whose loop counter is exhausted", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a refused last-active bump restarts the workspace", () => withImpl(async (impl, restarts) => {
    let errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = rejectUserCalls(impl, new Error(LOOP_LIMIT_MESSAGE));

    impl.bumpLastActive();
    await settle();

    expect(calls).toEqual(["setGadgetLastActive"]);
    expect(restarts).toEqual([RESTART_REASON]);
    // The restart is an error-level event carrying the rejection; the bump's own failure log is
    // still written.
    expect(logged(errors, "workspace.loop.limit.restart")).toEqual([expect.objectContaining({
      component: "workshop.overseer",
      gadgetId: impl.ctx.id.toString(),
      error: expect.stringContaining(LOOP_LIMIT_MESSAGE),
    })]);
    expect(logged(warnings, "gadget.last.active.bump.failed")).toHaveLength(1);
  }));

  it("a refused outputs sync restarts the workspace", () => withImpl(async (impl, restarts) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = rejectUserCalls(impl, new Error(LOOP_LIMIT_MESSAGE));

    // The sync still reports that the index did not take the snapshot, and still logs why.
    expect(await impl.syncOutputsTo(impl.users.get(OWNER_ID))).toBe(false);

    expect(calls).toEqual(["syncWorkspaceOutputs"]);
    expect(restarts).toEqual([RESTART_REASON]);
    expect(logged(warnings, "workspace.outputs.sync.failed")).toHaveLength(1);
  }));

  it("a refused call through the workspace's owner stub restarts it",
      () => withImpl(async (impl, restarts) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let error = new Error(LOOP_LIMIT_MESSAGE);
    let calls = rejectUserCalls(impl, error);

    // ensureAmbientCapsules reads the owner's accounts through OverseerImpl.#ownerUserDo. The
    // caller still gets the rejection itself: the call is not retried or replaced.
    await expect(impl.ensureAmbientCapsules()).rejects.toBe(error);

    expect(calls).toEqual(["listProvidedAccounts"]);
    expect(restarts).toEqual([RESTART_REASON]);
  }));

  it("a refused call through a session's user stub restarts it",
      () => withImpl(async (impl, restarts) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let error = new Error(LOOP_LIMIT_MESSAGE);
    let calls = rejectUserCalls(impl, error);
    // A real build client interface whose user stubs are the real impl's: setPinned goes through
    // OverseerClientInterface.#clientUser.
    let client = await openFakeOverseer({}, { impl: {
      users: impl.users,
      wrapUserDo: (stub: unknown) => impl.wrapUserDo(stub),
    } });

    await expect(client.setPinned(true)).rejects.toBe(error);

    expect(calls).toEqual(["updatePinned"]);
    expect(restarts).toEqual([RESTART_REASON]);
  }));

  it("a refused pending-agent-call drain restarts the workspace",
      () => withImpl(async (impl, restarts) => {
    let errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = rejectUserCalls(impl, new Error(LOOP_LIMIT_MESSAGE));
    // A call recorded but not yet drained. With no model to fall back from, the drain asks the
    // initiator's user object for its chat context once.
    const CHAT_ID = 1;
    impl.storage.pendingAgentCalls.put({
      chatId: CHAT_ID, callId: 0, methodName: "refused", args: [], argsSummary: "",
      initiatorUserId: OWNER_ID, initiatorModelId: null,
    });
    impl.storage.nextAgentCallId.put(1);

    await impl.drainPendingAgentCalls(CHAT_ID);

    expect(calls).toEqual(["getChatContext"]);
    expect(restarts).toEqual([RESTART_REASON]);
    // The drain still logs its own failure and leaves the call recorded for the retry.
    expect(logged(errors, "agent.callback.start.failed")).toHaveLength(1);
    expect([...impl.storage.pendingAgentCalls.list()].map(call => call.methodName))
        .toEqual(["refused"]);
  }));

  it("no other rejection restarts the workspace", () => withImpl(async (impl, restarts) => {
    let errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let rejections = [
      new Error(STAGE_LIMIT_MESSAGE),
      new Error("Durable Object reset."),
      // An error of the user object's own that quotes the text, as one echoing a caller-supplied
      // value would.
      new Error(`No such model: ${LOOP_LIMIT_MESSAGE}`),
      // Only an Error is the runtime's own rejection; the text alone is not.
      LOOP_LIMIT_MESSAGE,
      { message: LOOP_LIMIT_MESSAGE },
      // An Error with no string message is not it either, and is still the rejection the caller
      // gets.
      Object.assign(new Error(), { message: undefined }),
    ];

    for (let rejection of rejections) {
      let calls = rejectUserCalls(impl, rejection);
      expect(await impl.syncOutputsTo(impl.users.get(OWNER_ID))).toBe(false);
      await expect(impl.ensureAmbientCapsules()).rejects.toBe(rejection);
      expect(calls).toEqual(["syncWorkspaceOutputs", "listProvidedAccounts"]);
    }
    expect(restarts).toEqual([]);
    expect(logged(errors, "workspace.loop.limit.restart")).toEqual([]);

    // The same routes do restart on the loop-limit rejection.
    rejectUserCalls(impl, new Error(LOOP_LIMIT_MESSAGE));
    expect(await impl.syncOutputsTo(impl.users.get(OWNER_ID))).toBe(false);
    expect(restarts).toEqual([RESTART_REASON]);
  }));

  it("an instance younger than a minute is not restarted", () => withImpl(async (impl, restarts) => {
    let errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = rejectUserCalls(impl, new Error(LOOP_LIMIT_MESSAGE));

    // An instance this young may itself be the product of a restart that did not help.
    expect(await impl.syncOutputsTo(impl.users.get(OWNER_ID))).toBe(false);
    await expect(impl.ensureAmbientCapsules()).rejects.toThrow(/looped back/);
    impl.bumpLastActive();
    await settle();

    expect(calls).toEqual(["syncWorkspaceOutputs", "listProvidedAccounts", "setGadgetLastActive"]);
    expect(restarts).toEqual([]);
    expect(logged(errors, "workspace.loop.limit.restart")).toEqual([]);

    // Nothing was spent on the refusals: once the instance is old enough, the next one restarts.
    vi.spyOn(Date, "now").mockReturnValue(impl.streamGeneration + MIN_AGE_MS);
    expect(await impl.syncOutputsTo(impl.users.get(OWNER_ID))).toBe(false);
    expect(restarts).toEqual([RESTART_REASON]);
  }, MIN_AGE_MS - 1));

  it("an instance restarts at most once, however many calls are refused",
      () => withImpl(async (impl, restarts) => {
    let errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = rejectUserCalls(impl, new Error(LOOP_LIMIT_MESSAGE));

    // Every call fails while the counter is exhausted, and they arrive faster than the restart.
    await Promise.all([
      impl.syncOutputsTo(impl.users.get(OWNER_ID)),
      impl.syncOutputsTo(impl.users.get(OWNER_ID)),
      expect(impl.ensureAmbientCapsules()).rejects.toThrow(/looped back/),
    ]);
    impl.bumpLastActive();
    await settle();
    expect(await impl.syncOutputsTo(impl.users.get(OWNER_ID))).toBe(false);

    expect(calls).toHaveLength(5);
    expect(restarts).toEqual([RESTART_REASON]);
    expect(logged(errors, "workspace.loop.limit.restart")).toHaveLength(1);
  }));
});
