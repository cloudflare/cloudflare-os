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
  /** Whether the slide is skipped when presenting. */
  skipped: boolean;
  /** Text of the slide's title placeholder, truncated to 200 characters. */
  title?: string;
  /** Whether the slide has non-empty speaker notes. */
  hasSpeakerNotes: boolean;
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
};

/** Alternative text a page element may carry. */
type SlideElementBase = {
  /** Stable page element object ID. */
  id: string;
  /** Alt-text title. */
  altTitle?: string;
  /** Alt-text description. */
  altDescription?: string;
};

/**
 * One table cell. `null` in `TableElement.cells` marks a position covered by a merged cell that
 * starts above or to the left of it.
 */
export type TableCell = {
  /** The cell's text. */
  text: string;
  /** Rows this cell spans, when more than one. */
  rowSpan?: number;
  /** Columns this cell spans, when more than one. */
  columnSpan?: number;
};

/** A shape, text box, or placeholder. */
export type ShapeElement = SlideElementBase & {
  kind: "shape";
  /** Google shape type, such as `TEXT_BOX` or `RECTANGLE`. */
  shapeType: string;
  /** Placeholder type, such as `TITLE` or `BODY`, when the shape is a layout placeholder. */
  placeholder?: string;
  /**
   * The shape's own text: paragraphs are separated by `\n`, a line break within a paragraph is
   * `\u000b`, a slide number appears as the number it shows, and the final paragraph's newline is
   * omitted. An empty placeholder is `""`; the prompt text its layout shows in the editor is not
   * part of the slide.
   */
  text: string;
};

/** A table. */
export type TableElement = SlideElementBase & {
  kind: "table";
  /** Number of rows. */
  rows: number;
  /** Number of columns. */
  columns: number;
  /** Cells by row, then column. */
  cells: (TableCell | null)[][];
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

/** A page element whose content is not text, such as an image or a chart. */
export type OtherElement = SlideElementBase & {
  kind: "image" | "video" | "line" | "sheetsChart" | "other";
};

/** One element on a slide. */
export type SlideElement =
  ShapeElement | TableElement | GroupElement | WordArtElement | OtherElement;

/** One slide's content. */
export type Slide = SlideSummary & {
  /** The slide's own elements, in drawing order (back to front). */
  elements: SlideElement[];
  /**
   * Speaker notes, `""` when there are none. Paragraphs are separated by `\n`, as in shape text.
   */
  speakerNotes: string;
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
 * `getSlides()` returns the slides' own text. Layout and master elements such as logos and
 * footers, styles, and positions are not included; `getSlideThumbnail()` shows the slide whole.
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
