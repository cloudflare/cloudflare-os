import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [".wrangler/**", "dist/**", "node_modules/**"],
  },
});
