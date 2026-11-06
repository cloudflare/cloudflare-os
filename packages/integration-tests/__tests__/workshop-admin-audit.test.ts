import { createHash } from "node:crypto";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  MAX_ADMIN_AUDIT_VALUE_LENGTH, MAX_SITE_NAME_LENGTH,
  type AdminApi, type AdminAuditKind, type AdminAuditRecord,
  type AdminAuditStats, type AdminSettingRecord, type AuthenticatedApi, type Overseer,
} from "@gadgets/workshop-shared/api";
import {
  ADMIN_USERNAME, startHarness, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR, TEST_VENDOR_ID,
  type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp } from "../src/rpc-client.js";

// A second deployment admin, so that the statistics can be checked across two.
const AUDITOR_USERNAME = "auditor";
const REASON = "Audit log check";

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
      config.vars = {
        ...config.vars,
        ADMINS: [ADMIN_USERNAME, AUDITOR_USERNAME],
        ADMIN_WORKSPACE_ACCESS_MAX: "full",
      };
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
  if (record !== undefined && record.kind !== "setting") {
    throw new Error("The kind filter returned an access record");
  }
  return record;
}

/** The newest setting record, which must be newer than `previous`. */
async function newSetting(previous: AdminSettingRecord | undefined): Promise<AdminSettingRecord> {
  const record = await newestSetting();
  if (record === undefined) throw new Error("No setting change was recorded");
  expect(record).not.toEqual(previous);
  return record;
}

/** A fresh owner's workspace, retitled so that its records can be recognised. */
async function newWorkspace(stack: DisposableStack, prefix: string)
    : Promise<{ id: string; title: string; ownerName: string; ws: RpcStub<Overseer> }> {
  const [ownerName] = nextUsernames(prefix);
  const owner = stack.use(await signUp(stack.use(connect(harness.url)), ownerName!));
  const ws = stack.use(await owner.newWorkspace());
  const title = `Workspace of ${ownerName}`;
  await ws.setTitle(title);
  return { id: (await ws.getMetadata()).id, title, ownerName: ownerName!, ws };
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

  // Past it, the values are excerpts from a little before their first difference.
  const pattern = `https://gadgets-test.example/${"p".repeat(12_000 - 29)}`;
  expect(pattern).toHaveLength(12_000);
  const disabled = JSON.stringify([pattern]);
  try {
    await admin.setResourceEnabled(TEST_VENDOR_ID, pattern, false);
    last = await newSetting(last);
    expect(last.method).toBe("setResourceEnabled");
    expect(last.changes).toHaveLength(1);
    const [change] = last.changes;
    expect(change).toMatchObject({
      setting: "disabledResources", key: TEST_VENDOR_ID, excerpt: { offset: 0, afterLength: 12_004 },
    });
    expect(change).not.toHaveProperty("before");
    expect(change!.after!.length).toBeLessThanOrEqual(MAX_ADMIN_AUDIT_VALUE_LENGTH);
    expect(disabled.startsWith(change!.after!)).toBe(true);
  } finally {
    await admin.setResourceEnabled(TEST_VENDOR_ID, pattern, true);
  }
  last = await newSetting(last);
  expect(last.method).toBe("setResourceEnabled");
  expect(last.changes).toEqual([expect.objectContaining({
    setting: "disabledResources", key: TEST_VENDOR_ID, excerpt: { offset: 0, beforeLength: 12_004 },
  })]);
  expect(last.changes[0]).not.toHaveProperty("after");

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
  using stack = new DisposableStack();
  const { id } = await newWorkspace(stack, "kinds");
  const settingsBefore = await admin.getAdminAuditStats({ kind: "setting" });
  {
    using _view = await admin.inspectWorkspace(id, REASON);
  }
  const workspace = await kinds("workspace");
  expect(workspace.length).toBeGreaterThan(0);
  expect(new Set(workspace)).toEqual(new Set(["workspace"]));
  const setting = await kinds("setting");
  expect(setting.length).toBeGreaterThan(0);
  expect(new Set(setting)).toEqual(new Set(["setting"]));
  const settingsAfter = await admin.getAdminAuditStats({ kind: "setting" });
  expect(settingsAfter.totalEvents)
      .toBe(settingsBefore.totalEvents - droppedDays(settingsBefore, settingsAfter));
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
  using stack = new DisposableStack();
  const a = await newWorkspace(stack, "statsa");
  const b = await newWorkspace(stack, "statsb");
  const before = await admin.getAdminAuditStats();
  const settingsBefore = await admin.getAdminAuditStats({ kind: "setting" });

  try {
    {
      using view = await admin.inspectWorkspace(a.id, REASON);
      await view.describe();
      await view.listChats();
      await view.getDiagnostics();
    }
    await admin.setUserSearchEnabled(true);
    {
      using view = await auditor.inspectWorkspace(b.id, REASON);
      await view.listChats();
    }

    const after = await admin.getAdminAuditStats();
    expect(after.days).toBe(7);
    expect(after.totalEvents).toBe(before.totalEvents + 7 - droppedDays(before, after));
    const byDay = growth(before.byDay, after.byDay, entry => entry.day, entry => entry.count);
    expect([...byDay.values()].reduce((sum, count) => sum + count, 0)).toBe(7);

    expect(after.byDay).toHaveLength(7);
    const days = after.byDay.map(({ day }) => Date.parse(`${day}T00:00:00Z`));
    for (let i = 1; i < days.length; i++) expect(days[i]! - days[i - 1]!).toBe(24 * 60 * 60_000);

    const admins = growth(before.topAdmins, after.topAdmins, entry => entry.admin,
        entry => entry.count);
    expect(admins.get(ADMIN_USERNAME)).toBe(5);
    expect(admins.get(AUDITOR_USERNAME)).toBe(2);
    // Setting records name no workspace, so A lists its four access records alone.
    for (const [workspace, count] of [[a.id, 4], [b.id, 2]] as const) {
      expect((await admin.listAdminAudit({ workspace, limit: 200 })).records).toHaveLength(count);
    }

    const settingsAfter = await admin.getAdminAuditStats({ kind: "setting" });
    expect(settingsAfter.totalEvents)
        .toBe(settingsBefore.totalEvents + 1 - droppedDays(settingsBefore, settingsAfter));
    expect(growth(settingsBefore.topAdmins, settingsAfter.topAdmins, entry => entry.admin,
        entry => entry.count).get(ADMIN_USERNAME)).toBe(1);
  } finally {
    await admin.setUserSearchEnabled(false);
  }

  expect((await admin.getAdminAuditStats({ days: 1 })).byDay).toHaveLength(1);
  for (const days of [0, 367, 1.5]) {
    await expect(admin.getAdminAuditStats({ days }), `days ${days}`).rejects.toThrow();
  }
});

it("counts content reads, by admin and by workspace", async () => {
  using stack = new DisposableStack();
  const a = await newWorkspace(stack, "contenta");
  const b = await newWorkspace(stack, "contentb");
  const chatA = await a.ws.newChat("hello", null);
  const chatB = await b.ws.newChat("hello", null);

  try {
    await admin.setAdminWorkspaceAccess("full");
    const before = await admin.getAdminAuditStats();
    {
      using view = await admin.inspectWorkspace(a.id, REASON, { access: "full" });
      await view.getChat(chatA);
      await view.getChat(chatA);
      // No steer is queued, so this exposes no content.
      await view.listChats();
    }
    {
      using view = await auditor.inspectWorkspace(b.id, REASON, { access: "full" });
      await view.getChat(chatB);
    }
    const after = await admin.getAdminAuditStats();

    // Every content read in this harness happens during the run, so none has left the window.
    expect(after.contentReads - before.contentReads).toBe(3);
    const admins = growth(before.topAdmins, after.topAdmins,
        entry => entry.admin, entry => entry.contentReads);
    expect(admins.get(ADMIN_USERNAME)).toBe(2);
    expect(admins.get(AUDITOR_USERNAME)).toBe(1);
    // The open, the two getChat() calls and listChats(); only the getChat() calls read content.
    for (const [workspace, count, reads] of [[a.id, 4, 2], [b.id, 2, 1]] as const) {
      expect((await admin.listAdminAudit({ workspace, limit: 200 })).records).toHaveLength(count);
      expect((await admin.listAdminAudit({ workspace, exposed: "content", limit: 200 })).records)
          .toHaveLength(reads);
    }

    // Each workspace's records, found by its owner.
    const owned = (await admin.listAdminAudit({ owner: a.ownerName, limit: 200 })).records;
    expect(owned.map(record => record.method))
        .toEqual(["listChats", "getChat", "getChat", "inspectWorkspace"]);
    expect(new Set(owned.map(record => record.kind === "workspace" && record.workspaceId)))
        .toEqual(new Set([a.id]));

    const settings = await admin.getAdminAuditStats({ kind: "setting" });
    expect(settings.contentReads).toBe(0);
    expect(settings.topAdmins.every(entry => entry.contentReads === 0)).toBe(true);
    expect((await admin.getAdminAuditStats({ kind: "workspace" })).contentReads)
        .toBe(after.contentReads);

    const [newest] = (await admin.listAdminAudit(
        { exposed: "content", admin: AUDITOR_USERNAME, limit: 1 })).records;
    expect(newest).toMatchObject({
      kind: "workspace", workspaceId: b.id, method: "getChat", args: { chatId: chatB },
      requested: "full", access: "full", exposed: "content",
    });
  } finally {
    await admin.setAdminWorkspaceAccess("metadata");
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
