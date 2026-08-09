import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execPnpm } from "../../scripts/pnpm-command.mjs";

const packageDirectory = resolve(fileURLToPath(import.meta.url), "..");
const watch = process.argv.includes("--watch");

execPnpm(
  ["exec", "vite", "build", "-c", "vite.config.ts", ...(watch ? ["--watch"] : [])],
  { cwd: packageDirectory, stdio: "inherit" },
);
