/**
 * Formatting between Google's JSON and what agents read and write: colours, text and paragraph
 * styles, and shape and cell fills. Only what Google reports as set is read; an unset field is
 * inherited.
 */

import type {
  RestColor, RestDimension, RestOpaqueColor, RestParagraphStyle, RestPropertyState, RestShapeProperties,
  RestSolidFill, RestText, RestTextStyle,
} from "./slides-api";
import { emu, points } from "./slides-geometry";
import type {
  FormattedParagraph, FormattedRange, ParagraphFormat, ShapeElement, SlideColor, TableCell,
  TextFormat,
} from "./slides-read-types";
import type { ShapeOutline, TextFormatChange } from "./slides-types";

type Fill = { propertyState?: RestPropertyState; solidFill?: RestSolidFill };

const BOOLEAN_STYLES = ["bold", "italic", "underline", "strikethrough", "smallCaps"] as const;

/** Google's names for what agents read, and back. */
export const BASELINES: Record<string, "superscript" | "subscript"> = {
  SUPERSCRIPT: "superscript", SUBSCRIPT: "subscript",
};
export const ALIGNMENTS: Record<string, NonNullable<ParagraphFormat["alignment"]>> = {
  START: "start", CENTER: "center", END: "end", JUSTIFIED: "justified",
};
export const CONTENT_ALIGNMENTS: Record<string, NonNullable<ShapeElement["contentAlignment"]>> = {
  TOP: "top", MIDDLE: "middle", BOTTOM: "bottom",
};

/** A colour as agents read it; undefined for none. */
export function colorOf(color: RestOpaqueColor | undefined): SlideColor | undefined {
  if (color?.themeColor) return color.themeColor;
  if (!color?.rgbColor) return undefined;
  // Google omits a zero component, as it omits every zero-valued field.
  let { red = 0, green = 0, blue = 0 } = color.rgbColor;
  return `#${[red, green, blue]
    .map(value => Math.round(value * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** The formatting a text style sets. */
export function formatOf(style: RestTextStyle | undefined): TextFormat {
  if (!style) return {};
  let format: TextFormat = {};
  for (let key of BOOLEAN_STYLES) if (style[key] !== undefined) format[key] = style[key];
  if (style.fontFamily) format.fontFamily = style.fontFamily;
  if (style.fontSize?.magnitude) format.fontSize = points(emu(style.fontSize));
  let color = colorOf(style.foregroundColor?.opaqueColor);
  if (color) format.color = color;
  let highlight = colorOf(style.backgroundColor?.opaqueColor);
  if (highlight) format.highlight = highlight;
  if (style.link?.url) format.link = style.link.url;
  let baseline = BASELINES[style.baselineOffset ?? ""];
  if (baseline) format.baseline = baseline;
  return format;
}

function paragraphFormatOf(style: RestParagraphStyle | undefined): ParagraphFormat {
  let format: ParagraphFormat = {};
  let alignment = ALIGNMENTS[style?.alignment ?? ""];
  if (alignment) format.alignment = alignment;
  if (style?.lineSpacing) format.lineSpacing = style.lineSpacing;
  if (style?.spaceAbove) format.spaceAbove = points(emu(style.spaceAbove));
  if (style?.spaceBelow) format.spaceBelow = points(emu(style.spaceBelow));
  return format;
}

/**
 * The formatting of `body`, whose projected text is `text`: ranges of it that set text formatting,
 * and the paragraphs that set any. Ranges leave newlines out, running on across them where both
 * sides set the same: Google may restyle a newline beside text it styles, and never links one.
 */
export function formattingOf(
  body: RestText | undefined, text: string,
): { formats?: FormattedRange[]; paragraphs?: FormattedParagraph[] } {
  let formats: (FormattedRange & { key: string })[] = [];
  let offset = 0;
  let markers = [];
  for (let element of body?.textElements ?? []) {
    if (element.paragraphMarker) markers.push(element.paragraphMarker);
    let run = element.textRun ?? element.autoText;
    if (!run) continue;
    let format = formatOf(run.style);
    let key = JSON.stringify(format);
    let pieces = (run.content ?? "").split("\n");
    pieces.forEach((piece, i) => {
      let start = offset + i;
      offset += piece.length;
      // The final newline is not part of the text agents read.
      let end = Math.min(start + piece.length, text.length);
      if (end <= start || key === "{}") return;
      let previous = formats.at(-1);
      if (previous?.key === key && /^\n*$/.test(text.slice(previous.end, start))) previous.end = end;
      else formats.push({ start, end, ...format, key });
    });
    offset += pieces.length - 1;
  }
  let start = 0;
  let paragraphs = text.split("\n").flatMap((line, i): FormattedParagraph[] => {
    let range = { start, end: start + line.length };
    start = range.end + 1;
    let format = paragraphFormatOf(markers[i]?.style);
    let bullet = markers[i]?.bullet;
    if (!bullet && Object.keys(format).length === 0) return [];
    return [{ ...range, ...format, ...(bullet ? { bullet: { level: bullet.nestingLevel ?? 0 } } : {}) }];
  });
  return {
    ...(formats.length > 0 ? { formats: formats.map(({ key: _, ...range }) => range) } : {}),
    ...(paragraphs.length > 0 ? { paragraphs } : {}),
  };
}

/** A fill as agents read it: a colour, `"none"`, or undefined when inherited or unset. */
export function fillOf(fill: Fill | undefined): SlideColor | "none" | undefined {
  if (fill?.propertyState === "NOT_RENDERED") return "none";
  if (fill?.propertyState === "INHERIT") return undefined;
  return colorOf(fill?.solidFill?.color);
}

/** A shape's fill, outline and content alignment, as far as the shape sets them. */
export function shapePropertiesOf(
  properties: RestShapeProperties | undefined,
): Pick<ShapeElement, "fill" | "outline" | "contentAlignment"> {
  let read: Pick<ShapeElement, "fill" | "outline" | "contentAlignment"> = {};
  let fill = fillOf(properties?.shapeBackgroundFill);
  if (fill) read.fill = fill;
  let outline = properties?.outline;
  if (outline?.propertyState === "NOT_RENDERED") {
    read.outline = "none";
  } else if (outline && outline.propertyState !== "INHERIT") {
    let color = colorOf(outline.outlineFill?.solidFill?.color);
    let weight = outline.weight?.magnitude ? points(emu(outline.weight)) : undefined;
    if (color || weight) {
      read.outline = { ...(color ? { color } : {}), ...(weight ? { weight } : {}) };
    }
  }
  let contentAlignment = CONTENT_ALIGNMENTS[properties?.contentAlignment ?? ""];
  if (contentAlignment) read.contentAlignment = contentAlignment;
  return read;
}

/** A table cell's fill and content alignment, as far as the cell sets them. */
export function cellPropertiesOf(
  properties: { tableCellBackgroundFill?: Fill; contentAlignment?: string } | undefined,
): Pick<TableCell, "fill" | "contentAlignment"> {
  let fill = fillOf(properties?.tableCellBackgroundFill);
  let contentAlignment = CONTENT_ALIGNMENTS[properties?.contentAlignment ?? ""];
  return { ...(fill ? { fill } : {}), ...(contentAlignment ? { contentAlignment } : {}) };
}

/** The theme colours a `SlideColor` may name. */
const THEME_COLORS = new Set([
  "DARK1", "LIGHT1", "DARK2", "LIGHT2", "ACCENT1", "ACCENT2", "ACCENT3", "ACCENT4", "ACCENT5",
  "ACCENT6", "HYPERLINK", "FOLLOWED_HYPERLINK", "TEXT1", "BACKGROUND1", "TEXT2", "BACKGROUND2",
]);

/** Whether `color` is a `#rrggbb` colour or a theme colour's name. */
export function isSlideColor(color: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(color) || THEME_COLORS.has(color);
}

/** A colour as Google takes it, from a `#rrggbb` colour or a theme colour's name. */
export function restColorOf(color: SlideColor): RestOpaqueColor {
  if (THEME_COLORS.has(color)) return { themeColor: color };
  let [red, green, blue] = [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16) / 255);
  // Google omits a zero component, as it omits every zero-valued field.
  return { rgbColor: { ...(red ? { red } : {}), ...(green ? { green } : {}), ...(blue ? { blue } : {}) } };
}

/** A text colour as Google takes it: an `OptionalColor`, which wraps the colour a fill takes bare. */
function restTextColorOf(color: SlideColor | null): RestColor | null {
  return color === null ? null : { opaqueColor: restColorOf(color) };
}

/** A length in points, as Google takes it. */
export function pointsDimension(magnitude: number): RestDimension {
  return { magnitude, unit: "PT" };
}

/**
 * A style and the fields it sets, as an update request takes them: a field named but absent from
 * the style is unset.
 */
export type StyleChange<S> = { style: S; fields: (keyof S & string)[] };

const REST_BASELINES = { superscript: "SUPERSCRIPT", subscript: "SUBSCRIPT", none: "NONE" };

/**
 * The text style change `format` makes. A font is set at regular weight, which Google renders not
 * bold, so unless `format` sets `bold` the change unsets it explicitly, keeping what Google keeps.
 * A link turns the text the theme's link colour and underlined unless `format` says otherwise, as
 * Google does, but explicitly, so the request does not depend on it.
 */
export function textStyleChange(format: TextFormatChange): StyleChange<RestTextStyle> {
  let style: RestTextStyle = {};
  let fields = new Set<keyof RestTextStyle & string>();
  let set = <K extends keyof RestTextStyle & string>(key: K, value: RestTextStyle[K] | null) => {
    fields.add(key);
    if (value !== null) style[key] = value;
  };
  for (let key of BOOLEAN_STYLES) if (format[key] !== undefined) set(key, format[key]);
  if (format.fontFamily !== undefined) {
    let family = format.fontFamily;
    set("fontFamily", family);
    set("weightedFontFamily", family === null ? null : { fontFamily: family, weight: 400 });
    // Weights under 700 are not bold, so a `bold: true` the text kept would describe it wrongly.
    if (family !== null && format.bold === undefined) set("bold", false);
  }
  if (format.fontSize !== undefined) {
    set("fontSize", format.fontSize === null ? null : pointsDimension(format.fontSize));
  }
  if (format.color !== undefined) set("foregroundColor", restTextColorOf(format.color));
  else if (format.link !== undefined) set("foregroundColor", restTextColorOf("HYPERLINK"));
  if (format.highlight !== undefined) set("backgroundColor", restTextColorOf(format.highlight));
  if (format.link !== undefined) {
    set("link", { url: format.link });
    if (format.underline === undefined) set("underline", true);
  }
  if (format.baseline !== undefined) {
    set("baselineOffset", format.baseline === null ? null : REST_BASELINES[format.baseline]);
  }
  return { style, fields: [...fields] };
}

/** The paragraph style change a `formatParagraphs` change makes. */
export function paragraphStyleChange(change: {
  alignment?: ParagraphFormat["alignment"] | null; lineSpacing?: number | null;
  spaceAbove?: number | null; spaceBelow?: number | null;
}): StyleChange<RestParagraphStyle> {
  let style: RestParagraphStyle = {};
  let fields: (keyof RestParagraphStyle & string)[] = [];
  let set = <K extends keyof RestParagraphStyle & string>(
    key: K, value: RestParagraphStyle[K] | null,
  ) => {
    fields.push(key);
    if (value !== null) style[key] = value;
  };
  if (change.alignment !== undefined) {
    set("alignment", change.alignment === null ? null : change.alignment.toUpperCase());
  }
  if (change.lineSpacing !== undefined) set("lineSpacing", change.lineSpacing);
  for (let key of ["spaceAbove", "spaceBelow"] as const) {
    let value = change[key];
    if (value !== undefined) set(key, value === null ? null : pointsDimension(value));
  }
  return { style, fields };
}

/** Applies a style change to `style`, as Google applies an update request's fields. */
export function restyled<S extends object>(
  style: S | undefined, change: StyleChange<S>, skip?: keyof S,
): S | undefined {
  let next: S = { ...style } as S;
  for (let field of change.fields) {
    if (field === skip) continue;
    if (field in change.style) next[field] = change.style[field];
    else delete next[field];
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** A shape's or cell's fill, as Google takes it: opaque `color`, or none. */
export function restFillOf(fill: SlideColor | "none"): Fill {
  return fill === "none"
    ? { propertyState: "NOT_RENDERED" }
    : { propertyState: "RENDERED", solidFill: { color: restColorOf(fill), alpha: 1 } };
}

/** The `ShapeProperties` and field mask a shape change sets. */
export function shapePropertiesChange(change: {
  fill?: SlideColor | "none"; outline?: ShapeOutline | "none";
  contentAlignment?: "top" | "middle" | "bottom";
}): { properties: RestShapeProperties; fields: string[] } {
  let properties: RestShapeProperties = {};
  let fields: string[] = [];
  if (change.fill !== undefined) {
    properties.shapeBackgroundFill = restFillOf(change.fill);
    fields.push("shapeBackgroundFill");
  }
  let { outline } = change;
  if (outline === "none") {
    properties.outline = { propertyState: "NOT_RENDERED" };
    fields.push("outline.propertyState");
  } else if (outline !== undefined) {
    properties.outline = { propertyState: "RENDERED" };
    fields.push("outline.propertyState");
    if (outline.color !== undefined) {
      properties.outline.outlineFill = { solidFill: { color: restColorOf(outline.color), alpha: 1 } };
      fields.push("outline.outlineFill.solidFill");
    }
    if (outline.weight !== undefined) {
      properties.outline.weight = pointsDimension(outline.weight);
      fields.push("outline.weight");
    }
  }
  if (change.contentAlignment !== undefined) {
    properties.contentAlignment = change.contentAlignment.toUpperCase();
    fields.push("contentAlignment");
  }
  return { properties, fields };
}

/** Applies a shape change to `properties`, as Google applies its fields. */
export function reshaped(
  properties: RestShapeProperties | undefined, change: RestShapeProperties,
): RestShapeProperties {
  let next = structuredClone(properties ?? {});
  if (change.shapeBackgroundFill) next.shapeBackgroundFill = change.shapeBackgroundFill;
  if (change.outline) {
    let { outlineFill, weight, propertyState } = change.outline;
    next.outline = {
      ...next.outline, propertyState,
      ...(outlineFill ? { outlineFill } : {}), ...(weight ? { weight } : {}),
    };
  }
  if (change.contentAlignment) next.contentAlignment = change.contentAlignment;
  return next;
}
