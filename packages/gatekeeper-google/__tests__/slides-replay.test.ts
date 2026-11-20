import { afterEach, describe, expect, it, vi } from "vitest";
import { editorCost } from "../src/editor-cost";
import {
  applyChange, conflictReason, createReplay, type Deck, type QueuedChange, type SlidesAction,
} from "../src/slides-simulation";
import { locate, textOfTarget } from "../src/slides-target";
import { ChangeConflict } from "../src/slides-text";
import {
  batch, copyOfFirst, coverageOf, directedQueues, FAILS_ON_MADE, generatedQueue, newSlide,
  pagesHoldingRecords, queued, queueDeck, QUEUE_MASTER, uncovered,
} from "./slides-queues";

/** The ID a session folds its presentation's deck under: Google's own. */
const PRESENTATION = "presentation-1";

/** A deck holding `order`, built for one fold as a read builds its own. */
function deck(order = ["s1", "s2"]): Deck {
  return { order, slides: new Map(), masters: new Map(), themePages: new Map() };
}

function moveSlides(slideIds: string[], after: string | null): SlidesAction {
  return { kind: "moveSlides", payload: { slideIds, after, slides: [] } };
}

/** The title of slide `s1` of `queueDeck()`, and the text a deck holds there. */
const TITLE = { slideId: "s1", elementId: "title" };

function titleOf(folded: Deck): string {
  return textOfTarget(folded.slides.get("s1")!, TITLE);
}

/** The element a directed queue makes on slide `s1`, as `folded` holds it. */
function madeOn(folded: Deck) {
  return locate(folded.slides.get("s1")!.pageElements, "made")?.element;
}

function deleteSlide(slideId: string): SlidesAction {
  return { kind: "deleteSlide", payload: { slideId, slide: { number: 1 } } };
}

describe("Slides replay store", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // A session folds every read through one store, and its reads list the same journal IDs over
  // whatever Google then holds.
  it("folds each read's own deck, whatever it folded before under the same IDs", () => {
    let replay = createReplay();
    let pending: QueuedChange[] = [{ id: 1, action: deleteSlide("s2") }];

    let first = replay.fold(PRESENTATION, deck(), pending);
    expect(first.stopped).toBeUndefined();
    expect(first.refused).toEqual([]);
    expect(first.entity?.order).toEqual(["s1"]);

    // The slide was deleted in Slides since.
    let stopped = replay.fold(PRESENTATION, deck(["s1"]), pending);
    expect(stopped.stopped?.reason).toBe('slide "s2" no longer exists');
    expect(stopped.stopped?.record).toBe(pending[0]);
    expect(stopped.entity?.order).toEqual(["s1"]);

    let again = replay.fold(PRESENTATION, deck(), pending);
    expect(again.stopped).toBeUndefined();
    expect(again.entity?.order).toEqual(["s1"]);
  });

  it("stops at the first change that no longer applies, naming it, with the deck before it", () => {
    let changes: QueuedChange[] = [
      { id: 1, action: moveSlides(["s2"], null) },
      { id: 2, action: deleteSlide("gone") },
      { id: 3, action: deleteSlide("s1") },
    ];

    let { entity, stopped } = createReplay().fold(PRESENTATION, deck(), changes);

    if (!stopped) throw new Error("Expected the replay to stop.");
    expect(stopped.record).toBe(changes[1]);
    expect(stopped.reason).toBe('slide "gone" no longer exists');
    expect(entity?.order).toEqual(["s2", "s1"]);
    // The sentence a read shows.
    expect(conflictReason(stopped.record, stopped.reason)).toBe(
      "Queued change 2 no longer applies, so it and the changes queued after it are not shown: " +
        'slide "gone" no longer exists.');
  });

  it("gives a deck of its own equal to the fetched one when nothing queued changes it", () => {
    let base = deck();

    expect(createReplay().fold(PRESENTATION, base, [])).toEqual({ entity: base, refused: [] });
    expect(createReplay().fold(PRESENTATION, base, []).entity).not.toBe(base);
    // A batch that edits no page counts as no effect, which applying it alone shows: it gives the
    // deck it was given. One has no change; the other's only change is on a slide that is in the
    // order of a deck that does not hold it, as a read that fetched other slides builds.
    let onSlideNotHeld = batch({ op: "editText", slideId: "s1", elementId: "title", replace: "Edited" });
    for (let action of [batch(), onSlideNotHeld]) {
      expect(applyChange(base, action)).toBe(base);
      let folded = createReplay().fold(PRESENTATION, base, [{ id: 1, action }]);
      expect(folded).toEqual({ entity: base, refused: [] });
      expect(folded.entity).not.toBe(base);
    }
  });

  it("copies a slide once a fold, however many batches edit it", () => {
    let queue = queued(["One", "Two", "Three"].map(replace => batch({ op: "editText", ...TITLE, replace })));
    let before = editorCost.pageClones;

    let { entity } = createReplay().fold(PRESENTATION, queueDeck(), queue);

    expect(editorCost.pageClones - before).toBe(1);
    expect(titleOf(entity!)).toBe("Three");

    // A queued copy is the fold's as it is made: the batches on it copy nothing more.
    let onCopy = queued([
      copyOfFirst("copy"),
      ...["One", "Two"].map(replace => batch({ op: "editText", slideId: "copy", elementId: "copy-title", replace })),
    ]);
    before = editorCost.pageClones;
    expect(createReplay().fold(PRESENTATION, queueDeck(), onCopy).stopped).toBeUndefined();
    expect(editorCost.pageClones - before).toBe(1);
  });

  it("never writes the fetched deck or its slides", () => {
    let base = queueDeck();
    let before = structuredClone(base);
    let queue = queued([
      batch({ op: "editText", ...TITLE, replace: "Edited" }, { op: "setBackground", masterId: QUEUE_MASTER, background: "#123456" }),
      copyOfFirst("copy"),
      moveSlides(["s3"], null),
      { kind: "skipSlides", payload: { slideIds: ["s1", "s2"], skipped: true, slides: [] } },
      batch({ op: "deleteElement", slideId: "s2", elementId: "box" }),
    ]);

    let { entity, stopped } = createReplay().fold(PRESENTATION, base, queue);

    expect(stopped).toBeUndefined();
    expect(entity?.order).toEqual(["s3", "s1", "copy", "s2"]);
    expect(base).toStrictEqual(before);
  });

  it("never writes a queued new slide's stored placeholders", () => {
    let queue = queued([
      newSlide("fresh"),
      batch({ op: "setBounds", slideId: "fresh", elementId: "fresh-title", bounds: { x: 44 } }),
    ]);
    let before = structuredClone(queue);

    let { entity, stopped } = createReplay().fold(PRESENTATION, queueDeck(), queue);

    expect(stopped).toBeUndefined();
    let title = entity!.slides.get("fresh")!.pageElements![0];
    expect(title.transform?.translateX).toBe(44 * 12_700);
    expect(queue).toStrictEqual(before);
    expect(pagesHoldingRecords(queue, queue.length, entity!)).toEqual([]);

    // Nor those of a new slide that takes the ID of a deleted slide the fold had copied.
    let reused = directedQueues().find(({ name }) => name.startsWith("a new slide under the ID"))!.queue;
    let again = createReplay().fold(PRESENTATION, queueDeck(), reused);
    expect(again.stopped).toBeUndefined();
    expect(pagesHoldingRecords(reused, reused.length, again.entity!)).toEqual([]);
  });

  it("leaves the deck as the changes before made it when a batch stops part-way", () => {
    let kept = batch({ op: "editText", ...TITLE, replace: "Kept" });
    let queue = queued([
      kept,
      batch({ op: "editText", ...TITLE, replace: "Dropped" }, { op: "updateShape", slideId: "s1", elementId: "missing", fill: "none" }),
    ]);

    let { entity, stopped } = createReplay().fold(PRESENTATION, queueDeck(), queue);

    expect(stopped?.record).toBe(queue[1]);
    expect(stopped?.reason).toBe('change 2 (updateShape): the slide has no element "missing"');
    expect(entity).toEqual(createReplay().fold(PRESENTATION, queueDeck(), queued([kept])).entity);
    expect(titleOf(entity!)).toBe("Kept");
    expect(JSON.stringify(entity!.slides.get("s1"))).not.toContain("Dropped");
  });

  it("leaves the deck as it was when a batch stops at its first change", () => {
    let base = queueDeck();
    let before = structuredClone(base);
    let stops = batch(
      { op: "updateShape", slideId: "s1", elementId: "missing", fill: "none" },
      { op: "editText", ...TITLE, replace: "Dropped" });

    let alone = createReplay().fold(PRESENTATION, base, queued([stops]));
    expect(alone.stopped?.reason).toBe('change 1 (updateShape): the slide has no element "missing"');
    expect(alone.entity).toEqual(base);
    expect(alone.entity).not.toBe(base);

    let kept = batch({ op: "editText", ...TITLE, replace: "Kept" });
    let after = createReplay().fold(PRESENTATION, base, queued([kept, stops]));
    expect(after.stopped?.record.id).toBe(2);
    expect(after.entity).toEqual(createReplay().fold(PRESENTATION, base, queued([kept])).entity);
    expect(base).toStrictEqual(before);
  });

  it("throws an error that is not a conflict as it is, from a batch that had written", () => {
    let defect = new Error("a defect");
    // A paragraph made a list item is read for the tabs it starts with, after the batch's first
    // change has written the title: a fault there is not a conflict.
    let match = String.prototype.match;
    vi.spyOn(String.prototype, "match").mockImplementation(function (this: string, pattern) {
      if (pattern instanceof RegExp && pattern.source === "^\\t*") throw defect;
      return match.call(this, pattern as RegExp);
    });
    let queue = queued([
      batch({ op: "editText", ...TITLE, replace: "Kept" }),
      batch(
        { op: "editText", ...TITLE, replace: "Dropped" },
        { op: "formatParagraphs", slideId: "s1", elementId: "body", find: "First point", bullets: "numbered" }),
    ]);

    let thrown: unknown;
    try {
      createReplay().fold(PRESENTATION, queueDeck(), queue);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(defect);
  });

  it("puts back a list an earlier batch made as that batch made it, with no random source mocked", () => {
    let base = queueDeck();
    let bullets = batch(
      { op: "formatParagraphs", slideId: "s1", elementId: "body", find: "First point", bullets: "numbered" });
    // Writes the title before it reaches a slide the deck does not have, so the fold puts the
    // deck back and applies the batch before it again.
    let stops = batch(
      { op: "editText", ...TITLE, replace: "Dropped" }, { op: "arrange", slideId: "gone", elementId: "title", to: "front" });
    let folded = createReplay().fold(PRESENTATION, base, queued([bullets, stops]));
    let prefix = createReplay().fold(PRESENTATION, base, queued([bullets]));

    expect(folded.stopped?.record.id).toBe(2);
    expect(folded.entity).toEqual(prefix.entity);
    let listIds = (deck: Deck) => (deck.slides.get("s1")!.pageElements ?? []).flatMap(element =>
      (element.shape?.text?.textElements ?? []).flatMap(part => part.paragraphMarker?.bullet?.listId ?? []));
    expect(listIds(folded.entity!).length).toBeGreaterThan(0);
    expect(listIds(folded.entity!)).toEqual(listIds(prefix.entity!));
  });

  it("folds the same queue twice to the same deck", () => {
    let base = queueDeck();
    let queue = queued([
      batch({ op: "editText", ...TITLE, replace: "Kept" }),
      copyOfFirst("copy"),
      batch({ op: "editText", ...TITLE, replace: "Dropped" }, { op: "arrange", slideId: "gone", elementId: "title", to: "front" }),
      moveSlides(["s3"], null),
    ]);

    let first = createReplay().fold(PRESENTATION, base, queue);
    let second = createReplay().fold(PRESENTATION, base, queue);

    expect(first.stopped?.record).toBe(queue[2]);
    expect(second).toEqual(first);
    expect(second.entity).not.toBe(first.entity);
    expect(second.entity!.slides.get("s1")).not.toBe(first.entity!.slides.get("s1"));
  });

  // `applyChange` and the fold apply a change with the same code, so this holds what the fold adds
  // to it: the pages it owns and writes across batches, the deck put back when a batch stops, and
  // the changes it lists as applied. A fault the two share in one change is not found here; the
  // renumbering of a moved slide and the check of a skip have references of their own in the
  // simulation tests.
  it("folds generated queues as applying each change to a copy does", () => {
    let generated = new Map<string, number>();
    let directed = new Map<string, number>();
    let queues = [
      ...Array.from({ length: 300 }, (_, seed) => ({ name: `seed ${seed}`, queue: generatedQueue(seed), counts: generated })),
      ...directedQueues().map(entry => ({ ...entry, counts: directed })),
    ];

    for (let { name, queue, counts } of queues) {
      let base = queueDeck();
      let before = structuredClone({ base, queue });
      let expected: Deck = base;
      let stopped: { record: QueuedChange; reason: string } | undefined;
      let applied = 0;
      for (let change of queue) {
        try {
          expected = applyChange(expected, change.action);
        } catch (error) {
          if (!(error instanceof ChangeConflict)) throw error;
          stopped = { record: change, reason: error.message };
          break;
        }
        applied++;
      }

      let fold = createReplay().fold(PRESENTATION, base, queue);

      expect(fold.entity, name).toEqual(expected);
      expect(fold.stopped, name).toEqual(stopped);
      expect([...fold.entity!.slides.keys()], name).toEqual([...expected.slides.keys()]);
      expect([...fold.entity!.themePages.keys()], name).toEqual([...expected.themePages.keys()]);
      expect({ base, queue }, name).toStrictEqual(before);
      expect(pagesHoldingRecords(queue, applied, fold.entity!), name).toEqual([]);
      coverageOf(queue, applied, counts);
    }

    // Every operation ran in a batch on a page an earlier batch of its queue had edited.
    expect(uncovered(generated)).toEqual([]);
    expect(uncovered(directed)).toEqual([]);
  });

  it("leaves the deck as the changes before made it when a batch fails on an element an earlier batch created", () => {
    let failing = directedQueues().filter(({ name }) => name.startsWith(FAILS_ON_MADE));
    expect(failing).toHaveLength(3);

    for (let [index, { name, queue }] of failing.entries()) {
      let alone = createReplay().fold(PRESENTATION, queueDeck(), queue.slice(0, 1)).entity!;

      let { entity, stopped } = createReplay().fold(PRESENTATION, queueDeck(), queue);

      expect(stopped?.reason, name).toContain(`change ${index + 1} (`);
      expect(entity, name).toEqual(alone);
      expect(madeOn(entity!), name).toEqual(madeOn(alone));
      expect(madeOn(entity!), name).toBeDefined();
      expect(createReplay().fold(PRESENTATION, queueDeck(), queue).entity, name).toEqual(entity);
    }
  });
});
