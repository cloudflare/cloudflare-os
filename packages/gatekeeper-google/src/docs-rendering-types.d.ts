/**
 * Reads of a Google Doc session that its own declarations leave out: what it takes to render a
 * tab as Google Docs draws it. The session has these methods as it has the others.
 */
export interface GoogleDocRenderingReads {
  /**
   * Tab `tabId` as Google Docs has it saved and lays it out: its page, sections, headers and
   * footers, and every paragraph, table and object with its style in full. It says nothing of
   * pending changes: `getPendingChanges()` returns the tab's Markdown before and after them, and
   * each block of the body here names its line of that `savedMarkdown`. To read or edit the
   * tab's text call `getContent()`, whose answer is far smaller.
   *
   * `readImage()` reads the bytes of an object named here, and `readFont()` a font of a family
   * named here.
   */
  readDrawing(tabId: string): Promise<GoogleDocDrawing>;

  /**
   * Read the file of one font of `family`, a `fontFamily` the tab's drawing returned, from Google
   * Fonts: `weight` from 100 to 900, upright or `italic`. Throws when Google Fonts has no such font.
   */
  readFont(family: string, weight: number, italic: boolean): Promise<ReadableStream<Uint8Array>>;
}

/** One tab as Google Docs draws it. Lengths are in points and colors are `#rrggbb`. */
export type GoogleDocDrawing = {
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
   * `textLooks`: `NORMAL_TEXT`, `TITLE`, `SUBTITLE` and `HEADING_1` to `HEADING_6`.
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
      line?: number;
      blocks: GoogleDocBlock[];
    }
  | {
      /** Where the section at this place in `sections` starts. */
      type: "section";
      line?: number;
      section: number;
    };

export type GoogleDocParagraph = {
  type: "paragraph";

  /**
   * The paragraph's line in `getPendingChanges().savedMarkdown`, counting from zero: set for the
   * body's own blocks, and for none in a table, a header, a footer or a footnote.
   */
  line?: number;

  /** The named style the paragraph has, such as `NORMAL_TEXT` or `HEADING_2`. */
  style: string;

  /** What a link to this heading names it by, as `#heading=<headingId>` in the Markdown. */
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

  /** Where the text starts in the paragraph's line of the saved Markdown, when it has a line. */
  at?: number;

  /** Where the text leads, written as a link's destination is in the Markdown. */
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
  /** A person, a date or a link to a file, drawn as a chip with this text. */
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

  /** The line of the table's `<table>` in the saved Markdown, set for a table of the body. */
  line?: number;

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
