// The gadget libraries' source tree, as the two build scripts see it: `build-gadget-libraries.ts`
// bundles every library found here, and `format-blueprint-files.ts` checks a blueprint's pins
// against the same set, so a blueprint cannot pin a library the deployment will not ship.
//
// The tree is `packages/gadget-libraries`, one directory per library, each described by its
// `library.json`. Reached by workspace path rather than through the package's `exports` (which
// name the modules, not the manifests), and always this repo's own: unlike format blueprints, the
// libraries have no `FORMAT_BLUEPRINTS_DIR`-style override -- a fork that needs another library
// adds a directory here.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LIBRARY_NAME_PATTERN, type LibrarySide } from "../src/gadget-libraries.ts";

/** Absolute path of `packages/gadget-libraries`. */
export const GADGET_LIBRARIES_DIR = resolve(
    dirname(fileURLToPath(import.meta.url)), "..", "..", "gadget-libraries");

/**
 * Where `build-gadget-library-types.ts` emits the libraries' declarations and
 * `build-gadget-libraries.ts` reads them back: `<dir>/<side>/<name>/{client,server}.d.ts` plus
 * that side's `src/*.d.ts`. Under this package's `dist/` rather than `src/generated`: the trees
 * are text the generator copies into the module, not modules anything imports, and a `.d.ts`
 * under `src/` would join every program that includes `src` -- where a client declaration's
 * `gadgets:ui/client` import would drag the library's browser sources under the Workers globals.
 * `dist/` is gitignored, excluded by every tsconfig here, and what `pnpm clean` removes.
 */
export const GADGET_LIBRARY_TYPES_DIR = resolve(
    dirname(fileURLToPath(import.meta.url)), "..", "dist", "gadget-library-types");

/** The declaration tree of one side. */
export function librarySideTypesDir(side: LibrarySide): string {
  return join(GADGET_LIBRARY_TYPES_DIR, side);
}

/**
 * A library's own account of itself, `<name>/library.json`. `version` and `notes` exist for people
 * and for the agent's `listGadgetLibraries`: nothing resolves a pin by version, since a gadget
 * pinned to `latest` runs whatever the deployment ships.
 */
export type GadgetLibraryManifest = {
  /** The directory name, and the `<name>` in `gadgets:<name>/client`; `[a-z][a-z0-9-]*`. */
  name: string;
  /** Semantic version, bumped by hand when the library's behaviour changes. */
  version: string;
  /** One paragraph on what the library is and what changed last, shown to the agent. */
  notes: string;
};

/**
 * Parses one \`<name>/library.json\` strictly: \`name\` must equal the directory's name and match
 * {@link LIBRARY_NAME_PATTERN}, \`version\` must be MAJOR.MINOR.PATCH, \`notes\` must be non-empty, and
 * no other key is allowed. Throws an Error prefixed with the file's path.
 */
export function parseGadgetLibraryManifest(
  directoryName: string,
  raw: string,
): GadgetLibraryManifest {
  const label = `${directoryName}/library.json`;
  const bad = (message: string): never => { throw new Error(`${label}: ${message}`); };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return bad(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    bad("must be an object");
  }
  const { name, version, notes, ...rest } = parsed as Record<string, unknown>;
  if (Object.keys(rest).length > 0) bad(`unknown keys: ${Object.keys(rest).join(", ")}`);
  if (name !== directoryName) bad(`name must be "${directoryName}", the directory's name`);
  if (!LIBRARY_NAME_PATTERN.test(directoryName)) {
    bad(`a library name is [a-z][a-z0-9-]*, not "${directoryName}"`);
  }
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
    return bad("version must be MAJOR.MINOR.PATCH");
  }
  if (typeof notes !== "string" || notes.trim() === "") {
    return bad("notes must be a non-empty string");
  }
  return { name: directoryName, version, notes };
}

/**
 * Every library in the tree, sorted by name. A directory is a library when it holds a
 * `library.json`; anything else under the package (its configs, `node_modules`) is skipped.
 */
export async function readGadgetLibraryManifests(
  dir: string = GADGET_LIBRARIES_DIR,
): Promise<GadgetLibraryManifest[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const manifests: GadgetLibraryManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    let raw: string;
    try {
      raw = await readFile(join(dir, entry.name, "library.json"), "utf8");
    } catch (err) {
      if (isErrorCode(err, "ENOENT")) continue;
      throw err;
    }
    manifests.push(parseGadgetLibraryManifest(entry.name, raw));
  }
  return manifests.toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function isErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
