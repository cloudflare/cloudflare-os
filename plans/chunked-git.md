# Plan: Chunked storage for large git blobs

## Overview (plain language)

Each workspace keeps its files in a small git database inside its Durable Object (see
`packages/workshop-backend/src/git-cache.ts`). Every git object (a file's contents, a
directory listing, or a commit) is compressed and stored as one database row. A row can hold
at most 8 MiB, so today we cannot store any file bigger than about 8 MB. That covers files
the agent writes, uploads, and files pulled from GitHub or GitLab.

The fix is to split big files into pieces called **chunks**:

- A large file's row stops holding its contents. It holds a short **index**: the list of
  chunks, and where each one starts in the file, both as a byte position and as a line
  number.
- Each chunk is stored as its own small row, an ordinary git blob of up to 1 MiB.
- The file keeps its normal git identity, the SHA-1 hash of its whole contents. To the
  outside world, including GitHub, GitLab and every gatekeeper, it is an ordinary git blob.
  Chunking is purely an internal storage detail.

Where we split matters. If we cut every 1 MiB exactly, inserting one byte at the start of a
file would shift every later cut, and every chunk would change. Instead we pick cut points
from the content itself (**content-defined chunking**): a cut goes wherever a fingerprint of
the last few dozen bytes matches a pattern. An edit only changes the cut points close to it,
so after an edit only the chunk(s) around it change. The rest are byte-identical to before,
and since chunks are content-addressed, they are stored once and shared between versions of
the file.

The index makes partial reads cheap. To read bytes 500,000,000–500,001,000, or lines
2,000,000–2,000,100, we look up which chunk holds that position and decompress only that
chunk (and maybe its neighbour), not the whole file.

Storage is only half the problem. A Worker has about 128 MB of memory, so a 1 GB file can
never be held in memory in one piece, however it is stored. The plan therefore also makes the
paths that move files around *stream*: pulling from a remote, pushing to one, handing objects
to gatekeepers, browser uploads, and the agent's file reads and writes all work a piece at a
time. Code that
really needs a whole file in memory (running gadget code, three-way merges, text editing, the
code editor in the browser) still reads it whole, at any size: it may be slow or run out of
memory on a huge file, but trying is better than refusing to serve the user's stored data.
The user decides when a file has become too big to work with.

There is deliberately **no maximum file size**. The practical limits are the Durable
Object's storage quota and CPU time. Arbitrary caps added in the hope of avoiding resource
limits tend to reject work that would have succeeded, without reliably preventing the
failures they target.

The work lands as **four commits** in one PR:

0. **Native zlib only.** A preparatory cleanup. Today the pack reader uses `pako`, a
   JavaScript reimplementation of zlib, because it needed a feature the built-in
   decompressor seemed to lack. The runtime's native zlib can in fact do the job, and it is
   faster. This commit switches to it and removes `pako`, so the commits that follow build
   only on native compression.
1. **Chunked blob storage.** The new storage format, used for every blob over 1 MiB, behind
   the existing APIs. Nothing visible changes except that large local writes now succeed.
2. **Streaming git transport.** Pulls, pushes and the gatekeeper-facing `GitCache` API
   handle blobs of any size without holding them in memory.
3. **Ranged and streaming consumers.** The agent's `readFile` reads only the requested
   lines. Browser uploads, worktree byte reads/writes and the browser's file reads stream.
   grep streams large files.

Each commit leaves the tree building, passing tests, and shippable on its own.

---

## Locked decisions

These were settled in design discussion. Implementers and reviewers should treat them as
requirements, not suggestions.

1. **Only blobs are ever chunked.** Trees, commits and tags stay inline whatever their size
   (they never plausibly exceed 8 MB). So the chunked record variant needs no `type` field,
   and existing records need no migration.
2. **Chunks are ordinary inline git blobs** in the same `gitObjects` collection, keyed by
   their own SHA-1. They deduplicate against each other and against real files with
   identical bytes.
3. **The parent's oid is the SHA-1 of the whole blob** (`blob <size>\0<content>`), never of
   the chunk list. Chunking is invisible outside the store.
4. **Chunk boundaries are content-defined and byte-oriented.** They ignore newlines, since
   most large files are expected to be binary. A line may span chunks; readers must handle
   that.
5. **Each index entry records its byte offset and line**, where `line` is defined exactly as
   *the number of `\n` bytes in all preceding chunks*. The parent also records the total
   `size` and total `newlines`.
6. **Chunking threshold:** a blob is stored chunked iff its size is over `CHUNK_MAX_SIZE`
   (1 MiB). Every newly written row is therefore at most about 1 MiB. Legacy inline rows of
   up to 8 MB stay as they are and must stay readable.
7. **Chunk sizes:** minimum 64 KiB, average 256 KiB, maximum 1 MiB.
8. **No maximum blob size,** for ingress or for writes. Remove `MAX_GIT_OBJECT_SIZE`, the
   oversize-rejection bookkeeping, and the 64 MiB pack cap as the plan below describes.
9. **Limits go on writes, never on reads.** What a write is bounded by is chunking: no row
   is written holding more than about `CHUNK_MAX_SIZE`. A read never refuses data that is in
   storage, whatever its size or form (a legacy inline row of 8 MB, or a chunked blob of any
   size): a whole-buffer read assembles the whole object and tries its best. That may run
   out of memory on a giant blob, but that is better than refusing to serve stored data, and
   giant blobs are rare enough that a guard would be complexity without value. Where a
   streaming form exists, the paths that can handle large data use it; that is a choice of
   representation, not a refusal. `MAX_BUFFERED_BLOB_SIZE` (= `CHUNK_MAX_SIZE`, 1 MiB,
   introduced in commit 2) is only such a switch: the size above which an RPC that offers
   both forms returns a stream instead of a buffer. The same goes for clients: the browser
   reads a streamed file whole and displays it, with no client-side limit either. If huge
   files turn out to be a problem in practice, limits can be added then.
10. **Objects over 1 MiB cross RPC as streams.** `GitCache.get()` returns
    `Uint8Array | ReadableStream<Uint8Array>`: a `Uint8Array` iff the object's size is at
    most `MAX_BUFFERED_BLOB_SIZE` (1 MiB). Callers that don't want large objects cancel the
    stream and bail out. `Overseer.readFilesAtCommit()` likewise returns a stream for a file
    over the threshold (commit 3), which the browser reads whole.
11. **Pack deltas against large bases** use a streaming delta applicator. It may be slow;
    it must not run out of memory.
12. **Every ingress path is covered:** local writes, browser uploads (`uploadBlob`),
    worktree `writeBytes`, `GitCache.put`, and pulls (`consumePack`). The paths where content
    of unbounded size arrives get a streamed form: pulls (commit 2), and `uploadBlob` and
    `writeBytes` (commit 3). `GitCache.put` stays whole-buffer, with no size cap. Its payload
    is bounded by the RPC message carrying it, and no production gatekeeper calls it (see the
    `putStream()` TODO under "Out of scope").
13. **Binary detection moves to the read window.** The agent's `readFile` fails only if the
    *returned window* contains a NUL byte. Invalid UTF-8 is decoded as U+FFFD instead of
    making the whole file unreadable. Text *editing* keeps strict decoding.
14. **Text editing works at any size, as best it can.** Session/OT text editing stays
    whole-file: the edit tools fault the whole file into session text and search it, which is
    slow for a multi-megabyte file, but no tool refuses a file for its size. The one bound
    that remains is on *writes*: a single change is still capped by `MAX_CODE_CHANGE_SIZE`
    (it guards the size of the chat-change rows that store it). `editFile`'s change carries
    only the replaced span, so it is unaffected; a text `writeFile` whose new content alone
    exceeds the cap fails with the existing "too large to make in one step" error, and
    `writeBytes` (streamed) writes content of any size.
15. **Four commits, one PR** (commits 0–3). If reviewers want it, the gatekeeper-package
    edits in commit 2 may be split into their own commit after the kernel commit (see
    commit 2, "Split option").
16. **`node:zlib` for all git compression; no `pako`, no
    `CompressionStream`/`DecompressionStream`.** Use one API throughout the git code. Pack
    reading needs `node:zlib` anyway: `DecompressionStream` rejects the bytes that follow an
    entry's zlib stream ("trailing junk") and doesn't report where the stream ended. Nothing
    here needs a web stream *from* the compressor. The streams that cross RPC (the pack a
    gatekeeper sends, the pack `buildPack()` returns) are read or built by our own code
    (`PackReader`, `buildPackStream`), which feeds the compressor piece by piece. The
    compression level is also settable only in `node:zlib`.
    - Synchronous paths (loose objects, chunks, small pack entries) use
      `deflateSync`/`inflateSync`.
    - Streaming paths (large pack entries in and out) use `createInflate()`/
      `createDeflate()`. These are Node `Transform` streams: you call `write(chunk)` and
      `end()`, and output arrives through `"data"`/`"end"`/`"error"` events. They are
      driven by hand from inside the existing async loops; do not convert them with
      `Readable.toWeb`.
    - **Compression level: this work doesn't choose one.** Every deflate uses a single
      named constant, `GIT_DEFLATE_LEVEL` (exported from `git-codec.ts`, with
      `encodeLooseObject`'s rationale moved onto it). It keeps today's value, level 1
      (`Z_BEST_SPEED`), chosen in "Deflate loose git objects at level 1" (part of #656)
      because CPU was what stopped large mounts. Level 1 deflated 1.53× faster than level 6
      and stored 11% more bytes; a vscode first pull went from 7.3 s to 6.2 s. Chunk rows,
      inline rows and pack output all use the constant, so any later change to the level is
      one line. The level never affects oids or chunk boundaries, since both are computed
      from inflated bytes, so changing it doesn't disturb deduplication.

    Commit 0 removes `pako`, and no later commit may reintroduce it. (Elsewhere in the
    backend, `blueprint-archive.ts` gunzips R2 bodies with `DecompressionStream`. That is
    unrelated to the git store and out of scope.)

### Out of scope

- Blueprint release packs (`buildReleasePack` / `readReleasePack` in `blueprint-release.ts`,
  capped at `MAX_RELEASE_PACK_BYTES`). They keep working through `readLocalObject`, which
  assembles blobs of any size.
- Raising chat attachments' own 4 MiB/5 MiB caps (`chat-attachment-validation.ts`,
  `overseer.ts:380`). Commit 3 makes the upload path they use stream, but the caps, and the
  whole-buffer attachment reads behind them (replay, hydration), stay.
- A streaming `GitCache.putStream()` (the existing TODO at `workshop-shared/src/gatekeeper.ts`
  ~line 1858 stays a TODO).
- Garbage collection (there is none today). The GC notes must be updated; see commit 1.

---

## Background: current state (for implementers)

File references are as of this plan's writing; line numbers drift, so search by name.

- **Storage.** `GitObjectRecord { oid, data }` (`storage-schema/overseer-storage.ts` ~313) is
  one zlib-deflated loose object. The `gitObjects` collection is keyed by `oid` (~1264) and is
  backed by DO synchronous KV (`packages/typed-storage/src/index.ts`). A `get` returns the
  whole row value; there is no cheaper existence check.
- **Codec.** `git-codec.ts`:
  - `gitObjectOid(type, payload)` (~77) hashes `concatBytes([header, payload])`, an extra full
    copy.
  - `encodeLooseObject`/`decodeLooseObject` (~98/104) deflate and inflate whole objects.
  - `decodePackStream` (~613) streams the pack bytes, but inflates every entry whole
    (`PackReader.inflate`, ~769). Its `resolveBase` callback is synchronous and returns a
    whole `PackableObject`.
  - `PackReader.inflate` uses `pako`'s `Inflate` and reads pako internals (`ended`,
    `strm.avail_in`, through the hand-written `InflateWithInternals` interface, ~696) to find
    where each entry's zlib stream ends. The module header comment (~12–16) explains why.
  - `buildPackBytes` (~516), used by blueprint release packs, deflates with pako's `deflate`.
  - Loose objects already use native `node:zlib` (`deflateSync`/`inflateSync`).
  - Three test files build fixtures with pako's `deflate`: `git-codec.test.ts`,
    `git-cache.test.ts`, `blueprint-release.test.ts`.
  - `applyGitDelta` (~831) needs the whole delta, base and result in memory.
  - `buildPackStream` (~535) emits one whole object at a time (`deflateSync`).
  - `PackableObject = { type, payload: Uint8Array }` (~498).
- **Store.** `git-cache.ts`, `WorkspaceGitCache`:
  - `#putObject` (~279) is the single write to `gitObjects`. `#storeLocalObject` (~286) wraps
    it for local writes.
  - `writeBlob` (~305) enforces `MAX_GIT_OBJECT_SIZE`. `#writeFileBlob` (~448) maps
    `SQLITE_TOOBIG` via `isTooBigForStorage` (~1821).
  - `readLocalObject` (~271) inflates the whole object. It is called for commits and trees in
    many walks, *and on arbitrary oids* (see "readLocalObject audit" in commit 1).
  - `putFromGatekeeper` (~618) and `consumePackFromGatekeeper` (~659) store gatekeeper
    objects through `#storeVerifiedObject` (~1641). That rejects objects over
    `MAX_GIT_OBJECT_SIZE` via `#recordOversized` (~1627).
  - `consumePackFromGatekeeper` holds every non-blob *and every oversized blob* in memory
    until the pack verifies.
  - `ensureGitObjects` (~727) fails fast on a measured oversize, and has a "filtered
    omission" carve-out that reports a blob a filtered pull omitted as
    `GitObjectTooLargeError`. `#exactObjectHints` (~832) requests blobs with
    `filterBlobSize: MAX_GIT_OBJECT_SIZE + 1`.
  - `ensureBlobs` (~1256) returns the set of too-large oids.
  - `GitCacheImpl` (~1696) is the gatekeeper RPC stub. `get`/`has`/`stat` all go through
    `readForGatekeeper` (~696), which inflates the whole object even for `has`/`stat`.
  - `decodeBlobText` (~1769) rejects any NUL anywhere and requires strict UTF-8.
- **Overseer.** The pull delegate is `#pullGitObjects` (`overseer.ts` ~4789). It consumes
  `transfer.stream()` and, at ~4819, exempts blob-filtered pulls from the "every requested
  oid was stored" check.
- **Agent `readFile`.** `agent.ts`:
  - The tool is defined at ~3277. `readToolFile` (~1690) obtains the *whole* file text, then
    `readFileWindow(text, {startLine, lineCount})` (~1370) splits it and renders the window
    plus the note `[lines A-B of N; next startLine: B+1]`.
  - Replay of history re-renders the same output (~2336–2388) via `hooks.readBlobText(oid)`
    or session text.
- **Worktree bytes.** `worktree-session.ts`:
  - `readBytes` (~175) materializes the whole blob, then slices the range.
  - `writeBytes` (~188) takes a `Uint8Array`.
  - `fileBytesAtCommit` (`git-cache.ts` ~869) inflates a blob just to learn its length.
  - The RPC types live in `worktree-binding.d.ts`.
- **Gatekeepers.** GitHub and GitLab call `GitCache.get()` on blobs only in
  `#treeDiffSource.getBlob` (`gatekeeper-github/src/github.ts` ~4687,
  `gatekeeper-gitlab/src/gitlab-gatekeeper.ts` ~2865). That feeds
  `gatekeeper-kit/src/git-diff.ts` `diffGitTrees`, whose `getBlob` contract already allows
  `"unavailable"` (~109). No production gatekeeper calls `put` or `consumePack`.
- **Tests.** The relevant suites are in `packages/workshop-backend/__tests__/`:
  `git-codec.test.ts`, `git-cache.test.ts`, `git-cache-history.test.ts`, `git-blobs.test.ts`,
  `git-pull.test.ts`, `git-push-actions.test.ts`, `worktree-session.test.ts`,
  `attachment-worktrees.test.ts`, and the in-memory harness `local-git-cache.ts` /
  `git-cache-fixtures.ts`.

---

## Design

### Record format (`storage-schema/overseer-storage.ts`)

```ts
/**
 * One object of the workspace git store, in one of two forms. Content-addressed by `oid`
 * (SHA-1 of the whole object, as git names it) in both, hence immutable and idempotent to
 * rewrite.
 */
export type GitObjectRecord = GitInlineObjectRecord | GitChunkedBlobRecord;

/** Any object, stored whole: the zlib-deflated loose object, as git stores it. */
export interface GitInlineObjectRecord {
  oid: string;
  data: Uint8Array;
}

/**
 * A blob over CHUNK_MAX_SIZE, stored as an index of chunks. Each chunk is an ordinary inline
 * blob row; the concatenation of the chunks' payloads, in order, is this blob's payload.
 * `oid` is the SHA-1 of the whole blob (never of the chunk list), so the chunking is invisible
 * outside the store. Chunks are written before the index row, so an index row's presence
 * implies its chunks'.
 */
export interface GitChunkedBlobRecord {
  oid: string;
  /** Total payload byte length. */
  size: number;
  /** Total number of `\n` bytes in the payload. */
  newlines: number;
  /** In payload order; non-empty; offsets strictly increasing, the first 0. */
  chunks: GitBlobChunk[];
}

/** One entry of a chunked blob's index. */
export interface GitBlobChunk {
  /** The chunk's blob oid. */
  oid: string;
  /** Byte offset in the whole payload of the chunk's first byte. */
  offset: number;
  /**
   * The number of `\n` bytes in all preceding chunks: equivalently, the 0-based number of the
   * line containing this chunk's first byte.
   */
  line: number;
}
```

- The discriminant is structural: `"chunks" in record`. Add a small exported helper
  `isChunkedBlobRecord(record)` beside the types, or in the new module.
- A chunk's own size is `next.offset - this.offset`, or `size - this.offset` for the last
  chunk. Its newline count is derived the same way from `line`. Neither is stored
  redundantly.
- **Size of the index row.** Each entry is about 70 bytes serialized. At the 256 KiB average
  chunk size, an 8 MiB index row covers more than 25 GB, past a Durable Object's 10 GB
  storage limit. No index-of-indexes is needed. Note this in the doc comment.
- Update the `gitObjects` collection comment (~1257) to mention the two forms.
- Update the `GitObjectMetadataRecord.size` doc (~340) in commit 2, when oversize rejections
  disappear: `size` is then recorded only by stored puts and pack entries.

### Chunker

Implemented in a new module, `src/git-chunked-blob.ts`, by the class `ContentChunker`.

FastCDC with normalized chunking ("FastCDC", Xia et al. 2016), over a 32-bit gear hash.
**These parameters are part of the storage format.** Changing them never breaks correctness,
since rows are keyed by oid and an index written under old parameters stays valid. But new
writes would stop deduplicating against chunks written under the old ones. Put that warning in
the doc comment.

```
CHUNK_MIN_SIZE = 64 KiB
CHUNK_AVG_SIZE = 256 KiB   (2^18)
CHUNK_MAX_SIZE = 1 MiB
gear: Uint32Array(256), generated deterministically at module load (below)
hash update:  h = ((h << 1) + gear[byte]) >>> 0
masks: test HIGH bits, because with a left-shift gear hash bit k depends only on the last
       k+1 bytes, so the top bits carry the ~32-byte window:
  MASK_S = 0xFFFFF000   (20 bits; used before reaching CHUNK_AVG_SIZE: harder to cut)
  MASK_L = 0xFFFF0000   (16 bits; used after CHUNK_AVG_SIZE: easier to cut)
cut rule for a chunk starting at s, scanning position i (i = bytes into the chunk):
  - the first CHUNK_MIN_SIZE bytes are not hashed, and never cut
  - h restarts at 0 at the start of each chunk's hashed region
  - for CHUNK_MIN_SIZE <= i < CHUNK_AVG_SIZE: cut after byte i if (h & MASK_S) === 0
  - for CHUNK_AVG_SIZE <= i < CHUNK_MAX_SIZE: cut after byte i if (h & MASK_L) === 0
  - force a cut at CHUNK_MAX_SIZE
  - the final chunk is whatever remains (may be shorter than CHUNK_MIN_SIZE)
```

- **Gear table.** Generate it with splitmix32 seeded with the constant `0x67616467`
  ("gadg"). The exact algorithm goes in a comment, and a golden test pins `gear[0]`,
  `gear[255]` and a hash of the whole table. Hard-coding 256 literals is also acceptable if
  the reviewer prefers. Either way, the golden test is the guard.
- **API.** The chunker is a push-style state machine, so callers can feed arbitrary input
  pieces:
  `push(bytes: Uint8Array): number[]` returns the absolute cut offsets found in `bytes`, and
  `finish()` ends the input. Keep it allocation-free in the hot loop: a plain `for` loop over
  a `Uint8Array` with local variables.
- **Edit locality.** This is a probabilistic property, not a guarantee, and tests must say
  so. After an insertion or deletion, cut points resynchronize at the first content-defined
  cut more than `CHUNK_MIN_SIZE` past the edit. So an edit usually changes one chunk, two if
  it lands near a boundary, and rarely more.

### Writer

`BlobWriter`, in `git-chunked-blob.ts`.

```ts
/** Streams one blob into the store as chunks; see the module doc. */
class BlobWriter {
  constructor(store: ChunkStore, declaredSize?: number);
  write(bytes: Uint8Array): void;      // synchronous
  finish(): PendingBlob;               // synchronous
}
interface PendingBlob {
  oid: GitOid;
  size: number;
  /** The record to put, or undefined when the blob is small enough to be inline (then the caller writes it inline as today). */
  ...
}
```

The exact shape of `PendingBlob` is the implementer's call, subject to these requirements:

- **Synchronous.** Everything it uses is sync: DO KV, `node:crypto`
  `createHash("sha1")`, and `node:zlib` `deflateSync`/`inflateSync`. That lets pack
  consumption call it directly from the inflater's data callbacks.
- **Memory.** It buffers at most `CHUNK_MAX_SIZE` of not-yet-cut input, plus one chunk being
  deflated.
- **Chunk writes.** Each chunk is hashed as its own blob and stored as an inline row (skip
  the `put` if `gitObjects.get(chunkOid)` already exists). Chunk rows are written *as they are
  cut*, each in its own implicit write. Do **not** wrap a whole large blob in one
  `storage.transaction`. The parent's index row is written last.
- **Whole-blob oid.**
  - With `declaredSize`, hash the header `blob <declaredSize>\0` first, then every byte as it
    is written. `finish()` throws if the byte count differs from `declaredSize`.
  - Without one (only for an unknown-length stream, in commit 3), hash in `finish()` with a
    second pass that re-reads and inflates the chunks just written. Document that this costs
    roughly double the CPU.
- **Small results.** If the total size is at most `CHUNK_MAX_SIZE`, there is exactly one
  chunk, and it *is* the blob. Its oid is the blob's oid and no index row is written. Callers
  see an ordinary inline blob, exactly as today.
- **Index row and metadata.** `finish()` must let the caller write the index row *inside the
  caller's transaction*, together with metadata (`#storeVerifiedObject`). It must also let
  the caller skip the row when the oid is already held. The cleanest shape is to return the
  `GitChunkedBlobRecord`, so the caller `put`s it via `#putObject`.
- **Failures.** A failure partway leaves only orphaned chunk rows. That is consistent with
  the store's existing "no GC, objects may dangle" model.

`ChunkStore` is the narrow interface the module needs:
`get(oid) => GitObjectRecord | undefined` and `put(record)`. `WorkspaceGitCache` passes a view
over `storage.gitObjects`, and tests pass a `Map`.

### Reader

`BlobReader`, in `git-chunked-blob.ts`.

```ts
class BlobReader {
  static open(store: ChunkStore, record: GitObjectRecord): BlobReader;  // inline blob or chunked
  readonly size: number;
  /** Total `\n` count; for an inline record, computed on first access (one inflate). */
  get newlines(): number;
  read(offset: number, length: number): Uint8Array;   // bounds-checked
  /** Yields the payload in pieces (each at most one chunk), optionally over a byte range. */
  pieces(range?: { offset: number, length: number }): Iterable<Uint8Array>;
  /** Byte offset of the start of 0-based line `line` (0 <= line <= newlines). */
  lineStart(line: number): number;
}
```

- **Inline records** behave as a single chunk at offset 0, line 0. That covers legacy rows up
  to 8 MB too; they stay one 8 MB inflate.
- **`read`** binary-searches the chunk containing `offset` and concatenates across chunk
  boundaries.
- **`lineStart(n)`.** Line 0 starts at byte 0. For `n >= 1`, line `n` starts at the byte
  after the `n`-th `\n` (counting from 1). That newline lies in the **last chunk whose `line`
  is strictly less than `n`**: that chunk has fewer than `n` newlines before it, and the
  next chunk (if any) has at least `n`. Binary-search for that chunk, then scan it for its
  `(n - chunk.line)`-th `\n`. The answer is the next byte's offset. That is the next chunk's
  `offset` when the newline is a chunk's last byte, and `size` when it is the payload's last
  byte, where line `n` is the empty line at the end.
  - **Do not search for the last chunk with `line <= n`.** Several consecutive chunks can
    share one `line` value whenever a single line spans them (a newline-free file gives
    every chunk `line: 0`). That search would land on the last of them, not the one where
    the line begins.
- **Cache.** Keep a small LRU of inflated chunks (4 is plenty) so sequential and
  delta-copy access doesn't re-inflate.
- **Buffer ownership.** Every `Uint8Array` the reader returns (from `read`, `pieces` or
  anything else) is **borrowed**. It may be a view into a cached inflated chunk, shared with
  other results and later reads. The reader never mutates a cached buffer, so a caller may
  keep a borrowed view and read it later. But a caller **must not transfer** one.
  Transferring detaches the whole underlying `ArrayBuffer`, even through a `subarray`, which
  would empty the cache entry and every other view of it. Transfers include enqueuing into a
  `ReadableStream` with `type: "bytes"`, `structuredClone`/`postMessage` with a transfer
  list, and `ArrayBuffer.prototype.transfer`. Code that transfers must copy first
  (`piece.slice()`).
  - So the rule lives in one place, add one helper in `git-chunked-blob.ts`,
    `blobByteStream(reader, range?): ReadableStream<Uint8Array>`. It is a `"bytes"`
    stream with `highWaterMark: 0` that yields one copied piece per `pull`, and takes an
    optional per-pull hook (for worktree revocation). Every byte stream over a blob uses it:
    `GitCache.get` (commit 2) and worktree `readBytes` (commit 3). No other code enqueues
    reader output.
  - Consumers that only read synchronously or copy, such as `BlobWriter`, the delta
    applier, `node:zlib` `write` and `TextDecoder`, may use borrowed pieces directly.
  - Tests:
    - A stream over a blob whose chunks repeat (the same chunk oid several times, for
      example a file of one 1 MiB block repeated), consumed to the end. Every piece's bytes
      are right.
    - Afterwards, `read` and `pieces` on the same reader still return the right bytes.
- **Type check.** A chunk's inflated object must be a blob whose payload length equals its
  index-derived size. Otherwise throw "corrupt chunked blob <oid>". This is defence against
  storage corruption, not against attackers: the store is ours.

### Constants and errors (`git-cache.ts`)

- **New in commit 2: `MAX_BUFFERED_BLOB_SIZE = 1024 * 1024`.** Its doc comment says: the size
  above which an RPC that can return either a buffer or a stream (`GitCache.get()`, and in
  commit 3 `Overseer.readFilesAtCommit()`) returns a stream; not a storage limit, and never a
  reason to refuse a read (locked decision 9). It equals `CHUNK_MAX_SIZE`, so a buffered
  answer is never more than one row's worth. Define it in `workshop-shared` (both RPC docs
  cite it), with a doc comment, and have the backend import it; a backend test asserts it
  equals `CHUNK_MAX_SIZE`.
- **New: `CHUNK_*` constants,** in `git-chunked-blob.ts`.
- **Removed in commit 2:**
  - `MAX_GIT_OBJECT_SIZE` and `MAX_GIT_PACK_BYTES`.
  - `#recordOversized`.
  - `isTooBigForStorage` (removed in commit 1, since local writes can no longer hit
    `SQLITE_TOOBIG`).
- **`GitObjectTooLargeError`** keeps its existing meaning in commit 1: an object over
  `MAX_GIT_OBJECT_SIZE` that was not brought in from a remote. No read throws it. Commit 2
  removes the ingress cap, and with it this error, `tooLargeMessage`, and every "too large"
  path in the readers. After commit 2, nothing in the git store reports a file as too large.

### Invariants (reviewers check all of these)

- **I1. Chunk rows are invisible to provenance.** `gitObjectMetadata` never gets a row for a
  chunk by virtue of its being a chunk. No gatekeeper's scoped view answers for a chunk; the
  view requires `onRemote`/`pendingPush` metadata, so this holds by construction. The
  push-marking walk never descends into a blob, so never into chunks. A test asserts that
  `get`/`has`/`stat` of a chunk oid return null/false for a gatekeeper that owns the parent.
  One exception is acceptable: if a chunk's bytes are byte-identical to a real blob that a
  gatekeeper sent, that row has metadata as the real blob. It is the same object.
- **I2. Writes are ordered.** Chunk rows are written before the index row, and every object
  is written before any record names it (unchanged rule).
- **I3. Identity.** A chunked blob's oid always equals `gitObjectOid("blob", payload)`. Tests
  check this for sizes just around 1 MiB, multiples of chunk sizes, 0, and several random
  sizes.
- **I4. Reads are form-independent.** Every reader produces the same bytes whether the
  object is stored inline or chunked.
- **I5. No whole-object inflation when only presence, type or size is wanted.**
  `hasLocalObject`, `localObjectType`, `blobSize`, `GitCache.has` and `GitCache.stat` must not
  materialize a chunked blob. (For an inline row, the KV `get` still reads the row; that is
  unavoidable and fine.)
- **I6. The streaming paths never materialize a large blob whole:** pulls, pushes,
  `GitCache.get` and `readFilesAtCommit` above `MAX_BUFFERED_BLOB_SIZE`, worktree
  `readBytes`/`writeBytes`, uploads, the agent's windowed `readFile` from a blob, and grep of
  a large file. Whole-buffer reads (gadget loading, merges, `readCommitFiles`, text editing)
  do materialize, at any size, by design (locked decision 9).

---

## Commit 0: Native zlib only (remove `pako`)

**Goal:** `pako` is no longer a dependency. Pack decoding finds entry boundaries with native
`node:zlib`, and everything else uses native compression. Behavior is unchanged: the same
packs decode to the same objects, with the same errors for malformed input. This commit is
independent of chunking and could land on its own.

### Why `pako` was used, and why native zlib suffices

A pack stores each entry as a zlib stream directly followed by the next entry's header, with
no compressed length recorded. To decode one, an inflater must stop where the stream ends and
say how many input bytes it consumed. `DecompressionStream` cannot: it throws "trailing
junk" when bytes follow the stream, and it does not report a position. That is why the
module header (`git-codec.ts` ~12–16) chose `pako`, and read its internals to find the
boundary. `node:zlib` can do it directly:

- `inflateSync(input, { info: true })` stops at the end of the zlib stream, ignores input
  after it, and reports the bytes consumed as `engine.bytesWritten`. It throws
  (`Z_BUF_ERROR`) if the input ends before the stream does.
- `inflateSync`'s `maxOutputLength` option bounds the output, so a lying entry header can't
  cause a larger allocation than it claimed.
- `createInflate()` (streaming) also ends at the end of the zlib stream and reports the
  exact `bytesWritten`.

These were verified under Node. **Step 1 verifies them under workerd before anything else is
built on them**, since workerd implements `node:zlib` itself.

### Files

- `src/git-codec.ts`: `PackReader`, `buildPackBytes`, the module header comment, and
  deleting `InflateWithInternals`.
- `packages/workshop-backend/package.json`: remove `pako` and `@types/pako`, then update
  `pnpm-lock.yaml`.
- Tests: `__tests__/git-codec.test.ts`, `git-cache.test.ts` and `blueprint-release.test.ts`
  switch fixture deflation to `node:zlib` (`deflateSync`).

### Steps

1. **Verify workerd's `node:zlib`.** Add tests that run in the workerd pool (check which
   vitest project runs `git-codec.test.ts`; if it runs under Node, put these in a workerd
   suite). They assert:
   - `inflateSync(stream + trailingBytes, { info: true })` returns the right output, and
     `engine.bytesWritten` equals the stream's length exactly.
   - A truncated stream throws.
   - `maxOutputLength` is honored: inflating more than the limit throws.
   - `createInflate()`, fed a stream plus trailing bytes across several writes, emits `end`,
     and its `bytesWritten` equals the stream's length.
   - `createDeflate({ level: GIT_DEFLATE_LEVEL })`, written in pieces and then ended, produces
     output that `inflateSync` round-trips. Commit 2 relies on this.

   If any assertion fails, stop and report it. The fallback is to keep `pako` for finding
   boundaries only, and do everything else natively, with the reason recorded in the module
   header.
2. **Small entries: one synchronous inflate over a window.**
   - Add a `PackReader` operation that returns a contiguous view of up to `n` upcoming bytes,
     reading ahead across its 64 KiB reads (copying only when the window spans reads), and a
     companion that advances by `k` bytes. The SHA-1 trailer hashing must still see each byte
     exactly once.
   - For an entry whose declared size is at most a limit `PACK_SYNC_INFLATE_LIMIT` (1 MiB;
     commit 2 aligns it with `CHUNK_MAX_SIZE`): take a window of `zlibBound(size)` bytes, or
     whatever remains of the pack if that is less. `zlibBound` is zlib's `compressBound`
     (`n + (n >> 12) + (n >> 14) + (n >> 25) + 13`) plus zlib's 6-byte header and trailer.
     Then run `inflateSync(window, { info: true, maxOutputLength: max(size, 1) })`, check the
     output length equals `size`, and advance by `bytesWritten`.
   - A window can be too short for a valid stream that zlib's own encoder would never emit
     (for example, one padded with empty stored blocks). If `inflateSync` reports truncated
     input and the window stopped short of the pack's end, retry the entry on the streaming
     path (step 3). If the window already reached the pack's end, the pack is truncated:
     raise the existing "invalid packfile: truncated" error.
   - Map zlib errors to the existing messages: "corrupt object data", "object larger than its
     declared size", "object smaller than its declared size". Existing malformed-pack tests
     must pass unchanged.
3. **Large entries, and the fallback: streaming inflate.**
   - Feed the entry's bytes to `createInflate()` a read at a time, until it emits `end`.
     Then set the read position from `bytesWritten`, measured from the entry's start.
   - Enforce the declared size while inflating, as `inflate` does now: an overflow aborts
     immediately (destroy the stream), and a shortfall is an error at the end.
   - In this commit, collect the output into one buffer, as today. Commit 2 adds a callback
     form (`inflateTo`) that streams output instead.
   - Keep the `PackReader` API that `decodePackStream` uses (`inflate(size)`), so the
     decoder itself barely changes.
4. **`buildPackBytes`:** deflate with `deflateSync(payload, { level: GIT_DEFLATE_LEVEL })` (introduce the constant here, and use it in `encodeLooseObject` too),
   like `buildPackStream`.
5. **Remove `pako`:** delete the import and `InflateWithInternals`, drop `pako` and
   `@types/pako` from `package.json`, and update the lockfile. Rewrite the module header's
   compression paragraph: native `node:zlib` throughout; why `DecompressionStream` cannot
   decode packs; and how boundaries are found.

### Tests (commit 0)

- The workerd zlib checks from step 1.
- Every existing `git-codec`, `git-cache`, `git-pull` and `blueprint-release` test passes,
  with fixtures built by `node:zlib`.
- Entries whose compressed bytes span the 64 KiB read boundaries, including a header split
  across reads.
- A zero-length blob.
- An entry padded with empty stored blocks, so its compressed form exceeds `zlibBound`. It
  decodes via the fallback.
- An entry larger than `PACK_SYNC_INFLATE_LIMIT` decodes via the streaming path.
- A lying size header (too large and too small) on both paths gives the existing errors.
- A pack truncated inside an entry, on both paths.
- A real repository-sized pack (an existing fixture, or a generated pack of many small
  objects) decodes to the same oids as before.

### Review checklist (commit 0)

- No source or test file imports `pako`, and no `package.json` in this repo lists it.
  (`pako@1.x` stays in the lockfile as a transitive dependency of another package, which is
  fine.)
- A hostile pack still can't allocate more than an entry's declared size.
- Trailer hashing covers every pack byte exactly once, including bytes read ahead for a
  window.
- The module header accurately describes the compression choices.

---

## Commit 1: Chunked blob storage

**Goal:** blobs of any size can be stored and read back. Every existing API keeps its
behavior, except that local writes (`writeBlob`, file writes) no longer have a size cap. No
read is refused for size: a whole-buffer read of a chunked blob assembles it, whatever its
size.

Ingress from gatekeepers keeps `MAX_GIT_OBJECT_SIZE` in this commit. Blobs from 1 to 8 MB that
are pulled are now stored chunked.

### Files

- New `src/git-chunked-blob.ts`: `ContentChunker`, `BlobWriter`, `BlobReader`, `ChunkStore`,
  the constants, and a module doc.
- `src/storage-schema/overseer-storage.ts`: the record types (see Design).
- `src/git-codec.ts`: `gitObjectOid` hashes incrementally (`createHash("sha1")`, updated with
  the header, then the payload). Export a small `blobHasher(size)` helper, or similar, that
  `BlobWriter` uses, so the header format lives in one place.
- `src/git-cache.ts`: see the steps below.
- Tests: new `__tests__/git-chunked-blob.test.ts`, plus additions to `git-cache.test.ts` and
  `git-blobs.test.ts`.

### Steps

1. **Implement `git-chunked-blob.ts`** per Design.
2. **Write paths in `WorkspaceGitCache`.**
   - `#putObject(oid, object)` stays the single writer of *parent* rows. For a blob over
     `CHUNK_MAX_SIZE`, it runs a `BlobWriter` over the payload (with declared size) and puts
     the resulting index record. Otherwise it writes inline as today. Chunk rows are written
     by the `BlobWriter` through `ChunkStore`, and the `#putObject` doc comment says so.
   - `#storeLocalObject`, `importObjects`, `putFromGatekeeper` and the `consumePack` store
     step all go through `#putObject`, so they inherit chunking without further change.
   - Since `#putObject` runs inside callers' transactions, the chunk puts land inside them in
     commit 1. That is acceptable at the sizes commit 1 admits (8 MB ingress, buffered local
     writes). Commit 2 moves large-blob writing out of transactions for streaming.
   - `writeBlob`: remove the `MAX_GIT_OBJECT_SIZE` check and the `isTooBigForStorage`
     handling.
   - `#writeFileBlob`: remove the `isTooBigForStorage` handling. Delete `isTooBigForStorage`.
   - Update the `git-cache.ts` header "Storage notes" (lines ~16–37):
     - Loose objects or chunked blobs.
     - Chunk rows are kept alive by their index rows (a GC root rule).
     - Chunks carry no metadata (I1).
3. **Read primitives.**
   - `hasLocalObject(oid)`: unchanged logic. Note that it now never reads more than one
     index row for a chunked blob.
   - New `localObjectType(oid): GitObjectType | undefined`. A chunked record returns
     `"blob"`. An inline record is decoded whole with `decodeLooseObject`. New inline rows are
     ≤ 1 MiB and legacy ones ≤ 8 MB, so that is acceptable; say so in a comment. (Inflating
     just a prefix of the row with `inflateSync(..., {finishFlush: Z_SYNC_FLUSH})` would
     read the header alone, but don't add it unless profiling shows a need.)
   - New `blobSize(oid): number | undefined`: the chunked record's `size`, or the inline
     header size.
   - New `openLocalBlob(oid): BlobReader | undefined`. Throws if the object is not a blob.
   - `readLocalObject(oid)`: for a chunked record, assemble the full payload (one allocation
     of `size`, filled chunk by chunk) and return it, whatever its size. Inline records work
     as today.
4. **`readLocalObject` audit.** `readLocalObject` now assembles a chunked blob whole. Every
   call site that might see an arbitrary oid, and wants it only if it is a commit or tree,
   must find the type without assembling a blob, so a walk never materializes a large blob
   it doesn't need.
   - Commit/tree walks that cannot see blobs need no change:
     - `#heldPayload` for commit/tree.
     - `commitTree`, `readCommitObject`, `firstParentChain`.
   - Must change:
     - `#recordPullable` (~1620) and `#markForPush` (~1463) call `readLocalObject` on any
       visited oid to find referents. Blobs have none, so check `localObjectType` first and
       skip blobs.
     - `verifyPushAncestry` (~1316, ~1322), `isAncestor` (~1374), `#cachedAncestry` (~1414),
       `resolveCommitId` (~1188) and `fetchCommit` (~1222) inspect `.type` of arbitrary oids:
       use `localObjectType`.
     - `readForGatekeeper` (~705) is changed fully in commit 2. In commit 1 it may keep
       `readLocalObject`: a gatekeeper can only reach a large *local* blob through
       `pendingPush`, and commit 2 handles that. Better: make `has`/`stat` use
       `hasLocalObject`/`localObjectType`/`blobSize` already in this commit (I5).
     - `consumePackFromGatekeeper`'s `resolveBase` (~666): a large local base is assembled
       whole. That is acceptable in commit 1 (such bases can only be local uploads) and is
       made streaming in commit 2.
   - In `overseer.ts`, `releasesMergedSince` (~8315, commits only) needs no change, and
     `buildBlueprintPack` (~8357) is out of scope and acceptable.
5. **`readBlob(oid, byteLength?)`.** Check the length via `blobSize` *before* materializing.
   Leave its whole-buffer behavior otherwise, at any size. Add
   `assertBlob(oid, byteLength)`, which checks type and length without materializing. Switch
   `#writeFileBlob`'s `BytesRef` validation (~450) and the overseer's `#validateByteChanges`
   (`overseer.ts` ~2748) to it. Those callers only validate.
6. **`fileBytesAtCommit`** (~869): return `{oid, byteLength: blobSize(oid)}` after ensuring
   the blob, without materializing it. Faulting still pulls it whole in commit 1; that is
   bounded by the ingress cap.

### Tests (commit 1)

- **Chunker:**
  - A golden test of the gear table.
  - A golden test of cut offsets for a fixed pseudo-random 4 MiB input. It records the
    format; if the test changes, the format changed.
  - All chunks lie within [min, max], except the final one.
  - Determinism across arbitrary `push` splits: feeding 1 byte at a time gives the same cuts
    as feeding everything at once.
- **Edit locality** (statistical, with fixed seeds, no flakiness):
  - Insert 100 bytes into the middle of a 16 MiB random buffer. Assert that at most 3 chunk
    oids differ and the rest are shared.
  - Also test deletion and an edit at the very start.
- **Writer and reader:**
  - The oid equals `gitObjectOid` for sizes 0, 1, `CHUNK_MAX_SIZE`, `CHUNK_MAX_SIZE + 1`,
    3.5 MiB and 20 MiB (I3). Sizes up to `CHUNK_MAX_SIZE` produce an inline row and no index
    row.
  - `read(offset, len)` across chunk boundaries, at 0, and at the end.
  - Bounds errors.
  - `lineStart`, checked against a naive scan of the whole payload for every line, on:
    - a newline-free file of four or more chunks (every chunk has `line: 0`; `lineStart(0)`
      must be 0);
    - one long line spanning several chunks, with short lines before and after it;
    - a `\n` that is exactly a chunk's last byte, and one that is exactly a chunk's first
      byte;
    - a file ending in `\n`, so the last line is the empty line at `size`;
    - an inline (unchunked) record.
  - `newlines` equals the count over the whole payload.
  - A `declaredSize` mismatch throws.
- **Store:**
  - Writing the same large blob twice writes no new rows the second time.
  - Two blobs differing by a middle edit share most chunk rows.
  - A legacy 8 MB inline row (constructed directly) is readable via `readLocalObject` and
    `openLocalBlob`.
  - `readLocalObject` and `readBlob` assemble a chunked blob over 8 MB whole, and a legacy
    inline row over 8 MB reads whole too. Walks over arbitrary oids (`resolveCommitId`,
    `isAncestor`, `ensureObject` with the wrong type) read no chunk of a large blob.
  - `markPushClosure` over a commit containing a large blob neither throws nor marks any
    chunk.
  - `GitCache.get`/`has`/`stat` of a chunk oid return null/false (I1).
  - `writeBlob` of 20 MiB succeeds and round-trips. Use a size that keeps test time
    reasonable.

### Review checklist (commit 1)

- Record types are doc-commented, and there is no `type` field on the chunked variant.
- No `storage.transaction` wraps a call that can write more than a bounded number of chunks.
  In commit 1 this applies only through `#putObject`, which is bounded by
  ingress / buffered sizes; record this in a comment.
- Every `readLocalObject` call site was audited (step 4).
- The `git-cache.ts` header notes and GC-root notes are updated.
- No new size cap was introduced anywhere.

---

## Commit 2: Streaming git transport

**Goal:** pulls, pushes, and the `GitCache` RPC handle blobs of any size in bounded memory.
All ingress caps are removed, and with them every "too large" outcome in the git store: no
read reports a file as too large.

### Files

- `src/git-codec.ts`: streaming inflate, streaming delta application, and streamed pack
  entries.
- `src/git-cache.ts`:
  - `consumePackFromGatekeeper`, `putFromGatekeeper`, `#storeVerifiedObject`,
    `ensureGitObjects`, `#exactObjectHints`, `ensureBlobs`, `readForGatekeeper`,
    `buildPackForAction`, `GitCacheImpl`.
  - Removal of `MAX_GIT_OBJECT_SIZE`, `MAX_GIT_PACK_BYTES` and `#recordOversized`.
- `src/overseer.ts`: `#pullGitObjects`'s blob-filter exemption (~4819).
- `src/storage-schema/overseer-storage.ts`: the `GitObjectMetadataRecord.size` doc.
- `packages/workshop-shared/src/gatekeeper.ts`: the `GitCache.get` type and doc, plus the
  `MAX_BUFFERED_BLOB_SIZE` export (doc-commented; 1 MiB).
- `src/grep.ts`: drop the too-large skip.
- `packages/gatekeeper-kit/src/git-diff.ts` (the `getBlob` source contract):
  - `gatekeeper-github/src/github.ts` `#treeDiffSource.getBlob`
  - `gatekeeper-gitlab/src/gitlab-gatekeeper.ts` `#treeDiffSource.getBlob`
  - test stubs implementing `GitCache` (`gatekeeper-cloudflare/__tests__/worker.ts`,
    `gatekeeper-google/__tests__/test-git-cache.ts`, and any others found by type-checking).

### Steps

1. **Streaming inflate (`PackReader`).** Commit 0's large-entry path (`createInflate`)
   collects its output. Expose it as `inflateTo(size, onData: (piece: Uint8Array) => void)`,
   which delivers pieces as zlib produces them, with the same boundary detection and size
   enforcement. Commit 0's collecting version becomes a wrapper over it. Entries at or under
   the synchronous-window limit keep commit 0's `inflateSync` path. Align that limit with
   `CHUNK_MAX_SIZE`, so every entry streamed to a `BlobWriter` takes the streaming path.
2. **Streaming delta application.** This replaces `applyGitDelta`. Keep the old export name
   as a thin wrapper if tests or other callers use it.
   - A push-based parser, `GitDeltaApplier`, constructed with
     `(base: DeltaBase, sink: (piece: Uint8Array) => void)`.
     `DeltaBase = { size: number; read(offset: number, length: number): Uint8Array }`.
     `push(deltaBytes)` accepts arbitrary splits, including a split mid-varint or
     mid-instruction. `finish()` validates that the target length was reached exactly and
     that no instruction is left incomplete.
   - It exposes `targetSize` as soon as the header varints have been parsed, so the caller can
     choose the sink: a `BlobWriter` for a large blob target, otherwise a buffer.
   - Copy ops call `base.read(...)` and pass the result to the sink. Split large copies into
     ≤1 MiB pieces so the result never sits in memory whole.
   - Keep every validation of the current `applyGitDelta`:
     - The base size must match.
     - Copy ranges must lie within the base.
     - Op 0 is rejected.
     - The written length must equal the target length.
   - `DeltaBase` adapters:
     - A `Uint8Array` (a held non-blob, or a small blob).
     - A `BlobReader` (a chunked local blob), via `read`, cached by the reader's chunk LRU.
3. **`decodePackStream` streaming.**
   - Extend `DecodePackOptions`:
     - `resolveBase(oid) => { type: GitObjectType, base: DeltaBase, payload?: Uint8Array } | undefined`,
       or keep the `PackableObject` return and add an optional
       `resolveLargeBase(oid) => DeltaBase | undefined`. The implementer chooses, but keep the
       callback synchronous.
     - `openBlobSink?(size: number) => { write(piece): void; finish(): GitOid }`.
       When it is provided, every **blob** entry whose (target) size is over `CHUNK_MAX_SIZE`
       streams into it. This applies to non-delta entries via `inflateTo`, and to delta
       entries via `GitDeltaApplier` piped from `inflateTo`. The generator then yields
       `{ oid, type: "blob", size, stored: true }` without a payload.
   - Make the yielded type a discriminated union, so callers can't confuse a streamed entry
     with a buffered one.
   - Non-blob entries, and blobs at or under `CHUNK_MAX_SIZE`, behave as today.
   - `maxPackSize` and `maxObjectSize` become optional. Absent means unbounded.
     `readReleasePack` keeps passing `MAX_RELEASE_PACK_BYTES`.
   - OFS_DELTA bases are still found through `oidAt` (offset → oid) and then resolved via
     `resolveBase`, which hits storage for streamed blobs. That is correct because streamed
     blobs are stored before the next entry is decoded.
   - Delta entries: the type is known only from the base, so a delta whose base is a blob
     produces a blob. Decide streamed vs buffered from the base type and the delta's target
     size, read from the delta header before any output.
4. **`consumePackFromGatekeeper`.**
   - Remove both caps from the decode options.
   - `openBlobSink` returns a sink backed by a `BlobWriter(declaredSize)`.
     - The chunk rows are written outside any transaction.
     - On `finish`, run `this.storage.transaction(() => this.#storeVerifiedObject(...))`,
       which records metadata and puts the index row (skipped if it is already held).
   - Small blobs: stored on arrival as today.
   - `held` now contains only non-blob objects. Commits are still stored last; keep the
     existing comment's reasoning.
   - `resolveBase`:
     - From `held`.
     - Else a local inline object (whole, ≤ 1 MiB new / ≤ 8 MB legacy).
     - Else a chunked local blob via `openLocalBlob` as a `DeltaBase`.
   - The returned list now includes every object, of any size.
   - `#storeVerifiedObject` loses the oversize branch and always returns true. Simplify its
     callers, and change the return type to `void`.
5. **`putFromGatekeeper`.** It already takes a whole `Uint8Array` across RPC; it stays
   whole, minus the cap. Through `#putObject` it chunks blobs over 1 MiB.
   - Note: with a whole payload in hand, the chunk puts inside its transaction are bounded by
     the RPC message size, which is acceptable.
   - Update the doc and drop `GitObjectTooLargeError` from its contract.
6. **Pull-path cleanups.**
   - `ensureGitObjects`: delete the oversize fail-fast and the filtered-omission carve-out.
     With no blob filter on exact-blob pulls, a blob still missing after a successful pull is
     an ordinary pull failure.
   - `#exactObjectHints`: drop `filterBlobSize` for blob wants. The eager-tree hints keep
     `filterBlobSize: EAGER_BLOB_LIMIT`; that's for latency, not size safety.
   - Overseer `#pullGitObjects` (~4819): remove the blob-filter exemption from the
     "every requested oid was stored" check, but keep it for the eager commit pull (commit
     type with a filter), whose requested oid is the commit.
   - `ensureBlobs`: it can no longer return too-large oids from pulls. Change it to return
     `void`, and drop the too-large handling from its callers:
     - `readFilesAtCommit` loses its `unreadable` "too large" entry; every held blob is
       decoded, whatever its size. (Commit 3 switches large files to a stream.)
     - grep (`grep.ts` ~118) loses its "too large to read" skip note and greps every file;
       commit 3 makes large files stream rather than load whole.
   - Existing metadata rows with a measured `size > 8 MB` (from old rejections) become
     ordinary pullable objects. Nothing to migrate, but add a test.
   - Delete `GitObjectTooLargeError`, `tooLargeMessage`, and `#ensureFileBlob`'s translation
     of it into `UnreadableContentError`. `UnreadableContentError` then means only "not
     text" (binary or invalid UTF-8); update its doc (~194), which mentions the old limit.
   - Remove `MAX_GIT_OBJECT_SIZE` / `MAX_GIT_PACK_BYTES` and fix all references, including
     tests (`attachment-worktrees.test.ts`, `git-blobs.test.ts`, `git-cache.test.ts`,
     `worktree-session.test.ts`).
7. **Pack building.**
   - Add `type PackEntrySource = PackableObject | StreamedBlobEntry`, with
     `StreamedBlobEntry = { type: "blob", size: number, pieces(): Iterable<Uint8Array> }`.
     Do not widen `PackableObject` itself; many callers rely on `.payload`.
   - `buildPackStream(count, AsyncIterable<PackEntrySource>)`. A streamed entry is deflated
     incrementally with `node:zlib` `createDeflate({ level: GIT_DEFLATE_LEVEL })`.
     Write the entry's pieces to it one at a time, and emit its `"data"` output as it
     arrives. Await the output of each `write` before writing the next piece, so compressed
     bytes never queue up beyond about one piece. `end()` the deflater and await `"end"`
     before writing the next entry's header. Buffered entries keep `deflateSync`. The entry
     header uses `size`. The pack SHA-1 is updated as today.
     - Keep `highWaterMark: 0` pull semantics.
     - Emit at most about one chunk's compressed output per `pull`, so a large blob doesn't
       queue whole.
   - `buildPackForAction`: for a blob mark, yield a `StreamedBlobEntry` over `openLocalBlob`
     when the blob is chunked, and a buffered entry otherwise. Use `localObjectType` to tell.
8. **`GitCache` RPC (`workshop-shared/src/gatekeeper.ts` + `GitCacheImpl`).**
   - `get(id, hints?)` returns `Promise<{type: GitObjectType, content: Uint8Array |
     ReadableStream<Uint8Array>} | null>`. Doc: "`content` is a `Uint8Array` iff the
     object's size is at most `MAX_BUFFERED_BLOB_SIZE` (1 MiB); otherwise a byte stream of
     the payload, which the caller must consume or cancel." Trees and commits are buffered in
     practice, but the contract is by size, not type: a caller that fetches a tree still
     narrows with `instanceof Uint8Array` (see step 9).
     - Note: the threshold is by *size*, so a legacy inline blob of 1–8 MB is also streamed
       (`blobByteStream` over its `BlobReader`, whose one "chunk" is the whole row).
   - `readForGatekeeper` returns a discriminated value: a buffered object, or
     `{type: "blob", size, open(): BlobReader}`.
   - `GitCacheImpl.get` turns the latter into a stream with `blobByteStream(reader)`, which
     copies each piece before enqueuing it (see "Buffer ownership" under Reader).
   - `has`/`stat`: answered from the scoped metadata check plus
     `hasLocalObject`/`localObjectType`/`blobSize`, without materializing (I5). Pull-through
     for a missing `pendingPush` object stays as it is.
   - `@validateRpc()` must accept the union return type. Confirm that capnweb-validate
     handles `ReadableStream` in a union; if it doesn't, raise that rather than hand-roll
     validation.
9. **Gatekeepers.**
   - `git-diff.ts`: the source contract becomes `getBlob(oid): Promise<Uint8Array |
     "unavailable">` (unchanged). Document that adapters map a streamed `GitCache.get`
     result to `"unavailable"` after `cancel()`ing the stream. That is correct, since diffs
     already omit blobs over `MAX_DIFF_BLOB_BYTES` (1 MiB).
   - Add a shared helper in gatekeeper-kit,
     `bufferedGitContent(content): Uint8Array | undefined`, which cancels a stream and
     returns `undefined`, so both adapters stay one line.
   - GitHub/GitLab `getBlob` adapters: use the helper and fall back to the remote fetch, as
     they do for null, or return `"unavailable"`. Whichever keeps behavior simplest is fine;
     the remote fallback is already size-capped by `MAX_DIFF_BLOB_BYTES`.
   - Other `get()` callers fetch commits/trees. Those are buffered unless over 1 MiB, which
     a tree of a very large directory can be. They should read a stream whole rather than
     throw (locked decision 9): add a kit helper `gitContentBytes(content):
     Promise<Uint8Array>` that returns a buffer as is and reads a stream to the end, and use
     it at those call sites. Only the diff adapters above, which want to skip large blobs,
     cancel instead.

**Split option.** Step 9 (gatekeeper packages) may be its own commit, placed directly after
the kernel commit, as long as the workspace type-checks at each commit. If the kernel commit
alone would break gatekeeper type-checking, keep them together.

### Tests (commit 2)

- **`GitDeltaApplier`:**
  - Byte-for-byte equivalence with the old `applyGitDelta` on existing codec test vectors,
    with deltas fed 1 byte at a time and all at once.
  - All existing malformed-delta rejections still reject.
  - Copy from a `BlobReader` base spanning chunks.
- **Pack decode:**
  - A pack containing a 20 MiB blob (stored chunked, oid verified).
  - A REF_DELTA and an OFS_DELTA against that blob (the target is also large and stored
    chunked).
  - A delta chain of depth 3 across large blobs.
  - A delta whose base is a large blob *already in local storage*.
  - Small blobs and trees are unchanged.
  - A trailer mismatch still fails the decode.
- **`consumePackFromGatekeeper` + metadata:** a large blob gets `onRemote` and a measured
  `size`, and its chunks get no metadata (I1).
- **`buildPackForAction`** with a chunked blob, round-tripped through `decodePackStream`:
  the same oid comes back.
- **`GitCache.get`:**
  - Returns a buffer for a blob of exactly 1 MiB, and a stream for 1 MiB + 1 (chunked) and
    for a legacy 3 MB inline row, whose bytes match.
  - `stat`/`has` don't materialize. Assert via a spying `ChunkStore` or a storage-read
    counter in the test harness.
- **No too-large outcomes:** `readFilesAtCommit` returns the text of a 9 MB file; grep finds
  a match in one.
- **Pull:**
  - A blob pull with no filter, of a blob larger than 8 MB.
  - A legacy metadata row with `size > 8 MB` and no object pulls successfully.
  - A missing blob after a successful pull is a pull failure.
- **Memory (workerd suite, e.g. alongside `git-pull.test.ts`):** consume a pack carrying a
  ~200 MB blob, generated by streaming, never held whole in the test either, and push it back
  out via `buildPack`. The test asserts success. If the harness exposes heap stats, assert a
  bound. Mark it slow per `docs/testing.md` if needed.
- **Gatekeepers:** a `diffGitTrees` test where `getBlob` sees a stream yields `diffOmitted`
  and cancels the stream; `gitContentBytes` reads a streamed tree whole.

### Review checklist (commit 2)

- No whole-object materialization of a large blob anywhere on the pull/push/`get` paths
  (I6).
- No `storage.transaction` spans streamed chunk writes.
- Commits are still stored last in `consumePack`, and the reasoning comment is kept.
- `MAX_GIT_OBJECT_SIZE`/`MAX_GIT_PACK_BYTES`/`GitObjectTooLargeError` are fully gone, and
  their docs updated (search the docs too: `docs/`, `plans/git-storage.md`'s header note). No
  "too large" message remains in the git store's readers.
- `workshop-shared` changes are doc-commented, including the new constant.
- capnweb-validate covers the new return type.

---

## Commit 3: Ranged and streaming consumers

**Goal:** the agent and worktree APIs read large files in pieces. The agent's `readFile`
returns line windows of any file and detects binary data per window. Worktree byte I/O,
uploads and the browser's file reads stream. grep streams large files. Nothing refuses a file
for its size: the whole-file paths (edit tools, diffs, the code editor) just try.

### Files

- `src/git-cache.ts`: ranged/line read APIs with fault-in.
- `src/agent.ts`: the `readFile` tool, `readFileWindow`, `readToolFile`, replay, and the
  `AgentHooks` additions.
- `src/overseer.ts`: hook implementations.
- `src/worktree-session.ts`, `src/worktree-binding.d.ts`: `readBytes`, `writeBytes`, diff.
- `packages/workshop-shared/src/api.ts` and `src/overseer.ts`: the streamed `uploadBlob`
  form (step 6).
- `packages/workshop-frontend/src/features/chat/composer/attachments/useComposerAttachments.ts`
  and its test: send a stream (step 6).
- `packages/integration-tests/__tests__/workshop-lifecycle.test.ts`: the streamed-upload test.
- `packages/workshop-shared/src/api.ts`, `src/git-cache.ts`, `src/overseer.ts`: the streamed
  `FileAtCommit` (step 9).
- `packages/workshop-frontend/src/features/code/commitFileStore.ts` (and `otClient.ts`,
  if it consumes `FileAtCommit` directly) with tests: read streamed files (step 9).
- `src/grep.ts`.
- Tests.

### Steps

1. **Cache read APIs (`WorkspaceGitCache`).**
   - `async openBlob(oid, referencedBy?, path?): Promise<BlobReader>`: fault-in like
     `#ensureFileBlob` (pull if missing), then `openLocalBlob`. Never materializes.
   - `async openFileAtCommit(commitOid, path): Promise<{oid, reader} | undefined>`: the
     `#resolveEntryAt` walk plus the same symlink/submodule/dir rules as
     `readFileAtCommitWithOid`.
   - Keep `readTextBlob` / `readFileAtCommit*` (whole-text, strict) for whole-file consumers.
     They read a file of any size whole, as after commit 2.
2. **Line windows.** Add a pure function, in `git-chunked-blob.ts` or a new
   `line-window.ts`:
   ```ts
   /** The source a readFile window is rendered from: session text, or a stored blob. */
   type LineSource =
     | { kind: "text", text: string }
     | { kind: "blob", reader: BlobReader };
   ```
   `readFileWindow(source, {startLine, lineCount}, path)` reproduces today's output contract
   *exactly* for text that is valid, NUL-free UTF-8:
   - **Line count.** `N = newlines + (size > 0 && lastByte !== "\n" ? 1 : 0)`. This matches
     today's `split("\n")` followed by dropping a trailing empty element. Note: an empty file
     has N = 0.
   - **Unwindowed reads.** An unwindowed read of a source whose decoded length is at most
     `MAX_TOOL_RESULT_CHARS` returns the text verbatim, as today. For a blob source, decide
     this without decoding the whole file. Decoding yields at least one UTF-16 code unit
     per 3 bytes: a 3-byte sequence gives 1 unit, a 4-byte sequence gives 2, and an invalid
     byte gives at most one U+FFFD each. So a blob with `size > 3 * MAX_TOOL_RESULT_CHARS`
     cannot fit and is windowed. Otherwise decode it whole (it is small) and measure.
     Implementers: confirm the bound with a test that uses all-3-byte and all-invalid
     inputs.
   - **Windows.** Start at `lineStart(startLine - 1)`. Decode forward piece by piece with a
     non-fatal streaming `TextDecoder` (`{stream: true}`), accumulating whole lines until
     `lineCount` is reached or the character budget would be exceeded. At least one line is
     always taken, and lines are never cut, as today. The budget uses the same
     `note(lines.length - 1)` worst-case length rule as today, with `lines.length` = N.
   - **Errors.** `startLine` past the end gives the same error text as today.
   - **Binary detection.** If any byte of the returned window (the selected lines) is NUL,
     throw `UnreadableContentError("<path> contains binary data at lines A-B")`. Choose the
     exact wording; it is agent-visible. Bytes outside the window are never examined.
   - **Invalid UTF-8** within the window decodes to U+FFFD.
   - **One implementation.** The text-source path must give byte-identical output to the
     blob path for the same bytes. Implement both via one core over a "line pieces"
     abstraction, rather than two implementations.
   - A single line far larger than the budget is still returned whole (today's rule: "a
     single line longer than the cap is the one result that exceeds it"). For a blob, that
     could be a 1 GB line with no newlines. **Change for blob sources only:** if the first
     selected line alone exceeds the budget, return it truncated to the budget, followed by
     the note `[line A of N is X bytes; showing the first Y characters. Use readBytes for
     byte ranges.]`. Text sources keep today's behavior so replay stays identical. Call this
     out in the tool description.
3. **Agent `readFile` (`agent.ts`).**
   - `readToolFile` (~1690) returns a `LineSource` plus the oid stamp, instead of whole
     text:
     - Unpinned: `hooks.openFileAtCommit` (new), giving `{kind: "blob"}`.
     - Pinned with session text: `{kind: "text"}`.
     - Pinned with a `BytesRef` overlay: `hooks.openBlob(oid)`.
     - Pinned with no session content: today's fault-into-session behavior, at any size
       (`faultWorktreeBase` ~1655, `readSessionText` ~1677), so that edits keep working on
       what was read. A huge file is decoded whole here; that is the edit path's cost
       (locked decision 14), not a refusal.
   - The tool's execute (~3303) and history replay (~2336–2388) call the new
     `readFileWindow` with the same source kind they would have used live.
     - Replay of a stamped read uses `hooks.openBlob(observedOid)`.
     - Replay of session-text reads uses `{kind: "text"}`.
   - **Replay compatibility requirement.** Every read recorded before this commit must
     replay to identical output. Before this commit, a successful read always came from
     strict, NUL-free text under 8 MB, so the blob path decodes it identically. Add a test
     that replays recorded reads (existing fixtures) unchanged.
   - Tool description (~1165): mention that large files are read by window, and that
     binary data in a window is an error naming the lines.
   - `AgentHooks` additions (doc-commented): `openFileAtCommit` and `openBlob`, implemented
     in `overseer.ts` beside `readBlobText` (~1975). Return types must not cross RPC; these
     are in-process hooks. Verify that.
4. **Large files in the text-editing path: no refusals.** The edit tools work on a file of
   any size (locked decision 14). Check that nothing in `editFile`, the text form of
   `writeFile`, `faultWorktreeBase` or the worktree session's `writeFile` refuses a file for
   its size once commit 2 has removed the too-large errors; a test edits a 9 MB file.
   - The existing `"Binary content requires byte operations."` (`agent.ts` ~3482) stays: it
     is about content, not size.
   - `worktree-session.ts` `writeFile` (~197) keeps its whole-file `set` fallback on
     `UnreadableContentError`, which now means only "not text".
   - A text write whose change exceeds `MAX_CODE_CHANGE_SIZE` keeps the existing "too large
     to make in one step" error (`agent.ts` ~2934). Make sure that message suggests
     `writeBytes` for content that large.
5. **Worktree bytes (`worktree-session.ts`, `worktree-binding.d.ts`).**
   - `readBytes(path, range?)`:
      - For a `BytesRef` or base blob, open a `BlobReader` and return
        `blobByteStream(reader, range)`, with a per-pull hook that calls `#pinBase()`, as
        today, so revocation stops the stream. The helper copies each piece before enqueuing
        it (see "Buffer ownership").
     - For a string value, keep today's behavior.
     - Validate the range against `reader.size` up front.
   - `writeBytes(path, content: Uint8Array | ReadableStream<Uint8Array>)`. Update the `.d.ts`
     doc.
      - A stream is written with `BlobWriter` without a declared size (two-pass hash). Read it
        with a BYOB reader in 64 KiB pieces, like `PackReader`, for RPC efficiency.
      - Add `WorkspaceGitCache.writeBlobStream(stream, byteLength?): Promise<BytesRef>`. With
        `byteLength` it hashes in one pass, and a length mismatch throws (`BlobWriter`'s
        declared-size check). Without it, it hashes in two passes. If the stream does not
        support BYOB reads, which may be the case for a stream that arrived over Cap'n Web, it
        falls back to a default reader. `BlobWriter` buffers up to a chunk regardless, so the
        read size affects only overhead.
     - The resulting `BytesRef` flows into `setBytes` exactly like today's. `validateCodeChangeSchema`
       / `byteFileChangeSize` (`code-change.ts` ~236) must count a `BytesRef` as its
       reference size, not `byteLength`. Check this; otherwise a large `setBytes` would trip
       `MAX_CODE_CHANGE_SIZE`.
6. **Streamed browser uploads (`AuthenticatedApi.uploadBlob`).** Today the public upload
   path is whole-buffer at both ends:
   - `uploadBlob(content: Uint8Array)` in `workshop-shared/src/api.ts` (~2875), documented
     as "Limited to 8,000,000 bytes; larger-file support is deferred".
   - `Overseer.uploadBlob` (`overseer.ts` ~11844) forwards the array to `writeBlob`.
   - The frontend (`useComposerAttachments.ts` ~71–75) sends `await blob.arrayBuffer()`.

   Removing the storage cap (commit 1) only lets somewhat larger *buffered* uploads succeed;
   a 1 GB upload still cannot fit in the Worker's memory. So:
   - Widen the API to
     `uploadBlob(content: Uint8Array | { stream: ReadableStream<Uint8Array>, byteLength: number })`.
     Cap'n Web carries `ReadableStream` arguments with flow control (see its README,
     "Streaming with flow control"). `byteLength` is required on the stream form. A browser
     always knows a `File`'s size, which makes one-pass hashing possible, and the backend
     verifies it, so it is not trusted.
   - Rewrite the doc comment: no size limit; the stream form is for large content; the OID
     is returned after the whole stream is durably stored; a stream that ends early or
     overruns `byteLength` fails the call and stores no index row. The chunks it has already
     written may dangle, as with any interrupted write.
   - `Overseer.uploadBlob` dispatches to `writeBlob` or to
     `writeBlobStream(stream, byteLength)`, followed by the existing `storage.sync()`. The
     read-only role denial (~12665) still applies.
   - `@validateRpc()` must accept the union. If capnweb-validate can't express a stream
     inside an object, raise it rather than hand-roll validation (see commit 2 step 8).
   - Frontend: the composer sends
     `{ stream: blob.stream(), byteLength: blob.size }` for any blob above a small
     threshold, or always, whichever is simpler. Update the test double in
     `useComposerAttachments.test.tsx`. Chat attachments keep their 4 MiB caps, so this
     changes no visible behavior today. It makes the public API able to accept large
     content, and keeps the caller from needing a whole-file buffer when the caps are later
     raised. The frontend part is a small separate hunk; keep it in its own commit after
     commit 3 if reviewers prefer the kernel diff alone.
   - Integration test (`packages/integration-tests`, beside `workshop-lifecycle.test.ts`
     ~111): stream-upload content larger than `MAX_BUFFERED_BLOB_SIZE`, in odd-sized
     pieces. Check the oid, check that it equals the buffered upload's oid for the same
     bytes, and check that a `byteLength` mismatch fails.
7. **grep (`grep.ts`).**
   - For blobs over `MAX_BUFFERED_BLOB_SIZE` (chunked, or legacy inline over 1 MiB), stream
     the reader's pieces through a
     line-splitting matcher. Carry the partial last line across piece boundaries, and
     decode non-fatally. Treat the file as binary (skipped, with a note) if a NUL is seen,
     consistent with today's skip notes.
   - Small files are unchanged.
   - Don't add large files' text to the `files[]` array that holds all candidates (~138):
     match them in a separate streaming pass, so memory is bounded.
8. **Diffs.** `worktree-session.ts` `#changedFiles` (~342/370) and the agent's user-change
   diff (`agent.ts` ~1787) diff files of any size as text, as they do today. A large diff is
   slow; no size note is added. The existing `"binary content changed"` notes stay.
9. **Streamed `readFilesAtCommit` (the browser's file reads).**
   - Add a `FileAtCommit` variant for files over `MAX_BUFFERED_BLOB_SIZE`:
     `{ kind: "stream"; byteLength: number; content: ReadableStream<Uint8Array> }`, the
     blob's raw bytes. Smaller files keep `{ kind: "text" }`, decoded server-side as today.
     Doc-comment the variant: the caller must consume or cancel each stream; the server has
     not checked that the content is text.
   - Server: for a large regular file, return `blobByteStream(openLocalBlob(oid))`. Streamed
     files do not count toward `READ_FILES_RESPONSE_BUDGET` (their bytes don't travel in the
     response message); update that constant's doc. Symlinks and submodules stay
     `unreadable` as today.
   - Client (`commitFileStore.ts`): read the stream to the end and decode it with the same
     strict rules the server applies to small files (no NUL, valid UTF-8). Binary content
     becomes the same `unreadable` "is not a text file" entry the server would have sent, so
     the rest of the client sees no difference. Then cache the text as today. There is **no
     client-side size limit**: the editor displays the whole file. Worst case the tab runs
     out of memory and the user learns not to open that file; limits can be added later if
     that becomes a problem.
   - A stream that a caller abandons (for example, the store is disposed mid-read) must be
     cancelled.
   - `@validateRpc()` must accept a stream nested in the returned tuple; confirm, as for
     `GitCache.get` in commit 2.
10. **Whole-file paths.** Gadget loading, merges and `readCommitFiles` read files of any size
    whole, as after commit 2. Nothing to change; a test merges a 9 MB file.

### Tests (commit 3)

- **`readFileWindow` over blob sources:**
  - Windows across chunk boundaries.
  - A line spanning a boundary.
  - `N` with and without a final newline, including an empty file.
  - The continuation note.
  - The budget truncation rule.
  - `startLine` past the end.
  - A NUL inside the window (error naming the lines) versus a NUL just outside it (success).
  - Invalid UTF-8 renders as U+FFFD.
  - The giant-single-line truncation.
- **Equivalence property test:** for random NUL-free valid UTF-8 texts of various sizes,
  rendering from `{kind: "text"}` and from a stored blob of the same bytes gives
  byte-identical output for random windows.
- **Agent tool:**
  - An unpinned `readFile` window on a 50 MB file stored chunked doesn't materialize it
    (storage-read counter).
  - Replay of a pre-change recorded read is identical.
- **Large-file editing:** `editFile` on a 9 MB file succeeds and its change carries only the
  span; text `writeFile` of content over `MAX_CODE_CHANGE_SIZE` gives the "too large to make
  in one step" error that points at `writeBytes`, and `writeBytes` succeeds.
- **`readBytes`:** a ranged read in the middle of a chunked blob returns exactly the range;
  an invalid range errors; revocation mid-stream stops the stream.
- **`writeBytes`:** a stream of 30 MB arriving in odd-sized pieces. The oid equals the
  hash of the content, and the result is committed and read back.
- **grep:** a match spanning a chunk boundary in a large file is found; a large file with a
  NUL is skipped with a note.
- **Diff:** a 9 MB file's change is diffed as text.
- **`readFilesAtCommit`:** a 1 MiB file is `text`; a 1 MiB + 1 file is a `stream` whose bytes
  match; streamed files don't count toward the response budget. Client: a streamed text file
  is cached as text, a streamed binary file becomes `unreadable` "is not a text file", and a
  disposed store cancels its in-flight streams.

### Review checklist (commit 3)

- The readFile output is unchanged for every input that was readable before. Look for the
  equivalence and replay tests.
- The streaming paths listed in I6 never decode a large blob whole. The whole-file paths do,
  and none of them refuses a file for its size.
- The worktree binding `.d.ts` changes are documented, and the stream path is revocable.
- `uploadBlob`'s new form is doc-commented, has no "limited to 8,000,000 bytes" text left,
  and is verified against its declared `byteLength`.
- Every byte stream over a blob goes through `blobByteStream`. No code enqueues borrowed
  reader output (see "Buffer ownership").
- Agent-visible messages are clear and consistent with existing ones.
- Neither server nor client imposes a read-side size limit anywhere.

---

## Handoff notes

- **Order.** Commits depend strictly on one another: 0 → 1 → 2 → 3. Commit 0 is a cleanup
  that the rest builds on: commit 2's streaming inflate extends its `createInflate` path.
  An agent working on a later commit should start from the previous commit and read its
  module docs. Implementers may
  adjust APIs this plan only sketches (for example `PendingBlob`, the `resolveBase` shape),
  but must keep the locked decisions and invariants, and should note any deviation in the
  commit message.
- **Verification for each commit:**
  - `pnpm --filter @gadgets/workshop-backend test:run` while iterating, then `pnpm lint`
    and `pnpm test`.
  - Commit 2 also runs the gatekeeper-kit, GitHub and GitLab package tests.
  - Large-size tests should generate data deterministically (a seeded PRNG) and keep the
    default suite fast. Put the ~200 MB memory test where slow tests belong per
    `docs/testing.md`.
- **Kernel review bar** (see `AGENTS.md`):
  - Every new exported member in `workshop-shared` is doc-commented.
  - Reuse existing mechanisms; for example, `#putObject` stays the single parent-row writer.
  - No hand-written interface mirroring an RPC interface.
  - Keep `git-cache.ts` diffs focused. The new mechanics belong in `git-chunked-blob.ts` and
    `git-codec.ts`.
- **Docs to update** when done:
  - The header note of `plans/git-storage.md` ("Chunking is deferred").
  - `docs/chat-scratch-worktree.md`, if it mentions the 8 MB limit.
  - Any `docs/` page that cites `MAX_GIT_OBJECT_SIZE`; grep for "8,000,000" and "8 MB".
