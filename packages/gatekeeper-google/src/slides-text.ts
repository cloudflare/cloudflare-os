/**
 * Addresses and rewrites the text of one shape, table cell, or speaker-notes shape.
 *
 * Agents read text as `slides-model.ts` projects it, where an AutoText shows what it renders (a
 * slide number "11"), while Slides indexes an AutoText as one code unit whatever it shows. Every
 * other character occupies one index per UTF-16 code unit, so a range of projected text maps onto
 * provider indices exactly, unless a boundary falls inside an AutoText.
 *
 * Rewriting keeps styles: inserted text takes the style of the run at its insertion index, as
 * Google's `insertText` "generally" does, and a newline it inserts starts a paragraph copying the
 * one it was inserted into, bullet included, as `insertText` documents. Deleting a newline merges
 * its paragraph into the next, which keeps its own style. Google documents neither the first rule
 * exactly nor the last at all, so the requests set both styles explicitly. A style set on text
 * that ends a paragraph also reaches its newline, as a live read shows, though a link never does.
 */

import type {
  RestBullet, RestParagraphStyle, RestText, RestTextElement, RestTextStyle,
} from "./slides-api";
import { restyled, type StyleChange } from "./slides-format";

/** A text run, or an AutoText occupying `width` provider indices whatever `text` it shows. */
export type TextSegment = { text: string; width: number; autoText?: string; style?: RestTextStyle };

/** What a paragraph marker carries. */
export type Paragraph = { style?: RestParagraphStyle; bullet?: RestBullet };

/**
 * A shape's or cell's text: its segments, without the newline Slides keeps at its end, one
 * paragraph per newline including that last one, and the last newline's own style.
 */
export type RichText = {
  segments: TextSegment[];
  paragraphs: Paragraph[];
  endStyle?: RestTextStyle;
  lists?: Record<string, unknown>;
};

/** Where text requests apply: a shape, or one cell of a table. */
export type TextLocation = {
  objectId: string;
  cellLocation?: { rowIndex: number; columnIndex: number };
};

/** A provider index range, end exclusive. */
export type IndexRange = { startIndex: number; endIndex: number };

/**
 * Why a queued change cannot apply to the presentation as it now is. Its message is a lowercase
 * clause, which callers prefix with the change it is about.
 */
export class ChangeConflict extends Error {}

/** Characters Google strips from inserted text, which would leave a result unlike the preview. */
// oxlint-disable-next-line no-control-regex -- Google's documented set of stripped characters
export const STRIPPED_CHARACTERS = /[\u0000-\u0008\u000c-\u001f\ue000-\uf8ff]/;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The text and paragraphs of a shape or cell, as `RichText` describes them. */
export function richTextOf(body: RestText | undefined): RichText {
  let segments: TextSegment[] = [];
  let markers: Paragraph[] = [];
  for (let element of body?.textElements ?? []) {
    if (element.paragraphMarker) {
      let { style, bullet } = element.paragraphMarker;
      markers.push({ ...(style ? { style } : {}), ...(bullet ? { bullet } : {}) });
    } else if (element.textRun) {
      let { content = "", style } = element.textRun;
      segments.push({ text: content, width: content.length, ...(style ? { style } : {}) });
    } else if (element.autoText) {
      let width = (element.endIndex ?? 0) - (element.startIndex ?? 0);
      if (!Number.isInteger(width) || width <= 0) {
        throw new Error("Google Slides returned an invalid AutoText");
      }
      let { type = "UNSPECIFIED", content = "", style } = element.autoText;
      segments.push({ text: content, width, autoText: type, ...(style ? { style } : {}) });
    }
  }
  let endStyle: RestTextStyle | undefined;
  let last = segments.at(-1);
  if (last && !last.autoText && last.text.endsWith("\n")) {
    endStyle = last.style;
    let text = last.text.slice(0, -1);
    segments.pop();
    if (text) segments.push({ ...last, text, width: text.length });
  }
  // A summary read's field mask leaves out paragraph markers.
  let count = projectedText(segments).split("\n").length;
  return {
    segments,
    paragraphs: Array.from({ length: count }, (_, i) => markers[i] ?? {}),
    ...(endStyle ? { endStyle } : {}),
    ...(body?.lists ? { lists: body.lists } : {}),
  };
}

/** The text agents read, as `slides-model.ts` projects it. */
export function projectedText(segments: readonly TextSegment[]): string {
  return segments.map(segment => segment.text).join("");
}

/** The paragraph of projected `text` holding `offset`. */
export function paragraphAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length - 1;
}

/** Paragraph `i` of projected `text`, as a range without its newline. */
export function paragraphRange(text: string, i: number): [start: number, end: number] {
  let lines = text.split("\n");
  let start = lines.slice(0, i).reduce((sum, line) => sum + line.length + 1, 0);
  return [start, start + lines[i].length];
}

// Splits at a projected offset, which must not fall inside an AutoText.
function cut(
  segments: readonly TextSegment[], offset: number,
): [TextSegment[], TextSegment[]] {
  let projected = 0;
  for (let i = 0; i < segments.length; i++) {
    let segment = segments[i];
    if (offset < projected + segment.text.length) {
      if (offset === projected) return [segments.slice(0, i), segments.slice(i)];
      if (segment.autoText) {
        throw new ChangeConflict("a slide number or other AutoText can only be edited whole");
      }
      let k = offset - projected;
      return [
        [...segments.slice(0, i), { ...segment, text: segment.text.slice(0, k), width: k }],
        [{ ...segment, text: segment.text.slice(k), width: segment.text.length - k },
          ...segments.slice(i + 1)],
      ];
    }
    projected += segment.text.length;
  }
  return [[...segments], []];
}

function width(segments: readonly TextSegment[]): number {
  return segments.reduce((sum, segment) => sum + segment.width, 0);
}

/** The provider indices of the projected range `[start, end)`. */
export function providerRange(
  segments: readonly TextSegment[], start: number, end: number,
): IndexRange {
  return { startIndex: width(cut(segments, start)[0]), endIndex: width(cut(segments, end)[0]) };
}

/** The style text inserted at a projected offset takes: the run's there, as `insertText` does. */
function styleAt(rich: RichText, offset: number): RestTextStyle | undefined {
  let [, from] = cut(rich.segments, offset);
  return from.length > 0 ? from[0].style : rich.endStyle;
}

/** Replace the projected range `[start, end)` with `text`, keeping styles as the module says. */
export function spliceText(rich: RichText, start: number, end: number, text: string): RichText {
  let { segments, paragraphs } = rich;
  let [before] = cut(segments, start);
  let [, after] = cut(segments, end);
  let style = styleAt(rich, start);
  let projected = projectedText(segments);
  let paragraph = paragraphAt(projected, start);
  let merged = paragraphAt(projected, end);
  let inserted = text.split("\n").length - 1;
  // Google may give a merged paragraph either one's style; that is pinned when applied, but a list
  // item's bullet cannot be.
  let [first, last] = [paragraphs[paragraph], paragraphs[merged]]
    .map(({ bullet }) => JSON.stringify([bullet?.listId, bullet?.nestingLevel ?? 0]));
  if (merged > paragraph && first !== last) {
    throw new ChangeConflict(
      "the edit joins paragraphs that are not items of the same list at the same level; edit " +
      "each paragraph's text on its own");
  }
  let piece: TextSegment = { text, width: text.length, ...(style ? { style } : {}) };
  return {
    ...rich,
    segments: [
      ...before,
      // Google sets no link on a newline, so one the new text takes ends at each.
      ...atNewlines(piece).map(segment =>
        segment.text === "\n" ? withStyle(segment, restyled(segment.style, UNLINK)) : segment),
      ...after,
    ],
    paragraphs: [
      ...paragraphs.slice(0, paragraph),
      ...Array.from({ length: inserted }, () => structuredClone(paragraphs[paragraph])),
      ...paragraphs.slice(merged),
    ],
  };
}

/**
 * Restyle the projected range `[start, end)` as an `updateTextStyle` of `change` does. Google sets
 * no link on a newline or bullet, and a link set over part of an existing link retargets all of it.
 * A range covering a whole paragraph also styles its bullet.
 */
export function styledText(
  rich: RichText, start: number, end: number, change: StyleChange<RestTextStyle>,
): RichText {
  let [before, rest] = cut(rich.segments, start);
  let [inside, after] = cut(rest, end - start);
  let pieces = inside.flatMap(atNewlines);
  let styled = pieces.map(segment => withStyle(
    segment, restyled(segment.style, change, segment.text === "\n" ? "link" : undefined)));
  let link = change.style.link;
  if (link) {
    let retarget = (segments: TextSegment[], old: RestTextStyle["link"]) => {
      if (!old) return;
      let key = JSON.stringify(old);
      for (let at = 0; at < segments.length && JSON.stringify(segments[at].style?.link) === key; at++) {
        segments[at] = withStyle(segments[at], { ...segments[at].style, link });
      }
    };
    let left = before.toReversed();
    retarget(left, pieces[0]?.style?.link);
    before = left.toReversed();
    retarget(after, pieces.at(-1)?.style?.link);
  }
  let text = projectedText(rich.segments);
  let from = 0;
  let paragraphs = rich.paragraphs.map(paragraph => {
    let newline = text.indexOf("\n", from);
    let to = newline === -1 ? text.length : newline;
    // Styling through the text's end reaches its newline too. An empty paragraph requires its
    // newline in the range rather than an empty range at its start.
    let covered = start <= from && end >= to && end > from;
    from = to + 1;
    if (!paragraph.bullet || !covered) return paragraph;
    let { bulletStyle: _, ...bullet } = paragraph.bullet;
    let bulletStyle = restyled(paragraph.bullet.bulletStyle, change, "link");
    return { ...paragraph, bullet: { ...bullet, ...(bulletStyle ? { bulletStyle } : {}) } };
  });
  let result = { ...rich, paragraphs, segments: [...before, ...styled, ...after] };
  // A range ending in a newline holds its paragraph's newline already, and reaches no further.
  return pieces.at(-1)?.text === "\n" ? result : styledParagraphEnd(result, end, change);
}

/**
 * Restyles the newline at projected `offset`, or the last one if `offset` ends the text, as a
 * `change` set on text ending there reaches it, link aside.
 */
function styledParagraphEnd(
  rich: RichText, offset: number, change: StyleChange<RestTextStyle>,
): RichText {
  let restyle = (style: RestTextStyle | undefined) => restyled(style, change, "link");
  let [head, [next, ...tail]] = cut(rich.segments, offset);
  if (!next) {
    let { endStyle, ...rest } = rich;
    let style = restyle(endStyle);
    return style ? { ...rest, endStyle: style } : rest;
  }
  let [newline, ...line] = atNewlines(next);
  if (newline?.text !== "\n") return rich;
  return { ...rich, segments: [...head, withStyle(newline, restyle(newline.style)), ...line, ...tail] };
}

function withStyle(segment: TextSegment, style: RestTextStyle | undefined): TextSegment {
  let { style: _, ...rest } = segment;
  return style ? { ...rest, style } : rest;
}

const UNLINK: StyleChange<RestTextStyle> = { style: {}, fields: ["link"] };

// A segment split so each newline is its own, as Google keeps a newline's style apart.
function atNewlines(segment: TextSegment): TextSegment[] {
  if (segment.autoText) return [segment];
  return segment.text.split(/(\n)/).filter(Boolean).map(text => ({ ...segment, text, width: text.length }));
}

// Whether an edit may start or end at a projected offset: not inside a character, nor an AutoText.
function isEditBoundary(segments: readonly TextSegment[], text: string, offset: number): boolean {
  if (!isGraphemeBoundary(text, offset)) return false;
  let projected = 0;
  for (let segment of segments) {
    if (offset <= projected) return true;
    projected += segment.text.length;
    if (offset < projected) return !segment.autoText;
  }
  return true;
}

/**
 * The least replacement with the same result as replacing `[start, end)` with `text`. Text left
 * unchanged at either end is not rewritten, so it keeps its own style.
 */
export function narrowChange(
  segments: readonly TextSegment[], start: number, end: number, text: string,
): { start: number; end: number; text: string } {
  let current = projectedText(segments);
  let old = current.slice(start, end);
  let shorter = Math.min(old.length, text.length);
  let prefix = 0;
  while (prefix < shorter && old[prefix] === text[prefix]) prefix++;
  let suffix = 0;
  while (suffix < shorter - prefix && old.at(-1 - suffix) === text.at(-1 - suffix)) suffix++;
  while (prefix > 0 && !isEditBoundary(segments, current, start + prefix)) prefix--;
  while (suffix > 0 && !isEditBoundary(segments, current, end - suffix)) suffix--;
  return { start: start + prefix, end: end - suffix, text: text.slice(prefix, text.length - suffix) };
}

/** `TextContent` holding `rich`, with the indices, runs and paragraph markers Slides reports. */
export function restTextOf(rich: RichText): RestText {
  // Google ends a run at every newline, the last included.
  let pieces = rich.segments.flatMap(segment => segment.autoText ? [segment] :
    segment.text.split(/(?<=\n)/).filter(Boolean)
      .map(text => ({ ...segment, text, width: text.length })));
  pieces.push({ text: "\n", width: 1, ...(rich.endStyle ? { style: rich.endStyle } : {}) });
  let textElements: RestTextElement[] = [];
  let index = 0;
  let paragraph = 0;
  let runs: RestTextElement[] = [];
  for (let piece of pieces) {
    let at = { startIndex: index, endIndex: index += piece.width };
    let style = piece.style ? { style: piece.style } : {};
    runs.push(piece.autoText
      ? { ...at, autoText: { type: piece.autoText, content: piece.text, ...style } }
      : { ...at, textRun: { content: piece.text, ...style } });
    if (piece.autoText || !piece.text.endsWith("\n")) continue;
    // Each paragraph opens with a marker spanning it.
    let { style: paragraphStyle, bullet } = rich.paragraphs[paragraph++] ?? {};
    textElements.push({
      startIndex: runs[0].startIndex, endIndex: index,
      paragraphMarker: {
        ...(paragraphStyle ? { style: paragraphStyle } : {}), ...(bullet ? { bullet } : {}),
      },
    }, ...runs);
    runs = [];
  }
  return { textElements, ...(rich.lists ? { lists: rich.lists } : {}) };
}

/** Whether `offset` falls between characters of `text`, not inside one. */
export function isGraphemeBoundary(text: string, offset: number): boolean {
  return offset === 0 || offset === text.length || graphemes.segment(text).containing(offset)?.index === offset;
}

/**
 * The projected range an edit replaces: the one occurrence of `find`, or, without it, all of the
 * text, which must still read `before` when that is given.
 */
export function changeRange(
  text: string, change: { find?: string; before?: string },
): { start: number; end: number } {
  let { find, before } = change;
  if (find === undefined) {
    if (before !== undefined && text !== before) {
      throw new ChangeConflict("the text has changed since this edit was made");
    }
    return { start: 0, end: text.length };
  }
  let start = text.indexOf(find);
  if (start === -1) throw new ChangeConflict("the text does not contain the text to find");
  if (text.indexOf(find, start + 1) !== -1) {
    throw new ChangeConflict(
      "the text to find occurs more than once; include more of the surrounding text");
  }
  let end = start + find.length;
  // Google moves an insertion out of a grapheme cluster, so the edit would land elsewhere.
  if (!isGraphemeBoundary(text, start) || !isGraphemeBoundary(text, end)) {
    throw new ChangeConflict("the text to find starts or ends inside a character; include all of it");
  }
  return { start, end };
}

/** Every `TextStyle` field, so a style sent with them replaces the text's whole style. */
export const TEXT_STYLE_FIELDS = "backgroundColor,baselineOffset,bold,fontFamily,fontSize," +
  "foregroundColor,italic,link,smallCaps,strikethrough,underline,weightedFontFamily";

/** Every writable `ParagraphStyle` field, likewise. */
export const PARAGRAPH_STYLE_FIELDS = "alignment,direction,indentEnd,indentFirstLine,indentStart," +
  "lineSpacing,spaceAbove,spaceBelow,spacingMode";

/** A `Range` of provider indices. */
export function fixedRange(startIndex: number, endIndex: number) {
  return { type: "FIXED_RANGE", startIndex, endIndex };
}

/**
 * Whether styling `text`, inserted at projected `start` of `projected`, styles the whole of a
 * paragraph it starts. That reaches the paragraph's newline, as styling text ending a paragraph
 * does, and Google then gives the paragraph's bullet the style too.
 */
function fillsParagraph(projected: string, start: number, text: string): boolean {
  let joined = projected.slice(0, start) + text + projected.slice(start);
  let end = start + text.length;
  let starts = [...text.matchAll(/\n/g)].map(match => start + match.index + 1);
  if (start === 0 || projected[start - 1] === "\n") starts.unshift(start);
  return starts.some(from => {
    let newline = joined.indexOf("\n", from);
    let to = newline === -1 ? joined.length : newline;
    // An empty paragraph right after the text keeps its newline's style: the text ends one before.
    return to <= end && !(from === to && to === end);
  });
}

// A text style as JSON with its keys sorted, so styles Google lists in different orders compare
// equal. A bullet takes no link.
function styleKey(style: RestTextStyle): string {
  let { link: _, ...rest } = style;
  return JSON.stringify(rest, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a < b ? -1 : 1))
      : value);
}

/**
 * Requests turning `before` into `after`, which `spliceText` made by replacing `[start, end)` with
 * `text`. Google only "generally" keeps neighbouring styles and documents no rule for a merge, so
 * the new text is given its style explicitly, and so is the paragraph a merge leaves. A list item
 * that style fills would have its bullet restyled too, which is refused unless the bullet already
 * has that style, since no request sets a bullet's style back.
 */
export function replaceRequests(
  location: TextLocation, before: RichText, after: RichText, start: number, end: number,
  text: string,
): unknown[] {
  let range = providerRange(before.segments, start, end);
  let requests: unknown[] = [];
  if (text) {
    let style = styleAt(before, start) ?? {};
    let projected = projectedText(before.segments);
    let touched = before.paragraphs.slice(paragraphAt(projected, start), paragraphAt(projected, end) + 1);
    let styledApart = touched.some(({ bullet }) =>
      bullet && styleKey(bullet.bulletStyle ?? {}) !== styleKey(style));
    if (styledApart && fillsParagraph(projected, start, text)) {
      throw new ChangeConflict(
        "the new text fills a list item, and Google would give its bullet, which is styled apart " +
        "from its text, the text's style instead");
    }
    requests.push(
      { insertText: { ...location, text, insertionIndex: range.startIndex } },
      { updateTextStyle: {
        ...location, style, fields: TEXT_STYLE_FIELDS,
        textRange: fixedRange(range.startIndex, range.startIndex + text.length),
      } },
    );
  }
  if (range.endIndex > range.startIndex) {
    requests.push({
      deleteText: {
        ...location, textRange: fixedRange(range.startIndex + text.length, range.endIndex + text.length),
      },
    });
  }
  if (projectedText(before.segments).slice(start, end).includes("\n")) {
    let edited = projectedText(after.segments);
    let paragraph = paragraphAt(edited, start + text.length);
    let { startIndex, endIndex } = providerRange(after.segments, ...paragraphRange(edited, paragraph));
    requests.push({
      updateParagraphStyle: {
        ...location, style: after.paragraphs[paragraph].style ?? {}, fields: PARAGRAPH_STYLE_FIELDS,
        // Through its newline, so an empty paragraph has a range too.
        textRange: fixedRange(startIndex, endIndex + 1),
      },
    });
  }
  return requests;
}
