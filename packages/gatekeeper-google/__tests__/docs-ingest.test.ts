// What a fetch of a Google Doc stores and what it holds while it does. A fetched document is
// stored as it is read: each run is written, with its rendering, when it is cut, and the
// parsed answer lets go of each element before the run that holds it is written. A read
// through Drive holds the document, until its scope check has passed, as the bytes of its
// runs' stored JSON and nothing made of them, and stores it from those bytes. Held here:
// that the rows are those of the same tabs stored whole; that what is in hand is one run and
// that what was written can be collected; that a fetch that throws leaves storage as it was;
// and that a tab fetched unchanged renders, keys and writes nothing.

import { describe, expect, it } from "vitest";
import type { GoogleDocsDocument, GoogleDocsTab, StructuralElement } from "../src/docs-api";
import { inHandDocCopies } from "../src/docs-copy";
import { fetchedDoc, pruneTab, tabIdentity } from "../src/docs-replica";
import type { FetchedDoc } from "../src/docs-replica";
import { cutRuns, decodeRun, RUN_SIZES } from "../src/docs-runs";
import type { CutRun, RunSizes } from "../src/docs-runs";
import {
  DOC_ROW_BYTES, DocRowTooLargeError, DocStore, docStoreCost, heldDoc,
} from "../src/docs-store";
import type { DocCopyHead, DocPending, HeldDoc } from "../src/docs-store";
import { docTabToMarkdown } from "../src/markdown-converter";
import { buildTab, grid, item, NUMBERED_LIST, para } from "./doc-fixture";
import type { BlockSpec } from "./doc-fixture";
import { fakeDocStorage } from "./doc-store-fake";
import type { FakeDocStorage } from "./doc-store-fake";
import {
  DRIVE_READ_SCENARIO, driveReadScenario, FETCH_ATOMIC_SCENARIO, fetchAtomicScenario,
  LATE_FETCH_SCENARIO, lateFetchScenario, listRunsTab, proseTab, scenarioBase, scenarioTab,
  tinyTablesTab, wholeTabsFetched,
} from "./doc-store-scenarios";
import {
  CUTS, distinctTabs, documentOf, FORCED, FUZZED, LARGE, linesTab, MARKED, RECORDED, weakRefs,
  writeMarkersOf,
} from "./docs-fetched-corpus";
import type { NamedTabs } from "./docs-fetched-corpus";
import { readFixtures } from "./docs-live-fixtures";
import { collect, HEAP_MEASURED, inUse, observing } from "./heap-held";

const DOC = "doc";
const NONE: DocPending = { edits: [], roots: [] };

/**
 * The most bytes `GoogleDocsApi.getDocument` reads of an answer (`src/docs-api.ts`, which
 * exports no name for it).
 */
const ANSWER_LIMIT_BYTES = 10 * 1024 * 1024;

/** A store over a storage of its own, its runs cut to `sizes`. */
function opened(sizes?: RunSizes): { storage: FakeDocStorage; store: DocStore } {
  let storage = fakeDocStorage();
  return { storage, store: new DocStore(storage, undefined, undefined, sizes) };
}

/** What `run` moved of the store's counts. */
function moved(run: () => unknown) {
  let before = { ...docStoreCost };
  run();
  return {
    runsDecoded: docStoreCost.runsDecoded - before.runsDecoded,
    runsRendered: docStoreCost.runsRendered - before.runsRendered,
    runsKeyed: docStoreCost.runsKeyed - before.runsKeyed,
    rowsWritten: docStoreCost.rowsWritten - before.rowsWritten,
  };
}

/** The rows of the four tables a tab is stored in, as JSON, by table. */
function tabRows(storage: FakeDocStorage): Record<string, string[]> {
  let rows = storage.rows();
  return Object.fromEntries(["doc_run", "doc_md", "doc_seq", "doc_version"]
    .map(table => [table, rows[table].map(row => JSON.stringify(row))]));
}

/** The rows version `id` is stored as: its record, its list, and the runs and renderings the list names. */
function versionRows(storage: FakeDocStorage, id: string): unknown[][] {
  let rows = (query: string) => storage.sql.exec(query, id).toArray();
  return [
    rows("SELECT * FROM doc_version WHERE id = ?"),
    rows("SELECT * FROM doc_seq WHERE version = ? ORDER BY seq"),
    rows(`SELECT * FROM doc_run WHERE id IN (SELECT run FROM doc_seq WHERE version = ?1)
      OR id IN (SELECT context FROM doc_version WHERE id = ?1) ORDER BY id`),
    rows(`SELECT doc_md.* FROM doc_md JOIN (SELECT DISTINCT run, context, carry FROM doc_seq
      WHERE version = ?) AS listed ON doc_md.run = listed.run AND doc_md.context = listed.context
      AND doc_md.carry = listed.carry ORDER BY doc_md.run, doc_md.context, doc_md.carry`),
  ];
}

/** The ids of the runs `tab` is cut into under `sizes`, in order. */
function runsOf(storage: FakeDocStorage, version: string): string[] {
  return storage.sql.exec<{ run: string }>(
    "SELECT run FROM doc_seq WHERE version = ? ORDER BY seq", version).toArray().map(({ run }) => run);
}

// ---------------------------------------------------------------------------
// The edges of the walk, each a document built here
// ---------------------------------------------------------------------------

const texts = (count: number, text: (at: number) => string = at => `Paragraph ${at}.`) =>
  Array.from({ length: count }, (_, at) => para(text(at)));

/** `tab` under the id `tabId`, at `index` among the tabs of its parent. */
const placed = (tab: GoogleDocsTab, tabId: string, index = 0, more: Partial<GoogleDocsTab> = {}) =>
  ({ ...tab, tabId, index, ...more });

/** Two tabs of one document with the same body, lists and named styles. */
function twoTabsWithOneBody(): GoogleDocsTab[] {
  let tab = buildTab([...texts(40), item("first", "N1"), item("second", "N1")], NUMBERED_LIST);
  return [placed(tab, "t.1", 0), placed(tab, "t.2", 1)];
}

/** A body of one element, and a body of none. */
function smallBodies(): GoogleDocsTab[] {
  let one = buildTab([]);
  return [
    placed({ ...one, body: { content: one.body.content.slice(0, 1) } }, "t.one", 0),
    placed({ ...one, body: { content: [] } }, "t.empty", 1),
  ];
}

/** A table as a body's first element, as its first after the opening break, and as its last. */
function tablesAtTheEnds(): GoogleDocsTab[] {
  let table = grid(["a", "b"], ["c", "d"]);
  let first = buildTab([table, ...texts(5)]);
  return [
    placed({ ...first, body: { content: first.body.content.slice(1) } }, "t.first", 0),
    placed(first, "t.after-break", 1),
    placed(buildTab([...texts(5), table]), "t.last", 2),
  ];
}

/** A tab whose last element ends a run under `FORCED` (three elements a run at most). */
const endsOnARun = (more: number): GoogleDocsTab => placed(buildTab(texts(5 + more)), "t.ends");

/** A long stretch of paragraphs drawn from three forms: the cut ends its runs by size alone. */
function fewDistinctParagraphs(): GoogleDocsTab[] {
  let forms = ["An empty line of a form.", "", "A second form of a line, somewhat longer than the first."];
  return [placed(buildTab(texts(3_000, at => forms[at % 3])), "t.few")];
}

/** Tabs nested four deep, with write markers in a tab of the third level alone. */
function childTabsFourDeep(): GoogleDocsTab[] {
  let tab = (tabId: string, level: number, index: number, parent?: string): GoogleDocsTab => ({
    ...buildTab(texts(4, at => `${tabId}, paragraph ${at}.`)), tabId, title: `Tab ${tabId}`, index,
    nestingLevel: level, ...(parent === undefined ? {} : { parentTabId: parent }),
  });
  return [
    tab("t.a", 0, 0), tab("t.a.a", 1, 0, "t.a"), tab("t.a.a.a", 2, 0, "t.a.a"),
    tab("t.a.a.a.a", 3, 0, "t.a.a.a"),
    {
      ...tab("t.a.a.b", 2, 1, "t.a.a"),
      namedRanges: {
        "gadgets-write-w1": { namedRanges: [
          { namedRangeId: "marker-1", name: "gadgets-write-w1" },
          { namedRangeId: "marker-2", name: "gadgets-write-w1" },
        ] },
        bookmark: { namedRanges: [{ namedRangeId: "range-1", name: "bookmark" }] },
      },
    },
    tab("t.a.b", 1, 1, "t.a"), tab("t.b", 0, 1),
  ];
}

const EDGES: NamedTabs[] = [
  { name: "two tabs with one body", tabs: twoTabsWithOneBody() },
  { name: "a tab of one element, and an empty body", tabs: smallBodies() },
  { name: "a table first, and a table last", tabs: tablesAtTheEnds() },
  { name: "a last element that ends a run", tabs: [endsOnARun(0)] },
  { name: "a stretch of few distinct paragraphs", tabs: fewDistinctParagraphs() },
  { name: "child tabs four deep", tabs: childTabsFourDeep() },
];

/**
 * Tabs whose text is of one kind of character each, a few runs under `FORCED`: what a held
 * run must read back character for character.
 */
const CHARACTERS: NamedTabs[] = [
  ["text of Latin-1 alone", (at: number) => `Café crème ${at}, naïve.`],
  ["a typographic quote in a paragraph of each run", (at: number) => at % 3 === 0 ? `It’s ${at}.` : `Plain ${at}.`],
  ["text of three-byte and of four-byte characters", (at: number) => `文書 ${at} \u{1F600}\u{1F680}`],
  ["a text run that begins with U+FEFF", (at: number) => `\uFEFFAfter a mark ${at}.`],
  ["text cut inside an emoji, a lone surrogate", (at: number) => `Cut ${at} \uD83D`],
].map(([name, text]) => ({
  name: name as string, tabs: [placed(buildTab(texts(11, text as (at: number) => string)), "t.chars")],
}));

/**
 * `tabs` with one paragraph changed: the first character of the first text of two characters
 * or more is another, so every index stands. The tabs as they are where no paragraph holds one.
 */
function oneParagraphChanged(tabs: readonly GoogleDocsTab[]): GoogleDocsTab[] {
  let copy = tabs.map(tab => structuredClone(tab));
  for (let tab of copy) {
    for (let element of tab.body.content) {
      let run = element.paragraph?.elements.find(part => (part.textRun?.content.length ?? 0) > 1)?.textRun;
      if (!run) continue;
      run.content = (run.content.startsWith("#") ? "%" : "#") + run.content.slice(1);
      return copy;
    }
  }
  return copy;
}

describe("a fetched document, stored as it is read", () => {
  // SAME COPY
  it.each([...RECORDED, ...LARGE, ...FUZZED, MARKED, ...EDGES])(
    "stores of a fetched document the rows its tabs stored whole give: $name", ({ tabs }) => {
      for (let { cut, sizes } of CUTS) {
        let read = opened(sizes), whole = opened(sizes);
        let head = read.store.keep(DOC, read.store.fetched(documentOf(tabs, "r1"), 1_000), NONE);
        // The tabs stored whole, each as a tab in hand.
        for (let tab of tabs) whole.store.putTab(DOC, pruneTab(tab), writeMarkersOf(tab));

        expect(tabRows(read.storage), cut).toEqual(tabRows(whole.storage));
        expect(head, cut).toMatchObject({
          revision: "r1", fetchedAt: 1_000,
          outline: tabs.map(tab => tabIdentity(tab)),
          versions: tabs.map(tab => whole.store.versionId(DOC, pruneTab(tab))),
          writeMarkers: tabs.map(writeMarkersOf),
        });
      }
    });

  it("stores the runs and renderings two tabs share once", () => {
    let [first, second] = twoTabsWithOneBody();
    let one = opened(FORCED), both = opened(FORCED);
    one.store.keep(DOC, one.store.fetched(documentOf([first]), 1_000), NONE);
    both.store.keep(DOC, both.store.fetched(documentOf([first, second]), 1_000), NONE);

    // The second tab's runs are the first's rows, and its renderings are found stored inside
    // the transaction that wrote them.
    for (let table of ["doc_run", "doc_md"]) {
      expect(both.storage.rows()[table].length, table).toBe(one.storage.rows()[table].length);
    }
    expect(both.storage.rows().doc_version).toHaveLength(2);
  });

  it("cuts a tab whose last element ends a run as the same tab with a paragraph after it", () => {
    let { storage, store } = opened(FORCED);
    let head = store.keep(DOC, store.fetched(documentOf([endsOnARun(0)]), 1_000), NONE);
    let ends = runsOf(storage, head.versions[0]);
    let longer = opened(FORCED);
    let after = longer.store.keep(DOC, longer.store.fetched(documentOf([endsOnARun(1)]), 1_000), NONE);

    // The last element closed a run by the cut's own rule: the paragraph after it is a run more.
    expect(runsOf(longer.storage, after.versions[0])).toEqual([...ends, expect.any(String)]);
  });

  it("lists child tabs in the document's order, with their parents, levels and markers", () => {
    let { store } = opened();
    let head = store.keep(DOC, store.fetched(documentOf(childTabsFourDeep()), 1_000), NONE);

    expect(head.outline.map(({ tabId, parentTabId, nestingLevel, index }) =>
      [tabId, parentTabId, nestingLevel, index])).toEqual([
      ["t.a", undefined, 0, 0], ["t.a.a", "t.a", 1, 0], ["t.a.a.a", "t.a.a", 2, 0],
      ["t.a.a.a.a", "t.a.a.a", 3, 0], ["t.a.a.b", "t.a.a", 2, 1], ["t.a.b", "t.a", 1, 1],
      ["t.b", undefined, 0, 1],
    ]);
    expect(head.writeMarkers).toEqual([
      [], [], [], [],
      [{ writeId: "w1", id: "marker-1" }, { writeId: "w1", id: "marker-2" }],
      [], [],
    ]);
  });

  describe("a refetch", () => {
    /** Sizes that end a run every two elements, so a change of text moves no boundary. */
    const PAIRS: RunSizes = { least: Infinity, target: Infinity, most: Infinity, elements: 2 };
    const lines = (count: number) => Array.from({ length: count }, (_, at) => `Line ${at}.`);
    /** A tab of 2,401 paragraphs: 1,201 runs under `PAIRS`, more than two pages of a list. */
    const LINES = lines(2_401);
    const base = () => scenarioTab("t1", LINES);
    /** The paragraphs of run `at` under `PAIRS`: the first run holds the opening break and one. */
    const runAt = (at: number) => LINES.slice(2 * at - 1, 2 * at + 1);
    const listed = (items: readonly string[], glyphType: string): GoogleDocsTab => pruneTab({
      ...scenarioTab("t1", lines(1_300), items),
      lists: { numbered: { listProperties: { nestingLevels: [{ glyphType }] } } },
    });
    const tables = (changed?: number) =>
      tinyTablesTab("t1", 650, at => at === changed ? "changed" : `cell ${at}`);

    type Refetch = {
      name: string; sizes: RunSizes; states: () => GoogleDocsTab[];
      /**
       * What the pass costs for each state after the first, `[runsRendered, runsKeyed]`: the
       * runs rendered from hand, which the walk beside the base did not know, and the runs
       * re-keyed from their stored summaries. Left out where the counts are not pinned.
       */
      costs?: readonly (readonly number[])[];
    };
    const RECORDINGS: Refetch[] = readFixtures().map(({ name, before, steps }) => ({
      name: `the recording ${name}`, sizes: FORCED,
      states: () => [before, ...steps.map(step => step.after)].map(tab => ({ ...tab, tabId: "t1" })),
    }));
    // Each state is fetched beside the base it follows. A run that differs from the base's at
    // its place is rendered from hand, and the run after a rendered or a passed one is keyed
    // again from its stored summary; a run in step with the base costs neither.
    const NAMED: Refetch[] = [
      {
        name: "a paragraph changed in the first run", costs: [[1, 1]],
        states: () => [base(), scenarioTab("t1", LINES.with(0, "Changed."))],
      },
      {
        name: "a paragraph changed in a run of the second page", costs: [[1, 1]],
        states: () => [base(), scenarioTab("t1", LINES.with(1_300, "Changed."))],
      },
      {
        // No run stands after the one that changed.
        name: "a paragraph changed in the last run", costs: [[1, 0]],
        states: () => [base(), scenarioTab("t1", LINES.with(2_400, "Changed."))],
      },
      {
        name: "a run taken out of the middle", costs: [[0, 1]],
        states: () => [base(), scenarioTab("t1", LINES.toSpliced(1_399, 2))],
      },
      {
        name: "a run put in", costs: [[1, 1]],
        states: () => [base(), scenarioTab("t1", LINES.toSpliced(1_399, 0, "Put in.", "And its pair."))],
      },
      {
        // The run stands before the first change, so the walk taken up there does not know it:
        // it is rendered from hand, and its rendering is found stored.
        name: "a run from before the first change put in again after it", costs: [[1, 1]],
        states: () => [base(), scenarioTab("t1", LINES.toSpliced(1_599, 0, ...runAt(5)))],
      },
      {
        // The two runs that hold the list's items read another definition.
        name: "the same tab under another list definition", costs: [[2, 0]],
        states: () => [listed(["One", "Two"], "DECIMAL"), listed(["One", "Two"], "UPPER_ALPHA")],
      },
      {
        name: "a tab that is a prefix of the base", costs: [[0, 0]],
        states: () => [base(), scenarioTab("t1", LINES.slice(0, 1_801))],
      },
      {
        // The 300 runs the base does not list.
        name: "a tab the base is a prefix of", costs: [[300, 0]],
        states: () => [scenarioTab("t1", LINES.slice(0, 1_801)), base()],
      },
      {
        name: "a tab of many small tables with one changed", sizes: RUN_SIZES, costs: [[1, 1]],
        states: () => [tables(), tables(300)],
      },
    ].map(refetch => ({ sizes: PAIRS, ...refetch }));

    it.each([...RECORDINGS, ...NAMED])(
      "stores a refetch as the tab stored whole is stored: $name", ({ sizes, states, costs }) => {
        let read = opened(sizes), whole = opened(sizes);
        let [first, ...later] = states();
        for (let { store } of [read, whole]) {
          store.keep(DOC, store.fetched(documentOf([first], "r0"), 1_000), NONE);
        }
        for (let [at, tab] of later.entries()) {
          // The tab stored whole from hand, with nothing beside it.
          let stored = whole.store.putTab(DOC, pruneTab(tab), []).id;
          let head!: DocCopyHead;
          let cost = moved(() => head = read.store.keep(
            DOC, read.store.fetched(documentOf([tab], `r${at + 1}`), 1_000), NONE));

          expect(head.versions).toEqual([stored]);
          expect(versionRows(read.storage, stored)).toEqual(versionRows(whole.storage, stored));
          // Before the other store sweeps, it holds every row this one does.
          let theirs = tabRows(whole.storage);
          for (let [table, rows] of Object.entries(tabRows(read.storage))) {
            expect(rows.filter(row => !theirs[table].includes(row)), table).toEqual([]);
          }
          if (costs) expect([cost.runsRendered, cost.runsKeyed]).toEqual(costs[at]);
          // The other store keeps the same state, and then holds the same rows.
          whole.store.keep(DOC, whole.store.fetched(documentOf([tab], `r${at + 1}`), 1_000), NONE);
          expect(read.storage.rows()).toEqual(whole.storage.rows());
        }
        expect(later.length).toBeGreaterThan(0);
      });
  });
});

// ---------------------------------------------------------------------------
// A held document
// ---------------------------------------------------------------------------

/** How many bytes a chunk of a held document holds, and the head of a frame in it (`heldDoc`). */
const CHUNK_BYTES = 1 << 20;
const HEAD_BYTES = 12;

const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

/** A run a test builds by hand: one paragraph of `text`, with the size it is given. */
function runOf(text: string, size = text.length): CutRun {
  let elements = [{
    paragraph: {
      elements: [{ textRun: { content: text, textStyle: {} } }],
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
    },
  }] as unknown as StructuralElement[];
  return { json: JSON.stringify(elements), elements, size, footnotes: 0, holds: "paragraph" };
}

/** A fetched document of one tab whose runs are `runs`, with no list and nothing of a walk. */
function fetchedOf(runs: readonly CutRun[], first = 0): FetchedDoc {
  return {
    revision: "r1", fetchedAt: 1_000,
    tabs: [{
      identity: { tabId: "t1", title: "Tab", index: 0, nestingLevel: 0 }, writeMarkers: [],
      context: { lists: {} }, first, runs, unindexed: () => false,
    }],
  };
}

/** What a test compares of a run: everything but the array that holds its elements. */
const plainRun = ({ json, elements, size, footnotes, holds }: CutRun) =>
  ({ json, elements: [...elements], size, footnotes, holds });

/** The runs of `tab` as the cut gives them, each with the elements its stored JSON decodes to. */
function cutAndDecoded(tab: GoogleDocsTab, sizes: RunSizes): ReturnType<typeof plainRun>[] {
  let { content } = pruneTab(tab).body;
  let start = content[0]?.startIndex;
  let at = { first: Number.isInteger(start) ? start : 0, footnotes: 0, exact: false };
  return [...cutRuns(content, sizes)].map(run => {
    let decoded = decodeRun(run.json, at)!;
    at = { ...at, first: at.first + run.size, footnotes: at.footnotes + decoded.footnotes };
    return plainRun({ ...run, elements: decoded.elements });
  });
}

describe("a fetched document, held", () => {
  it.each([...RECORDED, ...EDGES, ...CHARACTERS])(
    "stores a held document as the document stored as it is read: $name", ({ tabs }) => {
      for (let { cut, sizes } of CUTS) {
        let read = opened(sizes), held = opened(sizes), tried = opened(sizes);
        // A first document, and then a refetch with one paragraph changed.
        for (let [at, state] of [tabs, oneParagraphChanged(tabs)].entries()) {
          let document = heldDoc(DOC, held.store.fetched(documentOf(state, `r${at}`), 1_000));
          let head = read.store.keep(DOC, read.store.fetched(documentOf(state, `r${at}`), 1_000), NONE);

          expect(held.store.keep(DOC, document, NONE).id, cut).toBe(document.id);
          expect(document.id).toBe(head.id);
          expect(held.storage.rows(), cut).toEqual(read.storage.rows());
          // A trial of it leaves nothing that a keep of it then lacks or holds over.
          tried.store.trial(DOC, document, () => NONE, () => undefined);
          tried.store.keep(DOC, document, NONE);
          expect(tried.storage.rows(), cut).toEqual(read.storage.rows());
          for (let tab of head.versions.keys()) {
            expect(held.store.markdown(scenarioBase(held.store, DOC, head, tab)))
              .toBe(read.store.markdown(scenarioBase(read.store, DOC, head, tab)));
          }
        }
      }
    });

  it("splits a frame between chunks on a character and reads it back", () => {
    // Runs whose JSON is more than three chunks, of characters of three and of four bytes;
    // and one paragraph larger than two chunks, a run across three.
    let many = proseTab("t.many", 5_000, at => `${"文書\u{1F600}".repeat(60)} ${at}`);
    let one = proseTab("t.one", 1, () => "文".repeat(750_000));
    for (let tab of [many, one]) {
      let held = heldDoc(DOC, fetchedDoc(documentOf([tab]), 1_000));
      let cut = cutAndDecoded(tab, RUN_SIZES);

      expect(held.chunks.length).toBeGreaterThan(tab === many ? 3 : 2);
      expect(cut.reduce((bytes, run) => bytes + utf8(run.json), 0)).toBeGreaterThan(2 * CHUNK_BYTES);
      // Read twice, the same: each read decodes the runs anew.
      for (let read = 0; read < 2; read++) {
        let runs: ReturnType<typeof plainRun>[] = [];
        for (let run of held.tabs[0].runs) runs.push(plainRun(run));
        expect(runs.length).toBe(cut.length);
        for (let [at, run] of runs.entries()) expect(run, `run ${at}`).toEqual(cut[at]);
      }
    }
  });

  it("begins the next chunk for a head that fewer than its bytes are left for", () => {
    // The first run leaves five bytes of its chunk: the second run's head begins the next.
    let padded = (bytes: number) => runOf("x".repeat(bytes - utf8(runOf("").json)));
    let first = padded(CHUNK_BYTES - HEAD_BYTES - 5);
    let second = runOf("the run after\n");
    let held = heldDoc(DOC, fetchedOf([first, second]));

    expect(utf8(first.json)).toBe(CHUNK_BYTES - HEAD_BYTES - 5);
    expect(held.chunks.map(chunk => chunk.byteLength)).toEqual([
      HEAD_BYTES + utf8(first.json),
      // The second run's frame, and the frame of the tab's context.
      HEAD_BYTES + utf8(second.json) + HEAD_BYTES + utf8(JSON.stringify({ lists: {} })),
    ]);
    let head = new DataView(held.chunks[1].buffer, held.chunks[1].byteOffset, HEAD_BYTES);
    expect([head.getUint32(0), head.getFloat64(4)]).toEqual([utf8(second.json), second.size]);
    expect([...held.tabs[0].runs].map(run => run.json)).toEqual([first.json, second.json]);
    expect(held.tabs[0].context).toEqual({ lists: {} });
  });

  it("reads back a U+FEFF that begins the part of a text in the next chunk", () => {
    // How many characters of a run's JSON stand before its text.
    let prefix = runOf("").json.indexOf('""') + 1;
    // The mark is three bytes: with none, one or two left in the chunk it begins the next,
    // where a reader that took a leading U+FEFF for a byte order mark would drop it.
    for (let short of [0, 1, 2]) {
      let padding = "x".repeat(CHUNK_BYTES - HEAD_BYTES - prefix - short);
      let run = runOf(`${padding}\uFEFFafter the mark\n`);
      let held = heldDoc(DOC, fetchedOf([run]));

      expect(held.chunks.map(chunk => chunk.byteLength), `${short} short`).toEqual([
        CHUNK_BYTES - short,
        // The rest of the run, and the frame of the tab's context.
        utf8(run.json) - (CHUNK_BYTES - HEAD_BYTES - short)
          + HEAD_BYTES + utf8(JSON.stringify({ lists: {} })),
      ]);
      expect([...held.tabs[0].runs].map(read => read.json === run.json), `${short} short`)
        .toEqual([true]);
    }
  });

  it("holds a run of any size the cut answers, as a store keeps it", () => {
    // What the cut answers for indexes that are malformed: a size below 0, one past 32 bits.
    let sizes = [-3, 2 ** 32 + 5, 0];
    let document = fetchedOf(sizes.map((size, at) => runOf(`run ${at}\n`, size)), 7);
    let held = heldDoc(DOC, document);
    let { storage, store } = opened();

    expect([...held.tabs[0].runs].map(run => run.size)).toEqual(sizes);
    expect(held.tabs[0].bodyEndIndex).toBe(7 + 2 ** 32 + 2);
    // A bound Doc's store refuses none of them either, and lists each as it was.
    let head = store.keep(DOC, document, NONE);
    expect(head.id).toBe(held.id);
    expect(storage.sql.exec<{ size: number }>("SELECT size FROM doc_seq ORDER BY seq").toArray()
      .map(row => row.size)).toEqual(sizes);
  });

  it("holding a document reads no storage, renders nothing and keeps no run's name", () => {
    let { storage, store } = opened(FORCED);
    let statements = storage.statements();
    let held!: HeldDoc;
    let cost = moved(() => held = heldDoc(DOC, store.fetched(documentOf(MARKED.tabs, "r1"), 1_000)));

    expect(cost).toEqual({ runsDecoded: 0, runsRendered: 0, runsKeyed: 0, rowsWritten: 0 });
    expect(storage.statements()).toEqual(statements);
    // Of what the held document owns, closures apart: no array longer than its tabs but the
    // chunks, and no name of 64 characters but the copy's.
    let arrays: unknown[][] = [], names: string[] = [];
    let walk = (value: unknown): void => {
      if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) names.push(value);
      if (typeof value !== "object" || value === null || ArrayBuffer.isView(value)) return;
      if (Array.isArray(value) && value !== held.chunks) arrays.push(value);
      for (let { value: own } of Object.values(Object.getOwnPropertyDescriptors(value))) walk(own);
    };
    walk(held);
    let runs = held.tabs.reduce((count, tab) => count + [...tab.runs].length, 0);
    expect(runs).toBeGreaterThan(10 * held.tabs.length);
    expect(Math.max(...arrays.map(array => array.length))).toBeLessThanOrEqual(held.tabs.length);
    expect(names).toEqual([held.id]);
  });

  it("a held tab makes its context anew at each read, and each pass reads it once a tab", () => {
    let { store } = opened(FORCED);
    let held = heldDoc(DOC, store.fetched(documentOf(MARKED.tabs, "r1"), 1_000));
    // The object a read answers is the reader's: the tab keeps none, so nothing parsed waits
    // beside the pack.
    for (let tab of held.tabs) {
      expect(tab.context).toEqual(tab.context);
      expect(tab.context).not.toBe(tab.context);
    }

    let reads = 0;
    /** The held document, each read of a tab's context counted. */
    let counted = (): FetchedDoc => ({
      revision: "r1", fetchedAt: held.fetchedAt,
      tabs: held.tabs.map(tab => ({
        identity: tab.identity, writeMarkers: tab.writeMarkers, first: tab.first, runs: tab.runs,
        unindexed: () => tab.unindexed(),
        get context() {
          reads++;
          return tab.context;
        },
      })),
    });
    // Holding it, trying it and keeping it: each parses a tab's context once.
    let passes = [
      () => heldDoc(DOC, counted()).id,
      () => store.trial(DOC, counted(), () => NONE, head => head.id),
      () => store.keep(DOC, counted(), NONE).id,
    ];
    for (let [at, pass] of passes.entries()) {
      expect(pass(), `pass ${at}`).toBe(held.id);
      expect(reads, `pass ${at}`).toBe((at + 1) * held.tabs.length);
    }
  });

  it("decodes and renders a held document at each write", () => {
    /** Sizes that end a run every two elements. */
    let pairs: RunSizes = { least: Infinity, target: Infinity, most: Infinity, elements: 2 };
    let lines = Array.from({ length: 601 }, (_, at) => `Line ${at}.`);
    let { store } = opened(pairs);
    let hold = (tab: GoogleDocsTab, revision: string) =>
      heldDoc(DOC, store.fetched(documentOf([tab], revision), 1_000));
    let n = 301;
    let write = (decoded: number, rendered: number, keyed: number) =>
      expect.objectContaining({ runsDecoded: decoded, runsRendered: rendered, runsKeyed: keyed });

    // A first document: the trial renders every run, and so does the keep after it.
    let first = hold(scenarioTab("t1", lines), "r1");
    expect(moved(() => store.trial(DOC, first, () => NONE, () => undefined))).toEqual(write(n, n, 0));
    expect(moved(() => store.keep(DOC, first, NONE))).toEqual(write(n, n, 0));
    // One paragraph changed: each write renders the run that holds it and keys the run after.
    let changed = hold(scenarioTab("t1", lines.with(300, "Changed.")), "r2");
    expect(moved(() => store.trial(DOC, changed, () => NONE, () => undefined))).toEqual(write(n, 1, 1));
    expect(moved(() => store.keep(DOC, changed, NONE))).toEqual(write(n, 1, 1));
    // Unchanged: each write decodes every run, and renders and keys none.
    let same = hold(scenarioTab("t1", lines.with(300, "Changed.")), "r3");
    expect(moved(() => store.trial(DOC, same, () => NONE, () => undefined))).toEqual(write(n, 0, 0));
    expect(moved(() => store.keep(DOC, same, NONE))).toEqual(write(n, 0, 0));
  });

  it.each([...RECORDED, ...LARGE, MARKED])(
    "an in-hand copy renders a tab from the held runs: $name", ({ tabs }) => {
      let copies = inHandDocCopies();
      let copy = copies.keep(copies.hold(documentOf(tabs, "r1"), 1_000))!;

      for (let tab of tabs) {
        let pruned = pruneTab(tab);
        let version = copy.tab(tab.tabId)!;
        let { markdown } = docTabToMarkdown(pruned);
        // Twice: the copy can be read again, and keeps no rendering. Each read counts the
        // Markdown it joined as in hand.
        for (let read = 0; read < 2; read++) {
          docStoreCost.peakMarkdownCharsInHand = 0;
          expect(copy.markdown(version)).toBe(markdown);
          expect(docStoreCost.peakMarkdownCharsInHand).toBe(markdown.length);
        }
        expect(version.bodyEndIndex).toBe(pruned.body.content.at(-1)!.endIndex);
      }
    });

  describe("refuses what is past a row before it is rendered or held", () => {
    const past = "x".repeat(DOC_ROW_BYTES + 1);
    /** Six paragraphs, the sixth past a row and one the renderer throws on, and one after it. */
    const paragraphPastARow = (): GoogleDocsTab => {
      let tab = buildTab([...texts(5), item(past, "N1"), para("After.")], NUMBERED_LIST);
      // A list item at a level below 0: the renderer throws on it.
      tab.body.content[6].paragraph!.bullet!.nestingLevel = -1;
      return placed(tab, "t.paragraph");
    };
    const listsPastARow = (blocks = texts(8)): GoogleDocsTab => placed(
      buildTab(blocks, { L1: { listProperties: { nestingLevels: [{ glyphSymbol: past }] } } }), "t.lists", 1);
    const thrown = (run: () => unknown): unknown => {
      try {
        run();
      } catch (error) {
        return error;
      }
      return undefined;
    };

    it("refuses an element past a row before it is rendered or held", () => {
      // Under three elements a run the paragraph is in the third run.
      let { storage, store } = opened({ least: Infinity, target: Infinity, most: Infinity, elements: 3 });
      let error: unknown;
      let cost = moved(() => error = thrown(() =>
        store.keep(DOC, store.fetched(documentOf([paragraphPastARow()]), 1_000), NONE)));

      expect(error).toBeInstanceOf(DocRowTooLargeError);
      expect((error as Error).message).toMatch(/^A paragraph of tab "t.paragraph" of this Google Doc is too large/);
      // The two runs before it were rendered, and it was not: the row's error is the one thrown.
      expect(cost.runsRendered).toBe(2);
      expect(storage.rows().doc_run).toEqual([]);
      // No read waits with it, with a store or without one.
      for (let hold of [
        () => heldDoc(DOC, store.fetched(documentOf([paragraphPastARow()]), 1_000)),
        () => inHandDocCopies().hold(documentOf([paragraphPastARow()]), 1_000),
      ]) {
        let refusal = thrown(hold);
        expect(refusal).toBeInstanceOf(DocRowTooLargeError);
        // The same refusal, of a run cut to whatever sizes its reader cuts to.
        expect((refusal as Error).message.split(":")[0]).toBe((error as Error).message.split(":")[0]);
      }
    });

    it("refuses a tab whose lists are past a row before any run of it", () => {
      let first = placed(buildTab(texts(8)), "t.first");
      let inserts: string[] = [];
      let storage = fakeDocStorage();
      let store = new DocStore({
        ...storage,
        sql: { exec: (query: string, ...bindings: unknown[]) => {
          if (query.startsWith("INSERT INTO doc_run")) inserts.push(String(bindings[1]).slice(0, 1));
          return storage.sql.exec(query, ...bindings);
        } },
      } as FakeDocStorage, undefined, undefined, FORCED);
      let alone = opened(FORCED);
      let firstRuns = moved(() => alone.store.keep(
        DOC, alone.store.fetched(documentOf([first]), 1_000), NONE)).runsRendered;

      let error: unknown;
      let cost = moved(() => error = thrown(() =>
        store.keep(DOC, store.fetched(documentOf([first, listsPastARow()]), 1_000), NONE)));
      expect(error).toBeInstanceOf(DocRowTooLargeError);
      expect((error as Error).message).toMatch(/^The lists of tab "t.lists" of this Google Doc is too large/);
      // The first tab's runs and its context were written, and no run of the second; the
      // first tab's rows went with the transaction.
      expect(cost.runsRendered).toBe(firstRuns);
      expect(inserts.filter(opening => opening === "[")).toHaveLength(firstRuns);
      expect(inserts.filter(opening => opening === "{")).toHaveLength(1);
      expect(storage.rows().doc_run).toEqual([]);

      // Holding it: the tab's runs are not read, so what was in hand is the first tab's.
      docStoreCost.ingestPeakBufferedBytes = 0;
      heldDoc(DOC, store.fetched(documentOf([first]), 1_000));
      let peak = docStoreCost.ingestPeakBufferedBytes;
      docStoreCost.ingestPeakBufferedBytes = 0;
      let refusal = thrown(() => heldDoc(DOC, store.fetched(documentOf([first, listsPastARow()]), 1_000)));
      expect((refusal as Error).message).toBe((error as Error).message);
      expect(docStoreCost.ingestPeakBufferedBytes).toBe(peak);

      // A tab with both is refused for its lists: they are checked first.
      let both = listsPastARow([...texts(2), para(past)]);
      for (let run of [
        () => store.keep(DOC, store.fetched(documentOf([both]), 1_000), NONE),
        () => heldDoc(DOC, store.fetched(documentOf([both]), 1_000)),
      ]) {
        expect((thrown(run) as Error).message).toBe((error as Error).message);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// What a fetch holds
// ---------------------------------------------------------------------------

/** A statement that reads a page of a version's list for the keying of a fetched tab. */
const readsListPage = (query: string) => /FROM doc_seq LEFT JOIN doc_md[^]*LIMIT/.test(query);
/** A statement that writes the content of a run (a context's JSON is an object). */
const writesRun = (query: string, bindings: readonly unknown[]) =>
  query.startsWith("INSERT INTO doc_run") && String(bindings[1]).startsWith("[");

/** The ends of the next job: a weak reference keeps its target until the job that made it ends. */
const nextJob = () => new Promise(resolve => setImmediate(resolve));

describe("what a fetch holds", () => {
  // WHAT THIS HOLDS: that no pass gathers runs before it writes them. The tally is of the run
  // JSON the cut has handed a pass and the pass has neither written nor let go. It does not
  // hold that what was written is let go, and it does not count the run the cut is building:
  // a pass that wrote each run and kept it would pass here. The three tests after this one
  // hold that (the slots of the answer, the weak references, the heap).
  it("has one run of a fetch in hand at a time, and all of a held document as bytes", () => {
    let lines = (count: number, tab = 0) =>
      Array.from({ length: count }, (_, at) => `Line ${tab}.${String(at).padStart(5, "0")}, of a document.`);
    let documents = [
      [scenarioTab("t1", lines(20_000))],
      Array.from({ length: 200 }, (_, tab) => scenarioTab(`t${tab}`, lines(100, tab))),
      [tinyTablesTab("t1", 2_000)],
    ];
    let peak = (run: () => unknown): number => {
      docStoreCost.ingestPeakBufferedBytes = 0;
      docStoreCost.peakRunBytesInHand = 0;
      run();
      return docStoreCost.ingestPeakBufferedBytes;
    };
    for (let tabs of documents) {
      let runs = tabs.flatMap(tab => [...cutRuns(tab.body.content, RUN_SIZES)].map(run => run.json));
      let longest = Math.max(...runs.map(json => json.length));
      let element = Math.max(...tabs.flatMap(tab =>
        tab.body.content.map(part => JSON.stringify(part).length)));
      let { store } = opened();

      // Stored as it is read, and stored from a held document: one run, as a string. Each
      // pass, the hold too, counts its longest run in hand, two bytes a character.
      let read = peak(() => store.keep(DOC, store.fetched(documentOf(tabs, "r1"), 1_000), NONE));
      expect(docStoreCost.peakRunBytesInHand).toBe(2 * longest);
      let held!: HeldDoc;
      let holding = peak(() => held = heldDoc(DOC, store.fetched(documentOf(tabs, "r2"), 1_000)));
      expect(docStoreCost.peakRunBytesInHand).toBe(2 * longest);
      let readBack = peak(() => store.keep(DOC, held, NONE));
      expect(docStoreCost.peakRunBytesInHand).toBe(2 * longest);
      for (let one of [read, readBack]) {
        expect(one).toBe(2 * longest);
        expect(one).toBeLessThanOrEqual(2 * (RUN_SIZES.most + element));
        if (tabs.length === 1 && runs.length > 500) continue;
        expect(one).toBeGreaterThanOrEqual(2 * RUN_SIZES.least);
      }
      // Held: every run as its bytes behind a head, and the one being packed as a string too.
      let bytes = runs.reduce((sum, json) => sum + utf8(json) + HEAD_BYTES, 0);
      expect(holding).toBeGreaterThanOrEqual(bytes);
      expect(holding).toBeLessThanOrEqual(bytes + 2 * longest);
    }

    // A pass's tally is its own: one that throws at its last tab leaves nothing in the next's.
    let { store } = opened();
    let [first, last] = [scenarioTab("t1", lines(2_000)), scenarioTab("t2", lines(2_000, 1))];
    delete (last.body.content[1_999].paragraph as { paragraphStyle?: unknown }).paragraphStyle;
    expect(() => store.keep(DOC, store.fetched(documentOf([first, last]), 1_000), NONE)).toThrow(TypeError);
    let longest = Math.max(...[...cutRuns(first.body.content, RUN_SIZES)].map(run => run.json.length));
    expect(peak(() => store.keep(DOC, store.fetched(documentOf([first]), 1_000), NONE))).toBe(2 * longest);
  });

  it("has emptied every element of the runs it has written", () => {
    let blocks: BlockSpec[] = texts(2_000, at => `Paragraph ${at} ${"of a document that is read. ".repeat(6)}`);
    blocks.splice(1_500, 0, grid(["c", "d"], ["e", "f"]));
    blocks.splice(700, 0, grid(["a", "b"], ["c", "d"]));
    let tab = buildTab(blocks);
    // How many elements the runs up to each one hold.
    let ends: number[] = [];
    for (let run of cutRuns(pruneTab(tab).body.content, RUN_SIZES)) {
      ends.push((ends.at(-1) ?? 0) + run.elements.length);
    }
    let document = documentOf([tab]);
    let { content } = document.tabs[0].body;
    let answered = [...content];
    let written = 0;
    let faults: string[] = [];
    let storage = fakeDocStorage();
    let store = new DocStore(observing(storage, (query, bindings) => {
      if (!writesRun(query, bindings)) return;
      let emptied = content.findIndex(slot => slot !== undefined);
      if (emptied === -1) emptied = content.length;
      let run = ends[written++];
      // The elements of the runs written so far, and at most the one the cut read past them.
      if (emptied < run || emptied > run + 1) faults.push(`run ${written}: ${emptied} slots emptied`);
      if (content.some((slot, at) => slot !== (at < emptied ? undefined : answered[at]))) {
        faults.push(`run ${written}: a slot holds neither nothing nor the answer's element`);
      }
    }));

    store.keep(DOC, store.fetched(document, 1_000), NONE);

    expect(ends.length).toBeGreaterThan(8);
    expect(written).toBe(ends.length);
    expect(faults).toEqual([]);
    expect(content.every(slot => slot === undefined)).toBe(true);
    expect(document.tabs).toEqual([undefined]);
  });

  it("lets the answer's elements be collected as their runs are written", HEAP_MEASURED, async () => {
    // The slots say that the answer let go; this says that nothing else holds on, in the walk,
    // the cut or the store.
    //
    // It is not flaky, for three reasons. `collect()` is a full collection run synchronously.
    // A `WeakRef` keeps its target to the end of the job that made it, and a job ends with its
    // macrotask: the refs are made in a function that has returned, and the keep starts after
    // a `setImmediate`, with no `await` from there on. And a `deref()` that answers keeps its
    // target to the end of the job, so each ref is dereferenced once, a run after its element
    // was let go, and a ref whose target may still be held is never dereferenced.
    let answer = () => documentOf(distinctTabs(
      [linesTab(1_000, [300]), linesTab(1_000, [1, 500]), linesTab(1_000, [998])]));
    let document = answer();
    let contents = document.tabs.map(tab => tab.body.content);
    let refs = weakRefs(document);
    let second = answer();
    let secondRefs = weakRefs(second);
    await nextJob();

    let alive = 0, checked = 0, writes = 0;
    // How many of each tab's slots were empty at the write before, and how many refs are spent.
    let released = contents.map(() => 0);
    let spent = contents.map(() => 0);
    let storage = fakeDocStorage();
    let store = new DocStore(observing(storage, (query, bindings) => {
      if (!writesRun(query, bindings)) return;
      writes++;
      collect();
      for (let [tab, content] of contents.entries()) {
        for (; spent[tab] < released[tab]; spent[tab]++, checked++) {
          if (refs.elements[tab][spent[tab]].deref() !== undefined) alive++;
        }
        while (released[tab] < content.length && content[released[tab]] === undefined) released[tab]++;
      }
    }));
    store.keep(DOC, store.fetched(document, 1_000), NONE);
    collect();
    let left = [...refs.elements.flatMap((elements, tab) => elements.slice(spent[tab])), ...refs.tabs.flat()]
      .filter(ref => ref.deref() !== undefined).length;

    // A held document pins no element of the answer, and none of the pruned ones.
    let held = heldDoc(DOC, fetchedDoc(second, 1_000));
    collect();
    let heldOnto = [...secondRefs.elements.flat(), ...secondRefs.tabs.flat()]
      .filter(ref => ref.deref() !== undefined).length;

    expect(writes).toBeGreaterThanOrEqual(12);
    expect(checked).toBeGreaterThan(2_500);
    expect(alive).toBe(0);
    expect(left).toBe(0);
    expect(heldOnto).toBe(0);
    expect(held.tabs).toHaveLength(3);
  });

  // THE HEAP, for what a weak reference cannot show: a run's JSON, its pruned elements and its
  // Markdown are made inside the pass, and a reference made there is not cleared within it.
  // The fake keeps its rows outside the heap, so as runs are written the heap holds what is
  // left of the answer, and one run. With A the answer's characters:
  // - the heap by the last write is at least 1.1 A below the heap before the keep: the answer
  //   is let go (a pass that kept its elements ends above where it began);
  // - by the half, at least 0.5 A below: it is let go as the runs are written, not at the end;
  // - no quarter is more than 512 KiB above the one before: nothing a run makes (its JSON, its
  //   Markdown) is gathered, which would rise by a quarter of the answer each time.
  it("lets go of each run it has written", HEAP_MEASURED, () => {
    // This frame holds the document, the store and numbers: a temporary that named the
    // answer's text or its runs here would not be collected while the frame runs.
    let paragraphs = 20_000;
    let tab = () => proseTab("t1", paragraphs);
    let document = ((): GoogleDocsDocument => JSON.parse(JSON.stringify(documentOf([tab()]))))();
    let characters = (() => JSON.stringify(documentOf([tab()])).length)();
    let runs = (() => [...cutRuns(tab().body.content, RUN_SIZES)].length)();
    let quarters = [1, 2, 3, 4].map(quarter => Math.round(quarter * runs / 4));
    let heaps: number[] = [];
    let written = 0;
    let store = new DocStore(observing(fakeDocStorage(), (query, bindings) => {
      if (!writesRun(query, bindings) || !quarters.includes(++written)) return;
      collect();
      heaps.push(process.memoryUsage().heapUsed);
    }));
    collect();
    let before = process.memoryUsage().heapUsed;

    store.keep(DOC, store.fetched(document, 1_000), NONE);

    expect(characters).toBeGreaterThan(6 * 1024 * 1024);
    expect(heaps).toHaveLength(4);
    expect(before - heaps[3]).toBeGreaterThanOrEqual(1.1 * characters);
    expect(before - heaps[1]).toBeGreaterThanOrEqual(0.5 * characters);
    for (let [quarter, heap] of heaps.entries()) {
      expect(heap - (heaps[quarter - 1] ?? before), `quarter ${quarter + 1}`).toBeLessThanOrEqual(512 * 1024);
    }
  });

  // THE SAME OF A HELD DOCUMENT, whose bytes are in buffers outside the heap and stay there
  // while it is kept: the heap holds what the read of a held tab has made of them, one run
  // decoded and its Markdown. A read that kept the runs it answered would rise by a quarter
  // of the document, several megabytes, at each quarter.
  it("keeps none of the runs it reads back from a held document", HEAP_MEASURED, () => {
    // This frame holds the box, the store and numbers; the answer the document was held from
    // is made, read and let go in a function of its own.
    let paragraphs = 20_000;
    let runs = (() =>
      [...cutRuns(proseTab("t1", paragraphs).body.content, RUN_SIZES)].length)();
    let quarters = [1, 2, 3, 4].map(quarter => Math.round(quarter * runs / 4));
    let box: { held?: HeldDoc } = {};
    (() => {
      box.held = heldDoc(DOC, fetchedDoc(documentOf([proseTab("t1", paragraphs)]), 1_000));
    })();
    let bytes = box.held!.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    let heaps: number[] = [];
    let written = 0;
    let store = new DocStore(observing(fakeDocStorage(), (query, bindings) => {
      if (!writesRun(query, bindings) || !quarters.includes(++written)) return;
      collect();
      heaps.push(process.memoryUsage().heapUsed);
    }));
    collect();
    let before = process.memoryUsage().heapUsed;

    store.keep(DOC, box.held!, NONE);

    expect(bytes).toBeGreaterThan(6 * 1024 * 1024);
    expect(heaps).toHaveLength(4);
    for (let [quarter, heap] of heaps.entries()) {
      expect(heap - before, `quarter ${quarter + 1}`).toBeLessThanOrEqual(1024 * 1024);
    }
  });

  describe("a held document", () => {
    const quoted = (at: number) =>
      `It’s paragraph ${at} ${"of some four hundred characters, ".repeat(12)}`.slice(0, 400);
    // The many-run shape is a tab of many runs, not the most runs an answer can hold.
    const SHAPES: { name: string; tab: () => GoogleDocsTab; nearTheLimit?: true }[] = [
      { name: "prose with a typographic quote in each paragraph", tab: () => proseTab("t1", 5_000, quoted) },
      { name: "prose in ASCII", tab: () => proseTab("t1", 5_000, at => quoted(at).replace("’", "'")) },
      {
        name: "a tab of thousands of tiny tables just under the limit", nearTheLimit: true,
        tab: () => tinyTablesTab("t1", 9_800),
      },
    ];

    it.each(SHAPES)(
      "holds a document as the bytes of its runs and 12 bytes a run: $name", HEAP_MEASURED,
      ({ tab, nearTheLimit }) => {
        // Each number is worked out in a function of its own, and so is each thing weighed:
        // this frame holds numbers and the value being weighed.
        let answer = (() => utf8(JSON.stringify(documentOf([tab()]))))();
        let runs = (() => [...cutRuns(tab().body.content, RUN_SIZES)].length)();
        let json = (() => {
          let bytes = 0;
          for (let run of cutRuns(tab().body.content, RUN_SIZES)) bytes += utf8(run.json);
          return bytes;
        })();
        // A document a fetch accepts; the tables' answer is near the limit, not small.
        expect(answer).toBeLessThanOrEqual(ANSWER_LIMIT_BYTES);
        if (nearTheLimit) expect(answer).toBeGreaterThan(9 * 1024 * 1024);

        // What is weighed stands in a box, and is read in functions of their own: a dead
        // temporary of this frame then names the box, never the document.
        let weighed: { held?: HeldDoc; pruned?: GoogleDocsTab[] } = {};
        (() => {
          weighed.held = heldDoc(DOC, fetchedDoc(documentOf([tab()]), 1_000));
        })();
        let withHeld = inUse();
        let { context, chunks, lastIsWhole } = (() => {
          let held = weighed.held!;
          let last = held.chunks.at(-1)!;
          return {
            context: utf8(JSON.stringify(held.tabs[0].context)),
            chunks: held.chunks.map(chunk => chunk.byteLength),
            lastIsWhole: last.byteOffset === 0 && last.buffer.byteLength === last.byteLength,
          };
        })();
        weighed.held = undefined;
        let weight = withHeld - inUse();

        // BY ITS SHAPE, exactly: the runs' JSON, the context, and a head for each, with nothing
        // over. A chunk but the last was closed with fewer bytes left than a head's, or than
        // a character's four.
        expect(chunks.reduce((sum, bytes) => sum + bytes, 0)).toBe(json + context + HEAD_BYTES * (runs + 1));
        expect(Math.min(...chunks.slice(0, -1))).toBeGreaterThan(CHUNK_BYTES - HEAD_BYTES);
        expect(Math.max(...chunks)).toBeLessThanOrEqual(CHUNK_BYTES);
        expect(lastIsWhole).toBe(true);
        // BY WHAT IT TAKES: 16 bytes a run beyond the JSON. One more value a run (a place, a
        // number in an array, a name) is 32 bytes a run or more, which at the tables' runs is
        // several times what the term and the slack leave.
        expect(weight).toBeLessThanOrEqual(json + context + 16 * runs + 128 * 1024);

        // AGAINST THE PRUNED TABS AS OBJECTS, weighed the same way with no parse tree beside.
        (() => {
          weighed.pruned = documentOf([tab()]).tabs.map(pruneTab);
        })();
        let withPruned = inUse();
        weighed.pruned = undefined;
        expect(withPruned - inUse()).toBeGreaterThan(1.25 * weight);
      });
  });

  describe("the stored base's list", () => {
    /** Sizes that end a run every two elements. */
    const PAIRS: RunSizes = { least: Infinity, target: Infinity, most: Infinity, elements: 2 };
    type Page = { from: number; rows: { run: string; context: string; carry: string; summary: string | null }[] };

    /**
     * A store under `sizes` whose reads of a base's list are recorded: where each page starts
     * and the rows it answers, and every other read of `doc_seq` before the copy's record is
     * written (after it, the keep's sweep reads the lists it removes).
     */
    function listReads(sizes: RunSizes) {
      let storage = fakeDocStorage();
      let reads = { pages: [] as Page[], others: [] as string[], recorded: false };
      let store = new DocStore({
        ...storage,
        sql: { exec: (query: string, ...bindings: unknown[]) => {
          let cursor = storage.sql.exec(query, ...bindings);
          if (query.startsWith("INSERT OR REPLACE INTO doc_copy")) reads.recorded = true;
          if (!readsListPage(query)) {
            if (/^SELECT[^]*\bdoc_seq\b/.test(query) && !reads.recorded) reads.others.push(query);
            return cursor;
          }
          let rows = cursor.toArray() as Page["rows"];
          reads.pages.push({ from: Number(bindings[2]), rows });
          return { toArray: () => rows, one: () => rows[0], rowsWritten: cursor.rowsWritten };
        } },
      } as FakeDocStorage, undefined, undefined, sizes);
      let again = () => {
        reads.pages = [];
        reads.others = [];
        reads.recorded = false;
      };
      return { storage, store, reads, again };
    }
    const keepTab = (store: DocStore, tab: GoogleDocsTab, revision: string) =>
      store.keep(DOC, store.fetched(documentOf([tab], revision), 1_000), NONE);
    const lines = (count: number) => Array.from({ length: count }, (_, at) => `Line ${at}.`);
    const otherwise = (tab: GoogleDocsTab): GoogleDocsTab => pruneTab({
      ...tab, lists: { numbered: { listProperties: { nestingLevels: [{ glyphType: "UPPER_ALPHA" }] } } },
    });

    it.each([
      ["unchanged", 2_399, (tab: GoogleDocsTab) => tab, [[0, 500], [500, 500], [1_000, 200]]],
      ["changed in its last run", 2_399, () => scenarioTab("t1", lines(2_399).with(2_398, "Changed.")), [[0, 500], [500, 500], [1_000, 200]]],
      ["changed in its first run", 2_399, () => scenarioTab("t1", lines(2_399).with(0, "Changed.")), [[0, 500], [500, 500], [1_000, 200]]],
      ["with a list defined otherwise", 2_399, otherwise, [[0, 500], [500, 500], [1_000, 200]]],
      ["of less than a page, changed in its first run", 599, () => scenarioTab("t1", lines(599).with(0, "Changed.")), [[0, 300]]],
      // A list of whole pages: a tab in step asks for no run past its own last, and a walk
      // taken up beside the base learns that the list has ended from a page that answers nothing.
      ["of two whole pages, unchanged", 1_999, (tab: GoogleDocsTab) => tab, [[0, 500], [500, 500]]],
      ["of two whole pages, changed in its last run", 1_999, () => scenarioTab("t1", lines(1_999).with(1_998, "Changed.")), [[0, 500], [500, 500], [1_000, 0]]],
    ] as const)("reads the stored base's list once, a page at a time, for a tab %s", (_, paragraphs, refetched, pages) => {
      let { storage, store, reads, again } = listReads(PAIRS);
      let tab = scenarioTab("t1", lines(paragraphs));
      keepTab(store, tab, "r1");
      let listed = storage.rows().doc_seq.length;
      let summaries = storage.sql.exec<{ run: string; context: string; carry: string; summary: string }>(
        "SELECT run, context, carry, summary FROM doc_md").toArray();
      again();

      keepTab(store, refetched(tab), "r2");

      // Each place once, in order: no statement starts from a place an earlier one answered.
      expect(reads.pages.map(page => [page.from, page.rows.length])).toEqual(pages);
      expect(reads.pages.reduce((rows, page) => rows + page.rows.length, 0)).toBe(listed);
      // And nothing else reads a list while the document is stored.
      expect(reads.others).toEqual([]);
      // No whole summary and no Markdown is read: of a summary, what the renderer made of the run.
      for (let row of reads.pages.flatMap(page => page.rows)) {
        let stored = summaries.find(({ run, context, carry }) =>
          run === row.run && context === row.context && carry === row.carry);
        let whole = JSON.parse(stored!.summary) as { run: unknown };
        expect(JSON.parse(row.summary!)).toEqual(whole.run);
        expect(row.summary!.length).toBeLessThanOrEqual(JSON.stringify(whole.run).length);
      }
    });

    // The keying takes a run as summarised where a read of its version does.
    it.each([
      ["has no length of its Markdown", (summary: Record<string, unknown>) => JSON.stringify({ ...summary, markdownLength: undefined })],
      ["holds a record for its tables", (summary: Record<string, unknown>) => JSON.stringify({ ...summary, tables: {} })],
      ["is not JSON", () => "not JSON"],
    ] as const)("renders from hand from a run whose stored summary %s", (_, damaged) => {
      let { storage, store, reads, again } = listReads(PAIRS);
      let tab = scenarioTab("t1", lines(39));
      let version = keepTab(store, tab, "r1").versions[0];
      let { run, context, carry } = storage.sql.exec<{ run: string; context: string; carry: string }>(
        "SELECT run, context, carry FROM doc_seq WHERE version = ? AND seq = 7", version).one();
      let key = [run, context, carry];
      let { summary } = storage.sql.exec<{ summary: string }>(
        "SELECT summary FROM doc_md WHERE run = ? AND context = ? AND carry = ?", ...key).one();
      storage.sql.exec(
        "UPDATE doc_md SET summary = ?4 WHERE run = ?1 AND context = ?2 AND carry = ?3",
        ...key, damaged(JSON.parse(summary) as Record<string, unknown>)).toArray();
      again();

      let head!: DocCopyHead;
      let cost = moved(() => head = keepTab(store, tab, "r2"));

      expect(storage.rows().doc_seq).toHaveLength(20);
      expect(reads.pages[0].rows.map(row => row.summary === null)).toEqual(
        Array.from({ length: 20 }, (_, at) => at === 7));
      // In step for seven runs; that run and the twelve after it are rendered from hand. The
      // version is found keyed and each rendering stored, so the copy's record alone is written.
      expect(cost).toEqual({ runsDecoded: 0, runsRendered: 13, runsKeyed: 0, rowsWritten: 1 });
      expect(head.versions).toEqual([version]);
      // A read renders that one run again and writes its row over.
      let read = moved(() => expect(store.markdown(scenarioBase(store, DOC, head)))
        .toBe(docTabToMarkdown(tab).markdown));
      expect(read).toMatchObject({ runsDecoded: 1, runsRendered: 1 });
    });

    // ONE PAGE IN HAND, WHATEVER THE SUMMARIES, held by the heap alone: a weak reference made
    // inside the keep is not cleared within it. The runs each name about a dozen lists and no
    // two the same ones, so every summary differs and is long, and a page or a summary that
    // was kept would weigh several times what a pass in step holds: the names and entries of
    // the runs passed, about 550 bytes a run here, where every page kept is about 1,700 bytes
    // a run more, and a summary kept parsed more than its text. The bound is 1,200 bytes a
    // run, over the 2,500 runs between the second page's read and the last's: at both the
    // reader has one spent page in hand, so the pages cancel.
    it("keeps no more of the stored base's list than a page while a tab is in step", HEAP_MEASURED, () => {
      // This frame holds the fetched value, the store and numbers. The value is one that can
      // be read again and lets go of nothing as it is read: a document emptied as it is
      // stored would free heap that hid what the pass keeps.
      let sizes: RunSizes = { least: Infinity, target: Infinity, most: Infinity, elements: 12 };
      let fetched = (() => wholeTabsFetched({
        revision: "r1", fetchedAt: 1_000, tabs: [{ tab: listRunsTab("t1", 3_000), writeMarkers: [] }],
      }, sizes))();
      let { storage, store, reads, again } = listReads(sizes);
      store.keep(DOC, fetched, NONE);
      // Unchanged, once: what a first use of the path in step allocates is not measured.
      again();
      store.keep(DOC, fetched, NONE);
      let texts = reads.pages.flatMap(page => page.rows.map(row => row.summary!));
      let [distinct, characters] = [new Set(texts).size, texts.reduce((sum, text) => sum + text.length, 0)];
      texts = [];
      again();

      // Unchanged again, through a store that records no row, measured before the second page
      // is read and before the last.
      let heaps: number[] = [];
      let statements = 0;
      let measured = new DocStore(observing(storage, query => {
        if (!readsListPage(query)) return;
        statements++;
        if (statements !== 2 && statements !== 7) return;
        for (let pass = 0; pass < 4; pass++) collect();
        heaps.push(process.memoryUsage().heapUsed);
      }), undefined, undefined, sizes);
      let cost = moved(() => measured.keep(DOC, fetched, NONE));

      // The shape has its teeth: every summary differs, and each is long.
      expect(distinct).toBe(3_001);
      expect(characters / distinct).toBeGreaterThanOrEqual(1_000);
      // Seven pages, the last from place 3,000; in step throughout: nothing rendered or keyed,
      // and the copy's record alone written.
      expect(statements).toBe(7);
      expect(cost).toEqual({ runsDecoded: 0, runsRendered: 0, runsKeyed: 0, rowsWritten: 1 });
      expect(heaps[1] - heaps[0]).toBeLessThanOrEqual(1_200 * 2_500);
    });

    // ONE OBJECT FOR THE SUMMARIES OF ONE TEXT, held by the heap alone as the test before. A
    // tab of 1x1 tables changed in its first table is keyed beside the whole of the base's
    // list, whose 8,001 runs have two distinct summaries: every table renders to the same
    // shape and every stretch between two is the same run. What the walk holds of the
    // base when the tab's list is written is then about 500 bytes a run (its carry key, its
    // id's places and keys, and the entry of the list being written); with a summary parsed
    // for each run it is about 300 bytes a run more. The bound is 650 bytes a run.
    it("keeps the summaries of one text of the stored base's list as one object", HEAP_MEASURED, () => {
      // This frame holds the fetched values, the stores and numbers; the values can be read
      // again and let go of nothing as they are read, as in the test before.
      let pairs = 4_000;
      let tables = (revision: string, changed?: number) => wholeTabsFetched({
        revision, fetchedAt: 1_000,
        tabs: [{
          tab: tinyTablesTab("t1", pairs, at => at === changed ? "changed" : `cell ${at}`),
          writeMarkers: [],
        }],
      });
      let storage = fakeDocStorage();
      let store = new DocStore(storage);
      store.keep(DOC, tables("r1"), NONE);
      // Changed, once: what a first use of the walk beside a base allocates is not measured.
      store.keep(DOC, tables("r2", 1), NONE);
      let distinct = new Set(storage.sql.exec<{ summary: string }>(
        "SELECT json_extract(summary, '$.run') AS summary FROM doc_md",
      ).toArray().map(row => row.summary));
      let fetched = tables("r3", 0);

      // Changed in its first table, through a store that measures at the first write of the
      // tab's list: the walk has passed every run and holds what it read of the base.
      let heap: number | undefined;
      let measured = new DocStore(observing(storage, query => {
        if (heap !== undefined || !query.startsWith("INSERT OR REPLACE INTO doc_seq")) return;
        for (let pass = 0; pass < 4; pass++) collect();
        heap = process.memoryUsage().heapUsed;
      }));
      for (let pass = 0; pass < 4; pass++) collect();
      let before = process.memoryUsage().heapUsed;
      let cost = moved(() => measured.keep(DOC, fetched, NONE));

      // The shape has its teeth: thousands of runs listed, of two distinct summaries, and the
      // walk taken up beside the base at the tab's second run, so that all but a few of the
      // runs are keyed from what it read of the base.
      let runs = 2 * pairs + 1;
      expect(storage.rows().doc_seq).toHaveLength(runs);
      expect(distinct.size).toBe(2);
      expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 1 });
      expect(cost.runsKeyed).toBeGreaterThanOrEqual(runs - 4);
      expect(heap! - before).toBeLessThanOrEqual(650 * runs);
    });
  });
});

// ---------------------------------------------------------------------------
// A fetch that is not kept, and a tab fetched unchanged
// ---------------------------------------------------------------------------

describe("a fetch that is not kept", () => {
  it("undoes a fetch that throws part way", () => {
    expect(fetchAtomicScenario(fakeDocStorage())).toEqual(FETCH_ATOMIC_SCENARIO);
  });

  it("leaves no row of a Drive read that is not approved, and decodes and renders it at each write", () => {
    expect(driveReadScenario(fakeDocStorage())).toEqual(DRIVE_READ_SCENARIO);
  });

  it("a late fetch replaces nothing", async () => {
    expect(await lateFetchScenario(fakeDocStorage())).toEqual(LATE_FETCH_SCENARIO);
  });
});

describe("a tab fetched unchanged", () => {
  /** A tab of 302 runs under sizes that end a run every two elements. */
  const PAIRS: RunSizes = { least: Infinity, target: Infinity, most: Infinity, elements: 2 };
  const tab = (tabId = "t1") =>
    scenarioTab(tabId, Array.from({ length: 601 }, (_, at) => `Line ${at}.`), ["One", "Two"]);
  const keepTab = (store: DocStore, revision: string, doc = DOC) =>
    store.keep(doc, store.fetched(documentOf([tab()], revision), 1_000), NONE);

  it("renders, keys and writes nothing of a tab fetched unchanged", () => {
    let { store } = opened(PAIRS);
    keepTab(store, "r1");

    // The copy's record is the one row written: it names the revision.
    expect(moved(() => keepTab(store, "r2")))
      .toEqual({ runsDecoded: 0, runsRendered: 0, runsKeyed: 0, rowsWritten: 1 });
  });

  it("renders from hand a run whose stored rendering is gone, and keeps the base's keys before it", () => {
    let { storage, store } = opened(PAIRS);
    let version = keepTab(store, "r1").versions[0];
    let runs = storage.rows().doc_seq.length;
    let gone = Math.floor(runs / 2);
    storage.sql.exec(
      `DELETE FROM doc_md WHERE (run, context, carry) IN
        (SELECT run, context, carry FROM doc_seq WHERE version = ? AND seq = ?)`, version, gone).toArray();

    let cost = moved(() => keepTab(store, "r2"));

    // The runs before it keep the base's keys; it and every run after it are rendered from
    // hand, and its row is the one written beside the copy's record.
    expect(cost).toEqual({ runsDecoded: 0, runsRendered: runs - gone, runsKeyed: 0, rowsWritten: 2 });
    let fresh = opened(PAIRS);
    keepTab(fresh.store, "r2");
    expect(storage.rows()).toEqual(fresh.storage.rows());
  });

  it("takes no key of a base version another digest keyed, though its renderings are this digest's", () => {
    let storage = fakeDocStorage();
    let [theirs, ours] = ["a", "b"].map(made => new DocStore(storage, undefined, made, PAIRS));
    let version = keepTab(theirs, "r1").versions[0];
    // This digest stores another version of the document, the same body under another tab's
    // name: it lists the same runs under the same keys, so the renderings this digest stores
    // for it are those the base version names, and the base version is not keyed again.
    ours.putTab(DOC, tab("t2"), []);
    const listed = (seq: number) => storage.sql.exec<{ run: string; context: string; carry: string }>(
      "SELECT run, context, carry FROM doc_seq WHERE version = ? AND seq = ?", version, seq).toArray()[0];
    let runs = runsOf(storage, version).length;
    let key = listed(3);
    // A key of the other digest's that this code does not derive, with a rendering this digest
    // stored under it.
    storage.sql.exec("UPDATE doc_seq SET carry = 'theirs' WHERE version = ? AND seq = 3", version).toArray();
    storage.sql.exec(
      `INSERT INTO doc_md SELECT doc, run, context, 'theirs', made, summary, md FROM doc_md
        WHERE doc = ? AND run = ? AND context = ? AND carry = ? AND made = 'b'`,
      DOC, key.run, key.context, key.carry).toArray();
    expect(listed(3).carry).toBe("theirs");
    // Every rendering the document holds is this digest's, the one under that key included.
    expect(storage.sql.exec(
      "SELECT doc, made, SUM(carry = 'theirs') AS theirs FROM doc_md GROUP BY doc, made",
    ).toArray()).toEqual([{ doc: DOC, made: "b", theirs: 1 }]);

    let cost = moved(() => expect(keepTab(ours, "r2").versions[0]).toBe(version));

    // Every run is rendered from hand and listed under the key this code derives.
    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: runs });
    expect(listed(3)).toEqual(key);
  });
});
