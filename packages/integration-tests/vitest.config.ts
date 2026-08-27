import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    globalSetup: ["./src/global-setup.ts"],
    forceRerunTriggers: [
      "../workshop-backend/{src,browser,format-blueprints}/**",
      "../workshop-backend/{wrangler.jsonc,build-browser-runtime.mjs}",
      "../workshop-backend/scripts/build-format-blueprints.mjs",
      "../workshop-shared/src/**",
      "../backend-utils/src/**",
      "fixtures/**",
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
