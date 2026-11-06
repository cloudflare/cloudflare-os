# Whole-file binary worktree changes

A mounted integration can return a non-text file using its existing worktree sync session:

```ts
const ref = await session.putBlob(rawBytes);
await session.submitChanges(batchId, baseRevision, [
  {path: "output.png", change: {setBytes: ref}},
]);
```

`putBlob(Uint8Array): Promise<BytesRef>` stores the raw payload as an ordinary Git blob and returns
`{oid, byteLength}`. It does not edit a file or advance the canonical revision. The existing Git
store limit of 8,000,000 bytes applies. The session supplies mounted-worktree authority and checks
that authority again after storage; deleting the worktree revokes both upload and submission.
An interrupted upload may leave an unreferenced immutable blob, but cannot publish a file edit.

`submitChanges` already supports `setBytes` and `remove`. It checks blob existence and length
before accepting a batch. The receiver resolves binary assignments through the worktree's normal
`gitPull()` endpoint, including unacknowledged OIDs superseded by later edits. No separate byte
staging, upload-grant, chunking, or binary-delta protocol is introduced. Text edits keep their
composable UTF-16 transforms.

Persist the batch ID, original revision, changes, and captured immutable postimages before sending.
After a lost reply, reuploading identical bytes returns the same OID; resubmitting the identical
batch returns its original receipt without applying it again. The native sync-session capability
can be stored and restored across Durable Object resets. Uploading through a transient `GitCache`
RPC target is not a replacement for that durable capability.

Whole-file replacement is an ordered assignment, including when it races with a text edit. It can
overwrite a concurrent edit when the assignment is accepted later; this is the explicit prototype
tradeoff. Deletion uses the same existing file-change ordering. Retention/quota and large-file
support remain separate work.

Kernel qualification lives in `worktree-replica.test.ts` (raw-byte limits, atomic validation,
replacement/deletion races and receipt reuse) and `replica-transfer.test.ts` (native persisted
capability and accepted mutation across real DO eviction). Container filesystem capture, Git blob
retention, raw export and synchronization completion belong to the companion gatekeeper.
