import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import { generate } from "./__tests__/workerd/generate.ts";

/**
 * The workerd project: a gatekeeper generated from the template, loaded as a Worker, so that what
 * `pnpm create-gatekeeper` writes is run and not only compiled. The suite imports the generated
 * sources as `#gatekeeper/<module>`. `@validateRpc()` is applied in memory by the capnweb-validate
 * plugin, as in a gatekeeper's own workerd suite.
 */
const gatekeeper = generate({ auth: "api-key", hooks: "subscription" });

export default defineConfig({
  resolve: { alias: { "#gatekeeper": `${gatekeeper}/src` } },
  // The generated package lies outside this one.
  server: { fs: { allow: [gatekeeper, "../.."] } },
  plugins: [
    // Told where the generated sources are: it transforms the modules of one TypeScript project.
    capnwebValidate({ cwd: gatekeeper, tsconfig: `${gatekeeper}/tsconfig.json` }),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        // Kept in step with scripts/worker-config.ts and the template's cloudflare.config.ts.
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        modulesRules: [{ type: "Text", include: ["**/*.txt", "**/*.svg"] }],
        durableObjects: {
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          ACME_GATEKEEPER: { className: "AcmeGatekeeperImpl", useSQLite: true },
          ACME_HOOK_DRIVER: { className: "AcmeHookDriver", useSQLite: true },
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
          TEST_HOST: { className: "TestHost", useSQLite: true },
        },
        bindings: {
          // An `https` one, which a gatekeeper that adds its own webhooks needs.
          BASE_URL: "https://gadgets.test/gatekeeper/acme",
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
