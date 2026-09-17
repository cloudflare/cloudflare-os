import type { GoogleDocReadSession } from "./docs-read-types";
export type { DocMetadata, GoogleDocReadSession, GoogleDocTab } from "./docs-read-types";

/**
 * Read/write access to one directly bound native Google Doc.
 *
 * Metadata covers the whole document; reads and edits each target exactly one tab, so call
 * `listTabs()` first and pass the ID of the tab to act on.
 */
export interface GoogleDocSession extends GoogleDocReadSession {

  /**
   * Find `oldMarkdown` in tab `tabId` and replace it with `newMarkdown`.
   * Both parameters are Markdown text.
   *
   * Matching and editing are local to that one tab: pass an ID returned by `listTabs()`, and omit
   * `tabId` only when `listTabs()` returns exactly one tab.
   *
   * The match must be unique -- if `oldMarkdown` appears zero times or more than once in the
   * selected tab, an error is thrown. If the match is ambiguous, include more surrounding context
   * in `oldMarkdown` to disambiguate.
   *
   * The gatekeeper automatically trims unchanged leading and trailing text before sending the
   * edit to Google Docs, so it's fine (and encouraged) to include extra context in `oldMarkdown`
   * and `newMarkdown` for matching purposes.
   *
   * The Markdown is mapped back to Google Docs operations using the tab's source map. The
   * following Markdown features are supported in `newMarkdown`:
   * - Headings (`# ` through `###### `)
   * - Bold (`**text**`)
   * - Italic (`*text*`)
   * - Bold+italic (`***text***`)
   * - Links (`[text](url)`)
   * - Strikethrough (`~~text~~`)
   * - Bullet lists (`- item`)
   * - Numbered lists (`1. item`)
   * - Plain paragraphs (separated by blank lines)
   *
   * Unsupported Markdown features (tables, images, code blocks, etc.) are inserted as plain text.
   * Existing structural content and paragraphs containing elements such as smart chips are
   * read-only. Narrow the match to plain text in another paragraph.
   *
   * A subsequent `getContent(tabId)` call reflects this replacement.
   */
  replaceText(oldMarkdown: string, newMarkdown: string, tabId?: string): Promise<void>;

  /**
   * Append Markdown content to the end of tab `tabId`. The same Markdown features and tab
   * selection rules as `replaceText()` apply. The tab must end in a paragraph; add one after a
   * final table or other structural element before appending.
   */
  appendText(markdown: string, tabId?: string): Promise<void>;
}
