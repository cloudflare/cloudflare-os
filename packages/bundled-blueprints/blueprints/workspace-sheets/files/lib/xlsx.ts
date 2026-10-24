import { type ZipEntry, createZip } from "@gadgets/bundled-blueprints/libraries/zip/server";
import { DEFAULT_COLS, DEFAULT_ROWS, EXPORT_UNKNOWN, ExportCells, type ExportEvaluator, type ExportValue, type ExportWorkbook, computedFilterToken, textStream } from "./export-data.ts";
import { FUNCTIONS, HyperlinkValue, type Scalar, displayValue, isErr, isMatrix, parseFormula, readableInk, unwrapParens } from "./formula.ts";
import type { CellFmt, ChartType, SheetMeta } from "./protocol.ts";

// ===========================================================================
// XLSX writer: values, formulas (rewritten for Excel), formatting, column widths, row heights,
// frozen panes, filters (with hidden rows and sort), hyperlinks and native charts.
// ===========================================================================
const XL_MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const XL_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XL_PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const XL_DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const XL_SPREADSHEET_DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const XL_CHART_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const XL_MAX_ROWS = 1048576;
const XL_MAX_COLUMNS = 16384;
const XL_DEFAULT_ROW_PIXELS = 24;
const XL_DEFAULT_COLUMN_PIXELS = 92;
// Excel's limits on distinct fonts, fills and cell formats in a workbook. Formats past them (a
// heatmap of hundreds of shades) export without that font, fill or format rather than failing.
const XL_MAX_FONTS = 512;
const XL_MAX_FILLS = 256;
const XL_MAX_CELL_FORMATS = 65490;
const XL_MAX_FORMULA_CHARACTERS = 8192;
const XL_MAX_SERIES = 255;
const XL_MAX_HYPERLINKS = 65530;
const XL_MAX_HYPERLINK_CHARACTERS = 2079;
const EMU_PER_PIXEL = 9525;
// The grid positions charts over its scroll area, so stored coordinates include the row-header
// column and the column-header row.
const ROW_HEADER_PIXELS = 44;
const COLUMN_HEADER_PIXELS = 22;
const XL_CHART_TYPES = new Set<unknown>(["line", "area", "pie", "stackedBar"]);
const XL_CHART_COLORS = ["E1632E", "3478C7", "1F9D77", "8B5FBF", "C49324", "C4566A"];
const HYPERLINK_FMT: CellFmt = { c: "#2f6fd1", u: true }; // the grid's link ink (--link)
const ERROR_INK = "#d0473f"; // the grid's error ink (--bad)
/** How the grid shows a cell beyond its format: as a link, an error (red, centred), a boolean (centred) or right-to-left text (still left-aligned). */
type CellLook = "plain" | "link" | "error" | "boolean" | "rtl";
// Text whose first strong character is Hebrew or Arabic, which Excel would align right by itself.
const RTL_TEXT = /^[^A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]*[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
// The format a cell is written with: its own, plus what the grid adds for its look. Excel centres
// booleans and errors by itself, but other viewers don't, so that is written out too.
function lookFmt(fmt: CellFmt | null, look: CellLook): CellFmt | null {
  if (look === "link") return { ...fmt, ...HYPERLINK_FMT };
  if (look === "error") return { ...fmt, c: fmt?.c ?? ERROR_INK, a: fmt?.a ?? "c" };
  if (look === "boolean") return { ...fmt, a: fmt?.a ?? "c" };
  if (look === "rtl") return { ...fmt, a: fmt?.a ?? "l" };
  return fmt;
}
const FUTURE_FUNCTIONS = new Set<string>(["CONCAT", "DAYS", "IFNA", "IFS", "SWITCH", "TEXTJOIN", "UNICHAR", "UNICODE", "XOR"]);
// The grid's functions that Excel lets you call with no arguments. The grid answers `SUM()` too,
// but Excel calls a file holding one damaged.
const NO_ARGUMENT_FUNCTIONS = new Set<string>(["COLUMN", "FALSE", "NA", "NOW", "PI", "RAND", "ROW", "TODAY", "TRUE"]);

/** A column width or row height as written: its zero-based index and the converted value. */
interface Dimension { index: number; value: string }
/** A cell's external link: where it is and its relationship. */
interface Hyperlink { reference: string; row: number; column: number; target: string; relationshipId: string }
/** The written cells' extent, 1-based. */
interface Bounds { minRow: number; maxRow: number; minColumn: number; maxColumn: number }
/** A rectangle of cells, 1-based. */
interface CellRange { firstRow: number; lastRow: number; firstColumn: number; lastColumn: number }
/** One criteria column of a filter: the chosen tokens, the values they show as, and whether blanks (or nothing at all) are chosen. */
interface FilterCriterion { tokens: Set<unknown>; values: string[]; blank: boolean; selectsNothing: boolean; hiddenButton?: undefined }
/** A column of the autoFilter: outside the filter's columns (button hidden), or one with criteria. */
type FilterColumn = { offset: number; hiddenButton: true } | ({ offset: number } & FilterCriterion);
/** A sheet's filter as written: its range, its hidden name, its columns, the rows it hides and its sort. */
interface PreparedFilter {
  ref: string;
  definedName: string;
  columns: FilterColumn[];
  hiddenRows: number[];
  sort: { ref: string; column: string; descending: boolean } | null;
}
/** A chart anchor's cell index and offset in it (EMU). */
interface Anchor { index: number; offset: number }
/** A chart's series layout and placement, as worked out from its settings and data (1-based rows and columns). */
interface ChartLayout {
  type: ChartType;
  title: string;
  xAxisTitle: string;
  yAxisTitle: string;
  legend: boolean;
  headerRow: number | null;
  categoryColumn: number | null;
  firstRow: number;
  lastRow: number;
  columns: number[];
  column: Anchor;
  row: Anchor;
  extent: { cx: number; cy: number };
}
/** What a chart shows, for its cached values. */
interface ChartCache { categories: string[] | null; names: string[]; named: boolean[]; values: (number | null)[][] }
type PreparedChart = ChartLayout & { cache: ChartCache };
/** A sheet's drawing part and the charts on it, numbered across the workbook. */
interface Drawing { index: number; relationshipId: string; charts: (PreparedChart & { index: number })[] }
/** A sheet as the writer works on it: its source, then everything prepareWorkbook works out for it. */
interface PreparedSheet {
  id: string;
  sourceName: string;
  metadata: Partial<SheetMeta>;
  data: ExportCells;
  name: string;
  rows: number;
  columns: number;
  frozenRows: number;
  frozenColumns: number;
  columnWidths: Dimension[];
  rowHeights: Dimension[];
  styleOf: Int32Array;
  hyperlinks: Hyperlink[];
  bounds: Bounds | null;
  filter: PreparedFilter | null;
  hiddenRows: number[];
  drawing?: Drawing;
}
/** A written font (index 0 is the default, Calibri 11). */
interface XlFont { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; color?: string | null; size?: number | null }
/** A cell format: indices into the fonts, fills, number formats and alignments. */
interface XlCellFormat { fontId: number; fillId: number; numberFormatId: number; alignmentId: number }
/** What parsedCellValue makes of a stored value. */
type ParsedCell =
  | { type: "text" | "formula" | "blank"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "number"; value: number };
/** A rewritten piece of a formula: where it ends and its Excel text. */
interface FormulaPiece { end: number; text: string }

function spreadsheetXml(value: unknown, attribute = false): string {
  const input = String(value).replace(/_x[0-9a-f]{4}_/gi, (match) => "_x005F_" + match.slice(1));
  let clean = "";
  for (let i = 0; i < input.length; ++i) {
    const code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = input.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) clean += input[i] + input[++i];
      else clean += "_xFFFD_";
    } else if (code >= 0xdc00 && code <= 0xdfff) clean += "_xFFFD_";
    else if (code === 13) clean += "_x000D_";
    else if (code === 9 || code === 10 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd)) clean += input[i];
    else clean += `_x${code.toString(16).toUpperCase().padStart(4, "0")}_`;
  }
  clean = clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (attribute) clean = clean.replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  return clean;
}
function formulaXml(value: unknown): string {
  const input = String(value);
  let clean = "";
  for (let i = 0; i < input.length; ++i) {
    const code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = input.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) clean += input[i] + input[++i];
      else clean += "\ufffd";
    } else if (code >= 0xdc00 && code <= 0xdfff) clean += "\ufffd";
    else if (code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd)) clean += input[i];
    else clean += "\ufffd";
  }
  return clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#13;");
}
function xmlAttribute(value: unknown): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
// DrawingML text has no `_xHHHH_` escapes: characters XML 1.0 forbids are dropped instead.
function plainXml(value: unknown): string {
  return String(value).replace(/[\0-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function xlCount(value: unknown, fallback: number, maximum: number): number {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(maximum, number));
}
function frozenCount(value: unknown, maximum: number): number {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(50, maximum, number));
}
function truncateSheetName(value: string, length: number): string {
  const input = value.slice(0, length);
  let result = "";
  for (let i = 0; i < input.length; ++i) {
    const code = input.charCodeAt(i);
    if (code < 32 || (code >= 127 && code <= 159)) result += "_";
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = input.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) result += input[i] + input[++i];
      else result += "_";
    } else if (code >= 0xdc00 && code <= 0xdfff) result += "_";
    else result += input[i];
  }
  return result;
}
function safeSheetName(value: unknown): string {
  let name = String(value ?? "").replace(/[:\\/?*\[\]]/g, "_").trim();
  name = truncateSheetName(name, 31);
  if (name.startsWith("'")) name = "_" + name.slice(1);
  if (name.endsWith("'")) name = name.slice(0, -1) + "_";
  if (name.toLowerCase() === "history") name += "_";
  return name || "Sheet";
}
// Excel names are unique (case-insensitively) and at most 31 characters; clashes get " (2)" etc.
function assignSheetNames(sheets: { sourceName: string; name: string }[]) {
  const used = new Set<string>();
  const nextSuffixes = new Map<string, number>();
  for (const sheet of sheets) {
    const base = safeSheetName(sheet.sourceName);
    let name = base, suffix = 2;
    while (used.has(name.toLowerCase())) {
      const digits = String(suffix).length;
      const stem = truncateSheetName(base, 28 - digits);
      const key = `${stem.toLowerCase()}|${digits}`;
      const next = nextSuffixes.get(key) ?? suffix;
      if (next > suffix) { suffix = next; continue; }
      name = `${stem} (${suffix})`;
      nextSuffixes.set(key, ++suffix);
    }
    used.add(name.toLowerCase());
    sheet.name = name;
  }
}
// 1-based row and column.
function parseCellReference(reference: string): { row: number; column: number } | null {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(reference);
  if (!match) return null;
  let column = 0;
  for (const character of match[1]) {
    column = column * 26 + character.charCodeAt(0) - 64;
    if (column > XL_MAX_COLUMNS) return null;
  }
  const row = Number(match[2]);
  if (!Number.isSafeInteger(row) || row > XL_MAX_ROWS) return null;
  return { row, column };
}
function columnName(column: number): string {
  let name = "";
  for (let value = column; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
  return name;
}
function pixelDimension(value: unknown): number | null {
  const pixels = Math.round(Number(value));
  return Number.isFinite(pixels) && pixels >= 8 && pixels <= 2000 ? pixels : null;
}
function rowPoints(pixels: number): string { return String(Math.min(409, Math.round(pixels * 75) / 100)); }
function columnWidth(pixels: number): string { return String(Math.min(255, Math.round(Math.max(0, (pixels - 5) / 7) * 256) / 256)); }
function xlDimensions(source: unknown, maximum: number, convert: (pixels: number) => string): Dimension[] {
  const result: Dimension[] = [];
  if (!source || typeof source !== "object") return result;
  for (const [key, value] of Object.entries(source)) {
    if (!/^(0|[1-9]\d*)$/.test(key)) continue;
    const index = Number(key);
    const pixels = pixelDimension(value);
    if (!Number.isSafeInteger(index) || index < 0 || index >= maximum || pixels == null) continue;
    result.push({ index, value: convert(pixels) });
  }
  result.sort((a, b) => a.index - b.index);
  return result;
}
function xlsxColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.slice(1);
  if (!value.startsWith("#") || ![3, 4, 6, 8].includes(hex.length) || !/^[0-9a-f]+$/i.test(hex)) return null;
  if (hex.length === 3) return "FF" + Array.from(hex, (ch) => ch + ch).join("").toUpperCase();
  if (hex.length === 4) { const [r, g, b, a] = Array.from(hex, (ch) => ch + ch); return (a + r + g + b).toUpperCase(); }
  if (hex.length === 6) return "FF" + hex.toUpperCase();
  return (hex.slice(6) + hex.slice(0, 6)).toUpperCase();
}
function xlDecimals(fmt: CellFmt | null | undefined): number | null {
  if (fmt?.d == null) return null;
  const value = Math.round(Number(fmt.d));
  return Number.isFinite(value) && value >= 0 && value <= 10 ? value : null;
}
function decimalPattern(value: number | null): string { return value ? "." + "0".repeat(value) : ""; }

class XlsxStyles {
  declare fonts: XlFont[];
  declare fontIds: Map<string, number>;
  declare fills: ({ color?: string; gray125?: true } | null)[];
  declare fillIds: Map<string, number>;
  declare numberFormats: { id: number; code: string }[];
  declare numberFormatIds: Map<string, number>;
  declare alignments: ({ horizontal: string | null; wrap: boolean } | null)[];
  declare alignmentIds: Map<string, number>;
  declare cellFormats: XlCellFormat[];
  declare cellFormatIds: Map<string, number>;
  constructor() {
    this.fonts = [{ size: 11 }]; this.fontIds = new Map();
    this.fills = [null, { gray125: true }]; this.fillIds = new Map();
    this.numberFormats = []; this.numberFormatIds = new Map();
    this.alignments = [null]; this.alignmentIds = new Map();
    this.cellFormats = [{ fontId: 0, fillId: 0, numberFormatId: 0, alignmentId: 0 }]; this.cellFormatIds = new Map();
  }
  font(fmt: CellFmt | null): number {
    // A fill without a text colour gets the grid's legible ink (dark on light fills, light on dark).
    const ink = !fmt?.c && fmt?.bg ? readableInk(fmt.bg) : "";
    const color = xlsxColor(fmt?.c) ?? (ink && ink !== "#1b1b1f" ? xlsxColor(ink) : null);
    const pixels = Math.round(Number(fmt?.fs));
    // The grid's text is 13px and `fs` is in pixels; the workbook's is Calibri 11, so sizes keep
    // their proportion to it (16px, 1.23x the grid's text, becomes 13.5pt), to the half point.
    const size = Number.isFinite(pixels) && pixels >= 6 && pixels <= 96 && pixels !== 13 ? Math.round(pixels * 11 / 13 * 2) / 2 : null;
    const font = { bold: Boolean(fmt?.b), italic: Boolean(fmt?.i), underline: Boolean(fmt?.u), strike: Boolean(fmt?.s), color, size };
    if (!font.bold && !font.italic && !font.underline && !font.strike && !font.color && !font.size) return 0;
    const key = JSON.stringify(font);
    let id = this.fontIds.get(key);
    if (id == null) {
      if (this.fonts.length >= XL_MAX_FONTS) return 0;
      id = this.fonts.length; this.fontIds.set(key, id); this.fonts.push(font);
    }
    return id;
  }
  fill(fmt: CellFmt | null): number {
    const color = xlsxColor(fmt?.bg);
    if (!color) return 0;
    let id = this.fillIds.get(color);
    if (id == null) {
      if (this.fills.length >= XL_MAX_FILLS) return 0;
      id = this.fills.length; this.fillIds.set(color, id); this.fills.push({ color });
    }
    return id;
  }
  customNumberFormat(code: string): number {
    let id = this.numberFormatIds.get(code);
    if (id == null) {
      if (164 + this.numberFormats.length > 0xffff) throw new Error("XLSX number format count exceeds the format ID limit of 65,535.");
      id = 164 + this.numberFormats.length; this.numberFormatIds.set(code, id); this.numberFormats.push({ id, code });
    }
    return id;
  }
  numberFormat(fmt: CellFmt | null): number {
    const places = xlDecimals(fmt);
    const name = fmt?.nf;
    if (name === "text") return 49;
    if (name === "integer") return this.customNumberFormat("#,##0");
    if (name === "number") return this.customNumberFormat("#,##0" + decimalPattern(places ?? 2));
    if (name === "currency") { const pattern = '"$"#,##0' + decimalPattern(places ?? 2); return this.customNumberFormat(pattern + ";-" + pattern); }
    if (name === "percent") return this.customNumberFormat("#,##0" + decimalPattern(places ?? 2) + "%");
    if (name === "scientific") return this.customNumberFormat("0" + decimalPattern(places ?? 2) + "E+00");
    if (name === "date") return this.customNumberFormat("mm/dd/yyyy");
    if (name === "time") return this.customNumberFormat("h:mm:ss AM/PM");
    if (name === "datetime") return this.customNumberFormat("mm/dd/yyyy h:mm:ss AM/PM");
    // "auto" (or any other name) shows as the grid's default: General, or fixed decimals without grouping.
    return places == null ? 0 : this.customNumberFormat("0" + decimalPattern(places));
  }
  alignment(fmt: CellFmt | null): number {
    const horizontal = fmt?.a === "l" ? "left" : fmt?.a === "c" ? "center" : fmt?.a === "r" ? "right" : null;
    const wrap = Boolean(fmt?.wrap);
    if (!horizontal && !wrap) return 0;
    const key = `${horizontal || ""}|${wrap}`;
    let id = this.alignmentIds.get(key);
    if (id == null) { id = this.alignments.length; this.alignmentIds.set(key, id); this.alignments.push({ horizontal, wrap }); }
    return id;
  }
  style(fmt: CellFmt | null): number {
    if (!fmt || typeof fmt !== "object") return 0;
    const cf = { fontId: this.font(fmt), fillId: this.fill(fmt), numberFormatId: this.numberFormat(fmt), alignmentId: this.alignment(fmt) };
    if (!cf.fontId && !cf.fillId && !cf.numberFormatId && !cf.alignmentId) return 0;
    const key = `${cf.fontId}|${cf.fillId}|${cf.numberFormatId}|${cf.alignmentId}`;
    let id = this.cellFormatIds.get(key);
    if (id == null) {
      if (this.cellFormats.length >= XL_MAX_CELL_FORMATS) return 0;
      id = this.cellFormats.length; this.cellFormatIds.set(key, id); this.cellFormats.push(cf);
    }
    return id;
  }
}

// `workbook` comes from loadExportWorkbook: each sheet's cells are an ExportCells.
function sourceSheets(workbook: ExportWorkbook): PreparedSheet[] {
  const result: PreparedSheet[] = [];
  const seen = new Set<string>();
  // The rest of a PreparedSheet (its name too) is filled in by assignSheetNames and prepareWorkbook before anything reads it.
  const sheetOf = (sheet: Pick<PreparedSheet, "id" | "sourceName" | "metadata" | "data">) => sheet as PreparedSheet;
  const order = Array.isArray(workbook?.sheetOrder) ? workbook.sheetOrder : [];
  const sheetMap: Record<string, SheetMeta | undefined> = workbook?.sheets && typeof workbook.sheets === "object" ? workbook.sheets : {};
  for (const rawId of order) {
    const id = String(rawId);
    if (seen.has(id)) continue;
    seen.add(id);
    const metadata = sheetMap[id];
    if (!metadata || typeof metadata !== "object") continue;
    result.push(sheetOf({ id, sourceName: typeof metadata.name === "string" ? metadata.name : "Sheet", metadata, data: workbook.cells?.get(id) || new ExportCells() }));
  }
  if (!result.length) result.push(sheetOf({ id: "", sourceName: "Sheet", metadata: {}, data: new ExportCells() }));
  assignSheetNames(result);
  return result;
}
function integerIn(value: unknown, minimum: number, maximum: number): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : null;
}
function parseRangeReference(value: unknown): CellRange | null {
  const match = /^([A-Z]+[1-9]\d*)(?::([A-Z]+[1-9]\d*))?$/.exec(typeof value === "string" ? value : "");
  const first = match && parseCellReference(match[1]);
  const last = match && parseCellReference(match[2] ?? match[1]);
  if (!first || !last) return null;
  return {
    firstRow: Math.min(first.row, last.row), lastRow: Math.max(first.row, last.row),
    firstColumn: Math.min(first.column, last.column), lastColumn: Math.max(first.column, last.column),
  };
}
function absoluteReference(sheetName: string, firstColumn: number, firstRow: number, lastColumn: number, lastRow: number): string {
  const first = `$${columnName(firstColumn)}$${firstRow}`, last = `$${columnName(lastColumn)}$${lastRow}`;
  return `'${sheetName.replace(/'/g, "''")}'!${first}${first === last ? "" : ":" + last}`;
}
// The grid's filter tokens: `s:` text, `n:` number, `b:1`/`b:0`, `e:` an error, `z:` blank,
// and `x:__none__` when nothing was selected.
function filterCriterion(token: unknown): { blank: true } | { value: string } | null {
  if (typeof token !== "string") return null;
  const kind = token.slice(0, 2), text = token.slice(2);
  if (kind === "z:") return { blank: true };
  if (kind === "b:") return { value: text === "1" ? "TRUE" : "FALSE" };
  return kind === "s:" || kind === "n:" || kind === "e:" ? { value: text } : null;
}
// Sorting in the grid reorders the stored cells, so only the header row, the criteria and the
// sort indicator are exported. Rows are hidden exactly as the grid hides them, by the computed
// values in the criteria columns. Excel matches filter values against a cell's displayed text,
// so each chosen value is written as the grid shows it.
function prepareFilter(sheet: PreparedSheet, evaluator: ExportEvaluator, fmts: CellFmt[]): PreparedFilter | null {
  const filter = sheet.metadata.filter;
  if (!filter || typeof filter !== "object") return null;
  const headerRow = integerIn(filter.row, 0, XL_MAX_ROWS - 1);
  const endRow = headerRow == null ? null : integerIn(filter.endRow, headerRow, XL_MAX_ROWS - 1);
  const columns = Array.isArray(filter.columns)
    ? [...new Set(filter.columns.map((column) => integerIn(column, 0, XL_MAX_COLUMNS - 1)))].filter((column): column is number => column != null).sort((a, b) => a - b)
    : [];
  if (headerRow == null || endRow == null || !columns.length) return null;
  const first = columns[0], last = columns[columns.length - 1];
  const criteria = new Map<number, FilterCriterion>();
  const source: Record<string, unknown> = filter.criteria && typeof filter.criteria === "object" ? filter.criteria : {};
  for (const [key, tokens] of Object.entries(source)) {
    const column = /^(0|[1-9]\d*)$/.test(key) ? Number(key) : null;
    if (column == null || !columns.includes(column) || !Array.isArray(tokens) || !tokens.length) continue;
    const criterion: FilterCriterion = { tokens: new Set<unknown>(tokens), values: [], blank: false, selectsNothing: tokens.every((token) => typeof token === "string" && token.startsWith("x:")) };
    criteria.set(column, criterion);
  }
  // Each criteria column's computed token per row, and the text a chosen token shows as.
  const tokenOf = new Map([...criteria.keys()].map((column) => [column, new Map<number, string | null>()]));
  const shownAs = new Map<string, string>();
  const data = sheet.data;
  for (let i = 0; i < data.size; ++i) {
    const row = data.rows[i], tokens = tokenOf.get(data.cols[i]);
    if (!tokens || row <= headerRow || row > endRow || data.values[i] === "") continue;
    const value = evaluator.value(sheet.id, row, data.cols[i]);
    const token = value === EXPORT_UNKNOWN ? null : computedFilterToken(value as Scalar); // unknown: no row is hidden by it
    tokens.set(row, token);
    if (token === null) continue;
    const key = data.cols[i] + "\u0000" + token;
    if (!shownAs.has(key)) shownAs.set(key, displayValue(value as Scalar, data.fmtIds[i] >= 0 ? fmts[data.fmtIds[i]] : null).text);
  }
  for (const [column, criterion] of criteria) {
    for (const token of criterion.tokens) {
      const parsed = filterCriterion(token);
      if (parsed && "blank" in parsed) criterion.blank = true;
      else if (parsed) criterion.values.push(shownAs.get(column + "\u0000" + token) ?? parsed.value);
    }
  }
  const filterColumns: FilterColumn[] = [];
  for (let column = first; column <= last; ++column) {
    const criterion = criteria.get(column);
    if (!columns.includes(column)) filterColumns.push({ offset: column - first, hiddenButton: true });
    else if (criterion?.values.length || criterion?.blank) filterColumns.push({ offset: column - first, ...criterion });
  }
  const hiddenRows: number[] = [];
  if (criteria.size) {
    for (let row = headerRow + 1; row <= endRow; ++row) {
      for (const [column, criterion] of criteria) {
        const token = (tokenOf.get(column) as Map<number, string | null>).get(row) ?? "z:"; // every criteria column has its map
        if (criterion.selectsNothing || (token !== null && !criterion.tokens.has(token))) { hiddenRows.push(row + 1); break; }
      }
    }
  }
  const sortColumn = filter.sort && typeof filter.sort === "object" ? integerIn(filter.sort.column, 0, XL_MAX_COLUMNS - 1) : null;
  const direction = filter.sort?.direction;
  const sort = sortColumn != null && columns.includes(sortColumn) && endRow > headerRow && (direction === "asc" || direction === "desc")
    ? {
        ref: `${columnName(first + 1)}${headerRow + 2}:${columnName(last + 1)}${endRow + 1}`,
        column: `${columnName(sortColumn + 1)}${headerRow + 2}:${columnName(sortColumn + 1)}${endRow + 1}`,
        descending: direction === "desc",
      }
    : null;
  return {
    ref: `${columnName(first + 1)}${headerRow + 1}:${columnName(last + 1)}${endRow + 1}`,
    definedName: absoluteReference(sheet.name, first + 1, headerRow + 1, last + 1, endRow + 1),
    columns: filterColumns, hiddenRows, sort,
  };
}
// Walks the grid's pixel sizes to the cell under `pixels`, for a chart's anchor.
function anchorPosition(pixels: number, sizes: unknown, defaultPixels: number, maximum: number): Anchor {
  const source: Record<string, unknown> = sizes && typeof sizes === "object" ? sizes as Record<string, unknown> : {};
  let index = 0;
  let remaining = Number.isFinite(pixels) ? Math.min(5000, Math.max(0, Math.round(pixels))) : 0;
  for (;;) {
    const size = pixelDimension(source[index]) ?? defaultPixels;
    if (remaining < size || index >= maximum - 1) return { index, offset: Math.min(remaining, size - 1) * EMU_PER_PIXEL };
    remaining -= size;
    ++index;
  }
}
// The grid drops a column with no number in it before building series (chartData).
function usableSeriesColumns(sheet: PreparedSheet, range: CellRange, firstColumn: number, evaluator: ExportEvaluator): number[] {
  const usable = new Set<number>();
  const data = sheet.data;
  for (let i = 0; i < data.size; ++i) {
    if (sheet.styleOf[i] < 0) continue;
    const row = data.rows[i] + 1, column = data.cols[i] + 1;
    if (column < firstColumn || column > range.lastColumn || row < range.firstRow || row > range.lastRow || usable.has(column)) continue;
    const value = evaluator.value(sheet.id, row - 1, column - 1);
    if (value === EXPORT_UNKNOWN || (typeof value === "number" && Number.isFinite(value))) usable.add(column);
  }
  return [...usable].sort((a, b) => a - b);
}
// What a chart shows, for its cached values: labels and series names as the grid displays them,
// and each point's number (null where the grid leaves a gap).
function chartCaches(sheet: PreparedSheet, chart: ChartLayout, evaluator: ExportEvaluator, fmtAt: Map<number, CellFmt>): ChartCache {
  const text = (row: number, column: number) => {
    const value = evaluator.value(sheet.id, row - 1, column - 1);
    return value === EXPORT_UNKNOWN ? "" : displayValue(value as Scalar, fmtAt.get((row - 1) * XL_MAX_COLUMNS + column - 1)).text;
  };
  const rows: number[] = [];
  for (let row = chart.firstRow; row <= chart.lastRow; ++row) rows.push(row);
  return {
    categories: chart.categoryColumn ? rows.map((row) => text(row, chart.categoryColumn as number)) : null,
    names: chart.columns.map((column) => chart.headerRow ? text(chart.headerRow, column) || columnName(column) : columnName(column)),
    named: chart.columns.map((column) => chart.headerRow ? text(chart.headerRow, column) !== "" : false),
    values: chart.columns.map((column) => rows.map((row) => {
      const value = evaluator.value(sheet.id, row - 1, column - 1);
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    })),
  };
}
// Mirrors the grid's chartData(): with header and label options on, each remaining column is a
// series named by its first cell, categorized by the first column. Charts without usable data
// are skipped, as the grid draws only a placeholder for them.
function prepareCharts(sheet: PreparedSheet, evaluator: ExportEvaluator, fmts: CellFmt[]): PreparedChart[] {
  const source = Array.isArray(sheet.metadata.charts) ? sheet.metadata.charts : [];
  const charts: PreparedChart[] = [];
  // Each cell's format by position, built once for all the sheet's charts.
  let fmtAt: Map<number, CellFmt> | null = null;
  const formatsByPosition = () => {
    if (fmtAt) return fmtAt;
    fmtAt = new Map();
    const data = sheet.data;
    for (let i = 0; i < data.size; ++i) if (data.fmtIds[i] >= 0) fmtAt.set(data.rows[i] * XL_MAX_COLUMNS + data.cols[i], fmts[data.fmtIds[i]]);
    return fmtAt;
  };
  for (const chart of source) {
    if (!chart || typeof chart !== "object") continue;
    const range = parseRangeReference(chart.range);
    if (!range) continue;
    const firstRowHeaders = chart.firstRowHeaders !== false;
    const firstColumnLabels = chart.firstColLabels !== false;
    const dataRow = range.firstRow + (firstRowHeaders && range.lastRow > range.firstRow ? 1 : 0);
    const seriesColumn = range.firstColumn + (firstColumnLabels && range.lastColumn > range.firstColumn ? 1 : 0);
    if (dataRow > range.lastRow || seriesColumn > range.lastColumn) continue;
    const type: ChartType = XL_CHART_TYPES.has(chart.type) ? chart.type : "line";
    const columns = usableSeriesColumns(sheet, { ...range, firstRow: dataRow }, seriesColumn, evaluator).slice(0, type === "pie" ? 1 : XL_MAX_SERIES);
    if (!columns.length) continue;
    const width = xlCount(chart.width, 520, 1200), height = xlCount(chart.height, 320, 900);
    const prepared: ChartLayout = {
      type,
      title: typeof chart.title === "string" ? chart.title : "",
      xAxisTitle: typeof chart.xAxisTitle === "string" ? chart.xAxisTitle : "",
      yAxisTitle: typeof chart.yAxisTitle === "string" ? chart.yAxisTitle : "",
      legend: chart.legend !== false,
      headerRow: firstRowHeaders && range.lastRow > range.firstRow ? range.firstRow : null,
      categoryColumn: seriesColumn > range.firstColumn ? range.firstColumn : null,
      firstRow: dataRow, lastRow: range.lastRow, columns,
      column: anchorPosition(Number(chart.x ?? 96) - ROW_HEADER_PIXELS, sheet.metadata.colWidths, XL_DEFAULT_COLUMN_PIXELS, XL_MAX_COLUMNS),
      row: anchorPosition(Number(chart.y ?? 44) - COLUMN_HEADER_PIXELS, sheet.metadata.rowHeights, XL_DEFAULT_ROW_PIXELS, XL_MAX_ROWS),
      extent: { cx: width * EMU_PER_PIXEL, cy: height * EMU_PER_PIXEL },
    };
    charts.push({ ...prepared, cache: chartCaches(sheet, prepared, evaluator, formatsByPosition()) });
  }
  return charts;
}
// The grid links any literal whose text is an absolute http(s) URL, unless formatted as text.
function hyperlinkTarget(value: string, fmt: CellFmt | null): string | null {
  const text = value[0] === "'" ? value.slice(1) : value;
  if (fmt?.nf === "text" || !/^\s*https?:/i.test(text)) return null;
  try {
    const url = new URL(text);
    const external = url.protocol === "http:" || url.protocol === "https:";
    return external && url.href.length <= XL_MAX_HYPERLINK_CHARACTERS ? url.href : null;
  } catch (e) { return null; }
}
function prepareWorkbook(workbook: ExportWorkbook, evaluator: ExportEvaluator) {
  const sheets = sourceSheets(workbook);
  const fmts: CellFmt[] = Array.isArray(workbook?.fmts) ? workbook.fmts : [];
  const formulaNames = new Map<string, string>();
  for (const sheet of sheets) {
    const key = sheet.sourceName.toLowerCase();
    if (!formulaNames.has(key)) formulaNames.set(key, sheet.name);
  }
  const styles = new XlsxStyles();
  const parts = { drawings: 0, charts: 0 };
  for (const sheet of sheets) {
    sheet.rows = xlCount(sheet.metadata.rows, DEFAULT_ROWS, XL_MAX_ROWS);
    sheet.columns = xlCount(sheet.metadata.cols, DEFAULT_COLS, XL_MAX_COLUMNS);
    sheet.frozenRows = frozenCount(sheet.metadata.frozenRows, sheet.rows);
    sheet.frozenColumns = frozenCount(sheet.metadata.frozenCols, sheet.columns);
    sheet.columnWidths = xlDimensions(sheet.metadata.colWidths, sheet.columns, columnWidth);
    sheet.rowHeights = xlDimensions(sheet.metadata.rowHeights, sheet.rows, rowPoints);
    // Each cell's Excel style id, or -1 for a cell that isn't written (empty and unstyled, or
    // beyond Excel's grid). Style ids are worked out once per distinct format, not per cell.
    const data = sheet.data, order = data.order;
    const styleOf = new Int32Array(data.size);
    const styleIds = new Map<string, number>();
    const styleFor = (fmtId: number, look: CellLook, lines: boolean) => {
      if (fmtId < 0 && look === "plain" && !lines) return 0;
      const key = look + (lines ? "+lines" : "") + fmtId;
      let id = styleIds.get(key);
      if (id === undefined) {
        const fmt = lookFmt(fmtId >= 0 ? fmts[fmtId] : null, look);
        id = styles.style(lines ? { ...fmt, wrap: true } : fmt); styleIds.set(key, id);
      }
      return id;
    };
    // Rows holding typed line breaks, and the height (pixels) their lines take in the grid.
    const lineHeights = new Map<number, number>();
    sheet.hyperlinks = [];
    sheet.bounds = null;
    // In reading order, so the hyperlinks come out sorted.
    for (let k = 0; k < order.length; ++k) {
      const i = order[k], row = data.rows[i] + 1, column = data.cols[i] + 1;
      if (row > XL_MAX_ROWS || column > XL_MAX_COLUMNS) { styleOf[i] = -1; continue; }
      const value = data.values[i], fmtId = data.fmtIds[i], fmt = fmtId >= 0 ? fmts[fmtId] : null;
      // A formula whose result the grid shows as a link (HYPERLINK, or a URL) is styled as one;
      // a URL result also gets a hyperlink, as a typed URL does (HYPERLINK links by itself).
      let target: string | null = null, linked = false, look: CellLook = "plain";
      if (value[0] === "=") {
        const result = evaluator.value(sheet.id, row - 1, column - 1);
        const shown = isErr(result) || result === EXPORT_UNKNOWN ? null : displayValue(result as Scalar, fmt);
        linked = !!shown?.link;
        if (shown && linked && !(result instanceof HyperlinkValue)) target = hyperlinkTarget(shown.text, fmt);
        if (isErr(result) || (typeof result === "number" && !Number.isFinite(result))) look = "error";
        else if (typeof result === "boolean") look = "boolean";
        else if (typeof result === "string" && RTL_TEXT.test(result)) look = "rtl";
      } else if (value) {
        target = hyperlinkTarget(value, fmt);
        if (value[0] !== "'" && /^\s*(TRUE|FALSE)\s*$/i.test(value)) look = "boolean";
        else if (RTL_TEXT.test(value)) look = "rtl";
      }
      if (target && sheet.hyperlinks.length >= XL_MAX_HYPERLINKS) target = null;
      if (target) sheet.hyperlinks.push({ reference: columnName(column) + row, row, column, target, relationshipId: `rId${sheet.hyperlinks.length + 1}` });
      // Typed text with line breaks wraps, in the grid and in Excel (which sets wrap when one is
      // typed). Excel doesn't grow a row to fit on opening the file, so the row gets the height
      // its lines take in the grid (1.35 lines of the font size each, plus padding), unless it has
      // its own height.
      const lines = value[0] !== "=" && value.includes("\n");
      if (lines) {
        const pixels = (value.split("\n").length) * (Number(fmt?.fs) || 13) * 1.35 + 6;
        if (pixels > (lineHeights.get(row - 1) ?? XL_DEFAULT_ROW_PIXELS)) lineHeights.set(row - 1, pixels);
      }
      const style = styleFor(fmtId, target || linked ? "link" : look, lines);
      if (value === "" && !style) { styleOf[i] = -1; continue; }
      styleOf[i] = style;
      const b = sheet.bounds ??= { minRow: row, maxRow: row, minColumn: column, maxColumn: column };
      if (row < b.minRow) b.minRow = row; if (row > b.maxRow) b.maxRow = row;
      if (column < b.minColumn) b.minColumn = column; if (column > b.maxColumn) b.maxColumn = column;
    }
    sheet.styleOf = styleOf;
    if (lineHeights.size) {
      const own = new Set(sheet.rowHeights.map((height) => height.index));
      for (const [index, pixels] of lineHeights) if (!own.has(index)) sheet.rowHeights.push({ index, value: rowPoints(pixels) });
      sheet.rowHeights.sort((a, b) => a.index - b.index);
    }
    sheet.filter = prepareFilter(sheet, evaluator, fmts);
    sheet.hiddenRows = sheet.filter?.hiddenRows ?? [];
    const charts = prepareCharts(sheet, evaluator, fmts);
    if (charts.length) {
      sheet.drawing = {
        index: ++parts.drawings,
        relationshipId: `rId${sheet.hyperlinks.length + 1}`,
        charts: charts.map((chart) => ({ ...chart, index: ++parts.charts })),
      };
    }
  }
  return { sheets, styles, formulaNames, parts };
}

function formulaReferenceAt(formula: string, offset: number): boolean {
  const match = /^\$?([A-Za-z]{1,3})\$?([1-9]\d*)/.exec(formula.slice(offset));
  if (!match) return false;
  let column = 0;
  for (const character of match[1].toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
  if (column > XL_MAX_COLUMNS || Number(match[2]) > XL_MAX_ROWS) return false;
  const next = formula[offset + match[0].length];
  return !next || !/[A-Za-z0-9_$]/.test(next);
}
function isThreeDimensionalReference(formula: string, offset: number): boolean {
  if (formula[offset - 1] !== ":") return false;
  let start = offset - 2;
  while (start >= 0 && /[A-Za-z0-9_$]/.test(formula[start])) --start;
  const preceding = formula.slice(start + 1, offset - 1);
  return !/^\$?[A-Za-z]{1,3}\$?[1-9]\d*$/.test(preceding);
}
// `'Owner\'s Sheet'!` (the grid's spelling) becomes Excel's `'Owner''s Sheet'!`, renamed to the
// sheet's Excel-safe name.
// A reference to a sheet the workbook doesn't have is #REF! in the grid. Written as is, Excel
// would read it as a link to another workbook and ask whether to trust it, so the whole
// reference (its cell or range too: Excel calls a file holding #REF!A1 damaged) becomes #REF!.
const CELL_OR_RANGE = /\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?/y;
function missingSheetReference(formula: string, offset: number): FormulaPiece {
  CELL_OR_RANGE.lastIndex = offset;
  return { end: CELL_OR_RANGE.exec(formula) ? CELL_OR_RANGE.lastIndex : offset, text: "#REF!" };
}
function quotedSheetReference(formula: string, offset: number, names: Map<string, string>): FormulaPiece | null {
  const nameParts: string[] = [];
  for (let i = offset + 1; i < formula.length; ++i) {
    if (formula[i] === "\\" && formula[i + 1] === "'") { nameParts.push("'"); ++i; continue; }
    if (formula[i] !== "'") { nameParts.push(formula[i]); continue; }
    if (formula[i + 1] === "'") { nameParts.push("'"); ++i; continue; }
    const quoteEnd = i + 1;
    const hasBang = formula[quoteEnd] === "!";
    const end = quoteEnd + (hasBang ? 1 : 0);
    const text = formula.slice(offset, end);
    const name = nameParts.join("");
    const normalized = names.get(name.toLowerCase());
    const malformed = offset > 0 && /[A-Za-z0-9_.$]/.test(formula[offset - 1]);
    const external = formula[offset - 1] === "]" || (!normalized && /\[[^\]]*\]/.test(name));
    if (!hasBang || !formulaReferenceAt(formula, end) || malformed || external || isThreeDimensionalReference(formula, offset)) return { end, text };
    return normalized ? { end, text: `'${normalized.replace(/'/g, "''")}'!` } : missingSheetReference(formula, end);
  }
  return null;
}
function unquotedSheetReference(formula: string, offset: number, names: Map<string, string>): FormulaPiece | null {
  if (!/[A-Za-z_$]/.test(formula[offset]) || (offset > 0 && /[A-Za-z0-9_.$]/.test(formula[offset - 1])) ||
      formula[offset - 1] === "]" || isThreeDimensionalReference(formula, offset)) return null;
  let end = offset + 1;
  while (end < formula.length && /[A-Za-z0-9_.$]/.test(formula[end])) ++end;
  if (formula[end] !== "!" || !formulaReferenceAt(formula, end + 1)) return null;
  const name = formula.slice(offset, end);
  const normalized = names.get(name.toLowerCase());
  if (!normalized) return missingSheetReference(formula, end + 1);
  if (normalized.toLowerCase() === name.toLowerCase()) return { end: end + 1, text: formula.slice(offset, end + 1) };
  return { end: end + 1, text: `'${normalized.replace(/'/g, "''")}'!` };
}
// A function call at `offset`. The grid accepts `SUM (1)`; in Excel that space is the
// intersection operator, so the gap is dropped. Newer functions get Excel's `_xlfn.` prefix.
function formulaFunctionAt(formula: string, offset: number): FormulaPiece | null {
  if (!/[A-Za-z_]/.test(formula[offset]) || (offset > 0 && /[A-Za-z0-9_.$!]/.test(formula[offset - 1]))) return null;
  let end = offset + 1;
  while (end < formula.length && /[A-Za-z0-9_.]/.test(formula[end])) ++end;
  let parenthesis = end;
  while (parenthesis < formula.length && /\s/.test(formula[parenthesis])) ++parenthesis;
  if (formula[parenthesis] !== "(") return null;
  const name = formula.slice(offset, end).toUpperCase();
  if (FUTURE_FUNCTIONS.has(name)) return { end: parenthesis, text: "_xlfn." + name };
  if (name === "ERRORTYPE") return { end: parenthesis, text: "ERROR.TYPE" };
  return parenthesis > end ? { end: parenthesis, text: formula.slice(offset, end) } : null;
}
// Whether `offset` starts a call to one of the grid's functions with an empty argument list,
// which Excel requires arguments for.
const EMPTY_CALL = /([A-Za-z_][A-Za-z0-9_.]*)\s*\(\s*\)/y;
function missingArguments(formula: string, offset: number): boolean {
  if (offset > 0 && /[A-Za-z0-9_.$!]/.test(formula[offset - 1])) return false;
  EMPTY_CALL.lastIndex = offset;
  const name = EMPTY_CALL.exec(formula)?.[1].toUpperCase();
  return name !== undefined && Object.hasOwn(FUNCTIONS, name) && !NO_ARGUMENT_FUNCTIONS.has(name);
}
// Mirrors the grid's tokenizer: inside a string a doubled quote, or a backslash before the
// quote, is a literal quote. Emits Excel's form (double quotes, doubled inside), or null when
// unterminated.
function stringLiteralAt(formula: string, offset: number): FormulaPiece | null {
  const quote = formula[offset];
  let text = "";
  for (let i = offset + 1; i < formula.length; ++i) {
    const character = formula[i];
    const escaped = formula[i + 1] === quote && (character === quote || character === "\\");
    if (escaped) { text += quote; ++i; }
    else if (character === quote) return { end: i + 1, text: `"${text.replace(/"/g, '""')}"` };
    else text += character;
  }
  return null;
}
// A single-quoted run is a sheet name only when its closing quote is followed by `!` (or `:`,
// for an Excel 3-D reference); any other run is a string literal.
function quotedSheetNameAt(formula: string, offset: number): boolean {
  for (let i = offset + 1; i < formula.length; ++i) {
    if (formula[i] === "\\" && formula[i + 1] === "'") { ++i; continue; }
    if (formula[i] !== "'") continue;
    if (formula[i + 1] === "'") { ++i; continue; }
    return formula[i + 1] === "!" || formula[i + 1] === ":";
  }
  return false;
}
// Rewrites strings, sheet names and function names for Excel. Returns null when the formula is
// unbalanced: the grid tolerates that, but one such formula makes Excel call the file damaged.
function rewriteFormula(formula: string, names: Map<string, string>): string | null {
  const result: string[] = [];
  let parentheses = 0, structuredReferenceDepth = 0, braces = 0;
  for (let i = 0; i < formula.length;) {
    const character = formula[i];
    // An array constant (`{1,2;3,4}`) is written without the spaces the grid allows in it.
    if (braces && !structuredReferenceDepth && /\s/.test(character)) { ++i; continue; }
    if (character === '"' || (character === "'" && !structuredReferenceDepth && !quotedSheetNameAt(formula, i))) {
      const literal = stringLiteralAt(formula, i);
      if (!literal) return null;
      result.push(literal.text);
      i = literal.end;
      continue;
    }
    let apostrophes = 0;
    if (structuredReferenceDepth && (character === "[" || character === "]")) {
      for (let j = i - 1; formula[j] === "'"; --j) ++apostrophes;
    }
    const escapedBracket = apostrophes % 2 === 1;
    if (character === "[" && !escapedBracket) ++structuredReferenceDepth;
    else if (character === "]" && !escapedBracket && --structuredReferenceDepth < 0) return null;
    if (!structuredReferenceDepth) {
      if (character === "{") ++braces;
      else if (character === "}" && --braces < 0) return null;
      if (character === "(") ++parentheses;
      else if (character === ")" && --parentheses < 0) return null;
      if (missingArguments(formula, i)) return null;
      const reference = character === "'" ? quotedSheetReference(formula, i, names) : formulaFunctionAt(formula, i) || unquotedSheetReference(formula, i, names);
      if (character === "'" && !reference) return null;
      if (reference) { result.push(reference.text); i = reference.end; continue; }
    }
    result.push(character);
    ++i;
  }
  return parentheses || structuredReferenceDepth || braces ? null : result.join("");
}
function parsedCellValue(value: string, formulaNames: Map<string, string> | null): ParsedCell {
  if (value[0] === "'") return { type: "text", value: value.slice(1) };
  if (value[0] === "=") {
    const formula = rewriteFormula(value.slice(1), formulaNames ?? new Map());
    // Excel also rejects empty formulas and those over its length limit; the text is kept instead.
    return formula && formula.trim() && formula.length < XL_MAX_FORMULA_CHARACTERS ? { type: "formula", value: formula } : { type: "text", value };
  }
  const trimmed = value.trim();
  if (trimmed === "") return { type: "blank", value: "" };
  if (/^(TRUE|FALSE)$/i.test(trimmed)) return { type: "boolean", value: /^true$/i.test(trimmed) };
  if (/^[-+]?\$?[\d,]*\.?\d+%?$/.test(trimmed) && /\d/.test(trimmed)) {
    const negative = trimmed.startsWith("-");
    let number = Number(trimmed.replace(/[$,+%-]/g, ""));
    if (Number.isFinite(number)) {
      if (trimmed.endsWith("%")) number /= 100;
      return { type: "number", value: negative ? -number : number };
    }
  }
  return { type: "text", value };
}
// Excel's error values; the grid's #CYCLE! has no equivalent, so it gets no cached result.
const XL_ERRORS = new Set(["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A"]);
// A formula's cached result, as the grid computed it, so viewers that don't recalculate (and
// Excel before it recalculates) show the same values.
function cachedResultXml(value: ExportValue): string {
  if (value === EXPORT_UNKNOWN) return ">";
  let result = value as Scalar;
  if (isMatrix(result)) result = result.get(0, 0);
  if (isErr(result)) return XL_ERRORS.has(result.value) ? ` t="e"><v>${result.value}</v>` : ">";
  if (typeof result === "number") return Number.isFinite(result) ? `><v>${String(result)}</v>` : ` t="e"><v>#NUM!</v>`;
  if (typeof result === "boolean") return ` t="b"><v>${result ? 1 : 0}</v>`;
  const text = result instanceof HyperlinkValue ? result.label : result == null ? "" : String(result);
  return ` t="str"><v>${spreadsheetXml(text)}</v>`;
}
// A formula that is just a range (=A1:B3) shows the range's first value in the grid. Excel
// would intersect a plain formula with the cell's row or column (#VALUE! off the range); as a
// one-cell array formula it shows the first value too.
function isRangeFormula(value: string): boolean {
  try {
    return unwrapParens(parseFormula(value.slice(1))).k === "range";
  } catch {
    return false;
  }
}
// `result()` gives a formula cell's computed value.
function cellXml(reference: string, value: string, styleId: number, formulaNames: Map<string, string>, result: () => ExportValue): string {
  const style = styleId ? ` s="${styleId}"` : "";
  if (value === "") return `<c r="${reference}"${style}/>`;
  const parsed = parsedCellValue(value, formulaNames);
  if (parsed.type === "blank") return `<c r="${reference}"${style}/>`;
  if (parsed.type === "formula") {
    const cached = cachedResultXml(result());
    const open = cached.startsWith(" t=") ? cached.slice(0, cached.indexOf(">")) : "";
    const array = isRangeFormula(value) ? ` t="array" ref="${reference}"` : "";
    return `<c r="${reference}"${style}${open}><f${array}>${formulaXml(parsed.value)}</f>${cached.slice(cached.indexOf(">") + 1)}</c>`;
  }
  if (parsed.type === "boolean") return `<c r="${reference}"${style} t="b"><v>${parsed.value ? 1 : 0}</v></c>`;
  if (parsed.type === "number") return `<c r="${reference}"${style}><v>${String(parsed.value)}</v></c>`;
  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${spreadsheetXml(parsed.value)}</t></is></c>`;
}
function frozenPane(sheet: PreparedSheet): string {
  const rows = sheet.frozenRows, columns = sheet.frozenColumns;
  if (!rows && !columns) return "";
  const attributes = [];
  if (columns) attributes.push(`xSplit="${columns}"`);
  if (rows) attributes.push(`ySplit="${rows}"`);
  attributes.push(`topLeftCell="${columnName(columns + 1)}${rows + 1}"`);
  attributes.push(`activePane="${rows && columns ? "bottomRight" : rows ? "bottomLeft" : "topRight"}"`);
  attributes.push('state="frozen"');
  return `<pane ${attributes.join(" ")}/>`;
}
function worksheetDimension(bounds: Bounds | null): string {
  if (!bounds) return "A1";
  const first = columnName(bounds.minColumn) + bounds.minRow, last = columnName(bounds.maxColumn) + bounds.maxRow;
  return first === last ? first : first + ":" + last;
}
function autoFilterXml(filter: PreparedFilter): string {
  let xml = `<autoFilter ref="${filter.ref}">`;
  for (const column of filter.columns) {
    if (column.hiddenButton) { xml += `<filterColumn colId="${column.offset}" hiddenButton="1"/>`; continue; }
    xml += `<filterColumn colId="${column.offset}"><filters${column.blank ? ' blank="1"' : ""}>`;
    for (const value of column.values) xml += `<filter val="${spreadsheetXml(value, true)}"/>`;
    xml += "</filters></filterColumn>";
  }
  // A sort applied through the filter menu lives inside the autoFilter, as Excel writes it.
  if (filter.sort) xml += `<sortState ref="${filter.sort.ref}"><sortCondition ref="${filter.sort.column}"${filter.sort.descending ? ' descending="1"' : ""}/></sortState>`;
  return xml + "</autoFilter>";
}
function* worksheetXml(sheet: PreparedSheet, formulaNames: Map<string, string>, evaluator: ExportEvaluator): Generator<string> {
  yield `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${XL_MAIN_NS}" xmlns:r="${XL_REL_NS}">`;
  yield `<dimension ref="${worksheetDimension(sheet.bounds)}"/>`;
  yield `<sheetViews><sheetView workbookViewId="0">${frozenPane(sheet)}</sheetView></sheetViews>`;
  yield `<sheetFormatPr defaultColWidth="${columnWidth(XL_DEFAULT_COLUMN_PIXELS)}" defaultRowHeight="${rowPoints(XL_DEFAULT_ROW_PIXELS)}"/>`;
  if (sheet.columnWidths.length) {
    yield "<cols>";
    for (const width of sheet.columnWidths) yield `<col min="${width.index + 1}" max="${width.index + 1}" width="${width.value}" customWidth="1"/>`;
    yield "</cols>";
  }
  yield "<sheetData>";
  // Cells in reading order; those not written (styleOf -1) are skipped. One string per row.
  const data = sheet.data, order = data.order, styleOf = sheet.styleOf, letters: string[] = [];
  let k = 0, heightIndex = 0, hiddenIndex = 0;
  for (;;) {
    while (k < order.length && styleOf[order[k]] < 0) ++k;
    const cellRow = k < order.length ? data.rows[order[k]] + 1 : Infinity;
    const heightRow = (sheet.rowHeights[heightIndex]?.index ?? Infinity) + 1;
    const hiddenRow = sheet.hiddenRows[hiddenIndex] ?? Infinity;
    const row = Math.min(cellRow, heightRow, hiddenRow);
    if (row === Infinity) break;
    const height = heightRow === row ? sheet.rowHeights[heightIndex++] : null;
    const hidden = hiddenRow === row && ++hiddenIndex;
    let xml = `<row r="${row}"${height ? ` ht="${height.value}" customHeight="1"` : ""}${hidden ? ' hidden="1"' : ""}>`;
    while (k < order.length && data.rows[order[k]] + 1 === row) {
      const i = order[k++];
      if (styleOf[i] < 0) continue;
      const column = data.cols[i] + 1;
      xml += cellXml((letters[column] ??= columnName(column)) + row, data.values[i], styleOf[i], formulaNames, () => evaluator.value(sheet.id, row - 1, column - 1));
    }
    yield xml + "</row>";
  }
  yield "</sheetData>";
  if (sheet.filter) yield autoFilterXml(sheet.filter);
  if (sheet.hyperlinks.length) {
    yield "<hyperlinks>";
    for (const link of sheet.hyperlinks) yield `<hyperlink ref="${link.reference}" r:id="${link.relationshipId}"/>`;
    yield "</hyperlinks>";
  }
  if (sheet.drawing) yield `<drawing r:id="${sheet.drawing.relationshipId}"/>`;
  yield "</worksheet>";
}
function worksheetRelationships(sheet: PreparedSheet): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${XL_PACKAGE_REL_NS}">`;
  for (const link of sheet.hyperlinks) xml += `<Relationship Id="${link.relationshipId}" Type="${XL_REL_NS}/hyperlink" Target="${xmlAttribute(link.target)}" TargetMode="External"/>`;
  if (sheet.drawing) xml += `<Relationship Id="${sheet.drawing.relationshipId}" Type="${XL_REL_NS}/drawing" Target="../drawings/drawing${sheet.drawing.index}.xml"/>`;
  return xml + "</Relationships>";
}
function drawingXml(drawing: Drawing): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="${XL_SPREADSHEET_DRAWING_NS}" xmlns:a="${XL_DRAWING_NS}">`;
  drawing.charts.forEach((chart, i) => {
    xml += `<xdr:oneCellAnchor><xdr:from><xdr:col>${chart.column.index}</xdr:col><xdr:colOff>${chart.column.offset}</xdr:colOff>` +
      `<xdr:row>${chart.row.index}</xdr:row><xdr:rowOff>${chart.row.offset}</xdr:rowOff></xdr:from>` +
      `<xdr:ext cx="${chart.extent.cx}" cy="${chart.extent.cy}"/>` +
      `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
      '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
      `<a:graphic><a:graphicData uri="${XL_CHART_NS}"><c:chart xmlns:c="${XL_CHART_NS}" xmlns:r="${XL_REL_NS}" r:id="rId${i + 1}"/></a:graphicData></a:graphic>` +
      "</xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>";
  });
  return xml + "</xdr:wsDr>";
}
function drawingRelationships(drawing: Drawing): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${XL_PACKAGE_REL_NS}">`;
  drawing.charts.forEach((chart, i) => { xml += `<Relationship Id="rId${i + 1}" Type="${XL_REL_NS}/chart" Target="../charts/chart${chart.index}.xml"/>`; });
  return xml + "</Relationships>";
}
// Sized like the grid's (a 13px semibold chart title, 11px axis titles) rather than Excel's 14pt / 10pt bold.
function chartTitleXml(text: string, axis = false): string {
  const size = axis ? 'sz="900" b="0"' : 'sz="1200" b="1"';
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr ${size}/></a:pPr><a:r><a:rPr lang="en-US" ${size}/><a:t>${plainXml(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
}
function solidFill(color: string, alpha?: number): string {
  const rgb = alpha ? `<a:srgbClr val="${color}"><a:alpha val="${alpha}"/></a:srgbClr>` : `<a:srgbClr val="${color}"/>`;
  return `<a:solidFill>${rgb}</a:solidFill>`;
}
function chartSeriesXml(chart: PreparedChart, sheetName: string, index: number): string {
  const column = chart.columns[index];
  const color = XL_CHART_COLORS[index % XL_CHART_COLORS.length];
  const reference = (firstRow: number, lastRow: number) => plainXml(absoluteReference(sheetName, column, firstRow, column, lastRow));
  let xml = `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>`;
  const name = chart.cache.names[index];
  // A blank header cell would leave the series unnamed (or "Column B"); the grid names it by its column.
  xml += chart.headerRow && chart.cache.named[index] ? `<c:tx><c:strRef><c:f>${reference(chart.headerRow, chart.headerRow)}</c:f>${strCacheXml([name])}</c:strRef></c:tx>` : `<c:tx><c:v>${plainXml(name)}</c:v></c:tx>`;
  if (chart.type === "line") {
    xml += `<c:spPr><a:ln w="28575" cap="rnd">${solidFill(color)}<a:round/></a:ln></c:spPr>`;
    xml += `<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr>${solidFill(color)}<a:ln>${solidFill(color)}</a:ln></c:spPr></c:marker>`;
  } else if (chart.type === "area") {
    xml += `<c:spPr>${solidFill(color, 18000)}<a:ln w="28575">${solidFill(color)}</a:ln></c:spPr>`;
  } else if (chart.type === "stackedBar") {
    xml += `<c:spPr>${solidFill(color)}</c:spPr><c:invertIfNegative val="0"/>`;
  } else {
    // The grid draws only positive slices and colours them in order, so a blank or zero point
    // (which has no slice anyway) takes no colour. Negative points come after the positive ones.
    const values = chart.cache.values[index];
    const drawn = values.map((value, point) => ({ value, point })).filter(({ value }) => value != null && value !== 0)
      .sort((a, b) => Number((a.value as number) < 0) - Number((b.value as number) < 0)).slice(0, 64);
    drawn.forEach(({ point }, order) => {
      xml += `<c:dPt><c:idx val="${point}"/><c:bubble3D val="0"/><c:spPr>${solidFill(XL_CHART_COLORS[order % XL_CHART_COLORS.length])}<a:ln w="19050">${solidFill("FFFFFF")}</a:ln></c:spPr></c:dPt>`;
    });
  }
  if (chart.categoryColumn) {
    const categories = absoluteReference(sheetName, chart.categoryColumn, chart.firstRow, chart.categoryColumn, chart.lastRow);
    xml += `<c:cat><c:strRef><c:f>${plainXml(categories)}</c:f>${strCacheXml(chart.cache.categories ?? [])}</c:strRef></c:cat>`;
  }
  xml += `<c:val><c:numRef><c:f>${reference(chart.firstRow, chart.lastRow)}</c:f>${numCacheXml(chart.cache.values[index])}</c:numRef></c:val>`;
  if (chart.type === "line") xml += '<c:smooth val="0"/>';
  return xml + "</c:ser>";
}
// Cached points, so a chart draws before (or without) recalculation.
function strCacheXml(texts: string[]): string {
  return `<c:strCache><c:ptCount val="${texts.length}"/>` + texts.map((text, i) => `<c:pt idx="${i}"><c:v>${plainXml(text)}</c:v></c:pt>`).join("") + "</c:strCache>";
}
function numCacheXml(values: (number | null)[]): string {
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>` +
    values.map((value, i) => value == null ? "" : `<c:pt idx="${i}"><c:v>${value}</c:v></c:pt>`).join("") + "</c:numCache>";
}
function chartAxisXml(kind: "catAx" | "valAx", id: number, crossId: number, position: string, title: string, { reversed = false, crossesMax = false, minimum = null as number | null } = {}): string {
  return `<c:${kind}><c:axId val="${id}"/><c:scaling><c:orientation val="${reversed ? "maxMin" : "minMax"}"/>${minimum == null ? "" : `<c:min val="${minimum}"/>`}</c:scaling>` +
    `<c:delete val="0"/><c:axPos val="${position}"/>${kind === "valAx" ? "<c:majorGridlines/>" : ""}${title ? chartTitleXml(title, true) : ""}` +
    // Category labels sit at the low end of the value axis, as the grid draws them, even when it crosses zero.
    // Tick values are plain numbers, as in the grid, not in the data's format ($120).
    `<c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="${kind === "catAx" ? "low" : "nextTo"}"/>` +
    `<c:crossAx val="${crossId}"/><c:crosses val="${crossesMax ? "max" : "autoZero"}"/>` +
    (kind === "catAx" ? '<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/>' : '<c:crossBetween val="between"/>') +
    `</c:${kind}>`;
}
// Series point at the worksheet and carry the grid's values as their cache. Like the grid, a chart
// plots rows a filter hides (plotVisOnly 0).
function chartXml(chart: PreparedChart, sheetName: string): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="${XL_CHART_NS}" xmlns:a="${XL_DRAWING_NS}" xmlns:r="${XL_REL_NS}">`;
  xml += '<c:roundedCorners val="0"/><c:chart>';
  xml += chart.title ? chartTitleXml(chart.title) + '<c:autoTitleDeleted val="0"/>' : '<c:autoTitleDeleted val="1"/>';
  xml += "<c:plotArea><c:layout/>";
  const series = chart.columns.map((_, index) => chartSeriesXml(chart, sheetName, index)).join("");
  if (chart.type === "pie") {
    xml += `<c:pieChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/></c:pieChart>`;
  } else {
    const axes = '<c:axId val="1"/><c:axId val="2"/>';
    if (chart.type === "stackedBar") {
      xml += `<c:barChart><c:barDir val="bar"/><c:grouping val="stacked"/><c:varyColors val="0"/>${series}<c:gapWidth val="56"/><c:overlap val="100"/>${axes}</c:barChart>`;
      // Categories run top-down as in the grid, which puts the value axis at the category maximum.
      // The grid stacks only positive values, from zero; the axis starting there clips negatives the same way.
      xml += chartAxisXml("catAx", 1, 2, "l", chart.yAxisTitle, { reversed: true }) + chartAxisXml("valAx", 2, 1, "b", chart.xAxisTitle, { crossesMax: true, minimum: 0 });
    } else {
      xml += chart.type === "area"
        ? `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}${axes}</c:areaChart>`
        : `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/>${axes}</c:lineChart>`;
      xml += chartAxisXml("catAx", 1, 2, "b", chart.xAxisTitle) + chartAxisXml("valAx", 2, 1, "l", chart.yAxisTitle);
    }
  }
  xml += "</c:plotArea>";
  if (chart.legend) {
    // The grid's pie legend lists only the slices it draws; blank and zero points have none.
    const hidden = chart.type === "pie" ? chart.cache.values[0].flatMap((value, point) => value == null || value === 0 ? [point] : []) : [];
    xml += '<c:legend><c:legendPos val="r"/>' + hidden.map((point) => `<c:legendEntry><c:idx val="${point}"/><c:delete val="1"/></c:legendEntry>`).join("") + '<c:overlay val="0"/></c:legend>';
  }
  // Blanks are gaps, as in the grid, except in an area chart: Excel for the web stops drawing an
  // area series at its first gap, so there a blank is zero (how LibreOffice draws it anyway).
  // A white card with a hairline, as the grid draws it (without a fill, cells show through in some viewers).
  return xml + `<c:plotVisOnly val="0"/><c:dispBlanksAs val="${chart.type === "area" ? "zero" : "gap"}"/></c:chart><c:spPr>${solidFill("FFFFFF")}<a:ln w="9525">${solidFill("E4E4E1")}</a:ln></c:spPr></c:chartSpace>`;
}
function* stylesXml(styles: XlsxStyles): Generator<string> {
  yield `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${XL_MAIN_NS}">`;
  if (styles.numberFormats.length) {
    yield `<numFmts count="${styles.numberFormats.length}">`;
    for (const format of styles.numberFormats) yield `<numFmt numFmtId="${format.id}" formatCode="${xmlAttribute(format.code)}"/>`;
    yield "</numFmts>";
  }
  yield `<fonts count="${styles.fonts.length}">`;
  for (const font of styles.fonts) {
    yield "<font>";
    if (font.bold) yield "<b/>";
    if (font.italic) yield "<i/>";
    // CT_Font's order: b, i, strike, …, u, …, sz, color, name, family, scheme.
    if (font.strike) yield "<strike/>";
    if (font.underline) yield "<u/>";
    yield `<sz val="${font.size || 11}"/>`;
    if (font.color) yield `<color rgb="${font.color}"/>`;
    yield '<name val="Calibri"/><family val="2"/><scheme val="minor"/></font>';
  }
  yield "</fonts>";
  yield `<fills count="${styles.fills.length}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`;
  for (let i = 2; i < styles.fills.length; ++i) yield `<fill><patternFill patternType="solid"><fgColor rgb="${styles.fills[i]?.color}"/><bgColor indexed="64"/></patternFill></fill>`;
  yield "</fills>";
  yield '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"><alignment vertical="center"/></xf></cellStyleXfs>';
  yield `<cellXfs count="${styles.cellFormats.length}">`;
  for (const format of styles.cellFormats) {
    const alignment = styles.alignments[format.alignmentId];
    let attributes = `numFmtId="${format.numberFormatId}" fontId="${format.fontId}" fillId="${format.fillId}" borderId="0" xfId="0"`;
    if (format.numberFormatId) attributes += ' applyNumberFormat="1"';
    if (format.fontId) attributes += ' applyFont="1"';
    if (format.fillId) attributes += ' applyFill="1"';
    if (alignment) attributes += ' applyAlignment="1"';
    // The grid centres text vertically in its rows; Excel's default is the bottom.
    if (!alignment) { yield `<xf ${attributes} applyAlignment="1"><alignment vertical="center"/></xf>`; continue; }
    const alignmentAttributes = ['vertical="center"'];
    if (alignment.horizontal) alignmentAttributes.push(`horizontal="${alignment.horizontal}"`);
    if (alignment.wrap) alignmentAttributes.push('wrapText="1"');
    yield `<xf ${attributes}><alignment ${alignmentAttributes.join(" ")}/></xf>`;
  }
  yield '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
}
function contentTypes(sheets: PreparedSheet[], parts: { drawings: number; charts: number }): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">';
  xml += '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>';
  xml += '<Default Extension="xml" ContentType="application/xml"/>';
  xml += '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';
  xml += '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
  for (let i = 1; i <= sheets.length; ++i) xml += `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  for (let i = 1; i <= parts.drawings; ++i) xml += `<Override PartName="/xl/drawings/drawing${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`;
  for (let i = 1; i <= parts.charts; ++i) xml += `<Override PartName="/xl/charts/chart${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`;
  return xml + "</Types>";
}
function workbookXml(sheets: PreparedSheet[]): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${XL_MAIN_NS}" xmlns:r="${XL_REL_NS}">`;
  xml += "<bookViews><workbookView/></bookViews><sheets>";
  for (let i = 0; i < sheets.length; ++i) xml += `<sheet name="${spreadsheetXml(sheets[i].name, true)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`;
  xml += "</sheets>";
  // Excel records each sheet's filter range under this reserved hidden name.
  const filtered = sheets.filter((sheet) => sheet.filter);
  if (filtered.length) {
    xml += "<definedNames>";
    for (const sheet of filtered) xml += `<definedName name="_xlnm._FilterDatabase" localSheetId="${sheets.indexOf(sheet)}" hidden="1">${plainXml(sheet.filter?.definedName)}</definedName>`;
    xml += "</definedNames>";
  }
  // Excel recalculates every formula on open; the cached results are for viewers that don't.
  return xml + '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>';
}
function workbookRelationships(sheetCount: number): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${XL_PACKAGE_REL_NS}">`;
  for (let i = 1; i <= sheetCount; ++i) xml += `<Relationship Id="rId${i}" Type="${XL_REL_NS}/worksheet" Target="worksheets/sheet${i}.xml"/>`;
  return xml + `<Relationship Id="rId${sheetCount + 1}" Type="${XL_REL_NS}/styles" Target="styles.xml"/></Relationships>`;
}
function sheetParts(sheet: PreparedSheet, index: number, formulaNames: Map<string, string>, evaluator: ExportEvaluator): ZipEntry[] {
  const entries: ZipEntry[] = [{ name: `xl/worksheets/sheet${index + 1}.xml`, data: textStream(worksheetXml(sheet, formulaNames, evaluator)) }];
  if (sheet.hyperlinks.length || sheet.drawing) entries.push({ name: `xl/worksheets/_rels/sheet${index + 1}.xml.rels`, data: worksheetRelationships(sheet) });
  if (sheet.drawing) {
    entries.push({ name: `xl/drawings/drawing${sheet.drawing.index}.xml`, data: drawingXml(sheet.drawing) });
    entries.push({ name: `xl/drawings/_rels/drawing${sheet.drawing.index}.xml.rels`, data: drawingRelationships(sheet.drawing) });
    for (const chart of sheet.drawing.charts) entries.push({ name: `xl/charts/chart${chart.index}.xml`, data: chartXml(chart, sheet.name) });
  }
  return entries;
}
// Streams a workbook read by loadExportWorkbook as an XLSX file.
export function workbookToXlsx(workbook: ExportWorkbook, evaluator: ExportEvaluator): ReadableStream<Uint8Array> {
  const { sheets, styles, formulaNames, parts } = prepareWorkbook(workbook, evaluator);
  return createZip([
    { name: "[Content_Types].xml", data: contentTypes(sheets, parts) },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${XL_PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${XL_REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: workbookXml(sheets) },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRelationships(sheets.length) },
    { name: "xl/styles.xml", data: textStream(stylesXml(styles)) },
    ...sheets.flatMap((sheet, i) => sheetParts(sheet, i, formulaNames, evaluator)),
  ]);
}

