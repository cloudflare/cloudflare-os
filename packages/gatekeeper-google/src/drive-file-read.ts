// What a Drive file read may return: which files have content of their own to download, which
// formats a native file exports to, and the streams a read hands over.

import { FOLDER_MIME_TYPE, SHORTCUT_MIME_TYPE, type DriveFile } from "./drive-api";
import {
  GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, GOOGLE_SLIDES_MIME_TYPE, driveModifiedTime,
} from "./drive-session";
import type { DriveExportFormat, DriveFileReadOptions } from "./drive-types";

/** The refusal for bytes read from another revision than the one whose size was read. */
export const FILE_CHANGED = "The Drive file changed while it was being read; read it again.";

/**
 * How long a read's stream may go with no bytes moving, whether Drive has stopped sending them or
 * the reader has stopped taking them, before it is ended and its download let go.
 */
export const FILE_READ_IDLE_MS = 60_000;

/** What ends a stream that sat idle. */
const FILE_READ_IDLE =
  "The Drive file's content went unread, or Drive stopped sending it, for a minute; read it again.";

/** Every Google-native type starts with this; none has content of its own to download. */
const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps.";

/** The native types a Drive session opens, and what a read of one is told to use instead. */
const NATIVE_OPENERS: Record<string, string> = {
  [GOOGLE_DOC_MIME_TYPE]: "a Google Doc; open it with openGoogleDoc(), or export it with exportFile()",
  [GOOGLE_SHEET_MIME_TYPE]:
    "a Google Sheet; open it with openGoogleSheet(), or export it with exportFile()",
  [GOOGLE_SLIDES_MIME_TYPE]:
    "a Google Slides presentation; open it with openGoogleSlides(), or export it with exportFile()",
};

/**
 * The requested range, refused before anything is asked of Google when it is not one. An omitted
 * `length` reaches past the end of any file, for the caller to cut to the file's size.
 */
export function fileReadRange(options: DriveFileReadOptions): { offset: number; length: number } {
  let { offset = 0, length = Number.MAX_SAFE_INTEGER } = options;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("offset must be a whole number of bytes, at least 0.");
  }
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new Error("length must be a whole number of bytes, at least 1.");
  }
  return { offset, length };
}

/**
 * `content` held to exactly `length` bytes, at least one, and read only as the result is, so none
 * are held here. Whatever follows them is cancelled unread, as when Drive answers a range from the
 * start with the whole file. An answer that ends first errors the stream: the range lies inside
 * the file, so one that ends short did not come from the revision whose size was read. So does
 * {@link FILE_READ_IDLE_MS} with no bytes moving, counted from now, so build this only once the
 * stream is about to be handed over. However the stream ends, the download is let go.
 */
export function exactRange(
  content: ReadableStream<Uint8Array>, length: number,
): ReadableStream<Uint8Array> {
  let remaining = length;
  return paced(content, (chunk, controller) => {
    if (chunk === undefined) {
      controller.error(new Error(FILE_CHANGED));
      return true;
    }
    let bytes = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    remaining -= bytes.byteLength;
    controller.enqueue(bytes);
    if (remaining > 0) return false;
    controller.close();
    return true;
  });
}

/**
 * `content`, of a length not known ahead, read only as the result is, so none of it is held here,
 * and ended with an error after {@link FILE_READ_IDLE_MS} with no bytes moving, counted from now.
 * However the stream ends, the download is let go.
 */
export function idleTimed(content: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return paced(content, (chunk, controller) => {
    if (chunk === undefined) {
      controller.close();
      return true;
    }
    controller.enqueue(chunk);
    return false;
  });
}

/**
 * A stream that reads `content` only as it is read, ending once `step`, handed each chunk read and
 * `undefined` at the end of `content`, says it has, or after {@link FILE_READ_IDLE_MS} with no
 * bytes moving. However it ends, `content` is let go.
 */
function paced(
  content: ReadableStream<Uint8Array>,
  step: (
    chunk: Uint8Array | undefined, controller: ReadableStreamDefaultController<Uint8Array>,
  ) => boolean,
): ReadableStream<Uint8Array> {
  let reader = content.getReader();
  let ended = false;
  /** When bytes last moved: asked of Drive, or handed to the reader. */
  let moved = Date.now();
  let timer!: ReturnType<typeof setTimeout>;
  let end = async (reason?: unknown) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    await reader.cancel(reason).catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // One timer for the whole stream, set again only when it fires, so that a chunk costs a
      // look at the clock rather than a timer of its own.
      let check = () => {
        let left = moved + FILE_READ_IDLE_MS - Date.now();
        if (left > 0) {
          timer = setTimeout(check, left);
          return;
        }
        controller.error(new Error(FILE_READ_IDLE));
        void end();
      };
      timer = setTimeout(check, FILE_READ_IDLE_MS);
    },
    async pull(controller) {
      moved = Date.now();
      let chunk = await reader.read().catch(async (error: unknown) => {
        await end();
        throw error;
      });
      // Idled out or cancelled while Drive was being waited on.
      if (ended) return;
      let over = step(chunk.done ? undefined : chunk.value, controller);
      moved = Date.now();
      if (over) await end();
    },
    cancel: end,
  }, { highWaterMark: 0 });
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
  requireDownloadable(file);
  let size = Number(file.size);
  if (file.size === undefined || !Number.isSafeInteger(size) || size < 0) {
    throw new Error("Google Drive did not report the file's size.");
  }
  return { mimeType, size, modifiedTime: driveModifiedTime(file) };
}

/** Refuses a file whose owner or administrator has stopped the connected account downloading it. */
function requireDownloadable(file: DriveFile): void {
  if (file.capabilities?.canDownload === false) {
    throw new Error("Google Drive does not let the connected account download this file; its " +
      "owner or administrator has restricted downloading it.");
  }
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** What each native type exports to, by format, as the MIME type Drive is asked for. */
const EXPORT_FORMATS: Record<string, { name: string; formats: Partial<Record<DriveExportFormat, string>> }> = {
  [GOOGLE_DOC_MIME_TYPE]: {
    name: "Google Doc",
    formats: {
      docx: DOCX, odt: "application/vnd.oasis.opendocument.text", rtf: "application/rtf",
      pdf: "application/pdf", txt: "text/plain", html: "text/html",
      epub: "application/epub+zip", md: "text/markdown",
    },
  },
  [GOOGLE_SHEET_MIME_TYPE]: {
    name: "Google Sheet",
    formats: {
      xlsx: XLSX, ods: "application/vnd.oasis.opendocument.spreadsheet",
      pdf: "application/pdf", csv: "text/csv", tsv: "text/tab-separated-values",
    },
  },
  [GOOGLE_SLIDES_MIME_TYPE]: {
    name: "Google Slides presentation",
    formats: {
      pptx: PPTX, odp: "application/vnd.oasis.opendocument.presentation",
      pdf: "application/pdf", txt: "text/plain",
    },
  },
};

/**
 * The MIME type `file` is exported to as `format`, with the native type it is exported from, or
 * the refusal for a file that is not a Google Doc, Sheet or Slides presentation, or that does not
 * export to `format`.
 */
export function exportMimeType(
  file: DriveFile, format: DriveExportFormat,
): { nativeMimeType: string; mimeType: string } {
  let nativeMimeType = file.mimeType;
  if (!nativeMimeType) throw new Error("Google Drive omitted required file mimeType");
  let native = EXPORT_FORMATS[nativeMimeType];
  if (!native) {
    let what = nativeMimeType === FOLDER_MIME_TYPE ? "a folder"
      : nativeMimeType === SHORTCUT_MIME_TYPE ? "a shortcut; export its target instead"
      : nativeMimeType.startsWith(GOOGLE_NATIVE_PREFIX) ? `a Google-native file (${nativeMimeType})`
      : "a file with content of its own; read it with readFile()";
    throw new Error(
      `Only Google Docs, Sheets and Slides files are exported. The requested Drive item is ${what}.`);
  }
  let mimeType = native.formats[format];
  if (mimeType === undefined) {
    throw new Error(`A ${native.name} does not export to ${format}; it exports to ${
      Object.keys(native.formats).join(", ")}.`);
  }
  requireDownloadable(file);
  return { nativeMimeType, mimeType };
}
