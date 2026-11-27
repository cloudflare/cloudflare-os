import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** The pure-logic suites, which are far cheaper in Node. Workers-API modules use the sibling config. */
export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    alias: {
      // Lets a module that reads the Worker's bindings be imported at all. See the stub for what
      // it does and does not provide.
      "cloudflare:workers": fileURLToPath(
        import.meta.resolve("@gadgets/scripts/cloudflare-workers-stub")),
    },
  },
});
