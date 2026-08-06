import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    // Each harness boots real workerd instances, so these run far slower than unit tests.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One harness at a time: the workers bind fixed DO namespaces and KV, so files running together
    // would race on ports and persisted state. This serialises the files -- one runs to completion
    // before the next starts, though they may share a worker process -- and leaves what happens
    // inside a file alone: only the cases written as `it.concurrent` run together.
    fileParallelism: false,
  },
});
