import { defineConfig } from "vitest/config";
import { EVAL_TEST_TIMEOUT_MS } from "./src/timeouts.ts";

/**
 * Live evals: every run boots its own workerd Workshop and drives a real model, so they are slow,
 * serial, and never part of `pnpm test`. Reporters live here rather than in each script so every
 * entry point writes the same report shape, and each writes its own file so running `eval:required`
 * and `eval:frontier` in sequence does not leave a summary covering only the second.
 */
export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: EVAL_TEST_TIMEOUT_MS,
    hookTimeout: 3 * 60_000,
    reporters: ["vitest-evals/reporter", "json"],
  },
});
