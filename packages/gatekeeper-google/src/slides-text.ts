/**
 * Addresses and rewrites the text of one shape, table cell, or speaker-notes shape.
 *
 * Agents read text as `slides-model.ts` projects it, where an AutoText shows what it renders (a
 * slide number "11"), while Slides indexes an AutoText as one code unit whatever it shows. Every
 * other character occupies one index per UTF-16 code unit, so a range of projected text maps onto
 * provider indices exactly, unless a boundary falls inside an AutoText.
 */

import type { RestText } from "./slides-api";

/** A text run, or an AutoText occupying `width` provider indices whatever `text` it shows. */
export type TextSegment = { text: string; width: number; autoText?: string };

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

function run(text: string): TextSegment {
  return { text, width: text.length };
}

/** The segments of a shape's or cell's text, without the newline Slides keeps at its end. */
export function segmentsOf(body: RestText | undefined): TextSegment[] {
  let segments: TextSegment[] = [];
  for (let element of body?.textElements ?? []) {
    if (element.textRun) {
      segments.push(run(element.textRun.content ?? ""));
    } else if (element.autoText) {
      let width = (element.endIndex ?? 0) - (element.startIndex ?? 0);
      if (!Number.isInteger(width) || width <= 0) {
        throw new Error("Google Slides returned an invalid AutoText");
      }
      segments.push({
        text: element.autoText.content ?? "", width, autoText: element.autoText.type ?? "UNSPECIFIED",
      });
    }
  }
  let last = segments.at(-1);
  if (last && !last.autoText && last.text.endsWith("\n")) {
    segments[segments.length - 1] = run(last.text.slice(0, -1));
  }
  return segments;
}

/** The text agents read, as `slides-model.ts` projects it. */
export function projectedText(segments: readonly TextSegment[]): string {
  return segments.map(segment => segment.text).join("");
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
        [...segments.slice(0, i), run(segment.text.slice(0, k))],
        [run(segment.text.slice(k)), ...segments.slice(i + 1)],
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

/** Replace the projected range `[start, end)` with `text`. */
export function spliceSegments(
  segments: readonly TextSegment[], start: number, end: number, text: string,
): TextSegment[] {
  let [before] = cut(segments, start);
  let [, after] = cut(segments, end);
  return [...before, ...(text ? [run(text)] : []), ...after].filter(s => s.width > 0);
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

/** `TextContent` holding `segments`, with the indices and final newline Slides would report. */
export function restTextOf(segments: readonly TextSegment[]): RestText {
  let index = 0;
  return {
    textElements: [...segments, run("\n")].map(segment => {
      let at = { startIndex: index, endIndex: index += segment.width };
      return segment.autoText
        ? { ...at, autoText: { type: segment.autoText, content: segment.text } }
        : { ...at, textRun: { content: segment.text } };
    }),
  };
}

function isGraphemeBoundary(text: string, offset: number): boolean {
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

/**
 * Requests replacing `range` with `text`. The insertion comes first, so the new text joins the
 * run at that index, which is the text it replaces, and takes its style.
 */
export function replaceRequests(location: TextLocation, range: IndexRange, text: string): unknown[] {
  let requests: unknown[] = [];
  if (text) {
    requests.push({ insertText: { ...location, text, insertionIndex: range.startIndex } });
  }
  if (range.endIndex > range.startIndex) {
    requests.push({
      deleteText: {
        ...location,
        textRange: {
          type: "FIXED_RANGE",
          startIndex: range.startIndex + text.length,
          endIndex: range.endIndex + text.length,
        },
      },
    });
  }
  return requests;
}
