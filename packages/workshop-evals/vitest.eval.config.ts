import { defineConfig } from "vitest/config";
import { EVAL_TEST_TIMEOUT_MS } from "./src/budgets.js";

export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    globalSetup: ["../integration-tests/src/global-setup.ts", "./src/global-setup.ts"],
    environment: "node",
    testTimeout: EVAL_TEST_TIMEOUT_MS,
    hookTimeout: 3 * 60_000,
    // A file's trials all run at once, so it finishes in the time of its slowest trial. Files
    // run two at a time: up to twenty Workshops alive on one runner, the envelope a ten-trial
    // run has been measured to fit.
    maxConcurrency: 10,
    maxWorkers: 2,
  },
});
