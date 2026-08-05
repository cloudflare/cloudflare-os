# Alchemy as the default deploy: the `OperatingSystem` resource

*Status: **implemented** in `packages/alchemy` (npm name `cloudflare-os`) with a
dogfood stack at the repo-root `alchemy.run.ts`. Verified: package + stack
typecheck clean, and `alchemy plan` builds the full resource graph against the
real state store. Not yet verified: a live `alchemy deploy` end-to-end.
Reference clone of alchemy lives at `.alchemy-reference/` (git-excluded, not a
submodule).*

## Goal

Make deploying Cloudflare OS to your own account a single alchemy resource:

```typescript
// alchemy.run.ts (in YOUR company's repo — no fork of cloudflare-os needed)
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import { OperatingSystem } from "cloudflare-os";
import GitHub from "@gadgets/github-gatekeeper/deploy";
import Google from "@gadgets/google-gatekeeper/deploy";
import HomeAssistant from "@gadgets/homeassistant-gatekeeper/deploy";
import Mcp from "@gadgets/mcp-gatekeeper/deploy";

export default Alchemy.Stack(
  "AcmeOS",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const os = yield* OperatingSystem("OS", {
      domain: "os.acme.com",
      admins: ["sam"],

      auth: {
        gatekeepers: ["google", "github"], // AUTH_GATEKEEPERS
        disablePasswordAuth: true,
      },

      // Gatekeepers are plugins: each package OWNS its deployment manifest
      // (exported from `<pkg>/deploy`, plain data, no alchemy dependency).
      // The core trio (context, scheduler, mcp) deploys by default.
      gatekeepers: [
        GitHub({
          clientId: Config.string("GITHUB_CLIENT_ID"),
          clientSecret: Config.redacted("GITHUB_CLIENT_SECRET"),
        }),
        Google({
          clientId: Config.string("GOOGLE_CLIENT_ID"),
          clientSecret: Config.redacted("GOOGLE_CLIENT_SECRET"),
        }),
        Mcp({ enabled: false }),   // opt OUT of a default
        HomeAssistant(),           // opt IN to a non-default zero-config gatekeeper
      ],

      // presence of `ai` = gateway mode; the Gateway is provisioned, not referenced
      ai: {
        gateway: { cacheTtl: 60 },            // Cloudflare.AI.GatewayProps, verbatim
        limits: { dailyLlmCallLimit: 200 },   // app-level per-user quotas (backend-enforced)
      },
    });

    return { url: os.url };
  }),
);
```

`bun alchemy deploy` provisions everything: 2+ KV namespaces, the R2 bucket, one Worker
per enabled gatekeeper, the workshop-backend Worker (browser rendering, worker loader,
Workers AI, DO migrations), the frontend build, and the router Worker with static assets
and the custom domain. `bun alchemy destroy` tears it all down.

## Output attributes

```typescript
const os = yield* OperatingSystem("OS", { ... });

os.url                      // public origin (https://os.acme.com or workers.dev URL)
os.router                   // the router Worker resource
os.backend                  // the workshop-backend Worker resource
os.gatekeepers              // { github: Worker, google: Worker, context: Worker, ... }
os.blueprints, os.avatars   // KV namespaces
os.blueprintContent         // R2 bucket
```

Everything is a real alchemy resource, so users can compose further — e.g. point a
`Cloudflare.DNS.Record` at `os.url`, bind `os.backend` from their own Workers, or add
alerting on the router.

## Class form (matching the `StaticSite`/`Worker` convention)

```typescript
export default class OS extends OperatingSystem<OS>()("OS", {
  domain: "os.acme.com",
  admins: ["sam"],
  gatekeepers: { context: true, scheduler: true },
}) {}

// elsewhere
const os = yield* OS;
```

## Gatekeepers: plugin functions, derived from wrangler.jsonc

**Each gatekeeper is its own Worker** (unchanged from production: both runtimes
discover them by prefix-scanning `GATEKEEPER_*` service bindings — the README calls
them "drivers"). Each has a plugin function in
`packages/alchemy/src/gatekeepers/<name>.ts` (one file per gatekeeper, exported from
`cloudflare-os/gatekeepers`), returning a `GatekeeperDeployment` manifest.

> Placement note: the conservative choice for now is to keep these modules inside the
> `cloudflare-os` package rather than adding `deploy.ts` exports to the gatekeeper
> packages we don't own. Moving each module into its package so the gatekeeper owns
> its deployment is the natural follow-up proposal upstream.

**Manifests are not copies of config that exists elsewhere.** The package's
`wrangler.jsonc` is the deploy contract, and the composite parses it at deploy time
(`src/wrangler.ts`, jsonc-parser) to derive the entry module, compatibility
date/flags, DO migrations, KV bindings, and vars — for gatekeepers, the backend, and
the router (including the contract-tested `run_worker_first` list). A manifest names
only what wrangler doesn't know:

```typescript
// src/gatekeepers/github.ts — everything else derives from wrangler.jsonc
export const GitHub = (config: GitHubConfig): GatekeeperDeployment => ({
  name: "github",
  package: "@gadgets/github-gatekeeper",
  prebuild: "build:configurator",   // the pre-build wrangler's build.command lacks
  env: { CLIENT_ID: config.clientId, CLIENT_SECRET: config.clientSecret },
  secrets: ["CLIENT_ID", "CLIENT_SECRET"],
});
```

`OperatingSystemProps.gatekeepers` is `GatekeeperDeployment[]`:

- The core trio (`Context()`, `Scheduler()`, `Mcp()`) is merged in by default
  (`defaultEnabled: true`); opt out with `Mcp({ enabled: false })`. A user entry with
  the same `name` replaces a default.
- Credentialed gatekeepers install by being listed — their config functions require
  the credentials, so **missing credentials are a type error**.
- `context` accepts `sharingDomain` (defaults to the `{PUBLIC_BASE_URL}` placeholder,
  substituted at deploy time; the starter pins it to `"production"`). Manifest
  `vendorProps` become the backend vendor binding's workerd `ctx.props`.
- `gatekeeper-email` ships no manifest (`NOT_INSTALLABLE`: needs a zone with Email
  Routing).

**Two ways to bring a custom gatekeeper** (`GatekeeperDeployment` is a union):

1. **Packaged** — any package following the standard capnweb layout with a
   `wrangler.jsonc`; the same derivation applies:
   `Gatekeeper({ name: "custom", package: "custom-gatekeeper", env: {...} })`.
2. **Effectful** — any alchemy Worker, including Effect-native
   `Cloudflare.Worker` classes; the Worker owns its build/bindings/DOs and the
   composite only wires it in (`GATEKEEPER_*` bindings, `BASE_URL`, vendor props):
   `Gatekeeper({ name: "jira", worker: Jira })`.

Note on terms: **gadgets** (user-built apps) are not Workers at all — they run as
Dynamic Worker facets loaded at runtime by the backend through `LOADER`, invisible to
IaC. Gatekeepers are the deployed Workers.

Typing follows alchemy doctrine: plain interfaces everywhere, `InputProps<T>` applied
once at the `OperatingSystem` boundary (structure-determining props — `domain`,
`auth`, `gatekeepers`, `ai`, `backend`, `frontend` — are marked static, the
`StaticSite` idiom).

## AI Gateway: provisioned, not referenced

Gateway mode is pure IaC — the composite *provisions* the gateway and its access
token; the user never copies an id or pastes a pre-made token. The `ai` key itself is
the opt-in (omit it → BYOK mode, today's default):

```typescript
ai: {}                                        // gateway mode, defaults
ai: {
  gateway: { cacheTtl: 60, spendLimits: { enabled: true, rules: [...] } },
  providers: {                                // keyed record of provider credentials
    anthropic: Config.redacted("ANTHROPIC_API_KEY"),
    openai: Config.redacted("OPENAI_API_KEY"),
  },
  workersAi: "direct",                        // CF_AI_GATEWAY_WAI / _WAI_DIRECT
  limits: { enableCloudflareLimits: true, dailyLlmCallLimit: 200 },
}
ai: { gateway: myGateway }                    // BYO Cloudflare.AI.Gateway resource (still IaC)
```

`providers` is a record, not a string list, because the strings alone are only half the
story: `CF_AI_GATEWAY_PROVIDERS` is merely the *menu* the backend shows
(`ai-gateway.ts:37`), while the actual upstream credentials live on the gateway —
gateway-mode requests carry only `cf-aig-authorization` and no provider key
(`ai-models.ts`), so the gateway resolves each provider's key from its Secrets-Store-
backed **stored keys**. Today self-hosters set those up by hand in the dashboard; here
they're provisioned. From the record the composite derives:

- `CF_AI_GATEWAY_PROVIDERS` ← the record's keys, joined
- `Cloudflare.SecretsStore.Store("KeyStore")` ← provisioned and attached to the
  gateway as `storeId`
- one `Cloudflare.AI.ProviderKey` per entry (`defaultConfig: true`) — the key lives in
  the Secrets Store, attached to the gateway, never bound into any Worker
- `workersAi` stays a separate flag: Workers AI authenticates with the gateway's own
  account token, no stored key involved

Two limit layers, deliberately distinct:

- **`ai.gateway`** is `Cloudflare.AI.GatewayProps` verbatim (no re-typing) — Cloudflare
  enforces these at the gateway: `rateLimiting*`, `spendLimits` cost caps, `cacheTtl`,
  DLP, logpush, otel.
- **`ai.limits`** are app-level *per-user* quotas the gateway cannot express, enforced
  by workshop-backend's billing/top-up flow (`docs/ai-gateway-billing.md`):
  `ENABLE_CLOUDFLARE_LIMITS`, `DAILY_LLM_CALL_LIMIT`, `MINIMUM_CLOUDFLARE_BALANCE`.

Under the hood (namespace `OS/AI/`):

- `Cloudflare.AI.Gateway("Gateway", …)` — the gateway itself; `gatewayId` and
  `accountId` are output attributes.
- `Cloudflare.ApiToken.AccountApiToken("GatewayToken", …)` scoped to the
  **AI Gateway Run + AI Gateway Read** permission groups — the same pattern alchemy's
  own `*Http` capability layers use to mint least-privilege tokens at deploy time.
- Backend env is wired entirely from those outputs: `CF_AI_GATEWAY` ← gateway id,
  `CF_AI_GATEWAY_ACCOUNT_ID` ← gateway's account, `CF_AI_GATEWAY_API_TOKEN` ← the
  minted token's secret value (deployed as `secret_text`), plus
  `CF_AI_GATEWAY_PROVIDERS` / `CF_AI_GATEWAY_WAI` / `CF_AI_GATEWAY_WAI_DIRECT` from
  the props.

Destroy the stack and the gateway *and* its token are revoked with it. Omit `ai`
entirely and the OS runs in BYOK mode (per-user provider keys), unchanged from today.

## What `OperatingSystem` closes over

Following the `Cloudflare.Website.StaticSite` composite pattern: one function returning
an Effect, children declared under `Namespace.push(id)`, aggregate outputs returned.
Logical tree:

```
OS/
├── Frontend            Command.Build  – vite build (VITE_CF_ACCESS_MODE from auth config)
├── Blueprints          KV.Namespace
├── Avatars             KV.Namespace
├── BlueprintContent    R2.Bucket
├── Backend/
│   ├── Blueprints      Command.Build  – build-format-blueprints.mjs  (⚠ not in wrangler build.command today)
│   ├── BrowserRuntime  Command.Build  – build-browser-runtime.mjs
│   ├── Validate        Command.Build  – capnweb-validate build
│   └── Worker          Cloudflare.Worker (async mode: main → .wrangler/validate/src/server.ts)
├── Gatekeepers/
│   ├── GitHub/
│   │   ├── Configurator Command.Build – build-gatekeeper-configurator.mjs
│   │   ├── Validate     Command.Build – capnweb-validate build
│   │   └── Worker       Cloudflare.Worker
│   └── … (one subtree per enabled gatekeeper; context/scheduler add build-app.mjs,
│         context adds its CONTEXT_COLLECTIONS KV.Namespace)
├── AI/                 (only when `ai` is set)
│   ├── Gateway         Cloudflare.AI.Gateway (storeId ← KeyStore)
│   ├── GatewayToken    ApiToken.AccountApiToken (AI Gateway Run + Read)
│   ├── KeyStore        SecretsStore.Store (only when `providers` is set)
│   └── <Provider>Key   AI.ProviderKey, one per `providers` entry
└── Router              Cloudflare.Worker (assets: Frontend outdir, SPA fallback,
                        run_worker_first, custom domain)
```

Key wiring, all of which the exploration confirmed against `run-dev-server.js`,
`scripts/release/manifest-lib.mjs`, and the golden manifest:

- **Backend env**: `BLUEPRINTS`/`AVATARS` (KV), `BLUEPRINT_CONTENT` (R2), `BROWSER`
  (browser rendering), `LOADER` (worker loader), `WORKERS_AI` (always bound — webFetch's
  toMarkdown needs it), `PUBLIC_BASE_URL`, `ADMINS`, auth vars
  (`AUTH_GATEKEEPERS`, `DISABLE_PASSWORD_AUTH`, `CF_ACCESS_AUD/ISS`), the
  `CF_AI_GATEWAY*` vars derived from the provisioned Gateway + token outputs (see the
  AI Gateway section), limits vars, plus one `GATEKEEPER_*` service binding per gatekeeper at entrypoint
  `GatekeeperVendor` (context additionally gets `props: { sharingDomain }`).
- **Router env**: `WORKSHOP_BACKEND` service binding, `GATEKEEPER_*` service bindings at
  the default entrypoint, `ASSETS` from the frontend build with
  `not_found_handling: "single-page-application"` and the `run_worker_first` list that
  `packages/router/__tests__/router.test.ts` contract-tests.
- **Gatekeeper env**: `BASE_URL = ${PUBLIC_BASE_URL}/gatekeeper/<short>`,
  `CLIENT_ID`/`CLIENT_SECRET` secrets where applicable, per-gatekeeper extras
  (`MCP_ALLOW_INSECURE`, portal vars, zoominfo URL overrides).
- **Compat flags/dates and Text-module rules** copied per worker from today's
  wrangler.jsonc files (`allow_irrevocable_stub_storage`, `nodejs_als`/`nodejs_compat`,
  `global_fetch_strictly_public`, `enhanced_error_serialization`;
  `rules: [{ type: "Text", globs: ["**/*.txt", "**/*.svg"] }]`).
- **DO migrations**: full ordered history per worker (backend v0–v2, google v0–v3,
  etc.), derived from declared DO classes.
- **`PUBLIC_BASE_URL`**: `https://${domain}` when `domain` is set; otherwise the
  router's workers.dev URL, which alchemy can resolve *before* upload (account
  subdomain + deterministic worker name — same machinery as `Cloudflare.Worker.URL`),
  so the router→gatekeeper URL "cycle" never actually materializes.
- **Builds are memoized** via `Command.Build`'s content-hash `memo` (include each
  package's `src/**` + the shared packages it imports + the lockfile), so re-deploys
  with no changes skip straight through — same behavior as the release pipeline's
  content-addressed manifest, but for free from the alchemy engine.

## Package

New public package in this monorepo:

```
packages/alchemy/
├── package.json           name: "cloudflare-os"   (bikeshed below)
├── scripts/
│   └── fix-text-modules.mjs   post-build shim: .svg → .svg.txt Text modules
├── src/
│   ├── index.ts           exports OperatingSystem, Gatekeeper, Gatekeepers ns
│   ├── OperatingSystem.ts the composite + AI subtree + backend/router/frontend
│   ├── Gatekeeper.ts      GatekeeperDeployment union (packaged | worker) + helper
│   ├── gatekeepers/       one plugin module per built-in (google.ts, github.ts, …)
│   ├── wrangler.ts        wrangler.jsonc reader (the deploy contract, derived)
│   └── paths.ts           package-dir resolution (user project first, then own deps)
└── tsconfig.json
```

No other package in the monorepo is touched.

Caller extension points on `OperatingSystemProps` (driven by the starter repo's
needs): `backend.env` (extra backend bindings/vars), `backend.services` (service
bindings with named entrypoint + `ctx.props`, e.g. the starter's private
`ERROR_REPORTER`), and `frontend.env` (extra vite build env, e.g.
`VITE_FRONTEND_ERROR_REPORTING`).

- `alchemy` and `effect` are **peer dependencies**. The workspace packages
  (`@gadgets/workshop-backend` etc.) are regular dependencies so `main:` entrypoints
  and build scripts resolve from `node_modules` in the consumer's repo — this is what
  lets a company deploy *without forking cloudflare-os* and still ride `pnpm update`.
- The repo root also gets its own thin `alchemy.run.ts` (dogfood: deploys this repo's
  checkout, replacing the starter-repo flow for source users).

Name bikeshed (pick one):

| option | import | notes |
|---|---|---|
| `cloudflare-os` (recommended) | `from "cloudflare-os"` | matches the product name; cleanest |
| `@cloudflare/os` | `from "@cloudflare/os"` | needs the org scope; likely fine for CF |
| `@gadgets/alchemy` | `from "@gadgets/alchemy"` | matches current internal scope, but `@gadgets` reads as placeholder |

## Upstream punch list (alchemy) — verified against 2.0.0-beta.67

What the implementation confirmed, with the workaround each item ships with:

1. ~~**Named-entrypoint service bindings.**~~ **Landed upstream** as
   `Cloudflare.WorkerEntrypoint`
   ([alchemy#1097](https://github.com/alchemy-run/alchemy/pull/1097)): the
   composite now declares vendor bindings as plain typed `env` entries
   (`Backend/GATEKEEPER_*` rows), the router was moved ahead of the backend
   so `PUBLIC_BASE_URL` rides `env` too, and the router's own service
   bindings close the cycle via `bind`. Until a release ships, the repo
   consumes a **local build** through `pnpm-workspace.yaml` overrides
   (`file:` tarballs in `.alchemy-reference/` for alchemy + its
   not-yet-published `@distilled.cloud/*` deps) — drop the overrides block
   when the npm release lands. Still pending: **`props` on live uploads**
   (workerd `ctx.props`; `gatekeeper-context` reads `sharingDomain` from it)
   — typed and delivered in `alchemy dev`, dropped at encode on live
   deploys until the distilled `workers` Smithy patch adds the field.
2. **Wrangler-style Text module rules in bundle mode.** The rolldown plugin
   hardcodes Text = `.txt/.html/.sql`; every OAuth gatekeeper imports its logo
   `.svg` as a Text module. → make `WorkerProps.rules` feed the bundler (and
   add `.svg` to `contentTypeForModule`). *Workaround in place:
   `scripts/fix-text-modules.mjs` rewrites `.svg` imports to `.svg.txt` in the
   capnweb-validate output.*
3. **`Input<>` distribution over `WorkerAssetsConfig`.** Output-valued
   `directory`/`hash` fail structural matching against the assets union —
   `StaticSite` casts, and so does `OperatingSystem`. → fix the union's Input
   distribution.
4. **Binding-less hosted DO classes** (nice-to-have). All cloudflare-os DOs are
   reached via `ctx.exports`; the implementation declares a namespace binding
   per class (harmless, unused) purely to drive migrations. A
   `durableObjects: [...]` Worker prop would drop the fake bindings.
5. **`Command` should warn on shell syntax without `shell: true`.** A command
   like `a && b` without the `shell` prop is argv-parsed, so `&&` reaches the
   first program as a literal argument — the chain silently truncates to its
   first step and exits 0. The live e2e caught this as a baffling
   `OutputNotFound`; a warning (or shell auto-detection) when the command
   contains `&&`/`||`/`|`/`;` would kill the trap. *Fixed here by passing
   `shell: true` on every chained build.*
6. **Decorator lowering in the bundler.** capnweb-validate output uses TC39
   class decorators; wrangler's esbuild lowers them, but alchemy's rolldown
   emits them raw and workerd rejects the syntax
   (`ScriptStartupError: Invalid or unexpected token`). Enable oxc's
   decorator transform in the worker bundle pipeline. *Worked around here:
   `scripts/prepare-worker-tree.mjs` esbuild-transforms the validate tree in
   place (also handles the `.svg` Text rename), found by the live e2e.*
7. **`main` must be static at precreate.** Routing `main` through a build
   Output (for sequencing) crashes the precreate stub
   (`isPythonMain` reads an unresolved value). Either support Input `main`
   at precreate or document the pattern: keep `main` static and sequence
   builds through an env Output (`BUILD_HASH` here).
8. **Effect workers can't export custom named entrypoints.** The Effect
   virtual entry emits only the default entrypoint + DO/Workflow classes,
   so a pure Effect worker cannot satisfy a `GatekeeperVendor`-style named
   `WorkerEntrypoint` binding. Wanted: (a) arbitrary named-entrypoint
   exports on `Cloudflare.Worker`, and (b) longer-term, a capnweb↔Effect
   bridge — capability-passing RPC maps naturally onto Effect (stubs as
   Scope-managed resources). Until then, Effect-style gatekeepers use a
   hybrid entry: a plain `GatekeeperVendor extends WorkerEntrypoint` whose
   method bodies run Effect via a ManagedRuntime.

## Testing

Live end-to-end coverage lives at
`packages/alchemy/test/OperatingSystem.test.ts`, built on **alchemy's own
test harness** (`alchemy/Test/Vitest` — the published vitest adapter of the
`Test.make({ providers, state })` pattern from alchemy's AGENTS.md):

- `beforeAll(deploy(Stack))` deploys a full default OS (no domain, password
  auth, the default-on gatekeepers) to the real account; `afterAll(destroy)`
  tears it down (`NO_DESTROY=1` keeps it for iteration).
- Assertions ride alchemy's `getWhenReady` helper (retries through the
  workers.dev cold-start window, but lets deliberate 4xx through):
  `/` serves the SPA shell (router assets + vite build), `/api` answers
  non-5xx (router → backend service binding, backend booted with all
  bindings), `/gatekeeper/mcp/*` answers non-5xx (router → gatekeeper
  binding).
- Run with `pnpm --dir packages/alchemy test:e2e`. The script is
  deliberately `test:e2e` (not `test`) so the repo's recursive `pnpm test`
  never deploys to a real account by accident.
- Follow-up: drive the capnweb `PublicApi` over WebSocket (create an
  account, run a prompt) for true interaction coverage.

## Open questions

1. **Adoption of existing deployments.** Instances deployed via os.cloudflare.app or
   the starter repo have live DOs with migration tag history (`v0`…`vN`). Alchemy's
   `--adopt` covers resource ownership; migration-tag alignment on the first
   alchemy-managed PUT needs a test against a real legacy instance.
2. **`gatekeeper-slack` observability** is disabled today only because its
   wrangler.jsonc lacks the stanza. Proposal: normalize (observability on for all
   workers, one prop to opt out) rather than replicate the oversight.
3. **Ambient/admin config** (`AdminSettings` DO, provisioning policy) stays runtime
   state, not IaC — deliberately out of scope for `OperatingSystem`. Confirm.
4. **`alchemy dev`** — phase 2. The local provider system (workerd-backed
   `LocalWorkerProvider`) could eventually replace `run-dev-server.js`'s generated
   `wrangler.dev.jsonc` fleet with the same `OperatingSystem` resource running locally.
   Not in scope for the first cut, but the composite is designed so nothing blocks it.

## The starter repo (cloudflare-os-starter)

The starter's `deployment.jsonc` + `scripts/deploy.mjs` collapse into one
`alchemy.run.ts` (drafted in the local clone at
`~/workspaces/cloudflare-os-starter`, a separate repo needing its own commit):

- `packages/custom-gatekeeper/deploy.ts` — the third-party plugin template; the
  custom gatekeeper flows through the same `gatekeepers: [...]` list as built-ins.
- The private error reporter stays a caller-owned `Cloudflare.Worker`, bound via
  `backend.services` with `entrypoint: "ErrorReporter"` + `ctx.props`.
- Access-mode sign-in via `auth.access`; context pinned to
  `Context({ sharingDomain: "production" })`.
- Requires the submodule pin to include this repo's changes, plus
  `cloudflare-os/packages/*` in the starter's pnpm workspace (replacing the current
  two-package allowlist) and alchemy/effect devDependencies.
- Verified by typechecking an identical-shape stack against this repo's install
  (the two-repo symlink check double-loads alchemy and is not meaningful).

## Phasing

1. **Alchemy PRs**: entrypoint+props service bindings; binding-less DO classes.
2. **`packages/alchemy`**: `Gatekeeper` + `OperatingSystem` + presets; root
   `alchemy.run.ts`; deploy a real instance from this repo and diff the resulting
   worker settings against the golden manifest (`scripts/testdata/golden-manifest.json`).
3. **Consumer template**: a `create-cloudflare-os` style starter (or update the
   existing starter repo) whose entire content is `package.json` + `alchemy.run.ts` +
   `.env.example`.
