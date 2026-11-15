import { describe, expect, it } from "vitest";
import {
  createReplay, replayChanges, type PlannedChange, type QueuedChange,
} from "../src/sheets-simulation";
import { grid, rect, sheet } from "./sheets-fixture";

/** The ID a session folds its spreadsheet's grid under: Google's own. */
const SPREADSHEET = "spreadsheet-1";

/** A queued batch of `changes`, recording the titles in `sheets` of the sheets it acts on. */
function queued(id: number, changes: PlannedChange[], sheets: Record<string, string> = {}): QueuedChange {
  return {
    id,
    action: {
      kind: "updateSpreadsheet",
      payload: {
        changes, sheets, marker: { id: id + 100, token: `token-${id}` },
        guard: { sha256: "", after: [] },
      },
    },
  };
}

/** `value` written to A1 of sheet 0, as queued. */
function writeA1(value: number): PlannedChange {
  return { op: "writeCells", sheetId: 0, rect: rect(0, 0), values: [[value]] };
}

describe("Sheets replay store", () => {
  // A session folds every read through one store, and its reads list the same journal IDs over
  // whatever Google then holds.
  it("folds each read's own grid, whatever it folded before under the same IDs", () => {
    let replay = createReplay();
    let pending = [queued(1, [writeA1(1)], { 0: "Sales" })];

    let first = replay.fold(SPREADSHEET, grid([sheet(0, "Sales")]), pending);
    expect(first.stopped).toBeUndefined();
    expect(first.refused).toEqual([]);
    expect(first.entity?.cells.get("0:b0:b0")).toEqual({ input: 1, at: 0, by: 1 });

    // The sheet was renamed in Sheets since.
    let renamed = replay.fold(SPREADSHEET, grid([sheet(0, "Revenue")]), pending);
    expect(renamed.stopped?.reason).toBe('the sheet "Sales" it acts on has been renamed "Revenue"');
    expect(renamed.stopped?.record).toBe(pending[0]);
    expect(renamed.entity?.cells.size).toBe(0);

    let restored = replay.fold(SPREADSHEET, grid([sheet(0, "Sales")]), pending);
    expect(restored.stopped).toBeUndefined();
    expect(restored.entity?.cells.get("0:b0:b0")).toEqual({ input: 1, at: 0, by: 1 });
  });

  it("folds a queue as replayChanges replays it: the same grid, stopped at the same change", () => {
    let gone = queued(2, [{ op: "clearRange", sheetId: 5, rect: rect(0, 0) }]);
    let queues: QueuedChange[][] = [
      [],
      [queued(1, [])],
      [queued(1, [writeA1(1)]), queued(2, [writeA1(2)])],
      [queued(1, [writeA1(1)]), gone, queued(3, [writeA1(3)])],
    ];
    for (let changes of queues) {
      let fold = createReplay().fold(SPREADSHEET, grid([sheet(0, "Sales")]), changes);
      let result = replayChanges(grid([sheet(0, "Sales")]), changes);
      expect(fold.refused).toEqual([]);
      if (result.kind === "complete") {
        expect(fold.stopped).toBeUndefined();
        expect(fold.entity).toEqual(result.value);
      } else {
        expect(fold.stopped).toEqual({ record: result.unsupported, reason: result.reason });
        expect(fold.stopped?.record).toBe(gone);
        expect(fold.entity).toEqual(result.partial);
      }
    }
  });

  it("returns the fetched grid itself when nothing queued changes it", () => {
    let base = grid([sheet(0, "Sales")]);
    expect(createReplay().fold(SPREADSHEET, base, []).entity).toBe(base);
    expect(createReplay().fold(SPREADSHEET, base, [queued(1, [])]).entity).toBe(base);
  });

  it("keeps nothing between replayChanges calls on one grid", () => {
    let base = grid([sheet(0, "Sales")]);
    let first = replayChanges(base, [queued(1, [writeA1(1)])]);
    let second = replayChanges(base, [queued(1, [writeA1(2)])]);

    if (first.kind !== "complete") throw new Error(first.reason);
    if (second.kind !== "complete") throw new Error(second.reason);
    expect(first.value.cells.get("0:b0:b0")).toMatchObject({ input: 1 });
    expect(second.value.cells.get("0:b0:b0")).toMatchObject({ input: 2 });
  });
});
