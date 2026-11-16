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
  /** UTF-16 units of the JSON built whole to be digested for a batch's guard. */
  digestedUnits: number;
  /** Slides, masters and layouts copied whole with `structuredClone`. */
  pageClones: number;
};

/** The running totals of `EditorCost`. */
export const editorCost: EditorCost = {
  overlayCopies: 0, overlayEntries: 0, keysIndexed: 0, cellsKeyed: 0, digestedUnits: 0,
  pageClones: 0,
};
