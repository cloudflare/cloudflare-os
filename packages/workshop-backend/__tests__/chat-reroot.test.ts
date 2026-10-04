// A pin declaration re-roots its gadget: every fold of a chat's log restarts the gadget's content
// at the declared commit, dropping what earlier messages changed in it. Nothing writes such a
// declaration yet beyond the first one per gadget, so these tests write the log by hand, in the
// shape an update from mainline will: a merge commit `M = [H, S]` declared as the pin's base,
// with the head it merged as the declaration's `mergedCommit`. Runs the real OverseerImpl, and
// for the agent's fold the real runAgent with pi's faux provider standing in for the model.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type Context,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { keyString } from "@gadgets/typed-storage";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMessageBody, ChatGadgetPinState,
} from "@gadgets/workshop-shared/api";
import {
  applyCodeChange, composeEpochChanges, diffFiles, type CodeContent,
} from "@gadgets/workshop-shared/code-change";
import { runAgent } from "../src/agent";
import { buildCompactionState } from "../src/agent-compaction";
import { releaseMergeHeader, releasesMergedBy } from "../src/blueprint-release";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const USER: AiChatAuthorInfo = { type: "user", id: "alice@example.com", name: "Alice" };
const USER_META = { profile: USER };
const GADGET = 1;
const CHAT = 1;

let doCounter = 0;
async function withImpl(fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`chat-reroot-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    await fn((instance as unknown as { impl: any }).impl);
  });
}

let commitCounter = 0;
async function commitFiles(
    impl: any, files: Record<string, string>, parents: string[] = []): Promise<string> {
  return await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents,
    author: { name: "Alice", email: "alice@example.com" },
    message: `test commit ${++commitCounter}`,
    timestamp: new Date(1700000000_000),
  });
}

function setHead(impl: any, commitId: string): void {
  impl.storage.gadgets.put({ ...impl.storage.gadgets.get(GADGET), commitId });
}

function head(impl: any): string {
  return impl.storage.gadgets.get(GADGET).commitId;
}

function chatMessages(impl: any): AiChatMessage[] {
  return [...impl.storage.chats.list({ prefix: `${keyString(CHAT)}.` })];
}

function pin(impl: any): ChatGadgetPinState | undefined {
  return impl.storage.chatMeta.get(CHAT).codeBase?.pins
      .find((p: ChatGadgetPinState) => p.gadgetId === GADGET);
}

function putMessage(impl: any, body: AiChatMessageBody): number {
  let sequence = impl.nextChatSequence(CHAT);
  impl.storage.chats.put(
      { chatId: CHAT, sequence, timestamp: impl.getChatTimestamp(), author: USER, ...body });
  return sequence;
}

// The gadget's files as the chat holds them, rebuilt from the log rather than from the cache.
async function chatFiles(impl: any): Promise<Record<string, string>> {
  impl.invalidateChatContent(CHAT);
  let content = await impl.getCurrentChatContent(CHAT, impl.storage.chatMeta.get(CHAT));
  return Object.fromEntries(content.get(GADGET) ?? new Map());
}

async function commitTree(impl: any, commitId: string): Promise<CodeContent> {
  return new Map([[GADGET, await impl.gitStore.readCommitFiles(commitId)]]);
}

// The user edits the chat's copy of the gadget from `before` to `after`, declaring the pin if
// the gadget has none yet, and the edit is materialized into a message.
async function edit(impl: any, before: Record<string, string>, after: Record<string, string>)
    : Promise<number> {
  let codeBase = impl.storage.chatMeta.get(CHAT).codeBase ?? { generation: 0, revision: 0 };
  let content = (files: Record<string, string>): CodeContent =>
      new Map([[GADGET, new Map(Object.entries(files))]]);
  await impl.submitCodeChange(CHAT, {
    generation: codeBase.generation, revision: codeBase.revision,
    clientId: `cli-${codeBase.generation}`, seq: codeBase.revision + 1,
    ...(pin(impl) === undefined ? { pins: [{ gadgetId: GADGET, baseCommit: head(impl) }] } : {}),
    change: diffFiles(content(before), content(after)),
  }, USER, "alice-user-do");
  return impl.materializeChatChanges(CHAT)!.sequence;
}

// Brings the chat up to date with the gadget's head as an update from mainline will: commits
// the chat's files as `S` on the pin's base and the merged `files` as `M = [head, S]`, declares
// `{M, mergedCommit: head}` on a message recording the merge, and moves the live pin there with
// a destructive generation bump.
async function reroot(impl: any, files: Record<string, string>)
    : Promise<{ merge: string, snapshot: string, sequence: number }> {
  let current = pin(impl)!;
  let mainline = head(impl);
  let snapshot = await commitFiles(impl, await chatFiles(impl), [current.baseCommit]);
  let merge = await commitFiles(impl, files, [mainline, snapshot]);
  let sequence = putMessage(impl, {
    type: "changes",
    pins: [{ gadgetId: GADGET, baseCommit: merge, mergedCommit: mainline }],
    mainlineMerge: {
      conflictPaths: [],
      gadgets: [{
        gadgetId: GADGET, baseCommit: current.mergedCommit, chatCommit: snapshot,
        conflictPaths: [],
      }],
    },
  });
  impl.deleteAllChatChanges(CHAT);
  let meta = impl.storage.chatMeta.get(CHAT);
  let codeBase = meta.codeBase;
  codeBase.pins = codeBase.pins.map((p: ChatGadgetPinState) => p.gadgetId === GADGET
      ? { gadgetId: GADGET, baseCommit: merge, mergedCommit: mainline } : p);
  codeBase.generation += 1;
  codeBase.revision = 0;
  delete codeBase.prior;
  impl.storage.chatMeta.put(meta);
  return { merge, snapshot, sequence };
}

// Brings the chat up to date as an update from before re-roots did: the merge recorded as an
// ordinary change, the pin's `mergedCommit` advanced and nothing declared.
async function updateAsBefore(impl: any, files: Record<string, string>): Promise<void> {
  let change = diffFiles(new Map([[GADGET, new Map(Object.entries(await chatFiles(impl)))]]),
                         new Map([[GADGET, new Map(Object.entries(files))]]));
  putMessage(impl, { type: "changes", change, mainlineMerge: { conflictPaths: [] } });
  let meta = impl.storage.chatMeta.get(CHAT);
  meta.codeBase.pins.find((p: ChatGadgetPinState) => p.gadgetId === GADGET).mergedCommit =
      head(impl);
  impl.storage.chatMeta.put(meta);
  impl.invalidateChatContent(CHAT);
}

// Publishes a checkpoint compacting everything before `compactedTo`, as a compaction would.
function compact(impl: any, compactedTo: number) {
  let previous = impl.getActiveChatCompaction(CHAT);
  let messages = chatMessages(impl)
      .filter(msg => previous === undefined || msg.sequence >= previous.compactedTo);
  let state = buildCompactionState(messages, compactedTo, [], previous);
  impl.storage.chatCompactions.put(
      { chatId: CHAT, compactedTo, summary: "Earlier work.", ...state });
  impl.storage.chatMeta.put({ ...impl.storage.chatMeta.get(CHAT), compactedTo });
  return state;
}

// Runs one agent turn, prompted by a new user message, in which the model makes `calls` and
// then stops. Returns the text of each call's result.
async function agentTurn(impl: any, calls: ReturnType<typeof fauxToolCall>[])
    : Promise<string[]> {
  putMessage(impl, { type: "message", message: "Go." });
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  let contexts: Context[] = [];
  faux.setResponses([
    fauxAssistantMessage(calls, { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("Done.")),
  ].map(step => (context: TranscriptContext) => {
    contexts.push({ messages: structuredClone(context.messages) });
    return step;
  }));
  await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, CHAT,
      { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal, USER,
      { provider: "cloudflare", model: "faux-model", apiToken: "" } as any);
  return contexts[1].messages.flatMap(message => message.role === "toolResult"
      ? [message.content.map(part => part.type === "text" ? part.text : "").join("")]
      : []).slice(-calls.length);
}

// The gadget's files as the agent's replay of the log reads them.
async function agentReads(impl: any, files: Record<string, string>)
    : Promise<Record<string, string>> {
  let names = Object.keys(files);
  let texts = await agentTurn(impl, names.map(filename =>
      fauxToolCall("readFile", { workpiece: "APP", filename })));
  return Object.fromEntries(names.map((name, i) => [name, texts[i]]));
}

// Every fold of the chat's log, and its content cache, agree that the gadget holds `expected`.
async function expectEveryFold(impl: any, expected: Record<string, string>): Promise<void> {
  expect(Object.fromEntries((await impl.buildChatContent(CHAT)).get(GADGET))).toEqual(expected);
  expect(await chatFiles(impl)).toEqual(expected);

  // The epoch's composed change, as a client folds it, over the live pin's tree.
  let messages = chatMessages(impl);
  let epoch = impl.storage.chatMeta.get(CHAT).codeBase.epoch ?? -1;
  let reverted = new Set(messages.filter(msg => msg.type === "revert")
      .flatMap(revert => messages.filter(msg =>
          msg.sequence >= (revert as any).revertFrom && msg.sequence < revert.sequence))
      .map(msg => msg.sequence));
  let composed = composeEpochChanges(messages.filter(msg =>
      msg.type === "changes" && msg.sequence >= epoch && !reverted.has(msg.sequence)) as any);
  let base = await commitTree(impl, pin(impl)!.baseCommit);
  let folded = composed === undefined ? base : applyCodeChange(base, composed);
  expect(Object.fromEntries(folded.get(GADGET)!)).toEqual(expected);

  // A checkpoint of the whole log replays to it: its pins' trees, then its change.
  let state = buildCompactionState(messages, messages.at(-1)!.sequence + 1, [], undefined);
  let checkpointPin = state.pins!.find(p => p.gadgetId === GADGET)!;
  expect(checkpointPin.baseCommit).toBe(pin(impl)!.baseCommit);
  let replayed = await commitTree(impl, checkpointPin.baseCommit);
  if (state.proposedChange) replayed = applyCodeChange(replayed, state.proposedChange);
  expect(Object.fromEntries(replayed.get(GADGET)!)).toEqual(expected);

  // And the agent's replay reads it.
  expect(await agentReads(impl, expected)).toEqual(expected);
}

const H0_FILES = { "a.txt": "one\n", "b.txt": "bee\n" };
const CHAT_EDIT = { "a.txt": "one\nchat\n", "b.txt": "bee\n" };
const MAINLINE_EDIT = { "a.txt": "one\n", "b.txt": "bee\nmain\n" };
const MERGED = { "a.txt": "one\nchat\n", "b.txt": "bee\nmain\n" };

// A gadget at H0 and a chat that edited it, pinned there, with mainline since moved on to H1.
async function staleChat(impl: any): Promise<{ h0: string, h1: string }> {
  let h0 = await commitFiles(impl, H0_FILES);
  impl.storage.gadgets.put({
    type: "gadget", id: GADGET, title: "App", created: new Date(0), bindingName: "APP",
    bindings: {}, commitId: h0,
  });
  impl.storage.chatMeta.put(
      { id: CHAT, title: "Chat", started: new Date(0), lastActive: new Date(0) });
  await edit(impl, H0_FILES, CHAT_EDIT);
  let h1 = await commitFiles(impl, MAINLINE_EDIT, [h0]);
  setHead(impl, h1);
  return { h0, h1 };
}

describe("a pin declaration re-roots its gadget", () => {
  it("every fold agrees on the content after a re-root, and after it is reverted",
      () => withImpl(async impl => {
    let { h0 } = await staleChat(impl);
    let { sequence } = await reroot(impl, MERGED);
    await edit(impl, MERGED, { ...MERGED, "b.txt": "bee\nmain\nmore\n" });
    await expectEveryFold(impl, { ...MERGED, "b.txt": "bee\nmain\nmore\n" });

    // Reverting the re-root brings back the declaration before it, the changes recorded
    // since, and the mainline commit the chat had merged before it. So the chat is stale again.
    await impl.revertChanges(CHAT, sequence, USER);
    expect(pin(impl)).toEqual({ gadgetId: GADGET, baseCommit: h0, mergedCommit: h0 });
    await expectEveryFold(impl, CHAT_EDIT);
    expect(await impl.mergeChanges(CHAT, USER_META, "alice-user-do"))
        .toEqual({ outcome: "stale" });
  }));

  it("a checkpoint taken after a re-root replays to the same content, and one before it too",
      () => withImpl(async impl => {
    await staleChat(impl);
    let { merge, sequence } = await reroot(impl, MERGED);
    let expected = { ...MERGED, "b.txt": "bee\nmain\nmore\n" };

    // Before: the checkpoint holds the edit the re-root drops, and the tail's re-root drops it.
    compact(impl, sequence);
    await edit(impl, MERGED, expected);
    expect(await agentReads(impl, expected)).toEqual(expected);

    // After: the checkpoint is rooted at the merge, and drops its predecessor's edit too.
    let state = compact(impl, chatMessages(impl).at(-1)!.sequence + 1);
    expect(state.pins).toEqual(
        [{ gadgetId: GADGET, baseCommit: merge, mergedCommit: head(impl) }]);
    expect(state.proposedChange).toEqual(diffFiles(
        new Map([[GADGET, new Map(Object.entries(MERGED))]]),
        new Map([[GADGET, new Map(Object.entries(expected))]])));
    expect(await agentReads(impl, expected)).toEqual(expected);
  }));

  it("makes the agent read a file again that the re-root changed, before it edits it",
      () => withImpl(async impl => {
    await staleChat(impl);
    expect(await agentReads(impl, CHAT_EDIT)).toEqual(CHAT_EDIT);
    await reroot(impl, { "a.txt": "one\nchat\n", "b.txt": "bee\nmain\n" });

    // a.txt is as the agent read it; b.txt is not.
    let [kept, refused] = await agentTurn(impl, [
      fauxToolCall("editFile",
          { workpiece: "APP", filename: "a.txt", textToReplace: "chat", replacement: "chat!" }),
      fauxToolCall("editFile",
          { workpiece: "APP", filename: "b.txt", textToReplace: "bee", replacement: "bee!" }),
    ]);
    expect(kept).toContain("success");
    expect(refused).toContain("You must read a file before you can edit it.");
  }));
});

describe("accepting a re-rooted chat", () => {
  it("makes the merge commit the head when nothing was edited since", () => withImpl(async impl => {
    await staleChat(impl);
    let { merge } = await reroot(impl, MERGED);
    expect(await impl.mergeChanges(CHAT, USER_META, "alice-user-do"))
        .toEqual({ outcome: "merged" });
    expect(head(impl)).toBe(merge);
    expect(chatMessages(impl).at(-1)).toMatchObject(
        { type: "merge", commits: [{ gadgetId: GADGET, commitId: merge }] });
  }));

  it("commits on top of the merge commit when something was edited since",
      () => withImpl(async impl => {
    await staleChat(impl);
    let { merge } = await reroot(impl, MERGED);
    let edited = { ...MERGED, "b.txt": "bee\nmain\nmore\n" };
    await edit(impl, MERGED, edited);
    expect(await impl.mergeChanges(CHAT, USER_META, "alice-user-do"))
        .toEqual({ outcome: "merged" });
    expect(Object.fromEntries(await impl.gitStore.readCommitFiles(head(impl)))).toEqual(edited);
    expect((await impl.gitStore.readCommitObject(head(impl))).parent).toEqual([merge]);
  }));

  it("moves the head to the merge commit though a checkpoint covers the re-root",
      () => withImpl(async impl => {
    await staleChat(impl);
    let { merge } = await reroot(impl, MERGED);
    // The checkpoint holds the pin and nothing else: the re-root dropped the only change.
    let state = compact(impl, chatMessages(impl).at(-1)!.sequence + 1);
    expect(state.proposedChange).toBeUndefined();
    expect(await impl.mergeChanges(CHAT, USER_META, "alice-user-do"))
        .toEqual({ outcome: "merged" });
    expect(head(impl)).toBe(merge);
  }));

  it("still adds a release that the merge commit's history lacks, and marks the commit",
      () => withImpl(async impl => {
    await staleChat(impl);
    // A blueprint proposal recorded before proposals were merge commits: the release is only
    // named, and accept is what gives the gadget's history the release as a parent.
    let release = await commitFiles(impl, { "a.txt": "released\n" });
    putMessage(impl, {
      type: "changes",
      blueprintMerges: [{
        gadgetId: GADGET, blueprintId: "blueprint-id", title: "Starter", version: 1,
        commitId: release, kind: "follow", conflictPaths: [],
      }],
    });
    let { merge } = await reroot(impl, MERGED);
    expect(await impl.mergeChanges(CHAT, USER_META, "alice-user-do"))
        .toEqual({ outcome: "merged" });
    let accepted = head(impl);
    expect((await impl.gitStore.readCommitObject(accepted)).parent).toEqual([merge, release]);
    expect(releasesMergedBy(impl.gitCache.readLocalObject(accepted).payload, accepted))
        .toEqual([release]);
    expect(impl.storage.gadgets.get(GADGET).upstream)
        .toEqual({ blueprintId: "blueprint-id", commitId: release });
  }));

  it("adds nothing for a release the merge commit's history already holds",
      () => withImpl(async impl => {
    await staleChat(impl);
    let release = await commitFiles(impl, { "a.txt": "released\n" });
    putMessage(impl, {
      type: "changes",
      blueprintMerges: [{
        gadgetId: GADGET, blueprintId: "blueprint-id", title: "Starter", version: 1,
        commitId: release, kind: "follow", conflictPaths: [],
      }],
    });
    // The merge commit merges the release, as an applied blueprint's will.
    let merge = await impl.gitStore.writeFilesAsCommit(
        new Map(Object.entries(MAINLINE_EDIT)), {
          parents: [head(impl), release], headers: [releaseMergeHeader(release)],
          author: { name: "Alice", email: "alice@example.com" }, message: "Merge blueprint",
          timestamp: new Date(1700000000_000),
        });
    let current = pin(impl)!;
    putMessage(impl, {
      type: "changes", pins: [{ gadgetId: GADGET, baseCommit: merge, mergedCommit: head(impl) }],
    });
    let meta = impl.storage.chatMeta.get(CHAT);
    meta.codeBase.pins = [{ ...current, baseCommit: merge, mergedCommit: head(impl) }];
    meta.codeBase.generation += 1;
    impl.storage.chatMeta.put(meta);

    expect(await impl.mergeChanges(CHAT, USER_META, "alice-user-do"))
        .toEqual({ outcome: "merged" });
    expect(head(impl)).toBe(merge);
  }));

  it("accepts a pin that an update from before re-roots advanced, as it did",
      () => withImpl(async impl => {
    let { h1 } = await staleChat(impl);
    await updateAsBefore(impl, MERGED);
    expect(pin(impl)!.mergedCommit).toBe(h1);
    expect(await impl.mergeChanges(CHAT, USER_META, "alice-user-do"))
        .toEqual({ outcome: "merged" });
    expect(Object.fromEntries(await impl.gitStore.readCommitFiles(head(impl)))).toEqual(MERGED);
    expect((await impl.gitStore.readCommitObject(head(impl))).parent).toEqual([h1]);
  }));
});

// Two re-roots of a stale chat, the second after mainline moved again.
async function twoReroots(impl: any) {
  let { h0, h1 } = await staleChat(impl);
  let first = await reroot(impl, MERGED);
  let h2 = await commitFiles(impl, { ...MAINLINE_EDIT, "c.txt": "sea\n" }, [h1]);
  setHead(impl, h2);
  let second = await reroot(impl, { ...MERGED, "c.txt": "sea\n" });
  return { h0, h1, first, second };
}

describe("reverting a re-root", () => {
  it("leaves mergedCommit where an update from before re-roots put it",
      () => withImpl(async impl => {
    let { h0, h1 } = await staleChat(impl);
    await updateAsBefore(impl, MERGED);

    // Mainline moves again, and this time the chat is re-rooted. Its declaration from before
    // still says the pin's mergedCommit was h0, but the chat's content had merged h1.
    let h2 = await commitFiles(impl, { ...MAINLINE_EDIT, "c.txt": "sea\n" }, [h1]);
    setHead(impl, h2);
    let { sequence } = await reroot(impl, { ...MERGED, "c.txt": "sea\n" });

    await impl.revertChanges(CHAT, sequence, USER);
    expect(pin(impl)).toEqual({ gadgetId: GADGET, baseCommit: h0, mergedCommit: h1 });
    expect(await chatFiles(impl)).toEqual(MERGED);
  }));

  it("puts back what the earliest of the re-roots it covers records", async () => {
    // Both at once: back to where the chat was before either.
    await withImpl(async impl => {
      let { h0, first } = await twoReroots(impl);
      await impl.revertChanges(CHAT, first.sequence, USER);
      expect(pin(impl)).toEqual({ gadgetId: GADGET, baseCommit: h0, mergedCommit: h0 });
      expect(await chatFiles(impl)).toEqual(CHAT_EDIT);
    });
    // The second alone: back to the first.
    await withImpl(async impl => {
      let { h1, first, second } = await twoReroots(impl);
      await impl.revertChanges(CHAT, second.sequence, USER);
      expect(pin(impl)).toEqual({ gadgetId: GADGET, baseCommit: first.merge, mergedCommit: h1 });
      expect(await chatFiles(impl)).toEqual(MERGED);
    });
  });
});
