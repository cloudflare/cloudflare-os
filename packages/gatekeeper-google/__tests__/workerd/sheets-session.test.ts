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
import type { PlannedChange, QueuedChange } from "../../src/sheets-simulation";
import type { GoogleSpreadsheetSession } from "../../src/sheets-types";
import {
  byDataFilter, protectedRange, rect, sheet, spreadsheetMetadata, type FixtureGridRange,
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

beforeEach(() => {
  providerFetches = [];
  dataFilterReads = [];
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
