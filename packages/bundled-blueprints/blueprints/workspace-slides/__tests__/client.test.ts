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
const gadget = {
  subscribe: vi.fn(async () => {}),
  getDeck: vi.fn(async () => structuredClone(deck)),
  getUndoState: vi.fn(async () => ({ canUndo: false, canRedo: false })),
  getBrandAssets: vi.fn(async () => ({ coverOrange: "" })),
  getAsset: vi.fn(async (ref: string) => (ref === "asset:abc" ? IMAGE : null)),
  missingSvgRasters: vi.fn(async () => []),
  updateBlock: vi.fn(async () => true),
  updateBlocks: vi.fn(async () => true),
  addBlock: vi.fn(async () => "n1"),
  reorderBlock: vi.fn(async () => true),
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
