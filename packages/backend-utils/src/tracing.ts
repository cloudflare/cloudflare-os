import { tracing } from "cloudflare:workers";

type Attribute = boolean | number | string;

/** The span surface exposed to callbacks. Lifetime is managed by `traced`, so no `end()`. */
export interface TraceSpan {
  readonly isTraced: boolean;
  setAttribute(key: string, value?: Attribute): void;
}

/**
 * Creates a span helper that stamps the ambient observability context onto each span as
 * attributes. Tracing only: never logs, never modifies context. Exceptions propagate
 * unchanged, marked on the span via an `error` attribute (the beta API has no outcome).
 * Sync and async callbacks both get correct spans: enterSpan ends the span only when the
 * returned promise settles, not at the synchronous return (pinned by __tests__/tracing.test.ts).
 */
export function createTracer(getContext: () => Readonly<Record<string, unknown>>) {
  return function traced<Result>(name: string, callback: (span: TraceSpan) => Result): Result {
    return tracing.enterSpan(name, (span) => {
      if (span.isTraced) {
        for (const [key, value] of Object.entries(getContext())) {
          if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
            span.setAttribute(key, value);
          }
        }
      }
      // Boolean marker only: error text is unbounded and possibly sensitive, so it belongs to
      // logs/reporting, not trace attributes.
      const fail = () => span.setAttribute("error", true);
      try {
        const result = callback(span);
        // enterSpan keeps the span open until the returned promise settles, so async work gets
        // its real duration and fail() runs before the span can close (the runtime watches the
        // .catch-wrapped promise returned here). That wrapper is a new promise, not `result` —
        // fine for data results; don't wrap pipelined RPC stubs in `traced`.
        return result instanceof Promise
            ? result.catch((err) => { fail(); throw err; }) as Result
            : result;
      } catch (err) {
        fail();
        throw err;
      }
    });
  };
}
