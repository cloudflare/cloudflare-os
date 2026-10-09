/** Width and height in points. */
export type SlideSize = {
  /** Width in points. */
  width: number;
  /** Height in points. */
  height: number;
};

/** One slide's place in the presentation, without its content. */
export type SlideSummary = {
  /** Stable slide object ID. Pass it to `getSlides()`. */
  id: string;
  /** Zero-based position in the presentation when it was read. */
  index: number;
  /** Display name of the layout the slide was made from, such as `Title and body`. */
  layout?: string;
  /** ID of the master, or theme, its layout belongs to. */
  master?: string;
  /** Whether the slide is skipped when presenting. */
  skipped: boolean;
  /** Text of the slide's title placeholder, truncated to 200 characters. */
  title?: string;
  /** Whether the slide has non-empty speaker notes. */
  hasSpeakerNotes: boolean;
};

/** A layout a slide can be made from. */
export type SlideLayout = {
  /** Layout object ID. Pass it to `createSlide()`. */
  id: string;
  /** Display name, such as `Title and body`, as `SlideSummary.layout` shows it. */
  name: string;
  /**
   * ID of the master, or theme, it belongs to. A new slide can take a layout only from the master
   * of the slide before it, of the first slide when it goes first, or of the presentation's first
   * master when it has no slides.
   */
  master: string;
  /** The placeholders the layout holds, by type such as `TITLE` or `BODY`, in drawing order. */
  placeholders: string[];
};

/** Metadata about the connected presentation and the slides it contains. */
export type PresentationInfo = {
  /** Stable Google presentation ID. */
  id: string;
  /** Presentation title. */
  title: string;
  /** Presentation locale, such as `en`. */
  locale?: string;
  /** Size of every slide. */
  pageSize: SlideSize;
  /** Every slide, in presentation order. */
  slides: SlideSummary[];
  /** Every layout the presentation's masters hold. */
  layouts: SlideLayout[];
  /**
   * Set when a change queued for approval no longer applies to the presentation: why. Neither it
   * nor any change queued after it is reflected.
   */
  queuedChangeConflict?: string;
};

/**
 * The box an element occupies on its slide, before any rotation, in points from the slide's
 * top-left corner: what the Slides editor shows as its position and size.
 */
export type SlideBounds = {
  /** Distance of the box's left edge from the slide's left edge. */
  x: number;
  /** Distance of the box's top edge from the slide's top edge. */
  y: number;
  /** Width in points. */
  width: number;
  /** Height in points. */
  height: number;
};

/** What every page element carries: its ID, place, and alternative text. */
type SlideElementBase = {
  /** Stable page element object ID. */
  id: string;
  /** Where the element is, absent when Google reports no place for it. */
  bounds?: SlideBounds;
  /** Clockwise rotation in degrees about the centre of `bounds`, when not 0. */
  rotation?: number;
  /** Alt-text title. */
  altTitle?: string;
  /** Alt-text description. */
  altDescription?: string;
};

/**
 * A colour: `#rrggbb`, or a theme colour such as `ACCENT1`, `DARK1` or `HYPERLINK`, which follows
 * the presentation's theme.
 */
export type SlideColor = string;

/**
 * Text formatting set on the text itself. What text takes from its placeholder, layout or theme is
 * not shown, and Google stores a value equal to the one the text would take anyway as not set, so
 * such a value disappears once a change setting it is applied.
 */
export type TextFormat = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  smallCaps?: boolean;
  /** Font name, such as `Roboto`. */
  fontFamily?: string;
  /** Font size in points. */
  fontSize?: number;
  /** Font weight from 100 to 900, when not the regular 400. Bold text shows at 700 or more. */
  fontWeight?: number;
  /** Text colour. */
  color?: SlideColor;
  /** Highlight colour behind the text. */
  highlight?: SlideColor;
  /** What the text links to. */
  link?: TextLink;
  /** Text raised or lowered from the line. */
  baseline?: "superscript" | "subscript";
};

/**
 * A link's target: a URL, a slide by ID or by zero-based position, or a slide relative to the one
 * being presented.
 */
export type TextLink =
  | string
  | { slideId: string }
  | { slideIndex: number }
  | { relative: "next" | "previous" | "first" | "last" };

/**
 * The formatting of `text.slice(start, end)`. A range may run on across a paragraph break when the
 * text on both sides sets the same; the newline itself is not reported.
 */
export type FormattedRange = TextFormat & { start: number; end: number };

/** Paragraph formatting set on the paragraph itself, as for `TextFormat`. */
export type ParagraphFormat = {
  alignment?: "start" | "center" | "end" | "justified";
  /** Line spacing as a percentage of single spacing, which is 100. */
  lineSpacing?: number;
  /** Space above the paragraph, in points. */
  spaceAbove?: number;
  /** Space below the paragraph, in points. */
  spaceBelow?: number;
  /** Indent of the paragraph's start edge, in points. */
  indentStart?: number;
  /** Indent of the paragraph's end edge, in points. */
  indentEnd?: number;
  /** Indent of the paragraph's first line, in points from the text box's edge, not `indentStart`. */
  indentFirstLine?: number;
};

/** A paragraph, `text.slice(start, end)` without its newline, and its formatting. */
export type FormattedParagraph = ParagraphFormat & {
  start: number;
  end: number;
  /** Set when the paragraph is a list item: its nesting level, 0 for the outermost. */
  bullet?: { level: number };
};

/** Text with its formatting. */
type FormattedText = {
  /**
   * Paragraphs are separated by `\n`, a line break within a paragraph is `\u000b`, a slide number
   * appears as the number it shows, and the final paragraph's newline is omitted.
   */
  text: string;
  /** Ranges of `text` that set formatting, in order, not overlapping; absent if none does. */
  formats?: FormattedRange[];
  /** The paragraphs that set formatting or are list items; absent if none is. */
  paragraphs?: FormattedParagraph[];
};

/**
 * One table cell. `null` in `TableElement.cells` marks a position covered by a merged cell that
 * starts above or to the left of it.
 */
export type TableCell = FormattedText & {
  /** Rows this cell spans, when more than one. */
  rowSpan?: number;
  /** Columns this cell spans, when more than one. */
  columnSpan?: number;
  /** Background colour set on the cell, or `"none"` for transparent. */
  fill?: SlideColor | "none";
  /** How opaque `fill` is, from 0 to 1, when less than 1. */
  fillOpacity?: number;
  /** Where the cell's text sits vertically, when set on the cell. */
  contentAlignment?: "top" | "middle" | "bottom";
};

/**
 * A dash pattern, such as `DOT`, `DASH`, `DASH_DOT`, `LONG_DASH` or `LONG_DASH_DOT`; a solid line
 * has none.
 */
export type DashStyle = string;

/**
 * A shape, text box, or placeholder. An empty placeholder's text is `""`; the prompt text its
 * layout shows in the editor is not part of the slide.
 */
export type ShapeElement = SlideElementBase & FormattedText & {
  kind: "shape";
  /** Google shape type, such as `TEXT_BOX` or `RECTANGLE`. */
  shapeType: string;
  /** Placeholder type, such as `TITLE` or `BODY`, when the shape is a layout placeholder. */
  placeholder?: string;
  /** Fill colour set on the shape, or `"none"` for no fill; absent when it takes its default. */
  fill?: SlideColor | "none";
  /** How opaque `fill` is, from 0 to 1, when less than 1. */
  fillOpacity?: number;
  /** Outline set on the shape (weight in points), or `"none"`; absent when it takes its default. */
  outline?: { color?: SlideColor; weight?: number; dash?: DashStyle } | "none";
  /** Where the shape's text sits vertically, when set on the shape. */
  contentAlignment?: "top" | "middle" | "bottom";
};

/** One edge of a table cell: its colour, weight in points, and dash pattern; `"none"` if hidden. */
export type TableBorder = { color?: SlideColor; weight?: number; dash?: DashStyle } | "none";

/**
 * A table. Its `bounds` are its columns' widths and rows' heights added up, so a row drawn taller
 * to fit its text makes the table taller than `bounds` say.
 */
export type TableElement = SlideElementBase & {
  kind: "table";
  /** Number of rows. */
  rows: number;
  /** Number of columns. */
  columns: number;
  /** Cells by row, then column. */
  cells: (TableCell | null)[][];
  /** Each column's width in points. */
  columnWidths?: number[];
  /**
   * Each row's height in points: the least it may have, since Google draws a row taller to fit
   * its text, and reports that height nowhere.
   */
  rowHeights?: number[];
  /**
   * The border every cell edge has, when all have the same. Neither `border` nor `borders` is set
   * while a queued change to the table's rows or columns leaves its borders unknown.
   */
  border?: TableBorder;
  /**
   * Each cell edge's border, when they differ: `horizontal[r][c]` is the edge above row `r`'s
   * column `c` (`r` up to `rows`, for the bottom edge), and `vertical[r][c]` the edge left of it
   * (`c` up to `columns`). An edge inside a merged cell is `null`.
   */
  borders?: { horizontal: (TableBorder | null)[][]; vertical: (TableBorder | null)[][] };
};

/** A group of page elements that move together. */
export type GroupElement = SlideElementBase & {
  kind: "group";
  /** The grouped elements, in drawing order. */
  children: SlideElement[];
};

/** Word art: text drawn as a graphic. */
export type WordArtElement = SlideElementBase & {
  kind: "wordArt";
  /** The text the word art shows. */
  text: string;
};

/** A picture. */
export type ImageElement = SlideElementBase & {
  kind: "image";
  /** The URL the picture was inserted from, when Google kept one. */
  sourceUrl?: string;
};

/** A point on the slide, in points from its top-left corner. */
export type SlidePoint = { x: number; y: number };

/** The element a line's end is attached to, and which of its connection sites, numbered by Google. */
export type LineConnection = { elementId: string; site: number };

/** A line, arrow or connector, drawn from `start` to `end`. */
export type LineElement = SlideElementBase & {
  kind: "line";
  /** Whether the line runs straight, bends at right angles, or curves between its ends. */
  category?: "straight" | "bent" | "curved";
  /** Where the line starts, absent when Google reports no place for it. */
  start?: SlidePoint;
  /** Where the line ends. */
  end?: SlidePoint;
  /** The arrowhead at `start`, such as `FILL_ARROW`, `STEALTH_ARROW` or `OPEN_CIRCLE`; absent for none. */
  startArrow?: string;
  /** The arrowhead at `end`, as for `startArrow`. */
  endArrow?: string;
  /** Line colour, as set on the line. */
  color?: SlideColor;
  /** Weight in points, as set on the line. */
  weight?: number;
  dash?: DashStyle;
  /** The element `start` is attached to, which moving that element moves it with. */
  startConnection?: LineConnection;
  /** The element `end` is attached to. */
  endConnection?: LineConnection;
};

/** A video. */
export type VideoElement = SlideElementBase & {
  kind: "video";
  /** Where the video is: on YouTube, or a Google Drive file. */
  source?: "youtube" | "drive";
  /** The YouTube video ID or Drive file ID. */
  videoId?: string;
  /** A URL of the video. */
  url?: string;
};

/** A chart from a Google Sheets spreadsheet, drawn as it was when last refreshed. */
export type SheetsChartElement = SlideElementBase & {
  kind: "sheetsChart";
  /** The spreadsheet holding the chart. */
  spreadsheetId?: string;
  /** The chart's ID in that spreadsheet. */
  chartId?: number;
};

/** A page element of another kind, which the gatekeeper does not read. */
export type OtherElement = SlideElementBase & { kind: "other" };

/** One element on a slide. */
export type SlideElement =
  | ShapeElement | TableElement | GroupElement | WordArtElement | ImageElement | LineElement
  | VideoElement | SheetsChartElement | OtherElement;

/** One slide's content. */
export type Slide = SlideSummary & {
  /** The slide's own elements, in drawing order (back to front). */
  elements: SlideElement[];
  /**
   * Speaker notes, `""` when there are none. Paragraphs are separated by `\n`, as in shape text.
   */
  speakerNotes: string;
  /** As for `PresentationInfo.queuedChangeConflict`. */
  queuedChangeConflict?: string;
};

/** Thumbnail widths: `small` is 200 pixels, `medium` 800 and `large` 1600. */
export type SlideThumbnailSize = "small" | "medium" | "large";

/** A rendered image of one slide. */
export type SlideThumbnail = {
  /** Always `image/png`. */
  mimeType: "image/png";
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
  /** The PNG file's bytes. */
  content: ArrayBuffer;
};

/**
 * Read-only access to one Google Slides presentation.
 *
 * `getSlides()` returns the slides' own elements: their text, formatting, and where they are.
 * Layout and master elements such as logos and footers are not included, nor is formatting an
 * element takes from its placeholder or theme; `getSlideThumbnail()` shows the slide whole.
 */
export interface GooglePresentationReadSession {
  /** Return presentation metadata and a summary of every slide. */
  getPresentation(): Promise<PresentationInfo>;

  /**
   * Read the content of up to 20 slides, by the IDs `getPresentation()` returns, in the order
   * requested. Each slide is fetched on its own, so reading a few costs the same however large the
   * presentation is. Throws if any ID does not name a slide, or if the slides together are too
   * large to return, in which case request fewer at a time.
   */
  getSlides(slideIds: string[]): Promise<Slide[]>;

  /**
   * Render one slide, by an ID `getPresentation()` returns, as a PNG image `medium` wide unless
   * another size is given. The image shows everything on the slide, including layout and master
   * elements, as currently saved in Google Slides.
   *
   * The image is for a gadget to display or store: code you run cannot look at it, and logging
   * the bytes prints numbers, not a picture. Google allows an account about 60 renders a minute.
   */
  getSlideThumbnail(slideId: string, size?: SlideThumbnailSize): Promise<SlideThumbnail>;
}
