// How a workspace lends its owner's Admin API to the admin gatekeeper (OverseerImpl.lendAdminApi(),
// the queue openGatekeeperSession() gives its sessions, and the one call an approved action is
// lent): over a real OverseerDurableObject and a fixture facet that stands for the gatekeeper, a
// Worker that keeps everything it is given (FakeAdminGatekeeper in test-worker.ts).
//
// The workspace inspects itself where a test needs a view: the Admin API reaches it through its
// own Durable Object stub, as it reaches any workspace, so the view is the native stub a real
// lend returns. The audit log and the issue report store are the real objects behind ctx.exports.
//
// Time is moved with a spy on Date.now(): a session's deadline is fixed by its queue when the
// queue is made, and neither the queue nor the lend takes a clock from outside.
//
// A content access request an action files goes to the deployment's own AdminSettings object, and
// the workspace's listing is read from its own user directory (see withWrites()). A write an
// action runs is the workspace's on itself.

import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_GRANT_ERROR_CODES, getAdminGrantErrorCode,
  type AdminAccessRecord, type AdminAuditRecord, type AdminContentRequest, type AdminGrantRecord,
  type AdminWriteRecord, type AiChatAuthorInfo, type IssueReportAssignee, type IssueReportEntry,
  type Overseer,
} from "@gadgets/workshop-shared/api";
import {
  ADMIN_AGENT_ACTIONS, ADMIN_AGENT_LEND_SECONDS, type AdminAgentAction,
} from "@gadgets/workshop-shared/admin-agent";
import { AdminApiImpl, type AdminSettings } from "../src/admin-settings.js";
import type { AdminSettingsStorage } from "../src/storage-schema/admin-settings-storage.js";
import type { GatekeeperCaller } from "../src/storage-schema/overseer-storage.js";
import type { UserDurableObject } from "../src/user.js";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";
import type { FakeAdminVendor } from "./test-worker.js";
import {
  ADMIN, NOT_ADMIN, OTHER_ADMIN, adminWorkspace, type AdminWorkspace,
} from "./admin-agent-helpers.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    GATEKEEPER_ADMIN: Service<FakeAdminVendor>;
    TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
  }
}

const REASON = "Looking into an issue report";
const LEND_MS = ADMIN_AGENT_LEND_SECONDS * 1000;
const ENDED = "This Admin API session has ended. Open a new one.";
// What createAdminAccessError(notAdmin) says, as it arrives over RPC.
const NOT_ADMIN_MESSAGE =
    "Only a deployment admin can inspect a workspace or a user, or change a workspace.";
// What a connection is told once its workspace's owner holds no account of the admin gatekeeper.
const ACCOUNT_REMOVED = "This workspace's owner has removed the deployment admin account, so " +
    "this connection reaches nothing. Add the account again from Connectors, or remove the " +
    "connection.";
const AGENT: GatekeeperCaller = { from: "agent", chatId: 5 };
const OPEN = (ws: AdminWorkspace, options?: object) =>
    ({ method: "inspectWorkspace", args: options ? [ws.id, REASON, options] : [ws.id, REASON] });

afterEach(() => { vi.restoreAllMocks(); });

// An action of `kind` as the gatekeeper would queue it, with `claims` over its description.
function describeAction(kind: AdminAgentAction, claims: object = {}) {
  return {
    title: ADMIN_AGENT_ACTIONS[kind].kind.label, description: "What will be posted or set.",
    implementsRevert: false, autoApprovable: ADMIN_AGENT_ACTIONS[kind].autoApprovable,
    actionKind: ADMIN_AGENT_ACTIONS[kind].kind, ...claims,
  };
}

// Queues action number `action` of `kind` through a session of `caller`, planned to make `calls`,
// and returns its record's id.
async function queueAction(ws: AdminWorkspace, action: number, kind: AdminAgentAction,
    calls: { method: string; args?: unknown[] }[], options: { caller?: GatekeeperCaller;
    claims?: object } = {}): Promise<number> {
  await ws.facet.plan(action, calls);
  using session = await ws.session(options.caller ?? AGENT);
  await session.submit(action, describeAction(kind, options.claims));
  let records = [...ws.impl.storage.actions.list()]
      .filter((record: any) => record.type === "action" && record.action === action);
  return records.at(-1).id;
}

const stateOf = (ws: AdminWorkspace, id: number) => ws.impl.storage.actions.get(id).state;

// Why a session of `caller` is refused queueing action `action`, which is then not stored.
async function refusedSubmit(ws: AdminWorkspace, action: number, kind: AdminAgentAction,
    caller: GatekeeperCaller = AGENT): Promise<string | undefined> {
  let before = [...ws.impl.storage.actions.list()].length;
  using session = await ws.session(caller);
  let refusal = await session.submit(action, describeAction(kind))
      .then(() => undefined, (error: Error) => error.message);
  expect([...ws.impl.storage.actions.list()]).toHaveLength(before);
  return refusal;
}

// Approves action `id` as `by` does from the Workshop, returning the refusal if it fails.
async function approve(ws: AdminWorkspace, id: number, by: AiChatAuthorInfo = ADMIN)
    : Promise<string | undefined> {
  try {
    await ws.impl.applyPendingAction(ws.impl.storage.actions.get(id), by, false);
  } catch (error) {
    return (error as Error).message;
  }
}

// Turns on the rule that auto-approves `kind` on the admin connection, enabled by `by`.
function enableRule(ws: AdminWorkspace, kind: AdminAgentAction, by: AiChatAuthorInfo = ADMIN) {
  ws.impl.storage.autoApproveTags.put(
      { gatekeeperId: ws.gatekeeperId, actionKind: ADMIN_AGENT_ACTIONS[kind].kind, enabledBy: by });
}

// A report in the deployment's store, filed by a user who is not an admin.
async function fileReport(ws: AdminWorkspace, reporter = NOT_ADMIN): Promise<string> {
  let report = await ws.impl.issueReports.getByName("").submit(
      reporter, { text: "The export button does nothing.", priority: "medium" }, false);
  return report.id;
}

async function entriesOf(ws: AdminWorkspace, reportId: string): Promise<IssueReportEntry[]> {
  return (await ws.impl.issueReports.getByName("").get(reportId)).entries;
}

// Who holds a report, as admins read it.
async function assigneeOf(ws: AdminWorkspace, reportId: string)
    : Promise<IssueReportAssignee | undefined> {
  return (await ws.impl.issueReports.getByName("").get(reportId)).assignee;
}

// The one call of a claim or a release of report `reportId`.
const CLAIM = (reportId: string) => [{ method: "claimIssueReport", args: [reportId] }];
const RELEASE = (reportId: string) => [{ method: "releaseIssueReport", args: [reportId] }];

describe("a session of the admin gatekeeper", () => {
  it("reads through the lent Admin API", () => adminWorkspace(async ws => {
    using session = await ws.session(AGENT);
    expect(await session.read({ method: "listUsers" })).toEqual({ value: { users: [] } });
    expect((await session.read({ method: "getSettings" })).error).toBeUndefined();
  }));

  it("is refused every act and omitted method", () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws);
    using session = await ws.session(AGENT);
    expect(await session.read({ method: "addIssueReportEntry", args: [reportId, "hi", "admins"] }))
        .toEqual({ error: "AdminApi.addIssueReportEntry() runs only as an approved action." });
    expect(await session.read({ method: "setIssueReportStatus", args: [reportId, "closed"] }))
        .toEqual({ error: "AdminApi.setIssueReportStatus() runs only as an approved action." });
    expect(await session.read({ method: "setSiteName", args: ["x"] }))
        .toEqual({ error: "AdminApi.setSiteName() is not available through the admin gatekeeper." });
    expect(await session.read({ method: "claimIssueReport", args: [reportId] }))
        .toEqual({ error: "AdminApi.claimIssueReport() runs only as an approved action." });
    expect(await session.read({ method: "releaseIssueReport", args: [reportId] }))
        .toEqual({ error: "AdminApi.releaseIssueReport() runs only as an approved action." });
    expect(await entriesOf(ws, reportId)).toEqual([]);
    expect(await assigneeOf(ws, reportId)).toBeUndefined();
  }));

  it("names the owner through a session's whoami()", () => adminWorkspace(async ws => {
    using session = await ws.session(AGENT);
    let { value, error } = await session.read({ method: "whoami" });
    expect(error).toBeUndefined();
    expect(value).toEqual({ id: ADMIN.id, name: expect.any(String) });

    // The same id a report the owner holds and an entry in the owner's name carry.
    let reportId = await fileReport(ws);
    expect(await approve(ws, await queueAction(ws, 1, "issueReportAssignment", CLAIM(reportId))))
        .toBeUndefined();
    expect((await assigneeOf(ws, reportId))!.id).toBe((value as { id: string }).id);
    expect((await entriesOf(ws, reportId))[0]!.author.id).toBe((value as { id: string }).id);
  }));

  it.each<[string, GatekeeperCaller]>([
    ["an agent's", AGENT],
    ["a gadget's", { from: "gadget", gadgetId: 1 }],
    ["the owner's direct", { from: "user" }],
  ])("stops %s session at its deadline, the stub it was lent included", (_label, caller) =>
      adminWorkspace(async ws => {
    let made = Date.now();
    using session = await ws.session(caller);
    expect((await session.read({ method: "listUsers" }, { api: "api" })).error).toBeUndefined();

    // A moment before the deadline the queue still lends, and what it lent still answers.
    let clock = vi.spyOn(Date, "now").mockReturnValue(made + LEND_MS - 1);
    expect((await session.read({ method: "listUsers" })).error).toBeUndefined();
    expect((await ws.facet.onKept("api", { method: "listUsers" })).error).toBeUndefined();

    // Asking again does not extend it: the deadline was fixed when the queue was made.
    clock.mockReturnValue(made + LEND_MS + 1000);
    expect(await session.read({ method: "listUsers" })).toEqual({ error: ENDED });
    expect(await ws.facet.onKept("api", { method: "listUsers" })).toEqual({ error: ENDED });
    // Nor does it queue an action once past it.
    let refusal = await session.submit(1, describeAction("workspaceWriteRequest"))
        .then(() => undefined, (error: Error) => error.message);
    expect(refusal).toBe(ENDED);
    expect([...ws.impl.storage.actions.list()]).toEqual([]);
  }));

  it("stops a view with the session that opened it", () => adminWorkspace(async ws => {
    let session = await ws.session(AGENT);
    expect(await session.read(OPEN(ws), { result: "view" })).toEqual({ kept: "view" });
    expect((await ws.facet.onKept("view", { method: "listChats" })).error).toBeUndefined();

    session[Symbol.dispose]();
    await vi.waitFor(async () => {
      expect(await ws.facet.onKept("view", { method: "listChats" })).toEqual({ error: ENDED });
    });
  }));

  it("leaves a Worker that keeps a view nothing once its session is over",
      () => adminWorkspace(async ws => {
    let before = Date.now();
    let session = await ws.session(AGENT);
    let deadline = Date.now() + LEND_MS;
    expect(before + LEND_MS).toBeLessThanOrEqual(deadline);

    // The Worker asks for the longest life a view can have, and keeps the lent API too.
    expect(await session.read(OPEN(ws, { lifetimeSeconds: 3600 }), { api: "api", result: "view" }))
        .toEqual({ kept: "view" });

    // dup() on the stub it was returned is answered by the Worker's own stub and never reaches
    // the Workshop: it is a second stub of the membrane, not of the view.
    expect(await ws.facet.onKept("view", { method: "dup" }, "copy")).toEqual({ kept: "copy" });
    // dup() pipelined on the promise of the open is refused by workerd itself, which reserves
    // the name; the open it rode on still ran, and nothing was kept of it.
    let pipelined = await session.read(OPEN(ws), { result: "pipelined" }, { method: "dup" });
    expect(pipelined.error).toMatch(/'dup' is a reserved method/);
    // onRpcBroken() is sent to the Workshop, where the membrane refuses it.
    expect(await ws.facet.onKept("view", { method: "onRpcBroken" }))
        .toEqual({ error: "This view has no method onRpcBroken." });
    // So is the open itself, which the view's own table names but the membrane's does not.
    expect(await ws.facet.onKept("view", { method: "inspectWorkspace", args: [ws.id, REASON] }))
        .toEqual({ error: "This view has no method inspectWorkspace." });
    expect(await ws.facet.kept()).toEqual(["api", "view", "copy"]);

    // The view's life is the session's, whatever was asked for.
    let description = await ws.facet.onKept("copy", { method: "describe" });
    let expiresAt = (description.value as { expiresAt: Date }).expiresAt.getTime();
    expect(expiresAt).toBeLessThanOrEqual(deadline + 1000);
    expect(expiresAt).toBeGreaterThan(before + LEND_MS - 60_000);
    let opens = (await ws.records()).filter(record => record.method === "inspectWorkspace");
    expect(opens.map(record => record.args)).toEqual([
      { expiresAt: new Date(expiresAt).toISOString() }, { expiresAt: expect.any(String) },
    ]);
    expect(Date.parse((opens[1]!.args as { expiresAt: string }).expiresAt))
        .toBeLessThanOrEqual(deadline + 1000);

    session[Symbol.dispose]();
    await vi.waitFor(async () => {
      expect(await ws.facet.onKept("view", { method: "describe" })).toEqual({ error: ENDED });
    });
    let recorded = (await ws.records()).length;
    for (let name of ["view", "copy"]) {
      expect(await ws.facet.onKept(name, { method: "describe" })).toEqual({ error: ENDED });
    }
    expect(await ws.facet.onKept("api", { method: "listUsers" })).toEqual({ error: ENDED });
    expect(await ws.facet.onKept("api", OPEN(ws), "late")).toEqual({ error: ENDED });
    expect(await ws.records()).toHaveLength(recorded);
  }));

  it("refuses the next call once the deployment turns the gatekeeper off",
      () => adminWorkspace(async ws => {
    using session = await ws.session(AGENT);
    expect((await session.read({ method: "listUsers" }, { api: "api" })).error).toBeUndefined();
    expect(await session.read(OPEN(ws), { result: "view" })).toEqual({ kept: "view" });

    ws.config.ambientGatekeeperModes.admin = "disabled";
    let off = { error: "Gatekeeper is disabled." };
    expect(await ws.facet.onKept("api", { method: "listUsers" })).toEqual(off);
    expect(await ws.facet.onKept("view", { method: "describe" })).toEqual(off);
    expect(await session.read({ method: "listUsers" })).toEqual(off);

    ws.config.ambientGatekeeperModes.admin = "optional";
    ws.config.disabledGatekeepers = ["admin"];
    expect(await ws.facet.onKept("api", { method: "listUsers" })).toEqual(off);
    expect(await session.read({ method: "listUsers" })).toEqual(off);

    ws.config.disabledGatekeepers = [];
    expect((await ws.facet.onKept("api", { method: "listUsers" })).error).toBeUndefined();
  }));

  it("refuses the next call once the owner is no longer an admin", () => adminWorkspace(async ws => {
    using session = await ws.session(AGENT);
    expect((await session.read({ method: "listUsers" }, { api: "api" })).error).toBeUndefined();
    ws.env.ADMINS = [OTHER_ADMIN.id];
    expect(await ws.facet.onKept("api", { method: "listUsers" }))
        .toEqual({ error: NOT_ADMIN_MESSAGE });
    expect(await session.read({ method: "listUsers" })).toEqual({ error: NOT_ADMIN_MESSAGE });
  }));
});

// The origin of the open a session of `caller` makes, as the audit log keeps it.
async function originOf(ws: AdminWorkspace, caller: GatekeeperCaller)
    : Promise<Pick<AdminAccessRecord, "admin" | "via" | "agent">> {
  using session = await ws.session(caller);
  expect(await session.read(OPEN(ws), { result: "view" })).toEqual({ kept: "view" });
  expect((await ws.facet.onKept("view", { method: "describe" })).error).toBeUndefined();
  let records = await ws.records();
  expect(records.map(record => record.method)).toEqual(["inspectWorkspace", "describe"]);
  // The view's calls carry what its open does.
  expect(records[1]).toMatchObject(
      { admin: records[0]!.admin, via: records[0]!.via, agent: records[0]!.agent });
  let { admin, via, agent } = records[0]!;
  return { admin, via, agent };
}

describe("what a lent call records", () => {
  it.each<[string, GatekeeperCaller, number | undefined]>([
    ["an agent's chat", { from: "agent", chatId: 5 }, 5],
    ["the chat whose changes a gadget runs", { from: "gadget", gadgetId: 1, chatId: 8 }, 8],
    ["no chat for a gadget's merged code", { from: "gadget", gadgetId: 1 }, undefined],
    ["no chat for a hook's firing", { from: "hook", gadgetId: 1 }, undefined],
    ["no chat for the owner's direct session", { from: "user" }, undefined],
  ])("names the owner, the workspace and %s", (_label, caller, chatId) =>
      adminWorkspace(async ws => {
    expect(await originOf(ws, caller)).toEqual({
      admin: ADMIN.id, via: "gatekeeper",
      agent: chatId === undefined ? { workspaceId: ws.id } : { workspaceId: ws.id, chatId },
    });
  }));

  it("opens a view of a user's account, which answers its own methods alone and records " +
      "each call with where it came from", () => adminWorkspace(async ws => {
    let userId = `lent${crypto.randomUUID().replaceAll("-", "")}`;
    await runInDurableObject(env.TEST_USER.getByName(userId), async (account: UserDurableObject) => {
      // The account reads the deployment's settings as the workspace does.
      Object.assign(account, { env: ws.env });
      expect(await account.createAccount(userId, "Viewed User", new Uint8Array([1, 2, 3])))
          .not.toBeNull();
    });

    using session = await ws.session(AGENT);
    expect(await session.read({ method: "inspectUser", args: [userId, REASON] }, { result: "view" }))
        .toEqual({ kept: "view" });
    let described = await ws.facet.onKept("view", { method: "describe" });
    expect(described.value).toMatchObject({ profile: { id: userId } });
    // Nothing of a workspace's view, and not the open.
    for (let method of ["getChat", "readFile", "inspectUser"]) {
      expect(await ws.facet.onKept("view", { method, args: [1] }))
          .toEqual({ error: `This view has no method ${method}.` });
    }

    let page = await env.TEST_ADMIN_AUDIT.getByName("").list({ owner: userId, limit: 10 }, 90);
    let origin = { admin: ADMIN.id, via: "gatekeeper", agent: { workspaceId: ws.id, chatId: 5 } };
    expect(page.records.toReversed()).toMatchObject([
      { kind: "user", userId, method: "inspectUser", access: "metadata", ...origin },
      { kind: "user", userId, method: "describe", access: "metadata", ...origin },
    ]);
    // The workspace that lent the call holds no record of it: the account is not a workspace.
    expect(await ws.records()).toEqual([]);
  }));

  it("takes no origin from the gatekeeper: an argument that claims one is the API's to refuse",
      () => adminWorkspace(async ws => {
    using session = await ws.session(AGENT);
    let claimed = { via: "api", agent: { workspaceId: "elsewhere", chatId: 99 } };
    let outcome = await session.read(
        { method: "inspectWorkspace", args: [ws.id, REASON, claimed, claimed] }, { result: "view" });
    // Whether AdminApi ignores or refuses the stray fields, no record carries them.
    for (let record of await ws.records()) {
      expect(record).toMatchObject(
          { via: "gatekeeper", agent: { workspaceId: ws.id, chatId: 5 }, admin: ADMIN.id });
    }
    expect(outcome.error === undefined || !/elsewhere/.test(outcome.error)).toBe(true);
  }));
});

describe("an approved action of the admin gatekeeper", () => {
  it("makes its one call, recorded with the chat that queued it", () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws);
    let note = { method: "addIssueReportEntry", args: [reportId, "Seen by the agent.", "admins"] };
    let id = await queueAction(ws, 1, "issueReportNote", [note, note]);
    expect(stateOf(ws, id)).toBe("pending");
    expect(await entriesOf(ws, reportId)).toEqual([]);

    expect(await approve(ws, id, OTHER_ADMIN)).toBeUndefined();
    expect(ws.impl.storage.actions.get(id)).toMatchObject(
        { state: "approved", autoApproved: false, resolvedBy: OTHER_ADMIN });
    // The entry is the owner's, written through the gatekeeper from the chat that queued it.
    expect(await entriesOf(ws, reportId)).toMatchObject([{
      visibility: "admins", text: "Seen by the agent.", author: { id: ADMIN.id },
      via: "gatekeeper", agent: { workspaceId: ws.id, chatId: 5 },
    }]);

    // A second call inside the apply was refused, and so is the copy of the lend the Worker kept.
    let outcomes = await ws.facet.outcomes(1);
    expect(outcomes![0]!.error).toBeUndefined();
    expect(outcomes![1]).toEqual({ error: "This action has made its one call." });
    expect(await ws.facet.onKept("action:1", note))
        .toEqual({ error: "This action has made its one call." });
    expect(await entriesOf(ws, reportId)).toHaveLength(1);
  }));

  it("applies an approved claim as the workspace's owner", () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws);
    let id = await queueAction(ws, 7, "issueReportAssignment", CLAIM(reportId));
    expect(stateOf(ws, id)).toBe("pending");
    expect(await assigneeOf(ws, reportId)).toBeUndefined();

    // Whoever approves, the report is the owner's.
    expect(await approve(ws, id, OTHER_ADMIN)).toBeUndefined();
    expect(ws.impl.storage.actions.get(id)).toMatchObject(
        { state: "approved", autoApproved: false, resolvedBy: OTHER_ADMIN });
    let origin = { via: "gatekeeper", agent: { workspaceId: ws.id, chatId: 5 } };
    expect(await assigneeOf(ws, reportId)).toMatchObject({ id: ADMIN.id, ...origin });
    expect(await entriesOf(ws, reportId)).toMatchObject([
      { visibility: "admins", assignment: "claimed", author: { id: ADMIN.id }, ...origin },
    ]);

    // An approved release is the owner's too, and leaves the report with nobody.
    let release = await queueAction(ws, 8, "issueReportAssignment", RELEASE(reportId));
    expect(await approve(ws, release, OTHER_ADMIN)).toBeUndefined();
    expect(await assigneeOf(ws, reportId)).toBeUndefined();
    expect((await entriesOf(ws, reportId)).map(entry => entry.assignment))
        .toEqual(["claimed", "released"]);
  }));

  it("makes one call of an assignment's two, and no other kind's", () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws);
    let id = await queueAction(ws, 9, "issueReportAssignment",
        [...CLAIM(reportId), ...RELEASE(reportId)]);
    expect(await approve(ws, id)).toBeUndefined();
    expect((await ws.facet.outcomes(9))![1]).toEqual({ error: "This action has made its one call." });
    expect(await assigneeOf(ws, reportId)).toMatchObject({ id: ADMIN.id });

    let status = await queueAction(ws, 10, "issueReportAssignment",
        [{ method: "setIssueReportStatus", args: [reportId, "closed"] }]);
    expect(await approve(ws, status)).toBe("This action may only call " +
        "AdminApi.claimIssueReport() or AdminApi.releaseIssueReport().");
    let note = await queueAction(ws, 11, "issueReportNote", RELEASE(reportId));
    expect(await approve(ws, note)).toBe("This action may only call AdminApi.addIssueReportEntry().");
    expect(await assigneeOf(ws, reportId)).toMatchObject({ id: ADMIN.id });
    expect((await entriesOf(ws, reportId)).map(entry => entry.assignment)).toEqual(["claimed"]);
  }));

  it("refuses a take-over to a lent call", () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws);
    await ws.impl.issueReports.getByName("").claim(OTHER_ADMIN, { via: "api" }, reportId);
    let held = { id: OTHER_ADMIN.id, via: "api" };

    // The store refuses it where the call lands, whatever was approved.
    let takeOver = await queueAction(ws, 12, "issueReportAssignment",
        [{ method: "claimIssueReport", args: [reportId, { takeOverFrom: OTHER_ADMIN.id }] }]);
    expect(await approve(ws, takeOver)).toBe("Only a person takes an issue report over.");
    expect(await assigneeOf(ws, reportId)).toMatchObject(held);

    // A claim and a release of another admin's report are refused too.
    let claim = await queueAction(ws, 13, "issueReportAssignment", CLAIM(reportId));
    expect(await approve(ws, claim)).toBe("Another admin holds this issue report.");
    let release = await queueAction(ws, 14, "issueReportAssignment", RELEASE(reportId));
    expect(await approve(ws, release)).toBe("Another admin holds this issue report.");
    expect(await assigneeOf(ws, reportId)).toMatchObject(held);
    expect((await entriesOf(ws, reportId)).map(entry => entry.assignment)).toEqual(["claimed"]);
  }));

  it("ends a lend whose call was never made when the apply returns",
      () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws);
    let id = await queueAction(ws, 2, "issueReportStatus", []);
    expect(await approve(ws, id)).toBeUndefined();
    expect(await ws.facet.onKept("action:2",
        { method: "setIssueReportStatus", args: [reportId, "closed"] })).toEqual({ error: ENDED });
    expect(await entriesOf(ws, reportId)).toEqual([]);
  }));

  it("cannot write an entry of another visibility, and stays pending",
      () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws);
    let id = await queueAction(ws, 3, "issueReportNote",
        [{ method: "addIssueReportEntry", args: [reportId, "To the reporter.", "public"] }]);
    expect(await approve(ws, id)).toBe(`This action may only write a "admins" entry.`);
    expect(stateOf(ws, id)).toBe("pending");
    expect(await entriesOf(ws, reportId)).toEqual([]);

    // Its next approval gets a lend of its own.
    await ws.facet.plan(3,
        [{ method: "addIssueReportEntry", args: [reportId, "For admins.", "admins"] }]);
    expect(await approve(ws, id)).toBeUndefined();
    expect(await entriesOf(ws, reportId)).toMatchObject([{ visibility: "admins" }]);
  }));

  it("cannot file a request for content as a write", () => adminWorkspace(async ws => {
    let id = await queueAction(ws, 4, "workspaceWriteRequest",
        [{ method: "requestContentAccess", args: [ws.id, REASON] }]);
    expect(await approve(ws, id))
        .toBe("This action may only call AdminApi.writeWorkspace().");
    expect(stateOf(ws, id)).toBe("pending");
    expect(await ws.records()).toEqual([]);
  }));

  it.each<AdminAgentAction>(["issueReportReply", "contentAccessRequest", "workspaceWriteRequest"])(
      "is never applied by a rule when its kind is %s, whatever its description claims",
      kind => adminWorkspace(async ws => {
    let reportId = await fileReport(ws);
    enableRule(ws, kind);
    let call = kind === "issueReportReply"
        ? { method: "addIssueReportEntry", args: [reportId, "To the reporter.", "public"] }
        : kind === "contentAccessRequest"
        ? { method: "requestContentAccess", args: [ws.id, REASON] }
        : { method: "writeWorkspace", args: [ws.id, "restartWorkspace", {}, REASON] };
    let id = await queueAction(ws, 5, kind, [call], { claims: { autoApprovable: true } });
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);

    expect(stateOf(ws, id)).toBe("pending");
    // The lend refused before the facet was called.
    expect(await ws.facet.outcomes(5)).toBeUndefined();
    expect(await entriesOf(ws, reportId)).toEqual([]);
    expect(await ws.records()).toEqual([]);
    await expect(ws.impl.lendAdminApi(ws.gatekeeperId, AGENT,
        { for: "action", kind, autoApproved: true, decidedBy: ADMIN.id }))
        .rejects.toThrow("This kind of action is never auto-approved.");
  }));

  it("refuses an action whose tag is not one of the gatekeeper's", () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws);
    let id = await queueAction(ws, 6, "issueReportNote",
        [{ method: "addIssueReportEntry", args: [reportId, "A note.", "admins"] }],
        { claims: { actionKind: { tag: "post-anything", label: "Post anything" } } });
    expect(await approve(ws, id)).toBe("This is not an action of the admin gatekeeper.");
    expect(stateOf(ws, id)).toBe("pending");
    expect(await ws.facet.outcomes(6)).toBeUndefined();
    expect(await entriesOf(ws, reportId)).toEqual([]);
  }));
});

// The one call of an admins-only note on report `reportId`.
const NOTE = (reportId: string) =>
    [{ method: "addIssueReportEntry", args: [reportId, "A note.", "admins"] }];

// The one call that sets report `reportId` to "investigating".
const STATUS = (reportId: string) =>
    [{ method: "setIssueReportStatus", args: [reportId, "investigating"] }];

// The one call of a public reply to report `reportId`'s reporter.
const REPLY = (reportId: string) =>
    [{ method: "addIssueReportEntry", args: [reportId, "To the reporter.", "public"] }];

// What a lend refuses an auto-approval with where ruleApplies() does not allow its kind.
const WAITS = "This workspace holds restricted data: this action waits for a person.";

describe("restricted data", () => {
  // A reporter of this describe's own: the store lets one reporter file only so many reports a
  // day, and the rest of the suite files NOT_ADMIN's.
  const REPORTER: AiChatAuthorInfo =
      { type: "user", id: "reporter@example.test", name: "Reporter" };

  // Marks the workspace as an observation of restricted data through the admin connection does.
  async function latch(ws: AdminWorkspace): Promise<void> {
    using session = await ws.session();
    await session.observe(
        { title: "Read", description: "A read.", containsRestrictedData: true });
    expect(ws.impl.storage.containsRestrictedData.get()).toBe(true);
  }

  // Adds a connection of another vendor and returns its id.
  async function otherConnection(ws: AdminWorkspace): Promise<number> {
    let client = await ws.impl.addGatekeeper(
        ws.impl.ctx.exports.FakeAdminGatekeeper({ props: {} }),
        { type: "gatekeeper", vendorId: "othervendor", resourceUrl: "https://other.example/",
          typeUrlPattern: "https://other.example/" }, "owner-user-do");
    return client.getId();
  }

  // Marks the workspace as an observation of restricted data through connection `id` does.
  async function latchThrough(ws: AdminWorkspace, id: number): Promise<void> {
    using session = await ws.impl.openGatekeeperSession(
        id, await ws.impl.getGatekeeperFacet(id), { from: "user" });
    await session.observe(
        { title: "Read", description: "A read.", containsRestrictedData: true });
  }

  const lend = (ws: AdminWorkspace, kind: AdminAgentAction, autoApproved: boolean) =>
      ws.impl.lendAdminApi(ws.gatekeeperId, AGENT,
          { for: "action", kind, autoApproved, decidedBy: ADMIN.id });

  it("keeps applying a note, a status and a claim by rule once the workspace holds what its own " +
      "reads marked", () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws, REPORTER);
    enableRule(ws, "issueReportNote");
    enableRule(ws, "issueReportStatus");
    enableRule(ws, "issueReportAssignment");

    // Before the first read, as after it.
    let first = await queueAction(ws, 1, "issueReportNote", NOTE(reportId));
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect(ws.impl.storage.actions.get(first)).toMatchObject(
        { state: "approved", autoApproved: true, resolvedBy: ADMIN });

    await latch(ws);
    let note = await queueAction(ws, 2, "issueReportNote", NOTE(reportId));
    let status = await queueAction(ws, 3, "issueReportStatus", STATUS(reportId));
    let claim = await queueAction(ws, 4, "issueReportAssignment", CLAIM(reportId));
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);

    for (let id of [note, status, claim]) {
      expect(ws.impl.storage.actions.get(id)).toMatchObject(
          { state: "approved", autoApproved: true, resolvedBy: ADMIN });
    }
    let origin = { via: "gatekeeper", agent: { workspaceId: ws.id, chatId: 5 } };
    expect(await entriesOf(ws, reportId)).toMatchObject([
      { visibility: "admins", text: "A note." },
      { visibility: "admins", text: "A note.", author: { id: ADMIN.id }, ...origin },
      { status: "investigating", author: { id: ADMIN.id }, ...origin },
      { visibility: "admins", assignment: "claimed", author: { id: ADMIN.id }, ...origin },
    ]);
    expect(await assigneeOf(ws, reportId)).toMatchObject({ id: ADMIN.id, ...origin });

    // The one rule is for both of an assignment's calls.
    let release = await queueAction(ws, 5, "issueReportAssignment", RELEASE(reportId));
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect(ws.impl.storage.actions.get(release)).toMatchObject(
        { state: "approved", autoApproved: true });
    expect(await assigneeOf(ws, reportId)).toBeUndefined();
  }));

  it("holds a scoped reply and a write under the mark, rule or not",
      () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws, REPORTER);
    enableRule(ws, "issueReportScopedReply");
    enableRule(ws, "workspaceWriteRequest");

    await latch(ws);
    let reply = await queueAction(ws, 1, "issueReportScopedReply", REPLY(reportId));
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect(stateOf(ws, reply)).toBe("pending");
    expect(await ws.facet.outcomes(1)).toBeUndefined();
    expect(await entriesOf(ws, reportId)).toEqual([]);

    // A person still approves it, after which the write is first in line and waits too.
    expect(await approve(ws, reply)).toBeUndefined();
    expect((await entriesOf(ws, reportId)).map(entry => entry.visibility)).toEqual(["public"]);
    let request = await queueAction(ws, 2, "workspaceWriteRequest",
        [{ method: "writeWorkspace", args: [ws.id, "restartWorkspace", {}, REASON] }]);
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect(stateOf(ws, request)).toBe("pending");
    expect(await ws.facet.outcomes(2)).toBeUndefined();
  }));

  it("applies a note queued before the first read once the action ahead of it is approved, and " +
      "holds a scoped reply queued the same way", () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws, REPORTER);
    enableRule(ws, "issueReportNote");
    enableRule(ws, "issueReportScopedReply");
    // A manual action first, so that what is queued behind it is not applied yet.
    let manual = await queueAction(ws, 1, "issueReportStatus", STATUS(reportId));
    let note = await queueAction(ws, 2, "issueReportNote", NOTE(reportId));
    let reply = await queueAction(ws, 3, "issueReportScopedReply", REPLY(reportId));
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect([manual, note, reply].map(id => stateOf(ws, id)))
        .toEqual(["pending", "pending", "pending"]);

    await latch(ws);
    expect(await approve(ws, manual)).toBeUndefined();
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect(ws.impl.storage.actions.get(note)).toMatchObject(
        { state: "approved", autoApproved: true });
    expect(stateOf(ws, reply)).toBe("pending");
    expect((await entriesOf(ws, reportId)).map(entry => entry.visibility))
        .toEqual(["public", "admins"]);
  }));

  it("lends to an auto-approval, where the power is handed over, only for a note, a status and " +
      "an assignment", () => adminWorkspace(async ws => {
    const EXEMPT: AdminAgentAction[] =
        ["issueReportNote", "issueReportStatus", "issueReportAssignment"];
    const HELD: AdminAgentAction[] = ["issueReportScopedReply"];
    for (let kind of [...EXEMPT, ...HELD]) (await lend(ws, kind, true)).end();
    // A write is never lent to an auto-approval, marked or not.
    await expect(lend(ws, "workspaceWriteRequest", true)).rejects.toThrow(/never auto-approved/);

    await latch(ws);
    for (let kind of EXEMPT) (await lend(ws, kind, true)).end();
    for (let kind of [...HELD, "workspaceWriteRequest" as const]) {
      await expect(lend(ws, kind, true), kind).rejects.toThrow(WAITS);
    }
    // A person's approval is lent to all the same.
    for (let kind of [...EXEMPT, ...HELD, "workspaceWriteRequest" as const]) {
      (await lend(ws, kind, false)).end();
    }
  }));

  it.each(["after", "before"] as const)(
      "applies nothing once another vendor's restricted data was read here, %s the admin " +
      "connection's", order => adminWorkspace(async ws => {
    let reportId = await fileReport(ws, REPORTER);
    let otherId = await otherConnection(ws);
    enableRule(ws, "issueReportNote");

    if (order === "before") await latchThrough(ws, otherId);
    await latch(ws);
    if (order === "after") await latchThrough(ws, otherId);
    expect(ws.impl.storage.adminRestrictedDataOnly.get()).toBe(false);

    let note = await queueAction(ws, 1, "issueReportNote", NOTE(reportId));
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect(stateOf(ws, note)).toBe("pending");
    expect(await ws.facet.outcomes(1)).toBeUndefined();
    await expect(lend(ws, "issueReportNote", true)).rejects.toThrow(WAITS);

    // A further read through the admin connection changes nothing, and a person still approves.
    await latch(ws);
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect(stateOf(ws, note)).toBe("pending");
    expect(await approve(ws, note)).toBeUndefined();
    expect(await entriesOf(ws, reportId)).toHaveLength(1);
  }));

  it("holds an action whose turn did not pause once another vendor's read lands before the drain",
      () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws, REPORTER);
    let otherId = await otherConnection(ws);
    enableRule(ws, "issueReportNote");
    await latch(ws);

    // The drain submitAction() schedules is held back until the other vendor's read has landed.
    let drain = ws.impl.drainAutoApprovals.bind(ws.impl);
    let scheduled = 0;
    ws.impl.drainAutoApprovals = async () => { scheduled++; };
    let note = await queueAction(ws, 1, "issueReportNote", NOTE(reportId),
        { claims: { awaitDecision: true } });
    // The rule applied at submit: a drain was scheduled, and the turn was not told to wait.
    expect(scheduled).toBe(1);
    await latchThrough(ws, otherId);
    ws.impl.drainAutoApprovals = drain;
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);

    expect(stateOf(ws, note)).toBe("pending");
    expect(await ws.facet.outcomes(1)).toBeUndefined();
    expect(ws.impl.consumeCapturedActions(AGENT.chatId))
        .toMatchObject({ actions: [note], awaitDecision: false });
    expect(await approve(ws, note)).toBeUndefined();
    expect(await entriesOf(ws, reportId)).toHaveLength(1);
  }));

  // The two waits between a rule's lend and the write it was lent for: the gatekeeper on its
  // way to the call, and the lend asking, as the call arrives, whether the gatekeeper is off.
  it.each(["before the gatekeeper makes its call", "while the lent call is checked"] as const)(
      "holds an action a rule was lent for when another vendor's read lands %s",
      gap => adminWorkspace(async ws => {
    let reportId = await fileReport(ws, REPORTER);
    let otherId = await otherConnection(ws);
    enableRule(ws, "issueReportNote");
    await latch(ws);

    let lendAdminApi = ws.impl.lendAdminApi.bind(ws.impl);
    let lent = false;
    ws.impl.lendAdminApi = async (...args: unknown[]) => {
      let lend = await lendAdminApi(...args);
      lent = true;
      if (gap === "before the gatekeeper makes its call") await latchThrough(ws, otherId);
      return lend;
    };
    // The first read of the admin config after the lend is the lent call's.
    let kv = ws.env.BLUEPRINTS as { get(key: string): Promise<string | null> };
    let readConfig = kv.get;
    kv.get = async key => {
      if (lent && gap === "while the lent call is checked") {
        lent = false;
        await latchThrough(ws, otherId);
      }
      return readConfig(key);
    };

    // Queuing it schedules the drain that applies it.
    let note = await queueAction(ws, 1, "issueReportNote", NOTE(reportId));
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect(lent).toBe(gap === "before the gatekeeper makes its call");
    expect(await ws.facet.outcomes(1)).toEqual([{ error: WAITS }]);
    expect(stateOf(ws, note)).toBe("pending");
    expect(await entriesOf(ws, reportId)).toEqual([]);

    // Nothing was done, so a person still approves it.
    expect(await approve(ws, note)).toBeUndefined();
    expect(ws.impl.storage.actions.get(note)).toMatchObject(
        { state: "approved", autoApproved: false });
    expect(await entriesOf(ws, reportId)).toHaveLength(1);
  }));

  it("holds a note under the mark of a workspace latched before the singleton existed",
      () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws, REPORTER);
    enableRule(ws, "issueReportNote");
    ws.impl.storage.containsRestrictedData.put(true);

    let note = await queueAction(ws, 1, "issueReportNote", NOTE(reportId));
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect(stateOf(ws, note)).toBe("pending");
    await expect(lend(ws, "issueReportNote", true)).rejects.toThrow(WAITS);

    // A read through the admin connection afterwards does not make the workspace exempt.
    await latch(ws);
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect(stateOf(ws, note)).toBe("pending");
  }));

  it("is not fooled by a tag: another vendor's action tagged as a note waits",
      () => adminWorkspace(async ws => {
    let otherId = await otherConnection(ws);
    ws.impl.storage.autoApproveTags.put({
      gatekeeperId: otherId, actionKind: ADMIN_AGENT_ACTIONS.issueReportNote.kind, enabledBy: ADMIN,
    });
    // Every action the drain goes on to apply, by its record's id.
    let applied: number[] = [];
    let apply = ws.impl.applyPendingAction.bind(ws.impl);
    ws.impl.applyPendingAction = (record: { id: number }, ...rest: unknown[]) => {
      applied.push(record.id);
      return apply(record, ...rest);
    };
    using session = await ws.impl.openGatekeeperSession(
        otherId, await ws.impl.getGatekeeperFacet(otherId), AGENT);
    let queued = () => [...ws.impl.storage.actions.list()]
        .filter((action: any) => action.type === "action" && action.gatekeeperId === otherId)
        .map((action: any) => action.id);

    // Unmarked, the rule is tried: the fixture facet applies nothing for another vendor, so
    // the action stays first in line and each drain tries it again.
    await session.submit(1, describeAction("issueReportNote"));
    await ws.impl.drainAutoApprovals(otherId);
    let [first] = queued();
    expect(applied.length).toBeGreaterThan(0);
    expect(new Set(applied)).toEqual(new Set([first]));

    // Marked by the admin connection alone, which exempts that connection's notes and no other's:
    // no drain tries either action again.
    await latch(ws);
    expect(ws.impl.storage.adminRestrictedDataOnly.get()).toBe(true);
    let tried = applied.length;
    await session.submit(2, describeAction("issueReportNote"));
    await ws.impl.drainAutoApprovals(otherId);
    expect(queued()).toHaveLength(2);
    expect(applied).toHaveLength(tried);
    expect(queued().map((id: number) => stateOf(ws, id))).toEqual(["pending", "pending"]);
  }));

  it("lets a rule-applied note under the mark add only an admins-only entry",
      () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws, REPORTER);
    enableRule(ws, "issueReportNote");
    await latch(ws);

    let note = await queueAction(ws, 1, "issueReportNote", REPLY(reportId));
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect(await ws.facet.outcomes(1))
        .toEqual([{ error: `This action may only write a "admins" entry.` }]);
    expect(stateOf(ws, note)).toBe("pending");
    expect(await entriesOf(ws, reportId)).toEqual([]);
  }));
});

describe("the catalog of auto-approvable kinds", () => {
  const KINDS = Object.values(ADMIN_AGENT_ACTIONS).filter(action => action.autoApprovable)
      .map(action => action.kind);

  // The catalog as the workspace's owner reads it, by connection: each kind's tag and whether a
  // rule for it applies. Every connection's facet offers the admin gatekeeper's kinds.
  async function catalog(ws: AdminWorkspace): Promise<Record<number, Record<string, boolean>>> {
    ws.impl.getGatekeeperFacet = async () => ({ getAutoApprovableActions: async () => KINDS });
    ws.impl.ensureAmbientCapsules = async () => {};
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await ws.instance.open(ws.impl.ownerId, ws.owner.id, notifyClosed) as
        unknown as Overseer & Disposable;
    let byConnection: Record<number, Record<string, boolean>> = {};
    for (let entry of await client.listPreApprovableActions()) {
      expect(byConnection[entry.gatekeeperId]?.[entry.actionKind.tag], entry.actionKind.tag)
          .toBeUndefined();
      (byConnection[entry.gatekeeperId] ??= {})[entry.actionKind.tag] = entry.ruleApplies;
    }
    return byConnection;
  }

  const tags = (applies: (kind: AdminAgentAction) => boolean) => Object.fromEntries(
      (Object.keys(ADMIN_AGENT_ACTIONS) as AdminAgentAction[])
          .filter(kind => ADMIN_AGENT_ACTIONS[kind].autoApprovable)
          .map(kind => [ADMIN_AGENT_ACTIONS[kind].kind.tag, applies(kind)]));

  it("lists the admin connection no gadget binds, with the kinds a rule applies as the " +
      "workspace is", () => adminWorkspace(async ws => {
    let client = await ws.impl.addGatekeeper(
        ws.impl.ctx.exports.FakeAdminGatekeeper({ props: {} }),
        { type: "gatekeeper", vendorId: "othervendor", resourceUrl: "https://other.example/",
          typeUrlPattern: "https://other.example/" }, "owner-user-do");
    let otherId: number = await client.getId();
    let observe = async (id: number) => {
      using session = await ws.impl.openGatekeeperSession(
          id, await ws.impl.getGatekeeperFacet(id), { from: "user" });
      await session.observe(
          { title: "Read", description: "A read.", containsRestrictedData: true });
    };
    let facetOf = ws.impl.getGatekeeperFacet.bind(ws.impl);
    let listed = async () => {
      try {
        return await catalog(ws);
      } finally {
        ws.impl.getGatekeeperFacet = facetOf;
      }
    };

    // Unmarked: the admin connection alone, once, and a rule applies every kind. The other
    // vendor's connection, which no gadget binds either, is not listed.
    expect(await listed()).toEqual({ [ws.gatekeeperId]: tags(() => true) });

    // Marked by the admin connection: a note, a status and an assignment.
    await observe(ws.gatekeeperId);
    expect(await listed()).toEqual({ [ws.gatekeeperId]: tags(kind =>
        ["issueReportNote", "issueReportStatus", "issueReportAssignment"].includes(kind)) });

    // Once another vendor's restricted data was read here: nothing.
    await observe(otherId);
    expect(await listed()).toEqual({ [ws.gatekeeperId]: tags(() => false) });
  }));
});

describe("who is lent the Admin API", () => {
  it("lends nothing in a workspace whose owner is not an admin", () => adminWorkspace(async ws => {
    using session = await ws.session(AGENT);
    expect(await session.read({ method: "listUsers" }, { api: "api" }))
        .toEqual({ error: NOT_ADMIN_MESSAGE });
    expect(await ws.facet.kept()).toEqual([]);

    // Nor is anything queued, which a rule could apply once the owner is an admin again.
    let reportId = await fileReport(ws);
    await ws.facet.plan(1, [{ method: "addIssueReportEntry", args: [reportId, "A note.", "admins"] }]);
    expect(await refusedSubmit(ws, 1, "issueReportNote")).toBe(NOT_ADMIN_MESSAGE);
    expect(await ws.facet.outcomes(1)).toBeUndefined();
  }, { owner: NOT_ADMIN }));

  it("lends nothing, and queues nothing, while the vendor's mode is disabled",
      () => adminWorkspace(async ws => {
    // Queued before the vendor was turned off: it waits, and is not applied meanwhile.
    let id = await queueAction(ws, 1, "issueReportStatus", []);
    ws.config.ambientGatekeeperModes.admin = "disabled";
    using session = await ws.session(AGENT);
    expect(await session.read({ method: "listUsers" }))
        .toEqual({ error: "Gatekeeper is disabled." });
    expect(await approve(ws, id)).toBe("Gatekeeper is disabled.");
    expect(stateOf(ws, id)).toBe("pending");
    expect(await refusedSubmit(ws, 2, "issueReportStatus")).toBe("Gatekeeper is disabled.");

    ws.config.ambientGatekeeperModes.admin = "enabled";
    expect((await session.read({ method: "listUsers" })).error).toBeUndefined();
  }));

  it("lends nothing to a session another admin opened from the connection itself",
      () => adminWorkspace(async ws => {
    // A "build" collaborator who is a deployment admin, as getGatekeeperById().openSession()
    // opens a session for one: a holder, and a caller with no chat.
    using theirs = await ws.session({ from: "user" }, { kind: "build", profileId: OTHER_ADMIN.id });
    let outcome = await theirs.read(OPEN(ws), { api: "api", result: "view" });
    expect(outcome.error).toMatch(/^Only this workspace's owner can open the admin connection/);
    expect(await ws.facet.kept()).toEqual([]);
    expect(await ws.records()).toEqual([]);

    // The owner's own direct session is lent to, and recorded with no chat.
    using own = await ws.session({ from: "user" });
    expect(await own.read(OPEN(ws), { result: "view" })).toEqual({ kept: "view" });
    expect(await ws.records()).toMatchObject(
        [{ method: "inspectWorkspace", admin: ADMIN.id, agent: { workspaceId: ws.id } }]);
    expect((await ws.records())[0]!.agent).toEqual({ workspaceId: ws.id });

    // From a chat, the same collaborator's call is the chat's: the chat keeps who prompted it.
    using chat = await ws.session(AGENT, { kind: "build", profileId: OTHER_ADMIN.id });
    expect((await chat.read({ method: "listUsers" })).error).toBeUndefined();
  }));

  it("queues nothing for a session another admin opened from the connection itself",
      () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws);
    // A rule would apply the note at once, as the owner's, with nobody deciding it.
    enableRule(ws, "issueReportNote");
    await ws.facet.plan(1, NOTE(reportId));
    using theirs = await ws.session({ from: "user" }, { kind: "build", profileId: OTHER_ADMIN.id });
    let refusal = await theirs.submit(1, describeAction("issueReportNote"))
        .then(() => undefined, (error: Error) => error.message);
    expect(refusal).toMatch(/^Only this workspace's owner can open the admin connection/);
    expect([...ws.impl.storage.actions.list()]).toEqual([]);
    expect(await ws.facet.outcomes(1)).toBeUndefined();
    expect(await entriesOf(ws, reportId)).toEqual([]);

    // The owner's own direct session queues, and the rule applies it.
    using own = await ws.session({ from: "user" });
    await own.submit(1, describeAction("issueReportNote"));
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect(await entriesOf(ws, reportId)).toMatchObject(
        [{ author: { id: ADMIN.id }, via: "gatekeeper", agent: { workspaceId: ws.id } }]);

    // From a chat, the same collaborator's action is the chat's.
    await ws.facet.plan(2, NOTE(reportId));
    using chat = await ws.session(AGENT, { kind: "build", profileId: OTHER_ADMIN.id });
    await chat.submit(2, describeAction("issueReportNote"));
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect(await entriesOf(ws, reportId)).toHaveLength(2);
  }));

  it("queues nothing once the user stopped the turn its session belongs to",
      () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws);
    // A rule would apply the note at once, with nobody deciding it.
    enableRule(ws, "issueReportNote");
    await ws.facet.plan(1, NOTE(reportId));
    vi.spyOn(ws.impl, "isLiveExecution").mockReturnValue(true);
    let stopped = vi.spyOn(ws.impl, "isStoppedExecution").mockReturnValue(false);
    using session = await ws.impl.openGatekeeperSession(ws.gatekeeperId,
        await ws.impl.getGatekeeperFacet(ws.gatekeeperId), AGENT, "execution-1");

    stopped.mockReturnValue(true);
    let refusal = await session.submit(1, describeAction("issueReportNote"))
        .then(() => undefined, (error: Error) => error.message);
    expect(refusal).toBe("The user stopped the agent turn this session belongs to.");
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect([...ws.impl.storage.actions.list()]).toEqual([]);
    expect(await entriesOf(ws, reportId)).toEqual([]);
  }));

  it("queues nothing for a turn stopped while the connection's owner is looked up",
      () => adminWorkspace(async ws => {
    vi.spyOn(ws.impl, "isLiveExecution").mockReturnValue(true);
    let stopped = vi.spyOn(ws.impl, "isStoppedExecution").mockReturnValue(false);
    using session = await ws.impl.openGatekeeperSession(ws.gatekeeperId,
        await ws.impl.getGatekeeperFacet(ws.gatekeeperId), AGENT, "execution-1");
    let lookup = ws.impl.adminConnectionOwner.bind(ws.impl);
    vi.spyOn(ws.impl, "adminConnectionOwner").mockImplementation(async (id: number) => {
      let owner = await lookup(id);
      stopped.mockReturnValue(true);
      return owner;
    });

    let refusal = await session.submit(1, describeAction("workspaceWriteRequest"))
        .then(() => undefined, (error: Error) => error.message);
    expect(refusal).toBe("The user stopped the agent turn this session belongs to.");
    expect([...ws.impl.storage.actions.list()]).toEqual([]);
  }));

  it("refuses an action a member who is not an admin approved", () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws);
    let id = await queueAction(ws, 1, "issueReportNote",
        [{ method: "addIssueReportEntry", args: [reportId, "A note.", "admins"] }]);
    expect(await approve(ws, id, NOT_ADMIN)).toBe(NOT_ADMIN_MESSAGE);
    expect(stateOf(ws, id)).toBe("pending");
    expect(await ws.facet.outcomes(1)).toBeUndefined();

    // Nor does a rule that member enabled apply anything.
    enableRule(ws, "issueReportNote", NOT_ADMIN);
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect(stateOf(ws, id)).toBe("pending");
    expect(await entriesOf(ws, reportId)).toEqual([]);

    // A member who was demoted is refused as one who never was an admin.
    ws.env.ADMINS = [ADMIN.id];
    expect(await approve(ws, id, OTHER_ADMIN)).toBe(NOT_ADMIN_MESSAGE);
    expect(await approve(ws, id, ADMIN)).toBeUndefined();
    expect(await entriesOf(ws, reportId)).toHaveLength(1);
  }));

  it("gives a connection of another vendor a plain queue and no lend",
      () => adminWorkspace(async ws => {
    let client = await ws.impl.addGatekeeper(
        ws.impl.ctx.exports.FakeAdminGatekeeper({ props: {} }),
        { type: "gatekeeper", vendorId: "othervendor", resourceUrl: "https://other.example/",
          typeUrlPattern: "https://other.example/" }, "owner-user-do");
    let otherId: number = await client.getId();
    let facet = await ws.impl.getGatekeeperFacet(otherId);

    using session = await ws.impl.openGatekeeperSession(otherId, facet, AGENT);
    let outcome = await session.read({ method: "listUsers" }, { api: "api" });
    expect(outcome.error).toMatch(/getAdminApi/);
    expect(await facet.kept()).toEqual([]);
    await expect(ws.impl.lendAdminApi(otherId, AGENT,
        { for: "session", until: Date.now() + 60_000, live: () => {} }))
        .rejects.toThrow("This connection is not the admin gatekeeper's.");

    // Its actions are applied as any gatekeeper's are, with nothing lent.
    await session.submit(1, describeAction("issueReportNote"));
    let [record] = [...ws.impl.storage.actions.list()]
        .filter((action: any) => action.gatekeeperId === otherId);
    expect(await approve(ws, record.id))
        .toBe("applyAction() was called on the admin gatekeeper.");
    expect(await facet.outcomes(1)).toBeUndefined();
  }));

  it("lends nothing once the connection is gone", () => adminWorkspace(async ws => {
    await expect(ws.impl.lendAdminApi(7, AGENT,
        { for: "session", until: Date.now() + 60_000, live: () => {} }))
        .rejects.toThrow("This connection is not the admin gatekeeper's.");
  }, { connection: false }));

  it("starts a hook of the admin gatekeeper only while the owner is an admin",
      () => adminWorkspace(async ws => {
    ws.impl.storage.boundHooks.put({
      id: 1, actionId: 1, gatekeeperId: ws.gatekeeperId, vendorId: "admin",
      controller: {} as any, callback: {} as any,
      description: { title: "Issue reported", description: "Wakes the triage gadget." },
      enabled: true,
    });
    let firing = await ws.instance.startHook(1);
    expect(firing.callback).toBeDefined();
    expect(firing.approvalQueue).toBeDefined();

    ws.env.ADMINS = [OTHER_ADMIN.id];
    await expect(ws.instance.startHook(1)).rejects.toThrow(NOT_ADMIN_MESSAGE);
    ws.env.ADMINS = [ADMIN.id];
    expect((await ws.instance.startHook(1)).callback).toBeDefined();

    // A hook of any other vendor is not asked the question.
    ws.impl.storage.boundHooks.put({
      ...ws.impl.storage.boundHooks.get(1), id: 2, vendorId: "othervendor",
    });
    ws.env.ADMINS = [];
    expect((await ws.instance.startHook(2)).callback).toBeDefined();
  }));
});

// The ids of the accounts of the admin gatekeeper in the owner's storage, offered or not.
function ownerAccounts(ws: AdminWorkspace): Promise<number[]> {
  return runInDurableObject(ws.ownerDo, user => {
    let { storage } = user as unknown as { storage: {
      nextAccountId: { get(): number };
      connectedAccounts: { get(id: number): { vendorId: string } | undefined };
    } };
    let ids: number[] = [];
    for (let id = 0; id < storage.nextAccountId.get(); id++) {
      if (storage.connectedAccounts.get(id)?.vendorId === "admin") ids.push(id);
    }
    return ids;
  });
}

// A hook of the admin connection, as a subscription to its issue reports leaves one.
function bindHook(ws: AdminWorkspace, id: number) {
  ws.impl.storage.boundHooks.put({
    id, actionId: id, gatekeeperId: ws.gatekeeperId, vendorId: "admin",
    controller: {} as any, callback: {} as any,
    description: { title: "Issue reported", description: "Wakes the triage gadget." },
    enabled: true,
  });
}

describe("the owner's account of the admin gatekeeper", () => {
  it("ends its connections when it is removed, and brings them back when it is added again",
      () => adminWorkspace(async ws => {
    let reportId = await fileReport(ws);
    bindHook(ws, 1);
    enableRule(ws, "issueReportNote");
    let id = await queueAction(ws, 1, "issueReportStatus",
        [{ method: "setIssueReportStatus", args: [reportId, "investigating"] }]);
    expect(stateOf(ws, id)).toBe("pending");
    using session = await ws.session(AGENT);
    expect((await session.read({ method: "listUsers" }, { api: "before" })).error).toBeUndefined();

    let [accountId] = await ownerAccounts(ws);
    await ws.ownerDo.disconnectAccount(accountId!);
    expect(await ownerAccounts(ws)).toEqual([]);

    // Nothing more is lent: to a session, to an approved action or to a hook's firing.
    expect(await session.read(OPEN(ws), { api: "after", result: "view" }))
        .toEqual({ error: ACCOUNT_REMOVED });
    using next = await ws.session(AGENT);
    expect(await next.read({ method: "listUsers" })).toEqual({ error: ACCOUNT_REMOVED });
    expect(await approve(ws, id)).toBe(ACCOUNT_REMOVED);
    expect(await ws.facet.outcomes(1)).toBeUndefined();
    expect(await refusedSubmit(ws, 2, "issueReportStatus")).toBe(ACCOUNT_REMOVED);
    await expect(ws.instance.startHook(1)).rejects.toThrow(ACCOUNT_REMOVED);
    expect(await ws.facet.kept()).toEqual(["before"]);
    expect(await ws.records()).toEqual([]);
    // What was lent before stays lent until its session ends.
    expect((await ws.facet.onKept("before", { method: "listUsers" })).error).toBeUndefined();

    // The connection, its rule, its hook and its pending action are all kept.
    expect(ws.impl.storage.gatekeepers.get(ws.gatekeeperId)).toBeDefined();
    expect([...ws.impl.storage.autoApproveTags.list()]).toHaveLength(1);
    expect(ws.impl.storage.boundHooks.get(1)).toMatchObject({ enabled: true });
    expect(stateOf(ws, id)).toBe("pending");

    await ws.ownerDo.provisionAmbientAccount("admin");
    let [addedId] = await ownerAccounts(ws);
    expect(addedId).not.toBe(accountId);
    expect(await session.read(OPEN(ws), { result: "view" })).toEqual({ kept: "view" });
    expect((await ws.instance.startHook(1)).callback).toBeDefined();
    expect(await approve(ws, id)).toBeUndefined();
    expect(stateOf(ws, id)).toBe("approved");
    expect((await ws.impl.issueReports.getByName("").get(reportId)).status).toBe("investigating");
  }));

  it("lends nothing through a connection whose owner never had the account",
      () => adminWorkspace(async ws => {
    expect(await ownerAccounts(ws)).toEqual([]);
    bindHook(ws, 1);
    using session = await ws.session(AGENT);
    expect(await session.read({ method: "listUsers" }, { api: "api" }))
        .toEqual({ error: ACCOUNT_REMOVED });
    expect(await refusedSubmit(ws, 1, "issueReportStatus")).toBe(ACCOUNT_REMOVED);
    await expect(ws.instance.startHook(1)).rejects.toThrow(ACCOUNT_REMOVED);
    expect(await ws.facet.kept()).toEqual([]);

    // A hook of any other vendor is not asked the question.
    ws.impl.storage.boundHooks.put(
        { ...ws.impl.storage.boundHooks.get(1), id: 2, vendorId: "othervendor" });
    expect((await ws.instance.startHook(2)).callback).toBeDefined();
  }, { account: false }));

  it("is held only by a user who is an admin now and has it", () => adminWorkspace(async ws => {
    let holds = (vendorId = "admin") => ws.ownerDo.holdsGatekeeperAccount(vendorId);
    let accounts = await ownerAccounts(ws);
    expect(accounts).toHaveLength(1);
    let asked = await env.GATEKEEPER_ADMIN.calls();

    expect(await holds()).toBe(true);
    expect(await holds("Admin")).toBe(true);
    expect(await holds("ambientfixture")).toBe(false);
    // A user who is not an admin holds none, whatever their storage keeps.
    ws.env.ADMINS = [OTHER_ADMIN.id];
    expect(await holds()).toBe(false);
    ws.env.ADMINS = [ADMIN.id];
    expect(await holds()).toBe(true);

    // The question provisions nothing and asks no vendor.
    expect(await ownerAccounts(ws)).toEqual(accounts);
    expect(await env.GATEKEEPER_ADMIN.calls()).toEqual(asked);

    await ws.ownerDo.disconnectAccount(accounts[0]!);
    expect(await holds()).toBe(false);
    expect(await ownerAccounts(ws)).toEqual([]);

    // Nor a user who never signed in, though ADMINS names the profile every user object starts
    // with and the object's storage keeps a record: being created is all that is missing.
    let unsigned = await runInDurableObject(
        env.TEST_USER.getByName(`never-signed-in-${crypto.randomUUID()}`),
        async (user: UserDurableObject) => {
      let { storage } = user as unknown as { storage: {
        created: { put(created: boolean): void }; profile: { get(): { id: string } };
        nextAccountId: { put(id: number): void }; connectedAccounts: { put(record: unknown): void };
      } };
      Object.assign(user, { env: { ...ws.env, ADMINS: [storage.profile.get().id] } });
      let account = await env.GATEKEEPER_ADMIN.createAccount();
      storage.connectedAccounts.put({
        id: 0, account, description: await account.describe(), vendorId: "admin",
        autoProvisioned: true,
      });
      storage.nextAccountId.put(1);
      let before = [await user.holdsGatekeeperAccount("admin"), await user.whoamiIfExists()];
      storage.created.put(true);
      return [...before, await user.holdsGatekeeperAccount("admin")];
    });
    expect(unsigned).toEqual([false, null, true]);
  }));

  it("cannot be removed while the mode forces it", () => adminWorkspace(async ws => {
    let [accountId] = await ownerAccounts(ws);
    // Caught inside the account's object: the pool reports a refusal that leaves it as unhandled.
    let refusal = await runInDurableObject(ws.ownerDo, user => (user as UserDurableObject)
        .disconnectAccount(accountId!).then(() => undefined, error => (error as Error).message));
    expect(refusal).toBe("This account is provided automatically and can't be disconnected.");
    expect(await ws.ownerDo.holdsGatekeeperAccount("admin")).toBe(true);
    using session = await ws.session(AGENT);
    expect((await session.read({ method: "listUsers" })).error).toBeUndefined();
  }, { mode: "enabled" }));

  it("is provisioned again, once the mode forces it, when a workspace of its user is opened",
      () => adminWorkspace(async ws => {
    let [accountId] = await ownerAccounts(ws);
    await ws.ownerDo.disconnectAccount(accountId!);
    using session = await ws.session(AGENT);
    expect(await session.read({ method: "listUsers" })).toEqual({ error: ACCOUNT_REMOVED });

    ws.config.ambientGatekeeperModes.admin = "enabled";
    expect(await session.read({ method: "listUsers" })).toEqual({ error: ACCOUNT_REMOVED });
    await ws.impl.ensureAmbientCapsules();
    expect(await ownerAccounts(ws)).toHaveLength(1);
    expect((await session.read({ method: "listUsers" })).error).toBeUndefined();
    // Opening provisioned the account, and still added no connection of its own.
    expect([...ws.impl.storage.gatekeepers.list()].map((record: any) => record.id))
        .toEqual([ws.gatekeeperId]);
  }));
});

// What the deployment needs before a content access request can be filed and claimed, and a write
// run, around `run`: writes on and the level at "content" for the workspace and for the
// AdminSettings object the Admin API reaches, which is given the workspace's own environment (so
// that a test demotes or adds an admin in one place), and the workspace listed in the directory
// with its owner. Everything is put back afterwards.
async function withWrites(ws: AdminWorkspace, run: () => Promise<void>): Promise<void> {
  let settings = env.TEST_ADMIN_SETTINGS.getByName("");
  let directory = env.TEST_USER_DIRECTORY.getByName("");
  Object.assign(ws.env, { ADMIN_WORKSPACE_WRITES: "on", ADMIN_WORKSPACE_ACCESS_MAX: "content" });
  let before = await runInDurableObject(settings, object => {
    let { storage } = object as unknown as { storage: AdminSettingsStorage };
    let was = {
      env: (object as unknown as { env: unknown }).env, config: storage.adminConfig.get(),
    };
    Object.assign(object, { env: ws.env });
    storage.adminConfig.put({ ...was.config, adminWorkspaceAccess: "content" });
    return was;
  });
  await directory.syncWorkspace({ id: ws.id, title: "Triage", ownerId: ws.owner.id }, 1);
  try {
    await run();
  } finally {
    await directory.removeWorkspace(ws.id);
    await runInDurableObject(settings, object => {
      let { storage } = object as unknown as { storage: AdminSettingsStorage };
      Object.assign(object, { env: before.env });
      storage.adminConfig.put(before.config);
    });
  }
}

// The one call that asks for the workspace's own content.
const contentRequestOf = (ws: AdminWorkspace) =>
    [{ method: "requestContentAccess", args: [ws.id, REASON] }];

// The request action number `action` filed, as its one call answered: what a client is shown.
async function filedBy(ws: AdminWorkspace, action: number): Promise<AdminContentRequest> {
  let [outcome] = (await ws.facet.outcomes(action))!;
  expect(outcome!.error).toBeUndefined();
  return outcome!.value as AdminContentRequest;
}

// Who the stored request `id` keeps as having been in the workspace it was filed from.
const insidersOf = (id: string) => runInDurableObject(env.TEST_ADMIN_SETTINGS.getByName(""),
    object => (object as unknown as { storage: AdminSettingsStorage })
        .storage.contentAccessRequests.get(id)?.insiders);

// What `admin`'s claim of request `id` for their approval comes to: "claimed", which spends the
// request, or the code it is refused with. Asked inside the object, so that the error is the one
// thrown.
const claim = (id: string, admin: AiChatAuthorInfo) => runInDurableObject(
    env.TEST_ADMIN_SETTINGS.getByName(""), async object => {
  try {
    await object.claimContentAccess(id, { admin: admin.id, sessionId: "approver", via: "api" });
    return "claimed";
  } catch (error) {
    return getAdminGrantErrorCode(error);
  }
});

// The records of the workspace of kind `kind`, which here all name it.
const recordsOf = async <Kind extends "grant" | "write">(ws: AdminWorkspace, kind: Kind) =>
    (await ws.records() as unknown as AdminAuditRecord[]).filter(
        (record): record is Extract<AdminGrantRecord | AdminWriteRecord, { kind: Kind }> =>
            record.kind === kind);

describe("a write an agent asks for", () => {
  it("runs once a person approves its action, as the owner's, from the chat that queued it",
      () => adminWorkspace(ws => withWrites(ws, async () => {
    let id = await queueAction(ws, 1, "workspaceWriteRequest",
        [{ method: "writeWorkspace", args: [ws.id, "restartWorkspace", {}, REASON] }]);
    expect(await recordsOf(ws, "write")).toEqual([]);

    expect(await approve(ws, id, OTHER_ADMIN)).toBeUndefined();
    expect(await recordsOf(ws, "write")).toMatchObject([{
      admin: ADMIN.id, via: "gatekeeper", agent: { workspaceId: ws.id, chatId: 5 },
      workspaceId: ws.id, method: "restartWorkspace", reason: REASON,
    }]);
  })));
});

describe("a request for content access an agent files", () => {
  // Two more deployment admins: one who is never in the workspace, and one who joins it late.
  const OUTSIDE_ADMIN: AiChatAuthorInfo =
      { type: "user", id: "outside-admin@example.test", name: "Outside admin" };
  const LATE_ADMIN: AiChatAuthorInfo =
      { type: "user", id: "late-admin@example.test", name: "Late admin" };
  const ADMINS = { admins: [ADMIN.id, OTHER_ADMIN.id, OUTSIDE_ADMIN.id, LATE_ADMIN.id] };
  const { secondAdminRequired } = ADMIN_GRANT_ERROR_CODES;
  const OWNER_CALLER = { profileId: ADMIN.id, isOwner: true };

  // Shares the workspace with `user`, as its owner does.
  async function share(ws: AdminWorkspace, user: AiChatAuthorInfo): Promise<void> {
    (await ws.impl.getSharingManager()).addCollaborator(
        { caller: OWNER_CALLER, profile: user, grant: "workspace" });
  }

  // Takes `user` out of the workspace, as its owner does.
  async function unshare(ws: AdminWorkspace, user: AiChatAuthorInfo): Promise<void> {
    (await ws.impl.getSharingManager()).removeCollaborator(OWNER_CALLER, user.id, []);
  }

  it("cannot be approved by the owner, a member or whoever approved its filing",
      () => adminWorkspace(ws => withWrites(ws, async () => {
    await share(ws, OTHER_ADMIN);
    let id = await queueAction(ws, 1, "contentAccessRequest", contentRequestOf(ws));
    expect(await approve(ws, id, OTHER_ADMIN)).toBeUndefined();

    // The request is the owner's, from the chat that queued it, and shows no client the list.
    let filed = await filedBy(ws, 1);
    expect(filed).toMatchObject({
      workspaceId: ws.id, state: "pending", requestedBy: ADMIN.id, via: "gatekeeper",
      agent: { workspaceId: ws.id, chatId: 5 },
    });
    expect(filed).not.toHaveProperty("insiders");
    expect(await insidersOf(filed.id)).toEqual([ADMIN.id, OTHER_ADMIN.id]);
    let records = await recordsOf(ws, "grant");
    expect(records).toMatchObject([{
      method: "requestContentAccess", requestId: filed.id, admin: ADMIN.id, via: "gatekeeper",
      agent: { workspaceId: ws.id, chatId: 5 },
    }]);
    expect(records[0]).not.toHaveProperty("insiders");
    expect(JSON.stringify(records)).not.toContain(OTHER_ADMIN.id);

    expect(await claim(filed.id, ADMIN)).toBe(secondAdminRequired);
    expect(await claim(filed.id, OTHER_ADMIN)).toBe(secondAdminRequired);
    expect(await claim(filed.id, OUTSIDE_ADMIN)).toBe("claimed");
  }), ADMINS));

  it("keeps its list as it was when filed: a member who leaves stays on it, one who joins is not",
      () => adminWorkspace(ws => withWrites(ws, async () => {
    await share(ws, OTHER_ADMIN);
    let id = await queueAction(ws, 1, "contentAccessRequest", contentRequestOf(ws));
    // The owner approves the filing: the member had no hand in it, and is on the list all the same.
    expect(await approve(ws, id, ADMIN)).toBeUndefined();
    let filed = await filedBy(ws, 1);
    expect(await insidersOf(filed.id)).toEqual([ADMIN.id, OTHER_ADMIN.id]);
    expect(await claim(filed.id, OTHER_ADMIN)).toBe(secondAdminRequired);

    await unshare(ws, OTHER_ADMIN);
    await share(ws, LATE_ADMIN);
    expect(await insidersOf(filed.id)).toEqual([ADMIN.id, OTHER_ADMIN.id]);
    expect(await claim(filed.id, OTHER_ADMIN)).toBe(secondAdminRequired);
    expect(await claim(filed.id, LATE_ADMIN)).toBe("claimed");
  }), ADMINS));

  it("counts everyone the workspace is shared with, an admin or not, and whoever decided once",
      () => adminWorkspace(ws => withWrites(ws, async () => {
    await share(ws, NOT_ADMIN);
    await share(ws, OTHER_ADMIN);
    let id = await queueAction(ws, 1, "contentAccessRequest", contentRequestOf(ws));
    expect(await approve(ws, id, OTHER_ADMIN)).toBeUndefined();
    let first = await filedBy(ws, 1);
    let insiders = await insidersOf(first.id);
    expect(insiders?.toSorted()).toEqual([ADMIN.id, NOT_ADMIN.id, OTHER_ADMIN.id].toSorted());
    expect(insiders?.[0]).toBe(ADMIN.id);
    // A workspace has one pending request at a time: the next is filed once this one is denied.
    await runInDurableObject(env.TEST_ADMIN_SETTINGS.getByName(""), object =>
        object.denyContentAccess(first.id, { admin: OUTSIDE_ADMIN.id, sessionId: "s", via: "api" }));

    // Whoever approved the filing is on the list, in the sharing list or not.
    let next = await queueAction(ws, 2, "contentAccessRequest", contentRequestOf(ws));
    expect(await approve(ws, next, LATE_ADMIN)).toBeUndefined();
    let decided = await filedBy(ws, 2);
    expect(await insidersOf(decided.id)).toContain(LATE_ADMIN.id);
    expect(await claim(decided.id, LATE_ADMIN)).toBe(secondAdminRequired);
    expect(await claim(decided.id, OUTSIDE_ADMIN)).toBe("claimed");
  }), ADMINS));

  it("keeps no list for a request an admin files from a client", () => adminWorkspace(ws =>
      withWrites(ws, async () => {
    await share(ws, OTHER_ADMIN);
    let api = new AdminApiImpl(ws.impl.ctx, ws.env, ADMIN.id, { via: "cli" });
    let filed = await api.requestContentAccess(ws.id, REASON);
    expect(await insidersOf(filed.id)).toBeUndefined();
    expect(await claim(filed.id, ADMIN)).toBe(secondAdminRequired);
    expect(await claim(filed.id, OTHER_ADMIN)).toBe("claimed");
  }), ADMINS));

  // A member who writes code that files a request later, leaves, and approves it from outside
  // would be nobody the request knows. No rule files it: a person present approves the filing,
  // and is on the list.
  it("is never filed by a rule, so a member who left cannot have it filed in their absence",
      () => adminWorkspace(ws => withWrites(ws, async () => {
    await share(ws, OTHER_ADMIN);
    enableRule(ws, "contentAccessRequest", OTHER_ADMIN);
    await unshare(ws, OTHER_ADMIN);

    // The code the member left behind asks for content: its kind waits, whatever the rule.
    let id = await queueAction(ws, 1, "contentAccessRequest", contentRequestOf(ws),
        { claims: { autoApprovable: true } });
    await ws.impl.drainAutoApprovals(ws.gatekeeperId);
    expect(stateOf(ws, id)).toBe("pending");
    expect(await ws.facet.outcomes(1)).toBeUndefined();
    expect(await recordsOf(ws, "grant")).toEqual([]);

    // Only once a person present approves that card is the request filed, with that person on
    // its list: the owner, alone in the workspace by now.
    expect(await approve(ws, id, ADMIN)).toBeUndefined();
    let filed = await filedBy(ws, 1);
    expect((await recordsOf(ws, "grant")).map(record => [record.method, record.requestId]))
        .toEqual([["requestContentAccess", filed.id]]);

    // The member who left is a second person, and may approve the request.
    expect(await insidersOf(filed.id)).toEqual([ADMIN.id]);
    expect(await claim(filed.id, ADMIN)).toBe(secondAdminRequired);
    expect(await claim(filed.id, OTHER_ADMIN)).toBe("claimed");
  }), ADMINS));
});

describe("a spawned chat", () => {
  const GADGET_ID = 100;

  // Spawns a chat through a spawner whose config names `spawnerEnv`, and returns its id.
  async function spawnChat(ws: AdminWorkspace, spawnerEnv: Record<string, number>)
      : Promise<number> {
    let config = { displayName: "Triager", modelId: "m" };
    let client = await ws.impl.addGatekeeper(
        ws.impl.ctx.exports.AgentSpawnerGatekeeper(
            { props: { config, creatorUserId: "owner-user-do" } }),
        { type: "agentSpawner", config }, "owner-user-do", undefined,
        Object.fromEntries(Object.entries(spawnerEnv).map(([name, target]) => [name, { target }])));
    let known = new Set([...ws.impl.storage.chatMeta.list()].map((meta: any) => meta.id));
    using spawner = await client.openSession();
    await spawner.spawn("Triage", "Look into the report.");
    let [spawned] = [...ws.impl.storage.chatMeta.list()].filter((meta: any) => !known.has(meta.id));
    return spawned.id;
  }

  it("holds the admin connection only when its spawner's config names it",
      () => adminWorkspace(async ws => {
    ws.impl.storage.gadgets.put({
      type: "gadget", id: GADGET_ID, title: "Gadget", created: new Date(0), bindingName: "GADGET",
      bindings: {},
    });

    // The workspace has the connection, and the spawner names a gadget alone.
    let without = await spawnChat(ws, { GADGET: GADGET_ID });
    expect(ws.impl.storage.chatContext.get(without).bindings).toEqual({ GADGET: GADGET_ID });

    let named = await spawnChat(ws, { GADGET: GADGET_ID, ADMIN: ws.gatekeeperId });
    expect(ws.impl.storage.chatContext.get(named).bindings)
        .toEqual({ GADGET: GADGET_ID, ADMIN: ws.gatekeeperId });

    // A session of that chat's agent is recorded with the spawned chat's id.
    using session = await ws.session({ from: "agent", chatId: named });
    expect(await session.read(OPEN(ws), { result: "view" })).toEqual({ kept: "view" });
    expect((await ws.records()).map(record => record.agent))
        .toEqual([{ workspaceId: ws.id, chatId: named }]);
  }));
});
