import { defineConfig } from "vitest/config";

/**
 * The live checks of what the hooks rely on GitHub for (`__tests__/contract`), which the
 * github-contract workflow runs. Never part of `test`: they need a real repository and token, and
 * wait on GitHub's own delivery times.
 */
export default defineConfig({
  test: {
    include: ["__tests__/contract/*.test.ts"],
    environment: "node",
    testTimeout: 15 * 60_000,
    hookTimeout: 2 * 60_000,
  },
});
