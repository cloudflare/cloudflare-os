import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The Node-side tests of the format-blueprint mechanism, in two projects because they need two
 * environments. Neither belongs in `vitest.config.ts`: that suite runs inside workerd, which has
 * no jsdom and cannot spawn the esbuild binary. `test:run` and the vp `test` task run this config;
 * `test:watch:blueprints` watches it.
 *
 * - `blueprint-lib`: unit tests of the blueprints' own TypeScript sources
 *   (`format-blueprints/<name>/__tests__/**`). These are gadget modules, so they get a jsdom
 *   document; a pure module's test opts into node with a `// @vitest-environment node` header.
 *   The project passes when no blueprint has tests.
 * - `blueprint-build`: `scripts/format-blueprint-files.ts`, whose TypeScript bundling drives
 *   esbuild. The same file is also collected by the workerd suite for its archive-format and path
 *   tests, where the bundling cases skip themselves.
 */

// A gadget's `gadgets:<name>/<side>` import resolves through its pins when the kernel loads it; a
// blueprint test that imports a module reaching one gets the library's source instead (as
// vitest.config.ts does for the workerd suite). Only `blueprint-lib` needs it: the build tests
// drive esbuild, which leaves the specifier in place as an external.
const gadgetLibraries = resolve(dirname(fileURLToPath(import.meta.url)), "..", "gadget-libraries");

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "blueprint-lib",
          include: ["format-blueprints/*/__tests__/**/*.test.ts"],
          environment: "jsdom",
          passWithNoTests: true,
        },
        resolve: {
          alias: [{
            find: /^gadgets:([a-z][a-z0-9-]*)\/(client|server)$/u,
            replacement: `${gadgetLibraries}/$1/$2.ts`,
          }],
        },
      },
      {
        test: {
          name: "blueprint-build",
          include: ["__tests__/format-blueprint-files.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
