// An edit or a quoted-text lookup whose stored copy lost a row drops the copy, wherever the
// row is met, and throws storage's own error, never the reading's wrapper.

import { afterEach, describe, expect, it, vi } from "vitest";
import { googleDocDisplayLimit } from "../src/doc-actions";
import { storedDocCopy } from "../src/docs-copy";
import { DocReadingFault } from "../src/docs-reading";
import { docEditResult, type DocEdit } from "../src/docs-replay";
import { DOC_COPY_UNREADABLE } from "../src/docs-replica";
import { DocStore, type DocVersion } from "../src/docs-store";
import { prepareAppend, prepareTableChange, prepareTextReplacement } from "../src/docs-table-actions";
import { savedDoc } from "../src/drive-comment-body";
import { buildTab, grid, item, NUMBERED_LIST, para } from "./doc-fixture";
import { RUNS_OF_THREE } from "./doc-store-scenarios";
import { asFetched, kept } from "./docs-store-slice-shadow";

/**
 * A numbered list broken by a paragraph after each item (every later number is carried), then a
 * table and a paragraph, kept three elements a run.
 */
function numbered() {
  let tab = asFetched(buildTab([
    ...Array.from({ length: 12 }, (_, at) => [item(`Item ${at}.`, "N1"), para(`Line ${at}.`)]).flat(),
    grid(["Cell"]), para("Last."),
  ], NUMBERED_LIST));
  let all = kept(tab, RUNS_OF_THREE);
  let runs = all.storage.sql.exec<{ run: string }>(
    "SELECT run FROM doc_seq WHERE version = ? ORDER BY seq", all.base.id,
  ).toArray().map(({ run }) => run);
  /** Removes run `at` beneath the store, and its stored rendering where `rendering` says so. */
  let lose = (at: number, rendering = false) => {
    all.storage.sql.exec("DELETE FROM doc_run WHERE id = ?", runs[at]);
    if (rendering) all.storage.sql.exec("DELETE FROM doc_md WHERE run = ?", runs[at]);
  };
  return { ...all, runs, lose };
}

/** Removes the list's first item, so every later item is numbered again. */
const RENUMBERS: DocEdit = { type: "replaceText", oldMarkdown: "1. Item 0.\n\n", newMarkdown: "" };

/** What `run` throws. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Holds that `thrown` is storage's own error for a copy that does not read back. */
function expectUnreadable(thrown: unknown, store: DocStore, what = ""): void {
  expect(thrown, what).toEqual(new Error(DOC_COPY_UNREADABLE));
  expect(thrown, what).not.toBeInstanceOf(DocReadingFault);
  expect(store.head("doc"), what).toBeUndefined();
}

afterEach(() => {
  vi.restoreAllMocks();
});

const LIMIT = googleDocDisplayLimit("replaceText");

describe("an edit that finds a later run of its tab gone as it stores its version", () => {
  it("renders the later runs again where every row is there", () => {
    let { store, base } = numbered();
    let made = docEditResult(store, base, RENUMBERS);
    expect(made.after.id).not.toBe(base.id);
    expect(store.markdown(made.after)).toContain("1. Item 1.");
    expect(store.head("doc")).toBeDefined();
  });

  it("drops the copy, whichever run is gone", () => {
    let dropped = 0;
    let { runs: all } = numbered();
    for (let at = 1; at < all.length; at++) {
      let { store, base, lose } = numbered();
      // Met by the piece, or else as the version is stored and later runs are rendered again.
      lose(at);
      let thrown = thrownBy(() => docEditResult(store, base, RENUMBERS));
      // A run that holds no item is not rendered again, so its row is not missed.
      if (thrown === undefined) continue;
      expectUnreadable(thrown, store, `run ${at}`);
      dropped++;
    }
    // The edit renders again every later run that holds an item: most of them.
    expect(dropped).toBeGreaterThanOrEqual(8);
  });
});

describe("a preparation whose copy lost a row, met where the piece does not decode", () => {
  it("a replacement meets it in the scan of the stored Markdown", () => {
    let { store, base, lose } = numbered();
    // Run 1 is gone with its rendering: the scan for text in run 6 renders it and finds no row.
    lose(1, true);
    let decoded = vi.spyOn(DocStore.prototype, "piece");
    let thrown = thrownBy(() => prepareTextReplacement(store, base, "Line 9.", "Line nine.", "Tab", LIMIT));
    expectUnreadable(thrown, store);
    expect(decoded).not.toHaveBeenCalled();
  });

  it("a replacement meets it in the model's slice", () => {
    let { store, base, runs, storage } = numbered();
    // Gone between the piece and the slice, which decodes it and finds no row.
    let piece = DocStore.prototype.piece;
    vi.spyOn(DocStore.prototype, "piece").mockImplementation(function (this: DocStore, version, at) {
      let made = piece.call(this, version, at);
      made.decoded.clear();
      storage.sql.exec("DELETE FROM doc_run WHERE id = ?", runs[at.place]);
      return made;
    });
    let sliced = vi.spyOn(DocStore.prototype, "slice");
    let thrown = thrownBy(() => prepareTextReplacement(store, base, "Line 9.", "Line nine.", "Tab", LIMIT));
    expect(sliced).toHaveBeenCalledTimes(1);
    expectUnreadable(thrown, store);
  });

  it("a replacement meets it as the version it gives is stored", () => {
    let { store, base, lose } = numbered();
    // Run 5 is renumbered, so rendered inside the edit's transaction, which the failure undoes.
    lose(5);
    let thrown = thrownBy(() => prepareTextReplacement(store, base, "1. Item 0.\n\n", "", "Tab", LIMIT));
    expectUnreadable(thrown, store);
  });

  it("an append meets it in the pass that places its piece", () => {
    let { store, base, lose } = numbered();
    // The pass over the summaries that finds the tab's end renders the lost run 1.
    lose(1, true);
    let placed = vi.spyOn(DocStore.prototype, "piece");
    let thrown = thrownBy(() => prepareAppend(store, base, "More."));
    expect(placed).not.toHaveBeenCalled();
    expectUnreadable(thrown, store);
  });

  it("a table change meets it in the pass that counts the tab's tables", () => {
    let { store, base, lose } = numbered();
    // The pass over the summaries that counts the tables renders the lost run 1.
    lose(1, true);
    let placed = vi.spyOn(DocStore.prototype, "piece");
    let thrown = thrownBy(() => prepareTableChange(
      store, base, { method: "deleteTable", table: 0 }, "Tab"));
    expect(placed).not.toHaveBeenCalled();
    expectUnreadable(thrown, store);
  });

  it("a table change meets it in the piece around its table", () => {
    let { store, base, runs, lose } = numbered();
    // The table's rendering is there but its run is not: the piece finds no row.
    lose(runs.length - 2);
    let placed = vi.spyOn(DocStore.prototype, "piece");
    let sliced = vi.spyOn(DocStore.prototype, "slice");
    let thrown = thrownBy(() => prepareTableChange(
      store, base, { method: "deleteTable", table: 0 }, "Tab"));
    expect(placed).toHaveBeenCalledTimes(1);
    expect(sliced).not.toHaveBeenCalled();
    expectUnreadable(thrown, store);
  });

  it("a table change does not meet a row gone far from its table", () => {
    let { store, base, lose } = numbered();
    // The preparation never decodes run 1; the next read that does drops the copy.
    lose(1);
    let prepared = prepareTableChange(store, base, { method: "deleteTable", table: 0 }, "Tab");
    expect(prepared.change.type).toBe("deleteTable");
    expect(store.head("doc")).toBeDefined();
    expectUnreadable(thrownBy(() => store.tab(base)), store);
  });

  it("a new table meets it in the piece made again for its number", () => {
    let { store, base, runs, storage } = numbered();
    // The piece for the new table's number is made again outside any transaction, over a lost run.
    let piece = DocStore.prototype.piece;
    let pieces = 0;
    vi.spyOn(DocStore.prototype, "piece").mockImplementation(function (this: DocStore, version, at) {
      if (++pieces === 2) storage.sql.exec("DELETE FROM doc_run WHERE id = ?", runs[at.place]);
      return piece.call(this, version, at);
    });
    let stored = vi.spyOn(DocStore.prototype, "putSlice");
    let thrown = thrownBy(() => prepareTableChange(
      store, base, { method: "insertTable", table: { rows: 1, columns: 1, after: "Line 9." } }, "Tab"));
    expect(stored).toHaveBeenCalledTimes(1);
    expect(pieces).toBe(2);
    expectUnreadable(thrown, store);
  });
});

describe("a preparation whose copy lost a row between its edit and its card", () => {
  /**
   * Makes the card's first read (`DocStore.changed`) remove the runs only the version after
   * lists, with their renderings. Answers how often the card read.
   */
  function losingForTheCard(storage: ReturnType<typeof numbered>["storage"]): () => number {
    let changed = DocStore.prototype.changed;
    let reads = 0;
    vi.spyOn(DocStore.prototype, "changed").mockImplementation(function (this: DocStore, before, after) {
      reads++;
      let anew = `SELECT run FROM doc_seq WHERE version = ?1
        AND run NOT IN (SELECT run FROM doc_seq WHERE version = ?2)`;
      let { runs } = storage.sql.exec<{ runs: number }>(
        `SELECT COUNT(*) AS runs FROM (${anew})`, after.id, before.id).one();
      expect(runs).toBeGreaterThan(0);
      storage.sql.exec(`DELETE FROM doc_md WHERE run IN (${anew})`, after.id, before.id);
      storage.sql.exec(`DELETE FROM doc_run WHERE id IN (${anew})`, after.id, before.id);
      return changed.call(this, before, after);
    });
    return () => reads;
  }

  // The card's reads run after the edit's transaction, in none.
  it.each([
    ["a replacement", (store: DocStore, base: DocVersion) =>
      prepareTextReplacement(store, base, "Line 9.", "Line nine.", "Tab", LIMIT)],
    ["an append", (store: DocStore, base: DocVersion) => prepareAppend(store, base, "More.")],
    ["a table change", (store: DocStore, base: DocVersion) => prepareTableChange(
      store, base, { method: "insertTableRows", lines: { table: 0, cells: [["Row"]] } }, "Tab")],
    ["a new table", (store: DocStore, base: DocVersion) => prepareTableChange(
      store, base, { method: "insertTable", table: { rows: 1, columns: 1, after: "Line 9." } }, "Tab")],
  ])("%s meets it in the runs in which the tab reads otherwise", (_name, prepare) => {
    let { store, base, storage } = numbered();
    let reads = losingForTheCard(storage);
    let stored = vi.spyOn(DocStore.prototype, "putSlice");
    let thrown = thrownBy(() => prepare(store, base));
    expect(stored).toHaveBeenCalledTimes(1);
    expect(reads()).toBe(1);
    expectUnreadable(thrown, store);
  });
});

// A bound Doc's lookup and a Drive connection's search the stored copy in no transaction.
describe("a lookup of quoted text whose copy lost a row", () => {
  /** What a search for `quote` in the kept tab throws, through a view of the stored copy. */
  const lookup = (store: DocStore, base: DocVersion, quote: string) => thrownBy(() =>
    savedDoc(storedDocCopy(store, "doc", store.head("doc")!)).locate(base.tabId, quote));

  it("finds the text where every row is there", () => {
    let { store, base } = numbered();
    expect(lookup(store, base, "Line 9.")).toBeUndefined();
    expect(store.head("doc")).toBeDefined();
  });

  it.each([
    ["before it", "Line 0."],
    ["after it", "Line 11."],
  ])("meets it at the run that is gone, where the text stands %s", (_where, quote) => {
    let { store, base, lose } = numbered();
    lose(5);
    expectUnreadable(lookup(store, base, quote), store);
  });

  it("is refused the view of a copy the store dropped", () => {
    let { store, base, lose } = numbered();
    let saved = savedDoc(storedDocCopy(store, "doc", store.head("doc")!));
    lose(5);
    expectUnreadable(thrownBy(() => saved.locate(base.tabId, "Line 0.")), store);
    // The view names a copy storage holds no more: it reads no row of it.
    expect(thrownBy(() => saved.locate(base.tabId, "Line 0."))).toEqual(new Error(DOC_COPY_UNREADABLE));
  });
});
