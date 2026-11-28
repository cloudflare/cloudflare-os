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

  /** Set while edits to this tab are pending: queued, and not yet in the document. */
  pending?: true;
}

/**
 * Read-only access to one native Google Doc.
 *
 * Each tab holds its own content. Call `listTabs()` before `getContent()` to see which tabs
 * exist, then read one of them.
 *
 * A `<user-focus>` on this document says where the user was reading. Its `anchor` is
 * `?tab=<tabId>`, then `#heading=<ID>`, as in a link to a heading: of the last heading at or
 * before what they had selected or clicked, where there is one, or with neither of the last they
 * had passed. Its `label` gives the tab's and the heading's titles as last saved, where
 * `getContent()` shows them as the edits awaiting approval leave them: take the tab from the
 * anchor, by its ID in `listTabs()`. `getContent()` marks no heading with its ID, so find the
 * heading by the label's title, which such an edit may have rewritten: with none of that title
 * there, or several, go by the body, or ask which is meant. Its body is the text they had
 * selected, or else the paragraph they had clicked. It is the text as they saw it: look for it in
 * `getContent()`, where an edit awaiting approval may have changed it, and where the paragraphs
 * of a table cell stand apart that the body runs together. What they clicked is told only for as
 * long as the document and the edits awaiting approval read as they did when they clicked it. For
 * a table cell they had clicked, the anchor ends `table=<table>&row=<row>&column=<column>`, after
 * `#` or `&`: the cell as the table methods of a read and write session name it, each counted
 * from 0 and the table among those `getContent()` shows. The label counts the same three from 1,
 * as the user would, so take them from the anchor. A label that ends `Cell of a table being
 * changed` is of a cell whose place was not certain where the user clicked it, as where edits
 * awaiting approval were not shown applied: the anchor names no cell, so find it by the body,
 * which is its text. A body whose first line is `(shown with changes not yet approved)` reads as
 * the edits still awaiting approval leave it, so the document may not hold that text.
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
   * A table's look shows in `style` attributes, which a table as Google Docs adds it has none
   * of. On `<td>`, after any spans, they give the cell's `background-color` (`#rrggbb`, or
   * `transparent` for none), `vertical-align` (`top`, `middle` or `bottom`), `padding-top`,
   * `-right`, `-bottom` and `-left` in points, and `border-top`, `-right`, `-bottom` and `-left`
   * as `<width>pt solid|dotted|dashed #rrggbb` or `none`; four equal paddings or borders read
   * as `padding` or `border`. What most cells share is written once on `<table>`, and a cell
   * writes only what differs from it. Unstyled, a cell is unshaded, aligned to the top, padded
   * 5pt and bordered `1pt solid #000000`. An edge two cells share shows on both, and a merged
   * cell shows the look of the whole block. When a column has a fixed width, a line
   * `  <colgroup><col><col style="width:120pt"></colgroup>` follows `<table>`, one `<col>` for
   * each column, those without a width sharing what the others leave. A row's least height
   * shows as `<tr style="height:30pt">`:
   *
   * ```
   * <table style="border:1pt solid #cccccc">
   *   <colgroup><col style="width:120pt"><col></colgroup>
   *   <tr style="height:30pt">
   *     <td style="background-color:#f3f3f3;vertical-align:middle"><p>Name</p></td>
   *     <td><p></p></td>
   *   </tr>
   * </table>
   * ```
   *
   * Suggestions made in suggesting mode show where they stand until someone accepts or rejects
   * them: text a suggestion inserts reads between `{++` and `++}`, and text one deletes between
   * `{--` and `--}`, as `Plan {++new ++}for {--next --}week`; in a table `<ins>` and `<del>`
   * mark them. A suggested change of style, or of a paragraph's style or bullet, is not shown.
   * The marks are not text of the Doc, and an edit made through this connection cannot change
   * suggested text: it is accepted or rejected in Google Docs. Nor can it change the text of a
   * table, row or cell that a suggestion inserts or deletes, even where that text is not marked.
   *
   * This reads exactly one tab and never combines tabs, so pass an ID returned by `listTabs()`.
   * Omitting `tabId` is valid only when `listTabs()` returns exactly one tab.
   */
  getContent(tabId?: string): Promise<string>;
}
