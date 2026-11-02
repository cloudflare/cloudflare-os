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

/**
 * A role the space gave out: it answered that member `profile` holds a role on workspace
 * `workspace`, whose Overseer may since have a session of theirs open through it. With
 * `profile` set to `PUBLICATION_LEASE` it is a publication lease instead: the space answered
 * that the workspace is visible, so that its publication may since have admitted anyone signed
 * in (see SpaceModel.workspaceVisible()).
 */
export type SpaceLease = { workspace: string; profile: string };

/**
 * The `profile` of a publication lease (see `SpaceLease`): no profile id, since none is empty,
 * so that a workspace's publication lease shares its key prefix with its members' leases and is
 * revoked with them, and no member's leases include it.
 */
export const PUBLICATION_LEASE = "";

/**
 * A lease the space took back, until the workspace's Overseer has been told. `seq` is the order
 * it was queued in, and never reused. `due` is when it is next attempted, a time in
 * milliseconds that is 0 until an attempt has failed, and `retryMs` how long it then waited, 0
 * likewise.
 */
export type SpaceRevocation = SpaceLease & { seq: number; due: number; retryMs: number };

/**
 * What the space last decided about its row in the space directory (see
 * SpaceModel.listed): whether it is `listed` there, as of `rev`, which counts those decisions
 * so that the directory keeps the newest, and whether the directory has taken it, `pushed`.
 * `due` and `retryMs` are as a revocation's, for the push.
 */
export type SpaceDirectoryState =
    { listed: boolean; rev: number; pushed: boolean; due: number; retryMs: number };

export function makeSpaceStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    singletons: {
      // Absent until the space's key is claimed (see SpaceModel.claim()), and never removed.
      info: <SpaceRecord | undefined>undefined,
      // The `seq` of the next entry of `revocations`.
      nextRevocation: 0,
      // Absent while the space has never been listed in the space directory, and so is in it
      // nowhere (see SpaceModel.listed).
      directory: <SpaceDirectoryState | undefined>undefined,
      // The version of the stored shape: 0 while the entries of `workspaces` may predate its
      // indexes `byParent` and `byPublishedRoot`, 1 once those are built, 2 once `directory` is
      // too (see migrateSpaceStorage()), or since the claim, for a space claimed with them.
      version: 0,
    },
    collections: {
      // The authority on who belongs to the space and in what role. A personal space's owner is
      // stored here too, as its only admin and its only member: any other profile here holds no
      // role (see SpaceModel.roleOf()) and is removed when the space wakes.
      members: collection<SpaceMemberInfo>()({
        primaryKey: record => record.profile.id,
      }),
      // The workspaces registered with the space, each by the User DO of its owner once it has
      // seen activity (see SpaceModel.attachWorkspaces()). The owner's record of a workspace says
      // which space it belongs to, and an entry follows it: only the owner it is listed under
      // updates or drops it. While an entry stands, each member of the space holds a role on its
      // workspace (see SpaceModel.workspaceRole()).
      //
      // `bySlug` and `byFormerSlug` are the space's slugs: each slug in use names one entry, and a
      // former slug names the entry that gave it up. An entry with no slug yields no key for
      // either, so it is in neither index, and deleting an entry frees every slug it held.
      //
      // The entries form a tree, whose shape (`parentId`, `position`) is the space's alone, like
      // the slugs: an owner's update keeps it, and the space writes it on any entry (see
      // SpaceModel.moveWorkspace()). `byParent` holds each entry under the one it sits under, or
      // under "" at the top of the tree, where a null key would leave it out of the index.
      //
      // `byPublishedRoot` holds the entries at the top of the tree that are published to the
      // deployment, by the role each is published with. Someone who is not a member sees only
      // the published entries with no unpublished entry above them, so while this is empty they
      // see none, and the space is closed to them (see SpaceModel.infoFor()). Storage may still
      // hold rows under the name `byPublished`, an index of every published entry declared
      // before this one, which nothing reads: that name is not to be declared again.
      workspaces: collection<SpaceWorkspaceRecord>()({
        primaryKey: "id",
        uniqueIndexes: {
          bySlug(record: SpaceWorkspaceRecord) { return record.slug ?? null; },
        },
        nonUniqueIndexes: {
          byFormerSlug(record: SpaceWorkspaceRecord) { return record.formerSlugs ?? []; },
          byParent(record: SpaceWorkspaceRecord) { return record.parentId ?? ""; },
          byPublishedRoot(record: SpaceWorkspaceRecord) {
            return record.parentId === undefined ? record.published ?? null : null;
          },
        },
      }),
      // Every (workspace, member) the space has answered with a role and not taken back since
      // (see SpaceModel.workspaceRole()): the sessions that a change to its members or to its
      // listing may have to end. Keyed workspace first, an id with no ":" in it, so that one
      // workspace's leases are a key prefix. Beside them are the publication leases (see
      // PUBLICATION_LEASE), all under that one key of `byProfile`.
      leases: collection<SpaceLease>()({
        primaryKey: lease => `${lease.workspace}:${lease.profile}`,
        nonUniqueIndexes: {
          byProfile(lease: SpaceLease) { return lease.profile; },
        },
      }),
      // The leases taken back and not yet delivered: each is one call to its workspace's
      // Overseer, which the space's alarm makes and repeats until it is answered (see
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

/**
 * The current version of a space's stored shape: the one migrateSpaceStorage() brings a space up
 * to, and the one a claim stores (see SpaceModel.claim()), since a new space has nothing to
 * migrate. The migration names its versions literally, as each is fixed for good.
 */
export const SPACE_STORAGE_VERSION = 2;

/**
 * Brings a space's storage up to the current `version`, before anything else touches it. From
 * 0 to 1 it builds `byParent` and `byPublishedRoot` over the entries already stored: an index is
 * kept only as records are written, so until then it misses them, and updating one of them
 * would corrupt it. From 1 to 2 it records a space that has a published entry at the top of its
 * tree as listed in the space directory, not yet pushed, which its alarm then does. One that has
 * none is in the directory nowhere already, and one that holds a state for it keeps that state,
 * which a change recorded while a failed attempt at this step left the space at version 1. A
 * space whose key is unclaimed holds no entry and is left as it is, unwritten.
 */
export function migrateSpaceStorage(storage: SpaceStorage): void {
  let version = storage.version.get();
  if (version >= 2 || !storage.info.get()) return;
  storage.transaction(() => {
    if (version < 1) {
      storage.workspaces.byParent.rebuild();
      storage.workspaces.byPublishedRoot.rebuild();
    }
    let [publishedRoot] = storage.workspaces.byPublishedRoot.list({ limit: 1 });
    if (publishedRoot && !storage.directory.get()) {
      storage.directory.put({ listed: true, rev: 1, pushed: false, due: 0, retryMs: 0 });
    }
    storage.version.put(2);
  });
}
