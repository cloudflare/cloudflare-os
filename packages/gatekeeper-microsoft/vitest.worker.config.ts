import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

/**
 * The workerd project: the account Durable Object, the gatekeeper Durable Object reached through a
 * `TestHooks` facet as the overseer reaches it, and the configurator capability, against a fake
 * Graph. The `@validateRpc()` decorators are applied in-memory by the capnweb-validate plugin, since
 * `.wrangler/validate` is not built for tests.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        // Kept in step with wrangler.jsonc; a drift here tests a runtime we do not deploy.
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        modulesRules: [
          { type: "Text", include: ["**/*.txt", "**/*.svg"] },
        ],
        durableObjects: {
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          SHAREPOINT_GATEKEEPER: { className: "SharePointGatekeeper", useSQLite: true },
          OUTLOOK_GATEKEEPER: { className: "OutlookGatekeeper", useSQLite: true },
          OUTLOOK_HOOK_DRIVER: { className: "OutlookHookDriver", useSQLite: true },
          CALENDAR_GATEKEEPER: { className: "CalendarGatekeeper", useSQLite: true },
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
        },
        bindings: {
          CLIENT_ID: "00000000-0000-0000-0000-00000000c1d0",
          CLIENT_SECRET: "test-client-secret",
          BASE_URL: "http://localhost:8787/gatekeeper/microsoft",
          MICROSOFT_TENANT_ID: "11111111-1111-1111-1111-111111111111",
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
