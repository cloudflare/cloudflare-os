import { createHash } from "node:crypto";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  MAX_ADMIN_AUDIT_VALUE_LENGTH, MAX_SITE_NAME_LENGTH,
  type AdminApi, type AdminAuditKind, type AdminAuditRecord,
  type AdminAuditStats, type AdminSettingRecord, type AuthenticatedApi,
} from "@gadgets/workshop-shared/api";
import {
  ADMIN_USERNAME, startHarness, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR, TEST_VENDOR_ID,
  type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, signUp } from "../src/rpc-client.js";

// A second deployment admin, so that the statistics can be checked across two.
const AUDITOR_USERNAME = "auditor";

// Admin settings and the audit log are deployment-wide, so this file owns its harness and runs
// serially.
const network = new NetworkInterceptor();
const fileScope = new DisposableStack();
let harness: Harness;
let adminApi: RpcStub<AuthenticatedApi>;
let admin: RpcStub<AdminApi>;
let auditor: RpcStub<AdminApi>;

async function signUpAdmin(username: string)
    : Promise<{ api: RpcStub<AuthenticatedApi>; admin: RpcStub<AdminApi> }> {
  const api = fileScope.use(await signUp(fileScope.use(connect(harness.url)), username));
  const stub = await api.getAdminApi();
  if (stub === null) throw new Error(`The admin API was unavailable to ${username}`);
  return { api, admin: fileScope.use(stub) };
}

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR }],
    patchWorkshop: config => {
      config.vars = { ...config.vars, ADMINS: [ADMIN_USERNAME, AUDITOR_USERNAME] };
    },
  });
  ({ api: adminApi, admin } = await signUpAdmin(ADMIN_USERNAME));
  ({ admin: auditor } = await signUpAdmin(AUDITOR_USERNAME));
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

/** The newest setting record of the deployment-wide audit log, if any. */
async function newestSetting(): Promise<AdminSettingRecord | undefined> {
  const [record] = (await admin.listAdminAudit({ kind: "setting", limit: 1 })).records;
  return record;
}

/** The newest setting record, which must be newer than `previous`. */
async function newSetting(previous: AdminSettingRecord | undefined): Promise<AdminSettingRecord> {
  const record = await newestSetting();
  if (record === undefined) throw new Error("No setting change was recorded");
  expect(record).not.toEqual(previous);
  return record;
}

// The smallest PNG a site logo accepts: the signature and a 1x1 IHDR chunk, 33 bytes.
function tinyPng(): Uint8Array {
  const png = new Uint8Array(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer);
  view.setUint32(8, 13);
  png.set([..."IHDR"].map(char => char.charCodeAt(0)), 12);
  view.setUint32(16, 1);
  view.setUint32(20, 1);
  png.set([8, 6, 0, 0, 0], 24);
  return png;
}

it("records every setting change, before it takes effect", async () => {
  const settings = await admin.getSettings();
  const expectRecord = async (previous: AdminSettingRecord | undefined,
                              method: AdminSettingRecord["method"],
                              changes: AdminSettingRecord["changes"]) => {
    const record = await newSetting(previous);
    expect(record).toMatchObject({
      kind: "setting", method, admin: ADMIN_USERNAME, via: "api", at: expect.any(Date),
    });
    expect(record.changes).toEqual(changes);
    return record;
  };

  let last = await newestSetting();
  await admin.setSiteName("Audited Deployment");
  last = await expectRecord(last, "setSiteName",
      [{ setting: "siteName", before: "", after: "Audited Deployment" }]);
  const { sessionId } = last;
  await admin.setSiteName("");
  last = await expectRecord(last, "setSiteName",
      [{ setting: "siteName", before: "Audited Deployment", after: "" }]);
  expect(last.sessionId).toBe(sessionId);

  await admin.setBanner("Maintenance tonight", "warning");
  last = await expectRecord(last, "setBanner", [
    { setting: "banner", key: "color", before: settings.banner.color, after: "warning" },
    { setting: "banner", key: "text", before: "", after: "Maintenance tonight" },
  ]);
  await admin.setBanner(settings.banner.text, settings.banner.color);
  last = await newSetting(last);

  try {
    await admin.setGatekeeperMode(TEST_VENDOR_ID, "disabled");
    last = await expectRecord(last, "setGatekeeperMode",
        [{ setting: "ambientGatekeeperModes", key: TEST_VENDOR_ID, after: "disabled" }]);
  } finally {
    await admin.setGatekeeperMode(TEST_VENDOR_ID, "optional");
  }
  last = await expectRecord(last, "setGatekeeperMode",
      [{ setting: "ambientGatekeeperModes", key: TEST_VENDOR_ID, before: "disabled" }]);

  const png = tinyPng();
  const logo = JSON.stringify({ bytes: 33, sha256: createHash("sha256").update(png).digest("hex") });
  try {
    await admin.setSiteLogo(png);
    last = await expectRecord(last, "setSiteLogo",
        [{ setting: "siteLogo", before: "default", after: logo }]);
    // The same logo again changes nothing.
    await admin.setSiteLogo(png);
    expect(await newestSetting()).toEqual(last);
  } finally {
    await admin.setSiteLogo(null);
  }
  last = await expectRecord(last, "setSiteLogo",
      [{ setting: "siteLogo", before: logo, after: "default" }]);

  const document = settings.formats.find(format => format.output?.id === "document");
  if (document === undefined) throw new Error("The bundled document format is not offered");
  const hint = `Prefer it for audit ${crypto.randomUUID()}.`;
  try {
    await admin.updateFormat(document.blueprintId, { agentHint: hint });
    last = await newSetting(last);
    expect(last.method).toBe("updateFormat");
    expect(last.changes).toHaveLength(1);
    const [change] = last.changes;
    expect(change).toMatchObject({ setting: "formats", key: document.blueprintId });
    expect(JSON.parse(change!.after!)).toEqual({ ...JSON.parse(change!.before!), agentHint: hint });
  } finally {
    await admin.updateFormat(document.blueprintId, { agentHint: document.agentHint });
  }
  last = await newSetting(last);

  const order = settings.formats.map(format => format.blueprintId);
  expect(order.length).toBeGreaterThan(1);
  const reversed = order.toReversed();
  try {
    await admin.setFormatOrder(reversed);
    last = await expectRecord(last, "setFormatOrder",
        [{ setting: "formats", before: JSON.stringify(order), after: JSON.stringify(reversed) }]);
  } finally {
    await admin.setFormatOrder(order);
  }
  last = await newSetting(last);

  // Under MAX_ADMIN_AUDIT_VALUE_LENGTH, an edit at the end is kept whole on both sides.
  const instructions = "i".repeat(7_990);
  const edited = `${instructions.slice(0, -20)}${"e".repeat(20)}`;
  try {
    await admin.setInstanceInstructions(instructions);
    last = await newSetting(last);
    await admin.setInstanceInstructions(edited);
    last = await expectRecord(last, "setInstanceInstructions",
        [{ setting: "instanceInstructions", before: instructions, after: edited }]);
  } finally {
    await admin.setInstanceInstructions(settings.instanceInstructions);
  }
  last = await newSetting(last);

  // Resource restrictions use the advertised stable ID and are audited as that identity.
  try {
    await admin.setResourceEnabled(TEST_VENDOR_ID, "thing", false);
    last = await expectRecord(last, "setResourceEnabled",
        [{ setting: "disabledResourceTypeIds", key: TEST_VENDOR_ID, after: '["thing"]' }]);
  } finally {
    await admin.setResourceEnabled(TEST_VENDOR_ID, "thing", true);
  }
  last = await expectRecord(last, "setResourceEnabled",
      [{ setting: "disabledResourceTypeIds", key: TEST_VENDOR_ID, before: '["thing"]' }]);

  // Past the audit value limit, the values are excerpts. Use a real setting that accepts a long
  // list, rather than inventing an unadvertised resource type that the setter must refuse.
  const hosts = Array.from({ length: 200 }, (_, i) => `${"h".repeat(50)}-${i}.example.test`);
  const serialized = JSON.stringify(hosts);
  expect(serialized.length).toBeGreaterThan(MAX_ADMIN_AUDIT_VALUE_LENGTH);
  try {
    await admin.setRestrictedWebFetchHosts(hosts);
    last = await newSetting(last);
    expect(last.method).toBe("setRestrictedWebFetchHosts");
    expect(last.changes).toHaveLength(1);
    const [change] = last.changes;
    expect(change).toMatchObject({
      setting: "restrictedWebFetchHosts", excerpt: { offset: 0, afterLength: serialized.length },
    });
    expect(change!.after!.length).toBeLessThanOrEqual(MAX_ADMIN_AUDIT_VALUE_LENGTH);
    expect(serialized.startsWith(change!.after!)).toBe(true);
  } finally {
    await admin.setRestrictedWebFetchHosts(settings.restrictedWebFetchHosts);
  }
  last = await newSetting(last);
  expect(last.method).toBe("setRestrictedWebFetchHosts");
  expect(last.changes).toEqual([expect.objectContaining({
    setting: "restrictedWebFetchHosts", excerpt: { offset: 0, beforeLength: serialized.length,
      afterLength: JSON.stringify(settings.restrictedWebFetchHosts).length },
  })]);

  try {
    await admin.setUpdateCheckIntervalMinutes(120);
    last = await expectRecord(last, "setUpdateCheckIntervalMinutes",
        [{ setting: "updateCheckIntervalMinutes", before: "60", after: "120" }]);
  } finally {
    await admin.setUpdateCheckIntervalMinutes(60);
  }
  last = await newSetting(last);

  try {
    await admin.setUserSearchEnabled(true);
    last = await expectRecord(last, "setUserSearchEnabled",
        [{ setting: "userSearchEnabled", before: "false", after: "true" }]);
    // A call that changes nothing records nothing.
    await admin.setUserSearchEnabled(true);
    expect(await newestSetting()).toEqual(last);
  } finally {
    await admin.setUserSearchEnabled(false);
  }
  last = await newSetting(last);

  try {
    await admin.setAdminAuditRetentionDays(120);
    last = await expectRecord(last, "setAdminAuditRetentionDays",
        [{ setting: "adminAuditRetentionDays", before: "90", after: "120" }]);
  } finally {
    await admin.setAdminAuditRetentionDays(90);
  }
  last = await expectRecord(last, "setAdminAuditRetentionDays",
      [{ setting: "adminAuditRetentionDays", before: "120", after: "90" }]);

  // A refused change records nothing.
  await expect(admin.setSiteName("x".repeat(MAX_SITE_NAME_LENGTH + 1))).rejects.toThrow();
  expect(await newestSetting()).toEqual(last);
  expect(last.sessionId).toBe(sessionId);
});

it("gives a new capability's records a session of their own", async () => {
  const before = await newestSetting();
  using again = await adminApi.getAdminApi();
  if (again === null) throw new Error("The admin API was unavailable");
  try {
    await again.setSiteName("A second capability");
    const record = await newSetting(before);
    expect(record).toMatchObject({ method: "setSiteName", admin: ADMIN_USERNAME });
    expect(record.sessionId).not.toBe(before?.sessionId);
  } finally {
    await again.setSiteName("");
  }
});

/** The kinds of the newest records `listAdminAudit({ kind })` lists. */
async function kinds(kind: AdminAuditKind): Promise<AdminAuditKind[]> {
  return (await admin.listAdminAudit({ kind, limit: 200 })).records.map(record => record.kind);
}

it("filters the log by kind", async () => {
  // A workspace access record, as the table can hold, which a setting filter leaves out.
  const storage = await harness.server.getWorker("workshop-backend")
      .getDurableObjectStorage("AdminAuditDurableObject", { name: "" });
  const settingsBefore = await admin.getAdminAuditStats({ kind: "setting" });
  await storage.exec(`INSERT INTO admin_audit
      (at, kind, admin, workspace_id, workspace_title, exposed, record)
      VALUES (${Date.now()}, 'workspace', 'filter-check', 'workspace-1', 'Filter check',
          'metadata', '{}')`);
  try {
    const setting = await kinds("setting");
    expect(setting.length).toBeGreaterThan(0);
    expect(new Set(setting)).toEqual(new Set(["setting"]));
    const settingsAfter = await admin.getAdminAuditStats({ kind: "setting" });
    expect(settingsAfter.totalEvents)
        .toBe(settingsBefore.totalEvents - droppedDays(settingsBefore, settingsAfter));
    expect(settingsAfter.topAdmins.map(entry => entry.admin)).not.toContain("filter-check");
  } finally {
    await storage.exec("DELETE FROM admin_audit WHERE admin = 'filter-check'");
  }
});

it("filters the log by method, and refuses a method that is not audited", async () => {
  await admin.setSiteName("Method filter check");
  try {
    await admin.setSignupsEnabled(false);
    await admin.setSignupsEnabled(true);
    const methods = async (method: AdminAuditRecord["method"]) =>
      (await admin.listAdminAudit({ method, limit: 200 })).records.map(record => record.method);
    const siteNames = await methods("setSiteName");
    expect(siteNames.length).toBeGreaterThan(0);
    expect(new Set(siteNames)).toEqual(new Set(["setSiteName"]));
    expect((await methods("setSignupsEnabled")).length).toBeGreaterThanOrEqual(2);
    await expect(admin.listAdminAudit(
      { method: "listAdminAudit" } as unknown as Parameters<AdminApi["listAdminAudit"]>[0]))
        .rejects.toThrow();
  } finally {
    await admin.setSiteName("");
  }
});

/** How much each named entry of `after` grew since `before`. */
function growth<T>(before: T[], after: T[], key: (entry: T) => string, count: (entry: T) => number)
    : Map<string, number> {
  const earlier = new Map(before.map(entry => [key(entry), count(entry)]));
  return new Map(after.map(entry => [key(entry), count(entry) - (earlier.get(key(entry)) ?? 0)]));
}

/** The records `before` counted on days that have since left the window: none unless the UTC day
 * turned between the two reads. */
function droppedDays(before: AdminAuditStats, after: AdminAuditStats): number {
  const kept = new Set(after.byDay.map(({ day }) => day));
  return before.byDay.filter(({ day }) => !kept.has(day)).reduce((sum, { count }) => sum + count, 0);
}

it("counts the log across two admins", async () => {
  const before = await admin.getAdminAuditStats();
  const settingsBefore = await admin.getAdminAuditStats({ kind: "setting" });

  try {
    await admin.setUserSearchEnabled(true);
    await auditor.setSiteName("Stats check");
    await auditor.setSiteName("");

    const after = await admin.getAdminAuditStats();
    expect(after.days).toBe(7);
    expect(after.totalEvents).toBe(before.totalEvents + 3 - droppedDays(before, after));
    const byDay = growth(before.byDay, after.byDay, entry => entry.day, entry => entry.count);
    expect([...byDay.values()].reduce((sum, count) => sum + count, 0)).toBe(3);

    expect(after.byDay).toHaveLength(7);
    const days = after.byDay.map(({ day }) => Date.parse(`${day}T00:00:00Z`));
    for (let i = 1; i < days.length; i++) expect(days[i]! - days[i - 1]!).toBe(24 * 60 * 60_000);

    const admins = growth(before.topAdmins, after.topAdmins, entry => entry.admin,
        entry => entry.count);
    expect(admins.get(ADMIN_USERNAME)).toBe(1);
    expect(admins.get(AUDITOR_USERNAME)).toBe(2);

    const settingsAfter = await admin.getAdminAuditStats({ kind: "setting" });
    expect(settingsAfter.totalEvents)
        .toBe(settingsBefore.totalEvents + 3 - droppedDays(settingsBefore, settingsAfter));
  } finally {
    await admin.setUserSearchEnabled(false);
  }

  expect((await admin.getAdminAuditStats({ days: 1 })).byDay).toHaveLength(1);
  for (const days of [0, 367, 1.5]) {
    await expect(admin.getAdminAuditStats({ days }), `days ${days}`).rejects.toThrow();
  }
});

it("refuses a setting change whose audit record cannot be written", async () => {
  // Addresses the deployment-wide log, which is always getByName("").
  const storage = await harness.server.getWorker("workshop-backend")
      .getDurableObjectStorage("AdminAuditDurableObject", { name: "" });
  const before = await newestSetting();
  const { siteName } = await admin.getSettings();
  try {
    await storage.exec(`CREATE TRIGGER admin_audit_unavailable BEFORE INSERT ON admin_audit
        BEGIN SELECT RAISE(ABORT, 'admin audit unavailable'); END`);
    await expect(admin.setSiteName("x")).rejects.toThrow();
  } finally {
    await storage.exec("DROP TRIGGER IF EXISTS admin_audit_unavailable");
  }
  expect((await admin.getSettings()).siteName).toBe(siteName);
  const after: AdminAuditRecord | undefined = await newestSetting();
  expect(after).toEqual(before);
});
