// The streaming RPC cursor and the session-side git-cache holder, shared by the GitLab gatekeeper's
// sessions. The same shapes as gatekeeper-github's: a cursor that overlays simulation onto remote
// pages and merges provisional rows at their sort positions, and the holder that owns a session's
// `GitCache` stub and wraps listings so each page advertises its commit ids (through the kit's
// `PageHookCursor` and `advertisePages`). In-memory listings use the kit's `ArrayCursor`.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue, Cursor, GitCache, GitOid } from "@gadgets/workshop-shared/gatekeeper";
import { PageHookCursor } from "@gadgets/gatekeeper-kit/cursors";
import { advertiseCommits, advertisePages, type CommitAdvertisingOptions } from "@gadgets/gatekeeper-kit/git-objects";
import type { GitLabPage } from "./gitlab-api";

/** A page with each row mapped, keeping where the listing continues. */
export function mapPage<T, U>(page: GitLabPage<T>, map: (item: T) => U): GitLabPage<U> {
  return { items: page.items.map(map), nextPage: page.nextPage };
}

/** What a `StreamingCursor` fetches and how it merges simulation in; all but the first two are optional. */
export type StreamingCursorOptions<T> = {
  /**
   * One page of already-normalized rows from GitLab (or the cache). Its `nextPage`, not its
   * length, says whether the listing continues: GitLab pages can be short mid-listing.
   */
  fetchPage: (page: number, perPage: number) => Promise<GitLabPage<T>>;
  pageSize: number;
  remotePageSize?: number;
  /** The simulation overlay applied to each remote row. */
  overlay?: (item: T) => T;
  /** Whether an overlaid remote row is listed. */
  filter?: (item: T) => boolean;
  /** Provisional rows, already overlaid and filtered, sorted by `comparator`. */
  injectedItems?: T[];
  /** GitLab's sort order for this listing; negative if `a` comes before `b`. */
  comparator?: (a: T, b: T) => number;
  /**
   * Re-validates an injected row as it is served (a page may be drained long after the cursor --
   * and its snapshot -- was built): the row to serve, possibly refreshed, or null to drop it. Must
   * not change the row's sort position.
   */
  revalidateInjected?: (item: T) => T | null;
  /**
   * What a row *is*; a row whose identity was already served is dropped. A queued create applied
   * while the cursor is drained lists the same issue twice -- the injected `~N` row and, on a page
   * fetched afterwards, the real one -- and the second, whichever it is, goes. An injected row's
   * identity may change as the cursor is drained (`~N` becomes the real number once its create
   * lands), so the injected rows already served are re-keyed at every check; a remote row's
   * identity must not change.
   */
  identity?: (item: T) => string;
};

/**
 * A cursor that fetches GitLab pages lazily, overlays and filters each row, and merges injected
 * provisional rows in at their sort positions -- so a large listing never has to be fetched whole.
 */
@validateRpc()
export class StreamingCursor<T> extends RpcTarget implements Cursor<T> {
  readonly #fetchPage: StreamingCursorOptions<T>["fetchPage"];
  readonly #pageSize: number;
  readonly #remotePageSize: number;
  readonly #overlay: (item: T) => T;
  readonly #filter: (item: T) => boolean;
  readonly #injected: T[];
  readonly #comparator: (a: T, b: T) => number;
  readonly #revalidate: (item: T) => T | null;
  readonly #identity?: (item: T) => string;
  readonly #served = new Set<string>();
  /** The injected rows served so far, whose identities can still change (see `identity`). */
  readonly #servedInjected: T[] = [];
  /** Rows buffered ahead of what `next()` has returned; injected ones re-validate when served. */
  readonly #buffer: { item: T; injected: boolean }[] = [];
  #injectedIndex = 0;
  #remotePage: number | null = 1;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: StreamingCursorOptions<T>) {
    super();
    this.#fetchPage = options.fetchPage;
    this.#pageSize = options.pageSize;
    this.#remotePageSize = options.remotePageSize ?? 100;
    this.#overlay = options.overlay ?? (item => item);
    this.#filter = options.filter ?? (() => true);
    this.#injected = options.injectedItems ?? [];
    this.#comparator = options.comparator ?? (() => 0);
    this.#revalidate = options.revalidateInjected ?? (item => item);
    this.#identity = options.identity;
  }

  /** Serialized: interleaved calls would serve a buffered row twice or fetch one page twice. */
  next(): Promise<T[] | null> {
    const page = this.#queue.then(() => this.#fill());
    this.#queue = page.catch(() => {});
    return page;
  }

  // Fetches before taking anything from the buffer, and fetches again only while the page is still
  // empty, so a fetch that throws loses no row: the retry finds them all still buffered. Injected
  // rows re-validate as they are served, not when buffered -- with a small page size a row can sit
  // in the buffer across many calls, long enough for what justified it to change.
  async #fill(): Promise<T[] | null> {
    const page: T[] = [];
    while (page.length === 0) {
      while (this.#buffer.length < this.#pageSize && this.#remotePage !== null) await this.#loadMore(this.#remotePage);
      if (this.#buffer.length === 0) return null;
      for (const { item, injected } of this.#buffer.splice(0, this.#pageSize)) {
        const served = injected ? this.#revalidate(item) : item;
        if (served !== null && this.#firstServing(served, injected)) page.push(served);
      }
    }
    return page;
  }

  #firstServing(item: T, injected: boolean): boolean {
    const identityOf = this.#identity;
    if (identityOf === undefined) return true;
    const identity = identityOf(item);
    if (this.#served.has(identity) || this.#servedInjected.some(prior => identityOf(prior) === identity)) return false;
    this.#served.add(identity);
    if (injected) this.#servedInjected.push(item);
    return true;
  }

  /** Buffers one remote page, and every remaining injected row once it was the last. */
  async #loadMore(remotePage: number): Promise<void> {
    const batch = await this.#fetchPage(remotePage, this.#remotePageSize);
    this.#remotePage = batch.nextPage;
    for (const raw of batch.items) {
      const overlaid = this.#overlay(raw);
      if (!this.#filter(overlaid)) continue;
      this.#bufferInjectedThrough(overlaid);
      this.#buffer.push({ item: overlaid, injected: false });
    }
    if (this.#remotePage === null) this.#bufferInjectedThrough(undefined);
  }

  /** Buffers the injected rows that sort at or before `limit` (all that remain, without one). */
  #bufferInjectedThrough(limit: T | undefined): void {
    while (this.#injectedIndex < this.#injected.length) {
      const item = this.#injected[this.#injectedIndex];
      if (limit !== undefined && this.#comparator(item, limit) > 0) return;
      this.#buffer.push({ item, injected: true });
      this.#injectedIndex++;
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
  readonly #approvalQueue: RpcStub<ApprovalQueue>;
  readonly #options: CommitAdvertisingOptions;
  #cache?: Promise<RpcStub<GitCache>>;

  /**
   * `approvalQueue` is only borrowed; the owning session must outlive this helper. `withhold`
   * names the ids never to advertise -- simulated heads of queued pushes, which reads show as if
   * pushed but GitLab does not have yet -- and is asked as each page is advertised, so a push
   * queued while a cursor is drained is honoured.
   */
  constructor(approvalQueue: RpcStub<ApprovalQueue>, withhold: (commitId: GitOid) => boolean) {
    this.#approvalQueue = approvalQueue;
    this.#options = { withhold };
  }

  /**
   * The session-owned cache stub itself, for callers that need more than advertising (the
   * simulation reads of queued pushes). Borrowed, not transferred: this helper still owns and
   * disposes it.
   */
  stub(): Promise<RpcStub<GitCache>> {
    this.#cache ??= this.#approvalQueue.getGitCache();
    return this.#cache;
  }

  /** Advertise the given commit ids; values that aren't full commit ids are skipped. */
  async advertise(ids: Iterable<GitOid>): Promise<void> {
    await advertiseCommits(await this.stub(), ids, this.#options);
  }

  /**
   * Wrap a cursor so that each page it returns advertises its commit ids first. The wrapper holds
   * its own dup of the cache stub, so it keeps working if the session is disposed before the
   * cursor is drained.
   */
  async wrap<T>(cursor: Cursor<T>, commitIds: (item: T) => readonly GitOid[]): Promise<Cursor<T>> {
    const cache = (await this.stub()).dup();
    return new PageHookCursor(cursor, {
      beforePage: advertisePages(cache, commitIds, this.#options),
      dispose: () => cache[Symbol.dispose](),
    });
  }

  dispose(): void {
    void this.#cache?.then(cache => cache[Symbol.dispose]()).catch(() => {});
  }
}
