import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ADMIN_AGENT_LEND_SECONDS } from "@gadgets/workshop-shared/admin-agent";
import {
  ADMIN_ACCESS_ERROR_CODES, createAdminAccessError, OPEN_WORKSPACE_ERROR_CODES, type AdminApi,
  type Overseer,
} from "@gadgets/workshop-shared/api";
import type { Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, waitFor, type ConnectedAccount } from "../src/rpc-client.js";
import {
  ACCOUNT_REMOVED, addAdminConnection, adminAccounts, adminApiOf, agentTurn, auditCount,
  auditRecords, buildGadget, collaboratorIds, connectionVendors, DEPLOYMENT_URL, gadgetIds, GRACE,
  HAS_CONNECTION, HAS_READ, HEIDI, isRestricted, newMember, newUser, newWorkspace,
  observationTitles, openAs, opening, OWNER, provisionAdminAccount, reconnect, signedInAgain,
  startAdminHarness, turnModels, VENDOR, withAdmins, type AdminConnection, type Suite,
  type SuiteUser,
} from "./admin-gatekeeper-harness.js";

// Who is offered the admin gatekeeper, where its connection goes, what an agent reads through
// it and how each read is recorded, and who is admitted to a workspace that has it.
//
// The vendor's mode and the audit log are deployment-wide, so this file owns its harness and its
// cases run in order: the first two leave the vendor's mode "optional" and the owner with an
// account, which the rest use.
const models = turnModels();
const network = new NetworkInterceptor({ handlers: [models.handler] });
const scope = new DisposableStack();
let harness: Harness;
let suite: Suite;
let owner: SuiteUser;
let grace: SuiteUser;
let heidi: SuiteUser;
let admin: RpcStub<AdminApi>;
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

const { workspaceAccessDenied } = OPEN_WORKSPACE_ERROR_CODES;
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
  const triage = await newWorkspace(suite, owner, "Triage reads");
  const connection = await addAdminConnection(triage.ws, ownerAccount.id);
  expect(await isRestricted(triage.ws)).toBe(false);
  expect(await observationTitles(triage.ws)).toEqual([]);

  const before = await auditCount(harness);
  const turn = await agentTurn(owner, triage.ws, `
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
    users: { value: { users: [expect.anything()] } },
    view: { value: { chats: 1 } },
  });

  // The view's open and its two calls are the turn's only records: a listing is read with no
  // record in the audit log.
  expect(await auditCount(harness)).toBe(before + 3);
  const records = await auditRecords(admin, { workspace: theirs.id });
  expect(records.map(record => record.method)).toEqual(["listChats", "describe", "inspectWorkspace"]);
  for (const record of records) {
    expect(record).toMatchObject({
      kind: "workspace", admin: OWNER, via: "gatekeeper",
      agent: { workspaceId: triage.id, chatId: turn.chatId },
    });
  }

  // Each read, the unrecorded ones included, is an observation of the workspace that made it.
  expect((await observationTitles(triage.ws)).toReversed()).toEqual([
    "Admin API: listUsers", "Admin API: inspectWorkspace", "Admin view: describe",
    "Admin view: listChats",
  ]);
  expect(await isRestricted(triage.ws)).toBe(true);

  // A view does not outlive the lend that opened it, whatever lifetime the agent asked for: the
  // lend began before the turn ended, and the seconds a view is given are rounded up.
  const { expiresAt } = results.view!.value as { expiresAt: string };
  expect(new Date(expiresAt).getTime())
      .toBeLessThanOrEqual(ended + (ADMIN_AGENT_LEND_SECONDS + 1) * 1000);
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

/** What an RPC stub answers for a method its target does not have. */
const notImplemented = (method: string) =>
  ({ error: `The RPC receiver does not implement the method "${method}".` });

it("refuses the methods an agent is not given, and changes nothing", async () => {
  // Each call below is one the Admin API would carry out for the owner: a name to set and a
  // switch to flip. So what is unchanged afterwards is unchanged because the call went nowhere.
  const { siteName, signupsEnabled } = await admin.getSettings();
  const triage = await newWorkspace(suite, owner, "Triage omitted");
  const connection = await addAdminConnection(triage.ws, ownerAccount.id);

  // Called, not looked up: every name on a stub is callable, so only the call's end tells.
  const turn = await agentTurn(owner, triage.ws, `
    await attempt("setSiteName", () => env.ADMIN.setSiteName("Renamed by an agent"));
    await attempt("setSignupsEnabled", () => env.ADMIN.setSignupsEnabled(${!signupsEnabled}));
    await attempt("getUpdateStatus", () => env.ADMIN.getUpdateStatus());`, { connection });
  expect(await turn.results()).toEqual({
    setSiteName: notImplemented("setSiteName"),
    setSignupsEnabled: notImplemented("setSignupsEnabled"),
    getUpdateStatus: notImplemented("getUpdateStatus"),
  });

  expect(await admin.getSettings()).toMatchObject({ siteName, signupsEnabled });
  // A call that is refused observes nothing, so it marks nothing.
  expect(await observationTitles(triage.ws)).toEqual([]);
  expect(await isRestricted(triage.ws)).toBe(false);
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
  const [nell, visitor] = [await newMember(suite, "nell"), await newMember(suite, "passerby")];
  const triage = await newWorkspace(suite, owner, "Triage, never read");
  const { ws } = triage;
  // Shared before it has the connection, and never invited again.
  expect(await ws.addCollaborator(nell.name, "workspace")).not.toBeNull();
  expect(await opening(suite, nell, triage.id)).toBe("opened");
  const link = await ws.createShareLink("workspace");
  const connection = await addAdminConnection(ws, ownerAccount.id);
  expect(await ws.addCollaborator(GRACE, "workspace")).not.toBeNull();
  using graceWs = await openAs(
      suite, grace, triage.id, { accountId: (await provisionAdminAccount(grace)).id });

  // Two reads refused before anything is lent: a member's own session, and a turn run while
  // the vendor is off. Neither reads anything through the binding.
  await expect(directRead(graceWs, connection)).rejects.toThrow(DIRECT_OWNER_ONLY);
  await admin.setGatekeeperMode(VENDOR, "disabled");
  try {
    const off = await agentTurn(owner, ws,
        `await attempt("users", () => env.ADMIN.listUsers());`, { connection });
    expect(await off.results()).toEqual({ users: { error: "Gatekeeper is disabled." } });
  } finally {
    await admin.setGatekeeperMode(VENDOR, "optional");
  }
  expect((await observationTitles(ws)).filter(title => title.startsWith("Admin API:"))).toEqual([]);
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

it("stays admins-only for good once it has read through the connection, removed or not", async () => {
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
      `await attempt("users", () => env.ADMIN.listUsers({ limit: 1 }));`, { connection });
  expect(await turn.results()).toMatchObject({ users: { value: { users: [expect.anything()] } } });
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
  const subject = await newWorkspace(suite, await newMember(suite, "lookedat"), "Looked at");
  const triage = await newWorkspace(suite, owner, "Triage, account removed");
  const spare = await newWorkspace(suite, owner, "Spare");
  const { ws } = triage;
  const connection = await addAdminConnection(ws, ownerAccount.id);

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

  // No new connection can be made; the connection is still there.
  await expect(spare.ws.newGatekeeper(ownerAccount.id, DEPLOYMENT_URL)).rejects.toThrow();
  expect(await connectionVendors(admin, triage.id)).toEqual([VENDOR]);

  // Added again, the account is another one, and the same connection answers with it.
  const removed = ownerAccount.id;
  ownerAccount = await provisionAdminAccount(owner);
  expect(ownerAccount.id).not.toBe(removed);
  const back = await agentTurn(owner, ws, read, { chatId: cut.chatId });
  expect(await back.results()).toEqual({
    users: { value: expect.objectContaining({ users: [expect.anything()] }) },
    view: { value: subject.id },
  });
});

/** A gadget whose methods show what its admin binding reaches. */
const WATCHER_GADGET = `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async binding() { return typeof this.env.ADMIN; }
  async look(workspaceId) {
    const view = await this.env.ADMIN.inspectWorkspace(workspaceId, "Checking from a gadget");
    return (await view.describe()).id;
  }
}`;

type Watcher = { binding(): string; look(workspaceId: string): string };

/** What fills the blueprint's one binding with the account `accountId`. */
const assignment = (accountId: number) =>
  ({ ADMIN: { type: "gatekeeper" as const, accountId, resourceUrl: DEPLOYMENT_URL } });

it("publishes a blueprint that carries no connection", async () => {
  const subject = await newWorkspace(suite, await newMember(suite, "watched"), "Watched");
  const source = await newWorkspace(suite, owner, "Watcher's source");
  const connection = await addAdminConnection(source.ws, ownerAccount.id);
  const { gadget } = await buildGadget(owner, source.ws,
      { name: "WATCHER", server: WATCHER_GADGET, bindings: { ADMIN: connection.id } });

  const blueprint = await gadget.createBlueprint("Watcher", "Looks at workspaces");
  using publicApi = connect(harness.url);
  const published = await waitFor("the published blueprint", () => publicApi.getBlueprint(blueprint.id));
  // The binding names the vendor and the kind of resource: no account or workspace.
  expect(published.metadata.bindings).toEqual({
    ADMIN: {
      title: "Deployment admin", description: "", type: "gatekeeper", gatekeeperName: VENDOR,
      resourceTypeId: "deployment", typeUrlPattern: DEPLOYMENT_URL,
    },
  });
  expect(JSON.stringify(published.metadata)).not.toContain(source.id);

  // Someone who is not an admin has no account to fill the binding with: left out, their
  // workspace has no connection of the vendor, and the admin's account id names nothing of
  // theirs.
  const outsider = await newMember(suite, "installer");
  await expect(outsider.api.newWorkspaceFromBlueprint(blueprint.id, assignment(ownerAccount.id)))
      .rejects.toThrow("No such account.");
  const bare = suite.scope.use(
      await (await reconnect(suite, outsider)).newWorkspaceFromBlueprint(blueprint.id, {}));
  expect(await connectionVendors(admin, (await bare.getMetadata()).id)).not.toContain(VENDOR);
  using theirs = await bare.getGadget((await gadgetIds(bare))[0]!);
  using theirFacet = await theirs.connectToGadget() as RpcStub<Watcher>;
  expect(await theirFacet.binding()).toBe("undefined");

  // Another admin fills it with her own account: the connection is hers, the workspace is
  // admins-only from that moment, and its calls are recorded as hers.
  const graceAccount = await provisionAdminAccount(grace);
  const installed = suite.scope.use(await (await reconnect(suite, grace)).newWorkspaceFromBlueprint(
      blueprint.id, assignment(graceAccount.id)));
  const { id: installedId } = await installed.getMetadata();
  expect(await connectionVendors(admin, installedId)).toEqual([VENDOR]);
  await expect(installed.addCollaborator(outsider.name, "workspace")).rejects.toThrow(HAS_CONNECTION);

  const [gadgetId] = await gadgetIds(installed);
  using hers = await installed.getGadget(gadgetId!);
  using herFacet = await hers.connectToGadget() as RpcStub<Watcher>;
  expect(await herFacet.look(subject.id)).toBe(subject.id);
  const [described] = await auditRecords(admin, { workspace: subject.id, method: "describe" });
  expect(described).toMatchObject({ admin: GRACE, via: "gatekeeper" });
  expect(described!.kind === "workspace" && described.agent).toEqual({ workspaceId: installedId });
});

// Last: each redeploy ends every session the cases above opened.
it("refuses a demoted owner's connection everything, keeps it, and answers again once they are " +
    "an admin again", async () => {
  const triage = await newWorkspace(suite, owner, "Triage, owner demoted");
  const connection = await addAdminConnection(triage.ws, ownerAccount.id);
  const read = `await attempt("users", () => env.ADMIN.listUsers({ limit: 1 }));`;
  const notAdmin = createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.notAdmin).message;
  const first = await agentTurn(owner, triage.ws, read, { connection });
  expect(await first.results())
      .toEqual({ users: { value: expect.objectContaining({ users: [expect.anything()] }) } });

  await harness.redeployWorkshop(withAdmins([GRACE, HEIDI]));
  const demoted = await signedInAgain(suite, owner);
  expect(await demoted.api.getAdminApi()).toBeNull();
  expect(await adminAccounts(demoted.api)).toEqual([]);
  const ws = suite.scope.use(await demoted.api.openWorkspace(triage.id));
  const cut = await agentTurn(demoted, ws, read, { chatId: first.chatId });
  expect(await cut.results()).toEqual({ users: { error: notAdmin } });
  // The connection is still the workspace's.
  const stillAdmin = await adminApiOf(suite, await signedInAgain(suite, grace));
  expect(await connectionVendors(stillAdmin, triage.id)).toEqual([VENDOR]);

  await harness.redeployWorkshop(withAdmins());
  const restored = await signedInAgain(suite, owner);
  const again = suite.scope.use(await restored.api.openWorkspace(triage.id));
  const back = await agentTurn(restored, again, read, { chatId: cut.chatId });
  expect(await back.results())
      .toEqual({ users: { value: expect.objectContaining({ users: [expect.anything()] }) } });
});
