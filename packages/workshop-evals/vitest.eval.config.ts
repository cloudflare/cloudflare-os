import { defineConfig } from "vitest/config";
import { EVAL_TEST_TIMEOUT_MS } from "./src/budgets.js";

export default defineConfig({
  test: {
    // The pull request comparison never runs a targeted eval (see scripts/evals/eval-keys.ts); its
    // own workflow does. A targeted eval may set model settings, so it needs an AI Gateway.
    include: ["evals/**/*.eval.ts", "targeted/**/*.eval.ts"],
    globalSetup: ["../integration-tests/src/global-setup.ts", "./src/global-setup.ts"],
    environment: "node",
    testTimeout: EVAL_TEST_TIMEOUT_MS,
    hookTimeout: 3 * 60_000,
    // A file's trials all run at once on the file's one Workshop, so it finishes in the time of
    // its slowest trial. Every file runs at once too: four files of ten trials on one 16 GB runner
    // peaked at 7.7 GB.
    maxConcurrency: 10,
    maxWorkers: 4,
  },
});
