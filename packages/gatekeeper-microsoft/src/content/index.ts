// Readable text for the files a SharePoint or OneDrive `readFile()` returns: Word and PowerPoint
// as Markdown, the plain-text family as text. Anything else (PDF, images, legacy binary Office
// formats) is reported as unsupported so the caller can use another route.

import { docxToMarkdown } from "./docx";
import { DocumentConversionError, type ConversionFailureReason } from "./errors";
import { pptxToMarkdown } from "./pptx";
import type { ConvertedMarkdown, OfficeConversionOptions } from "./ooxml";
import { cutText, decodeText, htmlToText } from "./text";
import { XmlError } from "./xml";
import { ZipError, type ZipErrorCode } from "./zip";

export { DocumentConversionError, type ConversionFailureReason } from "./errors";
export { cutText } from "./text";

/** The default output budget, in characters. */
export const DEFAULT_MAX_CHARS = 200_000;

/** HTML is read up to this many bytes; most of a page is markup, so the budget is wider than for text. */
const MAX_HTML_BYTES = 10 * 1024 * 1024;

/** The converters, by what they read. */
export type DocumentKind = "docx" | "pptx" | "html" | "markdown" | "text";

/** A file to convert. */
export interface ConvertInput {
  readonly bytes: Uint8Array;
  /** The file name; its extension decides the converter when it is a known one. */
  readonly name: string;
  /** Consulted when the extension is missing or unknown. */
  readonly mimeType?: string;
  /** Output budget in characters; defaults to `DEFAULT_MAX_CHARS`. */
  readonly maxChars?: number;
}

/** A converted file. */
export interface ConvertedText {
  readonly format: "markdown" | "text";
  /** At most `maxChars` characters of content, plus a truncation notice when cut. */
  readonly content: string;
  /** What the conversion left out or approximated, for the reader. */
  readonly warnings: string[];
  readonly truncated: boolean;
}

const EXTENSION_KINDS: Readonly<Record<string, DocumentKind>> = {
  ...kinds("docx", ["docx", "docm", "dotx", "dotm"]),
  ...kinds("pptx", ["pptx", "pptm", "potx", "potm", "ppsx", "ppsm"]),
  ...kinds("html", ["html", "htm", "xhtml"]),
  ...kinds("markdown", ["md", "markdown"]),
  ...kinds("text", [
    "txt", "text", "csv", "tsv", "json", "jsonl", "ndjson", "xml", "yaml", "yml", "log", "ini", "cfg", "conf",
    "toml", "env", "properties", "vtt", "srt", "sql", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb",
    "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "ps1", "bat",
  ]),
};

function kinds(kind: DocumentKind, extensions: readonly string[]): Record<string, DocumentKind> {
  return Object.fromEntries(extensions.map(extension => [extension, kind]));
}

const MIME_KINDS: Readonly<Record<string, DocumentKind>> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template": "docx",
  "application/vnd.ms-word.document.macroenabled.12": "docx",
  "application/vnd.ms-word.template.macroenabled.12": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.presentationml.template": "pptx",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow": "pptx",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12": "pptx",
  "application/vnd.ms-powerpoint.template.macroenabled.12": "pptx",
  "application/vnd.ms-powerpoint.slideshow.macroenabled.12": "pptx",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "text/markdown": "markdown",
  "application/json": "text",
  "application/xml": "text",
};

/**
 * Which converter reads a file, or undefined if none does. A known extension wins over the MIME
 * type, since storage services often report Office files as `application/octet-stream`.
 */
export function documentKind(name: string, mimeType?: string): DocumentKind | undefined {
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
  const byExtension = Object.hasOwn(EXTENSION_KINDS, extension) ? EXTENSION_KINDS[extension] : undefined;
  if (byExtension) return byExtension;
  const mime = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  if (Object.hasOwn(MIME_KINDS, mime)) return MIME_KINDS[mime];
  if (mime.startsWith("text/") || mime.endsWith("+json") || mime.endsWith("+xml")) return "text";
  return undefined;
}

/**
 * Converts a file to readable text, or returns null when its type is not one this module reads.
 * Throws `DocumentConversionError` for a supported type that cannot be converted (corrupt,
 * password-protected, or over a resource limit).
 */
export async function convertToText(input: ConvertInput): Promise<ConvertedText | null> {
  const kind = documentKind(input.name, input.mimeType);
  if (!kind) return null;
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  switch (kind) {
    case "docx":
      return convertOffice(input.bytes, maxChars, docxToMarkdown);
    case "pptx":
      return convertOffice(input.bytes, maxChars, pptxToMarkdown);
    case "html": {
      const cut = input.bytes.length > MAX_HTML_BYTES;
      return finish("text", htmlToText(decodeText(input.bytes.subarray(0, MAX_HTML_BYTES))), [], cut, maxChars);
    }
    case "markdown":
    case "text":
      return convertPlainText(input.bytes, kind === "markdown" ? "markdown" : "text", maxChars);
  }
}

/**
 * Decodes no more bytes than could fill the budget: a UTF-16 code unit takes at most three bytes
 * of UTF-8 or two of UTF-16, so four bytes per character always decodes past `maxChars`.
 */
function convertPlainText(bytes: Uint8Array, format: ConvertedText["format"], maxChars: number): ConvertedText {
  const byteBudget = Math.min(bytes.length, Math.max(4 * maxChars, 4));
  return finish(format, decodeText(bytes.subarray(0, byteBudget)), [], byteBudget < bytes.length, maxChars);
}

/** Password-protected and rights-managed OOXML files are OLE compound files, not ZIP archives. */
const COMPOUND_FILE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Whether the bytes are an OLE compound file: a legacy binary Office file, or a modern one encrypted. */
export function isCompoundFile(bytes: Uint8Array): boolean {
  return COMPOUND_FILE_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

async function convertOffice(
  bytes: Uint8Array,
  maxChars: number,
  convert: (bytes: Uint8Array, options: OfficeConversionOptions) => Promise<ConvertedMarkdown>,
): Promise<ConvertedText> {
  if (isCompoundFile(bytes)) {
    throw new DocumentConversionError("encrypted",
      "The file is password-protected or rights-managed (or is a legacy binary Office file with a modern extension)");
  }
  let converted: ConvertedMarkdown;
  try {
    converted = await convert(bytes, { maxChars });
  } catch (error) {
    throw asConversionError(error);
  }
  const warnings = [...converted.warnings];
  if (converted.markdown.trim() === "") warnings.push("The document contains no text.");
  return finish("markdown", converted.markdown, warnings, converted.truncated, maxChars);
}

const ZIP_FAILURE_REASONS: Readonly<Record<ZipErrorCode, ConversionFailureReason>> = {
  "malformed": "corrupt",
  "checksum": "corrupt",
  "duplicate-entry": "corrupt",
  "not-found": "corrupt",
  "encrypted": "encrypted",
  "zip64": "unsupported",
  "multi-disk": "unsupported",
  "unsupported-method": "unsupported",
  "too-many-entries": "too-large",
  "entry-too-large": "too-large",
  "archive-too-large": "too-large",
};

function asConversionError(error: unknown): unknown {
  if (error instanceof ZipError) return new DocumentConversionError(ZIP_FAILURE_REASONS[error.code], `The file could not be read: ${error.message}`, { cause: error });
  if (error instanceof XmlError) {
    return new DocumentConversionError(error.code === "limit" ? "too-large" : "corrupt", `The document's XML could not be parsed: ${error.message}`, { cause: error });
  }
  return error;
}

function finish(format: ConvertedText["format"], content: string, warnings: string[], truncated: boolean, maxChars: number): ConvertedText {
  if (content.length <= maxChars && !truncated) return { format, content, warnings, truncated: false };
  return { format, content: truncate(content, maxChars), warnings, truncated: true };
}

/** Cuts to `maxChars`, and says so at the end. */
function truncate(content: string, maxChars: number): string {
  return `${cutText(content, maxChars).trimEnd()}\n\n[Truncated: the content exceeds ${maxChars.toLocaleString("en-US")} characters, and the rest is omitted.]`;
}
