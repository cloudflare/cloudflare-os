This project is building a platform for "vibe coded" personal applications and AI agents that run inside a strong sandbox.

The following files are commonly important to reference:

* packages/workshop-shared/node_modules/capnweb/README.md: Explains how to use Cap'n Web RPC, which is used extensively for client-server communications.
* packages/workshop-shared/src/api.ts: Defines the RPC API used between the frontend and backend.

## Package guides

Each of these holds rules this file does not repeat. Read the matching guide before changing,
reviewing or answering questions about code under its directory:

| Guide | Read for |
|---|---|
| `packages/workshop-backend/AGENTS.md` | the kernel: bundled blueprints, agent tracing, auto-provisioned gatekeepers, admin settings |
| `packages/workshop-frontend/AGENTS.md` | Workshop UI structure, components, styling, tests |
| `packages/ui/AGENTS.md` | shared React UI ownership |
| `packages/configurator-ui/AGENTS.md` | configurator frames, their runtime and build |
| `packages/gatekeeper-kit/AGENTS.md` | the shared gatekeeper library |
| `packages/gatekeeper-context/AGENTS.md` | Context Library collections and sharing |
| `packages/gatekeeper-cloudflare/AGENTS.md` | Cloudflare OAuth, billing, Workers Observability |
| `packages/gatekeeper-x/AGENTS.md` | X, whose reads are billed |
| `packages/gatekeeper-microsoft/AGENTS.md` | Microsoft 365: SharePoint, Outlook, Calendar |
| `packages/gatekeeper-websearch/AGENTS.md` | Web Search |
| `packages/mcp-shared/AGENTS.md` | MCP / MCP Server Portal gatekeepers |
| `packages/observability/AGENTS.md` | server logging, issue reporting, metrics |
| `packages/error-reporting/AGENTS.md` | frontend error reporting |
| `scripts/release/AGENTS.md` | the release pipeline and deploy-wizard inputs |

Reviewing a pull request: follow `REVIEW.md` as well.

## Packages

* packages/workshop-frontend: The Gadgets Workshop UI, a pure client-side single-page app (React, Kumo UI (https://kumo-ui.com/api/component-registry), Phosphor icons, Vite) that speaks to the backend over a persistent WebSocket RPC connection.
* packages/workshop-backend: The Gadgets Workshop server, on Cloudflare Workers. This is the **kernel** (see below).
* packages/workshop-shared: The application's RPC interface, shared by client and server. The protocol is Cap'n Web, which has similar semantics to Cloudflare's Worker-to-Worker RPC while being able to run in a browser over WebSocket.
* packages/bundled-blueprints: The blueprints the deployment ships with; `blueprints/<name>/` holds each blueprint's `blueprint.json` plus its gadget code under `files/`, which may be TypeScript.
* packages/configurator-ui: The authoring API, sandbox runtime and build for gatekeeper resource configurator UI frames.
* packages/ui: Shared runtime React UI used across the Workshop and gatekeeper management apps.
* packages/gatekeeper-*: Gatekeeper workers for external service integrations. Scheduled Tasks (`gatekeeper-scheduler`) and GitLab (`gatekeeper-gitlab`, design record `plans/gitlab-gatekeeper.md`) are described in their READMEs.
* packages/mcp-shared: The library behind the two MCP gatekeepers, `gatekeeper-mcp` and `gatekeeper-mcp-portal`.
* packages/observability, packages/error-reporting: Server logging/issue reporting/metrics, and the opt-in frontend error-reporting contract.
* packages/router: The public origin of a deployed instance. Serves the workshop-frontend assets and routes `/api/*` and `/blueprint-screenshot/*` to the backend and `/gatekeeper/<name>/*` to whichever `GATEKEEPER_*` service bindings it has; with no `ASSETS` binding it doubles as the dev router (`pnpm dev-server`), proxying the frontend to Vite.

## The kernel

`workshop-backend` defines the architecture and is held to a higher bar than UI/gatekeeper code. Reviewers read *every line* of `workshop-backend` and of API changes in `workshop-shared`, so keep diffs here small and elegant. Concretely: doc-comment **every** exported member of the `workshop-shared` public API (types, consts, and functions — not just interfaces); never introduce a hand-written interface that mirrors an RPC interface plus an `as unknown as` cast (derive from the real type instead, or rethink the design); and prefer reusing existing mechanisms over adding parallel ones. Capability-based security note: a resource becomes "ambient" (auto-injected) only by user/admin configuration — a gatekeeper must never assert its own ambience. When a change to this package is large, split it by concern into separate PRs (and at minimum group commits so `workshop-backend`/`workshop-shared` can be reviewed apart from UI), since fewer kernel lines = easier review.

## Cap'n Web RPC

IMPORTANT: Remember when using RPC to use promise pipelining whenever possible. Cap'n Web implements promise pipelining (similar to Cap'n Proto). This means that if an RPC returns a stub, it's not necessary to await the RPC -- the promise itself can be used in place of the stub. Also, Cap'n Web lets you use the promise for a future result (even if it isn't a stub) in the arguments for another call; the promise will be replaced with its resolution on the server side before delivering the arguments. See the Cap'n Web README.md for more details.

IMPORTANT: When using React's useState(), the state value cannot be an RPC stub. At runtime, all stubs appear to be callable (because the system doesn't actually know if the stub points to a function on the server side or not). But the setter returned by useState() has different behavior if passed a function (including any callable object): it calls the function in order to get the state. In order to avoid this problem, whenever a useState() state will contain an RpcStub, it's important to wrap the stub in an object, and set the state to that object instead.

IMPORTANT: RPC stubs must be disposed to prevent resource leaks on the server side. Call `stub[Symbol.dispose]()` when the stub is no longer needed (or use a `using` declaration where possible). In particular, when a React component obtains a stub in a useEffect, the cleanup function should dispose the stub.

IMPORTANT: All RPC interface implementations should use the annotation `@validateRpc()` to apply capnweb-validate, which installs auto-generated runtime type validation matching the interface's TypeScript signatures. Do not write redundant validation code that duplicates the checks capnweb-validate already covers.

## Gatekeepers

* Each gatekeeper runs as a separate Cloudflare Worker, except that a `gatekeeper-*` package with **no `wrangler.jsonc` is a library, not a worker** (`gatekeeper-kit` here; `gatekeeper-shared` in the internal repo). Deployable discovery is config-gated, not name-gated — `readDeployablePackages` in `scripts/release/manifest-lib.ts` keys solely on the presence of `wrangler.jsonc`, and `run-dev-server.ts` requires it too — so adding one to a library package makes it deployable, at which point `workerKind` would classify it a gatekeeper by prefix and the deploy wizard would demand `CLIENT_ID`/`CLIENT_SECRET` for it. `manifest-lib.test.ts` fails first if that ever happens.
* Gatekeepers handle OAuth flows and provide sandboxed access to external APIs. A connect URL is a bearer capability, so every connect/reconnect flow ends on the kit's `connectHandoffPageHtml`, which sends the popup to the Workshop's `/connect/handoff` page, and that page redeems the single-use ticket over the popup's own session together with a per-flow nonce (see `docs/connect-handoff.md`); a reconnect stages its new credentials via `gatekeeper-kit/credential-stage` until the Workshop calls `GatekeeperUser.commitReconnect(stageId)` with the id that completion reported; completion is confirmed through the ticket, never through the URL alone.
* A gatekeeper that declares `VendorDescription.autoProvisionsAccount` mints accounts with no OAuth flow, under a per-vendor mode the deployment admin picks; its account may provide an ambient agent singleton and/or a management UI. See `packages/workshop-backend/AGENTS.md`.
* Writing or reviewing a gatekeeper: load the `write-gatekeeper` skill (`.agents/skills/write-gatekeeper/SKILL.md`).

## Frontend

IMPORTANT: Load the `frontend-conventions` skill (`.agents/skills/frontend-conventions/SKILL.md`) before creating, materially changing, moving, or reviewing React frontend code anywhere under `packages/`, and consult the installed Kumo API (`npx @cloudflare/kumo docs <Component>`) before implementing or changing Kumo UI. `packages/workshop-frontend/AGENTS.md` has the long form.

## Server logging

IMPORTANT: Server code logs through `@gadgets/observability/logger` with a module-scoped logger, a stable dot-separated `component` (plus `vendorId` for gatekeepers), and concrete `event` names. Pass caught values as `error`. Never log secrets, prompts, headers, tokens, or request/response bodies. The full rules, issue reporting and metrics are in `packages/observability/AGENTS.md`; frontend error reporting is in `packages/error-reporting/AGENTS.md`.

## Worker configs

Each Worker's `cloudflare.config.ts` (`@cloudflare/config` format, built from the shared factory in `scripts/worker-config.ts`) is the source of truth. The `wrangler.jsonc` beside it is committed but generated by `pnpm configs:generate` (`scripts/generate-worker-configs.ts`) and never edited by hand, because Wrangler's new-config support cannot drive the multi-worker dev server, `wrangler types`, the vitest pools or the integration harness. Settings `@cloudflare/config` has no field for (`build`, module `rules`, KV `preview_id`, `assets.directory`) go in the config's `wrangler` export, and Durable Object migrations stay tagged in its `migrations` export, because the release manifest ships them to the deploy service verbatim. `pnpm configs:check` (part of `pnpm lint` and CI) fails on a stale or hand-written file; `pnpm dev-server` regenerates before starting.

## Development checks

IMPORTANT: This repository uses pnpm, not npm. Always use pnpm.

- Run `pnpm lint` before pushing; it includes script types, generated-config checks, and the workspace build.
- `pnpm build` runs type-checks and codegen. For one package use `pnpm exec vp run -F <package> build`; most builds are tasks, not package.json scripts.
- Use `pnpm --filter <package> test:run` while iterating and `pnpm test` for workspace verification. Cached tasks may replay results; cold-checkout tests must generate their own prerequisites on both entrypoints.
- Cached Vite+ tasks strip undeclared environment variables. Declare output-affecting variables in `cache.env`; a path value does not fingerprint the external files it names.
- For slow CI/container runs, keep the local watchdog defaults and explicitly choose longer limits. See [testing guidance](docs/testing.md) for commands and timeout policy.
- Read [build-system guidance](docs/build-system.md) when changing task graphs, codegen, caching, or dev-server startup; [integration testing](docs/integration-testing.md) covers the workerd harness.
