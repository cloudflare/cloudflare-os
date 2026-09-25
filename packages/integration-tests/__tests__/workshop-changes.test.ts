import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMetadata, AiChatStreamEvent, AiChatSubscriber, AuthenticatedApi, Overseer, PublicApi, WorkpieceId,
  WorkpieceSummary, WorkpiecesSubscriber,
} from "@gadgets/workshop-shared/api";
import {
  applyCodeChange, diffFiles, type CodeChange, type CodeContent,
} from "@gadgets/workshop-shared/code-change";
import { loadAllChatHistory, openAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import {
  scriptedModelRouter, SCRIPTED_MODEL_ID, type ChatCompletionStep, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, RpcTarget, signUp, stubFor, waitFor } from "../src/rpc-client.js";

class WorkpieceRecorder extends RpcTarget implements WorkpiecesSubscriber {
  readonly summaries = new Map<WorkpieceId, WorkpieceSummary>();
  readonly #loaded = Promise.withResolvers<void>();
  readonly loaded = this.#loaded.promise;
  entry(summary: WorkpieceSummary): void { this.summaries.set(summary.id, summary); }
  removed(id: WorkpieceId): void { this.summaries.delete(id); }
  ready(): void { this.#loaded.resolve(); }
}

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
    fn: (client: Client) => Promise<T>): Promise<T> {
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
  return await fn({ ws, workpieces, chats });
}

function withOwner<T>(fn: (client: Client) => Promise<T>, model?: RoutedScriptedModel): Promise<T> {
  return withClient(api => signUp(api, nextUsernames("owner")[0]!), async api => {
    if (model !== undefined) await api.addModel(model.userModel.profile, model.userModel.config);
    return api.newGadget();
  }, fn);
}

/** Reopen the sole workspace of an agent session's account over a fresh connection. */
function reopen<T>(username: string, fn: (client: Client) => Promise<T>): Promise<T> {
  return withClient(api => logIn(api, username), async api => {
    const [workspace] = await waitFor("the session's workspace", async () => {
      const workspaces = await api.listGadgets();
      return workspaces.length > 0 ? workspaces : null;
    });
    return api.openGadget(workspace.id);
  }, fn);
}

const toolCall = (name: string, args: Record<string, unknown>): ChatCompletionStep =>
  ({ toolCall: { id: `call-${name}`, name, arguments: args } });

const files = (gadgetId: number, path: string, text?: string): CodeContent =>
  new Map([[gadgetId, new Map(text === undefined ? [] : [[path, text]])]]);

const edit = (gadgetId: number, path: string, before: string | undefined, after: string) =>
  diffFiles(files(gadgetId, path, before), files(gadgetId, path, after));

const textAfter = (changes: AppliedChange[], gadgetId: number, path: string, base: string) =>
  changes.reduce((content, { change }) => applyCodeChange(content, change), files(gadgetId, path, base))
    .get(gadgetId)?.get(path);

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

const MARKERS = "line1\n<<<<<<< mainline\nOURS\n||||||| merged base\nline2\n=======\nTHEIRS\n" +
    ">>>>>>> this chat\nline3\n";

it.concurrent.for([
  {
    lines: "different", base: "a\nb\nc\nd\ne\n", ours: "A\nb\nc\nd\ne\n", theirs: "a\nb\nc\nd\nE\n",
    conflictPaths: [], draft: "A\nb\nc\nd\nE\n", resolved: undefined,
  },
  {
    lines: "the same", base: "line1\nline2\nline3\n", ours: "line1\nOURS\nline3\n",
    theirs: "line1\nTHEIRS\nline3\n", conflictPaths: ["APP/app.txt"], draft: MARKERS,
    resolved: "line1\nOURS + THEIRS\nline3\n",
  },
])("a stale chat edited on $lines lines pulls in mainline and merges", async row => {
  await withOwner(async client => {
    const { ws, workpieces, chats } = client;
    const { gadgetId, head } = await seedGadget(client, "app.txt", row.base);
    const chatA = await ws.newChat("A", null);
    const chatB = await ws.newChat("B", null);
    const pins = [{ gadgetId, baseCommit: head }];
    await ws.submitCodeChange(chatA, {
      generation: 0, revision: 0, clientId: "a", seq: 1, pins,
      change: edit(gadgetId, "app.txt", row.base, row.ours),
    });
    await ws.submitCodeChange(chatB, {
      generation: 0, revision: 0, clientId: "b", seq: 1, pins,
      change: edit(gadgetId, "app.txt", row.base, row.theirs),
    });

    expect(await ws.mergeChanges(chatA)).toEqual({ outcome: "merged" });
    const mainline = await headOf(workpieces, gadgetId, head);
    expect(await ws.mergeChanges(chatB)).toEqual({ outcome: "stale" });
    expect((await ws.listChats()).find(chat => chat.id === chatB)?.codeBase?.generation).toBe(0);
    expect(workpieces.summaries.get(gadgetId)).toMatchObject({ commitId: mainline });
    await expectText(ws, mainline, "app.txt", row.ours);

    expect(await ws.updateChatFromMainline(chatB)).toEqual({ conflictPaths: row.conflictPaths });
    const changes = await changesOf(chats, chatB, 2);
    expect(textAfter(changes, gadgetId, "app.txt", row.base)).toBe(row.draft);

    if (row.resolved !== undefined) {
      const update = (await changesMessages(ws, chatB)).find(message => message.mainlineMerge);
      await expect(ws.revertChanges(chatB, update!.sequence))
          .rejects.toThrow("Cannot revert changes that include an update from mainline");
      const { generation, revision } = changes.at(-1)!;
      await ws.submitCodeChange(chatB, {
        generation, revision, clientId: "b", seq: 2,
        change: edit(gadgetId, "app.txt", row.draft, row.resolved),
      });
    }
    expect(await ws.mergeChanges(chatB)).toEqual({ outcome: "merged" });
    await expectText(ws, await headOf(workpieces, gadgetId, mainline), "app.txt",
        row.resolved ?? row.draft);
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
