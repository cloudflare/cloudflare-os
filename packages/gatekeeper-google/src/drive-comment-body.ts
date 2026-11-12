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
import { paragraphElementText } from "./markdown-converter";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The tab `tabId` names, or the document's first tab when it names none. A child tab is found like
 * any other: the document's tab list is already flattened.
 */
export function selectTab(document: GoogleDocsDocument, tabId?: string): GoogleDocsTab {
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
 * indices one for one, or a chip, which reads as more text than the one index it takes.
 */
type Piece = { at: number; length: number; startIndex: number; endIndex: number; run: boolean };

/**
 * A tab's text as its Markdown shows it, without the formatting: text runs, chips and placeholders,
 * in document order, table cells included, with where each piece sits in the tab. Structural
 * elements arrive unvalidated, so they are read defensively.
 */
function tabText(tab: GoogleDocsTab): { text: string; pieces: Piece[] } {
  let chunks: string[] = [];
  let length = 0;
  let pieces: Piece[] = [];
  let visit = (content: unknown) => {
    if (!Array.isArray(content)) return;
    for (let element of content) {
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
  visit(tab.body.content);
  return { text: chunks.join(""), pieces };
}

/** The refusal for replacing part of a chip, which takes one index however long its text reads. */
const PARTIAL_CHIP = "That text takes in part of a smart chip (a person, date or link), which " +
  "can only be replaced whole. Include all of the chip's text, or none of it.";

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

/**
 * Finds `quote`, trimmed, in the tab's text, where it must occur exactly once; neither side is
 * normalized. Returns the range it takes in the tab. A chip the quote takes part of is taken
 * whole, as a comment's anchor; with `wholeChips`, as for text a suggestion replaces, it is refused.
 */
export function locateQuote(
  tab: GoogleDocsTab, quote: string, { wholeChips = false }: { wholeChips?: boolean } = {},
): DocsRange {
  let needle = quote.trim();
  if (!needle) throw new Error("The quote is empty.");
  // The Markdown the agent read separates paragraphs differently from the Doc's own text.
  if (/[\n\v]/.test(needle)) {
    throw new Error("A quote must sit within one paragraph; quote part of one paragraph instead.");
  }
  let { text, pieces } = tabText(tab);
  let first = text.indexOf(needle);
  if (first < 0) {
    throw new Error(`That text was not found in tab ${tab.tabId}. Quote it as written, without ` +
      "Markdown or HTML formatting, and pass tabId if it is in another tab.");
  }
  let count = 0;
  for (let at = first; at >= 0; at = text.indexOf(needle, at + 1)) count++;
  if (count > 1) {
    throw new Error(`That text appears ${count} times; quote more of it so it is unique.`);
  }
  return {
    startIndex: indexAt(pieces, first, false, wholeChips),
    endIndex: indexAt(pieces, first + needle.length, true, wholeChips),
    tabId: tab.tabId,
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

/** A reply's body: the text, trimmed. */
export function composeReply(text: string): string {
  let reply = requireText(text, "reply");
  checkCommentContent(reply, "reply");
  return reply;
}

/**
 * A resolve's body: `undefined` without text, which sends the resolve with no content, and
 * otherwise the text as {@link composeReply} gives it.
 */
export function composeResolve(text?: string): string | undefined {
  if (text === undefined) return undefined;
  if (!text.trim()) {
    throw new Error("The reply is empty; leave it out to resolve without a reply.");
  }
  return composeReply(text);
}
