/** Metadata for one native Google Doc. */
export type DocMetadata = {
  /**
   * The Doc's file ID, as in its URL and in a Google Drive resource URL for it. Empty for a Doc
   * not created yet.
   */
  id: string;

  /** Document title. */
  title: string;

  /** When the document was last modified. */
  lastModified: Date;
}

/**
 * One tab of a native Google Doc.
 *
 * A document is a tree of tabs; `listTabs()` returns that tree flattened depth-first, parents
 * before children, so `parentTabId` reconstructs the hierarchy without nested objects.
 */
export type GoogleDocTab = {
  /** Immutable tab ID. Pass it to `getContent()` and to edits to target this tab. */
  id: string;

  /** Tab name, as shown in the document's tab list. */
  title: string;

  /** The tab that contains this one, absent for a top-level tab. */
  parentTabId?: string;

  /** Position among the tabs sharing this parent, counting from 0. */
  index: number;

  /** Depth in the tab tree: 0 for a top-level tab, 1 for its child, and so on. */
  nestingLevel: number;
}

/**
 * Read-only access to one native Google Doc.
 *
 * Each tab holds its own content. Call `listTabs()` before `getContent()` to see which tabs
 * exist, then read one of them.
 */
export interface GoogleDocReadSession {
  /** Return current document metadata. Works with any number of tabs. */
  getMetadata(): Promise<DocMetadata>;

  /** Return every tab in the document, flattened depth-first with parents before children. */
  listTabs(): Promise<GoogleDocTab[]>;

  /**
   * Return one tab's content as Markdown. A line break within a paragraph is `\u000b`, while
   * `\n` ends the paragraph. Tables of contents and interior section breaks are bracketed
   * placeholders.
   *
   * Native tables are raw HTML, written one row and one cell to a line with fixed indentation:
   * a `<tr>` line for each row, indented two spaces, and under it a `<td>` line for each cell,
   * indented four, a cell covered by a merged one included. A cell that holds more than one
   * paragraph or list spans lines instead, each of them on a line indented six spaces:
   *
   * ```
   * <table>
   *   <tr>
   *     <td><p>Name</p></td>
   *     <td><p></p></td>
   *   </tr>
   *   <tr>
   *     <td>
   *       <p>First paragraph</p>
   *       <p>Second paragraph</p>
   *     </td>
   *     <td><p>Total</p></td>
   *   </tr>
   * </table>
   * ```
   *
   * A cell holds its paragraphs as `<p>`, heading and list elements, with `<strong>`, `<em>`,
   * `<s>` and `<a href>` for bold, italic, strikethrough and links, `<br>` for a line break
   * within a paragraph, and `&amp;`, `&lt;` and `&gt;` for `&`, `<` and `>` in its text. An
   * empty cell reads `<td><p></p></td>`, as the second cell above does. A merged cell carries
   * `rowspan`, `colspan` or both, and the cells it covers read as empty cells. Where a bulleted
   * list item starts with its bullet character and a space, those show the bullet and are not
   * part of the item's text.
   *
   * This reads exactly one tab and never combines tabs, so pass an ID returned by `listTabs()`.
   * Omitting `tabId` is valid only when `listTabs()` returns exactly one tab.
   */
  getContent(tabId?: string): Promise<string>;
}
