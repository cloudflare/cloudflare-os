// Reading a workbook: every visible sheet's used range within the cell budget, or one named range.

import { describe, expect, it } from "vitest";
import { GraphApi } from "../src/graph-api";
import { readWorkbookSheets } from "../src/sharepoint-content";

const REF = { driveId: "b!drive", itemId: "01ITEM" };

/** A Graph answering each request with the next scripted body, recording what was asked. */
function harness(replies: unknown[]) {
  const asked: string[] = [];
  const api = new GraphApi("token", {
    fetch: async input => {
      asked.push(decodeURIComponent(new URL(String(input)).pathname.replace(/^\/v1\.0/, "")));
      return Response.json(replies.shift() ?? {});
    },
  });
  return { api, asked };
}

const sheets = { value: [{ id: "s1", name: "Budget" }, { id: "s2", name: "Notes" }] };

describe("readWorkbookSheets", () => {
  it("reads one range of one sheet as given, without asking for the used range", async () => {
    const { api, asked } = harness([
      sheets,
      { address: "Budget!B2:C3", values: [[1, 2], [3, null]], formulas: [["=A1", 2], [3, null]] },
    ]);
    const read = await readWorkbookSheets(api, REF, { sheet: "budget", range: "B2:C3", maxCells: 100 });
    expect(asked).toEqual([
      "/drives/b!drive/items/01ITEM/workbook/worksheets",
      "/drives/b!drive/items/01ITEM/workbook/worksheets/s1/range(address='B2:C3')",
    ]);
    expect(read.worksheets).toEqual([{
      name: "Budget", address: "Budget!B2:C3", values: [[1, 2], [3, null]], formulas: [["=A1", 2], [3, null]], truncated: false,
    }]);
    expect(read.otherWorksheets).toEqual(["Notes"]);
    expect(read.notes).toEqual([]);
  });

  it("reads a sheet's used range, cut to the cell budget, when no range is named", async () => {
    const { api, asked } = harness([
      sheets,
      { address: "Budget!A1:D10", rowCount: 10, columnCount: 4 },
      { address: "Budget!A1:D2", values: [[1, 2, 3, 4], [5, 6, 7, 8]] },
    ]);
    const read = await readWorkbookSheets(api, REF, { sheet: "Budget", maxCells: 8 });
    expect(asked[1]).toBe("/drives/b!drive/items/01ITEM/workbook/worksheets/s1/usedRange(valuesOnly=true)");
    expect(asked[2]).toBe("/drives/b!drive/items/01ITEM/workbook/worksheets/s1/range(address='A1:D2')");
    expect(read.worksheets[0]).toMatchObject({ address: "Budget!A1:D2", truncated: true });
    expect(read.notes).toEqual(['Only part of "Budget" was read (A1:D2 of Budget!A1:D10).']);
  });
});
