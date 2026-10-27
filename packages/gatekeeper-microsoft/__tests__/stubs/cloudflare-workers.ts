// Stand-in for the `cloudflare:workers` module, which only exists inside workerd.
//
// Modules here that define a Durable Object or an `RpcTarget` cannot be imported under plain vitest
// without it. Only the base classes are provided, and only so that `import` and `extends` resolve --
// anything that actually needs the runtime belongs in a Workers-pool test, not here.

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
