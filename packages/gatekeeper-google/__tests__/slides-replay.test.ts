import { describe, expect, it } from "vitest";
import {
  conflictReason, createReplay, type Deck, type QueuedChange, type SlidesAction,
} from "../src/slides-simulation";

/** The ID a session folds its presentation's deck under: Google's own. */
const PRESENTATION = "presentation-1";

/** A deck holding `order`, built for one fold as a read builds its own. */
function deck(order = ["s1", "s2"]): Deck {
  return { order, slides: new Map(), masters: new Map(), themePages: new Map() };
}

function moveSlides(slideIds: string[], after: string | null): SlidesAction {
  return { kind: "moveSlides", payload: { slideIds, after, slides: [] } };
}

function deleteSlide(slideId: string): SlidesAction {
  return { kind: "deleteSlide", payload: { slideId, slide: { number: 1 } } };
}

describe("Slides replay store", () => {
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

  it("returns the fetched deck itself when nothing queued changes it", () => {
    let base = deck();

    expect(createReplay().fold(PRESENTATION, base, [])).toEqual({ entity: base, refused: [] });
    expect(createReplay().fold(PRESENTATION, base, []).entity).toBe(base);
    // A batch that edits nothing counts as no effect.
    let empty = createReplay().fold(
      PRESENTATION, base, [{ id: 1, action: { kind: "editText", payload: { changes: [], slides: {} } } }]);
    expect(empty).toEqual({ entity: base, refused: [] });
    expect(empty.entity).toBe(base);
  });
});
