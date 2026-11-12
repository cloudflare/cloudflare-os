// How a Google Doc tab looks beyond what its Markdown says: its named styles and page, and what
// each paragraph sets over its named style. Read by previews (GoogleDocSession.getStyles()).

import type { Dimension, GoogleDocsTab, Paragraph, ParagraphStyle, TextStyle } from "./docs-api";
import type { GoogleDocLook as DocLook, GoogleDocStyles } from "./docs-types";

const ALIGNMENT = { START: "start", CENTER: "center", END: "end", JUSTIFIED: "justify" } as const;

// Google leaves a zero out of its JSON, so a length or color channel that is absent is zero.
const points = (length: Dimension | undefined) => length && (length.magnitude ?? 0);

function cssColor(color: TextStyle["foregroundColor"]): string | undefined {
  let rgb = color?.color?.rgbColor;
  if (!rgb) return undefined;
  let channel = (value = 0) => Math.round(value * 255).toString(16).padStart(2, "0");
  return `#${channel(rgb.red)}${channel(rgb.green)}${channel(rgb.blue)}`;
}

/** What `paragraph` and `text` set themselves; what they inherit is left out. */
function look(paragraph: Partial<ParagraphStyle> = {}, text: TextStyle = {}): DocLook {
  let weight = text.weightedFontFamily?.weight;
  let all: DocLook = {
    fontFamily: text.weightedFontFamily?.fontFamily,
    fontSize: points(text.fontSize),
    bold: text.bold ?? (weight === undefined ? undefined : weight >= 600),
    italic: text.italic,
    color: cssColor(text.foregroundColor),
    alignment: ALIGNMENT[paragraph.alignment as keyof typeof ALIGNMENT],
    lineSpacing: paragraph.lineSpacing === undefined ? undefined : paragraph.lineSpacing / 100,
    spaceAbove: points(paragraph.spaceAbove),
    spaceBelow: points(paragraph.spaceBelow),
  };
  return Object.fromEntries(Object.entries(all).filter(([, value]) => value !== undefined));
}

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

/**
 * The styles of `tab`, whose paragraphs begin at `starts` in its rendered `markdown`, in order.
 * Each paragraph is one line of it.
 */
export function docTabStyles(
  tab: GoogleDocsTab, markdown: string, starts: { mdStart: number; paragraph: Paragraph }[],
): GoogleDocStyles {
  let named: Record<string, DocLook> = {};
  let styles = tab.namedStyles?.styles ?? [];
  let normal = styles.find(style => style.namedStyleType === "NORMAL_TEXT");
  let base = look(normal?.paragraphStyle, normal?.textStyle);
  for (let style of styles) {
    if (!style.namedStyleType) continue;
    named[style.namedStyleType] = { ...base, ...look(style.paragraphStyle, style.textStyle) };
  }

  let line = 0;
  let scanned = 0;
  let paragraphs = starts.map(({ mdStart, paragraph }) => {
    for (; scanned < mdStart; scanned++) if (markdown.charCodeAt(scanned) === 10) line++;
    let style = paragraph.paragraphStyle.namedStyleType;
    let inherited = named[style] ?? base;
    let own = Object.entries({ ...look(paragraph.paragraphStyle), ...sharedLook(paragraph) })
      .filter(([key, value]) => inherited[key as keyof DocLook] !== value);
    return { line, style, ...own.length ? { look: Object.fromEntries(own) as DocLook } : {} };
  });

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
  };
}
