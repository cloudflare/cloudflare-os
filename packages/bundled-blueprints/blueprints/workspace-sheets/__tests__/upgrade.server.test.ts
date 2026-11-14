// @vitest-environment node
// A gadget made from the previous Sheets blueprint takes this one as a code update: its storage
// stays as the old server wrote it, and an editor tab running the old client may still be open.
// `fixtures/old-workbook.json` is storage written by an early build (through its UI and its
// applyOperation API): a `meta` record with no `cellStorage`, and each sheet's cells in one
// `cells:<sheetId>` value. `fixtures/v3-workbook.json` was written by the build before line ids
// (cellStorage 3): cells in blocks by position, with formulas, a chart, a filter, frozen panes
// and a pivot sheet.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Gadget } from "../files/server.ts";
import type { Cell, CellMap, DocumentMeta, OpenedDocument, SubscriberCallbacks, SubscriberEvent } from "../files/lib/protocol.ts";

class MemoryStorage {
  map = new Map<string, unknown>();
  async get(key: string | string[]): Promise<unknown> {
    if (!Array.isArray(key)) return structuredClone(this.map.get(key));
    return new Map(key.filter((k) => this.map.has(k)).map((k) => [k, structuredClone(this.map.get(k))]));
  }
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof key === "string" ? [[key, value] as const] : Object.entries(key);
    for (const [k, v] of entries) this.map.set(k, structuredClone(v));
  }
  async delete(key: string | string[]): Promise<number> {
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

type OldStorage = { meta: DocumentMeta } & Record<`cells:${string}`, CellMap>;
const fixture = (name: string) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8"));
const OLD: OldStorage = fixture("old-workbook.json");
const V3: { meta: DocumentMeta } & Record<string, unknown> = fixture("v3-workbook.json");
const [SUMMARY, SALES, NOTES] = OLD.meta.sheetOrder;

function storageWith(entries: Record<string, unknown>): MemoryStorage {
  const storage = new MemoryStorage();
  for (const [k, v] of Object.entries(entries)) storage.map.set(k, structuredClone(v));
  return storage;
}
// The runtime's state is far larger than what the gadget uses; `never` hands the stand-in over.
const gadgetOn = (storage: MemoryStorage) => new Gadget({ storage } as never, {});

// A subscriber as the RPC layer hands it to the server.
type Subscriber = SubscriberCallbacks & { dup(): Subscriber; onRpcBroken(handler: (error: unknown) => void): void };
function subscriber(events: SubscriberEvent[]): Subscriber {
  const stub: Subscriber = { operation: (event) => { events.push(event); }, presence: () => {}, dup: () => stub, onRpcBroken: () => {} };
  return stub;
}

// A sheet of `rows` rows with ~230 characters a row: 9,000 rows are more than one 2 MB page.
function bigSheet(rows: number): CellMap {
  const cells: CellMap = {};
  for (let r = 1; r <= rows; r++) {
    cells["A" + r] = { value: String(r), fmt: null, version: 1 };
    cells["B" + r] = { value: "x".repeat(220) + r, fmt: null, version: 1 };
  }
  return cells;
}
async function withBigSheet(rows: number): Promise<{ gadget: Gadget; sheetId: string }> {
  const gadget = gadgetOn(new MemoryStorage());
  const meta = await gadget.getStructure();
  const sheetId = meta.sheetOrder[0];
  // As an editor from before line ids saves a big paste: the grid grown, the cells by position.
  await gadget.applyOperation({ senderId: "seed", structure: { sheetOrder: [sheetId], sheets: { [sheetId]: { ...meta.sheets[sheetId], rows: rows + 10 } } }, sheetReplacements: [{ sheetId, cells: bigSheet(rows) } as never] });
  return { gadget, sheetId };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a workbook from the previous Sheets blueprint", () => {
  // The old server accepted any ref; a cell past the grid can't be shown, staged or exported.
  it("drops cells past a sheet's edge", async () => {
    const storage = storageWith({ ...OLD, [`cells:${NOTES}`]: { ...OLD[`cells:${NOTES}`], AAA1: { value: "wide", fmt: null, version: 1 }, A60000: { value: "deep", fmt: null, version: 1 } } });
    const document = await gadgetOn(storage).getDocument();
    expect(document.cells[NOTES]).toEqual(OLD[`cells:${NOTES}`]);
  });
  it("keeps every sheet, size and cell, converting `cells:<id>` to blocks by line id once", async () => {
    const storage = storageWith(OLD);
    const document = await gadgetOn(storage).getDocument();
    expect(document.title).toBe("Quarterly plan");
    expect(document.sheetOrder).toEqual(OLD.meta.sheetOrder);
    for (const id of OLD.meta.sheetOrder) {
      expect(document.sheets[id]).toMatchObject(OLD.meta.sheets[id]);
      expect(document.cells[id]).toEqual(OLD[`cells:${id}`]);
    }
    expect(document.sheets[SALES]).toMatchObject({ name: "Sales Data", frozenRows: 1, colWidths: { 0: 140 } });
    // Every format key the old toolbar wrote survives as written.
    expect(document.cells[SUMMARY].A1.fmt).toEqual({ b: true, fs: 14, c: "#1d1d20", bg: "#dbe6fa" });
    expect(document.cells[SUMMARY].B11.fmt).toEqual({ wrap: true, a: "l" });
    expect(document.cells[NOTES].B3).toEqual({ value: "", fmt: { bg: "#fbdedb" }, version: 1 });

    const keys = [...storage.map.keys()].toSorted();
    const block = (id: string) => "c:" + id + ":" + "0".repeat(15);
    expect(keys).toEqual([block(NOTES), block(SALES), block(SUMMARY), "meta"].toSorted());
    expect((storage.map.get("meta") as DocumentMeta).cellStorage).toBe(4);
    expect((storage.map.get("meta") as DocumentMeta).revision).toBe(OLD.meta.revision);

    // Loading again (a restart) reads the blocks and writes nothing.
    const before = structuredClone(Object.fromEntries(storage.map));
    expect((await gadgetOn(storage).getDocument()).cells).toEqual(document.cells);
    expect(Object.fromEntries(storage.map)).toEqual(before);
  });

  it("reads its values, formulas and formats through the cell API, and edits them", async () => {
    const gadget = gadgetOn(storageWith(OLD));
    const { sheets } = await gadget.listSheets();
    expect(sheets.map((s) => [s.name, s.filter, s.charts])).toEqual([["Summary", null, []], ["Sales Data", null, []], ["Owner's Notes", null, []]]);
    const read = await gadget.readRange({ sheet: "Summary", range: "B12:B14", formats: true });
    expect(read.values).toEqual([["='Sales Data'!B7*2"], ["='Owner''s Notes'!A1"], ["'=not a formula"]]);
    await gadget.setCells({ sheet: "Sales Data", cells: { B2: 1001 } });
    const cell = (await gadget.getDocument()).cells[SALES].B2;
    expect(cell).toEqual({ value: "1001", fmt: { nf: "currency", d: 2 }, version: 2 });
  });
});

describe("a workbook stored in blocks by position (cellStorage 3)", () => {
  const [DATA, Q1, PIVOT] = V3.meta.sheetOrder;
  it("keeps its cells, formulas and settings, and replaces the old blocks", async () => {
    const storage = storageWith(V3), gadget = gadgetOn(storage);
    const before = { ...V3.meta.sheets };
    const document = await gadget.getDocument();
    expect(document.title).toBe("Regional sales");
    for (const id of V3.meta.sheetOrder) {
      const { layout: _, ...sheet } = before[id] as typeof before[string] & { layout?: number };
      expect(document.sheets[id]).toEqual(sheet);
    }
    expect(document.cells[DATA]).toMatchObject({ A1: { value: "Region" }, D2: { value: "=B2/SUM($B$2:$B$5)" }, A40: { value: "far down" }, B40: { value: "=SUM(B2:B5)" } });
    expect(document.cells[Q1]).toMatchObject({ B1: { value: "=SUM(Data!B2:B5)" }, B2: { value: "=MAX(Data!B2:B5)" }, B3: { value: '="Data!B2"' } });
    expect(document.cells[PIVOT]).toMatchObject({ A2: { value: "North" }, B2: { value: "10" } });
    expect([...storage.map.keys()].some((key) => key.startsWith("b:"))).toBe(false);
    expect((storage.map.get("meta") as DocumentMeta).cellStorage).toBe(4);
  });

  it("then keeps formulas, the chart, filter, pivot and sizes with their lines when a row is inserted", async () => {
    const gadget = gadgetOn(storageWith(V3));
    await gadget.insertRows({ sheet: "Data", at: 1 });
    const { sheets } = await gadget.getStructure();
    expect(sheets[DATA]).toMatchObject({ rows: (V3.meta.sheets[DATA] as { rows: number }).rows + 1, rowHeights: { 1: 36 }, colWidths: { 0: 160, 2: 60 }, filter: { row: 1, endRow: 5, columns: [0, 1, 2] }, charts: [{ range: "A2:B6" }] });
    expect(sheets[PIVOT].pivot).toMatchObject({ sourceSheetId: DATA, sourceRange: "A2:C6" });
    expect((await gadget.readRange({ sheet: "Q1 Summary", range: "B1:B2" })).values).toEqual([["=SUM(Data!B3:B6)"], ["=MAX(Data!B3:B6)"]]);
    expect((await gadget.readRange({ sheet: "Data", range: "D3" })).values).toEqual([["=B3/SUM($B$3:$B$6)"]]);
  });
});

describe("an editor tab still running the previous client", () => {
  it("is subscribed with the whole workbook, which it can't load in pages", async () => {
    const { gadget, sheetId } = await withBigSheet(9000);
    const paged = await gadget.subscribe(subscriber([]), { clientId: "new", lines: true });
    expect(paged.cursors[sheetId]).toBeDefined();
    const old: OpenedDocument = await gadget.subscribe(subscriber([]), { clientId: "old" });
    expect(Object.keys(old.cells?.[sheetId] ?? {})).toHaveLength(18000);
    expect(old.cursors).toEqual({});
  });

  it("is sent the whole workbook for a change it can't follow by position, in revision order", async () => {
    const { gadget, sheetId } = await withBigSheet(6000);
    const oldEvents: SubscriberEvent[] = [], newEvents: SubscriberEvent[] = [];
    await gadget.subscribe(subscriber(oldEvents), { clientId: "old" });
    await gadget.subscribe(subscriber(newEvents), { clientId: "new", lines: true });
    await gadget.insertRows({ at: 1, count: 1 });
    await gadget.setCells({ cells: { A1: "after", B1: "=A2" } });
    await settle();
    // The current client hears one line operation; nothing about the cells moves.
    expect(newEvents[0]).toMatchObject({ type: "operation", lineOps: [{ kind: "insert", axis: "rows", sheetId }] });
    expect(newEvents[0].type === "operation" && newEvents[0].upserts).toEqual([]);
    expect(oldEvents.map((e) => e.type)).toEqual(["snapshot", "operation"]);
    const snapshot = oldEvents[0].type === "snapshot" ? oldEvents[0].document.cells[sheetId] : null;
    expect(Object.keys(snapshot ?? {})).toHaveLength(12000);
    expect(snapshot?.A2).toEqual({ value: "1", fmt: null, version: 1 } satisfies Cell);
    // Cell edits reach it by position, formulas as A1 text.
    expect(oldEvents[1]).toMatchObject({ revision: 3, upserts: [{ ref: "A1", cell: { value: "after" } }, { ref: "B1", cell: { value: "=A2" } }] });
  });

  it("keeps a sheet's charts and filter when it saves the structure it knows", async () => {
    const gadget = gadgetOn(storageWith(OLD));
    await gadget.addChart({ sheet: "Sales Data", range: "A1:C6", type: "line" });
    const { sheetOrder, sheets } = await gadget.getStructure();
    // The old client sends sheets as it holds them; a sheet it added has no new fields.
    const { charts: _, filter: __, pivot: ___, ...oldShape } = sheets[SALES];
    await gadget.applyOperation({ senderId: "old", structure: { title: "Quarterly plan", sheetOrder: [...sheetOrder, "s_added"], sheets: { ...sheets, [SALES]: { ...oldShape, name: "Sales" }, s_added: { id: "s_added", name: "Added", rows: 100, cols: 26, colWidths: {}, rowHeights: {}, frozenRows: 0, frozenCols: 0 } as never } } });
    const after = await gadget.getStructure();
    expect(after.sheets[SALES]).toMatchObject({ name: "Sales", charts: [expect.objectContaining({ range: "A1:C6" })] });
    expect(after.sheets.s_added).toMatchObject({ name: "Added", charts: [], filter: null, pivot: null });
  });
});
