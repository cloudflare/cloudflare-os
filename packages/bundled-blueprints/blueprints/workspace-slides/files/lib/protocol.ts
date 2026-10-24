/**
 * The contract between the Slides gadget's two halves: the deck document `server.ts` stores and
 * broadcasts, the patches it sends each subscribed browser, the summaries agents read, and the
 * RPC surface `client.ts` calls. Type-only -- both entries import it with `import type`, so
 * nothing here ships in the bundled gadget.
 */

/** A set block prop's value: the deck is JSON, and every prop is a string, number or flag (`BlockProps` adds null, for unset). */
export type PropValue = string | number | boolean;

/**
 * A block's type-specific props. The named keys are the ones the client's COMPONENTS render and
 * edit (each component reads its own subset) and the PowerPoint exporter reads; the index
 * signature carries anything else, since the server stores props opaquely and merges patches key
 * by key. Big media values (`src`, `markup`, any long `data:` string) are stored as
 * `"asset:<hash>"` refs.
 */
export interface BlockProps {
  [key: string]: PropValue | null | undefined;
  text?: string | null;
  fontSize?: number;
  weight?: number | string;
  color?: string;
  letterSpacing?: string;
  lineHeight?: number;
  highlight?: string;
  variant?: string;
  scale?: number;
  /** Ignored: logos once ended in an accent full stop. Kept so older decks still type-check. */
  accentDot?: boolean;
  size?: string;
  family?: string;
  align?: string;
  treatment?: string;
  tone?: string;
  topStripe?: boolean;
  eyebrow?: string;
  title?: string;
  body?: string;
  dashed?: boolean;
  opacity?: number;
  kind?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
  src?: string;
  fit?: string;
  alt?: string;
  markup?: string;
  background?: string;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  label?: string;
  width?: number;
}

/** One block on a slide: a component type at a position in 1200x675 slide coordinates, with its props. */
export interface Block {
  id: string;
  type: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  props: BlockProps;
}

/** A block as handed to `addBlock` / `addBlocks`: the server mints the id when it is missing or taken. */
export type BlockInput = Omit<Block, "id"> & { id?: string };

/** A slide's background: fill colour, the inset surface, the dot grid's opacity, and the orange cover art. */
export interface SlideBackground {
  color?: string;
  inset?: boolean;
  dotGrid?: number;
  coverOrange?: boolean;
}

/** One slide of the deck. */
export interface Slide {
  id: string;
  background: SlideBackground;
  blocks: Block[];
}

/** The named slide layouts (lib/layouts.ts): the cover, a narrative content slide, and two- and four-column content slides. */
export type SlideLayout = "title" | "content" | "twoColumn" | "fourColumn";

/**
 * A slide as handed to `addSlide`: the server fills in a missing id and mints ids for blocks that
 * lack one. `layout` builds the slide from that layout's template (then `blocks` must be absent,
 * and `background` is merged over the template's). Without a layout, a background missing
 * `inset` gets `inset: false`, and one missing `color` is white.
 */
export interface SlideInput {
  id?: string;
  layout?: SlideLayout;
  background?: SlideBackground;
  blocks?: BlockInput[];
}

/** The slide corner the deck logo sits in. */
export type LogoPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/**
 * The deck logo: one image, drawn at the same corner and size on every slide (cover slides too
 * unless `onCover` is false), above the background and below the slide's blocks. `src` is a PNG,
 * JPEG or SVG `data:` URI, or the `"asset:<hash>"` ref it is stored as; `alt` defaults to "Logo".
 */
export interface DeckLogo {
  src: string;
  position: LogoPosition;
  onCover: boolean;
  alt?: string;
}

/** A change to the deck logo for `setLogo`: merged into the current one; an empty `src` clears it. */
export type DeckLogoPatch = { [K in keyof DeckLogo]?: DeckLogo[K] | null };

/** The deck as `getDeck()` returns it: `rev` counts saved changes, `themeVersion` marks the schema. */
export interface Deck {
  themeVersion?: string;
  rev?: number;
  slides: Slide[];
  /** The deck logo, or null when none is set. */
  logo?: DeckLogo | null;
}

/** A partial update to a slide: `background` is merged key by key, `blocks` replaces the list. */
export interface SlidePatch {
  background?: Partial<SlideBackground>;
  blocks?: BlockInput[];
}

/** A partial update to a block: `props` is merged key by key, anything else replaces the field. */
export type BlockPatch = Partial<Omit<Block, "id" | "props">> & { props?: Partial<BlockProps> };

/** One entry of `updateBlocks`: the block's id and the patch merged into it. */
export interface BlockPatchEntry {
  id: string;
  patch: BlockPatch;
}

/** Whether the deck's shared history can step either way: `getUndoState`'s result and every patch's meta. */
export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * One saved change, as broadcast: the slides it changed (by id), on top of revision `base`, the
 * new slide order when that changed (a removed slide just drops out of it), and the deck logo
 * when that changed (null: removed).
 */
export interface DeckPatch {
  rev: number;
  base: number;
  slides: Record<string, Slide>;
  order?: string[];
  logo?: DeckLogo | null;
}

/** The callbacks a subscribed browser exposes to the server. */
export interface DeckCallbacks {
  deckPatched(patch: DeckPatch, meta: UndoState): void | Promise<void>;
}

/**
 * What a tab still running the previous Slides client (from before patches) exposes: the whole
 * deck, its media inlined, on every change. Such a tab subscribes without {@link SubscribeOptions}.
 */
export interface LegacyDeckCallbacks {
  deckChanged(deck: Deck, meta: UndoState): void | Promise<void>;
}

/** The second argument of `subscribe`: `patches: true` asks for `deckPatched` (this client). */
export interface SubscribeOptions {
  patches?: boolean;
}

/** A block in `listSlides()`: where it is and its readable text. */
export interface BlockSummary {
  id: string;
  type: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  text: string;
}

/** A slide in `listSlides()`: its id, position, a label, and a summary of each block. */
export interface SlideSummary {
  id: string;
  index: number;
  label: string;
  background: SlideBackground;
  blocks: BlockSummary[];
}

/** The artwork the server owns and the browser renderer fetches at boot. */
export interface BrandAssets {
  coverOrange: string;
}

/** The client's view of the server's `Gadget`: every public method, over RPC. */
export interface GadgetStub {
  getUndoState(): Promise<UndoState>;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  /** The deck with big media as asset refs; `refs: true` keeps them refs while a previous-version tab is open. */
  getDeck(options?: { refs?: boolean }): Promise<Deck>;
  getDeckInlined(): Promise<Deck>;
  getAsset(ref: string): Promise<string | null>;
  missingSvgRasters(keys: string[]): Promise<string[]>;
  saveSvgRaster(key: string, png: string): Promise<boolean>;
  getSvgRasters(keys: string[]): Promise<Record<string, string>>;
  getBrandAssets(): Promise<BrandAssets>;
  listSlides(): Promise<SlideSummary[]>;
  getSlide(slideId: string): Promise<Slide | null>;
  addSlide(atIndex?: number | null, slide?: SlideInput): Promise<string>;
  removeSlide(slideId: string): Promise<void>;
  duplicateSlide(slideId: string): Promise<string | null>;
  moveSlide(slideId: string, toIndex: number): Promise<void>;
  updateSlide(slideId: string, patch: SlidePatch): Promise<void>;
  addBlock(slideId: string, block: BlockInput, atIndex?: number | null): Promise<string | null>;
  updateBlock(slideId: string, blockId: string, patch: BlockPatch): Promise<void>;
  removeBlock(slideId: string, blockId: string): Promise<void>;
  reorderBlock(slideId: string, blockId: string, toIndex: number): Promise<void>;
  addBlocks(slideId: string, blocks: BlockInput[]): Promise<string[]>;
  updateBlocks(slideId: string, patches: BlockPatchEntry[]): Promise<void>;
  removeBlocks(slideId: string, blockIds: string[]): Promise<void>;
  setLogo(logo: DeckLogoPatch | null): Promise<DeckLogo | null>;
  setDeck(deck: { slides: SlideInput[]; logo?: DeckLogoPatch | null }): Promise<void>;
  resetAll(): Promise<Deck>;
  subscribe(cb: DeckCallbacks, options?: SubscribeOptions): Promise<void>;
}
