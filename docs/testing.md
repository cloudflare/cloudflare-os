# Running tests

Use this guide when running cold-checkout tests or investigating a slow or hung suite. For the
cross-Worker harness and its isolation rules, see [integration testing](integration-testing.md).

## Entry points

- `pnpm --filter <package> test:run`: the direct route, useful while iterating: Vitest, or `node --test`
  for `packages/api-cli`.
- `pnpm exec vp run -F <package> test`: cached task route; unchanged results may replay.
- `pnpm test`: workspace verification, including the `scripts/` and `packages/api-cli` suites, which
  run under `node --test` rather than Vitest.
- `pnpm lint`: lint, script types, generated-config checks, and workspace build/type-checks.

A direct `test:run` script does not execute a task's `dependsOn`. When tests import generated files,
both entrypoints must request codegen; verify without a root prebuild or prepared snapshot.

Backend unit tests use inline Miniflare bindings, not the full deployment configuration. Tests that
read admin settings, including through `authorizeWebFetch()`, must provide a `BLUEPRINTS.get` fixture;
returning `null` selects the default configuration. Assert async refusals with an awaited
`.rejects.toThrow(...)`, not a synchronous `.toThrow(...)`.

Workspace-restart integration tests must accept either a pending-restart refusal or an already-broken
RPC session. Match the pending-restart code or the same failure reported by that stub's `onRpcBroken()`,
not error wording or an arbitrary rejection. Assert that old capabilities return no data and a
replacement session re-verifies; do not race the transient error code against the scheduled abort.

For tests that advance time within a daily budget, pin the fake clock to a fixed UTC time before
seeding credentials and counters. Advancing from the wall clock can cross midnight and legitimately
reset the budget; test that rollover separately from cache expiry or limit enforcement.

Workshop's browser tests need Chromium installed once with
`pnpm --filter @gadgets/workshop-frontend exec playwright install chromium`.
Run them separately with `pnpm --filter @gadgets/workshop-frontend test:run:browser`.

## Watchdog policy

Shared test tasks use `scripts/with-timeout.ts`: 60 seconds without output and 600 seconds total.
Import-heavy backend unit tests use a 120-second idle allowance, and the `workshop-evals` unit tests
a 240-second one: `evals/chat-views.test.ts` reports only when it ends, and took 114 seconds on
CI on 2026-11-09. These process-level watchdogs are separate from Vitest's per-test limits and
Linux Container execution deadlines. Google test projects allow 15 seconds per test.

For a slow container or CI runner, explicitly override both bounds rather than changing local
defaults:

```sh
TESTS_WITH_TIMEOUT_IDLE_SECONDS=1800 TESTS_WITH_TIMEOUT_MAX_SECONDS=1800 pnpm test
```

Each override accepts positive, finite seconds and supersedes its corresponding command-line
threshold. An omitted override retains that command's default; malformed values fail before the
command starts. Cached tasks forward and fingerprint the overrides, so results from a different
policy are not reused. The direct Vitest route does not use this shared watchdog.

`TESTS_WITH_TIMEOUT_DISABLE=1` retains its existing meaning: disable both watchdogs, not process
cleanup. Prefer bounded overrides; disable only when an outer job or operator supplies the bound.
A timeout exits 124 and names the idle/total limit, command, and surviving process tree. Exit 137
alone does not prove OOM; inspect the primary failure and available memory diagnostics.

## Workerd and resource pressure

The root test launcher computes task concurrency and a Vitest worker budget in
`scripts/vp/concurrency.ts`. Workerd fleets can dominate memory usage; avoid simultaneously running
independent workspace-wide test launchers. Set `VITEST_MAX_WORKERS` for direct Vitest runs when
needed; cached tasks forward it without changing the result fingerprint.

Do not remove `scripts/assert-workerd.ts` from suites that require workerd: it prevents a failed
pool from appearing to pass under Node. On a Mac, prevent idle sleep for the duration of a benchmark
(`caffeinate -is <command>`) before interpreting wall-clock timeout results.

## Local instances

- `pnpm run-local --port <n>` serves the built frontend from the backend's own origin, so it runs
  beside another checkout's servers with nothing on :3000, and connect handoffs follow the port.
  It builds the frontend first and has no hot reload. For UI work, run
  `PUBLIC_BASE_URL=http://localhost:<m> pnpm dev-server --port <n>` and
  `VITE_BACKEND_HOST=localhost:<n> pnpm --filter @gadgets/workshop-frontend exec vite --port <m> --strictPort`.
- Point `pnpm cf-os api` at it with `CFOS_API_URL=http://localhost:<n>`; it defaults to :8787.
- A repo-root `.dev.vars` is loaded automatically; values already in the shell win.
- AI Gateway mode needs `CF_AI_GATEWAY`, `CF_AI_GATEWAY_ACCOUNT_ID`, `CF_AI_GATEWAY_PROVIDERS`
  (`cloudflare` for `@cf/*` models) and a transport: `--use-workers-ai-binding`, which needs a
  Wrangler login (set `CLOUDFLARE_ACCOUNT_ID` if it has several accounts), or
  `CF_AI_GATEWAY_API_TOKEN` with `CF_AI_GATEWAY_USE_BINDING=false`. `google` always needs the token.
  Listing models and changing admin model settings send nothing to the gateway, so placeholder
  values are enough for them.
- workshop-backend's `test:run` runs Vitest twice, unit then integration, so a file argument only
  reaches the integration run. For one unit file, run the script's two build steps, then
  `pnpm exec vitest run <file>` in `packages/workshop-backend`.
- To see what a request sent to a model, read the AI Gateway logs, or add a temporary log in the
  payload hook (`onPayload` in `ai-models.ts`) and revert it before committing.
