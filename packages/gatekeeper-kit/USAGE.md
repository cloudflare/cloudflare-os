# Using `@gadgets/gatekeeper-kit`

The kit exposes independent modules through package subpaths. Import only the pieces the gatekeeper
needs:

```ts
import {
  CredentialCoordinator,
  CredentialSource,
} from "@gadgets/gatekeeper-kit/credentials";
```

The exported symbols carry their exact contracts in JSDoc. This guide covers the choices and
sequencing that span more than one symbol.

## Connect flows

These sequences compose Layer-1 leaves; the kit ships no connect assembly. The conformance account
in [`__tests__/workerd/conformance/gatekeeper.ts`](__tests__/workerd/conformance/gatekeeper.ts) is
the executable reference. Production gatekeepers stage and commit reconnects; GitLab also fences
each connect on its connection generation, as the variants below do, and GitHub does not yet.
`disposeMintIfSafe`, `revokeLiveGrantBestEffort`, and `toGrant`
are gatekeeper-owned placeholders, not kit exports; `client` is an `OAuthClient` (see
[OAuth token endpoint](#oauth-token-endpoint)).

Every browser connect flow must claim its OAuth nonce before exchanging the provider code. An
expired or replayed callback must not mint a grant. When the attempt advances to OAuth, store the
PKCE verifier and the exact redirect URI with it, and capture the account's connection generation
so a disconnect or newer connect cannot be overwritten during the exchange:

```ts
type ConnectAttempt = { codeVerifier: string; redirectUri: string; startedUnder: string };

const pkce = await createPkce();
const state = advanceToOAuth<ConnectAttempt>(kv, linkNonce, Date.now(), {
  codeVerifier: pkce.codeVerifier,
  redirectUri,
  startedUnder: this.#creds.connectionGeneration(),
});
if (state === null) throw new Error("This connect link has expired. Start again.");
const authorize = client.authorizationUrl({
  redirectUri, state, scopes, codeChallenge: pkce.codeChallenge,
});

const claim = claimOAuth<ConnectAttempt>(kv, oauthNonce, Date.now());
if (claim === null) throw new Error("This connect attempt has expired. Start again.");

const grant = toGrant(await client.exchangeCode({
  code, redirectUri: claim.redirectUri, codeVerifier: claim.codeVerifier,
}));
```

The handshake holds one OAuth nonce, so a second `advanceToOAuth` invalidates the first unclaimed
callback. A claimed attempt can still race with a connection change. Use `startedUnder` in the
matching initial or reconnect path below.

Decide which path an attempt takes when its link is minted, not when it is used: pass that intent to
`putInitiation` as metadata, which `advanceToOAuth` carries into the OAuth record (its own `extra`
wins a name clash) and `claimOAuth` returns. Inferring it at callback time from whether credentials
exist misroutes a reconnect whose account was disconnected meanwhile. Make the absent value the safe
one — record `firstConnect: true` from the connect entry point, so anything else, a link minted
before the field existed included, stages its grant as a reconnect.

### Initial connect

An initial connect may persist its complete grant in the new account before calling
`callback.complete(user, expiresAt)`. Fence that write, then return the handoff as the final browser
response:

```ts
try {
  this.#creds.connect(grant, { ifGeneration: claim.startedUnder });
} catch (error) {
  if (!isConnectionSuperseded(error)) throw error;
  await disposeMintIfSafe(grant);
  throw new Error("This account's connection changed. Start again.", { cause: error });
}

const handoff = await callback.complete(user, credentialsRefreshabilityExpiry);
return htmlResponse(connectHandoffPageHtml(handoff));
```

Without `ifGeneration`, `connect()` writes unconditionally. That remains appropriate for a pasted
token or form submission with no round trip to fence.

Call `complete()` at most once per account. Each call stages another Workshop ticket, and an
unredeemed ticket revokes the account, so a second call can destroy the connection the first made,
even one that threw or lost its reply. A flow that claimed a single-use nonce reaches `complete()`
once already. A flow whose link or form has no single-use nonce records the attempt: refuse when
`isConnectAttempted(kv)` (early, to skip provider work, and again where the live credential is
written), then mark it in that same synchronous section:

```ts
if (isConnectAttempted(kv)) return refuse();
this.#creds.connect(grant);
markConnectAttempted(kv);
const handoff = await callback.complete(user, credentialsRefreshabilityExpiry);
```

RPC rejection does not prove that `complete()` failed. Workshop may already hold a pending handoff,
or a sign-in may already have linked the account, so a blind rollback can delete credentials the
Workshop is about to activate. The kit has no mechanism for this. An account that keeps its grant
must decide locally when the flow is dead, clear it only if the credential identity it wrote is
still current, and apply provider cleanup only when that cannot invalidate an alias or successor.
Workshop revokes a staged connect whose ticket is never redeemed.

### Reconnect and `ensureResources`

A reconnect or resource expansion must not write the new grant live. Stage the complete canonical
grant together with the generation under which the flow started, report that exact stage, and wait
for Workshop to call `commitReconnect(stageId)`:

```ts
type ReconnectStage = { grant: Grant; startedUnder: string };

if (this.#creds.connectionGeneration() !== claim.startedUnder) {
  await disposeMintIfSafe(grant);
  throw new Error("This account's connection changed while reconnecting. Start again.");
}

const displaced = discardStagedCredentials<ReconnectStage>(this.ctx.storage.kv);
const stageId = stageCredentials(
  this.ctx.storage.kv,
  { grant, startedUnder: claim.startedUnder },
  Date.now(),
);
if (displaced !== null) await disposeMintIfSafe(displaced.grant);

const handoff = await callback.reconnectComplete(stageId, credentialsRefreshabilityExpiry);
return htmlResponse(connectHandoffPageHtml(handoff));
```

Workshop then calls the account's `commitReconnect(stageId)`:

```ts
const staged = commitStagedCredentials<ReconnectStage>(
  this.ctx.storage.kv,
  Date.now(),
  stageId,
);
if (staged === null) throw new Error("This reconnect stage is no longer available.");
const retired = this.#creds.stored();
try {
  this.#creds.connect(staged.grant, { ifGeneration: staged.startedUnder });
} catch (error) {
  if (!isConnectionSuperseded(error)) throw error;
  await disposeMintIfSafe(staged.grant);
  throw new Error("This account's connection changed. Start again.", { cause: error });
}
if (retired !== undefined) await disposeMintIfSafe(retired);
```

No account or resource read may use staged data. A mismatched stage id leaves the newer stage
intact; only an exact, live stage is consumed. Workshop owns the opaque completion ticket and passes
its recorded stage id to `commitReconnect`. The stage TTL controls how long the grant is committable.
The optional `expiresAt` passed to `complete()` or `reconnectComplete()` is a separate absolute
estimate of when the credentials stop being refreshable, not the access-token or stage expiry.

An RPC rejection from `reconnectComplete()` is ambiguous: Workshop may already hold the `stageId`, so
the stage must stay committable. Nothing expires it locally — `commitStagedCredentials` refuses it
once the TTL passes, but the record survives until the next stage replaces it.

`disposeMintIfSafe` belongs to the gatekeeper and must not throw. It revokes only when the provider
guarantees cleanup cannot invalidate live or successor credentials. For grant-wide revocation, it
is a no-op. Capture a live grant or stage before synchronous replacement, then dispose it only after
the successor is live.

Fence rejection reports too: carry the identity of the credentials used by an in-flight provider
call, and ignore its rejection after a successor is live.

Teardown captures first, clears locally, and only then awaits provider cleanup. A revoke or account
deletion clears everything the account owns:

```ts
const live = this.#creds.stored();
const staged = discardStagedCredentials<ReconnectStage>(this.ctx.storage.kv);
await this.ctx.storage.deleteAlarm();
await this.ctx.storage.deleteAll();
if (staged !== null) await disposeMintIfSafe(staged.grant);
if (live !== undefined) await revokeLiveGrantBestEffort(live);
```

`deleteAll` removes the stored Workshop callback, the expiry latch, and the provider keys a
selective sequence would miss, so both captures above must be synchronous and precede it. A provider
await placed before the local clear leaves `commitReconnect` a window to re-arm an account being
deleted.

A path that keeps the account clears selectively instead. Repointing a connection at a new endpoint
discards the stage, deletes the nonce, and calls `CredentialCoordinator.clear()`, leaving the
callback and the alarm in place.

`discardStagedCredentials` returns what it dropped and ignores the stage TTL, so an abandoned grant
is still reachable. A gatekeeper that will not keep an unconfirmed grant at rest can retain the
`stageId` under its own key, arm its own alarm, and pass that id back:
`discardStagedCredentials(kv, stageId)` drops only that stage, so a newer flow's stage survives the
cleanup its predecessor scheduled. No gatekeeper retains stage ids today, so that argument has no
consumer yet. The kit owns no cleanup protocol either. The marker, the alarm, and whether to call
the provider at all stay with the gatekeeper, and a dropped grant goes to `disposeMintIfSafe`, never
to the live keys.

`revokeLiveGrantBestEffort` is also gatekeeper-owned and must not throw. Use the provider's
connection-specific revocation when it has one. Omit remote revocation when the provider cannot
target this connection without invalidating a separate live connection; local teardown still
removes the Workshop's authority.

Neither helper may decide the RPC outcome. Not throwing is not the same as returning: bound the
provider call with `AbortSignal.timeout`, or hand it to `ctx.waitUntil` once the local write is
durable. Each disposal above sits on the path of a reply someone awaits, and `commitReconnect`'s
cannot be retried because Workshop spends the handoff ticket before calling it. A reply lost behind
a hung revocation leaves the new grant live while the account stays marked unrestored.

See [`docs/connect-handoff.md`](../../docs/connect-handoff.md) for Workshop's ticket, popup nonce,
and redemption protocol.

## Credentials

An OAuth-shaped provider needs both halves of the credential API:

- `CredentialCoordinator` owns storage, migration, refresh, and rejection adjudication in the
  account Durable Object.
- `CredentialSource` fetches those credentials over RPC and runs provider calls in a resource
  facet.

The `CredentialSource over a CredentialCoordinator` suite in
[`__tests__/credentials.test.ts`](__tests__/credentials.test.ts) is the executable reference.

### 1. Create the coordinator in the account Durable Object

Use the stable `ctx.storage.kv` object so refreshes coalesce across coordinator instances.
`discardMint` is deliberately absent: whether a fenced-out mint can be revoked without killing the
surviving connection is provider-specific — see "Revoke discarded token rotations" below.

```ts
#creds = new CredentialCoordinator<Grant>(this.ctx.storage.kv, {
  expiresAt: grant => grant.expiresAt,
  legacyKeys: ["accessToken", "refreshToken"],
  upgrade: kv => readLegacyGrant(kv),
  vendorId: VENDOR_ID,
});
```

`legacyKeys` is the deletion set, not only the migration input. List every key the old layout owned,
including expiry, scope, endpoint, and refresh-token keys. `clear()` deletes exactly this set, so an
omitted key leaves credential material behind after disconnect.

### 2. Expose the account RPC methods

Both methods stay thin because the coordinator owns the atomic credential, identity, and generation
triple, refresh fencing, and rejection verdicts:

```ts
#refresh = oauthRefresh<Grant>(this.#client, {
  refreshToken: grant => grant.refreshToken,
  merge: mergeOAuthTokens,
  expiredMessage: "Reconnect the Vendor account in the Workshop.",
});

async getCredentials(): Promise<CredentialsWithIdentity<PublicGrant>> {
  const { creds, identity, generation } = await this.#creds.snapshot(
    this.#refresh,
    { notify: () => this.#notify() },
  );
  return {
    creds: { token: creds.accessToken, expiresAt: creds.expiresAt },
    identity,
    generation,
  };
}

reportCredentialsRejected(identity: string) {
  return this.#creds.adjudicateRejection(identity, {
    refresh: this.#refresh,
    notify: () => this.#notify(),
  });
}

#notify() {
  const callback = this.ctx.storage.kv
    .get<Fetcher<GatekeeperConnectCallback>>("callback");
  return notifyCredentialsExpiredOnce(
    this.ctx.storage.kv,
    callback,
    VENDOR_ID,
  );
}
```

Project credentials before returning them. Refresh material must not cross the account RPC
boundary.

The refresh owns a classification the coordinator cannot make: throw `CredentialsExpiredError` only
when the provider proves the *grant* is dead. `oauthRefresh` carries that classification in its
`isGrantDeath` option, which defaults to `isInvalidGrant` — an RFC 6749 `invalid_grant` below HTTP
500, other than 429. A supplied predicate replaces that default, so widen it by composing,
`error => isInvalidGrant(error) || …`, and only for provider-specific evidence of the same, such as
a revoked refresh token reported another way. Key it on `oauthError`, not a bare status, which a
proxy or WAF page carries too. Let transport, malformed-response, and 5xx failures travel
unchanged, and never read a bare `invalid_token` as that proof: it is RFC 6750 for the presented
access token, which a refresh recovers. Treating either an outage or a recoverable token
rejection as grant death destroys healthy authority and prompts an unnecessary reconnect.

It also owes the *complete* canonical record, not the provider's response. Providers routinely omit
values that did not change — an unchanged rotating refresh token, granted scopes, provider metadata
— and the coordinator replaces the stored record wholesale, so anything absent is lost and the next
refresh fails after the first successful rotation. `mergeOAuthTokens` keeps those values but
replaces `expiresAt`, since a carried-forward past expiry would refresh on every read. A grant with
other provider-reported fields extends it, picking each field rather than spreading the response:

```ts
merge: (grant, tokens) => ({
  ...mergeOAuthTokens(grant, tokens),
  instanceUrl: typeof tokens.raw.instance_url === "string"
    ? tokens.raw.instance_url
    : grant.instanceUrl,
}),
```

Omit `adjudicateRejection`'s `refresh` callback when rejection of a current credential proves the
whole grant is dead. A heal cannot recover that provider model and would suppress the expiry
notification.

A provider-confirmed death is recorded against the grant's identity fence, so every later read —
in this facet or any other over the same storage — refuses it until a reconnect replaces it, even
while its access token is still inside its own expiry window. The grant itself stays stored, so
account-owned revoke keeps its material and a failed expiry notification can still be retried by
a later read.

Every credential replacement re-arms the expiry latch. This includes `connect()`, successful
refresh, and rejection healing. A legacy-layout migration does not re-arm it because it replaces no
credentials. `clearCredentialExpiryLatch` remains available for accounts that manage credentials
without `CredentialCoordinator`.

### 3. Run facet calls through `CredentialSource`

```ts
#creds = new CredentialSource<PublicGrant>({
  account: () => this.env.ACCOUNT.get(this.accountId),
  isAuthError: error =>
    error instanceof VendorApiError && error.status === 401,
  expiredMessage: "Reconnect the Vendor account in the Workshop.",
});

listProjects() {
  return this.#creds.run(
    grant => this.#api.listProjects(grant),
    { replayable: true },
  );
}
```

`isAuthError` classifies credential rejection only. Do not classify a per-resource 403 or 404 as an
authentication error; doing so can retire a healthy account.

Set `replayable: true` only when the operation may execute twice. Re-entry can repeat provider calls
that succeeded before a later call rejected the credential. Without that flag, stale rejection
surfaces as `CredentialsChangedError` instead.

### 4. Handle the credential errors

Handle two credential errors:

- `isCredentialsChanged(error)` means the operation used stale credentials. Re-enter a replay-safe
  operation or surface the error when replay is unsafe.
- `isCredentialsExpired(error)` means the provider proved the grant is dead. Tell the user to
  reconnect. Workshop notification was attempted separately and may have failed.

Let every other error travel unchanged, including account RPC failures. An unreachable account is
not an expired grant.

### 5. Revoke discarded token rotations

A provider that rotates refresh tokens should implement `discardMint`. A reconnect or revoke can win
while refresh is in flight, leaving the completed mint fenced out of storage. Revoke that grant at
the provider so no live credential chain remains without a stored handle.

Do this only where revoking the discarded mint cannot invalidate the grant the surviving connection
uses. RFC 7009 lets a provider treat revoking one refresh token as revoking the whole authorization
grant, so where a reconnect reuses one grant per (user, client) the disposal kills the connection
that just won. For such a provider omit `discardMint` and order refresh against connect and clear in
the account itself — the kit supplies no primitive for that.

Where it can, `discardMint` is `mint => client.revoke({ token: mint.refreshToken!, tokenTypeHint:
"refresh_token" })`. The coordinator awaits it inside the refresh single-flight, which the client's
`timeoutMs` bounds. The recipe assumes every refresh rotates. `mergeOAuthTokens` carries an
unrotated refresh token forward, so on a provider that may not rotate, the mint holds the token the
refresh started from: revoking it disposes of more than the mint, and kills a winner handed the same
token back. The mint added only a short-lived access token there, so such a provider omits
`discardMint`.

Errors from `discardMint` are logged and do not replace the winning operation. It cannot recover a
crash between provider rotation and storage; the user must reconnect in that case.

### 6. Declare each action's fence, and capture it from the operation's own read

`defineActions` requires a `fence` policy for the whole set, with `fenceOverrides` naming the kinds
that differ. It is required rather than defaulted because an omitted fence is invisible: the
gatekeeper works, its tests pass, and an action approved under one provider account later applies
under the next one.

```ts
defineActions(definitions, {
  fence: "authority",
  // Named one at a time, so opting out is always a decision someone made.
  fenceOverrides: { pingHealthEndpoint: "none" },
});
```

An `"authority"` kind must be staged with the authority the operation ran under. For the common
connection fence, that is the `CredentialRead` **the staging operation itself ran under**.
`CredentialSource.run()` passes it as the operation's second argument, and it is structurally an
`ActionFence`, so `{ fence: read }` works verbatim. `submit` refuses the call without one, and
refuses a fence on a kind declared `"none"`. The kit never interprets the value, so a provider that
wants an action to survive re-authorization of the same account stores its own stable account id
instead and passes that at apply.

The read has to be the operation's own. A second `read()` taken inside the submit path can land
after a reconnect and would pin old-connection data to the new connection — which is why the kit
cannot capture the fence for you.

Apply then compares whatever was staged, by opaque equality. For a connection fence pass
`apply(id, { generation })` from `CredentialSource.read()`; for a custom fence pass that same
stable value instead — a connection generation and an account id can never match, and an action
staged under one and applied under the other fails terminally on every attempt. That is an
entry check, so a reconnect may still land between it and the provider call. A handler that must
not run under a replaced connection compares `ctx.fence` with the `CredentialRead` passed to the
same `run` callback that issues the request.

## OAuth token endpoint

`OAuthClient` in `./oauth-client` makes the token-endpoint calls behind a connect flow and a
refresh: authorization URLs with PKCE, code exchange, refresh, and RFC 7009 revocation. Every
request refuses redirects, is bounded in time and size, and reports a rejection as
`OAuthResponseError`, whose message carries no provider text beyond a validated `error` code;
transport, abort, and oversize failures propagate unchanged. The `oauth-client with the connect
handshake and CredentialCoordinator` suite in
[`__tests__/workerd/oauth-client.test.ts`](__tests__/workerd/oauth-client.test.ts) is the
executable reference.

```ts
#client = new OAuthClient({
  label: "Vendor",
  client: { method: "basic", id: this.env.CLIENT_ID, secret: this.env.CLIENT_SECRET },
  authorizationEndpoint: "https://vendor.example/oauth/authorize",
  tokenEndpoint: "https://vendor.example/oauth/token",
});
```

- Pass `redirectUri` per call, from what the connect attempt stored. It is deliberately not client
  configuration: under `PreviewOAuth` it depends on the deployment, and the exchange must repeat the
  exact URI the authorization used.
- Pick fields explicitly. A `claimOAuth` claim also carries the nonce's own `value` and `expiresAt`,
  and `OAuthTokens.raw` is whatever the provider sent, so spreading either into a grant stores
  nonce or provider data as credentials. `OAuthTokens.expiresAt` is absolute epoch milliseconds,
  anchored at the request's start, and feeds `CredentialCoordinator`'s `expiresAt` unchanged.
- Only a refresh can prove grant death. `invalid_client`, `unauthorized_client`, `invalid_scope`,
  429, and 5xx are rethrown: with one static client they are operator or provider faults, and
  treating them as death would expire every user at once. A deleted dynamically registered client
  is the kind of evidence that justifies widening `isGrantDeath`. An `invalid_grant` answering
  `exchangeCode` is a failed connect.
- A response with no `expires_in` and a client with no `defaultExpiresIn` leave `expiresAt` absent,
  so the grant refreshes only when a rejection is adjudicated. A lifetime within the coordinator's
  `refreshSkewMs` refreshes on every read.

When a provider does not fit, step down one rung at a time:

1. `oauthRefresh` with `mergeOAuthTokens`.
2. The client's own methods, with `params`, `headers`, and `bodyEncoding`, plus
   `searchParams.append` on the returned authorization `URL` for a repeated parameter. They classify
   nothing, so the caller decides which failures prove grant death, composing `isInvalidGrant`.
3. `client.request()` with `parseTokenResponse`, for a request or response shaped outside RFC 6749
   (Slack nests user tokens under `authed_user`). `request()` reserves no parameters and does not
   require an `access_token`; the parser does.
4. A native `RefreshCredentials<Grant>`, keeping every other leaf. A non-RFC revocation, such as a
   JSON body or a `DELETE`, stays hand-written.

## Storage

### Name the narrowest surface

Each module accepts the structural KV surface it needs (`KvReadWrite`, `KvMutable`, or
`KvScannable`) instead of `DurableObjectStorage`. The signature records whether the module can read,
write, delete, or scan. It also keeps pure modules testable against a plain object.

### Pass stable storage objects

Pass the same `ctx.storage.kv` object on every access. Credential refreshes, expiry notifications,
and observer claim counts key process-local coordination by storage-object identity. Wrapping the
storage for every call defeats coalescing and can spend a single-use refresh token twice.

That identity requirement is also why the kit's stateful objects are Durable-Object-local. A
journal, gate, cache, coordinator, source, or tracker is built inside the object that owns its
storage and never crosses an RPC boundary — attempting it fails with `DataCloneError`. Expose RPC
methods instead, and return either plain data or a cursor: `ArrayCursor` and the provider-backed
cursors extend `RpcTarget` precisely because they are the one kit type meant to be handed out.

### Name every keyspace

`ActionJournal` takes a `namespace` and `KvTtlCache` a `name`; both derive every key from it. Two
journals sharing a keyspace share ids and capacity while each bound action set serializes apply and
reject on its own in-memory queue, so nothing orders their provider calls against each other. Two
caches sharing one serve each other's values for colliding keys, and either one's `invalidateAll()`
clears both.

### Treat storage layout as compatibility

Shipped key names and prefixes are compatibility surfaces. Renaming one silently orphans live
records. A port that must keep reading records it already wrote passes `legacyKeys` (journal) or
`legacyUnnamed` (cache) instead of a namespace — mutually exclusive with it, so the unsafe shared
layout is always an explicit choice. `ObserverTrackerOptions` has its own key options for the same
reason.

### Fake the surface, not the runtime

A Node test double can be a small object implementing the required KV methods. Transactional tests
can add the synchronous transaction surface:

```ts
const storage = {
  kv,
  transactionSync<T>(callback: () => T): T {
    return callback();
  },
};
```

Persisted RPC stubs, `RpcTarget` behavior, and `crypto.subtle.timingSafeEqual` need workerd tests.
Those suites live under [`__tests__/workerd/`](__tests__/workerd/) and load
`@gadgets/scripts/assert-workerd`, so a failed Workers pool cannot pass silently in Node.

## Caching

Give each `KvTtlCache` a `name`, which gives it its own keys and generation.

`partitionedBy` asks the source for a live connection fence on every hit, so a reconnect
repartitions before the next hit rather than at the next provider call. That costs one account
credential read per hit — which may itself run a normal credential refresh — and still avoids the
provider request the entry exists to cache. A disconnected account propagates its own error; a
source that cannot vouch for the credentials bypasses the cache. Compose an authority on the raw
constructor only where it is genuinely local.

Use `cachedMany` when the provider answers many keys in one request. Fresh entries are served,
keys another caller is already loading are joined, and the rest reach the loader together; each key
is then stored and fenced as `cached` stores it, so a later batch of a different shape reuses them.
Pass the provider's per-request limit as `batchSize` rather than splitting keys inside the loader:
the cache cuts batches from the missing keys alone, loads them one at a time and stores each as it
returns, so a failing request keeps what the requests before it learned. A loader that throws
stores nothing. Use `cached` for a key answered by a request of its own.

Either method takes its TTL as a function of the cached value instead of a number when some answers
deserve trust for longer than others, such as an access check that keeps a grant longer than a
denial. It is asked each time an entry is consulted, so changing it applies to entries already
stored.

## Actions and files

Use `defineActions` and `stageAction` for externally visible side effects. They own the
submit, approve, apply, and retire lifecycle, including retryable versus terminal failure,
dependency stranding, and connection fences.

Every definition declares a `kind` and an `autoApprovable` verdict: `true` unless the
`write-gatekeeper` skill's opt-out policy applies
([Action kinds and auto-approval](../../.agents/skills/write-gatekeeper/SKILL.md#action-kinds-and-auto-approval)).

`retainApplied: true` opts out of retirement: applied records move to a retained tier the kit never
bounds. Enforce the binding's retention policy inside `runExclusive()`: walk storage-bounded pages
with `journal.listRetained({ limit, cursor })`, pass each `nextCursor` back until it is absent, and
call `journal.retire(id)` for each expired record.

An apply failure has three outcomes, and the handler picks by what it throws. An ordinary error is
retryable: the record returns to pending and the overseer may apply it again, so use it only when a
second attempt is safe. `ActionApplyError` is terminal and asserts the provider effect is **known
absent** — it retires the dependents waiting on references this action was to provide.
`ActionOutcomeUnknownError` is terminal and asserts nothing: use it for a timeout, an aborted
request, or any failure after the provider was reached. That record is never replayed and never
pruned, and holds a slot until the user rejects it, so the "check the provider" warning survives.
It strands no dependent until then; rejecting it retires those whose references it never bound.

`claimBeforeApply` produces that same unknown outcome when an activation dies mid-dispatch. Neither
substitutes for a provider idempotency key derived from the stable `ActionContext.id`, which is
what makes a retry safe in the first place.

Rejecting always withdraws the action, whatever its outcome at the provider: the gatekeeper stops
tracking it, and an effect that already landed stays. So a `reject` hook is cleanup only and must
not refuse because the outcome is uncertain; one that throws is logged and the record removed anyway.

`submit` refuses a payload whose `dependsOn` names a reference that is neither resolved nor
provided by a pending or claimed action: once its provider was rejected or failed, every apply
would fail retryably, and an auto-approvable one would stall the drain behind it. A provider
decided while the dependent was being delivered fails it instead, as the cascade would have.

### Describe with `buildDescription`

Write `describe` with `buildDescription` from `@gadgets/gatekeeper-kit/action-description`. The
approver vouches for the text they read, so every piece of content the action will send that came
from the workspace — a body, a field value, an identifier, serialized arguments — goes in a field
(`inline`, `verbatim`, `json`, `list`, or `file`). Fields travel as `ActionDescription.fields`,
which approval surfaces show as literal text, so nothing in a value renders as Markdown. A value a
field cannot show exactly, such as one with invisible characters, is shown as escaped JSON instead.
Prose is for the gatekeeper's own summary: never interpolate agent- or provider-supplied text into
it, since such text can open an HTML block the chat hides. Put the value in a field, or pass a mere
label through `codeSpan` or `plainInline`. Spread `finish()` into the presentation and never set
`descriptionIsComplete` by hand: the builder sets it only when every field was shown in full under
its 96 KiB budget, and leaves the key off after truncating or omitting one, or when prose alone
overflows it. An incomplete description is still submitted, and the approver is told part of the
action isn't shown.

```ts
describe: payload => ({
  title: `Comment on issue ${payload.issueId}`,
  ...buildDescription("Posts a comment on an issue.")
    .inline("Issue", payload.issueId)
    .verbatim("Comment", payload.body)
    .finish(),
  implementsRevert: false,
}),
```

Bytes the approver cannot read as text — an agent-supplied file, git objects — cannot be complete.
Name a file with `file(label, {name, mediaType, size, sha256, origin})`: `origin: "agent"` leaves
the flag off, while `origin: "provider"`, for bytes re-sent unchanged from the same provider such as
a forwarded attachment, keeps it on.

Store action file bytes with `ActionFileStore`. Put only the bounded `ActionFileReference` in the
action payload. Journal records must stay small, and approval text must describe the same bytes that
will be applied.

Release those bytes yourself — the kit never collects them, and every capture counts against
`maxTotalBytes` until it is deleted. Call `delete(reference)` when the action's record goes away:
on resolution normally, but only when `journal.retire(id)` removes an expired retained record under
`retainApplied: true`, since that record is what a revert reads back. Sweep orphans with
`pruneUnreferenced(referenced, createdBefore)`
before a new capture, passing every handle your pending **and retained** records name, plus a cutoff
old enough to spare a capture whose submission is still in flight. An orphan outlives a rejected
action, a terminal failure, and a capture whose `submit` never landed; without a sweep they
accumulate until the cap refuses every new file-backed action.

A declaration using `delivery: "continue-with-simulation"` must project pending actions onto later
reads. Use `createSimulationView`, `replaySimulation`, and `ProvisionalIds` for that projection and
for mapping provisional IDs to provider IDs.

## Observations

Every method that returns information to its caller must await `authorizeObservation()` before
returning it: fetch, authorize, return. That includes provider data (anything that came from the
provider's API, fetched now or cached earlier), values derived from it, and simulated state.
Report all access dependencies as explicit `subresources`, and keep observer authorization in
`verifyObserverAccess()`. [Simulated reads](#simulation-and-subresources) report the same IDs.
Do not build observer rosters, observed-set logs, `excludeObservers`, or legacy trackers for new code.

The shared `ObservationDescription.subresources` property is still optional for compatibility.
Require it locally with a typed helper:

```ts
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { escapeObservationValue } from "@gadgets/gatekeeper-kit/observers";
import { formatSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";

type ExplicitObservation = ObservationDescription & { subresources: string[] };

// Session helper; this session owns its approval-queue stub.
async #authorizeObservation(description: ExplicitObservation): Promise<void> {
  await this.#queue.authorizeObservation(description);
}

async getPage(id: string) {
  const page = await this.#api.page(id);
  const title = escapeObservationValue(page.title);
  await this.#authorizeObservation({
    title: `Page: ${title}`,
    description: `Read page **${title}**.`,
    subresources: [
      formatSubresourceId({ fragments: [{ name: "workspace", id: page.workspaceId }] }),
      formatSubresourceId({ fragments: [{ name: "page", id: page.id }] }),
    ],
  });
  return project(page);
}
```

Here the workspace ID requires current workspace membership, and the page ID requires permission to
read that page's disclosed content. The verifier must check both; a binding or connection does not
implicitly establish either. Report any additional role, tenant, or parent-resource dependencies
the returned data requires, using real resource IDs whose verifier semantics enforce those requirements.

Run every provider-controlled string through `escapeObservationValue()` first. It collapses
newlines and escapes Markdown controls, so a title cannot forge structure in the observation text.
Nothing automatically intercepts a session's return value: skipping authorization leaks unaudited
data. Cached reads, nested resource capabilities, cursor pages, and hook deliveries have the same
obligation. Hooks authorize through the fresh queue from `startHook()` before invoking the callback;
derive requirements from current binding state, not fields absent from older persistent hook props.

### Simulation and subresources

Simulation doesn't change what a read reports:

- A simulated read reports every real resource its data came from, in the provider's current
  (unapplied) state, plus every container the simulated view places it in. A pending move from P
  to Q reports both until it applies.
- Provider data stored in pending-action state (previous values, copied or quoted content) keeps
  its source's IDs when replayed.
- Pending permission changes (sharing, visibility, membership) never relax what a read reports.
  `verifyObserverAccess()` checks live provider state only, never simulated state.
- Only content that never came from the provider adds no IDs: action arguments and provisional IDs
  you generated. A read returning only such content still authorizes, reporting `[]` plus any
  container or account requirement.
- Do not invent IDs for pending actions or simulated resources.

While a Workshop `createExternalResource` creation is pending, the kernel records nothing its
simulated reads report (`docs/observers.md` §10), so that resource must hold no provider data.

Keep pending-action and cached state in the connection's facet storage, never in the account
Durable Object or anywhere else shared across connections: requirements are recorded per
connection. Within one connection, every chat and gadget reads that shared state. Authorize each
read through the reading session's own approval queue, never one captured when an action was
submitted or stored on the facet: that queue attributes the read to its chat or gadget. Never assume
the reader already received what it replays. Re-reporting adds no admission work, since admission
reads distinct requirement keys, though each read still checks its own audience.

Content one chat writes into a pending action reaches every other chat and gadget on the connection
before anyone approves it, with no requirement, and stays disclosed if the action is rejected. A
chat's audience is its "build" collaborators while a gadget's includes "use" collaborators, so text
a chat quotes from a resource checked only against "build" collaborators can reach "use"
collaborators this way. The kernel accepts this as indirect disclosure (`docs/observers.md` §10):
approval gates what reaches the provider, not what other contexts in the workspace see.

### New-gatekeeper observer contract

New gatekeepers follow these rules, although the current interface and its JSDoc still describe the
legacy observer methods:

- Every read that returns information to its caller explicitly reports all its dependencies, even
  ones an earlier read already reported, simulated reads included. Workshop records requirements
  per chat or gadget, not per binding.
- `[]` adds **no requirement**; requirements already recorded stay in force. It never means a
  binding/admission baseline was already checked. Report membership requirements explicitly; when
  any account on a deployment-fixed service instance may read everything returned, use
  [`GLOBAL_SUBRESOURCE_ID`](#connection-only-access-global), not `[]`.
- Private-only reads report the actual mailbox, account, document, or other resource ID;
  `verifyObserverAccess()` denies observers who may not read it. Neither `[]` nor a synthetic
  `private` policy marker expresses that requirement.
- Implement `getHistoricalSubresources(): Promise<string[]>` returning `[]`, read-only and with no
  tracker. It is required even though the current interface does not declare it, so type-checking
  will not catch its absence.
- Implement `addObserver(id, verifier)` and `removeObserver(id)`, which the current interface
  requires, as compatibility-only no-ops. Keep `getVerifier()` so Workshop can obtain each
  observer's provider-side verifier.

Use `observerAccessVerifier` without creating a tracker:

```ts
import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";

#verify = observerAccessVerifier<MyVerifierApi>({
  hasCollectionAccess: (verifier, ids) => verifier.canAccess(ids),
});

async verifyObserverAccess(
  observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
  subresources: string[],
) {
  return this.#verify(observers, subresources);
}

async getHistoricalSubresources(): Promise<string[]> { return []; }
async addObserver(_id: string, _verifier: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
async removeObserver(_id: string): Promise<void> {}
```

`hasCollectionAccess` is the helper's existing option name; its IDs are subresource requirements,
not a tracked collection set. The provider's `canAccess` must validate IDs, reject unknown kinds,
and check every requirement with the observer's own account, including membership and private-only
restrictions. Throw when access is indeterminate (expired credentials or a provider outage).
The helper stores no verifier or observer-ID verdict: each call uses the supplied verifier,
since an observer may reconnect with another account.

An existing `ObservationGate` converts a read with
`gate.authorize(description, { kind: "subresources", ids })`. This scope only reports the IDs:
it prepares no legacy state, exclusions, or fences. New code needs no gate: its constructor demands
one of the legacy strategies below, and the typed helper above does the same job.

### Choosing reporting and verification strategies

There is one new-authoring protocol, but several **strategies for choosing requirements and checks**.
Keep the [`write-gatekeeper` skill's](../../.agents/skills/write-gatekeeper/SKILL.md#choosing-a-strategy-per-resource-type--binding)
A–D framing; choose per disclosure, not once for an entire provider or even a session. These letters
are not the legacy admission strategies of the same letters in
[`docs/observers.md` §9.1](../../docs/observers.md#91-strategies) (where C is data-set tracking and D
is a no-op), which existing code comments may still cite.

| Strategy | Report | Verify |
| --- | --- | --- |
| **A — Private-only / account identity** | The actual mailbox/account or other private resource. | Deny collaborators, or require the same provider identity if that is the intended policy. |
| **B — One access-controlled unit** | The resource whose information is disclosed, including an empty answer about it. | Access sufficient for all disclosed fields, not merely existence or public metadata. |
| **C — Multiple access-controlled units** | Every independently required resource: returned items, query sources, and required containers or memberships. | All requirements, not any one of them; a parent ID does not imply child access. |
| **D — Unrestricted disclosure** | `[]`. | No provider-side access requirement applies to this answer. |

Keep **grant scope**, **disclosure dependencies**, and **oracle strength** separate. Labels, search
filters, and table/folder bindings limit what a caller may request; they do not necessarily define
sharing ACLs. A narrow binding can report a coarser resource when its oracle genuinely covers the
disclosure. A broad binding can mix private discovery (A), shareable resource reads (B/C), and local
configuration echoes or source-free computations (D). Observer verification does not replace the
session's own scope enforcement.

Design these variants explicitly:

- **Different information classes on one object.** Metadata, content, private fields, and availability
  can have different audiences. Use real resource kinds with distinct verifier semantics where
  necessary, rather than collapsing everything to "can open object" or adding synthetic policy IDs.
- **Account-wide discovery versus item access.** Knowing each returned item is readable need not
  authorize the owner's personal list, membership, or caller-specific metadata. Report an account
  requirement too when those are private. Distinguish the operator's configurator API from data
  returned to a Gadget session; a picker method is not automatically a session observation pattern.
- **Derived results.** Report the source footprint, not just objects present in output rows. Obtain
  dependencies from trustworthy provider analysis where available; request text alone may not reveal
  everything a query reads. Deduplicate, but retain dependencies for zero-row and cached answers.
  A source-free result is D only if it has no other restricted input or context.
- **Hierarchy and compound requirements.** A folder/list may control enumeration while individual
  children have independent ACLs. Report both where needed, including the container for an empty
  listing. Coarsen to one parent only with a provider guarantee that the observer can see everything
  disclosed; neither URL nesting nor common ownership proves that.
- **Empty and failed results.** "No rows" is not "no dependencies": absence, filtered membership,
  counts, and aggregates can be restricted. Conversely, a failed item lookup that discloses no
  protected information need not report that item. Decide from the complete returned answer,
  including errors and auxiliary metadata; do not mechanically add or remove a parent ID.
- **Stable identity.** Resolve or reject `me`, `primary`, personal `root`, mutable names, and similar
  account-relative selectors before reporting them. Canonical escaping is not identity resolution.
  Re-check the same real resource with the observer's account; never resolve an owner's alias to
  the observer's unrelated resource.

Choose the access oracle to match the information class. Metadata access does not establish content,
table-row, or private-field visibility, and a mutation role is not inherently the right read check.
An account-identity comparison can implement a private policy; it is not a delegated-resource ACL
probe. If no adequate oracle exists, choose A, not D. See the worked patterns below for real examples
and limits of the existing implementations.

### Connection-only access (`global`)

Use `GLOBAL_SUBRESOURCE_ID` only when the deployed Worker's configuration fixes the one service
instance every account of this vendor connects to, and any account connected to it may read
everything disclosed. This is strategy B, not unrestricted D (`[]`). Per-resource ACLs, per-user
roles or scopes, and private account data in the answer disqualify it.

`"global"` names no instance; the deployment supplies its meaning. When accounts choose their
instance (a self-hosted URL, a cloud or site ID, an Access team domain, a directory tenant), report
a structured instance ID instead, such as `instance/<stable instance id>`, and have the oracle
compare it with the observer's own instance. The [tenant identity](#subresource-ids-name-resources)
rules apply: repointing a deployment that has recorded `"global"` requires an explicit migration.

For example, a catalog whose origin is fixed in the Worker's `env`, behind one Access policy that
grants instance-wide read access, can offer project/item bindings without separate sharing ACLs.
Each read reports the same requirement:

```ts
import { GLOBAL_SUBRESOURCE_ID } from "@gadgets/gatekeeper-kit/subresource-ids";

await queue.authorizeObservation({
  title: "Read project catalog",
  description: "List projects from the connected catalog.",
  subresources: [GLOBAL_SUBRESOURCE_ID],
});
```

Report it on every read that returns information, including empty results, cache hits, cursor
pages, simulated reads, and hooks. Bindings still enforce their project/item scope; observer access
does not expand the caller's grant.

The observer's verifier delegates to its own account. Because every account here connects to the
`env`-fixed origin, the account's oracle needs only its own grant, using `getCredentials()` from the
[credential sequence](#2-expose-the-account-rpc-methods):

```ts
async checkSubresourceAccess(ids: string[]): Promise<boolean[]> {
  if (ids.some(id => id !== GLOBAL_SUBRESOURCE_ID)) {
    throw new Error("Unknown subresource ID.");
  }
  // Throws when the grant is expired, dead on refresh, or disconnected.
  const { creds } = await this.getCredentials();
  // A live grant with narrower scopes or role than the owner's is a definite denial.
  return ids.map(() => grantCoversCatalogReads(creds));
}
```

`getCredentials()` refreshes only when the access token expires, so this oracle notices an
observer's removal from the instance no sooner than that: within one token lifetime if refresh
re-evaluates access, and never for a credential that does not expire. If that window is too long,
add one identity call with the observer's credentials, not a probe per object. Credential failures
must throw. Document the window you accept.

Compare the sentinel directly before `parseSubresourceId()`, which rejects it. The kernel treats
it as an ordinary requirement, not a wildcard or automatic grant. It cannot replace independent
membership or resource checks. Existing gatekeepers must still follow the
[historical-enforcement migration rules](#existing-code-migration-only-preserve-historical-enforcement).

### Worked patterns from the Google migrations

These examples were audited against the merged migration PRs, including their implementations and
review discussions. They highlight design lessons; the per-binding decision table in
[`docs/observers.md` §9.2](../../docs/observers.md#92-decision-table) is authoritative for each
binding's current IDs and checks. IDs below are schematic: use `formatSubresourceId()` to escape
provider IDs, not string interpolation.

| Resource / disclosure | Strategy and requirements | Observer oracle / important boundary |
| --- | --- | --- |
| **Calendar metadata and events** ([#980](https://github.com/cloudflare/cloudflare-os/pull/980), `GoogleCalendarSessionImpl`) | B: `calendar/calendar/<calendarId>`, including empty event windows. Event IDs are unnecessary because the calendar determines visibility. | The observer's calendar-list role must include private-detail visibility (`owner` or `writer`); `writerWithoutPrivateAccess` or `reader` is not equivalent to the owner's full disclosure. |
| **Calendar availability** (same PR) | A separate information class: `calendar/freeBusy/<calendarId>` for each successful result, even one with no busy blocks. `allVisible` can span foreign calendars (C) without granting their event details. | Query free/busy with the observer's credentials, not the event-detail role. Failed per-calendar lookups contribute no successful availability requirement; assess their error information separately. Account-relative `primary` is refused. |
| **BigQuery project/dataset/table grants** ([#983](https://github.com/cloudflare/cloudflare-os/pull/983), `BigQuerySessionImpl`) | C: `bigquery/project/<projectId>/dataset/<datasetId>` for every dataset in provider dry-run `referencedTables`, deduplicated across joins. The same dataset unit is used under narrower table grants; table listings keep it even when empty. | Scope validation and read-only SQL checks are separate from observer access. **Existing limitation:** `datasets.get` proves metadata access, not table-row or row/column-policy equivalence. Copy dependency derivation, not this probe as proof of query-result access. |
| **Gmail mailbox, label, or search grants** ([#984](https://github.com/cloudflare/cloudflare-os/pull/984), `gmail.ts`) | A: every read, cursor page, nested message/attachment capability, and hook reports `gmail/user/<Google-sub>`. A label or search narrows authority, not the mailbox's sharing ACL. | Compare the observer's stable provider subject to the mailbox owner. This is a private-identity policy, not delegated-mailbox ACL verification or a probe of current Gmail content scopes. |
| **Chat account versus conversation/thread** ([#985](https://github.com/cloudflare/cloudflare-os/pull/985), `chat.ts`) | Account binding: A, `chat/user/<Google-sub>` on **all** reads, including discovery, nested capabilities, and hooks. Conversation/thread content: B, `chat/space/<spaceId>`, including empty pages. Member reads instead use `chat/spaceMembers/<spaceId>`. | Identity for account reads; `getSpace` for space visibility; `listMembers` for the independently protected member list. Space-level reporting relies on filtering out app-private messages with narrower audiences. |
| **Direct Docs / Sheets / Slides** ([#986](https://github.com/cloudflare/cloudflare-os/pull/986), `google.ts`, `sheets.ts`, `slides.ts`; IDs from `file-subresources.ts`) | B: `docs/document/<id>`, `sheets/spreadsheet/<id>`, or `slides/presentation/<id>`. Tabs, ranges, slides, notes, thumbnails, and cached or simulated reads report the whole file. | Open the corresponding native file with the observer's credentials. Read visibility, not edit permission, is the intended check. Do not invent range/tab ACLs when the provider shares the whole file. |
| **Drive account discovery and exact file** (same PR, `drive-session.ts`) | Account list/search: C, `drive/file/<id>` per returned metadata row, including folder rows. Exact-file reads/listings: B, the bound file ID even if a trashed item is omitted. | File visibility uses the observer's Drive grant and a batched `files.get` metadata lookup. This implementation deliberately treats an empty account-wide list/search as `[]`; that is a disclosure policy, not a general rule for absence. |
| **Drive positioned folder / descendant native reads** (same PR) | C: current `drive/folder/<id>` plus each returned child `drive/file/<id>`; opening a child folder reports both folder IDs. Searching selected child folders retains all searched folder IDs even with no hits. Folder-derived native reads carry folder + file + native-product requirements on every read. | Folder enumeration requires a live Drive folder with `capabilities.canListChildren`, not merely metadata visibility. The caller's live ancestry checks separately prevent moves, shortcuts, or foreign IDs from escaping the grant. A selected shared-drive root is a concrete folder, not a new shared-drive observer kind. |

Several details prevent overly broad recipes:

- **The origin binding matters.** Whole-account Chat replaces child-space requirements with the
  owner requirement, so opening a child capability does not turn a private account binding into a
  shareable conversation grant. Drive account/file native reads first authorize Drive metadata, then
  report the native file on content reads; folder-derived reads retain the additional folder/file
  guard requirements. Preserve the originating authorizer and scope in child capabilities.
- **Derived versus source-free answers.** BigQuery queries keep all referenced datasets for zero-row
  or cached results. A project-ID echo and an accepted tableless query report `[]`; a narrow
  dataset/table binding rejects tableless SQL when it cannot prove scope. Empty project-level dataset
  discovery also currently reports `[]`, unlike an empty table list within a dataset. Explain the
  policy before copying any of those empty cases.
  A Docs/Sheets/Slides resource not created yet, built only from caller-written content, also
  reports `[]`. Simulation over an existing file still reports that file; see
  [simulation and subresources](#simulation-and-subresources).
- **Private versus shareable discovery.** Chat account discovery is private even when its returned
  spaces have individual ACLs; Drive discovery reports each returned file instead.
  Inspect the entire response, including personal read state and membership, rather than deciding
  that every list is private or that every list is covered by returned-item IDs.
- **Permission strength still needs review.** Drive PDF reads use `drive/file/<id>`, whose
  oracle establishes metadata visibility, not download permission. That does not prove equivalent
  PDF-content access. BigQuery's metadata-only probe has the analogous table-data limitation
  ([review discussion](https://github.com/cloudflare/cloudflare-os/pull/983#issuecomment-6619477652)).
  Do not treat either implementation as a permission-complete content-access template.
- **Authorization machinery is reusable; migration quirks are not.** Calendar uses a typed read
  helper, Gmail decorates a shared queue with its mailbox requirement, and the Chat account queue
  enforces its account policy across child reads and hooks. Reuse those ways to avoid omissions.
  Do not copy Drive's one-time `directParentId` parent check when a cursor is created (`#assertParent`)
  as a substitute for complete dependencies on each page, or eagerly seed requirements merely because
  a binding exists.

The Google migrations retain legacy admission/history checks but do **not** implement the
required `getHistoricalSubresources()` export. They illustrate reporting and oracle design, not a
complete history migration or permission to use empty history in an existing gatekeeper. Follow the
new-authoring contract or the existing-code migration rules below, as appropriate.

### Existing-code migration only: preserve historical enforcement

Do not apply the new-gatekeeper empty-history/no-op admission recipe to an existing binding.
Preserve old binding-wide checks, private restrictions, observed sets, stored verifiers, and
admission enforcement until every affected read is converted **and a shipped kernel importer has
committed all actual historical access requirements to the observer ledger**. Export those real
requirements through `getHistoricalSubresources(): Promise<string[]>` as a complete, conservative
array. The current kernel does not
call this export; the importer is still deferred in
[`plans/kernel-observer-tracking.md`](../../plans/kernel-observer-tracking.md#deferred). Implementing
a complete exporter alone does not protect past disclosures or justify retiring legacy checks.

The exporter must return a valid subresource array for every supported legacy state. Missing granular
history is not an intentional error path: return broader real resource IDs whose verifier checks
preserve all historical access restrictions. A parent/container ID works only if its check covers
every possible historical child disclosure; otherwise fall back to an account-private resource whose
verifier denies collaborators. If no existing resource kind safely expresses that fallback, define
one and its verifier as part of the migration. Keep the export deduplicated, read-only, and repeatable;
never truncate history. Return `[]` only when no historical access requirement applies, not because
history is unknown. Unexpected storage or runtime failures must propagate rather than be converted
to an empty or incomplete export.

Legacy `privateObservers`, `aclObservers`, `trackedCollectionObservers`, and `openObservers`, and
the `baseline`, `collections`, and `withholdFromObservers` scopes, exist for maintaining and
migrating existing code, **not as alternate strategies for a new gatekeeper**. A converted read uses
`subresources` with all requirements, including any baseline previously enforced at admission.
Unconverted paths must retain their legacy protections.

Useful legacy operational constraints:

- `verifyBaseline` and `aclObservers.hasAccess` run at admission, not on every read. A legacy
  `baseline` scope does not recheck provider revocation. Never translate it into `subresources: []`
  when the read actually depends on membership or another ACL.
- Only `trackedCollectionObservers` supports per-read collection ACL checks. `collections` is refused
  with `aclObservers` or `openObservers`; `privateObservers` accepts it because it admits nobody.
  An empty `collections` list is refused. Do not weaken a read to `baseline` to evade these checks.
- Persisted verifier stubs require `allow_irrevocable_stub_storage`; without it, a legacy tracker's
  first `addObserver()` fails with `DataCloneError`. Preserve existing keys and verifier lifetimes
  while historical enforcement still needs them; do not introduce that storage for new gatekeepers.
- An existing gate owns its duplicated authorizer stub and must be disposed. A session holding an
  action queue and a gate over `queue.dup()` releases both; a gate lease owns an independent dup.

### A cursor authorizes everything it hands out

A provider-backed cursor returns provider data from `next()`, so it carries the same obligation. The
session cannot discharge it up front: the pages do not exist yet, and one `next()` may be served
from the buffer with no provider fetch at all. Pass `authorizePage`, which the cursor calls with the
exact page it is about to return:

```ts
// The walk owns a duplicate so it can outlive the session's approval-queue stub.
const walk = this.#queue.dup();
const authorizePage = (description: ExplicitObservation) => walk.authorizeObservation(description);
const workspaceResource = formatSubresourceId({
  fragments: [{ name: "workspace", id: this.#workspaceId }],
});
return new TokenCursor<Project>({
  pageSize: 50,
  dispose: () => walk[Symbol.dispose](),
  fetchPage: (token, perPage) => this.#api.listProjects({ cursor: token, limit: perPage }),
  authorizePage: (projects, { terminal }) => authorizePage({
    title: "Projects",
    description: projects.length > 0
      ? `Read ${projects.length} projects.`
      : terminal
        ? "Listed the projects; there were none."
        : "Scanned a window of projects; none were visible.",
    subresources: [
      workspaceResource,
      ...projects.map(project => formatSubresourceId({
        fragments: [{ name: "project", id: project.id }],
      })),
    ],
  }),
});
```

`dup()` needs a real `RpcStub`: the overseer hands one over, but a stub reached through a service
binding cannot be duplicated, since `dup` is reserved over RPC.

This listing requires workspace membership even to learn that there are no projects, so every
page retains the workspace resource. The oracle checks membership for that ID and each project's
read ACL. If a tenant or restricted parent controls absence or listing visibility, report that
resource too, including on empty pages. Use `[]` only if the answer has no observer-access
restriction at all. The same requirements accompany cached and buffered pages, not only fresh fetches.

Every page is authorized, including an empty one from a spent fetch window. So is the end of a walk
that disclosed nothing: `searchUsers(email) → no matches` answers a question about provider data,
and letting that reach the gadget unaudited turns the cursor into an existence oracle. A walk that
already returned a page does not re-authorize its `null`, and exhaustion is authorized at most once.

`terminal` changes the empty-page description, not whether access dependencies are reported.
Every outgoing page names all requirements for that disclosure, even if earlier pages named them.
Do not drop a membership or parent-resource requirement just because `projects.length === 0`.

A refusal holds the outgoing page, so the retry re-offers its rows with no further provider
fetch: a page the provider capped short cannot grow between the refusal and the retry, which would
hand the approver something larger than what they refused. An empty page from a spent window is the
exception — nothing was disclosed, so the retry opens a fresh window rather than pinning the walk
on a failure that may have been transient. A refused zero-result answer is likewise re-offered.
`ArrayCursor` takes no callback: the session that assembled its items authorized them as one read.

That hold is also why a walk pinned to a connection must re-check its authority in
`authorizePage`, not only in `fetchPage`. The retry never re-enters the fetch, so a reconnect
landing between the refusal and the retry would otherwise disclose the previous connection's rows
under the new one. Compare against a read taken now — a value captured earlier names the
connection the walk opened under, not the current one:

```ts
const opened = await this.#creds.read();
return new TokenCursor<Project>({
  authorizePage: async (projects, { terminal }) => {
    if ((await this.#creds.read()).generation !== opened.generation) {
      throw new Error("This walk was started under a connection that has since been replaced.");
    }
    await authorizePage({ /* the explicit-subresource description above */ });
  },
  // …
});
```

### Merge simulated rows with `inject`

Rows the gatekeeper's own simulation adds to a listing — a branch a queued push will create, a
commit queued for push — go in `inject: { items, compare, revalidate?, identity? }` rather than a
wrapper cursor, so they share the walk's serialization, fetch bound and refusal hold. Each injected
row is served before the first provider row `compare` places it at-or-before, and the rest after the
last page. They are not provider rows: they never reach `authorizePage`'s `items`, and a page
made only of them is not authorized, so do not inject anything the provider supplied. Their
position still says a little — an injected row served first means no fetched provider row sorts
ahead of it — so a listing whose order is itself sensitive authorizes its observation up front.
`revalidate` re-reads a row when it is served (`null` drops it), since a page may be drained long
after the cursor was built. `identity` drops a later row of either source whose identity was
already served, such as the provider's copy of a create that landed mid-walk; an injected row's
identity is re-read at each check, so a temporary id that became the provider's still matches.
A refused page's retry re-reads its injected rows and offers no provider row the refusal did not
cover; one a dropped injected row had hidden leads the next page instead, with the rows after it.

### Existing-code migration only: refusal and failure

`ObservationGate.authorize()` reclaims prepared state only when an error carries
`OBSERVATION_REFUSED_CODE`. That mark proves the overseer refused the observation before recording
anything.

Every other failure has an unknown outcome. The gate releases in-memory bookkeeping but retains
durable fences because a lost reply may have left an observation record. A tracked-collection marker is
reclaimed only after every read that disclosed the collection was refused. One unknown result retains it.

The Workshop overseer does not yet add this code: both pre-recording refusal paths — owner-only
observations in shared workspaces, and collaborator exclusions — still throw plain errors. Until a
kernel change marks them, every failure takes the fail-closed unknown-outcome path above, and
`discard()` never runs. For a `withholdFromObservers` read that is not merely a retained marker:
`abandon` latches the binding unshareable for good, so a refused owner-only read costs the
workspace its sharing until the kernel distinguishes the two.

### Subresource IDs name resources

Use `GLOBAL_SUBRESOURCE_ID` directly for [connection-only access](#connection-only-access-global)
on a deployment-fixed instance.
Build every **structured resource** ID with `formatSubresourceId()` from `./subresource-ids`, and
read it back in `verifyObserverAccess()` with `parseSubresourceId()`:

```ts
formatSubresourceId({ namespace: "drive", fragments: [{ name: "file", id: fileId }] });
// "drive/file/<escaped fileId>"
```

Each fragment names a resource: a kind and the provider's id for it. It never names a predicate or
a policy. A mailbox only its owner may see is still `gmail/user/<sub>`, naming the owner's Google
account, not a `private` marker; the verifier knows what access each kind of resource requires,
including that one is shared with nobody else. Set `namespace` only when the gatekeeper exposes
distinct product families with their own resources, as Google does with Gmail, Drive and BigQuery.
A single-product gatekeeper omits it instead of repeating its own name.

Cloud IDs, workspace URLs, organization IDs, and similar provider-instance identifiers are **tenant
identities**. Qualify a resource with its tenant, using real resource kinds such as Slack's
`workspace/<teamId>/conversation/<conversationId>`, unless the deployed Worker's configuration
permanently fixes that tenant. A tenant chosen through a connected account, resource binding, or
URL is not fixed, and one OAuth app can serve many tenants. A fixed tenant left implicit, as in
`GLOBAL_SUBRESOURCE_ID`, must stay fixed while recorded requirements exist: repointing the
deployment needs an explicit migration, never a silent reinterpretation of old IDs.

Prefer stable provider IDs; escaping does not make a mutable URL or account-relative alias stable.
Recorded IDs must retain their meaning across renames and reconnects. Report independently required
tenant membership and child-resource permissions separately, even when the tenant is implicit;
nesting does not imply access inheritance.

`parseSubresourceId()` accepts only the exact spelling `formatSubresourceId()` produces, so one
resource always reports one string. That string is what the Workshop deduplicates and indexes.
The current shared contract requires well-formed Unicode IDs of **1–2048 UTF-16 code units**,
with at most **10,000 IDs** and **500,000 total code units** per observation, before deduplication.
Escaping can lengthen a component up to ninefold (a three-byte UTF-8 character becomes nine).
Use a suitable coarser real resource when needed, with a verifier check covering the entire
disclosure; do not truncate IDs or omit requirements to fit a bound.

## Bounds

Every cap must be a positive safe integer. Constructors reject zero, fractional, and unsafe values
instead of allowing a bound to disable itself.

The kit supplies defaults where they apply across consumers:

| Option | Default |
| --- | ---: |
| `maxPending` | 50 |
| `maxTrackedCollections` | 1000 |
| `maxObservers` | 10 |
| `remotePageSize` | 100 |
| cursor `maxProviderPagesPerCall` | 10 |
| `OAuthClient` `timeoutMs` | 30 000 ms |
| `OAuthClient` `maxResponseBytes` | 64 KiB |
| `readCiLog` `retainBytes` / `maxBytes` | 8 MiB / 128 MiB |
| `CiLogCache` `ttlMs` / `maxTotalBytes` | 1 hour / 32 MiB |

The kit requires values where no general default is safe:

- Every cursor's `pageSize`.
- `ActionFileStore`'s `maxFileBytes` and `maxTotalBytes`.

Size limits from the provider and the disclosure shape. `maxTrackedCollections` is a cumulative budget: it
bounds the distinct collections this binding has *ever* disclosed, including markers a fail-closed read
left behind, so size it from the whole resource rather than one page — a per-page value starts
refusing valid reads once later pages reveal new collections. `maxObservers` must account for the Workers
subrequest ceiling because every observer costs a verifier call on each read. `remotePageSize`
cannot exceed the provider's page cap. Lower `maxProviderPagesPerCall` for a provider that bills
each row it returns: a filter that drops whole pages otherwise pays for up to ten per `next()`, and
`1` with a `pageSize` no provider page exceeds makes each `next()` one provider request.

## Git

`git-transport`, `git-objects`, and `git-diff` implement the worktree contract in
`plans/worktrees.md` §3 for any smart-HTTP host. The gatekeeper supplies a fetch callback that adds
the URL, credentials, and timeouts; the kit owns the framing. Two rules of DO cache-pull framing are easy to
break from the outside and fail late when broken:

- **Never send a `have`.** A `have` asserts full reachability of that commit, but the workspace
  cache can hold commits from filtered or shallow pulls whose blobs or ancestors it lacks.
  Sending one makes upload-pack withhold objects a later fault will `want`. `buildGitFetchRequest`
  sends an empty have list and `done`; do not build a fetch request another way to "save bytes".
- **At most one `filter` line.** upload-pack accepts a single filter-spec — a second `filter` line
  is not merged, and GitHub rejects the request outright. Combining hints is spelled in the
  filter-spec grammar or not at all; `filterSpecForHints` is the one place that chooses, and its
  limits are documented on it (`blob:limit` and `tree:0` are known to work on GitHub; `combine:`
  is not).

Every ref update goes through `pushGitRefUpdate` with the *queue-time* old sha, so receive-pack's
compare-and-swap protects a branch that moved between approval and apply; a rejected update is a
`GitRefUpdateRejectedError` whose `reason` is the server's own line, which the gatekeeper passes
through rather than matching on. Advertise every commit id a read hands out — `advertiseCommits`
for a single read, and for a listing a `PageHookCursor` whose hook is `advertisePages` — except
those served from the cache while queued for push, which both take as `withhold`: advertising one
of those would record a pull-routing hint for an object the remote does not have. A session's
`SessionGitCache` (`./cursors`) does both over its own lazily fetched cache stub, with `withhold`
given once at construction.

A simulated read of a branch with queued pushes takes its head from `simulateBranchHead(realHead,
pushes)`, the gatekeeper filtering the pushes to that branch; the same call gives the next push its
`expectedOldSha`, so the simulated head and the compare-and-swap agree. Provider patches go through
`parseUnifiedPatch`, one file's patch at a time, which shares `diffTextLines`'s hunk shape, so a
simulated diff and a provider diff read alike.

Lazy DO reads use `Gatekeeper.gitPull(oids, options)`. This is a kernel-facing method, not part
of a gadget's session API. The kernel routes pulls through recorded object provenance
(advertised commits, their referents, or objects previously populated by that gatekeeper).
The shared composer checks oid syntax and composes typed options; it does not check
advertisement history.
The provider composes a typed fetch with `git-pull-transfer.startGitPull()` and returns a transfer
capability. Claim its backpressured raw PACK stream once with `stream()`, without buffering or
base64 encoding. The DO feeds it to its bounded cache decoder. Workers RPC can replace a stream
exception with a generic disconnect. If consuming the stream fails, query `status()` to recover
the producer's error; if the status has not failed, preserve the consumer's own error. After
draining the stream, require `complete` before accepting the transfer. Cancel an unfinished stream
and dispose the capability when done.

The transfer also supports a native container consumer, but container hydration is not enabled
by this capability alone; it requires the separate kernel worktree-replica bootstrap support.
That consumer must bind its bootstrap capability to an authorized immutable commit, request depth
one with no tree/blob filters, stream directly to native Git using its own limits rather than
the DO cache's, and close the bootstrap capability after hydration. No guest-supplied Git
commands, ref discovery, arbitrary URLs, or provider credentials belong in that bootstrap
interface. Packs are self-contained (no `have` negotiation or thin-pack dependencies). Native
consumers must record their shallow boundary because the raw pack does not carry Git protocol
shallow-info.

## Other module boundaries

- Use `withAuthRetry` only for token flows without `CredentialSource`. Otherwise,
  `CredentialSource.run()` owns refresh, replay, and expiry reporting.
- Use `isNoAccessError` or `probeAccess` for observer ACL checks. Do not use `isNoAccessError` as
  `CredentialSource.isAuthError`; it accepts 403 and 404.
- Use `readTextCapped` for every textual, JSON, or error body — a provider can return more bytes
  than the Worker can hold — and for a connect form read before its nonce is checked. It decodes
  UTF-8 and buffers, so binary downloads and streaming protocols (SSE, Git) need their own
  byte-preserving limit instead. The exception is an excerpt decorating an error already being
  raised: `readTextPrefix(response, n)` truncates instead of refusing and never throws on the body,
  so an oversized HTML error page still yields its first bytes. Never redact its result: the cut can
  split an echoed secret. Read a body that may echo a credential whole with `readTextCapped` and
  redact before cutting. Use `readTextCapped` whenever the whole body must be read, JSON included.
- Read CI job logs with `readCiLog`, not `readTextCapped`: a long log is legitimately larger than
  any whole-body cap, and `readCiLog` streams it, keeps only the tail, and still counts every
  line, so `pageCiLog` numbers lines over the whole log. Pass agent-supplied page options to
  `pageCiLog` untouched; it validates them. Put only finished logs in `CiLogCache`, and revalidate
  a hit against the provider (log erased, job deleted, access lost) before serving it — the cache
  holds bytes, not authority.
- Use `normalizeVendorEndpoint` for user-supplied provider base URLs. It validates that one URL and
  is not a fetch policy: fetch with `redirect: "manual"`, or re-validate each `Location` and drop
  origin-scoped headers when the origin changes, or a redirect carries `Authorization` off the
  allowlisted host.
- Put agent-supplied ids into request paths with `pathSegment`, or `pathSegments` for a
  `/`-separated name, not bare `encodeURIComponent`: it leaves `.` and `..` literal, and URL
  parsing resolves them out of the route prefix. The provider's id grammar is still the
  gatekeeper's to check.
- Use `PreviewOAuth` when previews must share one stable callback registered with the OAuth
  provider.
- Use `OAuthClient` for OAuth 2.0 token-endpoint calls rather than a hand-written `fetch`. It is
  stateless and classifies nothing as grant death on its own, so a refresh still goes through
  `CredentialCoordinator` via `oauthRefresh`, and the two modules share no state with
  `PreviewOAuth`.
- Every callback the kit invokes must throw display-safe errors. `discardMint`, the rejection heal,
  and the expiry notification all log what they catch, so a thrown token, header, or response body
  lands in the deployment's logs.
