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
function diagnostics(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.map(([entry]) => entry as Record<string, unknown>)
    .filter(entry => entry.event === "agent.step.change.invalid");
}

describe("agent transform validation boundaries", () => {
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

  it("records an empty-filename tool error after creation and continues with a corrected write", () => inKernel(async impl => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const faux = createFauxCore({models: [{id: "faux-model"}]});
    const tool = (name: string, args: object) => fauxAssistantMessage(fauxToolCall(name, args), {stopReason: "toolUse"});
    faux.setResponses([
      tool("createGadget", {title: "Board", bindingName: "BOARD"}),
      tool("writeFile", {workpiece: "BOARD", filename: "", content: SECRET}),
      tool("writeFile", {workpiece: "BOARD", filename: "server.js", content: "export default {};"}),
      fauxAssistantMessage(fauxText("Done.")),
    ]);
    await runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, AUTHOR,
      new AbortController().signal, USER, {provider: "cloudflare", model: "faux-model", apiToken: ""});
    const calls = [...impl.storage.chats.list()].flatMap(message => message.type === "message" ? message.toolCalls ?? [] : []);
    const writes = calls.filter(call => call.toolName === "writeFile");
    expect(writes).toHaveLength(2);
    expect(writes[0].error).toMatch(/file path is empty/);
    expect(writes[1].error).toBeUndefined();
    const gadget = [...impl.storage.gadgets.list()].find(piece => piece.type === "gadget" && piece.bindingName === "BOARD")!;
    const files = (await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).get(gadget.id)!;
    expect(files.get("server.js")).toBe("export default {};");
    expect(files.has("")).toBe(false);
    const entries = diagnostics(warnings);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({changeStage: "buffer", changeWorkpieceCount: 1, changeFileCount: 1, changeEmptyPathCount: 1});
    expect(JSON.stringify(entries)).not.toContain(SECRET);
  }));

  it("fails closed at persistence with bounded shape diagnostics but no file contents", () => inKernel(async impl => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(impl.commitAgentStep(1, AUTHOR, [], {
      changes: [{change: {0: [["", {set: SECRET}]]}}], createdGadgets: [], createdWorktrees: [],
      addedBindings: [], worktreeCommits: [], blueprintMerges: [],
    })).rejects.toThrow(/file path is empty/);
    const entries = diagnostics(errors);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({changeStage: "persist", changeIndex: 0, changeWorkpieceCount: 1, changeFileCount: 1, changeEmptyPathCount: 1});
    expect(JSON.stringify(entries)).not.toContain(SECRET);
    expect([...impl.storage.chatChanges.list()]).toEqual([]);
  }));
});
