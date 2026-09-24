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
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        modulesRules: [{ type: "Text", include: ["**/*.txt"] }],
        durableObjects: {
          WEBHOOK_ACCOUNT: { className: "UserAccount", useSQLite: true },
          WEBHOOK_RECEIVER: { className: "WebhookReceiver", useSQLite: true },
          WEBHOOK_ENDPOINT_REGISTRY: { className: "WebhookEndpointRegistry", useSQLite: true },
          TEST_GADGET: { className: "TestGadget", useSQLite: true },
          TEST_WORKSHOP: { className: "TestWorkshop", useSQLite: true },
        },
        serviceBindings: {
          TEST_HOOKS: { name: kCurrentWorker, entrypoint: "TestHooks" },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
