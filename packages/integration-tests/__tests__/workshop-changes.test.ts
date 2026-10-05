import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMetadata, AiChatStreamEvent, AiChatSubscriber, AuthenticatedApi,
  GadgetMetadata, Overseer, PublicApi, WorkpieceId,
} from "@gadgets/workshop-shared/api";
import {
  applyCodeChange, diffFiles, type CodeChange, type CodeContent,
} from "@gadgets/workshop-shared/code-change";
import { loadAllChatHistory, openAgentSession } from "../src/agent-session.js";
import { settleRestart, startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import {
  scriptedModelRouter, SCRIPTED_MODEL_ID, type ChatCompletionStep, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, nextUsernames, restartWorkspace, RpcTarget, signUp,
  streamGeneration, stubFor, waitFor, WorkpieceRecorder,
} from "../src/rpc-client.js";

type AppliedChange = {
  chatId: number;
  generation: number;
  revision: number;
  change: CodeChange;
  submission?: { clientId: string; seq: number };
};

class ChatRecorder extends RpcTarget implements AiChatSubscriber {
  readonly chats = new Map<number, AiChatMetadata>();
  readonly applied: AppliedChange[] = [];
  streamGeneration(_generation: number): void {}
  metadata(chat: AiChatMetadata): void { this.chats.set(chat.id, chat); }
  deleted(_chatId: number): void {}
  message(_message: AiChatMessage): void {}
  changeApplied(chatId: number, generation: number, revision: number, _author: AiChatAuthorInfo,
                change: CodeChange, submission?: { clientId: string; seq: number }): void {
    this.applied.push({ chatId, generation, revision, change, submission });
  }
  stream(_chatId: number, _event: AiChatStreamEvent): void {}
}

type Client = { ws: RpcStub<Overseer>; workpieces: WorkpieceRecorder; chats: ChatRecorder };

const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

async function withClient<T>(
    auth: (api: RpcStub<PublicApi>) => Promise<RpcStub<AuthenticatedApi>>,
    open: (api: RpcStub<AuthenticatedApi>) => Promise<RpcStub<Overseer>>,
    fn: (client: Client, api: RpcStub<AuthenticatedApi>) => Promise<T>): Promise<T> {
  using publicApi = connect(harness.url);
  using api = await auth(publicApi);
  using ws = await open(api);
  const workpieces = new WorkpieceRecorder();
  const chats = new ChatRecorder();
  using workpiecesStub = stubFor(workpieces);
  using chatsStub = stubFor(chats);
  using _workpieces = await ws.subscribeToWorkpieces(workpiecesStub);
  using _chats = await ws.subscribeToChat(chatsStub);
  await workpieces.loaded;
  return await fn({ ws, workpieces, chats }, api);
}

function withOwner<T>(
    fn: (client: Client, api: RpcStub<AuthenticatedApi>, username: string) => Promise<T>,
    model?: RoutedScriptedModel): Promise<T> {
  const username = nextUsernames("owner")[0]!;
  return withClient(api => signUp(api, username), async api => {
    if (model !== undefined) await api.addModel(model.userModel.profile, model.userModel.config);
    return api.newGadget();
  }, (client, api) => fn(client, api, username));
}

/** Reopen an account's sole workspace over a fresh connection. */
function reopen<T>(
    username: string, fn: (client: Client, api: RpcStub<AuthenticatedApi>) => Promise<T>): Promise<T> {
  return withClient(api => logIn(api, username), async api => {
    const [workspace] = await waitFor("the session's workspace", async () => {
      const workspaces = await api.listGadgets();
      return workspaces.length > 0 ? workspaces : null;
    });
    return api.openGadget(workspace.id);
  }, fn);
}

const toolCall = (name: string, args: Record<string, unknown>, id = name): ChatCompletionStep =>
  ({ toolCall: { id: `call-${id}`, name, arguments: args } });

const files = (gadgetId: number, path: string, text?: string): CodeContent =>
  new Map([[gadgetId, new Map(text === undefined ? [] : [[path, text]])]]);

const edit = (gadgetId: number, path: string, before: string | undefined, after: string) =>
  diffFiles(files(gadgetId, path, before), files(gadgetId, path, after));

const changesOf = (chats: ChatRecorder, chatId: number, count: number) =>
  waitFor(`${count} changes to chat ${chatId}`, async () => {
    const changes = chats.applied.filter(change => change.chatId === chatId);
    return changes.length >= count ? changes : null;
  });

const headOf = (workpieces: WorkpieceRecorder, gadgetId: WorkpieceId, after?: string) =>
  waitFor(`a new head for gadget ${gadgetId}`, async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined &&
        summary.commitId !== after ? summary.commitId : null;
  });

const textAfter = (changes: AppliedChange[], gadgetId: number, path: string, base: string) =>
  changes.reduce((content, { change }) => applyCodeChange(content, change), files(gadgetId, path, base))
    .get(gadgetId)?.get(path);

const parentsOf = async (ws: RpcStub<Overseer>, commitId: string) =>
  (await ws.getCommitLog(commitId, 1))[0]?.parents;

async function expectText(ws: RpcStub<Overseer>, commitId: string, path: string, text: string) {
  expect(await ws.readFilesAtCommit(commitId, [path])).toEqual([[path, { kind: "text", text }]]);
}

async function changesMessages(ws: RpcStub<Overseer>, chatId: number) {
  const history = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  return history.flatMap(message => message.type === "changes" ? [message] : []);
}

/** Create permanent gadget `APP` and merge one file into it through a human-only chat. */
async function seedGadget({ ws, workpieces }: Client, path: string, text: string) {
  using gadget = ws.createGadget("App", undefined, "APP");
  const gadgetId = await gadget.getId();
  const empty = await headOf(workpieces, gadgetId);
  const chatId = await ws.newChat("Seed", null);
  await ws.submitCodeChange(chatId, {
    generation: 0, revision: 0, clientId: "seed", seq: 1,
    pins: [{ gadgetId, baseCommit: empty }], change: edit(gadgetId, path, undefined, text),
  });
  expect(await ws.mergeChanges(chatId)).toEqual({ outcome: "merged" });
  return { gadgetId, head: await headOf(workpieces, gadgetId, empty) };
}

const APP_SERVER =
    `import { DurableObject } from "cloudflare:workers";\nexport class Gadget extends DurableObject {}\n`;

it.concurrent("accepting agent changes makes the gadget, its code and its binding permanent",
    async () => {
  const model = models.script([
    toolCall("createGadget", { title: "App", bindingName: "APP" }),
    toolCall("writeFile", { workpiece: "APP", filename: "server.js", content: APP_SERVER }),
    toolCall("setGadgetBinding", { gadget: "APP", source: "TEST_AMBIENT", name: "DATA" }),
    { text: "Done." },
  ]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID, userModel: model.userModel, ambientVendorIds: [TEST_VENDOR_ID],
  });
  const { outcome, history } = await session.runTurn("Build an app bound to the test data.");
  expect(outcome).toEqual({ status: "completed" });
  expect(model.remainingSteps()).toBe(0);
  const chatId = history[0]!.chatId;
  const changes = history.flatMap(message => message.type === "changes" ? [message] : []);
  const [{ gadgetId }] = changes.flatMap(message => message.createdGadgets ?? []);
  const [{ target }] = changes.flatMap(message => message.addedBindings ?? []);

  await reopen(session.username, async ({ ws, workpieces }) => {
    expect((await ws.listChats()).find(chat => chat.id === chatId)?.proposedChangeWorkpieces)
        .toEqual([gadgetId]);
    expect(workpieces.summaries.get(gadgetId)).toMatchObject({ chatId });
    expect(workpieces.summaries.get(gadgetId)).not.toHaveProperty("commitId");
    using gadget = await ws.getGadget(gadgetId);
    expect((await gadget.listBindings()).map(binding => binding.name)).not.toContain("DATA");
    expect(await gadget.listBindings(chatId))
        .toContainEqual(expect.objectContaining({ name: "DATA", target, chatId }));
    expect(await ws.mergeChanges(chatId)).toEqual({ outcome: "merged" });
  });

  await reopen(session.username, async ({ ws, workpieces }) => {
    const commitId = await headOf(workpieces, gadgetId);
    expect(workpieces.summaries.get(gadgetId)?.chatId).toBeUndefined();
    expect(await ws.listTree(commitId)).toEqual([{ name: "server.js", kind: "file" }]);
    await expectText(ws, commitId, "server.js", APP_SERVER);
    using gadget = await ws.getGadget(gadgetId);
    const data = (await gadget.listBindings()).find(binding => binding.name === "DATA");
    expect(data).toMatchObject({ target });
    expect(data?.chatId).toBeUndefined();
  });
});

it.concurrent("one accept commits both gadgets a chat built, each with only its own code",
    async () => {
  const built = [{ name: "A", path: "a.txt", text: "made for A\n" },
                 { name: "B", path: "b.txt", text: "made for B\n" }];
  const model = models.script([
    ...built.map(({ name }) =>
      toolCall("createGadget", { title: name, bindingName: name }, `create-${name}`)),
    ...built.map(({ name, path, text }) =>
      toolCall("writeFile", { workpiece: name, filename: path, content: text }, `write-${name}`)),
    ...built.map(({ name }) => toolCall("setGadgetBinding",
      { gadget: name, source: "TEST_AMBIENT", name: "DATA" }, `bind-${name}`)),
    { text: "Done." },
  ]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID, userModel: model.userModel, ambientVendorIds: [TEST_VENDOR_ID],
  });
  const { outcome, history } = await session.runTurn("Build two apps bound to the test data.");
  expect(outcome).toEqual({ status: "completed" });
  expect(model.remainingSteps()).toBe(0);
  const chatId = history[0]!.chatId;
  const changes = history.flatMap(message => message.type === "changes" ? [message] : []);
  const created = changes.flatMap(message => message.createdGadgets ?? []);
  const gadgets = built.map(gadget => ({ ...gadget,
    gadgetId: created.find(({ bindingName }) => bindingName === gadget.name)!.gadgetId }));
  const [a, b] = gadgets.map(({ gadgetId }) => gadgetId) as [WorkpieceId, WorkpieceId];
  const [{ target }] = changes.flatMap(message => message.addedBindings ?? []);

  const [headA, headB] = await reopen(session.username, async ({ ws, workpieces }) => {
    expect((await ws.listChats()).find(chat => chat.id === chatId)?.proposedChangeWorkpieces
        ?.toSorted()).toEqual([a, b].toSorted());
    expect(await ws.mergeChanges(chatId)).toEqual({ outcome: "merged" });
    const heads = [];
    for (const { gadgetId, path, text } of gadgets) {
      const head = await headOf(workpieces, gadgetId);
      expect(await ws.listTree(head)).toEqual([{ name: path, kind: "file" }]);
      await expectText(ws, head, path, text);
      using gadget = await ws.getGadget(gadgetId);
      expect(await gadget.listBindings())
          .toContainEqual(expect.objectContaining({ name: "DATA", target }));
      heads.push(head);
    }
    return heads as [string, string];
  });

  await reopen(session.username, async ({ ws, workpieces }) => {
    const editA = await ws.newChat("Edit A", null);
    await ws.submitCodeChange(editA, {
      generation: 0, revision: 0, clientId: "editor", seq: 1,
      pins: [{ gadgetId: a, baseCommit: headA }],
      change: edit(a, "a.txt", built[0]!.text, "edited A\n"),
    });
    expect(await ws.mergeChanges(editA)).toEqual({ outcome: "merged" });
    const head = await headOf(workpieces, a, headA);
    await expectText(ws, head, "a.txt", "edited A\n");
    expect((await ws.getCommitLog(head, 2)).map(commit => commit.oid)).toEqual([head, headA]);
  });
  // A fresh snapshot, so a stray update to B can't still be in flight.
  await reopen(session.username, async ({ workpieces }) => {
    expect(workpieces.summaries.get(b)).toMatchObject({ commitId: headB });
  });
});

const MARKERS = "line1\n<<<<<<< mainline\nOURS\n||||||| merged base\nline2\n=======\nTHEIRS\n" +
    ">>>>>>> this chat\nline3\n";

it.concurrent.for([
  {
    lines: "different", base: "a\nb\nc\nd\ne\n", ours: "A\nb\nc\nd\ne\n", theirs: "a\nb\nc\nd\nE\n",
    conflicted: false, draft: "A\nb\nc\nd\nE\n", resolved: undefined,
  },
  {
    lines: "the same", base: "line1\nline2\nline3\n", ours: "line1\nOURS\nline3\n",
    theirs: "line1\nTHEIRS\nline3\n", conflicted: true, draft: MARKERS,
    resolved: "line1\nOURS + THEIRS\nline3\n",
  },
])("a stale chat edited on $lines lines pulls in mainline and merges", async row => {
  await withOwner(async client => {
    const { ws, workpieces } = client;
    const { gadgetId, head } = await seedGadget(client, "client.js", row.base);
    using gadget = await ws.getGadget(gadgetId);
    const chatA = await ws.newChat("A", null);
    const chatB = await ws.newChat("B", null);
    const pins = [{ gadgetId, baseCommit: head }];
    await ws.submitCodeChange(chatA, {
      generation: 0, revision: 0, clientId: "a", seq: 1, pins,
      change: edit(gadgetId, "client.js", row.base, row.ours),
    });
    await ws.submitCodeChange(chatB, {
      generation: 0, revision: 0, clientId: "b", seq: 1, pins,
      change: edit(gadgetId, "client.js", row.base, row.theirs),
    });
    const codeBaseOfB = async () => (await ws.listChats()).find(chat => chat.id === chatB)?.codeBase;
    const preview = async () => (await gadget.getUiBundle(chatB))?.jsCode;

    expect(await ws.mergeChanges(chatA)).toEqual({ outcome: "merged" });
    const mainline = await headOf(workpieces, gadgetId, head);
    expect(await ws.mergeChanges(chatB)).toEqual({ outcome: "stale" });
    expect((await codeBaseOfB())?.generation).toBe(0);
    expect(workpieces.summaries.get(gadgetId)).toMatchObject({ commitId: mainline });
    await expectText(ws, mainline, "client.js", row.ours);

    // The update is a merge commit of mainline and the chat's files before it, and the chat's
    // pin re-roots there. The message that says so carries no change of its own.
    const conflictPaths = row.conflicted ? ["client.js"] : [];
    const update = async () => {
      expect(await ws.updateChatFromMainline(chatB))
          .toEqual({ conflictPaths: conflictPaths.map(path => `APP/${path}`) });
      const message = (await changesMessages(ws, chatB)).findLast(entry => entry.mainlineMerge);
      expect(message?.change).toBeUndefined();
      expect(message?.mainlineMerge?.gadgets).toEqual(
          [{ gadgetId, baseCommit: head, chatCommit: expect.any(String), conflictPaths }]);
      const [{ chatCommit }] = message!.mainlineMerge!.gadgets!;
      const [{ baseCommit: merged }] = message!.pins!;
      expect(message?.pins).toEqual([{ gadgetId, baseCommit: merged, mergedCommit: mainline }]);
      expect(await parentsOf(ws, merged)).toEqual([mainline, chatCommit]);
      expect(await parentsOf(ws, chatCommit)).toEqual([head]);
      await expectText(ws, chatCommit, "client.js", row.theirs);
      await expectText(ws, merged, "client.js", row.draft);
      expect(await preview()).toBe(row.draft);
      return { message: message!, merged };
    };

    const first = await update();
    const rerooted = await codeBaseOfB();
    expect(rerooted).toMatchObject({
      generation: 1, revision: 0, pins: [{ gadgetId, baseCommit: first.merged, mergedCommit: mainline }],
    });
    expect(rerooted).not.toHaveProperty("prior");

    // Reverting the update puts the chat back as it was before, stale again.
    await ws.revertChanges(chatB, first.message.sequence);
    expect(await preview()).toBe(row.theirs);
    expect((await codeBaseOfB())?.pins).toEqual([{ gadgetId, baseCommit: head, mergedCommit: head }]);
    expect(await ws.mergeChanges(chatB)).toEqual({ outcome: "stale" });

    const { merged } = await update();
    if (row.resolved !== undefined) {
      const { generation, revision } = (await codeBaseOfB())!;
      await ws.submitCodeChange(chatB, {
        generation, revision, clientId: "b", seq: 2,
        change: edit(gadgetId, "client.js", row.draft, row.resolved),
      });
      expect(await preview()).toBe(row.resolved);
    }
    expect(await ws.mergeChanges(chatB)).toEqual({ outcome: "merged" });

    // The merge commit becomes the gadget's head, or the parent of one holding the resolution.
    const accepted = await headOf(workpieces, gadgetId, mainline);
    await expectText(ws, accepted, "client.js", row.resolved ?? row.draft);
    if (row.resolved === undefined) expect(accepted).toBe(merged);
    else expect(await parentsOf(ws, accepted)).toEqual([merged]);
  });
});

it.concurrent("two simultaneous chat merges choose one complete version", async () => {
  await withOwner(async client => {
    const { ws, workpieces } = client;
    const base = "base\n";
    const { gadgetId, head } = await seedGadget(client, "app.txt", base);
    const texts = ["from chat A\n", "from chat B\n"];
    const chatIds = [];
    for (const [i, text] of texts.entries()) {
      const chatId = await ws.newChat(`Chat ${i}`, null);
      await ws.submitCodeChange(chatId, {
        generation: 0, revision: 0, clientId: `editor-${i}`, seq: 1,
        pins: [{ gadgetId, baseCommit: head }], change: edit(gadgetId, "app.txt", base, text),
      });
      chatIds.push(chatId);
    }

    const outcomes = (await Promise.all(chatIds.map(chatId => ws.mergeChanges(chatId))))
        .map(result => result.outcome);
    expect(outcomes.toSorted()).toEqual(["merged", "stale"]);
    const mainline = await headOf(workpieces, gadgetId, head);
    await expectText(ws, mainline, "app.txt", texts[outcomes.indexOf("merged")]!);
    const log = await ws.getCommitLog(mainline, 2);
    expect(log.map(commit => commit.oid)).toEqual([mainline, head]);
    expect(log[0]!.parents).toEqual([head]);
  });
});

it.concurrent("a second session follows renames, drafts, merges and reverts", async () => {
  await withOwner(async (writer, _api, username) => {
    const { id } = await writer.ws.getMetadata();
    await withClient(api => logIn(api, username), api => api.openGadget(id), async reader => {
      const metadataEvents: GadgetMetadata[] = [];
      using _metadata = await reader.ws.subscribeToMetadata(metadata => {
        metadataEvents.push(metadata);
      });
      const initialMetadata = await waitFor("the reader's metadata", async () =>
        metadataEvents[0] ?? null);
      const title = "Synchronized workspace";
      await writer.ws.setTitle(title);
      expect(await waitFor("the renamed workspace", async () =>
        metadataEvents.find(metadata => metadata.title === title) ?? null))
          .toEqual({ ...initialMetadata, title });

      using gadget = writer.ws.createGadget("Shared App", undefined, "APP");
      const gadgetId = await gadget.getId();
      const initialHead = await headOf(writer.workpieces, gadgetId);
      const readerChat = (chatId: number, test: (chat: AiChatMetadata) => boolean) =>
        waitFor(`chat ${chatId} in the second session`, async () => {
          const chat = reader.chats.chats.get(chatId);
          return chat !== undefined && test(chat) ? chat : null;
        });
      const propose = async (chatId: number, baseCommit: string, before: string | undefined,
                             after: string) => {
        await writer.ws.submitCodeChange(chatId, {
          generation: 0, revision: 0, clientId: "writer", seq: 1,
          pins: [{ gadgetId, baseCommit }], change: edit(gadgetId, "shared.txt", before, after),
        });
        const chat = await readerChat(chatId, chat => chat.proposedChangeWorkpieces !== undefined);
        expect(chat.proposedChangeWorkpieces).toEqual([gadgetId]);
      };

      const merged = await writer.ws.newChat("Merge this draft", null);
      const chatTitle = "Renamed shared chat";
      await writer.ws.setChatTitle(merged, chatTitle);
      await readerChat(merged, chat => chat.title === chatTitle);
      await propose(merged, initialHead, undefined, "merged\n");
      expect(await writer.ws.mergeChanges(merged)).toEqual({ outcome: "merged" });
      const mergedHead = await headOf(reader.workpieces, gadgetId, initialHead);
      const author = { name: username, email: `${username}@localhost` };
      const log = [
        { oid: mergedHead, parents: [initialHead], message: `Accept changes from chat: ${chatTitle}\n` },
        { oid: initialHead, parents: [], message: "Create gadget: Shared App\n" },
      ].map(commit => ({ ...commit, author, timestamp: expect.any(Date) }));
      expect(await reader.ws.getCommitLog(mergedHead)).toEqual(log);

      const reverted = await writer.ws.newChat("Revert this draft", null);
      await propose(reverted, mergedHead, "merged\n", "merged\nreverted\n");
      await writer.ws.revertChanges(reverted, 0);
      await readerChat(reverted, chat => chat.proposedChangeWorkpieces === undefined);
      expect(reader.workpieces.summaries.get(gadgetId)).toMatchObject({ commitId: mergedHead });
      expect(await reader.ws.getCommitLog(mergedHead)).toEqual(log);
    });
  });
});

it.concurrent("reverting agent steps drops their code, then the gadget and its name claim",
    async () => {
  const client = `document.body.textContent = "step 2";\n`;
  const model = models.script([
    toolCall("createGadget", { title: "App", bindingName: "APP" }),
    toolCall("writeFile", { workpiece: "APP", filename: "client.js", content: client }),
    { text: "Done." },
  ]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID, userModel: model.userModel,
  });
  const { outcome, history } = await session.runTurn("Build an app.");
  expect(outcome).toEqual({ status: "completed" });
  expect(model.remainingSteps()).toBe(0);
  const chatA = history[0]!.chatId;
  const [step1, step2] = history.filter(message => message.type === "changes");
  expect(step2).toBeDefined();
  const [{ gadgetId }] = step1!.type === "changes" ? step1.createdGadgets ?? [] : [];

  await reopen(session.username, async ({ ws, workpieces }) => {
    const proposed = async () =>
      (await ws.listChats()).find(chat => chat.id === chatA)?.proposedChangeWorkpieces ?? [];
    using gadget = await ws.getGadget(gadgetId);
    expect(await gadget.getUiBundle(chatA)).toEqual({ jsCode: client });

    await ws.revertChanges(chatA, step2!.sequence);
    expect(await proposed()).toEqual([gadgetId]);
    expect(workpieces.summaries.get(gadgetId)).toMatchObject({ chatId: chatA });
    expect(await gadget.getUiBundle(chatA)).toBeNull();
    const chatB = await ws.newChat("Another take", null);
    await expect(ws.createGadget("App", chatB, "APP"))
        .rejects.toThrow('The gadget name "APP" is claimed by a gadget still pending in another chat');

    await ws.revertChanges(chatA, step1!.sequence);
    await waitFor("the provisional gadget's removal", async () =>
      workpieces.summaries.has(gadgetId) ? null : true);
    expect(await proposed()).toEqual([]);
    using _replacement = await ws.createGadget("App", chatB, "APP");
  });
});

it.concurrent("deleting a chat drops its provisional gadget, binding claim and attachment", async () => {
  let accountId: number | undefined;
  await withClient(api => signUp(api, nextUsernames("chatdelete")[0]!), async api => {
    await api.provisionAmbientAccount(TEST_VENDOR_ID);
    accountId = (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID)?.id;
    return api.newGadget();
  }, async ({ ws, workpieces }) => {
    if (accountId === undefined) throw new Error("The test account was not provisioned");
    using data = await ws.newGatekeeper(accountId, "https://gadgets-test.example/things/chat-delete");
    if (data === null) throw new Error("The test connection was not created");
    const dataId = await data.getId();
    using app = await ws.createGadget("App", undefined, "APP");
    const upload = await ws.uploadChatAttachment(
        { mimeType: "text/plain", content: new TextEncoder().encode("chat A notes"), name: "notes.txt" }, null);
    const chatA = await ws.newChat("A", null, undefined, [upload]);
    const chatB = await ws.newChat("B", null);
    using draft = await ws.createGadget("Draft", chatA, "DRAFT");
    const draftId = await draft.getId();
    await app.bind("DATA", dataId, chatA);

    await expect(ws.createGadget("Draft", chatB, "DRAFT"))
        .rejects.toThrow('The gadget name "DRAFT" is claimed by a gadget still pending in another chat');
    await expect(app.bind("DATA", dataId, chatB))
        .rejects.toThrow('The binding name "DATA" is already proposed by another chat.');
    expect(new TextDecoder().decode(await ws.getChatAttachmentContent(chatA, upload.id))).toBe("chat A notes");

    await ws.deleteChat(chatA);

    await waitFor("the provisional gadget's removal", async () =>
      workpieces.summaries.has(draftId) ? null : true);
    await expect(ws.getChatAttachmentContent(chatA, upload.id)).rejects.toThrow("Chat attachment not found.");
    using _replacement = await ws.createGadget("Draft", chatB, "DRAFT");
    await app.bind("DATA", dataId, chatB);
    expect(await app.listBindings(chatB))
        .toContainEqual(expect.objectContaining({ name: "DATA", target: dataId, chatId: chatB }));
  });
});

it.concurrent("two editors of one chat draft converge, and retries are idempotent", async () => {
  const model = models.script([{ pending: true }]);
  await withOwner(async owner => {
    const { gadgetId, head } = await seedGadget(owner, "app.txt", "middle\n");
    const { id } = await owner.ws.getMetadata();
    const [name] = nextUsernames("collaborator");
    await withClient(api => signUp(api, name), async api => {
      await owner.ws.addCollaborator(name, "build");
      return api.openGadget(id);
    }, async collaborator => {
      const chatId = await owner.ws.newChat("Let's edit together", null);
      const pins = [{ gadgetId, baseCommit: head }];
      const ownerEdit = {
        generation: 0, revision: 0, clientId: "owner", seq: 1, pins,
        change: edit(gadgetId, "app.txt", "middle\n", "top\nmiddle\n"),
      };
      const [ack] = await Promise.all([
        owner.ws.submitCodeChange(chatId, ownerEdit),
        collaborator.ws.submitCodeChange(chatId, {
          ...ownerEdit, clientId: "collaborator",
          change: edit(gadgetId, "app.txt", "middle\n", "middle\nbottom\n"),
        }),
      ]);
      const seen = await changesOf(owner.chats, chatId, 2);
      expect(await changesOf(collaborator.chats, chatId, 2)).toEqual(seen);
      expect(textAfter(seen, gadgetId, "app.txt", "middle\n")).toBe("top\nmiddle\nbottom\n");

      expect(await owner.ws.submitCodeChange(chatId, ownerEdit)).toEqual(ack);
      await expect(owner.ws.submitCodeChange(chatId, {
        ...ownerEdit, change: edit(gadgetId, "app.txt", "middle\n", "other\nmiddle\n"),
      })).rejects.toThrow("A submission reused a seq with different content");

      const sending = owner.ws.sendChatMessage(chatId, "Take it from here.", SCRIPTED_MODEL_ID);
      try {
        await waitFor("the agent's model request", async () => model.requests.length > 0 || null);
        await expect(collaborator.ws.submitCodeChange(chatId, {
          generation: 0, revision: 2, clientId: "collaborator", seq: 2,
          change: edit(gadgetId, "app.txt", "top\nmiddle\nbottom\n", "top\nmiddle\nbottom\nend\n"),
        })).rejects.toThrow("Agent is running, wait for it to finish.");
      } finally {
        await owner.ws.stopAgent(chatId);
        await Promise.allSettled([sending]);
        sending[Symbol.dispose]();
      }
      expect(model.requests).toHaveLength(1);
      for (const { chats } of [owner, collaborator]) {
        expect(chats.applied.filter(change => change.chatId === chatId)).toHaveLength(2);
      }
    });
  }, model);
});

it.concurrent("an edit rooted before a merge is carried into the new generation", async () => {
  await withOwner(async client => {
    const { ws, workpieces } = client;
    const { gadgetId, head } = await seedGadget(client, "app.txt", "one\n");
    const chatId = await ws.newChat("Edit", null);
    await ws.submitCodeChange(chatId, {
      generation: 0, revision: 0, clientId: "editor", seq: 1, pins: [{ gadgetId, baseCommit: head }],
      change: edit(gadgetId, "app.txt", "one\n", "one\nfirst\n"),
    });
    expect(await ws.mergeChanges(chatId)).toEqual({ outcome: "merged" });
    const merged = await headOf(workpieces, gadgetId, head);

    expect(await ws.submitCodeChange(chatId, {
      generation: 0, revision: 1, clientId: "editor", seq: 2,
      change: edit(gadgetId, "app.txt", "one\nfirst\n", "one\nfirst\nlate\n"),
    })).toEqual({ generation: 1, revision: 1 });
    expect(await ws.mergeChanges(chatId)).toEqual({ outcome: "merged" });
    await expectText(ws, await headOf(workpieces, gadgetId, merged), "app.txt", "one\nfirst\nlate\n");
  });
});

it.concurrent.for(["revert", "discard"] as const)(
    "an edit rooted before a %s is rejected, and resubscribing gives the new code base",
    async bump => {
  await withOwner(async client => {
    const { ws } = client;
    const { gadgetId, head } = await seedGadget(client, "app.txt", "one\n");
    const chatId = await ws.newChat("Edit", null);
    await ws.submitCodeChange(chatId, {
      generation: 0, revision: 0, clientId: "first", seq: 1, pins: [{ gadgetId, baseCommit: head }],
      change: edit(gadgetId, "app.txt", "one\n", "one\nfirst\n"),
    });
    if (bump === "revert") {
      await ws.finalizeChatDraft(chatId);
      await ws.revertChanges(chatId, 0);
    } else {
      await ws.discardChatDraftChanges(chatId);
    }

    await expect(ws.submitCodeChange(chatId, {
      generation: 0, revision: 1, clientId: "second", seq: 1,
      change: edit(gadgetId, "app.txt", "one\nfirst\n", "one\nfirst\nlate\n"),
    })).rejects.toThrow("rebuild from fresh metadata");

    const replay = new ChatRecorder();
    using replayStub = stubFor(replay);
    using _subscription = await ws.subscribeToChat(replayStub, new Date(0));
    expect(await waitFor("the replayed chat metadata", async () =>
      replay.chats.get(chatId)?.codeBase ?? null)).toEqual({ generation: 1, revision: 0, pins: [] });
  });
});

type VersionedGadget = RpcStub<{ version(): string }>;

const server = (version: string) => `import { DurableObject } from "cloudflare:workers";\n` +
    `export class Gadget extends DurableObject {\n  version() { return "${version}"; }\n}\n`;

it.concurrent("draft and mainline code run separately across merge and revert", async () => {
  await withOwner(async client => {
    const { ws, workpieces } = client;
    const { gadgetId, head } = await seedGadget(client, "server.js", server("v1"));
    // Drafts run only materialized changes, and one facet serves both draft and mainline.
    const running = async (chatId: number) => {
      await ws.finalizeChatDraft(chatId);
      using gadget = await ws.getGadget(gadgetId);
      const versions = [];
      for (const target of [chatId, undefined]) {
        using facet = await gadget.connectToGadget(target) as VersionedGadget;
        versions.push(await facet.version());
      }
      return versions;
    };

    const chatId = await ws.newChat("Edit", null);
    await ws.submitCodeChange(chatId, {
      generation: 0, revision: 0, clientId: "editor", seq: 1, pins: [{ gadgetId, baseCommit: head }],
      change: edit(gadgetId, "server.js", server("v1"), server("v2")),
    });
    expect(await running(chatId)).toEqual(["v2", "v1"]);

    expect(await ws.mergeChanges(chatId)).toEqual({ outcome: "merged" });
    const merged = await headOf(workpieces, gadgetId, head);
    expect(await running(chatId)).toEqual(["v2", "v2"]);

    await ws.submitCodeChange(chatId, {
      generation: 1, revision: 0, clientId: "editor", seq: 2,
      pins: [{ gadgetId, baseCommit: merged }],
      change: edit(gadgetId, "server.js", server("v2"), server("v3")),
    });
    expect(await running(chatId)).toEqual(["v3", "v2"]);

    await ws.revertChanges(chatId, (await changesMessages(ws, chatId)).at(-1)!.sequence);
    expect(await running(chatId)).toEqual(["v2", "v2"]);
  });
});

type StatefulGadget = RpcStub<{
  version(): string;
  put(key: string, value: string): void;
  get(key: string): string | null;
}>;

const stateServer = (version: string) => `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  version() { return "${version}"; }
  async put(key, value) { await this.ctx.storage.put(key, value); }
  async get(key) { return (await this.ctx.storage.get(key)) ?? null; }
}
`;

/** Run `act` on a gadget's server (mainline, or `chatId`'s draft), then read back its state. */
async function gadgetState(ws: RpcStub<Overseer>, gadgetId: WorkpieceId, chatId?: number,
                           act?: (facet: StatefulGadget) => unknown) {
  using gadget = await ws.getGadget(gadgetId);
  using facet = await gadget.connectToGadget(chatId) as StatefulGadget;
  await act?.(facet);
  return { version: await facet.version(), k: await facet.get("k") };
}

it.concurrent("gadget state survives code changes and restart but is not copied to a blueprint",
    async () => {
  const v2State = { version: "v2", k: "v1-data" };
  const { username, gadgetId, generation } = await withOwner(async (client, _api, username) => {
    const { ws, workpieces } = client;
    const { gadgetId, head } = await seedGadget(client, "server.js", stateServer("v1"));
    expect(await gadgetState(ws, gadgetId, undefined, facet => facet.put("k", "v1-data")))
        .toEqual({ version: "v1", k: "v1-data" });

    const v2Chat = await ws.newChat("V2", null);
    await ws.submitCodeChange(v2Chat, {
      generation: 0, revision: 0, clientId: "editor", seq: 1, pins: [{ gadgetId, baseCommit: head }],
      change: edit(gadgetId, "server.js", stateServer("v1"), stateServer("v2")),
    });
    expect(await ws.mergeChanges(v2Chat)).toEqual({ outcome: "merged" });
    const v2Head = await headOf(workpieces, gadgetId, head);
    expect(await gadgetState(ws, gadgetId)).toEqual(v2State);

    const v3Chat = await ws.newChat("V3", null);
    await ws.submitCodeChange(v3Chat, {
      generation: 0, revision: 0, clientId: "editor", seq: 1, pins: [{ gadgetId, baseCommit: v2Head }],
      change: edit(gadgetId, "server.js", stateServer("v2"), stateServer("v3")),
    });
    await ws.finalizeChatDraft(v3Chat);
    expect((await gadgetState(ws, gadgetId, v3Chat)).version).toBe("v3");

    // There is no public mainline revert (`revertChanges` on a merged message is a no-op), so
    // reverting a later draft is the revert users can reach.
    await ws.revertChanges(v3Chat, (await changesMessages(ws, v3Chat)).at(-1)!.sequence);
    expect(await gadgetState(ws, gadgetId)).toEqual(v2State);

    const generation = await streamGeneration(ws);
    await restartWorkspace(harness.url, ws);
    await settleRestart();
    return { username, gadgetId, generation };
  });

  await reopen(username, async ({ ws }, api) => {
    expect(await streamGeneration(ws)).not.toBe(generation);
    expect(await gadgetState(ws, gadgetId)).toEqual(v2State);

    using source = await ws.getGadget(gadgetId);
    const blueprint = await source.createBlueprint("Stateful app", "V2 without its state");
    using installed = await api.newGadgetFromBlueprint(blueprint.id, {});
    const { defaultGadgetId } = await installed.getMetadata();
    if (defaultGadgetId === undefined) throw new Error("Installed workspace has no default Gadget");
    expect(await gadgetState(installed, defaultGadgetId))
        .toEqual({ version: "v2", k: null });
    expect(await gadgetState(ws, gadgetId)).toEqual(v2State);
  });
});

it.concurrent("agent code runs the gadget edits made in earlier steps of its turn", async () => {
  const write = (version: string): ChatCompletionStep => ({ toolCall: {
    id: `write-${version}`, name: "writeFile",
    arguments: { workpiece: "APP", filename: "server.js", content: server(version) },
  } });
  const run = (id: string): ChatCompletionStep => ({ toolCall: {
    id, name: "executeCode",
    arguments: { code: "export default async function(self, env) { return await env.APP.version(); }" },
  } });
  const model = models.script([
    toolCall("createGadget", { title: "App", bindingName: "APP" }),
    write("v1"), run("run-v1"), write("v2"), run("run-v2"),
    { text: "Done." },
  ]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID, userModel: model.userModel,
  });
  const { outcome, history } = await session.runTurn("Build an app and run it after each edit.");
  expect(outcome).toEqual({ status: "completed" });
  expect(history.flatMap(message => message.type === "message" ? message.toolCalls ?? [] : [])
      .flatMap(call => call.toolName === "executeCode" ? [call.output] : []))
      .toEqual([expect.stringContaining("v1"), expect.stringContaining("v2")]);
});
