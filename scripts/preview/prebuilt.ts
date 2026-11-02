// Stages a release build (scripts/release/build-release.ts output) as each worker's preview input,
// so `preview.ts deploy --prebuilt <dir>` uploads those bundles as they are instead of building.
//
// This is the bot-preview path in preview.yml: the pull request's own run builds the release with
// no secrets, and a job that holds the preview token, but runs none of the pull request's code,
// deploys it. The release directory arrives as an artifact of that run, so it is untrusted input:
// every module is checked against the SHA-256 the manifest names and every asset against its
// content key, and no name may leave the staging directory.
//
// Measured 2026-11-02: the draft Wrangler this script deploys with (WRANGLER_PACKAGE) created a
// preview from a `no_bundle` config with a prebuilt module.

import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeployablePackage } from "../release/manifest-lib.ts";
import { cfAssetHash, sha256Hex } from "../release/hash-lib.ts";
import { asArray, asObject, asString, isObject, parseJson, type JsonObject } from "../automerge/proofs/json.ts";
import type { StagingConfig } from "./staging-config.ts";

/** Where a worker's staged modules go, relative to its package directory. */
export const PREBUILT_DIR = ".preview-prebuilt";
const PREBUILT_ASSETS_DIR = ".preview-prebuilt-assets";
/** The asset variant previews serve: the frontend built with VITE_CF_ACCESS_MODE=true. */
const ASSET_VARIANT = "access";

const SAFE_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9@._+-]+(?:\/[A-Za-z0-9@._+-]+)*$/;
const RULE_TYPES: Record<string, string> = { esm: "ESModule", text: "Text", wasm: "CompiledWasm", data: "Data" };

/** Reads `<releaseDir>/manifest.json`. */
export function readReleaseManifest(releaseDir: string): JsonObject {
  return asObject(parseJson(readFileSync(join(releaseDir, "manifest.json"), "utf8")), "release manifest");
}

function safePath(value: string, what: string): string {
  if (!SAFE_PATH.test(value)) throw new Error(`${what} is not a safe relative path: ${JSON.stringify(value)}`);
  return value;
}

/**
 * Copies `pkg`'s modules (and the router's assets) out of the release and returns `config`
 * rewritten to upload them unbundled. The custom build is dropped: the bundle is already built.
 */
export function stagePrebuilt(
  pkg: DeployablePackage, config: StagingConfig, releaseDir: string, manifest: JsonObject,
): StagingConfig {
  const worker = asObject(asObject(manifest.workers, "manifest workers")[pkg.name], `manifest worker ${pkg.name}`);
  const modulesDir = join(pkg.dir, PREBUILT_DIR);
  rmSync(modulesDir, { recursive: true, force: true });

  const globs = new Map<string, string[]>();
  for (const entry of asArray(worker.modules, `${pkg.name} modules`)) {
    const module = asObject(entry, `${pkg.name} module`);
    const name = safePath(asString(module.name, "module name"), "module name");
    const sha256 = asString(module.sha256, "module sha256");
    const type = RULE_TYPES[asString(module.type, "module type")];
    if (type === undefined) throw new Error(`${pkg.name}/${name}: module type ${String(module.type)} has no Wrangler rule`);
    const source = join(releaseDir, "modules", safePath(sha256, "module sha256"));
    if (sha256Hex(readFileSync(source)) !== sha256) throw new Error(`${pkg.name}/${name}: bytes do not match the manifest`);
    mkdirSync(dirname(join(modulesDir, name)), { recursive: true });
    copyFileSync(source, join(modulesDir, name));
    globs.set(type, [...globs.get(type) ?? [], name]);
  }
  const main = safePath(asString(worker.mainModule, `${pkg.name} mainModule`), "mainModule");

  const staged: StagingConfig = {
    ...config,
    main: `${PREBUILT_DIR}/${main}`,
    no_bundle: true,
    find_additional_modules: true,
    base_dir: PREBUILT_DIR,
    rules: [...globs].map(([type, names]) => ({ type, globs: names, fallthrough: false })),
  };
  delete staged.build;

  if (isObject(worker.assetsConfig)) {
    const variants = asObject(worker.assetsConfig.variants, `${pkg.name} asset variants`);
    const files = asObject(asObject(variants[ASSET_VARIANT], `${pkg.name} ${ASSET_VARIANT} assets`).manifest,
      `${pkg.name} asset manifest`);
    const assetsDir = join(pkg.dir, PREBUILT_ASSETS_DIR);
    rmSync(assetsDir, { recursive: true, force: true });
    for (const [path, entry] of Object.entries(files)) {
      const relativePath = safePath(path.replace(/^\//, ""), "asset path");
      const hash = safePath(asString(asObject(entry, path).hash, `${path} hash`), "asset hash");
      const source = join(releaseDir, "assets", hash);
      if (cfAssetHash(readFileSync(source), relativePath) !== hash) throw new Error(`${path}: bytes do not match the manifest`);
      mkdirSync(dirname(join(assetsDir, relativePath)), { recursive: true });
      copyFileSync(source, join(assetsDir, relativePath));
    }
    if (!staged.assets) throw new Error(`${pkg.name} serves assets but its preview config has no assets block`);
    staged.assets = { ...staged.assets, directory: PREBUILT_ASSETS_DIR };
  }
  return staged;
}
