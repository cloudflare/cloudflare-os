/**
 * Approval-backed Drive copies: what a copy queues, how it is described, how its file and folder
 * are proved when it is approved, how an approved copy is made, and what reads show of one that
 * waits.
 *
 * Drive copies a file server-side, so nothing of its content passes through here. An ordinary file
 * is copied under an ID reserved when the copy is queued: a send repeated after a lost answer is
 * refused with 409 and makes nothing, and the copy is found by that ID, so it is simulated under
 * it. Drive takes no reserved ID for a Google Docs, Sheets or Slides file, which a copy of one, or
 * a conversion of an Office file into one, makes. Such a copy carries a random token in an app
 * property instead, which a look searches for; Drive's search lags, so not finding it proves
 * nothing, and the copy is never sent twice. It is not simulated: its result is shown as
 * `pending:<n>` until it is made, and that ID names the copy afterwards through the made-copy
 * record kept here.
 */

import {
  ActionApplyError, type ActionDefinition, type JournalEntry, type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, codeSpan } from "@gadgets/gatekeeper-kit/action-description";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import {
  APPROVAL_READ_MAX_MS, CONVERTED_FROM_PROPERTY, COPY_TOKEN_PROPERTY, DriveApiRequestError,
  FOLDER_MIME_TYPE, isListableFolderNode, megabytes, SOURCE_MODIFIED_PROPERTY, type DriveApi,
  type DriveMadeCopy, type DriveScopeNode,
} from "./drive-api";
import { GOOGLE_NATIVE_PREFIX } from "./drive-file-read";
import { isDirectChild } from "./drive-folder-scope";
import {
  corpusOf, GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, GOOGLE_SLIDES_MIME_TYPE,
  type SimulatedEntry,
} from "./drive-session";
import type { DriveNativeType } from "./drive-types";
import {
  driveRefusal, isPendingId, PENDING_PREFIX, pendingId, provePath, requireWritable, sendOnce,
  type DriveWritesHost, type QueuedWrite, type RefusalRow,
} from "./drive-writes";
import { nativeCopyName, officeLabel, type OfficeKind } from "./office-conversion";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({
  component: "gatekeeper.google.drive.copies", vendorId: "google",
});

/** What every copy carries. */
type DriveCopyPayload = {
  /** The file copied. */
  fileId: string;
  /** Its name when queued, as an approval shows it. */
  fileName?: string;
  /** The copy's name, whole: the approval shows all of it. */
  name: string;
  /** The copy's MIME type: the file's own, or the native type it is converted to. */
  mimeType: string;
  /** The folder the copy goes into, by its own ID. */
  toFolderId: string;
  /** That folder's name when queued. */
  toName?: string;
  /** That folder is the account's own My Drive root, which the card says in words. */
  toMyDrive?: true;
  /** The shared drive that folder is in, which a copy that waits shows. */
  driveId?: string;
  /** Folder binding: the path from the bound root to the positioned folder, which holds the file. */
  folderIds?: string[];
  /** When it was queued (ISO 8601), which a copy that waits shows as its modification time. */
  queuedAt: string;
};

/** Each Drive copy, by the action kind it is queued as. */
export type DriveCopyActions = {
  /** A copy of a file that is not Google-native, made under an ID reserved when it was queued. */
  copyFile: DriveCopyPayload & {
    copyId: string;
    /** The file's size in bytes when queued, which the copy shows while it waits. */
    size?: number;
  };
  /**
   * A copy of a Google Docs, Sheets or Slides file, or of an Office file converted into one,
   * which Drive makes under an ID of its own.
   */
  copyNative: DriveCopyPayload & {
    /** The random token the copy carries in an app property, by which a look finds it. */
    token: string;
    /** Set for a conversion: the native type the Office file becomes. */
    convertTo?: DriveNativeType;
  };
};

/** One queued Drive copy. */
export type DriveCopyAction = TaggedAction<DriveCopyActions>;

/** The one kind every Drive copy is queued as. Every copy is auto-approvable. */
export const DRIVE_COPIES: ActionKind = { tag: "driveCopies", label: "Drive copies" };

/** What each native type is, as Drive and the Office conversion name it, and as a card says it. */
export const NATIVE_TYPES: Record<DriveNativeType, {
  mimeType: string; kind: OfficeKind; noun: string;
}> = {
  document: { mimeType: GOOGLE_DOC_MIME_TYPE, kind: "doc", noun: "Google Doc" },
  spreadsheet: { mimeType: GOOGLE_SHEET_MIME_TYPE, kind: "sheets", noun: "Google Sheet" },
  presentation: {
    mimeType: GOOGLE_SLIDES_MIME_TYPE, kind: "slides", noun: "Google Slides presentation",
  },
};

/** What applying a Drive copy needs of its gatekeeper beyond what every write does. */
export type DriveCopiesHost = DriveWritesHost & {
  api: Pick<DriveApi, "copyFile" | "findCopy" | "getConversionSource" | "getMaxImportSize">;
  /** Where the file a native copy made is recorded, under its action's ID. */
  madeCopies: Pick<MadeCopies, "put">;
};

/** The files native copies made, by the ID of the action that made each. */
export type MadeCopies = {
  /** The file action `id` made, if it was a native copy that was made. */
  get(id: number): string | undefined;
  /** Records that action `id` made file `fileId`. */
  put(id: number, fileId: string): void;
};

/**
 * Where the file each native copy made is kept, by action ID. Never swept: `pending:<n>` names
 * that file for as long as anything holds the ID, and action IDs are never reused.
 */
const MADE_COPY_PREFIX = "driveCopies:made:";

/** The made-copy records of one Drive binding, kept in its Durable Object's storage. */
export function madeCopies(kv: DurableObjectStorage["kv"]): MadeCopies {
  return {
    get: id => kv.get<string>(`${MADE_COPY_PREFIX}${id}`),
    put: (id, fileId) => kv.put(`${MADE_COPY_PREFIX}${id}`, fileId),
  };
}

/**
 * The refusal of a call given the ID of a copy that still waits. An auto-approval rule may make
 * the copy moments later, with no one to approve it, so this asks for a look later rather than
 * for an approval.
 */
export const COPY_WAITING =
  "That file is a copy still waiting to be made, so this cannot be done with it yet. It is made " +
  "once it is approved, which an auto-approval rule may do in moments: call getEntry() with this " +
  "ID later to see whether it has been made.";

/** The refusal of a `pending:<n>` ID that names no copy. */
export const NAMES_NO_COPY =
  "That pending ID names no copy that was made: the copy was rejected or failed, or the ID is " +
  "not a copy's.";

const NO_LONGER_IN_SCOPE = "That file is no longer in this connection's scope.";
const FILE_IN_TRASH = "That file is in the trash, so it was not copied.";
const DESTINATION_IN_TRASH = "That folder is in the trash, so nothing was copied into it.";
const CANNOT_COPY = "The connected account can no longer copy that file into that folder.";

/** Said when Drive leaves open whether a send made an ordinary copy. */
const UNCONFIRMED_COPY =
  "Google Drive did not confirm whether this copy was made, and it may have been. Approving it " +
  "again first checks for it, so it is not made twice; rejecting it leaves any copy that was made.";

/** Said when Drive leaves open whether a send made a native copy, or a look did not find one. */
const UNCONFIRMED_NATIVE_COPY =
  "Google Drive did not confirm whether this copy was made, and it may have been: Google Drive " +
  "can take a while to show a new file. It won't be sent again. Approving it again looks for the " +
  "copy once more; rejecting it leaves any copy that was made.";

/** Said when Drive does not answer a conversion's read of its file by the approval's deadline. */
const DRIVE_DID_NOT_ANSWER =
  "Google Drive did not answer in time, so nothing was copied. Approving it again tries once more.";

/** Said of a native copy Drive made of another type than asked for, as copyAsNative() says it. */
const DIFFERENT_TYPE = "Google Drive made a copy of a different type than was asked for";

/** What Drive refuses a copy for, and what the approver is told. */
const COPY_REFUSALS: readonly RefusalRow[] = [
  {
    status: 403, reason: "cannotCopyFile",
    message: "The owner of that file has turned off copying it for the connected account.",
  },
  {
    status: 404, reason: "notFound",
    message: "Google Drive no longer shows the file or the destination folder to the connected " +
      "account.",
  },
  { status: 403, reason: "insufficientFilePermissions", message: CANNOT_COPY },
  { status: 403, reason: "parentNotAFolder", message: "The destination is not a folder." },
  {
    status: 403, reason: "teamDriveFileLimitExceeded",
    message: "That shared drive already holds as many items as Google allows.",
  },
  {
    status: 403, reason: "storageQuotaExceeded",
    message: "There is no Drive storage left for this copy.",
  },
];

/** Whether `entry` is a copy: one queued under a copy definition's name. */
function isCopyEntry(entry: QueuedWrite): entry is JournalEntry<DriveCopyAction> {
  return Object.hasOwn(DRIVE_COPY_DEFINITIONS, entry.action.kind);
}

/**
 * What copy `id` shows while it waits, and the file it reports: the one it is a copy of, with a
 * folder binding's path to the folder that held it. An ordinary copy goes by the ID reserved for
 * it, any other by `pending:<id>`.
 */
export function simulatedCopy({ id, action }: { id: number; action: DriveCopyAction }): SimulatedEntry {
  let { payload } = action;
  return {
    entry: {
      id: action.kind === "copyFile" ? action.payload.copyId : pendingId(id),
      name: payload.name,
      mimeType: payload.mimeType,
      isFolder: false,
      modifiedTime: new Date(payload.queuedAt),
      ...(action.kind === "copyFile" && action.payload.size !== undefined
        ? { size: action.payload.size } : {}),
      parentId: payload.toFolderId,
      ...(payload.driveId ? { driveId: payload.driveId } : {}),
      pending: true,
    },
    sourceId: payload.fileId,
    ...(payload.folderIds ? { sourceFolderIds: payload.folderIds } : {}),
  };
}

/** The ordinary copy `fileId` names while an approval can still make it, if it is one. */
export function pendingCopy(
  fileId: string, pending: readonly QueuedWrite[],
): SimulatedEntry | undefined {
  let found = pending.filter(isCopyEntry).find(entry =>
    entry.action.kind === "copyFile" && entry.action.payload.copyId === fileId);
  return found && simulatedCopy(found);
}

/** The ordinary copies into folder `folderId` an approval can still make, as a listing shows them. */
export function pendingCopiesInto(
  folderId: string, pending: readonly QueuedWrite[],
): SimulatedEntry[] {
  return pending.filter(isCopyEntry)
    .filter(entry => entry.action.kind === "copyFile" && entry.action.payload.toFolderId === folderId)
    .map(entry => simulatedCopy(entry));
}

/** Native copy `actionId`, while an approval can still make it. */
export function waitingNativeCopy(
  actionId: number, pending: readonly QueuedWrite[],
): SimulatedEntry | undefined {
  let found = pending.find(entry => entry.id === actionId);
  return found && isCopyEntry(found) && found.action.kind === "copyNative"
    ? simulatedCopy(found) : undefined;
}

/** The action a `pending:<n>` ID names, or `undefined` for an ID of any other shape. */
export function pendingActionId(fileId: string): number | undefined {
  if (!isPendingId(fileId)) return undefined;
  let digits = fileId.slice(PENDING_PREFIX.length);
  return /^\d{1,15}$/.test(digits) ? Number(digits) : undefined;
}

/** A copy as `planCopy` decides it: which definition, of what type, under which name. */
type CopyPlan = {
  kind: keyof DriveCopyActions;
  mimeType: string;
  name: string;
  convertTo?: DriveNativeType;
};

/**
 * How a file of `source` is copied with `options`: an ordinary copy, a copy of a Google Docs,
 * Sheets or Slides file, or an Office file's conversion. Refuses a `convertTo` the file does not
 * convert to, any other Google-native file, and an empty name. A folder or a shortcut is the
 * scope proof's to refuse, before this.
 */
export function planCopy(
  source: { name: string; mimeType: string },
  options: { name?: string; convertTo?: DriveNativeType },
): CopyPlan {
  let { convertTo } = options;
  if (options.name !== undefined && !options.name.trim()) throw new Error("name is empty.");
  if (convertTo !== undefined) {
    if (!Object.hasOwn(NATIVE_TYPES, convertTo)) {
      throw new Error('convertTo is "document", "spreadsheet" or "presentation".');
    }
    let { mimeType, kind, noun } = NATIVE_TYPES[convertTo];
    if (source.mimeType === mimeType) {
      throw new Error(`That file is already a ${noun}. Leave out convertTo to copy it as it is.`);
    }
    if (officeLabel(kind, source.mimeType) === undefined) {
      throw new Error(`Only ${OFFICE_TYPES[convertTo]} converts to a ${noun}.`);
    }
    return {
      kind: "copyNative", mimeType, name: options.name ?? nativeCopyName(kind, source.name),
      convertTo,
    };
  }
  let name = options.name ?? `Copy of ${source.name}`;
  if (Object.values(NATIVE_TYPES).some(type => type.mimeType === source.mimeType)) {
    return { kind: "copyNative", mimeType: source.mimeType, name };
  }
  if (source.mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) {
    throw new Error(
      "Among Google's own file types, only Google Docs, Sheets and Slides files can be copied here.");
  }
  return { kind: "copyFile", mimeType: source.mimeType, name };
}

/** What each native type converts from, as a refusal names it. */
const OFFICE_TYPES: Record<DriveNativeType, string> = {
  document: "a .docx, .doc, .odt or .rtf file",
  spreadsheet: "an .xlsx, .xls, .xlsm or .ods file",
  presentation: "a .pptx, .ppt or .odp file",
};

/**
 * The refusal of a conversion of a file of `size` bytes into native `mimeType` when it is larger
 * than Google Drive converts, if it is. When Drive's limit cannot be read, or is not read before
 * `signal` aborts, nothing is refused, and Drive decides when the copy is sent.
 */
export async function importLimitRefusal(
  api: Pick<DriveApi, "getMaxImportSize">, fileId: string, size: number | undefined,
  mimeType: string, signal?: AbortSignal,
): Promise<string | undefined> {
  if (size === undefined || !Number.isFinite(size)) return undefined;
  let max = await api.getMaxImportSize(mimeType, signal).catch((error: unknown) => {
    logger.warn("could not read Drive's import size limit; copying without the check", {
      event: "drive.copies.import-size.unavailable", fileId,
      ...(error instanceof DriveApiRequestError ? {
        httpStatus: error.status, ...(error.reason ? { providerReasons: [error.reason] } : {}),
      } : { error }),
    });
    return undefined;
  });
  if (max === undefined || size <= max) return undefined;
  return `That file is ${megabytes(size)} MB, larger than the ${megabytes(max)} MB Google Drive ` +
    "converts into this format.";
}

/**
 * The file of a copy and the folder it goes into, as the binding's scope reaches them now, or
 * `undefined` when either is out of scope or invisible. An account binding reads both in one
 * batch. A folder binding re-proves its saved path in the same batch, then that the file is a live
 * direct child of the positioned folder and that the destination is a folder a copy may go into
 * from there: the positioned folder itself, a live listable direct child folder of it, or the
 * folder it was opened from. Whether either is in the trash, and what the account may do, is the
 * caller's to require of the nodes.
 */
async function proveCopy(
  host: Pick<DriveWritesHost, "api" | "scope">, payload: DriveCopyPayload,
): Promise<{ source: DriveScopeNode; destination: DriveScopeNode } | undefined> {
  let { fileId, toFolderId, folderIds } = payload;
  let scope = host.scope();
  // A single-file binding holds no folder to copy its file into.
  if (scope.kind === "file") return undefined;
  if (scope.kind === "account") {
    let [source, destination] = await host.api.getScopeNodes([fileId, toFolderId]);
    return source && destination ? { source, destination } : undefined;
  }
  let proved = await provePath(host, folderIds, [fileId, toFolderId]);
  if (!proved) return undefined;
  let { path, extras: [source, child] } = proved;
  let positioned = path.at(-1);
  if (!source || !positioned || !isDirectChild(source, positioned)) return undefined;
  let destination = toFolderId === positioned.id ? positioned
    : folderIds?.at(-2) === toFolderId ? path.at(-2)
    : child && isListableFolderNode(child) && isDirectChild(child, positioned) ? child
    : undefined;
  return destination && { source, destination };
}

/**
 * Why a conversion of `payload`'s file cannot be made now, if it cannot: it is larger than Drive
 * converts. Its reads wait for Drive {@link APPROVAL_READ_MAX_MS} at most, together: a file Drive
 * does not describe by then leaves the copy pending, and a limit it does not say is not checked.
 */
async function conversionRefusal(
  host: DriveCopiesHost, payload: DriveCopyPayload,
): Promise<string | undefined> {
  let deadline = AbortSignal.timeout(APPROVAL_READ_MAX_MS);
  let { size } = await host.api.getConversionSource(payload.fileId, deadline)
    .catch((error: unknown) => {
      throw deadline.aborted ? new Error(DRIVE_DID_NOT_ANSWER, { cause: error }) : error;
    });
  return importLimitRefusal(host.api, payload.fileId,
    size === undefined ? undefined : Number(size), payload.mimeType, deadline);
}

/**
 * Refuses for good a copy that may not be made at apply, having made nothing, except for a
 * refusal a later approval can pass, which leaves it pending. A copy may cross drives, as Drive
 * allows, so no drive is compared. The scope proof is the last request before the send: Drive is
 * given the folder's ID, not the path the proof walked, so a conversion's reads go first, and what
 * they refuse is said once the proof passes. A conversion takes the file's type from the proof
 * too, since only the last read before the send sees a revision that changed it to a type that
 * does not convert (https://developers.google.com/workspace/drive/api/reference/rest/v3/files#File).
 */
async function requireStillCopyable(
  host: DriveCopiesHost, payload: DriveCopyPayload & { convertTo?: DriveNativeType },
): Promise<void> {
  let { convertTo } = payload;
  await requireWritable(host);
  let converting = convertTo === undefined ? undefined : conversionRefusal(host, payload);
  await converting?.catch(() => {});
  let proved = await proveCopy(host, payload);
  if (!proved) throw new ActionApplyError(NO_LONGER_IN_SCOPE);
  let { source, destination } = proved;
  if (source.trashed !== false) throw new ActionApplyError(FILE_IN_TRASH);
  // Google copies into a folder that is in the trash, and the copy would be live in a folder no
  // listing shows.
  if (destination.trashed !== false) throw new ActionApplyError(DESTINATION_IN_TRASH);
  if (destination.mimeType !== FOLDER_MIME_TYPE || source.canCopy !== true ||
      destination.canAddChildren !== true) {
    throw new ActionApplyError(CANNOT_COPY);
  }
  if (convertTo !== undefined &&
      officeLabel(NATIVE_TYPES[convertTo].kind, source.mimeType) === undefined) {
    throw new ActionApplyError(
      `That file is no longer ${OFFICE_TYPES[convertTo]}, so it was not converted.`);
  }
  let refused = await converting;
  if (refused !== undefined) throw new ActionApplyError(refused);
}

/**
 * Makes one approved ordinary copy under its reserved ID. A look reads that ID, with the folder
 * the copy goes into: found, the copy was made; not found while the account can list that
 * folder's contents, it was not, since a copy made there takes the folder's access, and a send
 * under the same ID could make no second one anyway. Drive answers 404 for a file the account
 * cannot read as for one that does not exist
 * (https://developers.google.com/workspace/drive/api/guides/handle-errors#notFound), and answers a
 * folder whose contents the account's access no longer reaches with `canListChildren` false
 * (https://developers.google.com/workspace/drive/api/guides/limited-expansive-access#list-children-of-a-folder-with-limited-access),
 * so while the folder is not seen, or seen without its contents, the copy may be there out of the
 * account's sight, and the look proves nothing.
 */
function copyOrdinary(
  host: DriveCopiesHost, id: number, payload: DriveCopyActions["copyFile"],
): Promise<string> {
  let { fileId, copyId, name, toFolderId } = payload;
  return sendOnce<string>(host, id, {
    log: logger.with({ actionId: id, actionKind: "copyFile", fileId }),
    events: "drive.copies",
    look: async () => {
      let [made, destination] = await host.api.getScopeNodes([copyId, toFolderId]);
      return made ? { found: copyId }
        : { conclusive: destination !== undefined && isListableFolderNode(destination) };
    },
    check: async () => {
      await requireStillCopyable(host, payload);
      return {};
    },
    send: async () => {
      // `undefined`: Drive refused the ID as used, so an earlier send made the copy.
      await host.api.copyFile(fileId, { id: copyId, name, parents: [toFolderId] });
      return copyId;
    },
    repeatable: true,
    refusal: error => driveRefusal(error, COPY_REFUSALS, "Google Drive refused this copy."),
    unconfirmed: UNCONFIRMED_COPY,
    logFields: made => ({ copyFileId: made }),
  });
}

/**
 * Makes one approved native copy, with its token, and records the file it made. A look searches
 * for the token in the corpus of the folder the copy goes into as it was queued, then in every
 * file the account has reached (see DriveApi.findCopy), for {@link APPROVAL_READ_MAX_MS} at most;
 * not finding it by then leaves the copy unconfirmed and is never followed by a send. A copy
 * Drive made of another type than asked for is not the one queued, so it fails the copy rather
 * than being recorded.
 */
async function copyNative(
  host: DriveCopiesHost, id: number, payload: DriveCopyActions["copyNative"],
): Promise<void> {
  let { fileId, token, name, toFolderId, mimeType, convertTo, driveId } = payload;
  let made = await sendOnce<DriveMadeCopy>(host, id, {
    log: logger.with({ actionId: id, actionKind: "copyNative", fileId }),
    events: "drive.copies",
    look: async () => {
      let deadline = AbortSignal.timeout(APPROVAL_READ_MAX_MS);
      let found = await host.api.findCopy(token, corpusOf(driveId), deadline)
        .catch((error: unknown) => {
          if (deadline.aborted) return undefined;
          throw error;
        });
      return found ? { found } : { conclusive: false };
    },
    check: async () => {
      await requireStillCopyable(host, payload);
      return {};
    },
    send: async () => {
      let copy = await host.api.copyFile(fileId, {
        name, parents: [toFolderId], ...(convertTo === undefined ? {} : { mimeType }),
        // Drive keeps the file's own app properties unless cleared, and a conversion's markers
        // would have openGoogleDoc() offer this copy for reuse as that conversion.
        appProperties: {
          [COPY_TOKEN_PROPERTY]: token, [CONVERTED_FROM_PROPERTY]: null,
          [SOURCE_MODIFIED_PROPERTY]: null,
        },
      });
      // Not Drive's error class, so the outcome is read as open: the next approval looks.
      if (!copy) throw new Error("Google Drive answered a copy made without an ID as already made");
      return copy;
    },
    repeatable: false,
    refusal: error => driveRefusal(error, COPY_REFUSALS, "Google Drive refused this copy."),
    unconfirmed: UNCONFIRMED_NATIVE_COPY,
    logFields: copy => ({ copyFileId: copy.id }),
  });
  if (made.mimeType !== undefined && made.mimeType !== mimeType) {
    // The file Drive made stays, as any copy a rejection leaves does; nothing approves this again.
    logger.warn("Google Drive made a copy of another type than was asked for", {
      event: "drive.copies.type.mismatch", actionId: id, actionKind: "copyNative", fileId,
      copyFileId: made.id, outcome: "failed",
    });
    host.attempts.delete(id);
    throw new ActionApplyError(DIFFERENT_TYPE);
  }
  // Before the action set retires the record, so that `pending:<n>` never names nothing between.
  host.madeCopies.put(id, made.id);
}

/** The approval card of any copy. */
function describeCopy(payload: DriveCopyPayload & { convertTo?: DriveNativeType }) {
  let builder = buildDescription(`Copy Google Drive file ${codeSpan(payload.fileId)} into folder ${
    codeSpan(payload.toFolderId)}, as the connected account.`);
  if (payload.convertTo !== undefined) {
    builder.prose(`The copy is converted to a ${NATIVE_TYPES[payload.convertTo].noun}.`);
  }
  // No other account can see that folder, so the card names it in words of its own.
  if (payload.toMyDrive) {
    builder.prose("The folder it goes into is the top level of the connected account's My Drive.");
  }
  builder.prose(
    "The copy takes the sharing of the folder it goes into: everyone with access to that folder " +
    "can open it.");
  builder.inline("File", payload.fileId);
  if (payload.fileName !== undefined) builder.inline("File name", payload.fileName);
  builder.inline("Copy name", payload.name);
  builder.inline("To folder", payload.toFolderId);
  if (payload.toName !== undefined) builder.inline("To folder name", payload.toName);
  if (payload.convertTo !== undefined) {
    builder.inline("Converted to", NATIVE_TYPES[payload.convertTo].noun);
  }
  return { title: "Copy a Google Drive file", ...builder.finish(), implementsRevert: false };
}

/** The declared Drive copies, which drive-actions.ts combines with the other Drive writes. */
export const DRIVE_COPY_DEFINITIONS: {
  copyFile: ActionDefinition<DriveCopyActions["copyFile"], DriveCopiesHost>;
  copyNative: ActionDefinition<DriveCopyActions["copyNative"], DriveCopiesHost>;
} = {
  copyFile: {
    kind: DRIVE_COPIES,
    // Into the bound resource, changing no existing file's sharing: neither rule 2 nor rule 7.
    autoApprovable: true,
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: describeCopy,
    apply: async (payload, host, ctx) => {
      await copyOrdinary(host, ctx.id, payload);
    },
  },
  copyNative: {
    kind: DRIVE_COPIES,
    autoApprovable: true,
    // Drive gives the copy its ID only once it is made, so nothing can show it under that ID.
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: describeCopy,
    apply: async (payload, host, ctx) => {
      await copyNative(host, ctx.id, payload);
    },
  },
};
