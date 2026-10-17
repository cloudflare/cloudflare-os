import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutationQueue, SubscriberRegistry } from "@gadgets/bundled-blueprints/libraries/sync/server";
import type { CollaboratorInfo, GadgetStub, SheetChart, SheetFilter, SheetMeta, SheetsDocument, SubscriberCallbacks } from "../files/lib/protocol.ts";

// The real server is checked under Workers globals by its own type programs. This DOM test
// loads it at runtime and uses its shared RPC type, without pulling Worker sources into lib.dom.
const { Gadget } = await vi.importActual<{ Gadget: { prototype: GadgetStub } }>("../files/server.ts");

// oxlint-disable-next-line typescript/no-extraneous-class -- the host's RpcTarget is a marker base class.
class RpcTarget {}

const sheet = (id: string): SheetMeta => ({
  id, name: id, rows: 8, cols: 8, colWidths: {}, rowHeights: {}, frozenRows: 0, frozenCols: 0,
  filter: null, charts: [], comments: [], pivot: null,
});
const chart = (title: string, x: number, y: number): SheetChart => ({
  id: "chart", type: "line", range: "A1:B3", title, x, y, width: 520, height: 320,
  xAxisTitle: "", yAxisTitle: "", legend: true, firstRowHeaders: true, firstColLabels: true, smooth: false,
});
const filter = (criteria: SheetFilter["criteria"] = {}): SheetFilter => ({
  row: 0, endRow: 2, columns: [0, 1], criteria, rowOrder: [1, 2], sort: null,
});
const fixture = (): SheetsDocument => ({
  revision: 0, title: "Client regressions", lastModified: 0, sheetOrder: ["sheet", "other"],
  sheets: {
    sheet: { ...sheet("sheet"), charts: [chart("Original", 96, 44)] },
    other: { ...sheet("other"), charts: [chart("Other chart", 300, 120)] },
  },
  cells: {
    sheet: Object.fromEntries(Object.entries({
      A1: "Kind", A2: "drop", A3: "keep", B1: "Sales", B2: "10", B3: "20",
      D1: '=HYPERLINK("https://example.com","Complete")', D2: "=T(D1)",
      D3: "=ISTEXT(D1)", D4: "=ISNONTEXT(D1)", D5: '=IF(TRUE,D1,"no")',
      D6: '=ISTEXT(HYPERLINK("https://example.com",42))',
      D7: '=ISBLANK(HYPERLINK("https://example.com",""))', D8: "=T(42)",
    }).map(([ref, value]) => [ref, { value, fmt: null, version: 1 }])),
    other: {},
  },
});

let subscriber: SubscriberCallbacks;
let initial: SheetsDocument;
const listeners: { target: EventTarget; type: string; listener: EventListenerOrEventListenerObject | null; capture: boolean }[] = [];
let originalStyles: Set<Element>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  initial = fixture();
  originalStyles = new Set(document.head.querySelectorAll("style"));
  // The entry owns page-lifetime listeners; remove those between isolated mounts.
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
      listeners.push({ target, type, listener, capture: typeof options === "boolean" ? options : options?.capture ?? false });
      add(type, listener, options);
    });
  }
  vi.stubGlobal("RpcTarget", RpcTarget);
  // jsdom omits matchMedia; the print listener still receives an actual event target.
  vi.stubGlobal("matchMedia", (media: string) => Object.assign(new EventTarget(), { media, matches: false }));
  // Only text measurement is supplied here; native browser smoke covers actual editor layout.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "", measureText: (text: string) => ({ width: text.length * 8 }),
  } as CanvasRenderingContext2D);
  vi.stubGlobal("gadget", {
    async subscribe(callback) { subscriber = callback; return structuredClone(initial); },
    async updatePresence() {},
    async leavePresence() {},
  } satisfies Pick<GadgetStub, "subscribe" | "updatePresence" | "leavePresence">);
});

afterEach(() => {
  for (const { target, type, listener, capture } of listeners.splice(0)) target.removeEventListener(type, listener, capture);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  for (const style of document.head.querySelectorAll("style")) if (!originalStyles.has(style)) style.remove();
});

const element = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const cell = (ref: string) => element<HTMLTableCellElement>(`td.cell[data-ref="${ref}"]`);
const frame = () => vi.advanceTimersByTimeAsync(16);
// Static import would bootstrap before the host globals exist; each test exercises a fresh page load.
const mount = async () => { await import("../files/client.ts"); await frame(); };
const key = (target: EventTarget, value: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
const select = (ref: string) => {
  const name = element<HTMLInputElement>("input.namebox");
  name.value = ref;
  key(name, "Enter");
};
const peer = (document: SheetsDocument) => subscriber.operation({
  type: "operation", senderId: "peer", revision: 1, upserts: [], deletes: [], replacedSheets: [], lastModified: 1,
  structure: { title: document.title, sheetOrder: document.sheetOrder, sheets: document.sheets },
});
const pointer = (target: EventTarget, type: string, x: number, y: number) => {
  // jsdom has MouseEvent, not PointerEvent; these handlers use their shared coordinates/button.
  target.dispatchEvent(new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
};
const startDrag = () => {
  pointer(element(".chart-card-head"), "pointerdown", 100, 100);
  pointer(window, "pointermove", 200, 140);
};

const pivotOption = (value: string) => [...document.querySelectorAll<HTMLLabelElement>(".pivot-filter-option")]
  .find(label => label.querySelector("span")?.textContent === value)!.querySelector<HTMLInputElement>("input")!;

// Exercise authoritative optimistic concurrency, with cloned RPC/storage boundaries rather than
// echoing client operations. Disabling delivery models the peer callback arriving after the reply.
const serverHost = (deliverOperations = true) => {
  initial.cells.sheet.A1.value = "old";
  delete initial.cells.sheet.B1;
  const { cells, ...meta } = structuredClone(initial);
  const stored = new Map<string, unknown>([["meta", meta], ...Object.entries(cells).map(([id, values]) => ["cells:" + id, values] as [string, unknown])]);
  const server: GadgetStub = Object.assign(Object.create(Gadget.prototype), {
    ctx: { storage: {
      get: async (name: string) => structuredClone(stored.get(name)),
      put: async (name: string, value: unknown) => { stored.set(name, structuredClone(value)); },
      delete: async (name: string) => stored.delete(name),
    } },
    mutations: new MutationQueue(),
    subscribers: new SubscriberRegistry<SubscriberCallbacks, CollaboratorInfo>(),
  });
  const host: GadgetStub = {
    async subscribe(callback, client) {
      subscriber = callback;
      const callbacks: SubscriberCallbacks = {
        operation(event) { if (deliverOperations) return callback.operation(structuredClone(event)); },
        presence(event) { return callback.presence(structuredClone(event)); },
      };
      return structuredClone(await server.subscribe(Object.assign(callbacks, {
        dup() { return this; },
        onRpcBroken() {},
        [Symbol.dispose]() {},
      }), client));
    },
    async applyOperation(operation) { return structuredClone(await server.applyOperation(structuredClone(operation))); },
    async getDocument() { return structuredClone(await server.getDocument()); },
    async updatePresence(presence) { server.updatePresence(presence); },
    async leavePresence(clientId) { server.leavePresence(clientId); },
  };
  vi.stubGlobal("gadget", host);
  return { server, host };
};
const sourceUpdate = (server: GadgetStub, value: string | null, baseVersion: number) => server.applyOperation({
  senderId: "peer", cellOps: [{ sheetId: "sheet", ref: "A1", value, fmt: null, baseVersion }],
});
const acknowledgementGate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const cutTo = (source: string, destination: string) => {
  const clipboard = new Map<string, string>();
  const transfer = (type: "cut" | "paste") => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: {
      setData: (format: string, value: string) => clipboard.set(format, value),
      getData: (format: string) => clipboard.get(format) || "",
    } });
    element(".grid-scroll").dispatchEvent(event);
  };
  select(source); transfer("cut"); select(destination); transfer("paste");
};
const editCell = (ref: string, value: string) => {
  select(ref); key(element(".grid-scroll"), "F2");
  const editor = element<HTMLTextAreaElement>("textarea.cell-editor");
  editor.value = value;
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  key(editor, "Enter");
};

describe("Sheets client regressions", () => {
  it.each([false, true])("preserves a peer's cut source and the pasted destination when acknowledgement is lost: %s", async lostAcknowledgement => {
    const { server, host } = serverHost(false);
    const send = host.applyOperation.bind(host);
    const acknowledgement = acknowledgementGate();
    let first = true;
    host.applyOperation = async operation => {
      if (!first) return send(operation);
      first = false;
      await sourceUpdate(server, "new", 1);
      const result = await send(operation);
      await acknowledgement.promise;
      if (lostAcknowledgement) throw new Error("reply lost after commit");
      return result;
    };
    await mount();
    cutTo("A1", "B1");
    await vi.advanceTimersByTimeAsync(200);
    const committed = await server.getDocument();
    expect([committed.cells.sheet.A1.value, committed.cells.sheet.B1.value]).toEqual(["new", "old"]);
    acknowledgement.release();
    await vi.advanceTimersByTimeAsync(200);
    const saved = await server.getDocument();
    expect([saved.cells.sheet.A1.value, saved.cells.sheet.B1.value]).toEqual(["new", "old"]);
    expect([cell("A1").textContent, cell("B1").textContent]).toEqual(["new", "old"]);
  });

  it("still rebases an ordinary explicit deletion onto the peer's authoritative version", async () => {
    const { server, host } = serverHost(false);
    const send = host.applyOperation.bind(host);
    let first = true;
    host.applyOperation = async operation => {
      if (first) { first = false; await sourceUpdate(server, "new", 1); }
      return send(operation);
    };
    await mount();
    select("A1"); key(element(".grid-scroll"), "Delete");
    await vi.advanceTimersByTimeAsync(300);
    expect((await server.getDocument()).cells.sheet.A1).toBeUndefined();
    expect(cell("A1").textContent).toBe("");
  });

  it.each(["edit", "delete"])("retains a newer local %s queued while a cut source conflict awaits acknowledgement", async action => {
    const { server, host } = serverHost();
    const send = host.applyOperation.bind(host);
    const acknowledgement = acknowledgementGate();
    let first = true;
    host.applyOperation = async operation => {
      if (!first) return send(operation);
      first = false;
      await sourceUpdate(server, "new", 1);
      const result = await send(operation);
      await acknowledgement.promise;
      return result;
    };
    await mount();
    cutTo("A1", "B1");
    await vi.advanceTimersByTimeAsync(200);
    if (action === "edit") editCell("A1", "newer local edit");
    else { select("A1"); key(element(".grid-scroll"), "Delete"); }
    acknowledgement.release();
    await vi.advanceTimersByTimeAsync(300);
    const saved = await server.getDocument();
    expect(saved.cells.sheet.A1?.value).toBe(action === "edit" ? "newer local edit" : undefined);
    expect(saved.cells.sheet.B1.value).toBe("old");
    expect(cell("A1").textContent).toBe(action === "edit" ? "newer local edit" : "");
    expect(cell("B1").textContent).toBe("old");
  });

  it.each(["newest", null])("does not restore a stale cut conflict over a later peer source update: %s", async latest => {
    const { server, host } = serverHost();
    const send = host.applyOperation.bind(host);
    const acknowledgement = acknowledgementGate();
    let first = true;
    host.applyOperation = async operation => {
      if (!first) return send(operation);
      first = false;
      await sourceUpdate(server, "new", 1);
      const result = await send(operation);
      await acknowledgement.promise;
      return result;
    };
    await mount();
    cutTo("A1", "B1");
    await vi.advanceTimersByTimeAsync(200);
    await sourceUpdate(server, latest, 2);
    acknowledgement.release();
    await vi.advanceTimersByTimeAsync(200);
    const saved = await server.getDocument();
    expect(saved.cells.sheet.A1?.value).toBe(latest ?? undefined);
    expect(saved.cells.sheet.B1.value).toBe("old");
    expect(cell("A1").textContent).toBe(latest ?? "");
    expect(cell("B1").textContent).toBe("old");
  });

  it.each([{ lost: false, deliver: true }, { lost: true, deliver: true }, { lost: true, deliver: false }])("keeps a recreated peer source after an accepted cut (lost reply: $lost, peer callback: $deliver)", async ({ lost, deliver }) => {
    const { server, host } = serverHost(deliver);
    const send = host.applyOperation.bind(host);
    const acknowledgement = acknowledgementGate();
    let first = true;
    host.applyOperation = async operation => {
      const result = await send(operation);
      if (first) {
        first = false;
        await acknowledgement.promise;
        if (lost) throw new Error("reply lost after deletion committed");
      }
      return result;
    };
    await mount();
    cutTo("A1", "B1");
    await vi.advanceTimersByTimeAsync(200);
    await sourceUpdate(server, "new", 0);
    acknowledgement.release();
    await vi.advanceTimersByTimeAsync(200);
    const saved = await server.getDocument();
    expect([saved.cells.sheet.A1.value, saved.cells.sheet.B1.value]).toEqual(["new", "old"]);
    expect([cell("A1").textContent, cell("B1").textContent]).toEqual(["new", "old"]);
  });

  it("does not rebase a pending conditional cut deletion from an earlier edit acknowledgement", async () => {
    const { server, host } = serverHost();
    const send = host.applyOperation.bind(host);
    const acknowledgement = acknowledgementGate();
    let first = true;
    host.applyOperation = async operation => {
      const result = await send(operation);
      if (first) { first = false; await acknowledgement.promise; }
      return result;
    };
    await mount();
    editCell("A1", "cut text");
    await vi.advanceTimersByTimeAsync(200);
    cutTo("A1", "B1");
    await sourceUpdate(server, "new", 2);
    acknowledgement.release();
    await vi.advanceTimersByTimeAsync(300);
    const saved = await server.getDocument();
    expect([saved.cells.sheet.A1.value, saved.cells.sheet.B1.value]).toEqual(["new", "cut text"]);
    expect([cell("A1").textContent, cell("B1").textContent]).toEqual(["new", "cut text"]);
  });

  it("keeps a newer explicit edit made while an ambiguous cut recovery document is in flight", async () => {
    const { server, host } = serverHost(false);
    const send = host.applyOperation.bind(host);
    const getDocument = host.getDocument.bind(host);
    const recoveryStarted = acknowledgementGate();
    const recovery = acknowledgementGate();
    let first = true;
    host.applyOperation = async operation => {
      const result = await send(operation);
      if (first) {
        first = false;
        await sourceUpdate(server, "new", 0);
        throw new Error("reply lost after deletion committed");
      }
      return result;
    };
    host.getDocument = async () => {
      const snapshot = await getDocument();
      recoveryStarted.release();
      await recovery.promise;
      return snapshot;
    };
    await mount();
    cutTo("A1", "B1");
    await vi.advanceTimersByTimeAsync(240);
    await recoveryStarted.promise;
    editCell("A1", "newer local edit");
    recovery.release();
    await vi.advanceTimersByTimeAsync(300);
    const saved = await server.getDocument();
    expect([saved.cells.sheet.A1.value, saved.cells.sheet.B1.value]).toEqual(["newer local edit", "old"]);
    expect([cell("A1").textContent, cell("B1").textContent]).toEqual(["newer local edit", "old"]);
  });

  it("rejects an unrepresentable generated sheet qualifier before mutation and retains the cut for retry", async () => {
    initial.sheets.sheet.name = "Data\\";
    initial.cells.sheet.A1.value = "=A2";
    initial.cells.sheet.A2.value = "42";
    initial.cells.other.A1 = { value: "Destination", fmt: null, version: 1 };
    initial.sheets.sheet.comments = [{ id: "source-comment", ref: "A1", text: "Source comment", createdAt: 1, resolved: false }];
    initial.sheets.other.comments = [{ id: "destination-comment", ref: "A1", text: "Destination comment", createdAt: 1, resolved: false }];
    await mount();
    const clipboard = new Map<string, string>();
    const transfer = (type: "cut" | "paste") => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: {
        setData: (format: string, value: string) => clipboard.set(format, value),
        getData: (format: string) => clipboard.get(format) || "",
      } });
      element(".grid-scroll").dispatchEvent(event);
    };
    select("A1");
    transfer("cut");
    element<HTMLElement>('.tab[data-id="other"]').click();
    await frame();
    select("A1");
    transfer("paste");
    await frame();
    expect(cell("A1").querySelector(".cv")!.textContent).toBe("Destination");
    expect(cell("A1").querySelector(".cell-comment-tooltip")!.textContent).toBe("Destination comment");
    expect(element<HTMLButtonElement>('button[title="Undo (Ctrl+Z)"]').disabled).toBe(true);
    expect(element<HTMLButtonElement>('button[title="Redo (Ctrl+Y)"]').disabled).toBe(true);
    element<HTMLElement>('.tab[data-id="sheet"]').click();
    await frame();
    expect(cell("A1").querySelector(".cv")!.textContent).toBe("42");
    expect(cell("A1").querySelector(".cell-comment-tooltip")!.textContent).toBe("Source comment");
    const remote = structuredClone(initial);
    remote.sheets.sheet.name = "Data";
    peer(remote);
    element<HTMLElement>('.tab[data-id="other"]').click();
    await frame();
    select("A1");
    transfer("paste");
    await frame();
    expect(cell("A1").querySelector(".cv")!.textContent).toBe("42");
    expect(cell("A1").querySelector(".cell-comment-tooltip")!.textContent).toContain("Source comment");
    element<HTMLButtonElement>('button[title="Undo (Ctrl+Z)"]').click();
    await frame();
    expect(cell("A1").querySelector(".cv")!.textContent).toBe("Destination");
    expect(cell("A1").querySelector(".cell-comment-tooltip")!.textContent).toBe("Destination comment");
    element<HTMLButtonElement>('button[title="Redo (Ctrl+Y)"]').click();
    await frame();
    expect(cell("A1").querySelector(".cv")!.textContent).toBe("42");
  });

  it("fills only initially visible rows and preserves hidden records through undo and redo", async () => {
    for (const [ref, value] of Object.entries({ A2: "keep", A3: "drop", A4: "keep", A5: '=IF(B4="old","drop","keep")', A6: "keep",
      B2: "new", B3: "preserve", B4: "old", B5: "Also hidden", B6: "Last old" })) {
      initial.cells.sheet[ref] = { value, fmt: null, version: 1 };
    }
    initial.sheets.sheet.filter = { ...filter({ 0: ["s:keep"] }), endRow: 5, rowOrder: [1, 2, 3, 4, 5] };
    await mount();
    select("B2");
    const handle = element(".fill-handle");
    pointer(handle, "pointerdown", 0, 0);
    subscriber.operation({ type: "operation", senderId: "peer", revision: 1, deletes: [], replacedSheets: [], lastModified: 1,
      structure: { title: initial.title, sheetOrder: initial.sheetOrder, sheets: structuredClone(initial.sheets) },
      upserts: [{ sheetId: "sheet", ref: "C1", cell: { value: "Peer change", fmt: null, version: 1 } }],
    });
    // jsdom has no hit testing; the actual pointer handlers receive the visible destination.
    const hitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => cell("B6") });
    try {
      pointer(handle, "pointermove", 0, 0);
      pointer(handle, "pointerup", 0, 0);
    } finally {
      if (hitTest) Object.defineProperty(document, "elementFromPoint", hitTest);
      else Reflect.deleteProperty(document, "elementFromPoint");
    }
    await frame();
    expect(["B2", "B3", "B4", "B5", "B6"].map(ref => cell(ref).textContent)).toEqual(["new", "preserve", "new", "Also hidden", "new"]);
    const grid = element(".grid-scroll");
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    await frame();
    expect(["B2", "B3", "B4", "B5", "B6"].map(ref => cell(ref).textContent)).toEqual(["new", "preserve", "old", "Also hidden", "Last old"]);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true, cancelable: true }));
    await frame();
    expect(["B2", "B3", "B4", "B5", "B6"].map(ref => cell(ref).textContent)).toEqual(["new", "preserve", "new", "Also hidden", "new"]);
  });

  it("keeps an unchecked pivot group excluded when selected criteria contain a removed source value", async () => {
    for (const [ref, value] of Object.entries({ A2: "East", A3: "West", A4: "South", B2: "10", B3: "20", B4: "30" })) {
      initial.cells.sheet[ref] = { value, fmt: null, version: 1 };
    }
    initial.sheets.other.pivot = { sourceSheetId: "sheet", sourceRange: "A1:B4", rowField: "Kind", columnField: "", valueField: "Sales",
      aggregate: "sum", showRowTotals: true, showColumnTotals: true, filterField: "Kind", filterValues: ["East", "North"] };
    await mount();
    [...document.querySelectorAll<HTMLButtonElement>(".sidebar-menu-item")].find(button => button.querySelector(".sidebar-menu-label")?.textContent === "Pivot tables")!.click();
    element<HTMLButtonElement>(".chart-list-item").click();
    expect(pivotOption("East").checked).toBe(true);
    expect(pivotOption("South").checked).toBe(false);
    pivotOption("West").click();
    await frame();
    expect(pivotOption("South").checked).toBe(false);
    expect([cell("A2").textContent, cell("A3").textContent]).toEqual(["East", "West"]);
    expect(cell("B4").textContent).toBe("30");
  });

  it.each(["click", "shift", "additive", "drag"] as const)("keeps full-column bounds and a visible typing target after a filtered header %s", async (mode) => {
    initial.sheets.sheet.rows = 4;
    for (const [ref, value] of Object.entries({ A2: "keep", A3: "keep", A4: "drop", B4: "preserve",
      C1: "Third", C2: "30", C3: "40", C4: "Also hidden", D1: "Fourth", D2: "50", D3: "60", D4: "Last hidden" })) {
      initial.cells.sheet[ref] = { value, fmt: null, version: 1 };
    }
    initial.sheets.sheet.filter = { ...filter({ 0: ["s:keep"] }), endRow: 3, rowOrder: [1, 2, 3] };
    await mount();
    const grid = element(".grid-scroll");
    pointer(element('th.colhead[data-col="1"]'), "mousedown", 0, 0);
    if (mode === "drag") pointer(element('th.colhead[data-col="2"]'), "mousemove", 0, 0);
    pointer(window, "mouseup", 0, 0);
    if (mode === "shift" || mode === "additive") {
      element(`th.colhead[data-col="${mode === "shift" ? 2 : 3}"]`).dispatchEvent(new MouseEvent("mousedown", {
        button: 0, shiftKey: mode === "shift", ctrlKey: mode === "additive", bubbles: true, cancelable: true,
      }));
      pointer(window, "mouseup", 0, 0);
    }
    const columns = mode === "click" ? [1] : mode === "additive" ? [1, 3] : [1, 2];
    const target = mode === "click" ? "B3" : mode === "additive" ? "D3" : "C3";
    const bounds = mode === "click" ? "B1:B4" : mode === "additive" ? "2 ranges" : "B1:C4";
    expect(element<HTMLInputElement>("input.namebox").value).toBe(bounds);
    expect([...document.querySelectorAll<HTMLElement>("th.colhead.full")].map(header => Number(header.dataset.col))).toEqual(columns);
    expect(element<HTMLTableCellElement>("td.cell.active").dataset.ref).toBe(target);
    expect(cell(target).parentElement!.style.display).toBe("");
    expect(cell("B4").parentElement!.style.display).toBe("none");
    expect(cell("B4").classList.contains("sel")).toBe(true);
    const clipboard = new Map<string, string>();
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData: (format: string, value: string) => clipboard.set(format, value) } });
    grid.dispatchEvent(copy);
    expect(clipboard.get("text/plain")).toBe(Array.from({ length: 4 }, (_, row) => columns
      .map(column => initial.cells.sheet[`${String.fromCharCode(65 + column)}${row + 1}`].value).join("\t")).join("\n"));
    key(grid, "x"); // no queued paint between selecting the header and beginning an edit
    expect(element<HTMLTextAreaElement>("textarea.cell-editor").value).toBe("x");
    expect(element<HTMLInputElement>("input.namebox").value).toBe(bounds);
    key(element("textarea.cell-editor"), "Enter");
    await frame();
    expect(cell(target).textContent).toBe("x");
    expect(["B4", "C4", "D4"].map(ref => cell(ref).textContent)).toEqual(["preserve", "Also hidden", "Last hidden"]);
  });

  it.each([true, false])("uses a visible full-column editing target with all data hidden=%s without changing unfiltered targets", async (allHidden) => {
    initial.sheets.sheet.rows = 4;
    initial.cells.sheet.B4 = { value: "preserve", fmt: null, version: 1 };
    initial.sheets.sheet.filter = allHidden ? { ...filter({ 0: ["x:__none__"] }), endRow: 3, rowOrder: [1, 2, 3] } : null;
    await mount();
    pointer(element('th.colhead[data-col="1"]'), "mousedown", 0, 0);
    pointer(window, "mouseup", 0, 0);
    const target = allHidden ? "B1" : "B4";
    expect(element<HTMLInputElement>("input.namebox").value).toBe("B1:B4");
    expect(element<HTMLTableCellElement>("td.cell.active").dataset.ref).toBe(target);
    expect(cell(target).parentElement!.style.display).toBe("");
    key(element(".grid-scroll"), "x");
    key(element("textarea.cell-editor"), "Enter");
    await frame();
    expect(cell(target).textContent).toBe("x");
    if (allHidden) expect(cell("B4").textContent).toBe("preserve");
  });

  it("retains full-column bounds across peer visibility changes and horizontal keyboard extension, then deletes only visible cells", async () => {
    initial.sheets.sheet.rows = 4;
    initial.cells.sheet.A2.value = "keep";
    initial.cells.sheet.A3.value = "keep";
    initial.cells.sheet.A4 = { value: "drop", fmt: null, version: 1 };
    initial.cells.sheet.B4 = { value: "preserve", fmt: null, version: 1 };
    initial.sheets.sheet.filter = { ...filter({ 0: ["s:keep"] }), endRow: 3, rowOrder: [1, 2, 3] };
    await mount();
    pointer(element('th.colhead[data-col="1"]'), "mousedown", 0, 0);
    pointer(window, "mouseup", 0, 0);
    subscriber.operation({ type: "operation", senderId: "peer", revision: 1, deletes: [], replacedSheets: [], lastModified: 1,
      structure: { title: initial.title, sheetOrder: initial.sheetOrder, sheets: structuredClone(initial.sheets) },
      upserts: [{ sheetId: "sheet", ref: "A3", cell: { value: "drop", fmt: null, version: 2 } }],
    });
    expect(element<HTMLTableCellElement>("td.cell.active").dataset.ref).toBe("B2");
    expect(element<HTMLInputElement>("input.namebox").value).toBe("B1:B4");
    const grid = element(".grid-scroll");
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true, cancelable: true }));
    expect(element<HTMLInputElement>("input.namebox").value).toBe("A1:B4");
    key(grid, "Delete");
    await frame();
    expect(["A1", "A2", "B1", "B2"].map(ref => cell(ref).textContent)).toEqual(["", "", "", ""]);
    expect(["A3", "B3", "A4", "B4"].map(ref => cell(ref).textContent)).toEqual(["drop", "20", "drop", "preserve"]);
    expect(element<HTMLInputElement>("input.namebox").value).toBe("A1:B4");
    expect(element<HTMLTableCellElement>("td.cell.active").dataset.ref).toBe("A1");
  });

  it("clears only visible selected records and preserves hidden data through undo and redo", async () => {
    initial.cells.sheet.A2.value = "keep";
    initial.cells.sheet.A3.value = "drop";
    initial.cells.sheet.A4 = { value: "keep", fmt: null, version: 1 };
    initial.sheets.sheet.filter = { ...filter({ 0: ["s:keep"] }), endRow: 3, rowOrder: [1, 2, 3] };
    await mount();
    select("A2");
    const grid = element(".grid-scroll");
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true }));
    expect(element<HTMLInputElement>("input.namebox").value).toBe("A2:A4");
    key(grid, "Delete");
    await frame();
    expect(["A2", "A3", "A4"].map(ref => cell(ref).textContent)).toEqual(["", "drop", ""]);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    await frame();
    expect(["A2", "A3", "A4"].map(ref => cell(ref).textContent)).toEqual(["keep", "drop", "keep"]);
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true, cancelable: true }));
    await frame();
    expect(["A2", "A3", "A4"].map(ref => cell(ref).textContent)).toEqual(["", "drop", ""]);
  });

  it("resolves filtered selection visibility before clearing its formula dependencies", async () => {
    initial.cells.sheet.A2.value = "keep";
    initial.cells.sheet.A3.value = "Hidden record";
    initial.cells.sheet.A4 = { value: "keep", fmt: null, version: 1 };
    initial.cells.sheet.B2.value = "keep";
    initial.cells.sheet.B3.value = '=IF(A2="keep","drop","keep")';
    initial.cells.sheet.B4 = { value: "keep", fmt: null, version: 1 };
    initial.sheets.sheet.filter = { ...filter({ 1: ["s:keep"] }), endRow: 3, rowOrder: [1, 2, 3] };
    await mount();
    select("A2");
    const grid = element(".grid-scroll");
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true }));
    expect(cell("A3").parentElement!.style.display).toBe("none");
    // The peer update invalidates formula caches; Delete can arrive before the queued paint.
    subscriber.operation({ type: "operation", senderId: "peer", revision: 1, deletes: [], replacedSheets: [], lastModified: 1,
      structure: { title: initial.title, sheetOrder: initial.sheetOrder, sheets: structuredClone(initial.sheets) },
      upserts: [{ sheetId: "sheet", ref: "C1", cell: { value: "Peer change", fmt: null, version: 1 } }],
    });
    key(grid, "Delete");
    await frame();
    expect(["A2", "A3", "A4"].map(ref => cell(ref).textContent)).toEqual(["", "Hidden record", ""]);
    expect(cell("B3").textContent).toBe("keep");
    expect(cell("A3").parentElement!.style.display).toBe("");
  });

  it("retargets Delete synchronously when a peer filter hides the active cell", async () => {
    await mount();
    select("A2");
    const remote = structuredClone(initial);
    remote.sheets.sheet.filter = filter({ 0: ["s:keep"] });
    peer(remote);
    expect(element<HTMLInputElement>("input.namebox").value).toBe("A3");
    key(element(".grid-scroll"), "Delete"); // before the queued grid paint
    await frame();
    expect(cell("A2").textContent).toBe("drop");
    expect(cell("A3").textContent).toBe("");
    expect(cell("A2").parentElement!.style.display).toBe("none");
    expect(element<HTMLInputElement>("input.namebox").value).toBe("A4");
  });

  it("reconciles visibility after a peer changes a filtered cell's value", async () => {
    initial.sheets.sheet.filter = filter({ 0: ["s:keep"] });
    await mount();
    select("A3");
    subscriber.operation({ type: "operation", senderId: "peer", revision: 1, deletes: [], replacedSheets: [], lastModified: 1,
      structure: { title: initial.title, sheetOrder: initial.sheetOrder, sheets: structuredClone(initial.sheets) },
      upserts: [{ sheetId: "sheet", ref: "A3", cell: { value: "drop", fmt: null, version: 2 } }],
    });
    expect(element<HTMLInputElement>("input.namebox").value).toBe("A4");
    key(element(".grid-scroll"), "Delete");
    await frame();
    expect(cell("A3").textContent).toBe("drop");
  });

  it("moves to the visible header when a refreshed snapshot hides all data rows", async () => {
    await mount();
    select("A3");
    const remote = structuredClone(initial);
    remote.sheets.sheet.filter = { ...filter({ 0: ["x:__none__"] }), endRow: 7, rowOrder: [1, 2, 3, 4, 5, 6, 7] };
    subscriber.operation({ type: "snapshot", document: remote });
    expect(element<HTMLInputElement>("input.namebox").value).toBe("A1");
    await frame();
    expect(cell("A1").parentElement!.style.display).toBe("");
    expect(cell("A2").textContent).toBe("drop");
    expect(cell("A3").textContent).toBe("keep");
  });

  it("reconciles a local filter application before another keystroke", async () => {
    initial.sheets.sheet.filter = filter();
    await mount();
    select("A2");
    element<HTMLButtonElement>('td.cell[data-ref="A1"] button').click();
    const options = [...document.querySelectorAll<HTMLLabelElement>(".filter-option")];
    const drop = options.find(option => option.textContent === "drop")!;
    drop.querySelector<HTMLInputElement>("input")!.checked = false;
    [...document.querySelectorAll<HTMLButtonElement>(".filter-actions button")].find(button => button.textContent === "Apply")!.click();
    expect(element<HTMLInputElement>("input.namebox").value).toBe("A3");
    key(element(".grid-scroll"), "Delete");
    await frame();
    expect(cell("A2").textContent).toBe("drop");
    expect(cell("A3").textContent).toBe("");
  });

  it("cancels an edit hidden by a peer filter rather than committing it invisibly", async () => {
    await mount();
    select("A2");
    key(element(".grid-scroll"), "F2");
    const editor = element<HTMLTextAreaElement>("textarea.cell-editor");
    editor.value = "Uncommitted hidden edit";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    const remote = structuredClone(initial);
    remote.sheets.sheet.filter = filter({ 0: ["s:keep"] });
    peer(remote);
    key(element(".grid-scroll"), "Delete");
    await frame();
    expect(cell("A2").textContent).toBe("drop");
    expect(cell("A3").textContent).toBe("");
  });

  it("commits a drag to the live chart while preserving peer edits", async () => {
    await mount();
    startDrag();
    const remote = structuredClone(initial);
    remote.sheets.sheet.charts![0].title = "Peer title";
    remote.sheets.sheet.charts![0].legend = false;
    remote.sheets.sheet.comments = [{ id: "peer-comment", ref: "A3", text: "Peer comment", createdAt: 1, resolved: false }];
    peer(remote);
    await frame();
    pointer(window, "pointermove", 220, 150);
    pointer(window, "pointerup", 220, 150);
    expect(element<HTMLElement>(".chart-card").style.left).toBe("216px");
    expect(element<HTMLElement>(".chart-card").style.top).toBe("94px");
    expect(element(".chart-card-head strong").textContent).toBe("Peer title");
    expect(cell("A3").querySelector(".cell-comment-tooltip")!.textContent).toBe("Peer comment");
  });

  it("does not resurrect a chart deleted by a peer during its drag", async () => {
    await mount();
    startDrag();
    const remote = structuredClone(initial);
    remote.sheets.sheet.charts = [];
    peer(remote);
    await frame();
    pointer(window, "pointerup", 200, 140);
    expect(document.querySelector(".chart-card")).toBeNull();
  });

  it("does not apply a drag to a same-id chart on the newly active sheet", async () => {
    await mount();
    startDrag();
    element<HTMLElement>('.tab[data-id="other"]').click();
    await frame();
    pointer(window, "pointerup", 200, 140);
    expect(element<HTMLElement>(".chart-card").style.left).toBe("300px");
    expect(element<HTMLElement>(".chart-card").style.top).toBe("120px");
    expect(element(".chart-card-head strong").textContent).toBe("Other chart");
  });

  it("treats hyperlink labels as text without discarding links returned by IF", async () => {
    await mount();
    expect(cell("D2").textContent).toBe("Complete");
    expect(cell("D3").textContent).toBe("TRUE");
    expect(cell("D4").textContent).toBe("FALSE");
    expect(cell("D5").querySelector("a")!.href).toBe("https://example.com/");
    expect(cell("D6").textContent).toBe("TRUE");
    expect(cell("D7").textContent).toBe("TRUE");
    expect(cell("D8").textContent).toBe("");
  });
});
