import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * The suites that need the real runtime: `crypto.subtle.timingSafeEqual` and `RpcTarget` do not
 * exist in Node, so a fallback would fail confusingly rather than reporting a broken pool.
 */
export default defineConfig({
  plugins: [cloudflareTest({ miniflare: { compatibilityDate: "2026-02-02" } })],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
