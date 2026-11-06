import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

/** No `vars`: the OAuth client is the `CLIENT_ID` and `CLIENT_SECRET` secrets. */
export default defineGadgetsWorker({
  name: "gatekeeper-pagerduty",
  entrypoint: ".wrangler/validate/src/pagerduty.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "PagerDutyGatekeeperImpl"] },
];
