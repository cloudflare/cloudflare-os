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
import type { RestPageElement, RestSlide } from "./slides-api";
import { designDeck, type DesignChange } from "./slides-design";
import { ChangeConflict } from "./slides-text";

/** A slide as it was when a change was queued, so the approver can recognize it. */
export type SlideLabel = { number: number; title?: string };

/** An `updateSlides()` batch. `slides` labels each slide a change is on. */
export type DesignBatch = { changes: DesignChange[]; slides: Record<string, SlideLabel> };

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
};

/** A queued change, as the journal stores it. */
export type SlidesAction = TaggedAction<SlidesActions>;

/**
 * What a read fetched, with queued changes applied: the slide order, and the slides it fetched.
 * Every slide a queued edit addresses is a full page, so an edit to a slide it holds is checked.
 */
export type Deck = {
  order: readonly string[];
  slides: ReadonlyMap<string, RestSlide>;
};

/** Element IDs a duplicate gets: the gatekeeper's, so a queued edit can name them. */
export function mintObjectId(): string {
  return `gk${crypto.randomUUID().replaceAll("-", "")}`;
}

function requireSlide(order: readonly string[], id: string): void {
  if (!order.includes(id)) throw new ChangeConflict(`slide "${id}" no longer exists`);
}

/** Throws `ChangeConflict` if a slide already has the ID a copy is to take. */
export function requireNewSlide(order: readonly string[], id: string): void {
  if (order.includes(id)) throw new ChangeConflict(`a slide with the copy's ID "${id}" already exists`);
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

// An element added to the source after the copy was queued has no minted ID, so Google names it
// at random when it makes the copy. It is left out: any name shown for it would let an edit to the
// copy preview that its apply then cannot find.
function duplicated(slide: RestSlide, newSlideId: string, objectIds: Record<string, string>) {
  let rename = (elements: RestPageElement[] | undefined): RestPageElement[] | undefined =>
    elements?.flatMap(element => {
      let objectId = element.objectId && objectIds[element.objectId];
      if (!objectId) return [];
      let group = element.elementGroup;
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

// Google renders a slide number as the slide's position, so a slide that moves shows a new one.
function reordered(deck: Deck, order: string[], slides = deck.slides): Deck {
  let renumbered = [...slides].map(([id, slide]): [string, RestSlide] => {
    let position = order.indexOf(id);
    return position === deck.order.indexOf(id) ? [id, slide] : [id, numbered(slide, position + 1)];
  });
  return { order, slides: new Map(renumbered) };
}

function numbered(slide: RestSlide, number: number): RestSlide {
  return JSON.parse(JSON.stringify(slide), (key, value) =>
    key === "autoText" && value.type === "SLIDE_NUMBER" ? { ...value, content: `${number}` } : value);
}

/** Applies one queued change to `deck`, returning a new deck. Throws `ChangeConflict`. */
export function applyChange(deck: Deck, action: SlidesAction): Deck {
  let { order, slides } = deck;
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
      return reordered(deck, order.toSpliced(order.indexOf(slideId) + 1, 0, newSlideId), next);
    }
    case "deleteSlide": {
      let { slideId } = action.payload;
      requireSlide(order, slideId);
      let next = new Map(slides);
      next.delete(slideId);
      return reordered(deck, order.filter(id => id !== slideId), next);
    }
    case "moveSlides": {
      let { slideIds, after } = action.payload;
      return reordered(deck, movedOrder(order, slideIds, after));
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
 * The slides a read must fetch to show `ids` with queued changes: the slides themselves, the slide
 * each queued duplicate of one copies (back to its original), and every slide of a batch touching
 * one, since a batch applies all or none. A conflict on a slide reached only through an earlier
 * change, or on one no change links to `ids`, is not found, so the read shows the changes after
 * it, as approving them in order would apply them.
 */
export function slidesToFetch(ids: readonly string[], changes: readonly QueuedChange[]): Set<string> {
  let needed = new Set(ids);
  for (let { action } of changes.toReversed()) {
    if (action.kind === "duplicateSlide" && needed.has(action.payload.newSlideId)) {
      needed.add(action.payload.slideId);
    } else {
      let targets = batchSlides(action);
      if (targets.some(id => needed.has(id))) for (let id of targets) needed.add(id);
    }
  }
  return needed;
}

/** The slides a design batch changes, which it checks together; none for other changes. */
export function batchSlides(action: SlidesAction): string[] {
  switch (action.kind) {
    case "editText":
    case "formatSlides":
    case "updateSlides":
      return action.payload.changes.map(change => change.slideId);
    default:
      return [];
  }
}

/** The reason a read shows only some queued changes: the first that no longer applies. */
export function conflictReason(change: QueuedChange, reason: string): string {
  return `Queued change ${change.id} no longer applies, so it and the changes queued after it are ` +
    `not shown: ${reason}.`;
}
