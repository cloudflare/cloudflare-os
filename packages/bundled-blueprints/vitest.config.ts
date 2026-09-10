import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Two projects, because the two kinds of test here need two environments.
 *
 * - `gadgets`: unit tests of the blueprints' and the libraries' own TypeScript sources
 *   (`blueprints/<name>/__tests__/**`, `libraries/<name>/__tests__/**`). These are gadget modules,
 *   so they get a jsdom document by default; a pure module's test opts into node with a
 *   `// @vitest-environment node` header. A blueprint's `@gadgets/bundled-blueprints/libraries/...`
 *   import is this package referring to itself by name, which Vite resolves through the `exports`
 *   in package.json with no alias; `cloudflare:workers` is aliased to a stub of its base classes,
 *   so a module that declares a Durable Object can be imported at all -- the archives the build
 *   produces are still installed and inspected inside workerd by the Workshop backend's suite.
 * - `build`: the build itself (`__tests__/**`), whose TypeScript bundling drives esbuild's native
 *   binary. Node code, run under node.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "gadgets",
          include: [
            "blueprints/*/__tests__/**/*.test.ts",
            "libraries/*/__tests__/**/*.test.ts",
          ],
          environment: "jsdom",
        },
        resolve: {
          alias: [
            {
              find: "cloudflare:workers",
              replacement: resolve(here, "__tests__/stubs/cloudflare-workers.ts"),
            },
          ],
        },
      },
      {
        test: {
          name: "build",
          include: ["__tests__/**/*.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
