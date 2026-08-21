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
    /^(?:(?:'(?:[^']|'')+'|[^'!]+)!)?\$?([A-Za-z]{1,3})\$?([1-9]\d*)(?::\$?([A-Za-z]{1,3})\$?([1-9]\d*))?$/,
  );
  if (!match) {
    throw new Error(
      `Invalid or unbounded A1 range "${range}". Use a bounded range such as ` +
      "`'Sheet name'!A1:F200`.",
    );
  }

  let startColumn = columnNumber(match[1]);
  let startRow = Number(match[2]);
  let endColumn = columnNumber(match[3] ?? match[1]);
  let endRow = Number(match[4] ?? match[2]);
  if (endColumn < startColumn || endRow < startRow) {
    throw new Error(`A1 range "${range}" must run from its top-left cell to its bottom-right cell.`);
  }

  let rows = endRow - startRow + 1;
  let columns = endColumn - startColumn + 1;
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns)) {
    throw new Error(`A1 range "${range}" is too large.`);
  }
  return { range, rows, columns };
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
export class GoogleSheetsApi {
  constructor(private getAccessToken: AccessTokenProvider) {}

  async #request<T>(url: URL, operation: string): Promise<T> {
    let response = await fetchWithAuthRetry(
      url.toString(), {}, this.getAccessToken, { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    return readGoogleJson<T>(response, {
      provider: "Google Sheets", operation, maxBytes: MAX_RESPONSE_BYTES,
    });
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
