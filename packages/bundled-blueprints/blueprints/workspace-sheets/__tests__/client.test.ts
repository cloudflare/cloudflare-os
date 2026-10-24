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

async function loadClient(meta: SheetMeta, cells: CellMap = {}): Promise<Harness> {
  let callbacks: SubscriberCallbacks | null = null;
  const gadget = {
    subscribe: vi.fn(async (callback: SubscriberCallbacks): Promise<OpenedDocument> => {
      callbacks = callback;
      return { revision: 1, lastModified: 0, ...structure(meta), cells: { [meta.id]: cells }, cursors: {} };
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
    h.callbacks.operation({ type: "operation", senderId: "someone-else", revision: 2, structure: book, lastModified: 0, deletes: [], upserts: [
      { sheetId: "s1", ref: "A1", cell: cell("Region") }, { sheetId: "s1", ref: "B1", cell: cell("Amount") },
      { sheetId: "s1", ref: "A2", cell: cell("North") }, { sheetId: "s1", ref: "B2", cell: cell("10") }, { sheetId: "s1", ref: "A3", cell: cell("North") },
    ] });
    await settle(); await settle();
    const replaced = h.gadget.applyOperation.mock.calls.flatMap(([op]) => (op as Operation).sheetReplacements ?? []).find((r) => r.sheetId === "p1");
    const values = Object.values((replaced as { cells: CellMap }).cells).map((c) => c.value);
    expect(values).toContain("10");
    expect(values).not.toContain("5");
  });
});
