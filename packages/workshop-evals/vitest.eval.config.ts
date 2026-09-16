import { defineConfig } from "vitest/config";
import { EVAL_TEST_TIMEOUT_MS } from "./src/budgets.js";

export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    globalSetup: ["../integration-tests/src/global-setup.ts"],
    environment: "node",
    testTimeout: EVAL_TEST_TIMEOUT_MS,
    hookTimeout: 3 * 60_000,
  },
});
