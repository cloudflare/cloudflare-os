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

  it.each([
    {name: "a rejected write", toolName: "writeFile", args: {filename: "", content: SECRET}, error: /file path is empty/},
    {name: "an unmatched edit", toolName: "editFile", args: {filename: "server.js", textToReplace: "missing", replacement: "wrong"}, error: /No matching text/},
    {name: "a no-op edit", toolName: "editFile", args: {filename: "server.js", textToReplace: "original", replacement: "original"}, error: undefined},
  ])("preserves committed read knowledge after $name", ({toolName, args, error}) => inKernel(async impl => {
    const commitId = await impl.gitStore.writeFilesAsCommit(new Map([
      ["server.js", "original\n"], ["other.js", "untouched\n"],
    ]), {parents: [], author: {name: "Test", email: "test@example.com"}, message: "Initial", timestamp: new Date(0)});
    const gadget = impl.createGadget("Board", "BOARD", undefined, undefined, commitId);
    const faux = createFauxCore({models: [{id: "faux-model"}]});
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("readFile", {workpiece: "BOARD", filename: "server.js"}),
        fauxToolCall("readFile", {workpiece: "BOARD", filename: "other.js"}),
        fauxToolCall(toolName, {workpiece: "BOARD", ...args}),
        fauxToolCall("editFile", {workpiece: "BOARD", filename: "server.js", textToReplace: "original", replacement: "updated"}),
        fauxToolCall("editFile", {workpiece: "BOARD", filename: "other.js", textToReplace: "untouched", replacement: "also updated"}),
      ], {stopReason: "toolUse"}),
      fauxAssistantMessage(fauxText("Done.")),
    ]);
    await runAgent(impl, {model: faux.getModel(), stream: faux.stream}, 1, AUTHOR,
      new AbortController().signal, USER, {provider: "cloudflare", model: "faux-model", apiToken: ""});
    const calls = [...impl.storage.chats.list()].flatMap(message => message.type === "message" ? message.toolCalls ?? [] : []);
    expect(calls).toHaveLength(5);
    if (error) expect(calls[2].error).toMatch(error);
    else expect(calls[2].error).toBeUndefined();
    expect(calls[3].error).toBeUndefined();
    expect(calls[4].error).toBeUndefined();
    const files = (await impl.getCurrentChatContent(1, impl.storage.chatMeta.get(1)!)).get(gadget.id)!;
    expect(files.get("server.js")).toBe("updated\n");
    expect(files.get("other.js")).toBe("also updated\n");
    expect(files.has("")).toBe(false);
    expect(impl.getGadgetHead(gadget.id)).toBe(commitId);
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
