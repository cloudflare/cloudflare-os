// Stand-in for the `cloudflare:workers` module, which only exists inside workerd.
//
// A module that records metrics reads the Worker's bindings from that module's `env`, and cannot
// be imported under plain vitest without it. A package's Node vitest project aliases
// `cloudflare:workers` to this file. Only `env` is provided, empty until a test sets a binding on
// it -- anything that needs a Durable Object or an `RpcTarget` belongs in a Workers-pool test,
// not here.

/** The Worker's bindings: none, until a test sets one. */
export const env: Record<string, unknown> = {};
