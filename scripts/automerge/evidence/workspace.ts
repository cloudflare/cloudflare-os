// Which deployable Workers a pull request can change. A Worker is a package with a
// `wrangler.jsonc`. It changes when a file in its own package changes, when a workspace package it
// depends on changes (through `workspace:` specifiers, transitively), or when a package whose files
// it serves as static assets changes (the router serves workshop-frontend's `dist`). A change
// outside `packages/` that is not documentation or CI configuration can reach any build (the
// lockfile, the root tsconfig, the build scripts), so it selects every Worker.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { asObject, isObject, parseJson, parseJsonc, type JsonObject } from "../proofs/json.ts";

/** One workspace package under `packages/`. */
export interface WorkspacePackage {
  /** The directory name under `packages/`. */
  dir: string;
  /** The `name` in its package.json. */
  name: string;
  /** Names of the workspace packages it depends on through `workspace:` specifiers. */
  workspaceDeps: string[];
  /** Whether it has a `wrangler.jsonc`, which makes it a deployable Worker. */
  deployable: boolean;
  /** Directory names under `packages/` whose files its Wrangler `assets.directory` serves. */
  assetPackages: string[];
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
/** Changes outside `packages/` that no build reads. */
const NO_BUILD_INPUT = /^(\.github\/|docs\/|\.agents\/|\.opencode\/)|(^|\/)[^/]+\.md$/;

/** The workspace dependency names in a package.json's dependency fields. */
export function workspaceDependencies(manifest: JsonObject): string[] {
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (!isObject(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) names.add(name);
    }
  }
  return [...names].toSorted();
}

/** The package directory names a Wrangler config's `assets.directory` points into. */
export function assetPackages(dir: string, wrangler: JsonObject): string[] {
  const assets = wrangler.assets;
  if (!isObject(assets) || typeof assets.directory !== "string") return [];
  const target = normalize(join("packages", dir, assets.directory));
  const match = /^packages\/([^/]+)/.exec(target);
  return match && match[1] !== dir ? [match[1]] : [];
}

/** Reads every package under `<root>/packages`. */
export function readWorkspace(root: string): WorkspacePackage[] {
  const packagesDir = join(root, "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, "package.json")))
    .map((entry) => entry.name)
    .toSorted()
    .map((dir) => {
      const manifest = asObject(parseJson(readFileSync(join(packagesDir, dir, "package.json"), "utf8")), `${dir}/package.json`);
      const wranglerPath = join(packagesDir, dir, "wrangler.jsonc");
      const deployable = existsSync(wranglerPath);
      const wrangler = deployable ? asObject(parseJsonc(readFileSync(wranglerPath, "utf8")), `${dir}/wrangler.jsonc`) : {};
      return {
        dir,
        name: typeof manifest.name === "string" ? manifest.name : dir,
        workspaceDeps: workspaceDependencies(manifest),
        deployable,
        assetPackages: assetPackages(dir, wrangler),
      };
    });
}

/** The deployable package directory names the changed paths can affect, sorted. */
export function affectedDeployables(packages: WorkspacePackage[], changedPaths: string[]): string[] {
  const deployables = packages.filter((pkg) => pkg.deployable).map((pkg) => pkg.dir);
  const touched = new Set<string>();
  for (const path of changedPaths) {
    const match = /^packages\/([^/]+)\/(.+)$/.exec(path);
    if (match) {
      // Package-local Markdown can ship (bundled blueprints' files), so every package file counts.
      touched.add(match[1]);
    } else if (!NO_BUILD_INPUT.test(path)) {
      return deployables;
    }
  }
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg.dir]));
  const inputs = new Map(packages.map((pkg) => [pkg.dir, [
    ...pkg.workspaceDeps.flatMap((name) => byName.get(name) ?? []), ...pkg.assetPackages,
  ]]));
  const reaches = (dir: string, seen: Set<string>): boolean => {
    if (touched.has(dir)) return true;
    if (seen.has(dir)) return false;
    seen.add(dir);
    return (inputs.get(dir) ?? []).some((input) => reaches(input, seen));
  };
  return deployables.filter((dir) => reaches(dir, new Set()));
}
