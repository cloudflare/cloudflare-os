import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
});
