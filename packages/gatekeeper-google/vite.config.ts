import gatekeeperConfiguratorConfig from "../../scripts/gatekeeper-configurator-vite-config.js";
import { withVitestTask } from "../../scripts/vitest-task-vite-config.js";

/** Configurator tasks plus separate Node and workerd test passes. */
export default withVitestTask(gatekeeperConfiguratorConfig, [
  "vitest run",
  "vitest run -c vitest.worker.config.ts",
]);
