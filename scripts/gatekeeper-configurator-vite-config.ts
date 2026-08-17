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
 * would be restored under the other. vp forbids a task and a script sharing a name, so there is no
 * `build:configurator` script: `deploy` reaches this task with
 * `vp run --no-cache build:configurator`, the same way `gatekeeper-context` and
 * `gatekeeper-scheduler` reach `build:app`. Invoking the builder directly there would also work --
 * `deploy` is manual and does not run under vp, so it keeps the real environment -- but it
 * duplicated the command in thirteen packages, and a script shadowing a declared task is the shape
 * of the bug described below.
 *
 * `--no-cache` on the deploy path specifically, where `build` uses the cache. A cache hit is only as
 * correct as the fingerprint is complete, and every bug in this file's history has been a fingerprint
 * missing an input -- an undeclared env var here, a directory outside the workspace in
 * `workshop-backend`. Those are cheap to absorb on a build you can re-run and expensive on a deploy
 * you cannot, and the codegen costs a second or two, so a deploy always rebuilds from source rather
 * than trusting the fingerprint. The uncached `clean:error-reporting-artifacts` dependency matters
 * more here than anywhere: a cache *hit* restores archived outputs without deleting anything, so
 * without it a reporting-disabled deploy could keep the previous enabled build's sourcemaps.
 *
 * `build` is a task for the same reason, and declaring `build:configurator` was not enough on its
 * own: `build` was a script running the builder directly, and `pnpm build` runs `build`, not
 * `build:configurator`, so the whole point of the declaration was bypassed for every deploy.
 * Measured on `slack-gatekeeper` with the cache primed at one value of the variable and the build
 * then run at the other: the shipped `*-configurator-ui.txt` came out byte-identical (190,967 B
 * either way, against 195,361 B under `--no-cache`) and no sourcemap artifacts were emitted. The
 * builder had genuinely re-executed -- it was not a stale replay -- so it simply never saw the
 * variable. Depending on the task instead keeps the codegen in one place and lets `tsc` cache apart
 * from it.
 */
const gatekeeperConfiguratorConfig = {
  run: {
    tasks: {
      // Uncached: a cache hit restores archived outputs but never deletes files, so the sourcemap
      // artifacts of an enabled-reporting build would survive a later disabled-reporting cache hit
      // (see clean-error-reporting-artifacts.ts). This runs every time, before the cache lookup.
      "clean:error-reporting-artifacts": {
        command: "node ../../scripts/clean-error-reporting-artifacts.ts .",
        cache: false,
      },
      "build:configurator": {
        command: "node ../../scripts/build-gatekeeper-configurator.ts .",
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
        // Read via `loadEnv` in build-gatekeeper-configurator.ts and baked into the generated
        // HTML, so it belongs in the fingerprint.
        env: ["VITE_FRONTEND_ERROR_REPORTING"],
      },
      // Just the type check: the codegen it used to run with `&&` is `build:configurator` above, so
      // the two cache separately and a run that only touched types replays the generated HTML.
      // No `env` of its own -- `tsc` reads none, and the variable reaches the step that does.
      build: {
        command: "tsc",
        dependsOn: ["build:configurator"],
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
