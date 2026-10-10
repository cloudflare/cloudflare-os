// The cursor every listing returns. It keeps the kit cursors' contract -- each page is authorized
// before it leaves, a refused page is held and re-offered exactly, a walk ends at `null` -- but
// makes exactly one X request per `next()`. The kit's `TokenCursor` fills a whole local page,
// fetching again (up to ten times) whenever X returns fewer rows than asked; on X every row fetched
// is billed, so a cursor must never read rows the caller did not ask for.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import type { ObservationInput, ObservationScope } from "@gadgets/gatekeeper-kit/observers";
import type { Cursor } from "./types";

/** One page as fetched: its rows, where to resume, and how to authorize disclosing it. */
export type XPage<T> = {
  items: T[];
  /** Absent once the walk is over. */
  nextToken?: string;
  observation: ObservationInput;
  scope: ObservationScope;
};

/** What a cursor needs from the listing that made it. */
export type XCursorOptions<T> = {
  /** Fetches one page, continuing from `token` (absent for the first page). */
  fetchPage(token: string | undefined): Promise<XPage<T>>;
  /** Authorizes a page before `next()` returns it. A throw holds the page for the retry. */
  authorize(page: XPage<T>): Promise<void>;
  /** Releases what the cursor owns, when the caller disposes it. */
  dispose?(): void;
};

@validateRpc<XCursor<unknown>>()
export class XCursor<T> extends RpcTarget implements Cursor<T>, Disposable {
  readonly #options: XCursorOptions<T>;
  readonly #queue = new SerialTaskQueue();
  #token?: string;
  #done = false;
  #held?: XPage<T>;
  #disposed = false;

  constructor(options: XCursorOptions<T>) {
    super();
    this.#options = options;
  }

  /** @returns The next page, or `null` once the walk is over. Concurrent calls are serialized. */
  next(): Promise<T[] | null> {
    return this.#queue.run(() => this.#next());
  }

  async #next(): Promise<T[] | null> {
    if (this.#held === undefined) {
      if (this.#done) return null;
      const asked = this.#token;
      const page = await this.#options.fetchPage(asked);
      if (page.nextToken !== undefined && page.nextToken === asked) {
        throw new Error("X returned the same page it was asked to continue from.");
      }
      this.#token = page.nextToken;
      this.#done = page.nextToken === undefined;
      this.#held = page;
    }
    const page = this.#held;
    await this.#options.authorize(page);
    this.#held = undefined;
    return page.items;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#options.dispose?.();
  }
}

/** A cursor over rows already in hand, such as posts that exist only while pending. */
export function staticPage<T>(items: T[], observation: ObservationInput, scope: ObservationScope): XPage<T> {
  return { items, observation, scope };
}
