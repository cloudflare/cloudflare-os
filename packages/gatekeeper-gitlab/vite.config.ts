import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { TESTS_WITH_TIMEOUT_ENV, withTestTimeout, withVitestTask } from "../../scripts/vitest-task-vite-config.js";

/**
 * Vite+ per-package settings: the shared configurator `build`/`build:configurator` tasks plus a
 * two-pass `test` task -- pure logic in Node, RpcTarget/Durable Object behaviour in workerd. The
 * passes stay separate commands so one can replay from the task cache when only the other's
 * inputs moved.
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
      /**
       * The validated entrypoint `@gadgets/integration-tests` boots this gatekeeper from, built
       * before its test files start; see gatekeeper-github's task of the same name.
       */
      "build:integration-worker": {
        command: withTestTimeout("capnweb-validate build --out .wrangler/validate"),
        dependsOn: ["build:configurator"],
        cache: {
          env: TESTS_WITH_TIMEOUT_ENV,
          input: [{ auto: true }, { pattern: "!**/.wrangler/**", base: "workspace" }],
          output: [".wrangler/validate/**"],
        },
      },
    },
  },
};
