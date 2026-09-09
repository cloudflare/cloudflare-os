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

/**
 * `packages/gadget-libraries`, where the build resolves `gadgets:<name>/<side>`. Resolved on use,
 * like the script's own, since this file is also loaded inside workerd.
 */
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

  // esbuild rewrites a require() it could not resolve away to a `__require` shim that throws when
  // reached, without a warning, and for a computed path without a metafile import either.
  it("rejects a require() that survives into the bundle", async () => {
    let computed = await sourceTree({
      "client.ts": 'import { h } from "./lib/helper.js"; console.log(h);',
      "lib/helper.js": 'const p = "./x.js"; export const h = require(p);',
    });
    await expect(readSourceFiles(computed, "example/files")).rejects
      .toThrow("example/files: client.ts contains a require() call; the bundle is an ES module " +
          "and the gadget runtime has no require");

    // A literal path is no better: the server's externals are ES module imports, so a require of
    // one is left to a runtime that has no require.
    let literal = await sourceTree({
      "server.ts": 'const m = require("cloudflare:workers"); export default m;',
    });
    await expect(readSourceFiles(literal, "example/files")).rejects
      .toThrow("server.ts contains a require() call");
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
  });

  describe("gadget library imports", () => {
    it("inlines a library's entry and what it reaches, from packages/gadget-libraries", async () => {
      let directory = await sourceTree({
        "client.ts": [
          'import { el } from "gadgets:ui/client";',
          'document.body.append(el("div", { text: "hi" }));',
        ].join("\n"),
        "server.ts": 'export { MutationQueue } from "gadgets:sync/server";',
      });

      let files = await readSourceFiles(directory, "example/files");

      // Nothing of the specifier survives: the archive is self-contained, and a gadget created from
      // it carries its copy of the library.
      expect([...files.keys()]).toEqual(["client.js", "server.js"]);
      expect(files.get("client.js")).toContain("function el(");
      expect(files.get("client.js")).not.toContain("gadgets:");
      expect(files.get("server.js")).toContain("MutationQueue = class");
      expect(files.get("server.js")).not.toContain("gadgets:");
    });

    it.each([
      ["client", "server"],
      ["server", "client"],
    ] as const)("rejects %s.ts importing a library's %s side", async (entry, side) => {
      let directory = await sourceTree({
        [`${entry}.ts`]: `import * as ui from "gadgets:ui/${side}";\nexport default ui;\n`,
      });

      await expect(readSourceFiles(directory, "example/files")).rejects
        .toThrow(new RegExp(`${entry}\\.ts failed to bundle: .*imports gadgets:ui/${side} from ` +
            `the ${entry} side`, "su"));
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

    it("rejects a library the repository does not have", async () => {
      let directory = await sourceTree({
        "client.ts": 'import { x } from "gadgets:nope/client";\nx();\n',
      });

      await expect(readSourceFiles(directory, "example/files")).rejects
        .toThrow(/client\.ts failed to bundle: .*no gadget library named nope/su);
    });

    it.each(["gadgets:ui", "gadgets:ui/lib", "gadgets:ui/client/index.js", "gadgets:Ui/client"])(
      "rejects %s, which is not a library specifier", async specifier => {
        let directory = await sourceTree({
          "client.ts": `import * as ui from "${specifier}";\nexport default ui;\n`,
        });

        await expect(readSourceFiles(directory, "example/files")).rejects
          .toThrow(new RegExp(`client\\.ts failed to bundle: .*${specifier.replaceAll("/", "\\/")} ` +
              `is not a library \\(gadgets:<name>\\/client or gadgets:<name>\\/server\\)`, "su"));
      });
  });
});
