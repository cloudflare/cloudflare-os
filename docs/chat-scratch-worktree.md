# Chat attachment worktree

Every new upload becomes a file in a chat-private `ATTACHMENTS` worktree, independent of
MIME type or the selected model's input support. Images, PDFs, archives, spreadsheets,
unknown formats, empty binary files, and invalid UTF-8 are supported. Upload preparation
preserves the original bytes, including images; it does not resize or transcode them.
This intentionally removes the old image-only path that accepted source images up to 25 MiB
and resized them to fit: source images, like every other upload, must now fit the 100 MiB limit,
and the model sees only those within the inline limits below.
Chats without uploads do not acquire an automatic attachment worktree. For generated files,
reuse a suitable existing worktree or call `createWorktree({title: "Mandelbrot", bindingName:
"OUTPUTS"})` without `commitId` to create an empty one. Uploads create the attachment worktree
lazily; each attachment's transcript note identifies its actual binding name (which may be
`ATTACHMENTS_2` on collision), without changing the system prompt.
Existing chats retain their original binding, such as `SCRATCH`. Keep this worktree for uploads;
use a separate worktree for generated files and working notes.
Spawned agents retain only their configured bindings.

Any file can be offered for download as a Markdown link, such as
`[Download CSV](worktree://OUTPUTS/results.csv)` or `[Download archive](worktree://OUTPUTS/build.zip)`.
Clicking downloads the original bytes with their filename through the authenticated blob RPC.
No bytes are fetched until the viewer clicks. Downloads use `application/octet-stream`, including
HTML and SVG, so saved files do not run in the Workshop origin.

Generated images can appear directly in an answer as Markdown:
`![Mandelbrot set](worktree://OUTPUTS/mandelbrot.png)`. The same scheme works in literal
`<img src="worktree://OUTPUTS/mandelbrot.png">` tags inside `<inline-html>` for custom layouts.
Inline views load these images in the ordinary document, including images cloned from HTML
templates. Worktree images inside Shadow DOM are not supported; use ordinary image tags or Markdown.
Use any worktree binding available to the chat, including `ATTACHMENTS`, and percent-encode special
characters in paths. The host parser resolves the path once as the answer streams and records
its immutable Git blob OID in the message's `embeds` map. Rendering reads that saved OID through the
existing authenticated raw-byte blob RPC. Editing or deleting the path, reopening the chat,
accepting changes, or resetting the DO never changes the file linked or pictured in an existing reply.
A later reply resolves the path again for a new snapshot. Missing images stay unavailable in the
old reply rather than silently resolving to a later file. The agent does not look up OIDs or
choose between live and pinned references; both links and images use `worktree://`.
Container outputs must have returned successfully through a mounted worktree before the agent
references them. Files outside mounts and ignored files stay in the container.

An `<inline-html>` view's code can also read a data file: `await embeds.json("worktree://OUTPUTS/spending.json")`
or `embeds.text(...)` returns the whole file as it was when the answer was written. A view reads
any file its reply pinned in the message's `embeds`, and no other. The host pins a file when the
reply names it: a prose link, an `<img src>`, or a complete `worktree://` URL a view's raw text
quotes (in `"`, `'` or a backtick, with no `${`; `quotedFileUrls` in `inline-html-blocks.ts` is
that kernel-side rule). The agent writes the file from `executeCode` in one response and draws
the view in the next: the answer's pins are final before its own tool calls run, so a view in the
same response as the write reads the file as it was before. `writeBytes` suits a data file the
agent rewrites: it stores one blob and records only its OID, where `writeFile` keeps the text in
the chat's change rows until the changes are accepted.

`Overseer.uploadBlob(bytes)` durably stores a raw Git blob and returns its OID; the composer
sends `{stream, byteLength}` instead, which the backend stores as it arrives and checks
against the declared length, so neither end holds the whole file. Uploading
does not change a message or worktree. A message attaches the OID with filename/MIME metadata;
the same OID can instead be used in a worktree `setBytes` operation with its byte length.
Attachment limits and MIME signatures are checked when sending, independently of generic
blob storage. Removing an unsent attachment only discards the client reference; immutable
Git objects are not deleted while another attachment or worktree may still reference them.
Uploaded bytes, Git-fetched files, and authored files share the existing `gitObjects` collection:
one zlib-compressed loose Git object per OID, except that a blob over 1 MiB is stored as an index
of chunks that are themselves loose blobs (see `git-chunked-blob.ts`). There is no upload-grant
system. As with other Git APIs, knowing an OID allows access to that object if it exists in the
workspace. Raw-byte uploads and writes have no size limit of their own (but see the storage
quota below), and reads return whatever is stored.
The shared Git store has no GC. Removing an attachment from an unsent draft does not reclaim
its uploaded blob; retention/quota needs a generic policy that also protects objects referenced
by messages and worktree changes, not attachment-specific deletion by OID.

Valid UTF-8 text without NUL bytes retains the existing text OTs, including a preserved BOM, up to
`MAX_BUFFERED_BLOB_SIZE` (1 MiB). A larger upload is named by its immutable blob reference
without being read or decoded: a text OT is held whole wherever the chat's files are, while
reads and grep take a blob a window at a time. The same upload size limit therefore applies to
initial and subsequent messages. No file over 16 MiB (`MAX_WHOLE_TEXT_BYTES`) is read whole as
text, which would hold its bytes and its text together: editing it, or reading it whole through a
binding, is refused before anything is read, and the agent reads it by window, greps it, or reads
its bytes. The grep tool keeps only the matches its output can show and counts the rest.
Text reads and grep decode those references by content without changing their stored form.
Text edits over an uncommitted blob replacement remain unsupported; this does not change OT
composition or introduce binary deltas. Whole-file replacements and edits after committing
the blob as a Git base keep their existing semantics.
Other content uses the shared whole-file representation: `setBytes: {oid, byteLength}`
names an immutable whole-file Git blob. Payloads are stored as ordinary Git objects, not
embedded or base64-encoded in an OT. Binary changes are whole-file replacements or deletions;
binary deltas are deliberately not supported. Text transforms remain unchanged.

Ordinary worktree bindings expose `readBytes()` and `writeBytes(path, rawBytes)`; writes store
the blob before appending its whole-file OT. Both stream: `readBytes()` reads a blob (or a byte
range of it) a chunk at a time, and `writeBytes()` also accepts a `ReadableStream`. There is no
staged/resumable upload protocol. Containers consume the same canonical worktree rather than
needing a separate attachment download path: a container gatekeeper clones the attachment worktree
with native Git through `WorktreeReplicator.gitPull()` and gatekeeper-kit's `serveGitUploadPack()` (see
[`worktree-replicas.md`](worktree-replicas.md)), which streams files without decoding them as
text. This attachment ingress does not require a container.

Download/replay reads the original upload's immutable Git blob, not a subsequently edited
workspace file. On the next message or agent turn, legacy attachments are migrated lazily,
one payload at a time, into the same attachment worktree. Each original blob reference and file
projection publish atomically; a reset resumes without duplicate files. Previously projected
files are not overwritten, even if the agent has edited or renamed them. Original payload
copies are dropped only after their immutable blob is durable. Compatibility readers remain
for chats not yet visited and old staged-upload handles; this is not a bulk deletion policy.
Migration retries a file up to three times per visit; persistent failures are logged and left
retryable without blocking other files or future messages. Replay shows an explicit unavailable
content marker if an original payload cannot be read, rather than failing the whole chat.
Model requests inline only compatible image/document inputs and valid text; other files are
identified by workspace path, never lossy UTF-8 replacement characters or an unsupported
provider content part. Text is inlined only up to `MAX_TOOL_RESULT_CHARS` (32K characters), the
most `readFile` returns whole. Larger text is also identified by workspace path, for the agent to
read by window or grep: inlined, it would be resent on every turn, and a single upload can exceed
the model's context window, which compaction cannot repair. A later upload into an existing
attachment worktree also reaches the agent as a user change, whose diff is shown only within the same
limit. Images with an edge above 8000 pixels or unrecognized dimension headers stay
workspace-only on every model replay; no resize/transcode changes their original bytes.
An image or PDF goes inline if the model takes images, it is at most `MAX_INLINE_ATTACHMENT_BYTES`
(7 MiB, under Anthropic's 10 MB of base64 per image), its message's inline attachments stay within
`MAX_INLINE_MESSAGE_BYTES` (10 MiB), and no provider has refused a request for it. The decision
depends only on its own message, so a later message never changes how an earlier one is shown:
rewriting an earlier message would invalidate the model's preserved thinking after it, and miss
the provider's cache. Every request resends them all, so once the chat's inline attachments pass
`MAX_INLINE_ATTACHMENTS` (20, past which Anthropic lowers its pixel limit) or
`MAX_INLINE_ATTACHMENTS_TOTAL_BYTES` (20 MiB; about 28 MB encoded, within the 100 MB Gemini
allows inline), the turn compacts first. Compaction summarizes the prompt as earlier requests sent
it, so the request reuses their cache and the thinking it keeps stays valid, and keeps the newest
messages whose attachments fit. If compaction fails, the turn fails, and Retry compacts again:
showing earlier messages any other way would invalidate the model's thinking after them, which is
what it remembers its turn by. Images the agent views with `readFile` count toward the same
limits in the step that read them: a step whose reads take the next request past either limit
ends the pass, so that the turn compacts before sending it, cutting between the turn's own steps
if it must. One step's reads fit one message's budget, so a cut that keeps the step can always be
found. A provider that
refuses a turn's first request, say for a PDF of more pages than it takes, has its message's inline
attachments named by path from then on; the model has answered nothing after them. Replay reads no
attachment's bytes unless it could inline them. Originals remain unchanged. New images are read from the same
immutable blob for previews; there is no separate payload copy in attachment records, and a chat
message carries the bytes only of images up to 4 MiB to clients, which stream larger attachments
with `readBlob()`. Uploads are limited to 100 MiB per file and five files per message.

Uploads count toward the workspace's storage quota. A workspace is one Durable Object, which holds
at most 10 GB and refuses every write when full, so the git store refuses a new blob over 1 MiB
that would take it past 8 GB (uploaded, written, or pulled by a read) and agent turns stop
starting from 9.5 GB, each with a message that says why; from 7 GB the workspace's metadata
reports its usage, so clients can warn (see `OverseerImpl.sampleStorageBytes()` and
`WorkspaceMetadata.storageBytes`). The file quota does not apply to smaller blobs, so ordinary
work goes on until the Durable Object itself is full.

Filename allocation reserves existing base and pending root names, including directories.
Prior names are read from chat-scoped message metadata, never from a workspace-wide payload
scan. After the one-time legacy migration, messages without uploads do no attachment-namespace work.
Names are well-formed Unicode, truncated at code-point boundaries to 200 UTF-8 bytes before
collision suffixes, so recorded Git paths round-trip and materialize on Linux.
Projection commits with the validated user message; failed sends leave blobs available and
do not consume names. Later uploads receive collision-free suffixes. The worktree remains
available when a chat has already been seeded.
