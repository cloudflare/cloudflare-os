// The agent's file tools over files far larger than one storage row: windowed reads that read
// only the chunks they show (and replay identically), edits whose change carries only their
// span, and grep, which streams a large file rather than decoding it whole.

import {describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {runAgent} from "../src/agent";
import {createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage,
  type Message} from "@earendil-works/pi-ai";
import type {OverseerDurableObject} from "../src/overseer";
import type {UserDurableObject} from "../src/user";
import type {AiChatMessage} from "@gadgets/workshop-shared/api";

declare module "cloudflare:workers" { interface ProvidedEnv {
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
}}
type Impl = OverseerDurableObject["impl"];
const AUTHOR = {type: "agent" as const, id: "test", name: "Test"};
const USER = {type: "user" as const, id: "test-user", name: "Test"};

async function inKernel<T>(test: (impl: Impl) => Promise<T>): Promise<T> {
  return runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()),
      instance => test(instance.impl));
}

// Runs one agent turn whose model makes the given steps' tool calls, then says it is done.
// Returns the tool results the model was shown, from the last request.
async function scriptedTurn(impl: Impl, chatId: number,
                            steps: ReturnType<typeof fauxToolCall>[][]) {
  const faux = createFauxCore({models: [{id: "faux-model", contextWindow: 8_000_000}]});
  const requests: Message[][] = [];
  faux.setResponses([
    ...steps.map((calls): AssistantMessage => fauxAssistantMessage(calls, {stopReason: "toolUse"})),
    fauxAssistantMessage(fauxText("Done")),
  ]);
  await runAgent(impl, {model: faux.getModel(), stream: (model, context, options) => {
    requests.push(structuredClone(context.messages));
    return faux.stream(model, context, options);
  }}, chatId, AUTHOR, new AbortController().signal, USER,
  {provider: "cloudflare", model: "faux-model", apiToken: "", contextWindow: 8_000_000});
  return requests.at(-1)!.flatMap(message =>
    message.role === "toolResult" && message.toolName !== "observeUserChanges"
      ? [{toolName: message.toolName, text: message.content.map(part =>
            part.type === "text" ? part.text : "").join(""), isError: message.isError}]
      : []);
}

// A chat over a worktree, created this turn, rooted at a commit of `files`.
async function chatWithWorktree(impl: Impl, files: Map<string, string>) {
  const commit = await impl.gitCache.writeFilesAsCommit(files, {
    parents: [], author: {name: "Test", email: "test@example.com"},
    message: "large files", timestamp: new Date(0),
  });
  const user = env.TEST_USER.getByName(crypto.randomUUID());
  const chatId = await impl.newChat(user, {profile: USER}, "Inspect");
  const create = fauxToolCall("createWorktree", {title: "Repo", bindingName: "REPO", commitId: commit});
  return {user, chatId, commit, create};
}

// Counts reads of the chunk rows of the blob at `path`.
async function countChunkReads(impl: Impl, commit: string, path: string) {
  const ref = (await impl.gitCache.fileBytesAtCommit(commit, path))!;
  const record = impl.storage.gitObjects.get(ref.oid)!;
  if (!("chunks" in record)) throw new Error(`${path} is not chunked`);
  const chunks = new Set(record.chunks.map(chunk => chunk.oid));
  const counter = {reads: 0, chunks: chunks.size};
  const get = impl.storage.gitObjects.get.bind(impl.storage.gitObjects);
  impl.storage.gitObjects.get = (oid: string) => {
    if (chunks.has(oid)) counter.reads++;
    return get(oid);
  };
  return counter;
}

describe("large files in the agent's file tools", () => {
  it("reads a window of a 50 MB file without reading it whole, and replays it identically",
      () => inKernel(async impl => {
    const lines = Array.from({length: 5_000_000}, (_, i) => `line ${i + 1}`);
    const {user, chatId, commit, create} =
        await chatWithWorktree(impl, new Map([["big.txt", lines.join("\n") + "\n"]]));
    const counter = await countChunkReads(impl, commit, "big.txt");
    expect(counter.chunks).toBeGreaterThan(100);

    const results = await scriptedTurn(impl, chatId, [[create], [
      fauxToolCall("readFile", {workpiece: "REPO", filename: "big.txt", startLine: 2_500_000,
                                lineCount: 3}),
    ]]);
    expect(results.map(result => result.isError)).toEqual([false, false]);
    expect(results[1].text).toBe("line 2500000\nline 2500001\nline 2500002\n\n" +
        "[lines 2500000-2500002 of 5000000; next startLine: 2500003]");
    // The window's chunk or two, and the last chunk, for the line count.
    expect(counter.reads).toBeLessThanOrEqual(4);

    await impl.sendChatMessage(user, {profile: USER}, chatId, "Follow up");
    counter.reads = 0;
    expect(await scriptedTurn(impl, chatId, [])).toEqual(results);
    expect(counter.reads).toBeLessThanOrEqual(4);
  }), 60_000);

  it("edits a 9 MB file with a change carrying only the span", () => inKernel(async impl => {
    const big = "0123456789abcdef\n".repeat(9_000_000 / 17) + "the end\n";
    const {chatId, create} = await chatWithWorktree(impl, new Map([["big.txt", big]]));
    const results = await scriptedTurn(impl, chatId, [[create], [
      fauxToolCall("readFile", {workpiece: "REPO", filename: "big.txt", startLine: 1, lineCount: 1}),
    ], [
      fauxToolCall("editFile", {workpiece: "REPO", filename: "big.txt",
                                textToReplace: "the end", replacement: "THE END"}),
    ]]);
    expect(results.map(result => result.isError)).toEqual([false, false, false]);

    const changes = ([...impl.storage.chats.list()] as AiChatMessage[])
        .filter(message => message.chatId === chatId && message.type === "changes" &&
            message.change !== undefined);
    const change = changes.flatMap(message =>
        message.type === "changes" ? Object.values(message.change!).flat() : []);
    expect(change).toHaveLength(1);
    expect(change[0][0]).toBe("big.txt");
    expect(JSON.stringify(change[0][1]).length).toBeLessThan(200);
  }), 60_000);

  it("greps a large file a piece at a time, and skips a large binary one with a note",
      () => inKernel(async impl => {
    const filler = Array.from({length: 300_000}, (_, i) => `filler ${i}`).join("\n");
    const binary = `${filler}\nneedle in binary\0\n`;
    const {chatId, create} = await chatWithWorktree(impl, new Map([
      ["big.txt", `${filler}\nthe needle\n${filler}\n`], ["big.bin", binary],
    ]));
    const results = await scriptedTurn(impl, chatId, [[create], [
      fauxToolCall("grep", {workpiece: "REPO", pattern: "needle"}),
    ]]);
    expect(results[1]).toEqual({toolName: "grep", isError: false,
      text: "big.txt:300001:the needle\n(skipped: big.bin is not a text file)"});
  }), 60_000);
});
