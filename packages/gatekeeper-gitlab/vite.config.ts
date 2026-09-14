import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { withVitestTask } from "../../scripts/vitest-task-vite-config.js";

/**
 * Vite+ per-package settings: the shared configurator `build`/`build:configurator` tasks plus a
 * two-pass `test` task -- pure logic in Node, RpcTarget/Durable Object behaviour in workerd. The
 * passes stay separate commands so one can replay from the task cache when only the other's
 * inputs moved.
 */
export default withVitestTask(gatekeeperConfiguratorConfig, [
  "vitest run",
  "vitest run -c vitest.worker.config.ts",
]);
