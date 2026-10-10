import { env } from "cloudflare:test";
import { ActionJournal, APPLY_OUTCOME_UNKNOWN_MESSAGE } from "@gadgets/gatekeeper-kit/actions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHEETS_ACTIONS } from "../../src/sheets-actions";
import { GoogleSheetsApi } from "../../src/sheets-api";
import type { RestCellFormat } from "../../src/sheets-format";
import { rewriteFormula, type RewriteStep } from "../../src/sheets-formula";
import { a1Of, parseRange, type Rect } from "../../src/sheets-model";
import type {
  SpreadsheetFormats, SpreadsheetInfo, SpreadsheetRange, SpreadsheetValueMode,
} from "../../src/sheets-read-types";
import type { SheetMeta, SheetsAction } from "../../src/sheets-simulation";
import type { SheetCellInput, SheetChange } from "../../src/sheets-types";
import { protectedRange, sheet as sheetMeta, spreadsheetMetadata, type FixtureGridRange } from "../sheets-fixture";

type BatchRequest = Record<string, any>;

class Invalid extends Error {}

/** A sheet of the fake spreadsheet, and the ranges it protects. */
type ProviderSheet = SheetMeta & { protectedRanges?: ReturnType<typeof protectedRange>[] };

/** What a batch changes, committed only if every request applies. */
type ProviderState = {
  cells: Map<string, SheetCellInput>;
  formats: Map<string, RestCellFormat>;
  markers: Map<number, { metadataKey: string; metadataValue: string }>;
  sheets: ProviderSheet[];
};

const key = (sheetId: number, row: number, column: number) => `${sheetId}:${row}:${column}`;

const MAX_SHEET_ID = 2 ** 31 - 1;

const CHANGED = "This change no longer applies: cells it overwrites or deletes, or a sheet it changes, " +
  "changed since it was queued.";

/** The kinds of change a user may let apply without asking. */
const AUTO_APPROVABLE = [
  { tag: "editSheetValues", label: "Sheet value edits" },
  { tag: "formatSheets", label: "Sheet formatting" },
];

/** Fields of a cell's value, which no format read may ask for. */
const VALUE_FIELDS = ["formattedValue", "effectiveValue", "userEnteredValue", "hyperlink", "note"];

const BORDER_SIDES = ["top", "bottom", "left", "right", "innerHorizontal", "innerVertical"];

/** The paths a field mask names: `a(b,c(d)),e` names `a.b`, `a.c.d` and `e`. */
function maskPaths(mask: string, prefix = ""): string[] {
  let parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= mask.length; i++) {
    if (mask[i] === "(") depth++;
    else if (mask[i] === ")") depth--;
    else if (i === mask.length || (mask[i] === "," && depth === 0)) {
      parts.push(mask.slice(start, i));
      start = i + 1;
    }
  }
  return parts.flatMap(part => {
    let open = part.indexOf("(");
    return open < 0 ? [prefix + part] : maskPaths(part.slice(open + 1, -1), `${prefix}${part.slice(0, open)}.`);
  });
}

/** Sets `path` of `format` to `value`, or removes it when `value` is undefined, dropping emptied groups. */
function setPath(format: Record<string, any>, path: string[], value: unknown): void {
  let [head, ...rest] = path;
  if (rest.length === 0) {
    if (value === undefined) delete format[head];
    else format[head] = structuredClone(value);
    return;
  }
  let group = format[head] ?? {};
  setPath(group, rest, value);
  if (Object.keys(group).length > 0) format[head] = group;
  else delete format[head];
}

/** The provider of the test running, whose requests `afterEach` checks. */
let current: SheetsProvider | undefined;

/**
 * Google Sheets as far as these tests need it: metadata honouring its field mask, value reads in
 * each mode, data-filter reads answered out of order, developer metadata, Drive's `canEdit`, and
 * an atomic `batchUpdate` of the requests the gatekeeper sends, changes to rows, columns and sheets
 * included, rewriting formulas as Google does and refusing what Google refuses.
 */
class SheetsProvider {
  title = "Budget";
  cells = new Map<string, SheetCellInput>();
  /** What each cell has set of its formatting, as Google stores it. */
  formats = new Map<string, RestCellFormat>();
  /** The results of formulas, by their text; any other formula computes 0. */
  results: Record<string, number> = {};
  markers = new Map<number, { metadataKey: string; metadataValue: string }>();
  /** Every `batchUpdate` sent, committed or not. */
  batches: BatchRequest[][] = [];
  commits = 0;
  /** Every request, in order. */
  requests: URL[] = [];
  canEdit = true;
  /** Lands once, just before the next batch is checked, as a collaborator's edit would. */
  beforeNextBatch?: () => void;
  /** Lands once, just after the next batch is answered. */
  afterNextBatch?: () => void;
  /**
   * `lost` commits the next batch and answers 503; `dropped` answers 503 and commits nothing;
   * `inflight` answers 503 and commits it just before the batch after it is checked; `quota`
   * answers 429 and `forbidden` 403, committing nothing.
   */
  nextFailure?: "lost" | "dropped" | "inflight" | "quota" | "forbidden";
  /** Requests Google would refuse that the gatekeeper should never send, whatever the spreadsheet holds. */
  violations: string[] = [];
  #inflight?: BatchRequest[];

  constructor(public sheets: ProviderSheet[], cells: Record<string, SheetCellInput> = {}) {
    for (let [name, value] of Object.entries(cells)) this.set(name, value);
  }

  install(): this {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      let request = new Request(input, init);
      let url = new URL(request.url);
      this.requests.push(url);
      if (url.hostname === "www.googleapis.com" && url.pathname === "/drive/v3/files/sheet-1") {
        expect(url.searchParams.get("fields")).toBe("capabilities(canEdit)");
        return Response.json({ capabilities: { canEdit: this.canEdit } });
      }
      let path = url.pathname.replace("/v4/spreadsheets/sheet-1", "");
      if (path === ":batchUpdate") return this.#batch((await request.json() as { requests: BatchRequest[] }).requests);
      if (path === ":getByDataFilter") return this.#formatsByDataFilter(url, await request.json());
      if (path === "" && url.searchParams.has("ranges")) return this.#formatRead(url);
      if (path === "/values:batchGetByDataFilter") return this.#byDataFilter(await request.json());
      if (path === "/values:batchGet") return this.#batchGet(url);
      let metadataId = path.match(/^\/developerMetadata\/(\d+)$/)?.[1];
      if (metadataId !== undefined) {
        let marker = this.markers.get(Number(metadataId));
        return marker
          ? Response.json({ metadataId: Number(metadataId), ...marker })
          : Response.json({ error: { code: 404, status: "NOT_FOUND" } }, { status: 404 });
      }
      if (path === "") return this.#metadata(url.searchParams.get("fields") ?? "");
      throw new Error(`Unexpected provider request: ${url.href}`);
    }));
    return this;
  }

  /** A collaborator's edit of one cell, named as in `Sales!B2`. */
  set(name: string, value: SheetCellInput): void {
    let { sheet: title, rect } = parseRange(name);
    let id = this.sheets.find(s => s.title === title)!.id;
    if (value === null) this.cells.delete(key(id, rect.startRow, rect.startColumn));
    else this.cells.set(key(id, rect.startRow, rect.startColumn), value);
  }

  get(name: string): SheetCellInput {
    let { sheet: title, rect } = parseRange(name);
    let id = this.sheets.find(s => s.title === title)!.id;
    return this.cells.get(key(id, rect.startRow, rect.startColumn)) ?? null;
  }

  /** A collaborator's formatting of one cell, named as in `Sales!B2`. */
  setFormat(name: string, format: RestCellFormat): void {
    let { sheet: title, rect } = parseRange(name);
    let id = this.sheets.find(s => s.title === title)!.id;
    this.formats.set(key(id, rect.startRow, rect.startColumn), format);
  }

  getFormat(name: string): RestCellFormat | undefined {
    let { sheet: title, rect } = parseRange(name);
    let id = this.sheets.find(s => s.title === title)!.id;
    return this.formats.get(key(id, rect.startRow, rect.startColumn));
  }

  /** The `fields` masks of every format read. */
  formatMasks: string[] = [];

  /**
   * The paths of a cell's formatting a format read's mask names, below `userEnteredFormat`. A
   * format read must ask for no cell's value.
   */
  #formatPaths(fields: string): string[][] {
    this.formatMasks.push(fields);
    for (let field of VALUE_FIELDS) {
      if (fields.includes(field)) this.violations.push(`a format read asks for ${field}`);
    }
    let prefix = "sheets.data.rowData.values.userEnteredFormat.";
    return maskPaths(fields).flatMap(path => path.startsWith(prefix) ? [path.slice(prefix.length).split(".")] : []);
  }

  /** `sheet` with the formats of each of `rects`, as a format read returns it, only what `paths` name. */
  #formatSheet(sheet: ProviderSheet, rects: Rect[], paths: string[][]) {
    let masked = (format: RestCellFormat) => {
      let shown: Record<string, any> = {};
      for (let path of paths) setPath(shown, path, path.reduce<any>((at, part) => at?.[part], format));
      return shown;
    };
    return {
      properties: {
        sheetId: sheet.id, title: sheet.title, index: sheet.index,
        gridProperties: { rowCount: sheet.rowCount, columnCount: sheet.columnCount },
      },
      data: rects.map(rect => ({
        startRow: rect.startRow,
        startColumn: rect.startColumn,
        rowData: Array.from({ length: rect.endRow - rect.startRow }, (_row, r) => ({
          values: Array.from({ length: rect.endColumn - rect.startColumn }, (_column, c) => {
            let format = this.formats.get(key(sheet.id, rect.startRow + r, rect.startColumn + c));
            return format ? { userEnteredFormat: masked(format) } : {};
          }),
        })),
      })),
    };
  }

  /** `spreadsheets.get` with one A1 range and grid data. */
  #formatRead(url: URL): Response {
    let paths = this.#formatPaths(url.searchParams.get("fields") ?? "");
    let ranges = url.searchParams.getAll("ranges");
    if (ranges.length !== 1) this.violations.push(`a format read asks for ${ranges.length} ranges`);
    let parsed = parseRange(ranges[0]);
    let sheet = parsed.sheet === undefined
      ? this.sheets.toSorted((a, b) => a.index - b.index).find(s => !s.hidden)
      : this.sheets.find(s => s.title.toLowerCase() === parsed.sheet!.toLowerCase());
    if (!sheet || parsed.rect.startRow >= sheet.rowCount || parsed.rect.startColumn >= sheet.columnCount) {
      return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT" } }, { status: 400 });
    }
    let rect = {
      ...parsed.rect,
      endRow: Math.min(parsed.rect.endRow, sheet.rowCount),
      endColumn: Math.min(parsed.rect.endColumn, sheet.columnCount),
    };
    return Response.json({ sheets: [this.#formatSheet(sheet, [rect], paths)] });
  }

  /** `spreadsheets:getByDataFilter` by grid range, with grid data, each sheet once. */
  #formatsByDataFilter(
    url: URL, body: { dataFilters: { gridRange: Required<FixtureGridRange> }[]; includeGridData?: boolean },
  ): Response {
    let paths = this.#formatPaths(url.searchParams.get("fields") ?? "");
    if (body.includeGridData !== true) this.violations.push("a format read leaves out grid data");
    let bySheet = new Map<ProviderSheet, Rect[]>();
    for (let { gridRange } of body.dataFilters) {
      let sheet = this.sheets.find(s => s.id === gridRange.sheetId);
      if (!sheet || gridRange.endRowIndex > sheet.rowCount || gridRange.endColumnIndex > sheet.columnCount) {
        return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT" } }, { status: 400 });
      }
      bySheet.set(sheet, [...bySheet.get(sheet) ?? [], {
        startRow: gridRange.startRowIndex, endRow: gridRange.endRowIndex,
        startColumn: gridRange.startColumnIndex, endColumn: gridRange.endColumnIndex,
      }]);
    }
    // Not in the order asked.
    return Response.json({ sheets: [...bySheet].map(([sheet, rects]) => this.#formatSheet(sheet, rects, paths)).toReversed() });
  }

  /** The `fields` masks of every metadata read. */
  get masks(): string[] {
    return this.requests.flatMap(url => url.searchParams.getAll("fields"));
  }

  #metadata(fields: string): Response {
    let body = spreadsheetMetadata("sheet-1", this.title, this.sheets);
    // A field the mask does not name is left out, as Google leaves it out.
    for (let sheet of body.sheets) {
      if (!fields.includes("protectedRanges")) delete sheet.protectedRanges;
      for (let range of sheet.protectedRanges ?? []) {
        if (!fields.includes("editors")) delete (range as Partial<typeof range>).editors;
      }
    }
    return Response.json(body);
  }

  #shown(value: SheetCellInput, mode: string): SheetCellInput {
    let raw = typeof value === "string" && value.startsWith("=") ? this.results[value] ?? 0 : value;
    if (mode === "FORMULA") return value;
    if (mode === "UNFORMATTED_VALUE") return raw;
    return typeof raw === "boolean" ? String(raw).toUpperCase() : raw === null ? null : String(raw);
  }

  /** The cells of `rect` of a sheet, clipped to its grid, with trailing blanks trimmed. */
  #values(sheet: ProviderSheet, rect: Rect, mode: string): { rect: Rect; values?: unknown[][] } {
    let clipped = {
      ...rect, endRow: Math.min(rect.endRow, sheet.rowCount), endColumn: Math.min(rect.endColumn, sheet.columnCount),
    };
    let values: unknown[][] = [];
    for (let row = clipped.startRow; row < clipped.endRow; row++) {
      let line: unknown[] = [];
      for (let column = clipped.startColumn; column < clipped.endColumn; column++) {
        let value = this.cells.get(key(sheet.id, row, column)) ?? null;
        line.push(value === null ? "" : this.#shown(value, mode));
      }
      while (line.length > 0 && line.at(-1) === "") line.pop();
      values.push(line);
    }
    while (values.length > 0 && values.at(-1)!.length === 0) values.pop();
    return { rect: clipped, ...(values.length > 0 ? { values } : {}) };
  }

  #batchGet(url: URL): Response {
    let mode = url.searchParams.get("valueRenderOption")!;
    let ranges = url.searchParams.getAll("ranges").map(range => {
      let parsed = parseRange(range);
      let sheet = parsed.sheet === undefined
        ? this.sheets.toSorted((a, b) => a.index - b.index).find(s => !s.hidden)
        : this.sheets.find(s => s.title.toLowerCase() === parsed.sheet!.toLowerCase());
      return sheet && { sheet, rect: parsed.rect };
    });
    // Google refuses a range naming a sheet it does not have, or lying wholly outside its grid.
    if (ranges.some(range => !range || range.rect.startRow >= range.sheet.rowCount ||
      range.rect.startColumn >= range.sheet.columnCount)) {
      return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT" } }, { status: 400 });
    }
    return Response.json({
      valueRanges: ranges.map(range => {
        let { sheet } = range!;
        let { rect, values } = this.#values(sheet, range!.rect, mode);
        return { range: a1Of(sheet.title, rect), majorDimension: "ROWS", ...(values ? { values } : {}) };
      }),
    });
  }

  /** The grid ranges of every data-filter read, in the order asked. */
  dataFilterReads: { mode: string; gridRanges: Required<FixtureGridRange>[] }[] = [];

  #byDataFilter(body: { dataFilters: { gridRange: Required<FixtureGridRange> }[]; valueRenderOption: string }): Response {
    let mode = body.valueRenderOption;
    this.dataFilterReads.push({ mode, gridRanges: body.dataFilters.map(({ gridRange }) => gridRange) });
    let sheets = body.dataFilters.map(({ gridRange }) => this.sheets.find(s => s.id === gridRange.sheetId));
    if (body.dataFilters.some(({ gridRange }, i) => !sheets[i] || gridRange.startRowIndex >= sheets[i].rowCount ||
      gridRange.startColumnIndex >= sheets[i].columnCount)) {
      return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT" } }, { status: 400 });
    }
    let answers = body.dataFilters.map(({ gridRange }, i) => {
      let sheet = sheets[i]!;
      let { rect, values } = this.#values(sheet, {
        startRow: gridRange.startRowIndex, endRow: gridRange.endRowIndex,
        startColumn: gridRange.startColumnIndex, endColumn: gridRange.endColumnIndex,
      }, mode);
      return {
        valueRange: { range: a1Of(sheet.title, rect), majorDimension: "ROWS", ...(values ? { values } : {}) },
        // Echoed with its zero fields left out.
        dataFilters: [{ gridRange: Object.fromEntries(Object.entries(gridRange).filter(([, v]) => v !== 0)) }],
      };
    });
    // Not in the order asked.
    return Response.json({ valueRanges: answers.toReversed() });
  }

  #batch(requests: BatchRequest[]): Response {
    if (this.#inflight) {
      this.#commit(this.#inflight);
      this.#inflight = undefined;
    }
    this.batches.push(requests);
    this.beforeNextBatch?.();
    this.beforeNextBatch = undefined;
    let failure = this.nextFailure;
    this.nextFailure = undefined;
    let answer = (): Response => {
      if (failure === "quota") return Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, { status: 429 });
      if (failure === "forbidden") return Response.json({ error: { code: 403, status: "PERMISSION_DENIED" } }, { status: 403 });
      if (failure === "dropped") return new Response(null, { status: 503 });
      if (failure === "inflight") {
        this.#inflight = requests;
        return new Response(null, { status: 503 });
      }
      if (!this.#commit(requests)) {
        return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT" } }, { status: 400 });
      }
      return failure === "lost" ? new Response(null, { status: 503 }) : Response.json({ replies: [] });
    };
    let response = answer();
    this.afterNextBatch?.();
    this.afterNextBatch = undefined;
    return response;
  }

  /** Applies every request or none, as Google does. */
  #commit(requests: BatchRequest[]): boolean {
    let state: ProviderState = {
      cells: new Map(this.cells), formats: new Map(this.formats), markers: new Map(this.markers),
      sheets: this.sheets.map(s => ({ ...s })),
    };
    try {
      for (let request of requests) this.#apply(request, state);
    } catch (error) {
      if (error instanceof Invalid) return false;
      throw error;
    }
    this.cells = state.cells;
    this.formats = state.formats;
    this.markers = state.markers;
    this.sheets = state.sheets;
    this.commits++;
    return true;
  }

  /** Refuses a request the gatekeeper should never send, recording it for `afterEach`. */
  #violation(reason: string): never {
    this.violations.push(reason);
    throw new Invalid(reason);
  }

  #sheetOf(state: ProviderState, sheetId: number): ProviderSheet {
    let sheet = state.sheets.find(s => s.id === sheetId);
    if (!sheet) throw new Invalid(`No grid with id: ${sheetId}`);
    return sheet;
  }

  #newSheetId(state: ProviderState, sheetId: unknown): number {
    if (typeof sheetId !== "number" || !Number.isInteger(sheetId) || sheetId < 0 || sheetId > MAX_SHEET_ID) {
      this.#violation(`sheet ID ${String(sheetId)} is not a non-negative 32-bit integer`);
    }
    if (state.sheets.some(s => s.id === sheetId)) throw new Invalid(`Sheet with id ${sheetId} already exists.`);
    return sheetId;
  }

  #checkTitle(state: ProviderState, title: unknown, except?: number): string {
    if (typeof title !== "string" || title.length === 0) this.#violation("a sheet has no title");
    if (title.length > 100) this.#violation("a sheet title is over 100 characters");
    if (state.sheets.some(s => s.id !== except && s.title.toLowerCase() === title.toLowerCase())) {
      throw new Invalid(`A sheet with the name "${title}" already exists.`);
    }
    return title;
  }

  // Places `sheet` at its index, moving those from there on one along.
  #place(state: ProviderState, sheet: ProviderSheet): void {
    if (sheet.index > state.sheets.length) throw new Invalid("index is past the last sheet");
    state.sheets = [...state.sheets.map(s => s.index >= sheet.index ? { ...s, index: s.index + 1 } : s), sheet];
  }

  // Rewrites every formula through `step`, as Google does; `onTarget` says whether a formula on a
  // sheet is on the step's target.
  #rewrite(state: ProviderState, step: RewriteStep, onTarget: (sheetId: number) => boolean): void {
    for (let [cell, value] of state.cells) {
      if (typeof value !== "string" || !value.startsWith("=")) continue;
      state.cells.set(cell, rewriteFormula(value, step, onTarget(Number(cell.split(":")[0]))).text);
    }
  }

  /** Throws, as Google refuses a range, unless `range` lies within `sheet`'s grid. */
  #withinGrid(sheet: ProviderSheet, range: Required<FixtureGridRange>): void {
    if (range.endRowIndex > sheet.rowCount || range.endColumnIndex > sheet.columnCount) {
      throw new Invalid(`Range exceeds grid limits. Max rows: ${sheet.rowCount}, max columns: ${sheet.columnCount}`);
    }
  }

  /** Sets what `change` makes of the formatting of each cell of `range`, on a copy of the one held. */
  #reformat(
    state: ProviderState, range: Required<FixtureGridRange>,
    change: (format: Record<string, any>, row: number, column: number) => void,
  ): void {
    for (let row = range.startRowIndex; row < range.endRowIndex; row++) {
      for (let column = range.startColumnIndex; column < range.endColumnIndex; column++) {
        let cell = key(range.sheetId, row, column);
        let format: Record<string, any> = structuredClone(state.formats.get(cell) ?? {});
        change(format, row, column);
        if (Object.keys(format).length > 0) state.formats.set(cell, format);
        else state.formats.delete(cell);
      }
    }
  }

  #apply(request: BatchRequest, state: ProviderState): void {
    let { cells, markers } = state;
    if (request.createDeveloperMetadata) {
      let { metadataId, metadataKey, metadataValue, location, visibility } =
        request.createDeveloperMetadata.developerMetadata;
      if (markers.has(metadataId) || !location?.spreadsheet || visibility !== "PROJECT") throw new Invalid();
      markers.set(metadataId, { metadataKey, metadataValue });
    } else if (request.deleteDeveloperMetadata) {
      markers.delete(request.deleteDeveloperMetadata.dataFilter.developerMetadataLookup.metadataId);
    } else if (request.updateCells) {
      let { range, rows, fields } = request.updateCells;
      let sheet = this.#sheetOf(state, range.sheetId);
      if (fields !== "userEnteredValue" || range.endRowIndex > sheet.rowCount ||
        range.endColumnIndex > sheet.columnCount) throw new Invalid();
      for (let row = range.startRowIndex; row < range.endRowIndex; row++) {
        for (let column = range.startColumnIndex; column < range.endColumnIndex; column++) {
          // A cell `rows` leaves out is cleared.
          let entered = rows?.[row - range.startRowIndex]?.values?.[column - range.startColumnIndex]
            ?.userEnteredValue;
          let value = entered?.formulaValue ?? entered?.stringValue ?? entered?.numberValue ??
            entered?.boolValue ?? null;
          if (value === null) cells.delete(key(sheet.id, row, column));
          else cells.set(key(sheet.id, row, column), value);
        }
      }
    } else if (request.repeatCell) {
      let { range, cell, fields } = request.repeatCell;
      this.#withinGrid(this.#sheetOf(state, range.sheetId), range);
      let paths = maskPaths(fields);
      if (paths.some(path => !path.startsWith("userEnteredFormat."))) this.#violation(`repeatCell sets ${fields}`);
      this.#reformat(state, range, format => {
        for (let path of paths) {
          let parts = path.split(".").slice(1);
          // A field the mask names that the cell leaves out is reset.
          setPath(format, parts, parts.reduce((at, part) => at?.[part], cell.userEnteredFormat));
        }
      });
    } else if (request.updateBorders) {
      let { range, ...given } = request.updateBorders;
      this.#withinGrid(this.#sheetOf(state, range.sheetId), range);
      let unknown = Object.keys(given).filter(side => !BORDER_SIDES.includes(side));
      if (unknown.length > 0) this.#violation(`updateBorders sets ${unknown.join()}`);
      // An outer edge borders the cells along it, and an inner one the cells on both its sides.
      this.#reformat(state, range, (format, row, column) => {
        let sides = {
          top: row === range.startRowIndex ? given.top : given.innerHorizontal,
          bottom: row === range.endRowIndex - 1 ? given.bottom : given.innerHorizontal,
          left: column === range.startColumnIndex ? given.left : given.innerVertical,
          right: column === range.endColumnIndex - 1 ? given.right : given.innerVertical,
        };
        for (let [side, border] of Object.entries(sides)) {
          if (border !== undefined) setPath(format, ["borders", side], border.style === "NONE" ? undefined : border);
        }
      });
      // An edge has one owner, so an outer edge set on the range clears the facing side beside it.
      let sheet = this.#sheetOf(state, range.sheetId);
      let beside = [
        ["top", "bottom", { ...range, startRowIndex: range.startRowIndex - 1, endRowIndex: range.startRowIndex }],
        ["bottom", "top", { ...range, startRowIndex: range.endRowIndex, endRowIndex: range.endRowIndex + 1 }],
        ["left", "right", { ...range, startColumnIndex: range.startColumnIndex - 1, endColumnIndex: range.startColumnIndex }],
        ["right", "left", { ...range, startColumnIndex: range.endColumnIndex, endColumnIndex: range.endColumnIndex + 1 }],
      ] as const;
      for (let [side, facing, neighbours] of beside) {
        let inside = neighbours.startRowIndex >= 0 && neighbours.startColumnIndex >= 0 &&
          neighbours.endRowIndex <= sheet.rowCount && neighbours.endColumnIndex <= sheet.columnCount;
        if (given[side] !== undefined && inside) {
          this.#reformat(state, neighbours, format => setPath(format, ["borders", facing], undefined));
        }
      }
    } else if (request.addSheet) {
      let { sheetId, title, index, gridProperties } = request.addSheet.properties;
      if (index === undefined || gridProperties?.rowCount === undefined || gridProperties.columnCount === undefined) {
        this.#violation("addSheet leaves its index or size to Google");
      }
      this.#place(state, {
        id: this.#newSheetId(state, sheetId), title: this.#checkTitle(state, title), index,
        rowCount: gridProperties.rowCount, columnCount: gridProperties.columnCount,
      });
    } else if (request.updateSheetProperties) {
      let { properties, fields } = request.updateSheetProperties;
      if (fields !== "title" || Object.keys(properties).join() !== "sheetId,title") {
        this.#violation("updateSheetProperties changes more than a title");
      }
      let sheet = this.#sheetOf(state, properties.sheetId);
      let title = this.#checkTitle(state, properties.title, sheet.id);
      state.sheets = state.sheets.map(s => s.id === sheet.id ? { ...s, title } : s);
      this.#rewrite(state, { kind: "rename", from: sheet.title, to: title }, () => false);
    } else if (request.duplicateSheet) {
      let { sourceSheetId, newSheetId, insertSheetIndex, newSheetName } = request.duplicateSheet;
      // Google names a copy given no name in the user's language, and puts one given no index first.
      if (insertSheetIndex === undefined || newSheetName === undefined) {
        this.#violation("duplicateSheet leaves the copy's name or position to Google");
      }
      let source = this.#sheetOf(state, sourceSheetId);
      let id = this.#newSheetId(state, newSheetId);
      let title = this.#checkTitle(state, newSheetName);
      let { protectedRanges: _protectedRanges, hidden: _hidden, ...copied } = source;
      this.#place(state, { ...copied, id, title, index: insertSheetIndex });
      let copies = [...cells].flatMap(([cell, value]) => {
        let [sheetId, row, column] = cell.split(":").map(Number);
        return sheetId === source.id ? [[key(id, row, column), value] as const] : [];
      });
      for (let [cell, value] of copies) {
        cells.set(cell, typeof value === "string" && value.startsWith("=")
          ? rewriteFormula(value, { kind: "duplicate", title: source.title, newTitle: title }, true).text
          : value);
      }
      // A copy's own entries, visited as they are added, are on another sheet.
      for (let [cell, format] of state.formats) {
        let [sheetId, row, column] = cell.split(":").map(Number);
        if (sheetId === source.id) state.formats.set(key(id, row, column), structuredClone(format));
      }
    } else if (request.deleteSheet) {
      let sheet = this.#sheetOf(state, request.deleteSheet.sheetId);
      if (!sheet.hidden && state.sheets.filter(s => !s.hidden).length === 1) {
        throw new Invalid("You can't remove all the visible sheets in a document.");
      }
      state.sheets = state.sheets.flatMap(s =>
        s.id === sheet.id ? [] : [s.index > sheet.index ? { ...s, index: s.index - 1 } : s]);
      for (let held of [cells, state.formats]) {
        for (let cell of held.keys()) {
          if (Number(cell.split(":")[0]) === sheet.id) held.delete(cell);
        }
      }
    } else if (request.insertDimension || request.deleteDimension) {
      this.#dimension(request, state);
    } else {
      this.#violation(`unexpected request ${Object.keys(request).join()}`);
    }
  }

  /** Inserts or deletes rows or columns, moving cells and rewriting formulas as Google does. */
  #dimension(request: BatchRequest, state: ProviderState): void {
    let inserting = request.insertDimension !== undefined;
    let { range, inheritFromBefore } = request.insertDimension ?? request.deleteDimension;
    let sheet = this.#sheetOf(state, range.sheetId);
    let rows = range.dimension === "ROWS";
    if (!rows && range.dimension !== "COLUMNS") this.#violation(`unknown dimension ${range.dimension}`);
    let size = rows ? sheet.rowCount : sheet.columnCount;
    let { startIndex: start, endIndex: end } = range;
    let count = end - start;
    if (!(count > 0) || start < 0) this.#violation("a dimension range is empty");
    if (inserting) {
      if (start > size) throw new Invalid(`range.startIndex is larger than current grid size (${size})`);
      if (start === size && inheritFromBefore !== true) {
        this.#violation(`range.startIndex must be less than the grid size (${size}) if inheritFromBefore is false.`);
      }
    } else {
      if (end > size) throw new Invalid("range.endIndex is past the grid");
      if (count >= size) throw new Invalid(`You can't delete all the ${rows ? "rows" : "columns"} on the sheet.`);
    }
    // Formats move with their cells; inserted lines are left unformatted.
    let moved = <T>(held: Map<string, T>) => new Map([...held].flatMap(([cell, value]) => {
      let [sheetId, row, column] = cell.split(":").map(Number);
      if (sheetId !== sheet.id) return [[cell, value] as const];
      let line = rows ? row : column;
      if (!inserting && line >= start && line < end) return [];
      let to = line < start ? line : inserting ? line + count : line - count;
      return [[rows ? key(sheetId, to, column) : key(sheetId, row, to), value] as const];
    }));
    state.cells = moved(state.cells);
    state.formats = moved(state.formats);
    let grown = inserting ? count : -count;
    state.sheets = state.sheets.map(s => s.id !== sheet.id ? s
      : rows ? { ...s, rowCount: s.rowCount + grown } : { ...s, columnCount: s.columnCount + grown });
    this.#rewrite(state, {
      kind: inserting ? "insert" : "delete", title: sheet.title, axis: rows ? "rows" : "columns", start, count,
    }, sheetId => sheetId === sheet.id);
  }
}

function hooks() {
  return env.TEST_HOOKS.getByName("hooks");
}

let facetCount = 0;

/** A Sheets gatekeeper over its own storage, and calls through a fresh session each time. */
function gatekeeper() {
  let facet = `sheets-${++facetCount}`;
  let call = async (method: string, ...args: unknown[]) =>
    hooks().callSheets(facet, method as never, args);
  let update = (changes: SheetChange[]) => call("updateSheet", changes);
  return {
    call,
    update,
    queued: async (changes: SheetChange[]) => {
      let outcome = await update(changes);
      if (outcome.error !== undefined) throw new Error(outcome.error);
      if (outcome.actionId === undefined) throw new Error("updateSheet queued nothing");
      return outcome;
    },
    read: async (range: string, valueMode?: SpreadsheetValueMode) =>
      (await call("readRange", range, ...(valueMode ? [{ valueMode }] : []))).value as SpreadsheetRange,
    formats: async (range: string) => {
      let outcome = await call("readFormats", range);
      if (outcome.error !== undefined) throw new Error(outcome.error);
      return outcome.value as unknown as SpreadsheetFormats;
    },
    info: async () => (await call("getSpreadsheet")).value as SpreadsheetInfo,
    apply: (actionId: number) => hooks().applySheets(facet, actionId),
    reject: (actionId: number) => hooks().rejectSheets(facet, actionId),
    autoApprovable: () => hooks().sheetsAutoApprovable(facet),
    seedMarkers: (ids: number[]) => hooks().seedSheetsMarkers(facet, ids),
    orphan: (actionId: number) => hooks().orphanSheetsClaim(facet, actionId),
  };
}

function budget(sheets: ProviderSheet[] = [sheetMeta(0, "Sales"), sheetMeta(7, "Q3 Plan", { index: 1, rowCount: 10, columnCount: 4 })]) {
  current = new SheetsProvider(sheets, {
    "Sales!A1": "Region", "Sales!B1": "Total",
    "Sales!A2": "EMEA", "Sales!B2": 4, "Sales!C2": "=B2*2",
    "Sales!A3": "APAC", "Sales!B3": 5,
  }).install();
  return current;
}

/** The marker a batch creates. */
function markerOf(batch: BatchRequest[]): number {
  return batch[0].createDeveloperMetadata.developerMetadata.metadataId;
}

/** The markers a batch deletes, in order. */
function deletedBy(batch: BatchRequest[]): number[] {
  return batch.flatMap(request =>
    request.deleteDeveloperMetadata ? [request.deleteDeveloperMetadata.dataFilter.developerMetadataLookup.metadataId] : []);
}

/** The `updateCells` requests of a batch, without its marker requests. */
function cellRequests(batch: BatchRequest[]): BatchRequest[] {
  return batch.filter(request => request.updateCells);
}

/** The requests of a batch that change the spreadsheet, without its marker requests. */
function changeRequests(batch: BatchRequest[]): BatchRequest[] {
  return batch.filter(request => !request.createDeveloperMetadata && !request.deleteDeveloperMetadata);
}

/** How many value reads the provider has answered. */
function valueReads(provider: SheetsProvider): number {
  return provider.requests.filter(url => url.pathname.includes("/values:")).length;
}

/** Durable Object KV held in memory, as far as a journal uses it. */
function memoryKv() {
  let entries = new Map<string, unknown>();
  return {
    get: <T>(name: string) => entries.get(name) as T | undefined,
    put: <T>(name: string, value: T) => void entries.set(name, structuredClone(value)),
    delete: (name: string) => void entries.delete(name),
    list: <T>({ prefix, startAfter, limit }: { prefix: string; startAfter?: string; limit?: number }) =>
      [...entries]
        .filter(([name]) => name.startsWith(prefix) && (startAfter === undefined || name > startAfter))
        .toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .slice(0, limit ?? Infinity) as [string, T][],
  };
}

async function sha256(text: string): Promise<string> {
  let digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A batch writing `[id, "done"]` to Sales!B2:C2 as a queue that guarded only cells it wrote
 * journaled it: its guard a digest of the title and size of each sheet it writes to and of
 * `entered`, those cells as entered, naming no cells.
 */
async function cellsOnlyBatch(id: number, entered: SheetCellInput[]) {
  return {
    changes: [{
      op: "writeCells" as const, sheetId: 0, rect: { startRow: 1, endRow: 2, startColumn: 1, endColumn: 3 },
      values: [[id, "done"]],
    }],
    sheets: { 0: "Sales" },
    marker: { id, token: `token-${id}` },
    guard: { sha256: await sha256(JSON.stringify([[[0, "Sales", 20, 6]], [entered]])), after: [] },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  let violations = current?.violations ?? [];
  current = undefined;
  expect(violations).toEqual([]);
});

describe("Google Sheets changes", () => {
  it("queues literal values as an auto-approvable edit, shows them in reads, and writes them with a marker", async () => {
    let provider = budget();
    let sheets = gatekeeper();

    let { actionId, action, value, observations } = await sheets.queued([
      { op: "writeCells", range: "Sales!B2:C2", values: [[6, "done"]] },
    ]);

    expect(value).toEqual({});
    expect(observations).toEqual(['Read the cells 1 change(s) write in "Budget" to queue them.']);
    expect(action).toMatchObject({
      title: 'Edit "Sales"',
      description: 'In "Sales", set B2:C2 to the values below.',
      autoApprovable: true,
      actionKind: { tag: "editSheetValues", label: "Sheet value edits" },
      descriptionIsComplete: true,
      fields: [{ label: "Values", kind: "text", value: '[6,"done"]' }],
    });
    expect(await sheets.autoApprovable()).toEqual(AUTO_APPROVABLE);
    expect(provider.get("Sales!B2")).toBe(4);

    expect(await sheets.apply(actionId!)).toBeNull();

    expect(provider.batches).toHaveLength(1);
    let [create, ...rest] = provider.batches[0];
    expect(create).toEqual({
      createDeveloperMetadata: {
        developerMetadata: {
          metadataId: expect.any(Number), metadataKey: "gadgets.write", metadataValue: expect.any(String),
          location: { spreadsheet: true }, visibility: "PROJECT",
        },
      },
    });
    expect(rest).toEqual([{
      updateCells: {
        range: { sheetId: 0, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 3 },
        rows: [{ values: [{ userEnteredValue: { numberValue: 6 } }, { userEnteredValue: { stringValue: "done" } }] }],
        fields: "userEnteredValue",
      },
    }]);
    expect(provider.get("Sales!B2")).toBe(6);
    expect(provider.get("Sales!C2")).toBe("done");
    expect((await sheets.read("Sales!A2:C2")).values).toEqual([["EMEA", "6", "done"]]);
  });

  it("shows queued values as entered in each mode, and a result only Google can compute as pending", async () => {
    let provider = budget();
    provider.results["=B3*2"] = 10;
    provider.set("Sales!E3", "=B3*2");
    let sheets = gatekeeper();
    await sheets.queued([
      { op: "writeCells", range: "Sales!B2:D2", values: [[6, true, "=sum(sales!b2:b3)"]] },
      { op: "clearRange", range: "Sales!A3:B3" },
    ]);

    expect(await sheets.read("Sales!A2:D3", "formula")).toEqual({
      range: "Sales!A2:D3", values: [["EMEA", 6, true, "=sum(Sales!B2:B3)"], [null, null, null, null]],
    });
    expect(await sheets.read("Sales!A2:D3", "raw")).toEqual({
      range: "Sales!A2:D3", values: [["EMEA", 6, true, null], [null, null, null, null]], pendingCells: ["D2"],
    });
    expect(await sheets.read("Sales!A2:D3")).toEqual({
      range: "Sales!A2:D3",
      values: [["EMEA", null, null, null], [null, null, null, null]],
      pendingCells: ["B2", "C2", "D2"],
    });
    // Cells no change writes read as saved, even a formula's result that depends on a queued cell.
    expect(await sheets.read("Sales!A1:B1")).toEqual({ range: "Sales!A1:B1", values: [["Region", "Total"]] });
    expect((await sheets.read("Sales!E3", "raw")).values).toEqual([[10]]);
    expect(provider.get("Sales!A3")).toBe("APAC");
  });

  it("queues a batch with a formula for approval, written as Google stores it", async () => {
    let provider = budget();
    let sheets = gatekeeper();

    let { actionId, action } = await sheets.queued([
      { op: "writeCells", range: "sales!d2:d3", values: [["=sum(sales!b2:c2)"], [null]] },
      { op: "clearRange", range: "'Q3 Plan'!A1:B2" },
    ]);

    expect(action).toMatchObject({
      title: "Edit 2 sheets",
      autoApprovable: false,
      fields: [
        { label: "Change 1: Values", kind: "text", value: '["=sum(Sales!B2:C2)"]\n[null]' },
        { label: "Change 1: Formulas", kind: "text", value: "D2: =sum(Sales!B2:C2)" },
      ],
    });
    expect(action!.description).toContain(
      "Makes 2 changes, all or none of which are applied:\n\n" +
      '1. In "Sales", set D2:D3 to the values below\n' +
      '2. In "Q3 Plan", clear the contents of A1:B2, keeping their formatting');
    expect(await sheets.autoApprovable()).toEqual(AUTO_APPROVABLE);

    expect(await sheets.apply(actionId!)).toBeNull();

    expect(cellRequests(provider.batches[0])).toEqual([
      {
        updateCells: {
          range: { sheetId: 0, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 3, endColumnIndex: 4 },
          rows: [{ values: [{ userEnteredValue: { formulaValue: "=sum(Sales!B2:C2)" } }] }, { values: [{}] }],
          fields: "userEnteredValue",
        },
      },
      {
        updateCells: {
          range: { sheetId: 7, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2 },
          fields: "userEnteredValue",
        },
      },
    ]);
    expect(provider.get("Sales!D2")).toBe("=sum(Sales!B2:C2)");
  });

  it("names a sheet exactly when the description cannot, and quotes a formula with a line break", async () => {
    budget([sheetMeta(0, "Sales"), sheetMeta(3, "Sheet_1", { index: 1 }), sheetMeta(4, "Sheet1", { index: 2 })]);
    let sheets = gatekeeper();

    let { action } = await sheets.queued([
      { op: "writeCells", range: "Sheet_1!A1:B1", values: [["=1+\nB1: =2", "=A1"]] },
      { op: "clearRange", range: "Sheet1!A1" },
    ]);

    expect(action!.description).toContain(
      '1. In "Sheet1", set A1:B1 to the values below\n2. In "Sheet1", clear the contents of A1');
    expect(action!.fields).toEqual([
      { label: "Change 1: Sheet", kind: "inline", value: "Sheet_1" },
      { label: "Change 1: Values", kind: "text", value: '["=1+\\nB1: =2","=A1"]' },
      { label: "Change 1: Formulas", kind: "text", value: 'A1: "=1+\\nB1: =2"\nB1: =A1' },
    ]);
  });

  it("names a sheet whose title hides a character, and keeps any line separator on one line", async () => {
    budget([sheetMeta(0, "Sales"), sheetMeta(5, "Sales\u200b", { index: 1 })]);
    let sheets = gatekeeper();

    let { action } = await sheets.queued([
      { op: "writeCells", range: "'Sales\u200b'!A1:B1", values: [["=1+\u2028B1: =2", "x\u2029y"]] },
    ]);

    expect(action!.fields).toEqual([
      // The kit shows a title it cannot write out plainly as JSON.
      { label: "Sheet", kind: "json", value: '"Sales\\u200b"' },
      { label: "Values", kind: "text", value: '["=1+\\u2028B1: =2","x\\u2029y"]' },
      { label: "Formulas", kind: "text", value: 'A1: "=1+\\u2028B1: =2"' },
    ]);
  });

  it("refuses a collaborator's edit to any cell of a batch's changes, whatever their sizes", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    // Google answers the reads of these out of order, and each must still guard its own cells.
    let { actionId } = await sheets.queued([
      { op: "writeCells", range: "Sales!A9", values: [[1]] },
      { op: "writeCells", range: "Sales!B2:D4", values: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] },
    ]);

    provider.set("Sales!C3", "edited");

    expect(await sheets.apply(actionId!)).toBe(
      CHANGED);
    expect(provider.batches).toEqual([]);
    expect(provider.get("Sales!C3")).toBe("edited");
  });

  it("refuses a collaborator-edited cell's overwrite without writing, but not an edit elsewhere", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    let blocked = await sheets.queued([{ op: "writeCells", range: "Sales!B2", values: [[7]] }]);

    provider.set("Sales!A9", "note");
    provider.set("Sales!B2", 5);

    expect(await sheets.apply(blocked.actionId!)).toBe(
      CHANGED);
    expect(provider.batches).toEqual([]);
    expect(provider.get("Sales!B2")).toBe(5);

    let other = await sheets.queued([{ op: "writeCells", range: "Sales!B3", values: [[9]] }]);
    provider.set("Sales!A9", "another note");
    expect(await sheets.apply(other.actionId!)).toBeNull();
    expect(provider.get("Sales!B3")).toBe(9);
  });

  it("applies changes in order, the later one overwriting what the earlier one wrote", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    let first = await sheets.queued([{ op: "writeCells", range: "Sales!B2", values: [[6]] }]);
    let second = await sheets.queued([{ op: "writeCells", range: "Sales!B2:B3", values: [[7], [8]] }]);

    expect(await sheets.apply(second.actionId!)).toBe(
      `Google Sheets changes apply in the order they were queued. Approve or reject change ` +
      `${first.actionId} first.`);
    expect(provider.batches).toEqual([]);

    expect(await sheets.apply(first.actionId!)).toBeNull();
    expect(await sheets.apply(second.actionId!)).toBeNull();
    expect([provider.get("Sales!B2"), provider.get("Sales!B3")]).toEqual([7, 8]);
  });

  it("fails a change built on cells an earlier change was to write but did not, without writing", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    let failed = await sheets.queued([{ op: "writeCells", range: "Sales!B2", values: [[6]] }]);
    let rejected = await sheets.queued([{ op: "writeCells", range: "Sales!C2", values: [[7]] }]);
    let later = await sheets.queued([{ op: "writeCells", range: "Sales!B2:C2", values: [[8, 9]] }]);

    provider.set("Sales!B2", "edited");
    expect(await sheets.apply(failed.actionId!)).toBe(
      CHANGED);
    await sheets.reject(rejected.actionId!);

    expect(await sheets.apply(later.actionId!)).toBe(
      `This change no longer applies: it builds on change ${failed.actionId}, which was not applied.`);
    expect(provider.batches).toEqual([]);
    expect(provider.get("Sales!B2")).toBe("edited");
  });

  it("guards cells an earlier applied change wrote against a collaborator's edit since", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    let first = await sheets.queued([{ op: "writeCells", range: "Sales!B2", values: [["=A1 + 1"]] }]);
    let second = await sheets.queued([{ op: "writeCells", range: "Sales!B2:B3", values: [[7], [8]] }]);
    expect(await sheets.apply(first.actionId!)).toBeNull();

    provider.set("Sales!B2", "edited");
    expect(await sheets.apply(second.actionId!)).toBe(
      CHANGED);
    expect(provider.get("Sales!B2")).toBe("edited");
  });

  it("asks for a restart only when rejecting a change that later ones were built on", async () => {
    budget();
    let sheets = gatekeeper();
    let first = await sheets.queued([{ op: "writeCells", range: "Sales!B2", values: [[6]] }]);
    let second = await sheets.queued([{ op: "writeCells", range: "Sales!B3", values: [[7]] }]);

    expect(await sheets.reject(first.actionId!)).toEqual({ restart: true });
    expect(await sheets.reject(second.actionId!)).toBeNull();
  });

  it("reports a queued change whose sheet is gone, blocks more changes, and fails it without writing", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    let { actionId } = await sheets.queued([{ op: "writeCells", range: "'Q3 Plan'!A1", values: [["x"]] }]);

    provider.sheets = provider.sheets.filter(s => s.id !== 7);

    let conflict = `Queued change ${actionId} no longer applies, so it and the changes queued after it ` +
      "are not shown: change 1 (writeCells): the spreadsheet has no sheet with ID 7.";
    expect((await sheets.info()).queuedChangeConflict).toBe(conflict);
    expect((await sheets.read("Sales!A1")).queuedChangeConflict).toBe(conflict);
    let more = await sheets.update([{ op: "writeCells", range: "Sales!A1", values: [["y"]] }]);
    expect(more.error).toBe(`${conflict} No more changes can be queued until it is rejected.`);
    expect(more.actionId).toBeUndefined();

    expect(await sheets.apply(actionId!)).toBe(
      "This change no longer applies: change 1 (writeCells): the spreadsheet has no sheet with ID 7.");
    expect(provider.batches).toEqual([]);
  });

  it("finds a write whose response was lost landed by its marker, sending it once", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    let { actionId } = await sheets.queued([{ op: "writeCells", range: "Sales!B2", values: [[6]] }]);
    provider.nextFailure = "lost";

    expect(await sheets.apply(actionId!)).toBeNull();

    expect(provider.batches).toHaveLength(1);
    expect(provider.commits).toBe(1);
    let markerId = provider.batches[0][0].createDeveloperMetadata.developerMetadata.metadataId;
    expect(provider.requests.some(url => url.pathname.endsWith(`/developerMetadata/${markerId}`))).toBe(true);
    expect(provider.get("Sales!B2")).toBe(6);
  });

  it("resends a dropped write exactly as first sent, and it lands once", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    let { actionId } = await sheets.queued([{ op: "writeCells", range: "Sales!B2", values: [[6]] }]);
    provider.nextFailure = "dropped";

    expect(await sheets.apply(actionId!)).toBeNull();

    expect(provider.batches).toHaveLength(2);
    expect(provider.batches[1]).toEqual(provider.batches[0]);
    expect(provider.commits).toBe(1);
    expect(provider.get("Sales!B2")).toBe(6);
  });

  it("does not apply a write twice when the first send commits after its resend was sent", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    let { actionId } = await sheets.queued([{ op: "writeCells", range: "Sales!B2", values: [[6]] }]);
    provider.nextFailure = "inflight";

    expect(await sheets.apply(actionId!)).toBeNull();

    // The resend carries the same marker, so Google refuses it once the first send commits.
    expect(provider.batches).toHaveLength(2);
    expect(provider.batches[1]).toEqual(provider.batches[0]);
    expect(provider.commits).toBe(1);
    expect(provider.get("Sales!B2")).toBe(6);
  });

  it("records an unknown outcome for a dropped write it can no longer resend, and deletes its marker later", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    let first = await sheets.queued([{ op: "writeCells", range: "Sales!B2", values: [[6]] }]);
    provider.nextFailure = "dropped";
    provider.afterNextBatch = () => provider.set("Sales!B2", 5);

    expect(await sheets.apply(first.actionId!)).toBe(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(provider.batches).toHaveLength(1);
    expect(provider.commits).toBe(0);
    let lost = provider.batches[0][0].createDeveloperMetadata.developerMetadata.metadataId;

    // Rejected, it no longer blocks the next change, whose batch deletes the lost marker.
    await sheets.reject(first.actionId!);
    let second = await sheets.queued([{ op: "writeCells", range: "Sales!B3", values: [[7]] }]);
    expect(await sheets.apply(second.actionId!)).toBeNull();
    expect(provider.batches[1]).toContainEqual(
      { deleteDeveloperMetadata: { dataFilter: { developerMetadataLookup: { metadataId: lost } } } });
  });

  it("neither replays nor resends a change whose activation died applying it", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    let { actionId } = await sheets.queued([{ op: "writeCells", range: "Sales!B2", values: [[6]] }]);
    expect((await sheets.read("Sales!B2", "raw")).values).toEqual([[6]]);
    await sheets.orphan(actionId!);

    expect((await sheets.read("Sales!B2", "raw")).values).toEqual([[4]]);
    expect(await sheets.apply(actionId!)).toBe(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    expect(provider.batches).toEqual([]);
    expect(provider.get("Sales!B2")).toBe(4);
  });

  it("deletes each batch's marker in the next batch, leaving only the latest", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    let first = await sheets.queued([{ op: "writeCells", range: "Sales!B2", values: [[6]] }]);
    let second = await sheets.queued([{ op: "writeCells", range: "Sales!B3", values: [[7]] }]);
    let third = await sheets.queued([{ op: "writeCells", range: "Sales!B4", values: [[8]] }]);

    expect(await sheets.apply(first.actionId!)).toBeNull();
    expect(await sheets.apply(second.actionId!)).toBeNull();
    expect(await sheets.apply(third.actionId!)).toBeNull();

    let [one, two, three] = provider.batches.map(markerOf);
    expect(provider.batches.map(deletedBy)).toEqual([[], [one], [two]]);
    expect(provider.batches[1].slice(0, 2)).toEqual([
      expect.objectContaining({ createDeveloperMetadata: expect.anything() }),
      { deleteDeveloperMetadata: { dataFilter: { developerMetadataLookup: { metadataId: one } } } },
    ]);
    expect([...provider.markers.keys()]).toEqual([three]);
  });

  it("keeps the 20 newest markers to delete, dropping the oldest", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    let earlier = Array.from({ length: 20 }, (_, i) => i + 1);
    await sheets.seedMarkers(earlier);
    let first = await sheets.queued([{ op: "writeCells", range: "Sales!B2", values: [[6]] }]);
    provider.nextFailure = "dropped";
    provider.afterNextBatch = () => provider.set("Sales!B2", 5);

    expect(await sheets.apply(first.actionId!)).toBe(APPLY_OUTCOME_UNKNOWN_MESSAGE);
    await sheets.reject(first.actionId!);
    let second = await sheets.queued([{ op: "writeCells", range: "Sales!B3", values: [[7]] }]);
    expect(await sheets.apply(second.actionId!)).toBeNull();

    let [lost] = provider.batches.map(markerOf);
    expect(provider.batches.map(deletedBy)).toEqual([earlier, [...earlier.slice(1), lost]]);
  });

  it.each([
    ["quota", 429],
    ["forbidden", 403],
  ] as const)("leaves a change Google refused (%s) pending, and applies it with the same marker", async (failure, status) => {
    let provider = budget();
    let sheets = gatekeeper();
    let { actionId } = await sheets.queued([{ op: "writeCells", range: "Sales!B2", values: [[6]] }]);
    provider.nextFailure = failure;

    expect(await sheets.apply(actionId!)).toContain(`[http=${status}]`);
    expect(provider.commits).toBe(0);

    expect(await sheets.apply(actionId!)).toBeNull();
    expect(provider.batches).toHaveLength(2);
    expect(provider.batches[1][0]).toEqual(provider.batches[0][0]);
    // The marker is recorded before the first send, but no batch deletes its own.
    expect(provider.batches.map(deletedBy)).toEqual([[], []]);
    expect(provider.commits).toBe(1);
  });

  it("fails a change Google refuses as invalid, writing nothing", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    let { actionId } = await sheets.queued([{ op: "writeCells", range: "Sales!B12", values: [[6]] }]);
    // The grid shrinks between the apply's read and its write.
    provider.beforeNextBatch = () => {
      provider.sheets[0] = { ...provider.sheets[0], rowCount: 10 };
    };

    expect(await sheets.apply(actionId!)).toBe(
      "Google Sheets refused this change as invalid [http=400]. It may write to a protected range or " +
      "outside a sheet's grid, or leave a sheet with fewer rows or columns than Google allows.");
    expect(provider.commits).toBe(0);
  });

  it("refuses to queue a change the account can only view, after authorizing the read", async () => {
    let provider = budget();
    provider.canEdit = false;
    let sheets = gatekeeper();

    let outcome = await sheets.update([{ op: "writeCells", range: "Sales!B2", values: [[6]] }]);

    expect(outcome.error).toBe(
      'The connected Google account can view "Budget" but not edit it, so no change to it can be queued.');
    expect(outcome.actionId).toBeUndefined();
    expect(outcome.observations).toHaveLength(1);
  });

  it("refuses to queue a write into a protected range the account may not edit, and never asks who may", async () => {
    let provider = budget([
      sheetMeta(0, "Sales", {
        protectedRanges: [
          // Row 1, but for column C.
          protectedRange(1, { sheetId: 0, startRowIndex: 0, endRowIndex: 1 }, {
            requestingUserCanEdit: false,
            unprotectedRanges: [{ sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 2, endColumnIndex: 3 }],
          }),
          protectedRange(2, { sheetId: 0, startRowIndex: 4, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 2 }, {
            requestingUserCanEdit: false,
          }),
          protectedRange(3, { sheetId: 0, startRowIndex: 9, endRowIndex: 10 }),
        ],
      } as Partial<ProviderSheet>),
    ]);
    let sheets = gatekeeper();

    let row = await sheets.update([{ op: "writeCells", range: "Sales!A1:B1", values: [["x", "y"]] }]);
    expect(row.error).toBe(
      'Change 1 (writeCells): A1 is in a protected range of "Sales", which the connected account may not edit.');
    let block = await sheets.update([
      { op: "writeCells", range: "Sales!A2", values: [["x"]] },
      { op: "clearRange", range: "Sales!B5:C5" },
    ]);
    expect(block.error).toBe(
      "Change 2 (clearRange): B5 is in the protected range Sales!A5:B6, which the connected account " +
      "may not edit.");
    expect(row.actionId ?? block.actionId).toBeUndefined();

    let allowed = await sheets.update([
      { op: "writeCells", range: "Sales!C1", values: [["open"]] },
      { op: "writeCells", range: "Sales!A10", values: [["editable"]] },
    ]);
    expect(allowed.actionId).toEqual(expect.any(Number));
    expect(provider.masks.some(mask => mask.includes("protectedRanges"))).toBe(true);
    expect(provider.masks.filter(mask => mask.includes("editors"))).toEqual([]);
  });

  it.each([
    ["IMPORTRANGE", '=importrange("https://docs.google.com/x", "A1")'],
    ["IMPORTDATA", '=ImportData("https://example.com/a.csv")'],
    ["IMPORTHTML", '=IMPORTHTML("https://example.com", "table", 1)'],
    ["IMPORTXML", '=SUM(1, ImportXml("https://example.com", "//a"))'],
    ["IMPORTFEED", '=importfeed("https://example.com/feed")'],
    ["IMAGE", '=IMAGE("https://example.com/a.png")'],
  ])("refuses a formula calling %s before reading anything", async (name, formula) => {
    let provider = budget();
    let sheets = gatekeeper();

    let outcome = await sheets.update([{ op: "writeCells", range: "Sales!A1", values: [[formula]] }]);

    expect(outcome.error).toContain(`uses ${name}`);
    expect(outcome.actionId).toBeUndefined();
    expect(outcome.observations).toEqual([]);
    expect(provider.requests).toEqual([]);
  });
});

describe("Google Sheets changes to rows, columns and sheets", () => {
  it("inserts rows and writes into them in one batch, landing where the read previewed", async () => {
    let provider = budget();
    provider.results["=B2*2"] = 8;
    let sheets = gatekeeper();

    let { actionId, action, value } = await sheets.queued([
      { op: "insertRows", sheetId: 0, at: 3, count: 2 },
      { op: "writeCells", range: "Sales!A3:B4", values: [["LATAM", 2], ["ANZ", 3]] },
    ]);

    expect(value).toEqual({});
    expect(action).toMatchObject({ title: 'Edit "Sales"', autoApprovable: false });
    expect(action!.description).toContain(
      "Makes 2 changes, all or none of which are applied:\n\n" +
      '1. In "Sales", insert 2 rows before row 3\n' +
      '2. In "Sales", set A3:B4 to the values below');
    expect(await sheets.autoApprovable()).toEqual(AUTO_APPROVABLE);
    let previewed = await sheets.read("Sales!A1:C5", "formula");
    expect(previewed).toEqual({
      range: "Sales!A1:C5",
      values: [
        ["Region", "Total", null], ["EMEA", 4, "=B2*2"], ["LATAM", 2, null], ["ANZ", 3, null], ["APAC", 5, null],
      ],
    });
    // The formula's reference keeps its cell, so its saved result still holds.
    expect(await sheets.read("Sales!A2:C5", "raw")).toEqual({
      range: "Sales!A2:C5", values: [["EMEA", 4, 8], ["LATAM", 2, null], ["ANZ", 3, null], ["APAC", 5, null]],
    });
    expect((await sheets.info()).sheets[0]).toEqual({ id: 0, title: "Sales", index: 0, rowCount: 22, columnCount: 6 });

    expect(await sheets.apply(actionId!)).toBeNull();

    expect(changeRequests(provider.batches[0])).toEqual([
      { insertDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 2, endIndex: 4 }, inheritFromBefore: true } },
      {
        updateCells: {
          range: { sheetId: 0, startRowIndex: 2, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 2 },
          rows: [
            { values: [{ userEnteredValue: { stringValue: "LATAM" } }, { userEnteredValue: { numberValue: 2 } }] },
            { values: [{ userEnteredValue: { stringValue: "ANZ" } }, { userEnteredValue: { numberValue: 3 } }] },
          ],
          fields: "userEnteredValue",
        },
      },
    ]);
    expect(await sheets.read("Sales!A1:C5", "formula")).toEqual(previewed);
  });

  it("reads queued rows in every mode, a saved formula whose range grows pending", async () => {
    let provider = budget();
    provider.set("Sales!D2", "=SUM(B2:B3)");
    provider.results["=B2*2"] = 8;
    provider.results["=SUM(B2:B3)"] = 9;
    let sheets = gatekeeper();
    let { actionId } = await sheets.queued([{ op: "insertRows", sheetId: 0, at: 3 }]);
    let blank = [null, null, null, null];

    expect(await sheets.read("Sales!A2:D4", "formula")).toEqual({
      range: "Sales!A2:D4", values: [["EMEA", 4, "=B2*2", "=SUM(B2:B4)"], blank, ["APAC", 5, null, null]],
    });
    expect(await sheets.read("Sales!A2:D4", "raw")).toEqual({
      range: "Sales!A2:D4", values: [["EMEA", 4, 8, null], blank, ["APAC", 5, null, null]], pendingCells: ["D2"],
    });
    expect(await sheets.read("Sales!A2:D4")).toEqual({
      range: "Sales!A2:D4", values: [["EMEA", "4", "8", null], blank, ["APAC", "5", null, null]], pendingCells: ["D2"],
    });
    // Clipped to the sheet as the queued rows leave it, as Google clips a range.
    expect(await sheets.read("Sales!A20:A23", "raw")).toEqual({ range: "Sales!A20:A21", values: [[null], [null], [null], [null]] });
    // Each refusal tells what the spreadsheet holds, so it comes only after the read is authorized.
    let outside = await sheets.call("readRange", "Sales!A22");
    expect(outside.error).toBe("Range (Sales!A22) exceeds grid limits. Max rows: 21, max columns: 6");
    expect(outside.observations).toEqual([
      "Looked up 1 range(s) in the connected spreadsheet with the queued changes applied."]);
    let missing = await sheets.call("readRange", "Nope!A1");
    expect(missing.error).toBe('The spreadsheet has no sheet named "Nope" with the queued changes applied.');
    expect(missing.observations).toHaveLength(1);

    expect(await sheets.apply(actionId!)).toBeNull();
    expect(provider.get("Sales!D2")).toBe("=SUM(B2:B4)");
    expect(provider.get("Sales!A4")).toBe("APAC");
  });

  it("returns the IDs it mints for the sheets a batch adds, which Google honours", async () => {
    let provider = budget();
    let sheets = gatekeeper();

    let { actionId, action, value } = await sheets.queued([
      { op: "addSheet", title: "Q4", ref: "q4" },
      { op: "writeCells", range: "q4!A1", values: [["Forecast"]] },
      { op: "insertRows", sheetId: "q4", at: 1001, count: 5 },
    ]);

    let q4 = (value as Record<string, number>).q4;
    expect(value).toEqual({ q4: expect.any(Number) });
    expect(Number.isInteger(q4) && q4 >= 1 && q4 <= MAX_SHEET_ID && q4 !== 7).toBe(true);
    expect(action).toMatchObject({ title: 'Edit "Q4"', autoApprovable: false });
    expect(action!.description).toContain(
      '1. Add a sheet "Q4" of 1,000 rows and 26 columns at position 3\n' +
      '2. In "Q4", set A1 to the values below\n' +
      '3. In "Q4", add 5 rows after row 1000');
    expect((await sheets.info()).sheets).toContainEqual({ id: q4, title: "Q4", index: 2, rowCount: 1005, columnCount: 26 });
    // Google holds nothing of a sheet a queued change adds, so reading it fetches no values.
    let reads = valueReads(provider);
    expect(await sheets.read("'Q4'!A1:B2", "raw")).toEqual({ range: "'Q4'!A1:B2", values: [["Forecast", null], [null, null]] });
    expect(valueReads(provider)).toBe(reads);

    expect(await sheets.apply(actionId!)).toBeNull();

    expect(changeRequests(provider.batches[0])).toEqual([
      { addSheet: { properties: { sheetId: q4, title: "Q4", index: 2, gridProperties: { rowCount: 1000, columnCount: 26 } } } },
      {
        updateCells: {
          range: { sheetId: q4, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
          rows: [{ values: [{ userEnteredValue: { stringValue: "Forecast" } }] }],
          fields: "userEnteredValue",
        },
      },
      { insertDimension: { range: { sheetId: q4, dimension: "ROWS", startIndex: 1000, endIndex: 1005 }, inheritFromBefore: true } },
    ]);
    expect(provider.sheets.find(s => s.id === q4)).toMatchObject({ title: "Q4", index: 2, rowCount: 1005, columnCount: 26 });
    expect(provider.get("Q4!A1")).toBe("Forecast");
  });

  it("writes to a sheet by the title an earlier change of the batch renames it to", async () => {
    let provider = budget();
    provider.set("Sales!E2", "='Q3 Plan'!A1");
    provider.results["='Q3 Plan'!A1"] = 3;
    let sheets = gatekeeper();

    let { actionId, action } = await sheets.queued([
      { op: "renameSheet", sheetId: 7, title: "Q3 Final" },
      { op: "writeCells", range: "'q3 final'!A1", values: [["=sales!b2*2"]] },
    ]);

    expect(action).toMatchObject({
      title: 'Edit "Q3 Plan"',
      fields: [
        { label: "Change 2: Values", kind: "text", value: '["=Sales!B2*2"]' },
        { label: "Change 2: Formulas", kind: "text", value: "A1: =Sales!B2*2" },
      ],
    });
    expect(action!.description).toContain(
      '1. Rename "Q3 Plan" to "Q3 Final"\n2. In "Q3 Final", set A1 to the values below');
    expect((await sheets.info()).sheets.map(s => s.title)).toEqual(["Sales", "Q3 Final"]);
    expect(await sheets.read("'Q3 Final'!A1", "formula")).toEqual({ range: "'Q3 Final'!A1", values: [["=Sales!B2*2"]] });
    // A rename leaves a reference's cells as they were, so the saved result holds.
    expect(await sheets.read("Sales!E2", "formula")).toEqual({ range: "Sales!E2", values: [["='Q3 Final'!A1"]] });
    expect(await sheets.read("Sales!E2", "raw")).toEqual({ range: "Sales!E2", values: [[3]] });
    expect((await sheets.call("readRange", "'Q3 Plan'!A1")).error).toBe(
      'The spreadsheet has no sheet named "Q3 Plan" with the queued changes applied.');

    expect(await sheets.apply(actionId!)).toBeNull();

    expect(changeRequests(provider.batches[0])[0]).toEqual(
      { updateSheetProperties: { properties: { sheetId: 7, title: "Q3 Final" }, fields: "title" } });
    expect(provider.get("'Q3 Final'!A1")).toBe("=Sales!B2*2");
    expect(provider.get("Sales!E2")).toBe("='Q3 Final'!A1");
  });

  it("names the sheets a batch only adds", async () => {
    budget();
    let sheets = gatekeeper();
    let one = await sheets.queued([{ op: "addSheet", title: "Q4" }]);
    expect(one.action).toMatchObject({ title: 'Add the sheet "Q4"' });
    let two = await sheets.queued([{ op: "addSheet", title: "Q5" }, { op: "addSheet", title: "Q6" }]);
    expect(two.action).toMatchObject({ title: "Add 2 sheets" });
  });

  it("describes every change to rows, columns and sheets, and sends each as Google accepts it", async () => {
    let provider = budget();
    let sheets = gatekeeper();

    let { actionId, action, value } = await sheets.queued([
      { op: "addSheet", title: "Q4", ref: "q4", rowCount: 5, columnCount: 3 },
      { op: "renameSheet", sheetId: 7, title: "Plan_B" },
      { op: "duplicateSheet", sheetId: 0 },
      { op: "insertRows", sheetId: "q4", at: 6, count: 2 },
      { op: "insertRows", sheetId: 0, at: 2 },
      { op: "deleteRows", sheetId: 0, at: 5, count: 2 },
      { op: "insertColumns", sheetId: 7, at: "E" },
      { op: "deleteColumns", sheetId: 7, at: "b", count: 2 },
      { op: "deleteColumns", sheetId: 0, at: "F" },
      { op: "deleteRows", sheetId: 0, at: 1 },
      { op: "deleteSheet", sheetId: "q4" },
      { op: "insertColumns", sheetId: 0, at: "A", count: 3 },
    ]);

    // Q4, It's, Sales and the copy of Sales.
    expect(action).toMatchObject({ title: "Edit 4 sheets", autoApprovable: false });
    expect(action!.description).toContain(
      "Makes 12 changes, all or none of which are applied:\n\n" +
      '1. Add a sheet "Q4" of 5 rows and 3 columns at position 3\n' +
      '2. Rename "Q3 Plan" to "PlanB"\n' +
      '3. Copy "Sales" as "Copy of Sales" at position 2\n' +
      '4. In "Q4", add 2 rows after row 5\n' +
      '5. In "Sales", insert 1 row before row 2\n' +
      '6. In "Sales", delete rows 5 to 6\n' +
      '7. In "PlanB", add 1 column after column D\n' +
      '8. In "PlanB", delete columns B to C\n' +
      '9. In "Sales", delete column F\n' +
      '10. In "Sales", delete row 1\n' +
      '11. Delete the sheet "Q4" (7 rows, 3 columns) and everything on it\n' +
      '12. In "Sales", insert 3 columns before column A');
    // The prose drops the underscore, so the title is also given exactly.
    expect(action!.fields).toEqual([
      { label: "Change 2: New title", kind: "inline", value: "Plan_B" },
      { label: "Change 7: Sheet", kind: "inline", value: "Plan_B" },
      { label: "Change 8: Sheet", kind: "inline", value: "Plan_B" },
    ]);
    let shown = (await sheets.info()).sheets.map(s => [s.title, s.index, s.rowCount, s.columnCount]);
    expect(shown).toEqual([["Sales", 0, 18, 8], ["Copy of Sales", 1, 20, 6], ["Plan_B", 2, 10, 3]]);
    // Sales's old row 2 is its second row, three columns along; the copy keeps the original's.
    expect(await sheets.read("Sales!D2:F2", "formula")).toEqual({ range: "Sales!D2:F2", values: [["EMEA", 4, "=E2*2"]] });
    expect(await sheets.read("'Copy of Sales'!A2:C2", "formula"))
      .toEqual({ range: "'Copy of Sales'!A2:C2", values: [["EMEA", 4, "=B2*2"]] });

    expect(await sheets.apply(actionId!)).toBeNull();

    let sent = changeRequests(provider.batches[0]);
    let q4 = (value as Record<string, number>).q4;
    let copy = sent[2].duplicateSheet?.newSheetId;
    expect(sent).toEqual([
      { addSheet: { properties: { sheetId: q4, title: "Q4", index: 2, gridProperties: { rowCount: 5, columnCount: 3 } } } },
      { updateSheetProperties: { properties: { sheetId: 7, title: "Plan_B" }, fields: "title" } },
      { duplicateSheet: { sourceSheetId: 0, newSheetId: copy, insertSheetIndex: 1, newSheetName: "Copy of Sales" } },
      { insertDimension: { range: { sheetId: q4, dimension: "ROWS", startIndex: 5, endIndex: 7 }, inheritFromBefore: true } },
      { insertDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 2 }, inheritFromBefore: true } },
      { deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 4, endIndex: 6 } } },
      { insertDimension: { range: { sheetId: 7, dimension: "COLUMNS", startIndex: 4, endIndex: 5 }, inheritFromBefore: true } },
      { deleteDimension: { range: { sheetId: 7, dimension: "COLUMNS", startIndex: 1, endIndex: 3 } } },
      { deleteDimension: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 5, endIndex: 6 } } },
      { deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 0, endIndex: 1 } } },
      { deleteSheet: { sheetId: q4 } },
      { insertDimension: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 0, endIndex: 3 }, inheritFromBefore: false } },
    ]);
    expect(provider.sheets.toSorted((a, b) => a.index - b.index).map(s => [s.title, s.index, s.rowCount, s.columnCount]))
      .toEqual(shown);
    expect(provider.get("Sales!F2")).toBe("=E2*2");
    expect(provider.get("'Copy of Sales'!C2")).toBe("=B2*2");
  });

  it("reports a queued deleteSheet whose sheet a collaborator deleted, and fails it without writing", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    let { actionId, action } = await sheets.queued([{ op: "deleteSheet", sheetId: 7 }]);

    expect(action).toMatchObject({
      title: 'Edit "Q3 Plan"',
      description: 'Delete the sheet "Q3 Plan" (10 rows, 4 columns) and everything on it.',
      autoApprovable: false,
    });
    expect((await sheets.info()).sheets.map(s => s.title)).toEqual(["Sales"]);

    provider.sheets = provider.sheets.filter(s => s.id !== 7);

    let conflict = `Queued change ${actionId} no longer applies, so it and the changes queued after it ` +
      "are not shown: change 1 (deleteSheet): the spreadsheet has no sheet with ID 7.";
    expect((await sheets.info()).queuedChangeConflict).toBe(conflict);
    expect(await sheets.read("Sales!A1")).toEqual({ range: "Sales!A1", values: [["Region"]], queuedChangeConflict: conflict });
    expect(await sheets.apply(actionId!)).toBe(
      "This change no longer applies: change 1 (deleteSheet): the spreadsheet has no sheet with ID 7.");
    expect(provider.batches).toEqual([]);
  });

  it("refuses to delete rows a collaborator edited since they were queued, and deletes them otherwise", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    let edited = await sheets.queued([{ op: "deleteRows", sheetId: 0, at: 3 }]);
    expect(edited.action!.description).toBe('In "Sales", delete row 3.');

    provider.set("Sales!F3", "note");
    expect(await sheets.apply(edited.actionId!)).toBe(CHANGED);
    expect(provider.batches).toEqual([]);
    await sheets.reject(edited.actionId!);

    provider.set("Sales!A4", "ANZ");
    let unedited = await sheets.queued([{ op: "deleteRows", sheetId: 0, at: 2, count: 2 }]);
    expect(unedited.action!.description).toBe('In "Sales", delete rows 2 to 3.');
    provider.set("Sales!F9", "elsewhere");
    expect(await sheets.apply(unedited.actionId!)).toBeNull();
    expect(provider.sheets[0].rowCount).toBe(18);
    expect([provider.get("Sales!A1"), provider.get("Sales!A2"), provider.get("Sales!F7")])
      .toEqual(["Region", "ANZ", "elsewhere"]);
  });

  it("fails a batch built on a rejected change to rows, without writing", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    let inserted = await sheets.queued([{ op: "insertRows", sheetId: 0, at: 2 }]);
    let written = await sheets.queued([{ op: "writeCells", range: "Sales!A2", values: [["new"]] }]);

    expect(await sheets.reject(inserted.actionId!)).toEqual({ restart: true });
    expect(await sheets.apply(written.actionId!)).toBe(
      `This change no longer applies: it builds on change ${inserted.actionId}, which was not applied.`);
    expect(provider.batches).toEqual([]);
    expect(provider.get("Sales!A2")).toBe("EMEA");
  });

  it("refuses any change to the rows, columns or tab of a sheet holding a range the account may not edit", async () => {
    budget([
      sheetMeta(0, "Sales", {
        protectedRanges: [
          protectedRange(2, { sheetId: 0, startRowIndex: 4, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 2 }, {
            requestingUserCanEdit: false,
          }),
        ],
      } as Partial<ProviderSheet>),
      sheetMeta(7, "Q3 Plan", { index: 1, rowCount: 10, columnCount: 4 }),
    ]);
    let sheets = gatekeeper();

    for (let change of [
      { op: "insertRows", sheetId: 0, at: 21 },
      { op: "renameSheet", sheetId: 0, title: "Sales 2026" },
    ] satisfies SheetChange[]) {
      let outcome = await sheets.update([change]);
      expect(outcome.error).toBe(
        `Change 1 (${change.op}): "Sales" holds the protected range Sales!A5:B6, which the connected account may ` +
        "not edit, so its rows, columns and tab cannot be changed.");
      expect(outcome.actionId).toBeUndefined();
    }
    expect((await sheets.update([{ op: "insertRows", sheetId: 7, at: 11 }])).actionId).toEqual(expect.any(Number));
  });

  it("applies a batch queued before guards named their cells, guarding the cells it writes", async () => {
    let provider = budget();
    let journal = new ActionJournal<SheetsAction>(memoryKv(), { namespace: "sheets" });
    let markers: number[] = [];
    let actions = SHEETS_ACTIONS.bind(journal, {
      api: new GoogleSheetsApi(async () => "access-token"),
      spreadsheetId: "sheet-1",
      applied: () => true,
      markers: { read: () => markers, write: ids => { markers = ids; } },
    });
    let submitter = { submitAction: async () => {} };
    let stale = await actions.submit(submitter, "editSheetValues", await cellsOnlyBatch(5, [4, "=B2*2"]));
    let fresh = await actions.submit(submitter, "editSheetValues", await cellsOnlyBatch(6, [4, "=B2*2"]));

    await actions.apply(fresh);
    expect([provider.get("Sales!B2"), provider.get("Sales!C2")]).toEqual([6, "done"]);
    await expect(actions.apply(stale)).rejects.toThrow(CHANGED);
    expect(provider.batches).toHaveLength(1);
  });
});

describe("Google Sheets formatting", () => {
  it("queues formatting alone as auto-approvable, shows it in reads, and writes it as Google accepts it", async () => {
    let provider = budget();
    provider.setFormat("Sales!B2", { textFormat: { italic: true }, numberFormat: { type: "NUMBER", pattern: "0.0" } });
    let sheets = gatekeeper();

    let { actionId, action, value } = await sheets.queued([{
      op: "formatCells", range: "Sales!A1:B2",
      format: {
        bold: true, fontSize: 14, textColor: "#FF0000", fillColor: "ACCENT1",
        numberFormat: { type: "CURRENCY", pattern: '"$"#,##0.00' }, horizontalAlignment: "RIGHT", wrap: "WRAP",
        borders: { top: { style: "SOLID" } },
      },
    }]);

    expect(value).toEqual({});
    expect(action).toMatchObject({
      title: 'Format "Sales"',
      description: 'In "Sales", format A1:B2: bold, 14 pt, text colour #ff0000, fill ACCENT1, number format ' +
        "CURRENCY (pattern below), aligned right, wrapped, a solid top border.",
      autoApprovable: true,
      actionKind: { tag: "formatSheets", label: "Sheet formatting" },
      descriptionIsComplete: true,
      fields: [{ label: "Number format", kind: "text", value: '"$"#,##0.00' }],
    });
    expect(await sheets.autoApprovable()).toEqual(AUTO_APPROVABLE);

    let set = {
      bold: true, fontSize: 14, textColor: "#ff0000", fillColor: "ACCENT1",
      numberFormat: { type: "CURRENCY", pattern: '"$"#,##0.00' }, horizontalAlignment: "RIGHT", wrap: "WRAP",
    };
    let previewed = await sheets.formats("Sales!A1:B3");
    // Nothing is beside the top edge of row 1, so no cell is pending.
    expect(previewed).toEqual({
      range: "Sales!A1:B3",
      formats: [
        [{ ...set, borders: { top: { style: "SOLID" } } }, { ...set, borders: { top: { style: "SOLID" } } }],
        [set, { ...set, italic: true }],
        [null, null],
      ],
    });
    // Only Google can display a value in the number format the change sets; raw values are unaffected.
    expect(await sheets.read("Sales!A1:C2")).toEqual({
      range: "Sales!A1:C2", values: [[null, null, null], [null, null, "0"]], pendingCells: ["A1", "B1", "A2", "B2"],
    });
    expect(await sheets.read("Sales!A1:B2", "raw")).toEqual({
      range: "Sales!A1:B2", values: [["Region", "Total"], ["EMEA", 4]],
    });

    expect(await sheets.apply(actionId!)).toBeNull();

    let range = { sheetId: 0, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2 };
    expect(changeRequests(provider.batches[0])).toEqual([
      {
        repeatCell: {
          range,
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true, fontSize: 14, foregroundColorStyle: { rgbColor: { red: 1, green: 0, blue: 0 } } },
              backgroundColorStyle: { themeColor: "ACCENT1" },
              numberFormat: { type: "CURRENCY", pattern: '"$"#,##0.00' },
              horizontalAlignment: "RIGHT",
              wrapStrategy: "WRAP",
            },
          },
          fields: "userEnteredFormat(textFormat(bold,fontSize,foregroundColorStyle),backgroundColorStyle," +
            "numberFormat,horizontalAlignment,wrapStrategy)",
        },
      },
      { updateBorders: { range, top: { style: "SOLID", colorStyle: { rgbColor: { red: 0, green: 0, blue: 0 } } } } },
    ]);
    expect(provider.get("Sales!A1")).toBe("Region");
    expect(await sheets.formats("Sales!A1:B3")).toEqual(previewed);
    expect(provider.formatMasks.length).toBeGreaterThan(0);
  });

  it("resets fields and removes borders, and the facing border of the cells beside a changed outer edge", async () => {
    let provider = budget();
    provider.setFormat("Sales!B1", { borders: { bottom: { style: "DASHED" } } });
    provider.setFormat("Sales!B2", {
      textFormat: { bold: true, italic: true }, numberFormat: { type: "PERCENT" },
      borders: { top: { style: "DASHED" }, bottom: { style: "SOLID" } },
    });
    let sheets = gatekeeper();

    let { actionId, action } = await sheets.queued([{
      op: "formatCells", range: "Sales!B2:C3",
      format: {
        bold: null, numberFormat: null,
        borders: {
          top: null, right: { style: "DOUBLE", color: "#00FF00" }, innerHorizontal: { style: "DOTTED", color: "ACCENT2" },
        },
      },
    }]);

    expect(action!.description).toBe(
      'In "Sales", format B2:C3: default bold, default number format, no top border, a double right border ' +
      "in #00ff00, a dotted inner horizontal border in ACCENT2.");
    expect(action!.fields ?? []).toEqual([]);
    let dotted = { style: "DOTTED", color: "ACCENT2" };
    let double = { style: "DOUBLE", color: "#00ff00" };
    let changed = [
      [{ italic: true, borders: { bottom: dotted } }, { borders: { bottom: dotted, right: double } }],
      [{ borders: { top: dotted } }, { borders: { top: dotted, right: double } }],
    ];
    // B2:C3's top edge takes B1's bottom border with it, as Google gives an edge one owner.
    let around = {
      range: "Sales!A1:D4",
      formats: [
        [null, null, null, null],
        [null, ...changed[0], null],
        [null, ...changed[1], null],
        [null, null, null, null],
      ],
    };
    expect(await sheets.formats("Sales!A1:D4")).toEqual(around);
    // A number format reset is as unknown to the display as one set, blank cells included.
    expect(await sheets.read("Sales!B2:C3")).toEqual({
      range: "Sales!B2:C3", values: [[null, null], [null, null]], pendingCells: ["B2", "C2", "B3", "C3"],
    });

    expect(await sheets.apply(actionId!)).toBeNull();

    let range = { sheetId: 0, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 1, endColumnIndex: 3 };
    expect(changeRequests(provider.batches[0])).toEqual([
      { repeatCell: { range, cell: { userEnteredFormat: {} }, fields: "userEnteredFormat(textFormat(bold),numberFormat)" } },
      {
        updateBorders: {
          range,
          top: { style: "NONE" },
          right: { style: "DOUBLE", colorStyle: { rgbColor: { red: 0, green: 1, blue: 0 } } },
          innerHorizontal: { style: "DOTTED", colorStyle: { themeColor: "ACCENT2" } },
        },
      },
    ]);
    expect(provider.getFormat("Sales!B2")).toEqual({
      textFormat: { italic: true }, borders: { bottom: { style: "DOTTED", colorStyle: { themeColor: "ACCENT2" } } },
    });
    expect((await sheets.formats("Sales!B2:C3")).formats).toEqual(changed);
    expect(await sheets.formats("Sales!A1:D4")).toEqual(around);
  });

  it("queues formatting with any other change for approval, and names each sheet a formatting batch formats", async () => {
    budget();
    let sheets = gatekeeper();

    let mixed = await sheets.queued([
      { op: "writeCells", range: "Sales!A5", values: [["x"]] },
      { op: "formatCells", range: "Sales!A5", format: { italic: true, verticalAlignment: "MIDDLE" } },
    ]);
    expect(mixed.action).toMatchObject({ title: 'Edit "Sales"', autoApprovable: false });
    expect(mixed.action!.actionKind).toBeUndefined();
    expect(mixed.action!.description).toContain(
      "Makes 2 changes, all or none of which are applied:\n\n" +
      '1. In "Sales", set A5 to the values below\n' +
      '2. In "Sales", format A5: italic, vertically centred');

    let formatting = await sheets.queued([
      { op: "formatCells", range: "Sales!A1", format: { fillColor: null } },
      {
        op: "formatCells", range: "'Q3 Plan'!A1:B1",
        format: { underline: true, strikethrough: false, horizontalAlignment: "CENTER", wrap: "CLIP", numberFormat: { type: "DATE" } },
      },
      {
        op: "formatCells", range: "Sales!B1",
        format: {
          numberFormat: { type: "NUMBER", pattern: "0.0" },
          borders: { innerVertical: { style: "SOLID_THICK" }, left: { style: "DASHED", color: "TEXT" } },
        },
      },
    ]);
    expect(formatting.action).toMatchObject({
      title: "Format 2 sheets",
      autoApprovable: true,
      actionKind: { tag: "formatSheets", label: "Sheet formatting" },
      fields: [{ label: "Change 3: Number format", kind: "text", value: "0.0" }],
    });
    expect(formatting.action!.description).toContain(
      "Makes 3 changes, all or none of which are applied:\n\n" +
      '1. In "Sales", format A1: default fill\n' +
      '2. In "Q3 Plan", format A1:B1: underlined, not struck through, number format DATE, centred, clipped\n' +
      '3. In "Sales", format B1: number format NUMBER (pattern below), a dashed left border in TEXT, a thick ' +
      "solid inner vertical border");
  });

  it("formats cells where queued rows move them, reading inserted rows' formats pending", async () => {
    let provider = budget();
    provider.setFormat("Sales!A2", { textFormat: { bold: true } });
    provider.setFormat("Sales!A3", { textFormat: { italic: true } });
    let sheets = gatekeeper();

    let rows = await sheets.queued([{ op: "insertRows", sheetId: 0, at: 3 }]);
    expect(await sheets.formats("Sales!A2:A4")).toEqual({
      range: "Sales!A2:A4", formats: [[{ bold: true }], [null], [{ italic: true }]], pendingCells: ["A3"],
    });
    // The rows around the inserted one are read by grid range, as no A1 range names them.
    expect(provider.requests.some(url => url.pathname.endsWith(":getByDataFilter"))).toBe(true);

    let format = await sheets.queued([{ op: "formatCells", range: "Sales!A4", format: { fontSize: 9 } }]);
    expect(format.action).toMatchObject({ title: 'Format "Sales"', autoApprovable: true });
    expect((await sheets.formats("Sales!A4")).formats).toEqual([[{ italic: true, fontSize: 9 }]]);

    expect(await sheets.apply(rows.actionId!)).toBeNull();
    expect(await sheets.apply(format.actionId!)).toBeNull();

    expect(changeRequests(provider.batches[1])).toEqual([{
      repeatCell: {
        range: { sheetId: 0, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { fontSize: 9 } } },
        fields: "userEnteredFormat(textFormat(fontSize))",
      },
    }]);
    expect(provider.getFormat("Sales!A4")).toEqual({ textFormat: { italic: true, fontSize: 9 } });
  });

  it("fails formatting built on rows a rejected change was to insert, without writing", async () => {
    let provider = budget();
    let sheets = gatekeeper();
    let rows = await sheets.queued([{ op: "insertRows", sheetId: 0, at: 3 }]);
    let format = await sheets.queued([{ op: "formatCells", range: "Sales!A4", format: { bold: true } }]);

    await sheets.reject(rows.actionId!);

    expect(await sheets.apply(format.actionId!)).toBe(
      `This change no longer applies: it builds on change ${rows.actionId}, which was not applied.`);
    expect(provider.batches).toEqual([]);
  });

  it("copies queued formatting with the sheet a queued change duplicates", async () => {
    let provider = budget();
    provider.setFormat("Sales!A2", { textFormat: { italic: true } });
    let sheets = gatekeeper();
    let format = await sheets.queued([{ op: "formatCells", range: "Sales!A1", format: { bold: true } }]);
    let copy = await sheets.queued([{ op: "duplicateSheet", sheetId: 0, title: "Copy" }]);

    let previewed = await sheets.formats("Copy!A1:A2");
    expect(previewed).toEqual({ range: "Copy!A1:A2", formats: [[{ bold: true }], [{ italic: true }]] });

    expect(await sheets.apply(format.actionId!)).toBeNull();
    expect(await sheets.apply(copy.actionId!)).toBeNull();
    expect(await sheets.formats("Copy!A1:A2")).toEqual(previewed);
  });
});
