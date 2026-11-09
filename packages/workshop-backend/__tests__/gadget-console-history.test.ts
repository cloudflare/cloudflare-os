// The Overseer as the one writer of its workspace's console log history: what a gadget's server
// logs and the exceptions it does not catch are kept in the workspace's log object and listed back
// (OverseerImpl.deliverGadgetLogs(), #recordGadgetException() and listConsoleLogs()), live
// subscribers get each event whole, under the chat it was delivered with, and deleting the
// workspace deletes the log object before the workspace's own storage.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding) keeping entries in the real
// log object it reaches through ctx.exports, read back through the TEST_WORKSPACE_LOG binding.
// Gadgets are real facets loaded from real commits. User DOs are fakes, and so is the log
// namespace where a test makes it fail.

import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH,
  type AiChatAuthorInfo, type CodeChangeSubmission, type ConsoleLogEvent,
  type GadgetConsoleLogEntry, type GadgetConsoleLogQuery,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
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

describe("an exception a gadget's method did not catch", () => {
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

    beginDeletion(ws);
    await ws.impl.deliverUserUpdates();
    expect(storageKeys(ws)).toStrictEqual([]);

    // An append that was sent before the deletion and lands after it.
    await env.TEST_WORKSPACE_LOG.getByName(earlier).append([{
      time: new Date(), gadgetId: GADGET_ID, chatId: null, source: "server", level: "log",
      text: "late",
    }]);

    initialise(ws);
    await ws.impl.deliverGadgetLogs(null, [logEvent("log", "second life")], GADGET_ID);
    expect(consoleLogId(ws)).not.toBe(earlier);
    expect(texts(await ws.impl.listConsoleLogs())).toStrictEqual(["second life"]);
  }));
});
