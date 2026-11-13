// The Overseer as the one writer of its workspace's gadget error log: the exceptions the runtime
// reports for a gadget's Worker and the errors of the calls to a gadget that failed are kept in
// the workspace's log object and listed back (OverseerImpl.deliverGadgetExceptions(),
// #recordGadgetException() and readGadgetErrors()), console calls are kept at no level, live
// subscribers get what they get without the log, and deleting the workspace deletes the log
// object before the workspace's own storage.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding) keeping entries in the real
// log object it reaches through ctx.exports, read back through the TEST_WORKSPACE_ERROR_LOG
// binding. Gadgets are real facets loaded from real commits. User DOs are fakes, and so is the log
// namespace where a test makes it fail.

import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  MAX_GADGET_ERROR_TEXT_LENGTH,
  type AiChatAuthorInfo, type CodeChangeSubmission, type ConsoleLogEvent,
  type GadgetErrorEntry, type GadgetErrorQuery,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { GADGET_ERRORS_PER_MINUTE } from "../src/gadget-error-log.js";
import { GadgetTailLoopback, type OverseerDurableObject } from "../src/overseer.js";
import type { WorkspaceErrorLogDurableObject } from "../src/workspace-error-log.js";
import { openFakeOverseer } from "./fixtures.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_WORKSPACE_ERROR_LOG: DurableObjectNamespace<WorkspaceErrorLogDurableObject>;
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
  let stub = env.TEST_OVERSEER.getByName(`gadget-error-history-${crypto.randomUUID()}`);
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

// A gadget's server: methods that log, that throw at their caller and that leave an exception to
// the runtime, objects it returns and stores, and an export handler that leaves one too.
function serverJs(prefix = ""): string {
  return `
import { DurableObject, RpcTarget, WorkerEntrypoint, restore } from "cloudflare:workers";

class Callback extends RpcTarget {
  fail() {
    throw new Error("cb boom");
  }
}

class Session extends RpcTarget {
  fail() {
    throw new Error("session boom");
  }
}

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

  async slow() {
    await scheduler.wait(1500);
    return "done";
  }

  later() {
    this.ctx.waitUntil(Promise.reject(new Error("${prefix}late")));
    return "ok";
  }

  mint() {
    return this.ctx.restore({ type: "callback" });
  }

  [restore]() {
    return new Callback();
  }

  open() {
    return new Session();
  }

  hand(sink) {
    return sink(new Session());
  }
}

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(gadget) {
    this.ctx.waitUntil(Promise.reject(new Error("formats failed")));
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

// Commits `files` and makes them gadget `id`'s mainline: serverJs() for GADGET_ID unless a case
// names its own. Returns the commit.
async function addGadget(ws: Workspace, id = GADGET_ID,
                         files: Record<string, string> = { "server.js": serverJs() })
    : Promise<string> {
  let commitId = await ws.impl.gitCache.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents: [],
    author: { name: "Alice", email: "alice@example.com" },
    message: "test commit",
    timestamp: CREATED,
  });
  ws.impl.storage.gadgets.put({
    type: "gadget", id, title: `G${id}`, created: new Date(0), bindingName: `G${id}`,
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

// An exception as the Overseer is handed one to keep: one string, in the shape of a console event.
function thrown(text: string, timestamp = new Date()): ConsoleLogEvent {
  return { timestamp, level: "error", message: [text] };
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

function errorLogId(ws: Workspace): string | undefined {
  return ws.impl.storage.errorLogId.get();
}

// Hands the workspace `events` as the tail of a gadget Worker that it loaded does: with the name
// of the workspace's log object, which the workspace gives the tail when it loads the Worker.
function deliver(ws: Workspace, chatId: number | null, events: ConsoleLogEvent[],
                 gadgetId = GADGET_ID): Promise<void> {
  return ws.impl.deliverGadgetExceptions(chatId, events, gadgetId, ws.impl.errorLogName());
}

// The keys of everything the workspace stores: none once its deletion has run to its end.
function storageKeys(ws: Workspace): string[] {
  return [...ws.state.storage.kv.list()].map(([key]) => key);
}

// Every entry the log object named `name` lists for `query`, newest first, read from the object
// itself and not through the Overseer.
async function keptIn(name: string, query: GadgetErrorQuery = {}): Promise<GadgetErrorEntry[]> {
  let entries: GadgetErrorEntry[] = [];
  let cursor: string | undefined;
  do {
    let page = await env.TEST_WORKSPACE_ERROR_LOG.getByName(name).list({
      ...query, ...(cursor !== undefined && { cursor }),
    });
    entries.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return entries;
}

// The same for the workspace's own log object; nothing while the workspace has named none.
async function kept(ws: Workspace, query: GadgetErrorQuery = {}): Promise<GadgetErrorEntry[]> {
  let name = errorLogId(ws);
  return name === undefined ? [] : keptIn(name, query);
}

// Whether the log object named `name` holds its schema. (In local workerd an object also holds a
// table of the harness, so the schema's own table is what is looked for.)
function hasLogTable(name: string): Promise<boolean> {
  return runInDurableObject(env.TEST_WORKSPACE_ERROR_LOG.getByName(name), (_log, state) =>
      state.storage.sql.exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gadget_errors'")
          .toArray().length > 0);
}

function logAlarm(name: string): Promise<number | null> {
  return runInDurableObject(env.TEST_WORKSPACE_ERROR_LOG.getByName(name), (_log, state) =>
      state.storage.getAlarm());
}

function texts(page: { entries: GadgetErrorEntry[] }): string[] {
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

// The warnings written with `event`, as [message, fields] pairs.
function warnings(warn: { mock: { calls: unknown[][] } }, event: string): unknown[][] {
  return warn.mock.calls.filter(([, fields]) => (fields as { event?: string })?.event === event);
}

// Everything the logger was passed, as one string: the caught errors with their messages.
function logged(warn: { mock: { calls: unknown[][] } }): string {
  return JSON.stringify(warn.mock.calls, (_key, value) =>
      value instanceof Error ? `${value.name}: ${value.message}` : value);
}

// What the Overseer warns with when it could not keep a gadget's exceptions.
const RECORD_FAILED = "gadget.error.record.failed";

describe("a gadget Worker's exceptions", () => {
  it("are kept as server entries, under the chat given only if it pins the gadget, and are " +
      "told to no live subscriber", () => withWorkspace(async ws => {
    initialise(ws);
    let commit = await addGadget(ws);
    addChat(ws, 1);
    await addDraft(ws, 2, commit);
    let events = await subscribe(ws);
    let long = "word ".repeat(700);
    let first = thrown("Error: late\n    at Gadget.later (server.js:8:48)",
        new Date(1700000001_000));
    let keyed = thrown("Error: key sk-live0123456789abcdefghij", new Date(1700000002_000));

    // The chat that pins the gadget, then one that proposes no change to it, one that does not
    // exist and none: the last three ran the mainline's code.
    await deliver(ws, 2, [first, keyed, thrown(long, new Date(1700000003_000))]);
    await deliver(ws, 1, [thrown("under a chat with no draft")]);
    await deliver(ws, 99, [thrown("under a chat that is gone")]);
    await deliver(ws, null, [thrown("under none")]);

    let entries = await kept(ws);
    expect(entries.map(({ chatId, text }) => ({ chatId, text }))).toStrictEqual([
      { chatId: null, text: "under none" },
      { chatId: null, text: "under a chat that is gone" },
      { chatId: null, text: "under a chat with no draft" },
      { chatId: 2, text: `${long.slice(0, MAX_GADGET_ERROR_TEXT_LENGTH - 1)}…` },
      { chatId: 2, text: "Error: key [redacted]" },
      { chatId: 2, text: "Error: late\n    at Gadget.later (server.js:8:48)" },
    ]);
    expect(entries.at(-1)).toStrictEqual({
      time: first.timestamp, gadgetId: GADGET_ID, chatId: 2, source: "server",
      text: "Error: late\n    at Gadget.later (server.js:8:48)",
    });
    for (let entry of entries) {
      expect(entry).toMatchObject({ gadgetId: GADGET_ID, source: "server" });
      expect(entry).not.toHaveProperty("userId");
      expect(entry).not.toHaveProperty("level");
    }
    // Live delivery is the tail's other call (deliverGadgetLogs()): keeping tells nobody.
    expect(events).toStrictEqual([]);
  }));

  it("names the log object the first time it is asked for, and each workspace names its own",
      async () => {
    let names: string[] = [];
    for (let i = 0; i < 2; i++) {
      await withWorkspace(async ws => {
        initialise(ws);
        expect(errorLogId(ws)).toBeUndefined();
        await deliver(ws, null, [thrown("first")]);
        let name = errorLogId(ws)!;
        expect(name).toMatch(/^[0-9a-f-]{36}$/);
        expect(name).not.toBe(ws.state.id.toString());

        await deliver(ws, null, [thrown("second")]);
        expect(errorLogId(ws)).toBe(name);
        expect(ws.impl.errorLogName()).toBe(name);
        expect(texts({ entries: await keptIn(name) })).toStrictEqual(["second", "first"]);
        names.push(name);
      });
    }
    expect(names[0]).not.toBe(names[1]);
  });

  it("keeps nothing in a workspace that is uninitialised or being deleted, and asks no log object",
      () => withWorkspace(async ws => {
    let warn = vi.spyOn(ws.impl.logger, "warn");
    let real = ws.impl.workspaceErrorLogs;
    let logs = unreachableLogs();

    // An uninitialised workspace has no name to give a Worker's tail: whatever one carries, it
    // is not this workspace's.
    ws.impl.workspaceErrorLogs = logs;
    expect(ws.impl.errorLogName()).toBeUndefined();
    await ws.impl.deliverGadgetExceptions(null, [thrown("too early")], GADGET_ID, "any-name");
    expect(errorLogId(ws)).toBeUndefined();

    ws.impl.workspaceErrorLogs = real;
    initialise(ws);
    await deliver(ws, null, [thrown("kept")]);
    let name = errorLogId(ws)!;

    // A Worker loaded before the deletion began: its tail names the workspace's log object.
    ws.impl.beginDeletion(new Set());
    ws.impl.workspaceErrorLogs = logs;
    expect(ws.impl.errorLogName()).toBeUndefined();
    await ws.impl.deliverGadgetExceptions(null, [thrown("too late")], GADGET_ID, name);
    expect(logs.getByName).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(texts({ entries: await keptIn(name) })).toStrictEqual(["kept"]);

    // The deletion runs to its end, so that the workspace leaves no alarm retrying it.
    ws.impl.workspaceErrorLogs = real;
    await ws.impl.deliverUserUpdates();
    expect(storageKeys(ws)).toStrictEqual([]);
  }));

  it("keeps nothing of a trace whose Worker another workspace loaded",
      () => withWorkspace(async ws => {
    initialise(ws);
    let name = ws.impl.errorLogName();
    let real = ws.impl.workspaceErrorLogs;
    let logs = unreachableLogs();
    ws.impl.workspaceErrorLogs = logs;

    // A request of an earlier workspace under this id, whose Worker's tail names that workspace's
    // log object. It throws after this workspace was initialised, under a gadget id this
    // workspace has too.
    let stale = [thrown("thrown by an earlier workspace's gadget")];
    await ws.impl.deliverGadgetExceptions(null, stale, GADGET_ID, crypto.randomUUID());
    await ws.instance.deliverGadgetExceptions(null, stale, GADGET_ID, crypto.randomUUID());
    expect(logs.getByName).not.toHaveBeenCalled();

    // A request of a Worker this workspace loaded, through the call the tail makes.
    ws.impl.workspaceErrorLogs = real;
    await ws.instance.deliverGadgetExceptions(null, [thrown("its own")], GADGET_ID, name);
    expect(texts(await ws.impl.readGadgetErrors())).toStrictEqual(["its own"]);
    expect(errorLogId(ws)).toBe(name);
  }));

  it("keeps nothing of an empty batch: no log object is asked", () => withWorkspace(async ws => {
    initialise(ws);
    let name = ws.impl.errorLogName();
    let warn = vi.spyOn(ws.impl.logger, "warn");
    let logs = unreachableLogs();
    ws.impl.workspaceErrorLogs = logs;

    await ws.impl.deliverGadgetExceptions(null, [], GADGET_ID, name);
    await ws.impl.deliverGadgetExceptions(7, [], GADGET_ID, name);

    expect(logs.getByName).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  }));

  it("does not reject when the append fails: one warning, with nothing of the entry in it",
      () => withWorkspace(async ws => {
    initialise(ws);
    let warn = vi.spyOn(ws.impl.logger, "warn");
    let failure = new Error("log object unavailable");
    ws.impl.workspaceErrorLogs = failingLogs(failure);

    let events = [thrown(`Error: ${MARKER} thrown`), thrown(`Error: ${MARKER} again`)];
    await expect(deliver(ws, null, events)).resolves.toBeUndefined();

    expect(warn.mock.calls).toStrictEqual([[
      "failed to keep a gadget's exceptions", { event: RECORD_FAILED, error: failure },
    ]]);
    expect(logged(warn)).not.toContain(MARKER);
  }));

  it("does not reject when the log namespace itself throws", () => withWorkspace(async ws => {
    initialise(ws);
    let warn = vi.spyOn(ws.impl.logger, "warn");
    let logs = unreachableLogs();
    ws.impl.workspaceErrorLogs = logs;

    await expect(deliver(ws, null, [thrown("x")])).resolves.toBeUndefined();
    expect(logs.getByName).toHaveBeenCalledTimes(1);
    expect(warnings(warn, RECORD_FAILED)).toHaveLength(1);
  }));

  it("outlive their gadget's deletion", () => withWorkspace(async ws => {
    initialise(ws);
    await addGadget(ws);
    await deliver(ws, null, [thrown("one"), thrown("two")]);

    await ws.impl.removeWorkpiece(GADGET_ID);
    expect(ws.impl.storage.gadgets.get(GADGET_ID)).toBeUndefined();

    expect(texts(await ws.impl.readGadgetErrors({ gadgetId: GADGET_ID })))
        .toStrictEqual(["two", "one"]);
    expect(texts(await ws.impl.readGadgetErrors())).toStrictEqual(["two", "one"]);

    // One reported for it afterwards is kept under no chat: a deleted gadget has no draft.
    await deliver(ws, 7, [thrown("three")]);
    expect((await ws.impl.readGadgetErrors({ gadgetId: GADGET_ID })).entries[0])
        .toMatchObject({ text: "three", chatId: null });
  }));

  it("are held to 30 a minute for one gadget, with a marker for the rest",
      () => withWorkspace(async ws => {
    initialise(ws);
    let batch = Array.from({ length: 40 }, (_, i) => thrown(`Error: thrown ${i}`));
    await deliver(ws, null, batch);

    // The marker is kept ahead of the errors it came with, and counts the ten after them.
    let entries = (await kept(ws)).toReversed();
    expect(texts({ entries })).toStrictEqual([
      "10 errors dropped",
      ...batch.slice(0, GADGET_ERRORS_PER_MINUTE).map(event => event.message[0]),
    ]);
    expect(entries[0]).toMatchObject({ gadgetId: GADGET_ID, chatId: null, source: "server" });
    expect(entries[0]).not.toHaveProperty("userId");

    // Another gadget's minute is its own.
    await deliver(ws, null, [thrown("Error: the other gadget's")], 2);
    expect(texts({ entries: await kept(ws, { gadgetId: 2 }) }))
        .toStrictEqual(["Error: the other gadget's"]);
  }));
});

const LEVELS = ["debug", "info", "log", "warn", "error"] as const;
// What each console call of the synthetic trace says: looked for in what is kept and logged.
const CONSOLE_CALL = "console call at";
const EXCEPTION = {
  timestamp: 3, name: "TypeError", message: "thrown", stack: "    at f (server.js:1:1)",
};
// The exception as it is kept: one string, with the name and the stack that the live event drops.
const KEPT_TEXT = "TypeError: thrown\n    at f (server.js:1:1)";

// A trace as the old-style tail is handed one, with a console call at each level. tail() reads
// only its logs and its exceptions.
function traceItem(exceptions: object[] = [EXCEPTION]): TraceItem {
  return {
    logs: LEVELS.map((level, i) =>
        ({ timestamp: 10 + i, level, message: [`${CONSOLE_CALL} ${level}`] })),
    exceptions,
  } as unknown as TraceItem;
}

// The live events of that trace's console calls.
const CONSOLE_EVENTS: ConsoleLogEvent[] = LEVELS.map((level, i) =>
    ({ timestamp: new Date(10 + i), level, message: [`${CONSOLE_CALL} ${level}`] }));
// The exception as live subscribers are told it, and as it is handed over to be kept.
const LIVE_EXCEPTION: ConsoleLogEvent =
    { timestamp: new Date(3), level: "error", message: ["thrown"] };
const KEPT_EXCEPTION: ConsoleLogEvent =
    { timestamp: new Date(3), level: "error", message: [KEPT_TEXT] };

const OVERSEER_ID = "overseer-id";
const ERROR_LOG_ID = "error-log-name";

// A workspace that records the two calls a tail makes on it.
function fakeOverseer() {
  return {
    deliverGadgetLogs: vi.fn(async (..._args: unknown[]) => {}),
    deliverGadgetExceptions: vi.fn(async (..._args: unknown[]) => {}),
  };
}

// The loopback of a Worker loaded with `props`, whose workspace is `overseer`.
function loopback(props: object, overseer: object) {
  let ns = { idFromString: (id: string) => id, get: () => overseer };
  return new GadgetTailLoopback(
      { props, exports: { OverseerDurableObject: ns } } as never, env);
}

describe("the tail of a gadget's Worker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the workspace everything live and only the exceptions to keep", async () => {
    let overseer = fakeOverseer();
    let props = { chatId: 2, gadgetId: GADGET_ID, overseerId: OVERSEER_ID,
                  errorLogId: ERROR_LOG_ID };
    await loopback(props, overseer).tail([traceItem()]);

    expect(overseer.deliverGadgetLogs.mock.calls)
        .toStrictEqual([[2, [...CONSOLE_EVENTS, LIVE_EXCEPTION]]]);
    // No console call is handed over to be kept, the one at the error level included.
    expect(overseer.deliverGadgetExceptions.mock.calls)
        .toStrictEqual([[2, [KEPT_EXCEPTION], GADGET_ID, ERROR_LOG_ID]]);
    expect(overseer.deliverGadgetLogs.mock.invocationCallOrder[0])
        .toBeLessThan(overseer.deliverGadgetExceptions.mock.invocationCallOrder[0]);
  });

  it("keeps the name and message alone for an exception with no stack", async () => {
    let overseer = fakeOverseer();
    let props = { gadgetId: GADGET_ID, overseerId: OVERSEER_ID, errorLogId: ERROR_LOG_ID };
    await loopback(props, overseer).tail([traceItem([
      { timestamp: 4, name: "Error", message: "bare" },
      { timestamp: 5, name: "Error", message: "bare", stack: "" },
    ])]);

    expect(overseer.deliverGadgetExceptions.mock.calls).toStrictEqual([[null, [
      { timestamp: new Date(4), level: "error", message: ["Error: bare"] },
      { timestamp: new Date(5), level: "error", message: ["Error: bare"] },
    ], GADGET_ID, ERROR_LOG_ID]]);
  });

  it("passes null for a Worker of the gadget's mainline, in both calls", async () => {
    let overseer = fakeOverseer();
    let props = { gadgetId: GADGET_ID, overseerId: OVERSEER_ID, errorLogId: ERROR_LOG_ID };
    await loopback(props, overseer).tail([traceItem()]);

    expect(overseer.deliverGadgetLogs.mock.calls[0][0]).toBeNull();
    expect(overseer.deliverGadgetExceptions.mock.calls[0][0]).toBeNull();
  });

  it("makes no second call for a trace that holds no exception", async () => {
    let overseer = fakeOverseer();
    let props = { gadgetId: GADGET_ID, overseerId: OVERSEER_ID, errorLogId: ERROR_LOG_ID };
    await loopback(props, overseer).tail([traceItem([])]);

    expect(overseer.deliverGadgetLogs.mock.calls).toStrictEqual([[null, CONSOLE_EVENTS]]);
    expect(overseer.deliverGadgetExceptions).not.toHaveBeenCalled();
  });

  it("makes no second call for a Worker loaded with no log object's name, and still delivers " +
      "live", async () => {
    let overseer = fakeOverseer();
    await loopback({ gadgetId: GADGET_ID, overseerId: OVERSEER_ID }, overseer)
        .tail([traceItem()]);

    expect(overseer.deliverGadgetLogs.mock.calls)
        .toStrictEqual([[null, [...CONSOLE_EVENTS, LIVE_EXCEPTION]]]);
    expect(overseer.deliverGadgetExceptions).not.toHaveBeenCalled();
  });

  it("does not fail the tail when the workspace refuses the exceptions", async () => {
    let overseer = fakeOverseer();
    // What an Overseer of a version with no such method answers.
    overseer.deliverGadgetExceptions.mockRejectedValue(
        new TypeError('The RPC receiver does not implement the method "deliverGadgetExceptions".'));
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let props = { gadgetId: GADGET_ID, overseerId: OVERSEER_ID, errorLogId: ERROR_LOG_ID };

    await expect(loopback(props, overseer).tail([traceItem()])).resolves.toBeUndefined();

    expect(overseer.deliverGadgetLogs).toHaveBeenCalledTimes(1);
    let events = warn.mock.calls.map(([entry]) => (entry as { event?: unknown })?.event);
    expect(events).toStrictEqual(["gadget.error.deliver.failed"]);
    // Nothing of the trace is logged: neither what was thrown nor what a console call said.
    let written = JSON.stringify(warn.mock.calls);
    expect(written).not.toContain("thrown");
    expect(written).not.toContain(CONSOLE_CALL);
  });

  it("still rejects when the live delivery does, and then asks nothing to be kept", async () => {
    let overseer = fakeOverseer();
    overseer.deliverGadgetLogs.mockRejectedValue(new Error("workspace unavailable"));
    let props = { gadgetId: GADGET_ID, overseerId: OVERSEER_ID, errorLogId: ERROR_LOG_ID };

    await expect(loopback(props, overseer).tail([traceItem()]))
        .rejects.toThrow("workspace unavailable");
    expect(overseer.deliverGadgetExceptions).not.toHaveBeenCalled();
  });

  it("splits a streamed trace the same way", async () => {
    let overseer = fakeOverseer();
    let props = { chatId: 2, gadgetId: GADGET_ID, overseerId: OVERSEER_ID,
                  errorLogId: ERROR_LOG_ID };
    let handlers: any = await loopback(props, overseer).tailStream({} as never);

    await handlers.log({ timestamp: new Date(10), event: { level: "error", message: ["said"] } });
    expect(overseer.deliverGadgetLogs.mock.calls)
        .toStrictEqual([[2, [{ timestamp: new Date(10), level: "error", message: ["said"] }]]]);
    expect(overseer.deliverGadgetExceptions).not.toHaveBeenCalled();

    let { timestamp, ...exception } = EXCEPTION;
    await handlers.exception({ timestamp: new Date(timestamp), event: exception });
    // The live event carries the message and the stack apart, the kept copy is one string.
    expect(overseer.deliverGadgetLogs.mock.calls[1]).toStrictEqual([2, [{
      timestamp: new Date(3), level: "error", message: ["thrown", "    at f (server.js:1:1)"],
    }]]);
    expect(overseer.deliverGadgetExceptions.mock.calls)
        .toStrictEqual([[2, [KEPT_EXCEPTION], GADGET_ID, ERROR_LOG_ID]]);
  });
});

// Gives the synthetic trace to the loopback the workspace mints for a Worker it loads for
// `chatId`, which carries `name` as the name of the log object.
function tail(ws: Workspace, chatId: number | undefined, name: string): Promise<void> {
  return ws.impl.ctx.exports.GadgetTailLoopback({
    props: { chatId, gadgetId: GADGET_ID, overseerId: ws.state.id.toString(), errorLogId: name },
  }).tail([traceItem()]);
}

describe("a trace through the workspace's own tail", () => {
  it("tells live subscribers every event and keeps the exception alone, under the chat only " +
      "if it pins the gadget", () => withWorkspace(async ws => {
    initialise(ws);
    let commit = await addGadget(ws);
    addChat(ws, 1);
    await addDraft(ws, 2, commit);
    let events = await subscribe(ws);
    let name = ws.impl.errorLogName();

    // The mainline's Worker, the Worker of a chat that pins the gadget, and one loaded for a
    // chat that proposes no change to it (an export asked for under that chat).
    await tail(ws, undefined, name);
    await tail(ws, 2, name);
    await tail(ws, 1, name);

    // Subscribers are told each batch whole, under the chat its tail carries.
    let batch = [...CONSOLE_EVENTS, LIVE_EXCEPTION];
    expect(events).toStrictEqual([
      { chatId: null, logs: batch }, { chatId: 2, logs: batch }, { chatId: 1, logs: batch },
    ]);

    let { entries } = await ws.impl.readGadgetErrors();
    expect(entries).toStrictEqual([null, 2, null].map(chatId => ({
      time: new Date(3), gadgetId: GADGET_ID, chatId, source: "server", text: KEPT_TEXT,
    })));
    // No console call is kept, at any of the five levels.
    expect(texts({ entries }).join("\n")).not.toContain(CONSOLE_CALL);
  }));

  it("tells a trace of another workspace's Worker live and keeps nothing of it",
      () => withWorkspace(async ws => {
    initialise(ws);
    let events = await subscribe(ws);
    ws.impl.errorLogName();
    let real = ws.impl.workspaceErrorLogs;
    let logs = unreachableLogs();
    ws.impl.workspaceErrorLogs = logs;

    await tail(ws, undefined, crypto.randomUUID());

    expect(events).toStrictEqual([{ chatId: null, logs: [...CONSOLE_EVENTS, LIVE_EXCEPTION] }]);
    expect(logs.getByName).not.toHaveBeenCalled();
    ws.impl.workspaceErrorLogs = real;
    expect(await ws.impl.readGadgetErrors()).toStrictEqual({ entries: [] });
  }));
});

// What a poll for a kept entry waits at most: a trace is delivered after its call has ended, and
// an exception's entry is kept without the call waiting for it.
const KEPT_SOON = { timeout: 5_000, interval: 50 };
// The timeout of a test that runs a real gadget and polls for what it kept, several times over.
const GADGET_TEST_MS = 30_000;
// How long a case waits before it asserts that nothing more was kept or told live: a late trace
// would have arrived by then.
const NO_LATER_TRACE_MS = 2_000;
const noLaterTrace = () => new Promise(resolve => setTimeout(resolve, NO_LATER_TRACE_MS));

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
// ends, since the proxy names the method that was called.
async function failEntries(ws: Workspace, gadgetId = GADGET_ID): Promise<GadgetErrorEntry[]> {
  return (await kept(ws, { gadgetId })).filter(entry => entry.text.endsWith("at fail()"));
}

// Calls `count` methods the gadget does not have, each named by its caller, and returns what the
// caller chose.
async function failCalls(gadget: any, count: number, from = 0): Promise<string[]> {
  let names = Array.from({ length: count }, (_, i) => `forged_${from + i}`);
  for (let name of names) await rejection(gadget[name]());
  return names;
}

// The entries kept for those calls and the markers of the errors dropped, each oldest first.
const keptForged = async (ws: Workspace, gadgetId = GADGET_ID) =>
  (await kept(ws, { gadgetId }))
      .filter(entry => /at forged_\d+\(\)$/.test(entry.text)).toReversed();
const dropMarkers = async (ws: Workspace, gadgetId = GADGET_ID) =>
  (await kept(ws, { gadgetId }))
      .filter(entry => /^\d+ errors? dropped$/.test(entry.text)).toReversed();

// A trace's exceptions as the Overseer is handed them, `count` of them.
function trace(count: number): ConsoleLogEvent[] {
  return Array.from({ length: count }, (_, i) => thrown(`Error: reported ${i}`));
}

// What live subscribers were told, one string for each event's first value.
function told(events: LiveEvent[]): string[] {
  return events.flatMap(event => event.logs).map(log => String(log.message[0]));
}

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
      expect(entry).toMatchObject({ gadgetId: GADGET_ID, chatId: null, source: "server" });
      expect(entry.text).toBe("Error: boom\n    at fail()");
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

  it("is kept under no chat from a stub of the mainline, though the chat it was asked under " +
      "has come to pin the gadget", () => withWorkspace(async ws => {
    initialise(ws);
    let commit = await addGadget(ws);
    addChat(ws, 2);
    using gadget = await ws.impl.getGadgetFacet(GADGET_ID, 2);

    // The chat proposes a change to the gadget once the stub is out. The stub still reaches the
    // mainline's facet, so the error is the mainline's and is kept as that.
    await addDraft(ws, 2, commit);
    let error = await rejection(gadget.fail());
    expect(error).toContain("boom");
    expect(error).not.toContain("draft boom");
    await vi.waitFor(async () => expect(await failEntries(ws)).toHaveLength(1), KEPT_SOON);
    expect((await failEntries(ws))[0])
        .toMatchObject({ chatId: null, text: "Error: boom\n    at fail()" });

    // A stub asked for under the chat from here on runs its draft.
    using draft = await ws.impl.getGadgetFacet(GADGET_ID, 2);
    expect(await rejection(draft.fail())).toContain("draft boom");
    await vi.waitFor(async () => expect(await failEntries(ws)).toHaveLength(2), KEPT_SOON);
    expect((await failEntries(ws)).map(entry => entry.chatId)).toStrictEqual([2, null]);
  }), GADGET_TEST_MS);

  it("is kept redacted, in the error the gadget threw and in the method its caller named",
      () => withWorkspace(async ws => {
    initialise(ws);
    await addGadget(ws);
    let events = await subscribe(ws);
    let key = "sk-live0123456789abcdefghij";
    let leaked = "Error: GET https://api.example/v1?access_token=abc123 failed\n    at leak()";

    // The error's text is the gadget's choice, and the method named is its caller's.
    using gadget = await ws.impl.getGadgetFacet(GADGET_ID);
    expect(await rejection(gadget.leak())).toContain("access_token=abc123");
    await rejection(gadget[key]());

    // The proxy's entries, newest first, found by how they end: a redacted name leaves that.
    let caught = async () =>
      texts({ entries: await kept(ws, { gadgetId: GADGET_ID }) })
          .filter(text => text.endsWith("()"));
    await vi.waitFor(async () => expect(await caught()).toHaveLength(2), KEPT_SOON);
    expect(await caught()).toStrictEqual([
      expect.stringMatching(/at \[redacted\]\(\)$/),
      leaked.replace("abc123", "[redacted]"),
    ]);
    expect((await caught()).join("\n")).not.toContain(key);

    // A subscriber is told each whole: only what is kept is redacted.
    expect(told(events)).toContain(leaked);
    expect(told(events)).toContainEqual(expect.stringContaining(`at ${key}()`));
  }), GADGET_TEST_MS);

  it("reaches the gadget's caller as the gadget's own error when its append fails",
      () => withWorkspace(async ws => {
    initialise(ws);
    await addGadget(ws);
    let warn = vi.spyOn(ws.impl.logger, "warn");
    ws.impl.workspaceErrorLogs = failingLogs(new Error("log object unavailable"));

    using gadget = await ws.impl.getGadgetFacet(GADGET_ID);
    let message = await rejection(gadget.fail());
    expect(message).toContain("boom");
    expect(message).not.toContain("log object unavailable");

    await vi.waitFor(() => expect(warnings(warn, RECORD_FAILED)).toHaveLength(1), KEPT_SOON);
    expect(logged(warn)).not.toContain("boom");
  }), GADGET_TEST_MS);

  it("holds a gadget to 30 a minute, whichever methods its callers name, and marks the rest",
      () => withWorkspace(async ws => {
    initialise(ws);
    await addGadget(ws);
    let events = await subscribe(ws);
    let start = Date.now();
    let now = vi.spyOn(Date, "now").mockReturnValue(start);

    using gadget = await ws.impl.getGadgetFacet(GADGET_ID);
    let names = await failCalls(gadget, 100);

    // The first 30 are kept, and one marker for the call that was dropped first.
    await vi.waitFor(async () => {
      expect(await keptForged(ws)).toHaveLength(GADGET_ERRORS_PER_MINUTE);
      expect(await dropMarkers(ws)).toHaveLength(1);
    }, KEPT_SOON);
    expect((await keptForged(ws)).map(entry => entry.text.split("at ").at(-1)))
        .toStrictEqual(names.slice(0, 30).map(name => `${name}()`));
    let [marker] = await dropMarkers(ws);
    expect(marker).toMatchObject({ gadgetId: GADGET_ID, chatId: null, source: "server",
                                   text: "1 error dropped" });
    expect(marker).not.toHaveProperty("userId");

    // The gadget's next minute: the marker of its first kept call counts the other 69.
    now.mockReturnValue(start + 60_000);
    await failCalls(gadget, 1, 100);
    await vi.waitFor(async () => expect(await keptForged(ws)).toHaveLength(31), KEPT_SOON);
    expect(texts({ entries: await dropMarkers(ws) }))
        .toStrictEqual(["1 error dropped", "69 errors dropped"]);
    // What is said of the drops is kept before the call that brought it.
    expect(texts({ entries: (await kept(ws, { gadgetId: GADGET_ID })).slice(0, 2) }))
        .toStrictEqual([expect.stringMatching(/at forged_100\(\)$/), "69 errors dropped"]);

    // A subscriber is told every one of them.
    expect(told(events).filter(text => /at forged_\d+\(\)$/.test(text))).toHaveLength(101);
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
    let real = ws.impl.workspaceErrorLogs;
    ws.impl.workspaceErrorLogs = failingLogs(new Error("log object unavailable"));
    await failCalls(gadget, 3, 30);
    await vi.waitFor(() => expect(warnings(warn, RECORD_FAILED)).toHaveLength(1), KEPT_SOON);
    ws.impl.workspaceErrorLogs = real;

    now.mockReturnValue(start + 60_000);
    await failCalls(gadget, 1, 33);
    await vi.waitFor(async () => expect(await keptForged(ws)).toHaveLength(31), KEPT_SOON);
    expect(texts({ entries: await dropMarkers(ws) })).toStrictEqual(["3 errors dropped"]);
  }), GADGET_TEST_MS);

  it("failed calls do not use up the minute of the gadget's own exceptions, nor the reverse",
      () => withWorkspace(async ws => {
    initialise(ws);
    await addGadget(ws);
    await addGadget(ws, 2);
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    let traced = async (gadgetId: number) =>
        (await kept(ws, { gadgetId })).filter(entry => entry.text.startsWith("Error: reported"));

    // Failed calls past their limit, then a trace of the same minute, which is kept whole.
    using gadget = await ws.impl.getGadgetFacet(GADGET_ID);
    await failCalls(gadget, 35);
    await vi.waitFor(async () => {
      expect(await keptForged(ws)).toHaveLength(30);
      expect(await dropMarkers(ws)).toHaveLength(1);
    }, KEPT_SOON);
    await deliver(ws, null, trace(30));
    expect(await traced(GADGET_ID)).toHaveLength(30);
    expect(await kept(ws, { gadgetId: GADGET_ID })).toHaveLength(61);
    expect(texts({ entries: await dropMarkers(ws) })).toStrictEqual(["1 error dropped"]);

    // The other way round, on a gadget of its own: a trace past its limit, then failed calls.
    await deliver(ws, null, trace(35), 2);
    expect(await traced(2)).toHaveLength(30);
    expect(texts({ entries: await dropMarkers(ws, 2) })).toStrictEqual(["5 errors dropped"]);
    using other = await ws.impl.getGadgetFacet(2);
    await failCalls(other, 30);
    await vi.waitFor(async () => expect(await keptForged(ws, 2)).toHaveLength(30), KEPT_SOON);
    expect(await kept(ws, { gadgetId: 2 })).toHaveLength(61);
    expect(texts({ entries: await dropMarkers(ws, 2) })).toStrictEqual(["5 errors dropped"]);
  }), GADGET_TEST_MS);

  it("does not resolve the chat of an error it drops", () => withWorkspace(async ws => {
    initialise(ws);
    await addDraft(ws, 2, await addGadget(ws));
    vi.spyOn(Date, "now").mockReturnValue(Date.now());

    // The stub of a chat's draft: each error that is kept reads the chat, to find whether it
    // still proposes a change to the gadget. The first call starts the draft's facet, which
    // reads the chat for itself, so the reads are counted from the second.
    using gadget = await ws.impl.getGadgetFacet(GADGET_ID, 2);
    await failCalls(gadget, 1);
    let read = vi.spyOn(ws.impl.storage.chatMeta, "get");
    let resolved = () => read.mock.calls.filter(([chatId]) => chatId === 2).length;

    // The rest of the minute's 30 errors, and the marker that the first drop brings.
    await failCalls(gadget, 30, 1);
    await vi.waitFor(async () => {
      expect(await keptForged(ws)).toHaveLength(30);
      expect(await dropMarkers(ws)).toHaveLength(1);
    }, KEPT_SOON);
    expect(resolved()).toBe(30);

    // The limiter is asked before the call's promise rejects, so nothing is still to come.
    await failCalls(gadget, 20, 31);
    expect(resolved()).toBe(30);
    expect(await kept(ws)).toHaveLength(31);
  }), GADGET_TEST_MS);
});

// The error of a call is kept whoever raised it. Each case waits out a late trace, which would
// show as a second entry: the runtime reports none of these to the tail.
describe("the Workshop's own failure of a call to a gadget", () => {
  it("keeps the error of a call to a method the gadget does not have",
      () => withWorkspace(async ws => {
    initialise(ws);
    await addGadget(ws);
    let events = await subscribe(ws);

    using gadget = await ws.impl.getGadgetFacet(GADGET_ID);
    expect(await rejection(gadget.nosuch())).toContain("does not implement the method");
    await vi.waitFor(async () => expect(await kept(ws)).toHaveLength(1), KEPT_SOON);

    await noLaterTrace();
    let entries = await kept(ws);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ gadgetId: GADGET_ID, chatId: null, source: "server" });
    expect(entries[0].text).toMatch(/does not implement the method "nosuch"\.\n    at nosuch\(\)$/);
    expect(told(events)).toStrictEqual([entries[0].text]);
  }), GADGET_TEST_MS);

  it("keeps one entry for a call in flight when a draft switch restarts the gadget",
      () => withWorkspace(async ws => {
    initialise(ws);
    let commit = await addGadget(ws);
    await addDraft(ws, 2, commit);
    let restarted = "Gadget restarted to test proposed changes.";

    using gadget = await ws.impl.getGadgetFacet(GADGET_ID);
    // The mainline's Worker is running before the call that is to be caught in flight.
    expect(await gadget.greet("Ada")).toBe("Ada");
    let events = await subscribe(ws);
    let slow = rejection(gadget.slow());
    await scheduler.wait(300);
    // Minting the stub of the chat's version restores that version, which aborts the one
    // running: no call on the stub is needed.
    using _draft = await ws.impl.getGadgetFacet(GADGET_ID, 2);
    expect(await slow).toContain(restarted);
    await vi.waitFor(async () => expect(await kept(ws)).toHaveLength(1), KEPT_SOON);

    await noLaterTrace();
    expect(await kept(ws)).toStrictEqual([{
      time: expect.any(Date), gadgetId: GADGET_ID, chatId: null, source: "server",
      text: `Error: ${restarted}\n    at slow()`,
    }]);
    expect(told(events).filter(text => text.includes(restarted))).toHaveLength(1);
  }), GADGET_TEST_MS);
});

// A gadget of its own for each case, beside none: the server each names.
const OTHER_GADGET_ID = 2;

describe("where the failed call and the runtime's report meet", () => {
  it("keeps a constructor's throw by both paths", () => withWorkspace(async ws => {
    initialise(ws);
    await addGadget(ws, OTHER_GADGET_ID, { "server.js": `
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    throw new Error("ctor boom");
  }

  hello() {
    return "hi";
  }
}
` });
    let texted = async () => texts({ entries: await kept(ws, { gadgetId: OTHER_GADGET_ID }) });
    let failedCall = "Error: ctor boom\n    at hello()";

    // The call that starts the gadget runs its constructor, whose throw fails the call and is
    // reported by the runtime for the request as well. Nothing tells the two apart, so both are
    // kept.
    using gadget = await ws.impl.getGadgetFacet(OTHER_GADGET_ID);
    expect(await rejection(gadget.hello())).toContain("ctor boom");
    await vi.waitFor(async () => expect(await texted()).toHaveLength(2), KEPT_SOON);

    // A later call on the same stub fails with the same error and runs no constructor: the
    // runtime has nothing to report for it.
    expect(await rejection(gadget.hello())).toContain("ctor boom");
    await vi.waitFor(async () => expect(await texted()).toHaveLength(3), KEPT_SOON);

    // A stub minted afterwards starts the gadget again.
    using again = await ws.impl.getGadgetFacet(OTHER_GADGET_ID);
    expect(await rejection(again.hello())).toContain("ctor boom");
    await vi.waitFor(async () => expect(await texted()).toHaveLength(5), KEPT_SOON);

    await noLaterTrace();
    let all = await texted();
    expect(all.filter(text => text === failedCall)).toHaveLength(3);
    let byRuntime = all.filter(text => text !== failedCall);
    expect(byRuntime).toHaveLength(2);
    for (let text of byRuntime) expect(text).toMatch(/^Error: ctor boom\n\s+at new Gadget /);
  }), GADGET_TEST_MS);

  it("keeps a module that fails to load once for each call", () => withWorkspace(async ws => {
    initialise(ws);
    await addGadget(ws, OTHER_GADGET_ID, { "server.js": `
import { DurableObject } from "cloudflare:workers";

throw new Error("module boom");

export class Gadget extends DurableObject {
  hello() {
    return "hi";
  }
}
` });
    using gadget = await ws.impl.getGadgetFacet(OTHER_GADGET_ID);
    expect(await rejection(gadget.hello())).toContain("Failed to start Worker");
    await vi.waitFor(async () => expect(await kept(ws)).toHaveLength(1), KEPT_SOON);

    await noLaterTrace();
    let entries = await kept(ws);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject(
        { gadgetId: OTHER_GADGET_ID, chatId: null, source: "server" });
    expect(entries[0].text).toContain("module boom");
    expect(entries[0].text).toMatch(/at hello\(\)$/);
  }), GADGET_TEST_MS);

  it("keeps the error of a call an ExportHandler makes on the gadget",
      () => withWorkspace(async ws => {
    initialise(ws);
    await addGadget(ws, OTHER_GADGET_ID, { "server.js": `
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export class Gadget extends DurableObject {
  fail() {
    throw new Error("gadget boom");
  }
}

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(gadget) {
    return [{
      id: "csv", label: "CSV", mode: "server", contentType: "text/csv", fileExtension: ".csv",
    }];
  }

  async export(gadget, id) {
    await gadget.fail();
    return new Response("x").body;
  }
}
` });
    expect(await rejection(ws.impl.exportGadget(OTHER_GADGET_ID, "csv"))).toContain("gadget boom");

    // Found by how they end: the handler is handed the gadget's stub, whose calls pass the proxy.
    await vi.waitFor(async () => expect(await failEntries(ws, OTHER_GADGET_ID)).toHaveLength(1),
        KEPT_SOON);
    expect((await failEntries(ws, OTHER_GADGET_ID))[0]).toMatchObject({
      gadgetId: OTHER_GADGET_ID, chatId: null, source: "server",
      text: "Error: gadget boom\n    at fail()",
    });
  }), GADGET_TEST_MS);
});

describe("what the Workshop does not stand in the path of", () => {
  it("keeps nothing for a call that does not pass the facet proxy",
      () => withWorkspace(async ws => {
    initialise(ws);
    await addGadget(ws);
    let events = await subscribe(ws);
    using gadget = await ws.impl.getGadgetFacet(GADGET_ID);

    // A stored callback called directly: the runtime takes the call to the facet with no
    // Overseer code in between, and reports a method's throw to no tail.
    using callback = await gadget.mint();
    await ws.impl.ctx.storage.put("callback", callback);
    using restored = await ws.impl.ctx.storage.get("callback");
    expect(await rejection(restored.fail())).toContain("cb boom");

    // An object a method returned: the proxy catches the calls made on the gadget's stub and
    // hands their results on as they are, so its holder's calls reach it through the runtime
    // alone.
    using session = await gadget.open();
    expect(await rejection(session.fail())).toContain("session boom");

    // An object the gadget passed as an argument of a call it made: the proxy hands arguments
    // on as they are too. The call on it is made while its stub lives.
    let handed: string | undefined;
    await gadget.hand(async (passed: any) => { handed = await rejection(passed.fail()); });
    expect(handed).toContain("session boom");

    await noLaterTrace();
    expect(await ws.impl.readGadgetErrors()).toStrictEqual({ entries: [] });
    // Live delivery has the same gaps.
    expect(events).toStrictEqual([]);
  }), GADGET_TEST_MS);
});

// The entries the tail kept for an exception whose message is `message`, newest first.
async function reported(ws: Workspace, message: string): Promise<GadgetErrorEntry[]> {
  return (await kept(ws)).filter(entry => entry.text.startsWith(`Error: ${message}`));
}

// The runtime reports to the tail what a gadget's code throws outside the result of a call. The
// form these cases rely on is a rejected ctx.waitUntil() promise, in the gadget's Durable Object
// (later()) and in its export handler (getExportFormats()). A method's own throw is not reported
// there, and neither is a rejection that nothing handles.
describe("a gadget Worker's trace", () => {
  it("is kept under the chat its tail carries, if that chat pins the gadget",
      () => withWorkspace(async ws => {
    initialise(ws);
    let commit = await addGadget(ws);
    addChat(ws, 1);
    await addDraft(ws, 2, commit);
    let events = await subscribe(ws);

    // The mainline's facet.
    {
      using gadget = await ws.impl.getGadgetFacet(GADGET_ID);
      expect(await gadget.greet("Ada")).toBe("Ada");
      expect(await gadget.later()).toBe("ok");
    }
    await vi.waitFor(async () => expect(await reported(ws, "late")).toHaveLength(1), KEPT_SOON);
    let [mainline] = await reported(ws, "late");
    expect(mainline).toMatchObject({ gadgetId: GADGET_ID, chatId: null, source: "server" });
    // The name and the message, then the trace's stack.
    expect(mainline.text).toMatch(/^Error: late\n\s+at /);

    // The facet of the chat that pins the gadget.
    {
      using gadget = await ws.impl.getGadgetFacet(GADGET_ID, 2);
      expect(await gadget.later()).toBe("ok");
    }
    await vi.waitFor(async () => expect(await reported(ws, "draft late")).toHaveLength(1),
        KEPT_SOON);
    expect((await reported(ws, "draft late"))[0]).toMatchObject({ chatId: 2, source: "server" });

    // The export handler's Worker is loaded for the chat the export was asked under. An export
    // under the chat that pins the gadget is kept under it, and one under a chat that proposes
    // no change to the gadget under none, though that Worker's tail carries the chat.
    let formats = async () => (await reported(ws, "formats failed")).map(entry => entry.chatId);
    expect(await ws.impl.getGadgetExportFormats(GADGET_ID, 2)).toMatchObject([{ id: "txt" }]);
    await vi.waitFor(async () => expect(await formats()).toStrictEqual([2]), KEPT_SOON);
    expect(await ws.impl.getGadgetExportFormats(GADGET_ID, 1)).toMatchObject([{ id: "txt" }]);
    await vi.waitFor(async () => expect(await formats()).toStrictEqual([null, 2]), KEPT_SOON);

    // A subscriber is told each exception by its message alone, under the chat of its tail, and
    // the console call, which is not kept.
    let live = (message: string) => events
        .filter(event => event.logs.some(log => log.message[0] === message))
        .map(event => event.chatId);
    expect(live("late")).toStrictEqual([null]);
    expect(live("draft late")).toStrictEqual([2]);
    expect(live("formats failed")).toStrictEqual([2, 1]);
    expect(live("hello")).toStrictEqual([null]);
    expect(texts({ entries: await kept(ws) }).join("\n")).not.toContain("hello");
    expect(await kept(ws)).toHaveLength(4);
  }), GADGET_TEST_MS);

  it("is not kept by the workspace its id names once the one that loaded its Worker is deleted",
      () => withWorkspace(async ws => {
    initialise(ws);
    await addGadget(ws);
    // An export handler is a stateless entrypoint of the gadget's Worker, which the restart that
    // follows a deletion does not end, and which can throw for as long as a task of it runs.
    let handler = ws.impl.loadGadgetWorker(GADGET_ID).getEntrypoint("ExportHandler");
    await handler.getExportFormats(null);
    await vi.waitFor(async () => expect(await reported(ws, "formats failed")).toHaveLength(1),
        KEPT_SOON);

    beginDeletion(ws);
    await ws.impl.deliverUserUpdates();
    expect(storageKeys(ws)).toStrictEqual([]);

    // The id's next life, which has a log object of its own. The earlier life's Worker throws
    // after it began, and its trace reaches the workspace, whose subscribers are told.
    initialise(ws);
    await deliver(ws, null, [thrown("second life")]);
    let events = await subscribe(ws);
    await handler.getExportFormats(null);
    await vi.waitFor(() => expect(events.map(event => event.logs.map(log => log.message)))
        .toStrictEqual([[["formats failed"]]]), KEPT_SOON);
    expect(texts(await ws.impl.readGadgetErrors())).toStrictEqual(["second life"]);
  }), GADGET_TEST_MS);

  it("keeps nothing when export formats are read for a gadget with no ExportHandler",
      () => withWorkspace(async ws => {
    initialise(ws);
    await addGadget(ws, OTHER_GADGET_ID, {
      "server.js": `
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  hello() {
    return "hi";
  }
}
`,
      "client.js": `export default function App() { return null; }\n`,
    });
    let events = await subscribe(ws);

    // What the Workshop does each time the gadget's export menu is opened, and before an export.
    let formats = await ws.impl.getGadgetExportFormats(OTHER_GADGET_ID);
    expect(formats.length).toBeGreaterThan(0);
    expect(await ws.impl.getGadgetExportFormats(OTHER_GADGET_ID)).toStrictEqual(formats);

    await noLaterTrace();
    expect(await ws.impl.readGadgetErrors()).toStrictEqual({ entries: [] });
    expect(told(events)).toStrictEqual([]);
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

describe("readGadgetErrors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives a build session the page its query asks for", () => withWorkspace(async ws => {
    let client = await openOwner(ws);
    let commit = await addGadget(ws);
    await addDraft(ws, 2, commit);

    // 150 errors of one gadget, over five of its minutes, then one of another under a chat.
    let start = Date.now();
    let now = vi.spyOn(Date, "now");
    for (let minute = 0; minute < 5; minute++) {
      now.mockReturnValue(start + minute * 60_000);
      await deliver(ws, null, Array.from({ length: GADGET_ERRORS_PER_MINUTE },
          (_, i) => thrown(`Error: line ${minute * GADGET_ERRORS_PER_MINUTE + i}`)), 5);
    }
    await deliver(ws, 2, [thrown("Error: careful")]);

    let first = await client.readGadgetErrors();
    expect(first.entries).toHaveLength(100);
    expect(first.entries[0]).toMatchObject(
        { gadgetId: GADGET_ID, chatId: 2, source: "server", text: "Error: careful" });
    expect(first.entries[1].text).toBe("Error: line 149");
    let second = await client.readGadgetErrors({ cursor: first.nextCursor });
    expect(second.entries).toHaveLength(51);
    expect(second.entries.at(-1)!.text).toBe("Error: line 0");
    expect(second).not.toHaveProperty("nextCursor");

    let listed = async (query: GadgetErrorQuery) => texts(await client.readGadgetErrors(query));
    expect(await listed({ gadgetId: GADGET_ID })).toStrictEqual(["Error: careful"]);
    expect(await listed({ chatId: 2 })).toStrictEqual(["Error: careful"]);
    expect(await listed({ source: "server", gadgetId: GADGET_ID }))
        .toStrictEqual(["Error: careful"]);
    expect(await listed({ gadgetId: GADGET_ID, chatId: null })).toStrictEqual([]);
    expect(await listed({ gadgetId: 5, chatId: null })).toHaveLength(100);
    expect(await listed({ source: "client" })).toStrictEqual([]);
  }));

  it("checks the query, and asks no log object, while the workspace has kept nothing",
      () => withWorkspace(async ws => {
    let client = await openOwner(ws);
    let logs = unreachableLogs();
    ws.impl.workspaceErrorLogs = logs;

    await expect(client.readGadgetErrors({ cursor: "abc" })).rejects.toThrow("Invalid cursor.");
    expect(await client.readGadgetErrors()).toStrictEqual({ entries: [] });
    expect(await client.readGadgetErrors({ gadgetId: GADGET_ID })).toStrictEqual({ entries: [] });
    expect(logs.getByName).not.toHaveBeenCalled();
    expect(errorLogId(ws)).toBeUndefined();
  }));

  it("checks the query before it asks the log object that holds entries",
      () => withWorkspace(async ws => {
    let client = await openOwner(ws);
    await deliver(ws, null, [thrown("kept")]);
    let logs = unreachableLogs();
    ws.impl.workspaceErrorLogs = logs;

    await expect(client.readGadgetErrors({ cursor: "abc" })).rejects.toThrow("Invalid cursor.");
    expect(logs.getByName).not.toHaveBeenCalled();
  }));

  it("refuses a use session, whatever the query, and reaches nothing",
      () => withWorkspace(async ws => {
    initialise(ws);
    await deliver(ws, null, [thrown("kept")]);

    // A "use" session over a forged impl that holds only what such a session may reach: the
    // listing and the log namespace are counted, and neither may be asked.
    let readGadgetErrors = vi.fn();
    let logs = unreachableLogs();
    let client = await openFakeOverseer({ gadgets: ws.impl.storage.gadgets }, {
      role: "use", impl: { readGadgetErrors, workspaceErrorLogs: logs },
    });
    await expect(client.readGadgetErrors()).rejects.toThrow("Unauthorized");
    await expect(client.readGadgetErrors({ gadgetId: GADGET_ID })).rejects.toThrow("Unauthorized");
    await expect(client.readGadgetErrors({ cursor: "abc" })).rejects.toThrow("Unauthorized");
    expect(readGadgetErrors).not.toHaveBeenCalled();
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
        append: (entries: GadgetErrorEntry[]) =>
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

const DELETE_FAILED = "gadget.error.delete.failed";

describe("deleting the workspace", () => {
  it("deletes its log object, through the owner's deleteSelf()", () => withWorkspace(async ws => {
    let client = await openOwner(ws);
    await deliver(ws, null, [thrown("kept")]);
    let name = errorLogId(ws)!;
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
    ws.impl.workspaceErrorLogs = {
      getByName: () => ({
        append: async () => {
          order.push("append sent");
          await release.promise;
          order.push("append settled");
        },
        destroy: async () => { order.push("destroy"); },
      }),
    };

    let delivered = deliver(ws, null, [thrown("in flight")]);
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
    ws.impl.workspaceErrorLogs = logs;

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
      ws.impl.workspaceErrorLogs = faultyLogs(real, { append: () => release.promise });
      void deliver(ws, null, [thrown("held")]);
      return { error: "Gadget error log deletion timed out.", unblock: () => release.resolve() };
    }],
    ["destroy() never settles", (ws, real) => {
      let release = Promise.withResolvers<void>();
      ws.impl.workspaceErrorLogs = faultyLogs(real, {
        destroy: async destroy => { await release.promise; await destroy(); },
      });
      return { error: "Gadget error log deletion timed out.", unblock: () => release.resolve() };
    }],
    ["destroy() rejects", (ws, real) => {
      let failure = new Error("log storage failed");
      let failing = true;
      ws.impl.workspaceErrorLogs = faultyLogs(real, {
        destroy: destroy => failing ? Promise.reject(failure) : destroy(),
      });
      return { error: failure, unblock: () => { failing = false; } };
    }],
  ];

  it.for(blocks)("is deferred, and never rejects the drain, while %s",
      ([, block]) => withWorkspace(async ws => {
    initialise(ws);
    await deliver(ws, null, [thrown(MARKER)]);
    let name = errorLogId(ws)!;
    let warn = vi.spyOn(ws.impl.logger, "warn");
    let { error, unblock } = block(ws, ws.impl.workspaceErrorLogs);

    beginDeletion(ws);
    await expect(ws.impl.deliverUserUpdates()).resolves.toBeUndefined();

    // One warning, with the cause and nothing of an entry.
    expect(warn).toHaveBeenCalledTimes(1);
    let [[message, fields]] = warnings(warn, DELETE_FAILED);
    expect(message).toBe("gadget error log deletion deferred");
    let caught = (fields as { error: Error }).error;
    if (typeof error === "string") expect(caught.message).toBe(error);
    else expect(caught).toBe(error);
    expect(logged(warn)).not.toContain(MARKER);

    // The workspace's storage is whole and its tombstone stands, so the alarm tries again.
    expect(ws.impl.storage.deleting.get()).toBe(true);
    expect(errorLogId(ws)).toBe(name);
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
    await deliver(ws, null, [thrown("kept")]);
    let name = errorLogId(ws)!;
    let warn = vi.spyOn(ws.impl.logger, "warn");
    // The shape a reset arrives in on a deployment; the test pool's own aborts carry no flag.
    let reset = Object.assign(new Error("Durable Object reset."),
        { remote: true, overloaded: true, durableObjectReset: true });
    let destroys = 0;
    let logs = faultyLogs(ws.impl.workspaceErrorLogs, {
      destroy: destroy => ++destroys === 1 ? Promise.reject(reset) : destroy(),
    });
    ws.impl.workspaceErrorLogs = logs;

    beginDeletion(ws);
    await ws.impl.deliverUserUpdates();
    expect(destroys).toBe(2);
    // Each try asks the namespace for the stub: one of an object that was reset stays broken.
    expect(logs.getByName).toHaveBeenCalledTimes(2);
    expect(warnings(warn, DELETE_FAILED)).toStrictEqual([]);
    expect(storageKeys(ws)).toStrictEqual([]);
    expect(await hasLogTable(name)).toBe(false);
  }));

  it("still restarts the workspace's sessions from deleteSelf() when its log object fails",
      () => withWorkspace(async ws => {
    let client = await openOwner(ws);
    let reasons: string[] = [];
    ws.impl.scheduleAccessRestart = async (reason: string) => { reasons.push(reason); };
    await deliver(ws, null, [thrown("kept")]);
    let name = errorLogId(ws)!;
    let real = ws.impl.workspaceErrorLogs;
    let warn = vi.spyOn(ws.impl.logger, "warn");
    ws.impl.workspaceErrorLogs = faultyLogs(real, {
      destroy: () => Promise.reject(new Error("log storage failed")),
    });

    await expect(client.deleteSelf()).resolves.toBeUndefined();
    expect(reasons).toStrictEqual(["Gadget restarted because the workspace was deleted."]);
    expect(warnings(warn, DELETE_FAILED)).toHaveLength(1);
    expect(ws.impl.storage.deleting.get()).toBe(true);
    expect(errorLogId(ws)).toBe(name);

    // A second delete finds the workspace already being deleted, and restarts nothing.
    await expect(client.deleteSelf()).resolves.toBeUndefined();
    expect(reasons).toHaveLength(1);

    // What the alarm runs, once the log object answers.
    ws.impl.workspaceErrorLogs = real;
    await ws.impl.deliverUserUpdates();
    expect(storageKeys(ws)).toStrictEqual([]);
    expect(await hasLogTable(name)).toBe(false);
  }));

  it("leaves a workspace initialised again under the same id with no log of its earlier life",
      () => withWorkspace(async ws => {
    initialise(ws);
    await deliver(ws, null, [thrown("first life")]);
    let earlier = errorLogId(ws)!;

    beginDeletion(ws);
    await ws.impl.deliverUserUpdates();
    expect(storageKeys(ws)).toStrictEqual([]);

    // An append that was sent before the deletion and lands after it.
    await env.TEST_WORKSPACE_ERROR_LOG.getByName(earlier).append([{
      time: new Date(), gadgetId: GADGET_ID, chatId: null, source: "server", text: "late",
    }]);

    // The id is initialised again, as an external message does it, and a gadget of the earlier
    // life throws: the same gadget id, under the next life's owner, from a Worker whose tail
    // names the earlier life's log object.
    initialise(ws);
    let late = () => ws.impl.deliverGadgetExceptions(
        null, [thrown("first life, thrown late")], GADGET_ID, earlier);
    await late();
    expect(errorLogId(ws)).toBeUndefined();

    await deliver(ws, null, [thrown("second life")]);
    expect(errorLogId(ws)).not.toBe(earlier);
    await late();
    expect(texts(await ws.impl.readGadgetErrors())).toStrictEqual(["second life"]);
  }));

  // What whoever posts next to the workspace's key sends. They have an account, so only the
  // deletion can turn their message away.
  const NEXT_MESSAGE: Parameters<OverseerDurableObject["receiveExternalMessage"]>[0] = {
    callerEmail: "next@example.test", externalChatKey: "k", idempotencyKey: "i",
    prompt: "hello", chatGatewayRpcTarget: {} as never, title: "Next life",
  };
  const NEXT_PROFILE: AiChatAuthorInfo = { type: "user", id: "next@example.test", name: "Next" };
  const DELETED = { accepted: false, message: "Workspace was deleted." };

  it("initialises nothing for an external message on the instance that deleted the workspace",
      () => withWorkspace(async ws => {
    initialise(ws);
    let whoamiIfExists = vi.fn(async () => NEXT_PROFILE);
    ws.impl.users = {
      ...fakeUsers(ws),
      getByName: () => ({ id: { toString: () => "next-owner-do" }, whoamiIfExists }),
    };

    beginDeletion(ws);
    await ws.impl.deliverUserUpdates();
    expect(storageKeys(ws)).toStrictEqual([]);

    // The tombstone went with the storage, and this instance's sessions last until its restart: a
    // workspace initialised here would keep the errors of the gadget calls they make. The message
    // is turned away before anything is asked of it or of its caller: one with no prompt gets the
    // same answer, and no account is looked up.
    expect(await ws.instance.receiveExternalMessage(NEXT_MESSAGE)).toStrictEqual(DELETED);
    expect(await ws.instance.receiveExternalMessage({ ...NEXT_MESSAGE, prompt: " " }))
        .toStrictEqual(DELETED);
    expect(whoamiIfExists).not.toHaveBeenCalled();
    expect(ws.impl.ownerId).toBeUndefined();
    expect(storageKeys(ws)).toStrictEqual([]);
  }));

  it.for([
    ["while its storage was still to be wiped", false],
    ["once its storage was wiped", true],
  ] as const)("initialises nothing for an external message that was resolving its caller when " +
      "the workspace was deleted, and resolved them %s", ([, wiped]) => withWorkspace(async ws => {
    initialise(ws);
    let profile = Promise.withResolvers<AiChatAuthorInfo>();
    let whoamiIfExists = vi.fn(() => profile.promise);
    let removed = Promise.withResolvers<void>();
    let users = fakeUsers(ws);
    ws.impl.users = {
      ...users,
      get: () => ({ ...users.get(), workspaceRemoved: () => removed.promise }),
      getByName: () => ({ id: { toString: () => "next-owner-do" }, whoamiIfExists }),
    };

    // The message finds a workspace that is not being deleted, and waits for its caller's
    // profile. The owner deletes the workspace meanwhile.
    let answer = ws.instance.receiveExternalMessage(NEXT_MESSAGE);
    await vi.waitFor(() => expect(whoamiIfExists).toHaveBeenCalled());
    beginDeletion(ws);
    let drained = ws.impl.deliverUserUpdates();
    if (wiped) {
      removed.resolve();
      await drained;
      expect(storageKeys(ws)).toStrictEqual([]);
    }

    profile.resolve(NEXT_PROFILE);
    expect(await answer).toStrictEqual(DELETED);
    removed.resolve();
    await drained;
    expect(ws.impl.ownerId).toBeUndefined();
    expect(storageKeys(ws)).toStrictEqual([]);
  }));
});
