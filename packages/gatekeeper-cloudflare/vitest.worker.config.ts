import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/**
 * The suite that has to run in workerd, because what it covers -- the approval-queue audit on every
 * read, the collaborator ACL, and stub disposal -- is built on `RpcTarget`, `RpcStub`, and
 * `DurableObject` props. The sibling `vitest.config.ts` keeps the pure-logic tests in Node, where
 * they are far cheaper.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        // `UserAccount` refuses to refresh without client credentials; the provider itself is stubbed.
        bindings: { CLIENT_ID: "client", CLIENT_SECRET: "secret" },
        durableObjects: {
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          OBSERVABILITY_GATEKEEPER: {
            className: "CloudflareObservabilityGatekeeper",
            useSQLite: true,
          },
          // The gatekeeper DO reads `ctx.props`, and a `DurableObjectClass` carrying props is only
          // reachable through `ctx.facets` -- so the tests drive it from a hook Durable Object,
          // exactly as the overseer does in production, rather than a plain namespace binding.
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
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
