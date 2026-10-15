# Attachments in worktrees

Every new upload becomes a file in a chat-private `SCRATCH` worktree, independent of
MIME type or the selected model's input support. Images, PDFs, archives, spreadsheets,
unknown formats, empty binary files, and invalid UTF-8 are supported. Upload preparation
preserves the original bytes, including images; it does not resize or transcode them.
The scratch worktree is created on the first upload and reused for later uploads, plans,
and other agent working files. Existing attachment worktrees keep their binding names.

`Overseer.uploadBlob(bytes)` durably stores a raw Git blob and returns its OID. Uploading
does not change a message or worktree. A message attaches the OID with filename/MIME metadata;
the same OID can instead be used in a worktree `setBytes` operation with its byte length.
Attachment limits and MIME signatures are checked when sending, independently of generic
blob storage. Removing an unsent attachment only discards the client reference; immutable
Git objects are not deleted while another attachment or worktree may still reference them.

Valid UTF-8 text without NUL bytes retains the existing text OTs, including a preserved BOM.
Later text uploads that exceed the OT record budget use an immutable blob reference instead,
so the same upload size limit applies to initial and subsequent messages.
Other content uses the shared whole-file representation: `setBytes: {oid, byteLength}`
names an immutable whole-file Git blob. Payloads are stored in bounded raw-byte chunks, not
embedded or base64-encoded in an OT. Binary changes are whole-file replacements or deletions;
binary deltas are deliberately not supported. Text transforms remain unchanged.

Ordinary worktree bindings expose `readBytes()` and resumable, digest-verified byte uploads.
Git pack export streams chunk-backed blobs, so container materialization can transfer every
file without decoding it as text. Containers consume the same canonical worktree rather than
needing a separate attachment download path. The container-specific replica API remains in
the replica/binary follow-up PRs; this attachment ingress does not require a container.

Download/replay reads the original upload's immutable Git blob, not a subsequently edited
workspace file. Legacy attachments without Git source metadata keep their old read behavior.
Model requests inline only compatible image/document inputs and valid text; other files are
identified by workspace path, never lossy UTF-8 replacement characters or an unsupported
provider content part. Images with an edge above 8000 pixels or unrecognized dimension headers
stay workspace-only on every model replay; no resize/transcode changes their original bytes.
New images are read from the same immutable blob for previews; there
is no separate payload copy in attachment records. Existing limits remain: 4 MiB per file,
5 MiB and five files per message.

Filename allocation reserves existing base and pending root names, including directories.
Prior names are read from chat-scoped message metadata, never from a workspace-wide payload
scan. Messages without uploads do no attachment-namespace work.
Names are well-formed Unicode, truncated at code-point boundaries to 200 UTF-8 bytes before
collision suffixes, so recorded Git paths round-trip and materialize on Linux.
Projection commits with the validated user message; failed sends leave blobs available and
do not consume names. Later uploads receive collision-free suffixes. The worktree remains
available when a chat has already been seeded.
