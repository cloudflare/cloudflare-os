import type { SheetCellFormat, SpreadsheetSheetInfo } from "./sheets-read-types";
import type { SheetCellInput } from "./sheets-types";

/**
 * Reads of a `GoogleSpreadsheetSession` that its own declarations leave out: what it takes to
 * render the spreadsheet as Google draws it. The session has these methods as it has the others.
 */
export interface GoogleSpreadsheetRenderingReads {
  /**
   * Return what it takes to draw a bounded A1 range, such as `Sales!A1:Z60`, as Google Sheets
   * draws it with the pending changes made: each cell's displayed text and formatting in effect,
   * the sizes of its rows and columns, and the merged ranges. A cell a pending change writes also
   * says what it displays as saved. The sheet's frozen rows and columns are drawn with any range.
   * At most 10,000 cells are drawn at once, those of frozen rows and columns included.
   */
  readDrawing(range: string): Promise<SpreadsheetDrawing>;

  /**
   * One font of a family that a format `readDrawing()` returned names first in its `fontFamily`,
   * as a TrueType file from Google Fonts. Throws for a font Google Fonts does not serve, such as
   * Arial, and for a family only a pending change sets.
   */
  readFont(family: string, weight: number, italic: boolean): Promise<ReadableStream<Uint8Array>>;
}

/**
 * How a cell is drawn: its formatting in effect, conditional formatting included, with every
 * colour as `#rrggbb`. An absent field is Google Sheets' default.
 */
export type SheetDrawnFormat = Omit<SheetCellFormat, "numberFormat"> & {
  /** The font's family, such as `Arial`. */
  fontFamily?: string;
  /** How far the text is turned, in degrees from -90 to 90: 90 reads from the bottom up. */
  rotation?: number;
};

/** One row or column of a drawing. */
export type SheetDrawnLine = {
  /** Its 1-based number among the sheet's rows or columns: column C is 3. */
  number: number;
  /**
   * Its height or width in pixels. A row nobody has resized is as tall as its text, which is
   * estimated where the text wraps.
   */
  size: number;
  /** Set when it is hidden, by hand or by a filter. */
  hidden?: true;
  /** Set when a pending change inserts it. Google Sheets decides its size and formatting. */
  inserted?: true;
};

/** One cell of a drawing. */
export type SheetDrawnCell = {
  /**
   * What the cell displays, as `readRange()` reads it. Absent when it is empty, or `pending`.
   */
  text?: string;
  /** Set when what the cell will display is not known until pending changes are saved. */
  pending?: true;
  /**
   * What kind of value it holds, when not text: Google Sheets sets numbers, dates and times to
   * the right and booleans and errors in the middle unless the cell is aligned.
   */
  kind?: "number" | "boolean" | "error";
  /** Its formatting: an index into the drawing's `formats`. Absent when it has none. */
  format?: number;
  /** The address Google Sheets says it links to, when no pending change writes the cell. */
  link?: string;
  /** What it holds that `text` and `format` do not say. */
  holds?: ("note" | "dropdown" | "checkbox")[];
  /**
   * The stretches of `text` formatted apart from the rest, in order: each runs from `start`, a
   * 0-based index into `text`, to the next one's, and looks as the cell does except where its
   * `format`, an index into the drawing's `formats`, says otherwise. Absent when the text looks
   * the same throughout, or a pending change writes the cell.
   */
  runs?: { start: number; format?: number }[];
  /** The `id` of the pending change that last wrote or cleared it. */
  change?: number;
  /** With `change`: what that change entered, a formula as its text, or `null` for a clear. */
  entered?: SheetCellInput;
  /** What it displays as saved, when `change` or `pending` is set and it is not empty. */
  saved?: string;
  /** Set when a pending change sets some of its formatting. */
  formatted?: true;
};

/** A window of one sheet as Google Sheets draws it, with the pending changes made. */
export type SpreadsheetDrawing = {
  /** The cells asked for, as Google names them, such as `Sales!A1:F40`. */
  range: string;
  /** The sheet, with how it is laid out. */
  sheet: SpreadsheetSheetInfo & {
    /** How many leading rows stay in view while the rest scroll. */
    frozenRowCount?: number;
    /** How many leading columns stay in view while the rest scroll. */
    frozenColumnCount?: number;
    /** Set when the sheet's gridlines are hidden. */
    gridlinesHidden?: true;
  };
  /** The rows drawn: the frozen rows above the range, then the range's own. */
  rows: SheetDrawnLine[];
  /** The columns drawn: the frozen columns before the range, then the range's own. */
  columns: SheetDrawnLine[];
  /** One array per row of `rows`, each with one cell per column of `columns`; `null` is an empty cell with no formatting. */
  cells: (SheetDrawnCell | null)[][];
  /** The formats the cells are drawn in. */
  formats: SheetDrawnFormat[];
  /** The merged ranges that reach into the cells drawn, in A1 notation with no sheet. */
  merges: string[];
  /**
   * The first cell of each of `merges` that starts outside the cells drawn, by its A1 name: a
   * merged range shows what its first cell holds.
   */
  anchors?: Record<string, SheetDrawnCell>;
  /** The range a filter is set on, in A1 notation with no sheet. */
  filter?: string;
  /** The charts over the sheet, which the drawing has no picture of. */
  charts?: {
    title?: string;
    /** The cell its top left corner is in, and how far inside, in pixels. */
    anchor: string;
    offsetX: number;
    offsetY: number;
    /** Its size in pixels. */
    width: number;
    height: number;
  }[];
  /**
   * The first queued change that no longer applies. It and the changes queued after it are not
   * shown.
   */
  queuedChangeConflict?: string;
};
