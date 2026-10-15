// What the Doc, Sheets and Slides gatekeepers share to simulate a file GatekeeperVendor
// createResource() was asked for, and to create it once a user approves.
//
// Imports neither google.ts nor slides.ts, both of which import this.

import type {
  ActionDescription, GatekeeperUserVerifier, SupportedResource,
} from "@gadgets/workshop-shared/gatekeeper";
import { buildDescription, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import { AccessTokenCache, type AccessTokenProvider } from "./auth-retry";
import { DriveApi, DriveApiRequestError, FOLDER_MIME_TYPE, type DriveFile } from "./drive-api";
import type { GoogleVerifierApi } from "./google-verifier-types";
import { obsContext } from "./observability";
import { nativeFileUrl, parseResourceUrl, type CreatableKind } from "./resources";

const logger = obsContext.createLogger({ component: "gatekeeper.google.creation", vendorId: "google" });

/**
 * Props GatekeeperVendor.createResource() mints a simulated Doc, Sheet or Presentation with: no
 * account, only what to create.
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
    // No actionKind: the kernel never auto-applies a creation.
    implementsRevert: false,
  };
}

/**
 * The receipt of a file created for a pending creation, kept so a retry binds the same file: the
 * account it is in, and the folder this gatekeeper last put it in, or null while a move's outcome
 * is unknown. A receipt from before folders has no `folderId`: its file is still in My Drive.
 */
type CreatedFile = { userObjectId: string; fileId: string; folderId?: string | null };

const CREATED_FILE_KEY = "createdFile";

/** Drive's alias for the root of My Drive, where Google creates every file. */
const MY_DRIVE_FOLDER_ID = "root";

/**
 * The folder a creation's `configuration` puts the file in: one minted by the creation folder
 * configurator (`configurator/creation-folder-configurator-ui.tsx`), or null for My Drive.
 */
function creationFolderId(configuration: string | null): string {
  if (configuration === null) return MY_DRIVE_FOLDER_ID;
  let target = parseResourceUrl(configuration);
  if (target.kind === "driveAccount") return MY_DRIVE_FOLDER_ID;
  if (target.kind === "driveFolder") return target.folderId;
  throw new Error("A new Google file can only be put in My Drive or a Google Drive folder.");
}

function describeFolder(folderId: string, name?: string): string {
  if (folderId === MY_DRIVE_FOLDER_ID) return "My Drive";
  return name === undefined ? `the folder ${folderId}` : `"${name}" (${folderId})`;
}

/**
 * Folder `folderId`, refusing one the file can't be moved into: the account lacks `drive.file`, or
 * the folder is missing, trashed, not a folder, or without `canAddChildren`. The picker offers
 * none of those folders, but `configuration` is caller input, and the folder may have changed
 * since it was picked.
 */
async function destinationFolder(
  account: { canPlaceCreatedFiles(): Promise<boolean> }, drive: DriveApi, folderId: string,
): Promise<DriveFile> {
  if (folderId === MY_DRIVE_FOLDER_ID) return await drive.getFile(folderId);
  // An account connected before scopes were recorded is reported to hold the Doc grant, so the
  // approval dialog never asks it for `drive.file`, but the move needs it.
  if (!await account.canPlaceCreatedFiles()) {
    throw new Error("This Google account was connected without access to put new files in " +
      "folders. Reconnect it to choose a folder, or approve this for My Drive.");
  }
  let folder = await drive.getFile(folderId).catch((error: unknown) => {
    if (error instanceof DriveApiRequestError && error.status === 404) return undefined;
    throw error;
  });
  if (folder?.mimeType !== FOLDER_MIME_TYPE || folder.trashed || !folder.capabilities?.canAddChildren) {
    throw new Error(`The Google account creating this can't add files to ${describeFolder(folderId)}. ` +
      "Approve it again with a folder that account can add files to.");
  }
  return folder;
}

/**
 * Moves file `fileId` into `folder` unless that is already its only parent. Reads the file's
 * parents rather than trusting the receipt: an earlier move may have taken effect with its reply
 * lost.
 */
async function moveFile(
  drive: DriveApi, kind: CreatableKind, fileId: string, folderId: string, folder: DriveFile,
): Promise<void> {
  let parents = await drive.getFile(fileId).then(file => file.parents ?? [], (error: unknown) => {
    if (!(error instanceof DriveApiRequestError && error.status === 404)) throw error;
    throw new Error(`The ${FILE_NOUNS[kind]} created for this approval is gone, or its Google ` +
      "account can no longer reach it. Reject the creation and ask for a new one.", { cause: error });
  });
  if (parents.length === 1 && parents[0] === folder.id) return;
  try {
    await drive.moveFile(fileId, folder.id, parents.filter(parent => parent !== folder.id));
  } catch (error) {
    throw new Error(`The ${FILE_NOUNS[kind]} at ${nativeFileUrl(kind, fileId)} was created, but ` +
      `moving it into ${describeFolder(folderId, folder.name)} failed: ` +
      `${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * Creates the file a simulated facet stands for in the approver's account and puts it in the
 * folder `configuration` names, recording a receipt so a retried applyCreation() binds the same
 * file instead of making another. Google creates each file in My Drive, so putting it there takes
 * no Drive call, and neither does a retry for the folder the receipt says it is in: an account
 * holding only the file type's own scope, as one connected before per-resource grants may, can
 * still create in My Drive.
 *
 * A retry keeps the receipt's account: after a lost success it binds the file the first approval
 * made, as that approval completing would have. Only that account's approver may move the file, so
 * another approver's retry for anywhere but where it is is refused.
 *
 * Google's create calls take no idempotency key, so a file can still be orphaned: a create POST
 * that times out or fails 5xx after Google acted (the retry creates again), a crash between the
 * reply and the receipt write, or a creation rejected after a lost success (the facet's storage,
 * and so the receipt, is deleted). Each created file is logged so an orphan can be found.
 *
 * Callers serialize calls with a Mutex.
 */
export async function createFileOnce(
  ctx: DurableObjectState<object>,
  creator: Fetcher<GatekeeperUserVerifier>,
  kind: CreatableKind,
  configuration: string | null,
  create: (title: string, getAccessToken: AccessTokenProvider) => Promise<string>,
): Promise<CreatedFile & { resourceUrl: string; getAccessToken: AccessTokenProvider }> {
  let props = ctx.props;
  if (!isSimulated(props)) throw new Error(`This ${FILE_NOUNS[kind]} already exists.`);
  let folderId = creationFolderId(configuration);
  let approverId = await (creator as unknown as Fetcher<GoogleVerifierApi>).getUserObjectId();
  let receipt = ctx.storage.kv.get<CreatedFile>(CREATED_FILE_KEY);
  let userObjectId = receipt?.userObjectId ?? approverId;
  let account = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(userObjectId));
  let cache = new AccessTokenCache(opts => account.getAccessToken(opts));
  let getAccessToken: AccessTokenProvider = opts => cache.get(opts);
  let drive = new DriveApi(getAccessToken);
  let record = (file: CreatedFile) => ctx.storage.kv.put(CREATED_FILE_KEY, file);

  let folder: DriveFile | undefined;
  if (receipt === undefined) {
    // Checked first, so a folder the file can't be moved into orphans no file.
    if (folderId !== MY_DRIVE_FOLDER_ID) folder = await destinationFolder(account, drive, folderId);
    receipt = {
      userObjectId, fileId: await create(props.creation.title, getAccessToken),
      folderId: MY_DRIVE_FOLDER_ID,
    };
    record(receipt);
    logger.info("created file for a pending creation", {
      event: "google.creation.file.created", userObjectId, fileId: receipt.fileId, folderId,
    });
  }
  let { fileId, folderId: placedIn = MY_DRIVE_FOLDER_ID } = receipt;
  if (placedIn !== folderId) {
    if (userObjectId !== approverId) {
      throw new Error(`This ${FILE_NOUNS[kind]} was already created in another approver's Google ` +
        "account, and only they can move it. Ask them to approve it" +
        (placedIn === null ? "." : `, or approve it for ${describeFolder(placedIn)}.`));
    }
    folder ??= await destinationFolder(account, drive, folderId);
    record({ userObjectId, fileId, folderId: null });
    await moveFile(drive, kind, fileId, folderId, folder);
    record({ userObjectId, fileId, folderId });
  }
  return { userObjectId, fileId, resourceUrl: nativeFileUrl(kind, fileId), getAccessToken };
}
