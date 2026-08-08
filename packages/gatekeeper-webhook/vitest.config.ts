import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        bindings: { BASE_URL: "http://localhost:8787/gatekeeper/webhook" },
        durableObjects: {
          ENDPOINT_REGISTRY: { className: "EndpointRegistry", useSQLite: true },
          ENDPOINT_INDEX: { className: "EndpointIndex", useSQLite: true },
          WEBHOOK_SCOPE_TEST_PARENT: { className: "WebhookScopeTestParent", useSQLite: true },
          WEBHOOK_SCOPE_TEST_FACET: { className: "WebhookScopeTestFacet", useSQLite: true },
        },
        serviceBindings: {
          TEST_HOOKS: { name: kCurrentWorker, entrypoint: "TestHooks" },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
  },
});
