import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

export default defineConfig({
  plugins: [capnwebValidate(), cloudflareTest({
    miniflare: {
      compatibilityDate,
      compatibilityFlags,
    },
  })],
  test: {
    exclude: ["__tests__/vite-config.test.ts"],
    include: ["__tests__/*.test.ts"],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
