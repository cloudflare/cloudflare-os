import { describe, expect, it, vi } from "vitest";

// The runtime's DurableObject base refuses a state that is not a real DurableObjectState; the
// gadget only ever reads `state.storage`, so the base is stood in for by the assignment it does.
vi.mock("cloudflare:workers", async (importOriginal) => ({
  ...await importOriginal<typeof import("cloudflare:workers")>(),
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
}));

import { Gadget } from "../format-blueprints/workspace-slides/files/server.ts";

// The Slides Durable Object over in-memory storage: the contract its client relies on for adding
// blocks. A real instance, since the class keeps private methods, over a state that is only the
// storage the gadget reads and writes.
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

  it("returns null, and stores nothing, for a slide that no longer exists", async () => {
    const gadget = inMemoryGadget(deck());
    expect(await gadget.addBlock("gone", { type: "text", x: 0, y: 0, props: {} })).toBeNull();
    expect((await gadget.getDeck()).slides[0]!.blocks).toEqual([]);
  });
});
