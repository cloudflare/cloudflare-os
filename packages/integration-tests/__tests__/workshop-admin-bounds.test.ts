import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AdminApi, type AdminAuditRecord, type AuthenticatedApi,
} from "@gadgets/workshop-shared/api";
import { ADMIN_USERNAME, startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, signUp, waitFor } from "../src/rpc-client.js";

// An admin whom the redeploy removes from ADMINS.
const DEMOTED_USERNAME = "demoted";

// The environment's bound is read at startup and the redeploy restarts every Worker, so this file
// owns its harness, runs serially, and its cases run in order.
const network = new NetworkInterceptor();
const fileScope = new DisposableStack();
let harness: Harness;
let admin: RpcStub<AdminApi>;
let demotedApi: RpcStub<AuthenticatedApi>;

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

it("holds the admins' choice within the deployment's default", async () => {
  const settings = await admin.getSettings();
  expect(settings.adminAuditRetentionDays).toEqual({ effective: 90, chosen: 90, min: 90 });

  const before = await newest(admin, "setting");
  await expect(admin.setAdminAuditRetentionDays(89))
      .rejects.toThrow(/ADMIN_AUDIT_RETENTION_MIN_DAYS/);
  expect(await newest(admin, "setting")).toEqual(before);
});

it("keeps a demoted admin's records", async () => {
  const demoted = await adminApiOf(demotedApi);
  await demoted.setSiteName("Bounds check");
  expect(await newest(admin, "setting")).toMatchObject(
      { kind: "setting", admin: DEMOTED_USERNAME, method: "setSiteName" });
});

it("applies a redeploy's raised minimum and demotion", async () => {
  await harness.redeployWorkshop(config => {
    config.vars = { ...config.vars, ADMINS: [ADMIN_USERNAME], ADMIN_AUDIT_RETENTION_MIN_DAYS: "120" };
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

  const demoted = await logInAfresh(DEMOTED_USERNAME);
  expect(await demoted.getAdminApi()).toBeNull();
  expect(await demoted.amIAdmin()).toBe(false);

  const adminApi = await logInAfresh(ADMIN_USERNAME);
  const fresh = await adminApi.getAdminApi();
  if (fresh === null) throw new Error("The admin API was unavailable after the redeploy");
  stack.use(fresh);
  expect((await fresh.getSettings()).adminAuditRetentionDays)
      .toEqual({ effective: 120, chosen: 90, min: 120 });

  const demotedRecords = (await fresh.listAdminAudit({ admin: DEMOTED_USERNAME })).records;
  expect(demotedRecords.map(record => record.method)).toEqual(["setSiteName"]);
});
