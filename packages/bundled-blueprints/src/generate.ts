// Turns a directory of bundled blueprints into the text of a TypeScript module holding their
// files, so the Workshop backend can install them with no network access when a deployment
// first serves /api. The backend's `scripts/build-bundled-blueprints.ts` decides which directory,
// where the module goes and whether to write it; this is the part that reads and validates.
//
// Each blueprint is a directory containing blueprint.json and a files/ directory. The generated
// module holds the files as built, with the manifest beside them: the backend's installer is
// what turns them into the git commit an installed blueprint is.

import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractFiles,
  findInterruptedImportBackups,
  parseArchive,
  readSourceFiles,
  validatePortablePaths,
} from "./files.ts";
import type { BundledBlueprintManifest } from "./manifest.ts";
import {
  parseBundledBlueprintManifest,
  parseBundledBlueprintPresentation,
  parseBundledBlueprintProvenance,
} from "./manifest.ts";

/** The blueprints this repository ships: `blueprints/` beside this module's `src/`. */
export const BUNDLED_BLUEPRINTS_DIR: string =
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "blueprints");

/** What the caller wants the generated module's header to say it was built from. */
export type GenerateOptions = {
  /** Named in the module's header comment, e.g. `blueprints/` or `BUNDLED_BLUEPRINTS_DIR`. */
  builtFrom: string;
};

/** The generated module and what went into it. */
export type GeneratedModule = {
  /** The module's full text, ready to write. */
  text: string;
  /** How many blueprints it holds. */
  count: number;
  /** The files' size as UTF-8, summed over every blueprint. */
  totalBytes: number;
};

/**
 * Reads every blueprint under `sourceDir` and returns the generated module holding their files.
 *
 * Extracted directories (`<name>/blueprint.json` plus `<name>/files/`) are built; a legacy
 * `<name>.gadget` plus `<name>.json` pair is unpacked, which only a version 1 archive can be: a
 * newer export enters a blueprint directory through the importer, which writes the extracted
 * layout. An extracted directory wins over same-stem legacy files, and a `.<name>.backup-<pid>`
 * left by an interrupted import stands in for its missing directory, which is what makes
 * migration interruption-safe. Anything else in the directory other than README.md is an error,
 * as are two blueprints sharing a `blueprintId`.
 *
 * An empty directory is a supported way to ship no formats, so it is a warning rather than an
 * error; a mistyped directory fails in readdir(), which is the case worth catching.
 */
export async function generateBundledBlueprintsModule(
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
  // A backup beside its live directory is what an import interrupted after the swap leaves. It is
  // ignored while the directory exists and would stand in for it once the directory is deleted,
  // so it is named here; the next import of that blueprint removes it.
  for (let entry of allContents) {
    let name = /^\.(.+)\.backup-\d+$/su.exec(entry.name)?.[1];
    if (entry.isDirectory() && name !== undefined && directoryPaths.get(name) === name) {
      console.warn(`${entry.name} is left over from an interrupted import beside ${name}/ and ` +
          `is ignored; delete it, or import ${name} again.`);
    }
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

  let entries: Array<BundledBlueprintManifest & {
    contentHash: string;
    files: Array<[path: string, text: string]>;
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
    let manifest: BundledBlueprintManifest;
    let sourceFiles: Map<string, string>;
    if (source.kind === "extracted") {
      let directory = source.directory;
      let raw: string;
      try {
        raw = await readFile(join(sourceDir, directory, "blueprint.json"), "utf8");
      } catch (err) {
        if (!isErrorCode(err, "ENOENT")) throw err;
        throw new Error(`${name}/ has no blueprint.json describing it.`, { cause: err });
      }
      manifest = parseBundledBlueprintManifest(name, raw);
      sourceFiles = await readSourceFiles(join(sourceDir, directory, "files"), `${name}/files`);
    } else {
      let raw = await readFile(join(sourceDir, `${name}.json`), "utf8");
      let archive = parseArchive(await readFile(join(sourceDir, `${name}.gadget`)), name);
      if (archive.version !== 1) {
        throw new Error(`${name}.gadget is a version ${archive.version} archive, which the ` +
            `${name}.gadget plus ${name}.json layout cannot hold. Import it instead, with ` +
            `pnpm import:bundled-blueprint, which rewrites ${name} as a directory.`);
      }
      // The archive supplies what the blueprint does -- its code, its bindings and the dates from
      // the workspace it was exported from. How it is presented comes from the file beside it.
      manifest = {
        ...parseBundledBlueprintPresentation(`${name}.json`, raw),
        // An archive that names no bindings declares none, as the importer reads it too.
        ...parseBundledBlueprintProvenance(`${name}.gadget`,
            {...archive.metadata, bindings: archive.metadata.bindings ?? {}}),
      };
      sourceFiles = extractFiles(archive.content, name);
    }

    // Two blueprints installing under one id would race, and only one would survive.
    let duplicate = seen.get(manifest.blueprintId);
    if (duplicate) {
      throw new Error(`${name} and ${duplicate} share blueprintId ${manifest.blueprintId}`);
    }
    seen.set(manifest.blueprintId, name);

    // Sorted, so that the module and the fingerprint below depend on what the files are and not
    // on the order a directory or an archive happened to list them in.
    let sorted = [...sourceFiles].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    for (let [, text] of sorted) totalBytes += Buffer.byteLength(text);
    let {created, version, lastUpdated, bindings} = manifest;
    let contentHash = createHash("sha256")
        .update(JSON.stringify({created, version, lastUpdated, bindings, files: sorted}))
        .digest("hex");
    entries.push({ ...manifest, contentHash, files: sorted });
  }

  let text = `// GENERATED by @gadgets/bundled-blueprints through scripts/build-bundled-blueprints.ts -- do not edit.
//
// The deployment's bundled blueprints, for bundling into the Worker: each one's manifest, and its
// files as the build produced them. Extracted source is built; legacy BUNDLED_BLUEPRINTS_DIR
// archives are unpacked. Built from ${builtFrom}.

import type {
  AiChatAuthorInfo, BlueprintBinding, BlueprintOutput,
} from "@gadgets/workshop-shared/api";

// One bundled blueprint: how to present it, and the files and metadata that say what it does.
// The build validates the source manifest and files before writing them here.
export type BundledBlueprint = {
  blueprintId: string;
  title: string;
  description: string;
  output: BlueprintOutput;
  author: AiChatAuthorInfo;

  // Bumped when the blueprint changes, to trigger a reinstall on deployments already holding an
  // older copy. Everything else here is covered by the install fingerprint.
  revision: number;

  // What BlueprintMetadata holds under the same names, from the workspace the blueprint was
  // exported from. The dates are ISO strings.
  created: string;
  version: number;
  lastUpdated: string;
  bindings: Record<string, BlueprintBinding>;

  // Fingerprints the files and the four fields above, so direct source-file edits trigger a
  // reinstall.
  contentHash: string;

  // The blueprint's files, sorted by path. Pairs rather than an object, which could not hold a
  // file named \`__proto__\`.
  files: Array<[path: string, text: string]>;
};

export const BUNDLED_BLUEPRINTS: BundledBlueprint[] = ${JSON.stringify(entries, null, 2)};
`;

  return { text, count: entries.length, totalBytes };
}

function isErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
