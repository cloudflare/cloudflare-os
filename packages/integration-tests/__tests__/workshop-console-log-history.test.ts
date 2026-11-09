import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, droppedGadgetConsoleLogsText, getAdminAccessErrorCode,
  getOpenWorkspaceErrorCode, MAX_GADGET_CONSOLE_LOGS_PER_CALL, OPEN_WORKSPACE_ERROR_CODES,
  type AdminAccessErrorCode, type AdminAccessRecord, type AdminApi, type AdminWorkspaceView,
  type AuthenticatedApi, type ConsoleLogEvent, type ConsoleLogSubscriber, type GadgetClient,
  type GadgetConsoleLogEntry, type GadgetConsoleLogQuery, type Overseer,
  type ReportedGadgetConsoleLog, type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import type {
  SubmitExternalMessageResult,
} from "@gadgets/workshop-shared/external-message-gateway";
import {
  ADMIN_USERNAME, settleRestart, startHarness, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR,
  testControl, type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, logIn, nextUsernames, RpcTarget, signUp, stubFor, waitFor, WorkpieceRecorder,
} from "../src/rpc-client.js";

const REASON = "Support ticket 123";
// The time the reports of this file say their console calls were made at.
const REPORTED_AT = new Date("2026-03-04T05:06:07.890Z");
// How long after an export the task it leaves running logs, where a test asks for one: long enough
// for a workspace to be deleted, its key to name another, and that one's owner to open it.
const LATE_EXPORT_MS = 5_000;
// The one format the gadget's export handler offers.
const CSV = {
  id: "csv", label: "CSV", mode: "server", contentType: "text/csv", fileExtension: ".csv",
};

// The deployment's admin access level is one setting, and the tests tell a workspace's log object
// from the others by which one appears, so this file owns its harness and runs serially.
const network = new NetworkInterceptor();
const fileScope = new DisposableStack();
let harness: Harness;
let admin: RpcStub<AdminApi>;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR }],
    enableGadgetExecution: true,
    patchWorkshop: config => {
      config.vars = { ...config.vars, ADMIN_WORKSPACE_ACCESS_MAX: "full" };
    },
  });
  const api = fileScope.use(await signUp(fileScope.use(connect(harness.url)), ADMIN_USERNAME));
  const stub = await api.getAdminApi();
  if (stub === null) throw new Error(`The admin API was unavailable to ${ADMIN_USERNAME}`);
  admin = fileScope.use(stub);
});

afterAll(async () => {
  try {
    fileScope.dispose();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

// A gadget server whose `greet()` prints under `label`, whose `greetAfter()` waits before it does
// and whose `fail()` throws, with an export handler that prints too. Given `lateMs`, an export
// leaves a task running that prints after that long, and prints nothing before.
const server = (label: string, level: "log" | "warn", lateMs?: number) =>
  `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
export class Gadget extends DurableObject {
  greet(name) { console.${level}("${label}", name); return name; }
  async greetAfter(ms, name) { await scheduler.wait(ms); return this.greet(name); }
  fail() { throw new Error("boom"); }
}
export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(_gadget) {
    console.log("formats asked");
    return [${JSON.stringify(CSV)}];
  }
  async export(gadget, _id) {${lateMs === undefined ? "" : `
    this.ctx.waitUntil(
        scheduler.wait(${lateMs}).then(() => console.log("${label}", "after export")));`}
    return new Response(await gadget.greet("export")).body;
  }
}
`;
const MAINLINE = server("mainline", "log");

const files = (gadgetId: WorkpieceId, text?: string): CodeContent =>
  new Map([[gadgetId, new Map(text === undefined ? [] : [["server.js", text]])]]);

type Workspace = {
  api: RpcStub<AuthenticatedApi>;
  ws: RpcStub<Overseer>;
  /** The workspace's id. */
  id: string;
  /** The owner's profile id, which a "client" entry of theirs is labelled with. */
  userId: string;
  workpieces: WorkpieceRecorder;
};

/** A fresh owner's workspace, which has kept no console log. */
async function newWorkspace(stack: DisposableStack, prefix: string): Promise<Workspace> {
  const [username] = nextUsernames(prefix);
  const api = stack.use(await signUp(stack.use(connect(harness.url)), username!));
  const ws = stack.use(await api.newWorkspace());
  const workpieces = new WorkpieceRecorder();
  stack.use(await ws.subscribeToWorkpieces(stack.use(stubFor(workpieces))));
  await workpieces.loaded;
  return { api, ws, id: (await ws.getMetadata()).id, userId: (await api.whoami()).id, workpieces };
}

type LoggingGadget = {
  gadget: RpcStub<GadgetClient>;
  gadgetId: WorkpieceId;
  /** The gadget's head: the commit that holds the `MAINLINE` server. */
  head: string;
  /** The chat that commit was merged from, which holds no draft of the gadget any more. */
  seed: number;
};

/** A gadget of `ws` with `text` merged as its server, through a chat no model answers. */
async function loggingGadget(
    stack: DisposableStack, { ws, workpieces }: Workspace, title = "App", bindingName = "APP",
    text = MAINLINE): Promise<LoggingGadget> {
  const gadget = stack.use(await ws.createGadget(title, undefined, bindingName));
  const gadgetId = await gadget.getId();
  const headOf = (after?: string) => waitFor(`a new head for gadget ${gadgetId}`, async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined &&
        summary.commitId !== after ? summary.commitId : null;
  });
  const empty = await headOf();
  const seed = await ws.newChat(`Seed ${title}`, null);
  await ws.submitCodeChange(seed, {
    generation: 0, revision: 0, clientId: "seed", seq: 1, pins: [{ gadgetId, baseCommit: empty }],
    change: diffFiles(files(gadgetId), files(gadgetId, text)),
  });
  expect(await ws.mergeChanges(seed)).toEqual({ outcome: "merged" });
  return { gadget, gadgetId, head: await headOf(empty), seed };
}

/** A chat whose finalized draft of the gadget is the "draft" server, which warns. */
async function draftOf({ ws }: Workspace, { gadgetId, head }: LoggingGadget): Promise<number> {
  const draft = await ws.newChat("Draft", null);
  await ws.submitCodeChange(draft, {
    generation: 0, revision: 0, clientId: "draft", seq: 1, pins: [{ gadgetId, baseCommit: head }],
    change: diffFiles(files(gadgetId, MAINLINE), files(gadgetId, server("draft", "warn"))),
  });
  await ws.finalizeChatDraft(draft);
  return draft;
}

/** Call the gadget's server, as the mainline or under `chatId`. */
async function greet(gadget: RpcStub<GadgetClient>, name: string, chatId?: number) {
  using facet = await gadget.connectToGadget(chatId) as RpcStub<{ greet(name: string): string }>;
  expect(await facet.greet(name)).toBe(name);
}

/** Call the server's `fail()`, as the mainline or under `chatId`, and expect its error. */
async function fail(gadget: RpcStub<GadgetClient>, chatId?: number) {
  using facet = await gadget.connectToGadget(chatId) as RpcStub<{ fail(): void }>;
  await expect(facet.fail()).rejects.toThrow(/boom/);
}

/** A console call as a browser reports it. */
const reported = (text: string, level: ConsoleLogEvent["level"] = "log")
    : ReportedGadgetConsoleLog => ({ time: REPORTED_AT, level, text });

/** The "client" entry kept for `reported(text, level)`, for toStrictEqual(). */
const clientEntry = (
    gadgetId: WorkpieceId, chatId: number | null, userId: string, text: string,
    level: ConsoleLogEvent["level"] = "log"): GadgetConsoleLogEntry =>
  ({ time: REPORTED_AT, gadgetId, chatId, source: "client", userId, level, text });

/** The "server" entry kept for a console call, for toStrictEqual(): it names no user. */
const serverEntry = (
    gadgetId: WorkpieceId, chatId: number | null, level: ConsoleLogEvent["level"],
    text: unknown) =>
  ({ time: expect.any(Date), gadgetId, chatId, source: "server", level, text });

/** The entries a build session or an admin's view lists for `query`, newest first. */
async function kept(
    reader: RpcStub<Overseer> | RpcStub<AdminWorkspaceView>, query?: GadgetConsoleLogQuery)
    : Promise<GadgetConsoleLogEntry[]> {
  const page = await reader.listConsoleLogs(query);
  // No test keeps more than a page.
  expect(page.nextCursor).toBeUndefined();
  return page.entries;
}

/** Wait until an entry `matches` among those `ws` lists for `query`: the newest such entry. */
function keptEntry(
    ws: RpcStub<Overseer>, query: GadgetConsoleLogQuery, what: string,
    matches: (entry: GadgetConsoleLogEntry) => boolean): Promise<GadgetConsoleLogEntry> {
  return waitFor(what, async () => (await kept(ws, query)).find(matches) ?? null);
}

/** Wait until the server's console call that printed `text` is kept, and return its entry. */
const keptCall = (ws: RpcStub<Overseer>, gadgetId: WorkpieceId, text: string) =>
  keptEntry(ws, { gadgetId, source: "server" }, `the kept console call "${text}"`,
      entry => entry.text === text);

/** The ids of the log objects that have storage, in a stable order. */
async function logObjectIds(): Promise<string[]> {
  return (await harness.server.getWorker("workshop-backend")
      .listDurableObjectIds("WorkspaceLogDurableObject")).toSorted();
}

/** The code `call` is refused with; throws if it succeeds. */
async function refusalOf(call: PromiseLike<unknown>): Promise<AdminAccessErrorCode | undefined> {
  try {
    await call;
  } catch (error) {
    return getAdminAccessErrorCode(error);
  }
  throw new Error("The call was not refused");
}

/** The newest record of the deployment-wide audit log about workspace `id`. */
async function newestAccessRecord(id: string): Promise<AdminAccessRecord> {
  const [record] = (await admin.listAdminAudit({ workspace: id, limit: 1 })).records;
  if (record?.kind !== "workspace") throw new Error("Expected a workspace access record");
  return record;
}

type Live = { chatId: number | null; level: ConsoleLogEvent["level"]; message: unknown[] };

class LiveRecorder extends RpcTarget implements ConsoleLogSubscriber {
  readonly logs: Live[] = [];
  async event(chatId: number | null, logs: ConsoleLogEvent[]) {
    this.logs.push(...logs.map(({ level, message }) => ({ chatId, level, message })));
  }
}

it("keeps a gadget's server console calls and a reported client batch, for a build session to read",
    async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "logowner");
  const { ws, userId } = workspace;
  const app = await loggingGadget(stack, workspace);
  const { gadget, gadgetId, seed } = app;
  const draft = await draftOf(workspace, app);
  const live = new LiveRecorder();
  stack.use(await ws.subscribeToConsoleLogs(stack.use(stubFor(live))));

  await greet(gadget, "Grace");
  const mainlineCall = await keptCall(ws, gadgetId, "mainline Grace");
  expect(mainlineCall).toStrictEqual(serverEntry(gadgetId, null, "log", "mainline Grace"));
  await greet(gadget, "Ada", draft);
  const draftCall = await keptCall(ws, gadgetId, "draft Ada");
  expect(draftCall).toStrictEqual(serverEntry(gadgetId, draft, "warn", "draft Ada"));

  // A null chat is a filter of its own over the wire, and not the absence of one.
  expect(await kept(ws, { gadgetId, chatId: draft })).toStrictEqual([draftCall]);
  expect(await kept(ws, { gadgetId, chatId: null })).toStrictEqual([mainlineCall]);
  expect(await kept(ws, { gadgetId })).toStrictEqual([draftCall, mainlineCall]);

  // An exception is kept under the chat whose draft threw. The seed chat holds no draft of the
  // gadget, so a stub asked for under it runs the mainline. The ending is what the Workshop adds
  // to an exception it catches, which tells the entry from one the call's trace may bring.
  const failures = async () => (await kept(ws, { gadgetId, source: "server", level: "error" }))
      .filter(entry => entry.text.endsWith("at fail()"));
  const failure = (chatId: number | null) =>
    serverEntry(gadgetId, chatId, "error", expect.stringContaining("boom"));
  await fail(gadget, seed);
  await waitFor("the mainline's exception", async () => (await failures()).length > 0 || null);
  expect(await failures()).toStrictEqual([failure(null)]);
  await fail(gadget, draft);
  await waitFor("the draft's exception", async () => (await failures()).length > 1 || null);
  expect(await failures()).toStrictEqual([failure(draft), failure(null)]);

  // An export handler runs for the chat the export was asked under, draft or no draft.
  const formatsAsked = (chatId: number | null) =>
    keptEntry(ws, { gadgetId, chatId }, `the export handler's call under chat ${chatId}`,
        entry => entry.text === "formats asked");
  const formatsCall = (chatId: number | null) =>
    serverEntry(gadgetId, chatId, "log", "formats asked");
  expect(await gadget.getExportFormats(seed)).toEqual([CSV]);
  expect(await formatsAsked(seed)).toStrictEqual(formatsCall(seed));
  expect(await gadget.getExportFormats()).toEqual([CSV]);
  expect(await formatsAsked(null)).toStrictEqual(formatsCall(null));

  // A report is listed as soon as it returns: redacted, under the reporting user, with the time
  // the browser gave.
  const clientEntries = () => kept(ws, { gadgetId, source: "client" });
  expect(await ws.reportGadgetConsoleLogs(gadgetId, null, [
    reported("GET https://api.example/v1?access_token=abc123&x=1 failed", "error"),
  ])).toBeUndefined();
  const mainlineReport = clientEntry(gadgetId, null, userId,
      "GET https://api.example/v1?access_token=[redacted]&x=1 failed", "error");
  expect(await clientEntries()).toStrictEqual([mainlineReport]);
  // A report is kept under the chat it names only where that chat holds a draft of the gadget.
  await ws.reportGadgetConsoleLogs(gadgetId, draft, [reported("from the draft's UI")]);
  await ws.reportGadgetConsoleLogs(gadgetId, seed, [reported("from the seed chat's UI")]);
  const reports = [
    clientEntry(gadgetId, null, userId, "from the seed chat's UI"),
    clientEntry(gadgetId, draft, userId, "from the draft's UI"),
    mainlineReport,
  ];
  expect(await clientEntries()).toStrictEqual(reports);
  await expect(ws.reportGadgetConsoleLogs(gadgetId, draft + 1000, [reported("from no chat")]))
      .rejects.toThrow(/No such chatId/);
  expect(await clientEntries()).toStrictEqual(reports);

  // The source filter separates what the server logged from what browsers reported.
  const all = await kept(ws, { gadgetId });
  const from = (source: GadgetConsoleLogEntry["source"]) =>
    all.filter(entry => entry.source === source);
  expect(from("client")).toStrictEqual(reports);
  expect(from("server")).toEqual(expect.arrayContaining([mainlineCall, draftCall]));
  expect(await kept(ws, { gadgetId, source: "server" })).toStrictEqual(from("server"));

  // A collaborator who may build reads what the owner reads.
  const [builder] = nextUsernames("logbuilder");
  const builderApi = stack.use(await signUp(stack.use(connect(harness.url)), builder!));
  if (!await ws.addCollaborator(builder!, "workspace")) {
    throw new Error(`Failed to share with ${builder}`);
  }
  const builderWs = stack.use(await builderApi.openWorkspace(workspace.id));
  expect(await kept(builderWs, { gadgetId })).toStrictEqual(all);

  // Live delivery stands apart from what is kept: the server's console calls reach a subscriber,
  // under the chats they are kept under, and what browsers report does not. Exceptions are left
  // out of the comparison: one is delivered under the chat its stub was asked for, whatever that
  // chat holds.
  const liveCalls = () => live.logs.filter(log => log.level !== "error");
  await waitFor("the live console calls", async () => liveCalls().length >= 4 || null);
  // Anything already sent to the subscriber's connection arrives before this reply.
  await ws.getMetadata();
  expect(liveCalls()).toEqual([
    { chatId: null, level: "log", message: ["mainline", "Grace"] },
    { chatId: draft, level: "warn", message: ["draft", "Ada"] },
    { chatId: seed, level: "log", message: ["formats asked"] },
    { chatId: null, level: "log", message: ["formats asked"] },
  ]);
  expect(JSON.stringify(live.logs)).not.toContain("api.example");
});

it("gives a use session nothing to read, and keeps what it reports for a gadget it holds",
    async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "logsharer");
  const { ws } = workspace;
  const { gadget, gadgetId, seed } = await loggingGadget(stack, workspace);
  const other = stack.use(await ws.createGadget("Other", undefined, "OTHER"));
  const otherId = await other.getId();

  const [viewer] = nextUsernames("logviewer");
  const viewerApi = stack.use(await signUp(stack.use(connect(harness.url)), viewer!));
  if (!await ws.addCollaborator(viewer!, { gadgetId })) {
    throw new Error(`Failed to share with ${viewer}`);
  }
  const viewerId = (await viewerApi.whoami()).id;
  const useWs = stack.use(await viewerApi.openWorkspace(workspace.id));

  await greet(gadget, "Ada");
  const serverCall = await keptCall(ws, gadgetId, "mainline Ada");
  expect(await useWs.listConsoleLogs()).toEqual({ entries: [] });
  expect(await useWs.listConsoleLogs({ gadgetId })).toEqual({ entries: [] });

  expect(await useWs.reportGadgetConsoleLogs(gadgetId, null, [reported("from the viewer")]))
      .toBeUndefined();
  const viewerReport = clientEntry(gadgetId, null, viewerId, "from the viewer");
  expect(await kept(ws)).toStrictEqual([viewerReport, serverCall]);

  // A gadget the collaborator does not hold is refused as one that does not exist, and a chat is
  // not theirs to name.
  await expect(useWs.reportGadgetConsoleLogs(otherId, null, [reported("for another gadget")]))
      .rejects.toThrow(`No such gadget: ${otherId}`);
  await expect(useWs.reportGadgetConsoleLogs(gadgetId, seed, [reported("under a chat")]))
      .rejects.toThrow(/Unauthorized/);
  expect(await kept(ws)).toStrictEqual([viewerReport, serverCall]);
  expect(await useWs.listConsoleLogs()).toEqual({ entries: [] });
});

it("holds what a use session's failing calls add to a gadget's server entries to 30 a minute",
    async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "logflooded");
  const { ws } = workspace;
  const { gadget, gadgetId } = await loggingGadget(stack, workspace);
  const [viewer] = nextUsernames("logflooder");
  const viewerApi = stack.use(await signUp(stack.use(connect(harness.url)), viewer!));
  if (!await ws.addCollaborator(viewer!, { gadgetId })) {
    throw new Error(`Failed to share with ${viewer}`);
  }
  const useWs = stack.use(await viewerApi.openWorkspace(workspace.id));

  await greet(gadget, "Ada");
  const serverCall = await keptCall(ws, gadgetId, "mainline Ada");

  // Calls for methods the gadget does not have: each error names the method, which its caller
  // chose.
  using facet = await useWs.getGadget(gadgetId).connectToGadget() as
      RpcStub<Record<string, () => void>>;
  for (let call = 0; call < 40; call++) {
    await expect(facet[`forged_${call}_${"Z".repeat(100)}`]!()).rejects.toThrow();
  }

  // The first 30 are kept as the gadget's server's, naming no user, then one marker.
  expect(await keptEntry(ws, { gadgetId, level: "warn" }, "the marker of the dropped calls",
      entry => entry.text === "1 entry dropped"))
      .toStrictEqual(serverEntry(gadgetId, null, "warn", "1 entry dropped"));
  // They are all the errors the gadget has: a call that fails so is kept by nothing else.
  const forged = await kept(ws, { gadgetId, level: "error" });
  expect(forged.map(entry => /at forged_(\d+)_Z+\(\)$/.exec(entry.text)?.[1]).toReversed())
      .toStrictEqual(Array.from({ length: 30 }, (_, call) => String(call)));
  for (const entry of forged) {
    expect(entry).toMatchObject({ gadgetId, chatId: null, source: "server" });
    expect(entry).not.toHaveProperty("userId");
  }
  expect(await kept(ws, { gadgetId, level: "log" })).toStrictEqual([serverCall]);
  expect(await useWs.listConsoleLogs()).toEqual({ entries: [] });
});

it("refuses an admin's read below full access, and records it as a content read at full",
    async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "loginspected");
  const { ws, id } = workspace;
  const { gadget, gadgetId } = await loggingGadget(stack, workspace);
  await greet(gadget, "Ada");
  const serverCall = await keptCall(ws, gadgetId, "mainline Ada");
  // A workspace nothing was ever kept for.
  const quiet = await newWorkspace(stack, "logquiet");

  try {
    using metadataView = await admin.inspectWorkspace(id, REASON);
    expect(await refusalOf(metadataView.listConsoleLogs()))
        .toBe(ADMIN_ACCESS_ERROR_CODES.contentWithheld);
    // Refused by the level after being recorded, so the refusal is in the log.
    const refusedRead = await newestAccessRecord(id);
    expect(refusedRead).toMatchObject({
      method: "listConsoleLogs", requested: "metadata", access: "metadata", exposed: "metadata",
      refused: ADMIN_ACCESS_ERROR_CODES.contentWithheld,
    });
    // A read with no query records no argument: an absent chat is not the mainline's filter.
    expect(refusedRead.args).toEqual({});

    await admin.setAdminWorkspaceAccess("full");
    using fullView = await admin.inspectWorkspace(id, REASON, { access: "full" });
    const query = { gadgetId, chatId: null, source: "server" as const, since: new Date(0) };
    expect(await kept(fullView, query)).toStrictEqual([serverCall]);
    const read = await newestAccessRecord(id);
    expect(read).toMatchObject({
      method: "listConsoleLogs", requested: "full", access: "full", exposed: "content",
    });
    expect(read).not.toHaveProperty("refused");
    // A recorded argument is a string or a number, so the null chat is recorded as a word.
    expect(read.args).toEqual({
      gadgetId, chatId: "mainline", source: "server", since: new Date(0).toISOString(),
    });
    expect((await admin.listAdminAudit({ workspace: id, exposed: "content" })).records)
        .toEqual([read]);

    // A read of a workspace that kept nothing answers without visiting a log object, which
    // would give that object storage.
    const before = await logObjectIds();
    using quietView = await admin.inspectWorkspace(quiet.id, REASON, { access: "full" });
    expect(await quietView.listConsoleLogs()).toEqual({ entries: [] });
    const quietRead = await newestAccessRecord(quiet.id);
    expect(quietRead).toMatchObject({
      method: "listConsoleLogs", access: "full", exposed: "metadata",
    });
    expect(quietRead.args).toEqual({});
    expect(await logObjectIds()).toEqual(before);
  } finally {
    await admin.setAdminWorkspaceAccess("metadata");
  }
});

it("deletes a workspace's log with the workspace", async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "logdeleted");
  const { api, ws, id } = workspace;
  const { gadget, gadgetId } = await loggingGadget(stack, workspace);

  // The log object has a name of its own, which only the workspace knows, so it is found by
  // being the one that appears with the workspace's first entry.
  const before = await logObjectIds();
  await greet(gadget, "Ada");
  await keptCall(ws, gadgetId, "mainline Ada");
  const created = (await logObjectIds()).filter(candidate => !before.includes(candidate));
  expect(created).toHaveLength(1);

  // Miniflare's own tables, which any visit to an object creates, are left out.
  const storage = await harness.server.getWorker("workshop-backend")
      .getDurableObjectStorage("WorkspaceLogDurableObject", { id: created[0]! });
  const tables = async () => (await storage.exec<{ name: string }>(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT GLOB '__miniflare*' ORDER BY name`)).map(row => row.name);
  expect(await tables()).toContain("console_logs");
  expect(await storage.exec<{ n: number }>("SELECT COUNT(*) AS n FROM console_logs"))
      .toEqual([{ n: 1 }]);

  await ws.deleteSelf();
  await settleRestart();
  expect(await tables()).not.toContain("console_logs");

  // Neither refusal brings the log back, nor makes another.
  expect(await refusalOf(admin.inspectWorkspace(id, REASON)))
      .toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
  let openError: unknown;
  try {
    stack.use(await api.openWorkspace(id));
  } catch (error) {
    openError = error;
  }
  expect(getOpenWorkspaceErrorCode(openError)).toBe(OPEN_WORKSPACE_ERROR_CODES.workspaceNotFound);
  expect(await tables()).not.toContain("console_logs");
  expect(await logObjectIds()).toEqual([...before, ...created].toSorted());
});

it("keeps nothing a deleted workspace's gadget logs once its key names a workspace again",
    async () => {
  using stack = new DisposableStack();
  const [first, next] = nextUsernames("logfirstlife", "lognextlife");
  const apiFirst = stack.use(await signUp(stack.use(connect(harness.url)), first!));
  stack.use(await signUp(stack.use(connect(harness.url)), next!));

  // A workspace named by key belongs to whoever posts to the key while it names none.
  const gadgetKey = `log-lives-${first}`;
  const post = (callerEmail: string) =>
    testControl<SubmitExternalMessageResult>(harness, "submit-external-message", {
      callerEmail, gadgetKey, chatKey: `${gadgetKey}-chat`, messageKey: crypto.randomUUID(),
      gadgetTitle: gadgetKey, prompt: "hello",
    });
  await post(first!);
  const { gadgetId: id } = await testControl<{ gadgetId: string }>(
      harness, "external-gadget-id", { gadgetKey });
  const ws = stack.use(await apiFirst.openWorkspace(id));
  const workpieces = new WorkpieceRecorder();
  stack.use(await ws.subscribeToWorkpieces(stack.use(stubFor(workpieces))));
  await workpieces.loaded;
  const workspace = { api: apiFirst, ws, id, userId: (await apiFirst.whoami()).id, workpieces };
  const { gadget, gadgetId } = await loggingGadget(
      stack, workspace, "App", "APP", server("mainline", "log", LATE_EXPORT_MS));
  await greet(gadget, "first life");
  await keptCall(ws, gadgetId, "mainline first life");

  // An export, whose handler is no part of the gadget's object: the restart that follows the
  // deletion does not end the task it leaves running, which logs long after the key names a
  // workspace again, in a request that logged nothing before.
  expect(await new Response(await gadget.export("csv")).text()).toBe("export");

  // Calls still open when the owner deletes the workspace, which log at moments spread over the
  // tenth of a second its gadgets run on for, until the restart that follows the deletion.
  const facet = stack.use(await gadget.connectToGadget() as
      RpcStub<{ greetAfter(ms: number, name: string): string }>);
  const open = [30, 50, 70, 90, 110, 130].map(ms =>
    facet.greetAfter(ms, `late ${ms}`).then(() => {}, () => {}));
  await ws.deleteSelf();

  // The next poster's workspace: the same id, with gadget ids that start again at the same
  // numbers. A post is turned away until the deleted workspace's instance is gone, and one that
  // meets the restart itself fails.
  await waitFor("the key to name a workspace again", async () => {
    const answer = await post(next!).catch(() => null);
    const refused = answer !== null && !answer.accepted &&
        answer.message === "Workspace was deleted.";
    return answer === null || refused ? null : answer;
  });
  await Promise.all(open);
  // A trace is delivered when its call ends, which the restart sees to. The restart closes the
  // connections of the sessions it finds, so the next owner reads on one made after it.
  await settleRestart();
  const apiNext = stack.use(await logIn(stack.use(connect(harness.url)), next!));
  const nextWs = stack.use(await apiNext.openWorkspace(id));
  const live = new LiveRecorder();
  stack.use(await nextWs.subscribeToConsoleLogs(stack.use(stubFor(live))));
  expect((await nextWs.getMetadata()).role).toBe("build");
  expect(await kept(nextWs)).toEqual([]);

  // The export's task logs, and its trace is delivered to the workspace the id names by then,
  // whose live subscribers are told: nothing of it is kept.
  await waitFor("the first life's export to log", async () =>
    live.logs.some(log => log.message[1] === "after export") ? true : null);
  expect(await kept(nextWs)).toEqual([]);
});

it("keeps the first entries of a report over the cap of a call, and says how many it dropped",
    async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "logflood");
  const { ws, userId } = workspace;
  // Nothing was reported for this gadget, so the minute's allowance is whole and only the cap of
  // a call drops anything.
  const { gadgetId } = await loggingGadget(stack, workspace);
  const texts = Array.from(
      { length: MAX_GADGET_CONSOLE_LOGS_PER_CALL + 1 }, (_, index) => `line ${index + 1}`);

  expect(await ws.reportGadgetConsoleLogs(gadgetId, null, texts.map(text => reported(text))))
      .toBeUndefined();
  // Newest first, so the marker, which is kept ahead of the entries it speaks for, comes last.
  expect(await kept(ws, { gadgetId })).toStrictEqual([
    ...texts.slice(0, MAX_GADGET_CONSOLE_LOGS_PER_CALL).toReversed()
        .map(text => clientEntry(gadgetId, null, userId, text)),
    { ...clientEntry(gadgetId, null, userId, droppedGadgetConsoleLogsText(1), "warn"),
      time: expect.any(Date) },
  ]);
});

it("keeps a deleted gadget's entries, listed by its id", async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "logremoved");
  const { ws, id, userId } = workspace;
  const first = await loggingGadget(stack, workspace);
  const second = await loggingGadget(stack, workspace, "Second", "SECOND");

  await greet(first.gadget, "Ada");
  const firstCall = await keptCall(ws, first.gadgetId, "mainline Ada");
  await greet(second.gadget, "Grace");
  const secondCall = await keptCall(ws, second.gadgetId, "mainline Grace");
  await ws.reportGadgetConsoleLogs(second.gadgetId, null, [reported("from the second UI")]);
  const ofSecond = [clientEntry(second.gadgetId, null, userId, "from the second UI"), secondCall];
  expect(await kept(ws, { gadgetId: second.gadgetId })).toStrictEqual(ofSecond);

  await second.gadget.remove();
  expect(await kept(ws, { gadgetId: second.gadgetId })).toStrictEqual(ofSecond);
  expect(await kept(ws)).toStrictEqual([...ofSecond, firstCall]);
  // Nothing more is taken for a gadget that is gone.
  await expect(ws.reportGadgetConsoleLogs(second.gadgetId, null, [reported("after removal")]))
      .rejects.toThrow(`No such gadget: ${second.gadgetId}`);
  expect(await kept(ws, { gadgetId: second.gadgetId })).toStrictEqual(ofSecond);
  expect(await kept(ws, { gadgetId: first.gadgetId })).toStrictEqual([firstCall]);

  try {
    await admin.setAdminWorkspaceAccess("full");
    using view = await admin.inspectWorkspace(id, REASON, { access: "full" });
    expect(await kept(view, { gadgetId: second.gadgetId })).toStrictEqual(ofSecond);
  } finally {
    await admin.setAdminWorkspaceAccess("metadata");
  }
});
