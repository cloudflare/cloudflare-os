import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

/**
 * Tests run inside workerd so they can exercise modules that import "cloudflare:workers"
 * (github.ts), not just the standalone API helpers.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        durableObjects: {
          GITHUB_TEST_PARENT: { className: "GitHubTestParent", useSQLite: true },
          GITHUB_GATEKEEPER_IMPL: { className: "GitHubGatekeeperImpl", useSQLite: true },
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
