// The limits of a Drive connection's Doc copies: the count and byte caps, eviction order and
// what an eviction leaves; the expiry pass (no approved read for 7 days); and the removal of a
// copy whose record is still the one a refusal saw.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copiesOverCap, DOC_COPY_EXPIRY_PASS_KEY, DRIVE_DOC_COPY_EXPIRY_MS, DRIVE_DOC_EXPIRY_CALL_BYTES,
  driveDocCopies, DriveDocCopyLimits, existingDocStore, lazyDocStore, MAX_DRIVE_DOC_COPIES,
  MAX_DRIVE_DOC_COPY_BYTES, storedDocCopy, type DocCopyRemoval,
} from "../src/docs-copy";
import { docEditKey, docEditResult, type DocEdit } from "../src/docs-replay";
import { DOC_COPY_UNREADABLE } from "../src/docs-replica";
import {
  DOC_COPY_APPROVAL_GRAIN_MS, DOC_ROW_BYTES, DocRowTooLargeError, DocStore, docStoreCost,
  type DocCopyRecord, type DocPending,
} from "../src/docs-store";
import { fakeDocStorage, type FakeDocStorage } from "./doc-store-fake";
import {
  countedStorage, EXPIRY_COST, EXPIRY_COST_PAIRS, expiryCostScenario, scenarioBase, scenarioCopy,
  scenarioDocument, scenarioEdit, scenarioTab, storedRows, tableScans, type ExpiryCase,
} from "./doc-store-scenarios";

const NONE: DocPending = { edits: [], roots: [] };
const HOUR = DOC_COPY_APPROVAL_GRAIN_MS;
const MIB = 1024 * 1024;
type Caps = { readonly count: number; readonly bytes: number };
const NO_CAP: Caps = { count: Infinity, bytes: Infinity };

/** A document of one short paragraph that says `text`, as a keep takes it. */
const small = (text: string) => scenarioCopy([scenarioTab("t1", [text])]);
/** What every one-paragraph document of a five-letter text counts as its bytes. */
const ONE = new DocStore(fakeDocStorage()).keep("probe", small("doc-a"), NONE).bytes;

/**
 * A connection's limits under `caps` (its own by default). `keep` keeps a one-paragraph `doc`
 * approved at `hour`; `removed` lists each removal told, whether in a transaction and still held.
 */
function connection(caps?: Caps, storage: FakeDocStorage = fakeDocStorage()) {
  let open = 0;
  let watched: FakeDocStorage = {
    ...storage,
    transactionSync(callback) {
      open++;
      try {
        return storage.transactionSync(callback);
      } finally {
        open--;
      }
    },
  };
  let store = new DocStore(watched);
  let pending = new Set<string>();
  let removed: { doc: string; why: DocCopyRemoval; inTransaction: boolean; held: boolean }[] = [];
  let limits = new DriveDocCopyLimits({
    store: () => store,
    pendingDocs: () => pending,
    removed: (doc, why) => removed.push({
      doc, why, inTransaction: open > 0, held: store.head(doc) !== undefined,
    }),
    ...(caps ? { caps } : {}),
    kv: storage.kv,
  });
  return {
    storage, store, limits, pending, removed,
    keep: (doc: string, hour: number, document = small(doc)) =>
      limits.keep(doc, document, NONE, { at: hour * HOUR }),
    /** The documents the store holds a copy of, by key. */
    docs: () => store.copies().map(({ doc }) => doc).toSorted(),
    /** What the limits told of so far, as `[doc, reason]`. */
    evicted: () => removed.map(({ doc, why }) => [doc, why.reason]),
  };
}

/** Sets the bytes the record of `doc`'s copy says, as a document of that size would have. */
function sayBytes(storage: FakeDocStorage, doc: string, bytes: number): void {
  storage.sql.exec("UPDATE doc_copy SET bytes = ? WHERE doc = ?", bytes, doc).toArray();
}

describe("copiesOverCap", () => {
  const record = (doc: string, approvedAt: number | undefined, bytes = 10, fetchedAt = 0): DocCopyRecord =>
    ({ doc, ...(approvedAt === undefined ? {} : { approvedAt }), fetchedAt, bytes });
  const THREE = [record("a", 1), record("b", 2), record("c", 3)];
  const none = new Set<string>();

  it.each<[string, DocCopyRecord[], string, string[], Caps, [string, string][]]>([
    ["under both caps", THREE, "c", [], { count: 3, bytes: 30 }, []],
    ["over the count alone", THREE, "c", [], { count: 2, bytes: 30 }, [["a", "count"]]],
    ["over the bytes alone", THREE, "c", [], { count: 3, bytes: 29 }, [["a", "bytes"]]],
    ["over both: the count's first, then the bytes'", THREE, "c", [], { count: 2, bytes: 10 },
      [["a", "count"], ["b", "bytes"]]],
    ["the oldest approval first, whatever the order given",
      [record("c", 3), record("a", 1), record("d", 4), record("b", 2)], "d", [],
      { count: 1, bytes: 99 }, [["a", "count"], ["b", "count"], ["c", "count"]]],
    ["a copy with no approval before every other", [record("a", 0), record("b", undefined), record("c", 3)],
      "c", [], { count: 1, bytes: 99 }, [["b", "count"], ["a", "count"]]],
    ["the older fetch first among copies approved in one hour",
      [record("a", 5, 10, 30), record("b", 5, 10, 20), record("c", 5, 10, 40), record("d", 9)], "d", [],
      { count: 1, bytes: 99 }, [["b", "count"], ["a", "count"], ["c", "count"]]],
    ["the key first among copies approved in one hour and fetched at one clock",
      [record("b", 5), record("a", 5), record("c", 5), record("d", 9)], "d", [],
      { count: 2, bytes: 99 }, [["a", "count"], ["b", "count"]]],
    ["a file with pending edits after every file with none",
      THREE, "c", ["a"], { count: 2, bytes: 30 }, [["b", "count"]]],
    ["only files with pending edits left: the oldest of them",
      THREE, "c", ["a", "b"], { count: 1, bytes: 30 }, [["a", "count"], ["b", "count"]]],
    ["a file with pending edits once every file with none has gone",
      [...THREE, record("d", 4)], "d", ["a"], { count: 4, bytes: 15 },
      [["b", "bytes"], ["c", "bytes"], ["a", "bytes"]]],
    ["never the document being kept, though it is the oldest and the largest",
      [record("a", 0, 500), record("b", 2), record("c", 3)], "a", [], { count: 1, bytes: 20 },
      [["b", "count"], ["c", "count"]]],
    ["one document over the byte cap by itself: every other copy goes, and it stays",
      [record("a", 1), record("b", 2), record("c", 3, 500)], "c", [], { count: 3, bytes: 100 },
      [["a", "bytes"], ["b", "bytes"]]],
    ["a document being kept that the records do not list", THREE, "d", [], { count: 2, bytes: 30 },
      [["a", "count"]]],
    ["no copy at all", [], "a", [], { count: 0, bytes: 0 }, []],
  ])("%s", (_case, copies, keeping, pending, caps, expected) => {
    let given = structuredClone(copies);

    expect(copiesOverCap(copies, keeping, new Set(pending), caps).map(({ doc, reason }) => [doc, reason]))
      .toEqual(expected);
    // The records are read, never reordered.
    expect(copies).toEqual(given);
  });

  it("names no copy while the connection is at a cap, and one once it is past it", () => {
    expect(copiesOverCap(THREE, "c", none, { count: 3, bytes: 30 })).toEqual([]);
    expect(copiesOverCap([...THREE, record("d", 4, 1)], "d", none, { count: 4, bytes: 30 }))
      .toEqual([{ doc: "a", reason: "bytes" }]);
  });
});

describe("DriveDocCopyLimits.keep", () => {
  it("evicts the copy whose last approved read is oldest when a keep passes the count", () => {
    let { keep, docs, evicted, store } = connection({ count: 2, bytes: Infinity });
    keep("doc-b", 2);
    keep("doc-a", 1);
    expect(evicted()).toEqual([]);

    let head = keep("doc-c", 3);

    expect(evicted()).toEqual([["doc-a", "count"]]);
    expect(docs()).toEqual(["doc-b", "doc-c"]);
    // The answer is the record of the document kept.
    expect(head).toEqual(store.head("doc-c"));
    expect(head).toMatchObject({ approvedAt: 3 * HOUR, bytes: ONE });
  });

  it("evicts the copy whose last approved read is oldest when a keep passes the bytes", () => {
    let { keep, docs, evicted } = connection({ count: 100, bytes: 2.5 * ONE });
    keep("doc-a", 1);
    keep("doc-b", 2);
    expect(evicted()).toEqual([]);

    keep("doc-c", 3);

    expect(evicted()).toEqual([["doc-a", "bytes"]]);
    expect(docs()).toEqual(["doc-b", "doc-c"]);
  });

  it("orders by the approval a later read recorded, not by the keep", () => {
    let { keep, docs, evicted, store } = connection({ count: 2, bytes: Infinity });
    keep("doc-a", 1);
    keep("doc-b", 2);
    // A read of the first copy approved again, as `approvedUnder` records it.
    store.touch("doc-a", { approved: { at: 3 * HOUR } });

    keep("doc-c", 4);

    expect(evicted()).toEqual([["doc-b", "count"]]);
    expect(docs()).toEqual(["doc-a", "doc-c"]);
  });

  it("evicts until it is under both", () => {
    let storage = fakeDocStorage();
    let before = connection(NO_CAP, storage);
    for (let [at, doc] of ["doc-a", "doc-b", "doc-c"].entries()) before.keep(doc, at + 1);
    let { keep, docs, evicted } = connection({ count: 3, bytes: 1.5 * ONE }, storage);

    keep("doc-d", 4);

    // Four copies against three, and then three and two copies' bytes against one and a half.
    expect(evicted()).toEqual([["doc-a", "count"], ["doc-b", "bytes"], ["doc-c", "bytes"]]);
    expect(docs()).toEqual(["doc-d"]);
  });

  it("keeps a file with pending edits while a file with none can go, and evicts it when none can", () => {
    let { keep, docs, evicted, pending } = connection({ count: 2, bytes: Infinity });
    keep("doc-a", 1);
    keep("doc-b", 2);
    pending.add("doc-a");

    keep("doc-c", 3);
    expect(evicted()).toEqual([["doc-b", "count"]]);
    expect(docs()).toEqual(["doc-a", "doc-c"]);

    // Every copy but the one being kept has a pending edit: the oldest of them goes.
    pending.add("doc-c");
    keep("doc-d", 4);
    expect(evicted()).toEqual([["doc-b", "count"], ["doc-a", "count"]]);
    expect(docs()).toEqual(["doc-c", "doc-d"]);
  });

  it("never evicts the document it keeps", () => {
    let { keep, docs, evicted } = connection({ count: 1, bytes: Infinity });
    keep("doc-a", 5);

    // Its approval is the oldest of the two.
    keep("doc-b", 1);
    expect(evicted()).toEqual([["doc-a", "count"]]);
    expect(docs()).toEqual(["doc-b"]);

    // Kept again, it replaces its own copy and nothing is over a cap.
    keep("doc-b", 1);
    expect(evicted()).toHaveLength(1);
    expect(docs()).toEqual(["doc-b"]);
  });

  it("keeps one document larger than the byte cap alone", () => {
    let { keep, docs, evicted, store } = connection({ count: 100, bytes: ONE / 2 });

    keep("doc-a", 1);
    expect(evicted()).toEqual([]);
    expect(store.head("doc-a")?.bytes).toBeGreaterThan(ONE / 2);

    // Another such document: the first goes, and the one kept stays though it is over the cap.
    keep("doc-b", 2);
    expect(evicted()).toEqual([["doc-a", "bytes"]]);
    expect(docs()).toEqual(["doc-b"]);
  });

  it("evicts when a copy grew at a refetch", () => {
    let { keep, docs, evicted, store } = connection({ count: 100, bytes: 3.5 * ONE });
    for (let [at, doc] of ["doc-a", "doc-b", "doc-c"].entries()) keep(doc, at + 1);
    expect(evicted()).toEqual([]);

    // The second document fetched again, a paragraph longer by one document's bytes.
    let grown = keep("doc-b", 4, small(`doc-b${"x".repeat(ONE)}`));

    // About twice a small document: over the cap with two others, under it with one.
    expect(grown.bytes).toBeGreaterThan(1.5 * ONE);
    expect(grown.bytes).toBeLessThan(2.5 * ONE);
    expect(evicted()).toEqual([["doc-a", "bytes"]]);
    expect(docs()).toEqual(["doc-b", "doc-c"]);
    expect(store.head("doc-b")).toEqual(grown);
  });

  it("evicts many copies in one keep", () => {
    let { keep, docs, evicted, removed } = connection({ count: 100, bytes: 60 * ONE });
    let names = Array.from({ length: 51 }, (_, at) => `doc${String(at).padStart(2, "0")}`);
    // Approved newest first, so the order is the approvals' and not the keys'.
    for (let [at, doc] of names.entries()) keep(doc, 100 - at);
    expect(evicted()).toEqual([]);

    // The copy approved last grows past the cap by itself: the fifty others go.
    keep("doc00", 101, small("x".repeat(61 * ONE)));

    expect(evicted()).toEqual(names.slice(1).toReversed().map(doc => [doc, "bytes"]));
    expect(docs()).toEqual(["doc00"]);
    expect(removed.every(({ why }) => why.event === "evicted")).toBe(true);
  });

  it("tells `removed` once for each copy, after the transaction, with the cap it passed", () => {
    let storage = fakeDocStorage();
    let before = connection(NO_CAP, storage);
    for (let [at, doc] of ["doc-a", "doc-b", "doc-c"].entries()) before.keep(doc, at + 1);
    let { keep, removed } = connection({ count: 3, bytes: 2.5 * ONE }, storage);

    keep("doc-d", 4);

    expect(removed).toEqual([
      { doc: "doc-a", why: { event: "evicted", reason: "count" }, inTransaction: false, held: false },
      { doc: "doc-b", why: { event: "evicted", reason: "bytes" }, inTransaction: false, held: false },
    ]);
  });

  it("leaves no row of an evicted document: the storage reads as one that never kept it", () => {
    let { keep, store, storage, evicted } = connection({ count: 2, bytes: Infinity });
    let first = keep("doc-a", 1, scenarioCopy([scenarioTab("t1", ["One", "Two"], ["An item"]), scenarioTab("t2", ["Notes"])]));
    // An edit made in it, and one in what that gave: versions, results and renderings.
    scenarioEdit(store, scenarioEdit(store, scenarioBase(store, "doc-a", first), "e1"), "e2");
    keep("doc-b", 2);
    let rowsOfFirst = () => storage.sql.exec<{ rows: number }>(
      `SELECT (SELECT count(*) FROM doc_run WHERE doc = 'doc-a') + (SELECT count(*) FROM doc_md WHERE doc = 'doc-a')
         + (SELECT count(*) FROM doc_version WHERE doc = 'doc-a') AS rows`).one().rows;
    expect(rowsOfFirst()).toBeGreaterThan(8);
    expect(storage.rows().doc_result).toHaveLength(2);

    keep("doc-c", 3);

    expect(evicted()).toEqual([["doc-a", "count"]]);
    let control = connection(NO_CAP);
    control.keep("doc-b", 2);
    control.keep("doc-c", 3);
    expect(rowsOfFirst()).toBe(0);
    expect(storedRows(storage)).toBe(storedRows(control.storage));
  });

  it("undoes the keep and evicts nothing when the keep throws", () => {
    let { keep, docs, evicted, storage } = connection({ count: 2, bytes: Infinity });
    keep("doc-a", 1);
    keep("doc-b", 2);
    let before = storedRows(storage);

    // A paragraph past a row.
    expect(() => keep("doc-c", 3, small("x".repeat(DOC_ROW_BYTES)))).toThrow(DocRowTooLargeError);

    expect(storedRows(storage)).toBe(before);
    expect(evicted()).toEqual([]);
    expect(docs()).toEqual(["doc-a", "doc-b"]);
  });

  it("undoes the keep when a drop is refused", () => {
    let { keep, docs, evicted, storage, store } = connection({ count: 2, bytes: Infinity });
    keep("doc-a", 1);
    keep("doc-b", 2);
    let before = storedRows(storage);

    // The last statement of the eviction's drop.
    storage.refuse(statement => statement.startsWith("DELETE FROM doc_copy"));
    expect(() => keep("doc-c", 3)).toThrow("storage refused the write");
    storage.refuse(undefined);

    // Neither the document kept nor the eviction is committed, and nothing was told.
    expect(storedRows(storage)).toBe(before);
    expect(store.head("doc-c")).toBeUndefined();
    expect(evicted()).toEqual([]);

    keep("doc-c", 3);
    expect(evicted()).toEqual([["doc-a", "count"]]);
    expect(docs()).toEqual(["doc-b", "doc-c"]);
  });
});

describe("a Drive connection's caps as the connection has them", () => {
  it("the 201st document evicts the one read first", () => {
    let { keep, docs, evicted, store } = connection();
    let names = Array.from({ length: MAX_DRIVE_DOC_COPIES }, (_, at) => `doc-${String(at).padStart(3, "0")}`);
    for (let [at, doc] of names.entries()) keep(doc, at + 1);
    expect(evicted()).toEqual([]);
    expect(store.copies()).toHaveLength(200);

    keep("doc-200", 201);

    expect(evicted()).toEqual([["doc-000", "count"]]);
    expect(docs()).toEqual([...names.slice(1), "doc-200"]);

    // The first read again: the copy whose approval is then the oldest goes.
    keep("doc-000", 202);
    expect(evicted()).toEqual([["doc-000", "count"], ["doc-001", "count"]]);
    expect(store.copies()).toHaveLength(MAX_DRIVE_DOC_COPIES);
  });

  it("a keep that brings the records' bytes past 512 MiB evicts the oldest until under", () => {
    let { keep, docs, evicted, storage } = connection();
    keep("doc-a", 1);
    keep("doc-b", 2);
    // The figure is the records': no megabyte of content is stored.
    sayBytes(storage, "doc-a", 300 * MIB);
    sayBytes(storage, "doc-b", 200 * MIB);

    keep("doc-c", 3);
    expect(evicted()).toEqual([]);

    sayBytes(storage, "doc-c", 100 * MIB);
    expect(MAX_DRIVE_DOC_COPY_BYTES).toBe(512 * MIB);
    keep("doc-d", 4);

    // 600 MiB and a document: the oldest goes, and 300 MiB and a document are under.
    expect(evicted()).toEqual([["doc-a", "bytes"]]);
    expect(docs()).toEqual(["doc-b", "doc-c", "doc-d"]);

    // At the cap to the byte nothing goes; a byte past it, the oldest.
    sayBytes(storage, "doc-b", 412 * MIB - ONE);
    sayBytes(storage, "doc-d", 0);
    keep("doc-e", 5);
    expect(evicted()).toHaveLength(1);
    sayBytes(storage, "doc-d", 1);
    keep("doc-e", 5);
    expect(evicted()).toEqual([["doc-a", "bytes"], ["doc-b", "bytes"]]);
  });
});

describe("driveDocCopies under a connection's limits", () => {
  const EDIT: DocEdit = { type: "replaceText", oldMarkdown: "one", newMarkdown: "uno" };
  /** A document of one paragraph that says `text`, as Google answers one. */
  const answer = (text: string, revision = "r1") => scenarioDocument([scenarioTab("t1", [text])], revision);

  // `keep` takes the clock of its approval itself: the tenth hour, after the three copies'.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(10 * HOUR);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A connection over a cap of two holding `doc-a`, `doc-b`, `doc-c` (approved in order), and `doc`'s copies. */
  function overCap(doc: string, pending: () => DocPending = () => NONE) {
    let storage = fakeDocStorage();
    let before = connection(NO_CAP, storage);
    for (let [at, name] of ["doc-a", "doc-b", "doc-c"].entries()) before.keep(name, at + 1);
    let capped = connection({ count: 2, bytes: Infinity }, storage);
    let copies = driveDocCopies(() => capped.store, doc, pending, capped.limits);
    return { ...capped, copies };
  }

  it("a trial evicts nothing, though the connection is over a cap", () => {
    let { copies, storage, store, evicted } = overCap("doc-d");
    let before = storedRows(storage);
    let inside: { copies: string[]; versions: number } | undefined;
    let tried = () => ({
      copies: store.copies().map(({ doc }) => doc).toSorted(),
      versions: storage.sql.exec("SELECT id FROM doc_version WHERE doc = 'doc-d'").toArray().length,
    });

    copies.trial(copies.hold(answer("doc-d"), 10), () => { inside = tried(); });

    // The document was stored for the trial, beside every copy, and is gone with it.
    expect(inside).toEqual({ copies: ["doc-a", "doc-b", "doc-c"], versions: 1 });
    expect(storedRows(storage)).toBe(before);
    expect(evicted()).toEqual([]);

    // A fetch no scope check guards is a trial too.
    copies.tryFetched(answer("doc-d"), 11, () => { inside = tried(); });
    expect(inside).toEqual({ copies: ["doc-a", "doc-b", "doc-c"], versions: 1 });
    expect(storedRows(storage)).toBe(before);
    expect(evicted()).toEqual([]);
  });

  it("a first read stores the document in its trial and again in its keep, and the caps are " +
      "applied by the keep", () => {
    let { copies, storage, docs, evicted } = overCap("doc-d");
    let runsWritten = () => storage.sql.exec("SELECT id FROM doc_run WHERE doc = 'doc-d'").toArray().length;
    let held = copies.hold(answer("doc-d"), 10);
    let stored = 0;

    // The read's answer, before its scope check: tried, and nothing evicted.
    copies.trial(held, () => { stored = runsWritten(); });
    expect(stored).toBeGreaterThan(0);
    expect(runsWritten()).toBe(0);
    expect(evicted()).toEqual([]);
    expect(docs()).toEqual(["doc-a", "doc-b", "doc-c"]);

    // The scope check passed: the document is stored again, and the connection brought under.
    let view = copies.keep(held, "folder");
    expect(runsWritten()).toBe(stored);
    expect(view?.held()).toBe(true);
    expect(evicted()).toEqual([["doc-a", "count"], ["doc-b", "count"]]);
    expect(docs()).toEqual(["doc-c", "doc-d"]);
  });

  it("a keep that leaves a later copy in place stores nothing and evicts nothing", () => {
    let { copies, storage, docs, evicted, store } = overCap("doc-c");
    let before = storedRows(storage);
    // The stored copy of the file was fetched at 1,000: a slow read's document from before it.
    let slow = copies.hold(answer("doc-c"), 10);

    expect(copies.keep(slow)?.held()).toBe(true);

    // The approval is recorded on the stored copy, and that is all.
    expect(store.head("doc-c")?.approvedAt).toBe(10 * HOUR);
    storage.sql.exec("UPDATE doc_copy SET approved = ? WHERE doc = 'doc-c'", 3 * HOUR).toArray();
    expect(storedRows(storage)).toBe(before);
    expect(evicted()).toEqual([]);
    expect(docs()).toEqual(["doc-a", "doc-b", "doc-c"]);
    // Another document of the file from before the stored one is refused, and evicts nothing.
    expect(copies.keep(copies.hold(answer("another"), 10))).toBeUndefined();
    expect(evicted()).toEqual([]);
  });

  it("a keep without limits caps nothing", () => {
    let { store, docs, evicted } = overCap("doc-d");

    for (let doc of ["doc-d", "doc-e"]) {
      let copies = driveDocCopies(() => store, doc);
      expect(copies.keep(copies.hold(answer(doc), 10))?.held()).toBe(true);
    }

    expect(docs()).toEqual(["doc-a", "doc-b", "doc-c", "doc-d", "doc-e"]);
    expect(evicted()).toEqual([]);
  });

  it("a view of an evicted copy finds it not held and reads no tab", () => {
    let { copies, store, limits, evicted } = overCap("doc-d");
    let view = copies.keep(copies.hold(answer("doc-d"), 10))!;
    expect(view.held()).toBe(true);
    expect(view.tab("t1")).toBeDefined();

    // Another file's keep evicts it: its approval is then the oldest.
    store.touch("doc-c", { approved: { at: 11 * HOUR } });
    vi.setSystemTime(12 * HOUR);
    let other = driveDocCopies(() => store, "doc-e", () => NONE, limits);
    other.keep(other.hold(answer("doc-e"), 20));

    expect(evicted().at(-1)).toEqual(["doc-d", "count"]);
    expect(view.held()).toBe(false);
    expect(() => view.tab("t1")).toThrow(DOC_COPY_UNREADABLE);
    expect(store.head("doc-d")).toBeUndefined();
  });

  it("the pending edits of an evicted file are made again and read the same", () => {
    let pending: DocPending = { edits: [docEditKey(EDIT)], roots: [] };
    let { copies, store, limits, evicted, pending: pendingDocs } = overCap("doc-d", () => pending);
    let made = (run: () => string) => {
      let before = docStoreCost.resultsStored;
      let markdown = run();
      return { markdown, stored: docStoreCost.resultsStored - before };
    };
    let read = () => {
      let view = copies.keep(copies.hold(answer("one"), 10))!;
      return made(() => view.markdown(docEditResult(store, view.tab("t1")!, EDIT).after));
    };
    pendingDocs.add("doc-d");

    let first = read();
    expect(first).toEqual({ markdown: "uno\n", stored: 1 });
    // Read again while the copy stands, the edit's result is found stored.
    let view = storedDocCopy(store, "doc-d", store.head("doc-d")!);
    expect(made(() => view.markdown(docEditResult(store, view.tab("t1")!, EDIT).after)))
      .toEqual({ markdown: "uno\n", stored: 0 });

    // Another file's keep, every other copy pending too: the file's copy goes with its edit.
    for (let doc of ["doc-c", "doc-e"]) pendingDocs.add(doc);
    store.touch("doc-c", { approved: { at: 11 * HOUR } });
    vi.setSystemTime(12 * HOUR);
    let other = driveDocCopies(() => store, "doc-e", () => NONE, limits);
    other.keep(other.hold(answer("doc-e"), 20));
    expect(evicted().at(-1)).toEqual(["doc-d", "count"]);
    expect(store.head("doc-d")).toBeUndefined();

    // The file's next read fetched and keeps: the edit is made once more, and reads the same.
    expect(read()).toEqual(first);
  });
});

describe("DriveDocCopyLimits.expire", () => {
  const DAY = 24 * HOUR, MINUTE = 60_000;
  const WEEK = DRIVE_DOC_COPY_EXPIRY_MS;

  /**
   * A connection's limits on a clock the test moves. `pass` runs the expiry pass at `at` (as a
   * read of `reading`, if named) and answers its statements, rows answered and KV keys touched;
   * `removed` as in `connection`; `expiryCallBytes` is what one call drops.
   */
  function expiring(storage: FakeDocStorage = fakeDocStorage(), expiryCallBytes?: number) {
    let open = 0;
    let ran: string[] = [];
    let counted = countedStorage({
      sql: {
        exec: (query: string, ...bindings: unknown[]) => {
          ran.push(query);
          return storage.sql.exec(query, ...bindings);
        },
      },
      transactionSync(callback) {
        open++;
        try {
          return storage.transactionSync(callback);
        } finally {
          open--;
        }
      },
    } as FakeDocStorage);
    let store = new DocStore(counted.storage);
    let clock = { at: 0 };
    let read: string[] = [];
    let removed: { doc: string; why: DocCopyRemoval; inTransaction: boolean; held: boolean }[] = [];
    let limits = (lazy: () => DocStore = () => store) => new DriveDocCopyLimits({
      store: lazy,
      pendingDocs: () => new Set(),
      removed: (doc, why) => removed.push({
        doc, why, inTransaction: open > 0,
        // Asked of the storage itself, so that a pass's statements are the limits' alone.
        held: storage.sql.exec("SELECT 1 AS found FROM doc_copy WHERE doc = ?", doc).toArray().length > 0,
      }),
      kv: {
        get: <T>(key: string) => {
          read.push(key);
          return storage.kv.get<T>(key);
        },
        put: (key, value) => storage.kv.put(key, value),
      },
      now: () => clock.at,
      ...(expiryCallBytes === undefined ? {} : { expiryCallBytes }),
    });
    let first = limits();
    return {
      storage, store, clock, removed, limits,
      keep: (doc: string, at: number) => store.keep(doc, small(doc), NONE, { at }),
      pass(at: number, over: DriveDocCopyLimits = first, reading?: string) {
        clock.at = at;
        let before = { ran: ran.length, answered: counted.answered(), read: read.length, wrote: storage.kv.writes.length };
        over.expire(reading);
        return {
          statements: ran.slice(before.ran), answered: counted.answered() - before.answered,
          read: read.slice(before.read), wrote: storage.kv.writes.slice(before.wrote),
        };
      },
      /** The documents the store holds a copy of, by key. */
      docs: () => store.copies().map(({ doc }) => doc).toSorted(),
      /** The documents the limits told of so far. */
      expired: () => removed.map(({ doc }) => doc),
      /** The hour the KV names as the last finished pass's. */
      passed: () => storage.kv.get<number>(DOC_COPY_EXPIRY_PASS_KEY),
    };
  }
  const NOTHING = { statements: [], answered: 0, read: [], wrote: [] };
  const COPIES = "SELECT doc, approved, fetched_at, bytes FROM doc_copy";

  it("keeps a copy for 7 days", () => {
    expect(WEEK).toBe(7 * DAY);
  });

  it("expires a copy 7 days after its last approved read, to the hour", () => {
    let { keep, pass, docs, removed, passed } = expiring();
    // Approved at 10:59 of the first day, which the record keeps as 10:00.
    keep("doc-a", 10 * HOUR + 59 * MINUTE);

    pass(WEEK + 9 * HOUR + 59 * MINUTE);
    expect(docs()).toEqual(["doc-a"]);
    expect(removed).toEqual([]);
    expect(passed()).toBe(WEEK + 9 * HOUR);

    pass(WEEK + 10 * HOUR);
    expect(docs()).toEqual([]);
    expect(removed).toEqual([{
      doc: "doc-a", why: { event: "expired", reason: "unapproved" }, inTransaction: false, held: false,
    }]);
    expect(passed()).toBe(WEEK + 10 * HOUR);
  });

  it("passes at most once an hour", () => {
    let { keep, pass, docs } = expiring();
    keep("doc-a", 0);

    // The activation's first call reads the key; the pass is one statement and one key written.
    expect(pass(DAY + 5 * MINUTE)).toEqual({
      statements: [COPIES], answered: 1, read: [DOC_COPY_EXPIRY_PASS_KEY], wrote: [DOC_COPY_EXPIRY_PASS_KEY],
    });
    // Inside that hour: no statement, and no key read or written.
    expect(pass(DAY + 6 * MINUTE)).toEqual(NOTHING);
    expect(pass(DAY + 59 * MINUTE + 59_999)).toEqual(NOTHING);
    // The next hour passes, and asks the KV nothing: the last pass's hour is in memory.
    expect(pass(DAY + HOUR)).toEqual({
      statements: [COPIES], answered: 1, read: [], wrote: [DOC_COPY_EXPIRY_PASS_KEY],
    });
    expect(docs()).toEqual(["doc-a"]);
  });

  it("does not pass again in the hour after the connection is started again", () => {
    let { keep, pass, limits, docs } = expiring();
    keep("doc-a", 0);
    pass(DAY);

    // Another activation's limits, over the same storage and KV, in the same hour.
    let again = limits();
    expect(pass(DAY + 30 * MINUTE, again)).toEqual({ ...NOTHING, read: [DOC_COPY_EXPIRY_PASS_KEY] });
    expect(pass(DAY + 31 * MINUTE, again)).toEqual(NOTHING);

    // One started in a later hour passes.
    expect(pass(WEEK, limits()).statements[0]).toBe(COPIES);
    expect(docs()).toEqual([]);
  });

  it("passes where the key holds anything but a finite number", () => {
    for (let stored of ["soon", null, NaN, Infinity, { hour: DAY }]) {
      let { keep, pass, storage, passed } = expiring();
      keep("doc-a", 0);
      storage.kv.put(DOC_COPY_EXPIRY_PASS_KEY, stored);

      expect(pass(DAY).statements, String(stored)).toEqual([COPIES]);
      expect(passed()).toBe(DAY);
    }
  });

  it("reads the copies' records only", () => {
    let { keep, pass, storage, store } = expiring();
    for (let doc of ["doc-a", "doc-b", "doc-c"]) keep(doc, DAY);
    keep("doc-d", 0);
    scenarioEdit(store, scenarioBase(store, "doc-d", store.head("doc-d")!), "e1");

    // A pass that removes nothing is the one statement, and answers a row a copy.
    let none = pass(6 * DAY);
    expect(none).toMatchObject({ statements: [COPIES], answered: 4 });

    // One that removes a copy adds the six deletes of its drop, which answer nothing.
    let one = pass(WEEK);
    expect(one.answered).toBe(4);
    expect(one.statements).toHaveLength(7);
    expect(one.statements[0]).toBe(COPIES);
    expect(one.statements.slice(1).every(statement => statement.startsWith("DELETE FROM doc_"))).toBe(true);
    // No table is scanned but the copies' records: each delete searches the document's key.
    expect(tableScans(storage, [...none.statements, ...one.statements])).toEqual({ [COPIES]: ["SCAN doc_copy"] });
  });

  it("removes every copy past the limit, the kept ones untouched", () => {
    let { keep, pass, storage, store, expired } = expiring();
    let control = expiring();
    for (let [doc, at] of [["doc-a", 0], ["doc-b", 2 * DAY], ["doc-c", HOUR], ["doc-d", DAY + HOUR]] as const) {
      keep(doc, at);
      if (at >= DAY + HOUR) control.keep(doc, at);
    }
    // A copy with an edit made in it expires like any other, with what the edit made.
    scenarioEdit(store, scenarioBase(store, "doc-c", store.head("doc-c")!), "e1");
    expect(storedRows(storage)).not.toBe(storedRows(control.storage));

    pass(WEEK + DAY);

    expect(expired().toSorted()).toEqual(["doc-a", "doc-c"]);
    // Storage reads as one that never kept the two.
    expect(storedRows(storage)).toBe(storedRows(control.storage));
  });

  it("drops each copy in a transaction of its own, and goes on at the next call after a drop is refused", () => {
    let { keep, pass, storage, store, removed, expired, docs, passed, limits } = expiring();
    for (let doc of ["doc-a", "doc-b", "doc-c"]) keep(doc, 0);
    // The order a pass meets them in.
    let [first, second, third] = store.copies().map(({ doc }) => doc);
    let control = expiring();
    for (let doc of [second, third]) control.keep(doc, 0);

    // The first statement of the second copy's drop.
    storage.refuse((statement, bindings) =>
      statement.startsWith("DELETE FROM doc_result") && bindings[0] === second);
    expect(() => pass(WEEK)).toThrow("storage refused the write");
    storage.refuse(undefined);

    // The first copy stays gone, the others are whole, and no hour is written anywhere.
    expect(expired()).toEqual([first]);
    expect(storedRows(storage)).toBe(storedRows(control.storage));
    expect(passed()).toBeUndefined();

    // The next call, of this activation or of another, goes on from there.
    let next = pass(WEEK + MINUTE, limits());
    expect(next.statements).toHaveLength(1 + 2 * 6);
    expect(expired()).toEqual([first, second, third]);
    expect(docs()).toEqual([]);
    expect(passed()).toBe(WEEK);
    // Each was told once its own drop's transaction returned, outside every transaction.
    expect(removed.map(({ inTransaction, held }) => [inTransaction, held]))
      .toEqual([[false, false], [false, false], [false, false]]);
    // The failed activation passes again, asking the KV nothing more.
    expect(pass(WEEK + 2 * MINUTE)).toEqual({
      statements: [COPIES], answered: 0, read: [], wrote: [DOC_COPY_EXPIRY_PASS_KEY],
    });
    expect(pass(WEEK + 3 * MINUTE)).toEqual(NOTHING);
  });

  describe("what one call drops", () => {
    it("is 64 MiB of the copies' bytes", () => {
      expect(DRIVE_DOC_EXPIRY_CALL_BYTES).toBe(64 * MIB);
    });

    it("stops once the copies it dropped hold the bound, and writes no hour until none is left", () => {
      // Two one-paragraph documents meet the bound; a third is left to the next call.
      let { keep, pass, expired, docs, passed, limits } = expiring(fakeDocStorage(), 2 * ONE);
      for (let doc of ["doc-a", "doc-b", "doc-c", "doc-d", "doc-e"]) keep(doc, 0);
      keep("doc-f", DAY);

      // The pass over the records, and the six deletes of each of two drops.
      expect(pass(WEEK)).toMatchObject({ statements: { length: 1 + 2 * 6 }, answered: 6, wrote: [] });
      expect(expired()).toEqual(["doc-a", "doc-b"]);
      expect(passed()).toBeUndefined();

      // A call in the same hour goes on; another activation reads the key first.
      expect(pass(WEEK + MINUTE)).toMatchObject({ statements: { length: 1 + 2 * 6 }, answered: 4, read: [], wrote: [] });
      expect(expired()).toEqual(["doc-a", "doc-b", "doc-c", "doc-d"]);
      expect(passed()).toBeUndefined();

      // The call that leaves no copy past the limit writes the hour, and the pass is over.
      expect(pass(WEEK + 2 * MINUTE, limits())).toMatchObject({
        statements: { length: 1 + 6 }, answered: 2,
        read: [DOC_COPY_EXPIRY_PASS_KEY], wrote: [DOC_COPY_EXPIRY_PASS_KEY],
      });
      expect(docs()).toEqual(["doc-f"]);
      expect(passed()).toBe(WEEK);
      expect(pass(WEEK + 3 * MINUTE)).toMatchObject({ statements: [COPIES], answered: 1 });
      expect(pass(WEEK + 4 * MINUTE)).toEqual(NOTHING);
    });

    it("drops one copy at least, though it is larger than the bound by itself", () => {
      let { keep, pass, storage, docs, passed } = expiring(fakeDocStorage(), 2 * ONE);
      keep("doc-a", 0);
      keep("doc-b", 0);
      sayBytes(storage, "doc-a", 512 * MIB);

      pass(WEEK);
      expect(docs()).toEqual(["doc-b"]);
      expect(passed()).toBeUndefined();
      pass(WEEK);
      expect([docs(), passed()]).toEqual([[], WEEK]);
    });

    it("drops the copy of the file being read first, and then the oldest approval", () => {
      let { keep, pass, expired, docs } = expiring(fakeDocStorage(), 1);
      keep("doc-a", 2 * HOUR);
      keep("doc-b", HOUR);
      keep("doc-c", 3 * HOUR);
      keep("doc-d", 0);
      keep("doc-e", DAY);

      // A read of the file whose approval is newest of the four past the limit.
      pass(WEEK + 3 * HOUR, undefined, "doc-c");
      expect(expired()).toEqual(["doc-c"]);
      // A read of a fresh copy, of no copy, or of none named: the oldest approval goes.
      pass(WEEK + 3 * HOUR, undefined, "doc-e");
      pass(WEEK + 3 * HOUR, undefined, "doc-z");
      pass(WEEK + 3 * HOUR);
      expect(expired()).toEqual(["doc-c", "doc-d", "doc-b", "doc-a"]);
      expect(docs()).toEqual(["doc-e"]);
    });

    it("drops the copy of the file read through `driveDocCopies` first", () => {
      let { keep, clock, store, expired, limits } = expiring(fakeDocStorage(), 1);
      for (let doc of ["doc-a", "doc-b", "doc-c"]) keep(doc, 0);
      clock.at = WEEK;

      driveDocCopies(() => store, "doc-c", undefined, limits()).tend();

      expect(expired()).toEqual(["doc-c"]);
    });

    it("removes all 200 one-paragraph documents of a connection at its cap in one call", () => {
      let { keep, pass, docs, passed } = expiring();
      for (let at = 0; at < MAX_DRIVE_DOC_COPIES; at++) keep(`doc-${at}`, 0);

      pass(WEEK);

      expect([docs(), passed()]).toEqual([[], WEEK]);
    });
  });

  it("a drop refused in its last statement leaves that copy whole", () => {
    let { keep, pass, storage, docs, expired, passed } = expiring();
    keep("doc-a", 0);
    let before = storedRows(storage);

    storage.refuse(statement => statement.startsWith("DELETE FROM doc_copy"));
    expect(() => pass(WEEK)).toThrow("storage refused the write");
    storage.refuse(undefined);

    expect(storedRows(storage)).toBe(before);
    expect([docs(), expired(), passed()]).toEqual([["doc-a"], [], undefined]);
  });

  it("an approval renews", () => {
    let { keep, pass, store, docs } = expiring();
    keep("doc-a", 0);
    keep("doc-b", 0);

    // A read of the stored copy approved on the sixth day, and a keep of a fetch of the other.
    store.touch("doc-a", { approved: { folder: "folder", at: 6 * DAY + 30 * MINUTE } });
    keep("doc-b", 6 * DAY + 2 * HOUR);

    pass(8 * DAY);
    expect(docs()).toEqual(["doc-a", "doc-b"]);
    // Seven days after each renewal, to the hour.
    pass(13 * DAY - 1);
    expect(docs()).toEqual(["doc-a", "doc-b"]);
    pass(13 * DAY);
    expect(docs()).toEqual(["doc-b"]);
    pass(13 * DAY + 2 * HOUR);
    expect(docs()).toEqual([]);
  });

  it("leaves a copy no scope check guards", () => {
    let { pass, store, docs, removed } = expiring();
    store.keep("bound", small("bound"), NONE);
    expect(store.copies()[0]).not.toHaveProperty("approvedAt");

    pass(52 * WEEK);

    expect(docs()).toEqual(["bound"]);
    expect(removed).toEqual([]);
  });

  it("tells `removed` once for each, after its drop", () => {
    let { keep, pass, removed } = expiring();
    for (let doc of ["doc-a", "doc-b", "doc-c"]) keep(doc, 0);
    keep("doc-d", DAY);

    pass(WEEK);
    pass(WEEK + HOUR);

    expect(removed.map(({ doc }) => doc).toSorted()).toEqual(["doc-a", "doc-b", "doc-c"]);
    for (let told of removed) {
      expect(told).toMatchObject({
        why: { event: "expired", reason: "unapproved" }, inTransaction: false, held: false,
      });
    }
  });

  it("opens no transaction but each drop's own", () => {
    let storage = fakeDocStorage();
    let depths: number[] = [], depth = 0;
    let watched = {
      ...storage,
      transactionSync<T>(callback: () => T): T {
        depths.push(++depth);
        try {
          return storage.transactionSync(callback);
        } finally {
          depth--;
        }
      },
    } as FakeDocStorage;
    let store = new DocStore(watched);
    for (let doc of ["doc-a", "doc-b"]) store.keep(doc, small(doc), NONE, { at: 0 });
    depths.length = 0;

    new DriveDocCopyLimits({
      store: () => store, pendingDocs: () => new Set(), removed() {}, kv: storage.kv, now: () => WEEK,
    }).expire();

    // One transaction a copy, none around another.
    expect(depths).toEqual([1, 1]);
  });

  describe("on a storage that holds no Doc", () => {
    const tables = (storage: FakeDocStorage) => storage.sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'doc\\_%' ESCAPE '\\'",
    ).toArray().map(({ name }) => name);
    /** The limits of a lazy store over `storage`, on a clock the test moves, and what they ran. */
    function unmade(storage: FakeDocStorage = fakeDocStorage()) {
      let ran: string[] = [];
      let lazy = lazyDocStore({
        ...storage,
        sql: {
          exec: (query: string, ...bindings: unknown[]) => {
            ran.push(query);
            return storage.sql.exec(query, ...bindings);
          },
        },
      } as FakeDocStorage);
      let clock = { at: DAY };
      let limits = new DriveDocCopyLimits({
        store: lazy, pendingDocs: () => new Set(), removed() {}, kv: storage.kv, now: () => clock.at,
      });
      return { storage, lazy, clock, limits, ran };
    }
    const SCHEMA = "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'doc_copy'";

    it("makes no table and writes no key", () => {
      let { storage, clock, limits, ran } = unmade();

      limits.expire();

      expect(ran).toEqual([SCHEMA]);
      expect(tables(storage)).toEqual([]);
      expect(storage.kv.keys()).toEqual([]);
      expect(storage.kv.writes).toEqual([]);

      // A second call in the hour asks the schema nothing; the next hour's asks it once.
      clock.at += 59 * MINUTE;
      limits.expire();
      expect(ran).toEqual([SCHEMA]);
      clock.at += MINUTE;
      limits.expire();
      expect(ran).toEqual([SCHEMA, SCHEMA]);
      expect(tables(storage)).toEqual([]);
      expect(storage.kv.writes).toEqual([]);
    });

    it("passes once the connection stored a Doc, in that hour's next call or a later one", () => {
      let { storage, lazy, clock, limits } = unmade();
      limits.expire();

      lazy().keep("doc-a", small("doc-a"), NONE, { at: 0 });
      // The hour was passed in memory, with nothing to pass over.
      limits.expire();
      expect(storage.kv.keys()).toEqual([]);

      clock.at = WEEK;
      limits.expire();
      expect(lazy().copies()).toEqual([]);
      expect(storage.kv.get(DOC_COPY_EXPIRY_PASS_KEY)).toBe(WEEK);
    });

    it("makes the store of a storage whose tables another activation made", () => {
      let storage = fakeDocStorage();
      new DocStore(storage).keep("doc-a", small("doc-a"), NONE, { at: 0 });
      let { lazy, clock, limits, ran } = unmade(storage);
      clock.at = WEEK;

      limits.expire();

      expect(ran[0]).toBe(SCHEMA);
      expect(lazy.existing?.()).toBe(lazy());
      expect(lazy().copies()).toEqual([]);
      // The store made, its schema is not asked again.
      let asked = ran.filter(query => query === SCHEMA).length;
      lazy.existing?.();
      expect(ran.filter(query => query === SCHEMA)).toHaveLength(asked);
    });

    it("existingDocStore calls a plain function, which has no `existing`", () => {
      let store = new DocStore(fakeDocStorage());
      let calls = 0;

      expect(existingDocStore(() => { calls++; return store; })).toBe(store);
      expect(calls).toBe(1);
      expect(existingDocStore(lazyDocStore(fakeDocStorage()))).toBeUndefined();
    });
  });

  describe("what a pass costs a connection of 200 documents", () => {
    it.each(EXPIRY_COST_PAIRS)("a pass is a statement and six a copy removed: %d pairs", pairs => {
      let cost = expiryCostScenario(fakeDocStorage(), { pairs });

      expect([cost.runs, cost.proseRuns]).toEqual([2 * pairs + 1, 300]);
      expect(cost.copies).toEqual([200, 200, 0]);
      expect(cost.passed).toBe(8 * DAY);
      for (let call of Object.keys(EXPIRY_COST) as ExpiryCase[]) {
        expect(cost[call], call).toMatchObject(EXPIRY_COST[call]);
      }
    });
  });
});

describe("DriveDocCopyLimits.stored and remove", () => {
  const WHY: DocCopyRemoval = { event: "unreachable", reason: "moved-out" };
  /** Keeps `doc`'s one-paragraph copy, read under folder `folder` at the hour `hour`. */
  const keptUnder = (
    { limits }: ReturnType<typeof connection>, doc: string, folder: string, hour: number,
    document = small(doc),
  ) => limits.keep(doc, document, NONE, { folder, at: hour * HOUR });

  it("answers the record of a document's stored copy, and none for a document that has none", () => {
    let host = connection();
    let head = keptUnder(host, "doc-a", "sub", 1);

    expect(host.limits.stored("doc-a")).toEqual(head);
    expect(host.limits.stored("doc-a")).toMatchObject({ folder: "sub", approvedAt: HOUR });
    expect(host.limits.stored("doc-b")).toBeUndefined();
  });

  it("drops the copy whose record is the one seen, with everything stored for it, and tells of it once", () => {
    let host = connection();
    keptUnder(host, "doc-b", "sub", 1);
    // What a connection that never read the document stores.
    let without = host.storage.rows();
    let head = keptUnder(host, "doc-a", "sub", 1, scenarioCopy([scenarioTab("t1", ["one two"])]));
    // A pending edit's version and result, which go with the copy.
    scenarioEdit(host.store, scenarioBase(host.store, "doc-a", head), "e1");
    host.pending.add("doc-a");
    expect(host.storage.rows().doc_result).toHaveLength(1);

    host.limits.remove("doc-a", host.limits.stored("doc-a")!, WHY);

    expect(host.storage.rows()).toEqual(without);
    // Told once the drop's own transaction is over and the record is gone.
    expect(host.removed).toEqual([{ doc: "doc-a", why: WHY, inTransaction: false, held: false }]);
  });

  it.each<[string, (host: ReturnType<typeof connection>) => void]>([
    ["another document was kept over it", host =>
      keptUnder(host, "doc-a", "sub", 1, scenarioCopy([scenarioTab("t1", ["later"])], "r2"))],
    ["the same document was fetched again", host =>
      host.limits.keep("doc-a", { ...small("doc-a"), fetchedAt: 2_000 }, NONE, { folder: "sub", at: HOUR })],
    ["a read was approved under another folder", host =>
      host.store.touch("doc-a", { approved: { folder: "other", at: HOUR } })],
    ["a read was approved with no folder", host =>
      host.store.touch("doc-a", { approved: { at: HOUR } })],
    ["a read was approved in another hour", host =>
      host.store.touch("doc-a", { approved: { folder: "sub", at: 2 * HOUR } })],
    ["the copy was removed", host => host.store.drop("doc-a")],
  ])("leaves the copy as it is where %s since the record was seen", (_name, meanwhile) => {
    let host = connection();
    keptUnder(host, "doc-a", "sub", 1);
    let seen = host.limits.stored("doc-a")!;
    meanwhile(host);
    let rows = host.storage.rows();
    expect(host.store.head("doc-a")).not.toEqual(seen);

    host.limits.remove("doc-a", seen, WHY);

    expect(host.storage.rows()).toEqual(rows);
    expect(host.removed).toEqual([]);
  });

  it("drops a copy approved again in the same hour under the same folder, which writes nothing its record shows", () => {
    let host = connection();
    keptUnder(host, "doc-a", "sub", 1);
    let seen = host.limits.stored("doc-a")!;
    let rows = host.storage.rows();
    // Minutes later, the same copy is approved for a read under the same folder.
    host.store.touch("doc-a", { approved: { folder: "sub", at: HOUR + 59 * 60_000 } });
    expect(host.storage.rows()).toEqual(rows);

    host.limits.remove("doc-a", seen, WHY);

    expect(host.store.head("doc-a")).toBeUndefined();
    expect(host.removed.map(({ doc }) => doc)).toEqual(["doc-a"]);
  });

  it("leaves the copy whole, tells no one and throws where storage refuses a write of the drop", () => {
    let host = connection();
    keptUnder(host, "doc-a", "sub", 1);
    let seen = host.limits.stored("doc-a")!;
    let rows = host.storage.rows();
    host.storage.refuse(statement => statement.startsWith("DELETE FROM doc_run"));

    expect(() => host.limits.remove("doc-a", seen, WHY)).toThrow("storage refused the write");

    host.storage.refuse(undefined);
    expect(host.storage.rows()).toEqual(rows);
    expect(host.removed).toEqual([]);
  });

  it("reads one row of the schema, makes no table and removes nothing on a storage that holds no Doc", () => {
    let storage = fakeDocStorage();
    let counted = countedStorage(storage);
    let removed: string[] = [];
    let limits = new DriveDocCopyLimits({
      store: lazyDocStore(counted.storage), pendingDocs: () => new Set(),
      removed: doc => removed.push(doc), kv: storage.kv,
    });
    // A record seen on another storage, for the shape alone.
    let host = connection();
    let seen = keptUnder(host, "doc-a", "sub", 1);

    expect(limits.stored("doc-a")).toBeUndefined();
    limits.remove("doc-a", seen, WHY);

    expect(counted.ran()).toEqual([
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'doc_copy'",
    ]);
    expect(counted.counts().all).toBe(2);
    expect(storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("searches the copy's record by its key, a row read and none written, where the document has none", () => {
    let storage = fakeDocStorage();
    let counted = countedStorage(storage);
    let limits = new DriveDocCopyLimits({
      store: lazyDocStore(counted.storage), pendingDocs: () => new Set(), removed() {}, kv: storage.kv,
    });
    limits.keep("doc-a", small("doc-a"), NONE, { folder: "sub", at: HOUR });
    let before = counted.counts().all, written = counted.rowsWritten();
    let ran = new Set(counted.ran());

    expect(limits.stored("doc-b")).toBeUndefined();

    expect(counted.counts().all - before).toBe(1);
    expect(counted.rowsWritten() - written).toBe(0);
    // No statement but those the keep ran, and none of them scans a table to find a record.
    expect(counted.ran().filter(statement => !ran.has(statement))).toEqual([]);
    expect(tableScans(storage, counted.ran().filter(statement => /FROM doc_copy WHERE doc = \?/.test(statement))))
      .toEqual({});
  });
});
