import gatekeeperConfiguratorConfig from "@gadgets/scripts/gatekeeper-configurator";
import { TESTS_WITH_TIMEOUT_ENV, vitestTask, withTestTimeout } from "@gadgets/scripts/vitest-task";

const tests = vitestTask([
  "vitest run",
  "vitest run -c vitest.worker.config.ts",
  "vitest run -c vitest.docs-worker.config.ts",
]);

const widerTests = vitestTask([
  // A wider Node file runs for up to two minutes on CI, and the reporter is silent until one ends.
  { command: "vitest related --run __tests__/wider-run.ts --no-passWithNoTests", idleSeconds: 180 },
  "vitest related --run __tests__/wider-run.ts -c vitest.docs-worker.config.ts --no-passWithNoTests",
]);

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
        ...tests,
        // `GOOGLE_DOCS_WIDER_TESTS` widens the tables of the Docs tests that have two widths
        // (`__tests__/wider-run.ts`): a run with it set holds more, so it is another result,
        // and a cached run must neither strip it nor replay the narrower one.
        cache: { ...tests.cache, env: [...tests.cache.env, "GOOGLE_DOCS_WIDER_TESTS"] },
        dependsOn: ["build:configurator"],
      },
      /**
       * Only the test files that import `__tests__/wider-run.ts`, directly or through a helper, in
       * the Node and Docs workerd projects. `.github/workflows/google-wider-tests.yml` runs it with
       * `GOOGLE_DOCS_WIDER_TESTS` set.
       */
      "test:wider": {
        ...widerTests,
        cache: { ...widerTests.cache, env: [...widerTests.cache.env, "GOOGLE_DOCS_WIDER_TESTS"] },
        dependsOn: ["build:configurator"],
      },
    },
  },
};
