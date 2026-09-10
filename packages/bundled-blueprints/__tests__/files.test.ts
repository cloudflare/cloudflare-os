import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildContent,
  extractFiles,
  parseArchive,
  readSourceFiles,
  serializeArchive,
} from "../src/files.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, {recursive: true, force: true})));
});

/** Writes `files` (archive-style relative paths) into a fresh temporary files/ tree. */
async function sourceTree(files: Record<string, string>): Promise<string> {
  let directory = await mkdtemp(join(tmpdir(), "bundled-blueprint-"));
  temporaryDirectories.push(directory);
  for (let [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), {recursive: true});
    await writeFile(join(directory, path), source);
  }
  return directory;
}

/** This package's `libraries/`, where the build resolves a `${LIBRARY}/<name>/<side>` import. */
const gadgetLibraries = resolve(dirname(fileURLToPath(import.meta.url)), "..", "libraries");

/** How a blueprint imports a gadget library: this package's name and the exported subpath. */
const LIBRARY = "@gadgets/bundled-blueprints/libraries";

describe("bundled blueprint source", () => {
  it("reconstructs files deterministically", () => {
    let files = new Map([
      ["server.js", "export default {};\n"],
      ["lib/util.js", "export const value = 1;\n"],
      ["empty.txt", ""],
      ["client.js", "console.log('hello');\n"],
    ]);
    let metadata = {
      title: "Example",
      description: "Example blueprint",
      author: {type: "user", name: "Test", id: "test@example.com"},
      created: "2026-01-01T00:00:00.000Z",
      version: 1,
      lastUpdated: "2026-01-01T00:00:00.000Z",
      bindings: {},
    };

    let first = serializeArchive(metadata, buildContent(files, "example"), "example");
    let second = serializeArchive(metadata, buildContent(files, "example"), "example");

    expect(second).toEqual(first);
    let parsed = parseArchive(first, "example");
    expect(parsed.metadata).toEqual(metadata);
    expect(extractFiles(parsed.content, "example")).toEqual(files);
  });

  it("reads nested source files as archive paths", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprint-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "lib"));
    await writeFile(join(directory, "client.js"), "client\n");
    await writeFile(join(directory, "lib/util.js"), "utility\n");

    expect(await readSourceFiles(directory, "example/files")).toEqual(new Map([
      ["client.js", "client\n"],
      ["lib/util.js", "utility\n"],
    ]));
  });

  it.each(["", "/client.js", "lib/", "lib//util.js", "lib/./util.js", "lib/../util.js",
    "lib\\util.js", "lib\0util.js"])("rejects unsafe archive path %j", path => {
    expect(() => buildContent(new Map([[path, "source"]]), "example"))
      .toThrow("unsafe blueprint file path");
  });

  it("rejects file and directory path conflicts", () => {
    expect(() => buildContent(new Map([["lib", "file"], ["lib/util.js", "nested"]]), "example"))
      .toThrow("lib/util.js conflicts with file lib");
  });

  it.each([
    ["Foo.js", "foo.js"],
    ["caf\u00e9.js", "cafe\u0301.js"],
    ["\u03a3.js", "\u03c2.js"],
    ["S.js", "\u017f.js"],
    ["\u00df.js", "\u1e9e.js"],
  ])("rejects filesystem-equivalent archive paths %j and %j", (first, second) => {
    expect(() => buildContent(new Map([[first, "first"], [second, "second"]]), "example"))
      .toThrow("aliases");
  });

  it("rejects filesystem-equivalent file and directory conflicts", () => {
    expect(() => buildContent(new Map([["LIB", "file"], ["lib/util.js", "nested"]]), "example"))
      .toThrow("lib/util.js conflicts with file LIB");
  });

  it("rejects filesystem-equivalent directory aliases", () => {
    expect(() => buildContent(new Map([
      ["Foo/first.js", "first"],
      ["foo/second.js", "second"],
    ]), "example")).toThrow("foo aliases directory Foo");
  });

  it("rejects portable file and directory conflicts", () => {
    expect(() => buildContent(new Map([
      ["Foo", "file"],
      ["foo/child.js", "child"],
    ]), "example")).toThrow("foo/child.js conflicts with file Foo");
    expect(() => buildContent(new Map([
      ["foo/child.js", "child"],
      ["Foo", "file"],
    ]), "example")).toThrow("Foo conflicts with directory foo");
  });

  it.each(["CON", "aux.js", "COM\u00b9.log", "a:b.js", "client.js.", "client.js ",
    ".git/config", ".gitignore"])("rejects non-portable archive path %j", path => {
    expect(() => buildContent(new Map([[path, "source"]]), "example"))
      .toThrow("non-portable blueprint file path");
  });

  it("rejects empty blueprints", () => {
    expect(() => buildContent(new Map(), "example"))
      .toThrow("blueprint must contain at least one source file");
  });

  it("preserves a leading UTF-8 BOM", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprint-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "client.js"),
      Uint8Array.of(0xef, 0xbb, 0xbf, 0x73, 0x6f, 0x75, 0x72, 0x63, 0x65));

    expect((await readSourceFiles(directory, "example/files")).get("client.js"))
      .toBe("\ufeffsource");
  });

  it("rejects non-UTF-8 source", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprint-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "client.js"), Uint8Array.of(0xff));

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("client.js is not valid UTF-8");
  });

  it("rejects symlinks", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprint-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "source.js"), "source");
    await symlink(join(directory, "source.js"), join(directory, "client.js"));

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("client.js must not be a symlink");
  });

  it("rejects nested directory symlinks", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprint-"));
    temporaryDirectories.push(directory);
    let outside = await mkdtemp(join(tmpdir(), "bundled-blueprint-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.js"), "secret");
    await symlink(outside, join(directory, "lib"));

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("lib must not be a symlink");
  });

  it("rejects a symlink used as the source root", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprint-"));
    temporaryDirectories.push(directory);
    let link = `${directory}-link`;
    temporaryDirectories.push(link);
    await symlink(directory, link);

    await expect(readSourceFiles(link, "example/files"))
      .rejects.toThrow("example/files: must not be a symlink");
  });
});

describe("bundled blueprint TypeScript sources", () => {
  it("bundles each entry with its lib imports into one JavaScript file", async () => {
    let directory = await sourceTree({
      "README.md": "# Example\n",
      "client.ts": [
        'import { greet } from "./lib/greeting.ts";',
        'document.body.textContent = greet("caf\u00e9");',
      ].join("\n"),
      "server.ts": [
        'import { DurableObject } from "cloudflare:workers";',
        'import { VERSION } from "./lib/shared.ts";',
        "export class Gadget extends DurableObject { version(): number { return VERSION; } }",
      ].join("\n"),
      "lib/greeting.ts": "export function greet(name: string): string { return `hello ${name}`; }",
      "lib/shared.ts": "export const VERSION: number = 7;",
      "lib/types.d.ts": "export type Never = never;",
    });

    let files = await readSourceFiles(directory, "example/files");

    expect([...files.keys()]).toEqual(["README.md", "client.js", "server.js"]);
    expect(files.get("README.md")).toBe("# Example\n");
    let client = files.get("client.js")!;
    // The lib module is inlined, typed and readable rather than imported, erased or minified.
    expect(client).toContain("hello ${name}");
    expect(client).not.toMatch(/from\s+"\.\/lib/u);
    expect(client).not.toContain(": string");
    expect(client).toContain("function greet(name)");
    expect(client).toContain("caf\u00e9");
    let server = files.get("server.js")!;
    expect(server).toContain('from "cloudflare:workers"');
    expect(server).toContain("VERSION = 7");
    // esbuild gathers a bundle's exports into one trailing export list.
    expect(server).toContain("Gadget = class extends DurableObject");
    expect(server).toMatch(/export \{\s*Gadget\s*\};/u);
    expect(server).not.toContain("./lib/shared");
  });

  it("keeps a non-TypeScript module a bundle inlined in the archive", async () => {
    let directory = await sourceTree({
      "client.ts": 'import data from "./lib/data.json"; console.log(data.answer);',
      "lib/data.json": '{"answer": 42}',
    });

    let files = await readSourceFiles(directory, "example/files");

    // Inlined into the bundle *and* still shipped: only TypeScript is build input, and dropping a
    // file esbuild happened to inline would break whatever else in the archive imports it.
    expect([...files.keys()]).toEqual(["client.js", "lib/data.json"]);
    expect(files.get("client.js")).toContain("answer: 42");
    expect(files.get("lib/data.json")).toBe('{"answer": 42}');
  });

  it("bundles one side while the other stays plain JavaScript", async () => {
    let directory = await sourceTree({
      "client.ts": 'import { shared } from "./lib/helpers.js";\ndocument.title = shared();',
      "server.js": [
        'import { shared } from "./lib/helpers.js";',
        "export class Gadget { hi() { return shared(); } }",
      ].join("\n"),
      "lib/helpers.js": 'export function shared() { return "shared"; }',
    });

    let files = await readSourceFiles(directory, "example/files");

    // The un-migrated side keeps its import, so the module it names has to survive the migration
    // of the other side -- an archive whose server.js imports a file that is gone would fail to
    // load with nothing to show for it at build time.
    expect([...files.keys()]).toEqual(["client.js", "lib/helpers.js", "server.js"]);
    expect(files.get("server.js")).toContain('from "./lib/helpers.js"');
    expect(files.get("client.js")).toContain('return "shared"');
    expect(files.get("client.js")).not.toMatch(/from\s+"\.\/lib/u);
  });

  it("leaves a JavaScript blueprint untouched and drops declaration files", async () => {
    let directory = await sourceTree({
      "client.js": "client\n",
      "lib/util.js": "utility\n",
      "lib/util.d.ts": "export {};\n",
      "lib/util.d.mts": "export {};\n",
    });

    expect(await readSourceFiles(directory, "example/files")).toEqual(new Map([
      ["client.js", "client\n"],
      ["lib/util.js", "utility\n"],
    ]));
  });

  it("rejects an entry present as both TypeScript and JavaScript", async () => {
    let directory = await sourceTree({
      "client.ts": "export {};",
      "client.js": "export {};",
    });

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("client.ts and client.js both define the client entry");
  });

  it("rejects a lib module present as both TypeScript and JavaScript", async () => {
    let directory = await sourceTree({
      "client.ts": 'import { value } from "./lib/value.js"; console.log(value);',
      "lib/value.ts": "export const value: number = 1;",
      "lib/value.js": "export const value = 2;",
    });

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("lib/value.ts and lib/value.js both define the same module; TypeScript " +
          "would type the .ts while the bundle ships the .js");
  });

  it("rejects TypeScript that is neither an entry nor a lib module", async () => {
    let directory = await sourceTree({
      "client.ts": "export {};",
      "helpers.ts": "export const helper = 1;",
    });

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("helpers.ts is not a gadget module");
  });

  it("keeps a module imported only for its types out of the archive", async () => {
    let directory = await sourceTree({
      "client.ts": [
        'import { render } from "./lib/render.ts";',
        'document.body.append(render({id: "a", text: "hi"}));',
      ].join("\n"),
      "lib/render.ts": [
        'import type { Block } from "./types.ts";',
        "export function render(block: Block): Text { return new Text(block.text); }",
      ].join("\n"),
      "lib/types.ts": "export type Block = { id: string; text: string };",
    });

    let files = await readSourceFiles(directory, "example/files");

    // The shared contract is reached only through another lib module, and only in type position:
    // nothing of it survives compilation, so no bundle can witness that it was imported at all.
    expect([...files.keys()]).toEqual(["client.js"]);
    expect(files.get("client.js")).toContain("new Text(block.text)");
  });

  it.each(["client.tsx", "lib/component.tsx", "lib/loader.mts", "lib/loader.cts"])(
    "rejects TypeScript the gadget runtimes have no loader for: %s", async path => {
      let directory = await sourceTree({"client.ts": "export {};", [path]: "export {};"});

      await expect(readSourceFiles(directory, "example/files"))
        .rejects.toThrow(`${path} is not a gadget module: gadget TypeScript is plain .ts`);
    });

  // Each entry may import only what its own runtime supplies, so a bare import has to fail the
  // build: with no node_modules above the blueprint esbuild cannot resolve it at all, and with one
  // it resolves to a file the "outside the blueprint" check below rejects. Either way the mistake
  // surfaces here rather than inside the sandbox. `cloudflare:workers` is the interesting case: the
  // server's Durable Object has it, the iframe does not.
  it.each([
    ["client", "yjs"],
    ["client", "cloudflare:workers"],
    ["server", "zod"],
  ])("rejects %s.ts importing %s, which its runtime does not supply", async (entry, specifier) => {
    let directory = await sourceTree({
      [`${entry}.ts`]: `import * as module from "${specifier}";\nexport const value = module;\n`,
    });

    await expect(readSourceFiles(directory, "example/files")).rejects
      .toThrow(new RegExp(`${entry}\\.ts failed to bundle: [\\s\\S]*Could not resolve "${
        specifier}"`, "u"));
  });

  it("rejects a lib module no entry bundles", async () => {
    let directory = await sourceTree({
      "client.ts": "export {};",
      "lib/unused.ts": "export const unused = 1;",
    });

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("lib/unused.ts is not imported by any entry point");
  });

  it("rejects lib modules with no entry to bundle them", async () => {
    let directory = await sourceTree({
      "client.js": "export {};",
      "lib/orphan.ts": "export const orphan = 1;",
    });

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("lib/orphan.ts has no client.ts or server.ts to bundle it");
  });

  it("rejects imports that reach outside the blueprint", async () => {
    // A per-test parent, so the out-of-tree file is private to this run rather than a fixed path
    // in the shared tmpdir root that a concurrent run would race on.
    let parent = await mkdtemp(join(tmpdir(), "bundled-blueprint-outside-"));
    temporaryDirectories.push(parent);
    let directory = join(parent, "files");
    await mkdir(directory);
    await writeFile(join(directory, "client.ts"),
        'import { secret } from "../outside.ts"; console.log(secret);');
    await writeFile(join(parent, "outside.ts"), "export const secret = 1;");

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("client.ts imports ../outside.ts, which is outside the blueprint's files");
  });

  // esbuild inlines a dynamic import of a literal path like a static one, but leaves a computed
  // path in the output as written, to resolve inside the sandbox against nothing the build checked.
  it("rejects a dynamic import of a computed path, and inlines one of a literal", async () => {
    let computed = await sourceTree({
      "client.ts": 'const p = "./lib/x.js"; export const m = import(p);',
      "lib/x.ts": "export const x = 1;",
    });
    await expect(readSourceFiles(computed, "example/files")).rejects
      .toThrow("example/files: client.ts contains a dynamic import whose path is not a string " +
          "literal; the bundler cannot check it");

    let literal = await sourceTree({
      "client.ts": 'export const m = import("./lib/x.ts");',
      "lib/x.ts": "export const x = 1;",
    });
    let files = await readSourceFiles(literal, "example/files");
    expect([...files.keys()]).toEqual(["client.js"]);
    expect(files.get("client.js")).toContain("x = 1");
    expect(files.get("client.js")).not.toMatch(/\bimport\s*\(/u);
  });

  // esbuild expands a dynamic import of a template literal into a glob helper over every file the
  // pattern matches: no `import()` in the output, an external metafile edge whose path is the
  // wildcard, and the matched files inlined as inputs no edge points at -- including files outside
  // the blueprint, which the pattern is free to reach.
  it("rejects a dynamic import of a template literal", async () => {
    let inside = await sourceTree({
      "client.ts": "export const load = (name: string) => import(`./lib/${name}.js`);",
      "lib/a.js": "export const a = 1;",
    });
    await expect(readSourceFiles(inside, "example/files")).rejects
      .toThrow("example/files: client.ts imports ./lib/**/*.js: a dynamic import of a template " +
          "literal, which the bundler expands to every file the pattern matches and cannot check");

    let outside = await sourceTree({
      "files/client.ts": "export const load = (name: string) => import(`../outside/${name}.js`);",
      "outside/x.js": "export const x = 1;",
    });
    await expect(readSourceFiles(join(outside, "files"), "example/files")).rejects
      .toThrow("client.ts imports ../outside/**/*.js: a dynamic import of a template literal");
  });

  // A TypeScript lib module is compiled into the entries and not stored, so a module the archive
  // ships as written -- an un-migrated entry, or a lib/*.js -- would import a file the archive does
  // not contain, and the gadget would fail to load with nothing to show for it at build time.
  it("rejects a shipped JavaScript module that imports a TypeScript lib module", async () => {
    let direct = await sourceTree({
      "client.ts": 'import { shared } from "./lib/shared.js";\ndocument.title = shared();',
      "server.js": [
        'import { shared } from "./lib/shared.js";',
        "export class Gadget { hi() { return shared(); } }",
      ].join("\n"),
      "lib/shared.ts": 'export function shared(): string { return "shared"; }',
    });
    await expect(readSourceFiles(direct, "example/files")).rejects
      .toThrow("example/files: server.js imports ./lib/shared.js, which names lib/shared.ts; " +
          "server.js ships as written, and a TypeScript lib module is compiled into the entries " +
          "that import it and not shipped");

    let chained = await sourceTree({
      "client.ts": 'import { shared } from "./lib/shared.ts";\ndocument.title = shared();',
      "server.js": [
        'import { hi } from "./lib/helpers.js";',
        "export class Gadget { hi() { return hi(); } }",
      ].join("\n"),
      "lib/helpers.js": 'import { shared } from "./shared.js"; export const hi = () => shared();',
      "lib/shared.ts": 'export function shared(): string { return "shared"; }',
    });
    await expect(readSourceFiles(chained, "example/files")).rejects
      .toThrow("lib/helpers.js imports ./shared.js, which names lib/shared.ts");
  });

  // esbuild rewrites a reference to require it could not resolve away to a `__require` shim that
  // throws when called, without a warning, and for a computed path without a metafile import
  // either.
  it("rejects a require that survives into the bundle", async () => {
    let computed = await sourceTree({
      "client.ts": 'import { h } from "./lib/helper.js"; console.log(h);',
      "lib/helper.js": 'const p = "./x.js"; export const h = require(p);',
    });
    await expect(readSourceFiles(computed, "example/files")).rejects
      .toThrow("example/files: client.ts references require; the bundle is an ES module and the " +
          "gadget runtime has no require");

    // A literal path is no better: the server's externals are ES module imports, so a require of
    // one is left to a runtime that has no require.
    let literal = await sourceTree({
      "server.ts": 'const m = require("cloudflare:workers"); export default m;',
    });
    await expect(readSourceFiles(literal, "example/files")).rejects
      .toThrow("server.ts references require");

    // Nor is a use other than a call: `require.resolve` reaches the same shim, as a member access
    // rather than a call.
    let resolved = await sourceTree({
      "client.ts": 'export const p = require.resolve("./x.js");',
    });
    await expect(readSourceFiles(resolved, "example/files")).rejects
      .toThrow("client.ts references require");
  });

  it("counts a module imported across a comment as imported", async () => {
    let directory = await sourceTree({
      "client.ts": 'import /* initialize */ "./lib/setup.ts";',
      "lib/setup.ts": 'document.title = "ready";',
    });

    let files = await readSourceFiles(directory, "example/files");

    expect([...files.keys()]).toEqual(["client.js"]);
    expect(files.get("client.js")).toContain('document.title = "ready"');
  });

  it("reports an unresolvable import against the entry", async () => {
    let directory = await sourceTree({
      "server.ts": 'import { missing } from "./lib/missing.ts"; export default missing;',
    });

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow(/example\/files: server\.ts failed to bundle: .*lib\/missing/su);
  });

  // esbuild leaves a URL import in the bundle as an external without complaint, so the bundle's
  // surviving imports are checked against what the entry's runtime supplies.
  it("rejects an import the runtime does not supply, and keeps the ones it does", async () => {
    let url = await sourceTree({
      "client.ts": 'import x from "https://example.com/x.js";\nconsole.log(x);',
    });
    await expect(readSourceFiles(url, "example/files")).rejects
      .toThrow("example/files: client.ts imports https://example.com/x.js, which the client " +
          "runtime does not supply");

    // workerd's own modules are the server's externals only; on the client esbuild has nothing
    // to resolve them against, so that one fails as an ordinary unresolved import.
    let cloudflare = await sourceTree({
      "client.ts": 'import { DurableObject } from "cloudflare:workers";\nconsole.log(DurableObject);',
    });
    await expect(readSourceFiles(cloudflare, "example/files")).rejects
      .toThrow(/client\.ts failed to bundle: .*Could not resolve "cloudflare:workers"/su);

    let supplied = await sourceTree({
      "server.ts": [
        'import { DurableObject } from "cloudflare:workers";',
        "export class Gadget extends DurableObject {}",
      ].join("\n"),
    });
    let files = await readSourceFiles(supplied, "example/files");
    expect(files.get("server.js")).toMatch(/from "cloudflare:workers";/u);

    // And only that one: the gadget's worker loader supplies no other `cloudflare:` module, so a
    // Durable Object importing one has to fail here rather than when it is instantiated.
    let unsupplied = await sourceTree({
      "server.ts": 'import { env } from "cloudflare:test";\nexport default env;\n',
    });
    await expect(readSourceFiles(unsupplied, "example/files")).rejects
      .toThrow(/server\.ts failed to bundle: .*Could not resolve "cloudflare:test"/su);
  });

  describe("gadget library imports", () => {
    it("inlines a library's entry and what it reaches, from libraries/", async () => {
      let directory = await sourceTree({
        "client.ts": [
          `import { el } from "${LIBRARY}/ui/client";`,
          'document.body.append(el("div", { text: "hi" }));',
        ].join("\n"),
        "server.ts": `export { MutationQueue } from "${LIBRARY}/sync/server";`,
      });

      let files = await readSourceFiles(directory, "example/files");

      // Nothing of the specifier survives: the archive is self-contained, and a gadget created from
      // it carries its copy of the library. The fixture has no node_modules above it, so the
      // package name resolved through the build's alias, not through an install.
      expect([...files.keys()]).toEqual(["client.js", "server.js"]);
      expect(files.get("client.js")).toContain("function el(");
      expect(files.get("client.js")).not.toContain("@gadgets/");
      expect(files.get("server.js")).toContain("MutationQueue = class");
      expect(files.get("server.js")).not.toContain("@gadgets/");
    });

    it.each([
      ["client", "server"],
      ["server", "client"],
    ] as const)("rejects %s.ts importing a library's %s side", async (entry, side) => {
      let directory = await sourceTree({
        [`${entry}.ts`]: `import * as ui from "${LIBRARY}/ui/${side}";\nexport default ui;\n`,
      });

      await expect(readSourceFiles(directory, "example/files")).rejects
        .toThrow(`example/files: ${entry}.ts imports ${LIBRARY}/ui/${side} from the ${entry} side`);
    });

    // The package subpath is the libraries' only door: a path into libraries/, relative or
    // absolute, is an import outside the blueprint's files like any other, wherever in the
    // blueprint it is written, so a blueprint cannot reach a library's src/ or the wrong side by
    // path.
    const importers = [
      ["client.ts", (specifier: string) => ({
        "client.ts": `import * as ui from "${specifier}";\nexport default ui;\n`,
      })],
      ["lib/reach.ts", (specifier: string) => ({
        "client.ts": 'export { ui } from "./lib/reach.ts";',
        "lib/reach.ts": `import * as ui from "${specifier}";\nexport { ui };\n`,
      })],
    ] as const;

    it.each(importers)("rejects %s importing a library by relative path", async (importer,
        tree) => {
      // esbuild resolves the import from the importer's real path (a temporary directory on macOS
      // sits under a symlink), so the specifier has to climb from there for it to land at all.
      let directory = await realpath(await sourceTree({ "client.ts": "" }));
      let specifier = relative(join(directory, dirname(importer)),
          join(gadgetLibraries, "ui", "server.ts")).replaceAll("\\", "/");
      expect(specifier.startsWith("../")).toBe(true);
      for (let [path, source] of Object.entries(tree(specifier))) {
        await mkdir(dirname(join(directory, path)), {recursive: true});
        await writeFile(join(directory, path), source);
      }

      await expect(readSourceFiles(directory, "example/files")).rejects
          .toThrow(`${importer} imports ${specifier}, which is outside the blueprint's files`);
    });

    it.each(importers.flatMap(([importer, tree]) => [
      [importer, tree, join(gadgetLibraries, "sync", "server.ts")],
      [importer, tree, join(gadgetLibraries, "ui", "src", "dom.ts")],
    ]))("rejects %s importing a library by absolute path", async (importer, tree, specifier) => {
      let directory = await sourceTree(tree(specifier.replaceAll("\\", "/")));

      await expect(readSourceFiles(directory, "example/files")).rejects
          .toThrow(`${importer} imports ${specifier.replaceAll("\\", "/")}, which is outside the ` +
              `blueprint's files`);
    });

    // A bare specifier some node_modules above the blueprint happens to satisfy resolves, unlike
    // the ones in "rejects %s.ts importing %s" above, and is refused for where it landed.
    it("rejects a bare import that a node_modules above the blueprint resolves", async () => {
      let parent = await mkdtemp(join(tmpdir(), "bundled-blueprint-outside-"));
      temporaryDirectories.push(parent);
      let directory = join(parent, "files");
      await mkdir(join(parent, "node_modules", "dep"), {recursive: true});
      await writeFile(join(parent, "node_modules", "dep", "index.js"), "export const d = 1;");
      await mkdir(directory);
      await writeFile(join(directory, "client.ts"), 'import { d } from "dep"; console.log(d);');

      await expect(readSourceFiles(directory, "example/files")).rejects
        .toThrow("example/files: client.ts imports dep, which is outside the blueprint's files");
    });

    // A library that does not exist, or a subpath the package does not export, is not found where
    // the alias points, and esbuild says so against the specifier as written.
    it.each([
      `${LIBRARY}/nope/client`,
      `${LIBRARY}/ui`,
      "@gadgets/bundled-blueprints",
    ])("rejects %s, which names no library entry", async specifier => {
      let directory = await sourceTree({
        "client.ts": `import * as ui from "${specifier}";\nexport default ui;\n`,
      });

      await expect(readSourceFiles(directory, "example/files")).rejects
        .toThrow(new RegExp(`client\\.ts failed to bundle: .*Could not resolve .*\\(originally "${
          specifier}"\\)`, "su"));
    });

    // Spellings that resolve to a file under libraries/ but are not the exported subpath: esbuild's
    // extension probing takes `client.ts` and `client.js` to the same entry, and the alias takes
    // any path under the package root to the file there.
    it.each([`${LIBRARY}/ui/client.ts`, `${LIBRARY}/ui/client.js`, `${LIBRARY}/ui/src/dom.ts`])(
      "rejects %s, which is not a library import", async specifier => {
        let directory = await sourceTree({
          "client.ts": `import * as ui from "${specifier}";\nexport default ui;\n`,
        });

        await expect(readSourceFiles(directory, "example/files")).rejects
          .toThrow(`example/files: client.ts imports ${specifier}, which is not a library import ` +
              `(${LIBRARY}/<name>/client or ${LIBRARY}/<name>/server)`);
      });

    // A case-insensitive filesystem resolves the mis-cased name to the library, and the audit
    // refuses the spelling; a case-sensitive one never finds it. Either way it fails.
    it("rejects a mis-cased library name", async () => {
      let directory = await sourceTree({
        "client.ts": `import * as ui from "${LIBRARY}/Ui/client";\nexport default ui;\n`,
      });

      await expect(readSourceFiles(directory, "example/files")).rejects
        .toThrow(/Ui\/client(?:, which is not a library import|"\))/u);
    });
  });
});
