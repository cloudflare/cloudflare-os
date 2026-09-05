/** Metadata for one native Google Doc. */
export type DocMetadata = {
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
   * Return one tab's content as Markdown.
   *
   * This reads exactly one tab and never combines tabs, so pass an ID returned by `listTabs()`.
   * Omitting `tabId` is valid only when `listTabs()` returns exactly one tab.
   */
  getContent(tabId?: string): Promise<string>;
}
