// A git push from an agent, end to end: queued through the fixture gatekeeper standing for a git
// remote, read through Overseer.getPushReview(), and applied with the pack the Overseer builds.
//
// In a workspace that holds restricted data (`containsRestrictedData`) the approver vouches for
// what they read, so a push is queued only when everything it will send reads as text, and then
// waits for a person whatever rules the workspace holds. Any other push is refused, and the agent
// is told which file to change. Outside such a workspace every push is queued, and the same
// review says what cannot be shown.
//
// The fixture's session gives the agent `seedRepository()` (the remote's one commit, which a
// push's ancestry ends on) and `push()`; its applyAction() reads back the pack it is handed, and
// `/control/pushed-objects` returns the objects that pack carried.

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  ActionLogEntry, AiChatMessage, Overseer, PushReviewEntry,
} from "@gadgets/workshop-shared/api";
import { openAgentSession, type WorkshopAgentSession } from "../src/agent-session.js";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, testControl, type Harness,
} from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { accountLabel, waitFor, withOwnerWorkspace } from "../src/rpc-client.js";

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

// ---------------------------------------------------------------------------
// The agent's code. Every turn is one executeCode call made of these lines, which share `base`
// (the remote's commit), `tree` (a worktree on it) and `commits` (what the agent committed).

const TOOL_CALL_ID = "push-code";

const agentCode = (...lines: string[]): ChatCompletionStep => ({
  toolCall: { id: TOOL_CALL_ID, name: "executeCode", arguments: {
    code: `export default async function(self, env) {\n  const commits = [];\n${
      lines.map(line => `  ${line}\n`).join("")}}`,
  } },
});

const LATCH = "await env.TEST_AMBIENT.readValue(true);";
const SEED = "const base = await env.TEST_AMBIENT.seedRepository();" +
    " const tree = await env.GIT.newWorktree(base);";
const PUSH = "await env.TEST_AMBIENT.push(commits.at(-1));";
const TRY_PUSH = `try { ${PUSH} } catch (error) { console.log("REFUSED:" + error.message); }`;
const REPORT = `console.log("COMMITS:" + JSON.stringify({ base, commits }));`;

const commitText = (path: string, text: string, message: string) =>
  `await tree.writeFile(${JSON.stringify(path)}, ${JSON.stringify(text)});` +
  ` commits.push(await tree.commit(${JSON.stringify(message)}));`;

const GUIDE = { path: "docs/guide.md", text: "# Guide\n\nStart here.\n", message: "Add the guide" };
const REFERENCE = {
  path: "docs/api/reference.md", text: "# Reference\n\nEvery call.\n", message: "Add the reference",
};
const TEXT_COMMITS = [GUIDE, REFERENCE].map(file => commitText(file.path, file.text, file.message));
// Two commits, the directories from the root down to each file, and the two files.
const TEXT_PUSH_OBJECTS = 9;

// A file that is not text: a readable marker, so a leak of its content would show, then a NUL.
const BINARY_PATH = "assets/logo.bin";
const BINARY_MARKER = "logo-bytes-marker";
const COMMIT_BINARY =
    `await tree.writeBytes(${JSON.stringify(BINARY_PATH)}, new Uint8Array(${
      JSON.stringify([...new TextEncoder().encode(BINARY_MARKER), 0, 255])}));` +
    ` commits.push(await tree.commit("Add the logo"));`;

/** Two text files in two commits, pushed; `restricted` reads restricted data first. */
const textPush = (restricted: boolean): ChatCompletionStep[] => [
  agentCode(...(restricted ? [LATCH] : []), SEED, ...TEXT_COMMITS, REPORT, PUSH),
  { text: "Pushed." },
];

// ---------------------------------------------------------------------------

const openSession = (model: RoutedScriptedModel, usernamePrefix: string) =>
  openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: model.userModel,
    ambientVendorIds: [TEST_VENDOR_ID],
    usernamePrefix,
  });

const asOwner = <T>(session: WorkshopAgentSession, fn: (ws: RpcStub<Overseer>) => Promise<T>) =>
  withOwnerWorkspace(harness.url, session.username, fn);

/** The objects the fixture received when the session's last applied push was sent. */
const pushedObjects = async (session: WorkshopAgentSession) =>
  (await testControl<{ oids: string[] | null }>(harness, "pushed-objects", {
    label: accountLabel(session.connectedAccount(TEST_VENDOR_ID)),
  })).oids;

type Push = ActionLogEntry & { type: "action" };

async function pendingPushes(ws: RpcStub<Overseer>): Promise<Push[]> {
  const { entries } = await ws.listActions({ filter: "pending" });
  return entries.filter((entry): entry is Push =>
    entry.type === "action" && (entry.description.pushedCommits?.length ?? 0) > 0);
}

async function onlyPendingPush(ws: RpcStub<Overseer>): Promise<Push> {
  const pushes = await pendingPushes(ws);
  expect(pushes).toHaveLength(1);
  return pushes[0]!;
}

const PUSH_KIND = { tag: "test.push", label: "Pushes" };

/** Lets a rule approve the fixture's pushes, as "Always approve" does on a held push. */
const allowPushes = (ws: RpcStub<Overseer>, push: Push) =>
  ws.setAutoApprovedActionKind(push.gatekeeperId!, PUSH_KIND);

// A rule applies after its RPC returns (ctx.waitUntil), so "the rule did not apply" needs a
// settle window: one further round trip plus a beat, far beyond the drain's storage work.
async function settle(ws: RpcStub<Overseer>): Promise<void> {
  await ws.listActions();
  await new Promise(resolve => setTimeout(resolve, 300));
}

/** Every page of a push's review. */
async function wholeReview(ws: RpcStub<Overseer>, actionId: number) {
  let page = await ws.getPushReview(actionId);
  const { objectCount, stackedOn } = page;
  const entries = [...page.entries];
  while (page.next !== undefined) {
    page = await ws.getPushReview(actionId, page.next);
    entries.push(...page.entries);
  }
  return { entries, objectCount, stackedOn };
}

/** A review in brief: each commit, and under it each path with what the push sends there. */
const outline = (entries: PushReviewEntry[]) => entries.map(entry =>
  entry.kind === "path" ? [entry.commit, entry.path, entry.sent?.kind] : [entry.kind, entry.oid]);

/** The objects a review says the push sends: its commits, and the entry of each sent path. */
const reviewedObjects = (entries: PushReviewEntry[]) => entries.flatMap(entry =>
  entry.kind === "commit" ? [entry.oid]
    : entry.kind === "path" && entry.sent && entry.entry ? [entry.entry.oid]
    : []);

/** What the agent's executeCode calls returned to it, output and error alike. */
const toolResults = (history: AiChatMessage[]) => history
    .flatMap(message => message.type === "message" ? message.toolCalls ?? [] : [])
    .flatMap(call => call.toolName === "executeCode" ? [`${call.output ?? ""}\n${call.error ?? ""}`] : []);

/** What REPORT logged: the remote's commit and the agent's own, oldest first. */
function reportedCommits(history: AiChatMessage[]): { base: string; commits: string[] } {
  const match = /COMMITS:(\{.*?\})/.exec(toolResults(history).join("\n"));
  if (!match) throw new Error("The agent's code did not report its commits");
  return JSON.parse(match[1]!) as { base: string; commits: string[] };
}

it.concurrent("an agent's push from a restricted workspace waits, shows what it sends, and " +
    "applies when approved", async () => {
  const model = models.script(textPush(true));
  await using session = await openSession(model, "pushreview");

  const turn = await session.runTurn("Add the docs and push them.");
  expect(turn.outcome).toEqual({ status: "completed" });
  const { base, commits: [first, head] } = reportedCommits(turn.history);

  await asOwner(session, async ws => {
    expect((await ws.getMetadata()).containsRestrictedData).toBe(true);
    const push = await onlyPendingPush(ws);
    expect(push.description.pushedCommits).toEqual([head]);

    // The push's kind is one a rule may approve, and the rule is on: it still waits for a person.
    await allowPushes(ws, push);
    await settle(ws);
    expect((await pendingPushes(ws)).map(entry => entry.id)).toEqual([push.id]);
    expect(await pushedObjects(session)).toBeNull();

    // A push this small is one page: the first call returns all of it.
    const review = await ws.getPushReview(push.id);
    expect(review.next).toBeUndefined();
    expect(outline(review.entries)).toEqual([
      ["commit", first],
      [first, "", "dir"], [first, "docs", "dir"], [first, GUIDE.path, "text"],
      ["commit", head],
      [head, "", "dir"], [head, "docs", "dir"], [head, "docs/api", "dir"], [head, REFERENCE.path, "text"],
    ]);
    expect(review.stackedOn).toEqual([]);
    expect(review.objectCount).toBe(TEXT_PUSH_OBJECTS);
    const [firstCommit, headCommit] = review.entries.filter(entry => entry.kind === "commit");
    expect(firstCommit).toMatchObject({ parents: [base], text: expect.stringContaining(GUIDE.message) });
    expect(headCommit).toMatchObject({ parents: [first], text: expect.stringContaining(REFERENCE.message) });
    for (const commit of [firstCommit, headCommit]) {
      expect(commit!.text).toMatch(/^author .+ <.*> \d+ [+-]\d{4}$/m);
    }

    expect(await ws.readFilesAtCommit(first!, [GUIDE.path]))
        .toEqual([[GUIDE.path, { kind: "text", text: GUIDE.text }]]);
    expect(await ws.readFilesAtCommit(head!, [REFERENCE.path]))
        .toEqual([[REFERENCE.path, { kind: "text", text: REFERENCE.text }]]);

    // What was sent is what the review named, object for object: no row is left to infer.
    await ws.approveAction(push.id);
    const reviewed = [...new Set(reviewedObjects(review.entries))];
    expect(reviewed).toHaveLength(review.objectCount);
    expect((await pushedObjects(session))?.toSorted()).toEqual(reviewed.toSorted());

    await expect(ws.getPushReview(push.id)).rejects.toThrow(`Action ${push.id} is not a pending push.`);
    expect(await pendingPushes(ws)).toEqual([]);
  });
  expect(model.remainingSteps()).toBe(0);
});

it.concurrent("a restricted push with a binary file is refused and the agent is told why", async () => {
  const model = models.script([agentCode(LATCH, SEED, COMMIT_BINARY, PUSH), { text: "It was refused." }]);
  await using session = await openSession(model, "pushbinary");

  const { history } = await session.runTurn("Add the logo and push it.");

  // The refusal names the rule and the file, and carries none of the file.
  const [result] = toolResults(history);
  expect(result).toContain("is not UTF-8 text");
  expect(result).toContain(JSON.stringify(BINARY_PATH));
  expect(result).not.toContain(BINARY_MARKER);
  expect(model.requests[1]).toMatchObject({ messages: expect.arrayContaining([
    expect.objectContaining({ role: "tool", tool_call_id: TOOL_CALL_ID,
      content: expect.stringContaining("is not UTF-8 text") }),
  ]) });

  await asOwner(session, async ws => {
    expect((await ws.getMetadata()).containsRestrictedData).toBe(true);
    // The refusal queued nothing: no action is pending, and the log holds none in any state.
    expect((await ws.listActions({ filter: "pending" })).entries).toEqual([]);
    expect((await ws.listActions({ filter: "action" })).entries).toEqual([]);
  });
  expect(await pushedObjects(session)).toBeNull();
  expect(model.remainingSteps()).toBe(0);
});

it.concurrent("the same binary push from an unrestricted workspace is queued", async () => {
  const model = models.script([agentCode(SEED, COMMIT_BINARY, REPORT, PUSH), { text: "Pushed." }]);
  await using session = await openSession(model, "pushunrestricted");

  const { history } = await session.runTurn("Add the logo and push it.");
  const { commits: [head] } = reportedCommits(history);

  await asOwner(session, async ws => {
    expect((await ws.getMetadata()).containsRestrictedData).toBeFalsy();
    const push = await onlyPendingPush(ws);
    const review = await wholeReview(ws, push.id);
    expect(outline(review.entries)).toEqual([
      ["commit", head], [head, "", "dir"], [head, "assets", "dir"], [head, BINARY_PATH, "binary"],
    ]);
  });
  expect(model.remainingSteps()).toBe(0);
});

it.concurrent("getPushReview refuses what is not a pending push", async () => {
  // The write holds its turn until it is decided, so the script's last step is never asked for.
  const model = models.script([agentCode("await env.TEST_AMBIENT.writeValue(7);"), { text: "Unreached." }]);
  await using session = await openSession(model, "pushnotapush");

  await session.runTurn("Set the test value to 7.");
  await asOwner(session, async ws => {
    const { entries: [write] } = await ws.listActions({ filter: "pending" });
    expect(write).toMatchObject({ type: "action", description: { title: "Set the test value to 7" } });
    await expect(ws.getPushReview(write!.id)).rejects.toThrow(`Action ${write!.id} is not a pending push.`);
    const unknown = write!.id + 1000;
    await expect(ws.getPushReview(unknown)).rejects.toThrow(`Action ${unknown} is not a pending push.`);
    await ws.rejectAction(write!.id);
  });
  expect(model.remainingSteps()).toBe(1);
});

it.concurrent("a waiting push whose connection is removed is refused a review, rather than read as " +
    "one that sends nothing", async () => {
  const model = models.script(textPush(false));
  await using session = await openSession(model, "pushremoved");

  await session.runTurn("Add the docs and push them.");
  await asOwner(session, async ws => {
    const push = await onlyPendingPush(ws);
    expect((await wholeReview(ws, push.id)).objectCount).toBe(TEXT_PUSH_OBJECTS);

    using connection = ws.getGatekeeperById(push.gatekeeperId!);
    await connection.remove();
    // The record stays pending, and nothing is marked for it any more.
    expect((await onlyPendingPush(ws)).id).toBe(push.id);
    await expect(ws.getPushReview(push.id)).rejects.toThrow(
      `Action ${push.id} can never be applied: the connection it was submitted through has been ` +
      "removed from this workspace.");
  });
  expect(model.remainingSteps()).toBe(0);
});

it.concurrent("a push that was waiting when the workspace became restricted can still be reviewed, " +
    "and a push on top of it is refused", async () => {
  const model = models.script([
    agentCode(SEED, COMMIT_BINARY, PUSH, LATCH, commitText(GUIDE.path, GUIDE.text, GUIDE.message), TRY_PUSH,
        REPORT),
    { text: "The second push was refused." },
  ]);
  await using session = await openSession(model, "pushlatchedlater");

  const { history } = await session.runTurn("Push the logo, read the value, then push the guide.");
  const { commits: [first] } = reportedCommits(history);

  // The second push would send the first one's file too, which nobody can read as text.
  const [result] = toolResults(history);
  expect(result).toContain("REFUSED:");
  expect(result).toContain("is not UTF-8 text");
  expect(result).toContain(JSON.stringify(BINARY_PATH));
  expect(result).not.toContain(BINARY_MARKER);

  await asOwner(session, async ws => {
    expect((await ws.getMetadata()).containsRestrictedData).toBe(true);
    const push = await onlyPendingPush(ws);
    expect(push.description.pushedCommits).toEqual([first]);
    const review = await wholeReview(ws, push.id);
    expect(outline(review.entries)).toEqual([
      ["commit", first], [first, "", "dir"], [first, "assets", "dir"], [first, BINARY_PATH, "binary"],
    ]);
    // The first push is as it was queued: its own four objects, stacked on nothing.
    expect(review).toMatchObject({ objectCount: 4, stackedOn: [] });
    // The refused push is no record in any state: the log's only action is the first push.
    expect((await ws.listActions({ filter: "action" })).entries.map(entry => entry.id)).toEqual([push.id]);
  });
  expect(model.remainingSteps()).toBe(0);
});

it.concurrent("a rule applies the same push when the workspace is not restricted", async () => {
  const model = models.script(textPush(false));
  await using session = await openSession(model, "pushbyrule");

  const turn = await session.runTurn("Add the docs and push them.");
  expect(turn.outcome).toEqual({ status: "completed" });
  const { commits: [, head] } = reportedCommits(turn.history);

  await asOwner(session, async ws => {
    expect((await ws.getMetadata()).containsRestrictedData).toBeFalsy();
    const push = await onlyPendingPush(ws);
    expect(push.description.pushedCommits).toEqual([head]);

    await allowPushes(ws, push);
    const applied = await waitFor("the rule to apply the push", async () => {
      const { entries } = await ws.listActions({ filter: "action" });
      const entry = entries.find(candidate => candidate.id === push.id);
      return entry?.type === "action" && entry.state === "approved" ? entry : null;
    });
    expect(applied.autoApproved).toBe(true);
    expect(await pendingPushes(ws)).toEqual([]);

    const sent = await pushedObjects(session);
    expect(sent).toHaveLength(TEXT_PUSH_OBJECTS);
    expect(sent).toContain(head);
  });
  expect(model.remainingSteps()).toBe(0);
});
