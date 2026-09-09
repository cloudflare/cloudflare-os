import { defineConfig } from "vitest/config";

/**
 * The Node-side tests of the format-blueprint mechanism, in two projects because they need two
 * environments. Neither belongs in `vitest.config.ts`: that suite runs inside workerd, which has
 * no jsdom and cannot spawn the esbuild binary.
 *
 * - `blueprint-lib`: unit tests of the blueprints' own TypeScript sources
 *   (`format-blueprints/<name>/__tests__/**`). These are gadget modules, so they get a jsdom
 *   document; a pure module's test opts into node with a `// @vitest-environment node` header.
 *   The project passes when no blueprint has tests.
 * - `blueprint-build`: `scripts/format-blueprint-files.ts`, whose TypeScript bundling drives
 *   esbuild. The same file is also collected by the workerd suite for its archive-format and path
 *   tests, where the bundling cases skip themselves.
 */
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
