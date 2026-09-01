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

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildContent,
  findInterruptedImportBackups,
  readSourceFiles,
  serializeArchive,
} from "./format-blueprint-files.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const sourceDir = resolve(pkgRoot, process.env.FORMAT_BLUEPRINTS_DIR ?? "format-blueprints");
const outFile = join(pkgRoot, "src", "generated", "format-blueprints.ts");

// Icons a blueprint may declare. Duplicated from the shared API's OUTPUT_ICONS because this script
// runs before (and without) a TypeScript build; the runtime validates against the real list, so
// the cost of drift is a build that rejects an icon the Worker would have accepted.
const OUTPUT_ICONS = ["fileText", "gridNine", "presentation", "appWindow", "flowArrow",
    "kanban", "chartBar", "table", "notebook", "listChecks"];

// Must match isReservedBlueprintKey() in src/blueprint-archive.ts. This build script runs without
// loading TypeScript modules, so keep the tiny control-key list here as well.
const RESERVED_BLUEPRINT_KEYS = new Set([".featured", ".adminConfig"]);

// Validated here rather than at runtime so a typo fails the build of whoever made it, instead of
// quietly presenting the wrong thing in production. Unknown keys are rejected too: silently
// ignoring one looks exactly like the field not working.
type FormatBlueprintManifest = {
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

type FormatBlueprintPresentation = Omit<FormatBlueprintManifest,
    "created" | "version" | "lastUpdated" | "bindings">;

function parsePresentation(
  label: string,
  parsed: Record<string, unknown>,
  allowedExtra: string[],
): FormatBlueprintPresentation {
  let bad = (message: string): never => { throw new Error(`${label}: ${message}`); };
  let {
    blueprintId, title, description, output, author, revision, $comment, ...rest
  } = parsed;
  let unknown = Object.keys(rest).filter(key => !allowedExtra.includes(key));
  if (unknown.length > 0) bad(`unknown keys: ${unknown.join(", ")}`);

  let string = (value: unknown, what: string): string => {
    if (typeof value !== "string" || value.trim() === "") bad(`${what} must be a non-empty string`);
    return value as string;
  };

  if (typeof blueprintId !== "string" || !/^[a-zA-Z0-9._-]+$/.test(blueprintId)) {
    bad("blueprintId must be a non-empty [a-zA-Z0-9._-] string");
  }
  if (RESERVED_BLUEPRINT_KEYS.has(blueprintId as string)) {
    bad(`blueprintId ${blueprintId} is reserved`);
  }
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    bad("revision must be a positive integer");
  }
  if (typeof output !== "object" || output === null) bad("output is required");
  let { id, noun, plural, icon, ...outputRest } = output as Record<string, unknown>;
  if (Object.keys(outputRest).length > 0) {
    bad(`unknown output keys: ${Object.keys(outputRest).join(", ")}`);
  }
  if (!OUTPUT_ICONS.includes(icon as string)) {
    bad(`output.icon must be one of: ${OUTPUT_ICONS.join(", ")}`);
  }
  if (typeof author !== "object" || author === null) bad("author is required");
  let {
    type: authorType, name: authorName, id: authorId, ...authorRest
  } = author as Record<string, unknown>;
  if (Object.keys(authorRest).length > 0) {
    bad(`unknown author keys: ${Object.keys(authorRest).join(", ")}`);
  }
  if (authorType !== undefined && authorType !== "user") bad(`author.type must be "user"`);

  return {
    blueprintId: blueprintId as string,
    title: string(title, "title"),
    description: string(description, "description"),
    output: {
      id: string(id, "output.id"),
      noun: string(noun, "output.noun"),
      plural: string(plural, "output.plural"),
      icon: icon as string,
    },
    author: {
      type: "user",
      name: string(authorName, "author.name"),
      id: string(authorId, "author.id"),
    },
    revision: revision as number,
  };
}

function parseManifest(name: string, raw: string): FormatBlueprintManifest {
  let label = `${name}/blueprint.json`;
  let bad = (message: string): never => { throw new Error(`${label}: ${message}`); };
  let parsed = JSON.parse(raw);
  let presentation = parsePresentation(label, parsed,
      ["created", "version", "lastUpdated", "bindings"]);
  let {created, version, lastUpdated, bindings} = parsed;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    bad("version must be a positive integer");
  }
  for (let [key, value] of [["created", created], ["lastUpdated", lastUpdated]] as const) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
      bad(`${key} must be an ISO date string`);
    }
  }
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) {
    bad("bindings must be an object");
  }

  return {
    ...presentation,
    created: created as string,
    version: version as number,
    lastUpdated: lastUpdated as string,
    bindings: bindings as Record<string, unknown>,
  };
}

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
    let manifest = parseManifest(name, raw);
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
    entry = parsePresentation(`${name}.json`, JSON.parse(raw), []);
    bytes = await readFile(join(sourceDir, `${name}.gadget`));
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
