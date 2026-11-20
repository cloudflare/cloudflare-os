import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    alias: {
      // Lets the upstream client, which reads the Worker's bindings to write its metric points,
      // be imported at all. See the stub for what it does and does not provide.
      "cloudflare:workers": fileURLToPath(
        import.meta.resolve("@gadgets/scripts/cloudflare-workers-stub")),
    },
  },
});
