/**
 * The approval-backed writes of a Drive binding as one action set: comments, sharing changes,
 * moves, copies, uploads and edits of native files are declared together, so one journal stores
 * and numbers them all. What reads show of the files copies and uploads will make while they wait
 * is read here, across both.
 */

import { defineActions, type TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import { DRIVE_COMMENT_DEFINITIONS, type DriveCommentActions } from "./drive-comments";
import {
  DRIVE_COPY_DEFINITIONS, isCopyEntry, simulatedCopy, type DriveCopiesHost, type DriveCopyActions,
} from "./drive-copies";
import {
  DRIVE_DOCS_DEFINITIONS, DRIVE_SHEETS_DEFINITIONS, DRIVE_SLIDES_DEFINITIONS, type DriveDocEdits,
  type DriveEdits,
  type DriveEditorsHost,
} from "./drive-editors";
import { DRIVE_MOVE_DEFINITIONS, type DriveMoveActions } from "./drive-moves";
import type { SimulatedEntry } from "./drive-session";
import { DRIVE_SHARING_DEFINITIONS, type DriveSharingActions } from "./drive-sharing";
import {
  DRIVE_UPLOAD_DEFINITIONS, isUploadEntry, simulatedUpload, type DriveUploadActions,
  type DriveUploadFiles, type DriveUploadsHost,
} from "./drive-uploads";
import { isPendingId, type DriveWriteQueue, type DriveWritesHost, type QueuedWrite } from "./drive-writes";
import type { SheetsActions } from "./sheets-simulation";
import type { SlidesActions } from "./slides-simulation";

/** Every Drive write, by the action kind it is queued as. */
export type DriveActions = DriveCommentActions & DriveSharingActions & DriveMoveActions &
  DriveCopyActions & DriveUploadActions & DriveEdits<SlidesActions> & DriveEdits<SheetsActions> &
  DriveEdits<DriveDocEdits>;

/** One queued Drive write. */
export type DriveAction = TaggedAction<DriveActions>;

/** What a Drive session needs of its gatekeeper to show and queue writes, and keep uploads' bytes. */
export type DriveQueue = DriveWriteQueue<DriveActions> & { uploads: DriveUploadFiles };

/** What applying any Drive write needs of its gatekeeper. */
export type DriveHost = DriveWritesHost & DriveCopiesHost & DriveUploadsHost & DriveEditorsHost;

/**
 * The declared Drive writes: comments, sharing, moves, copies, uploads and edits, over one
 * journal, so one numbering serves the overseer's apply and reject. A comment or an edit is not
 * tied to the account that queued it; a sharing change, a move, a copy or an upload is made as one
 * Google account, and is fenced on it. No applied record is kept: none of these can be reverted
 * from here.
 */
export const DRIVE_ACTIONS = defineActions<DriveHost, DriveActions>({
  ...DRIVE_COMMENT_DEFINITIONS, ...DRIVE_SHARING_DEFINITIONS, ...DRIVE_MOVE_DEFINITIONS,
  ...DRIVE_COPY_DEFINITIONS, ...DRIVE_UPLOAD_DEFINITIONS,
  ...DRIVE_SLIDES_DEFINITIONS, ...DRIVE_SHEETS_DEFINITIONS, ...DRIVE_DOCS_DEFINITIONS,
}, {
  fence: "none",
  fenceOverrides: {
    createPermission: "authority", updatePermission: "authority", deletePermission: "authority",
    moveFile: "authority", copyFile: "authority", copyNative: "authority", exportCopy: "authority",
    uploadFile: "authority", uploadConverted: "authority", replaceFile: "authority",
  },
  vendorId: "google",
});

/** What a waiting copy or upload shows, if it shows anything. */
function simulated(entry: QueuedWrite): SimulatedEntry | undefined {
  if (isCopyEntry(entry)) return simulatedCopy(entry);
  return isUploadEntry(entry) ? simulatedUpload(entry) : undefined;
}

/**
 * The copy or upload `fileId` names while an approval can still make it, if it is one made under an
 * ID reserved for it.
 */
export function pendingFile(
  fileId: string, pending: readonly QueuedWrite[],
): SimulatedEntry | undefined {
  if (isPendingId(fileId)) return undefined;
  return pending.flatMap(entry => simulated(entry) ?? []).find(({ entry }) => entry.id === fileId);
}

/**
 * The copies and uploads into folder `folderId` an approval can still make under a reserved ID,
 * as a listing shows them.
 */
export function pendingFilesInto(
  folderId: string, pending: readonly QueuedWrite[],
): SimulatedEntry[] {
  return pending.flatMap(entry => simulated(entry) ?? []).filter(({ entry }) =>
    entry.parentId === folderId && !isPendingId(entry.id));
}

/** The native copy or converted upload `actionId`, while an approval can still make it. */
export function waitingFile(
  actionId: number, pending: readonly QueuedWrite[],
): SimulatedEntry | undefined {
  let found = pending.find(entry => entry.id === actionId);
  let shown = found && simulated(found);
  return shown && isPendingId(shown.entry.id) ? shown : undefined;
}

/**
 * Whether a copy or an upload waiting for approval would make, or replace, a file named `name` in
 * folder `folderId`.
 */
export function pendingNameInto(
  folderId: string, name: string, pending: readonly QueuedWrite[],
): boolean {
  return pending.some(entry =>
    (isCopyEntry(entry) || isUploadEntry(entry)) &&
    entry.action.payload.toFolderId === folderId && entry.action.payload.name === name);
}
