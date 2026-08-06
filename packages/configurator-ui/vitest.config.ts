import { defineConfig } from "vitest/config";

// Anchor Vitest to this package. Without a local config, Vitest walks up
// parent directories looking for one, so when this repo is embedded inside a
// larger monorepo it would load the host repo's vitest config instead.
export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
  },
});
