import type { GoogleSpreadsheetReadSession } from "./sheets-read-types";
export type * from "./sheets-read-types";

/**
 * A value to enter in a cell. A string starting with `=` is a formula; any other string is text
 * exactly as given, never read as a number or date. `null` clears the cell; an empty string is
 * refused in its favour, as is a number that is not finite.
 */
export type SheetCellInput = string | number | boolean | null;

/** One change to a spreadsheet's cells. */
export type SheetChange =
  /** Enter values in every cell of a range. */
  | {
      op: "writeCells";
      /** A bounded A1 range that names its sheet, such as `'Sales 2026'!A1:C3`. */
      range: string;
      /** One array per row of the range, each with one value per column: exactly its shape. */
      values: SheetCellInput[][];
    }
  /** Clear the contents of every cell of a range, keeping their formatting. */
  | {
      op: "clearRange";
      /** A bounded A1 range that names its sheet, such as `'Sales 2026'!A1:C3`. */
      range: string;
    };

/**
 * Read/write access to one directly bound Google spreadsheet.
 *
 * Changes are queued for the user's approval, and reads show them as entered until they are
 * decided. A queued change that no longer applies, because the spreadsheet was edited elsewhere,
 * fails when approved, and reads report it in `queuedChangeConflict`.
 */
export interface GoogleSpreadsheetSession extends GoogleSpreadsheetReadSession {
  /**
   * Queue changes as one approval, applied in order, together or not at all. Returns `{}`.
   *
   * The user may let a batch apply without asking only when it enters literal values and clears
   * ranges; a batch with any formula waits for approval. Formulas calling `IMPORTRANGE`, which
   * reads another spreadsheet, or `IMPORTDATA`, `IMPORTHTML`, `IMPORTXML`, `IMPORTFEED` or
   * `IMAGE`, which make Google fetch a URL, are refused.
   *
   * A batch makes at most 50 changes, a change addresses at most 10,000 cells and a batch 20,000,
   * and a cell holds at most 50,000 characters. The batch as queued, values included, must also
   * fit in 100 KiB, about 50,000 characters of text in all. Changes writing outside a sheet's grid, or into a
   * range the connected account may not edit, are refused, queuing nothing.
   *
   * Reads show queued changes as entered: formula reads show a queued formula as its text, and raw
   * reads show queued literal values. A queued formula's result, and in formatted reads a queued
   * number or boolean, read `null` and are listed in `pendingCells` until the change applies.
   * Formulas elsewhere keep showing their saved results. Google tidies the references in a
   * formula, upper-casing columns and quoting sheet titles its own way; the formula is shown
   * already tidied.
   */
  updateSheet(changes: SheetChange[]): Promise<Record<string, number>>;
}
