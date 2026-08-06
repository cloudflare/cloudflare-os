import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(fileURLToPath(import.meta.url), "..");
const watch = process.argv.includes("--watch");

// `vp build` rather than `vite build`: under Vite+ the `vite` package is an alias for
// @voidzero-dev/vite-plus-core, which ships no CLI binary of its own.
execFileSync("vp", ["build", "-c", "vite.config.ts", ...(watch ? ["--watch"] : [])], {
  cwd: packageDirectory,
  stdio: "inherit",
});
