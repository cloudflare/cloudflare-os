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

---

## 2026-08-09 — Org separation, Phase 1 (observable, not enforcing)

Design in `plans/org-separation.md`, shipped in four slices on `feat/org-membership`. **No access
decision changed**; a deployment that leaves `OIDC_GROUPS_CLAIM` unset is bit-for-bit unaffected.

Decisions taken from research (Slack Grid, Notion teamspaces, GitHub, GitLab, Grafana):
- **Container, not grouping** — the data model had already chosen: one immutable `ownerId` and
  sharing as reachability from it. Presenting this as an open choice would have been a false one.
- **Org stamped on the workspace, never resolved through the owner.** With immutable ownership and
  no offboarding path, `orgOf(owner)` means a person moving teams silently drags every workspace
  they own along. Confirmed against practice: GitHub documents repo transfer under "best practices
  for leaving your company"; Notion built a "Recently Left" lost-and-found. We have neither.
- **Fail closed on a missing claim** — never a default org. Verified from Microsoft's docs: above
  200 groups (JWT) / 150 (SAML) Entra omits the groups claim entirely and points at Graph, which is
  unreachable airgapped. A user in 250 groups is otherwise indistinguishable from one in none.
- **No approval workflow for membership changes.** Every comparable product re-syncs silently on
  login; building one would invent a mechanism the industry does not have. The real failure is
  *misconfiguration that looks like it worked* — GitLab #556879 and Grafana #97663 are the same
  shape — so the mitigation is the admin read-out, not a gate.

Three things caught by verifying delegated analysis rather than accepting it:
- The KV mirror (recommended by both Codex and me) was **dropped after reading `open()`** — it
  already holds the user namespace, so the mirror bought nothing and cost a staleness window.
- Codex's **backfill-on-owner-open was rejected**: it is the mover trap relocated to first-open,
  firing silently when an owner who changed teams simply opens an old project. Codex itself called
  it "mover-trap-shaped" and then argued it was fine.
- Codex's chokepoint enumeration **missed `receiveExternalMessage()`** as a second
  workspace-creation path. Stamping only `open()` would have left a permanent hole.

Also: `#migrateStorage` is for restructuring data whose meaning changed; an absent `orgId` is a
legitimate permanent state, not a legacy encoding, so no schema version bump.

Verified throughout: full-repo lint clean, 293 backend tests, 67 connector tests, manifest 4/4.

**Next:** Phase 2 — the check in `open()`'s non-owner branch plus `allowCrossOrgSharing`, behind
`ENABLE_ORG_SEPARATION` so the rollout is not one-way. Then Phase 3, the Context Library's
public-collection path, which never passes through `open()`.

---

## 2026-08-09 — Phase 1 research: standalone workerd is closer than the plan assumed

Branch `feat/standalone-workerd`, no code yet. Four parallel investigations into the DO/capnp
inventory, the KV/R2 surface, the boot path, and what breaks with no Cloudflare and no internet.
Recording only what was **verified**, the corrections, and the two things that changed the plan.

**The headline, proven by execution, not inference:** the real `workshop-backend` bundle **boots on
standalone workerd today** — HTTP 101 Cap'n Web upgrade on `/api`, SQLite files created on local
disk for all four DO namespaces. No Cloudflare account, no wrangler at runtime. Phase 1 is a
porting job, not a research project.

**`workerd 2026-08-01` was already in the pnpm store**, pulled in transitively by wrangler — the
exact build the feasibility probe used. Nothing to download, which is itself evidence for the
airgapped install story. Two versions are present (`1.20260722.1`, `1.20260801.1`) and there is
**no workerd override in `pnpm-workspace.yaml`**, so the binary must be selected explicitly; the
plan's version-pinning requirement is currently unenforced.

**The DO namespace list in `fieldos.md` is correct and complete — 4 namespaces**, machine-verified
against `worker-configuration.d.ts:13`'s `durableNamespaces` union, which wrangler generates from
`migrations.new_sqlite_classes`. The suspicion that it was incomplete was wrong. `LanguageModelGatekeeper`
and `AgentSpawnerGatekeeper` are **facet classes only** — reached as `ctx.exports.X({props})`, with
zero `.get()`/`.getByName()`/`.idFromName()` call sites — and facets need no capnp config at all.

Two corrections worth keeping:
- **`agent.ts`'s two `export class Gadget` declarations are not code.** Both sit inside the
  `SYSTEM_PROMPT` template literal (opens `:377`, closes `:522`) as example Gadget source shown to
  the model. Same for `class Callback` `:446`, `class Greeter` `:500`, and `overseer.ts:56` inside
  `CODE_MODE_HARNESS`. A grep-based class inventory over this repo produces false positives; the
  `export { ... }` list in `server.ts` is the only authoritative source. This is the same trap as
  the `ChatMessage` name-collision recorded in Phase 0 — **resolve, do not grep** — reappearing in
  a new disguise.
- **`enableSql = true` is load-bearing despite zero `storage.sql` calls.** The DOs use
  `ctx.storage.kv`, `transactionSync` (`overseer.ts:1268` and 6 more) and `ctx.storage.sync()`
  (`:3214`) — the synchronous KV-over-SQLite APIs, available only on SQLite-backed namespaces.
  Nobody should "optimize it away" on the grounds that `storage.sql` is unused.

**`uniqueKey` should be a fresh UUID, not the plan's `overseer-key`.** The schema
(`workerd.capnp:621-624`) states the key is what makes an object ID unforgeable. The plan's
human-readable placeholders are guessable, and `#openGadgetInternal` (`server.ts:281`) takes a DO id
straight from the client. Access control still runs inside `overseer.open()`, so this is
defence-in-depth rather than a hole — but it is free to get right now and impossible to change
later, since there is no migration mechanism for a `uniqueKey`.

### The one thing the plan got materially wrong

**"Shim KV / swap R2 → MinIO" understates and misdirects the work.** `kvNamespace @11` and
`r2Bucket @12` are **native workerd binding types** — but they are `ServiceDesignator`s: *"A KV
namespace, implemented by the named service. Requests to the namespace will be converted into HTTP
requests targeting the given service name."* workerd ships the **client** and no server.

Two consequences:
1. No call-site changes are needed, which matters because `workshop-backend` is upstream-mergeable
   and its diffs must stay surgical. The app keeps `KVNamespace`/`R2Bucket` types unchanged.
2. `docs/configuration.md:134`'s "R2's API is S3-compatible" is a **conflation to correct**: R2's
   *S3 endpoint* is S3-compatible; the *binding* this code uses is a private HTTP protocol, and
   MinIO cannot serve it. Pointing the binding at MinIO directly is not possible.

The required surface is genuinely tiny, exhaustively verified across all `packages/*/src`: KV needs
`get`/`put`/`delete` plus one `get(key, "arrayBuffer")` (avatars, `server.ts:253`); R2 needs
`get`/`put`/`delete` plus `httpMetadata.contentType`. **Zero** occurrences of `getWithMetadata`,
`expirationTtl`, `onlyIf`, multipart, `customMetadata`, or `list()`/`head()` on any of these
bindings.

**A third KV namespace the plan omits: `CONTEXT_COLLECTIONS`** (`gatekeeper-context/wrangler.jsonc:29`).

**KV is on the pre-login hot path**, so this is boot-blocking rather than a later concern:
`readAdminConfig()` (`admin-config.ts:313`) is reached by `getServerConfig()` before anyone signs
in, and by `checkSession()` (`user.ts:359`) on every authenticated connection. A missing
`BLUEPRINTS` breaks the login page, not just blueprints.

Noted for the security review, pre-existing and not introduced by the port: `parseAdminConfig`
returns `{...DEFAULT_ADMIN_CONFIG}` on failure (`admin-config.ts:302-304`), so a store outage
**fails open** to permissive defaults including `signupsEnabled: true`. The port changes who
operates that store, which is what makes it worth an explicit decision.

### The blocker nobody had recorded

**The release pipeline builds an Access-only frontend, so password login is unreachable in the
shipped bundle.** `scripts/release/build-release.mjs:76` hardcodes `VITE_CF_ACCESS_MODE: "true"`,
commented as "the one asset variant every release carries". It is a **build-time** flag
(`useAuth.ts:5`), so no runtime config can undo it: `ProtectedRoute.tsx:74` and `__root.tsx:87`
render "Authenticating…" forever instead of the login page, and `routes/signup.tsx:14` redirects
`/signup` to `/`, so no first user can ever be created.

The backend supports password login perfectly; only the build invocation is wrong. **Do not patch
the components** — the env-var branch is already correct. An airgapped release needs a second asset
variant.

### SSRF: the control moves into the capnp config

`wrangler.jsonc:16-18` says it plainly: under standalone workerd, blocking private IPs is **already
the default**, so `global_fetch_strictly_public` effectively only bites on Cloudflare's platform.
The real lever self-hosted is the `network` service's `allow` list.

Verified by execution: `allow = ["public"]` blocks private and loopback; `allow = []` is a true
airgap blocking everything including loopback; and **`deny = ["public"]` is a fatal config error**
(*"don't deny 'public', allow 'private' instead"*).

This has two consequences. First, **local inference is blocked by default** — Ollama on
`localhost:11434` needs an explicit `allow` entry, so "zero code changes for local inference" is
true of the code and false of the configuration. Second, and more usefully: the internal-CIDR
allowlist that Phase 2 (`gatekeeper-shared`) is supposed to implement centrally has a natural home
in the capnp `network` service, scoped to real CIDRs rather than a blanket `"private"`.

### Boot path

`integration-tests` boots via **wrangler's `createTestHarness` → miniflare → workerd**
(`harness.ts:12`), patching `wrangler.jsonc` in memory. It cannot be pointed at standalone workerd:
its config ingestion is wrangler-shaped, and `network-interceptor.ts` works only because miniflare
inserts a Node loopback as `globalOutbound`. So the standing obligation of a real-workerd suite
needs a **second boot path**, not an extension of this one.

The airgap guarantee survives more strongly, though: `globalOutbound` pointed at an interceptor
worker replaces the `globalThis.fetch` patch at the config layer, where gadget code cannot
monkey-patch its way out. `src/rpc-client.ts` ports verbatim and is where the real value sits.

`harness.ts:102` **deletes `worker_loaders` entirely**, so the existing suite has never covered the
gadget sandbox — the single largest unverified item, and the thing to test first.

Bundles come from `wrangler deploy --dry-run --outdir`, which works with no Cloudflare account and
yields exactly what capnp wants: one ESM plus text modules. `hash-lib.mjs:60-66` already asserts the
one-ESM invariant. Note `.wrangler/validate/` is **not** a bundle — `capnweb-validate` does a
TypeScript→TypeScript rewrite expanding `@validateRpc()` decorators, so that step is mandatory or
RPC argument validation is lost.

Also found: `GATEKEEPER_MCP_PORTAL` yields backend vendorId `mcp_portal` (underscore) but router
path `/gatekeeper/mcp-portal` (hyphen). Upstream behaviour to replicate exactly, not to "fix" —
changing it breaks the portal's OAuth redirect URIs.

### Corrections to existing docs, to make when the work lands

- `docs/configuration.md:134` — the R2 binding/S3-endpoint conflation above.
- `docs/integration-testing.md:83-93` — describes a wrangler `~4.104.0` pin and a root workerd
  override. Neither matches this fork (`~4.119.0`; no override).
- `docs/configuration.md` § Observability — "all logging is plain `console.*`" is stale; a
  structured logger exists and the backend has 5 `console.` calls left. Already noted in OZL-229.

### Still unproven

- **The KV wire protocol.** Being settled empirically now: workerd ships the client, so the exact
  request/response shape must be observed rather than guessed. Miniflare's `kv/namespace.worker.js`
  is the reference implementation but imports `miniflare:shared`/`miniflare:zod` and extends
  `MiniflareDurableObject`, so reusing it drags in Miniflare's own DO plumbing.
- **Worker Loaders end to end.** The binding was declared and the backend booted, but no gadget was
  loaded. This is how all gadget code runs.
- Whether `ctx.exports` synthesizes loopback stubs for `WorkerEntrypoint` exports identically
  off-platform. Affects the `tails:` targets, which have no capnp expression. Config-only fallback
  exists (a self-referential `service` binding with `entrypoint`), so it cannot invalidate any
  permanent decision.

---

## 2026-08-10 — `fieldos-runtime`: the KV, R2 and asset services (OZL-234)

Branch `feat/standalone-workerd`, commit `2d327a7`. The only infrastructure Phase 1 had to build,
and it came to ~250 lines because the protocol work was already done.

**What the bindings actually are.** `kvNamespace @11` and `r2Bucket @12` are `ServiceDesignator`s:
workerd converts binding calls into HTTP requests aimed at a service *you* supply, and ships none.
There is no `assets` binding type at all — only a bare `disk` service whose own schema comment says
you "would normally wrap this in a Worker". So each of the three files is a missing server half,
and the application needs **no changes**: it keeps calling `env.BLUEPRINTS.get(...)` exactly as
before. That was the deciding property, since `workshop-backend` is upstream-mergeable and every
line changed there is a line to reconcile on each future port.

**Placement: one new in-repo package, not a separate repo.** The cherry-pick-inward tax is
per-file-added-to-an-upstream-mergeable-package, and this adds zero such files — a sibling package
is invisible to a cherry-pick. It also version-locks to the pinned workerd and the capnp config,
both of which live here, so splitting it would create a cross-repo version matrix for something
that must upgrade atomically.

**No `wrangler.jsonc`, deliberately.** `findDeployablePackages()` (`manifest-lib.mjs:83`) discovers
packages purely by that file existing, and the golden manifest test **fails closed** on an
unrecognized deployable. Its absence is what keeps this package invisible to the release manifest,
the dev-server scan (`run-dev-server.js:70`) and type generation
(`scripts/generate-worker-types.mjs:44`) — all three key on the same file. Correct, since it never
deploys to Cloudflare. Verified the manifest test stays 4/4.

**Plain `.js`, not TypeScript.** capnp's `esModule = embed` inlines the source file itself; a build
step would put a `dist/` between the config and the code that runs, so the artifact in a deployment
would never be the file you read. `checkJs` plus JSDoc gives the type safety instead — and caught a
latent bug in the probe code immediately: `storage.get()` returns `{} | null`, so `new Response(v)`
was unsound without a cast.

### The adversarial review earned its keep by mostly clearing the code

Five of six concerns raised before promoting the probe code were unfounded:
- **Random-UUID etags are correct.** Nothing reads `.etag`, `.version` or `.checksums`; the app
  keys R2 by a path it constructs itself, so versioning lives in the key. Content hashing would
  force buffering to hash for no consumer. (The `uploaded` hits in `user.ts` are a **boolean** on
  DO storage meaning "was this published" — a different type entirely.)
- **Keys cannot traverse or collide.** They are SQLite row keys, never filesystem paths, and KV/R2
  are separate namespaces with separate files. `a/b` and `a%2Fb` stay distinct.
- **No torn reads**, measured: the object is one row, so metadata and body cannot desynchronise.
- **Not a bottleneck**: 400 concurrent KV gets ran at ~15,000/s, against a hot path
  (`readAdminConfig()`) that runs per connection.
- **The KV-put-failure rollback** in `admin-settings.ts:277-283` works unchanged.

The one real gap: **`MAX_BLUEPRINT_CONTENT_BYTES` permits 32 MB** (`blueprint-archive.ts:19`)
against a measured **2,199,729-byte** ceiling — SQLite's row limit (`SQLITE_TOOBIG`), not
workerd's. Independently confirmed by bisection: 2 MB succeeds, 4 MB fails. It fails fast and
leaves no partial object, so the existing rollback holds and no data is lost; the user just sees
`SQLITE_TOOBIG` instead of the friendly "Gadget archive content is too large." Recorded in the
package README — the fix belongs in a `workshop-backend` commit, not here.

Every other asset is far below the ceiling: avatars are capped at 100 KB (`server.ts:233` — an
earlier note in this log claiming they were uncapped was **wrong**, the check sits just above the
magic-byte validation), site logo 256 KB, screenshots 1 MB, shipped blueprints 25–50 KB.

**Path traversal needs no code.** workerd guarantees `.` and `..` are never accessible regardless
of `allowDotfiles` (`workerd.capnp:889`). Verified against a real `/etc/passwd`: every traversal
shape returns the SPA shell, never file content.

### Testing, and a bug the tests found in themselves

21 checks drive all three services through **real bindings** under the pinned workerd, including
byte-exact binary round-trips using deliberately invalid UTF-8 (the avatar path depends on values
staying `ArrayBuffer`; read as text those bytes become U+FFFD), stream puts (the blueprint import
path streams rather than buffers), directory-listing leaks and traversal. Then `SIGKILL` and
re-read, so durability is proven rather than a clean-shutdown flush.

Confirmed the suite can actually fail: removing the `cf-r2-error` header from a miss turned it red,
and restoring it turned it green.

`packages/integration-tests` **cannot** cover any of this — it boots via wrangler → miniflare, and
miniflare supplies its *own* KV/R2, so it would test Cloudflare's services rather than ours.

**A defect worth recording because the fix was better than the original.** The first suite
hardcoded port 8813. It passed standalone and failed under `pnpm test` on a leaked process from a
manual run. Killing the stray would have hidden the defect: a fixed port also collides with any
parallel CI job. Switching to `--socket-addr=:0` with `--control-fd` fixed the root cause and came
out *faster*, because workerd now reports readiness instead of being polled. Proved it by holding
8813 and re-running green.

### Docs corrected

- `docs/configuration.md` bindings table: "R2's API is S3-compatible" conflated R2's *S3 endpoint*
  with the *binding*. **MinIO cannot back `BLUEPRINT_CONTENT`.** Added `CONTEXT_COLLECTIONS` and
  `ASSETS`, which the table omitted, and corrected `WORKERS_AI` — it is not HTML-only, it converts
  PDF/DOCX/XLSX/ODT too, and fails soft.
- Observability: "all logging is plain `console.*`" predated the structured logger.

Verified: `pnpm lint` exit 0 (0 errors), `pnpm test` exit 0 — 1,113 vitest tests and 33 node:test
assertions repo-wide, golden manifest 4/4.

**Next:** OZL-235, the Access-only frontend build, which blocks the Phase 1 gate harder than
anything remaining — no airgapped deployment can render a login page or create a first user.
