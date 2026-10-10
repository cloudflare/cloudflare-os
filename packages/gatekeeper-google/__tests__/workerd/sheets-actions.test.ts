import { env } from "cloudflare:test";
import { APPLY_OUTCOME_UNKNOWN_MESSAGE } from "@gadgets/gatekeeper-kit/actions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { a1Of, parseRange, type Rect } from "../../src/sheets-model";
import type { SpreadsheetInfo, SpreadsheetRange, SpreadsheetValueMode } from "../../src/sheets-read-types";
import type { SheetMeta } from "../../src/sheets-simulation";
import type { SheetCellInput, SheetChange } from "../../src/sheets-types";
import { protectedRange, sheet as sheetMeta, spreadsheetMetadata, type FixtureGridRange } from "../sheets-fixture";

type BatchRequest = Record<string, any>;

class Invalid extends Error {}

/** A sheet of the fake spreadsheet, and the ranges it protects. */
type ProviderSheet = SheetMeta & { protectedRanges?: ReturnType<typeof protectedRange>[] };

const key = (sheetId: number, row: number, column: number) => `${sheetId}:${row}:${column}`;

/**
 * Google Sheets as far as these tests need it: metadata honouring its field mask, value reads in
 * each mode, data-filter reads answered out of order, developer metadata, Drive's `canEdit`, and
 * an atomic `batchUpdate` of the requests the gatekeeper sends.
 */
class SheetsProvider {
  title = "Budget";
  cells = new Map<string, SheetCellInput>();
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
    return Response.json({
      valueRanges: url.searchParams.getAll("ranges").map(range => {
        let parsed = parseRange(range);
        let sheet = parsed.sheet === undefined
          ? this.sheets.find(s => !s.hidden)!
          : this.sheets.find(s => s.title.toLowerCase() === parsed.sheet!.toLowerCase())!;
        let { rect, values } = this.#values(sheet, parsed.rect, mode);
        return { range: a1Of(sheet.title, rect), majorDimension: "ROWS", ...(values ? { values } : {}) };
      }),
    });
  }

  #byDataFilter(body: { dataFilters: { gridRange: Required<FixtureGridRange> }[]; valueRenderOption: string }): Response {
    expect(body.valueRenderOption).toBe("FORMULA");
    let answers = body.dataFilters.map(({ gridRange }) => {
      let sheet = this.sheets.find(s => s.id === gridRange.sheetId)!;
      let { rect, values } = this.#values(sheet, {
        startRow: gridRange.startRowIndex, endRow: gridRange.endRowIndex,
        startColumn: gridRange.startColumnIndex, endColumn: gridRange.endColumnIndex,
      }, "FORMULA");
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
    let cells = new Map(this.cells);
    let markers = new Map(this.markers);
    try {
      for (let request of requests) this.#apply(request, cells, markers);
    } catch (error) {
      if (error instanceof Invalid) return false;
      throw error;
    }
    this.cells = cells;
    this.markers = markers;
    this.commits++;
    return true;
  }

  #apply(
    request: BatchRequest, cells: Map<string, SheetCellInput>,
    markers: Map<number, { metadataKey: string; metadataValue: string }>,
  ): void {
    if (request.createDeveloperMetadata) {
      let { metadataId, metadataKey, metadataValue, location, visibility } =
        request.createDeveloperMetadata.developerMetadata;
      if (markers.has(metadataId) || !location?.spreadsheet || visibility !== "PROJECT") throw new Invalid();
      markers.set(metadataId, { metadataKey, metadataValue });
    } else if (request.deleteDeveloperMetadata) {
      markers.delete(request.deleteDeveloperMetadata.dataFilter.developerMetadataLookup.metadataId);
    } else if (request.updateCells) {
      let { range, rows, fields } = request.updateCells;
      let sheet = this.sheets.find(s => s.id === range.sheetId);
      if (!sheet || fields !== "userEnteredValue" || range.endRowIndex > sheet.rowCount ||
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
    } else {
      throw new Invalid();
    }
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
    info: async () => (await call("getSpreadsheet")).value as SpreadsheetInfo,
    apply: (actionId: number) => hooks().applySheets(facet, actionId),
    reject: (actionId: number) => hooks().rejectSheets(facet, actionId),
    autoApprovable: () => hooks().sheetsAutoApprovable(facet),
    seedMarkers: (ids: number[]) => hooks().seedSheetsMarkers(facet, ids),
    orphan: (actionId: number) => hooks().orphanSheetsClaim(facet, actionId),
  };
}

function budget(sheets: ProviderSheet[] = [sheetMeta(0, "Sales"), sheetMeta(7, "Q3 Plan", { index: 1, rowCount: 10, columnCount: 4 })]) {
  return new SheetsProvider(sheets, {
    "Sales!A1": "Region", "Sales!B1": "Total",
    "Sales!A2": "EMEA", "Sales!B2": 4, "Sales!C2": "=B2*2",
    "Sales!A3": "APAC", "Sales!B3": 5,
  }).install();
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

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(await sheets.autoApprovable()).toEqual([{ tag: "editSheetValues", label: "Sheet value edits" }]);
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
    expect(await sheets.autoApprovable()).toEqual([{ tag: "editSheetValues", label: "Sheet value edits" }]);

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
      "This change no longer applies: cells it overwrites, or a sheet it writes to, changed since it " +
      "was queued.");
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
      "This change no longer applies: cells it overwrites, or a sheet it writes to, changed since it " +
      "was queued.");
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
      "This change no longer applies: cells it overwrites, or a sheet it writes to, changed since it " +
      "was queued.");
    await sheets.reject(rejected.actionId!);

    expect(await sheets.apply(later.actionId!)).toBe(
      `This change no longer applies: it overwrites cells change ${failed.actionId} writes, which was ` +
      "not applied.");
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
      "This change no longer applies: cells it overwrites, or a sheet it writes to, changed since it " +
      "was queued.");
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
      "outside a sheet's grid.");
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
