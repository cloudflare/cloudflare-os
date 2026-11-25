/**
 * Approval-backed Drive renames: what a rename queues, how it is described, how its file is proved
 * when it is approved, and how an approved rename is made.
 *
 * A rename sets a file's or folder's name, which Drive reads back at once, so what an earlier send
 * made is found by one read of the name, and the same rename sent twice changes nothing the second
 * time. A rename is never simulated: every read shows the old name until it is made.
 */

import {
  ActionApplyError, ActionOutcomeUnknownError, type ActionDefinition, type JournalEntry,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, codeSpan } from "@gadgets/gatekeeper-kit/action-description";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import { MAX_FILE_NAME_LENGTH, oneLineFileName } from "./creation";
import { isInsufficientScope, type DriveScopeNode } from "./drive-api";
import {
  driveRefusal, proveTarget, requireWritable, sendOnce, waitWhileRefused,
  type DriveWriteTargetPayload, type DriveWritesHost, type QueuedWrite, type RefusalRow,
} from "./drive-writes";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({
  component: "gatekeeper.google.drive.renames", vendorId: "google",
});

/** Each Drive rename, by the action kind it is queued as. */
export type DriveRenameActions = {
  renameFile: DriveWriteTargetPayload & {
    /** What is renamed is a folder. */
    isFolder?: true;
    /** The name when queued, in full: an approval renames only a file that still has it. */
    fromName: string;
    /** The name the file is given, in full. */
    toName: string;
  };
};

/** One queued Drive rename. */
export type DriveRenameAction = TaggedAction<DriveRenameActions>;

/** The one kind every Drive rename is queued as. */
export const DRIVE_RENAMES: ActionKind = { tag: "driveRenames", label: "Drive renames" };

/** The refusal for a second rename of a file that has one waiting. */
export const RENAME_PENDING =
  "That file already has a rename waiting for approval. To give it another name instead, have " +
  "the user reject that rename first.";

/** The refusal at queue time of a file in the trash, which Google renames all the same. */
export const RENAME_TRASHED = "That file is in the trash, so it cannot be renamed.";

/** The refusal of a rename to the name a file already has. */
export const RENAME_SAME_NAME = "That file already has that name.";

/** The name a rename gives: `name`, trimmed, refused as {@link oneLineFileName} refuses it. */
export function newFileName(name: string): string {
  let trimmed = oneLineFileName(name);
  if (trimmed === undefined) {
    throw new Error(
      `A Google Drive file or folder needs a one-line name of 1 to ${MAX_FILE_NAME_LENGTH} ` +
      "characters.");
  }
  return trimmed;
}

const NO_LONGER_IN_SCOPE = "That file is no longer in this connection's scope.";
const FILE_IN_TRASH = "That file is in the trash, so it was not renamed.";
const ALREADY_RENAMED =
  "That file was already given that name after this was queued, so nothing was changed.";
const RENAMED_SINCE =
  "That file was renamed after this was queued, so it was not renamed again.";
const CANNOT_RENAME = "The connected account can no longer rename that file.";

/** Said when a look finds neither name of a rename an earlier send may have made. */
const RENAMED_AGAIN =
  "This file was renamed again on Google Drive after this was first sent, so its name was left " +
  "as it is. Check its name, then reject this to clear it.";

/** Said when a look cannot see the file of a rename an earlier send may have made. */
const NO_LONGER_SHOWN =
  "Google Drive no longer shows this file to the connected account where this connection " +
  "reaches it, so whether it was renamed can't be checked, and it won't be renamed again. " +
  "Reject it to clear it.";

/** Said when Drive leaves open whether a send renamed the file. */
const UNCONFIRMED_RENAME =
  "Google Drive did not confirm whether this was renamed, and it may have been. Approving it " +
  "again first checks the file's name; rejecting it leaves the file named as it is.";

/** What Drive refuses a rename for, and what the approver is told. */
const RENAME_REFUSALS: readonly RefusalRow[] = [
  { status: 400, reason: "badRequest", message: "Google Drive refused that name as invalid." },
  { status: 400, reason: "invalid", message: "Google Drive refused that name as invalid." },
  { status: 403, reason: "insufficientFilePermissions", message: CANNOT_RENAME },
  {
    status: 403, reason: "fileNeverWritable", message: "Google Drive does not let that be renamed.",
  },
  {
    status: 404, reason: "notFound",
    message: "Google Drive no longer shows that file to the connected account.",
  },
];

/** Whether `entry` is a rename: one queued under a rename definition's name. */
function isRenameEntry(entry: QueuedWrite): entry is JournalEntry<DriveRenameAction> {
  return Object.hasOwn(DRIVE_RENAME_DEFINITIONS, entry.action.kind);
}

/** Whether `pending` holds a rename of file or folder `fileId`. */
export function hasPendingRename(fileId: string, pending: readonly QueuedWrite[]): boolean {
  return pending.some(entry => isRenameEntry(entry) && entry.action.payload.fileId === fileId);
}

/**
 * A rename's file as the binding's scope reaches it now, with its current name, or `undefined`
 * when it is out of scope or invisible. The name is read in the batch that proves the scope, so
 * the two are one read's.
 */
async function proveRename(
  host: DriveWritesHost, payload: DriveRenameActions["renameFile"],
): Promise<{ file: DriveScopeNode; name: string } | undefined> {
  let file = await proveTarget(host, payload, { named: true });
  if (!file) return undefined;
  // Not Drive's error class, so the rename is left pending: Drive gives every file a name.
  if (file.name === undefined) throw new Error("Google Drive answered without the file's name");
  return { file, name: file.name };
}

/**
 * Refuses a rename that may not be made at apply, having renamed nothing: for good, except for a
 * refusal a later approval can pass, which leaves the rename pending. What the file is now comes
 * before what the account may still do, so that a rename someone else made is said as that.
 */
async function requireStillRenamable(
  host: DriveWritesHost, payload: DriveRenameActions["renameFile"],
): Promise<void> {
  await requireWritable(host);
  let proved = await proveRename(host, payload);
  if (!proved) throw new ActionApplyError(NO_LONGER_IN_SCOPE);
  let { file, name } = proved;
  // Google renames a file that is in the trash, where it stays.
  if (file.trashed !== false) throw new ActionApplyError(FILE_IN_TRASH);
  if (name === payload.toName) throw new ActionApplyError(ALREADY_RENAMED);
  // Someone else's name is not overwritten with one chosen before theirs.
  if (name !== payload.fromName) throw new ActionApplyError(RENAMED_SINCE);
  if (file.canRename !== true) throw new ActionApplyError(CANNOT_RENAME);
}

/**
 * What an earlier send of a rename left: the file under its new name, or still under the old one,
 * which proves that send renamed nothing.
 * @throws ActionOutcomeUnknownError when the file has neither name, or cannot be proved. A look
 * that cannot read for a refusal a later approval can pass throws that refusal instead, which
 * leaves the rename pending with its marker.
 */
async function findRenamed(
  host: DriveWritesHost, payload: DriveRenameActions["renameFile"],
): Promise<{ found: void } | { conclusive: true }> {
  let proved: { name: string } | undefined;
  try {
    proved = await proveRename(host, payload);
  } catch (error) {
    if (isInsufficientScope(error)) await waitWhileRefused(host, error);
    throw error;
  }
  if (!proved) {
    await waitWhileRefused(host);
    throw new ActionOutcomeUnknownError(NO_LONGER_SHOWN);
  }
  if (proved.name === payload.toName) return { found: undefined };
  if (proved.name === payload.fromName) return { conclusive: true };
  throw new ActionOutcomeUnknownError(RENAMED_AGAIN);
}

/**
 * Makes one approved rename, looking first for what an earlier send of it may have made. The
 * marker of a send stays until the action's record is settled, so every later approval looks
 * before it sends.
 */
function rename(
  host: DriveWritesHost, id: number, payload: DriveRenameActions["renameFile"],
): Promise<void> {
  let { fileId, toName } = payload;
  return sendOnce<void>(host, id, {
    log: logger.with({ actionId: id, actionKind: "renameFile", fileId }),
    events: "drive.renames",
    look: () => findRenamed(host, payload),
    check: async () => {
      await requireStillRenamable(host, payload);
      return {};
    },
    send: async () => {
      let { name } = await host.api.renameFile(fileId, toName);
      // Not Drive's error class, so the outcome is read as open: the next approval looks.
      if (name !== toName) {
        throw new Error("Google Drive answered a rename with another name than the one asked for");
      }
    },
    repeatable: true,
    refusal: error => driveRefusal(error, RENAME_REFUSALS, "Google Drive refused this rename."),
    unconfirmed: UNCONFIRMED_RENAME,
  });
}

/** The declared Drive renames, which drive-actions.ts combines with the other Drive writes. */
export const DRIVE_RENAME_DEFINITIONS: {
  renameFile: ActionDefinition<DriveRenameActions["renameFile"], DriveWritesHost>;
} = {
  renameFile: {
    kind: DRIVE_RENAMES,
    // A rename changes no one's access: it deletes, sends, spends and grants nothing.
    autoApprovable: true,
    // A rename is not simulated: every read shows the old name until it is made.
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: payload => {
      let noun = payload.isFolder ? "folder" : "file";
      // Whoever may rename the file chose its names, so they are fields, never prose.
      let builder = buildDescription(`Rename Google Drive ${noun} ${codeSpan(payload.fileId)}.`)
        .inline("File", payload.fileId)
        .inline("Current name", payload.fromName)
        .inline("New name", payload.toName);
      return {
        title: `Rename a Google Drive ${noun}`, ...builder.finish(), implementsRevert: false,
      };
    },
    apply: async (payload, host, ctx) => {
      await rename(host, ctx.id, payload);
    },
  },
};
