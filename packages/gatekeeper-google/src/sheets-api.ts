import type {
  SpreadsheetCellValue, SpreadsheetInfo, SpreadsheetRange, SpreadsheetValueMode,
} from "./sheets-types";
import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";
import { readGoogleJson } from "./google-response";

const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const MAX_RANGES = 20;
const MAX_TOTAL_CELLS = 50_000;
const MAX_RANGE_LENGTH = 500;
// Bound the encoded JSON before decoding and parsing.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

type RestSpreadsheet = {
  spreadsheetId: string;
  properties?: { title?: string; locale?: string; timeZone?: string };
  sheets?: {
    properties?: {
      sheetId?: number;
      title?: string;
      index?: number;
      hidden?: boolean;
      gridProperties?: { rowCount?: number; columnCount?: number };
    };
  }[];
};

type RestValueRange = {
  range?: string;
  values?: unknown[][];
};

type ValidatedRange = {
  range: string;
  /** The sheet the range names, unquoted, if it names one. */
  sheet?: string;
  rows: number;
  columns: number;
};

function columnNumber(column: string): number {
  let result = 0;
  for (let character of column.toUpperCase()) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result;
}

function validateRange(range: string): ValidatedRange {
  if (typeof range !== "string" || range.length === 0 || range.length > MAX_RANGE_LENGTH) {
    throw new Error(`A1 ranges must contain between 1 and ${MAX_RANGE_LENGTH} characters.`);
  }

  // A quoted sheet title escapes an apostrophe as two apostrophes. Requiring explicit cell
  // coordinates keeps reads bounded; named, whole-row, and whole-column ranges are rejected.
  let match = range.match(
    /^(?:('(?:[^']|'')+'|[^'!]+)!)?\$?([A-Za-z]{1,3})\$?([1-9]\d*)(?::\$?([A-Za-z]{1,3})\$?([1-9]\d*))?$/,
  );
  if (!match) {
    throw new Error(
      `Invalid or unbounded A1 range "${range}". Use a bounded range such as ` +
      "`'Sheet name'!A1:F200`.",
    );
  }

  let [, sheet, start, startRowText, end = start, endRowText = startRowText] = match;
  let startColumn = columnNumber(start);
  let startRow = Number(startRowText);
  let endColumn = columnNumber(end);
  let endRow = Number(endRowText);
  if (endColumn < startColumn || endRow < startRow) {
    throw new Error(`A1 range "${range}" must run from its top-left cell to its bottom-right cell.`);
  }

  let rows = endRow - startRow + 1;
  let columns = endColumn - startColumn + 1;
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns)) {
    throw new Error(`A1 range "${range}" is too large.`);
  }
  return {
    range, rows, columns,
    ...(sheet && { sheet: sheet.startsWith("'") ? sheet.slice(1, -1).replaceAll("''", "'") : sheet }),
  };
}

function validateRanges(ranges: string[]): ValidatedRange[] {
  if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > MAX_RANGES) {
    throw new Error(`readRanges requires between 1 and ${MAX_RANGES} ranges.`);
  }
  let validated = ranges.map(validateRange);
  let cells = validated.reduce((total, range) => total + range.rows * range.columns, 0);
  if (!Number.isSafeInteger(cells) || cells > MAX_TOTAL_CELLS) {
    throw new Error(`A read may request at most ${MAX_TOTAL_CELLS.toLocaleString()} cells.`);
  }
  return validated;
}

function valueRenderOption(mode: SpreadsheetValueMode | undefined): string {
  switch (mode ?? "formatted") {
    case "formatted": return "FORMATTED_VALUE";
    case "raw": return "UNFORMATTED_VALUE";
    case "formula": return "FORMULA";
    default: throw new Error(`Unknown Google Sheets value mode: ${String(mode)}`);
  }
}

function normalizeCell(value: unknown): SpreadsheetCellValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null || value === undefined) return null;
  throw new Error("Google Sheets returned an unsupported cell value.");
}

function normalizeRange(rest: RestValueRange, requested: ValidatedRange): SpreadsheetRange {
  let source = Array.isArray(rest.values) ? rest.values : [];
  let values = Array.from({ length: requested.rows }, (_row, rowIndex) => {
    let row = Array.isArray(source[rowIndex]) ? source[rowIndex] : [];
    return Array.from(
      { length: requested.columns },
      (_cell, columnIndex) => normalizeCell(row[columnIndex]),
    );
  });
  return { range: rest.range ?? requested.range, values };
}

/** The one sheet a created spreadsheet gets, named here so it doesn't depend on the account's locale. */
const BLANK_SHEET = { sheetId: 0, title: "Sheet1", rowCount: 1000, columnCount: 26 } as const;

export class GoogleSheetsApi {
  constructor(private getAccessToken: AccessTokenProvider) {}

  async #request<T>(url: URL, operation: string, init: RequestInit = {}): Promise<T> {
    let response = await fetchWithAuthRetry(
      url.toString(), init, this.getAccessToken, { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    return readGoogleJson<T>(response, {
      provider: "Google Sheets", operation, maxBytes: MAX_RESPONSE_BYTES,
    });
  }

  /** Create a spreadsheet titled `title` in the caller's My Drive, holding one empty sheet. */
  async createSpreadsheet(title: string): Promise<string> {
    let url = new URL(API_BASE);
    url.searchParams.set("fields", "spreadsheetId");
    let { sheetId, title: sheetTitle, rowCount, columnCount } = BLANK_SHEET;
    let { spreadsheetId } = await this.#request<{ spreadsheetId?: unknown }>(url, "create spreadsheet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        properties: { title },
        sheets: [{ properties: { sheetId, title: sheetTitle, gridProperties: { rowCount, columnCount } } }],
      }),
    });
    if (typeof spreadsheetId !== "string" || spreadsheetId.length === 0) {
      throw new Error("Google Sheets returned no spreadsheet ID");
    }
    return spreadsheetId;
  }

  async getSpreadsheet(spreadsheetId: string): Promise<SpreadsheetInfo> {
    let url = new URL(`${API_BASE}/${encodeURIComponent(spreadsheetId)}`);
    url.searchParams.set(
      "fields",
      "spreadsheetId,properties(title,locale,timeZone)," +
      "sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount)))",
    );
    let result = await this.#request<RestSpreadsheet>(url, "get spreadsheet");
    return {
      id: result.spreadsheetId,
      title: result.properties?.title ?? "Untitled spreadsheet",
      ...(result.properties?.locale ? { locale: result.properties.locale } : {}),
      ...(result.properties?.timeZone ? { timeZone: result.properties.timeZone } : {}),
      sheets: (result.sheets ?? []).flatMap(sheet => {
        let properties = sheet.properties;
        if (properties?.sheetId === undefined || properties.title === undefined) return [];
        return [{
          id: properties.sheetId,
          title: properties.title,
          index: properties.index ?? 0,
          rowCount: properties.gridProperties?.rowCount ?? 0,
          columnCount: properties.gridProperties?.columnCount ?? 0,
          ...(properties.hidden ? { hidden: true } : {}),
        }];
      }).toSorted((a, b) => a.index - b.index),
    };
  }

  async readRanges(
    spreadsheetId: string,
    ranges: string[],
    valueMode?: SpreadsheetValueMode,
  ): Promise<SpreadsheetRange[]> {
    let validated = validateRanges(ranges);
    let url = new URL(`${API_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchGet`);
    for (let range of validated) url.searchParams.append("ranges", range.range);
    url.searchParams.set("majorDimension", "ROWS");
    url.searchParams.set("valueRenderOption", valueRenderOption(valueMode));
    if (valueMode === "raw") url.searchParams.set("dateTimeRenderOption", "SERIAL_NUMBER");

    let result = await this.#request<{ valueRanges?: RestValueRange[] }>(
      url,
      "read ranges",
    );
    let returned = result.valueRanges ?? [];
    return validated.map((range, index) => normalizeRange(returned[index] ?? {}, range));
  }
}

/** The reads a spreadsheet session makes. */
export type SpreadsheetReader = Pick<GoogleSheetsApi, "getSpreadsheet" | "readRanges">;

/**
 * A spreadsheet not yet created, read as the one createSpreadsheet() makes: one empty sheet. Makes
 * no request, and so cannot know the locale and time zone Google will give it.
 */
export class BlankSpreadsheet implements SpreadsheetReader {
  constructor(private title: string) {}

  async getSpreadsheet(spreadsheetId: string): Promise<SpreadsheetInfo> {
    let { sheetId, title, rowCount, columnCount } = BLANK_SHEET;
    return {
      id: spreadsheetId,
      title: this.title,
      sheets: [{ id: sheetId, title, index: 0, rowCount, columnCount }],
    };
  }

  /** Every requested cell is empty. */
  async readRanges(_spreadsheetId: string, ranges: string[]): Promise<SpreadsheetRange[]> {
    return validateRanges(ranges).map(range => {
      // Google matches sheet names case-insensitively, as it keeps them unique.
      if (range.sheet !== undefined && range.sheet.toLowerCase() !== BLANK_SHEET.title.toLowerCase()) {
        throw new Error(
          `No sheet named "${range.sheet}": a spreadsheet awaiting creation has only "${BLANK_SHEET.title}".`);
      }
      return normalizeRange({}, range);
    });
  }
}
