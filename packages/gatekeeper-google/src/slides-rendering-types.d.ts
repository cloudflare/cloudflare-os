import type {
  DashStyle, ParagraphFormat, SlideBounds, SlidePoint, TextLink,
} from "./slides-read-types";

/**
 * Reads of a `GooglePresentationSession` that its own declarations leave out: what it takes to
 * render the presentation as Google draws it. The session has these methods as it has the others.
 */
export interface GooglePresentationRenderingReads {
  /**
   * Up to 10 slides as Google Slides draws them, saved and with pending changes applied, each
   * element placed and styled as its layout, master and theme make it. To read or edit slides
   * call `getSlides()`, whose answer is far smaller. Throws if an ID names no slide.
   */
  readSlideDrawings(slideIds: string[]): Promise<SlideDrawings>;

  /**
   * A picture that an element `readSlideDrawings()` returned for `slideId` names,
   * at most 6 MB and no larger than it is drawn. Code you run cannot look at its bytes.
   */
  readPicture(pictureId: string, slideId: string): Promise<SlidePictureBytes>;

  /** The font families the saved presentation's text names. */
  listFonts(): Promise<SlideFont[]>;

  /**
   * One font of a family `listFonts()` returns, as a TrueType file from Google
   * Fonts. Throws for a font Google Fonts does not serve, such as Arial.
   */
  readFont(family: string, weight: number, italic: boolean): Promise<ReadableStream<Uint8Array>>;
}

/** A colour as drawn: `#rrggbb`, a theme colour resolved, with `opacity` when it is under 1. */
export type DrawnFill = { color: string; opacity?: number };

/** A line as drawn. `weight` is in points. */
export type DrawnStroke = DrawnFill & { weight: number; dash?: DashStyle };

/** A shadow as drawn. Its offset and blur are in points. */
export type DrawnShadow = DrawnFill & { x: number; y: number; blur: number };

/** Text as drawn, with all it takes from its placeholder, layout and theme. Colours are `#rrggbb`. */
export type DrawnTextStyle = {
  fontFamily: string;
  /** In points, as Google last shrank the text to fit its shape. */
  fontSize: number;
  /** From 100 to 900. */
  fontWeight: number;
  italic?: true;
  underline?: true;
  strikethrough?: true;
  smallCaps?: true;
  color: string;
  highlight?: string;
  baseline?: "superscript" | "subscript";
};

/** A run of text drawn in one style. `\u000b` is a line break. */
export type DrawnRun = DrawnTextStyle & { text: string; link?: TextLink };

/** A paragraph as drawn. Lengths are in points; `lineSpacing` is a percentage of single spacing. */
export type DrawnParagraph = {
  runs: DrawnRun[];
  alignment?: ParagraphFormat["alignment"];
  rightToLeft?: true;
  lineSpacing?: number;
  spaceAbove?: number;
  spaceBelow?: number;
  indentStart?: number;
  indentEnd?: number;
  /** From the text box's edge, not from `indentStart`. */
  indentFirstLine?: number;
  /** A list item's marker. */
  bullet?: DrawnTextStyle & { glyph: string };
};

/**
 * One path of a freeform shape, in a box `width` by `height` that fills the shape's `bounds`.
 * `ops` holds a letter a step, as in an SVG path: `M` and `L` take a point of `points`, `Q` two,
 * `C` three and `Z` none, each point an `x` and a `y`.
 */
export type DrawnPath = {
  width: number;
  height: number;
  ops: string;
  points: number[];
  /** `false` for a path that is only outlined, or only filled. */
  filled?: false;
  stroked?: false;
};

/** What fills a shape or a table cell, and the text in it. */
type DrawnContent = {
  fill?: DrawnFill;
  contentAlignment?: "top" | "middle" | "bottom";
  text?: DrawnParagraph[];
};

/** One table cell as drawn. */
export type DrawnTableCell = DrawnContent & { rowSpan?: number; columnSpan?: number };

/** One element of a slide as Google Slides draws it. */
export type DrawnElement = {
  /** One inside a group is listed on its own, placed as the group places it. */
  id: string;
  /** Set on a layout's or master's element, which lies behind the slide's own. */
  from?: "layout" | "master";
  /** As `SlideElementBase.bounds`. */
  bounds: SlideBounds;
  /** Clockwise, in degrees, about the centre of `bounds`. */
  rotation?: number;
  /** Set when it is mirrored top to bottom, before it is rotated. */
  flipped?: true;
  /** The pending changes that touched it, by `PresentationPendingChange.id` and `SlideChange.op`. */
  changes?: { id: number; op: string }[];
} & (
  | (DrawnContent & {
    kind: "shape";
    /** As `ShapeElement.shapeType`. */
    shapeType: string;
    /** A `CUSTOM` shape's outline; absent when Google's export of the presentation gave none. */
    paths?: DrawnPath[];
    /**
     * How far a preset shape's handles were dragged, as its OOXML `adj` values. Absent when not
     * known, as for a shape not saved yet or a kind drawn without them: draw it at its defaults.
     */
    adjust?: number[];
    outline?: DrawnStroke;
    shadow?: DrawnShadow;
  })
  | {
    kind: "picture";
    /** An image, or the picture Google keeps of a video or a chart. */
    of: "image" | "video" | "chart";
    /** What to pass `readPicture()`; absent when Google has no picture yet, as for a pending image. */
    pictureId?: string;
    /** The fraction cut from each edge, and the cut's clockwise rotation in degrees. */
    crop?: { left: number; top: number; right: number; bottom: number; angle?: number };
    /** From 0 to 1. */
    opacity?: number;
    /** From -1 to 1, as is `contrast`. */
    brightness?: number;
    contrast?: number;
    outline?: DrawnStroke;
    shadow?: DrawnShadow;
  }
  | {
    kind: "line";
    start: SlidePoint;
    end: SlidePoint;
    stroke?: DrawnStroke;
    /** As `LineElement.startArrow`. */
    startArrow?: string;
    endArrow?: string;
    category?: "straight" | "bent" | "curved";
    /**
     * Where a `bent` line turns, or a `curved` one bends towards, as Google Slides first routes it:
     * one point for a line of two legs, two for one of three. Absent where Google routes the line
     * some other way, which it does not report.
     */
    via?: SlidePoint[];
  }
  | {
    kind: "table";
    /** In points. */
    columnWidths: number[];
    /** Each row's least height in points. */
    rowHeights: number[];
    /** By row, then column; `null` where a merged cell covers the position. */
    cells: (DrawnTableCell | null)[][];
    /** Cell edges, indexed as `TableElement.borders`; `null` for one not drawn. */
    horizontalBorders: (DrawnStroke | null)[][];
    verticalBorders: (DrawnStroke | null)[][];
  }
);

/** A slide as Google Slides draws it. */
export type DrawnSlide = {
  /** A colour, or what to pass `readPicture()` for a picture. */
  background?: DrawnFill | { pictureId?: string };
  /** What lies behind its own elements, back to front: indexes into `SlideDrawings.shared`. */
  behind?: number[];
  /** Its own elements, back to front. */
  elements: DrawnElement[];
  speakerNotes: string;
};

/** One slide of what `readSlideDrawings()` returns. */
export type SlideDrawing = {
  slideId: string;
  /** With pending changes applied; `null` when one deletes the slide. */
  drawing: DrawnSlide | null;
  /** As saved, when that differs from `drawing`; `null` for a slide a pending change adds. */
  saved?: DrawnSlide | null;
  /**
   * Set while the `paths` and `adjust` of shapes this slide shows are still being fetched: reading
   * the slide again in a few seconds has them. Not set when they are absent for good.
   */
  outlinesPending?: true;
};

/** What `readSlideDrawings()` returns. */
export type SlideDrawings = {
  /** In the order requested. */
  slides: SlideDrawing[];
  /** What masters and layouts put behind their slides, each list once for all its slides. */
  shared: DrawnElement[][];
};

/**
 * A picture: `image/png`, `image/jpeg`, `image/gif` or `image/webp`, and its bytes, read from
 * Google as you read them. Read it straight away, and cancel it if you will not.
 */
export type SlidePictureBytes = { mimeType: string; content: ReadableStream<Uint8Array> };

/** A font family the presentation's text names, and the weights it is drawn at. */
export type SlideFont = { family: string; weights: number[]; italic: boolean };
