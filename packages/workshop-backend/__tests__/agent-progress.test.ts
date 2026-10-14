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

});
