import { RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, GitCache, HookController, HookDescription,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unguardedNativeRead } from "../../src/drive-session";
import { GoogleSheetsApi } from "../../src/sheets-api";
import {
  GoogleSpreadsheetReadSessionImpl, GoogleSpreadsheetSessionImpl, NO_CHANGES,
} from "../../src/sheets";
import { FORMAT_READ_FIELDS } from "../../src/sheets-format";
import { parseRange } from "../../src/sheets-model";
import type { PlannedChange, QueuedChange } from "../../src/sheets-simulation";
import type { GoogleSpreadsheetSession } from "../../src/sheets-types";
import {
  byDataFilter, formatSheet, protectedRange, rect, sheet, spreadsheetMetadata, type FixtureGridRange,
} from "../sheets-fixture";

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  readonly observations: ObservationDescription[] = [];

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description);
  }

  async getGitCache(): Promise<GitCache> {
    throw new Error("Unexpected git cache access");
  }

  async submitAction(_action: number, _description: ActionDescription): Promise<void> {
    throw new Error("Unexpected action submission");
  }

  async bindHook<Hook extends RpcTarget>(
    _controller: Fetcher<HookController<Hook>>, _callback: RpcStub<Hook>,
    _description: HookDescription,
  ): Promise<void> {
    throw new Error("Unexpected hook binding");
  }
}

const METADATA = spreadsheetMetadata("sheet-1", "Budget", [
  { ...sheet(0, "Sales"), protectedRanges: [protectedRange(1, { sheetId: 0, startRowIndex: 0, endRowIndex: 1 })] },
  sheet(7, "Q3 Plan", { index: 1, rowCount: 10, columnCount: 4 }),
]);

let providerFetches: URL[];
/** The body of each data-filter read, in order. */
let dataFilterReads: {
  dataFilters: { gridRange: Required<FixtureGridRange> }[];
  valueRenderOption: string;
  dateTimeRenderOption?: string;
}[];

/** The grid ranges of each `spreadsheets:getByDataFilter` format read, in order. */
let formatFilterReads: Required<FixtureGridRange>[][];

/**
 * The formats Google holds in `cells` of sheet `sheetId`: each cell's font size names its sheet,
 * row and column, so a test can tell which cell a format came from.
 */
function positionedFormats(sheetId: number, cells: ReturnType<typeof rect>) {
  return Array.from({ length: cells.endRow - cells.startRow }, (_row, r) =>
    Array.from({ length: cells.endColumn - cells.startColumn }, (_column, c) =>
      ({ textFormat: { fontSize: sheetId * 10_000 + (cells.startRow + r) * 100 + cells.startColumn + c } })));
}

beforeEach(() => {
  providerFetches = [];
  dataFilterReads = [];
  formatFilterReads = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    let request = new Request(input, init);
    let url = new URL(request.url);
    providerFetches.push(url);
    if (url.hostname !== "sheets.googleapis.com") {
      throw new Error(`Unexpected provider request: ${url.origin}${url.pathname}`);
    }
    if (url.pathname.endsWith("/values:batchGet")) {
      return Response.json({
        valueRanges: url.searchParams.getAll("ranges").map(range => ({ range, values: [["saved", 1]] })),
      });
    }
    if (url.pathname.endsWith("/values:batchGetByDataFilter")) {
      let body = await request.json() as (typeof dataFilterReads)[number];
      dataFilterReads.push(body);
      // Each cell holds its own sheet, row and column, so a test can tell which cell a value came from.
      return Response.json(byDataFilter(body.dataFilters.map(({ gridRange }) => ({
        gridRange,
        range: "",
        values: Array.from({ length: gridRange.endRowIndex - gridRange.startRowIndex }, (_row, r) =>
          Array.from({ length: gridRange.endColumnIndex - gridRange.startColumnIndex }, (_column, c) =>
            `${gridRange.sheetId}:${gridRange.startRowIndex + r}:${gridRange.startColumnIndex + c}`)),
      }))));
    }
    if (url.pathname.endsWith(":getByDataFilter")) {
      let body = await request.json() as { dataFilters: { gridRange: Required<FixtureGridRange> }[] };
      formatFilterReads.push(body.dataFilters.map(({ gridRange }) => gridRange));
      // One sheet per range, in an order of Google's own.
      return Response.json({
        sheets: body.dataFilters.toReversed().map(({ gridRange }) => {
          let { sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex } = gridRange;
          let { title } = METADATA.sheets.find(({ properties }) => properties.sheetId === sheetId)!.properties;
          return formatSheet({ sheetId, title }, [{
            startRow: startRowIndex, startColumn: startColumnIndex,
            formats: positionedFormats(sheetId, rect(
              startRowIndex, startColumnIndex, endRowIndex - startRowIndex, endColumnIndex - startColumnIndex)),
          }]);
        }),
      });
    }
    if (url.searchParams.has("ranges")) {
      let { sheet: name, rect: cells } = parseRange(url.searchParams.get("ranges")!);
      let found = name === undefined ? METADATA.sheets[0]
        : METADATA.sheets.find(({ properties }) => properties.title.toLowerCase() === name.toLowerCase())!;
      let { sheetId, title, index, gridProperties } = found.properties;
      // Google clips a range running past the grid.
      let clipped = {
        ...cells,
        endRow: Math.min(cells.endRow, gridProperties.rowCount),
        endColumn: Math.min(cells.endColumn, gridProperties.columnCount),
      };
      return Response.json({
        sheets: [formatSheet({ sheetId, title, index, ...gridProperties }, [{
          startRow: cells.startRow, startColumn: cells.startColumn,
          formats: positionedFormats(sheetId, clipped),
        }])],
      });
    }
    // The fake honours only whether protected ranges were asked for; it never sends editors.
    let fields = url.searchParams.get("fields") ?? "";
    return Response.json({
      ...METADATA,
      sheets: METADATA.sheets.map(({ protectedRanges, ...rest }) =>
        fields.includes("protectedRanges") && protectedRanges
          ? { ...rest, protectedRanges: protectedRanges.map(({ editors: _editors, ...range }) => range) }
          : rest),
    });
  }));
});
afterEach(() => vi.unstubAllGlobals());

/** A queued batch writing `values` to `cells` of sheet `sheetId`. */
function queued(id: number, sheetId: number, cells: ReturnType<typeof rect>, values: (string | number | null)[][]): QueuedChange {
  return {
    id,
    action: {
      kind: "updateSheet",
      payload: {
        changes: [{ op: "writeCells", sheetId, rect: cells, values }],
        sheets: { [sheetId]: "Sales" },
        marker: { id: 1, token: "token" },
        guard: { sha256: "", after: [] },
      },
    },
  };
}

/** A queued batch making `changes`. */
function queuedBatch(id: number, changes: PlannedChange[]): QueuedChange {
  return {
    id,
    action: {
      kind: "updateSheet",
      payload: { changes, sheets: {}, marker: { id: 1, token: "token" }, guard: { sha256: "", after: [] } },
    },
  };
}

function newSession(pending: QueuedChange[] = []) {
  let queue = new TestApprovalQueue();
  let queueStub: RpcStub<ApprovalQueue> = new RpcStub(queue);
  let session = new RpcStub(new GoogleSpreadsheetSessionImpl(
    new GoogleSheetsApi(async () => "access-token"), "sheet-1", queueStub,
    unguardedNativeRead(description => queueStub.authorizeObservation(description)),
    { ...NO_CHANGES, snapshot: read => read(pending) },
  ));
  return { queue, session };
}

/** Each request's path, and the field mask it asked for. */
function requested(): [string, string | null][] {
  return providerFetches.map(url => [url.pathname, url.searchParams.get("fields")]);
}

describe("Google Sheets spreadsheet session", () => {
  it("reads with one request when no change is queued", async () => {
    let { queue, session } = newSession();
    using _session = session;

    let info = await session.getSpreadsheet();
    let [range] = await session.readRanges(["Sales!A1:B1"], { valueMode: "formula" });

    expect(info.sheets.map(s => s.title)).toEqual(["Sales", "Q3 Plan"]);
    expect(range).toEqual({ range: "Sales!A1:B1", values: [["saved", 1]] });
    expect(requested()).toEqual([
      ["/v4/spreadsheets/sheet-1",
        "spreadsheetId,properties(title,locale,timeZone)," +
        "sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount)))"],
      ["/v4/spreadsheets/sheet-1/values:batchGet", null],
    ]);
    expect(providerFetches[1].searchParams.get("valueRenderOption")).toBe("FORMULA");
    expect(queue.observations.map(o => o.title)).toEqual([
      "Read Google spreadsheet metadata", "Read Google Sheets range Sales!A1:B1",
    ]);
  });

  it("reads metadata and values with changes queued, showing them over what Google returns", async () => {
    let { session } = newSession([queued(1, 0, rect(0, 1), [["=SUM(B2:B3)"]])]);
    using _session = session;

    expect(await session.readRange("Sales!A1:B1", { valueMode: "formula" }))
      .toEqual({ range: "Sales!A1:B1", values: [["saved", "=SUM(B2:B3)"]] });
    // A range naming no sheet is read from the first visible one, as Google reads it.
    expect(await session.readRange("A1:B1", { valueMode: "raw" }))
      .toEqual({ range: "A1:B1", values: [["saved", null]], pendingCells: ["B1"] });
    expect(await session.readRange("'Q3 Plan'!A1:B1"))
      .toEqual({ range: "'Q3 Plan'!A1:B1", values: [["saved", 1]] });

    // Each read fetches the metadata, to replay the queued change over, and the values.
    let metadata = ["/v4/spreadsheets/sheet-1",
      "spreadsheetId,properties(title,locale,timeZone)," +
      "sheets(properties(sheetId,title,index,hidden," +
      "gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount))," +
      "protectedRanges(range,unprotectedRanges,requestingUserCanEdit,warningOnly))"];
    let values = ["/v4/spreadsheets/sheet-1/values:batchGet", null];
    expect(requested().toSorted()).toEqual([metadata, metadata, metadata, values, values, values]);
  });

  it("reports a queued change that no longer applies on every read, and shows no protected range", async () => {
    let { session } = newSession([queued(4, 9, rect(0, 0), [["x"]])]);
    using _session = session;
    let conflict = "Queued change 4 no longer applies, so it and the changes queued after it are not " +
      "shown: change 1 (writeCells): the spreadsheet has no sheet with ID 9.";

    let info = await session.getSpreadsheet();
    let ranges = await session.readRanges(["Sales!A1:B1", "'Q3 Plan'!A1"]);

    expect(info).toEqual({
      id: "sheet-1", title: "Budget", locale: "en_US", timeZone: "America/New_York",
      sheets: [
        { id: 0, title: "Sales", index: 0, rowCount: 20, columnCount: 6 },
        { id: 7, title: "Q3 Plan", index: 1, rowCount: 10, columnCount: 4 },
      ],
      queuedChangeConflict: conflict,
    });
    expect(ranges.map(range => range.queuedChangeConflict)).toEqual([conflict, conflict]);
    // Getting metadata needs no values.
    expect(providerFetches.filter(url => url.pathname.endsWith("/values:batchGet"))).toHaveLength(1);
  });

  it("refuses a malformed range before fetching anything", async () => {
    let { session } = newSession([queued(1, 0, rect(0, 1), [[1]])]);
    using _session = session;

    await expect(Promise.resolve(session.readRange("Sales!A:A")))
      .rejects.toThrow(/Invalid or unbounded A1 range/);
    expect(providerFetches).toEqual([]);
  });

  it("never asks Google who may edit a protected range", async () => {
    let { session } = newSession([queued(1, 0, rect(0, 1), [[1]])]);
    using _session = session;

    await session.getSpreadsheet();
    await session.readRange("Sales!A1:B2");

    let masks = providerFetches.flatMap(url => url.searchParams.getAll("fields"));
    expect(masks.some(mask => mask.includes("protectedRanges"))).toBe(true);
    expect(masks.filter(mask => mask.includes("editors"))).toEqual([]);
  });

  it("reads with rows and sheets queued by grid range, fetching only the cells Google holds", async () => {
    let { session } = newSession([queuedBatch(1, [
      { op: "renameSheet", sheetId: 0, title: "Renamed" },
      { op: "insertRows", sheetId: 0, start: 1, count: 1 },
    ])]);
    using _session = session;

    expect((await session.getSpreadsheet()).sheets[0])
      .toEqual({ id: 0, title: "Renamed", index: 0, rowCount: 21, columnCount: 6 });
    expect(await session.readRange("Renamed!A1:B3", { valueMode: "raw" })).toEqual({
      range: "Renamed!A1:B3", values: [["0:0:0", "0:0:1"], [null, null], ["0:1:0", "0:1:1"]],
    });

    // No range names the title Google holds, so none is read by A1 range.
    expect(providerFetches.filter(url => url.pathname.endsWith("/values:batchGet"))).toEqual([]);
    // The inserted row splits the range into the two rows around it, read as entered too, to tell
    // formulas apart.
    let pieces = [
      { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 },
      { sheetId: 0, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2 },
    ];
    expect(dataFilterReads.map(({ dataFilters, valueRenderOption, dateTimeRenderOption }) =>
      ({ gridRanges: dataFilters.map(({ gridRange }) => gridRange), valueRenderOption, dateTimeRenderOption }))
      .toSorted((a, b) => a.valueRenderOption.localeCompare(b.valueRenderOption))).toEqual([
      { gridRanges: pieces, valueRenderOption: "FORMULA", dateTimeRenderOption: undefined },
      { gridRanges: pieces, valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" },
    ]);
  });

  it("fetches at most 20 pieces of what Google holds for a read with rows queued", async () => {
    // A row inserted after each of the 20 rows Google holds.
    let rows = queuedBatch(1, Array.from({ length: 20 }, (_, i): PlannedChange =>
      ({ op: "insertRows", sheetId: 0, start: 2 * i + 1, count: 1 })));
    let { session } = newSession([rows]);
    using _session = session;

    let read = await session.readRange("Sales!A1:A40", { valueMode: "formula" });

    expect(read.values).toEqual(Array.from({ length: 40 }, (_, i) => [i % 2 === 0 ? `0:${i / 2}:0` : null]));
    expect(dataFilterReads.map(({ dataFilters }) => dataFilters.length)).toEqual([20]);

    // A column inserted too splits each of those pieces in two.
    let { session: split } = newSession([rows, queuedBatch(2, [{ op: "insertColumns", sheetId: 0, start: 1, count: 1 }])]);
    using _split = split;
    await expect(Promise.resolve(split.readRange("Sales!A1:C40"))).rejects.toThrow(
      "These ranges cannot be read with the queued changes applied. Read fewer cells, or approve or " +
      "reject the queued changes first.");
    expect(dataFilterReads).toHaveLength(1);
    expect(providerFetches.filter(url => url.pathname.endsWith("/values:batchGet"))).toEqual([]);
  });

  it("gives a spreadsheet opened read-only no write method", async () => {
    let queue = new TestApprovalQueue();
    let queueStub: RpcStub<ApprovalQueue> = new RpcStub(queue);
    using session = new RpcStub(new GoogleSpreadsheetReadSessionImpl(
      new GoogleSheetsApi(async () => "access-token"), "sheet-1", queueStub,
      unguardedNativeRead(description => queueStub.authorizeObservation(description)),
    ));

    expect((await session.getSpreadsheet()).title).toBe("Budget");
    let writable = session as unknown as GoogleSpreadsheetSession;
    await expect(Promise.resolve(writable.updateSheet([
      { op: "writeCells", range: "Sales!A1", values: [["x"]] },
    ]))).rejects.toThrow('The RPC receiver does not implement the method "updateSheet".');
    expect(providerFetches).toHaveLength(1);
  });
});

/** Fields of a cell's value, which no format read asks for. */
const VALUE_FIELDS = ["formattedValue", "effectiveValue", "userEnteredValue", "hyperlink", "note"];

/** The field mask of each request. */
function fieldMasks(): string[] {
  return providerFetches.map(url => url.searchParams.get("fields") ?? "");
}

describe("Google Sheets format reads", () => {
  it("reads formats with one request when no change is queued, asking for no value", async () => {
    let { queue, session } = newSession();
    using _session = session;

    expect(await session.readFormats("sales!a19:b21")).toEqual({
      range: "Sales!A19:B20",
      formats: [[{ fontSize: 1800 }, { fontSize: 1801 }], [{ fontSize: 1900 }, { fontSize: 1901 }], [null, null]],
    });
    expect(requested()).toEqual([["/v4/spreadsheets/sheet-1", FORMAT_READ_FIELDS]]);
    expect(providerFetches[0].searchParams.getAll("ranges")).toEqual(["sales!a19:b21"]);
    for (let field of VALUE_FIELDS) expect(fieldMasks()[0]).not.toContain(field);
    expect(queue.observations).toEqual([{
      title: "Read Google Sheets formatting of Sales!A19:B20",
      description: "Read the formatting of 6 cell(s) in the connected spreadsheet.",
    }]);
  });

  it("refuses an unbounded range, or one of more than 10,000 cells, before fetching anything", async () => {
    let { session } = newSession();
    using _session = session;

    await expect(Promise.resolve(session.readFormats("Sales!A:A")))
      .rejects.toThrow(/Invalid or unbounded A1 range/);
    await expect(Promise.resolve(session.readFormats("Sales!A1:CV101")))
      .rejects.toThrow("readFormats may request at most 10,000 cells.");
    expect(providerFetches).toEqual([]);
    expect((await session.readFormats("Sales!A1:CV100")).formats).toHaveLength(100);
  });

  it("reads formats by A1 range when queued changes move no cell", async () => {
    let { session } = newSession([queued(1, 0, rect(0, 0), [[5]]), queued(2, 9, rect(0, 0), [["x"]])]);
    using _session = session;

    expect(await session.readFormats("'Q3 Plan'!B2:C2")).toEqual({
      range: "'Q3 Plan'!B2:C2",
      formats: [[{ fontSize: 70_101 }, { fontSize: 70_102 }]],
      queuedChangeConflict: "Queued change 2 no longer applies, so it and the changes queued after " +
        "it are not shown: change 1 (writeCells): the spreadsheet has no sheet with ID 9.",
    });
    // The metadata, to replay the queued changes over, and the formats.
    expect(requested().map(([, fields]) => fields === FORMAT_READ_FIELDS).toSorted()).toEqual([false, true]);
    expect(formatFilterReads).toEqual([]);
  });

  it("shows queued formatting over the cells' own, and values in a queued number format as pending", async () => {
    let { session } = newSession([queuedBatch(1, [{
      op: "formatCells", sheetId: 0, rect: rect(0, 0, 1, 2),
      format: { bold: true, numberFormat: { type: "PERCENT" }, borders: { bottom: { style: "SOLID" } } },
    }])]);
    using _session = session;

    let set = { bold: true, numberFormat: { type: "PERCENT" }, borders: { bottom: { style: "SOLID" } } };
    // Row 2 loses only its top border beside the queued bottom one, which it does not have.
    expect(await session.readFormats("Sales!A1:C2")).toEqual({
      range: "Sales!A1:C2",
      formats: [
        [{ fontSize: 0, ...set }, { fontSize: 1, ...set }, { fontSize: 2 }],
        [{ fontSize: 100 }, { fontSize: 101 }, { fontSize: 102 }],
      ],
    });
    expect(formatFilterReads).toEqual([]);
    expect(await session.readRange("Sales!A1:B1")).toEqual({
      range: "Sales!A1:B1", values: [[null, null]], pendingCells: ["A1", "B1"],
    });
    expect(await session.readRange("Sales!A1:B1", { valueMode: "raw" })).toEqual({
      range: "Sales!A1:B1", values: [["saved", 1]],
    });
  });

  it("reads formats by grid range with rows and sheets queued, leaving inserted rows pending", async () => {
    let { queue, session } = newSession([queuedBatch(1, [
      { op: "renameSheet", sheetId: 7, title: "Plan" },
      { op: "insertRows", sheetId: 7, start: 1, count: 1 },
    ])]);
    using _session = session;

    expect(await session.readFormats("plan!A1:B3")).toEqual({
      range: "Plan!A1:B3",
      formats: [
        [{ fontSize: 70_000 }, { fontSize: 70_001 }],
        [null, null],
        [{ fontSize: 70_100 }, { fontSize: 70_101 }],
      ],
      pendingCells: ["A2", "B2"],
    });
    // The rows around the inserted one, of the sheet Google holds, which no A1 range names.
    expect(formatFilterReads).toEqual([[
      { sheetId: 7, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 },
      { sheetId: 7, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2 },
    ]]);
    let byDataFilterRead = providerFetches.find(url => url.pathname.endsWith(":getByDataFilter"))!;
    expect(byDataFilterRead.searchParams.get("fields")).toBe(FORMAT_READ_FIELDS);
    expect(providerFetches.some(url => url.searchParams.has("ranges"))).toBe(false);
    for (let mask of fieldMasks()) for (let field of VALUE_FIELDS) expect(mask).not.toContain(field);
    expect(queue.observations.map(o => o.title)).toEqual(["Read Google Sheets formatting of Plan!A1:B3"]);
  });

  it("refuses a sheet the queued changes leave no longer there only once the read is authorized", async () => {
    let { queue, session } = newSession([queuedBatch(1, [{ op: "renameSheet", sheetId: 7, title: "Plan" }])]);
    using _session = session;

    await expect(Promise.resolve(session.readFormats("'Q3 Plan'!A1")))
      .rejects.toThrow('The spreadsheet has no sheet named "Q3 Plan" with the queued changes applied.');
    expect(queue.observations.map(o => o.title)).toEqual(["Read Google Sheets formatting"]);
    expect(formatFilterReads).toEqual([]);
  });

  it("reads a spreadsheet opened read-only by A1 range", async () => {
    let queue = new TestApprovalQueue();
    let queueStub: RpcStub<ApprovalQueue> = new RpcStub(queue);
    using session = new RpcStub(new GoogleSpreadsheetReadSessionImpl(
      new GoogleSheetsApi(async () => "access-token"), "sheet-1", queueStub,
      unguardedNativeRead(description => queueStub.authorizeObservation(description)),
    ));

    expect((await session.readFormats("B2")).formats).toEqual([[{ fontSize: 101 }]]);
    expect(requested()).toEqual([["/v4/spreadsheets/sheet-1", FORMAT_READ_FIELDS]]);
    expect(formatFilterReads).toEqual([]);
  });
});
