import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsxFactory: "h", jsxFragment: "Fragment" },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
