/**
 * The contract between the Slides gadget's two halves: the deck document `server.ts` stores and
 * broadcasts, the patches `client.ts` sends back, the callback the server invokes on each
 * subscribed browser, and the RPC surface the client sees. Type-only -- both entries import it with
 * `import type`, so nothing here ships in the bundled gadget.
 */

/** A scalar a block prop may hold: the deck is JSON, and every prop is a string, number or flag. */
export type PropValue = string | number | boolean;

/**
 * A block's type-specific props. The named keys are the ones the client's COMPONENTS render and
 * edit (each component reads its own subset); the index signature carries anything else, since the
 * server stores props opaquely and merges patches key by key.
 */
export interface BlockProps {
  [key: string]: PropValue | undefined;
  text?: string;
  fontSize?: number;
  weight?: number | string;
  color?: string;
  letterSpacing?: string;
  lineHeight?: number;
  highlight?: string;
  variant?: string;
  scale?: number;
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

/** A block as handed to `addBlock`: the server mints the id when it is missing. */
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

/** A slide as handed to `addSlide`: the server fills in a missing id and mints ids for blocks that lack one. */
export interface SlideInput {
  id?: string;
  background?: SlideBackground;
  blocks?: BlockInput[];
}

/** The whole document, as stored under the "deck" key. `themeVersion` marks the current schema. */
export interface Deck {
  themeVersion?: string;
  slides: Slide[];
}

/** A partial update to a slide: `background` is merged key by key, anything else replaces the field. */
export type SlidePatch = Partial<Omit<Slide, "id" | "background">> & { background?: Partial<SlideBackground> };

/** A partial update to a block: `props` is merged key by key, anything else replaces the field. */
export type BlockPatch = Partial<Omit<Block, "id" | "props">> & { props?: Partial<BlockProps> };

/** Whether the deck's shared history can step either way: `getUndoState`'s result and `deckChanged`'s meta. */
export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
}

/** The callbacks a subscribed browser exposes to the server: the whole deck after every change. */
export interface DeckCallbacks {
  deckChanged(deck: Deck, meta: UndoState): void | Promise<void>;
}

/** The client's view of the server's `Gadget`: every public method, over RPC. */
export interface GadgetStub {
  getUndoState(): Promise<UndoState>;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  getDeck(): Promise<Deck>;
  addSlide(atIndex?: number | null, slide?: SlideInput): Promise<string>;
  removeSlide(slideId: string): Promise<void>;
  duplicateSlide(slideId: string): Promise<string | null>;
  moveSlide(slideId: string, toIndex: number): Promise<void>;
  updateSlide(slideId: string, patch: SlidePatch): Promise<void>;
  addBlock(slideId: string, block: BlockInput, atIndex?: number | null): Promise<string | null>;
  updateBlock(slideId: string, blockId: string, patch: BlockPatch): Promise<void>;
  removeBlock(slideId: string, blockId: string): Promise<void>;
  reorderBlock(slideId: string, blockId: string, toIndex: number): Promise<void>;
  setDeck(deck: Deck): Promise<void>;
  resetAll(): Promise<Deck>;
  subscribe(cb: DeckCallbacks): Promise<void>;
}
