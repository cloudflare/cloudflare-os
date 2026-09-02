import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** These suites require workerd-only APIs and persistent verifier-stub storage. */
export default defineConfig({
  plugins: [cloudflareTest({
    main: "./__tests__/workerd/worker.ts",
    miniflare: {
      compatibilityDate: "2026-02-02",
      compatibilityFlags: ["allow_irrevocable_stub_storage"],
      durableObjects: { TRACKER_HOST: { className: "TrackerHost", useSQLite: true } },
    },
  })],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
