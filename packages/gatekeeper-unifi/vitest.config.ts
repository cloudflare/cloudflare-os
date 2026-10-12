import { defineConfig } from "vitest/config";

/**
 * Pure-logic tests, run in Node: resource URL grammar, response parsing, the HTTP transport,
 * simulation, approval text, the connect form, the configurators, and the OpenAPI contract. The
 * sibling `vitest.worker.config.ts` covers what needs workerd.
 */
export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
  },
});
