// Build the Context Library SPA into generated single-file HTML for startAppUi().

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execPnpm } from "../../scripts/pnpm-command.mjs";

const pkgDir = resolve(fileURLToPath(import.meta.url), "..");
const watch = process.argv.includes("--watch");

console.log(
  watch
    ? "watching context library app for changes…"
    : "building context library app single-file bundle…",
);
execPnpm(
  ["exec", "vite", "build", "-c", "vite.config.ts", ...(watch ? ["--watch"] : [])],
  { cwd: pkgDir, stdio: "inherit" },
);
