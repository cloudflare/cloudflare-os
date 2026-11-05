// What a write puts in a file, from what the agent passed: Markdown becomes a Word document or a
// PowerPoint deck and rows or CSV an Excel workbook, by the file's extension, so files land in the
// formats people open them in. Bytes pass through, an Office file checked by `checkOfficePackage`,
// and a format that can run code when opened (macro-enabled, legacy binary) refused outright: the
// approver sees a byte upload only by its name. No Graph here: the session resolves a template and
// hands over its bytes.

import { isCompoundFile } from "./content/index";
import { checkOfficePackage } from "./content/package-check";
import { csvCells, parseCsv, rowsToXlsx, xlsxFeatures, type CellValue } from "./content/xlsx-write";
import { docxFeatures, markdownToDocx } from "./content/docx-write";
import { Deck } from "./content/pptx-deck";
import { describePptx, imageRefs, markdownToPptx, pptxFeatures, type PptxImage, type PptxImages } from "./content/pptx-write";
import type { Writing, WrittenAs } from "./sharepoint-actions";
import { MAX_UPLOAD_BYTES, extensionOf as extension } from "./sharepoint-content";
import type { SlideInfo, WorkbookRows } from "./types";

/** A source text longer than this is not kept for the approver, who is shown the file instead. */
const MAX_SOURCE_CHARS = 100_000;

/** The formats written from text, by extension. */
const WRITTEN: Record<string, WrittenAs> = { docx: "word", pptx: "powerpoint", xlsx: "excel" };

/** Formats whose files can run code when opened, so none is written at all, named for the refusal. */
const RUNS_CODE: Record<string, string> = {
  docm: "macro-enabled Word document", dotm: "macro-enabled Word template", xlsm: "macro-enabled workbook", xltm: "macro-enabled Excel template",
  xlam: "Excel add-in", xlsb: "binary workbook", pptm: "macro-enabled deck", potm: "macro-enabled PowerPoint template",
  ppsm: "macro-enabled slideshow", ppam: "PowerPoint add-in", doc: "Word 97-2003 document", dot: "Word 97-2003 template",
  xls: "Excel 97-2003 workbook", xlt: "Excel 97-2003 template", xla: "Excel 97-2003 add-in", ppt: "PowerPoint 97-2003 deck",
  pot: "PowerPoint 97-2003 template", pps: "PowerPoint 97-2003 slideshow", ppa: "PowerPoint 97-2003 add-in", rtf: "RTF document",
};

/** Binary formats a string would only corrupt, named for the refusal. */
const BINARY: Record<string, string> = {
  dotx: "Word templates", potx: "PowerPoint templates", xltx: "Excel templates", ppsx: "PowerPoint slideshows",
  pdf: "PDFs", png: "images", jpg: "images", jpeg: "images", gif: "images", webp: "images", zip: "zip files",
};

/** Extensions whose files are zip packages, so bytes that aren't one are refused. */
const PACKAGES = new Set(["docx", "xlsx", "pptx", "ppsx", "dotx", "potx", "xltx", "zip"]);

/**
 * Whether a name says a file is Office's: one whose content {@link encodeContent} checks, or
 * refuses for the code it can run. A rename or copy into such a name is refused, since the bytes
 * were checked as whatever the file was called before.
 */
export function isOfficeName(name: string): boolean {
  const ext = extension(name);
  return RUNS_CODE[ext] !== undefined || (PACKAGES.has(ext) && ext !== "zip");
}

/** A file a write will put in SharePoint. */
export type Encoded = {
  bytes: Uint8Array;
  /** What the approver is shown as the content: the Markdown or CSV it was written from, or the text itself. */
  source?: string;
  writing?: Writing;
};

/** A file whose look a written file takes. */
export type Template = { name: string; bytes: Uint8Array };

/** The format a file of this name is written as from text, if any. */
export function writtenAs(name: string): WrittenAs | undefined {
  return WRITTEN[extension(name)];
}

/** Whether a template suits a file of this name: a Word file for Word, a deck for PowerPoint. */
export function checkTemplate(name: string, template: string): void {
  const as = writtenAs(name);
  const wanted = as === "word" ? ["docx", "dotx"] : as === "powerpoint" ? ["pptx", "potx"] : [];
  if (wanted.length === 0) throw new Error("A template can only be used for a Word document (.docx) or PowerPoint deck (.pptx) written from Markdown.");
  if (!wanted.includes(extension(template))) {
    throw new Error(`A ${as === "word" ? "Word" : "PowerPoint"} file needs a ${wanted.map(ext => `.${ext}`).join(" or ")} template, not "${template}".`);
  }
}

/**
 * Encodes what the agent passed for a file named `name`. Throws an error the agent can act on for
 * content that doesn't suit the format.
 */
export async function encodeContent(
  name: string, content: string | Uint8Array | WorkbookRows,
  options: { template?: Template; images?: PptxImages; title?: string; author?: string; now?: Date } = {},
): Promise<Encoded> {
  const ext = extension(name);
  const as = WRITTEN[ext];
  const meta = { title: options.title ?? name.replace(/\.[^.]+$/, ""), ...(options.author ? { author: options.author } : {}), modifiedAt: options.now ?? new Date() };
  if (options.template !== undefined && (as === undefined || as === "excel" || typeof content !== "string")) {
    throw new Error("A template can only be used for a Word document (.docx) or PowerPoint deck (.pptx) written from Markdown.");
  }
  if (RUNS_CODE[ext] !== undefined) {
    throw new Error(`A ${RUNS_CODE[ext]} (${name}) can run code when opened, so it can't be written here. ` +
      "Save it as a .docx, .xlsx or .pptx without macros, or write one from Markdown, rows or CSV.");
  }
  let encoded: Encoded;
  if (content instanceof Uint8Array) {
    if (isCompoundFile(content)) {
      throw new Error("Those bytes are a legacy binary Office file, or a password-protected one, which can't be written here. " +
        "Save it as a .docx, .xlsx or .pptx without a password first.");
    }
    if (PACKAGES.has(ext) && !isZip(content)) {
      throw new Error(`Those bytes aren't a ${ext} file.${as ? ` To write one, pass ${as === "excel" ? "rows or CSV" : "Markdown"} as a string instead.` : ""}`);
    }
    await checkOfficePackage(ext, content);
    encoded = { bytes: content };
  } else if (Array.isArray(content)) {
    if (as !== "excel") throw new Error(`Rows can only be written to an Excel workbook (.xlsx), not "${name}". Pass a string or bytes instead.`);
    const sheets = isSheetList(content) ? content : undefined;
    const bytes = await rowsToXlsx(sheets ?? (content as CellValue[][]), meta);
    encoded = { bytes, source: rowsSource(content), writing: { as } };
  } else if (typeof content === "string") {
    if (as === "word" || as === "powerpoint") {
      const template = options.template ? { template: options.template.bytes } : {};
      const bytes = as === "word"
        ? await markdownToDocx(content, { ...meta, ...template })
        : await markdownToPptx(content, { ...meta, ...template, ...(options.images ? { images: options.images } : {}) });
      encoded = { bytes, source: content, writing: { as, ...(options.template ? { template: options.template.name } : {}) } };
    } else if (as === "excel") {
      encoded = { bytes: await rowsToXlsx(csvCells(parseCsv(content)), meta), source: content, writing: { as } };
    } else if (BINARY[ext] !== undefined) {
      throw new Error(`Text can't be written as one of the ${BINARY[ext]} "${name}" names. Pass the file's bytes, or choose ` +
        "a .docx, .pptx or .xlsx name to have it written from Markdown or CSV.");
    } else {
      encoded = { bytes: new TextEncoder().encode(content), source: content };
    }
  } else {
    throw new Error("Content must be a string, a Uint8Array, or rows for a workbook.");
  }
  if (encoded.bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error(`Files can be at most ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`);
  if (encoded.source !== undefined && encoded.source.length > MAX_SOURCE_CHARS) delete encoded.source;
  return encoded;
}

/**
 * What a file of this name holds that rewriting it wholesale would lose, in words for the approver.
 * Empty for a format this doesn't know, or one that can't be read.
 */
export async function featuresLost(name: string, bytes: Uint8Array): Promise<string[]> {
  try {
    switch (extension(name)) {
      case "docx": return await docxFeatures(bytes);
      case "pptx": return await pptxFeatures(bytes);
      case "xlsx": return await xlsxFeatures(bytes);
      default: return [];
    }
  } catch {
    // An unreadable file is still replaced; the approver sees the new content in full.
    return [];
  }
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function isSheetList(rows: WorkbookRows): rows is { name: string; rows: CellValue[][] }[] {
  return rows.length > 0 && rows.every(row => row !== null && typeof row === "object" && !Array.isArray(row));
}

/** Rows as the approver reads them: CSV, under each sheet's name when there are named sheets. */
function rowsSource(rows: WorkbookRows): string {
  const csv = (sheet: readonly (readonly CellValue[])[]) => sheet.map(row => row.map(csvField).join(",")).join("\n");
  return isSheetList(rows) ? rows.map(sheet => `# ${sheet.name}\n${csv(sheet.rows)}`).join("\n\n") : csv(rows as CellValue[][]);
}

function csvField(value: CellValue): string {
  if (value === null) return "";
  const text = typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

/** The pictures a deck's Markdown places, by the refs it names, which a caller resolves to files. */
export function slideImageRefs(markdown: string): string[] {
  return imageRefs(markdown);
}

/** The image types a slide can show, by media type. */
export const SLIDE_IMAGE_TYPES: ReadonlySet<string> = new Set<PptxImage["mimeType"]>(["image/png", "image/jpeg", "image/gif"]);

/** A deck's slides and the layouts a new slide may name. */
export async function presentationStructure(bytes: Uint8Array): Promise<{ slides: SlideInfo[]; layouts: string[] }> {
  const [slides, deck] = await Promise.all([describePptx(bytes), Deck.open(bytes)]);
  const layouts = [...new Set(deck.layouts().map(layout => layout.name || layout.type).filter(Boolean))];
  // A placeholder's `index` is the writer's own handle; agents address placeholders by name.
  return {
    slides: slides.map(slide => ({
      ...slide,
      placeholders: slide.placeholders.map(({ name, type, markdown }) => ({ name, type, markdown })),
      otherText: [...slide.otherText],
      images: slide.images.map(image => ({ ...image })),
    })),
    layouts,
  };
}

export type { PptxImages };
