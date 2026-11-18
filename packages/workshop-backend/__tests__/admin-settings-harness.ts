// What the AdminSettings suites that drive it directly share: an AdminSettings over fresh storage,
// hosted on an object of its own class, whose audit log is a fake.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AdminAuditRecord } from "@gadgets/workshop-shared/api";
import { AdminSettings } from "../src/admin-settings.js";
import type { AdminSettingsStorage } from "../src/storage-schema/admin-settings-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_ADMIN_SETTINGS: DurableObjectNamespace<AdminSettings>;
  }
}

/** A deployment admin of the harness's default environment. */
export const ADMIN = "admin@example.test";

/** The other deployment admin of the harness's default environment. */
export const OTHER_ADMIN = "other-admin@example.test";

/**
 * An AdminSettings over fresh storage, on the state of a TEST_ADMIN_SETTINGS object, with `vars`
 * over the defaults as its environment (and `more` over those for one call, as a later isolate
 * with other variables would see the same storage). The default environment's level in force is
 * "content". Its audit log is a fake whose appends land in `appended`, in order; `audit.fail`
 * makes appends throw, and `audit.before` runs, awaited, at the start of each.
 */
export function adminSettingsHarness(vars: object = {}): {
  inDo<T>(run: (admin: AdminSettings, state: DurableObjectState) => T | Promise<T>,
          more?: object): Promise<T>;
  storageOf(admin: AdminSettings): AdminSettingsStorage;
  appended: AdminAuditRecord[];
  audit: { fail: boolean; before?: () => Promise<void> };
} {
  const stub = env.TEST_ADMIN_SETTINGS.getByName(`admin-settings-${crypto.randomUUID()}`);
  const appended: AdminAuditRecord[] = [];
  const audit: { fail: boolean; before?: () => Promise<void> } = { fail: false };
  const audits = { getByName: () => ({
    append: async (record: AdminAuditRecord) => {
      await audit.before?.();
      if (audit.fail) throw new Error("audit log unavailable");
      appended.push(record);
    },
  }) };
  const blueprints = new Map<string, string>();
  const BLUEPRINTS = {
    put: async (key: string, value: string) => { blueprints.set(key, value); },
    get: async (key: string) => blueprints.get(key) ?? null,
  };

  return {
    inDo: (run, more = {}) => runInDurableObject(stub, async (_host, state) => {
      const settingsEnv = {
        ADMINS: [ADMIN, OTHER_ADMIN],
        ADMIN_WORKSPACE_ACCESS_MAX: "content",
        ...vars, ...more, BLUEPRINTS,
      };
      const admin = new AdminSettings(state, settingsEnv as unknown as Cloudflare.Env);
      Object.assign(admin, { audits });
      return await run(admin, state);
    }),
    storageOf: admin => (admin as unknown as { storage: AdminSettingsStorage }).storage,
    appended,
    audit,
  };
}
