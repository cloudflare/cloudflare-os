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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContent, readSourceFiles, serializeArchive } from "./format-blueprint-files.ts";

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

function parseManifest(name: string, raw: string): FormatBlueprintManifest {
  let bad = (message: string): never => { throw new Error(`${name}/blueprint.json: ${message}`); };
  let parsed = JSON.parse(raw);

  let string = (value: unknown, what: string): string => {
    if (typeof value !== "string" || value.trim() === "") bad(`${what} must be a non-empty string`);
    return value as string;
  };

  let {
    blueprintId, title, description, output, author, revision, created, version, lastUpdated,
    bindings, $comment, ...rest
  } = parsed;
  if (Object.keys(rest).length > 0) bad(`unknown keys: ${Object.keys(rest).join(", ")}`);

  if (!/^[a-zA-Z0-9._-]+$/.test(blueprintId ?? "")) {
    bad("blueprintId must be a non-empty [a-zA-Z0-9._-] string");
  }
  if (RESERVED_BLUEPRINT_KEYS.has(blueprintId)) {
    bad(`blueprintId ${blueprintId} is reserved`);
  }
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    bad("revision must be a positive integer");
  }
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
  if (typeof output !== "object" || output === null) bad("output is required");
  let { id, noun, plural, icon, ...outputRest } = output;
  if (Object.keys(outputRest).length > 0) {
    bad(`unknown output keys: ${Object.keys(outputRest).join(", ")}`);
  }
  if (!OUTPUT_ICONS.includes(icon)) {
    bad(`output.icon must be one of: ${OUTPUT_ICONS.join(", ")}`);
  }
  if (typeof author !== "object" || author === null) bad("author is required");
  let { type: authorType, name: authorName, id: authorId, ...authorRest } = author;
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
    revision,
    created: created as string,
    version: version as number,
    lastUpdated: lastUpdated as string,
    bindings: bindings as Record<string, unknown>,
  };
}

// An empty directory is a supported way to ship no formats, so it is a warning rather than an
// error. A mistyped FORMAT_BLUEPRINTS_DIR fails in readdir() above, which is the case worth
// catching.
let contents = (await readdir(sourceDir, {withFileTypes: true}))
    .filter(entry => !entry.name.startsWith("."));
let directories = contents
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .toSorted();
let unexpected = contents
    .filter(entry => !entry.isDirectory() && entry.name !== "README.md")
    .map(entry => entry.name);
if (unexpected.length > 0) {
  throw new Error(`Unexpected files in ${sourceDir}: ${unexpected.join(", ")}`);
}
if (directories.length === 0) {
  console.warn(`No blueprint directories in ${sourceDir}; the deployment will bundle no formats.`);
}

let entries: Array<Omit<FormatBlueprintManifest,
    "created" | "version" | "lastUpdated" | "bindings"> & {
      contentHash: string;
      archive: string;
    }> = [];
let totalBytes = 0;
let seen = new Map();
for (let name of directories) {
  let raw: string;
  try {
    raw = await readFile(join(sourceDir, name, "blueprint.json"), "utf8");
  } catch (err) {
    if (!isErrorCode(err, "ENOENT")) throw err;
    throw new Error(`${name}/ has no blueprint.json describing it.`, { cause: err });
  }

  let entry = parseManifest(name, raw);
  // Two archives installing under one id would race, and only one would survive.
  let duplicate = seen.get(entry.blueprintId);
  if (duplicate) {
    throw new Error(`${name}/blueprint.json and ${duplicate}/blueprint.json share id ` +
        entry.blueprintId);
  }
  seen.set(entry.blueprintId, name);

  let files = await readSourceFiles(join(sourceDir, name, "files"), `${name}/files`);
  let metadata = {
    title: entry.title,
    description: entry.description,
    author: entry.author,
    created: entry.created,
    version: entry.version,
    lastUpdated: entry.lastUpdated,
    bindings: entry.bindings,
  };
  let content = buildContent(files, name);
  let bytes = serializeArchive(metadata, content, name);
  totalBytes += bytes.byteLength;
  let {created, version, lastUpdated, bindings, ...bundled} = entry;
  let contentHash = createHash("sha256").update(bytes).digest("hex");
  entries.push({ ...bundled, contentHash, archive: Buffer.from(bytes).toString("base64") });
}

let generated = `// GENERATED by scripts/build-format-blueprints.ts -- do not edit.
//
// The deployment's format blueprints, rebuilt from reviewable source and base64-encoded for bundling
// into the Worker. Built from ${process.env.FORMAT_BLUEPRINTS_DIR ? "FORMAT_BLUEPRINTS_DIR" : "format-blueprints/"}.

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
