// The model on a slice held to the whole tab for one request of each kind at each place of three
// small tabs, from every stretch. The ranges a range kind takes are thinned, a table of two widths.

import { describe, expect, it } from "vitest";
import type { GoogleDocsRequest } from "../src/docs-api";
import { hasModelIndexes } from "../src/docs-model";
import type { ModelOptions } from "../src/docs-model";
import {
  expectEverySlice, FAMILY_KINDS, familyOf, INSERTION_KINDS, MIXED_PLACES, RANGE_KINDS,
  SLICE_TABS, TABLE_KINDS,
} from "./docs-slice-shadow";
import type { FamilyKind, SliceTabName } from "./docs-slice-shadow";
import { WIDER } from "./wider-run";

const UNLINK: ModelOptions = { unlinkRestyles: true };

/** The most ranges a tab and a range kind take: the table's width, under each option. */
const RANGES = { plain: WIDER ? 150 : 20, unlink: WIDER ? 75 : 20 };

/** The fewest requests a tab and a kind must run, so that a thinning gone too far fails. */
const FLOORS = { insertion: 40, plain: WIDER ? 120 : 16, unlink: WIDER ? 60 : 16, table: 1 };

const NAMES = Object.keys(SLICE_TABS) as SliceTabName[];
const RANGED: readonly FamilyKind[] = RANGE_KINDS;

/** Each test of the family: a tab, a kind and, for a range kind, each of the two options. */
const FAMILY = NAMES.flatMap(name => FAMILY_KINDS.flatMap(kind => [
  { name, kind, options: {} as ModelOptions, title: `${kind} in ${name}` },
  ...RANGED.includes(kind)
    ? [{ name, kind, options: UNLINK, title: `${kind} in ${name}, a link cleared restyles` }]
    : [],
]));

// What the family's tests add to, for the test after them.
const ran = new Map<string, number>();
const taken = new Map<string, number>();
const corpus = { stretches: 0, nothing: 0, unlinked: 0 };

/** Whether `request` clears a link from the first index of MIXED's linked paragraph. */
function clearsLinkedStart(request: GoogleDocsRequest): boolean {
  if (!("updateTextStyle" in request)) return false;
  let { range, textStyle, fields } = request.updateTextStyle;
  let linked = SLICE_TABS.MIXED.body.content[MIXED_PLACES.linked];
  return fields === "link" && textStyle.link === undefined && range.startIndex === linked.startIndex;
}

describe("a family of requests, from every slice", () => {
  it("runs on tabs the model follows, of eight to ten elements", () => {
    let mixed = SLICE_TABS.MIXED.body.content;
    for (let name of NAMES) {
      expect(hasModelIndexes(SLICE_TABS[name]), name).toBe(true);
      expect(SLICE_TABS[name].body.content.length, name).toBeGreaterThanOrEqual(8);
      expect(SLICE_TABS[name].body.content.length, name).toBeLessThanOrEqual(10);
    }
    // A section break in the middle of the body that is two indexes long: on a break of one
    // index nothing tells a slice's first element from the element that opens a body.
    let longBreak = mixed[MIXED_PLACES.longBreak];
    expect(longBreak.sectionBreak).toBeDefined();
    expect(longBreak.endIndex - longBreak.startIndex).toBe(2);
    expect(mixed[MIXED_PLACES.longBreak + 1].paragraph?.bullet).toBeUndefined();
    expect(mixed[MIXED_PLACES.table].table).toBeDefined();
    expect(mixed[MIXED_PLACES.pair].paragraph?.elements[0].textRun?.content.codePointAt(0)).toBe(0x1f600);
    expect(mixed[MIXED_PLACES.tabbed].paragraph?.elements[0].textRun?.content.startsWith("\t\t")).toBe(true);
    expect(mixed[MIXED_PLACES.linked].paragraph?.elements[0].textRun?.textStyle.link).toBeDefined();
    expect(mixed[MIXED_PLACES.linked - 1].paragraph?.elements.at(-1)?.textRun)
      .toEqual({ content: "\n", textStyle: { bold: true } });
  });

  it.each(FAMILY)("$title", ({ name, kind, options }) => {
    let tab = SLICE_TABS[name];
    let unlink = options === UNLINK;
    let requests = familyOf(tab, kind, unlink ? RANGES.unlink : RANGES.plain);
    let applied = 0;
    for (let request of requests) {
      let counted = expectEverySlice(tab, [request], options, () => `${name}: ${JSON.stringify(request)}`);
      corpus.stretches += counted.ran;
      corpus.nothing += counted.nothing;
      if (counted.applied) applied++;
      if (name === "MIXED" && unlink && clearsLinkedStart(request)) corpus.unlinked++;
    }
    ran.set(`${name}, ${kind}, ${unlink ? "unlink" : "plain"}`, requests.length);
    taken.set(`${name}, ${kind}, ${unlink ? "unlink" : "plain"}`, applied);
  });

  // The file's tests run in order: this one reads what the family's tests counted.
  it("ran enough requests of every kind on every tab, from stretches that hold nothing too", () => {
    for (let name of NAMES) {
      for (let kind of INSERTION_KINDS) {
        expect(ran.get(`${name}, ${kind}, plain`), `${name}, ${kind}`).toBeGreaterThanOrEqual(FLOORS.insertion);
      }
      for (let kind of RANGE_KINDS) {
        expect(ran.get(`${name}, ${kind}, plain`), `${name}, ${kind}`).toBeGreaterThanOrEqual(FLOORS.plain);
        expect(ran.get(`${name}, ${kind}, unlink`), `${name}, ${kind}`).toBeGreaterThanOrEqual(FLOORS.unlink);
      }
      for (let kind of TABLE_KINDS) {
        expect(ran.get(`${name}, ${kind}, plain`), `${name}, ${kind}`).toBeGreaterThanOrEqual(FLOORS.table);
      }
    }
    expect(ran.size).toBe(66);
    // And no tab and kind is held on refusals alone.
    for (let [test, applied] of taken) expect(applied, test).toBeGreaterThanOrEqual(1);
    expect(taken.size).toBe(66);
    // The range the model reads the unit before for is in the table, whatever the thinning.
    expect(corpus.unlinked).toBeGreaterThanOrEqual(1);
    expect(corpus.nothing / corpus.stretches).toBeGreaterThan(1 / 3);
  });
});
