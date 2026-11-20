// Plain-text bodies for Drive comments and replies, the text of a suggested edit, and where quoted
// text sits in a Google Doc.
//
// A comment made through Drive is attached to no text: Docs lists it under "Original content
// deleted". A comment that quotes a Google Doc is therefore made through the Docs API, anchored to
// the quoted range, and a suggested edit is a Docs suggestion; Drive lists the comment under the
// same ID. Every body here is exactly what is shown for approval and what is sent; Google stores it
// as sent but for white space at its ends, which no body here has.

import type { DocsRange, GoogleDocsDocument, GoogleDocsTab, ParagraphElement } from "./docs-api";
import {
  MAX_DOCS_COMMENT_BYTES, MAX_QUOTE_CHARS, MAX_REPLACEMENT_CHARS, checkCommentContent,
} from "./drive-api";
import { isGoogleDocsStrippedCharacter } from "./docs-content";
import type { DocCopy } from "./docs-copy";
import { DOC_COPY_UNREADABLE, type GoogleDocTabIdentity } from "./docs-replica";
import { paragraphElementText } from "./markdown-converter";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The tab `tabId` names, or the document's first tab when it names none. A child tab is found like
 * any other: the document's tab list is already flattened. Reads only each tab's ID.
 */
export function selectTab<Tab extends { readonly tabId: string }>(
  document: { readonly tabs: readonly Tab[] }, tabId?: string,
): Tab {
  if (tabId === undefined) return document.tabs[0];
  let tab = document.tabs.find(candidate => candidate.tabId === tabId);
  if (!tab) {
    throw new Error(`This document has no tab "${tabId}". Its tabs are: ${
      document.tabs.map(candidate => candidate.tabId).join(", ")}.`);
  }
  return tab;
}

/**
 * One piece of a tab's text and where it sits in the tab: a text run, whose characters are its
 * indices one for one, or a chip, which reads as more text than the one index it takes. `at` is
 * counted from the start of the tab's text.
 */
type Piece = { at: number; length: number; startIndex: number; endIndex: number; run: boolean };

/**
 * Adds the text of `content`, some consecutive body elements of a tab, as its Markdown shows it,
 * without the formatting: text runs, chips and placeholders, in document order, table cells
 * included. Each part of it is pushed to `chunks`, and where it sits in the tab to `pieces`;
 * `length` is the length of the tab's text before `content`, and the answer its length after.
 * Structural elements arrive unvalidated, so they are read defensively.
 *
 * Pieces of no text that follow one another are pushed as ONE, from the first's start to the
 * last's end, so `pieces` grows only with the text; its end is `NaN`, equal to no index, where
 * two of them do not meet, so that it reads as the gap it stands for.
 */
function addText(content: unknown, length: number, chunks: string[], pieces: Piece[]): number {
  let visit = (elements: unknown) => {
    if (!Array.isArray(elements)) return;
    for (let element of elements) {
      if (!isRecord(element)) continue;
      let { paragraph, table } = element;
      if (isRecord(paragraph)) {
        for (let part of Array.isArray(paragraph.elements) ? paragraph.elements : []) {
          if (!isRecord(part)) continue;
          // Chips read as the Markdown the agent was shown renders them.
          let text = paragraphElementText(part as ParagraphElement);
          let { startIndex, endIndex } = part;
          if (typeof text !== "string" || typeof startIndex !== "number" ||
              typeof endIndex !== "number") continue;
          let last = pieces.at(-1);
          if (text === "" && last?.length === 0) {
            last.endIndex = last.endIndex === startIndex ? endIndex : NaN;
            continue;
          }
          pieces.push({
            at: length, length: text.length, startIndex, endIndex, run: isRecord(part.textRun),
          });
          chunks.push(text);
          length += text.length;
        }
      } else if (isRecord(table) && Array.isArray(table.tableRows)) {
        for (let row of table.tableRows) {
          if (!isRecord(row) || !Array.isArray(row.tableCells)) continue;
          for (let cell of row.tableCells) if (isRecord(cell)) visit(cell.content);
        }
      }
    }
  };
  visit(content);
  return length;
}

/** The refusal for replacing part of a chip, which takes one index however long its text reads. */
const PARTIAL_CHIP = "That text takes in part of a smart chip (a person, date or link), which " +
  "can only be replaced whole. Include all of the chip's text, or none of it.";

/** The refusal for replacing text on both sides of an element that reads as no text. */
const SPANS_HIDDEN = "That text runs across something in the Doc that reads as no text, such " +
  "as a dropdown or a horizontal line, which the suggestion would delete too. Quote the text on " +
  "one side of it.";

/**
 * The tab index of text offset `offset`, as the start (or, `end`, the exclusive end) of a range.
 * A chip the offset falls inside is taken whole, or, with `wholeChips`, refused.
 */
function indexAt(pieces: Piece[], offset: number, end: boolean, wholeChips: boolean): number {
  let piece = pieces.find(candidate => end
    ? offset > candidate.at && offset <= candidate.at + candidate.length
    : offset >= candidate.at && offset < candidate.at + candidate.length);
  if (!piece) throw new Error("That text could not be placed in the document.");
  if (!piece.run) {
    let inside = end ? offset < piece.at + piece.length : offset > piece.at;
    if (inside && wholeChips) throw new Error(PARTIAL_CHIP);
    return end ? piece.endIndex : piece.startIndex;
  }
  return piece.startIndex + offset - piece.at;
}

/** The pieces of `pieces` that hold text from offset `from` on, or stand past it with none. */
const piecesPast = (pieces: Piece[], from: number): Piece[] =>
  pieces.filter(piece => piece.at + piece.length > from);

/**
 * Finds `quote`, trimmed, in the text of a tab handed as ITS RUNS' ELEMENTS, in order (each
 * item some consecutive body elements of the tab, with the indexes they have in the tab),
 * where it must occur exactly once; neither side is normalized. Returns the range it takes in
 * the tab. A chip the quote takes part of is taken whole, as a comment's anchor; with
 * `wholeChips`, as for text a suggestion replaces, it is refused, as is a quote that runs
 * across an element the text leaves out, which the range would take in.
 *
 * ONE ITEM IS IN HAND AT A TIME: of the items passed it keeps a count, the last characters of
 * the text (one fewer than the quote's, so a place that spans two items is found once) with
 * the pieces they came from, and the pieces of the first place found. Those characters are cut
 * from the text of the item they end, which stays in hand with them until the next item's text
 * is made. So what it keeps between two items grows with the quote and never with the tab.
 * `runs` is read to its end, since the refusal of a quote that occurs more than once says how
 * often; a quote refused on its own text (empty, or with a line break) reads none of it.
 */
export function locateQuoteInRuns(
  tabId: string, runs: Iterable<readonly unknown[]>, quote: string,
  { wholeChips = false }: { wholeChips?: boolean } = {},
): DocsRange {
  let needle = quote.trim();
  if (!needle) throw new Error("The quote is empty.");
  // The Markdown the agent read separates paragraphs differently from the Doc's own text.
  if (/[\n\v]/.test(needle)) {
    throw new Error("A quote must sit within one paragraph; quote part of one paragraph instead.");
  }
  // The end of the text so far, which the next item's text is searched behind, the pieces
  // that reach into it, and the length of the tab's text so far.
  let tail = "", pieces: Piece[] = [], length = 0;
  // How often the quote was found, and of the first place: its offset and its pieces.
  let count = 0, first = -1, inside: Piece[] = [];
  let items = runs[Symbol.iterator]();
  // Takes the next item in, where there is one. The item is this call's own, so nothing here
  // names it when the item after it is asked for: a `for...of` holds each item until the
  // next has been made.
  let take = (): boolean => {
    let next = items.next();
    if (next.done) return false;
    let chunks = [tail];
    length = addText(next.value, length, chunks, pieces);
    let text = chunks.join("");
    // No place lies within the tail, which is shorter than the quote: each is met once, in
    // the item it ends in.
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
      if (++count > 1) continue;
      first = length - text.length + at;
      let end = first + needle.length;
      inside = piecesPast(pieces, first).filter(piece => piece.at < end);
    }
    tail = needle.length > 1 ? text.slice(1 - needle.length) : "";
    pieces = piecesPast(pieces, length - tail.length);
    return true;
  };
  while (take());
  if (count === 0) {
    throw new Error(`That text was not found in tab ${tabId}. Quote it as written, without ` +
      "Markdown or HTML formatting, and pass tabId if it is in another tab.");
  }
  if (count > 1) {
    throw new Error(`That text appears ${count} times; quote more of it so it is unique.`);
  }
  if (wholeChips && inside.some((piece, i) => i > 0 && inside[i - 1].endIndex !== piece.startIndex)) {
    throw new Error(SPANS_HIDDEN);
  }
  return {
    startIndex: indexAt(inside, first, false, wholeChips),
    endIndex: indexAt(inside, first + needle.length, true, wholeChips),
    tabId,
  };
}

/**
 * Cuts `document.tabs`, in place, to the tab `tabId` names (`selectTab`) and answers that tab.
 * A call of its own: once it has returned, nothing but `document.tabs` and its caller names
 * the tab, and nothing names another.
 * @throws What `selectTab` throws, before anything is let go.
 */
function cutToTab(document: GoogleDocsDocument, tabId: string | undefined): GoogleDocsTab {
  let tab = selectTab(document, tabId);
  document.tabs.splice(0, document.tabs.length, tab);
  return tab;
}

/**
 * The elements of `content`, a tab's body as the parsed answer holds it, one at a time and in
 * order, each as Google sent it. An element's slot is emptied before the element is handed
 * over, so what the answer held of the elements already read can be collected: what is in
 * hand falls from the parsed answer to the element being read.
 */
function* releasedElements(content: unknown[]): Generator<readonly unknown[]> {
  for (let at = 0; at < content.length; at++) {
    let element = content[at];
    // The parsed answer lets go of the element. The slot stays: the loop goes by index.
    content[at] = undefined;
    yield [element];
  }
}

/**
 * Finds `quote` in tab `tabId` (the document's first tab when it names none) of `document`, a
 * Doc as a fetch just answered it, and returns the range it takes there (`locateQuoteInRuns`,
 * handed the tab's body elements one at a time, as Google sent them).
 * IT TAKES `document` OVER AND EMPTIES IT: every other tab is let go before the search, and
 * each element of the tab searched leaves the parsed answer as the search is handed it.
 * Nothing is pruned, cut, stored, rendered or decoded.
 *
 * WHAT IS IN HAND as the search goes: the elements of the answer not yet read and the one
 * being read, so never more than the parsed answer held, and less with each element. For a
 * tab that is mostly ONE ELEMENT, a table of megabytes, that element stays in hand while it
 * is read, as the answer held it.
 *
 * A caller reads what else it needs of `document` (its revision) first, and hands a document
 * it means to read again a copy.
 * @throws What `selectTab` and `locateQuoteInRuns` throw, as they throw it (plain `Error`s
 * with their messages).
 */
export function locateQuoteInFetched(
  document: GoogleDocsDocument, tabId: string | undefined, quote: string,
  options?: { wholeChips?: boolean },
): DocsRange {
  let tab = cutToTab(document, tabId);
  return locateQuoteInRuns(tab.tabId, releasedElements(tab.body.content), quote, options);
}

/** A Doc as Google has it saved, for a lookup of quoted text: its tabs, and one tab's text. */
export type SavedDoc = {
  /** Every tab's identity, in the document's order. */
  readonly tabs: readonly GoogleDocTabIdentity[];
  /** `locateQuoteInRuns` in tab `tabId` as the copy holds it, with no pending edit. */
  locate(tabId: string, quote: string, options?: { wholeChips?: boolean }): DocsRange;
};

/**
 * `copy` as a lookup of quoted text reads it: the copy's outline and, for one tab, its base
 * version's runs, decoded one at a time (`DocCopy.runs`). Nothing of the document is held
 * beside the run in hand. Valid until the next await, as the copy is: use it inside
 * `DocSource.read`.
 */
export function savedDoc(copy: DocCopy): SavedDoc {
  return {
    tabs: copy.outline,
    locate(tabId, quote, options) {
      // A tab the outline does not list is refused as `selectTab` refuses it.
      let version = copy.tab(selectTab({ tabs: copy.outline }, tabId).tabId);
      if (!version) throw new Error(DOC_COPY_UNREADABLE);
      return locateQuoteInRuns(tabId, copy.runs(version), quote, options);
    },
  };
}

/** `text` trimmed, refused when nothing is left. */
function requireText(text: string, what: string): string {
  let trimmed = text.trim();
  if (!trimmed) throw new Error(`The ${what} is empty.`);
  return trimmed;
}

/** `quote` trimmed, refused when empty or longer than {@link MAX_QUOTE_CHARS} characters. */
export function requireQuote(quote: string, what = "quote"): string {
  let trimmed = requireText(quote, what);
  let characters = [...trimmed].length;
  if (characters > MAX_QUOTE_CHARS) {
    throw new Error(
      `The ${what} is ${characters} characters; at most ${MAX_QUOTE_CHARS} can be quoted.`);
  }
  return trimmed;
}

/**
 * A comment's body: the text, trimmed, checked against Drive's limit or, for a comment anchored
 * through Docs, the Docs limit.
 */
export function composeComment(text: string, anchored = false): string {
  let comment = requireText(text, "comment");
  checkCommentContent(comment, "comment", anchored ? MAX_DOCS_COMMENT_BYTES : undefined);
  return comment;
}

/** What a suggested edit replaces and with what, checked, and the note posted on it. */
export type SuggestionText = { oldText: string; newText: string; note?: string };

/**
 * Checks a suggested edit: `oldText` trimmed and limited as a quote is, `newText` kept as given
 * (empty to delete) within one paragraph and {@link MAX_REPLACEMENT_CHARS} characters, and the note,
 * trimmed, within the Docs limit on a reply.
 */
export function checkSuggestion(oldText: string, newText: string, note?: string): SuggestionText {
  let old = requireQuote(oldText, "text to replace");
  if (/[\n\v]/.test(old)) {
    throw new Error("The text to replace must sit within one paragraph.");
  }
  if (newText === old) throw new Error("The replacement is the same as the text it replaces.");
  if (/[\n\v\r]/.test(newText)) {
    throw new Error("The replacement must be one paragraph, without line breaks.");
  }
  // Refused rather than dropped, so the approval shows exactly what the Doc gets.
  for (let index = 0; index < newText.length; index++) {
    let code = newText.charCodeAt(index);
    if (isGoogleDocsStrippedCharacter(code)) {
      throw new Error("The replacement contains a character Google Docs drops from inserted " +
        `text (U+${code.toString(16).toUpperCase().padStart(4, "0")}).`);
    }
  }
  let characters = [...newText].length;
  if (characters > MAX_REPLACEMENT_CHARS) {
    throw new Error(`The replacement is ${characters} characters; at most ${
      MAX_REPLACEMENT_CHARS} can be suggested.`);
  }
  if (note === undefined) return { oldText: old, newText };
  let checked = requireText(note, "note");
  checkCommentContent(checked, "note", MAX_DOCS_COMMENT_BYTES);
  return { oldText: old, newText, note: checked };
}

/** A reply's body: the text, trimmed, within Drive's limit or, posted through Docs, the Docs limit. */
export function composeReply(text: string, throughDocs = false): string {
  let reply = requireText(text, "reply");
  checkCommentContent(reply, "reply", throughDocs ? MAX_DOCS_COMMENT_BYTES : undefined);
  return reply;
}

/**
 * A resolve's body: `undefined` without text, which sends the resolve with no content, and
 * otherwise the text as {@link composeReply} gives it.
 */
export function composeResolve(text?: string, throughDocs = false): string | undefined {
  if (text === undefined) return undefined;
  if (!text.trim()) {
    throw new Error("The reply is empty; leave it out to resolve without a reply.");
  }
  return composeReply(text, throughDocs);
}
