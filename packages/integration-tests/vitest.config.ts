import { defineConfig } from "vitest/config";
import { FORCE_RERUN_TRIGGERS, WATCH_PATHS } from "./src/worker-inputs.js";

export default defineConfig({
  plugins: [{
    name: "watch-integration-worker-inputs",
    configureServer(server) {
      // Wrangler loads these outside Vitest's module graph, so nothing registers them for us.
      server.watcher.add(WATCH_PATHS);
    },
  }],
  test: {
    include: ["__tests__/**/*.test.ts"],
    globalSetup: ["./src/global-setup.ts"],
    // Absolute source globs over the same set, so a change rebuilds the Worker before rerunning.
    // Deletions are handled in `src/global-setup.ts`: vitest's unlink path never consults these.
    forceRerunTriggers: FORCE_RERUN_TRIGGERS,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
