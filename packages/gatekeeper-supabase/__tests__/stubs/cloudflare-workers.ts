// Stand-in for the `cloudflare:workers` module, which only exists inside workerd. Only the base
// classes are provided, so that `import` and `extends` resolve; a test constructs the gatekeeper's
// classes with a fake `ctx` of its own.

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
