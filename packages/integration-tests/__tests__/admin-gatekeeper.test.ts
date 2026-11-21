import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ADMIN_AGENT_ACTIONS, ADMIN_AGENT_LEND_SECONDS } from "@gadgets/workshop-shared/admin-agent";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_GRANT_ERROR_CODES, createAdminAccessError, getAdminAccessErrorCode,
  OPEN_WORKSPACE_ERROR_CODES, type AdminApi, type Overseer,
} from "@gadgets/workshop-shared/api";
import type { Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, waitFor, type ConnectedAccount } from "../src/rpc-client.js";
import {
  ACCOUNT_REMOVED, addAdminConnection, adminAccounts, adminActions, adminApiOf, agentTurn,
  approveContent, auditCount, auditRecords, buildGadget, collaboratorIds,
  connectionVendors, DEPLOYMENT_URL, enableEveryRule, EVERY_TAG, fileReport,
  gadgetIds, GRACE, HAS_CONNECTION, HAS_READ, HEIDI, isRestricted, listed, newMember, newUser,
  newWorkspace, observationTitles, openAs, opening, OWNER, pendingActions, provisionAdminAccount,
  reconnect, removeMember, reporterThread, requestsFiled, settle, signedInAgain,
  startAdminHarness, TAGS, turnModels, VENDOR, withAdmins, writesMade, type AdminConnection,
  type Suite, type SuiteUser,
} from "./admin-gatekeeper-harness.js";

// Who is offered the admin gatekeeper, where its connection goes, what an agent reads through
// it and how each read is recorded, who is admitted to a workspace that has it, and who may
// approve what it files.
//
// The vendor's mode, the audit log, the issue reports and the content requests are deployment-wide, so
// this file owns its harness and its cases run in order: the first two leave the vendor's mode
// "optional" and the owner with an account, which the rest use.
const models = turnModels();
const network = new NetworkInterceptor({ handlers: [models.handler] });
const scope = new DisposableStack();
let harness: Harness;
let suite: Suite;
let owner: SuiteUser;
let grace: SuiteUser;
let heidi: SuiteUser;
let admin: RpcStub<AdminApi>;
let graceAdmin: RpcStub<AdminApi>;
let heidiAdmin: RpcStub<AdminApi>;
// The owner's account of the vendor, added in the second case.
let ownerAccount: ConnectedAccount;

beforeAll(async () => {
  network.install();
  harness = await startAdminHarness();
  suite = { harness, models, scope };
  owner = await newUser(suite, OWNER);
  grace = await newUser(suite, GRACE);
  heidi = await newUser(suite, HEIDI);
  admin = await adminApiOf(suite, owner);
  // Content can be read wherever a grant is live.
  await admin.setAdminWorkspaceAccess("content");
  graceAdmin = await adminApiOf(suite, grace);
  heidiAdmin = await adminApiOf(suite, heidi);
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

const { contentNotRequested, grantRequired } = ADMIN_ACCESS_ERROR_CODES;
const { workspaceAccessDenied } = OPEN_WORKSPACE_ERROR_CODES;
const { secondAdminRequired } = ADMIN_GRANT_ERROR_CODES;
const ADMINS_ONLY = "Only deployment admins can add this gatekeeper.";

/** The ids of the vendors a listing names. */
const vendorIds = (vendors: { id: string }[]) => vendors.map(vendor => vendor.id);

it("offers an admin nothing while the vendor's mode was never set", async () => {
  const { resourceVendors } = await admin.getSettings();
  expect(resourceVendors.find(vendor => vendor.vendorId === VENDOR))
      .toMatchObject({ autoProvisions: true, ambientMode: "disabled" });
  expect(vendorIds(await owner.api.listAddableGatekeepers())).not.toContain(VENDOR);
  expect(vendorIds(await owner.api.listGatekeeperVendors())).not.toContain(VENDOR);
  await expect(owner.api.provisionAmbientAccount(VENDOR)).rejects.toThrow();
  expect(await adminAccounts(owner.api, { includeForcedAutoProvisionedAccounts: true }))
      .toEqual([]);
});

it("offers a non-admin nothing, whatever the mode", async () => {
  const outsider = await newMember(suite, "outsider");
  const { ws } = await newWorkspace(suite, outsider, "An outsider's workspace");

  await admin.setGatekeeperMode(VENDOR, "optional");
  expect(vendorIds(await owner.api.listAddableGatekeepers())).toContain(VENDOR);
  ownerAccount = await provisionAdminAccount(owner);

  for (const mode of ["optional", "enabled"] as const) {
    await admin.setGatekeeperMode(VENDOR, mode);
    expect(vendorIds(await outsider.api.listAddableGatekeepers()), mode).not.toContain(VENDOR);
    expect(vendorIds(await outsider.api.listGatekeeperVendors()), mode).not.toContain(VENDOR);
    await expect(outsider.api.provisionAmbientAccount(VENDOR), mode).rejects.toThrow(ADMINS_ONLY);
    // Nothing was provisioned for them, the forced accounts of an "enabled" vendor included.
    expect(await adminAccounts(outsider.api, { includeForcedAutoProvisionedAccounts: true }), mode)
        .toEqual([]);
    // An account id is its user's: the admin's names nothing of theirs.
    await expect(ws.newGatekeeper(ownerAccount.id, DEPLOYMENT_URL), mode).rejects.toThrow();
  }
  await admin.setGatekeeperMode(VENDOR, "optional");

  const turn = await agentTurn(outsider, ws, `out.admin = { value: typeof env.ADMIN };`);
  expect(await turn.results()).toEqual({ admin: { value: "undefined" } });
  expect(await observationTitles(ws)).toEqual([]);
});

it("injects nothing: an admin adds the connection to the workspaces that need it", async () => {
  const triage = await newWorkspace(suite, owner, "Triage");
  const notes = await newWorkspace(suite, owner, "Notes");
  expect(await connectionVendors(admin, triage.id)).not.toContain(VENDOR);
  expect(await connectionVendors(admin, notes.id)).not.toContain(VENDOR);

  await addAdminConnection(triage.ws, ownerAccount.id);
  expect(await connectionVendors(admin, triage.id)).toContain(VENDOR);
  expect(await connectionVendors(admin, notes.id)).not.toContain(VENDOR);

  // The other workspace is shared as any workspace is.
  const [builder, visitor] = [await newMember(suite, "builder"), await newMember(suite, "visitor")];
  expect(await notes.ws.addCollaborator(builder.name, "workspace")).not.toBeNull();
  expect(await opening(suite, builder, notes.id)).toBe("opened");
  const link = await notes.ws.createShareLink("workspace");
  expect(await opening(suite, visitor, notes.id, { shareKey: link.key })).toBe("opened");
  expect(await collaboratorIds(notes.ws))
      .toEqual(expect.arrayContaining([builder.name, visitor.name]));

  // The same where the deployment forces the account on every admin: heidi never added it.
  await admin.setGatekeeperMode(VENDOR, "enabled");
  try {
    const own = await newWorkspace(suite, heidi, "Heidi's desk");
    expect(await adminAccounts(heidi.api)).toEqual([]);
    const offered = (await heidi.api.listGatekeeperVendors()).find(vendor => vendor.id === VENDOR);
    expect(offered?.supportedResources.map(resource => resource.urlPattern))
        .toEqual([DEPLOYMENT_URL]);
    expect(await connectionVendors(admin, own.id)).not.toContain(VENDOR);

    // What the connection picker passes provisions the account, and still adds no connection.
    const [account] = await adminAccounts(
        heidi.api, { includeForcedAutoProvisionedAccounts: true });
    expect(account).toBeDefined();
    expect(await connectionVendors(admin, own.id)).not.toContain(VENDOR);

    const connection = await addAdminConnection(own.ws, account!.id);
    const turn = await agentTurn(heidi, own.ws, `
      await attempt("users", () => env.ADMIN.listUsers({ limit: 1 }));
      await attempt("view", async () => {
        const view = await env.ADMIN.inspectWorkspace(${JSON.stringify(notes.id)}, "Looking");
        return (await view.describe()).id;
      });`, { connection });
    expect(await turn.results()).toEqual({
      users: { value: expect.objectContaining({ users: [expect.anything()] }) },
      view: { value: notes.id },
    });
    // The owner of the workspace the call came from is the admin of its record.
    const [described] = await auditRecords(admin, { workspace: notes.id, method: "describe" });
    expect(described).toMatchObject({
      admin: HEIDI, via: "gatekeeper", agent: { workspaceId: own.id, chatId: turn.chatId },
    });
  } finally {
    await admin.setGatekeeperMode(VENDOR, "optional");
  }
});

it("records an agent's view calls as made through the gatekeeper, for the owner, with the " +
    "workspace and the chat, and marks the workspace at the first read", async () => {
  const subject = await newMember(suite, "subject");
  const theirs = await newWorkspace(suite, subject, "A user's workspace");
  await theirs.ws.newChat("hello", null);
  const report = await fileReport(subject);
  const triage = await newWorkspace(suite, owner, "Triage reads");
  const connection = await addAdminConnection(triage.ws, ownerAccount.id);
  expect(await isRestricted(triage.ws)).toBe(false);
  expect(await observationTitles(triage.ws)).toEqual([]);

  const before = await auditCount(harness);
  const turn = await agentTurn(owner, triage.ws, `
    await attempt("reports", () => env.ADMIN.listIssueReports());
    await attempt("report", () => env.ADMIN.getIssueReport(${JSON.stringify(report.id)}));
    await attempt("users", () => env.ADMIN.listUsers({ limit: 1 }));
    await attempt("view", async () => {
      const view = await env.ADMIN.inspectWorkspace(
          ${JSON.stringify(theirs.id)}, "Looking into a report", { lifetimeSeconds: 3600 });
      const { expiresAt } = await view.describe();
      return { expiresAt, chats: (await view.listChats()).length };
    });`, { connection });
  const ended = Date.now();
  const results = await turn.results();
  expect(results).toMatchObject({
    reports: { value: { reports: expect.arrayContaining([expect.objectContaining({ id: report.id })]) } },
    report: { value: { id: report.id } },
    users: { value: { users: [expect.anything()] } },
    view: { value: { chats: 1 } },
  });

  // The view's open and its two calls are the turn's only records: a listing and a report are
  // read with no record in the audit log.
  expect(await auditCount(harness)).toBe(before + 3);
  const records = await auditRecords(admin, { workspace: theirs.id });
  expect(records.map(record => record.method)).toEqual(["listChats", "describe", "inspectWorkspace"]);
  for (const record of records) {
    expect(record).toMatchObject({
      kind: "workspace", admin: OWNER, via: "gatekeeper", exposed: "metadata",
      agent: { workspaceId: triage.id, chatId: turn.chatId },
    });
  }

  // Each read, the unrecorded ones included, is an observation of the workspace that made it.
  expect((await observationTitles(triage.ws)).toReversed()).toEqual([
    "Admin API: listIssueReports", "Admin API: getIssueReport", "Admin API: listUsers",
    "Admin API: inspectWorkspace", "Admin view: describe", "Admin view: listChats",
  ]);
  expect(await isRestricted(triage.ws)).toBe(true);

  // A view does not outlive the lend that opened it, whatever lifetime the agent asked for: the
  // lend began before the turn ended, and the seconds a view is given are rounded up.
  const { expiresAt } = results.view!.value as { expiresAt: string };
  expect(new Date(expiresAt).getTime())
      .toBeLessThanOrEqual(ended + (ADMIN_AGENT_LEND_SECONDS + 1) * 1000);
});

/** An agent's code that reads a chat through a view of `workspaceId` opened for `access`. */
const chatThroughBinding = (workspaceId: string, chatId: number, access: "content" | "metadata") =>
  `async () => {
    const view = await env.ADMIN.inspectWorkspace(
        ${JSON.stringify(workspaceId)}, "Reading a chat", { access: "${access}" });
    return (await view.getChat(${chatId})).messages.length;
  }`;

/** The same read by the admin's own call: how many messages, or the code it is refused with. */
async function chatByHand(workspaceId: string, chatId: number, access: "content" | "metadata") {
  using view = await admin.inspectWorkspace(workspaceId, "Reading a chat", { access });
  return view.getChat(chatId).then(chat => chat.messages.length, getAdminAccessErrorCode);
}

/** The audit log's records of chats read in `workspace`, newest first. */
const chatReads = (workspace: string) => auditRecords(admin, { workspace, method: "getChat" });

it("reads content exactly where the workspace's own check allows it", async () => {
  const subject = await newMember(suite, "granter");
  const granted = await newWorkspace(suite, subject, "Granted");
  const closed = await newWorkspace(suite, subject, "Not granted");
  const grantedChat = await granted.ws.newChat("hello", null);
  const closedChat = await closed.ws.newChat("hello", null);
  const grant = await granted.ws.grantAdminAccess();
  const triage = await newWorkspace(suite, owner, "Triage content");
  const connection = await addAdminConnection(triage.ws, ownerAccount.id);

  const turn = await agentTurn(owner, triage.ws, `
    await attempt("granted", ${chatThroughBinding(granted.id, grantedChat, "content")});
    await attempt("closed", ${chatThroughBinding(closed.id, closedChat, "content")});
    await attempt("metadata", ${chatThroughBinding(granted.id, grantedChat, "metadata")});`,
      { connection });
  expect(await turn.results()).toEqual({
    granted: { value: 1 },
    closed: { error: createAdminAccessError(grantRequired).message },
    metadata: { error: createAdminAccessError(contentNotRequested).message },
  });

  const origin = { via: "gatekeeper", admin: OWNER, agent: { workspaceId: triage.id, chatId: turn.chatId } };
  expect(await chatReads(granted.id)).toEqual([
    expect.objectContaining({ ...origin, requested: "metadata", refused: contentNotRequested }),
    expect.objectContaining({ ...origin, exposed: "content", grantId: grant.id }),
  ]);
  expect(await chatReads(closed.id)).toEqual([
    expect.objectContaining({ ...origin, requested: "content", refused: grantRequired }),
  ]);

  // The gatekeeper changes neither answer: the admin's own calls end the same way.
  expect(await chatByHand(granted.id, grantedChat, "content")).toBe(1);
  expect(await chatByHand(closed.id, closedChat, "content")).toBe(grantRequired);
  expect(await chatByHand(granted.id, grantedChat, "metadata")).toBe(contentNotRequested);
});

it("admits only its owner and deployment admins to a workspace that has the connection", async () => {
  const triage = await newWorkspace(suite, owner, "Triage desk");
  const { ws } = triage;
  const subject = await newWorkspace(suite, await newMember(suite, "inspected"), "Inspected");
  using board = await ws.createGadget("Board", undefined, "BOARD");
  const [early, viewer, visitor, late] = [
    await newMember(suite, "early"), await newMember(suite, "viewer"),
    await newMember(suite, "linked"), await newMember(suite, "late"),
  ];
  const graceAccount = await provisionAdminAccount(grace);
  const heidiAccount = await provisionAdminAccount(heidi);

  // Shared as any workspace is, before it has the connection.
  expect(await ws.addCollaborator(early.name, "workspace")).not.toBeNull();
  expect(await ws.addCollaborator(viewer.name, { gadgetId: await board.getId() })).not.toBeNull();
  expect(await opening(suite, early, triage.id)).toBe("opened");
  expect(await opening(suite, viewer, triage.id)).toBe("opened");
  const link = await ws.createShareLink("workspace");
  // A chat's updates go to the members who follow it, so the collaborator follows the one the
  // owner posts in, and is sent what is posted there.
  const followed = await ws.newChat("Posted before the connection", null);
  const unreadOf = async (user: SuiteUser) =>
    (await user.api.getUnreadThreads())
        .find(thread => thread.workspaceId === triage.id && thread.chatId === followed)
        ?.unreadMessageCount ?? 0;
  {
    using earlyWs = await openAs(suite, early, triage.id);
    await earlyWs.setChatNotificationsEnabled(followed, true);
  }
  await ws.sendChatMessage(followed, "Posted to the collaborator", null);
  await waitFor("the collaborator's unread chat", async () => await unreadOf(early) > 0 || null);

  const connection = await addAdminConnection(ws, ownerAccount.id);
  expect(await isRestricted(ws)).toBe(false);

  const admission = async (phase: string) => {
    // No role opens it for someone who is not a deployment admin, and neither does a link.
    expect(await opening(suite, early, triage.id), phase).toBe(workspaceAccessDenied);
    expect(await opening(suite, viewer, triage.id), phase).toBe(workspaceAccessDenied);
    expect(await opening(suite, visitor, triage.id, { shareKey: link.key }), phase)
        .toBe(workspaceAccessDenied);
    await expect(ws.addCollaborator(late.name, "workspace"), phase).rejects.toThrow(
        phase === "before" ? HAS_CONNECTION : HAS_READ);
    const collaborators = await collaboratorIds(ws);
    expect(collaborators, phase).not.toContain(visitor.name);
    expect(collaborators, phase).not.toContain(late.name);
  };
  await admission("before");

  // An admin redeems the same link, once she has chosen her own account of this vendor as the
  // observer step asks: without one her open stops at that step, as for any vendor.
  expect(await opening(suite, grace, triage.id, { shareKey: link.key })).not.toBe("opened");
  using graceWs = await openAs(suite, grace, triage.id, { shareKey: link.key, accountId: graceAccount.id });
  expect(await collaboratorIds(ws)).toContain(GRACE);
  expect(await ws.addCollaborator(HEIDI, "workspace")).not.toBeNull();

  // Only the owner adds the connection, and only the owner opens it directly: a member's call
  // is refused before anything is lent, so it is recorded nowhere and marks nothing.
  await expect(graceWs.newGatekeeper(graceAccount.id, DEPLOYMENT_URL))
      .rejects.toThrow("Only this workspace's owner can add the admin connection.");
  const direct = async <T>(
      member: RpcStub<Overseer>, call: (session: RpcStub<AdminApi>) => Promise<T>) => {
    using client = await member.getGatekeeperById(connection.id);
    using session = await client.openSession() as RpcStub<AdminApi>;
    return await call(session);
  };
  const records = await auditCount(harness);
  await expect(direct(graceWs, session => session.listUsers()))
      .rejects.toThrow("Only this workspace's owner can open the admin connection directly");
  // Nor does it queue an action, which a rule could apply as the owner's with nobody deciding.
  await expect(direct(graceWs, session => session.addIssueReportEntry("a-report", "A note.", "admins")))
      .rejects.toThrow("Only this workspace's owner can open the admin connection directly");
  expect(await adminActions(ws)).toEqual([]);
  expect(await auditCount(harness)).toBe(records);
  expect(await isRestricted(ws)).toBe(false);
  expect(await observationTitles(ws)).toEqual([]);

  // The owner's own session is lent the Admin API: its records carry the workspace and no chat.
  await expect(direct(ws, async session => {
    await session.listUsers();
    using view = await session.inspectWorkspace(subject.id, "Checking by hand");
    return (await view.describe()).id;
  })).resolves.toBe(subject.id);
  const [described] = await auditRecords(admin, { workspace: subject.id, method: "describe" });
  expect(described).toMatchObject({ admin: OWNER, via: "gatekeeper" });
  expect(described!.kind === "workspace" && described.agent).toEqual({ workspaceId: triage.id });
  expect(await isRestricted(ws)).toBe(true);

  // A member's agent is lent the owner's Admin API: its records name the owner, and her chat.
  const turn = await agentTurn(grace, graceWs, `
    await attempt("users", () => env.ADMIN.listUsers({ limit: 1 }));
    await attempt("view", async () => {
      const view = await env.ADMIN.inspectWorkspace(${JSON.stringify(subject.id)}, "Looking");
      return (await view.listChats()).length;
    });
    await attempt("account", async () => {
      const view = await env.ADMIN.inspectUser(${JSON.stringify(early.name)}, "Looking");
      return (await view.describe()).profile.id;
    });`, { connection });
  expect(await turn.results()).toEqual({
    users: { value: expect.objectContaining({ users: [expect.anything()] }) },
    view: { value: 0 },
    account: { value: early.name },
  });
  const [chatsListed] = await auditRecords(admin, { workspace: subject.id, method: "listChats" });
  expect(chatsListed).toMatchObject({
    admin: OWNER, via: "gatekeeper", agent: { workspaceId: triage.id, chatId: turn.chatId },
  });
  // A view of a user's account is recorded the same way, in records of its own kind.
  const accountCalls = await auditRecords(admin, { kind: "user", owner: early.name });
  expect(accountCalls.map(record => record.method).toSorted()).toEqual(["describe", "inspectUser"]);
  for (const record of accountCalls) {
    expect(record).toMatchObject({
      kind: "user", userId: early.name, admin: OWNER, via: "gatekeeper",
      agent: { workspaceId: triage.id, chatId: turn.chatId },
    });
  }

  await admission("after");
  expect(await opening(suite, grace, triage.id, { accountId: graceAccount.id })).toBe("opened");
  expect(await opening(suite, heidi, triage.id, { accountId: heidiAccount.id })).toBe("opened");

  // The collaborator who was kept in the sharing list is sent nothing of what is posted since,
  // in the chat an admitted admin now follows too.
  await graceWs.setChatNotificationsEnabled(followed, true);
  const seen = await unreadOf(early);
  await ws.sendChatMessage(followed, "Posted with the connection", null);
  await waitFor("an admitted admin's unread chat", async () => await unreadOf(grace) > 0 || null);
  expect(await unreadOf(early)).toBe(seen);
  expect(await collaboratorIds(ws)).toEqual(expect.arrayContaining([early.name, viewer.name]));
});

it("lets an admin who is a member decide an action, and records who decided", async () => {
  const reporter = await newMember(suite, "notereporter");
  const report = await fileReport(reporter);
  const triage = await newWorkspace(suite, owner, "Triage decisions");
  const connection = await addAdminConnection(triage.ws, ownerAccount.id);
  expect(await triage.ws.addCollaborator(GRACE, "workspace")).not.toBeNull();
  using graceWs = await openAs(
      suite, grace, triage.id, { accountId: (await provisionAdminAccount(grace)).id });

  const turn = await agentTurn(owner, triage.ws, `await attempt("note", () =>
    env.ADMIN.addIssueReportEntry(${JSON.stringify(report.id)}, "Seen by the desk", "admins"));`,
      { connection });
  expect(turn.paused()).toBe(true);
  const [note] = await pendingActions(triage.ws, 1);
  expect(note!.description.actionKind?.tag).toBe(TAGS.issueReportNote);

  await graceWs.approveAction(note!.id);
  expect(await turn.resumed()).toEqual({ note: { value: null } });
  const [decided] = await adminActions(triage.ws);
  expect(decided).toMatchObject({ state: "approved", resolvedBy: { type: "user", id: GRACE } });
  expect(decided!.autoApproved).toBeFalsy();
  // The entry is the owner's: the call was made with the owner's Admin API.
  expect((await admin.getIssueReport(report.id)).entries).toEqual([expect.objectContaining({
    text: "Seen by the desk", visibility: "admins", via: "gatekeeper",
    author: expect.objectContaining({ id: OWNER }),
    agent: { workspaceId: triage.id, chatId: turn.chatId },
  })]);
  expect(await reporterThread(reporter, report.id)).toEqual([]);
});

/** An agent's code that files a request for the content of `workspaceId`. */
const ask = (workspaceId: string) => `await attempt("request", () =>
  env.ADMIN.requestContentAccess(${JSON.stringify(workspaceId)}, "A reporter asked for help"));`;

/** A gadget whose one method files a content request through its admin binding. */
const ASKING_GADGET = `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async ask(workspaceId) {
    await this.env.ADMIN.requestContentAccess(workspaceId, "A gadget asked");
    return "filed";
  }
}`;

it("keeps a content request filed through the connection from being approved by anyone who " +
    "is in its workspace, or who approved its filing", async () => {
  const wanted = await newMember(suite, "wanted");
  const [first, second, third, restarted] = [
    await newWorkspace(suite, wanted, "Wanted, first"),
    await newWorkspace(suite, wanted, "Wanted, second"),
    await newWorkspace(suite, wanted, "Wanted, third"),
    await newWorkspace(suite, wanted, "Wanted, restarted"),
  ];
  for (const { id } of [first, second, third, restarted]) await listed(admin, wanted.name, id);
  const triage = await newWorkspace(suite, owner, "Triage requests");
  let { ws } = triage;
  const connection = await addAdminConnection(ws, ownerAccount.id);
  expect(await enableEveryRule(ws, connection)).toEqual(EVERY_TAG);
  expect(await ws.addCollaborator(GRACE, "workspace")).not.toBeNull();
  using graceWs = await openAs(
      suite, grace, triage.id, { accountId: (await provisionAdminAccount(grace)).id });

  /** Runs a turn that asks for content of `workspaceId`: its card, pending under every rule. */
  const askForContent = async (workspaceId: string) => {
    const turn = await agentTurn(owner, ws, ask(workspaceId), { connection });
    await settle(ws);
    expect(turn.paused()).toBe(true);
    const [card] = await pendingActions(ws, 1);
    expect(card!.description.actionKind?.tag).toBe(TAGS.contentAccessRequest);
    // Nothing is filed until a person approves the card.
    expect(await requestsFiled(admin, workspaceId, triage.id)).toEqual([]);
    return { turn, card: card! };
  };

  // Approved by a member: neither the owner, whose Admin API filed it, nor that member may
  // approve the request. An admin from outside the workspace does.
  const byGrace = await askForContent(first.id);
  await graceWs.approveAction(byGrace.card.id);
  expect(await byGrace.turn.resumed()).toEqual({ request: { value: null } });
  const [request] = await requestsFiled(admin, first.id, triage.id);
  expect(request).toMatchObject({
    state: "pending", requestedBy: OWNER, via: "gatekeeper",
    agent: { workspaceId: triage.id, chatId: byGrace.turn.chatId },
  });
  expect(await approveContent(admin, request!.id)).toBe(secondAdminRequired);
  expect(await approveContent(graceAdmin, request!.id)).toBe(secondAdminRequired);
  // The grant is the admins': the workspace gave it when the request was approved.
  expect(await approveContent(heidiAdmin, request!.id)).toMatchObject({
    id: request!.id, state: "approved", resolvedBy: HEIDI, grantId: expect.any(String),
  });
  using view = await admin.inspectWorkspace(first.id, "Checking the grant");
  expect((await view.describe()).grants).toEqual([
    expect.objectContaining({ source: "admins", requestedBy: OWNER, requestId: request!.id }),
  ]);

  // Approved by the owner: a member who decided nothing is refused all the same.
  const byOwner = await askForContent(second.id);
  await ws.approveAction(byOwner.card.id);
  await byOwner.turn.resumed();
  const [again] = await requestsFiled(admin, second.id, triage.id);
  expect(await approveContent(admin, again!.id)).toBe(secondAdminRequired);
  expect(await approveContent(graceAdmin, again!.id)).toBe(secondAdminRequired);
  expect(await approveContent(heidiAdmin, again!.id)).toMatchObject({ resolvedBy: HEIDI });

  // A write is a kind of its own, which no rule applies: it waits for a person, and once a
  // member approves it, it runs as the owner's, with no other admin deciding.
  const restart = await agentTurn(owner, ws, `await attempt("write", () =>
    env.ADMIN.writeWorkspace(${JSON.stringify(restarted.id)}, "restartWorkspace", {},
        "A reporter asked for help"));`, { connection });
  await settle(ws);
  expect(restart.paused()).toBe(true);
  const [write] = await pendingActions(ws, 1);
  expect(write!.description.actionKind?.tag).toBe(TAGS.workspaceWriteRequest);
  expect(await writesMade(admin, restarted.id, triage.id)).toEqual([]);
  await graceWs.approveAction(write!.id);
  expect(await restart.resumed()).toEqual({ write: { value: null } });
  expect((await adminActions(ws)).at(-1)).toMatchObject({
    state: "approved", resolvedBy: { type: "user", id: GRACE },
    description: { actionKind: { tag: TAGS.workspaceWriteRequest } },
  });
  expect(await writesMade(admin, restarted.id, triage.id)).toEqual([expect.objectContaining({
    method: "restartWorkspace", admin: OWNER, via: "gatekeeper",
  })]);

  // A member who has left is an outsider again, but only for a request filed after she left,
  // and no rule files one: merged gadget code that asks for content waits for a person, who is
  // then counted among those who may not approve.
  ws = await removeMember(suite, owner, ws, GRACE);
  const { gadget } = await buildGadget(
      owner, ws, { name: "ASKER", server: ASKING_GADGET, bindings: { ADMIN: connection.id } });
  using facet = await gadget.connectToGadget() as RpcStub<{ ask(id: string): string }>;
  const asked = facet.ask(third.id);
  await settle(ws);
  const [held] = await pendingActions(ws, 1);
  expect(held!.description.actionKind?.tag).toBe(TAGS.contentAccessRequest);
  expect(await requestsFiled(admin, third.id, triage.id)).toEqual([]);
  await ws.approveAction(held!.id);
  expect(await asked).toBe("filed");
  const [late] = await requestsFiled(admin, third.id, triage.id);
  expect(late).toMatchObject({ requestedBy: OWNER, via: "gatekeeper" });
  expect(late!.agent).toEqual({ workspaceId: triage.id });
  expect(await approveContent(admin, late!.id)).toBe(secondAdminRequired);
  expect(await approveContent(graceAdmin, late!.id)).toMatchObject({ resolvedBy: GRACE });
});

/** What an RPC stub answers for a method its target does not have. */
const notImplemented = (method: string) =>
  ({ error: `The RPC receiver does not implement the method "${method}".` });

it("refuses the methods an agent is not given, and changes nothing", async () => {
  const subject = await newMember(suite, "kept");
  const theirs = await newWorkspace(suite, subject, "Kept as it is");
  await listed(admin, subject.name, theirs.id);
  /** The live grants of the user's workspace, as an admin's view lists them. */
  const grants = async () => {
    using view = await admin.inspectWorkspace(theirs.id, "Checking the grant");
    return (await view.describe()).grants.map(({ id, source }) => ({ id, source }));
  };

  // Each call below is one the Admin API would carry out for the owner: a name to set, an
  // admins' grant to end, and a pending request another admin filed, which the owner may
  // approve. So what is unchanged afterwards is unchanged because the call went nowhere.
  const granting = await admin.requestContentAccess(theirs.id, "Asked by hand");
  expect(await approveContent(heidiAdmin, granting.id)).toMatchObject({ resolvedBy: HEIDI });
  const [grant, ...others] = await grants();
  expect(grant).toMatchObject({ source: "admins" });
  expect(others).toEqual([]);
  const request = await graceAdmin.requestContentAccess(theirs.id, "Asked by hand");
  const { siteName } = await admin.getSettings();
  const triage = await newWorkspace(suite, owner, "Triage omitted");
  const connection = await addAdminConnection(triage.ws, ownerAccount.id);

  // Called, not looked up: every name on a stub is callable, so only the call's end tells.
  const turn = await agentTurn(owner, triage.ws, `
    await attempt("setSiteName", () => env.ADMIN.setSiteName("Renamed by an agent"));
    await attempt("approveContentAccess", () => env.ADMIN.approveContentAccess(
        ${JSON.stringify(request.id)}));
    await attempt("getUpdateStatus", () => env.ADMIN.getUpdateStatus());
    await attempt("endWorkspaceGrant", () => env.ADMIN.endWorkspaceGrant(
        ${JSON.stringify(theirs.id)}, ${JSON.stringify(grant!.id)}, "Ended by an agent"));`,
      { connection });
  expect(await turn.results()).toEqual({
    setSiteName: notImplemented("setSiteName"),
    approveContentAccess: notImplemented("approveContentAccess"),
    getUpdateStatus: notImplemented("getUpdateStatus"),
    endWorkspaceGrant: notImplemented("endWorkspaceGrant"),
  });

  expect((await admin.getSettings()).siteName).toBe(siteName);
  expect((await admin.getContentAccessRequest(request.id)).state).toBe("pending");
  expect(await grants()).toEqual([grant]);
  // A call that is refused observes nothing, so it marks nothing.
  expect(await observationTitles(triage.ws)).toEqual([]);
  expect(await isRestricted(triage.ws)).toBe(false);

  // The same grant and the same request, from the admin's own hand, are carried out.
  await admin.endWorkspaceGrant(theirs.id, grant!.id, "Ended by hand");
  expect(await grants()).toEqual([]);
  expect(await admin.approveContentAccess(request.id))
      .toMatchObject({ id: request.id, state: "approved", resolvedBy: OWNER });
});

it("refuses every call while the vendor is turned off, and answers again through the same " +
    "connection once it is back on", async () => {
  const triage = await newWorkspace(suite, owner, "Triage switched");
  const connection = await addAdminConnection(triage.ws, ownerAccount.id);
  const read = `await attempt("users", () => env.ADMIN.listUsers({ limit: 1 }));`;
  const answered = { users: { value: expect.objectContaining({ users: [expect.anything()] }) } };

  const first = await agentTurn(owner, triage.ws, read, { connection });
  expect(await first.results()).toEqual(answered);

  await admin.setGatekeeperMode(VENDOR, "disabled");
  try {
    const off = await agentTurn(owner, triage.ws, read, { chatId: first.chatId });
    expect(await off.results()).toEqual({ users: { error: "Gatekeeper is disabled." } });
  } finally {
    await admin.setGatekeeperMode(VENDOR, "optional");
  }

  const back = await agentTurn(owner, triage.ws, read, { chatId: first.chatId });
  expect(await back.results()).toEqual(answered);
  expect(await connectionVendors(admin, triage.id)).toEqual([VENDOR]);
});

const DIRECT_OWNER_ONLY = "Only this workspace's owner can open the admin connection directly";

/** Calls `listUsers()` on a session `member` opens from the connection by hand. */
async function directRead(member: RpcStub<Overseer>, connection: AdminConnection) {
  using client = await member.getGatekeeperById(connection.id);
  using session = await client.openSession() as RpcStub<AdminApi>;
  return await session.listUsers({ limit: 1 });
}

it("goes back to ordinary sharing when a connection that read nothing is removed", async () => {
  const reporter = await newMember(suite, "scopedreporter");
  const report = await fileReport(reporter);
  const [nell, visitor] = [await newMember(suite, "nell"), await newMember(suite, "passerby")];
  const triage = await newWorkspace(suite, owner, "Triage, scoped only");
  const { ws } = triage;
  // Shared before it has the connection, and never invited again.
  expect(await ws.addCollaborator(nell.name, "workspace")).not.toBeNull();
  expect(await opening(suite, nell, triage.id)).toBe("opened");
  const link = await ws.createShareLink("workspace");
  const connection = await addAdminConnection(ws, ownerAccount.id);
  await ws.setAutoApprovedActionKind(connection.id, ADMIN_AGENT_ACTIONS.issueReportNote.kind);
  await ws.setAutoApprovedActionKind(connection.id, ADMIN_AGENT_ACTIONS.issueReportScopedReply.kind);
  expect(await ws.addCollaborator(GRACE, "workspace")).not.toBeNull();
  using graceWs = await openAs(
      suite, grace, triage.id, { accountId: (await provisionAdminAccount(grace)).id });

  // Two reads refused before anything is lent: a member's own session, and a turn run while
  // the vendor is off.
  await expect(directRead(graceWs, connection)).rejects.toThrow(DIRECT_OWNER_ONLY);
  await admin.setGatekeeperMode(VENDOR, "disabled");
  let chatId: number;
  try {
    const off = await agentTurn(owner, ws,
        `await attempt("users", () => env.ADMIN.listUsers());`, { connection });
    expect(await off.results()).toEqual({ users: { error: "Gatekeeper is disabled." } });
    chatId = off.chatId;
  } finally {
    await admin.setGatekeeperMode(VENDOR, "optional");
  }

  // What it did do reads nothing through the connection: a session limited to one report,
  // opened and never read, its reply, and a note. Reading the report would mark the workspace.
  const turn = await agentTurn(owner, ws, `
    const report = await env.ADMIN.openIssueReport(${JSON.stringify(report.id)});
    await attempt("reply", () => report.reply("We are looking into it."));
    await attempt("note", () => env.ADMIN.addIssueReportEntry(
        ${JSON.stringify(report.id)}, "Triaged from the scoped session", "admins"));`, { chatId });
  expect(await turn.resumed()).toEqual({ reply: { value: null }, note: { value: null } });
  expect((await reporterThread(reporter, report.id)).map(entry => entry.text))
      .toEqual(["We are looking into it."]);
  expect(await observationTitles(ws)).toEqual([]);
  expect(await isRestricted(ws)).toBe(false);

  // Admins only while the connection is there.
  expect(await opening(suite, nell, triage.id)).toBe(workspaceAccessDenied);
  expect(await opening(suite, visitor, triage.id, { shareKey: link.key }))
      .toBe(workspaceAccessDenied);
  await expect(ws.addCollaborator(visitor.name, "workspace")).rejects.toThrow(HAS_CONNECTION);

  await connection.client.remove();
  expect(await connectionVendors(admin, triage.id)).not.toContain(VENDOR);
  expect(await isRestricted(ws)).toBe(false);
  expect(await opening(suite, nell, triage.id)).toBe("opened");
  expect(await opening(suite, visitor, triage.id, { shareKey: link.key })).toBe("opened");
  expect(await collaboratorIds(ws)).toEqual(expect.arrayContaining([nell.name, visitor.name]));
});

// A read through the whole binding, and one through a session limited to one report: a report's
// text and images are whatever its author put there.
it.each([
  { through: "the whole binding", read: `await attempt("read", async () =>
      (await env.ADMIN.listUsers({ limit: 1 })).users.length);` },
  { through: "a report session", read: `await attempt("read", async () =>
      (await (await env.ADMIN.openIssueReport(REPORT_ID)).get()).id === REPORT_ID ? 1 : 0);` },
])("stays admins-only for good once it has read through $through, removed or not", async ({ read }) => {
  const report = await fileReport(await newMember(suite, "readreporter"));
  const [nell, visitor, late] = [
    await newMember(suite, "nell"), await newMember(suite, "passerby"),
    await newMember(suite, "latecomer"),
  ];
  const triage = await newWorkspace(suite, owner, "Triage, read once");
  const { ws } = triage;
  expect(await ws.addCollaborator(nell.name, "workspace")).not.toBeNull();
  expect(await opening(suite, nell, triage.id)).toBe("opened");
  const link = await ws.createShareLink("workspace");
  const connection = await addAdminConnection(ws, ownerAccount.id);
  expect(await ws.addCollaborator(GRACE, "workspace")).not.toBeNull();
  const graceAccount = await provisionAdminAccount(grace);
  expect(await opening(suite, grace, triage.id, { accountId: graceAccount.id })).toBe("opened");

  const turn = await agentTurn(owner, ws,
      read.replaceAll("REPORT_ID", JSON.stringify(report.id)), { connection });
  expect(await turn.results()).toEqual({ read: { value: 1 } });
  expect(await isRestricted(ws)).toBe(true);

  await connection.client.remove();
  expect(await connectionVendors(admin, triage.id)).not.toContain(VENDOR);

  // Its chats still hold what was read, so nothing lifts the rule.
  expect(await isRestricted(ws)).toBe(true);
  expect(await opening(suite, nell, triage.id)).toBe(workspaceAccessDenied);
  expect(await opening(suite, visitor, triage.id, { shareKey: link.key }))
      .toBe(workspaceAccessDenied);
  await expect(ws.addCollaborator(late.name, "workspace")).rejects.toThrow(HAS_READ);
  const collaborators = await collaboratorIds(ws);
  expect(collaborators).toContain(nell.name);
  expect(collaborators).not.toContain(visitor.name);
  expect(collaborators).not.toContain(late.name);

  // An admin still opens it, and reads the chat that holds what was read.
  using graceWs = await openAs(suite, grace, triage.id, { accountId: graceAccount.id });
  expect((await graceWs.listChats()).map(chat => chat.id)).toContain(turn.chatId);
  expect((await graceWs.getChatHistory(turn.chatId)).messages.length).toBeGreaterThan(0);
});

it("ends the connections made with an account when its owner removes it, until they add " +
    "it again", async () => {
  const reporter = await newMember(suite, "waiting");
  const report = await fileReport(reporter);
  const subject = await newWorkspace(suite, reporter, "Looked at");
  const triage = await newWorkspace(suite, owner, "Triage, account removed");
  const spare = await newWorkspace(suite, owner, "Spare");
  const { ws } = triage;
  const connection = await addAdminConnection(ws, ownerAccount.id);
  await ws.setAutoApprovedActionKind(connection.id, ADMIN_AGENT_ACTIONS.issueReportStatus.kind);
  const paused = await agentTurn(owner, ws, `await attempt("note", () => env.ADMIN.addIssueReportEntry(
      ${JSON.stringify(report.id)}, "Held while the account was gone", "admins"));`, { connection });
  const [note] = await pendingActions(ws, 1);

  await owner.api.disconnectAccount(ownerAccount.id);
  expect(await adminAccounts(owner.api)).toEqual([]);

  const read = `
    await attempt("users", () => env.ADMIN.listUsers({ limit: 1 }));
    await attempt("view", async () => {
      const view = await env.ADMIN.inspectWorkspace(${JSON.stringify(subject.id)}, "Looking");
      return (await view.describe()).id;
    });`;
  const records = await auditCount(harness);
  const cut = await agentTurn(owner, ws, read, { connection });
  expect(await cut.results()).toEqual(
      { users: { error: ACCOUNT_REMOVED }, view: { error: ACCOUNT_REMOVED } });
  expect(await auditCount(harness)).toBe(records);
  expect(await isRestricted(ws)).toBe(false);

  // No new connection can be made, and the pending action cannot be applied; the connection,
  // its rule and the action are all still there.
  await expect(spare.ws.newGatekeeper(ownerAccount.id, DEPLOYMENT_URL)).rejects.toThrow();
  await expect(ws.approveAction(note!.id)).rejects.toThrow(ACCOUNT_REMOVED);
  expect((await pendingActions(ws, 1)).map(action => action.id)).toEqual([note!.id]);
  expect(await ws.listAutoApprovedActionKinds()).toEqual([
    { gatekeeperId: connection.id, actionKind: ADMIN_AGENT_ACTIONS.issueReportStatus.kind },
  ]);
  expect(await connectionVendors(admin, triage.id)).toEqual([VENDOR]);
  expect((await admin.getIssueReport(report.id)).entries).toEqual([]);

  // Added again, the account is another one, and the same connection answers with it.
  const removed = ownerAccount.id;
  ownerAccount = await provisionAdminAccount(owner);
  expect(ownerAccount.id).not.toBe(removed);
  const back = await agentTurn(owner, ws, read, { chatId: cut.chatId });
  expect(await back.results()).toEqual({
    users: { value: expect.objectContaining({ users: [expect.anything()] }) },
    view: { value: subject.id },
  });
  await ws.approveAction(note!.id);
  expect(await paused.resumed()).toEqual({ note: { value: null } });
  expect((await admin.getIssueReport(report.id)).entries.map(entry => entry.text))
      .toEqual(["Held while the account was gone"]);
});

/**
 * A gadget that subscribes a hook when it is asked to, and whose other methods show what its
 * admin binding reaches.
 */
const WATCHER_GADGET = `import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async [restore](params) {
    if (params.type !== "reports") throw new TypeError("Unknown restore type: " + params.type);
    return new Reports();
  }
  async subscribe() {
    await this.env.ADMIN.subscribeIssueReported(await this.ctx.restore({ type: "reports" }));
    return "subscribed";
  }
  async binding() { return typeof this.env.ADMIN; }
  async look(workspaceId) {
    const view = await this.env.ADMIN.inspectWorkspace(workspaceId, "Checking from a gadget");
    return (await view.describe()).id;
  }
}
class Reports extends RpcTarget {
  async issueReported() {}
}`;

type Watcher = { subscribe(): string; binding(): string; look(workspaceId: string): string };

/** What fills the blueprint's one binding with the account `accountId`. */
const assignment = (accountId: number) =>
  ({ ADMIN: { type: "gatekeeper" as const, accountId, resourceUrl: DEPLOYMENT_URL } });

it("publishes a blueprint that carries no connection and no subscription", async () => {
  const subject = await newWorkspace(suite, await newMember(suite, "watched"), "Watched");
  const source = await newWorkspace(suite, owner, "Watcher's source");
  const connection = await addAdminConnection(source.ws, ownerAccount.id);
  const { gadget } = await buildGadget(owner, source.ws,
      { name: "WATCHER", server: WATCHER_GADGET, bindings: { ADMIN: connection.id } });
  using facet = await gadget.connectToGadget() as RpcStub<Watcher>;
  expect(await facet.subscribe()).toBe("subscribed");
  expect(await source.ws.listHooks()).toHaveLength(1);

  const blueprint = await gadget.createBlueprint("Watcher", "Watches the issue reports");
  using publicApi = connect(harness.url);
  const published = await waitFor("the published blueprint", () => publicApi.getBlueprint(blueprint.id));
  // The binding names the vendor and the kind of resource: no account, workspace or hook.
  expect(published.metadata.bindings).toEqual({
    ADMIN: {
      title: "Deployment admin", description: "", type: "gatekeeper", gatekeeperName: VENDOR,
      resourceTypeId: "deployment", typeUrlPattern: DEPLOYMENT_URL,
    },
  });
  expect(JSON.stringify(published.metadata)).not.toContain(source.id);

  // Someone who is not an admin has no account to fill the binding with: left out, their
  // workspace has no connection of the vendor, and the admin's account id names nothing of
  // theirs. Neither way is a hook bound, and the gadget's code has nothing to subscribe through.
  const outsider = await newMember(suite, "installer");
  await expect(outsider.api.newWorkspaceFromBlueprint(blueprint.id, assignment(ownerAccount.id)))
      .rejects.toThrow("No such account.");
  const bare = suite.scope.use(
      await (await reconnect(suite, outsider)).newWorkspaceFromBlueprint(blueprint.id, {}));
  expect(await connectionVendors(admin, (await bare.getMetadata()).id)).not.toContain(VENDOR);
  expect(await bare.listHooks()).toEqual([]);
  using theirs = await bare.getGadget((await gadgetIds(bare))[0]!);
  using theirFacet = await theirs.connectToGadget() as RpcStub<Watcher>;
  expect(await theirFacet.binding()).toBe("undefined");
  await expect(theirFacet.subscribe()).rejects.toThrow();
  expect(await bare.listHooks()).toEqual([]);

  // Another admin fills it with her own account: the connection is hers, the workspace is
  // admins-only from that moment, its calls are recorded as hers, and it has no hook until her
  // instance of the gadget subscribes one itself.
  const graceAccount = await provisionAdminAccount(grace);
  const installed = suite.scope.use(await (await reconnect(suite, grace)).newWorkspaceFromBlueprint(
      blueprint.id, assignment(graceAccount.id)));
  const { id: installedId } = await installed.getMetadata();
  expect(await connectionVendors(admin, installedId)).toEqual([VENDOR]);
  await expect(installed.addCollaborator(outsider.name, "workspace")).rejects.toThrow(HAS_CONNECTION);
  expect(await installed.listHooks()).toEqual([]);

  const [gadgetId] = await gadgetIds(installed);
  using hers = await installed.getGadget(gadgetId!);
  using herFacet = await hers.connectToGadget() as RpcStub<Watcher>;
  expect(await herFacet.look(subject.id)).toBe(subject.id);
  const [described] = await auditRecords(admin, { workspace: subject.id, method: "describe" });
  expect(described).toMatchObject({ admin: GRACE, via: "gatekeeper" });
  expect(described!.kind === "workspace" && described.agent).toEqual({ workspaceId: installedId });
  expect(await herFacet.subscribe()).toBe("subscribed");
  expect(await installed.listHooks()).toHaveLength(1);
});

// Last: each redeploy ends every session the cases above opened.
it("refuses a demoted owner's connection everything, keeps what it had, and answers again " +
    "once they are an admin again", async () => {
  const reporter = await newMember(suite, "patient");
  const report = await fileReport(reporter);
  const triage = await newWorkspace(suite, owner, "Triage, owner demoted");
  const connection = await addAdminConnection(triage.ws, ownerAccount.id);
  const { gadget } = await buildGadget(owner, triage.ws,
      { name: "WATCHER", server: WATCHER_GADGET, bindings: { ADMIN: connection.id } });
  using facet = await gadget.connectToGadget() as RpcStub<Watcher>;
  await facet.subscribe();
  const rule = { gatekeeperId: connection.id, actionKind: ADMIN_AGENT_ACTIONS.issueReportStatus.kind };
  await triage.ws.setAutoApprovedActionKind(rule.gatekeeperId, rule.actionKind);
  const paused = await agentTurn(owner, triage.ws, `await attempt("note", () =>
    env.ADMIN.addIssueReportEntry(${JSON.stringify(report.id)}, "Held while demoted", "admins"));`);
  const [note] = await pendingActions(triage.ws, 1);
  const read = `await attempt("users", () => env.ADMIN.listUsers({ limit: 1 }));`;
  const notAdmin = createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.notAdmin).message;

  await harness.redeployWorkshop(withAdmins([GRACE, HEIDI]));
  const demoted = await signedInAgain(suite, owner);
  expect(await demoted.api.getAdminApi()).toBeNull();
  expect(await adminAccounts(demoted.api)).toEqual([]);
  const ws = suite.scope.use(await demoted.api.openWorkspace(triage.id));
  const cut = await agentTurn(demoted, ws, read);
  expect(await cut.results()).toEqual({ users: { error: notAdmin } });
  await expect(ws.approveAction(note!.id)).rejects.toThrow(notAdmin);
  expect((await pendingActions(ws, 1)).map(action => action.id)).toEqual([note!.id]);
  // The connection, its rule and its hook are still the workspace's.
  expect(await ws.listAutoApprovedActionKinds()).toEqual([rule]);
  expect(await ws.listHooks()).toHaveLength(1);
  const stillAdmin = await adminApiOf(suite, await signedInAgain(suite, grace));
  expect(await connectionVendors(stillAdmin, triage.id)).toEqual([VENDOR]);
  expect((await stillAdmin.getIssueReport(report.id)).entries).toEqual([]);

  await harness.redeployWorkshop(withAdmins());
  const restored = await signedInAgain(suite, owner);
  const again = suite.scope.use(await restored.api.openWorkspace(triage.id));
  const back = await agentTurn(restored, again, read, { chatId: cut.chatId });
  expect(await back.results())
      .toEqual({ users: { value: expect.objectContaining({ users: [expect.anything()] }) } });
  await again.approveAction(note!.id);
  await waitFor("the paused turn to end", async () => paused.script.done() || null);
  const restoredAdmin = await adminApiOf(suite, restored);
  expect((await restoredAdmin.getIssueReport(report.id)).entries.map(entry => entry.text))
      .toEqual(["Held while demoted"]);
});
