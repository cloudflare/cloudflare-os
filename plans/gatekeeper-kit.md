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
  coalescing, observer strategies, a durable action journal, pure simulation helpers, a TTL cache,
  and RPC cursors. Each is usable on its own; none requires the assembly layer.
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
`packages/mcp-shared/package.json`. Six files are internal instead: `serial-queue` (§4.12) and the
two split out of `actions` and `observers`, each reached through its owning subpath; `positive-int`
— one `requirePositiveInt` shared by every module that takes a bound; `kv` — the three KV surface
slices the leaves name, since seven modules had begun to carry byte-identical structural copies;
and `single-flight` — the in-flight coalescer four leaves had hand-rolled, on the same reasoning as
`serial-queue`.

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
  constructor(message: string, opts?: { cause?: unknown });
}

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
  });
  stored(): Creds | undefined;   // mints an identity for a record that predates them, so credentials
                                 // and a fence are always surfaced together
  connect(creds: Creds): void;   // a (re)connect's install: rotates the connection generation, THEN
                                 // commits (identity rotation + record write). Refresh commits
                                 // internally through fresh()/rotate(); there is no public commit
  clear(): void;                 // retires the migration, rotates the identity and the connection
                                 // generation (rather than deleting them), THEN drops the record
  identity(): string;            // random per write; opaque, equality only — a counter is reset by the
                                 // deleteAll() in revoke()/alarm(), which would reissue a fence value
                                 // from the revoked grant. "" = never surfaced, and never a fence
  connectionGeneration(): string; // survives refresh, rotated by connect()/clear(); the cache
                                 // authority (§4.10) and the account half of the action fence (§4.8).
                                 // Minted on first read, never ""
  fresh(refresh: (current: Creds) => Promise<Creds>): Promise<Creds>;
  rotate(refresh: (current: Creds) => Promise<Creds>): Promise<Creds>;   // refreshes now, whatever
                                 // the recorded expiry says: the provider rejected an unexpired
                                 // credential, and it is the only authority that matters
}

export class CredentialSource<Creds> {          // held by User entrypoint / facet / verifier
  constructor(opts: {
    account: () => AccountCredentialStub<Creds>;   // { getCredentials(): Promise<{ creds, identity, generation }>; noteCredentialsExpired(identity) }
    isAuthError(e: unknown): boolean;              // grant death only, never a per-resource denial
    expiredMessage: string;
    vendorId?: string;                             // log attribution
  });
  get(): Promise<Creds>;       // reads the account; concurrent reads coalesce onto one round trip
  run<T>(fn: (creds: Creds) => Promise<T>): Promise<T>;   // hands the call its creds, captures their
                                 // identity; an auth failure under an identity a refetch has since
                                 // superseded with a live successor is stale — rethrown as retry,
                                 // not reported as expiry. No live successor, no retry: a mismatch
                                 // alone can mean the read was fenced out, and its failure reports
  authority(): string | undefined;  // the connection generation of the last fetch, synchronously —
                                 // named for its facet-side cache-authority role, wired through
                                 // KvTtlCache.partitionedBy (§4.10). undefined before the first
                                 // fetch, and from a reported expiry until a fetch started after
                                 // the report adopts an undead identity: partition unknown, so a
                                 // cache keyed on it bypasses rather than serves. Last-seen and
                                 // shared — never the action-fence capture, which rides the
                                 // generation of its own fetch
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
holds that exact record — on a mismatch it returns the newer stored credentials when present and
throws `CredentialsExpiredError` when the store was cleared. The failure path carries the same
fence, but **only for grant death**: a `CredentialsExpiredError` propagates when the identity is
still current and otherwise re-reads the store (newer credentials → return them; cleared →
propagate), so grant A's stale death can never expire grant B. Every other refresh error propagates
untouched (grant death vs. infrastructure, §3) — fencing those would swallow an outage that raced a
reconnect, and reclassify one that raced a `clear()` as expiry. Refresh is not
transactional against provider-side rotation: a crash between the provider rotating a token and
the commit persisting it can lose the new token. The README documents this; nothing in the API
may promise otherwise.

`CredentialSource.run` resolves the credentials, hands them to the operation, and captures their
identity before awaiting it. When `isAuthError(e)` is true and that captured identity is still the
last one a fetch adopted, it calls `account().noteCredentialsExpired(identity)` and throws
`new Error(expiredMessage, { cause: e })`, adding that identity to a dead set (per-activation and
never evicted: growth is bounded by account commits, and stale failures mark identities out of
commit order, so no eviction order is safe): the account keeps the grant until reconnect, so a
refetch returns the same identity,
and re-adopting its generation would let cache hits mask the outage — while a fetch already in
flight at the report is fenced out entirely, since a straggler can carry any old identity. A fetch
started after the report, adopting an identity not in the dead set (successful refresh or
reconnect), re-establishes the authority. Expiry also surfaces through the fetch itself — a failed
refresh rejects `getCredentials()` with an error named `CredentialsExpiredError` — and the source
drops the authority there too, under the same fence so a straggler's stale rejection cannot clear a
revived partition. When a concurrent refetch has since adopted a **live successor** — a different
identity not itself in the dead set — the failure is stale: reporting it would expire the grant
that replaced the one the call used, and clearing the authority would drop the live grant's
partition, so `run` reports nothing, clears nothing, and throws a fixed retry message instead. A
bare identity mismatch is not enough: a fetch fenced out by the report still hands its credentials
to its caller without adopting them, and when those fail too, nothing live succeeded them — the
failure is fresh evidence and reports as expiry, or a later refetch would re-adopt the dead grant.
The account hop is itself wrapped, so its failure cannot replace `expiredMessage`; everything else
passes through.

**`isAuthError` is the one classifier the agent can aim.** It decides that a *grant* is dead, and
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
  excludeObservers?: string[]; commit(): void; discard?(): void;  // exactly one of the two runs;
};                                       // both MUST be synchronous -- the gate does not await them

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
batch-checks every stored observer, and returns `excludeObservers` plus a `commit()` that
promotes the newly-revealed sets to `"observed"` only after the overseer authorizes the observation.

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

`authorize` resolves the scope to one `ObservationCheck` — `sets` → `strategy.prepare(ids)`,
`withholdFromObservers` → `strategy.prepareWithheld()`, `baseline` → no strategy call at all —
then calls `queue.authorizeObservation`, adding `excludeObservers` only when the check produced any,
and invokes `commit()` after authorization succeeds or `discard?.()` when it refuses. `prepare` is
absent on A/B/D, which retain no per-set verdicts, so no exclusions there. `prepareWithheld` is
**required** with no fallback, because a silent no-exclusions default would let a misclassified
strategy void the caller's owner-only declaration — the failure would be a disclosure with no
signal. A answers vacuously (nobody is ever admitted); B and D throw, since their own premise is
that an admitted observer sees everything read here — a truthful owner-only read under them means
the resource belongs on C, and a read the premise covers should say `baseline`. Because the gate is
the only source of that field, there is no set-union merge left to do. Sessions call the gate for
every read instead of the raw queue.

**A refusal releases reservations, not records.** `discard()` is for state that must not outlive the
read that made it — the withheld reservation below. Pending set records are not that: a read that
never committed disclosed nothing, so keeping them costs a slot of the tracking budget and denies an
observer a set nobody saw, and the next read of those sets re-verifies and promotes them. Every
tracked-set gatekeeper in the corpus does exactly this, in the same words — "failed attempts remain
pending and are rechecked" (`notion.ts:880`, `linear.ts:1026`, `supabase.ts:998`,
`google/observers.ts:10`), and none of them deletes a set record at all. An earlier draft reclaimed
them behind an in-memory claim count, which a lost activation defeats: the count is gone and the
record is not.

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
export type JournalRecord<A> =                          // returned by get(); error only on "failed"
  { state: JournalState; action: A; error?: string };
export type JournalEntry<A> =                           // listed entries; structurally the
  { readonly id: number; readonly action: A };          // SimulationRecord createSimulationView takes
export class ActionJournal<A> {
  constructor(kv, opts?: JournalKeys & {
    upgradeRecord?(raw: unknown): A | undefined;   // undefined leaves a raw record unadopted
    maxPending?: number });
  // `maxPending` defaults to 50; records carry a version marker, and an unmarked one goes to
  // upgradeRecord rather than being trusted
  allocate(action: A): number;              // sequential id, state "staged"; throws at maxPending
  markSubmitted(id: number): void;          // "staged" → "pending"
  markClaimed(id: number): void;            // "staged" | "pending" → "claimed"
  restorePending(id: number): void;         // "claimed" → "pending"
  markFailed(id: number, error: string): void;    // → "failed", terminal; reason capped; only reject clears it
  rollbackSubmission(id: number): void;
  get(id: number): JournalRecord<A> | undefined;  // any state; checks both tiers
  remove(id: number): void;
  retain(id: number, action?: A): void;     // post-apply write: retained record first, then the
                                            // delete; no-op on a "failed" record
  isRetained(id: number): boolean;          // tier membership — trustworthy where open consumer states are not
  listPending(): JournalEntry<A>[];         // "pending" + "claimed", ascending id; feeds createSimulationView
  listUndecided(): JournalEntry<A>[];       // "pending" only — what a decision may still retire
}
export type ActionSubmitter =                           // the surface staging needs; `gate.actions`
  Pick<RpcStub<ApprovalQueue>, "submitAction">;         // (§4.7) and a full stub both satisfy it
export function stageAction<A>(journal, queue: ActionSubmitter,
  action: A, description: ActionDescription): Promise<number>;

export type ActionPresentation =                        // the approver-facing text; policy fields
  Pick<ActionDescription, "title" | "description" | "implementsRevert">;   // come from the decl
export type ActionContext = { readonly id: number };    // durable, unique, stable across retries
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
}): ActionSet<H, M>;

export type BoundActionSet<M> = {
  submit(queue: ActionSubmitter, kind, payload): Promise<number>;   // serialized against other
                                            // submissions only
  apply(id: number): Promise<void>;         // both exclusive with each other and with
                                            // runExclusive; void for an already-applied id
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

Two bounds keep this off the Layer 1 critical path: the window is a single overseer round-trip
against human reject latency, and the consequence is caught downstream. GitHub
(`github.ts:3287-3290`) and spotify (`spotify.ts:1709-1720`) fail cleanly when a provisional target
is unresolved, just as `ProvisionalIds.requireResolved` does here. The apply reports the clear
resolution error, and its record is restored to pending and remains retryable.

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
overseer can label an executed action rejected. `retire()` therefore removes the record while
remembering the id in one bounded array (the prunable allowance) both verbs consult: the replayed
apply settles, the reject throws "no longer pending", and ids past the allowance degrade to the
unknown-id error rather than growing a tombstone tier. mcp-shared ships the same semantics as full
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

**Other port-time obligations, recorded here because no leaf can enforce them.** None is a Layer 1
defect; each is either additive later or a fact about one provider that only bites on its own port.

| Obligation | Who it affects | Why it is deferred |
| --- | --- | --- |
| **Ordering credential mutations against `revoke`.** A refresh in flight when `revoke()` wipes storage mints a token the identity fence correctly discards — leaving live provider-side authority nobody stored. Google serializes its four credential paths on one FIFO chain (`google.ts:405-427`), and even it leaks one error-path `kv.delete("refreshToken")` outside the chain (`:524-530`). | every port with a refresh flow | `revoke()` is not in the kit — the account base owns it (§5.6): it drains the refresh in flight and best-effort revokes its result as well as the captured grant. `coordinator.fresh()` already coalesces concurrent refreshes; the coordinator needs no queue of its own. |
| **Baseline re-checks on the exclusion path.** `verifyBaseline` runs at admission only, so an observer who later loses the binding-wide grant keeps observing. Google's batch result carries it per call — `{ baselineAllowed, allowed[] }` (`gatekeeper-google/src/observers.ts:48-49`) — and excludes on `!baselineAllowed` (`:206-215`). | google port first | Expressible today by folding the baseline into `hasSetAccess` (return all-`false`), so this is a documentation gap rather than a missing capability. Note google's baseline is a recorded *resource grant* (`resources.ts:203-205`), not org membership, and it *excludes* rather than removing the observer. |
| **`maxTrackedSets` is a default, not a corpus constant.** 1000 comes from google's generic default, but its concrete Drive tracker overrides to **2000** (`drive-observers.ts:49-53`), sized against `ceil(N/100)` subrequests. | supabase, notion, linear ports, which had no cap at all | A port inherits a bound it never had; the number is per-provider and belongs in that port's options. |
| **`maxObservers` is a platform bound the corpus does not have.** Every retained observer costs one verifier call per read, and Workers cap a request at **32 Worker invocations** — past that the call throws, so a binding with too many collaborators fails *every* read rather than degrading. No shipped tracker caps this: notion, confluence, context, linear and internal `gatekeeper-shared` fan out over all observers with unbounded `Promise.all`, and google throttles concurrency without bounding the total. | every strategy-C port | The kit refuses at admission instead, which is the legible half of the same failure. The default is **10**, not 20: an observer count prices only the kit's own hop, and every verifier in the corpus spends a second invocation calling its account DO (`notion.ts:615-635`), so 20 observers is 40 invocations before the read does anything. The real ceiling is per-deployment, so the number belongs in that port's options. `concurrency` is a throttle and never a bound. |
| **Re-fetch after a reported expiry.** The account keeps the dead grant until reconnect — `noteCredentialsExpired` notifies, it does not clear — so any later `get()` fetches the same credentials back and its callers 401 again. | all | Self-healing and bounded: each round costs a redundant 401 (the account notifies once), never a wrong authorization. The source keeps reported identities in a per-activation dead set and refuses to re-adopt their generations, and fences out fetches already in flight at the report; without those, a cache hit under the restored partition never reaches the provider, so hit-only paths would mask the outage for the TTL and across the reconnect. A fetch started after the report, adopting an identity not in the set — successful refresh or reconnect — re-establishes the authority. |
| **Corrupt-record blast radius.** A throwing `upgradeRecord` propagates out of `#coerce`, so one unreadable legacy record makes `listPending()` throw and blinds the whole simulation overlay rather than dropping that entry. | ports supplying `upgradeRecord` | Both behaviours lose something — a throw blinds everything, skipping hides one pending action from its user — so pick it with a real corpus of legacy records in view. |
| **The retained tier is unbounded.** `#requireCapacity` scans only the pending prefix and skips `isRetained`, so `maxPending` bounds pending records and twice that many `staged`/`failed` ones, but never retained ones. A long-lived `retainApplied: true` binding accumulates one record per applied action indefinitely. | every retaining port | Retention is consumer policy and vendor caps differ; the binding must retire records through `runExclusive` under its own policy. |
| **Past its bound, a pruned `failed` record takes the only account of what went wrong.** The Workshop keeps a thrown `applyPendingAction` pending and visible (`overseer.ts:9497-9500`, "the action stays pending and the turn stays suspended"), so the journal record is the sole holder of the reason. Once more than `2 × maxPending` prunable records accumulate, the oldest are dropped: a later approve degrades to `Unknown pending action` and a later reject succeeds silently, which can lose an `ActionApplyError` warning that a provider effect partly landed. | any port accumulating more than twice `maxPending` un-rejected failures on one resource | Storage must be bounded, so something must eventually go; the choice is only what and when. Counting failures against the cap instead — the obvious alternative — converts a lost diagnostic into a provider-triggered denial of service, blocking all staging until the user hand-clears them. Staged-first pruning and the doubled bound push this out; closing it entirely needs a tier that keeps reasons after their records, which is the same unbounded retention the row above defers. |
| **A pending action is not fenced against the connection that staged it.** In-place reconnect keeps the same account DO and `userObjectId` and merely replaces the grant — `reconnectAccount()` is `record.account.reconnect()` (`user.ts:1541-1545`) and `markCredentialsRestored` re-describes on the assumption the user "may have re-authed with different info" (`user.ts:1655-1664`). Neither the overseer's approval record nor the facet's journal is touched, so an action staged under principal A can be approved and applied with principal B's credentials — and an object id that named one thing in A's tenant may name another in B's. No gatekeeper in either corpus fences this. | every port whose provider allows re-auth as a different principal | Not fixable with a nonce. A facet-side generation check followed by the handler's own `get()` is not atomic — a reconnect landing between them still yields B — so the fence has to be a credential read that takes the staged generation, `getCredentialsForGeneration(expected)` in the account DO, over the `connectionGeneration()` the coordinator already stores (§4.6; `identity()` cannot serve — every refresh supersedes it, invalidating every pending action). The stage-time half is delivered: the generation rides `getCredentials()`, so a staging call records the generation of its own credential read — never `CredentialSource.authority()`, a shared last-seen value (§4.10) that a concurrent fetch can move between the read and the record, stamping an action derived under A with B's generation. The apply-time fenced read remains open. That reaches only handlers that resolve credentials through the kit; a handler holding its own client still calls the provider unfenced, which is the cost of the escape hatch. Land it with the first port whose provider permits principal-switching re-auth, so the handler ergonomics are designed against a real one — supabase qualifies (reconnect may authorize a different org), so decide at that port whether to take the fence or explicitly re-scope this trigger. |
| **The expiry latch re-arms with two writes.** `clearCredentialExpiryLatch` clears the boolean and writes a fresh arm. Were the second to fail alone, an in-flight notification for the replaced credentials would match the surviving arm and latch the new ones — the one *silencing* failure in a module whose every other window fails toward a harmless duplicate notification. | every port with a refresh flow | Both writes are adjacent, awaitless and constant-size, so one implicit transaction carries them and no trigger separates them; the function's doc comment states that adjacency as the invariant to preserve. Every candidate fix is worse than the window: swapping the order makes the silence deterministic, and one combined record breaks the plain-boolean compatibility the latch key promises. If a port ever needs it, the escape is a single record holding arm and notified together. |
| **A crash mid-withheld-read closes admission for good.** The `observer-withhold:<nonce>` marker goes down before the overseer is asked and is stranded by an activation that dies before settling; `addObserver` refuses while any marker stands, and nothing reclaims one. A read the overseer would have refused still leaves the binding unshareable. | every strategy-C port using `withholdFromObservers` | A stranded marker cannot tell a lost reply from a lost request, and the overseer's record is durable before the reply — so reclaiming on any schedule risks disclosing a recorded owner-only description to the next collaborator admitted, while over-fencing costs sharing on a binding already handling owner-only data. The attempt record's fail-closed trade, without the TTL escape. *Trigger:* a binding observed stuck closed with no `observer-withheld` latch. |
| **A lost `authorizeObservation` reply reopens admission over a standing withheld record.** `authorize` runs `discard()` on any throw, but a transport failure after the overseer's durable store is indistinguishable from a refusal — the marker comes down while the record stands, and the next collaborator admitted can read the owner-only description through `listActions()`. | every strategy-C port using `withholdFromObservers` | Keeping the marker on every throw inverts the earned-latch trade: refusal is the *ordinary* answer for a binding with observers (`overseer.ts:4590-4603`), and would permanently close admission for a read that disclosed nothing. Matching refusal message text was considered and rejected. The fix is a distinguishable refusal result in the `ApprovalQueue` contract, with `discard()` run only on it — batch with the next kernel contract change. *Trigger:* that change, or the first port shipping withheld reads. |
| **A dropped action kind strands its dependents silently.** `provides`/`dependsOn` are evaluated from the live definition, so an action staged under a kind a later deploy removed reports no refs, and the dependents it was holding open are not retired with it. | any port that removes a shipped action kind | The dependent stays pending and fails at the provider instead of naming the parent it needed, so what is lost is an error message, not an effect — a ref a gatekeeper declares in `dependsOn` is by definition an identifier the provider validates. Closing it means storing the refs on the record, which puts staging metadata inside the journaled action identity and threads it through every state transition. No corpus gatekeeper stores its graph either (§4.8), so the six that cascade port without this. *Trigger:* the first port to remove a shipped action kind. |
| **A read during an in-flight apply can overlay an effect the provider already made real.** Simulated reads project `pending` and `claimed` records, and an apply is a provider round trip followed by the journal write, so a read landing between the two fetches the real effect and overlays the same action again — a transient duplicate in the *view*, never a second provider effect (resolution is serialized). | every port with continue-with-simulation actions | Inherent to overlaying local pending state onto remote reads: no atomic instant flips both, and it holds for every projected state, so dropping `claimed` from projection would only make the action vanish mid-apply instead. Serializing reads with resolution would stall the agent for the length of a provider call on every read — the trade submission already refuses — and `runExclusive` is the opt-in for a consumer that needs a consistent snapshot. Self-healing: the next read after the journal write is correct. *Trigger:* an agent observed acting on the duplicate, e.g. staging a corrective action against it. |
| **Pending observed-set records are never reclaimed.** `prepareObservation` marks untracked sets `"pending"` before awaiting the oracle and returns no `discard`, so a read the overseer refuses leaves them behind; only a later successful read of the same sets promotes them, and `#trackedSets()` counts pending rows against `maxTrackedSets`. Enough distinct refused reads and every `prepareObservation` throws "Bind a narrower scope". | every strategy-C port | Inherited behaviour, not introduced: google's shipped tracker writes pending before the await and returns `commit` only (`gatekeeper-google/src/observers.ts:186-236`), with `maxTrackedSets` alongside it. The naive fix is unsafe — two concurrent reads can mark one set pending, and a `discard` that deleted it after the other committed would un-track an observed set and let a later observer in unverified against it. So a reclaiming `discard` must delete only rows still `"pending"`, which is a concurrency argument that wants the fixture in front of it. *Trigger:* the first strategy-C port, or a binding observed to exhaust its budget. |

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
`submit(queue, kind, payload)`, `apply(id)`, `reject(id)`, a readonly
`retainsApplied` (the resolved retention flag the facet base's assert reads, §5.9),
`autoApprovableKinds()` (filtered to `autoApprovable: true`, deduplicated by tag), and
`resolved(outcome)` — the facet base's way to fire `afterResolve(host, "reverted")` after its
revert hook, since the hook is closed over inside `defineActions`. There is no `revert(id)`
here — see §5.9.

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
On success the kit performs a **single atomic post-apply write**: the handler's returned
`{ action }` (apply-time artifacts such as created entity ids — the linear/notion pattern) merged
with the state transition — record retired, or moved to the retained tier as `"applied"` when
`retainApplied`. One writer by construction; handlers never write the journal mid-apply. An apply
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

`JournalRecord` is discriminated on `state`, so `error` exists only on a `"failed"` record and
always does there. The one fallback for a stored failure that lost its reason lives at `#coerce`,
the single storage boundary, rather than at each reader — `./actions` reads `record.error` with no
`??` behind it.

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
  isResolved(id: Id): boolean;
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
`KvTtlCache.partitionedBy(kv, source)`, which wires the authority to the source's live
`authority()`; the raw constructor `(kv, authority: () => string | undefined)` remains
for static and composite authorities. There
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
facet's next credential fetch — TTL-bounded, and closed at the next operation, since every
operation reads the account afresh (§4.6). An async authority was considered and rejected: a DO
round trip per cache read defeats the cache, and an RPC-fetched fence races the reconnect it
fences.

**The generation record is deliberately not partitioned.** It is a single shared counter, so a bump
made under one authority also invalidates another's entries. That only ever over-invalidates, which
costs a refetch; under-invalidation is already impossible once entries carry the authority. One
mechanism, not two.

The `"cache:"` prefix is fixed rather than a `namespace` option: cache families in the corpus are
key *segments* within one namespace (github `cache:<kind>:`, notion `cache:page:`/`cache:db:`,
supabase `cache:entry:`), so a per-kind segment belongs in the caller's own `key`, and per-family
freshness is already per-read through `cached(key, ttlMs, …)` (notion's 30s/60s/1h split). No DO in
either corpus runs two separate durable TTL caches needing distinct namespaces.

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
};
export function withAuthRetry<Token, T>(options: AuthRetryOptions<Token>,
  run: (token: Token) => Promise<T>): Promise<T>;
```

`CredentialSource.run()` has exactly two outcomes: pass the call through, or report the account
expired. That is right for the five gatekeepers whose 401 means the grant is gone (supabase,
github, linear, spotify, homeassistant), and wrong for the four that mint a short-lived derived
bearer from a longer-lived grant, where a 401 usually means *that bearer* is stale. All four
hand-roll the same single retry: marketo (`marketo-api.ts:462-477`), google
(`auth-retry.ts:100-141`, which additionally force-refreshes with the rejected token's identity),
notion (`notion-api.ts:1022-1052`) and confluence (`confluence-api.ts:527-550`).

One retry, never a loop — a credential the provider rejects twice is not going to be accepted on a
third attempt, and a loop turns a dead grant into a burst of token mints. `run` therefore executes
**at most twice** and must be replayable, which the doc comment states and which means building the
request inside it rather than passing a prepared one. `staleToken` carries the rejected token into
the refresh so a shared cache can skip a redundant mint when another caller already advanced it
(google's shape). A non-auth error at either attempt propagates immediately: transport failures and
5xx are not credential problems, and retrying them here would double every provider outage.

**This module reports nothing, because it holds no credential identity to fence a report on.** An
expiry notification racing a reconnect is exactly what the identity fence exists to reject, and a
stale notifier that stepped on one would mark a healthy grant dead — so neither a failing `getToken`
nor a twice-rejected credential is reported from here. Both belong to the caller's
`CredentialSource.run(creds => withAuthRetry(...))`: `withAuthRetry` swallows the first 401 and
rethrows only a persistent one, so `run`'s catch fires exactly once, against the identity it
captured *before* the attempt (§5.6).

**Where `getToken` comes from is the port's, and today it is a vendor RPC.** For the five providers
whose 401 means the grant is gone, there is nothing to wire: `CredentialSource.run` alone is the
whole story. For the four that mint a derived bearer, `getToken({ forceRefresh: true })` has to
reach the account, because §5.6 forbids refresh material crossing to a facet — so the mint is
account-side by construction, and the channel is per-vendor: google passes
`getAccessToken({ forceRefresh, staleToken })`, notion calls a separate `refreshCredentials()`
(doc'd at §5.6's projection rule). The kit does not name that channel yet; the §5.6 work item below
records the shape it should take, and until it lands a port supplies its own.

`CredentialSource` cannot serve as that channel: `getCredentials()` is `coordinator.fresh(...)`,
which refreshes on expiry only, so a grant killed by `invalid_grant` while its access token is
still unexpired is re-served unchanged. `coordinator.rotate()` is the account-side half that
forces one; whatever RPC a port puts in front of it owes the same dead-grant treatment
`getCredentials()` gives — a still-current `CredentialsExpiredError` becomes
`noteCredentialsExpired()`, fenced on the identity.

This closes the "401 retry" *logic* the §4.8 table recorded as deferred. The refresh channel the
retry depends on stays per-vendor until the work item lands.

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
export class PreviewOAuth {
  constructor(options: { callbackUri: string; env: PreviewOAuthEnv });
}
```

This is Google's preview callback relay generalized without changing its wire format: direct flows
retain the `64hex:64hex` state, while preview flows use a ten-minute HS256 JWT carrying the same two
identifiers and the preview return URL. The factory returns the exact redirect URI to persist through
the code exchange, creates provider-facing state, and handles callbacks atomically — callers receive
either verified local state or an already-filtered relay `Response`. Return URLs are limited to the
stable callback's exact path and Worker Preview host suffixes; only `code`, `error`, and unchanged
state cross the relay. Google is the first consumer. Other gatekeepers can adopt the leaf without
porting to the assembly.

## 5. Layer 2: the assembly

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
  refresh?; revoke?; isAuthError; expiredMessage; expiresAt?; refreshSkewMs?;
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
- `prepareReconnect(nonce)` — sets `"reconnecting"`, `clearCredentialExpiryLatch`,
  `putInitiation`, fresh `"attemptGeneration"`.
- `beginAuth(nonce)` — `advanceToOAuth` with `{ connect }` metadata, then `strategy.begin`; after
  `begin`'s awaits, re-checks `"attemptGeneration"` and returns null on mismatch (rendered as an
  invalid link).
- `completeAuth(payload, state)` — `strategy.obtain`, then re-checks `"attemptGeneration"` and
  returns false on mismatch. This closes the revoke race: a `revoke()` that ran during the token
  exchange has already cleared the generation, so the exchange result is discarded instead of
  resurrecting credentials after
  `deleteAll()`. On success: `coordinator.connect`, `clearCredentialExpiryLatch`, clear
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
- `getCredentials()` — `coordinator.fresh(strategy.refresh)`, projected through
  `config.publicCredentials` and returned as `{ creds, identity, generation }` (the coordinator's
  current credential identity, reissued whenever credentials are written or cleared, plus its
  `connectionGeneration()`). A still-current
  `CredentialsExpiredError` from refresh triggers `noteCredentialsExpired()` and rethrows as a
  `CredentialsExpiredError` carrying the strategy's `expiredMessage` — the name must survive the
  RPC (the transport strips the class), since the source drops its cache authority on it; verify
  preservation at the first port. Any other refresh error rethrows with credentials intact. **The
  projection is not optional — see below.**
- `noteCredentialsExpired(identity)` — no-ops unless `identity` matches the coordinator's
  current one (a stale notifier lost the race to a reconnect); otherwise delegates to
  `notifyCredentialsExpiredOnce` with `vendorId = spec.id`.
- `revoke()` — clears `"attemptGeneration"`, `deleteAlarm()` and `deleteAll()` **before** the first
  await, then best-effort `strategy.revoke` on the grant it captured (failures log `error` with
  event `oauth.grant.revoke.failed`). Destroying local state after awaiting the provider would let
  a connection begun during that await be erased by the revoke that preceded it. It also owns the
  refresh in flight when it runs: the base hands the coordinator `strategy.refresh` wrapped so the
  latest refresh promise is observable, and after `deleteAll()` it awaits that promise and
  best-effort revokes its result too — a refresh that loses the identity fence otherwise mints
  rotated provider-side authority nobody stored and nobody would ever revoke (§4.6 obligations).
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

**Deferred: the force-refresh channel (§4.13).** `getCredentials()` is `coordinator.fresh(...)`,
which refreshes on expiry only, so nothing in the base's RPC list reaches `coordinator.rotate()`.
A derived-bearer port therefore supplies `withAuthRetry`'s `getToken({ forceRefresh: true })` from
its own vendor RPC — google's `getAccessToken({ forceRefresh, staleToken })`, notion's
`refreshCredentials()`. Naming that channel here is what stops each port inventing one. Design
notes for whoever lands it:

- **A required method, not an optional parameter.** TypeScript accepts a zero-argument
  implementation as satisfying `getCredentials(options?: …)`, and jsrpc drops the argument at
  runtime, so an account that ignores `forceRefresh` compiles and silently re-serves the rejected
  token; `withAuthRetry` then replays it, `run`'s catch fires, and a healthy grant is retired. A
  required `rotateBearer()` fails with TS2741 at the mistake, and has no option to ignore.
- **`staleBearer`, not `staleIdentity`.** `run` hands its callback `creds` only — `identity` stays
  private — so an identity is unobtainable where this is wired. The rejected bearer is in scope by
  construction, and comparing bearer values is what google already does (`google.ts:556`) to skip a
  redundant mint. Required, since `withAuthRetry` always supplies it on the forced call.
- **Expiry gates first.** Google refuses any cached token inside the safety window whatever the
  request asks for (`google.ts:555`); a forced rotate must not be answered with one either.
- **Do not widen `AccountCredentialStub`.** It would be dead surface for the five grant-death
  providers. A free-standing type plus a small adapter over the bearer `run` already fetched keeps
  the unforced path free of a second account round trip, which is the common case.
- **Interaction with the fencing row (§4.8).** `getCredentialsForGeneration(expected)` extends this
  same seam on a *different* trigger (the first principal-switching port), and generation overlaps
  with `staleBearer` semantically. Whichever lands first should leave room for the other.

### 5.7 `./vendor` — `KitVendorBase<E>`

Abstract `WorkerEntrypoint<E>` with hook `[kitVendorConfig](): { spec; accounts():
DurableObjectNamespace<…> }`. Implements `describe()` (returns `spec.vendor` as-is),
`connectAccount(callback, options?)` (`newUniqueId`, `generateNonce`, `setCallback`, returns
`{ url: `${getBaseUrl(env, spec.id)}/${id}/${nonce}` }`), `getSupportedResources()`
(`spec.resources.map(r => r.supported)`), and `getTypeScriptTypes()` (`spec.types`).

### 5.8 `./user` — `KitUserBase<E, Creds, X>`

Abstract `WorkerEntrypoint<E, KitAccountProps>` with hook `[kitUserConfig](): { spec; exports():
X; account(): AccountStub<Creds> }`. The typed `exports()` closure is what lets the default
resolver call `def.facet(exports(), props)` without a cast. Implements:

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
(`actions?.autoApprovableKinds() ?? []`), `applyAction`/`rejectAction` (dispatch straight to
`actions`, which already serializes both on the queue it owns — §4.8 — and throwing when no actions
are configured), `addObserver`/`removeObserver` (delegating to the strategy), a protected
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
   module`, per-file `exports` map for every module in §4/§5; scripts `build`, `clean`, and
   `test:run: "vitest run && vitest run -c vitest.worker.config.ts"` as a direct script beside
   the cached Vite `test` task; dependencies `@gadgets/workshop-shared`,
   `@gadgets/backend-utils` (both `workspace:*`); devDependencies
   `@cloudflare/vitest-pool-workers`, `typescript`, `vitest`, all `catalog:`). As landed the
   scaffold is deliberately leaner than first sketched: **one** `tsconfig.json` covering `src`
   and `__tests__` on `@cloudflare/workers-types/experimental` — no `tsconfig.test.json` and no
   checked-in `worker-configuration.d.ts` to drift — and no `capnweb`, `capnweb-validate`, or
   `@types/node`, since Layer 1 has no capnweb runtime path; those arrive when the Layer-2
   fixture needs them. `vite.config.ts` re-exports the shared vitest task:
   `vitestTaskViteConfig('pnpm test:run')`. Run `pnpm install`.
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
   (`prepare` → `authorizeObservation` with `excludeObservers` → `commit`; no commit when
   authorization throws); `escapeObservationValue` flattening each newline run to one space and
   escaping every control character while leaving prose and the empty string alone; each scope arm's
   exclusions, an empty `sets` scope being refused, and a `baseline` read delivering the caller's
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
   `withAuthRetry` (§4.13): the success path asks for a token once with `forceRefresh: false`; a
   non-auth error at either attempt propagates with no refresh and no report; an auth error
   refreshes with `{ forceRefresh: true, staleToken }` and returns the replay's result; two auth
   errors surface the second one; and when composed under `CredentialSource.run`, the outer source
   reports it exactly once.
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
    a stale-identity `noteCredentialsExpired` after a reconnect no-ops; with the
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
    apply-time credential failure (wrap apply bodies in `CredentialSource.run`, the supabase
    `noteCredentialsExpired` mapping). A new "when to bypass the kit" section names the known
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
- **Vite+ task nesting**: if `vitestTaskViteConfig('pnpm test:run')` misbehaves under vp's
  stripped environment, give the task the composed string
  `vitest run && vitest run -c vitest.worker.config.ts` directly, as
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
