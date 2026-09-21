// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Gadget } from "../files/server.ts";

// The Slides Durable Object over in-memory storage: the contract its client relies on for adding
// blocks. A real instance, since the class keeps private methods, over a state that is only the
// storage the gadget reads and writes -- the `cloudflare:workers` stub vitest.config.ts aliases in
// accepts it, where the runtime's base would refuse a state that is not a real DurableObjectState.
function inMemoryGadget(deck: unknown) {
  const stored = new Map<string, unknown>([["deck", deck]]);
  const state = {
    storage: {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => { stored.set(key, value); },
    },
  } as unknown as DurableObjectState;
  return new Gadget(state, {});
}

// The stored shape getDeck() accepts as current; anything else is wiped and reseeded.
const deck = () => ({ themeVersion: "workspace.1", slides: [{ id: "s1", background: {}, blocks: [] }] });

describe("Workspace Slides blocks", () => {

  it("adds a block to a slide and returns its id", async () => {
    const gadget = inMemoryGadget(deck());
    const id = await gadget.addBlock("s1", { type: "text", x: 10, y: 20, props: { text: "hi" } });
    expect(id).toMatch(/^[0-9a-f-]{8}$/);
    const saved = await gadget.getDeck();
    expect(saved.slides[0]!.blocks).toEqual([{ id, type: "text", x: 10, y: 20, props: { text: "hi" } }]);
  });

  // setDeck is reached over the GADGET binding with a deck built from the public type, on which
  // the marker is optional; without the stamp the next getDeck would reseed and the deck be lost.
  it("keeps a deck set without the schema marker", async () => {
    const gadget = inMemoryGadget(undefined);
    await gadget.setDeck({ slides: [{ id: "s9", background: {}, blocks: [] }] });
    expect((await gadget.getDeck()).slides.map(slide => slide.id)).toEqual(["s9"]);
  });

  it("returns null, and stores nothing, for a slide that no longer exists", async () => {
    const gadget = inMemoryGadget(deck());
    expect(await gadget.addBlock("gone", { type: "text", x: 0, y: 0, props: {} })).toBeNull();
    expect((await gadget.getDeck()).slides[0]!.blocks).toEqual([]);
  });
});
