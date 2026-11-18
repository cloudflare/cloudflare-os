import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/**
 * Workerd coverage for Google resource configurators and the Gmail, Chat, Calendar and BigQuery
 * Durable Objects, and for the Drive, Docs, Sheets and Slides observer checks.
 */
export default defineConfig({
  plugins: [
    // The tests' program, which holds the PDF renderer's entrypoint the pool's Worker exports: a
    // class outside the program is not given its validators, and refuses to be loaded without.
    capnwebValidate({ tsconfig: "tsconfig.test.json" }),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        // The pool takes its module rules from here, not from the Worker's configuration, and the
        // PDF renderer's PDFium build is imported as a compiled WebAssembly module.
        modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
        // The PDF renderer, which the pool's Worker exports beside the gatekeeper.
        serviceBindings: {
          PDF_RENDERER: { name: kCurrentWorker, entrypoint: "PdfRenderer" },
          // Workers AI cannot run in the pool: a fake answers the fetches the gatekeeper makes of it.
          AI: { name: kCurrentWorker, entrypoint: "FakeAi" },
        },
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
      "__tests__/workerd/drive-pdf.test.ts",
      "__tests__/workerd/gmail-actions.test.ts",
      "__tests__/workerd/gmail-hooks.test.ts",
      "__tests__/workerd/gmail-observers.test.ts",
      "__tests__/workerd/gmail-pdf.test.ts",
      "__tests__/workerd/gmail-state.test.ts",
      "__tests__/workerd/pdf-rendering.test.ts",
      "__tests__/workerd/workspace-observers.test.ts",
    ],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
