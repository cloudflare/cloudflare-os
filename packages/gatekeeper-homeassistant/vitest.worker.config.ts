import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

/**
 * The workerd project: the account Durable Object's credentials, and the gatekeeper Durable Object
 * reached through a `TestHooks` facet, as the overseer reaches it. The `@validateRpc()` decorators
 * are applied in-memory by the capnweb-validate plugin, since `.wrangler/validate` is not built for
 * tests.
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
          { type: "Text", include: ["**/*.txt"] },
        ],
        durableObjects: {
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          HOMEASSISTANT_GATEKEEPER: { className: "HomeAssistantGatekeeperImpl", useSQLite: true },
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
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
