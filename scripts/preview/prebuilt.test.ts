import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { cfAssetHash, sha256Hex } from "../release/hash-lib.ts";
import type { DeployablePackage } from "../release/manifest-lib.ts";
import type { JsonObject } from "../automerge/proofs/json.ts";
import { PREBUILT_DIR, readReleaseManifest, stagePrebuilt } from "./prebuilt.ts";
import type { StagingConfig } from "./staging-config.ts";

// A release directory laid out as build-release.ts writes one: `modules/<sha256>`,
// `assets/<content key>` and a manifest naming both. Everything lives under the OS temp directory,
// since the scripts suite must not write inside the workspace.

const ENTRY = "export default { fetch() { return new Response('ok'); } };\n";
const CHUNK = "export const chunk = 1;\n";
const INDEX = "<!doctype html><title>Workshop</title>\n";

let root: string;
let release: string;
let pkg: DeployablePackage;
const config: StagingConfig = {
  name: "router",
  main: "src/index.ts",
  build: { command: "pnpm build" },
  assets: { binding: "ASSETS", directory: "dist" },
};

function writeRelease(modules: { name: string; bytes: string; type?: string }[], assets: Record<string, string>): JsonObject {
  mkdirSync(join(release, "modules"), { recursive: true });
  mkdirSync(join(release, "assets"), { recursive: true });
  const entries = modules.map(({ name, bytes, type = "esm" }) => {
    const sha256 = sha256Hex(Buffer.from(bytes));
    writeFileSync(join(release, "modules", sha256), bytes);
    return { name, type, sha256, size: bytes.length, r2Key: `modules/${sha256}` };
  });
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const [path, bytes] of Object.entries(assets)) {
    const hash = cfAssetHash(Buffer.from(bytes), path.replace(/^\//, ""));
    writeFileSync(join(release, "assets", hash), bytes);
    manifest[path] = { hash, size: bytes.length };
  }
  const document = {
    commit: "0".repeat(40),
    workers: {
      router: {
        kind: "router",
        mainModule: entries[0]?.name ?? "index.js",
        modules: entries,
        assetsConfig: { not_found_handling: "single-page-application", variants: { access: { manifest } } },
      },
    },
  };
  writeFileSync(join(release, "manifest.json"), JSON.stringify(document));
  return readReleaseManifest(release);
}

describe("stagePrebuilt", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prebuilt-test-"));
    release = join(root, "release");
    pkg = { name: "router", dir: join(root, "router"), config: {} };
    mkdirSync(pkg.dir);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("stages every module and asset and points the config at them, unbundled", () => {
    const manifest = writeRelease(
      [{ name: "index.js", bytes: ENTRY }, { name: "chunks/a.js", bytes: CHUNK }],
      { "/index.html": INDEX });
    const staged = stagePrebuilt(pkg, config, release, manifest);

    assert.equal(staged.main, `${PREBUILT_DIR}/index.js`);
    assert.equal(staged.no_bundle, true);
    assert.equal(staged.find_additional_modules, true);
    assert.equal(staged.base_dir, PREBUILT_DIR);
    assert.deepEqual(staged.rules, [{ type: "ESModule", globs: ["index.js", "chunks/a.js"], fallthrough: false }]);
    assert.equal(staged.build, undefined);
    assert.deepEqual(staged.assets, { binding: "ASSETS", directory: ".preview-prebuilt-assets" });
    assert.equal(readFileSync(join(pkg.dir, PREBUILT_DIR, "chunks/a.js"), "utf8"), CHUNK);
    assert.equal(readFileSync(join(pkg.dir, ".preview-prebuilt-assets", "index.html"), "utf8"), INDEX);
  });

  it("rejects a module whose bytes differ from the hash the manifest names", () => {
    const manifest = writeRelease([{ name: "index.js", bytes: ENTRY }], {});
    writeFileSync(join(release, "modules", sha256Hex(Buffer.from(ENTRY))), "export default {};\n");
    assert.throws(() => stagePrebuilt(pkg, config, release, manifest), /router\/index\.js: bytes do not match the manifest/);
  });

  it("rejects an asset whose bytes differ from its content key", () => {
    const manifest = writeRelease([{ name: "index.js", bytes: ENTRY }], { "/index.html": INDEX });
    writeFileSync(join(release, "assets", cfAssetHash(Buffer.from(INDEX), "index.html")), "<script>alert(1)</script>");
    assert.throws(() => stagePrebuilt(pkg, config, release, manifest), /\/index\.html: bytes do not match the manifest/);
  });

  for (const name of ["../escape.js", "a/../../escape.js", "/abs.js", "./index.js"]) {
    it(`rejects the module name ${name}`, () => {
      const manifest = writeRelease([{ name, bytes: ENTRY }], {});
      assert.throws(() => stagePrebuilt(pkg, config, release, manifest), /module name is not a safe relative path/);
    });
  }

  it("rejects an asset path that leaves the staging directory", () => {
    const manifest = writeRelease([{ name: "index.js", bytes: ENTRY }], { "/../escape.html": INDEX });
    assert.throws(() => stagePrebuilt(pkg, config, release, manifest), /asset path is not a safe relative path/);
  });

  it("rejects a module type Wrangler has no rule for", () => {
    const manifest = writeRelease([{ name: "index.js", bytes: ENTRY, type: "python" }], {});
    assert.throws(() => stagePrebuilt(pkg, config, release, manifest), /module type python has no Wrangler rule/);
  });

  it("rejects a release that has no entry for the worker", () => {
    const manifest = writeRelease([{ name: "index.js", bytes: ENTRY }], {});
    assert.throws(() => stagePrebuilt({ ...pkg, name: "gatekeeper-x" }, config, release, manifest), /manifest worker gatekeeper-x/);
  });
});
