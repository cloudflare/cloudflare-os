import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinEntry } from "../../scripts/bin-entry.ts";
import { pnpmCommand } from "../../scripts/pnpm-command.ts";

const packageDirectory = resolve(fileURLToPath(import.meta.url), "..");
const watch = process.argv.includes("--watch");
// One-shot build that produces the same bytes `--watch` would, for the `pnpm dev-server`
// pre-flight see the `unminified` note in vite.app.config.ts.
const dev = process.argv.includes("--dev");

// Reached directly: Vite+ runs tasks with a filtered environment that drops `npm_execpath`, so on
// Windows there is no shell-free way back to pnpm. Falls back to `pnpm exec` if vite is missing.
const viteArgs = ["build", "-c", "vite.app.config.ts", ...(watch ? ["--watch"] : [])];
const viteEntry = resolveBinEntry(packageDirectory, "vite");
const [command, argv] = viteEntry
  ? [process.execPath, [viteEntry, ...viteArgs]]
  : pnpmCommand(["exec", "vite", ...viteArgs]);
execFileSync(
  command,
  argv,
  {
    cwd: packageDirectory,
    stdio: "inherit",
    // Always set explicitly an inherited GATEKEEPER_APP_UNMINIFIED would
    // turn a production build unminified, and Vite+ would cache that under `build:app`.
    env: { ...process.env, GATEKEEPER_APP_UNMINIFIED: dev ? "true" : "false" },
  },
);
