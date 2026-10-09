import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, symlink, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildSnapshotContent,
  serializeArchive,
} from "../packages/bundled-blueprints/__tests__/archives.ts";

const temporaryDirectories: string[] = [];
const workspaceRoot = join(import.meta.dirname, "..");
const packageRoot = join(workspaceRoot, "packages/workshop-backend");
const buildScript = join(packageRoot, "scripts/build-bundled-blueprints.ts");
const importScript = join(packageRoot, "scripts/import-bundled-blueprint.ts");

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

/** The metadata of an export of the example blueprint at `version`. */
function exportMetadata(version: number) {
  return {
    title: manifest.title,
    description: manifest.description,
    author: manifest.author,
    created: manifest.created,
    version,
    lastUpdated: manifest.lastUpdated,
    bindings: manifest.bindings,
  };
}

/** Writes a version 1 archive: the export of a blueprint stored as a snapshot of its files. */
async function writeArchive(
  path: string,
  version: number,
  files: Map<string, string>,
): Promise<void> {
  await writeFile(path, serializeArchive(1, exportMetadata(version), buildSnapshotContent(files)));
}

function git(repository: string, args: string[], input?: string): string {
  let result = spawnSync("git", ["-C", repository, "-c", "user.name=Test",
    "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    {input, encoding: "buffer"});
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout.toString("latin1");
}

/**
 * Builds what a version 2 archive holds, with git itself: a pack of a release commit of `files`,
 * and the commit's id. As in a Workshop's own packs, the release has an earlier release for a
 * `parent`, whose commit is in the pack and whose tree is not. `prepare` may change the working
 * tree before the release is committed.
 */
async function buildRelease(
  files: Map<string, string>,
  prepare: (repository: string) => Promise<void> = async () => {},
): Promise<{commitId: string; parent: string; pack: Uint8Array}> {
  let repository = await mkdtemp(join(tmpdir(), "bundled-blueprints-release-"));
  temporaryDirectories.push(repository);
  git(repository, ["init", "-q"]);
  await writeFile(join(repository, "earlier.js"), "// an earlier release\n");
  git(repository, ["add", "-A", "-f"]);
  git(repository, ["commit", "-q", "-m", "Release 1: Example"]);
  let parent = git(repository, ["rev-parse", "HEAD"]).trim();

  await rm(join(repository, "earlier.js"));
  for (let [path, source] of files) {
    await mkdir(dirname(join(repository, path)), {recursive: true});
    await writeFile(join(repository, path), source);
  }
  await prepare(repository);
  git(repository, ["add", "-A", "-f"]);
  git(repository, ["commit", "-q", "-m", "Release 2: Example"]);
  let commitId = git(repository, ["rev-parse", "HEAD"]).trim();

  // Both commits, and the whole of the newer one's tree.
  let tree = git(repository, ["rev-parse", "HEAD^{tree}"]).trim();
  let beneath = git(repository, ["ls-tree", "-r", "-t", "-z", "HEAD"]).split("\0").filter(Boolean)
    .map(record => record.split("\t")[0]!.split(" ")[2]!);
  let objects = [commitId, parent, tree, ...beneath];
  let pack = spawnSync("git", ["-C", repository, "pack-objects", "--stdout", "-q"],
    {input: `${objects.join("\n")}\n`});
  assert.equal(pack.status, 0, pack.stderr.toString());
  return {commitId, parent, pack: pack.stdout};
}

/** Writes a version 2 archive: the export of a blueprint whose content is a release pack. */
async function writeReleaseArchive(
  path: string,
  version: number,
  files: Map<string, string>,
): Promise<void> {
  let {commitId, pack} = await buildRelease(files);
  await writeFile(path, serializeArchive(2, {...exportMetadata(version), commitId}, pack));
}

/** One entry of a generated module's `BUNDLED_BLUEPRINTS`, as far as these tests read it. */
type GeneratedBlueprint = typeof manifest & {
  contentHash: string;
  files: Array<[path: string, text: string]>;
};

/** Runs the generator over `directory` and returns the blueprints in the module it wrote. */
async function generate(directory: string): Promise<GeneratedBlueprint[]> {
  let generatedModule = await temporaryOutFile();
  let build = spawnSync(process.execPath, [buildScript, "--out", generatedModule], {
    cwd: packageRoot,
    env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
    encoding: "utf8",
  });
  assert.equal(build.status, 0, build.stderr);
  // Node strips the module's types, which takes its one import with them.
  let generated = await import(pathToFileURL(generatedModule).href);
  return generated.BUNDLED_BLUEPRINTS;
}

// Throwaway output for the generator. Its default is
// `packages/workshop-backend/src/generated/bundled-blueprints.ts` -- the module that package
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
// succeed -- import-bundled-blueprint.ts regenerates the module in-process when it finishes, and
// forwards `--out` to do it. The `importScript` spawns that assert `status === 1` exit before
// reaching that point, so they need nothing; if one ever stopped failing, its own assertion is
// what catches it.
//
// A directory of its own rather than the fixture directory the generator is reading: both scripts
// reject unexpected files in a blueprint directory, so the output must not land in the set being
// scanned.
async function temporaryOutFile(): Promise<string> {
  let directory = await mkdtemp(join(tmpdir(), "bundled-blueprints-out-"));
  temporaryDirectories.push(directory);
  return join(directory, "bundled-blueprints.ts");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path =>
    rm(path, {recursive: true, force: true})));
});

describe("bundled blueprint scripts", () => {
  it("generates each blueprint's manifest and files, and fingerprints what it installs",
      async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprints-"));
    temporaryDirectories.push(directory);
    let bindings = {MODEL: {type: "aiModel", title: "Model", description: ""}};
    let source = {...manifest, version: 3, bindings};
    let writeManifest = (changes: object) => writeFile(join(directory, "example/blueprint.json"),
      `${JSON.stringify({...source, ...changes}, null, 2)}\n`);
    await mkdir(join(directory, "example", "files", "lib"), {recursive: true});
    await writeManifest({});
    await writeFile(join(directory, "example/files/server.js"), "// server\n");
    await writeFile(join(directory, "example/files/lib/util.js"), "// util\n");
    await writeFile(join(directory, "example/files/client.js"), "// client\n");

    let [blueprint, ...others] = await generate(directory);

    assert.deepEqual(others, []);
    let {contentHash, files, ...rest} = blueprint!;
    assert.deepEqual(rest, source);
    assert.deepEqual(files, [
      ["client.js", "// client\n"],
      ["lib/util.js", "// util\n"],
      ["server.js", "// server\n"],
    ]);
    assert.match(contentHash, /^[0-9a-f]{64}$/);
    assert.equal((await generate(directory))[0]!.contentHash, contentHash);

    // The fingerprint follows the files and what else of the manifest is installed with them.
    // Presentation is the exception: the installer fingerprints that for itself.
    await writeManifest({title: "Renamed"});
    assert.equal((await generate(directory))[0]!.contentHash, contentHash);
    for (let changes of [{version: 4}, {bindings: {}}, {lastUpdated: "2026-02-02T00:00:00.000Z"}]) {
      await writeManifest(changes);
      assert.notEqual((await generate(directory))[0]!.contentHash, contentHash);
    }
    await writeManifest({});
    await writeFile(join(directory, "example/files/lib/util.js"), "// edited\n");
    assert.notEqual((await generate(directory))[0]!.contentHash, contentHash);
  });

  it("ignores dot-prefixed files and interrupted-import directories", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprints-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, ".DS_Store"), "ignored");
    await mkdir(join(directory, ".example.import-123", "files"), {recursive: true});
    await writeFile(join(directory, ".example.import-123", "blueprint.json"), "not JSON");

    let result = spawnSync(process.execPath, [buildScript, "--out", await temporaryOutFile()], {
      cwd: packageRoot,
      env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /No blueprint directories/);
  });

  it("ignores hidden duplicate manifests when importing an update", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprints-"));
    temporaryDirectories.push(directory);
    // Two hidden backups: one from a process that has exited, one from this process, standing in
    // for an import still running beside the one under test.
    let exited = spawnSync(process.execPath, ["-e", ""], {encoding: "utf8"});
    assert.equal(exited.status, 0, exited.stderr);
    let dead = `.example.backup-${exited.pid}`;
    let running = `.example.backup-${process.pid}`;
    for (let name of ["example", dead, running]) {
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
        env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(directory, "example/files/client.js"), "utf8"), "// updated\n");
    assert.equal(await readFile(join(directory, "example/files/lib/util.js"), "utf8"),
      "// updated util\n");
    // Neither backup counted as a duplicate; the completed import removed the dead process's and
    // left the live one, whose import may still need it to restore.
    assert.deepEqual((await readdir(directory)).toSorted(), [running, ".update.gadget", "example"]);
    let updatedManifest = JSON.parse(await readFile(join(directory, "example/blueprint.json"), "utf8"));
    assert.equal(updatedManifest.revision, 2);
    assert.equal(updatedManifest.version, 2);
  });

  it("refuses an export whose files the build rejects, before replacing anything", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprints-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "example", "files"), {recursive: true});
    await writeFile(join(directory, "example", "blueprint.json"),
      `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(directory, "example", "files/client.js"), "// old\n");

    // A JavaScript module beside TypeScript is one thing the staged build refuses.
    let archivePath = join(directory, ".update.gadget");
    await writeArchive(archivePath, 2, new Map([
      ["client.ts", "export {};\n"],
      ["client.js", "// shipped\n"],
    ]));

    let result = spawnSync(process.execPath,
      [importScript, archivePath, "format.example", "--out", await temporaryOutFile()], {
        cwd: packageRoot,
        env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /client\.js is a JavaScript module in a TypeScript blueprint/);
    assert.equal(await readFile(join(directory, "example/files/client.js"), "utf8"), "// old\n");
    // No staged or backup directory survives the refusal.
    assert.deepEqual((await readdir(directory)).toSorted(), [".update.gadget", "example"]);
  });

  it("keeps what lives beside blueprint.json and files/ when importing an update", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprints-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "example", "files", "lib"), {recursive: true});
    await writeFile(join(directory, "example", "blueprint.json"),
      `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(directory, "example", "files/client.js"), "// old\n");
    await writeFile(join(directory, "example", "files/lib/util.js"), "// old util\n");
    // Repo-only siblings the archive never carries.
    let test = 'import { greet } from "../files/lib/greeting.ts";\n';
    let notes = "# Notes\n\nNot part of the archive.\n";
    await mkdir(join(directory, "example", "__tests__"));
    await writeFile(join(directory, "example", "__tests__/greeting.test.ts"), test);
    await writeFile(join(directory, "example", "NOTES.md"), notes);
    await symlink("../NOTES.md", join(directory, "example", "__tests__/notes.md"));

    let archivePath = join(directory, ".update.gadget");
    await writeArchive(archivePath, 2, new Map([["client.js", "// updated\n"]]));

    let result = spawnSync(process.execPath,
      [importScript, archivePath, "format.example", "--out", await temporaryOutFile()], {
        cwd: packageRoot,
        env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(directory, "example/__tests__/greeting.test.ts"), "utf8"), test);
    assert.equal(await readFile(join(directory, "example/NOTES.md"), "utf8"), notes);
    // Copied as written, not resolved to this checkout's absolute path. Windows stores the target
    // with backslashes.
    assert.equal(await readlink(join(directory, "example/__tests__/notes.md")),
      normalize("../NOTES.md"));
    assert.deepEqual((await readdir(join(directory, "example"))).toSorted(),
      ["NOTES.md", "__tests__", "blueprint.json", "files"]);
    // files/ holds exactly the archive's files: the old lib/util.js is gone.
    assert.deepEqual(await readdir(join(directory, "example/files")), ["client.js"]);
    assert.equal(await readFile(join(directory, "example/files/client.js"), "utf8"), "// updated\n");
  });

  it("imports a version 2 export, whose content is a git pack", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprints-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "example", "files", "lib"), {recursive: true});
    await writeFile(join(directory, "example", "blueprint.json"),
      `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(directory, "example", "files/client.js"), "// old\n");
    await writeFile(join(directory, "example", "files/lib/util.js"), "// old util\n");

    let files = new Map([
      ["README.md", "\ufeff# Kept, mark and all\n"],
      ["client.js", "// updated\n"],
      ["lib/deep/util.js", "// nested\n"],
    ]);
    let archivePath = join(directory, ".update.gadget");
    await writeReleaseArchive(archivePath, 2, files);

    let result = spawnSync(process.execPath,
      [importScript, archivePath, "format.example", "--out", await temporaryOutFile()], {
        cwd: packageRoot,
        env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /release +[0-9a-f]{40} /);
    let updated = JSON.parse(await readFile(join(directory, "example/blueprint.json"), "utf8"));
    assert.equal(updated.revision, 2);
    assert.equal(updated.version, 2);
    // Exactly the release's files: none of what it replaced, and nothing of the earlier release
    // in the pack's history.
    let [blueprint] = await generate(directory);
    assert.deepEqual(blueprint!.files, [...files]);
    assert.deepEqual((await readdir(join(directory, "example/files"))).toSorted(),
      ["README.md", "client.js", "lib"]);
    assert.deepEqual(await readdir(join(directory, "example/files/lib")), ["deep"]);
  });

  it("refuses a version 2 export it cannot read a release from, before replacing anything",
      async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprints-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "example", "files"), {recursive: true});
    await writeFile(join(directory, "example", "blueprint.json"),
      `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(directory, "example", "files/client.js"), "// old\n");

    let files = new Map([["client.js", "// updated\n"]]);
    let release = await buildRelease(files);
    let executable = await buildRelease(new Map([...files, ["run.sh", "#!/bin/sh\n"]]),
      repository => chmod(join(repository, "run.sh"), 0o755));
    let metadata = exportMetadata(2);
    let archivePath = join(directory, ".update.gadget");
    for (let [archive, error] of [
      [serializeArchive(2, metadata, release.pack), /does not name the release commit/],
      [serializeArchive(2, {...metadata, commitId: "main"}, release.pack),
        /does not name the release commit/],
      // A commit the pack does not hold, and one it holds without its files.
      [serializeArchive(2, {...metadata, commitId: "a".repeat(40)}, release.pack),
        /git ls-tree .* failed: /],
      [serializeArchive(2, {...metadata, commitId: release.parent}, release.pack),
        /git ls-tree .* failed: /],
      [serializeArchive(2, {...metadata, commitId: release.commitId},
        new TextEncoder().encode("not a pack")), /git unpack-objects .* failed: /],
      [serializeArchive(2, {...metadata, commitId: executable.commitId}, executable.pack),
        /run\.sh is not a plain file \(mode 100755\)/],
    ] as const) {
      await writeFile(archivePath, archive);

      let result = spawnSync(process.execPath, [importScript, archivePath, "format.example"], {
        cwd: packageRoot,
        env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, error);
      assert.equal(await readFile(join(directory, "example/files/client.js"), "utf8"), "// old\n");
      assert.deepEqual((await readdir(directory)).toSorted(), [".update.gadget", "example"]);
    }
  });

  it("builds and recovers a blueprint left only in an interrupted-import backup", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprints-"));
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
      env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
      encoding: "utf8",
    });
    assert.equal(build.status, 0, build.stderr);
    assert.match(await readFile(generatedModule, "utf8"), /"blueprintId": "format\.example"/);

    let archivePath = join(directory, ".update.gadget");
    await writeArchive(archivePath, 2, new Map([["client.js", "// recovered\n"]]));
    let imported = spawnSync(process.execPath,
      [importScript, archivePath, "format.example", "--out", generatedModule], {
        cwd: packageRoot,
        env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(await readFile(join(directory, name, "files/client.js"), "utf8"),
      "// recovered\n");
    await assert.rejects(readFile(join(directory, `.${name}.backup-123/blueprint.json`)),
      {code: "ENOENT"});
  });

  it("rejects dot-prefixed new blueprint names", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprints-"));
    temporaryDirectories.push(directory);

    let result = spawnSync(process.execPath,
      [importScript, join(directory, "missing.gadget"), "--new", ".hidden"], {
        cwd: packageRoot,
        env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /name must start with an alphanumeric character/);
  });

  it("rejects manifest fields that override the trusted directory name", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprints-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "example", "files"), {recursive: true});
    await writeFile(join(directory, "example", "blueprint.json"),
      `${JSON.stringify({...manifest, name: "../victim"}, null, 2)}\n`);
    await writeFile(join(directory, "example", "files/client.js"), "// original\n");

    let result = spawnSync(process.execPath,
      [importScript, join(directory, "missing.gadget"), "format.example"], {
        cwd: packageRoot,
        env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown keys: name/);
    assert.equal(await readFile(join(directory, "example/files/client.js"), "utf8"),
      "// original\n");
  });

  it("validates imported metadata before replacing existing source", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprints-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "example", "files"), {recursive: true});
    await writeFile(join(directory, "example", "blueprint.json"),
      `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(directory, "example", "files/client.js"), "// original\n");
    let archivePath = join(directory, ".invalid.gadget");
    await writeFile(archivePath, serializeArchive(1, {},
      buildSnapshotContent(new Map([["client.js", "// invalid\n"]]))));

    let result = spawnSync(process.execPath, [importScript, archivePath, "format.example"], {
      cwd: packageRoot,
      env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
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
    let directory = await mkdtemp(join(packageRoot, "bundled-blueprints-test-"));
    temporaryDirectories.push(directory);
    let archivePath = join(directory, ".ignored.gadget");
    await writeArchive(archivePath, 1, new Map([["dist/client.js", "// ignored\n"]]));

    let result = spawnSync(process.execPath,
      [importScript, archivePath, "--new", "example"], {
        cwd: packageRoot,
        env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(result.status, 1);
    assert.match(result.stderr,
      /imported blueprint paths are ignored by Git: example[\\/]files[\\/]dist[\\/]client\.js/);
    await assert.rejects(readFile(join(directory, "example/blueprint.json")), {code: "ENOENT"});
  });

  it("rejects a generated manifest ignored by Git", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprints-"));
    temporaryDirectories.push(directory);
    let initialized = spawnSync("git", ["init", "-q", directory], {encoding: "utf8"});
    assert.equal(initialized.status, 0, initialized.stderr);
    await writeFile(join(directory, ".gitignore"), "blueprint.json\n");
    let archivePath = join(directory, ".ignored.gadget");
    await writeArchive(archivePath, 1, new Map([["client.js", "// source\n"]]));

    let result = spawnSync(process.execPath,
      [importScript, archivePath, "--new", "example"], {
        cwd: packageRoot,
        env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(result.status, 1);
    assert.match(result.stderr,
      /imported blueprint paths are ignored by Git: example[\\/]blueprint\.json/);
    await assert.rejects(readFile(join(directory, "example/blueprint.json")), {code: "ENOENT"});
  });

  it("rejects non-portable blueprint directory names", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprints-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "CON", "files"), {recursive: true});
    await writeFile(join(directory, "CON", "blueprint.json"),
      `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(directory, "CON", "files/client.js"), "// source\n");

    let result = spawnSync(process.execPath, [buildScript, "--out", await temporaryOutFile()], {
      cwd: packageRoot,
      env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /non-portable blueprint file path "CON"/);
  });

  it("rejects duplicate blueprint IDs before adding new source", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprints-"));
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
        env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /blueprint ID format\.example is already used by example/);
    await assert.rejects(readFile(join(directory, "format.example/blueprint.json")),
      {code: "ENOENT"});
  });

  it("builds legacy archives and migrates them on import", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprints-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "example.json"), `${JSON.stringify(presentation, null, 2)}\n`);
    await writeArchive(join(directory, "example.gadget"), 1,
      new Map([["client.js", "// legacy\n"]]));

    // The archive supplies the files, and the part of the manifest its metadata holds.
    let [legacy] = await generate(directory);
    let {contentHash, files: legacyFiles, ...legacyManifest} = legacy!;
    assert.deepEqual(legacyManifest, manifest);
    assert.deepEqual(legacyFiles, [["client.js", "// legacy\n"]]);
    assert.match(contentHash, /^[0-9a-f]{64}$/);

    let incoming = join(directory, ".update.gadget");
    await writeArchive(incoming, 2, new Map([
      ["client.js", "// migrated\n"],
      ["lib/util.js", "// nested\n"],
    ]));
    let imported = spawnSync(process.execPath,
      [importScript, incoming, "format.example", "--out", await temporaryOutFile()], {
        cwd: packageRoot,
        env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
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

  // The legacy layout holds the archives it always did. A newer export put in a legacy archive's
  // place is refused by the build, and importing it is what moves the blueprint on.
  it("refuses a version 2 archive in the legacy layout, and migrates it on import", async () => {
    let directory = await mkdtemp(join(tmpdir(), "bundled-blueprints-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "example.json"), `${JSON.stringify(presentation, null, 2)}\n`);
    let archivePath = join(directory, "example.gadget");
    await writeReleaseArchive(archivePath, 2, new Map([["client.js", "// release\n"]]));

    let build = spawnSync(process.execPath, [buildScript, "--out", await temporaryOutFile()], {
      cwd: packageRoot,
      env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
      encoding: "utf8",
    });
    assert.equal(build.status, 1);
    assert.match(build.stderr, /example\.gadget is a version 2 archive/);
    assert.match(build.stderr, /pnpm import:bundled-blueprint/);

    let imported = spawnSync(process.execPath,
      [importScript, archivePath, "format.example", "--out", await temporaryOutFile()], {
        cwd: packageRoot,
        env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
        encoding: "utf8",
      });

    assert.equal(imported.status, 0, imported.stderr);
    assert.deepEqual(await readdir(directory), ["example"]);
    let [blueprint] = await generate(directory);
    assert.equal(blueprint!.version, 2);
    assert.deepEqual(blueprint!.files, [["client.js", "// release\n"]]);
  });
});
