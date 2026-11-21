// The Durable Objects the workerd tests of Docs' stored copy and of the Doc store run in.

import { DurableObject } from "cloudflare:workers";
import { removeUnreadDocCopyKeys, StoredDocCopy } from "../src/docs-copy";
import type { GoogleDocsDocument } from "../src/docs-api";
import { DOC_ROW_BYTES, DocStore } from "../src/docs-store";
import {
  anotherDigestScenario, scenarioTab, storeScenario, tableCounts,
} from "./doc-store-scenarios";

/** The Doc store over a real DO's storage; scenarios run inside it, so no document crosses RPC. */
export class DocStoreHost extends DurableObject {
  readonly #store = new DocStore(this.ctx.storage);

  /** Runs the scenario `name` of the store's scenarios over this object's storage. */
  scenario(name: "store" | "anotherDigest"): unknown {
    return name === "store" ? storeScenario(this.ctx.storage) : anotherDigestScenario(this.ctx.storage);
  }

  /** Whether the object's store holds a copy of document `doc`. */
  holds(doc: string): boolean {
    return this.#store.head(doc) !== undefined;
  }

  /** Writes a row with a statement that returns it, and leaves the statement's cursor unread. */
  writeReturningUnread(): void {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS unread (id INTEGER PRIMARY KEY) STRICT");
    this.ctx.storage.sql.exec("INSERT INTO unread (id) VALUES (1) RETURNING id");
  }

  /** How many rows `writeReturningUnread` left. */
  unreadRows(): number {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS unread (id INTEGER PRIMARY KEY) STRICT");
    return this.ctx.storage.sql.exec<{ rows: number }>("SELECT count(*) AS rows FROM unread").one().rows;
  }
}

const COPY_TTL_MS = 1_000;
const MEBIBYTE = 1_048_576;
/** In place of a tab's text: a text of one character repeated past what one row holds. */
const TOO_LARGE = "too large for a row";

/**
 * A Doc's stored copy over a real DO's storage, each tab one paragraph of the text given. The
 * copy is built at the first read, so a test of `docCopy:` keys alone runs none of its removals.
 */
export class DocCopyHost extends DurableObject {
  #answer: Record<string, string> = {};
  #now = 0;
  #fetches = 0;
  #store = new DocStore(this.ctx.storage);
  #opened: StoredDocCopy | undefined;

  get #copy(): StoredDocCopy {
    return this.#opened ??= new StoredDocCopy({
      store: this.#store,
      doc: "doc",
      storage: this.ctx.storage,
      ttlMs: COPY_TTL_MS,
      now: () => this.#now,
      fetch: async () => {
        this.#fetches++;
        return this.#document(this.#answer);
      },
      pending: () => ({ edits: [], roots: [] }),
    });
  }

  // A text past one row is built here, so it never crosses RPC.
  #document(tabs: Record<string, string>): GoogleDocsDocument {
    return {
      documentId: "doc-1",
      title: "A document",
      tabs: Object.entries(tabs).map(([tabId, text], index) => ({
        ...scenarioTab(tabId, [text === TOO_LARGE ? "a".repeat(DOC_ROW_BYTES + 1) : text]),
        index,
      })),
    };
  }

  /** Fetches the tabs `tabs` names, the stored copy being too old to serve; answers their ids. */
  async read(tabs: Record<string, string>): Promise<string[]> {
    this.#answer = tabs;
    this.#now += COPY_TTL_MS;
    return (await this.#copy.current()).copy.outline.map(({ tabId }) => tabId);
  }

  /** Starts over as an activation after an eviction does: storage alone is kept. */
  evict(): void {
    this.#store = new DocStore(this.ctx.storage);
    this.#opened = undefined;
  }

  /** Ends this activation: the call fails, and the next reaches an instance that has storage alone. */
  restart(): void {
    this.ctx.abort("Restarted by the test.");
  }

  /** The text of one tab of the stored copy, or `null` where it holds none under that id. */
  tab(tabId: string): string | null {
    let version = this.#copy.held()?.copy.tab(tabId);
    if (!version) return null;
    return this.#store.tab(version).body.content
      .flatMap(element => element.paragraph?.elements ?? [])
      .map(element => element.textRun?.content ?? "")
      .join("")
      .trimEnd();
  }

  /** How many times the document was fetched. */
  fetches(): number {
    return this.#fetches;
  }

  /** How many rows each table of documents holds. */
  counts(): Record<string, number> {
    return tableCounts(this.ctx.storage);
  }

  /** Every KV key of the object. */
  keys(): string[] {
    let keys: string[] = [];
    for (let [key] of this.ctx.storage.kv.list()) keys.push(key);
    return keys;
  }

  /** Keeps `tabs` and puts the key `beside` in one transaction, which then fails where `fail` says. */
  keepBeside(tabs: Record<string, string>, beside: string, fail: boolean): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put(beside, true);
      this.#store.keep("doc", this.#store.fetched(this.#document(tabs), this.#now), { edits: [], roots: [] });
      if (fail) throw new Error("The transaction around the keep failed.");
    });
  }

  /** Inserts a copy's record whose `fetched_at` is text, or one with no `id`. */
  insertRecord(wrong: "fetched_at" | "id"): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO doc_copy (doc, id, fetched_at, stale, made, bytes, outline, markers, versions)
       VALUES (?, ?, ?, 0, 'made', 0, '[]', '[]', '[]')`,
      "doc", wrong === "id" ? null : "copy", wrong === "fetched_at" ? "yesterday" : 1_000,
    );
  }

  /** Writes a `docCopy:` copy of `parts` parts of `megabytes` 1 MiB chunks, and the keys `others`. */
  writeUnreadCopy(parts: number, megabytes: number, others: string[]): void {
    let { kv } = this.ctx.storage;
    kv.put("docCopy:doc:manifest", { size: 0, chunks: 0 });
    for (let part = 0; part < parts; part++) {
      let name = `docCopy:doc/t.${part}`;
      kv.put(`${name}:manifest`, { size: megabytes * MEBIBYTE, chunks: megabytes });
      for (let at = 0; at < megabytes; at++) {
        kv.put(`${name}:chunk:${String(at).padStart(4, "0")}`, new Uint8Array(MEBIBYTE).fill(part + 1));
      }
    }
    for (let key of others) kv.put(key, { kept: key });
  }

  /** `removeUnreadDocCopyKeys` over this object's storage. */
  removeUnread(limit: number): boolean {
    return removeUnreadDocCopyKeys(this.ctx.storage, limit);
  }
}
