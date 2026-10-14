# Agent integrations and worktree replicas

The kernel remains authoritative for worktrees and their existing `FileChange` transforms.
An integration may keep a fully materialized replica, but never takes ownership of ordinary
agent file operations. Linux runners, images, filesystem implementations, network policy and
snapshots, mount names and single-container policy belong to the integration, not to
`workshop-backend`. Filesystem-to-OT calculation also belongs to the integration. The kernel
only validates scoped anchors and orders submitted transforms using the existing OT engine;
it must never re-diff canonical contents to approximate the journal's operations.

## Authority and lifecycle

`AGENT_INTEGRATION_GRANTS` is trusted deployment configuration, keyed by vendor ID. Its
independent `lifecycle`, `contextualActions`, `worktreeReplica` and `recoverableActions` flags
default to denied. Account provisioning/ambient enablement remains the existing user/admin
policy; a connector cannot grant itself integration privileges.

An eligible agent session obtains an ephemeral `AgentContext` from its approval queue. It can
register a persistent, binding-scoped lifecycle participant and acquire a persistent replica
capability. Contextual action application receives fresh capabilities tied to the original
approved action and logical turn, even after approval delays or eviction. It never falls back
to legacy application after a partial contextual dispatch.

One logical turn may have several invocation segments. Started/resumed/suspended/finished
events have durable IDs and an at-least-once outbox. Participants must deduplicate them.
Terminal turns revoke ordinary replica access. Only already-registered participants with an
unacknowledged terminal callback retain final-sync access, within a fixed persisted one-hour
cleanup deadline (the lifecycle callback's existing bound). Lease renewal is capped at that
deadline; callback ACK, expiry, release and revocation fence further access. Cleanup retries and
DO resets never restart that clock or resurrect expired leases.
Nested approvals use the existing action queue: durable submission does not grant permission.
Recoverable actions retain their origin and dispatch identity across resets rather than
executing under a new user prompt.

Lifecycle contexts retain their participant's registration-time worktree selection through retries
and resumed segments; they never acquire later-added bindings implicitly. Replica reads may include
gadgets a spawned agent can inspect, but replica writes obey that chat's ordinary file-tool rules:
spawned agents may modify worktrees, not gadget code. Both live and stored ingestion enforce this.
For a gadget's first replica write after approval or eviction, the stored barrier establishes a pin
against the lease's captured immutable base, just as the live path does. The ordinary barrier validates
the head/pin and records its declaration, so the proposal can subsequently be accepted normally.

Active continuations persist the initiating request before asynchronous startup, and each published
integration segment records its execution identity. Recovery skips inference for a completed segment
only when its terminal journal belongs to that continuation; older cleanup cannot discard a new prompt.
Interrupted suspension cleanup retains the paused continuation without inferring; only an authorized
decision wake-up removes that marker. Cancellation during recovery's awaited reconciliation/model
lookup clears running/visible busy state, fenced by continuation and live context so old cleanup
cannot clear a newer execution.
Segment startup rechecks the active continuation and rereads the lifecycle journal after draining
callbacks, so cancellation during delivery cannot publish another running segment of that turn.
Connection acceptance journals a wake-up on that continuation even before suspension is recorded
or while its callback is still running. Teardown consumes the marker after clearing busy state;
constructor recovery also consumes it if reset interrupts that hand-off. Cancellation or a new
execution removes the old marker, and an undecided/denied connection does not request a wake-up.
Only cards inside the current initiating request's history boundary can schedule that wake-up;
accepting an older card may connect a resource but cannot resume a newer undecided turn. Approval
decisions use the same durable marker during cleanup independently of the `recoverableActions`
grant, which controls external effect redelivery, not remembering that the user approved a pause.
The decisions authorizing a suspension's wake-up are consumed atomically with that marker, separately
from the chat note. Browser and recovery calls cannot re-arm the marker after its consumption;
integration decisions also fence against their submitting segment, not just the logical turn.
If model recovery fails, terminal callbacks are journalled before active state is cleared and the alarm
retries failed cleanup. Malformed model transforms are rejected before buffering and logged with only
stage/count diagnostics, preserving their tool-error transcript instead of aborting at persistence.
Content-free `agent.step.persist.*` and `agent.model.*` debug events share an execution ID and carry
local sequence numbers and elapsed milliseconds. They distinguish a queued or blocked persistence
barrier from a dispatched model request; stream creation is not receipt of provider response headers.

## Bootstrap and synchronization

1. Acquire a revocable, expiring lease for the captured worktree selection.
2. Capture a checkpoint containing binding/source metadata, immutable base identities,
   accepted and explicit Git heads, pending transforms, and an exact canonical cursor. The
   integration chooses collision-free paths for repository, gadget and attachment worktrees
   and retains those paths in snapshots.
3. Enumerate and stream base bytes separately from the transform overlay. `readCommitPack()`
   streams the original local commit/tree/blob objects above that base, rooted only at the
   checkpoint's captured accepted and explicit heads. It omits unchanged base objects and
   bounds content buffering by an object, not a repository or pack. Every scoped base also receives
   its original commit header: even a repository worktree may require byte hydration when its local
   base has no provider provenance. This neither sends base blobs nor walks beyond the original
   upstream shallow boundary, even when a migrated worktree hydrates from a newer local commit.
   `readOverlay()` then exports only pending operations above the accepted commit. Accepted OTs
   stay in their bounded storage chunks; the checkpoint captures their exact accepted Git identity
   instead of copying a cumulative prefix into one record. Reconciliation reads only a touched
   file from that commit, applies captured pending OTs, and replays intervening canonical events.
   Neither checkpoint capture nor export replaces canonical operations with file diffs. No whole-repository
   content buffer or base64 transfer is introduced. A provider may alternatively serve a
   validated native Git v2 pack for the already-advertised exact base commit. GitHub and GitLab
   implement this through the shared gatekeeper-kit validator and their authenticated
   upload-pack transports, including configured Access credentials for self-hosted GitLab.
   Source credentials
   and unrelated repository grants never enter the replica; provider and local-object bootstrap
   is explicitly closed before exposing it for agent commands.
4. Replay ordered canonical events through `changesSince()`. A receipt's acceptance marker is
   not a replay cursor: clients must consume every intervening event before advancing.
   Pages are limited by both row count and an 8 MiB conservative serialized-byte budget, using
   the existing OT size estimator plus event framing. Rows are read incrementally and the returned
   cursor/`hasMore` reflect only emitted events, including empty scoped or echo-marker events.
5. Submit frozen, bounded text transforms anchored by canonical cursor and SHA-256. The kernel
   checks path/checkout scope and base anchors, applies the existing OT resolution rules, and
   atomically stores a payload-bound batch receipt. Identical retries return the same receipt;
   reusing an ID for different content fails. Corrections bring the replica to canonical content.
   Both accepted OTs and durable correction receipts are bounded before the persistence barrier.
   Even a no-op from a stale cursor can need large corrections; an oversized receipt is rejected
   without committing or consuming its batch ID. Catch up canonical events or submit fewer paths.
   The immutable tree's ordinary file-tool writability checks reject directories, symlinks and
   Gitlinks before ACK. Leaf-only base enumeration does not establish that a path is absent.
6. Renew within the original grant/turn bounds; release fences further writes without removing
   already accepted changes. Live leases retain their required journal rows beyond the ordinary
   retired-row TTL, so caught-up clients can reconstruct anchors after long commands or DO resets.
   Expiry/revocation or an epoch change requires reacquiring a lease and checkpoint, not replaying
   an empty successful page. A checkpoint is immutable for its lease.

Journal events tag each replica-owned OT row with its batch, including an empty acceptance marker
for no-op batches. Ordinary DO edits flushed at the same barrier are not tagged. Echo batch IDs
are lease-local: another replica never mistakes a coincidentally equal batch ID for its own write.
The live barrier serializes receipt/version revalidation with append and persistence, so a
concurrent duplicate no-op returns the stored receipt without poisoning subsequent agent steps.
Ordinary model steps drain their buffers inside the same queue, so a concurrent `turn_end` cannot
detach replica edits between append and persistence. ACKs therefore retain both durable edits and
their lease-local echo provenance even while the ordinary transcript commit is still waiting.

UTF-8 text attachments become ordinary worktree files; BOMs are
preserved as content, and downloads read the original Git blob bytes. Upload names reserve existing
base and accepted/pending overlay root names, including directories, without reading their contents.
Immediately before the message's transaction, preflight every allocated name and OT against the
current namespace and content: a replica can
write while attachment preparation awaits. A collision rejects the send and leaves the upload
staged; retry allocates a free suffix without overwriting acknowledged replica edits.
This preflight must finish before publishing the user message or any attachment row. Collection
subscribers are synchronous, so database rollback cannot retract an already queued notification.
Rev 0 leaves non-UTF-8 attachments in the byte-preserving attachment store rather than creating
lossy text. File contents no longer have a separate uncompressed text-size cap; ordinary Git storage
and change-message limits apply, as on the kernel's other file paths.
Attachment bytes and tree metadata are prefetched, but worktree projection, attachment references
and the validated user message commit together. A rejected send leaves the upload staged and no
new workspace path; retry does not allocate a suffix for a file the failed send never committed.

The bootstrap API preserves Git modes and binary base bytes. Rev 0 mutation submission is text
only; it does not promise arbitrary binary/mode/Gitlink mutation support. A client cannot push
commits to a source repository through this capability. Unacknowledged local effects remain
subject to the integration's explicitly documented crash/loss boundary.

## Review and verification

The public kernel contains no Linux image, container service binding, standalone shell tool or
integration-specific release grant. The optional ambient connection card is generic; accepting
it uses the existing provisioning policy, not a new resource picker or authorization bypass.

Workerd tests cover contextual recovery, outbox eviction, grant/revocation checks, bounded raw
binary RPC transfer, anchored batch deduplication and deterministic bidirectional collisions.
The native Git bootstrap fixture uses a separate real Git server. Kernel transfer fixtures are
independent sinks: they do not import a private integration package.

## Storage and porting

Integration journals, leases, receipts, accepted OT prefixes, and attachment references live in
`storage-schema/overseer-storage.ts`. Schema version 6 adds their empty collections without
eagerly fetching repository contents. Checkout IDs are existing workpiece IDs; source provenance
remains in worktree records and the OID store, without a separate filesystem/repository catalog.
Replica overlays use the same compacted-history fold as agent replay, followed by live OT rows.
At accept, the original operations compose into bounded per-path storage chunks relative to a stable
hydration commit. A chunk that would exceed the ordinary change-record budget starts a new chunk
with the next original operation, rather than re-diffing a flattened file or rejecting a growing
file. Chunks are prepared and validated before publication; their replacement, pin advancement and
epoch reset share one storage transaction. Failure retains the previous prefix and the proposal.
First-chunk keys remain compatible with pre-chunking version-6 records.
Reconciliation therefore retains positional intent and small deltas across accepts,
compaction and eviction without expanding edits to full-file sets. Bootstrap materializes accepted
contents from real Git objects and applies only pending OTs; it does not fetch untouched blobs
through the DO. Captured heads survive eviction and do not follow a later moving worktree head.
Every object read during enumeration and streaming rechecks lease/revocation/bootstrap closure.
Stored replica selection replays the same stamped binding layer as compaction, including pasted
gadgets added after the chat's frozen seed. Suspension and eviction must not shrink an existing
lease solely because its live binding map is gone.
Pre-prototype worktrees without that prefix start from their current accepted commit; if it is
local-only, the integration uses binary base streaming rather than fetching it from a provider.

Retention is deliberately lease-bounded, not a longer global TTL: a long live lease retains more
journal rows on disk, and ordinary lazy pruning resumes after it ends. Advancing compact per-client
anchors to reduce that retention is a future optimization, not another merge algorithm.

Bootstrap adapters validate the immutable commit before contacting upstream and return the
binary response stream directly. Native Git tests belong in gatekeeper-kit; provider workerd
tests cover authentication, project scope, failures, and streaming. DO cache pulls are a separate
protocol path and must not inherit native Git's `have` negotiation semantics.
