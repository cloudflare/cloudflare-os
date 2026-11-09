// What a Drive file read may return: which files have content of their own to download, and the
// range of one a read streams.

import { FOLDER_MIME_TYPE, SHORTCUT_MIME_TYPE, type DriveFile } from "./drive-api";
import {
  GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, GOOGLE_SLIDES_MIME_TYPE, driveModifiedTime,
} from "./drive-session";
import type { DriveFileReadOptions } from "./drive-types";

/** The refusal for bytes read from another revision than the one whose size was read. */
export const FILE_CHANGED = "The Drive file changed while it was being read; read it again.";

/**
 * How many of a binding's reads may hold a Drive download open at once, across all its sessions.
 * Each holds a connection to Drive and the chunk RPC read ahead of its reader, in a Durable Object
 * that may share an isolate's memory with every other Drive binding's.
 */
export const MAX_OPEN_FILE_READS = 5;

/**
 * How long a read waits for one of those turns. Shorter than {@link FILE_READ_IDLE_MS}, so a
 * caller that collects more streams than there are turns before reading any is told so, rather
 * than handed streams that idled out while it waited.
 */
export const FILE_READ_WAIT_MS = 30_000;

/** The refusal for a read that no turn came free for. */
export const FILE_READS_BUSY =
  `${MAX_OPEN_FILE_READS} reads of this binding's Drive files are already open. Finish reading ` +
  "their content, or cancel it, before reading another file.";

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
  [GOOGLE_DOC_MIME_TYPE]: "a Google Doc; open it with openGoogleDoc()",
  [GOOGLE_SHEET_MIME_TYPE]: "a Google Sheet; open it with openGoogleSheet()",
  [GOOGLE_SLIDES_MIME_TYPE]: "a Google Slides presentation; open it with openGoogleSlides()",
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
 * {@link FILE_READ_IDLE_MS} with no bytes moving, counted from now. However the stream ends, the
 * download is let go and `onEnd` called, once.
 */
export function exactRange(
  content: ReadableStream<Uint8Array>, length: number, onEnd: () => void = () => undefined,
): ReadableStream<Uint8Array> {
  let reader = content.getReader();
  let remaining = length;
  let ended = false;
  let idle!: ReturnType<typeof setTimeout>;
  let end = async (reason?: unknown) => {
    if (ended) return;
    ended = true;
    clearTimeout(idle);
    onEnd();
    await reader.cancel(reason).catch(() => undefined);
  };
  /** Starts the wait over: for Drive's next bytes, or for the reader to ask for them. */
  let watch = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      controller.error(new Error(FILE_READ_IDLE));
      void end();
    }, FILE_READ_IDLE_MS);
  };
  return new ReadableStream<Uint8Array>({
    start: watch,
    async pull(controller) {
      watch(controller);
      let chunk = await reader.read().catch(async (error: unknown) => {
        await end();
        throw error;
      });
      // Idled out or cancelled while Drive was being waited on.
      if (ended) return;
      if (chunk.done) {
        controller.error(new Error(FILE_CHANGED));
        return end();
      }
      let bytes = chunk.value.byteLength > remaining
        ? chunk.value.subarray(0, remaining) : chunk.value;
      remaining -= bytes.byteLength;
      controller.enqueue(bytes);
      if (remaining > 0) return watch(controller);
      controller.close();
      await end();
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
