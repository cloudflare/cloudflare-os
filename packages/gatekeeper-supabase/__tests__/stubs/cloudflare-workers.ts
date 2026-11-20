// Stand-in for the `cloudflare:workers` module, which only exists inside workerd. Only the base
// classes are provided, so that `import` and `extends` resolve; a test constructs the gatekeeper's
// classes with a fake `ctx` of its own. `env` is the shared stub's: the Worker's bindings, none
// until a test sets one.

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
