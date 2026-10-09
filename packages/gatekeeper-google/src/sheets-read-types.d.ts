/** A value returned from a Google Sheets cell. */
export type SpreadsheetCellValue = string | number | boolean | null;

/** Metadata about one worksheet in the connected spreadsheet. */
export type SpreadsheetSheetInfo = {
  /** Stable numeric worksheet ID. */
  id: number;
  /** Worksheet title shown on its tab. */
  title: string;
  /** Zero-based worksheet position. */
  index: number;
  /** Number of rows currently allocated to the worksheet. */
  rowCount: number;
  /** Number of columns currently allocated to the worksheet. */
  columnCount: number;
  /** Whether the worksheet is hidden. */
  hidden?: boolean;
};

/** Metadata about the connected spreadsheet. */
export type SpreadsheetInfo = {
  /** Stable Google spreadsheet ID. */
  id: string;
  /** Spreadsheet title. */
  title: string;
  /** Spreadsheet locale, such as `en_US`. */
  locale?: string;
  /** Spreadsheet time zone, such as `America/Los_Angeles`. */
  timeZone?: string;
  /** Worksheets in display order. */
  sheets: SpreadsheetSheetInfo[];
  /**
   * The first queued change that no longer applies. It and the changes queued after it are not
   * shown.
   */
  queuedChangeConflict?: string;
};

/** How values read from cells should be represented. */
export type SpreadsheetValueMode =
  /** Values formatted as they appear in Google Sheets. This is the default. */
  | "formatted"
  /** Underlying numbers, strings, and booleans. Dates and times are serial numbers. */
  | "raw"
  /** Formula text for formula cells and ordinary values for other cells. */
  | "formula";

/** Values read from one rectangular range. */
export type SpreadsheetRange = {
  /** Canonical A1 range returned by Google Sheets. */
  range: string;
  /** Rectangular rows of values. Blank cells are `null`. */
  values: SpreadsheetCellValue[][];
  /**
   * A1 names (no sheet, such as `B3`) of cells in this range whose value is not known until queued
   * changes apply, such as a queued formula's result. They read `null`.
   */
  pendingCells?: string[];
  /**
   * The first queued change that no longer applies. It and the changes queued after it are not
   * shown.
   */
  queuedChangeConflict?: string;
};

/**
 * Read-only access to one Google spreadsheet. With changes queued, reads show them as entered (see
 * `pendingCells`).
 */
export interface GoogleSpreadsheetReadSession {
  /** Return spreadsheet metadata and its worksheet list. */
  getSpreadsheet(): Promise<SpreadsheetInfo>;

  /**
   * Read a bounded A1 range, such as `'Sales 2026'!A1:F200`.
   * Whole-row, whole-column, named, and unbounded ranges are not accepted. The read throws if the
   * response exceeds 5 MiB; request a smaller range when cells contain large values.
   */
  readRange(
    range: string,
    options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange>;

  /**
   * Read several bounded A1 ranges in one request. At most 20 ranges and 50,000 total cells may
   * be requested at once. The combined response must not exceed 5 MiB.
   */
  readRanges(
    ranges: string[],
    options?: { valueMode?: SpreadsheetValueMode },
  ): Promise<SpreadsheetRange[]>;
}
