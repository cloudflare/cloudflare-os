// Stand-in for the `cloudflare:workers` module, which only exists inside workerd.
//
// A bundled blueprint's server defines a Durable Object and a `WorkerEntrypoint`, and cannot be
// imported under plain vitest without it. Only the base classes are provided, and only so that
// `import` and `extends` resolve -- and so a server test can construct a gadget over in-memory
// storage, where the runtime's base would refuse a state that is not a real `DurableObjectState`.
// Anything that actually needs the runtime belongs in the Workshop backend's workerd suite, which
// installs and inspects the archives the build produces.
//
// Same as `packages/mcp-shared/__tests__/stubs/cloudflare-workers.ts`, spelled without parameter
// properties because `tsconfig.node.json` checks this directory under `erasableSyntaxOnly`.

export class DurableObject<E = unknown, P = unknown> {
  readonly ctx: unknown;
  readonly env: E;
  readonly props?: P;
  constructor(ctx: unknown, env: E, props?: P) {
    this.ctx = ctx;
    this.env = env;
    this.props = props;
  }
}

// oxlint-disable-next-line typescript/no-extraneous-class -- empty on purpose: only so `extends` resolves
export class RpcTarget {}

export class WorkerEntrypoint<E = unknown, P = unknown> {
  readonly ctx: unknown;
  readonly env: E;
  readonly props?: P;
  constructor(ctx: unknown, env: E, props?: P) {
    this.ctx = ctx;
    this.env = env;
    this.props = props;
  }
}

export class RpcStub<T> {
  readonly target: T;
  constructor(target: T) {
    this.target = target;
  }
}
