// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ExportHandler, Gadget } from "../files/server.ts";
import { workbookToXlsx } from "../files/lib/xlsx.ts";
import { addAggregate, aggregateState, finishAggregate } from "../files/lib/pivot.ts";
import { EXPORT_UNKNOWN, ExportEvaluator, MAX_EXPORT_CELLS, MAX_EXPORT_TEXT, loadExportWorkbook } from "../files/lib/export-data.ts";
import type { LineOp } from "../files/lib/lines.ts";
import type { Cell, Operation, SheetMeta, SubscriberEvent } from "../files/lib/protocol.ts";

// Durable Object storage in memory: just the calls the gadget makes, with values copied in and out
// as the real storage serializes them.
class MemoryStorage {
  map = new Map<string, unknown>();
  // The runtime's get, put and delete take at most 128 keys.
  static check(keys: unknown[]) { if (keys.length > 128) throw new Error("Too many keys in one storage call"); }
  async get(key: string | string[]): Promise<unknown> {
    if (!Array.isArray(key)) return structuredClone(this.map.get(key));
    MemoryStorage.check(key);
    return new Map(key.filter((k) => this.map.has(k)).map((k) => [k, structuredClone(this.map.get(k))]));
  }
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof key === "string" ? [[key, value] as const] : Object.entries(key);
    MemoryStorage.check(entries);
    for (const [k, v] of entries) this.map.set(k, structuredClone(v));
  }
  async delete(key: string | string[]): Promise<number> {
    if (Array.isArray(key)) MemoryStorage.check(key);
    return (Array.isArray(key) ? key : [key]).filter((k) => this.map.delete(k)).length;
  }
  async list({ prefix = "", start, startAfter, end, limit }: { prefix?: string; start?: string; startAfter?: string; end?: string; limit?: number } = {}): Promise<Map<string, unknown>> {
    const keys = [...this.map.keys()]
      .filter((k) => k.startsWith(prefix) && (start == null || k >= start) && (startAfter == null || k > startAfter) && (end == null || k < end))
      .toSorted()
      .slice(0, limit);
    return new Map(keys.map((k) => [k, structuredClone(this.map.get(k))]));
  }
}

// The runtime's state and storage are far larger than what the gadget uses; `never` hands the
// in-memory stand-ins over without pretending to implement the rest.
function newGadget(): Gadget {
  return new Gadget({ storage: new MemoryStorage() } as never, {});
}

const handler = () => new ExportHandler({} as never, {});

async function firstSheet(gadget: Gadget): Promise<SheetMeta> {
  const document = await gadget.getStructure();
  return document.sheets[document.sheetOrder[0]];
}

// Argument checks may throw before the call returns a promise, or reject it from the queue.
function failure(call: () => Promise<unknown>): Promise<unknown> {
  return Promise.resolve().then(call);
}

async function values(gadget: Gadget, range: string, sheet?: string): Promise<string[][]> {
  return (await gadget.readRange({ sheet, range })).values;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// A subscriber as the RPC layer hands it to the server, recording what it hears.
function watcher(events: SubscriberEvent[]) {
  return { operation: (event: SubscriberEvent) => { events.push(event); }, presence: () => {}, dup() { return this; }, onRpcBroken: () => {} };
}

describe("pivot aggregation", () => {
  it("sums numbers and numeric text, but counts booleans and spaces only toward Count, as Excel does", () => {
    const state = aggregateState();
    for (const value of [4, "6", "  ", true, "text", null]) addAggregate(state, value);
    expect(finishAggregate(state, "sum")).toBe(10);
    expect(finishAggregate(state, "min")).toBe(4);
    expect(finishAggregate(state, "average")).toBe(5);
    expect(finishAggregate(state, "count")).toBe(5);
  });
});

describe("cell storage", () => {
  it("reads and rewrites a block stored in more parts than one storage call takes", async () => {
    const storage = new MemoryStorage(), gadget = new Gadget({ storage } as never, {});
    await gadget.setCells({ cells: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`A${i + 1}`, String(i + 1)])) });
    // Repack the block one cell per part, as 130 parts (the rest left empty), as huge cells would be.
    const [key, whole] = [...storage.map].find(([k]) => k.startsWith("c:"))! as [string, { refs: string[]; values: string[]; versions: number[]; styles: number[]; fmts: unknown[] }];
    storage.map.delete(key);
    for (let p = 0; p < 130; p++) {
      const i = p < whole.refs.length ? [p] : [];
      const part = { refs: i.map((j) => whole.refs[j]), values: i.map((j) => whole.values[j]), versions: i.map((j) => whole.versions[j]), styles: i.map((j) => whole.styles[j]), fmts: whole.fmts };
      storage.map.set(p ? `${key}~${p}` : key, p ? part : { ...part, parts: 130 });
    }
    expect((await values(gadget, "A1:A30")).flat()).toEqual(Array.from({ length: 30 }, (_, i) => String(i + 1)));
    await gadget.setCell({ ref: "A5", value: "five" });
    expect((await values(gadget, "A4:A6")).flat()).toEqual(["4", "five", "6"]);
  });
});

describe("agent cell API", () => {
  it("takes a { value, fmt } spec as setCell's value, as setCells does", async () => {
    const gadget = newGadget();
    await gadget.setCell({ ref: "A1", value: { value: 42, fmt: { b: true } } });
    await gadget.setCell({ ref: "B1", value: { value: 7, fmt: { b: true } }, fmt: { i: true } });
    const read = await gadget.readRange({ range: "A1:B1", formats: true });
    expect(read.values).toEqual([["42", "7"]]);
    expect(read.formats).toEqual([[{ b: true }, { i: true }]]);
  });
  it("reads, writes and formats cells, bumping versions only on real changes", async () => {
    const gadget = newGadget();
    expect(await gadget.setCells({ cells: { A1: "Revenue", B2: 42, C3: "=SUM(B1:B9)", D4: true } })).toMatchObject({ status: "applied", revision: 1, updated: 4, cleared: 0 });
    expect(await values(gadget, "A1:D4")).toEqual([
      ["Revenue", "", "", ""],
      ["", "42", "", ""],
      ["", "", "=SUM(B1:B9)", ""],
      ["", "", "", "TRUE"],
    ]);
    expect(await gadget.setCell({ ref: "B2", value: 42 })).toEqual({ status: "unchanged", revision: 1, updated: 0, cleared: 0 });

    await gadget.formatRange({ range: "A1:B1", fmt: { b: true, bg: "#fbf0c2" } });
    await gadget.formatRange({ range: "A1", fmt: { b: null } });
    await gadget.setCell({ ref: "B2", value: 5, fmt: { nf: "currency", d: 0 } });
    const read = await gadget.readRange({ range: "A1:B2", formats: true });
    expect(read.values).toEqual([["Revenue", ""], ["", "5"]]);
    expect(read.formats).toEqual([[{ bg: "#fbf0c2" }, { b: true, bg: "#fbf0c2" }], [null, { nf: "currency", d: 0 }]]);

    // A plain value keeps the format; null clears the cell; an object merges its fmt.
    await gadget.setCells({ cells: { B2: 6, A1: null, B1: { fmt: { i: true } } } });
    const after = await gadget.readRange({ range: "A1:B2", formats: true });
    expect(after.values).toEqual([["", ""], ["", "6"]]);
    expect(after.formats).toEqual([[null, { b: true, bg: "#fbf0c2", i: true }], [null, { nf: "currency", d: 0 }]]);
    const document = await gadget.getDocument();
    expect(document.cells[document.sheetOrder[0]].B2.version).toBe(3);
  });

  it("keeps very small and very large numbers numbers", async () => {
    const gadget = newGadget();
    await gadget.setCells({ cells: { A1: 1.5e-7, A2: 1e21, A3: 42 } });
    // String(1.5e-7) is "1.5e-7", which the grid (like the export) would read as text.
    expect(await values(gadget, "A1:A3")).toEqual([["0.00000015"], ["1000000000000000000000"], ["42"]]);
  });

  it("writes ranges, grows the grid and clears values or formats", async () => {
    const gadget = newGadget();
    await gadget.setRange({ start: "Y99", values: [[1, 2, 3], [4, undefined, 6]], fmt: { a: "r" } });
    const sheet = await firstSheet(gadget);
    expect(sheet.rows).toBe(100);
    expect(sheet.cols).toBe(27);
    expect(await values(gadget, "Y99:AA100")).toEqual([["1", "2", "3"], ["4", "", "6"]]);

    expect(await gadget.clearRange({ range: "Y99:Z99" })).toMatchObject({ updated: 2, cleared: 0 });
    expect((await gadget.readRange({ range: "Y99", formats: true })).formats).toEqual([[{ a: "r" }]]);
    expect(await gadget.clearRange({ range: "Y99:AA100", formats: true })).toMatchObject({ updated: 0, cleared: 5 });

    await gadget.setRange({ values: [[1]], fmt: { b: true, nf: "currency" } });
    await gadget.setRange({ values: [[2]], fmt: null });
    expect((await gadget.readRange({ range: "A1", formats: true })).formats).toEqual([[null]]);
    await gadget.clearRange({ range: "A1" });

    // A huge area visits only the cells in it.
    await gadget.setCells({ cells: { C40000: "x", D2: "y" } });
    expect(await gadget.clearRange({ range: "A1000:Z50000", formats: true })).toMatchObject({ cleared: 1 });
    expect((await gadget.listSheets()).sheets[0]).toMatchObject({ usedRange: "A1:D2", cellCount: 1 });
  });

  it("validates arguments", async () => {
    const gadget = newGadget();
    await expect(failure(() => gadget.formatRange({ range: "A1", fmt: { nf: "0.00%" } }))).rejects.toThrow('Unknown number format "0.00%"');
    await expect(failure(() => gadget.formatRange({ range: "A1", fmt: { bg: "red" } }))).rejects.toThrow("bg must be a hex colour");
    await expect(failure(() => gadget.formatRange({ range: "A1", fmt: { a: "x" } as never }))).rejects.toThrow('a must be "l", "c" or "r"');
    await expect(failure(() => gadget.formatRange({ range: "A1", fmt: { bold: true } as never }))).rejects.toThrow('Unknown format key "bold"');
    await expect(failure(() => gadget.formatRange({ range: "A1" }))).rejects.toThrow("formatRange needs fmt");
    await expect(failure(() => gadget.setRange({ values: "x" as never }))).rejects.toThrow("values must be an array of rows");
    await expect(failure(() => gadget.setRange({ start: "1A", values: [] }))).rejects.toThrow("Bad start cell: 1A");
    await expect(failure(() => gadget.setCells({ cells: [1] as never }))).rejects.toThrow("cells must be an object");
    await expect(failure(() => gadget.setCells({ cells: { A1: { value: 1, fmt: { s: true, fs: 12, nf: "pct" } } } }))).rejects.toThrow('Unknown number format "pct"');
    await expect(failure(() => gadget.addChart({ range: "A1:B3", type: "bar" }))).rejects.toThrow('Unknown chart type "bar"');
    await expect(failure(() => gadget.addChart({ range: "B3" }))).resolves.toMatchObject({ status: "applied" });
    await expect(failure(() => gadget.addChart({ range: "B3:" }))).rejects.toThrow("Bad range: B3:");
    await expect(failure(() => gadget.insertRows({ at: 1, count: 50000 }))).rejects.toThrow("A sheet holds at most 50,000 rows");
    await expect(failure(() => gadget.insertCols({ at: "A", count: 700 }))).rejects.toThrow("A sheet holds at most 702 columns");
    await expect(failure(() => gadget.deleteRows({ at: 1, count: 100 }))).rejects.toThrow("Can't delete that many rows");
    await expect(failure(() => gadget.insertRows({ at: 0 }))).rejects.toThrow("Bad row number: 0");
    await expect(failure(() => gadget.insertCols({ at: "1" }))).rejects.toThrow('Bad column: 1 (use a letter such as "C")');
    await expect(failure(() => gadget.insertRows({ at: 102 }))).rejects.toThrow("Row out of range");
    await expect(failure(() => gadget.setCell({ sheet: "Nope", ref: "B2", value: 5 }))).rejects.toThrow('No sheet "Nope". Sheets: Sheet1');
    await expect(failure(() => gadget.setCell({ ref: "B0", value: 5 }))).rejects.toThrow("Bad cell: B0");
    await expect(failure(() => gadget.setCell({ ref: "A50001", value: 5 }))).rejects.toThrow("Cell out of range: A50001");
    await expect(failure(() => gadget.readRange({ range: "A1:Z50000" }))).rejects.toThrow("Range too large to read at once");
    await expect(failure(() => gadget.deleteSheet({}))).rejects.toThrow("A workbook needs at least one sheet");
    // Only the valid addChart above wrote.
    expect((await gadget.getDocument()).revision).toBe(1);
  });

  it("moves cells and every formula reference into the sheet when rows and columns are inserted or deleted", async () => {
    const gadget = newGadget();
    const { sheetId: other } = await gadget.addSheet({ name: "Other" });
    await gadget.setCells({ cells: { A1: 1, A2: 2, A3: 3, B1: "=SUM(A1:A3)", B2: "=$A$3*2", C1: "=Other!A1" } });
    await gadget.setCells({ sheet: "Other", cells: { A1: "=Sheet1!A3+SUM(Sheet1!A1:A3)", B1: "=A1" } });
    await gadget.addChart({ range: "A1:A3", type: "pie" });

    expect(await gadget.insertRows({ at: 2, count: 2 })).toMatchObject({ status: "applied" });
    expect(await values(gadget, "A1:B5")).toEqual([["1", "=SUM(A1:A5)"], ["", ""], ["", ""], ["2", "=$A$5*2"], ["3", ""]]);
    expect(await values(gadget, "A1:B1", "Other")).toEqual([["=Sheet1!A5+SUM(Sheet1!A1:A5)", "=A1"]]);
    expect((await firstSheet(gadget)).rows).toBe(102);
    expect((await firstSheet(gadget)).charts[0].range).toBe("A1:A5");

    await gadget.deleteRows({ at: 5 });
    expect(await values(gadget, "A1:B4")).toEqual([["1", "=SUM(A1:A4)"], ["", ""], ["", ""], ["2", "=#REF!*2"]]);
    expect(await values(gadget, "A1", "Other")).toEqual([["=#REF!+SUM(Sheet1!A1:A4)"]]);

    await gadget.insertCols({ at: "A" });
    expect(await values(gadget, "A1:D1")).toEqual([["", "1", "=SUM(B1:B4)", "=Other!A1"]]);
    expect(await values(gadget, "A1", "Other")).toEqual([["=#REF!+SUM(Sheet1!B1:B4)"]]);
    await gadget.deleteCols({ sheet: other, at: 1 });
    expect(await values(gadget, "A1", "Other")).toEqual([["=#REF!"]]);
    expect(await values(gadget, "D1")).toEqual([["=#REF!"]]);
  });

  it("adds, renames and deletes sheets; formulas name sheets by id, so they read a new name", async () => {
    const gadget = newGadget();
    expect(await gadget.addSheet({ name: "Data", index: 0 })).toMatchObject({ status: "applied", name: "Data" });
    await expect(gadget.addSheet({ name: "data" })).rejects.toThrow('A sheet named "data" already exists');
    expect(await gadget.addSheet({})).toMatchObject({ name: "Sheet3" });
    await gadget.setCells({ sheet: "Data", cells: { A1: 5, B1: "=Data!A1*2" } });
    await gadget.setCells({ sheet: "Sheet1", cells: { A1: "=Data!A1+1", A2: "=SUM(Data!A1:B1)", A3: '="Data!A1"', A4: "=data!A1" } });

    await gadget.renameSheet({ sheet: "Data", name: "Owner's Data" });
    expect(await values(gadget, "A1:A4", "Sheet1")).toEqual([["='Owner''s Data'!A1+1"], ["=SUM('Owner''s Data'!A1:B1)"], ['="Data!A1"'], ["='Owner''s Data'!A1"]]);
    expect(await values(gadget, "B1", "owner's data")).toEqual([["='Owner''s Data'!A1*2"]]);
    await expect(gadget.renameSheet({ sheet: "Sheet1", name: " " })).rejects.toThrow("Sheet name can't be empty");
    await expect(gadget.renameSheet({ sheet: "Sheet1", name: "Sheet3" })).rejects.toThrow('A sheet named "Sheet3" already exists');
    expect(await gadget.renameSheet({ sheet: "Sheet1", name: "Sheet1" })).toMatchObject({ status: "unchanged" });

    await gadget.deleteSheet({ sheet: "Owner's Data" });
    const sheets = (await gadget.listSheets()).sheets;
    expect(sheets.map((s) => s.name)).toEqual(["Sheet1", "Sheet3"]);
    // A reference to a deleted sheet reads #REF!, as in Excel.
    expect(await values(gadget, "A1:A2", "Sheet1")).toEqual([["=#REF!+1"], ["=SUM(#REF!)"]]);
  });

  it("adds charts and sets column widths", async () => {
    const gadget = newGadget();
    await gadget.setColumnWidths({ widths: { A: 180, 3: 10, D: 5000 } });
    expect((await firstSheet(gadget)).colWidths).toEqual({ 0: 180, 2: 24, 3: 2000 });
    await gadget.setColumnWidths({ widths: { A: null } });
    expect((await firstSheet(gadget)).colWidths).toEqual({ 2: 24, 3: 2000 });

    const { chartId } = await gadget.addChart({ range: "a1:c5", type: "stackedBar", title: "Sales" });
    const [chart] = (await firstSheet(gadget)).charts;
    expect(chart).toMatchObject({ id: chartId, type: "stackedBar", range: "A1:C5", title: "Sales", x: 44 + 24 + 92 + 92 + 24, y: 28 });
    expect((await gadget.listSheets()).sheets[0].charts).toEqual([{ id: chartId, type: "stackedBar", range: "A1:C5", title: "Sales" }]);

    // Data against the sheet's last column leaves no room beside it: the chart goes under it.
    const { cols } = await firstSheet(gadget);
    const last = String.fromCharCode(64 + cols);
    await gadget.addChart({ range: `${last}2:${last}4` });
    const below = (await firstSheet(gadget)).charts[1];
    let left = 44;
    for (let c = 0; c < cols - 1; c++) left += ({ 2: 24, 3: 2000 } as Record<number, number>)[c] ?? 92;
    expect(below).toMatchObject({ x: left, y: 24 + 4 * 24 + 24 });
  });

  it("places a new chart past the filled columns beside its data", async () => {
    const gadget = newGadget();
    await gadget.setRange({ values: [["Region", "Q1", "Q2", "Total"], ["N", 1, 2, 3], ["S", 4, 5, 9]] });
    await gadget.addChart({ range: "A1:C3" });
    expect((await firstSheet(gadget)).charts[0]).toMatchObject({ x: 44 + 4 * 92 + 24, y: 28 });
  });
});

describe("applyOperation", () => {
  it("rejects a stale cell edit with the authoritative cell", async () => {
    const gadget = newGadget();
    const { sheetOrder: [sheetId] } = await gadget.getStructure();
    const first = await gadget.applyOperation({ senderId: "a", cellOps: [{ sheetId, ref: "A1", value: "one", fmt: null, baseVersion: 0 }] });
    expect(first).toMatchObject({ status: "applied", revision: 1, conflicts: [], upserts: [{ sheetId, ref: "A1", cell: { value: "one", fmt: null, version: 1 } }] });

    const stale = await gadget.applyOperation({
      senderId: "b",
      cellOps: [
        { sheetId, ref: "A1", value: "two", fmt: null, baseVersion: 0 },
        { sheetId, ref: "B1", value: "fresh", fmt: { b: true }, baseVersion: 0 },
      ],
    });
    expect(stale.status).toBe("conflict");
    expect(stale.conflicts).toEqual([{ sheetId, ref: "A1", cell: { value: "one", fmt: null, version: 1 } }]);
    expect(stale.upserts).toEqual([{ sheetId, ref: "B1", cell: { value: "fresh", fmt: { b: true }, version: 1 } }]);

    // A stale delete conflicts too; a current one deletes.
    expect((await gadget.applyOperation({ cellOps: [{ sheetId, ref: "A1", value: null, fmt: null, baseVersion: 0 }] })).status).toBe("conflict");
    expect(await gadget.applyOperation({ cellOps: [{ sheetId, ref: "A1", value: null, fmt: null, baseVersion: 1 }] })).toMatchObject({ status: "applied", deletes: [{ sheetId, ref: "A1" }] });
    expect(await gadget.applyOperation({ cellOps: [{ sheetId, ref: "A1", value: null, fmt: null, baseVersion: 1 }] })).toMatchObject({ status: "unchanged" });
  });

  it("applies line operations by id, so an edit made before them still lands on its cell", async () => {
    const gadget = newGadget();
    const { sheetOrder: [sheetId] } = await gadget.getStructure();
    const events: SubscriberEvent[] = [];
    await gadget.subscribe(watcher(events), { clientId: "peer", lines: true });
    await gadget.setCells({ cells: { A1: "first", A2: "second", B1: "=SUM(A1:A2)" } });
    // One client inserts a row above A1.
    const insert: LineOp = { kind: "insert", sheetId, axis: "rows", ids: [2 ** 32], before: 0 };
    expect(await gadget.applyOperation({ senderId: "b", lineIds: true, lineOps: [insert] })).toMatchObject({
      status: "applied", revision: 2, lineOps: [insert], orders: { [sheetId]: { rows: [[2 ** 32, 1], [0, 100]], cols: [[0, 26]] } }, upserts: [],
    });
    await settle();
    expect(events[1]).toMatchObject({ senderId: "b", lineOps: [insert], structure: { sheets: { [sheetId]: { rows: 101 } } } });
    // Another's edit of the "second" record, made before it heard of the insert, still names that record.
    expect(await gadget.applyOperation({ senderId: "a", lineIds: true, cellOps: [{ sheetId, ref: "1:0", value: "edited", fmt: null, baseVersion: 1 }] })).toMatchObject({ status: "applied", upserts: [{ sheetId, ref: "1:0" }] });
    expect(await values(gadget, "A1:B3")).toEqual([["", ""], ["first", "=SUM(A2:A3)"], ["edited", ""]]);

    // Once its row is deleted, an edit of it is refused as gone, and its cells go with the row.
    await gadget.applyOperation({ senderId: "b", lineIds: true, lineOps: [{ kind: "delete", sheetId, axis: "rows", ids: [1] }] });
    expect(await gadget.applyOperation({ senderId: "a", lineIds: true, cellOps: [{ sheetId, ref: "1:0", value: "late", fmt: null, baseVersion: 2 }] })).toEqual({ status: "unchanged", revision: 4, conflicts: [], gone: [{ sheetId, ref: "1:0" }] });
    expect(await values(gadget, "A1:B2")).toEqual([["", ""], ["first", "=SUM(A2:A2)"]]);
    expect(Object.keys(await gadget.loadCells(sheetId)).toSorted()).toEqual(["0:0", "0:1"]);

    // A moved row takes its cells along, and a range follows the line it ends on.
    await gadget.setCells({ cells: { A3: "third" } });
    const [, firstRow, thirdRow] = (await gadget.openDocument()).orders![sheetId].rows.flatMap(([start, count, gone]) => gone ? [] : Array.from({ length: count }, (_, i) => start + i));
    await gadget.applyOperation({ senderId: "b", lineIds: true, lineOps: [{ kind: "move", sheetId, axis: "rows", ids: [thirdRow], before: firstRow }] });
    expect(await values(gadget, "A1:B3")).toEqual([["", ""], ["third", ""], ["first", "=SUM(A3:A3)"]]);
  });

  it("refuses line operations that can't apply, and applies the rest", async () => {
    const gadget = newGadget();
    const { sheetOrder: [sheetId] } = await gadget.getStructure();
    // An insert whose lines are all placed already happened (its save is being sent again); one
    // with only some of them placed collides with another.
    const again: LineOp = { kind: "insert", sheetId, axis: "rows", ids: [5], before: null };
    const taken: LineOp = { kind: "insert", sheetId, axis: "rows", ids: [5, 2 ** 32 + 96], before: null };
    const everything: LineOp = { kind: "delete", sheetId, axis: "cols", ids: Array.from({ length: 26 }, (_, i) => i) };
    const fine: LineOp = { kind: "insert", sheetId, axis: "cols", ids: [2 ** 32 + 64], before: 0 };
    const result = await gadget.applyOperation({ lineIds: true, lineOps: [again, taken, everything, { kind: "move", sheetId, axis: "rows", ids: [3], before: 3 }, fine] });
    expect(result).toMatchObject({ status: "applied", lineOps: [fine], refusedLines: [taken, everything, { kind: "move" }] });
    expect((await firstSheet(gadget)).cols).toBe(27);
    // Malformed ones are skipped outright.
    expect(await gadget.applyOperation({ lineIds: true, lineOps: [{ kind: "insert", sheetId, axis: "rows", ids: [-1], before: null }, { kind: "spin" } as never, null as never] })).toMatchObject({ status: "unchanged" });
  });

  it("creates a sheet and starts it over before the lines changed after, in one operation", async () => {
    const gadget = newGadget();
    const { sheetOrder, sheets } = await gadget.getStructure();
    const cell = (value: string): Cell => ({ value, fmt: null, version: 1 });
    const added = { ...sheets[sheetOrder[0]], id: "s_added", name: "Added", rows: 3, cols: 2 };
    const inserted = 2 ** 32;
    const lineOps: LineOp[] = [
      { kind: "insert", sheetId: "s_added", axis: "rows", ids: [inserted], before: 0 },
      { kind: "delete", sheetId: "s_added", axis: "rows", ids: [1] },
    ];
    const result = await gadget.applyOperation({
      lineIds: true, lineOps,
      structure: { sheetOrder: [...sheetOrder, "s_added"], sheets: { ...sheets, s_added: added } },
      sheetReplacements: [{ sheetId: "s_added", size: { rows: 3, cols: 2 }, cells: { "0:0": cell("top"), "1:0": cell("deleted"), "2:0": cell("last") } }],
      cellOps: [{ sheetId: "s_added", ref: `${inserted}:1`, value: "new", fmt: null, baseVersion: 0 }],
    });
    expect(result).toMatchObject({ status: "applied", lineOps });
    expect(result.refusedLines).toBeUndefined();
    expect(await values(gadget, "A1:B3", "Added")).toEqual([["", "new"], ["top", ""], ["last", ""]]);
    // Sent again (its reply was lost), they have nothing left to do.
    expect(await gadget.applyOperation({ lineIds: true, lineOps })).toMatchObject({ status: "unchanged" });
  });

  it("applies a sort's cells all together, and refuses someone's older edit of a sorted cell", async () => {
    const gadget = newGadget();
    const { sheetOrder: [sheetId] } = await gadget.getStructure();
    await gadget.setCells({ cells: { A1: "b", A2: "a" } });
    const write = (ref: string, value: string, baseVersion: number) => ({ sheetId, ref, value, fmt: null, baseVersion });
    const sort = { sheetId, rows: [0, 1], cols: [0], cellOps: [write("0:0", "a", 1), write("1:0", "b", 1)] };
    // Built on a cell that has changed since, a sort would misplace a record: refused whole.
    expect(await gadget.applyOperation({ senderId: "s", lineIds: true, sorts: [{ ...sort, cellOps: [write("0:0", "a", 0), write("1:0", "b", 1)] }], cellOps: [write("5:5", "with it", 0)] })).toMatchObject({ status: "conflict", revision: 1, refusedSorts: [sheetId] });
    expect(await values(gadget, "A1:A2")).toEqual([["b"], ["a"]]);
    expect(await values(gadget, "F6")).toEqual([[""]]);
    expect(await gadget.applyOperation({ senderId: "s", lineIds: true, sorts: [sort] })).toMatchObject({ status: "applied", revision: 2, upserts: [{ ref: "0:0" }, { ref: "1:0" }] });
    // An edit of "b" in A1 made before the sort (on revision 1) would land on "a" now.
    expect(await gadget.applyOperation({ senderId: "e", lineIds: true, cellOps: [{ ...write("0:0", "b!", 1), basis: 1 }] })).toMatchObject({ status: "unchanged", sorted: [{ sheetId, ref: "0:0" }] });
    // One made after it is an ordinary edit, and so is the sorter's own, which knew of its sort.
    expect(await gadget.applyOperation({ senderId: "e", lineIds: true, cellOps: [{ ...write("0:0", "a!", 2), basis: 2 }] })).toMatchObject({ status: "applied" });
    expect(await gadget.applyOperation({ senderId: "s", lineIds: true, cellOps: [{ ...write("1:0", "b!", 2), basis: 1 }] })).toMatchObject({ status: "applied" });
    expect(await values(gadget, "A1:A2")).toEqual([["a!"], ["b!"]]);
  });

  it("applies a staged replacement only once every part has arrived, and tells peers", async () => {
    const gadget = newGadget();
    const { sheetOrder: [sheetId] } = await gadget.getStructure();
    const events: SubscriberEvent[] = [];
    await gadget.subscribe(watcher(events), { clientId: "peer", lines: true });

    const cell = (value: string): Cell => ({ value, fmt: null, version: 1 });
    expect(gadget.stageCells({ uploadId: "u1", sheetId, part: 0, cells: { "0:0": cell("a"), "1:0": cell("b") } })).toEqual({ received: 2 });
    const replacement: Operation = { senderId: "me", lineIds: true, sheetReplacements: [{ sheetId, size: { rows: 3, cols: 2 }, uploadId: "u1", count: 3 }] };
    expect(await gadget.applyOperation(replacement)).toEqual({ status: "upload-missing", revision: 0, conflicts: [] });
    // A repeated part is not counted twice.
    expect(gadget.stageCells({ uploadId: "u1", sheetId, part: 0, cells: { "8:0": cell("dup") } })).toEqual({ received: 2 });
    expect(gadget.stageCells({ uploadId: "u1", sheetId, part: 1, cells: { "2:0": cell("c") } })).toEqual({ received: 3 });
    expect(await gadget.applyOperation(replacement)).toMatchObject({ status: "applied", revision: 1, replacedSheets: [sheetId], orders: { [sheetId]: { rows: [[0, 3]], cols: [[0, 2]] } } });
    expect(await values(gadget, "A1:A3")).toEqual([["a"], ["b"], ["c"]]);
    expect(await firstSheet(gadget)).toMatchObject({ rows: 3, cols: 2 });
    // The upload is used up.
    expect((await gadget.applyOperation(replacement)).status).toBe("upload-missing");
    expect(() => gadget.stageCells({ uploadId: "", sheetId, part: 0, cells: {} })).toThrow("Bad upload id");

    await settle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "operation", senderId: "me", replacedSheets: [sheetId], replacedCells: { [sheetId]: { "2:0": { value: "c" } } } });
  });

  it("serves an editor from before line ids by position, beside one that speaks ids", async () => {
    const gadget = newGadget();
    const oldEvents: SubscriberEvent[] = [], newEvents: SubscriberEvent[] = [];
    const opened = await gadget.subscribe(watcher(oldEvents), { clientId: "old" });
    const [sheetId] = opened.sheetOrder;
    expect(opened.cells?.[sheetId]).toEqual({});
    await gadget.subscribe(watcher(newEvents), { clientId: "new", lines: true });
    await gadget.applyOperation({ senderId: "new", lineIds: true, cellOps: [{ sheetId, ref: "0:0", value: "x", fmt: null, baseVersion: 0 }] });
    await settle();
    expect(oldEvents[0]).toMatchObject({ type: "operation", upserts: [{ sheetId, ref: "A1", cell: { value: "x" } }] });

    // Rows inserted above reach it as the whole workbook by position.
    await gadget.applyOperation({ senderId: "new", lineIds: true, lineOps: [{ kind: "insert", sheetId, axis: "rows", ids: [2 ** 32, 2 ** 32 + 1], before: 0 }] });
    await settle();
    expect(oldEvents[1]).toMatchObject({ type: "snapshot", document: { sheets: { [sheetId]: { rows: 102 } }, cells: { [sheetId]: { A3: { value: "x" } } } } });

    // Its edits and formulas by position name the cells there now, and its reply is by position.
    const reply = await gadget.applyOperation({ senderId: "old", cellOps: [{ sheetId, ref: "B3", value: "=A3&\"!\"", fmt: null, baseVersion: 0 }, { sheetId, ref: "A3", value: "stale", fmt: null, baseVersion: 0 }] });
    expect(reply).toMatchObject({ status: "conflict", upserts: [{ sheetId, ref: "B3", cell: { value: "=A3&\"!\"" } }], conflicts: [{ sheetId, ref: "A3", cell: { value: "x" } }] });
    await settle();
    const upsert = newEvents.at(-1)?.type === "operation" ? (newEvents.at(-1) as { upserts: { ref: string; cell: Cell }[] }).upserts[0] : null;
    expect(upsert?.ref).toBe("0:1");
    // Stored by id: inserting another row above keeps the formula on its cell.
    await gadget.insertRows({ at: 1 });
    expect(await values(gadget, "A4:B4")).toEqual([["x", "=A4&\"!\""]]);
  });

  it("keeps a sheet the agent added after the snapshot a structure update was built on", async () => {
    const gadget = newGadget();
    const document = await gadget.getDocument();
    const [sheetId] = document.sheetOrder;
    const snapshot = { title: document.title, sheetOrder: document.sheetOrder, sheets: structuredClone(document.sheets), revision: document.revision };
    snapshot.sheets[sheetId].colWidths = { 0: 200 };

    const { sheetId: added } = await gadget.addSheet({ name: "Agent" });
    await gadget.setCells({ sheet: "Agent", cells: { A1: "important" } });
    expect((await gadget.applyOperation({ senderId: "c", structure: snapshot })).status).toBe("applied");
    const after = await gadget.getDocument();
    expect(after.sheetOrder.map((id) => after.sheets[id].name)).toEqual(["Sheet1", "Agent"]);
    expect(after.cells[added]).toEqual({ A1: { value: "important", fmt: null, version: 1 } });
    expect(after.sheets[sheetId].colWidths).toEqual({ 0: 200 });

    // A snapshot that already knew the sheet deletes it.
    await gadget.applyOperation({ structure: { sheetOrder: [sheetId], sheets: { [sheetId]: after.sheets[sheetId] }, revision: after.revision } });
    expect((await gadget.listSheets()).sheets.map((s) => s.name)).toEqual(["Sheet1"]);
    expect(await gadget.loadCells(added)).toEqual({});
  });
});

describe("untrusted input", () => {
  it("refuses a chart past the limit instead of dropping it", async () => {
    const gadget = newGadget();
    for (let i = 0; i < 50; i++) await gadget.addChart({ range: "A1:B3" });
    await expect(failure(() => gadget.addChart({ range: "A1:B3" }))).rejects.toThrow("at most 50 charts");
    expect((await firstSheet(gadget)).charts).toHaveLength(50);
  });

  it("refuses a missing operation and skips malformed parts of one", async () => {
    const gadget = newGadget();
    const sheetId = (await firstSheet(gadget)).id;
    await expect(failure(() => gadget.applyOperation(null))).rejects.toThrow("applyOperation takes an operation object");
    await expect(gadget.applyOperation({ senderId: "x", cellOps: "A1" as never })).resolves.toMatchObject({ status: "unchanged" });
    const result = await gadget.applyOperation({
      senderId: "x",
      cellOps: [null as never, { sheetId, ref: "A1", value: "kept", fmt: null, baseVersion: 0 }],
      sheetReplacements: [null as never],
    });
    expect(result).toMatchObject({ status: "applied", conflicts: [] });
    expect(await values(gadget, "A1")).toEqual([["kept"]]);
    await expect(gadget.updatePresence(null)).resolves.toBeUndefined();
  });

  it("never reverses an insert or delete through its count, and refuses columns that aren't numbers", async () => {
    const gadget = newGadget();
    await gadget.setCells({ cells: { A1: "keep", A2: "too" } });
    await expect(failure(() => gadget.insertRows({ at: 1, count: -1 }))).rejects.toThrow("Bad count: -1");
    await expect(failure(() => gadget.deleteRows({ at: 1, count: -3 }))).rejects.toThrow("Bad count: -3");
    await expect(failure(() => gadget.deleteCols({ at: "A", count: 0 }))).rejects.toThrow("Bad count: 0");
    await expect(failure(() => gadget.insertCols({ at: Number.NaN }))).rejects.toThrow("Bad column: NaN");
    expect(await values(gadget, "A1:A2")).toEqual([["keep"], ["too"]]);
    expect(await gadget.insertRows({ at: 1, count: null as never })).toMatchObject({ status: "applied" });
    expect(await values(gadget, "A1:A3")).toEqual([[""], ["keep"], ["too"]]);
  });

  it("takes only plain new sheet ids, never an empty sheet order, and bounded size maps", async () => {
    const gadget = newGadget();
    const document = await gadget.getDocument();
    const [sheetId] = document.sheetOrder;
    await gadget.setCell({ ref: "A1", value: "x" });
    const sheet = { ...document.sheets[sheetId], rowHeights: { 5: 30, 60000: 30 }, colWidths: { 3: 120, 999: 120 } };
    await gadget.applyOperation({ structure: { sheetOrder: ["__proto__", "a:b", "constructor~1", sheetId], sheets: { [sheetId]: sheet } } });
    let after = await gadget.getStructure();
    expect(after.sheetOrder).toEqual([sheetId]);
    expect(Object.keys(after.sheets)).toEqual([sheetId]);
    expect(after.sheets[sheetId].rowHeights).toEqual({ 5: 30 });
    expect(after.sheets[sheetId].colWidths).toEqual({ 3: 120 });

    await gadget.applyOperation({ structure: { sheetOrder: [], sheets: {} } });
    after = await gadget.getStructure();
    expect(after.sheetOrder).toEqual([sheetId]);
    expect(await values(gadget, "A1")).toEqual([["x"]]);
  });

  it("writes only cells a sheet can have, so no export stretches past A1:ZZ50000", async () => {
    const gadget = newGadget();
    const { sheetOrder: [sheetId] } = await gadget.getStructure();
    const op = (ref: string) => ({ sheetId, ref, value: "x", fmt: null, baseVersion: 0 });
    // By position (an editor from before line ids), a cell past the edge reaches nothing.
    const result = await gadget.applyOperation({ cellOps: [op("ZZZ999999"), op("AAA1"), op("A50001"), op("Z100")] });
    expect(result.upserts?.map((upsert) => upsert.ref)).toEqual(["Z100"]);
    await gadget.applyOperation({ sheetReplacements: [{ sheetId, cells: { A1: { value: "a", fmt: null, version: 1 }, ZZZ1: { value: "b", fmt: null, version: 1 } } } as never] });
    expect(Object.keys(await gadget.loadCells(sheetId))).toEqual(["0:0"]);
    // By id, only a live cell; a regenerated sheet only within its size.
    expect(await gadget.applyOperation({ lineIds: true, cellOps: [op("100:0"), op("0:26"), op("A1"), op("0:1")] })).toMatchObject({ gone: [{ ref: "100:0" }, { ref: "0:26" }], upserts: [{ ref: "0:1" }] });
    await gadget.applyOperation({ lineIds: true, sheetReplacements: [{ sheetId, size: { rows: 2, cols: 2 }, cells: { "1:1": { value: "in", fmt: null, version: 1 }, "2:0": { value: "out", fmt: null, version: 1 } } }] });
    expect(Object.keys(await gadget.loadCells(sheetId))).toEqual(["1:1"]);
  });

  it("ignores cells and pages for sheet ids Object.prototype answers to", async () => {
    const gadget = newGadget();
    const result = await gadget.applyOperation({ cellOps: [{ sheetId: "constructor", ref: "A1", value: "x", fmt: null, baseVersion: 0 }] });
    expect(result.status).toBe("unchanged");
    expect(await gadget.getCellsPage({ sheetId: "toString" })).toMatchObject({ missing: true });
    expect(await gadget.exportPage({ sheetId: "hasOwnProperty" })).toMatchObject({ missing: true });
    expect((await gadget.getSheetSlices({ sheetIds: ["valueOf"] })).slices).toEqual([]);
  });

  it("sends collaborators only plain presence colours, and releases a subscriber it drops", async () => {
    const gadget = newGadget();
    const seen: unknown[] = [];
    let disposed = 0;
    const watcher = { operation: () => {}, presence: (event: unknown) => { seen.push(event); }, dup() { return this; }, onRpcBroken: () => {} };
    const broken = { operation: () => Promise.reject(new Error("gone")), presence: () => {}, dup() { return this; }, onRpcBroken: () => {}, [Symbol.dispose]: () => { disposed++; } };
    await gadget.subscribe(watcher, { clientId: "w", lines: true });
    await gadget.subscribe(broken, { clientId: "b", lines: true });
    await gadget.updatePresence({ clientId: "x".repeat(500), name: "Eve", color: "red;position:fixed;inset:0", sheetId: null, r1: 0, c1: 0, r2: 0, c2: 0 });
    await gadget.updatePresence({ clientId: "y", name: "Ann", color: "hsl(120 62% 48%)", sheetId: null, r1: 0, c1: 0, r2: 0, c2: 0 });
    expect(seen.filter((event) => (event as { type: string }).type === "cursor")).toMatchObject([
      { clientId: "x".repeat(80), color: "#e1632e" },
      { clientId: "y", color: "hsl(120 62% 48%)" },
    ]);
    await gadget.setCell({ ref: "A1", value: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(1);
    expect(gadget.subscribers.size).toBe(1);
  });
});

// --- Export -------------------------------------------------------------------------------

const decoder = new TextDecoder();

function uint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint16(offset, true);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true);
}

// The archive format itself is the zip library's to test; this reads the parts back by the
// central directory.
async function unzip(stream: ReadableStream<Uint8Array>): Promise<Map<string, string>> {
  const archive = new Uint8Array(await new Response(stream).arrayBuffer());
  const end = archive.byteLength - 22;
  expect(uint32(archive, end)).toBe(0x06054b50);
  const parts = new Map<string, string>();
  let offset = uint32(archive, end + 16);
  for (let i = uint16(archive, end + 10); i > 0; i--) {
    const compressedSize = uint32(archive, offset + 20);
    const nameLength = uint16(archive, offset + 28);
    const local = uint32(archive, offset + 42);
    const name = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength));
    const data = local + 30 + uint16(archive, local + 26) + uint16(archive, local + 28);
    const inflated = new Response(archive.slice(data, data + compressedSize)).body!.pipeThrough(new DecompressionStream("deflate-raw"));
    parts.set(name, await new Response(inflated).text());
    offset += 46 + nameLength + uint16(archive, offset + 30) + uint16(archive, offset + 32);
  }
  return parts;
}

async function xlsx(gadget: Gadget): Promise<Map<string, string>> {
  return unzip(await handler().export(gadget, "xlsx"));
}

function part(parts: Map<string, string>, name: string): string {
  const text = parts.get(name);
  if (text === undefined) throw new Error(`No ${name} in ${[...parts.keys()].join(", ")}`);
  return text;
}

function cellXml(xml: string, reference: string): string {
  const match = new RegExp(`<c r="${reference}"[^>]*?/>|<c r="${reference}"[^>]*>[\\s\\S]*?</c>`).exec(xml);
  if (!match) throw new Error(`No ${reference}`);
  return match[0];
}

// The style a cell's `s` names, resolved to its font, fill, number format and alignment XML.
function cellStyle(parts: Map<string, string>, sheetXml: string, reference: string) {
  const styles = part(parts, "xl/styles.xml");
  const index = Number(/ s="(\d+)"/.exec(cellXml(sheetXml, reference))?.[1] ?? 0);
  const listed = (tag: string) => [...(new RegExp(`<${tag}s count="\\d+">([\\s\\S]*?)</${tag}s>`).exec(styles)?.[1] ?? "").matchAll(new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`, "g"))].map((m) => m[0]);
  const xf = [.../<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1].matchAll(/<xf\b[\s\S]*?<\/xf>/g) ?? []][index][0];
  const attribute = (name: string) => Number(new RegExp(` ${name}="(\\d+)"`).exec(xf)?.[1]);
  const numberFormatId = attribute("numFmtId");
  return {
    font: listed("font")[attribute("fontId")],
    fill: listed("fill")[attribute("fillId")],
    numberFormat: new RegExp(`<numFmt numFmtId="${numberFormatId}" formatCode="([^"]*)"/>`).exec(styles)?.[1] ?? numberFormatId,
    alignment: /<alignment [^>]*\/>/.exec(xf)?.[0],
  };
}

async function salesWorkbook(): Promise<Gadget> {
  const gadget = newGadget();
  await gadget.renameSheet({ sheet: "Sheet1", name: "Sales Data" });
  await gadget.setRange({
    values: [
      ["Region", "Q1", "Q2", "Total", "Share", "Date", "Link"],
      ["North", 1200, 1350, "=SUM(B2:C2)", "=D2/$D$6", "=DATE(2024,1,15)", "https://example.com/north"],
      ["South", 980.5, 1110, "=SUM(B3:C3)", "=D3/$D$6", "=DATE(2024,2,29)", '=HYPERLINK("https://example.com","Ex")'],
      ["West", 1430, 1520, "=SUM(B4:C4)", "=D4/$D$6", "=F3+30", 'plain, "quoted" text'],
      ["East", -50, "", "=SUM(B5:C5)", "=D5/$D$6", "", "ünïcødé ✓ 日本"],
      ["Total", "=SUM(B2:B5)", "=SUM(C2:C5)", "=SUM(D2:D5)", "=SUM(E2:E5)", "", '=IF(D6>0,"pos","neg")'],
    ],
  });
  await gadget.formatRange({ range: "A1:G1", fmt: { b: true, bg: "#fbf0c2", a: "c" } });
  await gadget.formatRange({ range: "B2:D6", fmt: { nf: "currency", d: 0 } });
  await gadget.formatRange({ range: "E2:E6", fmt: { nf: "percent", d: 1 } });
  await gadget.formatRange({ range: "F2:F4", fmt: { nf: "date" } });
  await gadget.formatRange({ range: "A6:G6", fmt: { b: true, i: true, u: true, c: "#d0473f", fs: 16 } });
  await gadget.formatRange({ range: "A5", fmt: { s: true, wrap: true } });
  await gadget.setColumnWidths({ widths: { A: 140, G: 220 } });
  await gadget.addChart({ range: "A1:C5", type: "line", title: "Quarterly", xAxisTitle: "Region", yAxisTitle: "USD" });
  await gadget.addChart({ range: "A1:B5", type: "pie", title: "Q1 share", y: 400 });
  await gadget.addSheet({ name: "Owner's Sheet" });
  await gadget.setCells({
    sheet: "Owner's Sheet",
    cells: { A1: "Ref", B1: "='Sales Data'!D6*2", B2: "=1/0", B3: '=VLOOKUP("West",\'Sales Data\'!A2:D5,4,FALSE)', B4: "'00123", B5: true, B6: "=B6+1", B7: 123456789, B8: '="a"&"b"' },
  });
  await gadget.formatRange({ sheet: "Owner's Sheet", range: "B7", fmt: { nf: "scientific", d: 2 } });
  return gadget;
}

describe("XLSX export", () => {
  // Excel allows 256 fills in a workbook; a heatmap of more shades still exports.
  it("exports formats past Excel's fill limit without their fill", async () => {
    const gadget = newGadget();
    const shades = Array.from({ length: 300 }, (_, i) => "#" + (0x102030 + i).toString(16));
    for (let i = 0; i < shades.length; i++) await gadget.setCell({ ref: `A${i + 1}`, value: i, fmt: { bg: shades[i] } });
    const parts = await xlsx(gadget);
    expect(Number(/<fills count="(\d+)"/.exec(part(parts, "xl/styles.xml"))?.[1])).toBe(256);
    const sheetXml = part(parts, "xl/worksheets/sheet1.xml");
    expect(cellStyle(parts, sheetXml, "A1").fill).toContain('rgb="FF102030"');
    expect(cellStyle(parts, sheetXml, "A300").fill).not.toContain("rgb=");
  });
  it("reads a backslash before a closing double quote as text, as Excel does", async () => {
    const gadget = newGadget();
    await gadget.setCell({ ref: "A1", value: '="C:\\"&"x"' });
    const sheetXml = part(await xlsx(gadget), "xl/worksheets/sheet1.xml");
    expect(cellXml(sheetXml, "A1")).toBe('<c r="A1" t="str"><f>"C:\\"&amp;"x"</f><v>C:\\x</v></c>');
  });
  it("writes the workbook, sheets, cached values and formulas", async () => {
    const parts = await xlsx(await salesWorkbook());
    expect([...parts.keys()].toSorted()).toEqual([
      "[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/charts/chart1.xml", "xl/charts/chart2.xml",
      "xl/drawings/_rels/drawing1.xml.rels", "xl/drawings/drawing1.xml", "xl/styles.xml", "xl/workbook.xml",
      "xl/worksheets/_rels/sheet1.xml.rels", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml",
    ]);
    const workbook = part(parts, "xl/workbook.xml");
    expect(workbook).toContain('<sheets><sheet name="Sales Data" sheetId="1" r:id="rId1"/><sheet name="Owner&apos;s Sheet" sheetId="2" r:id="rId2"/></sheets>');
    expect(workbook).toContain('<calcPr calcId="0" fullCalcOnLoad="1"/>');

    const sales = part(parts, "xl/worksheets/sheet1.xml");
    expect(sales).toContain('<dimension ref="A1:G6"/>');
    expect(cellXml(sales, "A1")).toBe('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Region</t></is></c>');
    expect(cellXml(sales, "B3")).toBe('<c r="B3" s="2"><v>980.5</v></c>');
    expect(cellXml(sales, "D3")).toBe('<c r="D3" s="2"><f>SUM(B3:C3)</f><v>2090.5</v></c>');
    expect(cellXml(sales, "F3")).toBe('<c r="F3" s="4"><f>DATE(2024,2,29)</f><v>45351</v></c>');
    expect(cellXml(sales, "G4")).toBe('<c r="G4" t="inlineStr"><is><t xml:space="preserve">plain, "quoted" text</t></is></c>');
    expect(cellXml(sales, "G6")).toBe('<c r="G6" s="7" t="str"><f>IF(D6&gt;0,"pos","neg")</f><v>pos</v></c>');

    const owner = part(parts, "xl/worksheets/sheet2.xml");
    expect(cellXml(owner, "B1")).toBe("<c r=\"B1\"><f>'Sales Data'!D6*2</f><v>15081</v></c>");
    expect(cellXml(owner, "B2")).toMatch(/^<c r="B2" s="\d+" t="e"><f>1\/0<\/f><v>#DIV\/0!<\/v><\/c>$/);
    expect(cellXml(owner, "B3")).toBe("<c r=\"B3\"><f>VLOOKUP(\"West\",'Sales Data'!A2:D5,4,FALSE)</f><v>2950</v></c>");
    expect(cellXml(owner, "B4")).toBe('<c r="B4" t="inlineStr"><is><t xml:space="preserve">00123</t></is></c>');
    expect(cellXml(owner, "B5")).toMatch(/^<c r="B5" s="\d+" t="b"><v>1<\/v><\/c>$/);
    // A circular reference has no value to cache: Excel recalculates it.
    expect(cellXml(owner, "B6")).toMatch(/^<c r="B6" s="\d+"><f>B6\+1<\/f><\/c>$/);
    expect(cellXml(owner, "B8")).toBe('<c r="B8" t="str"><f>"a"&amp;"b"</f><v>ab</v></c>');
  });

  it("writes fonts, fills, number formats, alignment, wrap and column widths", async () => {
    const parts = await xlsx(await salesWorkbook());
    const sales = part(parts, "xl/worksheets/sheet1.xml");
    expect(cellStyle(parts, sales, "A1")).toEqual({
      font: '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>',
      fill: '<fill><patternFill patternType="solid"><fgColor rgb="FFFBF0C2"/><bgColor indexed="64"/></patternFill></fill>',
      numberFormat: 0,
      alignment: '<alignment vertical="center" horizontal="center"/>',
    });
    expect(cellStyle(parts, sales, "B2").numberFormat).toBe("&quot;$&quot;#,##0;-&quot;$&quot;#,##0");
    expect(cellStyle(parts, sales, "E2").numberFormat).toBe("#,##0.0%");
    expect(cellStyle(parts, sales, "F2").numberFormat).toBe("mm/dd/yyyy");
    expect(cellStyle(parts, sales, "A5")).toMatchObject({ font: expect.stringContaining("<strike/>"), alignment: '<alignment vertical="center" wrapText="1"/>' });
    // 16 CSS pixels is 12 points.
    expect(cellStyle(parts, sales, "B6")).toMatchObject({
      font: '<font><b/><i/><u/><sz val="13.5"/><color rgb="FFD0473F"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>',
      numberFormat: "&quot;$&quot;#,##0;-&quot;$&quot;#,##0",
    });
    expect(cellStyle(parts, part(parts, "xl/worksheets/sheet2.xml"), "B7").numberFormat).toBe("0.00E+00");
    expect(sales).toContain('<cols><col min="1" max="1" width="19.28515625" customWidth="1"/><col min="7" max="7" width="30.71484375" customWidth="1"/></cols>');
  });

  it("writes charts in a drawing, and hyperlinks", async () => {
    const parts = await xlsx(await salesWorkbook());
    const sales = part(parts, "xl/worksheets/sheet1.xml");
    expect(sales).toContain('<hyperlinks><hyperlink ref="G2" r:id="rId1"/></hyperlinks><drawing r:id="rId2"/>');
    // A HYPERLINK() formula carries its own link: it is styled as one but needs no relationship.
    expect(cellStyle(parts, sales, "G3").font).toContain('<u/><sz val="11"/><color rgb="FF2F6FD1"/>');
    const relationships = part(parts, "xl/worksheets/_rels/sheet1.xml.rels");
    expect(relationships).toContain('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/north" TargetMode="External"/>');
    expect(relationships).toContain('Target="../drawings/drawing1.xml"');
    expect(part(parts, "xl/drawings/_rels/drawing1.xml.rels")).toContain('Target="../charts/chart2.xml"');
    expect(part(parts, "xl/drawings/drawing1.xml").match(/<xdr:oneCellAnchor>/g)).toHaveLength(2);

    const line = part(parts, "xl/charts/chart1.xml");
    expect(line).toContain("<c:lineChart>");
    expect(line).toContain("<a:t>Quarterly</a:t>");
    expect(line).toContain("<c:f>'Sales Data'!$A$2:$A$5</c:f>");
    expect(line).toContain("<c:f>'Sales Data'!$C$2:$C$5</c:f>");
    expect(line).toContain('<c:pt idx="3"><c:v>-50</c:v></c:pt>');
    expect(line).toContain("<a:t>USD</a:t>");
    const pie = part(parts, "xl/charts/chart2.xml");
    expect(pie).toContain("<c:pieChart>");
    expect(pie).not.toContain("$C$2");
    const contentTypes = part(parts, "[Content_Types].xml");
    expect(contentTypes).toContain('<Override PartName="/xl/charts/chart2.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>');
    expect(contentTypes).toContain('<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>');
  });

  it("hides no row for a filter value the export couldn't work out", async () => {
    const gadget = newGadget();
    await gadget.setRange({ values: [["Name", "Double"], ["a", "=1*2"], ["b", "=2*2"]] });
    const document = await gadget.getStructure();
    const [id] = document.sheetOrder;
    const filter = { row: 0, endRow: 2, columns: [0, 1], criteria: { 1: ["n:2"] }, rowOrder: [], sort: null };
    await gadget.applyOperation({ structure: { sheetOrder: document.sheetOrder, sheets: { [id]: { ...document.sheets[id], filter } } } });
    const workbook = await loadExportWorkbook(gadget, { formats: true });
    const evaluator = new ExportEvaluator(workbook);
    evaluator.limits.budget = 0; // no formula is worked out
    const xml = part(await unzip(workbookToXlsx(workbook, evaluator)), "xl/worksheets/sheet1.xml");
    expect(xml).not.toContain('hidden="1"');
  });

  it("writes frozen panes, row heights, and a filter with its hidden rows and sort", async () => {
    const gadget = newGadget();
    await gadget.setRange({ values: [["Name", "Qty", "Double", "Price"], ["a", 1, "=B2*2", 3.5], ["b", 2, "=B3*2", 4], ["c", 3, "=B4*2", 1200], ["d", 4, "=B5*2", 9]] });
    await gadget.formatRange({ range: "D2:D5", fmt: { nf: "currency" } });
    const document = await gadget.getStructure();
    const [id] = document.sheetOrder;
    const sheet: SheetMeta = {
      ...document.sheets[id], frozenRows: 1, frozenCols: 1, rowHeights: { 0: 40 },
      filter: { row: 0, endRow: 4, columns: [0, 1, 2, 3], criteria: { 2: ["n:2", "n:6"], 3: ["n:3.5", "n:1200", "n:4"] }, rowOrder: [], sort: { column: 1, direction: "desc" } },
    };
    expect((await gadget.applyOperation({ structure: { sheetOrder: document.sheetOrder, sheets: { [id]: sheet } } })).status).toBe("applied");

    const parts = await xlsx(gadget);
    const xml = part(parts, "xl/worksheets/sheet1.xml");
    expect(xml).toContain('<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/>');
    expect(xml).toContain('<row r="1" ht="30" customHeight="1">');
    expect(xml).toContain('<row r="2">');
    expect(xml).toContain('<row r="3" hidden="1">');
    expect(xml).toContain('<row r="4">');
    expect(xml).toContain('<row r="5" hidden="1">');
    expect(xml).toContain(
      '<autoFilter ref="A1:D5"><filterColumn colId="2"><filters><filter val="2"/><filter val="6"/></filters></filterColumn>'
      + '<filterColumn colId="3"><filters><filter val="$3.50"/><filter val="$1,200.00"/><filter val="$4.00"/></filters></filterColumn>'
      + '<sortState ref="A2:D5"><sortCondition ref="B2:B5" descending="1"/></sortState></autoFilter>',
    );
    expect(part(parts, "xl/workbook.xml")).toContain("<definedNames><definedName name=\"_xlnm._FilterDatabase\" localSheetId=\"0\" hidden=\"1\">'Sheet1'!$A$1:$D$5</definedName></definedNames>");
  });

  it("gives sheets names Excel accepts and rewrites the formulas that name them", async () => {
    const gadget = newGadget();
    await gadget.renameSheet({ sheet: "Sheet1", name: "Q1/Q2: [draft]?" });
    await gadget.addSheet({ name: "q1_q2_ _draft__" });
    await gadget.addSheet({ name: "A very long sheet name that Excel would refuse" });
    await gadget.addSheet({ name: "History" });
    await gadget.setCells({ sheet: "History", cells: { A1: "='Q1/Q2: [draft]?'!A1+'A very long sheet name that Excel would refuse'!B2", A2: '="Q1/Q2: [draft]?!A1"' } });

    const parts = await xlsx(gadget);
    const names = [...part(parts, "xl/workbook.xml").matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
    // "History" is reserved in Excel.
    expect(names).toEqual(["Q1_Q2_ _draft__", "q1_q2_ _draft__ (2)", "A very long sheet name that Exc", "History_"]);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(31);
    const history = part(parts, "xl/worksheets/sheet4.xml");
    expect(cellXml(history, "A1")).toContain("<f>'Q1_Q2_ _draft__'!A1+'A very long sheet name that Exc'!B2</f>");
    expect(cellXml(history, "A2")).toContain('<f>"Q1/Q2: [draft]?!A1"</f>');
  });

  it("writes decimals on an Automatic cell, and fonts in the order Excel's schema requires", async () => {
    const gadget = newGadget();
    await gadget.setCells({ cells: { A1: { value: 1.23456, fmt: { nf: "auto", d: 2 } }, A2: { value: "x", fmt: { u: true, s: true } } } });
    const parts = await xlsx(gadget);
    const sheet = part(parts, "xl/worksheets/sheet1.xml");
    // The grid shows 1.23 (fixed decimals, no grouping), not General's 1.23456.
    expect(cellStyle(parts, sheet, "A1").numberFormat).toBe("0.00");
    expect(cellStyle(parts, sheet, "A2").font).toBe('<font><strike/><u/><sz val="11"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>');
  });

  it("writes errors in the grid's red, centres errors and booleans, and keeps right-to-left text on the left, unless aligned", async () => {
    const gadget = newGadget();
    await gadget.setCells({ cells: { A1: "=1/0", A2: { value: "=NA()", fmt: { c: "#2f9e66", a: "l" } }, A3: "TRUE", A4: "=1>0", A5: "'TRUE", A6: 5, A7: "مرحبا بالعالم", A8: { value: "שלום", fmt: { a: "r" } } } });
    const parts = await xlsx(gadget);
    const sheet = part(parts, "xl/worksheets/sheet1.xml");
    expect(cellStyle(parts, sheet, "A1").font).toContain('<color rgb="FFD0473F"/>');
    expect(cellStyle(parts, sheet, "A1").alignment).toBe('<alignment vertical="center" horizontal="center"/>');
    expect(cellStyle(parts, sheet, "A2").font).toContain('<color rgb="FF2F9E66"/>');
    expect(cellStyle(parts, sheet, "A2").alignment).toBe('<alignment vertical="center" horizontal="left"/>');
    expect(cellStyle(parts, sheet, "A3").alignment).toBe('<alignment vertical="center" horizontal="center"/>');
    expect(cellStyle(parts, sheet, "A4").alignment).toBe('<alignment vertical="center" horizontal="center"/>');
    expect(cellStyle(parts, sheet, "A5").alignment).toBe('<alignment vertical="center"/>');
    expect(cellXml(sheet, "A6")).toBe('<c r="A6"><v>5</v></c>');
    // The grid lays text out left to right; Excel would align Arabic or Hebrew text right by itself.
    expect(cellStyle(parts, sheet, "A7").alignment).toBe('<alignment vertical="center" horizontal="left"/>');
    expect(cellStyle(parts, sheet, "A8").alignment).toBe('<alignment vertical="center" horizontal="right"/>');
  });

  it("draws charts as the grid does: white card, named blank headers, pie slices and stacked bars", async () => {
    const gadget = newGadget();
    await gadget.setRange({ values: [["Month", "Sales", ""], ["Jan", 120, 1], ["Feb", -40, 2], ["Mar", "", 3], ["Apr", 200, 4], ["May", 0, 5]] });
    await gadget.addChart({ range: "A1:C6", type: "line" });
    await gadget.addChart({ range: "A1:B6", type: "pie" });
    await gadget.addChart({ range: "A1:C6", type: "stackedBar" });
    const parts = await xlsx(gadget);
    const line = part(parts, "xl/charts/chart1.xml");
    expect(line).toContain('<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="E4E4E1"/></a:solidFill></a:ln></c:spPr></c:chartSpace>');
    // Column C's header is blank: the grid calls the series "C", which a reference to the blank cell would lose.
    expect(line).toContain("<c:tx><c:v>C</c:v></c:tx>");
    expect(line).toContain("<c:f>'Sheet1'!$B$1</c:f>");
    expect(line).toContain('<c:tickLblPos val="low"/>');
    expect(line).toContain('<c:numFmt formatCode="General" sourceLinked="0"/>');
    const pie = part(parts, "xl/charts/chart2.xml");
    // Jan and Apr are the grid's first two slices (orange, blue); Feb is negative and comes after;
    // Mar (blank) and May (zero) have no slice, so no colour and no legend entry.
    const colours = [...pie.matchAll(/<c:dPt><c:idx val="(\d)"\/><c:bubble3D val="0"\/><c:spPr><a:solidFill><a:srgbClr val="(\w+)"/g)].map((m) => [Number(m[1]), m[2]]);
    expect(colours).toEqual([[0, "E1632E"], [3, "3478C7"], [1, "1F9D77"]]);
    expect(pie).toContain('<c:legend><c:legendPos val="r"/><c:legendEntry><c:idx val="2"/><c:delete val="1"/></c:legendEntry><c:legendEntry><c:idx val="4"/><c:delete val="1"/></c:legendEntry><c:overlay val="0"/></c:legend>');
    // Feb is negative: the grid stacks it leftwards from zero, so Excel's axis isn't pinned at 0.
    expect(part(parts, "xl/charts/chart3.xml")).toContain('<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling>');
  });

  // Each of these opened in Excel for the web as a damaged workbook, a link to another workbook,
  // or a different value from the grid's.
  it("writes formulas Excel opens as the grid shows them: empty calls, missing sheets, range results", async () => {
    const gadget = newGadget();
    await gadget.setCells({ cells: {
      A1: 1, A2: 2, B1: "=SUM()", B2: "=AND( )", B3: "=PI()+ROW()", B4: "=Nosheet!A1", B5: "='No sheet'!A1:A2", B6: "=A1:A2", B7: '="SUM()"',
    } });
    const sheet = part(await xlsx(gadget), "xl/worksheets/sheet1.xml");
    // Excel requires SUM's and AND's arguments and calls a file holding SUM() damaged; they stay text, as unbalanced formulas do.
    expect(cellXml(sheet, "B1")).toBe('<c r="B1" t="inlineStr"><is><t xml:space="preserve">=SUM()</t></is></c>');
    expect(cellXml(sheet, "B2")).toContain('<t xml:space="preserve">=AND( )</t>');
    expect(cellXml(sheet, "B3")).toContain("<f>PI()+ROW()</f>");
    expect(cellXml(sheet, "B7")).toContain('<f>"SUM()"</f>');
    // A sheet the workbook lacks is #REF!, not a link to another workbook; Excel calls #REF!A1 damaged.
    expect(cellXml(sheet, "B4")).toMatch(/^<c r="B4" s="\d+" t="e"><f>#REF!<\/f><v>#REF!<\/v><\/c>$/);
    expect(cellXml(sheet, "B5")).toContain(">#REF!</f>");
    // The grid shows a range's first value; a one-cell array formula does too.
    expect(cellXml(sheet, "B6")).toBe('<c r="B6"><f t="array" ref="B6">A1:A2</f><v>1</v></c>');
  });

  it("prefixes Excel's newer functions, names ERROR.TYPE as Excel does, and keeps quoted text and sheet names as typed", async () => {
    const gadget = newGadget();
    await gadget.addSheet({ name: "CONCAT" });
    await gadget.setCells({ cells: {
      A1: '=IFS(TRUE,1)+IFNA(A9,0)+XOR(TRUE,FALSE)+SWITCH(1,1,1)+LEN(CONCAT("a","b"))+LEN(TEXTJOIN(",",TRUE,A9))+DAYS(2,1)',
      A2: '=LEN("CONCAT(")+ERRORTYPE(NA())+LEN(CONCAT!A1)',
      A3: "=ERRORTYPE(NA())" + "+0".repeat(4088),
      A4: "=ERRORTYPE(NA())" + "+0".repeat(4087),
    } });
    const sheet = part(await xlsx(gadget), "xl/worksheets/sheet1.xml");
    expect(cellXml(sheet, "A1")).toContain('<f>_xlfn.IFS(TRUE,1)+_xlfn.IFNA(A9,0)+_xlfn.XOR(TRUE,FALSE)+_xlfn.SWITCH(1,1,1)+LEN(_xlfn.CONCAT("a","b"))+LEN(_xlfn.TEXTJOIN(",",TRUE,A9))+_xlfn.DAYS(2,1)</f>');
    expect(cellXml(sheet, "A2")).toContain('<f>LEN("CONCAT(")+ERROR.TYPE(NA())+LEN(CONCAT!A1)</f>');
    // Excel holds 8,192 characters of formula: one the longer name takes past that stays text.
    expect(cellXml(sheet, "A3")).toContain('t="inlineStr"><is><t xml:space="preserve">=ERRORTYPE(NA())+0');
    expect(cellXml(sheet, "A4")).toContain("<f>ERROR.TYPE(NA())+0");
  });

  it("writes array constants, empty arguments and error values as Excel reads them, with Excel's results", async () => {
    const gadget = newGadget();
    await gadget.setCells({ cells: {
      A1: '=LOOKUP(3,{1, 2, 3},{"x","y","z"})', A2: "=MATCH(5,{1,3;5,7})", A3: "=IF(,1,2)", A4: "=IF(1,)", A5: "=IFERROR(#N/A,{1})", A6: "=SQRT(2)^2=2", A7: "=Z99",
    } });
    const sheet = part(await xlsx(gadget), "xl/worksheets/sheet1.xml");
    expect(cellXml(sheet, "A1")).toBe('<c r="A1" t="str"><f>LOOKUP(3,{1,2,3},{"x","y","z"})</f><v>z</v></c>');
    expect(cellXml(sheet, "A2")).toBe('<c r="A2"><f>MATCH(5,{1,3;5,7})</f><v>3</v></c>');
    expect(cellXml(sheet, "A3")).toBe('<c r="A3"><f>IF(,1,2)</f><v>2</v></c>');
    expect(cellXml(sheet, "A4")).toBe('<c r="A4"><f>IF(1,)</f><v>0</v></c>');
    expect(cellXml(sheet, "A5")).toBe('<c r="A5"><f>IFERROR(#N/A,{1})</f><v>1</v></c>');
    expect(cellXml(sheet, "A6")).toMatch(/^<c r="A6" s="\d+" t="b"><f>SQRT\(2\)\^2=2<\/f><v>1<\/v><\/c>$/);
    // An empty cell's value is 0 in Excel, and in the grid.
    expect(cellXml(sheet, "A7")).toBe('<c r="A7"><f>Z99</f><v>0</v></c>');
  });

  it("wraps typed line breaks, as Excel does, in a row tall enough for the lines", async () => {
    const gadget = newGadget();
    await gadget.setCells({ cells: { A1: "one\ntwo", B1: "x", A2: "a\nb\nc", A3: '="p"&CHAR(10)&"q"', A4: "one\ntwo" } });
    await gadget.formatRange({ range: "A2", fmt: { fs: 16, b: true } });
    const document = await gadget.getStructure();
    const [id] = document.sheetOrder;
    // A row with its own height keeps it.
    expect((await gadget.applyOperation({ structure: { sheetOrder: document.sheetOrder, sheets: { [id]: { ...document.sheets[id], rowHeights: { 3: 30 } } } } })).status).toBe("applied");
    const parts = await xlsx(gadget);
    const sheet = part(parts, "xl/worksheets/sheet1.xml");
    expect(cellStyle(parts, sheet, "A1").alignment).toBe('<alignment vertical="center" wrapText="1"/>');
    expect(cellStyle(parts, sheet, "A2")).toMatchObject({ font: expect.stringContaining("<b/>"), alignment: '<alignment vertical="center" wrapText="1"/>' });
    expect(cellXml(sheet, "B1")).toBe('<c r="B1" t="inlineStr"><is><t xml:space="preserve">x</t></is></c>');
    // A formula's line break doesn't set wrap in Excel either.
    expect(cellXml(sheet, "A3")).toBe('<c r="A3" t="str"><f>"p"&amp;CHAR(10)&amp;"q"</f><v>p\nq</v></c>');
    // Two lines of 13px text at 1.35 lines plus padding: 41.1px, 30.83pt; three of 16px: 70.8px.
    expect(sheet).toContain('<row r="1" ht="30.83" customHeight="1">');
    expect(sheet).toContain('<row r="2" ht="53.1" customHeight="1">');
    expect(sheet).toContain('<row r="3">');
    expect(sheet).toContain('<row r="4" ht="22.5" customHeight="1">');
  });

  it("draws an area chart's blanks as zero, and a line chart's as gaps", async () => {
    const gadget = newGadget();
    await gadget.setRange({ values: [["Month", "Sales"], ["Jan", 120], ["Feb", ""], ["Mar", 200]] });
    await gadget.addChart({ range: "A1:B4", type: "area" });
    await gadget.addChart({ range: "A1:B4", type: "line" });
    const parts = await xlsx(gadget);
    expect(part(parts, "xl/charts/chart1.xml")).toContain('<c:dispBlanksAs val="zero"/>');
    expect(part(parts, "xl/charts/chart2.xml")).toContain('<c:dispBlanksAs val="gap"/>');
  });

  it("exports an empty workbook", async () => {
    const parts = await xlsx(newGadget());
    expect(part(parts, "xl/worksheets/sheet1.xml")).toContain('<dimension ref="A1"/>');
    expect(part(parts, "xl/worksheets/sheet1.xml")).toContain("<sheetData></sheetData>");
  });
});

// Response.text() would drop the byte-order mark.
async function csvText(gadget: Gadget, sheetId: string): Promise<string> {
  const bytes = await new Response(await handler().export(gadget, "csv:" + sheetId)).arrayBuffer();
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
}

describe("CSV export", () => {
  it("offers one format per sheet", async () => {
    const gadget = newGadget();
    const labels = (await handler().getExportFormats(gadget)).map((format) => format.label);
    expect(labels).toEqual(["Excel workbook", "CSV", "PDF"]);
    expect((await handler().getExportFormats(gadget)).find((format) => format.label === "CSV")?.fileName).toBeUndefined();
    const { sheetId } = await gadget.addSheet({ name: "Two" });
    const formats = await handler().getExportFormats(gadget);
    expect(formats.filter((format) => format.id.startsWith("csv:")).map((format) => [format.id, format.label, format.fileName])).toEqual([
      ["csv:" + (await gadget.getStructure()).sheetOrder[0], "CSV (Sheet1)", "Sheet1.csv"],
      ["csv:" + sheetId, "CSV (Two)", "Two.csv"],
    ]);
    // Each name is one the Workshop accepts, and no two are the same.
    await gadget.addSheet({ name: "Q1 / 2024" });
    await gadget.addSheet({ name: "Q1-2024" });
    await gadget.addSheet({ name: "売上" });
    expect((await handler().getExportFormats(gadget)).filter((format) => format.id.startsWith("csv:")).map((format) => format.fileName))
      .toEqual(["Sheet1.csv", "Two.csv", "Q1-2024.csv", "Q1-2024-2.csv", "Sheet5.csv"]);
    await expect(handler().export(gadget, "csv:s_missing")).rejects.toThrow("The selected worksheet is unavailable for CSV export.");
    await expect(handler().export(gadget, "docx")).rejects.toThrow("Unsupported spreadsheet export format: docx");
  });

  it("writes displayed values with a BOM, CRLF line ends and quoting", async () => {
    const gadget = await salesWorkbook();
    const [sales, owner] = (await gadget.getStructure()).sheetOrder;
    const csv = await csvText(gadget, sales);
    expect(csv).toBe(
      "﻿Region,Q1,Q2,Total,Share,Date,Link\r\n"
      + "North,\"$1,200\",\"$1,350\",\"$2,550\",33.8%,01/15/2024,https://example.com/north\r\n"
      + "South,$981,\"$1,110\",\"$2,091\",27.7%,02/29/2024,Ex\r\n"
      + "West,\"$1,430\",\"$1,520\",\"$2,950\",39.1%,03/30/2024,\"plain, \"\"quoted\"\" text\"\r\n"
      + "East,-$50,,-$50,-0.7%,,ünïcødé ✓ 日本\r\n"
      + "Total,\"$3,561\",\"$3,980\",\"$7,541\",100.0%,,pos\r\n",
    );
    const other = await csvText(gadget, owner);
    expect(other.split("\r\n").slice(0, 8)).toEqual(["﻿Ref,15081", ",#DIV/0!", ",2950", ",00123", ",TRUE", ",#CYCLE!", ",1.23E+08", ",ab"]);
  });
});

describe("export size", () => {
  it("refuses a workbook with more cells than one export can hold", async () => {
    const meta: SheetMeta = { id: "s1", name: "Sheet1", rows: 100, cols: 26, colWidths: {}, rowHeights: {}, frozenRows: 0, frozenCols: 0, filter: null, charts: [], pivot: null };
    const refs = Array.from({ length: MAX_EXPORT_CELLS + 1 }, () => "A1");
    const gadget = {
      getStructure: async () => ({ revision: 1, title: "Book", sheetOrder: ["s1"], sheets: { s1: meta } }),
      exportPage: async () => ({ revision: 1, refs, values: refs, next: null }),
    };
    await expect(loadExportWorkbook(gadget, { formats: false })).rejects.toThrow("more than can be exported at once");
  });

  it("refuses a workbook with more text than one export can hold", async () => {
    const meta: SheetMeta = { id: "s1", name: "Sheet1", rows: 100, cols: 26, colWidths: {}, rowHeights: {}, frozenRows: 0, frozenCols: 0, filter: null, charts: [], pivot: null };
    const long = "x".repeat(8192), count = Math.ceil(MAX_EXPORT_TEXT / long.length) + 1;
    const gadget = {
      getStructure: async () => ({ revision: 1, title: "Book", sheetOrder: ["s1"], sheets: { s1: meta } }),
      exportPage: async () => ({ revision: 1, refs: Array.from({ length: count }, () => "A1"), values: Array.from({ length: count }, () => long), next: null }),
    };
    await expect(loadExportWorkbook(gadget, { formats: false })).rejects.toThrow("characters of text");
  });

  it("leaves formulas past the evaluation budget without a result, and still reads literals", async () => {
    const meta: SheetMeta = { id: "s1", name: "Sheet1", rows: 100, cols: 26, colWidths: {}, rowHeights: {}, frozenRows: 0, frozenCols: 0, filter: null, charts: [], pivot: null };
    const refs = ["A1", "A2", "B1", "B2"], cellValues = ["1", "2", "=SUM(A1:A2)", "=A1*10"];
    const gadget = {
      getStructure: async () => ({ revision: 1, title: "Book", sheetOrder: ["s1"], sheets: { s1: meta } }),
      exportPage: async () => ({ revision: 1, refs, values: cellValues, next: null }),
    };
    const evaluator = new ExportEvaluator(await loadExportWorkbook(gadget, { formats: false }));
    evaluator.limits.budget = 1; // spent by the first formula's reads
    expect(evaluator.value("s1", 0, 1)).toBe(EXPORT_UNKNOWN);
    expect(evaluator.value("s1", 1, 1)).toBe(EXPORT_UNKNOWN);
    expect(evaluator.value("s1", 0, 0)).toBe(1);
    // CSV writes an unknown formula as its text.
    expect(evaluator.display("s1", 1, 1, null)).toBe("=A1*10");
    expect(evaluator.display("s1", 1, 0, null)).toBe("2");
  });
});

describe("review regressions", () => {
  it("keeps text that would start a formula as text in CSV, and numbers as they show", async () => {
    const gadget = newGadget();
    await gadget.setRange({ values: [["'=1+1", "'+cmd", -5, '="=2+2"', "'-x", "@SUM(A1)", "'\tTab"]] });
    await gadget.setCell({ ref: "A2", value: -50, fmt: { nf: "currency", d: 0 } });
    const csv = await csvText(gadget, (await gadget.getStructure()).sheetOrder[0]);
    expect(csv).toBe("﻿'=1+1,'+cmd,-5,'=2+2,'-x,'@SUM(A1),'\tTab\r\n-$50,,,,,,\r\n");
  });

  it("pages a block of long rows between rows, so no reload or export page outgrows a message", async () => {
    const gadget = newGadget();
    const { sheetOrder: [sheetId] } = await gadget.getStructure();
    const value = (ref: string) => ref.padEnd(8192, "x");
    // 32 rows (one block) saved one at a time, each 20 cells of 8,192 characters: 5 MB in one block.
    const columns = Array.from({ length: 20 }, (_, c) => String.fromCharCode(65 + c));
    for (let row = 1; row <= 32; row++) {
      await gadget.applyOperation({ cellOps: columns.map((column) => ({ sheetId, ref: column + row, value: value(column + row), fmt: null, baseVersion: 0 })) });
    }
    const size = (packed: { values: string[] }) => packed.values.reduce((sum, text) => sum + text.length, 0);
    const opened = await gadget.openDocument();
    const loaded = new Map<string, string>();
    const take = (packed: { refs: string[]; values: string[] }) => {
      expect(size(packed)).toBeLessThanOrEqual(2_000_000);
      packed.refs.forEach((ref, i) => { expect(loaded.has(ref)).toBe(false); loaded.set(ref, packed.values[i]); });
    };
    take(opened.packed![sheetId]);
    for (const slice of opened.slices!) {
      for (let after = slice.after; ;) {
        const page = await gadget.getCellsPage({ sheetId, after, from: slice.from, to: slice.to });
        take(page.packed!);
        if (page.next == null) break;
        after = page.next;
      }
    }
    expect(loaded.size).toBe(640);
    expect(loaded.get("31:19")).toBe(value("T32"));

    const pages: number[] = [];
    const recording = { getStructure: () => gadget.getStructure(), exportPage: async (options: { sheetId: string; after?: string; formats?: boolean }) => { const page = await gadget.exportPage(options); pages.push(size(page)); return page; } };
    const workbook = await loadExportWorkbook(recording, { formats: true });
    expect(workbook.cells.get(sheetId)?.size).toBe(640);
    expect(pages.length).toBeGreaterThan(1);
    expect(Math.max(...pages)).toBeLessThanOrEqual(3_000_000);
    const csv = (await csvText(gadget, sheetId)).split("\r\n");
    expect(csv).toHaveLength(33);
    expect(csv[31].split(",")[19]).toBe(value("T32"));
  });

  it("sends peers `null` for replaced sheets and agent edits past the inline text budget", async () => {
    const gadget = newGadget();
    const { sheetOrder: [sheetId] } = await gadget.getStructure();
    const events: SubscriberEvent[] = [];
    await gadget.subscribe({ operation: (event) => { events.push(event); }, presence: () => {}, dup() { return this; }, onRpcBroken: () => {} }, { clientId: "peer", lines: true });
    const long = "y".repeat(8192), cells: Record<string, Cell> = {};
    for (let r = 0; r < 300; r++) cells[r + ":0"] = { value: long, fmt: null, version: 1 };
    await gadget.applyOperation({ senderId: "me", lineIds: true, sheetReplacements: [{ sheetId, size: { rows: 300, cols: 26 }, cells }] });
    await gadget.setRange({ start: "B1", values: Array.from({ length: 300 }, () => [long]) });
    await settle();
    expect(events).toMatchObject([{ replacedCells: { [sheetId]: null } }, { upserts: [], replacedCells: { [sheetId]: null } }]);
  });

  it("bounds what staged uploads hold, and releases those named by an operation it refused", async () => {
    const gadget = newGadget();
    const { sheetOrder: [sheetId] } = await gadget.getStructure();
    const cell = (value: string, version = 1): Cell => ({ value, fmt: null, version });
    // A staged sort's cells carry their base versions; this one was built before A1 was written.
    gadget.stageCells({ uploadId: "small", sheetId, part: 0, cells: { "0:0": cell("a", 0) } });
    await gadget.setCell({ ref: "A1", value: "moved on" });
    expect(await gadget.applyOperation({ lineIds: true, sorts: [{ sheetId, rows: [0], cols: [0], uploadId: "small", count: 1 }] })).toMatchObject({ refusedSorts: [sheetId] });
    expect(gadget.uploads.size).toBe(0);

    const long = "z".repeat(8192), huge: Record<string, Cell> = {};
    for (let r = 0; r < 5000; r++) huge[r + ":0"] = cell(long);
    expect(() => gadget.stageCells({ uploadId: "huge", sheetId, part: 0, cells: huge })).toThrow("too large to save at once");
    expect(gadget.uploads.size).toBe(0);
  });

  it("works out chart caches only as the archive reaches each chart", async () => {
    const gadget = newGadget();
    await gadget.setRange({ values: Array.from({ length: 1500 }, (_, r) => [r, r * 2]) });
    for (let i = 0; i < 3; i++) await gadget.addChart({ range: "A1:B1500", type: "line", firstRowHeaders: false });
    const workbook = await loadExportWorkbook(gadget, { formats: true });
    const evaluator = new ExportEvaluator(workbook);
    const stream = workbookToXlsx(workbook, evaluator);
    const [sheetId] = workbook.sheetOrder;
    expect(evaluator.results.has(sheetId + "!B1500")).toBe(false);
    const chart = part(await unzip(stream), "xl/charts/chart3.xml");
    expect(evaluator.results.has(sheetId + "!B1500")).toBe(true);
    expect(chart).toContain('<c:pt idx="1499"><c:v>2998</c:v></c:pt>');
  });

  it("writes a filter that selects nothing as a rule matching no row", async () => {
    const gadget = newGadget();
    await gadget.setRange({ values: [["Name"], ["a"], ["b"]] });
    const document = await gadget.getStructure();
    const [id] = document.sheetOrder;
    const filter = { row: 0, endRow: 2, columns: [0], criteria: { 0: ["x:__none__"] }, rowOrder: [], sort: null };
    await gadget.applyOperation({ structure: { sheetOrder: document.sheetOrder, sheets: { [id]: { ...document.sheets[id], filter } } } });
    const xml = part(await xlsx(gadget), "xl/worksheets/sheet1.xml");
    expect(xml).toContain('<row r="2" hidden="1">');
    expect(xml).toContain('<row r="3" hidden="1">');
    expect(xml).toContain('<autoFilter ref="A1:A3"><filterColumn colId="0"><customFilters and="1"><customFilter operator="equal" val=""/><customFilter operator="notEqual" val=""/></customFilters></filterColumn></autoFilter>');
  });

  it("rebuilds every pivot from its source before exporting, pivots that read pivots too", async () => {
    const gadget = newGadget();
    const document = await gadget.getStructure();
    const [source] = document.sheetOrder;
    await gadget.setRange({ values: [["Region", "Sales"], ["North", 10]] });
    const pivot = (sourceSheetId: string, valueField: string) => ({ sourceSheetId, sourceRange: "A1:B2", rowField: "Region", columnField: "", valueField, aggregate: "sum" as const, showRowTotals: true, showColumnTotals: true, filterField: "", filterValues: [] });
    const sheet = (id: string, name: string, settings: SheetMeta["pivot"]) => ({ ...document.sheets[source], id, name, pivot: settings, created: undefined });
    // As grids saved them while the source read 10: the second pivot reads a sheet that reads the first.
    const stale = (value: string) => ({ A1: { value: "Region", fmt: null, version: 1 }, B2: { value, fmt: null, version: 1 } });
    await gadget.applyOperation({
      structure: { sheetOrder: [source, "s_pivot2", "s_calc", "s_pivot1"], sheets: { [source]: document.sheets[source], s_pivot2: sheet("s_pivot2", "Pivot 2", pivot("s_calc", "Total")), s_calc: sheet("s_calc", "Calc", null), s_pivot1: sheet("s_pivot1", "Pivot 1", pivot(source, "Sales")) } },
    });
    // As an editor from before line ids saved them, by position.
    await gadget.applyOperation({ sheetReplacements: [{ sheetId: "s_pivot1", cells: stale("10") }, { sheetId: "s_pivot2", cells: stale("20") }] as never });
    await gadget.setRange({ sheet: "Calc", values: [["Region", "Total"], ["North", "='Pivot 1'!B2*2"]] });
    await gadget.setCell({ ref: "B2", value: 20 });
    expect(await csvText(gadget, "s_pivot1")).toBe("﻿Region,Sales,Grand Total\r\nNorth,20,20\r\nGrand Total,20,20\r\n");
    expect(await csvText(gadget, "s_pivot2")).toBe("﻿Region,Total,Grand Total\r\nNorth,40,40\r\nGrand Total,40,40\r\n");
    const parts = await xlsx(gadget);
    expect(cellXml(part(parts, "xl/worksheets/sheet2.xml"), "B2")).toContain("<v>40</v>");
    expect(part(parts, "xl/worksheets/sheet4.xml")).toContain('<row r="1" ht="22.5" customHeight="1">');
  });

  it("keeps a pivot as the grid built it when the evaluation budget runs out while rebuilding it", async () => {
    const gadget = newGadget();
    const document = await gadget.getStructure();
    const [source] = document.sheetOrder;
    await gadget.setRange({ values: [["Region", "Sales"], ["North", "=5*4"]] });
    const settings = { sourceSheetId: source, sourceRange: "A1:B2", rowField: "Region", columnField: "", valueField: "Sales", aggregate: "sum" as const, showRowTotals: false, showColumnTotals: false, filterField: "", filterValues: [] };
    await gadget.applyOperation({ structure: { sheetOrder: [source, "s_pivot"], sheets: { [source]: document.sheets[source], s_pivot: { ...document.sheets[source], id: "s_pivot", name: "Pivot", pivot: settings, created: undefined } } } });
    expect((await gadget.applyOperation({ lineIds: true, sheetReplacements: [{ sheetId: "s_pivot", size: { rows: 2, cols: 2 }, cells: { "0:0": { value: "Region", fmt: null, version: 1 }, "0:1": { value: "Sales", fmt: null, version: 1 }, "1:0": { value: "North", fmt: null, version: 1 }, "1:1": { value: "10", fmt: null, version: 1 } } }] })).status).toBe("applied");
    // The source's formula is past the budget: unknown, rather than worked out.
    const value = ExportEvaluator.prototype.value;
    const spy = vi.spyOn(ExportEvaluator.prototype, "value").mockImplementation(function (this: ExportEvaluator, sheetId, row, column) {
      if (sheetId === source && row === 1 && column === 1) { this.spent = true; return EXPORT_UNKNOWN; }
      return value.call(this, sheetId, row, column);
    });
    try { expect(await csvText(gadget, "s_pivot")).toBe("\uFEFFRegion,Sales\r\nNorth,10\r\n"); } finally { spy.mockRestore(); }
  });

  it("forgets a subscriber whose first read failed", async () => {
    const gadget = newGadget();
    let disposed = 0;
    gadget.openDocument = () => Promise.reject(new Error("storage unavailable"));
    const subscriber = { operation: () => {}, presence: () => {}, dup() { return this; }, onRpcBroken: () => {}, [Symbol.dispose]: () => { disposed++; } };
    await expect(gadget.subscribe(subscriber, { clientId: "c", lines: true })).rejects.toThrow("storage unavailable");
    expect(gadget.subscribers.size).toBe(0);
    expect(disposed).toBe(1);
  });
});

// A sheet's first four live row ids.
const rowIds = async (gadget: Gadget, sheetId: string) => (await gadget.openDocument()).orders![sheetId].rows.flatMap(([start, count, gone]) => gone ? [] : Array.from({ length: count }, (_, i) => start + i)).slice(0, 4);

describe("an operation sent again", () => {
  // A save whose reply was lost goes again as it was, under its id (Operation.id): the server
  // answers it from where things are now, applying nothing twice.

  it("doesn't move rows again over someone's later move", async () => {
    const gadget = newGadget();
    const { sheetOrder: [sheetId] } = await gadget.getStructure();
    const mine: Operation = { id: "op-a", senderId: "a", lineIds: true, lineOps: [{ kind: "move", sheetId, axis: "rows", ids: [2], before: 0 }] };
    await gadget.applyOperation(mine);
    await gadget.applyOperation({ id: "op-b", senderId: "b", lineIds: true, lineOps: [{ kind: "move", sheetId, axis: "rows", ids: [2], before: null }] });
    const order = await rowIds(gadget, sheetId);
    expect(order).toEqual([0, 1, 3, 4]);
    const again = await gadget.applyOperation(structuredClone(mine));
    const { revision } = await gadget.getStructure();
    expect(again).toMatchObject({ status: "applied", revision, orders: { [sheetId]: expect.anything() } });
    expect(await rowIds(gadget, sheetId)).toEqual(order);
    expect((await gadget.getStructure()).revision).toBe(revision);
  });

  it("doesn't replace a sheet again over someone's later edit", async () => {
    const gadget = newGadget();
    const { sheetOrder, sheets } = await gadget.getStructure();
    const copy = { ...sheets[sheetOrder[0]], id: "s_copy", name: "Copy", rows: 5, cols: 3 };
    const mine: Operation = {
      id: "op-a", senderId: "a", lineIds: true,
      structure: { sheetOrder: [...sheetOrder, copy.id], sheets: { ...sheets, [copy.id]: copy }, revision: 1 },
      sheetReplacements: [{ sheetId: copy.id, size: { rows: 5, cols: 3 }, cells: { "0:0": { value: "copied", fmt: null, version: 1 } } }],
    };
    await gadget.applyOperation(mine);
    await gadget.applyOperation({ id: "op-b", senderId: "b", lineIds: true, cellOps: [{ sheetId: copy.id, ref: "1:0", value: "theirs", fmt: null, baseVersion: 0 }] });
    const { revision } = await gadget.getStructure();
    expect(await gadget.applyOperation(structuredClone(mine))).toMatchObject({ status: "applied", revision });
    expect(await values(gadget, "A1:A2", "Copy")).toEqual([["copied"], ["theirs"]]);
  });

  it("answers an edit with the cell as it is now, rather than rebase it over a later one", async () => {
    const gadget = newGadget();
    const { sheetOrder: [sheetId] } = await gadget.getStructure();
    const mine: Operation = { id: "op-a", senderId: "a", lineIds: true, cellOps: [{ sheetId, ref: "0:0", value: "mine", fmt: null, baseVersion: 0 }, { sheetId, ref: "0:1", value: "lost", fmt: null, baseVersion: 3 }] };
    // B's cell B1 is newer than A's edit of it, which conflicts.
    await gadget.setCells({ cells: { B1: "x" } });
    expect(await gadget.applyOperation(mine)).toMatchObject({ status: "conflict", conflicts: [{ ref: "0:1" }] });
    await gadget.applyOperation({ id: "op-b", senderId: "b", lineIds: true, cellOps: [{ sheetId, ref: "0:0", value: "theirs", fmt: null, baseVersion: 1 }] });
    const again = await gadget.applyOperation(structuredClone(mine));
    expect(again).toMatchObject({ status: "conflict", upserts: [{ ref: "0:0", cell: { value: "theirs", version: 2 } }], conflicts: [{ ref: "0:1", cell: { value: "x" } }] });
    expect(await values(gadget, "A1:B1")).toEqual([["theirs", "x"]]);
  });
});

describe("a structure snapshot from before a change", () => {
  it("doesn't bring back a sheet someone deleted since", async () => {
    const gadget = newGadget();
    const { sheetOrder, sheets } = await gadget.getStructure();
    const second = { ...sheets[sheetOrder[0]], id: "s_two", name: "Two" };
    const both = { sheetOrder: [...sheetOrder, second.id], sheets: { ...sheets, [second.id]: second } };
    await gadget.applyOperation({ lineIds: true, structure: { ...both, revision: 1 } });
    await gadget.deleteSheet({ sheet: "Two" });
    await gadget.applyOperation({ senderId: "a", lineIds: true, structure: { ...both, revision: 2 }, lineOps: [{ kind: "insert", sheetId: second.id, axis: "rows", ids: [2 ** 32], before: 0 }] });
    expect((await gadget.getStructure()).sheetOrder).toEqual(sheetOrder);
  });

  it("starts a filter's sort over when someone else's line change came after it", async () => {
    const gadget = newGadget();
    const { sheetOrder: [sheetId], sheets } = await gadget.getStructure();
    const filter = { row: 0, endRow: 3, columns: [0], criteria: {}, rowOrder: [3, 1, 2], sort: { column: 0, direction: "asc" as const } };
    const withFilter = (revision: number) => ({ sheetOrder: [sheetId], sheets: { [sheetId]: { ...sheets[sheetId], filter } }, revision });
    await gadget.applyOperation({ lineIds: true, structure: withFilter(0) });
    const { revision } = await gadget.getStructure();
    expect((await gadget.getStructure()).sheets[sheetId].filter).toMatchObject({ rowOrder: [3, 1, 2], sort: { column: 0 } });
    // A peer inserts a row inside the table; a snapshot built before it still has the old order.
    await gadget.applyOperation({ senderId: "b", lineIds: true, lineOps: [{ kind: "insert", sheetId, axis: "rows", ids: [2 ** 32], before: 2 }] });
    await gadget.applyOperation({ senderId: "a", lineIds: true, structure: withFilter(revision) });
    expect((await gadget.getStructure()).sheets[sheetId].filter).toMatchObject({ sort: null });
    // One built after it is kept as sent.
    await gadget.applyOperation({ senderId: "a", lineIds: true, structure: withFilter(revision + 2) });
    expect((await gadget.getStructure()).sheets[sheetId].filter).toMatchObject({ sort: { column: 0 } });
  });
});

describe("sorts", () => {
  it("still refuse an edit made before them after the gadget restarts", async () => {
    const storage = new MemoryStorage();
    const gadget = new Gadget({ storage } as never, {});
    const { sheetOrder: [sheetId] } = await gadget.getStructure();
    await gadget.setCells({ cells: { A1: "first", A2: "second" } });
    const { revision: basis } = await gadget.getStructure();
    // Another tab sorts the two rows.
    await gadget.applyOperation({ senderId: "b", lineIds: true, sorts: [{ sheetId, rows: [0, 1], cols: [0], cellOps: [{ sheetId, ref: "0:0", value: "second", fmt: null, baseVersion: 1 }, { sheetId, ref: "1:0", value: "first", fmt: null, baseVersion: 1 }] }] });
    const restarted = new Gadget({ storage } as never, {});
    // An edit of "second", made before the sort, reaches the restarted gadget at the cell's version now.
    expect(await restarted.applyOperation({ senderId: "a", lineIds: true, cellOps: [{ sheetId, ref: "1:0", value: "edited second", fmt: null, baseVersion: 2, basis }] })).toMatchObject({ status: "unchanged", sorted: [{ sheetId, ref: "1:0" }] });
    expect(await values(restarted, "A1:A2")).toEqual([["second"], ["first"]]);
  });

  it("refuse an edit made before a sort of its sheet that is no longer remembered", async () => {
    const gadget = newGadget();
    const { sheetOrder: [sheetId] } = await gadget.getStructure();
    await gadget.setCells({ cells: { A1: "a", A2: "b" } });
    const { revision: basis } = await gadget.getStructure();
    let version = 1;
    // Enough sorts of B1:B2 that the first is forgotten; none rewrote A2.
    for (let i = 0; i < 51; i++, version++) {
      await gadget.applyOperation({ senderId: "b", lineIds: true, sorts: [{ sheetId, rows: [0, 1], cols: [1], cellOps: [{ sheetId, ref: "0:1", value: String(i), fmt: null, baseVersion: version - 1 }] }] });
    }
    expect(await gadget.applyOperation({ senderId: "a", lineIds: true, cellOps: [{ sheetId, ref: "1:0", value: "late", fmt: null, baseVersion: 1, basis }] })).toMatchObject({ sorted: [{ sheetId, ref: "1:0" }] });
    // One made after the forgotten sorts is judged by the ones remembered.
    const { revision } = await gadget.getStructure();
    expect(await gadget.applyOperation({ senderId: "a", lineIds: true, cellOps: [{ sheetId, ref: "1:0", value: "fresh", fmt: null, baseVersion: 1, basis: revision }] })).toMatchObject({ status: "applied" });
  });
});

describe("long formulas", () => {
  it("keep every reference once inserted lines make their stored form much longer", async () => {
    const gadget = newGadget();
    await gadget.setCells({ cells: { A1: "7" } });
    await gadget.insertRows({ at: 1, count: 1 });
    const sum = "SUM(" + Array.from({ length: 200 }, () => "A1").join(",") + ")";
    const formula = "=" + Array.from({ length: 8 }, () => sum).join("+");
    await gadget.setCells({ cells: { A1: "7", B1: formula } });
    expect(await values(gadget, "B1")).toEqual([[formula]]);
  });
});
