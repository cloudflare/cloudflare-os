import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
