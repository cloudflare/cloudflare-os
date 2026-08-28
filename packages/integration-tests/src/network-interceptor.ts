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
 * A handler may read `request` only after deciding it owns the URL. Consuming a body and then
 * returning null would prevent a later handler from reading the same stream. Handlers may be async:
 * some wait for the test to decide what response to return after the Worker starts the request.
 */
export type Handler = (
  url: URL,
  method: string,
  headers: Headers,
  request: Request,
) => Response | null | Promise<Response | null>;

export class NetworkInterceptor {
  readonly #handlers: readonly Handler[];
  #realFetch: typeof globalThis.fetch | null = null;
  #unmockedCalls: string[] = [];

  constructor(handlers: Handler[] = []) {
    this.#handlers = [...handlers];
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

      // The harness dispatches its own traffic over loopback; let that through untouched.
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
        return realFetch(input, init);
      }

      // Let Request work out how input and init combine into a method, headers, and body. Constructing
      // one can transfer the body's stream, so it has to happen after the loopback return above. Past
      // this point `input` is never forwarded anywhere, so disturbing it costs nothing.
      const request = new Request(input, init);
      const method = request.method.toUpperCase();

      for (const handler of this.#handlers) {
        const response = await handler(url, method, request.headers, request);
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
