#!/usr/bin/env node

// `node scripts/vp-run.ts <args…>` is `vp run <args…>` with `VP_RUN_CONCURRENCY_LIMIT` set from the
// machine (see vp-concurrency.ts). The root `build`, `test` and `clean` scripts go through it.
//
// Spawns `node_modules/vite-plus/bin/vp` under the current `node` directly: `vite-plus` is a root
// devDependency, so it is always there, and this is shell-free (Windows-safe) and skips the ~0.33s of
// `pnpm exec` startup the repo avoids elsewhere (bin-entry.ts). `resolveBinEntry` can't be used for
// it because it keys the `bin` map on the package name, and `vite-plus`'s has no `vite-plus` entry.
//
// No argument parsing: `--concurrency-limit N` still works if passed, since vite-task gives the flag
// priority over the env var.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { relayTermination } from "./relay-termination.ts";
import { vpRunEnv } from "./vp-concurrency.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VP = join(ROOT, "node_modules", "vite-plus", "bin", "vp");

const child = spawn(process.execPath, [VP, "run", ...process.argv.slice(2)],
    { stdio: "inherit", env: vpRunEnv() });

relayTermination(child);
