// Telemetry for Durable Object reset rejections.
//
// workerd tags rejections from a reset or disconnected DO with structured flags (jsg/util.c++):
// `retryable` ⇔ connection lost, `overloaded` ⇔ load shedding, and `durableObjectReset`
// whenever the object's incarnation died — the production storage-timeout reset arrives as
// `{remote, overloaded, durableObjectReset}`. The flags are attached natively in the calling
// Worker, so no message matching is needed. Local vitest-pool-workers aborts reject FLAGLESS
// (pinned by the "user-DO reset flags" integration test), so this predicate is unit-tested
// with synthetic production shapes.

import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.server");

// True for rejections caused by a DO reset or lost connection. These are requests that could make
// sense to retry (although as of this writing, the code does not do so). `overloaded` is excluded
// because when the DO is overloaded, retrying would make the problem worse.
export function isDoResetError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const flags = e as { durableObjectReset?: unknown; retryable?: unknown };
  return flags.durableObjectReset === true || flags.retryable === true;
}

/** Wraps a DO stub so every method call observes DO-reset rejections for telemetry
 * (`user_do.reset.surfaced`, with the method name as the operation) and rethrows them
 * unchanged. Otherwise transparent. Pass the caller's logger so the log attributes the reset
 * to the component (and context, e.g. gadgetId) that observed it; defaults to the Worker's. */
export function wrapDoStubForTelemetry<T extends { id: DurableObjectId }>(
    stub: T, log: ReturnType<typeof createWorkshopLogger> = logger): T {
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
            throw e;
          }
        })();
      };
    },
  });
}
