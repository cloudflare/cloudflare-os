import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

/** Workerd coverage for Gmail, nested Drive sessions, and the Google Doc Durable Object. */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        // Kept in step with wrangler.jsonc; drift here tests a runtime we do not deploy.
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        bindings: {CLIENT_ID: "test-client", CLIENT_SECRET: "test-secret"},
        // Facets and loopback namespaces need test-only registrations in this test pool.
        durableObjects: {
          GOOGLE_DOC_GATEKEEPER: { className: "GoogleDocGatekeeperImpl", useSQLite: true },
          TEST_HOOKS: { className: "GoogleDocTestHooks", useSQLite: true },
          USER_ACCOUNT: { className: "GoogleDocUserAccount", useSQLite: true },
          GmailGatekeeperImpl: {className: "GmailGatekeeperImpl", useSQLite: true},
          TestHooks: {className: "TestHooks", useSQLite: true},
          UserAccount: {className: "UserAccount", useSQLite: true},
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
