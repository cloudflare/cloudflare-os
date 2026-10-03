import { fileURLToPath } from "node:url";

// Vite+ per-package settings. Shared by all gatekeepers with a configurator UI and living beside the
// builder it runs; `withTests` is that config plus the shared vitest `test` task.
import { withTests } from "@gadgets/scripts/gatekeeper-configurator";

export default {
  ...withTests,
  test: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("../mcp-shared/__tests__/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
};
