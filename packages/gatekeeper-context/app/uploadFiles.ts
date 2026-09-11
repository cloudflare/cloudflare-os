import { contentTypeFromPath, isTextContentType } from "../src/context-types";

/** A browser file decoded into the representation accepted by Context document RPCs. */
export type DecodedUploadFile = {
  path: string;
  contentType: string;
  body: string;
};

type ReadUploadFileOptions = {
  inferUnknownBinary?: boolean;
};

type DroppedDataTransferItem = DataTransferItem & {
  getAsEntry?: () => FileSystemEntry | null;
};

/** Read a browser file as base64 without creating a size-limited data URL. */
export const fileToBase64 = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunkSize = 24_576; // Divisible by three so independently encoded chunks concatenate safely.
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    result += btoa(String.fromCharCode(...chunk));
  }
  return result;
};

/** Decode one selected file, preserving its folder-relative path when available. */
export const readUploadFile = async (
  file: File,
  pathOverride?: string,
  options: ReadUploadFileOptions = {},
): Promise<DecodedUploadFile> => {
  const path = pathOverride
    || (file as File & { webkitRelativePath?: string }).webkitRelativePath
    || file.name;
  const pathContentType = contentTypeFromPath(path);
  const hasMarkdownExtension = /\.(?:md|markdown)$/i.test(path);
  let contentType = pathContentType;
  let body: string;

  // Unknown extensions default to Markdown in the document editor. Use browser metadata or a UTF-8
  // probe here so arbitrary skill assets are not corrupted by being decoded as text.
  if (options.inferUnknownBinary && pathContentType === "text/markdown" && !hasMarkdownExtension) {
    if (file.type) {
      contentType = file.type;
      body = isTextContentType(contentType) ? await file.text() : await fileToBase64(file);
    } else {
      const bytes = await file.arrayBuffer();
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        contentType = "text/plain";
      } catch {
        body = await fileToBase64(file);
        contentType = "application/octet-stream";
      }
    }
  } else {
    body = isTextContentType(contentType) ? await file.text() : await fileToBase64(file);
  }

  return { path, contentType, body };
};

/** Decode files sequentially to avoid retaining several duplicate browser buffers at once. */
export const readUploadFiles = async (
  files: Iterable<File>,
  options?: ReadUploadFileOptions,
): Promise<DecodedUploadFile[]> => {
  const result: DecodedUploadFile[] = [];
  for (const file of files) result.push(await readUploadFile(file, undefined, options));
  return result;
};

const droppedFolderReadError = () => new Error(
  "We couldn't read this dropped folder. Use Choose folder to select it instead.",
);

/** Decode dropped files, directing unsupported directory drops to the safe folder picker. */
export const readDroppedUploadFiles = async (
  dataTransfer: DataTransfer,
): Promise<DecodedUploadFile[]> => {
  const plainFiles = Array.from(dataTransfer.files);
  const items = Array.from(dataTransfer.items);
  let entries: FileSystemEntry[] = [];
  try {
    entries = items.flatMap((item) => {
      const droppedItem = item as DroppedDataTransferItem;
      const entry = droppedItem.getAsEntry?.() ?? droppedItem.webkitGetAsEntry?.();
      return entry ? [entry] : [];
    });
  } catch {
    if (plainFiles.length === 0 && items.length > 0) throw droppedFolderReadError();
  }

  if (entries.some((entry) => entry.isDirectory)
    || (plainFiles.length === 0 && items.length > 0)) throw droppedFolderReadError();
  return readUploadFiles(plainFiles, { inferUnknownBinary: true });
};
