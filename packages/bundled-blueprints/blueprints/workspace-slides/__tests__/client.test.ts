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

describe("in-place text", () => {
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
});
