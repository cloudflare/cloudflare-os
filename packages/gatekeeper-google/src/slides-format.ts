/**
 * Formatting between Google's JSON and what agents read: colours, text and paragraph styles, and
 * shape and cell fills. Only what Google reports as set is read; an unset field is inherited.
 */

import type {
  RestColor, RestParagraphStyle, RestPropertyState, RestShapeProperties, RestSolidFill, RestText,
  RestTextStyle,
} from "./slides-api";
import { emu, points } from "./slides-geometry";
import type {
  FormattedParagraph, FormattedRange, ParagraphFormat, ShapeElement, SlideColor, TableCell,
  TextFormat,
} from "./slides-read-types";

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

/** A colour as agents read it; undefined for a transparent one. */
export function colorOf(color: RestColor | undefined): SlideColor | undefined {
  let opaque = color?.opaqueColor;
  if (opaque?.themeColor) return opaque.themeColor;
  if (!opaque?.rgbColor) return undefined;
  // Google omits a zero component, as it omits every zero-valued field.
  let { red = 0, green = 0, blue = 0 } = opaque.rgbColor;
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
  let color = colorOf(style.foregroundColor);
  if (color) format.color = color;
  let highlight = colorOf(style.backgroundColor);
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
