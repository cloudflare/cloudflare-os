import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ADMIN_AGENT_ACTIONS } from "@gadgets/workshop-shared/admin-agent";
import {
  ADMIN_ACCESS_ERROR_CODES, createAdminAccessError, type AdminApi, type GadgetClient,
  type Overseer,
} from "@gadgets/workshop-shared/api";
import type { Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { waitFor, type ConnectedAccount } from "../src/rpc-client.js";
import {
  addAdminConnection, adminApiOf, agentTurn, auditRecords, buildGadget, callsOf, codeResults,
  codeStep, fileReport, GRACE, isRestricted, newMember, newUser, newWorkspace, observationTitles,
  OWNER, pendingActions, provisionAdminAccount, recordingGadget, startAdminHarness, turnModels,
  VENDOR, type AdminConnection, type HookCall, type HookMethod, type Recorder, type Suite,
  type SuiteUser,
} from "./admin-gatekeeper-harness.js";

// The gatekeeper's three hooks, fired into a gadget's stored callback, and what reaches an agent
// a gadget spawns: nothing unless its spawner names the connection, or a stub the gadget hands it.
//
// A hook is called for every report of the deployment, so this file owns its harness and its
// cases run in order.
const models = turnModels();
const network = new NetworkInterceptor({ handlers: [models.handler] });
const scope = new DisposableStack();
let harness: Harness;
let suite: Suite;
let owner: SuiteUser;
let admin: RpcStub<AdminApi>;
let ownerAccount: ConnectedAccount;

beforeAll(async () => {
  network.install();
  harness = await startAdminHarness();
  suite = { harness, models, scope };
  owner = await newUser(suite, OWNER);
  admin = await adminApiOf(suite, owner);
  await admin.setGatekeeperMode(VENDOR, "optional");
  await admin.setAdminWorkspaceAccess("content");
  ownerAccount = await provisionAdminAccount(owner);
});

afterAll(async () => {
  try {
    scope.dispose();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

type Watcher = { ws: RpcStub<Overseer>; connection: AdminConnection; facet: RpcStub<Recorder> };

/** A workspace of the owner whose recording gadget has subscribed `hooks` with one callback. */
async function watcher(title: string, hooks: HookMethod[]): Promise<Watcher> {
  const { ws } = await newWorkspace(suite, owner, title);
  const connection = await addAdminConnection(ws, ownerAccount.id);
  return { ws, connection, facet: await recordingGadget(suite, owner, ws, connection, hooks) };
}

// The workspace that watches the first two hooks, set up by the first case and used by the second.
let recording: Watcher;

it("calls a gadget's stored callback once for each new report and each end of an " +
    "investigation, with ids and labels only", async () => {
  recording = await watcher(
      "Triage, watching", ["subscribeIssueReported", "subscribeInvestigationComplete"]);
  const { ws, facet } = recording;
  // Subscribing binds each hook disabled: nothing is delivered until a person enables it.
  const hooks = await ws.listHooks();
  expect(hooks.map(hook => [hook.description.title, hook.enabled])).toEqual([
    ["Watch for new issue reports", false], ["Watch for investigations that end", false],
  ]);
  const unseen = await fileReport(await newMember(suite, "unseen"));
  for (const hook of hooks) await ws.enableHook(hook.id);

  const report = await fileReport(await newMember(suite, "hooked"), { priority: "high" });
  expect(await callsOf(facet, 1)).toEqual([{
    kind: "issueReported",
    event: {
      eventId: expect.any(String), reportId: report.id, priority: "high", filedAt: report.filedAt,
    },
  }]);

  // Leaving "investigating" ends an investigation, each time it does; entering it does not.
  await admin.setIssueReportStatus(report.id, "investigating");
  await admin.setIssueReportStatus(report.id, "answered");
  await admin.setIssueReportStatus(report.id, "investigating");
  await admin.setIssueReportStatus(report.id, "closed");
  const calls = await callsOf(facet, 3);
  expect(calls.slice(1)).toEqual([
    { kind: "investigationComplete", event: {
      eventId: expect.any(String), reportId: report.id, status: "answered", at: expect.any(Date),
    } },
    { kind: "investigationComplete", event: {
      eventId: expect.any(String), reportId: report.id, status: "closed", at: expect.any(Date),
    } },
  ]);
  // Each event has an id of its own, which is all a subscriber needs to tell them apart.
  expect(new Set(calls.map(call => call.event.eventId)).size).toBe(3);
  // Ids and labels only: nothing of the report's text or of who filed it.
  expect(JSON.stringify(calls)).not.toContain(report.text);
  expect(JSON.stringify(calls)).not.toContain(report.reporter.id);
  expect(JSON.stringify(calls)).not.toContain(unseen.id);

  // Once each, and each marks the workspace: a new report's event included.
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(await facet.calls()).toHaveLength(3);
  expect(await observationTitles(ws)).toEqual(Array(3).fill("Receive an issue report event"));
  expect(await isRestricted(ws)).toBe(true);
});

it("delivers an event again, with the same id, after a callback that failed, which a gadget " +
    "that keys its work by the event's id handles once", async () => {
  const { facet } = recording;
  const before = (await facet.calls()).length;
  await facet.failNext();
  const report = await fileReport(await newMember(suite, "retried"));
  const failed = await waitFor("the failed delivery", () => facet.failed());
  expect(failed).toEqual(
      { eventId: expect.any(String), reportId: report.id, priority: "medium", filedAt: report.filedAt });
  expect(await facet.calls()).toHaveLength(before);

  // The driver tries again a minute after a delivery that failed.
  const calls = await callsOf(facet, before + 1, 90_000);
  expect(calls.slice(before)).toEqual([{ kind: "issueReported", event: failed }]);
  expect((await facet.handled()).filter(reportId => reportId === report.id)).toHaveLength(1);
});

// The smallest PNG the report store takes: its signature, and filler.
const PNG = new Uint8Array(64).fill(0x11);
PNG.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

it("calls a gadget's stored callback once for each kind of change to a report", async () => {
  const { ws, connection, facet } = await watcher(
      "Triage, watching changes", ["subscribeIssueReportChanged"]);
  const hooks = await ws.listHooks();
  expect(hooks.map(hook => [hook.description.title, hook.enabled]))
      .toEqual([["Watch for changes to issue reports", false]]);
  for (const hook of hooks) await ws.enableHook(hook.id);
  const graceAdmin = await adminApiOf(suite, await newUser(suite, GRACE));
  const reporter = await newMember(suite, "writer");
  const theirs = await newWorkspace(suite, reporter, "A writer's workspace");
  // Filing is no change: the first call is for the first write after it.
  const report = await fileReport(reporter, { context: { workspaceId: theirs.id } });

  // Each write is awaited in the callback before the next is made, so the calls come in the
  // writes' order, and a write that must call nothing shows as a call too many.
  let expected = 0;
  const called = async (change: string, status?: string) => {
    const calls = await callsOf(facet, ++expected);
    expect(calls, change).toHaveLength(expected);
    expect(calls.at(-1), change).toEqual({ kind: "issueReportChanged", event: {
      eventId: expect.any(String), reportId: report.id, change, at: expect.any(Date),
      ...(status && { status }),
    } });
  };

  // A status, by an admin: the event carries it. The status the report has is no change.
  await admin.setIssueReportStatus(report.id, "answered");
  await called("status", "answered");
  await admin.setIssueReportStatus(report.id, "answered");

  // The reporter's reply reopens an answered report, and says so; their next one moves nothing.
  await reporter.api.replyToIssueReport(report.id, "It still fails for me");
  await called("reply", "withAdmin");
  await reporter.api.replyToIssueReport(report.id, "And once more today");
  await called("reply");

  // An admin's entries, of either visibility.
  await admin.addIssueReportEntry(report.id, "Likely the quota", "admins");
  await called("note");
  await admin.addIssueReportEntry(report.id, "We are looking into it", "public");
  await called("reply");

  // A claim, a take-over and a release. The holder's own claim and a refused one are no change.
  await admin.claimIssueReport(report.id);
  await called("assignment");
  await admin.claimIssueReport(report.id);
  await expect(graceAdmin.claimIssueReport(report.id))
      .rejects.toThrow("Another admin holds this issue report.");
  await graceAdmin.claimIssueReport(report.id, { takeOverFrom: OWNER });
  await called("assignment");
  await graceAdmin.releaseIssueReport(report.id);
  await called("assignment");

  // The links replaced, once: the links the report has are no change.
  await admin.setIssueReportLinks(report.id, ["https://tracker.example/issue/7"]);
  await called("links");
  await admin.setIssueReportLinks(report.id, ["https://tracker.example/issue/7"]);

  // What the reporter attaches to their report is no write to it.
  await reporter.api.addIssueReportImage(report.id, new Response(PNG).body!, PNG.byteLength);
  await theirs.ws.grantAdminAccess({ reportId: report.id });

  // The subscriber's own workspace's change, once a person approved it: how code learns that
  // an action it queued was applied. The status is the one admins read.
  const turn = await agentTurn(owner, ws, `await attempt("status", () =>
    env.ADMIN.setIssueReportStatus(${JSON.stringify(report.id)}, "fixSuggested"));`, { connection });
  const [queued] = await pendingActions(ws, 1);
  await ws.approveAction(queued!.id);
  expect(await turn.resumed()).toEqual({ status: { value: null } });
  await called("status", "fixSuggested");

  // Once each, with an id each, and nothing of what was written or of who wrote it.
  await new Promise(resolve => setTimeout(resolve, 500));
  const calls = await facet.calls();
  expect(calls).toHaveLength(expected);
  expect(new Set(calls.map(call => call.event.eventId)).size).toBe(expected);
  for (const hidden of [
    report.text, "It still fails", "Likely the quota", "We are looking", "tracker.example",
    reporter.name, GRACE,
  ]) {
    expect(JSON.stringify(calls), hidden).not.toContain(hidden);
  }
  // The workspace read nothing and is marked all the same, from its first event: a status is
  // flagged whatever it set.
  expect(await observationTitles(ws)).toEqual(Array(expected).fill("Receive an issue report event"));
  expect(await isRestricted(ws)).toBe(true);
});

it("fires both hooks when a report leaves investigating, each with an id of its own", async () => {
  const { ws, facet } = await watcher(
      "Triage, watching both", ["subscribeInvestigationComplete", "subscribeIssueReportChanged"]);
  for (const hook of await ws.listHooks()) await ws.enableHook(hook.id);
  const report = await fileReport(await newMember(suite, "both"));
  const changed = (status: string) => ({ kind: "issueReportChanged", event: {
    eventId: expect.any(String), reportId: report.id, change: "status", status, at: expect.any(Date),
  } });

  // Entering "investigating" is a change, and ends no investigation.
  await admin.setIssueReportStatus(report.id, "investigating");
  expect(await callsOf(facet, 1)).toEqual([changed("investigating")]);

  // Leaving it is one write and two events, which arrive in either order.
  await admin.setIssueReportStatus(report.id, "fixSuggested");
  const [complete, change] = (await callsOf(facet, 3)).slice(1)
      .toSorted((a, b) => a.kind.localeCompare(b.kind));
  expect(complete).toEqual({ kind: "investigationComplete", event: {
    eventId: expect.any(String), reportId: report.id, status: "fixSuggested", at: expect.any(Date),
  } });
  expect(change).toEqual(changed("fixSuggested"));
  expect(complete!.event.eventId).not.toBe(change!.event.eventId);
  expect(complete!.event.at).toEqual(change!.event.at);

  await new Promise(resolve => setTimeout(resolve, 500));
  expect(await facet.calls()).toHaveLength(3);
});

it("marks a workspace told of any event, a new report's and a reply's included, before its " +
    "callback runs", async () => {
  const { ws, facet } = await watcher(
      "Triage, told of a note", ["subscribeIssueReported", "subscribeIssueReportChanged"]);
  for (const hook of await ws.listHooks()) await ws.enableHook(hook.id);
  const reporter = await newMember(suite, "noted");
  const told = async (count: number) =>
    (await callsOf(facet, count)).map(call => call.event.change ?? call.kind);

  // Subscribing marks nothing; the first event, a new report's, marks the workspace as reading
  // the report would.
  expect(await isRestricted(ws)).toBe(false);
  const report = await fileReport(reporter);
  expect(await told(1)).toEqual(["issueReported"]);
  expect(await isRestricted(ws)).toBe(true);
  await reporter.api.replyToIssueReport(report.id, "It fails on every page");
  await admin.addIssueReportEntry(report.id, "Likely the quota", "admins");
  expect(await told(3)).toEqual(["issueReported", "reply", "note"]);
  expect((await ws.listActions({ filter: "observation" })).entries.map(entry =>
    entry.type === "observation" && entry.description.containsRestrictedData)).toEqual(
      [true, true, true]);
});

/** What a triage agent is told of its interface: one call, with a stub that reaches one report. */
const TRIAGE_TYPES = `interface TriageAgent {
  /** Triage the report that \`report\` reaches, as \`instructions\` say. */
  triage(instructions: string, report: RpcStub<Report>): void;
}
interface Report extends RpcTarget {
  /** The report, as its reporter reads it. */
  get(): Promise<unknown>;
  /** How many messages a chat of the reporter's workspace holds. */
  readChat(chatId: number): Promise<number>;
  /** Answers the reporter, which ends the triage. */
  reply(text: string): Promise<void>;
}`;

/**
 * A gadget that triages a report by handing a spawned agent a stub limited to it.
 *
 * The stub is minted from a random token the gadget stored with the report's id, never from the
 * id: any code whose env names this gadget can restore a stub from params it chooses, and a stub
 * minted from an id would then open any report. The restored target opens the report's session
 * anew in each method, for a token the gadget stored and for no other.
 */
const TRIAGE_GADGET = `import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
const TYPES = ${JSON.stringify(TRIAGE_TYPES)};
export class Gadget extends DurableObject {
  async [restore](params) {
    if (params.type === "hook") return new Hook(this);
    return new Report(this, params.token);
  }
  async subscribe() {
    await this.env.ADMIN.subscribeIssueReported(await this.ctx.restore({ type: "hook" }));
    await this.env.ADMIN.subscribeInvestigationComplete(await this.ctx.restore({ type: "hook" }));
  }
  async arm(instructions) { await this.ctx.storage.put("armed", instructions); }
  async calls() { return (await this.ctx.storage.get("calls")) ?? []; }
  async record(kind, event) {
    const calls = (await this.ctx.storage.get("calls")) ?? [];
    await this.ctx.storage.put("calls", [...calls, { kind, event }]);
  }
  async reported(event) {
    await this.record("issueReported", event);
    const instructions = await this.ctx.storage.get("armed");
    if (!instructions) return;
    await this.ctx.storage.delete("armed");
    await this.env.ADMIN.setIssueReportStatus(event.reportId, "investigating");
    await this.handOff("SPAWNER", event.reportId, instructions);
  }
  async handOff(spawner, reportId, instructions) {
    const token = crypto.randomUUID();
    await this.ctx.storage.put("triage:" + token, reportId);
    const agent = await this.env[spawner].spawnCallable(
        "Triage of " + reportId, { types: TYPES, mainType: "TriageAgent" });
    await agent.triage(instructions, await this.ctx.restore({ token }));
  }
  async reportOf(token) {
    const reportId = typeof token === "string"
        ? await this.ctx.storage.get("triage:" + token) : undefined;
    if (!reportId) throw new Error("No such triage.");
    return reportId;
  }
  async session(token) { return this.env.ADMIN.openIssueReport(await this.reportOf(token)); }
  async restored(params) { return (await this[restore](params)).get(); }
  async answered(token) {
    await this.env.ADMIN.setIssueReportStatus(await this.reportOf(token), "answered");
  }
}
class Hook extends RpcTarget {
  constructor(gadget) { super(); this.gadget = gadget; }
  async issueReported(event) { await this.gadget.reported(event); }
  async investigationComplete(event) { await this.gadget.record("investigationComplete", event); }
}
class Report extends RpcTarget {
  constructor(gadget, token) { super(); this.gadget = gadget; this.token = token; }
  async get() { return (await this.gadget.session(this.token)).get(); }
  async readChat(chatId) {
    const view = await (await this.gadget.session(this.token)).inspectWorkspace("triage");
    return (await view.getChat(chatId)).messages.length;
  }
  async reply(text) {
    await (await this.gadget.session(this.token)).reply(text);
    await this.gadget.answered(this.token);
  }
}`;

/** A gadget that mints nothing. */
const PLAIN_GADGET = `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async hello() { return "hello"; }
}`;

type Desk = {
  subscribe(): void; arm(instructions: string): void; calls(): HookCall[];
  handOff(spawner: string, reportId: string, instructions: string): void;
  /** What `get()` answers on the target the gadget restores from `params`. */
  restored(params: object): unknown;
};
type Spawner = { spawn(title: string, prompt: string): void };

// The triage desk: a workspace that has read nothing, and its gadget. Set up by the first of
// the three cases that use it.
let desk: { ws: RpcStub<Overseer>; id: string; gadget: RpcStub<GadgetClient>; gadgetId: number };

/** The desk's gadget, connected anew: a merge or a new binding restarts it, which ends a stub. */
const deskFacet = async () => scope.use(await desk.gadget.connectToGadget() as RpcStub<Desk>);

/** The chat a spawner made under `title`, once it exists. */
const spawnedChat = (ws: RpcStub<Overseer>, title: string) =>
  waitFor(`the spawned chat "${title}"`, async () =>
    (await ws.listChats()).find(chat => chat.title === title) ?? null);

it("gives a spawned chat no admin binding unless its spawner names one", async () => {
  const { ws, id } = await newWorkspace(suite, owner, "Triage desk");
  const connection = await addAdminConnection(ws, ownerAccount.id);
  for (const kind of [ADMIN_AGENT_ACTIONS.issueReportStatus, ADMIN_AGENT_ACTIONS.issueReportScopedReply]) {
    await ws.setAutoApprovedActionKind(connection.id, kind.kind);
  }
  const triage = scope.use(await ws.newAgentSpawnerGatekeeper(
      { displayName: "Triage", modelId: SCRIPTED_MODEL_ID, env: {} }));
  const built = await buildGadget(owner, ws, {
    name: "DESK", server: TRIAGE_GADGET,
    bindings: { ADMIN: connection.id, SPAWNER: await triage.getId() },
  });
  desk = { ws, id, gadget: built.gadget, gadgetId: built.id };
  await (await deskFacet()).subscribe();
  for (const hook of await ws.listHooks()) await ws.enableHook(hook.id);

  // A spawner whose env names a gadget that mints nothing: the workspace's own chats are given
  // the connection (the desk binds it), and the chat this spawner makes is not.
  const plain = await buildGadget(owner, ws, { name: "PLAIN", server: PLAIN_GADGET });
  using bare = await ws.newAgentSpawnerGatekeeper(
      { displayName: "Bare", modelId: SCRIPTED_MODEL_ID, env: { PLAIN: plain.id } });
  const script = models.turn([codeStep(`
    out.admin = { value: typeof env.ADMIN };
    out.names = { value: Object.keys(env) };
    await attempt("gadget", () => env.PLAIN.rpc.hello());`), { text: "Done." }]);
  using spawner = await bare.openSession() as RpcStub<Spawner>;
  await spawner.spawn("A bare agent", `${script.marker} Look at what you were given.`);
  await waitFor("the spawned agent's turn", async () => script.done() || null);
  const chat = await spawnedChat(ws, "A bare agent");
  const [results] = await codeResults(ws, chat.id);
  expect(results).toMatchObject({ admin: { value: "undefined" }, gadget: { value: "hello" } });
  expect(results!.names!.value).toContain("PLAIN");
  expect(results!.names!.value).not.toContain("ADMIN");
  expect(results!.names!.value).not.toContain("DESK");

  // The workspace's own chat, for contrast.
  const own = await agentTurn(owner, ws, `out.admin = { value: typeof env.ADMIN };`);
  expect((await own.results()).admin!.value).not.toBe("undefined");
  expect(await isRestricted(ws)).toBe(false);
});

it("triages a report: a gadget hands a spawned agent a stub that reaches that one report, and " +
    "its reply reaches the reporter once a person approves it", async () => {
  const { ws, id } = desk;
  const facet = await deskFacet();
  const reporter = await newMember(suite, "triaged");
  const theirs = await newWorkspace(suite, reporter, "A reporter's workspace");
  const chatId = await theirs.ws.newChat("hello", null);
  const before = (await facet.calls()).length;

  // The agent's first step runs as the hook fires; its second waits until the reporter has
  // added an image and given a grant, as the dialog does after it files the report.
  const later = Promise.withResolvers<void>();
  const look = `
    const [, report] = env.triage_ARGS;
    await attempt("report", () => report.get().then(({ id, images, grant }) =>
      ({ id, images: images.length, granted: grant !== undefined })));
    await attempt("chat", () => report.readChat(${chatId}));`;
  const script = models.turn([
    codeStep(`
      out.admin = { value: typeof env.ADMIN };
      out.names = { value: Object.keys(env) };
      ${look}
      await attempt("listIssueReports", () => report.listIssueReports());
      await attempt("getIssueReport", () => report.getIssueReport("another"));`),
    { ...codeStep(`
      ${look}
      await attempt("reply", () => report.reply("Fixed: please try again."));`),
      after: later.promise },
    { text: "Triaged." },
  ]);
  await facet.arm(`${script.marker} Triage this report.`);
  const report = await fileReport(reporter, { priority: "low", context: { workspaceId: theirs.id } });
  await waitFor("the hook's call", async () => (await facet.calls()).length > before || null);
  const chat = await spawnedChat(ws, `Triage of ${report.id}`);
  const atOnce = await waitFor("the agent's first step", async () =>
    (await codeResults(ws, chat.id))[0] ?? null);

  // The agent holds the stub and nothing else of the deployment's.
  expect(atOnce).toMatchObject({
    admin: { value: "undefined" },
    // Read as the hook fires: no image yet and no grant, so no content.
    report: { value: { id: report.id, images: 0, granted: false } },
    chat: { error: createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.grantRequired).message },
    listIssueReports: { error: expect.any(String) },
    getIssueReport: { error: expect.any(String) },
  });
  expect(atOnce.names!.value).not.toContain("ADMIN");
  expect(atOnce.names!.value).not.toContain("DESK");

  await reporter.api.addIssueReportImage(report.id, new Response(PNG).body!, PNG.byteLength);
  await theirs.ws.grantAdminAccess({ reportId: report.id });
  later.resolve();
  await waitFor("the agent's turn", async () => script.done() || null);
  const [, afterwards] = await codeResults(ws, chat.id);
  expect(afterwards).toEqual({
    report: { value: { id: report.id, images: 1, granted: true } },
    chat: { value: 1 },
    reply: { value: null },
  });

  // The hook's event marked the workspace before the gadget had it, so what the gadget and the
  // agent queued waits for a person, as every action there does: the status, the reply and the
  // status that follows it. A person approves each, in order.
  const held = await waitFor("the three actions", async () => {
    const pending = (await ws.listActions({ filter: "pending" })).entries.toReversed();
    return pending.length >= 3 ? pending : null;
  });
  expect(held.map(entry => entry.type === "action" && entry.description.actionKind?.tag)).toEqual([
    ADMIN_AGENT_ACTIONS.issueReportStatus.kind.tag,
    ADMIN_AGENT_ACTIONS.issueReportScopedReply.kind.tag,
    ADMIN_AGENT_ACTIONS.issueReportStatus.kind.tag,
  ]);
  expect(await isRestricted(ws)).toBe(true);
  for (const entry of held) await ws.approveAction(entry.id);

  // The reply reached the reporter, and ended the investigation once.
  const thread = await waitFor("the report to be answered", async () => {
    const found = await admin.getIssueReport(report.id);
    return found.status === "answered" ? found.entries : null;
  });
  expect(thread.map(({ text, status }) => text || status))
      .toEqual(["investigating", "Fixed: please try again.", "answered"]);
  for (const written of thread) {
    expect(written).toMatchObject({ visibility: "public", via: "gatekeeper", author: { id: OWNER } });
    // Merged gadget code, and a stub it handed on: the workspace, and no chat.
    expect(written.agent).toEqual({ workspaceId: id });
  }
  expect((await ws.listActions({ filter: "pending" })).entries).toEqual([]);
  const calls = await waitFor("the end of the investigation", async () => {
    const received = (await facet.calls()).slice(before);
    return received.length >= 2 ? received : null;
  });
  expect(calls).toEqual([
    { kind: "issueReported", event: expect.objectContaining({ reportId: report.id, priority: "low" }) },
    { kind: "investigationComplete", event: {
      eventId: expect.any(String), reportId: report.id, status: "answered", at: expect.any(Date),
    } },
  ]);
});

it("opens nothing for a stub restored from params its caller chose", async () => {
  const { ws, gadget, gadgetId } = desk;
  const [triaged, other] = [
    await fileReport(await newMember(suite, "mine")), await fileReport(await newMember(suite, "theirs")),
  ];
  // The rule the desk keeps is broken here on purpose: this spawner's env names the gadget
  // that mints the sessions, so its agent can ask that gadget to restore any params.
  using loose = await ws.newAgentSpawnerGatekeeper(
      { displayName: "Loose", modelId: SCRIPTED_MODEL_ID, env: { TRIAGE: gadgetId } });
  await gadget.bind("LOOSE", await loose.getId());
  const facet = await deskFacet();

  const forgeries = {
    byReportId: { reportId: other.id },
    byUnknownToken: { token: "00000000-0000-4000-8000-000000000000" },
    byReportIdAsToken: { token: triaged.id },
  };
  const script = models.turn([codeStep(`
    const [, report] = env.triage_ARGS;
    ${Object.entries(forgeries).map(([name, params]) => `await attempt("${name}", () =>
      env.TRIAGE.rpc[restore](${JSON.stringify(params)}).then(stub => stub.get()));`).join("\n")}
    await attempt("legitimate", () => report.get().then(report => report.id));`), { text: "Done." }]);
  await facet.handOff("LOOSE", triaged.id, `${script.marker} Triage this report.`);
  await waitFor("the agent's turn", async () => script.done() || null);
  const chat = await spawnedChat(ws, `Triage of ${triaged.id}`);

  // A forged stub can always be minted: what matters is that it opens nothing. The agent's
  // calls on one are refused, and the stub it was handed still answers for its own report.
  const refused = { error: expect.any(String) };
  expect((await codeResults(ws, chat.id))[0]).toEqual({
    byReportId: refused, byUnknownToken: refused, byReportIdAsToken: refused,
    legitimate: { value: triaged.id },
  });
  // What the gadget restores from each of those params is a target that knows no such triage:
  // a session is opened for a token the gadget stored, and a report's id is not one.
  for (const [name, params] of Object.entries(forgeries)) {
    await expect(facet.restored(params), name).rejects.toThrow("No such triage.");
  }
  // The other report is in nothing the workspace read or did: only the hook's event, which
  // every subscriber receives, names it.
  expect((await admin.getIssueReport(other.id)).entries).toEqual([]);
  const { entries } = await ws.listActions();
  const naming = (reportId: string) => entries
      .filter(entry => JSON.stringify(entry.description).includes(reportId))
      .map(entry => entry.description.title);
  expect(naming(other.id)).toEqual(["Receive an issue report event"]);
  expect(naming(triaged.id)).toEqual(["Issue report: get", "Receive an issue report event"]);
});

it("hands a spawned chat the whole binding when its spawner names the connection", async () => {
  const subject = await newWorkspace(suite, await newMember(suite, "seen"), "Seen by a spawned agent");
  const { ws, id } = await newWorkspace(suite, owner, "Triage, a spawner with the binding");
  const connection = await addAdminConnection(ws, ownerAccount.id);
  using whole = await ws.newAgentSpawnerGatekeeper(
      { displayName: "Whole", modelId: SCRIPTED_MODEL_ID, env: { ADMIN: connection.id } });
  const script = models.turn([codeStep(`
    await attempt("users", () => env.ADMIN.listUsers({ limit: 1 }).then(page => page.users.length));
    await attempt("view", () => env.ADMIN.inspectWorkspace(${JSON.stringify(subject.id)}, "Looking")
        .then(view => view.describe()).then(description => description.id));`), { text: "Done." }]);
  using spawner = await whole.openSession() as RpcStub<Spawner>;
  expect(await isRestricted(ws)).toBe(false);
  await spawner.spawn("An admin's agent", `${script.marker} Look at the deployment.`);
  await waitFor("the spawned agent's turn", async () => script.done() || null);
  const chat = await spawnedChat(ws, "An admin's agent");

  expect((await codeResults(ws, chat.id))[0])
      .toEqual({ users: { value: 1 }, view: { value: subject.id } });
  const [described] = await auditRecords(admin, { workspace: subject.id, method: "describe" });
  expect(described).toMatchObject({
    admin: OWNER, via: "gatekeeper", agent: { workspaceId: id, chatId: chat.id },
  });
  expect(await isRestricted(ws)).toBe(true);
});
