import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
} from "../scripts/format-blueprint-files.ts";
import {
  formatPins,
  librarySpecifier,
  parseLibrarySpecifier,
  parsePins,
  readPins,
} from "../src/gadget-libraries.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, {recursive: true, force: true})));
});

/** Writes `files` (archive-style relative paths) into a fresh temporary files/ tree. */
async function sourceTree(files: Record<string, string>): Promise<string> {
  let directory = await mkdtemp(join(tmpdir(), "format-blueprint-"));
  temporaryDirectories.push(directory);
  for (let [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), {recursive: true});
    await writeFile(join(directory, path), source);
  }
  return directory;
}

// This file is collected twice: by vitest.config.ts inside workerd, and by
// vitest.blueprints.config.ts in Node. Bundling runs esbuild's native binary, which only the Node
// run can spawn, so those cases skip themselves under workerd rather than fail there.
const inWorkerd = navigator.userAgent === "Cloudflare-Workers";

/** `packages/gadget-libraries`, the one tree near a blueprint a relative path could tempt. */
const gadgetLibrariesDir = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "gadget-libraries");

describe("format blueprint source", () => {
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
    let directory = await mkdtemp(join(tmpdir(), "format-blueprint-"));
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
    let directory = await mkdtemp(join(tmpdir(), "format-blueprint-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "client.js"),
      Uint8Array.of(0xef, 0xbb, 0xbf, 0x73, 0x6f, 0x75, 0x72, 0x63, 0x65));

    expect((await readSourceFiles(directory, "example/files")).get("client.js"))
      .toBe("\ufeffsource");
  });

  it("rejects non-UTF-8 source", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprint-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "client.js"), Uint8Array.of(0xff));

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("client.js is not valid UTF-8");
  });

  it("rejects symlinks", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprint-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "source.js"), "source");
    await symlink(join(directory, "source.js"), join(directory, "client.js"));

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("client.js must not be a symlink");
  });

  it("rejects nested directory symlinks", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprint-"));
    temporaryDirectories.push(directory);
    let outside = await mkdtemp(join(tmpdir(), "format-blueprint-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.js"), "secret");
    await symlink(outside, join(directory, "lib"));

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("lib must not be a symlink");
  });

  it("rejects a symlink used as the source root", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprint-"));
    temporaryDirectories.push(directory);
    let link = `${directory}-link`;
    temporaryDirectories.push(link);
    await symlink(directory, link);

    await expect(readSourceFiles(link, "example/files"))
      .rejects.toThrow("example/files: must not be a symlink");
  });
});

describe.skipIf(inWorkerd)("format blueprint TypeScript sources", () => {
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
    let parent = await mkdtemp(join(tmpdir(), "format-blueprint-outside-"));
    temporaryDirectories.push(parent);
    let directory = join(parent, "files");
    await mkdir(directory);
    await writeFile(join(directory, "client.ts"),
        'import { secret } from "../outside.ts"; console.log(secret);');
    await writeFile(join(parent, "outside.ts"), "export const secret = 1;");

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("client.ts imports ../outside.ts, which is outside the blueprint's files");
  });

  // The specifier is the libraries' only door: a relative path into packages/gadget-libraries is
  // an import outside the blueprint's files like any other, wherever in the blueprint it is
  // written, so a blueprint cannot reach a library's src/ or the wrong side by path.
  it.each([
    ["client.ts", (specifier: string) => ({
      "client.ts": `import * as ui from "${specifier}";\nexport default ui;\n`,
    })],
    ["lib/reach.ts", (specifier: string) => ({
      "client.ts": 'export { ui } from "./lib/reach.ts";',
      "lib/reach.ts": `import * as ui from "${specifier}";\nexport { ui };\n`,
    })],
  ])("rejects %s importing a library by relative path", async (importer, tree) => {
    let directory = await sourceTree({ "client.ts": "" });
    let specifier = relative(join(directory, dirname(importer)),
        join(gadgetLibrariesDir(), "ui", "server.ts")).replaceAll("\\", "/");
    expect(specifier.startsWith("../")).toBe(true);
    for (let [path, source] of Object.entries(tree(specifier))) {
      await mkdir(dirname(join(directory, path)), {recursive: true});
      await writeFile(join(directory, path), source);
    }

    await expect(readSourceFiles(directory, "example/files")).rejects
        .toThrow(`${importer} imports ${specifier}, which is outside the blueprint's files`);
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
});

// A blueprint written in JavaScript is checked without bundling, so every case here but the
// bundled ones runs in both environments.
describe("format blueprint library pins", () => {
  const PAGE_PINS = '{"libraries": {"page": "latest"}}\n';

  it("passes a JavaScript blueprint whose imports and pins agree", async () => {
    let directory = await sourceTree({
      "client.js": 'import { mount } from "gadgets:page/client";\nmount(document.body);\n',
      "server.js": 'export { Gadget } from "gadgets:page/server";\n',
      "gadget.json": PAGE_PINS,
    });

    expect(await readSourceFiles(directory, "example/files")).toEqual(new Map([
      ["client.js", 'import { mount } from "gadgets:page/client";\nmount(document.body);\n'],
      ["gadget.json", PAGE_PINS],
      ["server.js", 'export { Gadget } from "gadgets:page/server";\n'],
    ]));
  });

  it("rejects a library import gadget.json does not pin", async () => {
    let directory = await sourceTree({
      "client.js": 'import { mount } from "gadgets:page/client";\nmount(document.body);\n',
    });

    await expect(readSourceFiles(directory, "example/files")).rejects
      .toThrow("example/files: client.js imports gadgets:page/client, which gadget.json does " +
          "not pin");
  });

  it("names the module that wrote an unpinned import, not just the entry", async () => {
    let directory = await sourceTree({
      "client.js": 'import { mount } from "./lib/mount.js";\nmount();\n',
      "lib/mount.js": 'export { mount } from "gadgets:page/client";\n',
    });

    await expect(readSourceFiles(directory, "example/files")).rejects
      .toThrow("lib/mount.js imports gadgets:page/client, which gadget.json does not pin");
  });

  it("scans specifiers the way the lib reachability scan does, comments included", async () => {
    let directory = await sourceTree({
      "client.js": '// TODO: import { mount } from "gadgets:page/client";\nexport {};\n',
    });

    await expect(readSourceFiles(directory, "example/files")).rejects
      .toThrow("client.js imports gadgets:page/client, which gadget.json does not pin");
  });

  it("ignores a library import in a file no entry reaches", async () => {
    let directory = await sourceTree({
      "client.js": "export {};\n",
      "notes/scratch.js": 'import { mount } from "gadgets:page/client";\n',
    });

    expect([...(await readSourceFiles(directory, "example/files")).keys()])
      .toEqual(["client.js", "notes/scratch.js"]);
  });

  it("rejects a pin nothing imports", async () => {
    let directory = await sourceTree({
      "client.js": "export {};\n",
      "gadget.json": PAGE_PINS,
    });

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("example/files: gadget.json pins page, which nothing imports");
  });

  it("rejects a pin only a file no entry reaches imports", async () => {
    let directory = await sourceTree({
      "client.js": "export {};\n",
      "notes/scratch.js": 'import { mount } from "gadgets:page/client";\n',
      "gadget.json": PAGE_PINS,
    });

    await expect(readSourceFiles(directory, "example/files"))
      .rejects.toThrow("gadget.json pins page, which nothing imports");
  });

  it.each([
    ["client", "server"],
    ["server", "client"],
  ] as const)("rejects %s.js importing a library's %s side", async (entry, side) => {
    let directory = await sourceTree({
      [`${entry}.js`]: `import * as page from "gadgets:page/${side}";\nexport default page;\n`,
      "gadget.json": PAGE_PINS,
    });

    await expect(readSourceFiles(directory, "example/files")).rejects
      .toThrow(`example/files: ${entry}.js imports gadgets:page/${side} from the ${entry} side`);
  });

  it("checks each side's imports from its own entry", async () => {
    // The same library, imported by both entries: each side is walked from its own entry, so
    // neither import is mistaken for the other side's.
    let directory = await sourceTree({
      "client.js": 'import "gadgets:page/client";\n',
      "server.js": 'import "gadgets:page/server";\n',
      "gadget.json": PAGE_PINS,
    });

    expect((await readSourceFiles(directory, "example/files")).size).toBe(3);
  });

  it("rejects a pinned import of a library the deployment does not bundle", async () => {
    let files = {
      "client.js": 'import { mount } from "gadgets:other/client";\nmount();\n',
      "gadget.json": '{"libraries": {"other": "latest"}}\n',
    };

    await expect(readSourceFiles(await sourceTree(files), "example/files",
        {libraries: new Map([["page", []]])})).rejects
      .toThrow("example/files: client.js imports gadgets:other/client, but the deployment " +
          "bundles no library named other");
    // Without the set -- the archive tests, an importer that only needs the files -- names are
    // taken on trust.
    expect((await readSourceFiles(await sourceTree(files), "example/files")).size).toBe(2);
    expect((await readSourceFiles(await sourceTree(files), "example/files",
        {libraries: new Map([["other", []], ["page", []]])})).size).toBe(2);
  });

  it("demands the pins of what an imported library imports in turn", async () => {
    const files = {
      "client.js": 'import { mount } from "gadgets:page/client"; mount();',
      "server.js": "export default {};",
    };
    const libraries = new Map([["page", ["ui"]], ["ui", []]]);
    await expect(readSourceFiles(await sourceTree({
      ...files, "gadget.json": '{"libraries": {"page": "latest"}}',
    }), "example/files", {libraries})).rejects
      .toThrow("example/files: gadget.json must also pin ui, which the page library imports");
    const output = await readSourceFiles(await sourceTree({
      ...files, "gadget.json": '{"libraries": {"page": "latest", "ui": "latest"}}',
    }), "example/files", {libraries});
    expect(output.has("gadget.json")).toBe(true);
  });

  it("rejects a pin to anything but latest", async () => {
    let directory = await sourceTree({
      "client.js": 'import { mount } from "gadgets:page/client";\nmount();\n',
      "gadget.json": '{"libraries": {"page": "vendored"}}\n',
    });

    await expect(readSourceFiles(directory, "example/files")).rejects
      .toThrow('example/files: gadget.json: libraries.page must be "latest"');
  });

  it.each([
    ["not JSON", "{libraries: {}}", /gadget\.json: not valid JSON \(/u],
    ["an unknown key", '{"libraries": {"page": "latest"}, "version": 1}',
      "gadget.json: unknown keys: version"],
    ["a libraries list", '{"libraries": ["page"]}',
      "gadget.json: libraries must be an object of library name to pin"],
    ["a bad pin", '{"libraries": {"page": "1.0.0"}}',
      'gadget.json: libraries.page must be "latest"'],
    ["a bad library name", '{"libraries": {"Page": "latest"}}',
      'gadget.json: "Page" is not a library name ([a-z][a-z0-9-]*)'],
  ])("rejects a gadget.json that is %s", async (_case, text, message) => {
    let directory = await sourceTree({
      "client.js": 'import { mount } from "gadgets:page/client";\nmount();\n',
      "gadget.json": text,
    });

    await expect(readSourceFiles(directory, "example/files")).rejects.toThrow(message);
    await expect(readSourceFiles(directory, "example/files")).rejects.toThrow(/^example\/files: /u);
  });

  // gadget.json was an unrestricted filename before pins existed, so one that is not a pin file
  // (no `libraries` key) is left alone -- and then pins nothing, so a library import fails as
  // unpinned rather than the file failing to parse.
  it.each(["[]", '{"version": 1}', '"page"'])(
    "reads no pins from a gadget.json of %s, which is not a pin file", async text => {
      let plain = await sourceTree({
        "client.js": "// no libraries\n",
        "gadget.json": text,
      });
      expect(await readSourceFiles(plain, "example/files")).toEqual(new Map([
        ["client.js", "// no libraries\n"],
        ["gadget.json", text],
      ]));

      let importing = await sourceTree({
        "client.js": 'import { mount } from "gadgets:page/client";\nmount();\n',
        "gadget.json": text,
      });
      await expect(readSourceFiles(importing, "example/files")).rejects
        .toThrow("example/files: client.js imports gadgets:page/client, which gadget.json does " +
            "not pin");
    });

  it.each(["gadgets:page", "gadgets:page/lib", "gadgets:page/client/index.js",
    "gadgets:Page/client", "gadgets:/client"])(
    "rejects %s, which is not a library specifier", async specifier => {
      let directory = await sourceTree({
        "client.js": `import * as page from "${specifier}";\nexport default page;\n`,
        "gadget.json": PAGE_PINS,
      });

      await expect(readSourceFiles(directory, "example/files")).rejects
        .toThrow(`example/files: client.js imports ${specifier}, which is not a library ` +
            "(gadgets:<name>/client or gadgets:<name>/server)");
    });

  describe.skipIf(inWorkerd)("bundled from TypeScript", () => {
    it("leaves pinned library imports in the bundles and gadget.json as written", async () => {
      let directory = await sourceTree({
        "client.ts": [
          'import { mount, type Options } from "gadgets:page/client";',
          'const options: Options = {readOnly: false};',
          "mount(document.body, options);",
        ].join("\n"),
        "server.ts": 'export { Gadget } from "gadgets:page/server";',
        "gadget.json": PAGE_PINS,
      });

      let files = await readSourceFiles(directory, "example/files");

      expect([...files.keys()]).toEqual(["client.js", "gadget.json", "server.js"]);
      let client = files.get("client.js")!;
      expect(client).toMatch(/import \{\s*mount\s*\} from "gadgets:page\/client";/u);
      expect(client).toContain("mount(document.body, options)");
      expect(client).not.toContain("Options");
      expect(files.get("server.js")).toMatch(/from "gadgets:page\/server";/u);
      expect(files.get("gadget.json")).toBe(PAGE_PINS);
    });

    it("checks the bundle, so a lib module's library import is the entry's", async () => {
      let directory = await sourceTree({
        "client.ts": 'import { mount } from "./lib/mount.ts";\nmount();',
        "lib/mount.ts": 'export { mount } from "gadgets:page/client";',
      });

      await expect(readSourceFiles(directory, "example/files")).rejects
        .toThrow("example/files: client.js imports gadgets:page/client, which gadget.json does " +
            "not pin");
    });

    it("rejects a wrong-side import reached through a lib module", async () => {
      let directory = await sourceTree({
        "client.ts": 'import { Gadget } from "./lib/server.ts";\nconsole.log(Gadget);',
        "lib/server.ts": 'export { Gadget } from "gadgets:page/server";',
        "gadget.json": PAGE_PINS,
      });

      await expect(readSourceFiles(directory, "example/files")).rejects
        .toThrow("client.js imports gadgets:page/server from the client side");
    });

    // esbuild leaves a URL import in the bundle as an external without complaint, so the bundle's
    // surviving imports are checked against what the entry's runtime supplies.
    it("rejects an import the runtime does not supply, and keeps the ones it does", async () => {
      let url = await sourceTree({
        "client.ts": [
          'import x from "https://example.com/x.js";',
          'import { mount } from "gadgets:page/client";',
          "mount(x);",
        ].join("\n"),
        "gadget.json": PAGE_PINS,
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
          'import { Gadget as Base } from "gadgets:page/server";',
          "export class Gadget extends Base { static base = DurableObject; }",
        ].join("\n"),
        "gadget.json": PAGE_PINS,
      });
      let files = await readSourceFiles(supplied, "example/files");
      expect(files.get("server.js")).toMatch(/from "cloudflare:workers";/u);
      expect(files.get("server.js")).toMatch(/from "gadgets:page\/server";/u);
    });
  });
});

describe("gadget library grammar", () => {
  it("spells and parses a library specifier", () => {
    expect(librarySpecifier("page", "client")).toBe("gadgets:page/client");
    expect(parseLibrarySpecifier("gadgets:page/client")).toEqual({name: "page", side: "client"});
    expect(parseLibrarySpecifier("gadgets:my-lib2/server"))
      .toEqual({name: "my-lib2", side: "server"});
  });

  it.each(["gadgets:page", "gadgets:page/lib", "gadgets:page/client/", "gadgets:a/b/client",
    "gadgets:Page/client", "gadgets:2page/client", "gadgets:-page/client", "gadgets:/client",
    "gadgets:page/CLIENT", " gadgets:page/client", "gadget:page/client", "./gadgets:page/client",
    ""])("parses %j as no library specifier", specifier => {
    expect(parseLibrarySpecifier(specifier)).toBeNull();
  });

  it("reads no pins from an absent or empty gadget.json", () => {
    expect(readPins(new Map([["client.js", "export {};"]]))).toEqual(new Map());
    expect(parsePins("{}")).toEqual(new Map());
    expect(parsePins('{"libraries": {}}')).toEqual(new Map());
  });

  // The filename predates pins, so a gadget.json without a `libraries` key is somebody else's
  // file: no pins, and none of the pin file's rules.
  it.each(["null", '"page"', "[]", "1", '{"pins": {}}', '{"version": 1, "name": "x"}'])(
    "reads no pins from %s, which is not a pin file", text => {
      expect(parsePins(text)).toEqual(new Map());
    });

  it("reads pins through the file map", () => {
    expect(readPins(new Map([["gadget.json", '{"libraries": {"page": "latest"}}']])))
      .toEqual(new Map([["page", "latest"]]));
  });

  it("formats pins sorted, in the shape the repo's blueprints commit", () => {
    let text = formatPins(new Map([["zeta", "latest"], ["alpha", "latest"]]));

    expect(text).toBe([
      "{",
      '  "libraries": {',
      '    "alpha": "latest",',
      '    "zeta": "latest"',
      "  }",
      "}",
      "",
    ].join("\n"));
    expect(parsePins(text)).toEqual(new Map([["alpha", "latest"], ["zeta", "latest"]]));
    expect(formatPins(new Map())).toBe('{\n  "libraries": {}\n}\n');
  });

  it.each([
    ["{libraries: {}}", /^gadget\.json: not valid JSON \(/u],
    ['{"libraries": {}, "pins": {}}', "gadget.json: unknown keys: pins"],
    ['{"libraries": null}', "gadget.json: libraries must be an object of library name to pin"],
    ['{"libraries": "page"}', "gadget.json: libraries must be an object of library name to pin"],
    ['{"libraries": {"page": "Latest"}}', 'gadget.json: libraries.page must be "latest"'],
    ['{"libraries": {"page": true}}', 'gadget.json: libraries.page must be "latest"'],
    ['{"libraries": {"my lib": "latest"}}',
      'gadget.json: "my lib" is not a library name ([a-z][a-z0-9-]*)'],
    ['{"libraries": {"": "latest"}}', 'gadget.json: "" is not a library name ([a-z][a-z0-9-]*)'],
  ])("rejects malformed pin file %s", (text, message) => {
    expect(() => parsePins(text)).toThrow(message);
  });
});
