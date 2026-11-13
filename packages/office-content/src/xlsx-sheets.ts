// Excel (.xlsx, .xlsm) worksheets as they look, for drawing a sheet the way Excel shows it: every
// cell's displayed text (its number format applied) and resolved style, with column widths, row
// heights, merged ranges, hidden rows and columns, frozen panes and gridlines. Plain data, with no
// drawing here. A cell's value is what the file stores: a formula's last calculated result, never
// a recalculation. Charts, pictures and the like are only reported as present.

import { findMainPart, readPart, readPartText, readRelationships, streamPart } from "./ooxml";
import { attribute, childElements, firstChild, textContent, type XmlElement } from "./xml";
import { maxDigitWidth, readStyles, type SheetCellStyle, type WorkbookStyles } from "./xlsx-sheet-styles";
import { columnIndex, isTrue, readSharedStrings, stringItemText } from "./xlsx-sheet-strings";
import { openZip, type ZipArchive } from "./zip";

export type {
  SheetBorderEdge, SheetBorders, SheetBorderStyle, SheetCellStyle, SheetFont, SheetHorizontalAlignment, SheetVerticalAlignment,
} from "./xlsx-sheet-styles";

/** How much of each worksheet to read. */
export interface SheetLimits {
  readonly maxRows: number;
  readonly maxColumns: number;
}

/** What a cell holds, which decides how it aligns by default: text left, numbers and dates right, the rest centred. */
export type SheetCellKind = "number" | "text" | "boolean" | "error" | "date";

/** One cell that has a value or a style of its own. */
export interface SheetCell {
  /** Zero-based. */
  readonly column: number;
  /** What the cell shows, with its number format applied; "" for a cell that only has a style. */
  readonly text: string;
  readonly kind: SheetCellKind;
  /** An index into `WorkbookSheets.styles`. */
  readonly style: number;
  /** A text colour the number format asks for (`[Red]`), as `#RRGGBB`, overriding the font's. */
  readonly color?: string;
  /** Where the cell links to, as the file gives it: a URL, or `#Sheet!A1` for a place in the workbook. Never fetched. */
  readonly hyperlink?: string;
}

/** A row the file says something about. Rows it does not mention are empty and of default height. */
export interface SheetRow {
  /** Zero-based. */
  readonly index: number;
  /** In pixels. */
  readonly height: number;
  readonly hidden: boolean;
  /** The style of the row's cells that have none of their own, as an index into `styles`. */
  readonly style?: number;
  /** In column order. */
  readonly cells: readonly SheetCell[];
}

/** A column the file says something about. Columns it does not mention are of default width. */
export interface SheetColumn {
  /** Zero-based. */
  readonly index: number;
  /** In pixels. */
  readonly width: number;
  readonly hidden: boolean;
  /** The style of the column's cells that have none of their own or from their row. */
  readonly style?: number;
}

/** A merged range, zero-based and inclusive. Its top-left cell holds the value. */
export interface SheetMerge {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/** Things a sheet can hold that this model does not carry, so a viewer can say they are missing. */
export type UndrawnFeature =
  | "charts" | "images" | "shapes" | "comments" | "conditionalFormatting" | "dataValidation" | "sparklines" | "pivotTables";

/** One worksheet as it looks. */
export interface SheetModel {
  readonly name: string;
  /** The rows and columns that hold cells or merges: everything outside is blank. */
  readonly rowCount: number;
  readonly columnCount: number;
  /** In pixels. */
  readonly defaultColumnWidth: number;
  readonly defaultRowHeight: number;
  readonly columns: readonly SheetColumn[];
  /** In row order. */
  readonly rows: readonly SheetRow[];
  readonly merges: readonly SheetMerge[];
  /** How many leading rows and columns stay in view while the rest scrolls. */
  readonly frozen: { readonly rows: number; readonly columns: number };
  readonly showGridlines: boolean;
  /** True when the sheet has rows or values past the limits. */
  readonly truncated: boolean;
  /**
   * True when a formula has no stored result, which a file written by a program other than Excel
   * may leave out. Nothing is calculated here, so such a cell is empty.
   */
  readonly uncalculatedFormulas: boolean;
  readonly undrawn: readonly UndrawnFeature[];
}

/** A workbook's visible worksheets and the styles their cells refer to. */
export interface WorkbookSheets {
  /** In tab order. */
  readonly sheets: readonly SheetModel[];
  /** The distinct cell styles; entry 0 is the default, which cells with no style have. */
  readonly styles: readonly SheetCellStyle[];
}

/**
 * Reads the visible worksheets of a workbook as they look. Throws `DocumentConversionError`,
 * `ZipError` or `XmlError` for a file that is not a readable workbook.
 */
export async function readWorkbookSheets(bytes: Uint8Array, limits: SheetLimits): Promise<WorkbookSheets> {
  const zip = openZip(bytes);
  const mainPart = await findMainPart(zip, "xl/workbook.xml");
  const relationships = await readRelationships(zip, mainPart);
  const workbook = await readPart(zip, mainPart);
  const styles = await readStyles(zip, relationships);
  const context: SheetContext = {
    zip,
    strings: await readSharedStrings(zip, relationships),
    styles,
    digitWidth: maxDigitWidth(styles.defaultFont),
    // Workbooks from old Mac versions of Excel count days from 1904 rather than 1900.
    date1904: isTrue(attribute(firstChild(workbook, "s:workbookPr"), "date1904")),
    limits: { maxRows: Math.max(0, Math.floor(limits.maxRows)), maxColumns: Math.max(0, Math.floor(limits.maxColumns)) },
  };

  const sheets: SheetModel[] = [];
  for (const sheet of childElements(firstChild(workbook, "s:sheets"), "s:sheet")) {
    const state = attribute(sheet, "state");
    if (state === "hidden" || state === "veryHidden") continue;
    const part = relationships.get(attribute(sheet, "r:id") ?? "")?.target;
    // A chart sheet or a macro sheet has no cells.
    if (!part || !zip.has(part) || !/worksheets\//i.test(part)) continue;
    sheets.push(await readSheet(attribute(sheet, "name") ?? "", part, context));
  }
  return { sheets, styles: styles.styles };
}

interface SheetContext {
  readonly zip: ZipArchive;
  readonly strings: readonly string[];
  readonly styles: WorkbookStyles;
  readonly digitWidth: number;
  readonly date1904: boolean;
  readonly limits: SheetLimits;
}

const PIXELS_PER_POINT = 96 / 72;
/** Excel's row height when the sheet names none: 15 points, which fits Calibri 11. */
const DEFAULT_ROW_POINTS = 15;

/**
 * A column width in pixels. The file stores widths as a count of the default font's widest digit
 * (`digitWidth` pixels: 7 for Calibri 11), padding included, in 1/256ths. ECMA-376 Part 1,
 * 18.3.1.13 gives the conversion: `trunc((256 * width + trunc(128 / digitWidth)) / 256 * digitWidth)`.
 */
export function columnWidthPixels(width: number, digitWidth: number): number {
  return Math.trunc((256 * width + Math.trunc(128 / digitWidth)) / 256 * digitWidth);
}

/**
 * The width of a column the sheet gives no width: `baseColWidth` digits (8 unless said) plus 5
 * pixels of padding, rounded up to a multiple of 8 pixels. That is 64 pixels for Calibri 11, which
 * Excel calls 8.43 characters.
 */
export function defaultColumnWidthPixels(baseColumnWidth: number, digitWidth: number): number {
  return Math.ceil((baseColumnWidth * digitWidth + 5) / 8) * 8;
}

/**
 * The height Excel gives a row with no stored height, for its tallest font: 20 pixels for 11
 * point, 25 for 14, 28 for 16, 35 for 20.
 */
function lineHeightPixels(fontPoints: number): number {
  return Math.round(fontPoints * PIXELS_PER_POINT * 1.22) + 2;
}

/** The widest and tallest a column or row can be in Excel, so a hostile size cannot make a huge layout. */
const MAX_COLUMN_PIXELS = 1800;
const MAX_ROW_PIXELS = 546;

function clampSize(pixels: number, max: number): number {
  return Number.isFinite(pixels) ? Math.max(0, Math.min(max, Math.round(pixels))) : 0;
}

/** A zero-based cell position from a reference such as `B7`, or undefined if it is not one. */
function parseReference(reference: string): { row: number; column: number } | undefined {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(reference.trim());
  if (!match) return undefined;
  return { row: Number(match[2]) - 1, column: columnIndex(match[1]!) };
}

function parseRange(reference: string): SheetMerge | undefined {
  const [first, last = first] = reference.split(":");
  const start = parseReference(first ?? "");
  const end = parseReference(last ?? "");
  if (!start || !end || start.row < 0 || end.row < 0) return undefined;
  return {
    top: Math.min(start.row, end.row), left: Math.min(start.column, end.column),
    bottom: Math.max(start.row, end.row), right: Math.max(start.column, end.column),
  };
}

/**
 * The sheet's XML without its rows. Everything else about a sheet (views, columns, merges, links)
 * is small and sits beside `sheetData`, which can be too large to hold as a tree, so the two are
 * read apart: this in one piece, the rows streamed.
 */
function withoutSheetData(sheetXml: string): string {
  const open = /<(?:[\w.-]+:)?sheetData[\s>]/.exec(sheetXml);
  if (!open) return sheetXml;
  const close = /<\/(?:[\w.-]+:)?sheetData\s*>/g;
  let end = -1;
  for (let match = close.exec(sheetXml); match; match = close.exec(sheetXml)) end = match.index + match[0].length;
  return end < open.index ? sheetXml : sheetXml.slice(0, open.index) + sheetXml.slice(end);
}

interface SheetSettings {
  showGridlines: boolean;
  frozen: { rows: number; columns: number };
  defaultRowHeight: number;
  defaultColumnWidth: number;
  /** By column index, so a file that describes a column twice cannot grow the list. */
  columns: Map<number, SheetColumn>;
  merges: SheetMerge[];
  /** Hyperlink targets by range. */
  links: { range: SheetMerge; target: string }[];
  undrawn: Set<UndrawnFeature>;
}

/** More links than a sheet within the limits can show are not worth searching through. */
const MAX_LINKS = 20_000;

async function readSettings(sheetXml: string, part: string, context: SheetContext): Promise<SheetSettings> {
  const { maxRows, maxColumns } = context.limits;
  const relationships = await readRelationships(context.zip, part);
  const settings: SheetSettings = {
    showGridlines: true,
    frozen: { rows: 0, columns: 0 },
    defaultRowHeight: clampSize(DEFAULT_ROW_POINTS * PIXELS_PER_POINT, MAX_ROW_PIXELS),
    defaultColumnWidth: defaultColumnWidthPixels(8, context.digitWidth),
    columns: new Map(),
    merges: [],
    links: [],
    undrawn: new Set(),
  };
  // Merges may not overlap. A file that says otherwise would tear the table, so each is checked
  // against the cells already taken, on a budget a hostile list of huge ranges cannot outspend.
  const taken = new Set<number>();
  let budget = 2 * maxRows * maxColumns;

  for (const element of streamPart(withoutSheetData(sheetXml), 1)) {
    switch (element.name) {
      case "s:sheetViews": {
        const view = firstChild(element, "s:sheetView");
        const gridlines = attribute(view, "showGridLines");
        settings.showGridlines = gridlines === undefined || isTrue(gridlines);
        const pane = firstChild(view, "s:pane");
        const state = attribute(pane, "state");
        if (state === "frozen" || state === "frozenSplit") {
          settings.frozen = {
            rows: Math.min(maxRows, Math.max(0, Math.floor(Number(attribute(pane, "ySplit") ?? 0)) || 0)),
            columns: Math.min(maxColumns, Math.max(0, Math.floor(Number(attribute(pane, "xSplit") ?? 0)) || 0)),
          };
        }
        break;
      }
      case "s:sheetFormatPr": {
        const height = Number(attribute(element, "defaultRowHeight"));
        if (height > 0) settings.defaultRowHeight = clampSize(height * PIXELS_PER_POINT, MAX_ROW_PIXELS);
        const width = Number(attribute(element, "defaultColWidth"));
        const base = Number(attribute(element, "baseColWidth") ?? 8);
        settings.defaultColumnWidth = width > 0
          ? clampSize(columnWidthPixels(width, context.digitWidth), MAX_COLUMN_PIXELS)
          : clampSize(defaultColumnWidthPixels(base > 0 ? base : 8, context.digitWidth), MAX_COLUMN_PIXELS);
        break;
      }
      case "s:cols":
        for (const column of childElements(element, "s:col")) {
          const first = Math.max(1, Number(attribute(column, "min")) || 1);
          const last = Math.min(maxColumns, Number(attribute(column, "max")) || first);
          const width = Number(attribute(column, "width"));
          const style = context.styles.formats[Number(attribute(column, "style") ?? 0)]?.style;
          for (let index = first - 1; index < last; index++) {
            settings.columns.set(index, {
              index,
              width: width >= 0 && attribute(column, "width") !== undefined
                ? clampSize(columnWidthPixels(width, context.digitWidth), MAX_COLUMN_PIXELS)
                : settings.defaultColumnWidth,
              hidden: isTrue(attribute(column, "hidden")),
              ...(style ? { style } : {}),
            });
          }
        }
        break;
      case "s:mergeCells":
        for (const merge of childElements(element, "s:mergeCell")) {
          const range = parseRange(attribute(merge, "ref") ?? "");
          if (!range || range.top >= maxRows || range.left >= maxColumns) continue;
          const clipped = { ...range, bottom: Math.min(range.bottom, maxRows - 1), right: Math.min(range.right, maxColumns - 1) };
          const area = (clipped.bottom - clipped.top + 1) * (clipped.right - clipped.left + 1);
          if (area < 2 || area > budget) continue;
          budget -= area;
          const keys: number[] = [];
          for (let row = clipped.top; row <= clipped.bottom; row++) {
            for (let column = clipped.left; column <= clipped.right; column++) keys.push(row * maxColumns + column);
          }
          if (keys.some(key => taken.has(key))) continue;
          for (const key of keys) taken.add(key);
          settings.merges.push(clipped);
        }
        break;
      case "s:hyperlinks":
        for (const link of childElements(element, "s:hyperlink")) {
          if (settings.links.length >= MAX_LINKS) break;
          const range = parseRange(attribute(link, "ref") ?? "");
          const relationship = relationships.get(attribute(link, "r:id") ?? "");
          const location = attribute(link, "location");
          // An external target is kept as the address it is, to offer as a link; nothing reads it.
          const target = relationship?.external ? relationship.target + (location ? `#${location}` : "") : location ? `#${location}` : undefined;
          if (range && target) settings.links.push({ range, target });
        }
        break;
      case "s:conditionalFormatting":
        settings.undrawn.add("conditionalFormatting");
        break;
      case "s:dataValidations":
        settings.undrawn.add("dataValidation");
        break;
      case "s:drawing": {
        const drawing = relationships.get(attribute(element, "r:id") ?? "");
        if (drawing && !drawing.external) await readDrawingFeatures(drawing.target, context.zip, settings.undrawn);
        break;
      }
      case "s:picture":
        settings.undrawn.add("images");
        break;
      case "s:extLst":
        // Newer features live in extensions, under namespaces of their own.
        for (const extension of childElements(element)) {
          for (const child of childElements(extension)) {
            if (child.name.endsWith("}sparklineGroups")) settings.undrawn.add("sparklines");
            else if (child.name.endsWith("}conditionalFormattings")) settings.undrawn.add("conditionalFormatting");
            else if (child.name.endsWith("}dataValidations")) settings.undrawn.add("dataValidation");
          }
        }
        break;
    }
  }
  for (const relationship of relationships.values()) {
    if (relationship.type === "comments" || relationship.type === "threadedComment") settings.undrawn.add("comments");
    else if (relationship.type === "pivotTable") settings.undrawn.add("pivotTables");
  }
  return settings;
}

/** Notes what a drawing part holds: a chart by its relationship, pictures and shapes by their anchors. */
async function readDrawingFeatures(part: string, zip: ZipArchive, undrawn: Set<UndrawnFeature>): Promise<void> {
  if (!zip.has(part)) return;
  for (const relationship of (await readRelationships(zip, part)).values()) {
    if (/^chart/i.test(relationship.type)) undrawn.add("charts");
    else if (relationship.type === "image") undrawn.add("images");
  }
  for (const anchor of streamPart(await readPartText(zip, part), 1)) {
    for (const child of childElements(anchor)) {
      if (child.name.endsWith("}pic")) undrawn.add("images");
      else if (child.name.endsWith("}sp") || child.name.endsWith("}cxnSp") || child.name.endsWith("}grpSp")) undrawn.add("shapes");
    }
  }
}

interface CellContent {
  readonly text: string;
  readonly kind: SheetCellKind;
  readonly color?: string;
}

function cellContent(cell: XmlElement, format: WorkbookStyles["formats"][number], context: SheetContext): CellContent {
  const type = attribute(cell, "t");
  const asText = (text: string): CellContent => ({ kind: "text", ...format.numberFormat.formatText(text) });
  if (type === "inlineStr") {
    const inline = firstChild(cell, "s:is");
    return asText(inline ? stringItemText(inline) : "");
  }
  const value = firstChild(cell, "s:v");
  if (!value) return { text: "", kind: "text" };
  const raw = textContent(value);
  switch (type) {
    case "s":
      return asText(context.strings[Number(raw)] ?? "");
    case "str":
      return asText(raw);
    case "b":
      return { text: raw === "1" ? "TRUE" : "FALSE", kind: "boolean" };
    case "e":
      return { text: raw, kind: "error" };
    case "d":
      return { text: raw, kind: "date" };
  }
  const number = Number(raw);
  if (raw === "" || Number.isNaN(number)) return { text: raw, kind: "text" };
  return { kind: format.numberFormat.isDate ? "date" : "number", ...format.numberFormat.format(number, context.date1904) };
}

type SheetLink = SheetSettings["links"][number];

/**
 * Entries the per-row link index may hold in all. A link over many rows is entered once per row,
 * so without a budget a crafted sheet of tall link ranges would cost rows times links to index.
 */
const MAX_LINK_INDEX = 200_000;

/** Each row's links, in file order, so a cell is checked only against the links of its own row. */
function indexLinks(links: readonly SheetLink[], maxRows: number): Map<number, SheetLink[]> {
  const byRow = new Map<number, SheetLink[]>();
  let budget = MAX_LINK_INDEX;
  for (const link of links) {
    for (let row = link.range.top; row <= Math.min(link.range.bottom, maxRows - 1); row++) {
      if (budget-- <= 0) return byRow;
      const rowLinks = byRow.get(row);
      if (rowLinks) rowLinks.push(link);
      else byRow.set(row, [link]);
    }
  }
  return byRow;
}

function linkAt(links: readonly SheetLink[] | undefined, column: number): string | undefined {
  return links?.find(({ range }) => column >= range.left && column <= range.right)?.target;
}

async function readSheet(name: string, part: string, context: SheetContext): Promise<SheetModel> {
  const { maxRows, maxColumns } = context.limits;
  const { formats, styles } = context.styles;
  const sheetXml = await readPartText(context.zip, part);
  const settings = await readSettings(sheetXml, part, context);
  const linksByRow = indexLinks(settings.links, maxRows);

  const rows = new Map<number, SheetRow>();
  let truncated = false;
  let uncalculated = false;
  let nextRow = 0;
  let columnCount = 0;
  // Rows sit two levels down (worksheet > sheetData > row), among other parts' children.
  for (const row of streamPart(sheetXml, 2)) {
    if (row.name !== "s:row") continue;
    // `r` is optional; a row without it follows the one before.
    const rowIndex = Number(attribute(row, "r") ?? nextRow + 1) - 1;
    if (!(rowIndex >= 0)) continue;
    nextRow = rowIndex + 1;
    if (rowIndex >= maxRows) {
      truncated = true;
      break;
    }
    const rowStyle = isTrue(attribute(row, "customFormat")) ? formats[Number(attribute(row, "s") ?? 0)]?.style : undefined;
    const cells: SheetCell[] = [];
    const rowLinks = linksByRow.get(rowIndex);
    let nextColumn = 0;
    let tallest = 0;
    for (const cell of childElements(row, "s:c")) {
      const reference = attribute(cell, "r");
      const column = reference ? columnIndex(reference) : nextColumn;
      if (column < 0) continue;
      nextColumn = column + 1;
      const styleId = attribute(cell, "s");
      const format = formats[Number(styleId ?? 0)] ?? formats[0]!;
      const content = cellContent(cell, format, context);
      // A formula's text result may truly be empty; any other formula with nothing stored was never calculated.
      if (content.text === "" && attribute(cell, "t") !== "str" && firstChild(cell, "s:f")) uncalculated = true;
      if (content.text === "" && styleId === undefined) continue;
      if (column >= maxColumns) {
        if (content.text !== "") truncated = true;
        continue;
      }
      // A cell that names no style takes its row's, then its column's.
      const style = styleId !== undefined ? format.style : rowStyle ?? settings.columns.get(column)?.style ?? format.style;
      const hyperlink = linkAt(rowLinks, column);
      cells.push({ column, ...content, style, ...(hyperlink ? { hyperlink } : {}) });
      columnCount = Math.max(columnCount, column + 1);
      if (content.text !== "") {
        const cellStyle = styles[style]!;
        const lines = cellStyle.wrap ? Math.min(content.text.split("\n").length, 20) : 1;
        tallest = Math.max(tallest, lineHeightPixels(cellStyle.font.size) * lines - 2 * (lines - 1));
      }
    }
    const height = Number(attribute(row, "ht"));
    rows.set(rowIndex, {
      index: rowIndex,
      // A row with no stored height is as tall as its content needs, as Excel makes it on opening.
      height: height > 0 ? clampSize(height * PIXELS_PER_POINT, MAX_ROW_PIXELS) : clampSize(Math.max(settings.defaultRowHeight, tallest), MAX_ROW_PIXELS),
      hidden: isTrue(attribute(row, "hidden")),
      ...(rowStyle ? { style: rowStyle } : {}),
      cells: cells.toSorted((a, b) => a.column - b.column),
    });
  }

  const ordered = [...rows.values()].toSorted((a, b) => a.index - b.index);
  const lastRow = ordered.reduce((last, row) => row.cells.length > 0 ? row.index : last, -1);
  return {
    name,
    rowCount: settings.merges.reduce((count, merge) => Math.max(count, merge.bottom + 1), lastRow + 1),
    columnCount: settings.merges.reduce((count, merge) => Math.max(count, merge.right + 1), columnCount),
    defaultColumnWidth: settings.defaultColumnWidth,
    defaultRowHeight: settings.defaultRowHeight,
    columns: [...settings.columns.values()].toSorted((a, b) => a.index - b.index),
    rows: ordered,
    merges: settings.merges,
    frozen: settings.frozen,
    showGridlines: settings.showGridlines,
    truncated,
    uncalculatedFormulas: uncalculated,
    undrawn: [...settings.undrawn].toSorted(),
  };
}
