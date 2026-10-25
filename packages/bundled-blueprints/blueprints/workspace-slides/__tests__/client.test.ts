// The editor's commands, driven the way a person drives them. client.ts is a gadget entry with
// top-level effects, so it is loaded once against a fake `gadget` stub and driven through the DOM.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deck, GadgetStub } from "../files/lib/protocol.ts";

const IMAGE = `data:image/png;base64,${"A".repeat(4000)}`;
const deck: Deck = {
  rev: 1, logo: null,
  slides: [{
    id: "s1", background: { color: "#FFFFFF" },
    blocks: [
      { id: "t1", type: "text", x: 36, y: 204, w: 760, props: { text: "old" } },
      { id: "l1", type: "bulletList", x: 36, y: 300, w: 500, props: { text: "one\ntwo" } },
      { id: "i1", type: "image", x: 800, y: 100, w: 200, h: 100, props: { src: "asset:abc" } },
      { id: "h1", type: "title", x: 36, y: 500, w: 700, props: { text: "My title", highlight: "title" } },
    ],
  }],
};
// The subscriber the client hands the server, which the server calls with each broadcast.
let subscriber: { deckPatched: (patch: unknown, meta: unknown) => void };
const gadget = {
  subscribe: vi.fn(async (s: typeof subscriber) => { subscriber = s; }),
  getDeck: vi.fn(async () => structuredClone(deck)),
  getUndoState: vi.fn(async () => ({ canUndo: false, canRedo: false })),
  getBrandAssets: vi.fn(async () => ({ coverOrange: "" })),
  getAsset: vi.fn(async (ref: string) => (ref === "asset:abc" ? IMAGE : null)),
  missingSvgRasters: vi.fn(async () => []),
  updateBlock: vi.fn(async () => true),
  updateBlocks: vi.fn(async () => true),
  addBlock: vi.fn(async () => "n1"),
  reorderBlock: vi.fn(async () => true),
  removeBlock: vi.fn(async () => true),
  undo: vi.fn(async () => true),
};

beforeAll(async () => {
  Object.assign(globalThis, {
    gadget: gadget as unknown as Partial<GadgetStub>,
    RpcTarget: class {},
    matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    CSS: { escape: (v: string) => v, supports: () => false },
  });
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {} }) as unknown as Animation;
  // jsdom has no editing (`contentEditable` is a plain property there) and no `innerText`.
  Object.defineProperties(HTMLElement.prototype, {
    isContentEditable: { get(this: HTMLElement) { return ["true", "plaintext-only"].includes(this.contentEditable); } },
    innerText: { get(this: HTMLElement) { return this.textContent; } },
  });
  const entry = "../files/client.ts";
  await import(/* @vite-ignore */ entry);
  button("Edit slides").click();
});

beforeEach(() => vi.clearAllMocks());

const settle = () => new Promise((r) => setTimeout(r, 20));
const button = (label: string) => {
  const found = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label);
  if (!found) throw new Error(`No "${label}" button`);
  return found;
};
const onStage = (id: string) => document.querySelector<HTMLElement>(`.stage-wrap [data-block-id="${id}"]`)!;
async function select(id: string) {
  onStage(id).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
  await settle();
}
// Types into an in-place field, leaving it focused (as clicking a floating-bar button does).
function type(field: HTMLElement, text: string) {
  field.tabIndex = 0;
  field.focus();
  field.textContent = text;
}
const calls = (...mocks: Array<ReturnType<typeof vi.fn>>) =>
  mocks.flatMap((m) => m.mock.calls.map((args, i) => ({ order: m.mock.invocationCallOrder[i], args }))).toSorted((a, b) => a.order - b.order).map((c) => c.args);

describe("in-place edits are saved before a command acts on the block", () => {
  it("Duplicate copies the text being typed", async () => {
    await select("t1");
    type(onStage("t1").querySelector<HTMLElement>(".inline-edit")!, "new");
    button("Duplicate").click();
    await settle();
    expect(calls(gadget.updateBlock, gadget.addBlock)).toEqual([
      ["s1", "t1", { props: { text: "new" } }],
      ["s1", expect.objectContaining({ type: "text", props: expect.objectContaining({ text: "new" }) })],
    ]);
  });

  it("Duplicate copies the text being typed in Format", async () => {
    await select("t1");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    const field = document.querySelector<HTMLTextAreaElement>(".insp-scroll textarea")!;
    field.focus();
    field.value = "from format";
    button("Duplicate").click();
    await settle();
    expect(calls(gadget.updateBlock, gadget.addBlock)).toEqual([
      ["s1", "t1", { props: { text: "from format" } }],
      ["s1", expect.objectContaining({ type: "text", props: expect.objectContaining({ text: "from format" }) })],
    ]);
  });

  it("Bring forward saves the text being typed", async () => {
    await select("t1");
    type(onStage("t1").querySelector<HTMLElement>(".inline-edit")!, "newer");
    button("Bring forward").click();
    await settle();
    expect(calls(gadget.updateBlock, gadget.reorderBlock)).toEqual([
      ["s1", "t1", { props: { text: "newer" } }],
      ["s1", "t1", expect.any(Number)],
    ]);
  });

  it("a quick action on a bullet list saves the list's text first, so undo takes the formatting off first", async () => {
    await select("l1");
    type(onStage("l1").querySelector<HTMLElement>(".inline-edit")!, "uno");
    const compact = [...document.querySelectorAll("button")].find((b) => /compact/i.test(b.getAttribute("aria-label") ?? ""))!;
    compact.click();
    await settle();
    expect(calls(gadget.updateBlock)).toEqual([
      ["s1", "l1", { props: { text: "uno\ntwo" } }],
      ["s1", "l1", { props: { treatment: "compact" } }],
    ]);
  });
});

it("copied media is pasted as its data, so it survives the source's asset being deleted", async () => {
  await select("i1");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", metaKey: true, ctrlKey: true, bubbles: true }));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "v", metaKey: true, ctrlKey: true, bubbles: true }));
  await settle();
  expect(gadget.addBlock).toHaveBeenCalledWith("s1", expect.objectContaining({ type: "image", props: expect.objectContaining({ src: IMAGE }) }));
});

it("a slow bullet-list save doesn't redraw over text being typed in another block", async () => {
  let reply!: (ok: boolean) => void;
  gadget.updateBlock.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
  await select("l1");
  const row = onStage("l1").querySelector<HTMLElement>(".inline-edit")!;
  type(row, "late");
  row.blur();
  await settle();
  expect(gadget.updateBlock).toHaveBeenCalledWith("s1", "l1", { props: { text: "late\ntwo" } });
  await select("t1");
  const field = onStage("t1").querySelector<HTMLElement>(".inline-edit")!;
  type(field, "typing");
  reply(true);
  await settle();
  expect(field.isConnected).toBe(true);
  expect(field.textContent).toBe("typing");
  field.blur();
});

it("menu rows work from the keyboard, and their keys don't reach the slide", async () => {
  const more = button("More");
  more.click();
  const rows = [...document.querySelectorAll<HTMLElement>(".pop:not(.closing) .mi")];
  expect(rows.length).toBeGreaterThan(1);
  expect(document.activeElement).toBe(rows[0]);
  const key = (k: string) => {
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(e);
    return e;
  };
  expect(key("ArrowDown").defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(rows[1]);
  key("End");
  expect(document.activeElement).toBe(rows.at(-1));
  key("Escape");
  expect(document.querySelector(".pop:not(.closing)")).toBeNull();
  expect(document.activeElement).toBe(more);
});

// Enter on a selected block opens Format, but a focused toolbar button keeps its own Enter.
it("leaves Enter to a focused toolbar button while a block is selected", async () => {
  await select("t1");
  const more = button("More");
  more.focus();
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  more.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(more);
});

describe("in-place text", () => {
  // Typing resumed in the original while Duplicate is waiting on the server is saved, not dropped.
  it("saves text typed while a duplicate is being made", async () => {
    await select("t1");
    let reply!: () => void;
    gadget.addBlock.mockImplementationOnce(() => new Promise((resolve) => { reply = () => resolve("n2"); }));
    button("Duplicate").click();
    await vi.waitFor(() => expect(reply).toBeDefined());
    const field = onStage("t1").querySelector<HTMLElement>(".inline-edit")!;
    type(field, "typed meanwhile");
    reply();
    await settle();
    expect(gadget.updateBlock).toHaveBeenCalledWith("s1", "t1", { props: { text: "typed meanwhile" } });
  });

  // A number set back to where it started is a change of its own.
  it("saves a Format number changed back to its first value", async () => {
    await select("t1");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    document.querySelector<HTMLButtonElement>(".adv-toggle")!.click();
    const x = document.querySelector<HTMLInputElement>('input[data-key="pos-x"]')!;
    for (const v of ["37", "36"]) { x.value = v; x.dispatchEvent(new Event("change")); }
    expect(calls(gadget.updateBlock)).toEqual([["s1", "t1", { x: 37 }], ["s1", "t1", { x: 36 }]]);
    await settle();
    document.querySelector<HTMLButtonElement>(".adv-toggle")!.click();
  });

  it("saves the text being typed on Ctrl+S", async () => {
    await select("t1");
    const field = onStage("t1").querySelector<HTMLElement>(".inline-edit")!;
    type(field, "saved now");
    const key = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    field.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    await settle();
    expect(gadget.updateBlock).toHaveBeenCalledWith("s1", "t1", { props: { text: "saved now" } });
  });

  // A second drop while the first reconnect is still loading: live updates must resume.
  it("subscribes again when dropped during a reconnect", async () => {
    let deliver!: () => void;
    gadget.getDeck.mockImplementationOnce(() => new Promise((resolve) => { deliver = () => resolve(structuredClone(deck)); }));
    (subscriber as unknown as Disposable)[Symbol.dispose]();
    await vi.waitFor(() => expect(deliver).toBeDefined());
    expect(gadget.subscribe).toHaveBeenCalledTimes(1);
    (subscriber as unknown as Disposable)[Symbol.dispose]();
    deliver();
    await vi.waitFor(() => expect(gadget.subscribe).toHaveBeenCalledTimes(2));
    await settle();
  });

  // A reconnect brings a fresh snapshot; the text being typed stays, and is saved on blur.
  it("keeps the text being typed through a reconnect", async () => {
    await select("t1");
    const field = onStage("t1").querySelector<HTMLElement>(".inline-edit")!;
    type(field, "draft");
    (subscriber as unknown as Disposable)[Symbol.dispose]();
    await vi.waitFor(() => expect(gadget.getDeck).toHaveBeenCalled());
    await settle();
    expect(field.isConnected).toBe(true);
    field.blur();
    await settle();
    expect(gadget.updateBlock).toHaveBeenCalledWith("s1", "t1", { props: { text: "draft" } });
  });

  // A Format field's save finishing while slide text is being typed redraws around the field.
  it("keeps a field being typed in when a Format save finishes", async () => {
    await select("t1");
    let reply!: () => void;
    gadget.updateBlock.mockImplementationOnce(() => new Promise((resolve) => { reply = () => resolve(true); }));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    const advanced = () => document.querySelector<HTMLButtonElement>(".adv-toggle")!;
    advanced().click();
    const x = document.querySelector<HTMLInputElement>('input[data-key="pos-x"]')!;
    x.value = "50";
    x.dispatchEvent(new Event("change"));
    expect(gadget.updateBlock).toHaveBeenCalledWith("s1", "t1", { x: 50 });
    const field = onStage("t1").querySelector<HTMLElement>(".inline-edit")!;
    type(field, "typing");
    reply();
    await settle();
    expect(field.isConnected).toBe(true);
    expect(document.activeElement).toBe(field);
    field.blur();
    await settle();
    advanced().click();
  });

  // Pasted lines become list items, rather than one item with the lines run together.
  it("splits lines pasted into a bullet row into items", async () => {
    await select("l1");
    const row = onStage("l1").querySelectorAll<HTMLElement>(".inline-edit")[0]!;
    row.tabIndex = 0;
    row.focus();
    const range = document.createRange();
    range.setStart(row.firstChild!, 3);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const paste = Object.assign(new Event("beforeinput", { bubbles: true, cancelable: true }), {
      inputType: "insertFromPaste", data: null, isComposing: false,
      dataTransfer: { getData: (type: string) => (type === "text/plain" ? " A\r\nB" : "") },
    });
    row.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    (document.activeElement as HTMLElement).blur();
    await settle();
    expect(gadget.updateBlock).toHaveBeenCalledWith("s1", "l1", { props: { text: "one A\nB\ntwo" } });
  });

  // Chromium inserts pasted lines as <div>s; a highlighted title must keep them as lines.
  it("keeps the lines of text pasted into a highlighted title", async () => {
    await select("h1");
    const field = onStage("h1").querySelector<HTMLElement>(".inline-edit")!;
    expect(field.querySelector("span")).not.toBeNull();
    field.tabIndex = 0;
    field.focus();
    const range = document.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const paste = Object.assign(new Event("beforeinput", { bubbles: true, cancelable: true }), {
      inputType: "insertFromPaste", data: null, isComposing: false,
      dataTransfer: { getData: (type: string) => (type === "text/plain" ? "\r\nsecond line" : "") },
    });
    field.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    field.blur();
    await settle();
    expect(gadget.updateBlock).toHaveBeenCalledWith("s1", "h1", { props: { text: "My title\nsecond line" } });
  });

  // A field stays up through a save while another field is being edited; typing its text back
  // to what it was before that save is a change of its own.
  it("saves a field changed back after a save it outlived", async () => {
    await select("t1");
    const field = onStage("t1").querySelector<HTMLElement>(".inline-edit")!;
    const before = field.textContent!;
    const other = Object.assign(document.createElement("div"), { contentEditable: "true", tabIndex: 0 });
    onStage("t1").parentElement!.appendChild(other);
    type(field, "changed");
    other.focus();
    await settle();
    expect(onStage("t1").querySelector(".inline-edit")).toBe(field);
    type(field, before);
    other.focus();
    await settle();
    other.remove();
    expect(gadget.updateBlock.mock.calls).toEqual([
      ["s1", "t1", { props: { text: "changed" } }],
      ["s1", "t1", { props: { text: before } }],
    ]);
  });

  // Enter confirming an input method's candidate is the IME's, not a command to finish editing.
  it("leaves Enter to an input method that is composing", async () => {
    await select("t1");
    const field = onStage("t1").querySelector<HTMLElement>(".inline-edit")!;
    type(field, "日本");
    const enter = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
    field.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(field);
    expect(gadget.updateBlock).not.toHaveBeenCalled();
  });

  it("Delete saves the text being typed first, so undo brings it back", async () => {
    await select("t1");
    type(onStage("t1").querySelector<HTMLElement>(".inline-edit")!, "typed");
    button("Delete").click();
    await settle();
    expect(calls(gadget.updateBlock, gadget.removeBlock)).toEqual([
      ["s1", "t1", { props: { text: "typed" } }],
      ["s1", "t1"],
    ]);
  });
});

describe("edits racing the server's broadcasts", () => {
  let rev = 1;
  // The server's broadcast of the slide as `blocks` (fresh objects, as a real patch brings).
  const broadcast = async (blocks: Deck["slides"][number]["blocks"]) => {
    subscriber.deckPatched({ rev: rev + 1, base: rev, slides: { s1: { ...structuredClone(deck.slides[0]!), blocks: structuredClone(blocks) } } }, { canUndo: true, canRedo: false });
    rev++;
    await settle();
  };
  const press = (key: string) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  const nudgeSaved = () => new Promise((r) => setTimeout(r, 450));

  // A broadcast of an earlier nudge save, arriving after more presses, must not be where the next
  // press starts from.
  it("keeps nudges made while an earlier nudge's broadcast was on its way", async () => {
    await broadcast(deck.slides[0]!.blocks);
    await select("i1");
    press("ArrowRight");
    await nudgeSaved();
    expect(gadget.updateBlocks).toHaveBeenLastCalledWith("s1", [{ id: "i1", patch: { x: 801, y: 100 } }]);
    press("ArrowRight");
    await broadcast(deck.slides[0]!.blocks.map((b) => b.id === "i1" ? { ...b, x: 801 } : b));
    press("ArrowRight");
    await nudgeSaved();
    expect(gadget.updateBlocks).toHaveBeenLastCalledWith("s1", [{ id: "i1", patch: { x: 803, y: 100 } }]);
  });

  // Undo right after a nudge restores the block: its broadcast is the server's word, not the
  // position the nudge gave the block.
  it("lets an undo right after a nudge put the block back", async () => {
    await broadcast(deck.slides[0]!.blocks);
    await select("i1");
    // The server broadcasts each change before it replies.
    let replyToNudge!: () => void;
    gadget.updateBlocks.mockImplementationOnce(() => new Promise((resolve) => { replyToNudge = () => resolve(true); }));
    press("ArrowRight");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
    await settle();
    expect(gadget.undo).toHaveBeenCalled();
    await broadcast(deck.slides[0]!.blocks.map((b) => b.id === "i1" ? { ...b, x: 801 } : b));
    await broadcast(deck.slides[0]!.blocks);
    replyToNudge();
    await settle();
    press("ArrowRight");
    await nudgeSaved();
    expect(gadget.updateBlocks).toHaveBeenLastCalledWith("s1", [{ id: "i1", patch: { x: 801, y: 100 } }]);
  });

  // The editor outlives a broadcast that replaces its block; Duplicate must copy what was typed.
  it("Duplicate copies text typed into an editor that outlived a broadcast", async () => {
    await broadcast(deck.slides[0]!.blocks);
    await select("t1");
    type(onStage("t1").querySelector<HTMLElement>(".inline-edit")!, "draft");
    await broadcast(deck.slides[0]!.blocks);
    button("Duplicate").click();
    await settle();
    expect(gadget.addBlock).toHaveBeenCalledWith("s1", expect.objectContaining({ props: expect.objectContaining({ text: "draft" }) }));
  });

  // A Format field that outlives a broadcast edits the deck's block, not the one it was drawn for.
  it("Duplicate copies a position typed into a Format field that outlived a broadcast", async () => {
    await broadcast(deck.slides[0]!.blocks);
    await select("t1");
    press("Enter");
    await settle();
    const advanced = () => document.querySelector<HTMLButtonElement>(".adv-toggle")!;
    advanced().click();
    const x = document.querySelector<HTMLInputElement>('input[data-key="pos-x"]')!;
    x.focus();
    x.value = "101";
    x.dispatchEvent(new Event("change", { bubbles: true }));
    await broadcast(deck.slides[0]!.blocks.map((b) => b.id === "t1" ? { ...b, x: 101 } : b));
    expect(document.activeElement).toBe(x);
    x.value = "102";
    x.dispatchEvent(new Event("change", { bubbles: true }));
    button("Duplicate").click();
    await settle();
    expect(gadget.addBlock).toHaveBeenCalledWith("s1", expect.objectContaining({ x: 126 }));
    advanced().click();
  });

  // Splitting a bullet row is undone by ⌘Z (the browser's undo can't follow it).
  it("undoes and redoes a bullet row split", async () => {
    await broadcast(deck.slides[0]!.blocks);
    await select("l1");
    const rows = () => [...onStage("l1").querySelectorAll<HTMLElement>(".inline-edit")];
    const first = rows()[0]!;
    first.tabIndex = 0;
    first.focus();
    const range = document.createRange();
    range.setStart(first.firstChild!, 1);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(rows().map((r) => r.textContent)).toEqual(["o", "ne", "two"]);
    const undo = (shiftKey = false) => (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey, bubbles: true, cancelable: true }));
    undo();
    expect(rows().map((r) => r.textContent)).toEqual(["one", "two"]);
    undo(true);
    expect(rows().map((r) => r.textContent)).toEqual(["o", "ne", "two"]);
    (document.activeElement as HTMLElement).blur();
    await settle();
  });

  // The asset sweep may delete the raster of artwork gone from the deck and its history: when the
  // artwork comes back, the server is asked again whether it has one.
  it("asks about an SVG's raster again when the artwork returns", async () => {
    const svg = { id: "v1", type: "svg", x: 0, y: 0, w: 100, h: 100, props: { markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' } };
    const rasterPass = () => new Promise((r) => setTimeout(r, 1700));
    await broadcast([...deck.slides[0]!.blocks, svg]);
    await vi.waitFor(() => expect(gadget.missingSvgRasters).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await broadcast(deck.slides[0]!.blocks);
    await rasterPass();
    await broadcast([...deck.slides[0]!.blocks, svg]);
    await vi.waitFor(() => expect(gadget.missingSvgRasters).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await broadcast(deck.slides[0]!.blocks);
  }, 10_000);
});
