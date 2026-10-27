// Plain-text bodies for Drive comments, replies and suggested edits, and where a quote sits in a
// Google Doc.
//
// Drive comments are never anchored: Docs shows an API comment carrying an anchor or quoted file
// content as "Original content deleted", and no API makes a real suggestion. A quote therefore
// travels in the body, with a link to the nearest heading above it. Every body here is exactly what
// is shown for approval and what is sent; Drive stores it byte for byte.

import type { GoogleDocsDocument, GoogleDocsTab, ParagraphElement } from "./docs-api";
import { MAX_QUOTE_CHARS, checkCommentContent } from "./drive-api";
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

/** Where one paragraph starts in a tab's text, and its heading ID when it is a heading. */
type ParagraphStart = { start: number; headingId?: string };

/**
 * A tab's text as its Markdown shows it, without the formatting: text runs, chips and placeholders,
 * in document order, table cells included. Structural
 * elements arrive unvalidated, so they are read defensively.
 */
function tabText(tab: GoogleDocsTab): { text: string; paragraphs: ParagraphStart[] } {
  let chunks: string[] = [];
  let length = 0;
  let paragraphs: ParagraphStart[] = [];
  let visit = (content: unknown) => {
    if (!Array.isArray(content)) return;
    for (let element of content) {
      if (!isRecord(element)) continue;
      let { paragraph, table } = element;
      if (isRecord(paragraph)) {
        let style = paragraph.paragraphStyle;
        let headingId = isRecord(style) && typeof style.headingId === "string" && style.headingId
          ? style.headingId : undefined;
        paragraphs.push({ start: length, ...(headingId ? { headingId } : {}) });
        for (let part of Array.isArray(paragraph.elements) ? paragraph.elements : []) {
          // Chips read as the Markdown the agent was shown renders them.
          let text = isRecord(part) ? paragraphElementText(part as ParagraphElement) : undefined;
          if (typeof text === "string") {
            chunks.push(text);
            length += text.length;
          }
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
  return { text: chunks.join(""), paragraphs };
}

/**
 * Finds `quote`, trimmed, in the tab's text, where it must occur exactly once; neither side is
 * normalized. Returns the heading ID of the nearest heading at or above it, or `undefined` when no
 * heading precedes it.
 */
export function locateQuote(tab: GoogleDocsTab, quote: string): string | undefined {
  let needle = quote.trim();
  if (!needle) throw new Error("The quote is empty.");
  // The Markdown the agent read separates paragraphs differently from the Doc's own text.
  if (/[\n\v]/.test(needle)) {
    throw new Error("A quote must sit within one paragraph; quote part of one paragraph instead.");
  }
  let { text, paragraphs } = tabText(tab);
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
  let headingId: string | undefined;
  for (let paragraph of paragraphs) {
    if (paragraph.start > first) break;
    if (paragraph.headingId) headingId = paragraph.headingId;
  }
  return headingId;
}

/** A link that opens tab `tabId` of a Google Doc at heading `headingId`. */
export function headingLink(documentId: string, tabId: string, headingId: string): string {
  return `https://docs.google.com/document/d/${encodeURIComponent(documentId)}/edit?tab=${
    encodeURIComponent(tabId)}#heading=${encodeURIComponent(headingId)}`;
}

/** `text` trimmed, refused when nothing is left. */
function requireText(text: string, what: string): string {
  let trimmed = text.trim();
  if (!trimmed) throw new Error(`The ${what} is empty.`);
  return trimmed;
}

/** `quote` trimmed, refused when empty or longer than {@link MAX_QUOTE_CHARS} characters. */
function requireQuote(quote: string, what: string): string {
  let trimmed = requireText(quote, what);
  let characters = [...trimmed].length;
  if (characters > MAX_QUOTE_CHARS) {
    throw new Error(
      `The ${what} is ${characters} characters; at most ${MAX_QUOTE_CHARS} can be quoted.`);
  }
  return trimmed;
}

/** Paragraphs of a body, checked against Google's limit as the exact string sent. */
function joinBody(parts: string[], what: "comment" | "reply"): string {
  let body = parts.join("\n\n");
  checkCommentContent(body, what);
  return body;
}

/**
 * A comment's body: the quote in double quotes, when given, then the text, then the link, each its
 * own paragraph. Throws when a part is empty or out of bounds, so composing without the link checks
 * everything but the link before the document is read.
 */
export function composeComment(text: string, quote?: string, link?: string): string {
  let comment = requireText(text, "comment");
  return joinBody([
    ...(quote === undefined ? [] : [`"${requireQuote(quote, "quote")}"`]),
    comment,
    ...(link ? [link] : []),
  ], "comment");
}

/**
 * A suggested edit's body: `Suggested edit: replace "<old>" with "<new>"` (or `delete "<old>"` when
 * `newText` is empty), then the note and the link, each its own paragraph. `newText` is kept as
 * given. Throws like {@link composeComment}.
 */
export function composeSuggestion(
  oldText: string, newText: string, note?: string, link?: string,
): string {
  let old = requireQuote(oldText, "text to replace");
  if (newText === old) throw new Error("The replacement is the same as the text it replaces.");
  return joinBody([
    newText === ""
      ? `Suggested edit: delete "${old}"`
      : `Suggested edit: replace "${old}" with "${newText}"`,
    ...(note === undefined ? [] : [requireText(note, "note")]),
    ...(link ? [link] : []),
  ], "comment");
}

/** A reply's body: the text, trimmed. */
export function composeReply(text: string): string {
  return joinBody([requireText(text, "reply")], "reply");
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
