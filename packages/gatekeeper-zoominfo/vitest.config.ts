import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/**
 * The workerd project: the account Durable Object's credentials and identity, and the gatekeeper
 * Durable Object reached through a `TestHooks` facet, as the overseer reaches it. The
 * `@validateRpc()` decorators are applied in-memory by the capnweb-validate plugin, since
 * `.wrangler/validate` is not built for tests.
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
        // A class reaches `ctx.exports` as a Durable Object class, which facets need, only when
        // declared here.
        durableObjects: {
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          TEST_GATEKEEPER: { className: "TestGatekeeper", useSQLite: true },
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
        },
        bindings: {
          CLIENT_ID: "test-client-id",
          CLIENT_SECRET: "test-client-secret",
          BASE_URL: "http://localhost:8787/gatekeeper/zoominfo",
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    // The Node project's: see vitest.node.config.ts.
    exclude: ["__tests__/upstream.test.ts"],
    // Asserts the pool started, and that every request a test sends to ZoomInfo has a name.
    setupFiles: ["@gadgets/scripts/assert-workerd", "./__tests__/named-requests.ts"],
  },
});
