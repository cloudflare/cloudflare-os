import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsxFactory: "h", jsxFragment: "Fragment" },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    alias: {
      // Lets the upstream client, which reads the Worker's bindings to count its calls, be
      // imported at all. See the stub for what it does and does not provide.
      "cloudflare:workers": fileURLToPath(
        import.meta.resolve("@gadgets/scripts/cloudflare-workers-stub")),
    },
  },
});
