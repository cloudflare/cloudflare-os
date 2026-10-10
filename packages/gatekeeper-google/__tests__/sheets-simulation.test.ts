import { describe, expect, it } from "vitest";
import {
  applyChange, asQueued, buildsOn, conflictReason, overlayRange, replayChanges,
  type PlannedChange, type QueuedChange, type SheetsAction,
} from "../src/sheets-simulation";
import { grid, rect, sheet } from "./sheets-fixture";

function queued(id: number, changes: PlannedChange[], kind: SheetsAction["kind"] = "updateSheet"): QueuedChange {
  return {
    id,
    action: {
      kind,
      payload: {
        changes, sheets: { 0: "Sales" }, marker: { id: id + 100, token: `token-${id}` },
        guard: { sha256: "0".repeat(64), after: [] },
      },
    },
  };
}

const SALES = sheet(0, "Sales");
const COSTS = sheet(1, "Costs");

describe("Sheets queued changes in reads", () => {
  // B2:E2 enters a formula, a number, text and a clear; F2 is left as Google has it.
  let replayed = applyChange(grid([SALES, COSTS]), queued(1, [
    { op: "writeCells", sheetId: 0, rect: rect(1, 1, 1, 3), values: [["=SUM(A1:A2)", 5, "text"]] },
    { op: "clearRange", sheetId: 0, rect: rect(1, 4) },
  ]).action);
  let read = { range: "Sales!B2:F2", values: [["old", 1, "was", "kept?", "untouched"]] };

  it("shows queued input exactly in formula mode", () => {
    expect(overlayRange(read, 0, rect(1, 1, 1, 5), replayed, "formula")).toEqual({
      range: "Sales!B2:F2", values: [["=SUM(A1:A2)", 5, "text", null, "untouched"]],
    });
  });

  it("shows literals in raw mode, and a formula's result as pending", () => {
    expect(overlayRange(read, 0, rect(1, 1, 1, 5), replayed, "raw")).toEqual({
      range: "Sales!B2:F2", values: [[null, 5, "text", null, "untouched"]], pendingCells: ["B2"],
    });
  });

  it("shows text in formatted mode, and numbers and results as pending", () => {
    let formatted = { range: "Sales!B2:F2", values: [["$3.00", "$1.00", "was", "kept?", "untouched"]] };
    expect(overlayRange(formatted, 0, rect(1, 1, 1, 5), replayed)).toEqual({
      range: "Sales!B2:F2", values: [[null, null, "text", null, "untouched"]], pendingCells: ["B2", "C2"],
    });
  });

  it("lists pending cells row by row, and overlays only the sheet read", () => {
    let filled = applyChange(grid([SALES, COSTS]), queued(1, [
      { op: "writeCells", sheetId: 1, rect: rect(0, 0, 2, 2), values: [[1, "=A1"], ["=B1", true]] },
    ]).action);
    let blank = { range: "Costs!A1:B2", values: [[null, null], [null, null]] };
    expect(overlayRange(blank, 1, rect(0, 0, 2, 2), filled, "formatted").pendingCells)
      .toEqual(["A1", "B1", "A2", "B2"]);
    expect(overlayRange({ ...blank, range: "Sales!A1:B2" }, 0, rect(0, 0, 2, 2), filled, "formatted"))
      .toEqual({ ...blank, range: "Sales!A1:B2" });
  });

  it("replays changes in order, a later one entering over an earlier", () => {
    let result = replayChanges(grid([SALES]), [
      queued(1, [{ op: "writeCells", sheetId: 0, rect: rect(0, 0, 1, 2), values: [[1, 2]] }], "editSheetValues"),
      queued(2, [{ op: "writeCells", sheetId: 0, rect: rect(0, 1), values: [["=A1*2"]] }]),
    ]);
    if (result.kind !== "complete") throw new Error(result.reason);
    expect(result.appliedCount).toBe(2);
    let blank = { range: "Sales!A1:B1", values: [[null, null]] };
    expect(overlayRange(blank, 0, rect(0, 0, 1, 2), result.value, "formula"))
      .toEqual({ range: "Sales!A1:B1", values: [[1, "=A1*2"]] });
  });

  it("counts a batch of no changes as having no effect", () => {
    let base = grid([SALES]);
    expect(replayChanges(base, [queued(1, [])])).toEqual({ kind: "complete", value: base, appliedCount: 0 });
  });

  it("stops at a change whose sheet is gone, or whose cells the sheet no longer has", () => {
    let first = queued(1, [{ op: "writeCells", sheetId: 0, rect: rect(0, 0), values: [[1]] }]);
    let gone = queued(2, [
      { op: "clearRange", sheetId: 0, rect: rect(0, 0) },
      { op: "clearRange", sheetId: 5, rect: rect(0, 0) },
    ]);
    let result = replayChanges(grid([SALES]), [first, gone, queued(3, [])]);
    expect(result).toMatchObject({
      kind: "incomplete", appliedCount: 1, unsupported: gone,
      reason: "change 2 (clearRange): the spreadsheet has no sheet with ID 5",
    });
    if (result.kind !== "incomplete") throw new Error("the replay completed");
    expect(result.partial.cells.get("0:0:0")).toBe(1);
    expect(conflictReason(gone, "change 2 (clearRange): the spreadsheet has no sheet with ID 5")).toBe(
      "Queued change 2 no longer applies, so it and the changes queued after it are not shown: " +
      "change 2 (clearRange): the spreadsheet has no sheet with ID 5.");

    let shrunk = replayChanges(grid([sheet(0, "Sales", { rowCount: 10 })]), [
      queued(1, [{ op: "writeCells", sheetId: 0, rect: rect(14, 0), values: [[1]] }]),
    ]);
    expect(shrunk).toMatchObject({
      kind: "incomplete", appliedCount: 0, reason: 'change 1 (writeCells): A15 is outside "Sales"',
    });
  });

  it("names the queued changes whose cells a batch also writes", () => {
    let pending = [
      queued(1, [{ op: "writeCells", sheetId: 0, rect: rect(0, 0), values: [[1]] }]),
      queued(2, [{ op: "clearRange", sheetId: 1, rect: rect(2, 2, 3, 3) }]),
      queued(3, [{ op: "clearRange", sheetId: 0, rect: rect(5, 5) }]),
    ];
    expect(buildsOn(pending, [
      { op: "clearRange", sheetId: 0, rect: rect(0, 0, 2, 2) },
      { op: "clearRange", sheetId: 1, rect: rect(4, 4) },
    ])).toEqual([1, 2]);
    // The same cells of another sheet are not the same cells.
    expect(buildsOn(pending, [{ op: "clearRange", sheetId: 1, rect: rect(0, 0) }])).toEqual([]);
  });

  it("guards the cells a batch overwrites as queued changes leave them", () => {
    let queuedGrid = applyChange(grid([SALES]), queued(1, [
      { op: "writeCells", sheetId: 0, rect: rect(0, 0, 1, 2), values: [["=A9", null]] },
    ]).action);
    let changes: PlannedChange[] = [{ op: "clearRange", sheetId: 0, rect: rect(0, 1, 2) }];
    // B1 and B2 as Google holds them; B1 is queued to be cleared, so it reads null; Google trims B2.
    expect(asQueued(queuedGrid, changes, [[["was"]]])).toEqual([[[null], [null]]]);
    expect(asQueued(grid([SALES]), changes, [[["was"], [7]]])).toEqual([[["was"], [7]]]);
  });
});
