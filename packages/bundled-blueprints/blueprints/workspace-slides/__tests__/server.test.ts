// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gadget } from "../files/server.ts";
import { BOTTOM_BAR_SVG } from "../files/lib/layouts.ts";
import type { Block, Deck, DeckCallbacks, DeckPatch, LegacyDeckCallbacks, Slide, UndoState } from "../files/lib/protocol.ts";

// The Slides Durable Object over in-memory storage. A real instance, since the class keeps private
// methods, over a state holding only the storage calls the gadget makes; the `cloudflare:workers`
// stub vitest.config.ts aliases in accepts it, where the runtime's base would refuse a state that
// is not a real DurableObjectState.
class MemoryStorage {
  readonly data = new Map<string, unknown>();
  async get(key: string | string[]): Promise<unknown> {
    if (Array.isArray(key)) return new Map(key.filter((k) => this.data.has(k)).map((k) => [k, this.copy(this.data.get(k))]));
    return this.copy(this.data.get(key));
  }
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof key === "string" ? [[key, value] as const] : Object.entries(key);
    for (const [k, v] of entries) this.data.set(k, this.copy(v));
  }
  async delete(key: string | string[]): Promise<void> {
    for (const k of Array.isArray(key) ? key : [key]) this.data.delete(k);
  }
  async deleteAll(): Promise<void> {
    this.data.clear();
  }
  async list({ prefix = "", startAfter, limit = Infinity }: { prefix?: string; startAfter?: string; limit?: number } = {}): Promise<Map<string, unknown>> {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix) && (startAfter === undefined || k > startAfter)).toSorted();
    return new Map(keys.slice(0, limit).map((k) => [k, this.copy(this.data.get(k))]));
  }
  // Storage hands out copies, as the runtime's structured clone does.
  copy(v: unknown): unknown {
    return v === undefined ? undefined : structuredClone(v);
  }
}

// A gadget over `storage`, loaded: the constructor's blockConcurrencyWhile is awaited, as the
// runtime would before delivering the first call.
async function loadGadget(storage = new MemoryStorage()): Promise<{ gadget: Gadget; storage: MemoryStorage }> {
  let loading: Promise<unknown> = Promise.resolve();
  const state = {
    storage,
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => (loading = fn()),
  } as unknown as DurableObjectState;
  const gadget = new Gadget(state, {});
  await loading;
  return { gadget, storage };
}

async function withLegacyDeck(deck: unknown) {
  const storage = new MemoryStorage();
  storage.data.set("deck", deck);
  return loadGadget(storage);
}

// A subscriber as the RPC layer delivers one: dup()/onRpcBroken() plus the callbacks. Like an RPC
// stub it answers to both callbacks; `decks` records what a tab of the previous client is sent.
function recorder() {
  const patches: Array<{ patch: DeckPatch; meta: UndoState }> = [];
  const decks: Array<{ deck: Deck; meta: UndoState }> = [];
  const stub = {
    deckPatched(patch: DeckPatch, meta: UndoState) { patches.push({ patch, meta }); },
    deckChanged(deck: Deck, meta: UndoState) { decks.push({ deck, meta }); },
    dup() { return stub; },
    onRpcBroken() {},
    [Symbol.dispose]() {},
  };
  return { patches, decks, stub: stub as DeckCallbacks & LegacyDeckCallbacks };
}

// The whole storage of a gadget made from the previous Slides blueprint, captured from that
// blueprint's build after editing through its UI and its agent API: its seed deck, every block type
// it had (the Gadgets mark included), an image big enough to become an asset, SVG artwork, and
// every background option. It holds one key, "deck".
const workspace1Storage = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/workspace1-storage.json"), "utf8")) as Record<string, unknown>;

// A raster key: the first 16 bytes of the source's SHA-256, as hex.
async function sha(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The start of a PNG of the given size: as far as the header.
function pngHeader(w: number, h: number): string {
  const b = new Uint8Array(24);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return "data:image/png;base64," + Buffer.from(b).toString("base64");
}
const PNG_1x1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const bigImage = () => PNG_1x1 + "A".repeat(4096);

describe("seeding", () => {
  it("starts a new deck with the cover slide, with no logo", async () => {
    const { gadget, storage } = await loadGadget();
    const deck = await gadget.getDeck();
    expect(deck.themeVersion).toBe("workspace.2");
    expect(deck.slides).toHaveLength(1);
    const [cover] = deck.slides;
    expect(cover!.background).toEqual({ color: "#F6821F", inset: false, coverOrange: true });
    expect(cover!.blocks.map((b) => b.type)).toEqual(["title"]);
    expect(storage.data.get("meta")).toMatchObject({ v: 2, order: [cover!.id], rev: 0 });
    expect(storage.data.has(`s:${cover!.id}`)).toBe(true);
  });

  it("serves the cover artwork from the server", async () => {
    const { gadget } = await loadGadget();
    expect((await gadget.getBrandAssets()).coverOrange).toMatch(/^data:image\/png;base64,/);
  });
});

describe("agent API", () => {
  it("adds, edits, reorders and removes blocks, and summarises them for agents", async () => {
    const { gadget } = await loadGadget();
    const slideId = await gadget.addSlide(null, { background: { color: "#FFFFFF" }, blocks: [] });
    const a = await gadget.addBlock(slideId, { type: "title", x: 35, y: 76, props: { text: "Headline" } });
    const b = await gadget.addBlock(slideId, { type: "text", x: 36, y: 204, props: { text: "Body", color: "#000000" } }, 0);
    expect(a).toMatch(/^[0-9a-f-]{8}$/);
    expect((await gadget.getSlide(slideId))!.blocks.map((x) => x.id)).toEqual([b, a]);

    await gadget.updateBlock(slideId, a!, { y: 80, props: { highlight: "Head" } });
    expect((await gadget.getSlide(slideId))!.blocks[1]).toEqual({ id: a, type: "title", x: 35, y: 80, props: { text: "Headline", highlight: "Head" } });

    await gadget.reorderBlock(slideId, a!, 0);
    const [summary] = (await gadget.listSlides()).filter((s) => s.id === slideId);
    expect(summary).toMatchObject({ index: 1, label: "Headline" });
    // Readable text skips colours.
    expect(summary!.blocks.map((x) => [x.id, x.text])).toEqual([[a, "Headline · Head"], [b, "Body"]]);

    await gadget.removeBlock(slideId, b!);
    expect((await gadget.getSlide(slideId))!.blocks.map((x) => x.id)).toEqual([a]);
  });

  it("applies multi-block operations as one undo step", async () => {
    const { gadget } = await loadGadget();
    const slideId = await gadget.addSlide(null, { blocks: [] });
    const ids = await gadget.addBlocks(slideId, [
      { type: "text", x: 0, y: 0, props: { text: "one" } },
      { type: "text", x: 0, y: 50, props: { text: "two" } },
    ]);
    await gadget.updateBlocks(slideId, ids.map((id) => ({ id, patch: { x: 10 } })));
    expect((await gadget.getSlide(slideId))!.blocks.map((x) => x.x)).toEqual([10, 10]);
    await gadget.removeBlocks(slideId, ids);
    expect((await gadget.getSlide(slideId))!.blocks).toEqual([]);
    expect(await gadget.undo()).toBe(true);
    expect((await gadget.getSlide(slideId))!.blocks.map((x) => x.x)).toEqual([10, 10]);
    expect(await gadget.undo()).toBe(true);
    expect((await gadget.getSlide(slideId))!.blocks.map((x) => x.x)).toEqual([0, 0]);
  });

  it("adds, duplicates, moves and removes slides, never leaving the deck empty", async () => {
    const { gadget } = await loadGadget();
    const [first] = (await gadget.getDeck()).slides;
    const second = await gadget.addSlide(null, { id: first!.id, blocks: [{ type: "text", x: 0, y: 0, props: {} }] });
    expect(second).not.toBe(first!.id);
    const copy = await gadget.duplicateSlide(second);
    const copied = await gadget.getSlide(copy!);
    expect(copied!.blocks[0]!.id).not.toBe((await gadget.getSlide(second))!.blocks[0]!.id);
    await gadget.moveSlide(copy!, 0);
    expect((await gadget.getDeck()).slides.map((s) => s.id)).toEqual([copy, first!.id, second]);
    for (const id of [copy!, first!.id, second]) await gadget.removeSlide(id);
    const left = (await gadget.getDeck()).slides;
    expect(left).toHaveLength(1);
    expect(left[0]!.blocks.map((b) => b.type)).toEqual(["title"]);
  });

  // History steps and patches key slides by id, and an object drops a "__proto__" key.
  it("gives a slide a fresh id in place of a name every object has, so undo still works", async () => {
    const { gadget } = await loadGadget();
    const id = await gadget.addSlide(null, { id: "__proto__", blocks: [{ id: "t", type: "text", x: 0, y: 0, props: { text: "before" } }] });
    expect(id).not.toBe("__proto__");
    await gadget.updateBlock(id!, "t", { props: { text: "after" } });
    expect(await gadget.undo()).toBe(true);
    expect((await gadget.getSlide(id!))!.blocks[0]!.props.text).toBe("before");
  });

  it("merges slide background patches and replaces block lists", async () => {
    const { gadget } = await loadGadget();
    const slideId = await gadget.addSlide(null, { background: { color: "#FFFFFF", dotGrid: 0.4 }, blocks: [] });
    await gadget.updateSlide(slideId, { background: { inset: true }, blocks: [{ type: "text", x: 1, y: 2, props: {} }] });
    const slide = await gadget.getSlide(slideId);
    expect(slide!.background).toEqual({ color: "#FFFFFF", dotGrid: 0.4, inset: true });
    expect(slide!.blocks).toHaveLength(1);
  });

  it("returns null, and stores nothing, for a slide that no longer exists", async () => {
    const { gadget } = await loadGadget();
    const before = (await gadget.getDeck()).rev;
    expect(await gadget.addBlock("gone", { type: "text", x: 0, y: 0, props: {} })).toBeNull();
    expect(await gadget.duplicateSlide("gone")).toBeNull();
    expect((await gadget.getDeck()).rev).toBe(before);
  });

  it("keeps a deck set without the schema marker, and resets to the seed", async () => {
    const { gadget } = await loadGadget();
    await gadget.setDeck({ slides: [{ id: "s9", background: {}, blocks: [] }] });
    expect((await gadget.getDeck()).slides.map((s) => s.id)).toEqual(["s9"]);
    const reset = await gadget.resetAll();
    expect(reset.slides).toHaveLength(1);
    expect(reset.slides[0]!.background.coverOrange).toBe(true);
    // Reset is an edit like any other: it can be undone.
    await gadget.undo();
    expect((await gadget.getDeck()).slides.map((s) => s.id)).toEqual(["s9"]);
  });

  it("broadcasts each change as a patch of the slides it touched, and undo/redo too", async () => {
    const { gadget } = await loadGadget();
    const { patches, stub } = recorder();
    await gadget.subscribe(stub, { patches: true });
    const [cover] = (await gadget.getDeck()).slides;
    const id = await gadget.addBlock(cover!.id, { type: "text", x: 0, y: 0, props: { text: "x" } });
    expect(patches).toHaveLength(1);
    expect(patches[0]!.patch).toMatchObject({ rev: 1, base: 0 });
    expect(Object.keys(patches[0]!.patch.slides)).toEqual([cover!.id]);
    expect(patches[0]!.patch.order).toBeUndefined();
    expect(patches[0]!.meta).toEqual({ canUndo: true, canRedo: false });

    await gadget.undo();
    expect(patches[1]!.patch.slides[cover!.id]!.blocks.some((b) => b.id === id)).toBe(false);
    expect(patches[1]!.meta).toEqual({ canUndo: false, canRedo: true });
    await gadget.redo();
    expect(patches[2]!.patch.slides[cover!.id]!.blocks.some((b) => b.id === id)).toBe(true);

    const added = await gadget.addSlide(0, { blocks: [] });
    expect(patches[3]!.patch.order).toEqual([added, cover!.id]);
  });
});

describe("slide layouts", () => {
  const shape = (slide: Slide | null) => slide!.blocks.map((b) => [b.type, b.x, b.y]);
  const bar = ["svg", 0, 663];

  it("builds each layout's slide, with fresh ids, for the agent to fill in", async () => {
    const { gadget } = await loadGadget();
    const title = await gadget.getSlide(await gadget.addSlide(null, { layout: "title" }));
    expect(title!.background).toEqual({ color: "#F6821F", inset: false, coverOrange: true });
    expect(shape(title)).toEqual([["title", 33, 245]]);
    expect(title!.blocks[0]!.props).toMatchObject({ text: "[TITLE]", highlight: "" });

    const content = await gadget.getSlide(await gadget.addSlide(null, { layout: "content" }));
    expect(content!.background).toEqual({ color: "#FFFFFF", inset: false, dotGrid: 0 });
    expect(shape(content)).toEqual([["sectionLabel", 36, 35], ["title", 35, 76], ["text", 36, 204], bar]);
    expect(content!.blocks[1]!.props).toMatchObject({ color: "#000000", highlight: "" });
    expect(content!.blocks[3]!.props.markup).toBe(BOTTOM_BAR_SVG);

    const two = await gadget.getSlide(await gadget.addSlide(null, { layout: "twoColumn" }));
    expect(two!.background.inset).toBe(false);
    expect(shape(two)).toEqual([
      ["sectionLabel", 36, 35], ["title", 35, 76],
      ["text", 36, 204], ["text", 36, 252], ["text", 609, 204], ["text", 609, 252],
      bar,
    ]);

    const four = await gadget.getSlide(await gadget.addSlide(null, { layout: "fourColumn" }));
    expect(shape(four)).toEqual([
      ["sectionLabel", 36, 35], ["title", 35, 76],
      ...[34, 328, 622, 916].flatMap((x) => [["text", x, 194], ["text", x, 228], ["text", x, 272]]),
      bar,
    ]);
    expect(four!.blocks.slice(2, -1).filter((_, i) => i % 3 === 0).map((b) => b.props.text)).toEqual(["01", "02", "03", "04"]);

    const ids = [title, content, two, four].flatMap((s) => s!.blocks.map((b) => b.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("merges a supplied background over the layout's and keeps a free id", async () => {
    const { gadget } = await loadGadget();
    const id = await gadget.addSlide(0, { id: "intro", layout: "content", background: { dotGrid: 0.4 } });
    expect(id).toBe("intro");
    expect((await gadget.getSlide(id))!.background).toEqual({ color: "#FFFFFF", inset: false, dotGrid: 0.4 });
    expect((await gadget.getDeck()).slides[0]!.id).toBe("intro");
  });

  it("refuses an unknown layout, or a layout with blocks, naming the valid ones", async () => {
    const { gadget } = await loadGadget();
    const rev = (await gadget.getDeck()).rev;
    await expect(gadget.addSlide(null, { layout: "bullets" as never })).rejects.toThrow(
      'Unknown slide layout "bullets": use one of title, content, twoColumn, fourColumn.',
    );
    await expect(gadget.addSlide(null, { layout: "content", blocks: [] })).rejects.toThrow(/layout or blocks/);
    expect((await gadget.getDeck()).rev).toBe(rev);
  });

  it("stores a slide assembled without a layout flat and white unless it asks otherwise", async () => {
    const { gadget } = await loadGadget();
    const background = async (input: Parameters<Gadget["addSlide"]>[1]) => (await gadget.getSlide(await gadget.addSlide(null, input)))!.background;
    expect(await background({ blocks: [] })).toEqual({ color: "#FFFFFF", inset: false });
    expect(await background({ background: { color: "#000000" }, blocks: [] })).toEqual({ color: "#000000", inset: false });
    expect(await background({ background: { inset: true }, blocks: [] })).toEqual({ color: "#FFFFFF", inset: true });
    // No input at all is still the cover slide a new deck starts with.
    const cover = (await gadget.getDeck()).slides[0]!;
    expect(await gadget.getSlide(await gadget.addSlide())).toMatchObject({ background: cover.background, blocks: [{ type: "title", props: cover.blocks[0]!.props }] });
  });
});

describe("limits and no-op edits", () => {
  it("leaves history alone for an edit that changes nothing", async () => {
    const { gadget } = await loadGadget();
    const [cover] = (await gadget.getDeck()).slides;
    const id = await gadget.addBlock(cover!.id, { type: "text", x: 0, y: 0, props: { text: "x" } });
    await gadget.undo();
    await gadget.redo();
    await gadget.undo();
    const { rev } = await gadget.getDeck();
    await gadget.removeBlock(cover!.id, "missing");
    await gadget.removeBlocks(cover!.id, ["missing"]);
    await gadget.updateBlocks(cover!.id, [{ id: "missing", patch: { x: 1 } }]);
    expect(await gadget.addBlocks(cover!.id, [42 as never])).toEqual([]);
    await gadget.removeSlide("missing");
    await gadget.moveSlide(cover!.id, 0);
    await gadget.reorderBlock(cover!.id, cover!.blocks[0]!.id, 0);
    const first = cover!.blocks[0]!;
    await gadget.updateBlock(cover!.id, first.id, { x: first.x, y: first.y, props: first.props });
    expect((await gadget.getDeck()).rev).toBe(rev);
    // Redo still brings the block back.
    expect(await gadget.getUndoState()).toEqual({ canUndo: false, canRedo: true });
    expect(await gadget.redo()).toBe(true);
    expect((await gadget.getSlide(cover!.id))!.blocks.map((b) => b.id)).toContain(id);
  });

  it("ignores patches that aren't objects", async () => {
    const { gadget } = await loadGadget();
    const [cover] = (await gadget.getDeck()).slides;
    const blockId = cover!.blocks[0]!.id;
    await gadget.updateBlock(cover!.id, blockId, "ab" as never);
    await gadget.updateBlocks(cover!.id, [{ id: blockId, patch: ["x"] as never }, null as never]);
    await gadget.updateSlide(cover!.id, "ab" as never);
    expect(await gadget.getSlide(cover!.id)).toEqual(cover);
  });

  it("refuses to replace the deck without a list of slides", async () => {
    const { gadget } = await loadGadget();
    const before = await gadget.getDeck();
    await expect(gadget.setDeck({ logo: null } as never)).rejects.toThrow(/slides must be an array/);
    await expect(gadget.updateSlide(before.slides[0]!.id, { blocks: "none" as never })).rejects.toThrow(/blocks must be an array/);
    expect(await gadget.getDeck()).toEqual(before);
  });

  it("refuses an edit past the deck's limits, before changing anything", async () => {
    const { gadget, storage } = await loadGadget();
    const [cover] = (await gadget.getDeck()).slides;
    const block = { type: "text", x: 0, y: 0, props: { text: "x" } };
    await expect(gadget.addBlocks(cover!.id, Array.from({ length: 1000 }, () => block))).rejects.toThrow(/Too many blocks/);
    await expect(gadget.setDeck({ slides: Array.from({ length: 501 }, () => ({ blocks: [] })) })).rejects.toThrow(/Too many slides/);
    const before = await gadget.getDeck();
    const meta = structuredClone(storage.data.get("meta"));
    await expect(gadget.updateBlock(cover!.id, cover!.blocks[0]!.id, { props: { text: "x".repeat(1_000_000) } })).rejects.toThrow(/too large/);
    expect(await gadget.getDeck()).toEqual(before);
    expect(storage.data.get("meta")).toEqual(meta);
    expect(await gadget.getUndoState()).toEqual({ canUndo: false, canRedo: false });
  });
});

describe("block normalization", () => {
  it("coerces numeric strings, drops bad geometry, defaults the type and props", async () => {
    const { gadget } = await loadGadget();
    const slideId = await gadget.addSlide(null, { blocks: [] });
    const loose = { x: "120", y: "junk", w: "-5", h: "40", props: { fontSize: "19", text: "7", x1: " " } } as unknown as Omit<Block, "id">;
    const id = await gadget.addBlock(slideId, loose);
    expect((await gadget.getSlide(slideId))!.blocks[0]).toEqual({
      id, type: "text", x: 120, y: 0, h: 40, props: { fontSize: 19, text: "7", x1: " " },
    });
  });

  it("keeps old geometry for a non-numeric patch value (null x/y included), and clears w/h with null", async () => {
    const { gadget } = await loadGadget();
    const slideId = await gadget.addSlide(null, { blocks: [] });
    const id = (await gadget.addBlock(slideId, { type: "box", x: 10, y: 20, w: 200, h: 100, props: {} }))!;
    await gadget.updateBlock(slideId, id, { x: "oops", y: null, w: null, props: { title: "T" } } as unknown as Partial<Block>);
    expect((await gadget.getSlide(slideId))!.blocks[0]).toEqual({ id, type: "box", x: 10, y: 20, h: 100, props: { title: "T" } });
  });

  it("keeps a supplied id in addBlocks only when it is unique on the slide", async () => {
    const { gadget } = await loadGadget();
    const slideId = await gadget.addSlide(null, { blocks: [{ id: "taken", type: "text", x: 0, y: 0, props: {} }] });
    const block = (id: string) => ({ id, type: "text", x: 0, y: 0, props: {} });
    const ids = await gadget.addBlocks(slideId, [block("mine"), block("taken"), block("mine")]);
    expect(ids[0]).toBe("mine");
    expect(ids.slice(1)).not.toContain("taken");
    expect(new Set(["taken", ...ids]).size).toBe(4);
  });

  it("drops non-blocks and re-mints duplicate or missing ids in a block list", async () => {
    const { gadget } = await loadGadget();
    const slideId = await gadget.addSlide(null, {
      blocks: [
        { id: "dup", type: "text", x: 0, y: 0, props: {} },
        { id: "dup", type: "text", x: 0, y: 0, props: {} },
        null as unknown as Block,
        [] as unknown as Block,
        { type: "text", x: 0, y: 0, props: {} },
      ],
    });
    const ids = (await gadget.getSlide(slideId))!.blocks.map((b) => b.id);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe("dup");
    expect(new Set(ids).size).toBe(3);
  });

  it("keeps a supplied block id only while it is unique on the slide", async () => {
    const { gadget } = await loadGadget();
    const slideId = await gadget.addSlide(null, { blocks: [] });
    expect(await gadget.addBlock(slideId, { id: "mine", type: "text", x: 0, y: 0, props: {} })).toBe("mine");
    expect(await gadget.addBlock(slideId, { id: "mine", type: "text", x: 0, y: 0, props: {} })).not.toBe("mine");
  });
});

describe("media assets", () => {
  it("stores large media once, by hash, outside the slide, and inlines it for export", async () => {
    const { gadget, storage } = await loadGadget();
    const slideId = await gadget.addSlide(null, { blocks: [] });
    const src = bigImage();
    await gadget.addBlock(slideId, { type: "image", x: 0, y: 0, props: { src } });
    await gadget.addBlock(slideId, { type: "image", x: 0, y: 0, props: { src } });
    const stored = (await gadget.getSlide(slideId))!.blocks.map((b) => b.props.src);
    expect(stored[0]).toMatch(/^asset:[0-9a-f]{32}$/);
    expect(stored[1]).toBe(stored[0]);
    expect(Object.keys(storage.data.get("assets") as object)).toHaveLength(1);
    expect(await gadget.getAsset(stored[0]!)).toBe(src);
    const inlined = await gadget.getDeckInlined();
    expect(inlined.slides.find((s) => s.id === slideId)!.blocks.map((b) => b.props.src)).toEqual([src, src]);
    // A small value stays inline.
    await gadget.addBlock(slideId, { type: "image", x: 0, y: 0, props: { src: PNG_1x1 } });
    expect((await gadget.getSlide(slideId))!.blocks[2]!.props.src).toBe(PNG_1x1);
  });
});

// Stored media nothing uses any more is deleted a while later, and nothing still in use is.
describe("asset sweep", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());
  const big = (fill: string) => PNG_1x1 + fill.repeat(4096);
  // Waits out the sweep delay, then for the sweep itself (queued like a mutation).
  const sweep = async (gadget: Gadget) => {
    await vi.advanceTimersByTimeAsync(30_000);
    await gadget.saveSvgRaster("", "");
  };
  const lastSrc = async (gadget: Gadget, slideId: string) => (await gadget.getSlide(slideId))!.blocks.at(-1)!.props.src as string;

  it("keeps what the deck, its logo, undo or redo use, and deletes the rest", async () => {
    const { gadget } = await loadGadget();
    const slideId = await gadget.addSlide(null, { blocks: [] });
    await gadget.addBlock(slideId, { type: "image", x: 0, y: 0, props: { src: big("L") } });
    const live = await lastSrc(gadget, slideId);
    const logo = (await gadget.setLogo({ src: big("G") }))!.src;
    const undoId = (await gadget.addBlock(slideId, { type: "image", x: 0, y: 0, props: { src: big("U") } }))!;
    const undoOnly = await lastSrc(gadget, slideId);
    await gadget.removeBlock(slideId, undoId);
    await gadget.addBlock(slideId, { type: "image", x: 0, y: 0, props: { src: big("X") } });
    const unused = await lastSrc(gadget, slideId);
    await gadget.undo();
    // This edit drops the redo step, the only use of `unused`, and so schedules a sweep.
    await gadget.addBlock(slideId, { type: "text", x: 0, y: 0, props: { text: "hi" } });
    await gadget.addBlock(slideId, { type: "image", x: 0, y: 0, props: { src: big("R") } });
    const redoOnly = await lastSrc(gadget, slideId);
    await gadget.undo();
    await sweep(gadget);
    expect(await gadget.getAsset(unused)).toBeNull();
    for (const ref of [live, logo, undoOnly, redoOnly]) expect(await gadget.getAsset(ref)).not.toBeNull();
  });

  it("keeps an SVG's raster until neither the deck nor its history shows the SVG", async () => {
    const markup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="100%" height="100%"/></svg>';
    const { gadget } = await loadGadget();
    const slideId = await gadget.addSlide(null, { blocks: [] });
    const svgId = (await gadget.addBlock(slideId, { type: "svg", x: 0, y: 0, props: { markup } }))!;
    const key = await sha(markup);
    expect(await gadget.saveSvgRaster(key, PNG_1x1)).toBe(true);
    await gadget.removeBlock(slideId, svgId);
    await gadget.addBlock(slideId, { type: "text", x: 0, y: 0, props: { text: "0" } });
    await gadget.undo();
    await gadget.addBlock(slideId, { type: "text", x: 0, y: 0, props: { text: "drops redo" } });
    await sweep(gadget);
    expect(await gadget.getSvgRasters([key])).toEqual({ [key]: PNG_1x1 });
    // Enough edits to push the SVG's steps out of undo history.
    for (let i = 1; i <= 55; i++) await gadget.updateBlock(slideId, (await gadget.getSlide(slideId))!.blocks.at(-1)!.id, { props: { text: String(i) } });
    await sweep(gadget);
    expect(await gadget.getSvgRasters([key])).toEqual({});
  });
});

// The previous Slides blueprint stored the whole deck as one "deck" value, stamped
// "workspace.1". Those decks hold people's work: they are migrated, never reseeded.
const legacy = () => ({
  themeVersion: "workspace.1",
  slides: [
    { id: "s1", background: { color: "#F6821F", inset: false, coverOrange: true }, blocks: [
      { id: "b1", type: "logo", x: 36, y: 56, w: 267, props: { variant: "light", scale: 1, text: "Acme", accentDot: true } },
      { id: "b2", type: "title", x: 33, y: 197, w: 687, props: { text: "My old deck", fontSize: 58 } },
    ] },
    { id: "s2", background: { color: "#FFFFFF", dotGrid: 0 }, blocks: [
      { id: "c1", type: "logo", x: 1013, y: 40, props: { variant: "dark", scale: 0.62 } },
      { id: "c2", type: "card", x: 100, y: 200, w: 280, h: 200, props: { title: "Card", body: "x" } },
      { id: "c3", type: "logo", x: 500, y: 500, props: { variant: "dark", scale: 0.62, text: "Placed" } },
    ] },
  ],
});

describe("migration", () => {
  it("keeps a workspace.1 deck's slides and blocks, and leaves the old record in place", async () => {
    const { gadget, storage } = await withLegacyDeck(legacy());
    const deck = await gadget.getDeck();
    expect(deck.themeVersion).toBe("workspace.2");
    expect(deck.slides.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(deck.slides.map((s) => s.blocks.map((b) => b.id))).toEqual([["b1", "b2"], ["c1", "c2", "c3"]]);
    expect(deck.slides[0]!.blocks[1]!.props.text).toBe("My old deck");
    expect(storage.data.get("deck")).toEqual(legacy());
  });

  it("moves logos at an old template spot, names unnamed ones, and leaves placed logos alone", async () => {
    const { gadget } = await withLegacyDeck(legacy());
    const blocks = (await gadget.getSlide("s2"))!.blocks;
    expect(blocks[0]).toEqual({ id: "c1", type: "logo", x: 964, y: 31, w: 200, props: { variant: "dark", scale: 0.75, align: "right", text: "Workspace" } });
    expect(blocks[2]).toEqual(legacy().slides[1]!.blocks[2]);
    // Quietly: no undo step.
    expect(await gadget.getUndoState()).toEqual({ canUndo: false, canRedo: false });
  });

  it("reloads the migrated deck as it was, with edits and history intact", async () => {
    const { gadget, storage } = await withLegacyDeck(legacy());
    await gadget.updateBlock("s1", "b2", { props: { text: "Edited" } });
    const { gadget: again } = await loadGadget(storage);
    expect((await again.getSlide("s1"))!.blocks[1]!.props.text).toBe("Edited");
    expect(await again.getUndoState()).toEqual({ canUndo: true, canRedo: false });
    await again.undo();
    expect((await again.getSlide("s1"))!.blocks[1]!.props.text).toBe("My old deck");
  });

  it("keeps a v2 deck stored under an earlier theme marker", async () => {
    const { gadget, storage } = await withLegacyDeck(legacy());
    const meta = storage.data.get("meta") as Record<string, unknown>;
    storage.data.set("meta", { ...meta, themeVersion: "an-older-theme" });
    const { gadget: again } = await loadGadget(storage);
    expect((await again.getDeck()).slides.map((s) => s.id)).toEqual((await gadget.getDeck()).slides.map((s) => s.id));
  });

  it("migrates again when an older build saved to the old record after the migration", async () => {
    const { storage } = await withLegacyDeck(legacy());
    const changed = legacy();
    changed.slides[0]!.blocks[1]!.props.text = "Saved by the old build";
    storage.data.set("deck", changed);
    const { gadget } = await loadGadget(storage);
    expect((await gadget.getSlide("s1"))!.blocks[1]!.props.text).toBe("Saved by the old build");
  });

  it("loses nothing when the object is evicted partway through migrating again", async () => {
    const { gadget, storage } = await withLegacyDeck(legacy());
    await gadget.addSlide(null, { blocks: [] }); // a v2-only slide, which must not survive
    const changed = legacy();
    changed.slides[0]!.blocks[1]!.props.text = "Saved by the old build";
    storage.data.set("deck", changed);
    // Evicted after the first delete of the clean-up.
    const remove = storage.delete.bind(storage);
    storage.delete = async (key) => { await remove(key); storage.delete = async () => { throw new Error("evicted"); }; };
    await expect(loadGadget(storage)).rejects.toThrow("evicted");
    storage.delete = remove;
    expect(storage.data.get("deck")).toEqual(changed);
    const { gadget: again } = await loadGadget(storage);
    expect((await again.getDeck()).slides.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect((await again.getSlide("s1"))!.blocks[1]!.props.text).toBe("Saved by the old build");
  });

  it("migrates a logo stored without a name in the v2 layout on load", async () => {
    const { gadget, storage } = await loadGadget();
    const slideId = await gadget.addSlide(null, { blocks: [] });
    const slide = storage.data.get(`s:${slideId}`) as Slide;
    storage.data.set(`s:${slideId}`, { ...slide, blocks: [{ id: "l", type: "logo", x: 1, y: 2, props: { variant: "light" } }] });
    const { gadget: again } = await loadGadget(storage);
    expect((await again.getSlide(slideId))!.blocks[0]!.props.text).toBe("Workspace");
  });

  it("drops the earlier starter deck's gadgets mark, in either layout", async () => {
    const old = legacy();
    old.slides[0]!.blocks.push({ id: "g1", type: "gadgetsMark", x: 48, y: 240, props: { size: "large" } } as never);
    const { gadget, storage } = await withLegacyDeck(old);
    expect((await gadget.getSlide("s1"))!.blocks.map((b) => b.id)).toEqual(["b1", "b2"]);
    const slide = storage.data.get("s:s1") as Slide;
    storage.data.set("s:s1", { ...slide, blocks: [...slide.blocks, { id: "g2", type: "gadgetsMark", x: 0, y: 0, props: {} }] });
    const { gadget: again } = await loadGadget(storage);
    expect((await again.getSlide("s1"))!.blocks.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(await again.getUndoState()).toEqual({ canUndo: false, canRedo: false });
  });

  it("keeps an undo from bringing back a gadgets mark an earlier build saved in history", async () => {
    const { gadget, storage } = await withLegacyDeck(legacy());
    await gadget.updateBlock("s1", "b2", { props: { text: "Edited" } });
    // The step's earlier version of s1, as a build that still had the mark would have stored it.
    const [key, step] = [...storage.data].find(([k, v]) => k.startsWith("h:") && (v as { slides?: Record<string, Slide> }).slides?.s1)!;
    const s1 = (step as { slides: Record<string, Slide> }).slides.s1!;
    storage.data.set(key, { ...step as object, slides: { s1: { ...s1, blocks: [...s1.blocks, { id: "g1", type: "gadgetsMark", x: 0, y: 0, props: {} }] } } });
    const { gadget: again } = await loadGadget(storage);
    expect(await again.undo()).toBe(true);
    const restored = (await again.getSlide("s1"))!;
    expect(restored.blocks.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(restored.blocks[1]!.props.text).toBe("My old deck");
  });

  it("upgrades the storage the previous blueprint's build wrote, keeping every slide and block", async () => {
    const storage = new MemoryStorage();
    for (const [k, v] of Object.entries(workspace1Storage())) storage.data.set(k, v);
    const old = storage.data.get("deck") as Deck;
    const { gadget } = await loadGadget(storage);
    const deck = await gadget.getDeckInlined();
    expect(deck.slides.map((s) => s.id)).toEqual(old.slides.map((s) => s.id));
    const migrated = new Set(["gadgetsMark", "logo"]);
    for (const [i, before] of old.slides.entries()) {
      const after = deck.slides[i]!;
      expect(after.background).toEqual(before.background);
      // Every block is kept as it was -- media inlined back to the same data -- except the two
      // migrations: the Gadgets mark goes, and logos are named and moved (tested above).
      expect(after.blocks.map((b) => b.id)).toEqual(before.blocks.filter((b) => b.type !== "gadgetsMark").map((b) => b.id));
      for (const b of before.blocks.filter((b) => !migrated.has(b.type))) expect(after.blocks.find((x) => x.id === b.id)).toEqual(b);
    }
    expect(old.slides.flatMap((s) => s.blocks).some((b) => b.type === "gadgetsMark")).toBe(true);
    // The big image is stored once, as an asset; small media stays in the slide.
    const images = old.slides.flatMap((s) => s.blocks).filter((b) => b.type === "image");
    const big = images.find((b) => String(b.props.src).length >= 2048)!, small = images.find((b) => String(b.props.src).length < 2048)!;
    const stored = (await gadget.getDeck()).slides.flatMap((s) => s.blocks);
    expect(String(stored.find((b) => b.id === big.id)!.props.src)).toMatch(/^asset:/);
    expect(stored.find((b) => b.id === small.id)!.props.src).toBe(small.props.src);
    // Quietly, and the old record stays for the previous build.
    expect(await gadget.getUndoState()).toEqual({ canUndo: false, canRedo: false });
    expect(storage.data.get("deck")).toEqual(old);
    expect(await gadget.getDeckInlined()).toEqual(deck);

    // Edited and reloaded: no second migration, so the edit stays.
    const textBlock = deck.slides.flatMap((s) => s.blocks.map((b) => ({ s, b }))).find(({ b }) => b.type === "text")!;
    await gadget.updateBlock(textBlock.s.id, textBlock.b.id, { props: { text: "Edited after the update" } });
    const { gadget: again } = await loadGadget(storage);
    expect((await again.getSlide(textBlock.s.id))!.blocks.find((b) => b.id === textBlock.b.id)!.props.text).toBe("Edited after the update");
    expect((await again.getDeckInlined()).slides.flatMap((s) => s.blocks).find((b) => b.id === big.id)!.props.src).toBe(big.props.src);
  });

  it("keeps the slides of a deck from before the workspace.1 marker, which the previous build reseeded", async () => {
    const { themeVersion: _, ...unmarked } = legacy();
    const { gadget } = await withLegacyDeck(unmarked);
    expect((await gadget.getDeck()).slides.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("seeds a fresh deck when the old record holds no slides", async () => {
    const { gadget } = await withLegacyDeck({ themeVersion: "workspace.1" });
    expect((await gadget.getDeck()).slides).toHaveLength(1);
  });
});

describe("a tab of the previous client", () => {
  it("is sent the whole deck, media inlined, on subscribing and after every change", async () => {
    const { gadget } = await loadGadget();
    const [cover] = (await gadget.getDeck()).slides;
    await gadget.addBlock(cover!.id, { type: "image", x: 0, y: 0, props: { src: bigImage() } });
    const legacyTab = recorder(), currentTab = recorder();
    await gadget.subscribe(legacyTab.stub);
    await gadget.subscribe(currentTab.stub, { patches: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(legacyTab.decks).toHaveLength(1);
    expect(legacyTab.decks[0]!.deck.slides[0]!.blocks.at(-1)!.props.src).toBe(bigImage());
    await gadget.updateBlock(cover!.id, cover!.blocks[0]!.id, { props: { text: "Changed" } });
    await gadget.undo();
    await gadget.redo();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Coalesced, and never behind: the last deck it is sent is the current one.
    const last = legacyTab.decks.at(-1)!;
    expect(last.deck.slides[0]!.blocks[0]!.props.text).toBe("Changed");
    expect(last.meta).toEqual({ canUndo: true, canRedo: false });
    expect(legacyTab.patches).toEqual([]);
    expect(currentTab.decks).toEqual([]);
    expect(currentTab.patches).toHaveLength(3);
  });
});

describe("a tab of the previous client reading the deck", () => {
  it("gets media inlined while it is connected, unless the caller asks for refs", async () => {
    const { gadget } = await loadGadget();
    const [cover] = (await gadget.getDeck()).slides;
    await gadget.addBlock(cover!.id, { type: "image", x: 0, y: 0, props: { src: bigImage() } });
    const src = async (options?: { refs?: boolean }) => (await gadget.getDeck(options)).slides[0]!.blocks.at(-1)!.props.src;
    expect(await src()).toMatch(/^asset:/);
    await gadget.subscribe(recorder().stub);
    expect(await src()).toBe(bigImage());
    expect(await src({ refs: true })).toMatch(/^asset:/);
  });
});

describe("SVG rasters", () => {
  const markup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';

  it("validates the key and the PNG before saving anything", async () => {
    const { gadget, storage } = await loadGadget();
    const slideId = await gadget.addSlide(null, { blocks: [] });
    await gadget.addBlock(slideId, { type: "svg", x: 0, y: 0, props: { markup } });
    const key = await sha(markup);
    expect(await gadget.saveSvgRaster("not-a-key", PNG_1x1)).toBe(false);
    expect(await gadget.saveSvgRaster("A".repeat(32), PNG_1x1)).toBe(false);
    expect(await gadget.saveSvgRaster(key, "data:image/jpeg;base64,AAAA")).toBe(false);
    expect(await gadget.saveSvgRaster(key, 42 as unknown as string)).toBe(false);
    expect(await gadget.saveSvgRaster(key, "data:image/png;base64," + "A".repeat(6 * 1024 * 1024))).toBe(false);
    // Not a PNG, or larger than an editor draws one.
    expect(await gadget.saveSvgRaster(key, "data:image/png;base64,AAAA")).toBe(false);
    expect(await gadget.saveSvgRaster(key, pngHeader(4000, 10))).toBe(false);
    expect(storage.data.has("rasters")).toBe(false);
    expect(await gadget.saveSvgRaster(key, PNG_1x1)).toBe(true);
    expect(await gadget.getSvgRasters([key, "f".repeat(32)])).toEqual({ [key]: PNG_1x1 });
  });

  it("refuses a raster for artwork the deck doesn't show", async () => {
    const { gadget, storage } = await loadGadget();
    expect(await gadget.saveSvgRaster("0".repeat(32), PNG_1x1)).toBe(false);
    expect(storage.data.has("rasters")).toBe(false);
    expect([...storage.data.keys()].filter((k) => k.startsWith("a:"))).toEqual([]);
  });

  it("asks only for artwork in the deck without a raster, keyed by source hash or asset hash", async () => {
    const { gadget } = await loadGadget();
    const slideId = await gadget.addSlide(null, { blocks: [] });
    await gadget.addBlock(slideId, { type: "svg", x: 0, y: 0, props: { markup } });
    const big = `<svg xmlns="http://www.w3.org/2000/svg">${"<g/>".repeat(1000)}</svg>`;
    await gadget.addBlock(slideId, { type: "svg", x: 0, y: 0, props: { markup: big } });
    const ref = (await gadget.getSlide(slideId))!.blocks[1]!.props.markup!;
    expect(ref).toMatch(/^asset:/);
    const small = await sha(markup), asset = ref.slice("asset:".length);
    expect(asset).toBe(await sha(big));
    const stranger = "e".repeat(32);
    expect(await gadget.missingSvgRasters([small, asset, stranger])).toEqual([small, asset]);
    await gadget.saveSvgRaster(small, PNG_1x1);
    expect(await gadget.missingSvgRasters([small, asset])).toEqual([asset]);
    // Rasters touch neither the deck nor its history.
    expect((await gadget.getDeck()).rev).toBe(3);
  });
});

describe("deck logo", () => {
  const SVG = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 10"><rect width="40" height="10"/></svg>';

  it("sets, adjusts and removes the logo, each as one undo step, and broadcasts it", async () => {
    const { gadget } = await loadGadget();
    const sub = recorder();
    await gadget.subscribe(sub.stub, { patches: true });
    expect((await gadget.getDeck()).logo).toBeNull();

    expect(await gadget.setLogo({ src: PNG_1x1 })).toEqual({ src: PNG_1x1, position: "top-right", onCover: true });
    expect(sub.patches.at(-1)!.patch).toMatchObject({ slides: {}, logo: { src: PNG_1x1, position: "top-right", onCover: true } });
    // Merged into the current logo; alt text is trimmed.
    expect(await gadget.setLogo({ position: "bottom-left", onCover: false, alt: "  Acme  " }))
      .toEqual({ src: PNG_1x1, position: "bottom-left", onCover: false, alt: "Acme" });
    // No change, no step.
    const rev = (await gadget.getDeck()).rev;
    await gadget.setLogo({ position: "bottom-left" });
    expect((await gadget.getDeck()).rev).toBe(rev);

    expect(await gadget.setLogo({ src: "" })).toBeNull();
    expect(sub.patches.at(-1)!.patch.logo).toBeNull();
    expect(await gadget.undo()).toBe(true);
    expect((await gadget.getDeck()).logo).toMatchObject({ position: "bottom-left", alt: "Acme" });
    expect(await gadget.undo()).toBe(true);
    expect((await gadget.getDeck()).logo).toEqual({ src: PNG_1x1, position: "top-right", onCover: true });
    expect(await gadget.undo()).toBe(true);
    expect((await gadget.getDeck()).logo).toBeNull();
    expect(await gadget.redo()).toBe(true);
    expect((await gadget.getDeck()).logo).toEqual({ src: PNG_1x1, position: "top-right", onCover: true });
    // An undo that touches only the logo still leaves the slides alone.
    expect(sub.patches.at(-1)!.patch.slides).toEqual({});
  });

  it("refuses what isn't a PNG, JPEG or SVG logo", async () => {
    const { gadget } = await loadGadget();
    await expect(gadget.setLogo({ src: "data:image/gif;base64,R0lGOD" })).rejects.toThrow(/PNG, JPEG or SVG/);
    await expect(gadget.setLogo({ src: "https://example.com/logo.png" })).rejects.toThrow(/PNG, JPEG or SVG/);
    await expect(gadget.setLogo({ src: "asset:" + "0".repeat(32) })).rejects.toThrow(/PNG, JPEG or SVG/);
    await expect(gadget.setLogo({ src: PNG_1x1, position: "middle" as never })).rejects.toThrow(/position/);
    await expect(gadget.setLogo({ src: PNG_1x1, onCover: "yes" as never })).rejects.toThrow(/onCover/);
    await expect(gadget.setLogo("logo" as never)).rejects.toThrow(/setLogo takes/);
    expect((await gadget.getDeck()).logo).toBeNull();
    expect(await gadget.getUndoState()).toEqual({ canUndo: false, canRedo: false });

    // An asset that holds something other than image data (here, SVG block markup).
    const slideId = (await gadget.getDeck()).slides[0]!.id;
    await gadget.addBlock(slideId, { type: "svg", x: 0, y: 0, props: { markup: `<svg>${"<g/>".repeat(1000)}</svg>` } });
    const markupRef = (await gadget.getSlide(slideId))!.blocks[1]!.props.markup!;
    await expect(gadget.setLogo({ src: markupRef })).rejects.toThrow(/PNG, JPEG or SVG/);
  });

  it("stores a big image as an asset, inlines it for export, and keeps it on reload", async () => {
    const { gadget, storage } = await loadGadget();
    const logo = await gadget.setLogo({ src: bigImage(), alt: "Acme" });
    expect(logo!.src).toMatch(/^asset:[0-9a-f]{32}$/);
    expect(await gadget.getAsset(logo!.src)).toBe(bigImage());
    expect((await gadget.getDeckInlined()).logo!.src).toBe(bigImage());
    expect((storage.data.get("meta") as { logo: unknown }).logo).toEqual(logo);
    const { gadget: again } = await loadGadget(storage);
    expect((await again.getDeck()).logo).toEqual(logo);
    // Its asset is kept while the logo (or its history) uses it.
    expect(await again.getAsset(logo!.src)).toBe(bigImage());
    // Setting the same image again reuses the stored asset.
    expect((await again.setLogo({ src: logo!.src, position: "top-left" }))!.src).toBe(logo!.src);
  });

  it("asks browsers for a PNG of an SVG logo, keyed like any SVG source", async () => {
    const { gadget } = await loadGadget();
    await gadget.setLogo({ src: SVG });
    expect(await gadget.missingSvgRasters([await sha(SVG)])).toEqual([await sha(SVG)]);
  });

  it("keeps the logo across setDeck unless it is given, and resetAll removes it", async () => {
    const { gadget } = await loadGadget();
    await gadget.setLogo({ src: PNG_1x1 });
    await gadget.setDeck({ slides: [{ blocks: [] }] });
    expect((await gadget.getDeck()).logo).toMatchObject({ src: PNG_1x1 });
    await gadget.setDeck({ slides: [{ blocks: [] }], logo: { src: SVG, position: "bottom-right" } });
    expect((await gadget.getDeck()).logo).toEqual({ src: SVG, position: "bottom-right", onCover: true });
    expect((await gadget.resetAll()).logo).toBeNull();
    // One undo brings back the slides and the logo together.
    await gadget.undo();
    expect((await gadget.getDeck()).logo).toMatchObject({ src: SVG });
  });

  it("loads a deck saved before there was a deck logo, and keeps its logo blocks", async () => {
    const { gadget, storage } = await withLegacyDeck(legacy());
    const meta = storage.data.get("meta") as Record<string, unknown>;
    delete meta.logo;
    storage.data.set("meta", meta);
    const { gadget: again } = await loadGadget(storage);
    expect((await again.getDeck()).logo).toBeNull();
    // The accent stop flag is kept as stored (renderers ignore it), nothing is wiped.
    expect((await again.getSlide("s1"))!.blocks[0]!.props).toEqual({ variant: "light", scale: 1, text: "Acme", accentDot: true });
    void gadget;
  });
});
