import {env, tracing} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall} from "@earendil-works/pi-ai";
import type {OverseerDurableObject} from "../src/overseer";
import {runAgent} from "../src/agent";
import {obsContext} from "../src/observability";

interface RecordedSpan {
  name: string;
  spanId: string;
  parentSpanId: string | undefined;
  attributes: Record<string, unknown>;
  closed: boolean;
}

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    SPAN_RECORDER: Service<{ spans(): RecordedSpan[] }>;
  }
}
const USER = {type: "user" as const, id: "test-user", name: "Test"};
const AUTHOR = {type: "agent" as const, id: "faux-model", name: "Faux"};
const SECRET = "sentinel-file-content-must-not-be-logged";
type Impl = OverseerDurableObject["impl"];
async function inKernel<T>(test: (impl: Impl) => Promise<T>): Promise<T> {
  return await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async instance => {
    const impl = instance.impl, timestamp = impl.getChatTimestamp();
    impl.storage.chatMeta.put({id: 1, title: "Validation", started: timestamp, lastActive: timestamp});
    impl.addChatMessages(1, USER, [{type: "message", message: "Create an app."}]);
    impl.getInstanceInstructions = async () => "";
    impl.describeStandardFormats = async () => [];
    impl.listConnectableVendors = async () => [];
    return await obsContext.with({
      gadgetId: "test-workspace", modelId: AUTHOR.id, operation: "agent.run",
    }, () => test(impl));
  });
}

async function persistenceSpans(executionId: string, count: number) {
  let spans: RecordedSpan[] = [];
  await vi.waitFor(async () => {
    spans = (await env.SPAN_RECORDER.spans()).filter(span =>
      span.name === "agent.step.persist" && span.attributes.executionId === executionId);
    expect(spans).toHaveLength(count);
    expect(spans.every(span => span.closed)).toBe(true);
  }, {timeout: 5000});
  return spans;
}

describe("agent progress diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("awaits and traces persistence with a frozen JS clock, without duplicate model logs", async () => {
    const executionId = await inKernel(async impl => {
      const logs = vi.spyOn(console, "debug").mockImplementation(() => {});
      vi.spyOn(Date, "now").mockReturnValue(Date.now());
      const entries = () => logs.mock.calls.map(([entry]) => entry as Record<string, unknown>);
      const faux = createFauxCore({models: [{id: "faux-model"}]});
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("createGadget", {title: SECRET, bindingName: "BOARD"}), {stopReason: "toolUse"}),
        () => {
          expect(entries().some(entry => entry.event === "agent.step.persist.completed" && entry.sequence === 1)).toBe(true);
          return fauxAssistantMessage(fauxText(SECRET));
        },
      ]);
      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const commit = impl.commitAgentStep.bind(impl);
      let entered = false;
      impl.commitAgentStep = async (...args) => {
        const span = tracing.getActiveSpan();
        expect(span?.isTraced).toBe(true);
        if (!entered) {
          entered = true;
          await blocked;
          expect(span?.isTraced).toBe(true);
        }
        return await commit(...args);
      };
      const running = runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, AUTHOR,
        new AbortController().signal, USER, {provider: "cloudflare", model: "faux-model", apiToken: SECRET});
      try {
        await vi.waitFor(() => expect(entered).toBe(true));
        expect(faux.state.callCount).toBe(1);
        expect(entries().some(entry => entry.event === "agent.step.persist.started")).toBe(true);
        expect(entries().some(entry => entry.event === "agent.step.persist.completed")).toBe(false);
      } finally { release(); }
      await running;
      const progress = entries().filter(entry => typeof entry.event === "string" &&
        (entry.event.startsWith("agent.step.persist.") || entry.event.startsWith("agent.model.")));
      expect(faux.state.callCount).toBe(2);
      expect(progress.map(entry => [entry.event, entry.sequence])).toEqual([
        ["agent.step.persist.started", 1], ["agent.step.persist.completed", 1],
        ["agent.step.persist.started", 2], ["agent.step.persist.completed", 2],
      ]);
      expect(new Set(progress.map(entry => entry.executionId)).size).toBe(1);
      expect(progress.every(entry => entry.durationMs === undefined)).toBe(true);
      expect(JSON.stringify(progress)).not.toContain(SECRET);
      return String(progress[0].executionId);
    });
    const spans = await persistenceSpans(executionId, 2);
    expect(spans.map(span => span.attributes.sequence)).toEqual([1, 2]);
    for (const span of spans) {
      expect(span.attributes).toMatchObject({
        chatId: 1, executionId, gadgetId: "test-workspace", modelId: AUTHOR.id, operation: "agent.run",
      });
      expect(span.attributes.error).toBeUndefined();
      expect(JSON.stringify(span.attributes)).not.toContain(SECRET);
    }
  });

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
    expect(faux.state.callCount).toBe(reason === "provider retry" ? 4 : 5);
    expect(progress.some(entry => String(entry.event).startsWith("agent.model."))).toBe(false);
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
    const starts = entries.filter(entry => entry.event === "agent.step.persist.started");
    expect(starts.map(entry => entry.sequence)).toEqual([1, 1]);
    expect(new Set(starts.map(entry => entry.executionId)).size).toBe(2);
  }));

  it.each(["sync", "async"] as const)("marks a %s persistence failure without recording its contents", async mode => {
    const executionId = await inKernel(async impl => {
      const logs = vi.spyOn(console, "debug").mockImplementation(() => {});
      const faux = createFauxCore({models: [{id: "faux-model"}]});
      faux.setResponses([fauxAssistantMessage(fauxText(SECRET))]);
      const failure = new Error(SECRET);
      vi.spyOn(impl, "commitAgentStep").mockImplementation(() => {
        if (mode === "sync") throw failure;
        return Promise.reject(failure);
      });
      await expect(runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, AUTHOR,
        new AbortController().signal, USER, {provider: "cloudflare", model: "faux-model", apiToken: SECRET}))
        .rejects.toBe(failure);
      const progress = logs.mock.calls.map(([entry]) => entry as Record<string, unknown>)
        .filter(entry => entry.executionId !== undefined);
      expect(progress.map(entry => [entry.event, entry.sequence])).toEqual([
        ["agent.step.persist.started", 1], ["agent.step.persist.failed", 1],
      ]);
      expect(JSON.stringify(progress)).not.toContain(SECRET);
      return String(progress[0].executionId);
    });
    const spans = await persistenceSpans(executionId, 1);
    expect(spans[0].attributes).toMatchObject({executionId, chatId: 1, sequence: 1, error: true});
    expect(JSON.stringify(spans[0].attributes)).not.toContain(SECRET);
  });

});
