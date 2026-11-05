import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { withVitestTask } from "@gadgets/scripts/vitest-task";

/**
 * Vite+ per-package settings: the shared gatekeeper-configurator tasks plus a two-pass `test` task.
 * `withTests` from the configurator config hardcodes a single `vitest run`, and this package needs
 * two projects -- pure logic in Node, and the observer suite in workerd -- so it composes
 * `withVitestTask` directly, the same way gatekeeper-cloudflare does. The passes stay separate
 * commands so one can replay from the task cache when only the other's inputs moved. The workerd
 * pass imports the generated configurators, so the test task declares that prerequisite too.
 */
const config = withVitestTask(gatekeeperConfiguratorConfig, [
  "vitest run",
  "vitest run -c vitest.worker.config.ts",
]);

export default {
  ...config,
  run: {
    ...config.run,
    tasks: {
      ...config.run.tasks,
      test: { ...config.run.tasks.test, dependsOn: ["build:configurator"] },
    },
  },
};
