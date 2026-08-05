import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Live-cloud tests: one full OS deploy in beforeAll, destroyed in
    // afterAll. Keep files sequential so two suites never deploy the same
    // stage concurrently.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 1_800_000,
  },
});
