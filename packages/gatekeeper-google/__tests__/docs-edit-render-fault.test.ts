// Holds what the renderer throws on the tab an edit is made in and on the tab it gives. The
// store renders the piece of the first the builders read, and the runs cut from the edit's
// slice as it stores them, inside the transaction where every other throw is a fault of storage: the
// renderer's is told from those, refused as any throw of the pure code is, and stored.
// A file of its own, because it replaces a module for every test of its file.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleDocsTab } from "../src/docs-api";
import { replayCost } from "../src/docs-model";
import { storedTabReading } from "../src/docs-reading";
import {
  docEditKey, docEditResult, DocEditRefusedError, docRefusal, type DocEdit,
} from "../src/docs-replay";
import { pruneTab } from "../src/docs-replica";
import {
  DocRunRenderError, DocStore, docStoreCost, type DocPending,
} from "../src/docs-store";
import { prepareAppend } from "../src/docs-table-actions";
import { docTabToMarkdown } from "../src/markdown-converter";
import { buildTab, para } from "./doc-fixture";
import { fakeDocStorage } from "./doc-store-fake";
import { wholeTabsFetched } from "./doc-store-scenarios";

/** Whether the store's renderer throws on a run that holds the text `FAULT`. */
const fault = vi.hoisted(() => ({ on: false }));

// The module as it is but for `renderRun` as other modules import it. `docTabToMarkdown` calls
// the module's own `renderRun`, so the rendering of a tab in hand is untouched, and only the
// store's rendering of a run can fail.
vi.mock("../src/markdown-converter", async importOriginal => {
  let converter = await importOriginal<typeof import("../src/markdown-converter")>();
  let renderRun: typeof converter.renderRun = (elements, ...rest) => {
    if (fault.on && JSON.stringify(elements).includes("FAULT")) throw new Error("renderer fault");
    return converter.renderRun(elements, ...rest);
  };
  return { ...converter, renderRun };
});

const DOC = "doc";
const NONE: DocPending = { edits: [], roots: [] };
const APPEND: DocEdit = { type: "appendText", markdown: "FAULT" };

/** A pruned tab of one paragraph for each of `lines`, as Google sends one. */
function tabOf(...lines: string[]): GoogleDocsTab {
  let tab = pruneTab(buildTab(lines.map(para)));
  // Google sends no start index on the section break that opens a body.
  delete (tab.body.content[0] as { startIndex?: number }).startIndex;
  return tab;
}

const copyOf = (tab: GoogleDocsTab) =>
  wholeTabsFetched({ revision: "r1", fetchedAt: 1_000, tabs: [{ tab, writeMarkers: [] }] });

/** A tab of three paragraphs kept in a store of its own, and its base version. */
function kept() {
  let storage = fakeDocStorage();
  let store = new DocStore(storage);
  let tab = tabOf("One", "Two", "Three");
  let head = store.keep(DOC, copyOf(tab), NONE);
  let version = store.version(DOC, head.versions[0], { ...head.outline[0], writeMarkers: [] })!;
  return { storage, store, tab, version };
}

/** What `run` throws. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Nothing was thrown.");
}

describe("the renderer's fault on a tab the store renders as it stores it", () => {
  beforeEach(() => {
    fault.on = true;
  });

  it("refuses an edit whose tab after the renderer throws on, and stores the refusal", () => {
    let { storage, store, tab, version } = kept();
    let before = storage.rows();
    let refusal = docRefusal(new Error("renderer fault"));

    let thrown = thrownBy(() => docEditResult(store, version, APPEND));

    expect(thrown).toBeInstanceOf(DocEditRefusedError);
    expect((thrown as DocEditRefusedError).refusal).toEqual(refusal);
    expect(refusal).toEqual({ reason: "renderer fault" });
    expect(store.result(version, docEditKey(APPEND))).toEqual({ refusal });
    // Nothing of the version the edit would give is stored: the refusal alone was added.
    let after = storage.rows();
    expect(after.doc_result).toHaveLength(1);
    expect(after).toEqual({ ...before, doc_result: after.doc_result });

    // Asked again, the refusal is found stored: nothing is decoded and nothing rendered.
    let cost = { ...docStoreCost };
    let renders = replayCost.renders;
    let again = thrownBy(() => docEditResult(store, version, APPEND));
    expect(again).toBeInstanceOf(DocEditRefusedError);
    expect((again as DocEditRefusedError).refusal).toEqual(refusal);
    expect(docStoreCost.runsDecoded - cost.runsDecoded).toBe(0);
    expect(docStoreCost.runsRendered - cost.runsRendered).toBe(0);
    expect(replayCost.renders - renders).toBe(0);
    // The version the edit was made in reads whole.
    expect(store.markdown(version)).toBe(docTabToMarkdown(tab).markdown);
    expect(store.tab(version)).toEqual(tab);
  });

  it("refuses an edit whose tab before the renderer throws on", () => {
    fault.on = false;
    let storage = fakeDocStorage();
    let store = new DocStore(storage);
    let head = store.keep(DOC, copyOf(tabOf("One", "FAULT stands here", "Three")), NONE);
    let version = store.version(DOC, head.versions[0], { ...head.outline[0], writeMarkers: [] })!;
    let before = storage.rows();
    fault.on = true;
    let edit: DocEdit = { type: "appendText", markdown: "More" };

    // A piece marks what the renderer throws on a run of it; a preparation, which asks its
    // piece outside an edit's own `try`, is handed what the renderer threw, and stores
    // nothing.
    let unrendered = thrownBy(() => storedTabReading(store, version).piece("end"));
    expect(unrendered).toBeInstanceOf(DocRunRenderError);
    expect((unrendered as DocRunRenderError).cause).toEqual(new Error("renderer fault"));
    let prepared = thrownBy(() => prepareAppend(store, version, "More"));
    expect(prepared).toEqual(new Error("renderer fault"));
    expect(prepared).not.toBeInstanceOf(DocEditRefusedError);
    expect(storage.rows()).toEqual(before);

    // The piece of the tab around the edit is rendered for the builders, and the renderer
    // throws on a run of it.
    let thrown = thrownBy(() => docEditResult(store, version, edit));

    expect(thrown).toBeInstanceOf(DocEditRefusedError);
    expect((thrown as DocEditRefusedError).refusal).toEqual({ reason: "renderer fault" });
    expect(store.result(version, docEditKey(edit))).toEqual({ refusal: { reason: "renderer fault" } });
    // The refusal alone was added.
    let after = storage.rows();
    expect(after.doc_result).toHaveLength(1);
    expect(after).toEqual({ ...before, doc_result: after.doc_result });
  });

  it("passes a fault of storage as it is", () => {
    fault.on = false;
    let { storage, store, version } = kept();
    let before = storage.rows();
    // Storage refuses the statement that writes a run list: the list of the version the edit
    // gives.
    storage.refuse(statement => statement.startsWith("INSERT OR REPLACE INTO doc_seq"));

    let thrown = thrownBy(() => docEditResult(store, version, APPEND));

    expect(thrown).not.toBeInstanceOf(DocEditRefusedError);
    expect(thrown).not.toBeInstanceOf(DocRunRenderError);
    expect((thrown as Error).message).toBe("storage refused the write");
    storage.refuse(undefined);
    expect(store.result(version, docEditKey(APPEND))).toBeUndefined();
    expect(storage.rows()).toEqual(before);
  });

  it("a keep lets the renderer's fault pass, marked", () => {
    let { storage, store } = kept();
    let before = storage.rows();
    let faulty = tabOf("One", "FAULT in the document's own words", "Three");

    let thrown = thrownBy(() => store.keep("other", copyOf(faulty), NONE));

    expect(thrown).toBeInstanceOf(DocRunRenderError);
    let { message, cause, name } = thrown as DocRunRenderError;
    expect(name).toBe("DocRunRenderError");
    expect(cause).toEqual(new Error("renderer fault"));
    // The message is fixed, and holds nothing of the tab.
    expect(message).toBe("A run of the tab could not be rendered.");
    // Nothing of the document is stored.
    expect(store.head("other")).toBeUndefined();
    expect(storage.rows()).toEqual(before);
  });
});
