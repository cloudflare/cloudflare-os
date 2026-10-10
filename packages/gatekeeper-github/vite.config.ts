import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { TESTS_WITH_TIMEOUT_ENV, withTestTimeout, withVitestTask } from "@gadgets/scripts/vitest-task";

/**
 * Vite+ per-package settings: the shared gatekeeper-configurator tasks plus a two-pass `test` task.
 * `withTests` from the configurator config hardcodes a single `vitest run`, and this package needs
 * two projects -- pure logic in Node, and the session git-cache wiring suite in workerd -- so it
 * composes `withVitestTask` directly, the same way gatekeeper-cloudflare does. The passes stay
 * separate commands so one can replay from the task cache when only the other's inputs moved.
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
      // The contract checks run in Node rather than workerd, so they are checked with Node's types.
      build: { ...config.run.tasks.build, command: ["tsc", "tsc -p tsconfig.contract.json"] },
      /**
       * The validated entrypoint `@gadgets/integration-tests` boots this gatekeeper from, built
       * before its test files start rather than by each of them, which would race on the tree.
       * Cached as workshop-backend's own `build:integration-worker` is, and for the same reasons:
       * `.wrangler` is left out of the inputs, since the build writes it, and named as the output,
       * since a cache hit has to leave the tree on disk for the suite to read.
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
