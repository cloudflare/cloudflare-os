/**
 * Reads of a Google Doc session that its own declarations leave out: what it takes to render a
 * tab as Google Docs draws it, with its pending changes on it. The session has these methods as
 * it has the others.
 */
export interface GoogleDocRenderingReads {
  /**
   * Tab `tabId` as Google Docs has it saved and lays it out: its page, sections, headers and
   * footers, and every paragraph, table and object with its style in full. It says nothing of
   * pending changes: `readPendingDrawing()` returns what they put in place of which blocks of
   * the body here. The whole document is read from Google Docs for it, so read it again only
   * once `readPendingDrawing()` names another `version`. To read or edit the tab's text call
   * `getContent()`, whose answer is far smaller.
   */
  readDrawing(tabId: string): Promise<GoogleDocDrawing>;

  /**
   * What the pending changes of tab `tabId` put in place of parts of its saved body, as blocks
   * like the drawing's. It reads nothing from Google Docs that `getContent()` would not, so it
   * can be read as often as the changes are watched.
   */
  readPendingDrawing(tabId: string): Promise<GoogleDocPendingDrawing>;

  /**
   * Read one object the drawing of tab `tabId` names, by its ID in `objects`. Throws if the
   * object is not readable or is larger than 10 MB.
   */
  readImage(imageId: string, tabId: string): Promise<GoogleDocImageBytes>;

  /**
   * Read the file of one font of `family`, a `fontFamily` the tab's drawing returned, from Google
   * Fonts: `weight` from 100 to 900, upright or `italic`. Throws when Google Fonts has no such font.
   */
  readFont(family: string, weight: number, italic: boolean): Promise<ReadableStream<Uint8Array>>;
}

/** One tab as Google Docs draws it. Lengths are in points and colors are `#rrggbb`. */
export type GoogleDocDrawing = {
  /**
   * Google Docs' name for the saved document this was read from. `readPendingDrawing()` names
   * the one its edits are ranges of: where both name one and the two differ, read the drawing
   * again. Google Docs names none for an account that can only view the document, and a tab
   * that is itself pending has none: nothing then tells that a drawing has gone stale.
   */
  version?: string;

  /** Set for a pageless document: one sheet as long as its content, with no header or footer. */
  pageless?: true;

  /** The sheet of paper, before a section turns it on its side. */
  page: { width: number; height: number; background?: string };

  /** Set when even pages take a section's `even` header and footer. */
  evenPages?: true;

  /** The tab's sections in order. The body starts in the first. */
  sections: GoogleDocSection[];

  /** The body, in order. */
  blocks: GoogleDocBlock[];

  /** What the top of a page repeats, by the ID a section names. */
  headers: Record<string, GoogleDocBlock[]>;

  /** What the foot of a page repeats, by the ID a section names. */
  footers: Record<string, GoogleDocBlock[]>;

  /** Each footnote's text, by the ID its reference names. */
  footnotes: Record<string, GoogleDocBlock[]>;

  /** Each list's levels, outermost first, by the ID a paragraph's `list` names. */
  lists: Record<string, GoogleDocListLevel[]>;

  /** Every image, drawing and chart, by the ID a run or a paragraph names. */
  objects: Record<string, GoogleDocObject>;

  /** How paragraphs are set, each named by its place here. */
  paragraphLooks: GoogleDocParagraphLook[];

  /** How text is set, each named by its place here. */
  textLooks: GoogleDocTextLook[];

  /**
   * What a new paragraph of each named style would be set in, as places in `paragraphLooks` and
   * `textLooks`: `NORMAL_TEXT`, `TITLE`, `SUBTITLE` and `HEADING_1` to `HEADING_6`. Empty for a
   * tab or a document that is still to be made: Google Docs gives each its own when it makes it.
   */
  named: Record<string, { paragraph: number; text: number }>;
}

/** A stretch of the body that shares one page setup. */
export type GoogleDocSection = {
  /** Set when the section starts on a new page rather than where the one before it ends. */
  newPage?: true;

  /** Set when the section's pages are the sheet turned on its side. */
  landscape?: true;

  /**
   * The space kept clear at each edge of the page. `header` is from the top of the page to the
   * header, and `footer` from the foot of the footer to the foot of the page; the body starts
   * below `top` or below the header, whichever is lower. `footer` is below zero in a document
   * that sets neither, whose footer Google Docs draws reaching just past the foot of the page.
   */
  margins: { top: number; right: number; bottom: number; left: number; header: number; footer: number };

  /** The space kept under a header that reaches below `margins.top`, before the body starts. */
  headerGap?: number;

  /** The columns the body is set in, when more than one: each one's width and the gap after it. */
  columns?: { width: number; gap: number }[];

  /** Set when a line is drawn between columns. */
  columnRule?: true;

  /** Set when the columns are filled from the right, whichever way the text in them reads. */
  rightToLeft?: true;

  /**
   * The IDs, in `headers` and `footers`, of what the section's pages repeat. Google leaves out a
   * header or footer made only to carry an image: those are returned under the ID `unreturned`,
   * each an empty paragraph the image is tethered to, set as the header or footer nearest it is.
   */
  header?: string;
  footer?: string;

  /** What the section's first page takes instead, when `firstPage` is set. */
  firstHeader?: string;
  firstFooter?: string;
  firstPage?: true;

  /** What the section's even pages take instead, when the drawing's `evenPages` is set. */
  evenHeader?: string;
  evenFooter?: string;

  /** The number of the section's first page, where it does not go on from the page before. */
  pageNumberStart?: number;
}

/** One block of a body, a header, a footer, a footnote or a table cell. */
export type GoogleDocBlock =
  | GoogleDocParagraph
  | GoogleDocTable
  | {
      /** A table of contents: the paragraphs Google Docs last made for it. */
      type: "contents";
      range?: GoogleDocRange;
      blocks: GoogleDocBlock[];
    }
  | {
      /** Where the section at this place in `sections` starts. */
      type: "section";
      range?: GoogleDocRange;
      section: number;
    };

/**
 * Where a block stands in the saved tab, as document indexes from `start` up to `end`: set for
 * the body's own blocks, and for none in a table, a header, a footer, a footnote or a pending
 * edit. The body's blocks are in order and their ranges do not overlap.
 */
export type GoogleDocRange = { start: number; end: number };

export type GoogleDocParagraph = {
  type: "paragraph";

  range?: GoogleDocRange;

  /** The named style the paragraph has, such as `NORMAL_TEXT` or `HEADING_2`. */
  style: string;

  /** What a link to this heading names it by: `#heading=<headingId>`. */
  headingId?: string;

  /** The paragraph's place in `paragraphLooks`. */
  look: number;

  /** The place in `textLooks` of what the paragraph ends in, which sets the height of an empty one. */
  end: number;

  /** Set for a list item: its list, its level counting from zero, and what its marker is set in. */
  list?: { id: string; level: number; look: number };

  /** What the paragraph holds, in order. */
  runs: GoogleDocRun[];

  /** The objects tethered to the paragraph, which are placed against it rather than in its text. */
  objects?: string[];
}

/** One stretch of a paragraph, set in the text look at `look`. */
export type GoogleDocRun = { look: number } & ({
  /** Text. `\u000b` in it is a line break. */
  text: string;

  /**
   * Where the text leads: an address, or a place in the document as `?tab=<tabId>`,
   * `#heading=<headingId>` or `#bookmark=<bookmarkId>`, either after a `?tab=`.
   */
  link?: string;
} | {
  /** An object set in the line as a letter is, by its ID in `objects`. */
  object: string;
} | {
  /** What follows starts a new page or a new column. */
  break: "page" | "column";
} | {
  /** A line across the page. */
  rule: true;
} | {
  /** The number of the page this is on, or the number of pages there are. */
  field: "pageNumber" | "pageCount";
} | {
  /** A footnote's mark, by the ID of its text in `footnotes`. */
  footnote: string;
  mark: string;
} | {
  /** A person, a date, a dropdown's choice or a link to a file, drawn as a chip with this text. */
  chip: string;
  link?: string;
} | {
  equation: true;
});

/** How a paragraph is set. A length left out is zero. */
export type GoogleDocParagraphLook = {
  alignment?: "center" | "end" | "justify";

  /** Set for a paragraph that starts at the right. */
  rightToLeft?: true;

  /** Line height as a multiple of single spacing. */
  lineSpacing: number;
  spaceAbove?: number;
  spaceBelow?: number;

  /** From the column's edge to the text, on the side the paragraph starts and on the other. */
  indentStart?: number;
  indentEnd?: number;

  /** From the column's edge to the first line, or to a list item's marker. */
  indentFirstLine?: number;

  /** The color behind the whole paragraph. */
  shading?: string;

  /** Lines at the paragraph's edges; `between` is drawn between it and one bordered alike. */
  borders?: { [edge in "top" | "right" | "bottom" | "left" | "between"]?: GoogleDocBorder };

  /** Set when the paragraph stays on the page of the one after it. */
  keepWithNext?: true;

  /** Set when the paragraph's lines stay on one page. */
  keepLinesTogether?: true;

  /** Set when the paragraph is not left with one line alone at the top or foot of a page. */
  avoidWidowAndOrphan?: true;

  /** Set when the paragraph starts a new page. */
  pageBreakBefore?: true;

  /** Where a tab in the text reaches, from the column's edge, where the paragraph sets them. */
  tabStops?: { offset: number; alignment: "start" | "center" | "end" }[];
}

export type GoogleDocBorder = {
  width: number;
  color: string;
  dash?: "dot" | "dash";

  /** The space between a paragraph's border and its text. */
  padding?: number;
}

/** How text is set. */
export type GoogleDocTextLook = {
  fontFamily: string;
  fontSize: number;

  /** From 100 to 900, bold counted in. */
  weight: number;
  italic?: true;
  underline?: true;
  strikethrough?: true;
  smallCaps?: true;

  /** Set for text raised or lowered, which Google Docs also draws smaller. */
  baseline?: "super" | "sub";
  color?: string;

  /** The color behind the text. */
  highlight?: string;
}

/** One level of a list. */
export type GoogleDocListLevel = {
  /**
   * The marker's text, in which `%0` stands for the item's number at the outermost level, `%1`
   * for its number at the next, and so on, each written as its level's `numbering` says.
   */
  format: string;

  /** How a number is written. Absent for a level whose marker is `symbol`. */
  numbering?: "decimal" | "zeroDecimal" | "alpha" | "upperAlpha" | "roman" | "upperRoman";

  /** The marker of a bulleted level. */
  symbol?: string;

  /** The number of the level's first item. */
  start: number;

  /** How the marker sits in the space before the text; at its start when absent. */
  alignment?: "center" | "end";

  /** What an item of this level is indented by where its paragraph sets nothing. */
  indentFirstLine: number;
  indentStart: number;
}

export type GoogleDocTable = {
  type: "table";
  range?: GoogleDocRange;

  /** Each column's width; zero for a column that shares what the others leave. */
  columns: number[];
  rows: {
    /** The least height the row has. */
    minHeight?: number;

    /** Set when the row is repeated at the top of each page the table reaches. */
    header?: true;

    /** Set when the row is kept whole on one page. */
    unbroken?: true;

    /** The row's cells, without those a merged cell covers. */
    cells: GoogleDocTableCell[];
  }[];
}

export type GoogleDocTableCell = {
  /** The column the cell starts in, counting from zero. */
  column: number;
  rowSpan?: number;
  columnSpan?: number;

  /** The color that fills the cell. */
  background?: string;

  /** Where the cell's content sits in it; at the top when absent. */
  verticalAlign?: "middle" | "bottom";

  /** The space inside each edge: top, right, bottom, left. */
  padding: [number, number, number, number];

  /** Each edge's line; an edge left out has none. */
  borders: { [edge in "top" | "right" | "bottom" | "left"]?: GoogleDocBorder };
  blocks: GoogleDocBlock[];
}

/** An image, drawing or chart. */
export type GoogleDocObject = {
  /** The size it is drawn at. */
  width: number;
  height: number;

  /** The space kept clear around it: top, right, bottom, left. */
  margins?: [number, number, number, number];

  /** Alt text. */
  description?: string;

  /** False for a drawing, which has a size but no content `readImage()` could return. */
  readable: boolean;

  /** How much of the image is cut from each edge, as a fraction of its own size. */
  crop?: { top: number; right: number; bottom: number; left: number };

  /** How far it is turned clockwise, in radians. */
  angle?: number;

  /** From 0, opaque, to 1. */
  transparency?: number;
  border?: GoogleDocBorder;

  /**
   * Set for an object tethered to a paragraph: where the box of it and its margins starts, from
   * the column's edge and from the paragraph's top, and how the text meets it. `wrap` lets text
   * past it on both sides, `breakLeft` and `breakRight` keep it to that side with text on the
   * other, `breakBoth` leaves no text beside it, and `front` and `behind` leave the text as it is.
   */
  placed?: {
    left: number;
    top: number;
    layout: "wrap" | "breakLeft" | "breakRight" | "breakBoth" | "front" | "behind";
  };
}

/** One object's content, streamed. */
export type GoogleDocImageBytes = {
  /** `image/png`, `image/jpeg`, `image/gif` or `image/webp`. */
  mimeType: string;

  /**
   * The image file's bytes, read from Google as you read them. Read it whole with
   * `await new Response(content).arrayBuffer()`. Read it straight away, and cancel it if you
   * will not. It fails partway for an image larger than 10 MB whose size Google did not state.
   */
  content: ReadableStream<Uint8Array>;
}

/** What a tab's pending changes make of its saved body. */
export type GoogleDocPendingDrawing = {
  /**
   * The ID `listTabs()` gives the tab: not the one asked for, where that was the provisional ID
   * of a tab Google Docs has since been given.
   */
  tabId: string;

  /** The `version` of the `GoogleDocDrawing` whose blocks the edits name, where it has one. */
  version?: string;

  /**
   * Where the tab with its pending changes differs from the saved one, in order and apart: each
   * puts `blocks` in place of the saved body's blocks whose `range` lies from `start` up to
   * `end`. Where `start` is `end` the blocks are only added, before the saved block that starts
   * there; with no blocks the range is only removed. A changed table comes whole. A tab that is
   * itself pending is one edit at 0, of all it holds. A change that is stale is in none.
   */
  edits: { start: number; end: number; blocks: GoogleDocPendingBlock[] }[];

  /**
   * The lists the edits' paragraphs name that a pending change makes or changes, by ID, each
   * level as far as it is known. Draw the rest of a level as the drawing's own where it has the
   * list. A list that is not here is as the drawing has it.
   */
  lists: Record<string, Pick<GoogleDocListLevel, "numbering" | "symbol" | "start">[]>;

  /** What the edits' paragraphs state of how they are set, each named by its place here. */
  paragraphLooks: GoogleDocPendingParagraphLook[];

  /** What the edits' text states of how it is set, each named by its place here. */
  textLooks: GoogleDocPendingTextLook[];
}

/**
 * A block of a pending edit. A paragraph and a table are as the drawing's, but their `look`, `end`
 * and their runs' `look` are places in the pending drawing's own `paragraphLooks` and `textLooks`.
 * A table's row never says `unbroken`, and its cell names a `background` of the page's own color,
 * which the drawing leaves out. The objects they name are the drawing's, and so are the lists, but
 * for those the pending drawing's own `lists` holds: the ones a pending change makes or changes. A
 * footnote's `mark` is empty: number the footnotes, as a list's items, once the edits are in
 * place. Of a table of contents and of a section break only the place is known: each stands for
 * the saved block of its kind that its edit's range holds at the same count, if there is one.
 */
export type GoogleDocPendingBlock =
  | GoogleDocParagraph
  | GoogleDocTable
  | { type: "contents" | "section" };

/**
 * What a pending paragraph states of how it is set. What it leaves out of these its named style
 * sets (`GoogleDocDrawing.named`). Nothing else is known of it: take the rest from the saved
 * paragraph it replaces or stands beside.
 */
export type GoogleDocPendingParagraphLook = {
  alignment?: "start" | "center" | "end" | "justify";
  indentStart?: number;
  indentFirstLine?: number;
}

/**
 * What pending text states of how it is set. What it leaves out of these its paragraph's named
 * style sets. Nothing else is known of it (its font, small caps, baseline and highlight): take
 * the rest from the saved text it replaces or stands beside.
 */
export type GoogleDocPendingTextLook = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  color?: string;
}
