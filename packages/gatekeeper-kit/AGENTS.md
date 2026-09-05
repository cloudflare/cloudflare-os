# Gatekeeper Kit contributor notes

`@gadgets/gatekeeper-kit` is a library, not a deployable Worker. Do not add `wrangler.jsonc`; its
presence makes release tooling treat this package as a gatekeeper deployment.

## Package boundaries

- Only Layer 1 leaf modules are shipped. Layer 2 remains a proposal in
  [`../../plans/gatekeeper-kit.md`](../../plans/gatekeeper-kit.md).
- Keep leaf modules independently usable. Do not make one depend on a future assembly layer.
- Accept the narrowest structural KV surface a module needs. Pass stable `ctx.storage.kv` objects to
  modules that coordinate work by storage identity.
- Treat shipped storage keys and prefixes as compatibility. Use existing key and prefix options when
  porting a gatekeeper with a different layout.
- Public modules are explicit subpath exports in [`package.json`](package.json). Document new public
  symbols with JSDoc and add the subpath to the README inventory.

## Documentation ownership

- [`README.md`](README.md) maps the package and its modules.
- [`USAGE.md`](USAGE.md) owns cross-module integration guidance and operational sharp edges.
- Exported-symbol JSDoc owns the exact API contract visible in editors.
- [`../../plans/gatekeeper-kit.md`](../../plans/gatekeeper-kit.md) is the design record, including the
  unshipped Layer 2 proposal. Do not duplicate that proposal into current usage documentation.

## Verification

Use Node tests for pure logic. Use the workerd project for persisted RPC stubs, `RpcTarget`,
Durable Object behavior, and `crypto.subtle.timingSafeEqual`.

From the repository root:

```sh
pnpm --filter @gadgets/gatekeeper-kit test:run
vp run -F @gadgets/gatekeeper-kit build
```
