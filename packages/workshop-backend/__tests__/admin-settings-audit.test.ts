import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  MAX_ADMIN_AUDIT_ARG_LENGTH, MAX_ADMIN_AUDIT_VALUE_LENGTH, SUGGESTED_MODELS,
  type AdminAuditRecord, type AdminSettingRecord, type GatewayModel,
} from "@gadgets/workshop-shared/api";
import type { AdminSettingActor } from "../src/admin-access.js";
import type { AdminAuditDurableObject } from "../src/admin-audit.js";
import { AdminSettings } from "../src/admin-settings.js";
import { bundledBlueprintsManifestVersion } from "../src/bundled-blueprints.js";
import { BUNDLED_BLUEPRINTS } from "../src/generated/bundled-blueprints.js";
import {
  DEFAULT_ADMIN_CONFIG, type AdminConfig, type AdminSettingsStorage,
} from "../src/storage-schema/admin-settings-storage.js";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
    TEST_ADMIN_AUDIT: DurableObjectNamespace<AdminAuditDurableObject>;
  }
}

const GATEWAY = {
  CF_AI_GATEWAY: "platform-gateway",
  CF_AI_GATEWAY_ACCOUNT_ID: "account-id",
  CF_AI_GATEWAY_API_TOKEN: "gateway-token",
  CF_AI_GATEWAY_PROVIDERS: "anthropic,cloudflare",
};

const ACTOR: AdminSettingActor =
    { admin: "admin@example.test", sessionId: "session-1", via: "cli", method: "setSiteName" };

let counter = 0;

function model(i: number): GatewayModel {
  return { provider: "anthropic", id: `model-${i}`, name: `Model ${i}`, contextWindow: 200_000 };
}

async function digest(data: Uint8Array): Promise<string> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data)).toHex();
}

/**
 * An AdminSettings over fresh storage, built on the state of an unrelated Durable Object as
 * admin-settings-models.test.ts builds it, with `vars` as its environment (and `more` beside them
 * for one call). Its audit log is a fake whose appends land in `appended`; `events` orders the
 * appends, KV writes and R2 writes. `audit.fail`, `kv.fail` make the next of each throw, and
 * `audit.before` runs, and is awaited, at the start of each append.
 */
function adminSettings(vars: object = {}) {
  const stub = env.TEST_USER_DIRECTORY.getByName(`admin-settings-audit-${++counter}`);
  const events: string[] = [];
  const appended: { record: AdminAuditRecord; retentionDays: number }[] = [];
  const audit = { fail: false, before: undefined as (() => Promise<void>) | undefined };
  const kv = { fail: false, blueprints: new Map<string, string>() };
  const put = vi.fn(async (key: string, value: string) => {
    if (kv.fail) throw new Error("KV unavailable");
    events.push(`kv:${key}`);
    kv.blueprints.set(key, value);
  });
  const audits = { getByName: () => ({
    append: async (record: AdminAuditRecord, retentionDays: number) => {
      await audit.before?.();
      if (audit.fail) throw new Error("audit log unavailable");
      events.push("audit");
      appended.push({ record, retentionDays });
    },
  }) };
  // The logo R2 holds, with the digest put() was given, as head() reports it.
  const stored: { logo: { size: number; checksums: { sha256?: ArrayBuffer } } | null } =
      { logo: null };
  const r2 = {
    put: vi.fn(async (_key: string, data: Uint8Array, options?: { sha256?: string }) => {
      events.push("r2:put");
      stored.logo = { size: data.byteLength, checksums: {
        sha256: options?.sha256 ? Uint8Array.fromHex(options.sha256).buffer : undefined,
      } };
    }),
    head: vi.fn(async () => stored.logo),
    delete: vi.fn(async () => { events.push("r2:delete"); stored.logo = null; }),
  };
  const owner = {
    featured: null as boolean | null,
    isBlueprintFeatured: async () => owner.featured,
    setBlueprintFeatured: async (_id: string, featured: boolean) => {
      events.push("owner:set");
      owner.featured = featured;
    },
  };
  const users = { idFromString: (id: string) => id, get: () => owner };

  const inDo = <T>(f: (admin: AdminSettings) => T | Promise<T>,
                   options: { more?: object; fake?: boolean } = {}) => runInDurableObject(
      stub, (_host, state) => {
        const settingsEnv = {
          ...vars, ...options.more,
          BLUEPRINTS: { put, get: async (key: string) => kv.blueprints.get(key) ?? null },
          BLUEPRINT_CONTENT: r2,
        };
        const admin = new AdminSettings(state, settingsEnv as unknown as Cloudflare.Env);
        Object.assign(admin, { users }, options.fake === false ? {} : { audits });
        return f(admin);
      });
  const storageOf = (admin: AdminSettings) =>
      (admin as unknown as { storage: AdminSettingsStorage }).storage;
  // Write the stored config directly, as an earlier admin would have left it, recording nothing.
  const seed = (patch: Partial<AdminConfig>) => inDo(admin => {
    storageOf(admin).adminConfig.put({ ...DEFAULT_ADMIN_CONFIG, ...patch });
  });
  const config = () => inDo(admin => admin.getAdminConfig());
  // The setting records appended, in order.
  const records = () => appended.map(({ record }) => record as AdminSettingRecord);
  return { inDo, storageOf, seed, config, records, appended, events, audit, kv, put, r2, stored, owner };
}

describe("AdminSettings records each admin's change before making it", () => {
  it("records who changed a setting, how, and from what to what, before the KV write", async () => {
    const { inDo, appended, events, config } = adminSettings();
    const before = Date.now();
    await inDo(admin => admin.updateAdminConfig({ siteName: "Acme" }, ACTOR));

    expect(appended).toHaveLength(1);
    const { record, retentionDays } = appended[0]!;
    expect(record).toMatchObject({
      kind: "setting", admin: "admin@example.test", sessionId: "session-1", via: "cli",
      method: "setSiteName", changes: [{ setting: "siteName", before: "", after: "Acme" }],
    });
    expect((record as AdminSettingRecord).changes[0]).toStrictEqual(
        { setting: "siteName", before: "", after: "Acme" });
    expect(record.at.getTime()).toBeGreaterThanOrEqual(before);
    expect(retentionDays).toBe(90);
    expect(events).toEqual(["audit", "kv:.adminConfig"]);
    expect((await config()).siteName).toBe("Acme");
  });

  it("keeps long agent instructions whole, both before and after", async () => {
    const { inDo, records } = adminSettings();
    const first = "a".repeat(8_000);
    const second = first.slice(0, -20) + "b".repeat(20);
    await inDo(admin => admin.updateAdminConfig({ instanceInstructions: first }, ACTOR));
    await inDo(admin => admin.updateAdminConfig({ instanceInstructions: second }, ACTOR));

    expect(records()[1]!.changes).toStrictEqual(
        [{ setting: "instanceInstructions", before: first, after: second }]);
  });

  it("records one format's change, and a reordering as one keyless change", async () => {
    const { inDo, seed, records } = adminSettings();
    const ids = ["bp-a", "bp-b", "bp-c", "bp-d"];
    await seed({ formats: ids.map(blueprintId => ({ blueprintId, enabled: true })) });

    await inDo(admin => admin.updateFormat("bp-d", { enabled: false }, ACTOR));
    expect(records()[0]!.changes).toStrictEqual([{
      setting: "formats", key: "bp-d",
      before: '{"blueprintId":"bp-d","enabled":true}',
      after: '{"blueprintId":"bp-d","enabled":false}',
    }]);

    await inDo(admin => admin.setFormatOrder(["bp-d", "bp-a", "bp-b", "bp-c"], ACTOR));
    expect(records()[1]!.changes).toStrictEqual([{
      setting: "formats",
      before: '["bp-a","bp-b","bp-c","bp-d"]',
      after: '["bp-d","bp-a","bp-b","bp-c"]',
    }]);
  });

  it("records a model order per provider, and a provider order whole", async () => {
    const { inDo, records } = adminSettings(GATEWAY);
    const anthropic = Object.keys(SUGGESTED_MODELS.anthropic);
    await inDo(admin => admin.setGatewayModelOrder("anthropic", anthropic.toReversed(), ACTOR));
    expect(records()[0]!.changes).toStrictEqual([{
      setting: "modelOrder", key: "anthropic", after: JSON.stringify(anthropic.toReversed()),
    }]);

    const providers = ["anthropic", "cloudflare-auto-router", "cloudflare", "openai", "google"];
    await inDo(admin => admin.setGatewayProviderOrder(providers, ACTOR));
    expect(records()[1]!.changes).toStrictEqual(
        [{ setting: "providerOrder", before: "[]", after: JSON.stringify(providers) }]);
  });

  it("records an added model alone, however many there are", async () => {
    const { inDo, seed, records } = adminSettings(GATEWAY);
    await seed({ addedModels: Array.from({ length: 60 }, (_, i) => model(i)) });

    await inDo(admin => admin.addGatewayModel(model(60), ACTOR));
    expect(records()[0]!.changes).toStrictEqual([{
      setting: "addedModels", key: "model-60",
      after: '{"contextWindow":200000,"id":"model-60","name":"Model 60","provider":"anthropic"}',
    }]);
  });

  it("records a map one key at a time", async () => {
    const { inDo, records } = adminSettings(GATEWAY);
    const color = DEFAULT_ADMIN_CONFIG.banner.color === "warning" ? "danger" : "warning";
    await inDo(admin =>
        admin.updateAdminConfig({ banner: { text: "Down at noon", color } }, ACTOR));
    expect(records()[0]!.changes).toStrictEqual([
      { setting: "banner", key: "color", before: DEFAULT_ADMIN_CONFIG.banner.color, after: color },
      { setting: "banner", key: "text", before: "", after: "Down at noon" },
    ]);

    await inDo(admin => admin.setGatewayModelMode("claude-fable-5-1", "disabled", ACTOR));
    expect(records()[1]!.changes).toStrictEqual(
        [{ setting: "modelModes", key: "claude-fable-5-1", after: "disabled" }]);
  });

  it("keeps an excerpt of an over-long value, and cuts an over-long key", async () => {
    const { inDo, records } = adminSettings();
    const pattern = "p".repeat(12_000);
    await inDo(admin => admin.setResourceEnabled("vendor", pattern, false, ACTOR));
    const [change] = records()[0]!.changes;
    expect(change).toStrictEqual({
      setting: "disabledResources", key: "vendor",
      after: `["${pattern}"]`.slice(0, MAX_ADMIN_AUDIT_VALUE_LENGTH),
      excerpt: { offset: 0, afterLength: 12_004 },
    });

    const vendor = "v".repeat(300);
    await inDo(admin => admin.setResourceEnabled(vendor, "pattern", false, ACTOR));
    expect(records()[1]!.changes).toStrictEqual([{
      setting: "disabledResources",
      key: `${"v".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…`,
      after: '["pattern"]',
    }]);
  });

  it("records nothing for a change that changes nothing, which is still written", async () => {
    const { inDo, appended, put } = adminSettings();
    await inDo(admin => admin.updateAdminConfig({ siteName: "" }, ACTOR));
    expect(appended).toEqual([]);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("records nothing for a change it refuses", async () => {
    const { inDo, appended, put } = adminSettings(GATEWAY);
    await expect(inDo(admin => admin.setGatewayModelMode("no-such-model", "disabled", ACTOR)))
        .rejects.toThrow("No such model: no-such-model");
    expect(appended).toEqual([]);
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses a change whose record cannot be written, writing nothing", async () => {
    const { inDo, audit, put, config } = adminSettings();
    audit.fail = true;
    await expect(inDo(admin => admin.updateAdminConfig({ siteName: "Acme" }, ACTOR)))
        .rejects.toThrow("audit log unavailable");
    expect(put).not.toHaveBeenCalled();
    expect((await config()).siteName).toBe("");
  });

  it("keeps the record of a change the KV mirror then fails, which is rolled back", async () => {
    const { inDo, kv, appended, config } = adminSettings();
    kv.fail = true;
    await expect(inDo(admin => admin.updateAdminConfig({ siteName: "Acme" }, ACTOR)))
        .rejects.toThrow("KV unavailable");
    expect((await config()).siteName).toBe("");
    expect(appended).toHaveLength(1);
  });

  it("records a logo as its size and digest, before storing it", async () => {
    const { inDo, records, events } = adminSettings();
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5, 6, 7]);

    await inDo(admin => admin.setSiteLogo(first, ACTOR));
    expect(events).toEqual(["audit", "r2:put", "kv:.adminConfig"]);
    await inDo(admin => admin.setSiteLogo(second, ACTOR));
    // Uploading the logo already stored changes nothing, though it is written again.
    await inDo(admin => admin.setSiteLogo(second, ACTOR));
    await inDo(admin => admin.setSiteLogo(null, ACTOR));
    // Resetting a logo that is already the default changes nothing.
    await inDo(admin => admin.setSiteLogo(null, ACTOR));

    const firstLogo = `{"bytes":3,"sha256":"${await digest(first)}"}`;
    const secondLogo = `{"bytes":4,"sha256":"${await digest(second)}"}`;
    expect(records().map(record => record.changes)).toStrictEqual([
      [{ setting: "siteLogo", before: "default", after: firstLogo }],
      [{ setting: "siteLogo", before: firstLogo, after: secondLogo }],
      [{ setting: "siteLogo", before: secondLogo, after: "default" }],
    ]);
  });

  it("resets a logo whose digest R2 cannot read, naming it custom", async () => {
    const { inDo, seed, r2, records, config } = adminSettings();
    await seed({ siteLogoConfigured: true });
    r2.head.mockRejectedValueOnce(new Error("R2 unavailable"));
    await inDo(admin => admin.setSiteLogo(null, ACTOR));
    expect((await config()).siteLogoConfigured).toBe(false);
    expect(records().map(record => record.changes))
        .toStrictEqual([[{ setting: "siteLogo", before: "custom", after: "default" }]]);
  });

  it("refuses an upload when R2 cannot say which logo it replaces", async () => {
    const { inDo, seed, r2, appended } = adminSettings();
    await seed({ siteLogoConfigured: true });
    r2.head.mockRejectedValueOnce(new Error("R2 unavailable"));
    await expect(inDo(admin => admin.setSiteLogo(new Uint8Array([1, 2, 3]), ACTOR)))
        .rejects.toThrow("R2 unavailable");
    expect(appended).toEqual([]);
    expect(r2.put).not.toHaveBeenCalled();
  });

  it("records a first model change without the config's own bookkeeping", async () => {
    const { inDo, records, config } = adminSettings();
    expect((await config()).modelsSaved).toBe(false);
    await inDo(admin => admin.updateAdminConfig({ modelModes: { "claude-opus-5-5": "hidden" } }, ACTOR));
    expect((await config()).modelsSaved).toBe(true);
    expect(records().map(record => record.changes)).toStrictEqual([[
      { setting: "modelModes", key: "claude-opus-5-5", after: "hidden" },
    ]]);
  });

  it("names a logo stored without a digest as custom", async () => {
    const { inDo, seed, stored, records } = adminSettings();
    await seed({ siteLogoConfigured: true });
    stored.logo = { size: 9, checksums: {} };
    await inDo(admin => admin.setSiteLogo(null, ACTOR));
    expect(records().map(record => record.changes))
        .toStrictEqual([[{ setting: "siteLogo", before: "custom", after: "default" }]]);
  });

  it("records featuring a blueprint only when that changes it", async () => {
    const { inDo, kv, records, events, owner } = adminSettings();
    const at = new Date("2026-01-01T00:00:00Z");
    kv.blueprints.set("bp-1", JSON.stringify({
      metadata: {
        title: "Notes", description: "", author: { id: "owner", name: "Owner" },
        created: at, version: 1, lastUpdated: at,
      },
      ownerId: "owner-do", gadgetId: "gadget-1",
    }));

    await inDo(admin => admin.setBlueprintFeatured("bp-1", true, ACTOR));
    expect(events.slice(0, 2)).toEqual(["audit", "owner:set"]);
    await inDo(admin => admin.setBlueprintFeatured("bp-1", true, ACTOR));
    await inDo(admin => admin.setBlueprintFeatured("bp-1", false, ACTOR));
    expect(owner.featured).toBe(false);
    expect(records().map(record => record.changes)).toStrictEqual([
      [{ setting: "featured", key: "bp-1", before: "false", after: "true" }],
      [{ setting: "featured", key: "bp-1", before: "true", after: "false" }],
    ]);
  });

  it("never lets a concurrent featuring change go unrecorded", async () => {
    const { inDo, kv, records, owner } = adminSettings();
    const at = new Date("2026-01-01T00:00:00Z");
    kv.blueprints.set("bp-1", JSON.stringify({
      metadata: {
        title: "Notes", description: "", author: { id: "owner", name: "Owner" },
        created: at, version: 1, lastUpdated: at,
      },
      ownerId: "owner-do", gadgetId: "gadget-1",
    }));
    owner.featured = false;
    // The first read answers with the bit as it was, late: long enough for a concurrent call to
    // change it if nothing serializes the two.
    let reads = 0;
    owner.isBlueprintFeatured = async () => {
      const value = owner.featured;
      if (++reads === 1) await new Promise(resolve => setTimeout(resolve, 50));
      return value;
    };

    await inDo(admin => Promise.all([
      admin.setBlueprintFeatured("bp-1", false, ACTOR),
      admin.setBlueprintFeatured("bp-1", true, ACTOR),
    ]));
    expect(owner.featured).toBe(true);
    expect(records().map(record => record.changes)).toStrictEqual([
      [{ setting: "featured", key: "bp-1", before: "false", after: "true" }],
    ]);
  });
});

describe("AdminSettings promotes bundled formats", () => {
  it.skipIf(BUNDLED_BLUEPRINTS.length === 0)(
      "keeps an admin's format change that lands while promotion waits for it", async () => {
    const { inDo, storageOf, seed, config, records, audit } = adminSettings();
    const [pending, ...promoted] = BUNDLED_BLUEPRINTS;
    await seed({ formats: [{ blueprintId: "bp-a", enabled: true }] });
    // Installed already, with one bundled blueprint still to promote.
    await inDo(admin => {
      storageOf(admin).installedFormatBlueprints.put(bundledBlueprintsManifestVersion());
      storageOf(admin).promotedFormatBlueprints.put(promoted.map(entry => entry.blueprintId));
    });
    const appending = Promise.withResolvers<void>();
    const appended = Promise.withResolvers<void>();
    audit.before = () => { appending.resolve(); return appended.promise; };

    await inDo(async admin => {
      let change = admin.updateFormat("bp-a", { enabled: false }, ACTOR);
      await appending.promise;
      let promotion = admin.ensureBundledBlueprintsInstalled();
      appended.resolve();
      await change;
      expect(await promotion).toBe(true);
    });
    expect((await config()).formats).toStrictEqual([
      { blueprintId: "bp-a", enabled: false },
      { blueprintId: pending!.blueprintId, enabled: true },
    ]);
    expect(records().map(record => record.changes)).toStrictEqual([[{
      setting: "formats", key: "bp-a",
      before: '{"blueprintId":"bp-a","enabled":true}',
      after: '{"blueprintId":"bp-a","enabled":false}',
    }]]);
  });
});

describe("AdminSettings admin access bounds", () => {
  it("records a logo with the retention committed, not one still in flight", async () => {
    const { inDo, seed, put, appended } = adminSettings();
    await seed({ adminAuditRetentionDays: 365 });
    let failKv!: () => void;
    put.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      failKv = () => reject(new Error("KV unavailable"));
    }));

    await inDo(async admin => {
      let change = admin.setAdminAuditRetentionDays(90, ACTOR);
      await vi.waitFor(() => expect(failKv).toBeDefined());
      let logo = admin.setSiteLogo(new Uint8Array([1, 2, 3]), ACTOR);
      failKv();
      await expect(change).rejects.toThrow("KV unavailable");
      await logo;
    });
    expect(appended.map(({ record, retentionDays }) =>
        [(record as AdminSettingRecord).changes[0]!.setting, retentionDays]))
        .toStrictEqual([["adminAuditRetentionDays", 365], ["siteLogo", 365]]);
  });

  it("refuses a config change that leaves out its actor", async () => {
    const { inDo, appended, config } = adminSettings();
    await expect(inDo(admin => (admin.updateAdminConfig as (patch: object) => Promise<void>)(
        { siteName: "Acme" }))).rejects.toThrow("needs its actor");
    expect(appended).toEqual([]);
    expect((await config()).siteName).toBe("");
  });

  it("hands out the retention a change in flight would set only once it commits", async () => {
    const { inDo, seed, put } = adminSettings();
    await seed({ adminAuditRetentionDays: 365 });
    let failKv!: () => void;
    put.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      failKv = () => reject(new Error("KV unavailable"));
    }));

    await inDo(async admin => {
      let change = admin.setAdminAuditRetentionDays(90, ACTOR);
      await vi.waitFor(() => expect(failKv).toBeDefined());
      // Stored already, awaiting the mirror, which then fails and rolls the change back.
      expect(admin.getAdminConfig().adminAuditRetentionDays).toBe(90);
      let committed = admin.committedAdminConfig();
      failKv();
      await expect(change).rejects.toThrow("KV unavailable");
      expect((await committed).adminAuditRetentionDays).toBe(365);
    });
  });

  it("refuses an access level above ADMIN_WORKSPACE_ACCESS_MAX", async () => {
    const { inDo, seed, appended, config, records } = adminSettings();
    await seed({ adminWorkspaceAccess: "off" });
    await expect(inDo(admin => admin.setAdminWorkspaceAccess("metadata", ACTOR),
        { more: { ADMIN_WORKSPACE_ACCESS_MAX: "off" } }))
        .rejects.toThrow("ADMIN_WORKSPACE_ACCESS_MAX");
    expect(appended).toEqual([]);
    expect((await config()).adminWorkspaceAccess).toBe("off");

    await inDo(admin => admin.setAdminWorkspaceAccess("metadata", ACTOR));
    await inDo(admin => admin.setAdminWorkspaceAccess("off", ACTOR));
    await inDo(admin => admin.setAdminWorkspaceAccess("metadata", ACTOR));
    expect(records().map(record => record.changes)).toStrictEqual([
      [{ setting: "adminWorkspaceAccess", before: "off", after: "metadata" }],
      [{ setting: "adminWorkspaceAccess", before: "metadata", after: "off" }],
      [{ setting: "adminWorkspaceAccess", before: "off", after: "metadata" }],
    ]);
    expect((await config()).adminWorkspaceAccess).toBe("metadata");
  });

  // The bound check alone would pass such a value: it sorts below every level.
  describe.each([
    ["no cap", {}],
    ["the cap at off", { ADMIN_WORKSPACE_ACCESS_MAX: "off" }],
  ])("with %s", (_name, more) => {
    it.each(["full", "FULL", "", undefined])(
        "refuses a value that is not a level: %j", async value => {
      const { inDo, storageOf, appended, config } = adminSettings();
      await expect(inDo(admin => admin.setAdminWorkspaceAccess(value as never, ACTOR), { more }))
          .rejects.toThrow("Invalid admin workspace access");
      expect(appended).toEqual([]);
      expect((await config()).adminWorkspaceAccess).toBe("metadata");
      expect(JSON.stringify(await inDo(admin => storageOf(admin).adminConfig.get()) ?? null))
          .not.toContain("full");
    });
  });

  it("allows nothing while ADMIN_WORKSPACE_ACCESS_MAX is not a level", async () => {
    const { inDo, appended } = adminSettings({ ADMIN_WORKSPACE_ACCESS_MAX: "none" });
    await expect(inDo(admin => admin.setAdminWorkspaceAccess("metadata", ACTOR)))
        .rejects.toThrow("ADMIN_WORKSPACE_ACCESS_MAX");
    expect(appended).toEqual([]);
    expect((await inDo(admin => admin.getSettings("admin"))).adminWorkspaceAccess)
        .toStrictEqual({ effective: "off", chosen: "metadata", max: "off" });
  });

  it("refuses a retention below ADMIN_AUDIT_RETENTION_MIN_DAYS", async () => {
    const { inDo, appended, config } = adminSettings();
    for (let days of [30, 89, 90.5, 3651]) {
      await expect(inDo(admin => admin.setAdminAuditRetentionDays(days, ACTOR)))
          .rejects.toThrow("ADMIN_AUDIT_RETENTION_MIN_DAYS");
    }
    expect(appended).toEqual([]);
    await inDo(admin => admin.setAdminAuditRetentionDays(120, ACTOR));
    expect((await config()).adminAuditRetentionDays).toBe(120);

    const raised = { more: { ADMIN_AUDIT_RETENTION_MIN_DAYS: "365" } };
    await expect(inDo(admin => admin.setAdminAuditRetentionDays(200, ACTOR), raised))
        .rejects.toThrow("from 365");
    await inDo(admin => admin.setAdminAuditRetentionDays(400, ACTOR), raised);
    expect((await config()).adminAuditRetentionDays).toBe(400);
  });

  it("reports the level and retention enforced, chosen and bounded", async () => {
    const { inDo, appended } = adminSettings();
    await inDo(admin => admin.setAdminAuditRetentionDays(100, ACTOR));

    const settings = (more: object) =>
        inDo(admin => admin.getSettings("admin"), { more });
    expect(await settings({})).toMatchObject({
      adminWorkspaceAccess: { effective: "metadata", chosen: "metadata", max: "metadata" },
      adminAuditRetentionDays: { effective: 100, chosen: 100, min: 90 },
    });
    // Lowering the bounds keeps the admins' choices, but enforces the bounds. A cap that is not a
    // level is "off".
    for (let cap of ["off", "full"]) {
      expect(await settings({
        ADMIN_WORKSPACE_ACCESS_MAX: cap, ADMIN_AUDIT_RETENTION_MIN_DAYS: "180",
      }), cap).toMatchObject({
        adminWorkspaceAccess: { effective: "off", chosen: "metadata", max: "off" },
        adminAuditRetentionDays: { effective: 180, chosen: 100, min: 180 },
      });
    }

    // A record is kept for the retention in effect when it is made.
    await inDo(admin => admin.updateAdminConfig({ siteName: "Acme" }, ACTOR),
        { more: { ADMIN_AUDIT_RETENTION_MIN_DAYS: "180" } });
    expect(appended.at(-1)!.retentionDays).toBe(180);
  });

  it("reads a stored level that is not one as off until an admin chooses", async () => {
    const { inDo, seed, storageOf, records } = adminSettings();
    await seed({ adminWorkspaceAccess: "full" as never });

    expect((await inDo(admin => admin.getSettings("admin"))).adminWorkspaceAccess)
        .toStrictEqual({ effective: "off", chosen: "off", max: "metadata" });
    // The config an inspection computes its policy from.
    expect((await inDo(admin => admin.committedAdminConfig())).adminWorkspaceAccess).toBe("off");
    expect((await inDo(admin => admin.getAdminConfig())).adminWorkspaceAccess).toBe("off");
    // Reading rewrites nothing.
    expect((await inDo(admin => storageOf(admin).adminConfig.get()))?.adminWorkspaceAccess)
        .toBe("full");
    expect(records()).toEqual([]);

    await inDo(admin => admin.setAdminWorkspaceAccess("metadata", ACTOR));
    expect(records()[0]!.changes).toStrictEqual(
        [{ setting: "adminWorkspaceAccess", before: "off", after: "metadata" }]);
    expect((await inDo(admin => storageOf(admin).adminConfig.get()))?.adminWorkspaceAccess)
        .toBe("metadata");
    expect((await inDo(admin => admin.getSettings("admin"))).adminWorkspaceAccess)
        .toStrictEqual({ effective: "metadata", chosen: "metadata", max: "metadata" });
  });

  it("reports writes to workspaces as on only while ADMIN_WORKSPACE_WRITES is on", async () => {
    const { inDo } = adminSettings();
    const writes = async (more: object) =>
        (await inDo(admin => admin.getSettings("admin"), { more })).adminWorkspaceWrites;
    expect(await writes({})).toBe(false);
    expect(await writes({ ADMIN_WORKSPACE_WRITES: "true" })).toBe(false);
    expect(await writes({ ADMIN_WORKSPACE_WRITES: "on" })).toBe(true);
  });

  it("appends to the deployment-wide audit log", async () => {
    const { inDo } = adminSettings();
    const admin = `audit-${crypto.randomUUID()}@example.test`;
    const sessionId = crypto.randomUUID();
    await inDo(settings => settings.updateAdminConfig(
        { siteName: "Logged" }, { ...ACTOR, admin, sessionId }), { fake: false });

    const page = await env.TEST_ADMIN_AUDIT.getByName("").list(
        { kind: "setting", admin, limit: 10 }, 90);
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({
      kind: "setting", admin, sessionId, via: "cli", method: "setSiteName",
      changes: [{ setting: "siteName", before: "", after: "Logged" }],
    });
  });
});
