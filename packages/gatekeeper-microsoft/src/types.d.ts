// TypeScript API exposed to Gadgets by the Microsoft 365 gatekeeper's SharePoint resource.
//
// One resource covers SharePoint and OneDrive for Business. When it was connected, the user chose
// how much of it this connection covers: everything they can open, or one site, document library,
// folder, file, list, or page. Every connection has the same API; `getScope()` says what it covers,
// and a method that reaches outside that scope is refused. Start with `getScope()`.
//
// Changes (creating, uploading, replacing, renaming, moving, deleting, editing list items) are
// proposed for the user's approval and simulated meanwhile: reads show them right away, marked
// `pending`, and a new file or item has a temporary ID ("~N") until it is approved. A deployment
// may allow read-only access, in which case the connection is a `SharePointReader` with no write
// methods.
//
// IDs are opaque strings: pass back exactly what a read returned. A file or folder ID only works
// for files and folders, a list ID for lists, and so on.

/**
 * Forward-only paginated results. This is an RPC object: call `next()` repeatedly on the same
 * cursor until it returns `null`. A page may be empty before the end, so stop on `null`, not on an
 * empty page. Dispose the cursor when finished, including when stopping early.
 */
export interface Cursor<T> {
  next(): Promise<T[] | null>;
}

/** The kinds of thing a connection can cover. */
export type SharePointScopeKind = "all" | "site" | "library" | "folder" | "file" | "list" | "page";

/** What this connection covers. */
export type SharePointScopeInfo = {
  kind: SharePointScopeKind;
  /** The covered object's name: "SharePoint & OneDrive" for `all`, else the site, library, ... name. */
  name: string;
  webUrl: string;
  /** One sentence describing what is covered, e.g. "The Specs folder in Engineering › Documents, and everything in it." */
  description: string;
  /** Where to start: the IDs of the covered object and of what contains it. */
  siteId?: string;
  libraryId?: string;
  folderId?: string;
  fileId?: string;
  listId?: string;
  pageId?: string;
  /** Which parts of the API this scope can use. */
  can: {
    /** `listSites` and `getSite`. */
    sites: boolean;
    files: boolean;
    lists: boolean;
    pages: boolean;
    /** Whether changes can be proposed. False on a read-only deployment, and for a page, which has no write methods. */
    write: boolean;
  };
};

/** A SharePoint site, or a OneDrive (a personal site). */
export type SiteInfo = {
  id: string;
  name: string;
  webUrl: string;
  description?: string;
  /** A OneDrive rather than a team or communication site. */
  personal: boolean;
  modifiedAt?: string;
};

/** A document library, or a OneDrive's files. */
export type LibraryInfo = {
  id: string;
  name: string;
  webUrl: string;
  siteId: string;
  description?: string;
  /** The library's top folder, for `list({ folderId })`. */
  rootFolderId: string;
  modifiedAt?: string;
};

/** A SharePoint list (not a document library). */
export type ListInfo = {
  id: string;
  name: string;
  webUrl: string;
  siteId: string;
  description?: string;
  /** SharePoint's list template, e.g. "genericList", "events", "tasks". */
  template?: string;
  modifiedAt?: string;
};

/** What a site holds. */
export type SiteContents = SiteInfo & {
  libraries: LibraryInfo[];
  lists: ListInfo[];
  /** Whether the site has modern pages; read them with `listPages`. */
  hasPages: boolean;
  /** Subsites. A site connection covers only the site itself, not its subsites. */
  subsites: SiteInfo[];
};

/** A change awaiting the user's approval that a read is already showing. */
export type PendingChange = "create" | "replace" | "rename" | "move" | "delete" | "update";

/** A file or folder. */
export type DriveEntry = {
  id: string;
  name: string;
  kind: "file" | "folder";
  webUrl: string;
  /**
   * Where it is, as folder names joined by "/", relative to the top of what this connection covers
   * (its library, or its folder). "" for that top folder itself.
   */
  path: string;
  /** The containing folder's ID. Absent at the top of what this connection covers. */
  parentId?: string;
  libraryId: string;
  siteId?: string;
  /** Bytes. */
  size?: number;
  mimeType?: string;
  /** For a folder: how many items it holds. */
  childCount?: number;
  createdAt?: string;
  modifiedAt?: string;
  createdBy?: string;
  modifiedBy?: string;
  /**
   * The version this read saw. Pass it to a write's `ifUnchanged` to have the change refused if
   * anyone edits the file in between.
   */
  eTag?: string;
  /** Set when a change awaiting approval is shown here; the provider does not have it yet. */
  pending?: PendingChange;
};

/** Options for `list`. */
export type ListOptions = {
  /** The folder to list. Defaults to the top of what this connection covers. */
  folderId?: string;
  /** Sort order. Defaults to "name": folders first, then files, alphabetically. */
  orderBy?: "name" | "modified" | "size";
  /** Results per page, 1–200. Defaults to 50. */
  pageSize?: number;
};

/** Options for `search`. */
export type SearchOptions = {
  /** Only results inside this folder. Defaults to everything this connection covers. */
  folderId?: string;
  /** Only files, or only folders. */
  kind?: "file" | "folder";
  /** Results per page, 1–50. Defaults to 25. */
  pageSize?: number;
};

/** A file's content as text. */
export type FileContent = {
  entry: DriveEntry;
  /**
   * "markdown" for Word, PowerPoint, Excel, PDF and HTML files converted to Markdown; "text" for
   * plain-text files; "none" when the file cannot be read as text (`note` says why).
   */
  format: "markdown" | "text" | "none";
  content: string;
  /** The content was cut at `maxChars`. */
  truncated: boolean;
  /** Anything lost in conversion, or why there is no content. */
  note?: string;
};

/** Options for `readFile`. */
export type ReadFileOptions = {
  /** The most characters to return, 1,000–500,000. Defaults to 100,000. */
  maxChars?: number;
};

/** A cell value as Excel computed it. Dates are serial numbers unless the cell is formatted as text. */
export type CellValue = string | number | boolean | null;

/** One worksheet's used range. */
export type WorksheetContent = {
  name: string;
  /** The range read, e.g. "Sheet1!A1:D20". */
  address: string;
  /** Computed values, row by row. */
  values: CellValue[][];
  /** Formulas where a cell has one ("=SUM(B2:B3)"), else the same value as `values`. */
  formulas: CellValue[][];
  /** The used range was larger than `maxCells`, and only its top-left part is here. */
  truncated: boolean;
};

/** An Excel workbook's worksheets. */
export type WorkbookContent = {
  entry: DriveEntry;
  worksheets: WorksheetContent[];
  /** Names of worksheets not read, because `sheet` named another or they are hidden. */
  otherWorksheets: string[];
};

/** Options for `readWorkbook`. */
export type ReadWorkbookOptions = {
  /** Read only this worksheet. Defaults to every visible worksheet. */
  sheet?: string;
  /** Read only this range of `sheet`, e.g. "A1:D20" or "B2". Needs `sheet`; `maxCells` still caps it. */
  range?: string;
  /** The most cells to read per worksheet, up to 100,000. Defaults to 10,000. */
  maxCells?: number;
};

/** One saved version of a file. */
export type FileVersion = {
  id: string;
  modifiedAt?: string;
  modifiedBy?: string;
  size?: number;
};

/** A modern site page. */
export type PageInfo = {
  id: string;
  title: string;
  /** The page's file name, e.g. "Launch-Plan.aspx". */
  name: string;
  webUrl: string;
  siteId: string;
  description?: string;
  modifiedAt?: string;
  modifiedBy?: string;
  /** False for a draft or a page checked out for editing. */
  published: boolean;
};

/** A page's content. */
export type PageContent = {
  page: PageInfo;
  /** The page's text web parts as Markdown, in reading order. */
  markdown: string;
  /** What could not be read: web parts other than text (images, news, lists) are only named. */
  note?: string;
};

/** What a link turned out to be, with the ID to pass to the matching method. */
export type ResolvedLink = {
  kind: SharePointScopeKind;
  /**
   * A site ID for `getSite`, a folder or file ID for `list` and `getEntry` (a library's is its root
   * folder's, as `LibraryInfo.rootFolderId`), a list ID for `openList`, or a page ID for `readPage`;
   * absent for `all`.
   */
  id?: string;
  name: string;
  webUrl: string;
};

// -- lists --------------------------------------------------------------------------------------

/** The type of a list column. */
export type ColumnType =
  | "text" | "note" | "number" | "currency" | "boolean" | "dateTime" | "choice" | "multiChoice"
  | "person" | "lookup" | "hyperlink" | "calculated" | "other";

/** One column of a list. */
export type ColumnInfo = {
  /** The internal name: what `fields` are keyed by and what filters name. */
  name: string;
  /** The name SharePoint shows. */
  displayName: string;
  type: ColumnType;
  description?: string;
  required: boolean;
  /** Computed by SharePoint (calculated, lookup) or otherwise not writable. */
  readOnly: boolean;
  /**
   * Whether filtering or sorting on it stays fast. On a list over 5,000 items SharePoint refuses to
   * filter or sort on a column that is not indexed.
   */
  indexed: boolean;
  /** For "choice" and "multiChoice": the allowed values. */
  choices?: string[];
};

/**
 * A column value. Text, note, choice: string. Number, currency: number. Boolean: boolean.
 * dateTime: ISO 8601 string. multiChoice: string[]. Person and lookup columns read as display
 * text and cannot be written.
 */
export type FieldValue = string | number | boolean | null | string[];

/** A list item. */
export type ListItem = {
  id: string;
  /** Column values keyed by internal name. */
  fields: Record<string, FieldValue>;
  webUrl?: string;
  createdAt?: string;
  modifiedAt?: string;
  createdBy?: string;
  modifiedBy?: string;
  /** Pass to `updateItem`'s `ifUnchanged` to refuse the change if anyone edits the item in between. */
  eTag?: string;
  pending?: PendingChange;
};

/** One condition on a column. Text comparisons are case-insensitive. */
export type FieldFilter = {
  /** A column's internal name. */
  field: string;
  op: "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "startsWith";
  value: string | number | boolean | null;
};

/** Options for `queryItems`. */
export type ItemQuery = {
  /** Conditions that must all hold. */
  where?: FieldFilter[];
  orderBy?: { field: string; descending?: boolean };
  /** Only these columns, by internal name. Defaults to every column. */
  fields?: string[];
  /** Results per page, 1–200. Defaults to 50. */
  pageSize?: number;
};

/** Read access to one list. */
export interface SharePointListReader {
  getInfo(): Promise<ListInfo>;
  /** The list's columns, including hidden-but-useful ones like "Title"; SharePoint's bookkeeping columns are left out. */
  getColumns(): Promise<ColumnInfo[]>;
  queryItems(query?: ItemQuery): Promise<Cursor<ListItem>>;
  getItem(itemId: string): Promise<ListItem>;
}

/** Read and write access to one list. Changes need the user's approval. */
export interface SharePointList extends SharePointListReader {
  /** Proposes a new item. Returns it as it will be, with a temporary ID until approved. */
  createItem(fields: Record<string, FieldValue>): Promise<ListItem>;
  /** Proposes changing some of an item's column values; columns not named are left alone. */
  updateItem(itemId: string, fields: Record<string, FieldValue>, options?: { ifUnchanged?: string }): Promise<ListItem>;
  /** Proposes deleting an item, to the site's recycle bin. */
  deleteItem(itemId: string, options?: { ifUnchanged?: string }): Promise<void>;
}

// -- the session --------------------------------------------------------------------------------
//
// A connection is typed by what its scope can reach: `SharePointReader` / `SharePointSession` for
// all of SharePoint & OneDrive or a site, `SharePointFolderReader` / `SharePointFolderSession` for
// a library or folder, `SharePointFileReader` / `SharePointFileSession` for one file,
// `SharePointListScopeReader` / `SharePointListScopeSession` for one list, and
// `SharePointPageReader` for one page. A read-only connection has the Reader type.

/** What every connection answers: its scope, and where a link leads. */
export interface SharePointScopeReader {
  /** What this connection covers, and where to start. */
  getScope(): Promise<SharePointScopeInfo>;
  /** What a SharePoint or OneDrive link points to, if this connection covers it. */
  resolveUrl(url: string): Promise<ResolvedLink>;
}

/** Reads of files, in every connection that reaches them. */
export interface SharePointFileReads {
  /** One file or folder. */
  getEntry(id: string): Promise<DriveEntry>;
  /** A file's content as text. Word, PowerPoint, Excel, PDF and HTML are converted to Markdown. */
  readFile(id: string, options?: ReadFileOptions): Promise<FileContent>;
  /** A file's bytes, up to 25 MB. */
  readBytes(id: string): Promise<Uint8Array>;
  /** An Excel workbook's cell values and formulas, as Excel computes them. */
  readWorkbook(id: string, options?: ReadWorkbookOptions): Promise<WorkbookContent>;
  /** A PowerPoint deck (.pptx), slide by slide: layouts, placeholders, notes and images. */
  readPresentation(id: string): Promise<PresentationContent>;
  /** A file's saved versions, newest first. */
  listVersions(id: string): Promise<FileVersion[]>;
}

/** Reads of folders and what they hold. */
export interface SharePointFolderReads extends SharePointFileReads {
  /** A folder's files and folders. */
  list(options?: ListOptions): Promise<Cursor<DriveEntry>>;
  /**
   * Files and folders whose name or content matches `query`: words, or a phrase in quotes, every
   * one of which must match. Not a query language: operators and `property:` filters are searched
   * for as words. Search is SharePoint's own, so a new or just-changed file can take a few minutes
   * to appear.
   */
  search(query: string, options?: SearchOptions): Promise<Cursor<DriveEntry>>;
}

/** Reads of sites, and of their lists and pages. */
export interface SharePointSiteReads {
  /**
   * Sites you can open: your own OneDrive first (`personal: true`), then with no query the sites
   * you follow, with one the sites whose name matches. A site connection lists just its site.
   */
  listSites(options?: { query?: string }): Promise<Cursor<SiteInfo>>;
  /** A site's libraries, lists and subsites. Defaults to the connection's own site. */
  getSite(siteId?: string): Promise<SiteContents>;
  /** A list. Defaults to the connection's own list. */
  openList(listId?: string): Promise<SharePointListReader>;
  /** A site's pages. Defaults to the connection's own site. */
  listPages(siteId?: string): Promise<Cursor<PageInfo>>;
  /** A page's content. Defaults to the connection's own page. */
  readPage(pageId?: string): Promise<PageContent>;
}

/** Read access to one file. */
export interface SharePointFileReader extends SharePointScopeReader, SharePointFileReads {}

/** Read access to a library or folder. */
export interface SharePointFolderReader extends SharePointScopeReader, SharePointFolderReads {}

/** Read access to one list. */
export interface SharePointListScopeReader extends SharePointScopeReader {
  /** The connection's list. */
  openList(): Promise<SharePointListReader>;
}

/** Read access to one page. */
export interface SharePointPageReader extends SharePointScopeReader {
  /** The connection's page, as a listing of one. */
  listPages(): Promise<Cursor<PageInfo>>;
  /** The page's content. */
  readPage(): Promise<PageContent>;
}

/** Read access to all of SharePoint & OneDrive, or to a site. */
export interface SharePointReader extends SharePointScopeReader, SharePointFolderReads, SharePointSiteReads {}

/** Options for a change to an existing file or folder. */
export type ChangeOptions = {
  /** The `eTag` from the read the change is based on: the change is refused if it has changed since. */
  ifUnchanged?: string;
};

/**
 * Rows for a new Excel workbook: one worksheet's rows, or named worksheets. The first row is the
 * header (bold, frozen, filterable). A string starting with "=" is a formula, e.g. "=SUM(B2:B9)";
 * formulas that reach outside the workbook (WEBSERVICE, HYPERLINK, RTD, external references) are
 * refused.
 */
export type WorkbookRows = CellValue[][] | { name: string; rows: CellValue[][] }[];

/** Options for writing a Word document or PowerPoint deck from Markdown. */
export type WriteOptions = {
  /**
   * An existing Word or PowerPoint file (a .dotx/.potx template, or any document) whose look to use:
   * its styles, theme, fonts, page setup, headers and footers, or its slide masters and layouts.
   * Pass your organization's template so a new file matches its others.
   */
  template?: string;
};

/**
 * One change to a Word document, made in place: everything else in it (formatting, images,
 * comments, headers, other paragraphs) stays exactly as it is.
 *
 * - `{ find, replace }`: replaces text, which keeps the formatting of the text it replaces. `find`
 *   must occur once in the document unless `all` is set; quote more of the sentence if it occurs
 *   more often.
 * - `{ insertAfter | insertBefore, markdown }`: adds paragraphs, headings, lists or tables, in the
 *   document's own styles, next to the one paragraph containing the given text.
 * - `{ deleteParagraph }`: removes the one paragraph containing the given text.
 */
export type DocumentEdit =
  | { find: string; replace: string; all?: boolean }
  | { insertAfter: string; markdown: string }
  | { insertBefore: string; markdown: string }
  | { deleteParagraph: string };

/** Options for `editDocument`. */
export type EditDocumentOptions = ChangeOptions & {
  /**
   * Record the edits as tracked changes, which the document's owner reviews and accepts in Word
   * like a colleague's. Defaults to true.
   */
  trackChanges?: boolean;
};

/**
 * One change to a PowerPoint deck, made in place: everything else in it (masters, layouts, other
 * slides, animations, charts) stays exactly as it is. Edits apply in order, and each edit's slide
 * numbers (1-based) refer to the deck as the edits before it left it. Read the deck first with
 * `readPresentation` to see its slides, layouts and placeholder names.
 *
 * - `{ find, replace }`: replaces text on slides and in speaker notes, keeping its formatting; once
 *   unless `all` is set.
 * - `{ setText: { slide, placeholder, markdown } }`: rewrites one placeholder ("title", "body",
 *   "body 2"…, as `readPresentation` names them), keeping its formatting; bullets become levels.
 * - `{ addSlides, after }`: adds slides written in Markdown (see `uploadFile`) after slide `after`,
 *   or at the end, in the deck's own layouts.
 * - `{ duplicateSlide, after }`: copies a slide, with its notes and charts, after slide `after`
 *   (default: right after itself). The usual way to add a slide that looks like an existing one.
 * - `{ moveSlide, to }`: moves a slide to position `to`.
 * - `{ deleteSlide }`: removes a slide.
 * - `{ setNotes: { slide, markdown } }`: replaces a slide's speaker notes.
 */
export type PresentationEdit =
  | { find: string; replace: string; all?: boolean }
  | { setText: { slide: number; placeholder: string; markdown: string } }
  | { addSlides: string; after?: number }
  | { duplicateSlide: number; after?: number }
  | { moveSlide: number; to: number }
  | { deleteSlide: number }
  | { setNotes: { slide: number; markdown: string } };

/** One slide of a deck, as `readPresentation` describes it. */
export type SlideInfo = {
  number: number;
  /** The slide's layout, by the deck's own name for it ("Title and Content"). */
  layout: string;
  hidden?: boolean;
  /** Its placeholders, by the names `setText` takes. */
  placeholders: { name: string; type: "title" | "subtitle" | "body" | "other"; markdown: string }[];
  /** Text in other shapes and tables, as Markdown. */
  otherText: string[];
  images: { name: string; description?: string }[];
  notes?: string;
};

/** A PowerPoint deck's structure: what `editPresentation` works with. */
export type PresentationContent = {
  entry: DriveEntry;
  slides: SlideInfo[];
  /** The layouts a new slide can use (`<!-- layout: Name -->`). */
  layouts: string[];
};

/** Changes to a file's content, each proposed for the user's approval. */
export interface SharePointFileWrites {
  /**
   * Proposes replacing a file's whole content, written as `uploadFile` writes it. SharePoint keeps
   * the current content as an earlier version. Rewriting a Word, PowerPoint or Excel file from
   * Markdown or rows loses what they can't express (images, comments, formatting, other sheets), and
   * the approver is told what; to change part of one, use `editDocument`, `editPresentation` or
   * `updateCells`, which keep everything else.
   */
  replaceFile(id: string, content: string | Uint8Array | WorkbookRows, options?: ChangeOptions & WriteOptions): Promise<DriveEntry>;
  /** Proposes changes to a Word document (.docx), in place, as tracked changes by default. */
  editDocument(id: string, edits: DocumentEdit[], options?: EditDocumentOptions): Promise<DriveEntry>;
  /** Proposes changes to a PowerPoint deck (.pptx), in place. */
  editPresentation(id: string, edits: PresentationEdit[], options?: ChangeOptions): Promise<DriveEntry>;
  /**
   * Proposes setting a range of cells in an Excel workbook (.xlsx), as Excel itself does: every
   * other cell, formula, format, chart and sheet stays as it is. `address` is a range on the
   * worksheet, e.g. "B2:D4" or "A10"; `values` has one row per row of the range, one value per
   * column. A string starting with "=" is a formula; null clears a cell. Read the workbook first
   * (`readWorkbook`) to find where to write.
   */
  updateCells(id: string, worksheet: string, address: string, values: CellValue[][], options?: ChangeOptions): Promise<DriveEntry>;
}

/** Changes to folders and what they hold, each proposed for the user's approval. */
export interface SharePointFolderWrites extends SharePointFileWrites {
  /** Proposes a new folder. */
  createFolder(parentId: string, name: string): Promise<DriveEntry>;
  /**
   * Proposes a new file, up to 25 MB, written in the format its name says:
   *
   * - `.docx` from a Markdown string: a Word document in Word's own styles (headings, lists, tables,
   *   links, quotes, code), so it reads, prints and co-authors like any other.
   * - `.pptx` from a Markdown string: a 16:9 deck. Each `#` heading (or `---`) starts a slide; a
   *   first slide with only a line or two under its heading is the title slide, and a heading
   *   alone is a section header. Lists become bullets and tables become tables. A blockquote
   *   starting "Notes:" becomes the slide's speaker notes. A line `<!-- layout: Two Content -->`
   *   at the top of a slide picks a layout by name (with a `template`, its layouts: see
   *   `readPresentation`); a line `+++` splits a slide into columns. `![description](fileId)` on
   *   a line of its own places a PNG, JPEG or GIF file this connection covers. Text too long for a
   *   slide shrinks to fit, then continues on the next.
   * - `.xlsx` from `WorkbookRows`, or from a CSV string.
   * - Any other text format (.md, .txt, .csv, .json, .html…) from a string, as UTF-8.
   * - Anything from a `Uint8Array` of the file's own bytes.
   *
   * Refused if the folder already has an item with that name; use `replaceFile` or the edit
   * methods to change an existing file.
   */
  uploadFile(parentId: string, name: string, content: string | Uint8Array | WorkbookRows, options?: WriteOptions): Promise<DriveEntry>;
  /**
   * Proposes copying a file into a folder (in any library this connection covers), keeping
   * everything about it. The copy reads as its source while it waits, and can be edited once it is
   * approved. To write a new document in a template's look, pass `template` to `uploadFile` instead.
   */
  copyFile(id: string, folderId: string, name?: string): Promise<DriveEntry>;
  /** Proposes renaming a file or folder. */
  rename(id: string, name: string, options?: ChangeOptions): Promise<DriveEntry>;
  /** Proposes moving a file or folder into another folder in the same library. */
  move(id: string, folderId: string, options?: ChangeOptions): Promise<DriveEntry>;
  /** Proposes deleting a file or folder, to the site's recycle bin. */
  delete(id: string, options?: ChangeOptions): Promise<void>;
}

/** Read and write access to one file. Its content can change; it can't be renamed, moved or deleted. */
export interface SharePointFileSession extends SharePointFileReader, SharePointFileWrites {}

/** Read and write access to a library or folder. */
export interface SharePointFolderSession extends SharePointFolderReader, SharePointFolderWrites {}

/** Read and write access to one list. */
export interface SharePointListScopeSession extends SharePointListScopeReader {
  openList(): Promise<SharePointList>;
}

/** Read and write access to all of SharePoint & OneDrive, or to a site. */
export interface SharePointSession extends SharePointReader, SharePointFolderWrites {
  openList(listId?: string): Promise<SharePointList>;
}
