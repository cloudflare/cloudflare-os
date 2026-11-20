import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The Node project: the table of the requests the gatekeeper sends to ZoomInfo and the metric
 * points they are counted as, read through a fake dataset.
 */
export default defineConfig({
  test: {
    include: ["__tests__/upstream.test.ts"],
    environment: "node",
    alias: {
      // Lets the upstream client, which reads the Worker's bindings to write its metric points,
      // be imported at all. See the stub for what it does and does not provide.
      "cloudflare:workers": fileURLToPath(
        import.meta.resolve("@gadgets/scripts/cloudflare-workers-stub")),
    },
  },
});
