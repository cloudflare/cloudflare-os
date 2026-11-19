import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

/**
 * The suite that has to run in workerd, because what it covers -- the subresources every read
 * reports, and the observer checks each binding and the observer's own `UserAccount` answer -- is
 * built on `RpcTarget`, `RpcStub`, Durable Object facets and props. The sibling `vitest.config.ts`
 * keeps the pure-logic tests in Node, where they are far cheaper.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        // cloudflare.config.ts's Text-module rules, which slack.ts's .txt/.svg imports rely on.
        modulesRules: [
          { type: "Text", include: ["**/*.txt", "**/*.svg"] },
        ],
        durableObjects: {
          USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          // The bindings with a storage-seeding hook (see worker.ts), registered so `ctx.exports`
          // carries them.
          TEST_WORKSPACE_GATEKEEPER: { className: "TestWorkspaceGatekeeper", useSQLite: true },
          TEST_CONVERSATION_GATEKEEPER: { className: "TestConversationGatekeeper", useSQLite: true },
          TEST_THREAD_GATEKEEPER: { className: "TestThreadGatekeeper", useSQLite: true },
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
