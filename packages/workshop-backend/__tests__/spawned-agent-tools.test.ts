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
  type Message, type TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
  AgentSpawnerConfig, AiChatAuthorInfo, AiChatMessage, AiToolCall,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { AgentSpawnerBinding, SpawnOptions } from "../src/agent-spawner-binding";
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
async function spawnChat(impl: any, {env, ...config}: AgentSpawnerConfig,
                         options?: SpawnOptions): Promise<number> {
  let cls = impl.ctx.exports.AgentSpawnerGatekeeper({ props: {
    config, creatorUserId: OWNER_USER_ID,
  } });
  let bindings = Object.fromEntries(
      Object.entries(env).map(([name, target]) => [name, { target }]));
  let client = await impl.addGatekeeper(
      cls, { type: "agentSpawner", config }, OWNER_USER_ID, undefined, bindings);
  let binding: AgentSpawnerBinding = await client.openSession();
  await binding.spawn("Task", "Do the task.", options);
  let [meta] = [...impl.storage.chatMeta.list()];
  return meta.id;
}

// A valid 1x1 PNG, small enough to inline into model input.
const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_BYTES = Uint8Array.fromBase64(PNG_BASE64);

// Runs one agent turn whose model answers each step with the next scripted response, recording
// the tool names offered at every step (and, if `requests` is given, each step's model input).
async function runScriptedTurn(
    impl: any, chatId: number,
    steps: ReturnType<typeof fauxAssistantMessage>[],
    requests?: Message[][]): Promise<string[][]> {
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  let offered: string[][] = [];
  faux.setResponses(steps.map(step => (context: TranscriptContext) => {
    offered.push(getCurrentTools(context.messages).map(tool => tool.name).toSorted());
    return step;
  }));
  let model = faux.getModel();
  let stream: typeof faux.stream = (model, context, options) => {
    requests?.push(structuredClone(context.messages));
    return faux.stream(model, context, options);
  };
  await runAgent(impl, { model, stream }, chatId,
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

  it("shows an image attached to spawn() to the model, and saves it in the scratch worktree",
      () => withImpl(async impl => {
    let git = await impl.startGatekeeperSession({ type: "git" }, { from: "gadget", gadgetId: 1 });
    let oid = await git.writeBlob(PNG_BYTES);
    let chatId = await spawnChat(impl, { displayName: "Spawner", modelId: "m", env: {} },
        { attachments: [{ oid, mimeType: "image/png", name: "photo.png" }] });

    let [prompt] = ([...impl.storage.chats.list()] as AiChatMessage[])
        .filter(msg => msg.chatId === chatId);
    expect(prompt.type).toBe("message");
    if (prompt.type !== "message") return;
    expect(prompt.message).toBe("Do the task.");
    expect(prompt.attachments).toEqual([expect.objectContaining({
      mimeType: "image/png", name: "photo.png", size: PNG_BYTES.byteLength,
      workspacePath: "photo.png",
    })]);
    expect(await impl.getChatAttachmentData(chatId, prompt.attachments![0].id))
        .toEqual(PNG_BYTES);

    // The original bytes are in the agent's scratch worktree.
    let scratch = impl.getChatAgentContext(chatId).scratch;
    expect(scratch?.bindingName).toBe("SCRATCH");
    let tree = impl.storage.gadgets.get(scratch.worktreeId);
    expect(tree?.type).toBe("worktree");
    let value = await impl.gitCache.fileBytesAtCommit(tree.baseCommit, "photo.png");
    expect(impl.gitCache.readBlob(value!.oid, value!.byteLength)).toEqual(PNG_BYTES);

    // The model receives the image itself, alongside the prompt and where the file lives.
    let requests: Message[][] = [];
    await runScriptedTurn(impl, chatId, [fauxAssistantMessage(fauxText("A single pixel."))],
        requests);
    expect(requests).toHaveLength(1);
    let input = requests[0].find(message => message.role === "user")!;
    if (!Array.isArray(input.content)) throw new Error("Expected attachment parts");
    expect(input.content).toContainEqual({ type: "image", mimeType: "image/png", data: PNG_BASE64 });
    let text = input.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
    expect(text).toContain("Do the task.");
    expect(text).toContain("[Attached image (photo.png); workspace file env.SCRATCH/photo.png]");
  }));

  it("refuses a spawn() attachment whose content does not match its type, creating no chat",
      () => withImpl(async impl => {
    let oid = impl.gitCache.writeBlob(new TextEncoder().encode("not a png")).oid;
    await expect(spawnChat(impl, { displayName: "Spawner", modelId: "m", env: {} }, {
      attachments: [{ oid, mimeType: "image/png" }],
    })).rejects.toThrow(/does not match its MIME type/);
    expect([...impl.storage.chatMeta.list()]).toEqual([]);
  }));

  it("refuses a spawn() attachment the workspace doesn't have, creating no chat",
      () => withImpl(async impl => {
    await expect(spawnChat(impl, { displayName: "Spawner", modelId: "m", env: {} }, {
      attachments: [{ oid: "feed".repeat(10), mimeType: "image/png" }],
    })).rejects.toThrow(/Unknown Git blob/);
    expect([...impl.storage.chatMeta.list()]).toEqual([]);
  }));

  it("refuses more than five spawn() attachments", () => withImpl(async impl => {
    let attachment = { oid: impl.gitCache.writeBlob(PNG_BYTES).oid, mimeType: "image/png" };
    await expect(spawnChat(impl, { displayName: "Spawner", modelId: "m", env: {} },
        { attachments: Array(6).fill(attachment) })).rejects.toThrow(/up to 5 attachments/);
    expect([...impl.storage.chatMeta.list()]).toEqual([]);
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
