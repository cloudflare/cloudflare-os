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
  return await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents: [],
    author: { name: "Alice", email: "alice@example.com" },
    message: "test commit",
    timestamp: new Date(1700000000_000),
  });
}

// Spawns a chat through the spawner binding a gadget would hold, returning its chat id.
async function spawnChat(impl: any, config: AgentSpawnerConfig): Promise<number> {
  let cls = impl.ctx.exports.AgentSpawnerGatekeeper({ props: {
    overseerId: impl.ctx.id.toString(), config, creatorUserId: OWNER_USER_ID,
  } });
  let binding: AgentSpawnerBinding = await impl.getGatekeeperFacet(900, cls).startSession(undefined);
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
