import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { vitestTask } from "@gadgets/scripts/vitest-task";

/** Generate configurators before either Vitest project, including cold-checkout runs. */
export default {
  ...gatekeeperConfiguratorConfig,
  run: {
    ...gatekeeperConfiguratorConfig.run,
    tasks: {
      ...gatekeeperConfiguratorConfig.run.tasks,
      test: {
        ...vitestTask(["vitest run", "vitest run -c vitest.worker.config.ts"]),
        dependsOn: ["build:configurator"],
      },
    },
  },
};
