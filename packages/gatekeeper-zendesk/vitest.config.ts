import { defineConfig } from "vitest/config";

/** The pure-logic tests. `__tests__/workerd` is excluded: it belongs to vitest.worker.config.ts. */
export default defineConfig({
  test: { environment: "node", include: ["__tests__/*.test.ts"] },
});
