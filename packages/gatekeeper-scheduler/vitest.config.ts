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
        durableObjects: {
          SCHEDULE_DRIVER: { className: "ScheduleDriver", useSQLite: true },
          SCHEDULER_SCOPE_TEST_PARENT: {
            className: "SchedulerScopeTestParent",
            useSQLite: true,
          },
          SCHEDULER_SCOPE_TEST_FACET: {
            className: "SchedulerScopeTestFacet",
            useSQLite: true,
          },
        },
        serviceBindings: {
          TEST_HOOKS: { name: kCurrentWorker, entrypoint: "TestHooks" },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["../../test-setup/assert-workerd.ts"],
  },
});
