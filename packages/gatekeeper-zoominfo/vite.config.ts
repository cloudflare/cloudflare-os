import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { vitestTask } from "@gadgets/scripts/vitest-task";

/**
 * Vite+ per-package settings: the shared configurator `build`/`build:configurator` tasks plus a
 * `test` task for the workerd suite. The suite imports the generated configurator module, so `test`
 * generates it first rather than rely on an earlier build having left it.
 */
export default {
  ...gatekeeperConfiguratorConfig,
  run: {
    ...gatekeeperConfiguratorConfig.run,
    tasks: {
      ...gatekeeperConfiguratorConfig.run.tasks,
      test: {
        ...vitestTask("vitest run"),
        dependsOn: ["build:configurator"],
      },
    },
  },
};
