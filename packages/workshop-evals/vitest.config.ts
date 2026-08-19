import { defineConfig } from "vitest/config";

/** Fast unit tests. The live evals have their own config and never run here. */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tasks/**/*.test.ts"],
  },
});
