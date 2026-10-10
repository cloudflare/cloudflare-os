import { defineConfig } from "vitest/config";

/**
 * The live checks of what the hooks rely on GitLab for (`__tests__/contract`), which the
 * gitlab-contract workflow runs. Never part of `test`: they need a real project and token, and
 * wait on GitLab's own delivery times.
 */
export default defineConfig({
  test: {
    include: ["__tests__/contract/*.test.ts"],
    environment: "node",
    testTimeout: 15 * 60_000,
    hookTimeout: 2 * 60_000,
  },
});
