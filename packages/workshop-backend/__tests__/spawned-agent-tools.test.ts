// The tool surface of a spawned agent: no user is present to review its work, so it gets no tool
// that modifies a gadget or requests a connection, but it can read gadgets and create, read and
// edit worktrees. Drives the real runAgent against a real OverseerImpl, with pi's faux provider
// standing in for the model so each step's offered tools can be inspected and its tool calls
// scripted.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
  AgentSpawnerConfig, AiChatAuthorInfo, AiChatMessage, AiToolCall,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { AgentSpawnerBinding } from "../src/agent-spawner-binding";
import { runAgent } from "../src/agent";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER_USER_ID = "owner-user-do";
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const GADGET_ID = 100;

let doCounter = 0;

async function withImpl(fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`spawned-agent-tools-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.ownerId = OWNER_USER_ID;
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({ getChatContext: async () => ({ profile: OWNER }) }),
    };
    // The turn is driven by hand below, not by the spawn.
    impl.startAgent = () => {};
    await fn(impl);
  });
}

// A permanent gadget, offered to the spawned agent as env.GADGET.
function seedGadget(impl: any): void {
  impl.storage.gadgets.put({
    type: "gadget", id: GADGET_ID, title: "Gadget", created: new Date(0), bindingName: "GADGET",
    bindings: {},
  });
}

async function commitFiles(impl: any, files: Record<string, string>): Promise<string> {
  return await impl.gitCache.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents: [],
    author: { name: "Alice", email: "alice@example.com" },
    message: "test commit",
    timestamp: new Date(1700000000_000),
  });
}

// Spawns a chat through the spawner binding a gadget would hold, returning its chat id.
async function spawnChat(impl: any, {env, ...config}: AgentSpawnerConfig): Promise<number> {
  let cls = impl.ctx.exports.AgentSpawnerGatekeeper({ props: {
    config, creatorUserId: OWNER_USER_ID,
  } });
  let bindings = Object.fromEntries(
      Object.entries(env).map(([name, target]) => [name, { target }]));
  let client = await impl.addGatekeeper(
      cls, { type: "agentSpawner", config }, OWNER_USER_ID, undefined, bindings);
  let binding: AgentSpawnerBinding = await client.openSession();
  await binding.spawn("Task", "Do the task.");
  let [meta] = [...impl.storage.chatMeta.list()];
  return meta.id;
}

// Runs one agent turn whose model answers each step with the next scripted response, recording
// the tool names offered at every step.
async function runScriptedTurn(
    impl: any, chatId: number,
    steps: ReturnType<typeof fauxAssistantMessage>[]): Promise<string[][]> {
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  let offered: string[][] = [];
  faux.setResponses(steps.map(step => (context: TranscriptContext) => {
    offered.push(getCurrentTools(context.messages).map(tool => tool.name).toSorted());
    return step;
  }));
  let model = faux.getModel();
  await runAgent(impl, { model, stream: faux.stream }, chatId,
      { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal, OWNER,
      { provider: "cloudflare", model: "faux-model", apiToken: "" } as any);
  return offered;
}

function toolCalls(impl: any, chatId: number): AiToolCall[] {
  return ([...impl.storage.chats.list()] as AiChatMessage[])
      .filter(msg => msg.chatId === chatId)
      .flatMap(msg => msg.type === "message" ? msg.toolCalls ?? [] : []);
}

describe("spawned agent tools", () => {
  it("offers file and worktree tools, but nothing that modifies gadgets or requests connections",
      () => withImpl(async impl => {
    seedGadget(impl);
    let chatId = await spawnChat(impl, { displayName: "Spawner", modelId: "m", env: { GADGET: GADGET_ID } });

    let offered = await runScriptedTurn(impl, chatId, [fauxAssistantMessage(fauxText("Done."))]);

    expect(offered).toEqual([[
      "createWorktree", "describeBinding", "editFile", "executeCode", "grep", "observeUserChanges",
      "readFile", "webFetch", "writeFile",
    ]]);
  }));

  it("refuses writes to a gadget and allows them to a worktree it creates",
      () => withImpl(async impl => {
    seedGadget(impl);
    let commit = await commitFiles(impl, { "README.md": "hello\n" });
    let chatId = await spawnChat(impl, { displayName: "Spawner", modelId: "m", env: { GADGET: GADGET_ID } });

    await runScriptedTurn(impl, chatId, [
      fauxAssistantMessage([
        fauxToolCall("writeFile", { workpiece: "GADGET", filename: "server.js", content: "x" }),
        fauxToolCall("createWorktree", { title: "Repo", bindingName: "REPO", commitId: commit }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("readFile", { workpiece: "REPO", filename: "README.md" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("editFile",
            { workpiece: "REPO", filename: "README.md", textToReplace: "hello", replacement: "bye" }),
        fauxToolCall("writeFile", { workpiece: "REPO", filename: "NEW.md", content: "new\n" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    let calls = toolCalls(impl, chatId);
    let gadgetWrite = calls.find(call =>
        call.toolName === "writeFile" && call.input.workpiece === "GADGET");
    expect(gadgetWrite?.error).toMatch(/do not have permission to edit this gadget's code/);
    for (let call of calls.filter(call => call !== gadgetWrite)) {
      expect(call.error, `${call.toolName} failed`).toBeUndefined();
    }

    // The only proposed changes are the worktree's: the gadget was never pinned or modified.
    let worktreeId = calls.find(call => call.toolName === "createWorktree")!.output.worktreeId;
    let touched = new Set(([...impl.storage.chats.list()] as AiChatMessage[])
        .filter(msg => msg.chatId === chatId && msg.type === "changes")
        .flatMap(msg => msg.type === "changes" && msg.change ? Object.keys(msg.change) : []));
    expect(touched).toEqual(new Set([`${worktreeId}`]));
    expect(impl.getChatAgentContext(chatId).spawnerConfig).toBeDefined();
  }));

  it("greps a worktree before its first modification pins it, and after",
      () => withImpl(async impl => {
    seedGadget(impl);
    let commit = await commitFiles(impl,
        { "README.md": "hello\n", "src/util.js": "export let answer = 42;\n" });
    let chatId = await spawnChat(impl, { displayName: "Spawner", modelId: "m", env: { GADGET: GADGET_ID } });

    await runScriptedTurn(impl, chatId, [
      fauxAssistantMessage([
        fauxToolCall("createWorktree", { title: "Repo", bindingName: "REPO", commitId: commit }),
      ], { stopReason: "toolUse" }),
      // Unpinned: the search resolves against the accepted commit.
      fauxAssistantMessage([
        fauxToolCall("grep", { workpiece: "REPO", pattern: "answer", path: "src" }),
        fauxToolCall("grep", { workpiece: "REPO", pattern: "hello", path: "README.md" }),
        fauxToolCall("grep", { workpiece: "REPO", pattern: "answer|hello" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("writeFile",
            { workpiece: "REPO", filename: "src/new.js", content: "let answer = 43;\n" }),
      ], { stopReason: "toolUse" }),
      // Pinned by the write: the search sees the overlay over the same base.
      fauxAssistantMessage([
        fauxToolCall("grep", { workpiece: "REPO", pattern: "answer", path: "src" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    let calls = toolCalls(impl, chatId);
    for (let call of calls) {
      expect(call.error, `${call.toolName} failed`).toBeUndefined();
    }
    expect(calls.filter(call => call.toolName === "grep").map(call => call.output)).toEqual([
      "src/util.js:1:export let answer = 42;",
      "1:hello",
      "README.md:1:hello\nsrc/util.js:1:export let answer = 42;",
      "src/new.js:1:let answer = 43;\nsrc/util.js:1:export let answer = 42;",
    ]);
  }));

  it("tells an edit of a missing file apart from an edit of an unread one",
      () => withImpl(async impl => {
    let commit = await commitFiles(impl, { "README.md": "hello\n" });
    let chatId = await spawnChat(impl, { displayName: "Spawner", modelId: "m", env: {} });
    let edit = { workpiece: "REPO", textToReplace: "hello", replacement: "bye" };

    await runScriptedTurn(impl, chatId, [
      fauxAssistantMessage([
        fauxToolCall("createWorktree", { title: "Repo", bindingName: "REPO", commitId: commit }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("editFile", { ...edit, filename: "README.md" }),
        fauxToolCall("editFile", { ...edit, filename: "REPO/README.md" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    let [unread, missing] = toolCalls(impl, chatId).filter(call => call.toolName === "editFile");
    expect(unread.error).toMatch(/must read a file/);
    expect(missing.error).toMatch(/has no file named "REPO\/README\.md"/);
  }));

  it("refuses a new binding named GIT, which would shadow env.GIT",
      () => withImpl(async impl => {
    let commit = await commitFiles(impl, { "README.md": "hello\n" });
    let chatId = await spawnChat(impl, { displayName: "Spawner", modelId: "m", env: {} });

    await runScriptedTurn(impl, chatId, [
      fauxAssistantMessage([
        fauxToolCall("createWorktree", { title: "Repo", bindingName: "GIT", commitId: commit }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);

    let [call] = toolCalls(impl, chatId);
    expect(call.error).toMatch(/already a binding named "GIT"/);
    expect([...impl.storage.gadgets.list()].filter((record: any) => record.type === "worktree"))
        .toEqual([]);
  }));

  it("attributes the spawned turn to the gadget, with the creator's commit email",
      () => withImpl(async impl => {
    let creator = { ...OWNER, commitEmail: "owner@commits.example" };
    impl.users.get = () => ({ getChatContext: async () => ({ profile: creator }) });
    let chatId = await spawnChat(impl, { displayName: "Spawner", modelId: "m", env: {} });

    let [prompt] = ([...impl.storage.chats.list()] as AiChatMessage[])
        .filter(msg => msg.chatId === chatId);
    expect(prompt.author).toEqual({
      type: "gadget", id: OWNER.id, name: impl.storage.title.get(),
      commitEmail: "owner@commits.example",
    });
  }));

  it("still offers regular chats the full tool set", () => withImpl(async impl => {
    impl.storage.chatMeta.put(
        { id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0) });
    impl.storage.chats.put({
      chatId: 1, sequence: impl.nextChatSequence(1), timestamp: new Date(0), author: OWNER,
      type: "message", message: "Hi",
    });

    let offered = await runScriptedTurn(impl, 1, [fauxAssistantMessage(fauxText("Hello."))]);

    expect(offered[0]).toEqual(expect.arrayContaining(
        ["createGadget", "setGadgetBinding", "listBlueprints", "listConnectableResources",
         "requestConnection"]));
  }));
});

// An executeCode call that shows `count` views.
function showViews(count: number) {
  return fauxToolCall("executeCode", {
    code: `export default async function() {
      for (let i = 0; i < ${count}; i++) embedView({ title: "View " + i, html: "<p>hi</p>" });
    }`,
  });
}

// withImpl, in a regular chat, 1, with the user's prompt, unless `open` is false. executeCode
// looks its caller up by name.
function withChat(fn: Parameters<typeof withImpl>[0], { open = true } = {}) {
  return withImpl(async impl => {
    impl.users = { ...impl.users, idFromName: (name: string) => name };
    if (open) {
      impl.storage.chatMeta.put({ id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0) });
      impl.storage.chats.put({
        chatId: 1, sequence: impl.nextChatSequence(1), timestamp: new Date(0), author: OWNER,
        type: "message", message: "Chart it.",
      });
    }
    await fn(impl);
  });
}

// embedView (plans/live-views.md): a step that showed a view is the answer, unless an executeCode
// call in it failed. Only chats a person reads have it.
describe("embedView", () => {
  it("asks the model nothing more after a step that showed a view", () => withChat(async impl => {
    let offered = await runScriptedTurn(impl, 1, [
      fauxAssistantMessage([showViews(1)], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Here it is.")),
    ]);
    expect(offered).toHaveLength(1);
    expect(toolCalls(impl, 1)[0]?.views).toEqual([{ title: "View 0", html: "<p>hi</p>" }]);
  }));

  it("ends a step that read data in one call and showed a view in another", () => withChat(async impl => {
    let offered = await runScriptedTurn(impl, 1, [
      fauxAssistantMessage([
        fauxToolCall("executeCode", { code: `export default async function() { console.log(42); }` }),
        showViews(1),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Here it is.")),
    ]);
    expect(offered).toHaveLength(1);
  }));

  it("goes on after a step in which another call threw, so the agent can fix it", () => withChat(async impl => {
    let offered = await runScriptedTurn(impl, 1, [
      fauxAssistantMessage([
        showViews(1),
        fauxToolCall("executeCode", { code: `export default async function() { throw new Error("x"); }` }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Fixed.")),
    ]);
    expect(offered).toHaveLength(2);
    expect(toolCalls(impl, 1)[1]).toMatchObject({ failed: true });
  }));

  it("goes on after a step in which another executeCode call's input was refused", () => withChat(async impl => {
    let offered = await runScriptedTurn(impl, 1, [
      fauxAssistantMessage([showViews(1), fauxToolCall("executeCode", { source: "x" })],
          { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Fixed.")),
    ]);
    expect(offered).toHaveLength(2);
    expect(toolCalls(impl, 1)[1]?.error).toBeDefined();
  }));

  it("fails a call past 4 views or with an empty view, and goes on", () => withChat(async impl => {
    let offered = await runScriptedTurn(impl, 1, [
      fauxAssistantMessage([showViews(5)], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("executeCode", {
        code: `export default async function() { embedView({ title: "Empty", html: "" }); }`,
      })], { stopReason: "toolUse" }),
      // The limit is each call's, so two calls in one step show all five.
      fauxAssistantMessage([showViews(3), showViews(2)], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Unreached.")),
    ]);
    expect(offered).toHaveLength(3);
    let [five, empty, three, two] = toolCalls(impl, 1);
    expect(five).toMatchObject({ failed: true });
    expect(five.views).toBeUndefined();
    expect(empty).toMatchObject({ failed: true });
    expect(empty.views).toBeUndefined();
    expect(three.views).toHaveLength(3);
    expect(two.views).toHaveLength(2);
  }));

  it("refuses a call whose views would overfill what its step can save, saves the step, and " +
      "gives the next step its own budget", () => withChat(async impl => {
    // Each call shows 4 views of about 250 KiB, within its own limits; nine of them are more than
    // one stored record holds.
    let showBigViews = () => fauxToolCall("executeCode", {
      code: `export default async function() {
        for (let i = 0; i < 4; i++) embedView({ title: "View " + i, html: "x".repeat(250 * 1024) });
      }`,
    });
    let offered = await runScriptedTurn(impl, 1, [
      fauxAssistantMessage(Array.from({ length: 9 }, showBigViews), { stopReason: "toolUse" }),
      fauxAssistantMessage([showBigViews()], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Unreached.")),
    ]);
    let calls = toolCalls(impl, 1);
    expect(calls).toHaveLength(10);
    let [first, ...rest] = calls;
    expect(first.views).toHaveLength(4);
    let refused = rest.at(-2);
    expect(refused).toMatchObject({ failed: true });
    expect(refused?.views).toBeUndefined();
    expect(refused?.output).toContain("embedView:");
    // A refused call means the step did not answer, so the agent goes on, and its next step shows
    // views the first step had no more room for, which answers.
    expect(rest.at(-1)?.views).toHaveLength(4);
    expect(offered).toHaveLength(2);
  }));

  it("counts the output lines naming a step's views", () => withChat(async impl => {
    // Each call logs a line and shows a small view with a long title outside Latin-1, which its
    // output names too, so the output is stored at two bytes per code unit.
    let showTitled = (length: number) => fauxToolCall("executeCode", {
      code: `export default async function() {
        console.log("y".repeat(20000));
        embedView({ title: "\\u0100".repeat(${length}), html: "<p>x</p>" });
      }`,
    });
    await runScriptedTurn(impl, 1, [
      fauxAssistantMessage([...Array.from({ length: 15 }, () => showTitled(131000)), showTitled(33000)],
          { stopReason: "toolUse" }),
      // The step's output fills the model's window, so the next request compacts it first.
      fauxAssistantMessage(fauxText("Summary.")),
      fauxAssistantMessage(fauxText("Done.")),
    ]);
    let calls = toolCalls(impl, 1);
    // The step was saved.
    expect(calls).toHaveLength(16);
    expect(calls[0].views).toHaveLength(1);
    let refused = calls.filter(call => call.failed);
    expect(refused).not.toHaveLength(0);
    for (let call of refused) {
      expect(call.views).toBeUndefined();
      expect(call.output).toContain("embedView:");
    }
  }));

  it.each(["spawned", "callable"])("is not in a %s agent's code", kind => withChat(async impl => {
    let chatId = await spawnChat(impl, { displayName: "Spawner", modelId: "m", env: {} });
    if (kind === "callable") {
      impl.storage.chatContext.put({ ...impl.getChatAgentContext(chatId), spawnerTypes: {
        types: "/** Drafts replies. */\ninterface Drafter { composeEmail(to: string): void; }",
        mainType: "Drafter",
      } });
    }
    let offered = await runScriptedTurn(impl, chatId, [
      fauxAssistantMessage([showViews(1)], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("Done.")),
    ]);
    expect(offered).toHaveLength(2);
    let [call] = toolCalls(impl, chatId);
    expect(call).toMatchObject({ failed: true });
    expect(call.views).toBeUndefined();
    expect(call.output).toContain("ReferenceError");
  }, { open: false }));
});
