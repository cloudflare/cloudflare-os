// `<gadget-ui>` blocks in an agent's answer: live views the Workshop draws in place of the block's
// text (see plans/live-views.md). This module is the one parser of the syntax. The Workshop
// lays out a message with it, and the kernel writes the text a chat gateway gets with it.

/** One closed `<gadget-ui>` block of an agent answer. */
export type GadgetUiBlock = {
  kind: "block";

  /** The block's HTML: everything between its tags, trimmed. */
  html: string;

  /** The text of the block's `<title>` element, if it has one. */
  title?: string;

  /** Why the block must not run: it has nothing but a title. */
  error?: string;
};

/** One part of an agent answer, in order: prose, a closed block, or a block still open. */
export type GadgetUiSegment =
  /** Prose. `start` is its offset in the answer, for positions such as `CapsuleSpecifier`'s. */
  | { kind: "text"; text: string; start: number }
  | GadgetUiBlock
  /**
   * An opening tag with no closing tag after it: the answer is still streaming, or the agent never
   * closed the block. `text` runs from the tag to the end of the answer. `html` is the block's
   * HTML so far, which is always the start of its `html` once it closes.
   */
  | { kind: "open"; text: string; html: string; title?: string };

const CLOSE = "</gadget-ui>";

// A tag counts only where it opens a line outside a code fence, so prose and examples that
// mention the tag stay prose.
const OPEN = /^[ \t]*<gadget-ui\b[^>]*>/;

// Any line that may open a fence opens one: reading too much as code only keeps a block from
// being drawn. A fence may follow list item and block quote markers on its line. Each marker ends
// its own run of spaces, so the pattern reads a line one way only.
const FENCE_OPEN = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+|>[ \t]*)*(`{3,}(?=[^`]*$)|~{3,})/;

// Only a closing fence closes one: a marker alone on its line, indented at most three spaces more
// than the line that opened it. A fence in a list item opens and closes at the item's indent.
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

type Fence = { marker: string; indent: number };

const columns = (text: string) => text.replaceAll("\t", "    ").length;
const indentOf = (line: string) => columns(line.slice(0, line.search(/\S|$/)));

/** The fence open after `line`, given the fence open before it (null when none is). */
function fenceAfter(fence: Fence | null, line: string): Fence | null {
  if (fence === null) {
    let open = FENCE_OPEN.exec(line);
    if (open === null) return null;
    // A fence after markers closes relative to the column it starts at, as in its list item.
    let marker = open[1];
    return {marker, indent: columns(open[0].slice(0, -marker.length))};
  }
  let marker = FENCE_CLOSE.exec(line)?.[1];
  let closes = marker !== undefined && marker[0] === fence.marker[0] &&
      marker.length >= fence.marker.length && indentOf(line) <= fence.indent + 3;
  return closes ? null : fence;
}

// The first <title> element of `html`: its text as HTML reads it, with runs of whitespace as one
// space, and the HTML around it. Two plain searches, because a lazy pattern rescans the rest of the
// HTML from every <title> that never closes, and the Workshop parses on every streamed delta.
function splitTitle(html: string): {title: string | undefined; rest: string} {
  let open = html.search(/<title>/i);
  let textStart = open + "<title>".length;
  let textLength = open === -1 ? -1 : html.slice(textStart).search(/<\/title>/i);
  if (textLength === -1) return {title: undefined, rest: html};
  let textEnd = textStart + textLength;
  let title = html.slice(textStart, textEnd).replace(/\s+/g, " ").trim();
  return {
    title: title === "" ? undefined : title,
    rest: html.slice(0, open) + html.slice(textEnd + "</title>".length),
  };
}

/**
 * Whether a view's HTML has no content: nothing but whitespace once its `<title>` is taken out.
 * Such a block shows an error, and the kernel refuses such a view from `embedView` unless a script
 * draws it.
 */
export function isEmptyViewHtml(html: string): boolean {
  return splitTitle(html).rest.trim() === "";
}

function closedBlock(html: string): GadgetUiBlock {
  let block: GadgetUiBlock = {kind: "block", html};
  let {title} = splitTitle(html);
  if (title !== undefined) block.title = title;
  if (isEmptyViewHtml(html)) block.error = "This view has no content.";
  return block;
}

// An open block's HTML so far: its body, trimmed as a closed block's is, without a closing tag
// that has only partly arrived. Any part of a closing tag starts at its only "<".
function openHtml(body: string): string {
  let tag = body.lastIndexOf("<");
  return (tag !== -1 && CLOSE.startsWith(body.slice(tag)) ? body.slice(0, tag) : body).trim();
}

/** Splits an agent answer into prose and `<gadget-ui>` blocks, in order. */
export function parseGadgetUiBlocks(text: string): GadgetUiSegment[] {
  let segments: GadgetUiSegment[] = [];
  let prose = 0;
  let line = 0;
  let fence: Fence | null = null;

  let lineEndAt = (start: number) => {
    let end = text.indexOf("\n", start);
    return end === -1 ? text.length : end;
  };

  while (line < text.length) {
    let lineEnd = lineEndAt(line);
    let open = fence === null ? OPEN.exec(text.slice(line, lineEnd)) : null;
    if (open === null) {
      fence = fenceAfter(fence, text.slice(line, lineEnd));
      line = lineEnd + 1;
      continue;
    }

    if (prose < line) segments.push({kind: "text", text: text.slice(prose, line), start: prose});
    let body = line + open[0].length;
    let close = text.indexOf(CLOSE, body);
    if (close === -1) {
      let rest = text.slice(line);
      let {title} = splitTitle(rest);
      let html = openHtml(text.slice(body));
      segments.push(title === undefined ? {kind: "open", text: rest, html} : {kind: "open", text: rest, html, title});
      return segments;
    }

    segments.push(closedBlock(text.slice(body, close).trim()));
    prose = close + CLOSE.length;
    line = lineEndAt(prose) + 1;
  }

  if (prose < text.length) segments.push({kind: "text", text: text.slice(prose), start: prose});
  return segments;
}

/**
 * An agent answer for a reader that shows only text, such as a chat gateway: each closed
 * `<gadget-ui>` block becomes a note that names it. An unclosed block stays as written, as the
 * chat shows it.
 */
export function gadgetUiAnswerAsText(text: string): string {
  return parseGadgetUiBlocks(text).map(segment => segment.kind !== "block" ? segment.text
      : segment.title === undefined ? "[View in the chat]" : `[View in the chat: ${segment.title}]`)
      .join("");
}
