// The Sheets client in a jsdom page, against a scripted `gadget` stub: how it keeps local and
// remote edits apart while it syncs. The module runs on import (it builds its page and connects),
// so each test imports a fresh copy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SheetOrder, type LineOp, type StoredOrder } from "../files/lib/lines.ts";
import type { Cell, CellMap, CellOp, CellsPage, GadgetStub, OpenedDocument, Operation, OperationEvent, OperationResult, SheetMeta, SheetSlice, SheetsPresenceEvent, SubscriberCallbacks, SubscriberEvent } from "../files/lib/protocol.ts";
import { render, renderRange, toStored, type RefContext } from "../files/lib/refs.ts";

/** A promise with its resolver, for replies the test releases. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Long enough for a debounced save (180ms) and a frame to draw.
const settle = () => sleep(260);

function sheet(id: string, rows = 100, cols = 26): SheetMeta {
  return { id, name: "Sheet1", rows, cols, colWidths: {}, rowHeights: {}, frozenRows: 0, frozenCols: 0, filter: null, charts: [], pivot: null };
}
const structure = (meta: SheetMeta) => ({ title: "Book", sheetOrder: [meta.id], sheets: { [meta.id]: meta } });
const cell = (value: string, version = 1): Cell => ({ value, fmt: null, version });

interface Harness {
  callbacks: SubscriberCallbacks;
  gadget: { [K in keyof GadgetStub]: ReturnType<typeof vi.fn> };
  /** Each operation as the client sent it, by key. */
  sent: Operation[];
}

// The client names cells by key ("rowId:colId", see lib/lines.ts); most of these tests name them
// by A1 reference. On a sheet whose lines haven't moved (identity order), both name the same cell:
// "B3" is "2:1". The stub translates between them, so a scripted reply or event may use either,
// and what the client sent reads in A1 where it can.
function keyFor(ref: string): string {
  const m = /^([A-Z]{1,3})([1-9]\d*)$/.exec(ref);
  if (!m) return ref;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
  return `${Number(m[2]) - 1}:${col - 1}`;
}
function refFor(key: string): string {
  const m = /^(\d+):(\d+)$/.exec(key);
  if (!m || Number(m[1]) >= 2 ** 32 || Number(m[2]) >= 2 ** 32) return key;
  let col = Number(m[2]) + 1, letters = "";
  while (col) { col--; letters = String.fromCharCode(65 + (col % 26)) + letters; col = Math.floor(col / 26); }
  return letters + (Number(m[1]) + 1);
}
const rekeyed = (cells: CellMap | null | undefined, to: (ref: string) => string) => cells && Object.fromEntries(Object.entries(cells).map(([ref, value]) => [to(ref), value]));
function packed(cells: CellMap) {
  const entries = Object.entries(cells);
  return { refs: entries.map(([ref]) => keyFor(ref)), values: entries.map(([, c]) => c.value), versions: entries.map(([, c]) => c.version), styles: entries.map(() => -1), fmts: [] };
}
type Loose = Record<string, unknown>;
// What the server sends, in keys.
function inKeys<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const out: Loose = { ...(value as Loose) };
  const refs = (list: unknown) => Array.isArray(list) ? list.map((item: Loose) => ({ ...item, ref: keyFor(String(item.ref)) })) : list;
  for (const field of ["upserts", "deletes", "conflicts", "gone", "sorted"]) if (field in out) out[field] = refs(out[field]);
  if (out.replacedCells) out.replacedCells = Object.fromEntries(Object.entries(out.replacedCells as Record<string, CellMap | null>).map(([id, cells]) => [id, rekeyed(cells, keyFor)]));
  // A document's cells come packed, as the server sends them.
  if (out.cells && "cursors" in out) {
    out.packed = Object.fromEntries(Object.entries(out.cells as Record<string, CellMap>).map(([id, cells]) => [id, packed(cells)]));
    delete out.cells;
  }
  if (out.packed && Array.isArray((out.packed as Loose).refs)) out.packed = { ...(out.packed as Loose), refs: ((out.packed as Loose).refs as string[]).map(keyFor) };
  return out as T;
}
// What the client sent, in A1 where it can be.
function inA1(operation: Operation): Operation {
  const ops = (list: CellOp[] | undefined) => list?.map((op) => ({ ...op, ref: refFor(op.ref) }));
  return {
    ...operation,
    ...(operation.cellOps ? { cellOps: ops(operation.cellOps) } : {}),
    ...(operation.sorts ? { sorts: operation.sorts.map((sort) => (sort.cellOps ? { ...sort, cellOps: ops(sort.cellOps)! } : sort)) } : {}),
    ...(operation.sheetReplacements ? { sheetReplacements: operation.sheetReplacements.map((r) => (r.cells ? { ...r, cells: rekeyed(r.cells, refFor)! } : r)) } : {}),
  };
}

async function loadClient(meta: SheetMeta, cells: CellMap = {}, doc: Partial<OpenedDocument> = {}): Promise<Harness> {
  let callbacks: SubscriberCallbacks | null = null;
  const sent: Operation[] = [];
  const serverLines = new Map<string, SheetOrder>();
  const mocks = {
    subscribe: vi.fn(async (callback: SubscriberCallbacks, _options?: unknown): Promise<OpenedDocument> => {
      callbacks = callback;
      return { revision: 1, lastModified: 0, ...structure(meta), cells: { [meta.id]: cells }, cursors: {}, ...doc };
    }),
    openDocument: vi.fn(),
    getCellsPage: vi.fn<(options: unknown) => Promise<CellsPage>>(),
    getSheetSlices: vi.fn<(options: unknown) => Promise<{ revision: number; slices: SheetSlice[] }>>(),
    stageCells: vi.fn(),
    // Applied, with each sheet's lines after any line operations (as the server replies).
    applyOperation: vi.fn(async ({ lineOps }: Operation): Promise<OperationResult> => {
      if (!lineOps?.length) return { status: "applied", revision: 2, conflicts: [] };
      const orders: Record<string, StoredOrder> = {};
      for (const op of lineOps) {
        const sheetMeta = doc.sheets?.[op.sheetId] ?? (op.sheetId === meta.id ? meta : undefined);
        let order = serverLines.get(op.sheetId);
        if (!order) serverLines.set(op.sheetId, order = SheetOrder.from(doc.orders?.[op.sheetId], sheetMeta?.rows ?? 100, sheetMeta?.cols ?? 26));
        order.axis(op.axis).apply(op);
        orders[op.sheetId] = order.toStored();
      }
      return { status: "applied", revision: 2, conflicts: [], lineOps, orders };
    }),
    updatePresence: vi.fn(async (_presence: unknown) => {}),
    leavePresence: vi.fn(async (_id: unknown) => {}),
  };
  // The client's subscriber, with events translated as they arrive.
  const subscriber = (real: SubscriberCallbacks & Disposable) => ({
    operation: (event: SubscriberEvent) => real.operation(inKeys(event)),
    presence: (event: SheetsPresenceEvent) => real.presence(event),
    [Symbol.dispose]: () => real[Symbol.dispose](),
  });
  const gadget: GadgetStub = {
    subscribe: async (callback, options) => inKeys(await mocks.subscribe(subscriber(callback as SubscriberCallbacks & Disposable), options)),
    openDocument: async () => inKeys(await mocks.openDocument()),
    getCellsPage: async (options) => inKeys(await mocks.getCellsPage(options)),
    getSheetSlices: async (options) => mocks.getSheetSlices(options),
    stageCells: async (part) => mocks.stageCells({ ...part, cells: rekeyed(part.cells, refFor) }),
    applyOperation: async (operation) => { sent.push(structuredClone(operation)); return inKeys(await mocks.applyOperation(inA1(operation))); },
    updatePresence: async (presence) => mocks.updatePresence(presence),
    leavePresence: async (id) => mocks.leavePresence(id),
  };
  Object.assign(globalThis, { gadget, RpcTarget: class {} });
  vi.resetModules();
  await import("../files/client.ts");
  await settle();
  return { callbacks: callbacks!, gadget: mocks, sent };
}

const shown = (ref: string) => document.querySelector(`td.cell[data-ref="${ref}"] .cv`)?.textContent ?? null;

// Types `text` into the active cell (A1 on a fresh sheet) and presses Enter.
function typeIntoActiveCell(text: string) {
  const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
  grid.dispatchEvent(new KeyboardEvent("keydown", { key: text[0], bubbles: true }));
  const editor = document.querySelector<HTMLTextAreaElement>(".cell-editor")!;
  editor.value = text;
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

function remoteEvent(meta: SheetMeta, revision: number, rest: Partial<OperationEvent>): OperationEvent {
  return { type: "operation", senderId: "someone-else", revision, structure: structure(meta), upserts: [], deletes: [], lastModified: 0, ...rest };
}

// The first id an inserted line can have (lib/lines.ts FIRST_NEW_ID).
const NEW = 2 ** 32;
type SheetLineOp = LineOp extends infer T ? (T extends LineOp ? Omit<T, "sheetId"> : never) : never;
/**
 * Someone else's line operations on a sheet, as the server broadcasts them: the ops, and the
 * sheet's order after them (applied to `order`, identity by default, which a test can keep
 * across events).
 */
function lineEvent(meta: SheetMeta, revision: number, ops: SheetLineOp[], rest: Partial<OperationEvent> = {}, order = SheetOrder.from(null, meta.rows, meta.cols)): OperationEvent {
  const lineOps = ops.map((op) => ({ ...op, sheetId: meta.id }) as LineOp);
  for (const op of lineOps) order.axis(op.axis).apply(op);
  return remoteEvent({ ...meta, rows: order.rows.size, cols: order.cols.size }, revision, { lineOps, orders: { [meta.id]: order.toStored() }, ...rest });
}
/** How formulas read in a workbook of these sheets (each in identity order unless given). */
function bookCtx(sheets: Record<string, { name: string; order?: SheetOrder }>, sheetId: string): RefContext {
  return {
    sheetId,
    order: (id) => (sheets[id] ? sheets[id].order ?? SheetOrder.from(null, 100, 26) : undefined),
    sheetIdByName: (name) => Object.keys(sheets).find((id) => sheets[id].name.toLowerCase() === name.toLowerCase()),
    sheetName: (id) => sheets[id]?.name,
  };
}

// Each test's client keeps running after it (a retry waiting out its back-off, a debounced
// save), and would send through the next test's stub; its timers are cleared when its test ends.
// (Only the client's: the test runner keeps its own.)
const realSetTimeout = globalThis.setTimeout;
const timers = new Set<ReturnType<typeof setTimeout>>();
beforeEach(() => {
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number, ...args: unknown[]) => {
    const id = realSetTimeout(() => { timers.delete(id); handler(...(args as [])); }, ms);
    if (new Error().stack?.includes("files/client.ts")) timers.add(id);
    return id;
  }) as typeof setTimeout);
});
afterEach(() => {
  for (const id of timers) clearTimeout(id);
  timers.clear();
});

beforeEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  Object.assign(window, {
    matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }),
  });
  // A live edit's effects and a new tab's scroll use APIs jsdom leaves out.
  Element.prototype.scrollIntoView ||= () => {};
  // Renaming finds its tab with CSS.escape, which jsdom lacks.
  (globalThis as { CSS?: { escape(value: string): string } }).CSS ||= { escape: (value) => value };
  // Text is measured with a canvas, which jsdom lacks; the client then estimates.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("sync", () => {
  it("keeps an unsaved edit on screen when someone else replaces its sheet", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta);
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementation(() => save.promise);
    typeIntoActiveCell("mine");
    // The replacement arrives before the edit is saved; its cells come inline.
    h.callbacks.operation(remoteEvent(meta, 2, { replacedSheets: ["s1"], replacedCells: { s1: { B1: cell("theirs") } } }));
    await settle();
    expect(shown("A1")).toBe("mine");
    expect(shown("B1")).toBe("theirs");
  });

  it("replays a remote edit held during a sheet reload even after its own save landed with a later revision", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta);
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementation(() => save.promise);
    const slices = deferred<{ revision: number; slices: [] }>();
    h.gadget.getSheetSlices.mockImplementation(() => slices.promise);
    typeIntoActiveCell("mine");
    await settle(); // the save is now out
    expect(h.gadget.applyOperation).toHaveBeenCalledTimes(1);
    // Someone replaces the sheet with too many cells to send: it reloads, holding live events.
    h.callbacks.operation(remoteEvent(meta, 2, { replacedSheets: ["s1"], replacedCells: { s1: null } }));
    // An edit by someone else waits for the reload.
    h.callbacks.operation(remoteEvent(meta, 3, { upserts: [{ sheetId: "s1", ref: "C1", cell: cell("theirs") }] }));
    // This tab's own save then lands after both.
    save.resolve({ status: "applied", revision: 4, conflicts: [], upserts: [{ sheetId: "s1", ref: "A1", cell: cell("mine") }], deletes: [] });
    await settle();
    slices.resolve({ revision: 2, slices: [] });
    await settle();
    expect(shown("C1")).toBe("theirs");
    // The pages were read before the save landed; the saved cell stays.
    expect(shown("A1")).toBe("mine");
  });

  // Rows and columns have ids (lib/lines.ts): a cell is saved by its key, so an edit stays on its
  // record however the lines move before it lands, and formulas follow the lines they read.
  it("keeps an unsaved edit on its record when someone else inserts a row above it", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("first"), A2: cell("second") });
    document.querySelector<HTMLElement>(".grid-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    typeIntoActiveCell("edited");
    // Before the edit is saved, a row is inserted above A1: "second" is now A3.
    h.callbacks.operation(lineEvent(meta, 2, [{ kind: "insert", axis: "rows", ids: [NEW], before: 0 }]));
    await settle();
    expect([shown("A1"), shown("A2"), shown("A3")]).toEqual(["", "first", "edited"]);
    expect(h.sent.at(-1)!.cellOps).toEqual([{ sheetId: "s1", ref: "1:0", value: "edited", fmt: null, baseVersion: 1, basis: 1 }]);
  });

  it("lands a save that was out during someone else's move on its record", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("first"), A2: cell("second") });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    document.querySelector<HTMLElement>(".grid-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    typeIntoActiveCell("edited");
    await settle(); // the save of row 1 is out
    // A peer moves row 2 above row 1 first; the save then lands on the record, now first.
    h.callbacks.operation(lineEvent(meta, 2, [{ kind: "move", axis: "rows", ids: [1], before: 0 }]));
    save.resolve({ status: "applied", revision: 3, conflicts: [], upserts: [{ sheetId: "s1", ref: "1:0", cell: cell("edited", 2) }], deletes: [] });
    await settle();
    expect([shown("A1"), shown("A2")]).toEqual(["edited", "first"]);
    expect(h.gadget.applyOperation).toHaveBeenCalledTimes(1);
  });

  it("doesn't resend an edit saved before a move carried it, and shows a later write over it", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta);
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    typeIntoActiveCell("mine");
    await settle(); // the save of A1 is out
    // An agent inserts a row above it (the saved edit moves to A2), then writes it.
    h.callbacks.operation({ ...lineEvent(meta, 3, [{ kind: "insert", axis: "rows", ids: [NEW], before: 0 }]), senderId: "agent" });
    h.callbacks.operation({ ...remoteEvent(meta, 4, { upserts: [{ sheetId: "s1", ref: "0:0", cell: cell("theirs", 3) }] }), structure: undefined, senderId: "agent" });
    save.resolve({ status: "applied", revision: 2, conflicts: [], upserts: [{ sheetId: "s1", ref: "0:0", cell: cell("mine", 2) }], deletes: [] });
    await settle();
    expect(shown("A2")).toBe("theirs");
    expect(h.sent.slice(1).flatMap((op) => op.cellOps ?? [])).toEqual([]);
  });

  it("rebases an edit refused as a conflict onto its record after someone else moved it", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("old") });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    typeIntoActiveCell("mine");
    await settle(); // the save of A1 is out
    // An agent wrote A1 first (the save conflicts), then inserted a row above it.
    h.callbacks.operation({ ...remoteEvent(meta, 2, { upserts: [{ sheetId: "s1", ref: "0:0", cell: cell("theirs", 2) }] }), structure: undefined, senderId: "agent" });
    h.callbacks.operation({ ...lineEvent(meta, 3, [{ kind: "insert", axis: "rows", ids: [NEW], before: 0 }]), senderId: "agent" });
    save.resolve({ status: "conflict", revision: 3, conflicts: [{ sheetId: "s1", ref: "0:0", cell: cell("theirs", 2) }] });
    await settle();
    expect(h.sent.slice(1).flatMap((op) => op.cellOps ?? [])).toContainEqual(expect.objectContaining({ ref: "0:0", value: "mine", baseVersion: 2 }));
    expect(shown("A2")).toBe("mine");
  });

  it("keeps an unsaved formula reading the same cells through someone else's moves", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { C1: cell("2"), C2: cell("5") });
    document.querySelector<HTMLElement>(".grid-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    typeIntoActiveCell("=C1*3");
    // A row is inserted above, then the two records swap places.
    const order = SheetOrder.from(null, 100, 26);
    h.callbacks.operation(lineEvent(meta, 2, [{ kind: "insert", axis: "rows", ids: [NEW], before: 0 }], {}, order));
    h.callbacks.operation(lineEvent(meta, 3, [{ kind: "move", axis: "rows", ids: [1], before: 0 }], {}, order));
    await settle();
    expect([shown("B2"), shown("B3")]).toEqual(["", "6"]);
    const [op] = h.sent.at(-1)!.cellOps!;
    expect(op.ref).toBe("0:1");
    expect(render(op.value!, bookCtx({ s1: { name: "Sheet1", order } }, "s1"))).toBe("=C3*3");
  });

  it("shows someone else's rename in an unsaved formula, and saves the sheet it reads by id", async () => {
    const data = { ...sheet("s1"), name: "Data" }, other = sheet("s2");
    const both = (name: string) => ({ title: "Book", sheetOrder: ["s2", "s1"], sheets: { s1: { ...data, name }, s2: other } });
    const h = await loadClient(other, {}, { ...both("Data"), cells: { s1: { A1: cell("7") }, s2: {} } });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    typeIntoActiveCell("=Data!A1*2");
    // The agent renames Data before the edit is saved.
    h.callbacks.operation({ ...remoteEvent(other, 2, {}), structure: both("Renamed"), senderId: "agent" });
    await settle();
    const [op] = h.sent[0].cellOps!;
    expect(op.value).toBe(toStored("=Data!A1*2", bookCtx({ s1: { name: "Data" }, s2: { name: "Sheet1" } }, "s2")));
    expect(render(op.value!, bookCtx({ s1: { name: "Renamed" }, s2: { name: "Sheet1" } }, "s2"))).toBe("=Renamed!A1*2");
    save.resolve({ status: "applied", revision: 3, conflicts: [], upserts: [{ sheetId: "s2", ref: "0:0", cell: cell(op.value!, 1) }], deletes: [] });
    await settle();
    expect(shown("A1")).toBe("14");
    const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    expect(document.querySelector<HTMLTextAreaElement>(".cell-editor")!.value).toBe("=Renamed!A1*2");
  });

  it("draws a formula saved before someone else's rename with the new name when the older reply arrives", async () => {
    const data = sheet("s1"), other = { ...sheet("s2"), name: "Other" };
    const book = (name: string) => ({ title: "Book", sheetOrder: ["s2", "s1"], sheets: { s1: { ...data, name }, s2: other } });
    const h = await loadClient(other, {}, { ...book("Sheet1"), cells: { s1: { A1: cell("7") }, s2: {} } });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    typeIntoActiveCell("=Sheet1!A1*2");
    await settle(); // the save is out, and commits at revision 2
    h.callbacks.operation({ ...remoteEvent(other, 3, {}), structure: book("Renamed"), senderId: "agent" });
    save.resolve({ status: "applied", revision: 2, conflicts: [], upserts: [{ sheetId: "s2", ref: "0:0", cell: cell(h.sent[0].cellOps![0].value!, 2) }], deletes: [] });
    await settle();
    expect(shown("A1")).toBe("14");
    expect(h.gadget.applyOperation).toHaveBeenCalledTimes(1);
  });

  it("keeps this tab's insert and a later one when the older reply arrives after the later event", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("first") });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    document.querySelector<HTMLElement>('td.cell[data-ref="A1"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    [...document.querySelectorAll<HTMLElement>(".mi")].find((row) => row.textContent?.includes("Insert row above"))!.click();
    await settle();
    const [mine] = h.sent[0].lineOps!;
    expect(mine).toMatchObject({ kind: "insert", sheetId: "s1", axis: "rows", before: 0 });
    // An agent's insert commits after it, and its event arrives before this tab's reply.
    const order = SheetOrder.from(null, 100, 26);
    order.rows.apply(mine);
    h.callbacks.operation({ ...lineEvent(meta, 3, [{ kind: "insert", axis: "rows", ids: [NEW + 5000], before: 0 }], {}, order), senderId: "agent" });
    const replied = SheetOrder.from(null, 100, 26);
    replied.rows.apply(mine);
    save.resolve({ status: "applied", revision: 2, conflicts: [], lineOps: [mine], orders: { s1: replied.toStored() } });
    await settle();
    expect([shown("A1"), shown("A2"), shown("A3")]).toEqual(["", "", "first"]);
    // The active cell is on this tab's new row.
    typeIntoActiveCell("edited");
    await settle();
    expect(h.sent.at(-1)!.cellOps).toEqual([expect.objectContaining({ ref: `${mine.ids[0]}:0`, value: "edited" })]);
  });

  it("keeps a pending formula on another sheet reading its cell when that sheet's rows move while the save is out", async () => {
    const data = { ...sheet("s1"), name: "Data" }, other = sheet("s2");
    const both = { title: "Book", sheetOrder: ["s2", "s1"], sheets: { s1: data, s2: other } };
    const h = await loadClient(other, {}, { ...both, cells: { s1: { A1: cell("7") }, s2: {} } });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    typeIntoActiveCell("=Data!A1*2");
    await settle(); // the save is out
    const value = h.sent[0].cellOps![0].value!;
    // A row inserted above Data!A1 commits first; the saved formula still reads that cell.
    h.callbacks.operation({ ...lineEvent(data, 2, [{ kind: "insert", axis: "rows", ids: [NEW], before: 0 }]), structure: { ...both, sheets: { s1: { ...data, rows: 101 }, s2: other } } });
    save.resolve({ status: "applied", revision: 3, conflicts: [], upserts: [{ sheetId: "s2", ref: "0:0", cell: cell(value, 1) }], deletes: [] });
    await settle();
    expect(h.gadget.applyOperation).toHaveBeenCalledTimes(1);
    expect(shown("A1")).toBe("14");
    const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    expect(document.querySelector<HTMLTextAreaElement>(".cell-editor")!.value).toBe("=Data!A2*2");
  });

  it("drops an unsaved edit on a row someone else deleted, and keeps a formula's references on their rows", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("first"), A2: cell("second"), A3: cell("third") });
    typeIntoActiveCell("gone");
    typeIntoActiveCell("=A3&\"!\""); // on A2
    const order = SheetOrder.from(null, 100, 26);
    h.callbacks.operation(lineEvent(meta, 2, [{ kind: "delete", axis: "rows", ids: [0] }], {}, order));
    await settle();
    const [op, ...rest] = h.sent.at(-1)!.cellOps!;
    expect(rest).toEqual([]);
    expect(op.ref).toBe("1:0");
    expect(render(op.value!, bookCtx({ s1: { name: "Sheet1", order } }, "s1"))).toBe('=A2&"!"');
    expect([shown("A1"), shown("A2")]).toEqual(["third!", "third"]);
    expect(document.querySelector(".toast")?.textContent).toContain("someone else just deleted");
  });

  it("follows its cell with an open editor when someone else inserts a row above, and commits there", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("first"), A2: cell("second") });
    const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    const editor = document.querySelector<HTMLTextAreaElement>(".cell-editor")!;
    editor.value = "edited";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    h.callbacks.operation(lineEvent(meta, 2, [{ kind: "insert", axis: "rows", ids: [NEW], before: 0 }]));
    await settle();
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(h.sent.flatMap((op) => op.cellOps ?? [])).toEqual([expect.objectContaining({ ref: "1:0", value: "edited" })]);
    expect([shown("A2"), shown("A3")]).toEqual(["first", "edited"]);
  });

  it("undoes an edit on its record after someone else moved it", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("first"), A2: cell("second") });
    document.querySelector<HTMLElement>(".grid-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    typeIntoActiveCell("edited");
    await settle(); // saved
    h.callbacks.operation(lineEvent(meta, 3, [{ kind: "insert", axis: "rows", ids: [NEW], before: 0 }]));
    await settle();
    document.querySelector<HTMLElement>('.tb[aria-label="Undo"]')!.click();
    await settle();
    expect(h.sent.at(-1)!.cellOps).toEqual([expect.objectContaining({ ref: "1:0", value: "second" })]);
    expect([shown("A2"), shown("A3")]).toEqual(["first", "second"]);
  });

  it("keeps a save acknowledged while a reconnect's older snapshot loads, and replays later edits over it", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("old") });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    typeIntoActiveCell("mine");
    await settle(); // the save is out
    // The subscription drops; the reconnect reads a snapshot from before the save landed.
    const snapshot = deferred<OpenedDocument>();
    h.gadget.subscribe.mockImplementationOnce(async (callback: SubscriberCallbacks) => { h.callbacks = callback; return snapshot.promise; });
    (h.callbacks as unknown as Disposable)[Symbol.dispose]();
    save.resolve({ status: "applied", revision: 2, conflicts: [], upserts: [{ sheetId: "s1", ref: "A1", cell: cell("mine", 2) }], deletes: [] });
    await settle();
    // Held while the snapshot loads: an older edit of A1 (ignored) and a newer one of B1.
    h.callbacks.operation(remoteEvent(meta, 2, { senderId: h.gadget.subscribe.mock.calls[0][1].clientId, upserts: [{ sheetId: "s1", ref: "A1", cell: cell("mine", 2) }] }));
    h.callbacks.operation(remoteEvent(meta, 3, { upserts: [{ sheetId: "s1", ref: "B1", cell: cell("theirs") }] }));
    snapshot.resolve({ revision: 1, lastModified: 0, ...structure(meta), cells: { s1: { A1: cell("old") } }, cursors: {} });
    await settle();
    expect(shown("A1")).toBe("mine");
    expect(shown("B1")).toBe("theirs");
  });

  describe("after a reconnect that missed line changes", () => {
    // What the server has after a row was inserted above row 1 while this tab was away.
    const inserted = () => { const order = SheetOrder.from(null, 100, 26); order.rows.apply({ kind: "insert", sheetId: "s1", axis: "rows", ids: [NEW], before: 0 }); return order; };
    const reconnect = (h: Harness, opened: () => OpenedDocument | Promise<OpenedDocument>) => {
      h.gadget.subscribe.mockImplementationOnce(async (callback: SubscriberCallbacks) => { h.callbacks = callback; return opened(); });
      (h.callbacks as unknown as Disposable)[Symbol.dispose]();
    };

    it("commits an open draft on its cell's record, where the row went", async () => {
      const meta = sheet("s1");
      const h = await loadClient(meta, { A1: cell("first"), A2: cell("second") });
      const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
      grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      grid.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
      const editor = document.querySelector<HTMLTextAreaElement>(".cell-editor")!;
      editor.value = "edited";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      reconnect(h, () => ({ revision: 3, lastModified: 0, ...structure({ ...meta, rows: 101 }), orders: { s1: inserted().toStored() }, cells: { s1: { "0:0": cell("first"), "1:0": cell("second") } }, cursors: {} }));
      await settle();
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await settle();
      expect(h.sent.flatMap((op) => op.cellOps ?? [])).toEqual([expect.objectContaining({ ref: "1:0", value: "edited", baseVersion: 1 })]);
      expect([shown("A2"), shown("A3")]).toEqual(["first", "edited"]);
    });

    it("shows a rename in an unsaved formula", async () => {
      const data = { ...sheet("s1"), name: "Data" }, other = sheet("s2");
      const book = (name: string) => ({ title: "Book", sheetOrder: ["s2", "s1"], sheets: { s1: { ...data, name }, s2: other } });
      const h = await loadClient(other, {}, { ...book("Data"), cells: { s1: { A1: cell("7") }, s2: {} } });
      const snapshot = deferred<OpenedDocument>();
      reconnect(h, () => snapshot.promise);
      typeIntoActiveCell("=Data!A1*2");
      snapshot.resolve({ revision: 3, lastModified: 0, ...book("Renamed"), cells: { s1: { A1: cell("7") }, s2: {} }, cursors: {} });
      await settle();
      const sent = h.sent.flatMap((op) => op.cellOps ?? []).map((op) => render(op.value!, bookCtx({ s1: { name: "Renamed" }, s2: { name: "Sheet1" } }, "s2")));
      expect(sent).toContain("=Renamed!A1*2");
      expect(shown("A1")).toBe("14");
    });

    it("keeps an unsaved formula reading the cell it read on a sheet whose rows moved", async () => {
      const data = { ...sheet("s1"), name: "Data" }, other = sheet("s2");
      const book = (rows: number) => ({ title: "Book", sheetOrder: ["s2", "s1"], sheets: { s1: { ...data, rows }, s2: other } });
      const h = await loadClient(other, {}, { ...book(100), cells: { s1: { A1: cell("7") }, s2: {} } });
      const snapshot = deferred<OpenedDocument>();
      reconnect(h, () => snapshot.promise);
      typeIntoActiveCell("=Data!A1*2");
      snapshot.resolve({ revision: 3, lastModified: 0, ...book(101), orders: { s1: inserted().toStored() }, cells: { s1: { "0:0": cell("7") }, s2: {} }, cursors: {} });
      await settle();
      const sent = h.sent.flatMap((op) => op.cellOps ?? []).map((op) => render(op.value!, bookCtx({ s1: { name: "Data", order: inserted() }, s2: { name: "Sheet1" } }, "s2")));
      expect(sent.at(-1)).toBe("=Data!A2*2");
      expect(shown("A1")).toBe("14");
    });

    it("keeps undo history, which still names the same records", async () => {
      const meta = sheet("s1");
      const h = await loadClient(meta, { A1: cell("first"), A2: cell("second") });
      document.querySelector<HTMLElement>(".grid-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      typeIntoActiveCell("edited");
      await settle(); // saved
      reconnect(h, () => ({ revision: 3, lastModified: 0, ...structure({ ...meta, rows: 101 }), orders: { s1: inserted().toStored() }, cells: { s1: { "0:0": cell("first"), "1:0": cell("edited", 2) } }, cursors: {} }));
      await settle();
      document.querySelector<HTMLElement>('.tb[aria-label="Undo"]')!.click();
      await settle();
      expect(h.sent.at(-1)!.cellOps).toEqual([expect.objectContaining({ ref: "1:0", value: "second", baseVersion: 2 })]);
      expect(shown("A3")).toBe("second");
    });

    it("keeps this tab's insert acknowledged while an older snapshot loaded", async () => {
      const meta = sheet("s1");
      const h = await loadClient(meta, { A1: cell("first"), A2: cell("second") });
      const save = deferred<OperationResult>();
      h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
      document.querySelector<HTMLElement>('td.cell[data-ref="A1"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      [...document.querySelectorAll<HTMLElement>(".mi")].find((row) => row.textContent?.includes("Insert row above"))!.click();
      await settle(); // the insert is out
      const [mine] = h.sent[0].lineOps!;
      const snapshot = deferred<OpenedDocument>();
      reconnect(h, () => snapshot.promise);
      const after = SheetOrder.from(null, 100, 26);
      after.rows.apply(mine);
      save.resolve({ status: "applied", revision: 2, conflicts: [], lineOps: [mine], orders: { s1: after.toStored() } });
      await settle();
      snapshot.resolve({ revision: 1, lastModified: 0, ...structure(meta), cells: { s1: { A1: cell("first"), A2: cell("second") } }, cursors: {} });
      await settle();
      expect([shown("A1"), shown("A2"), shown("A3")]).toEqual(["", "first", "second"]);
      expect(h.gadget.getSheetSlices).not.toHaveBeenCalled();
    });
  });

  it("keeps a rename acknowledged while a reconnect's older snapshot loads", async () => {
    const one = sheet("s1"), other = { ...sheet("s2"), name: "Other" };
    const book = (name: string) => ({ title: "Book", sheetOrder: ["s1", "s2"], sheets: { s1: { ...one, name }, s2: other } });
    const reads = toStored("=Sheet1!A1", bookCtx({ s1: { name: "Sheet1" }, s2: { name: "Other" } }, "s2"));
    const h = await loadClient(one, {}, { ...book("Sheet1"), cells: { s1: { A1: cell("7") }, s2: { A1: cell(reads) } } });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    document.querySelector(".tab[data-id='s1']")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = document.querySelector<HTMLInputElement>(".tab-rename")!;
    input.value = "Mine";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(); // the rename is out
    // The subscription drops; the reconnect reads a snapshot from before the rename landed.
    const snapshot = deferred<OpenedDocument>();
    h.gadget.subscribe.mockImplementationOnce(async (callback: SubscriberCallbacks) => { h.callbacks = callback; return snapshot.promise; });
    (h.callbacks as unknown as Disposable)[Symbol.dispose]();
    save.resolve({ status: "applied", revision: 2, conflicts: [], structure: book("Mine") });
    await settle();
    snapshot.resolve({ revision: 1, lastModified: 0, ...book("Sheet1"), cells: { s1: { A1: cell("7") }, s2: { A1: cell(reads) } }, cursors: {} });
    await settle();
    expect(document.querySelector(".tab[data-id='s1']")!.textContent).toContain("Mine");
    const later = h.gadget.applyOperation.mock.calls.slice(1).map(([op]) => (op as Operation).structure?.sheets?.s1?.name).filter(Boolean);
    expect(later).not.toContain("Sheet1");
  });

  it("keeps a rename that overtook this tab's own rename before its reply arrived", async () => {
    const one = sheet("s1"), other = { ...sheet("s2"), name: "Other" };
    const two = { title: "Book", sheetOrder: ["s1", "s2"], sheets: { s1: one, s2: other } };
    const reads = toStored("=Sheet1!A1", bookCtx({ s1: { name: "Sheet1" }, s2: { name: "Other" } }, "s2"));
    const h = await loadClient(one, {}, { ...two, cells: { s1: { A1: cell("7") }, s2: { A1: cell(reads) } } });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    document.querySelector(".tab[data-id='s1']")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = document.querySelector<HTMLInputElement>(".tab-rename")!;
    input.value = "Mine";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(); // the rename is out, and commits at revision 2
    // The agent renames it again at revision 3; that event arrives before this tab's reply.
    h.callbacks.operation({ type: "operation", senderId: "agent", revision: 3, lastModified: 0, upserts: [], deletes: [], structure: { ...two, sheets: { s1: { ...one, name: "Theirs" }, s2: other } } });
    save.resolve({ status: "applied", revision: 2, conflicts: [], structure: { ...two, sheets: { s1: { ...one, name: "Mine" }, s2: other } } });
    await settle();
    expect(document.querySelector(".tab[data-id='s1'] .tname")?.textContent).toBe("Theirs");
    // Nothing puts "Mine" back.
    for (const [operation] of h.gadget.applyOperation.mock.calls.slice(1)) expect((operation as Operation).structure?.sheets?.s1?.name).not.toBe("Mine");
    document.querySelector<HTMLElement>(".tab[data-id='s2']")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(shown("A1")).toBe("7");
    // The formula reading it shows the name it has.
    document.querySelector<HTMLElement>(".grid-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    expect(document.querySelector<HTMLTextAreaElement>(".cell-editor")!.value).toBe("=Theirs!A1");
  });

  it("moves the selection off a row a filter hides, so typing never edits a hidden record", async () => {
    const filter = { row: 0, endRow: 2, columns: [0], criteria: {}, rowOrder: [], sort: null };
    const meta = { ...sheet("s1"), filter };
    const h = await loadClient(meta, { A1: cell("Name"), A2: cell("a"), A3: cell("b") });
    const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    // A3's value is filtered out; the next row shown is A4, below the table.
    h.callbacks.operation(remoteEvent({ ...meta, filter: { ...filter, criteria: { 0: ["s:a"] } } }, 2, {}));
    await settle();
    typeIntoActiveCell("x");
    await settle();
    const sent = h.gadget.applyOperation.mock.calls.at(-1)![0] as Operation;
    expect(sent.cellOps?.map((op) => op.ref)).toEqual(["A4"]);
  });

  it("doesn't take text in quotes for a reference when arrows move from a caret inside it", async () => {
    const h = await loadClient(sheet("s1"), { A1: cell('="A1"') });
    document.querySelector<HTMLElement>(".grid-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    const editor = document.querySelector<HTMLTextAreaElement>(".cell-editor")!;
    editor.setSelectionRange(4, 4); // just after the 1, inside the quotes
    editor.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    for (const [operation] of h.gadget.applyOperation.mock.calls) for (const op of (operation as Operation).cellOps || []) expect(op.value).toBe('="A1"');
  });

  it("pastes a cut from where its record went when someone else moved it, leaving the other record alone", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("same"), B1: cell("first-id"), A2: cell("same"), B2: cell("second-id") });
    const go = (ref: string) => {
      const box = document.querySelector<HTMLInputElement>(".namebox")!;
      box.value = ref;
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    };
    const clipboard = new Map<string, string>();
    const clipboardEvent = (type: string) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      clipboardData: { setData: (kind: string, value: string) => { clipboard.set(kind, value); }, getData: (kind: string) => clipboard.get(kind) ?? "" },
    });
    const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
    go("A2");
    grid.dispatchEvent(clipboardEvent("cut"));
    // An agent inserts a row above: the cut record is now on row 3, and A2 holds the other one.
    h.callbacks.operation({ ...lineEvent(meta, 2, [{ kind: "insert", axis: "rows", ids: [NEW], before: 0 }]), senderId: "agent" });
    await settle();
    go("D1");
    grid.dispatchEvent(clipboardEvent("paste"));
    await settle();
    expect([shown("A2"), shown("B2"), shown("A3"), shown("B3"), shown("D1")]).toEqual(["same", "first-id", "", "second-id", "same"]);
    expect(h.sent.flatMap((op) => op.cellOps ?? []).map(({ ref, value }) => ({ ref, value }))).toEqual(expect.arrayContaining([{ ref: "1:0", value: null }, { ref: `${NEW}:3`, value: "same" }]));
    expect(h.sent.flatMap((op) => op.cellOps ?? []).some((op) => op.ref === "0:0")).toBe(false);
  });

  it("moves a chart's range with its cells when the whole range is cut and pasted", async () => {
    const chart = { id: "c1", type: "line" as const, range: "A1:B3", title: "", xAxisTitle: "", yAxisTitle: "", legend: true, firstRowHeaders: true, firstColLabels: true, smooth: false, x: 0, y: 0, width: 520, height: 320 };
    const h = await loadClient({ ...sheet("s1"), charts: [chart] }, { A1: cell("x"), B1: cell("y"), A2: cell("a"), B2: cell("1"), A3: cell("b"), B3: cell("2") });
    const go = (ref: string) => {
      const box = document.querySelector<HTMLInputElement>(".namebox")!;
      box.value = ref;
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    };
    const clipboard = new Map<string, string>();
    const clipboardEvent = (type: string) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      clipboardData: { setData: (kind: string, value: string) => { clipboard.set(kind, value); }, getData: (kind: string) => clipboard.get(kind) ?? "" },
    });
    const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
    go("A1:B3");
    grid.dispatchEvent(clipboardEvent("cut"));
    go("D1");
    grid.dispatchEvent(clipboardEvent("paste"));
    await settle();
    const sent = h.gadget.applyOperation.mock.calls.at(-1)![0] as Operation;
    expect(renderRange(sent.structure!.sheets!.s1!.charts![0].range, SheetOrder.from(null, 100, 26))).toBe("D1:E3");
    expect(sent.cellOps?.find((op) => op.ref === "E3")?.value).toBe("2");
  });

  it("stacks a bar chart's negative values leftwards from zero", async () => {
    const chart = { id: "c1", type: "stackedBar" as const, range: "A1:C2", title: "", xAxisTitle: "", yAxisTitle: "", legend: false, firstRowHeaders: true, firstColLabels: true, smooth: false, x: 300, y: 0, width: 520, height: 320 };
    await loadClient({ ...sheet("s1"), charts: [chart] }, { A1: cell("k"), B1: cell("up"), C1: cell("down"), A2: cell("r"), B2: cell("10"), C2: cell("-5") });
    const [up, down] = [...document.querySelectorAll<SVGRectElement>("svg[aria-label='Stacked bar chart'] rect")].map((rect) => ({ x: Number(rect.getAttribute("x")), width: Number(rect.getAttribute("width")) }));
    expect(down.width).toBeGreaterThan(0);
    expect(up.width / down.width).toBeCloseTo(2);
    expect(down.x + down.width).toBeCloseTo(up.x); // both start at zero
  });

  describe("pivots", () => {
    const pivotOf = (sourceSheetId: string) => ({ sourceSheetId, sourceRange: "A1:B2", rowField: "k", columnField: "", valueField: "v", aggregate: "sum" as const, showRowTotals: false, showColumnTotals: false, filterField: "", filterValues: [] });
    const named = (id: string, name: string, pivot: SheetMeta["pivot"] = null): SheetMeta => ({ ...sheet(id), name, pivot });
    const book = (...sheets: SheetMeta[]) => ({ title: "Book", sheetOrder: sheets.map((s) => s.id), sheets: Object.fromEntries(sheets.map((s) => [s.id, s])) });
    const pivotWrites = (h: Harness, id: string) => h.gadget.applyOperation.mock.calls.filter(([op]) => (op as Operation).sheetReplacements?.some((r) => r.sheetId === id)).length;
    const refreshed = () => sleep(900);

    it("rebuild for this tab's and the agent's edits, never another tab's, so volatile sources can't ping-pong", async () => {
      const data = named("s1", "Data"), pivot = named("s2", "Pivot", pivotOf("s1"));
      const h = await loadClient(data, {}, { ...book(data, pivot), cells: { s1: { A1: cell("k"), B1: cell("v"), A2: cell("a"), B2: cell("=RAND()") }, s2: {} } });
      await refreshed();
      const opened = pivotWrites(h, "s2");
      expect(opened).toBeGreaterThan(0);
      h.callbacks.operation({ ...remoteEvent(data, 5, { upserts: [{ sheetId: "s1", ref: "C9", cell: cell("x") }] }), structure: undefined });
      await refreshed();
      expect(pivotWrites(h, "s2")).toBe(opened);
      h.callbacks.operation({ ...remoteEvent(data, 6, { senderId: "agent", upserts: [{ sheetId: "s1", ref: "C9", cell: cell("y") }] }), structure: undefined });
      await refreshed();
      expect(pivotWrites(h, "s2")).toBe(opened + 1);
    });

    it("wait for a source still being read again before rebuilding", async () => {
      const data = named("s1", "Data"), pivot = named("s2", "Pivot", pivotOf("s1"));
      const h = await loadClient(data, {}, { ...book(data, pivot), cells: { s1: { A1: cell("k"), B1: cell("v"), A2: cell("a"), B2: cell("10") }, s2: {} } });
      await refreshed();
      const slices = deferred<{ revision: number; slices: { sheetId: string; after: string; from: string; to: string }[] }>();
      h.gadget.getSheetSlices.mockImplementation(() => slices.promise);
      h.gadget.getCellsPage.mockResolvedValue({ revision: 5, sheetId: "s1", next: null, packed: { refs: ["0:0", "0:1", "1:0", "1:1"], values: ["k", "v", "a", "20"], versions: [5, 5, 5, 5], styles: [-1, -1, -1, -1], fmts: [] } });
      const before = pivotWrites(h, "s2");
      // The agent replaces the source with too many cells to send, so it's read again.
      h.callbacks.operation({ ...remoteEvent(data, 5, { senderId: "agent", replacedSheets: ["s1"], replacedCells: { s1: null } }), structure: book(data, pivot) });
      await refreshed(); // longer than a refresh's pause, with the pages still out
      expect(pivotWrites(h, "s2")).toBe(before);
      slices.resolve({ revision: 5, slices: [{ sheetId: "s1", after: "", from: "", to: "" }] });
      await refreshed();
      const replaced = h.gadget.applyOperation.mock.calls.flatMap(([op]) => (op as Operation).sheetReplacements ?? []).filter((r) => r.sheetId === "s2");
      expect(replaced.length).toBe(before + 1);
      expect(JSON.stringify(replaced.at(-1))).toContain('"20"');
    });

    it("settle when one reads another later in the tabs", async () => {
      const data = named("s1", "Data"), first = named("s2", "First", pivotOf("s3")), middle = named("s3", "Middle"), second = named("s4", "Second", pivotOf("s1"));
      const h = await loadClient(data, {}, {
        ...book(data, first, middle, second),
        cells: { s1: { A1: cell("k"), B1: cell("v"), A2: cell("a"), B2: cell("10") }, s2: {}, s3: { A1: cell("k"), B1: cell("v"), A2: cell("a"), B2: cell("=Second!B2") }, s4: {} },
      });
      await refreshed();
      document.querySelector<HTMLElement>(".grid-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      document.querySelector<HTMLElement>(".grid-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      typeIntoActiveCell("20");
      await refreshed();
      const replacements = h.gadget.applyOperation.mock.calls.flatMap(([op]) => (op as Operation).sheetReplacements || []).filter((r) => r.sheetId === "s2");
      expect(replacements.at(-1)?.cells?.B2.value).toBe("20");
    });
  });

  it("keeps a remote edit that lands after this tab's save, even when the save's reply comes later", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("old") });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementation(() => save.promise);
    typeIntoActiveCell("mine");
    await settle(); // the save is out, and commits at revision 2
    h.callbacks.operation(remoteEvent(meta, 3, { upserts: [{ sheetId: "s1", ref: "A1", cell: cell("theirs", 3) }] }));
    save.resolve({ status: "applied", revision: 2, conflicts: [], upserts: [{ sheetId: "s1", ref: "A1", cell: cell("mine", 2) }], deletes: [] });
    await settle();
    expect(shown("A1")).toBe("theirs");
  });

  it("redraws a remote edit adopted from a late save reply, with what depends on it", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("old"), B1: cell('=A1&"!"') });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementation(() => save.promise);
    typeIntoActiveCell("mine");
    await settle();
    h.callbacks.operation(remoteEvent(meta, 3, { upserts: [{ sheetId: "s1", ref: "A1", cell: cell("theirs", 3) }] }));
    await settle(); // the grid draws the remote event (A1 still shows the pending edit)
    save.resolve({ status: "applied", revision: 2, conflicts: [], upserts: [{ sheetId: "s1", ref: "A1", cell: cell("mine", 2) }], deletes: [] });
    await settle();
    expect(shown("A1")).toBe("theirs");
    expect(shown("B1")).toBe("theirs!");
  });

  it("doesn't let an edit held during a sheet reload undo a later save of the same cell", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("old") });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementation(() => save.promise);
    const slices = deferred<{ revision: number; slices: [] }>();
    h.gadget.getSheetSlices.mockImplementation(() => slices.promise);
    typeIntoActiveCell("mine");
    await settle(); // the save is out
    h.callbacks.operation(remoteEvent(meta, 2, { replacedSheets: ["s1"], replacedCells: { s1: null } }));
    // Someone deletes A1 while the pages load; this tab's save of A1 then commits after it.
    h.callbacks.operation(remoteEvent(meta, 3, { deletes: [{ sheetId: "s1", ref: "A1" }] }));
    save.resolve({ status: "applied", revision: 4, conflicts: [], upserts: [{ sheetId: "s1", ref: "A1", cell: cell("mine", 4) }], deletes: [] });
    await settle();
    slices.resolve({ revision: 2, slices: [] });
    await settle();
    expect(shown("A1")).toBe("mine");
  });

  it("doesn't let a sheet reload started before a reconnect overwrite the reconnect's snapshot", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("old") });
    const slices = deferred<{ revision: number; slices: [] }>();
    h.gadget.getSheetSlices.mockImplementation(() => slices.promise);
    h.callbacks.operation(remoteEvent(meta, 2, { replacedSheets: ["s1"], replacedCells: { s1: null } }));
    // The connection drops and comes back with the workbook at revision 3.
    h.gadget.subscribe.mockImplementation(async (): Promise<OpenedDocument> => ({
      revision: 3, lastModified: 0, ...structure(meta), cells: { s1: { B1: cell("fresh") } }, cursors: {},
    }));
    (h.callbacks as unknown as Disposable)[Symbol.dispose]();
    await settle();
    expect(shown("B1")).toBe("fresh");
    // The reload's pages, read at revision 2, arrive last.
    slices.resolve({ revision: 2, slices: [] });
    await settle();
    expect(shown("B1")).toBe("fresh");
  });
});

describe("undo", () => {
  it("bases an edit typed right after an undo on the cell's current version", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta);
    // A server that accepts each edit at its base version and bumps it.
    let revision = 1;
    h.gadget.applyOperation.mockImplementation(async ({ cellOps = [] }: Operation): Promise<OperationResult> => ({
      status: "applied", revision: ++revision, conflicts: [], deletes: [],
      upserts: cellOps.map((op) => ({ sheetId: op.sheetId, ref: op.ref, cell: { value: op.value ?? "", fmt: op.fmt, version: op.baseVersion + 1 } })),
    }));
    const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
    const key = (init: KeyboardEventInit) => grid.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
    typeIntoActiveCell("a");
    await settle(); // A1 is at version 1
    key({ key: "ArrowUp" });
    typeIntoActiveCell("b");
    await settle(); // version 2
    key({ key: "ArrowUp" });
    key({ key: "z", ctrlKey: true, metaKey: true });
    typeIntoActiveCell("c"); // replaces the undo before it is saved
    await settle();
    const last = h.gadget.applyOperation.mock.calls.at(-1)![0] as Operation;
    expect(last.cellOps).toEqual([expect.objectContaining({ ref: "A1", value: "c", baseVersion: 2 })]);
  });

  it("tells assistive tech when Undo has nothing to undo", async () => {
    await loadClient(sheet("s1"));
    const undo = document.querySelector<HTMLElement>('.tb[aria-label="Undo"]')!;
    expect(undo.getAttribute("aria-disabled")).toBe("true");
    typeIntoActiveCell("a");
    expect(undo.getAttribute("aria-disabled")).toBe("false");
  });
});

describe("charts", () => {
  it("draws a line chart over more values than a function call takes arguments", async () => {
    // 3 columns x 50,000 rows: 150,000 points.
    const rows = 50000, meta = sheet("s1", rows, 3), cells: CellMap = {};
    for (let r = 1; r <= rows; r++) for (const c of "ABC") cells[c + r] = cell(String(r));
    meta.charts = [{ id: "c1", type: "line", range: `A1:C${rows}`, title: "Big", xAxisTitle: "", yAxisTitle: "", legend: false, firstRowHeaders: false, firstColLabels: false, smooth: false, x: 0, y: 0, width: 520, height: 320 }];
    await loadClient(meta, cells);
    expect(document.querySelector(".chart-card svg")).not.toBeNull();
  }, 60_000);
});

describe("copy", () => {
  it("copies a whole-sheet selection trimmed to the used rows and columns", async () => {
    const meta = sheet("s1");
    await loadClient(meta, { A1: cell("a"), B2: cell("b") });
    const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, metaKey: true, bubbles: true }));
    const written = new Map<string, string>();
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData: (type: string, data: string) => written.set(type, data) } });
    grid.dispatchEvent(copy);
    expect(written.get("text/plain")).toBe("a\t\n\tb");
  });
});

describe("paste", () => {
  it("pastes text with more lines than a function call takes arguments", async () => {
    const meta = sheet("s1");
    await loadClient(meta);
    const text = Array.from({ length: 130_000 }, (_, i) => String(i + 1)).join("\n");
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: (type: string) => type === "text/plain" ? text : "" } });
    document.querySelector(".grid-scroll")!.dispatchEvent(paste);
    await settle();
    expect(shown("A1")).toBe("1");
    expect(shown("A2")).toBe("2");
  }, 60_000);
});

describe("paste values only", () => {
  it("pastes what a copied formula showed, not the formula", async () => {
    await loadClient(sheet("s1"), { A1: cell("10"), A2: cell("30"), B1: cell("=A1*2") });
    const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const written = new Map<string, string>();
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData: (type: string, data: string) => written.set(type, data) } });
    grid.dispatchEvent(copy);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, metaKey: true, shiftKey: true, bubbles: true }));
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: (type: string) => written.get(type) ?? "" } });
    grid.dispatchEvent(paste);
    await settle();
    expect(shown("B2")).toBe("20");
  });

  it("keeps a very small result a number", async () => {
    await loadClient(sheet("s1"), { A1: cell("=1/10000000"), A3: cell("=ISNUMBER(A2)") });
    const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
    const written = new Map<string, string>();
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData: (type: string, data: string) => written.set(type, data) } });
    grid.dispatchEvent(copy);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, metaKey: true, shiftKey: true, bubbles: true }));
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: (type: string) => written.get(type) ?? "" } });
    grid.dispatchEvent(paste);
    await settle();
    expect(shown("A3")).toBe("TRUE");
  });

  it("keeps text that reads as a number once trimmed as text", async () => {
    await loadClient(sheet("s1"), { A1: cell('=" 00123"'), A3: cell("=ISTEXT(A2)") });
    const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
    const written = new Map<string, string>();
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData: (type: string, data: string) => written.set(type, data) } });
    grid.dispatchEvent(copy);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, metaKey: true, shiftKey: true, bubbles: true }));
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: (type: string) => written.get(type) ?? "" } });
    grid.dispatchEvent(paste);
    await settle();
    expect(shown("A3")).toBe("TRUE");
  });
});

describe("fill handle", () => {
  it("continues a series of very small numbers as numbers", async () => {
    await loadClient(sheet("s1"), { A1: cell("0.0000001"), A2: cell("0.0000002"), B1: cell("=ISNUMBER(A3)") });
    const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }));
    const handle = document.querySelector<HTMLElement>(".fill-handle")!;
    const target = document.querySelector<HTMLElement>('td.cell[data-ref="A3"]')!;
    Object.assign(document, { elementFromPoint: () => target });
    for (const type of ["pointerdown", "pointermove", "pointerup"]) handle.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    await settle();
    expect(shown("B1")).toBe("TRUE");
  });
});

describe("moving rows", () => {
  // A range keeps the lines between its two ends, as Excel's cut and insert does: moved past its
  // last row, its first row takes the range's start with it.
  it("follows a range's ends when its first row moves below its last", async () => {
    await loadClient(sheet("s1"), { A1: cell("10"), A2: cell("20"), A3: cell("30"), B5: cell("=SUM(A1:A3)") });
    const head = () => document.querySelector<HTMLElement>('th.rowhead[data-row="0"]')!;
    const mouse = (target: EventTarget, type: string, clientY: number) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY }));
    // Select row 1, then drag it by its header into the lower half of row 3.
    mouse(head(), "mousedown", 36); mouse(window, "mouseup", 36);
    await settle();
    mouse(head(), "mousedown", 36); mouse(window, "mousemove", 60); mouse(window, "mousemove", 90); mouse(window, "mouseup", 90);
    await settle();
    expect([shown("A1"), shown("A2"), shown("A3")]).toEqual(["20", "30", "10"]);
    expect(shown("B5")).toBe("40");
    document.querySelector<HTMLInputElement>(".namebox")!.value = "B5";
    document.querySelector<HTMLInputElement>(".namebox")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    press(gridEl(), { key: "F2" });
    expect(editorEl().value).toBe("=SUM(A2:A3)");
  });
});

const gridEl = () => document.querySelector<HTMLElement>(".grid-scroll")!;
const editorEl = () => document.querySelector<HTMLTextAreaElement>(".cell-editor")!;
function press(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}
// Opens the active cell's editor by typing, with `text` in it and the caret at its end.
function startTyping(text: string): HTMLTextAreaElement {
  press(gridEl(), { key: text[0] });
  const editor = editorEl();
  editor.value = text;
  editor.setSelectionRange(text.length, text.length);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  return editor;
}

describe("cell editor keys", () => {
  it("moves the caret with the arrows in a formula opened with F2", async () => {
    await loadClient(sheet("s1"), { A1: cell("=SUM(B1:B2)") });
    press(gridEl(), { key: "F2" });
    const editor = editorEl();
    expect(press(editor, { key: "ArrowLeft" }).defaultPrevented).toBe(false);
    expect(editor.value).toBe("=SUM(B1:B2)");
  });

  it("points at a cell with the arrows where a reference can go", async () => {
    await loadClient(sheet("s1"));
    const editor = startTyping("=1+");
    press(editor, { key: "ArrowDown" });
    expect(editor.value).toBe("=1+A2");
  });

  it("commits with Shift+Enter", async () => {
    await loadClient(sheet("s1"));
    press(gridEl(), { key: "ArrowDown" });
    const editor = startTyping("x");
    expect(press(editor, { key: "Enter", shiftKey: true }).defaultPrevented).toBe(true);
    await settle();
    expect(shown("A2")).toBe("x");
    expect(editor.value.includes("\n")).toBe(false);
  });

  it("doesn't add a closing parenthesis inside quoted text", async () => {
    await loadClient(sheet("s1"));
    const editor = startTyping('="Note ');
    expect(press(editor, { key: "(" }).defaultPrevented).toBe(false);
    // This page keeps listening on the document during later tests; leave nothing open for them.
    press(editor, { key: "Escape" });
  });

  it("saves the open cell on Ctrl/Cmd+S", async () => {
    const h = await loadClient(sheet("s1"));
    const editor = startTyping("hello");
    press(editor, { key: "s", code: "KeyS", ctrlKey: true, metaKey: true });
    await settle();
    expect(h.gadget.applyOperation).toHaveBeenCalledWith(expect.objectContaining({ cellOps: [expect.objectContaining({ ref: "A1", value: "hello" })] }));
  });
});

describe("clipboard text", () => {
  it("quotes a copied cell holding a line break, as Excel does", async () => {
    await loadClient(sheet("s1"), { A1: cell("line1\nline2"), B1: cell('say "hi"'), C1: cell('"quoted"') });
    press(gridEl(), { key: "ArrowRight", shiftKey: true });
    press(gridEl(), { key: "ArrowRight", shiftKey: true });
    const written = new Map<string, string>();
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData: (type: string, data: string) => written.set(type, data) } });
    gridEl().dispatchEvent(copy);
    expect(written.get("text/plain")).toBe('"line1\nline2"\tsay "hi"\t"""quoted"""');
  });

  it("pastes Excel's quoted fields into one cell each", async () => {
    await loadClient(sheet("s1"));
    const text = '"line1\r\nline2"\tx\r\n"""a"" b"\t"open\r\n';
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: (type: string) => type === "text/plain" ? text : "" } });
    gridEl().dispatchEvent(paste);
    await settle();
    expect([shown("A1"), shown("B1"), shown("A2"), shown("B2"), shown("A3")]).toEqual(["line1\nline2", "x", '"a" b', '"open', ""]);
  });
});

describe("reconnect", () => {
  it("subscribes again when the server drops the subscriber while a reconnect is loading", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("old") });
    const page = deferred<unknown>();
    h.gadget.subscribe.mockImplementation(async (): Promise<OpenedDocument> => ({
      revision: 3, lastModified: 0, ...structure(meta), cells: { s1: {} }, cursors: {},
      slices: h.gadget.subscribe.mock.calls.length === 2 ? [{ sheetId: "s1", after: "", from: "", to: "" }] : [],
    }));
    h.gadget.getCellsPage.mockImplementation(() => page.promise);
    (h.callbacks as unknown as Disposable)[Symbol.dispose]();
    await settle();
    // The reconnect's subscriber is dropped too, before its pages arrive.
    const second = h.gadget.subscribe.mock.calls[1][0] as Disposable;
    second[Symbol.dispose]();
    page.resolve({ revision: 3, sheetId: "s1", packed: { refs: [], values: [], versions: [], styles: [], fmts: [] }, next: null });
    await settle();
    expect(h.gadget.subscribe).toHaveBeenCalledTimes(3);
  });
});

describe("undo after someone else's structural edit", () => {
  it("forgets history for a sheet someone else replaced", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta);
    typeIntoActiveCell("X");
    await settle();
    // An agent inserts a row above: what was A1 is now A2.
    h.callbacks.operation(remoteEvent(meta, 3, { senderId: "agent", replacedSheets: ["s1"], replacedCells: { s1: { A2: cell("X", 2) } } }));
    await settle();
    const calls = h.gadget.applyOperation.mock.calls.length;
    press(gridEl(), { key: "z", ctrlKey: true, metaKey: true });
    await settle();
    expect(h.gadget.applyOperation).toHaveBeenCalledTimes(calls);
    expect(shown("A2")).toBe("X");
    expect(document.querySelector('.tb[aria-label="Undo"]')!.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("menus", () => {
  it("work from the keyboard", async () => {
    await loadClient(sheet("s1"));
    const owner = document.querySelector<HTMLElement>('.tb[aria-label="Number format"]')!;
    owner.focus();
    owner.click();
    press(owner, { key: "ArrowDown" });
    const row = document.activeElement as HTMLElement;
    expect(row.classList.contains("mi")).toBe(true);
    press(row, { key: "ArrowDown" });
    expect(document.activeElement).not.toBe(row);
    press(document.activeElement as HTMLElement, { key: "Enter" });
    expect(document.querySelector(".pop.fmt-menu:not(.closing)")).toBeNull();
  });
});

describe("filtered rows", () => {
  it("are stepped over by the keyboard, so typing never edits a hidden record", async () => {
    const meta: SheetMeta = { ...sheet("s1"), filter: { row: 0, endRow: 3, columns: [0], criteria: { 0: ["s:keep"] }, rowOrder: [1, 2, 3], sort: null } };
    const h = await loadClient(meta, { A1: cell("Name"), A2: cell("keep"), A3: cell("hide"), A4: cell("keep") });
    press(gridEl(), { key: "ArrowDown" });
    press(gridEl(), { key: "ArrowDown" });
    typeIntoActiveCell("edited");
    await settle();
    const refs = h.gadget.applyOperation.mock.calls.flatMap(([op]) => (op as Operation).cellOps ?? []).map((op) => op.ref);
    expect(refs).toContain("A4");
    expect(refs).not.toContain("A3");
  });
});

describe("filter sort", () => {
  it("moves a column filled in after the filter was made with its records", async () => {
    const meta: SheetMeta = { ...sheet("s1"), filter: { row: 0, endRow: 2, columns: [0, 2], criteria: {}, rowOrder: [1, 2], sort: null } };
    await loadClient(meta, { A1: cell("Name"), C1: cell("Amount"), A2: cell("Z"), A3: cell("A"), C2: cell("10"), C3: cell("20"), B2: cell("for Z"), B3: cell("for A") });
    press(gridEl(), { key: "ArrowDown", altKey: true });
    [...document.querySelectorAll<HTMLElement>(".mi")].find((row) => row.textContent?.includes("Sort A → Z"))!.click();
    await settle();
    expect([shown("A2"), shown("B2"), shown("C2")]).toEqual(["A", "for A", "20"]);
    expect([shown("A3"), shown("B3"), shown("C3")]).toEqual(["Z", "for Z", "10"]);
  });
});

describe("a save whose reply was lost", () => {
  it("goes again as it was, under its id, and an edit made meanwhile waits for the next save", async () => {
    const h = await loadClient(sheet("s1"));
    h.gadget.applyOperation.mockRejectedValueOnce(new Error("connection lost"));
    typeIntoActiveCell("first");
    await settle(); // the save fails, its outcome unknown
    typeIntoActiveCell("second");
    await sleep(600); // past the save loop's back-off and the next save
    const [failed, again, next] = h.sent;
    expect(failed.id).toBeTruthy();
    expect(again).toEqual(failed);
    expect(next.id).not.toBe(failed.id);
    expect(next.cellOps).toEqual([expect.objectContaining({ ref: "1:0", value: "second" })]);
  });
});

describe("duplicate a sheet", () => {
  it("saves the copy's formulas by line id, so they follow its lines", async () => {
    const h = await loadClient(sheet("s1"), { A1: cell("1"), A2: cell("2"), B1: cell("=SUM(A1:A2)") });
    document.querySelector<HTMLElement>(".tab[data-id='s1']")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    [...document.querySelectorAll<HTMLElement>(".mi")].find((row) => row.textContent?.includes("Duplicate"))!.click();
    await settle();
    const replacement = h.sent.flatMap((op) => op.sheetReplacements ?? []).find((r) => r.sheetId !== "s1")!;
    const formula = replacement.cells!["0:1"].value;
    expect(formula).not.toBe("=SUM(A1:A2)");
    expect(render(formula, bookCtx({ s1: { name: "Sheet1" }, [replacement.sheetId]: { name: "Sheet1 copy" } }, replacement.sheetId))).toBe("=SUM(A1:A2)");
  });
});

describe("sort", () => {
  // Sorts A1:B2 from the cell menu.
  const sortRange = () => {
    const box = document.querySelector<HTMLInputElement>(".namebox")!;
    box.value = "A1:B2";
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    document.querySelector<HTMLElement>('.tb[aria-label="More"]')!.click();
    [...document.querySelectorAll<HTMLElement>(".mi")].find((row) => row.textContent?.includes("Sort range A → Z"))!.click();
  };
  const unsorted = { A1: cell("b"), B1: cell("2"), A2: cell("a"), B2: cell("1") };

  it("rewrites the cells, not the lines, and saves them as one write naming the lines it sorted", async () => {
    const h = await loadClient(sheet("s1"), unsorted);
    sortRange();
    await settle();
    expect([shown("A1"), shown("B1"), shown("A2"), shown("B2")]).toEqual(["a", "1", "b", "2"]);
    const [op] = h.sent;
    expect(op.cellOps ?? []).toEqual([]);
    expect(op.lineOps ?? []).toEqual([]);
    expect(op.sorts).toEqual([{
      sheetId: "s1", rows: [0, 1], cols: [0, 1],
      cellOps: expect.arrayContaining([
        expect.objectContaining({ ref: "0:0", value: "a", baseVersion: 1 }), expect.objectContaining({ ref: "0:1", value: "1", baseVersion: 1 }),
        expect.objectContaining({ ref: "1:0", value: "b", baseVersion: 1 }), expect.objectContaining({ ref: "1:1", value: "2", baseVersion: 1 }),
      ]),
    }]);
  });

  it("is undone and its sheet read again when a cell it rewrote changed first", async () => {
    const h = await loadClient(sheet("s1"), unsorted);
    h.gadget.applyOperation.mockImplementationOnce(async (): Promise<OperationResult> => ({ status: "conflict", revision: 3, conflicts: [{ sheetId: "s1", ref: "0:0", cell: cell("c", 2) }], refusedSorts: ["s1"] }));
    h.gadget.getSheetSlices.mockResolvedValue({ revision: 3, slices: [{ sheetId: "s1", after: "", from: "", to: "" }] });
    h.gadget.getCellsPage.mockResolvedValue({ revision: 3, sheetId: "s1", next: null, packed: { refs: ["0:0", "0:1", "1:0", "1:1"], values: ["c", "2", "a", "1"], versions: [2, 1, 1, 1], styles: [-1, -1, -1, -1], fmts: [] } });
    sortRange();
    await settle(); await settle();
    expect([shown("A1"), shown("B1"), shown("A2"), shown("B2")]).toEqual(["c", "2", "a", "1"]);
    expect(document.querySelector(".toast")?.textContent).toContain("the sort was undone");
    expect(document.querySelector('.tb[aria-label="Undo"]')!.getAttribute("aria-disabled")).toBe("true");
    expect(h.sent.slice(1).flatMap((op) => [...(op.cellOps ?? []), ...(op.sorts ?? [])])).toEqual([]);
  });

  it("drops an edit made before someone else's sort rewrote its cell, rather than save it over another record", async () => {
    const h = await loadClient(sheet("s1"), unsorted);
    h.gadget.applyOperation.mockImplementationOnce(async (): Promise<OperationResult> => ({ status: "unchanged", revision: 3, conflicts: [], sorted: [{ sheetId: "s1", ref: "0:0" }] }));
    typeIntoActiveCell("mine");
    await settle(); await settle();
    expect(document.querySelector(".toast")?.textContent).toContain("Someone sorted those rows");
    expect(h.sent).toHaveLength(1);
  });

  it("drops an edit on a line someone else deleted before it landed", async () => {
    const h = await loadClient(sheet("s1"), unsorted);
    h.gadget.applyOperation.mockImplementationOnce(async (): Promise<OperationResult> => ({ status: "unchanged", revision: 3, conflicts: [], gone: [{ sheetId: "s1", ref: "0:0" }] }));
    typeIntoActiveCell("mine");
    await settle(); await settle();
    expect(document.querySelector(".toast")?.textContent).toContain("someone else deleted");
    expect(h.sent).toHaveLength(1);
  });
});

describe("pivot tables", () => {
  it("leave blank values out of an average", async () => {
    const source = sheet("s1"), pivot: SheetMeta = { ...sheet("p1"), name: "Pivot", pivot: {
      sourceSheetId: "s1", sourceRange: "A1:B3", rowField: "Region", columnField: "", valueField: "Amount", aggregate: "average",
      showRowTotals: true, showColumnTotals: true, filterField: "", filterValues: [],
    } };
    const book = { title: "Book", sheetOrder: ["s1", "p1"], sheets: { s1: source, p1: pivot } };
    const h = await loadClient(source);
    // Region North: one amount of 10, one blank.
    h.callbacks.operation({ type: "operation", senderId: "agent", revision: 2, structure: book, lastModified: 0, deletes: [], upserts: [
      { sheetId: "s1", ref: "A1", cell: cell("Region") }, { sheetId: "s1", ref: "B1", cell: cell("Amount") },
      { sheetId: "s1", ref: "A2", cell: cell("North") }, { sheetId: "s1", ref: "B2", cell: cell("10") }, { sheetId: "s1", ref: "A3", cell: cell("North") },
    ] });
    await settle(); await settle();
    const replaced = h.gadget.applyOperation.mock.calls.flatMap(([op]) => (op as Operation).sheetReplacements ?? []).find((r) => r.sheetId === "p1");
    const values = Object.values((replaced as { cells: CellMap }).cells).map((c) => c.value);
    expect(values).toContain("10");
    expect(values).not.toContain("5");
  });

  it("are rebuilt from their source before a PDF prints them", async () => {
    const source = sheet("s1"), pivot: SheetMeta = { ...sheet("p1"), name: "Pivot", pivot: {
      sourceSheetId: "s1", sourceRange: "A1:B2", rowField: "Region", columnField: "", valueField: "Amount", aggregate: "sum",
      showRowTotals: false, showColumnTotals: false, filterField: "", filterValues: [],
    } };
    // The pivot was last built when North's amount was 10; an agent has since made it 20.
    const cells = { s1: { A1: cell("Region"), B1: cell("Amount"), A2: cell("North"), B2: cell("20") }, p1: { A1: cell("Region"), B1: cell("Sum of Amount"), A2: cell("North"), B2: cell("10") } };
    (globalThis as { gadgetExportFormatId?: string }).gadgetExportFormatId = "pdf";
    try {
      const h = await loadClient(source, {}, { title: "Book", sheetOrder: ["s1", "p1"], sheets: { s1: source, p1: pivot }, cells });
      const printed = [...document.querySelectorAll("#printWorkbook .print-sheet")].map((section) => section.textContent);
      expect(printed[1]).toContain("20");
      expect(printed[1]).not.toContain("10");
      expect(h.gadget.applyOperation).not.toHaveBeenCalled();
    } finally { delete (globalThis as { gadgetExportFormatId?: string }).gadgetExportFormatId; }
  });

  it("store a very small total as a number", async () => {
    const source = sheet("s1"), pivot: SheetMeta = { ...sheet("p1"), name: "Pivot", pivot: {
      sourceSheetId: "s1", sourceRange: "A1:B2", rowField: "Region", columnField: "", valueField: "Amount", aggregate: "sum",
      showRowTotals: false, showColumnTotals: false, filterField: "", filterValues: [],
    } };
    const h = await loadClient(source);
    h.callbacks.operation({ type: "operation", senderId: "agent", revision: 2, structure: { title: "Book", sheetOrder: ["s1", "p1"], sheets: { s1: source, p1: pivot } }, lastModified: 0, deletes: [], upserts: [
      { sheetId: "s1", ref: "A1", cell: cell("Region") }, { sheetId: "s1", ref: "B1", cell: cell("Amount") },
      { sheetId: "s1", ref: "A2", cell: cell("North") }, { sheetId: "s1", ref: "B2", cell: cell("0.0000001") },
    ] });
    await settle(); await settle();
    const replaced = h.gadget.applyOperation.mock.calls.flatMap(([op]) => (op as Operation).sheetReplacements ?? []).find((r) => r.sheetId === "p1");
    expect(Object.values((replaced as { cells: CellMap }).cells).map((c) => c.value)).toContain("0.0000001");
  });

  it("are rebuilt on open when their source changed while the workbook was closed", async () => {
    const source = sheet("s1"), pivot: SheetMeta = { ...sheet("p1"), name: "Pivot", pivot: {
      sourceSheetId: "s1", sourceRange: "A1:B2", rowField: "Region", columnField: "", valueField: "Amount", aggregate: "sum",
      showRowTotals: false, showColumnTotals: false, filterField: "", filterValues: [],
    } };
    await loadClient(source, {}, {
      sheetOrder: ["s1", "p1"], sheets: { s1: source, p1: pivot },
      cells: {
        s1: { A1: cell("Region"), B1: cell("Amount"), A2: cell("North"), B2: cell("20"), D1: cell("=Pivot!B2") },
        p1: { A1: cell("Region"), B1: cell("Amount"), A2: cell("North"), B2: cell("10") },
      },
    });
    await settle(); await settle();
    expect(shown("D1")).toBe("20");
  });

  it("update formulas on the visible sheet that read them", async () => {
    const source = sheet("s1"), pivot: SheetMeta = { ...sheet("p1"), name: "Pivot", pivot: {
      sourceSheetId: "s1", sourceRange: "A1:B2", rowField: "Region", columnField: "", valueField: "Amount", aggregate: "sum",
      showRowTotals: false, showColumnTotals: false, filterField: "", filterValues: [],
    } };
    const h = await loadClient(source);
    h.callbacks.operation({ type: "operation", senderId: "agent", revision: 2, structure: { title: "Book", sheetOrder: ["s1", "p1"], sheets: { s1: source, p1: pivot } }, lastModified: 0, deletes: [], upserts: [
      { sheetId: "s1", ref: "A1", cell: cell("Region") }, { sheetId: "s1", ref: "B1", cell: cell("Amount") },
      { sheetId: "s1", ref: "A2", cell: cell("North") }, { sheetId: "s1", ref: "B2", cell: cell("10") }, { sheetId: "s1", ref: "D1", cell: cell("=Pivot!B2") },
    ] });
    await settle(); await settle();
    expect(shown("D1")).toBe("10");
    const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    typeIntoActiveCell("20");
    await settle(); await settle();
    expect(shown("D1")).toBe("20");
  });

  it("follow an undone edit to their source", async () => {
    const source = sheet("s1"), pivot: SheetMeta = { ...sheet("p1"), name: "Pivot", pivot: {
      sourceSheetId: "s1", sourceRange: "A1:B2", rowField: "Region", columnField: "", valueField: "Amount", aggregate: "sum",
      showRowTotals: false, showColumnTotals: false, filterField: "", filterValues: [],
    } };
    const book = { title: "Book", sheetOrder: ["s1", "p1"], sheets: { s1: source, p1: pivot } };
    const h = await loadClient(source);
    h.callbacks.operation({ type: "operation", senderId: "someone-else", revision: 2, structure: book, lastModified: 0, deletes: [], upserts: [
      { sheetId: "s1", ref: "A1", cell: cell("Region") }, { sheetId: "s1", ref: "B1", cell: cell("Amount") },
      { sheetId: "s1", ref: "A2", cell: cell("North") }, { sheetId: "s1", ref: "B2", cell: cell("10") },
    ] });
    await settle(); await settle();
    const lastPivot = () => {
      const replaced = h.gadget.applyOperation.mock.calls.flatMap(([op]) => (op as Operation).sheetReplacements ?? []).filter((r) => r.sheetId === "p1").at(-1);
      return Object.values((replaced as { cells: CellMap }).cells).map((c) => c.value);
    };
    const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    typeIntoActiveCell("20");
    await settle(); await settle();
    expect(lastPivot()).toContain("20");
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, metaKey: true, bubbles: true }));
    await settle(); await settle();
    expect(shown("B2")).toBe("10");
    expect(lastPivot()).toContain("10");
  });
});
