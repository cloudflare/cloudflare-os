// The lifecycle of a Google Doc's stored copy, beside the store that holds it (`./docs-store`):
// when the copy is served, when Google is asked whether it still stands, when the document is
// fetched again, and what a write, a recheck and a drop do to it; what the source of a Doc
// opened through Drive needs of its connection's store; and the limits of what a Drive
// connection keeps.

import { SingleFlight } from "@gadgets/gatekeeper-kit/single-flight";
import type { GoogleDocsDocument, StructuralElement } from "./docs-api";
import {
  DOC_COPY_UNREADABLE, fetchedDoc, type FetchedDoc, type GoogleDocTabIdentity,
} from "./docs-replica";
import {
  approvalHour, DocStore, fetchedMarkdown, heldDoc,
  type DocCopyHead, type DocCopyRecord, type DocPending, type DocStoreStorage, type DocVersion,
  type HeldDoc,
} from "./docs-store";

/**
 * A copy of a document as its pending edits are replayed over it: a view of what the store
 * holds, VALID ONLY UNTIL THE NEXT AWAIT. A later fetch, a noted write or a drop retires what
 * is stored, after which `tab` throws; read what is wanted of it before awaiting, or ask for
 * the copy again.
 */
export type DocCopy = {
  /**
   * Where the copy's versions are stored: the store, and the document's key in it. What a
   * replay makes its edits in. Absent only for a copy read in hand (`inHandDocCopies`), which a
   * session with no storage reads and nothing is replayed over.
   */
  readonly stored?: { readonly store: DocStore; readonly doc: string };
  /**
   * Every tab's identity, in the document's order (depth-first, parents before children).
   * Never changed in place: each replay folds the pending adds over it, and answers this array
   * itself where none applies.
   */
  readonly outline: readonly GoogleDocTabIdentity[];
  /**
   * The base version of one tab: the tab as Google returned it. `undefined` for an id the
   * outline does not list. Reads one small row and no run.
   * @throws An `Error` whose message is `DOC_COPY_UNREADABLE` where storage holds another copy
   * than this one, a write was noted since, or the tab's record is gone.
   */
  tab(tabId: string): DocVersion | undefined;
  /**
   * The Markdown of `version`: a base version of this copy, or one a replay over it answered.
   * Read from storage (`DocStore.markdown`).
   */
  markdown(version: DocVersion): string;
  /**
   * The elements of each run of `version`, a base version of this copy, in order, one run
   * decoded at a time (`DocStore.runs`; a copy read in hand decodes its held tab's runs).
   * For a reader of the tab's own text. Valid until the next await.
   * @throws An `Error` whose message is `DOC_COPY_UNREADABLE` where storage holds another copy
   * than this one or a write was noted since, as `tab` does, and for a copy fetched and not
   * kept.
   */
  runs(version: DocVersion): Iterable<readonly StructuralElement[]>;
  /** Whether storage still holds this copy, with no write noted since (`DocStore.holds`). */
  held(): boolean;
  /**
   * Removes what no pending record of the document reaches (`DocStore.sweep`). The editor
   * calls it before it prepares an edit: a preparation stores its result before the caller's
   * later checks and before the edit is queued, so what an edit that was prepared and never
   * queued left (its result, the version it gave, that version's rendering) is removed by the
   * next preparation, and at most one such edit's rows are ever stored. Does nothing for a
   * copy that is not the stored one: a trial's, which its trial sweeps, one fetched and not
   * kept, one read in hand, and a view that was given no `pending`.
   */
  sweep(): void;
};

/**
 * The store and the document's key of `copy`.
 * @throws For a copy read in hand: a session with no storage queues no edit.
 */
export function storedIn(copy: DocCopy): NonNullable<DocCopy["stored"]> {
  if (!copy.stored) {
    throw new Error("This copy of the Google Doc is read in hand: it is kept in no store.");
  }
  return copy.stored;
}

/**
 * The view of the copy `head` names, of document `doc` in `store`. It remembers `head`, the
 * copy's record (its id, its outline, its tabs' write markers and its base versions' ids: no
 * tab, no rendering), and a snapshot may keep it across requests. That is safe because every
 * `tab` and every `runs` ask `store.holds(doc, head.id)` first: once a later fetch, a noted
 * write or a drop has retired the copy, the ids are not read, and both throw. A version the
 * held copy lists and storage does not hold throws as well, and the document's copy is
 * dropped first, so the next read fetches. Nothing else is declared in its body.
 * @param options.pending What the document's pending records reach, read at each `sweep`.
 * Left out, `sweep` does nothing.
 * @param options.trial Whether `head` is the record `DocStore.trial` handed its `use`, which
 * is not stored: the view then reads the versions without asking whether storage holds the
 * copy, `held()` answers `false`, and `sweep` does nothing (a sweep in the middle of a trial
 * would remove the versions the trial is reading). Such a view is for the length of that
 * `use`.
 */
export function storedDocCopy(
  store: DocStore, doc: string, head: DocCopyHead,
  options: { readonly pending?: () => DocPending; readonly trial?: boolean } = {},
): DocCopy {
  return {
    stored: { store, doc },
    outline: head.outline,
    tab(tabId) {
      let at = head.outline.findIndex(tab => tab.tabId === tabId);
      if (at === -1) return undefined;
      if (!options.trial && !store.holds(doc, head.id)) throw new Error(DOC_COPY_UNREADABLE);
      let version = store.version(
        doc, head.versions[at], { ...head.outline[at], writeMarkers: head.writeMarkers[at] });
      if (version === undefined) {
        // The record lists a version that is not stored, or that is another tab's: the copy
        // cannot be read back, as where `DocStore.tab` finds a run missing. A trial's record
        // is not the stored copy's, which is left as it is.
        if (!options.trial) store.drop(doc);
        throw new Error(DOC_COPY_UNREADABLE);
      }
      return version;
    },
    markdown: version => store.markdown(version),
    runs(version) {
      if (!options.trial && !store.holds(doc, head.id)) throw new Error(DOC_COPY_UNREADABLE);
      return store.runs(version);
    },
    held: () => !options.trial && store.holds(doc, head.id),
    sweep() {
      if (!options.trial && options.pending) store.sweep(doc, options.pending());
    },
  };
}

/**
 * The copy of a document fetched and not kept: it lists `outline` and reads no tab (`tab`
 * and `runs` throw `DOC_COPY_UNREADABLE`, `held()` is `false`). What a snapshot holds between
 * its fetch and the scope check that lets it be kept; it is read through `DocSource.read`.
 */
export function unkeptDocCopy(
  stored: NonNullable<DocCopy["stored"]>, outline: readonly GoogleDocTabIdentity[],
): DocCopy {
  return {
    stored,
    outline,
    tab() { throw new Error(DOC_COPY_UNREADABLE); },
    markdown() { throw new Error(DOC_COPY_UNREADABLE); },
    runs() { throw new Error(DOC_COPY_UNREADABLE); },
    held: () => false,
    sweep() {},
  };
}

/** What the source of a Doc opened through Drive needs of its connection's store. */
export type DriveDocCopies = {
  /**
   * `document`, as fetched at `fetchedAt`, read to its end and held for a read whose scope
   * check has not passed (`heldDoc`): its runs' stored JSON as bytes and nothing derived, at
   * most about the bytes of Google's answer. `document` is emptied as it is read. Nothing is
   * stored or read from storage.
   * @throws What `heldDoc` throws: a document the store cannot hold is refused here.
   */
  hold(document: GoogleDocsDocument, fetchedAt: number): HeldDoc;
  /**
   * Runs `use` over `document`, fetched and not kept, as the file's copy
   * (`DocStore.trial`): nothing of it is stored when `use` returns. It can be tried again,
   * and each trial decodes its runs and renders what the stored copy does not hold rendered.
   */
  trial<T>(document: HeldDoc, use: (copy: DocCopy) => T): T;
  /**
   * For a fetch NO SCOPE CHECK GUARDS (the one after an approval, the one an approval builds
   * its write from): stores `document`, as fetched at `fetchedAt`, AS IT IS READ, in a trial,
   * runs `use` over its copy and keeps nothing of it. Synchronous, in the stretch the answer
   * arrived in; `document` is emptied as it is read, and nothing of it is held.
   * @throws Before `use` is called, what storing the document throws (`DocStore.trial`,
   * `fetchedDoc`); nothing of the document is stored then.
   */
  tryFetched<T>(document: GoogleDocsDocument, fetchedAt: number, use: (copy: DocCopy) => T): T;
  /**
   * Keeps `document` as the file's copy, read under `folder` and approved at this clock
   * (`DocStore.keep`), and answers its view. Where the store holds a copy of the file fetched
   * LATER (another source kept it), nothing is kept: the answer is the view of that stored
   * copy where it is of the same document (its id is `document.id`), with the approval
   * recorded for it, and `undefined` where it is of another.
   * @param folder The Drive folder the session stood on whose read was approved; left out
   * for a session that stands on none.
   */
  keep(document: HeldDoc, folder?: string): DocCopy | undefined;
  /**
   * Records that a scope check approved a read of the stored copy under `folder`, at this
   * clock (`DocStore.touch`): the copy's record then names the folder its last approved read
   * stood on and, to the hour, when that was. No row is written where the record says so
   * already, and nothing is done where no copy is stored.
   */
  approvedUnder(folder?: string): void;
  /** The copy a snapshot holds of `document` until it is kept (`unkeptDocCopy`). */
  unkept(document: HeldDoc): DocCopy;
  /**
   * Records that a write of the connection's reached the file (`DocStore.touch` with
   * `stale`): the stored copy lacks it, so no view holds it (`held()` is `false`) and it is
   * reused by no source, of this activation or a later one, until a fetch replaces it. Its
   * rows stay for that fetch to be compared with. Does nothing where no copy is stored.
   */
  wrote(): void;
  /**
   * Removes what the file's pending edits do not reach (`DocStore.sweep`). The connection
   * calls it once an edit of the file is approved or rejected, so the version that edit gave,
   * its result and its rendering go with the record.
   */
  sweep(): void;
  /**
   * Runs the connection's expiry pass where one is due (`DriveDocCopyLimits.expire`), this
   * file's copy first. The source calls it before it decides whether a kept copy is reused,
   * so a read of a file whose own copy is past the limit fetches. Does nothing for copies
   * given no limits.
   */
  tend(): void;
};
// There is no method for a refusal: a read the scope check refuses calls nothing here. What
// is stored of the file stays as it was unless the connection finds that it does not reach
// the file (`DriveDocCopyLimits.remove`).

/**
 * A Durable Object's Doc store, made the first time it is called: a connection that opens no
 * Doc runs none of the store's table statements.
 */
export type LazyDocStore = {
  (): DocStore;
  /**
   * The store where the storage already holds its tables (made, if this activation has not
   * made it), and `undefined` where it holds none: asked of the storage's schema, so nothing
   * is created. Absent on a plain function, which is then called.
   */
  readonly existing?: () => DocStore | undefined;
};

/**
 * The `LazyDocStore` of `storage`. It keeps the store it made, which holds no document. Its
 * `existing` asks the schema for the table of the copies' records, one row read, until a
 * store is made.
 */
export function lazyDocStore(storage: DocStoreStorage): LazyDocStore {
  let made: DocStore | undefined;
  let store = () => made ??= new DocStore(storage);
  return Object.assign(store, {
    existing: () => made ?? (storage.sql.exec(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'doc_copy'",
    ).toArray().length > 0 ? store() : undefined),
  });
}

/** `store.existing()` where it has one, and `store()` otherwise. */
export function existingDocStore(store: LazyDocStore): DocStore | undefined {
  return store.existing ? store.existing() : store();
}

/**
 * How many documents a Drive connection keeps a copy of. Past it, the connection removes
 * copies (`DriveDocCopyLimits.keep`) until it holds this many.
 */
export const MAX_DRIVE_DOC_COPIES = 200;

/**
 * How many bytes of documents a Drive connection keeps copies of: the sum of its copies'
 * `DocCopyHead.bytes`, each document's runs and contexts as stored. Past it, the connection
 * removes copies until it is under; one document larger than this by itself is kept alone,
 * since the cap bounds what a connection stores and refuses no read. BESIDE WHAT IS COUNTED
 * a copy stores each run's rendering, its lists of runs and what its pending edits made. As
 * measured, the text of every row a document stores is 1.6 times its `bytes` for a tab of
 * prose and 1.8 times for a tab of 19,601 runs (one-cell tables, a run each, with a run
 * between each two); with five pending edits, each made in what the one before gave, 2.0 and
 * 3.3 times, since each edit's version lists every run of its tab. A rendering is not counted
 * because a run that stands as the stored copy has it is stored without being rendered, so
 * its Markdown's length is not in hand as the document is stored.
 */
export const MAX_DRIVE_DOC_COPY_BYTES = 512 * 1024 * 1024;

/**
 * How long a Drive connection keeps a copy that no scope check has approved a read of. A
 * copy's approval is kept to the hour (`DOC_COPY_APPROVAL_GRAIN_MS`), so a copy goes no later
 * than this after its last approved read and up to an hour sooner.
 */
export const DRIVE_DOC_COPY_EXPIRY_MS = 7 * 24 * 3_600_000;

/**
 * How many bytes of copies (`DocCopyHead.bytes`) one call of a Drive connection's expiry pass
 * drops before it leaves the rest to the connection's next call. A call is one synchronous
 * stretch, which a Durable Object commits whole or not at all, so this is the most a request
 * that was cut short does again. NOT COUNTED, as in `MAX_DRIVE_DOC_COPY_BYTES`: the lists of
 * a document's pending edits, a row for each run of the tab an edit. As measured where the
 * runs are smallest (a tab of 19,601 runs, 9.4 MB of `bytes`, whose drop writes 39,208 rows),
 * a call that meets this figure dropped eight such documents and wrote about 314,000 rows.
 */
export const DRIVE_DOC_EXPIRY_CALL_BYTES = 64 * 1024 * 1024;

/** Where a connection that stores a Doc keeps the hour of its last finished expiry pass. */
export const DOC_COPY_EXPIRY_PASS_KEY = "driveDocs:expiryPass";

/** Why a Drive connection removed a document's stored copy. */
export type DocCopyRemoval =
  | { readonly event: "evicted"; readonly reason: "count" | "bytes" }
  | { readonly event: "expired"; readonly reason: "unapproved" }
  | { readonly event: "unreachable"; readonly reason: "invisible" | "trashed" | "moved-out" };

/**
 * The copies to remove so that a connection is under both caps, in the order they go:
 * `copies` less `keeping`, the documents with no pending edit before every document with
 * one, and within each the copy whose last approved read is oldest first (`approvedAt`, an
 * absent one first; then the older fetch; then the document's key, so the order is total).
 * Copies are taken from the front while more than `caps.count` are left or their `bytes`,
 * with `keeping`'s, pass `caps.bytes`: each with the cap it was taken for (`"count"` where
 * both are passed). `keeping` is never among them, so one document past `caps.bytes` by
 * itself stays, alone.
 */
export function copiesOverCap(
  copies: readonly DocCopyRecord[], keeping: string, pending: ReadonlySet<string>,
  caps: { readonly count: number; readonly bytes: number },
): { doc: string; reason: "count" | "bytes" }[] {
  let left = copies.length, bytes = copies.reduce((sum, copy) => sum + copy.bytes, 0);
  let candidates = copies.filter(copy => copy.doc !== keeping).toSorted((a, b) =>
    Number(pending.has(a.doc)) - Number(pending.has(b.doc)) ||
    // A clock is never negative, so a copy with no approval stands before every other.
    (a.approvedAt ?? -1) - (b.approvedAt ?? -1) ||
    a.fetchedAt - b.fetchedAt ||
    (a.doc < b.doc ? -1 : 1));
  let over: { doc: string; reason: "count" | "bytes" }[] = [];
  for (let copy of candidates) {
    if (left <= caps.count && bytes <= caps.bytes) break;
    over.push({ doc: copy.doc, reason: left > caps.count ? "count" : "bytes" });
    left--;
    bytes -= copy.bytes;
  }
  return over;
}

/** What `DriveDocCopyLimits` needs of its connection. */
export type DriveDocCopyLimitsOptions = {
  /** The connection's Doc store. */
  readonly store: LazyDocStore;
  /** The documents that have an edit awaiting a decision, by their key in the store. */
  pendingDocs(): ReadonlySet<string>;
  /**
   * Told of each copy removed, once the transaction that removed it returned: the connection
   * logs it. That is before the request's writes are durable, so where the object is reset
   * before they are, the copy is stored still and is removed, and told of, again.
   */
  removed(doc: string, why: DocCopyRemoval): void;
  /** The caps. For tests. Defaults to `MAX_DRIVE_DOC_COPIES` and `MAX_DRIVE_DOC_COPY_BYTES`. */
  readonly caps?: { readonly count: number; readonly bytes: number };
  /** What one call of the expiry pass drops. For tests. Defaults to `DRIVE_DOC_EXPIRY_CALL_BYTES`. */
  readonly expiryCallBytes?: number;
  /** The connection's KV, where the hour of the last finished expiry pass is kept. */
  readonly kv: { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void };
  /** Clock, for tests. Defaults to `Date.now`, read at each call. */
  readonly now?: () => number;
};

/**
 * The limits of what one Drive connection's Doc store keeps. A stored copy is a cache: it
 * saves a fetch and the work of making pending edits again, and nothing depends on its
 * staying, so each removal here costs the document's next approved read one fetch and
 * changes no edit, card, approval or refusal. One for a connection's activation, shared by
 * every session; it holds no document and no record of one, only the hour of its last expiry
 * pass.
 */
export class DriveDocCopyLimits {
  #options: DriveDocCopyLimitsOptions;
  /** The hour of the last finished expiry pass, once the connection's KV was asked for it. */
  #passed: number | undefined;

  constructor(options: DriveDocCopyLimitsOptions) {
    this.#options = options;
  }

  /**
   * `DocStore.keep` for `doc` and then the caps, in ONE transaction: the document is kept,
   * the copies' small records are read (`DocStore.copies`) and every copy `copiesOverCap`
   * names is dropped (`DocStore.drop`), `doc`'s own never. The one transaction is meant: the
   * connection is under both caps wherever it commits, and a drop that fails undoes the keep
   * with it, as a failed keep leaves the copy stored before. What it removes is bounded by
   * what it kept: a connection under its caps before the keep is over them by no more than
   * the document kept. `removed` is told of each after the transaction. Call it outside any
   * other transaction. Reads a row a copy and the connection's pending records; a drop
   * brings no list to the isolate.
   */
  keep(
    doc: string, document: FetchedDoc, pending: DocPending,
    approved: { readonly folder?: string; readonly at: number },
  ): DocCopyHead {
    let store = this.#options.store();
    let caps = this.#options.caps ?? { count: MAX_DRIVE_DOC_COPIES, bytes: MAX_DRIVE_DOC_COPY_BYTES };
    let kept = store.transaction(() => {
      let head = store.keep(doc, document, pending, approved);
      let evicted = copiesOverCap(store.copies(), doc, this.#options.pendingDocs(), caps);
      for (let copy of evicted) store.drop(copy.doc);
      return { head, evicted };
    });
    for (let { doc: gone, reason } of kept.evicted) {
      this.#options.removed(gone, { event: "evicted", reason });
    }
    return kept.head;
  }

  /**
   * The expiry pass, where one is due: AT MOST ONCE AN HOUR of the clock (`approvalHour`).
   * The hour of the last finished pass is kept in the connection's KV
   * (`DOC_COPY_EXPIRY_PASS_KEY`) and, once read, in memory, so a call inside that hour reads
   * and writes nothing, and a connection started again within it reads one key. A pass reads
   * the copies' small records (`DocStore.copies`: a row a copy and nothing else) and drops
   * the copies whose last approved read (`approvedAt`) is `DRIVE_DOC_COPY_EXPIRY_MS` or more
   * before the hour of the clock; a copy with no `approvedAt` is not a scope-checked one and
   * stays. `reading`'s copy goes first where it is past the limit, and then the copy whose
   * approval is oldest.
   *
   * ONE CALL DROPS A BOUNDED AMOUNT. It stops once the copies it dropped hold
   * `DRIVE_DOC_EXPIRY_CALL_BYTES` of `bytes`, so it drops one copy at least, and it then
   * leaves the hour unwritten: the connection's next call reads the records again and goes
   * on, and the hour is written by the call that leaves no copy past the limit. Each copy is
   * dropped in a transaction of its own (`DocStore.drop`), and `removed` is told of it then,
   * so a drop that throws leaves the copies dropped before it gone. A CALL IS ONE SYNCHRONOUS
   * STRETCH, WHICH A DURABLE OBJECT COMMITS WHOLE: where the object is reset before the
   * request's writes are durable, every drop of that call is undone, though `removed` was told
   * of each, and what earlier calls dropped stays. So a call its request cannot finish is done
   * again at the size of the bound, never of the connection.
   *
   * Where the storage holds no Doc table there is nothing to pass over: none is made and no
   * key is written. Synchronous. NEVER CALL IT INSIDE A TRANSACTION: one that failed later
   * would bring the dropped copies back.
   *
   * The connection calls it when it is used: as each session starts, as the first statement
   * of an approval and of a rejection of any record, and at the start of a Doc read's
   * snapshot with the file read as `reading`, so that file's copy, where it is past the
   * limit, is gone before the read looks for it. A call that names no file may leave a copy
   * past the limit to a later one, where its bound was met. NO ALARM CALLS IT, so a
   * connection nobody uses again keeps what it stored, under the caps, until it is used or
   * its storage is deleted.
   */
  expire(reading?: string): void {
    let hour = approvalHour((this.#options.now ?? Date.now)());
    if (this.#passed === undefined) {
      // Read once an activation. Anything but a finite number counts as no pass: `NaN` is
      // no hour of the clock.
      let stored = this.#options.kv.get<unknown>(DOC_COPY_EXPIRY_PASS_KEY);
      this.#passed = typeof stored === "number" && Number.isFinite(stored) ? stored : NaN;
    }
    if (this.#passed === hour) return;
    let store = existingDocStore(this.#options.store);
    if (!store) {
      // No Doc table: nothing to pass over this hour, and the key is left unwritten.
      this.#passed = hour;
      return;
    }
    // The file being read first, then the oldest approval (every copy past the limit has
    // one); the sort keeps the store's order among equals.
    let due = store.copies()
      .filter(({ approvedAt }) =>
        approvedAt !== undefined && hour - approvedAt >= DRIVE_DOC_COPY_EXPIRY_MS)
      .toSorted((a, b) => Number(b.doc === reading) - Number(a.doc === reading) ||
        (a.approvedAt ?? 0) - (b.approvedAt ?? 0));
    let left = this.#options.expiryCallBytes ?? DRIVE_DOC_EXPIRY_CALL_BYTES;
    for (let { doc, bytes } of due) {
      // The call's bound is met: the hour stays unwritten, and the next call goes on.
      if (left <= 0) return;
      store.drop(doc);
      this.#options.removed(doc, { event: "expired", reason: "unapproved" });
      left -= bytes;
    }
    this.#options.kv.put(DOC_COPY_EXPIRY_PASS_KEY, hour);
    this.#passed = hour;
  }

  /**
   * The record of `doc`'s stored copy, `undefined` where none is stored or the storage holds
   * no Doc table (none is made).
   */
  stored(doc: string): DocCopyHead | undefined {
    return existingDocStore(this.#options.store)?.head(doc);
  }

  /**
   * Drops `doc`'s copy for `why`, in one transaction of its own (`DocStore.drop`), where its
   * record is still `seen`: the same copy (`id`), fetched at the same clock, last approved in
   * the same hour under the same folder; and tells `removed`. Does nothing otherwise. What the
   * record cannot show is an approval of the same copy in the same hour under the same folder,
   * which writes nothing: such a copy goes, and its file's next approved read fetches once.
   * Call it outside any other transaction: one that failed later would bring the copy back
   * after `removed` was told.
   */
  remove(doc: string, seen: DocCopyHead, why: DocCopyRemoval): void {
    let store = existingDocStore(this.#options.store);
    let head = store?.head(doc);
    if (!store || !head || head.id !== seen.id || head.fetchedAt !== seen.fetchedAt ||
      head.approvedAt !== seen.approvedAt || head.folder !== seen.folder) {
      return;
    }
    store.drop(doc);
    this.#options.removed(doc, why);
  }
}

/**
 * `DriveDocCopies` for document `doc` of the connection's store, which `store` makes the
 * first time it is asked. `pending` answers what the file's pending edits still reach, read at
 * each call: every session of a connection is given the connection's, one that cannot edit
 * included, since `keep` and `trial` sweep with it; none is for a store no edit is queued on.
 * `keep` and `approvedUnder` take the clock of the approval themselves (`Date.now()`). The
 * views `keep` answers are given `pending`, so their `sweep` removes what the file's pending
 * edits do not reach, as its own `sweep` does. `keep` puts a document over a stored copy that
 * is stale whenever each was fetched: a copy a write overtook is no later document.
 *
 * With `limits`, a keep is the connection's (`DriveDocCopyLimits.keep`): the copy is kept and
 * the connection brought under its caps in one transaction. A trial keeps nothing and evicts
 * nothing, and neither does a keep that leaves a later copy in place. Every session a Drive
 * connection builds is given the connection's; with none, nothing is capped.
 */
export function driveDocCopies(
  store: LazyDocStore, doc: string,
  pending: (store: DocStore) => DocPending = () => ({ edits: [], roots: [] }),
  limits?: DriveDocCopyLimits,
): DriveDocCopies {
  // Runs `use` over `document` as the file's copy, stored for the length of the call.
  let tried = <T>(document: FetchedDoc, use: (copy: DocCopy) => T): T =>
    store().trial(doc, document, () => pending(store()),
      head => use(storedDocCopy(store(), doc, head, { trial: true })));
  return {
    // The store is asked for the sizes it cuts to, and for nothing else.
    hold: (document, fetchedAt) => heldDoc(doc, store().fetched(document, fetchedAt)),
    trial: tried,
    tryFetched: (document, fetchedAt, use) => tried(store().fetched(document, fetchedAt), use),
    keep(document, folder) {
      let approved = { ...(folder === undefined ? {} : { folder }), at: Date.now() };
      let held = store().head(doc);
      // A stale copy lacks a write the document may hold: it is replaced whenever it was
      // fetched.
      if (held && !held.stale && held.fetchedAt > document.fetchedAt) {
        // Another source of the file kept a document fetched after this one: a slow read must
        // not put its older document over it. Where the two are the same document, the stored
        // copy is this read's too.
        if (held.id !== document.id) return undefined;
        store().touch(doc, { approved });
      } else {
        held = limits
          ? limits.keep(doc, document, pending(store()), approved)
          : store().keep(doc, document, pending(store()), approved);
      }
      return storedDocCopy(store(), doc, held, { pending: () => pending(store()) });
    },
    approvedUnder: folder => store().touch(
      doc, { approved: { ...(folder === undefined ? {} : { folder }), at: Date.now() } }),
    unkept: document => unkeptDocCopy(
      { store: store(), doc }, document.tabs.map(tab => tab.identity)),
    wrote: () => store().touch(doc, { stale: true }),
    sweep: () => store().sweep(doc, pending(store())),
    tend: () => limits?.expire(doc),
  };
}

/**
 * `DriveDocCopies` for a session that was given no storage: the document is read IN HAND.
 * `hold` answers the document held (`heldDoc`: its runs' stored JSON as bytes, and nothing
 * made of them); `unkept` and `keep` answer a copy that holds that held document (`tab`
 * answers a handle made from the tab's record, `markdown` decodes and renders the tab's runs
 * one at a time, `runs` decodes them one at a time, `held()` is `true`, `stored` is absent);
 * `trial` runs `use` over such a copy, and `tryFetched` over one that holds the document for
 * the length of `use`; `approvedUnder`, `wrote`, `sweep` and `tend` do nothing, and so does
 * the copy's `sweep`. So the snapshot its source keeps holds the document in memory, for as
 * long as the source does: it is the one holder of a document in a source's memory. No
 * rendering is kept: each `markdown` renders the tab. It refuses a document the store could
 * not hold, one with an element or a tab's lists past a row, as a session with storage does,
 * though it stores nothing: one reading of a fetched document serves both.
 *
 * It exists for `GoogleDriveSessionImpl` built with no storage at all, which reads Docs
 * without editing them. Every session a Drive connection's Durable Object builds, read-only
 * ones included, is given the connection's store and keeps its Docs there, so these bytes
 * wait only in a session built with no storage.
 */
export function inHandDocCopies(): DriveDocCopies {
  return {
    hold: (document, fetchedAt) => heldDoc("", fetchedDoc(document, fetchedAt)),
    trial: (document, use) => use(inHandDocCopy(document)),
    tryFetched: (document, fetchedAt, use) =>
      use(inHandDocCopy(heldDoc("", fetchedDoc(document, fetchedAt)))),
    keep: inHandDocCopy,
    approvedUnder() {},
    unkept: inHandDocCopy,
    wrote() {},
    sweep() {},
    tend() {},
  };
}

/** A copy that holds `document` itself, and no rendering of it: what `inHandDocCopies` answers. */
function inHandDocCopy(document: HeldDoc): DocCopy {
  return {
    outline: document.tabs.map(tab => tab.identity),
    tab(tabId) {
      let found = document.tabs.find(tab => tab.identity.tabId === tabId);
      // A handle of the tab in hand: it names no stored version, and no run is read for it.
      return found && {
        ...found.identity,
        id: tabId,
        doc: "",
        bodyEndIndex: found.bodyEndIndex,
        exact: false,
        writeMarkers: found.writeMarkers,
      };
    },
    markdown(version) {
      let found = document.tabs.find(tab => tab.identity.tabId === version.tabId);
      if (!found) throw new Error(DOC_COPY_UNREADABLE);
      return fetchedMarkdown(found);
    },
    runs(version) {
      let found = document.tabs.find(tab => tab.identity.tabId === version.tabId);
      if (!found) throw new Error(DOC_COPY_UNREADABLE);
      // The mapper's run is its own: nothing here names a run when the next is decoded.
      return Iterator.from(found.runs).map(run => run.elements);
    },
    held: () => true,
    sweep() {},
  };
}

/**
 * A copy as `StoredDocCopy` answers it. It says when the copy was fetched, not whether the
 * provider still holds it so.
 */
export type HeldDocCopy = {
  readonly copy: DocCopy;
  /** The clock when the fetch that brought the copy began. A revision check does not move it. */
  readonly fetchedAt: number;
  /** Google's revision of the copy, where the fetch reported one. */
  readonly revision?: string;
  /**
   * The document's title as the fetch answered it, where the work that answered this call
   * fetched the document; absent where the copy was served from storage. It is stored
   * nowhere.
   */
  readonly title?: string;
};

/** Where a `StoredDocCopy` keeps its copy, where the document comes from, and how fresh. */
export type StoredDocCopyOptions = {
  readonly store: DocStore;
  /** The document's key in `store`. */
  readonly doc: string;
  /** The object's storage, for the keys under `docCopy:`, which nothing reads. */
  readonly storage: UnreadDocCopyStorage;
  /**
   * Fetches the document from Google. The document it answers is emptied as it is stored, so
   * it answers one of its own each time.
   */
  readonly fetch: () => Promise<GoogleDocsDocument>;
  /** How long a copy is served without asking Google anything. A positive integer. */
  readonly ttlMs: number;
  /**
   * Whether Google still holds this revision; cheaper than `fetch`. Asked once a copy with a
   * revision is older than `ttlMs`. Absent, or with no revision held, an old copy is fetched
   * again.
   */
  readonly unchanged?: (revision: string) => Promise<boolean>;
  /** What the document's pending records still reach (`pendingDocKeys`), read at each call. */
  readonly pending: () => DocPending;
  /** Clock, for tests. Defaults to `Date.now`, read at each call. */
  readonly now?: () => number;
};

/** A document fetched, not read and not kept, with its answer's title: what `#keep` takes. */
type Fetched = { readonly epoch: number; readonly document: FetchedDoc; readonly title?: string };

/**
 * One document's copy in a `DocStore`: served while fresh, checked against Google's revision
 * when old, readable synchronously inside a transaction, and fetched apart from being kept.
 * Storage is the truth: what is served is always read from the store, so nothing is lost when
 * the Durable Object is evicted, and a reader finds the earlier copy or the later one whole.
 * What is in memory only is the fetch in flight and a count of the calls that made it
 * worthless, so build one per Durable Object activation and share it.
 */
export class StoredDocCopy {
  readonly #store: DocStore;
  readonly #doc: string;
  readonly #storage: UnreadDocCopyStorage;
  readonly #source: () => Promise<GoogleDocsDocument>;
  readonly #ttlMs: number;
  readonly #unchanged: ((revision: string) => Promise<boolean>) | undefined;
  readonly #pending: () => DocPending;
  readonly #now: () => number;
  // Counts the calls that made work in flight worthless.
  #epoch = 0;
  readonly #flights = new SingleFlight<"current">();
  // Whether a scan found no key under `docCopy:`. The activation scans no more after that.
  #unreadGone: boolean;

  /**
   * @throws For a `ttlMs` that is not a positive safe integer. Removes one batch of the keys
   * under `docCopy:` (`removeUnreadDocCopyKeys`).
   */
  constructor(options: StoredDocCopyOptions) {
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1) {
      throw new Error(`ttlMs must be a positive safe integer, got ${options.ttlMs}.`);
    }
    this.#store = options.store;
    this.#doc = options.doc;
    this.#storage = options.storage;
    this.#source = options.fetch;
    this.#ttlMs = options.ttlMs;
    this.#unchanged = options.unchanged;
    this.#pending = options.pending;
    this.#now = options.now ?? (() => Date.now());
    this.#unreadGone = removeUnreadDocCopyKeys(options.storage);
  }

  /**
   * The copy, as fresh as `ttlMs` asks. Serves the stored copy while it was fetched or
   * confirmed less than `ttlMs` ago. Past that, a copy with a revision is confirmed with
   * `unchanged`, which restarts its age (from when the question was asked) and stores nothing
   * else; otherwise the document is fetched, and stored as it is read, in one transaction
   * (`DocStore.keep`). Calls share one fetch as long as no `noteWrite()`, `recheck()` or
   * `drop()` comes between them; a call made after one of those is never answered by work
   * begun before it. A failed `fetch`, `unchanged` or keep rejects and leaves the stored copy
   * as it was. While keys under `docCopy:` remain, each call removes one more batch.
   *
   * With `confirm: false` a copy past `ttlMs` is fetched again and never confirmed with
   * `unchanged`, for a caller that may spend one request and no more. A call joins the flight
   * in progress, whichever kind began it.
   * @returns The copy served or kept, with the document's title where this call's flight
   * fetched it. Read it before awaiting anything else.
   */
  current(options: { readonly confirm?: boolean } = {}): Promise<HeldDocCopy> {
    if (!this.#unreadGone) this.#unreadGone = removeUnreadDocCopyKeys(this.#storage);
    return this.#flights.run("current", () => this.#load(options.confirm ?? true));
  }

  /**
   * The stored copy, whatever its age. Synchronous and read-only, for use inside
   * `transactionSync` and while Google is unreachable. `undefined` when none is stored or a
   * write was noted since it was fetched. It reads the copy's record only.
   */
  held(): HeldDocCopy | undefined {
    let head = this.#store.head(this.#doc);
    return head && !head.stale ? this.#view(head) : undefined;
  }

  /**
   * Records that a write reached Google. The stored copy lacks it and is served to no one
   * again; its rows stay stored for the next fetch to be compared with, so that fetch writes
   * only the tabs the write changed. A fetch in flight began before the write: its answer is
   * neither kept nor served, its callers get the fetch that follows, and a `current()` called
   * after this never joins it. Synchronous.
   */
  noteWrite(): void {
    this.#supersede();
    this.#store.touch(this.#doc, { stale: true });
  }

  /**
   * Makes the next `current()` confirm the stored copy with `unchanged` (or fetch) whatever
   * its age. Work in flight starts over. Synchronous.
   */
  recheck(): void {
    this.#supersede();
    this.#store.touch(this.#doc, { checkedAt: null });
  }

  /**
   * Removes the stored copy and everything stored for the document, in one transaction. Work
   * in flight starts over. Synchronous.
   */
  drop(): void {
    this.#supersede();
    this.#store.drop(this.#doc);
  }

  /**
   * `DocStore.sweep` for this document and what its pending records reach: call it in the
   * transaction that removes a pending record. Synchronous.
   */
  sweep(): void {
    this.#store.sweep(this.#doc, this.#pending());
  }

  // Makes work in flight worthless to every `current()` called from here on. The epoch alone is
  // not enough: it tells work past an `await` that its answer predates this call, but work that
  // has already answered stays joinable until its release microtask runs, and would hand a call
  // made in that window the copy from before. So the flight is forgotten as well.
  #supersede(): void {
    this.#epoch++;
    this.#flights.forget("current");
  }

  async #load(confirm: boolean): Promise<HeldDocCopy> {
    // Read before anything else and compared after the `await`. Where it moved, this work was
    // superseded and its flight forgotten, so `current()` joins the flight begun since or begins
    // one, and every superseded caller shares that one.
    let epoch = this.#epoch;
    let head = this.#store.head(this.#doc);
    if (head !== undefined && !head.stale) {
      let now = this.#now();
      if (head.checkedAt !== undefined && now - head.checkedAt < this.#ttlMs) {
        return this.#view(head);
      }
      if (confirm && head.revision !== undefined && this.#unchanged !== undefined) {
        let same = await this.#unchanged(head.revision);
        if (epoch !== this.#epoch) return this.current({ confirm });
        if (same) {
          // The age restarts from when the question was asked, and only the record is written.
          this.#store.touch(this.#doc, { checkedAt: now });
          return this.#view(head);
        }
      }
    }
    return this.#keep(await this.#fetch()) ?? this.current({ confirm });
  }

  /**
   * Fetches the document, storing nothing and reading nothing of it but its title: `#keep`
   * reads it as it stores it.
   */
  async #fetch(): Promise<Fetched> {
    let epoch = this.#epoch;
    let fetchedAt = this.#now();
    let answer = await this.#source();
    // Read before the store is handed the answer, which it empties as it reads it.
    let { title } = answer;
    return { epoch, document: this.#store.fetched(answer, fetchedAt), title };
  }

  /**
   * Keeps what `#fetch` returned, in one transaction, or keeps nothing and answers `undefined`
   * when a `noteWrite()`, `recheck()` or `drop()` came after the fetch began.
   */
  #keep(fetched: Fetched): HeldDocCopy | undefined {
    // The epoch is the whole check: `current()` runs one flight at a time and each of those
    // calls moves the epoch, so no fetch is kept behind a later one without it having moved.
    if (fetched.epoch !== this.#epoch) return undefined;
    let held = this.#view(this.#store.keep(this.#doc, fetched.document, this.#pending()));
    return fetched.title === undefined ? held : { ...held, title: fetched.title };
  }

  // The copy `head` names, as a view of storage: it holds the copy's record and no tab.
  #view(head: DocCopyHead): HeldDocCopy {
    return {
      copy: storedDocCopy(this.#store, this.#doc, head, { pending: this.#pending }),
      fetchedAt: head.fetchedAt,
      ...(head.revision === undefined ? {} : { revision: head.revision }),
    };
  }
}

/** What `removeUnreadDocCopyKeys` needs of a Durable Object's storage. */
export type UnreadDocCopyStorage = {
  readonly kv: {
    list<T>(options: { prefix: string; limit?: number }): Iterable<[string, T]>;
    delete(key: string): unknown;
  };
  transactionSync<T>(callback: () => T): T;
};

// A copy of the document that nothing reads: `docCopy:doc:manifest` (an index) and, for each
// part of the copy, `docCopy:doc/<part>:manifest` and `docCopy:doc/<part>:chunk:NNNN`.
const UNREAD_DOC_COPY_PREFIX = "docCopy:";
const UNREAD_DOC_COPY_BATCH = 16;

/**
 * Removes up to `limit` of the keys that start `docCopy:` (a copy stored as an index and, for
 * each part, a manifest and chunks of up to 1 MiB), which nothing reads, in one transaction.
 * The keys are found by a scan, so a removal interrupted anywhere is taken up by the next call
 * and nothing records how far it got. Each key's value passes through memory once (a chunk is
 * at most 1 MiB) and none is kept: the scan collects keys, and the deletes run after it ends.
 * @returns Whether no such key remains.
 */
export function removeUnreadDocCopyKeys(
  storage: UnreadDocCopyStorage, limit: number = UNREAD_DOC_COPY_BATCH,
): boolean {
  let keys: string[] = [];
  // The entries are stepped, never spread: each value is let go as the loop moves on.
  for (let [key] of storage.kv.list<unknown>({ prefix: UNREAD_DOC_COPY_PREFIX, limit })) {
    keys.push(key);
  }
  // Storage keeps one scan alive at a time, so the deletes wait for the scan to end.
  if (keys.length > 0) {
    storage.transactionSync(() => {
      for (let key of keys) storage.kv.delete(key);
    });
  }
  return keys.length < limit;
}
