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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, {recursive: true, force: true})));
});

describe("format blueprint generator", () => {
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
    // Restore the default generated module because the generator has one fixed output path.
    let restore = spawnSync(process.execPath, [buildScript], {
      cwd: packageRoot,
      env: Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => key !== "FORMAT_BLUEPRINTS_DIR")),
      encoding: "utf8",
    });
    assert.equal(restore.status, 0, restore.stderr);
    assert.match(await readFile(join(packageRoot, "src/generated/format-blueprints.ts"), "utf8"),
      /format\.document/);
  });
});
