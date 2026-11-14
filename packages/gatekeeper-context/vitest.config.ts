import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

export default defineConfig({
  plugins: [capnwebValidate(), cloudflareTest({
    main: "./__tests__/worker.ts",
    miniflare: {
      compatibilityDate,
      compatibilityFlags,
      kvNamespaces: ["CONTEXT_COLLECTIONS"],
      durableObjects: {
        COLLECTIONS: { className: "ContextCollectionDurableObject", useSQLite: true },
        USER_LIBRARIES: { className: "UserLibraryDurableObject", useSQLite: true },
        REGISTRIES: { className: "LibraryRegistryDurableObject", useSQLite: true },
      },
    },
  })],
  resolve: {
    // The management app bundle is built separately; the worker only embeds it.
    alias: [{
      find: /^\.\/generated\/app\.txt$/,
      replacement: fileURLToPath(new URL("./__tests__/app-stub.txt", import.meta.url)),
    }],
  },
  test: {
    exclude: ["__tests__/vite-config.test.ts"],
    include: ["__tests__/*.test.ts"],
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
