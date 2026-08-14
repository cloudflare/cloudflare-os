import { withVitestTask, type GlobWithBase } from "./vitest-task-vite-config.js";

/**
 * Shared Vite+ settings for every gatekeeper package with a `src/configurator/` UI, re-exported by
 * each such package's `vite.config.ts`. A plain object rather than `defineConfig` so the packages
 * need no resolvable `vite-plus` import of their own.
 *
 * Gatekeepers that also have tests re-export `withTests` below instead of this default.
 *
 * `build:configurator` is a task rather than a package.json script so VITE_FRONTEND_ERROR_REPORTING
 * can be declared: `vp run --cache` runs a task with undeclared env vars stripped and absent from
 * the cache fingerprint. As a script, the `pnpm dev-server` pre-flight baked
 * `frontendReportingEnabled = false` into the generated HTML regardless of the shell environment,
 * the directly-spawned watcher (which inherits the shell) rewrote it moments later, and Wrangler
 * restarted the worker on the change -- and a cached artifact built under one value of the variable
 * would be restored under the other. vp forbids a task and a script sharing a name, so the
 * packages' `build` and `deploy` scripts invoke the builder directly instead of through a
 * `build:configurator` script.
 */
const gatekeeperConfiguratorConfig = {
  run: {
    tasks: {
      // Uncached: a cache hit restores archived outputs but never deletes files, so the sourcemap
      // artifacts of an enabled-reporting build would survive a later disabled-reporting cache hit
      // (see clean-error-reporting-artifacts.mjs). This runs every time, before the cache lookup.
      "clean:error-reporting-artifacts": {
        command: "node ../../scripts/clean-error-reporting-artifacts.mjs .",
        cache: false,
      },
      "build:configurator": {
        command: "node ../../scripts/build-gatekeeper-configurator.mjs .",
        dependsOn: ["clean:error-reporting-artifacts"],
        input: [
          { auto: true },
          // The builder reads its own outputs back to skip no-op writes (writeFileIfChanged), so
          // automatic tracking would otherwise fingerprint them and any run that changed them
          // would refuse to cache ("modified its input").
          //
          // Annotated so a mistyped `base` is a compile error rather than an exclusion that
          // silently never matches -- the one thing being TS buys this file directly.
          { pattern: "!**/src/generated/**", base: "workspace" } satisfies GlobWithBase,
        ],
        output: ["src/generated/**"],
        // Read via `loadEnv` in build-gatekeeper-configurator.mjs and baked into the generated
        // HTML, so it belongs in the fingerprint.
        env: ["VITE_FRONTEND_ERROR_REPORTING"],
      },
    },
  },
};

export default gatekeeperConfiguratorConfig;

/**
 * The default plus the shared `test` task, for the gatekeepers that have tests of their own.
 *
 * Separate because most re-exporters have no test files and `vitest run` exits 1 when it finds none.
 * Putting `--passWithNoTests` in the default instead would let a gatekeeper whose tests stopped
 * being discovered go green with zero tests run.
 */
export const withTests = withVitestTask(gatekeeperConfiguratorConfig, "vitest run");
