// The closure of an edit's own elements, on what the renderer says each element writes: the
// rule on hand-built tabs, and what it answers where the elements in hand run out.

import { describe, expect, it } from "vitest";
import {
  closureOf, closureStart, ELEMENT_BREAKS, ELEMENT_DEEP, ELEMENT_TABLE, ELEMENT_TEXT,
  initialCarry, renderRun,
} from "../src/markdown-converter";
import type { OwnElements } from "../src/markdown-converter";
import { buildTab, grid, item, para, presetLevels } from "./doc-fixture";
import type { BlockSpec, Lists } from "./doc-fixture";

const WHOLE = { first: true, last: true };
const EMPTY: BlockSpec = { runs: ["\n"] };
/** A list of nine marked levels, and one whose second level has no marker. */
const LISTS: Lists = {
  L1: { listProperties: { nestingLevels: presetLevels() } },
  Q1: { listProperties: { nestingLevels: [{ glyphSymbol: "●" }, { glyphType: "NONE" }] } },
};

/** What the renderer says each element of the tab of `blocks` writes: block `k` is element `k + 1`. */
function flagsOf(blocks: BlockSpec[]): Uint8Array {
  let tab = buildTab(blocks, LISTS);
  return renderRun(tab.body.content, tab, initialCarry(), { mdStart: 0, elements: true })
    .elements!.flags;
}

/** `count` copies of what `make` answers for each number from 0. */
const times = <T>(count: number, make: (at: number) => T): T[] =>
  Array.from({ length: count }, (_, at) => make(at));

/** A tab's flags, an own range in it and the closure the rule gives of the whole tab. */
type Case = {
  name: string;
  flags: Uint8Array;
  own: OwnElements;
  closure: { from: number; to: number };
};

const only = (element: number): OwnElements => ({ first: element, last: element });

/**
 * `Lead`, `empties` empty paragraphs and `Tail`, with two paragraphs and one more on each
 * side: the own element is `Tail`, and then `Lead`.
 */
function breakCases(empties: number): Case[] {
  let flags = flagsOf([
    para("X"), para("A"), para("B"), para("Lead"), ...times(empties, () => EMPTY), para("Tail"),
    para("C"), para("D"), para("Y"),
  ]);
  let tail = 5 + empties;
  return [
    {
      name: `back from Tail over ${empties} empty paragraphs`, flags, own: only(tail),
      closure: { from: 3, to: tail + 3 },
    },
    {
      name: `forward from Lead over ${empties} empty paragraphs`, flags, own: only(4),
      closure: { from: 2, to: tail + 2 },
    },
  ];
}

/**
 * A paragraph, an item at level 0, `deeper` items at levels 1 to 3 and the paragraph after
 * them, which is the own element, with one paragraph more before and three after.
 */
function walkCase(deeper: number): Case {
  let flags = flagsOf([
    para("X"), para("Before"), item("top", "L1", 0),
    ...times(deeper, at => item(`deep ${at}`, "L1", 1 + at % 3)), para("After"),
    para("C"), para("D"), para("Y"),
  ]);
  let after = 4 + deeper;
  return {
    name: `back through ${deeper} deeper items`, flags, own: only(after),
    closure: { from: 3, to: after + 3 },
  };
}

const BREAKS = [0, 2, 20, 200].flatMap(breakCases);
const WALKS = [1, 20, 200].map(walkCase);
const CASES = [...BREAKS, ...WALKS];

describe("closureOf", () => {
  it("is closed at the tab's first element with no step", () => {
    let flags = flagsOf([para("Own"), para("A"), para("B"), para("C")]);
    expect(closureOf(flags, only(0), WHOLE)).toEqual({ from: 0, to: 3 });
    expect(closureOf(flags, only(0), { first: false, last: true })).toEqual({ more: "before" });
  });

  it("takes no second step once the first reached the tab's first element", () => {
    // In hand from "A": the first step back from "Own" ends on it.
    let flags = flagsOf([para("A"), para("Own"), para("B"), para("C")]).subarray(1);
    expect(flags[0] & ELEMENT_TEXT).toBe(ELEMENT_TEXT);
    expect(closureOf(flags, only(1), WHOLE)).toEqual({ from: 0, to: 4 });
    expect(closureOf(flags, only(1), { first: false, last: true })).toEqual({ more: "before" });
    // The section break that opens the body writes nothing: the step passes it and ends there.
    let whole = flagsOf([para("Own"), para("B"), para("C")]);
    expect(whole[0]).toBe(0);
    expect(closureOf(whole, only(1), WHOLE)).toEqual({ from: 0, to: 4 });
  });

  it("takes the table before a deeper item two steps back, and ends the walk there", () => {
    let flags = flagsOf([
      para("Before"), grid(["a", "b"]), item("deep", "L1", 1), para("One"), para("Own"),
    ]);
    expect(flags[2] & ELEMENT_TABLE).toBe(ELEMENT_TABLE);
    expect(flags[3] & ELEMENT_DEEP).toBe(ELEMENT_DEEP);
    expect(closureOf(flags, only(5), WHOLE)).toEqual({ from: 2, to: 6 });
  });

  it("asks for more before a deeper item that is the first in hand", () => {
    let flags = flagsOf([para("Before"), item("deep", "L1", 2), para("One"), para("Own")]).subarray(2);
    expect(flags[0] & ELEMENT_DEEP).toBe(ELEMENT_DEEP);
    expect(closureOf(flags, only(2), { first: false, last: true })).toEqual({ more: "before" });
    expect(closureStart(flags, 2, false)).toBeUndefined();
    // Where it is the tab's first element there is nothing before it to read.
    expect(closureOf(flags, only(2), WHOLE)).toEqual({ from: 0, to: 3 });
  });

  it("ends the walk at an item of a level with no marker, whatever its level", () => {
    let quiet = flagsOf([
      para("Before"), item("top", "Q1", 0), item("quiet", "Q1", 1), para("One"), para("Own"),
    ]);
    expect(quiet[3] & (ELEMENT_DEEP | ELEMENT_TEXT)).toBe(ELEMENT_TEXT);
    expect(closureOf(quiet, only(5), WHOLE)).toEqual({ from: 3, to: 6 });
    // The same tab with a marker at that level is walked back to the item at level 0.
    let marked = flagsOf([
      para("Before"), item("top", "L1", 0), item("deep", "L1", 1), para("One"), para("Own"),
    ]);
    expect(closureOf(marked, only(5), WHOLE)).toEqual({ from: 2, to: 6 });
  });

  it("passes an element that writes nothing as one that writes line breaks", () => {
    let flags = Uint8Array.of(ELEMENT_TEXT, ELEMENT_TEXT, 0, ELEMENT_BREAKS, 0, ELEMENT_TEXT, 0,
      ELEMENT_BREAKS, ELEMENT_TEXT, ELEMENT_TEXT, ELEMENT_TEXT);
    expect(closureOf(flags, only(5), WHOLE)).toEqual({ from: 0, to: 10 });
    expect(closureOf(flags, { first: 3, last: 7 }, WHOLE)).toEqual({ from: 0, to: 10 });
  });

  it("a step takes every element that writes only line breaks", () => {
    for (let { name, flags, own, closure } of BREAKS) {
      // The empty paragraphs between the two write line breaks alone.
      for (let element = 5; element < flags.length - 4; element++) {
        expect(flags[element] & (ELEMENT_TEXT | ELEMENT_BREAKS), name).toBe(ELEMENT_BREAKS);
      }
      expect(closureOf(flags, own, WHOLE), name).toEqual(closure);
    }
  });

  it("the walk goes back through deeper items", () => {
    for (let { name, flags, own, closure } of WALKS) {
      expect(flags[3] & ELEMENT_DEEP, name).toBe(0);
      for (let element = 4; element < own.first; element++) {
        expect(flags[element] & ELEMENT_DEEP, name).toBe(ELEMENT_DEEP);
      }
      expect(closureOf(flags, own, WHOLE), name).toEqual(closure);
    }
  });

  it("more is said where the tab goes on", () => {
    for (let { name, flags, own, closure } of CASES) {
      let { from, to } = closure;
      let length = flags.length;
      // Before: in hand from one element past the closure's first, from it, and from one before.
      let short = { first: own.first - from - 1, last: own.last - from - 1 };
      expect(closureOf(flags.subarray(from + 1), short, { first: false, last: true }), name)
        .toEqual({ more: "before" });
      expect(closureOf(flags.subarray(from + 1), short, WHOLE), name)
        .toEqual({ from: 0, to: to - from - 1 });
      expect(closureOf(flags.subarray(from), { first: own.first - from, last: own.last - from },
        { first: false, last: true }), name).toEqual({ from: 0, to: to - from });
      expect(closureOf(flags.subarray(from - 1),
        { first: own.first - from + 1, last: own.last - from + 1 }, { first: false, last: true }),
      name).toEqual({ from: 1, to: to - from + 1 });
      // After: in hand to one element short of the closure's last, to it, and to one past.
      expect(closureOf(flags.subarray(0, to - 1), own, { first: true, last: false }), name)
        .toEqual({ more: "after" });
      expect(closureOf(flags.subarray(0, to - 1), own, WHOLE), name).toEqual({ from, to: to - 1 });
      expect(closureOf(flags.subarray(0, to), own, { first: true, last: false }), name)
        .toEqual(closure);
      expect(to + 1, name).toBeLessThanOrEqual(length);
      expect(closureOf(flags.subarray(0, to + 1), own, { first: true, last: false }), name)
        .toEqual(closure);
      // Short on both sides, the side before is said first.
      expect(closureOf(flags.subarray(from + 1, to - 1), short, { first: false, last: false }), name)
        .toEqual({ more: "before" });
    }
  });

  it("the start alone is the closure's start", () => {
    for (let { name, flags, own, closure: { from } } of CASES) {
      expect(closureStart(flags, own.first, true), name).toBe(from);
      for (let cut of [from - 1, from, from + 1]) {
        let first = own.first - cut;
        for (let tabFirst of [true, false]) {
          let whole = closureOf(flags.subarray(cut), { first, last: own.last - cut },
            { first: tabFirst, last: true });
          expect(closureStart(flags.subarray(cut), first, tabFirst), `${name}, from ${cut}`)
            .toBe("more" in whole ? undefined : whole.from);
          expect("more" in whole, `${name}, from ${cut}`).toBe(cut === from + 1 && !tabFirst);
        }
      }
    }
  });

  it("answers for an own element that is none in hand", () => {
    let flags = flagsOf([para("A"), para("B"), para("C")]);
    // Before them all, or no whole number: the steps ran out at once.
    for (let first of [-1, -7, -0.5, NaN]) {
      expect(closureStart(flags, first, false), `${first}`).toBeUndefined();
      expect(closureStart(flags, first, true), `${first}`).toBe(0);
      expect(closureOf(flags, { first, last: 1 }, { first: false, last: true }), `${first}`)
        .toEqual({ more: "before" });
    }
    // Past them all: the steps go back, or forward, from where it stands.
    expect(closureStart(flags, 9, false)).toBe(2);
    for (let last of [flags.length, 9, NaN]) {
      expect(closureOf(flags, { first: 1, last }, WHOLE), `${last}`).toEqual({ from: 0, to: flags.length });
      expect(closureOf(flags, { first: 1, last }, { first: true, last: false }), `${last}`)
        .toEqual({ more: "after" });
    }
  });
});
