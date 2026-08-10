# Testing strategy

The suite has one job above all others: **make cherry-picking upstream changes safe.** Upstream
tests against Cloudflare's platform; we ship standalone workerd. That gap is the top platform risk
in [`plans/fieldos.md`](../plans/fieldos.md), and a test suite that runs on the wrong runtime does
not close it.

## Four tiers

| Tier | What | Runtime | Cost | Runs |
|---|---|---|---|---|
| 0 | Unit and in-isolate | vitest, some under miniflare | already in `pnpm test` | pre-commit, PR |
| 1 | **workerd-contract** — hand-written capnp fixtures | **real pinned workerd** | ~0.7s today | PR + **cherry-pick gate** |
| 2 | **workerd-stack** — 2–3 workers via `wrangler --dry-run` | **real pinned workerd** | ~6–10s | merge + **cherry-pick gate** |
| 3 | **workerd-full** — all 9 workers via `run-workerd.mjs` | **real pinned workerd** | ~24s | nightly, pre-release |

Only tiers 1 and 2 are new. Tier 1 already exists in miniature as
`packages/fieldos-runtime/__tests__/workerd.test.js` — spawn the pinned binary against a fixture
capnp, drive real bindings, `SIGKILL` and re-read. That pattern generalizes.

**Tier 0 is not a parity signal.** `workshop-backend` runs under `@cloudflare/vitest-pool-workers`,
which is miniflare — *Cloudflare's* runtime. It is good coverage of logic and proves nothing about
the runtime we ship. Do not let a green Tier 0 stand in for parity.

### Measured costs, not estimates

Bundling is **linear in worker count**, which is what makes Tier 2 affordable: `workshop-backend`
2.7s, `router` 0.9s, one gatekeeper ~1.5s — against 24s for all nine. There is **no incremental
caching** (a warm rerun measured the same 24s), so Tier 3 cannot be cheapened and belongs nightly.
"Full stack or nothing" was a false dichotomy.

## The cherry-pick gate

The highest-value output. A human runs:

```sh
git cherry-pick -x <upstream-sha>
pnpm gate
```

`pnpm gate` must pass, all of:

1. `pnpm lint` — exit 0, zero errors (warnings are tolerated; check the exit code, a piped `tail`
   hides it)
2. `pnpm test` — tier 0
3. **tier 1** — the parity gate proper
4. **tier 2** — the end-to-end leg on a 3-worker stack
5. **`node scripts/run-workerd.mjs --build-only`** — the capnp translatability check

Item 5 is the cheapest high-yield item and it is currently absent. An upstream commit that adds a
binding type the translator does not know breaks the airgapped deployment **while every other test
stays green** — `run-workerd.mjs` throws on unknown module types and silently drops `browser`. It
costs ~24s, and it is a build rather than a boot, so it is the one Tier-3-priced item worth paying
per cherry-pick.

**Item 6 is not automatable.** Does the diff touch `LOADER`, `ctx.restore`, `ctx.facets`,
`ctx.exports`, `compatibility_flags`, `kv_namespaces`/`r2_buckets`, or
`global_fetch_strictly_public`? If so it needs a new Tier-1 case *before* it merges, not after.

Record the gate output in the commit message, per [`git-workflow.md`](./git-workflow.md).

## What belongs in Tier 1

In priority order. The first is the largest untested surface in the fork and turns out to cost
about 2.5 seconds.

1. **The gadget sandbox.** `workerLoader` binding; `globalOutbound: null` blocks egress; `modules`
   is an object map; `--experimental` is required. Verified reproducible in a 20-line fixture.
2. **Loader identity and caching** — same key returns the same isolate, a changed key a fresh one.
   That is the semantic `overseer.ts`'s `codeVersion` keying depends on.
3. **`ctx.restore()` self-token semantics** — the self-labelled "Wacky hack", still unproven.
4. **Facet lifecycle** — `get`/`abort` and persistence across abort.
5. **DO durability under `SIGKILL`** — exists in `fieldos-runtime`; generalize it.
6. **KV/R2 binding protocol** — exists; it is also the workerd-version canary.
7. **Compatibility flags** — assert the pinned binary accepts each one. `run-workerd.mjs` already
   strips `enable_ctx_exports` because it is fatal, so this class of breakage is real.
8. **The `network` allow-list** — `["public"]` blocks private, `[]` blocks loopback,
   `deny = ["public"]` is fatal. Encodes verified findings so a bump cannot silently change them.

## The airgap assertion

Point `globalOutbound` at an interceptor worker that records and rejects every request, then assert
zero escapes. This replaces `integration-tests`' `globalThis.fetch` patch and is **strictly
stronger**: it lives below the isolate, so gadget code cannot monkey-patch out of it. Verified
working. `run-workerd.mjs` emits `globalOutbound = "internet"` on every worker against one named
service, so this is a one-line generator change.

Tier 2 needs it, or a CI runner's real egress lets an escape pass silently.

## `packages/integration-tests` — convert, don't retire

- **Retire `harness.ts`.** It boots wrangler → miniflare, so it tests a runtime we do not ship, with
  miniflare's own KV/R2 rather than ours. It also deletes `worker_loaders` outright, which is why
  the gadget path has never been covered.
- **Keep `rpc-client.ts` verbatim.** `connect(baseUrl: URL)` has zero wrangler coupling; it becomes
  Tier 2's client for free.
- **Keep `network-interceptor.ts`** as a Tier-0 unit spec — its concept moves to capnp, but the file
  is exported for consumer repos and runs in milliseconds.
- **Leave `observer-reverification.test.ts` on miniflare.** It tests overseer *logic*, which is
  runtime-independent. 382 lines of migration would buy no parity signal.

Note [`integration-testing.md`](./integration-testing.md) is stale where it describes a wrangler
`~4.104.0` pin and a root workerd override — neither matches this fork.

## What not to build

A small suite that actually gates beats an aspirational pyramid.

- **No coverage chase on the ten delete-candidate connectors.** `gatekeeper-confluence` has 7 test
  files for a package the plan deletes.
- **No Tier-2 case per gatekeeper.** One proves the binding-scan mechanism; the rest is the same
  code path.
- **No automated re-derivation of the workerd wire protocol.** `plans/workerd-probe/echo.js` takes
  two minutes by hand and produces output a human must read. Automating it builds a tool nobody
  runs. Pin the version instead, keep the canary, and make a workerd bump a deliberate PR.
- **No CI test of the watchdog.** It was verified three ways by hand; in CI it would be a
  timing-dependent flake generator, and its thresholds are explicitly calibration knobs.
- **No test of resource limits.** There are none — it is a documented ceiling, and a test would
  assert a known-absent feature.

## CI

One new job, `workerd parity`, running tiers 1 and 2 plus the translatability check. No extra setup
step: `@cloudflare/workerd-linux-64` is already in the lockfile as an optional dependency, so
`ubuntu-latest` works as-is.

Tier 3 goes in a separate nightly workflow. It needs Ollama and MCP fixtures that would make it
flaky on PRs.

## Open risks

- **The `ctx.restore()` case may not be reproducible in isolation** — the hack depends on
  `#codeIdMap` state inside `OverseerDurableObject`. If a minimal fixture cannot reproduce the
  self-token redirect, it moves to Tier 2 at ~5s more. Determine this first.
- **A Tier-2 restart test must delete the DO disk but keep `.workerd/keys.json`.** Regenerating a
  `uniqueKey` orphans the data, and the restart assertion then passes vacuously — proving nothing
  while looking green.
