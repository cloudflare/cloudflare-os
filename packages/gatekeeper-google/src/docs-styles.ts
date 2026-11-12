// How a Google Doc tab looks beyond what its Markdown says: its named styles and page, and what
// each paragraph sets over its named style. Read by previews (GoogleDocSession.getStyles()).

import type {
  Color, Dimension, GoogleDocsTab, Paragraph, ParagraphStyle, Table, TableCell, TextStyle,
} from "./docs-api";
import type { Segment } from "./markdown-converter";
import type { GoogleDocCell, GoogleDocLook as DocLook, GoogleDocStyles } from "./docs-types";

const ALIGNMENT = { START: "start", CENTER: "center", END: "end", JUSTIFIED: "justify" } as const;

// Google leaves a zero out of its JSON, so a length or color channel that is absent is zero.
const points = (length: Dimension | undefined) => length && (length.magnitude ?? 0);

function cssColor(color: Color | undefined): string | undefined {
  let rgb = color?.color?.rgbColor;
  if (!rgb) return undefined;
  let channel = (value = 0) => Math.round(value * 255).toString(16).padStart(2, "0");
  return `#${channel(rgb.red)}${channel(rgb.green)}${channel(rgb.blue)}`;
}

// White behind text on a white page is no highlight, though pasted text often carries one.
const fill = (color: Color | undefined) => {
  let css = cssColor(color);
  return css === "#ffffff" ? undefined : css;
};

/** What `paragraph` and `text` set themselves; what they inherit is left out. */
function look(paragraph: Partial<ParagraphStyle> = {}, text: TextStyle = {}): DocLook {
  let weight = text.weightedFontFamily?.weight;
  let all: DocLook = {
    fontFamily: text.weightedFontFamily?.fontFamily,
    fontSize: points(text.fontSize),
    bold: text.bold ?? (weight === undefined ? undefined : weight >= 600),
    italic: text.italic,
    color: cssColor(text.foregroundColor),
    highlight: fill(text.backgroundColor),
    shading: fill(paragraph.shading?.backgroundColor),
    alignment: ALIGNMENT[paragraph.alignment as keyof typeof ALIGNMENT],
    lineSpacing: paragraph.lineSpacing === undefined ? undefined : paragraph.lineSpacing / 100,
    spaceAbove: points(paragraph.spaceAbove),
    spaceBelow: points(paragraph.spaceBelow),
  };
  return Object.fromEntries(Object.entries(all).filter(([, value]) => value !== undefined));
}

const RUN_KEYS = ["fontFamily", "fontSize", "color", "highlight"] as const;

/**
 * The font, size and color every run of text in `paragraph` shares. Bold and italic are left to
 * the Markdown, which already says them run by run.
 */
function sharedLook(paragraph: Paragraph): DocLook {
  let styles = paragraph.elements
    .filter(element => element.textRun?.content.trim())
    .map(element => look({}, element.textRun!.textStyle));
  let shared: DocLook = {};
  for (let key of ["fontFamily", "fontSize", "color"] as const) {
    let value = styles[0]?.[key];
    if (value !== undefined && styles.every(style => style[key] === value)) {
      Object.assign(shared, { [key]: value });
    }
  }
  return shared;
}

const CELL_KEYS = ["fontFamily", "fontSize", "color", "alignment"] as const;
const SIDES = { top: "borderTop", right: "borderRight", bottom: "borderBottom", left: "borderLeft" } as const;

/** How `cell` is drawn, given each named style in full. */
function cellLook(cell: TableCell, named: Record<string, DocLook>, base: DocLook): GoogleDocCell {
  let style = cell.tableCellStyle ?? {};
  let borders: NonNullable<GoogleDocCell["borders"]> = {};
  for (let [side, key] of Object.entries(SIDES) as [keyof typeof SIDES, typeof SIDES[keyof typeof SIDES]][]) {
    let width = points(style[key]?.width);
    let color = cssColor(style[key]?.color) ?? "#000000";
    if (width !== undefined && (width !== 1 || color !== "#000000")) borders[side] = { width, color };
  }

  // What every paragraph of the cell has in common that Normal text does not.
  let looks = (cell.content ?? []).flatMap(({ paragraph }) => paragraph ? [{
    ...named[paragraph.paragraphStyle.namedStyleType] ?? base,
    ...look(paragraph.paragraphStyle),
    ...sharedLook(paragraph),
  }] : []);
  let shared = CELL_KEYS.filter(key =>
    looks[0]?.[key] !== undefined && looks[0][key] !== base[key] &&
    looks.every(each => each[key] === looks[0][key]));

  let background = fill(style.backgroundColor);
  let verticalAlign = ({ MIDDLE: "middle", BOTTOM: "bottom" } as const)[style.contentAlignment as "MIDDLE"];
  return {
    ...background ? { background } : {},
    ...verticalAlign ? { verticalAlign } : {},
    ...Object.keys(borders).length ? { borders } : {},
    ...shared.length ? { look: Object.fromEntries(shared.map(key => [key, looks[0][key]])) } : {},
  };
}

/** Counts the lines of `markdown` before each position asked for, which must not go backwards. */
function lineCounter(markdown: string): (position: number) => number {
  let line = 0;
  let scanned = 0;
  return position => {
    for (; scanned < position; scanned++) if (markdown.charCodeAt(scanned) === 10) line++;
    return line;
  };
}

/**
 * The styles of `tab`, whose paragraphs begin at `starts` and whose tables begin at `tables` in
 * its rendered `markdown`, each in order. Each paragraph is one line of it.
 */
export function docTabStyles(
  tab: GoogleDocsTab,
  markdown: string,
  starts: { mdStart: number; paragraph: Paragraph; segments: Segment[] }[],
  tables: { mdStart: number; table: Table }[],
): GoogleDocStyles {
  let named: Record<string, DocLook> = {};
  let styles = tab.namedStyles?.styles ?? [];
  let normal = styles.find(style => style.namedStyleType === "NORMAL_TEXT");
  let base = look(normal?.paragraphStyle, normal?.textStyle);
  for (let style of styles) {
    if (!style.namedStyleType) continue;
    named[style.namedStyleType] = { ...base, ...look(style.paragraphStyle, style.textStyle) };
  }

  let runLooks: DocLook[] = [];
  let runLookIndex = new Map<string, number>();
  let paragraphLine = lineCounter(markdown);
  let paragraphs = starts.map(({ mdStart, paragraph, segments }) => {
    let line = paragraphLine(mdStart);
    let style = paragraph.paragraphStyle.namedStyleType;
    let inherited = named[style] ?? base;
    let own = Object.entries({ ...look(paragraph.paragraphStyle), ...sharedLook(paragraph) })
      .filter(([key, value]) => inherited[key as keyof DocLook] !== value);

    // The stretches whose text departs from the paragraph's, adjacent ones alike joined.
    let whole: DocLook = { ...inherited, ...Object.fromEntries(own) };
    let runs: { start: number; end: number; look: number }[] = [];
    for (let segment of segments) {
      if (!("textStyle" in segment)) continue;
      let all = look({}, segment.textStyle);
      let differs = RUN_KEYS.filter(key => all[key] !== undefined && all[key] !== whole[key]);
      if (differs.length === 0) continue;
      let key = JSON.stringify(differs.map(name => all[name]).concat(differs));
      let index = runLookIndex.get(key);
      if (index === undefined) {
        runLookIndex.set(key, index = runLooks.length);
        runLooks.push(Object.fromEntries(differs.map(name => [name, all[name]])));
      }
      let [start, end] = [segment.mdStart - mdStart, segment.mdEnd - mdStart];
      let last = runs.at(-1);
      if (last?.look === index && last.end === start) last.end = end;
      else runs.push({ start, end, look: index });
    }
    return {
      line, style,
      ...own.length ? { look: Object.fromEntries(own) as DocLook } : {},
      ...runs.length ? { runs } : {},
    };
  });

  let tableLine = lineCounter(markdown);
  let { pageSize, marginTop, marginRight, marginLeft } = tab.documentStyle ?? {};
  let width = points(pageSize?.width);
  return {
    ...width ? {
      page: {
        width,
        marginTop: points(marginTop) ?? 0,
        marginRight: points(marginRight) ?? 0,
        marginLeft: points(marginLeft) ?? 0,
      },
    } : {},
    named,
    paragraphs,
    runLooks,
    tables: tables.map(({ mdStart, table }) => {
      let widths = (table.tableStyle?.tableColumnProperties ?? []).map(column =>
        column.widthType === "FIXED_WIDTH" ? points(column.width) : undefined);
      return {
        line: tableLine(mdStart),
        ...widths.length && widths.every(width => width) ? { columns: widths as number[] } : {},
        rows: (table.tableRows ?? []).map(row =>
          (row.tableCells ?? []).map(cell => cellLook(cell, named, base))),
      };
    }),
  };
}
