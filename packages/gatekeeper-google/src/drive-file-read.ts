// What a Drive file read may return: which files have content of their own to download, and the
// bounded range one read takes.

import { FOLDER_MIME_TYPE, SHORTCUT_MIME_TYPE, type DriveFile } from "./drive-api";
import {
  GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, GOOGLE_SLIDES_MIME_TYPE, driveModifiedTime,
} from "./drive-session";
import type { DriveFileReadOptions } from "./drive-types";

/**
 * The most bytes one read returns. A read is held whole until its last byte has arrived, so that a
 * folder binding's re-proof of the file's place, taken after it, covers everything returned.
 */
export const MAX_FILE_READ_BYTES = 4_000_000;

/** Every Google-native type starts with this; none has content of its own to download. */
const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps.";

/** The native types a Drive session opens, and what a read of one is told to use instead. */
const NATIVE_OPENERS: Record<string, string> = {
  [GOOGLE_DOC_MIME_TYPE]: "a Google Doc; open it with openGoogleDoc()",
  [GOOGLE_SHEET_MIME_TYPE]: "a Google Sheet; open it with openGoogleSheet()",
  [GOOGLE_SLIDES_MIME_TYPE]: "a Google Slides presentation; open it with openGoogleSlides()",
};

/** The requested range, refused before anything is asked of Google when it is not one. */
export function fileReadRange(options: DriveFileReadOptions): { offset: number; length: number } {
  let { offset = 0, length = MAX_FILE_READ_BYTES } = options;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("offset must be a whole number of bytes, at least 0.");
  }
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_FILE_READ_BYTES) {
    throw new Error(
      `length must be a whole number of bytes from 1 to ${MAX_FILE_READ_BYTES.toLocaleString("en-US")}.`);
  }
  return { offset, length };
}

/** What a read of `file`'s content rests on, or the refusal for a file with none to download. */
export function downloadableFile(
  file: DriveFile,
): { mimeType: string; size: number; modifiedTime: Date } {
  let mimeType = file.mimeType;
  if (!mimeType) throw new Error("Google Drive omitted required file mimeType");
  if (mimeType === FOLDER_MIME_TYPE) {
    throw new Error("The requested Drive item is a folder, which has no content to read.");
  }
  if (mimeType === SHORTCUT_MIME_TYPE) {
    throw new Error(
      "The requested Drive item is a shortcut, which is not followed; read its target instead.");
  }
  let opener = NATIVE_OPENERS[mimeType];
  if (opener) throw new Error(`The requested Drive file is ${opener}.`);
  if (mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) {
    throw new Error(
      `The requested Drive file is a Google-native file (${mimeType}) with no content to download.`);
  }
  if (file.capabilities?.canDownload === false) {
    throw new Error("Google Drive does not let the connected account download this file; its " +
      "owner or administrator has restricted downloading it.");
  }
  let size = Number(file.size);
  if (file.size === undefined || !Number.isSafeInteger(size) || size < 0) {
    throw new Error("Google Drive did not report the file's size.");
  }
  return { mimeType, size, modifiedTime: driveModifiedTime(file) };
}
