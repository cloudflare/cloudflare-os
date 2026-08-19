import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [capnwebValidate(), cloudflareTest({
    miniflare: {
      compatibilityDate: "2026-02-02",
      compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
    },
  })],
  test: {
    fileParallelism: false,
    exclude: ["__tests__/vite-config.test.ts"],
    include: ["__tests__/*.test.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
  },
});
