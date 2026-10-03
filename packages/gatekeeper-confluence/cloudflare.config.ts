import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-confluence",
  entrypoint: ".wrangler/validate/src/confluence.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  {
    tag: "v0",
    new_sqlite_classes: [
      "UserAccount",
      "ConfluenceSiteGatekeeperImpl",
      "ConfluenceSpaceGatekeeperImpl",
      "ConfluenceContentGatekeeperImpl",
    ],
  },
];
