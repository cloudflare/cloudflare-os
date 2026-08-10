# Handoff — state of the airgap port

Written 2026-08-10. What is done, what is true, and what to pick up next.

The living design is [`fieldos.md`](./fieldos.md); the append-only record is
[`fieldos-log.md`](./fieldos-log.md). This file is the orientation layer: read it first, then those.

Two process docs matter as much as the design:
[`docs/testing.md`](../docs/testing.md) (the tiers, and the cherry-pick gate) and
[`docs/upstream-sync.md`](../docs/upstream-sync.md) (how we take upstream changes, and why "watch
for security advisories" is not implementable — upstream publishes none).

## Where things stand

**FieldOS runs end to end on standalone workerd with no Cloudflare account.** That was the gate
everything else was untestable behind, and it is met. Each leg was verified by execution, not
inference:

| | |
|---|---|
| SPA serves | `GET /` → 200, hashed assets immutable |
| API | `/api` → 101, a real Cap'n Web session |
| password login | account creation, login, wrong-hash rejection |
| chat | a local Ollama model answered |
| **tool calling** | `executeCode` ran and returned `42` |
| gadget → on-prem MCP | read as observation, write queued for approval |
| **restart** | `kill -9`, then everything was still there |

`node scripts/run-workerd.mjs` does the whole thing: bundles nine workers, writes the capnp config,
spawns and supervises workerd.

## The five things most worth knowing

**1. The MCP trust boundary holds off-platform.** The security-relevant unknown. A gadget's write
*provably* did not reach the MCP server before approval — the server's own request log showed one
call, and a second only after `approveAction()`. `readOnlyHint: true` ran as an observation.

**2. Isolation is intact; availability is not.** A runaway gadget cannot reach anything it should
not — `globalOutbound: null`, tails and facet persistence all hold. It can only refuse to stop, and
that wedges the whole process. There is a watchdog; there is not containment. Do not let anyone
describe the watchdog as isolation (OZL-239).

**3. Two plan claims were wrong, and both are corrected in `fieldos.md`.** "R2 → MinIO, R2's API is
S3-compatible" conflated R2's *S3 endpoint* with the R2 *binding*; MinIO cannot serve the binding.
"Local inference is zero code changes" conflated the *endpoint* with the *request body*; an
internal endpoint fell through to OpenAI's strict defaults and 400'd on real vLLM. Both were
plausible, and both cost real time — treat plan claims as hypotheses until executed.

**4. The protocols we depend on are unversioned workerd internals.** `fieldos-runtime`'s KV/R2
implementations are valid for workerd **1.20260801.1 exactly**. `plans/workerd-probe/echo.js`
re-derives the wire protocol in about two minutes. Re-run it after any workerd bump; the
`fieldos-runtime` suite is the canary.

**5. Testing against Ollama proves less than it looks.** Ollama tolerates every field a stricter
server rejects, so the inference bug was invisible against it. The servers customers actually run
(vLLM, TGI) are the discriminating cases.

## What is done

| | |
|---|---|
| OZL-210 | Rebrand, dead code, GitLab CI removed |
| OZL-211 | Usage quotas decoupled from billing |
| OZL-212 | Session expiry and revocation |
| OZL-213 | `gatekeeper-oidc` |
| OZL-214 | Org separation Phase 1 (observable, not enforcing) |
| OZL-215 | **Phase 1 — standalone workerd end to end** |
| OZL-234 | `fieldos-runtime` — KV, R2, asset services |
| OZL-235 | Password-auth frontend variant |
| OZL-239 | *(Alpha stage)* workerd watchdog |

## What to pick up next

**Cheapest first: OZL-224–227.** Four verification issues — doc/sheet/deck, local models, admin
dashboard, sharing — all blocked until today because they need a running stack. Now unblocked, and
each is verification rather than construction. Note OZL-226 has one real gap inside it: session
bounds have no admin UI.

**Highest leverage: OZL-219 (SSRF inversion + `gatekeeper-shared`).** It unblocks OZL-240 (on-prem
MCP servers are unreachable as shipped) and OZL-230 (MCP to databases). Two findings feed straight
into it:
- `allow = ["public", "private"]` in the capnp `network` service re-opens all of RFC1918. workerd's
  own schema recommends `ExternalServer` bindings per host instead. The internal-CIDR allowlist the
  plan wants belongs *in capnp*, not only in connector code.
- `MCP_ALLOW_INSECURE` disables the HTTPS check **and** the private-host block together. Separating
  them is the actual work (OZL-240).

**Known bug worth fixing cheaply: OZL-241.** `updateCode()` accepts a malformed Yjs update and
permanently bricks a workspace. Not airgap-specific; latent only because the frontend is the sole
caller today.

**The one needing a decision, not code: OZL-222** — what IdP do customers actually run? It has been
asked repeatedly and gates verification of the OIDC work.

## Traps that have already cost time

Each of these looked like success while being wrong. That is what makes them worth listing.

- **A test that fails to exercise its subject looks exactly like a pass.** A DoS repro silently did
  not reproduce because the loader definition omitted `mainModule` — the gadget never started and
  the process looked healthy. Read the log, not the exit code.
- **Grep is not a search.** A character class without `_` hid two services; a name-based dead-code
  scan produced a false positive on `ChatMessage`. Resolve imports, and check your pattern before
  trusting a negative.
- **`agent.ts` contains code that is not code.** Two `export class Gadget` declarations live inside
  the `SYSTEM_PROMPT` template literal as examples for the model. Only `server.ts`'s `export { ... }`
  list is authoritative.
- **Running the release build breaks the next `types:check`.** It regenerates each package's
  gitignored `.wrangler/validate/`; clear with `rm -rf packages/*/.wrangler`.
- **`uniqueKey` values are permanent.** They become the on-disk directory name and there is no
  migration mechanism. `run-workerd.mjs` persists them in `.workerd/keys.json` — do not regenerate.
- **`SIGTERM` is ignored by a wedged workerd.** Go straight to `SIGKILL`.
- **An R2 miss must return 404 *and* a `cf-r2-error` header**, or `.get()` throws instead of
  resolving `null` — and the failure surfaces far from its cause.

## How to run it

```sh
node scripts/run-workerd.mjs                  # bundle, generate config, spawn, supervise
node scripts/run-workerd.mjs --build-only     # just write .workerd/config.capnp
node scripts/run-workerd.mjs --no-watchdog    # when attaching a debugger
```

Then `http://localhost:8080`. Local inference needs the default `--allow public,private`, since
standalone workerd blocks private IPs by default.

The gate before any push, per `docs/git-workflow.md`:

```sh
pnpm lint     # oxlint + recursive tsc --noEmit; errors must be zero
pnpm test
```

## Deliberate limitations, stated so they are not rediscovered

- A runaway gadget interrupts the deployment until the watchdog restarts it (OZL-239).
- On-prem MCP servers cannot be connected without disabling an orthogonal control (OZL-240).
- Blueprints are fetchable unauthenticated by id, bypassing org separation (OZL-223).
- Admin revocation targets a *named* user; there is no user directory.
- Gadget PDF export is unavailable — no `BROWSER` binding off-platform. It degrades cleanly.
- `webFetch` document conversion is unavailable; it falls back to plain text and is near-moot on an
  isolated network anyway.
