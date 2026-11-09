// Bounding the Markdown a Google Doc preview (Gatekeeper.previewResource()) carries per tab.

/** A range of a tab's Markdown, in UTF-16 code units, that a preview must keep. */
export type MarkdownSpan = { start: number; end: number };

/**
 * The most Markdown of one tab a preview carries. A tab within it is returned whole; a longer one
 * is cut down to the parts around its edits.
 */
export const MAX_PREVIEW_TAB_MARKDOWN = 256 * 1024;

/** How much Markdown a cut-down tab keeps on each side of an edit, before snapping to a block. */
export const PREVIEW_EDIT_CONTEXT = 4 * 1024;

/** The paragraph that stands in for Markdown left out of a cut-down tab. */
export function previewTrimPlaceholder(omitted: number): string {
  return `*[${omitted.toLocaleString("en-US")} characters of this tab are not shown in this preview.]*`;
}

/**
 * `markdown`, cut down to at most about MAX_PREVIEW_TAB_MARKDOWN if longer.
 *
 * Keeps PREVIEW_EDIT_CONTEXT around each span in `keep`, widened to the nearest paragraph break
 * (or, failing that, line break) within another PREVIEW_EDIT_CONTEXT, and replaces each run left
 * out with one placeholder paragraph (previewTrimPlaceholder). Spans are kept in document order
 * until the budget is spent: the first is always kept whole, so one edit larger than the budget
 * still shows, and the rest of an over-budget tab is left out. With nothing to keep, the tab's
 * beginning is.
 *
 * Cuts follow Markdown's lines, not its structure, so a cut inside a table or code block leaves
 * the placeholder inside it. Cuts are always at least PREVIEW_EDIT_CONTEXT from a kept span.
 */
export function trimDocumentPreviewMarkdown(markdown: string, keep: MarkdownSpan[]): string {
  if (markdown.length <= MAX_PREVIEW_TAB_MARKDOWN) return markdown;

  let windows = keep.length === 0
    ? [{ start: 0, end: blockEnd(markdown, MAX_PREVIEW_TAB_MARKDOWN) }]
    : keep
      .map(({ start, end }) => ({
        start: blockStart(markdown, start - PREVIEW_EDIT_CONTEXT),
        end: blockEnd(markdown, end + PREVIEW_EDIT_CONTEXT),
      }))
      .toSorted((a, b) => a.start - b.start);

  let kept: MarkdownSpan[] = [];
  let length = 0;
  for (let window of windows) {
    let last = kept.at(-1);
    if (last && window.start <= last.end) {
      if (window.end <= last.end) continue;
      if (length + window.end - last.end > MAX_PREVIEW_TAB_MARKDOWN) break;
      length += window.end - last.end;
      last.end = window.end;
      continue;
    }
    if (last && length + window.end - window.start > MAX_PREVIEW_TAB_MARKDOWN) break;
    length += window.end - window.start;
    kept.push({ ...window });
  }

  let parts: string[] = [];
  let cursor = 0;
  for (let { start, end } of kept) {
    if (start > cursor) parts.push(placeholderBlock(start - cursor));
    parts.push(markdown.slice(start, end));
    cursor = end;
  }
  if (cursor < markdown.length) parts.push(placeholderBlock(markdown.length - cursor));
  return parts.join("");
}

function placeholderBlock(omitted: number): string {
  return `\n\n${previewTrimPlaceholder(omitted)}\n\n`;
}

/** Where a kept window starting near `index` begins: just after a break at or before it. */
function blockStart(markdown: string, index: number): number {
  if (index <= 0) return 0;
  let floor = index - PREVIEW_EDIT_CONTEXT;
  let paragraph = markdown.lastIndexOf("\n\n", index);
  if (paragraph !== -1 && paragraph >= floor) return paragraph + 2;
  let line = markdown.lastIndexOf("\n", index);
  if (line !== -1 && line >= floor) return line + 1;
  return avoidSplitSurrogate(markdown, index);
}

/** Where a kept window ending near `index` ends: just after a break at or after it. */
function blockEnd(markdown: string, index: number): number {
  if (index >= markdown.length) return markdown.length;
  let ceiling = index + PREVIEW_EDIT_CONTEXT;
  let paragraph = markdown.indexOf("\n\n", index);
  if (paragraph !== -1 && paragraph <= ceiling) return paragraph + 1;
  let line = markdown.indexOf("\n", index);
  if (line !== -1 && line <= ceiling) return line + 1;
  return avoidSplitSurrogate(markdown, index);
}

/** `index`, moved back one if it would split a surrogate pair. */
function avoidSplitSurrogate(markdown: string, index: number): number {
  let unit = markdown.charCodeAt(index);
  return unit >= 0xdc00 && unit <= 0xdfff ? index - 1 : index;
}
