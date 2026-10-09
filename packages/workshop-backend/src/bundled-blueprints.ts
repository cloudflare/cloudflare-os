// Installing the deployment's bundled blueprints, which it then offers as its standard output
// formats.
//
// The reviewable source and its presentation come from a directory chosen at build time (see
// scripts/build-bundled-blueprints.ts), so a deployment ships its own formats by pointing
// BUNDLED_BLUEPRINTS_DIR at its own tree rather than by editing this repo.
//
// Installation writes an ordinary blueprint -- metadata into BLUEPRINTS, a release pack into
// BLUEPRINT_CONTENT -- exactly as publishing does. Nothing downstream knows these are special:
// no reserved id prefix, no fallback branch in the read path. Failure is tolerable: a deployment
// with none installed simply has no standard formats.
//
// One thing does set them apart: a bundled blueprint's releases are not chained. Each is the
// snapshot release of its files (see buildSnapshotRelease()), a parentless commit that depends on
// nothing but those files. So an install never has to read what was installed before it, and
// every deployment that installs the same files installs the same commit.

import { BlueprintMetadata, BlueprintPublicInfo } from "@gadgets/workshop-shared/api";
import { blueprintContentKey } from "./blueprint-archive.js";
import { buildReleasePack, buildSnapshotRelease } from "./blueprint-release.js";
import type { BlueprintKvRecord } from "./storage-schema/blueprints-kv.js";
import { BundledBlueprint, BUNDLED_BLUEPRINTS } from "./generated/bundled-blueprints.js";
import { fingerprint } from "./admin-config.js";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.formats");

type InstallEnv = Pick<Cloudflare.Env, "BLUEPRINTS" | "BLUEPRINT_CONTENT">;

/**
 * Identifies the exact set of bundled blueprints a deployment has installed, and how. Compared
 * with what was installed last time, so any change here triggers reinstallation.
 *
 * Everything that ends up in the installed metadata contributes, not just `revision`: editing a
 * description would otherwise build, deploy, and change nothing on a deployment that had already
 * installed. `contentHash` covers the files, including direct edits to their source, and what
 * the metadata takes from the manifest besides its presentation.
 */
export function bundledBlueprintsManifestVersion(): string {
  return BUNDLED_BLUEPRINTS
      .map(e => `${e.blueprintId}@${e.revision}+${e.contentHash}+` +
          fingerprint(JSON.stringify([e.title, e.description, e.author, e.output])))
      .toSorted()
      .join(",");
}

// Install one bundled blueprint, returning its public info for the featured mirror.
async function installOne(env: InstallEnv, entry: BundledBlueprint)
    : Promise<BlueprintPublicInfo> {
  // Packed the way a published release is, which checks the files against everything a reader
  // will demand of them: a blueprint that installs is one that instantiates.
  let {commitId, objects} = await buildSnapshotRelease(new Map(entry.files));
  let pack = await buildReleasePack(oid => objects.get(oid), commitId);

  let installed: BlueprintMetadata = {
    title: entry.title,
    description: entry.description,
    author: entry.author,
    created: new Date(entry.created),
    version: entry.version,
    lastUpdated: new Date(entry.lastUpdated),
    commitId,
    output: entry.output,
    bindings: entry.bindings,
  };

  // Content first: a blueprint whose metadata exists but whose R2 object doesn't is broken, while
  // the reverse is merely an orphaned object. The key names the commit, so reinstalling the same
  // files rewrites the same bytes, and installing new ones leaves the release they replace
  // where a reader that already holds its metadata will still find it.
  await env.BLUEPRINT_CONTENT.put(blueprintContentKey(entry.blueprintId, installed), pack);

  let kvRecord: BlueprintKvRecord = {metadata: installed};
  await env.BLUEPRINTS.put(entry.blueprintId, JSON.stringify(kvRecord));

  return {id: entry.blueprintId, metadata: installed};
}

/**
 * Install every bundled blueprint, skipping (and logging) any that fail. Returns the public info
 * of those that installed, so the caller can offer them to users.
 */
export async function installBundledBlueprints(env: InstallEnv): Promise<BlueprintPublicInfo[]> {
  let installed: BlueprintPublicInfo[] = [];
  for (let entry of BUNDLED_BLUEPRINTS) {
    try {
      installed.push(await installOne(env, entry));
      logger.info("installed bundled blueprint", {
        event: "formats.install.ok", blueprintId: entry.blueprintId,
      });
    } catch (err) {
      // One bad blueprint must not deny the deployment the others.
      logger.error("failed to install bundled blueprint", {
        event: "formats.install.failed", blueprintId: entry.blueprintId, error: err,
      });
    }
  }
  return installed;
}
