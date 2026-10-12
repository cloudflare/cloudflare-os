import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { vitestTask } from "@gadgets/scripts/vitest-task";

/**
 * Vite+ per-package settings: the shared gatekeeper-configurator tasks plus a two-pass `test` task,
 * pure logic in Node and the RpcTarget/Durable Object suite in workerd. The workerd suite loads the
 * worker module, which imports the generated configurator HTML, so `test` builds that first rather
 * than relying on a prior `pnpm build`.
 */
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
