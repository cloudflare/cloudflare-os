// Intercepts the Workers' outbound fetch() so the tests never touch a real server.
//
// createTestHarness routes a Worker's outbound fetch() back through the Node process, so patching
// globalThis.fetch is enough -- no interception library needed. Requests to the harness itself
// (localhost) pass through; anything else that isn't matched by a handler throws, so an unmocked
// call fails the test instead of silently reaching the internet.
//
// This file is mechanism only. What a given vendor's endpoints return lives in a handler module, so a
// suite for another gatekeeper is a new handler module rather than a fork of this one.

/**
 * Answers one request, or returns null to decline it and let the next handler try.
 *
 * Handlers may be async. That is load-bearing rather than a convenience: a handler sometimes has to
 * wait for the test to say what to answer with, because the thing that identifies the request only
 * comes into existence once the Worker has started making it.
 */
export type Handler =
    (url: URL, method: string, headers: Headers) => Response | null | Promise<Response | null>;

/** Optional settings for {@link NetworkInterceptor}. */
export type InterceptorOptions = {
  /**
   * Hostnames whose requests reach the real network untouched.
   *
   * A handler cannot stand in for a host that a suite genuinely has to reach, because a handler
   * receives the URL, the method, and the headers, but never the body. Passing a real POST through
   * therefore has to happen here, before the request is taken apart.
   *
   * Keep the list to hosts the suite cannot do without. Every other host still throws.
   */
  passThroughHosts?: readonly string[];
};

export class NetworkInterceptor {
  readonly #handlers: readonly Handler[];
  readonly #passThroughHosts: ReadonlySet<string>;
  #realFetch: typeof globalThis.fetch | null = null;
  #unmockedCalls: string[] = [];

  constructor(handlers: Handler[] = [], options: InterceptorOptions = {}) {
    this.#handlers = [...handlers];
    this.#passThroughHosts = new Set(options.passThroughHosts ?? []);
  }

  install(): void {
    if (this.#realFetch) return;
    const realFetch = this.#realFetch = globalThis.fetch;

    type FetchInput = Parameters<typeof globalThis.fetch>[0];
    type FetchInit = Parameters<typeof globalThis.fetch>[1];

    globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
      const raw = typeof input === "string" ? input
        : input instanceof URL ? input.toString()
        : input.url;
      const url = new URL(raw);

      // The harness dispatches its own traffic over loopback; let that through untouched. An
      // explicitly allowed host goes the same way, before the body can be disturbed below.
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
          || this.#passThroughHosts.has(url.hostname)) {
        return realFetch(input, init);
      }

      // Let Request work out how input and init combine into a method and headers. Constructing one
      // can transfer the body's stream, so it has to happen after the loopback return above -- past
      // this point `input` is never forwarded anywhere, so disturbing it costs nothing. The
      // toUpperCase() stays: Request normalises only the methods the fetch spec lists, so `patch`
      // would otherwise reach handlers lowercased.
      const { method: rawMethod, headers } = new Request(input, init);
      const method = rawMethod.toUpperCase();

      for (const handler of this.#handlers) {
        const response = await handler(url, method, headers);
        if (response) return response;
      }

      this.#unmockedCalls.push(`${method} ${raw}`);
      throw new Error(`Unmocked outbound request: ${method} ${raw}`);
    }) as typeof globalThis.fetch;
  }

  uninstall(): void {
    if (this.#realFetch) {
      globalThis.fetch = this.#realFetch;
      this.#realFetch = null;
    }
  }

  /** URLs that were neither handled nor local, for asserting nothing escaped. */
  getUnmockedCalls(): string[] {
    return [...this.#unmockedCalls];
  }

  /**
   * Remove and return the recorded unmocked calls containing `substring`.
   *
   * For the one test that provokes an unmocked request deliberately. Taking just its own entry rather
   * than resetting means a concurrently running sibling's escape is still caught.
   */
  takeUnmockedCalls(substring: string): string[] {
    const taken = this.#unmockedCalls.filter(call => call.includes(substring));
    this.#unmockedCalls = this.#unmockedCalls.filter(call => !call.includes(substring));
    return taken;
  }

  reset(): void {
    this.#unmockedCalls = [];
  }
}
