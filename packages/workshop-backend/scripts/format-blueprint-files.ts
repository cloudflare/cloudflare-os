// Gadgets are Git-backed, but blueprint archive version 1 intentionally retains its historical
// gzip-compressed Yjs snapshot wire format. Instantiation decodes that snapshot into a Git commit.
//
// A blueprint's files/ tree may be authored in TypeScript: `client.ts` and `server.ts` are each
// bundled with their `lib/**/*.ts` imports into the `client.js` / `server.js` the archive ships, so
// the running gadget and the agent that later edits it see one JavaScript file per side, as they
// do for a blueprint written in plain JavaScript.

import { lstat, readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { join } from "node:path";
import * as Y from "yjs";
import type { Metafile } from "esbuild";
import {
  type GadgetPins,
  LIBRARY_SIDES,
  parseLibrarySpecifier,
  readPins,
} from "../src/gadget-libraries.ts";

const MAGIC = 0xec2e2d3a2300e317n;
const VERSION = 1;
const PREFIX_BYTES = 24;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const textEncoder = new TextEncoder();

export function findInterruptedImportBackups(
  entries: Dirent[],
  label: string,
): Map<string, string> {
  const visibleDirectories = new Set(entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
      .map(entry => entry.name));
  const backups = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^\.(.+)\.backup-\d+$/su.exec(entry.name);
    const name = match?.[1];
    if (!name || name.startsWith(".") || visibleDirectories.has(name)) continue;
    const existing = backups.get(name);
    if (existing) {
      invalid(label, `multiple interrupted import backups for ${name}: ${existing}, ${entry.name}`);
    }
    backups.set(name, entry.name);
  }
  return backups;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function invalid(label: string, message: string): never {
  throw new Error(`${label}: ${message}`);
}

export function parseArchive(bytes: Uint8Array, label: string): {
  metadata: Record<string, unknown>;
  content: Uint8Array;
} {
  if (bytes.byteLength < PREFIX_BYTES) invalid(label, "too short to be a .gadget archive");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getBigUint64(0) !== MAGIC) invalid(label, "not a .gadget archive (bad magic)");
  const version = view.getUint32(8);
  if (version !== VERSION) invalid(label, `unsupported archive version ${version}`);

  const metadataLength = view.getUint32(12);
  const contentLength = Number(view.getBigUint64(16));
  if (metadataLength === 0 || metadataLength > MAX_METADATA_BYTES) {
    invalid(label, "metadata size is out of range");
  }
  if (!Number.isSafeInteger(contentLength) || contentLength > MAX_CONTENT_BYTES) {
    invalid(label, "content size is out of range");
  }
  if (PREFIX_BYTES + metadataLength + contentLength !== bytes.byteLength) {
    invalid(label, "lengths in prefix do not match archive size");
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(textDecoder.decode(
        bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + metadataLength)));
  } catch (err) {
    invalid(label, `metadata is not valid UTF-8 JSON (${errorMessage(err)})`);
  }
  return { metadata, content: bytes.subarray(PREFIX_BYTES + metadataLength) };
}

export function serializeArchive(
  metadata: Record<string, unknown>,
  content: Uint8Array,
  label: string,
): Uint8Array {
  const metadataBytes = textEncoder.encode(JSON.stringify(metadata));
  if (metadataBytes.byteLength > MAX_METADATA_BYTES) invalid(label, "metadata is too large");
  if (content.byteLength > MAX_CONTENT_BYTES) invalid(label, "compressed content is too large");

  const out = new Uint8Array(PREFIX_BYTES + metadataBytes.byteLength + content.byteLength);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, MAGIC);
  view.setUint32(8, VERSION);
  view.setUint32(12, metadataBytes.byteLength);
  view.setBigUint64(16, BigInt(content.byteLength));
  out.set(metadataBytes, PREFIX_BYTES);
  out.set(content, PREFIX_BYTES + metadataBytes.byteLength);
  return out;
}

export function extractFiles(content: Uint8Array, label: string): Map<string, string> {
  let update: Uint8Array;
  try {
    update = gunzipSync(content, { maxOutputLength: MAX_SOURCE_BYTES });
  } catch (err) {
    invalid(label, `content is not a valid gzip-compressed blueprint (${errorMessage(err)})`);
  }

  const doc = new Y.Doc();
  try {
    Y.applyUpdateV2(doc, update);
  } catch (err) {
    invalid(label, `content is not a valid Yjs V2 update (${errorMessage(err)})`);
  }

  if ([...doc.share.keys()].some(name => name !== "")) {
    invalid(label, "content contains a non-canonical named Yjs root");
  }
  const root = doc.getMap();
  const entries = [...root];
  validateFilePaths(entries.map(([filename]) => filename), label);
  const files = new Map<string, string>();
  for (const [filename, value] of entries) {
    if (!(value instanceof Y.Text)) invalid(label, `${filename} is not text`);
    files.set(filename, value.toString());
  }
  return files;
}

export function buildContent(files: Map<string, string>, label: string): Uint8Array {
  validateFilePaths(files.keys(), label);
  const doc = new Y.Doc();
  // The generated update is embedded as build output, not committed source. A fixed client ID makes
  // repeated builds byte-identical while preserving the same minimal one-insert-per-file snapshot.
  doc.clientID = 1;
  const root = doc.getMap();
  for (const [filename, source] of [...files].toSorted(([a], [b]) => compareNames(a, b))) {
    const text = new Y.Text();
    root.set(filename, text);
    text.insert(0, source);
  }
  const update = Y.encodeStateAsUpdateV2(doc);
  if (update.byteLength > MAX_SOURCE_BYTES) invalid(label, "source snapshot is too large");
  return gzipSync(update, {level: 9});
}

/**
 * Reads a blueprint's files/ tree into the file map its archive will hold.
 *
 * Every regular file under `filesDir` is read as UTF-8 and validated as a portable archive path; a
 * tree holding TypeScript is then compiled by {@link bundleTypeScriptSources}, so the returned map
 * is what the installed gadget sees, not what is on disk.
 */
export async function readSourceFiles(
  filesDir: string,
  label: string,
  options: ReadSourceOptions = {},
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let totalBytes = 0;
  const root = await lstat(filesDir);
  if (root.isSymbolicLink()) invalid(label, "must not be a symlink");
  if (!root.isDirectory()) invalid(label, "must be a directory");

  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
        .toSorted((a, b) => compareNames(a.name, b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      validateFilePath(path, label);
      if (entry.isSymbolicLink()) invalid(label, `${path} must not be a symlink`);
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), path);
        continue;
      }
      if (!entry.isFile()) invalid(label, `${path} must be a regular file or directory`);
      const bytes = await readFile(join(directory, entry.name));
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_SOURCE_BYTES) invalid(label, "source files are too large");
      try {
        files.set(path, textDecoder.decode(bytes));
      } catch (err) {
        invalid(label, `${path} is not valid UTF-8 (${errorMessage(err)})`);
      }
    }
  };

  await visit(filesDir, "");
  validateFilePaths(files.keys(), label);
  const output = await bundleTypeScriptSources(filesDir, files, label);
  checkLibraryPins(output, label, options.libraries);
  return output;
}

export type ReadSourceOptions = {
  /**
   * The libraries the deployment bundles, each with the names of the libraries it imports (see
   * scripts/gadget-libraries-source.ts). When given, a pin naming any other library fails the
   * build, and a library's own dependencies must be pinned too; when omitted -- the archive tests,
   * and an importer that only needs the files -- only the blueprint's direct imports are checked.
   */
  libraries?: ReadonlyMap<string, readonly string[]>;
};

/**
 * The two gadget entry points, each bundled for the runtime that loads it: the client runs as an
 * ES module inside a sandboxed browser iframe, the server as a Durable Object class in workerd.
 *
 * `external` is what that runtime supplies, and it is little: both sides get the gadget libraries
 * the deployment ships (`gadgets:<name>/<side>`, resolved through the pins in the blueprint's
 * `gadget.json` -- see {@link checkLibraryPins}), and the Durable Object gets workerd's own
 * `cloudflare:*`. Everything else a blueprint imports has to be a file it owns, so a bare
 * `import "yjs"` fails this build rather than going missing inside the sandbox; a library may
 * bundle npm packages, a gadget may not.
 */
const ENTRY_POINTS = [
  { name: "client", platform: "browser", external: ["gadgets:*"] },
  { name: "server", platform: "neutral", external: ["cloudflare:*", "gadgets:*"] },
] as const;

/** Where a blueprint's TypeScript modules live; everything under it is an input to the entries. */
const LIB_PREFIX = "lib/";

/** The ECMAScript level both gadget runtimes accept, and what the blueprint tsconfigs target. */
const GADGET_TARGET = "es2022";

/** Declaration files carry no code: dropped rather than compiled. */
const DECLARATION_PATTERN = /\.d\.[cm]?ts$/u;

/**
 * TypeScript spellings a gadget module may not use. Each would type-check but reach the archive
 * as raw TypeScript or not at all, so they are rejected rather than half-supported: JSX has no
 * runtime here (the client is hand-written DOM code), and the ESM/CJS variants say nothing a
 * blueprint needs -- both bundles are ES modules.
 */
const UNSUPPORTED_TYPESCRIPT_PATTERN = /\.(?:tsx|mts|cts)$/u;

/** The files the reachability scan reads: those that can name another module. */
const MODULE_PATTERN = /\.[cm]?[jt]s$/u;

/**
 * Every string literal that could be a module specifier: the operand of `from`, of `import` or
 * `import()`, or of `require()`.
 */
const SPECIFIER_PATTERN = /\b(?:from|import|require)\s*\(?\s*(?:"([^"\n]*)"|'([^'\n]*)')/gu;

/**
 * The JavaScript extension TypeScript rewrites to a source one, i.e. `./lib/blocks.js` naming
 * `lib/blocks.ts`. It is the only such rewrite a gadget module can need: the other dialects
 * TypeScript spells this way are rejected before any specifier is resolved (see
 * {@link UNSUPPORTED_TYPESCRIPT_PATTERN}).
 */
const JAVASCRIPT_EXTENSION = /\.js$/u;

/**
 * Replaces the TypeScript in a files/ tree with the JavaScript the archive ships.
 *
 * `client.ts` and `server.ts` each become `client.js` / `server.js`, bundling whatever they import
 * from `lib/`; those `lib/` modules are inputs to the bundles and are not stored themselves.
 * `.d.ts` files carry no code and are dropped. Every other file passes through unchanged -- a
 * bundle inlining one (a JSON data file, say) does not remove it, because a module the archive
 * still ships may import it too -- so a blueprint written in JavaScript builds exactly as it did
 * before TypeScript was allowed here.
 *
 * Bundles are readable rather than minified, because the agent edits the installed file. The only
 * imports that survive are the ones the entry's runtime supplies (see {@link ENTRY_POINTS}); every
 * other specifier has to resolve to a file the blueprint owns. esbuild enforces that for bare
 * specifiers, which it resolves or fails on, but not for URLs: `import x from "https://..."` is
 * left in the output as an external without a word, so the bundle's surviving imports are checked
 * against the entry's allowlist here.
 *
 * Rejected, rather than silently mis-shipped: an entry present as both `x.ts` and `x.js`; a `.ts`
 * file that is neither an entry nor under `lib/`; a TypeScript dialect the archive has no place for
 * (see {@link UNSUPPORTED_TYPESCRIPT_PATTERN}); a `lib/` module no entry imports, which would be
 * dropped from the archive; and an import that escapes files/, which would inline code the
 * blueprint does not own.
 */
async function bundleTypeScriptSources(
  filesDir: string,
  files: Map<string, string>,
  label: string,
): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  const libSources = new Set<string>();
  const entries: Array<(typeof ENTRY_POINTS)[number]> = [];
  for (const [path, source] of files) {
    if (DECLARATION_PATTERN.test(path)) continue;
    if (UNSUPPORTED_TYPESCRIPT_PATTERN.test(path)) {
      invalid(label, `${path} is not a gadget module: gadget TypeScript is plain .ts, not .tsx, ` +
          `.mts or .cts`);
    }
    if (!path.endsWith(".ts")) {
      output.set(path, source);
      continue;
    }
    if (path.startsWith(LIB_PREFIX)) {
      libSources.add(path);
      continue;
    }
    const entry = ENTRY_POINTS.find(candidate => `${candidate.name}.ts` === path);
    if (!entry) {
      invalid(label, `${path} is not a gadget module: only client.ts, server.ts and ` +
          `${LIB_PREFIX}**/*.ts are compiled`);
    }
    if (files.has(`${entry.name}.js`)) {
      invalid(label, `${path} and ${entry.name}.js both define the ${entry.name} entry`);
    }
    entries.push(entry);
  }
  if (entries.length === 0) {
    const [orphan] = libSources;
    if (orphan) invalid(label, `${orphan} has no client.ts or server.ts to bundle it`);
    return output;
  }

  // Loaded on demand: esbuild drives a native binary, and the JavaScript-only path through here
  // (including the importer and the archive tests that run inside workerd) never needs it.
  const { build } = await import("esbuild");
  await Promise.all(entries.map(async entry => {
    let metafile: Metafile;
    let text: string;
    try {
      const result = await build({
        absWorkingDir: filesDir,
        entryPoints: [`${entry.name}.ts`],
        bundle: true,
        external: [...entry.external],
        format: "esm",
        platform: entry.platform,
        target: GADGET_TARGET,
        charset: "utf8",
        minify: false,
        sourcemap: false,
        write: false,
        metafile: true,
        logLevel: "silent",
        // A blueprint's compile must not pick up whichever tsconfig sits above its directory --
        // FORMAT_BLUEPRINTS_DIR can name a tree anywhere.
        tsconfigRaw: {},
      });
      metafile = result.metafile;
      text = result.outputFiles[0]!.text;
    } catch (err) {
      invalid(label, `${entry.name}.ts failed to bundle: ${errorMessage(err)}`);
    }
    for (const input of Object.keys(metafile.inputs)) {
      if (!files.has(input)) {
        invalid(label, `${entry.name}.ts imports ${input}, which is outside the blueprint's files`);
      }
    }
    for (const bundle of Object.values(metafile.outputs)) {
      for (const imported of bundle.imports) {
        if (imported.external && !matchesExternal(imported.path, entry.external)) {
          invalid(label, `${entry.name}.ts imports ${imported.path}, which the ${entry.name} ` +
              `runtime does not supply`);
        }
      }
    }
    output.set(`${entry.name}.js`, text);
  }));
  // What esbuild inlined cannot say whether every `lib/` module is wanted: types are erased
  // before the bundle is written, so a module holding only the shared contract is inlined nowhere.
  // Reachability is read from the source instead.
  const imported = importedModules(files, entries.map(entry => `${entry.name}.ts`));
  for (const lib of libSources) {
    if (!imported.has(lib)) invalid(label, `${lib} is not imported by any entry point`);
  }
  return new Map([...output].toSorted(([a], [b]) => compareNames(a, b)));
}

/**
 * Whether `specifier` is one of the `external` patterns of an entry point: the pattern itself, or
 * anything under a pattern ending in `*` -- the only wildcard {@link ENTRY_POINTS} uses, and the
 * shape esbuild's own `external` matching gives it.
 */
function matchesExternal(specifier: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => pattern.endsWith("*")
      ? specifier.startsWith(pattern.slice(0, -1))
      : specifier === pattern);
}

/**
 * Checks that a blueprint's library imports and its `gadget.json` pins agree, on the files the
 * archive ships (so a blueprint written in JavaScript is checked exactly like a bundled one).
 *
 * Every `gadgets:<name>/<side>` a side's entry reaches must be pinned, must name that side (a
 * client that imports `gadgets:x/server` would drag a Durable Object into the iframe), and when
 * `libraries` is given must name a library the deployment ships -- and so must every library those
 * import, transitively, since a library's own `gadgets:` imports resolve through the pins of the
 * gadget loading it; every pin must be imported by something, directly or through a library, since
 * an unused pin would still be resolved on every load. The import scan is the same over-estimate
 * {@link importedModules} makes, so an unpinned specifier in a comment fails the build too; the fix
 * is the pin or the comment.
 */
export function checkLibraryPins(
  files: ReadonlyMap<string, string>,
  label: string,
  libraries: ReadonlyMap<string, readonly string[]> | undefined,
): void {
  let pins: GadgetPins;
  try {
    pins = readPins(files);
  } catch (err) {
    invalid(label, errorMessage(err));
  }
  const imported = new Set<string>();
  for (const side of LIBRARY_SIDES) {
    for (const [importer, specifier] of libraryImports(files, `${side}.js`)) {
      const parsed = parseLibrarySpecifier(specifier);
      if (!parsed) {
        invalid(label, `${importer} imports ${specifier}, which is not a library ` +
            `(gadgets:<name>/client or gadgets:<name>/server)`);
      }
      if (parsed.side !== side) {
        invalid(label, `${importer} imports ${specifier} from the ${side} side`);
      }
      if (!pins.has(parsed.name)) {
        invalid(label, `${importer} imports ${specifier}, which gadget.json does not pin`);
      }
      if (libraries && !libraries.has(parsed.name)) {
        invalid(label, `${importer} imports ${specifier}, but the deployment bundles no library ` +
            `named ${parsed.name}`);
      }
      imported.add(parsed.name);
    }
  }
  if (libraries) {
    // What the imported libraries import in turn: the gadget pins those too.
    for (const name of imported) {
      for (const dependency of libraries.get(name) ?? []) {
        if (imported.has(dependency)) continue;
        if (!pins.has(dependency)) {
          invalid(label, `gadget.json must also pin ${dependency}, which the ${name} library imports`);
        }
        imported.add(dependency);
      }
    }
  }
  for (const name of pins.keys()) {
    if (!imported.has(name)) invalid(label, `gadget.json pins ${name}, which nothing imports`);
  }
}

/**
 * The `gadgets:` specifiers written in the files reachable from `entryPath`, each with the file
 * that wrote it. The walk is {@link importedModules}'s, over the same specifier scan.
 */
function libraryImports(
  files: ReadonlyMap<string, string>,
  entryPath: string,
): Array<[importer: string, specifier: string]> {
  const found: Array<[string, string]> = [];
  for (const path of importedModules(files, [entryPath])) {
    const source = MODULE_PATTERN.test(path) ? files.get(path) : undefined;
    if (source === undefined) continue;
    for (const [, doubleQuoted, singleQuoted] of source.matchAll(SPECIFIER_PATTERN)) {
      const specifier = doubleQuoted ?? singleQuoted!;
      if (specifier.startsWith("gadgets:")) found.push([path, specifier]);
    }
  }
  return found;
}

/**
 * The blueprint's own files reachable from `entryPaths` by following import specifiers.
 *
 * A scan of the source rather than a parse of it, and deliberately so: it exists to prove that a
 * `lib/` module is wanted, and a scan can only over-estimate that (a specifier-shaped string in a
 * comment counts as an import), so the "no entry imports this" build error stays impossible to
 * trigger for a module something really does import -- including one imported only for its types,
 * which no compiled output can witness.
 */
function importedModules(
  files: ReadonlyMap<string, string>,
  entryPaths: string[],
): Set<string> {
  const reached = new Set(entryPaths);
  const queue = [...entryPaths];
  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    const source = MODULE_PATTERN.test(path) ? files.get(path) : undefined;
    if (source === undefined) continue;
    for (const [, doubleQuoted, singleQuoted] of source.matchAll(SPECIFIER_PATTERN)) {
      const specifier = doubleQuoted ?? singleQuoted!;
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      for (const candidate of resolveWithinFiles(path, specifier)) {
        if (!files.has(candidate) || reached.has(candidate)) continue;
        reached.add(candidate);
        queue.push(candidate);
      }
    }
  }
  return reached;
}

/**
 * The archive paths a relative `specifier` written in `importer` could name.
 *
 * Every spelling a bundler would try that could name a module of the blueprint's own, since which
 * one resolves is the bundler's business: the path as written, an omitted extension, a directory's
 * index module, and the TypeScript source behind a JavaScript extension. A specifier reaching above
 * files/ resolves to nothing here -- esbuild reports that as an import outside the blueprint.
 */
function resolveWithinFiles(importer: string, specifier: string): string[] {
  const segments = importer.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      segments.push(segment);
      continue;
    }
    if (segments.length === 0) return [];
    segments.pop();
  }
  const path = segments.join("/");
  if (path === "") return [];
  const candidates = [path, `${path}.ts`, `${path}.js`, `${path}/index.ts`, `${path}/index.js`];
  if (JAVASCRIPT_EXTENSION.test(path)) {
    candidates.push(path.replace(JAVASCRIPT_EXTENSION, ".ts"));
  }
  return candidates;
}

function validateFilePaths(paths: Iterable<string>, label: string): void {
  const allPaths = [...paths];
  if (allPaths.length === 0) invalid(label, "blueprint must contain at least one source file");
  validatePortablePaths(allPaths, label);
}

export function validatePortablePaths(paths: Iterable<string>, label: string): void {
  const portablePaths = new Map<string, string>();
  const portableDirectories = new Map<string, string>();
  for (const path of paths) {
    validateFilePath(path, label);
    const portable = portablePath(path);
    const existing = portablePaths.get(portable);
    if (existing) {
      invalid(label, `${path} aliases ${existing} on case-insensitive filesystems`);
    }
    const conflictingDirectory = portableDirectories.get(portable);
    if (conflictingDirectory) {
      invalid(label, `${path} conflicts with directory ${conflictingDirectory} on ` +
          `case-insensitive filesystems`);
    }
    portablePaths.set(portable, path);

    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const directory = segments.slice(0, i).join("/");
      const portableDirectory = portablePath(directory);
      const existingDirectory = portableDirectories.get(portableDirectory);
      if (existingDirectory && existingDirectory !== directory) {
        invalid(label, `${directory} aliases directory ${existingDirectory} on ` +
            `case-insensitive filesystems`);
      }
      const existingFile = portablePaths.get(portableDirectory);
      if (existingFile) {
        invalid(label, `${path} conflicts with file ${existingFile} on ` +
            `case-insensitive filesystems`);
      }
      portableDirectories.set(portableDirectory, directory);
    }
  }

  for (const [portable, path] of portablePaths) {
    let slash = portable.indexOf("/");
    while (slash !== -1) {
      const parent = portablePaths.get(portable.slice(0, slash));
      if (parent) {
        invalid(label, `${path} conflicts with file ${parent}`);
      }
      slash = portable.indexOf("/", slash + 1);
    }
  }
}

function validateFilePath(path: string, label: string): void {
  if (typeof path !== "string" || path.includes("\\") || path.includes("\0") ||
      path.split("/").some(segment => segment === "" || segment === "." || segment === "..")) {
    invalid(label, `unsafe blueprint file path ${JSON.stringify(path)}`);
  }
  for (const segment of path.split("/")) {
    if ([...segment].some(char => char.codePointAt(0)! <= 0x1f) || /[<>:"|?*]/u.test(segment) ||
        /[. ]$/u.test(segment) ||
        /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu
            .test(segment) ||
        /^\.git(?:ignore)?$/iu.test(segment)) {
      invalid(label, `non-portable blueprint file path ${JSON.stringify(path)}`);
    }
  }
}

function portablePath(path: string): string {
  return path.normalize("NFC").toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
