// A table change's card where the span that differs walks far back over text that repeats: a
// table added after a row of tables that read alike. The card is the whole tab's, and its
// cost grows with the tab, not with its square.

import { describe, expect, it } from "vitest";
import { prepareTableChange, type TableCall } from "../src/docs-table-actions";
import { tinyTablesTab } from "./doc-store-scenarios";
import { wholeTableChange } from "./docs-piece-cards-whole";
import { asFetched, kept } from "./docs-store-slice-shadow";

const LABEL = "Tab";

/** A table of one cell that reads as every table of an `equal` tab does, added at the tab's end. */
const ADDED: TableCall = { method: "insertTable", table: { rows: 1, columns: 1, cells: [["cell"]] } };

/** A tab of `pairs` one-cell tables, each followed by an empty paragraph, kept in a store. */
function tables(pairs: number, equal: boolean) {
  let tab = asFetched(tinyTablesTab("t1", pairs, equal ? () => "cell" : at => `cell ${at}`));
  return { tab, ...kept(tab) };
}

/** The milliseconds the card of `ADDED` takes on a kept tab of `pairs` tables, the least of three. */
function cardTime(pairs: number, equal: boolean): number {
  let times: number[] = [];
  for (let turn = 0; turn < 3; turn++) {
    let { store, base } = tables(pairs, equal);
    let started = performance.now();
    prepareTableChange(store, base, ADDED, LABEL);
    times.push(performance.now() - started);
  }
  return Math.min(...times);
}

describe("the card of a table added after tables that read alike", () => {
  it.each([1, 4, 5, 6, 7, 12, 40, 300])("is the whole tab's, after %i tables", pairs => {
    let { tab, store, base } = tables(pairs, true);
    expect(prepareTableChange(store, base, ADDED, LABEL)).toEqual(wholeTableChange(tab, ADDED, LABEL));
  });

  it("takes about what it takes after tables that differ", () => {
    // One run at a time, the span is compared again over both strings for every run it walks
    // back over: about twenty times the other tab's card at this size.
    let alike = cardTime(1_500, true);
    let unlike = cardTime(1_500, false);
    expect(alike).toBeLessThan(4 * unlike);
  });
});
