import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        durableObjects: {
          WEB_SEARCH_GATEKEEPER: { className: "WebSearchGatekeeper", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
