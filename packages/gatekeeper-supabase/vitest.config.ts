import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    // The gatekeeper module imports `cloudflare:workers`, which exists only inside workerd, and the
    // configurator UIs `build:configurator` generates, which a test run does not build.
    alias: [
      {
        find: "cloudflare:workers",
        replacement: fileURLToPath(new URL("./__tests__/stubs/cloudflare-workers.ts", import.meta.url)),
      },
      {
        find: /^\.\/generated\/.+-configurator-ui\.txt$/,
        replacement: fileURLToPath(new URL("./__tests__/stubs/configurator-ui.ts", import.meta.url)),
      },
    ],
  },
});
