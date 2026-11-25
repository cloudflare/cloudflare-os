import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Declaration compilation needs headroom when the full graph shares cloud CPUs. The wider
    // run of the Docs tests (`__tests__/wider-run.ts`) is given four times that: its tables are
    // several times the default pass's.
    testTimeout: 15_000 * (process.env.GOOGLE_DOCS_WIDER_TESTS ? 4 : 1),
    include: ["__tests__/*.test.ts"],
    // The suites' own calls as a corpus of the differential of the builders on a piece.
    setupFiles: ["__tests__/docs-piece-suite-shadow.ts"],
    environment: "node",
    alias: {
      // Lets modules that read the Worker's bindings be imported at all. See the stub for what it
      // does and does not provide.
      "cloudflare:workers": fileURLToPath(
        new URL("./__tests__/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
});
