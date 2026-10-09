import type {
  GooglePresentationReadSession, ParagraphFormat, SlideBounds, SlideColor,
} from "./slides-read-types";
export type * from "./slides-read-types";

/**
 * One text edit. The text is a shape's, a table cell's, or a slide's speaker notes, exactly as
 * `getSlides()` returns it.
 */
export type SlideTextEdit = {
  /** The slide the text is on. */
  slideId: string;
  /**
   * The shape or table holding the text, by `SlideElement.id`; a shape inside a group counts.
   * Omit to edit the slide's speaker notes.
   */
  elementId?: string;
  /** For a table, the cell to edit, zero-based as in `TableElement.cells`. */
  cell?: { row: number; column: number };
  /**
   * The text to replace, which must occur exactly once in the target's text: include surrounding
   * text to make it unique. Omit to replace all of the target's text.
   */
  find?: string;
  /** The new text. `\n` starts a paragraph, `\u000b` breaks a line within one. */
  replace: string;
};

/**
 * Text in a shape or table cell, as `getSlides()` returns it: the one occurrence of `find`, the
 * characters `range` covers, or, with neither, all of it.
 */
export type SlideTextTarget = {
  /** The slide the text is on. */
  slideId: string;
  /** The shape or table, by ID or by the `ref` of a shape or table an earlier change creates. */
  elementId: string;
  /** For a table, the cell, zero-based as in `TableElement.cells`. */
  cell?: { row: number; column: number };
  /** Text that must occur exactly once in the target's text. */
  find?: string;
  /**
   * Offsets into the target's text, as in `FormattedRange`. The change fails if that text is no
   * longer what it was when the change was queued.
   */
  range?: { start: number; end: number };
};

/**
 * Formatting to set on text. `null` unsets a value, so the text takes its placeholder's or the
 * default; an omitted field is left as it is.
 */
export type TextFormatChange = {
  bold?: boolean | null;
  italic?: boolean | null;
  underline?: boolean | null;
  strikethrough?: boolean | null;
  smallCaps?: boolean | null;
  /** Font name, such as `Roboto` or `Georgia`, at regular weight: not bold unless `bold` is set. */
  fontFamily?: string | null;
  /** Font size in points. */
  fontSize?: number | null;
  /** Text colour. */
  color?: SlideColor | null;
  /** Highlight colour behind the text. */
  highlight?: SlideColor | null;
  /**
   * An `https:`, `http:` or `mailto:` URL to link the text to. The text also turns the theme's
   * link colour and underlined, unless `color` or `underline` is given too. Links cannot be
   * removed, and newlines are never linked.
   */
  link?: string;
  baseline?: "superscript" | "subscript" | "none" | null;
};

/** A shape's outline: its colour and weight in points, either kept as is when omitted. */
export type ShapeOutline = { color?: SlideColor; weight?: number };

/**
 * One change in an `updateSlides()` batch. Every change names the slide it is on. `ref` names an
 * element the change creates, so later changes in the same batch can pass it as an `elementId`;
 * its real ID is returned under that name.
 */
export type SlideChange =
  /**
   * Replace the one occurrence of `find`, or all of the target's text. New text takes the style of
   * the text it replaces, and text the edit leaves unchanged at either end keeps its own, so `find`
   * and `replace` may share context. A slide number can be replaced whole, not in part.
   */
  | ({ op: "editText" } & SlideTextEdit)
  /** Format text. */
  | ({ op: "formatText"; format: TextFormatChange } & SlideTextTarget)
  /**
   * Format every paragraph the target text touches. `null` unsets a value. `bullets` makes the
   * paragraphs list items, each nested by the tab characters it starts with, which are removed
   * (`"\t\tItem"` becomes "Item" at level 2), or plain paragraphs again with `"none"`. Bullets
   * cannot start right after a list item, which Google may continue: include that item too.
   */
  | ({
    op: "formatParagraphs";
    alignment?: ParagraphFormat["alignment"] | null;
    lineSpacing?: number | null;
    spaceAbove?: number | null;
    spaceBelow?: number | null;
    bullets?: "bullet" | "checkbox" | "numbered" | "none";
  } & SlideTextTarget)
  /**
   * Add a shape, such as `TEXT_BOX`, `RECTANGLE`, `ROUND_RECTANGLE` or `ELLIPSE` (any Google
   * Slides shape type but `CUSTOM`), in front of the slide's other elements.
   */
  | {
    op: "createShape";
    slideId: string;
    ref?: string;
    shapeType: string;
    bounds: SlideBounds;
    /** Text to put in the shape, with `\n` between paragraphs. */
    text?: string;
    /** Formatting for all of the shape's text. */
    format?: TextFormatChange;
    fill?: SlideColor | "none";
    outline?: ShapeOutline | "none";
  }
  /** Set a shape's fill, outline, or where its text sits vertically. */
  | {
    op: "updateShape";
    slideId: string;
    elementId: string;
    fill?: SlideColor | "none";
    outline?: ShapeOutline | "none";
    contentAlignment?: "top" | "middle" | "bottom";
  }
  /**
   * Move, resize or rotate an element that is not inside a group. Omitted fields keep their
   * value, and `x` and `y` place the unrotated box's top-left corner, so resizing a rotated
   * element moves its centre. A table can only be moved, and a video cannot be rotated. An element
   * created in the same batch cannot be changed this way: give it the bounds it should have instead.
   */
  | {
    op: "setBounds";
    slideId: string;
    elementId: string;
    bounds?: Partial<SlideBounds>;
    /** Clockwise, in degrees. */
    rotation?: number;
  }
  /**
   * Delete an element; a group is deleted with everything in it. An element inside a group can
   * be deleted only while at least two others stay in the group.
   */
  | { op: "deleteElement"; slideId: string; elementId: string }
  /** Set an element's alt text, which cannot be cleared. Groups have none. */
  | { op: "setAltText"; slideId: string; elementId: string; title?: string; description?: string }
  /** Bring an element that is not inside a group in front of the slide's others, or behind them. */
  | { op: "arrange"; slideId: string; elementId: string; to: "front" | "back" }
  /**
   * Add an image, which Google downloads once from `url` when the change is applied: a public
   * `https:` URL of a PNG, JPEG or GIF under 50 MB. The image is fitted inside `bounds` keeping
   * its proportions, so once applied it may be narrower or shorter than `bounds`; without
   * `bounds` it takes its own size at the slide's top-left corner, and has no `bounds` until
   * applied. The URL is saved with the image.
   */
  | { op: "insertImage"; slideId: string; ref?: string; url: string; bounds?: SlideBounds }
  /**
   * Replace an image's picture with the one at `url`, as for `insertImage`. The new picture fills
   * the image's box, cropped to fit, and the image loses some effects, such as recolouring.
   */
  | { op: "replaceImage"; slideId: string; elementId: string; url: string }
  /**
   * Add a table of up to 20 rows and 20 columns, with `cells[row][column]` as each cell's text.
   * Google may make it larger than `bounds`; without `bounds` it sizes it and centres it on the
   * slide, and it has no `bounds` until applied.
   */
  | {
    op: "createTable";
    slideId: string;
    ref?: string;
    rows: number;
    columns: number;
    bounds?: SlideBounds;
    cells?: string[][];
  }
  /**
   * Insert `count` (default 1, at most 20) empty rows or columns before row or column `at`, or
   * after the last with `at` equal to the number of rows or columns. Neither the row or column
   * beside them may hold a merged cell.
   */
  | {
    op: "insertTableRows" | "insertTableColumns";
    slideId: string;
    elementId: string;
    at: number;
    count?: number;
  }
  /**
   * Delete `count` (default 1) rows or columns starting at `at`, none of which may hold a merged
   * cell. To delete every row or column, delete the table.
   */
  | {
    op: "deleteTableRows" | "deleteTableColumns";
    slideId: string;
    elementId: string;
    at: number;
    count?: number;
  }
  /**
   * Set the fill or vertical text alignment of the cells in `range`, or of every cell. The range
   * may not cut through a merged cell.
   */
  | {
    op: "formatTableCells";
    slideId: string;
    elementId: string;
    range?: { row: number; column: number; rowSpan?: number; columnSpan?: number };
    fill?: SlideColor | "none";
    contentAlignment?: "top" | "middle" | "bottom";
  };

/**
 * Read/write access to one directly bound Google Slides presentation.
 *
 * Changes are queued for the user's approval. `getPresentation()` and `getSlides()` show them as
 * if already applied; `getSlideThumbnail()` renders the presentation as saved. A queued change
 * that no longer applies, because the presentation was edited elsewhere, fails when approved, and
 * reads of what it changes report it in `queuedChangeConflict`.
 */
export interface GooglePresentationSession extends GooglePresentationReadSession {
  /**
   * Queue changes, applied in order, together or not at all, as one approval: text edits,
   * formatting, shapes, images, tables, and where elements sit. Returns the ID of each element
   * created with a `ref`, under that ref.
   *
   * The user may let a batch apply without asking when it only edits text, or when it only
   * formats text, paragraphs and shapes or moves elements, setting no link or font. Any other
   * batch, mixing those two included, waits for approval, so queue changes that need not apply
   * together as separate batches.
   *
   * Reads show the changes as if applied, except what only Google can work out: a new element
   * reads with just what the change sets until it is applied, and an image's fitted size, the size
   * Google gives a table, the formatting new table rows and columns take, and how text wraps or
   * shrinks to fit appear once applied. Throws, queuing nothing, when a change does not apply to
   * the slides `getSlides()` would now return.
   */
  updateSlides(changes: SlideChange[]): Promise<Record<string, string>>;

  /**
   * Queue copying a slide, with its speaker notes, to right after it. Returns the copy's slide ID.
   * Its elements get new IDs too: read the copy with `getSlides()` to edit it.
   */
  duplicateSlide(slideId: string): Promise<string>;

  /** Queue deleting a slide. */
  deleteSlide(slideId: string): Promise<void>;

  /**
   * Queue moving slides to follow the slide `after`, or to the start when `after` is null. They
   * keep their current order relative to each other, whatever order `slideIds` lists them in.
   */
  moveSlides(slideIds: string[], after: string | null): Promise<void>;
}
