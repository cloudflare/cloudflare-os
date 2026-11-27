/**
 * Approval-backed Drive uploads: what an upload queues, how its bytes are held until it is
 * decided, how it is described, how its folder is proved when it is approved, how an approved
 * upload is made, and what reads show of one that waits.
 *
 * The bytes the workspace gives are captured into the binding's own storage when the upload is
 * queued, and the payload carries only their reference: size and SHA-256 digest. An approval
 * streams them back into a resumable upload, a chunk at a time, and they are deleted once the
 * upload is decided. A new file goes under an ID reserved when it is queued, so it is simulated
 * under that ID, a repeated send is refused with 409 and makes nothing, and a look reads the ID. A
 * conversion into a Google Docs, Sheets or Slides file takes no reserved ID: it carries a random
 * token in an app property, as a native copy does, is shown as `pending:<n>`, and is never sent
 * twice. A replacement of an existing file's content first keeps that file's current version for
 * good, and is recognized afterwards by the content's checksum.
 */

import {
  ActionApplyError, ActionOutcomeUnknownError, type ActionDefinition, type JournalEntry,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, codeSpan } from "@gadgets/gatekeeper-kit/action-description";
import type { ActionFileReference, ActionFileStore } from "@gadgets/gatekeeper-kit/action-files";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import {
  DriveApiRequestError, FOLDER_MIME_TYPE, UPLOAD_TOKEN_PROPERTY, type DriveApi,
  type DriveContentVersion, type DriveFile, type DriveScopeNode,
} from "./drive-api";
import { NATIVE_TYPES, nativeConversion, proveDestination, type MadeFiles } from "./drive-copies";
import { GOOGLE_NATIVE_PREFIX } from "./drive-file-read";
import { corpusOf, type SimulatedEntry } from "./drive-session";
import type { DriveEntry, DriveNativeType } from "./drive-types";
import {
  driveRefusal, lookForToken, pendingId, requireWritable, sendOnce, uploadChecked,
  type DriveWritesHost, type QueuedWrite, type RefusalRow,
} from "./drive-writes";
import { nativeCopyName, officeLabel } from "./office-conversion";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({
  component: "gatekeeper.google.drive.uploads", vendorId: "google",
});

const MIB = 1024 * 1024;

/** The most one upload holds. */
const MAX_UPLOAD_BYTES = 100 * MIB;
/** The most a string or a `Uint8Array` upload holds, since it crosses as one message. */
const MAX_WHOLE_UPLOAD_BYTES = 25 * MIB;
/** The most every waiting upload of one binding holds together. */
export const MAX_UPLOADS_WAITING_BYTES = 1024 * MIB;
/**
 * How long bytes no waiting upload references are kept before a sweep deletes them: long enough
 * for a capture to be queued, so that a sweep never takes bytes on their way to the queue.
 */
export const UPLOAD_GRACE_MS = 60 * 60 * 1000;

/** Where an upload's bytes are kept, as the facet's file store is built over them. */
export const UPLOAD_FILE_STORE = {
  filePrefix: "driveUploads:file:",
  allocationPrefix: "driveUploads:allocation:",
  maxFileBytes: MAX_UPLOAD_BYTES,
  maxTotalBytes: MAX_UPLOADS_WAITING_BYTES,
} as const;

/** What a session keeps an upload's bytes in, and reads them back from. */
export type DriveUploadFiles = Pick<ActionFileStore, "capture" | "captureStream" | "readStream" | "delete">;

/** What an upload is given: text, bytes, or a stream of bytes. */
export type DriveUploadContent = string | Uint8Array | ReadableStream<Uint8Array>;

/** What every upload carries. */
type DriveUploadPayload = {
  /** The file's name, whole: the approval shows all of it. */
  name: string;
  /** The type the bytes are uploaded as. */
  contentType: string;
  /** The bytes, held in the binding's storage until the upload is decided. */
  file: ActionFileReference;
  /** The folder the file goes into, by its own ID. */
  toFolderId: string;
  /** That folder's name when queued. */
  toName?: string;
  /** That folder is the account's own My Drive root, which the card says in words. */
  toMyDrive?: true;
  /** The shared drive that folder is in, which an upload that waits shows. */
  driveId?: string;
  /** Folder binding: the path from the bound root to the positioned folder. */
  folderIds?: string[];
  /** When it was queued (ISO 8601), which an upload that waits shows as its modification time. */
  queuedAt: string;
};

/** Which version of its content a replaced file held when the replacement was queued. */
export type ReplacedVersion = {
  headRevisionId: string;
  sha256Checksum: string;
  /** Bytes. */
  size?: number;
  modifiedTime?: string;
};

/** Each Drive upload, by the action kind it is queued as. */
export type DriveUploadActions = {
  /** A new file, made under an ID reserved when it was queued. */
  uploadFile: DriveUploadPayload & { fileId: string };
  /** A new file Drive converts into a native type, under an ID of its own. */
  uploadConverted: DriveUploadPayload & {
    /** The random token the file carries in an app property, by which a look finds it. */
    token: string;
    convertTo: DriveNativeType;
  };
  /** New content for file `fileId`, which keeps its ID, name and sharing. */
  replaceFile: DriveUploadPayload & { fileId: string; replaced: ReplacedVersion };
};

/** One queued Drive upload. */
export type DriveUploadAction = TaggedAction<DriveUploadActions>;

/** The kind every Drive upload is queued as. */
export const DRIVE_UPLOADS: ActionKind = { tag: "driveUploads", label: "Drive uploads" };

/** What applying a Drive upload needs of its gatekeeper beyond what every write does. */
export type DriveUploadsHost = DriveWritesHost & {
  api: Pick<DriveApi, "findByToken" | "findNamed" | "getContentVersion" | "keepRevision" | "upload">;
  /** Where the file a converted upload made is recorded, under its action's ID. */
  madeFiles: Pick<MadeFiles, "put">;
  /** The bytes each upload holds. */
  uploads: Pick<DriveUploadFiles, "readStream">;
};

const NO_FOLDER = "That folder is no longer in this connection's scope, so nothing was uploaded.";
const FOLDER_IN_TRASH = "That folder is in the trash, so nothing was uploaded into it.";
const CANNOT_UPLOAD = "The connected account can no longer add files to that folder.";
const NAME_TAKEN_SINCE =
  "A file of that name has since appeared in that folder, so nothing was uploaded. Upload it " +
  "again under another name, or with overwrite: true to replace that file.";
const BYTES_GONE =
  "The uploaded bytes are no longer kept, so nothing was uploaded. Upload the file again.";
const NO_REPLACED_FILE =
  "The file this would replace is no longer in that folder, or no longer in this connection's " +
  "scope, so nothing was replaced.";
const CANNOT_REPLACE = "The connected account can no longer change that file's content.";
const NOT_THE_NAMED_FILE =
  "The file this would replace is no longer the one file of its name in that folder: it was " +
  "renamed, or another file of the name appeared there. Nothing was replaced; upload it again to " +
  "replace the file of that name as it is now.";
const CHANGED_SINCE_QUEUED =
  "That file changed since this was queued, so it was not replaced: approving it would have " +
  "discarded that change from the file's current content. Upload it again to replace the file as " +
  "it is now.";
const PIN_REFUSED =
  "Google Drive refused to keep the file's current version for good, so it was not replaced. " +
  "Drive keeps at most 200 versions of a file for good: in the file's version history, stop " +
  "keeping one, then upload it again.";

/** Said when Drive leaves open whether a send made a new file under its reserved ID. */
const UNCONFIRMED_UPLOAD =
  "Google Drive did not confirm whether this file was uploaded, and it may have been. Approving " +
  "it again first checks for it, so it is not uploaded twice; rejecting it leaves any file that " +
  "was made.";

/** Said when Drive leaves open whether a converted upload was made, or a look did not find it. */
const UNCONFIRMED_CONVERTED =
  "Google Drive did not confirm whether this file was uploaded, and it may have been: Google " +
  "Drive can take a while to show a new file. It won't be sent again. Approving it again looks " +
  "for the file once more; rejecting it leaves any file that was made.";

/** Said when Drive leaves open whether a replacement was made. */
const UNCONFIRMED_REPLACE =
  "Google Drive did not confirm whether the file's content was replaced, and it may have been. " +
  "Approving it again first reads the file's content checksum, so it is not replaced twice.";

/** Said when the content found is neither the old one nor the upload. */
const REPLACED_BY_OTHER =
  "That file's content is now neither what it held when this was queued nor this upload, so " +
  "whether this replacement was made cannot be told. Check the file's version history.";

/** What Drive refuses an upload for, and what the approver is told. */
const UPLOAD_REFUSALS: readonly RefusalRow[] = [
  {
    status: 404, reason: "notFound",
    message: "Google Drive no longer shows the destination folder or the file to the connected " +
      "account.",
  },
  { status: 403, reason: "insufficientFilePermissions", message: CANNOT_UPLOAD },
  { status: 403, reason: "parentNotAFolder", message: "The destination is not a folder." },
  {
    status: 403, reason: "teamDriveFileLimitExceeded",
    message: "That shared drive already holds as many items as Google allows.",
  },
  {
    status: 403, reason: "storageQuotaExceeded",
    message: "There is no Drive storage left for this upload.",
  },
];

/** The refusal of an upload larger than one holds. */
const TOO_LARGE = `An upload holds at most ${MAX_UPLOAD_BYTES / MIB} MB.`;
/** The refusal of a string or bytes larger than one call carries. */
const TOO_LARGE_WHOLE =
  `A string or Uint8Array upload holds at most ${MAX_WHOLE_UPLOAD_BYTES / MIB} MB. Pass a ` +
  `ReadableStream<Uint8Array> for a larger file, up to ${MAX_UPLOAD_BYTES / MIB} MB.`;
/** The refusal of an upload that would hold more than the binding keeps waiting at once. */
const TOO_MUCH_WAITING =
  `Uploads waiting for approval here already hold close to ${MAX_UPLOADS_WAITING_BYTES / MIB / 1024} ` +
  "GB, so this one cannot be kept. Upload it once some are decided.";
const EMPTY_CONVERSION = "An empty file cannot be converted. Leave out convertTo, or upload content.";
const OVERWRITE_CONVERTS =
  "overwrite cannot be combined with convertTo: a conversion makes a new Google file, and an " +
  "upload replaces only a file's own bytes.";
const NAME_TAKEN =
  "A file of that name is already in that folder. Choose another name, or pass overwrite: true " +
  "to replace that file's content.";
/** The refusal of an upload named as a copy or an upload waiting to go into the same folder. */
export const NAME_WAITING =
  "A copy or an upload of that name is already waiting for approval to go into that folder, and " +
  "overwrite replaces only a file that is there. Choose another name, or upload it once that one " +
  "is decided.";
const NAME_AMBIGUOUS =
  "More than one file of that name is in that folder, so overwrite cannot tell which to replace. " +
  "Upload it under another name.";
const NOT_REPLACEABLE =
  "The item of that name in that folder is a folder, a shortcut or a Google file, whose content " +
  "an upload cannot replace. Upload it under another name.";
const CANNOT_EDIT =
  "The connected account cannot change the content of the file of that name in that folder.";
const NO_CHECKSUM =
  "Google Drive reports no content checksum for the file of that name in that folder, so its " +
  "content cannot be replaced here. Upload it under another name.";

/**
 * The file among `named`, the live files in the destination named as the upload is, that it
 * replaces, or `undefined` when there is none. Without `overwrite` any file there is refused, and
 * with it more than one, or a folder, a shortcut or a Google file.
 */
export function replacedFile(
  named: readonly DriveFile[], overwrite: boolean | undefined,
): DriveFile | undefined {
  if (!named.length) return undefined;
  if (!overwrite) throw new Error(NAME_TAKEN);
  if (named.length > 1) throw new Error(NAME_AMBIGUOUS);
  let [file] = named;
  if (file.mimeType === undefined || file.mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) {
    throw new Error(NOT_REPLACEABLE);
  }
  return file;
}

/**
 * What a replacement records of the version it replaces, which approving it checks is still the
 * file's, refused when the account cannot change the file's content or Drive gives no checksum to
 * tell it by.
 */
export function replacedVersion(version: DriveContentVersion): ReplacedVersion {
  if (version.canModifyContent !== true) throw new Error(CANNOT_EDIT);
  let { headRevisionId, sha256Checksum, size, modifiedTime } = version;
  if (headRevisionId === undefined || sha256Checksum === undefined) throw new Error(NO_CHECKSUM);
  let bytes = Number(size);
  return {
    headRevisionId, sha256Checksum,
    ...(size !== undefined && Number.isSafeInteger(bytes) ? { size: bytes } : {}),
    ...(modifiedTime === undefined ? {} : { modifiedTime }),
  };
}

/** The bytes of `content`, as the store keeps them, refused when larger than one call carries. */
export function uploadBytes(content: DriveUploadContent): Uint8Array | ReadableStream<Uint8Array> {
  if (content instanceof ReadableStream) return content;
  let bytes: Uint8Array;
  if (typeof content === "string") {
    // UTF-8 takes at least a byte per UTF-16 unit, so a string this long is too large unencoded.
    if (content.length > MAX_WHOLE_UPLOAD_BYTES) throw new Error(TOO_LARGE_WHOLE);
    bytes = new TextEncoder().encode(content);
  } else {
    bytes = content;
  }
  if (bytes.byteLength > MAX_WHOLE_UPLOAD_BYTES) throw new Error(TOO_LARGE_WHOLE);
  return bytes;
}

/**
 * Keeps `bytes` in `files` until the upload is decided. A stream is read to its end here, straight
 * into the store. The store's refusals of a file too large, or of more than it keeps at once, are
 * said in the upload's terms.
 */
export async function captureUpload(
  files: Pick<DriveUploadFiles, "capture" | "captureStream">,
  bytes: Uint8Array | ReadableStream<Uint8Array>,
): Promise<ActionFileReference> {
  try {
    return bytes instanceof ReadableStream
      ? await files.captureStream(bytes) : await files.capture(bytes);
  } catch (error) {
    // The store says these in its own words, which name no upload.
    if (error instanceof Error && error.message.startsWith("Cannot retain a queued-action file larger")) {
      throw new Error(TOO_LARGE, { cause: error });
    }
    if (error instanceof Error &&
        error.message.startsWith("Queued-action files exceed the safe aggregate storage limit")) {
      throw new Error(TOO_MUCH_WAITING, { cause: error });
    }
    throw error;
  }
}

/** The types an upload's name tells, by its extension, beside those of the Office types. */
const TYPES_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values",
  html: "text/html", htm: "text/html", json: "application/json", xml: "application/xml",
  pdf: "application/pdf", rtf: "application/rtf", epub: "application/epub+zip",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword", xls: "application/vnd.ms-excel",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12", ppt: "application/vnd.ms-powerpoint",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};

const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/**
 * The type `content` named `name` is uploaded as: `mimeType` when given, else what the name's
 * extension tells, else `fallback`, else text for a string and bytes of no known type otherwise.
 * Google's own types are refused: nothing uploads as one.
 */
export function uploadContentType(
  name: string, content: unknown, mimeType: string | undefined, fallback?: string,
): string {
  if (mimeType !== undefined) {
    if (!MIME_TYPE_PATTERN.test(mimeType)) throw new Error("mimeType is not a MIME type.");
    if (mimeType.toLowerCase().startsWith(GOOGLE_NATIVE_PREFIX)) {
      throw new Error("mimeType names a Google file type, which an upload cannot be. Upload an " +
        "Office file with convertTo to make a Google file.");
    }
    return mimeType;
  }
  let extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  // Own keys only: a name ending `.constructor` would otherwise find Object's.
  let byExtension = extension !== undefined && Object.hasOwn(TYPES_BY_EXTENSION, extension)
    ? TYPES_BY_EXTENSION[extension] : undefined;
  return byExtension ?? fallback ??
    (typeof content === "string" ? "text/plain" : "application/octet-stream");
}

/** The refusals an upload's options meet before anything is read or kept. */
export function requireUploadOptions(
  name: string, options: { overwrite?: boolean; convertTo?: string },
): void {
  if (!name.trim()) throw new Error("name is empty.");
  if (options.overwrite && options.convertTo !== undefined) throw new Error(OVERWRITE_CONVERTS);
}

/**
 * The delimited text types an upload converts into a Google Sheet, beside the Office types, by
 * the extension each is named with. Drive imports CSV and TSV into Sheets
 * (https://developers.google.com/workspace/drive/api/guides/manage-uploads#import_to_google_docs_types).
 * A copy does not take them.
 */
const SHEET_TEXT_TYPES: Record<string, string> = {
  "text/csv": "csv", "text/tab-separated-values": "tsv",
};

const NOT_SHEET_SOURCE =
  "Only an .xlsx, .xls, .xlsm, .ods, .csv or .tsv file converts to a Google Sheet.";

/** What a converted upload becomes, refused for a type that does not convert into it. */
export function uploadConversion(
  name: string, contentType: string, convertTo: DriveNativeType,
): { mimeType: string; name: string } {
  if (convertTo === "spreadsheet") {
    let type = contentType.toLowerCase();
    let extension = Object.hasOwn(SHEET_TEXT_TYPES, type) ? SHEET_TEXT_TYPES[type] : undefined;
    if (extension !== undefined) {
      let suffix = `.${extension}`;
      let named = name.toLowerCase().endsWith(suffix) && name.length > suffix.length
        ? name.slice(0, -suffix.length) : name;
      return { mimeType: NATIVE_TYPES.spreadsheet.mimeType, name: named };
    }
    if (officeLabel(NATIVE_TYPES.spreadsheet.kind, contentType) === undefined) {
      throw new Error(NOT_SHEET_SOURCE);
    }
  }
  let native = nativeConversion(contentType, convertTo);
  return { mimeType: native.mimeType, name: nativeCopyName(native.kind, name) };
}

/** Refuses an empty upload Drive is asked to convert. */
export function requireConvertible(file: ActionFileReference): void {
  if (file.size === 0) throw new Error(EMPTY_CONVERSION);
}

/** Whether `entry` is an upload: one queued under an upload definition's name. */
export function isUploadEntry(entry: QueuedWrite): entry is JournalEntry<DriveUploadAction> {
  return isUploadAction(entry.action);
}

function isUploadAction(action: QueuedWrite["action"]): action is DriveUploadAction {
  return Object.hasOwn(DRIVE_UPLOAD_DEFINITIONS, action.kind);
}

/** The bytes the upload a journal record holds keeps, if it is an upload. */
export function uploadFileOf({ action }: Pick<QueuedWrite, "action">): ActionFileReference | undefined {
  return isUploadAction(action) ? action.payload.file : undefined;
}

/**
 * What upload `id` returns: a new file goes by the ID reserved for it, a converted one by
 * `pending:<id>`, and a replacement by the file it replaces, with the new content's size.
 */
export function uploadEntry({ id, action }: { id: number; action: DriveUploadAction }): DriveEntry {
  let { payload } = action;
  return {
    id: action.kind === "uploadConverted" ? pendingId(id) : action.payload.fileId,
    name: payload.name,
    mimeType: action.kind === "uploadConverted"
      ? NATIVE_TYPES[action.payload.convertTo].mimeType : payload.contentType,
    isFolder: false,
    modifiedTime: new Date(payload.queuedAt),
    ...(action.kind === "uploadConverted" ? {} : { size: payload.file.size }),
    parentId: payload.toFolderId,
    ...(payload.driveId ? { driveId: payload.driveId } : {}),
    pending: true,
  };
}

/**
 * What upload `id` shows while it waits, if anything: the entry it returned. A replacement shows
 * nothing of its own; the file it replaces reads as it is until it is approved.
 */
export function simulatedUpload(
  queued: { id: number; action: DriveUploadAction },
): SimulatedEntry | undefined {
  let { action } = queued;
  if (action.kind === "replaceFile") return undefined;
  return {
    entry: uploadEntry(queued), content: { kind: "upload", file: action.payload.file },
  };
}

/**
 * The bytes `file` holds, for an apply's check to hand to its send, refused for good when they are
 * no longer kept: the upload can then never be made.
 */
async function storedBytes(
  host: DriveUploadsHost, file: ActionFileReference,
): Promise<ReadableStream<Uint8Array>> {
  try {
    return await host.uploads.readStream(file);
  } catch (error) {
    throw new ActionApplyError(BYTES_GONE, { cause: error });
  }
}

/**
 * Refuses for good an upload whose folder the binding no longer reaches as a live folder the
 * account may add to, having made nothing. With `replacing`, also the file replaced, which must
 * still be a live direct child of that folder whose content the account may change. Made at the
 * check and again before the request that makes the file, which can come long after it.
 * @returns The folder, as read now.
 */
async function requireUploadScope(
  host: DriveUploadsHost, payload: DriveUploadPayload, replacing?: string,
): Promise<DriveScopeNode> {
  let proved = await proveDestination(host, payload, replacing === undefined ? [] : [replacing]);
  if (!proved) throw new ActionApplyError(NO_FOLDER);
  let { destination, nodes: [replaced] } = proved;
  if (destination.trashed !== false) throw new ActionApplyError(FOLDER_IN_TRASH);
  if (destination.mimeType !== FOLDER_MIME_TYPE || destination.canAddChildren !== true) {
    throw new ActionApplyError(CANNOT_UPLOAD);
  }
  if (replacing === undefined) return destination;
  if (!replaced || replaced.trashed !== false || replaced.parents?.length !== 1 ||
      replaced.parents[0] !== destination.id) {
    throw new ActionApplyError(NO_REPLACED_FILE);
  }
  if (replaced.canModifyContent !== true) throw new ActionApplyError(CANNOT_REPLACE);
  return destination;
}

/**
 * Refuses for good an upload that may not be made at apply, having made nothing, except for a
 * refusal a later approval can pass, which leaves it pending: {@link requireUploadScope}, and the
 * files of its name in the folder, none for a new file and only the file replaced for a
 * replacement.
 */
async function requireStillUploadable(
  host: DriveUploadsHost, payload: DriveUploadPayload, replacing?: string,
): Promise<void> {
  await requireWritable(host);
  let destination = await requireUploadScope(host, payload, replacing);
  // Drive takes any number of files of one name; an upload is checked against them only when
  // queued, so a file of that name made since, or a replaced file renamed since, is refused here.
  let named = await host.api.findNamed(destination.id, payload.name, corpusOf(destination.driveId));
  if (replacing === undefined) {
    if (named.length) throw new ActionApplyError(NAME_TAKEN_SINCE);
  } else if (named.length !== 1 || named[0].id !== replacing) {
    throw new ActionApplyError(NOT_THE_NAMED_FILE);
  }
}

/**
 * Makes one approved new file under its reserved ID. A look reads that ID: found, the upload was
 * made; not found, it was not, and a send under the same ID could make no second one anyway.
 */
function uploadReserved(
  host: DriveUploadsHost, id: number, payload: DriveUploadActions["uploadFile"],
): Promise<string> {
  let { fileId, name, toFolderId, contentType, file } = payload;
  let bytes: ReadableStream<Uint8Array> | undefined;
  return sendOnce<string>(host, id, {
    log: logger.with({ actionId: id, actionKind: "uploadFile", fileId }),
    events: "drive.uploads",
    look: async () => {
      let [made] = await host.api.getScopeNodes([fileId]);
      return made ? { found: fileId } : { conclusive: true };
    },
    check: async () => {
      await requireStillUploadable(host, payload);
      bytes = await storedBytes(host, file);
      return {};
    },
    send: async () => {
      // `undefined`: Drive refused the ID as used, so an earlier send made the file.
      await uploadChecked(host.api, bytes!, contentType, { create: { id: fileId, name, parents: [toFolderId] } },
        () => requireUploadScope(host, payload));
      return fileId;
    },
    repeatable: true,
    refusal: error => driveRefusal(error, UPLOAD_REFUSALS, "Google Drive refused this upload."),
    unconfirmed: UNCONFIRMED_UPLOAD,
  });
}

/**
 * Makes one approved converted upload, with its token, and records the file it made. A look
 * searches for the token in the corpus of the folder the upload goes into, for as long as
 * lookForToken allows; not finding it leaves the upload unconfirmed and is never followed by a
 * send.
 */
async function uploadConverted(
  host: DriveUploadsHost, id: number, payload: DriveUploadActions["uploadConverted"],
): Promise<void> {
  let { token, name, toFolderId, contentType, file, convertTo } = payload;
  let { mimeType } = NATIVE_TYPES[convertTo];
  let bytes: ReadableStream<Uint8Array> | undefined;
  let made = await sendOnce<string>(host, id, {
    log: logger.with({ actionId: id, actionKind: "uploadConverted" }),
    events: "drive.uploads",
    look: async () => {
      let found = await lookForToken(host.api, UPLOAD_TOKEN_PROPERTY, token, corpusOf(payload.driveId));
      return found ? { found: found.id } : { conclusive: false };
    },
    check: async () => {
      await requireStillUploadable(host, payload);
      bytes = await storedBytes(host, file);
      return {};
    },
    send: async () => {
      let uploaded = await uploadChecked(host.api, bytes!, contentType, {
        create: { name, parents: [toFolderId], mimeType, appProperties: { [UPLOAD_TOKEN_PROPERTY]: token } },
      }, () => requireUploadScope(host, payload));
      // Not Drive's error class, so the outcome is read as open: the next approval looks.
      if (!uploaded) throw new Error("Google Drive answered an upload made without an ID as already made");
      return uploaded.id;
    },
    repeatable: false,
    refusal: error => driveRefusal(error, UPLOAD_REFUSALS, "Google Drive refused this upload."),
    unconfirmed: UNCONFIRMED_CONVERTED,
    logFields: made => ({ fileId: made }),
  });
  // Before the action set retires the record, so that `pending:<n>` never names nothing between.
  host.madeFiles.put(id, made);
}

/**
 * Replaces one approved file's content, having kept its current version for good. A look reads
 * the content's checksum: the upload's, it was replaced; the one recorded when it was queued, it
 * was not; any other, which cannot be told, is left for the approver.
 */
function replaceContent(
  host: DriveUploadsHost, id: number, payload: DriveUploadActions["replaceFile"],
): Promise<string> {
  let { fileId, replaced, contentType, file } = payload;
  let bytes: ReadableStream<Uint8Array> | undefined;
  return sendOnce<string>(host, id, {
    log: logger.with({ actionId: id, actionKind: "replaceFile", fileId }),
    events: "drive.uploads",
    look: async () => {
      let { sha256Checksum } = await host.api.getContentVersion(fileId);
      if (sha256Checksum === file.digest) return { found: fileId };
      if (sha256Checksum === replaced.sha256Checksum) return { conclusive: true };
      return { conclusive: false, retry: new ActionOutcomeUnknownError(REPLACED_BY_OTHER) };
    },
    check: async () => {
      await requireStillUploadable(host, payload, fileId);
      let now = await host.api.getContentVersion(fileId);
      if (now.headRevisionId !== replaced.headRevisionId ||
          now.sha256Checksum !== replaced.sha256Checksum) {
        throw new ActionApplyError(CHANGED_SINCE_QUEUED);
      }
      let kept = await storedBytes(host, file);
      try {
        // The pin changes the file, which may have left the binding while its version was read.
        await requireUploadScope(host, payload, fileId);
        // Drive drops an old version in time unless it is kept for good, and the card promises it
        // stays restorable.
        await host.api.keepRevision(fileId, replaced.headRevisionId).catch((error: unknown) => {
          if (error instanceof DriveApiRequestError && (error.status === 400 || error.status === 403) &&
              error.reason !== "rateLimitExceeded" && error.reason !== "userRateLimitExceeded") {
            throw new ActionApplyError(`${PIN_REFUSED} [http=${error.status}${
              error.reason === undefined ? "" : ` reason=${error.reason}`}]`, { cause: error });
          }
          throw error;
        });
      } catch (error) {
        await kept.cancel().catch(() => {});
        throw error;
      }
      bytes = kept;
      return {};
    },
    send: async () => {
      await uploadChecked(host.api, bytes!, contentType, { replace: fileId },
        () => requireUploadScope(host, payload, fileId));
      return fileId;
    },
    repeatable: true,
    refusal: error => driveRefusal(error, UPLOAD_REFUSALS, "Google Drive refused this upload."),
    unconfirmed: UNCONFIRMED_REPLACE,
  });
}

/** The approval card of any upload. */
function describeUpload(
  payload: DriveUploadPayload & {
    convertTo?: DriveNativeType; fileId?: string; replaced?: ReplacedVersion;
  },
) {
  let replacing = payload.replaced !== undefined;
  let builder = buildDescription(replacing
    ? `Replace the content of Google Drive file ${codeSpan(payload.fileId ?? "")} in folder ${
      codeSpan(payload.toFolderId)} with an uploaded file, as the connected account.`
    : `Upload a file into Google Drive folder ${codeSpan(payload.toFolderId)}, as the connected ` +
      "account.");
  if (payload.convertTo !== undefined) {
    builder.prose(`Google Drive converts the upload into a ${NATIVE_TYPES[payload.convertTo].noun}.`);
  }
  // No other account can see that folder, so the card names it in words of its own.
  if (payload.toMyDrive) {
    builder.prose("The folder it goes into is the top level of the connected account's My Drive.");
  }
  builder.prose(replacing
    ? "The file keeps its sharing: everyone it is shared with can open the new content. Its " +
      "current version stays in its version history, kept for good: to restore it, open the " +
      "file's version history in Google Drive (File > Version history in a Google editor, or " +
      "Manage versions) and restore or download that version."
    : "The file takes the sharing of the folder it goes into: everyone with access to that " +
      "folder can open it.");
  builder.inline("Name", payload.name);
  if (payload.fileId !== undefined && replacing) builder.inline("Replaces", payload.fileId);
  builder.inline("To folder", payload.toFolderId);
  if (payload.toName !== undefined) builder.inline("To folder name", payload.toName);
  builder.inline("Type", payload.contentType);
  builder.inline("Size", `${payload.file.size} bytes`);
  if (payload.convertTo !== undefined) {
    builder.inline("Converted to", NATIVE_TYPES[payload.convertTo].noun);
  }
  builder.file("File", {
    name: payload.name, mediaType: payload.contentType, size: payload.file.size,
    sha256: payload.file.digest, origin: "agent",
  });
  return {
    title: replacing ? "Replace a Google Drive file's content" : "Upload a file to Google Drive",
    ...builder.finish(), implementsRevert: false,
  };
}

/** The declared Drive uploads, which drive-actions.ts combines with the other Drive writes. */
export const DRIVE_UPLOAD_DEFINITIONS: {
  uploadFile: ActionDefinition<DriveUploadActions["uploadFile"], DriveUploadsHost>;
  uploadConverted: ActionDefinition<DriveUploadActions["uploadConverted"], DriveUploadsHost>;
  replaceFile: ActionDefinition<DriveUploadActions["replaceFile"], DriveUploadsHost>;
} = {
  uploadFile: {
    kind: DRIVE_UPLOADS,
    // Posting into the bound resource, changing no existing file's sharing: no rule applies.
    autoApprovable: true,
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: describeUpload,
    apply: async (payload, host, ctx) => {
      await uploadReserved(host, ctx.id, payload);
    },
  },
  uploadConverted: {
    kind: DRIVE_UPLOADS,
    autoApprovable: true,
    // Drive gives the file its ID only once it is made, so nothing can show it under that ID.
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: describeUpload,
    apply: async (payload, host, ctx) => {
      await uploadConverted(host, ctx.id, payload);
    },
  },
  replaceFile: {
    kind: DRIVE_UPLOADS,
    // Rule 1: it replaces an existing file's content.
    autoApprovable: false,
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: describeUpload,
    apply: async (payload, host, ctx) => {
      await replaceContent(host, ctx.id, payload);
    },
  },
};
