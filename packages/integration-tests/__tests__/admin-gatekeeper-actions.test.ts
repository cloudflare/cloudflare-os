import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ADMIN_AGENT_ACTIONS } from "@gadgets/workshop-shared/admin-agent";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_WRITE_ERROR_CODES, createAdminAccessError,
  OPEN_WORKSPACE_ERROR_CODES, type AdminApi, type Overseer,
} from "@gadgets/workshop-shared/api";
import type { Harness } from "../src/harness.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";
import { waitFor, type ConnectedAccount } from "../src/rpc-client.js";
import {
  addAdminConnection, adminActions, adminApiOf, agentTurn, approveWrite, auditRecords,
  buildGadget, enableEveryRule, enrolPasskey, EVERY_TAG, fileReport, GRACE, HEIDI, isRestricted,
  listed, newMember, newUser, newWorkspace, observationTitles, openAs, opening, OWNER,
  pendingActions, provisionAdminAccount, recordingGadget, reporterThread, requestsFiled,
  scriptedTurn, settle, startAdminHarness, TAGS, turnModels, VENDOR, type AdminConnection,
  type Authenticator, type Suite, type SuiteUser,
} from "./admin-gatekeeper-harness.js";

// The gatekeeper's seven action kinds, what a rule may apply, and what marks a workspace as holding
// restricted data: any read through the whole binding, and what a session limited to one report
// reads of a reporter's workspace that is itself marked.
//
// The issue reports, the audit log and the passkeys are deployment-wide, so this file owns its
// harness and runs serially. Each case that depends on what a workspace has read uses a
// workspace of its own.
const models = turnModels();
// A public site, which is on no list of trusted hosts: every request that reaches it is kept.
const PUBLIC_PAGE = "https://public.example/page";
const webRequests: string[] = [];
const web: Handler = url => {
  if (url.host !== new URL(PUBLIC_PAGE).host) return null;
  webRequests.push(url.href);
  return new Response("A public page", { headers: { "content-type": "text/plain" } });
};
const network = new NetworkInterceptor({ handlers: [models.handler, web] });
const scope = new DisposableStack();
let harness: Harness;
let suite: Suite;
let owner: SuiteUser;
let grace: SuiteUser;
let heidi: SuiteUser;
let admin: RpcStub<AdminApi>;
let graceAdmin: RpcStub<AdminApi>;
let heidiAdmin: RpcStub<AdminApi>;
let ownerAccount: ConnectedAccount;
let graceAccount: ConnectedAccount;
let ownerKey: Authenticator;
let heidiKey: Authenticator;

beforeAll(async () => {
  network.install();
  harness = await startAdminHarness();
  suite = { harness, models, scope };
  owner = await newUser(suite, OWNER);
  grace = await newUser(suite, GRACE);
  heidi = await newUser(suite, HEIDI);
  admin = await adminApiOf(suite, owner);
  await admin.setGatekeeperMode(VENDOR, "optional");
  await admin.setAdminWorkspaceAccess("content");
  ownerAccount = await provisionAdminAccount(owner);
  ownerKey = await enrolPasskey(admin, "owner");
  graceAdmin = await adminApiOf(suite, grace);
  graceAccount = await provisionAdminAccount(grace);
  heidiAdmin = await adminApiOf(suite, heidi);
  heidiKey = await enrolPasskey(heidiAdmin, "heidi");
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

const { secondAdminRequired } = ADMIN_WRITE_ERROR_CODES;
const { grantRequired } = ADMIN_ACCESS_ERROR_CODES;
const { workspaceAccessDenied } = OPEN_WORKSPACE_ERROR_CODES;
const json = JSON.stringify;

type Triage = { ws: RpcStub<Overseer>; id: string; connection: AdminConnection };

/** A workspace of the owner with the admin connection, and a rule for every kind if asked. */
async function triageWorkspace(title: string, options: { rules?: boolean } = {}): Promise<Triage> {
  const { ws, id } = await newWorkspace(suite, owner, title);
  const connection = await addAdminConnection(ws, ownerAccount.id);
  if (options.rules) expect(await enableEveryRule(ws, connection)).toEqual(EVERY_TAG);
  expect(await isRestricted(ws)).toBe(false);
  return { ws, id, connection };
}

/** The thread of a report as admins read it. */
const adminThread = async (reportId: string) => (await admin.getIssueReport(reportId)).entries;

/** The tag of an action's kind. */
const tagOf = (action: { description: { actionKind?: { tag: string } } }) =>
  action.description.actionKind?.tag;

/** Code that calls `call` on the admin binding and records how it ends under `name`. */
const attempt = (name: string, call: string) => `await attempt(${json(name)}, () => ${call});`;
const addEntry = (reportId: string, text: string, visibility: "public" | "admins") =>
  `env.ADMIN.addIssueReportEntry(${json(reportId)}, ${json(text)}, "${visibility}")`;
const scopedReply = (reportId: string, text: string) =>
  `env.ADMIN.openIssueReport(${json(reportId)}).then(report => report.reply(${json(text)}))`;

it("holds a public reply through the binding for a person, whatever the rules", async () => {
  const reporter = await newMember(suite, "asker");
  const report = await fileReport(reporter);
  const { ws, id, connection } = await triageWorkspace("Triage, public reply");
  const text = "Thanks for the report.\n\nWe found the cause and a fix is on its way.";

  const turn = await agentTurn(
      owner, ws, attempt("reply", addEntry(report.id, text, "public")), { connection });
  expect(turn.paused()).toBe(true);
  const [reply] = await pendingActions(ws, 1);
  // The card says what will be posted, whole, and on which report.
  expect(reply).toMatchObject({
    chatId: turn.chatId,
    description: {
      title: `Reply to the reporter of issue report ${report.id}`,
      autoApprovable: false,
      actionKind: ADMIN_AGENT_ACTIONS.issueReportReply.kind,
      fields: [
        { label: "Report", kind: "inline", value: report.id },
        { label: "Reply", kind: "text", value: text },
      ],
    },
  });

  // A rule for every kind, this one included, applies nothing to it.
  expect(await enableEveryRule(ws, connection)).toEqual(EVERY_TAG);
  await settle(ws);
  expect((await pendingActions(ws, 1)).map(action => action.id)).toEqual([reply!.id]);
  expect(turn.paused()).toBe(true);
  expect(await reporterThread(reporter, report.id)).toEqual([]);

  await ws.approveAction(reply!.id);
  expect(await turn.resumed()).toEqual({ reply: { value: null } });
  expect((await adminActions(ws)).map(({ state, autoApproved, resolvedBy }) =>
    ({ state, autoApproved, resolvedBy: resolvedBy?.id })))
      .toEqual([{ state: "approved", autoApproved: false, resolvedBy: OWNER }]);
  // The reporter reads the admin's name and no id; admins read where it came from.
  expect(await reporterThread(reporter, report.id)).toEqual([expect.objectContaining({
    text, visibility: "public", via: "gatekeeper", author: { name: OWNER },
  })]);
  expect(await adminThread(report.id)).toEqual([expect.objectContaining({
    text, via: "gatekeeper", author: { id: OWNER, name: OWNER },
    agent: { workspaceId: id, chatId: turn.chatId },
  })]);
  expect(await isRestricted(ws)).toBe(false);
});

it("applies an admins-only note once its kind has a rule, and shows it to admins alone", async () => {
  const reporter = await newMember(suite, "noted");
  const report = await fileReport(reporter);
  const { ws, id, connection } = await triageWorkspace("Triage, note");

  const turn = await agentTurn(
      owner, ws, attempt("note", addEntry(report.id, "Looks like a quota", "admins")), { connection });
  await settle(ws);
  const [note] = await pendingActions(ws, 1);
  expect(tagOf(note!)).toBe(TAGS.issueReportNote);
  expect(note!.description.autoApprovable).toBe(true);
  expect(await adminThread(report.id)).toEqual([]);

  // The rule applies what was already waiting, with no person.
  await ws.setAutoApprovedActionKind(connection.id, ADMIN_AGENT_ACTIONS.issueReportNote.kind);
  expect(await turn.resumed()).toEqual({ note: { value: null } });
  expect(await adminActions(ws)).toEqual([
    expect.objectContaining({ id: note!.id, state: "approved", autoApproved: true }),
  ]);
  expect(await reporterThread(reporter, report.id)).toEqual([]);
  expect(await adminThread(report.id)).toEqual([expect.objectContaining({
    text: "Looks like a quota", visibility: "admins", via: "gatekeeper",
    agent: { workspaceId: id, chatId: turn.chatId },
  })]);
  expect(await isRestricted(ws)).toBe(false);
});

it("applies a status change by its rule, as a status line written through the gatekeeper", async () => {
  const reporter = await newMember(suite, "statused");
  const report = await fileReport(reporter);
  const { ws, id, connection } = await triageWorkspace("Triage, status");
  await ws.setAutoApprovedActionKind(connection.id, ADMIN_AGENT_ACTIONS.issueReportStatus.kind);

  const turn = await agentTurn(owner, ws, attempt("status",
      `env.ADMIN.setIssueReportStatus(${json(report.id)}, "investigating")`), { connection });
  expect(await turn.resumed()).toEqual({ status: { value: null } });
  expect(await adminActions(ws)).toEqual([expect.objectContaining({
    state: "approved", autoApproved: true,
    description: expect.objectContaining({
      title: `Set issue report ${report.id} to Investigating`,
      actionKind: ADMIN_AGENT_ACTIONS.issueReportStatus.kind,
    }),
  })]);
  expect((await admin.getIssueReport(report.id)).status).toBe("investigating");
  expect(await adminThread(report.id)).toEqual([expect.objectContaining({
    text: "", status: "investigating", via: "gatekeeper",
    agent: { workspaceId: id, chatId: turn.chatId },
  })]);
  expect(await reporterThread(reporter, report.id)).toEqual([expect.objectContaining({
    status: "investigating", via: "gatekeeper", author: { name: OWNER },
  })]);
  expect(await isRestricted(ws)).toBe(false);
});

it("files a write request by its rule, and holds a request for content for a person who " +
    "may then not approve it", async () => {
  const wanted = await newMember(suite, "target");
  const theirs = await newWorkspace(suite, wanted, "Target");
  await listed(admin, wanted.name, theirs.id);
  const { ws, id, connection } = await triageWorkspace("Triage, requests", { rules: true });
  const request = (action: string) => attempt("request", `env.ADMIN.requestWorkspaceWrite(
      ${json(theirs.id)}, "${action}", {}, "The reporter asked us to look")`);

  const restart = await agentTurn(owner, ws, request("restartWorkspace"), { connection });
  expect(await restart.resumed()).toEqual({ request: { value: null } });
  expect(await adminActions(ws)).toEqual([expect.objectContaining({
    state: "approved", autoApproved: true,
    description: expect.objectContaining({ actionKind: ADMIN_AGENT_ACTIONS.workspaceWriteRequest.kind }),
  })]);
  expect(await requestsFiled(admin, theirs.id, id)).toEqual([expect.objectContaining({
    action: "restartWorkspace", state: "pending", requestedBy: OWNER, via: "gatekeeper",
    agent: { workspaceId: id, chatId: restart.chatId },
  })]);

  const content = await agentTurn(owner, ws, request("grantContentAccess"), { chatId: restart.chatId });
  await settle(ws);
  expect(content.paused()).toBe(true);
  const [card] = await pendingActions(ws, 1);
  expect(card).toMatchObject({ description: {
    title: `Ask the admins for access to the content of workspace ${theirs.id}`,
    autoApprovable: false,
    actionKind: ADMIN_AGENT_ACTIONS.contentAccessRequest.kind,
  } });
  // The card says who may not approve the request it files.
  expect(card!.description.description).toContain(
      "Nobody who is in this workspace now, you included once you approve this, can approve " +
      "that request.");
  expect(await requestsFiled(admin, theirs.id, id)).toHaveLength(1);

  await ws.approveAction(card!.id);
  expect(await content.resumed()).toEqual({ request: { value: null } });
  const [, filed] = await requestsFiled(admin, theirs.id, id);
  expect(filed).toMatchObject({ action: "grantContentAccess", state: "pending", requestedBy: OWNER });
  expect(await approveWrite(admin, ownerKey, filed!.id)).toBe(secondAdminRequired);
  expect(await isRestricted(ws)).toBe(false);
});

/** The report's assignee as admins read it. */
const assigneeOf = async (reportId: string) => (await admin.getIssueReport(reportId)).assignee;
/** The ids of the reports `holder` holds, as the admins' list filters them. */
const heldBy = async (holder: string) =>
  (await admin.listIssueReports({ assignee: holder })).reports.map(found => found.id);
/** Each change of the report's assignee as [what it was, whose it is, how it arrived]. */
const assignments = async (reportId: string) => (await adminThread(reportId))
    .flatMap(({ assignment, author, via }) => assignment ? [[assignment, author.id, via]] : []);
const claim = (reportId: string) => `env.ADMIN.claimIssueReport(${json(reportId)})`;
const ASSIGNED = "Another admin holds this issue report.";

it("lets two admins' workspaces claim one report, and exactly one holds it", async () => {
  const report = await fileReport(await newMember(suite, "claimed"));
  const mine = await triageWorkspace("Claims, the owner's");
  const hers = await newWorkspace(suite, grace, "Claims, Grace's");
  const herConnection = await addAdminConnection(hers.ws, graceAccount.id);
  // The owner's workspace watches for changes to reports, as a gadget that lists them would.
  const watching = await recordingGadget(
      suite, owner, mine.ws, mine.connection, ["subscribeIssueReportChanged"]);
  const hooks = await mine.ws.listHooks();
  for (const hook of hooks) await mine.ws.enableHook(hook.id);

  // Each workspace's agent claims the report: two cards, and nobody holds it yet.
  const ownerTurn = await agentTurn(
      owner, mine.ws, attempt("claim", claim(report.id)), { connection: mine.connection });
  const graceTurn = await agentTurn(
      grace, hers.ws, attempt("claim", claim(report.id)), { connection: herConnection });
  const [[ownerCard], [graceCard]] =
      [await pendingActions(mine.ws, 1), await pendingActions(hers.ws, 1)];
  for (const card of [ownerCard, graceCard]) {
    // The card says which report, and for whom: the workspace's owner, whoever approves it.
    expect(card).toMatchObject({ description: {
      title: `Assign issue report ${report.id} to this workspace's owner`,
      autoApprovable: true,
      actionKind: ADMIN_AGENT_ACTIONS.issueReportAssignment.kind,
      fields: [
        { label: "Report", kind: "inline", value: report.id },
        { label: "Assignee", kind: "inline", value: "This workspace's owner" },
      ],
    } });
  }
  expect(await assigneeOf(report.id)).toBeUndefined();

  // The first approved is applied: the report is held by that workspace's owner.
  await hers.ws.approveAction(graceCard!.id);
  expect(await graceTurn.resumed()).toEqual({ claim: { value: null } });
  const held = {
    id: GRACE, name: GRACE, at: expect.any(Date), via: "gatekeeper",
    agent: { workspaceId: hers.id, chatId: graceTurn.chatId },
  };
  expect(await assigneeOf(report.id)).toEqual(held);

  // The second is refused, and its card stays for a person to decide: nothing changed.
  await expect(mine.ws.approveAction(ownerCard!.id)).rejects.toThrow(ASSIGNED);
  expect(await assigneeOf(report.id)).toEqual(held);
  expect(await assignments(report.id)).toEqual([["claimed", GRACE, "gatekeeper"]]);
  expect(await decisions(mine.ws)).toEqual([[TAGS.issueReportAssignment, "pending", false]]);

  // The owner's workspace learns of it from the hook, which says that the report's assignee
  // changed and never whose it is, and from a read: the holder is not the admin it acts as.
  // The turn that lost still waits on its card, so the read is another chat's.
  const assignment = { kind: "issueReportChanged", event: {
    eventId: expect.any(String), reportId: report.id, change: "assignment", at: expect.any(Date),
  } };
  const told = (count: number) => waitFor(`${count} call(s) of the hook for the report`, async () => {
    const calls = (await watching.calls()).filter(call => call.event.reportId === report.id);
    return calls.length >= count ? calls : null;
  });
  expect(await told(1)).toEqual([assignment]);
  const ids = attempt("ids", `Promise.all([
      env.ADMIN.getIssueReport(${json(report.id)}), env.ADMIN.whoami(),
    ]).then(([report, me]) => ({ assignee: report.assignee.id, me: me.id }))`);
  const ownerRead = await agentTurn(owner, mine.ws, ids, { connection: mine.connection });
  expect(await ownerRead.results()).toEqual({ ids: { value: { assignee: GRACE, me: OWNER } } });
  const graceRead = await agentTurn(grace, hers.ws, ids, { chatId: graceTurn.chatId });
  expect(await graceRead.results()).toEqual({ ids: { value: { assignee: GRACE, me: GRACE } } });
  // The claim that was refused changed nothing, so the hook was called for the one alone.
  expect(await told(1)).toEqual([assignment]);

  // It failed for good: once Grace has released the report, approving the card again is
  // refused the same way and takes nothing, and all that is left is to discard it.
  await graceAdmin.releaseIssueReport(report.id);
  expect(await assigneeOf(report.id)).toBeUndefined();
  await expect(mine.ws.approveAction(ownerCard!.id)).rejects.toThrow(ASSIGNED);
  expect(ownerTurn.paused()).toBe(true);
  await mine.ws.rejectAction(ownerCard!.id);
  expect(await decisions(mine.ws)).toEqual([[TAGS.issueReportAssignment, "rejected", false]]);
  expect(await assigneeOf(report.id)).toBeUndefined();
  expect(await assignments(report.id))
      .toEqual([["claimed", GRACE, "gatekeeper"], ["released", GRACE, "api"]]);
  // The hook was called for the release as well, and for nothing else.
  expect(await told(2)).toEqual([assignment, assignment]);

  // The gadget has no part in the rest of the file's reports.
  for (const hook of hooks) await mine.ws.disableHook(hook.id);
});

it("holds what a rule would apply behind a claim that lost, until a person rejects it", async () => {
  const reporter = await newMember(suite, "lost");
  const [held, free] = [await fileReport(reporter), await fileReport(reporter)];
  await graceAdmin.claimIssueReport(held.id);
  const { ws, connection } = await triageWorkspace("Claims, one lost under a rule", { rules: true });

  // Each call has a rule, so nothing pauses the turn; the first is refused where it lands.
  const turn = await agentTurn(owner, ws, `
    ${attempt("lost", claim(held.id))}
    ${attempt("note", addEntry(free.id, "A note", "admins"))}
    ${attempt("claim", claim(free.id))}`, { connection });
  expect(await turn.results())
      .toEqual({ lost: { value: null }, note: { value: null }, claim: { value: null } });
  expect(turn.paused()).toBe(false);

  // The refused claim stays pending, and no rule applies the note or the claim behind it.
  await settle(ws);
  const [lost] = await pendingActions(ws, 3);
  expect(await decisions(ws)).toEqual([
    [TAGS.issueReportAssignment, "pending", false], [TAGS.issueReportNote, "pending", false],
    [TAGS.issueReportAssignment, "pending", false],
  ]);
  expect(await assigneeOf(free.id)).toBeUndefined();
  expect(await adminThread(free.id)).toEqual([]);

  // A person's approval only repeats the refusal, and still nothing behind it is applied.
  await expect(ws.approveAction(lost!.id)).rejects.toThrow(ASSIGNED);
  await settle(ws);
  await pendingActions(ws, 3);

  // Rejecting it is what lets the rest through, by rule.
  await ws.rejectAction(lost!.id);
  await pendingActions(ws, 0);
  expect(await decisions(ws)).toEqual([
    [TAGS.issueReportAssignment, "rejected", false], [TAGS.issueReportNote, "approved", true],
    [TAGS.issueReportAssignment, "approved", true],
  ]);
  expect(await assigneeOf(free.id)).toMatchObject({ id: OWNER, via: "gatekeeper" });
  expect((await adminThread(free.id)).flatMap(({ text, visibility, assignment }) =>
    assignment ? [] : [[text, visibility]])).toEqual([["A note", "admins"]]);
  expect(await assigneeOf(held.id)).toMatchObject({ id: GRACE, via: "api" });
});

it("never lets an agent take a report from a person", async () => {
  const report = await fileReport(await newMember(suite, "kept"));
  await graceAdmin.claimIssueReport(report.id);
  const hers = { id: GRACE, name: GRACE, at: expect.any(Date), via: "api" };
  expect(await assigneeOf(report.id)).toEqual(hers);
  const { ws, connection } = await triageWorkspace("Claims, a take-over");

  // The gatekeeper refuses the call itself, so no card exists for a person to approve.
  const turn = await agentTurn(owner, ws, attempt("takeOver",
      `env.ADMIN.claimIssueReport(${json(report.id)}, { takeOverFrom: ${json(GRACE)} })`),
      { connection });
  expect(await turn.results()).toEqual({
    takeOver: { error: expect.stringContaining("Only a person takes an issue report") },
  });
  expect(turn.paused()).toBe(false);
  expect(await adminActions(ws)).toEqual([]);
  expect(await assigneeOf(report.id)).toEqual(hers);

  // A person's plain claim is refused as well, and so is their take-over from an admin who
  // does not hold the report; their take-over from its holder, through their own Admin API, is
  // what takes it.
  await expect(admin.claimIssueReport(report.id)).rejects.toThrow(ASSIGNED);
  await expect(admin.claimIssueReport(report.id, { takeOverFrom: HEIDI })).rejects.toThrow(ASSIGNED);
  await admin.claimIssueReport(report.id, { takeOverFrom: GRACE });
  expect(await assigneeOf(report.id))
      .toEqual({ id: OWNER, name: OWNER, at: expect.any(Date), via: "api" });
  expect(await assignments(report.id))
      .toEqual([["claimed", GRACE, "api"], ["takenOver", OWNER, "api"]]);
  expect(await isRestricted(ws)).toBe(false);
});

it("assigns the workspace's owner, whoever in the workspace asked", async () => {
  const report = await fileReport(await newMember(suite, "asked"));
  const { ws, id, connection } = await triageWorkspace("Claims, a member asks");
  expect(await ws.addCollaborator(GRACE, "workspace")).not.toBeNull();
  using graceWs = await openAs(suite, grace, id, { accountId: graceAccount.id });
  const decide = async () => {
    const [card] = await pendingActions(ws, 1);
    await graceWs.approveAction(card!.id);
    return card!.description.title;
  };

  // Grace's agent asks, and Grace approves: the call is the owner's, as every call lent to
  // this connection is, so the owner holds the report and Grace holds nothing.
  const turn = await agentTurn(grace, graceWs, attempt("claim", claim(report.id)), { connection });
  expect(await decide()).toBe(`Assign issue report ${report.id} to this workspace's owner`);
  expect(await turn.resumed()).toEqual({ claim: { value: null } });
  expect(await assigneeOf(report.id)).toEqual({
    id: OWNER, name: OWNER, at: expect.any(Date), via: "gatekeeper",
    agent: { workspaceId: id, chatId: turn.chatId },
  });
  expect(await heldBy(OWNER)).toContain(report.id);
  expect(await heldBy(GRACE)).not.toContain(report.id);

  // A release is the same kind, and the owner's call as well.
  const release = await agentTurn(grace, graceWs, attempt("release",
      `env.ADMIN.releaseIssueReport(${json(report.id)})`), { chatId: turn.chatId });
  expect(await decide()).toBe(`Release issue report ${report.id} from this workspace's owner`);
  expect(await release.resumed()).toEqual({ release: { value: null } });
  expect(await assigneeOf(report.id)).toBeUndefined();
  expect(await assignments(report.id))
      .toEqual([["claimed", OWNER, "gatekeeper"], ["released", OWNER, "gatekeeper"]]);
  expect((await adminActions(ws)).map(action =>
    [tagOf(action), action.state, action.resolvedBy?.id])).toEqual([
    [TAGS.issueReportAssignment, "approved", GRACE], [TAGS.issueReportAssignment, "approved", GRACE],
  ]);
});

it("applies nothing ahead of an action that waits for a person", async () => {
  const reporter = await newMember(suite, "ordered");
  const report = await fileReport(reporter);
  const { ws, connection } = await triageWorkspace("Triage, in order", { rules: true });

  const first = await agentTurn(
      owner, ws, attempt("reply", addEntry(report.id, "A public reply", "public")), { connection });
  await pendingActions(ws, 1);
  // Queued behind it from another chat: each has a rule, and neither is applied before it.
  const second = await agentTurn(owner, ws, `
    ${attempt("note", addEntry(report.id, "A note", "admins"))}
    ${attempt("scoped", scopedReply(report.id, "A scoped reply"))}`, { connection });
  await settle(ws);
  const pending = await pendingActions(ws, 3);
  expect(pending.map(tagOf))
      .toEqual([TAGS.issueReportReply, TAGS.issueReportNote, TAGS.issueReportScopedReply]);
  expect(second.paused()).toBe(true);
  expect(await adminThread(report.id)).toEqual([]);

  await ws.approveAction(pending[0]!.id);
  expect(await first.resumed()).toEqual({ reply: { value: null } });
  expect(await second.resumed()).toEqual({ note: { value: null }, scoped: { value: null } });
  expect((await adminActions(ws)).map(action => [tagOf(action), action.state, action.autoApproved]))
      .toEqual([
        [TAGS.issueReportReply, "approved", false],
        [TAGS.issueReportNote, "approved", true],
        [TAGS.issueReportScopedReply, "approved", true],
      ]);
  expect((await adminThread(report.id)).map(({ text, visibility }) => [text, visibility])).toEqual([
    ["A public reply", "public"], ["A note", "admins"], ["A scoped reply", "public"],
  ]);
  expect(await isRestricted(ws)).toBe(false);
});

/** Each admin action of the workspace as [tag, state, whether a rule applied it]. */
const decisions = async (ws: RpcStub<Overseer>) =>
  (await adminActions(ws)).map(action => [tagOf(action), action.state, action.autoApproved === true]);

it("marks the workspace at any read through the binding, after which no rule applies anything",
    async () => {
  const reporter = await newMember(suite, "marked");
  const report = await fileReport(reporter);
  const wanted = await newWorkspace(suite, reporter, "Marked target");
  await listed(admin, reporter.name, wanted.id);
  const { ws, id, connection } = await triageWorkspace("Triage, read first", { rules: true });

  const turn = await agentTurn(owner, ws, `
    ${attempt("reports", "env.ADMIN.listIssueReports().then(page => page.reports.length > 0)")}
    ${attempt("note", addEntry(report.id, "A note", "admins"))}
    ${attempt("status", `env.ADMIN.setIssueReportStatus(${json(report.id)}, "investigating")`)}
    ${attempt("claim", claim(report.id))}
    ${attempt("request", `env.ADMIN.requestWorkspaceWrite(
        ${json(wanted.id)}, "restartWorkspace", {}, "Stuck after the report")`)}
    ${attempt("scoped", scopedReply(report.id, "A scoped reply"))}`, { connection });
  expect(await turn.results()).toEqual({
    reports: { value: true }, note: { value: null }, status: { value: null },
    claim: { value: null }, request: { value: null }, scoped: { value: null },
  });
  expect(await isRestricted(ws)).toBe(true);

  // Every one of the five has a rule, and each waits for a person.
  await settle(ws);
  const pending = await pendingActions(ws, 5);
  expect(pending.map(tagOf)).toEqual([
    TAGS.issueReportNote, TAGS.issueReportStatus, TAGS.issueReportAssignment,
    TAGS.workspaceWriteRequest, TAGS.issueReportScopedReply,
  ]);
  expect(turn.paused()).toBe(true);
  expect(await adminThread(report.id)).toEqual([]);
  expect(await assigneeOf(report.id)).toBeUndefined();
  expect(await requestsFiled(admin, wanted.id, id)).toEqual([]);

  for (const action of pending) await ws.approveAction(action.id);
  await turn.resumed();
  expect(await decisions(ws)).toEqual(pending.map(action => [tagOf(action), "approved", false]));
  expect((await adminThread(report.id)).map(({ text, visibility, status, assignment }) =>
    [text, visibility, status ?? assignment])).toEqual([
    ["A note", "admins", undefined], ["", "public", "investigating"], ["", "admins", "claimed"],
    ["A scoped reply", "public", undefined],
  ]);
  expect(await assigneeOf(report.id)).toMatchObject({ id: OWNER, via: "gatekeeper" });
  expect(await requestsFiled(admin, wanted.id, id)).toHaveLength(1);
});

it("holds a scoped reply for a person in a workspace whose agent read the report through " +
    "the whole binding", async () => {
  const reporter = await newMember(suite, "readfirst");
  const report = await fileReport(reporter);
  const { ws, connection } = await triageWorkspace("Triage, read then reply", { rules: true });

  const turn = await agentTurn(owner, ws, `
    ${attempt("report", `env.ADMIN.getIssueReport(${json(report.id)}).then(report => report.id)`)}
    ${attempt("scoped", scopedReply(report.id, "Written after reading as an admin"))}`,
      { connection });
  expect(await turn.results()).toEqual({ report: { value: report.id }, scoped: { value: null } });
  await settle(ws);
  const [held] = await pendingActions(ws, 1);
  expect(tagOf(held!)).toBe(TAGS.issueReportScopedReply);
  expect(await reporterThread(reporter, report.id)).toEqual([]);

  await ws.approveAction(held!.id);
  await turn.resumed();
  expect(await decisions(ws)).toEqual([[TAGS.issueReportScopedReply, "approved", false]]);
  expect((await reporterThread(reporter, report.id)).map(entry => entry.text))
      .toEqual(["Written after reading as an admin"]);
});

it("holds a scoped reply whose session was opened, or which was drafted, before the first read",
    async () => {
  const reporter = await newMember(suite, "raced");
  const [opened, drafted] = [await fileReport(reporter), await fileReport(reporter)];

  // The session is opened first, the binding read next, the reply sent last.
  const early = await triageWorkspace("Triage, session first", { rules: true });
  const turn = await agentTurn(owner, early.ws, `
    const report = await env.ADMIN.openIssueReport(${json(opened.id)});
    ${attempt("users", "env.ADMIN.listUsers({ limit: 1 }).then(page => page.users.length)")}
    ${attempt("scoped", `report.reply("Sent after the read")`)}`, { connection: early.connection });
  expect(await turn.results()).toEqual({ users: { value: 1 }, scoped: { value: null } });
  await settle(early.ws);
  expect((await pendingActions(early.ws, 1)).map(tagOf)).toEqual([TAGS.issueReportScopedReply]);
  expect(await reporterThread(reporter, opened.id)).toEqual([]);

  // The reply is drafted behind an action that waits for a person, the binding is read in a
  // later turn, and the action in front is then approved: the draft still waits.
  const late = await triageWorkspace("Triage, draft first", { rules: true });
  const front = await agentTurn(owner, late.ws,
      attempt("reply", addEntry(drafted.id, "A public reply", "public")), { connection: late.connection });
  const draft = await agentTurn(owner, late.ws,
      attempt("scoped", scopedReply(drafted.id, "Drafted before the read")),
      { connection: late.connection });
  const [reply, scoped] = await pendingActions(late.ws, 2);
  expect([reply, scoped].map(action => tagOf(action!)))
      .toEqual([TAGS.issueReportReply, TAGS.issueReportScopedReply]);
  expect(await isRestricted(late.ws)).toBe(false);
  const reading = await agentTurn(owner, late.ws,
      attempt("users", "env.ADMIN.listUsers({ limit: 1 }).then(page => page.users.length)"),
      { connection: late.connection });
  expect(await reading.results()).toEqual({ users: { value: 1 } });
  expect(await isRestricted(late.ws)).toBe(true);

  await late.ws.approveAction(reply!.id);
  await front.resumed();
  await settle(late.ws);
  expect((await pendingActions(late.ws, 1)).map(action => action.id)).toEqual([scoped!.id]);
  expect(draft.paused()).toBe(true);
  expect((await reporterThread(reporter, drafted.id)).map(entry => entry.text))
      .toEqual(["A public reply"]);
});

/** A triage workspace whose one rule is for a reply from a session limited to one report. */
async function scopedOnly(title: string): Promise<Triage> {
  const triage = await triageWorkspace(title);
  await triage.ws.setAutoApprovedActionKind(
      triage.connection.id, ADMIN_AGENT_ACTIONS.issueReportScopedReply.kind);
  return triage;
}

/** A gadget whose one method answers a report through a session limited to it. */
const REPLYING_GADGET = `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async answer(reportId, text) {
    const report = await this.env.ADMIN.openIssueReport(reportId);
    await report.reply(text);
    return "queued";
  }
}`;

it("lets a scoped reply reach the reporter with no person, from a workspace that has read " +
    "nothing through the binding", async () => {
  const reporter = await newMember(suite, "answered");
  const [byGadget, byAgent] = [await fileReport(reporter), await fileReport(reporter)];
  const posted = (reportId: string) => waitFor("the reply in the reporter's thread", async () => {
    const entries = await reporterThread(reporter, reportId);
    return entries.length > 0 ? entries : null;
  });

  // Merged gadget code: no chat, and no person.
  const desk = await scopedOnly("Triage, a gadget answers");
  const { gadget } = await buildGadget(owner, desk.ws,
      { name: "REPLIER", server: REPLYING_GADGET, bindings: { ADMIN: desk.connection.id } });
  using facet = await gadget.connectToGadget() as RpcStub<{ answer(id: string, text: string): string }>;
  expect(await facet.answer(byGadget.id, "Answered by the gadget")).toBe("queued");
  expect(await posted(byGadget.id)).toEqual([expect.objectContaining({
    text: "Answered by the gadget", visibility: "public", via: "gatekeeper", author: { name: OWNER },
  })]);
  expect(await decisions(desk.ws)).toEqual([[TAGS.issueReportScopedReply, "approved", true]]);
  expect((await adminThread(byGadget.id))[0]!.agent).toEqual({ workspaceId: desk.id });
  expect(await isRestricted(desk.ws)).toBe(false);

  // An agent's own turn, likewise: it read only what the reporter could see. Pinned, so that
  // a change of this rule is deliberate.
  const chat = await scopedOnly("Triage, an agent answers");
  const turn = await agentTurn(owner, chat.ws, `
    const report = await env.ADMIN.openIssueReport(${json(byAgent.id)});
    ${attempt("text", "report.get().then(report => report.text)")}
    ${attempt("scoped", `report.reply("Answered by the agent")`)}`, { connection: chat.connection });
  expect(await turn.resumed()).toEqual({ text: { value: byAgent.text }, scoped: { value: null } });
  expect((await posted(byAgent.id)).map(entry => entry.text)).toEqual(["Answered by the agent"]);
  expect(await decisions(chat.ws)).toEqual([[TAGS.issueReportScopedReply, "approved", true]]);
  expect((await adminThread(byAgent.id))[0]!.agent)
      .toEqual({ workspaceId: chat.id, chatId: turn.chatId });
  expect(await isRestricted(chat.ws)).toBe(false);
});

const REPORT_NOT_OWNERS = "This report's workspace is not its reporter's.";

/** A member with a workspace of their own that holds one chat, and reports that name it. */
async function reporterWithWorkspace(prefix: string, reports = 1) {
  const reporter = await newMember(suite, prefix);
  const { ws, id } = await newWorkspace(suite, reporter, `Workspace of ${reporter.name}`);
  const chatId = await ws.newChat("hello", null);
  await listed(admin, reporter.name, id);
  const filed = [];
  for (let i = 0; i < reports; i++) {
    filed.push(await fileReport(reporter, { context: { workspaceId: id } }));
  }
  return { reporter, ws, id, chatId, reports: filed };
}

/** A grant the admins gave themselves on `workspaceId`: grace asked, heidi approved. */
async function adminsGrant(workspaceId: string, reason: string) {
  const request = await graceAdmin.requestWorkspaceWrite(workspaceId, "grantContentAccess", {}, reason);
  expect(await approveWrite(heidiAdmin, heidiKey, request.id)).toMatchObject({ resolvedBy: HEIDI });
  using view = await admin.inspectWorkspace(workspaceId, "Reading the admins' grant");
  return await waitFor("the admins' grant", async () =>
    (await view.describe()).grants.find(grant => grant.requestId === request.id) ?? null);
}

/** Code that opens a session limited to `reportId` as `report`, then runs `body`. */
const inSession = (reportId: string, body: string) =>
  `const report = await env.ADMIN.openIssueReport(${json(reportId)});\n${body}`;
/** Code that reads chat `chatId` through the session's view of the reporter's workspace. */
const readChat = (chatId: number) => attempt("chat", `report.inspectWorkspace("triage")
    .then(view => view.getChat(${chatId})).then(chat => chat.messages.length)`);
const REFUSED_FOR_GRANT = { chat: { error: createAdminAccessError(grantRequired).message } };

it("limits a report session to its one report, as its reporter reads it", async () => {
  const { reporter, reports: [report] } = await reporterWithWorkspace("scoped");
  const other = await fileReport(await newMember(suite, "elsewhere"));
  await admin.addIssueReportEntry(report!.id, "Only for admins: a quota", "admins");
  await admin.addIssueReportEntry(report!.id, "We are on it", "public");
  await admin.setIssueReportLinks(report!.id, ["https://tracker.example/issue/7"]);
  await reporter.api.replyToIssueReport(report!.id, "Thank you");
  const { ws, connection } = await triageWorkspace("Triage, one report");

  const refused = [
    ["listIssueReports", "report.listIssueReports()"],
    ["getIssueReport", `report.getIssueReport(${json(other.id)})`],
    ["openIssueReport", `report.openIssueReport(${json(other.id)})`],
    ["addIssueReportEntry", `report.addIssueReportEntry(${json(report!.id)}, "A note", "admins")`],
    ["setIssueReportStatus", `report.setIssueReportStatus(${json(report!.id)}, "closed")`],
    ["listUsers", "report.listUsers()"],
    ["listAdminAudit", "report.listAdminAudit()"],
    ["getSettings", "report.getSettings()"],
    ["requestWorkspaceWrite",
      `report.requestWorkspaceWrite(${json(report!.context.workspaceId)}, "restartWorkspace", {}, "x")`],
  ] as const;
  const turn = await agentTurn(owner, ws, inSession(report!.id, `
    ${attempt("get", "report.get()")}
    ${refused.map(([name, call]) => attempt(name, call)).join("\n")}`), { connection });
  const { get, ...rest } = await turn.results();
  for (const [name] of refused) expect(rest[name], name).toEqual({ error: expect.any(String) });
  expect(Object.keys(rest)).toEqual(refused.map(([name]) => name));

  expect(get!.value).toMatchObject({
    id: report!.id, text: report!.text, reporter: { id: reporter.name },
    entries: [
      { text: "We are on it", visibility: "public", author: { name: OWNER } },
      { text: "Thank you", visibility: "public", author: { id: reporter.name } },
    ],
  });
  const serialized = json(get!.value);
  for (const hidden of ["Only for admins", "tracker.example", "links", "agent", `"id":"${OWNER}"`]) {
    expect(serialized, hidden).not.toContain(hidden);
  }
  expect(await pendingActions(ws, 0)).toEqual([]);
  expect((await admin.getIssueReport(report!.id)).status).toBe("new");
  // What it read is what the reporter could see: the workspace is not marked.
  expect(await observationTitles(ws)).toEqual(["Issue report: get"]);
  expect(await isRestricted(ws)).toBe(false);
});

it("shows a session limited to one report what its reporter reads", async () => {
  const reporter = await newMember(suite, "fixed");
  const report = await fileReport(reporter);
  // With the admins, then on to a status the reporter reads as the same, and held.
  await admin.setIssueReportStatus(report.id, "withAdmin");
  await admin.setIssueReportStatus(report.id, "fixSuggested");
  await admin.claimIssueReport(report.id);
  expect(await admin.getIssueReport(report.id))
      .toMatchObject({ status: "fixSuggested", assignee: { id: OWNER } });
  expect((await adminThread(report.id)).map(({ visibility, status, assignment }) =>
    [visibility, status ?? assignment])).toEqual([
    ["public", "withAdmin"], ["admins", "fixSuggested"], ["admins", "claimed"],
  ]);
  const { ws, connection } = await triageWorkspace("Triage, a fix suggested");

  const turn = await agentTurn(
      owner, ws, inSession(report.id, attempt("get", "report.get()")), { connection });
  const { get } = await turn.results();
  // Neither the admins' status, nor the holder, nor a line only admins read.
  expect(get!.value).toMatchObject({
    id: report.id, status: "withAdmin",
    entries: [{ text: "", visibility: "public", status: "withAdmin", author: { name: OWNER } }],
  });
  const own = await reporter.api.getIssueReport(report.id);
  expect(own.status).toBe("withAdmin");
  expect((await reporterThread(reporter, report.id)).map(({ visibility, status }) =>
    [visibility, status])).toEqual([["public", "withAdmin"]]);
  for (const read of [get!.value, own]) {
    for (const hidden of ["fixSuggested", "assignee", "assignment", "claimed"]) {
      expect(json(read), hidden).not.toContain(hidden);
    }
  }
  expect(await isRestricted(ws)).toBe(false);
});

it("reads a reporter's content through a report session only under the grant given with " +
    "that report, or the reporter's account-wide grant", async () => {
  const { ws, id, connection } = await triageWorkspace("Triage, the reporter's grant");
  let chatId: number | undefined;
  /** One turn that reads the chat of the report's workspace through a session limited to it. */
  const read = async (reportId: string, chat: number) => {
    const turn = await agentTurn(owner, ws, inSession(reportId, readChat(chat)),
        chatId === undefined ? { connection } : { chatId });
    chatId = turn.chatId;
    return await turn.results();
  };
  const chatReads = async (workspace: string) =>
    (await auditRecords(admin, { workspace, method: "getChat" })).map(record =>
      record.kind === "workspace" ? [record.exposed, record.grantId ?? record.refused] : []);

  // No grant: a view, and no content. Then the grant given with the report.
  const plain = await reporterWithWorkspace("plain");
  expect(await read(plain.reports[0]!.id, plain.chatId)).toEqual(REFUSED_FOR_GRANT);
  const given = await plain.ws.grantAdminAccess({ reportId: plain.reports[0]!.id });
  expect(await read(plain.reports[0]!.id, plain.chatId)).toEqual({ chat: { value: 1 } });
  expect(await chatReads(plain.id)).toEqual([["content", given.id], ["metadata", grantRequired]]);
  expect((await auditRecords(admin, { workspace: plain.id }))[0]).toMatchObject({
    admin: OWNER, via: "gatekeeper", agent: { workspaceId: id, chatId },
  });

  // The reporter's account-wide grant, and none given with the report.
  const wide = await reporterWithWorkspace("wide");
  const account = await wide.reporter.api.grantAccountAdminAccess();
  expect(await read(wide.reports[0]!.id, wide.chatId)).toEqual({ chat: { value: 1 } });
  expect(await chatReads(wide.id)).toEqual([["content", account.id]]);

  // Only the admins' own grant: not this session's to use, though the whole binding reads
  // under it. Then the reporter's too: read, and recorded, under the reporter's.
  const both = await reporterWithWorkspace("both");
  const admins = await adminsGrant(both.id, "Asked for by the desk");
  expect(await read(both.reports[0]!.id, both.chatId)).toEqual(REFUSED_FOR_GRANT);
  const whole = await triageWorkspace("Triage, the admins' grant");
  const direct = await agentTurn(owner, whole.ws, attempt("chat", `env.ADMIN.inspectWorkspace(
      ${json(both.id)}, "Reading under the admins' grant", { access: "content" })
      .then(view => view.getChat(${both.chatId})).then(chat => chat.messages.length)`),
      { connection: whole.connection });
  expect(await direct.results()).toEqual({ chat: { value: 1 } });
  const theirs = await both.ws.grantAdminAccess({ reportId: both.reports[0]!.id });
  expect(await read(both.reports[0]!.id, both.chatId)).toEqual({ chat: { value: 1 } });
  expect(await chatReads(both.id)).toEqual(
      [["content", theirs.id], ["content", admins.id], ["metadata", grantRequired]]);

  // A grant given with another report about the same workspace is not this report's.
  const twice = await reporterWithWorkspace("twice", 2);
  await twice.ws.grantAdminAccess({ reportId: twice.reports[1]!.id });
  expect(await read(twice.reports[0]!.id, twice.chatId)).toEqual(REFUSED_FOR_GRANT);
  expect(await read(twice.reports[1]!.id, twice.chatId)).toEqual({ chat: { value: 1 } });

  // None of it marks the workspace that read: each answer is what the reporter could see.
  expect(await isRestricted(ws)).toBe(false);
});

it("lists in a report session's view the grant given with its report, and no other", async () => {
  const { ws: theirs, id: workspaceId, reports: [report, other] } =
      await reporterWithWorkspace("listed", 2);
  const reason = "Opened by the desk for the outage";
  const admins = await adminsGrant(workspaceId, reason);
  const others = await theirs.grantAdminAccess({ reportId: other!.id });
  const own = await theirs.grantAdminAccess({ reportId: report!.id });
  const { ws, connection } = await triageWorkspace("Triage, the grants a view lists");
  const describe = attempt("description",
      `report.inspectWorkspace("triage").then(view => view.describe())`);

  const turn = await agentTurn(owner, ws, inSession(report!.id, describe), { connection });
  const { description } = await turn.results();
  expect(description!.value).toMatchObject({ id: workspaceId, grants: [{ id: own.id }] });
  const serialized = json(description!.value);
  for (const hidden of [admins.id, others.id, reason, GRACE, HEIDI]) {
    expect(serialized, hidden).not.toContain(hidden);
  }

  await theirs.revokeAdminAccess(own.id);
  const ended = await agentTurn(owner, ws, inSession(report!.id, describe), { chatId: turn.chatId });
  expect((await ended.results()).description!.value).toMatchObject({ grants: [] });
  expect(await isRestricted(ws)).toBe(false);

  // The contrast: a view opened through the whole binding lists the admins' grant.
  const whole = await triageWorkspace("Triage, every grant");
  const all = await agentTurn(owner, whole.ws, attempt("grants", `env.ADMIN.inspectWorkspace(
      ${json(workspaceId)}, "Reading the grants").then(view => view.describe())
      .then(description => description.grants.map(grant => grant.id))`),
      { connection: whole.connection });
  expect((await all.results()).grants!.value).toEqual(expect.arrayContaining([admins.id, others.id]));
});

it("opens no view for a report that names a workspace its reporter does not own", async () => {
  const host = await newMember(suite, "host");
  const guest = await newMember(suite, "guest");
  const shared = await newWorkspace(suite, host, "Shared with a guest");
  expect(await shared.ws.addCollaborator(guest.name, "workspace")).not.toBeNull();
  const report = await fileReport(guest, { context: { workspaceId: shared.id } });
  const { ws, connection } = await triageWorkspace("Triage, a guest's report");

  const turn = await agentTurn(owner, ws, inSession(report.id, `
    ${attempt("view", `report.inspectWorkspace("triage")`)}
    ${attempt("get", "report.get().then(report => report.id)")}`), { connection });
  expect(await turn.results()).toEqual(
      { view: { error: REPORT_NOT_OWNERS }, get: { value: report.id } });
  // The workspace was neither opened nor described.
  expect(await auditRecords(admin, { workspace: shared.id })).toEqual([]);
});

it("opens a metadata view from a report session where the deployment reads metadata alone, " +
    "with no refused record", async () => {
  const { id: workspaceId, chatId, reports: [report] } = await reporterWithWorkspace("metadata");
  const { ws, connection } = await triageWorkspace("Triage, metadata only");
  await admin.setAdminWorkspaceAccess("metadata");
  try {
    const turn = await agentTurn(owner, ws, inSession(report!.id, `
      const view = await report.inspectWorkspace("triage");
      ${attempt("access", "view.describe().then(description => description.access)")}
      ${attempt("chats", "view.listChats().then(chats => chats.map(chat => chat.id))")}`),
        { connection });
    expect(await turn.results()).toEqual({ access: { value: "metadata" }, chats: { value: [chatId] } });
  } finally {
    await admin.setAdminWorkspaceAccess("content");
  }
  const records = await auditRecords(admin, { workspace: workspaceId });
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) {
    expect(record).toMatchObject({ kind: "workspace", requested: "metadata", exposed: "metadata" });
    expect(record.kind === "workspace" && record.refused).toBeUndefined();
  }
});

/** The observations of the workspace as [title, whether it is flagged as restricted data]. */
const observations = async (ws: RpcStub<Overseer>) =>
  (await ws.listActions({ filter: "observation" })).entries.toReversed().map(entry =>
    [entry.description.title, entry.type === "observation" &&
        entry.description.containsRestrictedData === true]);

/** One turn that fetches the public page: what the agent was told, once the turn has ended. */
async function fetchPublicPage(ws: RpcStub<Overseer>, chatId: number): Promise<string> {
  const { script } = await scriptedTurn(owner, ws, [
    { toolCall: { id: "fetch-public", name: "webFetch", arguments: { url: PUBLIC_PAGE } } },
    { text: "Done." },
  ], { chatId });
  await waitFor("the fetch turn to end", async () => script.done() || null);
  return json(script.requests[1]);
}

const WEB_FETCH_PROHIBITED = "This workspace has observed sensitive data. To prevent leaks, the " +
    "workspace is prohibited from fetching from public web sites.";

/** A triage workspace with every rule on, shared with `member` before it has the connection. */
async function sharedTriage(title: string, member: SuiteUser): Promise<Triage> {
  const { ws, id } = await newWorkspace(suite, owner, title);
  expect(await ws.addCollaborator(member.name, "workspace")).not.toBeNull();
  expect(await opening(suite, member, id)).toBe("opened");
  const connection = await addAdminConnection(ws, ownerAccount.id);
  expect(await enableEveryRule(ws, connection)).toEqual(EVERY_TAG);
  return { ws, id, connection };
}

/** The view of the report's workspace, as `view`, then `body`. */
const inView = (reportId: string, body: string) => inSession(reportId,
    `const view = await report.inspectWorkspace("triage");\n${body}`);
const listChats = attempt("chats", "view.listChats().then(chats => chats.length)");
const getChat = (chatId: number) =>
  attempt("chat", `view.getChat(${chatId}).then(chat => chat.messages.length > 0)`);

// A workspace of heidi's that holds restricted data, its chat, and her two reports that name it:
// the first with a grant. Made by the first of the three cases below.
let restricted: { id: string; chatId: number; granted: string; plain: string };

it("carries the mark of a reporter's restricted workspace into the workspace whose report " +
    "session reads it, from the view's first answer", async () => {
  const hers = await newWorkspace(suite, heidi, "Heidi's own triage");
  const herConnection = await addAdminConnection(
      hers.ws, (await provisionAdminAccount(heidi)).id);
  const marking = await agentTurn(heidi, hers.ws, attempt("users",
      "env.ADMIN.listUsers({ limit: 1 }).then(page => page.users.length)"),
      { connection: herConnection });
  expect(await marking.results()).toEqual({ users: { value: 1 } });
  expect(await isRestricted(hers.ws)).toBe(true);
  const [granted, plain] = [
    await fileReport(heidi, { context: { workspaceId: hers.id } }),
    await fileReport(heidi, { context: { workspaceId: hers.id } }),
  ];
  await hers.ws.grantAdminAccess({ reportId: granted.id });
  restricted = { id: hers.id, chatId: marking.chatId, granted: granted.id, plain: plain.id };

  const [nell, late] = [await newMember(suite, "nell"), await newMember(suite, "afterwards")];
  const { ws, id, connection } = await sharedTriage("Triage, a restricted reporter", nell);

  // The report never marks, and neither does opening the view, which returns no data.
  const first = await agentTurn(owner, ws, inSession(granted.id,
      attempt("get", "report.get().then(report => report.id)")), { connection });
  expect(await first.results()).toEqual({ get: { value: granted.id } });
  expect(await isRestricted(ws)).toBe(false);
  const { chatId } = first;
  const opened = await agentTurn(owner, ws, inView(granted.id, `out.opened = { value: true };`), { chatId });
  expect(await opened.results()).toEqual({ opened: { value: true } });
  expect(await isRestricted(ws)).toBe(false);

  // The view's first answer does, metadata though it is; content under her grant does too.
  const metadata = await agentTurn(owner, ws, inView(granted.id, listChats), { chatId });
  expect(await metadata.results()).toEqual({ chats: { value: 1 } });
  expect(await isRestricted(ws)).toBe(true);
  const content = await agentTurn(owner, ws, inView(granted.id, getChat(restricted.chatId)), { chatId });
  expect(await content.results()).toEqual({ chat: { value: true } });
  expect(await observations(ws)).toEqual([
    ["Issue report: get", false],
    ["Issue report: inspectWorkspace", false],
    ["Issue report: inspectWorkspace", false], ["Admin view: listChats", true],
    ["Issue report: inspectWorkspace", false], ["Admin view: getChat", true],
  ]);

  // From then on nothing is applied without a person, a reply through the session included,
  // and no public site is fetched.
  const reply = await agentTurn(owner, ws, inSession(granted.id,
      attempt("scoped", `report.reply("We read your workspace")`)), { chatId });
  await settle(ws);
  const [held] = await pendingActions(ws, 1);
  expect(tagOf(held!)).toBe(TAGS.issueReportScopedReply);
  expect(reply.paused()).toBe(true);
  expect(await reporterThread(heidi, granted.id)).toEqual([]);
  await ws.approveAction(held!.id);
  await reply.resumed();
  expect(await decisions(ws)).toEqual([[TAGS.issueReportScopedReply, "approved", false]]);
  expect((await reporterThread(heidi, granted.id)).map(entry => entry.text))
      .toEqual(["We read your workspace"]);
  expect(await fetchPublicPage(ws, chatId)).toContain(WEB_FETCH_PROHIBITED);
  expect(webRequests).toEqual([]);

  // Restricted, but not admins-only for good: that follows a read through the whole binding
  // alone. With the connection removed, the workspace is shared again as any workspace.
  expect(await opening(suite, nell, id)).toBe(workspaceAccessDenied);
  await connection.client.remove();
  expect(await isRestricted(ws)).toBe(true);
  expect(await opening(suite, nell, id)).toBe("opened");
  expect(await ws.addCollaborator(late.name, "workspace")).not.toBeNull();
});

it("leaves the workspace unmarked when a report session reads an ordinary reporter's " +
    "workspace, so its reply still reaches the reporter with no person", async () => {
  const { reporter, chatId: theirChat, ws: theirs, reports: [report] } =
      await reporterWithWorkspace("ordinary");
  await theirs.grantAdminAccess({ reportId: report!.id });
  const { ws, connection } = await sharedTriage(
      "Triage, an ordinary reporter", await newMember(suite, "nell"));

  const metadata = await agentTurn(owner, ws, inView(report!.id, listChats), { connection });
  expect(await metadata.results()).toEqual({ chats: { value: 1 } });
  expect(await isRestricted(ws)).toBe(false);
  const { chatId } = metadata;
  const content = await agentTurn(owner, ws, inView(report!.id, getChat(theirChat)), { chatId });
  expect(await content.results()).toEqual({ chat: { value: true } });
  expect(await isRestricted(ws)).toBe(false);
  expect((await observations(ws)).map(([, flagged]) => flagged)).toEqual([false, false, false, false]);

  const reply = await agentTurn(owner, ws, inSession(report!.id,
      attempt("scoped", `report.reply("We read your workspace")`)), { chatId });
  await reply.resumed();
  expect(await decisions(ws)).toEqual([[TAGS.issueReportScopedReply, "approved", true]]);
  expect((await reporterThread(reporter, report!.id)).map(entry => entry.text))
      .toEqual(["We read your workspace"]);
  // A public site is still fetched from here.
  expect(await fetchPublicPage(ws, chatId)).toContain("A public page");
  expect(webRequests).toEqual([PUBLIC_PAGE]);
});

it("holds a scoped reply drafted before a view's answer marked the workspace", async () => {
  const { ws, connection } = await triageWorkspace("Triage, drafted before the mark", { rules: true });
  const front = await agentTurn(owner, ws,
      attempt("reply", addEntry(restricted.plain, "A public reply", "public")), { connection });
  const draft = await agentTurn(owner, ws,
      attempt("scoped", scopedReply(restricted.plain, "Drafted before the view")), { connection });
  const [reply, scoped] = await pendingActions(ws, 2);
  expect(await isRestricted(ws)).toBe(false);

  const viewing = await agentTurn(owner, ws, inView(restricted.plain, listChats), { connection });
  expect(await viewing.results()).toEqual({ chats: { value: 1 } });
  expect(await isRestricted(ws)).toBe(true);

  await ws.approveAction(reply!.id);
  await front.resumed();
  await settle(ws);
  expect((await pendingActions(ws, 1)).map(action => action.id)).toEqual([scoped!.id]);
  expect(draft.paused()).toBe(true);
  expect((await reporterThread(heidi, restricted.plain)).map(entry => entry.text))
      .toEqual(["A public reply"]);
});
