import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Plain node, not @cloudflare/vitest-pool-workers: that pool boots miniflare, which supplies
    // its own KV/R2 implementations and would therefore test Cloudflare's services instead of
    // ours. These tests spawn the real workerd binary as a child process.
    environment: "node",
    // One workerd process bound to a fixed port, so suites must not run concurrently.
    fileParallelism: false,
  },
});
