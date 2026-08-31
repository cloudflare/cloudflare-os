import gatekeeperConfiguratorConfig from "../../scripts/gatekeeper-configurator-vite-config.js";
import { vitestTask } from "../../scripts/vitest-task-vite-config.js";

/** Configurator tasks plus separate Node and workerd test passes. */
export default {
  ...gatekeeperConfiguratorConfig,
  run: {
    ...gatekeeperConfiguratorConfig.run,
    tasks: {
      ...gatekeeperConfiguratorConfig.run.tasks,
      test: {
        ...vitestTask([
          "vitest run",
          "vitest run -c vitest.worker.config.ts",
        ]),
        dependsOn: ["build:configurator"],
      },
    },
  },
};
