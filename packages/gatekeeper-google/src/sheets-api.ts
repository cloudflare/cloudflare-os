import type {
  SpreadsheetCellValue, SpreadsheetInfo, SpreadsheetInputMode, SpreadsheetRange,
  SpreadsheetValueMode,
} from "./sheets-types";
import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";

const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const MAX_RANGES = 20;
const MAX_TOTAL_CELLS = 50_000;
const MAX_WRITE_BYTES = 100 * 1024;
const MAX_RANGE_LENGTH = 500;
// Bound the encoded JSON before decoding and parsing.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

type GoogleErrorResponse = {
  error?: { message?: string };
};

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

export function validateRange(range: string): ValidatedRange {
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

export function validateWrite(
  range: string,
  values: SpreadsheetCellValue[][],
  requireExactShape: boolean,
): { values: SpreadsheetCellValue[][]; cellCount: number } {
  let validatedRange = validateRange(range);
  if (!Array.isArray(values) || values.length === 0 || values.length > validatedRange.rows) {
    throw new Error(
      `A write to ${validatedRange.range} requires between 1 and ${validatedRange.rows} row(s).`,
    );
  }
  let width = values[0]?.length ?? 0;
  if (width === 0 || width > validatedRange.columns) {
    throw new Error(
      `A write to ${validatedRange.range} requires between 1 and ` +
      `${validatedRange.columns} column(s).`,
    );
  }
  if (values.some(row => !Array.isArray(row) || row.length !== width)) {
    throw new Error("Google Sheets writes require a rectangular value matrix.");
  }
  if (requireExactShape &&
      (values.length !== validatedRange.rows || width !== validatedRange.columns)) {
    throw new Error(
      `updateRange values must exactly fill ${validatedRange.range} ` +
      `(${validatedRange.rows} row(s) by ${validatedRange.columns} column(s)).`,
    );
  }
  let cellCount = values.length * width;
  if (cellCount > MAX_TOTAL_CELLS) {
    throw new Error(`A write may contain at most ${MAX_TOTAL_CELLS.toLocaleString()} cells.`);
  }
  for (let row of values) {
    for (let value of row) normalizeCell(value);
  }
  let encodedBytes = new TextEncoder().encode(JSON.stringify(values)).byteLength;
  if (encodedBytes > MAX_WRITE_BYTES) {
    throw new Error(
      `A staged write may contain at most ${MAX_WRITE_BYTES.toLocaleString()} encoded bytes. ` +
      "Split this change into smaller approval actions.",
    );
  }
  return { values, cellCount };
}

function valueInputOption(mode: SpreadsheetInputMode | undefined): string {
  switch (mode ?? "raw") {
    case "raw": return "RAW";
    case "userEntered": return "USER_ENTERED";
    default: throw new Error(`Unknown Google Sheets input mode: ${String(mode)}`);
  }
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

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  let contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    let declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Google Sheets response exceeded the ${maxBytes}-byte limit.`);
    }
  }

  if (!response.body) return "";
  let reader = response.body.getReader();
  let chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      let { done, value } = await reader.read();
      if (done) break;
      if (totalBytes + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Google Sheets response exceeded the ${maxBytes}-byte limit.`);
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  let bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (let chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export class GoogleSheetsApi {
  constructor(private getAccessToken: AccessTokenProvider) {}

  async #request<T>(url: URL, init: RequestInit = {}): Promise<T> {
    let response = await fetchWithAuthRetry(
      url.toString(), init, this.getAccessToken, { timeoutMs: REQUEST_TIMEOUT_MS },
    );

    let text: string;
    try {
      text = await readResponseText(
        response, response.ok ? MAX_RESPONSE_BYTES : MAX_ERROR_RESPONSE_BYTES,
      );
    } catch (error) {
      if (!response.ok) {
        throw new Error(
          `Google Sheets request failed [http=${response.status}]`, { cause: error },
        );
      }
      throw error;
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new Error(`Google Sheets request failed [http=${response.status}]`);
      }
      throw new Error("Google Sheets returned an invalid JSON response.");
    }

    if (!response.ok) {
      let errorBody = body as GoogleErrorResponse;
      let detail = errorBody?.error?.message ? `: ${errorBody.error.message}` : "";
      throw new Error(`Google Sheets request failed [http=${response.status}]${detail}`);
    }
    return body as T;
  }

  async getSpreadsheet(spreadsheetId: string): Promise<SpreadsheetInfo> {
    let url = new URL(`${API_BASE}/${encodeURIComponent(spreadsheetId)}`);
    url.searchParams.set(
      "fields",
      "spreadsheetId,properties(title,locale,timeZone)," +
      "sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount)))",
    );
    let result = await this.#request<RestSpreadsheet>(url);
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

    let result = await this.#request<{ valueRanges?: RestValueRange[] }>(url);
    let returned = result.valueRanges ?? [];
    return validated.map((range, index) => normalizeRange(returned[index] ?? {}, range));
  }

  async updateRange(
    spreadsheetId: string,
    range: string,
    values: SpreadsheetCellValue[][],
    inputMode?: SpreadsheetInputMode,
  ): Promise<void> {
    validateWrite(range, values, true);
    let url = new URL(
      `${API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
    );
    url.searchParams.set("valueInputOption", valueInputOption(inputMode));
    await this.#request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ range, majorDimension: "ROWS", values }),
    });
  }

  async appendRows(
    spreadsheetId: string,
    range: string,
    values: SpreadsheetCellValue[][],
    inputMode?: SpreadsheetInputMode,
  ): Promise<void> {
    validateWrite(range, values, false);
    let url = new URL(
      `${API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append`,
    );
    url.searchParams.set("valueInputOption", valueInputOption(inputMode));
    url.searchParams.set("insertDataOption", "INSERT_ROWS");
    await this.#request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ range, majorDimension: "ROWS", values }),
    });
  }
}
