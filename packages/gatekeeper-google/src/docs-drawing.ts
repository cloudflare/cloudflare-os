// A Google Doc tab as Google Docs draws it: its page, sections, headers and footers, and every
// paragraph, table and object with its style in full; and what pending edits put in place of
// parts of its body, as the same blocks with the looks the copy keeps. Read by previews
// (GoogleDocSession.readDrawing() and readPendingDrawing()), whose types are in
// docs-rendering-types.d.ts.

import type {
  Border, Bullet, Dimension, DrawnDocumentTab, DrawnElement, DrawnParagraphStyle, DrawnTextStyle,
  EmbeddedObject, OptionalColor, Paragraph, ParagraphElement, Positioning, SectionStyle, Table,
  TableCell, TextStyle,
} from "./docs-api";
import type { ChangedElements } from "./docs-changed-elements";
import type {
  GoogleDocBlock, GoogleDocBorder, GoogleDocTableCell, GoogleDocDrawing, GoogleDocListLevel,
  GoogleDocObject, GoogleDocParagraph, GoogleDocParagraphLook, GoogleDocPendingBlock,
  GoogleDocPendingDrawing, GoogleDocPendingParagraphLook, GoogleDocPendingTextLook, GoogleDocRun,
  GoogleDocSection, GoogleDocTable, GoogleDocTextLook,
} from "./docs-rendering-types";

/**
 * How far a header starts below the top of the page, how far a footer ends above its foot, and
 * what is kept clear under a header deeper than the top margin, in a document that does not keep
 * to `marginHeader` and `marginFooter`: one from before Google Docs had them, which it still lays
 * out as it did then. Measured from its pages.
 */
const UNSET_HEADER_MARGIN = 5.25;
const UNSET_FOOTER_MARGIN = -3.6;
const UNSET_HEADER_GAP = 5.25;

/**
 * What Google Docs pads a cell by, above, after, below and before its text, where the cell states
 * none. A table made in Google Docs states 5pt all round; one brought in from Word states
 * nothing, and is drawn as Word set it. Measured from its pages.
 */
const UNSTATED_PADDING = [0, 5.4, 0, 5.4];

/** The ID a header or footer is drawn under when Google Docs returned none for it. */
const UNRETURNED = "unreturned";

/** A length in points. Google leaves a zero out of its JSON, so one that is absent is zero. */
const points = (length: Dimension | undefined) => length && (length.magnitude ?? 0);

/** A color as `#rrggbb`, a channel Google leaves out being zero. */
function cssColor(color: OptionalColor | undefined): string | undefined {
  let rgb = color?.color?.rgbColor;
  if (!rgb) return undefined;
  let channel = (value = 0) => Math.round(value * 255).toString(16).padStart(2, "0");
  return `#${channel(rgb.red)}${channel(rgb.green)}${channel(rgb.blue)}`;
}

const WHITE = "#ffffff";

/**
 * The color that fills behind text drawn over the color `behind`: the page's, or that of the cell
 * or the paragraph the text is in. That color itself is no fill: pasted text often carries a
 * white one, which shows only where what is behind it is not white.
 */
const fill = (color: OptionalColor | undefined, behind: string | undefined) => {
  let css = cssColor(color);
  return css === behind ? undefined : css;
};

/** Whether `cell` has no text, as the cells a merged one covers have none. */
const isBlank = (cell: TableCell) => (cell.content ?? []).every(({ paragraph }) =>
  paragraph?.elements.every(({ textRun }) => textRun && !textRun.content.trim()));

/**
 * The cells of `table` that are drawn, a row at a time. Google lists every grid position, so the
 * ones a merged cell covers are left out: they hold nothing, and the merged cell spans them. One
 * that holds text all the same is kept, at its place, for its reader to make of it what it will.
 */
function drawnTableCells(table: Table): TableCell[][] {
  let covered = new Set<string>();
  return (table.tableRows ?? []).map((row, rowIndex) =>
    (row.tableCells ?? []).filter((cell, columnIndex) => {
      if (covered.has(`${rowIndex},${columnIndex}`) && isBlank(cell)) return false;
      let { rowSpan = 1, columnSpan = 1 } = cell.tableCellStyle ?? {};
      for (let down = 0; down < rowSpan; down++) {
        for (let across = 0; across < columnSpan; across++) {
          covered.add(`${rowIndex + down},${columnIndex + across}`);
        }
      }
      return true;
    }));
}

/** `value` without the entries that say nothing: those undefined and, unless `zeros` say something, zero. */
function set<T extends object>(value: T, zeros = false): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) =>
    entry !== undefined && (zeros || entry !== 0))) as T;
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

/** The weight text is drawn at: Google Docs makes bold of a family lighter than bold a step up from its own weight. */
function drawnWeight({ bold, weightedFontFamily }: DrawnTextStyle): number {
  let weight = weightedFontFamily?.weight ?? 400;
  if (!bold) return weight;
  return weight < 400 ? 400 : Math.max(weight, 700);
}

function textLook(style: DrawnTextStyle, behind: string | undefined): GoogleDocTextLook {
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
    highlight: fill(style.backgroundColor, behind),
  } satisfies { [key in keyof GoogleDocTextLook]: unknown }) as GoogleDocTextLook;
}

/** What the copy keeps of a text style, as it states it: a `false` and an absence are told apart. */
const statedTextLook = (style: DrawnTextStyle): GoogleDocPendingTextLook => set({
  bold: style.bold,
  italic: style.italic,
  underline: style.underline,
  strikethrough: style.strikethrough,
  fontSize: points(style.fontSize),
  color: cssColor(style.foregroundColor),
});

const ALIGNMENT = { CENTER: "center", END: "end", JUSTIFIED: "justify" } as const;
const TAB_ALIGNMENT = { START: "start", CENTER: "center", END: "end" } as const;

/** What the copy keeps of a paragraph style, as it states it: a zero and an absence are told apart. */
const statedParagraphLook = (style: DrawnParagraphStyle): GoogleDocPendingParagraphLook => set({
  alignment: { ...ALIGNMENT, START: "start" as const }[style.alignment as keyof typeof ALIGNMENT],
  indentStart: points(style.indentStart),
  indentFirstLine: points(style.indentFirstLine),
}, true);

function paragraphLook(style: DrawnParagraphStyle, behind: string | undefined): GoogleDocParagraphLook {
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
      shading: fill(style.shading?.backgroundColor, behind),
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

function drawnObject(object: EmbeddedObject | undefined, positioning?: Positioning): GoogleDocObject {
  let image = object?.imageProperties;
  let { offsetTop: top = 0, offsetRight: right = 0, offsetBottom: bottom = 0, offsetLeft: left = 0 } =
    image?.cropProperties ?? {};
  let edge = object?.embeddedObjectBorder;
  let layout = LAYOUT[positioning?.layout as keyof typeof LAYOUT];
  let description = object?.description || object?.title;
  return {
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
  };
}

/** Where Google serves each image of `tab`, for a short while, by its object's ID. */
export function docImageUris(tab: DrawnDocumentTab): Map<string, string> {
  let objects = [
    ...Object.entries(tab.inlineObjects ?? {}).map(([id, object]) =>
      [id, object.inlineObjectProperties?.embeddedObject] as const),
    ...Object.entries(tab.positionedObjects ?? {}).map(([id, object]) =>
      [id, object.positionedObjectProperties?.embeddedObject] as const),
  ];
  return new Map(objects.flatMap(([id, object]) => {
    let uri = object?.imageProperties?.contentUri;
    return uri ? [[id, uri]] : [];
  }));
}

/** Where a link leads: an address, or a place in the document. */
function linkDestination(link: TextStyle["link"]): string | undefined {
  if (!link) return undefined;
  if ("url" in link) return link.url;
  let place = (kind: "bookmark" | "heading", id: string, tabId?: string) =>
    `${tabId ? `?tab=${encodeURIComponent(tabId)}` : ""}#${kind}=${encodeURIComponent(id)}`;
  if ("tabId" in link) return `?tab=${encodeURIComponent(link.tabId)}`;
  if ("bookmark" in link) return place("bookmark", link.bookmark.id, link.bookmark.tabId);
  if ("heading" in link) return place("heading", link.heading.id, link.heading.tabId);
  return "bookmarkId" in link ? place("bookmark", link.bookmarkId) : place("heading", link.headingId);
}

/**
 * What draws elements of `tab` as blocks, and holds what the blocks name: each paragraph's look
 * as `paragraphLook` makes it of its style and each text's as `textLook` does, over the color
 * `page`. With no page the elements are drawn apart from their tab, and a footnote's mark, its
 * number in the tab, is left empty.
 */
function drawer<P, T>(
  tab: DrawnDocumentTab,
  paragraphLook: (style: DrawnParagraphStyle, behind: string | undefined) => P,
  textLook: (style: DrawnTextStyle, behind: string | undefined) => T,
  page?: string,
) {
  // What is drawn is drawn over this: the page, or the fill of the cell or paragraph it is in.
  let behind = page;
  let over = <Drawn>(color: string | undefined, draw: () => Drawn): Drawn => {
    let was = behind;
    behind = color ?? was;
    try {
      return draw();
    } finally {
      behind = was;
    }
  };
  let named = new Map((tab.namedStyles?.styles ?? []).map(style => [style.namedStyleType, style]));
  let normal = named.get("NORMAL_TEXT");
  let paragraphStyleOf = (name: string): DrawnParagraphStyle =>
    ({ ...normal?.paragraphStyle, ...named.get(name)?.paragraphStyle });
  let textStyleOf = (name: string): DrawnTextStyle =>
    ({ ...normal?.textStyle, ...named.get(name)?.textStyle });

  let paragraphLooks: P[] = [];
  let textLooks: T[] = [];
  let paragraphPlace = placer(paragraphLooks);
  let textPlace = placer(textLooks);
  let objects: Record<string, GoogleDocObject> = {};
  let lists: Record<string, GoogleDocListLevel[]> = {};
  let levelsOf = (id: string) => tab.lists?.[id]?.listProperties?.nestingLevels ?? [];

  let addObject = (id: string, embedded: EmbeddedObject | undefined, positioning?: Positioning) => {
    objects[id] ??= drawnObject(embedded, positioning);
  };

  let addList = (id: string) => {
    lists[id] ??= levelsOf(id).map((level, depth) => {
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
        // Google starts a lettered or a Roman list at its first letter or numeral for 0 as for 1.
        start: (/alpha|roman/i.test(numbering ?? "") ? level.startNumber || 1 : level.startNumber) ?? 1,
        indentFirstLine: points(level.indentFirstLine) ?? 0,
        indentStart: points(level.indentStart) ?? 0,
      };
    });
  };

  /** The runs of `element`, set over `base`. */
  let runsOf = (element: ParagraphElement, base: DrawnTextStyle, last: boolean): GoogleDocRun[] => {
    let look = (style: DrawnTextStyle | undefined) => textPlace(textLook({ ...base, ...style }, behind));
    let { textRun } = element;
    if (textRun) {
      let { textStyle } = textRun;
      let link = linkDestination(textStyle.link);
      // The paragraph's own end is not text.
      let text = last ? textRun.content.replace(/\n$/, "") : textRun.content;
      return text ? [{ look: look(textStyle), text, ...link ? { link } : {} }] : [];
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
        : [{ look: look(textStyle), footnote: footnoteId, mark: page ? footnoteNumber ?? "" : "" }];
    }
    let { person, richLink, dateElement, dropdown } = element;
    let chip = person?.personProperties?.name || person?.personProperties?.email ||
      richLink?.richLinkProperties?.title || dateElement?.dateElementProperties?.displayText ||
      dropdown?.dropdownProperties?.displayValue ||
      // One a new row copies is set to a choice the document does not name: a chip all the same.
      (dropdown && "Dropdown");
    if (!chip) return [];
    let link = richLink?.richLinkProperties?.uri;
    return [{
      look: look((person ?? richLink ?? dateElement ?? dropdown)?.textStyle), chip, ...link ? { link } : {},
    }];
  };

  /** Whether the paragraph at `at` of `content` is an item of the list `paragraph` is in. */
  let besideItem = (content: DrawnElement[], at: number, paragraph: Paragraph) =>
    content[at]?.paragraph?.bullet?.listId === paragraph.bullet?.listId;

  let drawParagraph = (content: DrawnElement[], at: number): GoogleDocParagraph => {
    let paragraph = content[at].paragraph!;
    let name = paragraph.paragraphStyle.namedStyleType;
    let style: DrawnParagraphStyle = { ...paragraphStyleOf(name), ...paragraph.paragraphStyle };
    let base = textStyleOf(name);
    let bullet: Bullet & { textStyle?: DrawnTextStyle } | undefined = paragraph.bullet;
    let level = bullet && levelsOf(bullet.listId)[bullet.nestingLevel ?? 0];
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
    let lastElement = paragraph.elements.at(-1);
    let { headingId } = paragraph.paragraphStyle;
    let look = paragraphPlace(paragraphLook(style, behind));
    return over(fill(style.shading?.backgroundColor, behind), () => ({
      type: "paragraph",
      style: name,
      ...headingId ? { headingId } : {},
      look,
      end: textPlace(textLook({ ...base, ...lastElement?.textRun?.textStyle }, behind)),
      ...bullet ? {
        list: {
          id: bullet.listId,
          level: bullet.nestingLevel ?? 0,
          look: textPlace(textLook({ ...base, ...level?.textStyle, ...bullet.textStyle }, behind)),
        },
      } : {},
      runs: paragraph.elements.flatMap(part => runsOf(part, base, part === lastElement)),
      ...paragraph.positionedObjectIds?.length ? { objects: paragraph.positionedObjectIds } : {},
    }));
  };

  let drawTable = (table: Table): GoogleDocTable => {
    let rows = table.tableRows ?? [];
    let drawn = drawnTableCells(table);
    let widths = (table.tableStyle?.tableColumnProperties ?? []).map(column =>
      column.widthType === "FIXED_WIDTH" ? points(column.width) ?? 0 : 0);
    let columns = Math.max(widths.length, ...rows.map(row => row.tableCells?.length ?? 0));
    return {
      type: "table",
      columns: Array.from({ length: columns }, (_, column) => widths[column] ?? 0),
      rows: rows.map((row, rowIndex) => ({
        ...set({
          minHeight: points(row.tableRowStyle?.minRowHeight),
          header: row.tableRowStyle?.tableHeader || undefined,
          unbroken: (row.tableRowStyle as { preventOverflow?: boolean } | undefined)?.preventOverflow || undefined,
        }),
        cells: drawn[rowIndex].map((cell): GoogleDocTableCell => {
          let style = cell.tableCellStyle ?? {};
          let background = fill(style.backgroundColor, behind);
          return {
            column: row.tableCells!.indexOf(cell),
            ...set({
              rowSpan: (style.rowSpan ?? 1) > 1 ? style.rowSpan : undefined,
              columnSpan: (style.columnSpan ?? 1) > 1 ? style.columnSpan : undefined,
              background,
              verticalAlign: ({ MIDDLE: "middle", BOTTOM: "bottom" } as const)[style.contentAlignment as "MIDDLE"],
            }),
            padding: (["Top", "Right", "Bottom", "Left"] as const).map((side, at) =>
              points(style[`padding${side}`]) ?? UNSTATED_PADDING[at]) as [number, number, number, number],
            // And draws a 1pt line where an edge names no width.
            borders: set({
              top: border(style.borderTop, 1),
              right: border(style.borderRight, 1),
              bottom: border(style.borderBottom, 1),
              left: border(style.borderLeft, 1),
            }),
            blocks: over(background, () => drawBlocks(cell.content ?? [])),
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
    let pageNumberStart = style.pageNumberStart ??
      (before || (document.pageNumberStart ?? 1) === 1 ? undefined : document.pageNumberStart);
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
        rightToLeft: columns.length > 1 && style.contentDirection === "RIGHT_TO_LEFT" || undefined,
        // A section that names none takes those of the section before it, and the first the document's.
        header: style.defaultHeaderId ?? (before ? before.header : document.defaultHeaderId),
        footer: style.defaultFooterId ?? (before ? before.footer : document.defaultFooterId),
        firstHeader: style.firstPageHeaderId ?? (before ? before.firstHeader : document.firstPageHeaderId),
        firstFooter: style.firstPageFooterId ?? (before ? before.firstFooter : document.firstPageFooterId),
        // Only the first section takes the document's: a later one that does not say has none.
        firstPage: (style.useFirstPageHeaderFooter ?? (!before && document.useFirstPageHeaderFooter)) || undefined,
        evenHeader: style.evenPageHeaderId ?? (before ? before.evenHeader : document.evenPageHeaderId),
        evenFooter: style.evenPageFooterId ?? (before ? before.evenFooter : document.evenPageFooterId),
      }),
      // Outside set(): pages may be counted from 0.
      ...pageNumberStart === undefined ? {} : { pageNumberStart },
    }) - 1;
  };

  /** The blocks of `content`, each with its range where it is `placed`: the body's own are. */
  let drawBlocks = (content: DrawnElement[], placed = false): GoogleDocBlock[] =>
    content.flatMap((element, at): GoogleDocBlock[] => {
      let range = placed ? { range: { start: element.startIndex, end: element.endIndex } } : {};
      if (element.paragraph) return [{ ...drawParagraph(content, at), ...range }];
      if (element.table) return [{ ...drawTable(element.table), ...range }];
      if (element.tableOfContents) {
        return [{ type: "contents", ...range, blocks: drawBlocks(element.tableOfContents.content ?? []) }];
      }
      if (element.sectionBreak) {
        // The break a body opens with starts its first section, and is no block of it.
        let section = addSection(element.sectionBreak.sectionStyle);
        return section === 0 ? [] : [{ type: "section", ...range, section }];
      }
      return [];
    });

  return {
    blocks: drawBlocks, addSection, addObject, sections, lists, objects, paragraphLooks, textLooks,
    /** What a new paragraph of each named style would be set in. */
    named: () => Object.fromEntries([...named.keys()].flatMap(name => name === undefined ? [] : [[name, {
      paragraph: paragraphPlace(paragraphLook(paragraphStyleOf(name), page)),
      text: textPlace(textLook(textStyleOf(name), page)),
    }]])),
  };
}

/** The drawing of `tab` as the document Google Docs names `version` holds it. */
export function docTabDrawing(tab: DrawnDocumentTab, version?: string): GoogleDocDrawing {
  let document = tab.documentStyle ?? {};
  let page = cssColor(document.background?.color) ?? WHITE;
  let draw = drawer(tab, paragraphLook, textLook, page);
  let { sections, objects } = draw;
  let blocks = draw.blocks(tab.body?.content ?? [], true);
  if (sections.length === 0) draw.addSection();
  let parts = (of: Record<string, { content?: DrawnElement[] }> | undefined) =>
    Object.fromEntries(Object.entries(of ?? {}).map(([id, part]) => [id, draw.blocks(part.content ?? [])]));
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
    let { placed } = drawnObject(properties?.embeddedObject, properties?.positioning ?? {});
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
    draw.addObject(id, properties?.embeddedObject, properties?.positioning ?? {});
    (unreturned[nearest.kind] ??= { ...nearest.paragraph, runs: [], objects: [] }).objects!.push(id);
  }
  for (let [kind, part] of returned) {
    let paragraph = unreturned[kind];
    if (!paragraph) continue;
    part[UNRETURNED] = [paragraph];
    for (let section of sections) section[kind] ||= UNRETURNED;
  }

  return {
    ...set({ version }),
    ...document.documentFormat?.documentMode === "PAGELESS" ? { pageless: true as const } : {},
    page: {
      width: points(document.pageSize?.width) ?? 612,
      height: points(document.pageSize?.height) ?? 792,
      ...page === WHITE ? {} : { background: page },
    },
    ...document.useEvenPageHeaderFooter ? { evenPages: true as const } : {},
    sections,
    blocks,
    headers,
    footers,
    footnotes,
    lists: draw.lists,
    objects,
    paragraphLooks: draw.paragraphLooks,
    textLooks: draw.textLooks,
    named: draw.named(),
  };
}

/**
 * What `changes`, the elements a tab's pending edits put in place of ranges of its saved body,
 * are drawn as, for the tab `tabId` of the document Google Docs names `version`, with `lists`,
 * the lists among those they name that the edits make or change. Each element is drawn as the
 * saved tab's are, with the looks the copy keeps of it as it states them and nothing guessed: no
 * named style is laid under them and no default over them, and a list's level is what the copy
 * keeps of it.
 */
export function docPendingDrawing(
  changes: readonly ChangedElements[], lists: NonNullable<DrawnDocumentTab["lists"]>,
  tabId: string, version?: string,
): GoogleDocPendingDrawing {
  let draw = drawer({ lists }, statedParagraphLook, statedTextLook);
  return {
    tabId,
    ...set({ version }),
    edits: changes.map(({ start, end, elements }) => ({
      start,
      end,
      blocks: elements.flatMap((element): GoogleDocPendingBlock[] => {
        if (element.tableOfContents) return [{ type: "contents" }];
        // The break a body opens with is no block of it.
        if (element.sectionBreak) return element.startIndex ? [{ type: "section" }] : [];
        return draw.blocks([element]);
      }),
    })),
    // A list drawn that `lists` does not hold is the saved drawing's to define.
    lists: Object.fromEntries(Object.entries(draw.lists).flatMap(([id, levels]) =>
      Object.hasOwn(lists, id)
        ? [[id, levels.map(({ numbering, symbol, start }) => ({ ...set({ numbering, symbol }), start }))]]
        : [])),
    paragraphLooks: draw.paragraphLooks,
    textLooks: draw.textLooks,
  };
}
