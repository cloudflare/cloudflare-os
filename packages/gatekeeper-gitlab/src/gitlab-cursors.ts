// RPC cursors and the session-side git-cache holder, shared by the GitLab gatekeeper's sessions.
// The same shapes as gatekeeper-github's: an in-memory cursor, a streaming cursor that overlays
// simulation onto remote pages and merges provisional rows at their sort positions, and the
// holder that owns a session's `GitCache` stub and wraps listings so each page advertises its
// commit ids (through the kit's `PageHookCursor` and `advertisePages`).

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue, Cursor, GitCache, GitOid } from "@gadgets/workshop-shared/gatekeeper";
import { PageHookCursor } from "@gadgets/gatekeeper-kit/cursors";
import { advertiseCommits, advertisePages } from "@gadgets/gatekeeper-kit/git-objects";
import type { GitLabPage } from "./gitlab-api";

/** A page with each row mapped, keeping where the listing continues. */
export function mapPage<T, U>(page: GitLabPage<T>, map: (item: T) => U): GitLabPage<U> {
  return { items: page.items.map(map), nextPage: page.nextPage };
}

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
  /**
   * Fetches one page of already-normalized items from the remote API (or cache). Its `nextPage`,
   * not its length, says whether the listing continues: GitLab pages can be short mid-listing.
   */
  #fetchPage: (page: number, perPage: number) => Promise<GitLabPage<T>>;
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
  /**
   * What an item *is*, read when it is served; a row whose identity was already served is
   * dropped. A queued create applied while the cursor is drained puts the same issue in the
   * listing twice -- the injected `~N` row and, on a page fetched afterwards, the real one -- and
   * which comes first depends on the sort, so the second, whichever it is, is the one dropped.
   */
  #identity?: (item: T) => string;
  #served = new Set<string>();

  /** Rows buffered ahead of what next() has returned; injected ones re-validate when served. */
  #buffer: { item: T; injected: boolean }[] = [];
  #remotePage: number | null = 1;
  #remotePerPage: number;
  #pageSize: number;

  constructor(options: {
    fetchPage: (page: number, perPage: number) => Promise<GitLabPage<T>>;
    overlay: (item: T) => T;
    filter: (item: T) => boolean;
    comparator: (a: T, b: T) => number;
    injectedItems: T[];
    revalidateInjected?: (item: T) => T | null;
    identity?: (item: T) => string;
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
    this.#identity = options.identity;
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
      if (item !== null && this.#firstServing(item)) page.push(item);
    }
    return page.length === 0 ? null : page;
  }

  #firstServing(item: T): boolean {
    if (this.#identity === undefined) return true;
    const identity = this.#identity(item);
    if (this.#served.has(identity)) return false;
    this.#served.add(identity);
    return true;
  }

  #fullyExhausted(): boolean {
    return this.#remotePage === null && this.#injectedIndex >= this.#injectedItems.length;
  }

  async #loadMore(): Promise<void> {
    if (this.#remotePage === null) {
      this.#flushInjectedBefore(undefined);
      return;
    }

    const batch = await this.#fetchPage(this.#remotePage, this.#remotePerPage);
    this.#remotePage = batch.nextPage;

    for (const raw of batch.items) {
      const overlaid = this.#overlay(raw);
      if (!this.#filter(overlaid)) continue;
      this.#flushInjectedBefore(overlaid);
      this.#buffer.push({ item: overlaid, injected: false });
    }

    if (this.#remotePage === null) {
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

  /**
   * The session-owned cache stub itself, for callers that need more than advertising (the
   * simulation reads of queued pushes). Borrowed, not transferred: this helper still owns and
   * disposes it.
   */
  stub(): Promise<RpcStub<GitCache>> {
    return this.#get();
  }

  #get(): Promise<RpcStub<GitCache>> {
    this.#cache ??= this.#approvalQueue.getGitCache();
    return this.#cache;
  }

  /**
   * Advertise the given commit ids (deduplicated, in parallel). Values that aren't full commit
   * ids -- e.g. a merge base that could not be determined -- are skipped.
   */
  async advertise(ids: Iterable<GitOid>): Promise<void> {
    await advertiseCommits(await this.#get(), ids);
  }

  /**
   * Wrap a cursor so that each page it returns advertises its commit ids first. The wrapper holds
   * its own dup of the cache stub, so it keeps working if the session is disposed before the
   * cursor is drained.
   */
  async wrap<T>(cursor: Cursor<T>, commitIds: (item: T) => readonly GitOid[]): Promise<Cursor<T>> {
    const cache = (await this.#get()).dup();
    return new PageHookCursor(cursor, {
      beforePage: advertisePages(cache, commitIds),
      dispose: () => cache[Symbol.dispose](),
    });
  }

  dispose(): void {
    void this.#cache?.then(cache => cache[Symbol.dispose]()).catch(() => {});
  }
}
