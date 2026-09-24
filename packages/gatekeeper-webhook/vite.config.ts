import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask(
  gatekeeperConfiguratorConfig,
  "vitest run -c vitest.worker.config.ts",
);
