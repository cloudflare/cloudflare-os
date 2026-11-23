// The model `readPptxSlides` returns: a presentation as plain data a renderer can draw without
// knowing PresentationML. Every length is in points (1/72 inch; 12,700 EMU), with the origin at
// the slide's top left, and every property is already resolved through the file's inheritance
// (slide, layout, master, theme), so nothing here refers to another part of the file.

/** A color after its theme lookup and transforms. */
export interface SlideColor {
  /** Six upper-case hexadecimal digits, `RRGGBB`. */
  readonly hex: string;
  /** Opacity from 0 (transparent) to 1. */
  readonly alpha: number;
}

/** A picture's bytes, taken from a part inside the file. */
export interface SlideImage {
  readonly bytes: Uint8Array;
  /** A raster type a browser draws, or `image/svg+xml`, which is only safe to draw in an `<img>`. */
  readonly contentType: string;
}

/** One color stop of a gradient. */
export interface SlideGradientStop {
  /** From 0 (start) to 1 (end). */
  readonly position: number;
  readonly color: SlideColor;
}

/** What paints an area. */
export type SlideFill =
  | { readonly kind: "solid"; readonly color: SlideColor }
  /** `angle` is in degrees clockwise from left-to-right: 0 runs left to right, 90 top to bottom. */
  | { readonly kind: "gradient"; readonly angle: number; readonly stops: readonly SlideGradientStop[] }
  /** The image stretched over the area. */
  | { readonly kind: "image"; readonly image: SlideImage };

/** A stroke, centered on the edge it follows. */
export interface SlideOutline {
  readonly width: number;
  readonly color: SlideColor;
  readonly dash: "solid" | "dash" | "dot";
}

/**
 * Where a shape is: its unrotated box, then `rotation` degrees clockwise about the box's center.
 * A flip mirrors the shape's geometry within the box, before rotation.
 */
export interface SlideBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly flipH: boolean;
  readonly flipV: boolean;
}

/** A stretch of text with one formatting. A line break is a run whose text is `"\n"`. */
export interface SlideRun {
  readonly text: string;
  /** The typeface name as the file gives it, with theme fonts resolved (`Calibri`, not `+mn-lt`). */
  readonly font: string;
  /** In points, before the body's `fontScale`. */
  readonly size: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly color: SlideColor;
  /** Raised (positive) or lowered (negative) by this fraction of the size; 0 for ordinary text. */
  readonly baseline: number;
  /** Extra space after each character, in points; negative tightens. */
  readonly letterSpacing: number;
}

/** A paragraph's bullet or number, already formatted (`"•"`, `"3."`). */
export interface SlideBullet {
  readonly text: string;
  readonly font: string;
  readonly size: number;
  readonly color: SlideColor;
}

/** Line pitch: a multiple of the font's natural line height, or an exact distance in points. */
export type SlideLineSpacing =
  | { readonly kind: "multiple"; readonly value: number }
  | { readonly kind: "exact"; readonly points: number };

/** One paragraph of a text body. */
export interface SlideParagraph {
  readonly align: "left" | "center" | "right" | "justify";
  /** The outline level, 0 to 8. */
  readonly level: number;
  /** Where wrapped lines start, from the body's left inset. */
  readonly marginLeft: number;
  /** The first line's offset from `marginLeft`; negative for a hanging bullet. */
  readonly indent: number;
  readonly lineSpacing: SlideLineSpacing;
  /** In points, before the body's `fontScale`. PowerPoint drops it for a body's first paragraph. */
  readonly spaceBefore: number;
  readonly spaceAfter: number;
  /** Absent for an unbulleted paragraph, and for an empty one, which shows no bullet. */
  readonly bullet?: SlideBullet;
  /** The first run's size, or the size of the line an empty paragraph occupies. */
  readonly fontSize: number;
  readonly runs: readonly SlideRun[];
}

/** The text inside a shape or a table cell. */
export interface SlideTextBody {
  readonly insets: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  readonly anchor: "top" | "middle" | "bottom";
  /** False when lines only break where the text says. */
  readonly wrap: boolean;
  /** `rotate90` and `rotate270` are text turned to read down or up the shape. */
  readonly direction: "horizontal" | "rotate90" | "rotate270";
  /** What PowerPoint's shrink-on-overflow scaled font sizes and paragraph spacing by; 1 when it did not. */
  readonly fontScale: number;
  /** The fraction shrink-on-overflow took off line spacing; 0 when it did not. */
  readonly lineSpacingReduction: number;
  readonly paragraphs: readonly SlideParagraph[];
}

/** The outline a drawn shape has. Presets the reader does not know are their bounding `rect`. */
export type SlideGeometry = "rect" | "roundRect" | "ellipse" | "line";

/** A drawn shape, text box or placeholder. */
export interface SlideDrawnShape {
  readonly kind: "shape";
  readonly bounds: SlideBounds;
  /** A `line` runs from the box's top left to its bottom right, before flips. */
  readonly geometry: SlideGeometry;
  /** A `roundRect`'s corner radius. */
  readonly cornerRadius: number;
  readonly fill?: SlideFill;
  readonly outline?: SlideOutline;
  readonly text?: SlideTextBody;
}

/** A picture, cropped and stretched to its box. */
export interface SlidePicture {
  readonly kind: "picture";
  readonly bounds: SlideBounds;
  readonly geometry: SlideGeometry;
  readonly cornerRadius: number;
  readonly image: SlideImage;
  /** The fraction of the image cut from each side before it is stretched; negative values pad. */
  readonly crop: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  readonly outline?: SlideOutline;
  readonly description?: string;
}

/** One cell of a table, at its top-left grid position. Cells a merge covers are not listed. */
export interface SlideTableCell {
  /** The zero-based grid column the cell starts in. */
  readonly column: number;
  readonly columnSpan: number;
  readonly rowSpan: number;
  readonly fill?: SlideFill;
  readonly borders: {
    readonly left?: SlideOutline;
    readonly top?: SlideOutline;
    readonly right?: SlideOutline;
    readonly bottom?: SlideOutline;
  };
  readonly text: SlideTextBody;
}

/** A table. Its rows grow past their stated height when their text needs more. */
export interface SlideTable {
  readonly kind: "table";
  readonly bounds: SlideBounds;
  readonly columnWidths: readonly number[];
  readonly rows: readonly { readonly height: number; readonly cells: readonly SlideTableCell[] }[];
}

/** Content the reader does not interpret. */
export type SlideUnsupportedKind = "chart" | "diagram" | "object" | "picture";

/** Where uninterpreted content sits, for a renderer to mark with a labelled box. */
export interface SlideUnsupportedShape {
  readonly kind: "unsupported";
  readonly bounds: SlideBounds;
  readonly what: SlideUnsupportedKind;
}

/** Anything on a slide. Groups are flattened: their children appear here with final bounds. */
export type SlideShape = SlideDrawnShape | SlidePicture | SlideTable | SlideUnsupportedShape;

/** One slide. */
export interface Slide {
  /** The slide's position in the presentation, from 1, counting the hidden slides left out. */
  readonly number: number;
  readonly background: SlideFill;
  /** Back to front: the master's and layout's own shapes, then the slide's. */
  readonly shapes: readonly SlideShape[];
}

/** A presentation's visible slides. */
export interface SlideDeck {
  /** The slide size in points. */
  readonly width: number;
  readonly height: number;
  readonly slides: readonly Slide[];
  /** True when the presentation has more slides, or more on them, than the reader returns. */
  readonly truncated: boolean;
  /** The kinds of uninterpreted content the returned slides hold. */
  readonly unsupported: readonly SlideUnsupportedKind[];
}
