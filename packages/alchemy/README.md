# cloudflare-os

Deploy [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) to your
own Cloudflare account with [alchemy](https://alchemy.run) — one
`OperatingSystem` resource provisions and wires the whole system:

- the **router** (the public origin: static frontend assets, SPA fallback,
  custom domain) and the **workshop backend** (the kernel: browser
  rendering, dynamic Worker loader, Workers AI, Durable Objects),
- one Worker per enabled **gatekeeper**, with `GATEKEEPER_*` service
  bindings both runtimes discover,
- the KV namespaces and R2 bucket, every build step (vite, capnweb-validate,
  configurator UIs), and — in gateway mode — an **AI Gateway** with a
  least-privilege access token and Secrets-Store-backed provider keys.

`alchemy destroy` tears all of it down again.

## Quick start

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { OperatingSystem } from "cloudflare-os";
import { GitHub } from "cloudflare-os/gatekeepers";

export default Alchemy.Stack(
  "AcmeOS",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const os = yield* OperatingSystem("OS", {
      domain: "os.acme.com",          // omit → the router's workers.dev URL
      admins: ["sam"],
      auth: { gatekeepers: ["github"], disablePasswordAuth: true },
      gatekeepers: [
        GitHub({
          clientId: Config.string("GITHUB_CLIENT_ID"),
          clientSecret: Config.redacted("GITHUB_CLIENT_SECRET"),
        }),
      ],
      ai: {
        providers: { anthropic: Config.redacted("ANTHROPIC_API_KEY") },
      },
    });

    return { url: os.url };
  }),
);
```

```sh
pnpm exec alchemy deploy
```

Every prop is optional: `OperatingSystem("OS")` alone deploys a fully
working OS (password auth, BYOK model keys, the default gatekeepers) at the
router's `workers.dev` URL. To deploy **your own instance**, start from the
[starter repo](https://github.com/cloudflare/cloudflare-os-starter) — its
`alchemy.run.ts` is a complete customized deployment. The
[examples here](./examples/README.md) are for working on this repo: the
[quickstart](./examples/0-quickstart/alchemy.run.ts) deploys straight from a
checkout (`pnpm --dir packages/alchemy run deploy`).

## Gatekeepers

Each gatekeeper deploys as **its own Worker**. Built-ins are configured with
the plugin functions in [`cloudflare-os/gatekeepers`](./src/gatekeepers) —
their entry module, compatibility flags, Durable Object migrations, KV
bindings, and vars all **derive from the package's `wrangler.jsonc` at
deploy time**, so a manifest names only what wrangler doesn't know:

```typescript
import { Context, GitHub, HomeAssistant, Mcp } from "cloudflare-os/gatekeepers";

gatekeepers: [
  GitHub({ clientId, clientSecret }),   // credentialed: configuring = installing
  Context({ sharingDomain: "production" }), // reconfigure a default by name
  Mcp({ enabled: false }),              // opt out of a default
  HomeAssistant(),                      // opt in to a config-free non-default
]
```

`context`, `scheduler`, and `mcp` deploy by default, even when the
`gatekeepers` prop is omitted.

### Custom gatekeepers

A custom gatekeeper is a Worker implementing the **gatekeeper contract**
from `@gadgets/workshop-shared/gatekeeper` — capability-passing RPC, not
HTTP. One Worker module, several exports (workerd requires every named
export of an entry module to be a class):

| export | consumed by | role |
| --- | --- | --- |
| `GatekeeperVendor` | the backend's `GATEKEEPER_<NAME>` binding at `entrypoint: "GatekeeperVendor"` | the vendor API — the only externally-bound entrypoint |
| account / verifier / resource classes | `ctx.exports` loopback | capabilities the vendor mints and hands back as RPC stubs |
| `default` (`fetch`) | the router at `/gatekeeper/<name>/*` | browser plumbing only: OAuth landings, configurator iframes, logos |

The chain: the backend calls `GatekeeperVendor` → `connectAccount()` /
`createAccount()` yields a `GatekeeperUser` (an account capability) →
`getGatekeeperClassFor(url)` yields a Durable Object class per bound
resource → its `startSession()` returns the session object — the
capability gadgets and agents actually call, typed by the vendor's own
`getTypeScriptTypes()`.

```typescript
// src/worker.ts — the vendor entrypoint (abridged; the account, verifier,
// and resource-DO classes complete the contract — see the example)
import { WorkerEntrypoint } from "cloudflare:workers";
import type { GatekeeperUser, SupportedResource, VendorDescription }
  from "@gadgets/workshop-shared/gatekeeper";
import type { AcmeEnv } from "../alchemy.run.ts";

export class GatekeeperVendor extends WorkerEntrypoint<AcmeEnv> {
  async describe(): Promise<VendorDescription> {
    return { displayName: "Acme", url: "https://acme.example",
             logo: AVATAR, tagline: "…", autoProvisionsAccount: true };
  }
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    // mint an account capability from this module's own exports
    return this.ctx.exports.AcmeAccount({ props: { label: "…" } });
  }
  async getSupportedResources(): Promise<SupportedResource[]> { /* … */ }
  async getTypeScriptTypes(): Promise<string> { /* the session .d.ts */ }
  // credentialed vendors implement connectAccount() (OAuth) instead of
  // autoProvisionsAccount + createAccount() — see packages/gatekeeper-github
}
```

The stack declares the Worker with typed bindings (`InferEnv`) and its
resource DO class, then wires it in:

```typescript
export const AcmeWorker = Cloudflare.Worker("AcmeWorker", {
  main: "./src/worker.ts",
  compatibility: { date: "2026-02-02", flags: ["enable_ctx_exports"] },
  env: {
    CACHE: Cloudflare.KV.Namespace("Cache"),
    ACME_API_TOKEN: Config.redacted("ACME_API_TOKEN"),
    AcmeThing: Cloudflare.DurableObject("AcmeThing"), // drives its migration
  },
});

gatekeepers: [Gatekeeper({ name: "acme", worker: yield* AcmeWorker })]
```

[examples/2-custom-gatekeeper](./examples/2-custom-gatekeeper) is the
complete, typechecked version of this vendor. A gatekeeper that lives in
its own package following the standard capnweb layout (`wrangler.jsonc` +
`capnweb-validate`) can instead be wired with
`Gatekeeper({ name: "acme", package: "my-acme-gatekeeper" })` — the same
wrangler derivation as the built-ins.

> An Effect-native gatekeeper (capability bindings, typed errors) is not
> offered yet: alchemy's Effect workers can't export the named entrypoint
> and capability classes above, and the vendor API's capability-passing
> semantics need a proper Effect bridge. Both are on the upstream list.

## Sign-in & admins

Three sign-in modes, chosen by `auth`:

```typescript
// 1. Password accounts (default — no auth prop). Users self-register;
//    `admins` are local usernames.
admins: ["admin"]

// 2. OAuth gatekeeper sign-in: "Continue with GitHub/Google/…" for
//    gatekeepers listed here (they must be deployed with credentials).
//    Identities are OAuth-verified emails — `admins` too.
auth: { gatekeepers: ["github"], disablePasswordAuth: true },
admins: ["sam@acme.com"]

// 3. Cloudflare Access: identity is verified before requests reach the
//    Worker. `admins` are the emails in the Access JWT.
auth: { access: { aud: "<AUDIENCE_TAG>", iss: "https://<TEAM>.cloudflareaccess.com" } },
admins: ["sam@acme.com"]
```

`admins` gates `/admin` (branding, connector policies) and is always
interpreted in the active sign-in system's identity namespace.

> Note: `auth.access` *validates* an Access application — it does not
> create one. Create the self-hosted app for your hostname in Zero Trust
> and copy its audience tag. Provisioning the Access application and its
> admin policy from this stack (alchemy has the Access resources) is a
> natural follow-up.

## AI Gateway: provisioned, not referenced

The presence of the `ai` prop is the opt-in (omit it → BYOK mode, where
users bring their own model keys):

```typescript
ai: {
  gateway: { cacheTtl: 60 },   // Cloudflare.AI.GatewayProps, verbatim
  providers: {                 // stored keys, provisioned on the gateway
    anthropic: Config.redacted("ANTHROPIC_API_KEY"),
    openai: Config.redacted("OPENAI_API_KEY"),
  },
  workersAi: true,             // or "direct" to skip gateway cost logs
  limits: { dailyLlmCallLimit: 200 },  // per-user quotas (backend-enforced)
}
```

This provisions the gateway, a Run+Read `AccountApiToken` for the backend,
a Secrets Store, and one `AI.ProviderKey` per `providers` entry — nothing to
create in the dashboard, and the keys are never bound into any Worker.

## Extending the deployment

- `backend.env` — extra bindings/vars on the backend Worker.
- `backend.services` — extra service bindings with a named entrypoint and
  workerd `ctx.props` (e.g. a private error-reporter Worker; see the
  [starter repo](https://github.com/cloudflare/cloudflare-os-starter)).
- `frontend.env` — extra build-time env for the vite build.

All outputs are real alchemy resources (`os.router`, `os.backend`,
`os.gatekeepers`, `os.blueprints`, …), so you can compose further — point a
DNS record at `os.url`, bind `os.backend` from your own Workers, add
alerting.

## Status

Early access, like the OS itself. The resource graph is verified against
alchemy's plan engine; see
[`plans/alchemy-deploy.md`](../../plans/alchemy-deploy.md) for the design,
current limitations (a `.svg` Text-module shim, service-binding `ctx.props`
pending an upstream schema fix), and the upstream punch list.
