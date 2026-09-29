import {
  CAPNWEB_VALIDATE_BUILD, defineGadgetsWorker, textModules,
  type DurableObjectMigration, type WranglerExtras,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-slack",
  entrypoint: ".wrangler/validate/src/slack.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
});

export const wrangler = {
  build: CAPNWEB_VALIDATE_BUILD,
  rules: textModules(["**/*.txt", "**/*.svg"]),
} satisfies WranglerExtras;

export const migrations: DurableObjectMigration[] = [
  {
    tag: "v0",
    new_sqlite_classes: [
      "UserAccount",
      "SlackWorkspaceGatekeeperImpl",
      "SlackConversationGatekeeperImpl",
      "SlackThreadGatekeeperImpl",
    ],
  },
];
