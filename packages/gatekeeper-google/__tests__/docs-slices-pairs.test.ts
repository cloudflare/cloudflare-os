// The model on a slice held to the whole tab for a first request that removes or adds a top-level
// element, then any request, from every stretch: what a guard that judged by the lookup gets wrong.

import { describe, expect, it } from "vitest";
import { expectEverySlice, PAIR_FIRSTS, pairsCorpus, SLICE_TABS } from "./docs-slice-shadow";
import type { Pair, SliceTabName } from "./docs-slice-shadow";

const PAIRS = pairsCorpus();
const NAMES = Object.keys(SLICE_TABS) as SliceTabName[];

/** The pairs of one test: a tab and a first request. */
const GROUPS = NAMES.flatMap(name => PAIR_FIRSTS.map(first => ({
  name, first, pairs: PAIRS.filter(pair => pair.name === name && pair.first === first),
})));

// What the pairs' tests add to, for the test after them.
const corpus = { pairs: 0, stretches: 0, nothing: 0 };

describe("a request that removes or adds a top-level element, then any request, from every slice", () => {
  it.each(GROUPS)("$first, in $name", ({ pairs }) => {
    let zones = (zone: Pair["zone"]) => pairs.filter(pair => pair.zone === zone).length;
    expect(pairs).toHaveLength(40);
    // The second request's index: before what the first names, in it, and after it.
    for (let zone of ["before", "at", "after"] as const) expect(zones(zone), zone).toBeGreaterThanOrEqual(12);

    let taken = { before: 0, at: 0, after: 0 };
    for (let { tab, requests, label, zone } of pairs) {
      let { ran, nothing, applied } = expectEverySlice(tab, requests, {}, () => label);
      corpus.pairs++;
      corpus.stretches += ran;
      corpus.nothing += nothing;
      if (applied) taken[zone]++;
    }
    // In each zone a pair the whole tab takes, so that no zone is held on refusals alone: a
    // request on what stands after an element that was removed among them.
    for (let zone of ["before", "at", "after"] as const) expect(taken[zone], zone).toBeGreaterThanOrEqual(1);
  });

  // The file's tests run in order: this one reads what the pairs' tests counted.
  it("ran every pair, from stretches that hold nothing the batch names too", () => {
    expect([GROUPS.length, corpus.pairs]).toEqual([18, 720]);
    expect(corpus.nothing / corpus.stretches).toBeGreaterThan(1 / 3);
  });
});
