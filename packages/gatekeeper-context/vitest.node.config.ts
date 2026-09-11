import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["__tests__/vite-config.test.ts", "app/**/*.test.{ts,tsx}"],
  },
});
