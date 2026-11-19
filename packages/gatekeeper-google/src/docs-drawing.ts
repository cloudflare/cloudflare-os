// A Google Doc tab as Google Docs draws it: its page, sections, headers and footers, and every
// paragraph, table and object with its style in full. Read by previews
// (GoogleDocSession.readDrawing()), whose types are in docs-rendering-types.d.ts.

import {
  docsLinkDestination,
  type Border, type EmbeddedObject, type GoogleDocsTab, type Paragraph, type ParagraphElement,
  type ParagraphStyle, type Positioning, type SectionStyle, type StructuralElement, type Table,
  type TextStyle,
} from "./docs-api";
import { cssColor, drawnTableCells, fill, lineCounter, points } from "./docs-styles";
import type { Segment } from "./markdown-converter";
import type {
  GoogleDocBlock, GoogleDocBorder, GoogleDocTableCell, GoogleDocDrawing, GoogleDocListLevel,
  GoogleDocObject, GoogleDocParagraph, GoogleDocParagraphLook, GoogleDocRun, GoogleDocSection,
  GoogleDocTable, GoogleDocTextLook,
} from "./docs-rendering-types";

/**
 * Version of the drawing a snapshot holds. Bump it whenever what this module returns changes, so
 * a snapshot cached by older code is read again.
 */
export const DOC_DRAWING_VERSION = 3;

/**
 * How far a header starts below the top of the page, how far a footer ends above its foot, and
 * what is kept clear under a header deeper than the top margin, in a document that does not keep
 * to `marginHeader` and `marginFooter`: one from before Google Docs had them, which it still lays
 * out as it did then. Measured from its pages.
 */
const UNSET_HEADER_MARGIN = 5;
const UNSET_FOOTER_MARGIN = -3.6;
const UNSET_HEADER_GAP = 6;

/** The ID a header or footer is drawn under when Google Docs returned none for it. */
const UNRETURNED = "unreturned";

/** Where a block of a tab's body starts in its Markdown, with a paragraph's source-map segments. */
export type DocBlockPlace = { mdStart: number; segments?: Segment[] };

/** A tab's drawing, and where Google serves each of its images for a short while. */
export type DocTabDrawing = { drawing: GoogleDocDrawing; imageUris: Record<string, string> };

/** `value` without the entries that say nothing: undefined and zero. */
function set<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== 0)) as T;
}

const DASH = { DOT: "dot", DASH: "dash" } as const;

/** A border that is drawn: one with a width. `fallback` is the width of one that names none. */
function border(edge: Border | undefined, fallback?: number): GoogleDocBorder | undefined {
  let width = points(edge?.width) ?? fallback;
  if (!width) return undefined;
  return set({
    width,
    color: cssColor(edge?.color) ?? "#000000",
    dash: DASH[edge?.dashStyle as keyof typeof DASH],
    padding: points(edge?.padding),
  });
}

/** The weight text is drawn at: Google Docs makes bold a step up from the family's own weight. */
function drawnWeight({ bold, weightedFontFamily }: TextStyle): number {
  let weight = weightedFontFamily?.weight ?? 400;
  if (!bold) return weight;
  return weight < 400 ? 400 : weight < 700 ? 700 : 900;
}

function textLook(style: TextStyle): GoogleDocTextLook {
  return set({
    fontFamily: style.weightedFontFamily?.fontFamily ?? "Arial",
    fontSize: points(style.fontSize) ?? 11,
    weight: drawnWeight(style),
    italic: style.italic || undefined,
    underline: style.underline || undefined,
    strikethrough: style.strikethrough || undefined,
    smallCaps: style.smallCaps || undefined,
    baseline: ({ SUPERSCRIPT: "super", SUBSCRIPT: "sub" } as const)[style.baselineOffset as "SUPERSCRIPT"],
    color: cssColor(style.foregroundColor),
    highlight: fill(style.backgroundColor),
  } satisfies { [key in keyof GoogleDocTextLook]: unknown }) as GoogleDocTextLook;
}

const ALIGNMENT = { CENTER: "center", END: "end", JUSTIFIED: "justify" } as const;
const TAB_ALIGNMENT = { START: "start", CENTER: "center", END: "end" } as const;

function paragraphLook(style: Partial<ParagraphStyle>): GoogleDocParagraphLook {
  let borders = set({
    top: border(style.borderTop),
    right: border(style.borderRight),
    bottom: border(style.borderBottom),
    left: border(style.borderLeft),
    between: border(style.borderBetween),
  });
  let tabStops = (style.tabStops ?? []).flatMap(stop => {
    let alignment = TAB_ALIGNMENT[stop.alignment as keyof typeof TAB_ALIGNMENT];
    return alignment ? [{ offset: points(stop.offset) ?? 0, alignment }] : [];
  });
  return {
    lineSpacing: (style.lineSpacing ?? 100) / 100,
    ...set({
      alignment: ALIGNMENT[style.alignment as keyof typeof ALIGNMENT],
      rightToLeft: style.direction === "RIGHT_TO_LEFT" || undefined,
      spaceAbove: points(style.spaceAbove),
      spaceBelow: points(style.spaceBelow),
      indentStart: points(style.indentStart),
      indentEnd: points(style.indentEnd),
      indentFirstLine: points(style.indentFirstLine),
      shading: fill(style.shading?.backgroundColor),
      keepWithNext: style.keepWithNext || undefined,
      keepLinesTogether: style.keepLinesTogether || undefined,
      avoidWidowAndOrphan: style.avoidWidowAndOrphan || undefined,
      pageBreakBefore: style.pageBreakBefore || undefined,
    }),
    ...Object.keys(borders).length ? { borders } : {},
    ...tabStops.length ? { tabStops } : {},
  };
}

/** Gives each distinct value one place in `list`, and answers with that place. */
function placer<T>(list: T[]): (value: T) => number {
  let places = new Map<string, number>();
  return value => {
    let key = JSON.stringify(value);
    let place = places.get(key);
    if (place === undefined) places.set(key, place = list.push(value) - 1);
    return place;
  };
}

const NUMBERING = {
  DECIMAL: "decimal", ZERO_DECIMAL: "zeroDecimal", ALPHA: "alpha", UPPER_ALPHA: "upperAlpha",
  ROMAN: "roman", UPPER_ROMAN: "upperRoman",
} as const;

const LAYOUT = {
  WRAP_TEXT: "wrap", BREAK_LEFT: "breakLeft", BREAK_RIGHT: "breakRight",
  BREAK_LEFT_RIGHT: "breakBoth", IN_FRONT_OF_TEXT: "front", BEHIND_TEXT: "behind",
} as const;

/** The four sides of `of`, as top, right, bottom and left, or nothing when all are zero. */
function sides(of: (side: "Top" | "Right" | "Bottom" | "Left") => number | undefined)
    : [number, number, number, number] | undefined {
  let all = (["Top", "Right", "Bottom", "Left"] as const).map(side => of(side) ?? 0);
  return all.some(Boolean) ? all as [number, number, number, number] : undefined;
}

function drawnObject(object: EmbeddedObject | undefined, positioning?: Positioning)
    : { object: GoogleDocObject; uri?: string } {
  let image = object?.imageProperties;
  let { offsetTop: top = 0, offsetRight: right = 0, offsetBottom: bottom = 0, offsetLeft: left = 0 } =
    image?.cropProperties ?? {};
  let edge = object?.embeddedObjectBorder;
  let layout = LAYOUT[positioning?.layout as keyof typeof LAYOUT];
  let description = object?.description || object?.title;
  return {
    uri: image?.contentUri,
    object: {
      width: object?.size?.width?.magnitude ?? 0,
      height: object?.size?.height?.magnitude ?? 0,
      readable: image?.contentUri !== undefined,
      ...set({
        margins: sides(side => points(object?.[`margin${side}`])),
        description,
        crop: top || right || bottom || left ? { top, right, bottom, left } : undefined,
        angle: image?.angle,
        transparency: image?.transparency,
        border: edge?.propertyState === "NOT_RENDERED" ? undefined : border(edge),
        placed: positioning && {
          left: points(positioning.leftOffset) ?? 0,
          top: points(positioning.topOffset) ?? 0,
          layout: layout ?? "wrap",
        },
      }),
    },
  };
}

/**
 * The drawing of `tab`, whose body's blocks start at `places` in its rendered `markdown`. A block
 * `places` does not name, as none of a header or a table cell is, has no line.
 */
export function docTabDrawing(
  tab: GoogleDocsTab,
  markdown: string,
  places: Map<StructuralElement, DocBlockPlace>,
): DocTabDrawing {
  let named = new Map((tab.namedStyles?.styles ?? []).map(style => [style.namedStyleType, style]));
  let normal = named.get("NORMAL_TEXT");
  let paragraphStyleOf = (name: string): Partial<ParagraphStyle> =>
    ({ ...normal?.paragraphStyle, ...named.get(name)?.paragraphStyle });
  let textStyleOf = (name: string): TextStyle =>
    ({ ...normal?.textStyle, ...named.get(name)?.textStyle });

  let paragraphLooks: GoogleDocParagraphLook[] = [];
  let textLooks: GoogleDocTextLook[] = [];
  let paragraphPlace = placer(paragraphLooks);
  let textPlace = placer(textLooks);
  let objects: Record<string, GoogleDocObject> = {};
  let imageUris: Record<string, string> = {};
  let lists: Record<string, GoogleDocListLevel[]> = {};
  let lineOf = lineCounter(markdown);

  let addObject = (id: string, embedded: EmbeddedObject | undefined, positioning?: Positioning) => {
    if (objects[id]) return;
    let { object, uri } = drawnObject(embedded, positioning);
    objects[id] = object;
    if (uri) imageUris[id] = uri;
  };

  let addList = (id: string) => {
    lists[id] ??= (tab.lists[id]?.listProperties.nestingLevels ?? []).map((level, depth) => {
      let numbering = NUMBERING[level.glyphType as keyof typeof NUMBERING];
      // A checklist's level names neither a number nor a symbol.
      let symbol = level.glyphSymbol ?? (numbering || level.glyphType === "NONE" ? undefined : "☐");
      return {
        format: level.glyphType === "NONE" ? "" : level.glyphFormat ?? `%${depth}`,
        ...set({
          numbering,
          symbol,
          alignment: ({ CENTER: "center", END: "end" } as const)[level.bulletAlignment as "CENTER"],
        }),
        start: level.startNumber ?? 1,
        indentFirstLine: points(level.indentFirstLine) ?? 0,
        indentStart: points(level.indentStart) ?? 0,
      };
    });
  };

  /** The runs of `element`, set over `base`: its text where `segments` place it in the Markdown. */
  let runsOf = (
    element: ParagraphElement, base: TextStyle, last: boolean, lineStart: number,
    segments: Segment[] | undefined,
  ): GoogleDocRun[] => {
    let look = (style: TextStyle | undefined) => textPlace(textLook({ ...base, ...style }));
    let { textRun } = element;
    if (textRun) {
      let { textStyle } = textRun;
      let link = docsLinkDestination(textStyle.link);
      let run = { look: look(textStyle), ...link ? { link } : {} };
      let placed = (segments ?? []).filter(segment => "docStart" in segment &&
        segment.docStart >= element.startIndex && segment.docStart < element.endIndex);
      if (placed.length) {
        return placed.map(({ mdStart, mdEnd }) =>
          ({ ...run, text: markdown.slice(mdStart, mdEnd), at: mdStart - lineStart }));
      }
      // The paragraph's own end is not text.
      let text = last ? textRun.content.replace(/\n$/, "") : textRun.content;
      return text ? [{ ...run, text }] : [];
    }
    if (element.inlineObjectElement) {
      let { inlineObjectId: id, textStyle } = element.inlineObjectElement;
      if (id === undefined) return [{ look: look(textStyle), chip: "Image" }];
      addObject(id, tab.inlineObjects?.[id]?.inlineObjectProperties?.embeddedObject);
      return [{ look: look(textStyle), object: id }];
    }
    if (element.pageBreak) return [{ look: look(element.pageBreak.textStyle), break: "page" }];
    if (element.columnBreak) return [{ look: look(element.columnBreak.textStyle), break: "column" }];
    if (element.horizontalRule) return [{ look: look(undefined), rule: true }];
    if (element.equation) return [{ look: look(undefined), equation: true }];
    if (element.autoText) {
      let { type, textStyle } = element.autoText;
      let field = ({ PAGE_NUMBER: "pageNumber", PAGE_COUNT: "pageCount" } as const)[type as "PAGE_NUMBER"];
      return field ? [{ look: look(textStyle), field }] : [];
    }
    if (element.footnoteReference) {
      let { footnoteId, footnoteNumber, textStyle } = element.footnoteReference;
      return footnoteId === undefined ? []
        : [{ look: look(textStyle), footnote: footnoteId, mark: footnoteNumber ?? "" }];
    }
    let { person, richLink, dateElement } = element;
    let chip = person?.personProperties?.name || person?.personProperties?.email ||
      richLink?.richLinkProperties?.title || dateElement?.dateElementProperties?.displayText;
    if (!chip) return [];
    let link = richLink?.richLinkProperties?.uri;
    return [{
      look: look((person ?? richLink ?? dateElement)?.textStyle), chip, ...link ? { link } : {},
    }];
  };

  /** Whether the paragraph at `at` of `content` is an item of the list `paragraph` is in. */
  let besideItem = (content: StructuralElement[], at: number, paragraph: Paragraph) =>
    content[at]?.paragraph?.bullet?.listId === paragraph.bullet?.listId;

  let drawParagraph = (content: StructuralElement[], at: number): GoogleDocParagraph => {
    let element = content[at];
    let paragraph = element.paragraph!;
    let place = places.get(element);
    let name = paragraph.paragraphStyle.namedStyleType;
    let style = { ...paragraphStyleOf(name), ...paragraph.paragraphStyle };
    let base = textStyleOf(name);
    let { bullet } = paragraph;
    let level = bullet && tab.lists[bullet.listId]?.listProperties.nestingLevels[bullet.nestingLevel ?? 0];
    if (bullet) {
      addList(bullet.listId);
      style = {
        ...level?.indentStart ? { indentStart: level.indentStart } : {},
        ...level?.indentFirstLine ? { indentFirstLine: level.indentFirstLine } : {},
        ...style,
        // A list item that collapses its spacing has none on the side of another item of its list.
        ...style.spacingMode === "COLLAPSE_LISTS" ? {
          ...besideItem(content, at - 1, paragraph) ? { spaceAbove: {} } : {},
          ...besideItem(content, at + 1, paragraph) ? { spaceBelow: {} } : {},
        } : {},
      };
    }
    for (let id of paragraph.positionedObjectIds ?? []) {
      let properties = tab.positionedObjects?.[id]?.positionedObjectProperties;
      addObject(id, properties?.embeddedObject, properties?.positioning ?? {});
    }
    let lineStart = place?.mdStart ?? 0;
    let lastElement = paragraph.elements.at(-1);
    let { headingId } = paragraph.paragraphStyle;
    return {
      type: "paragraph",
      ...place ? { line: lineOf(place.mdStart) } : {},
      style: name,
      ...headingId ? { headingId } : {},
      look: paragraphPlace(paragraphLook(style)),
      end: textPlace(textLook({ ...base, ...lastElement?.textRun?.textStyle })),
      ...bullet ? {
        list: {
          id: bullet.listId,
          level: bullet.nestingLevel ?? 0,
          look: textPlace(textLook({ ...base, ...level?.textStyle, ...bullet.textStyle })),
        },
      } : {},
      runs: paragraph.elements.flatMap(part =>
        runsOf(part, base, part === lastElement, lineStart, place?.segments)),
      ...paragraph.positionedObjectIds?.length ? { objects: paragraph.positionedObjectIds } : {},
    };
  };

  let drawTable = (table: Table, line: number | undefined): GoogleDocTable => {
    let rows = table.tableRows ?? [];
    let drawn = drawnTableCells(table);
    let widths = (table.tableStyle?.tableColumnProperties ?? []).map(column =>
      column.widthType === "FIXED_WIDTH" ? points(column.width) ?? 0 : 0);
    let columns = Math.max(widths.length, ...rows.map(row => row.tableCells?.length ?? 0));
    return {
      type: "table",
      ...line === undefined ? {} : { line },
      columns: Array.from({ length: columns }, (_, column) => widths[column] ?? 0),
      rows: rows.map((row, rowIndex) => ({
        ...set({
          minHeight: points(row.tableRowStyle?.minRowHeight),
          header: row.tableRowStyle?.tableHeader || undefined,
          unbroken: row.tableRowStyle?.preventOverflow || undefined,
        }),
        cells: drawn[rowIndex].map((cell): GoogleDocTableCell => {
          let style = cell.tableCellStyle ?? {};
          return {
            column: row.tableCells!.indexOf(cell),
            ...set({
              rowSpan: (style.rowSpan ?? 1) > 1 ? style.rowSpan : undefined,
              columnSpan: (style.columnSpan ?? 1) > 1 ? style.columnSpan : undefined,
              background: fill(style.backgroundColor),
              verticalAlign: ({ MIDDLE: "middle", BOTTOM: "bottom" } as const)[style.contentAlignment as "MIDDLE"],
            }),
            // Google Docs pads a cell by 5pt where it says nothing.
            padding: (["Top", "Right", "Bottom", "Left"] as const)
              .map(side => points(style[`padding${side}`]) ?? 5) as [number, number, number, number],
            // And draws a 1pt line where an edge names no width.
            borders: set({
              top: border(style.borderTop, 1),
              right: border(style.borderRight, 1),
              bottom: border(style.borderBottom, 1),
              left: border(style.borderLeft, 1),
            }),
            blocks: drawBlocks(cell.content ?? []),
          };
        }),
      })),
    };
  };

  let sections: GoogleDocSection[] = [];
  let document = tab.documentStyle ?? {};
  let addSection = (style: SectionStyle = {}): number => {
    let before = sections.at(-1);
    let margin = (side: "Top" | "Right" | "Bottom" | "Left" | "Header" | "Footer", fallback: number) =>
      points(style[`margin${side}`]) ?? points(document[`margin${side}`]) ?? fallback;
    let columns = (style.columnProperties ?? []).map(column =>
      ({ width: points(column.width) ?? 0, gap: points(column.paddingEnd) ?? 0 }));
    return sections.push({
      ...set({
        newPage: sections.length > 0 && style.sectionType === "NEXT_PAGE" || undefined,
        landscape: (style.flipPageOrientation ?? document.flipPageOrientation) || undefined,
      }),
      margins: {
        top: margin("Top", 72), right: margin("Right", 72), bottom: margin("Bottom", 72),
        left: margin("Left", 72),
        header: document.useCustomHeaderFooterMargins ? margin("Header", 36) : UNSET_HEADER_MARGIN,
        footer: document.useCustomHeaderFooterMargins ? margin("Footer", 36) : UNSET_FOOTER_MARGIN,
      },
      ...document.useCustomHeaderFooterMargins ? {} : { headerGap: UNSET_HEADER_GAP },
      ...columns.length > 1 ? { columns } : {},
      ...set({
        columnRule: columns.length > 1 && style.columnSeparatorStyle === "BETWEEN_EACH_COLUMN" || undefined,
        // A section that names none takes those of the section before it, and the first the document's.
        header: style.defaultHeaderId ?? (before ? before.header : document.defaultHeaderId),
        footer: style.defaultFooterId ?? (before ? before.footer : document.defaultFooterId),
        firstHeader: style.firstPageHeaderId ?? (before ? before.firstHeader : document.firstPageHeaderId),
        firstFooter: style.firstPageFooterId ?? (before ? before.firstFooter : document.firstPageFooterId),
        firstPage: (style.useFirstPageHeaderFooter ?? document.useFirstPageHeaderFooter) || undefined,
        evenHeader: style.evenPageHeaderId ?? (before ? before.evenHeader : document.evenPageHeaderId),
        evenFooter: style.evenPageFooterId ?? (before ? before.evenFooter : document.evenPageFooterId),
        pageNumberStart: style.pageNumberStart ??
          (before || (document.pageNumberStart ?? 1) === 1 ? undefined : document.pageNumberStart),
      }),
    }) - 1;
  };

  let drawBlocks = (content: StructuralElement[]): GoogleDocBlock[] =>
    content.flatMap((element, at): GoogleDocBlock[] => {
      if (element.paragraph) return [drawParagraph(content, at)];
      let place = places.get(element);
      let line = place ? { line: lineOf(place.mdStart) } : {};
      if (element.table) return [drawTable(element.table, line.line)];
      if (element.tableOfContents) {
        return [{ type: "contents", ...line, blocks: drawBlocks(element.tableOfContents.content ?? []) }];
      }
      if (element.sectionBreak) {
        // The break a body opens with starts its first section, and is no block of it.
        let section = addSection(element.sectionBreak.sectionStyle);
        return section === 0 ? [] : [{ type: "section", ...line, section }];
      }
      return [];
    });

  let blocks = drawBlocks(tab.body.content);
  if (sections.length === 0) addSection();
  let parts = (of: Record<string, { content?: StructuralElement[] }> | undefined) =>
    Object.fromEntries(Object.entries(of ?? {}).map(([id, part]) => [id, drawBlocks(part.content ?? [])]));
  let headers = parts(tab.headers);
  let footers = parts(tab.footers);
  let footnotes = parts(tab.footnotes);

  // For some documents with a first page of its own, Google Docs returns neither the header nor
  // the footer of the other pages, only the objects tethered in them. Each is drawn where the
  // object nearest it is drawn on the first page, in a paragraph set as that one is.
  let returned = [["header", headers], ["footer", footers]] as const;
  let unreturned: { header?: GoogleDocParagraph; footer?: GoogleDocParagraph } = {};
  for (let [id, { positionedObjectProperties: properties }] of Object.entries(tab.positionedObjects ?? {})) {
    if (objects[id]) continue;
    let { object: { placed } } = drawnObject(properties?.embeddedObject, properties?.positioning ?? {});
    let nearest: { kind: "header" | "footer"; paragraph: GoogleDocParagraph; distance: number } | undefined;
    for (let [kind, part] of returned) {
      for (let paragraph of Object.values(part).flat()) {
        if (paragraph.type !== "paragraph") continue;
        for (let other of paragraph.objects ?? []) {
          let beside = objects[other]?.placed;
          if (!beside) continue;
          let distance = Math.abs(beside.left - placed!.left) + Math.abs(beside.top - placed!.top);
          if (!nearest || distance < nearest.distance) nearest = { kind, paragraph, distance };
        }
      }
    }
    if (!nearest) continue;
    addObject(id, properties?.embeddedObject, properties?.positioning ?? {});
    (unreturned[nearest.kind] ??= { ...nearest.paragraph, runs: [], objects: [] }).objects!.push(id);
  }
  for (let [kind, part] of returned) {
    let paragraph = unreturned[kind];
    if (!paragraph) continue;
    part[UNRETURNED] = [paragraph];
    for (let section of sections) section[kind] ||= UNRETURNED;
  }

  let background = fill(document.background?.color);
  return {
    imageUris,
    drawing: {
      ...document.documentFormat?.documentMode === "PAGELESS" ? { pageless: true as const } : {},
      page: {
        width: points(document.pageSize?.width) ?? 612,
        height: points(document.pageSize?.height) ?? 792,
        ...background ? { background } : {},
      },
      ...document.useEvenPageHeaderFooter ? { evenPages: true as const } : {},
      sections,
      blocks,
      headers,
      footers,
      footnotes,
      lists,
      objects,
      paragraphLooks,
      textLooks,
      named: Object.fromEntries([...named.keys()].flatMap(name => name === undefined ? [] : [[name, {
        paragraph: paragraphPlace(paragraphLook(paragraphStyleOf(name))),
        text: textPlace(textLook(textStyleOf(name))),
      }]])),
    },
  };
}
