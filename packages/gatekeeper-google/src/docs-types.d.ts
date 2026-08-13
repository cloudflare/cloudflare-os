export type DocMetadata = {
  /** Document title. */
  title: string;

  /** When the document was last modified. */
  lastModified: Date;
}

export interface GoogleDocSession {
  /** Get basic metadata about the document (title, last modified time). */
  getMetadata(): Promise<DocMetadata>;

  /** Get the full document content, converted to Markdown. */
  getContent(): Promise<string>;

  /**
   * Find `oldMarkdown` in the current document content and replace it with `newMarkdown`.
   * Both parameters are Markdown text.
   *
   * The match must be unique -- if `oldMarkdown` appears zero times or more than once in the
   * document, an error is thrown. If the match is ambiguous, include more surrounding context
   * in `oldMarkdown` to disambiguate.
   *
   * The gatekeeper automatically trims unchanged leading and trailing text before sending the
   * edit to Google Docs, so it's fine (and encouraged) to include extra context in `oldMarkdown`
   * and `newMarkdown` for matching purposes.
   *
   * The Markdown is mapped back to Google Docs operations using the document's source map. The
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
   *
   * A subsequent `getContent()` call reflects this replacement.
   */
  replaceText(oldMarkdown: string, newMarkdown: string): Promise<void>;

  /**
   * Append Markdown content to the end of the document. The same Markdown features as
   * `replaceText()` are supported.
   */
  appendText(markdown: string): Promise<void>;
}
