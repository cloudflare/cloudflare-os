// Stand-in for the `cloudflare:workers` module, which only exists inside workerd.
//
// Modules here that define a Durable Object or an `RpcTarget` cannot be imported under plain vitest
// without it. Only the base classes are provided, and only so that `import` and `extends` resolve --
// anything that actually needs the runtime belongs in a Workers-pool test, not here.
//
// `env` is the shared stub's: empty until a test sets a binding on it, such as the `METRICS`
// dataset the upstream's points are written to.

export { env } from "@gadgets/scripts/cloudflare-workers-stub";

export class DurableObject<E = unknown, P = unknown> {
  constructor(readonly ctx: unknown, readonly env: E, readonly props?: P) {}
}

export class RpcTarget {}

export class WorkerEntrypoint<E = unknown, P = unknown> {
  constructor(readonly ctx: unknown, readonly env: E, readonly props?: P) {}
}

export class RpcStub<T> {
  constructor(readonly target: T) {}
}
