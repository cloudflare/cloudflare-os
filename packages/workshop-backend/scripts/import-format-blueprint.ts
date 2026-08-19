// Extracts a `.gadget` archive exported from a running Workshop into the repo's reviewable bundled
// format-blueprint source. See format-blueprints/README.md for the workflow this belongs to.

import { readdir, readFile, rename, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { extractFiles, parseArchive } from "./format-blueprint-files.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const sourceDir = resolve(pkgRoot, process.env.FORMAT_BLUEPRINTS_DIR ?? "format-blueprints");
type BlueprintManifest = {
  name: string;
  source: string;
  blueprintId: string;
  title: string;
  description: string;
  output: {id: string; noun: string; plural: string; icon: string};
  author: {type: "user"; name: string; id: string};
  revision: number;
  created: string;
  version: number;
  lastUpdated: string;
  bindings: Record<string, unknown>;
};

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

const manifests: BlueprintManifest[] = [];
for (const entry of (await readdir(sourceDir, {withFileTypes: true}))
    .filter(entry => entry.isDirectory()).toSorted((a, b) => a.name < b.name ? -1 : 1)) {
  const path = join(sourceDir, entry.name, "blueprint.json");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (err) {
    if (isErrorCode(err, "ENOENT")) continue;
    throw err;
  }
  manifests.push({name: entry.name, source, ...JSON.parse(source)} as BlueprintManifest);
}

const rawArgs = process.argv.slice(2);
const args = [...rawArgs];
const newAt = args.indexOf("--new");
const newName = newAt === -1 ? undefined : args.splice(newAt, 2)[1];
const [archivePath, blueprintId] = args;

if (!archivePath || (!blueprintId && !newName)) {
  console.error("usage: pnpm import:format-blueprint <export.gadget> <blueprintId>");
  console.error("       pnpm import:format-blueprint <export.gadget> --new <name>");
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
if (newName && !/^[a-zA-Z0-9._-]+$/.test(newName)) {
  fail(`--new ${newName}: name must be [a-zA-Z0-9._-]`);
}
if (newName && manifests.some(entry => entry.name === newName)) {
  fail(`${newName}/ already exists; import into it by blueprintId instead`);
}

const foundEntry = manifests.find(candidate => candidate.blueprintId === blueprintId);
if (!newName && !foundEntry) {
  fail(`no blueprint declares blueprintId "${blueprintId}". Use --new <name> to add one.`);
}
const entry: BlueprintManifest | {name: string; scaffold: true} = newName
    ? {name: newName, scaffold: true}
    : foundEntry!;

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

let oldFiles = new Map<string, string>();
if (!("scaffold" in entry)) {
  const oldDir = join(sourceDir, entry.name, "files");
  for (const file of await readdir(oldDir)) {
    oldFiles.set(file, await readFile(join(oldDir, file), "utf8"));
  }
}

const scaffold = "scaffold" in entry;
const title = scaffold ? String(incoming.metadata.title || entry.name) : entry.title;
const author = scaffold
    ? (manifests[0]?.author ?? incoming.metadata.author as BlueprintManifest["author"])
    : entry.author;
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
  ...JSON.parse(entry.source),
  revision: entry.revision + 1,
  created: String(incoming.metadata.created),
  version: Number(incoming.metadata.version),
  lastUpdated: String(incoming.metadata.lastUpdated),
  bindings: (incoming.metadata.bindings as Record<string, unknown> | undefined) ?? {},
};

const targetDir = join(sourceDir, entry.name);
const stagedDir = join(sourceDir, `.${entry.name}.import-${process.pid}`);
const backupDir = join(sourceDir, `.${entry.name}.backup-${process.pid}`);
await rm(stagedDir, {recursive: true, force: true});
await rm(backupDir, {recursive: true, force: true});
try {
  await mkdir(join(stagedDir, "files"), {recursive: true});
  await writeFile(join(stagedDir, "blueprint.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [filename, source] of files) {
    await writeFile(join(stagedDir, "files", filename), source);
  }
  if (!scaffold) await rename(targetDir, backupDir);
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

const changed = [...new Set([...oldFiles.keys(), ...files.keys()])]
    .filter(filename => oldFiles.get(filename) !== files.get(filename)).toSorted();
const oldBindings = Object.keys(scaffold ? {} : entry.bindings).toSorted().join(",");
const newBindings = Object.keys(manifest.bindings).toSorted().join(",");

console.log(`${scaffold ? "Imported" : "Updated"} ${entry.name}/ (${manifest.blueprintId})`);
console.log(`  files        ${files.size} (${changed.length ? `changed: ${changed.join(", ")}` : "unchanged"})`);
console.log(`  snapshot     ${incoming.content.byteLength} bytes (${sha(incoming.content)})`);
console.log(`  bindings     ${newBindings || "(none)"}` +
    `${oldBindings !== newBindings ? `   [CHANGED from ${oldBindings || "(none)"}]` : ""}`);
console.log(`  version      ${scaffold ? manifest.version : `${entry.version} -> ${manifest.version}`}`);
console.log(`  revision     ${scaffold ? "1 (new)" : `${entry.revision} -> ${manifest.revision}`}`);
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
await import("./build-format-blueprints.ts");
