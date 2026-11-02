// Markdown blocks laid out as WordprocessingML body content, shared by the writer (a whole new
// document) and the editor (paragraphs inserted into an existing one). Everything is expressed
// through the document's styles and numbering rather than direct formatting, so the result looks
// like the rest of the document and a user restyling it in Word restyles the agent's text too.
// When a revision is given, every paragraph, run and table row is marked as a tracked insertion.

import type { MdAlign, MdBlock, MdInline, MdListItem } from "./markdown-parse";
import type { TextStyle } from "./markdown";
import { escapeAttribute, escapeText } from "./ooxml";
import { isoSeconds } from "./ooxml";
import { listIndent, type NumberingAllocator } from "./docx-numbering";
import type { StyleCatalog, StyleRole } from "./docx-styles";

/** The author and time tracked insertions are attributed to, and the source of their ids. */
export interface Revision {
  readonly author: string;
  readonly date: Date;
  /** A revision id unique in the document. */
  nextId(): number;
}

/** What the layout needs from the document it is writing into. */
export interface BodyContext {
  readonly styles: StyleCatalog;
  readonly numbering: NumberingAllocator;
  /** The relationship id of an external hyperlink to `url`, adding one if needed. */
  hyperlink(url: string): string;
  /** The width text can occupy, in twentieths of a point, which tables fill. */
  readonly textWidth: number;
  readonly revision?: Revision;
}

/** The most list nesting Word supports. */
const MAX_LEVEL = 8;

/** Body XML for `blocks`. An empty paragraph separates two tables, which Word would otherwise merge. */
export function renderBlocks(blocks: readonly MdBlock[], context: BodyContext): Rendered {
  return sequence(blocks, context, { quote: false, listLevel: -1 });
}

/** An empty paragraph, as a document must end with one and two tables need one between them. */
export function emptyParagraph(context: BodyContext): string {
  return paragraphXml(context, {}, "");
}

interface Frame {
  readonly quote: boolean;
  /** The list level the block is nested in, or -1 outside lists. */
  readonly listLevel: number;
}

/** Rendered body XML, and whether it starts or ends with a table, which a paragraph must then separate from another. */
export interface Rendered {
  readonly xml: string;
  readonly startsWithTable: boolean;
  readonly endsWithTable: boolean;
}

function flow(xml: string): Rendered {
  return { xml, startsWithTable: false, endsWithTable: false };
}

function renderBlock(block: MdBlock, context: BodyContext, frame: Frame): Rendered {
  switch (block.kind) {
    case "heading":
      return flow(paragraphXml(context, { style: context.styles.id(`heading${block.level}` as StyleRole) }, runsXml(block.inlines, context)));
    case "paragraph":
      return flow(paragraphXml(context, bodyParagraph(context, frame), runsXml(block.inlines, context)));
    case "quote":
      return sequence(block.blocks, context, { ...frame, quote: true });
    case "code":
      return flow(paragraphXml(context, { style: context.styles.id("codeBlock") }, codeRuns(block.text, context)));
    case "rule":
      return flow(paragraphXml(context, { border: true }, ""));
    case "list":
      return flow(listXml(block, context, frame));
    case "table": {
      const xml = tableXml(block, context);
      return { xml, startsWithTable: true, endsWithTable: true };
    }
  }
}

function sequence(blocks: readonly MdBlock[], context: BodyContext, frame: Frame): Rendered {
  let xml = "";
  let startsWithTable = false;
  let endsWithTable = false;
  blocks.forEach((block, index) => {
    const rendered = renderBlock(block, context, frame);
    if (index === 0) startsWithTable = rendered.startsWithTable;
    if (rendered.startsWithTable && endsWithTable) xml += emptyParagraph(context);
    xml += rendered.xml;
    endsWithTable = rendered.endsWithTable;
  });
  return { xml, startsWithTable, endsWithTable };
}

/** A paragraph outside a list marker: a quote line, a list item's continuation, or plain body text. */
function bodyParagraph(context: BodyContext, frame: Frame): ParagraphProperties {
  if (frame.quote) return { style: context.styles.id("quote") };
  if (frame.listLevel >= 0) return { style: context.styles.id("listParagraph"), indent: listIndent(frame.listLevel).left };
  return {};
}

// ---- Lists ----

function listXml(list: Extract<MdBlock, { kind: "list" }>, context: BodyContext, frame: Frame): string {
  const level = Math.min(frame.listLevel + 1, MAX_LEVEL);
  let marker: ParagraphProperties | undefined;
  let taskMarker: ParagraphProperties | undefined;
  let xml = "";
  for (const item of list.items) {
    const properties = item.checked !== undefined
      ? (taskMarker ??= { style: context.styles.id("listParagraph"), numbering: { numId: context.numbering.instance("task", level), level } })
      : (marker ??= listMarker(list, level, context));
    xml += itemXml(item, properties, context, { ...frame, listLevel: level });
  }
  return xml;
}

/**
 * How a list's items are marked: in the document's own List Bullet or List Number style when it
 * has one for the level (restarting a numbered list's count), or else as List Paragraphs numbered
 * by a definition of the writer's own.
 */
function listMarker(list: Extract<MdBlock, { kind: "list" }>, level: number, context: BodyContext): ParagraphProperties {
  const own = context.styles.listStyle(list.ordered, level);
  if (own && !list.ordered) return { style: own.id };
  const restarted = own && context.numbering.restart(own.numId, own.level, list.start);
  if (own && restarted !== undefined) return { style: own.id, numbering: { numId: restarted, level: own.level } };
  return {
    style: context.styles.id("listParagraph"),
    numbering: { numId: context.numbering.instance(list.ordered ? "ordered" : "bullet", level, list.start), level },
  };
}

function itemXml(item: MdListItem, listStyle: ParagraphProperties, context: BodyContext, frame: Frame): string {
  const [first, ...rest] = item.blocks;
  const box = item.checked === undefined ? "" : runXml(`${item.checked ? "☒" : "☐"} `, PLAIN_STYLE, context);
  let xml = "";
  let remaining: readonly MdBlock[] = rest;
  if (first?.kind === "paragraph") {
    xml += paragraphXml(context, listStyle, box + runsXml(first.inlines, context));
  } else {
    // An item that opens with something other than text still needs its marker.
    xml += paragraphXml(context, listStyle, box);
    remaining = item.blocks;
  }
  return xml + sequence(remaining, context, frame).xml;
}

// ---- Tables ----

const TABLE_LOOK = '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>';

function tableXml(table: Extract<MdBlock, { kind: "table" }>, context: BodyContext): string {
  const columns = Math.max(table.header.length, ...table.rows.map(row => row.length), 1);
  const widths = columnWidths(table, columns, context.textWidth);
  const grid = widths.map(width => `<w:gridCol w:w="${width}"/>`).join("");
  const rowXml = (cells: readonly (readonly MdInline[])[], header: boolean): string => {
    const properties = (header ? "<w:cantSplit/><w:tblHeader/>" : "<w:cantSplit/>") + revisionMark(context, "ins");
    const tcs = widths.map((width, index) => {
      const inlines = cells[index] ?? [];
      const align = table.align[index] ?? null;
      return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>` +
        `${paragraphXml(context, { align }, runsXml(header ? bolded(inlines) : inlines, context))}</w:tc>`;
    }).join("");
    return `<w:tr><w:trPr>${properties}</w:trPr>${tcs}</w:tr>`;
  };
  return `<w:tbl><w:tblPr><w:tblStyle w:val="${escapeAttribute(context.styles.id("table"))}"/><w:tblW w:w="5000" w:type="pct"/>${TABLE_LOOK}</w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${rowXml(table.header, true)}${table.rows.map(row => rowXml(row, false)).join("")}</w:tbl>`;
}

/**
 * Column widths that fill the text width, in proportion to each column's longest line of text,
 * with every column given room for a short word and none more than half the table.
 */
function columnWidths(table: Extract<MdBlock, { kind: "table" }>, columns: number, textWidth: number): number[] {
  const weights = Array.from({ length: columns }, (_, index) => {
    const lengths = [table.header, ...table.rows].map(row => inlineText(row[index] ?? []).length);
    return Math.min(Math.max(4, ...lengths), 60);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const widths = weights.map(weight => Math.min(Math.round(textWidth * weight / total), Math.round(textWidth / 2)));
  if (columns === 1) return [textWidth];
  // Whatever capping took away goes to the uncapped columns, so the table still spans the page.
  const shortfall = textWidth - widths.reduce((sum, width) => sum + width, 0);
  const uncapped = widths.map((width, index) => [width, index] as const).filter(([width]) => width < Math.round(textWidth / 2));
  if (uncapped.length > 0) {
    const share = Math.floor(shortfall / uncapped.length);
    for (const [, index] of uncapped) widths[index]! += share;
    widths[uncapped[0]![1]]! += shortfall - share * uncapped.length;
  }
  return widths;
}

/**
 * A header cell's inlines in bold. The table style bolds the header row too, but Word Online and
 * file previews don't always apply table styles.
 */
function bolded(inlines: readonly MdInline[]): MdInline[] {
  return inlines.map(inline => inline.kind === "text" ? { ...inline, style: { ...inline.style, bold: true } }
    : inline.kind === "link" ? { ...inline, children: bolded(inline.children) } : inline);
}

function inlineText(inlines: readonly MdInline[]): string {
  return inlines.map(inline => inline.kind === "text" ? inline.text : inline.kind === "link" ? inlineText(inline.children) : " ").join("");
}

// ---- Paragraphs ----

interface ParagraphProperties {
  readonly style?: string;
  readonly numbering?: { readonly numId: number; readonly level: number };
  /** A horizontal rule: a bottom border on an empty paragraph, as Word's own `---` makes. */
  readonly border?: boolean;
  /** A left indent, in twips, for a list item's later paragraphs. */
  readonly indent?: number;
  readonly align?: MdAlign;
}

/** A paragraph, its properties in schema order: pStyle, numPr, pBdr, ind, jc, then the mark's rPr. */
function paragraphXml(context: BodyContext, properties: ParagraphProperties, runs: string): string {
  let pPr = "";
  if (properties.style) pPr += `<w:pStyle w:val="${escapeAttribute(properties.style)}"/>`;
  if (properties.numbering) pPr += `<w:numPr><w:ilvl w:val="${properties.numbering.level}"/><w:numId w:val="${properties.numbering.numId}"/></w:numPr>`;
  if (properties.border) pPr += '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>';
  if (properties.indent !== undefined) pPr += `<w:ind w:left="${properties.indent}"/>`;
  if (properties.align === "center" || properties.align === "right") pPr += `<w:jc w:val="${properties.align}"/>`;
  const mark = revisionMark(context, "ins");
  if (mark) pPr += `<w:rPr>${mark}</w:rPr>`;
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs}</w:p>`;
}

/** A tracked-change mark (`w:ins` or `w:del`) with a fresh id, or nothing when changes aren't tracked. */
function revisionMark(context: { readonly revision?: Revision }, name: "ins" | "del"): string {
  return context.revision ? `<w:${name} ${revisionAttributes(context.revision)}/>` : "";
}

/** The `w:id`, `w:author` and `w:date` of a tracked change. */
export function revisionAttributes(revision: Revision): string {
  return `w:id="${revision.nextId()}" w:author="${escapeAttribute(revision.author)}" w:date="${isoSeconds(revision.date)}"`;
}

// ---- Runs ----

const PLAIN_STYLE: TextStyle = { bold: false, italic: false, strike: false, code: false };

/** Runs for inline content: text with emphasis, inline code, line breaks and hyperlinks. */
function runsXml(inlines: readonly MdInline[], context: BodyContext): string {
  return inlines.map(inline => {
    switch (inline.kind) {
      case "text":
        return runXml(inline.text, inline.style, context);
      case "break":
        return insertion(context, "<w:r><w:br/></w:r>");
      case "link": {
        const id = context.hyperlink(inline.href);
        const runs = inline.children.map(child => child.kind === "text"
          ? runXml(child.text, child.style, context, true)
          : child.kind === "break" ? insertion(context, "<w:r><w:br/></w:r>") : runsXml([child], context)).join("");
        return `<w:hyperlink r:id="${escapeAttribute(id)}" w:history="1">${runs}</w:hyperlink>`;
      }
    }
  }).join("");
}

/** One run. Inline code takes the HTML Code character style, a link the Hyperlink style (and a monospace font if it is code). */
function runXml(text: string, style: TextStyle, context: BodyContext, inLink = false): string {
  if (text === "") return "";
  let rPr = "";
  if (inLink) rPr += `<w:rStyle w:val="${escapeAttribute(context.styles.id("hyperlink"))}"/>`;
  else if (style.code) rPr += `<w:rStyle w:val="${escapeAttribute(context.styles.id("codeChar"))}"/>`;
  if (inLink && style.code) rPr += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>';
  if (style.bold) rPr += "<w:b/><w:bCs/>";
  if (style.italic) rPr += "<w:i/><w:iCs/>";
  if (style.strike) rPr += "<w:strike/>";
  return insertion(context, `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}${textXml(text)}</w:r>`);
}

/** A code block's lines as one paragraph's runs, joined by line breaks so the block stays one shaded box. */
function codeRuns(code: string, context: BodyContext): string {
  const lines = code.replace(/\n$/, "").split("\n");
  const content = lines.map((line, index) => (index > 0 ? "<w:br/>" : "") + (line ? textXml(line) : "")).join("");
  return content ? insertion(context, `<w:r>${content}</w:r>`) : "";
}

/** Text as `w:t` elements, tabs as `w:tab`, spaces preserved. */
export function textXml(text: string): string {
  return text.split("\t").map(piece => piece ? `<w:t xml:space="preserve">${escapeText(piece)}</w:t>` : "").join("<w:tab/>");
}

/** Wraps run content in a tracked insertion when changes are tracked. */
function insertion(context: BodyContext, runs: string): string {
  return context.revision ? `<w:ins ${revisionAttributes(context.revision)}>${runs}</w:ins>` : runs;
}
