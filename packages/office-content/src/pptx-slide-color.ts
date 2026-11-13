// DrawingML colors, fills and outlines for the slide reader: the theme's color scheme and format
// scheme, a master's color map, and the transforms (tint, shade, lumMod, ...) a color element may
// carry. Colors come out as plain sRGB so a renderer needs no theme.

import { fontName } from "./font-name";
import { attribute, childAt, childElements, firstChild, type XmlElement } from "./xml";
import type { SlideColor, SlideFill, SlideGradientStop, SlideOutline } from "./pptx-slide-model";
import { lookupTable } from "./lookup-table";

/** What a theme part contributes to drawing. */
export interface SlideTheme {
  /** Scheme slot (`dk1`, `accent1`, ...) to `RRGGBB`. */
  readonly colors: ReadonlyMap<string, string>;
  readonly majorFont: string;
  readonly minorFont: string;
  /** The format scheme's fill, line and background fill styles, which `p:style` and `p:bgRef` index. */
  readonly fillStyles: readonly XmlElement[];
  readonly lineStyles: readonly XmlElement[];
  readonly backgroundFillStyles: readonly XmlElement[];
}

/** A master's `p:clrMap`: the name a slide uses (`bg1`, `tx1`, ...) to the theme slot it means. */
export type ColorMap = ReadonlyMap<string, string>;

/** What resolving a color needs. */
export interface ColorContext {
  readonly theme: SlideTheme;
  readonly colorMap: ColorMap;
}

/** The Office theme's colors, for a file whose theme is missing or incomplete. */
const DEFAULT_SCHEME: Readonly<Record<string, string>> = lookupTable({
  dk1: "000000", lt1: "FFFFFF", dk2: "44546A", lt2: "E7E6E6", accent1: "4472C4", accent2: "ED7D31",
  accent3: "A5A5A5", accent4: "FFC000", accent5: "5B9BD5", accent6: "70AD47", hlink: "0563C1", folHlink: "954F72",
});

const DEFAULT_FONT = "Calibri";

/** The map every Office master declares, for one that declares none. */
export const DEFAULT_COLOR_MAP: ColorMap = new Map([["bg1", "lt1"], ["tx1", "dk1"], ["bg2", "lt2"], ["tx2", "dk2"]]);

/** Opaque black, the color of text nothing colors. */
export const BLACK: SlideColor = { hex: "000000", alpha: 1 };
/** Opaque white, the background of a slide nothing paints. */
export const WHITE: SlideColor = { hex: "FFFFFF", alpha: 1 };

/** Reads a theme part's root; a missing part gives the Office defaults. */
export function readTheme(root: XmlElement | undefined): SlideTheme {
  const elements = firstChild(root, "a:themeElements");
  const colors = new Map(Object.entries(DEFAULT_SCHEME));
  for (const slot of childElements(firstChild(elements, "a:clrScheme"))) {
    const base = baseColor(childElements(slot)[0], undefined, undefined);
    if (base) colors.set(slot.name.slice(slot.name.indexOf(":") + 1), toHex(base));
  }
  const fonts = firstChild(elements, "a:fontScheme");
  const format = firstChild(elements, "a:fmtScheme");
  return {
    colors,
    majorFont: fontName(attribute(childAt(fonts, "a:majorFont", "a:latin"), "typeface")) || DEFAULT_FONT,
    minorFont: fontName(attribute(childAt(fonts, "a:minorFont", "a:latin"), "typeface")) || DEFAULT_FONT,
    fillStyles: childElements(firstChild(format, "a:fillStyleLst")),
    lineStyles: childElements(firstChild(format, "a:lnStyleLst")),
    backgroundFillStyles: childElements(firstChild(format, "a:bgFillStyleLst")),
  };
}

/** Reads `p:clrMap` or `a:overrideClrMapping`, whose attributes are the map. */
export function readColorMap(element: XmlElement | undefined): ColorMap | undefined {
  return element && element.attributes.size > 0 ? element.attributes : undefined;
}

/** A theme font reference (`+mj-lt`, `+mn-ea`, ...) as the theme's Latin typeface; other names unchanged. */
export function resolveFont(typeface: string | undefined, theme: SlideTheme): string {
  if (!typeface) return theme.minorFont;
  if (typeface.startsWith("+mj")) return theme.majorFont;
  if (typeface.startsWith("+mn")) return theme.minorFont;
  return fontName(typeface);
}

type Rgb = readonly [number, number, number];

const COLOR_ELEMENTS = new Set(["a:srgbClr", "a:schemeClr", "a:sysClr", "a:prstClr", "a:scrgbClr", "a:hslClr"]);

/** The preset color names files use in practice; the rest of the 140 fall back to the caller's default. */
const PRESET_COLORS: Readonly<Record<string, string>> = lookupTable({
  black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00",
  gray: "808080", grey: "808080", ltGray: "D3D3D3", dkGray: "A9A9A9", orange: "FFA500", purple: "800080",
  cyan: "00FFFF", magenta: "FF00FF", navy: "000080", teal: "008080", maroon: "800000", olive: "808000",
  silver: "C0C0C0", lime: "00FF00", aqua: "00FFFF", fuchsia: "FF00FF",
});

/**
 * The color of the first color element among `parent`'s children (as in `a:solidFill`, `a:buClr`,
 * `a:fontRef`). `placeholder` is what `phClr` stands for inside a theme style.
 */
export function resolveColor(parent: XmlElement | undefined, context: ColorContext, placeholder?: SlideColor): SlideColor | undefined {
  for (const child of childElements(parent)) {
    if (COLOR_ELEMENTS.has(child.name)) return colorOf(child, context, placeholder);
  }
  return undefined;
}

/** A theme color by the name a slide uses for it (`tx1`, `hlink`, `accent1`, ...). */
export function schemeColor(name: string, context: ColorContext): SlideColor | undefined {
  const rgb = fromHex(context.theme.colors.get(context.colorMap.get(name) ?? DEFAULT_COLOR_MAP.get(name) ?? name));
  return rgb && { hex: toHex(rgb), alpha: 1 };
}

function colorOf(element: XmlElement, context: ColorContext, placeholder: SlideColor | undefined): SlideColor | undefined {
  let rgb = baseColor(element, context, placeholder);
  if (!rgb) return undefined;
  let alpha = element.name === "a:schemeClr" && attribute(element, "val") === "phClr" ? placeholder?.alpha ?? 1 : 1;
  for (const transform of childElements(element)) {
    const amount = percent(attribute(transform, "val"));
    if (amount === undefined) continue;
    switch (transform.name) {
      case "a:alpha": alpha = amount; break;
      case "a:alphaMod": alpha *= amount; break;
      case "a:alphaOff": alpha += amount; break;
      // PowerPoint mixes towards white or black in linear light, which is why 75% tinted black is
      // the mid gray #898989 and not #404040.
      case "a:tint": rgb = mapLinear(rgb, channel => channel * amount + (1 - amount)); break;
      case "a:shade": rgb = mapLinear(rgb, channel => channel * amount); break;
      case "a:lumMod": rgb = mapHsl(rgb, ([h, s, l]) => [h, s, l * amount]); break;
      case "a:lumOff": rgb = mapHsl(rgb, ([h, s, l]) => [h, s, l + amount]); break;
      case "a:satMod": rgb = mapHsl(rgb, ([h, s, l]) => [h, s * amount, l]); break;
      case "a:satOff": rgb = mapHsl(rgb, ([h, s, l]) => [h, s + amount, l]); break;
      case "a:hueMod": rgb = mapHsl(rgb, ([h, s, l]) => [h * amount, s, l]); break;
    }
  }
  return { hex: toHex(rgb), alpha: clamp01(alpha) };
}

function baseColor(element: XmlElement | undefined, context: ColorContext | undefined, placeholder: SlideColor | undefined): Rgb | undefined {
  if (!element) return undefined;
  const value = attribute(element, "val");
  switch (element.name) {
    case "a:srgbClr": return fromHex(value);
    case "a:sysClr": return fromHex(attribute(element, "lastClr")) ?? (value === "window" ? [1, 1, 1] : [0, 0, 0]);
    case "a:prstClr": return fromHex(PRESET_COLORS[value ?? ""]);
    case "a:scrgbClr": {
      const channels = ["r", "g", "b"].map(name => linearToSrgb(clamp01(percent(attribute(element, name)) ?? 0)));
      return [channels[0]!, channels[1]!, channels[2]!];
    }
    case "a:hslClr": {
      const hue = Number.parseInt(attribute(element, "hue") ?? "0", 10) / 60000;
      return hslToRgb([Number.isFinite(hue) ? hue : 0, percent(attribute(element, "sat")) ?? 0, percent(attribute(element, "lum")) ?? 0]);
    }
    case "a:schemeClr": {
      if (value === undefined || !context) return undefined;
      if (value === "phClr") return fromHex(placeholder?.hex);
      return fromHex(context.theme.colors.get(context.colorMap.get(value) ?? DEFAULT_COLOR_MAP.get(value) ?? value));
    }
    default: return undefined;
  }
}

/** A value in 1000ths of a percent as a fraction. */
function percent(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number / 100000 : undefined;
}

function fromHex(hex: string | undefined): Rgb | undefined {
  if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  const number = Number.parseInt(hex, 16);
  return [(number >> 16) / 255, ((number >> 8) & 0xff) / 255, (number & 0xff) / 255];
}

function toHex(rgb: Rgb): string {
  return rgb.map(channel => Math.round(clamp01(channel) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function mapLinear(rgb: Rgb, map: (channel: number) => number): Rgb {
  const [r, g, b] = rgb.map(channel => linearToSrgb(clamp01(map(srgbToLinear(channel)))));
  return [r!, g!, b!];
}

type Hsl = readonly [hue: number, saturation: number, lightness: number];

function mapHsl(rgb: Rgb, map: (hsl: Hsl) => Hsl): Rgb {
  const [h, s, l] = map(rgbToHsl(rgb));
  return hslToRgb([h, clamp01(s), clamp01(l)]);
}

/** Hue is in degrees. */
function rgbToHsl([r, g, b]: Rgb): Hsl {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return [0, 0, lightness];
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return [(hue * 60 + 360) % 360, saturation, lightness];
}

function hslToRgb([hue, saturation, lightness]: Hsl): Rgb {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (((hue % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const floor = lightness - chroma / 2;
  const [r, g, b] = sector < 1 ? [chroma, second, 0] : sector < 2 ? [second, chroma, 0] : sector < 3 ? [0, chroma, second]
    : sector < 4 ? [0, second, chroma] : sector < 5 ? [second, 0, chroma] : [chroma, 0, second];
  return [r! + floor, g! + floor, b! + floor];
}

/** A fill, `"none"` for an explicit `a:noFill`, or undefined when nothing here says (so a lower layer decides). */
export type FillChoice = SlideFill | "none" | undefined;

/**
 * The fill one fill element (`a:solidFill`, `a:gradFill`, `a:pattFill`, `a:noFill`) describes.
 * Picture fills need the package and are the caller's to resolve.
 */
export function fillOf(element: XmlElement, context: ColorContext, placeholder?: SlideColor): FillChoice {
  switch (element.name) {
    case "a:noFill":
      return "none";
    case "a:solidFill": {
      const color = resolveColor(element, context, placeholder);
      return color && { kind: "solid", color };
    }
    case "a:gradFill":
      return gradientOf(element, context, placeholder);
    case "a:pattFill": {
      // A pattern is drawn as its foreground color: closer to the intent than leaving it empty.
      const color = resolveColor(firstChild(element, "a:fgClr"), context, placeholder);
      return color && { kind: "solid", color };
    }
    default:
      return undefined;
  }
}

/** The first fill among `container`'s children, as `a:spPr`, `p:bgPr` and `a:tcPr` hold one. */
export function findFill(container: XmlElement | undefined, context: ColorContext, placeholder?: SlideColor): FillChoice {
  for (const child of childElements(container)) {
    const fill = fillOf(child, context, placeholder);
    if (fill) return fill;
  }
  return undefined;
}

/**
 * The most stops a gradient keeps; PowerPoint lets a gradient have ten. Every shape painted with
 * a theme gradient gets its own copy of the stops, so a longer list would be copied once per shape.
 */
const MAX_GRADIENT_STOPS = 64;

function gradientOf(element: XmlElement, context: ColorContext, placeholder: SlideColor | undefined): FillChoice {
  const stops: SlideGradientStop[] = [];
  for (const stop of childElements(firstChild(element, "a:gsLst"), "a:gs").slice(0, MAX_GRADIENT_STOPS)) {
    const color = resolveColor(stop, context, placeholder);
    const position = percent(attribute(stop, "pos"));
    if (color && position !== undefined) stops.push({ position: clamp01(position), color });
  }
  if (stops.length === 0) return undefined;
  stops.sort((a, b) => a.position - b.position);
  const linear = firstChild(element, "a:lin");
  const angle = Number.parseInt(attribute(linear, "ang") ?? "", 10) / 60000;
  // A radial or shaped gradient is drawn top to bottom, which keeps its colors if not its shape.
  return { kind: "gradient", angle: linear ? (Number.isFinite(angle) ? angle : 0) : 90, stops };
}

/** The parts of an outline one `a:ln` states; the rest come from a lower layer. */
export interface OutlineLayer {
  readonly width?: number;
  readonly color?: SlideColor | "none";
  readonly dash?: SlideOutline["dash"];
}

const EMU_PER_POINT = 12700;
/** DrawingML's default line width, 0.75pt. */
const DEFAULT_LINE_WIDTH = 9525 / EMU_PER_POINT;

/** What an `a:ln` element (or a table border's) states. */
export function outlineLayer(line: XmlElement | undefined, context: ColorContext, placeholder?: SlideColor): OutlineLayer {
  if (!line) return {};
  const width = Number.parseInt(attribute(line, "w") ?? "", 10);
  const fill = findFill(line, context, placeholder);
  const dash = attribute(firstChild(line, "a:prstDash"), "val");
  return {
    ...(Number.isFinite(width) && width >= 0 ? { width: width / EMU_PER_POINT } : {}),
    ...(fill === "none" ? { color: "none" as const }
      : fill?.kind === "solid" ? { color: fill.color }
      : fill?.kind === "gradient" ? { color: fill.stops[0]!.color } : {}),
    ...(dash === undefined ? {} : { dash: dash === "solid" ? "solid" as const : /dot/i.test(dash) && !/dash/i.test(dash) ? "dot" as const : "dash" as const }),
  };
}

/** The outline the layers describe, highest priority first; undefined when none gives it a color. */
export function mergeOutline(layers: readonly OutlineLayer[]): SlideOutline | undefined {
  const color = layers.find(layer => layer.color !== undefined)?.color;
  if (color === undefined || color === "none") return undefined;
  const width = layers.find(layer => layer.width !== undefined)?.width ?? DEFAULT_LINE_WIDTH;
  if (width <= 0) return undefined;
  return { width, color, dash: layers.find(layer => layer.dash !== undefined)?.dash ?? "solid" };
}
