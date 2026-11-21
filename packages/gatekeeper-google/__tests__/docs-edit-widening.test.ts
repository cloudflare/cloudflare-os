// An edit whose first slice (`batchReach`'s guess) is made wrong on purpose gives what it gives
// with the guess right. Its own file, because it mocks the model for the whole file.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleDocsTab } from "../src/docs-api";
import { storedTabReading } from "../src/docs-reading";
import {
  docEditKey, DocEditRefusedError, docEditResult, type DocEdit,
} from "../src/docs-replay";
import type { RunSizes } from "../src/docs-runs";
import { DocStore, docStoreCost, type DocPending } from "../src/docs-store";
import { tableIdentity } from "../src/docs-tables";
import {
  linesWithTablesTab, RUNS_OF_THREE, scenarioTab, tinyTablesTab,
} from "./doc-store-scenarios";
import { kept } from "./docs-store-slice-shadow";

type Model = typeof import("../src/docs-model");

/** What stands in for the model's two functions an edit calls, where a test sets one. */
const hooks = vi.hoisted(() => ({
  original: undefined as Model | undefined,
  batchReach: undefined as Model["batchReach"] | undefined,
  slice: undefined as Model["applyDocsRequestsToSlice"] | undefined,
}));

vi.mock("../src/docs-model", async importOriginal => {
  let model = await importOriginal<Model>();
  hooks.original = model;
  let batchReach: Model["batchReach"] = requests => (hooks.batchReach ?? model.batchReach)(requests);
  let applyDocsRequestsToSlice: Model["applyDocsRequestsToSlice"] = (...given) =>
    (hooks.slice ?? model.applyDocsRequestsToSlice)(...given);
  return { ...model, batchReach, applyDocsRequestsToSlice };
});

const NONE: DocPending = { edits: [], roots: [] };
const LINES = Array.from({ length: 12 }, (_, at) => `Line ${String(at).padStart(2, "0")}.`);
/** Twelve lines cut into seven runs of one to three elements: the third holds `Line 05.` alone. */
const keptLines = () => kept(scenarioTab("t1", LINES), RUNS_OF_THREE);
/** An edit inside the paragraph of the third run. */
const THIRD: DocEdit = { type: "replaceText", oldMarkdown: "05", newMarkdown: "five" };
/** A reach that names nothing: the first slice is the tab's first run. */
const noReach: Model["batchReach"] = () => undefined;
const MODEL_FAULT = "replaceText: this change cannot be shown as it will read once applied, " +
  "so it cannot be made through this connection. Make it in Google Docs.";

/** What `run` throws, which must be a refusal of the edit. */
function refusedBy(run: () => unknown): DocEditRefusedError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DocEditRefusedError);
    return error as DocEditRefusedError;
  }
  throw new Error("Nothing was thrown.");
}

/** What `run` moved of the runs decoded and rendered and of the widenings. */
function moved(run: () => unknown) {
  let before = { ...docStoreCost };
  run();
  return {
    runsDecoded: docStoreCost.runsDecoded - before.runsDecoded,
    runsRendered: docStoreCost.runsRendered - before.runsRendered,
    viewWidenings: docStoreCost.viewWidenings - before.viewWidenings,
  };
}

describe("an edit whose first slice does not hold what its batch reads", () => {
  afterEach(() => {
    hooks.batchReach = undefined;
    hooks.slice = undefined;
    vi.restoreAllMocks();
  });

  it("a slice edge is never a refusal", () => {
    let straight = keptLines();
    let want = docEditResult(straight.store, straight.base, THIRD);

    let { storage, store, base } = keptLines();
    hooks.batchReach = noReach;
    let made!: ReturnType<typeof docEditResult>;
    let cost = moved(() => made = docEditResult(store, base, THIRD));

    // The builders' piece (1 tried, 4 made); the model's slice widened once (1, then 3).
    expect(cost).toMatchObject({ viewWidenings: 1, runsDecoded: (1 + 4) + (1 + 3) });
    let stored = store.result(base, docEditKey(THIRD));
    expect(stored).toEqual({ requests: want.requests, after: made.after });
    expect(storage.rows().doc_result).toHaveLength(1);
    expect(made.requests).toEqual(want.requests);
    expect(store.tab(made.after)).toEqual(straight.store.tab(want.after));
    expect(store.markdown(made.after)).toBe(straight.store.markdown(want.after));
  });

  it("a refused batch that widens stores its refusal and nothing else", () => {
    // Thrown by the model once the slice holds what the batch reads.
    let refusal = new Error("Index 4 must be less than the end index.");
    hooks.slice = (...given) => {
      hooks.original!.applyDocsRequestsToSlice(...given);
      throw refusal;
    };
    let straight = keptLines();
    let want = refusedBy(() => docEditResult(straight.store, straight.base, THIRD));

    let { storage, store, base } = keptLines();
    let before = storage.rows();
    hooks.batchReach = noReach;
    let got!: DocEditRefusedError;
    let cost = moved(() => got = refusedBy(() => docEditResult(store, base, THIRD)));

    expect(cost.viewWidenings).toBe(1);
    expect(got.refusal).toEqual(want.refusal);
    expect(got.refusal.reason).toBe(
      "replaceText: Google Docs would refuse this change: Index 4 must be less than the end index.");
    expect(got.refusal.modelError?.name).toBe("Error");
    expect(store.result(base, docEditKey(THIRD))).toEqual({ refusal: got.refusal });
    let after = storage.rows();
    expect(after.doc_result).toHaveLength(1);
    expect(after).toEqual({ ...before, doc_result: after.doc_result });
  });

  it("no run left to widen to is a fault of the model", () => {
    let { store, base } = keptLines();
    // What `widen` does where no run is left on the edge's side: it throws the edge itself.
    vi.spyOn(DocStore.prototype, "widen").mockImplementation((_version, _held, edge) => {
      throw edge;
    });
    hooks.batchReach = noReach;

    let got = refusedBy(() => docEditResult(store, base, THIRD));

    expect(got.name).toBe("DocModelError");
    expect(got.refusal.reason).toBe(MODEL_FAULT);
    expect(got.refusal.modelError?.name).toBe("SliceEdgeError");
    // Nothing of what was thrown: no side, no index.
    expect(got.refusal.reason).not.toMatch(/\d|before|after/);
    expect(store.result(base, docEditKey(THIRD))).toEqual({ refusal: got.refusal });
  });

  it("a slice the model's exit check refuses stores no run", () => {
    let straight = keptLines();
    let want = docEditResult(straight.store, straight.base, THIRD);
    let what = "a slice whose elements do not follow one another from its origin";
    // The model changes the piece, and then its exit check throws.
    hooks.slice = (...given) => {
      hooks.original!.applyDocsRequestsToSlice(...given);
      throw new hooks.original!.NotModelledError(what, true);
    };
    let { storage, store, base } = keptLines();
    let before = storage.rows();
    let got!: DocEditRefusedError;
    let cost = moved(() => got = refusedBy(() => docEditResult(store, base, THIRD)));

    expect(cost.viewWidenings).toBe(0);
    expect(got.name).toBe("DocModelError");
    expect(got.refusal).toEqual({
      reason: `replaceText: this change cannot be shown as it will read once applied (${what}), ` +
        "so it cannot be made through this connection. Make it in Google Docs.",
      unmodelled: { what, invariant: true },
    });
    expect(store.result(base, docEditKey(THIRD))).toEqual({ refusal: got.refusal });
    // No run cut from the changed piece, no rendering, no list and no version.
    let after = storage.rows();
    expect(after.doc_result).toHaveLength(1);
    expect(after).toEqual({ ...before, doc_result: after.doc_result });

    // The same edit made again with the model as it is is the whole tab's.
    hooks.slice = undefined;
    store.sweep("doc", NONE);
    let made = docEditResult(store, base, THIRD);
    expect(store.tab(made.after)).toEqual(straight.store.tab(want.after));
    expect(made.requests).toEqual(want.requests);
  });

  // Teeth: the reach counts no index an earlier request of the batch moved.
  it("read as written, the builders' batches take runs they do not touch", () => {
    // Every request read alone and joined: the least `from`, the greatest `to`, every `behind`.
    let asWritten: Model["batchReach"] = requests => {
      let each = requests.flatMap(request => hooks.original!.batchReach([request]) ?? []);
      return each.length === 0 ? undefined : {
        from: Math.min(...each.map(reach => reach.from)), to: Math.max(...each.map(reach => reach.to)),
        behind: each.flatMap(reach => reach.behind),
      };
    };
    /** `edit` made in `tab` under each reach: what it decodes and renders, and what it gives. */
    let both = (tab: GoogleDocsTab, edit: (expected: string) => DocEdit, sizes?: RunSizes) => {
      let { store, base } = kept(tab, sizes);
      let table = tab.tabId === "t2" ? 99 : 0;
      let piece = storedTabReading(store, base).piece({ table });
      let { mdStart, mdEnd } = piece.sourceMap.tables[table - piece.part!.tablesBefore];
      let change = edit(tableIdentity(piece.markdown.slice(mdStart, mdEnd)));
      return [undefined, asWritten].map(reach => {
        hooks.batchReach = reach;
        let made!: ReturnType<typeof docEditResult>;
        let cost = moved(() => made = docEditResult(store, base, change));
        let read = {
          cost, requests: made.requests, tab: JSON.stringify(store.tab(made.after)),
          markdown: store.markdown(made.after),
        };
        store.sweep("doc", NONE);
        return read;
      });
    };
    /** Holds that the reach chose what was decoded and nothing else. */
    let sameOutcome = ([original, written]: ReturnType<typeof both>) => {
      expect(written.requests).toEqual(original.requests);
      expect(written.tab).toBe(original.tab);
      expect(written.markdown).toBe(original.markdown);
    };
    let lines = Array.from({ length: 2_000 }, (_, at) => `Line ${String(at).padStart(5, "0")}.`);
    let tabled = linesWithTablesTab("t1", lines, [1_000]);
    // The builders' piece around the table: 1 tried, 3 made.
    const TABLED = 1 + 3;

    // A row added with text, written past the table's stored end: as written, one run more.
    let row = both(tabled, expected => ({ type: "insertTableRows", at: 1, cells: [["added"]], expected }));
    expect(row.map(({ cost }) => cost)).toEqual([
      { runsDecoded: TABLED, runsRendered: TABLED + 1, viewWidenings: 0 },
      { runsDecoded: TABLED + 1, runsRendered: TABLED + 2, viewWidenings: 0 },
    ]);
    sameOutcome(row);

    // A growing replacement before the table, whose styling as written reaches past it.
    let growing = both(tabled, () => ({
      type: "replaceText", oldMarkdown: lines[999], newMarkdown: "G".repeat(45),
    }));
    expect(growing.map(({ cost }) => cost)).toEqual([
      { runsDecoded: 3, runsRendered: 3 + 1, viewWidenings: 0 },
      { runsDecoded: 3 + 2, runsRendered: 3 + 3, viewWidenings: 0 },
    ]);
    sameOutcome(growing);

    // A long row added to the hundredth of 200 tables: as written, 72 runs more.
    const MANY = 1 + 2 + 3 + 5 + 9;
    let many = both(tinyTablesTab("t2", 200), expected => ({
      type: "insertTableRows", at: 1, cells: [["x".repeat(500)]], expected,
    }));
    expect(many.map(({ cost }) => cost)).toEqual([
      { runsDecoded: MANY, runsRendered: MANY + 1, viewWidenings: 0 },
      { runsDecoded: MANY + 72, runsRendered: MANY + 73, viewWidenings: 0 },
    ]);
    sameOutcome(many);
  });
});
