/**
 * Approval-backed Drive moves: what a move queues, how it is described, how a move's file and
 * folders are proved when it is approved, and how an approved move is made.
 *
 * A move swaps one parent of a file for another. That is state Drive reads back at once, so what an
 * earlier send of a move made is found by one read of where the file is, and the same move sent
 * twice changes nothing the second time. A move is never simulated: every read shows the file where
 * it is until the move is made.
 */

import {
  ActionApplyError, ActionOutcomeUnknownError, type ActionDefinition, type JournalEntry,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, codeSpan } from "@gadgets/gatekeeper-kit/action-description";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import {
  FOLDER_MIME_TYPE, isInsufficientScope, isListableFolderNode, type DriveScopeNode,
} from "./drive-api";
import { isDirectChild } from "./drive-folder-scope";
import {
  driveRefusal, isLiftable, provePath, requireWritable, sendOnce, type DriveWritesHost,
  type QueuedWrite, type RefusalRow,
} from "./drive-writes";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({
  component: "gatekeeper.google.drive.moves", vendorId: "google",
});

/** Each Drive move, by the action kind it is queued as. */
export type DriveMoveActions = {
  moveFile: {
    fileId: string;
    /** The file's or folder's name when queued, as an approval shows it. */
    fileName?: string;
    /** What moves is a folder, with everything in it. */
    isFolder?: true;
    /** The folder the file leaves: its one parent when queued. */
    fromFolderId: string;
    /** The folder the file goes into. */
    toFolderId: string;
    /** The name of the folder the file goes into, when queued. */
    toName?: string;
    /** Folder binding: the positioned folder's name. An account binding does not show it. */
    fromName?: string;
    /** The folder left is the account's own My Drive root, which the card says in words. */
    fromMyDrive?: true;
    /** The folder entered is the account's own My Drive root, which the card says in words. */
    toMyDrive?: true;
    /** Folder binding: the path from the bound root to the positioned folder, the source. */
    folderIds?: string[];
  };
};

/** One queued Drive move. */
export type DriveMoveAction = TaggedAction<DriveMoveActions>;

/** The one kind every Drive move is queued as. No move is auto-approvable. */
export const DRIVE_MOVES: ActionKind = { tag: "driveMoves", label: "Drive moves" };

/** The refusal for a second move of a file that has one waiting. */
export const MOVE_PENDING =
  "That file already has a move waiting for approval. To move it somewhere else instead, have " +
  "the user reject that move first.";

/**
 * The refusal, on a folder binding, for a write whose file, or a folder on the saved path to it,
 * has a move waiting: the write names that path, which the move takes the file out of.
 */
export const MOVE_WAITING =
  "That file, or a folder it is in, has a move waiting for approval, which takes it out of " +
  "where this binding reaches it now. Queue this once the move is decided, from the folder the " +
  "file is then in.";

/** The refusal, on a folder binding, for a move into a folder that has a move of its own waiting. */
export const MOVE_DESTINATION_WAITING =
  "That destination folder has a move waiting for approval. Queue this once that move is decided.";

const NO_LONGER_IN_SCOPE = "That file is no longer in this connection's scope.";
const ALREADY_MOVED =
  "That file was already moved there after this was queued, so nothing was changed.";
const NOT_WHERE_IT_WAS =
  "That file is no longer in the folder it was to be moved from, so it was not moved.";
const FILE_IN_TRASH = "That file is in the trash, so it was not moved.";
const DESTINATION_IN_TRASH = "That folder is in the trash, so nothing was moved into it.";
const CANNOT_MOVE = "The connected account can no longer move that file there.";

/** Said when a look finds the file in neither folder of a move an earlier send may have made. */
const MOVED_AGAIN =
  "This file was moved again on Google Drive after this was first sent, so it was left where it " +
  "is. Check where it is, then reject this to clear it.";

/** Said when a look cannot see the file or a folder of a move an earlier send may have made. */
const NO_LONGER_SHOWN =
  "Google Drive no longer shows this file to the connected account where this connection " +
  "reaches it, so whether it was moved can't be checked, and it won't be moved again. Reject it " +
  "to clear it.";

/** Said when Drive leaves open whether a send moved the file. */
const UNCONFIRMED_MOVE =
  "Google Drive did not confirm whether this was moved, and it may have been. Approving it " +
  "again first checks where the file is, so it is not moved twice; rejecting it leaves the file " +
  "wherever it is.";

/** What Drive refuses a move for, and what the approver is told. */
const MOVE_REFUSALS: readonly RefusalRow[] = [
  {
    status: 400, reason: "badRequest",
    message: "Google Drive refused this move as invalid. A folder cannot be moved into itself " +
      "or into a folder inside it.",
  },
  { status: 403, reason: "parentNotAFolder", message: "The destination is not a folder." },
  {
    status: 404, reason: "notFound",
    message: "Google Drive no longer shows the file or the destination folder to the connected " +
      "account.",
  },
  { status: 403, reason: "insufficientFilePermissions", message: CANNOT_MOVE },
  {
    status: 403, reason: "teamDrivesFolderMoveInNotSupported",
    message: "Google does not allow that folder to be moved into a shared drive.",
  },
  {
    status: 403, reason: "teamDriveHierarchyTooDeep",
    message: "That would nest folders deeper than a shared drive allows.",
  },
  {
    status: 403, reason: "teamDriveFileLimitExceeded",
    message: "That shared drive already holds as many items as Google allows.",
  },
  {
    status: 403, reason: "storageQuotaExceeded",
    message: "There is no Drive storage left for this move.",
  },
];

/** Whether `entry` is a move: one queued under a move definition's name. */
function isMoveEntry(entry: QueuedWrite): entry is JournalEntry<DriveMoveAction> {
  return Object.hasOwn(DRIVE_MOVE_DEFINITIONS, entry.action.kind);
}

/**
 * Whether `pending` holds a move of any of the files or folders `fileIds`. A move into one of
 * them, or out of one, is not a move of it.
 */
export function hasPendingMove(
  fileIds: readonly string[], pending: readonly QueuedWrite[],
): boolean {
  return pending.some(entry =>
    isMoveEntry(entry) && fileIds.includes(entry.action.payload.fileId));
}

/** Where a move's file was found, with the nodes that prove it. */
type ProvedMove =
  | {
    at: "source" | "destination";
    file: DriveScopeNode;
    source: DriveScopeNode;
    destination: DriveScopeNode;
  }
  | { at: "elsewhere" };

/**
 * Where the file of a move is now, as the binding's scope reaches it: in the folder it was to
 * leave, in the folder it was to enter, or, on an account binding, visibly in neither. `undefined`
 * when either folder or the file is out of scope or invisible. Read in one batch.
 *
 * It asks only where the file is. Whether the file or a folder is in the trash, and what the
 * account may do, is the caller's to require of the nodes, on an account binding. A folder
 * binding's proof admits live direct children of live folders alone, as every folder call does.
 */
export async function proveMove(
  host: Pick<DriveWritesHost, "api" | "scope">, payload: DriveMoveActions["moveFile"],
): Promise<ProvedMove | undefined> {
  let { fileId, fromFolderId, toFolderId, folderIds } = payload;
  let scope = host.scope();
  // A single-file binding holds no folder to move its file between.
  if (scope.kind === "file") return undefined;

  if (scope.kind === "account") {
    let [file, source, destination] =
      await host.api.getScopeNodes([fileId, fromFolderId, toFolderId]);
    if (!file || !source || !destination) return undefined;
    let parent = file.parents?.length === 1 ? file.parents[0] : undefined;
    if (parent === fromFolderId) return { at: "source", file, source, destination };
    if (parent === toFolderId) return { at: "destination", file, source, destination };
    return { at: "elsewhere" };
  }

  let proved = await provePath(host, folderIds, [fileId, toFolderId]);
  if (!proved) return undefined;
  let { path, extras: [file, child] } = proved;
  let source = path.at(-1);
  if (!file || !source || source.id !== fromFolderId) return undefined;
  // Up, into the folder the positioned one was opened from, which the path has proved; or down,
  // into a child folder of the positioned one. Nothing above the bound root is on the path.
  let destination = folderIds?.at(-2) === toFolderId ? path.at(-2)
    : child && isListableFolderNode(child) && isDirectChild(child, source) ? child
    : undefined;
  if (!destination) return undefined;
  if (isDirectChild(file, source)) return { at: "source", file, source, destination };
  if (isDirectChild(file, destination)) return { at: "destination", file, source, destination };
  // In neither folder, or in the trash: outside what the saved path proves.
  return undefined;
}

/** What a move needs of the folder its file goes into: a folder of the file's own drive. */
function canEnter(file: DriveScopeNode, folder: DriveScopeNode): boolean {
  // Outside shared drives neither carries a drive, which counts as the same one.
  return folder.mimeType === FOLDER_MIME_TYPE && folder.driveId === file.driveId;
}

/**
 * Refuses a move that may not be made at apply, having moved nothing: for good, except for a
 * refusal a later approval can pass, which leaves the move pending. Where the file is comes before
 * what the account may still do, so that a move found made, a file found elsewhere and a file in
 * the trash are each said as that.
 */
async function requireStillMovable(
  host: DriveWritesHost, payload: DriveMoveActions["moveFile"],
): Promise<void> {
  await requireWritable(host);
  let proved = await proveMove(host, payload);
  if (!proved) throw new ActionApplyError(NO_LONGER_IN_SCOPE);
  if (proved.at === "destination") throw new ActionApplyError(ALREADY_MOVED);
  if (proved.at === "elsewhere") throw new ActionApplyError(NOT_WHERE_IT_WAS);
  let { file, source, destination } = proved;
  // Google moves a file that is in the trash, where it stays. What a folder put in the trash holds
  // can read as live for some seconds, so the folder being left is asked too.
  if (file.trashed !== false || source.trashed !== false) {
    throw new ActionApplyError(FILE_IN_TRASH);
  }
  // Google moves a file into a folder that is in the trash, which still reports that the account
  // can add to it: the file would then be live in a folder no listing shows.
  if (destination.trashed !== false) throw new ActionApplyError(DESTINATION_IN_TRASH);
  if (!canEnter(file, destination) || file.canMoveItemWithinDrive !== true ||
      destination.canAddChildren !== true) {
    throw new ActionApplyError(CANNOT_MOVE);
  }
}

/**
 * Leaves a move pending, under the binding's own refusal, when that is one a later approval can
 * pass. A token without the Drive scope reads every file as one the account cannot see, so a look
 * that proved nothing asks this before it takes the file for gone.
 */
async function waitWhileRefused(
  host: Pick<DriveWritesHost, "writeRefusal">, cause?: unknown,
): Promise<void> {
  let refused = await host.writeRefusal();
  if (refused !== undefined && isLiftable(refused)) {
    throw new Error(refused, cause === undefined ? undefined : { cause });
  }
}

/**
 * What an earlier send of a move left: the file in the folder it was to enter, or still in the one
 * it was to leave, which proves that send moved nothing.
 * @throws ActionOutcomeUnknownError when the file is in neither folder, or the move cannot be
 * proved. A look that cannot read for a refusal a later approval can pass throws that refusal
 * instead, which leaves the move pending with its marker.
 */
async function findMoved(
  host: DriveWritesHost, payload: DriveMoveActions["moveFile"],
): Promise<{ found: void } | { conclusive: true }> {
  let proved: ProvedMove | undefined;
  try {
    proved = await proveMove(host, payload);
  } catch (error) {
    if (isInsufficientScope(error)) await waitWhileRefused(host, error);
    throw error;
  }
  if (!proved) {
    await waitWhileRefused(host);
    throw new ActionOutcomeUnknownError(NO_LONGER_SHOWN);
  }
  if (proved.at === "elsewhere") throw new ActionOutcomeUnknownError(MOVED_AGAIN);
  return proved.at === "destination" ? { found: undefined } : { conclusive: true };
}

/**
 * Makes one approved move, looking first for what an earlier send of it may have made. The marker
 * of a send stays until the action's record is settled, so every later approval looks before it
 * sends.
 */
function move(
  host: DriveWritesHost, id: number, payload: DriveMoveActions["moveFile"],
): Promise<void> {
  let { fileId, fromFolderId, toFolderId } = payload;
  return sendOnce<void>(host, id, {
    log: logger.with({ actionId: id, actionKind: "moveFile", fileId }),
    events: "drive.moves",
    look: () => findMoved(host, payload),
    check: async () => {
      await requireStillMovable(host, payload);
      return {};
    },
    send: async () => {
      let { parents } = await host.api.swapParent(
        fileId, { addParent: toFolderId, removeParent: fromFolderId });
      // Not Drive's error class, so the outcome is read as open: the next approval looks.
      if (parents.length !== 1 || parents[0] !== toFolderId) {
        throw new Error("Google Drive answered a move with other parents than the folder asked for");
      }
    },
    repeatable: true,
    refusal: error => driveRefusal(error, MOVE_REFUSALS, "Google Drive refused this move."),
    unconfirmed: UNCONFIRMED_MOVE,
  });
}

/** The declared Drive moves, which drive-actions.ts combines with the other Drive writes. */
export const DRIVE_MOVE_DEFINITIONS: {
  moveFile: ActionDefinition<DriveMoveActions["moveFile"], DriveWritesHost>;
} = {
  moveFile: {
    kind: DRIVE_MOVES,
    // Rule 7: a move changes the access a file inherits.
    autoApprovable: false,
    // A move is not simulated: the folder core admits only what is a direct child on Drive.
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: payload => {
      let noun = payload.isFolder ? "folder" : "file";
      let builder = buildDescription(
        `**Moving changes who has access.** Move Google Drive ${noun} ${
          codeSpan(payload.fileId)} from folder ${codeSpan(payload.fromFolderId)} into folder ${
          codeSpan(payload.toFolderId)}, as the connected account.`);
      if (payload.isFolder) builder.prose("Everything in it moves with it.");
      // No other account can see that folder, so the card names it in words of its own.
      if (payload.fromMyDrive) {
        builder.prose("The folder it leaves is the top level of the connected account's My Drive.");
      }
      if (payload.toMyDrive) {
        builder.prose(
          "The folder it goes into is the top level of the connected account's My Drive.");
      }
      builder.prose(
        "It takes the sharing of the folder it goes into: everyone with access to that folder " +
        "gains access to it, and access it had only through the folder it leaves is lost. " +
        "Access given on it directly that the new folder also gives is merged into the " +
        "folder's, and does not come back if it is moved out again.");
      builder.inline("File", payload.fileId);
      if (payload.fileName !== undefined) builder.inline("File name", payload.fileName);
      builder.inline("From folder", payload.fromFolderId);
      if (payload.fromName !== undefined) builder.inline("From folder name", payload.fromName);
      builder.inline("To folder", payload.toFolderId);
      if (payload.toName !== undefined) builder.inline("To folder name", payload.toName);
      return {
        title: `Move a Google Drive ${noun}`, ...builder.finish(), implementsRevert: false,
      };
    },
    apply: async (payload, host, ctx) => {
      await move(host, ctx.id, payload);
    },
  },
};
