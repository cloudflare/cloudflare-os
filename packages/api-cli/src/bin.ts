#!/usr/bin/env node

// The `cf-os` bin, run as `pnpm cf-os api ...` or `pnpm exec cf-os api ...`. It brings the generated
// commands up to date with this checkout's API, then runs main.ts in this process. The generator
// runs as a child of this process's own Node, with no shell, so each argument keeps its exact value
// on Windows too, and the runtime's import graph stays what main.test.ts allows.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const generator = fileURLToPath(new URL("../../api-schema/scripts/generate.ts", import.meta.url));
const generation = spawnSync(process.execPath, [generator, "--if-stale"], { stdio: ["ignore", "inherit", "inherit"] });
if (generation.error) console.error(`Could not run ${generator}: ${generation.error.message}`);
if (generation.status !== 0) process.exit(generation.status ?? 1);

// Imported only now, as main.ts loads generated/commands.ts, which the generation may have just written.
const { main } = await import("./main.ts");
await main();
