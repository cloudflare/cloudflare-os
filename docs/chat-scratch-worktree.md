# Chat scratch worktree

Every new upload becomes a file in a chat-private `SCRATCH` worktree, independent of
MIME type or the selected model's input support. Images, PDFs, archives, spreadsheets,
unknown formats, empty binary files, and invalid UTF-8 are supported. Upload preparation
preserves the original bytes, including images; it does not resize or transcode them.
This intentionally removes the old image-only path that accepted source images up to 25 MiB
and resized them to fit: source images, like every other upload, must now fit the 4 MiB limit.
The scratch worktree is created on the first upload and reused for later uploads, plans,
and other agent working files.

`Overseer.uploadBlob(bytes)` durably stores a raw Git blob and returns its OID. Uploading
does not change a message or worktree. A message attaches the OID with filename/MIME metadata;
the same OID can instead be used in a worktree `setBytes` operation with its byte length.
Attachment limits and MIME signatures are checked when sending, independently of generic
blob storage. Removing an unsent attachment only discards the client reference; immutable
Git objects are not deleted while another attachment or worktree may still reference them.
Uploaded bytes, Git-fetched files, and authored files share the existing `gitObjects` collection:
one zlib-compressed loose Git object per OID. There is no chunk store or upload-grant system.
As with other Git APIs, knowing an OID allows access to that object if it exists in the workspace.
Raw-byte uploads and writes accept at most 8,000,000 bytes, conservatively below the existing
8 MiB compressed storage-record limit. Larger-file storage is deferred to a separate change;
existing text-write and local-read behavior is unchanged.
The shared Git store has no GC. Removing an attachment from an unsent draft does not reclaim
its uploaded blob; retention/quota needs a generic policy that also protects objects referenced
by messages and worktree changes, not attachment-specific deletion by OID.

Valid UTF-8 text without NUL bytes retains the existing text OTs, including a preserved BOM.
Later text uploads that exceed the OT record budget use an immutable blob reference instead,
so the same upload size limit applies to initial and subsequent messages.
Text reads and grep decode those references by content without changing their stored form.
Text edits over an uncommitted blob replacement remain unsupported; this does not change OT
composition or introduce binary deltas. Whole-file replacements and edits after committing
the blob as a Git base keep their existing semantics.
Other content uses the shared whole-file representation: `setBytes: {oid, byteLength}`
names an immutable whole-file Git blob. Payloads are stored as ordinary Git objects, not
embedded or base64-encoded in an OT. Binary changes are whole-file replacements or deletions;
binary deltas are deliberately not supported. Text transforms remain unchanged.

Ordinary worktree bindings expose `readBytes()` and `writeBytes(path, rawBytes)`; writes store
the blob before appending its whole-file OT. There is no staged/resumable upload protocol.
Git pack export streams one object at a time, so container materialization can transfer files
without decoding them as text or buffering the entire repository. Containers consume the same
canonical worktree rather than needing a separate attachment download path. The container-specific
replica API remains in the replica/binary follow-up PRs; this attachment ingress does not require
a container.

Download/replay reads the original upload's immutable Git blob, not a subsequently edited
workspace file. On the next message or agent turn, legacy attachments are migrated lazily,
one payload at a time, into the same scratch worktree. Each original blob reference and file
projection publish atomically; a reset resumes without duplicate files. Previously projected
files are not overwritten, even if the agent has edited or renamed them. Original payload
copies are dropped only after their immutable blob is durable. Compatibility readers remain
for chats not yet visited and old staged-upload handles; this is not a bulk deletion policy.
Migration retries a file up to three times per visit; persistent failures are logged and left
retryable without blocking other files or future messages. Replay shows an explicit unavailable
content marker if an original payload cannot be read, rather than failing the whole chat.
Model requests inline only compatible image/document inputs and valid text; other files are
identified by workspace path, never lossy UTF-8 replacement characters or an unsupported
provider content part. Images with an edge above 8000 pixels or unrecognized dimension headers
stay workspace-only on every model replay; no resize/transcode changes their original bytes.
When the replay contains more than 20 candidate images/documents, image edges are conservatively
limited to 2000 pixels, including images attached in earlier turns. Originals remain unchanged.
New images are read from the same immutable blob for previews; there
is no separate payload copy in attachment records. Existing limits remain: 4 MiB per file,
5 MiB and five files per message.

Filename allocation reserves existing base and pending root names, including directories.
Prior names are read from chat-scoped message metadata, never from a workspace-wide payload
scan. After the one-time legacy migration, messages without uploads do no attachment-namespace work.
Names are well-formed Unicode, truncated at code-point boundaries to 200 UTF-8 bytes before
collision suffixes, so recorded Git paths round-trip and materialize on Linux.
Projection commits with the validated user message; failed sends leave blobs available and
do not consume names. Later uploads receive collision-free suffixes. The worktree remains
available when a chat has already been seeded.
