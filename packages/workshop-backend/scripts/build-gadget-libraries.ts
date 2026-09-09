// Bundles every gadget library in `packages/gadget-libraries` into a generated TypeScript module,
// so the Worker ships each library's client and server bundles and hands them to gadgets that
// import `gadgets:<name>/client` and `gadgets:<name>/server`.
//
// The deployment ships exactly what this build produced, and nothing else: no library version is
// ever stored in R2 or KV. A gadget pinned to `latest` runs these bundles (see
// src/gadget-libraries.ts). Rolling a bad library back is therefore a redeploy.
//
// A library, unlike a gadget, may depend on npm packages: they are bundled in here. What it may
// not do is reach into any other package of this workspace -- the metafile check below rejects
// an input outside the libraries tree that is not under `node_modules`.
//
// The `code` a `latest` pin runs is minified for size (whitespace and syntax, not identifiers, so
// a stack trace from inside a gadget still names the library's functions), and its source map is
// written beside the generated module for anyone reading such a trace; nothing serves it. The
// bundle carries no doc comment -- esbuild keeps only legal comments, whatever the minify
// settings -- so the comments travel in the library's declarations, emitted by
// `build-gadget-library-types.ts` and shipped alongside for the agent's `describeGadgetLibrary`.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BuildOptions, type Plugin, build } from "esbuild";
import {
  LIBRARY_SIDES, type LibrarySide, librarySpecifier, parseLibrarySpecifier,
} from "../src/gadget-libraries.ts";
import {
  GADGET_LIBRARIES_DIR, type GadgetLibraryManifest, librarySideTypesDir,
  readGadgetLibraryManifests,
} from "./gadget-libraries-source.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const generatedDir = resolve(pkgRoot, "src", "generated");
const outFile = join(generatedDir, "gadget-libraries.ts");
const mapsDir = join(generatedDir, "gadget-libraries");

/**
 * The ECMAScript level both gadget runtimes accept; the same as the blueprint build's
 * `GADGET_TARGET`. The gadget loader's `compatibilityDate` stays "2026-02-01": a library that needs
 * a newer runtime feature has to bump that date in overseer.ts, not this target.
 */
const LIBRARY_TARGET = "es2022";

/** What each side's runtime supplies, so the bundle leaves it as an import. */
const EXTERNALS: Record<LibrarySide, string[]> = {
  // Nothing but other libraries: the iframe has no import map beyond `gadgets:*`.
  client: ["gadgets:*"],
  server: ["cloudflare:*"],
};

/**
 * How a server bundle spells its import of another library. workerd's loader resolves a specifier
 * against the importing module's own name as if it were a path: from a module registered as
 * \`gadgets:editor/server\`, a bare \`gadgets:sync/server\` would be looked up as
 * \`gadgets:editor/gadgets:sync/server\`. The bundle therefore climbs out of its "directory" first,
 * and \`../gadgets:sync/server\` lands on the module the loader registered under the plain specifier
 * (see src/gadget-library-resolution.ts). A gadget's own \`server.js\` has no directory, so its bare
 * import needs no such prefix; for the gadget's files under \`lib/\` and the like, the loader adds
 * shims (\`lib/gadgets:sync/server\` re-exporting the root module the same way, one \`../\` deeper)
 * rather than asking the gadget to spell the prefix. The client bundle is untouched: the iframe resolves the
 * bare specifier through its import map.
 */
const SERVER_LIBRARY_IMPORTS: Plugin = {
  name: "server-library-imports",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^gadgets:/ }, args => ({ path: `../${args.path}`, external: true }));
  },
};

type BundledModule = { code: string; hash: string; dependencies: string[] };

/** One emitted `.d.ts`, as the generated module records it (see `LibraryDeclaration` there). */
type Declaration = { path: string; side: LibrarySide | "both"; text: string };

const manifests = await readGadgetLibraryManifests();
if (manifests.length === 0) {
  console.warn(`No libraries in ${GADGET_LIBRARIES_DIR}; gadgets will be able to import none.`);
}
const names = new Set(manifests.map(manifest => manifest.name));

const entries = await Promise.all(manifests.map(async manifest => {
  const client = await bundle(manifest, "client");
  const server = await bundle(manifest, "server");
  return {
    ...manifest,
    dependencies: [...new Set([...client.dependencies, ...server.dependencies])].toSorted(),
    client: { code: client.code, hash: client.hash },
    server: { code: server.code, hash: server.hash },
    declarations: await readDeclarations(manifest.name),
  };
}));
checkDependencyGraph(entries);

/**
 * A library's imports of other libraries stay external in its bundle and resolve through the pins
 * of the gadget that loads it, so they are recorded for the blueprint build to demand those pins.
 * Each must name a library in the tree, on the same side (a client bundle importing
 * \`gadgets:x/server\` would pull a Durable Object into the iframe), and not the library itself.
 */
function dependenciesOf(
  manifest: GadgetLibraryManifest,
  side: LibrarySide,
  imports: Array<{ path: string; external?: boolean }>,
): string[] {
  const specifier = librarySpecifier(manifest.name, side);
  const found = new Set<string>();
  for (const imported of imports) {
    // The server side's imports carry the `../` prefix SERVER_LIBRARY_IMPORTS gave them.
    const path = imported.path.replace(/^\.\.\//u, "");
    if (!imported.external || !path.startsWith("gadgets:")) continue;
    const parsed = parseLibrarySpecifier(path);
    if (!parsed) throw new Error(`${specifier} imports ${imported.path}, which is not a library`);
    if (parsed.side !== side) {
      throw new Error(`${specifier} imports ${imported.path} from the ${side} side`);
    }
    if (parsed.name === manifest.name) throw new Error(`${specifier} imports itself`);
    if (!names.has(parsed.name)) {
      throw new Error(`${specifier} imports ${imported.path}, but no library is named ${parsed.name}`);
    }
    found.add(parsed.name);
  }
  return [...found].toSorted();
}

/** Rejects a cycle, which no pin order could load. */
function checkDependencyGraph(libraries: Array<{ name: string; dependencies: string[] }>): void {
  const byName = new Map(libraries.map(library => [library.name, library.dependencies]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (name: string, trail: string[]): void => {
    if (done.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`libraries import each other in a cycle: ${[...trail, name].join(" -> ")}`);
    }
    visiting.add(name);
    for (const dependency of byName.get(name) ?? []) visit(dependency, [...trail, name]);
    visiting.delete(name);
    done.add(name);
  };
  for (const library of libraries) visit(library.name, []);
}

async function bundle(manifest: GadgetLibraryManifest, side: LibrarySide): Promise<BundledModule> {
  const libraryDir = join(GADGET_LIBRARIES_DIR, manifest.name);
  const specifier = librarySpecifier(manifest.name, side);
  const options: BuildOptions = {
    absWorkingDir: libraryDir,
    entryPoints: [`${side}.ts`],
    bundle: true,
    external: EXTERNALS[side],
    plugins: side === "server" ? [SERVER_LIBRARY_IMPORTS] : [],
    format: "esm",
    platform: side === "client" ? "browser" : "neutral",
    target: LIBRARY_TARGET,
    charset: "utf8",
    legalComments: "none",
    write: false,
    logLevel: "silent",
    // esbuild would otherwise pick up the nearest tsconfig, and which one that is depends on the
    // cwd the build runs from; the libraries' tsconfigs exist for tsc.
    tsconfigRaw: {},
  };
  const result = await build({
    ...options,
    minifyWhitespace: true,
    minifySyntax: true,
    // An external map needs an output path even with `write: false`; nothing is written there.
    // "external" also leaves the bundle without a `sourceMappingURL` comment, which would only 404
    // inside the iframe.
    outfile: join(mapsDir, `${manifest.name}-${side}.js`),
    sourcemap: "external",
    sourcesContent: false,
    metafile: true,
  });
  if (!result.metafile) throw new Error(`${specifier}: esbuild produced no metafile`);
  // The loader's nested-directory shims are `export *`, which forwards no default export (see
  // gadgetWorkerModules), so a default export would exist for `server.js` and vanish for
  // `lib/impl.js`.
  if (side === "server" &&
      Object.values(result.metafile.outputs).some(output => output.exports.includes("default"))) {
    throw new Error(`${specifier} has a default export; libraries export named bindings only`);
  }
  const imports = Object.values(result.metafile.inputs).flatMap(input => input.imports);
  const dependencies = dependenciesOf(manifest, side, imports);
  for (const input of Object.keys(result.metafile.inputs)) {
    const absolute = resolve(libraryDir, input);
    const insideLibrary = !relative(libraryDir, absolute).startsWith("..");
    const fromNodeModules = absolute.split(/[\\/]/u).includes("node_modules");
    if (!insideLibrary && !fromNodeModules) {
      throw new Error(`${specifier} bundles ${input}, which is outside the ${manifest.name} ` +
          `library and not an npm package`);
    }
  }
  const js = result.outputFiles?.find(file => file.path.endsWith(".js"));
  const map = result.outputFiles?.find(file => file.path.endsWith(".map"));
  if (!js || !map) throw new Error(`${specifier}: esbuild produced no bundle`);
  await writeIfChanged(join(mapsDir, `${manifest.name}-${side}.js.map`), map.text);
  const code = js.text;
  return { code, hash: createHash("sha256").update(code).digest("hex"), dependencies };
}

/**
 * The declarations `build-gadget-library-types.ts` emitted for one library: its `client.d.ts`,
 * its `server.d.ts` and every `src/*.d.ts` either side's program reached, with a module both
 * sides emitted identically recorded once as `both`. Each side's entry must be present, or the
 * emit did not run for that side and the library would ship without its interface.
 */
async function readDeclarations(name: string): Promise<Declaration[]> {
  const bySide = new Map<LibrarySide, Map<string, string>>();
  for (const side of LIBRARY_SIDES) {
    const dir = join(librarySideTypesDir(side), name);
    const files = new Map<string, string>();
    for (const path of await listDeclarationFiles(dir)) {
      files.set(path, await readFile(join(dir, path), "utf8"));
    }
    if (!files.has(`${side}.d.ts`)) {
      throw new Error(`no ${side}.d.ts emitted for the ${name} library under ${dir}; run ` +
          `scripts/build-gadget-library-types.ts first`);
    }
    bySide.set(side, files);
  }
  const client = bySide.get("client")!;
  const server = bySide.get("server")!;
  const declarations: Declaration[] = [];
  for (const [path, text] of client) {
    declarations.push({ path, side: server.get(path) === text ? "both" : "client", text });
  }
  for (const [path, text] of server) {
    if (client.get(path) !== text) declarations.push({ path, side: "server", text });
  }
  return declarations.toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Every `.d.ts` under `dir`, as `/`-joined paths relative to it, or none when it does not exist. */
async function listDeclarationFiles(dir: string): Promise<string[]> {
  let found;
  try {
    found = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
  return found
      .filter(entry => entry.isFile() && entry.name.endsWith(".d.ts"))
      .map(entry => relative(dir, join(entry.parentPath, entry.name)).split(/[\\/]/u).join("/"));
}

const generated = `// GENERATED by scripts/build-gadget-libraries.ts -- do not edit.
//
// The gadget libraries this deployment ships, one client and one server ES module each, bundled
// from packages/gadget-libraries. A gadget whose gadget.json pins a library to "latest" runs these;
// see src/gadget-libraries.ts for how a pin resolves.

/** One side of one library: the bundle a gadget's import resolves to, and its content hash. */
export type BundledLibraryModule = {
  /** The ES module's source, minified: what a \`latest\` pin runs and the UI serves by hash. */
  code: string;
  /** sha256 of \`code\`, hex. The UI caches a bundle by it and the loader logs it for provenance. */
  hash: string;
};

/**
 * One declaration file of a library, for the agent's \`describeGadgetLibrary\`: the library's
 * interface with the doc comments the bundles lost.
 */
export type LibraryDeclaration = {
  /** Relative to the library's directory: \`client.d.ts\`, \`server.d.ts\` or \`src/<module>.d.ts\`. */
  path: string;
  /** Which side's program emitted it; \`both\` when the two emitted it identically. */
  side: "client" | "server" | "both";
  /** The \`.d.ts\` text. */
  text: string;
};

/** One bundled library, from its library.json plus the two bundles. */
export type BundledGadgetLibrary = {
  /** The \`<name>\` in \`gadgets:<name>/client\`; the library's directory name. */
  name: string;
  /** From library.json, for people and the agent's listGadgetLibraries; nothing resolves by it. */
  version: string;
  /** From library.json: what the library is and what changed last. */
  notes: string;
  /**
   * Names of the libraries this one imports (\`gadgets:<dependency>/<side>\` left external in its
   * bundles). A gadget loading this library has to pin those too: the blueprint build demands it
   * and the resolver refuses a \`latest\` pin whose dependency is unpinned.
   */
  dependencies: string[];
  /** The \`gadgets:<name>/client\` module. */
  client: BundledLibraryModule;
  /** The \`gadgets:<name>/server\` module. */
  server: BundledLibraryModule;
  /** The library's declarations, sorted by path. */
  declarations: LibraryDeclaration[];
};

export const GADGET_LIBRARIES: readonly BundledGadgetLibrary[] = ${JSON.stringify(entries, null, 2)};
`;

// Skip the write when nothing changed, for the same reason build-format-blueprints.ts does: this
// runs before every build and test, and an identical module with a fresh mtime helps nobody.
if (await writeIfChanged(outFile, generated)) {
  const sizes = entries.map(entry => `${entry.name} ` + LIBRARY_SIDES
      .map(side => `${side} ${kib(entry[side].code)}`)
      .join(", ") + `, declarations ${kib(entry.declarations.map(d => d.text).join(""))}`);
  console.log(`Bundled ${entries.length} gadget librar${entries.length === 1 ? "y" : "ies"} ` +
      `(${sizes.join("; ")}) -> ${outFile}`);
} else {
  console.log(`gadget libraries up-to-date (${entries.length}): ${outFile}`);
}

function kib(text: string): string {
  return `${(text.length / 1024).toFixed(0)} KiB`;
}

async function writeIfChanged(path: string, contents: string): Promise<boolean> {
  try {
    if (await readFile(path, "utf8") === contents) return false;
  } catch (err) {
    if (!(typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT")) {
      throw err;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return true;
}
