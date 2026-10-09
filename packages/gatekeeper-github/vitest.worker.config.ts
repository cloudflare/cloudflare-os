import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/**
 * The suite that has to run in workerd, because what it covers -- the session-side git-cache
 * wiring (where every commit id a read returns must be advertised), the push action's
 * queue/simulate/apply/revert flow on the real gatekeeper Durable Object, and the account's
 * credential refresh and expiry -- is built on `RpcTarget`, `RpcStub`, and `DurableObject` props.
 * The sibling `vitest.config.ts` keeps the pure-logic tests in Node, where they are far cheaper.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        // cloudflare.config.ts's Text-module rules, which github.ts's .txt/.svg imports rely on.
        modulesRules: [
          { type: "Text", include: ["**/*.txt", "**/*.svg"] },
        ],
        // Fake OAuth client credentials, so the account's code exchange and refresh can run.
        bindings: { CLIENT_ID: "test-client", CLIENT_SECRET: "test-secret" },
        durableObjects: {
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          GITHUB_GATEKEEPER: { className: "GitHubGatekeeperImpl", useSQLite: true },
          // The gatekeeper with a storage-seeding hook (see worker.ts), registered so `ctx.exports`
          // carries it.
          SEEDED_GITHUB_GATEKEEPER: { className: "SeededGitHubGatekeeper", useSQLite: true },
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
