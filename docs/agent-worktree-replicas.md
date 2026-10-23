# Worktree replicas for agent integrations

The DO owns canonical worktrees and their existing `FileChange` transforms. An integration
can keep a fully materialized, concurrently writable replica; it never takes ownership of
ordinary DO file tools. Filesystem change detection, OT calculation, paths, containers,
snapshots, commands and network policy belong to the integration, not the kernel.

## Authority and lifecycle

`AGENT_INTEGRATION_GRANTS` is trusted deployment configuration keyed by vendor ID.
`worktreeReplica: true` grants replication independently of `lifecycle: true`.
Both default to denied. Ambient provisioning is still user/admin policy; a connector
cannot grant itself either privilege.

An agent's approval queue supplies the ephemeral `AgentContext` from #798.
`openWorktreeReplica()` captures only that invocation's named workpieces. It returns a
persistent, lease-scoped endpoint, not an arbitrary OID reader or repository credential.
Lifecycle participation remains #798's existing execution-row/outbox mechanism:
registration sends no started event; suspension and resumption notify asynchronously;
finished cleanup is awaited. This PR does not add contextual-action or effect-redelivery APIs.

Lease methods recheck the grant, connection, original logical turn, workpiece scope,
expiry and code epoch. Replica writes obey ordinary file-tool permissions, including
spawned agents' prohibition on changing gadget code. Original selection survives
suspension and eviction; later-added bindings do not silently widen a saved capability.

Terminal execution normally revokes a lease. A previously registered lifecycle participant
with an unacknowledged finished callback can perform final sync until a fixed, persisted
one-hour cleanup deadline. Renewal cannot extend that deadline; callback acknowledgement,
release, expiry or revocation fences further requests. A retry/reset never restarts the clock.

## Bootstrap

1. Acquire the lease, then capture an immutable checkpoint: checkout/binding/source metadata,
   original base commit/tree, accepted content commit, explicit Git head and canonical cursor.
2. Materialize the base through raw binary file streams or the authorized provider's complete,
   depth-one Git pack. The integration chooses paths and records the upstream shallow boundary.
3. Import `readCommitPack()` into private refs: actual DO-only commit identities, trees and
   changed blobs above the base, not synthesized file replacements. It includes the original
   base commit header for byte-only hydration, omits unchanged upstream blobs and never walks
   beyond that shallow boundary. Pack generation buffers at most one object, not a repository.
4. Apply `readOverlay()`'s pending canonical OTs above the accepted commit.
5. Irreversibly close Git bootstrap before exposing the replica for agent commands.

Checkpoints store pending transforms only once. Accepted contents already live in Git; there
is no second cumulative accepted-OT store. To validate a submission, the kernel reads only its
touched anchors from the captured accepted commit, applies checkpoint OTs and replays intervening
journal operations. It must not approximate established operations by re-diffing resulting text.

## Continuous bidirectional synchronization

The integration reads `changesSince(cursor)` while continuing its own work. Pages are bounded
by row count and a conservative 24 MiB serialized-byte budget. The cursor and `hasMore`
describe only emitted events, including empty scoped events and acceptance markers.

A frozen submission contains a lease-local batch ID, last fully consumed cursor, and touched
paths with acknowledged SHA-256 text anchors and integration-produced transforms.
The kernel transforms these against the canonical journal with the existing OT engine,
validates scope/applicability/budgets, and atomically persists accepted edits and a
payload-bound receipt. Identical retries return that receipt; reusing the ID for a different
payload fails. Corrections transform frozen replica contents to accepted canonical contents.

The receipt's acceptance marker is not permission to skip intervening canonical events.
Clients must paginate them all. Echo IDs belong to this lease, so another replica cannot
mistake an equal batch ID for its own operation. Ordinary DO edits flushed with a replica
batch do not acquire the replica's provenance.

Ordinary model-step commits and replica flushes share one persistence queue. Reconciliation
is fenced to the revision actually drained, not a later in-memory version. A replacement
agent pass registers only if its history snapshot is still current; a stale pass cannot
durably acknowledge a replica batch after replacement. Async first-pin reads cannot replace
a pin established by another writer.

Replica flushes may persist tool edits before their assistant transcript. Those tools are
stamped `effectsPersisted`, and bounded read outputs across that boundary are retained.
History replay must not reapply those edits or reconstruct earlier reads from newer contents.

## Recovery, retention and limits

Leases and payload-bound receipts are durable collections. Acknowledged changes use the
ordinary chat change journal and Git storage; no in-memory promise is a recovery receipt.
Live leases retain their required retired rows beyond the normal journal TTL. Ordinary
lazy pruning resumes after the lease ends. Revocation, expiry or a closed code epoch requires
a new checkpoint, not a misleading empty successful replay page.

Canonical replay, correction receipts and submissions are size-bounded before the durable
barrier. A tiny incoming OT can require large corrections; an oversized receipt is rejected
without committing or consuming its batch ID. The client can catch up or submit fewer paths.

Uploads use the existing scratch worktree and original byte-preserving Git blobs.
Attachment-name allocation is revalidated before publishing the message and its changes:
a replica can claim that name during preparation. A collision leaves the upload staged;
a retry allocates a free suffix, without overwriting acknowledged replica content.

Bootstrap preserves binary bytes and Git entry modes. This revision accepts text mutations
only; it does not implement binary replica uploads, chmod, symlink or Gitlink mutations.
The kernel already supports byte references for its own writes; replica binary submission
is a separate protocol extension. Source pushes are not granted by this capability.
Unacknowledged local effects retain the integration's documented crash/loss boundary.

## Verification

Workerd suites exercise deterministic bidirectional collisions, the live persistence races,
payload deduplication, fixed cleanup authority, actual DO eviction, scope/revocation,
large accepted Git contents with tiny pending deltas, and binary bootstrap streams to a
separately bundled consumer Worker. Test lifecycle helpers use #798's actual execution records
and pending-decision suspension rather than a parallel mock lifecycle state machine.

Lease and receipt collections start empty without a schema migration or repository fetch.
Checkout IDs remain existing workpiece IDs; provenance remains in the existing worktree/OID
metadata. There is no integration-specific container grant, image or deployment binding here.
