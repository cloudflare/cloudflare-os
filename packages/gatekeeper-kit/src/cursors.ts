/**
 * In-memory and provider-backed implementations of the gatekeeper cursor RPC.
 *
 * No class here carries `@validateRpc()`: on a server target it validates incoming arguments, and
 * `next()` takes none. A gatekeeper's capnweb-validate build also transforms only its own sources,
 * so a decorator here would reach the Worker untransformed and throw.
 */

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import type { ApprovalQueue, Cursor, GitCache, GitOid } from "@gadgets/workshop-shared/gatekeeper";
import { advertiseCommits, advertisePages, type CommitAdvertisingOptions } from "./git-objects";
import { SerialTaskQueue } from "./serial-queue";
import { requirePositiveInt } from "./positive-int";

/** Pages a list the gatekeeper already holds. */
export class ArrayCursor<T> extends RpcTarget implements Cursor<T> {
  readonly #items: readonly T[];
  readonly #pageSize: number;
  #index = 0;

  /**
   * Creates an in-memory cursor.
   * @param items Items to page.
   * @param pageSize Maximum items returned by `next()`.
   */
  constructor(items: readonly T[], pageSize: number) {
    super();
    this.#items = items;
    this.#pageSize = requirePositiveInt("pageSize", pageSize);
  }

  /** @returns The next page, or `null` after exhaustion. */
  async next(): Promise<T[] | null> {
    if (this.#index >= this.#items.length) return null;
    const page = this.#items.slice(this.#index, this.#index + this.#pageSize);
    this.#index += this.#pageSize;
    return page;
  }
}

/**
 * Rows the agent's own simulation adds to a provider listing, such as an item it created that the
 * provider does not list yet. Each is merged before the first visible provider row it sorts
 * at-or-before; the rest follow the last provider page. They are not provider rows: they never
 * reach `authorizePage`'s `items`, and a page made only of them is not authorized. Their
 * position still says a little -- an injected row served ahead of the queue means no fetched
 * provider row sorts before it -- so a listing whose order is itself sensitive authorizes its
 * observation up front.
 */
export type CursorInjection<T> = {
  /** The rows to merge, sorted by `compare`. */
  items: readonly T[];
  /**
   * The provider's sort order: negative when `a` lists first. An injected row lists before an
   * equal provider row.
   */
  compare(a: T, b: T): number;
  /**
   * Re-reads an injected row as it is served, since a page may be drained long after the cursor
   * was built: the row to serve, possibly refreshed, or `null` to drop it. Must keep the row's sort
   * position.
   */
  revalidate?(item: T): T | null;
  /**
   * What a row *is*. A later row from either source whose identity was already served is dropped,
   * e.g. the injected stand-in for a create that landed mid-walk and the real row a later provider
   * page lists. An injected row's identity may change between servings (a temporary id becoming
   * the provider's), so served injected rows are re-keyed at every check; a provider row's must
   * not change. Identities count as served only once their page is authorized.
   */
  identity?(item: T): string;
};

type CursorShape<T> = {
  /** How many items each `next()` returns. */
  pageSize: number;
  /** How many items to ask the provider for at a time. */
  remotePageSize?: number;
  /**
   * Most provider pages one `next()` fetches; default 10. At the bound it returns what it has, `[]`
   * included, which says "ask again". Every fetch counts, not only empty ones. Lower it for a
   * provider that bills each row fetched.
   */
  maxProviderPagesPerCall?: number;
  /**
   * Releases resources the fetch callback owns — a duplicated RPC stub, most often — when the
   * cursor is disposed. Without it a fetch callback may only borrow stubs the session owns for at
   * least as long as the walk: dropping the cursor stub would otherwise leak whatever the callback
   * duplicated for itself. Return a cursor to exactly one RPC call: capnweb disposes the target
   * once per stub, so the first drop of a shared cursor would release the walk another still uses.
   */
  dispose?(): void;
  /** Simulated rows to merge into the provider's; see `CursorInjection`. */
  inject?: CursorInjection<T>;
  /**
   * Authorizes what `next()` is about to return, before it leaves the cursor. Runs on every page
   * carrying provider rows, including one served entirely from the buffer with no provider fetch,
   * on a spent window's empty page, and once for a walk that ends having disclosed nothing — a
   * zero-result query answers "no such thing", which is provider data too. A page made only of
   * injected rows is not authorized.
   *
   * A throw holds the outgoing page, so the retry offers no provider row beyond it, with no further
   * provider fetch and no chance of a capped page growing between refusal and retry. Its injected
   * rows are re-read, and a provider row one of them no longer hides leads the next page instead.
   * The exception is an empty page from a spent window: nothing was disclosed, so the retry opens a
   * fresh window rather than pinning the walk on a failure that may have been transient.
   *
   * That hold is why a walk pinned to a connection must re-check its authority **here**, not only
   * in its fetch callback: the retry path never re-enters the fetch, so a reconnect landing
   * between refusal and retry would otherwise disclose the previous connection's rows.
   *
   * `terminal` marks the walk over, so `items` is empty and no further page will come. Describe
   * that case as the query it answered rather than the rows it returned, and give it a
   * `{ kind: "baseline" }` scope or a synthetic collection id: the gate refuses a `collections`
   * scope naming none. A mid-walk empty page (a spent fetch window that still says "ask again")
   * arrives with `terminal: false`.
   * @param items The provider rows of the page, without injected rows. Empty when `terminal`.
   * @param context `terminal` when this ends the walk.
   */
  authorizePage(items: readonly T[], context: { terminal: boolean }): Promise<void>;
};

const DEFAULT_MAX_PROVIDER_PAGES_PER_CALL = 10;

const DEFAULT_REMOTE_PAGE_SIZE = 100;

// Symbol naming keeps these implementation methods out of the RPC surface.
const loadMore = Symbol("loadMore");
const enqueue = Symbol("enqueue");

// The serving queue: provider rows, with injected rows merged in at their sort positions.
type Entry<T> = { readonly item: T; readonly injected: boolean };

// An outgoing page, built before authorization and committed only after it succeeds.
type Outgoing<T> = {
  readonly items: T[];
  // The provider rows among `items`: what authorization sees.
  readonly provided: T[];
  // Leading queue entries it used.
  consumed: number;
  // Identities it serves, and the injected rows among them, which are re-keyed at each check.
  readonly ids: string[];
  readonly injected: T[];
};

// Shared buffered implementation for provider-backed cursors.
abstract class BufferedCursor<T> extends RpcTarget implements Cursor<T>, Disposable {
  readonly #pageSize: number;
  readonly #maxProviderPagesPerCall: number;
  readonly #queue = new SerialTaskQueue();
  readonly #dispose?: () => void;
  readonly #authorizePage: CursorShape<T>["authorizePage"];
  readonly #inject: CursorInjection<T>;
  readonly #buffer: Entry<T>[] = [];
  readonly #servedIds = new Set<string>();
  readonly #servedInjected: T[] = [];
  #injectedIndex = 0;
  #remoteExhausted = false;
  // Set once the walk has either disclosed provider rows or authorized that it had none. An empty
  // window leaves it clear: that page answered nothing, so the terminal answer is still owed.
  #answered = false;
  #held?: Outgoing<T>;
  #disposed = false;
  protected readonly remotePageSize: number;

  /**
   * Creates a buffered provider cursor.
   * @param options Page sizes and fetch bound, page authorization, injected rows, and an optional
   * release hook.
   */
  constructor(options: CursorShape<T>) {
    super();
    this.#dispose = options.dispose;
    this.#authorizePage = options.authorizePage;
    this.#inject = options.inject ?? { items: [], compare: () => 0 };
    // Assigned first, so a rejected size releases what the caller already acquired for this
    // cursor -- the documented pattern leases a gate before constructing one.
    try {
      this.#pageSize = requirePositiveInt("pageSize", options.pageSize);
      this.remotePageSize =
        requirePositiveInt("remotePageSize", options.remotePageSize ?? DEFAULT_REMOTE_PAGE_SIZE);
      this.#maxProviderPagesPerCall = requirePositiveInt("maxProviderPagesPerCall",
        options.maxProviderPagesPerCall ?? DEFAULT_MAX_PROVIDER_PAGES_PER_CALL);
    } catch (error) {
      this[Symbol.dispose]();
      throw error;
    }
  }

  /**
   * Releases what the fetch callback owns. Idempotent, since the runtime may dispose a target a
   * second reference already released. A `next()` after disposal is the callback's own business:
   * whatever it borrowed or released decides what that call does.
   */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#dispose?.();
  }

  /** Fetches the next provider page and passes it to `[enqueue]`. */
  protected abstract [loadMore](): Promise<void>;

  /**
   * Queues one fetched provider page, merging each injected row ahead of the first visible row it
   * sorts at-or-before, and the rest after the last page. Builds before it mutates, so a throwing
   * `compare` leaves the walk where it was: call it before moving paging state.
   */
  protected [enqueue](items: readonly T[], exhausted: boolean): void {
    const { items: injected, compare } = this.#inject;
    const entries: Entry<T>[] = [];
    let next = this.#injectedIndex;
    for (const item of items) {
      while (next < injected.length && compare(injected[next], item) <= 0) {
        entries.push({ item: injected[next++], injected: true });
      }
      entries.push({ item, injected: false });
    }
    if (exhausted) while (next < injected.length) entries.push({ item: injected[next++], injected: true });
    this.#buffer.push(...entries);
    this.#injectedIndex = next;
    this.#remoteExhausted = exhausted;
  }

  /** @returns The next page, or `null` after exhaustion. Concurrent calls are serialized. */
  next(): Promise<T[] | null> {
    return this.#queue.run(() => this.#fill());
  }

  /** @returns One local page, `[]` when the fetch window is spent, or `null` at exhaustion. */
  async #fill(): Promise<T[] | null> {
    // A refused page is held, and its retry offers no provider row beyond it: growing a page the
    // provider had capped would change what the approver already refused.
    const page = this.#held = await this.#take(this.#held);
    // Only exhaustion ends the walk. A spent window yields `[]`, which says "ask again", as does a
    // retry whose rows all dropped out with more of the queue behind them.
    const terminal = page.items.length === 0 && this.#remoteExhausted
      && page.consumed === this.#buffer.length;
    // Injected rows are the gatekeeper's own simulation, so a page made only of them has nothing
    // to authorize. A walk that disclosed nothing still answered the query: "no such thing" is
    // provider data. Authorized once, so a repeated terminal `next()` emits no duplicate observation.
    const injectedOnly = page.items.length > 0 && page.provided.length === 0;
    if (terminal ? !this.#answered : !injectedOnly) {
      try {
        await this.#authorizePage(page.provided, { terminal });
      } catch (error) {
        // An empty window disclosed nothing, and pinning it would stall the walk on a lost reply.
        if (!terminal && page.items.length === 0) this.#held = undefined;
        throw error;
      }
    }
    this.#held = undefined;
    this.#buffer.splice(0, page.consumed);
    for (const id of page.ids) this.#servedIds.add(id);
    this.#servedInjected.push(...page.injected);
    if (terminal || page.provided.length > 0) this.#answered = true;
    return terminal ? null : page.items;
  }

  /**
   * Builds the next outgoing page from the queue without consuming it, fetching only when the
   * queue runs dry. A refused page's retry instead rebuilds from the entries that page consumed,
   * re-reading its injected rows, and stops before a provider row the refusal did not cover -- one
   * a dropped injected row no longer hides -- which then leads the next page.
   */
  async #take(held?: Outgoing<T>): Promise<Outgoing<T>> {
    const refused = held && new Set(held.provided);
    const page: Outgoing<T> = { items: [], provided: [], consumed: 0, ids: [], injected: [] };
    let fetches = 0;
    while (page.items.length < this.#pageSize) {
      if (page.consumed === (held?.consumed ?? this.#buffer.length)) {
        if (held || this.#remoteExhausted || fetches++ === this.#maxProviderPagesPerCall) break;
        await this[loadMore]();
        continue;
      }
      const entry = this.#buffer[page.consumed];
      if (refused && !entry.injected && !refused.has(entry.item) && !this.#served(page, entry.item)) {
        break;
      }
      page.consumed++;
      this.#admit(page, entry);
    }
    return page;
  }

  /** Whether an earlier page or this one already served a row with this row's identity. */
  #served(page: Outgoing<T>, item: T): boolean {
    const { identity } = this.#inject;
    if (!identity) return false;
    const id = identity(item);
    const rekeyed = (row: T) => identity(row) === id;
    return this.#servedIds.has(id) || page.ids.includes(id)
      || this.#servedInjected.some(rekeyed) || page.injected.some(rekeyed);
  }

  /**
   * Adds an entry to a page unless it drops out. Revalidation and identity run here, at serve time,
   * so a dropped row never costs a page while the fetch window lasts.
   */
  #admit(page: Outgoing<T>, entry: Entry<T>): void {
    const { revalidate, identity } = this.#inject;
    const item = entry.injected && revalidate ? revalidate(entry.item) : entry.item;
    if (item === null || this.#served(page, item)) return;
    if (identity) page.ids.push(identity(item));
    page.items.push(item);
    (entry.injected ? page.injected : page.provided).push(item);
  }
}

/** Options for a provider that pages by page number. */
export type PageNumberCursorOptions<T> = CursorShape<T> & {
  /**
   * Fetches one unfiltered provider page. Filter in `retain`, or a fully hidden page would end the
   * walk.
   * @param page One-based page number.
   * @param perPage Requested provider page size.
   * @returns Raw provider items. An empty result ends the walk.
   */
  fetchPage(page: number, perPage: number): Promise<readonly T[]>;
  /**
   * Narrows a page after its raw length determines exhaustion.
   * @param items Raw provider items.
   * @returns Items visible to the caller.
   */
  retain?(items: readonly T[]): readonly T[];
};

/** Options for a provider that pages by numeric offset. */
export type OffsetCursorOptions<T> = CursorShape<T> & {
  /**
   * Fetches one unfiltered provider page. Filter in `retain`, or a fully hidden page would end the
   * walk.
   * @param offset Zero-based provider offset.
   * @param limit Requested provider page size.
   * @returns Raw provider items. An empty result ends the walk.
   */
  fetchPage(offset: number, limit: number): Promise<readonly T[]>;
  /**
   * Narrows a page after its raw length determines exhaustion.
   * @param items Raw provider items.
   * @returns Items visible to the caller.
   */
  retain?(items: readonly T[]): readonly T[];
};

// Shared numeric-position cursor for page-number and offset pagination.
class PositionCursor<T> extends BufferedCursor<T> {
  readonly #fetchPage: (position: number, perPage: number) => Promise<readonly T[]>;
  readonly #retain?: (items: readonly T[]) => readonly T[];
  readonly #advance: (position: number, rawPage: readonly T[]) => number;
  #position: number;

  /**
   * Creates a numeric-position cursor.
   * @param options Provider fetch and filtering policy.
   * @param start Initial page number or offset.
   * @param advance Computes the next provider position.
   */
  constructor(
    options: PageNumberCursorOptions<T> | OffsetCursorOptions<T>,
    start: number,
    advance: (position: number, rawPage: readonly T[]) => number,
  ) {
    super(options);
    this.#fetchPage = options.fetchPage;
    this.#retain = options.retain;
    this.#advance = advance;
    this.#position = start;
  }

  /** Loads one numeric provider page. */
  protected override async [loadMore](): Promise<void> {
    const page = await this.#fetchPage(this.#position, this.remotePageSize);
    // Only an empty page ends the walk. Providers may cap a page below the requested size.
    // `retain` and the queueing run before the position moves, so a throw leaves the walk here.
    this[enqueue](this.#retain?.(page) ?? page, page.length === 0);
    this.#position = this.#advance(this.#position, page);
  }
}

/**
 * Pages by incrementing page number. Do not use for numeric offsets: provider page caps can skip
 * rows when the requested and returned sizes differ.
 */
export class PageNumberCursor<T> extends PositionCursor<T> {
  /**
   * Creates a page-number cursor.
   * @param options Provider fetch and page-size settings.
   */
  constructor(options: PageNumberCursorOptions<T>) {
    super(options, 1, page => page + 1);
  }
}

/**
 * Pages by numeric offset, advancing by the raw row count rather than filtered rows. Use
 * `TokenCursor` when the provider supplies its own continuation signal.
 */
export class OffsetCursor<T> extends PositionCursor<T> {
  /**
   * Creates an offset cursor.
   * @param options Provider fetch and page-size settings.
   */
  constructor(options: OffsetCursorOptions<T>) {
    super(options, 0, (offset, page) => offset + page.length);
  }
}

/** One provider page keyed by an opaque continuation token. `""` is a valid token. */
export type TokenPage<T> = {
  /** Safe to filter: `nextToken`, not this length, ends the walk. */
  items: readonly T[];
  /** Absent ends the remote walk. Presence means "ask again", even when `items` is empty. */
  nextToken?: string;
};

/** Options for a provider that pages by continuation token. */
export type TokenCursorOptions<T> = CursorShape<T> & {
  /**
   * Fetches one provider page.
   * @param token Continuation token from the previous page.
   * @param perPage Requested provider page size.
   * @returns Provider items and the next token.
   */
  fetchPage(token: string | undefined, perPage: number): Promise<TokenPage<T>>;
};

/**
 * Fetches provider pages lazily using an opaque continuation token. 
 * 
 * Only `undefined` ends the walk; an empty string is a valid token, 
 * and an echoed token throws without advancing.
 *
 * @example
 * ```ts
 * // The cursor is walked after this call returns, so it takes its own lease rather than
 * // borrowing the session's stub, and releases it when the walk is dropped.
 * const walk = this.#gate.lease();
 * return new TokenCursor<Project>({
 *   pageSize: 50,
 *   dispose: () => walk[Symbol.dispose](),
 *   fetchPage: async (token, perPage) => {
 *     const page = await api.listProjects({ cursor: token, limit: perPage });
 *     return { items: page.projects, nextToken: page.nextCursor };
 *   },
 *   // Branch on emptiness, not on `terminal`: a spent mid-walk window is also empty, and a
 *   // `collections` scope naming no collection is refused.
 *   authorizePage: (items, { terminal }) => items.length === 0
 *     ? walk.authorize(
 *       { title: "Projects", description: terminal ? "Listed the projects; there were none" : "Scanned a window of projects; none were visible" },
 *       { kind: "baseline" })
 *     : walk.authorize(
 *       { title: "Projects", description: `Read ${items.length} projects` },
 *       { kind: "collections", ids: items.map(project => project.id) }),
 * });
 * ```
 */
export class TokenCursor<T> extends BufferedCursor<T> {
  readonly #fetchPage: TokenCursorOptions<T>["fetchPage"];
  #token?: string;

  /**
   * Creates a continuation-token cursor.
   * @param options Provider fetch and page-size settings.
   */
  constructor(options: TokenCursorOptions<T>) {
    super(options);
    this.#fetchPage = options.fetchPage;
  }

  /** Loads one continuation-token provider page. */
  protected override async [loadMore](): Promise<void> {
    const asked = this.#token;
    const page = await this.#fetchPage(asked, this.remotePageSize);
    const exhausted = page.nextToken === undefined;
    // Refuse an echoed token before moving cursor state so retrying asks for the same token.
    if (!exhausted && page.nextToken === asked) {
      throw new Error(
        "Provider returned the same continuation token it was asked to continue from.");
    }
    this[enqueue](page.items, exhausted);
    this.#token = page.nextToken;
  }
}

/** What a `PageHookCursor` runs on each page, and what it releases. */
export type PageHookCursorOptions<T> = {
  /**
   * Runs on each page before `next()` returns it -- e.g. `advertisePages()` from `./git-objects`,
   * which reports a git listing's commit ids to the workspace before the caller sees them. A
   * throw rejects that `next()` and holds the page, so the retry re-offers exactly it instead of
   * skipping it.
   * @param items The page `next()` is about to return.
   */
  beforePage(items: readonly T[]): Promise<void>;
  /** Releases what the hook owns -- a duplicated RPC stub, most often -- when the cursor is disposed. */
  dispose?(): void;
};

/**
 * Wraps a cursor the gatekeeper already built, so a hook sees each page before the caller does.
 * For listings whose observation was authorized once, up front: the hook is not an authorization
 * point (the provider-backed cursors' `authorizePage` is), it only acts on what is about to be
 * returned.
 */
export class PageHookCursor<T> extends RpcTarget implements Cursor<T>, Disposable {
  readonly #inner: Cursor<T>;
  readonly #options: PageHookCursorOptions<T>;
  readonly #queue = new SerialTaskQueue();
  #held?: T[];
  #disposed = false;

  /**
   * Creates the wrapper. It does not take ownership of `inner`.
   * @param inner The cursor whose pages to return.
   * @param options The hook, and an optional release hook.
   */
  constructor(inner: Cursor<T>, options: PageHookCursorOptions<T>) {
    super();
    this.#inner = inner;
    this.#options = options;
  }

  /** @returns The next page, or `null` after exhaustion. Concurrent calls are serialized. */
  next(): Promise<T[] | null> {
    return this.#queue.run(async () => {
      const page = this.#held ?? await this.#inner.next();
      if (page === null) return null;
      this.#held = page;
      await this.#options.beforePage(page);
      this.#held = undefined;
      return page;
    });
  }

  /** Runs the release hook. Idempotent, since the runtime may dispose a target twice. */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#options.dispose?.();
  }
}

/**
 * Lazily obtains and owns a git session's `GitCache` stub (fetched at most once, via its
 * `ApprovalQueue`), through which the session advertises the commit ids its reads return --
 * directly, or per page of a listing by wrapping its cursor in a `PageHookCursor` over
 * `advertisePages()`. Advertisement is workspace-internal pull-routing metadata, not a read, so
 * no observation accompanies it. A plain helper, deliberately not an `RpcTarget`: the cache stub
 * must never be reachable by the session's callers.
 */
export class SessionGitCache {
  readonly #approvalQueue: RpcStub<ApprovalQueue>;
  readonly #options: CommitAdvertisingOptions | undefined;
  #cache?: Promise<RpcStub<GitCache>>;

  /**
   * `approvalQueue` is only borrowed; the owning session must outlive this helper. `options` apply
   * to every advertisement: `withhold` typically names the simulated heads of queued pushes, which
   * reads show as if pushed but the remote does not have yet.
   */
  constructor(approvalQueue: RpcStub<ApprovalQueue>, options?: CommitAdvertisingOptions) {
    this.#approvalQueue = approvalQueue;
    this.#options = options;
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

  /** Releases the cache stub, if one was fetched. */
  dispose(): void {
    void this.#cache?.then(cache => cache[Symbol.dispose]()).catch(() => {});
  }
}
