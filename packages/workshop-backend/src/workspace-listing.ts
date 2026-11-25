// What a workspace's Overseer mirrors into the User DO of each person it is listed for (see
// OverseerImpl.deliverUserUpdates() and UserDurableObject.syncWorkspaceListing()). Each part is
// present only when this recipient is entitled to it, owes it, and has not acknowledged its
// current value; an absent part leaves the recipient's copy as it is.

import type { BlueprintUnpublishedChanges, BoundHookInfo, WorkpieceId, WorkspaceWaiting } from "@gadgets/workshop-shared/api";
import type { WorkspaceOutputEntry } from "./storage-schema/user-storage.js";

/** One blueprint published from the workspace, and what it has not released. */
export type ListedBlueprintChanges = {
  blueprintId: string;
  /** Null when it has released everything (see BlueprintUserSummary.unpublishedChanges). */
  changes: BlueprintUnpublishedChanges | null;
  /** The gadget it is published from. */
  gadgetId: WorkpieceId;
};

export type WorkspaceListing = {
  /**
   * The Overseer's listing revision the parts were read at: one per delivery pass, increasing, so
   * a recipient can tell a push that arrives late from a newer one it has taken.
   */
  listingRev: number;
  /** The outputs the recipient may see: the owner all, a collaborator those their access holds. */
  outputs?: WorkspaceOutputEntry[];
  /** The actions waiting there, by gadget (WorkspaceSummary.waiting): for the owner and "build" collaborators. */
  attention?: WorkspaceWaiting;
  /** Each blueprint published from here: for the owner. */
  blueprintChanges?: ListedBlueprintChanges[];
  /** The title: for the owner, and for each collaborator's shared listing with its revision. */
  title?: {title: string; titleRev: number};
  /** When the workspace was last active and what it has cost: for the owner. */
  activity?: {lastActive: Date; totalCost: number};
  /**
   * Each hook added, changed or removed since the recipient last took it, or every hook on a
   * resync, each as it stands when sent (null: removed): for the owner and "build" collaborators.
   * Not a part: owed per hook (see PendingUserUpdate.hookIds), and never acknowledged.
   */
  hooks?: {id: number; hook: BoundHookInfo | null}[];
  /**
   * Set once a collaborator is found denied background reads: their account forgets the chat state
   * it holds of the workspace, and seeds it again at the next open that admits them. Not a part:
   * owed once (see PendingUserUpdate.forgetChats).
   */
  forgetChats?: true;
};

/** A part of the listing, which the Overseer marks as it may change and sends whole. */
export type ListingPart = Exclude<keyof WorkspaceListing, "listingRev" | "hooks" | "forgetChats">;

/** Every part of the listing. */
export const LISTING_PARTS: readonly ListingPart[] = ["outputs", "attention", "blueprintChanges", "title", "activity"];
