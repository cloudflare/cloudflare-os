// Scenarios of the Doc store that run the same on the Node fake and on a Durable Object's real
// storage, and answer small values: no document crosses RPC. Nothing here imports the test
// runner, so the worker's Durable Objects can run it.

import { createSimulationStore } from "@gadgets/gatekeeper-kit/simulation-store";
import type { GoogleDocsDocument, GoogleDocsRequest, GoogleDocsTab } from "../src/docs-api";
import {
  DOC_COPY_EXPIRY_PASS_KEY, driveDocCopies, DriveDocCopyLimits, lazyDocStore, MAX_DRIVE_DOC_COPIES,
  StoredDocCopy, type DocCopy, type UnreadDocCopyStorage,
} from "../src/docs-copy";
import {
  applyDocsRequests, hasModelFootnotes, hasModelIndexes, replayCost,
} from "../src/docs-model";
import {
  applyDocRequests, docEditKey, docEditResult, DocModelError, docTabReducer, editedSlice,
  tabEditRequests, type DocEdit, type QueuedDocRecord,
} from "../src/docs-replay";
import { storedTabReading } from "../src/docs-reading";
import {
  pruneTab, tabIdentity, type DocWriteMarkerCopy, type FetchedDoc, type FetchedDocTab,
} from "../src/docs-replica";
import { cutRuns, RUN_SIZES, type RunSizes } from "../src/docs-runs";
import {
  DOC_COPY_APPROVAL_GRAIN_MS, DOC_ROW_BYTES, DocRowTooLargeError, DocStore, docStoreCost, heldDoc,
  type DocCopyHead,
  type DocPending, type DocStoreStorage, type DocVersion, type HeldDoc,
} from "../src/docs-store";
import {
  changedMarkdown, prepareAppend, prepareTableChange, prepareTextReplacement, tableCallChange,
  type TableCall,
} from "../src/docs-table-actions";
import { MAX_TAB_TABLE_CELLS, tableIdentity } from "../src/docs-tables";
import { docTabToMarkdown, MARKDOWN_RENDERING_VERSION } from "../src/markdown-converter";
import { WIDER } from "./wider-run";

const NONE: DocPending = { edits: [], roots: [] };

/**
 * A pruned tab named `tabId`, as Google sends one: its paragraphs each hold one of `lines`,
 * and after them stands an item of its one numbered list for each of `items`.
 */
export function scenarioTab(
  tabId: string, lines: readonly string[], items: readonly string[] = [],
): GoogleDocsTab {
  // Google sends no start index on the section break that opens a body.
  let content = [{ endIndex: 1, sectionBreak: {} }] as GoogleDocsTab["body"]["content"];
  let index = 1;
  for (let [at, line] of [...lines, ...items].entries()) {
    let text = `${line}\n`;
    let endIndex = index + text.length;
    content.push({
      startIndex: index, endIndex,
      paragraph: {
        elements: [{ startIndex: index, endIndex, textRun: { content: text, textStyle: {} } }],
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        ...(at < lines.length ? {} : { bullet: { listId: "numbered" } }),
      },
    });
    index = endIndex;
  }
  return pruneTab({
    tabId, title: `Tab ${tabId}`, index: 0, nestingLevel: 0, body: { content },
    lists: { numbered: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } } },
    namedRanges: {},
  });
}

type Content = GoogleDocsTab["body"]["content"];

// A paragraph style as Google sends one for prose, and for a table's cell: the fields the
// pruning keeps beside the style's name are part of what a tab's JSON weighs.
const PROSE_STYLE = { namedStyleType: "NORMAL_TEXT", direction: "LEFT_TO_RIGHT" };
const CELL_STYLE = {
  namedStyleType: "NORMAL_TEXT", alignment: "START",
  indentFirstLine: { unit: "PT" }, indentStart: { unit: "PT" },
};

// A body paragraph of `text` (its newline included) that starts at `index`.
const proseParagraph = (index: number, text: string): Content[number] => ({
  startIndex: index, endIndex: index + text.length,
  paragraph: {
    elements: [{
      startIndex: index, endIndex: index + text.length, textRun: { content: text, textStyle: {} },
    }],
    paragraphStyle: PROSE_STYLE,
  },
});

// A pruned tab named `tabId` whose body is `content` after the section break that opens it.
const shapedTab = (tabId: string, content: Content): GoogleDocsTab => pruneTab({
  tabId, title: `Tab ${tabId}`, index: 0, nestingLevel: 0,
  body: { content: [{ endIndex: 1, sectionBreak: {} }, ...content] as Content },
  lists: {}, namedRanges: {},
});

/**
 * A pruned tab of `paragraphs` paragraphs of prose: paragraph n holds `text(n)` (by default
 * 249 characters of ASCII that name n) and its newline. A stretch of them is one run.
 */
export function proseTab(
  tabId: string, paragraphs: number,
  text: (at: number) => string =
    at => `Paragraph ${at} ${"lorem ipsum dolor sit amet ".repeat(9)}`.slice(0, 249),
): GoogleDocsTab {
  let content: Content = [];
  let index = 1;
  for (let at = 0; at < paragraphs; at++) {
    let line = `${text(at)}\n`;
    content.push(proseParagraph(index, line));
    index += line.length;
  }
  return shapedTab(tabId, content);
}

/**
 * A pruned tab of a paragraph, a level-0 item of a bulleted list, `items` items of `chars`
 * characters below it at levels 1 to 3, a level-1 item (`target item`) and a last paragraph.
 * That item made a level-0 one has the builders bullet the items before it again, so the
 * version the edit gives lists other runs for them, which read as before.
 */
export function nestedItemsTab(tabId: string, items: number, chars: number): GoogleDocsTab {
  let content: Content = [];
  let index = 1;
  let add = (text: string, nestingLevel?: number) => {
    let paragraph = proseParagraph(index, `${text}\n`);
    if (nestingLevel !== undefined) {
      paragraph.paragraph!.bullet = { listId: "B1", ...(nestingLevel ? { nestingLevel } : {}) };
    }
    content.push(paragraph);
    index = paragraph.endIndex;
  };
  add("Intro");
  add("top", 0);
  for (let at = 0; at < items; at++) {
    add(`nested ${at} ${"lorem ipsum ".repeat(Math.ceil(chars / 12))}`.slice(0, chars), 1 + at % 3);
  }
  add("target item", 1);
  add("End");
  let tab = shapedTab(tabId, content);
  // The nine levels Google gives a list that the bulleted preset makes.
  tab.lists = {
    B1: {
      listProperties: {
        nestingLevels: Array.from({ length: 9 }, (_, level) =>
          ({ glyphSymbol: ["\u25cf", "\u25cb", "\u25a0"][level % 3], startNumber: 1 })),
      },
    },
  };
  return tab;
}

/**
 * A pruned tab of `pairs` pairs of a 1x1 table and a paragraph, after one empty paragraph:
 * table n's cell holds `cell(n)` (by default `cell n`) and the paragraph after it `between(n)`
 * (by default nothing: an empty paragraph). A table is a run of its own and so is every
 * stretch between two, so the tab is `2 * pairs + 1` runs, and every stretch of an empty
 * paragraph but the first is the same run.
 */
export function tinyTablesTab(
  tabId: string, pairs: number, cell: (at: number) => string = at => `cell ${at}`,
  between: (at: number) => string = () => "",
): GoogleDocsTab {
  let content: Content = [proseParagraph(1, "\n")];
  let index = 2;
  for (let at = 0; at < pairs; at++) {
    let table = tinyTable(index, `${cell(at)}\n`);
    content.push(table);
    index = table.endIndex;
    let line = `${between(at)}\n`;
    content.push(proseParagraph(index, line));
    index += line.length;
  }
  return shapedTab(tabId, content);
}

// A 1x1 table that starts at `index`, its cell one paragraph of `text` (its newline included),
// as Google sends one: the table is four indexes longer than its text.
function tinyTable(index: number, text: string): Content[number] {
  let start = index + 3, end = start + text.length;
  return {
    startIndex: index, endIndex: end + 1,
    table: {
      rows: 1, columns: 1,
      tableRows: [{
        startIndex: index + 1, endIndex: end,
        tableCells: [{
          startIndex: index + 2, endIndex: end,
          content: [{
            startIndex: start, endIndex: end,
            paragraph: {
              elements: [{ startIndex: start, endIndex: end, textRun: { content: text, textStyle: {} } }],
              paragraphStyle: CELL_STYLE,
            },
          }],
          tableCellStyle: {
            rowSpan: 1, columnSpan: 1, contentAlignment: "TOP",
            paddingLeft: { magnitude: 5, unit: "PT" }, paddingRight: { magnitude: 5, unit: "PT" },
            paddingTop: { magnitude: 5, unit: "PT" }, paddingBottom: { magnitude: 5, unit: "PT" },
          },
        }],
        tableRowStyle: { minRowHeight: { unit: "PT" } },
      }],
      tableStyle: { tableColumnProperties: [{ widthType: "EVENLY_DISTRIBUTED" }] },
    },
  } as Content[number];
}

/**
 * A pruned tab named `tabId`, as Google sends one: its paragraphs each hold one of `lines`, as
 * `scenarioTab`'s do, and a 1x1 table as `tinyTablesTab`'s (its cell holds `cell n` for the
 * n-th) stands before the paragraph at each place of `tables`. It defines no list. A table is
 * a run of its own, so each stands between two runs of paragraphs.
 */
export function linesWithTablesTab(
  tabId: string, lines: readonly string[], tables: readonly number[],
): GoogleDocsTab {
  let content: Content = [];
  let index = 1, made = 0;
  for (let [at, line] of lines.entries()) {
    if (tables.includes(at)) {
      let table = tinyTable(index, `cell ${made++}\n`);
      content.push(table);
      index = table.endIndex;
    }
    let text = `${line}\n`;
    let endIndex = index + text.length;
    content.push({
      startIndex: index, endIndex,
      paragraph: {
        elements: [{ startIndex: index, endIndex, textRun: { content: text, textStyle: {} } }],
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
      },
    });
    index = endIndex;
  }
  return shapedTab(tabId, content);
}

/**
 * `tinyTablesTab(tabId, pairs)` with each table's cell an item of a numbered list OF ITS OWN
 * (`kix.list<n>`, each defined in `tab.lists`): `2 * pairs + 1` runs and `pairs` lists, every
 * table a run that counts in one list no other run names. It is the shape on which what is
 * held or done for every list shows, so THE SIZE OF A DEFINITION IS FIXED: every figure in
 * bytes a list, and every statement over a tab's context, scales with it.
 * - `"short"`: nine levels of `{ glyphType: "DECIMAL" }`, 254 characters of JSON a definition,
 *   which is all a fetch keeps of a definition; 7,700 lists are a context of about 2 MB.
 * - `"long"`: nine levels with the fields Google sends of one (alignment, glyph format,
 *   indents, start number and text style), 1,923 characters of JSON a definition; 4,000 lists
 *   are a context of about 7.7 MB, under a row's limit. A fetch's walk prunes a definition to
 *   what the rendering reads, so this size is stored by a copy made of whole tabs
 *   (`wholeTabsFetched`) and by nothing that goes through the walk.
 */
export function listedTablesTab(
  tabId: string, pairs: number, definition: "short" | "long" = "short",
): GoogleDocsTab {
  let tab = tinyTablesTab(tabId, pairs);
  let lists: GoogleDocsTab["lists"] = {};
  let made = 0;
  for (let element of tab.body.content) {
    let paragraph = element.table?.tableRows?.[0]?.tableCells?.[0]?.content?.[0]?.paragraph;
    if (!paragraph) continue;
    let listId = `kix.list${made++}`;
    paragraph.bullet = { listId };
    lists[listId] = {
      listProperties: {
        nestingLevels: Array.from({ length: 9 }, (_, level) => definition === "short"
          ? { glyphType: "DECIMAL" }
          : {
            bulletAlignment: "START", glyphType: "DECIMAL", glyphFormat: `%${level}.`,
            indentFirstLine: { magnitude: 18 + 36 * level, unit: "PT" },
            indentStart: { magnitude: 36 + 36 * level, unit: "PT" },
            startNumber: 1, textStyle: { underline: false },
          }),
      },
    };
  }
  return { ...tab, lists };
}

/**
 * A pruned tab of one empty paragraph and then `lists` paragraphs of about a hundred
 * characters, EACH AN ITEM OF A NUMBERED LIST OF ITS OWN (`kix.list<n>`, defined as
 * `listedTablesTab`'s short definition, 254 characters of JSON): under the store's sizes about
 * a hundred paragraphs are a run, so 3,000 lists are a few tens of runs, ONE PAGE of the
 * version's list, whose runs name every list the tab defines. It is the shape a tab of prose
 * under the limit on an answer has (about 320 runs: one page), kept beside the shapes of many
 * runs because what is held of a page's lists is here the tab's, where on those it is a
 * page's share.
 */
export function listedProseTab(tabId: string, lists: number): GoogleDocsTab {
  let content: Content = [proseParagraph(1, "\n")];
  let defined: GoogleDocsTab["lists"] = {};
  let index = 2;
  for (let at = 0; at < lists; at++) {
    let listId = `kix.list${at}`;
    let text = `Item ${at} ${"lorem ipsum dolor sit amet ".repeat(4)}`.slice(0, 99) + "\n";
    let paragraph = proseParagraph(index, text);
    content.push({ ...paragraph, paragraph: { ...paragraph.paragraph!, bullet: { listId } } });
    defined[listId] = {
      listProperties: { nestingLevels: Array.from({ length: 9 }, () => ({ glyphType: "DECIMAL" })) },
    };
    index += text.length;
  }
  return { ...shapedTab(tabId, content), lists: defined };
}

/** What `wholeTabsFetched` answers: a fetched document whose tabs also name the tab they are of. */
export type WholeTabsFetched = Omit<FetchedDoc, "tabs"> & {
  readonly tabs: readonly (FetchedDocTab & { readonly tab: GoogleDocsTab })[];
};

/**
 * A fetched document made of whole pruned tabs, with nothing of the walk of a parsed answer:
 * each tab's runs are the tab's body cut to `sizes`, anew at each read, so one value serves
 * several keeps and nothing of it is let go as it is read.
 */
export function wholeTabsFetched(
  copy: {
    readonly revision?: string;
    readonly fetchedAt: number;
    readonly tabs: readonly {
      readonly tab: GoogleDocsTab; readonly writeMarkers: readonly DocWriteMarkerCopy[];
    }[];
  },
  sizes: RunSizes = RUN_SIZES,
): WholeTabsFetched {
  return {
    ...(copy.revision === undefined ? {} : { revision: copy.revision }),
    fetchedAt: copy.fetchedAt,
    tabs: copy.tabs.map(({ tab, writeMarkers }) => {
      let start = tab.body.content[0]?.startIndex;
      return {
        tab,
        identity: tabIdentity(tab),
        writeMarkers,
        context: { lists: tab.lists, ...(tab.namedStyles ? { namedStyles: tab.namedStyles } : {}) },
        first: Number.isInteger(start) ? start : 0,
        runs: { [Symbol.iterator]: () => cutRuns(tab.body.content, sizes) },
        unindexed: () => !hasModelIndexes(tab) || !hasModelFootnotes(tab),
      };
    }),
  };
}

/** A document of `tabs` as a keep takes it, with no write marker, cut to `sizes`. */
export function scenarioCopy(
  tabs: readonly GoogleDocsTab[], revision = "r1", sizes: RunSizes = RUN_SIZES,
): WholeTabsFetched {
  return wholeTabsFetched(
    { revision, fetchedAt: 1_000, tabs: tabs.map(tab => ({ tab, writeMarkers: [] })) }, sizes);
}

/** A document of deep copies of `tabs`, as Google answers one: for a test that goes through the walk. */
export function scenarioDocument(tabs: readonly GoogleDocsTab[], revision = "r1"): GoogleDocsDocument {
  return {
    documentId: "doc", title: "Scenario", revisionId: revision,
    tabs: tabs.map(tab => structuredClone(tab)),
  };
}

const ROWS_BY_KEY = [
  "SELECT * FROM doc_copy ORDER BY doc",
  "SELECT * FROM doc_md ORDER BY doc, run, context, carry",
  "SELECT * FROM doc_result ORDER BY version, edit",
  "SELECT * FROM doc_run ORDER BY doc, id",
  "SELECT * FROM doc_seq ORDER BY version, seq",
  "SELECT * FROM doc_version ORDER BY doc, id",
];

/**
 * Every row of the six tables of documents, each table in the order of its key, as JSON: what
 * two states of storage are compared by, on the fake and on real storage alike.
 */
export function storedRows(storage: DocStoreStorage): string {
  return JSON.stringify(ROWS_BY_KEY.map(query => storage.sql.exec(query).toArray()));
}

/** The base version of the `at`-th tab of the copy `head` names. */
export function scenarioBase(store: DocStore, doc: string, head: DocCopyHead, at = 0): DocVersion {
  let version = store.version(doc, head.versions[at], {
    ...head.outline[at], writeMarkers: head.writeMarkers[at],
  });
  if (!version) throw new Error("The copy's base version is not stored.");
  return version;
}

/**
 * Makes the edit keyed `edit` in `version`, typing `text` at the start of the tab, as the
 * replay makes one: the version it gives is stored from the runs the batch touches, every
 * other run listed as it was, and the result under `edit`.
 */
export function scenarioEdit(store: DocStore, version: DocVersion, edit: string, text = edit): DocVersion {
  let requests: GoogleDocsRequest[] = [{ insertText: { location: { index: 1, tabId: version.tabId }, text } }];
  let { slice, made } = editedSlice(store, version, "replaceText", requests);
  let after = store.putSlice(slice, made);
  store.putResult(version, edit, { requests, after });
  return after;
}

const TABLES = ["doc_copy", "doc_md", "doc_result", "doc_run", "doc_seq", "doc_version"] as const;

/** How many rows each table of documents holds. */
export function tableCounts(storage: DocStoreStorage): Record<string, number> {
  return Object.fromEntries(TABLES.map(table =>
    [table, storage.sql.exec<{ rows: number }>(`SELECT count(*) AS rows FROM ${table}`).one().rows]));
}

/**
 * What Google sent of document `doc`, as it is stored: the copy's record but the digest it was
 * swept under; its base versions but what code derived of them; of their run lists, which runs,
 * in which order and of which lengths; and those runs and the versions' contexts. This is what
 * a deploy that changes the code keeps byte for byte, said in one place.
 */
export function fetchedRows(storage: DocStoreStorage, doc: string): Record<string, unknown[]> {
  let rows = (query: string, ...bindings: unknown[]) => storage.sql.exec(query, ...bindings).toArray();
  let copy = rows(
    `SELECT doc, id, revision, fetched_at, checked_at, stale, folder, approved, outline, markers, versions
     FROM doc_copy WHERE doc = ?`, doc);
  let ids = copy.length > 0 ? String(copy[0].versions) : "[]";
  let versions = rows(
    `SELECT doc, id, context, meta FROM doc_version
     WHERE doc = ?1 AND id IN (SELECT value FROM json_each(?2)) ORDER BY id`, doc, ids);
  // `context` and `carry` of a run list are keys the renderer's rules derive, so they are not
  // part of what was fetched.
  let lists = rows(
    `SELECT version, seq, run, size FROM doc_seq
     WHERE version IN (SELECT value FROM json_each(?1)) ORDER BY version, seq`, ids);
  let content = JSON.stringify([...lists.map(row => row.run), ...versions.map(row => row.context)]);
  let runs = rows(
    "SELECT id, json FROM doc_run WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id", content);
  return { doc_copy: copy, doc_version: versions, doc_seq: lists, doc_run: runs };
}

/** The values of `made` each table of derived rows holds, in order. */
export function digestsStored(storage: DocStoreStorage): Record<string, string[]> {
  let made = (query: string) =>
    storage.sql.exec<{ made: string }>(query).toArray().map(row => row.made);
  return {
    doc_copy: made("SELECT DISTINCT made FROM doc_copy ORDER BY made"),
    doc_md: made("SELECT DISTINCT made FROM doc_md ORDER BY made"),
    doc_result: made("SELECT DISTINCT made FROM doc_result ORDER BY made"),
  };
}

/**
 * Keeps a two-tab document, reads a tab's Markdown, stores a child and a result, runs a trial of
 * the document with its other tab changed, sweeps, and reads again.
 */
export function storeScenario(storage: DocStoreStorage) {
  let store = new DocStore(storage);
  let tabs = [scenarioTab("t1", ["One", "Two"], ["Three"]), scenarioTab("t2", ["Notes"])];
  let head = store.keep("doc", scenarioCopy(tabs), NONE);
  let base = scenarioBase(store, "doc", head);
  let markdown = store.markdown(base);
  let child = scenarioEdit(store, base, "e1", "Zero ");
  let kept = tableCounts(storage);

  let pending: DocPending = { edits: ["e1"], roots: [] };
  let later = [tabs[0], scenarioTab("t2", ["Notes", "More"])];
  let trial = store.trial("doc", scenarioCopy(later, "r2"), () => pending, unkept => ({
    anotherCopy: unkept.id !== head.id,
    changed: store.markdown(scenarioBase(store, "doc", unkept, 1)),
    edited: store.markdown(scenarioEdit(store, scenarioBase(store, "doc", unkept, 0), "e2", "Not queued ")),
  }));
  let afterTrial = tableCounts(storage);

  store.sweep("doc", pending);
  let found = store.result(base, "e1");
  let read = found && "after" in found
    ? { requests: found.requests.length, child: found.after.id === child.id, markdown: store.markdown(found.after) }
    : undefined;
  store.sweep("doc", NONE);
  return {
    head: { versions: head.versions.length, revision: head.revision, stale: store.head("doc")?.stale },
    holds: store.holds("doc", head.id),
    markdown, kept, trial, afterTrial, read,
    notPending: store.result(base, "e2") === undefined,
    swept: tableCounts(storage),
  };
}

/**
 * A document written under one digest of the code and read under another: what is served, what
 * is made again, and what the document's next sweep leaves.
 */
export function anotherDigestScenario(storage: DocStoreStorage) {
  let a = new DocStore(storage, undefined, "a");
  let tabs = [scenarioTab("t1", ["One", "Two"], ["Three"]), scenarioTab("t2", ["Notes"])];
  let head = a.keep("doc", scenarioCopy(tabs), NONE);
  let base = scenarioBase(a, "doc", head);
  a.markdown(base);
  let child = scenarioEdit(a, base, "e1", "Zero ");
  a.unindexed(base);
  let fetched = JSON.stringify(fetchedRows(storage, "doc"));
  let before = tableCounts(storage);

  let b = new DocStore(storage, undefined, "b");
  let opened = JSON.stringify(tableCounts(storage)) === JSON.stringify(before);
  let cost = () => [docStoreCost.runsDecoded, docStoreCost.runsRendered];
  let moved = (run: () => unknown) => {
    let [decoded, rendered] = cost();
    run();
    return [docStoreCost.runsDecoded - decoded, docStoreCost.runsRendered - rendered];
  };
  let served = {
    result: b.result(base, "e1") !== undefined,
    firstRead: moved(() => b.markdown(base)),
    secondRead: moved(() => b.markdown(base)),
    unindexed: [moved(() => b.unindexed(base)), moved(() => b.unindexed(base))],
  };
  let beforeSweep = digestsStored(storage);
  b.sweep("doc", { edits: ["e1"], roots: [] });
  return {
    opened, served, beforeSweep,
    afterSweep: digestsStored(storage),
    childGone: b.version("doc", child.id, base) === undefined,
    counts: tableCounts(storage),
    fetchedKept: JSON.stringify(fetchedRows(storage, "doc")) === fetched,
  };
}

/** What one step of a tab's life moved of the store's counters. */
export type StepCost = {
  rowsWritten: number; runsDecoded: number; runsRendered: number; runsKeyed: number;
};

/**
 * The life of a tab of `paragraphs` paragraphs (`Line 00000.` and on) in `store`, as the
 * document `doc`: kept, read, edited in the middle, read pending, the edit rejected, made again
 * and approved, the tab fetched with one paragraph changed, and fetched unchanged. Answers what
 * each step moved of the store's counters, with how many runs the tab is (`n`), how many the
 * edit and the changed fetch replaced (`c`, `fetched`) and how many runs the tab after either
 * is (`m`).
 */
export function largeTabLife(store: DocStore, storage: DocStoreStorage, paragraphs = 20_000) {
  let lines = Array.from({ length: paragraphs }, (_, at) => `Line ${String(at).padStart(5, "0")}.`);
  let middle = Math.floor(paragraphs / 2);
  let edit: DocEdit = { type: "replaceText", oldMarkdown: lines[middle], newMarkdown: "Changed." };
  let step = (run: () => unknown): StepCost => {
    let before = { ...docStoreCost };
    run();
    return {
      rowsWritten: docStoreCost.rowsWritten - before.rowsWritten,
      runsDecoded: docStoreCost.runsDecoded - before.runsDecoded,
      runsRendered: docStoreCost.runsRendered - before.runsRendered,
      runsKeyed: docStoreCost.runsKeyed - before.runsKeyed,
    };
  };
  let runsOf = ({ id }: DocVersion) => storage.sql.exec<{ run: string }>(
    "SELECT run FROM doc_seq WHERE version = ? ORDER BY seq", id).toArray().map(({ run }) => run);
  let replaced = (after: string[], before: string[]) => {
    let known = new Set(before);
    return after.filter(run => !known.has(run)).length;
  };

  let head!: DocCopyHead;
  let keep = step(() => head = store.keep("doc", scenarioCopy([scenarioTab("t1", lines)]), NONE));
  let base = scenarioBase(store, "doc", head);
  let runs = runsOf(base);
  let read = step(() => {
    store.markdown(base);
    store.summary(base);
  });
  let child!: DocVersion;
  let edited = step(() => child = docEditResult(store, base, edit).after);
  let after = runsOf(child);
  let pendingRead = step(() => store.markdown(child));
  let rejection = step(() => store.sweep("doc", NONE));
  let baseRead = step(() => store.markdown(base));
  let editedAgain = step(() => docEditResult(store, base, edit));
  let approval = step(() => {
    store.touch("doc", { stale: true });
    store.sweep("doc", NONE);
  });
  let later = scenarioTab("t1", lines.with(middle, "Changed in Google Docs."));
  let refetch = step(() => head = store.keep("doc", scenarioCopy([later], "r2"), NONE));
  let fetched = runsOf(scenarioBase(store, "doc", head));
  let unchanged = step(() => store.keep("doc", scenarioCopy([later], "r3"), NONE));
  return {
    n: runs.length, c: replaced(after, runs), m: after.length,
    fetched: { c: replaced(fetched, runs), m: fetched.length },
    keep, read, edit: edited, pendingRead, rejection, baseRead, editAgain: editedAgain, approval,
    refetch, unchanged,
  };
}

/**
 * What `storeScenario` answers, on the fake and on real storage alike. Each tab is one run
 * under the sizes a store cuts to, so a row a run is a row a tab here.
 */
export const STORE_SCENARIO: ReturnType<typeof storeScenario> = {
  head: { versions: 2, revision: "r1", stale: false },
  holds: true,
  markdown: "One\n\nTwo\n\n1. Three\n",
  // Two tabs that share a context and the child an edit made: a run, a list of one row and a
  // version each, and a rendering each, since a keep renders each run of each tab, alone, to be
  // stored, and an edit the runs it changed, which is its tab's one run. And the edit's result.
  kept: { doc_copy: 1, doc_md: 3, doc_result: 1, doc_run: 4, doc_seq: 3, doc_version: 3 },
  trial: {
    anotherCopy: true, changed: "Notes\n\nMore\n", edited: "Not queued One\n\nTwo\n\n1. Three\n",
  },
  // The trial left nothing of the changed tab, nor of the edit that is not pending.
  afterTrial: { doc_copy: 1, doc_md: 3, doc_result: 1, doc_run: 4, doc_seq: 3, doc_version: 3 },
  read: { requests: 1, child: true, markdown: "Zero One\n\nTwo\n\n1. Three\n" },
  notPending: true,
  // The two base versions, each with its run and its rendering, and their context.
  swept: { doc_copy: 1, doc_md: 2, doc_result: 0, doc_run: 3, doc_seq: 2, doc_version: 2 },
};

/** What `anotherDigestScenario` answers, on the fake and on real storage alike. */
export const ANOTHER_DIGEST_SCENARIO: ReturnType<typeof anotherDigestScenario> = {
  // Opening under another digest removes nothing.
  opened: true,
  served: {
    result: false,
    // The version's keys and its stored rendering are of the other digest: its one run is
    // decoded and rendered once, with the list it names loaded, and keyed in place.
    firstRead: [1, 1],
    // Keyed under this digest, it is read as stored: nothing is decoded and nothing rendered.
    secondRead: [0, 0],
    // Whether the model follows the tab is worked out once, by a decode of its one run.
    unindexed: [[1, 0], [0, 0]],
  },
  beforeSweep: { doc_copy: ["a"], doc_md: ["a", "b"], doc_result: ["a"] },
  afterSweep: { doc_copy: ["b"], doc_md: ["b"], doc_result: [] },
  childGone: true,
  // Of the renderings, the one this digest made of the tab that was read: the other tab's goes
  // with the sweep, and is made again by its next read.
  counts: { doc_copy: 1, doc_md: 1, doc_result: 0, doc_run: 3, doc_seq: 2, doc_version: 2 },
  fetchedKept: true,
};

// ---------------------------------------------------------------------------
// A fetch, stored as it is read
// ---------------------------------------------------------------------------

/** Sizes that end a run every three elements, whatever they hold. */
const THREES: RunSizes = { least: Infinity, target: Infinity, most: Infinity, elements: 3 };

/** `storage`, with `seen` handed each statement before it runs. */
function observedStorage(
  storage: DocStoreStorage, seen: (query: string, bindings: readonly unknown[]) => void,
): DocStoreStorage {
  return {
    sql: {
      exec: ((query: string, ...bindings: unknown[]) => {
        seen(query, bindings);
        return storage.sql.exec(query, ...bindings);
      }) as DocStoreStorage["sql"]["exec"],
    },
    transactionSync: callback => storage.transactionSync(callback),
  };
}

/** What a scenario answers of something thrown: its name and what it says, with no size in it. */
function said(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // A row's error says how many bytes the row is, after a colon.
  return `${error.name}: ${error instanceof DocRowTooLargeError ? error.message.split(":")[0] : error.message}`;
}

/**
 * A tab of `groups` groups of 12 paragraphs after its section break, group n's paragraphs the
 * items of the n-th 12-subset, in lexicographic order, of 18 numbered lists of nine levels
 * that the tab defines: cut every 12 elements, runs that each name a dozen lists and no two
 * the same ones, so every run's summary is long and differs from every other.
 */
export function listRunsTab(tabId: string, groups: number): GoogleDocsTab {
  let ids = Array.from({ length: 18 }, (_, at) => `kix.list${String(at).padStart(2, "0")}`);
  let levels = Array.from({ length: 9 }, () => ({ glyphType: "DECIMAL" }));
  let subset = Array.from({ length: 12 }, (_, at) => at);
  let content: Content = [];
  let index = 1;
  for (let group = 0; group < groups; group++) {
    for (let list of subset) {
      let text = `Item ${group} of ${ids[list]}\n`;
      let paragraph = proseParagraph(index, text);
      content.push({
        ...paragraph, paragraph: { ...paragraph.paragraph!, bullet: { listId: ids[list] } },
      });
      index += text.length;
    }
    // The next subset in lexicographic order: the last place that can move, and those after it.
    let at = subset.length - 1;
    while (at >= 0 && subset[at] === ids.length - subset.length + at) at--;
    if (at < 0) throw new Error("There are no more subsets of the lists.");
    subset[at]++;
    for (let after = at + 1; after < subset.length; after++) subset[after] = subset[after - 1] + 1;
  }
  return pruneTab({
    tabId, title: `Tab ${tabId}`, index: 0, nestingLevel: 0,
    body: { content: [{ endIndex: 1, sectionBreak: {} }, ...content] as Content },
    lists: Object.fromEntries(ids.map(id => [id, { listProperties: { nestingLevels: levels } }])),
    namedRanges: {},
  });
}

/** One fetch that throws part way, and how it is stored. */
type AtomicCase = {
  /** What threw, and whether storage and the copy's record are, byte for byte, what they were. */
  thrown: string; unchanged: boolean;
  /** Whether a run was written inside the transaction before the throw. */
  wrote: boolean;
};

/**
 * Fetches that throw part way, with no copy stored and with a seven-tab copy stored: a keep
 * and a trial of a seven-tab document in which an element is one the copy refuses, the named
 * ranges are malformed, a paragraph is past a row, or a run is one the renderer throws on;
 * and, for the renderer's throw, which holding a document does not meet, a keep and a trial of
 * the document held. Answers, by case, what was thrown and whether storage is as it was.
 */
export function fetchAtomicScenario(storage: DocStoreStorage): Record<string, AtomicCase> {
  let runsWritten = 0;
  let store = new DocStore(observedStorage(storage, query => {
    if (query.startsWith("INSERT INTO doc_run")) runsWritten++;
  }), undefined, undefined, THREES);
  // Seven tabs of eleven paragraphs and a list item: four runs each.
  let tabs = (text: string) => Array.from({ length: 7 }, (_, tab) => scenarioTab(
    `t${tab + 1}`, Array.from({ length: 11 }, (_line, at) => `${text} ${tab + 1}.${at}`), ["An item"]));
  let paragraphOf = (tab: GoogleDocsTab, at: number) => tab.body.content[at].paragraph!;
  let unstyled = (tab: GoogleDocsTab, at: number) => {
    delete (paragraphOf(tab, at) as { paragraphStyle?: unknown }).paragraphStyle;
  };
  let faults: Record<string, (document: GoogleDocsTab[]) => void> = {
    "an element the copy refuses in the first tab": document => unstyled(document[0], 1),
    "an element the copy refuses in a middle tab": document => unstyled(document[3], 1),
    "an element the copy refuses in the last tab": document => unstyled(document[6], 1),
    "an element the copy refuses in mid-tab, after runs of the tab": document => unstyled(document[0], 9),
    "malformed named ranges in the last tab": document => {
      document[6].namedRanges = { broken: {} } as unknown as GoogleDocsTab["namedRanges"];
    },
    "a paragraph past a row in the last tab": document => {
      paragraphOf(document[6], 5).elements[0].textRun!.content = "x".repeat(DOC_ROW_BYTES);
    },
    "a run the renderer throws on in the last tab": document => {
      paragraphOf(document[6], 12).bullet!.nestingLevel = -1;
    },
  };
  let cases: Record<string, AtomicCase> = {};
  for (let stored of ["no copy stored", "a copy stored"]) {
    if (stored === "a copy stored") {
      store.keep("doc", store.fetched(scenarioDocument(tabs("Stored")), 1_000), NONE);
    }
    let before = storedRows(storage) + JSON.stringify(store.head("doc"));
    for (let [fault, damage] of Object.entries(faults)) {
      let fetched = () => {
        let document = tabs("Fetched");
        damage(document);
        return store.fetched(scenarioDocument(document, "r2"), 2_000);
      };
      let ways: Record<string, () => unknown> = {
        "kept": () => store.keep("doc", fetched(), NONE),
        "tried": () => store.trial("doc", fetched(), () => NONE, () => undefined),
        ...(fault.startsWith("a run the renderer") ? {
          "held and kept": () => store.keep("doc", heldDoc("doc", fetched()), NONE),
          "held and tried": () => store.trial("doc", heldDoc("doc", fetched()), () => NONE, () => undefined),
        } : {}),
      };
      for (let [way, run] of Object.entries(ways)) {
        let written = runsWritten;
        let thrown = "nothing";
        try {
          run();
        } catch (error) {
          thrown = said(error);
        }
        cases[`${stored}, ${fault}, ${way}`] = {
          thrown, wrote: runsWritten > written,
          unchanged: storedRows(storage) + JSON.stringify(store.head("doc")) === before,
        };
      }
    }
  }
  return cases;
}

/** What `fetchAtomicScenario` answers, on the fake and on real storage alike. */
export const FETCH_ATOMIC_SCENARIO: ReturnType<typeof fetchAtomicScenario> = Object.fromEntries(
  ["no copy stored", "a copy stored"].flatMap(stored => ([
    // In the first tab's first run: nothing was written before it.
    ["an element the copy refuses in the first tab", "TypeError: Google Docs returned a part without its paragraphStyle", false],
    ["an element the copy refuses in a middle tab", "TypeError: Google Docs returned a part without its paragraphStyle", true],
    ["an element the copy refuses in the last tab", "TypeError: Google Docs returned a part without its paragraphStyle", true],
    // In the first tab's fourth run: the runs written before it are that tab's.
    ["an element the copy refuses in mid-tab, after runs of the tab", "TypeError: Google Docs returned a part without its paragraphStyle", true],
    ["malformed named ranges in the last tab", "Error: Google Docs returned invalid named ranges", true],
    ["a paragraph past a row in the last tab", "DocRowTooLargeError: A paragraph of tab \"t7\" of this Google Doc is too large to keep a copy of", true],
    ["a run the renderer throws on in the last tab", "DocRunRenderError: A run of the tab could not be rendered.", true],
  ] as const).flatMap(([fault, thrown, wrote]) =>
    ["kept", "tried", ...(fault.startsWith("a run the renderer") ? ["held and kept", "held and tried"] : [])]
      .map(way => [`${stored}, ${fault}, ${way}`, { thrown, wrote, unchanged: true }]))));

/** What a step of a read through Drive moved of the store's counts. */
type ReadCost = { runsDecoded: number; runsRendered: number; runsKeyed: number };

/**
 * What a source of a Doc opened through Drive does with a fetched document, through the
 * connection's copies (`driveDocCopies`): held, tried in a read, and kept only once the read
 * is approved. A first read that is refused, the same read approved, a read of the document
 * changed that is refused beside the stored copy, and the document kept as a bound Doc keeps
 * it. Answers what each step decoded, rendered and keyed, with how many runs the document is
 * (`n`), and whether storage was as it was after each refused read.
 */
export function driveReadScenario(storage: DocStoreStorage) {
  let lazy = lazyDocStore(storage);
  let copies = driveDocCopies(lazy, "file");
  let step = (run: () => unknown): ReadCost => {
    let before = { ...docStoreCost };
    run();
    return {
      runsDecoded: docStoreCost.runsDecoded - before.runsDecoded,
      runsRendered: docStoreCost.runsRendered - before.runsRendered,
      runsKeyed: docStoreCost.runsKeyed - before.runsKeyed,
    };
  };
  let document = (changed?: number) => scenarioDocument(
    [proseTab("t1", 1_200, at => at === changed ? "Changed in Google Docs." : `Paragraph ${at} ${"of some length ".repeat(15)}`)],
    changed === undefined ? "r1" : "r2");
  let read = (copy: DocCopy) => copy.markdown(copy.tab("t1")!).length;
  // The rows a tab is stored as: every table of documents but the copy's record.
  let tabRows = () => JSON.stringify(ROWS_BY_KEY.filter(query => !query.includes("doc_copy"))
    .map(query => storage.sql.exec(query).toArray()));

  // A first read, refused: held, read in a trial, and never kept.
  lazy();
  let empty = storedRows(storage);
  let held!: HeldDoc;
  let hold = step(() => held = copies.hold(document(), 1_000));
  let firstTrial = step(() => copies.trial(held, read));
  let refusedFirst = storedRows(storage) === empty;
  // The same read approved.
  let keep = step(() => copies.keep(held));
  let kept = tabRows();
  let stored = storedRows(storage);
  let n = storage.sql.exec<{ runs: number }>("SELECT count(*) AS runs FROM doc_seq").one().runs;
  // A read of the document changed, refused beside the stored copy.
  let later = copies.hold(document(600), 2_000);
  let besideTrial = step(() => copies.trial(later, read));
  let refusedBeside = storedRows(storage) === stored;
  // The document as a bound Doc keeps it: the same rows, and the same copy.
  lazy().drop("file");
  let bound = lazy().keep("file", lazy().fetched(document(), 1_000), NONE);
  return {
    n, hold, firstTrial, refusedFirst, keep, besideTrial, refusedBeside,
    asBound: tabRows() === kept && bound.id === held.id,
  };
}

/** How many runs the document of `driveReadScenario` is. */
const DRIVE_READ_RUNS = 20;

/** What `driveReadScenario` answers, on the fake and on real storage alike. */
export const DRIVE_READ_SCENARIO: ReturnType<typeof driveReadScenario> = {
  n: DRIVE_READ_RUNS,
  // Holding a document reads it and renders nothing.
  hold: { runsDecoded: 0, runsRendered: 0, runsKeyed: 0 },
  // The trial and the keep each store the document from its bytes: every run is decoded, and
  // rendered, twice in all.
  firstTrial: { runsDecoded: DRIVE_READ_RUNS, runsRendered: DRIVE_READ_RUNS, runsKeyed: 0 },
  refusedFirst: true,
  keep: { runsDecoded: DRIVE_READ_RUNS, runsRendered: DRIVE_READ_RUNS, runsKeyed: 0 },
  // Beside the stored copy, the run that changed is rendered and the run after it keyed.
  besideTrial: { runsDecoded: DRIVE_READ_RUNS, runsRendered: 1, runsKeyed: 1 },
  refusedBeside: true,
  asBound: true,
};

/**
 * Fetches that answer late or not at all. A bound Doc (`StoredDocCopy`): a fetch in flight
 * that a write overtakes; two reads issued together; a fetch whose document cannot be stored.
 * Through Drive (`driveDocCopies`): a held document fetched before the one that is stored, of
 * the same document and of another.
 */
export async function lateFetchScenario(storage: DocStoreStorage & UnreadDocCopyStorage) {
  let store = new DocStore(storage);
  let document = (text: string, revision: string) =>
    scenarioDocument([scenarioTab("t1", [text, "Two"]), scenarioTab("t2", ["Notes"])], revision);
  let whole = (answer: GoogleDocsDocument) => answer.tabs.every(tab =>
    tab !== undefined && tab.body.content.every(element => element !== undefined));
  let answers: (GoogleDocsDocument | Error | Promise<GoogleDocsDocument>)[] = [];
  let fetches = 0;
  let copy = new StoredDocCopy({
    store, doc: "doc", storage, ttlMs: 60_000, pending: () => NONE, now: () => 1_000,
    fetch: async () => {
      fetches++;
      let next = await (answers.shift() ?? new Error("No answer is queued."));
      if (next instanceof Error) throw next;
      return next;
    },
  });
  let failure = (reading: Promise<unknown>) => reading.then(() => "nothing", said);

  // A fetch in flight when a write lands: its answer is not stored, and is not read.
  let empty = storedRows(storage);
  let slow = Promise.withResolvers<GoogleDocsDocument>();
  let overtakenAnswer = document("Overtaken", "r0");
  answers.push(slow.promise, new Error("The fetch after the write failed."));
  let reading = failure(copy.current());
  copy.noteWrite();
  slow.resolve(overtakenAnswer);
  let overtaken = {
    rejected: await reading, fetches,
    stored: storedRows(storage) !== empty, unread: whole(overtakenAnswer),
  };

  // Two reads issued together share one fetch, which is stored once.
  fetches = 0;
  answers.push(document("One", "r1"));
  let rendered = docStoreCost.runsRendered;
  let [first, second] = await Promise.all([copy.current(), copy.current()]);
  let together = {
    fetches, sameCopy: first.revision === "r1" && second.revision === "r1",
    rendered: docStoreCost.runsRendered - rendered,
  };

  // A fetch whose document cannot be stored: the read fails, the earlier copy stands.
  let refused = document("Refused", "r2");
  delete (refused.tabs[1].body.content[1].paragraph as { paragraphStyle?: unknown }).paragraphStyle;
  copy.recheck();
  let before = storedRows(storage);
  fetches = 0;
  answers.push(refused, document("Three", "r3"));
  let rejected = await failure(copy.current());
  let thrown = {
    rejected, unchanged: storedRows(storage) === before, held: copy.held()?.revision,
    next: (await copy.current()).revision, fetches,
  };

  // Through Drive: a held document fetched before the stored one replaces nothing.
  let copies = driveDocCopies(lazyDocStore(storage), "file");
  copies.keep(copies.hold(document("Later", "r5"), 20));
  let kept = storedRows(storage);
  let same = copies.keep(copies.hold(document("Later", "r5"), 10));
  let other = copies.keep(copies.hold(document("Earlier", "r4"), 5));
  let drive = {
    same: same?.held() === true, other: other === undefined, unchanged: storedRows(storage) === kept,
    fetchedAt: store.head("file")?.fetchedAt,
  };
  return { overtaken, together, thrown, drive };
}

/** What `lateFetchScenario` answers, on the fake and on real storage alike. */
export const LATE_FETCH_SCENARIO: Awaited<ReturnType<typeof lateFetchScenario>> = {
  // The read is answered by the fetch that follows the write, which failed here: the answer
  // the write overtook stored no row, and still holds every tab and element.
  overtaken: {
    rejected: "Error: The fetch after the write failed.", fetches: 2, stored: false, unread: true,
  },
  // One fetch, kept once: each of the two tabs is one run, rendered once.
  together: { fetches: 1, sameCopy: true, rendered: 2 },
  thrown: {
    rejected: "TypeError: Google Docs returned a part without its paragraphStyle",
    unchanged: true, held: "r1", next: "r3", fetches: 2,
  },
  // The stored copy is the read's where it is of the same document, and no one's otherwise.
  drive: { same: true, other: true, unchanged: true, fetchedAt: 20 },
};

/** A Durable Object's storage as `fetchCounts` reads it: a cursor also says the rows it read. */
export type CountedStorage = {
  readonly sql: {
    exec(query: string, ...bindings: unknown[]): {
      toArray(): Record<string, SqlStorageValue>[];
      one(): Record<string, SqlStorageValue>;
      readonly rowsWritten: number;
      readonly rowsRead: number;
    };
  };
  transactionSync<T>(callback: () => T): T;
};

/** What one fetch of `fetchCounts` cost. */
export type FetchCost = {
  /** Rows written and rows read, as storage bills them for every statement of the fetch. */
  rowsWritten: number; rowsRead: number;
  runsRendered: number; runsKeyed: number;
  /** The statements that read a page of the stored base's list, and the rows they answered. */
  listStatements: number; listRows: number;
};

/**
 * The fetches of one tab near the limit on an answer, in a store of its own over `storage`: a
 * first fetch, a fetch with a paragraph changed in the first run, one with a paragraph
 * changed in the last run as well, and a fetch that brings nothing changed. `prose` is a tab
 * of paragraphs of about 500 characters, an answer of nearly 10 MiB; `tables` a tab of 2,000
 * small tables, which is many runs. Answers what each fetch cost, with the bytes of the
 * answer's JSON, the runs of the tab (`n`), and for each changed fetch the runs it replaced.
 */
export function fetchCounts(storage: CountedStorage, shape: "prose" | "tables") {
  let rowsRead = 0, listStatements = 0, listRows = 0;
  let store = new DocStore({
    sql: {
      exec: ((query: string, ...bindings: unknown[]) => {
        let cursor = storage.sql.exec(query, ...bindings);
        let list = /FROM doc_seq LEFT JOIN doc_md[^]*LIMIT/.test(query);
        return {
          toArray: () => {
            let rows = cursor.toArray();
            rowsRead += cursor.rowsRead;
            if (list) {
              listStatements++;
              listRows += rows.length;
            }
            return rows;
          },
          one: () => {
            let row = cursor.one();
            rowsRead += cursor.rowsRead;
            return row;
          },
          get rowsWritten() {
            return cursor.rowsWritten;
          },
        };
      }) as DocStoreStorage["sql"]["exec"],
    },
    transactionSync: callback => storage.transactionSync(callback),
  });
  let paragraphs = 14_600;
  let text = (at: number) => `Paragraph ${at} ${"lorem ipsum dolor sit amet ".repeat(19)}`.slice(0, 499);
  let last = shape === "prose" ? paragraphs - 1 : 1_999;
  let tab = (changed: readonly number[]) => shape === "prose"
    ? proseTab("t1", paragraphs, at => changed.includes(at) ? `Changed ${text(at)}`.slice(0, 499) : text(at))
    : tinyTablesTab("t1", 2_000, at => changed.includes(at) ? `changed ${at}` : `cell ${at}`);
  let listed = () => storage.sql.exec(
    `SELECT run FROM doc_seq WHERE version =
       (SELECT json_extract(versions, '$[0]') FROM doc_copy WHERE doc = 'doc') ORDER BY seq`)
    .toArray().map(({ run }) => String(run));
  let runs: string[] = [];
  let fetch = (changed: readonly number[], revision: string) => {
    let document = scenarioDocument([tab(changed)], revision);
    let before = { ...docStoreCost, rowsRead, listStatements, listRows };
    store.keep("doc", store.fetched(document, 1_000), NONE);
    let cost: FetchCost = {
      rowsWritten: docStoreCost.rowsWritten - before.rowsWritten, rowsRead: rowsRead - before.rowsRead,
      runsRendered: docStoreCost.runsRendered - before.runsRendered,
      runsKeyed: docStoreCost.runsKeyed - before.runsKeyed,
      listStatements: listStatements - before.listStatements, listRows: listRows - before.listRows,
    };
    let known = new Set(runs);
    runs = listed();
    return { ...cost, replaced: runs.filter(run => !known.has(run)).length, runs: runs.length };
  };
  let answerBytes = new TextEncoder().encode(JSON.stringify(scenarioDocument([tab([])]))).length;
  return {
    answerBytes,
    first: fetch([], "r1"),
    changedFirst: fetch([0], "r2"),
    changedLast: fetch([0, last], "r3"),
    unchanged: fetch([0, last], "r4"),
  };
}

// ---------------------------------------------------------------------------
// The statements a call runs, counted and planned
// ---------------------------------------------------------------------------

/** Sizes that cut a tab into runs of one to three elements. */
export const RUNS_OF_THREE: RunSizes = { least: 0, target: 400, most: Infinity, elements: 3 };

/**
 * The storage a `DocStore` takes, whose cursor may also say the rows it read: a Durable
 * Object's does, and the Node tests' does not.
 */
export type RowsReadStorage = {
  readonly sql: {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): {
      toArray(): T[];
      one(): T;
      readonly rowsWritten: number;
      readonly rowsRead?: number;
    };
  };
  transactionSync<T>(callback: () => T): T;
};

/** How many statements of each kind ran through a `countedStorage`. */
export type StatementCounts = {
  /** A context's named styles, and whether its row is a context. */
  styles: number;
  /** The definitions of some lists of a context. */
  lists: number;
  /** Every page of a version's list, whatever it selects; `joined`, those joined to the renderings. */
  pages: number; joined: number;
  /** One row's large column: a run's JSON, a rendering's Markdown or an edit's result. */
  content: number;
  all: number;
};

/**
 * `storage` wrapped so that each statement is counted by kind as it runs: hand `storage` of
 * the answer to a store and to nothing else, so that what is counted is the store's.
 * - `counts()`: the statements so far, by kind. A PAGE is every page of a version's list,
 *   whatever it selects: a statement that reads `doc_seq` in the order of `seq` up to a bound
 *   limit, which every page of a list is and no other statement.
 * - `definitions()`: the largest sum of the lengths of the definitions one `lists` statement
 *   answered, as text.
 * - `ran()`: every distinct statement run through the wrapper, for a census that plans the
 *   store's statements and not a test's own reads of rows.
 * - `rowsRead()`: THE ROWS READ AS STORAGE BILLS THEM, the sum of each cursor's `rowsRead`,
 *   read once a cursor when its rows have been taken, or when its `rowsWritten` is read where
 *   they are not. The unit is a row of a table a statement steps to AND a row for every step
 *   of `json_each` or `json_tree`. A Durable Object's cursor says it; the Node tests' does
 *   not, so there the answer is 0.
 * - `rowsWritten()`: the rows written, the sum of each cursor's `rowsWritten`, read where
 *   `rowsRead` is: as storage bills them on a Durable Object, and the rows each statement
 *   changed on the Node tests' storage.
 * - `answered()`: THE ROWS ANSWERED TO THE ISOLATE, every row a `toArray()` or a `one()` gave.
 */
export function countedStorage(storage: RowsReadStorage) {
  let counts: StatementCounts = { styles: 0, lists: 0, pages: 0, joined: 0, content: 0, all: 0 };
  let ran = new Set<string>();
  let definitions = 0, rowsRead = 0, rowsWritten = 0, answered = 0;
  let counted: RowsReadStorage = {
    sql: {
      exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) {
        let cursor = storage.sql.exec<T>(query, ...bindings);
        ran.add(query);
        counts.all++;
        let lists = query.includes("json_each(doc_run.json, '$.lists')");
        if (lists) counts.lists++;
        if (query.includes("json_type(json, '$.lists')")) counts.styles++;
        if (/FROM doc_seq\b[^]*ORDER BY (doc_seq\.)?seq LIMIT \?/.test(query)) {
          counts.pages++;
          if (query.includes("LEFT JOIN doc_md")) counts.joined++;
        }
        if (/^SELECT (json|md|result) FROM/.test(query)) counts.content++;
        let billed = false;
        let bill = () => {
          if (billed) return;
          billed = true;
          rowsRead += cursor.rowsRead ?? 0;
          rowsWritten += cursor.rowsWritten;
        };
        return {
          toArray() {
            let rows = cursor.toArray();
            bill();
            answered += rows.length;
            if (lists) {
              definitions = Math.max(
                definitions, rows.reduce((sum, row) => sum + String(row.definition).length, 0));
            }
            return rows;
          },
          one() {
            let row = cursor.one();
            bill();
            answered++;
            return row;
          },
          get rowsWritten() {
            bill();
            return cursor.rowsWritten;
          },
        };
      },
    },
    transactionSync: callback => storage.transactionSync(callback),
  };
  return {
    storage: counted,
    counts: (): StatementCounts => ({ ...counts }),
    definitions: () => definitions,
    ran: () => [...ran],
    rowsRead: () => rowsRead,
    rowsWritten: () => rowsWritten,
    answered: () => answered,
  };
}

/**
 * The tables a statement scans, for a census of the statements a store ran (`ran()` of a
 * `countedStorage`): for each of `statements` but those that drop a table, the steps of its
 * plan that start `SCAN` and are not of a virtual table (`json_each`, `json_tree`), by the
 * statement with its white space folded; a statement with no such step is left out. A PLAN
 * NAMES A TABLE BY THE STATEMENT'S ALIAS, so no table's name is read here: a scan of `doc_run
 * AS run` plans as `SCAN run` and is answered like any other. A census asserts on what this
 * answers, never on a pattern of the tables' names.
 */
export function tableScans(
  storage: { plan(statement: string): string[] }, statements: readonly string[],
): Record<string, string[]> {
  let scans: Record<string, string[]> = {};
  for (let statement of statements) {
    if (statement.startsWith("DROP TABLE")) continue;
    let steps = storage.plan(statement)
      .filter(step => step.startsWith("SCAN") && !step.includes("VIRTUAL TABLE"));
    if (steps.length > 0) scans[statement.replace(/\s+/g, " ")] = steps;
  }
  return scans;
}

/**
 * Keeps a document of `tab` alone, cut to `sizes`, into `storage`, through a store of the
 * digest `digest`. Answers the storage it was handed, a `countedStorage` over it, the store
 * (which runs on the counted storage) and the base version of the tab.
 */
export function keptUnder<Storage extends RowsReadStorage>(
  storage: Storage, tab: GoogleDocsTab, digest: string, sizes?: RunSizes,
) {
  let counted = countedStorage(storage);
  let store = new DocStore(counted.storage, undefined, digest, sizes);
  let head = store.keep(
    "doc", wholeTabsFetched({ revision: "r1", fetchedAt: 1_000, tabs: [{ tab, writeMarkers: [] }] }, sizes),
    NONE);
  return { storage, counted, store, base: scenarioBase(store, "doc", head) };
}

/** Another store on `storage`, of the digest `digest`, its runs cut to `sizes` where given. */
export function under(storage: DocStoreStorage, digest: string, sizes?: RunSizes): DocStore {
  return new DocStore(storage, undefined, digest, sizes);
}

/** What `run` moved of the store's counters and of the statements `counted` counts. */
export function spent(counted: { counts(): StatementCounts }, run: () => unknown) {
  let cost = { ...docStoreCost };
  let before = counted.counts();
  run();
  let after = counted.counts();
  return {
    runsDecoded: docStoreCost.runsDecoded - cost.runsDecoded,
    runsRendered: docStoreCost.runsRendered - cost.runsRendered,
    runsKeyed: docStoreCost.runsKeyed - cost.runsKeyed,
    rowsWritten: docStoreCost.rowsWritten - cost.rowsWritten,
    styles: after.styles - before.styles, lists: after.lists - before.lists,
    pages: after.pages - before.pages, joined: after.joined - before.joined,
    content: after.content - before.content, all: after.all - before.all,
  };
}

/**
 * ONE SCENARIO FOR REAL STORAGE: a tab of 300 one-cell tables, each an item of a list of its
 * own (601 runs, two pages of its list, 300 lists), kept under one digest and its version
 * keyed again under another by a read of its summary. Answers the runs the version lists, the
 * pages of its list, THE JSON NODES OF ITS STORED RUNS and the lists its context defines (both
 * counted by the functions storage bills a row a step for, beneath the counter), and for the
 * keying alone the rows read and the statements by kind. No document leaves it.
 */
export function keyingRows(storage: RowsReadStorage) {
  let { base } = keptUnder(storage, listedTablesTab("t1", 300), "a");
  let counted = countedStorage(storage);
  under(counted.storage, "b").summary(base);
  let one = (query: string, ...bindings: unknown[]) =>
    Number(Object.values(storage.sql.exec(query, ...bindings).one())[0]);
  let runs = one("SELECT COUNT(*) AS runs FROM doc_seq WHERE version = ?", base.id);
  return {
    runs,
    pages: Math.ceil(runs / 500),
    nodes: one(
      `SELECT COUNT(*) AS nodes FROM doc_seq JOIN doc_run AS run ON run.doc = ?2 AND run.id = doc_seq.run,
         json_tree(run.json) AS tree WHERE doc_seq.version = ?1`, base.id, base.doc),
    lists: one(
      `SELECT COUNT(*) AS lists FROM doc_version
         JOIN doc_run ON doc_run.doc = doc_version.doc AND doc_run.id = doc_version.context,
         json_each(doc_run.json, '$.lists') WHERE doc_version.doc = ? AND doc_version.id = ?`,
      base.doc, base.id),
    rowsRead: counted.rowsRead(),
    counts: counted.counts(),
  };
}

// ---------------------------------------------------------------------------
// What a removal costs beside the other documents of a store
// ---------------------------------------------------------------------------

/** What one removal of `sweepCostScenario` cost. */
export type SweepCost = {
  /** Rows read and rows written, as `countedStorage` says them (no row read on the Node fake). */
  rowsRead: number; rowsWritten: number;
  /** The statements run, and the rows they answered to the isolate. */
  statements: number; answered: number;
};

/**
 * WHAT A REMOVAL COSTS IN A STORE THAT HOLDS OTHER DOCUMENTS: one store over `storage` keeps
 * `others` documents of one short paragraph each, one more such document (`small`) and one
 * document of THE MANY-RUN SHAPE (`tinyTablesTab("t1", pairs)`, `2 * pairs + 1` runs), and
 * answers what each of these cost, in order:
 * - `nothing`: a sweep of the many-run document that removes nothing;
 * - `rejection`: the sweep after a rejection: one edit made in the tab, swept with none pending;
 * - `approval`: the sweep of an approval's handoff: two edits pending, the second made in what
 *   the first gave, swept with the second alone;
 * - `trialChanged`: THE SWEEP of a trial of the document fetched changed in one run, with no
 *   edit pending, counted from where the trial's `use` returns;
 * - `trialFirst`: THE SWEEP of a trial of a many-run document of another text that has no
 *   stored copy and no root (nothing of it is live), counted the same way;
 * - `dropOther`: a drop of `small`; `dropLarge`: a drop of the many-run document.
 * Two calls that differ in `others` alone say whether a removal reads or writes a row for what
 * the store holds of other documents; two that differ in `pairs`, what grows with a tab's runs.
 */
export function sweepCostScenario(
  storage: RowsReadStorage, { others, pairs }: { readonly others: number; readonly pairs: number },
) {
  let counted = countedStorage(storage);
  let store = new DocStore(counted.storage);
  for (let at = 0; at < others; at++) {
    store.keep(`other-${at}`, scenarioCopy([scenarioTab("t1", [`Other ${at}`])]), NONE);
  }
  store.keep("small", scenarioCopy([scenarioTab("t1", ["Small"])]), NONE);
  store.keep("doc", scenarioCopy([tinyTablesTab("t1", pairs)]), NONE);
  let base = () => scenarioBase(store, "doc", store.head("doc")!);
  let reading = (): SweepCost => ({
    rowsRead: counted.rowsRead(), rowsWritten: counted.rowsWritten(),
    statements: counted.counts().all, answered: counted.answered(),
  });
  let since = (before: SweepCost): SweepCost => {
    let after = reading();
    return {
      rowsRead: after.rowsRead - before.rowsRead, rowsWritten: after.rowsWritten - before.rowsWritten,
      statements: after.statements - before.statements, answered: after.answered - before.answered,
    };
  };
  let cost = (run: () => void): SweepCost => {
    let before = reading();
    run();
    return since(before);
  };
  // The sweep that ends a trial of `tab` as document `doc`, whose `use` does nothing.
  let trialSweep = (doc: string, tab: GoogleDocsTab): SweepCost => {
    let before: SweepCost | undefined;
    store.trial(doc, scenarioCopy([tab], "r2"), () => NONE, () => {
      before = reading();
    });
    return since(before!);
  };

  let nothing = cost(() => store.sweep("doc", NONE));
  scenarioEdit(store, base(), "e1");
  let rejection = cost(() => store.sweep("doc", NONE));
  scenarioEdit(store, scenarioEdit(store, base(), "e1"), "e2");
  let approval = cost(() => store.sweep("doc", { edits: ["e2"], roots: [] }));
  let changed = pairs >> 1;
  let trialChanged = trialSweep(
    "doc", tinyTablesTab("t1", pairs, at => at === changed ? "changed" : `cell ${at}`));
  let trialFirst = trialSweep("first", tinyTablesTab("t1", pairs, at => `first ${at}`));
  let dropOther = cost(() => store.drop("small"));
  let dropLarge = cost(() => store.drop("doc"));
  return {
    runs: 2 * pairs + 1,
    nothing, rejection, approval, trialChanged, trialFirst, dropOther, dropLarge,
  };
}

/** The removals `sweepCostScenario` answers a cost for. */
export type SweepCase = Exclude<keyof ReturnType<typeof sweepCostScenario>, "runs">;

/**
 * The pairs of the many-run tab `sweepCostScenario` is run with, a table of two widths: a tab
 * of 4,001 runs, and in the wider run the tab of 19,601 runs too.
 */
export const SWEEP_COST_PAIRS: readonly number[] = WIDER ? [2_000, 9_800] : [2_000];

/**
 * THE STATEMENTS each removal of `sweepCostScenario` runs and THE ROWS THEY ANSWER TO THE
 * ISOLATE, on the Node fake and on a Durable Object's storage alike, WHATEVER THE TAB'S RUNS
 * AND WHATEVER ELSE THE STORE HOLDS: a sweep answers the copy's record, the live versions'
 * results and the dead versions' ids, and no row of a list; a drop answers none.
 */
export const SWEEP_COST: Record<SweepCase, Pick<SweepCost, "statements" | "answered">> = {
  nothing: { statements: 3, answered: 1 },
  rejection: { statements: 10, answered: 3 },
  approval: { statements: 10, answered: 4 },
  trialChanged: { statements: 9, answered: 2 },
  trialFirst: { statements: 7, answered: 1 },
  dropOther: { statements: 6, answered: 0 },
  dropLarge: { statements: 6, answered: 0 },
};

/**
 * THE ROWS each removal of `sweepCostScenario` is billed on a Durable Object's storage, by the
 * pairs of the many-run tab: `rowsRead` and `rowsWritten` in a store that holds no other
 * document, and `beside`, the rows read MORE where it holds two hundred (the rows written are
 * the same). `beside` is 6 at the most, and a removal is billed the same beside a thousand
 * other documents as beside two hundred (the workerd test holds both): it does not grow with
 * the documents stored. Which rows storage counts there is not established.
 * A sweep that removes a version reads each list of the document twice (once for the
 * renderings, once for the runs), searches a content row for each distinct name of the dead
 * lists, and reads each row of a dead list as it deletes it: at 19,601 runs a rejection is
 * billed 8.5 rows a run, and an approval's handoff that removes two versions 13.
 */
export const SWEEP_ROWS: Record<number, Record<SweepCase, {
  rowsRead: number; beside: number; rowsWritten: number;
}>> = {
  2_000: {
    nothing: { rowsRead: 5, beside: 0, rowsWritten: 0 },
    rejection: { rowsRead: 34_057, beside: 2, rowsWritten: 4_005 },
    approval: { rowsRead: 52_093, beside: 2, rowsWritten: 8_010 },
    trialChanged: { rowsRead: 34_053, beside: 2, rowsWritten: 4_004 },
    trialFirst: { rowsRead: 12_021, beside: 0, rowsWritten: 8_007 },
    dropOther: { rowsRead: 12, beside: 0, rowsWritten: 6 },
    dropLarge: { rowsRead: 12_013, beside: 6, rowsWritten: 8_008 },
  },
  9_800: {
    nothing: { rowsRead: 5, beside: 0, rowsWritten: 0 },
    rejection: { rowsRead: 166_659, beside: 0, rowsWritten: 19_605 },
    approval: { rowsRead: 254_895, beside: 0, rowsWritten: 39_210 },
    trialChanged: { rowsRead: 166_655, beside: 0, rowsWritten: 19_604 },
    trialFirst: { rowsRead: 58_821, beside: 0, rowsWritten: 39_207 },
    dropOther: { rowsRead: 11, beside: 1, rowsWritten: 6 },
    dropLarge: { rowsRead: 58_813, beside: 6, rowsWritten: 39_208 },
  },
};

// ---------------------------------------------------------------------------
// What a keep costs a connection at its caps
// ---------------------------------------------------------------------------

/** What one keep of `capCostScenario` cost, and how many copies it evicted. */
export type CapCost = SweepCost & { evicted: number };

/**
 * WHAT A KEEP COSTS A CONNECTION AT ITS CAP OF 200 DOCUMENTS: one store over `storage` keeps
 * 196 one-paragraph documents, a document of prose cut a paragraph a run (300 runs) whose
 * approval is the oldest, and one of THE MANY-RUN SHAPE (`tinyTablesTab("t1", pairs)`,
 * `2 * pairs + 1` runs) whose approval is the next. Each keep below is of ONE MORE
 * one-paragraph document the store does not hold, so the five differ only in what the caps
 * add. In order:
 * - `plain`: `DocStore.keep` itself, with no limits, which brings the store to 199 documents;
 * - `nothing`: the connection's keep (`DriveDocCopyLimits.keep`, under the connection's own
 *   caps) that brings the store to 200 documents and evicts nothing;
 * - `prose`: the connection's keep that brings 200 documents to 201 and evicts the prose;
 * - `manyRuns`: the next, which evicts the many-run document;
 * - `fifty`: one under a cap of bytes that 151 one-paragraph documents fill, which evicts
 *   fifty of them at once.
 * Answers each one's cost, the runs of the two larger documents and the copies the store
 * holds after each of the connection's keeps.
 */
export function capCostScenario(storage: RowsReadStorage, { pairs }: { readonly pairs: number }) {
  let counted = countedStorage(storage);
  let store = new DocStore(counted.storage);
  let paragraph = (at: number) => scenarioCopy([scenarioTab("t1", [`Other ${String(at).padStart(3, "0")}`])]);
  let hour = (at: number) => ({ at: at * DOC_COPY_APPROVAL_GRAIN_MS });
  let evicted = 0;
  let limits = (caps?: { count: number; bytes: number }) => new DriveDocCopyLimits({
    store: () => store, pendingDocs: () => new Set(), removed: () => { evicted++; },
    ...(caps ? { caps } : {}),
    // No keep asks the KV anything.
    kv: { get: () => undefined, put() {} },
  });
  let cost = (run: () => void): CapCost => {
    let before = {
      rowsRead: counted.rowsRead(), rowsWritten: counted.rowsWritten(),
      statements: counted.counts().all, answered: counted.answered(), evicted,
    };
    run();
    return {
      rowsRead: counted.rowsRead() - before.rowsRead,
      rowsWritten: counted.rowsWritten() - before.rowsWritten,
      statements: counted.counts().all - before.statements,
      answered: counted.answered() - before.answered,
      evicted: evicted - before.evicted,
    };
  };
  let listed = () => store.copies().length;

  let others = MAX_DRIVE_DOC_COPIES - 4;
  let prose = scenarioCopy([proseTab("t1", 300)], "r1", RUNS_OF_THREE);
  store.keep("prose", prose, NONE, hour(1));
  store.keep("many", scenarioCopy([tinyTablesTab("t1", pairs)]), NONE, hour(2));
  for (let at = 0; at < others; at++) store.keep(`other-${at}`, paragraph(at), NONE, hour(10 + at));
  let { bytes: one } = store.head("other-0")!;
  let proseRuns = Number(storage.sql.exec<{ runs: number }>(
    "SELECT COUNT(*) AS runs FROM doc_seq WHERE version = ?", store.head("prose")!.versions[0]).one().runs);

  let plain = cost(() => store.keep("more-0", paragraph(900), NONE, hour(900)));
  let nothing = cost(() => limits().keep("more-1", paragraph(901), NONE, hour(901)));
  let copies = [listed()];
  let evictsProse = cost(() => limits().keep("more-2", paragraph(902), NONE, hour(902)));
  copies.push(listed());
  let evictsMany = cost(() => limits().keep("more-3", paragraph(903), NONE, hour(903)));
  copies.push(listed());
  let fifty = cost(() => limits({ count: Infinity, bytes: 151.5 * one })
    .keep("more-4", paragraph(904), NONE, hour(904)));
  copies.push(listed());
  return {
    runs: 2 * pairs + 1, proseRuns, copies,
    plain, nothing, prose: evictsProse, manyRuns: evictsMany, fifty,
  };
}

/** The keeps `capCostScenario` answers a cost for. */
export type CapCase = "plain" | "nothing" | "prose" | "manyRuns" | "fifty";

/**
 * The pairs of the many-run tab `capCostScenario` is run with, a table of two widths: a tab
 * of 4,001 runs, and in the wider run the tab of 19,601 runs.
 */
export const CAP_COST_PAIRS: readonly number[] = WIDER ? [2_000, 9_800] : [2_000];

/**
 * THE STATEMENTS each keep of `capCostScenario` runs, THE ROWS THEY ANSWER TO THE ISOLATE and
 * the copies it evicts, on the Node fake and on a Durable Object's storage alike, WHATEVER
 * THE RUNS OF THE DOCUMENT EVICTED: the caps add one statement that answers a row a copy,
 * and six statements that answer nothing for each copy evicted.
 */
export const CAP_COST: Record<CapCase, Pick<CapCost, "statements" | "answered" | "evicted">> = {
  // The keep itself answers one row: the digest the copy stored before was swept under.
  plain: { statements: 15, answered: 1, evicted: 0 },
  nothing: { statements: 16, answered: 1 + 200, evicted: 0 },
  prose: { statements: 16 + 6, answered: 1 + 201, evicted: 1 },
  manyRuns: { statements: 16 + 6, answered: 1 + 201, evicted: 1 },
  fifty: { statements: 16 + 50 * 6, answered: 1 + 201, evicted: 50 },
};

/**
 * THE ROWS each keep of `capCostScenario` is billed on a Durable Object's storage, whatever
 * the pairs of the many-run tab; the keep that evicts that tab is billed these of `plain`,
 * a row a copy listed and what a drop of the tab is billed (`SWEEP_ROWS`, `dropLarge` beside
 * other documents). Beyond the keep itself (`plain`), the caps read ONE ROW A COPY (200 and
 * then 201), and an eviction is billed what its deletes are: for the prose of 300 runs, the
 * 903 rows it held and a row for each row of its list as the list's delete finds it; for
 * fifty one-paragraph documents, six rows written and seventeen read each.
 */
export const CAP_ROWS: Record<Exclude<CapCase, "manyRuns">, { rowsRead: number; rowsWritten: number }> = {
  plain: { rowsRead: 6, rowsWritten: 9 },
  nothing: { rowsRead: 6 + 200, rowsWritten: 9 },
  prose: { rowsRead: 6 + 201 + 1_208, rowsWritten: 9 + 903 },
  fifty: { rowsRead: 6 + 201 + 849, rowsWritten: 9 + 50 * 6 },
};

// ---------------------------------------------------------------------------
// What a connection's expiry pass costs
// ---------------------------------------------------------------------------

/**
 * What one call of `expiryCostScenario` cost: the copies it removed, the keys it read and
 * wrote in the connection's KV, and the milliseconds it took by the scenario's clock, which
 * are reported and never pinned.
 */
export type ExpiryCost = SweepCost & { removed: number; kvReads: number; kvWrites: number; ms: number };

/**
 * WHAT THE EXPIRY PASS COSTS A CONNECTION AT ITS CAP OF 200 DOCUMENTS: one store over
 * `storage` keeps 200 one-paragraph documents, their last approved read a day after the
 * clock's start, and one `DriveDocCopyLimits` passes over it on a clock the scenario moves.
 * In order:
 * - `none`: the pass six days on, which reads the 200 records and removes none;
 * - `inside`: a call in the hour of that pass, which asks nothing of storage or of the KV;
 * - `two`: with a document of prose cut a paragraph a run (300 runs) and one of THE MANY-RUN
 *   SHAPE (`tinyTablesTab("t1", pairs)`, `2 * pairs + 1` runs) kept as approved at the clock's
 *   start, the pass seven days on, which removes those two and leaves the 200;
 * - `all`: the pass eight days on, which removes all 200.
 * Answers each one's cost, the runs of the two larger documents, the copies the store holds
 * after each call and the hour the KV names at the end.
 * @param options.clock What the milliseconds are read from. Defaults to `performance.now`.
 */
export function expiryCostScenario(
  storage: RowsReadStorage,
  { pairs, clock = () => performance.now() }: { readonly pairs: number; readonly clock?: () => number },
) {
  let counted = countedStorage(storage);
  let store = new DocStore(counted.storage);
  let hour = DOC_COPY_APPROVAL_GRAIN_MS, day = 24 * hour;
  let now = 0, removed = 0, kvReads = 0, kvWrites = 0;
  let keys = new Map<string, unknown>();
  let limits = new DriveDocCopyLimits({
    store: () => store, pendingDocs: () => new Set(), removed: () => { removed++; },
    kv: {
      get: <T>(key: string) => { kvReads++; return keys.get(key) as T | undefined; },
      put: (key, value) => { kvWrites++; keys.set(key, value); },
    },
    now: () => now,
  });
  let pass = (at: number): ExpiryCost => {
    now = at;
    let before = {
      rowsRead: counted.rowsRead(), rowsWritten: counted.rowsWritten(),
      statements: counted.counts().all, answered: counted.answered(), removed, kvReads, kvWrites,
    };
    let began = clock();
    limits.expire();
    let ms = clock() - began;
    return {
      rowsRead: counted.rowsRead() - before.rowsRead,
      rowsWritten: counted.rowsWritten() - before.rowsWritten,
      statements: counted.counts().all - before.statements,
      answered: counted.answered() - before.answered,
      removed: removed - before.removed,
      kvReads: kvReads - before.kvReads, kvWrites: kvWrites - before.kvWrites, ms,
    };
  };
  let listed = () => store.copies().length;

  for (let at = 0; at < MAX_DRIVE_DOC_COPIES; at++) {
    store.keep(`other-${at}`, scenarioCopy([scenarioTab("t1", [`Other ${at}`])]), NONE, { at: day });
  }
  let none = pass(6 * day + 30 * 60_000);
  let inside = pass(6 * day + 59 * 60_000);
  let copies = [listed()];
  store.keep("prose", scenarioCopy([proseTab("t1", 300)], "r1", RUNS_OF_THREE), NONE, { at: 0 });
  store.keep("many", scenarioCopy([tinyTablesTab("t1", pairs)]), NONE, { at: 59 * 60_000 });
  let proseRuns = Number(storage.sql.exec<{ runs: number }>(
    "SELECT COUNT(*) AS runs FROM doc_seq WHERE version = ?", store.head("prose")!.versions[0]).one().runs);
  let two = pass(7 * day);
  copies.push(listed());
  let all = pass(8 * day);
  copies.push(listed());
  return {
    runs: 2 * pairs + 1, proseRuns, copies, passed: keys.get(DOC_COPY_EXPIRY_PASS_KEY),
    none, inside, two, all,
  };
}

/** The calls `expiryCostScenario` answers a cost for. */
export type ExpiryCase = "none" | "inside" | "two" | "all";

/**
 * The pairs of the many-run tab `expiryCostScenario` is run with, a table of two widths: a
 * tab of 4,001 runs, and in the wider run the tab of 19,601 runs.
 */
export const EXPIRY_COST_PAIRS: readonly number[] = WIDER ? [2_000, 9_800] : [2_000];

/**
 * THE STATEMENTS each call of `expiryCostScenario` runs, THE ROWS THEY ANSWER TO THE ISOLATE,
 * the copies it removes and the keys it reads and writes, on the Node fake and on a Durable
 * Object's storage alike, WHATEVER THE RUNS OF A DOCUMENT REMOVED: a pass is one statement
 * that answers a row a copy and six statements that answer nothing for each copy removed,
 * and it writes one key; the activation's first reads that key; a call inside the hour of a
 * pass does nothing.
 */
export const EXPIRY_COST: Record<ExpiryCase, Omit<ExpiryCost, "rowsRead" | "rowsWritten" | "ms">> = {
  none: { statements: 1, answered: 200, removed: 0, kvReads: 1, kvWrites: 1 },
  inside: { statements: 0, answered: 0, removed: 0, kvReads: 0, kvWrites: 0 },
  two: { statements: 1 + 2 * 6, answered: 202, removed: 2, kvReads: 0, kvWrites: 1 },
  all: { statements: 1 + 200 * 6, answered: 200, removed: 200, kvReads: 0, kvWrites: 1 },
};

/**
 * THE ROWS each call of `expiryCostScenario` is billed on a Durable Object's storage,
 * whatever the pairs of the many-run tab: a pass reads ONE ROW A COPY and writes none; the
 * pass that removes all 200 one-paragraph documents is billed the 200 records and what 200
 * drops are (six rows written each, and about seventeen read, fewer as the store empties).
 * The pass that removes the prose and the many-run document is billed a row a copy and what
 * a drop of each is (`EXPIRY_PROSE_DROP`; `SWEEP_ROWS`, `dropLarge` beside other documents).
 */
export const EXPIRY_ROWS: Record<Exclude<ExpiryCase, "two">, { rowsRead: number; rowsWritten: number }> = {
  none: { rowsRead: 200, rowsWritten: 0 },
  inside: { rowsRead: 0, rowsWritten: 0 },
  all: { rowsRead: 200 + 3_393, rowsWritten: 200 * 6 },
};

/**
 * What a drop of the scenarios' prose of 300 runs is billed beside other documents: the 903
 * rows it held, and a row for each row of its list as the list's delete finds it (the same
 * drop `CAP_ROWS` bills its eviction).
 */
export const EXPIRY_PROSE_DROP = { rowsRead: 1_208, rowsWritten: 903 };

// ---------------------------------------------------------------------------
// What an edit costs, case by case
// ---------------------------------------------------------------------------

/** What one case of `editCountsScenario` cost and gave. */
export type EditCost = {
  runsDecoded: number; viewWidenings: number; runsRendered: number; tabClones: number;
  /** The runs after the slice whose key was worked out again: 0 where the carry did not move. */
  runsKeyed: number;
  /** The most bytes of run JSON in hand at once during the case (`peakRunBytesInHand`). */
  peak: number;
  /** Rows as storage counts them: the fake counts a changed row once and reads none. */
  rowsWritten: number; rowsRead: number;
  /**
   * For a case the scenario makes at a place it chose: the place of the slice's first run in
   * the list, its runs, the lists they name and the runs cut of them, which are the terms the
   * rows it reads are a formula in.
   */
  at?: { place: number; runs: number; named: number; cut: number };
  /** The runs the child lists, and how many of them the parent lists under the same id. */
  listed: number; shared: number;
  /** Whether the child read back (`store.tab`, `store.markdown`) is the whole-tab model's. */
  same: boolean;
  /** Whether the sweep after the case left the rows the kept tab had. */
  restored: boolean;
  /** The refusal's text, for a case whose batch is refused. */
  refused?: string;
};

/** A tab of `editCountsScenario` in the units rows are read in. */
export type EditTab = {
  /** The runs the kept version lists, and the pages of its list (500 runs a page). */
  runs: number; pages: number;
  /** The JSON nodes of its stored runs, of those of its list's first page, and of its largest run. */
  nodes: number; firstPage: number; largestRun: number;
  /** The lists its context defines. */
  lists: number;
};

const BULLETED = "BULLET_DISC_CIRCLE_SQUARE";

/**
 * ONE EDIT AT A TIME ON A TAB OF 20,000 PARAGRAPHS, on the fake and on real storage alike:
 * the tab is `Line 00000.` and on, with a 1x1 table before the paragraphs at 5,000, 10,000
 * and 15,000 (`linesWithTablesTab`), kept under the store's sizes; beside it, each under a
 * document of its own, `tinyTablesTab("t2", 200)` (the shape of many runs) and
 * `listedTablesTab("t3", 300)` (a list a table). The store runs on a `countedStorage` over
 * `storage`; each case is made with nothing of its tab in hand (`docEditResult` for an edit
 * the builders build, which reads what it asks of the tab as a whole from stored rows and
 * builds from the piece around the edit; `editedSlice` and `DocStore.putSlice` for a batch
 * written by hand), and the store's counters are read around that call alone. What the
 * scenario reads for itself (a list's sizes, a table as it reads, the child read back, the
 * tabs' nodes) goes through a store and statements BENEATH the counter, so it is counted in
 * no case. After each case the document is swept, as a rejection sweeps it.
 *
 * Answers `n`, the runs of the tab of lines; `cases`, by name; and `tabs`, each tab in the
 * units rows are read in. The child of a case is compared here with `applyDocsRequests` on
 * the tab in hand, and the answer is a boolean: no document leaves the scenario.
 */
export function editCountsScenario(storage: RowsReadStorage) {
  let counted = countedStorage(storage);
  let store = new DocStore(counted.storage);
  // The scenario's own reads: beneath the counter.
  let beneath = new DocStore(storage);
  let rows = <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) =>
    storage.sql.exec<T>(query, ...bindings).toArray();
  let one = (query: string, ...bindings: unknown[]) =>
    Number(Object.values(storage.sql.exec(query, ...bindings).one())[0]);
  let runsOf = ({ id }: DocVersion) =>
    rows<{ run: string }>("SELECT run FROM doc_seq WHERE version = ? ORDER BY seq", id)
      .map(({ run }) => run);

  /** A tab kept under a document of its own: its base version, and where its runs stand. */
  type Kept = {
    doc: string; tab: GoogleDocsTab; base: DocVersion; runs: string[];
    /** The first index of each run, and after them where the body ends. */
    starts: number[];
  };
  let keep = (doc: string, tab: GoogleDocsTab, through = beneath): Kept => {
    let base = scenarioBase(through, doc, through.keep(doc, scenarioCopy([tab]), NONE));
    let sizes = rows<{ size: number }>(
      "SELECT size FROM doc_seq WHERE version = ? ORDER BY seq", base.id);
    let starts = [base.bodyEndIndex - sizes.reduce((sum, { size }) => sum + size, 0)];
    for (let { size } of sizes) starts.push(starts.at(-1)! + size);
    return { doc, tab, base, runs: runsOf(base), starts };
  };
  /** The place of the run of `kept` that holds `index`. */
  let placeOf = ({ starts }: Kept, index: number) => starts.findLastIndex(start => start <= index);
  // What a tab is in the units rows are read in: the test's own reads, counted nowhere.
  let unitsOf = ({ base }: Kept): EditTab => {
    let nodes = rows<{ nodes: number }>(
      `SELECT COUNT(*) AS nodes FROM doc_seq JOIN doc_run AS run ON run.doc = ?2 AND run.id = doc_seq.run,
         json_tree(run.json) AS tree WHERE doc_seq.version = ?1 GROUP BY doc_seq.seq
         ORDER BY doc_seq.seq`, base.id, base.doc);
    return {
      runs: nodes.length, pages: Math.ceil(nodes.length / 500),
      nodes: nodes.reduce((sum, row) => sum + row.nodes, 0),
      firstPage: nodes.slice(0, 500).reduce((sum, row) => sum + row.nodes, 0),
      largestRun: Math.max(...nodes.map(row => row.nodes)),
      lists: one(
        `SELECT COUNT(*) AS lists FROM doc_version
         JOIN doc_run ON doc_run.doc = doc_version.doc AND doc_run.id = doc_version.context,
           json_each(doc_run.json, '$.lists') WHERE doc_version.doc = ? AND doc_version.id = ?`,
        base.doc, base.id),
    };
  };

  let cases: Record<string, EditCost> = {};
  /** What `run` moved of the counters, with the peak from 0. */
  let measured = <T>(run: () => T) => {
    let before = { ...docStoreCost };
    let clones = replayCost.tabClones, read = counted.rowsRead();
    docStoreCost.peakRunBytesInHand = 0;
    let value = run();
    return {
      value,
      cost: {
        runsDecoded: docStoreCost.runsDecoded - before.runsDecoded,
        viewWidenings: docStoreCost.viewWidenings - before.viewWidenings,
        runsRendered: docStoreCost.runsRendered - before.runsRendered,
        tabClones: replayCost.tabClones - clones,
        runsKeyed: docStoreCost.runsKeyed - before.runsKeyed,
        peak: docStoreCost.peakRunBytesInHand,
        rowsWritten: docStoreCost.rowsWritten - before.rowsWritten,
        rowsRead: counted.rowsRead() - read,
      },
    };
  };
  let sameCounts = (before: Record<string, number>) =>
    JSON.stringify(tableCounts(storage)) === JSON.stringify(before);
  let sortedLists = (tab: GoogleDocsTab) =>
    JSON.stringify(Object.entries(tab.lists).toSorted(([a], [b]) => a < b ? -1 : 1));
  /** Whether `child` reads back as `requests` applied to the tab in hand by the whole-tab model. */
  let readsAs = (kept: Kept, child: DocVersion, requests: readonly GoogleDocsRequest[]) => {
    let reference = requests.length === 0 ? kept.tab : applyDocsRequests(kept.tab, requests);
    let tab = beneath.tab(child);
    return JSON.stringify(tab.body.content) === JSON.stringify(reference.body.content) &&
      sortedLists(tab) === sortedLists(reference) &&
      beneath.markdown(child) === docTabToMarkdown(reference).markdown &&
      child.bodyEndIndex === (reference.body.content.at(-1)?.endIndex ?? 0);
  };
  /**
   * One case: `make` is measured, the version it gives compared with the whole-tab model's
   * for the requests it answers, and the document swept. `between` runs before the sweep.
   * `at`, where the case names its place: the slice's first place, its runs and their lists.
   */
  let record = (
    name: string, kept: Kept,
    make: () => { child: DocVersion; requests: readonly GoogleDocsRequest[] },
    at?: { place: number; runs: number; named: number },
    between?: (child: DocVersion) => void,
  ) => {
    let before = tableCounts(storage);
    let { value: { child, requests }, cost } = measured(make);
    let listed = runsOf(child);
    let parent = new Set(kept.runs);
    let same = readsAs(kept, child, requests);
    between?.(child);
    beneath.sweep(kept.doc, NONE);
    cases[name] = {
      ...cost,
      ...(at ? { at: { ...at, cut: listed.length - (kept.runs.length - at.runs) } } : {}),
      listed: listed.length, shared: listed.filter(run => parent.has(run)).length,
      same, restored: sameCounts(before),
    };
  };
  /** A case of an edit the builders build, from the piece of the version around it. */
  let byEdit = (
    name: string, kept: Kept, edit: DocEdit, at?: { place: number; runs: number; named: number },
    between?: (child: DocVersion) => void,
  ) => record(name, kept, () => {
    let made = docEditResult(store, kept.base, edit);
    return { child: made.after, requests: made.requests };
  }, at, between);
  /** A case of a batch written by hand, through the loop the source uses. */
  let byHand = (name: string, kept: Kept, requests: readonly GoogleDocsRequest[]) =>
    record(name, kept, () => {
      let { slice, made } = editedSlice(store, kept.base, "byHand", requests);
      return { child: store.putSlice(slice, made), requests };
    });

  // THE TAB OF LINES. A line is 12 indexes with its line break and a table 11, so where each
  // stands follows from its place; a run's first and last line are read off the list's sizes.
  const TABLES_AT = [5_000, 10_000, 15_000];
  let lines = Array.from({ length: 20_000 }, (_, at) => `Line ${String(at).padStart(5, "0")}.`);
  let digits = (at: number) => String(at).padStart(5, "0");
  let kept = keep("doc", linesWithTablesTab("t1", lines, TABLES_AT));
  let lineStart = (at: number) => 1 + 12 * at + 11 * TABLES_AT.filter(place => place <= at).length;
  let tableStart = (table: number) => lineStart(TABLES_AT[table]) - 11;
  let lineAt = (index: number) => {
    for (let tables = 0; tables <= TABLES_AT.length; tables++) {
      let at = (index - 1 - 11 * tables) / 12;
      if (Number.isInteger(at) && lineStart(at) === index) return at;
    }
    throw new Error(`No line starts at index ${index}.`);
  };
  let insert = (index: number, text: string): GoogleDocsRequest =>
    ({ insertText: { location: { index, tabId: "t1" }, text } });
  let remove = (startIndex: number, endIndex: number): GoogleDocsRequest =>
    ({ deleteContentRange: { range: { startIndex, endIndex, tabId: "t1" } } });
  let bullets = (startIndex: number, endIndex: number): GoogleDocsRequest =>
    ({ createParagraphBullets: { range: { startIndex, endIndex, tabId: "t1" }, bulletPreset: BULLETED } });
  /** The identity of table `table` of a kept tab, as a change to it records it. */
  let expectedOf = (of: Kept, table: number) => {
    // Rendered beneath the counter, and let go with this call.
    let piece = storedTabReading(beneath, of.base).piece({ table });
    let { mdStart, mdEnd } = piece.sourceMap.tables[table - piece.part!.tablesBefore];
    return tableIdentity(piece.markdown.slice(mdStart, mdEnd));
  };

  // A run of prose in the middle of the tab, far from a table: its place, its first index, its
  // first and its last line, and a line in its middle.
  let prose = placeOf(kept, lineStart(7_000));
  let start = kept.starts[prose];
  let first = lineAt(start), last = lineAt(kept.starts[prose + 1]) - 1;
  let middle = first + Math.floor((last - first) / 2);
  // The middle table, alone in its run between two runs of prose.
  let table = placeOf(kept, tableStart(1));
  let expected = expectedOf(kept, 1);
  let at = (place: number, runs = 1, named = 0) => ({ place, runs, named });

  let middleEdit: DocEdit = { type: "replaceText", oldMarkdown: lines[middle], newMarkdown: "Changed." };
  byEdit("middle", kept, middleEdit, at(prose), child => {
    // A pending read of the version the edit gave, before it is swept.
    let read = measured(() => [store.markdown(child), store.summary(child).markdownLength] as const);
    cases.pendingRead = {
      ...read.cost, listed: 0, shared: 0, restored: false,
      same: read.value[0] === beneath.markdown(child) && read.value[1] === read.value[0].length,
    };
  });
  let { at: where, listed, shared, restored } = cases.middle;
  cases.pendingRead = { ...cases.pendingRead, at: where, listed, shared, restored };

  // Table changes, on the table in the middle.
  byEdit("cellStyle", kept, {
    type: "setTableCellStyle", row: 0, column: 0, rows: 1, columns: 1,
    style: { background: "#ffcc00" }, expected,
  }, at(table));
  byEdit("rowNoText", kept, { type: "insertTableRows", at: 1, cells: [[""]], expected }, at(table));
  // The builders' own batches, written front to back.
  byEdit("rowWithText", kept, { type: "insertTableRows", at: 1, cells: [["added"]], expected }, at(table));
  byEdit(
    "columnWithText", kept, { type: "insertTableColumns", at: 1, cells: [["added"]], expected },
    at(table));
  byEdit("growingBeforeTable", kept, {
    type: "replaceText", oldMarkdown: lines[TABLES_AT[1] - 1], newMarkdown: "G".repeat(45),
  }, at(table - 1));
  byEdit("append", kept, { type: "appendText", markdown: "More" }, at(kept.runs.length - 1));
  byEdit("tableFilled", kept, { type: "insertTable", rows: 1, columns: 2, cells: [["a", "b"]] });
  byEdit("listItems", kept, {
    type: "replaceText", oldMarkdown: lines[middle + 1], newMarkdown: "- one\n- two",
  }, at(prose));
  byEdit("tableAfterParagraph", kept, {
    type: "insertTable", rows: 1, columns: 1, cells: [["new"]], after: lines[middle],
  }, at(prose));
  byHand("tableRemoved", kept, [remove(tableStart(1), tableStart(1) + 11)]);

  // At a run's first and last element.
  byEdit("firstParagraph", kept, {
    type: "replaceText", oldMarkdown: digits(first), newMarkdown: "first",
  }, at(prose));
  byEdit("runStart", kept, {
    type: "replaceText", oldMarkdown: lines[first], newMarkdown: "Changed.",
  }, at(prose));
  byEdit("lastShorter", kept, {
    type: "replaceText", oldMarkdown: digits(last), newMarkdown: "x",
  }, at(prose));
  byEdit("lastLonger", kept, {
    type: "replaceText", oldMarkdown: digits(last), newMarkdown: "a longer text",
  }, at(prose));
  byHand("joinAcross", kept, [remove(lineStart(last + 1) - 1, lineStart(last + 1))]);

  // A bulleted range at a run's start, and one index past it.
  byEdit("bulletAtRunStart", kept, {
    type: "replaceText", oldMarkdown: lines[first], newMarkdown: `- ${lines[first]}`,
  });
  byHand("bulletInsideFirst", kept, [bullets(start + 1, start + 3)]);
  byHand("bulletMovedOntoFirst", kept, [remove(start, start + 12), bullets(start + 1, start + 3)]);

  // What a widening takes where earlier requests moved the indexes: the run before the middle
  // table, the table and the run after it.
  let before = table - 1;
  let inBefore = lineStart(lineAt(kept.starts[before]) + 1) + 1;
  let inAfter = lineStart(TABLES_AT[1] + 5) + 1;
  byHand("longInsertion", kept, [
    insert(inBefore, "x".repeat(100_000)), insert(inAfter + 100_000, "y"),
  ]);
  // A deletion across paragraphs of the run before the table, longer than the table.
  let deleted = Math.min(500, kept.starts[table] - inBefore - 13);
  byHand("deletionThenPast", kept, [
    remove(inBefore, inBefore + deleted), insert(inAfter - deleted, "y"),
  ]);

  // A refused batch that widens: a bulleted range one index past the last run's first index,
  // then the deletion of the tab's final line break, which Google refuses.
  {
    let end = kept.base.bodyEndIndex, lastStart = kept.starts.at(-2)!;
    let requests = [bullets(lastStart + 1, lastStart + 3), remove(end - 1, end)];
    let counts = tableCounts(storage);
    let refusedBy = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        if (error instanceof DocModelError) return error.message;
        throw error;
      }
      return undefined;
    };
    let { value: refused, cost } = measured(
      () => refusedBy(() => editedSlice(store, kept.base, "byHand", requests)));
    let whole = refusedBy(() => applyDocRequests(kept.tab, "byHand", requests));
    cases.refusedWidens = {
      ...cost, listed: 0, shared: 0, same: refused !== undefined && refused === whole,
      restored: sameCounts(counts), ...(refused === undefined ? {} : { refused }),
    };
  }

  // A span of runs: text selected across N of them and replaced, and a range styled across
  // five that changes text in none.
  let span = placeOf(kept, lineStart(1_000));
  for (let runs of [3, 5]) {
    let from = kept.starts[span + 1] - 3, to = kept.starts[span + runs - 1] + 3;
    byHand(`span${runs}`, kept, [remove(from, to), insert(from, "Joined")]);
  }
  byHand("styleSpan5", kept, [{
    updateParagraphStyle: {
      range: { startIndex: kept.starts[span] + 1, endIndex: kept.starts[span + 4] + 3, tabId: "t1" },
      paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType",
    },
  }]);

  // THE SHAPE OF MANY RUNS: a row added with 500 characters to the hundredth table.
  let tables = keep("doc-tables", tinyTablesTab("t2", 200));
  byEdit("rowManyRuns", tables, {
    type: "insertTableRows", at: 1, cells: [["x".repeat(500)]], expected: expectedOf(tables, 99),
  }, at(1 + 2 * 99));

  // A LIST A TABLE: the piece around the 150th table, and a replacement in that table's cell.
  let listedTab = keep("doc-listed", listedTablesTab("t3", 300));
  {
    let counts = tableCounts(storage);
    let whole = docTabToMarkdown(listedTab.tab);
    let piece = measured(() => storedTabReading(store, listedTab.base).piece({ table: 149 }));
    let { markdown, part } = piece.value;
    cases.listedPiece = {
      ...piece.cost, listed: listedTab.runs.length, shared: listedTab.runs.length,
      // The piece reads as the same part of the tab rendered whole, and holds the table.
      same: part !== undefined && markdown.includes("cell 149") &&
        whole.markdown.slice(part.mdStart, part.mdStart + markdown.length) === markdown,
      restored: sameCounts(counts),
    };
  }
  byEdit("listedMiddle", listedTab, {
    type: "replaceText", oldMarkdown: "cell 149", newMarkdown: "cell changed", inTable: true,
  }, at(1 + 2 * 149, 1, 1));

  // THE FIRST EDIT AFTER A DEPLOY: the tab of lines kept again, under another document, by a
  // store of another digest; then, through the store of this one, the question whether the
  // model follows it and the edit of one paragraph.
  let deployed = keep("doc-deploy", kept.tab, under(storage, "another"));
  record("afterDeploy", deployed, () => {
    store.unindexed(deployed.base);
    let made = docEditResult(store, deployed.base, middleEdit);
    return { child: made.after, requests: made.requests };
  }, at(prose));

  // The same on the tab that defines lists, whose runs' values a pass that renders every run
  // reads: the first edit after a deploy reads them twice.
  let listedDeployed = keep("doc-listed-deploy", listedTab.tab, under(storage, "another"));
  record("listedAfterDeploy", listedDeployed, () => {
    store.unindexed(listedDeployed.base);
    let made = docEditResult(store, listedDeployed.base, {
      type: "replaceText", oldMarkdown: "cell 149", newMarkdown: "cell changed", inTable: true,
    });
    return { child: made.after, requests: made.requests };
  }, at(1 + 2 * 149, 1, 1));

  return {
    n: kept.runs.length, cases,
    tabs: { lines: unitsOf(kept), tables: unitsOf(tables), listed: unitsOf(listedTab) },
  };
}

const N = 138;
/**
 * The runs the piece around a table decodes and renders where a table and an empty paragraph
 * alternate, each a run (the tab of a list a table, and the shape of many runs).
 */
const PIECE_OF_LISTED = 1 + 2 + 3 + 5 + 9;
/**
 * The runs the piece around a table of the tab of lines decodes and renders. The table is a
 * run of its own between two runs of prose: tried from the table's run (1 run, which says
 * the closure goes on before it), and made again from the run before, to which the table's
 * run and the run after it are added (3).
 */
const PIECE_OF_TABLE = 1 + 3;
/** A case of `EDIT_COUNTS`: no copy, no later run keyed, the whole-tab model's result, swept clean. */
const editCase = (
  runsDecoded: number, viewWidenings: number, runsRendered: number, listed: number, shared: number,
  more: Partial<EditCost> = {},
): Omit<EditCost, "rowsWritten" | "rowsRead" | "peak"> => ({
  runsDecoded, viewWidenings, runsRendered, tabClones: 0, runsKeyed: 0, listed, shared,
  same: true, restored: true, ...more,
});

/**
 * What each case of `editCountsScenario` answers, on the fake and on real storage alike: every
 * field but the rows written and read, which each storage counts its own way, and the peak,
 * which is held to a bound. The tab of lines is `N` runs (138). A TEXT EDIT (a replacement,
 * an append) decodes and renders the runs of its piece, the closure of its own elements,
 * and the model's slice takes those runs as they were decoded; A TABLE CHANGE does the same
 * with the piece around its table, or around the place a new table goes; a batch written by
 * hand (`editedSlice`) has no piece and decodes its slice.
 */
export const EDIT_COUNTS: Record<string, Omit<EditCost, "rowsWritten" | "rowsRead" | "peak">> = {
  // A replacement inside one paragraph in the middle of a run: its closure (the paragraph and
  // two on each side) stands in that run, which is decoded once, for the piece, and taken
  // by the slice. Rendered: the run for the piece, and the one run cut from the slice. The
  // child lists every other run by the id it had.
  middle: editCase(1, 0, 1 + 1, N, N - 1, { at: { place: 48, runs: 1, named: 0, cut: 1 } }),
  // The Markdown and the summary of the version that edit gave: every rendering is stored, so
  // nothing is decoded and nothing rendered.
  pendingRead: editCase(0, 0, 0, N, N - 1, { at: { place: 48, runs: 1, named: 0, cut: 1 } }),
  // A cell's style, and a row added with no text, on a table in the middle of the tab: the
  // table is its own run. The piece around it is decoded and rendered for the builders
  // (`PIECE_OF_TABLE`); the slice takes the table's run from the piece, and the run cut from
  // it is rendered.
  cellStyle: editCase(PIECE_OF_TABLE, 0, PIECE_OF_TABLE + 1, N, N - 1, {
    at: { place: 73, runs: 1, named: 0, cut: 1 },
  }),
  rowNoText: editCase(PIECE_OF_TABLE, 0, PIECE_OF_TABLE + 1, N, N - 1, {
    at: { place: 73, runs: 1, named: 0, cut: 1 },
  }),
  // THE BUILDERS' OWN BATCHES, WRITTEN FRONT TO BACK. The table starts at index 120,012 and
  // the run after it at 120,023. A row added with text: `insertTableRow` at 120,012, then the
  // text typed into the cell just made, written past the table's stored end (120,024 and
  // on), which is not counted: the table's run alone is the slice, and the run after it is
  // listed by the id it had.
  rowWithText: editCase(PIECE_OF_TABLE, 0, PIECE_OF_TABLE + 1, N, N - 1, {
    at: { place: 73, runs: 1, named: 0, cut: 1 },
  }),
  // A column added with text: `insertTableColumn` at 120,012, then its text, as above.
  columnWithText: editCase(PIECE_OF_TABLE, 0, PIECE_OF_TABLE + 1, N, N - 1, {
    at: { place: 73, runs: 1, named: 0, cut: 1 },
  }),
  // A growing replacement in the paragraph that ends the run before the table (11 characters
  // replaced by 45). Its closure steps forward twice, to the table and to the paragraph after
  // it, each a run: the paragraph's run, the table's and the next are decoded and rendered
  // for the piece (3). The deletion and the insertion are inside the paragraph, and the
  // indexes the batch names after them, moved by 34, are not counted: the slice is the
  // paragraph's run, taken from the piece, and the one run cut from it is rendered.
  growingBeforeTable: editCase(3, 0, 3 + 1, N, N - 1, { at: { place: 72, runs: 1, named: 0, cut: 1 } }),
  // An append: the tab's last run holds the closure of the tab's end, and is the slice.
  append: editCase(1, 0, 1 + 1, N, N - 1, { at: { place: 137, runs: 1, named: 0, cut: 1 } }),
  // A table added at the tab's end with its cells filled: `insertTable` in the last
  // paragraph, then the cells' text past it. The tab's last run holds the closure of the
  // tab's end (1 decoded and rendered) and is the slice, taken from the piece; it is cut in
  // three (the paragraphs before, the table, the paragraph after), each rendered.
  tableFilled: editCase(1, 0, 1 + 3, N + 2, N),
  // A replacement that makes two list items of a paragraph in the middle of a run.
  listItems: editCase(1, 0, 1 + 1, N, N - 1, { at: { place: 48, runs: 1, named: 0, cut: 1 } }),
  // `insertTable` after a paragraph in the middle of a run: the paragraph's closure stands in
  // that run (1 decoded and rendered), which the slice takes from the piece and which is cut
  // in three (the paragraphs before, the table, the paragraphs after), each rendered.
  tableAfterParagraph: editCase(1, 0, 1 + 3, N + 2, N - 1, { at: { place: 48, runs: 1, named: 0, cut: 3 } }),
  // A TABLE REMOVED WHOLE, by one `deleteContentRange` from its first index to its end: the
  // deletion's exclusive end is the first index of the run after the table, which the reach
  // counts (a deletion that ends inside an element joins into it), so that run is decoded
  // too. It comes out as it went in: it is cut and rendered again, listed under the id it
  // had, and no row of it is written. One run decoded and rendered that the batch did not
  // change: the price of a rule that reads no content to choose.
  tableRemoved: editCase(2, 0, 1, N - 1, N - 1),
  // A replacement inside the first paragraph of a run, and one that starts at the run's first
  // index. The closure steps back twice, into the run before: the piece is tried from the
  // paragraph's run (1 run decoded and rendered), which answers that the closure goes on
  // before it, and made again from the run before (2). The batch names the paragraph's run
  // alone (the element before a run's first index is not read by the model), which the slice
  // takes from the piece; the run before, which the piece keeps decoded, is let go.
  firstParagraph: editCase(1 + 2, 0, 1 + 2 + 1, N, N - 1, { at: { place: 48, runs: 1, named: 0, cut: 1 } }),
  runStart: editCase(1 + 2, 0, 1 + 2 + 1, N, N - 1, { at: { place: 48, runs: 1, named: 0, cut: 1 } }),
  // A replacement inside the last paragraph of a run, shorter and longer than what it
  // replaces. The closure steps forward twice, into the next run, which is added to the
  // piece: 2 runs decoded and rendered, of which the slice takes the paragraph's.
  lastShorter: editCase(2, 0, 2 + 1, N, N - 1, { at: { place: 48, runs: 1, named: 0, cut: 1 } }),
  lastLonger: editCase(2, 0, 2 + 1, N, N - 1, { at: { place: 48, runs: 1, named: 0, cut: 1 } }),
  // A deletion that ends at the next run's first index, joining two paragraphs across the
  // boundary: the exclusive end is named, and it is the batch's first request, so it counts:
  // both runs are decoded at once. Together they are under a run's maximum, so the cut makes
  // one run of them.
  joinAcross: editCase(2, 0, 1, N - 1, N - 2),
  // A replacement that makes a list item of the paragraph a run starts with: the bulleted
  // range starts at the run's first index, so the run before is taken with it (the request
  // reads the element before the paragraph). The piece is tried from the paragraph's run (1)
  // and made again from the run before (2), and keeps both decoded: the slice takes both and
  // decodes none. EVERY RUN CUT FROM A SLICE IS RENDERED, changed or not: two, of which the
  // run before came out as it went in and writes no row.
  bulletAtRunStart: editCase(1 + 2, 0, 1 + 2 + 2, N, N - 1),
  // A bulleted range, by hand, that starts one index past a run's first index: the run before
  // is not taken at first (the start is matched with the run's first index), the model reads
  // the element before, and the batch is applied again to both runs: 1 and then 2 decoded.
  // The price of matching by equality; the builders bullet whole paragraphs.
  bulletInsideFirst: editCase(1 + 2, 1, 2, N, N - 1),
  // The same where an earlier request of the batch (the run's first paragraph deleted) moves
  // the bulleted range onto the run's first element: its start is past where that request
  // changed a length, so it is not counted.
  bulletMovedOntoFirst: editCase(1 + 2, 1, 2, N, N - 1),
  // A LONG INSERTION, THEN A REQUEST PAST IT: 100,000 characters typed in the run before the
  // table, then an insertion in the run after the table, written 100,000 past where it is
  // stored. The second index is not counted, so the first slice is the one run; the model
  // reads past it at the written index, and the widening places that index in the stored
  // sizes, 100,000 past the run the batch reads: 53 runs where the batch reads three. A
  // widening's guess is over by what the batch typed; no batch of the builders is of this
  // shape. The paragraph typed into passes a run's size, so the cut makes more runs.
  longInsertion: editCase(1 + 53, 1, 55, N + 2, N - 2),
  // A DELETION, THEN A REQUEST PAST IT: the written index, short by what was deleted, falls in
  // the first slice's own run as stored, so the first widening adds the table's run alone, the
  // model reads past it again, and the second adds the run after: 1, 2 and 3 decoded.
  deletionThenPast: editCase(1 + 2 + 3, 2, 3, N, N - 2),
  // A REFUSED BATCH THAT WIDENS: the bulleted range one index past the last run's first index,
  // then the deletion of the tab's final line break. One widening, the attempts' runs
  // decoded, Google's words, and no row written: the loop stores nothing.
  refusedWidens: editCase(1 + 2, 1, 0, 0, 0, {
    refused: "byHand: Google Docs would refuse this change: Invalid deletion range. Cannot " +
      "delete the requested range.",
  }),
  // THE LIMIT: A REPLACEMENT THAT SPANS N RUNS DECODES N. They are decoded one at a time (the
  // peak is one run's string) and all N are in hand as elements. What is left of them is
  // under a run's maximum, so the cut makes one run.
  span3: editCase(3, 0, 1, N - 2, N - 3),
  span5: editCase(5, 0, 1, N - 4, N - 5),
  // A range styled across five runs that changes text in none: five decoded and five rendered
  // though no run's content changed. The child is its parent's runs under its parent's keys:
  // no run and no rendering is written.
  styleSpan5: editCase(5, 0, 5, N, N),
  // ON THE SHAPE OF MANY RUNS (401: a table and an empty paragraph in turn, each a run): a
  // row added with 500 characters in its cell to the hundredth table. The piece around the
  // table is the nine runs of `listedPiece` below, found the same way (`PIECE_OF_LISTED`), of
  // which the slice takes the table's; the run cut from it is rendered, and the child lists
  // 400 runs by the ids they had.
  rowManyRuns: editCase(PIECE_OF_LISTED, 0, PIECE_OF_LISTED + 1, 401, 400, {
    at: { place: 199, runs: 1, named: 0, cut: 1 },
  }),
  // A LIST A TABLE (601 runs, two pages, 300 lists; an empty paragraph between each two
  // tables, each a run). THE PIECE AROUND THE 150TH TABLE: a step passes an empty paragraph
  // and ends on a table, so the closure is four runs before the table's and four after it,
  // nine in all. Tried from the table's run (1 run, which says the closure goes on before
  // it) and from the run before (2), then the runs before are scouted, 2 and then 4 of them
  // with the table's (3 and 5 runs), and the piece is made from the run the closure starts
  // in (9): 1 + 2 + 3 + 5 + 9 runs decoded and rendered, and nothing of the tab's other 592.
  listedPiece: editCase(PIECE_OF_LISTED, 0, PIECE_OF_LISTED, 601, 601),
  // A replacement inside the cell of that table, whose run names one list: the same piece,
  // whose own run the slice takes, and the run cut from it rendered.
  listedMiddle: editCase(PIECE_OF_LISTED, 0, PIECE_OF_LISTED + 1, 601, 600, {
    at: { place: 299, runs: 1, named: 1, cut: 1 },
  }),
  // THE FIRST EDIT AFTER A DEPLOY: every run decoded twice (to ask whether the model follows
  // the tab, and for the keying the scan of the tab's stored Markdown asks for) and the
  // piece's one; every run rendered once (the keying), then the piece's run and the run cut.
  afterDeploy: editCase(2 * N + 1, 0, N + 1 + 1, N, N - 1, { at: { place: 48, runs: 1, named: 0, cut: 1 } }),
  // The same on the tab of a list a table (601 runs), with that tab's piece.
  listedAfterDeploy: editCase(2 * 601 + PIECE_OF_LISTED, 0, 601 + PIECE_OF_LISTED + 1, 601, 600, {
    at: { place: 299, runs: 1, named: 1, cut: 1 },
  }),
};

/** What a card's reads cost on real storage, for one edit of one tab. */
export type CardRows = {
  /** The runs the version before and the version after list. */
  before: number; after: number;
  /** Where the two lists differ (`DocStore.changed`). */
  changed: { from: number; beforeTo: number; afterTo: number };
  /** The rows `DocStore.changed` reads, and its statements. */
  compared: { rowsRead: number; all: number };
  /** The rows `changedMarkdown` reads, `changed` among them, and its statements by kind. */
  card: { rowsRead: number; pages: number; joined: number; content: number; all: number };
  /** Where the strings the card answered start, and their lengths. */
  strings: { mdStart: number; before: number; after: number };
};

/**
 * ONE SCENARIO FOR REAL STORAGE: what the card of a queued change reads, in rows as storage
 * bills them. A row added to a table in the middle of 2,000 lines (nothing is listed anew
 * but the table's run), and `nestedItemsTab`'s item made a level-0 one, under the real cut
 * (every run before the item's is listed anew, cut otherwise, and reads as before). Each
 * edit is made beneath the counter; the reads counted are `DocStore.changed` alone, and
 * `changedMarkdown`, which asks it first.
 */
export function cardRowsScenario(storage: RowsReadStorage): Record<"rowAdded" | "nested", CardRows> {
  let counted = countedStorage(storage);
  let store = new DocStore(counted.storage);
  let beneath = new DocStore(storage);
  let listed = ({ id }: DocVersion) => Number(
    storage.sql.exec("SELECT COUNT(*) AS runs FROM doc_seq WHERE version = ?", id).one().runs);
  let spentOn = <T>(run: () => T) => {
    let rows = counted.rowsRead(), counts = counted.counts();
    let value = run();
    let now = counted.counts();
    return {
      value, rowsRead: counted.rowsRead() - rows, pages: now.pages - counts.pages,
      joined: now.joined - counts.joined, content: now.content - counts.content, all: now.all - counts.all,
    };
  };
  let measured = (
    base: DocVersion, edit: DocEdit, named?: (markdown: string) => { mdStart: number; mdEnd: number },
  ): CardRows => {
    let { after } = docEditResult(beneath, base, edit);
    let range = named?.(beneath.markdown(base));
    let compared = spentOn(() => store.changed(base, after));
    let { value, ...card } = spentOn(() => changedMarkdown(store, base, after, range, range && 1 << 20));
    if (value === "too-long") throw new Error("The card was refused.");
    return {
      before: listed(base), after: listed(after), changed: compared.value,
      compared: { rowsRead: compared.rowsRead, all: compared.all }, card,
      strings: { mdStart: value.mdStart, before: value.before.length, after: value.after.length },
    };
  };
  let keep = (doc: string, tab: GoogleDocsTab) =>
    scenarioBase(beneath, doc, beneath.keep(doc, scenarioCopy([tab]), NONE));

  let lines = keep("card-lines", linesWithTablesTab(
    "t1", Array.from({ length: 2_000 }, (_, at) => `Line ${at} ${"-".repeat(100)}`.slice(0, 100)), [1_000]));
  let row = tableCallChange(
    storedTabReading(beneath, lines), { method: "insertTableRows", lines: { table: 0, cells: [["x"]] } });
  let nested = keep("card-nested", nestedItemsTab("t1", 3_000, 100));
  let oldMarkdown = "  - target item";
  return {
    rowAdded: measured(lines, row),
    nested: measured(nested, { type: "replaceText", oldMarkdown, newMarkdown: "- target item" }, markdown => {
      let mdStart = markdown.indexOf(oldMarkdown);
      return { mdStart, mdEnd: mdStart + oldMarkdown.length };
    }),
  };
}


// ---------------------------------------------------------------------------
// What a read, a queued edit, a preview, an approval and a rejection take in hand
// ---------------------------------------------------------------------------

/** What one call of `pieceCountsScenario` decoded, rendered, held, ran and wrote. */
export type PieceCost = {
  runsDecoded: number; runsRendered: number; pieceWidenings: number;
  /** `peakRunBytesInHand` and `peakMarkdownCharsInHand` during the call, each from 0. */
  peakRun: number; peakMarkdown: number;
  /** Rows as storage counts them: the fake counts a changed row once and reads none. */
  rowsWritten: number; rowsRead: number;
  /** The statements by kind (`StatementCounts`), and `writes`, those that change a row. */
  pages: number; joined: number; content: number; all: number; writes: number;
};

/** One case of `pieceCountsScenario`. */
export type PieceCountsCase = PieceCost & {
  /**
   * The characters of the edit's own text, the longer of what it names and what it writes; for
   * a scan the text sought, and for the pending read the Markdown it answered.
   */
  text: number;
  /** Whether the call answered what the case is of. */
  ok: boolean;
  /**
   * `R` and `M` for the case: the longest stored run's JSON, in bytes at two a character, and
   * the longest stored rendering's Markdown, in characters, over every row the store held
   * when the call returned: the kept tab's and those the case made.
   */
  longestRun: number; longestMarkdown: number;
  /**
   * The rows each table of documents gained by the case, for a case that makes an edit: the
   * runs cut that the store did not hold, their renderings, the list of each version made,
   * the versions and the results.
   */
  stored?: Record<string, number>;
  /** Whether the sweep after the case left the rows the kept tab had. */
  restored: boolean;
};

/** The tab of `pieceCountsScenario` in the units its bounds and its rows are stated in. */
export type PieceCountsTab = {
  /** `n`, the runs the kept version lists, and `P`, the pages of its list (500 runs a page). */
  n: number; pages: number;
  /** The tab's Markdown, whole, in characters. */
  whole: number;
  /**
   * Whether the tab's tables hold as many cells as a tab's may (`MAX_TAB_TABLE_CELLS`): the
   * builders then refuse a row and a table added, and the scenario has no case of either.
   */
  full: boolean;
  /**
   * The place in the list of the run each case's piece is asked at: the replacements and the
   * approvals' edit (`text`), the table a row is added to (`table`), the line a table is
   * added after (`line`), the tab's last run (`end`), each edit of the replay (`queue`) and,
   * on prose, the large edit's first run (`large`).
   */
  places: { text: number; table: number; line: number; end: number; queue: number[]; large?: number };
  /**
   * The large edit (prose): `O`, the runs its own elements span, and the runs the version it
   * gives lists in their place.
   */
  large?: { own: number; cut: number };
};

/** The tab's name as a card says it. */
const PIECE_LABEL = "\"Main\" (t1)";
/** The display limit a replacement's card is held to, as the editor's is: 1 MiB of characters. */
const PIECE_LIMIT = { chars: 1 << 20, refusal: () => new Error("The card was refused.") };
/** A line of the prose shape: `chars` characters that name `at`. */
const proseLine = (word: string, at: number, chars = 100) =>
  `${word} ${String(at).padStart(5, "0")} ${"lorem ipsum dolor sit amet ".repeat(Math.ceil(chars / 27))}`
    .slice(0, chars - 1) + ".";
/**
 * The paragraphs of 500 characters the prose shape holds in a row, and how many of them the
 * large edit replaces, by as many: over 0.45 MiB of Markdown each way, in under the 2,000
 * blocks one edit's text may hold.
 */
const LONG_LINES = 1_100, LARGE_LINES = 945;
/**
 * The lines of the text a scan seeks on prose, from the line of that number on: over 1 MiB
 * of Markdown, which the tab of 20,000 paragraphs holds once and a shorter one does not.
 */
const SCAN_LINES = 10_300, SCAN_FROM = 3_000;

/** What a case of `pieceCountsScenario` edits, by shape. */
type PieceEdits = {
  tab: GoogleDocsTab;
  /** The replacements, by case; `middle` is also the edit an approval builds. */
  replacements: Record<string, { oldMarkdown: string; newMarkdown: string }>;
  /** The table a row is added to, the line a table is added after, and the new table's number there. */
  table: number; after: string; tableAfter: number;
  /** The three replacements of the replay, in the tab's order. */
  queue: { oldMarkdown: string; newMarkdown: string }[];
  /** The text a scan seeks. */
  scan: string;
  places: PieceCountsTab["places"];
  /** The runs the large edit's own elements span. */
  own?: number;
};

/**
 * The tab of `pieceCountsScenario` for `shape` and `size`, kept in `storage` under the
 * document `doc` by a store of its own, with every rendering stored: the tab, its base
 * version, the runs it is kept as and what each case edits. For a test that measures a case
 * of the scenario otherwise than the scenario does.
 */
export function pieceShapeKept(storage: RowsReadStorage, shape: "prose" | "tables", size: number) {
  let beneath = new DocStore(storage);
  let rows = <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) =>
    storage.sql.exec<T>(query, ...bindings).toArray();
  let digits = (at: number) => String(at).padStart(5, "0");

  // THE TAB, kept beneath the counter, and where its runs stand.
  const TABLES_AT = [0.01, 0.02, 0.03].map(share => Math.floor(share * size));
  const MIDDLE = "The middle paragraph.";
  const LONG_FROM = Math.floor(0.05 * size);
  let middleTable = size >> 1;
  let lineOf = (at: number) => at >= LONG_FROM && at < LONG_FROM + LONG_LINES
    ? proseLine("Long", at - LONG_FROM, 500) : proseLine("Line", at);
  let tab = shape === "prose"
    ? linesWithTablesTab("t1", Array.from({ length: size }, (_, at) => lineOf(at)), TABLES_AT)
    : tinyTablesTab("t1", size, at => `cell ${digits(at)}`, at => at === middleTable ? MIDDLE : "");
  let base = scenarioBase(beneath, "doc", beneath.keep("doc", scenarioCopy([tab]), NONE));
  let sizes = rows<{ size: number }>("SELECT size FROM doc_seq WHERE version = ? ORDER BY seq", base.id);
  let starts = [base.bodyEndIndex - sizes.reduce((sum, { size: indexes }) => sum + indexes, 0)];
  for (let { size: indexes } of sizes) starts.push(starts.at(-1)! + indexes);
  let n = sizes.length;
  let placeOf = (index: number) => starts.findLastIndex(start => start <= index);
  let joined = (from: number, count: number, line = lineOf) =>
    Array.from({ length: count }, (_, at) => line(from + at)).join("\n\n");

  let proseEdits = (): Omit<PieceEdits, "tab"> => {
    // Where each line starts: a line is as long as its text and its line break, and a table,
    // which stands before its line, 11 indexes.
    let lineStarts: number[] = [];
    let lines = new Map<number, number>();
    for (let at = 0, index = 1; at < size; at++) {
      if (TABLES_AT.includes(at)) index += 11;
      lineStarts.push(index);
      lines.set(index, at);
      index += lineOf(at).length + 1;
    }
    let lineStart = (at: number) => lineStarts[at];
    let lineAt = (index: number) => {
      let at = lines.get(index);
      if (at === undefined) throw new Error(`No line starts at index ${index}.`);
      return at;
    };
    // The run that holds the line at `share` of the tab: its place, and its first, middle
    // and last line.
    let runAt = (share: number) => {
      let place = placeOf(lineStart(Math.floor(share * size)));
      let first = lineAt(starts[place]), last = lineAt(starts[place + 1]) - 1;
      return { place, first, last, middle: first + ((last - first) >> 1) };
    };
    let change = (at: number) => ({ oldMarkdown: `Line ${digits(at)}`, newMarkdown: `Changed ${digits(at)}` });
    // The large edit starts three paragraphs into the run that holds the hundredth long one.
    let text = runAt(0.6), large = runAt((LONG_FROM + 100) / size);
    let queue = [runAt(0.4), text, runAt(0.9)];
    return {
      replacements: {
        replaceMiddle: change(text.middle), replaceFirst: change(text.first),
        replaceLast: change(text.last),
        largeEdit: {
          oldMarkdown: joined(large.first + 3, LARGE_LINES),
          newMarkdown: joined(0, LARGE_LINES, at => proseLine("Other", at, 500)),
        },
      },
      table: 1, after: proseLine("Line", text.middle), tableAfter: TABLES_AT.length,
      queue: queue.map(({ middle }) => change(middle)),
      scan: joined(SCAN_FROM, SCAN_LINES, at => proseLine("Line", at)),
      places: {
        text: text.place, table: placeOf(lineStart(TABLES_AT[1]) - 11), line: text.place,
        end: n - 1, queue: queue.map(({ place }) => place), large: large.place,
      },
      own: placeOf(lineStart(large.first + 3 + LARGE_LINES - 1)) - large.place + 1,
    };
  };
  let tablesEdits = (): Omit<PieceEdits, "tab"> => {
    let cell = (at: number) => ({ oldMarkdown: `cell ${digits(at)}`, newMarkdown: `cell changed ${digits(at)}` });
    let queue = [Math.floor(0.2 * size), middleTable, Math.floor(0.9 * size)];
    // The first run is the empty paragraph the tab opens with; table `at` is run `1 + 2 * at`.
    return {
      replacements: { replaceMiddle: cell(middleTable) },
      table: middleTable, after: MIDDLE, tableAfter: middleTable + 1,
      queue: queue.map(cell), scan: `cell ${digits(middleTable)}`,
      places: {
        text: 1 + 2 * middleTable, table: 1 + 2 * middleTable, line: 2 + 2 * middleTable,
        end: n - 1, queue: queue.map(at => 1 + 2 * at),
      },
    };
  };
  let edits: Omit<PieceEdits, "tab"> = shape === "prose" ? proseEdits() : tablesEdits();
  return { tab, base, n, edits };
}

/**
 * WHAT EACH STEP OF A DOCUMENT'S LIFE TAKES IN HAND, READS AND WRITES, one call at a time, on
 * the fake and on real storage alike, on one of two shapes kept under the store's sizes with
 * every rendering stored:
 * - `"prose"`: one tab of `size` paragraphs (`linesWithTablesTab`): 100 characters each
 *   (`Line 00000 ...`) but for 1,100 in a row, from 5% of the tab on, of 500 characters
 *   (`Long 00000 ...`, the same paragraphs whatever the tab's size), with a 1x1 table before
 *   the paragraphs at 1%, 2% and 3% of the tab.
 * - `"tables"`: `tinyTablesTab` of `size` pairs of a one-cell table and a paragraph, each a
 *   run (`2 * size + 1` runs), with the cases at its middle table and the one paragraph that
 *   holds text, which follows that table.
 *
 * The store runs on a `countedStorage`, and beneath that a wrapper counts the statements that
 * change a row; each case is one call made with nothing of the tab in hand, and the store's
 * counters, both peaks from 0, the statements and the rows read are taken around that call
 * alone. What the scenario reads for itself goes through a store and statements beneath the
 * counter. After each case the document is swept, as a rejection sweeps it.
 *
 * THE CASES, by name (a name that ends in `Again` is the same call a second time, its result
 * found stored: a preview's card made again):
 * - `pendingRead`: `store.markdown` of the version a queued replacement gave.
 * - `replaceMiddle`, and on prose `replaceFirst` and `replaceLast`: `prepareTextReplacement`
 *   inside a paragraph in the middle of a run, in a run's first paragraph and in its last; on
 *   tables, in the middle table's cell.
 * - `append`: `prepareAppend`.
 * - `rowAdded`, `tableAfterLine`, `tableAtEnd`: `prepareTableChange` for a row added to a
 *   table, and for a table added after a line and at the tab's end. Not on a tab whose
 *   tables already hold the cells a tab's may (5,000 pairs or more): the builders refuse.
 * - `largeEdit` (prose): `prepareTextReplacement` of 945 of the long paragraphs, over 0.45
 *   MiB of Markdown that spans tens of runs, by as much other text.
 * - `replay`, `replayAgain`: three queued replacements folded through `docTabReducer`.
 * - `rejection`: the same queue without its first edit, folded while what the fold of three
 *   stored is still there: the two edits left are made in other versions.
 * - `approvalStored`: `store.result` of an edit a replay made, which is all an approval reads
 *   of the tab while its revision pin holds.
 * - `approvalBuilt`: `tabEditRequests` over `storedTabReading` with no result stored.
 * - `fallback`: the same build inside a trial of the document fetched again.
 * - `scan`: `storedTabReading(...).find` of a text of over 1 MiB (prose) or of a cell's text.
 *
 * Answers the tab in the units the bounds are stated in and the cases by name. No document
 * leaves the scenario.
 */
export function pieceCountsScenario(
  storage: RowsReadStorage, shape: "prose" | "tables", size: number,
): { tab: PieceCountsTab; cases: Record<string, PieceCountsCase> } {
  let writes = 0;
  let watched: RowsReadStorage = {
    sql: {
      exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) {
        if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/.test(query)) writes++;
        return storage.sql.exec<T>(query, ...bindings);
      },
    },
    transactionSync: callback => storage.transactionSync(callback),
  };
  let counted = countedStorage(watched);
  let store = new DocStore(counted.storage);
  // The scenario's own reads: beneath the counter.
  let beneath = new DocStore(storage);
  let one = (query: string, ...bindings: unknown[]) =>
    Number(Object.values(storage.sql.exec(query, ...bindings).one())[0]);
  let { tab, base, n, edits } = pieceShapeKept(storage, shape, size);

  let cases: Record<string, PieceCountsCase> = {};
  let clean = tableCounts(storage);
  /** `R` and `M` over every run and every rendering stored. */
  let longest = () => ({
    longestRun: 2 * one("SELECT MAX(LENGTH(json)) AS longest FROM doc_run"),
    longestMarkdown: one("SELECT MAX(LENGTH(md)) AS longest FROM doc_md"),
  });
  /** What `run` moved of the counters, the statements and the rows, with both peaks from 0. */
  let measured = <T>(run: () => T): { value: T; cost: PieceCost } => {
    let before = { ...docStoreCost }, counts = counted.counts();
    let read = counted.rowsRead(), wrote = writes;
    docStoreCost.peakRunBytesInHand = 0;
    docStoreCost.peakMarkdownCharsInHand = 0;
    let value = run();
    let now = counted.counts();
    return {
      value,
      cost: {
        runsDecoded: docStoreCost.runsDecoded - before.runsDecoded,
        runsRendered: docStoreCost.runsRendered - before.runsRendered,
        pieceWidenings: docStoreCost.pieceWidenings - before.pieceWidenings,
        peakRun: docStoreCost.peakRunBytesInHand,
        peakMarkdown: docStoreCost.peakMarkdownCharsInHand,
        rowsWritten: docStoreCost.rowsWritten - before.rowsWritten,
        rowsRead: counted.rowsRead() - read,
        pages: now.pages - counts.pages, joined: now.joined - counts.joined,
        content: now.content - counts.content, all: now.all - counts.all, writes: writes - wrote,
      },
    };
  };
  /** The rows each table gained since `before`, by table: those that gained any. */
  let gained = (before: Record<string, number>) => Object.fromEntries(
    Object.entries(tableCounts(storage)).map(([table, count]) => [table, count - before[table]])
      .filter(([, by]) => by !== 0));
  /** Sweeps the document and notes, for each of `names`, whether the kept tab's rows are left. */
  let swept = (...names: string[]) => {
    beneath.sweep("doc", NONE);
    let restored = JSON.stringify(tableCounts(storage)) === JSON.stringify(clean);
    for (let name of names) cases[name].restored = restored;
  };
  /**
   * A preparation and the same a second time, as cases `name` and `nameAgain`: `ok` says
   * whether the first answered what the case is of, and the second is held to the first's
   * answer. `between` runs before the sweep.
   */
  let twice = <T>(
    name: string, text: number, prepare: () => T, ok: (value: T) => boolean, between?: () => void,
  ) => {
    let before = tableCounts(storage);
    let first = measured(prepare);
    cases[name] = {
      ...first.cost, text, ok: ok(first.value), ...longest(), stored: gained(before), restored: false,
    };
    let again = measured(prepare);
    cases[`${name}Again`] = {
      ...again.cost, text, ...longest(), restored: false,
      ok: JSON.stringify(again.value) === JSON.stringify(first.value),
    };
    between?.();
    swept(name, `${name}Again`);
  };
  let longer = ({ oldMarkdown, newMarkdown }: { oldMarkdown: string; newMarkdown: string }) =>
    Math.max(oldMarkdown.length, newMarkdown.length);
  let replacement = (name: string, between?: () => void) => {
    let { oldMarkdown, newMarkdown } = edits.replacements[name];
    twice(
      name, longer(edits.replacements[name]),
      () => prepareTextReplacement(store, base, oldMarkdown, newMarkdown, PIECE_LABEL, PIECE_LIMIT),
      ({ shown }) => shown.old.includes(oldMarkdown) && shown.rendered.includes(newMarkdown), between);
  };
  let tableChange = (name: string, text: number, call: TableCall, table?: number) => twice(
    name, text, () => prepareTableChange(store, base, call, PIECE_LABEL),
    prepared => prepared.change.type === call.method && prepared.table === table);
  // The edit an approval sends: the replacement in the middle, as its preparation queues it.
  let middle: DocEdit = {
    type: "replaceText", ...edits.replacements.replaceMiddle, ...(shape === "tables" ? { inTable: true } : {}),
  };
  let listed = ({ id }: DocVersion) => one("SELECT COUNT(*) AS runs FROM doc_seq WHERE version = ?", id);

  replacement("replaceMiddle", () => {
    // A pending read of the version the replacement gave, before it is swept.
    let child = docEditResult(beneath, base, middle).after;
    let read = measured(() => store.markdown(child));
    cases.pendingRead = {
      ...read.cost, text: read.value.length, ...longest(), restored: false,
      ok: child.id !== base.id && read.value === beneath.markdown(child),
    };
  });
  cases.pendingRead.restored = cases.replaceMiddle.restored;
  if (shape === "prose") {
    replacement("replaceFirst");
    replacement("replaceLast");
  }
  twice("append", 4, () => prepareAppend(store, base, "More"), added => added === "More");
  let full = shape === "tables" && size >= MAX_TAB_TABLE_CELLS;
  if (!full) {
    tableChange("rowAdded", 5, { method: "insertTableRows", lines: { table: edits.table, cells: [["added"]] } });
    tableChange(
      "tableAfterLine", edits.after.length,
      { method: "insertTable", table: { rows: 1, columns: 1, cells: [["new"]], after: edits.after } },
      edits.tableAfter);
    tableChange(
      "tableAtEnd", 3, { method: "insertTable", table: { rows: 1, columns: 1, cells: [["new"]] } },
      shape === "prose" ? 3 : size);
  }
  let large: PieceCountsTab["large"];
  if (edits.own !== undefined) {
    let own = edits.own;
    replacement("largeEdit", () => {
      let after = docEditResult(beneath, base, { type: "replaceText", ...edits.replacements.largeEdit }).after;
      large = { own, cut: listed(after) - (n - own) };
    });
  }

  // A REPLAY of three queued replacements, made and made again; then A REJECTION of the
  // first: the two left are folded over the base, where neither was made before.
  {
    let queue: QueuedDocRecord[] = edits.queue.map((edit, at) => ({
      id: at + 1,
      action: {
        type: "replaceText", ...edit, ...(shape === "tables" ? { inTable: true as const } : {}),
        tabId: "t1", markdownVersion: MARKDOWN_RENDERING_VERSION,
      },
    }));
    let fold = (records: QueuedDocRecord[]) => {
      let { entity, refused } = createSimulationStore(docTabReducer(store)).fold("t1", base, records);
      return { id: entity?.id, refused: refused.length };
    };
    let text = Math.max(...edits.queue.map(longer));
    let before = tableCounts(storage);
    let first = measured(() => fold(queue));
    cases.replay = {
      ...first.cost, text, ...longest(), stored: gained(before), restored: false,
      ok: first.value.refused === 0 && first.value.id !== undefined && first.value.id !== base.id,
    };
    let again = measured(() => fold(queue));
    cases.replayAgain = {
      ...again.cost, text, ...longest(), restored: false, ok: again.value.id === first.value.id,
    };
    before = tableCounts(storage);
    let rejected = measured(() => fold(queue.slice(1)));
    cases.rejection = {
      ...rejected.cost, text, ...longest(), stored: gained(before), restored: false,
      ok: rejected.value.refused === 0 && rejected.value.id !== undefined &&
        rejected.value.id !== first.value.id && rejected.value.id !== base.id,
    };
    swept("replay", "replayAgain", "rejection");
  }

  // AN APPROVAL while the revision pin holds: the result a replay stored, read; and, with
  // none stored, the batch built from the piece around the edit. Then THE FALLBACK: the same
  // build inside a trial of the document fetched again, which leaves no row.
  {
    let made = docEditResult(beneath, base, middle);
    let text = longer(edits.replacements.replaceMiddle);
    let sent = JSON.stringify(made.requests);
    let stored = measured(() => store.result(base, docEditKey(middle)));
    cases.approvalStored = {
      ...stored.cost, text, ...longest(), restored: false,
      ok: made.requests.length > 0 && stored.value !== undefined && "requests" in stored.value &&
        JSON.stringify(stored.value.requests) === sent,
    };
    swept("approvalStored");
    let build = (version: DocVersion) =>
      measured(() => JSON.stringify(tabEditRequests(storedTabReading(store, version), middle)));
    let built = build(base);
    cases.approvalBuilt = { ...built.cost, text, ...longest(), restored: false, ok: built.value === sent };
    swept("approvalBuilt");
    let fallback = beneath.trial(
      "doc", scenarioCopy([tab], "r2"), () => NONE, head => build(scenarioBase(beneath, "doc", head)));
    cases.fallback = { ...fallback.cost, text, ...longest(), restored: false, ok: fallback.value === sent };
    swept("fallback");
  }

  // UNIQUENESS: a scan of the runs' stored Markdown for a text.
  {
    let scan = measured(() => storedTabReading(store, base).find(edits.scan));
    cases.scan = {
      ...scan.cost, text: edits.scan.length, ...longest(), restored: false,
      // The 1 MiB text stands in a tab that holds its lines, and in no shorter one.
      ok: shape === "prose" && size < SCAN_FROM + SCAN_LINES
        ? scan.value === "none" : typeof scan.value === "number",
    };
    swept("scan");
  }

  return {
    tab: {
      n, pages: Math.ceil(n / 500), whole: beneath.markdown(base).length, full,
      places: edits.places, ...(large ? { large } : {}),
    },
    cases,
  };
}

/** What a case of `pieceCountsScenario` is held to (`pieceCountsExpected`). */
export type PieceCountsExpected = {
  runsDecoded: number; runsRendered: number; pieceWidenings: number;
  /** The statements by kind, on any storage. */
  pages: number; joined: number; content: number;
  /**
   * The rows read as real storage bills them, but for the case's small constant
   * (`PIECE_ROWS`): the terms that grow with the tab.
   */
  rows: number;
  /** The statements that change a row, and the rows each table gains. */
  writes: number; stored?: Record<string, number>;
  /**
   * The bound of `peakMarkdownCharsInHand`: `runs * M + texts * E`, with `M` the longest
   * stored rendering's Markdown and `E` the case's text; `exact` where the peak is the bound.
   */
  markdown: { runs: number; texts: number; exact?: true };
};

/** Statements of the kinds a case's formula is written in, and the rows they are billed. */
type Reads = { pages: number; joined: number; content: number; rows: number };

/**
 * WHAT EACH CASE OF `pieceCountsScenario` IS HELD TO, on the fake and on real storage alike,
 * as formulas in the tab's runs `n` and the places of the runs the cases stand in. No case
 * decodes or renders a number of runs that grows with the tab: those figures are the piece's.
 *
 * THE PIECE, as passes `[from, runs]` (an attempt or a scout from the run at `from` that
 * decodes and renders `runs` runs; `DocStore.piece`), by shape:
 * - prose, where a run is a hundred paragraphs or one table. In the middle of a run the
 *   closure stands in the run: `[p, 1]`. In a run's first paragraph it steps back into the
 *   run before: `[p, 1]`, which answers that it starts earlier, then `[p - 1, 2]`. In a run's
 *   last paragraph it steps forward: `[p, 2]`, the run after added. Around a table, a run of
 *   its own: `[t, 1]`, then `[t - 1, 3]`. At the tab's end: `[n - 1, 1]`. The large edit:
 *   `[p, O + 1]`, its own `O` runs and the run after them.
 * - tables, where a table and a paragraph alternate, each a run, and a step of the closure
 *   passes an empty paragraph and ends on a table. Around a table: `[p, 1]`, `[p - 1, 2]`,
 *   scouts of the two and the four runs before with the table's (`[p - 2, 3]`, `[p - 4, 5]`)
 *   and the piece from the run the closure starts in, `[p - 4, 9]`; `[p - 4, 7]` around the
 *   middle table, whose paragraph after holds text and ends the first step forward. Around
 *   that paragraph, at `q`: the same four and `[q - 3, 7]`. At the tab's end, `e`: the same
 *   four and `[e - 3, 4]`.
 *
 * THE STATEMENTS, term by term (a page is 500 runs; `through(x)` is `floor(x / 500) + 1`,
 * the pages of a walk from the list's start that ends at the run of place `x`, or with the
 * list where `x` is `n`; `before(x)` is `ceil(x / 500)`, the pages of `x` runs):
 * - a walk of the stored summaries to place `x` (`DocStore.walk`): `through(x)` joined pages.
 *   Uniqueness is a walk of the whole list that also reads each run's Markdown (`n` content
 *   rows); the pass that places an edit's own elements ends at the run after the one it
 *   names (`through(p + 1)`), at the table's run for a table (`through(t)`), and with the
 *   list for the tab's end; the tables' totals and a table found by how it reads are a walk
 *   of the whole list each; blankness is one page.
 * - a pass of a piece from `a` over `r` runs: `before(a)` joined pages for the carry at `a`,
 *   one page of the list from `a`, and `r` content rows (each run's JSON).
 * - the model's slice of runs `s` to `e` and the version stored from it: `through(e + 1)`
 *   joined pages for the slice, and `before(s) + before(n - e - 1)` pages of the runs the
 *   child lists as its parent does, before the slice and after it.
 * - a card (`changedMarkdown`): `before(from)` joined pages of the summaries before the
 *   first run the two versions list otherwise, and its readers' pages of eight runs and the
 *   Markdown of the runs they compare and join, which are constants of the case.
 * - a result found stored: one content row.
 *
 * THE ROWS READ, as real storage bills them (a row of a table a statement steps to), by the
 * same terms; what is left of a case is a small constant (`PIECE_ROWS`):
 * - a walk reads its pages whole, a row of the list and a row of the rendering it names for
 *   each run, and the version's record: `1 + 2 * (the runs of the pages read)`; a scan reads
 *   each run's Markdown too, `1 + 3 * n`.
 * - a pass of a piece from `a` over `r` runs: the version's totals (`n`), the joined pages
 *   before `a` whole (`2 * min(n, 500 * before(a))`), the page of the list from `a`
 *   (`min(500, n - a)`), and each run found and read (`2 * r`).
 * - the slice of runs `s` to `e` and its version: the totals and the joined pages to the run
 *   after the slice (`n + 2 * (the runs of those pages)`), and for the version the totals,
 *   the sizes summed, the parent's runs before and after the slice read and copied
 *   (`2 * n + 2 * (s + n - e - 1)`) and `s` rows more.
 * - a card: both versions' totals and the two comparisons of their lists (`4 * n`), and the
 *   summaries before the first run that differs (`2 * from`); its readers are the constant.
 * - the line before a table read back over `k` runs: `4 * k`.
 *
 * THE LARGE EDIT (prose) STATES THE MULTIPLE OF THE EDIT'S TEXT, which every other case hides
 * behind a small edit. With `E` the longer of its two texts, in characters, `O` the runs its
 * own elements span and `M` the longest stored rendering's Markdown: it decodes `O + 1` runs
 * and holds one run's JSON at a time, on a short tab as on a long one. THE COUNTER'S PEAK IS
 * `2 * E` AND A FEW LINES, NOT `E`: the card counts its two strings together
 * (`changedMarkdown`), where the piece's joined Markdown, counted alone, is `E` and the
 * rest of the runs it stands in (`docs-piece-counts.test.ts` holds the peak over `2 * E`
 * and under `2 * E + M`).
 * WHAT IS IN HAND AT ONCE IS MORE THAN A COUNTER OF ONE STRING SHOWS. By the code, in
 * characters, beside the edit's two texts, which the caller holds throughout (`2 * E`):
 * - while the builders run: the piece's joined Markdown (`E`, and the run after the own),
 *   with its source map and the own runs decoded, whose paragraphs hold the text named once
 *   more: about `3 * E` of strings, and those objects;
 * - while the model runs and the version is stored: the batch, which holds the new text
 *   (`E`), the slice's runs, taken from the piece, and the runs cut from them, with one
 *   run's JSON and its rendering at a time, and no rendering of the tab before: about
 *   `3 * E` of strings, and those objects;
 * - at the card: the two strings of the runs in which the tab reads otherwise, each about
 *   `E`: about `4 * E`, and no decoded run.
 * The heap of each moment is measured in `docs-piece-heap.test.ts` ("a large edit holds a
 * stated multiple of its text"), where the objects of a decoded run count: the second is
 * the largest.
 */
export function pieceCountsExpected(
  shape: "prose" | "tables", tab: PieceCountsTab,
): Record<string, PieceCountsExpected> {
  let { n, places } = tab;
  let through = (place: number) => Math.floor(place / 500) + 1;
  let before = (runs: number) => Math.ceil(runs / 500);
  let sum = (...parts: Reads[]): Reads => ({
    pages: parts.reduce((all, part) => all + part.pages, 0),
    joined: parts.reduce((all, part) => all + part.joined, 0),
    content: parts.reduce((all, part) => all + part.content, 0),
    rows: parts.reduce((all, part) => all + part.rows, 0),
  });
  // The runs of the pages a walk reads to end at the run of `place`.
  let paged = (place: number) => Math.min(n, 500 * through(place));
  let walk = (to: number): Reads =>
    ({ pages: through(to), joined: through(to), content: 0, rows: 1 + 2 * paged(to) });
  let scan = sum(walk(n), { pages: 0, joined: 0, content: n, rows: n });
  let found: Reads = { pages: 0, joined: 0, content: 1, rows: 0 };
  type Pass = readonly [from: number, runs: number];
  let passed = (passes: readonly Pass[]) => sum(...passes.map(([from, runs]): Reads => ({
    pages: before(from) + 1, joined: before(from), content: runs,
    rows: n + 2 * Math.min(n, 500 * before(from)) + Math.min(500, n - from) + 2 * runs,
  })));
  let runsOf = (passes: readonly Pass[]) => passes.reduce((all, [, runs]) => all + runs, 0);
  let sliced = (first: number, last: number): Reads => ({
    pages: through(last + 1) + before(first) + before(n - last - 1), joined: through(last + 1), content: 0,
    rows: n + 2 * paged(last + 1) + 2 * n + 2 * (first + n - last - 1) + first,
  });
  let card = (from: number, pages: number, content: number): Reads =>
    ({ pages: before(from) + pages, joined: before(from) + pages, content, rows: 4 * n + 2 * from });
  /** The rows an edit stores: `runs` new runs with their renderings, a list of `listed` runs. */
  let storing = (runs: number, listed: number, edits = 1) => ({
    ...(runs > 0 ? { doc_md: runs, doc_run: runs } : {}),
    doc_result: edits, doc_seq: listed, doc_version: edits,
  });
  /**
   * The statements that write an edit of the slice `first` to `last`: each new run and its
   * rendering, the child's list (the runs cut, and the parent's before and after them where
   * there are any), its version and its result.
   */
  let writing = (runs: number, first: number, last: number) =>
    2 * runs + 1 + (first > 0 ? 1 : 0) + (last < n - 1 ? 1 : 0) + 1 + 1;

  // The pieces, and what `pieceWidenings` counts of each: an attempt made again, each scout
  // and the attempt after it, and each time runs are added after.
  type Piece = { passes: readonly Pass[]; widenings: number };
  let inRun = (place: number): Piece => ({ passes: [[place, 1]], widenings: 0 });
  // On tables: tried from the run, from the run before, scouted two and four runs back, and
  // made from `start`, the run the closure starts in.
  let around = (place: number, start: number, runs: number, widenings: number): Piece => ({
    passes: [[place, 1], [place - 1, 2], [place - 2, 3], [place - 4, 5], [start, runs]], widenings,
  });
  let prose = shape === "prose";
  let pieces: Record<"text" | "table" | "line" | "end", Piece> = prose
    ? {
      text: inRun(places.text), line: inRun(places.line), end: inRun(places.end),
      table: { passes: [[places.table, 1], [places.table - 1, 3]], widenings: 2 },
    }
    : {
      text: around(places.text, places.text - 4, 7, 6), table: around(places.table, places.table - 4, 7, 6),
      line: around(places.line, places.line - 3, 7, 7), end: around(places.end, places.end - 3, 4, 4),
    };
  let expected: Record<string, PieceCountsExpected> = {};
  // The runs a piece joins: those of its last pass.
  let k = (piece: Piece) => piece.passes.at(-1)![1];
  /**
   * A case that makes an edit from `pieces` (each made once, in order) and its card, and the
   * same a second time, where the result is found stored and only `again` of the pieces are
   * made.
   */
  let prepared = (
    name: string, made: readonly Piece[], again: readonly Piece[], asked: Reads, askedAgain: Reads,
    slice: { first: number; last: number; cut: number; stored: number; listed: number },
    shown: Reads, texts = 1,
  ) => {
    let runs = (of: readonly Piece[]) => of.reduce((all, piece) => all + runsOf(piece.passes), 0);
    let widenings = (of: readonly Piece[]) => of.reduce((all, piece) => all + piece.widenings, 0);
    let read = (of: readonly Piece[]) => sum(...of.map(piece => passed(piece.passes)));
    // The longest Markdown in hand is a piece's joined runs, or a scan's text and one run; a
    // card's two strings together where they pass both.
    let markdown = { runs: texts > 1 ? texts : Math.max(1, ...made.map(k)), texts };
    expected[name] = {
      runsDecoded: runs(made), runsRendered: runs(made) + slice.cut, pieceWidenings: widenings(made),
      ...sum(asked, read(made), sliced(slice.first, slice.last), shown),
      writes: writing(slice.stored, slice.first, slice.last),
      stored: storing(slice.stored, slice.listed), markdown,
    };
    expected[`${name}Again`] = {
      runsDecoded: runs(again), runsRendered: runs(again), pieceWidenings: widenings(again),
      ...sum(askedAgain, read(again), found, shown), writes: 0, markdown,
    };
  };
  let one = (place: number, listed = n) => ({ first: place, last: place, cut: 1, stored: 1, listed });

  // A REPLACEMENT: uniqueness, the placing pass, the piece, the slice and the version, and a
  // card of six readers' pages and six runs' Markdown.
  let replaced = (name: string, piece: Piece, place: number) => prepared(
    name, [piece], [piece], sum(scan, walk(place + 1)), sum(scan, walk(place + 1)), one(place),
    card(place, 6, 6));
  replaced("replaceMiddle", pieces.text, places.text);
  if (prose) {
    replaced("replaceFirst", { passes: [[places.text, 1], [places.text - 1, 2]], widenings: 1 }, places.text);
    replaced("replaceLast", { passes: [[places.text, 2]], widenings: 1 }, places.text);
  }
  // AN APPEND: the pass that places the tab's end, the piece, and blankness, asked once the
  // edit is made.
  let ended = sum(walk(n), walk(0));
  prepared("append", [pieces.end], [pieces.end], ended, ended, one(places.end), card(places.end, 4, 4));
  // A ROW ADDED: the tables' totals, the pass to the table's run, the piece, the table found
  // by how it reads, and the line before the table for its card. On tables no line stands
  // before the middle table: from the run before the piece every run back to the tab's first
  // is read, a page of one run and its Markdown each.
  let start = places.table - 4;
  let lineBefore: Reads = prose
    ? { pages: 0, joined: 0, content: 0, rows: 0 }
    : sum(walk(start - 1), { pages: start, joined: start, content: start, rows: 4 * start });
  let row = sum(walk(n), walk(places.table), walk(n), lineBefore);
  if (!tab.full) {
    prepared("rowAdded", [pieces.table], [pieces.table], row, row, one(places.table), card(places.table, 6, 8));
  }
  // A TABLE ADDED AFTER A LINE: the tables' totals, the scan for the line, the placing pass
  // and the piece; and, once the edit is made, the placing pass and THE PIECE A SECOND TIME,
  // for the new table's number. Found stored, the piece is made once. The line's run is cut
  // in three: on prose all three are new, on tables the line's own run is its parent's.
  let line = sum(scan, walk(places.line + 1));
  if (!tab.full) prepared(
    "tableAfterLine", [pieces.line, pieces.line], [pieces.line], sum(walk(n), line, walk(places.line + 1)),
    line, { first: places.line, last: places.line, cut: 3, stored: prose ? 3 : 2, listed: n + 2 },
    card(prose ? places.line : places.line + 1, 6, prose ? 9 : 10));
  // A TABLE ADDED AT THE END: the same with a pass to the list's end in place of the scan.
  // The paragraphs before the new table are the run the parent lists.
  if (!tab.full) prepared(
    "tableAtEnd", [pieces.end, pieces.end], [pieces.end], sum(walk(n), walk(n), walk(n)), walk(n),
    { first: places.end, last: places.end, cut: 3, stored: 2, listed: n + 2 },
    card(n, prose ? 6 : 7, prose ? 6 : 7));
  // THE LARGE EDIT: its `O` own runs and the run after them, one pass; the slice is the own
  // runs. Its card's two strings are each about the edit's text: counted together, twice
  // the text.
  if (tab.large && places.large !== undefined) {
    let { own, cut } = tab.large, at = places.large;
    let piece: Piece = { passes: [[at, own + 1]], widenings: 1 };
    prepared(
      "largeEdit", [piece], [piece], sum(scan, walk(at + 1)), sum(scan, walk(at + 1)),
      { first: at, last: at + own - 1, cut, stored: cut, listed: n - own + cut }, card(at, 10, 48), 2);
  }

  // A REPLAY: each edit as a replacement without its card. Made again, each result is found
  // stored: one content row an edit. A REJECTION of the first makes the other two in the
  // base, whose runs and renderings the replay stored.
  let queue = places.queue.map(place => ({
    place,
    piece: prose ? inRun(place) : place === places.text ? pieces.text : around(place, place - 4, 9, 8),
  }));
  let folded = (edits: typeof queue, stored: number): PieceCountsExpected => {
    let runs = edits.reduce((all, { piece }) => all + runsOf(piece.passes), 0);
    return {
      runsDecoded: runs, runsRendered: runs + edits.length,
      pieceWidenings: edits.reduce((all, { piece }) => all + piece.widenings, 0),
      ...sum(...edits.flatMap(({ place, piece }) =>
        [scan, walk(place + 1), passed(piece.passes), sliced(place, place)])),
      writes: edits.reduce((all, { place }) => all + writing(stored, place, place), 0),
      stored: storing(stored * edits.length, n * edits.length, edits.length),
      markdown: { runs: Math.max(...edits.map(({ piece }) => k(piece))), texts: 1 },
    };
  };
  let nothing = {
    runsDecoded: 0, runsRendered: 0, pieceWidenings: 0, pages: 0, joined: 0, rows: 0, writes: 0,
  };
  expected.replay = folded(queue, 1);
  expected.replayAgain = { ...nothing, content: queue.length, markdown: { runs: 0, texts: 0, exact: true } };
  expected.rejection = folded(queue.slice(1), 0);

  // AN APPROVAL: a stored result is one content row; built, it is the replacement's reads
  // before the model runs, and writes nothing. THE FALLBACK is the same build.
  expected.approvalStored = { ...nothing, content: 1, markdown: { runs: 0, texts: 0, exact: true } };
  let built: PieceCountsExpected = {
    runsDecoded: runsOf(pieces.text.passes), runsRendered: runsOf(pieces.text.passes),
    pieceWidenings: pieces.text.widenings, ...sum(scan, walk(places.text + 1), passed(pieces.text.passes)),
    writes: 0, markdown: { runs: k(pieces.text), texts: 1 },
  };
  expected.approvalBuilt = built;
  expected.fallback = built;
  // A SCAN holds the text and one run; A PENDING READ answers the tab's Markdown, which is
  // the floor: the same statements, every run's Markdown read.
  expected.scan = { ...nothing, ...scan, markdown: { runs: 1, texts: 1, exact: true } };
  expected.pendingRead = { ...nothing, ...scan, markdown: { runs: 0, texts: 1, exact: true } };
  return expected;
}

/** One tab of `closurePieceScenario` under one cut: the piece around its replacement. */
export type ClosurePiece = {
  /** The runs the tab is kept as, and the place the piece was asked at. */
  n: number; place: number;
  /** The runs the piece holds, `[from, to)`, and the places of the runs it kept decoded. */
  from: number; to: number; decoded: number[];
  /** The piece's Markdown and the longest stored rendering's, in characters. */
  closure: number; longestMarkdown: number;
  /** What the piece alone moved of the counters, with the Markdown's peak from 0. */
  runsDecoded: number; runsRendered: number; pieceWidenings: number; peakMarkdown: number;
  /** What the replacement queued end to end decoded, and whether its card shows it. */
  edit: { runsDecoded: number; pieceWidenings: number; ok: boolean };
};

/** One element a run. */
const ONE_ELEMENT: RunSizes = { least: Infinity, target: Infinity, most: Infinity, elements: 1 };

/**
 * PIECES WHOSE CLOSURE IS THE DOCUMENT'S, each tab kept under the store's sizes and under
 * runs of one element:
 * - `breaks`: a replacement in the paragraph after 200 empty ones. A step back passes every
 *   paragraph that writes line breaks alone, so the closure starts three paragraphs before
 *   the first of them and ends two after the paragraph changed.
 * - `nested`: a replacement in the item after 3,000 items deeper than level 0 of one level-0
 *   item (`nestedItemsTab`): the closure goes back through them to that item.
 * For each: the piece asked alone through a stored reading (its runs, the runs it kept
 * decoded, its Markdown and what it cost), and the replacement queued end to end.
 */
export function closurePieceScenario(storage: RowsReadStorage) {
  let seen: { place: number; from: number; to: number; decoded: number[]; closure: number }[] = [];
  /** A store that notes, as numbers, each piece it answers. */
  class Watched extends DocStore {
    override piece(...asked: Parameters<DocStore["piece"]>) {
      let piece = super.piece(...asked);
      seen.push({
        place: asked[1].place, from: piece.from, to: piece.to, decoded: [...piece.decoded.keys()],
        closure: piece.rendering.markdown.length,
      });
      return piece;
    }
  }
  let one = (query: string, ...bindings: unknown[]) =>
    Number(Object.values(storage.sql.exec(query, ...bindings).one())[0]);
  let measure = (
    doc: string, tab: GoogleDocsTab, sizes: RunSizes, oldMarkdown: string, newMarkdown: string,
  ): ClosurePiece => {
    let store = new Watched(storage, undefined, undefined, sizes);
    let base = scenarioBase(store, doc, store.keep(doc, scenarioCopy([tab], "r1", sizes), NONE));
    let mdStart = storedTabReading(store, base).find(oldMarkdown);
    if (typeof mdStart !== "number") throw new Error("The text is not in the tab once.");
    let before = { ...docStoreCost };
    docStoreCost.peakMarkdownCharsInHand = 0;
    seen = [];
    storedTabReading(store, base).piece({ markdown: { mdStart, mdEnd: mdStart + oldMarkdown.length } });
    let [piece] = seen;
    let cost = {
      runsDecoded: docStoreCost.runsDecoded - before.runsDecoded,
      runsRendered: docStoreCost.runsRendered - before.runsRendered,
      pieceWidenings: docStoreCost.pieceWidenings - before.pieceWidenings,
      peakMarkdown: docStoreCost.peakMarkdownCharsInHand,
    };
    before = { ...docStoreCost };
    let { shown } = prepareTextReplacement(store, base, oldMarkdown, newMarkdown, PIECE_LABEL, PIECE_LIMIT);
    return {
      n: one("SELECT COUNT(*) AS runs FROM doc_seq WHERE version = ?", base.id), ...piece, ...cost,
      longestMarkdown: one("SELECT MAX(LENGTH(md)) AS longest FROM doc_md"),
      edit: {
        runsDecoded: docStoreCost.runsDecoded - before.runsDecoded,
        pieceWidenings: docStoreCost.pieceWidenings - before.pieceWidenings,
        ok: shown.old.includes(oldMarkdown) && shown.rendered.includes(newMarkdown),
      },
    };
  };
  let breaks = scenarioTab("t1", ["X", "A", "B", "Lead", ...Array.from({ length: 200 }, () => ""), "Tail", "C", "D", "Y"]);
  let nested = nestedItemsTab("t1", 3_000, 100);
  return {
    breaks: measure("breaks", breaks, RUN_SIZES, "Tail", "Changed"),
    breaksByElement: measure("breaks-one", breaks, ONE_ELEMENT, "Tail", "Changed"),
    nested: measure("nested", nested, RUN_SIZES, "target item", "changed item"),
    nestedByElement: measure("nested-one", nested, ONE_ELEMENT, "target item", "changed item"),
  };
}

/**
 * What a piece asked at `place` decodes and renders, and its widenings, by `DocStore.piece`'s
 * rule, with `before` the runs of the closure before `place`, `own` the runs of the own
 * elements and `after` those after them. Tried from the run named, which adds the runs
 * after only where the closure starts in it; made again from the run before; then the runs
 * before are scouted, 2, 4, 8, ... of them (capped at `place`) with the run named, until a
 * scout reaches the run the closure starts in, and the piece is made from exactly that run.
 */
export function pieceCost(place: number, before: number, own: number, after: number) {
  if (before === 0) return { runs: own + after, widenings: after };
  if (before === 1) return { runs: own + (1 + own + after), widenings: 1 + after };
  let scouted = 0, scouts = 0;
  for (let back = 2; ; back *= 2) {
    let reach = Math.min(back, place);
    scouted += reach + 1;
    scouts++;
    if (reach >= before) break;
  }
  return { runs: own + (1 + own) + scouted + (before + own + after), widenings: 1 + scouts + 1 + after };
}

/**
 * THE SMALL CONSTANT OF EACH CASE'S ROWS READ, as real storage shows it on the tab the
 * bounds are stated on (prose: 20,000 paragraphs; tables: 2,000 pairs): what a case reads
 * beside the terms of `pieceCountsExpected(...).rows`. It is the version's records, a run
 * found by its id, the named styles and the lists of a pass, a result's rows, and A CARD'S
 * READERS: a page of up to eight runs with their renderings for each reader made, and the
 * Markdown of each run compared or joined (about 120 rows for a replacement's card, about
 * 30 for an append's at the list's end, where a page is cut short; 390 for the large
 * edit's, which joins its runs). On another size of the same shape a constant moves by a
 * reader's page at most, where the pages read stand otherwise in the list.
 */
export const PIECE_ROWS: Record<"prose" | "tables", Record<string, number>> = {
  prose: {
    replaceMiddle: 124, replaceMiddleAgain: 123, pendingRead: 0, replaceFirst: 126,
    replaceFirstAgain: 121, replaceLast: 124, replaceLastAgain: 123, append: 34, appendAgain: 35,
    rowAdded: 128, rowAddedAgain: 123, tableAfterLine: 133, tableAfterLineAgain: 123,
    tableAtEnd: 85, tableAtEndAgain: 74, largeEdit: 391, largeEditAgain: 371, replay: 46,
    replayAgain: 12, rejection: 38, approvalStored: 3, approvalBuilt: 3, fallback: 3, scan: 0,
  },
  tables: {
    replaceMiddle: 139, replaceMiddleAgain: 139, pendingRead: 0, append: 49, appendAgain: 57,
    rowAdded: 141, rowAddedAgain: 142, tableAfterLine: 171, tableAfterLineAgain: 145,
    tableAtEnd: 141, tableAtEndAgain: 115, replay: 91, replayAgain: 12, rejection: 65,
    approvalStored: 3, approvalBuilt: 18, fallback: 18, scan: 0,
  },
};
