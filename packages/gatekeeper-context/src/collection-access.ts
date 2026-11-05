// The one collection access policy. A collection's Durable Object answers `CollectionAccess` for an
// account from its own grants; every reader of access — management API, agent reads, catalogs, and
// observer verification — interprets it here.

import type {
  ContextCollectionPermissions, ContextCollectionRole, ContextCollectionVisibility,
} from "./context-types.js";

/** One account's standing on one collection, as recorded by the collection itself. */
export type CollectionAccess = {
  /** False for an ID no collection was ever initialized under, or one since deleted. */
  exists: boolean;
  visibility: ContextCollectionVisibility;
  /** The account's grant on a private collection; always null on a public one. */
  role: ContextCollectionRole | null;
  everyoneCanView: boolean;
  /** Whether any grant is `owner`. Only meaningful for private collections. */
  hasOwner: boolean;
  /** Whether anyone besides this account can read it: another grant, or everyone-viewable. */
  shared: boolean;
};

/** Whether the account may read every document in the collection. */
export function canReadCollection(access: CollectionAccess): boolean {
  if (!access.exists) return false;
  if (access.visibility === "public") return true;
  return access.role !== null || access.everyoneCanView;
}

/**
 * What the account may do. Public collections keep their rule: editable and deletable by admins.
 * Private collection roles retain their permissions even after the last owner disconnects.
 */
export function collectionPermissions(
    access: CollectionAccess, isAdmin: boolean): ContextCollectionPermissions {
  if (!access.exists) {
    return { canEdit: false, canShare: false, canManageOwners: false, canDelete: false };
  }
  if (access.visibility === "public") {
    return { canEdit: isAdmin, canShare: false, canManageOwners: false, canDelete: isAdmin };
  }
  let isOwner = access.role === "owner";
  let canEdit = isOwner || access.role === "editor";
  return { canEdit, canShare: canEdit, canManageOwners: isOwner, canDelete: isOwner };
}

