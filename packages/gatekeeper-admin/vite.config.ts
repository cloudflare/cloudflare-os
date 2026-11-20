import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { TESTS_WITH_TIMEOUT_ENV, vitestTask, withTestTimeout } from "@gadgets/scripts/vitest-task";

/** The task that writes the Admin API's schema, which is generated and not committed. */
const GENERATE_SCHEMA = "@gadgets/api-schema#generate";

/**
 * Vite+ per-package settings: the shared configurator `build`/`build:configurator` tasks, a
 * two-pass `test` task (the generated surface in Node, the facet and its sessions in workerd, kept
 * as separate commands so one replays from the task cache when only the other's inputs moved), and
 * the validated tree the integration harness boots. `build`, `test` and
 * `build:integration-worker` each import the generated schema and the generated configurator
 * module, so each generates both first rather than rely on an earlier build having left them.
 */
export default {
  ...gatekeeperConfiguratorConfig,
  run: {
    ...gatekeeperConfiguratorConfig.run,
    tasks: {
      ...gatekeeperConfiguratorConfig.run.tasks,
      build: {
        ...gatekeeperConfiguratorConfig.run.tasks.build,
        dependsOn: [...gatekeeperConfiguratorConfig.run.tasks.build.dependsOn, GENERATE_SCHEMA],
      },
      test: {
        ...vitestTask(["vitest run", "vitest run -c vitest.worker.config.ts"]),
        dependsOn: ["build:configurator", GENERATE_SCHEMA],
      },
      // The integration harness boots this validated tree without rebuilding it per test file.
      // Workspace-wide exclusion, as gatekeeper-context's: tracking reaches past the package, and
      // wrangler's randomly named scratch bundles would otherwise miss the cache every run.
      "build:integration-worker": {
        command: withTestTimeout("capnweb-validate build --out .wrangler/validate"),
        dependsOn: ["build:configurator", GENERATE_SCHEMA],
        cache: {
          env: TESTS_WITH_TIMEOUT_ENV,
          input: [{ auto: true }, { pattern: "!**/.wrangler/**", base: "workspace" }],
          output: [".wrangler/validate/**"],
        },
      },
    },
  },
};
