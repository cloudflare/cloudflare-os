// The workspace's gadget error log (docs/gadget-error-log.md), against real Workers: what a
// gadget's server throws and what a session reports for its UI are kept and read back through
// Overseer.readGadgetErrors(), and console calls are not.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  getOpenWorkspaceErrorCode, MAX_GADGET_ERRORS_PER_CALL, OPEN_WORKSPACE_ERROR_CODES,
  type AuthenticatedApi, type ConsoleLogEvent, type ConsoleLogSubscriber, type GadgetClient,
  type GadgetErrorEntry, type GadgetErrorQuery, type Overseer, type ReportedGadgetError,
  type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import type {
  SubmitExternalMessageResult,
} from "@gadgets/workshop-shared/external-message-gateway";
import {
  settleRestart, startTestGatekeeperHarness, TEST_VENDOR_ID, testControl, type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, nextUsernames, RpcTarget, signUp, stubFor, waitFor,
  WorkpieceRecorder,
} from "../src/rpc-client.js";

// How long after an export the task it leaves running throws, where a test asks for one: long
// enough for a workspace to be deleted, its key to name another, and that one's owner to open it.
const LATE_EXPORT_MS = 5_000;
// The one format a gadget's export handler offers, where a test gives it one.
const CSV = {
  id: "csv", label: "CSV", mode: "server", contentType: "text/csv", fileExtension: ".csv",
};
// What a gadget's "client" entries may count before its oldest are dropped.
const CLIENT_BYTES_PER_GADGET = 200_000;

// The tests tell a workspace's log object from the others by which one appears, so this file
// owns its harness and its tests run one after another.
const network = new NetworkInterceptor();
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

// A gadget server whose errors are told apart by `label`. `greet()` only prints. `fail()` and
// `leak()` throw at their caller, and `failAfter()` does once it has waited. `later()` returns,
// leaving a rejected waitUntil() promise: an exception of the gadget's Worker that no caller sees,
// which the runtime reports to the Worker's tail. `exportHandler` is the source of an
// ExportHandler, for a gadget that has one.
const server = (label: string, exportHandler = "") =>
  `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
export class Gadget extends DurableObject {
  greet(name) { console.error("said", name); console.log("also", name); return name; }
  fail() { throw new Error("${label} boom"); }
  async failAfter(ms) { await scheduler.wait(ms); throw new Error("${label} boom after " + ms); }
  leak() { throw new Error("GET https://api.example/v1?access_token=abc123 failed"); }
  later() { this.ctx.waitUntil(Promise.reject(new Error("${label} late"))); return "ok"; }
}
${exportHandler}`;
const MAINLINE = server("mainline");

// An export handler whose export() throws.
const THROWING_EXPORT = `export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(_gadget) { return [${JSON.stringify(CSV)}]; }
  async export(_gadget, _id) { throw new Error("export boom"); }
}
`;

// An export handler whose export() succeeds and leaves a task running that throws `label`'s
// error after LATE_EXPORT_MS, which the runtime reports to the Worker's tail once the task ends.
const lateExport = (label: string) => `export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(_gadget) { return [${JSON.stringify(CSV)}]; }
  async export(_gadget, _id) {
    this.ctx.waitUntil(scheduler.wait(${LATE_EXPORT_MS}).then(() => {
      throw new Error("${label} late export");
    }));
    return new Response("exported").body;
  }
}
`;

// A gadget server that stores a callback with the test gatekeeper's `watch` hook, which throws
// when the hook fires.
const HOOK_SERVER = `import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async [restore](_params) { return new ValueHook(); }
  async watch(key) {
    await this.env.THING.watch(key, await this.ctx.restore({ type: "value-hook" }));
  }
  fail() { throw new Error("hook gadget boom"); }
}
class ValueHook extends RpcTarget {
  async onValueRequested(value) { throw new Error("hook boom " + value); }
}
`;

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

/** `ws` as a Workspace, once its workpieces are loaded. */
async function workspaceOf(
    stack: DisposableStack, api: RpcStub<AuthenticatedApi>, ws: RpcStub<Overseer>)
    : Promise<Workspace> {
  const workpieces = new WorkpieceRecorder();
  stack.use(await ws.subscribeToWorkpieces(stack.use(stubFor(workpieces))));
  await workpieces.loaded;
  return { api, ws, id: (await ws.getMetadata()).id, userId: (await api.whoami()).id, workpieces };
}

/** A fresh owner's workspace, which has kept no gadget error. */
async function newWorkspace(stack: DisposableStack, prefix: string): Promise<Workspace> {
  const [username] = nextUsernames(prefix);
  const api = stack.use(await signUp(stack.use(connect(harness.url)), username!));
  return await workspaceOf(stack, api, stack.use(await api.newWorkspace()));
}

type SeededGadget = {
  gadget: RpcStub<GadgetClient>;
  gadgetId: WorkpieceId;
  /** The gadget's head: the commit that holds the seeded server. */
  head: string;
  /** The chat that commit was merged from, which proposes no change to the gadget. */
  seed: number;
};

/** A gadget of `ws` with `text` merged as its server, through a chat no model answers. */
async function seedGadget(
    stack: DisposableStack, { ws, workpieces }: Workspace, text = MAINLINE, title = "App",
    bindingName = "APP"): Promise<SeededGadget> {
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

/** A chat that proposes `text` as the gadget's server in place of `from`, the server it has. */
async function proposeServer(
    { ws }: Workspace, { gadgetId, head }: SeededGadget, from: string, text: string)
    : Promise<number> {
  const chat = await ws.newChat("Change", null);
  await ws.submitCodeChange(chat, {
    generation: 0, revision: 0, clientId: "change", seq: 1, pins: [{ gadgetId, baseCommit: head }],
    change: diffFiles(files(gadgetId, from), files(gadgetId, text)),
  });
  return chat;
}

/** A chat whose finalized draft of the gadget is the "draft" server. */
async function draftOf(workspace: Workspace, app: SeededGadget): Promise<number> {
  const draft = await proposeServer(workspace, app, MAINLINE, server("draft"));
  await workspace.ws.finalizeChatDraft(draft);
  return draft;
}

/** A collaborator who may only use `gadgetId`, with their session on the workspace. */
async function addViewer(
    stack: DisposableStack, { ws, id }: Workspace, gadgetId: WorkpieceId, prefix: string)
    : Promise<{ useWs: RpcStub<Overseer>; viewerId: string }> {
  const [viewer] = nextUsernames(prefix);
  const viewerApi = stack.use(await signUp(stack.use(connect(harness.url)), viewer!));
  if (!await ws.addCollaborator(viewer!, { gadgetId })) {
    throw new Error(`Failed to share with ${viewer}`);
  }
  return {
    useWs: stack.use(await viewerApi.openWorkspace(id)), viewerId: (await viewerApi.whoami()).id,
  };
}

type SuiteGadget = {
  greet(name: string): string;
  fail(): void;
  failAfter(ms: number): void;
  leak(): void;
  later(): string;
};

/** Call the server's `greet()`, which prints at two levels and throws nothing. */
async function greet(gadget: RpcStub<GadgetClient>, name: string) {
  using facet = await gadget.connectToGadget() as RpcStub<SuiteGadget>;
  expect(await facet.greet(name)).toBe(name);
}

/** Call the `label` server's `fail()`, as the mainline or under `chatId`, and expect its error. */
async function fail(gadget: RpcStub<GadgetClient>, label: string, chatId?: number) {
  using facet = await gadget.connectToGadget(chatId) as RpcStub<SuiteGadget>;
  await expect(facet.fail()).rejects.toThrow(`${label} boom`);
}

/** Call the server's `later()`, which returns and leaves an exception for the Worker's tail. */
async function later(gadget: RpcStub<GadgetClient>) {
  using facet = await gadget.connectToGadget() as RpcStub<SuiteGadget>;
  expect(await facet.later()).toBe("ok");
}

/** Uncaught errors as a browser reports them: a text each and nothing else. */
const reported = (...texts: string[]): ReportedGadgetError[] => texts.map(text => ({ text }));

/** The "server" entry kept for a call that failed with `text`, for toStrictEqual(): no user. */
const serverEntry = (gadgetId: WorkpieceId, chatId: number | null, text: unknown) =>
  ({ time: expect.any(Date), gadgetId, chatId, source: "server", text });

/** The "server" entry kept for the `label` server's `fail()`. */
const failure = (gadgetId: WorkpieceId, chatId: number | null, label: string) =>
  serverEntry(gadgetId, chatId, `Error: ${label} boom\n    at fail()`);

/** The "server" entry kept for the exception that the `label` server's `later()` leaves: its
 * name and message, then the stack the runtime gives. */
const lateFailure = (gadgetId: WorkpieceId, label: string) =>
  serverEntry(gadgetId, null, expect.stringMatching(new RegExp(`^Error: ${label} late\\n\\s+at `)));

/** The "client" entry kept for a report of `text` by `userId`'s session, for toStrictEqual(). */
const clientEntry = (
    gadgetId: WorkpieceId, chatId: number | null, userId: string, text: string) =>
  ({ time: expect.any(Date), gadgetId, chatId, source: "client", userId, text });

/** The entries a build session lists for `query`, newest first. */
async function kept(ws: RpcStub<Overseer>, query?: GadgetErrorQuery): Promise<GadgetErrorEntry[]> {
  const page = await ws.readGadgetErrors(query);
  // No test keeps more than a page.
  expect(page.nextCursor).toBeUndefined();
  return page.entries;
}

/**
 * Wait until `ws` lists `count` entries for `query`, and return what it lists then. A server
 * exception is kept shortly after its call returns, and one from the tail after the tail's delay.
 */
function keptCount(ws: RpcStub<Overseer>, query: GadgetErrorQuery, count: number)
    : Promise<GadgetErrorEntry[]> {
  return waitFor(`${count} kept gadget errors`, async () => {
    const entries = await kept(ws, query);
    return entries.length >= count ? entries : null;
  });
}

const texts = (entries: GadgetErrorEntry[]) => entries.map(entry => entry.text);

/** The ids of the log objects that have storage, in a stable order. */
async function logObjectIds(): Promise<string[]> {
  return (await harness.server.getWorker("workshop-backend")
      .listDurableObjectIds("WorkspaceErrorLogDurableObject")).toSorted();
}

/** The storage of the log object `id`, whose exec() runs SQL in the object. */
function logStorage(id: string) {
  return harness.server.getWorker("workshop-backend")
      .getDurableObjectStorage("WorkspaceErrorLogDurableObject", { id });
}

/**
 * The log object that appears while `keepFirst` keeps a workspace's first entry. The object has
 * a name of its own, which only the workspace knows, so that is how a test finds it. Also
 * answers the ids there were before.
 */
async function logObjectOf(keepFirst: () => Promise<unknown>)
    : Promise<{ id: string; before: string[] }> {
  const before = await logObjectIds();
  await keepFirst();
  const created = (await logObjectIds()).filter(candidate => !before.includes(candidate));
  expect(created).toHaveLength(1);
  return { id: created[0]!, before };
}

type Live = { chatId: number | null; level: ConsoleLogEvent["level"]; message: unknown[] };

class LogRecorder extends RpcTarget implements ConsoleLogSubscriber {
  readonly logs: Live[] = [];
  async event(chatId: number | null, logs: ConsoleLogEvent[]) {
    this.logs.push(...logs.map(({ level, message }) => ({ chatId, level, message })));
  }
  /** Wait for the event whose first value is `first`. */
  told(first: string) {
    return waitFor(`the live event "${first}"`, async () =>
      this.logs.find(log => log.message[0] === first) ?? null);
  }
}

/** A resource URL no other test (or earlier run against the same storage) has used. */
function freshThingUrl(name: string): string {
  return `https://gadgets-test.example/things/${name}-${crypto.randomUUID().slice(0, 8)}`;
}

function reportSubresources(resourceUrl: string): Promise<void> {
  return testControl(harness, "report-subresources", { resourceUrl });
}

it("lists an exception a gadget method throws, an uncaught server exception and a reported " +
    "client error, and no console call", async () => {
  const start = Date.now();
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "errowner");
  const { ws, userId } = workspace;
  const { gadget, gadgetId } = await seedGadget(stack, workspace);
  const live = new LogRecorder();
  stack.use(await ws.subscribeToConsoleLogs(stack.use(stubFor(live))));

  await greet(gadget, "Ada");
  await fail(gadget, "mainline");
  await later(gadget);
  expect(await ws.reportGadgetErrors(gadgetId, null, reported("client boom"))).toBeUndefined();

  // The three are kept by different paths, so in no fixed order.
  const entries = await keptCount(ws, { gadgetId }, 3);
  expect(entries).toHaveLength(3);
  const entry = (text: string) => entries.find(candidate => candidate.text.startsWith(text));
  expect(entry("Error: mainline boom")).toStrictEqual(failure(gadgetId, null, "mainline"));
  expect(entry("Error: mainline late")).toStrictEqual(lateFailure(gadgetId, "mainline"));
  expect(entry("client boom")).toStrictEqual(clientEntry(gadgetId, null, userId, "client boom"));

  // A report's time is the moment it arrived, whatever a browser adds to it.
  await ws.reportGadgetErrors(gadgetId, null, [{ text: "dated", time: new Date(0) } as never]);
  const all = await kept(ws, { gadgetId });
  const end = Date.now();
  expect(all[0]).toStrictEqual(clientEntry(gadgetId, null, userId, "dated"));
  expect(all).toHaveLength(4);
  for (const { time } of all) {
    expect(time.getTime()).toBeGreaterThanOrEqual(start);
    expect(time.getTime()).toBeLessThanOrEqual(end);
  }

  // Neither console call was kept, at either level.
  expect(texts(all).join("\n")).not.toMatch(/said|also/);

  // Live delivery is whole: a subscriber is told both console calls and both exceptions, and
  // nothing of what a browser reported.
  expect(await live.told("said"))
      .toEqual({ chatId: null, level: "error", message: ["said", "Ada"] });
  expect(await live.told("also"))
      .toEqual({ chatId: null, level: "log", message: ["also", "Ada"] });
  expect(await live.told("Error: mainline boom\n    at fail()"))
      .toMatchObject({ chatId: null, level: "error" });
  expect(await live.told("mainline late")).toMatchObject({ chatId: null, level: "error" });
  // Anything already sent to the subscriber's connection arrives before this reply.
  await ws.getMetadata();
  expect(JSON.stringify(live.logs)).not.toMatch(/client boom|dated/);
});

it("keeps a thrown error redacted", async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "errleak");
  const { ws } = workspace;
  const { gadget, gadgetId } = await seedGadget(stack, workspace);

  // The caller gets the gadget's own error, as the gadget threw it.
  using facet = await gadget.connectToGadget() as RpcStub<SuiteGadget>;
  await expect(facet.leak()).rejects.toThrow("access_token=abc123");

  const entries = await keptCount(ws, { gadgetId }, 1);
  expect(entries).toStrictEqual([serverEntry(gadgetId, null,
      "Error: GET https://api.example/v1?access_token=[redacted] failed\n    at leak()")]);
  expect(texts(entries).join("\n")).not.toContain("abc123");
});

it("labels an entry with the chat whose draft threw", async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "errdraft");
  const { ws } = workspace;
  const app = await seedGadget(stack, workspace);
  const { gadget, gadgetId } = app;
  const draft = await draftOf(workspace, app);

  await fail(gadget, "draft", draft);
  await keptCount(ws, { gadgetId }, 1);
  await fail(gadget, "mainline");
  const draftFailure = failure(gadgetId, draft, "draft");
  const mainlineFailure = failure(gadgetId, null, "mainline");
  expect(await keptCount(ws, { gadgetId }, 2)).toStrictEqual([mainlineFailure, draftFailure]);

  // A null chat is a filter of its own over the wire, and not the absence of one.
  expect(await kept(ws, { gadgetId, chatId: draft })).toStrictEqual([draftFailure]);
  expect(await kept(ws, { gadgetId, chatId: null })).toStrictEqual([mainlineFailure]);
  expect(await kept(ws, { gadgetId, source: "server" }))
      .toStrictEqual([mainlineFailure, draftFailure]);
  expect(await kept(ws, { gadgetId, source: "client" })).toStrictEqual([]);
});

it("gives a use session nothing to read, and keeps what it reports for a gadget it holds",
    async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "errsharer");
  const { ws } = workspace;
  const { gadget, gadgetId, seed } = await seedGadget(stack, workspace);
  const other = stack.use(await ws.createGadget("Other", undefined, "OTHER"));
  const otherId = await other.getId();
  const { useWs, viewerId } = await addViewer(stack, workspace, gadgetId, "errviewer");

  await fail(gadget, "mainline");
  const serverFailure = failure(gadgetId, null, "mainline");
  expect(await keptCount(ws, { gadgetId }, 1)).toStrictEqual([serverFailure]);
  await expect(useWs.readGadgetErrors()).rejects.toThrow(/Unauthorized/);
  await expect(useWs.readGadgetErrors({ gadgetId })).rejects.toThrow(/Unauthorized/);

  expect(await useWs.reportGadgetErrors(gadgetId, null, reported("from the viewer")))
      .toBeUndefined();
  const viewerReport = clientEntry(gadgetId, null, viewerId, "from the viewer");
  expect(await kept(ws)).toStrictEqual([viewerReport, serverFailure]);

  // A gadget the collaborator does not hold is refused as one that does not exist, and a chat is
  // not theirs to name.
  await expect(useWs.reportGadgetErrors(otherId, null, reported("for another gadget")))
      .rejects.toThrow(`No such gadget: ${otherId}`);
  await expect(useWs.reportGadgetErrors(gadgetId, seed, reported("under a chat")))
      .rejects.toThrow(/Unauthorized/);
  expect(await kept(ws)).toStrictEqual([viewerReport, serverFailure]);
  await expect(useWs.readGadgetErrors()).rejects.toThrow(/Unauthorized/);
});

it("holds what a use session's failing calls add to a gadget's server entries to 30 a minute",
    async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "errflooded");
  const { ws } = workspace;
  const { gadget, gadgetId } = await seedGadget(stack, workspace);
  const { useWs } = await addViewer(stack, workspace, gadgetId, "errflooder");

  using viewerGadget = await useWs.getGadget(gadgetId);
  using facet = await viewerGadget.connectToGadget() as RpcStub<SuiteGadget>;
  for (let call = 0; call < 40; call++) {
    await expect(facet.fail()).rejects.toThrow("mainline boom");
  }

  // The first 30 are kept as the gadget's server's, naming no user, with one marker for the
  // call that was dropped first. The calls dropped after it in the minute are counted by no
  // marker yet.
  const flooded = await keptCount(ws, { gadgetId }, 31);
  expect(flooded).toHaveLength(31);
  const failures = flooded.filter(entry => entry.text !== "1 error dropped");
  expect(failures).toStrictEqual(
      Array.from({ length: 30 }, () => failure(gadgetId, null, "mainline")));
  expect(flooded.filter(entry => entry.text === "1 error dropped"))
      .toStrictEqual([serverEntry(gadgetId, null, "1 error dropped")]);

  // The failed calls used up the gadget's minute of failed calls, and not the minute of the
  // exceptions the runtime reports for it: one of those is still kept.
  await later(gadget);
  const all = await keptCount(ws, { gadgetId }, 32);
  expect(all).toHaveLength(32);
  expect(all[0]).toStrictEqual(lateFailure(gadgetId, "mainline"));
  expect(await kept(ws, { gadgetId, source: "client" })).toStrictEqual([]);
  await expect(useWs.readGadgetErrors()).rejects.toThrow(/Unauthorized/);
});

it("keeps the first errors of a report over the cap of a call, and says how many it dropped",
    async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "errcapped");
  const { ws, userId } = workspace;
  // Nothing was reported for this gadget, so the minute's allowance is whole and only the cap of
  // a call drops anything.
  const { gadgetId } = await seedGadget(stack, workspace);
  const lines = Array.from(
      { length: MAX_GADGET_ERRORS_PER_CALL + 5 }, (_, index) => `line ${index + 1}`);

  expect(await ws.reportGadgetErrors(gadgetId, null, reported(...lines))).toBeUndefined();
  // Newest first, so the marker, which is kept ahead of the errors it speaks for, comes last.
  expect(await kept(ws, { gadgetId })).toStrictEqual([
    ...lines.slice(0, MAX_GADGET_ERRORS_PER_CALL).toReversed()
        .map(text => clientEntry(gadgetId, null, userId, text)),
    clientEntry(gadgetId, null, userId, "5 errors dropped"),
  ]);
});

it("drops a gadget's oldest reported errors once they pass its bound", async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "errbounded");
  const { ws, userId } = workspace;
  const { gadget, gadgetId } = await seedGadget(stack, workspace);

  // A server entry, which what is reported must not push out.
  const { id } = await logObjectOf(async () => {
    await fail(gadget, "mainline");
    await keptCount(ws, { gadgetId }, 1);
  });
  const storage = await logStorage(id);

  // The limit of a minute keeps reports far from a byte bound, so the gadget's "client" entries
  // are brought to just under theirs by rows written in the log object itself, oldest first,
  // each counting what the row says.
  const rowBytes = 19_990;
  const old = Array.from({ length: 10 }, (_, index) => `old ${index + 1}`);
  expect(old.length * rowBytes).toBeLessThan(CLIENT_BYTES_PER_GADGET);
  const now = Date.now();
  for (const text of old) {
    await storage.exec(
        `INSERT INTO gadget_errors (kept_at, at, gadget_id, chat_id, source, user_id, text, bytes)
         VALUES (?, ?, ?, NULL, 'client', ?, ?, ?)`, now, now, gadgetId, userId, text, rowBytes);
  }
  const reports = { gadgetId, source: "client" as const };
  expect(texts(await kept(ws, reports))).toStrictEqual(old.toReversed());

  // Three more pass the bound by less than one of the rows counts, so the oldest row goes.
  await ws.reportGadgetErrors(gadgetId, null, reported("new 1", "new 2", "new 3"));
  expect(texts(await kept(ws, reports)))
      .toStrictEqual(["new 3", "new 2", "new 1", ...old.slice(1).toReversed()]);
  const [{ bytes }] = await storage.exec<{ bytes: number }>(
      `SELECT SUM(bytes) AS bytes FROM gadget_errors WHERE gadget_id = ? AND source = 'client'`,
      gadgetId);
  expect(bytes).toBeLessThanOrEqual(CLIENT_BYTES_PER_GADGET);
  expect(bytes).toBeGreaterThan((old.length - 1) * rowBytes);

  // Neither source pushes out the other's entries.
  expect(await kept(ws, { gadgetId, source: "server" }))
      .toStrictEqual([failure(gadgetId, null, "mainline")]);
});

it("keeps a deleted gadget's entries, listed by its id", async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "errremoved");
  const { ws, userId } = workspace;
  const first = await seedGadget(stack, workspace);
  const second = await seedGadget(stack, workspace, server("second"), "Second", "SECOND");

  await fail(first.gadget, "mainline");
  const ofFirst = [failure(first.gadgetId, null, "mainline")];
  expect(await keptCount(ws, { gadgetId: first.gadgetId }, 1)).toStrictEqual(ofFirst);
  await fail(second.gadget, "second");
  await keptCount(ws, { gadgetId: second.gadgetId }, 1);
  await ws.reportGadgetErrors(second.gadgetId, null, reported("from the second UI"));
  const ofSecond = [
    clientEntry(second.gadgetId, null, userId, "from the second UI"),
    failure(second.gadgetId, null, "second"),
  ];
  expect(await kept(ws, { gadgetId: second.gadgetId })).toStrictEqual(ofSecond);

  await second.gadget.remove();
  expect(await kept(ws, { gadgetId: second.gadgetId })).toStrictEqual(ofSecond);
  expect(await kept(ws)).toStrictEqual([...ofSecond, ...ofFirst]);
  // Nothing more is taken for a gadget that is gone.
  await expect(ws.reportGadgetErrors(second.gadgetId, null, reported("after removal")))
      .rejects.toThrow(`No such gadget: ${second.gadgetId}`);
  expect(await kept(ws, { gadgetId: second.gadgetId })).toStrictEqual(ofSecond);
  expect(await kept(ws, { gadgetId: first.gadgetId })).toStrictEqual(ofFirst);
});

it("deletes a workspace's log with the workspace", async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "errdeleted");
  const { api, ws, id } = workspace;
  const { gadget, gadgetId } = await seedGadget(stack, workspace);

  const log = await logObjectOf(async () => {
    await fail(gadget, "mainline");
    await keptCount(ws, { gadgetId }, 1);
  });

  // Miniflare's own tables, which any visit to an object creates, are left out.
  const storage = await logStorage(log.id);
  const tables = async () => (await storage.exec<{ name: string }>(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT GLOB '__miniflare*' ORDER BY name`)).map(row => row.name);
  expect(await tables()).toContain("gadget_errors");
  expect(await storage.exec<{ n: number }>("SELECT COUNT(*) AS n FROM gadget_errors"))
      .toEqual([{ n: 1 }]);

  await ws.deleteSelf();
  await settleRestart();
  expect(await tables()).not.toContain("gadget_errors");

  // The refusal does not bring the log back, nor make another.
  let openError: unknown;
  try {
    stack.use(await api.openWorkspace(id));
  } catch (error) {
    openError = error;
  }
  expect(getOpenWorkspaceErrorCode(openError)).toBe(OPEN_WORKSPACE_ERROR_CODES.workspaceNotFound);
  expect(await tables()).not.toContain("gadget_errors");
  expect(await logObjectIds()).toEqual([...log.before, log.id].toSorted());
});

it("keeps no error of a deleted workspace's gadget once its id names a workspace again",
    async () => {
  using stack = new DisposableStack();
  const [first, next] = nextUsernames("errfirstlife", "errnextlife");
  const apiFirst = stack.use(await signUp(stack.use(connect(harness.url)), first!));
  stack.use(await signUp(stack.use(connect(harness.url)), next!));

  // A workspace named by key belongs to whoever posts to the key while it names none.
  const gadgetKey = `error-lives-${first}`;
  const post = (callerEmail: string) =>
    testControl<SubmitExternalMessageResult>(harness, "submit-external-message", {
      callerEmail, gadgetKey, chatKey: `${gadgetKey}-chat`, messageKey: crypto.randomUUID(),
      gadgetTitle: gadgetKey, prompt: "hello",
    });
  await post(first!);
  const { gadgetId: id } = await testControl<{ gadgetId: string }>(
      harness, "external-gadget-id", { gadgetKey });
  const workspace = await workspaceOf(stack, apiFirst, stack.use(await apiFirst.openWorkspace(id)));
  const { ws } = workspace;
  const { gadget, gadgetId } =
      await seedGadget(stack, workspace, server("first life", lateExport("first life")));
  await fail(gadget, "first life");
  await keptCount(ws, { gadgetId }, 1);

  // An export, whose handler is no part of the gadget's object: the restart that follows the
  // deletion does not end the task it leaves running, which throws long after the key names a
  // workspace again.
  expect(await new Response(await gadget.export("csv")).text()).toBe("exported");

  // Calls still open when the owner deletes the workspace, which fail at moments spread over the
  // tenth of a second its gadgets run on for, until the restart that follows the deletion.
  const facet = stack.use(await gadget.connectToGadget() as RpcStub<SuiteGadget>);
  const open = [30, 50, 70, 90, 110, 130].map(ms => facet.failAfter(ms).then(() => {}, () => {}));
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
  // The restart closes the connections of the sessions it finds, so the next owner reads on one
  // made after it.
  await settleRestart();
  const apiNext = stack.use(await logIn(stack.use(connect(harness.url)), next!));
  const nextLife = await workspaceOf(stack, apiNext, stack.use(await apiNext.openWorkspace(id)));
  const nextWs = nextLife.ws;
  const live = new LogRecorder();
  stack.use(await nextWs.subscribeToConsoleLogs(stack.use(stubFor(live))));
  expect((await nextWs.getMetadata()).role).toBe("build");
  expect(await kept(nextWs)).toEqual([]);

  // The id's next life keeps an entry of its own, in a log object of its own, for a gadget that
  // has the id the deleted one had. Its first merge repeats the code version of the deleted
  // workspace's as well, and a call then loads a Worker of this life all the same: one that runs
  // this life's server, and whose tail names this life's log object.
  const nextApp = await seedGadget(stack, nextLife, server("next life"));
  expect(nextApp.gadgetId).toBe(gadgetId);
  await fail(nextApp.gadget, "next life");
  const own = failure(gadgetId, null, "next life");
  expect(await keptCount(nextWs, {}, 1)).toStrictEqual([own]);

  // The export's task throws, and its trace is delivered to the workspace the id names by then,
  // whose live subscribers are told. Nothing of it is kept: an exception of the next life's own
  // gadget that takes the same way, made after it, is kept, and is all that joins the listing.
  await live.told("first life late export");
  await later(nextApp.gadget);
  expect(await keptCount(nextWs, {}, 2)).toStrictEqual([lateFailure(gadgetId, "next life"), own]);
});

it("lists the throw of a hook's firing", async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "errhook");
  const { api, ws } = workspace;
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the test account to be provisioned", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
  const resourceUrl = freshThingUrl("error-hook");
  const key = `error-hook-${crypto.randomUUID()}`;
  await reportSubresources(resourceUrl);
  const connection = stack.use(await ws.newGatekeeper(account.id, resourceUrl));
  if (!connection) throw new Error(`Failed to connect ${resourceUrl}`);
  const { gadget, gadgetId } = await seedGadget(stack, workspace, HOOK_SERVER);
  await gadget.bind("THING", await connection.getId());

  using facet = await gadget.connectToGadget() as
      RpcStub<{ watch(key: string): Promise<void>; fail(): void }>;
  await facet.watch(key);
  const [hook] = await ws.listHooks();
  if (!hook) throw new Error("The gadget did not register its hook");
  expect(hook).toMatchObject({ gadgetId, enabled: false });
  await ws.enableHook(hook.id);

  // The firing calls the callback stored with the hook, which no session's stub stands before.
  // Its throw fails the firing and is kept as the gadget's, naming the callback's method.
  const fire = () => testControl<{ fired: true } | { error: string }>(harness, "fire-hook",
      { key, value: 7, resourceUrl, subresources: ["hook-doc"] });
  const thrown = serverEntry(gadgetId, null, "Error: hook boom 7\n    at onValueRequested()");
  expect(await fire()).toEqual({ error: expect.stringContaining("hook boom 7") });
  expect(await keptCount(ws, { gadgetId }, 1)).toStrictEqual([thrown]);
  expect(await fire()).toEqual({ error: expect.stringContaining("hook boom 7") });
  expect(await keptCount(ws, { gadgetId }, 2)).toStrictEqual([thrown, thrown]);

  // A firing that is refused is not a failed call: nothing is kept for it. A call that fails
  // after it is kept, and is all that joins the listing.
  await ws.disableHook(hook.id);
  expect(await fire()).toEqual({ error: expect.stringContaining("deleted or disabled") });
  await expect(facet.fail()).rejects.toThrow("hook gadget boom");
  expect(await keptCount(ws, { gadgetId }, 3)).toStrictEqual([
    serverEntry(gadgetId, null, "Error: hook gadget boom\n    at fail()"), thrown, thrown,
  ]);
});

it("keeps the Workshop's own failure of a call once, and nothing for reading export formats",
    async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "errnosuch");
  const { ws } = workspace;
  const { gadget, gadgetId } = await seedGadget(stack, workspace);

  // The gadget has no such method, so the error is the Workshop's and none of the gadget's code
  // ran. It is kept as the gadget's all the same.
  using facet = await gadget.connectToGadget() as RpcStub<{ nosuch(): void }>;
  await expect(facet.nosuch()).rejects.toThrow();
  const [missing] = await keptCount(ws, { gadgetId }, 1);
  expect(missing).toStrictEqual(
      serverEntry(gadgetId, null, expect.stringMatching(/\n    at nosuch\(\)$/)));

  // What the Workshop does each time the gadget's export menu is opened. The gadget has no
  // ExportHandler, which is no error.
  expect(await gadget.getExportFormats()).toEqual([]);

  // An exception that the tail brings, made after both: once it is kept, a trace of either would
  // have been. Neither the missing method nor the missing ExportHandler was kept through the tail.
  await later(gadget);
  expect(await keptCount(ws, { gadgetId }, 2))
      .toStrictEqual([lateFailure(gadgetId, "mainline"), missing]);
});

it("lists what a gadget's ExportHandler throws", async () => {
  using stack = new DisposableStack();
  const workspace = await newWorkspace(stack, "errexport");
  const { ws } = workspace;
  const { gadget, gadgetId } =
      await seedGadget(stack, workspace, server("exporting", THROWING_EXPORT));

  // A handler that answers keeps nothing.
  expect(await gadget.getExportFormats()).toEqual([CSV]);
  await expect(gadget.export("csv")).rejects.toThrow("export boom");
  const thrown = serverEntry(gadgetId, null, "Error: export boom\n    at ExportHandler.export()");
  expect(await keptCount(ws, { gadgetId }, 1)).toStrictEqual([thrown]);

  // The handler's throw is kept once: an exception that the tail brings, made after it, is all
  // that joins the listing.
  await later(gadget);
  expect(await keptCount(ws, { gadgetId }, 2))
      .toStrictEqual([lateFailure(gadgetId, "exporting"), thrown]);
});
