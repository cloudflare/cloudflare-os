import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildContent,
  serializeArchive,
} from "../packages/workshop-backend/scripts/format-blueprint-files.ts";

const temporaryDirectories: string[] = [];
const workspaceRoot = join(import.meta.dirname, "..");
const packageRoot = join(workspaceRoot, "packages/workshop-backend");
const buildScript = join(packageRoot, "scripts/build-format-blueprints.ts");
const importScript = join(packageRoot, "scripts/import-format-blueprint.ts");

const presentation = {
  blueprintId: "format.example",
  title: "Example",
  description: "An example format.",
  output: {id: "example", noun: "Example", plural: "Examples", icon: "appWindow"},
  author: {type: "user" as const, name: "Test", id: "test@example.com"},
  revision: 1,
};
const manifest = {
  ...presentation,
  created: "2026-01-01T00:00:00.000Z",
  version: 1,
  lastUpdated: "2026-01-01T00:00:00.000Z",
  bindings: {},
};

async function writeArchive(
  path: string,
  version: number,
  files: Map<string, string>,
): Promise<void> {
  let metadata = {
    title: manifest.title,
    description: manifest.description,
    author: manifest.author,
    created: manifest.created,
    version,
    lastUpdated: manifest.lastUpdated,
    bindings: manifest.bindings,
  };
  await writeFile(path, serializeArchive(metadata, buildContent(files, path), path));
}

// Throwaway output for the generator. Its default is
// `packages/workshop-backend/src/generated/format-blueprints.ts` -- the module that package
// compiles, and which its `build:integration-worker` and `test` tasks read concurrently with this
// suite under `vp run`. Writing there races them for a real blueprint set, and this suite's
// fixtures are one fake blueprint or none.
//
// Nothing was catching that. The module is gitignored, so `git status` stays clean, and the
// `afterEach` that used to regenerate it afterwards left the bytes as vp found them, so the task
// cached normally too -- the corruption was visible only to whatever read the path inside the
// window. `scripts/vite.config.ts` has the longer note.
//
// Two kinds of spawn need it: every `buildScript` spawn, and the `importScript` spawns that
// succeed -- import-format-blueprint.ts regenerates the module in-process when it finishes, and
// forwards `--out` to do it. The `importScript` spawns that assert `status === 1` exit before
// reaching that point, so they need nothing; if one ever stopped failing, its own assertion is
// what catches it.
//
// A directory of its own rather than the fixture directory the generator is reading: both scripts
// reject unexpected files in a blueprint directory, so the output must not land in the set being
// scanned.
async function temporaryOutFile(): Promise<string> {
  let directory = await mkdtemp(join(tmpdir(), "format-blueprints-out-"));
  temporaryDirectories.push(directory);
  return join(directory, "format-blueprints.ts");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, {recursive: true, force: true})));
});

describe("format blueprint scripts", () => {
  it("ignores dot-prefixed files and interrupted-import directories", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprints-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, ".DS_Store"), "ignored");
    await mkdir(join(directory, ".example.import-123", "files"), {recursive: true});
    await writeFile(join(directory, ".example.import-123", "blueprint.json"), "not JSON");

    let result = spawnSync(process.execPath, [buildScript, "--out", await temporaryOutFile()], {
      cwd: packageRoot,
      env: {...process.env, FORMAT_BLUEPRINTS_DIR: directory},
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /No blueprint directories/);
  });

  it("ignores hidden duplicate manifests when importing an update", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprints-"));
    temporaryDirectories.push(directory);
    for (let name of ["example", ".example.backup-123"]) {
      await mkdir(join(directory, name, "files"), {recursive: true});
      await writeFile(join(directory, name, "blueprint.json"),
        `${JSON.stringify(manifest, null, 2)}\n`);
      await writeFile(join(directory, name, "files/client.js"), `// old ${name}\n`);
      await mkdir(join(directory, name, "files/lib"));
      await writeFile(join(directory, name, "files/lib/util.js"), `// old util ${name}\n`);
    }

    let archivePath = join(directory, ".update.gadget");
    await writeArchive(archivePath, 2, new Map([
      ["client.js", "// updated\n"],
      ["lib/util.js", "// updated util\n"],
    ]));

    let result = spawnSync(process.execPath,
      [importScript, archivePath, "format.example", "--out", await temporaryOutFile()], {
        cwd: packageRoot,
        env: {...process.env, FORMAT_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(directory, "example/files/client.js"), "utf8"), "// updated\n");
    assert.equal(await readFile(join(directory, "example/files/lib/util.js"), "utf8"),
      "// updated util\n");
    assert.equal(await readFile(join(directory, ".example.backup-123/files/client.js"), "utf8"),
      "// old .example.backup-123\n");
    let updatedManifest = JSON.parse(await readFile(join(directory, "example/blueprint.json"), "utf8"));
    assert.equal(updatedManifest.revision, 2);
    assert.equal(updatedManifest.version, 2);
  });

  it("builds and recovers a blueprint left only in an interrupted-import backup", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprints-"));
    temporaryDirectories.push(directory);
    let name = "example format";
    await mkdir(join(directory, name, "files"), {recursive: true});
    await writeFile(join(directory, name, "blueprint.json"),
      `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(directory, name, "files/client.js"), "// old\n");
    await rename(join(directory, name), join(directory, `.${name}.backup-123`));

    let generatedModule = await temporaryOutFile();
    let build = spawnSync(process.execPath, [buildScript, "--out", generatedModule], {
      cwd: packageRoot,
      env: {...process.env, FORMAT_BLUEPRINTS_DIR: directory},
      encoding: "utf8",
    });
    assert.equal(build.status, 0, build.stderr);
    assert.match(await readFile(generatedModule, "utf8"), /"blueprintId": "format\.example"/);

    let archivePath = join(directory, ".update.gadget");
    await writeArchive(archivePath, 2, new Map([["client.js", "// recovered\n"]]));
    let imported = spawnSync(process.execPath,
      [importScript, archivePath, "format.example", "--out", generatedModule], {
        cwd: packageRoot,
        env: {...process.env, FORMAT_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(await readFile(join(directory, name, "files/client.js"), "utf8"),
      "// recovered\n");
    await assert.rejects(readFile(join(directory, `.${name}.backup-123/blueprint.json`)),
      {code: "ENOENT"});
  });

  it("rejects dot-prefixed new blueprint names", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprints-"));
    temporaryDirectories.push(directory);

    let result = spawnSync(process.execPath,
      [importScript, join(directory, "missing.gadget"), "--new", ".hidden"], {
        cwd: packageRoot,
        env: {...process.env, FORMAT_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /name must start with an alphanumeric character/);
  });

  it("rejects manifest fields that override the trusted directory name", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprints-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "example", "files"), {recursive: true});
    await writeFile(join(directory, "example", "blueprint.json"),
      `${JSON.stringify({...manifest, name: "../victim"}, null, 2)}\n`);
    await writeFile(join(directory, "example", "files/client.js"), "// original\n");

    let result = spawnSync(process.execPath,
      [importScript, join(directory, "missing.gadget"), "format.example"], {
        cwd: packageRoot,
        env: {...process.env, FORMAT_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown keys: name/);
    assert.equal(await readFile(join(directory, "example/files/client.js"), "utf8"),
      "// original\n");
  });

  it("validates imported metadata before replacing existing source", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprints-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "example", "files"), {recursive: true});
    await writeFile(join(directory, "example", "blueprint.json"),
      `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(directory, "example", "files/client.js"), "// original\n");
    let archivePath = join(directory, ".invalid.gadget");
    await writeFile(archivePath, serializeArchive({},
      buildContent(new Map([["client.js", "// invalid\n"]]), archivePath), archivePath));

    let result = spawnSync(process.execPath, [importScript, archivePath, "format.example"], {
      cwd: packageRoot,
      env: {...process.env, FORMAT_BLUEPRINTS_DIR: directory},
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /version must be a positive integer/);
    assert.equal(await readFile(join(directory, "example/files/client.js"), "utf8"),
      "// original\n");
    let unchanged = JSON.parse(await readFile(join(directory, "example/blueprint.json"), "utf8"));
    assert.equal(unchanged.revision, 1);
  });

  it("rejects extracted files ignored by Git", async () => {
    let directory = await mkdtemp(join(packageRoot, "format-blueprints-test-"));
    temporaryDirectories.push(directory);
    let archivePath = join(directory, ".ignored.gadget");
    await writeArchive(archivePath, 1, new Map([["dist/client.js", "// ignored\n"]]));

    let result = spawnSync(process.execPath,
      [importScript, archivePath, "--new", "example"], {
        cwd: packageRoot,
        env: {...process.env, FORMAT_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(result.status, 1);
    assert.match(result.stderr,
      /imported blueprint paths are ignored by Git: example\/files\/dist\/client\.js/);
    await assert.rejects(readFile(join(directory, "example/blueprint.json")), {code: "ENOENT"});
  });

  it("rejects a generated manifest ignored by Git", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprints-"));
    temporaryDirectories.push(directory);
    let initialized = spawnSync("git", ["init", "-q", directory], {encoding: "utf8"});
    assert.equal(initialized.status, 0, initialized.stderr);
    await writeFile(join(directory, ".gitignore"), "blueprint.json\n");
    let archivePath = join(directory, ".ignored.gadget");
    await writeArchive(archivePath, 1, new Map([["client.js", "// source\n"]]));

    let result = spawnSync(process.execPath,
      [importScript, archivePath, "--new", "example"], {
        cwd: packageRoot,
        env: {...process.env, FORMAT_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(result.status, 1);
    assert.match(result.stderr,
      /imported blueprint paths are ignored by Git: example\/blueprint\.json/);
    await assert.rejects(readFile(join(directory, "example/blueprint.json")), {code: "ENOENT"});
  });

  it("rejects non-portable blueprint directory names", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprints-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "CON", "files"), {recursive: true});
    await writeFile(join(directory, "CON", "blueprint.json"),
      `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(directory, "CON", "files/client.js"), "// source\n");

    let result = spawnSync(process.execPath, [buildScript, "--out", await temporaryOutFile()], {
      cwd: packageRoot,
      env: {...process.env, FORMAT_BLUEPRINTS_DIR: directory},
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /non-portable blueprint file path "CON"/);
  });

  it("rejects duplicate blueprint IDs before adding new source", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprints-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "example", "files"), {recursive: true});
    await writeFile(join(directory, "example", "blueprint.json"),
      `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(directory, "example", "files/client.js"), "// original\n");
    let archivePath = join(directory, ".duplicate.gadget");
    await writeArchive(archivePath, 1, new Map([["client.js", "// duplicate\n"]]));

    let result = spawnSync(process.execPath,
      [importScript, archivePath, "--new", "format.example"], {
        cwd: packageRoot,
        env: {...process.env, FORMAT_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /blueprint ID format\.example is already used by example/);
    await assert.rejects(readFile(join(directory, "format.example/blueprint.json")),
      {code: "ENOENT"});
  });

  it("builds legacy archives and migrates them on import", async () => {
    let directory = await mkdtemp(join(tmpdir(), "format-blueprints-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "example.json"), `${JSON.stringify(presentation, null, 2)}\n`);
    await writeArchive(join(directory, "example.gadget"), 1,
      new Map([["client.js", "// legacy\n"]]));

    let generatedModule = await temporaryOutFile();
    let build = spawnSync(process.execPath, [buildScript, "--out", generatedModule], {
      cwd: packageRoot,
      env: {...process.env, FORMAT_BLUEPRINTS_DIR: directory},
      encoding: "utf8",
    });
    assert.equal(build.status, 0, build.stderr);
    assert.match(await readFile(generatedModule, "utf8"), /"blueprintId": "format\.example"/);

    let incoming = join(directory, ".update.gadget");
    await writeArchive(incoming, 2, new Map([
      ["client.js", "// migrated\n"],
      ["lib/util.js", "// nested\n"],
    ]));
    let imported = spawnSync(process.execPath,
      [importScript, incoming, "format.example", "--out", generatedModule], {
        cwd: packageRoot,
        env: {...process.env, FORMAT_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(await readFile(join(directory, "example/files/client.js"), "utf8"),
      "// migrated\n");
    assert.equal(await readFile(join(directory, "example/files/lib/util.js"), "utf8"),
      "// nested\n");
    await assert.rejects(readFile(join(directory, "example.gadget")), {code: "ENOENT"});
    await assert.rejects(readFile(join(directory, "example.json")), {code: "ENOENT"});
    let migrated = JSON.parse(await readFile(join(directory, "example/blueprint.json"), "utf8"));
    assert.equal(migrated.blueprintId, "format.example");
    assert.equal(migrated.revision, 2);
    assert.equal(migrated.version, 2);
  });
});
