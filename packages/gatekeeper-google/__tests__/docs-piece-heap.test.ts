// What a queued edit of a stored Google Doc holds as live heap on a tab of 20,000 paragraphs:
// a small multiple of a run, or of its own text, at its peak; and nothing of a piece once a
// call has returned. Each measure is taken in a function of its own that answers numbers.

import { createSimulationStore } from "@gadgets/gatekeeper-kit/simulation-store";
import { afterEach, describe, expect, it } from "vitest";
import { storedTabReading } from "../src/docs-reading";
import { docTabReducer, tabEditRequests, type QueuedDocRecord } from "../src/docs-replay";
import { DocStore } from "../src/docs-store";
import {
  prepareAppend, prepareTableChange, prepareTextReplacement,
} from "../src/docs-table-actions";
import { MARKDOWN_RENDERING_VERSION } from "../src/markdown-converter";
import { fakeDocStorage, type FakeDocStorage } from "./doc-store-fake";
import { pieceShapeKept } from "./doc-store-scenarios";
import { collect, HEAP_MEASURED, inUse, observing } from "./heap-held";

const NONE = { edits: [], roots: [] };
const LABEL = "\"Main\" (t1)";
const LIMIT = { chars: 1 << 20, refusal: () => new Error("The card was refused.") };
const KIB = 1024;
const putsRendering = (query: string) => query.startsWith("INSERT INTO doc_md");
const comparesLists = (query: string) => query.startsWith("SELECT b.seq AS place");
const laterJob = () => new Promise(resolve => setImmediate(resolve));
const settled = () => Math.min(inUse(), inUse());

/**
 * How much more is in use at the first statement `at` chooses inside `call` than before it.
 * `call` builds its own store over the storage it is handed, so this frame holds numbers only.
 * @throws Where the statement is not reached: a measure of no statement is no measure.
 */
function heldAt(
  storage: FakeDocStorage, at: (query: string) => boolean, call: (observed: FakeDocStorage) => void,
): number {
  let reading: number | undefined;
  let before = settled();
  call(observing(storage, query => {
    if (at(query)) reading ??= settled() - before;
  }));
  if (reading === undefined) throw new Error("The moment was not reached.");
  return reading;
}

/**
 * The scenario's tab of 20,000 paragraphs, kept once a file: its storage, what the cases edit,
 * and the longest stored run's JSON in bytes at two a character (`run`). The tab itself is let go.
 */
type Kept = Omit<ReturnType<typeof pieceShapeKept>, "tab"> & { storage: FakeDocStorage; run: number };
let known: Kept | undefined;
function prose(): Kept {
  if (!known) {
    let storage = fakeDocStorage();
    let { tab: _tab, ...made } = pieceShapeKept(storage, "prose", 20_000);
    let { longest } = storage.sql.exec<{ longest: number }>(
      "SELECT MAX(LENGTH(json)) AS longest FROM doc_run").one();
    known = { ...made, storage, run: 2 * longest };
  }
  return known;
}

/** Removes what the last case stored, as a rejection sweeps it. */
const sweep = ({ storage }: { storage: FakeDocStorage }) => new DocStore(storage).sweep("doc", NONE);

/** A preparation of the scenario, made through `store`. */
type Prepare = (store: DocStore, kept: Kept) => unknown;
const replacement = (name: string): Prepare => (store, { base, edits }) => prepareTextReplacement(
  store, base, edits.replacements[name].oldMarkdown, edits.replacements[name].newMarkdown, LABEL, LIMIT);
const appended: Prepare = (store, { base }) => prepareAppend(store, base, "More");
const rowAdded: Prepare = (store, { base, edits }) => prepareTableChange(
  store, base, { method: "insertTableRows", lines: { table: edits.table, cells: [["added"]] } }, LABEL);
const tableAdded: Prepare = (store, { base, edits }) => prepareTableChange(
  store, base, { method: "insertTable", table: { rows: 1, columns: 1, cells: [["new"]], after: edits.after } },
  LABEL);

describe("what is in hand at the worst moment", HEAP_MEASURED, () => {
  // MADE: a rendering being stored inside `putSlice`, the edit's peak: the slice's runs, the
  // runs cut from them and the batch, under 3 runs. FOUND STORED (the same preparation again):
  // the comparison of the two versions' lists, the result and the card, under half a run.
  const PREPARED: Record<string, Prepare> = {
    "a replacement": replacement("replaceMiddle"),
    "a replacement in a run's first paragraph": replacement("replaceFirst"),
    "an append": appended,
    "a row added": rowAdded,
    "a table added after a line": tableAdded,
  };

  it.each(Object.keys(PREPARED))("%s holds runs and nothing of its piece", name => {
    let kept = prose();
    let prepare = (observed: FakeDocStorage) => void PREPARED[name](new DocStore(observed), kept);
    // Once before anything is measured: what a first use of the path allocates for good.
    prepare(kept.storage);
    sweep(kept);
    let made = heldAt(kept.storage, putsRendering, prepare);
    let found = heldAt(kept.storage, comparesLists, prepare);
    sweep(kept);

    expect(made).toBeGreaterThan(0);
    expect(made).toBeLessThan(3 * kept.run);
    expect(found).toBeLessThan(64 * KIB);
  });

  // The replacement of 945 paragraphs (over 0.45 MiB) by as much other text: at its peak,
  // inside `putSlice`, the batch and the runs as the model left them, a stated multiple of
  // the longer text at two bytes a character (`E`) and a run.
  it("a large edit holds a stated multiple of its text", () => {
    let kept = prose();
    let large = replacement("largeEdit");
    let { oldMarkdown, newMarkdown } = kept.edits.replacements.largeEdit;
    let text = 2 * Math.max(oldMarkdown.length, newMarkdown.length);
    large(new DocStore(kept.storage), kept);
    sweep(kept);

    let stored = heldAt(kept.storage, putsRendering, observed => void large(new DocStore(observed), kept));
    sweep(kept);

    expect(text).toBeGreaterThan(2 * 0.45 * (1 << 20));
    expect(stored).toBeGreaterThan(text);
    expect(stored).toBeLessThan(2.6 * text + kept.run);
  });
});

describe("nothing of a document is held once a call returns", HEAP_MEASURED, () => {
  const original = DocStore.prototype.piece;
  afterEach(() => {
    DocStore.prototype.piece = original;
  });

  /**
   * Makes `call` over a store whose every piece is watched: a weak reference to the source
   * map of each piece made, and nothing else of it. A plain wrapper and no spy: a spy keeps
   * what each call returned.
   */
  function watched<T>(call: (store: DocStore, kept: Kept) => T): { answer: T; pieces: WeakRef<object>[] } {
    let kept = prose();
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
    ["a row added", rowAdded],
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
    sweep(prose());
  });
});
