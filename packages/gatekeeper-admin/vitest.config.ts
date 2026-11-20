import { defineConfig } from "vitest/config";

/**
 * The Node project: the generated surface (`src/surface.ts`), which imports nothing of the Workers
 * runtime. The facet and its sessions run in workerd, in `vitest.worker.config.ts`.
 */
export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
  },
});
