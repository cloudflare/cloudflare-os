// SpreadsheetML cell styles, resolved to plain values: fonts, fills, borders and alignment with
// their colours worked out from the theme, the legacy palette and tints, and the number format
// each style formats its values with.

import { findRelationship, readPart, type Relationships } from "./ooxml";
import { attribute, childElements, firstChild, type XmlElement } from "./xml";
import { builtInFormatCode, INDEXED_COLORS, parseNumberFormat, type NumberFormat } from "./xlsx-sheet-format";
import { isTrue } from "./xlsx-sheet-strings";
import type { ZipArchive } from "./zip";
import { lookupTable } from "./lookup-table";

/** A cell's font. */
export interface SheetFont {
  /** The typeface as the file names it, such as `Calibri`. */
  readonly name: string;
  /** In points. */
  readonly size: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: "none" | "single" | "double";
  readonly strike: boolean;
  /** `#RRGGBB`; absent for the automatic colour, which is black on paper. */
  readonly color?: string;
}

/** The line styles a cell border can have (ST_BorderStyle without `none`). */
export type SheetBorderStyle =
  | "thin" | "medium" | "thick" | "dashed" | "dotted" | "double" | "hair" | "mediumDashed"
  | "dashDot" | "mediumDashDot" | "dashDotDot" | "mediumDashDotDot" | "slantDashDot";

/** One edge of a cell's border. */
export interface SheetBorderEdge {
  readonly style: SheetBorderStyle;
  /** `#RRGGBB`. */
  readonly color: string;
}

/** A cell's border; an absent edge has none. */
export interface SheetBorders {
  readonly top?: SheetBorderEdge;
  readonly right?: SheetBorderEdge;
  readonly bottom?: SheetBorderEdge;
  readonly left?: SheetBorderEdge;
}

/** How a cell's content sits across its width. `general` goes by the value: text left, numbers right. */
export type SheetHorizontalAlignment =
  | "general" | "left" | "center" | "right" | "fill" | "justify" | "centerContinuous" | "distributed";

/** How a cell's content sits across its height. */
export type SheetVerticalAlignment = "top" | "center" | "bottom" | "justify" | "distributed";

/** Everything about how a cell looks apart from its value. */
export interface SheetCellStyle {
  readonly font: SheetFont;
  /** The background as `#RRGGBB`; absent for no fill. A pattern is given as its average colour. */
  readonly fill?: string;
  readonly borders: SheetBorders;
  readonly horizontal: SheetHorizontalAlignment;
  readonly vertical: SheetVerticalAlignment;
  readonly wrap: boolean;
  /** Indent levels, each about three spaces wide. */
  readonly indent: number;
}

/** A workbook's cell styles. */
export interface WorkbookStyles {
  /** The distinct styles; entry 0 is the workbook's default. */
  readonly styles: readonly SheetCellStyle[];
  /** For each cell format (a cell's `s`), its entry in `styles` and its number format. */
  readonly formats: readonly { readonly style: number; readonly numberFormat: NumberFormat }[];
  /** The font of the Normal style, which column widths are measured in. */
  readonly defaultFont: SheetFont;
}

/** The colours of the Office theme, in `theme` index order, for a workbook with no theme part. */
const DEFAULT_THEME = ["#FFFFFF", "#000000", "#EEECE1", "#1F497D", "#4F81BD", "#C0504D", "#9BBB59", "#8064A2", "#4BACC6", "#F79646", "#0000FF", "#800080"];

/**
 * The theme's colours in the order a `theme` index counts them, which swaps each light and dark
 * pair of the scheme's own order (dk1, lt1, dk2, lt2, ...): index 0 is lt1 and 1 is dk1.
 */
export async function readThemeColors(zip: ZipArchive, relationships: Relationships): Promise<string[]> {
  const part = findRelationship(relationships, "theme")?.target;
  const theme = part ? await readPart(zip, part) : undefined;
  const scheme = firstChild(firstChild(theme, "a:themeElements"), "a:clrScheme");
  const colors = [...DEFAULT_THEME];
  for (const [index, name] of ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"].entries()) {
    const entry = firstChild(scheme, `a:${name}`);
    const value = attribute(firstChild(entry, "a:srgbClr"), "val") ?? attribute(firstChild(entry, "a:sysClr"), "lastClr");
    if (value && /^[0-9a-f]{6}$/i.test(value)) colors[index] = `#${value.toUpperCase()}`;
  }
  return colors;
}

/**
 * Lightens (tint above 0) or darkens (below) a colour by moving its HSL lightness toward white or
 * black, which is how Excel applies a theme colour's `tint`.
 */
export function applyTint(color: string, tint: number): string {
  if (!tint || !Number.isFinite(tint)) return color;
  const [red, green, blue] = [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16) / 255) as [number, number, number];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const chroma = max - min;
  const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (chroma !== 0) {
    if (max === red) hue = ((green - blue) / chroma) % 6;
    else if (max === green) hue = (blue - red) / chroma + 2;
    else hue = (red - green) / chroma + 4;
  }
  const amount = Math.max(-1, Math.min(1, tint));
  const tinted = amount < 0 ? lightness * (1 + amount) : lightness * (1 - amount) + amount;
  const newChroma = (1 - Math.abs(2 * tinted - 1)) * saturation;
  const second = newChroma * (1 - Math.abs((((hue % 6) + 6) % 2) - 1));
  const sector = Math.floor(((hue % 6) + 6) % 6);
  const [r, g, b] = [
    [newChroma, second, 0], [second, newChroma, 0], [0, newChroma, second],
    [0, second, newChroma], [second, 0, newChroma], [newChroma, 0, second],
  ][sector] as [number, number, number];
  const base = tinted - newChroma / 2;
  return toHex((r + base) * 255, (g + base) * 255, (b + base) * 255);
}

function toHex(...channels: number[]): string {
  return "#" + channels.map(channel => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0")).join("").toUpperCase();
}

interface Palette {
  readonly theme: readonly string[];
  readonly indexed: readonly string[];
}

/** A CT_Color as `#RRGGBB`, or undefined when it is automatic or cannot be resolved. */
function resolveColor(element: XmlElement | undefined, palette: Palette): string | undefined {
  if (!element) return undefined;
  const tint = Number(attribute(element, "tint") ?? 0);
  const rgb = attribute(element, "rgb");
  // `rgb` is AARRGGBB; the alpha is ignored, as Excel ignores it.
  if (rgb && /^[0-9a-f]{6,8}$/i.test(rgb)) return applyTint(`#${rgb.slice(-6).toUpperCase()}`, tint);
  const theme = attribute(element, "theme");
  if (theme !== undefined) {
    const color = palette.theme[Number(theme)];
    return color && applyTint(color, tint);
  }
  const indexed = attribute(element, "indexed");
  // 64 and 65 are the system's foreground and background, which are the automatic colours.
  if (indexed !== undefined) {
    const color = palette.indexed[Number(indexed)];
    return color && applyTint(color, tint);
  }
  return undefined;
}

const FALLBACK_FONT: SheetFont = { name: "Calibri", size: 11, bold: false, italic: false, underline: "none", strike: false };

/** ST_OnOff on a font property: `<b/>` is on unless its `val` says otherwise. */
const MAX_FONT_NAME = 64;

function fontFlag(font: XmlElement, name: string): boolean {
  const element = firstChild(font, name);
  if (!element) return false;
  const value = attribute(element, "val");
  return value === undefined || isTrue(value);
}

function readFont(font: XmlElement, palette: Palette, base: SheetFont): SheetFont {
  const size = Number(attribute(firstChild(font, "s:sz"), "val"));
  const underline = firstChild(font, "s:u");
  const underlineStyle = underline ? attribute(underline, "val") ?? "single" : "none";
  const color = resolveColor(firstChild(font, "s:color"), palette);
  return {
    // A font that names no typeface or size takes the default font's, as Excel does.
    // Excel's own font names are at most 31 characters. Every distinct style repeats its font's
    // name in the key it is shared by, so a longer one would be copied once per style.
    name: attribute(firstChild(font, "s:name"), "val")?.slice(0, MAX_FONT_NAME) || base.name,
    size: size >= 1 && size <= 409 ? size : base.size,
    bold: fontFlag(font, "s:b"),
    italic: fontFlag(font, "s:i"),
    underline: underlineStyle === "none" ? "none" : underlineStyle.startsWith("double") ? "double" : "single",
    strike: fontFlag(font, "s:strike"),
    ...(color ? { color } : {}),
  };
}

/** How much of a pattern's area its foreground colour covers. */
const PATTERN_DENSITY: Readonly<Record<string, number>> = lookupTable({
  darkGray: 0.75, mediumGray: 0.5, lightGray: 0.25, gray125: 0.125, gray0625: 0.0625,
  darkHorizontal: 0.5, darkVertical: 0.5, darkDown: 0.5, darkUp: 0.5, darkGrid: 0.75, darkTrellis: 0.75,
  lightHorizontal: 0.25, lightVertical: 0.25, lightDown: 0.25, lightUp: 0.25, lightGrid: 0.4, lightTrellis: 0.5,
});

function channelAt(color: string, at: number): number {
  return parseInt(color.slice(at, at + 2), 16);
}

function mix(foreground: string, background: string, share: number): string {
  return toHex(...[1, 3, 5].map(at => channelAt(foreground, at) * share + channelAt(background, at) * (1 - share)));
}

function readFill(fill: XmlElement, palette: Palette): string | undefined {
  const gradient = firstChild(fill, "s:gradientFill");
  if (gradient) return resolveColor(firstChild(childElements(gradient, "s:stop")[0], "s:color"), palette);
  const pattern = firstChild(fill, "s:patternFill");
  const type = attribute(pattern, "patternType") ?? "none";
  if (type === "none") return undefined;
  const foreground = resolveColor(firstChild(pattern, "s:fgColor"), palette);
  if (type === "solid") return foreground;
  // A hatch or dot pattern is drawn as the colour it averages to.
  return mix(foreground ?? "#000000", resolveColor(firstChild(pattern, "s:bgColor"), palette) ?? "#FFFFFF", PATTERN_DENSITY[type] ?? 0.5);
}

const BORDER_STYLES: ReadonlySet<string> = new Set<SheetBorderStyle>([
  "thin", "medium", "thick", "dashed", "dotted", "double", "hair", "mediumDashed",
  "dashDot", "mediumDashDot", "dashDotDot", "mediumDashDotDot", "slantDashDot",
]);

function isBorderStyle(style: string | undefined): style is SheetBorderStyle {
  return style !== undefined && BORDER_STYLES.has(style);
}

function readBorders(border: XmlElement, palette: Palette): SheetBorders {
  const edge = (...names: string[]): SheetBorderEdge | undefined => {
    for (const name of names) {
      const element = firstChild(border, name);
      const style = attribute(element, "style");
      if (isBorderStyle(style)) return { style, color: resolveColor(firstChild(element, "s:color"), palette) ?? "#000000" };
    }
    return undefined;
  };
  const edges = {
    top: edge("s:top"),
    // Strict files name the side edges by reading direction.
    right: edge("s:right", "s:end"),
    bottom: edge("s:bottom"),
    left: edge("s:left", "s:start"),
  };
  return Object.fromEntries(Object.entries(edges).filter(([, value]) => value));
}

const HORIZONTAL: ReadonlySet<string> = new Set<SheetHorizontalAlignment>(["general", "left", "center", "right", "fill", "justify", "centerContinuous", "distributed"]);
const VERTICAL: ReadonlySet<string> = new Set<SheetVerticalAlignment>(["top", "center", "bottom", "justify", "distributed"]);

function isHorizontal(value: string | undefined): value is SheetHorizontalAlignment {
  return value !== undefined && HORIZONTAL.has(value);
}

function isVertical(value: string | undefined): value is SheetVerticalAlignment {
  return value !== undefined && VERTICAL.has(value);
}

/**
 * Reads styles.xml. Each cell format (`cellXfs/xf`) is resolved to a style, and equal styles are
 * shared, so a workbook with thousands of formats that differ only in number format has few
 * styles.
 */
export async function readStyles(zip: ZipArchive, relationships: Relationships): Promise<WorkbookStyles> {
  const part = findRelationship(relationships, "styles")?.target;
  const sheet = part ? await readPart(zip, part) : undefined;
  const custom = childElements(firstChild(firstChild(sheet, "s:colors"), "s:indexedColors"), "s:rgbColor")
    .map(color => attribute(color, "rgb"))
    .map((rgb, index) => rgb && /^[0-9a-f]{6,8}$/i.test(rgb) ? `#${rgb.slice(-6).toUpperCase()}` : INDEXED_COLORS[index] ?? "#000000");
  const palette: Palette = {
    theme: await readThemeColors(zip, relationships),
    indexed: custom.length > 0 ? custom : INDEXED_COLORS,
  };

  const fontElements = childElements(firstChild(sheet, "s:fonts"), "s:font");
  const defaultFont = fontElements[0] ? readFont(fontElements[0], palette, FALLBACK_FONT) : FALLBACK_FONT;
  const fonts = fontElements.map(font => readFont(font, palette, defaultFont));
  const fills = childElements(firstChild(sheet, "s:fills"), "s:fill").map(fill => readFill(fill, palette));
  const borders = childElements(firstChild(sheet, "s:borders"), "s:border").map(border => readBorders(border, palette));

  const codes = new Map<number, string>();
  for (const format of childElements(firstChild(sheet, "s:numFmts"), "s:numFmt")) {
    codes.set(Number(attribute(format, "numFmtId")), attribute(format, "formatCode") ?? "");
  }
  const parsed = new Map<string, NumberFormat>();
  const numberFormat = (id: number): NumberFormat => {
    const code = codes.get(id) ?? builtInFormatCode(id);
    let format = parsed.get(code);
    if (!format) parsed.set(code, format = parseNumberFormat(code));
    return format;
  };

  const styles: SheetCellStyle[] = [];
  const indexes = new Map<string, number>();
  const intern = (style: SheetCellStyle): number => {
    const key = JSON.stringify(style);
    let index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, index = styles.length);
      styles.push(style);
    }
    return index;
  };
  const base: SheetCellStyle = { font: defaultFont, borders: {}, horizontal: "general", vertical: "bottom", wrap: false, indent: 0 };
  const formats = childElements(firstChild(sheet, "s:cellXfs"), "s:xf").map(xf => {
    const alignment = firstChild(xf, "s:alignment");
    const horizontal = attribute(alignment, "horizontal");
    const vertical = attribute(alignment, "vertical");
    const indent = Number(attribute(alignment, "indent") ?? 0);
    const fill = fills[Number(attribute(xf, "fillId") ?? 0)];
    return {
      style: intern({
        font: fonts[Number(attribute(xf, "fontId") ?? 0)] ?? defaultFont,
        ...(fill ? { fill } : {}),
        borders: borders[Number(attribute(xf, "borderId") ?? 0)] ?? {},
        horizontal: isHorizontal(horizontal) ? horizontal : "general",
        vertical: isVertical(vertical) ? vertical : "bottom",
        wrap: isTrue(attribute(alignment, "wrapText")),
        indent: indent > 0 && indent <= 250 ? Math.floor(indent) : 0,
      }),
      numberFormat: numberFormat(Number(attribute(xf, "numFmtId") ?? 0)),
    };
  });
  // A workbook with no styles part still has the default style.
  if (formats.length === 0) formats.push({ style: intern(base), numberFormat: numberFormat(0) });
  return { styles, formats, defaultFont };
}

/** The width of a digit as a share of the font size, for the faces workbooks most often use. */
const DIGIT_WIDTH_EM: Readonly<Record<string, number>> = lookupTable({
  calibri: 0.507, "aptos narrow": 0.5, aptos: 0.56, arial: 0.556, helvetica: 0.556, "times new roman": 0.5,
  "courier new": 0.6, verdana: 0.636, tahoma: 0.546, cambria: 0.55, "segoe ui": 0.539, "liberation sans": 0.556,
});

/**
 * The pixel width of the widest digit in the workbook's default font at 96 DPI, which is the
 * unit column widths are stored in: 7 for Calibri 11. Taken from a table of digit widths rather
 * than measured, since no font is at hand here.
 */
export function maxDigitWidth(font: SheetFont): number {
  const em = DIGIT_WIDTH_EM[font.name.toLowerCase()] ?? 0.53;
  return Math.max(1, Math.floor(em * font.size * 96 / 72));
}
