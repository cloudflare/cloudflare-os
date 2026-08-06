// Build the Context Library SPA into generated single-file HTML for startAppUi().

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(fileURLToPath(import.meta.url), "..");
const watch = process.argv.includes("--watch");

console.log(
  watch
    ? "watching context library app for changes…"
    : "building context library app single-file bundle…",
);
// `vp build` rather than `vite build`: under Vite+ the `vite` package is an alias for
// @voidzero-dev/vite-plus-core, which ships no CLI binary of its own.
execFileSync("vp", ["build", "-c", "vite.config.ts", ...(watch ? ["--watch"] : [])], {
  cwd: pkgDir,
  stdio: "inherit",
});
