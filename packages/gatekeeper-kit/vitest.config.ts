import { defineConfig } from "vitest/config";

/** The pure-logic suites, which are far cheaper in Node. Workers-API modules use the sibling config. */
export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
  },
});
