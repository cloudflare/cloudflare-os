import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { SubscriberRegistry } from "@gadgets/bundled-blueprints/libraries/sync/server";
import { MAX_TOTAL_TEXT_LENGTH, deckToPptx, measureText } from "@gadgets/bundled-blueprints/libraries/pptx/server";
import type {
  Block,
  BlockInput,
  BlockPatch,
  Deck,
  DeckCallbacks,
  GadgetStub,
  Slide,
  SlideInput,
  SlidePatch,
  UndoState,
} from "./lib/protocol.ts";

/**
 * The Gadget stores a single "deck" document under the "deck" key:
 *
 *   { slides: [Slide] }
 *
 * Slide = {
 *   id: string,
 *   background: { color?: string, inset?: bool, dotGrid?: number },
 *   blocks: [Block],
 * }
 *
 * Block = {
 *   id: string,
 *   type: string,         // e.g. "title", "card", "arrow"
 *   x: number, y: number, // top-left in 1200x675 slide coords
 *   w?: number, h?: number,
 *   props: {...},         // type-specific (text, tone, etc.)
 * }
 *
 * Interactive rendering lives in client.ts and PowerPoint rendering in the shared PPTX library;
 * the server is a document store with realtime broadcast plus the export adapter. Mutations are
 * coarse: any change re-sends the whole deck, which keeps clients trivially in sync and makes undo
 * easy.
 *
 * The connected browsers are held by the sync library's SubscriberRegistry.
 * A deck has no presence — everyone sees the same slide data and cursors are
 * not shared — so the registry is built with no presence hooks and is a plain
 * fan-out: it keeps each subscriber's stub, drops and releases one whose
 * connection breaks or whose delivery fails, and isolates the rest from it.
 */

const STORAGE_KEY = "deck";
/** The schema marker a stored deck carries; a deck without it is reseeded (see getDeck). */
const THEME_VERSION = "workspace.1";
const MAX_UNDO = 50;

export class Gadget extends DurableObject<unknown> implements GadgetStub {
  state: DurableObjectState;
  subscribers: SubscriberRegistry<DeckCallbacks>;
  undoStack: Deck[];
  redoStack: Deck[];

  constructor(state: DurableObjectState, env: unknown) {
    super(state, env);
    this.state = state;
    this.subscribers = new SubscriberRegistry();
    // Undo/redo stacks live in memory only — they're transient and
    // shared across every connected client (one global history for the
    // whole deck). On DO restart history is lost, which we consider
    // acceptable. Each entry is a full deck snapshot (deep clone).
    this.undoStack = [];
    this.redoStack = [];
  }

  // -------- undo / redo ---------------------------------------------------
  async getUndoState(): Promise<UndoState> {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }

  async undo(): Promise<boolean> {
    if (this.undoStack.length === 0) return false;
    const prev = this.undoStack.pop()!;
    const current = await this.state.storage.get<Deck>(STORAGE_KEY);
    if (current) this.redoStack.push(current);
    await this.state.storage.put(STORAGE_KEY, prev);
    this.#broadcast(prev);
    return true;
  }

  async redo(): Promise<boolean> {
    if (this.redoStack.length === 0) return false;
    const next = this.redoStack.pop()!;
    const current = await this.state.storage.get<Deck>(STORAGE_KEY);
    if (current) this.undoStack.push(current);
    await this.state.storage.put(STORAGE_KEY, next);
    this.#broadcast(next);
    return true;
  }

  // -------- read ----------------------------------------------------------
  async getDeck(): Promise<Deck> {
    let d = await this.state.storage.get<Deck>(STORAGE_KEY);
    // Defensive: if the storage was empty OR holds an older-schema document
    // (the previous version of this Gadget stored field overrides under
    // numeric keys rather than a `slides` array), wipe and seed.
    if (!d || !Array.isArray(d.slides) || d.themeVersion !== THEME_VERSION) {
      d = initialDeck();
      await this.state.storage.put(STORAGE_KEY, d);
    }
    return d;
  }

  // -------- slide ops -----------------------------------------------------
  async addSlide(atIndex?: number | null, slide?: SlideInput): Promise<string> {
    const d = await this.getDeck();
    const s = slide || newBlankSlide();
    if (!s.id) s.id = genId();
    // Mint ids for any blocks that arrived without one. Caller-supplied
    // slides (e.g. created over the GADGET binding) often omit ids, and
    // a missing id breaks the client's selection model — every block
    // with `id === undefined` would look "selected" at the same time
    // when any one of them is selected.
    s.blocks = (s.blocks || []).map(b => b.id ? b : { ...b, id: genId() });
    const i = (atIndex == null || atIndex < 0 || atIndex > d.slides.length)
      ? d.slides.length : atIndex;
    // A caller-supplied slide is a Slide by now: its id and its blocks' ids were filled in above.
    d.slides.splice(i, 0, s as Slide);
    await this.#save(d);
    return s.id;
  }

  async removeSlide(slideId: string): Promise<void> {
    const d = await this.getDeck();
    d.slides = d.slides.filter(s => s.id !== slideId);
    if (d.slides.length === 0) d.slides.push(newBlankSlide());
    await this.#save(d);
  }

  async duplicateSlide(slideId: string): Promise<string | null> {
    const d = await this.getDeck();
    const i = d.slides.findIndex(s => s.id === slideId);
    if (i < 0) return null;
    const copy: Slide = JSON.parse(JSON.stringify(d.slides[i]));
    copy.id = genId();
    copy.blocks = (copy.blocks || []).map(b => ({ ...b, id: genId() }));
    d.slides.splice(i + 1, 0, copy);
    await this.#save(d);
    return copy.id;
  }

  async moveSlide(slideId: string, toIndex: number): Promise<void> {
    const d = await this.getDeck();
    const i = d.slides.findIndex(s => s.id === slideId);
    if (i < 0) return;
    const [s] = d.slides.splice(i, 1);
    const j = Math.max(0, Math.min(d.slides.length, toIndex));
    d.slides.splice(j, 0, s);
    await this.#save(d);
  }

  async updateSlide(slideId: string, patch: SlidePatch): Promise<void> {
    const d = await this.getDeck();
    const s = d.slides.find(s => s.id === slideId);
    if (!s) return;
    if (patch.background) s.background = { ...s.background, ...patch.background };
    const { background, ...rest } = patch;
    Object.assign(s, rest);
    await this.#save(d);
  }

  // -------- block ops -----------------------------------------------------
  async addBlock(slideId: string, block: BlockInput, atIndex?: number | null): Promise<string | null> {
    const d = await this.getDeck();
    const s = d.slides.find(s => s.id === slideId);
    if (!s) return null;
    const b: Block = { id: genId(), ...block };
    if (!b.id) b.id = genId();
    if (atIndex == null) s.blocks.push(b);
    else s.blocks.splice(atIndex, 0, b);
    await this.#save(d);
    return b.id;
  }

  async updateBlock(slideId: string, blockId: string, patch: BlockPatch): Promise<void> {
    const d = await this.getDeck();
    const s = d.slides.find(s => s.id === slideId);
    if (!s) return;
    const b = s.blocks.find(b => b.id === blockId);
    if (!b) return;
    if (patch.props) {
      b.props = { ...b.props, ...patch.props };
    }
    const { props, ...rest } = patch;
    Object.assign(b, rest);
    await this.#save(d);
  }

  async removeBlock(slideId: string, blockId: string): Promise<void> {
    const d = await this.getDeck();
    const s = d.slides.find(s => s.id === slideId);
    if (!s) return;
    s.blocks = s.blocks.filter(b => b.id !== blockId);
    await this.#save(d);
  }

  async reorderBlock(slideId: string, blockId: string, toIndex: number): Promise<void> {
    const d = await this.getDeck();
    const s = d.slides.find(s => s.id === slideId);
    if (!s) return;
    const i = s.blocks.findIndex(b => b.id === blockId);
    if (i < 0) return;
    const [b] = s.blocks.splice(i, 1);
    const j = Math.max(0, Math.min(s.blocks.length, toIndex));
    s.blocks.splice(j, 0, b);
    await this.#save(d);
  }

  // -------- bulk ----------------------------------------------------------
  async setDeck(deck: Deck): Promise<void> {
    // Stamped as current: getDeck() reseeds a deck without the marker, which a caller building a
    // whole deck from the public type would otherwise lose on the next read.
    await this.#save({ ...deck, themeVersion: THEME_VERSION });
  }

  async resetAll(): Promise<Deck> {
    const d = initialDeck();
    await this.#save(d);
    return d;
  }

  // -------- realtime ------------------------------------------------------
  async subscribe(cb: DeckCallbacks): Promise<void> {
    this.subscribers.add(cb);
  }

  async #save(deck: Deck): Promise<void> {
    // Snapshot the previous deck onto the undo stack before overwriting.
    // The very first save (no prior deck in storage) doesn't push, and
    // calls from undo/redo bypass this method so they don't recurse.
    const prev = await this.state.storage.get<Deck>(STORAGE_KEY);
    if (prev) {
      this.undoStack.push(prev);
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
      // Any new mutation invalidates the redo branch.
      this.redoStack = [];
    }
    await this.state.storage.put(STORAGE_KEY, deck);
    this.#broadcast(deck);
  }

  // Delivery is the registry's: issued at once and never awaited, so a slow or
  // failing browser holds up neither the save nor the other subscribers.
  #broadcast(deck: Deck): void {
    const meta: UndoState = {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
    this.subscribers.broadcast(sub => sub.deckChanged(deck, meta));
  }
}

function genId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function newBlankSlide(): Slide {
  return {
    id: genId(),
    background: { color: "#F6821F", inset: false, coverOrange: true },
    blocks: [
      { id: genId(), type: "logo", x: 36, y: 56, w: 267, props: {} },
      { id: genId(), type: "title", x: 33, y: 197, w: 687,
        props: { text: "[TITLE]", fontSize: 58, weight: 700,
          color: "#FFFFFF", letterSpacing: "-0.03em", lineHeight: 1.1,
          highlight: "" } },
      { id: genId(), type: "subtitle", x: 36, y: 533, w: 553,
        props: { text: "[SUBTITLE]", fontSize: 17, weight: 600,
          color: "#FFFFFF", lineHeight: 1.5 } },
    ],
  };
}

function initialDeck(): Deck {
  // Build the four-slide starter deck. Clone all source objects so later
  // edits cannot mutate the blueprint used by future instances or resetAll().
  const deck = structuredClone(INITIAL_DECK);
  deck.slides.push(structuredClone(KEY_TAKEAWAYS_SLIDE));
  deck.slides.push(structuredClone(GET_STARTED_SLIDE));
  return deck;
}

const GET_STARTED_SLIDE: Slide = {
  id: "4f8c2d91",
  background: { color: "#FFFFFF", inset: false, dotGrid: 0 },
  blocks: [
    { id: "b8216c3a", type: "sectionLabel", x: 36, y: 35,
      props: { text: "GET STARTED" } },
    { id: "b63fe9a1", type: "title", x: 35, y: 76, w: 950,
      props: { text: "Two ways to get started", fontSize: 32, weight: 600,
        color: "#000000", letterSpacing: "-0.03em", lineHeight: 1.2,
        highlight: "" } },
    { id: "165a8f0c", type: "logo", x: 1013, y: 40,
      props: { variant: "dark", scale: 0.62 } },
    { id: "a1725e4f", type: "shape", x: 51, y: 199, w: 52, h: 52,
      props: { kind: "rect", fill: "#FFF8F2", stroke: "#F3D8C5", strokeWidth: 1, radius: 2 } },
    { id: "edit-input-frame", type: "shape", x: 63, y: 213, w: 28, h: 22,
      props: { kind: "rect", fill: "", stroke: "#F6821F", strokeWidth: 2, radius: 2 } },
    { id: "edit-input-line", type: "divider", x: 68, y: 224, w: 12, h: 2,
      props: { color: "#F6821F", opacity: 1 } },
    { id: "edit-input-caret", type: "divider", x: 83, y: 219, w: 2, h: 10,
      props: { color: "#F6821F", opacity: 1 } },
    { id: "edit-input-baseline", type: "divider", x: 70, y: 239, w: 14, h: 2,
      props: { color: "#F6821F", opacity: 1 } },
    { id: "db375e12", type: "text", x: 50, y: 282, w: 500,
      props: { text: "Click Edit", fontSize: 22, weight: 600,
        color: "#000000", family: "sans", align: "left", lineHeight: 1.3 } },
    { id: "d0c451ab", type: "text", x: 50, y: 330, w: 500,
      props: { text: "Click the pencil icon to add slides, insert components, edit content, and adjust the layout.",
        fontSize: 18, weight: 400, color: "#747474", family: "sans",
        align: "left", lineHeight: 1.55 } },
    { id: "8cf12ea4", type: "divider", x: 594, y: 198, w: 1, h: 260,
      props: { color: "#E5E5E5", opacity: 1 } },
    { id: "02d7fc35", type: "shape", x: 647, y: 199, w: 52, h: 52,
      props: { kind: "rect", fill: "#FFF8F2", stroke: "#F3D8C5", strokeWidth: 1, radius: 2 } },
    { id: "agent-chat-frame", type: "shape", x: 659, y: 212, w: 28, h: 22,
      props: { kind: "rect", fill: "#FFF8F2", stroke: "#F6821F", strokeWidth: 2, radius: 4 } },
    { id: "agent-chat-tail", type: "shape", x: 663, y: 231, w: 7, h: 8,
      props: { kind: "rect", fill: "#FFF8F2", stroke: "#F6821F", strokeWidth: 2, radius: 1 } },
    { id: "agent-chat-tail-join", type: "shape", x: 665, y: 230, w: 3, h: 4,
      props: { kind: "rect", fill: "#FFF8F2", strokeWidth: 0 } },
    { id: "agent-chat-dot-1", type: "shape", x: 665, y: 221, w: 3, h: 3,
      props: { kind: "ellipse", fill: "#F6821F", strokeWidth: 0 } },
    { id: "agent-chat-dot-2", type: "shape", x: 672, y: 221, w: 3, h: 3,
      props: { kind: "ellipse", fill: "#F6821F", strokeWidth: 0 } },
    { id: "agent-chat-dot-3", type: "shape", x: 679, y: 221, w: 3, h: 3,
      props: { kind: "ellipse", fill: "#F6821F", strokeWidth: 0 } },
    { id: "47a8d50c", type: "text", x: 646, y: 282, w: 500,
      props: { text: "Ask the agent", fontSize: 22, weight: 600,
        color: "#000000", family: "sans", align: "left", lineHeight: 1.3 } },
    { id: "d941a7b6", type: "text", x: 646, y: 330, w: 500,
      props: { text: "Ask the agent to create slides, add charts, connect approved internal data, or build your own components for a fully customized deck.",
        fontSize: 18, weight: 400, color: "#747474", family: "sans",
        align: "left", lineHeight: 1.55 } },
    { id: "4aa013dc", type: "text", x: 36, y: 562, w: 1128,
      props: { text: "Use either approach, or switch between them at any time.",
        fontSize: 18, weight: 600, color: "#000000", family: "sans",
        align: "center", lineHeight: 1.4 } },
    { id: "50db219e", type: "shape", x: 0, y: 663, w: 1200, h: 12,
      props: { kind: "rect", fill: "#F6821F", stroke: "", strokeWidth: 0, radius: 0,
        opacity: 1 } },
  ],
};

const KEY_TAKEAWAYS_SLIDE: Slide = {
  id: "6a7e5ae2",
  background: { color: "#FFFFFF", inset: false, dotGrid: 0 },
  blocks: [
    { id: "e6fd515b", type: "sectionLabel", x: 36, y: 35,
      props: { text: "CONNECTED CHARTS" } },
    { id: "67fefcc4", type: "title", x: 35, y: 76, w: 950,
      props: { text: "Turn internal data into presentation-ready charts",
        fontSize: 32, weight: 600, color: "#000000",
        letterSpacing: "-0.03em", lineHeight: 1.2, highlight: "" } },
    { id: "16c8d805", type: "logo", x: 1013, y: 40,
      props: { variant: "dark", scale: 0.62 } },
    { id: "2b48e66e", type: "text", x: 36, y: 187, w: 730, h: 24,
      props: { text: "Quarterly adoption", fontSize: 16, weight: 600, color: "#000000", lineHeight: 1.2 } },
    { id: "adoption-subtitle", type: "text", x: 36, y: 215, w: 730, h: 18,
      props: { text: "Illustrative data • refreshed from your system of record", fontSize: 12, color: "#747474", lineHeight: 1.2 } },
    { id: "adoption-grid-1", type: "divider", x: 36, y: 323, w: 730, h: 1,
      props: { color: "#EEEEEE", opacity: 1 } },
    { id: "adoption-grid-2", type: "divider", x: 36, y: 393, w: 730, h: 1,
      props: { color: "#EEEEEE", opacity: 1 } },
    { id: "adoption-grid-3", type: "divider", x: 36, y: 463, w: 730, h: 1,
      props: { color: "#EEEEEE", opacity: 1 } },
    { id: "adoption-baseline", type: "divider", x: 36, y: 533, w: 730, h: 1,
      props: { color: "#D9D9D9", opacity: 1 } },
    { id: "adoption-q1-bar", type: "shape", x: 94, y: 426, w: 92, h: 107,
      props: { kind: "rect", fill: "#FF6633", strokeWidth: 0, radius: 2 } },
    { id: "adoption-q2-bar", type: "shape", x: 258, y: 372, w: 92, h: 161,
      props: { kind: "rect", fill: "#F6821F", strokeWidth: 0, radius: 2 } },
    { id: "adoption-q3-bar", type: "shape", x: 422, y: 328, w: 92, h: 205,
      props: { kind: "rect", fill: "#FBAD41", strokeWidth: 0, radius: 2 } },
    { id: "adoption-q4-bar", type: "shape", x: 586, y: 279, w: 92, h: 254,
      props: { kind: "rect", fill: "#F6821F", strokeWidth: 0, radius: 2 } },
    { id: "adoption-q1-label", type: "text", x: 94, y: 547, w: 92, h: 20,
      props: { text: "Q1", fontSize: 13, color: "#747474", align: "center", lineHeight: 1.2 } },
    { id: "adoption-q2-label", type: "text", x: 258, y: 547, w: 92, h: 20,
      props: { text: "Q2", fontSize: 13, color: "#747474", align: "center", lineHeight: 1.2 } },
    { id: "adoption-q3-label", type: "text", x: 422, y: 547, w: 92, h: 20,
      props: { text: "Q3", fontSize: 13, color: "#747474", align: "center", lineHeight: 1.2 } },
    { id: "adoption-q4-label", type: "text", x: 586, y: 547, w: 92, h: 20,
      props: { text: "Q4", fontSize: 13, color: "#747474", align: "center", lineHeight: 1.2 } },
    { id: "adoption-q1-value", type: "text", x: 94, y: 401, w: 92, h: 20,
      props: { text: "38", fontSize: 14, weight: 600, color: "#000000", align: "center", lineHeight: 1.2 } },
    { id: "adoption-q2-value", type: "text", x: 258, y: 347, w: 92, h: 20,
      props: { text: "57", fontSize: 14, weight: 600, color: "#000000", align: "center", lineHeight: 1.2 } },
    { id: "adoption-q3-value", type: "text", x: 422, y: 303, w: 92, h: 20,
      props: { text: "73", fontSize: 14, weight: 600, color: "#000000", align: "center", lineHeight: 1.2 } },
    { id: "adoption-q4-value", type: "text", x: 586, y: 254, w: 92, h: 20,
      props: { text: "91", fontSize: 14, weight: 600, color: "#000000", align: "center", lineHeight: 1.2 } },
    { id: "adoption-source-panel", type: "shape", x: 831, y: 270, w: 333, h: 245,
      props: { kind: "rect", fill: "#FFF8F2", stroke: "#F3D8C5", strokeWidth: 1, radius: 2 } },
    { id: "adoption-source-heading", type: "text", x: 855, y: 297, w: 285, h: 18,
      props: { text: "LIVE DATA, READY TO PRESENT", fontSize: 11, weight: 600, letterSpacing: "1px", color: "#FF6633", lineHeight: 1.2 } },
    { id: "adoption-source-title", type: "text", x: 855, y: 328, w: 285, h: 54,
      props: { text: "Ask the agent to add chart\nfrom internal data source.", fontSize: 20, weight: 600, color: "#000000", lineHeight: 1.3 } },
    { id: "adoption-source-copy", type: "text", x: 855, y: 401, w: 285, h: 66,
      props: { text: "Or connect an approved internal\nsystem of record so an agent can\npull, shape, and refresh the data.", fontSize: 14, color: "#747474", lineHeight: 1.57 } },
    { id: "adoption-source-status-dot", type: "shape", x: 854, y: 484, w: 8, h: 8,
      props: { kind: "ellipse", fill: "#26A641", strokeWidth: 0 } },
    { id: "adoption-source-status", type: "text", x: 872, y: 481, w: 268, h: 18,
      props: { text: "Connected source", fontSize: 12, weight: 600, color: "#000000", lineHeight: 1.2 } },
    { id: "39af0189", type: "shape", x: 0, y: 663, w: 1200, h: 12,
      props: { kind: "rect", fill: "#F6821F", stroke: "", strokeWidth: 0, radius: 0,
        opacity: 1 } },
  ],
};

const INITIAL_DECK: Deck = {
  themeVersion: THEME_VERSION,
  slides: [
    {
      id: "a8dd8e44",
      background: { color: "#F6821F", inset: false, coverOrange: true },
      blocks: [
        { id: "7d2196db", type: "logo", x: 36, y: 56, w: 267, props: {} },
        { id: "44e96d7c", type: "title", x: 33, y: 197, w: 687,
          props: { text: "Compose your deck or build with agent.\n", fontSize: 58,
            weight: 700, color: "#FFFFFF", letterSpacing: "-0.03em",
            lineHeight: 1.1, highlight: "" } },
        { id: "2b69cd51", type: "subtitle", x: 36, y: 533, w: 553,
          props: { text: "Press E to edit. Add slides, drop in components, drag to move, then F to present.\n",
            fontSize: 17, weight: 600, color: "#FFFFFF", lineHeight: 1.5 } },
      ],
    },
    {
      id: "935d6824",
      background: { color: "#FFFFFF", inset: false, dotGrid: 0 },
      blocks: [
        { id: "a10324fe", type: "sectionLabel", x: 36, y: 35,
          props: { text: "SLIDE BUILDER" } },
        { id: "6457b707", type: "title", x: 35, y: 76, w: 984,
          props: { text: "One canvas gives you everything you need to build and refine a deck",
            fontSize: 28, weight: 600, color: "#000000", letterSpacing: "-0.03em",
            lineHeight: 1.2, highlight: "" } },
        { id: "7221dd20", type: "logo", x: 1013, y: 40,
          props: { variant: "dark", scale: 0.62, text: "Workspace", accentDot: true } },
        { id: "7a5a9052", type: "shape", x: 0, y: 663, w: 1200, h: 12,
          props: { kind: "rect", fill: "#F6821F", stroke: "", strokeWidth: 0, radius: 0,
            opacity: 1 } },
        { id: "ac789ac0", type: "text", x: 36, y: 184, w: 55,
          props: { text: "01", fontSize: 16, color: "#FF6633", weight: 600,
            family: "sans", align: "left", lineHeight: 1.2 } },
        { id: "9ab784eb", type: "divider", x: 36, y: 218, w: 36, h: 3,
          props: { color: "#F6821F", opacity: 1 } },
        { id: "c42d52f0", type: "text", x: 36, y: 242, w: 330,
          props: { text: "Templates", fontSize: 18, color: "#000000", weight: 600,
            family: "sans", align: "left", lineHeight: 1.2 } },
        { id: "b83685ca", type: "text", x: 36, y: 276, w: 320,
          props: { text: "Start with title, narrative, two-column, or four-column layouts.",
            fontSize: 15, color: "#747474", weight: 400, family: "sans",
            align: "left", lineHeight: 1.5 } },
        { id: "557dd2fd", type: "text", x: 425, y: 184, w: 55,
          props: { text: "02", fontSize: 16, color: "#FF6633", weight: 600,
            family: "sans", align: "left", lineHeight: 1.2 } },
        { id: "bc20fe5a", type: "divider", x: 425, y: 218, w: 36, h: 3,
          props: { color: "#F6821F", opacity: 1 } },
        { id: "fd610310", type: "text", x: 425, y: 242, w: 330,
          props: { text: "Components", fontSize: 18, color: "#000000", weight: 600,
            family: "sans", align: "left", lineHeight: 1.2 } },
        { id: "aa3db0c3", type: "text", x: 425, y: 276, w: 320,
          props: { text: "Add text, cards, media, shapes, and diagrams from one library.",
            fontSize: 15, color: "#747474", weight: 400, family: "sans",
            align: "left", lineHeight: 1.5 } },
        { id: "57cf5870", type: "text", x: 814, y: 184, w: 55,
          props: { text: "03", fontSize: 16, color: "#FF6633", weight: 600,
            family: "sans", align: "left", lineHeight: 1.2 } },
        { id: "b64e4086", type: "divider", x: 814, y: 218, w: 36, h: 3,
          props: { color: "#F6821F", opacity: 1 } },
        { id: "7c2fb36f", type: "text", x: 814, y: 242, w: 330,
          props: { text: "Direct editing", fontSize: 18, color: "#000000", weight: 600,
            family: "sans", align: "left", lineHeight: 1.2 } },
        { id: "30668753", type: "text", x: 814, y: 276, w: 320,
          props: { text: "Edit copy inline and tune every block in the inspector.",
            fontSize: 15, color: "#747474", weight: 400, family: "sans",
            align: "left", lineHeight: 1.5 } },
        { id: "4813a65d", type: "text", x: 36, y: 408, w: 55,
          props: { text: "04", fontSize: 16, color: "#FF6633", weight: 600,
            family: "sans", align: "left", lineHeight: 1.2 } },
        { id: "e434b278", type: "divider", x: 36, y: 442, w: 36, h: 3,
          props: { color: "#F6821F", opacity: 1 } },
        { id: "630ea5b1", type: "text", x: 36, y: 466, w: 330,
          props: { text: "Layout controls", fontSize: 18, color: "#000000", weight: 600,
            family: "sans", align: "left", lineHeight: 1.2 } },
        { id: "fab3ac08", type: "text", x: 36, y: 500, w: 320,
          props: { text: "Drag, resize, reorder, and snap blocks to precise guides.",
            fontSize: 15, color: "#747474", weight: 400, family: "sans",
            align: "left", lineHeight: 1.5 } },
        { id: "56ff718c", type: "text", x: 425, y: 408, w: 55,
          props: { text: "05", fontSize: 16, color: "#FF6633", weight: 600,
            family: "sans", align: "left", lineHeight: 1.2 } },
        { id: "b52192c2", type: "divider", x: 425, y: 442, w: 36, h: 3,
          props: { color: "#F6821F", opacity: 1 } },
        { id: "545fab77", type: "text", x: 425, y: 466, w: 330,
          props: { text: "Live collaboration", fontSize: 18, color: "#000000", weight: 600,
            family: "sans", align: "left", lineHeight: 1.2 } },
        { id: "c940701b", type: "text", x: 425, y: 500, w: 320,
          props: { text: "Keep connected editors in sync with shared undo and redo.",
            fontSize: 15, color: "#747474", weight: 400, family: "sans",
            align: "left", lineHeight: 1.5 } },
        { id: "6700f2e6", type: "text", x: 814, y: 408, w: 55,
          props: { text: "06", fontSize: 16, color: "#FF6633", weight: 600,
            family: "sans", align: "left", lineHeight: 1.2 } },
        { id: "fb4710ef", type: "divider", x: 814, y: 442, w: 36, h: 3,
          props: { color: "#F6821F", opacity: 1 } },
        { id: "b903c07f", type: "text", x: 814, y: 466, w: 330,
          props: { text: "Present anywhere", fontSize: 18, color: "#000000", weight: 600,
            family: "sans", align: "left", lineHeight: 1.2 } },
        { id: "8f8a19cf", type: "text", x: 814, y: 500, w: 320,
          props: { text: "Go full screen, jump between slides, and navigate by keyboard.",
            fontSize: 15, color: "#747474", weight: 400, family: "sans",
            align: "left", lineHeight: 1.5 } },
      ],
    },
  ],
};

// Retained for compatibility with older code paths and as a component demo.
function defaultDeck(): Deck {
  return {
    slides: [
      // ----- Slide 1: cover ------------------------------------------------
      {
        id: genId(),
        background: { inset: true, dotGrid: 0.45 },
        blocks: [
          { id: genId(), type: "sectionLabel", x: 48, y: 38,
            props: { text: "Slide builder" } },
          { id: genId(), type: "logo", x: 1080, y: 38, props: {} },
          { id: genId(), type: "gadgetsMark", x: 48, y: 240,
            props: { size: "large" } },
          { id: genId(), type: "title", x: 48, y: 340, w: 1040,
            props: { text: "Compose your deck from primitives.",
                     fontSize: 46, highlight: "primitives" } },
          { id: genId(), type: "subtitle", x: 48, y: 430, w: 980,
            props: { text: "Press E to edit. Add slides, drop in components, drag to move, then F to present." } },
        ],
      },
      // ----- Slide 2: cards in 4 tones ------------------------------------
      {
        id: genId(),
        background: { inset: true },
        blocks: [
          { id: genId(), type: "sectionLabel", x: 48, y: 38,
            props: { text: "Components" } },
          { id: genId(), type: "logo", x: 1080, y: 38, props: {} },
          { id: genId(), type: "title", x: 48, y: 78, w: 1040,
            props: { text: "Cards come in tones.", fontSize: 42,
                     highlight: "tones" } },
          { id: genId(), type: "subtitle", x: 48, y: 152, w: 1040,
            props: { text: "Each card carries a tone, an optional top stripe, an eyebrow, a title, and body copy." } },
          { id: genId(), type: "card", x: 48,  y: 268, w: 264, h: 296,
            props: { tone: "orange", topStripe: true, eyebrow: "01",
                     title: "Composable", body: "Every slide is just a list of blocks." } },
          { id: genId(), type: "card", x: 328, y: 268, w: 264, h: 296,
            props: { tone: "blue", topStripe: true, eyebrow: "02",
                     title: "Themed", body: "Tones, fonts and spacing come from one set of tokens." } },
          { id: genId(), type: "card", x: 608, y: 268, w: 264, h: 296,
            props: { tone: "purple", topStripe: true, eyebrow: "03",
                     title: "Live", body: "Edits sync across every connected viewer in real time." } },
          { id: genId(), type: "card", x: 888, y: 268, w: 264, h: 296,
            props: { tone: "green", topStripe: true, eyebrow: "04",
                     title: "Yours", body: "Add or remove slides, drag blocks anywhere on the canvas." } },
        ],
      },
      // ----- Slide 3: diagram (boxes + arrows) ----------------------------
      {
        id: genId(),
        background: { inset: true },
        blocks: [
          { id: genId(), type: "sectionLabel", x: 48, y: 38,
            props: { text: "Diagrams" } },
          { id: genId(), type: "logo", x: 1080, y: 38, props: {} },
          { id: genId(), type: "title", x: 48, y: 78, w: 1040,
            props: { text: "Boxes and arrows, no Figma required.",
                     fontSize: 40, highlight: "arrows" } },
          { id: genId(), type: "subtitle", x: 48, y: 150, w: 1040,
            props: { text: "Use the box and arrow blocks to sketch flows. Arrows take endpoints in slide coordinates." } },
          { id: genId(), type: "box", x: 96,  y: 340, w: 220, h: 110,
            props: { tone: "neutral", title: "Source",
                     body: "Where it starts" } },
          { id: genId(), type: "box", x: 490, y: 340, w: 220, h: 110,
            props: { tone: "blue", title: "Gatekeeper",
                     body: "Where it’s checked" } },
          { id: genId(), type: "box", x: 884, y: 340, w: 220, h: 110,
            props: { tone: "orange", title: "Destination",
                     body: "Where it lands" } },
          { id: genId(), type: "arrow", x: 0, y: 0,
            props: { x1: 316, y1: 395, x2: 490, y2: 395,
                     color: "blue", label: "request" } },
          { id: genId(), type: "arrow", x: 0, y: 0,
            props: { x1: 710, y1: 395, x2: 884, y2: 395,
                     color: "orange", label: "approved" } },
          { id: genId(), type: "tonePill", x: 96, y: 500,
            props: { tone: "neutral", text: "EXTERNAL" } },
          { id: genId(), type: "tonePill", x: 490, y: 500,
            props: { tone: "blue", text: "POLICY" } },
          { id: genId(), type: "tonePill", x: 884, y: 500,
            props: { tone: "orange", text: "INTERNAL" } },
        ],
      },
    ],
  };
}


const SLIDES_EXPORT_FORMATS = [
  { id: "html", label: "HTML", mode: "browser", contentType: "text/html", fileExtension: ".html" },
  { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
  { id: "pptx", label: "PowerPoint", mode: "server", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", fileExtension: ".pptx" },
];

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats() {
    return SLIDES_EXPORT_FORMATS;
  }

  async export(gadget: GadgetStub, id: string): Promise<ReadableStream<Uint8Array>> {
    if (id === "pptx") {
      const deck = await gadget.getDeck();
      const budget = { remaining: MAX_TOTAL_TEXT_LENGTH };
      // The renderer validates every authored slide/block quota before expanding logos.
      return deckToPptx(deck, (block) => isLogoBlock(block) ? logoBlocks(block, budget) : undefined);
    }
    throw new Error("Unsupported slides export format: " + id);
  }
}


function isLogoBlock(block: unknown): block is Record<string, unknown> & {type: "logo"} {
  return block !== null && typeof block === "object" && !Array.isArray(block) &&
    (block as Record<string, unknown>).type === "logo";
}

// The logo component's styling, from client.ts: a 24px bold wordmark tracked -0.02em at
// line-height 1, then a 3px flex gap and a 6px dot whose bottom sits 1px above the baseline.
const LOGO_FONT_PX = 24;
const LOGO_TRACKING_EM = -0.02;
const LOGO_GAP_PX = 3;
const LOGO_DOT_PX = 6;

function logoScale(value: unknown): number {
  const scale = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return scale && Number.isFinite(scale) ? Math.max(0.01, Math.min(20, scale)) : 1;
}

function logoBlocks(block: Record<string, unknown>, budget: {remaining: number}): Array<Record<string, unknown>> {
  const rawProps = block.props;
  const props = rawProps !== null && typeof rawProps === "object" && !Array.isArray(rawProps)
    ? rawProps as Record<string, unknown>
    : {};
  const scale = logoScale(props.scale);
  const x = Number(block.x);
  const y = Number(block.y);
  const fontSize = LOGO_FONT_PX * scale;
  const tracking = LOGO_TRACKING_EM * fontSize;
  const raw = props.text == null ? "Workspace" : typeof props.text === "object" ? "" : String(props.text);
  budget.remaining -= raw.length;
  if (budget.remaining < 0) return [{ type: "text", x, y, props: { text: raw } }];

  const text = raw.replace(/[\t\n\r ]+/g, " ").trim();
  const { width, ascent, lineHeight } = measureText(text, fontSize, 700, tracking);
  const halfLeading = (lineHeight - fontSize) / 2;
  const baseline = y + ascent - halfLeading;
  const blocks: Array<Record<string, unknown>> = [{
    type: "text",
    x,
    y: y - halfLeading,
    w: Math.max(fontSize / 2, width * 1.02) + 8 * scale,
    h: lineHeight,
    props: {
      text, fontSize, weight: 700, letterSpacing: `${LOGO_TRACKING_EM}em`,
      lineHeight: lineHeight / fontSize, align: "left",
      color: props.variant === "dark" ? "#000000" : "#FFFFFF",
    },
  }];
  if (props.accentDot !== false) {
    blocks.push({
      type: "shape",
      x: x + (text ? width + tracking : 0) + LOGO_GAP_PX * scale,
      y: baseline - (LOGO_DOT_PX + 1) * scale,
      w: LOGO_DOT_PX * scale,
      h: LOGO_DOT_PX * scale,
      props: { kind: "ellipse", fill: "#F6821F" },
    });
  }
  return blocks;
}
