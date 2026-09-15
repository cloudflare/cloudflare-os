// The paging engine behind every `Cursor` this gatekeeper hands out.
//
// A cursor is a capability: the call that creates it authorizes its existence, and each page it
// yields is separately authorized before it is disclosed. This module owns the parts of that
// which are the same for every provider — serializing concurrent `next()` calls, walking past
// pages that yield nothing, refusing to loop forever, and holding the cursor's position back
// until the page it would advance over has actually been approved.
//
// It deliberately imports nothing from `cloudflare:workers`, so it can be tested outside workerd.
// google.ts wraps it in the one-method `RpcTarget` that crosses the wire.

/** One page as the provider returned it, before any scope filtering. */
export type CursorPage<Item> = {
  items: Item[];
  /** Absent once the provider has no more pages. */
  nextPageToken?: string;
};

export type CursorPagerOptions<Item, Entry> = {
  /** Provider name, used only to make error messages legible. */
  provider: string;

  /** Fetch one raw page. `pageToken` is undefined for the first. */
  fetchPage(pageToken: string | undefined): Promise<CursorPage<Item>>;

  /**
   * Turn a raw page into the entries the caller sees.
   *
   * May return fewer entries than it was given: dropping items outside the binding's scope
   * belongs here, and a page that empties out that way is walked past rather than mistaken for
   * the end of the results. Enriching entries with extra requests belongs here too, so it is
   * never paid for items that were about to be dropped.
   */
  buildEntries(items: Item[]): Promise<Entry[]>;

  /**
   * Authorize a page before it is disclosed. Throws to deny.
   *
   * `exhausted` says the provider handed back no continuation token, so this really is the end of
   * the results. An empty page with `exhausted: false` is only this call's budget running out, and
   * must not be treated as a negative answer -- there are results ahead of it.
   */
  authorize(entries: Entry[], exhausted: boolean): Promise<void>;

  /** Best-effort cleanup for built entries that authorization prevents from being returned. */
  disposeEntries?(entries: Entry[]): void | Promise<void>;

  /** Provider pages one `next()` may fetch before returning what it has. */
  maxProviderPagesPerCall?: number;
};

/**
 * Provider pages one `next()` walks past before handing the caller an empty page.
 *
 * Reached either because the provider itself keeps returning empty pages, or because a scope
 * filter keeps discarding everything on them. The bound is per call, not per cursor: it caps the
 * work and the subrequests one invocation can spend, and the caller drains to `null` regardless.
 */
export const DEFAULT_MAX_PROVIDER_PAGES_PER_CALL = 20;

/** The one method a `Cursor` exposes. `CursorPager` implements it; google.ts wraps it for RPC. */
export interface Pager<Entry> {
  next(): Promise<Entry[] | null>;
}

export class CursorPager<Item, Entry> implements Pager<Entry> {
  #options: CursorPagerOptions<Item, Entry>;
  #maxProviderPages: number;
  #pageToken: string | undefined;
  // Every token the provider has handed back. A cursor stops at the first repeat, so this grows
  // only with genuinely distinct pages.
  #seenTokens = new Set<string>();
  #exhausted = false;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: CursorPagerOptions<Item, Entry>) {
    this.#options = options;
    this.#maxProviderPages =
      options.maxProviderPagesPerCall ?? DEFAULT_MAX_PROVIDER_PAGES_PER_CALL;
  }

  /**
   * The next page of entries, `[]` when this call's page budget ran out with results still ahead,
   * or null once there are none left.
   *
   * Calls are serialized: a caller that fires several without awaiting gets successive pages
   * rather than a race over the cursor's position.
   */
  next(): Promise<Entry[] | null> {
    let result = this.#tail.then(() => this.#nextPage());
    // Chain on completion, not on the value: holding the resolved page here would pin a page of
    // results in memory until the next call.
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #nextPage(): Promise<Entry[] | null> {
    if (this.#exhausted) return null;

    let { fetchPage, buildEntries, authorize, disposeEntries, provider } = this.#options;
    let pageToken = this.#pageToken;
    // Tokens followed during this call. Merged into the committed set only once the page is
    // approved: a denied read rewinds the cursor, and the retry re-derives these same tokens.
    let followed = new Set<string>();
    let entries: Entry[];

    for (let fetched = 1; ; fetched++) {
      let page = await fetchPage(pageToken);
      pageToken = page.nextPageToken;

      // A token we have already followed would page forever. Comparing only against the token we
      // just sent would catch a self-loop but not a longer cycle, and the empty-page cap is no
      // backstop: the pages in a cycle come back full.
      if (pageToken !== undefined) {
        if (this.#seenTokens.has(pageToken) || followed.has(pageToken)) {
          throw new Error(`${provider} returned a repeated page token.`);
        }
        followed.add(pageToken);
      }

      entries = await buildEntries(page.items);
      if (entries.length > 0 || pageToken === undefined) break;
      // Out of budget with pages still to come. Hand back an empty page rather than throwing: the
      // caller's own retry is the next slice of the same work, and a cursor is drained to `null`.
      if (fetched >= this.#maxProviderPages) break;
    }

    // Advance only once the page has been approved. A denied read leaves the cursor where it was,
    // so retrying re-offers the same page instead of silently skipping over it.
    try {
      await authorize(entries, pageToken === undefined);
    } catch (error) {
      try {
        await disposeEntries?.(entries);
      } catch {
        // Cleanup is best effort; authorization failures must reach the caller unchanged.
      }
      throw error;
    }
    for (let token of followed) this.#seenTokens.add(token);
    this.#pageToken = pageToken;
    this.#exhausted = pageToken === undefined;
    return entries.length === 0 && this.#exhausted ? null : entries;
  }
}
