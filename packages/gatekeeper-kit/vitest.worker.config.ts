import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * The suites that need the real runtime: `crypto.subtle.timingSafeEqual` and `RpcTarget` do not
 * exist in Node, so a fallback would fail confusingly rather than reporting a broken pool.
 *
 * `allow_irrevocable_stub_storage` is the deployment contract `trackedSetObservers` carries: it
 * persists verifier stubs, which the Node fake cannot model because it clones every stored value.
 */
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
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
