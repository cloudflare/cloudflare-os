import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [capnwebValidate(), cloudflareTest({
    miniflare: {
      compatibilityDate: "2026-09-04",
      compatibilityFlags: ["nodejs_compat", "allow_irrevocable_stub_storage"],
    },
  })],
  test: {
    exclude: ["__tests__/vite-config.test.ts"],
    include: ["__tests__/*.test.ts"],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
