/**
 * What the Sheets and Slides editors have spent in this isolate since it started, counted always
 * (each is one integer added). Tests read the differences; nothing else reads them.
 */
export type EditorCost = {
  /** Copies made of a grid's overlay: its `cells`, `formats` and `sizes` maps, together. */
  overlayCopies: number;
  /** Entries those copies copied, over the three maps. */
  overlayEntries: number;
  /**
   * Keys of entries and formats put in an index by sheet, each time a change that reads one
   * sheet's entries (a deletion of rows or columns, a copy or a deletion of a sheet) builds it.
   */
  keysIndexed: number;
  /** Cells of a read put in a map under a string key of their own on the way to a simulated read. */
  cellsKeyed: number;
  /** Strings built only to be measured against a size limit. */
  measuredStrings: number;
  /** The longest of them, in UTF-16 units. A test sets it to 0 before what it measures. */
  longestMeasured: number;
  /** UTF-16 units of the JSON built whole to be digested for a batch's guard. */
  digestedUnits: number;
  /** Slides, masters and layouts copied whole with `structuredClone`. */
  pageClones: number;
  /** Slides passed whole through `JSON.stringify` and `JSON.parse` to show their number. */
  pageRoundTrips: number;
  /** UTF-16 units of the JSON those round trips built. */
  roundTripUnits: number;
};

/** The running totals of `EditorCost`. */
export const editorCost: EditorCost = {
  overlayCopies: 0, overlayEntries: 0, keysIndexed: 0, cellsKeyed: 0, measuredStrings: 0,
  longestMeasured: 0, digestedUnits: 0, pageClones: 0, pageRoundTrips: 0, roundTripUnits: 0,
};

/** Counts a string built only to be measured, and gives its length. */
export function measured(text: string): number {
  editorCost.measuredStrings++;
  editorCost.longestMeasured = Math.max(editorCost.longestMeasured, text.length);
  return text.length;
}
