/**
 * A slide as Google Slides draws it, worked out from Slides' own JSON: a placeholder takes its
 * place, fill, outline, shadow and text styles from its layout's placeholder, and that from its
 * master's; the master's and layout's other elements lie behind the slide's own; a theme colour
 * is the master's. Grouped elements are listed on their own, placed as their groups place them.
 *
 * Nothing Google works out as it renders is simulated, as for any read (see
 * `slides-simulation.ts`): text is shrunk only by the scale Google last reported, a bent or curved
 * line turns where Google first puts its turns, and gradients and a picture's recolouring are left
 * out.
 */

import type {
  RestBorderRow, RestDimension, RestImageProperties, RestOpaqueColor, RestOutline, RestPageElement,
  RestParagraphStyle, RestPresentation, RestShadow, RestSlide, RestSolidFill, RestText,
  RestTextElement, RestTextStyle, RestThemePage,
} from "./slides-api";
import { ALIGNMENTS, BASELINES, colorOf, CONTENT_ALIGNMENTS } from "./slides-format";
import {
  emu, IDENTITY, localBox, matrixOf, multiply, placementOf, points, roundedPlacement, slidePoint,
  tableLinesOf, type Matrix,
} from "./slides-geometry";
import { ADJUSTED_PRESETS, type ShapeGeometry } from "./slides-export";
import type { Deck } from "./slides-simulation";
import type {
  DrawnElement, DrawnFill, DrawnParagraph, DrawnShadow, DrawnSlide, DrawnStroke, DrawnTableCell,
  DrawnTextStyle, SlideFont,
} from "./slides-rendering-types";
import type { SlideBounds, SlidePoint } from "./slides-types";

const arrowOf = (end: string | undefined) => end && end !== "NONE" ? end : undefined;

/**
 * A picture a drawing names, and where Google serves it: a bearer URL, which stays here. `side` is
 * the longer side of the whole picture as it is drawn, in points, before any of it is cut away.
 */
export type PictureSource = { contentUrl: string; side: number };

/**
 * A slide drawn: its own elements, what its master and its layout put behind them, and the
 * pictures all of them name, by the IDs they name them by.
 */
export type DrawnPage = {
  slide: Omit<DrawnSlide, "behind">;
  behind: DrawnElement[][];
  pictures: Map<string, PictureSource>;
};

/** The pending changes that touched the element with the last of `ids`, or a group among them. */
export type ElementChanges = (ids: readonly string[]) => NonNullable<DrawnElement["changes"]>;

// What Slides draws text as when nothing sets it, and a line when nothing weighs it.
const DEFAULT_FONT = "Arial";
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_LINE_WEIGHT = 0.75;
const DEFAULT_BORDER_WEIGHT = 1;
const REGULAR_WEIGHT = 400;
const BOLD_WEIGHT = 700;

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places + 0;

/** A length in points; a dimension with no magnitude is a zero Google omitted. */
const lengthOf = (dimension: RestDimension | undefined) => dimension && points(emu(dimension));

type Paragraph = {
  marker?: RestTextElement["paragraphMarker"];
  runs: { text: string; style?: RestTextStyle; link?: RestTextStyle["link"] }[];
  /** The style of the newline ending it, which a placeholder's paragraphs pass on. */
  end?: RestTextStyle;
};

function paragraphsOf(body: RestText | undefined): Paragraph[] {
  let paragraphs: Paragraph[] = [];
  let current: Paragraph | undefined;
  for (let element of body?.textElements ?? []) {
    if (element.paragraphMarker) {
      paragraphs.push(current = { marker: element.paragraphMarker, runs: [] });
      continue;
    }
    let run = element.textRun ?? element.autoText;
    if (!run) continue;
    (run.content ?? "").split("\n").forEach((piece, i) => {
      if (i > 0) {
        if (current) current.end = run.style;
        current = undefined;
      }
      if (!piece) return;
      if (!current) paragraphs.push(current = { runs: [] });
      current.runs.push({ text: piece, ...(run.style ? { style: run.style } : {}) });
    });
  }
  return paragraphs;
}

const levelOf = (paragraph: Paragraph) => paragraph.marker?.bullet?.nestingLevel ?? 0;

/**
 * What a paragraph at `level` takes from the placeholders above it, the nearest first: Google
 * styles it as each one's first paragraph at that level, or its first of all, and that paragraph's
 * text as its newline.
 */
function inheritedAt(parents: readonly Paragraph[][], level: number) {
  let text: RestTextStyle = {};
  let paragraph: RestParagraphStyle = {};
  for (let paragraphs of parents.toReversed()) {
    let match = paragraphs.find(found => levelOf(found) === level) ?? paragraphs[0];
    if (!match) continue;
    Object.assign(text, match.end ?? match.runs.at(-1)?.style);
    Object.assign(paragraph, match.marker?.style);
  }
  return { text, paragraph };
}

/** A list's style at each nesting level, as `TextContent.lists` holds it. */
type RestList = { nestingLevel?: Record<string, { bulletStyle?: RestTextStyle } | undefined> };

/** The scale Google last shrank a shape's text by to fit it, and how far it closed its lines up. */
type Fit = { scale: number; reduction: number };
const UNFITTED: Fit = { scale: 1, reduction: 0 };

type Fill = { propertyState?: string; solidFill?: RestSolidFill };

/** One page's elements resolved against its layout and master in `deck`. */
class Page {
  readonly pictures = new Map<string, PictureSource>();
  #theme = new Map<string, string>();
  /** Every layout and master element by ID, which a placeholder names as its parent. */
  #parents = new Map<string, RestPageElement>();
  #changesOf: ElementChanges;
  /** The lines of three legs drawn, and the elements their ends are attached to. */
  #joined: { id: string; ends: (string | undefined)[] }[] = [];

  constructor(
    pages: readonly (RestThemePage | undefined)[], master: RestThemePage | undefined, changesOf: ElementChanges,
    private geometry: ReadonlyMap<string, ShapeGeometry>,
  ) {
    this.#changesOf = changesOf;
    for (let { type, color } of master?.pageProperties?.colorScheme?.colors ?? []) {
      // Google omits a zero component, so black is `{}`.
      let hex = colorOf({ rgbColor: color ?? {} });
      if (type && hex) this.#theme.set(type, hex);
    }
    let index = (elements: RestPageElement[] | undefined) => {
      for (let element of elements ?? []) {
        if (element.objectId) this.#parents.set(element.objectId, element);
        index(element.elementGroup?.children);
      }
    };
    for (let page of pages) index(page?.pageElements);
  }

  color(color: RestOpaqueColor | undefined): string | undefined {
    let read = colorOf(color);
    return read?.startsWith("#") ? read : read && this.#theme.get(read);
  }

  solid(fill: RestSolidFill | undefined): DrawnFill | undefined {
    let color = this.color(fill?.color);
    let opacity = fill?.alpha ?? 1;
    return color && opacity > 0 ? { color, ...(opacity < 1 ? { opacity: round(opacity, 3) } : {}) } : undefined;
  }

  /** The element and the placeholders above it, nearest first. */
  #chain(element: RestPageElement): RestPageElement[] {
    let chain = [element];
    for (let id = element.shape?.placeholder?.parentObjectId; id !== undefined;) {
      let parent = this.#parents.get(id);
      if (!parent || chain.includes(parent)) break;
      chain.push(parent);
      id = parent.shape?.placeholder?.parentObjectId;
    }
    return chain;
  }

  /** Draws `element` and, for a group, what it holds, into `drawn`. */
  draw(
    element: RestPageElement, drawn: DrawnElement[], from?: "layout" | "master",
    parent: Matrix = IDENTITY, groups: readonly string[] = [],
  ): void {
    if (!element.objectId) return;
    let chain = this.#chain(element);
    // A placeholder that sets no place of its own is where its layout's is.
    let transform = chain.find(link => link.transform)?.transform;
    let matrix = transform && multiply(parent, matrixOf(transform));
    let ids = [...groups, element.objectId];
    if (element.elementGroup) {
      for (let child of element.elementGroup.children ?? []) this.draw(child, drawn, from, matrix ?? parent, ids);
      return;
    }
    let size = chain.find(link => link.size)?.size;
    let box = localBox(element.table || !size ? element : { ...element, size });
    let placement = matrix && box && placementOf(matrix, box);
    if (!matrix || !box || !placement) return;
    let { bounds, rotation, flipped } = roundedPlacement(placement);
    let changes = from ? [] : this.#changesOf(ids);
    let base = {
      id: element.objectId, ...(from ? { from } : {}), bounds,
      ...(rotation ? { rotation } : {}), ...(flipped ? { flipped: true as const } : {}),
      ...(changes.length > 0 ? { changes } : {}),
    };
    if (element.shape) {
      drawn.push({ ...base, kind: "shape", ...this.#shape(element, chain) });
    } else if (element.wordArt) {
      let text = this.#text(
        { textElements: [{ textRun: { content: element.wordArt.renderedText ?? "" } }] }, [], UNFITTED);
      drawn.push({ ...base, kind: "shape", shapeType: "TEXT_BOX", ...(text ? { text } : {}) });
    } else if (element.table) {
      let scaleX = Math.hypot(matrix.a, matrix.b);
      let scaleY = scaleX ? Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) / scaleX : 1;
      drawn.push({ ...base, kind: "table", ...this.#table(element.table, scaleX, scaleY) });
    } else if (element.line) {
      let { lineProperties: properties, lineCategory } = element.line;
      let stroke = this.#stroke(properties?.lineFill?.solidFill, properties?.weight, properties?.dashStyle);
      let category = ({ STRAIGHT: "straight", BENT: "bent", CURVED: "curved" } as const)[lineCategory ?? ""];
      let startArrow = arrowOf(properties?.startArrow);
      let endArrow = arrowOf(properties?.endArrow);
      // A connector of two legs turns at its box's corner. One of three has its middle leg halfway
      // along until someone drags it, which Google does not report; one of more is not followed.
      let legs = element.line.lineType?.at(-1);
      let turn = (along: number, down: number) =>
        slidePoint(matrix, box.x + along * box.width, box.y + down * box.height);
      let via = category === "straight" ? undefined
        : legs === "2" ? [turn(1, 0)] : legs === "3" ? [turn(.5, 0), turn(.5, 1)] : undefined;
      if (via?.length === 2) {
        let { startConnection, endConnection } = properties ?? {};
        this.#joined.push({
          id: element.objectId, ends: [startConnection?.connectedObjectId, endConnection?.connectedObjectId],
        });
      }
      drawn.push({
        ...base, kind: "line",
        // A line runs from its box's top-left corner to its bottom-right, before its transform.
        start: slidePoint(matrix, box.x, box.y),
        end: slidePoint(matrix, box.x + box.width, box.y + box.height),
        ...(via ? { via } : {}),
        ...(stroke ? { stroke } : {}),
        ...(startArrow ? { startArrow } : {}), ...(endArrow ? { endArrow } : {}),
        ...(category ? { category } : {}),
      });
    } else if (element.image || element.video || element.sheetsChart) {
      let of = element.image ? "image" as const : element.video ? "video" as const : "chart" as const;
      // A picture a pending change puts in is not Google's to serve yet.
      let replaced = changes.some(({ op }) => op === "replaceImage");
      let contentUrl = replaced ? undefined : element.image?.contentUrl ?? element.sheetsChart?.contentUrl;
      let look = this.#pictureLook(element.image?.imageProperties ??
        element.sheetsChart?.sheetsChartProperties?.chartImageProperties);
      // Its box shows what a crop leaves of the picture, so the whole of it is that much larger.
      let { left = 0, top = 0, right = 0, bottom = 0 } = look.crop ?? {};
      if (contentUrl) {
        this.pictures.set(element.objectId, {
          contentUrl, side: Math.max(bounds.width / (1 - left - right), bounds.height / (1 - top - bottom)),
        });
      }
      drawn.push({ ...base, kind: "picture", of, ...(contentUrl ? { pictureId: element.objectId } : {}), ...look });
    }
  }

  /**
   * Draws straight each line of three legs in `drawn` whose middle leg cannot be halfway along:
   * with it there, an end would cross the shape it is attached to. Google routes such a line
   * around the shapes it joins, and does not report where.
   */
  straighten(drawn: DrawnElement[]): void {
    let byId = new Map(drawn.map(element => [element.id, element]));
    for (let { id, ends } of this.#joined) {
      let line = byId.get(id);
      if (line?.kind !== "line" || line.via?.length !== 2) continue;
      let crosses = [[line.start, line.via[0]], [line.end, line.via[1]]].some(([end, corner], i) => {
        let shape = byId.get(ends[i] ?? "");
        if (!shape) return false;
        let out = outwardAt(shape.bounds, end);
        return (corner.x - end.x) * out.x + (corner.y - end.y) * out.y < 0;
      });
      if (crosses) delete line.via;
    }
  }

  #shape(element: RestPageElement, chain: RestPageElement[]) {
    let properties = chain.map(link => link.shape?.shapeProperties);
    let { shapeType = "TEXT_BOX" } = element.shape!;
    let fill = this.#fill(properties.map(set => set?.shapeBackgroundFill));
    let outline = this.#outline(properties.map(set => set?.outline));
    let shadow = this.#shadow(properties.map(set => set?.shadow));
    let autofit = element.shape!.shapeProperties?.autofit;
    let text = this.#text(
      element.shape!.text, chain.slice(1).map(link => paragraphsOf(link.shape?.text)),
      { scale: autofit?.fontScale ?? 1, reduction: autofit?.lineSpacingReduction ?? 0 });
    // A text box's text starts at its top, any other shape's at its middle, unless it says.
    let contentAlignment = properties.map(set => CONTENT_ALIGNMENTS[set?.contentAlignment ?? ""]).find(Boolean)
      ?? (shapeType === "TEXT_BOX" ? "top" : "middle");
    // What the export says of the shape, as long as it is still the kind of shape the export saw.
    let geometry = this.geometry.get(element.objectId!);
    let paths = geometry && "paths" in geometry && shapeType === "CUSTOM" ? geometry.paths : undefined;
    let adjust = geometry && "preset" in geometry && geometry.preset === ADJUSTED_PRESETS.get(shapeType) && geometry.adjust.length > 0
      ? geometry.adjust : undefined;
    return {
      shapeType, ...(paths ? { paths } : {}), ...(adjust ? { adjust } : {}),
      ...(fill ? { fill } : {}), ...(outline ? { outline } : {}),
      ...(shadow ? { shadow } : {}), ...(text ? { contentAlignment, text } : {}),
    };
  }

  /**
   * A fill, from the nearest of `fills` that does not inherit. One that is drawn but names no
   * colour takes it from the nearest further one that does, drawn or not: a placeholder switched
   * on over a layout's hidden white box is drawn white.
   */
  #fill(fills: (Fill | undefined)[]): DrawnFill | undefined {
    let at = fills.findIndex(fill => fill && fill.propertyState !== "INHERIT");
    let fill = fills[at];
    if (!fill || fill.propertyState === "NOT_RENDERED") return undefined;
    return this.solid(fills.slice(at).find(link => link?.solidFill)?.solidFill);
  }

  #outline(outlines: (RestOutline | undefined)[]): DrawnStroke | undefined {
    let outline = outlines.find(link => link && link.propertyState !== "INHERIT");
    if (!outline || outline.propertyState === "NOT_RENDERED") return undefined;
    return this.#stroke(outline.outlineFill?.solidFill, outline.weight, outline.dashStyle);
  }

  // Google stores a transparent line as a fill with no colour, or none at all.
  #stroke(
    fill: RestSolidFill | undefined, weight: RestDimension | undefined, dashStyle: string | undefined,
    fallbackWeight = DEFAULT_LINE_WEIGHT,
  ): DrawnStroke | undefined {
    let solid = this.solid(fill);
    return solid && {
      ...solid, weight: lengthOf(weight) || fallbackWeight,
      ...(dashStyle && dashStyle !== "SOLID" ? { dash: dashStyle } : {}),
    };
  }

  #shadow(shadows: (RestShadow | undefined)[]): DrawnShadow | undefined {
    let shadow = shadows.find(link => link && link.propertyState !== "INHERIT");
    if (!shadow || shadow.propertyState === "NOT_RENDERED") return undefined;
    let solid = this.solid({ color: shadow.color ?? { rgbColor: {} }, alpha: shadow.alpha ?? 1 });
    let { translateX: x = 0, translateY: y = 0, unit } = shadow.transform ?? {};
    return solid && {
      ...solid, x: points(emu({ magnitude: x, unit })), y: points(emu({ magnitude: y, unit })),
      blur: lengthOf(shadow.blurRadius) ?? 0,
    };
  }

  #pictureLook(properties: RestImageProperties | undefined) {
    let { leftOffset: left = 0, topOffset: top = 0, rightOffset: right = 0, bottomOffset: bottom = 0,
      angle = 0 } = properties?.cropProperties ?? {};
    // Google gives the cut's turn in radians. What is left of the picture must have some size.
    let turn = round(angle * 180 / Math.PI);
    let cropped = (left || top || right || bottom || turn) && left + right < 1 && top + bottom < 1;
    let opacity = 1 - (properties?.transparency ?? 0);
    let outline = this.#outline([properties?.outline]);
    let shadow = this.#shadow([properties?.shadow]);
    return {
      ...(cropped ? { crop: {
        left: round(left, 4), top: round(top, 4), right: round(right, 4), bottom: round(bottom, 4),
        ...(turn ? { angle: turn } : {}),
      } } : {}),
      ...(opacity < 1 ? { opacity: round(Math.max(opacity, 0), 3) } : {}),
      ...(properties?.brightness ? { brightness: round(properties.brightness, 3) } : {}),
      ...(properties?.contrast ? { contrast: round(properties.contrast, 3) } : {}),
      ...(outline ? { outline } : {}), ...(shadow ? { shadow } : {}),
    };
  }

  #table(table: NonNullable<RestPageElement["table"]>, scaleX: number, scaleY: number) {
    let rows = table.rows ?? 0;
    let columns = table.columns ?? 0;
    let cells: (DrawnTableCell | null)[][] =
      Array.from({ length: rows }, () => Array.from({ length: columns }, (): DrawnTableCell => ({})));
    for (let row of table.tableRows ?? []) {
      for (let cell of row.tableCells ?? []) {
        // Google omits a zero index. A merged cell appears once, at its top left.
        let r = cell.location?.rowIndex ?? 0;
        let c = cell.location?.columnIndex ?? 0;
        if (r >= rows || c >= columns || cells[r][c] === null) continue;
        let rowSpan = Math.min(cell.rowSpan ?? 1, rows - r);
        let columnSpan = Math.min(cell.columnSpan ?? 1, columns - c);
        let properties = cell.tableCellProperties;
        let text = this.#text(cell.text, [], UNFITTED);
        let fill = this.#fill([properties?.tableCellBackgroundFill]);
        let contentAlignment = CONTENT_ALIGNMENTS[properties?.contentAlignment ?? ""];
        for (let dr = 0; dr < rowSpan; dr++) for (let dc = 0; dc < columnSpan; dc++) cells[r + dr][c + dc] = null;
        cells[r][c] = {
          ...(rowSpan > 1 ? { rowSpan } : {}), ...(columnSpan > 1 ? { columnSpan } : {}),
          ...(fill ? { fill } : {}), ...(contentAlignment ? { contentAlignment } : {}),
          ...(text ? { text } : {}),
        };
      }
    }
    // A pending change to the table's rows or columns leaves its borders unknown, so they are
    // drawn as Slides draws a new table's.
    let unknown: DrawnStroke = { color: this.#theme.get("DARK1") ?? "#000000", weight: DEFAULT_BORDER_WEIGHT };
    let borders = (lines: RestBorderRow[] | undefined, count: number, length: number) =>
      Array.from({ length: count }, (_, i) => {
        let edges = new Map(lines?.[i]?.tableBorderCells?.map(edge =>
          [edge.location?.columnIndex ?? 0, edge.tableBorderProperties] as const));
        return Array.from({ length }, (_edge, j): DrawnStroke | null => {
          if (!lines) return unknown;
          let edge = edges.get(j);
          return (edge && this.#stroke(
            edge.tableBorderFill?.solidFill, edge.weight, edge.dashStyle, DEFAULT_BORDER_WEIGHT)) ?? null;
        });
      });
    let { widths, heights } = tableLinesOf(table);
    return {
      columnWidths: (widths ?? []).map(width => points(width * scaleX)),
      rowHeights: (heights ?? []).map(height => points(height * scaleY)),
      cells,
      horizontalBorders: borders(table.horizontalBorderRows, rows + 1, columns),
      verticalBorders: borders(table.verticalBorderRows, rows, columns + 1),
    };
  }

  /** Text a paragraph at a time, styled as its placeholders resolve it; none if it is empty. */
  #text(body: RestText | undefined, parents: Paragraph[][], fit: Fit): DrawnParagraph[] | undefined {
    let lists = (body?.lists ?? {}) as Record<string, RestList | undefined>;
    let paragraphs = paragraphsOf(body).map((paragraph): DrawnParagraph => {
      let level = levelOf(paragraph);
      let inherited = inheritedAt(parents, level);
      let style: RestParagraphStyle = { ...inherited.paragraph, ...paragraph.marker?.style };
      let drawn: DrawnParagraph = { runs: [] };
      for (let run of paragraph.runs) {
        let look = this.#textStyle({ ...inherited.text, ...run.style }, fit.scale);
        let link = linkOf(run.style?.link);
        // Runs an edit split apart that draw alike are drawn as one.
        let last = drawn.runs.at(-1);
        let same = last && JSON.stringify({ ...last, text: "" }) === JSON.stringify({ ...look, text: "", ...(link ? { link } : {}) });
        if (last && same) last.text += run.text;
        else drawn.runs.push({ ...look, text: run.text, ...(link ? { link } : {}) });
      }
      // An empty paragraph is still a line, as tall as its newline's style makes it.
      if (drawn.runs.length === 0) {
        drawn.runs.push({ ...this.#textStyle({ ...inherited.text, ...paragraph.end }, fit.scale), text: "" });
      }
      let alignment = ALIGNMENTS[style.alignment ?? ""];
      if (alignment) drawn.alignment = alignment;
      if (style.direction === "RIGHT_TO_LEFT") drawn.rightToLeft = true;
      // Google closes lines up by points of the percentage.
      let lineSpacing = round((style.lineSpacing ?? 100) - fit.reduction);
      if (lineSpacing !== 100 && lineSpacing > 0) drawn.lineSpacing = lineSpacing;
      for (let key of ["spaceAbove", "spaceBelow", "indentStart", "indentEnd", "indentFirstLine"] as const) {
        let length = lengthOf(style[key]);
        if (length) drawn[key] = length;
      }
      let bullet = paragraph.marker?.bullet;
      if (bullet) {
        let listed = lists[bullet.listId ?? ""]?.nestingLevel?.[level]?.bulletStyle;
        // A bullet is drawn as its paragraph's first character, but never as a link.
        let { link: _link, underline: _underline, strikethrough: _strikethrough, ...first } = {
          ...inherited.text, ...paragraph.runs[0]?.style ?? paragraph.end, ...listed, ...bullet.bulletStyle,
        };
        drawn.bullet = { glyph: bullet.glyph || "●", ...this.#textStyle(first, fit.scale) };
      }
      return drawn;
    });
    return paragraphs.some(paragraph => paragraph.bullet || paragraph.runs.some(run => run.text))
      ? paragraphs : undefined;
  }

  /**
   * A run's or bullet's style in full. Text that sets no colour is the theme's first dark colour,
   * and a link that sets none the theme's link colour, underlined. Bold text is drawn at 700
   * unless its font is weightier, and at the font's own weight otherwise.
   */
  #textStyle(style: RestTextStyle, scale: number): DrawnTextStyle {
    let weight = style.weightedFontFamily?.weight ?? REGULAR_WEIGHT;
    let link = style.link !== undefined;
    let highlight = this.color(style.backgroundColor?.opaqueColor);
    let baseline = BASELINES[style.baselineOffset ?? ""];
    return {
      fontFamily: style.weightedFontFamily?.fontFamily ?? style.fontFamily ?? DEFAULT_FONT,
      fontSize: round((lengthOf(style.fontSize) || DEFAULT_FONT_SIZE) * scale),
      fontWeight: style.bold && weight < BOLD_WEIGHT ? (weight < REGULAR_WEIGHT ? REGULAR_WEIGHT : BOLD_WEIGHT) : weight,
      ...(style.italic ? { italic: true } : {}),
      ...(style.underline ?? link ? { underline: true } : {}),
      ...(style.strikethrough ? { strikethrough: true } : {}),
      ...(style.smallCaps ? { smallCaps: true } : {}),
      color: this.color(style.foregroundColor?.opaqueColor)
        ?? (link ? this.#theme.get("HYPERLINK") : undefined) ?? this.#theme.get("DARK1") ?? "#000000",
      ...(highlight ? { highlight } : {}),
      ...(baseline ? { baseline } : {}),
    };
  }
}

/** Which way is out of a box, at a point on its edge: along the normal of the side nearest it. */
function outwardAt({ x, y, width, height }: SlideBounds, point: SlidePoint): SlidePoint {
  let sides = [
    [Math.abs(point.x - x), -1, 0], [Math.abs(point.x - x - width), 1, 0],
    [Math.abs(point.y - y), 0, -1], [Math.abs(point.y - y - height), 0, 1],
  ];
  let [, dx, dy] = sides.toSorted(([a], [b]) => a - b)[0];
  return { x: dx, y: dy };
}

function linkOf(link: RestTextStyle["link"]): DrawnParagraph["runs"][number]["link"] {
  if (!link) return undefined;
  if (link.url) return link.url;
  if (link.pageObjectId) return { slideId: link.pageObjectId };
  let relative = ({ NEXT_SLIDE: "next", PREVIOUS_SLIDE: "previous", FIRST_SLIDE: "first", LAST_SLIDE: "last" } as const)[
    link.relativeLink ?? ""];
  return relative ? { relative } : { slideIndex: link.slideIndex ?? 0 };
}

function speakerNotesOf(properties: RestSlide["slideProperties"]): string {
  let page = properties?.notesPage;
  let id = page?.notesProperties?.speakerNotesObjectId;
  let body = page?.pageElements?.find(element => id && element.objectId === id)?.shape?.text;
  return paragraphsOf(body).map(paragraph => paragraph.runs.map(run => run.text).join("")).join("\n");
}

/**
 * The slide `id` of `deck` as it is drawn, or undefined if `deck` does not hold it. `deck`'s
 * masters and layouts carry their elements. `changesOf` says which pending changes touched an
 * element, for a deck with them applied. `geometry` holds, by element, the outlines the API does
 * not report (see `slides-export.ts`).
 */
export function drawSlide(
  deck: Deck, id: string, changesOf: ElementChanges = () => [],
  geometry: ReadonlyMap<string, ShapeGeometry> = new Map(),
): DrawnPage | undefined {
  let slide = deck.slides.get(id);
  if (!slide) return undefined;
  let layoutId = slide.slideProperties?.layoutObjectId;
  let layout = layoutId === undefined ? undefined : deck.themePages.get(layoutId);
  let masterId = deck.masters.get(id) ?? slide.slideProperties?.masterObjectId
    ?? layout?.layoutProperties?.masterObjectId;
  let master = masterId === undefined ? undefined : deck.themePages.get(masterId);
  let page = new Page([master, layout], master, changesOf, geometry);

  let behind = ([["master", master], ["layout", layout]] as const).map(([from, theme]) => {
    let drawn: DrawnElement[] = [];
    for (let element of theme?.pageElements ?? []) {
      if (!element.shape?.placeholder) page.draw(element, drawn, from);
    }
    page.straighten(drawn);
    return drawn;
  }).filter(drawn => drawn.length > 0);
  let elements: DrawnElement[] = [];
  for (let element of slide.pageElements ?? []) page.draw(element, elements);
  page.straighten(elements);

  let background: DrawnSlide["background"];
  for (let from of [slide, layout, master]) {
    let fill = from?.pageProperties?.pageBackgroundFill;
    if (!fill || fill.propertyState === "INHERIT") continue;
    if (fill.propertyState === "NOT_RENDERED") break;
    let picture = fill.stretchedPictureFill;
    if (picture?.contentUrl && from?.objectId) {
      page.pictures.set(from.objectId, { contentUrl: picture.contentUrl, side: Infinity });
    }
    background = picture
      ? (picture.contentUrl && from?.objectId ? { pictureId: from.objectId } : {})
      : page.solid(fill.solidFill);
    break;
  }
  return {
    slide: {
      ...(background ? { background } : {}), elements,
      speakerNotes: speakerNotesOf(slide.slideProperties),
    },
    behind,
    pictures: page.pictures,
  };
}

/** The most font families a listing names. */
const MAX_FONT_FAMILIES = 40;

/**
 * The font families the text styles anywhere in `deck` name, each with the weights it is named
 * at. Which run inherits which family is not worked out, so every family lists bold, and is
 * italic, when any text of the deck is.
 */
export function fontsOf(deck: RestPresentation): SlideFont[] {
  let weights = new Map<string, Set<number>>();
  let add = (family: string, weight: number) => weights.set(family, (weights.get(family) ?? new Set()).add(weight));
  let bold = false;
  let italic = false;
  let visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    let { weightedFontFamily: weighted, fontFamily, ...rest } = value as RestTextStyle;
    let family = weighted?.fontFamily ?? fontFamily;
    if (typeof family === "string" && family) add(family, weighted?.weight ?? REGULAR_WEIGHT);
    bold ||= rest.bold === true;
    italic ||= rest.italic === true;
    Object.values(rest).forEach(visit);
  };
  visit(deck);
  return [...weights].toSorted(([a], [b]) => a.localeCompare(b)).slice(0, MAX_FONT_FAMILIES)
    .map(([family, set]) => ({
      family, weights: [...bold ? set.add(BOLD_WEIGHT) : set].toSorted((a, b) => a - b), italic,
    }));
}
