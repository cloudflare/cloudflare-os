import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  droppedGadgetConsoleLogsText, MAX_GADGET_CONSOLE_LOGS_PER_CALL, type AuthenticatedApi,
  type ConsoleLogEvent, type ConsoleLogSubscriber, type GadgetClient, type Overseer,
  type ReportedGadgetConsoleLog, type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import {
  startHarness, startTestGatekeeperHarness, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR,
  TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, RpcTarget, signUp, stubFor, waitFor,
  WorkpieceRecorder,
} from "../src/rpc-client.js";

const network = new NetworkInterceptor();

// `harness` leaves RECORD_GADGET_CONSOLE_LOGS unset, which is how a local instance runs unless its
// shell sets the variable, and `recording` sets it to "true". Those are the only two values
// GadgetTailLoopback.tail()'s reading of the switch is tried with, here or anywhere: it reads the
// Worker's own env, which only a harness sets. "false" and a malformed value are off by the same
// isGadgetConsoleLogRecordingEnabled() call, whose values the backend's unit tests cover, so a
// tail() that read the variable's truthiness instead of calling it would pass every suite.
// Showing otherwise takes a third server for one assertion, and neither of these two can be
// redeployed with "false": that restarts every Worker under the sessions the concurrent tests hold.
let harness: Harness;
let recording: Harness;

beforeAll(async () => {
  network.install();
  // Each is kept as soon as it has started, so that afterAll closes it when the other fails.
  await Promise.all([
    startTestGatekeeperHarness({ enableGadgetExecution: true })
        .then(started => { harness = started; }),
    startHarness({
      gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR }],
      enableGadgetExecution: true,
      patchWorkshop: config => {
        config.vars = { ...config.vars, RECORD_GADGET_CONSOLE_LOGS: "true" };
      },
    }).then(started => { recording = started; }),
  ]);
});

afterAll(async () => {
  try {
    await Promise.all([harness?.server.close(), recording?.server.close()]);
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

type Log = { chatId: number | null; level: ConsoleLogEvent["level"]; message: unknown[] };

class LogRecorder extends RpcTarget implements ConsoleLogSubscriber {
  readonly logs: Log[] = [];
  async event(chatId: number | null, logs: ConsoleLogEvent[]) {
    this.logs.push(...logs.map(({ level, message }) => ({ chatId, level, message })));
  }
  /** Wait for the log of the call that greeted `name`. */
  logged(name: string) {
    return waitFor(`the log greeting ${name}`, async () =>
      this.logs.find(log => log.message[1] === name) ?? null);
  }
}

/** A live event of level "error" under `chatId` whose one argument holds `text`, for toEqual(). */
const liveError = (chatId: number | null, text: string) =>
    ({ chatId, level: "error", message: [expect.stringContaining(text)] });

// A gadget server whose methods print and throw under `label`, with an export handler that prints
// too. `late()` throws from a timer, which nothing catches, and answers after it.
const server = (label: string, level: "log" | "warn") =>
  `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
export class Gadget extends DurableObject {
  greet(name) { console.${level}("${label}", name); return name; }
  fail() { throw new Error("${label} boom"); }
  late() {
    setTimeout(() => { throw new Error("${label} late"); }, 0);
    return new Promise(resolve => setTimeout(() => resolve("ok"), 50));
  }
  flood(n) { for (let i = 0; i < n; i++) console.log("flood", i); return n; }
}
export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(_gadget) {
    console.log("${label} formats");
    return [{
      id: "csv", label: "CSV", mode: "server", contentType: "text/csv", fileExtension: ".csv",
    }];
  }
  async export(gadget, _id) { return new Response(await gadget.greet("export")).body; }
}
`;
const MAINLINE = server("mainline", "log");

const files = (gadgetId: WorkpieceId, text?: string): CodeContent =>
  new Map([[gadgetId, new Map(text === undefined ? [] : [["server.js", text]])]]);

type Owner = {
  /** The owner's authenticated API. */
  api: RpcStub<AuthenticatedApi>;
  ws: RpcStub<Overseer>;
  /** The workspace's id, which its log lines carry as `gadgetId`. */
  workspaceId: string;
  /** The owner's profile id, which a client entry is recorded under. */
  userId: string;
  gadget: RpcStub<GadgetClient>;
  gadgetId: WorkpieceId;
  head: string;
};

/** Sign up an owner on `on` whose workspace has gadget `APP` with the `MAINLINE` server merged. */
async function withLoggingGadget<T>(fn: (owner: Owner) => Promise<T>, on = harness): Promise<T> {
  const [username] = nextUsernames("logowner");
  using publicApi = connect(on.url);
  using api = await signUp(publicApi, username!);
  using ws = await api.newWorkspace();
  const workpieces = new WorkpieceRecorder();
  using workpiecesStub = stubFor(workpieces);
  using _workpieces = await ws.subscribeToWorkpieces(workpiecesStub);
  await workpieces.loaded;
  using gadget = await ws.createGadget("App", undefined, "APP");
  const gadgetId = await gadget.getId();
  const headOf = (after?: string) => waitFor(`a new head for gadget ${gadgetId}`, async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined &&
        summary.commitId !== after ? summary.commitId : null;
  });
  const empty = await headOf();
  const seed = await ws.newChat("Seed", null);
  await ws.submitCodeChange(seed, {
    generation: 0, revision: 0, clientId: "seed", seq: 1, pins: [{ gadgetId, baseCommit: empty }],
    change: diffFiles(files(gadgetId), files(gadgetId, MAINLINE)),
  });
  expect(await ws.mergeChanges(seed)).toEqual({ outcome: "merged" });
  return await fn({
    api, ws, workspaceId: (await ws.getMetadata()).id, userId: (await api.whoami()).id, gadget,
    gadgetId, head: await headOf(empty),
  });
}

/** A chat whose finalized draft of the owner's gadget is the "draft" server, which warns. */
async function draftOf({ ws, gadgetId, head }: Owner): Promise<number> {
  const draft = await ws.newChat("Draft", null);
  await ws.submitCodeChange(draft, {
    generation: 0, revision: 0, clientId: "draft", seq: 1, pins: [{ gadgetId, baseCommit: head }],
    change: diffFiles(files(gadgetId, MAINLINE), files(gadgetId, server("draft", "warn"))),
  });
  await ws.finalizeChatDraft(draft);
  return draft;
}

/** Call the gadget's server, as the mainline or `chatId`'s draft. */
async function greet(gadget: RpcStub<GadgetClient>, name: string, chatId?: number) {
  using facet = await gadget.connectToGadget(chatId) as RpcStub<{ greet(name: string): string }>;
  expect(await facet.greet(name)).toBe(name);
}

/** Call the server's `fail()`, as the mainline or under `chatId`, and expect its error. */
async function fail(gadget: RpcStub<GadgetClient>, message: RegExp, chatId?: number) {
  using facet = await gadget.connectToGadget(chatId) as RpcStub<{ fail(): void }>;
  await expect(facet.fail()).rejects.toThrow(message);
}

type Line = Record<string, string>;

/** The gadget.console lines `on` has logged for a workspace, each as its printed fields by name. */
const recorded = (on: Harness, workspaceId: string): Line[] => on.server.getLogs()
    .filter(log => log.message.includes("component: 'gadget.console'") &&
        log.message.includes(`gadgetId: '${workspaceId}'`))
    .map(log => Object.fromEntries([...log.message.matchAll(/^ {2}(\w+): (.*?),?$/gm)]
        .map(([, name, value]) => [name, value])));

/** A string field as a line prints it. Sampled texts hold no quote, backslash or line break. */
const printed = (text: string) => `'${text}'`;

/**
 * Wait until `recording` has captured the workspace's line with `text`. Capture trails the call
 * that wrote a line, and a line written later is captured later, so a test that counts lines
 * first waits here for one written after them.
 */
const recordedText = (workspaceId: string, text: string) =>
    waitFor(`the recorded line "${text}"`, async () =>
        recorded(recording, workspaceId).find(line => line.text === printed(text)) ?? null);

const ISO_TIME = /^'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z'$/;

type Labels = { source: "server" | "client"; chatId?: number; userId?: string };

// The fields every line of `owner`'s gadget prints, for toEqual(): an absent chat or user is
// undefined here, which matches only a line without that field.
const lineLabels = (owner: Owner, { source, chatId, userId }: Labels) => ({
  component: "'gadget.console'", gadgetId: printed(owner.workspaceId),
  workpieceId: String(owner.gadgetId), chatId: chatId?.toString(),
  consoleSource: printed(source), userId: userId === undefined ? undefined : printed(userId),
});

/**
 * The whole line recorded() gives for one entry of `owner`'s gadget, for toEqual(). `text` is the
 * entry's text, or a matcher for its printed form, and `time` is any ISO time unless given.
 */
const entryLine = (owner: Owner, entry: Labels & {
  level: ConsoleLogEvent["level"]; text: unknown; time?: Date;
}) => ({
  ...lineLabels(owner, entry), event: "'gadget.console.entry'", message: "'gadget console entry'",
  consoleLevel: printed(entry.level),
  time: entry.time ? printed(entry.time.toISOString()) : expect.stringMatching(ISO_TIME),
  text: typeof entry.text === "string" ? printed(entry.text) : entry.text,
});

/** The whole line recorded() gives for a marker that counts `dropped` entries, for toEqual(). */
const markerLine = (owner: Owner, labels: Labels, dropped: number) => ({
  ...lineLabels(owner, labels), event: "'gadget.console.dropped'",
  message: "'gadget console entries dropped'", droppedCount: String(dropped),
  time: expect.stringMatching(ISO_TIME), text: printed(droppedGadgetConsoleLogsText(dropped)),
});

const isEntry = (line: Line) => line.event === "'gadget.console.entry'";

const REPORTED_AT = new Date("2026-01-02T03:04:05.678Z");

/** One console call as a browser reports it, made at REPORTED_AT. */
const reported = (text: string, level: ConsoleLogEvent["level"] = "log")
    : ReportedGadgetConsoleLog => ({ time: REPORTED_AT, level, text });

// The scheme word and its credential are never written as one literal: a secret scanner reads this
// source, not the value a test builds from it.
const credential = "abcdef0123456789ABCDEF";

it.concurrent("gadget console logs reach subscribers, labelled with their draft or mainline",
    async () => {
  await withLoggingGadget(async ({ ws, gadget, gadgetId, head }) => {
    const draft = await ws.newChat("Draft", null);
    await ws.submitCodeChange(draft, {
      generation: 0, revision: 0, clientId: "draft", seq: 1, pins: [{ gadgetId, baseCommit: head }],
      change: diffFiles(files(gadgetId, MAINLINE), files(gadgetId, server("draft", "warn"))),
    });
    await ws.finalizeChatDraft(draft);
    const recorder = new LogRecorder();
    using recorderStub = stubFor(recorder);
    using _logs = await ws.subscribeToConsoleLogs(recorderStub);

    await greet(gadget, "Ada", draft);
    await greet(gadget, "Grace");
    expect(await recorder.logged("Ada"))
        .toEqual({ chatId: draft, level: "warn", message: ["draft", "Ada"] });
    expect(await recorder.logged("Grace"))
        .toEqual({ chatId: null, level: "log", message: ["mainline", "Grace"] });
  });
});

it.concurrent("disposing a console log subscription stops its logs but not others'", async () => {
  await withLoggingGadget(async ({ ws, gadget }) => {
    const stopped = new LogRecorder();
    const live = new LogRecorder();
    using stoppedStub = stubFor(stopped);
    using liveStub = stubFor(live);
    const subscription = await ws.subscribeToConsoleLogs(stoppedStub);
    using _live = await ws.subscribeToConsoleLogs(liveStub);
    await greet(gadget, "before");
    await Promise.all([stopped.logged("before"), live.logged("before")]);

    subscription[Symbol.dispose]();
    await greet(gadget, "after");
    await live.logged("after");
    // Both subscriptions share one connection, so a log sent to the stopped one is here by now.
    expect(stopped.logs.map(log => log.message[1])).toEqual(["before"]);
  });
});

it.concurrent("a use collaborator's console log subscription receives nothing", async () => {
  await withLoggingGadget(async ({ ws, gadget, gadgetId }) => {
    const [viewer] = nextUsernames("logviewer");
    using viewerPublic = connect(harness.url);
    using viewerApi = await signUp(viewerPublic, viewer!);
    if (!await ws.addCollaborator(viewer!, { gadgetId })) {
      throw new Error(`Failed to share with ${viewer}`);
    }
    using useWs = await viewerApi.openWorkspace((await ws.getMetadata()).id);
    const viewerLogs = new LogRecorder();
    const ownerLogs = new LogRecorder();
    using viewerStub = stubFor(viewerLogs);
    using ownerStub = stubFor(ownerLogs);
    using _viewer = await useWs.subscribeToConsoleLogs(viewerStub);
    using _owner = await ws.subscribeToConsoleLogs(ownerStub);

    await greet(gadget, "Ada");
    await ownerLogs.logged("Ada");
    // Anything already sent to the viewer's connection arrives before this reply.
    await useWs.getMetadata();
    expect(viewerLogs.logs).toEqual([]);
  });
});

it.concurrent("a gadget's server console calls are each recorded once, under their draft or mainline, and still reach subscribers",
    async () => {
  await withLoggingGadget(async owner => {
    const { ws, workspaceId, gadget } = owner;
    const draft = await draftOf(owner);
    const recorder = new LogRecorder();
    using recorderStub = stubFor(recorder);
    using _logs = await ws.subscribeToConsoleLogs(recorderStub);

    await greet(gadget, "Ada", draft);
    await greet(gadget, "Grace");
    expect(await recorder.logged("Ada"))
        .toEqual({ chatId: draft, level: "warn", message: ["draft", "Ada"] });
    expect(await recorder.logged("Grace"))
        .toEqual({ chatId: null, level: "log", message: ["mainline", "Grace"] });

    await greet(gadget, "Sentinel");
    await recordedText(workspaceId, "mainline Sentinel");
    const lines = recorded(recording, workspaceId);
    expect(lines.filter(line => line.text === printed("draft Ada"))).toEqual([
      entryLine(owner, { source: "server", chatId: draft, level: "warn", text: "draft Ada" }),
    ]);
    expect(lines.filter(line => line.text === printed("mainline Grace"))).toEqual([
      entryLine(owner, { source: "server", level: "log", text: "mainline Grace" }),
    ]);
  }, recording);
});

it.concurrent("a gadget method that throws is recorded once, under the draft or mainline that ran, and still delivered live",
    async () => {
  await withLoggingGadget(async owner => {
    const { ws, workspaceId, gadget } = owner;
    const draft = await draftOf(owner);
    const idle = await ws.newChat("Idle", null);
    const recorder = new LogRecorder();
    using recorderStub = stubFor(recorder);
    using _logs = await ws.subscribeToConsoleLogs(recorderStub);

    // The idle chat proposes nothing, so the mainline's code runs under it and throws its error.
    await fail(gadget, /mainline boom/);
    await fail(gadget, /draft boom/, draft);
    await fail(gadget, /mainline boom/, idle);

    // A live event names the chat the caller asked for.
    const liveErrors = () => recorder.logs.filter(log => log.level === "error");
    await waitFor("three live errors", async () => liveErrors().length >= 3 || null);
    expect(liveErrors()).toEqual(expect.arrayContaining([
      liveError(null, "mainline boom"), liveError(draft, "draft boom"),
      liveError(idle, "mainline boom"),
    ]));

    // A caught exception is written from a request of its own, which a later call's line can
    // overtake, so the three lines are waited for before the sentinel.
    const errorLines = () =>
        recorded(recording, workspaceId).filter(line => line.consoleLevel === printed("error"));
    await waitFor("three recorded errors", async () => errorLines().length >= 3 || null);
    await greet(gadget, "Sentinel");
    await recorder.logged("Sentinel");
    await recordedText(workspaceId, "mainline Sentinel");

    // The record's chat is the one whose code ran, as it is for the gadget's own console calls,
    // while the live event keeps the caller's. The two chats pin that from both sides: a record
    // made with the caller's chat as given would put the idle chat's id on a mainline error, and
    // one made with no chat would file the draft's error under the mainline. No other test here
    // throws under a chat. The counts guard against the runtime starting to report these
    // exceptions to the tail worker while the Workshop still reports them itself.
    const errorLine = (text: string, chatId?: number) => entryLine(owner, {
      source: "server", chatId, level: "error", text: expect.stringContaining(text),
    });
    const lines = errorLines();
    expect(lines).toHaveLength(3);
    expect(lines).toEqual(expect.arrayContaining([errorLine("draft boom", draft)]));
    expect(lines.filter(line => line.chatId === undefined))
        .toEqual([errorLine("mainline boom"), errorLine("mainline boom")]);
    expect(liveErrors()).toHaveLength(3);
  }, recording);
});

it.concurrent("an exception a gadget does not catch is recorded once and still delivered live",
    async () => {
  await withLoggingGadget(async owner => {
    const { ws, workspaceId, gadget } = owner;
    const recorder = new LogRecorder();
    using recorderStub = stubFor(recorder);
    using _logs = await ws.subscribeToConsoleLogs(recorderStub);

    {
      using facet = await gadget.connectToGadget() as RpcStub<{ late(): string }>;
      expect(await facet.late()).toBe("ok");
    }
    // The tail worker writes a request's lines before it delivers its events, so once the error
    // is here its line is written, ahead of the sentinel's.
    const liveErrors = () => recorder.logs.filter(log => log.level === "error");
    await waitFor("the live error", async () => liveErrors().length > 0 || null);
    await greet(gadget, "Sentinel");
    await recorder.logged("Sentinel");
    await recordedText(workspaceId, "mainline Sentinel");

    // The runtime reports a timer callback's exception to the tail worker (an unhandled
    // rejection it does not), which appends such exceptions after the request's console calls,
    // so the record has to be written after that. No other test reaches that loop.
    expect(liveErrors()).toEqual([{ chatId: null, level: "error", message: ["mainline late"] }]);
    expect(recorded(recording, workspaceId).filter(line => line.consoleLevel === printed("error")))
        .toEqual([entryLine(owner, { source: "server", level: "error", text: "mainline late" })]);
  }, recording);
});

it.concurrent("one chatty request keeps its newest lines and marks the rest dropped", async () => {
  await withLoggingGadget(async owner => {
    const { workspaceId, gadget } = owner;
    // Enough calls to make more lines than one request may write, since each line carries its
    // labels, and few enough that the gadget's own request stays under the runtime's limit on a
    // request's logs: these come to about 142 KB of its 256 KB, which some 2,760 such calls
    // reach. Past it the runtime passes no calls on and ends the output with a warning of its own.
    const calls = 1500;
    {
      using facet = await gadget.connectToGadget() as RpcStub<{ flood(n: number): number }>;
      expect(await facet.flood(calls)).toBe(calls);
    }

    // The marker is written before the entries, so the wait is for the last entry: waiting for
    // the marker would count the entries while they are still arriving.
    await recordedText(workspaceId, `flood ${calls - 1}`);
    const lines = recorded(recording, workspaceId);
    const markers = lines.filter(line => !isEntry(line));
    const dropped = Number(markers[0]?.droppedCount);
    expect(dropped).toBeGreaterThan(0);
    expect(markers).toEqual([markerLine(owner, { source: "server" }, dropped)]);
    expect(lines.filter(isEntry).map(line => line.text)).toEqual(
        Array.from({ length: calls - dropped }, (_, i) => printed(`flood ${dropped + i}`)));
  }, recording);
});

it.concurrent("a client batch is recorded once per entry under the sending user, and reaches no subscriber",
    async () => {
  await withLoggingGadget(async owner => {
    const { ws, workspaceId, userId, gadget, gadgetId } = owner;
    const draft = await draftOf(owner);
    const idle = await ws.newChat("Idle", null);
    const recorder = new LogRecorder();
    using recorderStub = stubFor(recorder);
    using _logs = await ws.subscribeToConsoleLogs(recorderStub);

    await ws.reportGadgetConsoleLogs(gadgetId, null, [
      reported(`boom ${userId} Bearer ${credential}`, "error"),
      reported(`second ${userId}`, "debug"),
    ]);
    await ws.reportGadgetConsoleLogs(gadgetId, draft, [reported(`drafted ${userId}`, "warn")]);
    await ws.reportGadgetConsoleLogs(gadgetId, idle, [reported(`idle ${userId}`, "info")]);

    // Only the draft's entry names a chat: the idle chat proposes nothing, so the UI it showed
    // was the mainline's.
    await recordedText(workspaceId, `idle ${userId}`);
    const client = { source: "client", userId, time: REPORTED_AT } as const;
    expect(recorded(recording, workspaceId)).toEqual([
      entryLine(owner, { ...client, level: "error", text: `boom ${userId} Bearer [redacted]` }),
      entryLine(owner, { ...client, level: "debug", text: `second ${userId}` }),
      entryLine(owner, { ...client, chatId: draft, level: "warn", text: `drafted ${userId}` }),
      entryLine(owner, { ...client, level: "info", text: `idle ${userId}` }),
    ]);

    // A subscriber is sent its events in order, so once this call's event has arrived, anything
    // a report had delivered would have arrived before it. A bare "holds nothing" would pass
    // before any delivery could have landed. The call comes last so that it adds nothing to the
    // lines compared above.
    await greet(gadget, "Grace");
    await recorder.logged("Grace");
    expect(recorder.logs).toEqual([{ chatId: null, level: "log", message: ["mainline", "Grace"] }]);
  }, recording);
});

it.concurrent("a client batch names a gadget and a chat of the workspace", async () => {
  await withLoggingGadget(async owner => {
    const { ws, workspaceId, userId, gadgetId } = owner;
    await expect(ws.reportGadgetConsoleLogs(999_999, null, [reported("no such gadget")]))
        .rejects.toThrow(/No such gadget/);
    await expect(ws.reportGadgetConsoleLogs(gadgetId, 424_242, [reported("no such chat")]))
        .rejects.toThrow(/No such chatId/);

    await ws.reportGadgetConsoleLogs(gadgetId, null, [reported("sentinel")]);
    await recordedText(workspaceId, "sentinel");
    expect(recorded(recording, workspaceId)).toEqual([entryLine(owner, {
      source: "client", userId, level: "log", time: REPORTED_AT, text: "sentinel",
    })]);
  }, recording);
});

it.concurrent("a use collaborator sends the console output of a gadget they hold, and nothing else",
    async () => {
  await withLoggingGadget(async owner => {
    const { ws, workspaceId, gadget, gadgetId } = owner;
    using other = await ws.createGadget("Other", undefined, "OTHER");
    const otherId = await other.getId();
    const chat = await ws.newChat("Idle", null);
    const [viewer] = nextUsernames("logviewer");
    using viewerPublic = connect(recording.url);
    using viewerApi = await signUp(viewerPublic, viewer!);
    if (!await ws.addCollaborator(viewer!, { gadgetId })) {
      throw new Error(`Failed to share with ${viewer}`);
    }
    using useWs = await viewerApi.openWorkspace(workspaceId);

    await useWs.reportGadgetConsoleLogs(gadgetId, null, [reported("from the viewer")]);
    await expect(useWs.reportGadgetConsoleLogs(gadgetId, chat, [reported("under a chat")]))
        .rejects.toThrow(
            "Unauthorized: this collaborator only has permission to use the gadget's UI.");
    await expect(useWs.reportGadgetConsoleLogs(otherId, null, [reported("another gadget")]))
        .rejects.toThrow(/No such gadget/);

    // The viewer still reads nothing on an instance that records. The gadget's server prints
    // for that: a report is delivered to no subscriber of any role, so a viewer's recorder that
    // only sat through reports would be empty whatever a use subscription delivers.
    const viewerLogs = new LogRecorder();
    const ownerLogs = new LogRecorder();
    using viewerStub = stubFor(viewerLogs);
    using ownerStub = stubFor(ownerLogs);
    using _viewer = await useWs.subscribeToConsoleLogs(viewerStub);
    using _owner = await ws.subscribeToConsoleLogs(ownerStub);
    await greet(gadget, "Sentinel");
    await ownerLogs.logged("Sentinel");
    // Anything already sent to the viewer's connection arrives before this reply.
    await useWs.getMetadata();
    expect(viewerLogs.logs).toEqual([]);

    await recordedText(workspaceId, "mainline Sentinel");
    expect(recorded(recording, workspaceId)).toEqual([
      entryLine(owner, {
        source: "client", userId: (await viewerApi.whoami()).id, level: "log", time: REPORTED_AT,
        text: "from the viewer",
      }),
      entryLine(owner, { source: "server", level: "log", text: "mainline Sentinel" }),
    ]);
  }, recording);
});

it.concurrent("a call records its first MAX_GADGET_CONSOLE_LOGS_PER_CALL entries and marks the rest dropped",
    async () => {
  await withLoggingGadget(async owner => {
    const { ws, workspaceId, userId, gadgetId } = owner;
    const client = { source: "client", userId } as const;
    const texts = Array.from({ length: MAX_GADGET_CONSOLE_LOGS_PER_CALL + 5 }, (_, i) => `n${i}`);
    await ws.reportGadgetConsoleLogs(gadgetId, null, texts.map(text => reported(text)));

    await ws.reportGadgetConsoleLogs(gadgetId, null, [reported("sentinel")]);
    await recordedText(workspaceId, "sentinel");
    expect(recorded(recording, workspaceId)).toEqual([
      { ...markerLine(owner, client, 5), text: printed("5 entries dropped") },
      ...[...texts.slice(0, MAX_GADGET_CONSOLE_LOGS_PER_CALL), "sentinel"].map(text =>
          entryLine(owner, { ...client, level: "log", time: REPORTED_AT, text })),
    ]);
  }, recording);
});

it.concurrent("the deployment says whether it records", async () => {
  using recordingApi = connect(recording.url);
  using localApi = connect(harness.url);
  expect((await recordingApi.getServerConfig()).gadgetConsoleLogsRecorded).toBe(true);
  expect((await localApi.getServerConfig()).gadgetConsoleLogsRecorded).toBe(false);
});

it.concurrent("an instance that does not turn recording on writes no gadget console output, and still delivers it live",
    async () => {
  await withLoggingGadget(async ({ ws, gadget, gadgetId }) => {
    const recorder = new LogRecorder();
    using recorderStub = stubFor(recorder);
    using _logs = await ws.subscribeToConsoleLogs(recorderStub);

    await greet(gadget, "Ada");
    await recorder.logged("Ada");
    await ws.reportGadgetConsoleLogs(gadgetId, null, [reported("unrecorded")]);
    await fail(gadget, /mainline boom/);
    const liveErrors = () => recorder.logs.filter(log => log.level === "error");
    await waitFor("the live error", async () => liveErrors().length > 0 || null);

    // The local runtime prints a gadget's own console call by itself, and the harness captures
    // it. This one is printed after anything the calls above could have written, so once it is
    // captured, so is whatever they wrote. An instance whose shell does not set the variable
    // behaves this way: it prints nothing of its own for a gadget's console.
    await greet(gadget, "Zed");
    await recorder.logged("Zed");
    await waitFor("the gadget's own line", async () =>
        harness.server.getLogs().some(log => log.message.includes("mainline Zed")) || null);
    expect(liveErrors()).toHaveLength(1);
    expect(harness.server.getLogs().filter(log => log.message.includes("gadget.console")))
        .toEqual([]);
  });
});

it.concurrent("a batch sent just before its session is let go is still recorded", async () => {
  await withLoggingGadget(async owner => {
    const { api, workspaceId, userId, gadgetId } = owner;
    // The Workshop relies on this when a gadget view goes away: it sends its last batch, and its
    // workspace is disposed straight after. The workspace is opened as the Workshop holds it, a
    // promise used as the stub it will be.
    const leaving = api.openWorkspace(workspaceId);
    await leaving.getMetadata();
    const sent = leaving.reportGadgetConsoleLogs(gadgetId, null, [reported("last words")]);
    leaving[Symbol.dispose]();
    // Whether the call is answered is not what is checked: only that it leaves nothing unhandled.
    sent.then(() => {}, () => {});

    expect(await recordedText(workspaceId, "last words")).toEqual(entryLine(owner, {
      source: "client", userId, level: "log", time: REPORTED_AT, text: "last words",
    }));
  }, recording);
});

it.concurrent("an export handler's console output is recorded under the chat the export was asked for",
    async () => {
  await withLoggingGadget(async owner => {
    const { ws, workspaceId, gadget } = owner;
    const idle = await ws.newChat("Idle", null);
    const csv = [{
      id: "csv", label: "CSV", mode: "server", contentType: "text/csv", fileExtension: ".csv",
    }];
    const formatLines = () => recorded(recording, workspaceId)
        .filter(line => line.text === printed("mainline formats"));

    // This is the one place a recorded chat is not narrowed to a chat that changes the gadget:
    // an export's worker is loaded for the chat as given, so the idle chat, which proposes
    // nothing, is named all the same. Live delivery labels the same call the same way.
    expect(await gadget.getExportFormats(idle)).toEqual(csv);
    await waitFor("the line of the export under the chat", async () =>
        formatLines().length >= 1 || null);
    expect(await gadget.getExportFormats()).toEqual(csv);
    await waitFor("the line of the mainline's export", async () =>
        formatLines().length >= 2 || null);
    expect(formatLines()).toEqual([
      entryLine(owner, { source: "server", chatId: idle, level: "log", text: "mainline formats" }),
      entryLine(owner, { source: "server", level: "log", text: "mainline formats" }),
    ]);
  }, recording);
});

it.concurrent("a workspace that holds restricted data is recorded like any other", async () => {
  await withLoggingGadget(async owner => {
    const { api, ws, workspaceId, userId, gadget, gadgetId } = owner;
    // The restricted-data flag withholds nothing from the record, on purpose. It is checked here
    // because the tail worker, which writes every console call of a gadget's server, reads the
    // Worker's own env, so no unit test reaches it; the backend's unit tests hold the restricted
    // case of the other two writers, an exception the Workshop caught and a client report.
    //
    // The flag is set before anything calls the gadget, and the draft is made after it: a
    // gadget's worker, and the props its tail worker is given, are made when the worker is first
    // loaded, so a guard carried in those props would show only on a worker loaded after the flag
    // was set, which the draft's certainly is.
    await api.provisionAmbientAccount(TEST_VENDOR_ID);
    const account = await waitFor("the test account to be provisioned", async () =>
        (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
    using gatekeeper = await ws.newGatekeeper(
        account.id, "https://gadgets-test.example/things/console-logs");
    if (!gatekeeper) throw new Error("Failed to create the test connection");
    using session = await gatekeeper.openSession() as RpcStub<TestSession>;
    expect(await session.readValue(true)).toBe(42);
    expect((await ws.getMetadata()).containsRestrictedData).toBe(true);

    const draft = await draftOf(owner);
    await greet(gadget, "Ada", draft);
    await greet(gadget, "Grace");
    await ws.reportGadgetConsoleLogs(gadgetId, null, [reported("restricted client", "error")]);
    // A call's line is written once its request has ended, which a later call's line can
    // overtake, so both are waited for before the sentinel.
    await recordedText(workspaceId, "draft Ada");
    await recordedText(workspaceId, "mainline Grace");
    await greet(gadget, "Sentinel");
    await recordedText(workspaceId, "mainline Sentinel");

    // The same lines, with their whole text, as a workspace that holds no restricted data gets.
    const lines = recorded(recording, workspaceId);
    expect(lines.filter(line => line.text === printed("draft Ada"))).toEqual([
      entryLine(owner, { source: "server", chatId: draft, level: "warn", text: "draft Ada" }),
    ]);
    expect(lines.filter(line => line.text === printed("mainline Grace"))).toEqual([
      entryLine(owner, { source: "server", level: "log", text: "mainline Grace" }),
    ]);
    expect(lines.filter(line => line.consoleSource === printed("client"))).toEqual([
      entryLine(owner, {
        source: "client", userId, level: "error", time: REPORTED_AT, text: "restricted client",
      }),
    ]);
    expect(lines.filter(line => !isEntry(line))).toEqual([]);
  }, recording);
});
