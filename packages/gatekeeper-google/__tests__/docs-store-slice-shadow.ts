// A batch applied through the store's slices, held to the batch applied to the whole tab: the
// helpers that keep a tab as a fetch keeps it, take the runs of a stretch of its version as a
// slice, apply a batch to the slice and widen it where the model says a read fell outside it,
// store the version the slice gives and compare what the store reads of it with the whole
// tab's result. A helper and no test of its own: `storeFromEveryStretch` registers the
// differential for one sizing, in the file of that sizing. Node only: the storage is the fake.

import { beforeAll, describe, expect, it } from "vitest";
import type { GoogleDocsRequest, GoogleDocsTab } from "../src/docs-api";
import {
  applyDocsRequests, applyDocsRequestsToSlice, batchReach, hasModelFootnotes, hasModelIndexes,
  SliceEdgeError,
} from "../src/docs-model";
import type { BatchReach, SliceResult } from "../src/docs-model";
import { docEditRequests } from "../src/docs-replay";
import { pruneTab, tabIdentity } from "../src/docs-replica";
import type { DocWriteMarkerCopy } from "../src/docs-replica";
import type { RunSizes } from "../src/docs-runs";
import { DocStore } from "../src/docs-store";
import type { DocPending, DocRunSummary, DocSlice, DocVersion } from "../src/docs-store";
import { docTabToMarkdown } from "../src/markdown-converter";
import { fakeDocStorage } from "./doc-store-fake";
import type { FakeDocStorage } from "./doc-store-fake";
import { scenarioBase, wholeTabsFetched } from "./doc-store-scenarios";
import { readFixtures } from "./docs-live-fixtures";
import { SCENARIOS, stepEdit } from "./docs-live-recorder";
import type { ScenarioStep } from "./docs-live-recorder";
import { recordedSequenceCalls } from "./docs-model-draws";
import type { RecordedCall } from "./docs-model-draws";
import { PAIR_FIRSTS, pairsCorpus, SLICE_TABS } from "./docs-slice-shadow";
import type { Pair, Refusal } from "./docs-slice-shadow";
import { summaryOf, throughJson } from "./render-run-tabs";
import { WIDER } from "./wider-run";

const DOC = "doc";
const NONE: DocPending = { edits: [], roots: [] };

/**
 * `tab` as a fetch hands it to a store: decoded from JSON, so that no two parts are one
 * object, pruned, and with no start on the section break that opens its body, as Google
 * sends it.
 */
export function asFetched(tab: GoogleDocsTab): GoogleDocsTab {
  let fetched = pruneTab(throughJson(tab));
  let opening: Partial<GoogleDocsTab["body"]["content"][number]> | undefined = fetched.body.content[0];
  if (opening?.sectionBreak) delete opening.startIndex;
  return fetched;
}

/**
 * A store of its own over a `fakeDocStorage` of its own, its runs cut to `sizes`, with `tab`
 * kept in it as a fetch keeps a document's one tab, with the write markers `writeMarkers`
 * (none where not given): the storage, the store and the tab's base version.
 */
export function kept(
  tab: GoogleDocsTab, sizes?: RunSizes, writeMarkers: readonly DocWriteMarkerCopy[] = [],
): { storage: FakeDocStorage; store: DocStore; base: DocVersion } {
  let storage = fakeDocStorage();
  let store = new DocStore(storage, undefined, undefined, sizes);
  let head = store.keep(
    DOC, wholeTabsFetched({ revision: "r1", fetchedAt: 1_000, tabs: [{ tab, writeMarkers }] }, sizes),
    NONE);
  return { storage, store, base: scenarioBase(store, DOC, head) };
}

/** The sizes `version` lists for its runs, in order, read off `doc_seq`. */
export function runSizes(storage: FakeDocStorage, version: DocVersion): number[] {
  return storage.sql.exec<{ size: number }>(
    "SELECT size FROM doc_seq WHERE version = ? ORDER BY seq", version.id,
  ).toArray().map(({ size }) => size);
}

/** The first index of each run `version` lists, in order, and where the body ends. */
export function runStarts(storage: FakeDocStorage, version: DocVersion): number[] {
  let sizes = runSizes(storage, version);
  let starts = [version.bodyEndIndex - sizes.reduce((sum, size) => sum + size, 0)];
  for (let size of sizes) starts.push(starts.at(-1)! + size);
  return starts;
}

/**
 * A reach that names exactly the runs at places `[from, to)` of `version`: its lowest index
 * the first index of run `from` and its highest that of run `to - 1`, so `DocStore.slice`
 * answers that stretch. `starts` is `runStarts` of the version, for a caller that asks often.
 */
export function stretchReach(
  storage: FakeDocStorage, version: DocVersion, from: number, to: number,
  starts: readonly number[] = runStarts(storage, version),
): BatchReach {
  return { from: starts[from], to: starts[to - 1], behind: [] };
}

/**
 * How many runs `storage` holds, and how many of them do not start at 0. A run is a JSON
 * array (a context is an object): its first element's stored start is 0, or absent where it
 * is the section break that opens a body.
 */
export function runsStored(storage: FakeDocStorage): { runs: number; off: number } {
  return storage.sql.exec<{ runs: number; off: number }>(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(CASE
         WHEN json_extract(json, '$[0].startIndex') = 0 THEN 0
         WHEN json_type(json, '$[0].startIndex') IS NULL
           AND json_type(json, '$[0].sectionBreak') IS NOT NULL THEN 0
         ELSE 1 END), 0) AS off
     FROM doc_run WHERE json_valid(json) AND json_type(json) = 'array' AND json_array_length(json) > 0`,
  ).one();
}

/**
 * The refusal `thrown` is: its name and message, whatever error it is (a generated batch the
 * model has no answer for can fail it with a `TypeError`, which every slice must give too).
 * Anything thrown that is no `Error` is thrown on.
 */
function refusalOf(thrown: unknown): Refusal {
  if (!(thrown instanceof Error)) throw thrown;
  return { name: thrown.name, message: thrown.message };
}

/** What `applied` answers where the batch applies. */
export type AppliedSlice = {
  /** The slice the batch applied to: the one handed in, or the last widening of it. */
  slice: DocSlice;
  made: SliceResult;
  widenings: number;
  /** How many of the edges were thrown once the slice's first element was gone or replaced. */
  afterRemoval: number;
  /** How many attempts, the last included, left their slice with no element. */
  emptied: number;
};

/**
 * THE WIDENING LOOP on the store: `requests` applied to `slice.piece`; on a slice edge the
 * runs are taken again, wider, FROM THE STORE (`DocStore.widen`, handed the places and the
 * error) and the batch applied again. Answers the slice the batch applied to, what the model
 * answered and how often it widened, or the refusal.
 */
export function applied(
  store: DocStore, slice: DocSlice, requests: readonly GoogleDocsRequest[],
): AppliedSlice | { refused: Refusal } {
  let afterRemoval = 0, emptied = 0;
  for (let widenings = 0; ; widenings++) {
    let { content } = slice.piece;
    let opening = content[0];
    try {
      let made = applyDocsRequestsToSlice(slice.piece, requests);
      if (content.length === 0) emptied++;
      return { slice, made, widenings, afterRemoval, emptied };
    } catch (thrown) {
      if (!(thrown instanceof SliceEdgeError)) return { refused: refusalOf(thrown) };
      if (content[0] !== opening) afterRemoval++;
      if (content.length === 0) emptied++;
      slice = store.widen(slice.version, { from: slice.from, to: slice.to }, thrown);
    }
  }
}

/** What the whole tab gives for a batch, with what a store must read of the version it gives. */
export type WholeResult =
  | { refused: Refusal }
  | {
    tab: GoogleDocsTab; body: string; shared: string; markdown: string; summary: DocRunSummary;
    end: number;
  };

/**
 * What `tab` holds beside its body: its identity, its lists and its named styles, in that
 * order whatever the order of the tab's own keys. A tab with no named styles reads as one
 * whose named styles are absent.
 */
function sharedOf(tab: GoogleDocsTab): unknown[] {
  return [tabIdentity(tab), tab.lists, tab.namedStyles ?? null];
}

/** THE WHOLE-TAB OUTCOME of `requests` on `tab`: the reference every slice is held to. */
export function whole(tab: GoogleDocsTab, requests: readonly GoogleDocsRequest[]): WholeResult {
  let after: GoogleDocsTab;
  try {
    after = applyDocsRequests(tab, requests);
  } catch (thrown) {
    return { refused: refusalOf(thrown) };
  }
  let rendering = docTabToMarkdown(after);
  return {
    tab: after, body: JSON.stringify(after.body.content), shared: JSON.stringify(sharedOf(after)),
    markdown: rendering.markdown,
    summary: summaryOf(rendering), end: after.body.content.at(-1)?.endIndex ?? 0,
  };
}

/**
 * Holds that `child`, the version a slice gave, reads as the whole tab's result: its tab (the
 * body, and beside it the identity, the lists and the named styles), its Markdown, its
 * summary, where its body ends and that it is exact. The tab's JSON is compared first, and
 * the values only where the texts differ.
 */
export function expectReadsAs(
  store: DocStore, child: DocVersion, want: Extract<WholeResult, { tab: GoogleDocsTab }>,
  where: () => string,
): void {
  let tab = store.tab(child);
  if (JSON.stringify(tab.body.content) !== want.body) expect(tab, where()).toEqual(want.tab);
  else if (JSON.stringify(sharedOf(tab)) !== want.shared) {
    expect(sharedOf(tab), where()).toEqual(sharedOf(want.tab));
  }
  let markdown = store.markdown(child);
  if (markdown !== want.markdown) expect(markdown, where()).toBe(want.markdown);
  expect(store.summary(child), where()).toEqual(want.summary);
  if (child.bodyEndIndex !== want.end || !child.exact) {
    expect([child.bodyEndIndex, child.exact], where()).toEqual([want.end, true]);
  }
}

/** Thrown to end a transaction that must leave no row: each stretch starts from the same rows. */
const UNDONE = new Error("undone");

/** Runs `run` in a transaction of `store` that is undone at its end, and answers what it answered. */
export function undone<T>(store: DocStore, run: () => T): T {
  let answered: { value: T } | undefined;
  try {
    store.transaction(() => {
      answered = { value: run() };
      throw UNDONE;
    });
  } catch (thrown) {
    if (thrown !== UNDONE) throw thrown;
  }
  return answered!.value;
}

/** What a walk of every stretch of a version counted. */
export type StretchTally = {
  /** Stretches run, and those of them that hold nothing the batch names. */
  ran: number;
  nothing: number;
  /** Whether the whole tab took the batch. */
  applied: boolean;
  /** Attempts, of any stretch, that left their slice with no element. */
  emptied: number;
  /** Edges thrown once the slice's first element was gone, each answered by a wider slice. */
  afterRemoval: number;
  widenings: number;
  /** Stretches whose version lists more runs than the one it was made in. */
  grew: number;
};

/**
 * THE DIFFERENTIAL FOR ONE BATCH: `tab` kept under `sizes`, and for EVERY stretch `[from, to)`
 * of its version's runs, each from the same rows: the slice of that stretch, the batch through
 * `applied`, the version through `putSlice`, held to what the whole tab gives (the same
 * refusal by name and message, or the version read as the whole tab's result).
 */
export function expectFromEveryStretch(
  tab: GoogleDocsTab, requests: readonly GoogleDocsRequest[], sizes: RunSizes,
  where: () => string,
): StretchTally {
  let fetched = asFetched(tab);
  let want = whole(fetched, requests);
  let { storage, store, base } = kept(fetched, sizes);
  // A tab the model cannot follow takes no edit, so no slice of it is asked for.
  expect(store.unindexed(base), where()).toBe(!hasModelIndexes(fetched) || !hasModelFootnotes(fetched));
  let tally: StretchTally = {
    ran: 0, nothing: 0, applied: "tab" in want, emptied: 0, afterRemoval: 0, widenings: 0, grew: 0,
  };
  if (store.unindexed(base)) return tally;
  let starts = runStarts(storage, base);
  let runs = starts.length - 1;
  let reach = batchReach(requests);
  // The places of the runs that hold the batch's lowest and highest index.
  let placeOf = (index: number) => Math.max(0, starts.findLastIndex(
    (start, place) => place < runs && start <= index));
  let named = reach && [placeOf(reach.from), placeOf(reach.to)];
  for (let from = 0; from < runs; from++) {
    for (let to = from + 1; to <= runs; to++) {
      let at = () => `${where()}, from the runs [${from}, ${to}) of ${runs}`;
      undone(store, () => {
        let made = applied(store, store.slice(base, stretchReach(storage, base, from, to, starts)), requests);
        if ("refused" in made || "refused" in want) {
          expect("refused" in made ? { refused: made.refused } : "applied", at())
            .toEqual("refused" in want ? { refused: want.refused } : "applied");
          return;
        }
        tally.emptied += made.emptied;
        tally.afterRemoval += made.afterRemoval;
        tally.widenings += made.widenings;
        let child = store.putSlice(made.slice, made.made);
        expectReadsAs(store, child, want, at);
        if (runSizes(storage, child).length > runs) tally.grew++;
        // Every run stored starts at 0: asked once for each first run a stretch can have.
        if (to === runs && runsStored(storage).off > 0) expect(runsStored(storage), at()).toMatchObject({ off: 0 });
      });
      tally.ran++;
      if (named && (named[1] < from || named[0] >= to)) tally.nothing++;
    }
  }
  return tally;
}

/** The batch the builders make for `step` in `tab`, or nothing where they refuse the step. */
export function builtBatch(tab: GoogleDocsTab, step: ScenarioStep): GoogleDocsRequest[] | undefined {
  let view = docTabToMarkdown(tab);
  try {
    return docEditRequests(view, stepEdit(step, view));
  } catch (error) {
    if (!(error instanceof Error) || error instanceof TypeError) throw error;
    return undefined;
  }
}

/** Every recorded step of the fixture `name`: the tab Google answered before it, and its batch. */
export function recordedSteps(name: string): {
  where: string; tab: GoogleDocsTab; after: GoogleDocsTab; requests: GoogleDocsRequest[] | undefined;
}[] {
  let { before, steps } = readFixtures().find(fixture => fixture.name === name)!;
  let scenario = SCENARIOS.find(candidate => candidate.name === name)!;
  return scenario.steps.map((step, position) => {
    let tab = pruneTab(throughJson(position === 0 ? before : steps[position - 1].after));
    return {
      where: `${name}, step ${position + 1} (${step.name})`, tab,
      after: steps[position].after, requests: builtBatch(tab, step),
    };
  });
}

// The seeded sequences a sizing's file runs, A TABLE OF TWO WIDTHS: each seed with the way its
// sequences are written, and which of a seed's 320 sequences are run (those whose number is a
// multiple of `every`).
const SEQUENCES: { seeds: (readonly [seed: number, backToFront: boolean])[]; every: number } = WIDER
  ? { seeds: [[20261113, false], [20261114, true]], every: 80 }
  : { seeds: [[20261113, false]], every: 160 };

/** How many tests the calls of one seed's sequences are run as. */
const SEQUENCE_PARTS = 4;

/** The pairs of the corpus, made once a file, by the first test that reads them. */
let pairs: Pair[] | undefined;

/**
 * Registers THE STORE'S DIFFERENTIAL FOR ONE SIZING: every recorded step, the pairs whose
 * first request removes or adds a top-level element, and a share of the seeded sequences,
 * each batch through `slice`, the model and `putSlice` FROM EVERY STRETCH of its version's
 * runs under `sizes`, held to the whole tab's outcome. `share` takes every `share`-th pair of
 * each tab and first request (1 for all of them), and `widerOnly` registers the tests and
 * skips them outside the wider run, where the file's sequences are two a seed.
 */
export function storeFromEveryStretch(
  label: string, sizes: RunSizes, share: number, widerOnly: boolean,
): void {
  let title = `a batch through the store's slices, ${label}` +
    (widerOnly ? " (the wider run: GOOGLE_DOCS_WIDER_TESTS=1)" : "");
  describe.skipIf(widerOnly && !WIDER)(title, () => {
    let steps = { fixtures: 0, steps: 0, built: 0, applied: 0, ran: 0, nothing: 0 };

    it.each(readFixtures().map(fixture => fixture.name))(
      "every recorded step, from every stretch of runs: %s", name => {
        steps.fixtures++;
        for (let { where, tab, requests } of recordedSteps(name)) {
          steps.steps++;
          if (!requests) continue;
          steps.built++;
          let tally = expectFromEveryStretch(tab, requests, sizes, () => where);
          if (tally.applied) steps.applied++;
          steps.ran += tally.ran;
          steps.nothing += tally.nothing;
        }
      });

    // The tests of a file run in order: this one reads what the recordings' tests counted.
    it("ran every recorded step, from stretches that hold nothing the batch names too", () => {
      expect([steps.fixtures, steps.steps]).toEqual([33, 199]);
      expect(steps.built).toBe(199);
      expect(steps.applied).toBeGreaterThanOrEqual(150);
      expect(steps.ran).toBeGreaterThan(steps.built);
      expect(steps.nothing).toBeGreaterThan(0);
    });

    let names = Object.keys(SLICE_TABS);
    let counted = {
      pairs: 0, ran: 0, nothing: 0, emptied: 0, afterRemoval: 0, tables: 0,
      kinds: new Set<string>(),
    };

    it.each(names.flatMap(name => PAIR_FIRSTS.map(first => [name, first] as const)))(
      "the pairs, from every stretch of runs: %s, %s", (name, first) => {
        pairs ??= pairsCorpus();
        let group = pairs.filter(pair => pair.name === name && pair.first === first);
        expect(group).toHaveLength(40);
        for (let [position, pair] of group.entries()) {
          if (position % share !== 0) continue;
          let tally = expectFromEveryStretch(pair.tab, pair.requests, sizes, () => pair.label);
          expect(tally.ran, pair.label).toBeGreaterThan(0);
          counted.pairs++;
          counted.kinds.add(`${name}: ${first}`);
          counted.ran += tally.ran;
          counted.nothing += tally.nothing;
          counted.emptied += tally.emptied;
          counted.afterRemoval += tally.afterRemoval;
          if (first === "a table inserted") counted.tables += tally.grew;
        }
      });

    it("ran the pairs of every first request on every tab, and what a removal and an addition leave", () => {
      expect(counted.kinds.size).toBe(names.length * PAIR_FIRSTS.length);
      // Every `share`-th pair of each tab and first request, and the floor of a file that
      // takes a share of them: ten of each, 180 pairs.
      expect(counted.pairs).toBe(counted.kinds.size * Math.ceil(40 / share));
      expect(counted.pairs).toBeGreaterThanOrEqual(120);
      // A first request left its slice with no element; a later request read past a slice
      // whose first element was gone, and the runs were taken again from the store; a table
      // added was cut into a run of its own.
      expect(counted.emptied).toBeGreaterThan(0);
      expect(counted.afterRemoval).toBeGreaterThan(0);
      expect(counted.tables).toBeGreaterThan(0);
      expect(counted.nothing).toBeGreaterThan(0);
    });

    describe("a share of the seeded sequences, from every stretch of runs", () => {
      // Text, not objects: a tab is parsed where it is used.
      let recorded = new Map<number, RecordedCall[]>();
      let every = widerOnly ? 160 : SEQUENCES.every;
      let ran = { calls: 0, followed: 0, stretches: 0 };

      beforeAll(() => {
        for (let [seed, backToFront] of SEQUENCES.seeds) {
          recorded.set(seed, recordedSequenceCalls(seed, 320, backToFront).calls
            .filter(call => call.sequence % every === 0));
        }
      });

      // A seed's calls are a test a part, each part every `SEQUENCE_PARTS`-th call: from
      // every stretch, the calls of one seed take longer than a test is given on a busy machine.
      it.each(SEQUENCES.seeds.flatMap(([seed]) =>
        Array.from({ length: SEQUENCE_PARTS }, (_, part) => [seed, part] as const),
      ))("seed %i, part %i", (seed, part) => {
        let calls = recorded.get(seed)!;
        expect(new Set(calls.map(call => call.sequence)).size).toBe(320 / every);
        for (let [index, call] of calls.entries()) {
          if (index % SEQUENCE_PARTS !== part) continue;
          let [tab, requests] = JSON.parse(call.json) as [GoogleDocsTab, GoogleDocsRequest[]];
          let tally = expectFromEveryStretch(tab, requests, sizes, () => call.where);
          ran.calls++;
          if (tally.ran > 0) ran.followed++;
          ran.stretches += tally.ran;
        }
      });

      it("ran every call of those sequences", () => {
        let calls = [...recorded.values()].reduce((sum, of) => sum + of.length, 0);
        expect(calls).toBeGreaterThan(0);
        expect(ran.calls).toBe(calls);
        // A tab the model cannot follow takes no edit and is not sliced: most are followed.
        expect(ran.followed / ran.calls).toBeGreaterThan(0.5);
        expect(ran.stretches).toBeGreaterThan(ran.followed);
      });
    });
  });
}
