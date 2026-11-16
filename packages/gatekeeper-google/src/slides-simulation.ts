/**
 * Queued Google Slides changes, and their replay over what a read fetched.
 *
 * Replay works on Slides' own JSON, before `slides-model.ts` projects it, so a simulated read
 * projects exactly as a fresh one would. It is exact for text and for which slides exist in what
 * order; `slides-design.ts` replays design changes, refusing what it cannot replay exactly.
 * Nothing Google renders is simulated: shrinking text to fit, wrapping and thumbnails show the
 * presentation as saved.
 *
 * Apply re-runs the same functions over a fresh read to find the provider indices it writes, so
 * the preview and the write cannot disagree about where an edit lands.
 */

import type { TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import type { SimulationStep } from "@gadgets/gatekeeper-kit/simulation";
import { createSimulationStore, type SimulationStore } from "@gadgets/gatekeeper-kit/simulation-store";
import { editorCost } from "./editor-cost";
import type { RestPage, RestPageElement, RestSlide, RestThemePage } from "./slides-api";
import { designInPlace, pageOf, slideIdOf, type DesignChange } from "./slides-design";
import { ChangeConflict } from "./slides-text";

/** A slide as it was when a change was queued, so the approver can recognize it. */
export type SlideLabel = { number: number; title?: string };

/** A master or layout as it was when a change was queued: its name, and a layout's master's. */
export type ThemeLabel = { name?: string; master?: string };

/**
 * An `updateSlides()` batch. `slides` labels each slide a change is on, and `themes` each master
 * or layout, by ID; `themes` may be absent when there are none.
 */
export type DesignBatch = {
  changes: DesignChange[];
  slides: Record<string, SlideLabel>;
  themes?: Record<string, ThemeLabel>;
};

/**
 * A placeholder a created slide gets from its layout: the ID the gatekeeper minted for it, the
 * layout placeholder it maps to (`type` and `index`, which Google matches it by, and that
 * placeholder's ID, which Google records as its parent), and the shape and geometry it starts with.
 */
export type CreatedPlaceholder = {
  objectId: string; type: string; index: number; parentObjectId: string;
  shapeType?: string; size?: RestPageElement["size"]; transform?: RestPageElement["transform"];
};

/**
 * The payload of each kind of queued change. A batch is queued as `editText` when it only edits
 * text, `formatSlides` when it only formats or moves, `updateSlides` when it downloads an image,
 * `deleteSlideContent` when it deletes elements, table rows or columns, and `editSlides`
 * otherwise; they differ in nothing but which kinds a user may let apply without asking.
 */
export type SlidesActions = {
  editText: DesignBatch;
  formatSlides: DesignBatch;
  editSlides: DesignBatch;
  deleteSlideContent: DesignBatch;
  updateSlides: DesignBatch;
  /** `objectIds` maps the source's element IDs to the IDs the gatekeeper minted for the copy's. */
  duplicateSlide: {
    slideId: string; newSlideId: string; objectIds: Record<string, string>; slide: SlideLabel;
  };
  deleteSlide: { slideId: string; slide: SlideLabel };
  /** `after: null` moves the slides to the start. */
  moveSlides: {
    slideIds: string[]; after: string | null; slides: SlideLabel[]; afterSlide?: SlideLabel;
  };
  /**
   * `layout` is the layout's display name; an absent `after` adds the slide at the end, `null`
   * at the start.
   */
  createSlide: {
    newSlideId: string; layoutId: string; layout: string; after?: string | null;
    placeholders: CreatedPlaceholder[]; afterSlide?: SlideLabel;
  };
  /** `slides` labels `slideIds` in presentation order. */
  skipSlides: { slideIds: string[]; skipped: boolean; slides: SlideLabel[] };
};

/** A queued change, as the journal stores it. */
export type SlidesAction = TaggedAction<SlidesActions>;

type DesignKind = {
  [K in keyof SlidesActions]: SlidesActions[K] extends DesignBatch ? K : never;
}[keyof SlidesActions];

// Every kind an `updateSlides()` batch may be queued as; the type makes a new one join it.
const DESIGN_KINDS: Record<DesignKind, true> = {
  editText: true, formatSlides: true, editSlides: true, deleteSlideContent: true,
  updateSlides: true,
};

/** Whether `action` is an `updateSlides()` batch, whichever kind it was queued as. */
export function isDesignBatch(action: SlidesAction): action is Extract<SlidesAction, { kind: DesignKind }> {
  return Object.hasOwn(DESIGN_KINDS, action.kind);
}

/**
 * What a read fetched, with queued changes applied: the slide order, the slides it fetched (a
 * slide no queued change edits may hold only its label fields), and every master and layout,
 * which the outline holds. Every slide a queued edit addresses is a full page, so an edit to a
 * slide it holds is checked.
 */
export type Deck = {
  order: readonly string[];
  slides: ReadonlyMap<string, RestSlide>;
  /** The master of every slide in `order`, and of every layout the presentation has. */
  masters: ReadonlyMap<string, string>;
  /** The presentation's first master, which a slide added to it with none takes its layout from. */
  firstMaster?: string;
  /** Every master and layout, which the outline holds. */
  themePages: ReadonlyMap<string, RestThemePage>;
};

/** Element IDs a duplicate gets: the gatekeeper's, so a queued edit can name them. */
export function mintObjectId(): string {
  return `gk${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Throws `ChangeConflict` if `order` no longer has the slide `id`. */
export function requireSlide(order: readonly string[], id: string): void {
  if (!order.includes(id)) throw new ChangeConflict(`slide "${id}" no longer exists`);
}

/** Throws `ChangeConflict` if a slide already has the ID a copy or new slide is to take. */
export function requireNewSlide(order: readonly string[], id: string): void {
  if (order.includes(id)) throw new ChangeConflict(`a slide with the new slide's ID "${id}" already exists`);
}

/** The order after moving `slideIds`, kept in their current order, to follow `after`. */
export function movedOrder(
  order: readonly string[], slideIds: readonly string[], after: string | null,
): string[] {
  for (let id of slideIds) requireSlide(order, id);
  let moving = new Set(slideIds);
  if (after !== null) {
    requireSlide(order, after);
    if (moving.has(after)) throw new ChangeConflict(`slide "${after}" cannot follow itself`);
  }
  let rest = order.filter(id => !moving.has(id));
  let at = after === null ? 0 : rest.indexOf(after) + 1;
  return [...rest.slice(0, at), ...order.filter(id => moving.has(id)), ...rest.slice(at)];
}

/**
 * Where a new slide goes in `deck`, and the master it takes from its layout. Throws `ChangeConflict`
 * for a layout that is gone, or that is not of the master Google takes a new slide's layout from:
 * the slide before's, the first slide's when it goes first, or the first master's when there is
 * no slide.
 */
export function newSlidePlace(
  { order, masters, firstMaster }: Deck, { newSlideId, layoutId, after }: SlidesActions["createSlide"],
): { at: number; master: string } {
  requireNewSlide(order, newSlideId);
  if (typeof after === "string") requireSlide(order, after);
  let master = masters.get(layoutId);
  if (master === undefined) throw new ChangeConflict(`layout "${layoutId}" no longer exists`);
  let at = after === undefined ? order.length : after === null ? 0 : order.indexOf(after) + 1;
  let beside = order[Math.max(at - 1, 0)];
  if ((beside === undefined ? firstMaster : masters.get(beside)) !== master) {
    throw new ChangeConflict(`layout "${layoutId}" belongs to a different master than ` +
      (beside === undefined ? `the presentation's first${firstMaster ? `, "${firstMaster}"` : ""}`
        : `slide "${beside}"`) +
      ", and Google takes a new slide's layout from the master of the slide before it, of the " +
      "first slide when it goes first, or of the presentation's first master when there is no slide");
  }
  return { at, master };
}

// An element added to the source after the copy was queued has no minted ID, so Google names it
// at random when it makes the copy. It is left out: any name shown for it would let an edit to the
// copy preview that its apply then cannot find. A copied line connects to the copies of the shapes
// its source connects to.
function duplicated(slide: RestSlide, newSlideId: string, objectIds: Record<string, string>) {
  let rename = (elements: RestPageElement[] | undefined): RestPageElement[] | undefined =>
    elements?.flatMap(element => {
      let objectId = element.objectId && objectIds[element.objectId];
      if (!objectId) return [];
      let { elementGroup: group, line } = element;
      for (let connection of [line?.lineProperties?.startConnection, line?.lineProperties?.endConnection]) {
        if (connection?.connectedObjectId) connection.connectedObjectId = objectIds[connection.connectedObjectId];
      }
      return [{
        ...element,
        objectId,
        ...(group ? { elementGroup: { ...group, children: rename(group.children) } } : {}),
      }];
    });
  editorCost.pageClones++;
  let copy = structuredClone(slide);
  copy.objectId = newSlideId;
  copy.pageElements = rename(copy.pageElements);
  return copy;
}

/**
 * The placeholders a slide made from `layout` gets, each with a minted ID so a queued edit can
 * name it, in the layout's order, each at its layout placeholder's size and transform. A slide
 * number is left out: Google adds one only while the presentation shows slide numbers, which a new
 * one does not, and otherwise ignores its mapping, so a minted ID could name nothing.
 */
export function instantiatedPlaceholders(layout: RestPage): CreatedPlaceholder[] {
  return (layout.pageElements ?? []).flatMap(({ objectId, size, transform, shape }) => {
    let { type, index = 0 } = shape?.placeholder ?? {};
    if (!objectId || !type || type === "SLIDE_NUMBER") return [];
    return [{
      objectId: mintObjectId(), type, index, parentObjectId: objectId,
      ...(shape?.shapeType ? { shapeType: shape.shapeType } : {}),
      ...(size ? { size } : {}), ...(transform ? { transform } : {}),
    }];
  });
}

/**
 * Throws `ChangeConflict` if `layout` no longer has a placeholder of each type and index in
 * `placeholders`, as Google refuses a new slide that maps one it lacks.
 */
export function requirePlaceholders(layout: RestPage, placeholders: readonly CreatedPlaceholder[]): void {
  let key = (type: string, index = 0) => `${type}#${index}`;
  let present = new Set(layout.pageElements?.flatMap(({ shape }) =>
    shape?.placeholder?.type ? [key(shape.placeholder.type, shape.placeholder.index)] : []));
  let missing = placeholders.find(({ type, index }) => !present.has(key(type, index)));
  if (missing) {
    throw new ChangeConflict(`layout "${layout.objectId}" no longer has its ${missing.type} placeholder` +
      (missing.index ? ` ${missing.index}` : ""));
  }
}

// Every placeholder is empty, and there are no speaker notes: Google names the notes shape only
// when it creates the slide.
function created(
  newSlideId: string, layoutId: string, master: string, placeholders: readonly CreatedPlaceholder[],
): RestSlide {
  return {
    objectId: newSlideId,
    pageElements: placeholders.map(({ objectId, type, index, parentObjectId, shapeType, size, transform }) => ({
      objectId,
      ...(size ? { size } : {}),
      ...(transform ? { transform } : {}),
      // Google omits a zero index.
      shape: {
        ...(shapeType ? { shapeType } : {}),
        placeholder: { type, ...(index ? { index } : {}), parentObjectId },
      },
    })),
    slideProperties: { layoutObjectId: layoutId, masterObjectId: master },
  };
}

// Google omits a false `isSkipped`, so a replayed read matches a fresh one.
function withSkipped(slide: RestSlide, skipped: boolean): RestSlide {
  let { isSkipped: _, ...properties } = slide.slideProperties ?? {};
  return { ...slide, slideProperties: skipped ? { ...properties, isSkipped: true } : properties };
}

/**
 * A deck being changed in place, which its maker alone holds: its own order and maps. Its pages
 * are the fetched deck's until a change writes one, which is then copied once (see `DRAFTS`).
 */
export type DeckDraft = {
  order: string[];
  slides: Map<string, RestSlide>;
  masters: Map<string, string>;
  firstMaster?: string;
  themePages: Map<string, RestThemePage>;
};

// What a fold keeps of its deck beside the deck: `own`, the IDs of the pages that are the fold's
// to write (copied by it, or made by it as a copy of a slide), and `applied`, the changes it has
// applied, oldest first, which put the deck back when a batch stops after it wrote. Both are that
// deck's own bookkeeping, a part of the fold's draft kept beside it so the deck stays a `Deck`
// and nothing more: reached only through the deck, and gone with it. The store holds nothing, and
// no fold reads another's.
const DRAFTS = new WeakMap<DeckDraft, { own: Set<string>; applied: SlidesAction[] }>();

// A deck of the caller's own holding what `deck` holds: its order and maps copied, its pages not.
// `firstMaster` is always set, to `undefined` where the deck has none, so that assigning a
// draft's fields over another's replaces every one.
function draftOf(deck: Deck): DeckDraft {
  return {
    order: [...deck.order],
    slides: new Map(deck.slides),
    masters: new Map(deck.masters),
    firstMaster: deck.firstMaster,
    themePages: new Map(deck.themePages),
  };
}

// Gives each held slide whose position changed from `before` to the deck's order now its number.
// Google renders a slide number as the slide's position, so a slide that moves shows another.
function renumber(deck: DeckDraft, before: readonly string[]): void {
  for (let [id, slide] of deck.slides) {
    let position = deck.order.indexOf(id);
    if (position !== before.indexOf(id)) deck.slides.set(id, numbered(slide, position + 1));
  }
}

// `slide` showing `number` wherever it shows its own number (an `autoText` of type
// `SLIDE_NUMBER`, at any depth): the slide itself when it shows none, else a copy of only the
// objects and arrays on the way to each number, sharing everything else with `slide`. `slide`
// is not written, so it needs no copy of the page and no entry in `own`. Every key of a copied
// object is kept, one that holds `undefined` included.
function numbered(slide: RestSlide, number: number): RestSlide {
  let content = `${number}`;
  let show = (value: unknown, key?: string): unknown => {
    if (typeof value !== "object" || value === null) return value;
    let parts = value as Record<string, unknown>;
    let shown: Record<string, unknown> | undefined;
    for (let name of Object.keys(parts)) {
      let next = show(parts[name], name);
      if (next === parts[name]) continue;
      shown ??= (Array.isArray(value) ? [...value] : { ...parts }) as Record<string, unknown>;
      shown[name] = next;
    }
    let result = shown ?? parts;
    return key === "autoText" && result.type === "SLIDE_NUMBER" ? { ...result, content } : result;
  };
  return show(slide) as RestSlide;
}

// Applies `action` to `deck` in place and says whether it changed anything. `own` is as
// `designInPlace` takes it. Throws `ChangeConflict`: having written nothing, for a change that
// is not a design batch, since each checks before it writes; for a design batch the deck may
// hold a part of it (see `designInPlace`), and the caller drops the deck or puts it back.
function applyInPlace(deck: DeckDraft, action: SlidesAction, own: Set<string>): boolean {
  let { order, slides, masters } = deck;
  switch (action.kind) {
    case "editText":
    case "formatSlides":
    case "editSlides":
    case "deleteSlideContent":
    case "updateSlides":
      // A step is null only for a change on a slide the deck does not hold, which edits nothing.
      return designInPlace(deck, action.payload.changes, own).some(step => step !== null);
    case "duplicateSlide": {
      let { slideId, newSlideId, objectIds } = action.payload;
      requireSlide(order, slideId);
      requireNewSlide(order, newSlideId);
      let source = slides.get(slideId);
      if (source) {
        slides.set(newSlideId, duplicated(source, newSlideId, objectIds));
        own.add(newSlideId);
      }
      let master = masters.get(slideId);
      if (master !== undefined) masters.set(newSlideId, master);
      deck.order = order.toSpliced(order.indexOf(slideId) + 1, 0, newSlideId);
      break;
    }
    case "deleteSlide": {
      let { slideId } = action.payload;
      requireSlide(order, slideId);
      slides.delete(slideId);
      own.delete(slideId);
      deck.order = order.filter(id => id !== slideId);
      // Google deletes a master, and its layouts, with the last slide on it, unless it is the
      // presentation's first master.
      let master = masters.get(slideId);
      let dropped = master !== undefined && master !== deck.firstMaster &&
        !deck.order.some(id => masters.get(id) === master);
      if (dropped) {
        deck.themePages = new Map([...deck.themePages].filter(([id, page]) =>
          id !== master && page.layoutProperties?.masterObjectId !== master));
        deck.masters = new Map([...masters].filter(([, of]) => of !== master));
      }
      break;
    }
    case "moveSlides": {
      let { slideIds, after } = action.payload;
      deck.order = movedOrder(order, slideIds, after);
      break;
    }
    case "createSlide": {
      let { newSlideId, layoutId, placeholders } = action.payload;
      let { at, master } = newSlidePlace(deck, action.payload);
      // The new slide holds the queued record's sizes and transforms, so it is not the fold's to
      // write: the first batch that edits it copies it.
      slides.set(newSlideId, created(newSlideId, layoutId, master, placeholders));
      masters.set(newSlideId, master);
      deck.order = order.toSpliced(at, 0, newSlideId);
      break;
    }
    case "skipSlides": {
      let { slideIds, skipped } = action.payload;
      for (let id of slideIds) requireSlide(order, id);
      for (let id of slideIds) {
        let slide = slides.get(id);
        if (slide) slides.set(id, withSkipped(slide, skipped));
      }
      return true;
    }
  }
  renumber(deck, order);
  return true;
}

// Makes `deck` what a fold of `applied` over `base` is, in the same object, and `own` the pages
// that fold copied: what `base` holds, then each change again. They applied once over this base,
// so they apply again to the same result.
function restore(
  deck: DeckDraft, base: Deck, { own, applied }: { own: Set<string>; applied: SlidesAction[] },
): void {
  Object.assign(deck, draftOf(base));
  own.clear();
  for (let action of applied) applyInPlace(deck, action, own);
}

/** Applies one queued change to `deck`, returning a new deck. Throws `ChangeConflict`. */
export function applyChange(deck: Deck, action: SlidesAction): Deck {
  let draft = draftOf(deck);
  return applyInPlace(draft, action, new Set()) ? draft : deck;
}

/** One journal entry visible to replay. */
export type QueuedChange = { readonly id: number; readonly action: SlidesAction };

/**
 * Creates a store that replays queued changes over the deck a read fetched, stopping at the first
 * that no longer applies. The deck is its one entity, folded under the presentation's own ID,
 * because a change may move, add or delete slides in the one order, a batch applies across its
 * slides or not at all, and a change that no longer applies hides every change queued after it,
 * on whatever slide. The store keeps nothing: every call folds the changes it is given from the
 * first. Each fold works on one deck of its own, changed in place: a page is copied the first
 * time a change of the fold writes it and never again, and the fetched deck and its pages are
 * left as they were. A batch that stops part-way leaves that deck as the changes before it made
 * it.
 */
export function createReplay(): SimulationStore<string, Deck, DeckDraft, QueuedChange> {
  return createSimulationStore<string, Deck, DeckDraft, QueuedChange>({
    initial: base => {
      let deck = draftOf(base);
      DRAFTS.set(deck, { own: new Set(), applied: [] });
      return deck;
    },
    // A deck is always given: every fold has one for its base, and no change deletes it.
    reduce: (deck, change, { base }): SimulationStep<DeckDraft> => {
      let draft = DRAFTS.get(deck!)!;
      try {
        if (!applyInPlace(deck!, change.action, draft.own)) return { kind: "known-no-effect" };
      } catch (error) {
        if (!(error instanceof ChangeConflict)) throw error;
        // A batch checks each change against what the one before it wrote, so it cannot decide
        // before it writes; a change of any other kind throws before it writes.
        if (isDesignBatch(change.action)) restore(deck!, base!, draft);
        return { kind: "unsupported", reason: error.message };
      }
      draft.applied.push(change.action);
      return { kind: "applied", value: deck! };
    },
  });
}

/**
 * The slides a read must fetch to show `pages` with queued changes: the slides themselves, the
 * slide each queued duplicate of one copies (back to its original), and every slide of a batch
 * touching one, or touching a master or layout among `pages`, since a batch applies all or none.
 * A conflict on a slide reached only through an earlier change, or on one no change links to
 * `pages`, is not found, so the read shows the changes after it, as approving them in order would
 * apply them. A slide a queued `createSlide` adds is not Google's yet, so none is fetched for it:
 * replay makes it whole. The set also holds the masters and layouts reached, which `getSlides()`
 * passes over, not being slides.
 */
export function slidesToFetch(pages: readonly string[], changes: readonly QueuedChange[]): Set<string> {
  let needed = new Set(pages);
  for (let { action } of changes.toReversed()) {
    if (action.kind === "duplicateSlide" && needed.has(action.payload.newSlideId)) {
      needed.add(action.payload.slideId);
    } else if (isDesignBatch(action)) {
      let targets = action.payload.changes.map(change => pageOf(change).id);
      if (targets.some(id => needed.has(id))) for (let id of targets) needed.add(id);
    }
  }
  return needed;
}

/**
 * The slides a read fetches to show `pages` whole and to name `labelled` with queued changes:
 * `needed`, what `slidesToFetch` gives for all of them, and `labelOnly`, those of `needed` that
 * no queued change edits and `pages` does not reach, of which `LABEL_FIELDS` is enough. A slide a
 * queued batch edits is read whole, with the batch's other slides, so the batch is checked as it
 * is when every slide is read whole; so is the slide a queued copy that is edited, or is among
 * `pages`, was made from.
 */
export function slidesToRead(
  pages: readonly string[], labelled: readonly string[], changes: readonly QueuedChange[],
): { needed: Set<string>; labelOnly: Set<string> } {
  let needed = slidesToFetch([...pages, ...labelled], changes);
  let whole = slidesToFetch([...pages, ...changes.flatMap(({ action }) => batchSlides(action))], changes);
  return { needed, labelOnly: new Set([...needed].filter(id => !whole.has(id))) };
}

/**
 * The slides a design batch changes, which it checks together, leaving out its masters and
 * layouts, which every read holds; none for other changes.
 */
export function batchSlides(action: SlidesAction): string[] {
  return isDesignBatch(action) ? action.payload.changes.flatMap(change => slideIdOf(change) ?? []) : [];
}

/** The reason a read shows only some queued changes: the first that no longer applies. */
export function conflictReason(change: QueuedChange, reason: string): string {
  return `Queued change ${change.id} no longer applies, so it and the changes queued after it are ` +
    `not shown: ${reason}.`;
}
