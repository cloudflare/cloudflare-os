# Examples

Three ways to configure and extend a Cloudflare OS deployment. Each example
is a self-contained stack — run one with:

```sh
pnpm exec alchemy deploy ./examples/<example>/alchemy.run.ts
```

| example | shows |
| --- | --- |
| [0-quickstart](./0-quickstart/alchemy.run.ts) | Zero-config full OS deploy, configured entirely through environment variables (custom domain, GitHub sign-in, AI gateway key) — what `pnpm run deploy` runs |
| [1-builtin-gatekeepers](./1-builtin-gatekeepers/alchemy.run.ts) | Configuring built-in gatekeepers: OAuth credentials install one, defaults opt out, config-free ones opt in |
| [2-custom-gatekeeper](./2-custom-gatekeeper/alchemy.run.ts) | A complete minimal custom gatekeeper: the `GatekeeperVendor` entrypoint, account/verifier/resource capability classes, and a session — typechecked against `@gadgets/workshop-shared/gatekeeper` |

A custom gatekeeper can also be a **package** following the standard capnweb
layout (`wrangler.jsonc` + `capnweb-validate` build) — then
`Gatekeeper({ name, package: "my-gatekeeper" })` derives everything from its
wrangler config, exactly like the built-ins. See any `packages/gatekeeper-*`
for the full gatekeeper RPC contract; example 2 implements the
contract end to end (with an auto-provisioning vendor; OAuth vendors
implement `connectAccount()` instead — see `packages/gatekeeper-github`).
