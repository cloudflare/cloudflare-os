import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

/** Workerd coverage for nested Drive sessions and the Google Doc Durable Object. */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        // Kept in step with wrangler.jsonc; drift here tests a runtime we do not deploy.
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        // Facets and loopback namespaces need test-only registrations in this test pool.
        durableObjects: {
          GOOGLE_DOC_GATEKEEPER: { className: "GoogleDocGatekeeperImpl", useSQLite: true },
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: [
      "__tests__/workerd/google-doc-actions.test.ts",
      "__tests__/workerd/native-sessions.test.ts",
    ],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
