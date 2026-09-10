// Gadgets are Git-backed, but blueprint archive version 1 intentionally retains its historical
// gzip-compressed Yjs snapshot wire format. Instantiation decodes that snapshot into a Git commit.
//
// A blueprint's files/ tree may be authored in TypeScript: `client.ts` and `server.ts` are each
// bundled with their `lib/**/*.ts` imports into the `client.js` / `server.js` the archive ships, so
// the running gadget and the agent that later edits it see one JavaScript file per side, as they
// do for a blueprint written in plain JavaScript.

import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import type { Metafile } from "esbuild";
import pkg from "../package.json" with { type: "json" };

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
  return await bundleTypeScriptSources(filesDir, files, label);
}

/**
 * The two gadget entry points, each bundled for the runtime that loads it: the client runs as an
 * ES module inside a sandboxed browser iframe, the server as a Durable Object class in workerd.
 *
 * `external` is what that runtime supplies, and it is little: the iframe supplies nothing, and the
 * Durable Object gets `cloudflare:workers`, the one `cloudflare:` module the gadget's worker loader
 * gives it (`loadGadgetWorker` in the backend's overseer.ts: no outbound network, so
 * `cloudflare:sockets` is moot, and none of the flags behind the others). Everything else a
 * blueprint imports has to be a file it owns or a gadget library (see {@link auditInputs}), so a
 * bare `import "yjs"` fails this build rather than going missing inside the sandbox -- and so does
 * `cloudflare:test`, which a `BUNDLED_BLUEPRINTS_DIR` tree no tsc program checks could otherwise
 * ship to a Durable Object that fails to instantiate.
 */
const ENTRY_POINTS = [
  { name: "client", platform: "browser", external: [] },
  { name: "server", platform: "neutral", external: ["cloudflare:workers"] },
] as const;

type EntryPoint = (typeof ENTRY_POINTS)[number];

/**
 * This package's name, read from its manifest so that it cannot drift from the `exports` there: a
 * blueprint imports a gadget library as `<PACKAGE_NAME>/libraries/<name>/<side>`, the subpath the
 * manifest exports, which is how tsc, vitest and an editor resolve the import with no alias.
 */
const PACKAGE_NAME: string = pkg.name;

/**
 * This package's root, beside the `src/` this module is in. The build aliases {@link PACKAGE_NAME}
 * to it (see {@link bundleTypeScriptSources}), so a blueprint's library import resolves to the
 * libraries this build ships with whether or not a `node_modules` above the blueprint could resolve
 * the package: the tests' temporary fixtures and a `BUNDLED_BLUEPRINTS_DIR` tree elsewhere have
 * none.
 */
const packageRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The shape of a library import as a blueprint may write it: {@link LIBRARY_PREFIX} and then the
 * library's directory name and the side imported, with no extension -- the two subpath patterns
 * the manifest exports.
 */
const LIBRARY_PREFIX = `${PACKAGE_NAME}/libraries/`;
const LIBRARY_SUBPATH = /^([a-z][a-z0-9-]*)\/(client|server)$/u;

/**
 * Whether `path` is `directory` or under it. `relative` answers with a `..` first segment when it
 * is not, or with an absolute path when the two are on different drives, which is outside too.
 */
function contains(directory: string, path: string): boolean {
  const rel = relative(directory, path);
  return !isAbsolute(rel) && rel.split(/[\\/]/u)[0] !== "..";
}

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
 * What may sit between a keyword and its operand in source: whitespace and comments, in any
 * number. `import`, a block comment, then `"./lib/setup.ts"` is a legal import, and the scan below
 * has to see the specifier through the comment, or a module the bundle inlined would be reported
 * as unimported.
 */
const GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*`;

/**
 * Every string literal that could be a module specifier: the operand of `from`, of `import` or
 * `import()`, or of `require()`, with comments allowed wherever whitespace is. A scan, not a parse,
 * so it also matches inside a string or a comment; that direction of error is the harmless one
 * (see {@link importedModules}).
 */
const SPECIFIER_PATTERN = new RegExp(
    String.raw`\b(?:from|import|require)${GAP}\(?${GAP}(?:"([^"\n]*)"|'([^'\n]*)')`, "gu");

/**
 * A dynamic `import()` whose operand is not a string literal. esbuild bundles a literal one like a
 * static import and leaves a computed one in the output as written, where it would resolve inside
 * the sandbox against nothing the bundle checked. Comments cannot trip this: esbuild drops ordinary
 * ones from the output, and a template literal with no substitutions is folded to a string before
 * it is written.
 */
const COMPUTED_DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*(?!["'])/u;

/**
 * A reference to `require` that survived bundling. Both bundles are ES modules and neither gadget
 * runtime supplies `require`, so esbuild rewrites any reference it could not resolve at build time
 * -- a call with a computed path, or a literal one, since the entry's externals are ES module
 * imports; `require.resolve(...)`; `typeof require`; a bare `require` passed along -- to its
 * `__require` shim, which throws "Dynamic require ... is not supported" when called. It reports no
 * warning and, for a computed path, records no import in the metafile, so the output is scanned for
 * the shim instead. The identifier alone is the witness: esbuild emits the shim only when some
 * reference survives, and renames a source identifier of that name away from it. Comments cannot
 * trip this either, for the reason above.
 */
const RESIDUAL_REQUIRE_PATTERN = /\b__require\b/u;

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
 * A gadget library is inlined the same way. The blueprint imports it by this package's name
 * (`<PACKAGE_NAME>/libraries/<name>/<side>`), and esbuild is given that name as an alias for the
 * package root, so the import resolves to the libraries beside this module without a
 * `node_modules` above the blueprint: a `BUNDLED_BLUEPRINTS_DIR` tree elsewhere builds against the
 * libraries this build ships with. The archive stays self-contained -- a gadget created from the
 * blueprint carries its own copy of the library as of its instantiation, and nothing resolves the
 * package name at runtime.
 *
 * Bundles are readable rather than minified, because the agent edits the installed file. The only
 * imports that survive are the ones the entry's runtime supplies (see {@link ENTRY_POINTS}); every
 * other specifier has to resolve to a file the blueprint owns or to a gadget library. esbuild
 * enforces that for bare specifiers, which it resolves or fails on, but not for URLs: `import x
 * from "https://..."` is left in the output as an external without a word, so the bundle's
 * surviving imports are checked against the entry's allowlist here.
 *
 * Rejected, rather than silently mis-shipped: an entry or a `lib/` module present as both `x.ts`
 * and `x.js`, where TypeScript would type the one and the bundle ship the other; a `.ts` file that
 * is neither an entry nor under `lib/`; a TypeScript dialect the archive has no place for (see
 * {@link UNSUPPORTED_TYPESCRIPT_PATTERN}); a `lib/` module no entry imports, which would be dropped
 * from the archive; an input the bundle inlined that is neither one of the blueprint's own files
 * nor a library reached by its package subpath, from the right side, which would inline code the
 * blueprint does not own (see {@link auditInputs}); a dynamic `import()` of a computed path, which
 * the bundler cannot check (see {@link COMPUTED_DYNAMIC_IMPORT_PATTERN}); and a reference to
 * `require` the bundler could not resolve away, which would throw when reached (see
 * {@link RESIDUAL_REQUIRE_PATTERN}).
 */
async function bundleTypeScriptSources(
  filesDir: string,
  files: Map<string, string>,
  label: string,
): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  const libSources = new Set<string>();
  const entries: EntryPoint[] = [];
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
      const twin = path.replace(/\.ts$/u, ".js");
      if (files.has(twin)) {
        invalid(label, `${path} and ${twin} both define the same module; TypeScript would type ` +
            `the .ts while the bundle ships the .js`);
      }
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
  // (the importer's, for one) never needs it.
  const { build } = await import("esbuild");
  // esbuild reports every path it touches with symlinks resolved (a temporary directory on macOS
  // sits under one), so the roots it is compared against, and the root it is given to resolve the
  // package name to, are resolved the same way.
  const [rootDir, packageDir] = await Promise.all([realpath(filesDir), realpath(packageRoot())]);
  const librariesDir = join(packageDir, "libraries");
  // Every input esbuild inlined into some bundle, as an archive path: what the bundles can witness
  // of a `lib/` module being wanted.
  const bundled = new Set<string>();
  await Promise.all(entries.map(async entry => {
    let metafile: Metafile;
    let text: string;
    try {
      const result = await build({
        absWorkingDir: rootDir,
        entryPoints: [`${entry.name}.ts`],
        bundle: true,
        external: [...entry.external],
        alias: { [PACKAGE_NAME]: packageDir },
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
        // BUNDLED_BLUEPRINTS_DIR can name a tree anywhere.
        tsconfigRaw: {},
      });
      metafile = result.metafile;
      text = result.outputFiles[0]!.text;
    } catch (err) {
      invalid(label, `${entry.name}.ts failed to bundle: ${errorMessage(err)}`);
    }
    for (const input of auditInputs(metafile, entry, files, rootDir, librariesDir, label)) {
      bundled.add(input);
    }
    for (const bundle of Object.values(metafile.outputs)) {
      for (const imported of bundle.imports) {
        if (imported.external && !matchesExternal(imported.path, entry.external)) {
          invalid(label, `${entry.name}.ts imports ${imported.path}, which the ${entry.name} ` +
              `runtime does not supply`);
        }
      }
    }
    if (COMPUTED_DYNAMIC_IMPORT_PATTERN.test(text)) {
      invalid(label, `${entry.name}.ts contains a dynamic import whose path is not a string ` +
          `literal; the bundler cannot check it`);
    }
    if (RESIDUAL_REQUIRE_PATTERN.test(text)) {
      invalid(label, `${entry.name}.ts references require; the bundle is an ES module and the ` +
          `gadget runtime has no require`);
    }
    output.set(`${entry.name}.js`, text);
  }));
  // A `lib/` module is wanted if some bundle inlined it, or if the source names it: the two are
  // read together because neither alone sees everything. Types are erased before the bundle is
  // written, so a module holding only the shared contract is inlined nowhere and only the source
  // scan can witness it; the scan in turn is a scan (see importedModules), so the metafile is what
  // vouches for a spelling it does not recognize.
  const imported = importedModules(files, entries.map(entry => `${entry.name}.ts`));
  for (const lib of libSources) {
    if (!imported.has(lib) && !bundled.has(lib)) {
      invalid(label, `${lib} is not imported by any entry point`);
    }
  }
  return new Map([...output].toSorted(([a], [b]) => compareNames(a, b)));
}

/**
 * Walks what esbuild inlined into an entry's bundle, import by import, and rejects anything that is
 * not the blueprint's own or a gadget library reached the one way a blueprint may reach one.
 * Returns the blueprint's own files the bundle inlined, as archive paths.
 *
 * The walk starts at the entry and follows `metafile.inputs[*].imports`, so every input is met as
 * the edge that brought it in and an error names the importer and the specifier as written. An
 * import written in a blueprint file that lands outside the blueprint's files has to be a library
 * import: spelled `<PACKAGE_NAME>/libraries/<name>/<side>` (see {@link LIBRARY_SUBPATH}), of the
 * entry's own side -- a client that imported a library's server side would drag a Durable Object
 * into the iframe -- and resolved to exactly that library's `<side>.ts`, since esbuild's extension
 * probing would otherwise also accept a `client/index.ts` or a `client.tsx` beside it. Any other
 * spelling -- a relative path that climbs out of files/, an absolute path, a bare specifier some
 * `node_modules` above the blueprint happens to satisfy, the package root or one of its `src/`
 * modules -- is refused, so the package subpath is the libraries' only door and a library's `src/`
 * is not reachable from a blueprint by any path. An import written inside a library may reach any
 * module under `libraries/`, but never `node_modules`: a library's npm dependency would be inlined
 * into an archive nothing audits. An external import is not an input and is not walked; the
 * bundle's surviving imports are checked against the entry's runtime in
 * {@link bundleTypeScriptSources}.
 *
 * Types are erased before esbuild builds this graph, so an `import type` of the wrong side is not
 * seen here and not an error: nothing of it reaches the bundle.
 */
function auditInputs(
  metafile: Metafile,
  entry: EntryPoint,
  files: ReadonlyMap<string, string>,
  rootDir: string,
  librariesDir: string,
  label: string,
): Set<string> {
  const own = new Set<string>();
  const entryPath = `${entry.name}.ts`;
  const seen = new Set([entryPath]);
  const queue = [entryPath];
  for (let importer = queue.pop(); importer !== undefined; importer = queue.pop()) {
    if (files.has(importer)) own.add(importer);
    for (const imported of metafile.inputs[importer]?.imports ?? []) {
      if (imported.external) continue;
      const input = imported.path;
      const specifier = imported.original ?? input;
      if (!files.has(input)) {
        // Inputs are relative to files/.
        const absolute = resolve(rootDir, input);
        if (files.has(importer)) {
          if (specifier !== PACKAGE_NAME && !specifier.startsWith(`${PACKAGE_NAME}/`)) {
            invalid(label, `${importer} imports ${specifier}, which is outside the blueprint's ` +
                `files`);
          }
          const library = specifier.startsWith(LIBRARY_PREFIX)
              ? LIBRARY_SUBPATH.exec(specifier.slice(LIBRARY_PREFIX.length))
              : null;
          if (!library) {
            invalid(label, `${importer} imports ${specifier}, which is not a library import ` +
                `(${LIBRARY_PREFIX}<name>/client or ${LIBRARY_PREFIX}<name>/server)`);
          }
          const [, name, side] = library;
          if (side !== entry.name) {
            invalid(label, `${importer} imports ${specifier} from the ${entry.name} side`);
          }
          if (absolute !== join(librariesDir, name, `${side}.ts`)) {
            invalid(label, `${importer} imports ${specifier}, which does not resolve to the ` +
                `library's ${side}.ts`);
          }
        } else if (!contains(librariesDir, absolute) ||
            absolute.split(/[\\/]/u).includes("node_modules")) {
          invalid(label, `${importer} imports ${specifier}, which is outside the gadget libraries`);
        }
      }
      if (!seen.has(input)) {
        seen.add(input);
        queue.push(input);
      }
    }
  }
  return own;
}

/** Whether `specifier` is one of the `external` modules of an entry point. */
function matchesExternal(specifier: string, externals: readonly string[]): boolean {
  return externals.includes(specifier);
}

/**
 * The blueprint's own files reachable from `entryPaths` by following import specifiers.
 *
 * A scan of the source rather than a parse of it, and deliberately so: it exists to prove that a
 * `lib/` module is wanted, and a scan can only over-estimate that (a specifier-shaped string in a
 * comment counts as an import), so the "no entry imports this" build error stays impossible to
 * trigger for a module something really does import -- including one imported only for its types,
 * which no compiled output can witness. Comments between a keyword and its specifier are allowed
 * for (see {@link GAP}); a module the scan still misses is vouched for by the bundle that inlined
 * it, in {@link bundleTypeScriptSources}.
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
 * files/ resolves to nothing here -- the bundle rejects that as an import outside the blueprint
 * (see {@link auditInputs}).
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
