// Bundles a directory of format blueprints into a generated TypeScript module, so the Worker can
// install them with no network access when a deployment first serves /api.
//
// The directory defaults to the blueprints `@gadgets/format-blueprints` ships, and
// `FORMAT_BLUEPRINTS_DIR` points somewhere else (relative to this package's root). That is how a
// deployment ships its own formats: this repo is often a submodule, so a fork can't add files here
// without conflicting on every update -- it keeps its blueprints in its own tree and points the
// build at them. Whatever directory is named *is* the deployment's format set; it replaces this one
// rather than adding to it. The reading, validating and bundling is that package's
// `generateFormatBlueprintsModule`; this script is the command line around it.
//
// `--out <path>` redirects the generated module, which is what lets a test run this generator
// without clobbering the module the package actually compiles. That module is read concurrently by
// sibling tasks (`build:integration-worker` and `test` both depend on `build:format-blueprints`),
// so a test writing the default path races them.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_BLUEPRINTS_DIR, generateFormatBlueprintsModule } from "@gadgets/format-blueprints";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const sourceDir = process.env.FORMAT_BLUEPRINTS_DIR
    ? resolve(pkgRoot, process.env.FORMAT_BLUEPRINTS_DIR)
    : BUNDLED_BLUEPRINTS_DIR;
const outFile = resolve(pkgRoot, parseOutFlag() ?? join("src", "generated", "format-blueprints.ts"));

const { text: generated, count, totalBytes } = await generateFormatBlueprintsModule(sourceDir, {
  builtFrom: process.env.FORMAT_BLUEPRINTS_DIR ? "FORMAT_BLUEPRINTS_DIR" : "blueprints/",
});

// Skip the write when nothing changed. This script runs as a prerequisite of `build` and `test`,
// and rewriting an identical module would give it a fresh mtime, invalidating tsc's incremental
// cache for the whole package on every invocation. Same reason build-browser-runtime.mjs and the
// two SPA builds compare before writing.
let unchanged = false;
try {
  unchanged = await readFile(outFile, "utf8") === generated;
} catch (err) {
  if (!isErrorCode(err, "ENOENT")) throw err;
}

if (unchanged) {
  console.log(`format blueprints up-to-date (${count}): ${outFile}`);
} else {
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, generated);
  console.log(`Bundled ${count} format blueprint(s) from ${sourceDir}, ` +
      `${(totalBytes / 1024).toFixed(0)} KiB raw -> ${outFile}`);
}

function isErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

// A flag rather than an env var on purpose: a new build-time `process.env` read in this package
// would be discovered by scripts/env-passthrough.test.ts, which would then require an `EXPECTED`
// entry here and an `env:` declaration on every task that runs this generator -- a guard
// interaction that buys nothing, since only tests ever pass it. Relative paths resolve against the
// package root, the same rule the `FORMAT_BLUEPRINTS_DIR` line above uses.
//
// Arguments other than `--out` are ignored rather than rejected, because this module is not always
// the entry point: import-format-blueprint.ts loads it in-process to regenerate the module after an
// import, and that script's own positional arguments are still on `process.argv` when it does. It
// forwards `--out` by leaving it there.
function parseOutFlag(): string | undefined {
  let args = process.argv.slice(2);
  let index = args.indexOf("--out");
  if (index === -1) return undefined;
  let value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--out requires a path");
  }
  return value;
}
