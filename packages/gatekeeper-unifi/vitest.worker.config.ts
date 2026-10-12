import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/**
 * The suite that has to run in workerd: the connect flow and the account's request egress (Durable
 * Object storage, persisted stubs, `crypto.subtle.timingSafeEqual`), and the sessions, whose every
 * read must reach the approval queue and whose actions resolve through the facet. The sibling
 * `vitest.config.ts` keeps the pure-logic tests in Node, where they are far cheaper.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        modulesRules: [{ type: "Text", include: ["**/*.txt", "**/*.svg"] }],
        bindings: { BASE_URL: "https://gadgets.example/gatekeeper/unifi" },
        durableObjects: {
          UNIFI_ACCOUNT: { className: "UnifiAccount", useSQLite: true },
          UNIFI_GATEKEEPER: { className: "UnifiGatekeeper", useSQLite: true },
          // A gatekeeper DO reads `ctx.props`, and a `DurableObjectClass` carrying props is only
          // reachable through `ctx.facets` -- so tests drive it from a hook Durable Object, exactly
          // as the overseer does in production, rather than a plain namespace binding.
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
