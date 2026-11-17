/**
 * The approval-backed writes of a Drive binding as one action set: comments, sharing changes,
 * moves and edits of native files are declared together, so one journal stores and numbers them
 * all.
 */

import { defineActions, type TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import { DRIVE_COMMENT_DEFINITIONS, type DriveCommentActions } from "./drive-comments";
import {
  DRIVE_DOCS_DEFINITIONS, DRIVE_SHEETS_DEFINITIONS, DRIVE_SLIDES_DEFINITIONS, type DriveDocEdits,
  type DriveEdits,
  type DriveEditorsHost,
} from "./drive-editors";
import { DRIVE_MOVE_DEFINITIONS, type DriveMoveActions } from "./drive-moves";
import { DRIVE_SHARING_DEFINITIONS, type DriveSharingActions } from "./drive-sharing";
import type { DriveWriteQueue, DriveWritesHost } from "./drive-writes";
import type { SheetsActions } from "./sheets-simulation";
import type { SlidesActions } from "./slides-simulation";

/** Every Drive write, by the action kind it is queued as. */
export type DriveActions = DriveCommentActions & DriveSharingActions & DriveMoveActions &
  DriveEdits<SlidesActions> & DriveEdits<SheetsActions> & DriveEdits<DriveDocEdits>;

/** One queued Drive write. */
export type DriveAction = TaggedAction<DriveActions>;

/** What a Drive session needs of its gatekeeper to show and queue writes. */
export type DriveQueue = DriveWriteQueue<DriveActions>;

/** What applying any Drive write needs of its gatekeeper. */
export type DriveHost = DriveWritesHost & DriveEditorsHost;

/**
 * The declared Drive writes: comments, sharing, moves and edits, over one journal, so one
 * numbering serves the overseer's apply and reject. A comment or an edit is not tied to the
 * account that queued it; a sharing change or a move is made as one Google account, and is fenced
 * on it. No applied record is kept: none of these can be reverted from here.
 */
export const DRIVE_ACTIONS = defineActions<DriveHost, DriveActions>({
  ...DRIVE_COMMENT_DEFINITIONS, ...DRIVE_SHARING_DEFINITIONS, ...DRIVE_MOVE_DEFINITIONS,
  ...DRIVE_SLIDES_DEFINITIONS, ...DRIVE_SHEETS_DEFINITIONS, ...DRIVE_DOCS_DEFINITIONS,
}, {
  fence: "none",
  fenceOverrides: {
    createPermission: "authority", updatePermission: "authority", deletePermission: "authority",
    moveFile: "authority",
  },
  vendorId: "google",
});
