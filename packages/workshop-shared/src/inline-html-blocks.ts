// `<inline-html>` blocks in an agent's answer: live views the Workshop draws in place of the
// block's text (see plans/live-views.md). This module is the one parser of the syntax: the
// Workshop lays out a message with it, and the evals find the views an answer shows with it.

import { fromMarkdown } from "mdast-util-from-markdown";

/** One closed `<inline-html>` block of an agent answer. */
export type InlineHtmlBlock = {
  kind: "block";

  /** The block's HTML: everything between its tags, trimmed. */
  html: string;

  /** The text of the block's `<title>` element, if it has one. */
  title?: string;

  /** Why the block must not run: it has nothing but a title. */
  error?: string;
};

/** One part of an agent answer, in order: prose, a closed block, or a block still open. */
export type InlineHtmlSegment =
  /** Prose. `start` is its offset in the answer, for positions such as `CapsuleSpecifier`'s. */
  | { kind: "text"; text: string; start: number }
  | InlineHtmlBlock
  /**
   * An opening tag with no closing tag after it: the answer is still streaming, or the agent never
   * closed the block. `text` runs from the tag to the end of the answer. `html` is the block's
   * HTML so far, which is always the start of its `html` once it closes.
   */
  | { kind: "open"; text: string; html: string; title?: string };

const CLOSE_TAG = "</inline-html>";

// A tag counts only alone on its line, with no indent, outside a code block, so prose and
// examples that mention it stay prose.
const OPEN = /^<inline-html>[ \t]*$/;
const CLOSE = /^<\/inline-html>[ \t]*$/;

// The top-level code blocks of `text` from `from` to `to`, as offsets into `text`, as the chat
// renders that prose: the Workshop draws each part of an answer's prose as its own Markdown
// document, with the parser this one uses. A tag line has no indent, so it ends every list item and
// block quote and no indented code block holds it: only a fenced code block at the top of the
// document can. Markdown decides a line's block from the lines before it, so these blocks hold for
// every line that ends by `to`, whatever follows.
function codeBlocksIn(text: string, from: number, to: number): {start: number; end: number}[] {
  return fromMarkdown(text.slice(from, to)).children.flatMap(node => {
    let start = node.position?.start.offset, end = node.position?.end.offset;
    return node.type === "code" && start !== undefined && end !== undefined
      ? [{start: from + start, end: from + end}] : [];
  });
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

function closedBlock(html: string): InlineHtmlBlock {
  let block: InlineHtmlBlock = {kind: "block", html};
  let {title} = splitTitle(html);
  if (title !== undefined) block.title = title;
  if (isEmptyViewHtml(html)) block.error = "This view has no content.";
  return block;
}

// An open block's HTML so far: its body, trimmed as a closed block's is, without a closing tag
// line that has only partly arrived or not yet ended.
function openHtml(body: string): string {
  let last = body.slice(Math.max(body.lastIndexOf("\n"), body.lastIndexOf("\r")) + 1);
  return (CLOSE_TAG.startsWith(last.trimEnd()) ? body.slice(0, body.length - last.length) : body).trim();
}

const LINE_END = /[\r\n]/g;

/**
 * Splits an agent answer into prose and `<inline-html>` blocks, in order. While the answer is
 * `streaming`, more text may join its last line, so that line opens or closes no block until it
 * ends: a block that opens or closes stays so as the answer grows.
 */
export function parseInlineHtmlBlocks(
    text: string, {streaming = false}: {streaming?: boolean} = {}): InlineHtmlSegment[] {
  let segments: InlineHtmlSegment[] = [];
  let prose = 0;
  let line = 0;
  // The code blocks of the prose since the last block, up to `until`. Parsing takes about 3 ms per
  // KB and the Workshop parses on every streamed delta, so prose with no fence marker is not
  // parsed, and a tag line past `until` parses twice as far: a code example of many tag lines
  // costs time linear in its length.
  let code: {blocks: {start: number; end: number}[]; until: number} | undefined;
  let inCodeBlock = (lineStart: number, lineEnd: number) => {
    if (code === undefined && !/```|~~~/.test(text.slice(prose, lineEnd))) return false;
    if (code === undefined || lineEnd > code.until) {
      let until = code === undefined ? lineEnd : Math.min(text.length, Math.max(lineEnd, 2 * code.until - prose));
      code = {blocks: codeBlocksIn(text, prose, until), until};
    }
    return code.blocks.some(block => block.start <= lineStart && lineStart < block.end);
  };

  // A line ends at "\n", "\r\n" or a lone "\r", as Markdown reads it.
  let lineEndAt = (start: number) => {
    LINE_END.lastIndex = start;
    return LINE_END.exec(text) === null ? text.length : LINE_END.lastIndex - 1;
  };
  let nextLineAt = (lineEnd: number) => lineEnd + (text.startsWith("\r\n", lineEnd) ? 2 : 1);
  let isTag = (tag: RegExp, start: number, lineEnd: number) =>
    (!streaming || lineEnd < text.length) && tag.test(text.slice(start, lineEnd));

  while (line < text.length) {
    let lineEnd = lineEndAt(line);
    if (!isTag(OPEN, line, lineEnd) || inCodeBlock(line, lineEnd)) {
      line = nextLineAt(lineEnd);
      continue;
    }

    if (prose < line) segments.push({kind: "text", text: text.slice(prose, line), start: prose});
    let body = nextLineAt(lineEnd);
    let close = body;
    while (close < text.length && !isTag(CLOSE, close, lineEndAt(close))) {
      close = nextLineAt(lineEndAt(close));
    }
    if (close >= text.length) {
      let rest = text.slice(line);
      let {title} = splitTitle(rest);
      let html = openHtml(text.slice(body));
      segments.push(title === undefined ? {kind: "open", text: rest, html} : {kind: "open", text: rest, html, title});
      return segments;
    }

    segments.push(closedBlock(text.slice(body, close).trim()));
    prose = lineEndAt(close);
    line = nextLineAt(prose);
    code = undefined;
  }

  if (prose < text.length) segments.push({kind: "text", text: text.slice(prose), start: prose});
  return segments;
}
