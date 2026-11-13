import type { CSSProperties } from "react";
import type {
  SheetBorderEdge, SheetCell, SheetCellStyle, SheetFont,
} from "@gadgets/office-content/xlsx-sheets";
import { fontStack } from "./slideStyles";

/**
 * A sheet is a document, and Excel draws it as paper whatever the app's theme: white cells, black
 * text, pale gridlines, blue links. These are that document's own colours, not the app's chrome.
 */
export const SHEET_PAPER = "#FFFFFF";
export const SHEET_INK = "#000000";
export const SHEET_GRIDLINE = "#E1E1E1";
export const SHEET_LINK = "#0563C1";

/** The room Excel leaves between a cell's edge and its text, and the width of one indent level. */
export const CELL_PADDING = 3;
export const CELL_INDENT = 9;

const fontPixels = (font: SheetFont) => (font.size * 96) / 72;

/** The CSS for a cell's font. */
export const fontCss = (font: SheetFont): CSSProperties => ({
  fontFamily: fontStack(font.name),
  fontSize: fontPixels(font),
  lineHeight: 1.2,
  fontWeight: font.bold ? 700 : 400,
  fontStyle: font.italic ? "italic" : "normal",
});

/** The CSS `text-decoration` for a font's underline and strikethrough, with a link's underline if `link`. */
export const textDecoration = (font: SheetFont, link: boolean): string | undefined => {
  const lines = [
    font.underline !== "none" || link ? "underline" : "",
    font.strike ? "line-through" : "",
  ].filter(Boolean);
  if (lines.length === 0) return undefined;
  return font.underline === "double" ? `${lines.join(" ")} double` : lines.join(" ");
};

let measurer: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

/**
 * How wide `text` is in `font`, in pixels, to tell whether it fits its cell. Measured on a canvas
 * rather than in the page, so drawing a row never forces layout; a font that loads later is not
 * measured again.
 */
export const textWidth = (text: string, font: SheetFont): number => {
  measurer ??= document.createElement("canvas").getContext("2d");
  if (!measurer) return 0;
  const css = `${font.italic ? "italic " : ""}${font.bold ? "700" : "400"} ${fontPixels(font)}px ${fontStack(font.name)}`;
  const key = `${css}\n${text}`;
  let width = widths.get(key);
  if (width === undefined) {
    // A sheet's worth of distinct strings is plenty to remember; past that, start over.
    if (widths.size > 20_000) widths.clear();
    measurer.font = css;
    widths.set(key, width = measurer.measureText(text).width);
  }
  return width;
};

/** Where a cell's content sits across its width. */
export type CellAlignment = "left" | "center" | "right" | "justify";

/** A cell's horizontal alignment; Excel's `general` goes by the value: text left, numbers and dates right, the rest centred. */
export const cellAlignment = (style: SheetCellStyle, kind: SheetCell["kind"]): CellAlignment => {
  switch (style.horizontal) {
    case "left":
    case "right":
    case "center":
    case "justify":
      return style.horizontal;
    case "centerContinuous":
    case "distributed":
      return "center";
    case "fill":
      return "left";
    case "general":
      return kind === "text" ? "left" : kind === "number" || kind === "date" ? "right" : "center";
  }
};

const BORDER_WIDTHS: Partial<Record<SheetBorderEdge["style"], number>> = {
  medium: 2, mediumDashed: 2, mediumDashDot: 2, mediumDashDotDot: 2, slantDashDot: 2, thick: 3, double: 3,
};

/** How many pixels of a cell a border edge takes; a gridline or no edge at all takes one. */
export const borderWidth = (edge: SheetBorderEdge | undefined): number =>
  edge ? BORDER_WIDTHS[edge.style] ?? 1 : 1;

/** A border edge as a CSS border. CSS has no dash-dot lines, which are drawn dashed. */
export const borderCss = (edge: SheetBorderEdge): string => {
  const line = edge.style === "double" ? "double"
    : edge.style === "dotted" || edge.style === "hair" ? "dotted"
    : edge.style === "thin" || edge.style === "medium" || edge.style === "thick" ? "solid"
    : "dashed";
  return `${borderWidth(edge)}px ${line} ${edge.color}`;
};

/**
 * The address a hyperlink may open, or undefined. A sheet can link anywhere, and only web and
 * mail addresses are safe to hand to the browser from a file someone sent.
 */
export const safeHref = (target: string | undefined): string | undefined => {
  if (!target || !/^(https?:|mailto:)/i.test(target)) return undefined;
  try {
    const { protocol, href } = new URL(target);
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:" ? href : undefined;
  } catch {
    return undefined;
  }
};
