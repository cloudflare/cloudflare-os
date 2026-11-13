import { attachmentKind } from "./attachmentKind";

/** A way of drawing a file's content. Each has one previewer (attachmentPreviewers.ts). */
export type PreviewFormat =
  | "image"
  | "pdf"
  | "text"
  | "markdown"
  | "delimited"
  | "workbook"
  | "document"
  | "slides";

// Formats every current browser decodes in an <img>. HEIC and TIFF are images, but not these.
const BROWSER_IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml", "image/bmp",
  "image/x-icon", "image/vnd.microsoft.icon",
]);

const DELIMITED_TYPES = new Set(["text/csv", "text/tab-separated-values"]);
const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown"]);

const extensionOf = (name: string | undefined): string => {
  const dot = name?.lastIndexOf(".") ?? -1;
  return name && dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/**
 * How an attachment can be previewed, or undefined when it can only be downloaded. Refines
 * `attachmentKind`, which is too coarse to choose a previewer: a spreadsheet may be CSV text or an
 * Excel package, and only the Open XML Office formats can be read in the browser.
 */
export const previewFormat = (mimeType: string, name?: string): PreviewFormat | undefined => {
  const mime = mimeType.toLowerCase();
  const extension = extensionOf(name);
  // Before the kind, which is decided by the type first: browsers type a TSV and some Markdown as
  // `text/*`, which the kind takes for plain text.
  if (DELIMITED_TYPES.has(mime) || extension === "csv" || extension === "tsv") return "delimited";
  if (MARKDOWN_TYPES.has(mime)) return "markdown";
  switch (attachmentKind(mimeType, name)) {
    case "image":
      return BROWSER_IMAGE_TYPES.has(mime) ? "image" : undefined;
    case "pdf":
      return "pdf";
    case "spreadsheet":
      return mime.includes("spreadsheetml") || extension === "xlsx" ? "workbook" : undefined;
    case "document":
      return mime.includes("wordprocessingml") || extension === "docx" ? "document" : undefined;
    case "presentation":
      return mime.includes("presentationml") || extension === "pptx" ? "slides" : undefined;
    case "code":
      return "text";
    case "text":
      return extension === "md" || extension === "markdown" ? "markdown" : "text";
    case "audio":
    case "video":
    case "archive":
    case "file":
      return undefined;
  }
};

/**
 * Whether bytes are UTF-8 text, for files whose name and type say nothing (`Dockerfile`, `.env`).
 * Only the head is checked, so a file is never decoded twice just to be classified.
 */
export const looksLikeText = (bytes: Uint8Array): boolean => {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    // A multi-byte character cut by the 8 KiB boundary is not a decoding error with `stream`.
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
};
