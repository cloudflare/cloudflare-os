import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { COMPATIBILITY_DATE } from "@gadgets/scripts/worker-config";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

/**
 * The workerd project: the gatekeeper's Durable Objects, loaded with a test worker that reaches
 * them as the overseer does. `@validateRpc()` is applied in memory by the capnweb-validate
 * plugin, since `.wrangler/validate` is not built for tests.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        // Kept in step with cloudflare.config.ts; a drift here tests a runtime we do not deploy.
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        modulesRules: [{ type: "Text", include: ["**/*.txt", "**/*.svg"] }],
        durableObjects: {
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          ACME_GATEKEEPER: { className: "AcmeGatekeeperImpl", useSQLite: true },
          // #if hooks
          ACME_HOOK_DRIVER: { className: "AcmeHookDriver", useSQLite: true },
          // #endif
          TEST_HOST: { className: "TestHost", useSQLite: true },
        },
        // What the suites need of the Worker's environment: its secrets go here too.
        bindings: { BASE_URL: "https://gadgets.test/gatekeeper/acme" },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
