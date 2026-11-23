import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { TESTS_WITH_TIMEOUT_ENV, vitestTask, withTestTimeout } from "@gadgets/scripts/vitest-task";

/**
 * Vite+ per-package settings: the shared configurator `build`/`build:configurator` tasks, the
 * `generate` task that writes this Worker's subset of the Admin API's schema, a two-pass `test`
 * task (the generated surface in Node, the Worker in workerd, kept as separate commands so one
 * replays from the task cache when only the other's inputs moved), and the validated tree the
 * integration harness boots. `build`, `test` and `build:integration-worker` each import the
 * generated schema and the generated configurator module, so each generates both first rather
 * than rely on an earlier build having left them.
 */
export default {
  ...gatekeeperConfiguratorConfig,
  run: {
    ...gatekeeperConfiguratorConfig.run,
    tasks: {
      ...gatekeeperConfiguratorConfig.run.tasks,
      // Uncached: it reads another package's generated file and returns at once when its own is
      // current. After `build:configurator`, whose cached outputs are everything under
      // `src/generated`: a cache hit there must not leave an older schema behind.
      generate: {
        command: "node scripts/generate-schema.ts",
        dependsOn: ["@gadgets/api-schema#generate", "build:configurator"],
        cache: false,
      },
      build: {
        ...gatekeeperConfiguratorConfig.run.tasks.build,
        dependsOn: [...gatekeeperConfiguratorConfig.run.tasks.build.dependsOn, "generate"],
      },
      test: {
        ...vitestTask(["vitest run", "vitest run -c vitest.worker.config.ts"]),
        dependsOn: ["generate"],
      },
      // The integration harness boots this validated tree without rebuilding it per test file.
      // Workspace-wide exclusion, as gatekeeper-context's: tracking reaches past the package, and
      // wrangler's randomly named scratch bundles would otherwise miss the cache every run.
      "build:integration-worker": {
        command: withTestTimeout("capnweb-validate build --out .wrangler/validate"),
        dependsOn: ["generate"],
        cache: {
          env: TESTS_WITH_TIMEOUT_ENV,
          input: [{ auto: true }, { pattern: "!**/.wrangler/**", base: "workspace" }],
          output: [".wrangler/validate/**"],
        },
      },
    },
  },
};
