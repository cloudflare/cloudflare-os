// Bundles a directory of format blueprints into a generated TypeScript module, so the Worker can
// install them with no network access when a deployment first serves /api.
//
// The directory defaults to this package's `format-blueprints/`, and `FORMAT_BLUEPRINTS_DIR`
// points somewhere else. That is how a deployment ships its own formats: this repo is often a
// submodule, so a fork can't add files here without conflicting on every update -- it keeps its
// blueprints in its own tree and points the build at them. Whatever directory is named *is* the
// deployment's format set; it replaces this one rather than adding to it.
//
// Each blueprint is a directory containing blueprint.json and a files/ directory. The reviewable
// source is converted to the ordinary binary .gadget representation only in the generated module.
//
// `--out <path>` redirects the generated module, which is what lets a test run this generator
// without clobbering the module the package actually compiles. That module is read concurrently by
// sibling tasks (`build:integration-worker` and `test` both depend on `build:format-blueprints`),
// so a test writing the default path races them.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildContent,
  extractFiles,
  findInterruptedImportBackups,
  parseArchive,
  readSourceFiles,
  serializeArchive,
  validatePortablePaths,
} from "./format-blueprint-files.ts";
import type {
  FormatBlueprintManifest,
  FormatBlueprintPresentation,
} from "./format-blueprint-manifest.ts";
import {
  parseFormatBlueprintManifest,
  parseFormatBlueprintPresentation,
} from "./format-blueprint-manifest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const sourceDir = resolve(pkgRoot, process.env.FORMAT_BLUEPRINTS_DIR ?? "format-blueprints");
const outFile = resolve(pkgRoot, parseOutFlag() ?? join("src", "generated", "format-blueprints.ts"));

// An empty directory is a supported way to ship no formats, so it is a warning rather than an
// error. A mistyped FORMAT_BLUEPRINTS_DIR fails in readdir() above, which is the case worth
// catching.
let allContents = await readdir(sourceDir, {withFileTypes: true});
let contents = allContents.filter(entry => !entry.name.startsWith("."));
let directoryPaths = new Map(contents
    .filter(entry => entry.isDirectory())
    .map(entry => [entry.name, entry.name]));
for (const [name, backup] of findInterruptedImportBackups(allContents, sourceDir)) {
  directoryPaths.set(name, backup);
}
let directories = [...directoryPaths.keys()].toSorted();
let directorySet = new Set(directories);
let files = contents.filter(entry => entry.isFile()).map(entry => entry.name);
let legacyNames = files.filter(file => file.endsWith(".gadget"))
    .map(file => basename(file, ".gadget"))
    .filter(name => !directorySet.has(name))
    .toSorted();
let expectedFiles = new Set(["README.md"]);
for (let name of legacyNames) {
  expectedFiles.add(`${name}.gadget`);
  expectedFiles.add(`${name}.json`);
  if (!files.includes(`${name}.json`)) {
    throw new Error(`${name}.gadget has no ${name}.json describing it.`);
  }
}
// An extracted directory wins over same-stem legacy files, making migration interruption-safe.
for (let name of directories) {
  expectedFiles.add(`${name}.gadget`);
  expectedFiles.add(`${name}.json`);
}
let unexpected = contents
    .filter(entry => !entry.isDirectory() && !expectedFiles.has(entry.name))
    .map(entry => entry.name);
if (unexpected.length > 0) {
  throw new Error(`Unexpected files in ${sourceDir}: ${unexpected.join(", ")}`);
}
if (directories.length === 0 && legacyNames.length === 0) {
  console.warn(`No blueprint directories in ${sourceDir}; the deployment will bundle no formats.`);
}

let entries: Array<Omit<FormatBlueprintManifest,
    "created" | "version" | "lastUpdated" | "bindings"> & {
      contentHash: string;
      archive: string;
    }> = [];
let totalBytes = 0;
let seen = new Map<string, string>();
let sources = [
  ...directories.map(name => ({name, directory: directoryPaths.get(name)!,
    kind: "extracted" as const})),
  ...legacyNames.map(name => ({name, kind: "legacy" as const})),
].toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
validatePortablePaths(sources.map(source => source.name), sourceDir);
for (let source of sources) {
  let {name} = source;
  let raw: string;
  let entry: FormatBlueprintPresentation;
  let bytes: Uint8Array;
  if (source.kind === "extracted") {
    let directory = source.directory;
    try {
      raw = await readFile(join(sourceDir, directory, "blueprint.json"), "utf8");
    } catch (err) {
      if (!isErrorCode(err, "ENOENT")) throw err;
      throw new Error(`${name}/ has no blueprint.json describing it.`, { cause: err });
    }
    let manifest = parseFormatBlueprintManifest(name, raw);
    let {created, version, lastUpdated, bindings, ...presentation} = manifest;
    entry = presentation;
    let sourceFiles = await readSourceFiles(join(sourceDir, directory, "files"), `${name}/files`);
    let metadata = {
      title: manifest.title,
      description: manifest.description,
      author: manifest.author,
      created,
      version,
      lastUpdated,
      bindings,
    };
    let content = buildContent(sourceFiles, name);
    bytes = serializeArchive(metadata, content, name);
  } else {
    raw = await readFile(join(sourceDir, `${name}.json`), "utf8");
    entry = parseFormatBlueprintPresentation(`${name}.json`, raw);
    bytes = await readFile(join(sourceDir, `${name}.gadget`));
    let archive = parseArchive(bytes, name);
    extractFiles(archive.content, name);
  }

  // Two archives installing under one id would race, and only one would survive.
  let duplicate = seen.get(entry.blueprintId);
  if (duplicate) {
    throw new Error(`${name} and ${duplicate} share blueprintId ${entry.blueprintId}`);
  }
  seen.set(entry.blueprintId, name);
  totalBytes += bytes.byteLength;
  let contentHash = createHash("sha256").update(bytes).digest("hex");
  entries.push({ ...entry, contentHash, archive: Buffer.from(bytes).toString("base64") });
}

let generated = `// GENERATED by scripts/build-format-blueprints.ts -- do not edit.
//
// The deployment's format blueprints, base64-encoded for bundling into the Worker. Extracted source
// is rebuilt into archives; legacy FORMAT_BLUEPRINTS_DIR archives are copied as-is. Built from
// ${process.env.FORMAT_BLUEPRINTS_DIR ? "FORMAT_BLUEPRINTS_DIR" : "format-blueprints/"}.

import type { AiChatAuthorInfo, BlueprintOutput } from "@gadgets/workshop-shared/api";

// One bundled blueprint: how to present it, and the archive that says what it does. The build
// validates the source manifest and files before constructing the archive.
export type BundledFormatBlueprint = {
  blueprintId: string;
  title: string;
  description: string;
  output: BlueprintOutput;
  author: AiChatAuthorInfo;

  // Bumped when the archive changes, to trigger a reinstall on deployments already holding an
  // older copy. Everything else here is covered by the install fingerprint.
  revision: number;

  // Fingerprints the generated archive so direct source-file edits trigger a reinstall.
  contentHash: string;

  // The archive's bytes, base64-encoded.
  archive: string;
};

export const FORMAT_BLUEPRINTS: BundledFormatBlueprint[] = ${JSON.stringify(entries, null, 2)};
`;

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
  console.log(`format blueprints up-to-date (${entries.length}): ${outFile}`);
} else {
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, generated);
  console.log(`Bundled ${entries.length} format blueprint(s) from ${sourceDir}, ` +
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
