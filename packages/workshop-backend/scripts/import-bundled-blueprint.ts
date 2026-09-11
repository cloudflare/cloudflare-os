// Extracts a `.gadget` archive exported from a running Workshop into the repo's reviewable bundled
// bundled-blueprint source, in `@gadgets/bundled-blueprints` or in the `BUNDLED_BLUEPRINTS_DIR` tree
// (resolved against this package's root, as build-bundled-blueprints.ts resolves it). See that
// package's README for the workflow this belongs to.

import { access, cp, readdir, readFile, rename, rm, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type {
  BundledBlueprintManifest,
  BundledBlueprintPresentation,
} from "@gadgets/bundled-blueprints";
import {
  BUNDLED_BLUEPRINTS_DIR,
  buildContent,
  extractFiles,
  findInterruptedImportBackups,
  parseArchive,
  parseBundledBlueprintManifest,
  parseBundledBlueprintPresentation,
  readSourceFiles,
  validatePortablePaths,
} from "@gadgets/bundled-blueprints";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const sourceDir = process.env.BUNDLED_BLUEPRINTS_DIR
    ? resolve(pkgRoot, process.env.BUNDLED_BLUEPRINTS_DIR)
    : BUNDLED_BLUEPRINTS_DIR;
type BlueprintPresentation = BundledBlueprintPresentation & {
  name: string;
  source: string;
};
type BlueprintManifest = BundledBlueprintManifest & {name: string; source: string};
type BlueprintEntry = (BlueprintManifest & {layout: "extracted"}) |
    (BlueprintPresentation & {layout: "legacy"});

const sha = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex").slice(0, 12);

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

function rejectIgnoredBlueprintPaths(name: string, files: Iterable<string>): void {
  const paths = [join(sourceDir, name, "blueprint.json"),
    ...[...files].map(file => join(sourceDir, name, "files", file))];
  const result = spawnSync("git", ["-C", sourceDir, "check-ignore", "-z", "--stdin"], {
    input: `${paths.join("\0")}\0`,
    encoding: "utf8",
  });
  if (result.status === 1) return;
  if (result.status === 128 && result.stderr.includes("not a git repository")) return;
  if (result.status !== 0) {
    fail(`could not check whether extracted files are ignored by Git: ` +
        `${result.error?.message ?? result.stderr.trim()}`);
  }
  const ignored = result.stdout.split("\0").filter(Boolean)
      .map(path => relative(sourceDir, path));
  fail(`imported blueprint paths are ignored by Git: ${ignored.join(", ")}`);
}

let directoryEntries = await readdir(sourceDir, {withFileTypes: true});
const interruptedBackups = findInterruptedImportBackups(directoryEntries, sourceDir);
for (const [name, backup] of interruptedBackups) {
  await rename(join(sourceDir, backup), join(sourceDir, name));
}
if (interruptedBackups.size > 0) {
  directoryEntries = await readdir(sourceDir, {withFileTypes: true});
}
const extractedNames = new Set(directoryEntries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
    .map(entry => entry.name));
const manifests: BlueprintEntry[] = [];
for (const dirent of directoryEntries
    .filter(candidate => candidate.isDirectory() && !candidate.name.startsWith("."))
    .toSorted((a, b) => a.name < b.name ? -1 : 1)) {
  const path = join(sourceDir, dirent.name, "blueprint.json");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (err) {
    if (isErrorCode(err, "ENOENT")) continue;
    throw err;
  }
  let manifest = parseBundledBlueprintManifest(dirent.name, source);
  manifests.push({...manifest, name: dirent.name, source, layout: "extracted"});
}
for (const dirent of directoryEntries
    .filter(candidate => candidate.isFile() && candidate.name.endsWith(".json") &&
        !candidate.name.startsWith(".") &&
        !extractedNames.has(basename(candidate.name, ".json")))
    .toSorted((a, b) => a.name < b.name ? -1 : 1)) {
  const name = basename(dirent.name, ".json");
  try {
    await access(join(sourceDir, `${name}.gadget`));
  } catch (err) {
    if (isErrorCode(err, "ENOENT")) continue;
    throw err;
  }
  const source = await readFile(join(sourceDir, dirent.name), "utf8");
  let presentation = parseBundledBlueprintPresentation(`${name}.json`, source);
  manifests.push({...presentation, name, source, layout: "legacy"});
}

const rawArgs = process.argv.slice(2);
const args = [...rawArgs];
// `--out <path>` is not this script's flag: it belongs to build-bundled-blueprints.ts, which the
// last line of this file loads in-process to regenerate the bundled module. Taken out of the
// positional arguments here and deliberately left on `process.argv`, which is where that script
// reads it from. Tests pass it so importing a fixture does not overwrite the module the package
// actually compiles -- sibling `vp` tasks read it while this suite runs.
const outAt = args.indexOf("--out");
if (outAt !== -1) {
  const outPath = args[outAt + 1];
  if (outPath === undefined || outPath.startsWith("--")) fail("--out requires a path");
  args.splice(outAt, 2);
}
const newAt = args.indexOf("--new");
const newName = newAt === -1 ? undefined : args.splice(newAt, 2)[1];
const [archivePath, blueprintId] = args;

if (!archivePath || (!blueprintId && !newName)) {
  console.error("usage: pnpm import:bundled-blueprint <export.gadget> <blueprintId>");
  console.error("       pnpm import:bundled-blueprint <export.gadget> --new <name>");
  console.error("");
  console.error(`formats in ${sourceDir}:`);
  for (const entry of manifests) {
    console.error(`  ${entry.blueprintId.padEnd(20)} ${entry.name}/`);
  }
  process.exit(2);
}
if (newAt !== -1 && !newName) fail("--new requires a name");
if ((newName && args.length !== 1) || (!newName && args.length !== 2) ||
    rawArgs.filter(arg => arg === "--new").length > 1) {
  fail("unexpected arguments");
}
if (newName && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(newName)) {
  fail(`--new ${newName}: name must start with an alphanumeric character and contain only ` +
      `[a-zA-Z0-9._-]`);
}
if (newName && manifests.some(entry => entry.name === newName)) {
  fail(`${newName}/ already exists; import into it by blueprintId instead`);
}

const foundEntry = manifests.find(candidate => candidate.blueprintId === blueprintId);
if (!newName && !foundEntry) {
  fail(`no blueprint declares blueprintId "${blueprintId}". Use --new <name> to add one.`);
}
const entry: BlueprintEntry | {name: string; scaffold: true} = newName
    ? {name: newName, scaffold: true}
    : foundEntry!;
validatePortablePaths(new Set([...manifests.map(manifest => manifest.name), entry.name]), sourceDir);

let incomingBytes: Uint8Array;
try {
  incomingBytes = await readFile(resolve(archivePath));
} catch (err) {
  fail(isErrorCode(err, "ENOENT") ? `no such file: ${archivePath}` :
    `${archivePath}: ${errorMessage(err)}`);
}

let incoming: ReturnType<typeof parseArchive>;
let files: Map<string, string>;
try {
  incoming = parseArchive(incomingBytes, archivePath);
  files = extractFiles(incoming.content, archivePath);
} catch (err) {
  fail(errorMessage(err));
}
rejectIgnoredBlueprintPaths(entry.name, files.keys());

// The outgoing files, read only for the change summary below; undefined if the current TypeScript
// source does not build, which the import warns about rather than refuses over (the archive being
// imported may be what repairs it).
let oldFiles: Map<string, string> | undefined;
let current: BlueprintManifest | undefined;
if ("scaffold" in entry) {
  oldFiles = new Map();
} else if (entry.layout === "legacy") {
  let existing = parseArchive(await readFile(join(sourceDir, `${entry.name}.gadget`)),
      `${entry.name}.gadget`);
  oldFiles = extractFiles(existing.content, `${entry.name}.gadget`);
  current = {
    ...entry,
    created: String(existing.metadata.created),
    version: Number(existing.metadata.version),
    lastUpdated: String(existing.metadata.lastUpdated),
    bindings: (existing.metadata.bindings as Record<string, unknown> | undefined) ?? {},
  };
} else {
  try {
    oldFiles = await readSourceFiles(join(sourceDir, entry.name, "files"), `${entry.name}/files`);
  } catch (err) {
    console.error(`warning: ${entry.name}/files does not build (${errorMessage(err)}); the ` +
        "change summary compares against nothing");
  }
  current = entry;
}

const scaffold = "scaffold" in entry;
const title = scaffold ? String(incoming.metadata.title || entry.name) : current!.title;
const author = scaffold
    ? (manifests[0]?.author ?? incoming.metadata.author as BlueprintManifest["author"])
    : current!.author;
const manifest = scaffold ? {
  blueprintId: entry.name,
  title,
  description: String(incoming.metadata.description || `TODO: say what a ${title} is for.`),
  output: {id: entry.name, noun: title, plural: `${title}s`, icon: "appWindow"},
  author,
  revision: 1,
  created: String(incoming.metadata.created),
  version: Number(incoming.metadata.version),
  lastUpdated: String(incoming.metadata.lastUpdated),
  bindings: (incoming.metadata.bindings as Record<string, unknown> | undefined) ?? {},
} : {
  ...JSON.parse(current!.source),
  revision: current!.revision + 1,
  created: String(incoming.metadata.created),
  version: Number(incoming.metadata.version),
  lastUpdated: String(incoming.metadata.lastUpdated),
  bindings: (incoming.metadata.bindings as Record<string, unknown> | undefined) ?? {},
};
parseBundledBlueprintManifest(entry.name, JSON.stringify(manifest));
const duplicate = manifests.find(candidate => candidate.name !== entry.name &&
    candidate.blueprintId === manifest.blueprintId);
if (duplicate) {
  fail(`blueprint ID ${manifest.blueprintId} is already used by ${duplicate.name}`);
}

const targetDir = join(sourceDir, entry.name);
const stagedDir = join(sourceDir, `.${entry.name}.import-${process.pid}`);
const backupDir = join(sourceDir, `.${entry.name}.backup-${process.pid}`);
await rm(stagedDir, {recursive: true, force: true});
await rm(backupDir, {recursive: true, force: true});
try {
  await mkdir(join(stagedDir, "files"), {recursive: true});
  await writeFile(join(stagedDir, "blueprint.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [filename, source] of files) {
    const path = join(stagedDir, "files", filename);
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, source);
  }
  // The staged tree is built before it replaces anything: the bundler policy the post-rename build
  // applies to files/ is applied here first, so an export it rejects is refused with the current
  // source untouched. The snapshot is built too, since the bundles inline lib/ into each entry and
  // can outgrow sources that were under the limit; buildContent holds the update-size limit
  // generation applies. The metadata's own limit was met when the export's manifest was read.
  buildContent(await readSourceFiles(join(stagedDir, "files"), `${entry.name}/files`), entry.name);
  if (!scaffold && entry.layout === "extracted") {
    // Only blueprint.json and files/ are archive-owned; __tests__/ and anything else beside them
    // is repo-only and carried over -- copied, not moved, so a failure below leaves the current
    // tree whole for the restore in the catch. A symlink is copied as written: cp would otherwise
    // rewrite a relative target to an absolute path under this checkout.
    for (const name of await readdir(targetDir)) {
      if (name !== "blueprint.json" && name !== "files") {
        await cp(join(targetDir, name), join(stagedDir, name),
            {recursive: true, verbatimSymlinks: true});
      }
    }
    await rename(targetDir, backupDir);
  }
  await rename(stagedDir, targetDir);
  await rm(backupDir, {recursive: true, force: true});
} catch (err) {
  await rm(stagedDir, {recursive: true, force: true});
  try {
    await rename(backupDir, targetDir);
  } catch (restoreErr) {
    if (!isErrorCode(restoreErr, "ENOENT")) {
      throw new Error(`Failed to install blueprint source (${errorMessage(err)}) and restore it`, {
        cause: restoreErr,
      });
    }
  }
  throw err;
}
// An extracted directory is authoritative if migration was interrupted, so cleanup can safely be
// retried by a later import without ever making the legacy pair win again.
await rm(join(sourceDir, `${entry.name}.gadget`), {force: true});
await rm(join(sourceDir, `${entry.name}.json`), {force: true});

const changed = oldFiles && [...new Set([...oldFiles.keys(), ...files.keys()])]
    .filter(filename => oldFiles.get(filename) !== files.get(filename)).toSorted();
const oldBindings = Object.keys(scaffold ? {} : current!.bindings).toSorted().join(",");
const newBindings = Object.keys(manifest.bindings).toSorted().join(",");

console.log(`${scaffold ? "Imported" : "Updated"} ${entry.name}/ (${manifest.blueprintId})`);
console.log(`  files        ${files.size} (${changed === undefined
    ? "summary unavailable: current source does not build"
    : changed.length ? `changed: ${changed.join(", ")}` : "unchanged"})`);
console.log(`  snapshot     ${incoming.content.byteLength} bytes (${sha(incoming.content)})`);
console.log(`  bindings     ${newBindings || "(none)"}` +
    `${oldBindings !== newBindings ? `   [CHANGED from ${oldBindings || "(none)"}]` : ""}`);
console.log(`  version      ${scaffold ? manifest.version : `${current!.version} -> ${manifest.version}`}`);
console.log(`  revision     ${scaffold ? "1 (new)" : `${current!.revision} -> ${manifest.revision}`}`);
console.log(`  presented as "${manifest.title}" by ${manifest.author.name}` +
    `${incoming.metadata.title !== manifest.title ? ` [export called it "${incoming.metadata.title}"]` : ""}`);

if (scaffold) {
  console.log("");
  console.log(`  Edit ${entry.name}/blueprint.json before deploying:`);
  console.log(`    blueprintId  "${manifest.blueprintId}" -- fixed once deployed`);
  console.log(`    output.id    "${manifest.output.id}" -- use a generic grouping word`);
  console.log(`    description  replace the scaffold text`);
}

console.log("");
await import("./build-bundled-blueprints.ts");
