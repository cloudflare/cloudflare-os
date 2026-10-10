import type {
  GoogleSpreadsheetReadSession, SheetBorder, SheetColor, SheetNumberFormat,
} from "./sheets-read-types";
export type * from "./sheets-read-types";

/**
 * A value to enter in a cell. A string starting with `=` is a formula; any other string is text
 * exactly as given, never read as a number or date. `null` clears the cell; an empty string is
 * refused in its favour, as is a number that is not finite.
 */
export type SheetCellInput = string | number | boolean | null;

/**
 * A sheet a change acts on: its ID (`SpreadsheetSheetInfo.id`), or the `ref` an earlier change in
 * the same batch gave the sheet it adds.
 */
export type SheetTarget = number | string;

/**
 * Formatting to set on every cell of a range, as `SheetCellFormat` names it. A field given is set,
 * `null` resets it to the default, and a field left out is kept. At least one field is given.
 */
export type SheetFormatChange = {
  bold?: boolean | null;
  italic?: boolean | null;
  underline?: boolean | null;
  strikethrough?: boolean | null;
  /** Font size in points: an integer from 1 to 400. */
  fontSize?: number | null;
  textColor?: SheetColor | null;
  /** Background colour. */
  fillColor?: SheetColor | null;
  /**
   * How numbers, dates and times display. A pattern holds 1 to 200 characters and no control
   * characters; leave it out for the type's default.
   */
  numberFormat?: SheetNumberFormat | null;
  horizontalAlignment?: "LEFT" | "CENTER" | "RIGHT" | null;
  verticalAlignment?: "TOP" | "MIDDLE" | "BOTTOM" | null;
  /** Whether text too long for a cell overflows into empty neighbours, wraps, or is cut off. */
  wrap?: "OVERFLOW" | "WRAP" | "CLIP" | null;
  /** Borders to draw, or with `null` remove. At least one is given. */
  borders?: {
    /** Along the range's top edge. */
    top?: SheetBorder | null;
    /** Along the range's bottom edge. */
    bottom?: SheetBorder | null;
    /** Along the range's left edge. */
    left?: SheetBorder | null;
    /** Along the range's right edge. */
    right?: SheetBorder | null;
    /** Between each two rows of the range. */
    innerHorizontal?: SheetBorder | null;
    /** Between each two columns of the range. */
    innerVertical?: SheetBorder | null;
  };
};

/** One change to a spreadsheet's cells, rows, columns or sheets. */
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
    }
  /** Format every cell of a range, keeping its contents. */
  | {
      op: "formatCells";
      /** A bounded A1 range that names its sheet, such as `'Sales 2026'!A1:C3`. */
      range: string;
      /** What to set or reset. */
      format: SheetFormatChange;
    }
  /** Add an empty sheet. */
  | {
      op: "addSheet";
      /** Its title: 1 to 100 characters, and no other sheet's, ignoring case. */
      title: string;
      /** A name later changes in the batch pass as `sheetId` to act on this sheet. */
      ref?: string;
      /** Its 0-based position among all sheets, hidden ones included. Last by default. */
      index?: number;
      /** Its number of rows: 1,000 by default, as in Google Sheets. */
      rowCount?: number;
      /** Its number of columns: 26 by default, as in Google Sheets. */
      columnCount?: number;
    }
  /** Give a sheet another title. */
  | {
      op: "renameSheet";
      /** The sheet renamed. */
      sheetId: SheetTarget;
      /** The new title: 1 to 100 characters, and no other sheet's, ignoring case. */
      title: string;
    }
  /** Copy a sheet and its contents, the changes queued to it included. */
  | {
      op: "duplicateSheet";
      /** The sheet copied. */
      sheetId: SheetTarget;
      /** The copy's title: `Copy of <title>` by default. */
      title?: string;
      /** A name later changes in the batch pass as `sheetId` to act on the copy. */
      ref?: string;
      /**
       * The copy's 0-based position among all sheets, hidden ones included. Right after the sheet
       * copied by default.
       */
      index?: number;
    }
  /**
   * Delete a sheet and everything on it. The spreadsheet's last visible sheet cannot be deleted,
   * nor, here, a sheet of more than 50,000 cells: delete that one in Google Sheets.
   */
  | {
      op: "deleteSheet";
      /** The sheet deleted. */
      sheetId: SheetTarget;
    }
  /** Insert empty rows, formatted as the row before them (before row 1, as the row after). */
  | {
      op: "insertRows";
      /** The sheet the rows are inserted in. */
      sheetId: SheetTarget;
      /** The 1-based row the new rows go before; the sheet's row count plus 1 adds them at the end. */
      at: number;
      /** How many rows: 1 to 1,000, 1 by default. */
      count?: number;
    }
  /** Delete rows and their contents. A sheet keeps at least one row. */
  | {
      op: "deleteRows";
      /** The sheet the rows are deleted from. */
      sheetId: SheetTarget;
      /** The 1-based first row deleted. */
      at: number;
      /** How many rows, 1 by default. */
      count?: number;
    }
  /** Insert empty columns, formatted as the column before them (before column A, as the column after). */
  | {
      op: "insertColumns";
      /** The sheet the columns are inserted in. */
      sheetId: SheetTarget;
      /**
       * The letters of the column the new columns go before, such as `"C"`; those of the column
       * after the last add them at the end.
       */
      at: string;
      /** How many columns: 1 to 1,000, 1 by default. */
      count?: number;
    }
  /** Delete columns and their contents. A sheet keeps at least one column. */
  | {
      op: "deleteColumns";
      /** The sheet the columns are deleted from. */
      sheetId: SheetTarget;
      /** The letters of the first column deleted, such as `"C"`. */
      at: string;
      /** How many columns, 1 by default. */
      count?: number;
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
   * Queue changes as one approval, applied in order, together or not at all. Each change acts on
   * the spreadsheet as the changes before it leave it: a range names its sheet by title, including
   * a title an earlier change gives a sheet it adds or renames, and its cells are those of the
   * sheet once earlier changes have inserted or deleted rows and columns. A change acting on a
   * sheet the batch adds passes the `ref` that change gave it as `sheetId`. Returns each such ref
   * mapped to the ID of the sheet it names, the ID the sheet will have in the spreadsheet.
   *
   * The user may let a batch apply without asking only when it enters literal values and clears
   * ranges, or, as "Sheet formatting", when it only formats cells with `formatCells`; a batch with
   * any formula, any change to rows, columns or sheets, or formatting together with any other
   * change, waits for approval. Formulas calling `IMPORTRANGE`, which reads another spreadsheet,
   * or `IMPORTDATA`, `IMPORTHTML`, `IMPORTXML`, `IMPORTFEED` or `IMAGE`, which make Google fetch a
   * URL, are refused.
   *
   * A batch makes at most 50 changes, a change addresses at most 10,000 cells and a batch 20,000,
   * and a cell holds at most 50,000 characters. A batch may overwrite or delete at most 50,000
   * cells that are already there. The batch as queued, values included, must also fit in 100 KiB,
   * about 50,000 characters of text in all. Changes writing or formatting outside a sheet's grid,
   * or in a range the connected account may not edit, are refused, queuing nothing, as is any
   * change to the rows, columns or tab of a sheet holding a range the account may not edit.
   *
   * Reads show queued changes as entered: formula reads show a queued formula as its text, and raw
   * reads show queued literal values. A queued formula's result, and in formatted reads a queued
   * number or boolean, read `null` and are listed in `pendingCells` until the change applies.
   * Formulas elsewhere keep showing their saved results. Google tidies the references in a
   * formula, upper-casing columns and quoting sheet titles its own way; the formula is shown
   * already tidied.
   *
   * Queued changes to rows, columns and sheets show in reads too: `getSpreadsheet()` lists the
   * sheets as they leave them, cells read where those changes move them, and cells of inserted rows,
   * columns and added sheets read blank. Formulas read as Google rewrites them. A saved formula's
   * result reads `null` and is listed in `pendingCells` when a queued change alters the cells one
   * of its references covers (growing, shrinking or deleting them, or deleting their sheet), or
   * when it uses `ROW`, `COLUMN`, `ROWS`, `COLUMNS`, `OFFSET`, `INDIRECT`, `ADDRESS`, `CELL`,
   * `SHEET`, `SHEETS`, `FORMULATEXT`, `LAMBDA`, `LET` or a named range.
   *
   * Queued formatting shows in `readFormats()`, merged over what each cell has; a border along a
   * range's outer edge also removes the facing border of the cell beside it, as Google does. The
   * formatting of inserted rows and columns reads `null` and is listed in `pendingCells`, as Google
   * decides it. In formatted reads, a cell whose number format a queued change sets or resets reads
   * `null` and is listed in `pendingCells`, unless a queued change leaves it empty. Formatting is applied as queued, over any formatting a collaborator gives the cells in
   * the meantime.
   */
  updateSheet(changes: SheetChange[]): Promise<Record<string, number>>;
}
