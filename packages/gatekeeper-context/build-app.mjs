// Build the Context Library SPA into generated single-file HTML for startAppUi().

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(fileURLToPath(import.meta.url), "..");
const watch = process.argv.includes("--watch");
// One-shot build that produces the same bytes `--watch` would, for the `pnpm dev-server`
// pre-flight see the `unminified` note in vite.app.config.ts.
const dev = process.argv.includes("--dev");

console.log(
  watch
    ? "watching context library app for changes…"
    : "building context library app single-file bundle…",
);
execFileSync(
  "pnpm",
  ["exec", "vite", "build", "-c", "vite.app.config.ts", ...(watch ? ["--watch"] : [])],
  {
    cwd: pkgDir,
    stdio: "inherit",
    // Always set explicitly an inherited GATEKEEPER_APP_UNMINIFIED would
    // turn a production build unminified, and Vite+ would cache that under `build:app`.
    env: { ...process.env, GATEKEEPER_APP_UNMINIFIED: dev ? "true" : "false" },
  },
);
