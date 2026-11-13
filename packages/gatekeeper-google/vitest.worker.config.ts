import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/**
 * Workerd coverage for Google resource configurators and the Gmail, Chat, Calendar and BigQuery
 * Durable Objects, and for the Drive, Docs, Sheets and Slides observer checks.
 */
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
          PUBSUB_CHAT_TOPIC: "projects/test/topics/chat", PUBSUB_GMAIL_TOPIC: "projects/test/topics/gmail",
          PUBSUB_PUSH_SERVICE_ACCOUNT: "push@test.iam.gserviceaccount.com",
        },
        durableObjects: {
          BigQueryGatekeeperImpl: {className: "BigQueryGatekeeperImpl", useSQLite: true},
          ChatHookDriver: {className: "ChatHookDriver", useSQLite: true},
          GmailGatekeeperImpl: {className: "GmailGatekeeperImpl", useSQLite: true},
          GmailHookDriver: {className: "GmailHookDriver", useSQLite: true},
          GoogleCalendarGatekeeperImpl: {className: "GoogleCalendarGatekeeperImpl", useSQLite: true},
          GoogleChatGatekeeperImpl: {className: "GoogleChatGatekeeperImpl", useSQLite: true},
          GoogleDocGatekeeperImpl: {className: "GoogleDocGatekeeperImpl", useSQLite: true},
          GoogleDriveGatekeeperImpl: {className: "GoogleDriveGatekeeperImpl", useSQLite: true},
          GoogleSheetsGatekeeperImpl: {className: "GoogleSheetsGatekeeperImpl", useSQLite: true},
          GoogleSlidesGatekeeperImpl: {className: "GoogleSlidesGatekeeperImpl", useSQLite: true},
          TestHooks: {className: "TestHooks", useSQLite: true},
          UserAccount: {className: "UserAccount", useSQLite: true},
        },
      },
    }),
  ],
  test: {
    testTimeout: 15_000,
    include: [
      "__tests__/workerd/bigquery-observers.test.ts",
      "__tests__/workerd/calendar-observers.test.ts",
      "__tests__/workerd/chat-actions.test.ts",
      "__tests__/workerd/chat-hooks.test.ts",
      "__tests__/workerd/chat-observers.test.ts",
      "__tests__/workerd/configurators.test.ts",
      "__tests__/workerd/gmail-actions.test.ts",
      "__tests__/workerd/gmail-hooks.test.ts",
      "__tests__/workerd/gmail-observers.test.ts",
      "__tests__/workerd/gmail-state.test.ts",
      "__tests__/workerd/session-queue-release.test.ts",
      "__tests__/workerd/workspace-observers.test.ts",
    ],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
