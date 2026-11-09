// The Overseer as the one writer of its workspace's console log history: what a gadget's server
// logs and the exceptions it does not catch are kept in the workspace's log object and listed back
// (OverseerImpl.deliverGadgetLogs(), #recordGadgetException() and listConsoleLogs()), live
// subscribers get each event whole, under the chat it was delivered with, and deleting the
// workspace deletes the log object before the workspace's own storage. What a session reports of
// a gadget's UI is kept there too (reportGadgetConsoleLogs()): the session checks the gadget and
// the chat, and the Overseer applies the per-call cap and the gadget's limit. Those cases open the
// real OverseerClientInterface as the workspace's owner. A use session's reports are in
// use-gadget-access.test.ts.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding) keeping entries in the real
// log object it reaches through ctx.exports, read back through the TEST_WORKSPACE_LOG binding.
// Gadgets are real facets loaded from real commits. User DOs are fakes, and so is the log
// namespace where a test makes it fail.

import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH, MAX_GADGET_CONSOLE_LOGS_PER_CALL,
  type AiChatAuthorInfo, type CodeChangeSubmission, type ConsoleLogEvent,
  type GadgetConsoleLogEntry, type GadgetConsoleLogQuery, type Overseer,
  type ReportedGadgetConsoleLog,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { GADGET_CONSOLE_LOGS_PER_MINUTE } from "../src/gadget-console-log.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { WorkspaceLogDurableObject } from "../src/workspace-log.js";
import { openFakeOverseer } from "./fixtures.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_WORKSPACE_LOG: DurableObjectNamespace<WorkspaceLogDurableObject>;
  }
}

const OWNER_USER_ID = "owner-user-do";
const CREATED = new Date(1700000000_000);
const USER: AiChatAuthorInfo = { type: "user", id: "alice@example.com", name: "Alice" };
const GADGET_ID = 1;
// A string a kept entry carries, to look for in what the logger was passed.
const MARKER = "marker-7f3a";

type Workspace = {
  impl: any;
  instance: OverseerDurableObject;
  state: DurableObjectState;
  owner: AiChatAuthorInfo;
};

// A fake owner user DO: their profile, their record of the workspace, and what open(),
// deleteSelf(), the deletion's drain and a chat's fan-out call on it.
function fakeUsers(ws: Pick<Workspace, "owner" | "state">) {
  let user = {
    id: { toString: () => OWNER_USER_ID },
    whoami: async () => ws.owner,
    getWorkspace: async () => ({
      id: ws.state.id.toString(), title: "Untitled Workspace", created: CREATED,
      lastActive: CREATED,
    }),
    workspaceRemoved: async () => {},
    messageArrived: async () => {},
    syncWorkspaceOutputs: async () => {},
    setWorkspaceLastActive: async () => {},
  };
  return { idFromString: (id: string) => id, get: () => user };
}

async function withWorkspace(fn: (ws: Workspace) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`gadget-console-history-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject, state) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let ws: Workspace = {
      impl, instance, state,
      owner: { type: "user", id: `owner-${crypto.randomUUID()}@example.test`, name: "Owner" },
    };
    impl.users = fakeUsers(ws);
    impl.scheduleAccessRestart = async () => {};
    await fn(ws);
  });
}

// Makes the workspace an initialised one owned by ws.owner: what the owner's first open does, and
// an external message's first post to a workspace named by key.
function initialise(ws: Workspace): void {
  ws.impl.ownerId = OWNER_USER_ID;
  ws.impl.ownerProfileId = ws.owner.id;
  ws.impl.storage.ownerId.put(OWNER_USER_ID);
}

// A gadget's server: methods that log and throw, and an export handler that logs.
function serverJs(prefix = ""): string {
  return `
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export class Gadget extends DurableObject {
  greet(name) {
    console.log("${prefix}hello", name);
    return name;
  }

  fail() {
    throw new Error("${prefix}boom");
  }

  leak() {
    throw new Error("GET https://api.example/v1?access_token=abc123 failed");
  }
}

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(gadget) {
    console.log("formats asked");
    return [{
      id: "txt", label: "Text", mode: "server", contentType: "text/plain", fileExtension: ".txt",
    }];
  }

  async export(gadget, id) {
    return new Response("x").body;
  }
}
`;
}

// Commits serverJs() and makes it gadget GADGET_ID's mainline. Returns the commit.
async function addGadget(ws: Workspace): Promise<string> {
  let commitId = await ws.impl.gitCache.writeFilesAsCommit(new Map([["server.js", serverJs()]]), {
    parents: [],
    author: { name: "Alice", email: "alice@example.com" },
    message: "test commit",
    timestamp: CREATED,
  });
  ws.impl.storage.gadgets.put({
    type: "gadget", id: GADGET_ID, title: "G", created: new Date(0), bindingName: "G",
    bindings: {}, commitId,
  });
  return commitId;
}

// A chat with no draft. (Chats are indexed by when they were last active, so each has its own.)
function addChat(ws: Workspace, id: number): void {
  ws.impl.storage.chatMeta.put(
      { id, title: "Chat", started: new Date(0), lastActive: new Date(id) });
}

// Gives chat `chatId` a materialized draft of the gadget, whose server says "draft " before what
// the mainline's says, so that the chat pins the gadget and its facet runs the draft.
async function addDraft(ws: Workspace, chatId: number, baseCommit: string): Promise<void> {
  addChat(ws, chatId);
  let content = (source: string): CodeContent =>
      new Map([[GADGET_ID, new Map([["server.js", source]])]]);
  let submission: CodeChangeSubmission = {
    generation: 0, revision: 0, clientId: "cli", seq: 1,
    pins: [{ gadgetId: GADGET_ID, baseCommit }],
    change: diffFiles(content(serverJs()), content(serverJs("draft "))),
  };
  await ws.impl.submitCodeChange(chatId, submission, USER, "alice-user-do");
  ws.impl.materializeChatChanges(chatId);
}

function logEvent(level: ConsoleLogEvent["level"], ...message: unknown[]): ConsoleLogEvent {
  return { timestamp: new Date(), level, message };
}

type LiveEvent = { chatId: number | null; logs: ConsoleLogEvent[] };

// Subscribes to the live logs through the impl, and returns what the subscriber is told.
async function subscribe(ws: Workspace): Promise<LiveEvent[]> {
  let events: LiveEvent[] = [];
  let subscriber: any = {
    dup: () => subscriber,
    onRpcBroken: () => {},
    event: async (chatId: number | null, logs: ConsoleLogEvent[]) => {
      events.push({ chatId, logs });
    },
    [Symbol.dispose]: () => {},
  };
  await ws.impl.subscribeToConsoleLogs(subscriber);
  return events;
}

function consoleLogId(ws: Workspace): string | undefined {
  return ws.impl.storage.consoleLogId.get();
}

// The keys of everything the workspace stores: none once its deletion has run to its end.
function storageKeys(ws: Workspace): string[] {
  return [...ws.state.storage.kv.list()].map(([key]) => key);
}

// Every entry the log object named `name` lists for `query`, newest first, read from the object
// itself and not through the Overseer.
async function keptIn(name: string, query: GadgetConsoleLogQuery = {})
    : Promise<GadgetConsoleLogEntry[]> {
  let entries: GadgetConsoleLogEntry[] = [];
  let cursor: string | undefined;
  do {
    let page = await env.TEST_WORKSPACE_LOG.getByName(name).list({
      ...query, ...(cursor !== undefined && { cursor }),
    });
    entries.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return entries;
}

// The same for the workspace's own log object; nothing while the workspace has named none.
async function kept(ws: Workspace, query: GadgetConsoleLogQuery = {})
    : Promise<GadgetConsoleLogEntry[]> {
  let name = consoleLogId(ws);
  return name === undefined ? [] : keptIn(name, query);
}

// Whether the log object named `name` holds its schema. (In local workerd an object also holds a
// table of the harness, so the schema's own table is what is looked for.)
function hasLogTable(name: string): Promise<boolean> {
  return runInDurableObject(env.TEST_WORKSPACE_LOG.getByName(name), (_log, state) =>
      state.storage.sql.exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'console_logs'")
          .toArray().length > 0);
}

function logAlarm(name: string): Promise<number | null> {
  return runInDurableObject(env.TEST_WORKSPACE_LOG.getByName(name), (_log, state) =>
      state.storage.getAlarm());
}

function texts(page: { entries: GadgetConsoleLogEntry[] }): string[] {
  return page.entries.map(entry => entry.text);
}

// A log namespace that no test path may reach: a lookup is counted, and fails.
function unreachableLogs() {
  return {
    getByName: vi.fn((): never => { throw new Error("no log object should be asked"); }),
  };
}

// A log object namespace whose every append() rejects with `error`.
function failingLogs(error: Error) {
  return { getByName: () => ({ append: async (): Promise<never> => { throw error; } }) };
}

// What a report that could not be kept is refused with, whatever the log object failed with.
const REPORT_REFUSED = "Gadget console logs could not be recorded.";

// The warnings written with `event`, as [message, fields] pairs.
function warnings(warn: { mock: { calls: unknown[][] } }, event: string): unknown[][] {
  return warn.mock.calls.filter(([, fields]) => (fields as { event?: string })?.event === event);
}

// Everything the logger was passed, as one string: the caught errors with their messages.
function logged(warn: { mock: { calls: unknown[][] } }): string {
  return JSON.stringify(warn.mock.calls, (_key, value) =>
      value instanceof Error ? `${value.name}: ${value.message}` : value);
}

describe("a gadget's server console output", () => {
  it("is kept as server entries under the chat given, and reaches live subscribers whole",
      () => withWorkspace(async ws => {
    initialise(ws);
    let events = await subscribe(ws);
    let long = "word ".repeat(700);
    let logs: ConsoleLogEvent[] = [
      { timestamp: new Date(1700000001_000), level: "log", message: ["hello", { n: 1 }] },
      { timestamp: new Date(1700000002_000), level: "warn",
        message: ["key sk-live0123456789abcdefghij"] },
      { timestamp: new Date(1700000003_000), level: "info", message: [long] },
    ];
    await ws.impl.deliverGadgetLogs(7, logs, GADGET_ID);
    await ws.impl.deliverGadgetLogs(null, [logs[0]], GADGET_ID);

    // The subscriber gets the events whole: only what is kept is redacted and cut.
    expect(events).toStrictEqual([{ chatId: 7, logs }, { chatId: null, logs: [logs[0]] }]);

    let entries = await kept(ws);
    expect(entries).toStrictEqual([
      { time: logs[0].timestamp, gadgetId: GADGET_ID, chatId: null, source: "server",
        level: "log", text: 'hello {"n":1}' },
      { time: logs[2].timestamp, gadgetId: GADGET_ID, chatId: 7, source: "server",
        level: "info", text: `${long.slice(0, MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH - 1)}…` },
      { time: logs[1].timestamp, gadgetId: GADGET_ID, chatId: 7, source: "server",
        level: "warn", text: "key [redacted]" },
      { time: logs[0].timestamp, gadgetId: GADGET_ID, chatId: 7, source: "server",
        level: "log", text: 'hello {"n":1}' },
    ]);
    for (let entry of entries) expect(entry).not.toHaveProperty("userId");
  }));

  it("passes no rate limit: a batch of 700 is kept whole", () => withWorkspace(async ws => {
    initialise(ws);
    let events = await subscribe(ws);
    let logs = Array.from({ length: 700 }, (_, i) => logEvent("log", "line", i));
    await ws.impl.deliverGadgetLogs(null, logs, GADGET_ID);

    let entries = await kept(ws);
    expect(entries).toHaveLength(700);
    expect(entries[0].text).toBe("line 699");
    expect(entries.at(-1)!.text).toBe("line 0");
    expect(entries.filter(entry => entry.level === "warn")).toStrictEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0].logs).toHaveLength(700);
  }));

  it("names the log object with the first kept entry, and each workspace names its own",
      async () => {
    let names: string[] = [];
    for (let i = 0; i < 2; i++) {
      await withWorkspace(async ws => {
        initialise(ws);
        expect(consoleLogId(ws)).toBeUndefined();
        await ws.impl.deliverGadgetLogs(null, [logEvent("log", "first")], GADGET_ID);
        let name = consoleLogId(ws)!;
        expect(name).toMatch(/^[0-9a-f-]{36}$/);
        expect(name).not.toBe(ws.state.id.toString());

        await ws.impl.deliverGadgetLogs(null, [logEvent("log", "second")], GADGET_ID);
        expect(consoleLogId(ws)).toBe(name);
        expect(texts({ entries: await keptIn(name) })).toStrictEqual(["second", "first"]);
        names.push(name);
      });
    }
    expect(names[0]).not.toBe(names[1]);
  });

  it("keeps nothing in a workspace that is uninitialised or being deleted, and asks no log object",
      () => withWorkspace(async ws => {
    let warn = vi.spyOn(ws.impl.logger, "warn");
    let real = ws.impl.workspaceLogs;
    let logs = unreachableLogs();

    ws.impl.workspaceLogs = logs;
    await ws.impl.deliverGadgetLogs(null, [logEvent("log", "too early")], GADGET_ID);
    expect(consoleLogId(ws)).toBeUndefined();

    ws.impl.workspaceLogs = real;
    initialise(ws);
    await ws.impl.deliverGadgetLogs(null, [logEvent("log", "kept")], GADGET_ID);
    let name = consoleLogId(ws)!;

    ws.impl.beginDeletion(new Set());
    ws.impl.workspaceLogs = logs;
    await ws.impl.deliverGadgetLogs(null, [logEvent("log", "too late")], GADGET_ID);
    expect(logs.getByName).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(texts({ entries: await keptIn(name) })).toStrictEqual(["kept"]);

    // The deletion runs to its end, so that the workspace leaves no alarm retrying it.
    ws.impl.workspaceLogs = real;
    await ws.impl.deliverUserUpdates();
    expect(storageKeys(ws)).toStrictEqual([]);
  }));

  it("delivers a batch that names no gadget live, under its chat, and keeps nothing of it",
      () => withWorkspace(async ws => {
    initialise(ws);
    let events = await subscribe(ws);
    let event = logEvent("log", "from a tail of another version");

    // What a tail running a version of the Worker that passes no gadget id calls.
    await ws.instance.deliverGadgetLogs(null, [event]);
    await ws.instance.deliverGadgetLogs(7, [event]);

    expect(events).toStrictEqual([{ chatId: null, logs: [event] }, { chatId: 7, logs: [event] }]);
    expect(consoleLogId(ws)).toBeUndefined();
  }));

  it("keeps nothing of a trace that logged before the workspace was initialised, and delivers it",
      () => withWorkspace(async ws => {
    initialise(ws);
    let created = new Date(1700000100_000);
    ws.impl.storage.createdAt.put(created);
    let events = await subscribe(ws);
    let at = (ms: number, text: string): ConsoleLogEvent =>
        ({ timestamp: new Date(created.getTime() + ms), level: "log", message: [text] });

    // A request of an earlier workspace under this id, and one that was still logging when the
    // id was initialised again: nothing of either is kept, and no log object is named.
    let before = [at(-60_000, "a minute before")];
    let straddling = [at(-1, "just before"), at(0, "at"), at(1, "after")];
    await ws.impl.deliverGadgetLogs(null, before, GADGET_ID);
    await ws.impl.deliverGadgetLogs(null, straddling, GADGET_ID);
    expect(consoleLogId(ws)).toBeUndefined();

    // A request that logged from the initialisation on is this workspace's.
    let own = [at(0, "at"), at(1, "after")];
    await ws.impl.deliverGadgetLogs(null, own, GADGET_ID);
    expect(texts(await ws.impl.listConsoleLogs())).toStrictEqual(["after", "at"]);

    expect(events.map(event => event.logs)).toStrictEqual([before, straddling, own]);
  }));

  it("keeps nothing of a batch with no logs: no log object is named, and none is asked",
      () => withWorkspace(async ws => {
    initialise(ws);
    let events = await subscribe(ws);
    let warn = vi.spyOn(ws.impl.logger, "warn");
    let logs = unreachableLogs();
    ws.impl.workspaceLogs = logs;

    // What the tail delivers for a gadget call that logged nothing: one batch per trace.
    await ws.impl.deliverGadgetLogs(null, [], GADGET_ID);
    await ws.impl.deliverGadgetLogs(7, [], GADGET_ID);

    expect(events).toStrictEqual([{ chatId: null, logs: [] }, { chatId: 7, logs: [] }]);
    expect(consoleLogId(ws)).toBeUndefined();
    expect(logs.getByName).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  }));

  it("does not reject when the append fails: one warning, with nothing of the entry in it",
      () => withWorkspace(async ws => {
    initialise(ws);
    let events = await subscribe(ws);
    let warn = vi.spyOn(ws.impl.logger, "warn");
    let failure = new Error("log object unavailable");
    ws.impl.workspaceLogs = { getByName: () => ({ append: async () => { throw failure; } }) };

    let logs = [logEvent("log", `${MARKER} in a line`), logEvent("warn", `${MARKER} again`)];
    await expect(ws.impl.deliverGadgetLogs(null, logs, GADGET_ID)).resolves.toBeUndefined();

    expect(events).toStrictEqual([{ chatId: null, logs }]);
    expect(warn.mock.calls).toStrictEqual([[
      "failed to record gadget console output",
      { event: "gadget.console.record.failed", error: failure },
    ]]);
    expect(logged(warn)).not.toContain(MARKER);
  }));

  it("does not reject when the log namespace itself throws", () => withWorkspace(async ws => {
    initialise(ws);
    let warn = vi.spyOn(ws.impl.logger, "warn");
    let logs = unreachableLogs();
    ws.impl.workspaceLogs = logs;

    await expect(ws.impl.deliverGadgetLogs(null, [logEvent("log", "x")], GADGET_ID))
        .resolves.toBeUndefined();
    expect(logs.getByName).toHaveBeenCalledTimes(1);
    expect(warnings(warn, "gadget.console.record.failed")).toHaveLength(1);
  }));

  it("outlives its gadget's deletion", () => withWorkspace(async ws => {
    initialise(ws);
    await addGadget(ws);
    await ws.impl.deliverGadgetLogs(
        null, [logEvent("log", "one"), logEvent("warn", "two")], GADGET_ID);

    await ws.impl.removeWorkpiece(GADGET_ID);
    expect(ws.impl.storage.gadgets.get(GADGET_ID)).toBeUndefined();

    expect(texts(await ws.impl.listConsoleLogs({ gadgetId: GADGET_ID })))
        .toStrictEqual(["two", "one"]);
    expect(texts(await ws.impl.listConsoleLogs())).toStrictEqual(["two", "one"]);
  }));
});

// What a poll for a kept entry waits at most: a trace is delivered after its call has ended, and
// an exception's entry is kept without the call waiting for it.
const KEPT_SOON = { timeout: 5_000, interval: 50 };
// The timeout of a test that runs a real gadget and polls for what it kept, several times over.
const GADGET_TEST_MS = 30_000;

// What a stub call rejected with, as text. One handler awaits it: expect(...).rejects forks the
// underlying promise, and the leftover copy is reported as an unhandled rejection.
async function rejection(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    return String(error);
  }
  throw new Error("the call did not reject");
}

// The entries the facet proxy kept for fail(), newest first. They are found by how their text
// ends, since the trace of the same call may bring an "error" entry of its own.
async function failEntries(ws: Workspace): Promise<GadgetConsoleLogEntry[]> {
  return (await kept(ws, { gadgetId: GADGET_ID, level: "error" }))
      .filter(entry => entry.text.endsWith("at fail()"));
}

// Calls `count` methods the gadget does not have, each named by its caller, and returns what the
// caller chose.
async function failCalls(gadget: any, count: number, from = 0): Promise<string[]> {
  let names = Array.from({ length: count }, (_, i) => `forged_${from + i}`);
  for (let name of names) await rejection(gadget[name]());
  return names;
}

// The entries kept for those calls and the markers of the ones dropped, each oldest first.
const keptForged = async (ws: Workspace) =>
  (await kept(ws, { gadgetId: GADGET_ID, level: "error" }))
      .filter(entry => /at forged_\d+\(\)$/.test(entry.text)).toReversed();
const dropMarkers = async (ws: Workspace) =>
  (await kept(ws, { gadgetId: GADGET_ID, level: "warn" })).toReversed();

describe("an exception a gadget's method did not catch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is kept under the calling chat only if it pins the gadget, and told live under that chat",
      () => withWorkspace(async ws => {
    initialise(ws);
    let commit = await addGadget(ws);
    addChat(ws, 1);
    let events = await subscribe(ws);

    // A chat that holds no draft of the gadget, then one that does not exist: both run the
    // mainline, and the gadget's own error reaches the caller.
    let expected = 0;
    for (let chatId of [1, 99]) {
      using gadget = await ws.impl.getGadgetFacet(GADGET_ID, chatId);
      expect(await rejection(gadget.fail())).toContain("boom");
      expected++;
      await vi.waitFor(async () => expect(await failEntries(ws)).toHaveLength(expected),
          KEPT_SOON);
    }
    for (let entry of await failEntries(ws)) {
      expect(entry).toMatchObject(
          { gadgetId: GADGET_ID, chatId: null, source: "server", level: "error" });
      expect(entry.text).toContain("boom");
      expect(entry).not.toHaveProperty("userId");
    }
    // A subscriber is told each under the chat that was passed.
    let live = events.filter(event =>
        event.logs.some(log => String(log.message[0]).endsWith("at fail()")));
    expect(live.map(event => event.chatId)).toStrictEqual([1, 99]);

    await addDraft(ws, 2, commit);
    {
      using gadget = await ws.impl.getGadgetFacet(GADGET_ID, 2);
      expect(await rejection(gadget.fail())).toContain("draft boom");
    }
    await vi.waitFor(async () => expect(await failEntries(ws)).toHaveLength(3), KEPT_SOON);
    let [newest] = await failEntries(ws);
    expect(newest).toMatchObject({ gadgetId: GADGET_ID, chatId: 2, source: "server" });
    expect(newest.text).toContain("draft boom");
  }), GADGET_TEST_MS);

  it("follows its stub's draft: under the chat while it pins the gadget, under none once merged",
      () => withWorkspace(async ws => {
    initialise(ws);
    let commit = await addGadget(ws);
    await addDraft(ws, 2, commit);
    using gadget = await ws.impl.getGadgetFacet(GADGET_ID, 2);

    expect(await rejection(gadget.fail())).toContain("draft boom");
    await vi.waitFor(async () => expect(await failEntries(ws)).toHaveLength(1), KEPT_SOON);
    expect((await failEntries(ws))[0].chatId).toBe(2);

    expect(await ws.impl.mergeChanges(2, { profile: USER }, "user-do-id"))
        .toEqual({ outcome: "merged" });
    // The stub still names the chat, which proposes nothing any more. Whatever this call rejects
    // with, its entry is labelled when it fails.
    await rejection(gadget.fail());
    await vi.waitFor(async () => expect(await failEntries(ws)).toHaveLength(2), KEPT_SOON);
    expect((await failEntries(ws)).map(entry => entry.chatId)).toStrictEqual([null, 2]);
  }), GADGET_TEST_MS);

  it("is kept redacted, in the error the gadget threw and in the method its caller named",
      () => withWorkspace(async ws => {
    initialise(ws);
    await addGadget(ws);
    let events = await subscribe(ws);
    let key = "sk-live0123456789abcdefghij";
    let thrown = "Error: GET https://api.example/v1?access_token=abc123 failed\n    at leak()";

    // The error's text is the gadget's choice, and the method named is its caller's.
    using gadget = await ws.impl.getGadgetFacet(GADGET_ID);
    expect(await rejection(gadget.leak())).toContain("access_token=abc123");
    await rejection(gadget[key]());

    // The proxy's entries, newest first, found by how they end: a redacted name leaves that.
    let caught = async () =>
      texts({ entries: await kept(ws, { gadgetId: GADGET_ID, level: "error" }) })
          .filter(text => text.endsWith("()"));
    await vi.waitFor(async () => expect(await caught()).toHaveLength(2), KEPT_SOON);
    expect(await caught()).toStrictEqual([
      expect.stringMatching(/at \[redacted\]\(\)$/),
      thrown.replace("abc123", "[redacted]"),
    ]);
    expect((await caught()).join("\n")).not.toContain(key);

    // A subscriber is told each whole: only what is kept is redacted.
    let told = events.flatMap(event => event.logs).map(log => String(log.message[0]));
    expect(told).toContain(thrown);
    expect(told).toContainEqual(expect.stringContaining(`at ${key}()`));
  }), GADGET_TEST_MS);

  it("reaches the gadget's caller as the gadget's own error when its append fails",
      () => withWorkspace(async ws => {
    initialise(ws);
    await addGadget(ws);
    let warn = vi.spyOn(ws.impl.logger, "warn");
    ws.impl.workspaceLogs = {
      getByName: () => ({ append: async () => { throw new Error("log object unavailable"); } }),
    };

    using gadget = await ws.impl.getGadgetFacet(GADGET_ID);
    let message = await rejection(gadget.fail());
    expect(message).toContain("boom");
    expect(message).not.toContain("log object unavailable");

    // The catch's own warning, told from one the trace of the same call would bring.
    let exceptionWarnings = () => warnings(warn, "gadget.console.record.failed")
        .filter(([text]) => text === "failed to record a gadget exception");
    await vi.waitFor(() => expect(exceptionWarnings()).toHaveLength(1), KEPT_SOON);
  }), GADGET_TEST_MS);

  it("holds a gadget to 30 a minute, whichever methods its callers name, and marks the rest",
      () => withWorkspace(async ws => {
    initialise(ws);
    await addGadget(ws);
    await ws.impl.deliverGadgetLogs(null, [logEvent("log", "the server's own")], GADGET_ID);
    let events = await subscribe(ws);
    let start = Date.now();
    let now = vi.spyOn(Date, "now").mockReturnValue(start);

    using gadget = await ws.impl.getGadgetFacet(GADGET_ID);
    let names = await failCalls(gadget, 100);

    // The first 30 are kept, and one marker for the call that was dropped first.
    await vi.waitFor(async () => {
      expect(await keptForged(ws)).toHaveLength(30);
      expect(await dropMarkers(ws)).toHaveLength(1);
    }, KEPT_SOON);
    expect((await keptForged(ws)).map(entry => entry.text.split("at ").at(-1)))
        .toStrictEqual(names.slice(0, 30).map(name => `${name}()`));
    let [marker] = await dropMarkers(ws);
    expect(marker).toMatchObject({ gadgetId: GADGET_ID, chatId: null, source: "server",
                                   text: "1 entry dropped" });
    expect(marker).not.toHaveProperty("userId");
    expect(texts({ entries: await kept(ws, { level: "log" }) }))
        .toStrictEqual(["the server's own"]);

    // The gadget's next minute: the marker of its first kept call counts the other 69.
    now.mockReturnValue(start + 60_000);
    await failCalls(gadget, 1, 100);
    await vi.waitFor(async () => expect(await keptForged(ws)).toHaveLength(31), KEPT_SOON);
    expect(texts({ entries: await dropMarkers(ws) }))
        .toStrictEqual(["1 entry dropped", "69 entries dropped"]);
    // What is said of the drops is kept before the call that brought it.
    expect(texts({ entries: (await kept(ws, { gadgetId: GADGET_ID })).slice(0, 2) }))
        .toStrictEqual([expect.stringMatching(/at forged_100\(\)$/), "69 entries dropped"]);

    // A subscriber is told every one of them.
    let told = events.flatMap(event => event.logs)
        .filter(log => /at forged_\d+\(\)$/.test(String(log.message[0])));
    expect(told).toHaveLength(101);
  }), GADGET_TEST_MS);

  it("counts what a marker that could not be written held with the gadget's next",
      () => withWorkspace(async ws => {
    initialise(ws);
    await addGadget(ws);
    let start = Date.now();
    let now = vi.spyOn(Date, "now").mockReturnValue(start);
    let warn = vi.spyOn(ws.impl.logger, "warn");

    using gadget = await ws.impl.getGadgetFacet(GADGET_ID);
    await failCalls(gadget, 30);
    await vi.waitFor(async () => expect(await keptForged(ws)).toHaveLength(30), KEPT_SOON);

    // The marker of the first drop cannot be kept, and two more calls are dropped after it.
    let real = ws.impl.workspaceLogs;
    ws.impl.workspaceLogs = {
      getByName: () => ({ append: async () => { throw new Error("log object unavailable"); } }),
    };
    await failCalls(gadget, 3, 30);
    await vi.waitFor(() => expect(warnings(warn, "gadget.console.record.failed")
        .filter(([text]) => text === "failed to record a gadget exception")).toHaveLength(1),
        KEPT_SOON);
    ws.impl.workspaceLogs = real;

    now.mockReturnValue(start + 60_000);
    await failCalls(gadget, 1, 33);
    await vi.waitFor(async () => expect(await keptForged(ws)).toHaveLength(31), KEPT_SOON);
    expect(texts({ entries: await dropMarkers(ws) })).toStrictEqual(["3 entries dropped"]);
  }), GADGET_TEST_MS);
});

describe("a gadget Worker's trace", () => {
  it("is kept under the chat its tail carries", () => withWorkspace(async ws => {
    initialise(ws);
    let commit = await addGadget(ws);
    addChat(ws, 1);
    await addDraft(ws, 2, commit);
    let events = await subscribe(ws);
    let newestLog = async () => (await kept(ws, { gadgetId: GADGET_ID, level: "log" }))[0];

    // The mainline's facet.
    {
      using gadget = await ws.impl.getGadgetFacet(GADGET_ID);
      expect(await gadget.greet("Ada")).toBe("Ada");
    }
    await vi.waitFor(async () => expect(await newestLog()).toMatchObject(
        { text: "hello Ada", chatId: null, source: "server" }), KEPT_SOON);

    // The facet of the chat that pins the gadget.
    {
      using gadget = await ws.impl.getGadgetFacet(GADGET_ID, 2);
      expect(await gadget.greet("Bob")).toBe("Bob");
    }
    await vi.waitFor(async () => expect(await newestLog()).toMatchObject(
        { text: "draft hello Bob", chatId: 2, source: "server" }), KEPT_SOON);

    // The export handler runs for the chat the export was asked under, though that chat holds no
    // draft of the gadget, and a subscriber is told its logs under that chat.
    expect(await ws.impl.getGadgetExportFormats(GADGET_ID, 1)).toMatchObject([{ id: "txt" }]);
    await vi.waitFor(async () => expect(await newestLog()).toMatchObject(
        { text: "formats asked", chatId: 1, source: "server" }), KEPT_SOON);
    expect(events.filter(event => event.logs.some(log => log.message[0] === "formats asked"))
        .map(event => event.chatId)).toStrictEqual([1]);
  }), GADGET_TEST_MS);
});

// The owner's session, opened as a client opens one, which initialises the workspace. The close
// notification is a plain function.
async function openOwner(ws: Workspace) {
  ws.impl.ensureAmbientCapsules = async () => {};
  let notifyClosed: any = Object.assign(async () => {}, {
    dup: () => notifyClosed,
    [Symbol.dispose]: () => {},
  });
  return await ws.instance.open(OWNER_USER_ID, ws.owner.id, notifyClosed);
}

describe("listConsoleLogs", () => {
  it("gives a build session the page its query asks for", () => withWorkspace(async ws => {
    let client = await openOwner(ws);
    let lines = Array.from({ length: 150 }, (_, i) => logEvent("log", "line", i));
    await ws.impl.deliverGadgetLogs(null, lines, GADGET_ID);
    await ws.impl.deliverGadgetLogs(7, [logEvent("warn", "careful")], 2);

    let first = await client.listConsoleLogs();
    expect(first.entries).toHaveLength(100);
    expect(first.entries[0]).toMatchObject(
        { gadgetId: 2, chatId: 7, source: "server", level: "warn", text: "careful" });
    expect(first.entries[1].text).toBe("line 149");
    let second = await client.listConsoleLogs({ cursor: first.nextCursor });
    expect(second.entries).toHaveLength(51);
    expect(second.entries.at(-1)!.text).toBe("line 0");
    expect(second).not.toHaveProperty("nextCursor");

    let listed = async (query: GadgetConsoleLogQuery) =>
        texts(await client.listConsoleLogs(query));
    expect(await listed({ gadgetId: 2 })).toStrictEqual(["careful"]);
    expect(await listed({ chatId: 7 })).toStrictEqual(["careful"]);
    expect(await listed({ level: "warn" })).toStrictEqual(["careful"]);
    expect(await listed({ gadgetId: GADGET_ID, chatId: null, level: "warn" })).toStrictEqual([]);
    expect(await listed({ source: "client" })).toStrictEqual([]);
    expect(await listed({ until: new Date(0) })).toStrictEqual([]);
    expect(await listed({ gadgetId: 2, since: new Date(0) })).toStrictEqual(["careful"]);
  }));

  it("checks the query, and asks no log object, while the workspace has kept nothing",
      () => withWorkspace(async ws => {
    let client = await openOwner(ws);
    let logs = unreachableLogs();
    ws.impl.workspaceLogs = logs;

    await expect(client.listConsoleLogs({ cursor: "abc" })).rejects.toThrow("Invalid cursor.");
    expect(await client.listConsoleLogs()).toStrictEqual({ entries: [] });
    expect(await client.listConsoleLogs({ gadgetId: GADGET_ID })).toStrictEqual({ entries: [] });
    expect(logs.getByName).not.toHaveBeenCalled();
    expect(consoleLogId(ws)).toBeUndefined();
  }));

  it("checks the query before it asks the log object that holds entries",
      () => withWorkspace(async ws => {
    let client = await openOwner(ws);
    await ws.impl.deliverGadgetLogs(null, [logEvent("log", "kept")], GADGET_ID);
    let logs = unreachableLogs();
    ws.impl.workspaceLogs = logs;

    await expect(client.listConsoleLogs({ cursor: "abc" })).rejects.toThrow("Invalid cursor.");
    expect(logs.getByName).not.toHaveBeenCalled();
  }));

  it("gives a use session an empty page, whatever the query, and reaches nothing",
      () => withWorkspace(async ws => {
    initialise(ws);
    await ws.impl.deliverGadgetLogs(null, [logEvent("log", "kept")], GADGET_ID);

    // A "use" session over a forged impl that holds only what such a session may reach: the
    // listing and the log namespace are counted, and neither may be asked.
    let listConsoleLogs = vi.fn();
    let logs = unreachableLogs();
    let client = await openFakeOverseer({ gadgets: ws.impl.storage.gadgets }, {
      role: "use", impl: { listConsoleLogs, workspaceLogs: logs },
    });
    expect(await client.listConsoleLogs()).toStrictEqual({ entries: [] });
    expect(await client.listConsoleLogs({ gadgetId: GADGET_ID })).toStrictEqual({ entries: [] });
    expect(await client.listConsoleLogs({ cursor: "abc" })).toStrictEqual({ entries: [] });
    expect(listConsoleLogs).not.toHaveBeenCalled();
    expect(logs.getByName).not.toHaveBeenCalled();
    (client as unknown as Disposable)[Symbol.dispose]();
  }));
});

// The real log namespace with append() or destroy() replaced where `faults` gives one. Its lookups
// are counted.
function faultyLogs(real: any, faults: {
  append?: () => Promise<void>;
  destroy?: (destroy: () => Promise<void>) => Promise<void>;
}) {
  return {
    getByName: vi.fn((name: string) => {
      let stub = real.getByName(name);
      return {
        append: (entries: GadgetConsoleLogEntry[]) =>
            faults.append ? faults.append() : stub.append(entries),
        destroy: () => faults.destroy ? faults.destroy(() => stub.destroy()) : stub.destroy(),
      };
    }),
  };
}

// Begins the workspace's deletion with its owner's listing still to remove, as deleteSelf() does.
function beginDeletion(ws: Workspace): void {
  ws.impl.beginDeletion(new Set([OWNER_USER_ID]));
}

describe("deleting the workspace", () => {
  it("deletes its log object, through the owner's deleteSelf()", () => withWorkspace(async ws => {
    let client = await openOwner(ws);
    await ws.impl.deliverGadgetLogs(null, [logEvent("log", "kept")], GADGET_ID);
    let name = consoleLogId(ws)!;
    expect(await hasLogTable(name)).toBe(true);
    expect(await logAlarm(name)).not.toBeNull();

    await client.deleteSelf();
    expect(storageKeys(ws)).toStrictEqual([]);
    expect(await hasLogTable(name)).toBe(false);
    expect(await logAlarm(name)).toBeNull();
  }));

  it("waits for an append still in flight before it destroys the log object",
      () => withWorkspace(async ws => {
    initialise(ws);
    let order: string[] = [];
    let release = Promise.withResolvers<void>();
    ws.impl.workspaceLogs = {
      getByName: () => ({
        append: async () => {
          order.push("append sent");
          await release.promise;
          order.push("append settled");
        },
        destroy: async () => { order.push("destroy"); },
      }),
    };

    let delivered = ws.impl.deliverGadgetLogs(null, [logEvent("log", "in flight")], GADGET_ID);
    beginDeletion(ws);
    let drained = ws.impl.deliverUserUpdates();
    await scheduler.wait(100);
    expect(order).toStrictEqual(["append sent"]);

    release.resolve();
    await drained;
    await delivered;
    expect(order).toStrictEqual(["append sent", "append settled", "destroy"]);
    expect(storageKeys(ws)).toStrictEqual([]);
  }));

  it("asks no log object when the workspace kept nothing", () => withWorkspace(async ws => {
    initialise(ws);
    let logs = unreachableLogs();
    ws.impl.workspaceLogs = logs;

    beginDeletion(ws);
    await ws.impl.deliverUserUpdates();
    expect(logs.getByName).not.toHaveBeenCalled();
    expect(storageKeys(ws)).toStrictEqual([]);
  }));

  // Each case keeps an entry, makes the log object impossible to destroy, and returns what the
  // deferral's warning must carry and how the test lets the deletion through afterwards.
  type Blocked = { error: string | Error; unblock: () => void };
  let blocks: [string, (ws: Workspace, real: any) => Blocked][] = [
    ["an append that never settles is in flight", (ws, real) => {
      let release = Promise.withResolvers<void>();
      ws.impl.workspaceLogs = faultyLogs(real, { append: () => release.promise });
      void ws.impl.deliverGadgetLogs(null, [logEvent("log", "held")], GADGET_ID);
      return { error: "Console log deletion timed out.", unblock: () => release.resolve() };
    }],
    ["destroy() never settles", (ws, real) => {
      let release = Promise.withResolvers<void>();
      ws.impl.workspaceLogs = faultyLogs(real, {
        destroy: async destroy => { await release.promise; await destroy(); },
      });
      return { error: "Console log deletion timed out.", unblock: () => release.resolve() };
    }],
    ["destroy() rejects", (ws, real) => {
      let failure = new Error("log storage failed");
      let failing = true;
      ws.impl.workspaceLogs = faultyLogs(real, {
        destroy: destroy => failing ? Promise.reject(failure) : destroy(),
      });
      return { error: failure, unblock: () => { failing = false; } };
    }],
  ];

  it.for(blocks)("is deferred, and never rejects the drain, while %s",
      ([, block]) => withWorkspace(async ws => {
    initialise(ws);
    await ws.impl.deliverGadgetLogs(null, [logEvent("log", MARKER)], GADGET_ID);
    let name = consoleLogId(ws)!;
    let warn = vi.spyOn(ws.impl.logger, "warn");
    let { error, unblock } = block(ws, ws.impl.workspaceLogs);

    beginDeletion(ws);
    await expect(ws.impl.deliverUserUpdates()).resolves.toBeUndefined();

    // One warning, with the cause and nothing of an entry.
    expect(warn).toHaveBeenCalledTimes(1);
    let [[message, fields]] = warnings(warn, "gadget.console.delete.failed");
    expect(message).toBe("console log deletion deferred");
    let caught = (fields as { error: Error }).error;
    if (typeof error === "string") expect(caught.message).toBe(error);
    else expect(caught).toBe(error);
    expect(logged(warn)).not.toContain(MARKER);

    // The workspace's storage is whole and its tombstone stands, so the alarm tries again.
    expect(ws.impl.storage.deleting.get()).toBe(true);
    expect(consoleLogId(ws)).toBe(name);
    expect(ws.impl.storage.ownerId.get()).toBe(OWNER_USER_ID);
    let alarm = await ws.state.storage.getAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm! - Date.now()).toBeLessThanOrEqual(30_000);

    unblock();
    await ws.impl.deliverUserUpdates();
    expect(storageKeys(ws)).toStrictEqual([]);
    expect(await hasLogTable(name)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  }), 20_000);

  it("tries destroy() again after the log object was reset", () => withWorkspace(async ws => {
    initialise(ws);
    await ws.impl.deliverGadgetLogs(null, [logEvent("log", "kept")], GADGET_ID);
    let name = consoleLogId(ws)!;
    let warn = vi.spyOn(ws.impl.logger, "warn");
    // The shape a reset arrives in on a deployment; the test pool's own aborts carry no flag.
    let reset = Object.assign(new Error("Durable Object reset."),
        { remote: true, overloaded: true, durableObjectReset: true });
    let destroys = 0;
    let logs = faultyLogs(ws.impl.workspaceLogs, {
      destroy: destroy => ++destroys === 1 ? Promise.reject(reset) : destroy(),
    });
    ws.impl.workspaceLogs = logs;

    beginDeletion(ws);
    await ws.impl.deliverUserUpdates();
    expect(destroys).toBe(2);
    // Each try asks the namespace for the stub: one of an object that was reset stays broken.
    expect(logs.getByName).toHaveBeenCalledTimes(2);
    expect(warnings(warn, "gadget.console.delete.failed")).toStrictEqual([]);
    expect(storageKeys(ws)).toStrictEqual([]);
    expect(await hasLogTable(name)).toBe(false);
  }));

  it("still restarts the workspace's sessions from deleteSelf() when its log object fails",
      () => withWorkspace(async ws => {
    let client = await openOwner(ws);
    let reasons: string[] = [];
    ws.impl.scheduleAccessRestart = async (reason: string) => { reasons.push(reason); };
    await ws.impl.deliverGadgetLogs(null, [logEvent("log", "kept")], GADGET_ID);
    let name = consoleLogId(ws)!;
    let real = ws.impl.workspaceLogs;
    let warn = vi.spyOn(ws.impl.logger, "warn");
    ws.impl.workspaceLogs = faultyLogs(real, {
      destroy: () => Promise.reject(new Error("log storage failed")),
    });

    await expect(client.deleteSelf()).resolves.toBeUndefined();
    expect(reasons).toStrictEqual(["Gadget restarted because the workspace was deleted."]);
    expect(warnings(warn, "gadget.console.delete.failed")).toHaveLength(1);
    expect(ws.impl.storage.deleting.get()).toBe(true);
    expect(consoleLogId(ws)).toBe(name);

    // A second delete finds the workspace already being deleted, and restarts nothing.
    await expect(client.deleteSelf()).resolves.toBeUndefined();
    expect(reasons).toHaveLength(1);

    // What the alarm runs, once the log object answers.
    ws.impl.workspaceLogs = real;
    await ws.impl.deliverUserUpdates();
    expect(storageKeys(ws)).toStrictEqual([]);
    expect(await hasLogTable(name)).toBe(false);
  }));

  it("leaves a workspace initialised again under the same id with no log of its earlier life",
      () => withWorkspace(async ws => {
    initialise(ws);
    await ws.impl.deliverGadgetLogs(null, [logEvent("log", "first life")], GADGET_ID);
    let earlier = consoleLogId(ws)!;
    // What a gadget call still open at the deletion logged: its trace is delivered when it ends.
    let open = logEvent("log", "first life, delivered late");

    beginDeletion(ws);
    await ws.impl.deliverUserUpdates();
    expect(storageKeys(ws)).toStrictEqual([]);

    // An append that was sent before the deletion and lands after it.
    await env.TEST_WORKSPACE_LOG.getByName(earlier).append([{
      time: new Date(), gadgetId: GADGET_ID, chatId: null, source: "server", level: "log",
      text: "late",
    }]);

    // The id is initialised again, as an external message does it, and the open call's trace
    // arrives: the same gadget id, under the next life's owner.
    initialise(ws);
    ws.impl.storage.createdAt.put(new Date(open.timestamp.getTime() + 1));
    await ws.impl.deliverGadgetLogs(null, [open], GADGET_ID);
    expect(consoleLogId(ws)).toBeUndefined();

    await ws.impl.deliverGadgetLogs(null, [{ ...logEvent("log", "second life"),
        timestamp: new Date(open.timestamp.getTime() + 2) }], GADGET_ID);
    expect(consoleLogId(ws)).not.toBe(earlier);
    expect(texts(await ws.impl.listConsoleLogs())).toStrictEqual(["second life"]);
  }));

  it("initialises nothing for an external message on the instance that deleted the workspace",
      () => withWorkspace(async ws => {
    initialise(ws);
    // Whoever posts next has an account, so only the deletion can turn their message away.
    ws.impl.users = {
      ...fakeUsers(ws),
      getByName: () => ({
        id: { toString: () => "next-owner-do" },
        whoamiIfExists: async () => ({ type: "user", id: "next@example.test", name: "Next" }),
      }),
    };

    beginDeletion(ws);
    await ws.impl.deliverUserUpdates();
    expect(storageKeys(ws)).toStrictEqual([]);

    // The tombstone went with the storage, and this instance's gadgets run until its restart: a
    // workspace initialised here would be given what they log from then on.
    let message: Parameters<OverseerDurableObject["receiveExternalMessage"]>[0] = {
      callerEmail: "next@example.test", externalChatKey: "k", idempotencyKey: "i",
      prompt: "hello", chatGatewayRpcTarget: {} as never, title: "Next life",
    };
    expect(await ws.instance.receiveExternalMessage(message))
        .toStrictEqual({ accepted: false, message: "Workspace was deleted." });
    expect(ws.impl.ownerId).toBeUndefined();
    expect(storageKeys(ws)).toStrictEqual([]);
  }));
});

// A second gadget of the workspace, and a worktree.
const OTHER_GADGET_ID = 2;
const WORKTREE_ID = 3;

// Runs `fn` with the owner's session over a workspace that holds the gadget, at `commit`, a second
// gadget and a worktree.
function withReporter(fn: (ws: Workspace, client: Overseer, commit: string) => Promise<void>)
    : Promise<void> {
  return withWorkspace(async ws => {
    using client = await openOwner(ws);
    let commit = await addGadget(ws);
    ws.impl.storage.gadgets.put({
      type: "gadget", id: OTHER_GADGET_ID, title: "Other", created: new Date(0),
      bindingName: "OTHER", bindings: {},
    });
    ws.impl.storage.gadgets.put({
      type: "worktree", id: WORKTREE_ID, title: "Repo", created: new Date(0), chatId: 0,
      baseCommit: "c0", headCommit: "c0", pinBase: "c0",
    });
    await fn(ws, client, commit);
  });
}

// When the reported calls of these cases were made.
const AT = new Date("2026-01-02T03:04:05.678Z");

// One reported call, made at `AT`.
const reported = (text: string, level: ConsoleLogEvent["level"] = "log")
    : ReportedGadgetConsoleLog => ({ time: AT, level, text });

// `count` reported calls of level "log", their texts `prefix` and a number from 0.
const batch = (count: number, prefix = "n"): ReportedGadgetConsoleLog[] =>
  Array.from({ length: count }, (_, i) => reported(prefix + i));

// The entry kept for a call the owner's browser reported for the gadget, under no chat.
const reportedEntry = (ws: Workspace, entry: ReportedGadgetConsoleLog): GadgetConsoleLogEntry => ({
  time: entry.time, gadgetId: GADGET_ID, chatId: null, source: "client", userId: ws.owner.id,
  level: entry.level, text: entry.text,
});

// Every entry the Overseer lists for `query`, newest first.
async function listAll(ws: Workspace, query: GadgetConsoleLogQuery = {})
    : Promise<GadgetConsoleLogEntry[]> {
  let entries: GadgetConsoleLogEntry[] = [];
  let cursor: string | undefined;
  do {
    let page = await ws.impl.listConsoleLogs({ ...query, ...(cursor !== undefined && { cursor }) });
    entries.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return entries;
}

// Of those, the calls that were reported, and the markers of what was dropped, each oldest first:
// the order they were kept in. Every call these cases report in bulk has level "log", and a marker
// has "warn".
const lines = async (ws: Workspace) =>
  (await listAll(ws)).filter(entry => entry.level !== "warn").toReversed();
const markers = async (ws: Workspace) =>
  (await listAll(ws)).filter(entry => entry.level === "warn").toReversed();

// Reports six full calls for the gadget, which is all it may record in a minute.
async function useUpMinute(client: Overseer): Promise<void> {
  for (let call = 0; call < GADGET_CONSOLE_LOGS_PER_MINUTE / MAX_GADGET_CONSOLE_LOGS_PER_CALL;
       call++) {
    await client.reportGadgetConsoleLogs(
        GADGET_ID, null, batch(MAX_GADGET_CONSOLE_LOGS_PER_CALL, `call${call}-`));
  }
}

// Filler of `n` characters in which no run of token characters is long.
const words = (n: number) => "word ".repeat(Math.ceil(n / 5)).slice(0, n);

describe("keeping what a session reports of a gadget's UI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // What decides is #resolveGadgetChatId, as for an exception of the gadget's server.
  it("names the chat only while it proposes a change to the gadget", () =>
      withReporter(async (ws, client, commit) => {
    addChat(ws, 1);
    await addDraft(ws, 2, commit);
    let entry = reported("boom", "error");

    // Chat 1 proposes nothing, so the UI it showed was the mainline's. Chat 2 pins the gadget.
    await client.reportGadgetConsoleLogs(GADGET_ID, 1, [entry]);
    await client.reportGadgetConsoleLogs(GADGET_ID, 2, [entry]);
    await client.reportGadgetConsoleLogs(GADGET_ID, null, [entry]);

    expect(await listAll(ws)).toStrictEqual([
      reportedEntry(ws, entry), { ...reportedEntry(ws, entry), chatId: 2 },
      reportedEntry(ws, entry),
    ]);
  }));

  it("leaves nothing of a token that straddles the cut", () =>
      withReporter(async (ws, client) => {
    let token = "A1b2C3d4E5".repeat(4);
    // The token starts five characters before the kept length.
    let text = (words(1987) + " Bearer " + token + " " + words(4000)).slice(0, 4000);

    await client.reportGadgetConsoleLogs(GADGET_ID, null, [reported(text)]);

    let cut = (words(1987) + " Bearer [redacted] " + words(4000)).slice(0, 1999) + "…";
    expect(cut).toHaveLength(MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH);
    expect(texts({ entries: await listAll(ws) })).toStrictEqual([cut]);
    expect(cut).not.toContain("A1b2");
  }));

  it("keeps the first entries of a call up to the cap, and marks the rest", () =>
      withReporter(async (ws, client, commit) => {
    let began = Date.now();
    await addDraft(ws, 2, commit);
    let entries = batch(MAX_GADGET_CONSOLE_LOGS_PER_CALL + 10);

    await client.reportGadgetConsoleLogs(GADGET_ID, 2, entries);

    let all = await listAll(ws);
    expect(all.slice(0, -1)).toStrictEqual(entries.slice(0, MAX_GADGET_CONSOLE_LOGS_PER_CALL)
        .map(entry => ({ ...reportedEntry(ws, entry), chatId: 2 })).toReversed());
    // The marker was kept first, so the listing ends with it.
    let marker = all.at(-1)!;
    expect(marker).toStrictEqual({
      time: expect.any(Date), gadgetId: GADGET_ID, chatId: 2, source: "client",
      userId: ws.owner.id, level: "warn", text: "10 entries dropped",
    });
    expect(marker.time.getTime()).toBeGreaterThanOrEqual(began);
  }));

  it("holds a gadget to its entries a minute, and marks what it drops once a minute", () =>
      withReporter(async (ws, client) => {
    let start = Date.now();
    let now = vi.spyOn(Date, "now").mockReturnValue(start);
    await useUpMinute(client);
    expect(await lines(ws)).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE);
    expect((await lines(ws)).at(-1)!.text).toBe(`call5-${MAX_GADGET_CONSOLE_LOGS_PER_CALL - 1}`);
    expect(await markers(ws)).toHaveLength(0);

    // The minute is used up: the next call's entries are dropped, and marked at once.
    await client.reportGadgetConsoleLogs(
        GADGET_ID, null, batch(MAX_GADGET_CONSOLE_LOGS_PER_CALL, "over-"));
    expect(await lines(ws)).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE);
    expect(texts({ entries: await markers(ws) })).toStrictEqual(["50 entries dropped"]);

    // A gadget is marked once a minute, so these fifty wait for its next: the call keeps
    // nothing, and reaches no log object.
    let real = ws.impl.workspaceLogs;
    let logs = unreachableLogs();
    ws.impl.workspaceLogs = logs;
    await client.reportGadgetConsoleLogs(
        GADGET_ID, null, batch(MAX_GADGET_CONSOLE_LOGS_PER_CALL, "later-"));
    expect(logs.getByName).not.toHaveBeenCalled();
    ws.impl.workspaceLogs = real;

    // Another gadget's minute is its own.
    await client.reportGadgetConsoleLogs(OTHER_GADGET_ID, null, [reported("other")]);
    expect(await listAll(ws, { gadgetId: OTHER_GADGET_ID })).toStrictEqual(
        [{ ...reportedEntry(ws, reported("other")), gadgetId: OTHER_GADGET_ID }]);

    now.mockReturnValue(start + 60_000);
    await client.reportGadgetConsoleLogs(GADGET_ID, null, [reported("next")]);
    let all = await listAll(ws, { gadgetId: GADGET_ID });
    expect(all).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE + 3);
    // The marker of the fifty that waited, and then the call's own entry.
    expect(all[0]).toStrictEqual(reportedEntry(ws, reported("next")));
    expect(all[1]).toMatchObject({ level: "warn", text: "50 entries dropped" });
    expect(texts({ entries: await markers(ws) }))
        .toStrictEqual(["50 entries dropped", "50 entries dropped"]);
  }));

  // What this varies is the chat the calls came under: a marker's count is the gadget's,
  // whatever chat its calls named (the method's doc), while its labels are those of the call
  // that brings it. This file has one session, so it says nothing of users: two reporters that
  // share a gadget's minute and its count are in use-gadget-access.test.ts.
  it("labels a marker with the call that brings it, whichever calls dropped what it counts", () =>
      withReporter(async (ws, client, commit) => {
    await addDraft(ws, 2, commit);
    let start = Date.now();
    let now = vi.spyOn(Date, "now").mockReturnValue(start);
    await useUpMinute(client);
    await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(10));
    expect(await markers(ws)).toMatchObject([{ text: "10 entries dropped", chatId: null }]);
    await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(5));
    expect(await markers(ws)).toHaveLength(1);

    // The five were reported under no chat, and are marked under the chat of this call.
    now.mockReturnValue(start + 60_000);
    await client.reportGadgetConsoleLogs(GADGET_ID, 2, [reported("next")]);
    expect(await markers(ws)).toHaveLength(2);
    expect((await markers(ws))[1]).toMatchObject(
        { text: "5 entries dropped", chatId: 2, userId: ws.owner.id });
    expect((await lines(ws)).at(-1)).toStrictEqual(
        { ...reportedEntry(ws, reported("next")), chatId: 2 });
  }));

  // A report that brings neither an entry to keep nor a marker ends in the Overseer. Two kinds
  // do: one for a gadget whose minute is used up and marked, and an empty one, whose gadget and
  // chat the session checks all the same. No clock is moved: the gadget's minute runs from its
  // first report, and the case takes far less.
  it("reaches no log object for a report that leaves nothing to keep or mark", () =>
      withReporter(async (ws, client) => {
    await useUpMinute(client);
    await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(5));
    expect(await lines(ws)).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE);
    expect(texts({ entries: await markers(ws) })).toStrictEqual(["5 entries dropped"]);

    // A log object asked from here on fails its report, which would log that and reject.
    let warn = vi.spyOn(ws.impl.logger, "warn");
    let real = ws.impl.workspaceLogs;
    let logs = unreachableLogs();
    ws.impl.workspaceLogs = logs;
    await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(5));
    await client.reportGadgetConsoleLogs(OTHER_GADGET_ID, null, []);
    await expect(client.reportGadgetConsoleLogs(999, null, []))
        .rejects.toThrow(/No such gadget: 999/);
    await expect(client.reportGadgetConsoleLogs(GADGET_ID, 424242, []))
        .rejects.toThrow(/No such chatId: 424242/);
    expect(logs.getByName).not.toHaveBeenCalled();
    expect(warnings(warn, "gadget.console.record.failed")).toHaveLength(0);

    ws.impl.workspaceLogs = real;
    expect(await listAll(ws)).toHaveLength(GADGET_CONSOLE_LOGS_PER_MINUTE + 1);
  }));

  // What the log object failed with is in the warning alone. The caller is refused with the
  // Overseer's own error whatever it was: a log object that was reset fails with a message and
  // flags that a client takes for a failure a retry cures, and a client that took a refused
  // report for one would not wait any longer before its next.
  it.each([
    ["rejects", () => failingLogs(new Error("down")), /down/],
    ["was reset", () => failingLogs(Object.assign(
        new Error("Durable Object storage operation exceeded timeout which caused object to be " +
            "reset."),
        { remote: true, overloaded: true, durableObjectReset: true, retryable: true })),
      /storage operation exceeded timeout/],
    ["cannot be asked", unreachableLogs, /no log object should be asked/],
  ])("refuses a report whose log object %s with its own error: one warning, and nothing of the " +
      "entry in it", (_name, logs, failure) => withReporter(async (ws, client) => {
    let warn = vi.spyOn(ws.impl.logger, "warn");
    let real = ws.impl.workspaceLogs;
    ws.impl.workspaceLogs = logs();

    let refused: unknown = await client
        .reportGadgetConsoleLogs(GADGET_ID, null, [reported(`${MARKER} unkept`)])
        .then(() => undefined, error => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toBe(REPORT_REFUSED);
    // Nor does the caught error go along as a cause, which is sent to a client with its error.
    for (let relayed of ["durableObjectReset", "overloaded", "retryable", "cause"]) {
      expect(refused).not.toHaveProperty(relayed);
    }

    expect(warn.mock.calls).toStrictEqual([[
      "failed to record reported gadget console output",
      { event: "gadget.console.record.failed", error: expect.objectContaining(
          { message: expect.stringMatching(failure) }) },
    ]]);
    expect(logged(warn)).not.toContain(MARKER);
    ws.impl.workspaceLogs = real;
    expect(await listAll(ws)).toStrictEqual([]);
  }));

  // The limiter has counted a marker's drops by the time the marker's append fails, so the
  // Overseer has them counted again: otherwise no marker would ever hold them.
  it("counts what a marker that could not be written held with the gadget's next", () =>
      withReporter(async (ws, client) => {
    let start = Date.now();
    let now = vi.spyOn(Date, "now").mockReturnValue(start);
    await useUpMinute(client);
    await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(10));
    expect(texts({ entries: await markers(ws) })).toStrictEqual(["10 entries dropped"]);
    // Seven more wait for the gadget's next minute, whose first report cannot be kept.
    await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(7));

    now.mockReturnValue(start + 60_000);
    let real = ws.impl.workspaceLogs;
    let handed: string[][] = [];
    ws.impl.workspaceLogs = { getByName: () => ({
      append: async (entries: GadgetConsoleLogEntry[]) => {
        handed.push(entries.map(entry => entry.text));
        throw new Error("down");
      },
    }) };
    await expect(client.reportGadgetConsoleLogs(GADGET_ID, null, batch(3)))
        .rejects.toThrow(REPORT_REFUSED);
    // The marker and the call's entries went in one append, the marker first.
    expect(handed).toStrictEqual([["7 entries dropped", "n0", "n1", "n2"]]);
    ws.impl.workspaceLogs = real;

    // A gadget is marked once a minute, written or not, so the seven wait for the one after.
    await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(1));
    expect(await markers(ws)).toHaveLength(1);
    now.mockReturnValue(start + 120_000);
    await client.reportGadgetConsoleLogs(GADGET_ID, null, batch(1));
    expect(texts({ entries: await markers(ws) }))
        .toStrictEqual(["10 entries dropped", "7 entries dropped"]);
  }));

  it("delivers nothing of a report to a live subscriber", () =>
      withReporter(async (ws, client) => {
    let events = await subscribe(ws);

    await client.reportGadgetConsoleLogs(GADGET_ID, null, [reported("reported")]);
    expect(texts({ entries: await listAll(ws) })).toStrictEqual(["reported"]);

    // A subscriber is sent its events in order, so anything the report had delivered would stand
    // before this one.
    let sentinel = [logEvent("info", "sentinel")];
    await ws.impl.deliverGadgetLogs(null, sentinel);
    expect(events).toStrictEqual([{ chatId: null, logs: sentinel }]);
  }));

  // Validation lets members it does not know through, so a reported call can carry any member an
  // entry has. None is kept: an entry's user and labels are the session's and the kernel's.
  it("keeps nothing a client adds to an entry", () => withReporter(async (ws, client) => {
    let forged = {
      time: AT, level: "error", text: "boom", userId: "mallory", source: "server", gadgetId: 999,
      chatId: 77,
    } as ReportedGadgetConsoleLog;

    await client.reportGadgetConsoleLogs(GADGET_ID, null, [forged]);

    expect(await listAll(ws)).toStrictEqual([reportedEntry(ws, reported("boom", "error"))]);
    expect(await listAll(ws, { source: "server" })).toStrictEqual([]);
  }));

  // An entry is kept for as long as any other whatever its own time says (the log object's
  // tests), so a reported time decides nothing but what the listing shows and filters by.
  it("keeps a reported time as it is, a future one included, and an invalid one as its arrival",
      () => withReporter(async (ws, client) => {
    let old = new Date(Date.now() - 73 * 3_600_000);
    let future = new Date("2999-01-01T00:00:00Z");
    let before = Date.now();

    await client.reportGadgetConsoleLogs(GADGET_ID, null, [
      { time: old, level: "log", text: "old" }, { time: future, level: "log", text: "future" },
      { time: new Date(NaN), level: "log", text: "invalid" },
    ]);

    let [invalid, ...rest] = await listAll(ws);
    expect(rest).toStrictEqual([
      reportedEntry(ws, { time: future, level: "log", text: "future" }),
      reportedEntry(ws, { time: old, level: "log", text: "old" }),
    ]);
    expect(invalid.text).toBe("invalid");
    expect(invalid.time.getTime()).toBeGreaterThanOrEqual(before);
    expect(invalid.time.getTime()).toBeLessThanOrEqual(Date.now());
  }));

  it.each([
    ["an unknown gadget", 999, null, "log", /No such gadget: 999/],
    ["a worktree", WORKTREE_ID, null, "log", /is a worktree, not a gadget/],
    ["an unknown chat", GADGET_ID, 424242, "log", /No such chatId: 424242/],
    // A workspace's first chat is chat 0, and this workspace has none.
    ["chat 0 where there is none", GADGET_ID, 0, "log", /No such chatId: 0/],
    // Refused by the session's validation, before the method runs.
    ["a level no console has", GADGET_ID, null, "fatal", /\[2\]\[0\]\.level: expected union/],
  ] as const)("refuses %s, and keeps nothing", (_name, gadgetId, chatId, level, error) =>
      withReporter(async (ws, client) => {
    let refused = { time: AT, level, text: "refused" } as ReportedGadgetConsoleLog;
    // Called inside an async function: validation throws where the method is called, which on
    // the session itself is here and not in the promise it returns.
    await expect(async () => client.reportGadgetConsoleLogs(gadgetId, chatId, [refused]))
        .rejects.toThrow(error);
    expect(consoleLogId(ws)).toBeUndefined();

    // A report resolves once its entries are kept, so the one that follows a refusal is the only
    // one kept.
    await client.reportGadgetConsoleLogs(GADGET_ID, null, [reported("accepted")]);
    expect(await listAll(ws)).toStrictEqual([reportedEntry(ws, reported("accepted"))]);
  }));

  it("resolves and keeps nothing for a workspace that is being deleted", () =>
      withReporter(async (ws, client) => {
    await client.reportGadgetConsoleLogs(GADGET_ID, null, [reported("kept")]);
    let name = consoleLogId(ws)!;
    let warn = vi.spyOn(ws.impl.logger, "warn");
    let real = ws.impl.workspaceLogs;
    let logs = unreachableLogs();

    ws.impl.beginDeletion(new Set());
    ws.impl.workspaceLogs = logs;
    await expect(client.reportGadgetConsoleLogs(GADGET_ID, null, [reported("too late")]))
        .resolves.toBeUndefined();
    expect(logs.getByName).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(texts({ entries: await keptIn(name) })).toStrictEqual(["kept"]);

    // The deletion runs to its end, so that the workspace leaves no alarm retrying it.
    ws.impl.workspaceLogs = real;
    await ws.impl.deliverUserUpdates();
    expect(storageKeys(ws)).toStrictEqual([]);
  }));

  it("keeps what was reported for a gadget that is deleted, and takes no more for it", () =>
      withReporter(async (ws, client) => {
    // A collaborator who may use every gadget, whose session reaches the real access check.
    let viewer = await openFakeOverseer({ gadgets: ws.impl.storage.gadgets }, {
      role: "use", impl: {
        holdsGadget: (profileId: string, gadgetId: number) =>
            ws.impl.holdsGadget(profileId, gadgetId),
        reportGadgetConsoleLogs: (...args: unknown[]) => ws.impl.reportGadgetConsoleLogs(...args),
      },
    });
    ws.impl.storage.collaborators.put({
      profile: { id: "viewer-id-profile", name: "Viewer" },
      addedBy: [{ type: "user", sharer: ws.owner.id, created: new Date(0), role: "use" }],
    });
    await client.reportGadgetConsoleLogs(GADGET_ID, null, [reported("one"), reported("two")]);
    await viewer.reportGadgetConsoleLogs(GADGET_ID, null, [reported("three")]);
    let before = await listAll(ws, { gadgetId: GADGET_ID, source: "client" });
    expect(texts({ entries: before })).toStrictEqual(["three", "two", "one"]);
    expect(before[0].userId).toBe("viewer-id-profile");

    await ws.impl.removeWorkpiece(GADGET_ID);

    expect(await listAll(ws, { gadgetId: GADGET_ID, source: "client" })).toStrictEqual(before);
    await expect(client.reportGadgetConsoleLogs(GADGET_ID, null, [reported("late")]))
        .rejects.toThrow(`No such gadget: ${GADGET_ID}`);
    await expect(viewer.reportGadgetConsoleLogs(GADGET_ID, null, [reported("late")]))
        .rejects.toThrow(`No such gadget: ${GADGET_ID}`);
    expect(await listAll(ws)).toStrictEqual(before);
    (viewer as unknown as Disposable)[Symbol.dispose]();
  }));

  it("keeps the entries labelled with a chat that is deleted, and takes no more under it", () =>
      withReporter(async (ws, client, commit) => {
    await addDraft(ws, 2, commit);
    await client.reportGadgetConsoleLogs(GADGET_ID, 2, [reported("draft")]);
    let before = await listAll(ws);
    expect(before).toStrictEqual([{ ...reportedEntry(ws, reported("draft")), chatId: 2 }]);

    await client.deleteChat(2);
    expect(ws.impl.storage.chatMeta.get(2)).toBeUndefined();

    expect(await listAll(ws)).toStrictEqual(before);
    expect(await listAll(ws, { chatId: 2 })).toStrictEqual(before);
    await expect(client.reportGadgetConsoleLogs(GADGET_ID, 2, [reported("gone")]))
        .rejects.toThrow("No such chatId: 2");
    expect(await listAll(ws)).toStrictEqual(before);
  }));
});
