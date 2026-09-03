/**
 * Vite+ settings for `@gadgets/scripts`. Only a `test` task: this package holds the shared task
 * *definitions* every other package re-exports, and has no build of its own (nothing here is
 * compiled -- see `tsconfig.json`).
 *
 * A task rather than the `node --test` line the root `test` script used to run ahead of `vp run`,
 * so these suites cache and are watchdogged like every other package's. They are the slowest
 * uncached thing in `pnpm test` despite changing rarely.
 *
 * `node --test`, not vitest, so this cannot use the shared `vitestTask()` -- only the watchdog part
 * of it. The suites here deliberately run on the platform test runner (they assert on build tooling,
 * and pulling vitest in would mean the tooling under test and the runner testing it share a
 * resolver); `vite.config.ts`'s lint overrides keep vitest globals away from them for the same
 * reason.
 *
 * `cwd: '..'` because these are workspace-wide guards, not unit tests of this directory:
 * `env-passthrough.test.ts` walks every package for build-time env reads, `deploy-scripts.test.ts`
 * reads every manifest, `build-gatekeeper-configurator.test.ts` asserts which packages route through
 * the shared configurator task. They name those paths from the repo root (`packages/…`,
 * `scripts/…`), which is where the root `test` script used to invoke them from. Package-relative
 * would resolve to `scripts/packages/…` and find nothing -- and `readdirSync` on a missing directory
 * throws, so that failure is loud rather than a vacuous pass. In a fork that vendors this repo as a
 * submodule, `..` is that fork's `public/`, which is the correct root for these assertions there.
 */

import { withTestTimeout } from "./vitest-task-vite-config.ts";

export default {
  run: {
    tasks: {
      test: {
        command: withTestTimeout("node --test 'scripts/**/*.test.ts'"),
        cwd: "..",
        // Workspace-wide, matching `cwd`: the suites read across `packages/` and the root manifests,
        // and a guard that stopped seeing a file it asserts about would cache-hit its way to a
        // stale pass.
        //
        // That breadth means a suite that writes anywhere in the workspace is writing its own
        // input, and racing whatever task owns that path. So the fixtures stay outside it:
        // `build-gatekeeper-configurator.test.ts`, `bin-entry.test.ts` and `release/hash-lib.test.ts`
        // build theirs under the OS temp directory; `build-format-blueprints.test.ts` passes `--out`
        // so the blueprint generator writes there too, rather than the `workshop-backend` module
        // that package compiles and its sibling tasks read. `release/manifest-lib.test.ts` writes
        // its golden file only under `UPDATE_GOLDEN=1`, which CI never sets.
        //
        // Don't rely on the cache to catch a violation. vp compares the input set before and after,
        // so it reports a write it can still see at the end -- but a suite that writes a path and
        // puts the original bytes back is net-zero to the fingerprint and hits the cache normally.
        // That is exactly how the blueprint generator's write hid here: it was restored in an
        // `afterEach`, so neither vp nor `git status` (the module is gitignored) showed anything,
        // and only a task reading it inside the window would see the corruption.
        //
        // One deliberate exception: `build-format-blueprints.test.ts`'s "rejects extracted files
        // ignored by Git" case has to `mkdtemp` inside `packages/workshop-backend`, because what it
        // asserts is that the import script consults *this* repo's ignore rules. It creates and
        // removes one directory, leaving nothing behind for the comparison to find.
        input: [
          { auto: true },
          { pattern: "!**/node_modules/.vite/**", base: "workspace" },
          { pattern: "!**/node_modules/.vite-temp/**", base: "workspace" },
          { pattern: "!**/.wrangler/**", base: "workspace" },
        ],
        // No artifacts -- `output: []` still fingerprints and replays the terminal output on a hit,
        // it just declares there is nothing to restore.
        output: [],
      },
    },
  },
};
