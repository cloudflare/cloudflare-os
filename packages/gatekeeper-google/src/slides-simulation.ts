/**
 * Queued Google Slides changes, and their replay over what a read fetched.
 *
 * Replay works on Slides' own JSON, before `slides-model.ts` projects it, so a simulated read
 * projects exactly as a fresh one would. It is exact for text and for which slides exist in what
 * order. Nothing Google renders is simulated: autofit, wrapping and thumbnails show the
 * presentation as saved.
 *
 * Apply re-runs the same functions over a fresh read to find the provider indices it writes, so
 * the preview and the write cannot disagree about where an edit lands.
 */

import type { TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import {
  replaySimulation, type SimulationResult, type SimulationStep,
} from "@gadgets/gatekeeper-kit/simulation";
import type { RestPageElement, RestSlide, RestText } from "./slides-api";
import {
  ChangeConflict, changeRange, narrowChange, projectedText, providerRange, restTextOf, segmentsOf,
  spliceSegments, type IndexRange, type TextLocation,
} from "./slides-text";

/** A slide as it was when a change was queued, so the approver can recognize it. */
export type SlideLabel = { number: number; title?: string };

/** One queued text edit, addressed as `SlideTextEdit` addresses it. */
export type TextEditRecord = {
  slideId: string;
  /** The shape or table; absent for the slide's speaker notes. */
  elementId?: string;
  cell?: { row: number; column: number };
  /** Absent to replace all of the text. */
  find?: string;
  replace: string;
  /** With no `find`: the text when the edit was queued, which it must still be at apply. */
  before?: string;
  slide: SlideLabel;
};

/** The payload of each kind of queued change. */
export type SlidesActions = {
  editText: { edits: TextEditRecord[] };
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

/** Where one edit landed: the provider range it replaces with `inserted`, and the text after it. */
export type EditPlacement = {
  location: TextLocation; range: IndexRange; inserted: string; previous: string; text: string;
};

type TextSlot = { location: TextLocation; body: RestText | undefined; write(body: RestText): void };

/** Element IDs a duplicate gets: the gatekeeper's, so a queued edit can name them. */
export function mintObjectId(): string {
  return `gk${crypto.randomUUID().replaceAll("-", "")}`;
}

function findElement(
  elements: RestPageElement[] | undefined, id: string,
): RestPageElement | undefined {
  for (let element of elements ?? []) {
    if (element.objectId === id) return element;
    let child = findElement(element.elementGroup?.children, id);
    if (child) return child;
  }
  return undefined;
}

/** Every element ID on a slide, groups' children included. */
export function elementIdsOf(elements: RestPageElement[] | undefined): string[] {
  return (elements ?? []).flatMap(element => [
    ...(element.objectId ? [element.objectId] : []),
    ...elementIdsOf(element.elementGroup?.children),
  ]);
}

// Names an edit's target, for prefixing a conflict.
function editTarget(edit: Omit<TextEditRecord, "slide">): string {
  if (edit.elementId === undefined) return `the speaker notes of slide "${edit.slideId}"`;
  if (edit.cell) {
    return `row ${edit.cell.row}, column ${edit.cell.column} of table "${edit.elementId}"`;
  }
  return `element "${edit.elementId}"`;
}

function textSlot(slide: RestSlide, edit: Omit<TextEditRecord, "slide">): TextSlot {
  let { elementId, cell } = edit;
  if (elementId === undefined) {
    let notes = slide.slideProperties?.notesPage;
    let id = notes?.notesProperties?.speakerNotesObjectId;
    if (!notes || !id) throw new ChangeConflict("the slide has no speaker notes");
    // Absent until someone first writes notes; inserting text at its ID creates it.
    let shape = notes.pageElements?.find(element => element.objectId === id)?.shape;
    return {
      location: { objectId: id },
      body: shape?.text,
      write: text => {
        if (shape) shape.text = text;
        else (notes.pageElements ??= []).push({ objectId: id, shape: { shapeType: "TEXT_BOX", text } });
      },
    };
  }
  let element = findElement(slide.pageElements, elementId);
  if (!element) throw new ChangeConflict(`the slide has no element "${elementId}"`);
  if (cell) {
    let table = element.table;
    if (!table) throw new ChangeConflict(`element "${elementId}" is not a table`);
    let found = table.tableRows?.flatMap(row => row.tableCells ?? []).find(candidate =>
      (candidate.location?.rowIndex ?? 0) === cell.row &&
      (candidate.location?.columnIndex ?? 0) === cell.column);
    if (!found) {
      throw new ChangeConflict(
        `table "${elementId}" has no cell starting at row ${cell.row}, column ${cell.column}`);
    }
    return {
      location: { objectId: elementId, cellLocation: { rowIndex: cell.row, columnIndex: cell.column } },
      body: found.text,
      write: text => { found.text = text; },
    };
  }
  if (element.table) throw new ChangeConflict(`element "${elementId}" is a table; give a cell`);
  let shape = element.shape;
  if (!shape) throw new ChangeConflict(`element "${elementId}" has no editable text`);
  return { location: { objectId: elementId }, body: shape.text, write: text => { shape.text = text; } };
}

/** Applies one edit to `slide` in place, returning where it landed. Throws `ChangeConflict`. */
export function editSlide(slide: RestSlide, edit: Omit<TextEditRecord, "slide">): EditPlacement {
  let slot = textSlot(slide, edit);
  let segments = segmentsOf(slot.body);
  let previous = projectedText(segments);
  let found = changeRange(previous, edit);
  let { start, end, text } = narrowChange(segments, found.start, found.end, edit.replace);
  let range = providerRange(segments, start, end);
  let edited = spliceSegments(segments, start, end, text);
  slot.write(restTextOf(edited));
  return { location: slot.location, range, inserted: text, previous, text: projectedText(edited) };
}

/** The current text an edit addresses. Throws `ChangeConflict` when it is not there. */
export function textOfTarget(slide: RestSlide, edit: Omit<TextEditRecord, "slide">): string {
  return projectedText(segmentsOf(textSlot(slide, edit).body));
}

// Prefixes a conflict with the edit it is about.
function inEdit<T>(index: number, edit: Omit<TextEditRecord, "slide">, body: () => T): T {
  try {
    return body();
  } catch (error) {
    if (!(error instanceof ChangeConflict)) throw error;
    throw new ChangeConflict(`edit ${index + 1}, to ${editTarget(edit)}: ${error.message}`);
  }
}

function requireSlide(order: readonly string[], id: string): void {
  if (!order.includes(id)) throw new ChangeConflict(`slide "${id}" no longer exists`);
}

/** Throws `ChangeConflict` if a slide already has the ID a copy is to take. */
export function requireNewSlide(order: readonly string[], id: string): void {
  if (order.includes(id)) throw new ChangeConflict(`a slide with the copy's ID "${id}" already exists`);
}

/**
 * Applies text edits in order. Returns the edited deck, and where each edit landed: null for one
 * whose target the deck does not hold. Throws `ChangeConflict`.
 */
export function editDeck(
  deck: Deck, edits: readonly Omit<TextEditRecord, "slide">[],
): { deck: Deck; placements: (EditPlacement | null)[] } {
  let edited = new Map<string, RestSlide>();
  let placements = edits.map((edit, i) => inEdit(i, edit, () => {
    requireSlide(deck.order, edit.slideId);
    let slide = edited.get(edit.slideId);
    if (!slide) {
      let held = deck.slides.get(edit.slideId);
      if (!held) return null;
      edited.set(edit.slideId, slide = structuredClone(held));
    }
    return editSlide(slide, edit);
  }));
  return {
    deck: edited.size === 0 ? deck : { order: deck.order, slides: new Map([...deck.slides, ...edited]) },
    placements,
  };
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
      return editDeck(deck, action.payload.edits).deck;
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
 * each queued duplicate of one copies (back to its original), and every slide of a text edit batch
 * touching one, since a batch applies all or none. A conflict on a slide reached only through an
 * earlier change, or on one no change links to `ids`, is not found, so the read shows the changes
 * after it, as approving them in order would apply them.
 */
export function slidesToFetch(ids: readonly string[], changes: readonly QueuedChange[]): Set<string> {
  let needed = new Set(ids);
  for (let { action } of changes.toReversed()) {
    if (action.kind === "duplicateSlide" && needed.has(action.payload.newSlideId)) {
      needed.add(action.payload.slideId);
    } else if (action.kind === "editText") {
      let targets = action.payload.edits.map(edit => edit.slideId);
      if (targets.some(id => needed.has(id))) for (let id of targets) needed.add(id);
    }
  }
  return needed;
}

/** The reason a read shows only some queued changes: the first that no longer applies. */
export function conflictReason(change: QueuedChange, reason: string): string {
  return `Queued change ${change.id} no longer applies, so it and the changes queued after it are ` +
    `not shown: ${reason}.`;
}
