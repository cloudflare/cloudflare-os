// GatekeeperUser.saveFile(): an Office file the user hands over, such as a gadget's export, saved
// to their Drive as a native Doc, Sheet or Presentation, which Drive converts it into.

import type { AccessTokenProvider } from "./auth-retry";
import { newFileTitle } from "./creation";
import { DriveApi, DriveApiRequestError, isFileInvisible, megabytes } from "./drive-api";
import { obsContext } from "./observability";
import { OFFICE_KINDS, type OfficeKind } from "./office-conversion";
import { CREATED_FILES_GRANT, nativeFileUrl, parseResourceUrl, RESOURCE_BY_KIND } from "./resources";

const logger = obsContext.createLogger({ component: "gatekeeper.google.save", vendorId: "google" });

/** Read when Drive does not say what it imports: the most it converts into any type. */
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

/** Marks a file a save made: only such a file is replaced, whatever else the account may edit. */
const SAVED_PROPERTY = "gadgetsSaved";

const GONE = "Google Drive can't find the file this was saved to before, or this app can no longer " +
  "change it. Save a new copy.";

/** Where `destination` puts a save of `kind`: the ID of the file to replace, or a new file's folder. */
function saveTarget(kind: OfficeKind, destination: string): string | { folderId: string } {
  let target = parseResourceUrl(destination);
  if (target.kind === "driveFolder") return { folderId: target.folderId };
  if (target.kind !== kind) {
    throw new Error(`A ${RESOURCE_BY_KIND[kind].title} is saved to a Google Drive folder, or over one saved before.`);
  }
  return target.kind === "doc" ? target.documentId
    : target.kind === "sheets" ? target.spreadsheetId : target.presentationId;
}

/** `file`, failing once it has given more than `max` bytes, or if it ends having given none. */
function upTo(file: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let size = 0;
  return file.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      if ((size += chunk.length) > max) {
        throw new Error(`This file is larger than the ${megabytes(max)} MB Google Drive converts into this format.`);
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (!size) throw new Error("This file is empty, so there is nothing to save.");
    },
  }));
}

/** Drive's refusal of a save in our own words, where the status and reason say enough. */
function saveError(error: unknown, replacing: boolean): unknown {
  if (!(error instanceof DriveApiRequestError)) return error;
  if (error.reason === "storageQuotaExceeded") {
    return new Error("This Google account has no Drive storage left to save to.");
  }
  if (!isFileInvisible(error)) return error;
  return new Error(replacing ? GONE : "This Google account can't add files to that folder. Choose another.");
}

/**
 * Saves `file` for the account `getAccessToken` and `holds` reach, as GatekeeperUser.saveFile()
 * defines, with the type given by its URL pattern. It needs only CREATED_FILES_GRANT (`drive.file`),
 * so it works where Drive is otherwise read-only. The file is streamed to Drive, up to the size it
 * imports, and is never held whole.
 */
export async function saveFile(
  getAccessToken: AccessTokenProvider, holds: (grant: string) => Promise<boolean>,
  resourceUrlPattern: string, destination: string, name: string, contentType: string,
  file: ReadableStream<Uint8Array>,
): Promise<{ url: string }> {
  let kind = (Object.keys(OFFICE_KINDS) as OfficeKind[])
    .find(kind => RESOURCE_BY_KIND[kind].urlPattern === resourceUrlPattern);
  if (!kind || !RESOURCE_BY_KIND[kind].savableFrom?.includes(contentType)) {
    throw new Error("Google cannot save that kind of file as that resource type.");
  }
  let target = saveTarget(kind, destination);
  let replacing = typeof target === "string";
  let into = typeof target === "string" ? target
    : { name: newFileTitle(name), parents: [target.folderId], appProperties: { [SAVED_PROPERTY]: "1" } };
  if (!(await holds(CREATED_FILES_GRANT))) {
    throw new Error("This Google account hasn't let this app save files to its Drive. Choose where to " +
      "save it again and allow access when asked.");
  }
  let drive = new DriveApi(getAccessToken);
  let { nativeMimeType } = OFFICE_KINDS[kind];
  try {
    if (typeof into === "string") {
      // Drive takes new content for a trashed file, which then stays in the trash.
      let saved = await drive.getConvertedCopy(into);
      if (saved.trashed !== false) {
        throw new Error("The file this was saved to before is in the Drive trash. Restore it, or save a new copy.");
      }
      if (saved.mimeType !== nativeMimeType || !saved.appProperties?.[SAVED_PROPERTY]) {
        throw new Error(`That file is not a ${RESOURCE_BY_KIND[kind].title} saved from here. Save a new copy.`);
      }
    }
    let content = upTo(file, await drive.getMaxImportSize(nativeMimeType).catch(() => undefined) ?? MAX_IMPORT_BYTES);
    let fileId = await drive.uploadConverted(content, contentType, nativeMimeType, into);
    logger.info("saved a file to Drive", {
      event: "google.save.saved", conversionKind: kind, fileId, method: replacing ? "replace" : "create",
    });
    return { url: nativeFileUrl(kind, fileId) };
  } catch (error) {
    let explained = saveError(error, replacing);
    logger.warn("failed to save a file to Drive", {
      event: "google.save.failed", conversionKind: kind, method: replacing ? "replace" : "create",
      ...(error instanceof DriveApiRequestError ? {
        httpStatus: error.status, ...(error.reason ? { providerReasons: [error.reason] } : {}),
      } : {}),
      error: explained,
    });
    throw explained;
  }
}
