import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

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
 * All shape/render logic lives in client.js; the server is a dumb document
 * store with realtime broadcast. Mutations are coarse: any change re-sends
 * the whole deck, which keeps clients trivially in sync and makes undo
 * (future) easy.
 */

const STORAGE_KEY = "deck";
const MAX_UNDO = 50;

export class Gadget extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.subscribers = new Set();
    // Undo/redo stacks live in memory only — they're transient and
    // shared across every connected client (one global history for the
    // whole deck). On DO restart history is lost, which we consider
    // acceptable. Each entry is a full deck snapshot (deep clone).
    this.undoStack = [];
    this.redoStack = [];
  }

  // -------- undo / redo ---------------------------------------------------
  async getUndoState() {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }

  async undo() {
    if (this.undoStack.length === 0) return false;
    const prev = this.undoStack.pop();
    const current = await this.state.storage.get(STORAGE_KEY);
    if (current) this.redoStack.push(current);
    await this.state.storage.put(STORAGE_KEY, prev);
    await this.#broadcast(prev);
    return true;
  }

  async redo() {
    if (this.redoStack.length === 0) return false;
    const next = this.redoStack.pop();
    const current = await this.state.storage.get(STORAGE_KEY);
    if (current) this.undoStack.push(current);
    await this.state.storage.put(STORAGE_KEY, next);
    await this.#broadcast(next);
    return true;
  }

  // -------- read ----------------------------------------------------------
  async getDeck() {
    let d = await this.state.storage.get(STORAGE_KEY);
    // Defensive: if the storage was empty OR holds an older-schema document
    // (the previous version of this Gadget stored field overrides under
    // numeric keys rather than a `slides` array), wipe and seed.
    if (!d || !Array.isArray(d.slides) || d.themeVersion !== "workspace.1") {
      d = initialDeck();
      await this.state.storage.put(STORAGE_KEY, d);
    }
    return d;
  }

  // -------- slide ops -----------------------------------------------------
  async addSlide(atIndex, slide) {
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
    d.slides.splice(i, 0, s);
    await this.#save(d);
    return s.id;
  }

  async removeSlide(slideId) {
    const d = await this.getDeck();
    d.slides = d.slides.filter(s => s.id !== slideId);
    if (d.slides.length === 0) d.slides.push(newBlankSlide());
    await this.#save(d);
  }

  async duplicateSlide(slideId) {
    const d = await this.getDeck();
    const i = d.slides.findIndex(s => s.id === slideId);
    if (i < 0) return null;
    const copy = JSON.parse(JSON.stringify(d.slides[i]));
    copy.id = genId();
    copy.blocks = (copy.blocks || []).map(b => ({ ...b, id: genId() }));
    d.slides.splice(i + 1, 0, copy);
    await this.#save(d);
    return copy.id;
  }

  async moveSlide(slideId, toIndex) {
    const d = await this.getDeck();
    const i = d.slides.findIndex(s => s.id === slideId);
    if (i < 0) return;
    const [s] = d.slides.splice(i, 1);
    const j = Math.max(0, Math.min(d.slides.length, toIndex));
    d.slides.splice(j, 0, s);
    await this.#save(d);
  }

  async updateSlide(slideId, patch) {
    const d = await this.getDeck();
    const s = d.slides.find(s => s.id === slideId);
    if (!s) return;
    if (patch.background) s.background = { ...s.background, ...patch.background };
    const { background, ...rest } = patch;
    Object.assign(s, rest);
    await this.#save(d);
  }

  // -------- block ops -----------------------------------------------------
  async addBlock(slideId, block, atIndex) {
    const d = await this.getDeck();
    const s = d.slides.find(s => s.id === slideId);
    if (!s) return null;
    const b = { id: genId(), ...block };
    if (!b.id) b.id = genId();
    if (atIndex == null) s.blocks.push(b);
    else s.blocks.splice(atIndex, 0, b);
    await this.#save(d);
    return b.id;
  }

  async updateBlock(slideId, blockId, patch) {
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

  async removeBlock(slideId, blockId) {
    const d = await this.getDeck();
    const s = d.slides.find(s => s.id === slideId);
    if (!s) return;
    s.blocks = s.blocks.filter(b => b.id !== blockId);
    await this.#save(d);
  }

  async reorderBlock(slideId, blockId, toIndex) {
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
  async setDeck(deck) {
    await this.#save(deck);
  }

  async resetAll() {
    const d = initialDeck();
    await this.#save(d);
    return d;
  }

  // -------- realtime ------------------------------------------------------
  async subscribe(cb) {
    const dup = cb.dup();
    this.subscribers.add(dup);
    dup.onRpcBroken(() => this.subscribers.delete(dup));
  }

  async #save(deck) {
    // Snapshot the previous deck onto the undo stack before overwriting.
    // The very first save (no prior deck in storage) doesn't push, and
    // calls from undo/redo bypass this method so they don't recurse.
    const prev = await this.state.storage.get(STORAGE_KEY);
    if (prev) {
      this.undoStack.push(prev);
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
      // Any new mutation invalidates the redo branch.
      this.redoStack = [];
    }
    await this.state.storage.put(STORAGE_KEY, deck);
    await this.#broadcast(deck);
  }

  async #broadcast(deck) {
    const meta = {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
    for (const sub of this.subscribers) {
      try { sub.deckChanged(deck, meta); }
      catch (e) { this.subscribers.delete(sub); }
    }
  }
}

function genId() {
  return crypto.randomUUID().slice(0, 8);
}

function newBlankSlide() {
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

function initialDeck() {
  // Build the four-slide starter deck. Clone all source objects so later
  // edits cannot mutate the blueprint used by future instances or resetAll().
  const deck = structuredClone(INITIAL_DECK);
  deck.slides.push(structuredClone(KEY_TAKEAWAYS_SLIDE));
  deck.slides.push(structuredClone(GET_STARTED_SLIDE));
  return deck;
}

const GET_STARTED_SLIDE = {
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
    { id: "a1725e4f", type: "svg", x: 50, y: 198, w: 54, h: 54,
      props: { markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 54 54"><rect x="1" y="1" width="52" height="52" rx="2" fill="#FFF8F2" stroke="#F3D8C5"/><g transform="translate(15 15)" fill="none" stroke="#F6821F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></g></svg>`, fit: "contain", background: "" } },
    { id: "db375e12", type: "text", x: 50, y: 282, w: 500,
      props: { text: "Click Edit", fontSize: 22, weight: 600,
        color: "#000000", family: "sans", align: "left", lineHeight: 1.3 } },
    { id: "d0c451ab", type: "text", x: 50, y: 330, w: 500,
      props: { text: "Click the pencil icon to add slides, insert components, edit content, and adjust the layout.",
        fontSize: 18, weight: 400, color: "#747474", family: "sans",
        align: "left", lineHeight: 1.55 } },
    { id: "8cf12ea4", type: "divider", x: 594, y: 198, w: 1, h: 260,
      props: { color: "#E5E5E5", opacity: 1 } },
    { id: "02d7fc35", type: "svg", x: 646, y: 198, w: 54, h: 54,
      props: { markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 54 54"><rect x="1" y="1" width="52" height="52" rx="2" fill="#FFF8F2" stroke="#F3D8C5"/><g transform="translate(15 15)" fill="none" stroke="#F6821F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.5 5.5L19 9l-5.5 1.5L12 16l-1.5-5.5L5 9l5.5-1.5L12 2z"/><path d="M20 15l.8 3.2L24 19l-3.2.8L20 23l-.8-3.2L16 19l3.2-.8L20 15z"/><path d="M4 14l.7 2.3L7 17l-2.3.7L4 20l-.7-2.3L1 17l2.3-.7L4 14z"/></g></svg>`, fit: "contain", background: "" } },
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
    { id: "50db219e", type: "svg", x: 0, y: 663, w: 1200, h: 12,
      props: { markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 12" preserveAspectRatio="none"><defs><linearGradient id="g"><stop stop-color="#FF6633"/><stop offset=".5" stop-color="#F6821F"/><stop offset="1" stop-color="#FBAD41"/></linearGradient></defs><rect width="1200" height="12" fill="url(#g)"/></svg>`,
        fit: "stretch", background: "" } },
  ],
};

const KEY_TAKEAWAYS_SLIDE = {
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
    { id: "2b48e66e", type: "svg", x: 36, y: 178, w: 1128, h: 430,
      props: { markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1128 430" role="img" aria-label="Example bar chart showing connected internal data"><rect width="1128" height="430" fill="#fff"/><text x="0" y="25" font-family="Inter,Arial,sans-serif" font-size="16" font-weight="600" fill="#000">Quarterly adoption</text><text x="0" y="49" font-family="Inter,Arial,sans-serif" font-size="12" fill="#747474">Illustrative data • refreshed from your system of record</text><g transform="translate(0 75)"><line x1="0" y1="280" x2="730" y2="280" stroke="#D9D9D9"/><line x1="0" y1="210" x2="730" y2="210" stroke="#EEEEEE"/><line x1="0" y1="140" x2="730" y2="140" stroke="#EEEEEE"/><line x1="0" y1="70" x2="730" y2="70" stroke="#EEEEEE"/><rect x="58" y="173" width="92" height="107" rx="2" fill="#FF6633"/><rect x="222" y="119" width="92" height="161" rx="2" fill="#F6821F"/><rect x="386" y="75" width="92" height="205" rx="2" fill="#FBAD41"/><rect x="550" y="26" width="92" height="254" rx="2" fill="#F6821F"/><g font-family="Inter,Arial,sans-serif" font-size="13" fill="#747474" text-anchor="middle"><text x="104" y="307">Q1</text><text x="268" y="307">Q2</text><text x="432" y="307">Q3</text><text x="596" y="307">Q4</text></g><g font-family="Inter,Arial,sans-serif" font-size="14" font-weight="600" fill="#000" text-anchor="middle"><text x="104" y="162">38</text><text x="268" y="108">57</text><text x="432" y="64">73</text><text x="596" y="15">91</text></g></g><g transform="translate(795 92)"><rect width="333" height="245" rx="2" fill="#FFF8F2" stroke="#F3D8C5"/><text x="24" y="38" font-family="Inter,Arial,sans-serif" font-size="11" font-weight="600" letter-spacing="1" fill="#FF6633">LIVE DATA, READY TO PRESENT</text><text x="24" y="78" font-family="Inter,Arial,sans-serif" font-size="20" font-weight="600" fill="#000">Ask the agent to add chart</text><text x="24" y="104" font-family="Inter,Arial,sans-serif" font-size="20" font-weight="600" fill="#000">from internal data source.</text><text x="24" y="145" font-family="Inter,Arial,sans-serif" font-size="14" fill="#747474">Or connect an approved internal</text><text x="24" y="167" font-family="Inter,Arial,sans-serif" font-size="14" fill="#747474">system of record so an agent can</text><text x="24" y="189" font-family="Inter,Arial,sans-serif" font-size="14" fill="#747474">pull, shape, and refresh the data.</text><circle cx="27" cy="218" r="4" fill="#26A641"/><text x="41" y="223" font-family="Inter,Arial,sans-serif" font-size="12" font-weight="600" fill="#000">Connected source</text></g></svg>`,
        fit: "contain", background: "" } },
    { id: "39af0189", type: "svg", x: 0, y: 663, w: 1200, h: 12,
      props: { markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 12" preserveAspectRatio="none"><defs><linearGradient id="g"><stop stop-color="#FF6633"/><stop offset=".5" stop-color="#F6821F"/><stop offset="1" stop-color="#FBAD41"/></linearGradient></defs><rect width="1200" height="12" fill="url(#g)"/></svg>`,
        fit: "stretch", background: "" } },
  ],
};

const INITIAL_DECK = {
  themeVersion: "workspace.1",
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
        { id: "7a5a9052", type: "svg", x: 0, y: 663, w: 1200, h: 12,
          props: { markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 12" preserveAspectRatio="none"><defs><linearGradient id="g"><stop stop-color="#FF6633"/><stop offset=".5" stop-color="#F6821F"/><stop offset="1" stop-color="#FBAD41"/></linearGradient></defs><rect width="1200" height="12" fill="url(#g)"/></svg>`,
            fit: "stretch", background: "" } },
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
function defaultDeck() {
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
];

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats() {
    return SLIDES_EXPORT_FORMATS;
  }

  async export(_gadget, id) {
    throw new Error("Unsupported slides export format: " + id);
  }
}
