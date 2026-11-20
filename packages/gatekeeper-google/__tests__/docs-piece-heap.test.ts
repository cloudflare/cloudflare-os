// What a queued edit, a preview's card made again, a scan and a piece of a stored Google Doc
// HOLD AS LIVE HEAP, on the tabs of `pieceCountsScenario`: a tab of 20,000 paragraphs and a
// tab of thousands of runs. Bounds are bytes read after full collections at a statement
// inside the call, multiples of a run's maximum and of the edit's text, and bytes a run as a
// difference between two sizes of one shape: never a clock. Node only: the collector is
// Node's, and the storage the fake.
//
// EVERY MEASURE IS TAKEN IN A FUNCTION OF ITS OWN that answers numbers: a temporary of the
// measuring frame would pin what it measured and make a bound pass on nothing.
//
// A WEAK REFERENCE MADE INSIDE A CALL KEEPS ITS TARGET UNTIL THE JOB ENDS, so nothing made
// inside one synchronous preparation can be seen collected at a statement of that same
// preparation. Inside a call this file reads bytes; that the renderings a call made are gone
// is read from weak references once the call has returned and a later job runs.
//
// A file of its own, because it wraps a module for every test of its file: `decodeRun` as
// the store imports it, so that a test can watch the elements a piece decoded.

import { createSimulationStore } from "@gadgets/gatekeeper-kit/simulation-store";
import { getHeapSpaceStatistics } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleDocsTab } from "../src/docs-api";
import { storedTabReading } from "../src/docs-reading";
import { docTabReducer, tabEditRequests, type QueuedDocRecord } from "../src/docs-replay";
import { RUN_SIZES, type RunSizes } from "../src/docs-runs";
import { DocStore } from "../src/docs-store";
import {
  prepareAppend, prepareTableChange, prepareTextReplacement,
} from "../src/docs-table-actions";
import { MARKDOWN_RENDERING_VERSION } from "../src/markdown-converter";
import { fakeDocStorage, type FakeDocStorage } from "./doc-store-fake";
import {
  nestedItemsTab, pieceShapeKept, scenarioBase, scenarioCopy, scenarioTab,
} from "./doc-store-scenarios";
import { collect, HEAP_MEASURED, observing } from "./heap-held";
import { WIDER } from "./wider-run";

// What a test is told of each run decoded: nothing, unless it asks.
const watch = vi.hoisted(() => ({ decoded: undefined as ((elements: readonly object[]) => void) | undefined }));

vi.mock("../src/docs-runs", async importOriginal => {
  let runs = await importOriginal<typeof import("../src/docs-runs")>();
  let decodeRun: typeof runs.decodeRun = (...given) => {
    let run = runs.decodeRun(...given);
    if (run) watch.decoded?.(run.elements);
    return run;
  };
  return { ...runs, decodeRun };
});

const NONE = { edits: [], roots: [] };
const LABEL = "\"Main\" (t1)";
const LIMIT = { chars: 1 << 20, refusal: () => new Error("The card was refused.") };
const KIB = 1024;
const putsRendering = (query: string) => query.startsWith("INSERT INTO doc_md");
const comparesLists = (query: string) => query.startsWith("SELECT b.seq AS place");
const readsRun = (query: string) => query.startsWith("SELECT json FROM doc_run");
const readsMarkdown = (query: string) => query.startsWith("SELECT md FROM doc_md");
const laterJob = () => new Promise(resolve => setImmediate(resolve));

/** True at the `n`th statement `is` chooses, counted from 1, and at no other. */
function nth(n: number, is: (query: string) => boolean): (query: string) => boolean {
  let seen = 0;
  return query => is(query) && ++seen === n;
}

/**
 * What is in use after six full collections: the heap's objects, which is all of it but the
 * engine's own code (compiled or not, it comes and goes by kilobytes as a call runs), and
 * the buffers outside the heap. SIX, MEASURED: what the calls before left on the stack can
 * hold their last values through one, and a reading after two or three is, in two to five
 * runs of this file in sixty under load, 70 to 300 KB off what the call holds at one moment
 * or another; after six, in none of sixty, and no reading moves by over 10 KB.
 */
function objectsInUse(): number {
  for (let pass = 0; pass < 6; pass++) collect();
  let objects = 0;
  for (let { space_name, space_used_size } of getHeapSpaceStatistics()) {
    if (!/code|trusted/.test(space_name)) objects += space_used_size;
  }
  return objects + process.memoryUsage().arrayBuffers;
}

/**
 * How much more is in use, at the first statement each of `moments` chooses inside `call`,
 * than before it: the readings of ONE call, in the order given. `call` builds its own store
 * over the storage it is handed and answers nothing, so this frame holds numbers only.
 * @throws Where a moment is not reached: a measure of no statement is no measure.
 */
function heldAt(
  storage: FakeDocStorage, moments: readonly ((query: string) => boolean)[],
  call: (observed: FakeDocStorage) => void,
): number[] {
  let readings: (number | undefined)[] = moments.map(() => undefined);
  let before = objectsInUse();
  call(observing(storage, query => {
    // Every moment is asked of every statement, since a moment may count the ones it passes.
    moments.forEach((at, moment) => {
      if (at(query)) readings[moment] ??= objectsInUse() - before;
    });
  }));
  return readings.map((reading, moment) => {
    if (reading === undefined) throw new Error(`Moment ${moment} was not reached.`);
    return reading;
  });
}

/**
 * A tab of the scenario, kept: its storage, what the cases edit, and `R` and `M`. The tab
 * itself is let go once it is stored: the heap this file reads holds no document.
 */
type Kept = Omit<ReturnType<typeof pieceShapeKept>, "tab"> & {
  storage: FakeDocStorage;
  /** The longest stored run's JSON, in bytes at two a character, and Markdown, in characters. */
  run: number; markdown: number;
};
const shapes = new Map<string, Kept>();

/** The scenario's tab for `shape` and `size`, kept once a file by the first test that reads it. */
function keptShape(shape: "prose" | "tables", size: number): Kept {
  let key = `${shape} ${size}`;
  let known = shapes.get(key);
  if (!known) {
    let storage = fakeDocStorage();
    let { tab: _tab, ...made } = pieceShapeKept(storage, shape, size);
    let longest = (query: string) => Number(Object.values(storage.sql.exec(query).one())[0]);
    known = {
      ...made, storage, run: 2 * longest("SELECT MAX(LENGTH(json)) AS longest FROM doc_run"),
      markdown: longest("SELECT MAX(LENGTH(md)) AS longest FROM doc_md"),
    };
    shapes.set(key, known);
  }
  return known;
}

/**
 * `tab` kept in a storage of its own as the document `doc`, its runs cut to `sizes`: the
 * storage, a store over it and the tab's base version. Its own few lines, and not the
 * helper the slices' tests share: that one's module loads the recorded corpus, and every
 * collection of this file would walk it.
 */
function keptTab(tab: GoogleDocsTab, sizes: RunSizes = RUN_SIZES) {
  let storage = fakeDocStorage();
  let store = new DocStore(storage, undefined, undefined, sizes);
  let base = scenarioBase(store, "doc", store.keep("doc", scenarioCopy([tab], "r1", sizes), NONE));
  return { storage, store, base };
}

/** Removes what the last case stored, as a rejection sweeps it. */
const sweep = ({ storage }: { storage: FakeDocStorage }) => new DocStore(storage).sweep("doc", NONE);

/** The stored JSON of the run `version` lists at `place`, in bytes at two a character. */
function runBytes(storage: FakeDocStorage, version: { id: string }, place: number): number {
  return 2 * storage.sql.exec<{ size: number }>(
    "SELECT LENGTH(doc_run.json) AS size FROM doc_seq JOIN doc_run ON doc_run.id = doc_seq.run " +
    "WHERE doc_seq.version = ? AND doc_seq.seq = ?", version.id, place).one().size;
}

/** A preparation of the scenario, made through `store`. */
type Prepare = (store: DocStore, kept: Kept) => unknown;
const replacement = (name: string): Prepare => (store, { base, edits }) => prepareTextReplacement(
  store, base, edits.replacements[name].oldMarkdown, edits.replacements[name].newMarkdown, LABEL, LIMIT);
const appended: Prepare = (store, { base }) => prepareAppend(store, base, "More");
const rowAdded = (table?: number): Prepare => (store, { base, edits }) => prepareTableChange(
  store, base, { method: "insertTableRows", lines: { table: table ?? edits.table, cells: [["added"]] } }, LABEL);
const tableAdded: Prepare = (store, { base, edits }) => prepareTableChange(
  store, base, { method: "insertTable", table: { rows: 1, columns: 1, cells: [["new"]], after: edits.after } },
  LABEL);

/**
 * What `prepare` holds where it makes its edit, at the first rendering stored, and where it
 * finds its result stored, at the comparison of the two versions' lists, on a tab kept in
 * `storage`: numbers. What it stored is swept before the first and after the second.
 */
function madeAndFound(storage: FakeDocStorage, prepare: (observed: FakeDocStorage) => void) {
  // Once before anything is measured: what a first use of the path allocates for good.
  prepare(storage);
  sweep({ storage });
  let [made] = heldAt(storage, [putsRendering], prepare);
  let [found] = heldAt(storage, [comparesLists], prepare);
  sweep({ storage });
  return { made, found };
}

describe("what is in hand at the worst moment", HEAP_MEASURED, () => {
  // TWO MOMENTS of a preparation. MADE: a rendering being stored inside `putSlice`. In hand
  // then: the slice's runs as the model left them (the piece's own, taken from it), the runs
  // cut from them, one of them as its JSON and its rendering, the batch, and for a table
  // change its pending card's strings. FOUND STORED (the same preparation a second time): the
  // first statement of the comparison of the two versions' lists, which follows the result's
  // read. In hand then: the result, and a table change's pending card. AT NEITHER, ANYTHING OF
  // THE PIECE: the reading let go of its rendering when the edit was made, and the model
  // dropped the decoded runs its slice did not take.
  //
  // MEASURED on the tab of 20,000 paragraphs, with `R` 130,692 bytes (the longest run's JSON
  // at two bytes a character), made and found: a replacement 207 KB (1.6 R) and 5 to 7 KB;
  // one in a run's first paragraph 204 to 207 KB and 10 to 11 KB; an append 246 to 248 KB
  // (1.9 R) and 8 to 9 KB; a row added 65 KB (0.5 R: the table's run is small) and 21 KB
  // (its pending card); a table added after a line 150 KB (1.1 R) and 8 KB. MADE is pinned
  // under 3 R: a decoded run weighs about its JSON at two bytes a character, and the run cut
  // from it and its rendering are in hand beside it. FOUND is pinned under 64 KiB, half a
  // run: a decoded run of the piece still in hand there reads 70 KB or more beside a
  // paragraph.
  //
  // THOSE BOUNDS HAVE ROOM FOR A PIECE OF A RUN OR TWO, so two more tests hold what they
  // cannot:
  // - THE RUN BEFORE THE PIECE'S PLACE, which a piece in a run's first paragraph decodes and
  //   the batch does not name: that replacement holds what the one in the middle of the same
  //   run holds. MEASURED over sixty runs of the file: the two differ by 1 to 4 KB; with
  //   that run kept through the model, by 90 to 140 KB (it is the tab's longest: 130,692
  //   bytes of JSON). Pinned under a third of that run's JSON, 43 KB.
  // - THE PIECE'S RENDERING, on a closure that is the document: a replacement under 3,000
  //   nested items of one level-0 item, whose piece is the tab (321,034 characters of
  //   Markdown; with its source map, 1.9 MB of heap). MEASURED: made 50 to 76 KB, found 5 to
  //   20 KB; with the rendering kept through the model and the card's reads, 1.9 MB at both.
  //   Both pinned under half the piece's Markdown at a byte a character (160 KB).
  const MIDDLE = "a replacement", FIRST = "a replacement in a run's first paragraph";
  const PREPARED: Record<string, Prepare> = {
    [MIDDLE]: replacement("replaceMiddle"),
    [FIRST]: replacement("replaceFirst"),
    "an append": appended,
    "a row added": rowAdded(),
    "a table added after a line": tableAdded,
  };

  const read = new Map<string, { made: number; found: number }>();
  /** The two readings of the preparation `name` on the tab of 20,000 paragraphs, taken once a file. */
  function held(name: string): { made: number; found: number } {
    let kept = keptShape("prose", 20_000);
    let known = read.get(name) ??
      madeAndFound(kept.storage, observed => void PREPARED[name](new DocStore(observed), kept));
    read.set(name, known);
    return known;
  }

  it.each(Object.keys(PREPARED))("%s holds runs and nothing of its piece", name => {
    let { made, found } = held(name);

    expect(made).toBeGreaterThan(0);
    expect(made).toBeLessThan(3 * keptShape("prose", 20_000).run);
    expect(found).toBeLessThan(64 * KIB);
  });

  it("a replacement in a run's first paragraph holds no run before its own", () => {
    let { storage, base, edits } = keptShape("prose", 20_000);
    let before = runBytes(storage, base, edits.places.text - 1);

    let first = held(FIRST).made, middle = held(MIDDLE).made;

    // A decoded run weighs over its JSON at two bytes a character: one kept is no third of it.
    expect(before).toBeGreaterThan(64 * KIB);
    expect(Math.abs(first - middle)).toBeLessThan(before / 3);
  });

  it("a replacement whose closure is the document holds no rendering of it", () => {
    let { storage, base } = keptTab(nestedItemsTab("t1", 3_000, 100));
    // The piece is the tab (`docs-piece-counts.test.ts` holds where it stands).
    let closure = new DocStore(storage).markdown(base).length;

    let { made, found } = madeAndFound(storage, observed => void prepareTextReplacement(
      new DocStore(observed), base, "target item", "changed item", LABEL, LIMIT));

    expect(closure).toBeGreaterThan(300_000);
    expect(made).toBeGreaterThan(0);
    expect(made).toBeLessThan(closure / 2);
    expect(found).toBeLessThan(closure / 2);
  });
});

describe("a scan holds the text and a run", HEAP_MEASURED, () => {
  // The text of over 1 MiB stands before the measure starts. At the read of the middle
  // run's Markdown, beyond it: MEASURED 120 KB, of runs of 47,188 characters at most (94 KB
  // at two bytes a character): the run read, the run before it, which the scan's tail
  // keeps, and the page of the list. Pinned under two runs' Markdown and 32 KiB (221 KB);
  // the tab's Markdown joined would be 2.4 MB of characters.
  it("on the tab of 20,000 paragraphs, for a text of 1 MiB", () => {
    let kept = keptShape("prose", 20_000);
    let scan = (storage: FakeDocStorage) =>
      void storedTabReading(new DocStore(storage), kept.base).find(kept.edits.scan);
    scan(kept.storage);

    let [held] = heldAt(kept.storage, [nth(kept.n >> 1, readsMarkdown)], scan);

    expect(kept.edits.scan.length).toBeGreaterThan(1 << 20);
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThan(2 * 2 * kept.markdown + 32 * KIB);
  });
});

describe("a large edit holds a stated multiple of its text", HEAP_MEASURED, () => {
  // The replacement of 945 paragraphs, over 0.45 MiB, by as much other text. `E` is its
  // longer text in bytes at two a character (948,776); the two texts stand before the
  // measure starts and are not in it. THE ENGINE HOLDS ASCII AT A BYTE A CHARACTER, so a
  // string of the text's length weighs `E / 2`. Three moments of one call, MEASURED on
  // 20,000 paragraphs (and on 5,000 within 3%: the multiple is of the text, not of the tab):
  // (a) inside the piece, at the read of the last run it decodes: the own runs decoded
  //     beside their renderings: 1.48 E (1.41 MB). Pinned under 1.7 E + R.
  // (b) inside `putSlice`, at the first rendering stored: the batch, which holds the new
  //     text, the slice's runs as the model left them and the runs cut from them, and no
  //     rendering of the tab before: 2.20 E (2.09 MB), THE LARGEST. Pinned under 2.6 E + R.
  // (c) inside `changedMarkdown`, at the read of the last run of the version after: the two
  //     strings of the card a run short: 1.02 E (0.96 MB). Pinned under 1.3 E + R, and over
  //     0.9 E: both strings are in hand there.
  it.each([20_000, 5_000])("at three moments of one call, on a tab of %i paragraphs", size => {
    let kept = keptShape("prose", size);
    let large = replacement("largeEdit");
    let { oldMarkdown, newMarkdown } = kept.edits.replacements.largeEdit;
    let text = 2 * Math.max(oldMarkdown.length, newMarkdown.length);
    large(new DocStore(kept.storage), kept);
    sweep(kept);
    // The runs the piece decodes: its own and the one after them. The card reads, after the
    // scan's `n`, 48 runs' Markdown: the moment is the last of them.
    let pieceRuns = kept.edits.own! + 1;

    let [piece, stored, card] = heldAt(
      kept.storage,
      [nth(pieceRuns, readsRun), nth(1, putsRendering), nth(kept.n + 48, readsMarkdown)],
      observed => void large(new DocStore(observed), kept));
    sweep(kept);

    expect(text).toBeGreaterThan(2 * 0.45 * (1 << 20));
    expect(piece).toBeLessThan(1.7 * text + kept.run);
    expect(piece).toBeGreaterThan(text);
    expect(stored).toBeLessThan(2.6 * text + kept.run);
    expect(stored).toBeGreaterThan(piece);
    expect(card).toBeLessThan(1.3 * text + kept.run);
    expect(card).toBeGreaterThan(0.9 * text);
  });
});

describe("a per-run term, in bytes a run", HEAP_MEASURED, () => {
  // The shape of many runs at two sizes: what a call holds at the same moment of each, and
  // THE DIFFERENCE DIVIDED BY THE RUNS BETWEEN. A row cannot be added to a tab whose tables
  // hold 5,000 cells, so in the wider run the cases that add one stop at 4,900 pairs.
  const PAIRS = WIDER ? [4_900, 9_800] as const : [1_000, 2_000] as const;
  const ROW_PAIRS = WIDER ? [2_450, 4_900] as const : PAIRS;
  /** Bytes a run under which a member is held: what two readings of one moment differ by. */
  const BOUND = WIDER ? 4 : 16;
  const digits = (at: number) => String(at).padStart(5, "0");
  const lastPiece = (store: DocStore, kept: Kept, pairs: number) =>
    storedTabReading(store, kept.base).piece({ table: pairs - 1 });

  type Member = {
    /** The moments inside the call, for a tab kept as `kept`. */
    at(kept: Kept): ((query: string) => boolean)[];
    call(store: DocStore, kept: Kept, pairs: number): void;
    /** Whether the call stores an edit (swept after), and whether one is stored before it. */
    makes?: true; stored?: true;
    pairs?: readonly [number, number];
  };
  // Each at the tab's last table, so that every run of the tab stands before the moments.
  const MEMBERS: Record<string, Member> = {
    // Inside `DocStore.piece`: at the second run decoded, which is the second attempt's
    // first, and at the twelfth, in the pass that makes the piece.
    "a piece, at its second attempt and in its last pass": {
      at: () => [nth(2, readsRun), nth(12, readsRun)],
      call: (store, kept, pairs) => void lastPiece(store, kept, pairs),
    },
    // At the Markdown of the last run of the last full page of the list: the page in hand
    // is 500 runs on either tab, and every page before it is passed.
    "the scan of a cell's text": {
      at: kept => [nth(500 * Math.floor(kept.n / 500), readsMarkdown)],
      call: (store, kept, pairs) => void storedTabReading(store, kept.base).find(`cell ${digits(pairs - 1)}`),
    },
    // Read back from the last table to the one paragraph that holds text, in the tab's
    // middle: at a run twenty short of it.
    "the line before the last table": {
      at: kept => [nth((kept.n >> 1) - 20, readsMarkdown)],
      call: (store, kept, pairs) => {
        let piece = lastPiece(store, kept, pairs);
        let { mdStart } = piece.sourceMap.tables[pairs - 1 - piece.part!.tablesBefore];
        void storedTabReading(store, kept.base).lineBefore(piece.part!.mdStart + mdStart);
      },
    },
    "a row added, queued end to end, inside putSlice": {
      at: () => [putsRendering], makes: true, pairs: ROW_PAIRS,
      call: (store, kept, pairs) => void rowAdded(pairs - 1)(store, kept),
    },
    // Found stored: where the two versions' lists are compared (`changed`), and among the
    // eight runs the card then reads, which follow the line before the table, read back
    // over half the tab less seven runs.
    "a row added, at its card's comparison and its reads of the runs that differ": {
      at: kept => [comparesLists, nth((kept.n >> 1) - 2, readsMarkdown)], stored: true, pairs: ROW_PAIRS,
      call: (store, kept, pairs) => void rowAdded(pairs - 1)(store, kept),
    },
  };

  /** What `member` holds at each of its moments on a tab of `pairs` pairs: numbers. */
  function heldOn(member: Member, pairs: number): number[] {
    let kept = keptShape("tables", pairs);
    if (member.stored) member.call(new DocStore(kept.storage), kept, pairs);
    let held = heldAt(kept.storage, member.at(kept), observed => member.call(new DocStore(observed), kept, pairs));
    if (member.makes || member.stored) sweep(kept);
    return held;
  }

  // MEASURED, default (1,000 against 2,000 pairs, 2,000 runs between): from -1.7 to 1.4
  // bytes a run over sixty runs of the file; two readings of one moment differ by up to
  // 10 KB, which is 5 bytes a run here. In the wider run (4,900 against 9,800 pairs, 9,800
  // runs between, or 2,450 against 4,900 where a row is added): under one byte a run. A
  // member that kept one number for every run would read 8 or more, and a rendering or a
  // summary a run hundreds.
  it.each(Object.keys(MEMBERS))("%s holds nothing for every run", name => {
    let member = MEMBERS[name];
    let [small, large] = member.pairs ?? PAIRS;
    let runs = keptShape("tables", large).n - keptShape("tables", small).n;
    // Made once on the larger tab before it is measured: what its code takes the first
    // time it runs is not what it holds.
    heldOn(member, large);

    let onLarge = heldOn(member, large), onSmall = heldOn(member, small);

    let perRun = onLarge.map((held, moment) => (held - onSmall[moment]) / runs);
    for (let term of perRun) expect(Math.abs(term)).toBeLessThan(BOUND);
  });
});

describe("the document-sized closures", HEAP_MEASURED, () => {
  const ONE: RunSizes = { least: Infinity, target: Infinity, most: Infinity, elements: 1 };
  const breaks = () => scenarioTab(
    "t1", ["X", "A", "B", "Lead", ...Array.from({ length: 200 }, () => ""), "Tail", "C", "D", "Y"]);

  /** `tab` kept under `sizes`: a reading of it, and the range of `text` in it. No tab leaves this. */
  function readingOf(tab: () => GoogleDocsTab, sizes: RunSizes, text: string) {
    let { store, base } = keptTab(tab(), sizes);
    let reading = storedTabReading(store, base);
    let mdStart = reading.find(text) as number;
    return { reading, own: { markdown: { mdStart, mdEnd: mdStart + text.length } } };
  }

  /**
   * The piece of `own`, made and handed back with what was in use before it and a weak
   * reference to the first element of each run decoded for it, in order. With `taken`, the
   * runs the reading kept decoded for the model are taken from it and dropped, as the edit
   * takes them: what is left in hand is the rendering. In a function of its own: the test's
   * frame names the rendering and numbers.
   */
  function pieceOf({ reading, own }: ReturnType<typeof readingOf>, taken: boolean) {
    let decoded: WeakRef<object>[] = [];
    let before = objectsInUse();
    watch.decoded = elements => void decoded.push(new WeakRef(elements[0]));
    let rendering = reading.piece(own);
    watch.decoded = undefined;
    if (taken) void reading.takeDecoded();
    return { rendering, before, decoded };
  }

  // A PIECE HELD IS ITS MARKDOWN AND ITS SOURCE MAP, and nothing of the runs decoded for it
  // once the runs the reading kept for the model are taken: of the runs decoded (675 beside
  // the empty paragraphs and 10,115 under the nested items, a run an element, attempts and
  // scouts included) no element can still be reached. MEASURED against the Markdown at two
  // bytes a character and the source map as JSON (29 KB beside the empty paragraphs, 1.5 MB
  // under the nested items): 1.4 and 1.7 to 1.9 times beside the empty paragraphs (one run,
  // and a run an element), 1.2 and 1.8 times under the nested items; pinned under 3 times,
  // as the piece's own test pins it (the renderer's arrays are grown by `push`, with room
  // to spare), and over half.
  it.each([
    ["200 empty paragraphs, the store's sizes", breaks, RUN_SIZES, "Tail", 1],
    ["200 empty paragraphs, one element a run", breaks, ONE, "Tail", 675],
    ["3,000 nested items, the store's sizes", () => nestedItemsTab("t1", 3_000, 100), RUN_SIZES, "target item", 0],
    ["3,000 nested items, one element a run", () => nestedItemsTab("t1", 3_000, 100), ONE, "target item", 10_115],
  ] as const)("holds its Markdown and source map, and not its decoded runs: %s", async (_name, tab, sizes, text, runs) => {
    // A piece made once before anything is measured: what the path allocates the first time.
    void pieceOf(readingOf(breaks, RUN_SIZES, "Tail"), true);
    let { rendering, before, decoded } = pieceOf(readingOf(tab, sizes, text), true);
    await laterJob();
    let held = objectsInUse() - before;
    let measure = 2 * rendering.markdown.length + JSON.stringify(rendering.sourceMap).length;

    expect(held).toBeGreaterThan(0.5 * measure);
    expect(held).toBeLessThan(3 * measure);
    if (runs > 0) expect(decoded.length).toBe(runs);
    else expect(decoded.length).toBeGreaterThan(40);
    expect(decoded.filter(run => run.deref() !== undefined)).toEqual([]);
    expect(rendering.markdown).toContain(text);
  });

  // TEETH for the references, and what a reading keeps until the edit takes it: the own run
  // and the run before the piece's place, decoded, and no other of the 675.
  it("a reading keeps decoded the own run and the run before it, and no other", async () => {
    let asked = readingOf(breaks, ONE, "Tail");
    let { rendering, decoded } = pieceOf(asked, false);
    await laterJob();
    collect();
    collect();

    expect(decoded.length).toBe(675);
    expect(decoded.filter(run => run.deref() !== undefined).length).toBe(2);
    expect(asked.reading.takeDecoded()?.size).toBe(2);
    expect(rendering.markdown).toContain("Tail");
  });
});

describe("nothing of a document is held once a call returns", HEAP_MEASURED, () => {
  const original = DocStore.prototype.piece;
  afterEach(() => {
    DocStore.prototype.piece = original;
  });

  /**
   * Makes `call` over a store whose every piece is watched: a weak reference to the source
   * map of each piece made, and nothing else of it. Answers what the call answered and the
   * references. A plain wrapper and no spy: a spy keeps what each call returned.
   */
  function watched<T>(call: (store: DocStore, kept: Kept) => T): { answer: T; pieces: WeakRef<object>[] } {
    let kept = keptShape("prose", 20_000);
    let pieces: WeakRef<object>[] = [];
    DocStore.prototype.piece = function (this: DocStore, ...asked) {
      let piece = original.apply(this, asked);
      pieces.push(new WeakRef(piece.rendering.sourceMap));
      return piece;
    };
    let answer = call(new DocStore(kept.storage), kept);
    DocStore.prototype.piece = original;
    return { answer, pieces };
  }

  const queued = (kept: Kept): QueuedDocRecord[] => kept.edits.queue.map((edit, at) => ({
    id: at + 1,
    action: { type: "replaceText", ...edit, tabId: "t1", markdownVersion: MARKDOWN_RENDERING_VERSION },
  }));

  it.each([
    ["a replacement", replacement("replaceMiddle")],
    ["an append", appended],
    ["a row added", rowAdded()],
    ["a table added after a line", tableAdded],
    ["a fold of three queued edits", (store, kept) => {
      let { entity, refused } = createSimulationStore(docTabReducer(store)).fold("t1", kept.base, queued(kept));
      return { id: entity?.id, refused: refused.length };
    }],
    ["an approval's batch built from the copy", (store, kept) => tabEditRequests(
      storedTabReading(store, kept.base), { type: "replaceText", ...kept.edits.replacements.replaceMiddle })],
  ] as [string, Prepare][])("%s leaves no rendering reachable", async (_name, call) => {
    let { answer, pieces } = watched(call);
    await laterJob();
    collect();
    collect();

    // The answer is strings, numbers and requests: it is still held here.
    expect(JSON.stringify(answer).length).toBeGreaterThan(0);
    expect(pieces.length).toBeGreaterThan(0);
    expect(pieces.filter(piece => piece.deref() !== undefined)).toEqual([]);
    sweep(keptShape("prose", 20_000));
  });
});
