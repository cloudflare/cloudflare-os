// The Sheets client in a jsdom page, against a scripted `gadget` stub: how it keeps local and
// remote edits apart while it syncs. The module runs on import (it builds its page and connects),
// so each test imports a fresh copy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cell, CellMap, GadgetStub, OpenedDocument, Operation, OperationEvent, OperationResult, SheetMeta, SubscriberCallbacks } from "../files/lib/protocol.ts";

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
}

async function loadClient(meta: SheetMeta, cells: CellMap = {}, doc: Partial<OpenedDocument> = {}): Promise<Harness> {
  let callbacks: SubscriberCallbacks | null = null;
  const gadget = {
    subscribe: vi.fn(async (callback: SubscriberCallbacks): Promise<OpenedDocument> => {
      callbacks = callback;
      return { revision: 1, lastModified: 0, ...structure(meta), cells: { [meta.id]: cells }, cursors: {}, ...doc };
    }),
    openDocument: vi.fn(),
    getCellsPage: vi.fn(),
    getSheetSlices: vi.fn(),
    stageCells: vi.fn(),
    applyOperation: vi.fn(async (): Promise<OperationResult> => ({ status: "applied", revision: 2, conflicts: [] })),
    updatePresence: vi.fn(async () => {}),
    leavePresence: vi.fn(async () => {}),
  };
  Object.assign(globalThis, { gadget, RpcTarget: class {} });
  vi.resetModules();
  await import("../files/client.ts");
  await settle();
  return { callbacks: callbacks!, gadget };
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

  it("moves an unsaved edit with its row when someone else inserts a row above it", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("first"), A2: cell("second") });
    document.querySelector<HTMLElement>(".grid-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    typeIntoActiveCell("edited");
    // Before the edit is saved, a row is inserted above A1: "second" is now A3.
    const moved = { ...meta, layout: 2 };
    h.callbacks.operation(remoteEvent(moved, 2, { replacedSheets: ["s1"], replacedCells: { s1: { A2: cell("first"), A3: cell("second") } }, moves: { s1: [{ kind: "lines", rows: true, at: 0, count: 1 }] } }));
    await settle();
    expect(shown("A2")).toBe("first");
    expect(shown("A3")).toBe("edited");
    const sent = h.gadget.applyOperation.mock.calls.at(-1)![0] as Operation;
    expect(sent.cellOps).toEqual([{ sheetId: "s1", ref: "A3", value: "edited", fmt: null, baseVersion: 1, layout: 2 }]);
  });

  it("resends an edit refused as misplaced where its row went", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("first"), A2: cell("second") });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    document.querySelector<HTMLElement>(".grid-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    typeIntoActiveCell("edited");
    await settle(); // the save of A2 is out
    expect((h.gadget.applyOperation.mock.calls[0][0] as Operation).cellOps).toEqual([{ sheetId: "s1", ref: "A2", value: "edited", fmt: null, baseVersion: 1, layout: 0 }]);
    // A peer's insert commits first; the server refuses the edit, addressed before it.
    h.callbacks.operation(remoteEvent({ ...meta, layout: 2 }, 2, { replacedSheets: ["s1"], replacedCells: { s1: { A2: cell("first"), A3: cell("second") } }, moves: { s1: [{ kind: "lines", rows: true, at: 0, count: 1 }] } }));
    save.resolve({ status: "unchanged", revision: 2, conflicts: [], misplaced: [{ sheetId: "s1", ref: "A2" }] });
    await settle();
    expect(h.gadget.applyOperation).toHaveBeenCalledTimes(2);
    expect((h.gadget.applyOperation.mock.calls[1][0] as Operation).cellOps).toEqual([{ sheetId: "s1", ref: "A3", value: "edited", fmt: null, baseVersion: 1, layout: 2 }]);
    expect(shown("A2")).toBe("first");
    expect(shown("A3")).toBe("edited");
  });

  it("doesn't resend an edit saved before a move carried it, and shows a later write over it", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta);
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    typeIntoActiveCell("mine");
    await settle(); // the save of A1 is out
    // An agent inserts a row above it (the saved edit moves to A2), then writes A2.
    h.callbacks.operation({ ...remoteEvent({ ...meta, layout: 3 }, 3, { replacedSheets: ["s1"], replacedCells: { s1: { A2: cell("mine", 2) } }, moves: { s1: [{ kind: "lines", rows: true, at: 0, count: 1 }] } }), senderId: "agent" });
    h.callbacks.operation({ ...remoteEvent({ ...meta, layout: 3 }, 4, { upserts: [{ sheetId: "s1", ref: "A2", cell: cell("theirs", 3) }] }), senderId: "agent" });
    save.resolve({ status: "applied", revision: 2, conflicts: [], upserts: [{ sheetId: "s1", ref: "A1", cell: cell("mine", 2) }], deletes: [] });
    await settle();
    expect(shown("A2")).toBe("theirs");
    expect(h.gadget.applyOperation.mock.calls.slice(1).flatMap(([op]) => (op as Operation).cellOps ?? [])).toEqual([]);
  });

  it("keeps an edit a move carried when its original write was refused as a conflict", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("old") });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    typeIntoActiveCell("mine");
    await settle(); // the save of A1 is out
    // An agent wrote A1 first (the save conflicts), then inserted a row above it.
    h.callbacks.operation({ ...remoteEvent(meta, 2, { upserts: [{ sheetId: "s1", ref: "A1", cell: cell("theirs", 2) }] }), senderId: "agent" });
    h.callbacks.operation({ ...remoteEvent({ ...meta, layout: 3 }, 3, { replacedSheets: ["s1"], replacedCells: { s1: { A2: cell("theirs", 2) } }, moves: { s1: [{ kind: "lines", rows: true, at: 0, count: 1 }] } }), senderId: "agent" });
    save.resolve({ status: "conflict", revision: 2, conflicts: [{ sheetId: "s1", ref: "A1", cell: cell("theirs", 2) }] });
    await settle();
    expect(h.gadget.applyOperation.mock.calls.slice(1).flatMap(([op]) => (op as Operation).cellOps ?? [])).toContainEqual(expect.objectContaining({ ref: "A2", value: "mine" }));
  });

  it("shifts an unsaved formula by each move in turn, a sort by only its own displacement", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("first"), A2: cell("second") });
    document.querySelector<HTMLElement>(".grid-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    typeIntoActiveCell("=C1*3");
    // A row is inserted above, then rows 2–3 are sorted so the first record ends up third.
    h.callbacks.operation(remoteEvent({ ...meta, layout: 2 }, 2, { replacedSheets: ["s1"], replacedCells: { s1: { A2: cell("second"), A3: cell("first") } }, moves: { s1: [{ kind: "lines", rows: true, at: 0, count: 1 }, { kind: "sort", r1: 1, c1: 0, c2: 1, order: [2, 1] }] } }));
    await settle();
    const sent = h.gadget.applyOperation.mock.calls.at(-1)![0] as Operation;
    expect(sent.cellOps).toEqual([{ sheetId: "s1", ref: "B3", value: "=C3*3", fmt: null, baseVersion: 0, layout: 2 }]);
  });

  it("renames the sheet an unsaved formula reads when someone else renames it", async () => {
    const data = { ...sheet("s1"), name: "Data" }, other = sheet("s2");
    const both = (name: string) => ({ title: "Book", sheetOrder: ["s2", "s1"], sheets: { s1: { ...data, name }, s2: other } });
    const h = await loadClient(other, {}, { ...both("Data"), cells: { s1: { A1: cell("7") }, s2: { A1: cell("=Data!A1") } } });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    typeIntoActiveCell("=Data!A1*2");
    // The agent renames Data before the edit is saved (and rewrites the stored A1 with it).
    h.callbacks.operation({ ...remoteEvent(other, 2, { upserts: [{ sheetId: "s2", ref: "A1", cell: cell("=Renamed!A1", 2) }] }), structure: both("Renamed"), senderId: "agent" });
    await settle();
    expect((h.gadget.applyOperation.mock.calls[0][0] as Operation).cellOps).toEqual([expect.objectContaining({ ref: "A1", value: "=Renamed!A1*2" })]);
    save.resolve({ status: "applied", revision: 3, conflicts: [], upserts: [{ sheetId: "s2", ref: "A1", cell: cell("=Renamed!A1*2", 3) }], deletes: [] });
    await settle();
    expect(shown("A1")).toBe("14");
  });

  it("keeps a rename's rewrite of a formula whose save landed before it, when the older reply arrives", async () => {
    const data = sheet("s1"), other = { ...sheet("s2"), name: "Other" };
    const book = (name: string) => ({ title: "Book", sheetOrder: ["s2", "s1"], sheets: { s1: { ...data, name }, s2: other } });
    const h = await loadClient(other, {}, { ...book("Sheet1"), cells: { s1: { A1: cell("7") }, s2: {} } });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    typeIntoActiveCell("=Sheet1!A1*2");
    await settle(); // the save is out, and commits at revision 2
    h.callbacks.operation({ ...remoteEvent(other, 3, { upserts: [{ sheetId: "s2", ref: "A1", cell: cell("=Renamed!A1*2", 3) }] }), structure: book("Renamed"), senderId: "agent" });
    save.resolve({ status: "applied", revision: 2, conflicts: [], upserts: [{ sheetId: "s2", ref: "A1", cell: cell("=Sheet1!A1*2", 2) }], deletes: [] });
    await settle();
    expect(shown("A1")).toBe("14");
    expect(h.gadget.applyOperation).toHaveBeenCalledTimes(1);
  });

  it("refuses edits to a sheet while its moved cells load, so none lands on another record", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("first"), A2: cell("second") });
    const slices = deferred<{ revision: number; slices: { sheetId: string; after: string; from: string; to: string }[] }>();
    h.gadget.getSheetSlices.mockImplementation(() => slices.promise);
    h.gadget.getCellsPage.mockResolvedValue({ revision: 2, sheetId: "s1", next: null, packed: { refs: ["A2", "A3"], values: ["first", "second"], versions: [2, 2], styles: [-1, -1], fmts: [] } });
    // An agent inserts a row above; the sheet is too big to send, so it's read again.
    h.callbacks.operation({ ...remoteEvent({ ...meta, layout: 2 }, 2, { replacedSheets: ["s1"], replacedCells: { s1: null }, moves: { s1: [{ kind: "lines", rows: true, at: 0, count: 1 }] } }), senderId: "agent" });
    document.querySelector<HTMLElement>(".grid-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    typeIntoActiveCell("edited");
    slices.resolve({ revision: 2, slices: [{ sheetId: "s1", after: "", from: "", to: "" }] });
    await settle();
    expect(h.gadget.applyOperation.mock.calls.flatMap(([op]) => (op as Operation).cellOps ?? [])).toEqual([]);
    expect([shown("A2"), shown("A3")]).toEqual(["first", "second"]);
  });

  it("drops an unsaved edit on a sheet someone else moved without saying how, rather than save it over another record", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("first"), A2: cell("second") });
    document.querySelector<HTMLElement>(".grid-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    typeIntoActiveCell("edited");
    // An older client inserts a row above A1 and sends no moves.
    h.callbacks.operation(remoteEvent({ ...meta, layout: 2 }, 2, { replacedSheets: ["s1"], replacedCells: { s1: { A2: cell("first", 2), A3: cell("second", 2) } }, moves: { s1: null } }));
    await settle();
    expect(h.gadget.applyOperation.mock.calls.flatMap(([op]) => (op as Operation).cellOps ?? [])).toEqual([]);
    expect([shown("A2"), shown("A3")]).toEqual(["first", "second"]);
  });

  it("keeps a later move's layout when an older save of its sheet is acknowledged", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("first") });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    // This tab inserts a row; its replacement is out.
    document.querySelector<HTMLElement>('td.cell[data-ref="A1"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    [...document.querySelectorAll<HTMLElement>(".mi")].find((row) => row.textContent?.includes("Insert row above"))!.click();
    await settle();
    expect((h.gadget.applyOperation.mock.calls[0][0] as Operation).sheetReplacements).toHaveLength(1);
    // An agent's insert commits after it, and its event arrives before this tab's reply.
    h.callbacks.operation({ ...remoteEvent({ ...meta, layout: 3 }, 3, { replacedSheets: ["s1"], replacedCells: { s1: { A3: cell("first") } }, moves: { s1: [{ kind: "lines", rows: true, at: 0, count: 1 }] } }), senderId: "agent" });
    save.resolve({ status: "applied", revision: 2, conflicts: [], structure: structure({ ...meta, layout: 2 }) });
    await settle();
    typeIntoActiveCell("edited");
    await settle();
    expect((h.gadget.applyOperation.mock.calls.at(-1)![0] as Operation).cellOps?.[0]).toMatchObject({ value: "edited", layout: 3 });
  });

  it("resends a pending formula another sheet's move rewrote while its save was out", async () => {
    const data = { ...sheet("s1"), name: "Data" }, other = sheet("s2");
    const both = { title: "Book", sheetOrder: ["s2", "s1"], sheets: { s1: data, s2: other } };
    const h = await loadClient(other, {}, { ...both, cells: { s1: { A1: cell("7") }, s2: {} } });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    typeIntoActiveCell("=Data!A1*2");
    await settle(); // the save is out with the old reference
    expect((h.gadget.applyOperation.mock.calls[0][0] as Operation).cellOps?.[0]?.value).toBe("=Data!A1*2");
    // A row inserted above Data!A1 commits first; the server still accepts the old text.
    h.callbacks.operation({ ...remoteEvent(other, 2, { replacedSheets: ["s1"], replacedCells: { s1: { A2: cell("7") } }, moves: { s1: [{ kind: "lines", rows: true, at: 0, count: 1 }] } }), structure: { ...both, sheets: { s1: { ...data, layout: 2 }, s2: other } } });
    save.resolve({ status: "applied", revision: 3, conflicts: [], upserts: [{ sheetId: "s2", ref: "A1", cell: cell("=Data!A1*2") }], deletes: [] });
    await settle();
    expect(h.gadget.applyOperation).toHaveBeenCalledTimes(2);
    expect((h.gadget.applyOperation.mock.calls[1][0] as Operation).cellOps).toEqual([{ sheetId: "s2", ref: "A1", value: "=Data!A2*2", fmt: null, baseVersion: 1, layout: 0 }]);
  });

  it("drops an unsaved edit on a row someone else deleted, and moves a formula's references with the rows", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("first"), A2: cell("second"), A3: cell("third") });
    const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
    typeIntoActiveCell("gone");
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    typeIntoActiveCell("=A3&\"!\"");
    h.callbacks.operation(remoteEvent({ ...meta, layout: 2 }, 2, { replacedSheets: ["s1"], replacedCells: { s1: { A1: cell("second"), A2: cell("third") } }, moves: { s1: [{ kind: "lines", rows: true, at: 0, count: -1 }] } }));
    await settle();
    const sent = h.gadget.applyOperation.mock.calls.at(-1)![0] as Operation;
    expect(sent.cellOps).toEqual([{ sheetId: "s1", ref: "A2", value: '=A2&"!"', fmt: null, baseVersion: 1, layout: 2 }]);
    expect(shown("A1")).toBe("second");
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

  it("won't commit a draft whose cell's rows moved while this tab was disconnected, and keeps it open", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("first"), A2: cell("second") });
    const grid = document.querySelector<HTMLElement>(".grid-scroll")!;
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    const editor = document.querySelector<HTMLTextAreaElement>(".cell-editor")!;
    editor.value = "edited";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    // An agent's row insertion lands unheard; the reconnect's snapshot has "first" at A2 now.
    h.gadget.subscribe.mockImplementationOnce(async (callback: SubscriberCallbacks) => {
      h.callbacks = callback;
      return { revision: 3, lastModified: 0, ...structure({ ...meta, layout: 3 }), cells: { s1: { A2: cell("first"), A3: cell("second") } }, cursors: {} };
    });
    (h.callbacks as unknown as Disposable)[Symbol.dispose]();
    await settle();
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(h.gadget.applyOperation.mock.calls.flatMap(([op]) => (op as Operation).cellOps ?? [])).toEqual([]);
    expect(editor.value).toBe("edited");
  });

  it("renames the sheet an unsaved formula reads when it was renamed while this tab was disconnected", async () => {
    const data = { ...sheet("s1"), name: "Data" }, other = sheet("s2");
    const book = (name: string) => ({ title: "Book", sheetOrder: ["s2", "s1"], sheets: { s1: { ...data, name }, s2: other } });
    const h = await loadClient(other, {}, { ...book("Data"), cells: { s1: { A1: cell("7") }, s2: { A1: cell("=Data!A1") } } });
    const snapshot = deferred<OpenedDocument>();
    h.gadget.subscribe.mockImplementationOnce(async (callback: SubscriberCallbacks) => { h.callbacks = callback; return snapshot.promise; });
    (h.callbacks as unknown as Disposable)[Symbol.dispose]();
    typeIntoActiveCell("=Data!A1*2");
    snapshot.resolve({ revision: 3, lastModified: 0, ...book("Renamed"), cells: { s1: { A1: cell("7") }, s2: { A1: cell("=Renamed!A1", 3) } }, cursors: {} });
    await settle();
    const sent = h.gadget.applyOperation.mock.calls.flatMap(([op]) => (op as Operation).cellOps ?? []).map((op) => op.value);
    expect(sent).toContain("=Renamed!A1*2");
    expect(sent).not.toContain("=Data!A1*2");
    expect(shown("A1")).toBe("14");
  });

  it("drops an unsaved formula reading a sheet whose rows moved while this tab was disconnected", async () => {
    const data = { ...sheet("s1"), name: "Data" }, other = sheet("s2");
    const book = (layout: number) => ({ title: "Book", sheetOrder: ["s2", "s1"], sheets: { s1: { ...data, layout }, s2: other } });
    const h = await loadClient(other, {}, { ...book(0), cells: { s1: { A1: cell("7") }, s2: { A1: cell("=Data!A1") } } });
    const snapshot = deferred<OpenedDocument>();
    h.gadget.subscribe.mockImplementationOnce(async (callback: SubscriberCallbacks) => { h.callbacks = callback; return snapshot.promise; });
    (h.callbacks as unknown as Disposable)[Symbol.dispose]();
    typeIntoActiveCell("=Data!A1*2");
    // Meanwhile an agent inserted a row above Data!A1, rewriting the stored formula.
    snapshot.resolve({ revision: 3, lastModified: 0, ...book(3), cells: { s1: { A2: cell("7") }, s2: { A1: cell("=Data!A2", 3) } }, cursors: {} });
    await settle();
    expect(h.gadget.applyOperation.mock.calls.flatMap(([op]) => (op as Operation).cellOps ?? []).map((op) => op.value)).not.toContain("=Data!A1*2");
    expect(shown("A1")).toBe("7");
  });

  it("forgets undo history on a sheet whose rows moved while this tab was disconnected", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("first"), A2: cell("second") });
    document.querySelector<HTMLElement>(".grid-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    typeIntoActiveCell("edited");
    await settle(); // saved
    const undo = document.querySelector<HTMLElement>('.tb[aria-label="Undo"]')!;
    expect(undo.getAttribute("aria-disabled")).not.toBe("true");
    // An agent's row insertion lands unheard; the reconnect's snapshot has it.
    h.gadget.subscribe.mockImplementationOnce(async (callback: SubscriberCallbacks) => {
      h.callbacks = callback;
      return { revision: 3, lastModified: 0, ...structure({ ...meta, layout: 3 }), cells: { s1: { A2: cell("first"), A3: cell("edited", 2) } }, cursors: {} };
    });
    (h.callbacks as unknown as Disposable)[Symbol.dispose]();
    await settle();
    expect(undo.getAttribute("aria-disabled")).toBe("true");
  });

  it("reads a sheet again when its replacement was acknowledged while a reconnect's older snapshot loaded", async () => {
    const meta = sheet("s1");
    const h = await loadClient(meta, { A1: cell("first"), A2: cell("second") });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    document.querySelector<HTMLElement>('td.cell[data-ref="A1"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    [...document.querySelectorAll<HTMLElement>(".mi")].find((row) => row.textContent?.includes("Insert row above"))!.click();
    await settle(); // the insert is out
    const snapshot = deferred<OpenedDocument>();
    h.gadget.subscribe.mockImplementationOnce(async (callback: SubscriberCallbacks) => { h.callbacks = callback; return snapshot.promise; });
    (h.callbacks as unknown as Disposable)[Symbol.dispose]();
    save.resolve({ status: "applied", revision: 2, conflicts: [], structure: structure({ ...meta, layout: 2 }) });
    await settle();
    // The server, at revision 2, has the rows moved down.
    h.gadget.getSheetSlices.mockResolvedValue({ revision: 2, slices: [{ sheetId: "s1", after: "", from: "", to: "" }] });
    h.gadget.getCellsPage.mockResolvedValue({ revision: 2, sheetId: "s1", next: null, packed: { refs: ["A2", "A3"], values: ["first", "second"], versions: [2, 2], styles: [-1, -1], fmts: [] } });
    snapshot.resolve({ revision: 1, lastModified: 0, ...structure(meta), cells: { s1: { A1: cell("first"), A2: cell("second") } }, cursors: {} });
    await settle();
    expect([shown("A1"), shown("A2"), shown("A3")]).toEqual(["", "first", "second"]);
  });

  it("keeps a rename acknowledged while a reconnect's older snapshot loads", async () => {
    const one = sheet("s1"), other = { ...sheet("s2"), name: "Other" };
    const book = (name: string) => ({ title: "Book", sheetOrder: ["s1", "s2"], sheets: { s1: { ...one, name }, s2: other } });
    const h = await loadClient(one, {}, { ...book("Sheet1"), cells: { s1: { A1: cell("7") }, s2: { A1: cell("=Sheet1!A1") } } });
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
    save.resolve({ status: "applied", revision: 2, conflicts: [], structure: book("Mine"), upserts: [{ sheetId: "s2", ref: "A1", cell: cell("=Mine!A1", 2) }], deletes: [] });
    await settle();
    snapshot.resolve({ revision: 1, lastModified: 0, ...book("Sheet1"), cells: { s1: { A1: cell("7") }, s2: { A1: cell("=Sheet1!A1") } }, cursors: {} });
    await settle();
    expect(document.querySelector(".tab[data-id='s1']")!.textContent).toContain("Mine");
    const later = h.gadget.applyOperation.mock.calls.slice(1).map(([op]) => (op as Operation).structure?.sheets?.s1?.name).filter(Boolean);
    expect(later).not.toContain("Sheet1");
  });

  it("keeps a rename that overtook this tab's own rename before its reply arrived", async () => {
    const one = sheet("s1"), other = { ...sheet("s2"), name: "Other" };
    const two = { title: "Book", sheetOrder: ["s1", "s2"], sheets: { s1: one, s2: other } };
    const h = await loadClient(one, {}, { ...two, cells: { s1: { A1: cell("7") }, s2: { A1: cell("=Sheet1!A1") } } });
    const save = deferred<OperationResult>();
    h.gadget.applyOperation.mockImplementationOnce(() => save.promise);
    document.querySelector(".tab[data-id='s1']")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = document.querySelector<HTMLInputElement>(".tab-rename")!;
    input.value = "Mine";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(); // the rename is out, and commits at revision 2
    const renamed = (name: string, formula: string, revision: number): OperationEvent => ({
      type: "operation", senderId: "agent", revision, lastModified: 0, deletes: [],
      structure: { ...two, sheets: { s1: { ...one, name }, s2: other } },
      upserts: [{ sheetId: "s2", ref: "A1", cell: cell(formula, revision) }],
    });
    // The agent renames it again at revision 3; that event arrives before this tab's reply.
    h.callbacks.operation(renamed("Theirs", "=Theirs!A1", 3));
    const { structure: _, ...ack } = renamed("Mine", "=Mine!A1", 2);
    save.resolve({ ...ack, status: "applied", conflicts: [], structure: { ...two, sheets: { s1: { ...one, name: "Mine" }, s2: other } } });
    await settle();
    expect(document.querySelector(".tab[data-id='s1'] .tname")?.textContent).toBe("Theirs");
    // Nothing puts "Mine" back.
    for (const [operation] of h.gadget.applyOperation.mock.calls.slice(1)) expect((operation as Operation).structure?.sheets?.s1?.name).not.toBe("Mine");
    document.querySelector<HTMLElement>(".tab[data-id='s2']")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(shown("A1")).toBe("7");
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

  it("won't paste a cut whose source rows someone else moved, so it can't remove another record's cells", async () => {
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
    h.callbacks.operation({ ...remoteEvent({ ...meta, layout: 2 }, 2, { replacedSheets: ["s1"], replacedCells: { s1: { A2: cell("same"), B2: cell("first-id"), A3: cell("same"), B3: cell("second-id") } }, moves: { s1: [{ kind: "lines", rows: true, at: 0, count: 1 }] } }), senderId: "agent" });
    await settle();
    go("D1");
    grid.dispatchEvent(clipboardEvent("paste"));
    await settle();
    expect(shown("A2")).toBe("same");
    expect(shown("D1") ?? "").toBe("");
    expect(h.gadget.applyOperation.mock.calls.flatMap(([op]) => (op as Operation).cellOps ?? [])).toEqual([]);
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
    expect(sent.structure?.sheets?.s1?.charts?.[0].range).toBe("D1:E3");
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

    it("wait for a source still loading its moved cells before rebuilding", async () => {
      const data = named("s1", "Data"), pivot = named("s2", "Pivot", pivotOf("s1"));
      const h = await loadClient(data, {}, { ...book(data, pivot), cells: { s1: { A1: cell("k"), B1: cell("v"), A2: cell("a"), B2: cell("10") }, s2: {} } });
      await refreshed();
      const slices = deferred<{ revision: number; slices: { sheetId: string; after: string; from: string; to: string }[] }>();
      h.gadget.getSheetSlices.mockImplementation(() => slices.promise);
      h.gadget.getCellsPage.mockResolvedValue({ revision: 5, sheetId: "s1", next: null, packed: { refs: ["A2", "B2", "A3", "B3"], values: ["k", "v", "a", "10"], versions: [5, 5, 5, 5], styles: [-1, -1, -1, -1], fmts: [] } });
      // An agent inserts a row above the source (too big to send), which moves the pivot's range.
      const moved = { ...pivot, pivot: { ...pivotOf("s1"), sourceRange: "A2:B3" } };
      h.callbacks.operation({ ...remoteEvent(data, 5, { senderId: "agent", replacedSheets: ["s1"], replacedCells: { s1: null }, moves: { s1: [{ kind: "lines", rows: true, at: 0, count: 1 }] } }), structure: book({ ...data, layout: 5 }, moved) });
      await refreshed(); // longer than a refresh's pause, with the pages still out
      slices.resolve({ revision: 5, slices: [{ sheetId: "s1", after: "", from: "", to: "" }] });
      await refreshed();
      const replaced = h.gadget.applyOperation.mock.calls.flatMap(([op]) => (op as Operation).sheetReplacements ?? []).filter((r) => r.sheetId === "s2");
      for (const r of replaced) expect(JSON.stringify(r)).not.toContain("not found");
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
  it("keeps a range whole when its first row moves below its last", async () => {
    await loadClient(sheet("s1"), { A1: cell("10"), A2: cell("20"), A3: cell("30"), B5: cell("=SUM(A1:A3)") });
    const head = () => document.querySelector<HTMLElement>('th.rowhead[data-row="0"]')!;
    const mouse = (target: EventTarget, type: string, clientY: number) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY }));
    // Select row 1, then drag it by its header into the lower half of row 3.
    mouse(head(), "mousedown", 36); mouse(window, "mouseup", 36);
    await settle();
    mouse(head(), "mousedown", 36); mouse(window, "mousemove", 60); mouse(window, "mousemove", 90); mouse(window, "mouseup", 90);
    await settle();
    expect([shown("A1"), shown("A2"), shown("A3")]).toEqual(["20", "30", "10"]);
    expect(shown("B5")).toBe("60");
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
    page.resolve({ revision: 3, cells: {}, next: null });
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

describe("a refused row insert", () => {
  it("discards the references it rewrote on other sheets", async () => {
    const one = sheet("s1"), two = { ...sheet("s2"), name: "Other" };
    const book = { title: "Book", sheetOrder: ["s1", "s2"], sheets: { s1: one, s2: two } };
    const cells = { s1: { A1: cell("1") }, s2: { A1: cell("=Sheet1!A1") } };
    const h = await loadClient(one);
    h.gadget.openDocument.mockImplementation(async (): Promise<OpenedDocument> => ({ revision: 3, lastModified: 0, ...book, cells, cursors: {} }));
    // Someone else's edit lands first, so the insert's save is refused and the workbook reloads.
    let refused: Operation | null = null;
    h.gadget.applyOperation.mockImplementation(async (op: Operation): Promise<OperationResult> => {
      if (!refused && op.sheetReplacements?.length) { refused = op; return { status: "conflict", revision: 3, conflicts: [], staleRevision: true }; }
      return { status: "applied", revision: 4, conflicts: [] };
    });
    h.callbacks.operation({ type: "operation", senderId: "someone-else", revision: 2, structure: book, upserts: [{ sheetId: "s2", ref: "A1", cell: cell("=Sheet1!A1") }], deletes: [], lastModified: 0 });
    await settle();
    document.querySelector<HTMLElement>('td.cell[data-ref="A1"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    [...document.querySelectorAll<HTMLElement>(".mi")].find((row) => row.textContent?.includes("Insert row above"))!.click();
    await settle(); await settle();
    expect(refused!.cellOps).toEqual([expect.objectContaining({ sheetId: "s2", value: "=Sheet1!A2" })]);
    const sent = h.gadget.applyOperation.mock.calls.map(([op]) => op as Operation).filter((op) => op !== refused).flatMap((op) => op.cellOps ?? []);
    expect(sent.filter((op) => op.sheetId === "s2")).toEqual([]);
  });

  it("discards an edit made on top of such a rewrite while the insert was being saved", async () => {
    const one = sheet("s1"), two = { ...sheet("s2"), name: "Other" };
    const book = { title: "Book", sheetOrder: ["s1", "s2"], sheets: { s1: one, s2: two } };
    const cells = { s1: { A1: cell("1") }, s2: { A1: cell("=Sheet1!A1") } };
    const h = await loadClient(one);
    h.gadget.openDocument.mockImplementation(async (): Promise<OpenedDocument> => ({ revision: 3, lastModified: 0, ...book, cells, cursors: {} }));
    const reply = deferred<OperationResult>();
    let refused: Operation | null = null;
    h.gadget.applyOperation.mockImplementation(async (op: Operation): Promise<OperationResult> => {
      if (!refused && op.sheetReplacements?.length) { refused = op; return reply.promise; }
      return { status: "applied", revision: 4, conflicts: [] };
    });
    h.callbacks.operation({ type: "operation", senderId: "someone-else", revision: 2, structure: book, upserts: [{ sheetId: "s2", ref: "A1", cell: cell("=Sheet1!A1") }], deletes: [], lastModified: 0 });
    await settle();
    document.querySelector<HTMLElement>('td.cell[data-ref="A1"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    [...document.querySelectorAll<HTMLElement>(".mi")].find((row) => row.textContent?.includes("Insert row above"))!.click();
    await settle(); // the insert's save is out
    // Bold the rewritten cell on the other sheet before the reply.
    [...document.querySelectorAll<HTMLElement>(".tab")].find((tab) => tab.textContent?.includes("Other"))!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    [...document.querySelectorAll<HTMLElement>(".tab")].find((tab) => tab.textContent?.includes("Other"))!.click();
    await settle();
    press(gridEl(), { key: "b", ctrlKey: true, metaKey: true });
    reply.resolve({ status: "conflict", revision: 3, conflicts: [], staleRevision: true });
    await settle(); await settle();
    const sent = h.gadget.applyOperation.mock.calls.map(([op]) => op as Operation).filter((op) => op !== refused).flatMap((op) => op.cellOps ?? []);
    expect(sent.filter((op) => op.sheetId === "s2" && op.value === "=Sheet1!A2")).toEqual([]);
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
