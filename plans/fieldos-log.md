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

## Next

Session expiry and revocation (`user.ts:76`, `:298`, `overseer.ts:7333`), ahead of the OIDC
connector: it is a likely accreditation blocker, small, and independent of which auth path ships.
