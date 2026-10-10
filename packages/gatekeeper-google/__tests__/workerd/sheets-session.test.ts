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
import type { QueuedChange } from "../../src/sheets-simulation";
import type { GoogleSpreadsheetSession } from "../../src/sheets-types";
import { ENTERED_READS, protectedRange, rect, sheet, spreadsheetMetadata } from "../sheets-fixture";

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

beforeEach(() => {
  providerFetches = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    let url = new URL(new Request(input, init).url);
    providerFetches.push(url);
    if (url.hostname !== "sheets.googleapis.com") {
      throw new Error(`Unexpected provider request: ${url.origin}${url.pathname}`);
    }
    if (url.pathname.endsWith("/values:batchGet")) {
      return Response.json({
        valueRanges: url.searchParams.getAll("ranges").map(range => ({ range, values: [["saved", 1]] })),
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
      "sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount))," +
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

/** Answers every request with `answer`, recording each. */
function answering(answer: unknown): Request[] {
  let requests: Request[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Response.json(answer);
  }));
  return requests;
}

describe("Google Sheets entered values", () => {
  let api = new GoogleSheetsApi(async () => "access-token");
  let areas = [
    { sheetId: 7, rect: rect(2, 1, 2, 3) },
    { sheetId: 0, rect: rect(0, 0, 3, ENTERED_READS.length) },
    { sheetId: 0, rect: rect(5, 3, 1, 2) },
  ];

  it("places each cell by the sheet and position Google gives it, whatever order it answers in", async () => {
    // One entry per sheet, in the spreadsheet's order, with a block per range in the order asked.
    // Google leaves out a sheet ID or start of 0, blank cells and rows at the end, and the value of
    // a blank cell before them.
    let requests = answering({
      sheets: [
        {
          properties: {},
          data: [
            {
              rowData: [
                { values: ENTERED_READS.map(([userEnteredValue]) => ({ userEnteredValue })) },
                {},
                { values: [{}, { userEnteredValue: { numberValue: 0 } }] },
              ],
            },
            { startRow: 5, startColumn: 3, rowData: [{ values: [{ userEnteredValue: { boolValue: false } }] }] },
          ],
        },
        {
          properties: { sheetId: 7 },
          data: [{ startRow: 2, startColumn: 1, rowData: [{ values: [{}, {}, { userEnteredValue: { stringValue: "x" } }] }] }],
        },
      ],
    });

    let blank = ENTERED_READS.map(() => null);
    expect(await api.readEntered("sheet-1", areas)).toEqual([
      [[null, null, "x"], [null, null, null]],
      [
        ["=order 123", "=quoted", { formula: "=1/0" }, "#REF!", { error: "REF" }, { error: "DIVIDE_BY_ZERO" }],
        blank,
        [null, 0, ...blank.slice(2)],
      ],
      [[false, null]],
    ]);

    // Only the cells' entered values are asked for, never who may edit them.
    expect(requests).toHaveLength(1);
    let url = new URL(requests[0].url);
    expect(url.pathname).toBe("/v4/spreadsheets/sheet-1:getByDataFilter");
    expect(url.searchParams.get("fields"))
      .toBe("sheets(properties(sheetId),data(startRow,startColumn,rowData(values(userEnteredValue))))");
    expect(url.searchParams.get("prettyPrint")).toBe("false");
    expect(await requests[0].json()).toEqual({
      dataFilters: areas.map(({ sheetId, rect: { startRow, endRow, startColumn, endColumn } }) => ({
        gridRange: {
          sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startColumn,
          endColumnIndex: endColumn,
        },
      })),
      includeGridData: true,
    });
  });

  it("refuses an answer without a block where a range starts", async () => {
    answering({
      sheets: [
        { properties: {}, data: [{}, { startRow: 5, startColumn: 3 }] },
        { properties: { sheetId: 7 }, data: [{ startRow: 2 }] },
      ],
    });

    await expect(api.readEntered("sheet-1", areas))
      .rejects.toThrow("Google Sheets did not return every range it was asked for.");
  });
});
