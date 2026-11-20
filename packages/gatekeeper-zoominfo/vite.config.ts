import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { vitestTask } from "@gadgets/scripts/vitest-task";

/**
 * Vite+ per-package settings: the shared configurator `build`/`build:configurator` tasks plus a
 * two-pass `test` task: the workerd suite, then the request table in Node. The workerd suite
 * imports the generated configurator module, so `test` generates it first rather than rely on an
 * earlier build having left it.
 */
export default {
  ...gatekeeperConfiguratorConfig,
  run: {
    ...gatekeeperConfiguratorConfig.run,
    tasks: {
      ...gatekeeperConfiguratorConfig.run.tasks,
      test: {
        ...vitestTask(["vitest run", "vitest run -c vitest.node.config.ts"]),
        dependsOn: ["build:configurator"],
      },
    },
  },
};
