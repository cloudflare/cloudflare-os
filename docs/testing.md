# Running tests

Use this guide when running cold-checkout tests or investigating a slow or hung suite. For the
cross-Worker harness and its isolation rules, see [integration testing](integration-testing.md).

## Entry points

- `pnpm --filter <package> test:run`: direct Vitest route, useful while iterating.
- `pnpm exec vp run -F <package> test`: cached task route; unchanged results may replay.
- `pnpm test`: workspace verification, including `scripts/` suites under `node --test`.
- `pnpm lint`: lint, script types, generated-config checks, and workspace build/type-checks.

A direct `test:run` script does not execute a task's `dependsOn`. When tests import generated files,
both entrypoints must request codegen; verify without a root prebuild or prepared snapshot.

Workshop's browser tests need Chromium installed once with
`pnpm --filter @gadgets/workshop-frontend exec playwright install chromium`.
Run them separately with `pnpm --filter @gadgets/workshop-frontend test:run:browser`.

## Watchdog policy

Shared test tasks use `scripts/with-timeout.ts`: 60 seconds without output and 600 seconds total.
Import-heavy backend unit tests use a 120-second idle allowance. These process-level watchdogs are
separate from Vitest's per-test limits and Linux Container execution deadlines. Google test
projects allow 15 seconds per test.

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
