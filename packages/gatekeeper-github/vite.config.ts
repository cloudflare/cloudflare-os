import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { withVitestTask } from "../../scripts/vitest-task-vite-config.js";

/**
 * Vite+ per-package settings: the shared gatekeeper-configurator tasks plus a two-pass `test` task.
 * `withTests` from the configurator config hardcodes a single `vitest run`, and this package needs
 * two projects -- pure logic in Node, and the session git-cache wiring suite in workerd -- so it
 * composes `withVitestTask` directly, the same way gatekeeper-cloudflare does. The passes stay
 * separate commands so one can replay from the task cache when only the other's inputs moved.
 */
export default withVitestTask(gatekeeperConfiguratorConfig, [
  "vitest run",
  "vitest run -c vitest.worker.config.ts",
]);
