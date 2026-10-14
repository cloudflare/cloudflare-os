# Attachments in worktrees

Every new upload becomes a file in a chat-private `ATTACHMENTS` worktree, independent of
MIME type or the selected model's input support. Images, PDFs, archives, spreadsheets,
unknown formats, empty binary files, and invalid UTF-8 are supported. Upload preparation
preserves the original bytes, including images; it does not resize or transcode them.

Valid UTF-8 text without NUL bytes retains the existing text OTs, including a preserved BOM.
Later text uploads that exceed the OT record budget use an immutable blob reference instead,
so the same upload size limit applies to initial and subsequent messages.
Other content uses the shared binary-file representation: `setBytes: {base: {oid, byteLength}}`
names an immutable whole-file Git blob. Payloads are stored in bounded raw-byte chunks, not
embedded or base64-encoded in an OT. Binary changes are whole-file replacements or deletions;
binary deltas are deliberately not supported. Text transforms remain unchanged.

Ordinary worktree bindings expose `readBytes()` and resumable, digest-verified byte uploads.
Git pack export streams chunk-backed blobs, so container materialization can transfer every
file without decoding it as text. Containers consume the same canonical worktree rather than
needing a separate attachment download path. The container-specific replica API remains in
the replica/binary follow-up PRs; this attachment ingress does not require a container.

Download/replay reads the original upload's immutable Git blob, not a subsequently edited
workspace file. A bounded image-byte copy is retained for the existing synchronous inline
preview API. Legacy attachments without Git source metadata keep their old read behavior.
Model requests inline only compatible image/document inputs and valid text; other files are
identified by workspace path, never lossy UTF-8 replacement characters or an unsupported
provider content part. Existing limits remain: 4 MiB per file, 5 MiB and five files per message.

Filename allocation reserves existing base and pending root names, including directories.
Names are well-formed Unicode, truncated at code-point boundaries to 200 UTF-8 bytes before
collision suffixes, so recorded Git paths round-trip and materialize on Linux.
Projection commits with the validated user message; failed sends leave uploads staged and
do not consume names. Later uploads receive collision-free suffixes. The worktree remains
available when a chat has already been seeded.
