import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BlueprintMetadata } from "@gadgets/workshop-shared/api";
import type { AdminSettings } from "../src/admin-settings.js";
import { FEATURED_BLUEPRINTS_KEY, parseFeaturedBlueprints } from "../src/blueprint-archive.js";
import type { UserDurableObject } from "../src/user.js";

function metadata(version: number, updatedAt: number): BlueprintMetadata {
  return {
    title: `Blueprint ${version}`,
    description: "",
    author: {type: "user", id: "owner@example.com", name: "Owner"},
    created: new Date(1),
    version,
    lastUpdated: new Date(updatedAt),
    bindings: {},
  };
}

async function featuredIds(): Promise<Map<string, BlueprintMetadata>> {
  let raw = await env.BLUEPRINTS.get(FEATURED_BLUEPRINTS_KEY);
  return new Map((raw ? parseFeaturedBlueprints(raw) : []).map(entry => [entry.id, entry.metadata]));
}

async function createOwner(): Promise<{
  admin: DurableObjectStub<AdminSettings>;
  owner: DurableObjectStub<UserDurableObject>;
  ownerId: DurableObjectId;
  workspaceId: string;
}> {
  let username = `featured-owner-${crypto.randomUUID()}@example.com`;
  let ownerId = exports.UserDurableObject.idFromName(username);
  let owner = exports.UserDurableObject.get(ownerId);
  await owner.createAccount(username, "Owner", new Uint8Array([1, 2, 3]));
  return {
    admin: exports.AdminSettings.getByName(""),
    owner,
    ownerId,
    workspaceId: crypto.randomUUID(),
  };
}

async function publishBlueprint(
  owner: DurableObjectStub<UserDurableObject>,
  ownerId: DurableObjectId,
  blueprintId: string,
  metadata: BlueprintMetadata,
  workspaceId: string,
): Promise<void> {
  await owner.updateBlueprint(blueprintId, metadata, workspaceId);
  await env.BLUEPRINTS.put(blueprintId, JSON.stringify({
    metadata,
    ownerId: ownerId.toString(),
    gadgetId: workspaceId,
  }));
}

describe("featured blueprint mirror", () => {
  it("honors the current owner bit and rejects stale metadata", async () => {
    let {admin, owner, ownerId, workspaceId} = await createOwner();
    let blueprintId = crypto.randomUUID().replaceAll("-", "");
    let current = metadata(2, 2);
    await publishBlueprint(owner, ownerId, blueprintId, current, workspaceId);

    await owner.setBlueprintFeatured(blueprintId, true);
    await admin.syncFeaturedBlueprint({id: blueprintId, metadata: current}, ownerId.toString());
    expect((await featuredIds()).has(blueprintId)).toBe(true);

    await owner.setBlueprintFeatured(blueprintId, false);
    await admin.syncFeaturedBlueprint({id: blueprintId, metadata: current}, ownerId.toString());
    expect((await featuredIds()).has(blueprintId)).toBe(false);

    await owner.setBlueprintFeatured(blueprintId, true);
    await admin.syncFeaturedBlueprint({id: blueprintId, metadata: current}, ownerId.toString());

    let stale = metadata(1, 1);
    await env.BLUEPRINTS.put(blueprintId, JSON.stringify({
      metadata: stale,
      ownerId: ownerId.toString(),
      gadgetId: workspaceId,
    }));
    await admin.setBlueprintFeatured(blueprintId, true);
    expect((await featuredIds()).get(blueprintId)?.version).toBe(2);

    // Propagation finishes by publishing canonical KV and reconciling unconditionally, so even a
    // false/true toggle that temporarily lost the mirror's high-water mark converges to v2.
    await admin.setBlueprintFeatured(blueprintId, false);
    await admin.setBlueprintFeatured(blueprintId, true);
    await env.BLUEPRINTS.put(blueprintId, JSON.stringify({
      metadata: current,
      ownerId: ownerId.toString(),
      gadgetId: workspaceId,
    }));
    await admin.syncFeaturedBlueprint({id: blueprintId, metadata: current}, ownerId.toString());
    expect((await featuredIds()).get(blueprintId)?.version).toBe(2);

    let sameTimestamp = {...current, title: "Canonical same-millisecond title"};
    await publishBlueprint(owner, ownerId, blueprintId, sameTimestamp, workspaceId);
    await admin.syncFeaturedBlueprint({
      id: blueprintId,
      metadata: sameTimestamp,
    }, ownerId.toString());
    expect((await featuredIds()).get(blueprintId)?.title).toBe(sameTimestamp.title);
  });
});
