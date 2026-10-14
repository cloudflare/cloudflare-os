# Byte worktree mutations

Text keeps the existing UTF-16 OT algebra. Worktrees (including attachments), not gadget
source, additionally accept opaque bytes. A byte reference names an immutable Git blob,
but is **not** read authority. Bulk payloads never travel inside a `CodeChange` or its logs.

## Data and operations

`BytesRef = {oid, byteLength}` names an immutable whole-file Git blob.
`ByteValue = {base: BytesRef}` represents that file without fetching it. Binary mutations
are whole-file replacements only; byte diffs/splices are deferred until measurements justify
them. The existing serialized change budget covers reference metadata, not embedded payloads.

The file operations are:

- `setBytes`: create/replace a file with a `ByteValue`, including an empty byte file.
- `remove`: the existing deletion operation, equally applicable to text and bytes.

Sequential replacements discard the earlier assignment. Concurrent replacements/deletions
use last-writer-wins by server order, without reading or merging payloads. A replacement or
deletion also supersedes an opposing text edit, matching the existing assignment policy.
Text/text edits retain the existing UTF-16 OT algebra. Binary formats are never auto-merged.

## Staging and authority

`Worktree` and `WorkspaceReplica` use the same resumable staging primitive:

1. `beginUpload(id, {byteLength, sha256})` durably binds the frozen payload identity.
2. `writeUpload(id, offset, ReadableStream<Uint8Array>)` appends raw bytes, with a durable
   offset after each bounded chunk. Matching retransmissions are permitted; changed retries,
   gaps, inconsistent IDs or simultaneous conflicting writers are refused.
3. `getUploadStatus(id)` recovers the durable offset/receipt after a lost response or DO reset.
4. `finishUpload(id)` verifies exact length and SHA-256, streams the Git blob SHA-1, publishes
   the chunk-backed blob into the workspace Git cache, and returns its OID reference.
5. Publish `writeBytes` or a replica `setBytes` batch only after staging finishes.

Upload IDs are scoped to a worktree or the original replica lease. Ephemeral `env.GIT`
worktrees have separate random staging scopes. Staging does not change a visible file.
Replica reads/replacements additionally require references granted to that lease or present in its
selected checkpoint/journal. Every streamed chunk rechecks lease revocation. A reset resumes
the original authorized upload/batch; it never borrows a new turn's authority.

`Worktree.readBytes(path, range?)` streams the current postimage. The replica equivalent reads
a scoped immutable reference; `readByteAnchor` supplies a byte postimage and opaque version
at a consumed cursor. Hydrating and finishing a Git base produces the same OID already named by
the selected tree; no separate base-adoption operation or second hashing pass is needed.

## Persistence and Git

The DO stages payload blocks of at most 256 KiB under an internal upload identity and block number.
Partial blocks and append offsets persist during staging; only verified finished uploads become
immutable objects. Replacements upload a new complete payload, leaving old references intact.
Change application/composition handle only metadata; range reads stream indexed blocks with
bounded buffers and backpressure. There is no piece tree or base64 encoding.

Finished uploads are promoted into the Git cache as OID-to-chunk-root mappings. The OID is
streamed over Git's `blob <length>\0` header and payload before the OT can reference it; commits
therefore reuse the already-verified blob OID without reading the payload again. Tree and commit
identities remain real Git identities. A blob's first chunk-root mapping stays stable across
identical uploads and imports, so an unrelated commit cannot invalidate a replica anchor.
Raw reads never seed the worktree overlay or change a text file's representation; text
readers classify bounded payloads by their contents, not their storage format.
Pack export streams compression and the pack trailer. Existing small loose
objects remain readable. Text-only tools/editor views explicitly reject or skip opaque bytes;
the code browser still lists their changed paths, without showing stale base text.

All uploaded attachments enter the attachments worktree. Valid text retains text OTs;
explicit binary MIME types, NUL-containing data and invalid UTF-8 use byte references.
The existing attachment upload/model-delivery size limits are unchanged.

## Recovery and limits

Length/digest verification precedes publication. The existing payload-bound batch receipt
remains the only replica mutation commit boundary. A lost ACK reuses that receipt, never
re-diffs a mutable file or repeats a command. Unacknowledged guest changes can still be lost
if the guest is destroyed before uploading, as with existing text synchronization.

Unreferenced uploads and immutable payloads currently have no collection
or quota policy (the Git store also retains objects). Production rollout needs a shared
retention/quota decision; do not delete references by age without tracing commits, checkpoints,
pending batches and grants. Legacy remote object pulls still have their existing bounded
decoder; a git-hydrated replica can seed a large binary base through verified staging instead.
No arbitrary total-file cap is introduced for new streamed byte mutations.

Coverage includes replacement/deletion convergence, resumable/digest-verified storage,
non-aligned upload recovery, bounded reads, real Git blob/pack identities, real DO/native RPC
publication, DO worktree commits/deletion, binary attachments and scope/revocation checks.
