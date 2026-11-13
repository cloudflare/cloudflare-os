// Word (.docx, .docm, .dotx, .dotm) as a layout model: what a renderer needs to draw the document
// the way Word does, as plain data with no DOM. Every paragraph and run carries fully resolved
// formatting, because WordprocessingML states almost none of it where it applies. This reader
// applies the inheritance itself:
//
//   paragraphs: document defaults → table style (and its conditional formats) → paragraph style
//               chain → numbering level → the paragraph's own properties
//   runs:       document defaults → table style → paragraph style's run properties → character
//               style chain → the run's own properties
//
// Pages are not broken the way Word breaks them: that needs Word's line breaking and its fonts.
// The body is one flow, split only where the document asks for a new page (a page break, a
// paragraph with "page break before", a section that starts a new page). The page setup, header
// and footer are the first section's.
//
// The file is untrusted. Parts are read through the bounded ZIP and XML readers, the body is
// streamed one block at a time, relationships marked external are never followed (a linked
// picture is reported as unsupported, not fetched), links keep only http, https and mailto
// targets, and the number of blocks is capped.

import {
  Numbering, StyleSheet, Theme, layered, layeredParagraph, layeredTable, numeric, readCellFormat, readParagraphFormat,
  readRunFormat, readTableFormat, symbolText, twips,
  type BorderEdges, type BorderFormat, type CellFormat, type CellMargins, type ParagraphFormat, type RunFormat,
  type TableFormat, type TableLook, type TableStyle, type TableStyleRegion,
} from "./docx-document-styles";
import {
  findMainPart, findRelationship, readPart, readPartText, readRelationships, streamPart, type Relationships,
} from "./ooxml";
import { attribute, childElements, firstChild, firstDescendant, textContent, type XmlElement } from "./xml";
import { openZip, type ZipArchive } from "./zip";
import { lookupTable } from "./lookup-table";

/** A page's size and margins, in points. */
export interface DocxPageSetup {
  readonly width: number;
  readonly height: number;
  readonly marginTop: number;
  readonly marginRight: number;
  readonly marginBottom: number;
  readonly marginLeft: number;
  /** From the top edge to the top of the header. */
  readonly headerDistance: number;
  /** From the bottom edge to the bottom of the footer. */
  readonly footerDistance: number;
}

/** A run's formatting, fully resolved. Sizes are in points and colours are `#RRGGBB`. */
export interface DocxRunProperties {
  /** The font's name as the file gives it, such as "Calibri". */
  readonly font: string;
  readonly size: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline?: "single" | "double" | "dotted" | "dashed" | "wavy" | undefined;
  /** Absent when the underline takes the text's colour. */
  readonly underlineColor?: string | undefined;
  readonly strike: boolean;
  /** Absent for Word's automatic colour, which is black on a light background. */
  readonly color?: string | undefined;
  readonly highlight?: string | undefined;
  readonly shading?: string | undefined;
  readonly verticalAlign: "baseline" | "superscript" | "subscript";
  readonly caps: boolean;
  readonly smallCaps: boolean;
  /** Extra space between characters; negative to tighten. */
  readonly letterSpacing: number;
}

/** A border line. */
export interface DocxBorder {
  readonly width: number;
  readonly color: string;
  readonly style: "solid" | "double" | "dashed" | "dotted";
  /** The gap between a paragraph border and its text. */
  readonly space: number;
}

/** The borders of a paragraph or table cell. */
export interface DocxBoxBorders {
  readonly top?: DocxBorder | undefined;
  readonly right?: DocxBorder | undefined;
  readonly bottom?: DocxBorder | undefined;
  readonly left?: DocxBorder | undefined;
}

/** A tab stop, measured from the left page margin. */
export interface DocxTabStop {
  readonly position: number;
  readonly alignment: "left" | "center" | "right";
}

/**
 * The height of a paragraph's lines: a multiple of the font's own line height (`auto`), a fixed
 * height in points (`exact`), or a minimum in points (`atLeast`).
 */
export interface DocxLineSpacing {
  readonly rule: "auto" | "exact" | "atLeast";
  readonly value: number;
}

/** A list paragraph's bullet or number. */
export interface DocxListMarker {
  /** The marker as Word would print it: "•", "3.", "b)", "2.1". */
  readonly text: string;
  readonly run: DocxRunProperties;
  /** What separates the marker from the text; a tab runs to the paragraph's left indent. */
  readonly suffix: "tab" | "space" | "nothing";
}

/** Content the model names but does not describe. */
export type DocxUnsupportedKind = "textBox" | "chart" | "diagram" | "equation" | "object" | "shape" | "picture";

/** A piece of a paragraph. */
export type DocxInline =
  /** `href` is an http, https or mailto address. */
  | { readonly kind: "text"; readonly text: string; readonly run: DocxRunProperties; readonly href?: string | undefined }
  | { readonly kind: "tab"; readonly run: DocxRunProperties }
  | { readonly kind: "break" }
  | DocxImage
  | { readonly kind: "unsupported"; readonly what: DocxUnsupportedKind };

/** A picture stored in the file, at the size the document gives it. */
export interface DocxImage {
  readonly kind: "image";
  /** Shared with every other use of the same picture; do not modify. */
  readonly bytes: Uint8Array;
  /** Decided from the bytes, never from the file's own claim: PNG, JPEG, GIF, BMP or WebP. */
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly description?: string | undefined;
  readonly outline?: DocxBorder | undefined;
  /** The radius of the picture's corners when it is cropped to a rounded rectangle. */
  readonly cornerRadius?: number | undefined;
  readonly href?: string | undefined;
}

/** A paragraph. Lengths are in points. */
export interface DocxParagraph {
  readonly kind: "paragraph";
  /** 1 to 9 for a heading. */
  readonly headingLevel?: number | undefined;
  readonly alignment: "left" | "center" | "right" | "justify";
  readonly spacingBefore: number;
  readonly spacingAfter: number;
  readonly lineSpacing: DocxLineSpacing;
  readonly indentLeft: number;
  readonly indentRight: number;
  /** Positive for a first-line indent, negative for a hanging one. */
  readonly indentFirstLine: number;
  readonly borders: DocxBoxBorders;
  readonly shading?: string | undefined;
  /** The paragraph's own stops, in order. Past the last, stops fall every `defaultTabStop`. */
  readonly tabStops: readonly DocxTabStop[];
  readonly marker?: DocxListMarker | undefined;
  /** The formatting of the paragraph mark, which gives an empty paragraph its height. */
  readonly mark: DocxRunProperties;
  readonly inlines: readonly DocxInline[];
}

/** A table cell. A cell merged into the one above or beside it is not listed. */
export interface DocxTableCell {
  readonly columnSpan: number;
  readonly rowSpan: number;
  readonly borders: DocxBoxBorders;
  readonly shading?: string | undefined;
  readonly margins: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };
  readonly verticalAlign: "top" | "center" | "bottom";
  readonly blocks: readonly DocxBlock[];
}

/** A table row. */
export interface DocxTableRow {
  /** The row's least height, or its exact height when `exactHeight` is set. */
  readonly height?: number | undefined;
  readonly exactHeight: boolean;
  readonly cells: readonly DocxTableCell[];
}

/** A table. */
export interface DocxTable {
  readonly kind: "table";
  /** The width of each grid column; empty when the file gives no grid. */
  readonly columnWidths: readonly number[];
  /** How far the table's left edge sits from the left margin; negative when it hangs into it. */
  readonly indent: number;
  readonly alignment: "left" | "center" | "right";
  readonly rows: readonly DocxTableRow[];
}

/** Where the document asks for a new page. */
export interface DocxPageBreak {
  readonly kind: "pageBreak";
}

/** A block of the body, a header, a footer or a table cell. */
export type DocxBlock = DocxParagraph | DocxTable | DocxPageBreak;

/** A Word document, ready to draw. */
export interface DocxDocument {
  readonly page: DocxPageSetup;
  /** The first section's default header and footer; empty when it has none. */
  readonly header: readonly DocxBlock[];
  readonly footer: readonly DocxBlock[];
  readonly body: readonly DocxBlock[];
  /** The spacing of the tab stops a paragraph has past its own. */
  readonly defaultTabStop: number;
  /** What the document holds that the model leaves out; `notes` is the text of foot- and endnotes. */
  readonly omitted: readonly (DocxUnsupportedKind | "notes")[];
  /** True when the document had more blocks than the reader keeps and its end was dropped. */
  readonly truncated: boolean;
}

/** The most paragraphs and tables (nested ones included) read from one document. */
const MAX_BLOCKS = 5_000;
/** The most blocks read from the header and the footer together. */
const MAX_MARGIN_BLOCKS = 200;
const MAX_TABLE_DEPTH = 8;
const MAX_GRID_SPAN = 64;
/** The most rows read from one table; a table can hold rows with no cells, which the block limit does not count. */
const MAX_TABLE_ROWS = 5_000;
/** The most table cells read from one document, which the block limit does not count either: a cell may be empty. */
const MAX_TABLE_CELLS = 50_000;
/**
 * The most fields one may sit inside. Each run looks through the fields it is in, so a run inside
 * thousands of fields never closed would cost runs times fields; real documents nest a few.
 */
const MAX_FIELD_NESTING = 32;

/** Reads a Word document into a layout model. Throws `DocumentConversionError`, `ZipError` or `XmlError`. */
export async function readDocxDocument(bytes: Uint8Array, options: { readonly maxBlocks?: number } = {}): Promise<DocxDocument> {
  const zip = openZip(bytes);
  const mainPart = await findMainPart(zip, "word/document.xml");
  const relationships = await readRelationships(zip, mainPart);
  const related = async (type: string): Promise<XmlElement | undefined> => {
    const relationship = findRelationship(relationships, type);
    return relationship ? readPart(zip, relationship.target) : undefined;
  };
  const theme = new Theme(await related("theme"));
  const styles = new StyleSheet(await related("styles"), theme);
  const settings = await related("settings");
  const compatibilityMode = childElements(firstChild(settings, "w:compat"), "w:compatSetting")
    .find(setting => attribute(setting, "w:name") === "compatibilityMode");
  const document: DocumentContext = {
    zip,
    styles,
    numbering: new Numbering(await related("numbering"), styles, theme),
    theme,
    // Before Word 2013 a table hung into the margin by its cell padding, so that its text, not
    // its border, lined up with the paragraphs around it. A file says which behaviour it expects.
    outdentTables: (numeric(attribute(compatibilityMode, "w:val")) ?? 12) < 15,
    blocksLeft: Math.min(MAX_BLOCKS, options.maxBlocks ?? MAX_BLOCKS),
    cellsLeft: MAX_TABLE_CELLS,
    truncated: false,
    omitted: new Set(),
    notes: 0,
    contextual: new WeakMap(),
  };
  const bodyText = await readPartText(zip, mainPart);
  const part = await openPart(document, mainPart, relationships);

  const body: DocxBlock[] = [];
  let firstSection: XmlElement | undefined;
  let sectionBreak: DocxPageBreak | undefined;
  // A section's properties sit at its end and say how it began, so the break before a section is
  // only known to be one once that section closes.
  const endSection = (section: XmlElement): void => {
    firstSection ??= section;
    const type = attribute(firstChild(section, "w:type"), "w:val");
    if (sectionBreak && (type === "continuous" || type === "nextColumn")) body.splice(body.lastIndexOf(sectionBreak), 1);
    sectionBreak = undefined;
  };

  // Depth 2 is w:document > w:body > each block.
  for (const element of streamPart(bodyText, 2)) {
    if (element.name === "w:sectPr") {
      endSection(element);
      continue;
    }
    if (document.blocksLeft <= 0) {
      // Not a break: the page setup and the header and footer references are in the section
      // properties that close the body, after everything left out.
      document.truncated = true;
      continue;
    }
    body.push(...readBlock(element, part, undefined, 0));
    const section = element.name === "w:p" ? firstChild(firstChild(element, "w:pPr"), "w:sectPr") : undefined;
    if (section) {
      endSection(section);
      body.push(sectionBreak = { kind: "pageBreak" });
    }
  }
  if (sectionBreak) body.splice(body.lastIndexOf(sectionBreak), 1);
  applyContextualSpacing(body, document);

  // The header and footer have a budget of their own: a body that used all of its blocks still
  // has them, and their length says nothing about whether the body was cut short.
  const truncated = document.truncated;
  document.blocksLeft = MAX_MARGIN_BLOCKS;

  return {
    page: readPageSetup(firstSection),
    header: await readHeaderOrFooter(document, relationships, firstSection, "w:headerReference"),
    footer: await readHeaderOrFooter(document, relationships, firstSection, "w:footerReference"),
    body,
    defaultTabStop: twips(firstChild(settings, "w:defaultTabStop"), "w:val") || 36,
    omitted: [...document.omitted],
    truncated,
  };
}

interface DocumentContext {
  readonly zip: ZipArchive;
  readonly styles: StyleSheet;
  readonly numbering: Numbering;
  readonly theme: Theme;
  readonly outdentTables: boolean;
  blocksLeft: number;
  cellsLeft: number;
  truncated: boolean;
  readonly omitted: Set<DocxUnsupportedKind | "notes">;
  /** Foot- and endnote references seen so far, which number them. */
  notes: number;
  /** For each paragraph, what deciding its contextual spacing needs once its neighbours are known. */
  readonly contextual: WeakMap<DocxParagraph, { readonly styleId: string | undefined; readonly contextual: boolean }>;
}

/** A part whose content is being read: the body, a header or a footer. */
interface PartContext {
  readonly document: DocumentContext;
  readonly relationships: Relationships;
  /** The part's embedded pictures by part name, read ahead so the walk over its content can stay synchronous. */
  readonly images: ReadonlyMap<string, LoadedImage>;
}

interface LoadedImage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

async function openPart(document: DocumentContext, partName: string, relationships?: Relationships): Promise<PartContext> {
  const own = relationships ?? await readRelationships(document.zip, partName);
  const images = new Map<string, LoadedImage>();
  for (const relationship of own.values()) {
    if (relationship.type !== "image" || relationship.external || images.has(relationship.target)) continue;
    try {
      const bytes = await document.zip.readBytes(relationship.target);
      const contentType = rasterType(bytes);
      if (contentType) images.set(relationship.target, { bytes, contentType });
    } catch {
      // A picture that is missing or over the archive's budget is drawn as a placeholder.
    }
  }
  return { document, relationships: own, images };
}

/** The image type the bytes really are, for the raster formats a browser draws; undefined for anything else. */
function rasterType(bytes: Uint8Array): string | undefined {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x42, 0x4d)) return "image/bmp";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return undefined;
}

// ---- Sections ----

const LETTER: DocxPageSetup = {
  width: 612, height: 792, marginTop: 72, marginRight: 72, marginBottom: 72, marginLeft: 72, headerDistance: 36, footerDistance: 36,
};

function readPageSetup(section: XmlElement | undefined): DocxPageSetup {
  const size = firstChild(section, "w:pgSz");
  const margins = firstChild(section, "w:pgMar");
  const positive = (value: number | undefined, fallback: number): number => value !== undefined && value > 0 ? value : fallback;
  // A negative top or bottom margin is Word's way of saying "exactly this, whatever the header needs".
  const margin = (name: string, fallback: number): number => Math.abs(twips(margins, name) ?? fallback);
  return {
    width: positive(twips(size, "w:w"), LETTER.width),
    height: positive(twips(size, "w:h"), LETTER.height),
    marginTop: margin("w:top", LETTER.marginTop),
    marginRight: margin("w:right", LETTER.marginRight),
    marginBottom: margin("w:bottom", LETTER.marginBottom),
    marginLeft: margin("w:left", LETTER.marginLeft),
    headerDistance: margin("w:header", LETTER.headerDistance),
    footerDistance: margin("w:footer", LETTER.footerDistance),
  };
}

async function readHeaderOrFooter(
  document: DocumentContext, relationships: Relationships, section: XmlElement | undefined, reference: string,
): Promise<DocxBlock[]> {
  const references = childElements(section, reference);
  const chosen = references.find(element => attribute(element, "w:type") === "default") ?? references.find(element => !attribute(element, "w:type"));
  const relationship = relationships.get(attribute(chosen, "r:id") ?? "");
  if (!relationship || relationship.external || !document.zip.has(relationship.target)) return [];
  const root = await readPart(document.zip, relationship.target);
  const part = await openPart(document, relationship.target);
  const blocks = childElements(root).flatMap(element => readBlock(element, part, undefined, 0));
  applyContextualSpacing(blocks, document);
  return blocks.filter(block => block.kind !== "pageBreak");
}

// ---- Blocks ----

/** What a table gives the paragraphs of one of its cells. */
interface CellContext {
  readonly paragraph: ParagraphFormat;
  readonly run: RunFormat;
  readonly background: string | undefined;
}

function readBlock(element: XmlElement, part: PartContext, cell: CellContext | undefined, tableDepth: number): DocxBlock[] {
  switch (element.name) {
    case "w:p":
      return takeBlock(part.document) ? readParagraph(element, part, cell) : [];
    case "w:tbl":
      return takeBlock(part.document) && tableDepth < MAX_TABLE_DEPTH ? [readTable(element, part, tableDepth)] : [];
    case "w:sdt":
      return childElements(firstChild(element, "w:sdtContent")).flatMap(child => readBlock(child, part, cell, tableDepth));
    case "w:customXml":
    case "w:sdtContent":
      return childElements(element).flatMap(child => readBlock(child, part, cell, tableDepth));
    case "w:altChunk":
      part.document.omitted.add("object");
      return [];
    default:
      return [];
  }
}

function takeBlock(document: DocumentContext): boolean {
  if (document.blocksLeft <= 0) {
    document.truncated = true;
    return false;
  }
  document.blocksLeft--;
  return true;
}

/**
 * "Don't add space between paragraphs of the same style": a paragraph that asks for it gives up
 * the spacing on the side of a neighbour that shares its style.
 */
function applyContextualSpacing(blocks: readonly DocxBlock[], document: DocumentContext): void {
  for (let index = 0; index + 1 < blocks.length; index++) {
    const above = blocks[index]!;
    const below = blocks[index + 1]!;
    if (above.kind !== "paragraph" || below.kind !== "paragraph") continue;
    const aboveStyle = document.contextual.get(above);
    const belowStyle = document.contextual.get(below);
    if (!aboveStyle || !belowStyle || aboveStyle.styleId !== belowStyle.styleId) continue;
    if (aboveStyle.contextual) (above as Mutable<DocxParagraph>).spacingAfter = 0;
    if (belowStyle.contextual) (below as Mutable<DocxParagraph>).spacingBefore = 0;
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// ---- Paragraphs ----

/** A paragraph's formatting with every layer applied, and what its runs start from. */
interface ResolvedParagraph {
  readonly styleId: string | undefined;
  readonly format: ParagraphFormat;
  /** Document defaults, table style and paragraph style: the base of each run. */
  readonly runBase: RunFormat;
  readonly headingLevel: number | undefined;
  readonly numbering: { readonly numId: string; readonly level: number } | undefined;
  readonly background: string | undefined;
}

function resolveParagraph(properties: XmlElement | undefined, part: PartContext, cell: CellContext | undefined): ResolvedParagraph {
  const { styles, numbering, theme } = part.document;
  const styleId = attribute(firstChild(properties, "w:pStyle"), "w:val");
  const style = styles.paragraphStyle(styleId);
  const direct = readParagraphFormat(properties, theme);

  const numId = direct.numId ?? style.paragraph.numId;
  const listed = numId !== undefined && numId !== "0";
  const level = listed ? clampLevel(direct.level ?? style.paragraph.level ?? numbering.styleLevel(numId, styleId)) : 0;
  const format = layeredParagraph(
    styles.defaults.paragraph, cell?.paragraph, style.paragraph, listed ? numbering.level(numId, level)?.paragraph : undefined, direct,
  );
  const outline = format.outlineLevel;
  return {
    styleId,
    format,
    runBase: layered(styles.defaults.run, cell?.run, style.run),
    headingLevel: outline !== undefined && outline >= 0 && outline <= 8 ? outline + 1 : style.headingLevel,
    numbering: listed ? { numId, level } : undefined,
    background: format.shading !== undefined && format.shading !== "none" ? format.shading : cell?.background,
  };
}

function clampLevel(level: number): number {
  return Math.max(0, Math.min(8, Math.trunc(level)));
}

/** What a paragraph is read into before it is split at its page breaks. */
type WalkedInline = DocxInline | DocxPageBreak;

function readParagraph(paragraph: XmlElement, part: PartContext, cell: CellContext | undefined): DocxBlock[] {
  const { document } = part;
  const properties = firstChild(paragraph, "w:pPr");
  const resolved = resolveParagraph(properties, part, cell);
  const markFormat = layered(resolved.runBase, readRunFormat(firstChild(properties, "w:rPr"), document.theme));

  const walk: InlineWalk = { part, resolved, inlines: [], fields: [], unnested: 0 };
  walkInlines(paragraph, walk, undefined);

  // The marker is counted even for a paragraph that ends up split or empty, as Word numbers it.
  const item = resolved.numbering ? document.numbering.next(resolved.numbering.numId, resolved.numbering.level) : undefined;
  const marker = item && item.level.format !== "none" ? listMarker(item.text, layered(markFormat, item.level.run), item.level.suffix, resolved) : undefined;

  const pieces: DocxInline[][] = [[]];
  for (const inline of walk.inlines) {
    if (inline.kind === "pageBreak") pieces.push([]);
    else pieces[pieces.length - 1]!.push(inline);
  }
  // Word ignores a page break inside a table.
  const flow = cell ? [pieces.flat()] : pieces;

  const { format } = resolved;
  const line = format.line ?? 240;
  const rule = format.lineRule ?? "auto";
  const blocks: DocxBlock[] = [];
  if (!cell && format.pageBreakBefore) blocks.push({ kind: "pageBreak" });
  let marked = false;
  flow.forEach((inlines, index) => {
    // Each page break makes a paragraph two blocks more, which the document's budget pays for.
    if (index > 0 && !(takeBlock(document) && takeBlock(document))) return;
    if (index > 0) blocks.push({ kind: "pageBreak" });
    // A break at either end of a paragraph leaves no empty paragraph beside it.
    if (inlines.length === 0 && flow.length > 1) return;
    const block: DocxParagraph = {
      kind: "paragraph",
      headingLevel: resolved.headingLevel,
      alignment: format.alignment ?? "left",
      spacingBefore: Math.max(0, format.spacingBefore ?? 0),
      spacingAfter: Math.max(0, format.spacingAfter ?? 0),
      lineSpacing: { rule, value: rule === "auto" ? line / 240 : line / 20 },
      indentLeft: format.indentLeft ?? 0,
      indentRight: format.indentRight ?? 0,
      indentFirstLine: format.indentFirstLine ?? 0,
      borders: boxBorders(format.borders ?? {}),
      shading: format.shading === "none" ? undefined : format.shading,
      tabStops: (format.tabs ?? []).filter(tab => !tab.clear)
        .map(({ position, alignment }) => ({ position, alignment }))
        .toSorted((a, b) => a.position - b.position),
      marker: marked ? undefined : marker,
      mark: runProperties(markFormat, resolved.background),
      inlines,
    };
    document.contextual.set(block, { styleId: resolved.styleId, contextual: format.contextualSpacing === true });
    blocks.push(block);
    marked = true;
  });
  return blocks;
}

function listMarker(text: string, format: RunFormat, suffix: DocxListMarker["suffix"], resolved: ResolvedParagraph): DocxListMarker {
  const symbol = symbolText(text, format.font);
  // The glyph now stands in the paragraph's own font; the symbol font could not draw it.
  const run = runProperties(symbol === undefined ? format : { ...format, font: resolved.runBase.font }, resolved.background);
  return { text: symbol ?? text, run, suffix };
}

function boxBorders(edges: BorderEdges): DocxBoxBorders {
  const edge = (border: BorderFormat | undefined): DocxBorder | undefined => border === "none" ? undefined : border;
  return { top: edge(edges.top), right: edge(edges.right), bottom: edge(edges.bottom), left: edge(edges.left) };
}

// ---- Runs ----

const DEFAULT_FONT = "Times New Roman";
/** What Word uses when neither the document defaults nor a style gives a size. */
const DEFAULT_SIZE = 10;

/** A run's final formatting. Automatic text turns white on a dark background, as in Word. */
function runProperties(format: RunFormat, background: string | undefined): DocxRunProperties {
  const shading = format.shading === "none" ? undefined : format.shading;
  const highlight = format.highlight === "none" ? undefined : format.highlight;
  const behind = highlight ?? shading ?? background;
  const automatic = format.color === undefined || format.color === "auto";
  return {
    font: format.font || DEFAULT_FONT,
    size: format.size !== undefined && format.size > 0 ? Math.min(format.size, 1638) : DEFAULT_SIZE,
    bold: format.bold === true,
    italic: format.italic === true,
    underline: format.underline === "none" ? undefined : format.underline,
    underlineColor: format.underlineColor === "auto" ? undefined : format.underlineColor,
    strike: format.strike === true,
    color: automatic ? (behind && isDark(behind) ? "#FFFFFF" : undefined) : format.color,
    highlight,
    shading,
    verticalAlign: format.verticalAlign ?? "baseline",
    caps: format.caps === true,
    smallCaps: format.smallCaps === true,
    letterSpacing: format.letterSpacing ?? 0,
  };
}

function isDark(color: string): boolean {
  const channel = (at: number) => Number.parseInt(color.slice(at, at + 2), 16);
  return 0.299 * channel(1) + 0.587 * channel(3) + 0.114 * channel(5) < 96;
}

/** One complex field (`w:fldChar` begin … separate … end) the walk is inside. */
interface FieldFrame {
  instruction: string;
  /** False while in the field's code, whose runs are instructions rather than text. */
  inResult: boolean;
  /** For a HYPERLINK field, its vetted target, applied to the result runs. */
  href: string | undefined;
}

interface InlineWalk {
  readonly part: PartContext;
  readonly resolved: ResolvedParagraph;
  readonly inlines: WalkedInline[];
  readonly fields: FieldFrame[];
  /** Fields opened past `MAX_FIELD_NESTING`, which are not followed but still have to close. */
  unnested: number;
}

/**
 * Walks paragraph content. Tracked insertions are read as text and tracked deletions skipped, so
 * the model is the document with every change accepted. A field shows the result Word last
 * computed for it.
 */
function walkInlines(parent: XmlElement | undefined, walk: InlineWalk, href: string | undefined): void {
  for (const child of childElements(parent)) {
    switch (child.name) {
      case "w:r":
        walkRun(child, walk, href);
        break;
      case "w:hyperlink":
        walkInlines(child, walk, hyperlinkTarget(child, walk.part.relationships) ?? href);
        break;
      case "w:fldSimple":
        walkInlines(child, walk, fieldHyperlink(attribute(child, "w:instr") ?? "") ?? href);
        break;
      case "w:sdt":
        walkInlines(firstChild(child, "w:sdtContent"), walk, href);
        break;
      case "w:ins":
      case "w:moveTo":
      case "w:smartTag":
      case "w:customXml":
      case "w:dir":
      case "w:bdo":
        walkInlines(child, walk, href);
        break;
      case "m:oMath":
      case "m:oMathPara":
        unsupported(walk, "equation");
        break;
    }
  }
}

function unsupported(walk: InlineWalk, what: DocxUnsupportedKind): void {
  walk.part.document.omitted.add(what);
  walk.inlines.push({ kind: "unsupported", what });
}

function walkRun(element: XmlElement, walk: InlineWalk, href: string | undefined): void {
  const { styles, theme } = walk.part.document;
  const properties = firstChild(element, "w:rPr");
  const format = layered(
    walk.resolved.runBase,
    styles.characterStyle(attribute(firstChild(properties, "w:rStyle"), "w:val")),
    readRunFormat(properties, theme),
  );
  if (format.hidden) {
    // A hidden run still opens and closes fields: missing one would leave the rest of the
    // paragraph read as field code.
    for (const child of childElements(element, "w:fldChar")) advanceField(walk, attribute(child, "w:fldCharType"));
    return;
  }
  const run = runProperties(format, walk.resolved.background);

  for (const child of childElements(element)) {
    if (child.name === "w:fldChar") {
      advanceField(walk, attribute(child, "w:fldCharType"));
      continue;
    }
    const field = walk.fields[walk.fields.length - 1];
    if (child.name === "w:instrText" && field && !field.inResult) field.instruction += textContent(child);
    if (walk.fields.some(frame => !frame.inResult)) continue;
    walkRunContent(child, walk, run, format, walk.fields.findLast(frame => frame.href)?.href ?? href);
  }
}

function walkRunContent(child: XmlElement, walk: InlineWalk, run: DocxRunProperties, format: RunFormat, href: string | undefined): void {
  const text = (value: string, properties = run): void => {
    if (value !== "") walk.inlines.push({ kind: "text", text: value, run: properties, href });
  };
  switch (child.name) {
    case "w:t": {
      // A line end inside text is white space to Word, not a break.
      const content = textContent(child).replace(/[\r\n]+/g, " ");
      return text(symbolText(content, format.font) ?? content);
    }
    case "w:sym": {
      const code = Number.parseInt(attribute(child, "w:char") ?? "", 16);
      if (Number.isNaN(code)) return;
      return text(symbolText(String.fromCharCode(code), attribute(child, "w:font")) ?? String.fromCharCode(code));
    }
    case "w:tab":
    case "w:ptab":
      walk.inlines.push({ kind: "tab", run });
      return;
    case "w:noBreakHyphen":
      return text("‑");
    case "w:softHyphen":
      return text("­");
    case "w:br":
      // A column break has nowhere to go in one flow, so it breaks the line.
      walk.inlines.push(attribute(child, "w:type") === "page" ? { kind: "pageBreak" } : { kind: "break" });
      return;
    case "w:cr":
      walk.inlines.push({ kind: "break" });
      return;
    case "w:drawing":
      return walkDrawing(child, walk, href);
    case "w:pict":
    case "w:object":
      return walkVml(child, walk, href);
    case "w:footnoteReference":
    case "w:endnoteReference": {
      const { document } = walk.part;
      document.omitted.add("notes");
      const superscript = runProperties({ ...format, verticalAlign: "superscript" }, walk.resolved.background);
      walk.inlines.push({ kind: "text", text: String(++document.notes), run: superscript });
      return;
    }
  }
}

function advanceField(walk: InlineWalk, type: string | undefined): void {
  const { fields } = walk;
  if (walk.unnested > 0) {
    if (type === "begin") walk.unnested++;
    else if (type === "end") walk.unnested--;
  } else if (type === "begin") {
    if (fields.length < MAX_FIELD_NESTING) fields.push({ instruction: "", inResult: false, href: undefined });
    else walk.unnested++;
  } else if (type === "separate") {
    const field = fields[fields.length - 1];
    if (field) {
      field.inResult = true;
      field.href = fieldHyperlink(field.instruction);
    }
  } else if (type === "end") {
    fields.pop();
  }
}

/** A `HYPERLINK "url"` field's target. A field with only `\l "bookmark"` is an internal jump. */
function fieldHyperlink(instruction: string): string | undefined {
  const match = /^\s*HYPERLINK\s+"([^"]+)"/i.exec(instruction);
  return match ? safeHref(match[1]!) : undefined;
}

/** A `w:hyperlink`'s external target. Links to bookmarks (`w:anchor` alone) stay plain text. */
function hyperlinkTarget(link: XmlElement, relationships: Relationships): string | undefined {
  const relationship = relationships.get(attribute(link, "r:id") ?? "");
  if (!relationship?.external) return undefined;
  const anchor = attribute(link, "w:anchor");
  return safeHref(anchor ? `${relationship.target}#${anchor}` : relationship.target);
}

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** The address a link may open: an absolute http, https or mailto URL, and nothing else. */
function safeHref(target: string): string | undefined {
  let url: URL;
  try {
    url = new URL(target.trim());
  } catch {
    return undefined;
  }
  return SAFE_SCHEMES.has(url.protocol) ? url.href : undefined;
}

// ---- Pictures ----

const EMU_PER_POINT = 12_700;

/**
 * A DrawingML object. Only a picture is drawn, and it is placed in the line whether it was inline
 * or floating; a text box, chart, diagram or shape is named so the renderer can mark its place.
 */
function walkDrawing(drawing: XmlElement, walk: InlineWalk, href: string | undefined): void {
  if (firstDescendant(drawing, "w:txbxContent")) return unsupported(walk, "textBox");
  const kind = attribute(firstDescendant(drawing, "a:graphicData"), "uri") ?? "";
  if (kind.endsWith("/chart")) return unsupported(walk, "chart");
  if (kind.endsWith("/diagram")) return unsupported(walk, "diagram");

  const blip = firstDescendant(drawing, "a:blip");
  if (!blip) return unsupported(walk, "shape");
  const image = embeddedImage(walk.part, attribute(blip, "r:embed"));
  const extent = firstDescendant(drawing, "wp:extent");
  const width = (numeric(attribute(extent, "cx")) ?? 0) / EMU_PER_POINT;
  const height = (numeric(attribute(extent, "cy")) ?? 0) / EMU_PER_POINT;
  if (!image || width <= 0 || height <= 0) return unsupported(walk, "picture");

  const docPr = firstDescendant(drawing, "wp:docPr");
  const line = firstChild(firstDescendant(drawing, "pic:spPr"), "a:ln");
  const lineColor = attribute(firstChild(firstChild(line, "a:solidFill"), "a:srgbClr"), "val");
  const lineWidth = (numeric(attribute(line, "w")) ?? 0) / EMU_PER_POINT;
  const geometry = firstChild(firstDescendant(drawing, "pic:spPr"), "a:prstGeom");
  // A rounded rectangle's one adjustment is its radius, in 100,000ths of its shorter side.
  const rounding = /^val (\d{1,6})$/.exec(attribute(firstDescendant(geometry, "a:gd"), "fmla") ?? "")?.[1] ?? "16667";
  walk.inlines.push({
    kind: "image",
    ...image,
    width,
    height,
    description: attribute(docPr, "descr") || attribute(docPr, "title") || undefined,
    outline: lineColor !== undefined && /^[0-9a-fA-F]{6}$/.test(lineColor) && lineWidth > 0
      ? { width: lineWidth, color: `#${lineColor.toUpperCase()}`, style: "solid", space: 0 }
      : undefined,
    cornerRadius: attribute(geometry, "prst") === "roundRect" ? Math.min(width, height) * Math.min(Number(rounding), 50_000) / 100_000 : undefined,
    href,
  });
}

/** A legacy VML picture, sized by its shape's CSS-like style; embedded objects and VML text boxes are named only. */
function walkVml(element: XmlElement, walk: InlineWalk, href: string | undefined): void {
  if (firstDescendant(element, "w:txbxContent")) return unsupported(walk, "textBox");
  if (element.name === "w:object") return unsupported(walk, "object");
  const data = firstDescendant(element, "v:imagedata");
  if (!data) return unsupported(walk, "shape");
  const image = embeddedImage(walk.part, attribute(data, "r:id"));
  const style = attribute(firstDescendant(element, "v:shape"), "style") ?? "";
  const width = vmlLength(style, "width");
  const height = vmlLength(style, "height");
  if (!image || width === undefined || height === undefined) return unsupported(walk, "picture");
  walk.inlines.push({ kind: "image", ...image, width, height, description: attribute(data, "o:title") || undefined, href });
}

const POINTS_PER_UNIT: Readonly<Record<string, number>> = lookupTable({ pt: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, px: 0.75 });

function vmlLength(style: string, property: string): number | undefined {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([0-9.]+)(pt|in|cm|mm|px)`).exec(style);
  const value = match ? Number.parseFloat(match[1]!) * POINTS_PER_UNIT[match[2]!]! : undefined;
  return value !== undefined && value > 0 ? value : undefined;
}

/** A picture stored in the package. One that is linked from elsewhere is never fetched. */
function embeddedImage(part: PartContext, relationshipId: string | undefined): LoadedImage | undefined {
  const relationship = part.relationships.get(relationshipId ?? "");
  return relationship && !relationship.external ? part.images.get(relationship.target) : undefined;
}

// ---- Tables ----

interface GridCell {
  readonly element: XmlElement;
  readonly properties: XmlElement | undefined;
  readonly column: number;
  readonly span: number;
  readonly merge: "restart" | "continue" | undefined;
}

interface GridRow {
  readonly properties: XmlElement | undefined;
  readonly cells: readonly GridCell[];
  /** The row's cells by the column each starts at, for finding the cell above or below one. */
  readonly byColumn: ReadonlyMap<number, GridCell>;
}

const DEFAULT_LOOK: TableLook = {
  firstRow: true, lastRow: false, firstColumn: true, lastColumn: false, bandedRows: true, bandedColumns: false,
};

function readTable(table: XmlElement, part: PartContext, depth: number): DocxTable {
  const { document } = part;
  const properties = firstChild(table, "w:tblPr");
  const style = document.styles.tableStyle(attribute(firstChild(properties, "w:tblStyle"), "w:val"));
  const format = layeredTable(style.table, readTableFormat(properties, document.theme));
  const look = format.look ?? DEFAULT_LOOK;

  const grid: GridRow[] = [];
  for (const row of unwrapped(table, "w:tr")) {
    const rowProperties = firstChild(row, "w:trPr");
    // A row deleted under tracked changes.
    if (firstChild(rowProperties, "w:del")) continue;
    if (grid.length >= MAX_TABLE_ROWS) {
      document.truncated = true;
      break;
    }
    let column = gridValue(rowProperties, "w:gridBefore", 0);
    const cells: GridCell[] = [];
    for (const element of unwrapped(row, "w:tc")) {
      const cellProperties = firstChild(element, "w:tcPr");
      const merge = firstChild(cellProperties, "w:vMerge");
      const span = Math.max(1, gridValue(cellProperties, "w:gridSpan", 1));
      cells.push({
        element, properties: cellProperties, column, span,
        merge: !merge ? undefined : attribute(merge, "w:val") === "restart" ? "restart" : "continue",
      });
      column += span;
    }
    document.cellsLeft -= cells.length;
    if (document.cellsLeft < 0) {
      document.truncated = true;
      break;
    }
    grid.push({ properties: rowProperties, cells, byColumn: new Map(cells.map(cell => [cell.column, cell])) });
  }

  const columnWidths = childElements(firstChild(table, "w:tblGrid"), "w:gridCol").map(column => Math.max(0, twips(column, "w:w") ?? 0));
  let columnCount = columnWidths.length;
  for (const row of grid) {
    for (const cell of row.cells) columnCount = Math.max(columnCount, cell.column + cell.span);
  }
  const shape: TableShape = { rows: grid.length, columns: columnCount, look, format, style };

  const rows = grid.map((row, rowIndex): DocxTableRow => {
    const height = firstChild(row.properties, "w:trHeight");
    const cells: DocxTableCell[] = [];
    const leading = row.cells[0]?.column ?? 0;
    if (leading > 0) cells.push(spacerCell(leading));
    for (const cell of row.cells) {
      const above = grid[rowIndex - 1]?.byColumn.get(cell.column);
      // A cell that continues a merge is part of the cell above; one with nothing above it starts its own.
      if (cell.merge === "continue" && above?.merge) continue;
      let rowSpan = 1;
      if (cell.merge) {
        while (grid[rowIndex + rowSpan]?.byColumn.get(cell.column)?.merge === "continue") rowSpan++;
      }
      cells.push(readCell(cell, { row: rowIndex, rowSpan }, shape, part, depth));
    }
    return { height: twips(height, "w:val"), exactHeight: attribute(height, "w:hRule") === "exact", cells };
  });

  const margin = format.cellMargins?.left ?? DEFAULT_CELL_MARGIN;
  return {
    kind: "table",
    columnWidths: columnWidths.every(width => width === 0) ? [] : columnWidths,
    indent: (format.indent ?? 0) - (document.outdentTables ? margin : 0),
    alignment: format.alignment ?? "left",
    rows,
  };
}

/** Word's own left and right cell padding, for a table whose style gives none. */
const DEFAULT_CELL_MARGIN = 5.4;

interface TableShape {
  readonly rows: number;
  readonly columns: number;
  readonly look: TableLook;
  readonly format: TableFormat;
  readonly style: TableStyle;
}

function spacerCell(columnSpan: number): DocxTableCell {
  return { columnSpan, rowSpan: 1, borders: {}, margins: { top: 0, right: 0, bottom: 0, left: 0 }, verticalAlign: "top", blocks: [] };
}

/** How a region of a table style lays its borders onto one cell. */
type RegionKind = "table" | "row" | "column" | "cell";

/**
 * The table style's conditional formats that cover a cell, weakest first: column bands, row bands,
 * first and last row, first and last column, then the corners. Bands are counted past a first row
 * or column that has its own format.
 */
function conditionalRegions(row: number, column: number, shape: TableShape): { type: string; kind: RegionKind }[] {
  const { look, format } = shape;
  const firstRow = look.firstRow && row === 0;
  const lastRow = look.lastRow && row === shape.rows - 1;
  const firstColumn = look.firstColumn && column === 0;
  const lastColumn = look.lastColumn && column === shape.columns - 1;
  const regions: { type: string; kind: RegionKind }[] = [];
  if (look.bandedColumns && !firstColumn && !lastColumn) {
    const band = Math.floor((column - (look.firstColumn ? 1 : 0)) / Math.max(1, format.columnBandSize ?? 1));
    regions.push({ type: band % 2 === 0 ? "band1Vert" : "band2Vert", kind: "column" });
  }
  if (look.bandedRows && !firstRow && !lastRow) {
    const band = Math.floor((row - (look.firstRow ? 1 : 0)) / Math.max(1, format.rowBandSize ?? 1));
    regions.push({ type: band % 2 === 0 ? "band1Horz" : "band2Horz", kind: "row" });
  }
  if (firstRow) regions.push({ type: "firstRow", kind: "row" });
  if (lastRow) regions.push({ type: "lastRow", kind: "row" });
  if (firstColumn) regions.push({ type: "firstCol", kind: "column" });
  if (lastColumn) regions.push({ type: "lastCol", kind: "column" });
  if (firstRow && firstColumn) regions.push({ type: "nwCell", kind: "cell" });
  if (firstRow && lastColumn) regions.push({ type: "neCell", kind: "cell" });
  if (lastRow && firstColumn) regions.push({ type: "swCell", kind: "cell" });
  if (lastRow && lastColumn) regions.push({ type: "seCell", kind: "cell" });
  return regions;
}

/** Which of a cell's edges lie on the table's outline. */
interface CellEdges {
  readonly top: boolean;
  readonly right: boolean;
  readonly bottom: boolean;
  readonly left: boolean;
}

/**
 * The borders a region gives one cell. A region's outer borders belong to the cells on its
 * outline and its inside borders to the edges between its cells: a row region's left border is
 * the first cell's alone.
 */
function regionBorders(borders: BorderEdges | undefined, kind: RegionKind, outer: CellEdges): BorderEdges {
  if (!borders) return {};
  const acrossRows = kind === "cell" || kind === "row";
  const acrossColumns = kind === "cell" || kind === "column";
  return layered<BorderEdges>({
    top: acrossRows || outer.top ? borders.top : borders.insideH,
    bottom: acrossRows || outer.bottom ? borders.bottom : borders.insideH,
    left: acrossColumns || outer.left ? borders.left : borders.insideV,
    right: acrossColumns || outer.right ? borders.right : borders.insideV,
  });
}

function readCell(cell: GridCell, at: { row: number; rowSpan: number }, shape: TableShape, part: PartContext, depth: number): DocxTableCell {
  const { document } = part;
  const { style, format } = shape;
  const outer: CellEdges = {
    top: at.row === 0,
    bottom: at.row + at.rowSpan >= shape.rows,
    left: cell.column === 0,
    right: cell.column + cell.span >= shape.columns,
  };
  const regions = conditionalRegions(at.row, cell.column, shape)
    .flatMap(({ type, kind }): { region: TableStyleRegion; kind: RegionKind }[] => {
      const region = style.conditional.get(type);
      return region ? [{ region, kind }] : [];
    });
  const direct = readCellFormat(cell.properties, document.theme);
  const cellFormat = layered<CellFormat>(style.cell, ...regions.map(({ region }) => region.cell), direct);
  const borders = layered<BorderEdges>(
    regionBorders(format.borders, "table", outer),
    regionBorders(style.cell.borders, "table", outer),
    ...regions.map(({ region, kind }) => regionBorders(region.cell.borders, kind, outer)),
    regionBorders(direct.borders, "cell", outer),
  );
  const margins = layered<CellMargins>(format.cellMargins, style.cell.margins, ...regions.map(({ region }) => region.cell.margins), direct.margins);
  const shading = cellFormat.shading === "none" ? undefined : cellFormat.shading;

  const context: CellContext = {
    paragraph: layeredParagraph(style.paragraph, ...regions.map(({ region }) => region.paragraph)),
    run: layered(style.run, ...regions.map(({ region }) => region.run)),
    background: shading,
  };
  const blocks = unwrapped(cell.element, "w:p", "w:tbl").flatMap(child => readBlock(child, part, context, depth + 1));
  applyContextualSpacing(blocks, document);
  return {
    columnSpan: cell.span,
    rowSpan: at.rowSpan,
    borders: boxBorders(borders),
    shading,
    margins: {
      top: margins.top ?? 0, right: margins.right ?? DEFAULT_CELL_MARGIN, bottom: margins.bottom ?? 0, left: margins.left ?? DEFAULT_CELL_MARGIN,
    },
    verticalAlign: cellFormat.verticalAlign ?? "top",
    blocks,
  };
}

function gridValue(properties: XmlElement | undefined, name: string, fallback: number): number {
  const value = numeric(attribute(firstChild(properties, name), "w:val")) ?? fallback;
  return Math.max(0, Math.min(MAX_GRID_SPAN, Math.trunc(value)));
}

/** Child elements with one of `names`, looking through content controls and custom XML wrappers. */
function unwrapped(parent: XmlElement, ...names: readonly string[]): XmlElement[] {
  const found: XmlElement[] = [];
  // Collected into one array: spreading a wrapper's children into `push` fails past the number
  // of arguments a call may take.
  const collect = (from: XmlElement): void => {
    for (const child of childElements(from)) {
      if (names.includes(child.name)) found.push(child);
      else if (child.name === "w:sdt") collect(firstChild(child, "w:sdtContent") ?? child);
      else if (child.name === "w:customXml" || child.name === "w:sdtContent") collect(child);
    }
  };
  collect(parent);
  return found;
}
