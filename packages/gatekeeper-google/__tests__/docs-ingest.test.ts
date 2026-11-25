// What a fetch of a Google Doc stores and holds: the rows of the tabs stored whole, one run in
// hand, nothing written kept; a Drive read's document is its runs' bytes; a throwing fetch
// leaves storage as it was.

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
import { fakeDocStorage } from "./doc-store-fake";
import type { FakeDocStorage } from "./doc-store-fake";
import {
  DRIVE_READ_SCENARIO, driveReadScenario, FETCH_ATOMIC_SCENARIO, fetchAtomicScenario,
  LATE_FETCH_SCENARIO, lateFetchScenario, proseTab, scenarioBase, scenarioTab, tinyTablesTab,
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

/** The most bytes `GoogleDocsApi.getDocument` reads of an answer (not exported by `src/docs-api.ts`). */
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

// The edges of the walk, each a document built here.

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

/** A tab of five paragraphs whose last element ends a run under either cut. */
const endsOnARun = (): GoogleDocsTab => placed(buildTab(texts(5)), "t.ends");

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
  { name: "a last element that ends a run", tabs: [endsOnARun()] },
  { name: "a stretch of few distinct paragraphs", tabs: fewDistinctParagraphs() },
  { name: "child tabs four deep", tabs: childTabsFourDeep() },
];

/** Tabs of one kind of character each, which a held run must read back character for character. */
const CHARACTERS: NamedTabs[] = [
  ["text of Latin-1 alone", (at: number) => `Café crème ${at}, naïve.`],
  ["a typographic quote in a paragraph of each run", (at: number) => at % 3 === 0 ? `It’s ${at}.` : `Plain ${at}.`],
  ["text of three-byte and of four-byte characters", (at: number) => `文書 ${at} \u{1F600}\u{1F680}`],
  ["a text run that begins with U+FEFF", (at: number) => `\uFEFFAfter a mark ${at}.`],
  ["text cut inside an emoji, a lone surrogate", (at: number) => `Cut ${at} \uD83D`],
].map(([name, text]) => ({
  name: name as string, tabs: [placed(buildTab(texts(11, text as (at: number) => string)), "t.chars")],
}));

/** `tabs` with the first character of the first text of two or more changed, so every index stands. */
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
      /** `[runsRendered, runsKeyed]` for each state after the first, where pinned. */
      costs?: readonly (readonly number[])[];
    };
    const RECORDINGS: Refetch[] = readFixtures().map(({ name, before, steps }) => ({
      name: `the recording ${name}`, sizes: FORCED,
      states: () => [before, ...steps.map(step => step.after)].map(tab => ({ ...tab, tabId: "t1" })),
    }));
    // A run that differs from the base's at its place is rendered from hand, and the run after
    // it keyed again from its stored summary; a run in step with the base costs neither.
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
        // A run the walk taken up at the change does not know: rendered from hand, found stored.
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
    // Runs of three- and four-byte characters over three chunks, and one paragraph across three.
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
    // With 0-2 bytes left the mark begins the next chunk, where a BOM-stripping reader drops it.
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
    let held = heldDoc(DOC, store.fetched(documentOf(MARKED.tabs, "r1"), 1_000));

    // Its decode and render counts are in `DRIVE_READ_SCENARIO`.
    expect(storage.statements()).toEqual(statements);
    // It owns no array longer than its tabs but the chunks, and no 64-hex name but the copy's.
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
    // The tab keeps no parsed context beside the pack: each read answers a new object.
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

  // A first write and a changed trial are counted in `DRIVE_READ_SCENARIO`.
  it("decodes and renders a held document at each write", () => {
    let pairs: RunSizes = { least: Infinity, target: Infinity, most: Infinity, elements: 2 };
    let lines = Array.from({ length: 601 }, (_, at) => `Line ${at}.`);
    let { store } = opened(pairs);
    let hold = (tab: GoogleDocsTab, revision: string) =>
      heldDoc(DOC, store.fetched(documentOf([tab], revision), 1_000));
    let n = 301;
    let write = (decoded: number, rendered: number, keyed: number) =>
      expect.objectContaining({ runsDecoded: decoded, runsRendered: rendered, runsKeyed: keyed });

    store.keep(DOC, hold(scenarioTab("t1", lines), "r1"), NONE);
    // One paragraph changed: the keep renders the run that holds it and keys the run after.
    let changed = hold(scenarioTab("t1", lines.with(300, "Changed.")), "r2");
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
        // Twice: the copy keeps no rendering, and each read counts the Markdown it joined.
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
      // The first tab was written and no run of the second; its rows went with the transaction.
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


/** A statement that reads a page of a version's list for the keying of a fetched tab. */
const readsListPage = (query: string) => /FROM doc_seq LEFT JOIN doc_md[^]*LIMIT/.test(query);
/** A statement that writes the content of a run (a context's JSON is an object). */
const writesRun = (query: string, bindings: readonly unknown[]) =>
  query.startsWith("INSERT INTO doc_run") && String(bindings[1]).startsWith("[");

/** The ends of the next job: a weak reference keeps its target until the job that made it ends. */
const nextJob = () => new Promise(resolve => setImmediate(resolve));

describe("what a fetch holds", () => {
  // No pass gathers runs before it writes them; that what was written is let go is held below.
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
      let { store } = opened();

      // Each pass, the hold too, has its longest run in hand as a string, two bytes a character.
      let read = peak(() => store.keep(DOC, store.fetched(documentOf(tabs, "r1"), 1_000), NONE));
      expect(docStoreCost.peakRunBytesInHand).toBe(2 * longest);
      let held!: HeldDoc;
      let holding = peak(() => held = heldDoc(DOC, store.fetched(documentOf(tabs, "r2"), 1_000)));
      expect(docStoreCost.peakRunBytesInHand).toBe(2 * longest);
      let readBack = peak(() => store.keep(DOC, held, NONE));
      expect(docStoreCost.peakRunBytesInHand).toBe(2 * longest);
      expect([read, readBack]).toEqual([2 * longest, 2 * longest]);
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

  it("lets the answer's elements be collected as their runs are written", HEAP_MEASURED, async () => {
    // Nothing holds an element the answer let go (refs made before `nextJob`, read once after).
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

  // A cold read lets the answer go as runs are written: no reading passes the start by 512 KiB.
  it("lets go of each run it has written", HEAP_MEASURED, () => {
    let paragraphs = 20_000;
    let tab = () => proseTab("t1", paragraphs);
    let document = ((): GoogleDocsDocument => JSON.parse(JSON.stringify(documentOf([tab()]))))();
    let characters = (() => JSON.stringify(documentOf([tab()])).length)();
    let runs = (() => [...cutRuns(tab().body.content, RUN_SIZES)].length)();
    let quarters = [1, 2, 3, 4].map(quarter => Math.round(quarter * runs / 4));
    let heaps: number[] = [];
    let written = 0;
    let store = new DocStore(observing(fakeDocStorage(), (query, bindings) => {
      if (writesRun(query, bindings) && quarters.includes(++written)) heaps.push(inUse());
    }));
    let before = inUse();

    store.keep(DOC, store.fetched(document, 1_000), NONE);

    expect(characters).toBeGreaterThan(6 * 1024 * 1024);
    expect(heaps).toHaveLength(4);
    expect(before - heaps[1]).toBeGreaterThanOrEqual(0.5 * characters);
    expect(before - heaps[3]).toBeGreaterThanOrEqual(1.1 * characters);
    expect(Math.max(...heaps) - before).toBeLessThanOrEqual(512 * 1024);
  });

  describe("a held document", () => {
    const quoted = (at: number) =>
      `It’s paragraph ${at} ${"of some four hundred characters, ".repeat(12)}`.slice(0, 400);
    // The many-run shape is a tab of many runs, not the most runs an answer can hold.
    const SHAPES: { name: string; tab: () => GoogleDocsTab; nearTheLimit?: true }[] = [
      { name: "prose with a typographic quote in each paragraph", tab: () => proseTab("t1", 5_000, quoted) },
      {
        name: "a tab of thousands of tiny tables just under the limit", nearTheLimit: true,
        tab: () => tinyTablesTab("t1", 9_800),
      },
    ];

    it.each(SHAPES)(
      "holds a document as the bytes of its runs and 12 bytes a run: $name", HEAP_MEASURED,
      ({ tab, nearTheLimit }) => {
        // Numbers and what is weighed are made in calls of their own, so no temporary pins them.
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

        // Exactly the runs' JSON, the context and a head for each; a chunk closes only when full.
        expect(chunks.reduce((sum, bytes) => sum + bytes, 0)).toBe(json + context + HEAD_BYTES * (runs + 1));
        expect(Math.min(...chunks.slice(0, -1))).toBeGreaterThan(CHUNK_BYTES - HEAD_BYTES);
        expect(Math.max(...chunks)).toBeLessThanOrEqual(CHUNK_BYTES);
        expect(lastIsWhole).toBe(true);
        // In the heap: 16 bytes a run beyond the JSON; one more value a run would pass it.
        expect(weight).toBeLessThanOrEqual(json + context + 16 * runs + 128 * 1024);

        // Well under the pruned tabs as objects.
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

    /** A store whose reads of a base's list are recorded: each page, and other `doc_seq` reads before the record. */
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
      ["changed in its first run", 2_399, () => scenarioTab("t1", lines(2_399).with(0, "Changed.")), [[0, 500], [500, 500], [1_000, 200]]],
      ["with a list defined otherwise", 2_399, otherwise, [[0, 500], [500, 500], [1_000, 200]]],
      ["of less than a page, changed in its first run", 599, () => scenarioTab("t1", lines(599).with(0, "Changed.")), [[0, 300]]],
      // Whole pages: in step, no run past the last is asked; a walk beside the base ends on an empty page.
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
      // That run and the twelve after it are rendered from hand; only the copy's record is written.
      expect(cost).toEqual({ runsDecoded: 0, runsRendered: 13, runsKeyed: 0, rowsWritten: 1 });
      expect(head.versions).toEqual([version]);
      // A read renders that one run again and writes its row over.
      let read = moved(() => expect(store.markdown(scenarioBase(store, DOC, head)))
        .toBe(docTabToMarkdown(tab).markdown));
      expect(read).toMatchObject({ runsDecoded: 1, runsRendered: 1 });
    });

  });
});

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

// What a tab fetched unchanged writes and renders is pinned in the workerd count table.
describe("a tab fetched unchanged", () => {
  /** A tab of 302 runs under sizes that end a run every two elements. */
  const PAIRS: RunSizes = { least: Infinity, target: Infinity, most: Infinity, elements: 2 };
  const tab = (tabId = "t1") =>
    scenarioTab(tabId, Array.from({ length: 601 }, (_, at) => `Line ${at}.`), ["One", "Two"]);
  const keepTab = (store: DocStore, revision: string, doc = DOC) =>
    store.keep(doc, store.fetched(documentOf([tab()], revision), 1_000), NONE);

  it("renders from hand a run whose stored rendering is gone, and keeps the base's keys before it", () => {
    let { storage, store } = opened(PAIRS);
    let version = keepTab(store, "r1").versions[0];
    let runs = storage.rows().doc_seq.length;
    let gone = Math.floor(runs / 2);
    storage.sql.exec(
      `DELETE FROM doc_md WHERE (run, context, carry) IN
        (SELECT run, context, carry FROM doc_seq WHERE version = ? AND seq = ?)`, version, gone).toArray();

    let cost = moved(() => keepTab(store, "r2"));

    // The runs before it keep the base's keys; it and every run after are rendered from hand.
    expect(cost).toEqual({ runsDecoded: 0, runsRendered: runs - gone, runsKeyed: 0, rowsWritten: 2 });
    let fresh = opened(PAIRS);
    keepTab(fresh.store, "r2");
    expect(storage.rows()).toEqual(fresh.storage.rows());
  });

  it("takes no key of a base version another digest keyed, though its renderings are this digest's", () => {
    let storage = fakeDocStorage();
    let [theirs, ours] = ["a", "b"].map(made => new DocStore(storage, undefined, made, PAIRS));
    let version = keepTab(theirs, "r1").versions[0];
    // The same body under another tab's name gives this digest's renderings the base's keys.
    ours.putTab(DOC, tab("t2"), []);
    const listed = (seq: number) => storage.sql.exec<{ run: string; context: string; carry: string }>(
      "SELECT run, context, carry FROM doc_seq WHERE version = ? AND seq = ?", version, seq).toArray()[0];
    let runs = runsOf(storage, version).length;
    let key = listed(3);
    // A key this code does not derive, with a rendering of this digest's under it.
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
