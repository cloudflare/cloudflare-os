// The Space Durable Object's storage schema: `makeSpaceStorage()` and the record types it stores.
//
// Everything a space persists is declared in this one file, so that a change to the stored shape
// of a space shows up as a change here. See overseer-storage.ts for the conventions.

import { collection, createTypedStorage } from "@gadgets/typed-storage";
import type { SpaceInfo, SpaceMemberInfo } from "@gadgets/workshop-shared/api";

/** A space as stored: its `SpaceInfo` without `role`, which is derived per caller on read. */
export type SpaceRecord = Omit<SpaceInfo, "role">;

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
    },
  });
}

export type SpaceStorage = ReturnType<typeof makeSpaceStorage>;
