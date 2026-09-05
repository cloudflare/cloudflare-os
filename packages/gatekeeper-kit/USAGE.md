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

Use the stable `ctx.storage.kv` object so refreshes coalesce across coordinator instances:

```ts
#creds = new CredentialCoordinator<Grant>(this.ctx.storage.kv, {
  expiresAt: grant => grant.expiresAt,
  legacyKeys: ["accessToken", "refreshToken"],
  upgrade: kv => readLegacyGrant(kv),
  discardMint: grant => revokeAtProvider(grant),
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
when the provider proves the grant is dead (`invalid_grant`, `invalid_token`, or a revoked refresh
token). Let transport, malformed-response, and 5xx failures travel unchanged. Treating an outage as
grant death destroys healthy authority and prompts an unnecessary reconnect.

Omit `adjudicateRejection`'s `refresh` callback when rejection of a current credential proves the
whole grant is dead. A heal cannot recover that provider model and would suppress the expiry
notification.

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

A provider that rotates refresh tokens must implement `discardMint`. A reconnect or revoke can win
while refresh is in flight, leaving the completed mint fenced out of storage. Revoke that grant at
the provider so no live credential chain remains without a stored handle.

Errors from `discardMint` are logged and do not replace the winning operation. It cannot recover a
crash between provider rotation and storage; the user must reconnect in that case.

### 6. Fence actions with the operation's credential read

`CredentialSource.run()` passes the operation a `CredentialRead` containing its `identity` and
`generation`. Capture that read when submitting an action.

`CredentialSource.read()` can supply the entry fence used by `apply(id, { generation })`, but a
reconnect may still land between the entry check and the provider call. A handler that must not run
under a replaced connection compares `ctx.fence` with the `CredentialRead` passed to the same `run`
callback that issues the request.

`authority()` is for cache partitioning only. A concurrent fetch can change it during an operation.

## Storage

### Name the narrowest surface

Each module accepts the structural KV surface it needs (`KvReadWrite`, `KvMutable`, or
`KvScannable`) instead of `DurableObjectStorage`. The signature records whether the module can read,
write, delete, or scan. It also keeps pure modules testable against a plain object.

### Pass stable storage objects

Pass the same `ctx.storage.kv` object on every access. Credential refreshes, expiry notifications,
and observer claim counts key process-local coordination by storage-object identity. Wrapping the
storage for every call defeats coalescing and can spend a single-use refresh token twice.

### Treat storage layout as compatibility

Shipped key names and prefixes are compatibility surfaces. Renaming one silently orphans live
records. When a port must preserve different keys, use the available options on
`ActionJournalOptions`, `ObserverTrackerOptions`, or `KvTtlCache` rather than migrating by accident.

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

Give each logical `KvTtlCache` family a `name`. Unnamed cache instances over one KV object share the
`cache:entry:` and `cache:generation` namespaces. Colliding keys can then serve another cache's
values, and either instance's `invalidateAll()` clears both.

The authority is the last-seen connection generation. A cached value from the previous connection
can remain available until its TTL, so call `invalidateAll()` during reconnect when that distinction
matters.

## Actions and files

Use `defineActions` and `stageAction` for externally visible side effects. They own the
submit, approve, apply, and retire lifecycle, including retryable versus terminal failure,
dependency stranding, and connection fences.

`claimBeforeApply` turns a lost activation into a terminal unknown outcome. It cannot classify an
ambiguous failure returned by the provider after dispatch. For that case, throw `ActionApplyError`
when the failure is known terminal, or use a provider idempotency key derived from the stable
`ActionContext.id`.

Store action file bytes with `ActionFileStore`. Put only the bounded `ActionFileReference` in the
action payload. Journal records must stay small, and approval text must describe the same bytes that
will be applied.

A declaration using `delivery: "continue-with-simulation"` must project pending actions onto later
reads. Use `createSimulationView`, `replaySimulation`, and `ProvisionalIds` for that projection and
for mapping provisional IDs to provider IDs.

## Observations

Every gatekeeper must implement the three observer methods. Select one strategy:

- `privateObservers` rejects collaborators.
- `aclObservers` checks baseline resource access when a collaborator is admitted.
- `trackedSetObservers` tracks disclosed sets and rechecks each observer for every set-scoped read.
- `openObservers` admits every observer.

`trackedSetObservers` persists verifier stubs. Its Worker needs the
`allow_irrevocable_stub_storage` compatibility flag; without it, the first `addObserver` fails with
`DataCloneError`.

### Baseline access is checked at admission

`verifyBaseline` and `aclObservers.hasAccess` run when a collaborator is admitted. The overseer
re-admits on every open, so losing Workshop membership is the revocation path.

Only `trackedSetObservers` continuously runs its oracle. It calls `hasSetAccess` for every observer
on every set-scoped read. If the provider can revoke binding-level access independently of Workshop
membership, a `{ kind: "baseline" }` read is insufficient because it consults no oracle. Represent
that disclosure with a synthetic set ID instead.

### Scope describes the disclosure

`ObservationScope` describes what a read reveals: `baseline`, `sets`, or
`withholdFromObservers`. The selected strategy decides the policy. A `sets` scope under a strategy
without `prepare` is a deliberate no-op. Do not choose such a strategy for resources whose children
have separate ACLs.

### Refusal and failure have different outcomes

`ObservationGate.authorize()` reclaims prepared state only when an error carries
`OBSERVATION_REFUSED_CODE`. That mark proves the overseer refused the observation before recording
anything.

Every other failure has an unknown outcome. The gate releases in-memory bookkeeping but retains
durable fences because a lost reply may have left an observation record. A tracked-set marker is
reclaimed only after every read that disclosed the set was refused. One unknown result retains it.

The overseer does not yet add the refusal mark, so every failure currently takes the fail-closed
unknown-outcome path.

## Bounds

Every cap must be a positive safe integer. Constructors reject zero, fractional, and unsafe values
instead of allowing a bound to disable itself.

The kit supplies defaults where they apply across consumers:

| Option | Default |
| --- | ---: |
| `maxPending` | 50 |
| `maxTrackedSets` | 1000 |
| `maxObservers` | 10 |
| `remotePageSize` | 100 |

The kit requires values where no general default is safe:

- Every cursor's `pageSize`.
- `ActionFileStore`'s `maxFileBytes` and `maxTotalBytes`.

Size limits from the provider and the disclosure shape. `maxTrackedSets` covers the distinct
subresources one read can reveal. `maxObservers` must account for the Workers subrequest ceiling
because every observer costs a verifier call on each read. `remotePageSize` cannot exceed the
provider's page cap.

## Other module boundaries

- Use `withAuthRetry` only for token flows without `CredentialSource`. Otherwise,
  `CredentialSource.run()` owns refresh, replay, and expiry reporting.
- Use `isNoAccessError` or `probeAccess` for observer ACL checks. Do not use `isNoAccessError` as
  `CredentialSource.isAuthError`; it accepts 403 and 404.
- Use `readTextCapped` for every provider response body. A provider can return more bytes than the
  Worker can hold.
- Use `normalizeVendorEndpoint` for user-supplied provider base URLs.
- Use `PreviewOAuth` when previews must share one stable callback registered with the OAuth
  provider.
