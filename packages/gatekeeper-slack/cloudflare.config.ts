import {
  DEFAULT_GATEKEEPER_WRANGLER, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-slack",
  entrypoint: ".wrangler/validate/src/slack.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage"],
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

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
