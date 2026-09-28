import { afterAll, beforeAll, expect, it } from "vitest";
import { loadAllChatHistory } from "../src/agent-session.js";
import { startTestGatekeeperHarness, type Harness } from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, nextUsernames, signUp, stubFor, waitFor, waitForIdleChat, WorkpieceRecorder,
} from "../src/rpc-client.js";

let harness: Harness;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

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

const executeCode = (id: string, code: string): ChatCompletionStep => ({
  toolCall: { id, name: "executeCode", arguments: { code } },
});

it.concurrent("a worktree stays private to its chat; merge, revert and delete keep it consistent",
    async () => {
  const [username] = nextUsernames("worktree");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, username!);
  using ws = await api.newGadget();
  const workpieces = new WorkpieceRecorder();
  using workpiecesStub = stubFor(workpieces);
  using _workpieces = await ws.subscribeToWorkpieces(workpiecesStub);
  await workpieces.loaded;

  using seed = ws.createGadget("Seed", undefined, "SEED");
  const seedId = await seed.getId();
  const baseCommit = await waitFor("the seed gadget commit", async () => {
    const summary = workpieces.summaries.get(seedId);
    return summary?.type === "gadget" && summary.commitId !== undefined
      ? summary.commitId
      : null;
  });

  const model = models.script([
    { toolCall: { id: "create-worktree", name: "createWorktree", arguments: {
      title: "Notes", bindingName: "WORKTREE", commitId: baseCommit,
    } } },
    executeCode("write-worktree", `export default async function(self, env) {
  await env.WORKTREE.writeFile("note.txt", "one\\n");
  await env.WORKTREE.commit("first");
  await env.WORKTREE.writeFile("note.txt", "two\\n");
  await env.WORKTREE.commit("second");
  await env.WORKTREE.writeFile("note.txt", "three\\n");
}`),
    { text: "Done." },
    executeCode("inspect-worktree", `export default async function(self, env) {
  console.log(typeof env.WORKTREE);
}`),
    { text: "Done." },
    executeCode("continue-worktree", `export default async function(self, env) {
  await env.WORKTREE.writeFile("note.txt", "four\\n");
  await env.WORKTREE.commit("fourth");
  await env.WORKTREE.writeFile("note.txt", "five\\n");
  await env.WORKTREE.commit("fifth");
}`),
    { text: "Done." },
  ]);
  await api.addModel(model.userModel.profile, model.userModel.config);

  const chatA = await ws.newChat("Make a worktree.", SCRIPTED_MODEL_ID);
  await waitFor("three model requests", async () => model.requests.length === 3 ? true : null);
  await waitForIdleChat(ws, chatA);

  const firstHistory = await loadAllChatHistory(before => ws.getChatHistory(chatA, before));
  const creation = firstHistory.find(message =>
    message.type === "changes" && message.createdWorktrees?.length);
  const created = creation?.type === "changes" ? creation.createdWorktrees?.[0] : undefined;
  if (created === undefined) throw new Error("The agent did not create a worktree");
  const { worktreeId } = created;
  const committed = firstHistory.find(message =>
    message.type === "changes" && message.worktreeCommits?.length);
  if (committed?.type !== "changes" || committed.worktreeCommits?.length !== 2) {
    throw new Error("The agent did not record both initial worktree commits");
  }
  const first = committed.worktreeCommits[0]!;
  const second = committed.worktreeCommits[1]!;
  const summary = await waitFor("the worktree summary at its second commit", async () => {
    const entry = workpieces.summaries.get(worktreeId);
    return entry?.type === "worktree" && entry.headCommit === second.commit ? entry : null;
  });
  expect(summary).toMatchObject({ chatId: chatA, baseCommit, pinBase: baseCommit });
  expect((await ws.listChats()).find(chat => chat.id === chatA)?.proposedChangeWorkpieces)
      .toContain(worktreeId);
  expect(await ws.readFilesAtCommit(first.commit, ["note.txt"]))
      .toEqual([["note.txt", { kind: "text", text: "one\n" }]]);
  expect(await ws.readFilesAtCommit(second.commit, ["note.txt"]))
      .toEqual([["note.txt", { kind: "text", text: "two\n" }]]);

  const chatB = await ws.newChat("Look for a worktree.", SCRIPTED_MODEL_ID);
  await waitFor("five model requests", async () => model.requests.length === 5 ? true : null);
  await waitForIdleChat(ws, chatB);
  const secondHistory = await loadAllChatHistory(before => ws.getChatHistory(chatB, before));
  const inspection = secondHistory.flatMap(message =>
    message.type === "message" ? message.toolCalls ?? [] : [])
      .find(call => call.toolName === "executeCode");
  expect(inspection?.output).toContain("undefined");

  expect(await ws.mergeChanges(chatA)).toEqual({ outcome: "merged" });
  const merged = await waitFor("the worktree merge", async () => {
    const summary = workpieces.summaries.get(worktreeId);
    return summary?.type === "worktree" && summary.pinBase !== baseCommit ? summary : null;
  });
  expect(merged.headCommit).toBe(second.commit);
  expect(merged.pinBase).not.toBe(second.commit);
  expect(await ws.readFilesAtCommit(merged.pinBase, ["note.txt"]))
      .toEqual([["note.txt", { kind: "text", text: "three\n" }]]);
  expect((await ws.listChats()).find(chat => chat.id === chatA)?.proposedChangeWorkpieces ?? [])
      .toEqual([]);

  await ws.sendChatMessage(chatA, "Keep going.", SCRIPTED_MODEL_ID);
  await waitFor("seven model requests", async () => model.requests.length === 7 ? true : null);
  await waitForIdleChat(ws, chatA);
  await waitFor("a new worktree head", async () => {
    const summary = workpieces.summaries.get(worktreeId);
    return summary?.type === "worktree" && summary.headCommit !== second.commit ? true : null;
  });
  const finalHistory = await loadAllChatHistory(before => ws.getChatHistory(chatA, before));
  const laterCommits = finalHistory.find(message => message.type === "changes" &&
    message.worktreeCommits?.[0]?.previousHead === second.commit);
  if (laterCommits === undefined) throw new Error("The later worktree commits were not recorded");
  await ws.revertChanges(chatA, laterCommits.sequence);
  await waitFor("the reverted worktree head", async () => {
    const summary = workpieces.summaries.get(worktreeId);
    return summary?.type === "worktree" && summary.headCommit === second.commit ? true : null;
  });
  const reverted = workpieces.summaries.get(worktreeId);
  expect(reverted?.type === "worktree" ? reverted.pinBase : undefined).toBe(merged.pinBase);
  expect(await ws.readFilesAtCommit(merged.pinBase, ["note.txt"]))
      .toEqual([["note.txt", { kind: "text", text: "three\n" }]]);

  await ws.deleteChat(chatA);
  await waitFor("the deleted chat's worktree to disappear", async () =>
    workpieces.summaries.has(worktreeId) ? null : true);
  expect((await ws.listChats()).some(chat => chat.id === chatA)).toBe(false);
  expect(model.remainingSteps()).toBe(0);
});
