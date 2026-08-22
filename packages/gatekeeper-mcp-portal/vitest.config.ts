import { fileURLToPath } from "node:url";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [capnwebValidate()],
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("../mcp-shared/__tests__/stubs/cloudflare-workers.ts", import.meta.url)),
      "./generated/server-configurator-ui.txt": fileURLToPath(
        new URL("./__tests__/stubs/configurator-html.ts", import.meta.url)),
    },
  },
});
