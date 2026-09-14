import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { withVitestTask } from "../../scripts/vitest-task-vite-config.js";

/**
 * Vite+ per-package settings: the shared configurator `build`/`build:configurator` tasks plus
 * the cached vitest `test` task. Pure logic runs in Node; the workerd project (RpcTarget,
 * Durable Objects) is added alongside the gatekeeper implementation.
 */
export default withVitestTask(gatekeeperConfiguratorConfig, [
  "vitest run",
]);
