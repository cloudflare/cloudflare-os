// What the Doc, Sheets, Slides and Drive gatekeepers share to simulate a file or folder
// GatekeeperVendor createResource() was asked for, and to create it once a user approves.
//
// Imports neither google.ts nor slides.ts, both of which import this.

import type {
  ActionDescription, GatekeeperUserVerifier, SupportedResource,
} from "@gadgets/workshop-shared/gatekeeper";
import { buildDescription, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import { AccessTokenCache, type AccessTokenProvider } from "./auth-retry";
import {
  DriveApi, isAddableFolderFile, isFileInvisible, isListableFolderFile, MY_DRIVE_ROOT, type DriveFile,
} from "./drive-api";
import type { GoogleVerifierApi } from "./google-verifier-types";
import { obsContext } from "./observability";
import {
  CREATED_FILES_GRANT, GOOGLE_DRIVE_FOLDER_RESOURCE, nativeFileUrl, parseResourceUrl, type CreatableKind,
} from "./resources";

const logger = obsContext.createLogger({ component: "gatekeeper.google.creation", vendorId: "google" });

/**
 * Props GatekeeperVendor.createResource() mints a simulated Doc, Sheet, Presentation or Drive
 * folder with: no account, only what to create.
 */
export type SimulatedFileProps = { creation: { title: string } };

/** Whether a gatekeeper's props describe a file not yet created. */
export function isSimulated<P extends object>(props: P | SimulatedFileProps): props is SimulatedFileProps {
  return "creation" in props;
}

/** The file ID a simulated file's reads report (Sheets/Slides `id`): it has none until created. */
export const UNCREATED_FILE_ID = "";

const FILE_NOUNS: Record<CreatableKind, string> = {
  doc: "Google Doc", sheets: "Google spreadsheet", slides: "Google Slides presentation",
  driveFolder: "Google Drive folder",
};

/** A created file's props: the account and file its gatekeeper reaches. Throws for a simulated one. */
export function boundProps<P extends object>(props: P | SimulatedFileProps, kind: CreatableKind): P {
  if (isSimulated(props)) {
    throw new Error(
      `This ${FILE_NOUNS[kind]} doesn't exist yet: it is created when a user approves its creation.`);
  }
  return props;
}

const MAX_NEW_FILE_TITLE_LENGTH = 256;

/**
 * The title to create a file with: `title`, trimmed. Refuses one the agent should fix: blank, longer
 * than MAX_NEW_FILE_TITLE_LENGTH, or holding a control character or line break (U+2028, U+2029).
 */
export function newFileTitle(title: string): string {
  let trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NEW_FILE_TITLE_LENGTH ||
      /[\p{Cc}\p{Zl}\p{Zp}]/u.test(trimmed)) {
    throw new Error(
      `A new Google file needs a one-line title of 1 to ${MAX_NEW_FILE_TITLE_LENGTH} characters.`);
  }
  return trimmed;
}

/** The creation card createResource() returns for `resource`. */
export function creationAction(resource: SupportedResource, title: string): ActionDescription {
  return {
    title: sanitizeTitle(`Create ${resource.title}: ${title}`),
    ...buildDescription(
      `Create a new, empty ${resource.title} in the Google account and Drive folder you choose.`)
      .inline("Title", title).finish(),
    // The kernel never auto-applies a creation, so the card says so and names no kind.
    implementsRevert: false,
    autoApprovable: false,
  };
}

/**
 * The folder a creation's `configuration` puts it in: the Drive folder URL the creation location
 * configurator (`configurator/creation-location-configurator-ui.tsx`) minted, or, for null (no
 * choice), My Drive.
 */
function creationFolderId(configuration: string | null): string {
  if (configuration === null) return MY_DRIVE_ROOT;
  let target = parseResourceUrl(configuration);
  if (target.kind !== "driveFolder") throw new Error("A new Google file can only be put in a Google Drive folder.");
  return target.folderId;
}

const folderName = (folderId: string) => folderId === MY_DRIVE_ROOT ? "My Drive" : `the folder ${folderId}`;

/** What an approver's account is told when it lacks a grant a creation needs. */
const MISSING_GRANTS: Record<string, string> = {
  [CREATED_FILES_GRANT]: "hasn't let this app put what it creates in Drive folders. " +
    "Approve it again and allow access when asked.",
  [GOOGLE_DRIVE_FOLDER_RESOURCE.urlPattern]: "hasn't granted Google Drive Folder access, so the new " +
    "folder's connection could read only what this app puts in it. Grant it, then approve this again.",
};

/** Refuses an account that has not granted all of `grants`. */
async function requireGrants(account: { getGrantedResourceUrlPatterns(): Promise<string[]> }, grants: string[]) {
  if (grants.length === 0) return;
  let granted = await account.getGrantedResourceUrlPatterns();
  let missing = grants.find(grant => !granted.includes(grant));
  if (missing !== undefined) throw new Error(`This Google account ${MISSING_GRANTS[missing]}`);
}

/**
 * Folder `folderId`, refusing one nothing can be put in: gone, trashed, not a folder, or without
 * `canAddChildren`. The picker offers none of those, but `configuration` is caller input, and the
 * folder may have changed since it was picked.
 */
async function destinationFolder(drive: DriveApi, folderId: string): Promise<DriveFile> {
  let folder = await drive.getFile(folderId).catch((error: unknown) => {
    if (isFileInvisible(error)) return undefined;
    throw error;
  });
  if (!folder || !isAddableFolderFile(folder)) {
    throw new Error(`The Google account creating this can't add files to ${folderName(folderId)}. ` +
      "Approve it again with a folder that account can add files to.");
  }
  return folder;
}

/** The refusal for a file this approval created that is gone, trashed, or out of its account's reach. */
const goneError = (kind: CreatableKind, cause?: unknown) => new Error(`The ${FILE_NOUNS[kind]} created ` +
  "for this approval is gone or in the trash, or its Google account can no longer reach it. Reject the " +
  "creation and ask for a new one.", { cause });

/** File `fileId`, which this approval created, refusing it once its account can no longer see it. */
function readCreated(drive: DriveApi, kind: CreatableKind, fileId: string): Promise<DriveFile> {
  return drive.getFile(fileId).catch((error: unknown) => {
    throw isFileInvisible(error) ? goneError(kind, error) : error;
  });
}

/**
 * Moves file `fileId` into `folder` unless that is already its only parent. Reads the parents
 * rather than trusting the receipt: an earlier move may have taken effect with its reply lost.
 */
async function moveInto(drive: DriveApi, kind: CreatableKind, fileId: string, folder: DriveFile): Promise<void> {
  let { parents = [] } = await readCreated(drive, kind, fileId);
  if (parents.length === 1 && parents[0] === folder.id) return;
  await drive.moveFile(fileId, folder.id, parents.filter(parent => parent !== folder.id)).catch((error: unknown) => {
    throw new Error(`The ${FILE_NOUNS[kind]} at ${nativeFileUrl(kind, fileId)} was created, but moving ` +
      `it into "${folder.name}" failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  });
  logger.info("moved a created file", { event: "google.creation.file.moved", fileId, folderId: folder.id });
}

/**
 * The receipt of a file created for a pending creation, kept so a retry binds the same file: the
 * account it is in, and the folder this gatekeeper last put it in, or null while a move's outcome,
 * or whether a folder was made under the receipt's reserved ID, is unknown. A receipt from before
 * folders has no `folderId`: its file is in My Drive.
 */
type CreatedFile = { userObjectId: string; fileId: string; folderId?: string | null };

const CREATED_FILE_KEY = "createdFile";

/**
 * Creates the file a simulated facet stands for in the approver's account and puts it in the
 * folder `configuration` names, recording a receipt so a retried applyCreation() binds the same
 * file instead of making another. `create` makes a Doc, Sheet or Presentation, in My Drive, as the
 * Docs, Sheets and Slides APIs cannot name a folder, and it is moved from there: Drive's own
 * `files.create` could place it, but would lose what the simulations rely on, a spreadsheet's
 * locale-independent `Sheet1` and a new presentation's fixed object IDs. Without `create`, it is a
 * Drive folder, which Drive makes in place. A Doc, Sheet or Presentation kept in My Drive takes no
 * Drive call, so an account holding only its type's own scope can still create one.
 *
 * A retry keeps the receipt's account: after a lost success it binds the file the first approval
 * made. Only that account's approver may move the file, so another approver's retry for anywhere
 * but where it is is refused. Every approval brings the file to its own choice before the binding
 * switches, so nothing queued against it applies elsewhere.
 *
 * A folder is made under an ID Drive generated, recorded before the create is sent, so a retry
 * that cannot tell whether it was made sends it again and Drive makes it at most once. The Docs,
 * Sheets and Slides APIs take no such ID or idempotency key, so one of their files can still be
 * orphaned: by a create POST that times out or fails 5xx after Google acted (the retry creates
 * again), or a crash between the reply and the receipt write. A creation rejected after a lost
 * success orphans either, since the facet's storage, and so the receipt, is deleted. A created
 * file's ID is logged once its create's reply arrives; an orphan whose reply was lost has to be
 * found in the approver's Drive.
 *
 * Callers serialize calls with a Mutex.
 */
export async function createFileOnce(
  ctx: DurableObjectState<object>,
  creator: Fetcher<GatekeeperUserVerifier>,
  kind: CreatableKind,
  configuration: string | null,
  create?: (title: string, getAccessToken: AccessTokenProvider) => Promise<string>,
): Promise<{ userObjectId: string; fileId: string; resourceUrl: string; getAccessToken: AccessTokenProvider }> {
  let props = ctx.props;
  if (!isSimulated(props)) throw new Error(`This ${FILE_NOUNS[kind]} already exists.`);
  let inPlace = create === undefined;
  let folderId = creationFolderId(configuration);
  let approverId = await (creator as unknown as Fetcher<GoogleVerifierApi>).getUserObjectId();
  let receipt = ctx.storage.kv.get<CreatedFile>(CREATED_FILE_KEY);
  let userObjectId = receipt?.userObjectId ?? approverId;
  // Where the file is, or is about to be made; null while unknown.
  let { folderId: placedIn = MY_DRIVE_ROOT } = receipt ?? { folderId: inPlace ? folderId : MY_DRIVE_ROOT };
  let moving = placedIn !== folderId;
  // `root` names each account's own My Drive, so another approver's choice of it is elsewhere too.
  if (userObjectId !== approverId && (moving || folderId === MY_DRIVE_ROOT && configuration !== null)) {
    throw new Error(`This ${FILE_NOUNS[kind]} was already created in another approver's Google ` +
      "account. Ask them to approve it" +
      (placedIn === null || placedIn === MY_DRIVE_ROOT ? "." : `, or approve it for ${folderName(placedIn)}.`));
  }

  let account = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(userObjectId));
  let cache = new AccessTokenCache(opts => account.getAccessToken(opts));
  let getAccessToken: AccessTokenProvider = opts => cache.get(opts);
  let drive = new DriveApi(getAccessToken);
  let record = (fileId: string, placed: string | null) =>
    ctx.storage.kv.put(CREATED_FILE_KEY, { userObjectId, fileId, folderId: placed } satisfies CreatedFile);
  // Checked before anything is made, so a choice that can be checked in advance orphans no file.
  let making = receipt === undefined;
  await requireGrants(account, making && inPlace ? [CREATED_FILES_GRANT, GOOGLE_DRIVE_FOLDER_RESOURCE.urlPattern]
    : moving ? [CREATED_FILES_GRANT] : []);
  let folder = moving || making && folderId !== MY_DRIVE_ROOT
    ? await destinationFolder(drive, folderId) : undefined;

  let fileId = receipt?.fileId;
  let made = false;
  if (create === undefined) {
    if (fileId === undefined) {
      fileId = await drive.generateFileId();
      record(fileId, null);
    }
    // Sent again while it is unknown whether the ID was used. The ID is kept even after Drive
    // refuses: the request replays a lost reply, so the refused attempt may not have been the first.
    if (making || placedIn === null) {
      // A 409 says an earlier attempt made the folder, which may be trashed or deleted since.
      if (!await drive.createFolder(props.creation.title, folderId, fileId) &&
          !isListableFolderFile(await readCreated(drive, kind, fileId))) throw goneError(kind);
      made = true;
    }
  } else if (fileId === undefined) {
    fileId = await create(props.creation.title, getAccessToken);
    made = true;
  }
  if (made) {
    logger.info("created file for a pending creation", {
      event: "google.creation.file.created", userObjectId, fileId, folderId,
    });
  }
  if (moving && folder) {
    record(fileId, null);
    await moveInto(drive, kind, fileId, folder);
  }
  record(fileId, folderId);
  return { userObjectId, fileId, resourceUrl: nativeFileUrl(kind, fileId), getAccessToken };
}
