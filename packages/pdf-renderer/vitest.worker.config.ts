import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate } = deployed.worker;

/**
 * Workerd coverage for the Worker as it is deployed: its PDFium build as the pool imports it, and
 * its entrypoint called over a service binding.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate,
        // The pool takes its module rules from here, not from the Worker's configuration, and
        // the PDFium build is imported as a compiled WebAssembly module.
        modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
        serviceBindings: {
          PDF_RENDERER: { name: kCurrentWorker, entrypoint: "PdfRenderer" },
        },
      },
    }),
  ],
  test: {
    testTimeout: 15_000,
    include: ["__tests__/workerd/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@gadgets/scripts/assert-workerd"],
  },
});
