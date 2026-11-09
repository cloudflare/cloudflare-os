// The Space Durable Object's storage schema: `makeSpaceStorage()` and the record types it stores.
//
// Everything a space persists is declared in this one file, so that a change to the stored shape
// of a space shows up as a change here. See overseer-storage.ts for the conventions.

import { collection, createTypedStorage } from "@gadgets/typed-storage";
import type {
  SpaceInfo, SpaceMemberInfo, SpaceWorkspaceInfo, SubspaceInfo,
} from "@gadgets/workshop-shared/api";

/**
 * A space as stored: its `SpaceInfo` without `id`, which is the id of the Durable Object that
 * stores it, and without `role` and `parent`, which are derived per caller on read. A sub-space
 * stores its `ancestors` instead: the ids of the spaces it is inside, nearest first, from its
 * parent to the one inside no other. They are written once, by the parent that creates it, and
 * are the spaces it asks which role a profile inherits.
 */
export type SpaceRecord = Omit<SpaceInfo, "id" | "role" | "parent"> & { ancestors?: string[] };

/**
 * A role the space gave out: it answered that member `profile` holds a role on workspace
 * `workspace`, whose Overseer may since have a session of theirs open through it, or that they
 * hold one in this space to `space`, a space below it, which may since have given them one on a
 * workspace of its own.
 */
export type SpaceLease = { profile: string } & ({ workspace: string } | { space: string });

/**
 * A lease the space took back, until its workspace or space has been told. `seq` is the order
 * it was queued in, and never reused. `due` is when it is next attempted, a time in
 * milliseconds that is 0 until an attempt has failed, and `retryMs` how long it then waited, 0
 * likewise.
 */
export type SpaceRevocation = SpaceLease & { seq: number; due: number; retryMs: number };

export function makeSpaceStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    singletons: {
      // Absent until the space is created (see SpaceModel.create()), and never removed.
      info: <SpaceRecord | undefined>undefined,
      // The `seq` of the next entry of `revocations`.
      nextRevocation: 0,
    },
    collections: {
      // The space's own members, each with the role given here. A personal space's owner is
      // stored here too, as its only admin and its only member.
      members: collection<SpaceMemberInfo>()({
        primaryKey: record => record.profile.id,
      }),
      // The workspaces registered with the space, each by the User DO of its owner once it has
      // seen activity (see SpaceModel.attachWorkspaces()). The owner's record of a workspace says
      // which space it belongs to, and an entry follows it: only the owner it is listed under
      // updates or drops it. While an entry stands, each member of the space holds a role on its
      // workspace (see SpaceModel.workspaceRole()).
      workspaces: collection<SpaceWorkspaceInfo>()({
        primaryKey: "id",
      }),
      // The sub-spaces created in this space (see SpaceDurableObject.createSubspace()), for its
      // members to find. Nothing is decided from an entry: a sub-space's own record says which
      // spaces it is inside.
      children: collection<SubspaceInfo>()({
        primaryKey: "id",
      }),
      // Every (workspace, member) the space has answered with a role and not taken back since
      // (see SpaceModel.workspaceRole()): the sessions that a change to its members or to its
      // listing may have to end. Keyed workspace first, an id with no ":" in it, so that one
      // workspace's leases are a key prefix. A (space below it, member) it answered likewise
      // (see SpaceModel.lend()) is keyed under "space:", which no workspace's id starts with.
      leases: collection<SpaceLease>()({
        primaryKey: lease => "space" in lease
            ? `space:${lease.space}:${lease.profile}` : `${lease.workspace}:${lease.profile}`,
        nonUniqueIndexes: {
          byProfile(lease: SpaceLease) { return lease.profile; },
        },
      }),
      // The leases taken back and not yet delivered: each is one call to its workspace's
      // Overseer or to its space, which the alarm makes and repeats until it is answered (see
      // SpaceDurableObject.alarm()). The index is the order they are attempted in: by when each
      // is due and, among those due together, as queued.
      revocations: collection<SpaceRevocation>()({
        primaryKey: "seq",
        nonUniqueIndexes: {
          byDue(revocation: SpaceRevocation) { return revocation.due; },
        },
      }),
    },
  });
}

export type SpaceStorage = ReturnType<typeof makeSpaceStorage>;
