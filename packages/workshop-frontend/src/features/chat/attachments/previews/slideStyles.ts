import type { CSSProperties } from "react";
import type { SlideColor, SlideFill, SlideOutline } from "@gadgets/office-content/pptx-slides";
import "./slideFonts.css";

/** A slide color as CSS. */
export const cssColor = ({ hex, alpha }: SlideColor): string => {
  if (alpha >= 1) return `#${hex}`;
  const channel = (at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
  return `rgb(${channel(0)} ${channel(2)} ${channel(4)} / ${alpha})`;
};

/** A solid or gradient fill as a CSS background. Picture fills are drawn as images instead. */
export const fillBackground = (fill: SlideFill | undefined): string | undefined => {
  if (!fill || fill.kind === "image") return undefined;
  if (fill.kind === "solid") return cssColor(fill.color);
  const stops = fill.stops.map((stop) => `${cssColor(stop.color)} ${stop.position * 100}%`);
  // A lone stop is not a valid gradient; DrawingML angles start at "left to right", CSS's at "to top".
  if (stops.length === 1) return cssColor(fill.stops[0].color);
  return `linear-gradient(${fill.angle + 90}deg, ${stops.join(", ")})`;
};

/** An outline's SVG stroke attributes. */
export const strokeProps = (outline: SlideOutline) => ({
  stroke: cssColor(outline.color),
  strokeWidth: outline.width,
  strokeDasharray: outline.dash === "dash"
    ? `${outline.width * 4} ${outline.width * 3}`
    : outline.dash === "dot" ? `${outline.width} ${outline.width}` : undefined,
});

/** An outline as a CSS border, for table cells. */
export const cssBorder = (outline: SlideOutline | undefined): string | undefined =>
  outline && `${outline.width}px ${outline.dash === "solid" ? "solid" : outline.dash === "dot" ? "dotted" : "dashed"} ${cssColor(outline.color)}`;

type FontFace = {
  /** The fonts to try after the named one, metric-compatible substitutes first. */
  fallbacks: string;
};

const SANS = '"Helvetica Neue", Arial, sans-serif';
/** Calibri, its metric-compatible twin, then the scaled stand-in `slideFonts.css` defines. */
const CALIBRI = `Carlito, "Slide Calibri Substitute", ${SANS}`;

/**
 * Office's common fonts. Fonts are neither bundled nor downloaded, so a machine without one draws
 * its text in a substitute: Carlito, Caladea, the Liberation fonts and the Calibri stand-in match
 * the originals' widths, and the rest only approximate them, so lines may break in different
 * places than in PowerPoint.
 */
const FONTS: Record<string, FontFace> = {
  calibri: { fallbacks: CALIBRI },
  "calibri light": { fallbacks: `Calibri, ${CALIBRI}` },
  aptos: { fallbacks: `Calibri, Carlito, ${SANS}` },
  "aptos display": { fallbacks: `Aptos, Calibri, Carlito, ${SANS}` },
  cambria: { fallbacks: "Caladea, Georgia, serif" },
  arial: { fallbacks: '"Liberation Sans", Helvetica, sans-serif' },
  helvetica: { fallbacks: 'Arial, "Liberation Sans", sans-serif' },
  "times new roman": { fallbacks: '"Liberation Serif", Times, serif' },
  "courier new": { fallbacks: '"Liberation Mono", Courier, monospace' },
  consolas: { fallbacks: 'Menlo, "Liberation Mono", monospace' },
  georgia: { fallbacks: "serif" },
  verdana: { fallbacks: '"DejaVu Sans", sans-serif' },
  tahoma: { fallbacks: "Verdana, sans-serif" },
  "trebuchet ms": { fallbacks: "sans-serif" },
  "segoe ui": { fallbacks: `system-ui, ${SANS}` },
};

const UNKNOWN_FONT: FontFace = { fallbacks: SANS };

const fontFace = (name: string): FontFace => {
  const known = FONTS[name.trim().toLowerCase()];
  if (known) return known;
  if (/courier|mono|consol/i.test(name)) return { fallbacks: "monospace" };
  if (/serif|times|roman|garamond|georgia|palatino|book/i.test(name) && !/sans/i.test(name)) {
    return { fallbacks: "Georgia, serif" };
  }
  return UNKNOWN_FONT;
};

/** The CSS font stack for an Office typeface name. */
export const fontStack = (name: string): string =>
  // The name is the file's; anything that could end the quoted family is dropped.
  `"${name.replace(/["\\;{}<>\p{Cc}]/gu, "")}", ${fontFace(name).fallbacks}`;

/**
 * PowerPoint's single line spacing as a multiple of the font size. It is the same for every font,
 * rather than each font's own line height: measured against Microsoft 365's renderings.
 */
export const SINGLE_LINE_HEIGHT = 1.2;

/** Positions a slide element at its bounds, turned about its center. */
export const boundsStyle = (bounds: {
  x: number; y: number; width: number; height: number; rotation: number;
}): CSSProperties => ({
  position: "absolute",
  left: bounds.x,
  top: bounds.y,
  width: bounds.width,
  height: bounds.height,
  transform: bounds.rotation ? `rotate(${bounds.rotation}deg)` : undefined,
});
