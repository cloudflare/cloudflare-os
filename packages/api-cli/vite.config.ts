/**
 * Vite+ settings for `@gadgets/api-cli`: a hand-declared `test` task.
 *
 * `node --test`, not vitest: the CLI's suites are written for the platform test runner, as
 * `scripts/`' are, and need nothing vitest adds. So this cannot use the shared `vitestTask()`, which
 * wraps vitest, only its watchdog (`withTestTimeout`), declaring the watchdog's policy variables in
 * `cache.env` so a cached run keeps them (`scripts/vitest-task.test.ts` checks it).
 *
 * The suites run from this package and write only under the OS temp directory: a suite writing in
 * the workspace would be writing its own cached input.
 */

import { TESTS_WITH_TIMEOUT_ENV, withTestTimeout } from "@gadgets/scripts/vitest-task";

export default {
  run: {
    tasks: {
      test: {
        command: withTestTimeout("node --test 'src/**/*.test.ts' 'generator/**/*.test.ts'"),
        cache: {
          env: TESTS_WITH_TIMEOUT_ENV,
          input: [
            { auto: true },
            { pattern: "!**/node_modules/.vite/**", base: "workspace" },
            { pattern: "!**/node_modules/.vite-temp/**", base: "workspace" },
            { pattern: "!**/.wrangler/**", base: "workspace" },
          ],
          // No artifacts: the terminal output is still replayed on a hit.
          output: [],
        },
      },
    },
  },
};
