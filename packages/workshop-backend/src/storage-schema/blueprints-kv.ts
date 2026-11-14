// The BLUEPRINTS Workers KV namespace's schema: what each key holds, and the helpers that parse
// and read it.
//
// The namespace is the deployment-wide lookup store for published blueprints (see
// docs/blueprints.md), plus two reserved keys that mirror state owned by the AdminSettings
// Durable Object so that hot paths can read it with one KV get. Every value is a JSON string:
//
//   <blueprintId>   A BlueprintKvRecord. Written when a workspace publishes a blueprint
//                   (Overseer's propagateBlueprint), when a user imports an archive (server.ts),
//                   and when the deployment installs its bundled blueprints
//                   (bundled-blueprints.ts).
//   .featured       The featured blueprints, a BlueprintPublicInfo[]. Written only by
//                   AdminSettings.
//   .adminConfig    The deployment's AdminConfig (see admin-settings-storage.ts). Written only by
//                   AdminSettings; the code that normalizes, serializes and reads it lives in
//                   admin-config.ts.
//
// Unlike the Durable Object schemas beside this file, the namespace has several writers and no
// migration step, so a change here must leave the values already stored readable.
//
// This file has no runtime dependency on any other backend module, so any of them may import it
// without creating a cycle.

import type { BlueprintMetadata, BlueprintPublicInfo } from "@gadgets/workshop-shared/api";

/** Reserved key holding the featured blueprints (see parseFeaturedBlueprints). */
export const FEATURED_BLUEPRINTS_KEY = '.featured';

/**
 * Reserved key holding the deployment-wide admin config (a single JSON object), mirrored here by
 * AdminSettings; see admin-config.ts.
 */
export const ADMIN_CONFIG_KEY = '.adminConfig';

/**
 * Whether `id` is one of the namespace's reserved keys rather than a blueprint's. Blueprint ids
 * can arrive from clients, so anything that reads or deletes a record under a caller-supplied
 * id must refuse these first. (readBlueprintKvRecord does.)
 */
export function isReservedBlueprintKey(id: string): boolean {
  return id === FEATURED_BLUEPRINTS_KEY || id === ADMIN_CONFIG_KEY;
}

/** A blueprint's record, stored under its id. */
export type BlueprintKvRecord = {
  metadata: BlueprintMetadata;
  /**
   * The User DO that published or uploaded this blueprint, and which owns the authoritative
   * "featured" bit for it. Undefined for a blueprint the deployment installed itself, which
   * has no owning user.
   */
  ownerId?: string;
  gadgetId?: string;  // undefined = uploaded, not published from a gadget on this instance
};

/**
 * Restore the Dates in blueprint metadata that has been through JSON, in place. Also used for the
 * metadata section of a `.gadget` archive (see blueprint-archive.ts), which is the same JSON.
 */
export function reviveBlueprintMetadata(metadata: BlueprintMetadata): BlueprintMetadata {
  metadata.created = new Date(metadata.created);
  metadata.lastUpdated = new Date(metadata.lastUpdated);
  return metadata;
}

export function parseBlueprintKvRecord(raw: string): BlueprintKvRecord {
  let kvRecord = JSON.parse(raw) as BlueprintKvRecord;
  kvRecord.metadata = reviveBlueprintMetadata(kvRecord.metadata);
  return kvRecord;
}

export function parseFeaturedBlueprints(raw: string): BlueprintPublicInfo[] {
  let featured = JSON.parse(raw) as BlueprintPublicInfo[];
  for (let entry of featured) {
    entry.metadata = reviveBlueprintMetadata(entry.metadata);
  }
  return featured;
}

export function serializeFeaturedBlueprints(featured: BlueprintPublicInfo[]): string {
  return JSON.stringify(featured);
}

/**
 * The env a blueprint KV read needs. Narrowed to the one binding so helpers that only read
 * blueprints can be called from anywhere holding it, without passing a whole env around.
 */
export type BlueprintKvEnv = Pick<Cloudflare.Env, 'BLUEPRINTS'>;

export async function readBlueprintKvRecord(
  env: BlueprintKvEnv,
  blueprintId: string,
): Promise<BlueprintKvRecord | null> {
  if (isReservedBlueprintKey(blueprintId)) {
    return null;
  }

  let raw = await env.BLUEPRINTS.get(blueprintId);
  if (!raw) {
    return null;
  }

  return parseBlueprintKvRecord(raw);
}

export async function listFeaturedBlueprintsFromKv(
  env: BlueprintKvEnv,
): Promise<BlueprintPublicInfo[]> {
  let raw = await env.BLUEPRINTS.get(FEATURED_BLUEPRINTS_KEY);
  if (!raw) {
    return [];
  }

  return parseFeaturedBlueprints(raw);
}
