import {
  CAPNWEB_VALIDATE_BUILD, OBSERVABILITY, defineGadgetsWorker, textModules,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-google",
  entrypoint: ".wrangler/validate/src/google.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
  observability: OBSERVABILITY,
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
  rules: textModules(["**/*.txt", "**/*.svg"]),
} satisfies WranglerExtras;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "GmailGatekeeperImpl"] },
  { tag: "v1", new_sqlite_classes: ["BigQueryGatekeeperImpl"] },
  { tag: "v2", new_sqlite_classes: ["GoogleCalendarGatekeeperImpl"] },
  { tag: "v3", new_sqlite_classes: ["GoogleSheetsGatekeeperImpl"] },
  { tag: "v4", new_sqlite_classes: ["GoogleDriveGatekeeperImpl", "GoogleDocGatekeeperImpl"] },
  { tag: "v5", new_sqlite_classes: ["GoogleChatGatekeeperImpl"] },
];
