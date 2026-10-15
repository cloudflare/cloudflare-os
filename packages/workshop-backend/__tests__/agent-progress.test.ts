import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall} from "@earendil-works/pi-ai";
import type {OverseerDurableObject} from "../src/overseer";
import {runAgent} from "../src/agent";

declare module "cloudflare:workers" {
  interface ProvidedEnv { TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>; }
}
const USER = {type: "user" as const, id: "test-user", name: "Test"};
const AUTHOR = {type: "agent" as const, id: "faux-model", name: "Faux"};
const SECRET = "sentinel-file-content-must-not-be-logged";
type Impl = OverseerDurableObject["impl"];
async function inKernel(test: (impl: Impl) => Promise<void>) {
  await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    const impl = instance.impl, timestamp = impl.getChatTimestamp();
    impl.storage.chatMeta.put({id: 1, title: "Validation", started: timestamp, lastActive: timestamp});
    impl.addChatMessages(1, USER, [{type: "message", message: "Create an app."}]);
    impl.getInstanceInstructions = async () => "";
    impl.describeStandardFormats = async () => [];
    impl.listConnectableVendors = async () => [];
    await test(impl);
  });
}
describe("agent progress diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("distinguishes a blocked persistence barrier from the next model dispatch without logging contents", () => inKernel(async impl => {
    const logs = vi.spyOn(console, "debug").mockImplementation(() => {});
    const faux = createFauxCore({models: [{id: "faux-model"}]});
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("createGadget", {title: SECRET, bindingName: "BOARD"}), {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText(SECRET)),
    ]);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const commit = impl.commitAgentStep.bind(impl);
    let entered = false;
    impl.commitAgentStep = async (...args) => {
      if (!entered) { entered = true; await blocked; }
      return await commit(...args);
    };
    const entries = () => logs.mock.calls.map(([entry]) => entry as Record<string, unknown>);
    const running = runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, AUTHOR,
      new AbortController().signal, USER, {provider: "cloudflare", model: "faux-model", apiToken: SECRET});
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(entries().filter(entry => entry.event === "agent.model.dispatch")).toHaveLength(1);
      expect(entries().some(entry => entry.event === "agent.step.persist.started")).toBe(true);
      expect(entries().some(entry => entry.event === "agent.step.persist.completed")).toBe(false);
    } finally { release(); }
    await running;
    const progress = entries().filter(entry => typeof entry.event === "string" &&
      (entry.event.startsWith("agent.step.persist.") || entry.event.startsWith("agent.model.")));
    const completed = progress.findIndex(entry => entry.event === "agent.step.persist.completed");
    const dispatched = progress.findIndex(entry => entry.event === "agent.model.dispatch" && entry.sequence === 2);
    expect(completed).toBeGreaterThanOrEqual(0);
    expect(dispatched).toBeGreaterThan(completed);
    expect(progress.filter(entry => entry.event === "agent.model.completed")).toHaveLength(2);
    expect(new Set(progress.map(entry => entry.executionId)).size).toBe(1);
    expect(progress.filter(entry => entry.durationMs !== undefined).every(entry => typeof entry.durationMs === "number")).toBe(true);
    expect(JSON.stringify(progress)).not.toContain(SECRET);
  }));

  it.each(["provider retry", "compaction reload"] as const)(
      "preserves correlation and monotonic sequences across a %s", reason => inKernel(async impl => {
    const logs = vi.spyOn(console, "debug").mockImplementation(() => {});
    const history = vi.spyOn(impl, "loadChatHistory");
    const checkpoints = vi.spyOn(impl, "commitChatCompaction");
    const faux = createFauxCore({models: [{id: "faux-model"}]});
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("createGadget", {title: SECRET, bindingName: "FIRST"}), {stopReason: "toolUse"}),
      ...(reason === "provider retry" ? [fauxAssistantMessage(fauxText(SECRET), {
        stopReason: "error", errorMessage: `503 Service Unavailable ${SECRET}`,
      })] : [fauxAssistantMessage(fauxText(SECRET))]),
      fauxAssistantMessage(fauxToolCall("createGadget", {title: SECRET, bindingName: "SECOND"}), {stopReason: "toolUse"}),
      ...(reason === "compaction reload" ? [fauxAssistantMessage(fauxText(SECRET))] : []),
      fauxAssistantMessage(fauxText(SECRET)),
    ]);
    await runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, AUTHOR,
      new AbortController().signal, USER, {
        provider: "cloudflare", model: "faux-model", apiToken: SECRET,
        // Force a checkpoint after each tool step; the extra faux responses supply its summary.
        ...(reason === "compaction reload" ? {compactionInputBudget: 1} : {}),
      });
    expect(history).toHaveBeenCalledTimes(reason === "provider retry" ? 2 : 5);
    expect(checkpoints).toHaveBeenCalledTimes(reason === "provider retry" ? 0 : 2);
    expect(faux.getPendingResponseCount()).toBe(0);
    const progress = logs.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .filter(entry => entry.component === "workshop.agent" && entry.executionId !== undefined);
    const events = (event: string) => progress.filter(entry => entry.event === event);
    const modelSequences = reason === "provider retry" ? [1, 2, 3, 4] : [1, 2, 3];
    expect(events("agent.model.dispatch").map(entry => entry.sequence)).toEqual(modelSequences);
    expect(events("agent.model.stream.created").map(entry => entry.sequence)).toEqual(modelSequences);
    expect(events("agent.model.completed").map(entry => entry.sequence)).toEqual(modelSequences);
    expect(events("agent.model.completed").map(entry => entry.outcome))
      .toEqual(reason === "provider retry" ? ["ok", "error", "ok", "ok"] : ["ok", "ok", "ok"]);
    expect(events("agent.step.persist.started").map(entry => entry.sequence)).toEqual([1, 2, 3]);
    expect(events("agent.step.persist.completed").map(entry => entry.sequence)).toEqual([1, 2, 3]);
    expect(progress.every(entry => entry.chatId === 1)).toBe(true);
    expect(new Set(progress.map(entry => entry.executionId)).size).toBe(1);
    expect(JSON.stringify(progress)).not.toContain(SECRET);
  }));

  it("starts a new correlation ID and counters for a later invocation on the same chat", () => inKernel(async impl => {
    const logs = vi.spyOn(console, "debug").mockImplementation(() => {});
    const faux = createFauxCore({models: [{id: "faux-model"}]});
    faux.setResponses([fauxAssistantMessage(fauxText(SECRET)), fauxAssistantMessage(fauxText(SECRET))]);
    for (let turn = 0; turn < 2; ++turn) {
      if (turn > 0) impl.addChatMessages(1, USER, [{type: "message", message: "Continue."}]);
      await runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, AUTHOR,
        new AbortController().signal, USER, {provider: "cloudflare", model: "faux-model", apiToken: SECRET});
    }
    const entries = logs.mock.calls.map(([entry]) => entry as Record<string, unknown>);
    const dispatches = entries.filter(entry => entry.event === "agent.model.dispatch");
    expect(dispatches.map(entry => entry.sequence)).toEqual([1, 1]);
    expect(new Set(dispatches.map(entry => entry.executionId)).size).toBe(2);
    expect(entries.filter(entry => entry.event === "agent.step.persist.started").map(entry => entry.sequence))
      .toEqual([1, 1]);
  }));

});
