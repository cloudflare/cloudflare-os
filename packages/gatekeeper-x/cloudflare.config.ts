import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

/**
 * No `vars`: every setting has an in-code default. A deployment may set `X_DAILY_READ_LIMIT` (the
 * per-connection daily read limit, default 2,000), and `WEBHOOK_ORIGIN` with the
 * `X_APP_BEARER_TOKEN` secret to enable push notifications.
 */
export default defineGadgetsWorker({
  name: "gatekeeper-x",
  entrypoint: ".wrangler/validate/src/x.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "XGatekeeperImpl"] },
];
