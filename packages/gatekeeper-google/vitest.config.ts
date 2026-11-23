import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Declaration compilation needs headroom when the full graph shares cloud CPUs.
    testTimeout: 15_000,
    include: ["__tests__/*.test.ts"],
    environment: "node",
    alias: {
      // Lets modules that read the Worker's bindings be imported at all. See the stub for what it
      // does and does not provide.
      "cloudflare:workers": fileURLToPath(
        new URL("./__tests__/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
});
