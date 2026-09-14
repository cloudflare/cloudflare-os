// RPC cursor wrappers and the session-side git-cache holder, shared by the GitLab gatekeeper's
// sessions. The same shapes as gatekeeper-github's: an in-memory cursor, a streaming cursor that
// overlays simulation onto remote pages and merges provisional rows at their sort positions, an
// advertising wrapper that reports each page's commit ids to the workspace git cache, and the
// holder that owns a session's `GitCache` stub.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue, Cursor, GitCache, GitOid } from "@gadgets/workshop-shared/gatekeeper";
import { CommitAdvertisingCursor, advertiseCommits } from "@gadgets/gatekeeper-kit/git-objects";

@validateRpc()
export class ArrayCursor<T> extends RpcTarget implements Cursor<T> {
  #items: T[];
  #pageSize: number;
  #index = 0;

  constructor(items: T[], pageSize: number) {
    super();
    this.#items = items;
    this.#pageSize = pageSize;
  }

  async next(): Promise<T[] | null> {
    if (this.#index >= this.#items.length) return null;
    const next = this.#items.slice(this.#index, this.#index + this.#pageSize);
    this.#index += this.#pageSize;
    return next;
  }
}

/**
 * A cursor that lazily fetches pages from a remote API, applies an overlay and filter to each
 * item, and merges in pre-computed provisional items at their correct sort positions.
 *
 * This avoids the need to fetch ALL pages upfront before returning any results, which is
 * critical for projects with large issue/MR histories.
 */
@validateRpc()
export class StreamingCursor<T> extends RpcTarget implements Cursor<T> {
  /** Fetches one page of already-normalized items from the remote API (or cache). */
  #fetchPage: (page: number, perPage: number) => Promise<T[]>;
  /** Applies simulation overlay to a single item. */
  #overlay: (item: T) => T;
  /** Returns false for items that should be excluded after overlay. */
  #filter: (item: T) => boolean;
  /** Comparator consistent with the remote API's sort order. Negative if a comes before b. */
  #comparator: (a: T, b: T) => number;
  /** Pre-computed injected items, already overlaid and filtered, sorted by #comparator. */
  #injectedItems: T[];
  #injectedIndex = 0;
  /**
   * Re-validates an injected item at the moment `next()` serves it (a page may be drained long
   * after the cursor -- and its injected snapshot -- was built): returns the item to serve,
   * possibly refreshed, or null to drop it. Must not change the item's sort position. Defaults
   * to serving the snapshot as-is.
   */
  #revalidateInjected: (item: T) => T | null;

  /** Rows buffered ahead of what next() has returned; injected ones re-validate when served. */
  #buffer: { item: T; injected: boolean }[] = [];
  #remotePage = 1;
  #remotePerPage: number;
  #remoteExhausted = false;
  #pageSize: number;

  constructor(options: {
    fetchPage: (page: number, perPage: number) => Promise<T[]>;
    overlay: (item: T) => T;
    filter: (item: T) => boolean;
    comparator: (a: T, b: T) => number;
    injectedItems: T[];
    revalidateInjected?: (item: T) => T | null;
    pageSize: number;
    remotePageSize?: number;
  }) {
    super();
    this.#fetchPage = options.fetchPage;
    this.#overlay = options.overlay;
    this.#filter = options.filter;
    this.#comparator = options.comparator;
    this.#injectedItems = options.injectedItems;
    this.#revalidateInjected = options.revalidateInjected ?? (item => item);
    this.#pageSize = options.pageSize;
    this.#remotePerPage = options.remotePageSize ?? 100;
  }

  async next(): Promise<T[] | null> {
    // Fill the page from the buffer, loading more when it runs dry. Injected rows re-validate
    // at the moment they are *served*, not when they were buffered: #loadMore buffers a whole
    // remote page at once, so with a small page size a row can sit in the buffer across many
    // next() calls -- plenty of time for the state that justified it to change underneath.
    const page: T[] = [];
    while (page.length < this.#pageSize) {
      const entry = this.#buffer.shift();
      if (entry === undefined) {
        if (this.#fullyExhausted()) break;
        await this.#loadMore();
        continue;
      }
      const item = entry.injected ? this.#revalidateInjected(entry.item) : entry.item;
      if (item !== null) page.push(item);
    }
    return page.length === 0 ? null : page;
  }

  #fullyExhausted(): boolean {
    return this.#remoteExhausted && this.#injectedIndex >= this.#injectedItems.length;
  }

  async #loadMore(): Promise<void> {
    if (this.#remoteExhausted) {
      this.#flushInjectedBefore(undefined);
      return;
    }

    const batch = await this.#fetchPage(this.#remotePage, this.#remotePerPage);
    this.#remotePage++;
    if (batch.length < this.#remotePerPage) {
      this.#remoteExhausted = true;
    }

    for (const raw of batch) {
      const overlaid = this.#overlay(raw);
      if (!this.#filter(overlaid)) continue;
      this.#flushInjectedBefore(overlaid);
      this.#buffer.push({ item: overlaid, injected: false });
    }

    if (this.#remoteExhausted) {
      this.#flushInjectedBefore(undefined);
    }
  }

  /**
   * Buffer the injected items that sort at or before `limit` (all remaining, when `limit` is
   * undefined). Re-validation happens later, when next() serves them from the buffer.
   */
  #flushInjectedBefore(limit: T | undefined): void {
    while (this.#injectedIndex < this.#injectedItems.length) {
      if (limit !== undefined &&
          this.#comparator(this.#injectedItems[this.#injectedIndex], limit) > 0) {
        return;
      }
      this.#buffer.push({ item: this.#injectedItems[this.#injectedIndex++], injected: true });
    }
  }
}

/**
 * RPC wrapper around the kit's `CommitAdvertisingCursor`: each page a caller fetches advertises
 * its commit ids to the workspace git cache before it is returned. Owns the `GitCache` stub it
 * is given (a dup of the session's), disposing it with the cursor.
 */
@validateRpc()
export class AdvertisingCursor<T> extends RpcTarget implements Cursor<T> {
  #inner: CommitAdvertisingCursor<T>;
  #cache: RpcStub<GitCache>;

  constructor(inner: Cursor<T>, cache: RpcStub<GitCache>, commitIds: (item: T) => GitOid[]) {
    super();
    this.#inner = new CommitAdvertisingCursor(inner, cache, commitIds);
    this.#cache = cache;
  }

  async next(): Promise<T[] | null> {
    return await this.#inner.next();
  }

  [Symbol.dispose](): void {
    this.#cache[Symbol.dispose]();
  }
}

/**
 * Lazily obtains and owns a session's `GitCache` stub (fetched at most once per session, via
 * `ObservationAuthorizer.getGitCache()`), through which the session advertises the commit ids its
 * reads return -- advertisement is workspace-internal pull-routing metadata, not a read, so no
 * observation accompanies it. A plain helper, deliberately not an `RpcTarget`: the cache stub
 * must never be reachable by the session's callers.
 */
export class SessionGitCache {
  #approvalQueue: RpcStub<ApprovalQueue>;
  #cache?: Promise<RpcStub<GitCache>>;

  /** `approvalQueue` is only borrowed; the owning session must outlive this helper. */
  constructor(approvalQueue: RpcStub<ApprovalQueue>) {
    this.#approvalQueue = approvalQueue;
  }

  /** The session-owned cache stub itself. Borrowed, not transferred. */
  stub(): Promise<RpcStub<GitCache>> {
    return this.#get();
  }

  #get(): Promise<RpcStub<GitCache>> {
    this.#cache ??= this.#approvalQueue.getGitCache();
    return this.#cache;
  }

  /** Advertise the given commit ids; values that aren't full commit ids are skipped. */
  async advertise(ids: Iterable<GitOid>): Promise<void> {
    await advertiseCommits(await this.#get(), ids);
  }

  /**
   * Wrap a cursor so that each page it returns advertises its commit ids first. The wrapper holds
   * its own dup of the cache stub, so it keeps working if the session is disposed before the
   * cursor is drained.
   */
  async wrap<T>(cursor: Cursor<T>, commitIds: (item: T) => GitOid[]): Promise<Cursor<T>> {
    const cache = await this.#get();
    return new AdvertisingCursor(cursor, cache.dup(), commitIds);
  }

  dispose(): void {
    void this.#cache?.then(cache => cache[Symbol.dispose]()).catch(() => {});
  }
}
