import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, createAdminAccessError, type AdminApi,
} from "@gadgets/workshop-shared/api";
import type { Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import type { ConnectedAccount } from "../src/rpc-client.js";
import {
  addAdminConnection, adminAccounts, adminApiOf, agentTurn, auditRecords, collaboratorIds,
  connectAdminAccount, connectionVendors, DEPLOYMENT_URL, GRACE, HEIDI, isRestricted, newMember,
  newUser, newWorkspace, observationTitles, observerStep, openAs, opening, OWNER, signedInAgain, startAdminHarness,
  turnModels, VENDOR, withAdmins, type Suite, type SuiteUser,
} from "./admin-gatekeeper-harness.js";

// The real admin gatekeeper beside the Workshop: who is offered it and can connect it, what an
// agent reads through its connection and how each read is recorded, who may open a workspace
// that has read through it, and what ends a connection.
//
// The deployment's admins and its audit log are deployment-wide, so this file owns its harness
// and its cases run in order: the second leaves the owner with an account, which the rest use.
const models = turnModels();
const network = new NetworkInterceptor({ handlers: [models.handler] });
const scope = new DisposableStack();
let harness: Harness;
let suite: Suite;
let owner: SuiteUser;
let grace: SuiteUser;
let heidi: SuiteUser;
let admin: RpcStub<AdminApi>;
// The owner's account of the vendor, connected in the second case.
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

const NOT_ADMIN = createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.notAdmin).message;
const ADMINS_ONLY = "Only a deployment admin can connect the admin gatekeeper.";
const NOT_CONNECTED = "This deployment admin account is no longer connected.";
/** How an open ends for a collaborator who answers the observer step with no account. */
const NO_ACCOUNT = {
  asked: [VENDOR],
  outcome: "You must connect an account for every service this workspace uses in order to open it.",
};

/** The ids of the vendors a listing names. */
const vendorIds = (vendors: { id: string }[]) => vendors.map(vendor => vendor.id);

/** A turn's code that lists one user through the connection. */
const READ = `await attempt("users", () => env.ADMIN.listUsers({ limit: 1 }));`;
/** What READ records when the read is answered. */
const ANSWERED = { users: { value: expect.objectContaining({ users: [expect.anything()] }) } };

it("offers the gatekeeper to deployment admins, and hands a non-admin's connect flow nothing",
    async () => {
  const offered = (await owner.api.listGatekeeperVendors()).find(vendor => vendor.id === VENDOR);
  expect(offered?.supportedResources.map(resource => resource.urlPattern)).toEqual([DEPLOYMENT_URL]);
  // It is a connector like any other on the admin page, on unless an admin turns it off.
  const { resourceVendors } = await admin.getSettings();
  expect(resourceVendors.find(vendor => vendor.vendorId === VENDOR))
      .toMatchObject({ autoProvisions: false, enabled: true });

  const outsider = await newMember(suite, "outsider");
  expect(vendorIds(await outsider.api.listGatekeeperVendors())).not.toContain(VENDOR);
  // The Workshop hands the gatekeeper no Admin API for them, so it starts no connection.
  await expect(outsider.api.connectAccount(VENDOR)).rejects.toThrow(ADMINS_ONLY);
  expect(await adminAccounts(outsider.api)).toEqual([]);

  const { ws } = await newWorkspace(suite, outsider, "An outsider's workspace");
  const turn = await agentTurn(outsider, ws, `out.admin = { value: typeof env.ADMIN };`);
  expect(await turn.results()).toEqual({ admin: { value: "undefined" } });

  // An admin turns it off for the deployment as any connector is turned off.
  await admin.setGatekeeperMode(VENDOR, "disabled");
  try {
    expect(vendorIds(await owner.api.listGatekeeperVendors())).not.toContain(VENDOR);
    await expect(owner.api.connectAccount(VENDOR)).rejects.toThrow("is disabled on this deployment");
  } finally {
    await admin.setGatekeeperMode(VENDOR, "enabled");
  }
  expect(vendorIds(await owner.api.listGatekeeperVendors())).toContain(VENDOR);
});

it("lets an admin connect it, add the connection and read through it, each read recorded",
    async () => {
  expect(await adminAccounts(owner.api)).toEqual([]);
  ownerAccount = await connectAdminAccount(suite, owner);
  expect(ownerAccount.description.displayName).toBe("Deployment admin");
  // Connecting again is the same identity: the Workshop keeps the first account and drops the new.
  await connectAdminAccount(suite, owner);
  expect((await adminAccounts(owner.api)).map(account => account.id)).toEqual([ownerAccount.id]);

  const subject = await newMember(suite, "subject");
  const theirs = await newWorkspace(suite, subject, "A user's workspace");
  await theirs.ws.newChat("hello", null);
  const triage = await newWorkspace(suite, owner, "Triage reads");
  const notes = await newWorkspace(suite, owner, "Notes");

  // Nothing injects it: the connection goes to the workspace it was added to.
  const connection = await addAdminConnection(triage.ws, ownerAccount.id);
  expect(await connectionVendors(admin, triage.id)).toContain(VENDOR);
  expect(await connectionVendors(admin, notes.id)).not.toContain(VENDOR);
  expect(await isRestricted(triage.ws)).toBe(false);
  expect(await observationTitles(triage.ws)).toEqual([]);

  const turn = await agentTurn(owner, triage.ws, `
    ${READ}
    await attempt("view", async () => {
      const view = await env.ADMIN.inspectWorkspace(
          ${JSON.stringify(theirs.id)}, "Looking into a report");
      return { id: (await view.describe()).id, chats: (await view.listChats()).length };
    });
    await attempt("account", async () => {
      const view = await env.ADMIN.inspectUser(${JSON.stringify(subject.name)}, "Looking");
      return (await view.describe()).profile.id;
    });`, { connection });
  expect(await turn.results()).toEqual({
    ...ANSWERED,
    view: { value: { id: theirs.id, chats: 1 } },
    account: { value: subject.name },
  });

  // The view's open and its calls are recorded as the connecting admin's, made through the
  // gatekeeper; a listing is read with no record in the audit log.
  const records = await auditRecords(admin, { workspace: theirs.id });
  expect(records.map(record => record.method)).toEqual(["listChats", "describe", "inspectWorkspace"]);
  for (const record of records) {
    expect(record).toMatchObject({ kind: "workspace", admin: OWNER, via: "gatekeeper" });
  }
  const accountCalls = await auditRecords(admin, { kind: "user", owner: subject.name });
  expect(accountCalls.map(record => record.method).toSorted()).toEqual(["describe", "inspectUser"]);
  for (const record of accountCalls) {
    expect(record).toMatchObject({ kind: "user", admin: OWNER, via: "gatekeeper" });
  }

  // Each read, the unrecorded ones included, is an observation of the workspace that made it,
  // and the first marked it as holding restricted data.
  expect((await observationTitles(triage.ws)).toReversed()).toEqual([
    "Admin API: listUsers", "Admin API: inspectWorkspace", "Admin view: describe",
    "Admin view: listChats", "Admin API: inspectUser", "Admin view: describe",
  ]);
  expect(await isRestricted(triage.ws)).toBe(true);
  expect(await isRestricted(notes.ws)).toBe(false);
});

it("refuses the methods an agent is not given, and changes nothing", async () => {
  // Each call below is one the Admin API would carry out for the owner. So what is unchanged
  // afterwards is unchanged because the call went nowhere.
  const { siteName, signupsEnabled } = await admin.getSettings();
  const settingRecords = (await auditRecords(admin, { kind: "setting" })).length;
  const triage = await newWorkspace(suite, owner, "Triage omitted");
  const connection = await addAdminConnection(triage.ws, ownerAccount.id);

  const turn = await agentTurn(owner, triage.ws, `
    await attempt("setSiteName", () => env.ADMIN.setSiteName("Renamed by an agent"));
    await attempt("setSignupsEnabled", () => env.ADMIN.setSignupsEnabled(${!signupsEnabled}));
    await attempt("approveContentAccess", () => env.ADMIN.approveContentAccess("request-1"));
    await attempt("getUpdateStatus", () => env.ADMIN.getUpdateStatus());`, { connection });
  const results = await turn.results();
  expect(Object.keys(results)).toEqual(
      ["setSiteName", "setSignupsEnabled", "approveContentAccess", "getUpdateStatus"]);
  for (const [name, attempt] of Object.entries(results)) {
    expect(attempt, name).toEqual(
        { error: `The RPC receiver does not implement the method "${name}".` });
  }

  expect(await admin.getSettings()).toMatchObject({ siteName, signupsEnabled });
  expect(await auditRecords(admin, { kind: "setting" })).toHaveLength(settingRecords);
  // A call that reached nothing observed nothing.
  expect(await observationTitles(triage.ws)).toEqual([]);
  expect(await isRestricted(triage.ws)).toBe(false);
});

it("opens a workspace that has the connection only to collaborators with an account of their own",
    async () => {
  const triage = await newWorkspace(suite, owner, "Triage desk");
  const { ws } = triage;
  const builder = await newMember(suite, "builder");
  expect(await ws.addCollaborator(builder.name, "workspace")).not.toBeNull();
  expect(await ws.addCollaborator(GRACE, "workspace")).not.toBeNull();
  expect(await ws.addCollaborator(HEIDI, "workspace")).not.toBeNull();
  expect(await opening(suite, builder, triage.id)).toBe("opened");

  const connection = await addAdminConnection(ws, ownerAccount.id);
  await agentTurn(owner, ws, READ, { connection });
  expect(await isRestricted(ws)).toBe(true);

  // The observer check asks each collaborator for an account of this vendor. Someone who is not
  // a deployment admin has none and can connect none, so the workspace does not open for them.
  expect(await adminAccounts(builder.api)).toEqual([]);
  expect(await observerStep(suite, builder, triage.id)).toEqual(NO_ACCOUNT);
  // Nor for an admin who has not connected the gatekeeper herself.
  expect(await observerStep(suite, heidi, triage.id)).toEqual(NO_ACCOUNT);

  // A second admin opens it once she answers the step with an account of her own.
  const graceAccount = await connectAdminAccount(suite, grace);
  expect(await observerStep(suite, grace, triage.id)).toEqual(NO_ACCOUNT);
  using graceWs = await openAs(suite, grace, triage.id, { accountId: graceAccount.id });
  expect(await collaboratorIds(ws)).toEqual(expect.arrayContaining([builder.name, GRACE, HEIDI]));

  // Her agent's calls through the connection are made as the admin whose account it was added
  // from, whoever's agent makes them.
  const turn = await agentTurn(grace, graceWs, `
    await attempt("view", async () => {
      const view = await env.ADMIN.inspectWorkspace(${JSON.stringify(triage.id)}, "Looking");
      return (await view.describe()).id;
    });`, { connection });
  expect(await turn.results()).toEqual({ view: { value: triage.id } });
  const [described] = await auditRecords(admin, { workspace: triage.id, method: "describe" });
  expect(described).toMatchObject({ admin: OWNER, via: "gatekeeper" });
});

it("ends every connection made with an account when its admin disconnects it", async () => {
  const account = await connectAdminAccount(suite, heidi);
  const desk = await newWorkspace(suite, heidi, "Heidi's desk");
  const connection = await addAdminConnection(desk.ws, account.id);
  const first = await agentTurn(heidi, desk.ws, READ, { connection });
  expect(await first.results()).toEqual(ANSWERED);
  // A session opened from the connection before the account is removed.
  using session = await connection.client.openSession() as RpcStub<AdminApi>;
  expect((await session.listUsers({ limit: 1 })).users).toHaveLength(1);

  await heidi.api.disconnectAccount(account.id);
  expect(await adminAccounts(heidi.api)).toEqual([]);
  // The session that was already open reads nothing more.
  await expect(session.listUsers({ limit: 1 })).rejects.toThrow(NOT_CONNECTED);

  const cut = await agentTurn(heidi, desk.ws, READ, { chatId: first.chatId });
  expect(await cut.results()).toEqual({ users: { error: expect.stringContaining(NOT_CONNECTED) } });
  // The owner's account, and the connections made with it, are untouched.
  expect(await adminAccounts(owner.api)).toHaveLength(1);
});

// Last: each redeploy ends every session the cases above opened.
it("refuses a demoted admin's next read and a demoted collaborator's open, and answers again " +
    "once they are admins again", async () => {
  const triage = await newWorkspace(suite, owner, "Triage, demoted");
  expect(await triage.ws.addCollaborator(GRACE, "workspace")).not.toBeNull();
  const connection = await addAdminConnection(triage.ws, ownerAccount.id);
  const first = await agentTurn(owner, triage.ws, READ, { connection });
  expect(await first.results()).toEqual(ANSWERED);
  const [graceAccount] = await adminAccounts(grace.api);
  expect(await opening(suite, grace, triage.id, { accountId: graceAccount!.id })).toBe("opened");

  await harness.redeployWorkshop(withAdmins([HEIDI]));
  const demoted = await signedInAgain(suite, owner);
  expect(await demoted.api.getAdminApi()).toBeNull();
  expect(vendorIds(await demoted.api.listGatekeeperVendors())).not.toContain(VENDOR);
  // The account still holds its grant, which opens nothing for someone who is no admin now.
  const ws = suite.scope.use(await demoted.api.openWorkspace(triage.id));
  const cut = await agentTurn(demoted, ws, READ, { chatId: first.chatId });
  expect(await cut.results()).toEqual({ users: { error: expect.stringContaining(NOT_ADMIN) } });
  // A collaborator demoted with them still has her account, which no longer vouches for her.
  const demotedGrace = await signedInAgain(suite, grace);
  expect(await opening(suite, demotedGrace, triage.id, { accountId: graceAccount!.id }))
      .toContain("could not confirm that you are permitted to observe all of the data");

  await harness.redeployWorkshop(withAdmins());
  const restored = await signedInAgain(suite, owner);
  const again = suite.scope.use(await restored.api.openWorkspace(triage.id));
  const answered = await agentTurn(restored, again, READ, { chatId: first.chatId });
  expect(await answered.results()).toEqual(ANSWERED);
  expect(await opening(suite, await signedInAgain(suite, grace), triage.id,
      { accountId: graceAccount!.id })).toBe("opened");
});
