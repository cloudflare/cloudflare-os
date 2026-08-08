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
};

/** How values written to cells should be interpreted. */
export type SpreadsheetInputMode =
  /** Store values exactly as supplied. */
  | "raw"
  /** Parse values as if an employee entered them in Google Sheets. */
  | "userEntered";

/** A bounded write that is waiting in the Company OS action queue. */
export type SpreadsheetPendingWrite = {
  /** Gatekeeper-local action identifier used by the action queue. */
  actionId: number;
  /** Canonical operation staged for approval. */
  operation: "updateRange" | "appendRows";
  /** A1 range affected by the write. */
  range: string;
  /** Number of cells supplied by the caller. */
  cellCount: number;
};

/** Read and approval-gated write access to one selected Google spreadsheet. */
export interface GoogleSpreadsheetSession {
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

  /**
   * Stage replacement values for one bounded A1 range. The write stays pending until a person
   * approves its Company OS action card. The value matrix must fit the declared range exactly and
   * remain within the 100 KiB staged-action limit.
   */
  updateRange(
    range: string,
    values: SpreadsheetCellValue[][],
    options?: { inputMode?: SpreadsheetInputMode },
  ): Promise<SpreadsheetPendingWrite>;

  /**
   * Stage rows to append after the current table in a bounded A1 range. The write stays pending
   * until a person approves its Company OS action card. Split input larger than 100 KiB into
   * separate approval actions.
   */
  appendRows(
    range: string,
    values: SpreadsheetCellValue[][],
    options?: { inputMode?: SpreadsheetInputMode },
  ): Promise<SpreadsheetPendingWrite>;
}

/** Metadata about one file in the connected Google Drive folder. */
export type DriveFileInfo = {
  /** Stable Google Drive file ID. */
  id: string;
  /** File name shown in Google Drive. */
  name: string;
  /** Google Drive MIME type. */
  mimeType: string;
  /** File size in bytes when Google supplies it. Native Google files do not have a byte size. */
  size?: number;
  /** Last modification time. */
  modifiedTime?: Date;
  /** URL that opens the file in Google Drive. */
  webViewLink?: string;
};

/** Metadata about the connected Google Drive folder. */
export type DriveFolderInfo = {
  /** Stable Google Drive folder ID. */
  id: string;
  /** Folder name shown in Google Drive. */
  name: string;
  /** URL that opens the folder in Google Drive. */
  webViewLink: string;
};

/** File data staged for upload after Company OS approval. */
export type DriveUploadInput = {
  /** File name, including a useful extension. */
  name: string;
  /** MIME type of the supplied bytes. */
  mimeType: string;
  /** Standard base64-encoded file bytes. Maximum decoded size: 10 MiB. */
  base64: string;
  /** Convert textual input to a native Google Doc instead of keeping the source MIME type. */
  convertToGoogleDoc?: boolean;
};

/** An upload that is waiting in the Company OS action queue. */
export type DrivePendingUpload = {
  /** Gatekeeper-local action identifier used by the action queue. */
  actionId: number;
  /** File name shown on the action card. */
  name: string;
  /** Decoded upload size in bytes. */
  bytes: number;
};

/** Durable state for one staged Drive upload. */
export type DriveUploadStatus = {
  /** Gatekeeper-local action identifier. */
  actionId: number;
  /** Current upload state. */
  state: "pending" | "applying" | "completed" | "rejected" | "failed";
  /** Uploaded file metadata after successful approval and completion. */
  file?: DriveFileInfo;
  /** Failure detail when the outcome is known to have failed. */
  error?: string;
};

/** Read and approval-gated upload access to one employee-selected Google Drive folder. */
export interface GoogleDriveFolderSession {
  /** Return metadata for the connected folder. */
  getFolder(): Promise<DriveFolderInfo>;

  /** List the most recently modified files directly inside the connected folder. */
  listFiles(options?: { limit?: number }): Promise<DriveFileInfo[]>;

  /** Stage one file upload. The upload cannot run until a person approves its action card. */
  uploadFile(input: DriveUploadInput): Promise<DrivePendingUpload>;

  /** Read durable pending, completed, rejected, or failed state for a staged upload. */
  getUpload(actionId: number): Promise<DriveUploadStatus>;
}
