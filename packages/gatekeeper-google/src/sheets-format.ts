/**
 * Cell formatting as Google Sheets stores it, as an agent reads it, and as queued changes set it.
 *
 * Only what a cell has set itself (`userEnteredFormat`) is read, and of that only the fields an
 * agent may read and change: text style and size, text and fill colours, number format,
 * alignment, wrapping and borders. Of a cell, a read asks Google for nothing else: never its value,
 * link or note.
 *
 * Google returns each colour twice: as a colour style, which names a theme colour when one is
 * set, and as the legacy colour, with any theme colour resolved. The style is read when there is
 * one. Google stores a component `n / 255` as a 32-bit float and leaves it out when it is 0, so a
 * component reads as `round(component * 255)`, and a missing one as 0.
 */

import type {
  SheetBorder, SheetBorderStyle, SheetCellFormat, SheetColor, SheetNumberFormat,
} from "./sheets-read-types";
import type { SheetFormatChange } from "./sheets-types";

/** The theme colours a colour may name. */
export const THEME_COLORS: readonly string[] = [
  "TEXT", "BACKGROUND", "ACCENT1", "ACCENT2", "ACCENT3", "ACCENT4", "ACCENT5", "ACCENT6", "LINK",
];

/** The border styles an agent may read and set. */
export const BORDER_STYLES: readonly SheetBorderStyle[] = [
  "SOLID", "SOLID_MEDIUM", "SOLID_THICK", "DOTTED", "DASHED", "DOUBLE",
];

/** The number format types an agent may read and set. */
export const NUMBER_FORMAT_TYPES: readonly SheetNumberFormat["type"][] = [
  "TEXT", "NUMBER", "PERCENT", "CURRENCY", "DATE", "TIME", "DATE_TIME", "SCIENTIFIC",
];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Sheets' `Color`. A component that is 0 is left out. */
export type RestColor = { red?: number; green?: number; blue?: number; alpha?: number };

/** Sheets' `ColorStyle`: an RGB colour, or a theme colour by name. */
export type RestColorStyle = { rgbColor?: RestColor; themeColor?: string };

type RestBorder = { style?: string; color?: RestColor; colorStyle?: RestColorStyle };

/** Sheets' `CellFormat`, as far as the gatekeeper reads it. */
export type RestCellFormat = {
  textFormat?: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    fontSize?: number;
    foregroundColor?: RestColor;
    foregroundColorStyle?: RestColorStyle;
  };
  backgroundColor?: RestColor;
  backgroundColorStyle?: RestColorStyle;
  numberFormat?: { type?: string; pattern?: string };
  horizontalAlignment?: string;
  verticalAlignment?: string;
  wrapStrategy?: string;
  borders?: { top?: RestBorder; bottom?: RestBorder; left?: RestBorder; right?: RestBorder };
};

/** Sheets' `GridData`: the cells of one range, from its first row and column. */
export type RestGridData = {
  startRow?: number;
  startColumn?: number;
  rowData?: { values?: { userEnteredFormat?: RestCellFormat }[] }[];
};

/** One sheet of a `spreadsheets.get` or `spreadsheets:getByDataFilter` answer with grid data. */
export type RestFormatSheet = {
  properties?: {
    sheetId?: number;
    title?: string;
    index?: number;
    hidden?: boolean;
    gridProperties?: { rowCount?: number; columnCount?: number };
  };
  data?: RestGridData[];
};

const BORDER_FIELDS = "style,color,colorStyle";

/** The fields of a cell a format read asks for: what the cell has set of what an agent may read. */
export const CELL_FORMAT_FIELDS =
  "userEnteredFormat(" +
  "textFormat(bold,italic,underline,strikethrough,fontSize,foregroundColor,foregroundColorStyle)," +
  "backgroundColor,backgroundColorStyle,numberFormat,horizontalAlignment,verticalAlignment," +
  `wrapStrategy,borders(top(${BORDER_FIELDS}),bottom(${BORDER_FIELDS}),left(${BORDER_FIELDS}),` +
  `right(${BORDER_FIELDS})))`;

/**
 * The field mask of a format read: each sheet's ID, title and size, to name and clip the range
 * read, and each range's position and cells' formats.
 */
export const FORMAT_READ_FIELDS =
  "sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount))," +
  `data(startRow,startColumn,rowData(values(${CELL_FORMAT_FIELDS}))))`;

/** Whether `color` is `#rrggbb` or a theme colour's name. */
export function isSheetColor(color: unknown): color is SheetColor {
  return typeof color === "string" && (HEX_COLOR.test(color) || THEME_COLORS.includes(color));
}

function hexByte(component: number | undefined): string {
  return Math.round(Math.min(Math.max(component ?? 0, 0), 1) * 255).toString(16).padStart(2, "0");
}

function hex(color: RestColor): SheetColor {
  return `#${hexByte(color.red)}${hexByte(color.green)}${hexByte(color.blue)}`;
}

/** A colour as an agent reads it: the style's when there is one, else the legacy colour's. */
export function sheetColor(style?: RestColorStyle, legacy?: RestColor): SheetColor | undefined {
  if (style?.themeColor !== undefined && THEME_COLORS.includes(style.themeColor)) return style.themeColor;
  if (style?.rgbColor) return hex(style.rgbColor);
  return legacy ? hex(legacy) : undefined;
}

/** `color` as Sheets' `ColorStyle`, each RGB component `n / 255`. */
export function colorStyle(color: SheetColor): RestColorStyle {
  if (!HEX_COLOR.test(color)) return { themeColor: color };
  let component = (at: number) => parseInt(color.slice(at, at + 2), 16) / 255;
  return { rgbColor: { red: component(1), green: component(3), blue: component(5) } };
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.find(candidate => candidate === value);
}

// Wrapping as an agent names it. A sheet from before `WRAP` existed may hold `LEGACY_WRAP`, which
// also wraps.
const WRAP: Record<string, SheetCellFormat["wrap"]> = {
  OVERFLOW_CELL: "OVERFLOW", WRAP: "WRAP", LEGACY_WRAP: "WRAP", CLIP: "CLIP",
};

function border(rest: RestBorder | undefined): SheetBorder | undefined {
  let style = oneOf(rest?.style, BORDER_STYLES);
  if (!style) return undefined;
  let color = sheetColor(rest?.colorStyle, rest?.color);
  return { style, ...(color === undefined || color === "#000000" ? {} : { color }) };
}

/**
 * The formatting a cell has set, as an agent reads it, or null when it has none of the fields an
 * agent reads. A border's colour is left out when black.
 */
export function projectFormat(rest: RestCellFormat | undefined): SheetCellFormat | null {
  if (!rest) return null;
  let text = rest.textFormat ?? {};
  let format: SheetCellFormat = {};
  for (let field of ["bold", "italic", "underline", "strikethrough"] as const) {
    let value = text[field];
    if (typeof value === "boolean") format[field] = value;
  }
  if (typeof text.fontSize === "number") format.fontSize = text.fontSize;
  let textColor = sheetColor(text.foregroundColorStyle, text.foregroundColor);
  if (textColor !== undefined) format.textColor = textColor;
  let fillColor = sheetColor(rest.backgroundColorStyle, rest.backgroundColor);
  if (fillColor !== undefined) format.fillColor = fillColor;
  let type = oneOf(rest.numberFormat?.type, NUMBER_FORMAT_TYPES);
  if (type) {
    let pattern = rest.numberFormat?.pattern;
    format.numberFormat = { type, ...(pattern ? { pattern } : {}) };
  }
  let horizontal = oneOf(rest.horizontalAlignment, ["LEFT", "CENTER", "RIGHT"] as const);
  if (horizontal) format.horizontalAlignment = horizontal;
  let vertical = oneOf(rest.verticalAlignment, ["TOP", "MIDDLE", "BOTTOM"] as const);
  if (vertical) format.verticalAlignment = vertical;
  let wrap = rest.wrapStrategy === undefined ? undefined : WRAP[rest.wrapStrategy];
  if (wrap) format.wrap = wrap;
  let borders: NonNullable<SheetCellFormat["borders"]> = {};
  for (let side of ["top", "bottom", "left", "right"] as const) {
    let edge = border(rest.borders?.[side]);
    if (edge) borders[side] = edge;
  }
  if (Object.keys(borders).length > 0) format.borders = borders;
  return Object.keys(format).length > 0 ? format : null;
}

/** Formats of cells of the sheets Google holds, by sheet ID and zero-based row and column. */
export type BaseFormats = (sheetId: number, row: number, column: number) => SheetCellFormat | null;

/** The formats of every cell `sheets`' grid data holds, by cell; any other cell has none. */
export function baseFormats(sheets: readonly RestFormatSheet[]): BaseFormats {
  let cells = new Map<string, SheetCellFormat>();
  for (let sheet of sheets) {
    let sheetId = sheet.properties?.sheetId ?? 0;
    for (let data of sheet.data ?? []) {
      data.rowData?.forEach((row, r) => row.values?.forEach((cell, c) => {
        let format = projectFormat(cell.userEnteredFormat);
        if (format) cells.set(`${sheetId}:${(data.startRow ?? 0) + r}:${(data.startColumn ?? 0) + c}`, format);
      }));
    }
  }
  return (sheetId, row, column) => cells.get(`${sheetId}:${row}:${column}`) ?? null;
}

/** Sheets' `wrapStrategy` for wrapping as an agent names it. */
export function wrapStrategy(wrap: NonNullable<SheetCellFormat["wrap"]>): string {
  return wrap === "OVERFLOW" ? "OVERFLOW_CELL" : wrap;
}

/** A side of a cell's border. */
export type BorderSide = "top" | "bottom" | "left" | "right";

/**
 * What queued changes set on a cell's own formatting, in the order they were queued: each field
 * set, `null` for one reset, and each side of its border drawn, `null` for one removed.
 */
export type FormatEntry = {
  set: Omit<SheetFormatChange, "borders">;
  borders: Partial<Record<BorderSide, SheetBorder | null>>;
};

/** `base`, a cell's formatting, with what `entry` sets on it; null when that leaves none set. */
export function mergeFormat(base: SheetCellFormat | null, entry: FormatEntry | undefined): SheetCellFormat | null {
  if (!entry) return base;
  let format: Record<string, unknown> = { ...base };
  for (let [field, value] of Object.entries(entry.set)) {
    if (value === null) delete format[field];
    else if (value !== undefined) format[field] = value;
  }
  let borders: Record<string, SheetBorder> = { ...base?.borders };
  for (let [side, edge] of Object.entries(entry.borders)) {
    if (edge === null) delete borders[side];
    else if (edge !== undefined) borders[side] = edge;
  }
  if (Object.keys(borders).length > 0) format.borders = borders;
  else delete format.borders;
  return Object.keys(format).length > 0 ? format as SheetCellFormat : null;
}
