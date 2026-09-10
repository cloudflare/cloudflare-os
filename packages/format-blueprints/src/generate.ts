// Turns a directory of format blueprints into the text of a TypeScript module holding their
// archives, so the Workshop backend can install them with no network access when a deployment
// first serves /api. The backend's `scripts/build-format-blueprints.ts` decides which directory,
// where the module goes and whether to write it; this is the part that reads and validates.
//
// Each blueprint is a directory containing blueprint.json and a files/ directory. The reviewable
// source is converted to the ordinary binary .gadget representation only in the generated module.

import { readdir, readFile } from "node:fs/promises";
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
} from "./files.ts";
import type { FormatBlueprintManifest, FormatBlueprintPresentation } from "./manifest.ts";
import { parseFormatBlueprintManifest, parseFormatBlueprintPresentation } from "./manifest.ts";

/** The blueprints this repository ships: `blueprints/` beside this module's `src/`. */
export const BUNDLED_BLUEPRINTS_DIR: string =
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "blueprints");

/** What the caller wants the generated module's header to say it was built from. */
export type GenerateOptions = {
  /** Named in the module's header comment, e.g. `blueprints/` or `FORMAT_BLUEPRINTS_DIR`. */
  builtFrom: string;
};

/** The generated module and what went into it. */
export type GeneratedModule = {
  /** The module's full text, ready to write. */
  text: string;
  /** How many blueprints it holds. */
  count: number;
  /** The archives' raw size before base64 encoding, summed. */
  totalBytes: number;
};

/**
 * Reads every blueprint under `sourceDir` and returns the generated module holding their archives.
 *
 * Extracted directories (`<name>/blueprint.json` plus `<name>/files/`) are rebuilt into archives;
 * a legacy `<name>.gadget` plus `<name>.json` pair is copied as-is. An extracted directory wins
 * over same-stem legacy files, and a `.<name>.backup-<pid>` left by an interrupted import stands
 * in for its missing directory, which is what makes migration interruption-safe. Anything else in
 * the directory other than README.md is an error, as are two blueprints sharing a `blueprintId`.
 *
 * An empty directory is a supported way to ship no formats, so it is a warning rather than an
 * error; a mistyped directory fails in readdir(), which is the case worth catching.
 */
export async function generateFormatBlueprintsModule(
  sourceDir: string,
  { builtFrom }: GenerateOptions,
): Promise<GeneratedModule> {
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

  let text = `// GENERATED by @gadgets/format-blueprints through scripts/build-format-blueprints.ts -- do not edit.
//
// The deployment's format blueprints, base64-encoded for bundling into the Worker. Extracted source
// is rebuilt into archives; legacy FORMAT_BLUEPRINTS_DIR archives are copied as-is. Built from
// ${builtFrom}.

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

  return { text, count: entries.length, totalBytes };
}

function isErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
