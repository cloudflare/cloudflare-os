// Turns what SharePoint stores into text an agent can read. Graph has no document-to-text
// conversion, so it happens here: Word and PowerPoint are parsed in the Worker (content/), Excel is
// read through Graph's workbook API (which computes formulas), PDFs and legacy Office formats go
// through Workers AI's `toMarkdown` when the deployment binds it (legacy formats first converted to
// PDF by Graph), and HTML and pages through a small HTML-to-Markdown converter.

import { DocumentConversionError, convertToText, cutText, documentKind } from "./content/index";
import { DownloadTooLargeError, type GraphApi } from "./graph-api";
import type { GraphDriveItem, PageWebPart } from "./graph-parse";
import { htmlToMarkdown } from "./html-markdown";
import { listWorksheets, readRange, usedRangeShape } from "./sharepoint-reads";
import type { ItemRef } from "./sharepoint-scope";
import type { CellValue, WorksheetContent } from "./types";
import { columnIndex, columnLetters } from "./workbook-ranges";

/** The largest file read for conversion or handed out as bytes. */
export const MAX_READ_BYTES = 25 * 1024 * 1024;
/** The largest file an upload or replace may carry. Graph's simple upload takes up to 250 MB. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** `readFile`'s default `maxChars`. */
export const DEFAULT_MAX_CHARS = 100_000;
/** The smallest `maxChars` `readFile` accepts. */
export const MIN_MAX_CHARS = 1_000;
/** The largest `maxChars` `readFile` accepts. */
export const MAX_MAX_CHARS = 500_000;
/** Cells read per worksheet by default. */
export const DEFAULT_MAX_CELLS = 10_000;
/** The most cells read per worksheet. */
export const MAX_MAX_CELLS = 100_000;

/** A conversion's outcome, before the session wraps it with the entry. */
export type Converted = { format: "markdown" | "text" | "none"; content: string; truncated: boolean; note?: string };

/** The file's extension, lower-case, without the dot. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

const WORKBOOK_EXTENSIONS = new Set(["xlsx", "xlsm", "xlsb"]);
const PDF_EXTENSIONS = new Set(["pdf"]);
/** Formats Graph converts to PDF (`?format=pdf`) that the Worker cannot parse itself. */
const LEGACY_OFFICE = new Set(["doc", "dot", "ppt", "pps", "pot", "rtf", "odt", "odp", "xls", "ods", "msg", "epub"]);
const HTML_EXTENSIONS = new Set(["html", "htm", "aspx"]);

/** Whether a file is an Excel workbook the workbook API reads. */
export function isWorkbook(item: Pick<GraphDriveItem, "name">): boolean {
  return WORKBOOK_EXTENSIONS.has(extensionOf(item.name));
}

/** Cuts text at `maxChars`, saying so. */
function cut(text: string, maxChars: number): { content: string; truncated: boolean } {
  if (text.length <= maxChars) return { content: text, truncated: false };
  return {
    content: `${cutText(text, maxChars)}\n\n[Truncated: the content is longer than ${maxChars.toLocaleString("en-US")} characters.]`,
    truncated: true,
  };
}

/** What conversion uses: Graph for downloads, and Workers AI, when bound, for PDFs. */
export type ConversionTools = {
  api: GraphApi;
  ai?: Ai;
};

/**
 * A file's content as text.
 * @param item The file, already proven in scope.
 */
export async function convertFile(tools: ConversionTools, item: GraphDriveItem, maxChars: number): Promise<Converted> {
  const ref = { driveId: item.driveId, itemId: item.id };
  const extension = extensionOf(item.name);
  if (item.size !== undefined && item.size > MAX_READ_BYTES && !WORKBOOK_EXTENSIONS.has(extension)) {
    return none(`The file is ${megabytes(item.size)}; files over ${megabytes(MAX_READ_BYTES)} can't be read as text.`);
  }
  if (WORKBOOK_EXTENSIONS.has(extension)) {
    const sheets = await readWorkbookSheets(tools.api, ref, { maxCells: DEFAULT_MAX_CELLS });
    return { format: "markdown", ...cut(workbookMarkdown(sheets.worksheets), maxChars),
      ...(sheets.notes.length ? { note: sheets.notes.join(" ") } : {}) };
  }
  if (PDF_EXTENSIONS.has(extension) || item.mimeType === "application/pdf") {
    if (!tools.ai) return none("Reading PDFs as text isn't enabled on this deployment. Use readBytes for the file itself.");
    const download = await tools.api.download(`/drives/${ref.driveId}/items/${ref.itemId}/content`, MAX_READ_BYTES);
    return await aiMarkdown(tools.ai, item.name, download.bytes, "application/pdf", maxChars);
  }
  if (LEGACY_OFFICE.has(extension)) {
    if (!tools.ai) {
      return none(`Reading .${extension} files as text isn't enabled on this deployment. Use readBytes for the file itself.`);
    }
    // Graph renders legacy and OpenDocument formats to PDF; the redirect goes to its media service.
    const pdf = await tools.api.download(`/drives/${ref.driveId}/items/${ref.itemId}/content`, MAX_READ_BYTES, { format: "pdf" });
    return await aiMarkdown(tools.ai, item.name.replace(/\.[^.]+$/, ".pdf"), pdf.bytes, "application/pdf", maxChars);
  }

  const kind = documentKind(item.name, item.mimeType);
  if (kind === undefined && !HTML_EXTENSIONS.has(extension)) {
    return none(`This is a ${describeType(item)}, which can't be read as text. Use readBytes for the file itself.`);
  }
  let bytes: Uint8Array;
  try {
    bytes = (await tools.api.download(`/drives/${ref.driveId}/items/${ref.itemId}/content`, MAX_READ_BYTES)).bytes;
  } catch (error) {
    if (error instanceof DownloadTooLargeError) return none(error.message);
    throw error;
  }
  if (kind === "html" || HTML_EXTENSIONS.has(extension)) {
    const html = new TextDecoder("utf-8").decode(bytes.subarray(0, maxChars * 4));
    return { format: "markdown", ...cut(htmlToMarkdown(html), maxChars) };
  }
  try {
    const converted = await convertToText({ bytes, name: item.name, ...(item.mimeType ? { mimeType: item.mimeType } : {}), maxChars });
    if (converted === null) return none(`This is a ${describeType(item)}, which can't be read as text. Use readBytes for the file itself.`);
    return {
      format: converted.format,
      content: converted.content,
      truncated: converted.truncated,
      ...(converted.warnings.length ? { note: converted.warnings.join(" ") } : {}),
    };
  } catch (error) {
    if (error instanceof DocumentConversionError) return none(error.message);
    throw error;
  }
}

/**
 * Bytes that aren't a drive item (a mail attachment) as text: what Office, HTML and text files hold,
 * and, through Workers AI when it is bound, PDFs and workbooks. Legacy formats need Graph's PDF
 * rendering, which only drive items get.
 */
export async function convertBytes(ai: Ai | undefined, name: string, mimeType: string, bytes: Uint8Array, maxChars: number): Promise<Converted> {
  const extension = extensionOf(name);
  const what = extension ? `.${extension} file` : "file with no extension";
  if (PDF_EXTENSIONS.has(extension) || mimeType === "application/pdf" || WORKBOOK_EXTENSIONS.has(extension)) {
    if (!ai) return none(`Reading a ${what} as text isn't enabled on this deployment. Read its bytes instead.`);
    const converted = await aiMarkdown(ai, name, bytes, PDF_EXTENSIONS.has(extension) ? "application/pdf" : mimeType, maxChars);
    return WORKBOOK_EXTENSIONS.has(extension) && converted.format === "markdown" ? { ...converted, note: "Converted from Excel; formulas and formatting are not shown." } : converted;
  }
  if (LEGACY_OFFICE.has(extension)) return none(`A ${what} can't be read as text here. Save it to OneDrive and read it there, or read its bytes.`);
  if (HTML_EXTENSIONS.has(extension) || mimeType === "text/html") {
    return { format: "markdown", ...cut(htmlToMarkdown(new TextDecoder("utf-8").decode(bytes.subarray(0, maxChars * 4))), maxChars) };
  }
  try {
    const converted = await convertToText({ bytes, name, mimeType, maxChars });
    if (converted === null) return none(`This is a ${mimeType.startsWith("image/") ? "picture" : what}, which can't be read as text. Read its bytes instead.`);
    return {
      format: converted.format, content: converted.content, truncated: converted.truncated,
      ...(converted.warnings.length ? { note: converted.warnings.join(" ") } : {}),
    };
  } catch (error) {
    if (error instanceof DocumentConversionError) return none(error.message);
    throw error;
  }
}

function none(note: string): Converted {
  return { format: "none", content: "", truncated: false, note };
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** A file's type in words, for a note. */
function describeType(item: GraphDriveItem): string {
  const extension = extensionOf(item.name);
  if (item.mimeType?.startsWith("image/")) return "image";
  if (item.mimeType?.startsWith("video/")) return "video";
  if (item.mimeType?.startsWith("audio/")) return "audio file";
  return extension ? `.${extension} file` : "file with no extension";
}

/** Converts a document through Workers AI's `toMarkdown`. */
async function aiMarkdown(ai: Ai, name: string, bytes: Uint8Array, mimeType: string, maxChars: number): Promise<Converted> {
  const [result] = await ai.toMarkdown([{ name, blob: new Blob([bytes], { type: mimeType }) }]);
  if (result === undefined || result.format !== "markdown") {
    return none("Workers AI couldn't convert this file to text.");
  }
  return { format: "markdown", ...cut(result.data, maxChars), note: "Converted from PDF; layout, images and some tables may be lost." };
}

// -- workbooks ----------------------------------------------------------------------------------

/** The top-left cell of an address like "Sheet1!B2:D9", as 1-based column and row numbers. */
function topLeft(address: string): { column: number; row: number } {
  const cells = address.includes("!") ? address.slice(address.lastIndexOf("!") + 1) : address;
  const match = /^\$?([A-Z]{1,3})\$?(\d{1,7})/i.exec(cells);
  return match ? { column: columnIndex(match[1]) + 1, row: Number(match[2]) } : { column: 1, row: 1 };
}

/**
 * The range to read so a used range of `rows` × `columns` stays within `maxCells`: every column
 * when they fit, and as many whole rows as the budget allows.
 */
function boundedRange(start: { column: number; row: number }, rows: number, columns: number, maxCells: number):
    { address: string; truncated: boolean } {
  const width = Math.max(1, Math.min(columns, maxCells));
  const height = Math.max(1, Math.min(rows, Math.floor(maxCells / width)));
  const end = { column: start.column + width - 1, row: start.row + height - 1 };
  return {
    address: `${columnLetters(start.column - 1)}${start.row}:${columnLetters(end.column - 1)}${end.row}`,
    truncated: width < columns || height < rows,
  };
}

function cell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

/** Reads a workbook's worksheets, within a per-sheet cell budget. */
export async function readWorkbookSheets(api: GraphApi, ref: ItemRef, options: { sheet?: string; range?: string; maxCells: number }):
    Promise<{ worksheets: WorksheetContent[]; otherWorksheets: string[]; notes: string[] }> {
  const all = await listWorksheets(api, ref);
  const wanted = options.sheet === undefined
    ? all.filter(sheet => sheet.visible)
    : all.filter(sheet => sheet.name.toLowerCase() === options.sheet!.toLowerCase());
  if (options.sheet !== undefined && wanted.length === 0) {
    throw new Error(`This workbook has no worksheet named "${options.sheet}". Its worksheets are: ${all.map(sheet => sheet.name).join(", ")}.`);
  }
  const worksheets: WorksheetContent[] = [];
  const notes: string[] = [];
  for (const sheet of wanted.slice(0, 20)) {
    if (options.range !== undefined) {
      const range = await readRange(api, ref, sheet.id, options.range);
      const values = range.values.map(row => row.map(cell));
      worksheets.push({
        name: sheet.name, address: range.address || `${sheet.name}!${options.range}`, values,
        formulas: range.formulas ? range.formulas.map(row => row.map(cell)) : values, truncated: false,
      });
      continue;
    }
    const shape = await usedRangeShape(api, ref, sheet.id);
    if (shape.rowCount === 0 || shape.columnCount === 0 || shape.address === "") {
      worksheets.push({ name: sheet.name, address: shape.address, values: [], formulas: [], truncated: false });
      continue;
    }
    const bounded = boundedRange(topLeft(shape.address), shape.rowCount, shape.columnCount, options.maxCells);
    const range = await readRange(api, ref, sheet.id, bounded.address);
    const values = range.values.map(row => row.map(cell));
    worksheets.push({
      name: sheet.name,
      address: range.address || `${sheet.name}!${bounded.address}`,
      values,
      formulas: range.formulas ? range.formulas.map(row => row.map(cell)) : values,
      truncated: bounded.truncated,
    });
    if (bounded.truncated) notes.push(`Only part of "${sheet.name}" was read (${bounded.address} of ${shape.address}).`);
  }
  if (wanted.length > 20) notes.push(`Only the first 20 of ${wanted.length} worksheets were read.`);
  return {
    worksheets,
    otherWorksheets: all.filter(sheet => !wanted.slice(0, 20).includes(sheet)).map(sheet => sheet.name),
    notes,
  };
}

/** Escapes a cell for a Markdown table. */
function tableCell(value: CellValue): string {
  if (value === null) return "";
  return String(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Worksheets as Markdown: a heading and a table per sheet, the first row as the header. */
function workbookMarkdown(worksheets: readonly WorksheetContent[]): string {
  const sections: string[] = [];
  for (const sheet of worksheets) {
    const lines = [`## ${sheet.name}`, ""];
    if (sheet.values.length === 0) {
      lines.push("(empty)");
    } else {
      const width = Math.max(...sheet.values.map(row => row.length));
      const row = (cells: CellValue[]) => `| ${Array.from({ length: width }, (_, index) => tableCell(cells[index] ?? null)).join(" | ")} |`;
      lines.push(row(sheet.values[0]), `| ${Array<string>(width).fill("---").join(" | ")} |`);
      for (const values of sheet.values.slice(1)) lines.push(row(values));
      const formulas = sheet.formulas.flatMap((cells, r) => cells.flatMap((formula, c) =>
        typeof formula === "string" && formula.startsWith("=") ? [`${columnLetters(topLeft(sheet.address).column - 1 + c)}${topLeft(sheet.address).row + r}: \`${formula}\``] : []));
      if (formulas.length > 0) lines.push("", "Formulas:", ...formulas.slice(0, 200).map(formula => `- ${formula}`));
      if (sheet.truncated) lines.push("", "(Only part of this worksheet was read.)");
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

// -- pages --------------------------------------------------------------------------------------

/** A page's web parts as Markdown, and a note naming what could not be read. */
export function pageMarkdown(title: string, parts: readonly PageWebPart[]): { markdown: string; note?: string } {
  const blocks = [`# ${title.replace(/[\r\n]+/g, " ")}`];
  const other: string[] = [];
  for (const part of parts) {
    if (part.kind === "text") {
      const markdown = htmlToMarkdown(part.html);
      if (markdown) blocks.push(markdown);
    } else {
      other.push(part.title ?? "untitled web part");
    }
  }
  const notes: string[] = [];
  if (parts.length === 0) {
    notes.push("Graph returned no web parts for this page. Pages from SharePoint's built-in templates (like a site's " +
      "home page) often have content Graph can't read.");
  }
  if (other.length > 0) notes.push(`Not text, so not included: ${other.slice(0, 10).join(", ")}${other.length > 10 ? ", …" : ""}.`);
  return { markdown: blocks.join("\n\n"), ...(notes.length ? { note: notes.join(" ") } : {}) };
}
