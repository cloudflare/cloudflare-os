/** In-memory and provider-backed implementations of the gatekeeper cursor RPC. */

import { RpcTarget } from "cloudflare:workers";
import type { Cursor } from "@gadgets/workshop-shared/gatekeeper";
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

type CursorShape = {
  /** How many items each `next()` returns. */
  pageSize: number;
  /** How many items to ask the provider for at a time. */
  remotePageSize?: number;
};

// Bound sequential requests per `next()`; an empty visibility window returns `[]`, not exhaustion.
const MAX_PROVIDER_PAGES_PER_CALL = 10;

const DEFAULT_REMOTE_PAGE_SIZE = 100;

// Symbol naming keeps this implementation method out of the RPC surface.
const loadMore = Symbol("loadMore");

// Shared buffered implementation for provider-backed cursors.
abstract class BufferedCursor<T> extends RpcTarget implements Cursor<T> {
  readonly #pageSize: number;
  readonly #queue = new SerialTaskQueue();
  protected readonly remotePageSize: number;
  protected readonly buffer: T[] = [];
  protected remoteExhausted = false;

  /**
   * Creates a buffered provider cursor.
   * @param options Local and provider page sizes.
   */
  constructor(options: CursorShape) {
    super();
    this.#pageSize = requirePositiveInt("pageSize", options.pageSize);
    this.remotePageSize =
      requirePositiveInt("remotePageSize", options.remotePageSize ?? DEFAULT_REMOTE_PAGE_SIZE);
  }

  /** Loads the next provider page into the buffer. */
  protected abstract [loadMore](): Promise<void>;

  /** @returns The next page, or `null` after exhaustion. Concurrent calls are serialized. */
  next(): Promise<T[] | null> {
    return this.#queue.run(() => this.#fill());
  }

  /** @returns One local page, `[]` when the fetch window is spent, or `null` at exhaustion. */
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
export type OffsetCursorOptions<T> = CursorShape & {
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
    const exhausted = page.length === 0;
    // `retain` runs before either field moves, so a throw leaves the walk on this page.
    const visible = this.#retain?.(page) ?? page;
    this.#position = this.#advance(this.#position, page);
    this.remoteExhausted = exhausted;
    for (const item of visible) this.buffer.push(item);
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
export type TokenCursorOptions<T> = CursorShape & {
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
 * return new TokenCursor<Project>({
 *   pageSize: 50,
 *   fetchPage: async (token, perPage) => {
 *     const page = await api.listProjects({ cursor: token, limit: perPage });
 *     return { items: page.projects, nextToken: page.nextCursor };
 *   },
 * });
 * ```
 */
export class TokenCursor<T> extends BufferedCursor<T> {
  readonly #fetchPage: (token: string | undefined, perPage: number) => Promise<TokenPage<T>>;
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
    this.remoteExhausted = exhausted;
    this.#token = page.nextToken;
    for (const item of page.items) this.buffer.push(item);
  }
}
