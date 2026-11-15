import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_WRITE_ERROR_CODES, getAdminAccessErrorCode,
  getAdminWriteErrorCode,
  type AdminApi, type AdminAuditRecord, type AdminPasskeyChallenge, type AdminWorkspaceView,
  type AuthenticatedApi,
} from "@gadgets/workshop-shared/api";
import { softwareAuthenticator } from "../../workshop-backend/__tests__/software-authenticator.js";
import { ADMIN_USERNAME, startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";

// An admin whom the redeploy removes from ADMINS.
const DEMOTED_USERNAME = "demoted";
const REASON = "Bounds check";

// The environment bounds are read at startup and the redeploy restarts every Worker, so this file
// owns its harness, runs serially, and its cases run in order.
const network = new NetworkInterceptor();
const fileScope = new DisposableStack();
let harness: Harness;
let admin: RpcStub<AdminApi>;
let demotedApi: RpcStub<AuthenticatedApi>;
let demotedView: RpcStub<AdminWorkspaceView>;
let workspaceId: string;

async function adminApiOf(api: RpcStub<AuthenticatedApi>): Promise<RpcStub<AdminApi>> {
  const stub = await api.getAdminApi();
  if (stub === null) throw new Error("The admin API was unavailable");
  return fileScope.use(stub);
}

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [],
    patchWorkshop: config => {
      config.vars = { ...config.vars, ADMINS: [ADMIN_USERNAME, DEMOTED_USERNAME] };
    },
  });
  admin = await adminApiOf(
      fileScope.use(await signUp(fileScope.use(connect(harness.url)), ADMIN_USERNAME)));
  demotedApi = fileScope.use(await signUp(fileScope.use(connect(harness.url)), DEMOTED_USERNAME));
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

/**
 * Logs `username` in once the Workshop answers again. A redeploy restarts every Worker, ending
 * every session open at the time. The session is disposed with `stack`.
 */
function logInAfresh(stack: DisposableStack, username: string)
    : Promise<RpcStub<AuthenticatedApi>> {
  return waitFor(`${username} to log in again`, async () => {
    try {
      return stack.use(await logIn(stack.use(connect(harness.url)), username));
    } catch {
      return null;
    }
  });
}

/** The newest record of the deployment-wide audit log of `kind`, if any. */
async function newest(api: RpcStub<AdminApi>, kind: AdminAuditRecord["kind"])
    : Promise<AdminAuditRecord | undefined> {
  return (await api.listAdminAudit({ kind, limit: 1 })).records[0];
}

it("holds the admins' choices within the deployment's defaults", async () => {
  const settings = await admin.getSettings();
  expect(settings.adminWorkspaceAccess)
      .toEqual({ effective: "metadata", chosen: "metadata", max: "metadata" });
  expect(settings.adminAuditRetentionDays).toEqual({ effective: 90, chosen: 90, min: 90 });
  expect(settings.issueReportRetentionDays).toEqual({ effective: 90, chosen: 90, min: 90 });

  const before = await newest(admin, "setting");
  // Not a level, so the setter refuses it as a value of the wrong type, whatever the bound.
  await expect(admin.setAdminWorkspaceAccess("full" as never)).rejects.toThrow(TypeError);
  // A level, but above the cap an unset ADMIN_WORKSPACE_ACCESS_MAX gives.
  await expect(admin.setAdminWorkspaceAccess("content"))
      .rejects.toThrow(/ADMIN_WORKSPACE_ACCESS_MAX/);
  await expect(admin.setAdminAuditRetentionDays(89))
      .rejects.toThrow(/ADMIN_AUDIT_RETENTION_MIN_DAYS/);
  // Issue reports have a floor of their own, of the same kind.
  await expect(admin.setIssueReportRetentionDays(89))
      .rejects.toThrow(/ISSUE_REPORT_RETENTION_MIN_DAYS/);
  await expect(admin.setIssueReportRetentionDays(3651)).rejects.toThrow();
  expect(await newest(admin, "setting")).toEqual(before);

  // Above the floor an admin chooses, and the choice is recorded as any setting is.
  try {
    await admin.setIssueReportRetentionDays(180);
    expect((await admin.getSettings()).issueReportRetentionDays)
        .toEqual({ effective: 180, chosen: 180, min: 90 });
    expect(await newest(admin, "setting")).toMatchObject({
      kind: "setting", admin: ADMIN_USERNAME, method: "setIssueReportRetentionDays",
      changes: [{ setting: "issueReportRetentionDays", before: "90", after: "180" }],
    });
  } finally {
    await admin.setIssueReportRetentionDays(90);
  }

  try {
    await admin.setAdminWorkspaceAccess("off");
    expect((await admin.getSettings()).adminWorkspaceAccess)
        .toEqual({ effective: "off", chosen: "off", max: "metadata" });
  } finally {
    await admin.setAdminWorkspaceAccess("metadata");
  }
});

it("lets an admin inspect another user's workspace", async () => {
  const [ownerName] = nextUsernames("boundsowner");
  using ownerPublic = connect(harness.url);
  using owner = await signUp(ownerPublic, ownerName!);
  using ws = await owner.newWorkspace();
  workspaceId = (await ws.getMetadata()).id;

  const demoted = await adminApiOf(demotedApi);
  demotedView = fileScope.use(await demoted.inspectWorkspace(workspaceId, REASON));
  const description = await demotedView.describe();
  expect(description).toMatchObject({ id: workspaceId, access: "metadata", grants: [] });
});

/**
 * Expects `api` to refuse every write-request and passkey method as a deployment without
 * ADMIN_WORKSPACE_WRITES "on" does, recording nothing. Listing and removal still answer, so that
 * a passkey enrolled while writes were on can be seen and removed; here none ever was.
 */
async function expectWritesOff(api: RpcStub<AdminApi>): Promise<void> {
  expect((await api.getSettings()).adminWorkspaceWrites).toBe(false);

  // Answers that are well formed, to a challenge no server issued.
  const authenticator = await softwareAuthenticator({ origin: "http://workshop.test" });
  const unissued: AdminPasskeyChallenge = {
    challenge: "AAAA", rpId: "workshop.test", credentialIds: [], expiresAt: new Date(0),
  };
  const registration = await authenticator.register(unissued);
  const assertion = await authenticator.assert(unissued);
  const noRequest = crypto.randomUUID();

  const before = (await api.listAdminAudit({ limit: 1 })).records;
  const refused: [string, () => PromiseLike<unknown>][] = [
    ["requestWorkspaceWrite",
      () => api.requestWorkspaceWrite(workspaceId, "restartWorkspace", {}, REASON)],
    ["getWorkspaceWrite", () => api.getWorkspaceWrite(noRequest)],
    ["denyWorkspaceWrite", () => api.denyWorkspaceWrite(noRequest)],
    ["beginWorkspaceWriteApproval", () => api.beginWorkspaceWriteApproval(noRequest)],
    ["approveWorkspaceWrite", () => api.approveWorkspaceWrite(noRequest, assertion)],
    ["beginAdminPasskeyEnrolment", () => api.beginAdminPasskeyEnrolment()],
    ["addAdminPasskey", () => api.addAdminPasskey("Laptop", registration)],
  ];
  for (const [method, call] of refused) {
    const code = await call().then(() => null, getAdminWriteErrorCode);
    expect(code, method).toBe(ADMIN_WRITE_ERROR_CODES.writesOff);
  }

  expect(await api.listAdminPasskeys()).toEqual([]);
  // No passkey was ever enrolled here, so no ceremony is checked: the id names none.
  await expect(api.beginAdminPasskeyRemoval("nope")).rejects.toThrow("You have no such passkey.");
  await expect(api.removeAdminPasskey("nope", assertion))
      .rejects.toThrow("You have no such passkey.");
  expect((await api.listAdminAudit({ limit: 1 })).records).toEqual(before);
}

it("refuses writes to workspaces while ADMIN_WORKSPACE_WRITES is unset", async () => {
  await expectWritesOff(admin);
});

it("applies a redeploy's tighter bounds and demotion", async () => {
  await harness.redeployWorkshop(config => {
    config.vars = {
      ...config.vars,
      ADMINS: [ADMIN_USERNAME],
      ADMIN_AUDIT_RETENTION_MIN_DAYS: "120",
      ISSUE_REPORT_RETENTION_MIN_DAYS: "150",
      // Not a level, so the cap must fail closed to "off".
      ADMIN_WORKSPACE_ACCESS_MAX: "full",
      // Not "on", so writes must fail closed to off.
      ADMIN_WORKSPACE_WRITES: "true",
    };
  });

  using stack = new DisposableStack();

  // No session survives an ADMINS change, so the old view fails here because its session ended.
  // The per-call re-check that stops a live view once its admin is demoted is covered by the
  // Overseer's unit suite.
  const demoted = await logInAfresh(stack, DEMOTED_USERNAME);
  expect(await demoted.getAdminApi()).toBeNull();
  expect(await demoted.amIAdmin()).toBe(false);
  await expect(demotedView.describe()).rejects.toThrow();

  const adminApi = await logInAfresh(stack, ADMIN_USERNAME);
  const fresh = await adminApi.getAdminApi();
  if (fresh === null) throw new Error("The admin API was unavailable after the redeploy");
  stack.use(fresh);
  const settings = await fresh.getSettings();
  expect(settings.adminAuditRetentionDays).toEqual({ effective: 120, chosen: 90, min: 120 });
  // Each floor holds its own retention: the admins' choice stays stored, below what is enforced.
  expect(settings.issueReportRetentionDays).toEqual({ effective: 150, chosen: 90, min: 150 });
  await expect(fresh.setIssueReportRetentionDays(149))
      .rejects.toThrow(/ISSUE_REPORT_RETENTION_MIN_DAYS/);
  expect(settings.adminWorkspaceAccess)
      .toEqual({ effective: "off", chosen: "metadata", max: "off" });
  await expect(fresh.setAdminWorkspaceAccess("metadata"))
      .rejects.toThrow(/ADMIN_WORKSPACE_ACCESS_MAX/);

  let code: string | undefined;
  try {
    stack.use(await fresh.inspectWorkspace(workspaceId, REASON));
  } catch (error) {
    code = getAdminAccessErrorCode(error);
  }
  expect(code).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
  expect(await newest(fresh, "workspace")).toMatchObject({
    kind: "workspace", workspaceId, admin: ADMIN_USERNAME, method: "inspectWorkspace",
    reason: REASON, access: "off", refused: ADMIN_ACCESS_ERROR_CODES.accessOff,
  });

  const demotedRecords = (await fresh.listAdminAudit({ admin: DEMOTED_USERNAME })).records;
  expect(demotedRecords.map(record => record.kind === "workspace" && record.method))
      .toEqual(["describe", "inspectWorkspace"]);

  await expectWritesOff(fresh);
});

it("lets an admin choose content once a redeploy raises the cap to it", async () => {
  await harness.redeployWorkshop(config => {
    config.vars = {
      ...config.vars, ADMINS: [ADMIN_USERNAME], ADMIN_WORKSPACE_ACCESS_MAX: "content",
    };
  });

  using stack = new DisposableStack();
  const adminApi = await logInAfresh(stack, ADMIN_USERNAME);
  const fresh = await adminApi.getAdminApi();
  if (fresh === null) throw new Error("The admin API was unavailable after the redeploy");
  stack.use(fresh);
  const publicApi = stack.use(connect(harness.url));

  // The cap alone grants nothing: content stays off until an admin picks it.
  expect((await fresh.getSettings()).adminWorkspaceAccess)
      .toEqual({ effective: "metadata", chosen: "metadata", max: "content" });
  expect(await publicApi.getServerConfig()).not.toHaveProperty("adminContentGrants");

  await fresh.setAdminWorkspaceAccess("content");
  expect((await fresh.getSettings()).adminWorkspaceAccess)
      .toEqual({ effective: "content", chosen: "content", max: "content" });
  expect(await newest(fresh, "setting")).toMatchObject({
    kind: "setting", admin: ADMIN_USERNAME, method: "setAdminWorkspaceAccess",
    changes: [{ setting: "adminWorkspaceAccess", before: "metadata", after: "content" }],
  });
  // What a client that has not signed in reads of it: that a content grant can be given.
  expect((await publicApi.getServerConfig()).adminContentGrants).toBe(true);

  await fresh.setAdminWorkspaceAccess("metadata");
  expect(await publicApi.getServerConfig()).not.toHaveProperty("adminContentGrants");
});
