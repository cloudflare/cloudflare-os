// Bundles a directory of format blueprints into a generated TypeScript module, so the Worker can
// install them with no network access when a deployment first serves /api.
//
// The directory defaults to this package's `format-blueprints/`, and `FORMAT_BLUEPRINTS_DIR`
// points somewhere else. That is how a deployment ships its own formats: this repo is often a
// submodule, so a fork can't add files here without conflicting on every update -- it keeps its
// archives in its own tree and points the build at them. Whatever directory is named *is* the
// deployment's format set; it replaces this one rather than adding to it.
//
// Each blueprint is a `<name>.gadget` archive and a `<name>.json` beside it describing how to
// present it. Nothing references a list, so a directory outside this repo is self-contained.
//
// Archives are binary, so they are emitted as base64 -- the same "bundle a data file as a
// generated module" approach gatekeeper-context uses for its SPA.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

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
function parseSidecar(name, raw) {
  let bad = (message) => { throw new Error(`${name}.json: ${message}`); };
  let parsed = JSON.parse(raw);

  let string = (value, what) => {
    if (typeof value !== "string" || value.trim() === "") bad(`${what} must be a non-empty string`);
    return value;
  };

  let { blueprintId, title, description, output, author, revision, $comment, ...rest } = parsed;
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
    blueprintId,
    title: string(title, "title"),
    description: string(description, "description"),
    output: {
      id: string(id, "output.id"),
      noun: string(noun, "output.noun"),
      plural: string(plural, "output.plural"),
      icon,
    },
    author: {
      type: "user",
      name: string(authorName, "author.name"),
      id: string(authorId, "author.id"),
    },
    revision,
  };
}

// An empty directory is a supported way to ship no formats, so it is a warning rather than an
// error. A mistyped FORMAT_BLUEPRINTS_DIR fails in readdir() above, which is the case worth
// catching.
let archives = (await readdir(sourceDir)).filter((f) => f.endsWith(".gadget")).toSorted();
if (archives.length === 0) {
  console.warn(`No *.gadget archives in ${sourceDir}; the deployment will bundle no formats.`);
}

let entries = [];
let totalBytes = 0;
let seen = new Map();
for (let file of archives) {
  let name = basename(file, ".gadget");
  let raw;
  try {
    raw = await readFile(join(sourceDir, `${name}.json`), "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    throw new Error(`${file} has no ${name}.json describing it.`, { cause: err });
  }

  let entry = parseSidecar(name, raw);
  // Two archives installing under one id would race, and only one would survive.
  let duplicate = seen.get(entry.blueprintId);
  if (duplicate) throw new Error(`${name}.json and ${duplicate}.json share id ${entry.blueprintId}`);
  seen.set(entry.blueprintId, name);

  let bytes = await readFile(join(sourceDir, file));
  totalBytes += bytes.byteLength;
  entries.push({ ...entry, archive: bytes.toString("base64") });
}

let generated = `// GENERATED by scripts/build-format-blueprints.mjs -- do not edit.
//
// The deployment's format blueprints, with their archives base64-encoded so they can be bundled
// into the Worker. Built from ${process.env.FORMAT_BLUEPRINTS_DIR ? "FORMAT_BLUEPRINTS_DIR" : "format-blueprints/"}.

import type { AiChatAuthorInfo, BlueprintOutput } from "@gadgets/workshop-shared/api";

// One bundled blueprint: how to present it, and the archive that says what it does. The build
// validates these sidecar fields; the archive itself is copied verbatim and checked when the
// importer writes it.
export type BundledFormatBlueprint = {
  blueprintId: string;
  title: string;
  description: string;
  output: BlueprintOutput;
  author: AiChatAuthorInfo;

  // Bumped when the archive changes, to trigger a reinstall on deployments already holding an
  // older copy. Everything else here is covered by the install fingerprint.
  revision: number;

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
  if (err?.code !== "ENOENT") throw err;
}

if (unchanged) {
  console.log(`format blueprints up-to-date (${entries.length}): ${outFile}`);
} else {
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, generated);
  console.log(`Bundled ${entries.length} format blueprint(s) from ${sourceDir}, ` +
      `${(totalBytes / 1024).toFixed(0)} KiB raw -> ${outFile}`);
}
