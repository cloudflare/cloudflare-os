// The Space Durable Object's storage schema: `makeSpaceStorage()` and the record types it stores.
//
// Everything a space persists is declared in this one file, so that a change to the stored shape
// of a space shows up as a change here. See overseer-storage.ts for the conventions.

import { collection, createTypedStorage } from "@gadgets/typed-storage";
import type { SpaceInfo, SpaceMemberInfo, SpaceWorkspaceInfo } from "@gadgets/workshop-shared/api";

/** A space as stored: its `SpaceInfo` without `role`, which is derived per caller on read. */
export type SpaceRecord = Omit<SpaceInfo, "role">;

/**
 * A workspace's entry in the listing as stored: what a member is shown, plus the slugs the entry
 * used to have, oldest first, which keep resolving to it and are never sent to a client. An
 * entry has none until its slug is first changed.
 */
export type SpaceWorkspaceRecord = SpaceWorkspaceInfo & { formerSlugs?: string[] };

export function makeSpaceStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    singletons: {
      // Absent until the space's key is claimed (see SpaceModel.claim()), and never removed.
      info: <SpaceRecord | undefined>undefined,
    },
    collections: {
      // The authority on who belongs to the space and in what role. A personal space's owner is
      // stored here too, as its only admin.
      members: collection<SpaceMemberInfo>()({
        primaryKey: record => record.profile.id,
      }),
      // The workspaces registered with the space, each by the User DO of its owner once it has
      // seen activity (see SpaceModel.attachWorkspaces()). A listing only: the owner's record of
      // a workspace says which space it belongs to, and all an entry decides is that only the
      // owner it is listed under updates or drops it.
      //
      // The indexes are the space's slugs: each slug in use names one entry, and a former slug
      // names the entry that gave it up. An entry with no slug yields no key for either, so it is
      // in neither index, and deleting an entry frees every slug it held.
      workspaces: collection<SpaceWorkspaceRecord>()({
        primaryKey: "id",
        uniqueIndexes: {
          bySlug(record: SpaceWorkspaceRecord) { return record.slug ?? null; },
        },
        nonUniqueIndexes: {
          byFormerSlug(record: SpaceWorkspaceRecord) { return record.formerSlugs ?? []; },
        },
      }),
    },
  });
}

export type SpaceStorage = ReturnType<typeof makeSpaceStorage>;
