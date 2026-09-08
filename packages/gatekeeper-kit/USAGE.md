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
async getCredentials(): Promise<CredentialsWithIdentity<PublicGrant>> {
  const { creds, identity, generation } = await this.#creds.snapshot(
    grant => refreshAtProvider(grant),
    { notify: () => this.#notify() },
  );
  return {
    creds: { token: creds.token, expiresAt: creds.expiresAt },
    identity,
    generation,
  };
}

reportCredentialsRejected(identity: string) {
  return this.#creds.adjudicateRejection(identity, {
    refresh: grant => refreshAtProvider(grant),
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

`refreshAtProvider` owns a classification the kit cannot make: throw `CredentialsExpiredError` only
when the provider proves the *grant* is dead — `invalid_grant` from the token endpoint, a revoked
refresh token, or provider-specific evidence of the same. Let transport, malformed-response, and
5xx failures travel unchanged, and do not treat a bare `invalid_token`: that is RFC 6750 for the
presented access token, which a refresh recovers. Treating either an outage or a recoverable token
rejection as grant death destroys healthy authority and prompts an unnecessary reconnect.

It also owes the *complete* canonical record, not the provider's response. Providers routinely omit
values that did not change — an unchanged rotating refresh token, granted scopes, provider metadata
— and the coordinator replaces the stored record wholesale, so anything absent is lost and the next
refresh fails after the first successful rotation:

```ts
const response = await exchangeRefreshToken(grant);
return { ...grant, ...response, refreshToken: response.refreshToken ?? grant.refreshToken };
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

`claimOAuth()` consumes its nonce *before* the provider token exchange, so a revoke or a newer
reconnect can land while that exchange is in flight. Unfenced, the older completion overwrites it.
Capture the connection when the attempt starts and hand it back at the end:

```ts
// Starting the attempt: `advanceToOAuth` carries arbitrary metadata through the callback.
const state = advanceToOAuth(kv, linkNonce, Date.now(),
  { startedUnder: this.#creds.connectionGeneration() });
if (state === null) throw new Error("This connect link has expired. Start again.");

// Completing it. Both handshake calls return null for an expired or replayed nonce, and the claim
// is checked before the exchange: minting first would leave a live grant nothing here can revoke.
const claim = claimOAuth<{ startedUnder: string }>(kv, oauthNonce, Date.now());
if (claim === null) throw new Error("This connect attempt has expired. Start again.");

const grant = await exchangeCode(code);
try {
  this.#creds.connect(grant, { ifGeneration: claim.startedUnder });
} catch (error) {
  if (!isConnectionSuperseded(error)) throw error;
  // Never stored, so this mint is yours to dispose — but only where revoking one token cannot
  // revoke the whole grant; see "Revoke discarded token rotations" below.
  await revokeAtProvider(grant);
  // Either a `clear()` or a newer winning `connect()` moves the generation, so report the change
  // rather than asserting which one happened.
  throw new Error("This account's connection changed while connecting. Start again.");
}
```

Without `ifGeneration`, `connect()` writes unconditionally. Fencing is opt-in because a flow with
no round trip — a pasted token, a form submission — has no window to fence and would have to
invent a generation to pass.

This closes the window between the claim and the write. It does not order two attempts that both
reach the exchange: the handshake holds one nonce, so a second attempt reaching `advanceToOAuth`
invalidates the first's callback, but an attempt that already claimed will still win if it
completes first.

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
connection fence that is the `CredentialRead` **the staging operation itself ran under** — `CredentialSource.run()` passes it as the operation's second argument, and it is
structurally an `ActionFence`, so `{ fence: read }` works verbatim. `submit` refuses the call
without one, and refuses a fence on a kind declared `"none"`. The kit never interprets the value, so a provider that wants an action to survive re-authorization of the same account stores its own stable account id instead and passes that at apply.

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

## Actions and files

Use `defineActions` and `stageAction` for externally visible side effects. They own the
submit, approve, apply, and retire lifecycle, including retryable versus terminal failure,
dependency stranding, and connection fences.

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
pruned, strands no dependent, and holds a slot until the user rejects it, so the "check the
provider" warning survives.

`claimBeforeApply` produces that same unknown outcome when an activation dies mid-dispatch. Neither
substitutes for a provider idempotency key derived from the stable `ActionContext.id`, which is
what makes a retry safe in the first place.

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

Every session method that returns provider data must await `ObservationGate.authorize()` before it
returns, in this order: fetch, authorize, return.

```ts
async getPage(id: string) {
  const page = await this.#api.page(id);
  const title = escapeObservationValue(page.title);
  await this.#gate.authorize(
    { title: `Page: ${title}`, description: `Read page **${title}**.` },
    { kind: "collections", ids: [page.spaceId] },
  );
  return project(page);
}
```

Run every provider-controlled string through `escapeObservationValue()` first. It collapses
newlines and escapes Markdown controls, so a page whose title carries `#` or a line break cannot
forge structure in the text a human approves against.

Nothing in the kit can enforce this — no code sits between a session method and its return value.
Skipping it fails silently: reads keep working, the Workshop records no observation, and the
strategy's derived `excludeObservers` never reaches the overseer, so owner-only data goes to every
admitted collaborator. Authorizing after the fetch is what makes the description name the bytes
actually disclosed; authorizing before it would describe a read that may still fail.

`ObservationGate` is the only path to `authorizeObservation`. It takes a duplicate of the stub it
guards and owns that dup, so a session holds two owners — its own approval queue for staging
actions, and the gate over `queue.dup()` — and releases both when the session ends:

```ts
#queue = queue;
#gate = new ObservationGate(queue.dup(), this.#observers);

[Symbol.dispose]() {
  this.#gate[Symbol.dispose]();
  this.#queue[Symbol.dispose]();
}
```

The gate only needs `ObservationAuthorizer`, the read-only capability, so a catalog or
slash-command handler — which receives exactly that — constructs one from its own
`authorizer.dup()`. Gate leases (`lease()`) are independent owners in the same way.

Every gatekeeper must implement the three observer methods, and `GatekeeperUser.getVerifier()`
alongside them — that capability is what `aclObservers` and `trackedCollectionObservers` call to check a
collaborator, and `asVerifier` casts it to the vendor's own interface. Select one strategy:

- `privateObservers` rejects collaborators.
- `aclObservers` checks baseline resource access when a collaborator is admitted.
- `trackedCollectionObservers` tracks disclosed collections and rechecks each observer for every collection-scoped read.
- `openObservers` admits every observer without consulting the provider. Choose it only where the
  data carries no provider-side access distinction, since a collaborator the provider itself would
  refuse still observes everything the binding reads.

`trackedCollectionObservers` persists verifier stubs. Its Worker needs the
`allow_irrevocable_stub_storage` compatibility flag; without it, the first `addObserver` fails with
`DataCloneError`.

### Baseline access is checked at admission

`verifyBaseline` and `aclObservers.hasAccess` run when a collaborator is admitted. The overseer
re-admits on every open, so losing Workshop membership is the revocation path.

Only `trackedCollectionObservers` continuously runs its oracle. It calls `hasCollectionAccess` for every observer
on every collection-scoped read. If the provider can revoke binding-level access independently of Workshop
membership, a `{ kind: "baseline" }` read is insufficient because it consults no oracle. Represent
that disclosure with a synthetic collection ID instead.

### Scope describes the disclosure

`ObservationScope` describes what a read reveals: `baseline`, `collections`, or `withholdFromObservers`.

A **collection** is a provider-side access-controlled grouping — a Confluence space, a Jira project, a
GitHub repo — whose ACL governs the items the read returned. Pass the ids of those groupings, not
of the individual rows.

Each strategy declares, as `aclChecks`, how thoroughly it verifies observer access to them, and the
gate refuses a `collections` scope a strategy cannot honour:

| Strategy | `aclChecks` | A `collections` scope |
| --- | --- | --- |
| `trackedCollectionObservers` | `per-read` | checked for every observer, on every read |
| `privateObservers` | `no-observers` | accepted; nobody is admitted to exclude |
| `aclObservers` | `unsupported` | **refused** |
| `openObservers` | `unsupported` | **refused** |

A resource whose children carry their own ACLs needs `trackedCollectionObservers`. Under the other two,
collection ids would name a check nothing performs, so declare those reads `{ kind: "baseline" }` — and if
the provider can revoke child access independently, that is the wrong strategy, not the wrong
scope. A custom strategy declares its own `aclChecks`, and only the `per-read` arm may carry
`prepare`, so claiming a check it does not implement will not compile.

### A cursor authorizes everything it hands out

A provider-backed cursor returns provider data from `next()`, so it carries the same obligation. The
session cannot discharge it up front: the pages do not exist yet, and one `next()` may be served
from the buffer with no provider fetch at all. Pass `authorizePage`, which the cursor calls with the
exact page it is about to return:

```ts
// A cursor is walked after this call returns, so it takes its own gate with `lease()` and
// releases it from `dispose`. Built on the session's gate instead, the first `next()` after the
// session releases its stub fails on the authorization rather than the data.
const walk = this.#gate.lease();
return new TokenCursor<Project>({
  pageSize: 50,
  dispose: () => walk[Symbol.dispose](),
  fetchPage: (token, perPage) => this.#api.listProjects({ cursor: token, limit: perPage }),
  authorizePage: (projects, { terminal }) => projects.length === 0
    ? walk.authorize(
      {
        title: "Projects",
        description: terminal
          ? "Listed the projects; there were none."
          : "Scanned a window of projects; none were visible.",
      },
      { kind: "baseline" })
    : walk.authorize(
      { title: "Projects", description: `Read ${projects.length} projects.` },
      { kind: "collections", ids: projects.map(project => project.id) }),
});
```

The lease and the session gate share the binding's strategy, so exclusions stay one decision; only
the stub is duplicated, and either side can be released without disturbing the other. `lease()`
needs a real `RpcStub` — the overseer hands one over, but a gate built from a service binding
cannot duplicate it, since `dup` is reserved over RPC.

Every page is authorized, including an empty one from a spent fetch window. So is the end of a walk
that disclosed nothing: `searchUsers(email) → no matches` answers a question about provider data,
and letting that reach the gadget unaudited turns the cursor into an existence oracle. A walk that
already returned a page does not re-authorize its `null`, and exhaustion is authorized at most once.

Branch on `projects.length`, not on `terminal`. Both an exhausted walk and a spent mid-walk window
arrive with no items, and `{ kind: "collections", ids: [] }` is refused — naming no collection is exactly the
shape the gate rejects. `terminal` distinguishes the two only for the description: whether the walk
is over, or the caller should ask again. The `collections` branch above also assumes
`trackedCollectionObservers`; under a strategy whose `aclChecks` is `"unsupported"` every branch is
`baseline`, per the table above.

A refusal holds the outgoing page, so the retry re-offers exactly it with no further provider
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
  authorizePage: async projects => {
    if ((await this.#creds.read()).generation !== opened.generation) {
      throw new Error("This walk was started under a connection that has since been replaced.");
    }
    await walk.authorize(/* … */);
  },
  // …
});
```

### Refusal and failure have different outcomes

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

The kit requires values where no general default is safe:

- Every cursor's `pageSize`.
- `ActionFileStore`'s `maxFileBytes` and `maxTotalBytes`.

Size limits from the provider and the disclosure shape. `maxTrackedCollections` is a cumulative budget: it
bounds the distinct collections this binding has *ever* disclosed, including markers a fail-closed read
left behind, so size it from the whole resource rather than one page — a per-page value starts
refusing valid reads once later pages reveal new collections. `maxObservers` must account for the Workers
subrequest ceiling because every observer costs a verifier call on each read. `remotePageSize`
cannot exceed the provider's page cap.

## Other module boundaries

- Use `withAuthRetry` only for token flows without `CredentialSource`. Otherwise,
  `CredentialSource.run()` owns refresh, replay, and expiry reporting.
- Use `isNoAccessError` or `probeAccess` for observer ACL checks. Do not use `isNoAccessError` as
  `CredentialSource.isAuthError`; it accepts 403 and 404.
- Use `readTextCapped` for every textual, JSON, or error body — a provider can return more bytes
  than the Worker can hold. It decodes UTF-8 and buffers, so binary downloads and streaming
  protocols (SSE, Git) need their own byte-preserving limit instead.
- Use `normalizeVendorEndpoint` for user-supplied provider base URLs. It validates that one URL and
  is not a fetch policy: fetch with `redirect: "manual"`, or re-validate each `Location` and drop
  origin-scoped headers when the origin changes, or a redirect carries `Authorization` off the
  allowlisted host.
- Use `PreviewOAuth` when previews must share one stable callback registered with the OAuth
  provider.
- Every callback the kit invokes must throw display-safe errors. `discardMint`, the rejection heal,
  and the expiry notification all log what they catch, so a thrown token, header, or response body
  lands in the deployment's logs.
