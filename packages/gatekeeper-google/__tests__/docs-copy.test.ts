// Holds the lifecycle of a Google Doc's stored copy to its contract: when the copy is served,
// confirmed and fetched again, what a write, a recheck and a drop do to it and to work in
// flight, and that storage alone is what it remembers.

import { describe, expect, it, vi } from "vitest";
import {
  blankDocTabToKeep, pendingDocKeys, type GoogleDocAction, type GoogleDocAddTabAction,
} from "../src/doc-actions";
import type { GoogleDocsTab } from "../src/docs-api";
import {
  DOC_COPY_EXPIRY_PASS_KEY, DRIVE_DOC_COPY_EXPIRY_MS, driveDocCopies, DriveDocCopyLimits,
  inHandDocCopies, lazyDocStore, removeUnreadDocCopyKeys, storedDocCopy,
  StoredDocCopy, storedIn, unkeptDocCopy,
  type DocCopy, type HeldDocCopy, type StoredDocCopyOptions,
} from "../src/docs-copy";
import { docEditKey, docEditResult, type DocEdit } from "../src/docs-replay";
import { DOC_COPY_UNREADABLE, fetchedDoc, pruneTab, tabIdentity } from "../src/docs-replica";
import {
  DOC_COPY_APPROVAL_GRAIN_MS, DOC_ROW_BYTES, DocStore, docStoreCost, heldDoc, runId,
  type DocPending, type HeldDoc,
} from "../src/docs-store";
import { savedDoc } from "../src/drive-comment-body";
import { buildTab, diceOf } from "./doc-fixture";
import { fakeDocStorage, type FakeDocStorage } from "./doc-store-fake";
import { withUnkeptFields } from "./docs-fetched-corpus";
import { readFixtures } from "./docs-live-fixtures";
import { drawnQuotes, locateQuoteWhole, outcome, QUOTED_TABS } from "./locate-quote-whole";
import { WIDER } from "./wider-run";

// The fixture is a document of one paragraph a tab. A tab as Google answers it holds a named
// range, which the copy does not keep: that tells a served copy from a fetched one.
type Answer = { base: GoogleDocsTab[]; revision?: string };

const TTL = 100;
const DOC = "doc";
const tabOf = (id: string, text: string, index = 0): GoogleDocsTab => {
  let tab = buildTab([{ runs: [`${text}\n`] }]);
  // Google sends no start index on the section break that opens a body.
  delete (tab.body.content[0] as { startIndex?: number }).startIndex;
  return {
    ...tab,
    tabId: id,
    title: `Tab ${id}`,
    index,
    namedRanges: { scratch: { namedRanges: [{ namedRangeId: "range.scratch", name: "scratch" }] } },
  };
};
/** A document as Google answers it, one tab per text. */
const fetched = (...texts: string[]): GoogleDocsTab[] =>
  texts.map((text, index) => tabOf(`t.${index}`, text, index));
/** The same document as it is stored and served. */
const kept = (...texts: string[]): GoogleDocsTab[] => fetched(...texts).map(pruneTab);
/** A document of one tab per id, as Google answers it. */
const named = (...ids: string[]): GoogleDocsTab[] =>
  ids.map((id, index) => tabOf(id, `the text of ${id}`, index));

/** Tab `tabId` of a stored copy, decoded; `undefined` for none, and for no copy. */
function tabIn(copy: DocCopy | undefined, tabId: string): GoogleDocsTab | undefined {
  let version = copy?.tab(tabId);
  return copy && version && storedIn(copy).store.tab(version);
}
/** Every tab of a copy, in order, or `undefined` when the copy serves one of them no more. */
const whole = (held: HeldDocCopy | undefined): GoogleDocsTab[] | undefined => {
  try {
    return held?.copy.outline.map(({ tabId }) => tabIn(held.copy, tabId)!);
  } catch {
    return undefined;
  }
};
/** A copy as the tests compare it: its tabs, when it was fetched and its revision. */
const seen = (held: HeldDocCopy | undefined) =>
  held && {
    base: whole(held),
    fetchedAt: held.fetchedAt,
    ...(held.revision === undefined ? {} : { revision: held.revision }),
  };
/** Whether two copies serve the same tabs, fetched at the same clock, or both are absent. */
const identical = (a: HeldDocCopy | undefined, b: HeldDocCopy | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  return whole(a) !== undefined && JSON.stringify(seen(a)) === JSON.stringify(seen(b));
};

/** One turn of the timer queue, by which every microtask queued so far has run. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
/** Every row of a document and every stored key, to tell whether anything in storage changed. */
const snapshot = (storage: FakeDocStorage): unknown =>
  ({ rows: storage.rows(), kv: storage.kv.keys().map(key => [key, storage.kv.get(key)]) });
/** Every row the store holds of any document: every table but the one that names the format. */
const documentRows = (storage: FakeDocStorage): unknown[] =>
  Object.entries(storage.rows()).flatMap(([table, rows]) => table === "doc_format" ? [] : rows);
/** The ids of the rows of `table`, by its column `column`. */
const column = (storage: FakeDocStorage, table: string, name: string): unknown[] =>
  (storage.rows()[table] as Record<string, unknown>[]).map(row => row[name]);

/** What outlives a Durable Object activation (storage, the clock) and Google's stubs. */
type World = {
  readonly storage: FakeDocStorage;
  now: number;
  /** How many times Google was asked for the document. */
  fetches: number;
  /** What the next fetches answer, in order. A fetch with nothing queued rejects. */
  readonly answers: (Answer | Error | Promise<Answer>)[];
  /** The revisions `unchanged` was asked about. */
  readonly asked: string[];
  /** What the next revision checks answer, in order. A check with nothing queued rejects. */
  readonly verdicts: (boolean | Error | Promise<boolean>)[];
  /** What the document's pending records reach, and how many times it was asked. */
  pending: DocPending;
  pendingReads: number;
};

function world(storage: FakeDocStorage = fakeDocStorage()): World {
  return {
    storage, now: 1_000, fetches: 0, answers: [], asked: [], verdicts: [],
    pending: { edits: [], roots: [] }, pendingReads: 0,
  };
}

/**
 * A `StoredDocCopy` over a `DocStore` on the world's storage. A second one over the same world
 * is an eviction: neither holds anything of the first.
 */
function open(
  w: World, overrides: Partial<StoredDocCopyOptions> = {}, store = new DocStore(w.storage),
): { copy: StoredDocCopy; store: DocStore } {
  const copy = new StoredDocCopy({
    store,
    doc: DOC,
    storage: w.storage,
    ttlMs: TTL,
    fetch: async () => {
      w.fetches++;
      const next = await (w.answers.shift() ?? new Error("unexpected fetch"));
      if (next instanceof Error) throw next;
      // A document of its own each time: the copy empties the one it is given as it stores it.
      return {
        documentId: "doc-1", title: "A document", tabs: next.base.map(tab => structuredClone(tab)),
        ...(next.revision === undefined ? {} : { revisionId: next.revision }),
      };
    },
    unchanged: async revision => {
      w.asked.push(revision);
      const next = w.verdicts.shift() ?? new Error("unexpected revision check");
      if (next instanceof Error) throw next;
      return next;
    },
    pending: () => {
      w.pendingReads++;
      return w.pending;
    },
    now: () => w.now,
    ...overrides,
  });
  return { copy, store };
}

/** Queues a changed revision and the document the fetch that follows answers. */
const changed = (w: World, base: GoogleDocsTab[] = fetched("uno", "a second tab")): void => {
  w.verdicts.push(false);
  w.answers.push({ base, revision: "r1" });
};

// An earlier copy past `ttlMs` with no revision, so the next `current()` fetches.
const withEarlierCopy = async (w: World, copy: StoredDocCopy) => {
  w.answers.push({ base: fetched("zero") });
  const earlier = await copy.current();
  w.now += TTL;
  return earlier;
};
// Two fetches the test answers when it chooses, so storage can be read between the answers.
const twoFetches = (w: World) => {
  const answers = [Promise.withResolvers<Answer>(), Promise.withResolvers<Answer>()] as const;
  w.answers.push(answers[0].promise, answers[1].promise);
  return answers;
};

describe("StoredDocCopy", () => {
  it("gives its views its own pending records, so their sweep is its own", async () => {
    const w = world();
    const { copy, store } = open(w);
    w.answers.push({ base: fetched("one") });
    const got = await copy.current();
    const edit: DocEdit = { type: "replaceText", oldMarkdown: "one", newMarkdown: "uno" };
    const prepare = () => docEditResult(store, got.copy.tab("t.0")!, edit);

    prepare();
    expect(w.storage.rows().doc_result).toHaveLength(1);
    got.copy.sweep();
    expect(w.storage.rows().doc_result).toEqual([]);
    prepare();
    w.pending = { edits: [docEditKey(edit)], roots: [] };
    copy.held()?.copy.sweep();
    copy.sweep();
    expect(w.storage.rows().doc_result).toHaveLength(1);
  });

  it("fetches and stores when nothing is held", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one"), revision: "r1" });

    expect(copy.held()).toBeUndefined();
    const got = await copy.current();

    expect(w.fetches).toBe(1);
    expect(seen(got)).toEqual({ base: kept("one"), fetchedAt: 1_000, revision: "r1" });
    expect(seen(copy.held())).toEqual(seen(got));
  });

  it("serves what it stored, not what was fetched", async () => {
    const w = world();
    const { copy } = open(w);
    const answer = Promise.withResolvers<Answer>();
    w.answers.push(answer.promise);
    const base = fetched("one");

    const reading = copy.current();
    w.now = 1_050;
    answer.resolve({ base });
    const got = await reading;

    expect(got.copy.outline.map(({ tabId }) => tabId)).toEqual(["t.0"]);
    const tab = tabIn(got.copy, "t.0")!;
    expect(tab).not.toBe(base[0]);
    expect(tab).toEqual(pruneTab(base[0]));
    expect(base[0].namedRanges).not.toEqual({});
    expect(tab.namedRanges).toEqual({});
    expect(got.copy.tab("t.1")).toBeUndefined();
    expect(got.fetchedAt).toBe(1_000);
    expect(got).not.toHaveProperty("revision");
    expect(seen(copy.held())).toEqual(seen(got));

    // The copy ages from when the fetch began as well, not from when it was answered.
    w.answers.push({ base: fetched("two") });
    w.now = 1_000 + TTL - 1;
    await copy.current();
    expect(w.fetches).toBe(1);
    w.now = 1_000 + TTL;
    await copy.current();
    expect(w.fetches).toBe(2);
  });

  it("serves the copy from storage, not from the fetch", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one", "two"), revision: "r1" });
    const first = await copy.current();
    const decoded = docStoreCost.runsDecoded;

    const again = await copy.current();

    expect(w.fetches).toBe(1);
    // A view holds the copy's record and no tab: each tab is read from its rows when asked for.
    expect(docStoreCost.runsDecoded).toBe(decoded);
    expect(again.copy.tab("t.1")).toEqual(first.copy.tab("t.1"));
    expect(docStoreCost.runsDecoded).toBe(decoded);
    expect(tabIn(again.copy, "t.1")).toEqual(kept("one", "two")[1]);
    expect(docStoreCost.runsDecoded).toBe(decoded + 1);
    // The view remembers no tab: asked again, the tab is decoded again.
    expect(tabIn(again.copy, "t.1")).toEqual(kept("one", "two")[1]);
    expect(docStoreCost.runsDecoded).toBe(decoded + 2);
  });

  it("confirms an old copy by its revision and restarts its age", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one", "two"), revision: "r1" });
    const first = await copy.current();
    const written = docStoreCost.rowsWritten;
    const verdict = Promise.withResolvers<boolean>();
    w.verdicts.push(verdict.promise);

    w.now = 1_000 + TTL;
    const reading = copy.current();
    // Google answers later than it was asked.
    w.now += 30;
    verdict.resolve(true);
    const confirmed = await reading;

    expect(w.asked).toEqual(["r1"]);
    expect(w.fetches).toBe(1);
    expect(identical(confirmed, first)).toBe(true);
    // A revision check restarts the copy's age and leaves when it was fetched.
    expect(confirmed.fetchedAt).toBe(1_000);
    expect(open(w).copy.held()?.fetchedAt).toBe(1_000);
    // One row, the copy's record.
    expect(docStoreCost.rowsWritten - written).toBe(1);
    expect(column(w.storage, "doc_copy", "checked_at")).toEqual([1_000 + TTL]);

    w.now = 1_000 + TTL + TTL - 1;
    await copy.current();
    expect(w.asked).toEqual(["r1"]);

    w.now = 1_000 + TTL + TTL;
    w.verdicts.push(true);
    await copy.current();
    expect(w.asked).toEqual(["r1", "r1"]);
    expect(w.fetches).toBe(1);
  });

  it("fetches again when the revision changed", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one", "two"), revision: "r1" });
    const first = await copy.current();

    w.now += TTL;
    w.verdicts.push(false);
    w.answers.push({ base: fetched("uno"), revision: "r2" });
    const second = await copy.current();

    expect(w.asked).toEqual(["r1"]);
    expect(w.fetches).toBe(2);
    expect(identical(second, first)).toBe(false);
    expect(seen(second)).toEqual({ base: kept("uno"), fetchedAt: 1_000 + TTL, revision: "r2" });
    expect(seen(copy.held())).toEqual(seen(second));
    // The copy before it serves nothing, and its tabs are gone.
    expect(() => first.copy.tab("t.1")).toThrow(DOC_COPY_UNREADABLE);
    expect(w.storage.rows().doc_version).toHaveLength(1);
    expect(w.storage.rows().doc_seq).toHaveLength(1);
  });

  it.each([
    ["that has no revision", undefined, {}],
    ["when unchanged is not given", "r1", { unchanged: undefined }],
  ] as const)("fetches an old copy %s, asking nothing", async (_, revision, overrides) => {
    const w = world();
    const { copy } = open(w, overrides);
    w.answers.push({ base: fetched("one"), revision }, { base: fetched("uno"), revision: "r2" });
    await copy.current();

    w.now += TTL;
    const second = await copy.current();

    expect(w.asked).toEqual([]);
    expect(w.fetches).toBe(2);
    expect(seen(second)).toEqual({ base: kept("uno"), fetchedAt: 1_000 + TTL, revision: "r2" });
  });

  it("shares one fetch between concurrent calls", async () => {
    const w = world();
    const { copy } = open(w);
    const answer = Promise.withResolvers<Answer>();
    w.answers.push(answer.promise);

    const readings = [copy.current(), copy.current()];
    answer.resolve({ base: fetched("one"), revision: "r1" });
    const [first, second] = await Promise.all(readings);

    expect(w.fetches).toBe(1);
    expect(second).toBe(first);
    expect(seen(second)).toEqual(seen(first));
  });

  it.each([
    ["is unchanged", true, 1],
    ["changed", false, 2],
  ])("shares one revision check between concurrent calls when the revision %s", async (_, same, fetches) => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one"), revision: "r1" }, { base: fetched("uno"), revision: "r2" });
    const held = seen(await copy.current());
    const verdict = Promise.withResolvers<boolean>();
    w.verdicts.push(verdict.promise);

    w.now += TTL;
    const readings = [copy.current(), copy.current()];
    verdict.resolve(same);
    const [first, second] = await Promise.all(readings);

    expect(w.asked).toEqual(["r1"]);
    expect(w.fetches).toBe(fetches);
    expect(second).toBe(first);
    expect(JSON.stringify(seen(first)) === JSON.stringify(held)).toBe(same);
    expect(whole(first)).toEqual(same ? kept("one") : kept("uno"));
  });

  it.each<[string, (w: World) => void, string | RegExp]>([
    ["fetch", w => {
      w.verdicts.push(false);
      w.answers.push(new Error("fetch failed"));
    }, "fetch failed"],
    ["unchanged", w => {
      w.verdicts.push(new Error("check failed"));
    }, "check failed"],
    // Not the test of the limit: what is held is that a keep that fails leaves the earlier copy.
    ["a paragraph too large for a row", w => {
      changed(w, [tabOf("t.0", "uno"), tabOf("t.1", "a".repeat(DOC_ROW_BYTES + 1), 1)]);
    }, /^A paragraph of tab "t\.1" of this Google Doc is too large to keep a copy of: /],
    ["storage, in the middle of the keep", w => {
      changed(w);
      w.storage.refuse(statement => statement.includes("INTO doc_seq"));
    }, "storage refused the write"],
    ["storage, at the record that ends the keep", w => {
      changed(w);
      w.storage.refuse(statement => statement.includes("INTO doc_copy"));
    }, "storage refused the write"],
  ])("leaves the stored copy as it was when %s fails", async (_, arm, message) => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one", "two", "three"), revision: "r0" });
    const earlier = await copy.current();
    const earlierSeen = seen(earlier);
    const before = snapshot(w.storage);

    w.now += TTL;
    arm(w);
    const error: unknown = await copy.current().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    if (typeof message === "string") expect((error as Error).message).toBe(message);
    else expect((error as Error).message).toMatch(message);
    const held = copy.held();
    expect(seen(held)).toEqual(earlierSeen);
    expect(identical(held, earlier)).toBe(true);
    expect(snapshot(w.storage)).toEqual(before);

    w.storage.refuse(undefined);
    w.verdicts.push(false);
    w.answers.push({ base: fetched("again"), revision: "r2" });
    expect(seen(await copy.current())).toEqual(
      { base: kept("again"), fetchedAt: 1_000 + TTL, revision: "r2" });
  });

  // A superseded fetch stores nothing; its caller is answered by the fetch begun after it.
  it.each([
    ["a write lands, nothing stored", "noteWrite", false],
    ["a write lands, an earlier copy stored", "noteWrite", true],
    ["the copy is dropped, nothing stored", "drop", false],
    ["the copy is dropped, an earlier copy stored", "drop", true],
    ["a recheck comes, an earlier copy stored", "recheck", true],
  ] as const)("neither stores nor serves a fetch in flight when %s", async (_, method, has) => {
    const w = world();
    const { copy } = open(w);
    if (has) await withEarlierCopy(w, copy);
    const began = w.fetches;
    const [a, b] = twoFetches(w);
    let settled = false;
    const mark = (): void => {
      settled = true;
    };

    const first = copy.current();
    void first.then(mark, mark);
    copy[method]();
    const left = copy.held();
    // A copy stored before a write or a drop is held for no one.
    if (method !== "recheck") expect(left).toBeUndefined();
    if (method === "drop") expect(documentRows(w.storage)).toEqual([]);
    const stored = snapshot(w.storage);
    const written = docStoreCost.rowsWritten;

    a.resolve({ base: fetched("A"), revision: "ra" });
    // The superseded fetch is pruned before it is refused, and only then does the next one begin.
    await vi.waitFor(() => expect(w.fetches - began).toBe(2));
    await settle();

    expect(snapshot(w.storage)).toEqual(stored);
    expect(docStoreCost.rowsWritten).toBe(written);
    expect(identical(copy.held(), left)).toBe(true);
    expect(w.fetches - began).toBe(2);
    expect(settled).toBe(false);

    b.resolve({ base: fetched("B"), revision: "rb" });
    const got = await first;

    expect(seen(got)).toEqual({ base: kept("B"), fetchedAt: has ? 1_000 + TTL : 1_000, revision: "rb" });
    expect(identical(copy.held(), got)).toBe(true);
  });

  it("joins a call that a write superseded to the fetch begun after the write", async () => {
    const w = world();
    const { copy } = open(w);
    const [a, b] = twoFetches(w);

    const first = copy.current();
    copy.noteWrite();
    const second = copy.current();
    expect(w.fetches).toBe(2);

    a.resolve({ base: fetched("A"), revision: "ra" });
    b.resolve({ base: fetched("B"), revision: "rb" });
    const [one, two] = await Promise.all([first, second]);

    expect(w.fetches).toBe(2);
    expect(whole(one)).toEqual(kept("B"));
    expect(identical(two, one)).toBe(true);
  });

  it.each([
    { method: "noteWrite", same: undefined, how: "noteWrite" },
    { method: "recheck", same: false, how: "recheck, the revision changed" },
    { method: "recheck", same: true, how: "recheck, the revision unchanged" },
    { method: "drop", same: undefined, how: "drop" },
  ] as const)(
    "never answers a call made after $how with work begun before it",
    async ({ method, same }) => {
      const w = world();
      const { copy } = open(w);
      w.answers.push({ base: fetched("v1"), revision: "r1" }, { base: fetched("v2"), revision: "r2" });
      const v1 = await copy.current();
      if (same !== undefined) w.verdicts.push(same);

      // How a read and an apply interleave in a Durable Object.
      const gate = Promise.resolve();
      const before = gate.then(() => copy.current());
      const after = gate.then(() => {
        copy[method]();
        return copy.current();
      });
      await Promise.allSettled([before, after]);
      const got = await after;

      if (same === true) {
        expect(w.fetches).toBe(1);
        expect(identical(got, v1)).toBe(true);
      } else {
        expect(w.fetches).toBe(2);
        expect(seen(got)).toEqual({ base: kept("v2"), fetchedAt: 1_000, revision: "r2" });
      }
      expect(w.asked).toEqual(method === "recheck" ? ["r1"] : []);
      expect(identical(copy.held(), got)).toBe(true);
    },
  );

  it("does not credit a revision check that a write overtook", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("v1"), revision: "r1" }, { base: fetched("v2"), revision: "r2" });
    await copy.current();
    const verdict = Promise.withResolvers<boolean>();
    w.verdicts.push(verdict.promise);

    w.now += TTL;
    const reading = copy.current();
    copy.noteWrite();
    verdict.resolve(true);
    const got = await reading;

    expect(w.asked).toEqual(["r1"]);
    expect(w.fetches).toBe(2);
    expect(whole(got)).toEqual(kept("v2"));
    expect(seen(copy.held())).toEqual(seen(got));
  });

  it("fetches after a write without asking for the revision, and holds the copy from before it for no one", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("v1"), revision: "r1" }, { base: fetched("v2"), revision: "r2" });
    await copy.current();

    copy.noteWrite();

    expect(copy.held()).toBeUndefined();
    // What an eviction finds is the same: the mark is stored.
    expect(open(w).copy.held()).toBeUndefined();

    const v2 = await copy.current();

    expect(w.fetches).toBe(2);
    expect(w.asked).toEqual([]);
    expect(whole(v2)).toEqual(kept("v2"));
    // The fetched copy is fresh: the write marked the copy it replaced.
    expect(identical(await copy.current(), v2)).toBe(true);
    expect(w.fetches).toBe(2);
    expect(w.asked).toEqual([]);
  });

  it("rechecks on demand whatever the age", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("v1"), revision: "r1" });
    const v1 = await copy.current();

    copy.recheck();
    w.now += 10;
    w.verdicts.push(true);
    const confirmed = await copy.current();

    expect(w.asked).toEqual(["r1"]);
    expect(w.fetches).toBe(1);
    expect(identical(confirmed, v1)).toBe(true);
  });

  it("fetches on a recheck when the copy has no revision", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("v1") }, { base: fetched("v2") });
    await copy.current();

    copy.recheck();
    const got = await copy.current();

    expect(w.asked).toEqual([]);
    expect(w.fetches).toBe(2);
    expect(whole(got)).toEqual(kept("v2"));
  });

  // An approval and then a rejection with no read between them: the write's mark and the
  // recheck's are kept apart, so Google's revision is not asked about a copy a write outdated.
  it.each([
    ["a write and then a recheck", ["noteWrite", "recheck"]],
    ["a recheck and then a write", ["recheck", "noteWrite"]],
  ] as const)("fetches without asking for the revision after %s", async (_, calls) => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("v1"), revision: "r1" }, { base: fetched("v2"), revision: "r2" });
    await copy.current();

    for (const call of calls) copy[call]();
    const got = await open(w).copy.current();

    expect(w.asked).toEqual([]);
    expect(w.fetches).toBe(2);
    expect(whole(got)).toEqual(kept("v2"));
  });

  it.each([
    ["a check its age began", false],
    ["the check a first recheck asked for", true],
  ])("asks again when a recheck comes while %s is in flight", async (_, rechecked) => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("v1"), revision: "r1" });
    const v1 = await copy.current();
    const verdict = Promise.withResolvers<boolean>();
    w.verdicts.push(verdict.promise, true);

    if (rechecked) copy.recheck();
    else w.now += TTL;
    const reading = copy.current();
    copy.recheck();
    verdict.resolve(true);
    const got = await reading;

    expect(w.asked).toEqual(["r1", "r1"]);
    expect(w.fetches).toBe(1);
    expect(identical(got, v1)).toBe(true);
  });

  it("joins a check that a recheck superseded to the check begun after the recheck", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("v1"), revision: "r1" });
    const v1 = await copy.current();
    const verdicts = [Promise.withResolvers<boolean>(), Promise.withResolvers<boolean>()] as const;
    w.verdicts.push(verdicts[0].promise, verdicts[1].promise);

    w.now += TTL;
    const first = copy.current();
    copy.recheck();
    const second = copy.current();
    const both = Promise.allSettled([first, second]);

    verdicts[0].resolve(true);
    await settle();

    // The superseded call waits on the check the later call began: it asks nothing itself.
    expect(w.asked).toEqual(["r1", "r1"]);

    verdicts[1].resolve(true);

    expect((await both).map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    expect(identical(await first, v1)).toBe(true);
    expect(identical(await second, v1)).toBe(true);
    expect(w.asked).toEqual(["r1", "r1"]);
    expect(w.fetches).toBe(1);
  });

  it("drops the copy", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one", "two"), revision: "r1" }, { base: fetched("uno") });
    await copy.current();
    expect(documentRows(w.storage)).not.toEqual([]);

    copy.drop();

    // No row of the document is left.
    expect(documentRows(w.storage)).toEqual([]);
    expect(copy.held()).toBeUndefined();
    expect(whole(await copy.current())).toEqual(kept("uno"));
    expect(w.fetches).toBe(2);
  });

  it("removes nothing when storage refuses part of a drop", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one", "two"), revision: "r1" });
    const got = seen(await copy.current());
    const before = snapshot(w.storage);

    w.storage.refuse(statement => statement.startsWith("DELETE FROM doc_run"));
    expect(() => copy.drop()).toThrow("storage refused the write");

    expect(snapshot(w.storage)).toEqual(before);
    expect(seen(open(w).copy.held())).toEqual(got);

    w.storage.refuse(undefined);
    copy.drop();

    expect(documentRows(w.storage)).toEqual([]);
  });

  // A call with nothing new to mark writes nothing and still makes the work in flight worthless.
  it.each([
    ["a second write, the copy already stale", "noteWrite", true],
    ["a recheck with nothing stored", "recheck", false],
  ] as const)("starts a fetch in flight over after %s", async (_, method, stale) => {
    const w = world();
    const { copy } = open(w);
    if (stale) {
      w.answers.push({ base: fetched("v1"), revision: "r1" });
      await copy.current();
      copy.noteWrite();
    }
    const earlier = copy.held();
    const began = w.fetches;
    const [a, b] = twoFetches(w);

    const first = copy.current();
    const written = docStoreCost.rowsWritten;
    copy[method]();
    expect(docStoreCost.rowsWritten).toBe(written);

    a.resolve({ base: fetched("A"), revision: "ra" });
    // The superseded fetch is pruned before it is refused, and only then does the next one begin.
    await vi.waitFor(() => expect(w.fetches - began).toBe(2));
    await settle();

    expect(w.fetches - began).toBe(2);
    expect(docStoreCost.rowsWritten).toBe(written);
    expect(identical(copy.held(), earlier)).toBe(true);

    b.resolve({ base: fetched("B"), revision: "rb" });

    expect(whole(await first)).toEqual(kept("B"));
    expect(w.asked).toEqual([]);
    expect(copy.held()?.revision).toBe("rb");
  });

  it.each(["noteWrite", "recheck", "drop"] as const)(
    "does nothing to storage when nothing is held: %s",
    method => {
      const w = world();
      const { copy } = open(w);
      const written = docStoreCost.rowsWritten;

      copy[method]();

      expect(docStoreCost.rowsWritten).toBe(written);
      expect(documentRows(w.storage)).toEqual([]);
      expect(copy.held()).toBeUndefined();
    },
  );

  it("fetches after the store was opened under another format, and stores the copy whole", async () => {
    const w = world();
    w.answers.push({ base: fetched("one", "two"), revision: "r1" }, { base: fetched("uno"), revision: "r2" });
    await open(w).copy.current();
    const { copy } = open(w, {}, new DocStore(w.storage, "another format"));

    expect(documentRows(w.storage)).toEqual([]);
    expect(copy.held()).toBeUndefined();
    const got = await copy.current();

    expect(w.fetches).toBe(2);
    expect(whole(got)).toEqual(kept("uno"));
    expect(seen(copy.held())).toEqual(seen(got));
    expect(w.storage.rows().doc_version).toHaveLength(1);
    // A store of the first format finds nothing of the other's either.
    expect(open(w).copy.held()).toBeUndefined();
  });

  it.each([
    ["missing", ["DELETE FROM doc_run WHERE id = ?"]],
    ["not what was stored", ["UPDATE doc_run SET json = substr(json, 1, 10) WHERE id = ?"]],
    ["JSON that is not a list of elements", ["UPDATE doc_run SET json = '{\"a\":1}' WHERE id = ?"]],
    // The version goes with its run list, as a sweep removes one.
    ["listed by a version that is not stored", [
      "DELETE FROM doc_version WHERE id IN (SELECT version FROM doc_seq WHERE run = ?)",
      "DELETE FROM doc_seq WHERE run = ?",
    ]],
    ["listed by a version of another tab", [
      `UPDATE doc_version SET meta = json_set(meta, '$.tabId', 't.9')
       WHERE id IN (SELECT version FROM doc_seq WHERE run = ?)`,
    ]],
  ])("reads a copy as absent once a tab's run is %s, and fetches", async (_, damage) => {
    const w = world();
    const warm = open(w).copy;
    const text = "a text of one paragraph";
    w.answers.push({ base: fetched(text, "two") }, { base: fetched(text, "two") });
    await warm.current();
    const rows = documentRows(w.storage).length;

    const run = runId(JSON.stringify(kept(text)[0].body.content));
    for (const statement of damage) w.storage.sql.exec(statement, run).toArray();

    // A view reads the record alone until a tab is asked for.
    const cold = open(w).copy;
    const held = cold.held();
    expect(held?.copy.outline.map(({ tabId }) => tabId)).toEqual(["t.0", "t.1"]);
    expect(tabIn(held?.copy, "t.1")).toEqual(kept(text, "two")[1]);
    expect(cold.held()).toBeDefined();
    expect(() => tabIn(held?.copy, "t.0")).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(cold.held()).toBeUndefined();
    expect(w.storage.transactionSync(() => cold.held())).toBeUndefined();

    const repaired = await cold.current();

    expect(w.fetches).toBe(2);
    expect(documentRows(w.storage)).toHaveLength(rows);
    expect(seen(cold.held())).toEqual(seen(repaired));
    expect(whole(repaired)).toEqual(kept(text, "two"));
  });

  // The record's columns are typed; what can be malformed is the JSON three of them hold. A
  // record replaced takes the rows it named with it.
  it.each([
    ["outline is not JSON", "outline = '{'"],
    ["versions is not JSON", "versions = '{'"],
    ["outline is not a list", "outline = '{}'"],
    ["versions is not a list", "versions = '\"v\"'"],
    ["outline and versions differ in length", "versions = '[]'"],
    ["outline entry names no tab", "outline = '[{\"title\":\"x\"},{\"title\":\"y\"}]'"],
    ["version is not a string", "versions = '[1,2]'"],
    ["markers is not a list", "markers = '\"m\"'"],
    ["markers and outline differ in length", "markers = '[]'"],
    ["markers entry is not a list", "markers = '[{},{}]'"],
  ])("reads a record whose %s as absent, and replaces it", async (_, set) => {
    const w = world();
    const warm = open(w).copy;
    w.answers.push({ base: fetched("one", "two"), revision: "r1" }, { base: fetched("uno"), revision: "r2" });
    await warm.current();
    // The record a fetch stored, its tabs beside it, wrong in this one respect.
    const damage = (): void => {
      w.storage.sql.exec(`UPDATE doc_copy SET ${set} WHERE doc = ?`, DOC).toArray();
    };
    damage();
    const { copy } = open(w);

    // Nothing throws over it.
    expect(copy.held()).toBeUndefined();
    expect(w.storage.transactionSync(() => copy.held())).toBeUndefined();
    copy.noteWrite();
    copy.recheck();
    expect(copy.held()).toBeUndefined();

    const got = await copy.current();

    expect(w.fetches).toBe(2);
    expect(w.asked).toEqual([]);
    expect(seen(got)).toEqual({ base: kept("uno"), fetchedAt: 1_000, revision: "r2" });
    expect(seen(copy.held())).toEqual(seen(got));
    // One tab is left, as its version, its run and its context.
    expect(w.storage.rows().doc_version).toHaveLength(1);
    expect(w.storage.rows().doc_run).toHaveLength(2);

    damage();
    copy.drop();

    expect(documentRows(w.storage)).toEqual([]);
  });

  it("works after an eviction", async () => {
    const w = world();
    w.answers.push({ base: fetched("v1"), revision: "r1" });
    const got = await open(w).copy.current();

    const second = open(w).copy;
    const held = second.held();
    expect(seen(held)).toEqual(seen(got));
    // Nothing of the first activation is the second's: the tab is read from its rows again.
    expect(held?.copy.tab("t.0")).not.toBe(got.copy.tab("t.0"));
    w.now += TTL - 1;
    expect(seen(await second.current())).toEqual(seen(got));
    expect(w.fetches).toBe(1);
    expect(w.asked).toEqual([]);

    second.recheck();
    const third = open(w).copy;
    w.verdicts.push(true);
    expect(seen(await third.current())).toEqual(seen(got));
    expect(w.asked).toEqual(["r1"]);
    expect(w.fetches).toBe(1);
  });

  it("serves the copy another instance kept", async () => {
    const w = world();
    const first = open(w).copy;
    const second = open(w).copy;
    w.answers.push({ base: fetched("v1"), revision: "r1" }, { base: fetched("v2"), revision: "r2" });
    const v1 = await first.current();

    second.noteWrite();
    const v2 = await second.current();

    const held = first.held();
    expect(seen(held)).toEqual(seen(v2));
    expect(whole(held)).toEqual(kept("v2"));
    // The copy the first instance was answered is retired, and serves nothing.
    expect(() => v1.copy.tab("t.0")).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(identical(first.held(), held)).toBe(true);
  });

  it("reads and marks inside a transaction, and is undone with it", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("v1"), revision: "r1" });
    const got = await copy.current();

    expect(() => w.storage.transactionSync(() => {
      expect(seen(copy.held())).toEqual(seen(got));
      copy.recheck();
      throw new Error("undone");
    })).toThrow("undone");

    expect(identical(await copy.current(), got)).toBe(true);
    expect(w.asked).toEqual([]);
    expect(w.fetches).toBe(1);

    expect(() => w.storage.transactionSync(() => {
      copy.drop();
      expect(copy.held()).toBeUndefined();
      throw new Error("undone");
    })).toThrow("undone");

    expect(seen(copy.held())).toEqual(seen(got));
    expect(identical(copy.held(), got)).toBe(true);
  });

  it("keeps two documents on one store apart", async () => {
    const w = world();
    const store = new DocStore(w.storage);
    const first = open(w, {}, store).copy;
    const second = open(w, { doc: "doc-2" }, store).copy;
    w.answers.push({ base: fetched("first") }, { base: fetched("second") });
    const one = await first.current();
    const two = await second.current();

    expect(seen(first.held())).toEqual(seen(one));
    expect(seen(second.held())).toEqual(seen(two));
    expect(whole(one)).toEqual(kept("first"));
    expect(whole(two)).toEqual(kept("second"));

    first.drop();

    expect(first.held()).toBeUndefined();
    expect(seen(second.held())).toEqual(seen(two));
    expect(seen(open(w, { doc: "doc-2" }).copy.held())).toEqual(seen(two));
    expect(column(w.storage, "doc_copy", "doc")).toEqual(["doc-2"]);
    expect(column(w.storage, "doc_version", "doc")).toEqual(["doc-2"]);

    second.drop();

    expect(documentRows(w.storage)).toEqual([]);
  });

  it("lists the tabs in the document's order", async () => {
    const w = world();
    w.answers.push({ base: named("b", "a") });
    const warm = await open(w).copy.current();
    const cold = open(w).copy;
    const decoded = docStoreCost.runsDecoded;

    const held = cold.held();

    expect(warm.copy.outline.map(({ tabId }) => tabId)).toEqual(["b", "a"]);
    expect(held?.copy.outline.map(({ tabId }) => tabId)).toEqual(["b", "a"]);
    expect(docStoreCost.runsDecoded).toBe(decoded);
    expect(whole(held)).toEqual(named("b", "a").map(pruneTab));
    expect(docStoreCost.runsDecoded).toBe(decoded + 2);
    expect(identical(await cold.current(), held)).toBe(true);
    expect(w.fetches).toBe(1);
  });

  it("does not rewrite a tab a fetch returned unchanged", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push(
      { base: fetched("one", "two", "three"), revision: "r1" },
      { base: fetched("one", "two", "three"), revision: "r2" },
    );
    await copy.current();
    const runs = column(w.storage, "doc_run", "id");

    const written = docStoreCost.rowsWritten;
    w.now += TTL;
    w.verdicts.push(false);
    const got = await copy.current();

    // The same tabs under another revision: one row, the copy's record.
    expect(docStoreCost.rowsWritten - written).toBe(1);
    expect(column(w.storage, "doc_run", "id")).toEqual(runs);
    expect(seen(open(w).copy.held())).toEqual(seen(got));
  });

  it("stores again only the tabs a noted write changed, and serves none of the copy from before it", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push(
      { base: fetched("one", "two", "three"), revision: "r1" },
      { base: fetched("one", "dos", "three"), revision: "r2" },
    );
    const before = await copy.current();
    expect(before.copy.tab("t.0")).toBeDefined();
    let written = docStoreCost.rowsWritten;

    copy.noteWrite();

    // Only the record is written, and the copy from before the write serves no tab.
    expect(docStoreCost.rowsWritten - written).toBe(1);
    expect(() => before.copy.tab("t.0")).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(() => before.copy.tab("t.1")).toThrow(new Error(DOC_COPY_UNREADABLE));

    written = docStoreCost.rowsWritten;
    const got = await copy.current();

    expect(w.asked).toEqual([]);
    // The changed tab's run, rendering, version and list, the record, and four rows of the old
    // version.
    expect(docStoreCost.rowsWritten - written).toBe(9);
    expect(seen(got)).toEqual({ base: kept("one", "dos", "three"), fetchedAt: 1_000, revision: "r2" });
    expect(seen(open(w).copy.held())).toEqual(seen(got));
  });

  it("removes the version of a tab a later copy does not list", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: named("a", "b") }, { base: named("a") }, { base: named("a", "b") });
    await copy.current();
    const [a, b] = column(w.storage, "doc_copy", "versions").flatMap(text => JSON.parse(text as string) as string[]);

    w.now += TTL;
    await copy.current();

    // The tab's version, its run list and its run are gone; the other tab's and the context stay.
    expect(column(w.storage, "doc_version", "id")).toEqual([a]);
    expect(column(w.storage, "doc_seq", "version")).toEqual([a]);
    expect(w.storage.rows().doc_run).toHaveLength(2);

    w.now += TTL;
    const third = await copy.current();

    expect(column(w.storage, "doc_version", "id").toSorted()).toEqual([a, b].toSorted());
    expect(whole(third)).toEqual(named("a", "b").map(pruneTab));
  });

  it("a copy held across a later keep never serves the later copy's bytes", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push(
      { base: fetched("one", "two") },
      { base: fetched("uno", "two") },
      { base: fetched("one", "two") },
    );
    // Held with neither tab read.
    const first = await copy.current();

    w.now += TTL;
    const second = await copy.current();

    // Storage holds another copy: the first serves no tab, the one the fetch left alone included.
    expect(() => first.copy.tab("t.0")).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(() => first.copy.tab("t.1")).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(copy.held()).toBeDefined();
    expect(tabIn(second.copy, "t.0")).toEqual(kept("uno")[0]);
    expect(copy.held()).toBeDefined();

    // The first document comes back, and with it the copy the first view names.
    w.now += TTL;
    const third = await copy.current();

    expect(tabIn(third.copy, "t.0")).toEqual(kept("one")[0]);
    expect(tabIn(first.copy, "t.0")).toEqual(kept("one")[0]);
    expect(() => second.copy.tab("t.1")).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(copy.held()).toBeDefined();
    expect(w.fetches).toBe(3);
  });

  it("keeps a tab whose id holds a lone surrogate", async () => {
    const w = world();
    const { copy } = open(w);
    const tabs = [tabOf("t.0", "uno"), tabOf("t\uD800", "dos", 1)];
    w.answers.push({ base: tabs });

    const got = await copy.current();

    expect(got.copy.outline.map(({ tabId }) => tabId)).toEqual(["t.0", "t\uD800"]);
    expect(tabIn(got.copy, "t\uD800")).toEqual(pruneTab(tabs[1]));
    expect(tabIn(got.copy, "t\uD800")?.tabId).toBe("t\uD800");
    expect(whole(open(w).copy.held())).toEqual(tabs.map(pruneTab));
  });

  it("sweeps with what the pending records reach when it keeps", async () => {
    const w = world();
    const { copy, store } = open(w);
    w.answers.push({ base: fetched("one", "two") }, { base: fetched("one", "dos") });
    await copy.current();
    const head = store.head(DOC)!;
    const base = store.version(DOC, head.versions[0], { ...head.outline[0], writeMarkers: [] })!;
    store.putResult(base, "pending", { refusal: { reason: "It does not apply." } });
    store.putResult(base, "decided", { refusal: { reason: "It does not apply either." } });
    w.pending = { edits: ["pending"], roots: [] };
    const read = w.pendingReads;

    w.now += TTL;
    await copy.current();

    // The pending records are read at the keep, and what one of them reaches survives it.
    expect(w.pendingReads).toBe(read + 1);
    expect(store.result(base, "pending")).toEqual({ refusal: { reason: "It does not apply." } });
    expect(store.result(base, "decided")).toBeUndefined();

    // A sweep reads them again.
    w.pending = { edits: [], roots: [] };
    copy.sweep();

    expect(w.pendingReads).toBe(read + 2);
    expect(store.result(base, "pending")).toBeUndefined();
    expect(whole(copy.held())).toEqual(kept("one", "dos"));
  });

  it("serves the stored copy to code of another digest and fetches nothing for it", async () => {
    const w = world();
    w.answers.push({ base: fetched("one", "two"), revision: "r1" });
    const got = seen(await open(w, {}, new DocStore(w.storage, undefined, "a")).copy.current());
    const { copy } = open(w, {}, new DocStore(w.storage, undefined, "b"));

    w.now += TTL - 1;
    expect(seen(await copy.current())).toEqual(got);
    expect(w.fetches).toBe(1);
    expect(w.asked).toEqual([]);

    w.now += 1;
    w.verdicts.push(true);
    expect(seen(await copy.current())).toEqual(got);
    expect(w.fetches).toBe(1);
    expect(w.asked).toEqual(["r1"]);
  });

  it("refuses a ttlMs that is not a positive integer", () => {
    const w = world();

    for (const ttlMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => open(w, { ttlMs })).toThrow(
        `ttlMs must be a positive safe integer, got ${ttlMs}.`);
    }
    expect(() => open(w, { ttlMs: 1 })).not.toThrow();
  });

  // What a lookup of quoted text asks for: one request of Google at most.
  it("`current` with no confirmation serves a fresh copy, and past the TTL fetches without asking `unchanged`", async () => {
    const w = world();
    const { copy } = open(w);
    w.answers.push({ base: fetched("one"), revision: "r1" }, { base: fetched("uno"), revision: "r2" });
    const first = await copy.current({ confirm: false });
    expect(w.fetches).toBe(1);

    w.now += TTL - 1;
    expect(seen(await copy.current({ confirm: false }))).toEqual(seen(first));
    expect(w.fetches).toBe(1);

    // No verdict is queued: a revision check would reject.
    w.now += 1;
    const second = await copy.current({ confirm: false });
    expect(w.asked).toEqual([]);
    expect(w.fetches).toBe(2);
    expect(seen(second)).toEqual({ base: kept("uno"), fetchedAt: 1_000 + TTL, revision: "r2" });
    // The copy it kept is confirmed by the call after it that asks for that.
    w.now += TTL;
    w.verdicts.push(true);
    expect(seen(await copy.current())).toEqual(seen(second));
    expect(w.asked).toEqual(["r2"]);
    expect(w.fetches).toBe(2);
  });

  it("answers the fetch's title to the calls its fetch answered, and none for a copy served from storage", async () => {
    const w = world();
    const { copy } = open(w);
    const answer = Promise.withResolvers<Answer>();
    w.answers.push(answer.promise);
    // Whichever kind of call began the flight, the other joins it.
    const calls = [copy.current(), copy.current({ confirm: false })];
    answer.resolve({ base: fetched("one"), revision: "r1" });
    const [read, lookup] = await Promise.all(calls);
    expect(lookup).toBe(read);
    expect(read.title).toBe("A document");
    expect(w.fetches).toBe(1);

    // Inside the TTL, and once a revision check confirmed the copy: storage holds no title.
    expect("title" in await copy.current({ confirm: false })).toBe(false);
    expect("title" in copy.held()!).toBe(false);
    w.now += TTL;
    const verdict = Promise.withResolvers<boolean>();
    w.verdicts.push(verdict.promise);
    const confirming = [copy.current(), copy.current({ confirm: false })];
    verdict.resolve(true);
    const [confirmed, joined] = await Promise.all(confirming);
    expect(joined).toBe(confirmed);
    expect("title" in confirmed).toBe(false);
    expect(w.fetches).toBe(1);
    expect(JSON.stringify(snapshot(w.storage))).not.toContain("A document");
  });

  it("starts a superseded load over with the confirmation it was asked for", async () => {
    const w = world();
    const { copy } = open(w);
    // A copy with a revision, past its TTL: a call that confirms would ask about it.
    w.answers.push({ base: fetched("zero"), revision: "r0" });
    await copy.current();
    w.now += TTL;
    const [first, second] = twoFetches(w);
    const reading = copy.current({ confirm: false });
    // The fetch in flight is made worthless; the one that follows asks no revision check.
    copy.recheck();
    first.resolve({ base: fetched("one"), revision: "r1" });
    second.resolve({ base: fetched("uno"), revision: "r2" });
    expect(whole(await reading)).toEqual(kept("uno"));
    expect(w.asked).toEqual([]);
    expect(w.fetches).toBe(3);
  });
});

/** A copy as it lies under `docCopy:`: an index and, for each part, a manifest and chunks. */
function putUnreadCopy(storage: FakeDocStorage, parts: Record<string, number>): string[] {
  const { kv } = storage;
  kv.put("docCopy:doc:manifest", { size: 0, chunks: 0, meta: { partitions: Object.keys(parts) } });
  for (const [part, chunks] of Object.entries(parts)) {
    const name = `docCopy:doc/${encodeURIComponent(part)}`;
    kv.put(`${name}:manifest`, { size: 8 * chunks, chunks });
    for (let at = 0; at < chunks; at++) {
      kv.put(`${name}:chunk:${String(at).padStart(4, "0")}`, new Uint8Array(8));
    }
  }
  return kv.keys().filter(key => key.startsWith("docCopy:"));
}
const unread = (storage: FakeDocStorage): string[] =>
  storage.kv.keys().filter(key => key.startsWith("docCopy:"));
/** `storage`, counting its scans. */
function counting(storage: FakeDocStorage): { storage: FakeDocStorage; scans: () => number } {
  let scans = 0;
  const kv: FakeDocStorage["kv"] = {
    ...storage.kv,
    list: options => {
      scans++;
      return storage.kv.list(options);
    },
  };
  return { storage: { ...storage, kv }, scans: () => scans };
}

describe("removeUnreadDocCopyKeys", () => {
  it("removes the keys under docCopy: a batch at a time, and answers whether none remain", () => {
    const storage = fakeDocStorage();
    expect(removeUnreadDocCopyKeys(storage)).toBe(true);

    // A batch that was full says nothing of what is behind it: the next scan does.
    expect(putUnreadCopy(storage, { "t.0": 2 })).toHaveLength(4);
    expect(removeUnreadDocCopyKeys(storage, 4)).toBe(false);
    expect(unread(storage)).toEqual([]);
    expect(removeUnreadDocCopyKeys(storage, 4)).toBe(true);

    // Sixteen keys a call, where no limit is given.
    expect(putUnreadCopy(storage, { "t.0": 18 })).toHaveLength(20);
    expect(removeUnreadDocCopyKeys(storage)).toBe(false);
    expect(unread(storage)).toHaveLength(4);
    expect(removeUnreadDocCopyKeys(storage)).toBe(true);
    expect(unread(storage)).toEqual([]);
  });

  it("takes up after an interruption with no record of how far it got", () => {
    const storage = fakeDocStorage();
    const keys = putUnreadCopy(storage, { "t.0": 4 });
    let deletes = 0;
    const failing: FakeDocStorage = {
      ...storage,
      kv: {
        ...storage.kv,
        delete: key => {
          if (++deletes === 3) throw new Error("storage stopped");
          storage.kv.delete(key);
        },
      },
    };

    // A batch is removed whole or not at all, and nothing but its keys is touched.
    expect(() => removeUnreadDocCopyKeys(failing, 4)).toThrow("storage stopped");
    expect(storage.kv.keys()).toEqual(keys);

    expect(removeUnreadDocCopyKeys(storage, 4)).toBe(false);
    expect(unread(storage)).toHaveLength(2);
    expect(removeUnreadDocCopyKeys(storage, 4)).toBe(true);
    expect(storage.kv.keys()).toEqual([]);
  });

  it("leaves every other key", () => {
    const storage = fakeDocStorage();
    const others = [
      "docCopy", "docCop:doc:manifest", "docWriteReceipt", "pending:action:1", "pending:docCopy:doc:manifest",
    ];
    for (const key of others) storage.kv.put(key, { kept: key });
    putUnreadCopy(storage, { "": 1, "t.0": 2 });

    while (!removeUnreadDocCopyKeys(storage, 3));

    expect(storage.kv.keys()).toEqual(others.toSorted());
    for (const key of others) expect(storage.kv.get(key)).toEqual({ kept: key });
  });

  it("is run by a StoredDocCopy when it is made and at each current() until none remain, and then no more", async () => {
    const w = world();
    // Forty keys: two batches of sixteen and one of eight.
    expect(putUnreadCopy(w.storage, { "": 1, "t.0": 36 })).toHaveLength(40);
    const { storage, scans } = counting(w.storage);
    w.answers.push({ base: fetched("one"), revision: "r1" });

    const { copy } = open(w, { storage });

    expect(scans()).toBe(1);
    expect(unread(w.storage)).toHaveLength(24);
    // Neither a read of the held copy nor a mark removes any.
    copy.held();
    copy.recheck();
    expect(scans()).toBe(1);

    const got = await copy.current();

    expect(scans()).toBe(2);
    expect(unread(w.storage)).toHaveLength(8);
    expect(whole(got)).toEqual(kept("one"));

    await copy.current();

    expect(scans()).toBe(3);
    expect(unread(w.storage)).toEqual([]);

    await copy.current();
    await copy.current();

    expect(scans()).toBe(3);
    expect(w.fetches).toBe(1);
    // An activation that finds none at its start never scans again.
    const later = counting(w.storage);
    const second = open(w, { storage: later.storage }).copy;
    await second.current();
    expect(later.scans()).toBe(1);
  });
});

describe("pendingDocKeys", () => {
  it("names each pending edit by its key and each pending add by the version of its blank tab", () => {
    const storage = fakeDocStorage();
    const store = new DocStore(storage);
    const edit: GoogleDocAction = {
      type: "appendText", markdown: "More.\n", tabId: "t.0", submittedAt: 1,
    };
    const add: GoogleDocAddTabAction = {
      type: "addTab", provisionalTabId: "pending-tab-3", title: "Notes", submittedAt: 3,
    };
    const actions: GoogleDocAction[] = [
      edit,
      { ...edit, markdown: "Never.\n", submittedAt: 2, invalidatedReason: "It does not apply." },
      add,
      { ...add, provisionalTabId: "pending-tab-4", submittedAt: 4, invalidatedReason: "It was refused." },
    ];

    const keys = pendingDocKeys(store, DOC, actions.map((action, index) => ({ id: index + 1, action })));

    // A record that carries a reason is replayed by nothing, so it reaches nothing.
    expect(keys.edits).toEqual([docEditKey(edit)]);
    // Nothing is stored to name a root: it is the id the replay's version of the tab gets.
    expect(documentRows(storage)).toEqual([]);
    expect(keys.roots).toEqual([store.putTab(DOC, blankDocTabToKeep(add), []).id]);
  });
});

/** A document of one tab per text, held, as a source holds it between its fetch and its keep. */
const toKeep = (at: number, texts: string[], revision = "r1"): HeldDoc =>
  heldDoc(DOC, fetchedDoc({ documentId: DOC, title: "Plan", revisionId: revision, tabs: fetched(...texts) }, at));
/** An edit of the first tab of a document whose first text is "one". */
const EDIT: DocEdit = { type: "replaceText", oldMarkdown: "one", newMarkdown: "uno" };
/** Every tab of a copy's view, in order. */
const tabsOf = (copy: DocCopy): GoogleDocsTab[] =>
  copy.outline.map(({ tabId }) => tabIn(copy, tabId)!);

describe("a view of a stored copy", () => {
  it("a view says whether storage still holds its copy", () => {
    let store = new DocStore(fakeDocStorage());
    let none = { edits: [], roots: [] };
    let first = storedDocCopy(store, DOC, store.keep(DOC, toKeep(1, ["one"]), none));
    expect(first.stored).toEqual({ store, doc: DOC });
    expect(first.held()).toBe(true);

    // A later document of the file retires the view, and so does a noted write and a drop.
    let second = storedDocCopy(store, DOC, store.keep(DOC, toKeep(2, ["two"], "r2"), none));
    expect(first.held()).toBe(false);
    expect(second.held()).toBe(true);
    store.touch(DOC, { stale: true });
    expect(second.held()).toBe(false);
    let third = storedDocCopy(store, DOC, store.keep(DOC, toKeep(3, ["three"], "r3"), none));
    store.drop(DOC);
    expect(third.held()).toBe(false);
    expect(() => third.tab("t.0")).toThrow(DOC_COPY_UNREADABLE);
  });

  it("a trial's view reads its tabs and runs while nothing holds them, and is never held", () => {
    let storage = fakeDocStorage();
    let store = new DocStore(storage);
    let stored = store.keep(DOC, toKeep(1, ["one"]), { edits: [], roots: [] });
    let before = storage.rows();
    let read = store.trial(DOC, toKeep(2, ["two"], "r2"), () => ({ edits: [], roots: [] }), head => {
      let view = storedDocCopy(store, DOC, head, { trial: true });
      // Storage holds another copy than the trial's, which the view does not ask.
      expect(store.holds(DOC, head.id)).toBe(false);
      expect(view.held()).toBe(false);
      expect(view.stored).toEqual({ store, doc: DOC });
      expect([...view.runs(view.tab("t.0")!)].flat()).toEqual(bodyOf(0, "two"));
      return tabsOf(view);
    });
    expect(read).toEqual(kept("two"));
    expect(storage.rows()).toEqual(before);
    expect(store.head(DOC)).toEqual(stored);
  });

  it("a trial's view is not held where storage holds the very document it tries", () => {
    let store = new DocStore(fakeDocStorage());
    let stored = store.keep(DOC, toKeep(1, ["one"]), { edits: [], roots: [] });
    let held = store.trial(DOC, toKeep(2, ["one"]), () => ({ edits: [], roots: [] }), head => {
      // The trial's record names the stored copy, which a view of that copy would be held by.
      expect(store.holds(DOC, head.id)).toBe(true);
      expect(storedDocCopy(store, DOC, head).held()).toBe(true);
      return storedDocCopy(store, DOC, head, { trial: true }).held();
    });
    expect(held).toBe(false);
    expect(store.head(DOC)).toEqual(stored);
  });

  it("a trial's view that cannot read a tab back throws, and leaves the stored copy", () => {
    let storage = fakeDocStorage();
    let store = new DocStore(storage);
    let stored = store.keep(DOC, toKeep(1, ["one"]), { edits: [], roots: [] });
    let before = storage.rows();
    // A record that lists a version no row holds, as a trial's and as the stored copy's.
    let unstored = { ...stored, versions: [runId("a version that is not stored")] };

    let trial = storedDocCopy(store, DOC, unstored, { trial: true });
    expect(() => trial.tab("t.0")).toThrow(DOC_COPY_UNREADABLE);
    expect(storage.rows()).toEqual(before);
    expect(store.head(DOC)).toEqual(stored);

    // The view of the stored copy drops it, so the next read fetches.
    expect(() => storedDocCopy(store, DOC, unstored).tab("t.0")).toThrow(DOC_COPY_UNREADABLE);
    expect(store.head(DOC)).toBeUndefined();
  });

  it("an unkept copy lists the tabs and reads none", () => {
    let storage = fakeDocStorage();
    let store = new DocStore(storage);
    let before = storage.rows();
    let outline = toKeep(1, ["one", "two"]).tabs.map(tab => tab.identity);
    let copy = unkeptDocCopy({ store, doc: DOC }, outline);
    expect(copy.outline).toBe(outline);
    expect(copy.stored).toEqual({ store, doc: DOC });
    expect(copy.held()).toBe(false);
    expect(() => copy.tab("t.0")).toThrow(DOC_COPY_UNREADABLE);
    expect(() => copy.tab("t.other")).toThrow(DOC_COPY_UNREADABLE);
    let version = store.putTab(DOC, kept("one")[0], []);
    let { runsDecoded } = docStoreCost;
    expect(() => copy.markdown(version)).toThrow(DOC_COPY_UNREADABLE);
    expect(() => copy.runs(version)).toThrow(DOC_COPY_UNREADABLE);
    expect(docStoreCost.runsDecoded).toBe(runsDecoded);
    expect(storedIn(copy)).toBe(copy.stored);
    store.sweep(DOC, { edits: [], roots: [] });
    expect(storage.rows()).toEqual(before);
  });

  it("answers a tab's version from one small row, and its Markdown from storage", () => {
    let store = new DocStore(fakeDocStorage());
    let copy = storedDocCopy(store, DOC, store.keep(DOC, toKeep(1, ["one"]), { edits: [], roots: [] }));
    let decoded = docStoreCost.runsDecoded;
    let version = copy.tab("t.0")!;
    expect(version).toMatchObject({ tabId: "t.0", doc: DOC, exact: false, writeMarkers: [] });
    expect(copy.tab("t.other")).toBeUndefined();
    expect(docStoreCost.runsDecoded).toBe(decoded);
    // Its run was rendered when the copy was kept: its Markdown is read from its row.
    expect(copy.markdown(version)).toBe("one\n");
    expect(copy.markdown(docEditResult(store, version, EDIT).after)).toBe("uno\n");
    expect(docStoreCost.runsDecoded).toBe(decoded + 1);
  });

  it("sweeps what the pending records do not reach, for a view of the stored copy given them", () => {
    let storage = fakeDocStorage();
    let store = new DocStore(storage);
    let none = { edits: [], roots: [] };
    let head = store.keep(DOC, toKeep(1, ["one"]), none);
    let kept = storage.rows();
    let made = () => docEditResult(store, storedDocCopy(store, DOC, head).tab("t.0")!, EDIT);

    // An edit prepared and never queued: its result, its version and both renderings.
    made();
    let prepared = storage.rows();
    expect(prepared.doc_result).toHaveLength(1);
    expect(prepared.doc_version).toHaveLength(2);
    // A view given no pending sweeps nothing, and neither does a trial's nor an unkept copy.
    storedDocCopy(store, DOC, head).sweep();
    storedDocCopy(store, DOC, head, { trial: true, pending: () => none }).sweep();
    unkeptDocCopy({ store, doc: DOC }, head.outline).sweep();
    expect(storage.rows()).toEqual(prepared);

    // The pending records are read at each sweep.
    let pending: DocPending = { edits: [docEditKey(EDIT)], roots: [] };
    let view = storedDocCopy(store, DOC, head, { pending: () => pending });
    view.sweep();
    expect(storage.rows()).toEqual(prepared);
    pending = none;
    view.sweep();
    // The rendering of the base version stays: it is of the copy.
    expect(storage.rows()).toEqual({ ...kept, doc_md: storage.rows().doc_md });
    expect(storage.rows().doc_md).toHaveLength(1);
  });
});

describe("driveDocCopies", () => {
  /** The copies of one file over a store of its own, and what its statements wrote. */
  function copiesOf(pending?: (store: DocStore) => DocPending) {
    let storage = fakeDocStorage();
    let store = new DocStore(storage);
    let copies = driveDocCopies(() => store, DOC, pending);
    /** How many rows `run` writes. */
    let written = (run: () => void): number => {
      let before = docStoreCost.rowsWritten;
      run();
      return docStoreCost.rowsWritten - before;
    };
    return { storage, store, copies, written };
  }

  it("gives the views keep answers the file's pending edits, so their sweep is its own", () => {
    let pending: DocPending = { edits: [], roots: [] };
    let { storage, store, copies } = copiesOf(() => pending);
    let view = copies.keep(toKeep(1, ["one"]))!;
    let kept = storage.rows().doc_version;
    let prepare = () => docEditResult(store, view.tab("t.0")!, EDIT);

    // Prepared and not queued: the view's sweep removes it, and so does the copies'.
    prepare();
    view.sweep();
    expect(storage.rows().doc_result).toEqual([]);
    expect(storage.rows().doc_version).toEqual(kept);
    prepare();
    copies.sweep();
    expect(storage.rows().doc_result).toEqual([]);
    // Queued, it stays, also for the view of the stored copy a slower keep answers.
    prepare();
    pending = { edits: [docEditKey(EDIT)], roots: [] };
    let same = copies.keep(toKeep(0, ["one"]))!;
    expect(same.held()).toBe(true);
    for (let sweeper of [view, same, copies]) {
      sweeper.sweep();
      expect(storage.rows().doc_result).toHaveLength(1);
    }
    // A trial's view and an unkept copy sweep nothing.
    pending = { edits: [], roots: [] };
    copies.unkept(toKeep(1, ["one"])).sweep();
    expect(storage.rows().doc_result).toHaveLength(1);
    copies.trial(toKeep(1, ["one"]), copy => {
      copy.sweep();
      expect(storage.rows().doc_result).toHaveLength(1);
    });
    // The trial itself does, at its end.
    expect(storage.rows().doc_result).toEqual([]);
  });

  it("keeps a document, and refuses one fetched before the copy it holds where the two differ", () => {
    let { store, copies } = copiesOf();
    let later = copies.keep(toKeep(20, ["later"], "r2"));
    expect(later && tabsOf(later)).toEqual(kept("later"));
    expect(later?.held()).toBe(true);
    expect(store.head(DOC)).toMatchObject({ revision: "r2", fetchedAt: 20, stale: false });
    let head = store.head(DOC);

    // A slow read's older document, which is another document, is not put over it.
    expect(copies.keep(toKeep(10, ["earlier"]))).toBeUndefined();
    expect(store.head(DOC)).toEqual(head);
    expect(later?.held()).toBe(true);

    // A document fetched after the stored copy replaces it.
    let latest = copies.keep(toKeep(30, ["latest"], "r3"));
    expect(latest && tabsOf(latest)).toEqual(kept("latest"));
    expect(later?.held()).toBe(false);
    expect(store.head(DOC)).toMatchObject({ revision: "r3", fetchedAt: 30 });
  });

  it("answers the stored copy's view for a document fetched before it that is the same " +
      "document, and records the approval", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(5 * DOC_COPY_APPROVAL_GRAIN_MS + 7);
      let { store, copies } = copiesOf();
      copies.keep(toKeep(20, ["same"]), "f1");
      let head = store.head(DOC)!;
      expect(head).toMatchObject({ folder: "f1", approvedAt: 5 * DOC_COPY_APPROVAL_GRAIN_MS });

      vi.setSystemTime(6 * DOC_COPY_APPROVAL_GRAIN_MS + 1);
      let view = copies.keep(toKeep(10, ["same"]), "f2");
      expect(view?.held()).toBe(true);
      expect(view && tabsOf(view)).toEqual(kept("same"));
      // The stored copy is the one fetched later, with the approval of the read that found it.
      expect(store.head(DOC)).toEqual(
        { ...head, folder: "f2", approvedAt: 6 * DOC_COPY_APPROVAL_GRAIN_MS });
    } finally {
      vi.useRealTimers();
    }
  });

  it("records the folder and the hour a reused copy was approved under, writing no row where " +
      "both are the same", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(3 * DOC_COPY_APPROVAL_GRAIN_MS);
      let { store, copies, written } = copiesOf();
      // Nothing is done where no copy is stored.
      expect(written(() => copies.approvedUnder("f1"))).toBe(0);
      expect(store.head(DOC)).toBeUndefined();

      copies.keep(toKeep(1, ["one"]));
      expect(store.head(DOC)?.folder).toBeUndefined();
      expect(store.head(DOC)?.approvedAt).toBe(3 * DOC_COPY_APPROVAL_GRAIN_MS);

      // Two approvals in one hour under one folder write the record once.
      expect(written(() => copies.approvedUnder("f1"))).toBe(1);
      vi.setSystemTime(4 * DOC_COPY_APPROVAL_GRAIN_MS - 1);
      expect(written(() => copies.approvedUnder("f1"))).toBe(0);
      expect(store.head(DOC)).toMatchObject({ folder: "f1", approvedAt: 3 * DOC_COPY_APPROVAL_GRAIN_MS });

      // Another folder, or the next hour, writes it once more.
      expect(written(() => copies.approvedUnder("f2"))).toBe(1);
      expect(store.head(DOC)).toMatchObject({ folder: "f2", approvedAt: 3 * DOC_COPY_APPROVAL_GRAIN_MS });
      vi.setSystemTime(4 * DOC_COPY_APPROVAL_GRAIN_MS);
      expect(written(() => copies.approvedUnder("f2"))).toBe(1);
      expect(store.head(DOC)).toMatchObject({ folder: "f2", approvedAt: 4 * DOC_COPY_APPROVAL_GRAIN_MS });

      // A session that stands on no folder records none.
      expect(written(() => copies.approvedUnder())).toBe(1);
      expect("folder" in store.head(DOC)!).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers an unkept copy that lists the document's tabs over its store, and stores nothing", () => {
    let { storage, store, copies, written } = copiesOf();
    let document = toKeep(1, ["one", "two"]);
    let before = storage.rows();
    let copy!: DocCopy;
    expect(written(() => { copy = copies.unkept(document); })).toBe(0);
    expect(storage.rows()).toEqual(before);
    expect(store.head(DOC)).toBeUndefined();
    // It lists the document's tabs and names the store its document will be kept in.
    expect(copy.outline).toEqual(document.tabs.map(tab => tab.identity));
    expect(copy.stored?.store).toBe(store);
    expect(copy.held()).toBe(false);
  });

  it("offers nothing to call for a refusal", () => {
    // None removes a copy for a refusal; a removal added here needs its rule. `tend` is the
    // expiry pass, which removes a copy for its age alone.
    expect(Object.keys(copiesOf().copies).toSorted()).toEqual(
      ["approvedUnder", "hold", "keep", "sweep", "tend", "trial", "tryFetched", "unkept", "wrote"]);
  });

  it("tend runs the limits' pass, and does nothing without limits", () => {
    let { storage, store, copies } = copiesOf();
    copies.keep(toKeep(1, ["one"]), "f1");
    // `keep` took the clock of its approval itself: the limits' clock is seven days on.
    let clock = Date.now() + DRIVE_DOC_COPY_EXPIRY_MS;
    let removed: unknown[] = [];
    let limited = driveDocCopies(() => store, "another", undefined, new DriveDocCopyLimits({
      store: () => store, pendingDocs: () => new Set(), kv: storage.kv, now: () => clock,
      removed: (doc, why) => removed.push([doc, why]),
    }));
    let before = { rows: storage.rows(), statements: storage.statements() };

    // Without limits: no statement, no key, the copy as it was.
    copies.tend();
    expect(storage.statements()).toEqual(before.statements);
    expect(storage.rows()).toEqual(before.rows);
    expect(storage.kv.keys()).toEqual([]);

    // With the connection's: the pass, over every copy of the store and not this file's alone.
    limited.tend();
    expect(store.head(DOC)).toBeUndefined();
    expect(removed).toEqual([[DOC, { event: "expired", reason: "unapproved" }]]);
    expect(storage.kv.get(DOC_COPY_EXPIRY_PASS_KEY)).toBe(clock - clock % DOC_COPY_APPROVAL_GRAIN_MS);
  });

  it("marks the stored copy stale when a write lands, and puts the next document over it " +
      "whenever each was fetched", () => {
    let { storage, store, copies, written } = copiesOf();
    // With no copy stored, no statement writes.
    expect(written(() => copies.wrote())).toBe(0);
    expect(store.head(DOC)).toBeUndefined();

    let view = copies.keep(toKeep(20, ["before the write"]));
    let versions = storage.rows().doc_version;
    copies.wrote();
    expect(store.head(DOC)?.stale).toBe(true);
    expect(view?.held()).toBe(false);
    // The rows of the copy's tabs stay, for the next fetch to be compared with.
    expect(storage.rows().doc_version).toEqual(versions);

    // A copy a write overtook is no later document: one fetched earlier replaces it.
    let next = copies.keep(toKeep(10, ["after the write"], "r2"));
    expect(next && tabsOf(next)).toEqual(kept("after the write"));
    expect(store.head(DOC)).toMatchObject({ revision: "r2", fetchedAt: 10, stale: false });
  });

  it("keeps a document with the file's pending edits, whose results in a tab it brought " +
      "unchanged stay", () => {
    let edits = ["edit-1"];
    let { store, copies } = copiesOf(() => ({ edits, roots: [] }));
    copies.keep(toKeep(1, ["one"]));
    let base = store.version(DOC, store.head(DOC)!.versions[0], { ...tabIdentity(kept("one")[0]), writeMarkers: [] })!;
    store.putResult(base, "edit-1", { requests: [], after: store.putTab(DOC, kept("made")[0], []) });

    // The sweep of a keep spares what a pending edit made in the first tab, which is the same.
    copies.keep(toKeep(2, ["one", "two"], "r2"));
    expect(store.head(DOC)).toMatchObject({ revision: "r2", fetchedAt: 2 });
    expect(store.result(base, "edit-1")).toBeDefined();

    // Once the edit is decided, the next keep removes it.
    edits = [];
    copies.keep(toKeep(3, ["one", "two", "three"], "r3"));
    expect(store.result(base, "edit-1")).toBeUndefined();
  });

  it("reads a document in a trial with the file's pending edits", () => {
    let edits = ["edit-1"];
    let asked = 0;
    let { storage, store, copies } = copiesOf(() => {
      asked++;
      return { edits, roots: [] };
    });
    copies.keep(toKeep(1, ["one"]));
    let base = store.version(DOC, store.head(DOC)!.versions[0], { ...tabIdentity(kept("one")[0]), writeMarkers: [] })!;
    let before = storage.rows();
    let head = store.head(DOC);
    asked = 0;

    let read = copies.trial(toKeep(2, ["one", "another tab"], "r2"), copy => {
      expect(copy.held()).toBe(false);
      // What a pending edit makes in a tab the stored copy holds unchanged outlives the trial.
      store.putResult(base, "edit-1", { requests: [], after: store.putTab(DOC, kept("made")[0], []) });
      return tabsOf(copy);
    });
    expect(read).toEqual(kept("one", "another tab"));
    // The pending edits are read once, after `use`.
    expect(asked).toBe(1);
    expect(store.head(DOC)).toEqual(head);
    expect(store.result(base, "edit-1")).toBeDefined();
    // Nothing of the second tab, which only the fetched document holds, is stored.
    expect(storage.rows().doc_version).toHaveLength((before.doc_version as unknown[]).length + 1);
    expect(JSON.stringify(storage.rows())).not.toContain("another tab");
  });

  it("makes its store only when it is first used", () => {
    let storage = fakeDocStorage();
    let lazy = lazyDocStore(storage);
    let copies = driveDocCopies(lazy, DOC);
    expect(storage.statements()).toEqual([]);
    copies.keep(toKeep(1, ["one"]));
    expect(storage.statements().length).toBeGreaterThan(0);
    // The one store is answered again, and it holds what was kept through it.
    expect(lazy()).toBe(lazy());
    expect(lazy().head(DOC)?.fetchedAt).toBe(1);
  });
});

describe("inHandDocCopies", () => {
  it("reads a document in hand: its outline and its tabs", () => {
    let document = toKeep(1, ["one", "two"]);
    let copy = inHandDocCopies().keep(document)!;
    expect(copy.outline).toEqual(document.tabs.map(tab => tab.identity));
    // A handle made of the tab in hand, which names no stored version.
    expect(copy.tab("t.0")).toEqual({
      ...document.tabs[0].identity, id: "t.0", doc: "", exact: false, writeMarkers: [],
      bodyEndIndex: pruneTab(fetched("one")[0]).body.content.at(-1)!.endIndex,
    });
    expect(copy.outline.map(({ tabId }) => copy.markdown(copy.tab(tabId)!))).toEqual(["one\n", "two\n"]);
    expect(copy.tab("t.other")).toBeUndefined();
    expect(copy.held()).toBe(true);
    expect(copy.stored).toBeUndefined();
    expect(() => storedIn(copy)).toThrow("read in hand");
    copy.sweep();
  });

  it("keeps no rendering of a tab in hand", () => {
    let copy = inHandDocCopies().keep(toKeep(1, ["one"]))!;
    let { runsDecoded, runsRendered } = docStoreCost;
    copy.markdown(copy.tab("t.0")!);
    copy.markdown(copy.tab("t.0")!);
    // The tab is one run: each read decodes it from the held bytes and renders it.
    expect(docStoreCost.runsDecoded - runsDecoded).toBe(2);
    expect(docStoreCost.runsRendered - runsRendered).toBe(2);
  });

  it("reads of a tab in hand the writes it is marked with", () => {
    let marked: GoogleDocsTab = {
      ...tabOf("t.marked", "marked"),
      namedRanges: {
        "gadgets-write-first": { namedRanges: [
          { namedRangeId: "range.1", name: "gadgets-write-first" },
          { namedRangeId: "range.2", name: "gadgets-write-first" },
        ] },
        "gadgets-write-second": { namedRanges: [
          { namedRangeId: "range.3", name: "gadgets-write-second" },
        ] },
      },
    };
    let copy = inHandDocCopies().keep(inHandDocCopies().hold(
      { documentId: DOC, title: "Plan", revisionId: "r1", tabs: [marked, tabOf("t.plain", "plain")] }, 1))!;

    expect(copy.tab("t.marked")?.writeMarkers).toEqual([
      { writeId: "first", id: "range.1" },
      { writeId: "first", id: "range.2" },
      { writeId: "second", id: "range.3" },
    ]);
    expect(copy.tab("t.plain")?.writeMarkers).toEqual([]);
  });

  it("answers the same copy for a trial, an unkept and a kept document, and stores nothing", () => {
    let storage = fakeDocStorage();
    let store = new DocStore(storage);
    let statements = storage.statements();
    let rows = storage.rows();
    let copies = inHandDocCopies();
    let document = toKeep(1, ["one"]);
    // The same document as Google answers it, for the copy that is read off the answer.
    let answer = { documentId: DOC, title: "Plan", revisionId: "r1", tabs: fetched("one") };
    let { content } = answer.tabs[0].body;
    let views = [
      copies.unkept(document), copies.keep(document, "f1")!, copies.trial(document, copy => copy),
      copies.tryFetched(answer, 1, copy => copy),
    ];
    // The answer was emptied as it was read: the copy holds its runs' bytes, not the answer.
    expect(answer.tabs).toEqual([undefined]);
    expect(content).toEqual(content.map(() => undefined));
    expect(content).not.toEqual([]);
    for (let view of views) {
      expect(view.markdown(view.tab("t.0")!)).toBe("one\n");
      expect(view.held()).toBe(true);
      view.sweep();
    }
    copies.approvedUnder("f1");
    copies.wrote();
    copies.sweep();
    copies.tend();
    // A store beside it is asked nothing.
    expect(storage.statements()).toEqual(statements);
    expect(storage.rows()).toEqual(rows);
    expect(store.head(DOC)).toBeUndefined();
  });
});

/** The body of the `at`-th tab of a document of one tab per text, as it is stored. */
const bodyOf = (at: number, ...texts: string[]) => kept(...texts)[at].body.content;

describe("a copy's runs", () => {
  const NONE: DocPending = { edits: [], roots: [] };
  /** How many rounds of quotes are drawn from each tab: more in the wider run. */
  const QUOTE_DRAWS = WIDER ? 24 : 3;

  it("a view's runs are the store's, and throw once the copy is retired", () => {
    let store = new DocStore(fakeDocStorage());
    let view = storedDocCopy(store, DOC, store.keep(DOC, toKeep(1, ["one", "two"]), NONE));
    let version = view.tab("t.1")!;

    expect([...view.runs(version)]).toEqual([...store.runs(version)]);
    expect([...view.runs(version)].flat()).toEqual(bodyOf(1, "one", "two"));

    // A retired view reads no run (what retires one: "a view says whether storage still holds its copy").
    store.touch(DOC, { stale: true });
    expect(() => view.runs(version)).toThrow(new Error(DOC_COPY_UNREADABLE));
  });

  it("a view's runs drop the stored copy where a run does not read back", () => {
    let storage = fakeDocStorage();
    let store = new DocStore(storage);
    let view = storedDocCopy(store, DOC, store.keep(DOC, toKeep(1, ["one"]), NONE));
    let version = view.tab("t.0")!;
    storage.sql.exec("UPDATE doc_run SET json = '{}' WHERE id IN (SELECT run FROM doc_seq)").toArray();

    expect(() => [...view.runs(version)]).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(store.head(DOC)).toBeUndefined();
  });

  it("a copy read in hand decodes its held tab's runs", () => {
    let copy = inHandDocCopies().keep(toKeep(1, ["one", "two"]))!;
    let version = copy.tab("t.1")!;
    let { runsDecoded } = docStoreCost;

    expect([...copy.runs(version)].flat()).toEqual(bodyOf(1, "one", "two"));
    expect([...copy.runs(version)].flat()).toEqual(bodyOf(1, "one", "two"));

    // The tab is one run, decoded from the held bytes at each read: none is kept.
    expect(docStoreCost.runsDecoded - runsDecoded).toBe(2);
    expect(() => copy.runs({ ...version, tabId: "t.other" })).toThrow(new Error(DOC_COPY_UNREADABLE));
  });

  /** Every tab of every recording, with fields the copy does not keep, as Google sends a tab. */
  const RECORDED_TABS = readFixtures()
    .flatMap(({ before, steps }) => [before, ...steps.map(step => step.after)])
    .map(withUnkeptFields);

  it("savedDoc finds the same as the whole-tab search finds in the document as Google sent it", () => {
    let store = new DocStore(fakeDocStorage());
    let compared = 0, found = 0;
    let tabs = [...QUOTED_TABS, ...RECORDED_TABS.map(tab => ({ tab, quotes: [] }))];
    for (let [index, { tab, quotes }] of tabs.entries()) {
      // A document of its own for each reading: it is emptied as it is read.
      let held = () => heldDoc(DOC, fetchedDoc(
        { documentId: DOC, title: "Plan", revisionId: `r${index}`, tabs: [structuredClone(tab)] }, index + 1));
      let copies: [string, (use: (copy: DocCopy) => void) => void][] = [
        ["a stored copy", use => use(storedDocCopy(store, DOC, store.keep(DOC, held(), NONE)))],
        ["a copy in hand", use => use(inHandDocCopies().keep(held())!)],
      ];
      let sample = [...new Set([...quotes, ...drawnQuotes(tab, diceOf(104_729 + index), QUOTE_DRAWS)])];
      // The search of the tab whole, over the tab as Google sent it.
      let searches = sample.flatMap(quote => [false, true].map(wholeChips => ({
        quote, wholeChips, expected: outcome(() => locateQuoteWhole(tab, quote, { wholeChips })),
      })));
      found += searches.filter(({ expected }) => typeof expected !== "string").length;
      for (let [name, reading] of copies) {
        reading(copy => {
          let saved = savedDoc(copy);
          for (let { quote, wholeChips, expected } of searches) {
            let answered = outcome(() => saved.locate(tab.tabId, quote, { wholeChips }));
            if (JSON.stringify(answered) !== JSON.stringify(expected)) {
              expect(answered, `${JSON.stringify(quote)} in tab ${index} through ${name}, ` +
                `wholeChips ${wholeChips}`).toEqual(expected);
            }
            compared++;
          }
        });
      }
    }

    expect(compared).toBeGreaterThan(5_000);
    expect(found).toBeGreaterThan(1_000);
  });
});
