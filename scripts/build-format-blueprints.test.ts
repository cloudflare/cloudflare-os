import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const temporaryDirectories: string[] = [];
const workspaceRoot = join(import.meta.dirname, "..");
const packageRoot = join(workspaceRoot, "packages/workshop-backend");
const buildScript = join(packageRoot, "scripts/build-format-blueprints.ts");
const importScript = join(packageRoot, "scripts/import-format-blueprint.ts");

async function restoreGeneratedModule(): Promise<void> {
  let restore = spawnSync(process.execPath, [buildScript], {
    cwd: packageRoot,
    env: Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => key !== "FORMAT_BLUEPRINTS_DIR")),
    encoding: "utf8",
  });
  assert.equal(restore.status, 0, restore.stderr);
}

afterEach(async () => {
  await restoreGeneratedModule();
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

    let result = spawnSync(process.execPath, [buildScript], {
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
    let manifest = {
      blueprintId: "format.example",
      title: "Example",
      description: "An example format.",
      output: {id: "example", noun: "Example", plural: "Examples", icon: "appWindow"},
      author: {type: "user", name: "Test", id: "test@example.com"},
      revision: 1,
      created: "2026-01-01T00:00:00.000Z",
      version: 1,
      lastUpdated: "2026-01-01T00:00:00.000Z",
      bindings: {},
    };
    for (let name of ["example", ".example.backup-123"]) {
      await mkdir(join(directory, name, "files"), {recursive: true});
      await writeFile(join(directory, name, "blueprint.json"),
        `${JSON.stringify(manifest, null, 2)}\n`);
      await writeFile(join(directory, name, "files/client.js"), `// old ${name}\n`);
    }

    let archivePath = join(directory, ".update.gadget");
    let archiveScript = `
      import {buildContent, serializeArchive} from ${JSON.stringify(
        join(packageRoot, "scripts/format-blueprint-files.ts"))};
      import {writeFile} from "node:fs/promises";
      const content = buildContent(new Map([["client.js", "// updated\\n"]]), "update");
      const metadata = ${JSON.stringify({...manifest, version: 2, revision: undefined})};
      await writeFile(${JSON.stringify(archivePath)}, serializeArchive(metadata, content, "update"));
    `;
    let makeArchive = spawnSync(process.execPath, ["--input-type=module", "--eval", archiveScript], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    assert.equal(makeArchive.status, 0, makeArchive.stderr);

    let result = spawnSync(process.execPath, [importScript, archivePath, "format.example"], {
      cwd: packageRoot,
      env: {...process.env, FORMAT_BLUEPRINTS_DIR: directory},
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(directory, "example/files/client.js"), "utf8"), "// updated\n");
    assert.equal(await readFile(join(directory, ".example.backup-123/files/client.js"), "utf8"),
      "// old .example.backup-123\n");
    let updatedManifest = JSON.parse(await readFile(join(directory, "example/blueprint.json"), "utf8"));
    assert.equal(updatedManifest.revision, 2);
    assert.equal(updatedManifest.version, 2);
  });
});
