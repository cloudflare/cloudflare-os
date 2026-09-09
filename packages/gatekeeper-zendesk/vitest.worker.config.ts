import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

/**
 * The suite that has to run in workerd. What it covers -- turning
 * `ctx.exports.ZendeskGatekeeper({props})` into something the Work Items app UI can actually call --
 * is `ctx.facets` plus Durable Object props, and neither has a stand-in outside the real runtime.
 * A mock would have re-admitted the shipped bug: any hand-written double happily answers
 * `sourceStatuses()` whether it was handed a live stub or a `DurableObjectClass`.
 *
 * The sibling `vitest.config.ts` keeps the pure-logic tests in Node, where they are far cheaper.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        // Kept in step with wrangler.jsonc; a drift here tests a runtime we do not deploy.
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        bindings: {
          BASE_URL: "https://odie.example/gatekeeper/zendesk",
          CLIENT_ID: "test-client-id",
          CLIENT_SECRET: "test-client-secret",
        },
        durableObjects: {
          ZENDESK_ACCOUNT: { className: "ZendeskAccount", useSQLite: true },
          // Declared so miniflare can construct the class the account opens as a facet. Nothing
          // binds to this namespace directly -- doing so is precisely the "arbitrary standalone
          // instance" the account-owned facet exists to avoid.
          ZENDESK_GATEKEEPER: { className: "ZendeskGatekeeper", useSQLite: true },
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
