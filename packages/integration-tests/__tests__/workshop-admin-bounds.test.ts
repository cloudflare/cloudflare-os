import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, getAdminAccessErrorCode,
  type AdminApi, type AdminAuditRecord, type AdminWorkspaceView, type AuthenticatedApi,
} from "@gadgets/workshop-shared/api";
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

  const before = await newest(admin, "setting");
  await expect(admin.setAdminWorkspaceAccess("full")).rejects.toThrow(/ADMIN_WORKSPACE_ACCESS_MAX/);
  await expect(admin.setAdminAuditRetentionDays(89))
      .rejects.toThrow(/ADMIN_AUDIT_RETENTION_MIN_DAYS/);
  expect(await newest(admin, "setting")).toEqual(before);

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
  expect(await demotedView.describe()).toMatchObject({ id: workspaceId, access: "metadata" });
});

it("applies a redeploy's tighter bounds and demotion", async () => {
  await harness.redeployWorkshop(config => {
    config.vars = {
      ...config.vars,
      ADMINS: [ADMIN_USERNAME],
      ADMIN_AUDIT_RETENTION_MIN_DAYS: "120",
      // Not a level, so the cap must fail closed to "off".
      ADMIN_WORKSPACE_ACCESS_MAX: "none",
    };
  });

  // The redeploy restarts every Worker, ending every session open at the time.
  using stack = new DisposableStack();
  const logInAfresh = (username: string) => waitFor(`${username} to log in again`, async () => {
    try {
      return stack.use(await logIn(stack.use(connect(harness.url)), username));
    } catch {
      return null;
    }
  });

  // No session survives an ADMINS change, so the old view fails here because its session ended.
  // The per-call re-check that stops a live view once its admin is demoted is covered by the
  // Overseer's unit suite.
  const demoted = await logInAfresh(DEMOTED_USERNAME);
  expect(await demoted.getAdminApi()).toBeNull();
  expect(await demoted.amIAdmin()).toBe(false);
  await expect(demotedView.describe()).rejects.toThrow();

  const adminApi = await logInAfresh(ADMIN_USERNAME);
  const fresh = await adminApi.getAdminApi();
  if (fresh === null) throw new Error("The admin API was unavailable after the redeploy");
  stack.use(fresh);
  const settings = await fresh.getSettings();
  expect(settings.adminAuditRetentionDays).toEqual({ effective: 120, chosen: 90, min: 120 });
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
});
