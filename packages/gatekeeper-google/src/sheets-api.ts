import type {
  SpreadsheetCellValue, SpreadsheetFormats, SpreadsheetInfo, SpreadsheetRange, SpreadsheetSheetInfo,
  SpreadsheetValueMode,
} from "./sheets-read-types";
import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";
import { readGoogleJson } from "./google-response";
import {
  baseFormats, FORMAT_READ_FIELDS, type BaseFormats, type RestFormatSheet,
} from "./sheets-format";
import {
  a1Of, cellCount, findSheet, parseRange, validateRange, type Rect, type ValidatedRange,
} from "./sheets-model";

const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const MAX_RANGES = 20;
const MAX_TOTAL_CELLS = 50_000;
const MAX_FORMAT_CELLS = 10_000;
// Bound the encoded JSON before decoding and parsing.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

const SPREADSHEET_FIELDS = "spreadsheetId,properties(title,locale,timeZone)";
const SHEET_PROPERTIES_FIELDS =
  "properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount))";
// Google keeps at least one unfrozen row and column, so the gatekeeper needs the frozen counts too.
const METADATA_PROPERTIES_FIELDS =
  "properties(sheetId,title,index,hidden," +
  "gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount))";
// Never `editors`: it lists collaborators' email addresses.
const PROTECTED_RANGE_FIELDS =
  "protectedRanges(range,unprotectedRanges,requestingUserCanEdit,warningOnly)";

/** A `GridRange`. Google omits each index that is 0, and an end that is unbounded. */
type RestGridRange = {
  sheetId?: number;
  startRowIndex?: number;
  endRowIndex?: number;
  startColumnIndex?: number;
  endColumnIndex?: number;
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
      gridProperties?: {
        rowCount?: number; columnCount?: number; frozenRowCount?: number; frozenColumnCount?: number;
      };
    };
    protectedRanges?: {
      range?: RestGridRange;
      unprotectedRanges?: RestGridRange[];
      requestingUserCanEdit?: boolean;
      warningOnly?: boolean;
    }[];
  }[];
};

type RestValueRange = {
  range?: string;
  values?: unknown[][];
};

/** Cells of one sheet. An end Google leaves unbounded is `Infinity`. */
export type SheetArea = { sheetId: number; rect: Rect };

/** A protected range: the cells it covers, less those it leaves editable. */
export type SheetProtection = {
  area: SheetArea;
  unprotected: SheetArea[];
  /** Whether the connected account may edit its cells. */
  requestingUserCanEdit: boolean;
  /** Whether it only warns before an edit, rather than refusing one. */
  warningOnly: boolean;
};

/** A spreadsheet's metadata, with each sheet's protected ranges. */
export type SpreadsheetMetadata = Omit<SpreadsheetInfo, "sheets"> & {
  /** The sheets, with how many of their leading rows and columns are frozen, when any are. */
  sheets: (SpreadsheetSheetInfo & { frozenRowCount?: number; frozenColumnCount?: number })[];
  protectedRanges: SheetProtection[];
};

/** A `batchUpdate` Google answered with a 4xx status, so it applied none of the requests. */
export class SheetsWriteRefused extends Error {
  constructor(readonly status: number) {
    super(`Google Sheets refused the update [http=${status}]`);
  }
}

/**
 * Checks the ranges a read asks for: 1 to 20 bounded A1 ranges, of at most 50,000 cells in all.
 * Throws `Error`.
 */
export function validateRanges(ranges: string[]): ValidatedRange[] {
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

/**
 * Checks the range a format read asks for: a bounded A1 range of at most 10,000 cells. Throws
 * `Error`.
 */
export function parseFormatRange(range: string): { sheet?: string; rect: Rect } {
  let parsed = parseRange(range);
  if (cellCount(parsed.rect) > MAX_FORMAT_CELLS) {
    throw new Error(`readFormats may request at most ${MAX_FORMAT_CELLS.toLocaleString("en-US")} cells.`);
  }
  return parsed;
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

function normalizeRange(
  rest: RestValueRange, requested: { range: string; rows: number; columns: number },
): SpreadsheetRange {
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

function spreadsheetInfo(result: RestSpreadsheet): SpreadsheetInfo {
  return {
    id: result.spreadsheetId,
    title: result.properties?.title ?? "Untitled spreadsheet",
    ...(result.properties?.locale ? { locale: result.properties.locale } : {}),
    ...(result.properties?.timeZone ? { timeZone: result.properties.timeZone } : {}),
    sheets: (result.sheets ?? []).flatMap((sheet): SpreadsheetSheetInfo[] => {
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

// A range with no bounds covers the whole sheet it is listed under.
function areaOf(range: RestGridRange | undefined, sheetId: number): SheetArea {
  return {
    sheetId: range?.sheetId ?? sheetId,
    rect: {
      startRow: range?.startRowIndex ?? 0,
      endRow: range?.endRowIndex ?? Infinity,
      startColumn: range?.startColumnIndex ?? 0,
      endColumn: range?.endColumnIndex ?? Infinity,
    },
  };
}

// Whether Google's echo of a data filter's `GridRange`, which leaves out its zero fields, is
// `area`'s.
function echoes(echoed: RestGridRange | undefined, { sheetId, rect }: SheetArea): boolean {
  return (echoed?.sheetId ?? 0) === sheetId &&
    (echoed?.startRowIndex ?? 0) === rect.startRow && (echoed?.endRowIndex ?? 0) === rect.endRow &&
    (echoed?.startColumnIndex ?? 0) === rect.startColumn &&
    (echoed?.endColumnIndex ?? 0) === rect.endColumn;
}

/** The Google Sheets API, as far as the gatekeeper uses it. */
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
    url.searchParams.set("fields", `${SPREADSHEET_FIELDS},sheets(${SHEET_PROPERTIES_FIELDS})`);
    return spreadsheetInfo(await this.#request<RestSpreadsheet>(url, "get spreadsheet"));
  }

  /** A spreadsheet's metadata and the ranges it protects, but not who may edit them. */
  async getMetadata(spreadsheetId: string): Promise<SpreadsheetMetadata> {
    let url = new URL(`${API_BASE}/${encodeURIComponent(spreadsheetId)}`);
    url.searchParams.set(
      "fields", `${SPREADSHEET_FIELDS},sheets(${METADATA_PROPERTIES_FIELDS},${PROTECTED_RANGE_FIELDS})`);
    let result = await this.#request<RestSpreadsheet>(url, "get spreadsheet metadata");
    let protectedRanges = (result.sheets ?? []).flatMap(sheet => {
      let sheetId = sheet.properties?.sheetId;
      if (sheetId === undefined) return [];
      return (sheet.protectedRanges ?? []).map(protection => ({
        area: areaOf(protection.range, sheetId),
        unprotected: (protection.unprotectedRanges ?? []).map(range => areaOf(range, sheetId)),
        requestingUserCanEdit: protection.requestingUserCanEdit === true,
        warningOnly: protection.warningOnly === true,
      }));
    });
    let info = spreadsheetInfo(result);
    let frozen = new Map((result.sheets ?? []).map(({ properties }) =>
      [properties?.sheetId, properties?.gridProperties] as const));
    let sheets = info.sheets.map(sheet => {
      let { frozenRowCount, frozenColumnCount } = frozen.get(sheet.id) ?? {};
      return {
        ...sheet,
        ...(frozenRowCount ? { frozenRowCount } : {}),
        ...(frozenColumnCount ? { frozenColumnCount } : {}),
      };
    });
    return { ...info, sheets, protectedRanges };
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

  /**
   * The cells of each of `areas` as `valueMode` reads them, padded to its size: in formula mode,
   * as entered, formulas as their text. Each must lie within its sheet's grid. Only the response
   * size bounds the read, so callers bound how many cells they ask for.
   */
  async readAreas(
    spreadsheetId: string, areas: readonly SheetArea[], valueMode: SpreadsheetValueMode,
  ): Promise<SpreadsheetCellValue[][][]> {
    if (areas.length === 0) return [];
    let response = await fetchWithAuthRetry(
      `${API_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchGetByDataFilter`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataFilters: areas.map(({ sheetId, rect }) => ({
            gridRange: {
              sheetId,
              startRowIndex: rect.startRow,
              endRowIndex: rect.endRow,
              startColumnIndex: rect.startColumn,
              endColumnIndex: rect.endColumn,
            },
          })),
          majorDimension: "ROWS",
          valueRenderOption: valueRenderOption(valueMode),
          ...(valueMode === "raw" ? { dateTimeRenderOption: "SERIAL_NUMBER" } : {}),
        }),
      },
      // A read, however it is sent.
      this.getAccessToken, { timeoutMs: REQUEST_TIMEOUT_MS, idempotent: true },
    );
    let result = await readGoogleJson<{
      valueRanges?: { valueRange?: RestValueRange; dataFilters?: { gridRange?: RestGridRange }[] }[];
    }>(response, { provider: "Google Sheets", operation: "read cells", maxBytes: MAX_RESPONSE_BYTES });
    // Google answers in an order of its own, so each answer is found by the filter it echoes.
    let returned = result.valueRanges ?? [];
    return areas.map(area => {
      let answer = returned.find(({ dataFilters }) => echoes(dataFilters?.[0]?.gridRange, area));
      if (!answer) throw new Error("Google Sheets did not return every range it was asked for.");
      let { rect } = area;
      return normalizeRange(answer.valueRange ?? {}, {
        range: "", rows: rect.endRow - rect.startRow, columns: rect.endColumn - rect.startColumn,
      }).values;
    });
  }

  /**
   * The formatting of a bounded A1 range of at most 10,000 cells, padded to its size. It is read
   * with `spreadsheets.get`, which a read-only grant allows.
   */
  async readFormats(spreadsheetId: string, range: string): Promise<SpreadsheetFormats> {
    let { sheet: name, rect } = parseFormatRange(range);
    let url = new URL(`${API_BASE}/${encodeURIComponent(spreadsheetId)}`);
    url.searchParams.append("ranges", range);
    url.searchParams.set("fields", FORMAT_READ_FIELDS);
    // Each colour comes back in two forms, so a pretty-printed answer reaches the size cap early.
    url.searchParams.set("prettyPrint", "false");
    let result = await this.#request<{ sheets?: RestFormatSheet[] }>(url, "read formats");
    let sheets = (result.sheets ?? []).map(sheet => ({
      sheet,
      title: sheet.properties?.title ?? "",
      index: sheet.properties?.index ?? 0,
      hidden: sheet.properties?.hidden,
    }));
    // Google returns the sheet the range is on, which is the first visible one when it names none.
    let found = findSheet(sheets, name)?.sheet;
    if (!found?.properties?.title) {
      throw new Error("Google Sheets did not return the range it was asked for.");
    }
    let formats = baseFormats([found]);
    let sheetId = found.properties.sheetId ?? 0;
    let grid = found.properties.gridProperties;
    let clipped = {
      ...rect,
      endRow: Math.min(rect.endRow, grid?.rowCount ?? rect.endRow),
      endColumn: Math.min(rect.endColumn, grid?.columnCount ?? rect.endColumn),
    };
    return {
      range: a1Of(found.properties.title, clipped),
      formats: Array.from({ length: rect.endRow - rect.startRow }, (_row, r) =>
        Array.from({ length: rect.endColumn - rect.startColumn }, (_column, c) =>
          formats(sheetId, rect.startRow + r, rect.startColumn + c))),
    };
  }

  /**
   * The formatting of the cells of `areas`, each of which must lie within its sheet's grid. They
   * are read by grid range with `spreadsheets:getByDataFilter`, which needs a grant that may edit
   * the spreadsheet. Only the response size bounds the read, so callers bound how many cells they
   * ask for.
   */
  async readFormatAreas(spreadsheetId: string, areas: readonly SheetArea[]): Promise<BaseFormats> {
    if (areas.length === 0) return () => null;
    let url = new URL(`${API_BASE}/${encodeURIComponent(spreadsheetId)}:getByDataFilter`);
    url.searchParams.set("fields", FORMAT_READ_FIELDS);
    // Each colour comes back in two forms, so a pretty-printed answer reaches the size cap early.
    url.searchParams.set("prettyPrint", "false");
    let response = await fetchWithAuthRetry(
      url.toString(),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataFilters: areas.map(({ sheetId, rect }) => ({
            gridRange: {
              sheetId,
              startRowIndex: rect.startRow,
              endRowIndex: rect.endRow,
              startColumnIndex: rect.startColumn,
              endColumnIndex: rect.endColumn,
            },
          })),
          includeGridData: true,
        }),
      },
      // A read, however it is sent.
      this.getAccessToken, { timeoutMs: REQUEST_TIMEOUT_MS, idempotent: true },
    );
    let result = await readGoogleJson<{ sheets?: RestFormatSheet[] }>(response, {
      provider: "Google Sheets", operation: "read formats", maxBytes: MAX_RESPONSE_BYTES,
    });
    let sheets = result.sheets ?? [];
    // Each range's cells are placed by the position Google gives them, whichever order they come
    // in, so a range is answered when its sheet holds data starting where it does.
    let answered = areas.every(({ sheetId, rect }) => sheets.some(sheet =>
      (sheet.properties?.sheetId ?? 0) === sheetId && (sheet.data ?? []).some(data =>
        (data.startRow ?? 0) === rect.startRow && (data.startColumn ?? 0) === rect.startColumn)));
    if (!answered) throw new Error("Google Sheets did not return every range it was asked for.");
    return baseFormats(sheets);
  }

  /** A developer metadata entry's value, or undefined if the spreadsheet has none with that ID. */
  async getDeveloperMetadata(
    spreadsheetId: string, metadataId: number,
  ): Promise<{ metadataValue?: string } | undefined> {
    let url = new URL(
      `${API_BASE}/${encodeURIComponent(spreadsheetId)}/developerMetadata/${metadataId}`);
    url.searchParams.set("fields", "metadataValue");
    let response = await fetchWithAuthRetry(
      url.toString(), {}, this.getAccessToken, { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    return readGoogleJson<{ metadataValue?: string }>(response, {
      provider: "Google Sheets", operation: "get developer metadata", maxBytes: MAX_RESPONSE_BYTES,
    });
  }

  /**
   * Apply `requests` together. Throws `SheetsWriteRefused` for a 4xx answer, which applied
   * nothing; any other failure leaves the outcome unknown, since the update may have been
   * committed before the response was lost.
   */
  async batchUpdate(spreadsheetId: string, requests: unknown[]): Promise<void> {
    let response = await fetchWithAuthRetry(
      `${API_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      },
      this.getAccessToken, { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    if (response.ok) {
      await response.body?.cancel();
      return;
    }
    // Always rejects, having logged Google's diagnostics.
    let failure = await readGoogleJson(response, {
      provider: "Google Sheets", operation: "batch update", maxBytes: MAX_RESPONSE_BYTES,
    }).catch((error: unknown) => error);
    let refused = response.status >= 400 && response.status < 500;
    throw refused ? new SheetsWriteRefused(response.status) : failure;
  }
}

/** The reads a spreadsheet session makes with no change queued. */
export type SpreadsheetReader = Pick<GoogleSheetsApi, "getSpreadsheet" | "readRanges" | "readFormats">;

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
    let { title, rowCount, columnCount } = BLANK_SHEET;
    return validateRanges(ranges).map(range => {
      let { sheet, rect } = parseRange(range.range);
      // Google matches sheet names case-insensitively, as it keeps them unique.
      if (sheet !== undefined && sheet.toLowerCase() !== title.toLowerCase()) {
        throw new Error(
          `No sheet named "${sheet}": a spreadsheet awaiting creation has only "${title}".`);
      }
      if (rect.endRow > rowCount || rect.endColumn > columnCount) {
        throw new Error(`A1 range "${range.range}" exceeds the ${rowCount} rows and ${columnCount} ` +
          `columns of "${title}".`);
      }
      return normalizeRange({}, range);
    });
  }

  /** No cell has formatting. */
  async readFormats(_spreadsheetId: string, range: string): Promise<SpreadsheetFormats> {
    let { title, rowCount, columnCount } = BLANK_SHEET;
    let { sheet, rect } = parseFormatRange(range);
    if (sheet !== undefined && sheet.toLowerCase() !== title.toLowerCase()) {
      throw new Error(`No sheet named "${sheet}": a spreadsheet awaiting creation has only "${title}".`);
    }
    if (rect.endRow > rowCount || rect.endColumn > columnCount) {
      throw new Error(`A1 range "${range}" exceeds the ${rowCount} rows and ${columnCount} columns ` +
        `of "${title}".`);
    }
    return {
      range: a1Of(title, rect),
      formats: Array.from({ length: rect.endRow - rect.startRow }, () =>
        Array.from({ length: rect.endColumn - rect.startColumn }, () => null)),
    };
  }
}
