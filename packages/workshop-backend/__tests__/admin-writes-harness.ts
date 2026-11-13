// What the admin-write suites share: an AdminSettings over fresh storage, hosted on an object of
// its own class, whose audit log is a fake.

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
 * with other variables would see the same storage). Its audit log is a fake whose appends land in
 * `appended`, in order; `audit.fail` makes appends throw, and `audit.before` runs, awaited, at the
 * start of each.
 *
 * The host is a TEST_ADMIN_SETTINGS object, so that its state allows whatever the class does with
 * it: workerd refuses storage.setAlarm(), for one, on an object whose class has no alarm()
 * handler. That makes the host a real AdminSettings with the pool's environment, on which an alarm
 * that came due would run, beside the test's instance and over the same storage. So `inDo`
 * replaces the host's own `alarm` with a no-op each time, which leaves an alarm's time real and
 * readable through `state.storage.getAlarm()`; a suite that makes something due calls alarm() on
 * its own instance, inside the `inDo` callback that made it due, and ends each test with
 * `state.storage.deleteAlarm()`.
 */
export function adminWritesHarness(vars: object = {}): {
  inDo<T>(run: (admin: AdminSettings, state: DurableObjectState) => T | Promise<T>,
          more?: object): Promise<T>;
  storageOf(admin: AdminSettings): AdminSettingsStorage;
  appended: AdminAuditRecord[];
  audit: { fail: boolean; before?: () => Promise<void> };
} {
  const stub = env.TEST_ADMIN_SETTINGS.getByName(`admin-writes-${crypto.randomUUID()}`);
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
    inDo: (run, more = {}) => runInDurableObject(stub, (host, state) => {
      Object.assign(host, { alarm: async () => {} });
      const settingsEnv = {
        PUBLIC_BASE_URL: "https://workshop.example/",
        ADMINS: [ADMIN, OTHER_ADMIN],
        ADMIN_WORKSPACE_WRITES: "on",
        ...vars, ...more, BLUEPRINTS,
      };
      const admin = new AdminSettings(state, settingsEnv as unknown as Cloudflare.Env);
      Object.assign(admin, { audits });
      return run(admin, state);
    }),
    storageOf: admin => (admin as unknown as { storage: AdminSettingsStorage }).storage,
    appended,
    audit,
  };
}
