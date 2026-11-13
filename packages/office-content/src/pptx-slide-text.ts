// DrawingML text for the slide reader. A run's formatting comes from up to seven places (the run,
// its paragraph, the shape's list style, the layout's and master's placeholders, the master's text
// styles and the presentation defaults), each of which may state any subset of the properties, so
// each source is read into a partial record and the records are overlaid, lowest priority first.

import { isOn } from "./ooxml";
import { BLACK, resolveColor, resolveFont, schemeColor, type ColorContext } from "./pptx-slide-color";
import type { SlideBullet, SlideColor, SlideParagraph, SlideRun, SlideTextBody } from "./pptx-slide-model";
import { attribute, childAt, childElements, firstChild, textContent, type XmlElement } from "./xml";

/** What reading text needs beyond colors. */
export interface TextContext extends ColorContext {
  /** What a slide-number field shows. */
  readonly slideNumber: number;
}

/** Spacing as the file states it: a fraction of the line, or points. */
type Spacing = { readonly percent: number } | { readonly points: number };

/** Run properties one source states. */
export interface RunProps {
  readonly size?: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly color?: SlideColor;
  /** A typeface name or a theme font reference such as `+mn-lt`. */
  readonly font?: string;
  readonly baseline?: number;
  readonly letterSpacing?: number;
  readonly capitals?: boolean;
}

type BulletKind =
  | { readonly kind: "none" }
  | { readonly kind: "character"; readonly character: string }
  | { readonly kind: "number"; readonly scheme: string; readonly startAt: number };

/** Paragraph properties one source states for one level. `null` means "follow the text". */
interface LevelProps {
  readonly align?: SlideParagraph["align"];
  readonly marginLeft?: number;
  readonly indent?: number;
  readonly lineSpacing?: Spacing;
  readonly spaceBefore?: Spacing;
  readonly spaceAfter?: Spacing;
  readonly bullet?: BulletKind;
  readonly bulletFont?: string | null;
  readonly bulletColor?: SlideColor | null;
  readonly bulletSize?: Spacing | null;
  readonly run: RunProps;
}

/** One source's properties for each of the nine outline levels. */
export type ListStyle = readonly (LevelProps | undefined)[];

const LEVELS = 9;
const EMU_PER_POINT = 12700;
/** The size of text nothing sizes. */
const DEFAULT_FONT_SIZE = 18;
/**
 * A typical ratio of line height to font size, for turning spacing stated as a percentage of a
 * line into points without knowing the font's metrics.
 */
const TYPICAL_LINE_HEIGHT = 1.2;

/**
 * Reads `a:lstStyle`, a master's `p:titleStyle`/`p:bodyStyle`/`p:otherStyle`, or the presentation's
 * `p:defaultTextStyle`. `a:defPPr`, where present, underlies every level.
 */
export function readListStyle(element: XmlElement | undefined, context: TextContext): ListStyle {
  if (!element) return [];
  const base = firstChild(element, "a:defPPr");
  const baseProps = base && readLevelProps(base, context);
  return Array.from({ length: LEVELS }, (_, index) => {
    const level = firstChild(element, `a:lvl${index + 1}pPr`);
    const props = level && readLevelProps(level, context);
    return baseProps && props ? mergeLevel(baseProps, props) : props ?? baseProps;
  });
}

/** A list style giving every level the same run properties, as a shape's `a:fontRef` or a table style does. */
export function uniformListStyle(run: RunProps): ListStyle {
  return Array.from({ length: LEVELS }, () => ({ run }));
}

function emu(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number / EMU_PER_POINT : undefined;
}

function integer(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : undefined;
}

/** `a:spcPct` (1000ths of a percent) or `a:spcPts` (100ths of a point) inside `parent`. */
function readSpacing(parent: XmlElement | undefined): Spacing | undefined {
  const percent = integer(attribute(firstChild(parent, "a:spcPct"), "val"));
  if (percent !== undefined) return { percent: percent / 100000 };
  const points = integer(attribute(firstChild(parent, "a:spcPts"), "val"));
  return points === undefined ? undefined : { points: points / 100 };
}

const ALIGNMENTS: Readonly<Record<string, SlideParagraph["align"]>> = {
  l: "left", ctr: "center", r: "right", just: "justify", dist: "justify",
};

/** Drops the properties a source did not state, so overlaying it leaves the lower layer's. */
function stated<T extends object>(props: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/** Reads `a:lvlNpPr`, `a:defPPr` or a paragraph's `a:pPr`, which share one shape. */
function readLevelProps(element: XmlElement, context: TextContext): LevelProps {
  let bullet: BulletKind | undefined;
  let bulletFont: string | null | undefined;
  let bulletColor: SlideColor | null | undefined;
  let bulletSize: Spacing | null | undefined;
  for (const child of childElements(element)) {
    switch (child.name) {
      case "a:buNone": bullet = { kind: "none" }; break;
      case "a:buChar": bullet = { kind: "character", character: attribute(child, "char") ?? "•" }; break;
      // A picture bullet is drawn as a round one.
      case "a:buBlip": bullet = { kind: "character", character: "•" }; break;
      case "a:buAutoNum":
        bullet = { kind: "number", scheme: attribute(child, "type") ?? "arabicPeriod", startAt: integer(attribute(child, "startAt")) ?? 1 };
        break;
      case "a:buFont": bulletFont = attribute(child, "typeface"); break;
      case "a:buFontTx": bulletFont = null; break;
      case "a:buClr": bulletColor = resolveColor(child, context); break;
      case "a:buClrTx": bulletColor = null; break;
      case "a:buSzPct": { const value = integer(attribute(child, "val")); if (value !== undefined) bulletSize = { percent: value / 100000 }; break; }
      case "a:buSzPts": { const value = integer(attribute(child, "val")); if (value !== undefined) bulletSize = { points: value / 100 }; break; }
      case "a:buSzTx": bulletSize = null; break;
    }
  }
  return stated({
    align: ALIGNMENTS[attribute(element, "algn") ?? ""],
    marginLeft: emu(attribute(element, "marL")),
    indent: emu(attribute(element, "indent")),
    lineSpacing: readSpacing(firstChild(element, "a:lnSpc")),
    spaceBefore: readSpacing(firstChild(element, "a:spcBef")),
    spaceAfter: readSpacing(firstChild(element, "a:spcAft")),
    bullet, bulletFont, bulletColor, bulletSize,
    run: readRunProps(firstChild(element, "a:defRPr"), context),
  });
}

function flag(element: XmlElement, name: string): boolean | undefined {
  return element.attributes.has(name) ? isOn(element, name) : undefined;
}

/** Reads `a:rPr`, `a:defRPr` or `a:endParaRPr`. */
export function readRunProps(element: XmlElement | undefined, context: TextContext): RunProps {
  if (!element) return {};
  const size = integer(attribute(element, "sz"));
  const underline = attribute(element, "u");
  const strike = attribute(element, "strike");
  const baseline = integer(attribute(element, "baseline"));
  const spacing = integer(attribute(element, "spc"));
  const capitals = attribute(element, "cap");
  const fill = firstChild(element, "a:solidFill") ?? firstChild(childAt(element, "a:gradFill", "a:gsLst"), "a:gs");
  // PowerPoint draws a link in the theme's link color whatever the run says.
  const link = firstChild(element, "a:hlinkClick") ? schemeColor("hlink", context) : undefined;
  return stated({
    size: size === undefined || size <= 0 ? undefined : size / 100,
    bold: flag(element, "b"),
    italic: flag(element, "i"),
    underline: link ? true : underline === undefined ? undefined : underline !== "none",
    strike: strike === undefined ? undefined : strike !== "noStrike",
    color: link ?? resolveColor(fill, context),
    font: attribute(firstChild(element, "a:latin"), "typeface") || undefined,
    baseline: baseline === undefined ? undefined : baseline / 100000,
    letterSpacing: spacing === undefined ? undefined : spacing / 100,
    capitals: capitals === undefined ? undefined : capitals !== "none",
  });
}

function mergeLevel(base: LevelProps, over: LevelProps | undefined): LevelProps {
  return over ? { ...base, ...over, run: { ...base.run, ...over.run } } : base;
}

const ANCHORS: Readonly<Record<string, SlideTextBody["anchor"]>> = { t: "top", ctr: "middle", b: "bottom" };

/** A text body's frame without its paragraphs. */
export type TextFrame = Omit<SlideTextBody, "paragraphs">;

/** DrawingML's default insets: 0.1 inch at the sides, 0.05 inch above and below. */
const DEFAULT_INSETS = { left: 7.2, top: 3.6, right: 7.2, bottom: 3.6 };

/** Maps `vert` values to how the text is turned; East Asian upright modes are drawn rotated. */
function textDirection(vertical: string | undefined): SlideTextBody["direction"] {
  if (vertical === "vert" || vertical === "eaVert" || vertical === "wordArtVert" || vertical === "mongolianVert") return "rotate90";
  if (vertical === "vert270" || vertical === "wordArtVertRtl") return "rotate270";
  return "horizontal";
}

/** Overlays `a:bodyPr` elements, lowest priority first (master placeholder, layout placeholder, shape). */
export function readTextFrame(layers: readonly (XmlElement | undefined)[]): TextFrame {
  const find = (name: string): string | undefined => {
    for (let index = layers.length - 1; index >= 0; index--) {
      const value = attribute(layers[index], name);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  let fontScale = 1;
  let lineSpacingReduction = 0;
  for (let index = layers.length - 1; index >= 0; index--) {
    const fit = childElements(layers[index]).find(child => child.name === "a:normAutofit" || child.name === "a:spAutoFit" || child.name === "a:noAutofit");
    if (!fit) continue;
    fontScale = (integer(attribute(fit, "fontScale")) ?? 100000) / 100000;
    lineSpacingReduction = (integer(attribute(fit, "lnSpcReduction")) ?? 0) / 100000;
    break;
  }
  return {
    insets: {
      left: emu(find("lIns")) ?? DEFAULT_INSETS.left,
      top: emu(find("tIns")) ?? DEFAULT_INSETS.top,
      right: emu(find("rIns")) ?? DEFAULT_INSETS.right,
      bottom: emu(find("bIns")) ?? DEFAULT_INSETS.bottom,
    },
    anchor: ANCHORS[find("anchor") ?? ""] ?? "top",
    wrap: find("wrap") !== "none",
    direction: textDirection(find("vert")),
    fontScale: fontScale > 0 && fontScale <= 1 ? fontScale : 1,
    lineSpacingReduction: lineSpacingReduction >= 0 && lineSpacingReduction < 1 ? lineSpacingReduction : 0,
  };
}

/**
 * The paragraphs of a `p:txBody` or `a:txBody`, formatted by `styles` (lowest priority first)
 * under each paragraph's and run's own properties.
 */
export function readParagraphs(body: XmlElement, styles: readonly ListStyle[], context: TextContext): SlideParagraph[] {
  const counters: ({ scheme: string; value: number } | undefined)[] = [];
  return childElements(body, "a:p").map(paragraph => {
    const properties = firstChild(paragraph, "a:pPr");
    const level = Math.min(LEVELS - 1, Math.max(0, integer(attribute(properties, "lvl")) ?? 0));
    let props: LevelProps = { run: {} };
    for (const style of styles) props = mergeLevel(props, style[level]);
    if (properties) props = mergeLevel(props, { ...readLevelProps(properties, context), run: {} });

    const runs: SlideRun[] = [];
    for (const child of childElements(paragraph)) {
      if (child.name !== "a:r" && child.name !== "a:fld" && child.name !== "a:br") continue;
      const run = { ...props.run, ...readRunProps(firstChild(child, "a:rPr"), context) };
      const text = child.name === "a:br" ? "\n" : runText(child, context);
      if (text !== "") runs.push(finishRun(run.capitals ? text.toUpperCase() : text, run, context));
    }
    const end = finishRun("", { ...props.run, ...readRunProps(firstChild(paragraph, "a:endParaRPr"), context) }, context);
    const first = runs[0] ?? end;
    const hasText = runs.some(run => run.text.trim() !== "");

    counters.length = Math.min(counters.length, level + 1);
    let bullet: SlideBullet | undefined;
    if (hasText && props.bullet && props.bullet.kind !== "none") {
      let text: string;
      if (props.bullet.kind === "number") {
        const previous = counters[level];
        const value = previous?.scheme === props.bullet.scheme ? previous.value + 1 : props.bullet.startAt;
        counters[level] = { scheme: props.bullet.scheme, value };
        text = formatNumber(props.bullet.scheme, value);
      } else {
        counters[level] = undefined;
        text = props.bullet.character;
      }
      const size = props.bulletSize;
      bullet = {
        text,
        font: props.bulletFont ? resolveFont(props.bulletFont, context.theme) : first.font,
        size: !size ? first.size : "percent" in size ? first.size * size.percent : size.points,
        color: props.bulletColor ?? first.color,
      };
    } else if (hasText) {
      counters[level] = undefined;
    }

    const points = (spacing: Spacing | undefined): number =>
      !spacing ? 0 : "points" in spacing ? spacing.points : spacing.percent * first.size * TYPICAL_LINE_HEIGHT;
    const lineSpacing = props.lineSpacing;
    return {
      align: props.align ?? "left",
      level,
      marginLeft: props.marginLeft ?? 0,
      indent: props.indent ?? 0,
      lineSpacing: !lineSpacing ? { kind: "multiple", value: 1 }
        : "percent" in lineSpacing ? { kind: "multiple", value: lineSpacing.percent } : { kind: "exact", points: lineSpacing.points },
      spaceBefore: points(props.spaceBefore),
      spaceAfter: points(props.spaceAfter),
      ...(bullet ? { bullet } : {}),
      fontSize: first.size,
      runs,
    };
  });
}

function runText(run: XmlElement, context: TextContext): string {
  if (run.name === "a:fld" && attribute(run, "type") === "slidenum") return String(context.slideNumber);
  const text = firstChild(run, "a:t");
  return text ? textContent(text) : "";
}

function finishRun(text: string, props: RunProps, context: TextContext): SlideRun {
  return {
    text,
    font: resolveFont(props.font, context.theme),
    size: props.size ?? DEFAULT_FONT_SIZE,
    bold: props.bold ?? false,
    italic: props.italic ?? false,
    underline: props.underline ?? false,
    strike: props.strike ?? false,
    color: props.color ?? BLACK,
    baseline: props.baseline ?? 0,
    letterSpacing: props.letterSpacing ?? 0,
  };
}

/** Formats an automatic number: schemes are a numeral kind and a punctuation, such as `alphaLcParenR`. */
function formatNumber(scheme: string, value: number): string {
  const match = /^(arabic|alphaLc|alphaUc|romanLc|romanUc)(ParenBoth|ParenR|Period|Plain)?/.exec(scheme);
  const kind = match?.[1] ?? "arabic";
  const numeral = kind === "arabic" ? String(value)
    : kind === "alphaLc" ? alphabetic(value) : kind === "alphaUc" ? alphabetic(value).toUpperCase()
    : kind === "romanLc" ? roman(value).toLowerCase() : roman(value);
  switch (match?.[2] ?? "Period") {
    case "ParenBoth": return `(${numeral})`;
    case "ParenR": return `${numeral})`;
    case "Plain": return numeral;
    default: return `${numeral}.`;
  }
}

/** 1 → a, 26 → z, 27 → aa. */
function alphabetic(value: number): string {
  let out = "";
  for (let rest = Math.max(1, Math.min(value, 18278)); rest > 0; rest = Math.floor((rest - 1) / 26)) {
    out = String.fromCharCode(97 + ((rest - 1) % 26)) + out;
  }
  return out;
}

const ROMAN: readonly (readonly [number, string])[] = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
];

function roman(value: number): string {
  let rest = Math.max(1, Math.min(value, 3999));
  let out = "";
  for (const [amount, numeral] of ROMAN) {
    while (rest >= amount) {
      out += numeral;
      rest -= amount;
    }
  }
  return out;
}
