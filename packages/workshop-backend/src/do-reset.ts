// Classification of Durable Object reset rejections.
//
// workerd tags rejections from a reset or disconnected DO with structured flags (jsg/util.c++):
// `retryable` ⇔ connection lost, `overloaded` ⇔ load shedding, and `durableObjectReset`
// whenever the object's incarnation died — the production storage-timeout reset arrives as
// `{remote, overloaded, durableObjectReset}`. The flags are attached natively in the calling
// Worker, so no message matching is needed. Local vitest-pool-workers aborts reject FLAGLESS
// (pinned by the "user-DO reset flags" integration test), so this predicate is unit-tested
// with synthetic production shapes.

/** True for rejections caused by a DO reset or lost connection. Used to classify surfaced
 * errors for telemetry (user_do.reset.surfaced); the Worker deliberately does not retry them
 * (see the chokepoint comment in server.ts). `overloaded` alone is excluded — that object is
 * alive and shedding load. */
export function isDoResetError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const flags = e as { durableObjectReset?: unknown; retryable?: unknown };
  return flags.durableObjectReset === true || flags.retryable === true;
}
