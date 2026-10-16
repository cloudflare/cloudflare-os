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
import {
  replaySimulation, type SimulationResult, type SimulationStep,
} from "@gadgets/gatekeeper-kit/simulation";
import type { RestPage, RestPageElement, RestSlide, RestThemePage } from "./slides-api";
import { designDeck, pageOf, slideIdOf, type DesignChange } from "./slides-design";
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
 * text, `formatSlides` when it only formats or moves, and `updateSlides` otherwise; they differ in
 * nothing but which kinds a user may let apply without asking.
 */
export type SlidesActions = {
  editText: DesignBatch;
  formatSlides: DesignBatch;
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

/**
 * What a read fetched, with queued changes applied: the slide order, the slides it fetched, and
 * every master and layout, which the outline holds. Every slide a queued edit addresses is a full
 * page, so an edit to a slide it holds is checked.
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

// Google renders a slide number as the slide's position, so a slide that moves shows a new one.
function reordered(deck: Deck, order: string[], slides = deck.slides, masters = deck.masters): Deck {
  let renumbered = [...slides].map(([id, slide]): [string, RestSlide] => {
    let position = order.indexOf(id);
    return position === deck.order.indexOf(id) ? [id, slide] : [id, numbered(slide, position + 1)];
  });
  return { ...deck, order, slides: new Map(renumbered), masters };
}

function numbered(slide: RestSlide, number: number): RestSlide {
  return JSON.parse(JSON.stringify(slide), (key, value) =>
    key === "autoText" && value.type === "SLIDE_NUMBER" ? { ...value, content: `${number}` } : value);
}

/** Applies one queued change to `deck`, returning a new deck. Throws `ChangeConflict`. */
export function applyChange(deck: Deck, action: SlidesAction): Deck {
  let { order, slides, masters } = deck;
  switch (action.kind) {
    case "editText":
    case "formatSlides":
    case "updateSlides":
      return designDeck(deck, action.payload.changes).deck;
    case "duplicateSlide": {
      let { slideId, newSlideId, objectIds } = action.payload;
      requireSlide(order, slideId);
      requireNewSlide(order, newSlideId);
      let source = slides.get(slideId);
      let next = new Map(slides);
      if (source) next.set(newSlideId, duplicated(source, newSlideId, objectIds));
      let master = masters.get(slideId);
      return reordered(deck, order.toSpliced(order.indexOf(slideId) + 1, 0, newSlideId), next,
        master === undefined ? masters : new Map(masters).set(newSlideId, master));
    }
    case "deleteSlide": {
      let { slideId } = action.payload;
      requireSlide(order, slideId);
      let next = new Map(slides);
      next.delete(slideId);
      let rest = order.filter(id => id !== slideId);
      // Google deletes a master, and its layouts, with the last slide on it, unless it is the
      // presentation's first master.
      let master = masters.get(slideId);
      let dropped = master !== undefined && master !== deck.firstMaster &&
        !rest.some(id => masters.get(id) === master);
      if (!dropped) return reordered(deck, rest, next);
      let themePages = new Map([...deck.themePages].filter(([id, page]) =>
        id !== master && page.layoutProperties?.masterObjectId !== master));
      return reordered({ ...deck, themePages }, rest, next,
        new Map([...masters].filter(([, of]) => of !== master)));
    }
    case "moveSlides": {
      let { slideIds, after } = action.payload;
      return reordered(deck, movedOrder(order, slideIds, after));
    }
    case "createSlide": {
      let { newSlideId, layoutId, placeholders } = action.payload;
      let { at, master } = newSlidePlace(deck, action.payload);
      return reordered(deck, order.toSpliced(at, 0, newSlideId),
        new Map(slides).set(newSlideId, created(newSlideId, layoutId, master, placeholders)),
        new Map(masters).set(newSlideId, master));
    }
    case "skipSlides": {
      let { slideIds, skipped } = action.payload;
      let next = new Map(slides);
      for (let id of slideIds) {
        requireSlide(order, id);
        let slide = slides.get(id);
        if (slide) next.set(id, withSkipped(slide, skipped));
      }
      return { ...deck, slides: next };
    }
  }
}

function step(deck: Deck, action: SlidesAction): SimulationStep<Deck> {
  try {
    let next = applyChange(deck, action);
    return next === deck ? { kind: "known-no-effect" } : { kind: "applied", value: next };
  } catch (error) {
    if (error instanceof ChangeConflict) return { kind: "unsupported", reason: error.message };
    throw error;
  }
}

/** One journal entry visible to replay. */
export type QueuedChange = { readonly id: number; readonly action: SlidesAction };

/** Replays queued changes over a read, stopping at the first that no longer applies. */
export function replayChanges(
  base: Deck, changes: readonly QueuedChange[],
): SimulationResult<Deck, QueuedChange> {
  return replaySimulation(base, changes, (deck, change) => step(deck, change.action));
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
    } else if (action.kind === "editText" || action.kind === "formatSlides" || action.kind === "updateSlides") {
      let targets = action.payload.changes.map(change => pageOf(change).id);
      if (targets.some(id => needed.has(id))) for (let id of targets) needed.add(id);
    }
  }
  return needed;
}

/**
 * The slides a design batch changes, which it checks together, leaving out its masters and
 * layouts, which every read holds; none for other changes.
 */
export function batchSlides(action: SlidesAction): string[] {
  switch (action.kind) {
    case "editText":
    case "formatSlides":
    case "updateSlides":
      return action.payload.changes.flatMap(change => slideIdOf(change) ?? []);
    default:
      return [];
  }
}

/** The reason a read shows only some queued changes: the first that no longer applies. */
export function conflictReason(change: QueuedChange, reason: string): string {
  return `Queued change ${change.id} no longer applies, so it and the changes queued after it are ` +
    `not shown: ${reason}.`;
}
