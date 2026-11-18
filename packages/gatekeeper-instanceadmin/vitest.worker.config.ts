import { readFileSync } from "node:fs";
import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

const { compatibilityDate, compatibilityFlags } = deployed.worker;

// Wrangler ships `*.txt` imports as Text modules, but this pool is driven from inline miniflare
// settings, where Vite would resolve the agent types' `.txt`, a symlink to its `.d.ts`, to that
// file and send it through the TypeScript pipeline, leaving the import `undefined`. Resolving by
// the import path, as wrangler does, keeps Vite from following the link.
const textModules: Plugin = {
  name: "text-modules",
  enforce: "pre",
  resolveId(source, importer) {
    if (source.endsWith(".txt") && importer !== undefined) {
      return path.resolve(path.dirname(importer), source);
    }
  },
  load(id) {
    if (id.endsWith(".txt")) {
      return `export default ${JSON.stringify(readFileSync(id, "utf-8"))};`;
    }
  },
};

/**
 * The workerd project: the facet, its sessions and their stubs are RpcTargets and a Durable
 * Object, and the facet runs validated (capnwebValidate()), as it does when deployed. The sibling
 * `vitest.config.ts` keeps the generated surface in Node.
 */
export default defineConfig({
  plugins: [
    textModules,
    capnwebValidate(),
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate,
        compatibilityFlags,
        durableObjects: {
          // Declared only here; production reaches this class through facets.
          INSTANCE_ADMIN_GATEKEEPER: { className: "InstanceAdminGatekeeper", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@gadgets/scripts/assert-workerd"],
    // Vitest's module cache hands `.txt` modules back under ids `textModules` cannot read, so
    // every run after the first would fail.
    fsModuleCache: false,
  },
});
