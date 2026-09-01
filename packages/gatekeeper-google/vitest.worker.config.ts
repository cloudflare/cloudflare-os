import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

/** Workerd coverage for Gmail sessions and the Gmail Durable Object. */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        bindings: {CLIENT_ID: "test-client", CLIENT_SECRET: "test-secret"},
        durableObjects: {
          GmailGatekeeperImpl: {className: "GmailGatekeeperImpl", useSQLite: true},
          TestHooks: {className: "TestHooks", useSQLite: true},
          UserAccount: {className: "UserAccount", useSQLite: true},
        },
      },
    }),
  ],
  test: {
    include: [
      "__tests__/workerd/gmail-actions.test.ts",
      "__tests__/workerd/gmail-state.test.ts",
    ],
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
