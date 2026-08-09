# FieldOS Work Log

Append-only. Newest at the bottom. Records what was done, what was *verified*, and decisions taken
as they were taken. The living design lives in [`fieldos.md`](./fieldos.md) — when a decision here
changes the plan, update that document too and note it in the entry.

Conventions: cite `file:line` for anything a reader would otherwise have to hunt for. Record what
was **checked**, not what was assumed. Corrections to earlier entries are new entries, not edits.

---

## 2026-08-09 — Repo analysis

Six parallel investigations across the kernel, frontend, gatekeeper subsystem, infrastructure, an
independent Cloudflare-dependency audit, and upstream `workerd` verification. Findings folded into
`fieldos.md`; only the corrections and surprises are recorded here.

**Delegated findings that were wrong**, caught by direct verification:
- Two items reported as "hard blockers, no OSS equivalent" — Worker Loaders and SQLite DOs — are
  neither. Both work in self-hosted workerd. The report inferred from "new Cloudflare feature"
  without checking the runtime.
- A dead-code list flagged `ChatMessage` as safe to delete by name-grep. The *name* has 35 live
  references (it collides with the `AiChatMessage` API type). Name-based dead-code detection is
  unreliable here; resolved imports are the only trustworthy signal.
- `tools.ts:2` asserts "nothing outside this file reads a tool's annotations". **False** —
  `client.ts:270` reads `tool.annotations`. Probably transport-layer pass-through, but the absolute
  claim is wrong and a security review must confirm it makes no *decision* on the value.

**The distinction that reframed the project:** Durable Objects are two things. Actor semantics and
SQLite storage are open-source workerd; the global placement/routing control plane is proprietary.
Two expert analyses appeared to contradict each other because one answered "do the semantics
exist?" (yes) and the other "can I run this multi-node?" (not for free). Both were right.

**Sizes** (src/ + app/, excluding generated `worker-configuration.d.ts`): frontend 44,192; backend
21,516; the ten delete-candidate connectors 34,290 combined; `router` **69**.

---

## 2026-08-09 — workerd feasibility verified by execution

Ran it rather than reading about it. `workerd 2026-08-01` from public npm, no Cloudflare account.

```
schema fields ....... workerLoader :446, enableSql :653,
                      durableObjectStorage :681, localDisk :698
DO SQL write ........ 1, 2, 3
alarm (+5s) ......... ALARM FIRED
Worker Loader ....... dynamic-ok        (globalOutbound: null)
kill + restart ...... 3 → 4             state survived
on disk ............. state/probe-key-permanent/*.sqlite
```

Two things only execution revealed:
- **Worker Loader bindings require `--experimental`.** workerd refuses the config without it. A CLI
  gate, invisible to any amount of schema reading.
- **`modules` in a loader definition is an object map**, not an array. The array form throws
  `TypeError: the provided value is not of type 'object'`.

**Surprise that reordered the risk register:** `localDisk` is marked
`** EXPERIMENTAL; SUBJECT TO BACKWARDS-INCOMPATIBLE CHANGE **` in the schema. `workerLoader` carries
no such warning. The scary thing (the sandbox) is stable; the boring thing (DO persistence to disk)
is the flagged one — and it is the only way to persist state on own hardware, since `inMemory` is
explicitly test-only. Promoted to top platform risk in `fieldos.md`; implies version pinning is a
hard requirement and a backup path for the SQLite files is needed from day one.

Provenance note: an earlier claim that this was "confirmed from primary source" was **overstated**
at the time — it rested on search-engine renderings of the schema, since GitHub and raw file hosts
were DNS-blocked. The execution run above is what actually settled it.

---

## 2026-08-09 — Phase 0: rebrand, dead code, CI (`bbe9297`)

Branch `phase0-rebrand`. 21 files, +26 / −1,563. **Connector deletion deliberately deferred** at
the user's request — connectors retained for now.

- `DEFAULT_SITE_NAME` → `"FieldOS"` (`workshop-shared/src/api.ts:674`), which flows through
  `resolveSiteName()` to every route title and to backend prose (`overseer.ts:4833, 6511, 6573`).
- `index.html:11` title and `favicon.svg` — the two places that bypass the `siteName` system.
- `DEFAULT_ACCENT_COLOR` and the `styles.css` token fallbacks: `#ff4801` → `#2d6a4f`.
- Literal "Cloudflare OS" in retained packages: `mcp-shared`, `gatekeeper-github`,
  `gatekeeper-homeassistant`, `gatekeeper-context`.
- Deleted nine dead files: `src/App.tsx` (superseded by TanStack Router) and the chat prototype
  cluster (`AppPreview`, `ChatMessage`, `ConnectionConfigModal`, `DataTab`, `PermissionToast`,
  `ToolCallCard`, `data/chat.ts`, `data/sample.ts`).
- Removed `.gitlab-ci.yml` — hardcoded `gitlab.cfdata.org`, Cloudflare-internal runner tags and an
  internal AI-review component. GitHub Actions is the portable path and stays.

**Correction to the plan's own estimate:** the rebrand was scoped at "5 touch points" from a
frontend-only reading. The real count is **57 occurrences across 16 files**. Gatekeepers are
separate Workers that render their own OAuth callback HTML and never see `ServerConfig`, so they
hardcode the product name. Only the retained ones were renamed; renaming delete-candidates would be
wasted work. The proper fix — plumbing branding through to gatekeepers — is kernel API work,
deferred.

**Method note:** the dead-code deletion was verified by *resolving import specifiers* against the
filesystem, not by grepping names. All nine had zero live importers. Given the `ChatMessage`
collision, name-grep would have produced a misleading answer either way.

Deleting `data/chat.ts` also removed hardcoded `slack.com` and `*.workers.dev` fetch URLs, which
have no place in an airgapped client bundle even as dead code.

Verified: frontend `types:check` clean, `workshop-shared` `types:check` clean, 118 frontend tests
pass (24 files), `oxlint` exit 0 (64 pre-existing warnings, 0 errors).

---

## 2026-08-09 — Usage quotas decoupled from billing (`432fa09`)

User asked to keep the metering rather than delete it: useful for limiting users even with no money
involved. Correct call, and the code was already shaped for it.

The subsystem was two separable halves: `limits/` is a generic per-user daily counter
(`DAILY_LLM_CALL_LIMIT`, a UTC-day count on `UserDurableObject`, consuming only while under the
limit so a blocked request never counts), while `cloudflare/` is OAuth, AI Gateway balance reads and
BYOK routing. Only `ENABLE_CLOUDFLARE_LIMITS` gated both, making quotas unreachable without the
billing path.

Added `ENABLE_USAGE_QUOTAS`: enforces the same counter for every user with no balance lookup, no
BYOK and no top-up affordance. Ignored when `ENABLE_CLOUDFLARE_LIMITS` is on, since that path
already enforces the counter and enabling both would be ambiguous.

The frontend keys on the **honest existing signal** rather than a new flag: quota-only reports
`cloudflareLimitsEnabled: false` with `unlimited: false`, a state the type already permits and which
describes the situation exactly — limits apply, Cloudflare doesn't.

Two bugs found by tracing consumers rather than trusting the producer:
- `UsageSettings` gated its **render** on `limitsEnabled`, so the quota banner would never appear.
- Its **fetch** also short-circuited on `limitsEnabled`, so `usage` stayed `null` and nothing would
  render regardless. Now unconditional — the server already reports `unlimited: true` when apt.

Also: gated the Cloudflare connect/credits block and billing doc links on `limitsEnabled`; gave
`OutOfCreditsModal` a quota-only branch (checked first, since every other branch is
Cloudflare-specific) offering a reset countdown and an admin referral instead of a top-up; dropped
"free" from its title, which implies a paid tier that does not exist in this mode.

Config for an airgapped deployment: `ENABLE_USAGE_QUOTAS=true`, `DAILY_LLM_CALL_LIMIT=250`
(default 100), leaving `ENABLE_CLOUDFLARE_LIMITS` unset.

**Known limitation:** the limit is one global number. Per-user or per-role limits would be an
`AdminConfig` change.

Verified: frontend + backend `types:check` clean, 118 frontend tests pass, `oxlint` 0 errors.

---

## 2026-08-09 — Auth direction: `gatekeeper-oidc`, not Better Auth

Better Auth was proposed and rejected for the main login path. Reasons, in order of weight:

1. **There is no database.** Zero relational dependencies in the monorepo (checked across all
   `package.json`). Auth lives on `UserDurableObject`: `passwordHashHash` and `sessions` are DO
   storage (`user.ts:163, 217`), reached by `idFromName(username)`. Better Auth requires a DB
   adapter owning `user`/`session`/`account` tables. Adopting it means standing up Postgres purely
   for auth in an airgapped datacenter, or writing an adapter where "list all sessions" is a
   cross-DO fan-out the model deliberately cannot do.
2. **The password protocol is inverted.** `LoginPage.tsx:38` hashes with **argon2id in the
   browser**; the server sees only a hash and stores SHA-256 of it (`user.ts:339-347`). Better Auth
   owns server-side hashing.
3. **It does not solve the actual problem.** The need is LDAP/AD or on-prem OIDC; Better Auth's
   strength is social providers, useless on an isolated network.

Chose `gatekeeper-oidc`: OIDC is what enterprise IdPs speak, `providesAuth` + `AUTH_GATEKEEPERS` is
the built-in seam, and `access.ts` is already 48 lines of generic `jose` JWKS verification.

Also considered and rejected for production: repointing `CF_ACCESS_ISS` at a local IdP. Works in
hours and is a fine Phase-1 stopgap, but it trusts a `cf-access-jwt-assertion` header a proxy is
expected to inject — **spoofable if anything can reach the backend directly**.

**Still unanswered, and it gates this work:** what IdP does the customer actually run? OIDC is the
bet; raw AD with no OIDC front door would invalidate it and require an LDAP sidecar.

---

## 2026-08-09 — Session expiry and revocation

**Root cause, found while scoping:** `server.ts` called `await stub.authenticate(split[1])` and
**discarded the result**. The live connection carried no session identity, so there was nothing
later calls could re-validate against. That — not the missing TTL — is why mid-connection expiry
looked hard: `authenticate()` runs once and the resulting capability serves a WebSocket for days.

**Enforcement: a Proxy over `AuthenticatedApiImpl`.** Considered and rejected:
- *A DO alarm calling `abortSession`* — **impossible**, not merely costly. `abortSession`
  (`server.ts`, in the fetch handler) is a closure capturing `resp.webSocket`; an alarm fires on
  `UserDurableObject`, a different isolate with no reference to it, and no registry maps sessions
  to live connections. Building one is the parallel mechanism the repo forbids.
- *Enforcing inside `UserDurableObject`* — this was the lead's own first proposal, **retracted on
  verification**: that class has **77 public methods** versus 54 on `AuthenticatedApiImpl`, so
  pushing the guard down makes the interception problem worse. There is no convergence point on
  either side; the RPC layer dispatches straight to methods.
- *Editing all 54 forwarders* — a 54-line diff in the kernel's most-reviewed file.

The Proxy is ~15 lines at the two (only two) construction sites. Precedent: `overseer.ts:2392`
already Proxies a facet stub for a cross-cutting concern, and its comments encode the two traps
that apply verbatim — pass `target` as the `Reflect.get` receiver (not the Proxy, which throws
"illegal invocation"), and skip non-functions and symbols (`then` is probed on anything awaited).
That precedent is itself labelled "a hack"; precedent, not endorsement.

**Config: env ceiling, admin tightens within it** (`auth/session-policy.ts`). `AdminConfig` is
documented as deliberately *not* holding auth config so a compromised admin session cannot weaken
it (`admin-config.ts:7-8`, `AGENTS.md:37`). Putting timeouts there outright would have inverted
that. Instead `SESSION_MAX_LIFETIME_HOURS` / `SESSION_MAX_IDLE_MINUTES` set ceilings and the admin
may only tighten below them — a compromised admin can annoy users, not disable the control.
Clamping happens at *resolve* time, not write time, so lowering a ceiling immediately tightens
deployments holding a looser stored value. Defaults 12h / 60min.

**IdP deference:** `sessionExpiry()` takes an optional `idpExpiresAt`; when an external provider
issues the session, its expiry wins — but still clamped to our ceiling, so a permissive OIDC
config cannot mint an effectively immortal session. Plumbed through `#newSessionToken()` and unused
until `gatekeeper-oidc` exists.

**Bypass audit.** Only two sites construct `AuthenticatedApiImpl`. The **Cloudflare Access path
mints no session record** — `authenticateFromCfAccess()` never calls `#newSessionToken()`;
authority is the per-request JWT and its lifetime is the IdP's. The wrapper therefore treats a
missing `tokenId` as "not session-backed, pass through" rather than invalid. Assuming a tokenId
always exists would crash a path no airgapped deployment would ever exercise; commented so nobody
later "fixes" it into a rejection.

**Migration: forced re-login.** Records lacking the new deadlines are treated as expired and
deleted on read. Grandfathering would have meant a token leaked *before* the fix kept working for
the full new window — the fix doing nothing for its own threat model — and would have cost a
dual-schema branch.

**Revocation:** `revokeAllSessions()` on the user DO, reached two ways —
`AuthenticatedApi.revokeAllSessions()` (all-or-nothing, drops the caller's own connection too) and
`revokeSessionsForUser(username)` gated on `#isAdmin()`. Admin revocation lives on
`AuthenticatedApiImpl`, **not** `AdminApiImpl`: Codex proposed giving the latter a user-DO binding,
but its own doc comment (`admin-settings.ts:549`) states it is "fully user-independent" so the
client "never receives a stub to the DO's internal methods". `AuthenticatedApiImpl` already holds
both the user namespace and `#isAdmin()`.

**Sweep:** lazy deletion on read, marked with a `ponytail:` comment naming the ceiling. Sessions
are small rows in a per-user DO accumulating at human pace — no growth problem to justify an alarm.

**Scope boundary worth stating to an accreditation reviewer:** there is no user directory (user DOs
are `idFromName`, `AdminSettings` has no enumeration method), so revocation targets a *named* user.
"Force a global re-auth" would require building a directory.

Verified: backend + shared `types:check` clean, **293 backend tests pass** (14 new in
`__tests__/session-policy.test.ts` covering ceiling fallback, admin tightening, clamping, ceiling
lowering, and IdP precedence), 118 frontend tests pass, `oxlint` 0 errors.

**Not done:** no admin UI yet — the fields exist in `AdminConfig` and resolve correctly, but the
dashboard controls come with the future admin panel work. Env vars work today.

---

## 2026-08-09 — Multi-customer decisions

The deployment model is **mostly isolated, some shared**: a deployment per customer, with some
shared services. Two consequences.

**Shared infrastructure — recommended split.** Share the GPU/inference cluster only; keep
everything stateful per-customer. Inference is stateless, so prompts cross the boundary but no
persisted state does; per-deployment API keys plus network policy cover it. Everything else fails
the "what if customer A is compromised?" test:
- *Shared Context gatekeeper* — A reads B's documents. `domain.ts:1-2` says its namespacing "is not
  a boundary against malicious peer configs", and `sharingDomain` arrives from binding props set at
  deploy time with nothing enforcing a deployment stays in its own namespace.
- *Shared blueprint registry* — blueprints are code that runs in user sandboxes, so A publishes
  into B. Acceptable only one-way: we curate and publish, customers consume.

Caveat raised to the user and not yet resolved: a shared GPU cluster means prompts leave the
customer's network, which may be disqualifying for a genuinely classified deployment regardless of
technical isolation.

**Auth is generic, configured per deployment.** Multiple customers means multiple IdPs, so the
connector takes issuer/client/scopes as config rather than shipping a connector per provider.

## 2026-08-09 — gatekeeper-oidc

Generic OIDC sign-in. Three layers, deliberately separate so each can be read alone:
`identity.ts` (discovery + ID token verification), `oauth.ts` (nonces, authorize URL, code
exchange), `oidc.ts` (durable state + the Workshop contract). The first two hold no Workers types,
so their rules are unit-testable directly — 46 tests covering every rejection path.

**The security-critical rule:** `email_verified` must be exactly boolean `true`. Absent counts as
unverified (some IdPs omit the claim rather than sending `false`), and a string `"true"` is
rejected. The Workshop keys accounts by email, so without this anyone able to register
`victim@corp` at a permissive IdP signs in as that Workshop user.

**Discovery is required, not optional.** Hand-configuring three endpoint URLs is three chances to
point token verification at the wrong host. The document's declared issuer must match the
configured one, and every endpoint must share its origin and use HTTPS.

**Two nonce stages**, mirroring the other OAuth connectors: the initiation nonce is spent when the
user opens the link, and only then is the `state` nonce minted, so a captured link cannot be
reused. The nonce is deleted *before* the code exchange, so a replayed callback cannot reach the
provider twice. The provider's echoed `nonce` is checked *after* signature verification, so the
claim is trustworthy when read.

**Sign-in only by construction:** `getSupportedResources()` returns `[]`, `getGatekeeperClassFor()`
throws, and no access token is stored — there is no resource to reach with one. The grant
self-destructs two minutes after the Workshop reads the email; abandoned attempts are reaped after
an hour.

Three things worth recording as traps:
- **`deploy-inputs.json` was nearly missed.** Without it the connector inherits
  `DEFAULT_CRED_INPUTS` (`CLIENT_ID`/`CLIENT_SECRET`) and, since the deploy wizard blocks Install on
  unfilled secret inputs, would have been **uninstallable**. A first draft used `kind: "var"` for
  the non-credential inputs; `manifest-lib.mjs:218` only emits a `secret_text` binding for
  `kind: "secret"`, so those would have produced no binding at all and the worker would never have
  seen `OIDC_ISSUER`. All four are `secret`.
- **The golden manifest test fails closed on a new deployable package** ("missing fixture bundle"),
  which is a good guard — a new worker cannot silently skip the deploy contract. Fixture added,
  golden regenerated with `UPDATE_GOLDEN=1` and the diff read rather than trusted.
- **Two workerd-only APIs broke under the Node test runner:** `crypto.subtle.timingSafeEqual` and
  `Uint8Array.prototype.toHex`. Both now have portable implementations — the constant-time
  comparison falls back to XOR accumulation branching only on length, which is a real
  implementation rather than a test stub. Note the GitHub connector's copy of `constantTimeEqual`
  is untested in every package that has it, for exactly this reason.

A commit-hygiene correction: the first OIDC commit claimed "23 tests pass" but `vitest.config.ts`
had been added afterwards and was not in it, so the claim was not reproducible from that SHA.
Amended. A commit whose stated verification cannot be reproduced from itself is worse than one
that claims nothing.

**Not done:** no `src/types.d.ts` / `types.txt` symlink, since a sign-in-only connector exposes no
Session type. If OIDC ever grows a resource (group membership for authorization, say), whoever adds
it must know `SKILL.md:318` requires a **symlink**, not a copy.

---

## 2026-08-09 — Correction: the sharing question was the wrong question

The earlier entry recommended sharing a GPU cluster across customers, and flagged "prompts leave
the customer's network" as an open accreditation question. **Both were wrong, for the same
reason:** an airgapped deployment has no route to another customer's network, so cross-customer
sharing of anything is not merely inadvisable, it is unavailable. The accreditation question does
not arise because the connectivity does not exist.

The separation customers actually want is **between orgs inside one deployment** — several
departments on one airgapped network, sharing the GPU cluster that customer bought, with their
workspaces and documents kept apart. There, sharing is the point rather than the risk, and the
hardware is the customer's own on their own network.

**Nothing models this today** (verified): no org/team/tenant/group concept in
`workshop-shared/api.ts`, `user.ts` or `admin-config.ts`. What exists is a per-workspace sharing
graph that separates individuals but knows nothing of groups, a flat deployment-wide `ADMINS` list
checked by `#isAdmin()` with no per-org scoping, a single `AdminConfig`, and the Context
gatekeeper's `sharingDomain` — which its own source calls out as "not a boundary against malicious
peer configs".

Four questions decide the design, recorded in `fieldos.md`: whether org boundaries are advisory or
enforced, whether the customer's IdP carries group membership (in which case `gatekeeper-oidc` maps
a claim rather than FieldOS keeping its own directory), whether orgs need separate admins (`ADMINS`
is flat, so this is the expensive one), and whether inference is shared across orgs (almost
certainly yes).

Recommended default: **enforced**, with membership from the IdP where available. Advisory
separation is cheap but gets sold as a boundary and later discovered not to be one — precisely the
failure `sharingDomain` already demonstrates.

---

## Next

Phase 1 — standalone workerd end to end. It is the gate everything else is untestable behind, and
it needs no further decisions: KV shim, R2 → MinIO, local inference, then the checkpoint of
login → gadget → local model chat → MCP call → restart → state survives.

Org separation is a design question, not yet a task — it needs the four answers above first.
