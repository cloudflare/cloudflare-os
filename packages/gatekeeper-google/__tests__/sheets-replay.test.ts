import { describe, expect, it } from "vitest";
import { editorCost } from "../src/editor-cost";
import {
  createReplay, replayChanges, type Grid, type PlannedChange, type QueuedChange,
} from "../src/sheets-simulation";
import { diceOf, type Dice } from "./doc-fixture";
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

/**
 * Folds `changes` over the grid `base` makes and holds the fold to what `replayChanges`, which
 * copies the grid for every batch, makes of them over another: the same grid, entry for entry and
 * in the same order, holding a grid's fields and no other, stopped at the same change for the same
 * reason. Returns the fold.
 */
function foldedAsReplayed(base: () => Grid, changes: readonly QueuedChange[]) {
  let fold = createReplay().fold(SPREADSHEET, base(), changes);
  let result = replayChanges(base(), changes);
  let expected = result.kind === "complete" ? result.value : result.partial;
  expect(fold.refused).toEqual([]);
  expect(fold.stopped).toEqual(
    result.kind === "complete" ? undefined : { record: result.unsupported, reason: result.reason });
  expect(fold.entity).toEqual(expected);
  expect(Object.keys(fold.entity!)).toEqual(["sheets", "cells", "formats", "sizes", "log"]);
  for (let map of ["cells", "formats", "sizes"] as const) {
    expect([...fold.entity![map].keys()]).toEqual([...expected[map].keys()]);
  }
  return fold;
}

/** The two sheets generated queues change. */
const twoSheets = () => grid([sheet(0, "Sales"), sheet(1, "Notes", { rowCount: 8, columnCount: 4 })]);

/** The sheets a generated queue has made so far, were every change of it to apply. */
type Believed = { sheets: { id: number; title: string }[]; minted: number };

/** The kinds of change a queue is generated from, the ones that enter cells the likeliest. */
const KINDS = [
  "writeCells", "writeCells", "writeCells", "clearRange", "formatCells", "formatCells", "borders",
  "mergeCells", "unmergeCells", "addSheet", "renameSheet", "duplicateSheet", "duplicateSheet",
  "deleteSheet", "insertRows", "insertColumns", "deleteRows", "deleteColumns", "resizeRows",
  "resizeColumns", "freeze",
] as const;

/**
 * One generated change, of any kind a batch may hold. About one in ten names a sheet the
 * spreadsheet never had or cells outside every sheet, and others stop applying by what the queue
 * did before them: a title taken, a merge cut, a row that is gone.
 */
function generatedChange(dice: Dice, believed: Believed): PlannedChange {
  let on = dice.pick(believed.sheets);
  let sheetId = dice.below(20) === 0 ? 99 : on.id;
  let area = dice.below(20) === 0 ? rect(500, 0)
    : rect(dice.below(6), dice.below(3), 1 + dice.below(3), 1 + dice.below(2));
  let start = dice.below(5);
  let count = 1 + dice.below(2);
  let kind = dice.pick(KINDS);
  switch (kind) {
    case "writeCells": {
      let values = Array.from({ length: area.endRow - area.startRow }, () =>
        Array.from({ length: area.endColumn - area.startColumn }, () =>
          dice.pick([dice.below(100), `text ${dice.below(100)}`, "=A1+B2", "=SUM(Notes!A1:B2)", true])));
      return { op: kind, sheetId, rect: area, values };
    }
    case "clearRange":
      return { op: kind, sheetId, rect: area };
    // The merges recorded are a guess, so that some unmerges apply and others are refused.
    case "unmergeCells":
      return { op: kind, sheetId, rect: area, merges: dice.pick([[], [area]]) };
    case "formatCells":
      return { op: kind, sheetId, rect: area, format: dice.pick([{ bold: true }, { italic: null, fontSize: 12 }]) };
    case "borders":
      return {
        op: "formatCells", sheetId, rect: area,
        format: { borders: dice.pick([{ top: { style: "SOLID" } }, { left: null, innerHorizontal: { style: "DOTTED" } }]) },
      };
    case "mergeCells":
      return { op: kind, sheetId, rect: area, merge: dice.pick(["ALL", "ROWS", "COLUMNS"]) };
    case "addSheet": {
      let added = { id: ++believed.minted, title: `Added ${believed.minted}` };
      believed.sheets.push(added);
      return { op: kind, sheetId: added.id, title: added.title, index: dice.below(3), rowCount: 5, columnCount: 3 };
    }
    case "renameSheet": {
      let title = dice.below(4) === 0 ? "Sales" : `Renamed ${++believed.minted}`;
      on.title = title;
      return { op: kind, sheetId, title };
    }
    case "duplicateSheet": {
      let copy = { id: ++believed.minted, title: `Copy ${believed.minted}` };
      believed.sheets.push(copy);
      return { op: kind, sheetId, newSheetId: copy.id, title: copy.title, index: dice.below(3) };
    }
    case "deleteSheet":
      if (believed.sheets.length > 1) believed.sheets.splice(believed.sheets.indexOf(on), 1);
      return { op: kind, sheetId, rowCount: 20, columnCount: 6 };
    case "resizeRows":
    case "resizeColumns":
      return { op: kind, sheetId, start, count, size: 20 + dice.below(100) };
    case "freeze":
      return dice.below(2) === 0 ? { op: kind, sheetId, rows: dice.below(3) }
        : { op: kind, sheetId, rows: dice.below(2), columns: dice.below(3) };
    default:
      return { op: kind, sheetId, start, count };
  }
}

/**
 * A generated queue of one to six batches of one to three changes over `twoSheets()`. A batch
 * records, half the time, the titles of the sheets it acts on, and one time in thirty a title none
 * of them has.
 */
function generatedQueue(dice: Dice): QueuedChange[] {
  let believed: Believed = { sheets: [{ id: 0, title: "Sales" }, { id: 1, title: "Notes" }], minted: 100 };
  return Array.from({ length: 1 + dice.below(6) }, (_batch, at) => {
    let titles = new Map(believed.sheets.map(({ id, title }) => [id, title]));
    let changes = Array.from({ length: 1 + dice.below(3) }, () => generatedChange(dice, believed));
    let recorded = dice.below(2) === 0 ? [] : changes.flatMap(({ sheetId }) =>
      titles.has(sheetId) ? [[sheetId, dice.below(30) === 0 ? "Elsewhere" : titles.get(sheetId)!] as const] : []);
    return queued(at + 1, changes, Object.fromEntries(recorded));
  });
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

  it("gives a grid of its own equal to the fetched one when nothing queued changes it", () => {
    let base = grid([sheet(0, "Sales")], { "0:0:0": 1 });
    for (let changes of [[], [queued(1, [])]]) {
      let { entity } = createReplay().fold(SPREADSHEET, base, changes);
      expect(entity).toEqual(base);
      expect(entity).not.toBe(base);
    }
    expect(base).toEqual(grid([sheet(0, "Sales")], { "0:0:0": 1 }));
  });

  it("writes the fold's grid and never the fetched one", () => {
    let base = grid([sheet(0, "Sales")]);
    let { sheets, log } = base;
    let { entity } = createReplay().fold(SPREADSHEET, base, [
      queued(1, [writeA1(1)]),
      queued(2, [{ op: "renameSheet", sheetId: 0, title: "Revenue" }, writeA1(2)]),
    ]);

    expect(entity?.cells.get("0:b0:b0")).toEqual({ input: 2, at: 1, by: 2 });
    expect(entity?.sheets[0].title).toBe("Revenue");
    expect(base.cells.size).toBe(0);
    expect(base.sheets).toBe(sheets);
    expect(base.log).toBe(log);
    expect(base).toEqual(grid([sheet(0, "Sales")]));
  });

  it("copies the overlay once a fold, however many batches are queued", () => {
    let changes = Array.from({ length: 5 }, (_batch, i) => queued(i + 1, [writeA1(i)]));
    let before = editorCost.overlayCopies;

    let { entity } = createReplay().fold(SPREADSHEET, grid([sheet(0, "Sales")]), changes);

    expect(editorCost.overlayCopies - before).toBe(1);
    expect(entity?.cells.get("0:b0:b0")).toEqual({ input: 4, at: 0, by: 5 });
  });

  it("leaves the grid as the batches before made it when a batch stops at a later change", () => {
    let stopped = queued(2, [
      { op: "writeCells", sheetId: 0, rect: rect(1, 1), values: [["half"]] },
      { op: "clearRange", sheetId: 5, rect: rect(0, 0) },
    ]);
    let fold = foldedAsReplayed(() => grid([sheet(0, "Sales")]), [queued(1, [writeA1(1)]), stopped, queued(3, [writeA1(3)])]);

    expect(fold.stopped).toEqual({ record: stopped, reason: "change 2 (clearRange): the spreadsheet has no sheet with ID 5" });
    expect([...fold.entity!.cells]).toEqual([["0:b0:b0", { input: 1, at: 0, by: 1 }]]);
    expect("keys" in fold.entity!).toBe(false);
  });

  it("leaves the grid as it was when a batch of several stops at its first change", () => {
    let stopped = queued(2, [{ op: "clearRange", sheetId: 5, rect: rect(0, 0) }, writeA1(2)]);
    let fold = foldedAsReplayed(() => grid([sheet(0, "Sales")]), [queued(1, [writeA1(1)]), stopped]);

    expect(fold.stopped?.record).toBe(stopped);
    expect([...fold.entity!.cells]).toEqual([["0:b0:b0", { input: 1, at: 0, by: 1 }]]);
  });

  it("puts the grid back through inserted rows and a copied sheet", () => {
    let stopped = queued(4, [
      { op: "writeCells", sheetId: 5, rect: rect(0, 0, 1, 2), values: [["on", "the copy"]] },
      { op: "deleteRows", sheetId: 5, start: 1, count: 2 },
      { op: "deleteSheet", sheetId: 0, rowCount: 20, columnCount: 6 },
      { op: "resizeRows", sheetId: 9, start: 0, count: 1, size: 40 },
    ]);
    let fold = foldedAsReplayed(() => grid([sheet(0, "Sales")]), [
      queued(1, [
        { op: "writeCells", sheetId: 0, rect: rect(0, 0, 3, 2), values: [[1, 2], [3, "=A1"], [5, 6]] },
        { op: "resizeRows", sheetId: 0, start: 2, count: 1, size: 30 },
      ]),
      queued(2, [{ op: "formatCells", sheetId: 0, rect: rect(4, 0, 1, 3), format: { bold: true } }]),
      queued(3, [
        { op: "insertRows", sheetId: 0, start: 1, count: 2 },
        { op: "duplicateSheet", sheetId: 0, newSheetId: 5, title: "Copy", index: 1 },
        { op: "writeCells", sheetId: 5, rect: rect(1, 0), values: [["between"]] },
      ]),
      stopped,
    ]);

    expect(fold.stopped).toEqual({ record: stopped, reason: "change 4 (resizeRows): the spreadsheet has no sheet with ID 9" });
    expect(fold.entity?.sheets.map(({ id, title, rowCount }) => [id, title, rowCount]))
      .toEqual([[0, "Sales", 22], [5, "Copy", 22]]);
    // The six cells written, their copies, the cell written between the copy's inserted rows, and
    // the three formats and their copies; the row given a size, and its copy.
    expect(fold.entity?.cells.size).toBe(13);
    expect([...fold.entity!.cells.values()].filter(entry => entry.by > 1)).toEqual([{ input: "between", at: 2, by: 3 }]);
    expect(fold.entity?.formats.size).toBe(6);
    expect([...fold.entity!.sizes]).toEqual([["0:rows:b2", 30], ["5:rows:b2", 30]]);
    expect(fold.entity?.log).toHaveLength(2);
  });

  it("folds the same queue twice to the same grid", () => {
    let replay = createReplay();
    let base = grid([sheet(0, "Sales")]);
    let changes = [
      queued(1, [writeA1(1), { op: "insertRows", sheetId: 0, start: 0, count: 1 }]),
      queued(2, [writeA1(2), { op: "clearRange", sheetId: 5, rect: rect(0, 0) }]),
    ];

    let first = replay.fold(SPREADSHEET, base, changes);
    let second = replay.fold(SPREADSHEET, base, changes);

    expect(first.stopped?.record).toBe(changes[1]);
    expect(second.stopped).toEqual(first.stopped);
    expect(second.entity).toEqual(first.entity);
    expect([...second.entity!.cells]).toEqual([...first.entity!.cells]);
    expect(second.entity).not.toBe(first.entity);
    expect(second.entity?.cells).not.toBe(first.entity?.cells);
  });

  // Only a change that no longer applies stops a fold with its grid kept: any other error is a
  // fault, and may have left a part of the change in the grid, which is dropped with the fold.
  it("throws an error that is not a conflict, as replayChanges does", () => {
    // One row of values for a rectangle of two.
    let malformed: PlannedChange = { op: "writeCells", sheetId: 0, rect: rect(0, 0, 2, 1), values: [[1]] };
    for (let changes of [
      [queued(1, [malformed])],
      [queued(1, [writeA1(1)]), queued(2, [writeA1(2), malformed])],
    ]) {
      let base = grid([sheet(0, "Sales")]);
      expect(() => replayChanges(grid([sheet(0, "Sales")]), changes)).toThrow(TypeError);
      expect(() => createReplay().fold(SPREADSHEET, base, changes)).toThrow(TypeError);
      expect(base).toEqual(grid([sheet(0, "Sales")]));
    }
  });

  it("folds generated queues as replayChanges replays them", () => {
    // How many queues applied whole, and how many stopped at each change of a batch, by its number;
    // 0 counts a batch whose sheet no longer had the title it recorded.
    let whole = 0;
    let stoppedAt = [0, 0, 0, 0];
    for (let seed = 1; seed <= 200; seed++) {
      let changes = generatedQueue(diceOf(seed));
      let { stopped } = foldedAsReplayed(twoSheets, changes);
      if (stopped) stoppedAt[Number(/^change (\d+) /.exec(stopped.reason)?.[1] ?? 0)]++;
      else whole++;
    }
    // The queues reach every way a fold ends.
    expect(whole).toBeGreaterThan(20);
    for (let count of stoppedAt) expect(count).toBeGreaterThan(0);
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
