import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

/**
 * The suite that has to run in workerd, because what it covers -- the session-side git-cache
 * wiring (where every commit id a read returns must be advertised) and the push action's
 * queue/simulate/apply/revert flow on the real gatekeeper Durable Object -- is built on
 * `RpcTarget`, `RpcStub`, and `DurableObject` props. The sibling `vitest.config.ts` keeps the
 * pure-logic tests in Node, where they are far cheaper.
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
        // wrangler.jsonc's Text-module rules, which github.ts's .txt/.svg imports rely on.
        modulesRules: [
          { type: "Text", include: ["**/*.txt", "**/*.svg"] },
        ],
        durableObjects: {
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          GITHUB_GATEKEEPER: { className: "GitHubGatekeeperImpl", useSQLite: true },
          // The gatekeeper DO reads `ctx.props`, and a `DurableObjectClass` carrying props is
          // only reachable through `ctx.facets` -- so the tests drive it from a hook Durable
          // Object, exactly as the overseer does in production, rather than a plain namespace
          // binding.
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
