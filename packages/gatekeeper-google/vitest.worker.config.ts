import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/** Workerd coverage for Google resource configurators and the Gmail and Chat Durable Objects. */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        bindings: {
          CLIENT_ID: "test-client", CLIENT_SECRET: "test-secret",
          PUBSUB_TOPIC: "projects/test/topics/chat", PUBSUB_PUSH_SERVICE_ACCOUNT: "push@test.iam.gserviceaccount.com",
        },
        durableObjects: {
          ChatHookDriver: {className: "ChatHookDriver", useSQLite: true},
          GmailGatekeeperImpl: {className: "GmailGatekeeperImpl", useSQLite: true},
          GmailHookDriver: {className: "GmailHookDriver", useSQLite: true},
          GoogleChatGatekeeperImpl: {className: "GoogleChatGatekeeperImpl", useSQLite: true},
          TestHooks: {className: "TestHooks", useSQLite: true},
          UserAccount: {className: "UserAccount", useSQLite: true},
        },
      },
    }),
  ],
  test: {
    include: [
      "__tests__/workerd/chat-actions.test.ts",
      "__tests__/workerd/chat-hooks.test.ts",
      "__tests__/workerd/configurators.test.ts",
      "__tests__/workerd/gmail-actions.test.ts",
      "__tests__/workerd/gmail-hooks.test.ts",
      "__tests__/workerd/gmail-state.test.ts",
    ],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
