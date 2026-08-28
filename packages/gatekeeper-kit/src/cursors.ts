import { RpcTarget } from "cloudflare:workers";
import type { Cursor } from "@gadgets/workshop-shared/gatekeeper";
import { SerialTaskQueue } from "./serial-queue";
import { requirePositiveInt } from "./positive-int";

/** Pages a list the gatekeeper already holds. */
export class ArrayCursor<T> extends RpcTarget implements Cursor<T> {
  readonly #items: readonly T[];
  readonly #pageSize: number;
  #index = 0;

  constructor(items: readonly T[], pageSize: number) {
    super();
    this.#items = items;
    this.#pageSize = requirePositiveInt("pageSize", pageSize);
  }

  async next(): Promise<T[] | null> {
    if (this.#index >= this.#items.length) return null;
    const page = this.#items.slice(this.#index, this.#index + this.#pageSize);
    this.#index += this.#pageSize;
    return page;
  }
}

type CursorShape = {
  /** How many items each `next()` returns. */
  pageSize: number;
  /** How many items to ask the provider for at a time. */
  remotePageSize?: number;
};

/**
 * A page the caller sees nothing in is not the end: the provider may return an empty one, or
 * `retain` may empty a full one. Each `next()` fetches at most this many, since they are sequential
 * round trips and the caller is waiting; a later call spends another window. A page still short of
 * `pageSize` is legal, so a port needing more than this per call should raise `remotePageSize`
 * rather than expect one call to fill.
 */
const MAX_PROVIDER_PAGES_PER_CALL = 10;

/** Provider page size when a cursor's options name none. */
const DEFAULT_REMOTE_PAGE_SIZE = 100;

/**
 * Symbol-named so it is not an RPC method: capnweb exposes every string-named method on an
 * `RpcTarget`'s prototype chain, `protected` is erased, and a direct call would skip the queue.
 */
const loadMore = Symbol("loadMore");

/** The buffered walk both provider cursors share. */
abstract class BufferedCursor<T> extends RpcTarget implements Cursor<T> {
  readonly #pageSize: number;
  readonly #queue = new SerialTaskQueue();
  /** How many items each provider round trip asks for. */
  protected readonly remotePageSize: number;
  protected readonly buffer: T[] = [];
  /** Set from the provider's own page, never from what survived `retain`. */
  protected remoteExhausted = false;

  constructor(options: CursorShape) {
    super();
    this.#pageSize = requirePositiveInt("pageSize", options.pageSize);
    this.remotePageSize =
      requirePositiveInt("remotePageSize", options.remotePageSize ?? DEFAULT_REMOTE_PAGE_SIZE);
  }

  /** Buffers one provider page's visible items and sets `remoteExhausted`. */
  protected abstract [loadMore](): Promise<void>;

  /** The next page, or null at the end. Concurrent callers are serialized rather than interleaved. */
  next(): Promise<T[] | null> {
    return this.#queue.run(() => this.#fill());
  }

  async #fill(): Promise<T[] | null> {
    let pages = 0;
    while (this.buffer.length < this.#pageSize
      && !this.remoteExhausted
      && pages++ < MAX_PROVIDER_PAGES_PER_CALL) {
      await this[loadMore]();
    }
    // Only exhaustion ends the walk. A spent window yields `[]`, which says "ask again".
    if (this.buffer.length === 0 && this.remoteExhausted) return null;
    return this.buffer.splice(0, this.#pageSize);
  }
}

/** Options for a provider that pages by page number. */
export type PageNumberCursorOptions<T> = CursorShape & {
  /**
   * One provider page, unfiltered. Its length is the only end-of-list signal a numeric walk has, so
   * dropping rows here ends the walk on a page that merely held none the caller may see. Narrow the
   * page in `retain` instead.
   */
  fetchPage(page: number, perPage: number): Promise<readonly T[]>;
  /** Narrows a page to what the caller may see, after its raw length has decided exhaustion. */
  retain?(items: readonly T[]): readonly T[];
};

/** Options for a provider that pages by numeric offset. */
export type OffsetCursorOptions<T> = CursorShape & {
  /** One provider page, unfiltered -- as `PageNumberCursor.fetchPage`. */
  fetchPage(offset: number, limit: number): Promise<readonly T[]>;
  /** Narrows a page to what the caller may see, after its raw length has decided exhaustion. */
  retain?(items: readonly T[]): readonly T[];
};

/**
 * The numeric walk the page-number and offset cursors share; they differ only in where the position
 * starts and how a raw page advances it. `advance` is a constructor argument rather than an
 * overridable method for the reason `loadMore` is symbol-named.
 */
class PositionCursor<T> extends BufferedCursor<T> {
  readonly #fetchPage: (position: number, perPage: number) => Promise<readonly T[]>;
  readonly #retain?: (items: readonly T[]) => readonly T[];
  readonly #advance: (position: number, rawPage: readonly T[]) => number;
  #position: number;

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

  protected override async [loadMore](): Promise<void> {
    const page = await this.#fetchPage(this.#position, this.remotePageSize);
    // Only an empty page ends the walk. Providers may cap a page below the requested size.
    const exhausted = page.length === 0;
    // `retain` runs before either field moves, so a throw leaves the walk on this page.
    const visible = this.#retain?.(page) ?? page;
    this.#position = this.#advance(this.#position, page);
    this.remoteExhausted = exhausted;
    for (const item of visible) this.buffer.push(item);
  }
}

/**
 * Drives providers that page by an incrementing page number, which stays aligned under a provider
 * cap because the provider clamps `perPage` consistently. Never format one over a numeric offset:
 * `page * perPage` advances by the requested size while a capped page returns fewer, silently
 * skipping the rows between. Offsets are `OffsetCursor`'s.
 */
export class PageNumberCursor<T> extends PositionCursor<T> {
  constructor(options: PageNumberCursorOptions<T>) {
    super(options, 1, page => page + 1);
  }
}

/**
 * Drives providers that page by numeric offset. The offset advances by the raw rows returned --
 * never by what survived `retain`, since the provider served those rows whatever the caller may
 * see -- so a provider capping a page below `limit` skips nothing. A provider whose short pages do
 * not reflect the rows it consumed -- a server-side-filtered search with its own next signal, like
 * Confluence v1 -- is a `TokenCursor` carrying that signal instead.
 */
export class OffsetCursor<T> extends PositionCursor<T> {
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
export type TokenCursorOptions<T> = CursorShape & {
  fetchPage(token: string | undefined, perPage: number): Promise<TokenPage<T>>;
};

/** A cursor that fetches provider pages lazily using an opaque continuation token. */
export class TokenCursor<T> extends BufferedCursor<T> {
  readonly #fetchPage: (token: string | undefined, perPage: number) => Promise<TokenPage<T>>;
  #token?: string;

  constructor(options: TokenCursorOptions<T>) {
    super(options);
    this.#fetchPage = options.fetchPage;
  }

  protected override async [loadMore](): Promise<void> {
    const asked = this.#token;
    const page = await this.#fetchPage(asked, this.remotePageSize);
    const exhausted = page.nextToken === undefined;
    // Refuse an echoed token before moving cursor state so retrying asks for the same token.
    if (!exhausted && page.nextToken === asked) {
      throw new Error(
        "Provider returned the same continuation token it was asked to continue from.");
    }
    this.remoteExhausted = exhausted;
    this.#token = page.nextToken;
    for (const item of page.items) this.buffer.push(item);
  }
}
