import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { TESTS_WITH_TIMEOUT_ENV, vitestTask, withTestTimeout } from "@gadgets/scripts/vitest-task";

/** Configurator tasks plus separate Node and workerd test passes. */
export default {
  ...gatekeeperConfiguratorConfig,
  run: {
    ...gatekeeperConfiguratorConfig.run,
    tasks: {
      ...gatekeeperConfiguratorConfig.run.tasks,
      build: {
        ...gatekeeperConfiguratorConfig.run.tasks.build,
        command: ["tsc", "tsc -p tsconfig.test.json"],
      },
      /**
       * The validated entrypoint `@gadgets/integration-tests` upgrades a deployment to, built
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
      test: {
        ...vitestTask([
          "vitest run",
          "vitest run -c vitest.worker.config.ts",
          "vitest run -c vitest.docs-worker.config.ts",
        ]),
        dependsOn: ["build:configurator"],
      },
    },
  },
};
