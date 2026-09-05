# Implementation Plan: Gatekeeper Kit (`@gadgets/gatekeeper-kit`)

This is the implementation plan for the gatekeeper kit: a workspace library that lets a new
gatekeeper be written as a TypeScript spec plus service-specific sessions, instead of ~400–500
lines of hand-copied plumbing.

**Status.** Layer 1 (§4, the leaf modules) has landed and has been through a review pass against
both corpora. The §4 sections are reconciled against the shipped signatures — where the two ever
disagree, the code and its tests win. Google consumes the preview OAuth leaf; Layer 2 (§5, the
assembly) and §7 steps 8–16 are still proposal, so no gatekeeper has been ported to the assembly and
none of §5's ergonomics have met a real consumer. Findings that review raised and declined are
recorded in the obligations table (§4.8), each with the trigger that would revive it.

## 1. Introduction & high-level intent

Every OAuth gatekeeper in this repo repeats the same block of code with the provider's name
swapped in: the browser-facing fetch handler that drives the OAuth redirect dance, a `UserAccount`
Durable Object holding a two-stage nonce machine and token storage, a `GatekeeperVendor`
entrypoint, a `GatekeeperUser` entrypoint that maps resource URLs to facet classes, verifier
minting, configurator dispatch, a pending-action store, and observer bookkeeping. Compare
`packages/gatekeeper-github/src/github.ts:931-1333` with
`packages/gatekeeper-supabase/src/supabase.ts:267-672`: the two are the same machine. The
security-critical parts (nonce lifecycle, approval-queue ordering, observer admission) are exactly
the parts a new gatekeeper author is most likely to get subtly wrong.

The kit is one new workspace package, `packages/gatekeeper-kit`, with **two strictly separated
layers**:

- **Layer 1 — leaf modules.** Small, standalone primitives behind per-file subpath exports:
  connect nonces and the two-stage handshake, preview OAuth callback relaying, browser status pages,
  a credential-expiry latch, HTTP error classification, credential storage with refresh
  coalescing, observer strategies, a durable action journal, a transactional action-file store,
  pure simulation helpers, a TTL cache, and RPC cursors. Each is usable on its own; none requires
  the assembly layer.
- **Layer 2 — the assembly.** A `gatekeeperKit<Env, Grant, Exports, Public>()` factory producing a
  typed spec (`define`, `resource`), pluggable auth strategies (`oauth2`, `tokenAuth`, or a
  hand-written `AuthStrategy`), an HTTP handler, and four abstract base classes (`KitVendorBase`,
  `KitUserAccountBase`, `KitUserBase`, `KitGatekeeperBase`) that a gatekeeper subclasses under its
  own export names. The bases contain only sequencing; every provider decision (token exchange,
  refresh, revocation, error classification, scopes, URL grammar, session API) stays in the
  consumer package.

The escape hatch is structural. A gatekeeper that outgrows the assembly implements the canonical
`workshop-shared/gatekeeper` interfaces by hand and keeps using whatever leaf modules still fit;
`packages/mcp-shared` already proves the two styles coexist in one repo.

Provider *policy* and shared *sequencing* are deliberately separated. The kit never decides what a
provider error means or which scopes to request; it does own the order of operations — nonce
transitions, callback handoff, rollback when `complete()` fails, refresh coalescing, and the
races between connect, refresh, and revoke. Today that sequencing exists in at least three
divergent forms (supabase's in-flight refresh promise, google's `#credentialUpdate` chain,
ironclad's generation counter in the internal repo), which is how sequencing bugs multiply.

### v1 scope decisions (agreed)

- **New package `@gadgets/gatekeeper-kit`**, private, non-deployable (no `wrangler.jsonc`).
  `@gadgets/backend-utils` is not touched; it stays a logging/observability package with no
  `workshop-shared` dependency.
- **Layer 2 parity goal: port `gatekeeper-supabase`** to the assembly, keeping every export name and
  the entire `wrangler.jsonc` (including migrations) byte-identical, and keeping live account DO
  storage readable through explicit legacy-key options.
- **Layer 2 second consumer: `mcp-shared`** drops its private copies of nonce and HTML modules in
  favor of the kit's leaf modules. No other existing gatekeeper is modified; follow-up PRs port
  them one at a time.
- **Cloudflare Access stays out.** Internal gatekeepers authenticate through Cloudflare Access;
  that flow lives in the internal repo and will later be expressed as an `AuthStrategy`
  implementation. The seam is designed for it (see §5, `./auth`), but no Access code ships here.
- **Simulation primitives ship pure and unwired.** `createSimulationView`, `replaySimulation`, and
  `ProvisionalIds` land as tested leaf modules; no gatekeeper is ported to them in this change.
- **Layer 2 rewrites the `write-gatekeeper` skill kit-first** after the consumer cutovers, since the
  skill is the primary manual for agent-authored gatekeepers.
- Explicit follow-ups, not in scope: repo conformance checks over gatekeeper `wrangler.jsonc`
  files, a `create-gatekeeper` generator, ports of the remaining gatekeepers, and the batch
  `applyActionsThrough` action contract (its journal-shaped prerequisites are built here).

## 2. Background: relevant existing code

| Concern | Location |
|---|---|
| Canonical gatekeeper RPC contract | `packages/workshop-shared/src/gatekeeper.ts` (`GatekeeperVendor` :445, `GatekeeperUser` :567, `Gatekeeper` :698, `ApprovalQueue` :934) |
| Reference OAuth boilerplate (the duplication) | `packages/gatekeeper-supabase/src/supabase.ts:267-672`, `packages/gatekeeper-github/src/github.ts:931-1333` |
| Shared-base precedent (symbol hooks, undecorated bases) | `packages/mcp-shared/src/user.ts:30-38`, `src/facet.ts`, `src/account.ts`, `src/http.ts` |
| Facet instantiation via `ctx.facets`, props-complete classes | `packages/workshop-backend/src/overseer.ts` (`addGatekeeper`), `user.ts:1666-1691` (policy chokepoint) |
| Build-time RPC validation | `capnweb-validate` (`wrangler.jsonc` build command in every gatekeeper; vite plugin in workerd test configs) |
| workerd test harness + facet access from tests | `packages/gatekeeper-cloudflare/vitest.worker.config.ts`, its `__tests__/` `TestHooks` DO |
| `ctx.exports` typing | generated `worker-configuration.d.ts` `Cloudflare.GlobalProps` (e.g. `packages/gatekeeper-supabase/worker-configuration.d.ts:6-12`, `packages/gatekeeper-mcp/src/env.d.ts`) |
| Cursor implementations to generalize | `packages/gatekeeper-github/src/github.ts:809-929` |
| Existing simulation shapes (design inputs) | `packages/gatekeeper-homeassistant/src/simulation.ts`, `packages/gatekeeper-confluence/src/confluence-actions.ts`, `packages/gatekeeper-notion/src/notion-actions.ts` |
| Agent-facing authoring guide to rewrite | `.agents/skills/write-gatekeeper/SKILL.md`, `SKELETON.md` |

## 3. Concepts & terminology

- **Leaf module:** a Layer-1 primitive with no dependency on the assembly. Declares the narrowest
  structural KV surface it needs (`get`/`put`/`delete`/`list` subsets of
  `DurableObjectStorage["kv"]`), never the full storage type.
- **Assembly:** the Layer-2 spec, strategies, HTTP handler, and base classes. Built only on leaf
  modules.
- **Auth strategy:** the pluggable object that turns a verified connect attempt into stored
  credentials. The kit ships `oauth2` and `tokenAuth`; Cloudflare Access and other exotic flows
  implement the same interface elsewhere.
- **Grant death:** a provider response that proves the stored grant is gone. For OAuth this is an
  RFC 6749 §5.2 token-error response — HTTP 400, or 401 for client authentication, or an
  `invalid_grant`/`invalid_token` error code. A 403 WAF page, a 404, an unexpected redirect, a
  malformed 2xx, or a network failure is infrastructure, and must never destroy stored
  credentials. Strategies signal grant death by throwing `CredentialsExpiredError`; everything
  else propagates with credentials intact.
- **Identity fencing:** a refresh result is committed only if the stored credential record is
  still the one the refresh started from, so a stale refresh cannot clobber a newer reconnect.
- **Attempt generation:** a random value stored when a connect attempt starts and re-checked after
  every `await` inside the attempt. `revoke()` and a newer attempt clear it, so a token exchange
  that races a revoke can never write credentials back after `deleteAll()`.
- **Expiry latch:** the `"expiredNotified"` flag that keeps `credentialsExpired()` to one
  notification per expiry. The latch is set only after the callback RPC succeeds; a crash
  mid-notification re-notifies later (harmless per the contract), whereas a latch claimed before
  the RPC could be stranded set and silence every future expiry.
- **Observer strategies A–D:** the four admission policies from the `write-gatekeeper` skill —
  private-only, single-unit ACL check, tracked data sets with forward exclusion, and open.

## 4. Layer 1: leaf modules

Each module is a subpath export (`@gadgets/gatekeeper-kit/<name>`), mirroring
`packages/mcp-shared/package.json`. Seven files are internal instead: `serial-queue` (§4.12);
`action-journal` and `observer-tracker`, split out of `actions` and `observers` and reached through
their owning subpaths; `positive-int` — one `requirePositiveInt` shared by every module that takes a
bound; `kv` — the three KV surface slices the leaves name, since seven modules had begun to carry
byte-identical structural copies; `single-flight` — the in-flight coalescer four leaves had
hand-rolled, on the same reasoning as `serial-queue`; and `per-storage` — the
process-local-value-per-storage-object helper behind credential refresh and notification
single-flights and observer claim counts.

One spec discipline applies to every section below: a behavioral sentence must name the surface
that carries it in the adjacent method list. Behavior with no named carrier is a spec bug (three
instances were found this way: `markApplied`, `resolved`, and the retention derivation).

### 4.1 `./connect-nonce`

```ts
export const NONCE_BYTES = 32;
export const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
export const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
export const CONNECT_TIMEOUT_MS = 60 * 60 * 1000;
export const ACCESS_TOKEN_SAFETY_MS = 60 * 1000;
export function hexEncode(bytes: Uint8Array): string;
export function generateNonce(): string;                       // hex over crypto.getRandomValues
export function constantTimeEqual(a: string, b: string): boolean;  // crypto.subtle.timingSafeEqual
export type TimedNonce = { value: string; expiresAt: number };
export function isLiveNonce(stored: TimedNonce | undefined, presented: string, now: number): boolean;
```

`constantTimeEqual` uses the native `crypto.subtle.timingSafeEqual` after an encoded-length check
(the length is public: every nonce is 64 hex characters). The native API exists only in workerd,
which is why this module's tests run in the workerd vitest project (§6).

`isLiveNonce` fails closed on a malformed stored record: a non-string or empty `value`, an empty
`presented`, or a non-finite `expiresAt` all deny. An absent `value` encodes to the same empty
buffer an empty `presented` does, so a corrupt record would otherwise admit — and a capability
check may not have a fail-open branch. The encoder is module-scoped, since this runs on the auth
path.

### 4.2 `./connect-handshake`

The two-stage connect nonce machine that every OAuth gatekeeper currently re-implements
(`supabase.ts:380-425` is representative). Function-based so partial adopters can take only
`isLiveNonce` or only the constants.

```ts
export const NONCE_KEY = "nonce";               // unchanged from every current gatekeeper
export type ConnectStage = "initiation" | "oauth";
export type StoredNonce<Extra extends object = Record<never, never>> =
  TimedNonce & { stage: ConnectStage } & Extra;
export function putInitiation(kv, initiationNonce: string, now: number): void;
export function advanceToOAuth<Extra extends object>(
  kv, initiationNonce: string, now: number, extra?: Extra & NonceExtra): string | null;
export function claimOAuth<Extra extends object>(
  kv, oauthNonce: string, now: number): StoredNonce<Extra> | null;
```

`advanceToOAuth` verifies the initiation nonce (constant time, TTL, stage) and mints the OAuth-stage
nonce in one synchronous step, so exactly one concurrent caller can advance a given attempt.
`claimOAuth` is one-shot: it deletes the record on success and returns it so callers can read
`Extra` fields (PKCE verifier, requested scopes). The stored shape matches the `StoredNonce` every
existing OAuth gatekeeper writes (`mcp-shared` is the exception: `account.ts:118` also carries a
`"connecting"` stage, which step 12 leaves in place). `Extra` stays flat rather than nested under a
property; the reserved keys (`value`, `expiresAt`, `stage`) are intersected onto
`advanceToOAuth`'s `extra` parameter, which both excludes them statically and rejects them at
runtime. The exclusion lives on the parameter rather than the `Extra` constraint: as a constraint
it is a weak type, which defeats inference and collapses `StoredNonce<Extra>` to `never`.

### 4.3 `./connect-pages`

The browser pages and request guards used during connect. Exports `escapeHtml`,
`htmlResponse(body, status = 200)`, `connectMutationError(req, options)`, `SELF_CLOSING_HTML`,
`INVALID_LINK_HTML`, `errorPageHtml(title, detail)`, and `PAGE_STYLE`.

`htmlResponse` sets `Cache-Control: no-store`, `Content-Security-Policy: frame-ancestors 'none'`,
`Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`.
Connect pages open in their own tab and are never framed (the srcDoc-framed surfaces are gatekeeper
app UIs, a different module entirely), a connect URL carries a nonce that must not leak via
`Referer`, and an error page
interpolating provider text must not have that text sniffed into another content type. `no-store`
is there because the URL's path segment *is* the bearer capability and the page may echo account
identifiers, so a shared cache holding either turns a one-shot link into a readable artifact; the
Marketo branch sets it (`connect-ui.ts:32-40`) and every OAuth gatekeeper in this repo omits it.
They belong on the helper rather than each call site for the same reason `PAGE_STYLE` does: a
vendor form inherits all four without remembering them. This flows on to mcp-shared's connect form
at step 12.

`connectMutationError(req, { origin, contentType })` classifies a browser mutation on one of those
capability URLs, answering `"cross-origin"`, `"unsupported-content-type"`, or `undefined`; the
caller renders its own refusal, since Marketo answers JSON 403/415 while a form-based flow answers
HTML. A **missing** `Origin` is refused, not waved through: browsers send it on every POST, so its
absence means a non-browser caller on a URL whose whole authority is that a browser followed a
link. This is the third copy of the same check — Marketo's `checkMutation`, and
`workshop-backend/src/client-errors.ts:100-104` — and homeassistant, which accepts POSTs on its
connect route, has none.

The expected `origin` is **required and explicit** rather than derived from `req.url` (the shape
client-errors uses): the form's action URL is built from the configured base URL, so the legitimate
browser `Origin` is that URL's origin by construction, while the origin the Worker sees is whatever
host the request arrived on — the shipped base-path guard (`supabase.ts:270-273`) deliberately
compares only the path for the same reason. A deployment fronted by a host-rewriting proxy would
403 every connect submission under the derived form, in production only. A full base URL is
accepted; only its origin is compared. `handleGatekeeperHttp` (§5.5) computes `baseUrl` already, so
Layer 2 passes it through.

`contentType` names a media type and is compared **exactly**, parameters dropped and case folded.
Substring matching looks equivalent and is not: `application/jsonp` contains `application/json`,
and so does the parameter in `text/plain; x=application/json`, while a genuine
`multipart/form-data; boundary=…` still has to pass.

`PAGE_STYLE` is a shared page frame whose palette tokens (light and dark) are copied from
`packages/workshop-frontend/src/styles.css`, exposed as CSS variables so a gatekeeper with a form
(the `tokenAuth` strategy, or a hand-written page) can extend it. These pages open in their own
tab, outside the Workshop, so they cannot use Tailwind or Kumo; only the base palette is copied,
never the deployment's admin-chosen accent. Vendor-specific wording stays in the vendor:

```ts
const NOT_CONFIGURED_HTML = errorPageHtml(
  "Supabase Gatekeeper Not Configured",
  "Please configure a Supabase OAuth app client ID and secret for this gatekeeper.");
```

### 4.4 `./credential-expiry`

```ts
export async function notifyCredentialsExpiredOnce(
  kv, callback: Fetcher<GatekeeperConnectCallback> | undefined, vendorId: string): Promise<void>;
export function clearCredentialExpiryLatch(kv): void;
```

`notifyCredentialsExpiredOnce` never throws (callers await it and then throw their own "please
reconnect" message, which a broken stored callback must not replace with an RPC error). It marks
the latch **only after** `callback.credentialsExpired()` resolves — and only if no reconnect re-armed
it meanwhile, which would otherwise silence the new credentials' first expiry. Concurrent callers
dedupe onto one in-flight notification *per arm*, so a caller arriving after a re-arm gets its own
notification rather than the one already awaiting a callback for the credentials just replaced. That
entry is released by the caller that installed it, never by the notification itself: a stub that
throws before returning a promise settles inside the frame that started it, and a release attempted
there would run before the entry existed — leaving a resolved one behind that silences the arm.
"Never throws" includes its own storage reads: a failing latch must not replace the caller's
reconnect message either. The ordering matters: claiming the latch before the
RPC leaves a crash window in which the latch is set but nobody was notified, permanently
silencing the account. With mark-on-success, the worst crash outcome is a duplicate notification,
which the `GatekeeperConnectCallback` contract explicitly tolerates. Failures log `warn` with
event `credentials.expiry.notify.failed` and the caller's `vendorId` via
`@gadgets/backend-utils/logger` (component `"gatekeeper.connect"`). Existing stored `true` latch
values remain honored.
`CredentialCoordinator.connect()` calls `clearCredentialExpiryLatch` itself before installing a new
connection; the standalone export remains for hand-written account implementations.

The latch key is `"expiredNotified"` — unchanged from every current gatekeeper — but **module-private
rather than exported**: every latch in both corpora is that literal, ports adopt the two functions
above, and no external writer remains, so exporting it only invites one. The compat test restates
the literal, which is what fences a rename against live accounts.

### 4.5 `./http-errors`

`HttpError(status, message)`, `isNoAccessError(e)`, and `probeAccess(check)`. `isNoAccessError`
returns true only for a numeric `status` property of 401, 403, or 404 — never by parsing message
text, which could match a code embedded in a 5xx body. Errors without one of those statuses must
be rethrown by callers, never treated as "no access". `probeAccess` wraps an ACL probe in exactly
that policy.

`probeAccess`'s callback should throw to report failure, but the likeliest misuse —
`probeAccess(() => fetch(url))`, where `fetch` resolves for HTTP errors — is guarded at runtime: a
resolved non-ok `Response` is classified by status like a thrown error rather than read as access.
No legitimate caller signals access by resolving with a non-ok `Response`, and throw-style callers
(all nine internal ones below throw an `HttpError` from their API client) pay nothing. Typing the
callback `Promise<void>` could not have closed it: TypeScript accepts any return type in a `void`
position, so `() => fetch(url)` still assigns.

This module stays, and the evidence is worth recording so a later pass does not re-litigate
deleting it as consumerless: the internal repo's `gatekeeper-shared/src/observers.ts:27-56` exports
this exact trio, and nine internal gatekeepers call `probeAccess` from their verifiers (backstage,
gitlab, ironclad, jira, kibana, prometheus, sentry, slo-directory, zinc; clickhouse uses
`isNoAccessError` inline). Public google, github, and confluence do the same 401/403/404
classification ad hoc. Ports consume it directly.

### 4.6 `./credentials`

Durable credential storage and the refresh discipline, for the `UserAccount` DO side and the
consumer side respectively:

```ts
export class CredentialsExpiredError extends Error {
  readonly code = "CredentialsExpiredError";           // transport-stable mark; name mirrors it
  constructor(message: string, opts?: { cause?: unknown });
}
export class CredentialsChangedError extends Error {   // credentials replaced mid-operation: the
  readonly code = "CredentialsChangedError";           // failure was stale and the caller re-enters.
  constructor(opts?: { cause?: unknown });             // Fixed display-safe message
}
export function isCredentialsExpired(e: unknown): boolean;  // matched by name or code: the RPC
export function isCredentialsChanged(e: unknown): boolean;  // transport strips classes, and capnweb
                                                            // rebuilds errors keeping enumerable own
                                                            // props but not the name — code survives

export type RejectionVerdict = "expired" | "superseded" | "unavailable";
  // expired     — grant gone: provider-confirmed death (the account owns announcing it; delivery
  //               never adjudicated) or a disconnect discovered during adjudication (never notifies)
  // superseded  — a live successor replaced the rejected identity: refresh, heal, or reconnect
  // unavailable — the heal failed for non-credential reasons; nothing adjudicated, and the source
  //               rethrows the caller's original provider error

export class CredentialCoordinator<Creds> {                  // lives in the UserAccount DO
  constructor(kv, opts: {                // keys are fixed: "credentials", plus ":identity" and
    expiresAt?(c: Creds): number | undefined;      // finite or absent; ":migrated" beside it
    refreshSkewMs?: number;              // default ACCESS_TOKEN_SAFETY_MS
    legacyKeys?: readonly string[];      // every key the pre-kit layout owns; reaped after the
                                         // canonical record exists and again by clear(), so the
                                         // reap is idempotent and a failed delete is retried
    upgrade?(kv: Pick<CredentialsKv, "get">):          // lazy legacy-key migration, READS ONLY:
      Creds | undefined;                 // reassembles the grant those keys hold. Retired by
                                         // clear(), so a clear() (or a restart after one) cannot
                                         // resurrect a grant since replaced or revoked
    discardMint?(mint: Creds): void | Promise<void>;  // awaited when a reconnect or revoke wins
                                         // the identity fence after a successful mint; errors are
                                         // logged as credentials.mint.discard.failed, never rethrown
    vendorId?: string;                   // log attribution for the heal-failure/overtaken logs
  });
  stored(): Creds | undefined;   // mints an identity for a record that predates them, so credentials
                                 // and a fence are always surfaced together
  connect(creds: Creds): void;   // a (re)connect's install: rotates the connection generation,
                                 // then commits (expiry-latch re-arm + identity rotation + record
                                 // write). Refresh commits internally through fresh()/rotate();
                                 // there is no public commit
  clear(): void;                 // retires the migration, rotates the identity and the connection
                                 // generation (rather than deleting them), THEN drops the record
  identity(): string;            // random per write; opaque, equality only. "" is reserved for a
                                 // never-connected read, always adjudicates "superseded", and must
                                 // never front credentials from a hand-written getCredentials
  connectionGeneration(): string; // survives refresh, rotated by connect()/clear(); the cache
                                 // authority (§4.10) and the account half of the action fence (§4.8).
                                 // Minted on first read, never ""
  fresh(refresh: (current: Creds) => Promise<Creds>): Promise<Creds>;
  rotate(refresh: (current: Creds) => Promise<Creds>): Promise<Creds>;   // refreshes now, whatever
                                 // the recorded expiry says: the provider rejected an unexpired
                                 // credential, and it is the only authority that matters
  snapshot(refresh, opts?: { notify?: () => Promise<void> }):
    Promise<CredentialsWithIdentity<Creds>>;   // the account's getCredentials half: fresh(), then a
                                 // SYNCHRONOUS re-read of record + identity + generation, so the
                                 // triple is atomic against a connect() landing at the await
                                 // boundary — the reason the helper lives here. A confirmed expiry
                                 // of the still-stored grant awaits notify (§4.4's latch) before
                                 // rethrowing — a reconnect landing mid-notify replaces the death
                                 // and the fresh triple is served, while a disconnect landing
                                 // there reads as not connected with the death as its cause; a
                                 // disconnect is a user action and never notifies
  adjudicateRejection(identity, opts: { refresh?; notify }): Promise<RejectionVerdict>;
                                 // the account's reportCredentialsRejected half. "" (never-
                                 // connected) answers "superseded"; every other moved fence
                                 // resolves by successor — "superseded" when one is stored,
                                 // "expired" when a disconnect left none (never notifying for the
                                 // disconnect itself). No refresh means a grant-death provider:
                                 // notify, "expired". Otherwise heal via rotate() — fence-keyed,
                                 // so concurrent heals share one mint: success → "superseded";
                                 // confirmed death → notify, "expired" (the fence re-checked
                                 // after the notify await resolves a mid-notification reconnect
                                 // or disconnect by successor again); any other mint failure →
                                 // logged account-side, "unavailable" (credentials intact),
                                 // unless the fence moved meanwhile. No durable
                                 // dead-grant mint latch: a repeat report costs one doomed provider
                                 // call answering invalid_grant again, and notification is deduped
                                 // by notifyCredentialsExpiredOnce's own latch — a port that
                                 // measures mint spam adds a cooldown inside its refresh callback
}

export class CredentialSource<Creds> {          // held by User entrypoint / facet / verifier
  constructor(opts: {
    account: () => AccountCredentialStub<Creds>;   // { getCredentials(): Promise<CredentialsWithIdentity<Creds>>;
                                 //   reportCredentialsRejected(identity): Promise<RejectionVerdict> —
                                 //   an adjudication of identity, never of notification delivery
                                 //   (that is the latch's, §4.4). A malformed or lost answer is
                                 //   "unadjudicated": the source rethrows the caller's original
                                 //   provider error and never dead-marks the identity. A structural
                                 //   two-method type: the coordinator helpers are the reference
                                 //   implementation, and a hand-written stub owns their invariants —
                                 //   atomic triple under a non-"" identity (the source refuses a ""
                                 //   read), moved-past gate, heal fenced on the rejected identity,
                                 //   honest verdicts }
    isAuthError(e: unknown): boolean;              // credential rejection — the provider refusing
                                 // the presented credentials — never a per-resource denial; the
                                 // account's heal inside the adjudication, not the classifier,
                                 // tells a stale derived bearer from a dead grant
    expiredMessage: string;
    vendorId?: string;                             // log attribution
  });
  get(): Promise<Creds>;       // reads the account; concurrent reads coalesce onto one round trip
  read(): Promise<CredentialRead>;  // coalesces on the same account read as get()/run(), returns a
                                    // fresh { identity, generation } object and never credentials
  run<T>(fn: (creds: Creds, read: CredentialRead) => Promise<T>,
    opts?: { replayable?: boolean }): Promise<T>;  // hands the call its creds plus a fresh
                                 // { identity, generation } read object — the action-fence capture,
                                 // since authority() can move mid-operation — and resolves a
                                 // confirmed rejection through the account's verdict: "expired" →
                                 // CredentialsExpiredError(expiredMessage); "superseded" → retry
                                 // once when `replayable`, else CredentialsChangedError;
                                 // "unavailable" or an internal "unadjudicated" answer → the
                                 // caller's original provider error. At most two
                                 // executions; an auth failure under an identity a refetch has
                                 // since superseded with a live successor is stale and re-enters
                                 // without an ask (§4.13)
  authority(): string | undefined;  // the connection generation of the last fetch, synchronously —
                                 // named for its facet-side cache-authority role, wired through
                                 // KvTtlCache.partitionedBy (§4.10). undefined before the first
                                 // fetch, and from a reported — or superseded-answered — rejection
                                 // until a fetch started after
                                 // the report adopts an undead identity: partition unknown, so a
                                 // cache keyed on it bypasses rather than serves. Last-seen and
                                 // shared — never the action-fence capture, which rides the
                                 // CredentialRead of its own run attempt
}
```

A defined `expiresAt` must be finite. `Infinity` makes the grant permanently fresh so `fresh()`
never refreshes it, and `NaN` fails every comparison so it refreshes on every call. Both are
reachable from one ordinary bug — `Date.parse` on a provider expiry string it did not recognize —
and both are silent, so the projection is checked where it is read rather than trusted.

There is no `key` option, no `cacheTtlMs`, and **no consumer-side cache**. No consumer in either
corpus needs a different canonical key — a split or foreign legacy layout migrates through
`upgrade()`, the mechanism supabase and any `cfAccessToken`-cohort port already require regardless.
And a settled cache is not the corpus discipline either: across 33 packages no gatekeeper caches a
credential on a fixed wall clock, 21 fetch from the account on every provider request
(`github.ts:1392-1395` → `github-api.ts:231-238`), and the three that do cache gate on the
*provider-issued expiry* rather than a fetch timestamp (google expiry−60s, supabase expiry−30s,
slack expiry−5m). The rest do not have the shape at all: three snapshot a bearer at session
construction (homeassistant, http, gtmdata), two resolve once per MCP operation, and four have no
connected-account credential path. So every operation reads the account's current
`{ creds, identity, generation }`, and the only
sharing is coalescing the concurrent reads one operation makes onto a single in-flight round trip.
The `generation` riding along is `connectionGeneration()`: the source records the last-seen value
and surfaces it synchronously as its `authority()` — named for the role, in the cache's own
vocabulary — which is what lets `KvTtlCache.partitionedBy(kv, source)` partition a facet-side cache
by principal (§4.10) without an extra account round trip per cache read. A
fixed TTL would instead keep a live facet serving a stale principal across a reconnect for the
length of the window. An expiry-gated cache is the shape to add if measurement ever demands one, and
it needs an `expiresAt` projection the stored/public credential split does not carry today (§10).

The migration marker is written by `clear()` and by an `upgrade()` that found nothing, and nowhere
else. While a canonical record exists, `stored()` never consults the migration path, so the marker
only has to be durable once that record is gone — and `clear()` is the only kit path that removes
it. (The `deleteAll()` behind `revoke()` wipes the legacy keys too, so an upgrade re-run after one
finds nothing and re-marks.) Keeping it off the commit path saves a KV write per successful refresh.

`clear()` writes it **whether or not an `upgrade` is configured**. Conditioning it on the option
saved one write on a path taken once per disconnect, and bought a trap: a deployment that ships the
kit without a migration and adds `upgrade` in a later release would find no marker on an account
that had since disconnected, re-run the migration against whatever legacy keys that disconnect left
behind, and resurrect a grant the user revoked.

**Write order is load-bearing in both mutators.** An implicit Durable Object transaction is atomic
against machine failure but is *not* rolled back by a throw, so the order decides what an unusually
placed storage failure leaves behind. The fence goes first: the commit rotating before it publishes
can only lose the new record, with every in-flight refresh already fenced out, whereas publishing
first could leave the new record readable under the *old* fence and let a stale refresh commit
straight over a reconnect. `connect()` prepends the connection-generation rotation for the same
reason: a failure between its writes over-invalidates generation-keyed consumers, where the other
order serves the new principal under the old generation. `clear()` follows the same rule with the
record last, which closes two
resurrection paths rather than one — dropping the record first can bring it back either from an
in-flight refresh whose fence still matches, or from an `upgrade()` re-run that the not-yet-written
marker permits. Both orders are pinned by tests that fail if the statements are swapped back.

`fresh()` returns the stored credentials when they are outside the skew window; otherwise it
coalesces concurrent callers onto one in-flight refresh. The flight is keyed by the storage object
rather than the coordinator instance, so a port constructing a coordinator per call still
coalesces — two concurrent rotates would otherwise each spend the same single-use refresh token,
and the loser's `invalid_grant` would read as grant death. It is identity-fenced on **both paths**:
it snapshots the stored record before awaiting, and commits a result only if the store still
holds that exact record — on a mismatch, a successful mint is handed to
`CredentialCoordinatorOptions.discardMint`, awaited, and then the coordinator returns the newer
stored credentials when present or throws `CredentialsExpiredError` when the store was cleared.
The handler is the provider-side drain for a mint that will never be stored; a throw is logged as
`credentials.mint.discard.failed` and never changes that result (`credentials.ts:139-145,332-378`).
The failure path carries the same fence, but **only for grant death**: a
`CredentialsExpiredError` propagates when the identity is still current and otherwise re-reads the
store (newer credentials → return them; cleared → propagate), so grant A's stale death can never
expire grant B. Every other refresh error propagates untouched (grant death vs. infrastructure,
§3) — fencing those would swallow an outage that raced a reconnect, and reclassify one that raced a
`clear()` as expiry. Refresh is not transactional against provider-side rotation: a crash between
the provider rotating a token and the commit persisting it can lose the new token. The README
documents this; nothing in the API may promise otherwise.

`CredentialSource.run` resolves the credentials, hands them to the operation together with a fresh
`CredentialRead` — `{ identity, generation }`, constructed per attempt, never the source's internal
triple — and captures the read before awaiting. When `isAuthError(e)` is true, `run` resolves the
rejection through `account().reportCredentialsRejected(identity)` — the account's authoritative
verdict, with any healing done *inside* that ask (§4.13). `"expired"` throws
`CredentialsExpiredError(expiredMessage, { cause: e })`, adding that identity to a dead set
(per-activation and
never evicted: growth is bounded by account commits, and stale failures mark identities out of
commit order, so no eviction order is safe): the account keeps the grant until reconnect, so a
refetch returns the same identity,
and re-adopting its generation would let cache hits mask the outage — while a fetch already in
flight at the report is fenced out entirely, since a straggler can carry any old identity. A fetch
started after the report, adopting an identity not in the dead set (successful refresh or
reconnect), re-establishes the authority. Expiry also surfaces through the fetch itself — a failed
refresh rejects `getCredentials()` with an error marked `CredentialsExpiredError` — and the source
drops the authority there too, under the same fence so a straggler's stale rejection cannot clear a
revived partition. `"superseded"` — a live successor already replaced the rejected identity, or
the account just healed past it — resolves as `CredentialsChangedError` with the authority left
unknown, or,
under `replayable`, as one internal retry: a fresh account read (the ask's fence bump forgot the
pre-ask flight, and the single-threaded account answers after the heal's commit), refused as
"changed" when its generation moved (a reconnect — never run under a principal the caller didn't
start with), resolved as expiry without a provider call when it re-serves a dead-set successor
the source last stood behind, refused as "changed" when the refetch was not itself adopted (a
fenced-out response is stale evidence that can postdate a reconnect the source already adopted,
with no adoption of its own to act on), refused as "changed" when its identity did not move (a
lazy account re-served the rejected credentials, whose refetch's own adoption is dropped again so
cache-first re-entries bypass rather than serve the partition it failed to defend), and otherwise
a second execution whose own rejection is adjudicated but never retried — at most two executions.
`"unavailable"` rethrows the caller's original provider error: nothing was adjudicated, and the
heal's own failure lives in the account's logs. When a concurrent refetch has since adopted a
**live successor** — a different
identity not itself in the dead set — the failure is stale: reporting it would expire the grant
that replaced the one the call used, and clearing the authority would drop the live grant's
partition, so `run` reports nothing and clears nothing. A replayable operation whose successor
shares the read's generation — a heal of the caller's own principal — retries once under it, no
ask spent; otherwise (non-replayable, or a moved generation marking a reconnect) `run` throws
`CredentialsChangedError` instead. A
bare identity mismatch is not enough: a fetch fenced out by the report still hands its credentials
to its caller without adopting them, and when those fail too, nothing live succeeded them — the
failure is fresh evidence and goes to the account for adjudication, or a later refetch would
re-adopt the dead grant. If that account hop fails or returns a malformed verdict, the internal
answer is `"unadjudicated"`: `run` rethrows the provider error it was resolving and does not
dead-mark the identity (`credentials.ts:735-768`). Everything else passes through. Callers wanting
own retry policy skip `replayable` and match `CredentialsChangedError`/`CredentialsExpiredError`
(`isCredentialsChanged`/`isCredentialsExpired` — matching `name`, or the `code` that survives the
transports that strip it) in a plain loop; the source itself is optional, and a port that only wants coordinated storage uses
`get()` or the stub directly.

**`isAuthError` is the one classifier the agent can aim.** It decides that the provider *rejected
the credentials* — and the account's heal inside the rejection adjudication then tells a stale
derived bearer from a dead grant — while
the agent chooses which operations run — so a classifier matching bare 401/403 lets it retire a
healthy connection by requesting one resource the grant does not cover, and the user is prompted to
reconnect something that never broke. Per-resource denials are `isNoAccessError`'s job (§4.5); this
one wants the provider's credential-invalid signal, the same RFC 6749 §5.2 doctrine
`CredentialsExpiredError` carries on the refresh path. The option's doc comment says so, and the
skill rewrite (§7 step 16) repeats it where config authors will be reading.

That invalidation drops the **in-flight** fetch. The fetch was started
against the credentials the failure just reported dead, so leaving it in place would let a caller
arriving afterwards await it and receive them anyway; a caller already awaiting it is in the same
position as any caller holding credentials when they die, and handles its own auth failure.

### 4.7 `./observers`

The observer-verification primitives, plus the strategy objects the assembly consumes.

```ts
export function asVerifier<T>(user: unknown): T;    // the one sanctioned cast, with justification
export const OBSERVER_DENIED: string;               // default denial text
export type ObservationCheck = {
  excludeObservers?: string[]; commit(): void; discard?(): void; abandon?(): void;
};   // exactly one runs synchronously: discard only after a marked refusal; abandon on an unknown
     // outcome releases in-memory bookkeeping but keeps durable fences

export type ObserverTrackerOptions<V> = {
  kv;
  setPrefix?: string;                   // observed-set records; default "observed:"
  canonicalSetId?(setId: string): string;             // identity when omitted; applied once, at entry
  verifyBaseline?(verifier: V): Promise<void>;        // throwing coarse membership check, ADMISSION ONLY
  hasSetAccess(verifier: V, setIds: readonly string[]): Promise<boolean[]>;   // batched; copied
  denyMessage?(setId: string): string;                // default OBSERVER_DENIED; keep it generic —
                                                      // shown verbatim to the denied collaborator
  vendorId?: string;                       // log attribution
  maxTrackedSets?: number;              // default 1000; refuses to reveal set 1001
  maxObservers?: number;                // default 10; refuses to admit observer 11
  concurrency?: number;                 // default 6; concurrent verifier round trips
};
export class ObserverTracker<V> {
  addObserver; removeObserver; prepareObservation; prepareWithheld; observerIds
}
export class ObservationGate implements Disposable { authorize; actions; [Symbol.dispose] }  // owns the dup
// Storage: `observer:<id>` admitted, `observer-attempt:<id>` + `observer-nonce:<id>` mid-admission,
// `observer-withhold:<nonce>` per withheld read in flight, `observer-withheld` latched closed.
// Modules: the tracker and its storage vocabulary live in `src/observer-tracker.ts`, the strategies
// and the gate in `src/observers.ts`, which re-exports the tracker so `./observers` stays the one
// public subpath.
```
`addObserver` awaits `verifyBaseline` first — the consumer throws its own baseline error, so the kit
never has to decide what a non-`true` answer meant (`aclObservers` takes the answering shape instead,
and admits only a literal `true`) — then verifies the observer against every tracked set, looping
and re-reading until no unchecked sets remain, so sets that appear mid-check are also verified — and
only then persists the verifier under `observer:<id>`. A failing set throws `denyMessage(setId)`,
and the overseer shows that text verbatim to the denied collaborator — so it stays generic like the
default, as every shipped multi-set gatekeeper's does: naming the set would disclose to a party
without access that this workspace read it. The `setId` argument is for diagnostics.

**Port-time deployment requirement.** `trackedSetObservers` persists the verifier capability under
`observer:<id>`, so a worker using it must set `compatibility_flags:
["allow_irrevocable_stub_storage"]` — every shipped gatekeeper already does, and without it the
first `addObserver` fails with `DataCloneError: ServiceStub cannot be serialized in this context`.
Only a *persistent* stub qualifies: the overseer's verifier is a `WorkerEntrypoint` behind a service
binding, while an ad-hoc `RpcTarget` has no durable address and is refused whatever the flag says.
The Node fake cannot model any of this (§6), so a workerd suite carries it.

`prepareObservation(sets)` marks
newly-revealed sets `"pending"` before any `await` (so a concurrent `addObserver` sees them),
batch-checks every stored observer, and returns `excludeObservers` plus synchronous settlement:
`commit()` promotes the read's sets to `"observed"` after authorization; `discard()` reclaims only
the pending markers this check created after a marked refusal; `abandon()` releases only its
in-memory claims when the outcome is unknown, leaving durable markers in place.

**The oracle is asked about every set in the read, not only the newly revealed ones.** A verdict
recorded at first disclosure would otherwise be permanent, so an observer who lost provider-side
access to a set the binding had already shown them would keep seeing it. The accepted cost: re-reading
an already-observed set now costs one oracle call per admitted observer where it previously cost none.
It is one call per observer either way — only the id list grows — and a binding with no observers
still makes none, so the cost lands only on shared bindings, which is where the guarantee matters.

`verifyBaseline` stays **admission-only**. Running it per read would be N extra provider round trips
per observation, no corpus gatekeeper does it, and the one gatekeeper that re-checks a baseline at
all folds it into the batched set oracle (google, as `{ baselineAllowed, allowed[] }`) — which is
expressible today by returning all-`false` from `hasSetAccess`.

The observer prefix is `"observer:"` and is **not** configurable: every tracker in both corpora
(public linear, notion, confluence, slack, supabase, context, google; internal
`gatekeeper-shared/src/observers.ts`) stores verifiers there, and only the set family varies —
`observedProject:`, `observedCollection:`, `observedTeam:`, `observedItem:`,
`trackedConversation:`, `observed:` — which is what `setPrefix` exists for, so the ported supabase
organization binding keeps reading its existing `observedProject:` rows. The constructor throws
when `setPrefix` overlaps `"observer:"` in either direction, which also rejects the empty prefix:
overlapping families scan into each other, returning set ids as verifier keys and handing stored
verifiers to `hasSetAccess` as set ids. A stored `true` always reads as "observed" with no opt-in
flag — the kit never writes `true`, its only source is a legacy record, and in every corpus case
that means observed.

`hasSetAccess` is batched because real oracles are: supabase answers N project refs with one
`/v1/projects` call. Because it is batched, **a verdict array whose length disagrees with the
question denies or excludes, in either direction.** A short answer already denied by reading
`undefined !== true`; an answer *longer* than the question used to admit, since the surplus entries
were never looked at — and index position is the only thing tying a verdict to a set, so a length
the oracle disagrees about invalidates every verdict in the array, not merely the extras. Google
asserts the same invariant before reading a batch result
(`gatekeeper-google/src/observers.ts:51-55`); the kit denies rather than throwing on the exclusion
path, so one broken verifier cannot fail an entire read. A verifier that *throws* is excluded the
same way and logged at `warn`: a stored stub outlives the workspace that supplied it, and rejecting
the batch would fail every observation this binding makes from then on.

**Each call gets its own copy of the batch.** Chunking it destructively —
`while (ids.length) ids.splice(0, N)` — is a legal oracle: it returns one verdict per set, in
order, which is the whole contract, and an oracle whose provider caps ACL lookups has to chunk
somehow. Shared, that array is a data leak rather than a style problem: the exclusion check
compares the verdict count against the *same* array the oracle emptied, so the comparison passes
vacuously and every observer after the first is admitted to sets nothing verified it against —
while the honest verifier, whose answer no longer matches the emptied question, is the one
excluded. A per-call `slice()` is one allocation beside a round trip the same loop is already
making, and it makes the fence independent of oracle etiquette. `readonly string[]` records the
intent for a port author; because method parameters are bivariant it does not enforce it, which is
why the copy is the mechanism and the type is only the documentation.

`addObserver` records the candidate under `observer-attempt:<id>` with a nonce before its first
await, writes the verifier only if that nonce is still current, and throws when it is not — a quiet
return would report an admission that did not happen, and an untracked observer is excluded from
nothing. Durable rather than an in-memory counter, so a `removeObserver` reaching a different
tracker instance over the same storage still cancels the admission. A stranded attempt does not hold
its `maxObservers` slot for good: each admission sweeps attempts past `OBSERVER_ATTEMPT_LIFETIME_MS`,
and one swept while its admission is still alive merely fails closed at its next nonce check and
retries.

The four strategies and the session-side gate:

```ts
export interface ObserverStrategy {
  addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void>;
  removeObserver(id: string): Promise<void>;
  prepare?(setIds: readonly string[]): Promise<ObservationCheck>;
  observerIds?(): string[];        // retained observers, candidates mid-admission included
  prepareWithheld(): ObservationCheck;    // enumerates and fences admission in one step. REQUIRED:
                                          // every strategy answers the owner-only question itself
}
export function privateObservers(message: string): ObserverStrategy;                       // A
export function aclObservers<V>(opts: {                                                    // B
  hasAccess(v: V): Promise<boolean>;   // answers rather than throws; only `true` admits
  denyMessage?: string;
}): ObserverStrategy;
export function trackedSetObservers<V>(opts: ObserverTrackerOptions<V>): ObserverStrategy; // C
export function openObservers(): ObserverStrategy;                                         // D

export function escapeObservationValue(value: string): string;
export type ObservationScope =
  | { kind: "baseline" }                        // admission already covers this disclosure
  | { kind: "sets"; ids: readonly string[] }    // per-set verification; an empty array is refused
  | { kind: "withholdFromObservers" };          // withhold from every admitted observer
export type ObservationInput = Omit<ObservationDescription, "excludeObservers">;
export class ObservationGate {
  constructor(queue: RpcStub<ApprovalQueue>, strategy: ObserverStrategy);
  authorize(input: ObservationInput, scope: ObservationScope): Promise<void>;
  get actions(): Pick<RpcStub<ApprovalQueue>, "submitAction" | "bindHook">;   // borrowed for action
                                         // staging; the gate keeps ownership. Narrowed so a raw
                                         // authorizeObservation cannot skip the strategy's exclusions
}
```

**The scope is explicit, and the gate owns `excludeObservers`.** The corpus has 195 authorization
sites and not one passes set ids to `authorizeObservation` itself; instead 8 of 10 tracked-set
gatekeepers authorize a binding-wide read with a literal `[]` meaning "reveals nothing per-set"
(`slack.ts:1178`, `jira.ts:1575`, `notion.ts:1450`, `confluence.ts:791`, `google.ts:3439`), while
Google Drive spells the *opposite* meaning the same way — `excludeObservers: this.#observerIds()`
then a throw (`drive-session.ts:271-276`). One spelling, two opposite meanings, exactly one
gatekeeper noticing. So `sets` refuses an empty array and names `baseline` as the way to say "the
admission baseline covers this", and `withholdFromObservers` is Drive's shape as a first-class arm.
The scope describes disclosure while the strategy decides policy: declaring `sets` under a strategy
with no `prepare` is a deliberate no-op, and choosing an ACL strategy for a resource whose children
carry independent ACLs is the unsafe act (`observers.ts:167-175`).

`authorize` resolves the scope to one `ObservationCheck` — `sets` → `strategy.prepare(ids)`,
`withholdFromObservers` → `strategy.prepareWithheld()`, `baseline` → no strategy call at all —
then calls `queue.authorizeObservation`, adding `excludeObservers` only when the check produced any.
It invokes `commit()` after authorization succeeds, `discard?.()` only when the failure carries
`OBSERVATION_REFUSED_CODE`, and `abandon?.()` for every unmarked error. `prepare` is absent on A/B/D,
which retain no per-set verdicts, so no exclusions there. `prepareWithheld` is **required** with no
fallback, because a silent no-exclusions default would let a misclassified strategy void the
caller's owner-only declaration — the failure would be a disclosure with no signal. A answers
vacuously (nobody is ever admitted); B and D throw, since their own premise is that an admitted
observer sees everything read here — a truthful owner-only read under them means the resource
belongs on C, and a read the premise covers should say `baseline`. Because the gate is the only
source of that field, there is no set-union merge left to do. Sessions call the gate for every read
instead of the raw queue.

**A proven refusal reclaims only this read's reservations.** For withheld reads, `discard()` deletes
the read's `observer-withhold:` marker. For set-scoped reads it releases the check's per-storage
in-memory claims and deletes only the `"pending"` markers that check created, only while no
concurrent read still claims the key and storage has not promoted it. One isolate owns a Durable
Object, and `perStorage` shares the counts across tracker instances over the same storage object
(`observer-tracker.ts:88-113,380-453`). An unmarked failure calls `abandon()` instead: claims go,
durable fences stay. A crash-stranded marker is deliberately permanent because the vanished
in-memory count cannot prove the overseer failed to record the observation.

Because the gate awaits the overseer after reading that list, C records a candidate under
`observer-attempt:<id>` before its first await and enumerates it as an observer: otherwise an
admission landing inside that round trip is absent from `excludeObservers` for a read that promised
to be owner-only. A removal or a later attempt rotates `observer-nonce:<id>`, which the admission
rechecks after every await, so the fence holds across separately constructed trackers.

**No arm maps to `prohibitAllSharing`.** That field is a permanent gadget-wide escalation, not a
per-read withholding: `authorizeObservation()` throws if the gadget is already shared, all future
sharing is prohibited, and the gadget enters lockdown where it "can no longer perform any actions,
only make observations" (`workshop-shared/src/gatekeeper.ts:1072-1087`). Firing that on a routine
empty search would disable the gadget's actions for good. `excludeObservers` is the per-observation
mechanism the overseer promises to enforce (`:1089-1106`). So `prohibitAllSharing` stays
**caller-set** and passes through untouched — four corpus packages set it on every read (gtmdata,
lighthouse, salesforce, town-lake) while ironclad is equally private-by-binding and deliberately
does not, because it has actions to run, so the gate cannot infer it.

**A withheld read closes admission.** `withholdFromObservers` covers the half `excludeObservers`
does — data read after observers were configured — and the read registers no tracked set, so C's
admission would have nothing to verify a later candidate against. The kernel does not leave that
open: `addObserver` "must verify that the given user is allowed to directly observe everything that
has been observed through this gatekeeper in the past" and "must throw an exception" otherwise
(`workshop-shared/src/gatekeeper.ts:753-777`). So the gate takes `strategy.prepareWithheld()`, whose
`commit()` latches `observer-withheld`, after which `addObserver` refuses with `OBSERVER_WITHHELD`.
The kernel sanctions the outcome — a gatekeeper is unshareable once it has made one of these
observations. Zero shipped gatekeepers persist this, and the closest precedent is stricter still:
Drive's empty search audits the read and then always throws
(`gatekeeper-google/src/drive-session.ts:260-283`), keeping the binding shareable by refusing to
serve. A consumer preferring that trade can still throw instead of reading.

**The latch is earned, and the fence is not the latch.** Latching before the round trip would spend
it on a refusal: the overseer rejects an observation outright whenever an excluded observer is still
an authorized collaborator (`overseer.ts:4590-4603`), which is the ordinary answer for a binding
that has any, so an unshareable binding would be the *normal* result of a read that disclosed
nothing and returned an error. Latching only after success needs something else to hold the window,
because the exclusion list is already sent and an `addObserver` delivered during the round trip
would be absent from it — and the window outlives the activation. `authorizeObservation()` stores
the description in the overseer's action log durably before its reply is released
(`overseer.ts:4482`, output-gated), v1 hides nothing per-viewer after the fact ("v1 has no
per-thread hiding", `overseer.ts:4460`), and `listActions()` serves the log to edit collaborators
unfiltered — so a crash before the latch lands would leave an owner-only description readable by
whoever is admitted next. `prepareWithheld` therefore writes a durable `observer-withhold:<nonce>`
marker, which the output gate orders ahead of the overseer call itself: no crash can leave the
record standing without the marker. `addObserver` refuses while any marker stands; `commit()`
latches and then deletes its marker, so no state has neither; `discard()` only deletes. A stranded
marker over-fences admission for good — the attempt record's fail-closed direction, but where the
attempt record ages out (`OBSERVER_ATTEMPT_LIFETIME_MS`), the marker deliberately has no TTL: its
expiry would reopen the window mid-read.

An earlier draft held the window with an in-memory count keyed by the storage object's identity, on
the theory that a fence only has to reach a *concurrent* admission. That mistakes where the window
ends — the overseer's record survives the activation, the count does not — and the identity keying
forced a "never wrap `ctx.storage.kv`" construction contract nothing could enforce. The marker is
plain storage, so both problems are gone.

**Open, to revisit with the restricted-data work.** Latching admission is the gatekeeper's half. The
Workshop's half — restricting the workspace itself, severing live sessions, blocking actions and web
fetches — needs `containsRestrictedData`, which `origin/restricted-data-rename` introduces by
renaming this field and inverting it from prohibition to per-collaborator verification re-checked at
every `open()`. That wants the field to exist first, and nothing consumes the kit yet.

There is **no `sanitize` hook.** Zero shipped gatekeepers sanitize a whole description; the two real
paths are per-value (`google.ts:1186`, `mcp-shared/src/tools.ts:201-217`), and mcp-shared's
deliberately structured Markdown would be destroyed by a blanket escape. `escapeObservationValue`
stays as the per-value primitive.

`escapeObservationValue` flattens newline runs to a space and backslash-escapes the Markdown
control characters, for interpolating a provider-controlled string — an issue title, a document
name — into a description. Marketo escapes exactly this set (`session.ts:1701-1709`) and google
flattens newlines (`google.ts:1186-1188`); github and homeassistant interpolate provider titles
raw, which is a provider-authored line break or list marker rendered as the gatekeeper's own
prose in the approval UI. It is deliberately per-value: `ObservationDescription.description` is
Markdown by contract (`workshop-shared/src/gatekeeper.ts:1054-1058`), and escaping every
description wholesale would destroy the structure a session composed on purpose — so the choice
belongs to the consumer that knows whether its descriptions are authored Markdown or plain
provider sentences.

### 4.8 `./actions`

The durable action journal (sequential IDs, staged/pending lifecycle) and kind-based dispatch,
shaped so the batch `applyActionsThrough` contract can be layered on later without rework.

The module's scope follows the corpus test: **reject's variance lives inside a handler body, which
dispatch can absorb; revert's variance lives in record lifecycle, which it cannot.** So apply and
reject are declarative here, while revert is a facet-level seam (§5.9) whose behavior is ordinary
consumer TypeScript — five gatekeepers today have five incompatible revert/retention behaviors,
and the kit does not model irreducible variance.

```ts
// `SerialTaskQueue` lives in its own internal module -- see §4.12. The journal itself lives in
// `src/action-journal.ts`, re-exported here so `./actions` stays the one public subpath.

export type JournalKeys = {
  nextIdKey?: string;                       // default "pending:nextActionId"
  recordPrefix?: string;                    // default "pending:action:" — disjoint from nextIdKey
};
type JournalState =                                     // internal; the kit writes all five
  "staged" | "pending" | "claimed" | "failed" | "applied";
export type ActionFence = { generation: string };       // opaque, equality-only staged connection
export type JournalRecord<A> =                          // returned by get(); error only on "failed"
  | { state: Exclude<JournalState, "failed">; action: A; fence?: ActionFence; error?: never;
      undispatched?: never }
  | { state: "failed"; action: A; fence?: ActionFence; error: string;
      undispatched?: true };                            // failed before the handler ran, so a
                                                        // rejection still owes its cleanup
export type JournalEntry<A> =                           // listed entries; structurally the
  { readonly id: number; readonly action: A };          // SimulationRecord createSimulationView takes
export class ActionJournal<A> {
  constructor(kv, opts?: JournalKeys & {
    upgradeRecord?(raw: unknown): A | undefined;   // undefined leaves a raw record unadopted
    maxPending?: number });
  // `maxPending` defaults to 50; records carry a version marker, and an unmarked one goes to
  // upgradeRecord rather than being trusted
  allocate(action: A, fence?: ActionFence): number;  // sequential id, "staged"; throws at maxPending
  markSubmitted(id: number): void;          // "staged" → "pending"
  markClaimed(id: number): void;            // "staged" | "pending" → "claimed"
  restorePending(id: number): void;         // "claimed" → "pending"
  markFailed(id: number, error: string,           // → "failed", terminal; reason capped; only
    options?: { undispatched?: boolean }): void;   // reject clears it, and prunes last when owed
  rollbackSubmission(id: number): void;
  get(id: number): JournalRecord<A> | undefined;  // any state; checks both tiers
  remove(id: number): void;
  retain(id: number, action?: A): void;     // post-apply write: retained record first, then the
                                            // delete; no-op on a "failed" record
  retire(id: number): void;                 // retired-id tombstone first, then remove; idempotent
  wasApplied(id: number): boolean;
  isRetained(id: number): boolean;          // tier membership — trustworthy where open consumer states are not
  listPending(): JournalEntry<A>[];         // "pending" + "claimed", ascending id; feeds createSimulationView
  listUndecided(): JournalEntry<A>[];       // "pending" only — what a decision may still retire
}
export type ActionSubmitter =                           // the surface staging needs; `gate.actions`
  Pick<RpcStub<ApprovalQueue>, "submitAction">;         // (§4.7) and a full stub both satisfy it
export function stageAction<A>(journal, queue: ActionSubmitter,
  action: A, description: ActionDescription, fence?: ActionFence): Promise<number>;

export type ActionPresentation =                        // the approver-facing text; policy fields
  Pick<ActionDescription, "title" | "description" | "implementsRevert">;   // come from the decl
export type ActionContext = { readonly id: number; readonly gitCache?: RpcStub<GitCache>;
  readonly fence?: ActionFence };                       // staged fence reaches apply/reject handlers
export type ActionApplyContext = { gitCache?: RpcStub<GitCache>; generation?: string };
export type ResolveOutcome = "applied" | "rejected" | "failed" | "reverted";

export class ActionApplyError extends Error {}          // an apply handler's terminal failure; its
                                                       // message is display-safe and becomes the
                                                       // stored answer every later attempt sees
export const APPLY_OUTCOME_UNKNOWN_MESSAGE: string;     // the answer an orphaned claim is failed with

export function defineActions<H, M extends Record<string, unknown>>(defs: {
  [K in keyof M]: {
    kind?: ActionKind;
    autoApprovable?: boolean;
    delivery: "continue-with-simulation" | "await-decision";   // REQUIRED; → awaitDecision
    claimBeforeApply?: boolean;             // at-most-once for an irreversible provider call
    describe(payload: M[K], host: H):       // derived from the stored payload, never passed beside it
      ActionPresentation | Promise<ActionPresentation>;
    provides?(payload: M[K]): readonly string[];    // provisional refs this payload creates
    dependsOn?(payload: M[K]): readonly string[];   // ... and those it needs an earlier one to create
    apply(payload: M[K], host: H, ctx: ActionContext): Promise<void | { action?: M[K] }>;
    reject?(payload: M[K], host: H, ctx: ActionContext): Promise<void>;
  }
}, opts?: {
  retainApplied?: boolean;                  // explicit; default false — facet base asserts revert-hook consistency (§5.9)
  vendorId?: string;                        // log attribution; the assembly threads spec.id
  afterResolve?(host: H, outcome: ResolveOutcome): void | Promise<void>;
  isResolvedReference?(ref: string): boolean;  // unresolved dependsOn refs never reach the provider
}): ActionSet<H, M>;

export type BoundActionSet<M> = {
  submit(queue: ActionSubmitter, kind, payload,
    options?: { fence?: ActionFence }): Promise<number>;  // serialized against submissions only
  apply(id: number, context?: ActionApplyContext): Promise<void>;  // context carries the canonical
                                            // applyAction(action, cache) stub and current generation
  reject(id: number): Promise<void>;
  autoApprovableKinds(): ActionKind[];
  readonly retainsApplied: boolean;
  resolved(outcome: ResolveOutcome): Promise<void>;
  runExclusive<T>(hook: () => T | Promise<T>): Promise<T>;   // the facet's revert seam (§5.9)
};
export type ActionSet<H, M> = {   // declarations are module-scoped, the journal and host per-facet
  bind(journal: ActionJournal<TaggedAction<M>>, host: H): BoundActionSet<M>;
};
```

The default keys are the dominant corpus family — supabase, google, backstage, and excalidraw all
use exactly `pending:nextActionId` and `pending:action:` — so a port in that cohort passes no key
options at all and its raw legacy records flow through `upgradeRecord` as designed. Ports outside it
override (ironclad `pending:`, github `action:`). Because the defaults are now a live-storage
contract, the test asserting those literals is load-bearing rather than a tautology.

**A kind this deploy no longer defines fails apply and still rejects.** A queued action outlives a
deploy — the queue contract allows a decision "hours or days later" — so renaming or removing a
definition leaves records whose `kind` no longer resolves. `upgradeRecord` does not cover it and must
not: it adapts a *legacy layout* into the current record shape, and these records are already
current. So apply marks the record terminally failed with a message naming the kind, which both
stops it projecting into every later read and opens the reject-a-failure path; reject dispatches
through the definition only if one exists, and retires the record either way. Dispatching reject
through an absent definition would strand it for good: the Workshop needs `rejectAction` to succeed
before it marks its own entry rejected (`overseer.ts:9630-9641`), leaving the user nothing short of
deleting the workspace. Four shipped gatekeepers already split it this way — google
(`google.ts:1681-1726`), confluence (`confluence-actions.ts:571-574`), ironclad
(`ironclad.ts:963-983`) and mcp-shared (`action-store.ts:201-210`).

**Resolution is serialized, and the queue is part of the contract.** The overseer can deliver two
callbacks for one action id concurrently: `approveAction` checks `state !== "pending"` and then
awaits `#getClientProfile()` before dispatching (`overseer.ts:9485-9495`), with the Durable Object's
input gate open across that await — and `applyPendingAction`'s own comment states that validating
the record is the caller's responsibility. Its single-flight drainer guards concurrent auto-approval
*drains* only, so manual-plus-drain and two manual approvals both reach the gatekeeper. Without a
queue, `resolvable(id)` is a time-of-check/time-of-use window wrapped around a provider call, i.e. a
double effect on the provider with one journal record to show for it.

This is an inherited corpus-wide hole, not a kit regression: supabase has the identical shape
(`supabase.ts:1092-1107` — get, `await runQuery`, remove), and no *public* gatekeeper has a
serialization primitive at all. Two places in either repo defend, and both do it differently:
`mcp-shared` takes a synchronous `applying` claim over the same TOCTOU
(`action-store.ts:130-162`), and ironclad checks an `applied:${id}` idempotency marker before
applying (`ironclad.ts:869`). The kit is the first place the fix can be written once for every
port, which is why it is here rather than left to each facet.

**The exclusive region is exposed rather than hidden**, because revert is a facet seam and is not
its only client. A second queue beside this one would serialize apply-vs-apply and
revert-vs-revert while leaving **apply-vs-revert** interleaved, which is the pair where one side
reads back what the other rewrote — 8 functional reverts across 11 corpus entrypoints, none
serialized against apply or reject, every one reading back artifacts its apply wrote. Retiring the
retained tier is the second client: it is consumer policy (spotify's 30-day sweep
`spotify.ts:1091-1099`, cf-wiki's 200-record cap, zoominfo's eviction, mcp's prune) and it mutates
the same records a revert reads. So the surface is `runExclusive(hook)` rather than the queue
object. `resolved(outcome)` stays separate from it, since folding a retirement sweep into
`runExclusive` would fire a spurious `"reverted"`; and a caller must never invoke `apply`/`reject`
from inside the callback, because they claim this same queue and would wait on their own
predecessor. `submit` stays off *that* queue — submission is not a resolution, and queueing it
behind a slow apply would stall the agent for a provider round trip — but it holds a second queue
of its own, so submissions serialize against each other (see the staged-record fix options above).

There is deliberately **no** `put(id, record)` and no `listUnresolved()`. No corpus journal lets
outside code write arbitrary states into a live record, and `put(id, { state: "applied" })` on one is
a re-apply footgun; cascade rejection everywhere enumerates *pending* records only (github's
`#listPendingActions`, and the pending scans in linear, notion, confluence, and spotify). For the
same reason `JournalState` is internal and closed rather than an open `(string & {})` union: no
consumer stamps its own state.

**The cascade is kit-owned.** A rejected or terminally failed creation retires whatever depended on
it: `provides` names the provisional references a payload creates, `dependsOn` those it needs an
earlier action to have created, and one `listUndecided()` scan per decision derives the transitive
closure. Retired records are marked `failed` with a reason rather than deleted, so a later overseer
callback for one reports why instead of `Unknown pending action`.

Seven live gatekeepers have this shape and six hand-roll the cascade — github
(`github.ts:1948-2006`), linear (`linear.ts:1598-1641`), notion (`notion-actions.ts:1035-1080`),
confluence (`confluence-actions.ts:571-605`), spotify (`spotify.ts:1816-1844`) and internal cf-wiki
(`pending.ts:175-199`) — and every one derives dependents by scanning pending payloads rather than
storing a graph, which is why the kit stores none either: there is nothing to keep in step, and
`maxPending` already bounds the scan. Jira is the seventh and cascades not at all, which is why its
rewriter passes unresolved keys straight to the provider (`jira.ts:466-475` → `:1399-1458`). No
corpus gatekeeper cascades on *terminal failure*, because none has a terminal failure state for
these actions — the kit does, so it is the only one that both strands dependents and retires them.
The one terminal failure that does **not** cascade is an orphaned claim: its stored answer says the
effect is unknown, so "was not applied" cannot be asserted over its dependents — the argument that
keeps `claimed` out of `listUndecided` below, which converting the claim makes no more decidable.
They stay pending, fail at the provider if the effect never landed, and clear by rejection —
exactly a corpus dependent whose creator never resolved.

`provides` and `dependsOn` return arrays, not `Iterable<string>`. Every one of those six cascades
keys on a scalar string — confluence's `parentId`, notion's `pageId`, github's `targetId`, linear's
`issueRef`, spotify's `playlistId`, cf-wiki's `provisionalId` — and `string` satisfies
`Iterable<string>`, so the natural `payload => payload.ref` would compile and cascade over
individual characters, stranding unrelated actions that happen to share one. That is a wrong,
user-visible outcome from type-correct code, which no test in the port would be looking for. An
array refuses it, matches what `ActionRefs` and `strandedBy` already take, and removes the three
conversion spreads that stood between them; `__tests__/actions.test.ts` pins the refusal with
`@ts-expect-error`.

**Dispatch reads a `Map` built from the declarations, never indexes the object.** `kind` comes from
storage, so a stale one naming an `Object.prototype` member (`constructor`, `toString`) would
otherwise resolve to an inherited function: `Object.apply(payload, host)` reads `host.length` as an
arity, calls `Object()` with no arguments, and returns a truthy `{}` — an apply that "succeeds",
removing the record with no provider call and nothing to tell the user. All fifteen action-capable
gatekeepers dispatch through a discriminated `switch`, which cannot reach a prototype member, so
this hazard is one the declarative registry introduces and has to close. It closes it at zero cost:
the validation loop already walks `Object.entries`, and the `Map` retires the cast that indexing
needed. The `submit` path still indexes directly, because there `kind` is `keyof M` at compile time
and the precise per-kind type is what makes `describe(payload, host)` check.

`listUndecided()` exists for this and is deliberately not `listPending()`: the two answer different
questions. Simulation asks what a read should project, and a `claimed` dispatch belongs there — it
is part of the pending world. A decision asks what it may still retire, and `claimed` must not be:
the dispatch may already have created the entity its own dependents name, so retiring it would
replace an unknown-outcome warning with a wrong explanation, and traversing it would retire
dependents that are in fact resolvable. Sharing one predicate is what made the constant behind the
old scan misnamed (`AWAITING_DECISION` covered `claimed`, which is precisely not awaiting a
decision); it is now `PROJECTED`, beside `UNDECIDED`, over one private scan.

**The residual gap: staged records are invisible to it.** `stageAction` leaves the record `staged`
while it awaits `submitAction`, and neither scan includes staged records — so a
dependent submitted concurrently with its parent's rejection survives, and becomes pending after
the parent and its provisional resource are gone.

The corpus is split. The majority writes `pending` before yielding at the approval-queue RPC and
rolls it back if submission throws — linear (`linear.ts:1116-23`), notion
(`notion-actions.ts:1015-21`), and confluence (`confluence-actions.ts:424-27`). GitHub
(`github.ts:3224-3239`) and spotify (`spotify.ts:1657-1673`) already carry this exact staged window:
they stage, await `submitAction`, then mark pending, while their cascade scans see pending records
only (`github.ts:1913-1919,1975-1981`, `spotify.ts:1816-1843`).

What `staged` buys is narrower, and worth stating precisely: the pending-first pattern's orphan
window is a **crash** between the write and rollback, which leaves a visible pending record the
overseer never heard of (linear's is permanent unless a later rejection sweeps it,
`linear.ts:1615-18`), whereas a staged orphan is invisible to every scan — silently leaked storage
instead of a phantom approval. The trade is real, and the corpus has chosen both sides.

The residual staged window is bounded by one overseer round-trip against human reject latency, and
`ActionSetOptions.isResolvedReference` closes its provider-facing consequence. When configured
(naturally as `ref => provisionalIds.isResolved(ref)`), apply checks every `dependsOn` reference
after the connection fence and before claim or handler dispatch; an unresolved ref throws a plain
retryable error, leaves the record pending, and never hands the provisional string to the provider
(`actions.ts:155-175,465-489`). GitHub and spotify already fail cleanly at the same boundary
(`github.ts:3287-3290`, `spotify.ts:1709-1720`).

The interleaving has two independent halves, and only one of them is closed.

**Closed: two submissions racing each other.** A staged record stays staged across `submitAction`,
and the capacity scan drops the oldest *staged* records first, so a second concurrent stage could
delete the record the first was still waiting on — the approval queue accepts an action whose
journal entry is already gone, and approving it later fails with `Unknown pending action`.
`stageAction` therefore serializes per journal on its own `SerialTaskQueue` — separate from the
resolution queue, and covering direct callers, not just `BoundActionSet.submit`: at most one staged
record is open at a time, so a live one is never the oldest prunable. Serializing against
resolution would have closed this too, at the cost below.

**Open: a submission racing its parent's rejection.** Cascade scans still see pending records only,
so a dependent submitted while its parent is being rejected survives, and becomes pending after the
parent and its provisional resource are gone. The fix is one of two, and the choice needs the
fixture (§7 step 11) in front of us rather than an argument here:

1. **Converge on the majority pattern.** Write `pending` before the await and keep the rollback, as
   linear, notion, and confluence do. Cascade rejection then sees the record throughout, and the
   residual is the crash-orphan above.
2. **Serialize submission with resolution.** Fold the submission queue into the resolution queue,
   making the interleaving impossible by construction, at the cost of queueing every submit behind
   a slow apply.

Exposing `listUnresolved()` is *not* on that list: a consumer that can enumerate staged records will
eventually try to resolve one, and `staged` means the overseer has not yet been told the action
exists.

The journal is **two-tier**: staged/pending records live under `recordPrefix`, and a retained
applied record moves to a sibling retained prefix, so `listPending()`'s scan stays bounded by
genuinely pending records no matter how many applied records accumulate. `get(id)` checks both
tiers, **preferring the retained one**, `listPending()` skips an id the retained tier holds, and the
`maxPending` scan does not count one against the cap. All three readers, because the rule is an
invariant and not a convenience: the record is applied, so a reader treating it as pending is wrong
in whatever way that reader can be wrong — and the capacity scan's way is to hold a queue slot for
good, refusing allocations for a user whose approval queue is empty.
That is not belt-and-braces: `retain` writes the applied record before deleting the pending one
(so an interrupted move never loses the record), which means a failed delete leaves the id in both
tiers — and the applied copy is the true one, since it carries the apply-time artifacts a revert
hook reads back. Resolving the duplicate the other way would hand a revert the pre-apply payload
and keep projecting an effect the provider has already made real. GC of the retained tier is
deliberately consumer-side policy: retention is inherently unbounded and retirement caps are
per-vendor (only github has one today).

With `retainApplied: false`, a resolution replayed after an apply whose RPC result was lost would
find no record: the retry errors for an effect that succeeded, and a reject reports success, so the
overseer can label an executed action rejected. `retire()` therefore writes the id into one bounded
retired-id array **before** removing the record. If removal is interrupted, `listPending()` and the
capacity scan already skip that tombstoned id, and a replayed apply idempotently finishes the
removal; reject throws "no longer pending" throughout. IDs past the allowance degrade to the
unknown-id error rather than growing an unbounded tombstone tier
(`action-journal.ts:234-318`, `actions.ts:430-440`). mcp-shared ships the same semantics as full
rows capped at 100 (`action-store.ts:137,204`); the kit keeps only the ids.

**The key layouts a port must reconcile (verified across both corpora, not inferred).** The kit's
defaults fit the largest cohort, but neither the counter convention nor the retention layout is
universal, and both mismatches are silent. Whoever ports a gatekeeper checks it against these two
tables *before* pointing the journal at existing keys.

*Counter convention* — what the stored number means:

| Convention | Gatekeepers | Kit |
| --- | --- | --- |
| Next unused (`?? 1`, store `id + 1`, return `id`) | supabase, google, notion, confluence, backstage, cf-wiki, ironclad, jira, salesforce — 9 | **this is `allocate()`** |
| Last issued (`(?? 0) + 1`, store and return it) | github, linear, spotify — 3 | incompatible |

Adopting a last-issued counter key as `nextIdKey` **would re-issue the last ID and overwrite its
pending record** — after which the overseer could approve one description while the journal
dispatches another payload. N-as-next and N-as-last are the same byte, so the counter itself
cannot be validated — but `allocate()` refuses to stage over an id that already has a record or
retired-id memory, so the misport fails loudly at the moment of harm instead of corrupting it. Those three ports still
migrate the counter `+1` in the same commit that adopts the journal. Key name and convention vary independently — `pending:nextActionId`, `seq:action`,
`counter:action`, `pending:nextId`, `nextActionId` all appear — so a port picks both, separately.

*Retention layout* — where an applied record lives:

| Layout | Gatekeepers | Kit |
| --- | --- | --- |
| None: deleted on apply | supabase, google, cf-wiki, ironclad — 4 | `retainApplied: false` |
| In-place `state`/`status` field on one prefix | notion, confluence, linear — 3 | not expressible |
| Second-tier records under an independent prefix | github (`action:` → `retiredAction:`) — 1 | shape matches, key does not |
| Derived sibling `retained:${recordPrefix}` | none | `retainApplied: true` |

So the derived prefix, justified above as "the shape github already uses", generalizes exactly one
gatekeeper and matches *no* existing key: github's retained records sit at `retiredAction:${id}`,
not `retained:action:${id}`, and its `#getLiveActionRecord` fallback (`github.ts:1880-1881`) is what
would stop finding them. That port needs a `retainedPrefix` option — added *then*, designed against
its one real consumer, rather than shipped now with none. Watch two traps in the tally: ironclad's
`applied:${id}` holds `true`, not a record (`ironclad.ts:831-890` — an idempotency marker, then the
pending record is deleted), so it maps to no-retention plus the journal's existing resolution
dedupe; and the in-place trio is the *plurality of retainers*, so the first of those ports chooses
between an N-key migration to tiered (buying the O(pending) scan that in-place listing gives up —
linear filters its whole history at `linear.ts:1136`) and adding the in-place store as a second
strategy. `JournalState` already carries the `state` field that makes the latter mechanical; what
it does not settle is whether `reverted` is a journal state or facet-private, which is the §5.9
revert question and the reason this is not a slot the kit cuts in v1.

**Port-time obligations and adjudications.** Some remain provider-specific work; others now record
the leaf contract that closed or deliberately adjudicated the finding.

| Obligation | Who it affects | Disposition |
| --- | --- | --- |
| **A revoke-raced mint now has a drain seam.** A refresh in flight when `revoke()` wipes storage may still complete after its identity fence moved, producing live provider-side authority the coordinator will never store. | every port with a refresh flow | **Resolved in Layer 1:** `CredentialCoordinatorOptions.discardMint` receives that successful fenced-out mint; `#refresh` awaits it before returning the winning credentials, and logs a throwing handler as `credentials.mint.discard.failed` without rethrowing (`credentials.ts:139-145,332-378`). `revoke()` itself still belongs to the account base (§5.6), which owns revoking the captured grant; the coordinator owns only the mint that lost its fence. |
| **Baseline verification is admission-time policy.** `verifyBaseline` and `aclObservers.hasAccess` run only when admitting an observer; the tracked-set oracle alone runs on every set-scoped read. | every observer port | **Adjudicated as doctrine:** Workshop membership removal is the revocation path, and a provider needing per-read baseline freshness folds that check into `hasSetAccess` (`observers.ts:50-54,103-129`; `observer-tracker.ts:149-161`). *Trigger for a new seam:* a provider whose binding-level grant is revocable independently of Workshop membership **and** whose reads are baseline-shaped. |
| **`maxTrackedSets` is a default, not a corpus constant.** 1000 comes from google's generic default, but its concrete Drive tracker overrides to **2000** (`drive-observers.ts:49-53`), sized against `ceil(N/100)` subrequests. | supabase, notion, linear ports, which had no cap at all | A port inherits a bound it never had; the number is per-provider and belongs in that port's options. |
| **`maxObservers` is a platform bound the corpus does not have.** Every retained observer costs one verifier call per read, and Workers cap a request at **32 Worker invocations** — past that the call throws, so a binding with too many collaborators fails *every* read rather than degrading. No shipped tracker caps this: notion, confluence, context, linear and internal `gatekeeper-shared` fan out over all observers with unbounded `Promise.all`, and google throttles concurrency without bounding the total. | every strategy-C port | The kit refuses at admission instead, which is the legible half of the same failure. The default is **10**, not 20: an observer count prices only the kit's own hop, and every verifier in the corpus spends a second invocation calling its account DO (`notion.ts:615-635`), so 20 observers is 40 invocations before the read does anything. The real ceiling is per-deployment, so the number belongs in that port's options. `concurrency` is a throttle and never a bound. |
| **Re-fetch after a reported expiry.** The account keeps the dead grant until reconnect — `reportCredentialsRejected` notifies, it does not clear — so any later `get()` fetches the same credentials back and its callers 401 again. | all | Self-healing and bounded: each round costs a redundant 401 (the account notifies once), never a wrong authorization. The source keeps reported identities in a per-activation dead set and refuses to re-adopt their generations, and fences out fetches already in flight at the report; without those, a cache hit under the restored partition never reaches the provider, so hit-only paths would mask the outage for the TTL and across the reconnect. A fetch started after the report, adopting an identity not in the set — successful refresh or reconnect — re-establishes the authority. |
| **Warm-path credential memo.** Every `run` and `get` opens an account round trip even when the same operation read credentials moments ago; the kit deliberately ships no consumer-side cache (§4.6), so a facet fanning out N provider calls pays N same-colo hops. | high-read-volume ports | The corpus survey behind §4.6 stands — 21 of 33 gatekeepers fetch per provider request, and the three that memoize gate on the *provider-issued expiry*, a projection the stored/public credential split does not carry today. An expiry-gated memo is additive (an `expiresAt` on the public projection plus a source option) and wants a port with measured hop cost in view, not a speculative default that would hold a stale principal for its window. |
| **403 scope-regrant healing.** The rejection adjudication heals *credentials* — a stale bearer minted from a live grant. A 403 whose cause is a missing scope is a different failure: the grant is alive, no mint fixes it, and the recovery is a reconnect flow with incremental consent. Classifying it as an auth error would retire a healthy connection; classifying it as no-access hides the regrant path from the user. | google port first (incremental-consent scopes) | Needs surface the kit does not have: a per-operation scope requirement, a reconnect prompt distinct from expiry, and provider-specific insufficient-scope detection (google's `403 insufficientPermissions` vs. its resource-level 403s). Land it with the first port whose provider does incremental consent, so the classification is designed against real error bodies. |
| **Corrupt-record blast radius.** A throwing `upgradeRecord` propagates out of `#coerce`, so one unreadable legacy record makes `listPending()` throw and blinds the whole simulation overlay rather than dropping that entry. | ports supplying `upgradeRecord` | Both behaviours lose something — a throw blinds everything, skipping hides one pending action from its user — so pick it with a real corpus of legacy records in view. |
| **The retained tier is unbounded.** `#requireCapacity` scans only the pending prefix and skips `isRetained`, so `maxPending` bounds pending records and twice that many `staged`/`failed` ones, but never retained ones. A long-lived `retainApplied: true` binding accumulates one record per applied action indefinitely. | every retaining port | Retention is consumer policy and vendor caps differ; the binding must retire records through `runExclusive` under its own policy. |
| **Past its bound, a pruned `failed` record takes the only account of what went wrong.** The Workshop keeps a thrown `applyPendingAction` pending and visible (`overseer.ts:9497-9500`, "the action stays pending and the turn stays suspended"), so the journal record is the sole holder of the reason. Once more than `2 × maxPending` prunable records accumulate, the oldest are dropped: a later approve degrades to `Unknown pending action` and a later reject succeeds silently, which can lose an `ActionApplyError` warning that a provider effect partly landed. | any port accumulating more than twice `maxPending` un-rejected failures on one resource | Storage must be bounded, so something must eventually go; the choice is only what and when. Counting failures against the cap instead — the obvious alternative — converts a lost diagnostic into a provider-triggered denial of service, blocking all staging until the user hand-clears them. Staged-first pruning and the doubled bound push this out; closing it entirely needs a tier that keeps reasons after their records, which is the same unbounded retention the row above defers. |
| **Staged actions have an opt-in connection fence.** `ActionFence` is stored on both journal-record arms and preserved through every transition; `submit(..., { fence })` captures it, and `apply(id, { generation })` checks it before prerequisites, claim, or handler dispatch (`action-journal.ts:23-46,151-152,186-200,395-455`; `actions.ts:181-226,430-501`). | every port whose action payload is connection-scoped | **Resolved in Layer 1, opt-in per submit.** `CredentialCoordinator` rotates the connection generation on `connect()` and `clear()` only; token refresh preserves it. A reconnect or disconnect therefore trips the fence, including re-authorization of the **same** provider account because the generation is an opaque nonce. The kit treats the value as equality-only, so a port wanting account-scoped fencing may pass its own stable provider account id at submit and apply instead, and only the declared `generation` is stored. Omitting `generation` at apply is a retryable wiring error that leaves the record untouched; a mismatch records a terminal `undispatched` failure, strands dependents (`undispatched` too, since they never dispatched either), fires the failed-resolution hook, and tells the user to reject and resubmit — and that rejection runs each definition's `reject` hook, since no handler ran to own the staging artifacts. |
| **An evicted tombstone stops filtering the record an interrupted retire left.** `retire()` writes the retired-id tombstone before removing the record, so a split write degrades to a stale pending record that `#scan` and `#requireCapacity` filter on the tombstone and the next apply of that id retires. Past `2 × maxPending` retirements the tombstone is evicted, and nothing filters the record: it projects again and a later apply repeats a provider effect that already landed. | any port whose journal KV can tear a two-write sequence | **Accepted, not code.** The split needs `kv.delete` to throw between the two writes, which `ctx.storage.kv` cannot do here — both land in one implicit transaction, and the keys are fixed and short, so only a consumer-supplied wrapper could fail one. Sweeping the record at eviction was implemented and reverted: it put the deletes *before* the tombstone write, inverting the ordering the rest of the function depends on, and closing that in turn needed a second write of the same key — machinery for a tear production storage does not produce. *Trigger:* a journal KV that is not `ctx.storage.kv`, or an observed stale pending record with no tombstone. |
| **The expiry latch re-arms with two writes.** `clearCredentialExpiryLatch` clears the boolean and writes a fresh arm. Were the second to fail alone, an in-flight notification for the replaced credentials would match the surviving arm and latch the new ones — the one *silencing* failure in a module whose every other window fails toward a harmless duplicate notification. | every port with a refresh flow | Both writes are adjacent, awaitless and constant-size, so one implicit transaction carries them and no trigger separates them; the function's doc comment states that adjacency as the invariant to preserve. Every candidate fix is worse than the window: swapping the order makes the silence deterministic, and one combined record breaks the plain-boolean compatibility every shipped gatekeeper reads. **Narrowed:** every credential *replacement* re-arms through `#commit`, not only `connect()` — a successful refresh racing a notification for the credentials it replaces can no longer let that notification latch it, which was the same silencing class reachable with no storage failure at all. The legacy migration publishes without re-arming (`#publish`), since moving a grant between layouts replaces nothing and would otherwise re-announce a death the account already reported. |
| **A crash mid-withheld-read closes admission for good.** The `observer-withhold:<nonce>` marker goes down before the overseer is asked and is stranded by an activation that dies before settling; `addObserver` refuses while any marker stands, and nothing reclaims one. A read the overseer would have refused still leaves the binding unshareable. | every strategy-C port using `withholdFromObservers` | A stranded marker cannot tell a lost reply from a lost request, and the overseer's record is durable before the reply — so reclaiming on any schedule risks disclosing a recorded owner-only description to the next collaborator admitted, while over-fencing costs sharing on a binding already handling owner-only data. The attempt record's fail-closed trade, without the TTL escape. *Trigger:* a binding observed stuck closed with no `observer-withheld` latch. |
| **A lost `authorizeObservation` reply no longer reopens admission over a standing fence.** `ObservationGate.authorize` calls `discard` only for a marked refusal; an unmarked transport or service error calls `abandon`, releasing in-memory bookkeeping while retaining durable set and withheld-read fences (`observers.ts:238-251`; `observer-tracker.ts:38-51,304-323,437-453`). | every strategy-C port | **Kit side shipped; kernel mark held.** This closes the former discard-on-any-error leak immediately. Today the overseer's refusals remain unmarked, so every failure takes the fail-closed unknown-outcome path. Full refusal reclamation activates when a later kernel PR moves `OBSERVATION_REFUSED_CODE` into `workshop-shared/gatekeeper.ts` and marks the two pre-record refusal throws at `overseer.ts:5514-5517` and `:5691-5693`. This change touches neither `workshop-backend` nor `workshop-shared`. |
| **A dropped action kind strands its dependents silently.** `provides`/`dependsOn` are evaluated from the live definition, so an action staged under a kind a later deploy removed reports no refs, and the dependents it was holding open are not retired with it. | any port that removes a shipped action kind | The dependent stays pending and fails at the provider instead of naming the parent it needed, so what is lost is an error message, not an effect — a ref a gatekeeper declares in `dependsOn` is by definition an identifier the provider validates. Closing it means storing the refs on the record, which puts staging metadata inside the journaled action identity and threads it through every state transition. No corpus gatekeeper stores its graph either (§4.8), so the six that cascade port without this. *Trigger:* the first port to remove a shipped action kind. |
| **A read during an in-flight apply can overlay an effect the provider already made real.** Simulated reads project `pending` and `claimed` records, and an apply is a provider round trip followed by the journal write, so a read landing between the two fetches the real effect and overlays the same action again — a transient duplicate in the *view*, never a second provider effect (resolution is serialized). | every port with continue-with-simulation actions | Inherent to overlaying local pending state onto remote reads: no atomic instant flips both, and it holds for every projected state, so dropping `claimed` from projection would only make the action vanish mid-apply instead. Serializing reads with resolution would stall the agent for the length of a provider call on every read — the trade submission already refuses — and `runExclusive` is the opt-in for a consumer that needs a consistent snapshot. Self-healing: the next read after the journal write is correct. *Trigger:* an agent observed acting on the duplicate, e.g. staging a corrective action against it. |
| **Refused reads reclaim their pending observed-set markers.** `prepareObservation` can remove the `"pending"` rows a read wrote once nothing is left to account for them. | every strategy-C port | **Resolved in Layer 1:** each disclosed key carries a per-storage in-memory claim recording how many reads still owe it, whether this generation of claims created its marker, and whether every claimant so far refused. The last claimant to settle reclaims the marker when all of them refused and storage still says `"pending"` (`observer-tracker.ts:88-136,424-473`). One isolate owns a Durable Object, so in-memory tracking is sound; `perStorage` shares it across trackers over the same storage object. Two markers stay by design: one whose claimants include an unknown outcome, since a lost reply may have followed a durable record, and one stranded by a crash, which a later read can never prove was refused because it did not create it. |

`stageAction` encodes the one ordering every gatekeeper must get right: allocate the record,
`submitAction(id, description)`, then mark it submitted — and roll the record back and rethrow if
submission fails *while the record is still staged*. A record that has left "staged" proves the
overseer received the submission — an auto-approval can resolve the action while `submitAction` is
in flight — so a rejected RPC then means only the reply was lost, and `stageAction` reports the id
as submitted rather than offering a resubmit of an effect that landed. The resolution verbs supply
the same proof from the other side: a callback naming the id promotes a record a crash or lost
reply stranded `staged`, so a retryable failure leaves it pending — projected into reads, safe
from the rollback — instead of invisible to simulation while the overseer still lists it.

`ActionSet.bind(journal, host)` returns a `BoundActionSet` with
`submit(queue, kind, payload, options?: { fence?: ActionFence })`,
`apply(id, context?: ActionApplyContext)`, `reject(id)`, a readonly `retainsApplied` (the resolved
retention flag the facet base's assert reads, §5.9), `autoApprovableKinds()` (filtered to
`autoApprovable: true`, deduplicated by tag), and `resolved(outcome)` — the facet base's way to fire
`afterResolve(host, "reverted")` after its revert hook, since the hook is closed over inside
`defineActions`. `ActionApplyContext` carries the `cache` stub received by canonical
`applyAction(action, cache)` as `gitCache`, plus the current connection `generation`. There is no
`revert(id)` here — see §5.9.
For a strict fence, the handler compares `ActionContext.fence` with the `CredentialRead` of its own
provider operation; that catches a reconnect landing after apply's entry check
(`actions.ts:84-102,465-501`).

`reject` resolves to `void`. The canonical `rejectAction` may return `{ restart: true }` to ask the
overseer to re-run the submitting turn, but the overseer awaits the call and discards its result
(`overseer.ts:9636`), so the kit does not carry a field nothing reads. `revertAction`'s `restart` is
deader still: nothing in `workshop-backend` calls `revertAction` at all.

**The approval text is derived from the stored payload, not passed in beside it.** `describe` is a
definition member, so what the approver reads is a function of the bytes a later `apply` sends.
Passing both independently is what lets them diverge, and six live gatekeepers demonstrate the
divergence: gmail renders an ephemeral outbound message while storing compact semantic fields
(`google.ts:1060-1079,1485-1555`), google docs renders 80/100-character previews of a body it stores
whole (`google.ts:1792-1794`), home assistant renders friendly names from a live registry snapshot
while applying stored entity ids, so a rename between approval and apply leaves the approved text
describing something else (`homeassistant.ts:1285-1313`), cf-wiki displays caller markdown and sends
converted storage markup (`session.ts:417-434`), and jira's description reads `input` while apply
sends `normalizedInput` (`jira.ts:1795-1840`). Confluence and notion — the two most mature action
implementations — already derive it exactly this way (`describeAction(action)`), and `host` stays
available for the enrichment reads a description often needs.

Deriving it also settles the policy fields: `actionKind` and `autoApprovable` come from the
declaration alone and `awaitDecision` from its required `delivery`, so the AND of a call-site
verdict with a declared one is gone along with the reasoning it needed. `defineActions` still
rejects a definition that claims `autoApprovable` without declaring a `kind`, since auto-approval
rules key on the tag and the flag could otherwise never take effect.

**Handlers receive the journal id.** `apply` and `reject` take an `ActionContext` carrying it. It is
durable, unique per resource and stable across retries, which is what a provider idempotency key can
be derived from — 0 of 15 live writers send one today, and both google
(`auth-retry.ts:14-19`, naming gmail's `X-Goog-Client-Request-Id` and calendar's client-supplied
event id) and jira (`jira-api.ts:352-392`, "writes need an idempotency key to retry safely") record
it as a follow-up they cannot reach without this.

**`delivery` is declared, never inferred.** `awaitDecision` is documented as being for "actions whose
effects the gatekeeper does NOT simulate" (`workshop-shared/src/gatekeeper.ts:1153-1168`), and
nothing in a definition reveals whether its kind's effects show up in later reads. The corpus splits
both ways — jira and cf-wiki simulate and let the agent continue, ironclad waits — and backstage
queues an unsimulated action with no `awaitDecision` at all (`backstage.ts:572-586`), a live
violation of that guidance that a required field makes unwritable. `"await-decision"` puts
`awaitDecision: true` on the wire and `"continue-with-simulation"` puts **no key** there, via a
conditional spread; the flag is independent of `autoApprovable`, `implementsRevert`, and
`claimBeforeApply`. The journal's
overridable keys are validated at construction — an empty record prefix, a counter inside either
record prefix, or a record prefix containing its own retained tier all throw.

Resolution lookups (`apply`/`reject`) find records in **any** state, not just `pending`: the DO
output gate holds the outgoing `submitAction` RPC until the preceding `allocate()` write commits,
so a crash before `markSubmitted` persists still leaves a durable `staged` record the overseer
will legitimately resolve (github's own `applyAction` accepts `"staged"`). Only `listPending()`
filters to `pending` (plus `claimed`, below). `apply(id)` with a missing record throws
`Unknown pending action: ${id}`. On an **already-applied** id the two verbs diverge: `apply`
returns void and does nothing, because the effect and the journal write both already happened and
the only caller who can be asking is the overseer's retry after losing the reply — reporting a
failure there gives the user an error about an action that succeeded. `reject` instead throws "no
longer pending" (github's semantics), because the retained record is what a revert hook reads back
and a stray rejection would destroy it. The guard behind both is `isRetained` — not the open state
string — plus the journal's retired-id memory, the only trace a non-retaining set keeps: it lets a
retry of `apply` stay idempotent across activations, and stops a reject racing the apply (the
overseer can deliver both concurrently) from reporting success for an action the provider ran.
On success the kit performs one **awaitless post-apply transition** after the provider effect:
the handler's returned `{ action }` (apply-time artifacts such as created entity ids — the
linear/notion pattern) is merged into a retained `"applied"` record, or a non-retaining resolution
writes its retired-id tombstone before removing the record. One writer by construction; handlers
never write the journal mid-apply. An apply
that throws leaves the record so the user can retry (matching supabase) unless it threw
`ActionApplyError`, which is terminal (below), and either way still fires
`afterResolve(host, "failed")` — a partial provider effect is exactly when caches are most stale.
`reject(id)` is idempotent for an id the journal never had or already dropped: optional handler,
record removed, no-op. That is what lets the overseer retry after crashing before its own state
write, and why only ids the retired-id memory names are refused — a rejected removal leaves none.
`afterResolve` fires once per resolution with the outcome; it exists because every corpus
gatekeeper invalidates caches after resolution and the big ones repeat it per branch (github calls
`#clearCaches()` in every switch arm), where one forgotten branch is a silent stale read. The hook
is **best-effort and carries no authority**: the kit awaits it (so post-resolution reads see fresh
caches) but catches and logs a throwing hook at `error` — it must never mask an apply error's
display-safe message with an invalidation stack, nor convert a provider-side success plus a
completed journal write into a caller-visible failure. The journal write precedes the hook, so a
manufactured failure could never reach a re-apply anyway (the retry hits the resolution guard);
the catch confines the damage to zero.

**Apply is at-least-once by default**, and `claimBeforeApply` is the opt-out. Without it the
provider call can succeed and the process crash before the journal write, and the overseer's retry
re-applies — fine for an idempotent write, wrong for one that charges a card. With it the journal
is moved to `claimed` *before* the handler runs, so the three outcomes are distinguishable in a
later activation: a plain throw restores `pending` (the handler classified the failure retryable),
an `ActionApplyError` records `failed` with its display-safe message (terminal — every later
attempt is answered from the record with no provider call, and only a rejection clears it), and a
claim nobody in this activation wrote is converted to `failed` with
`APPLY_OUTCOME_UNKNOWN_MESSAGE`, which says the call went out and its outcome is unknowable rather
than guessing either way. `claimed` records still project into simulation — an in-flight dispatch
is part of the world a read describes — while `failed` ones deliberately do not.

**A non-idempotent create must set it.** Without a claim, an interrupted dispatch leaves the record
retryable, so the retry creates a second entity — and if the first one bound a provisional id, the
retry's `bind` throws the conflict of §4.9 *after* the duplicate exists. The claim is what turns
that into one terminal "outcome unknown" the user reconciles. It is also the corpus answer:
ironclad and salesforce both write a pre-dispatch marker and refuse the ambiguous retry
(`ironclad.ts:927-941`, `salesforce.ts:1050-1065`), while confluence, which does not, can re-create
and silently retarget. Where the provider takes an idempotency key, derive it from
`ActionContext.id`, which is stable across retries.

**Only the handler is caught**, and the boundary is load-bearing. The post-apply journal write sits
outside that `catch`: by then the provider effect has landed, so treating a storage failure as
retryable and restoring `pending` would offer the user a second irreversible apply — the exact
thing the claim exists to prevent. The claim survives instead, and the next attempt reports the
unknown outcome. No invalidation hook fires on that path either, since the write that would have
justified one is what failed; the following resolution's `failed` covers it.

The earlier claim here that "no gatekeeper solves this" was wrong: `mcp-shared/src/action-store.ts`
persists its claim before any external I/O and converts an orphaned claim into a `failed,
retryable = 0` record (`:1-2, 9-12, 43-71`), and ironclad's `applied:${id}` marker is the same
idea one step later. This is that mechanism, generalized. Marketo's finer answer — per-provider
`partial`/`nothing-changed` labels and a batch-result classifier — stays consumer policy on top of
it: the kit's own axis is binary — a plain throw is retryable, an `ActionApplyError` is terminal —
which is mcp's shape too (a `retryable` flag plus a persisted message, `action-store.ts:152-169`),
and neither corpus has a three-valued classifier to generalize from.

`maxPending` bounds the pending tier itself, and **defaults to 50**: an agent looping on an action
nobody approves would otherwise grow it without limit, so `allocate` counts the unresolved records
and throws before writing. The corpus caps disagree (gmail 100 `google.ts:1216-1218`, mcp 50
`action-store.ts:9-12`, ironclad 10 for inline-file actions only), so that default is a conservative
kit choice rather than corpus-compatible behaviour.

**Only a record awaiting a user decision counts, and the rest get their own wider bound.** `staged`
and `failed` are both excluded from the cap — one was never delivered to the overseer, the other is
cleared by rejecting it — and no journal in either tree reclaims a record stranded between
`allocate` and a successful `submitAction`, so counting either would wedge `allocate` for a user
with nothing in their approval queue to clear. Counting `failed` would be worse than useless: a run
of terminal provider failures would stop the agent staging anything at all until the user cleared
them by hand, which is an outage denying service to someone who did nothing wrong.

But exclusion alone would just move the growth: both sit under the *scanned* prefix, so a run of
them would make every later allocation and every simulation scan more expensive. They are therefore
bounded separately, at `PRUNABLE_RECORD_FACTOR` (2) times `maxPending`, dropped by the same
`allocate` scan that enforces the cap — which is exactly mcp-shared's shape, a pending cap that
throws beside a wider terminal-retention cap that prunes (`MAX_PENDING_ACTIONS = 50`,
`MAX_RETAINED_ACTIONS = 100`, `#prune()`). A retaining gatekeeper still owns retirement of its own
retained tier (above).

**Staged records are dropped before failed ones**, whatever their age: a stranded `staged` record is
plumbing a submission left behind, while a `failed` one holds the only account of what went wrong,
which the user is still owed. Within each group the oldest goes first, the newest being what the
user still has on screen. Reaching a `staged` prune at all requires more than twice `maxPending`
concurrent in-flight submissions on one resource; the oldest then loses its record, its
`markSubmitted` no-ops, and the action surfaces later as `Unknown pending action`.

The excess is clamped rather than trusted, which reads like a redundant check and is not: a
negative `slice` end counts back from the array's own length, so under the bound `slice(0, -n)`
silently drops the oldest records instead of nothing — worst at one below the bound.

`JournalRecord` is discriminated on `state`: both arms may carry an opaque `fence`, while `error`
exists only on a `"failed"` record and always does there. The one fallback for a stored failure that
lost its reason lives at `#coerce`, the single storage boundary, rather than at each reader —
`./actions` reads `record.error` with no `??` behind it.

### 4.9 `./simulation`

Pure projection helpers extracted from the shapes already present in homeassistant, confluence,
notion, jira, and spotify. No storage, no wiring into the assembly.

```ts
export type SimulationRecord<Action> = { readonly id: number; readonly action: Action };
export function createSimulationView<Action, Target>(
  records: readonly SimulationRecord<Action>[],
  targets: (action: Action) => readonly Target[],
): Readonly<{                                       // frozen; readonly function properties, since
  all: () => readonly SimulationRecord<Action>[];   // an RPC-reachable object may not hand out a
  forTarget: (target: Target) => readonly SimulationRecord<Action>[];   // mutable method table
}>;

export type SimulationStep<State> =
  | { kind: "applied"; value: State }
  | { kind: "known-no-effect" }
  | { kind: "unsupported"; reason: string };
export type SimulationResult<State, Action> =
  | { kind: "complete"; value: State; appliedCount: number }
  | { kind: "incomplete"; partial: State; appliedCount: number;   // `partial`, not `value`: the
      unsupported: SimulationRecord<Action>; reason: string };    // fold stops at `unsupported`
export function replaySimulation<State, Action>(base, records, apply): SimulationResult<State, Action>;

export class ProvisionalIds<Id extends string> {
  constructor(kv, options: {
    namespace: string;
    isProvisional?(id: Id): boolean;   // classifies an unknown id, so requireResolved can tell
  });                                  // "not ours" from "not bound yet"; it throws without one
  allocate(format: (sequence: number) => Id,        // keys `${ns}seq:provisional`
    options?: { kind?: string }): Id;               // tagged: also keys `${ns}kind:${id}`
  bind(provisional: Id, real: Id): void;            // keys `${ns}prov:${id}`
  resolve(id: Id): Id;                              // identity for unknown or provider ids
  isResolved(id: Id): boolean;                      // true for a classified provider id, so a
                                                    // dependsOn ref that is already real passes
  kindOf(id: Id): string | undefined;
  requireResolved(id: Id, options?: { expectedKind?: string }): Id;
}
```

`requireResolved` is the confluence/notion "reject an unbound provisional target" pattern, which
every caller would otherwise re-express as its own `if (!isResolved(...)) throw`.

**`isProvisional` is enforced where IDs are created, not only where they are read.** Supplying it
makes `allocate` reject a formatter whose output it does not classify as provisional, and makes
`bind` reject the pair in both directions — a real ID as the key would shadow a provider ID for
every later `resolve()`, and a provisional ID as the value would resolve one provisional to another
and defeat `requireResolved`. Without those checks a badly-chosen formatter mints IDs
indistinguishable from provider ones, and `resolve()` hands an unbound provisional straight to the
provider as though it were ready — a failure that surfaces as an inexplicable provider error far
from its cause. The corpus formatters all prefix `~` (github `~${n}`, linear `~${n}`,
`~comment:${n}`), which is exactly the convention a classifier encodes; the write-side guards are
skipped entirely when no classifier is supplied, so they cost nothing to a consumer that only
allocates and resolves.

`requireResolved` demands the classifier and applies it to **both** ends before trusting a binding:
a provider ID is already final, so it returns unchanged without consulting the table, and a bound
value that classifies as provisional throws. Either would otherwise let a pair written by an
instance with no classifier — the one configuration whose `bind` validates nothing — aim an outbound
call at a different resource. Ironclad (`ironclad.ts:945-950`) and salesforce
(`salesforce.ts:3081-3093`) both classify before consulting their mapping for the same reason.
`resolve()` applies that same test one step earlier: an ID the classifier calls non-provisional is
returned before the binding table is consulted at all. Only a classifier-less instance can write a
binding keyed by a real provider ID, but once one exists, every later `resolve()` on a correctly
configured instance would redirect that ID and aim an outbound call at another resource. Reading
the classifier first makes the stale row unreachable rather than authoritative.

**A provisional ID may carry its logical kind, and a reference may demand one.** A provisional ID
is a bare string, so nothing stops a caller passing a provisional comment id where a page id was
meant; `resolve` returns it unchanged and the provider answers with an error naming neither the
wrong kind nor the caller that supplied it. Tagging is durable and opt-in (`allocate(format,
{ kind })`, read back by `kindOf`), and `requireResolved(id, { expectedKind })` refuses a mismatch
with `${id} is a ${actual}, not a ${expected}.` before the unbound-provisional check runs — a
mistyped reference is a reference error whether or not it happens to be bound yet. An ID with no
recorded kind (a real provider ID, or an untagged provisional) skips the check, so this costs
nothing to a consumer with one entity type. Marketo carries a `LogicalKind` on every provisional
(`marketo.ts:1261-1291`) and github hand-rolls per-kind prefixes plus per-kind lookups
(`github.ts:139-142, 1956-1981`) — two independent consumers of the same idea.

**A conflicting rebind throws, and it is not classifier-gated.** Apply is at-least-once (§4.8), so a
create whose journal write was lost is re-applied and the provider answers with a *second* entity.
Overwriting the binding would silently retarget every queued action that resolves that provisional
and orphan the entity the earlier apply created, so `bind` refuses a different provider ID for an
already-bound provisional and stays a no-op for the same one — the retry's own path. A duplicate the
user can see and delete beats a mutation aimed at the wrong resource, and unlike the direction
checks this one reads the stored binding rather than the shape of the IDs, so it holds for a
consumer that supplies no classifier.

`createSimulationView` sorts once by action ID, indexes each action under every target it affects
(deduplicated per record), and returns frozen snapshots. `replaySimulation` folds records in
order; `known-no-effect` continues, and the first `unsupported` stops replay, because projecting
later actions onto a state already known to be wrong produces confident nonsense. Provider
reducers stay in each gatekeeper as pure functions; the kit deliberately ships no generic
collection overlay and no recursive ID substitution.

`targets` returns an array, not an `Iterable<Target>`. Every simulating gatekeeper's target is a
scalar string — notion's `actionPageId(action): string | null`, linear's `issueRef: string`,
github's `targetId: string`, jira's issue key — and `string` satisfies `Iterable<string>`, so the
natural `action => action.target` (or `action => actionPageId(action) ?? []`, where both branches
qualify) would compile, index one character per target, and leave `forTarget` answering every real
target with nothing: a simulated read that is silently stale rather than wrong. An array refuses
both spellings, and the port writes `id ? [id] : []`. `__tests__/simulation.test.ts` pins that with
`@ts-expect-error`, so restoring the looser type fails the type check rather than the suite.

`ProvisionalIds` namespaces are a **disjointness convention, not a checked one**: bindings are keyed
`${namespace}prov:${id}` with no separator between the two consumer-supplied parts, so two instances
in one DO whose namespaces are prefixes of each other can collide (`("", "prov:~1")` and
`("prov:", "~1")` both land on `prov:prov:~1`). Left unchecked
deliberately — unlike `setPrefix` in §4.7, there is no fixed kit prefix for a consumer prefix to
overlap with, only sibling namespaces the consumer chose, and no DO in either corpus holds more than
one `ProvisionalIds`. Length-prefixing would change the documented key layout to defend against a
consumer colliding with itself.

### 4.10 `./cache`

`KvTtlCache` — `cached<T>(key, ttlMs, load)` and `invalidateAll()`. Consumers construct it with
`KvTtlCache.partitionedBy(kv, source, options?)`, which wires the authority to the source's live
`authority()`; the raw constructor `(kv, authority: () => string | undefined, options?)` remains
for static and composite authorities. `options.name`, when present, must match
`/^[A-Za-z0-9_-]+$/` and gives the logical cache family its own key and generation namespace under
a `cache:@<name>:` prefix. The sigil is what makes the namespaces provably disjoint: plain
`cache:<name>:` would let a cache named `entry` write `cache:entry:generation`, which is the
unnamed layout's own entry for the key `"generation"`. There
is no public `get`/`put` pair: a read-then-store cache whose two halves are separately callable puts
the generation fence in the caller's hands, and the fence is the whole point. `cached()` reads the
generation and the authority before `load()` and again after, and stores only if neither moved — so
a fetch that started before an `invalidateAll()` or a reconnect is handed to the caller that asked
for it (which asked before the change) and deliberately not written. Values live inside the
generation that `invalidateAll()`
invalidates wholesale, the pattern `SupabaseCache` uses at `supabase.ts:777-806` to drop cached
schema after a mutating statement applies.

**Entries are partitioned by authority, read per call and never captured.** Every entry carries the
authority current when it was stored, and a read hits only when that matches the authority *now*,
the generation matches, and the TTL has
not elapsed. The corpus has 21 metadata caches across 16 packages, **none** partitioned by
principal; 12 of them are durable or warm enough to serve old-principal data after a reconnect, and
not one reconnect path clears metadata — each replaces the credentials and calls
`credentialsRestored()` with the resource cache untouched (`github.ts:1111-1118`,
`google.ts:511-522`, `notion.ts:384-392`, `confluence.ts:320-327`, `spotify.ts:553-562`). mcp's
`connectionGeneration` is the closest discipline (`account.ts:304-310`), and even there the catalog's
own key is the static string `"catalog"` (`catalog.ts:81`). The authority must therefore be an
opaque, non-secret identity covering the account, the resource scope, and any policy that changes
what the provider would return — never an email or other display value.

**A captured authority would defeat the partition it exists for.** An in-place reconnect replaces
the grant under a live facet, and the long-lived cache object is the prevalent corpus shape, not the
exception — slack's `#apiInstance ??=` lives for the DO (`slack.ts:862-874`), jira's `#cache` and
`#metadata` are instance fields (`jira.ts:1310-1312`), mcp-shared's `#hydrated` is a facet field
(`facet.ts:63-64`) — and it is also the only shape in which the coalescing below pays for itself. A
frozen authority would then serve the old principal's entries and, worse, stamp the *new*
principal's data with the old identity, an entry that inverts the guarantee below rather than merely
going stale. `CredentialCoordinator.identity()` cannot serve: every successful refresh supersedes
it, so keying on it silently discards the whole cache each time the grant renews. The account-side
source is `connectionGeneration()` (§4.6) — a live storage read that survives refresh and rotates
on `connect()`/`clear()`. A facet reaches it through
`CredentialSource.authority()`: the generation rides every `getCredentials()` and
the source surfaces the last-seen value synchronously, so the authority costs no round trip of its
own. `KvTtlCache.partitionedBy(kv, source)` is that wiring, blessed: it takes the source itself
(structurally — anything with `authority()`, so the cache module never names the credential
domain), so a port never writes the authority
closure a captured value, an `identity()`, or a static string would silently break. An authority
with more dimensions (resource scope, policy) composes its own closure for the raw constructor;
per-kind scoping stays in key segments (below). `undefined` — before the operation's first
credential fetch, or from a reported expiry until a fetch started after the report adopts a
different identity —
means the partition is unknown, and the cache **bypasses** rather than hits or stores: an entry
served or stamped without a partition is exactly the cross-principal leak the authority exists to
prevent. The residual window is a last-seen value going stale between an in-place reconnect and the
facet's next credential *fetch* — TTL-bounded, and closed by any operation that misses, since a
miss reads the account afresh (§4.6). A hit-only workload does not close it: it keeps serving the
previous connection's entries until their TTL, so a port that cares calls `invalidateAll()` from
its reconnect path. An async authority was considered and rejected: a DO
round trip per cache read defeats the cache, and an RPC-fetched fence races the reconnect it
fences.

**Within one cache namespace, the generation record is deliberately not authority-partitioned.**
It is one counter, so a bump made under one authority also invalidates another's entries. That only
ever over-invalidates, which costs a refetch; under-invalidation is already impossible once entries
carry the authority. One mechanism, not two.

The unnamed layout remains `cache:entry:<key>` plus `cache:generation` for compatibility. That also
means every unnamed instance over one KV shares both keys and generation: colliding `cached()` keys
serve each other's values, and either instance's `invalidateAll()` invalidates both. A validated
`name` changes the layout to `cache:@<name>:entry:<key>` plus `cache:@<name>:generation`, isolating
logical cache families without making per-kind segments a second option (`cache.ts:26-86,97-129`).
The sigil is load-bearing: plain `cache:<name>:` would let a cache named `entry` write
`cache:entry:generation`, which is the unnamed layout's own entry for the key `"generation"`.

A stale, generation-mismatched or foreign-authority entry is an ordinary **miss**, left where it is:
the generation counter lives under a stable key, so a bump never grows the keyspace, and the next
fill overwrites the entry. That narrows `CacheKv` to `get`/`put` — no `delete`.

**Concurrent misses coalesce.** An instance-local `Map` keyed
`` JSON.stringify([generation, authority, key]) `` holds the
in-flight load, so N callers missing one key run `load()` once, and the entry is cleared in a
`finally` only when it is still the same promise — the guard shape `CredentialSource` uses. Both the
generation and the authority are part of that key, so a load started before a bump or a reconnect is
never shared with a caller that arrived after it — the latter would hand the new principal a value
fetched with the old one's credentials. Encoded rather than joined with a delimiter, since an
authority composed by a port may itself contain one. Without the coalescing, the later-started load
could store first and the earlier one
overwrite it with older data plus a fresh `fetchedAt`, stale for the full TTL. The coalescing is
per-instance, so it does nothing for a consumer that constructs a cache per call
(`supabase.ts:1023`); that is a consumer-side lifetime choice, not something the cache can fix.

### 4.11 `./cursors`

`ArrayCursor<T>`, `PageNumberCursor<T>`, `OffsetCursor<T>` and `TokenCursor<T>`, all extending
`RpcTarget` and implementing the `Cursor<T>` contract from `workshop-shared/gatekeeper`, generalized
from `gatekeeper-github/src/github.ts:809-929`. The scope is **pagination mechanics only**: a cursor
owns provider paging state, buffers pages, and hands out fixed-size ones. `fetchPage` returns the
session's own item type, so each provider cursor takes a single type parameter.

Provider-backed cursor options also share `dispose?(): void`. `BufferedCursor` exposes
`[Symbol.dispose]()` and calls that hook once, so a fetch callback may release a duplicated RPC stub
when the cursor target is dropped; without it, the callback may only borrow session-owned stubs.
`ArrayCursor` is unchanged because it owns no external resource, and `next()` after disposal keeps
its old behavior — whatever the callback released or borrowed decides the result
(`cursors.ts:34-87`).

The provider cursors stream; the split is what the paging state is, because a capped page moves each
differently. A page number stays aligned under a cap — the provider clamps `perPage` consistently —
so `PageNumberCursor` advances by one page. A numeric offset does not: jira clamps `maxResults`
silently, and `page * perPage` arithmetic then skips the rows between with no error anywhere, so
`OffsetCursor` advances by the raw rows returned instead. A provider whose short pages do not even
reflect the rows it consumed — a server-side-filtered search with its own next signal, confluence's
v1 CQL — is a `TokenCursor` carrying that signal as its token.

There is no `overlay`, `map` or injected-item merging. Each came from one gatekeeper's shape, with
ordering and authorization needs the others do not share. `retain` is the one post-fetch step left,
and the ordering rule below is what keeps it from costing a page.

Filtering is the exception, because a numeric walk has no end-of-list signal but the row count.
The numeric cursors' `fetchPage` therefore returns the provider's page **unfiltered** and an optional
`retain` narrows it afterwards: dropping rows in the fetch ends the walk on a page that merely held
none the caller may see. This is the live bug in the prior art — `#listIssueSummaries` filters
`pull_request` rows inside its fetch (`gatekeeper-github/src/github.ts:2516-2542`) against a cursor
that ends on a short page (`:904-912`), and GitHub's Issues endpoint genuinely returns pull requests,
so a page of them silently truncates the list. `gatekeeper-google/src/cursor.ts:26-34` and
`gatekeeper-cloudflare/src/observability-api.ts:181,614` both put the split in the pager for the same
reason. `TokenCursor` needs no such option: `nextToken` ends its walk, so its `fetchPage` may filter
freely.

Three rules the prior art does not have. Only an **empty** provider page ends a numeric walk
(providers cap page size below what was asked for — Cloudflare's own `/accounts` answers 20 to a
request for 100 — so treating a short page as the end silently omits every later record). A page the
caller sees nothing in is not the end either, so one `next()` fetches at most
`MAX_PROVIDER_PAGES_PER_CALL` (10) pages — **every** page, not just consecutive empty ones, since a
provider yielding one surviving row every few pages would otherwise cost hundreds of fetches in one
call — and then yields what it has, `[]` included, which invites another call where `null` would
claim the list had ended. The bound is latency, not quota: the fetches are sequential and the caller
is blocked on them, while 10 still fills a 100-row page from a provider dropping 90% of what it
returns. A short page is legal, so a port needing more per call raises `remotePageSize` rather than
expecting one call to fill.
And `next()` is serialized on a `SerialTaskQueue` (§4.12), since two un-awaited callers racing on the
page counter would return one page twice and skip the next.

**Nothing latches a failure, because no paging state moves until every step that can throw has
run.** `PageNumberCursor` and `OffsetCursor` decide exhaustion from the raw page and apply `retain`
before their position and `remoteExhausted` move; `TokenCursor` decides exhaustion and refuses an echoed
token before `#token` moves. A throw therefore leaves the walk on the page it failed — advancing
first would skip that page for good on the retry, since the position lives in the cursor and not in
the caller's hands. Both are resumable by construction, so the cursors hold no resumable-region
machinery and no failure flag: a transient 5xx costs the caller a retry, not the whole walk.

**The echo check is one-step, and deliberately not a lifetime bound.** It catches `t → t`, the
shape a stuck provider actually produces; a longer continuation cycle (`a → b → a`) passes it and
the walk never terminates, re-releasing the same rows. Refusing that needs either a remembered
token set, which is unbounded, or a lifetime page ceiling — and a ceiling has no honest default: it
cannot distinguish a cyclic provider from a legitimately enormous collection, so it would convert a
provider bug into a truncated read. The per-call bound above is what protects the request; a cyclic
provider is bounded instead by the caller, which sees duplicate rows and stops. If a port meets a
provider that cycles, the fix belongs in its `fetchPage`, which knows what its tokens mean.

Both are undecorated, and a decorator would add nothing: on a server target `@validateRpc()`
validates incoming arguments, and `next()` takes none (returns are checked caller-side by
`validateStub<T>()`). A consumer wanting one anyway declares
`@validateRpc<Cursor<Item>>() class ItemCursor extends ArrayCursor<Item> {}` locally.

`TokenCursor<T>` is the same cursor for a provider that pages by opaque continuation token rather
than page number — marketo's `nextPageToken`/`moreResult`, notion, confluence, cloudflare, and
mcp-shared's client, five of the corpus providers. It is a separate class, not a widened numeric
`fetchPage` signature, because **the exhaustion rule inverts**: only an absent `nextToken` ends the
walk, and an empty page carrying one is an ordinary idle window in an activity stream. A cursor
that inferred the end from an empty page — as page-number paging must — would silently truncate,
which is exactly the data loss marketo's own pager documents (`types.d.ts:357-358`, pinned by
`marketo.test.ts:2999-3007`). The empty string is a **valid** token, so exhaustion is
`nextToken === undefined` and nothing else; mcp-shared learned the same thing
(`client.ts:628-679`).

Two rules follow from the token being opaque, and both belong to this class alone. A page whose
`nextToken` equals the token it was *asked* to continue from throws: the provider is ignoring the
token, and the walk would otherwise re-fetch that page until a cap. Only the immediately-prior token
is compared — an unbounded seen-set would grow with the walk it is meant to protect — and the first
page, asked `undefined`, is exempt by construction. The refusal is stable and non-advancing, so a
retry re-asks the same token and is refused again rather than losing the position. And a fixed
shared `MAX_PROVIDER_PAGES_PER_CALL` bound of **10 provider pages** per `next()` call keeps a quiet
stream from looping forever and also bounds sparse streams: every provider page counts, not just
consecutive empty ones. At the bound `next()` returns the buffer *even when empty*, because `[]` is
a legal non-terminal page (only `null` ends a `Cursor`) and the next call resumes the walk with a
window. It is not an option: google's `CursorPager` hard-codes its own bound, internal cf-wiki loops
unbounded (a hang on a broken provider), and nobody tunes it per resource. The numeric cursor needs
no such bound, since an empty page ends its walk. Neither detects a provider that ignores the page
argument and keeps answering with rows, which yields duplicates instead of ending; that needs an item
identity the cursor does not have, and no page ceiling substitutes for one.

### 4.12 `./serial-queue` — internal

```ts
export class SerialTaskQueue { run<T>(op: () => T | Promise<T>): Promise<T> }
```

`SerialTaskQueue` is an **internal module, not a public subpath**: no consumer needs it, and the one
caller that used to reach for it — a facet's revert hook — now goes through
`BoundActionSet.runExclusive` (§4.8), which is the queue it actually has to join. It is its own
module because two unrelated leaves need it — the action journal serializes resolution so one
action cannot be applied twice (§4.8), and each cursor's `next()` serializes paging so two callers
cannot claim one provider page (§4.11). Both had mutable state behind an await, and both had
hand-rolled the same gate with the same reasoning in a comment, which is the point at which a second
copy becomes a parallel mechanism that drifts. Nothing else in either corpus has this primitive.

A **gate** rather than a chain of results: the promise stored for the next caller settles regardless
of outcome, so a rejection neither blocks later operations nor leaves an unhandled rejection behind.
Specifically not a tail-chain (`this.#gate = this.#gate.then(op).then(noop, noop)`), because `.then`
adopts an async operation's already-rejected promise through a deferred thenable-adoption microtask,
leaving it momentarily handlerless — and workerd reports that eagerly where Node waits for the queue
to drain. Validated 2026-08-29 in an isolated `@cloudflare/vitest-pool-workers` sandbox at compat
date 2026-02-02: the tail-chain passes under Node and reports `Unhandled Rejection` under workerd
for an operation that rejects before its first await. That difference is why the queue keeps
`__tests__/workerd/serial-queue.test.ts` beside the Node one.

Callers await or return what `run` hands back; an unattached rejecting promise is reported unhandled
like any other. `run` claims the gate before its first await, so concurrent callers cannot capture
the same predecessor, and a nested `run` on the same queue deadlocks by construction — see the
warning on `BoundActionSet.runExclusive`.

### 4.13 `./auth-retry`

```ts
export type AuthRetryOptions<Token> = {
  getToken(options: { forceRefresh: boolean; staleToken?: Token }): Promise<Token>;
  isAuthError(error: unknown): boolean;          // the provider rejecting the credential, not 5xx
  replayable: true;                              // explicit acknowledgment: `run` may execute twice
};
export function withAuthRetry<Token, T>(options: AuthRetryOptions<Token>,
  run: (token: Token) => Promise<T>): Promise<T>;
```

`CredentialSource.run()` resolves every credential rejection through the account's verdict, heal
included (§4.6); what `replayable` adds is the retry on a `"superseded"` answer. For the five
gatekeepers whose 401 means the grant is gone (supabase,
github, linear, spotify, homeassistant), the verdict alone is the whole story. The four that mint
a short-lived derived
bearer from a longer-lived grant, where a 401 usually means *that bearer* is stale, want the
rejection healed and the call retried. All four
hand-roll the same single retry: marketo (`marketo-api.ts:462-477`), google
(`auth-retry.ts:100-141`, which additionally force-refreshes with the rejected token's identity),
notion (`notion-api.ts:1022-1052`) and confluence (`confluence-api.ts:527-550`).

One retry, never a loop — a credential the provider rejects twice is not going to be accepted on a
third attempt, and a loop turns a dead grant into a burst of token mints. `run` therefore executes
**at most twice**; the required `replayable: true` field acknowledges that the operation is safe to
execute twice, which means building the request inside it rather than passing a prepared one.
`staleToken` carries the rejected token into
the refresh so a shared cache can skip a redundant mint when another caller already advanced it
(google's shape). A non-auth error at either attempt propagates immediately: transport failures and
5xx are not credential problems, and retrying them here would double every provider outage.

**This module reports nothing, and a `CredentialSource.run()` wrapped around it cannot reliably
report either** *(revised 2026-09-03; this section previously blessed that composition)*: a
report is fenced on the identity the source observed, and `withAuthRetry`'s refresh happens where
no source sees it. For a grant that rotates on refresh — confluence persists a rotated refresh
token on every redemption (`confluence.ts:372`) — the mint supersedes the identity mid-operation,
so a persistent 401's report names the superseded grant and the account's fence gates it out: the
dead grant stays accepted and the Workshop is never told to reconnect. The retry a source user
needs therefore lives *behind the reporter* *(rewritten 2026-09-04 — the in-source replay this
section previously specified collapsed into the verdict protocol; the dated inversion below
records why)*: the account heals past a rejected-but-current credential *inside*
`reportCredentialsRejected`, and `run(operation, { replayable: true })` retries once on its
`"superseded"` answer. The whole protocol is three verdicts and one refetch. `"expired"` is
provider-confirmed grant death, already notified account-side — or a disconnect discovered during
the adjudication, which leaves no successor to retry into and never notifies: `run` throws
`CredentialsExpiredError(expiredMessage)` and marks the identity dead. `"superseded"` means a live
successor replaced the rejected identity — already replaced, or just healed past
by `adjudicateRejection`'s fence-keyed `rotate()` (§4.6): a non-replayable `run` throws
`CredentialsChangedError` and the caller re-enters; a replayable one refetches and retries. The
refetch is ordering, not hope: the ask's fence bump forgot the pre-ask flight, so the retry opens
a fresh account read, and the single-threaded account answers it after the heal's commit. Three
local guards keep the retry single-shot and honest — a moved generation rethrows as "changed" (a
reconnect: never run under a principal the caller didn't start with), an unmoved identity
rethrows likewise (a lazy hand-written stub re-served the rejected credentials; the source cannot
verify freshness for it, but it can refuse to burn the retry proving nothing), and an identity
already in the dead set resolves as expiry without a provider call. The retry's own rejection is
adjudicated but never retried — at most two executions, same doctrine as this module.
`"unavailable"` is the heal failing for non-credential reasons: nothing was adjudicated, the
caller gets the provider rejection it actually saw, and the token endpoint's error lives in the
account's logs. A read superseded before any ask — a live successor adopted mid-operation — still
skips the report entirely: its failure has nothing to tell a caller who only needs to re-enter.
Identity succession is the account's to adjudicate: the moved-past gate resolves any identity
that is not its current one by successor — `"superseded"` when a live one is stored, `"expired"`
after a disconnect ("" — a never-connected read — never matches, always `"superseded"`) — and
the verdict adjudicates identity, never notification delivery, whose latch deliberately stays
unset on a failed callback so a later expiry re-notifies. The rejected
authority drops at the ask: the rejection already proves the snapshot cannot vouch whichever way
the answer goes — dead, its partition could serve the next principal stale data on a hit;
superseded, it no longer vouches for the current principal (§4.10) — so cache-first readers
bypass during the round trip instead of serving the rejected partition. A read landing mid-ask is
served to its caller but never adopted — the pending ask blocks handing the rejected identity's
partition back before the verdict, so the bypass holds for the whole round trip — and the
authority drops again with the fences at the verdict, while the death mark itself waits for an
`"expired"` answer. Asks coalesce per identity: the verdict adjudicates the
identity, not the report, so concurrent reporters of one grant share the account round trip —
and the account's fence-keyed mint flight collapses their heals onto one provider call; each
reporter still takes its own drops around the shared answer.
`withAuthRetry` remains for token flows that hold no source, where nothing reports; a configurator
holds one (`AccountHandle.creds`, §5.1) wired through the same account stub, keeping refresh
material account-side (§5.6).

**Inverted 2026-09-04, superseding the 2026-09-03 adjudication that kept the replay
source-side.** That adjudication weighed the account-side alternative — the account minting
inside the report and answering `"superseded"` — and rejected it on four costs. Re-weighed with
the branch built and pressure-tested against its consumers (of which there are zero), each fell.
*Caller-visible retry:* it isn't — `run` retries internally on the `"superseded"` answer, so the
routine stale-bearer 401 recovers exactly as invisibly as the in-source replay did, and the heal
now also covers **non-replayable** operations, closing the footgun where a stale derived bearer
on one falsely retired a healthy account (the old protocol could only report it as expiry).
*A third account round trip:* one to two extra same-colo RPCs on an error path only, priced
against a token mint and a provider 401 already being spent. *The healthy account takes authority
drops:* the ask-time drop is a cache-bypass window until the next read, `undefined` means bypass
— never a wrong answer — and zero cache consumers exist today. *One-retry ownership:* the
**source** owns replay-attempt counting and permits at most two executions of one `run`; the
**account** owns mint ordering and verdict authority. Its single-threaded DO plus the fence-keyed
mint flight collapses concurrent heals, while `notifyCredentialsExpiredOnce`'s durable latch
deduplicates notification. That division removes the source-side proposal's per-read replay flight
and `#crossed`/`#seen` generation bookkeeping without moving replay counting into cross-request
state: the account answers what happened to the rejected identity, and the source alone decides
whether its caller may spend the one retry. The deciding evidence is unchanged: every observed real
implementation (mcp-shared's `noteCredentialsExpired`, google's account-side mint with its
`staleToken` gate) already puts mint/verdict ordering account-side; the kit had armored the consumer
and left the account bring-your-own. Deliberately not carried over: a durable dead-grant mint
latch — a repeat report
against a dead grant costs one provider call answering `invalid_grant` again, same verdict, and a
port that measures mint spam adds a cooldown inside its `refresh` callback (google's
`#mintFailure` shape), which is the escape hatch's job, not the kit's. The residual costs,
accepted: heal-infrastructure errors reach the caller as the original 401 with the token
endpoint's error in account logs; a double fault — the 401 plus a lost RPC reply after a
successful heal — also surfaces that original provider error, never an invented expiry, and the
next fetch recovers; and a hand-rolled account carries the ordering
contract the coordinator helpers otherwise own, mitigated by `adjudicateRejection` being the
reference implementation and by the source's same-identity retry guard.

**Where the refresh comes from is still the port's, and it is account-side by construction.** For
the five providers whose 401 means the grant is gone, there is nothing to wire: the account
passes no `refresh` to `adjudicateRejection`, so a current-identity rejection notifies and
answers `"expired"` before any retry (a grant-death port passing `replayable` is harmless). For
the four that mint a derived bearer, the mint is the `refresh` callback handed to
`adjudicateRejection` — bare by design, so provider-specific mint logic (cooldowns, `staleToken`
skips, scope handling) lives inside the port's callback, not in kit options.
`getCredentials()` alone cannot serve: it is `coordinator.fresh(...)`, which
refreshes on expiry only, so a grant killed by `invalid_grant` while its access token is still
unexpired would be re-served unchanged — `adjudicateRejection`'s `rotate()` is what forces the
mint past it.

This closes the "401 retry" logic the §4.8 table recorded as deferred and names its refresh
channel (the `refresh` callback of `CredentialCoordinator.adjudicateRejection`), superseding the
§5.6 deferral below.

### 4.14 `./endpoint`

```ts
export function normalizeVendorEndpoint(raw: string, options: {
  hostPattern: RegExp;              // non-global, non-sticky; ANCHORED BY THE KIT, tested against
                                    // url.hostname, so any port is accepted and preserved
  label: string;                    // names the endpoint in the thrown message
  requireHttps?: boolean;           // default true
}): string;                         // origin + normalized path; no query, userinfo or fragment
```

For the operator-pasted endpoint an instance-hosted vendor needs (marketo's `<munchkin>.mktorest.com`,
a self-hosted Confluence, a Home Assistant on someone's LAN). Marketo validates against an anchored
allowlist (`config.ts:91-110`); homeassistant checks the scheme and nothing else
(`homeassistant.ts:317-322`), so today an operator can point it at any host that speaks HTTP,
including one the Worker reaches but the operator cannot.

**Anchoring is enforced, not documented.** The caller's pattern is recompiled as
`^(?:<source>)$` with its own flags. The non-capturing group is what makes an unanchored
alternation behave: comparing a match against the host instead would false-reject
`/a\.com|sub\.a\.com/` on `sub.a.com`, whose leftmost match is `a.com`. An unanchored
`/marketo\.com/` therefore refuses `https://evil-marketo.com.attacker.net` rather than accepting it.

**It returns an endpoint, not an origin, and matches on the hostname.** Two corpus facts force both.
No shipped validator reduces an endpoint to an origin: mcp-shared keeps path and query deliberately
("Path and query are part of which server is being spoken to", `scope.ts:49-52`), homeassistant
reconstructs and keeps the path (`homeassistant.ts:321-322`), and generic HTTP stores the value as
supplied — so a port adopting this on a self-hosted base URL such as `https://ha.example.com/hass`
would silently lose `/hass`. And `url.host` carries the port, so an anchored `/^ha\.example\.com$/`
tested against it would refuse `ha.example.com:8123`, while 6 of the corpus's 7 endpoint choices
accept an explicit port and home assistant's own form documents "port if non-standard"
(`homeassistant.ts:217`). Matching `url.hostname` accepts and preserves any port: the allowlist pins
*which vendor* is being addressed, and a different port on an allowlisted host is the same host. The
returned value is `origin + pathname` with trailing slashes stripped (`"/"` reducing to `""`), so a
vendor with no path gets exactly the old origin output; query and fragment are dropped, and a URL
carrying userinfo is refused outright, as mcp-portal does (`config.ts:87`).

A `g` or `y` pattern is refused outright,
because `RegExp.test` advances `lastIndex` on those: the same endpoint would be accepted, then
refused, then accepted. Nondeterminism keyed on call count is the worst failure this leaf could
have, and it is a programming error rather than bad input, so it throws on every call instead of
every other one. Thrown messages name the `label` and never
echo the input, since the input reaches an operator-visible error page and may carry a token in its
query. mcp-shared's endpoint **blocklist** (`endpoint.ts:17-45`) is deliberately not re-homed here:
it is MCP-scoped SSRF defence with its own trust boundary, and moving it would churn shipped code
for no new consumer.

### 4.15 `./response-body`

```ts
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export class ResponseTooLargeError extends Error {}
export function readTextCapped(response: Response, maxBytes?: number): Promise<string>;
```

The one thing the competing `gatekeeper-factory-research` branch surfaced that belongs here — and it
is not that branch's code. Two shipped readers already do this, written independently, each missing
the half the other has: mcp-shared streams and cancels on overflow but never reads
`Content-Length` (`mcp-shared/src/fetch.ts:60-100`), while cloudflare checks the header and then
leaks the reader lock when a chunk throws (`observability-api.ts:219-253`), so a caller retrying the
same body gets an opaque "already locked" instead of the provider's error. This is both halves.

Both checks are needed and neither subsumes the other: the header is a provider claim, so the
running total is the actual enforcement, but waiting for the stream wastes the whole transfer when
the claim was honest. Refused rather than truncated, because half a JSON document does not parse and
a clipped SSE stream can drop the event carrying the response — a size problem should not surface as
a protocol error. The error type is the caller's to re-wrap: cloudflare needs its own
`CloudflareObservabilityApiError` with a status, and a shared error carrying a provider-shaped
status would be a worse fit than a catch.

Two orderings inside it are load-bearing. A bodyless response is answered `""` **before** the
`Content-Length` check, since a HEAD or 304 legitimately advertises a length it will never send and
refusing one would raise a size error for a body that does not exist. And both cancellations are
best-effort: cancelling is cleanup on a path that has already decided to throw
`ResponseTooLargeError`, so letting a rejected `cancel()` propagate would report a stream-teardown
failure in place of the size limit that actually fired.

Deliberately **only** the reader. Redirect following, SSRF re-checks per hop, retry and deadline
composition stay out: mcp-shared re-validates every hop against a public-host blocklist and drops
origin-scoped headers when one crosses origins (`fetch.ts:142-209`), the factory branch instead
refuses any redirect leaving its declared origin, and `normalizeVendorEndpoint` (§4.14) admits an
operator-pasted vendor host. Those are three different trust boundaries, and a helper spanning them
would have to expose knobs for exactly the policy it claims to centralize.

### 4.16 `./preview-oauth`

```ts
export type PreviewOAuthEnv = {
  OAUTH_ALLOW_PREVIEW_REDIRECTS?: boolean | string;
  OAUTH_REDIRECT_URI?: string;
  OAUTH_STATE_SIGNING_SECRET?: string;
};
export type PreviewOAuthState = { userObjectId: string; oauthNonce: string };
export type PreviewOAuthCallbackResult =
  | { kind: "local"; state: PreviewOAuthState }
  | { kind: "relay"; response: Response };
export class PreviewOAuthConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions);
}
export class PreviewOAuth {
  readonly redirectUri: string;
  constructor(options: {
    callbackUri: string;
    env: PreviewOAuthEnv;
    relayParams?: readonly string[];
  });
  createAuthorizationState(state: PreviewOAuthState): Promise<string>;
  handleCallback(callbackUrl: URL): Promise<PreviewOAuthCallbackResult>;
}
```

This is Google's preview callback relay generalized without changing its state wire format: direct
flows retain the `64hex:64hex` form, while preview flows use a ten-minute HS256 JWT carrying the
same two identifiers and the preview return URL. `redirectUri` is the exact value to persist through
the code exchange; `createAuthorizationState` builds provider-facing state, and `handleCallback`
returns either verified local state or an already-filtered relay `Response`. Return URLs are limited
to the stable callback's exact path and Worker Preview host suffixes. The relay forwards `code`,
`error`, `error_description`, `error_uri`, and `iss` plus constructor-configured `relayParams`;
`state` is kit-owned and always written last, and either adding it or duplicating a default throws
`PreviewOAuthConfigurationError`. Every occurrence of a forwarded parameter is appended, empty
values included: `iss` is the RFC 9207 mix-up defense and the preview's own check is what decides
whether an issuer is acceptable, so a collapsed duplicate would hide the ambiguity from the code
that enforces it. It must survive the relay
(`preview-oauth.ts:28-53,151-209,246-300`). Google is the first consumer; other gatekeepers can
adopt the leaf without porting to the assembly.

### 4.17 `./action-files`

```ts
export const ACTION_FILE_CHUNK_BYTES = 1024 * 1024;
export type ActionFileReference = { readonly handle: string; readonly size: number;
  readonly digest: string };
export type ActionFileStoreOptions = { readonly filePrefix: string;
  readonly allocationPrefix: string; readonly maxFileBytes: number;
  readonly maxTotalBytes: number };
export type ActionFileStorage = { readonly kv: KvScannable;
  transactionSync<T>(callback: () => T): T };
export class ActionFileStore {
  constructor(storage: ActionFileStorage, options: ActionFileStoreOptions);
  capture(bytes: Uint8Array): Promise<ActionFileReference>;
  read(file: ActionFileReference): Promise<Uint8Array>;
  delete(file: ActionFileReference | undefined): void;
  pruneUnreferenced(referencedHandles: ReadonlySet<string>, createdBefore: number): void;
}
```

`ActionFileStore` keeps queued-action bytes out of action records as bounded, SHA-256-checked
one-MiB chunks. Capture writes the manifest, chunks, allocation, and aggregate accounting in one
synchronous transaction; deletion removes the same record family and releases its allocation in
one transaction (`action-files.ts:4-35,53-221`). It is consumed today
by google's `GmailForwardSnapshotStore` for exact inline-forward source snapshots
(`gmail-state.ts:5-34`; `gmail.ts:255-273,730-744`) and by `ConfluenceStore` for pending attachment
uploads, including orphan pruning and release after resolution
(`confluence-actions.ts:50-62,83-106,162-186,590-613`).

## 5. Layer 2: the assembly

**Layer-1 reconciliation, 2026-09-05 — the leaf contracts this section now builds on.** Observation
settlement is now fail-closed by outcome:
`OBSERVATION_REFUSED_CODE` and `isObservationRefused` are kit-local, a marked refusal may discard
prepared state, and an unknown result abandons only in-memory claims while durable fences remain.
The kernel half is deliberately held — `workshop-backend` still throws the two refusals unmarked and
`workshop-shared` is unchanged — so nothing reclaims until the later kernel PR moves the canonical
mark and applies it there. Pending-set reclamation itself is ready, claim-counted per storage, while
crash-stranded markers remain permanent.

Credential ownership gained the provider-side `discardMint` drain for a successful refresh that
loses its identity fence; `"unadjudicated"` now surfaces the caller's original provider error
instead of synthesizing expiry, `CredentialSource.read()` exposes only a fresh identity/generation
fence, and every credential replacement — `connect()` and a successful refresh alike — re-arms the
expiry latch inside `#commit`. Action staging gained
the opt-in equality-only `ActionFence`, apply-time generation and git-cache context, and unresolved
reference guard; `AuthRetryOptions.replayable: true` makes the two-execution acknowledgment explicit.
Journal retirement is tombstone-first, with scans ignoring and a replayed apply healing any stale
record left by an interrupted removal.

The smaller ownership seams landed with the same rule: provider cursors have a call-once disposal
hook, preview OAuth relays the standard callback error fields plus RFC 9207 `iss` and validated
extras, and named TTL caches isolate their entry and generation keyspaces while unnamed instances
retain the compatible shared namespace.

A review pass over that change set closed four holes in it, all reachable rather than theoretical.
Set-marker reclamation now tracks, per disclosed key, how many reads still owe it and whether every
claimant refused: a sibling settling with an unknown outcome fences the marker for good — the naive
claim count let a later refusal delete a marker whose sibling may already have been recorded, which
would have admitted a collaborator against undisclosed data — and the last claimant to settle
reclaims, so two refused reads of one set no longer strand its slot. The expiry latch moved from
`connect()` into `#commit`, since a refresh that landed while a notification for the credentials it
replaced was in flight could let that notification latch it and silence its own death. Named caches
took a `cache:@<name>:` prefix, because plain `cache:<name>:` let the name `entry` collide with the
unnamed layout. And `ProvisionalIds.isResolved` now classifies before consulting the binding table,
so the documented `isResolvedReference` spelling stops refusing an action whose `dependsOn`
reference is already a provider id.

A second pass, from a consumer's perspective, closed the gaps the first one opened or left. A
terminal failure the apply refused *before* dispatch is the one state that is terminal, has a
`reject` hook, and provably never ran it, so the record now carries `undispatched` and the user's
rejection runs the hook for it — otherwise the rejection the failure message asks for silently
dropped whatever staging had set up, and `ActionFileStore`'s `pruneUnreferenced` sweep is a port's
own opt-in, not kit GC. Stranded dependents carry the same mark, since a cascade never reaches
their handlers either, and an `undispatched` record prunes **last** among failures: dropping one
drops a rejection's obligation, not just the reason it failed. The latch re-arm moved again, out of
`#commit` for the legacy migration path only (`#publish`): moving a grant between storage layouts
replaces nothing, so re-arming there re-announced a death the account had already reported before
it was ported. The journal stores only the
`generation` an `ActionFence` declares, so handing `submit` a whole `CredentialRead` no longer
persists its identity fence. And a repeated custom `relayParams` key is refused like a repeated
built-in one, rather than appending each provider occurrence twice.

Three consumer findings were adjudicated as **not defects**, and one fix was reverted as one. A
death decided inside `#refresh` cannot notify against a replacement's identity: only microtasks
separate that decision from `snapshot`'s fence read, and a `connect()` is delivered on an I/O turn,
so the proposed "capture before the await" would instead read a fence a reconnect had already moved
and silence a genuine death. `clearCredentialExpiryLatch` stays ahead of the credential write in
`#commit`, because both land in one implicit transaction and latch-first fails toward a duplicate
notice where credentials-first fails toward silence. A delayed rejection verdict cannot report a
live successor dead, because `#moved()` answers `"expired"` only with nothing stored and
`#notified` re-checks the fence after its await; the successor's dropped authority and fenced
in-flight fetch are the deliberate conservatism `#verdict` documents, costing one refetch. And the
eviction sweep in `retire()` was reverted to an obligation row (§4.8): it needs a tear
`ctx.storage.kv` cannot produce, and it had inverted the tombstone-first ordering to get there.

### 5.1 `./spec`

```ts
export type KitEnv = { BASE_URL?: string; CLIENT_ID?: string; CLIENT_SECRET?: string };
export type KitAccountProps = { userObjectId: string };
export type KitLogger = { warn(msg: string, fields?: object): void;
                          error(msg: string, fields?: object): void };
export function getBaseUrl(env: KitEnv, id: string): string;
export function svgLogoUrl(svg: string): string;
// `Public` is what a facet/configurator may hold; `Grant` is what the account DO stores (§5.6).
export type AccountHandle<E, Public> = { env: E; creds: CredentialSource<Public> };

export function gatekeeperKit<E extends KitEnv, Grant, X, Public>(): {
  define(spec: GatekeeperSpecInput<E, Grant, X, Public>): GatekeeperSpec<E, Grant, X, Public>;
  resource<P extends Record<string, unknown>>(def: {
    supported: SupportedResource;
    tsType: string;                    // exported name in the effective types text (§5.10)
    hookTsType?: string;               // ditto, for resources whose sessions register hooks
    suggestedBindingName: string;      // e.g. "SUPABASE_PROJECT" — the resource *type*, not instance
    resolve?(url: URL): P | null;
    facet?(exports: X, props: KitAccountProps & P): DurableObjectClass<Gatekeeper<unknown>>;
    configurator?(h: AccountHandle<E, Public>): ResourceConfiguratorFrame;
    types?: string;                    // per-resource slice; default spec.types (§5.10)
  }): ResourceDef<E, Grant, X, Public>;
};

export type GatekeeperSpecInput<E, Grant, X, Public> = {
  id: string;                        // vendor id; names the dev BASE_URL default and log vendorId
  vendor: VendorDescription;         // the canonical type, reused directly
  auth: AuthStrategy<Grant, E>;      // the strategy mints and refreshes the *stored* grant
  account: {
    describe(h: AccountHandle<E, Public>): Promise<AccountDescription>;
    authenticatedEmail?(h: AccountHandle<E, Public>): Promise<string | null>;  // absent → null
  };
  resources: readonly ResourceDef<E, Grant, X, Public>[];
  types: string;                     // the types.txt text
  notConfigured?: { title: string; detail: string };
  logger?: KitLogger;
};
```

The factory is curried so the type parameters are written once per gatekeeper. **`Grant` and
`Public` are separate on purpose**: the strategy mints, refreshes and revokes the stored grant,
while everything reachable from a facet, configurator or verifier holds only the projection §5.6's
`publicCredentials` produces. Writing one letter for both is what would carry refresh material
across the RPC boundary, so the two are threaded apart from `gatekeeperKit()` down. `Public` has
**no default**: `Public = Grant` is honest for a gatekeeper with no refresh flow (github), but as a
default it makes forgetting the argument publish the stored grant, which is the one mistake this
split exists to prevent. `X` is the
consumer's generated `Cloudflare.Exports` (from `wrangler types`), which is how spec closures like
`facet: (exports, props) => exports.SupabaseGatekeeperImpl({ props })` type-check without a cast;
the kit's own source never references the `Cloudflare` namespace. `define()` freezes the spec and
validates it: unique `urlPattern`s, a non-empty id, and — for every resource — that `tsType` and
`hookTsType` name exports of the effective types text (§5.10). `resource()` exists to infer `P`
from `resolve` and thread it into `facet`'s props parameter, then erase it. `getBaseUrl` returns
`env.BASE_URL ?? "http://localhost:8787/gatekeeper/${id}"` with trailing slashes stripped via the
existing `stripTrailingSlashes` from `workshop-shared/gatekeeper`. `notConfigured` defaults its
title to `${vendor.displayName} Gatekeeper Not Configured`.

### 5.2 `./auth` — the strategy seam

```ts
export type BeginResult = { redirectUrl: string } | { html: string };
export type AttemptMetadata = { connect?: GatekeeperConnectOptions; [key: string]: unknown };
// A fresh Durable Object stub per call, never a property-derived RpcStub the strategy would leak.
export type StrategyAccountStub = { completeAuth(payload: unknown, state: string): Promise<boolean> };

export interface AuthStrategy<Creds, E extends KitEnv = KitEnv> {
  configured(env: E): boolean;
  routes(req: Request, ctx: { env: E; baseUrl: string; relPath: string; url: URL;
    accountForId(id: string): StrategyAccountStub }): Promise<Response | null>;
  begin(ctx: { env: E; baseUrl: string; accountId: string; state: string;
    metadata: AttemptMetadata; kv;            // "auth:"-namespaced view of account storage
    deliver(creds: Creds): Promise<void>;
    waitUntil(p: Promise<unknown>): void }): Promise<BeginResult>;
  obtain(ctx: { env: E; baseUrl: string; payload: unknown; metadata: AttemptMetadata;
    kv }): Promise<Creds>;
  refresh?(creds: Creds, ctx: { env: E }): Promise<Creds>;   // CredentialsExpiredError on grant death only
  heal?(creds: Creds, ctx: { env: E }): Promise<Creds>;  // mints past a rejected-but-current
                                             // bearer (adjudicateRejection's refresh, §5.6); absent = grant death
  revoke?(creds: Creds, ctx: { env: E }): Promise<void>;
  isAuthError(error: unknown): boolean;      // runtime API classification (CredentialSource.run)
  expiredMessage: string;
  expiresAt?(creds: Creds): number | undefined;
  refreshSkewMs?: number;
  // Layer 1's exact contract: reads only, and never deletes anything itself.
  legacyKeys?: readonly string[];
  upgradeStoredCredentials?(kv): Creds | undefined;
}
```

The seam covers three known shapes: redirect flows with a provider callback (`oauth2`), form
flows with no provider round trip (`tokenAuth`), and poll-based flows that complete from inside
the DO — the Cloudflare Access CLI flow returns a redirect from `begin` while scheduling
`waitUntil(poll().then(deliver))`, and serves its transfer proxy from `routes`. `deliver` is
therefore fenced on its own: it captures the attempt generation and no-ops if a revoke or a new
attempt overtook it, since a poll flow commits after `begin` returned and the account's post-begin
re-check cannot cover it.

`legacyKeys` and `upgradeStoredCredentials` pass straight through to `CredentialCoordinator` (§4.6):
the key list is declared, the hook only reads, and the coordinator reaps after the canonical record
exists and again on `clear()`. Splitting them that way is what makes the reap idempotent — a hook
that reported its own key list could only ever be reaped once, so a failed delete would strand the
old grant with no path back. Letting the hook delete would be worse still: a Durable Object's
implicit transaction is not rolled back by a throw, so a hook that deleted first and then threw on a
malformed record would leave the account with no grant and nothing to retry from.

A strategy that needs durable state beyond credentials (a DCR client registration, a PKCE
verifier) keeps it in its namespaced `kv` view, keyed by state — not in attempt metadata: that
record is written by `advanceToOAuth` before `begin` runs, and DO KV structured-clones on `put`, so
a value minted inside `begin` cannot reach it by mutation.

### 5.3 `./auth-oauth2`

```ts
export function oauth2<Creds, E extends KitEnv = KitEnv>(config: {
  authorizeUrl: string | ((env: E) => string);
  clientCredentials?(env: E): { id: string; secret: string } | undefined;  // default env.CLIENT_ID/SECRET
  scopes?: { full: string[]; auth?: string[]; param?: string; join?: string };
  extraAuthorizeParams?: Record<string, string>;
  pkce?: boolean;                                        // S256; verifier lives in the strategy's kv view, keyed by state
  exchange(ctx: { code: string; redirectUri: string; client: { id: string; secret: string };
    env: E; codeVerifier?: string; requestedScopes?: string[] }): Promise<Creds>;
  refresh?; heal?; revoke?; isAuthError; expiredMessage; expiresAt?; refreshSkewMs?;
  legacyKeys?: readonly string[];
  upgradeStoredCredentials?;
}): AuthStrategy<Creds, E>;
```

Provider behavior remains compatible with the handlers it replaces (`supabase.ts:267-334`,
`github.ts:931-1004`): `begin` builds the authorize URL carrying `client_id`,
`redirect_uri = ${baseUrl}/oauth`, `state = ${accountId}:${stateNonce}`, scope/PKCE/extra params;
`routes` handles exactly `GET /oauth`, parses state, and dispatches to the account DO. Provider
errors yield a 400 plain-text restart message; malformed or expired callbacks render
`INVALID_LINK_HTML`.
`scopes.auth` is the sign-in-only subset used when
`GatekeeperConnectOptions.scopes === "auth"`. The README instructs config
authors to wrap provider refresh calls so only 400/401/`invalid_grant`/`invalid_token` become
`CredentialsExpiredError` and everything else rethrows untouched.

### 5.4 `./auth-token`

`tokenAuth<Creds, E>(config)` for user-pasted secrets (the shape internal gatekeepers like sentry
need): `begin` returns `{ html }` — a minimal form styled with `PAGE_STYLE`, fields from
`config.fields: { name, label, secret?: boolean }[]`, a hidden `state`, posting to
`${baseUrl}/connect/${accountId}`; `routes` handles that POST, first calls
`connectMutationError(req, { origin: baseUrl, contentType: "application/x-www-form-urlencoded" })`
(the expected origin is the base URL's, never `req.url`'s — §4.3) and renders any
refusal, then reads the form and calls `completeAuth(formFields, state)`; `obtain` delegates to
`config.validate(fields, env): Promise<Creds>`, and a validation throw renders `errorPageHtml`.
`configured` is always true; no refresh or revoke by default. The shipped token-auth gatekeepers —
homeassistant and internal sentry/http/clickhouse — accept these POSTs without this check; the kit
closes that corpus-wide gap. **This is a parity break, not just a hardening**: a non-browser client
scripting a connect POST (no `Origin` header) works against those gatekeepers today and 403s after
the port. Each token-auth port PR restates this in its description rather than leaving it to a test
assertion.

### 5.5 `./http`

```ts
export function handleGatekeeperHttp<E extends KitEnv, Creds, Public>(req: Request, opts: {
  env: E;
  spec: GatekeeperSpec<E, Creds, any, Public>;
  accountForId(id: string): AccountStub<Creds>;
  routes?(req: Request, url: URL, relPath: string): Promise<Response | null>;
}): Promise<Response>;
```

Routing order: base-path guard (throws on a mismatched prefix, preserving current behavior at
`supabase.ts:270-273`); the initiation link `/<64-hex DO id>/<64-hex nonce>` renders the
not-configured page or calls `accountForId(doId).beginAuth(nonce)`; then `spec.auth.routes`, then the
consumer's `routes` escape hatch, then 404. The URL shape and Workshop API remain unchanged.

### 5.6 `./account` — `KitUserAccountBase<E, Creds, Public>`

An abstract `DurableObject<E>` subclass. Configuration arrives through a symbol-keyed hook —
symbols cannot be dispatched over RPC, following `mcp-shared/src/user.ts:31-38`:

```ts
export const kitAccountConfig: unique symbol;
protected abstract [kitAccountConfig](): {
  spec: GatekeeperSpec<E, Creds, any, Public>;
  mintUser(): Fetcher<GatekeeperUser>;     // e.g. this.ctx.exports.GatekeeperUserImpl({ props })
};
```

Public loopback-RPC methods and their sequencing:

- `setCallback(callback, initiationNonce, options?: GatekeeperConnectOptions)` — stores the
  callback under `"callback"`, connect options under `"connectOptions"`, `"ephemeral"` when
  `options?.scopes === "auth"`; `putInitiation`; mints and stores a fresh random
  `"attemptGeneration"`; sets a `CONNECT_TIMEOUT_MS` self-destruct alarm when no credentials
  exist.
- `prepareReconnect(nonce)` — sets `"reconnecting"`, calls `putInitiation`, and writes a fresh
  `"attemptGeneration"`.
- `beginAuth(nonce)` — `advanceToOAuth` with `{ connect }` metadata, then `strategy.begin`; after
  `begin`'s awaits, re-checks `"attemptGeneration"` and returns null on mismatch (rendered as an
  invalid link).
- `completeAuth(payload, state)` — `strategy.obtain`, then re-checks `"attemptGeneration"` and
  returns false on mismatch. This closes the revoke race: a `revoke()` that ran during the token
  exchange has already cleared the generation, so the exchange result is discarded instead of
  resurrecting credentials after
  `deleteAll()`. On success: `coordinator.connect` (which re-arms the expiry latch), clear
  `"attemptGeneration"`; then `callback.credentialsRestored()` when reconnecting, else
  `callback.complete(mintUser())` — **and the credentials stay whatever that call does**; ephemeral
  sign-in accounts arm a 2-minute self-destruct alarm, everything else `deleteAlarm()`s.

  Committing is the point of no return, deliberately against the corpus. Eleven shipped accounts
  delete their grant when `complete()` rejects (github `github.ts:1120-1127`, cloudflare
  `cloudflare.ts:309-313`, supabase `supabase.ts:447-454`, and eight more), which is exactly wrong
  under RPC response loss: the user DO keys connected accounts by the id it minted before the
  connect began (`user.ts:1142-1166`), so a lost reply means Workshop has the account and the
  gatekeeper has thrown away the grant behind it — unrecoverable without a reconnect the user is
  never prompted for. Retaining it leaves at worst a grant Workshop never adopted, which the
  connect-timeout alarm already collects. `mcp-shared` reaches the same conclusion for the same
  reason (`account.ts:633-650`). Redelivering `complete()` instead would need an outbox the kit
  does not have and could not safely enable: sign-in replay mints a second session
  (`user.ts:416-426`) and, for cloudflare login, revokes the grant it is about to keep
  (`user.ts:1567-1590`).
- `getCredentials()` — `coordinator.snapshot(strategy.refresh, { notify })` with
  `notify = () => notifyCredentialsExpiredOnce(kv, callback, spec.id)`, projected through
  `config.publicCredentials` and returned as `{ creds, identity, generation }` (the coordinator's
  current credential identity, reissued whenever credentials are written or cleared, plus its
  `connectionGeneration()` — read synchronously together, which is `snapshot`'s whole job). A
  still-current
  `CredentialsExpiredError` from refresh awaits `notify` inside the helper and rethrows — the name
  must survive the
  RPC (the transport strips the class), since the source drops its cache authority on it; verify
  preservation at the first port. Any other refresh error rethrows with credentials intact. **The
  projection is not optional — see below.**
- `reportCredentialsRejected(identity)` — delegates to
  `coordinator.adjudicateRejection(identity, { refresh, notify })` with the same `notify` and
  `refresh = strategy.heal` (§5.2), the *explicit* rejection-heal callback. Presence of
  `strategy.refresh` must not be the discriminator: it is the proactive expiry refresh, and a
  provider can define it while a 401 on a current, unexpired bearer still means grant death
  (supabase) — inferring would spend a doomed mint to answer what the grant-death path answers
  directly. A derived-bearer strategy whose heal *is* its refresh wires `heal: refresh`
  deliberately; grant-death providers leave it unset. The
  moved-past gate answers `"superseded"` without notifying (a stale reporter lost the race to a
  reconnect or a sibling's heal); a current identity heals through the fence-keyed `rotate()` or,
  on confirmed death, notifies via `notifyCredentialsExpiredOnce` with `vendorId = spec.id` and
  answers `"expired"`. The verdict adjudicates identity only:
  the latch deliberately stays unset on a failed callback so a later expiry re-notifies, and
  returning that failure would make the source resolve a dead grant as superseded — an endless
  retry the user is never told about.
- `revoke()` — clears `"attemptGeneration"`, `deleteAlarm()` and `deleteAll()` **before** the first
  await, then best-effort `strategy.revoke` on the grant it captured (failures log `error` with
  event `oauth.grant.revoke.failed`). Destroying local state after awaiting the provider would let
  a connection begun during that await be erased by the revoke that preceded it. It also owns the
  mint in flight when it runs: the base hands the coordinator `strategy.refresh` *and*
  `strategy.heal` wrapped through one tracker so the latest mint promise is observable, and after
  `deleteAll()` it awaits that promise and best-effort revokes its result too — a refresh or
  rejection heal that loses the identity fence otherwise mints rotated provider-side authority
  nobody stored and nobody would ever revoke (§4.6 obligations). Draining only the refresh would
  leave the heal's mint as exactly that leak.
- `alarm()` — `deleteAll()` when no credentials exist or the account is ephemeral.

Storage keys owned by the base: `"callback"`, `"nonce"`, `"reconnecting"`, `"expiredNotified"`,
`"expiredNotifiedArm"`, `"credentials"`, `"credentials:identity"`, `"credentials:migrated"`,
`"credentials:connection"`,
`"connectOptions"`, `"ephemeral"`, `"attemptGeneration"`. `expiredNotifiedArm` is the expiry-latch
arm; the three `credentials:` siblings are the coordinator's identity fence, migration marker, and
connection generation. The original first four match every existing OAuth gatekeeper, so live
accounts keep working across a port.

**Refresh material must not cross the account boundary.** `AuthStrategy.refresh(creds)` and
`revoke(creds)` (§5.2) take `Creds`, so for any gatekeeper with a refresh flow `Creds` *is* the
stored grant, refresh token included. `getCredentials()` is called by the User entrypoint, every
facet, and every verifier, and every operation in each of them reads it afresh —
so returning the coordinator's `Creds` unprojected would hand long-lived refresh authority to every
consumer and cache it there. That is a capability regression against the whole corpus, not a
theoretical one: across **15** OAuth gatekeepers in both trees, **none** returns refresh material
over that boundary. Each returns a narrow projection and refreshes *inside* the account DO —
supabase `{ token, expiresAt }` (`supabase.ts:80-83, 469-479`), github the access token string
(`github.ts:1141-1147`), google `{ token, expires }` (`google-api.ts:42-45`), linear and notion
access-token strings (`linear.ts:601-620`, `notion.ts:419-427`), with notion's separate
`refreshCredentials()` RPC still keeping the refresh token in the DO; gitlab, ironclad and
salesforce do the same in the internal tree.

So the config hook requires a projection, and its return type — not `Creds` — is what the consumer
side is generic over:

```ts
protected abstract [kitAccountConfig](): {
  spec: GatekeeperSpec<E, Creds, any, Public>;
  mintUser(): Fetcher<GatekeeperUser>;
  /** What a facet/verifier may hold. Omit everything sensitive: this crosses the RPC boundary. */
  publicCredentials(creds: Creds): Public;
};
```

Layer 1 already permits this and needs no change: `CredentialCoordinator<Creds>`,
`AccountCredentialStub<Creds>`, and `CredentialSource<Creds>` are three *independent* type
parameters that merely share a letter, so `CredentialCoordinator<Grant>` in the DO alongside
`CredentialSource<AccessToken>` in the facet already type-checks today. The leak would be introduced
here, by wiring the two to one type — which is precisely why this is written down before §5.6 is
built. `KitUserAccountBase<E, Creds, Public>` gains the third parameter; where a gatekeeper has no
refresh flow (github), `Public = Creds` is a legitimate instantiation, not a default to fall into.

**Landed 2026-09-03, superseded 2026-09-04**: this block shipped the force-refresh channel as
`CredentialSourceOptions.refreshCredentials`, a consumer-side option triggered by
`run(operation, { replayable: true })`. The 2026-09-04 inversion (§4.13) collapsed that channel
into the verdict protocol — the option and `ExpiryVerdict` no longer exist; the mint is the
`refresh` callback of `coordinator.adjudicateRejection`, and `reportCredentialsRejected` answers
`"expired" | "superseded" | "unavailable"`. The block is kept for the design-note resolutions
that still stand (the presence-check argument now applies to the account-side callback; the
staleness contract moved to `adjudicateRejection`'s doc):

The composition the original deferral assumed —
`run(creds => withAuthRetry(...))` — routed the refresh around the reporter, so a rotating grant's
expiry was unreportable (§4.13). The kernels of its design notes that survive the collapse, in
the protocol's current vocabulary:

- **Presence over required surface.** An optional method on an RPC stub cannot be
  presence-checked (stubs are proxies that answer every property), and a required one is dead
  surface for the five grant-death providers — which is why the heal is a local callback on
  `adjudicateRejection`, never a stub method. The old safety throw (`replayable` without a wired
  channel) is gone with the channel: an unwired heal now answers a current-identity rejection
  `"expired"` honestly, so a grant-death port passing `replayable` is harmless (§4.13).
- **The port's mint logic stays the port's.** Redundant-mint skipping (`google.ts:556`) and the
  expiry gate (`google.ts:555`) live inside the port's `refresh` callback; the identity the old
  channel had to be handed is the report's own argument, adjudicated account-side.
- **Interaction with the fencing row (§4.8).** Closed as an opt-in leaf contract:
  `BoundActionSet.submit` stores an opaque `ActionFence`, and apply compares the current generation
  before dispatch. The source still refuses a retry whose refetch crossed a connection generation
  and rethrows as `CredentialsChangedError`, so neither retry nor approved-action apply silently
  crosses a connection when the port wires the fence.

### 5.7 `./vendor` — `KitVendorBase<E>`

Abstract `WorkerEntrypoint<E>` with hook `[kitVendorConfig](): { spec; accounts():
DurableObjectNamespace<…> }`. Implements `describe()` (returns `spec.vendor` as-is),
`connectAccount(callback, options?)` (`newUniqueId`, `generateNonce`, `setCallback`, returns
`{ url: `${getBaseUrl(env, spec.id)}/${id}/${nonce}` }`), `getSupportedResources()`
(`spec.resources.map(r => r.supported)`), and `getTypeScriptTypes()` (`spec.types`).

### 5.8 `./user` — `KitUserBase<E, Creds, X>`

Abstract `WorkerEntrypoint<E, KitAccountProps>` with hook `[kitUserConfig](): { spec; exports():
X; account(): AccountStub<Creds> }`. The typed `exports()`
closure is what lets the default resolver call `def.facet(exports(), props)` without a cast.
The consumer side carries no mint wiring *(2026-09-04: the `refreshCredentials` option this hook
previously threaded through is gone — the derived-bearer mint lives account-side behind
`coordinator.adjudicateRejection` (§4.13), inside the same stub the source already holds)*.
Implements:

- `describe` / `getAuthenticatedEmail` via `spec.account.*` with a lazily built `AccountHandle`
  (a `CredentialSource` over `account()`).
- `getSupportedResources`.
- Default `getGatekeeperClassFor(url)`: the first resource whose `resolve(new URL(url))` returns
  non-null wins, yielding `{ class: def.facet(exports(), { ...props, userObjectId }), resource:
  def.supported }`; no match throws `Unsupported ${spec.vendor.displayName} URL: ${url}`. The
  authenticated identity always wins because `props` are parsed from a caller-supplied URL.
  Gatekeepers with irregular URL grammars (github's repo-with-refinements, email's mailbox
  claiming) override the method; it is a normal public method on the subclass.
- `startResourceConfigurator(pattern)`: matches `def.supported.urlPattern` exactly and returns
  `def.configurator(handle)`; unknown patterns throw, as today.
- `revoke` / `reconnect` via the account stub; `reconnect` returns a fresh initiation URL.
- `ensureResources` returns `{}` (override for scope-expanding vendors).
- **Abstract `getVerifier()`** — every consumer implements it (with `@skipRpcValidation()`, since
  Fetcher returns cannot be validated), because the verifier class and its props are
  vendor-specific.

### 5.9 `./facet` — `KitGatekeeperBase<E, Props extends KitAccountProps, Session>`

Abstract `DurableObject<E, Props>` with hook `[kitFacetConfig](): { spec; resource:
ResourceDef<…>; observers: ObserverStrategy; actions?: BoundActionSet<any> }`, invoked per call so
the hook can branch on `this.ctx.props` (supabase: project bindings return the project def and
`aclObservers`, organization bindings the organization def and `trackedSetObservers`). Implements
`getTypeScriptTypes` (`resource.types ?? spec.types`), `getAutoApprovableActions`
(`actions?.autoApprovableKinds() ?? []`), `applyAction`/`rejectAction` (dispatch to
`actions`, which already serializes both on the queue it owns — §4.8 — and throwing when no actions
are configured; `applyAction` passes `{ gitCache: cache, generation }` from
`(await creds.read()).generation`, since a fenced record refuses to apply without one and only the
facet holds the credential source), `addObserver`/`removeObserver` (delegating to the strategy), a protected
`observationGate(queue)` helper that `.dup()`s the queue and binds the strategy — the session's
**only** dup: action submission borrows the same stub through `gate.actions` (§4.7), matching the
corpus's one-stub-per-session shape (`supabase.ts:814-819`) — and a protected
`resourceDescription(dynamic: { url: string; title: string; snippet: string; hasSlashCommands?:
boolean }): ResourceDescription` helper that merges the def's static `tsType`/`hookTsType`/
`suggestedBindingName` with the live fields. `describe()` and `startSession(queue)` stay
abstract — resource metadata lookups and the session API are the gatekeeper — but a typical
`describe()` is now one fetch plus `return this.resourceDescription({...})`.

**The hook returns activation-scoped values; it must not construct them.** `actions` and
`observers` both carry in-memory state that is the whole point of them: `BoundActionSet` owns the
`SerialTaskQueue` every resolution is ordered on plus the `claimedHere` set, and
`ObserverTracker` owns the admission/removal fence. A hook calling `defineActions(...).bind(...)` or
`trackedSetObservers(...)` inline — the shape a per-call hook invites — would hand every call a
fresh queue and empty sets, silently voiding both guarantees. `bind` blunts its likeliest form by
being idempotent per journal: rebinding a module-scoped set to a facet-held journal returns the
first bound set, so even the per-call shape shares one queue. Nothing equivalent covers
`trackedSetObservers`, and a hook that rebuilds the set or the journal per call stays uncatchable
— so the hook resolves these from instance fields, built once per activation and memoized per
`ctx.props` when a facet serves more than one resource kind; the base's own doc comment says so,
and the fixture asserts two concurrent `applyAction` calls share one queue.

**The revert seam.** Revert behavior is not declarative (see §4.8's doctrine): the base implements
`revertAction(id)` as `actions.runExclusive(...)` — exclusive with `apply`/`reject` (§4.8) —
dispatching to a `protected revert?(id: number): Promise<void | { message?: string; canRetry?:
boolean }>` hook → throw not-implemented when the hook is absent. The consumer's
hook is ordinary TypeScript reading the journal directly (`journal.get(id)`, switch on kind —
github's and linear's existing `revertAction` bodies port nearly verbatim), but the *seam* stays
kit-owned: revert-vs-apply is the most race-sensitive pair in the corpus (notion's
`laterConflictingApplied` ordering check assumes non-interleaving), so a hand-written public
method skipping the queue would be a concurrency regression. Retention consistency is enforced
by an **assert, not derivation** — the consumer calls `bind(journal, host)`, which has no channel
for the facet's hook, and behavior must live on a named surface: at hook-return the base throws
a named config error when a revert hook is present, actions are configured, and
`actions.retainsApplied` is false. Same guarantee (you cannot ship revert without retention) and
it fails on the first facet call, i.e. in every test; `retainApplied: true` without a hook stays
legal (notion-style overlay/history retention). After the hook completes, the base fires
`afterResolve(host, "reverted")`, so the invalidation hook covers all resolution sites.
Overriding the public `revertAction` itself bypasses both the queue and the assert — that is the
"you own everything" tier, not the intended hatch.

### 5.10 The agent type contract

`types.d.ts` remains the hand-authored source of truth, unchanged by the kit. Its JSDoc is the
agent's entire documentation for the session API, and it is the artifact reviewed at the
`write-gatekeeper` skill's Phase-1 STOP gate before any implementation exists, so the kit never
generates it — not from session implementations, and not from the spec. The `types.txt →
types.d.ts` symlink also stays: the worker imports the symlink as a Text module and hands it to
`spec.types`, which makes the runtime text and the compile-time declarations identical by
construction.

What the kit adds is enforcement of the seams that are stringly today:

- **Name integrity.** `ResourceDescription.tsType` must name an export of the returned types text
  (`workshop-shared/gatekeeper.ts` requires this; nothing checks it today, and a drifted name
  breaks the agent's type database at runtime). Under the kit the names live in the resource def
  next to the slice they must exist in, and `define()` throws at module init when
  `tsType`/`hookTsType` does not match an `export interface|type|class` declaration in
  `resource.types ?? spec.types`. A regex-level check, deliberately: it catches renames and
  typos, and a full TS parse would buy little because shape agreement is enforced elsewhere.
- **Shape integrity.** Session implementations declare `implements` against the interfaces in
  `types.d.ts` and carry `@validateRpc()`, so `capnweb-validate` validates every RPC call against
  the same declarations the agent reads. The kit does not add machinery here; it inherits it.
- **The residual gap, stated honestly:** TypeScript cannot verify that the exported *name* inside
  a serialized text blob denotes the type of a given session object. The single-file symlink case
  closes it by construction (same declarations); multi-file vendors keep the parity-test pattern
  (`gatekeeper-google/__tests__/types-parity.test.ts`); the `define()` check covers name drift in
  between. This gap exists today too — the kit narrows it and documents it.

Vendor-level `getTypeScriptTypes()` returns `spec.types` (for a multi-service vendor, the
concatenation of its per-service files); each facet returns only its slice via `resource.types`,
the google pattern. Gatekeepers whose types are runtime data (the MCP connectors generate
declarations from live tool schemas) override `getTypeScriptTypes()` on their facet and skip the
static path; the `define()` name check applies only to static defs, so a def may omit
`resolve`/`facet` and carry a placeholder text without fighting the validator.

## 6. Build & validation constraints

These are load-bearing; the fixture suite (§7 step 11) exists to prove each one.

- **Named exports and migrations.** `ctx.exports.X` and `wrangler.jsonc` migrations resolve by
  export name, so consumers subclass the bases under their own names (`export class UserAccount
  extends KitUserAccountBase<Env, SupabaseCredentials, SupabasePublicCredentials> { … }`). The kit
  never dictates names.
- **`@validateRpc()` stays in the consumer.** `capnweb-validate build` transforms only the
  consuming package's source tree, so kit bases are undecorated and every consumer decorates its
  subclasses. `gatekeeper-mcp` proves decorated subclasses of imported generic bases transform
  correctly (`mcp.ts:242`, `:487-488`). If the transform rejects a facet subclass over the
  generic `Gatekeeper<Session>` surface, the documented explicit form
  `@validateRpc<Gatekeeper<SupabaseProject | SupabaseOrganization>>()` is the fallback.
- **workerd for nonce tests.** `crypto.subtle.timingSafeEqual` does not exist in Node, so the
  kit runs two vitest projects: `vitest.config.ts` (Node, pure modules: actions, observers,
  credentials, auth-retry, simulation, cache, connect-pages, endpoint, http-errors,
  response-body, spec, http routing) and
  `vitest.worker.config.ts` (workerd: connect-nonce, connect-handshake, credential-expiry,
  cursors, the action queue, and the fixture). The workerd project loads
  `scripts/assert-workerd.ts` so a broken pool fails loudly. `connect-pages` and `endpoint` are
  Node suites because they assert only `Response` headers, escaped HTML, and `URL` parsing —
  `Request` and `URL` behave identically under both. `credential-expiry` and the
  `SerialTaskQueue` suite stay in workerd even though their APIs exist in Node: their subject is
  in-flight promise dedup with throwing callbacks, and workerd's eager unhandled-rejection
  reporting is a load-bearing part of what they defend (§4.8).
- **One shared KV fake, because a `Map` is not one.** Every suite takes its KV from
  `__tests__/fake-kv.ts` rather than hand-rolling a `Map`, since real `ctx.storage.kv` differs from a
  `Map` in two ways that each hide a class of bug — both established by probing workerd, not
  reasoned about. It **structured-clones on write and on read**: mutating what you passed to `put`
  does not change what is stored, `get` never returns the object written, and two `get`s of one key
  return different objects — so a reference-returning fake lets a module mutate stored state in
  place while a test still reports "one write", and would let a regression from opaque-identity
  comparison to reference equality pass. And its **`list` is lexicographic, not insertion-ordered**:
  real scans yield `…:10` before `…:2`, so an insertion-ordered fake silently satisfies any test
  that should have caught a missing numeric sort — `listPending`'s was exactly that test, and now
  fails without the sort. The fake is deliberately clone-faithful and calls `structuredClone` for
  every put and get; it does **not** model platform RPC-stub storage, so that behavior
  needs a workerd test.
- **A test that cannot fail is a finding.** Three of these were fixed rather than left: the
  `listPending` order above; the `ObservationGate` ordering test, whose `prepare` resolved
  synchronously and so could not distinguish "authorize after prepare" from "authorize before it"
  (it now parks on a resolver the test controls, and asserts the queue is untouched while it does);
  and the OAuth-claim rejections, every one of which an implementation deleting the record *before*
  validating would also satisfy, so a separate test now proves a wrong claim leaves the attempt
  claimable and a right one consumes it exactly once. The wire-visible constants
  (`NONCE_KEY`, `NONCE_BYTES`, and the four durations) are pinned as literals for the same reason:
  each is observable outside the kit, and turning ten minutes into a day is a security decision, not
  a tuning one.
- **Facets are reachable only via `ctx.facets`.** Tests drive the fixture facet through a
  `TestHooks` DO, exactly as `gatekeeper-cloudflare/__tests__` does.
- **`ctx.exports` typing** comes from each consumer's generated `Cloudflare.GlobalProps`; the
  fixture declares its own in `__tests__/fixture/env.d.ts` (the `gatekeeper-mcp/src/env.d.ts`
  pattern).

## 7. Work breakdown

Each step leaves the tree building; tests land with the module they cover. Nothing outside
`packages/gatekeeper-kit` changes before step 12.

1. **Scaffold the package.** `package.json` (name `@gadgets/gatekeeper-kit`, private, `type:
   module`, per-file `exports` map for every module in §4/§5; scripts
   `test:run: "vitest run && vitest run -c vitest.worker.config.ts"`,
   `test:watch:node: "vitest"`, and
   `test:watch:workerd: "vitest -c vitest.worker.config.ts"`; dependencies
   `@gadgets/workshop-shared` and `@gadgets/backend-utils` (`workspace:*`) plus `jose`; devDependencies
   `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types`, `typescript`, and `vitest`
   (`catalog:`) plus `@gadgets/scripts` (`workspace:*`)). `build` (`tsc`) and `clean`
   (`rm -rf dist`, uncached) are Vite+ tasks, not package scripts. As landed the
   scaffold is deliberately leaner than first sketched: **one** `tsconfig.json` covering `src`
   and `__tests__` on `@cloudflare/workers-types/experimental` — no `tsconfig.test.json` and no
   checked-in `worker-configuration.d.ts` to drift — and no `capnweb`, `capnweb-validate`, or
   `@types/node`, since Layer 1 has no capnweb runtime path; those arrive when the Layer-2
   fixture needs them. `vite.config.ts` uses `withVitestTask` for the two Vitest commands and adds
   the Vite+ `build`/`clean` tasks above. Run `pnpm install`.
2. **`connect-nonce`, `connect-handshake`, `connect-pages`, `endpoint` (§4.1–4.3, §4.14).** workerd
   tests: nonce round-trip and TTL expiry; stage transitions; exactly one concurrent
   `advanceToOAuth` succeeds per attempt; a wrong initiation nonce does not consume the attempt;
   `claimOAuth` is one-shot and returns `Extra`; legacy records without metadata are accepted; a
   wrong OAuth claim leaves the attempt claimable and the right claim consumes it. Node tests:
   `escapeHtml` and `errorPageHtml` escaping; `htmlResponse` carrying all shipped security headers;
   `connectMutationError` refusing an absent or foreign `Origin` and an absent or wrong content
   type, and matching a content type case-insensitively and past its parameters;
   `normalizeVendorEndpoint` returning origin plus normalized path for a URL carrying a query and
   fragment, refusing userinfo, refusing `http:` by default and accepting it under
   `requireHttps: false`, refusing a non-HTTP scheme either way, anchoring an unanchored pattern and
   an alternation, preserving an explicit port, refusing a suffix host, and
   never echoing the input in any thrown message.
3. **`credential-expiry` (§4.4).** workerd tests: notifies once; a failed callback leaves the
   latch unset and a later call notifies again; concurrent callers share one in-flight
   notification; the latch write happens only after the callback resolves (assert with a
   late-resolving callback); `clearCredentialExpiryLatch` re-arms.
4. **`http-errors` + `observers` (§4.5, §4.7).** Node tests with a Map-backed KV stub and fake
   verifiers: 401/403/404 classify as no-access and 5xx rethrows; a throwing `verifyBaseline`
   propagates before any `hasSetAccess` call;
   re-read-until-stable admission (a set appearing mid-check is verified before the verifier
   persists); batched oracle called once per admission round; a legacy stored `true` reads as
   observed and re-reading it is not a fresh reveal; an overlapping `setPrefix` is refused in
   either direction; per-set deny messages; pending-before-await then commit promotion; forward exclusion lists
   exactly the observers lacking access, and excludes one whose verifier throws rather than failing
   the read; `removeObserver` idempotence, and a removal mid-admission refusing the admission;
   `ObservationGate` ordering
   (`prepare` → `authorizeObservation` with `excludeObservers` → `commit`; marked refusal →
   `discard`, unmarked failure → `abandon` with durable fences retained);
   `escapeObservationValue` flattening each newline run to one space and escaping every control
   character while leaving prose and the empty string alone; each scope arm's exclusions, an empty
   `sets` scope being refused, and a `baseline` read delivering the caller's
   own object with the oracle never consulted.
5. **`credentials` (§4.6).** Node tests: skew-aware reuse; two concurrent `fresh` calls share one
   refresh; a `connect` (reconnect) during an in-flight refresh wins and `fresh` returns the newer
   credentials; a `clear` during an in-flight refresh yields `CredentialsExpiredError`; a refresh
   throwing `CredentialsExpiredError` propagates only when its snapshot is still current — after
   a concurrent `connect` it is fenced and `fresh` returns the newer credentials with no expiry
   signal; a `refreshSkewMs` override refreshes a token the default window would leave alone;
   `identity()` is reissued on every credential write and `clear`, and never repeats a wiped value — fenced
   against a **raw** wipe of both keys (what `deleteAll()` leaves), the only form that proves
   `stored()` lazily mints one for a pre-kit record; the migration is retired by `clear()` both
   before the first read and after an upgrade already adopted the grant; any other refresh error
   leaves `stored()` unchanged and rethrows; `upgrade` runs once and persists. For
   `CredentialSource`: two concurrent `get`s make one account round trip and the next sequential one
   re-reads, and an auth failure drops the in-flight fetch so the next caller does not receive
   credentials already reported expired. For
   `withAuthRetry` (§4.13): the required `replayable: true` acknowledges the operation may run
   twice; the success path asks for a token once with `forceRefresh: false`; a non-auth error at
   either attempt propagates with no refresh and no report; an auth error refreshes with
   `{ forceRefresh: true, staleToken }` and returns the replay's result; and two auth errors surface
   the second one. For the verdict protocol (§4.13), a rejection is reported against the identity
   the failed attempt used, and the verdict decides — `"expired"` throws
   `CredentialsExpiredError(expiredMessage)` with the identity marked dead, `"superseded"` throws
   `CredentialsChangedError` or, under `replayable`, refetches and retries once; `"unavailable"` or
   an internal `"unadjudicated"` result from a malformed or lost answer rethrows the caller's
   original provider error without dead-marking the identity;
   the retry is refused as "changed" when its refetch crosses a generation, re-serves the
   rejected identity, or was not itself adopted (a fenced-out refetch triggers neither the
   re-serve's authority drop nor the dead successor's expiry — both act only on the read the
   source last stood behind), resolved as expiry without a provider call when the successor the
   source stands behind is already dead, and its own rejection is adjudicated but never retried
   (at most two executions); a live
   successor adopted mid-operation resolves the failure as "changed" with no ask spent and the
   live authority kept — before the first ask and at the retry's rejection alike; the rejected
   authority drops at the ask (cache-first readers bypass during the round trip instead of
   serving the rejected partition) and a read landing mid-ask is served but never adopted —
   the pending ask blocks re-adopting the identity whose verdict is out — then drops again at
   the verdict, with the death mark waiting for an `"expired"` answer; asks coalesce per identity, so a burst of rejections of one grant spends one report
   and one refetch; and the coordinator halves hold their own contracts — `snapshot`'s triple is
   atomic against a connect landing at the await boundary and notifies only a still-stored
   grant's confirmed death, `adjudicateRejection` gates moved-past identities ("" never matches)
   before healing through the fence-keyed rotate (concurrent heals share one mint), answers
   `"superseded"` when a reconnect overtakes the mint, notifies before `"expired"`, and answers
   `"unavailable"` with credentials intact when the mint fails for non-credential reasons —
   proven composed by an integration suite (real coordinator over `fakeKv` behind a real source):
   an invisible heal spending one mint and no notification, a dead grant under concurrent runs
   spending one mint and one notification, a non-replayable stale bearer re-entering with no
   second mint, a mid-operation reconnect resolving as "changed" with no mint, and one mint
   however many facets report their stale bearers.
6. **`actions` (§4.8).** Node tests: sequential IDs; staged→pending transitions; the default
   keys landing records at `pending:action:<id>` with counter `pending:nextActionId` (a
   live-storage contract for the supabase/google-family ports, so those literals are
   load-bearing); `stageAction`
   rolls back when `submitAction` throws (fake queue); `apply` resolves a still-`staged` record
   (the output-gate/crash window); `listPending` ordering, and its scan staying confined to the
   pending prefix (a retained record moves tiers and `get`
   still finds it); `upgradeRecord` wraps kindless legacy records; dispatch including the
   unknown-id throw; apply-throw retains the record and fires `afterResolve("failed")`; the
   retained record carries the artifacts the handler returned;
   `retainApplied: true` marks-and-moves where the default removes; a replayed `apply` of a
   retained record resolves void without re-running the handler or firing `afterResolve` while
   `reject` on it still throws "no longer pending"; `afterResolve` fires with the
   right outcome, and a throwing hook is logged but never masks the apply error nor fails a
   successful resolution; `reject` removes and no-ops on an unknown id, but refuses one racing an
   apply that already ran; an interrupted `retain` keeps the applied record, while a `retain` of a
   `failed` one is refused and `markFailed` bounds the reason it stores. For the claim
   lifecycle (§4.8): `listPending` projects a `claimed` record and not a `failed` one; no
   transition moves a settled record and the first stored failure message wins; a stored `failed`
   record that lost its reason still reads with one; `maxPending`
   refuses `allocate` and `submit` at the cap while writing nothing, and a `failed` record neither
   counts against it nor ever blocks a new action — while the prunable tier is bounded at twice the
   cap, drops nothing under it, and takes a stranded `staged` record before an explained failure;
   a prototype-inherited kind (`constructor`, `toString`, `valueOf`, `hasOwnProperty`) takes the
   dropped-kind path instead of resolving to an inherited handler; a bare reference string is
   refused at the type level; `claimBeforeApply` plus a plain throw restores `pending` and a second apply
   reaches the provider; an `ActionApplyError` records the failure, answers every replay from the
   record with no provider call, and is cleared only by `reject`; a claim a second bind finds
   over the same journal is converted to `APPLY_OUTCOME_UNKNOWN_MESSAGE` by both verbs without
   running a handler; and a journal write that fails *after* the handler succeeded leaves the
   record `claimed`, fires no hook, and is reported unknown on the next attempt rather than being
   rolled back to `pending`. `SerialTaskQueue`
   ordering and rejection isolation live in the **workerd** project
   (`__tests__/workerd/serial-queue.test.ts`), since rejection reporting is the subject.
7. **`simulation` + `cache` + `cursors` (§4.9–§4.11).** Node tests: view sorts once and indexes
   multi-target
   actions; replay applies in order, skips `known-no-effect`, stops at the first `unsupported`
   with the record and reason; `ProvisionalIds` allocate/bind/resolve with plain and prefixed
   formatters; a `kind` recorded by `allocate` surviving a new instance, `requireResolved`
   refusing a mismatched `expectedKind` with the exact message even while unbound, and an
   untagged or real id passing through; a bare target refused at the type level; cache TTL and
   generation bump, plus a reconnect under one *live* instance in both directions, a value whose
   authority moved mid-load stored under neither, and an in-flight load never shared across the
   change. Cursors get their **own**
   workerd suite
   (`__tests__/workerd/cursors.test.ts`) rather than waiting on step 11's fixture, since they
   extend `RpcTarget`: empty-page exhaustion versus a
   short page, serialized `next()`, and a provider rejection that moved no paging state being
   resumable. `TokenCursor` adds: a walk mixing an
   empty-page-with-token and a `""` token yielding every item then `null` (the marketo shape); 12
   token-bearing empty windows making 10 provider calls and returning `[]` at the shared cap, then
   resuming afterwards; and an echoed token being refused repeatedly rather than latching the
   cursor. The fixture still exercises them, but for assembly behavior rather than first coverage.
8. **Assembly: `spec`, `auth`, `auth-oauth2`, `auth-token`, `http` (§5.1–5.5).** Node tests for
   the pure parts: `define` rejects duplicate `urlPattern`s and rejects a `tsType`/`hookTsType`
   that is not exported from the effective types text (§5.10); default resolver precedence;
   `getBaseUrl` defaulting; authorize-URL construction (state format, scope join, PKCE challenge,
   extra params); handler routing against `Request` objects and a stubbed `accountForId`
   (initiation-link shape, not-configured page, `/oauth` error/missing-parameter branches,
   fall-through to consumer routes, 404).
9. **Assembly bases: `account`, `vendor`, `user`, `facet` (§5.6–5.9).** Exercised end to end in
   step 11.
10. **Kit `README.md`.** Architecture and the à-la-carte doctrine; per-module docs; consumer
    obligations (named exports, migrations, decorated subclasses, `@skipRpcValidation()` on
    `getVerifier`, `env.d.ts`, `types.txt` symlink); the `AuthStrategy` contract with the
    Cloudflare Access CLI mapping sketched (redirect plus `waitUntil(poll → deliver)` plus a
    transfer-proxy route); storage-compat options for ports; the grant-death doctrine and the
    explicit warnings that credential rotation is not transactional, that action apply is
    at-least-once unless the definition sets `claimBeforeApply`, and that a retaining gatekeeper
    owns GC of its retained journal tier.
11. **Fixture gatekeeper + workerd suite.** `__tests__/fixture/worker.ts` builds a complete
    "Acme" gatekeeper the intended consumer way: `gatekeeperKit<FixtureEnv, AcmeCreds,
    FixtureExports, AcmePublicCreds>()`, `oauth2` against `https://acme.test` endpoints mocked with
    `fetchMock` from `cloudflare:test`, one `https://acme.test/w/:id` resource with a configurator,
    decorated `GatekeeperVendor`/`GatekeeperUserImpl`/`AcmeGatekeeperImpl` subclasses plus an
    decorated `UserAccount`, a one-method verifier, `defineActions` with one kind, `aclObservers`,
    and a session that authorizes reads through `ObservationGate` and returns a `PageNumberCursor`.
    Alongside it: a `TestHooks` DO for facet access, a `GatekeeperConnectCallback` entrypoint
    capturing `complete`/`credentialsExpired`/`credentialsRestored`, and a fake `ApprovalQueue`
    recording calls. `vitest.worker.config.ts` runs `capnwebValidate()` plus `cloudflareTest`
    (compatibility date `2026-02-02`, flags `allow_irrevocable_stub_storage` + `nodejs_als`, the
    three DOs). Tests: the full connect round trip (connectAccount URL → initiation fetch → 302 with
    state → `/oauth` callback → mocked token exchange → `complete()` delivering a working user stub);
    concurrent `beginAuth` advancing exactly once; the revoke-during-obtain race
    (`beginAuth` → `revoke()` → `/oauth` callback: `completeAuth` returns false and storage stays
    empty); ephemeral sign-in self-destruct via `runDurableObjectAlarm`; reconnect →
    `credentialsRestored`; a mocked 400 `invalid_grant` refresh notifying `credentialsExpired`
    exactly once and re-notifying after a failed callback; a mocked 500 refresh propagating with
    stored credentials intact and the next `getCredentials` retrying; revoke; `getGatekeeperClassFor`
    through facet `describe`/`startSession`; observation data withheld until `authorizeObservation`
    resolves (assert ordering) with each cursor page authorized; action submit → pending →
    apply/reject including submit-failure rollback; a hand-written `protected revert(id)` hook —
    the fixture implements one reading the journal, proving the escape hatch is load-bearing —
    dispatched through the queue (interleaving asserted against a concurrent apply), bound with
    `retainApplied: true` so its record survives apply, and firing `afterResolve("reverted")`;
    the facet-base assert rejects (named config error) a revert hook whose actions don't retain;
    a stale-identity `reportCredentialsRejected` after a reconnect answers `"superseded"` without
    notifying, and a current-identity one answers `"expired"` even when the Workshop callback
    fails (the latch stays unset for a later re-notify; the verdict adjudicates identity only) —
    both through the real account RPC; with the
    hook absent, `revertAction` throws not-implemented; strategy-B observer denial. This suite is
    also the proof that decorated subclasses of the kit's generic bases survive the
    `capnweb-validate` transform.
12. **`mcp-shared` cutover.** Delete `packages/mcp-shared/src/connect-nonce.ts` and `src/html.ts`;
    re-point every import of them — `mcp-shared/src/{account,http,tools,user,util}.ts`,
    `gatekeeper-mcp/src/{mcp,connect-form}.ts`, `gatekeeper-mcp-portal/src/portal.ts` (verify the
    list with `grep -rn 'connect-nonce\|\./html' packages/mcp-shared packages/gatekeeper-mcp
    packages/gatekeeper-mcp-portal`) — at `@gadgets/gatekeeper-kit/connect-nonce`,
    `/connect-pages`, and `/credential-expiry`. Move `DEFAULT_TOKEN_LIFETIME_S = 60 * 60` local to
    `account.ts`. Replace `McpAccountBase`'s hand-rolled expiry latch with
    `notifyCredentialsExpiredOnce`/`clearCredentialExpiryLatch`, adding `protected abstract
    vendorId(): string` implemented by both connectors (`"mcp"`, `"mcp-portal"`). Keep a
    file-local pure-JS `constantTimeEqual` in `account.ts` with a comment naming the reason (its
    account tests run in Node, where `crypto.subtle.timingSafeEqual` is unavailable; every Worker
    runtime path uses the kit comparator). Drop `escapeHtml` from `util.ts` in favor of
    `connect-pages`, `hexEncode` from `util.ts` in favor of `/connect-nonce`, and
    `readTextCapped`/`MAX_RESPONSE_BYTES` from `fetch.ts` in favor of
    `/response-body` — catching `ResponseTooLargeError` where `fetch.ts` threw its own. Add
    `@gadgets/gatekeeper-kit` to the three `package.json`s; update `mcp-shared/README.md` and
    `__tests__/account-endpoint.test.ts` imports. In the same step, collapse
    `gatekeeper-cloudflare`'s `readJson` (`observability-api.ts:219-253`) onto the same leaf,
    re-wrapping the refusal as `CloudflareObservabilityApiError`: it is the second consumer, and
    leaving it behind keeps the divergence the leaf exists to end.
13. **Port `gatekeeper-supabase`.** In `supabase.ts`, delete the plumbing: nonce/TTL constants
    (:65-70), `StoredNonce`/`StoredToken` (:74-83), HTML constants and nonce/base-url helpers
    (:138-191), the fetch handler (:267-334), the `GatekeeperVendor` body (:339-368), the
    `UserAccount` body (:373-544), the `GatekeeperUserImpl` body except `getVerifier` (:549-672),
    `PendingActionStore` and `SupabaseCache` (:745-806), the facet's token cache and observer
    internals (:925-1018, :1146-1187), and the action methods (:1090-1126). Replace with:
    - `type SupabaseCredentials = { accessToken: string; refreshToken: string; expiresAt: number }`.
    - A `gatekeeperKit<Env, SupabaseCredentials, Cloudflare.Exports, SupabasePublicCredentials>()`
      spec, where `SupabasePublicCredentials = { token: string; expiresAt: number }` and
      `publicCredentials` maps `accessToken` onto `token`, so no refresh material crosses to a
      facet. The `oauth2` config wraps the untouched `supabase-api.ts` helpers (`exchangeAuthCode`,
      `refreshAccessToken`, `revokeRefreshToken`); its `refresh` maps `SupabaseApiError.isAuthError`
      (the client derives it from 401, or an exact 400 `invalid_grant` — never 403) to
      `CredentialsExpiredError` and rethrows everything else untouched, so infrastructure failures
      stop destroying sessions; `extraAuthorizeParams:
      { response_type: "code" }`; `expiredMessage` and the not-configured wording preserved
      verbatim; `legacyKeys` declares
      `accessToken`/`refreshToken`/`accessTokenExpiresAt` and `upgradeStoredCredentials` reassembles
      the grant from them, leaving the reap to the coordinator.
    - Resource defs gain the static contract fields: the project def `tsType: "SupabaseProject"`,
      `suggestedBindingName: "SUPABASE_PROJECT"`; the organization def `tsType:
      "SupabaseOrganization"`, `suggestedBindingName: "SUPABASE_ORGANIZATION"` — moved out of the
      facet's `describe()` (:1049-1067), which shrinks to metadata fetches plus
      `this.resourceDescription({...})`.
    - Thin subclasses with unchanged export names (`GatekeeperVendor`, `UserAccount`,
      `GatekeeperUserImpl`, `SupabaseGatekeeperImpl`; `SupabaseVerifier` untouched), and a
      default export wiring `handleGatekeeperHttp`.
    - `SupabaseSessionContext` (:814-913) survives, rebuilt on kit pieces: `ObservationGate`
      (project bindings `aclObservers`, organization bindings `trackedSetObservers` with
      `setPrefix: "observedProject:"` and `verifyBaseline` throwing the existing org-membership
      denial — the legacy stored `true` needs no flag — denial messages preserved verbatim from
      :1152-1179), `BoundActionSet.submit`
      (the SQL `ActionDescription` text preserved verbatim from :896-907), `KvTtlCache`, and
      `CredentialSource`.
    - Every action handler resolves each outbound provider reference through
      `ProvisionalIds.requireResolved` before the provider call, never `resolve()`. The dependency
      cascade (§4.8) is advisory and best-effort: it runs after the parent's decision is durable, so
      a failure there is logged and cannot be retried, and this guard is what bounds that into a
      clear local failure instead of a call carrying a provisional id. Confluence is the corpus
      precedent for doing both (`confluence-actions.ts:438-443`, `:571-600`).
    - The facet keeps `describe()` per resource kind (:1045-1068) and `startSession` (:1078-1084).
      Actions: `defineActions<SupabaseActionHost, { execute: StoredExecuteAction }>` whose
      `apply` preserves :1096-1108 (auth failure notes expiry and throws the "reconnect, then
      retry" message without removing the record), with `afterResolve` bumping the cache
      generation on `"applied"`. No `revert` hook and `retainApplied` unset, so records are
      removed on apply (the facet-base assert is trivially satisfied) — storage byte-identical
      to today. The dead-code
      compensating-statement message (:1120-1126) is intentionally dropped: the path is
      caller-less (`submitAction` sets `implementsRevert: false`, nothing in the repo calls
      `Gatekeeper.revertAction`), and the manual-revert path already shows the SQL via the action
      description. Journal options: `{ upgradeRecord: wrap kindless legacy records as execute }`
      only — supabase's live keys `pending:nextActionId` and `pending:action:` are the kit
      defaults (§4.8), so restating them would be noise.
    - Session implementations (:1208-1444), configurators, `types.d.ts`, and `supabase-api.ts`
      stay as they are apart from context-method renames.
14. **Port safety net.** `packages/gatekeeper-supabase/__tests__/`: Node tests for
    `upgradeStoredCredentials` (legacy keys convert and are deleted) and the journal's
    legacy-record upgrade; a workerd `connect-flow.test.ts` against the real `UserAccount`
    subclass (single-use initiation advance under concurrency, wrong-nonce rejection without
    consuming the attempt, wrong-state `completeAuth` rejection), with its own
    `vitest.worker.config.ts` (`capnwebValidate` + `cloudflareTest` with the `UserAccount` DO +
    `assert-workerd`) and `__tests__/env.d.ts`. Switch `vite.config.ts` to the `withTests`
    re-export from `scripts/gatekeeper-configurator-vite-config.js` and add `test:run` plus the
    vitest devDependencies. `wrangler.jsonc` must show a zero diff.
15. **Repo docs.** Add the `packages/gatekeeper-kit` bullet to the root `AGENTS.md` project
    structure (after `packages/mcp-shared`): two layers, escape hatches, supabase as the
    assembly reference, mcp-shared as the leaf-only reference, new gatekeepers start here.
16. **Skill rewrite.** `.agents/skills/write-gatekeeper/SKILL.md` keeps the seven
    responsibilities, the phase gates (including the API-design STOP), and the observer taxonomy;
    Phase 1 becomes kit-first (spec + `types.d.ts` + sessions), Phase 2 maps strategies A–D to
    `privateObservers`/`aclObservers`/`trackedSetObservers`/`openObservers`, actions to
    `defineActions` + `ActionJournal` + `stageAction`, and simulation to the pure substrate
    (`createSimulationView` over `journal.listPending()`, `replaySimulation`, `ProvisionalIds`,
    provider reducers local and pure). Revert guidance: the facet's `protected revert(id)` hook
    with github's and linear's `revertAction` bodies as the exemplars. Recipes, cited by symbol
    name (never line numbers — those rot): cascade rejection of provisional dependents (linear's
    dependent-action sweep in `rejectAction`, github's `#rejectReplyDependencyChain`) and
    apply-time credential failure (wrap apply bodies in `CredentialSource.run`, mapping the
    provider's grant-death error to `CredentialsExpiredError` and reporting a rejection through
    `adjudicateRejection` — not the pre-kit fire-and-forget `noteCredentialsExpired` note, which
    the verdict replaces). A new "when to bypass the kit" section names the known
    cases — google-class OAuth irregularities, MCP-class runtime-generated types, email-class
    resource claiming — and states that each keeps implementing the raw interfaces while reusing
    leaf modules. Reference implementations: supabase for the kit path, github for the raw path.
    `SKELETON.md` is rewritten as a kit-based skeleton (spec, subclasses, `wrangler.jsonc` with
    the `capnweb-validate` build command and migrations, `env.d.ts`, `types.txt` symlink,
    configurator, workerd test scaffold); the raw path points at `gatekeeper-github` instead of
    carrying a second skeleton.

## 8. Verification

All commands from the repo root.

1. `pnpm install`, then `pnpm --filter @gadgets/gatekeeper-kit test:run`. Both suites green. The
   checks that define success: the fixture OAuth round trip delivers a usable `GatekeeperUser` stub;
   concurrent `beginAuth` advances exactly once; `completeAuth` after a concurrent `revoke` leaves
   the account empty; a mocked-500 refresh leaves stored credentials intact while a mocked-400
   `invalid_grant` notifies expiry exactly once and re-notifies after a failed callback; observation
   data is withheld until `authorizeObservation` resolves; a staged action is absent after
   `submitAction`-failure rollback — `journal.get(id)` is `undefined` and `listPending()` is empty;
   tracked-set exclusion lists exactly the denied observer.
2. `pnpm --filter @gadgets/mcp-shared test:run` plus type-checking the two MCP connectors — the
   step-12 regression gate.
3. `pnpm --filter <supabase package name> test:run` (the `name` field in
   `packages/gatekeeper-supabase/package.json`) — legacy-storage upgrades and the workerd connect
   flow.
4. `pnpm build` and `pnpm lint`.
5. `git diff --stat main...HEAD -- packages/gatekeeper-supabase/wrangler.jsonc` is empty (bare
   `git diff` compares the worktree, so it goes empty once the change is committed), and
   `node --test scripts/release/manifest-lib.test.ts` leaves the golden manifest unchanged (the
   kit is non-deployable and the supabase worker config is untouched).
6. Dev smoke, no provider credentials needed: `pnpm dev-server`, then
   - `curl -sS -i "http://localhost:8787/gatekeeper/supabase/oauth?error=denied"` → HTTP 400 with
     "authorization failed" in the body;
   - `curl -sS http://localhost:8787/gatekeeper/supabase/$(printf 'a%.0s' {1..64})/$(printf 'b%.0s' {1..64})`
     → the not-configured page when dev has no `CLIENT_ID`, else the invalid-link page (this proves
     initiation routing and DO dispatch, not browser-to-Workshop binding);
   - the Workshop UI lists Supabase in the connectors panel.

## 9. Assumptions & contingencies

- **Bare `@validateRpc()` on subclasses of generic bases** is expected to work (the
  `gatekeeper-mcp` precedent). If the transform rejects a facet subclass, switch that class to
  the explicit-surface form `@validateRpc<Gatekeeper<…>>()` documented in the capnweb-validate
  README, for both supabase and the fixture.
- **capnweb-validate resolving kit imports**: MCP consumers already resolve
  `@gadgets/mcp-shared/*` during `capnweb-validate build`. If kit imports resolve differently,
  add the same `paths` mappings `gatekeeper-mcp/tsconfig.json` uses.
- **`ctx.exports` typing**: if supabase's checked-in `worker-configuration.d.ts` lacks entries
  for the kit-based classes after the port, regenerate it with `pnpm exec wrangler types` in that
  package and commit the diff.
- **In-flight connects during a deploy** of the ported supabase: the stored nonce shape is a
  superset of the old one, so live initiation links keep working; a flow whose state was minted
  before the deploy and consumed after may fail once, and the user restarts the connect. No
  migration code for attempt records.
- **Vite+ task nesting**: if `withVitestTask` misbehaves under vp's stripped environment, give its
  test task the composed string `vitest run && vitest run -c vitest.worker.config.ts` directly, as
  `gatekeeper-cloudflare`'s `test:run` script composes it.

## 10. Deferred seams — separate implementations behind existing interfaces

Opportunities the review pass verified against both corpora for slotting an alternate
implementation behind a contract the kit already has. Nothing here is built now: the surface is
preserved so the work is additive when its trigger port lands. Each entry names the interface, the
evidence, and the trigger.

- **Expiry-derived consumer credential cache** behind `CredentialSource`'s `get`/`run` surface.
  Google caches a fetched token until expiry − 60s (`google/src/auth-retry.ts:181-213`) and slack
  until expiry − 300s (`slack.ts:510-519`) — freshness derived from the credential rather than a
  fixed TTL. *Trigger:* the google or slack port. Add an `expiresAt`-aware variant rather than
  reintroducing a TTL knob; it needs an `expiresAt` projection the stored/public credential split
  does not carry today (§4.6).
- **Split-key handshake variant** behind the `putInitiation`/`advanceToOAuth`/`claimOAuth`
  operations. Internal ironclad stores `initiationNonce` and `oauthNonce` under two keys
  (`ironclad.ts:129-131,1634-1692`) where the kit uses one `nonce` record. *Trigger:* the ironclad
  port — either a variant module or a one-time key migration. Salesforce
  (`salesforce.ts:150-152,1210-1269`) already matches the kit shape exactly, PKCE verifier in the
  record.
- **Per-action-id claim serialization** as an alternative to the facet's global `SerialTaskQueue`.
  The durable claim itself is now in the journal (§4.8, `claimBeforeApply`); what stays deferred is
  its granularity. `mcp-shared` stamps `applying` synchronously before awaiting
  (`action-store.ts:130-162`) and ironclad coalesces per id (`ironclad.ts:957-995`). *Trigger:*
  measured per-DO contention where one slow apply may not block unrelated actions — a `deferred:`
  global lock is the simple form, per-id claims the one that matters if throughput does.
- **Provider-probing reconciliation** behind `ActionDefinition`, as a
  `reconcile?(payload, host, ctx) => "applied" | "absent" | "unknown"` consulted before re-applying a
  `claimed` record. It is the principled answer to `APPLY_OUTCOME_UNKNOWN_MESSAGE`, which today ends
  in "check the provider yourself". *Trigger:* the first gatekeeper whose provider supports both an
  idempotency key and lookup by it — 0 of 15 live writers probe today, and three independently chose
  the manual-check message instead (`mcp-shared/src/action-store.ts:43-46`,
  `ironclad.ts:916-931`, and the kit). Half the work is already done: `ActionContext.id` is the
  stable key such a probe would look up.
- **A `reverting` marker** for the retained tier, so an interrupted compensating call is
  distinguishable from a completed one. No gatekeeper in either corpus persists one, which is why
  all 11 functional reverts are silently replayable; the kit already owns the right primitive in
  `claimed`, and the work is extending it past the tier boundary. *Trigger:* the first
  non-idempotent compensating write — today's are mostly restores of a previous value, which is why
  the gap has cost nothing yet.
- **Already realized** (orientation only, no work): the `ObserverStrategy` A–D wrappers behind one
  interface; `ArrayCursor`/`PageNumberCursor`/`OffsetCursor`/`TokenCursor` behind `Cursor<T>`; and
  Layer 2's `AuthStrategy` (`oauth2` / `tokenAuth` / CF Access) — the same doctrine at the auth seam.
