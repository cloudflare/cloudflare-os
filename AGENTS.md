This project is building a platform for "vibe coded" personal applications and AI agents that run inside a strong sandbox.

The following files are commonly important to reference:

* packages/workshop-shared/node_modules/capnweb/README.md: Explains how to use Cap'n Web RPC, which is used extensively for client-server communications.
* packages/workshop-shared/src/api.ts: Defines the RPC API used between the frontend and backend.

The project structure is:

* packages/workshop-frontend: The Gadgets Workshop UI.
    * This is a pure single-page app, running entirely client-side.
    * It speaks to the backend using an RPC API over a persistent WebSocket connection.
    * Uses React, Kumo UI (https://kumo-ui.com/api/component-registry), Phosphor icons, and Vite.
* packages/workshop-backend: The Gadgets Workshop server.
    * Runs on Cloudflare Workers.
    * This is the **kernel**: it defines the architecture and is held to a higher bar than UI/gatekeeper code. Reviewers read *every line* of `workshop-backend` and of API changes in `workshop-shared`, so keep diffs here small and elegant. Concretely: doc-comment **every** exported member of the `workshop-shared` public API (types, consts, and functions — not just interfaces); never introduce a hand-written interface that mirrors an RPC interface plus an `as unknown as` cast (derive from the real type instead, or rethink the design); and prefer reusing existing mechanisms over adding parallel ones. Capability-based security note: a resource becomes "ambient" (auto-injected) only by user/admin configuration — a gatekeeper must never assert its own ambience. When a change to this package is large, split it by concern into separate PRs (and at minimum group commits so `workshop-backend`/`workshop-shared` can be reviewed apart from UI), since fewer kernel lines = easier review.
    * `format-blueprints/` holds the **output format** blueprints the deployment ships with, committed as data: a `<name>.gadget` archive plus a `<name>.json` sidecar giving its `blueprintId`, prose, and `output` presentation. `scripts/build-format-blueprints.mjs` globs that directory (override with `FORMAT_BLUEPRINTS_DIR`, which lets a fork ship its own set without touching this submodule) into the gitignored `src/generated/format-blueprints.ts`, so `build` and `test` both run the generator first (it rewrites the module only when the content changes, so the repeat invocations don't invalidate the downstream task cache). Replace one with `pnpm import:format-blueprint <export.gadget> <blueprintId>`, or add one with `pnpm import:format-blueprint <export.gadget> --new <name>`; never edit a `blueprintId` after deploy, since the install and promotion are keyed on it and a rename orphans the old entry. See `format-blueprints/README.md`.
* packages/workshop-shared: Shared API definitions between client and server.
    * This defines the application's RPC interface.
    * The RPC protocol is Cap'n Web, which has similar semantics to Cloudflare's Worker-to-Worker RPC system, while being able to run in a browser over WebSocket. Read the readme for details.
* packages/configurator-ui: Type-only component helpers used by optional gatekeeper resource configurator UI modules.
    * Gatekeeper configurator UI modules are compiled by `scripts/build-gatekeeper-configurator.mjs` as part of package builds.
* packages/gatekeeper-*: Gatekeeper workers for external service integrations.
    * Each gatekeeper runs as a separate Cloudflare Worker.
    * Gatekeepers handle OAuth flows and provide sandboxed access to external APIs.
    * A gatekeeper may declare `VendorDescription.autoProvisionsAccount`: it can mint a connected account with no OAuth flow (via `GatekeeperVendor.createAccount()`, which takes no user identity). For such gatekeepers the deployment admin picks a per-vendor mode in the admin Gatekeepers panel — **disabled** / **optional** / **enabled** (default **optional**) — resolved in `provisioning-policy.ts`: `enabled` auto-provisions the account for every user (forced, and hidden from the Connectors list), `optional` lets each user opt in from the Connectors page, and `disabled` offers it to no one (existing accounts go dormant). The Workshop persists the account in the user DO like any connected account (the account capability — not an asserted identity — is the authority thereafter). The **account** (a `GatekeeperUser`) declares in its `AccountDescription` whether it provides an agent **singleton** (`singleton: { tsType }`) and/or a **management UI** (`providesUi`). The Workshop auto-provides the singleton to the owner's workspaces as an **ambient gatekeeper record**, folded into each chat's env as a **named chat binding** (named by the gatekeeper's `suggestedBindingName`; see `prepareChatBindings` in overseer.ts) that the agent reads in `executeCode` (`getSession`/`getAgentCatalog`), each read recorded as an observation. It is not bound to any gadget by default — most gadgets never call it programmatically — but the agent may wire it into a gadget's binding list with `setGadgetBinding` when the gadget's persistent code needs it. The UI is hosted at `/gatekeepers/$appId` (the gatekeeper's vendor id, e.g. `/gatekeepers/context`) via `startAppUi({ isAdmin })`. The two are orthogonal — an account can declare either, both, or neither.
* packages/mcp-shared: Shared implementation behind the two MCP gatekeepers — `gatekeeper-mcp` (endpoints a user pastes) and `gatekeeper-mcp-portal` (one admin-configured portal). Not a Worker; a library both import, holding the MCP client, the OAuth chain, the account DO base, the resource-URL scope grammar, and the queued-action store. See `packages/mcp-shared/README.md` and each connector's README.
    * The trust boundary is `tools.ts`, and nothing outside it reads a tool's annotations: a tool the server declares `readOnlyHint: true` runs as an observation, everything else is queued for approval, and auto-*applying* a write additionally requires a `vetted` endpoint — which only the portal can produce, via `MCP_PORTAL_TRUST_ANNOTATIONS`.
    * OAuth uses the official `@modelcontextprotocol/client`; always give SDK OAuth operations `sdkFetch(...)` so every request and redirect retains endpoint and SSRF checks.
* packages/gatekeeper-context: The Context Library — a gatekeeper whose account provides a singleton read session + a management UI, for authoring collections of context documents that agents read as observations. Collections have one of two visibilities: **private** (owned by a single account, readable/writable only by that account) and **public** (created/edited only by deployment admins, readable by everyone and auto-enabled for all users). It owns its state in three Durable Objects (`ContextCollectionDurableObject` for content, `UserLibraryDurableObject` for each account's own private collections, `LibraryRegistryDurableObject` for the domain's public set) plus a KV namespace. All data is namespaced by a `sharingDomain` (from the binding's props, see `domain.ts`) so multiple workshops sharing one gatekeeper instance stay isolated.
    * Its `GatekeeperVendor` entrypoint (bound as `GATEKEEPER_CONTEXT`) declares `autoProvisionsAccount` and mints a `ContextAccount` via `createAccount()` (no user identity is passed in; the account keys its private data by its own generated `accountId`). The account exposes the agent read session (`getSession()`), collection discovery metadata (`getAgentCatalog()`), and a management UI (`startAppUi({ isAdmin })`). The UI is a single-file React SPA in `app/` (Vite + Tailwind + Kumo) bundled by `build-app.mjs` into `src/generated/app.txt`.
* packages/gatekeeper-scheduler: Scheduled Tasks — an auto-provisioned gatekeeper whose account provides an ambient singleton for registering persistent workspace callbacks plus a read-only management UI. One account-scoped `ScheduleDriver` Durable Object stores enabled schedules and delivers them from a shared alarm; hook enablement remains in the Workshop Connections UI.
* packages/router: The public origin of a deployed gadgets instance. Serves the workshop-frontend assets and routes by path prefix: `/api/*` and `/blueprint-screenshot/*` to the workshop backend, `/gatekeeper/<name>/*` to whichever gatekeepers are bound (discovered by scanning its own `GATEKEEPER_*` service bindings, so installing a gatekeeper is purely a binding change). The same worker doubles as the dev router (`pnpm dev-server`): with no `ASSETS` binding it proxies frontend requests to the Vite dev server instead.

Deployment admin settings (the `/admin` panel) follow a few conventions worth knowing when extending them:

* `packages/workshop-backend/src/admin-config.ts` defines `AdminConfig` — the deployment's "soft" customizations: agent instructions, banners/theme, and which gatekeeper connectors/resources are offered (plus the three-state mode for auto-provisioning gatekeepers, see `provisioning-policy.ts`). Connectors/resources default to enabled and the admin UI opts them *out*; auto-provisioning gatekeepers default to *optional*. **Authentication/authorization config (sign-in providers via `AUTH_GATEKEEPERS`, password login via `DISABLE_PASSWORD_AUTH`) is deliberately NOT here** — it stays env-var driven (`auth/config.ts`) so it can't be changed by a compromised admin session.
* The `AdminSettings` durable object owns the authoritative `AdminConfig` and mirrors it to a single reserved KV key (`.adminConfig`, see `isReservedBlueprintKey()`), so hot-path code (connect/agent) reads it with one cheap KV get via `readAdminConfig(env)`. The DO is the only writer (`updateAdminConfig(patch)`).
* Admin operations are exposed as an `AdminApi` capability obtained via `AuthenticatedApi.getAdminApi()` (returns null for non-admins). The `#isAdmin()` check happens once when the capability is minted, so the individual methods don't re-check.
* `user.ts:getGatekeeperClassFor()` is the single core chokepoint where disabled gatekeepers/resources are enforced before a capability is minted (gadget/agent code can't reach it directly).

Release pipeline (`scripts/release/`) — how customer instances get deployed:

* `build-release.mjs` bundles every deployable worker byte-identically (wrangler dry-run with the pinned wrangler), builds the Access-mode frontend asset build, and generates the release manifest — the contract between this repo's CI and the deploy service, produced by `manifest-lib.mjs` from each package's wrangler.jsonc with account-specific values replaced by placeholders (`$ACCOUNT_ID`, `$WORKER_NAME(...)`, `$SECRET(...)`, `$PUBLIC_BASE_URL`, ...).
* `upload-release.mjs` mirrors the release to R2 content-addressed, manifest last; with `--candidate` the manifest lands under `candidates/<id>/` (invisible to the deploy service) so e2e can verify it, and `promote-release.mjs` then copies it to `releases/<id>/` — publishing is that single all-or-nothing manifest copy. The copy is not isolated against concurrent promotions, so CI serializes promote runs (a GitLab resource group) and the script's newer-release guard skips candidates that a later release has already superseded.
* The manifest is covered by a golden-file test; after an intentional manifest change, regenerate with `UPDATE_GOLDEN=1 node --test scripts/release-manifest.test.js` and review the golden diff.
* Running the flow by hand (upload and promote need `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`):
    * `node scripts/release/build-release.mjs --out release-out` — build everything into `release-out/` (id defaults to `r<CI_PIPELINE_IID>-<sha7>` in CI, `dev-<timestamp>` locally; override with `--release-id <id>`).
    * `node scripts/release/upload-release.mjs --release release-out --candidate` — mirror to R2; omit `--candidate` to publish directly (bypasses the gate — CI never does this).
    * `node scripts/release/promote-release.mjs --release-id <id>` — copy the verified candidate's manifest into `releases/<id>/`.
* Deploy-wizard configuration: an installable gatekeeper's user-supplied inputs default to OAuth `CLIENT_ID`/`CLIENT_SECRET` secrets; a per-package `deploy-inputs.json` overrides them, and `NO_DEFAULT_CRED_INPUTS` in `manifest-lib.mjs` opts out gatekeepers that take no third-party OAuth app credentials (the wizard blocks Install on unfilled secret inputs, so a spurious default makes a gatekeeper uninstallable). Backend instance-state vars (`ADMINS`, `DEPLOY_URL`, ...) are injected by the deploy service at PUT time, never manifest-templated.

To test changes:
- Run `pnpm build` (optionally narrowed to a particular package) to run TypeScript type checks. It is a type check and codegen pass, not a compile: every package but `typed-storage` is `noEmit`, because nothing imports the others' `dist` — wrangler and vite bundle from source. `typed-storage` still emits because its `exports` resolves to `dist/index.js`. A re-run with nothing changed is much cheaper than the first, because Vite+ replays it from the task cache — see below.
- Run `pnpm test` to run unit tests, though as of this writing most packages don't have tests yet.
- `pnpm build`, `pnpm test` and `pnpm clean` are `vp run -r <task>`, not `pnpm run --recursive <task>`. Vite+ runs the same per-package scripts, in dependency order, but caches each one against its inputs, so an unchanged package replays its previous output instead of re-running. Commands joined with `&&` are cached as separate entries, so a package whose codegen is fresh can still re-run its `tsc`. `vp run --last-details` explains every hit and miss, which is the thing to read when a build is slower than expected. Don't reintroduce a root script that calls `pnpm run --recursive`: `vp run -r` selects the root package too, and would run it as a task and rebuild the whole workspace a second time.
- Caching is off for tasks that read a path they also write, which is why the three `vite build` SPA bundles never cache. Tests mostly don't cache either, for the same reason. This is also why no tsconfig sets `incremental`: `tsc` reads its own `.tsbuildinfo` and writes it back, which takes the whole type check out of the task cache to save less than the cache does (measured: 2% hits and 21.1s on a clean tree, against 65% and 13.4s without it). Don't add it back without re-measuring `vp run --last-details`.
- The five packages whose tests run in workerd (`router`, `typed-storage`, `backend-utils`, `workshop-backend`, `gatekeeper-scheduler`) load `test-setup/assert-workerd.ts` as a `setupFiles` entry. It throws unless `navigator.userAgent` is `Cloudflare-Workers`, so a `@cloudflare/vitest-pool-workers` pool that fails to start fails the suite instead of silently falling back to Node — which otherwise looks like a pass in the packages that import no `cloudflare:*` module. Don't remove it to make a suite green.

Linting (oxlint, via Vite+):
- `pnpm lint` runs what CI enforces: `lint:check` (oxlint) and `types:check`. Run this before pushing.
- Individual scripts:
    * `pnpm lint:check` / `pnpm lint:fix` — `vp lint`, i.e. oxlint driven by Vite+ (rules in the `lint` block of the root `vite.config.ts`; `correctness` + `suspicious` as errors). Vite+ pins the oxlint it runs (1.76.0), so there is no separate `oxlint` dependency to drift from it and no `.oxlintrc.json` beside the config — one toolchain config, one version. Diagnostics are identical to what running that oxlint directly would emit.
    * `pnpm types:check` — an alias for `pnpm build`. They were separate scripts running the same recursive `tsc` twice; one name is kept for habit and the other because the codegen prerequisites hang off it. `vp lint` is not part of `vp run`, so it has no task cache; it takes about a second regardless.
- Unused function parameters and caught errors are not lint-enforced; unused imports and local variables are still errors.
- Some rules are kept as warnings (e.g. `no-shadow`) for incremental cleanup; warnings don't block CI.
- Type-aware oxlint rules are intentionally not enabled. The type-aware engine (tsgo) drops `baseUrl`, which all 21 backend tsconfigs use for this monorepo's cross-package source imports. (It also requires an explicit `rootDir` under declaration emit — no longer a factor now that only `typed-storage` emits, which is what makes revisiting this worthwhile rather than hopeless.) Among other things this means `no-floating-promises` is not enforced — which is just as well, since RPC promise pipelining (below) intentionally leaves promises unawaited. Type safety is still enforced by `tsc` through `pnpm types:check` and `pnpm build`.

IMPORTANT: This repository uses pnpm, not npm. Always use pnpm.

IMPORTANT: Remember when using RPC to use promise pipelining whenever possible. Cap'n Web implements promise pipelining (similar to Cap'n Proto). This means that if an RPC returns a stub, it's not necessary to await the RPC -- the promise itself can be used in place of the stub. Also, Cap'n Web lets you use the promise for a future result (even if it isn't a stub) in the arguments for another call; the promise will be replaced with its resolution on the server side before delivering the arguments. See the Cap'n Web README.md for more details.

IMPORTANT: When using React's useState(), the state value cannot be an RPC stub. At runtime, all stubs appear to be callable (because the system doesn't actually know if the stub points to a function on the server side or not). But the setter returned by useState() has different behavior if passed a function (including any callable object): it calls the function in order to get the state. In order to avoid this problem, whenever a useState() state will contain an RpcStub, it's important to wrap the stub in an object, and set the state to that object instead.

IMPORTANT: RPC stubs must be disposed to prevent resource leaks on the server side. Call `stub[Symbol.dispose]()` when the stub is no longer needed (or use a `using` declaration where possible). In particular, when a React component obtains a stub in a useEffect, the cleanup function should dispose the stub.

IMPORTANT: Server-side logging uses `@gadgets/backend-utils/logger` (frontend browser `console.*` is out of scope):
- Define a package-owned field type and module-scoped logger with a stable dot-separated `component`
  and, for gatekeepers, `vendorId`:
  `const logger = createLogger<GitHubLogFields>({ component: "gatekeeper.github", vendorId: VENDOR_ID });`.
- Emit concrete event names and relevant typed fields, for example:
  `logger.warn("failed to notify credential expiry", { event: "credentials.expiry.notify.failed", error: err });`.
  Each call emits one indexed object; module/child fields such as `vendorId` are inherited.
- Use immutable `logger.with(fields)` for object-owned or nearby context. Prefer module/object loggers
  over logger parameters, and do not replace a shallow child logger with ambient context just to
  remove a local variable.
- For bounded operation context needed by deep helpers, independent loggers, or other observability
  consumers, use `createObservabilityContext` from `@gadgets/backend-utils/observability-context`.
  Re-establish it per operation;
  it does not cross RPC, hibernation, or restart, and requires `nodejs_als` or `nodejs_compat`.
- Pass caught values as `error`. The helper stringifies `Error` instances and primitives, uses an
  own string `message` for plain objects, omits `undefined`, and adds stacks to all `Error` logs.
  Keep this normalization deliberately small; do not traverse causes or copy arbitrary properties.
- Extend field vocabularies locally. Levels: `error` needs attention, `warn` continues best-effort,
  `info` is notable lifecycle, and `debug` is noisy breadcrumbs. Never log secrets, prompts, headers,
  tokens, or request/response bodies.
- To also dispatch a failure to the optional external issue Reporter (in addition to logging it),
  call `reportIssue(failureSite, caught, options?)` from
  `@gadgets/backend-utils/error-reporting`. Attach ambient fields from the package's observability
  context and augment them with capture-site fields:
  `reportIssue("overseer.catalog-fallback", err, { handled: true, attributes: { ...obsContext.get(), gatekeeperId } });`.
  It is a no-op when the `ERROR_REPORTER` binding is absent (local dev / deployments without an issue
  destination). Only bounded scalars are retained as attributes; reported context obeys the same
  no-secrets rules as log fields.

IMPORTANT: Frontend error reporting is a separate, opt-in path:
- `@gadgets/error-reporting` owns the vendor-neutral browser/Worker event contract and tolerant,
  bounded normalization. `VITE_FRONTEND_ERROR_REPORTING=true` enables trusted frontend producers
  and their hidden source maps at build time; deployments without reporting should leave it unset.
- The Workshop browser sends best-effort reports to the same-origin `POST /api/client-errors`
  endpoint. The backend dispatches only when both `FRONTEND_ERROR_REPORTER` and
  `FRONTEND_ERROR_RATE_LIMITER` are bound; otherwise the endpoint is an intentional no-op.
- Gatekeeper management/configurator UIs run as Workshop-owned opaque-origin `srcDoc` frames. They
  send bounded reports with `postMessage`; the host accepts them only from the known frame window
  with origin `null`, adds host-owned surface/vendor context, and performs the same-origin POST.
  Do not add direct cross-origin reporting from a gatekeeper Worker domain.
- Frontend reports and frame metadata are diagnostic only and never convey identity or authority.
  Install automatic capture only in trusted first-party surfaces, never gadget/user-authored code.
  Exception messages and stacks reach the external Reporter, so never intentionally put secrets,
  prompts, tokens, headers, or request/response bodies in thrown errors or report metadata.
