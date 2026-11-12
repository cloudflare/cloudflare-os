import type { DocSuggestion, DriveComment, DriveCommentReply } from "./comment-types";
import type { GoogleDocReadSession } from "./docs-read-types";
export type { DocMetadata, GoogleDocReadSession, GoogleDocTab } from "./docs-read-types";

/** Options for {@link GoogleDocSession.comment}. */
export type DocCommentOptions = {
  /**
   * Text of the Doc this comment is about, within one paragraph and at most 500 characters, which
   * must occur exactly once in the tab as Google has it saved, not counting edits still waiting for
   * approval: the tab's text as `getContent()` shows it, without Markdown formatting (no `**`, list
   * markers or escapes) and, in a table, without HTML (`&` rather than `&amp;`, no tags). The
   * comment is attached to it, as one made in Google Docs is, and it must still occur exactly
   * once in the tab when the comment is approved.
   */
  quote: string;
  /** The tab `quote` is in: an ID returned by `listTabs()`, omitted only when there is one tab. */
  tabId?: string;
};

/** Options for {@link GoogleDocSession.suggestEdit}. */
export type DocSuggestEditOptions = {
  /** Why, posted as a reply on the suggestion; at most 2048 bytes of UTF-8. */
  note?: string;
  /** The tab `oldText` is in: an ID returned by `listTabs()`, omitted only when there is one tab. */
  tabId?: string;
};

/** A table to add with `insertTable()`. */
export type NewDocTable = {
  /** How many rows the table has: at least 1. */
  rows: number;

  /** How many columns it has: 1 to 20. */
  columns: number;

  /**
   * `cells[row][column]` is each cell's text. Rows left out at the end, and cells left out at
   * the end of a row, are empty; an empty cell before a filled one is `""`. The text is plain:
   * nothing in it is read as Markdown or HTML. `\n` starts a new paragraph in the cell and
   * `\u000b` breaks a line within one. The cells of one call hold at most 2,000 `\n` in all.
   */
  cells?: string[][];

  /**
   * Where the table goes: Markdown that occurs exactly once in the tab, found as `replaceText()`
   * finds `oldMarkdown`. The table follows the paragraph, heading, list item or table that the
   * text ends in (text inside a table names that whole table); line breaks at the end of the
   * text only help to make it unique. To make it unique, add the text before it or the line
   * break that ends its paragraph: text added after it names a later paragraph. A line break at
   * the start of the text stands for the start of a line, the tab's first line included. Omit
   * `after` to add the table at the end of the tab.
   */
  after?: string;
};

/** Rows or columns to add to a table, for `insertTableRows()` and `insertTableColumns()`. */
export type DocTableInsertion = {
  /** The table: its position among the tab's tables, counting from 0. */
  table: number;

  /**
   * The row or column, counting from 0, that the new ones go before. Omit it, or give the
   * table's number of rows or columns, to add them after the last.
   */
  at?: number;

  /**
   * How many to add. For rows, when left out, it is as many as `cells` holds, or 1 without
   * `cells`. For columns it is 1 unless given: `cells` never sets it. `cells` may fill fewer
   * rows or columns than `count`, which leaves the rest empty, but not more.
   */
  count?: number;

  /**
   * The new cells' text, as in `NewDocTable.cells`: plain, with cells left out at the end
   * empty and an empty cell before a filled one `""`. For rows, `cells[i][column]` is the text
   * of the i-th new row's cell in that column. For columns, `cells[row][i]` is the text of the
   * i-th new column's cell in that row of the table: one array per row of the table, each
   * holding one text per new column.
   */
  cells?: string[][];
};

/** Rows or columns to delete from a table, for `deleteTableRows()` and `deleteTableColumns()`. */
export type DocTableDeletion = {
  /** The table: its position among the tab's tables, counting from 0. */
  table: number;

  /** The first row or column to delete, counting from 0. */
  at: number;

  /** How many to delete: 1 by default. */
  count?: number;
};

/**
 * Read/write access to one directly bound native Google Doc, and to its comments.
 *
 * Metadata covers the whole document; reads and edits each target exactly one tab, so call
 * `listTabs()` first and pass the ID of the tab to act on.
 *
 * When to use which:
 * - `replaceText()` and `appendText()` change the Doc's text once the user approves them.
 * - `suggestEdit()` leaves a suggestion in the Doc, as one made in Suggesting mode, which someone
 *   who can edit the Doc accepts or rejects there; the text does not change until then.
 * - `comment()` is a remark on a passage of the Doc, attached to the text it quotes.
 * - `reply()` and `resolve()` answer the comments `listComments()` returns.
 * - A comment attached to no text, or an answer to one, takes a Google Drive connection to the
 *   file with read and write access: request the resource URL
 *   `https://drive.google.com/file/d/<id>/view?access=write`, where `<id>` is `getMetadata().id`.
 *
 * Every comment write is queued for the user's approval. A comment, reply or resolve returns the
 * pending item, which `listComments()` shows until it is decided; `suggestEdit()` returns a
 * `DocSuggestion`, which no listing shows, queued or made. A write needs the connected account to
 * be able to comment on the Doc, and a new comment makes Google email the Doc's owner. An email
 * address written after `@` or `+` in the text mentions that person: Google emails them the text,
 * whether or not they can open the Doc. A comment, reply or note holds at most 2048 bytes of UTF-8.
 * A Doc not created yet has no comments, and takes no comment writes until it is.
 *
 * `getContent()` shows each table as HTML that starts at a line reading exactly `<table>`,
 * directly followed by a `  <tr>` line; a paragraph whose text merely reads `<table>` is
 * followed by a blank line and is not a table. The table methods name a table by its position
 * among the tab's tables, counting from 0 in the order `getContent()` shows them; a table inside
 * another table's cell is not counted and cannot be changed. Rows and columns count from 0 too:
 * each `  <tr>` line, indented two spaces, is a row, and each `    <td` line under it, indented
 * four, a column. The lines of a table inside a cell are indented further and are not counted.
 * Every edit shows in the next `getContent()` call. Adding or deleting a table renumbers the
 * tables after it, and adding or deleting rows or columns renumbers those after them.
 *
 * Tables, rows and columns can be added only until the tables of one tab hold 5,000 cells
 * in all, a cell counting once for each paragraph it holds.
 *
 * The rows and columns of a table can be changed, and the table deleted, only while no other
 * table of the tab reads the same as it does: the same HTML, apart from the number a numbered
 * list starts at and any number in square brackets, as a footnote's is. While two tables read
 * the same, such as two empty tables or two with only the same header row,
 * make them differ first, for example by changing the text of a cell with `replaceText()`
 * (quote the text above the table so that the match is unique), and then change either one.
 * The cell can be changed back once the tables differ in another way, as they do when one of
 * them has gained a row.
 */
export interface GoogleDocSession extends GoogleDocReadSession {

  /**
   * Find `oldMarkdown` in tab `tabId` and replace it with `newMarkdown`.
   * Both parameters are Markdown text or, inside a table, the table's HTML (described below).
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
   * - Line breaks within a paragraph (`\u000b`, as `getContent()` returns them)
   *
   * Unsupported Markdown features (tables, images, code blocks, etc.) are inserted as plain text,
   * and so is a table written as HTML: add a table with `insertTable()`. Tables of contents,
   * section breaks and paragraphs containing elements such as images or smart chips are
   * read-only. Narrow the match to plain text in another paragraph.
   *
   * Inside a table, both parameters are the HTML that `getContent()` returns there, and a
   * replacement changes the text of cells: of their paragraphs, headings and list items, in one
   * cell or in several. Write `&amp;`, `&lt;` and `&gt;` for `&`, `<` and `>`, `<br>` for a line
   * break within a paragraph, and `<strong>`, `<em>`, `<s>` and `<a href="...">` for bold,
   * italic, strikethrough and links; Markdown syntax is plain text there. Everything else in the
   * table must stay as it is, down to the line breaks and indentation `getContent()` writes
   * between cells. A replacement cannot add or remove paragraphs, list items, cells, rows or
   * columns (use the table methods for rows and columns), change a table together with the text
   * around it, or change a cell that a merged cell covers, a cell that holds another table, a
   * subtitle, or a paragraph that holds an image, smart chip or other element. It can add
   * paragraphs directly above or below a table, with a blank line between them and the table,
   * unless the paragraph on that side of the table is read-only. That blank line has to stay: to
   * remove the paragraph next to a table, remove the blank line on the paragraph's other side
   * with it.
   *
   * Each parameter holds at most 2,000 lines. A table has a line for every cell and two more for
   * every row, so quote only the rows a replacement needs and change a large table in several
   * calls.
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

  /**
   * Every comment on the Doc, attached to text or not, with its replies, and this binding's
   * comments, replies and resolves still waiting for approval (`pending`). A suggestion is not a
   * comment, and is not listed. Fails for an account that can only view the Doc: Google shows a
   * Doc's comments only to accounts that can comment on it.
   */
  listComments(): Promise<DriveComment[]>;

  /** Queue a plain-text comment attached to the text `options.quote`. */
  comment(text: string, options: DocCommentOptions): Promise<DriveComment>;

  /**
   * Queue a suggestion that `oldText`, which must occur exactly once in the tab (matched and
   * limited as `quote` is), be replaced with `newText`: empty to delete it, otherwise at most 1000
   * characters without line breaks. At approval `oldText` must still occur exactly once in the tab.
   */
  suggestEdit(
    oldText: string, newText: string, options?: DocSuggestEditOptions,
  ): Promise<DocSuggestion>;

  /**
   * Queue a reply to comment `commentId`, an ID `listComments()` returned. Replying to a resolved
   * comment reopens it. Fails for a comment attached to no text, saying which Drive connection can
   * answer it; for one that is itself still `pending`, which takes replies once it is posted; and
   * for one with a resolve awaiting approval, which the reply would reopen (to close a comment with
   * words, resolve it with them). At approval the reply fails if the comment was edited after the
   * reply was queued.
   */
  reply(commentId: string, text: string): Promise<DriveCommentReply>;

  /**
   * Queue resolving comment `commentId`, with an optional closing reply. Fails for a comment that
   * is already resolved, that already has a resolve awaiting approval, that is itself still
   * `pending`, or that is attached to no text. At approval the resolve fails if the comment was
   * edited after the resolve was queued.
   */
  resolve(commentId: string, text?: string): Promise<DriveCommentReply>;

  /**
   * Add a table to tab `tabId`: after the text `table.after` names, or at the end of the tab.
   * The same tab selection rules as `replaceText()` apply. Returns the new table's position
   * among the tab's tables, to name it in later calls. The table then reads as `getContent()`
   * lays tables out, each paragraph of a cell's text as a `<p>` element.
   *
   * A new table holds at most 1,000 cells that have text, an empty cell counting as half of
   * one; add further rows with `insertTableRows()`. A new table may read the same as another
   * table of the tab; give one of the two text of its own before changing the rows or columns
   * of either, or deleting either.
   *
   * Google Docs keeps a paragraph on each side of a table, so an empty paragraph is added with
   * it: after the new table, or between the two when it follows another table. A table cannot be
   * added between two items of one list (name the list's last item instead), after a paragraph
   * that holds nothing but a positioned image, or after a table whose next paragraph holds one.
   */
  insertTable(table: NewDocTable, tabId?: string): Promise<number>;

  /**
   * Add rows to a table in tab `tabId`, with their text when `rows.cells` gives it. To add a
   * row at the end of a table, leave `rows.at` out. New cells hold plain paragraphs. They take
   * the look (cell shading, alignment, font, size and colour) of the cells of the row they go
   * before, or of the last row when they are added at the end, and never
   * their bold, italic, strikethrough, links, list items or headings; a new cell holds default
   * text where that row's cell in its column starts with a heading or a list item.
   *
   * One call adds at most 1,000 cells that have text, an empty cell counting as half of one.
   * The rows of a table with merged cells cannot be changed, nor those of a table that holds
   * suggested changes to its rows, columns or cells. Where a cell of the row the new rows go
   * before (or of the last row, for rows added at the end) holds one dropdown, person chip, date
   * chip, rich link or placeholder and no text, Google Docs copies it into the new rows: a
   * dropdown with its first choice, U+E907 for the others. Their cells in that column then take
   * no text. Rows cannot be added beside a cell of chips and no text in another shape, such as
   * a chip after a space: add those rows in Google Docs.
   */
  insertTableRows(rows: DocTableInsertion, tabId?: string): Promise<void>;

  /**
   * Add columns to a table in tab `tabId`: one, or `columns.count` of them, with their text
   * when `columns.cells` gives it. `cells` goes row by row, so `[["Owner"], ["Ana"], ["Ben"]]`
   * fills one new column of a table of three rows. To add a column at the end of a table, leave
   * `columns.at` out. New cells hold plain paragraphs and take the look of the cells of the
   * column they go before, or of the last column when they are added at the end, as for
   * `insertTableRows()`.
   *
   * Columns can be added until the table has 20, and only to a table of at most 500 rows.
   * One call adds at most 1,000 cells that have text, an empty cell counting as half of one.
   * The columns of a table with merged cells cannot be changed, nor those of a table that holds
   * suggested changes to its rows, columns or cells.
   */
  insertTableColumns(columns: DocTableInsertion, tabId?: string): Promise<void>;

  /**
   * Delete rows of a table in tab `tabId`, with everything in them. To delete every row, delete
   * the table. The rows of a table with merged cells cannot be changed, nor those of a table
   * that holds suggested changes to its rows, columns or cells. Rows that hold a footnote
   * cannot be deleted, nor can rows that hold items of a numbered list while a numbered list
   * follows them in the tab.
   */
  deleteTableRows(rows: DocTableDeletion, tabId?: string): Promise<void>;

  /**
   * Delete columns of a table in tab `tabId`, with everything in them. To delete every column,
   * delete the table. The columns of a table with merged cells cannot be changed, nor those of
   * a table that holds suggested changes to its rows, columns or cells. Columns that hold a
   * footnote cannot be deleted, nor can columns that hold items of a numbered list while a
   * numbered list follows them in the tab.
   */
  deleteTableColumns(columns: DocTableDeletion, tabId?: string): Promise<void>;

  /**
   * Delete a table of tab `tabId`, with everything in it, leaving the paragraphs around it.
   * `table` is its position among the tab's tables, counting from 0. A table cannot be deleted
   * while it sits between two items of one list or holds a footnote, or while it holds items of
   * a numbered list and a numbered list follows it in the tab.
   */
  deleteTable(table: number, tabId?: string): Promise<void>;
}
