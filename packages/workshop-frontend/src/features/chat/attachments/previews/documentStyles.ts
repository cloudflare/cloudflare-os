import type { CSSProperties } from "react";
import type { DocxBorder, DocxLineSpacing, DocxRunProperties } from "@gadgets/office-content/docx-document";

/** CSS pixels per point, for measurements read back from the DOM. */
export const PX_PER_PT = 96 / 72;

/** A length from the file, which is in points. */
export const pt = (points: number): string => `${Math.round(points * 100) / 100}pt`;

/**
 * Office's fonts, each followed by the free font drawn to the same metrics and then by whatever
 * the system has. No font is bundled or downloaded, so on a machine with neither the Office font
 * nor its metric twin, lines break in slightly different places than they do in Word.
 */
const FONT_STACKS: Readonly<Record<string, string>> = {
  "aptos": 'Aptos, Calibri, Carlito, "Helvetica Neue", Arial, sans-serif',
  "arial": 'Arial, Arimo, "Liberation Sans", Helvetica, sans-serif',
  "calibri": 'Calibri, Carlito, "Helvetica Neue", Arial, sans-serif',
  "cambria": "Cambria, Caladea, Georgia, serif",
  "consolas": 'Consolas, "Cascadia Mono", Menlo, monospace',
  "courier new": '"Courier New", Cousine, "Liberation Mono", Courier, monospace',
  "georgia": "Georgia, Gelasio, serif",
  "helvetica": 'Helvetica, Arial, Arimo, "Liberation Sans", sans-serif',
  // Word sets its checkboxes in MS Gothic, whose box glyphs fill the line as other Japanese fonts' do.
  "ms gothic": '"MS Gothic", "Hiragino Sans", "Yu Gothic", "Noto Sans CJK JP", "Segoe UI Symbol", sans-serif',
  "segoe ui": '"Segoe UI", system-ui, sans-serif',
  "tahoma": "Tahoma, Verdana, sans-serif",
  "times new roman": '"Times New Roman", Tinos, "Liberation Serif", Times, serif',
  "verdana": 'Verdana, "DejaVu Sans", sans-serif',
};

const genericFamily = (name: string): string => {
  if (/mono|courier|consol|code|typewriter/.test(name)) return "monospace";
  if (/times|georgia|garamond|cambria|book|palatino|serif|minion|roman|century|baskerville|caslon|didot/.test(name)
    && !/sans/.test(name)) return "serif";
  return "sans-serif";
};

/** Weights that Office lists as fonts of their own ("Calibri Light"), which CSS asks for by number. */
const WEIGHT_SUFFIXES: Readonly<Record<string, number>> = {
  thin: 100, light: 300, semilight: 350, medium: 500, semibold: 600, demibold: 600, black: 900, heavy: 900,
};

/**
 * A font name from the file as its family and the weight its name asks for, if any. The name is
 * the file's, so it is stripped of what could end a CSS string and always quoted.
 */
const fontFace = (font: string): { name: string; family: string; weight: number | undefined } => {
  const name = font.replace(/["\\\p{Cc}]/gu, "").trim();
  const suffix = /^(.+) (\w+)$/.exec(name);
  const weight = suffix ? WEIGHT_SUFFIXES[suffix[2]!.toLowerCase()] : undefined;
  return { name, family: weight === undefined ? name : suffix![1]!, weight };
};

/** The CSS font stack for a font the file names. */
export const fontStack = (font: string): string => {
  const { name, family } = fontFace(font);
  const key = family.toLowerCase();
  const stack = FONT_STACKS[key] ?? `"${family}", ${genericFamily(key)}`;
  return name === family ? stack : `"${name}", ${stack}`;
};

/**
 * Each font's own line height as a multiple of its size (ascent, descent and line gap), which is
 * what Word's "single" spacing means. CSS has no way to ask for a multiple of it, so the ones
 * documents commonly use are listed.
 */
const NATURAL_LINE_HEIGHT: Readonly<Record<string, number>> = {
  "aptos": 1.22,
  "arial": 1.15,
  "calibri": 1.2207,
  "cambria": 1.1724,
  "candara": 1.2207,
  "consolas": 1.1709,
  "constantia": 1.2207,
  "corbel": 1.2207,
  "courier new": 1.1328,
  "georgia": 1.1362,
  "helvetica": 1.15,
  "segoe ui": 1.3301,
  "tahoma": 1.207,
  "times new roman": 1.15,
  "trebuchet ms": 1.1611,
  "verdana": 1.2153,
};
const DEFAULT_NATURAL_LINE_HEIGHT = 1.2;

/** The height of a line of `run` in a paragraph spaced by `spacing`, in points. */
const lineHeight = (run: DocxRunProperties, spacing: DocxLineSpacing): number => {
  const natural = run.size * (NATURAL_LINE_HEIGHT[fontFace(run.font).family.toLowerCase()] ?? DEFAULT_NATURAL_LINE_HEIGHT);
  if (spacing.rule === "exact") return spacing.value;
  return spacing.rule === "auto" ? natural * spacing.value : Math.max(natural, spacing.value);
};

/** How Word sizes superscript and subscript text against the text around it. */
const SCRIPT_SCALE = 0.65;

/** A run's formatting as CSS. Every value is data from the file, which is why it is an inline style. */
export const runStyle = (run: DocxRunProperties, spacing: DocxLineSpacing): CSSProperties => {
  const script = run.verticalAlign !== "baseline";
  const decoration = [run.underline && "underline", run.strike && "line-through"].filter(Boolean).join(" ");
  return {
    fontFamily: fontStack(run.font),
    fontSize: pt(script ? run.size * SCRIPT_SCALE : run.size),
    // A raised or lowered run would otherwise push its line taller than the lines around it.
    lineHeight: script ? 0 : pt(lineHeight(run, spacing)),
    fontWeight: run.bold ? 700 : fontFace(run.font).weight ?? 400,
    fontStyle: run.italic ? "italic" : "normal",
    color: run.color,
    backgroundColor: run.highlight ?? run.shading,
    textDecorationLine: decoration || "none",
    textDecorationStyle: run.underline === "single" || !run.underline ? undefined : run.underline,
    textDecorationColor: run.underline ? run.underlineColor : undefined,
    verticalAlign: run.verticalAlign === "superscript" ? "super" : run.verticalAlign === "subscript" ? "sub" : undefined,
    textTransform: run.caps ? "uppercase" : undefined,
    fontVariantCaps: run.smallCaps ? "small-caps" : undefined,
    letterSpacing: run.letterSpacing ? pt(run.letterSpacing) : undefined,
  };
};

/** A border from the file as a CSS border shorthand. */
export const borderStyle = (border: DocxBorder | undefined): string | undefined =>
  // A double line needs three times its stroke to show as two.
  border && `${pt(border.style === "double" ? Math.max(border.width * 3, 2.25) : border.width)} ${border.style} ${border.color}`;
