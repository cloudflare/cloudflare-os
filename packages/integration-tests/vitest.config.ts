import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const WORKSPACE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspacePath = (path: string) =>
  resolve(WORKSPACE_DIR, path).replaceAll("\\", "/");
const formatBlueprintsPath = resolve(
    WORKSPACE_DIR,
    "packages/workshop-backend",
    process.env.FORMAT_BLUEPRINTS_DIR ?? "format-blueprints",
).replaceAll("\\", "/");
const backendSourceRoot = workspacePath("packages/workshop-backend/src");
const fixtureRoot = workspacePath("packages/integration-tests/fixtures");

// Vite registers literal watch paths. The force-rerun globs below filter events from these roots.
const WATCH_PATHS = [
  backendSourceRoot,
  workspacePath("packages/workshop-backend/browser"),
  formatBlueprintsPath,
  workspacePath("packages/workshop-backend/scripts"),
  workspacePath("packages/workshop-backend/build-browser-runtime.mjs"),
  workspacePath("packages/workshop-backend/package.json"),
  workspacePath("packages/workshop-backend/wrangler.jsonc"),
  workspacePath("packages/workshop-backend/vite.config.ts"),
  workspacePath("packages/workshop-backend/tsconfig.json"),
  workspacePath("packages/workshop-backend/tsconfig.browser.json"),
  workspacePath("packages/workshop-shared/src"),
  workspacePath("packages/backend-utils/src"),
  workspacePath("packages/error-reporting/src"),
  workspacePath("packages/typed-storage/src"),
  fixtureRoot,
  workspacePath("pnpm-lock.yaml"),
];

export default defineConfig({
  plugins: [{
    name: "watch-integration-worker-inputs",
    configureServer(server) {
      server.watcher.add(WATCH_PATHS);
    },
  }],
  test: {
    include: ["__tests__/**/*.test.ts"],
    globalSetup: ["./src/global-setup.ts"],
    // Wrangler loads these outside Vitest's module graph. Absolute source paths make watch mode
    // rebuild before rerunning; generated outputs are omitted so a build cannot trigger itself.
    forceRerunTriggers: [
      `${backendSourceRoot}/*`,
      `${backendSourceRoot}/!(generated)/**`,
      `${formatBlueprintsPath}/**`,
      workspacePath("packages/workshop-backend/browser/**"),
      workspacePath("packages/workshop-backend/scripts/build-format-blueprints.mjs"),
      workspacePath("packages/workshop-backend/build-browser-runtime.mjs"),
      workspacePath("packages/workshop-backend/{package.json,wrangler.jsonc,vite.config.ts,tsconfig*.json}"),
      workspacePath("packages/workshop-shared/src/**"),
      workspacePath("packages/backend-utils/src/**"),
      workspacePath("packages/error-reporting/src/**"),
      workspacePath("packages/typed-storage/src/**"),
      `${fixtureRoot}/*`,
      `${fixtureRoot}/*/*`,
      `${fixtureRoot}/*/!(.wrangler)/**`,
      workspacePath("pnpm-lock.yaml"),
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
