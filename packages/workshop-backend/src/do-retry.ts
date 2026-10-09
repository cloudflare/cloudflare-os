// Retry and telemetry for Durable Object reset rejections.
//
// workerd attaches the flags natively in the calling Worker, so no message matching is needed
// (jsg/util.c++, decodeTunneledException). Two independent axes: `retryable`/`overloaded` come
// from the kj exception TYPE (DISCONNECTED/OVERLOADED) and describe THIS CALL — one type per
// hop, so one flag per hop; `durableObjectReset` is parsed from the tunneled description and
// describes THE OBJECT, whose incarnation died, poisoning every stub to it. Hence the production
// storage-timeout reset is `{remote, overloaded, durableObjectReset}` with no `retryable`: it was
// shedding load AND it died. The docs cover `retryable`/`overloaded`/`remote`, but not
// `durableObjectReset` or the `durableObjectId` we log:
// https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
//
// Local vitest-pool-workers aborts reject FLAGLESS (pinned by the "user-DO reset flags"
// integration test), so the predicates and the retry path are unit-tested with synthetic
// production shapes.

import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.server");

/**
 * True for rejections caused by a DO reset or lost connection. This is the telemetry
 * classification, deliberately not the retry policy, which is narrower (see
 * `shouldRetryAfterReset`): a bare `overloaded` is excluded here only because a live object
 * shedding load is not a reset.
 */
export function isDoResetError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const flags = e as { durableObjectReset?: unknown; retryable?: unknown };
  return flags.durableObjectReset === true || flags.retryable === true;
}

/**
 * True for the runtime's loop-limit rejection ("Subrequest depth limit exceeded. This request
 * looped back into the Workers runtime too many times."). The runtime spends a loop counter on
 * Durable Object calls and refuses a call once it is exhausted. An object's outgoing channels can
 * hold an exhausted counter with nothing recursing, and then every call it makes is refused. The
 * counter is held by the calling object's instance, so restarting that object clears it. The
 * runtime gives the error no flag or code, hence the message match -- on the start of the
 * message, so that the text quoted inside another error (one echoing a caller-supplied value,
 * say) does not count. The sibling "passed through too many Workers stages" message is a
 * different counter, which a restart does not help, and is deliberately not matched.
 */
export function isLoopLimitError(e: unknown): boolean {
  return e instanceof Error && typeof e.message === "string" && e.message.startsWith(
      "Subrequest depth limit exceeded. This request looped back into the Workers runtime");
}

/** Wraps a DO stub so every method call observes DO-reset rejections for telemetry
 * (`user_do.reset.surfaced`, with the method name as the operation) and rethrows them
 * unchanged. Otherwise transparent. Pass the caller's logger so the log attributes the reset
 * to the component (and context, e.g. gadgetId) that observed it; defaults to the Worker's.
 * A surfaced reset may still be absorbed by `retryOnDoReset` at the call site (correlate with
 * `user_do.reset.recovered`). `onRejection`, if given, is called with every rejection of a
 * wrapped call (not only resets) before it is rethrown. */
export function wrapDoStubForTelemetry<T extends { id: DurableObjectId }>(
    stub: T, log: ReturnType<typeof createWorkshopLogger> = logger,
    onRejection?: (e: unknown) => void): T {
  return new Proxy(stub, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== "function") return value;
      // Invoke through the stub (`target[prop](...)`) rather than `.apply` on the extracted
      // handle: native RPC method handles are themselves proxies, and touching `.apply` on one
      // is interpreted as a nested RPC property access (the DO then rejects a call to "apply").
      const methods = target as unknown as Record<PropertyKey, (...a: unknown[]) => unknown>;
      if (typeof prop !== "string") return (...args: unknown[]) => methods[prop](...args);
      return (...args: unknown[]) => {
        const result = methods[prop](...args);
        if (typeof (result as PromiseLike<unknown> | undefined)?.then !== "function") return result;
        return (async () => {
          try {
            return await (result as PromiseLike<unknown>);
          } catch (e) {
            if (isDoResetError(e)) {
              log.warn("user DO reset observed", {
                event: "user_do.reset.surfaced",
                operation: prop,
                durableObjectId: target.id.toString(),
                error: e,
              });
            }
            onRejection?.(e);
            throw e;
          }
        })();
      };
    },
  });
}

// Full jitter decorrelates the replay burst a mass reset produces (a reset fails every
// in-flight call from every session at once); workerd queues the fresh-stub request behind
// the object restart, so no delay floor is needed.
const RETRY_JITTER_MS = 250;

/** Whether a rejection may be retried, given a call already known to be replay-safe.
 * Narrower than `isDoResetError`: `durableObjectReset` retries even with `overloaded` set (the
 * incarnation is dead — the queue that overloaded it died with it; this is the shape production
 * storage-timeout resets arrive in), a deliberate divergence from the never-retry-`overloaded`
 * guidance in the error-handling docs linked above. Bare `retryable` (connection lost to a
 * possibly-live object) retries only if it isn't shedding load. */
function shouldRetryAfterReset(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const flags = e as { durableObjectReset?: unknown; retryable?: unknown; overloaded?: unknown };
  if (flags.durableObjectReset === true) return true;
  return flags.retryable === true && flags.overloaded !== true;
}

/** Retries `callWithFreshStub` once if it rejects with a DO-reset shape. The caller asserts the
 * call is replay-safe (a reset can't distinguish "never applied" from "applied, response lost")
 * — wrap pure reads only. The thunk must mint its stub inside itself (e.g. via the fresh-stub
 * getters) so the second attempt gets a fresh incarnation; a captured stub is permanently broken
 * and retrying it is a silent no-op. Pass the same logger the stub's `wrapDoStubForTelemetry`
 * uses so the recovery is attributed to the component (and context, e.g. gadgetId) whose
 * surfaced warning it absorbs; defaults to the Worker's. */
export async function retryOnDoReset<T>(
    callWithFreshStub: () => Promise<T>,
    log: ReturnType<typeof createWorkshopLogger> = logger): Promise<T> {
  try {
    return await callWithFreshStub();
  } catch (e) {
    if (!shouldRetryAfterReset(e)) throw e;  // identity rethrow, flags intact
    await scheduler.wait(Math.random() * RETRY_JITTER_MS);
    let recovered = await callWithFreshStub();  // a second rejection propagates by identity
    log.info("recovered from user DO reset", { event: "user_do.reset.recovered" });
    return recovered;
  }
}
