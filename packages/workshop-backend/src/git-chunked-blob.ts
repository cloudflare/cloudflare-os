// Chunked blob storage: how the git store holds a blob too large for one storage row.
//
// A blob over CHUNK_MAX_SIZE is stored as an index row (GitChunkedBlobRecord, see
// storage-schema/overseer-storage.ts) naming its chunks, each an ordinary inline blob row in the
// same `gitObjects` collection, keyed by its own SHA-1. The index row is keyed by the whole
// blob's oid, the SHA-1 of `blob <size>\0<content>` exactly as git computes it, so chunking is
// invisible outside the store: to every gatekeeper and remote, a chunked blob is an ordinary
// blob. Chunks deduplicate against each other, against other versions of the file, and against
// real files with identical bytes.
//
// Chunk boundaries are content-defined (FastCDC; see ContentChunker), so an edit moves only the
// boundaries near it, and the rest of the file's chunks are shared with its previous version.
// They ignore newlines: a line may span chunks. Each index entry records the chunk's byte offset
// and its starting line, which lets BlobReader read a byte range, or find a line, inflating only
// the chunks it covers.
//
// This module is pure mechanism over a ChunkStore (`get`/`put` of object rows): the git store
// passes its `gitObjects` collection, tests a Map. Everything is synchronous, so a writer can be
// fed from inside an inflater's callbacks. Writing order is the store's invariant: a writer puts
// every chunk row before it hands back the index row for its caller to put, so an index row's
// presence implies its chunks'. A failure partway leaves only unreferenced chunk rows, which
// the store (having no GC) already tolerates for any interrupted write.

import type { Hash } from "node:crypto";
import type { GitOid } from "@gadgets/workshop-shared/gatekeeper";
import type {
  GitBlobChunk,
  GitChunkedBlobRecord,
  GitInlineObjectRecord,
  GitObjectRecord,
} from "./storage-schema/overseer-storage";
import { decodeLooseObject, encodeLooseObject, gitObjectHasher } from "./git-codec";

// =======================================================================================
// Format parameters
//
// These constants, the gear table and the cut rule below are part of the storage format.
// Changing them never breaks correctness -- rows are keyed by oid, and an index written under old
// parameters stays valid and readable -- but new writes would stop deduplicating against chunks
// written under the old ones. The golden tests in git-chunked-blob.test.ts pin them.

/** The smallest chunk the chunker cuts, but for a blob's final chunk. */
export const CHUNK_MIN_SIZE = 64 * 1024;

/** The chunk size the chunker aims for: 2^18. */
export const CHUNK_AVG_SIZE = 256 * 1024;

/**
 * The largest chunk, and the chunking threshold: a blob is stored chunked iff its size is over
 * this, so every newly written row holds at most about this much.
 */
export const CHUNK_MAX_SIZE = 1024 * 1024;

// The cut masks test the hash's *high* bits: with a left-shift gear hash, bit k depends only on
// the last k+1 bytes, so the top bits carry the ~32-byte window. The stricter mask applies before
// CHUNK_AVG_SIZE and the looser one after ("normalized chunking"), which narrows the spread of
// chunk sizes around the average.
const MASK_S = 0xFFFFF000;  // 20 bits
const MASK_L = 0xFFFF0000;  // 16 bits

const GEAR_SEED = 0x67616467;  // "gadg"

/**
 * The chunker's gear table: 256 pseudo-random 32-bit values, one per byte value. Generated with
 * splitmix32 seeded with 0x67616467, each entry being the next output of:
 *
 *     state = (state + 0x9e3779b9) mod 2^32
 *     z = imul32(state ^ (state >>> 16), 0x21f0aaad)
 *     z = imul32(z ^ (z >>> 15), 0x735a2d97)
 *     output = z ^ (z >>> 15)
 *
 * Exported for its golden test only.
 */
export const CHUNK_GEAR_TABLE: Uint32Array = (() => {
  let table = new Uint32Array(256);
  let state = GEAR_SEED;
  for (let i = 0; i < 256; i++) {
    state = (state + 0x9e3779b9) >>> 0;
    let z = Math.imul(state ^ (state >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    table[i] = (z ^ (z >>> 15)) >>> 0;
  }
  return table;
})();

// =======================================================================================
// Records and storage

/** Whether a `gitObjects` row is a chunked blob's index (rather than an inline object). */
export function isChunkedBlobRecord(record: GitObjectRecord): record is GitChunkedBlobRecord {
  return "chunks" in record;
}

/**
 * The object rows a writer stores chunks into and a reader reads them from. The git store passes
 * its `gitObjects` collection.
 */
export interface ChunkStore {
  get(oid: GitOid): GitObjectRecord | undefined;
  put(record: GitInlineObjectRecord): void;
}

// =======================================================================================
// ContentChunker

/**
 * Finds content-defined chunk boundaries: FastCDC with normalized chunking (Xia et al., 2016)
 * over a 32-bit gear hash, `h = ((h << 1) + gear[byte]) >>> 0`. For a chunk's byte at index i
 * (0-based within the chunk):
 *
 * - the first CHUNK_MIN_SIZE bytes are not hashed, and never cut after;
 * - the hash restarts at 0 at the first hashed byte of each chunk;
 * - for CHUNK_MIN_SIZE <= i < CHUNK_AVG_SIZE, cut after byte i if (h & MASK_S) === 0;
 * - for CHUNK_AVG_SIZE <= i < CHUNK_MAX_SIZE, cut after byte i if (h & MASK_L) === 0;
 * - a cut is forced after byte CHUNK_MAX_SIZE - 1, so no chunk is larger than CHUNK_MAX_SIZE;
 * - the final chunk is whatever remains, and may be shorter than CHUNK_MIN_SIZE.
 *
 * Push-style, so input may arrive in arbitrary pieces: the cuts depend on the bytes alone, never
 * on how they were split. After an edit, the cuts resynchronize at the first content-defined cut
 * more than CHUNK_MIN_SIZE past it, so an edit usually changes one or two chunks. That is a
 * probabilistic property of the content, not a guarantee.
 */
export class ContentChunker {
  #offset = 0;   // absolute offset of the next byte pushed
  #inChunk = 0;  // bytes of the current chunk pushed so far
  #hash = 0;

  /** Consumes `bytes`, returning the absolute offsets of the cuts found in them, ascending. */
  push(bytes: Uint8Array): number[] {
    let cuts: number[] = [];
    let gear = CHUNK_GEAR_TABLE;
    let h = this.#hash;
    let i = this.#inChunk;
    let p = 0;
    let n = bytes.length;
    while (p < n) {
      if (i < CHUNK_MIN_SIZE) {
        let skip = Math.min(CHUNK_MIN_SIZE - i, n - p);
        i += skip;
        p += skip;
        continue;
      }
      let mask = i < CHUNK_AVG_SIZE ? MASK_S : MASK_L;
      let limit = Math.min(n, p + (i < CHUNK_AVG_SIZE ? CHUNK_AVG_SIZE : CHUNK_MAX_SIZE) - i);
      let cut = false;
      while (p < limit) {
        h = ((h << 1) + gear[bytes[p]]) >>> 0;
        p++;
        i++;
        if ((h & mask) === 0) {
          cut = true;
          break;
        }
      }
      if (cut || i === CHUNK_MAX_SIZE) {
        cuts.push(this.#offset + p);
        i = 0;
        h = 0;
      }
    }
    this.#offset += n;
    this.#inChunk = i;
    this.#hash = h;
    return cuts;
  }

  /**
   * Ends the input, returning the end offset of the final chunk, or undefined when there is no
   * final chunk: the input was empty, or ended exactly at a cut.
   */
  finish(): number | undefined {
    return this.#inChunk > 0 ? this.#offset : undefined;
  }
}

// =======================================================================================
// BlobWriter

/**
 * What `BlobWriter.finish()` produced, for the caller to store. Either way the chunk rows, if
 * any, are already stored; the parent row is the caller's to write (inside its own transaction,
 * together with any metadata, and skipped if the oid is already held).
 */
export type PendingBlob =
  /** The blob is at most CHUNK_MAX_SIZE: store it inline as an ordinary blob. No row was written. */
  | { oid: GitOid, size: number, payload: Uint8Array, record?: undefined }
  /** The blob was stored as chunks: `record` is the index row to put. */
  | { oid: GitOid, size: number, record: GitChunkedBlobRecord, payload?: undefined };

/**
 * Streams one blob into a ChunkStore as chunks (see the module doc). Synchronous throughout, and
 * memory-bounded: it buffers at most CHUNK_MAX_SIZE of not-yet-written input, copying what it is
 * given (so a caller may pass borrowed or reused buffers). Each chunk row is put as soon as the
 * chunk is cut, unless a row for its oid exists; nothing here opens a transaction, so callers
 * must not wrap a write of unbounded size in one either.
 *
 * A blob of at most CHUNK_MAX_SIZE is never chunked: it comes back whole from `finish()`, and
 * nothing is written.
 */
export class BlobWriter {
  readonly #store: ChunkStore;
  readonly #declaredSize: number | undefined;
  readonly #hasher: Hash | undefined;
  readonly #chunker = new ContentChunker();
  readonly #buffer: Uint8Array;
  #bufferStart = 0;   // absolute offset of #buffer[0]; always a cut
  #bufferLength = 0;
  #cuts: number[] = [];  // cuts within the buffer not yet written, absolute
  #chunks: GitBlobChunk[] = [];
  #newlines = 0;      // in the chunks written so far
  #size = 0;
  #finished = false;

  /**
   * With `declaredSize`, the whole blob's oid is hashed as bytes arrive, and a write past it, or
   * a `finish()` short of it, throws. Without one -- for content of unknown length -- `finish()`
   * hashes in a second pass over the chunks just written, re-reading and inflating them, which
   * costs roughly double the CPU.
   */
  constructor(store: ChunkStore, declaredSize?: number) {
    if (declaredSize !== undefined && !(Number.isSafeInteger(declaredSize) && declaredSize >= 0)) {
      throw new RangeError(`invalid blob size: ${declaredSize}`);
    }
    this.#store = store;
    this.#declaredSize = declaredSize;
    this.#hasher = declaredSize === undefined ? undefined : gitObjectHasher("blob", declaredSize);
    this.#buffer = new Uint8Array(Math.min(declaredSize ?? CHUNK_MAX_SIZE, CHUNK_MAX_SIZE));
  }

  /** Appends `bytes` to the blob. */
  write(bytes: Uint8Array): void {
    if (this.#finished) throw new Error("BlobWriter.write() after finish()");
    if (this.#declaredSize !== undefined && this.#size + bytes.length > this.#declaredSize) {
      throw new Error(`blob is larger than its declared size of ${this.#declaredSize} bytes`);
    }
    this.#hasher?.update(bytes);
    let pos = 0;
    while (pos < bytes.length) {
      // A full buffer holds at least one cut, since its start is a cut and no chunk is larger
      // than the buffer, so writing out its chunks always makes room.
      if (this.#bufferLength === this.#buffer.length) this.#flush();
      let take = Math.min(this.#buffer.length - this.#bufferLength, bytes.length - pos);
      let piece = bytes.subarray(pos, pos + take);
      this.#buffer.set(piece, this.#bufferLength);
      for (let cut of this.#chunker.push(piece)) this.#cuts.push(cut);
      this.#bufferLength += take;
      pos += take;
    }
    this.#size += bytes.length;
  }

  /** Ends the blob. See PendingBlob for what the caller must store. */
  finish(): PendingBlob {
    if (this.#finished) throw new Error("BlobWriter.finish() called twice");
    this.#finished = true;
    let size = this.#size;
    if (this.#declaredSize !== undefined && size !== this.#declaredSize) {
      throw new Error(`blob is smaller than its declared size of ${this.#declaredSize} bytes`);
    }

    if (this.#chunks.length === 0) {
      // Nothing was ever flushed, so the whole blob is in the buffer, and is at most
      // CHUNK_MAX_SIZE (any more would have forced a flush).
      let payload = this.#buffer.subarray(0, this.#bufferLength);
      let oid = (this.#hasher ?? gitObjectHasher("blob", size).update(payload)).digest("hex");
      return { oid, size, payload };
    }

    this.#flush();
    if (this.#bufferLength > 0) {
      this.#writeChunk(this.#bufferStart, this.#buffer.subarray(0, this.#bufferLength));
    }
    let chunks = this.#chunks;
    let oid: GitOid;
    if (this.#hasher !== undefined) {
      oid = this.#hasher.digest("hex");
    } else {
      let hasher = gitObjectHasher("blob", size);
      let reader = new BlobReader(this.#store, "(pending)", size, chunks, this.#newlines);
      for (let piece of reader.pieces()) hasher.update(piece);
      oid = hasher.digest("hex");
    }
    return { oid, size, record: { oid, size, newlines: this.#newlines, chunks } };
  }

  // Writes every chunk the buffer holds a cut for, then moves the rest to its start.
  #flush(): void {
    let start = 0;
    for (let cut of this.#cuts) {
      let end = cut - this.#bufferStart;
      this.#writeChunk(this.#bufferStart + start, this.#buffer.subarray(start, end));
      start = end;
    }
    this.#cuts = [];
    this.#buffer.copyWithin(0, start, this.#bufferLength);
    this.#bufferLength -= start;
    this.#bufferStart += start;
  }

  #writeChunk(offset: number, payload: Uint8Array): void {
    let oid = gitObjectHasher("blob", payload.length).update(payload).digest("hex");
    this.#chunks.push({ oid, offset, line: this.#newlines });
    this.#newlines += countNewlines(payload);
    if (this.#store.get(oid) === undefined) {
      this.#store.put({ oid, data: encodeLooseObject("blob", payload) });
    }
  }
}

// =======================================================================================
// BlobReader

// How many inflated chunks a reader keeps, so that sequential reads and a delta's nearby copies
// don't re-inflate.
const CHUNK_CACHE_SIZE = 4;

const NEWLINE = 0x0a;

/**
 * Random access to a stored blob's payload, inline or chunked alike, inflating only the chunks a
 * read covers. An inline row reads as a single chunk at offset 0, line 0 (a legacy row of up to
 * 8 MB stays one inflate).
 *
 * Every Uint8Array a reader returns is *borrowed*: it may be a view into a cached inflated
 * chunk, shared with other results and later reads. The reader never mutates one, so keeping a
 * borrowed view and reading it later is fine, but it must never be *transferred* -- enqueued
 * into a `type: "bytes"` ReadableStream, put in a structuredClone/postMessage transfer list, or
 * passed to `ArrayBuffer.prototype.transfer` -- since that detaches the whole underlying buffer,
 * emptying the cache entry and every other view of it. Code that transfers copies first; byte
 * streams over a blob are made only by `blobByteStream()`, which does.
 */
export class BlobReader {
  /** Opens a blob's row. Throws if the row is an inline object other than a blob. */
  static open(store: ChunkStore, record: GitObjectRecord): BlobReader {
    if (isChunkedBlobRecord(record)) {
      return new BlobReader(store, record.oid, record.size, record.chunks, record.newlines);
    }
    let object = decodeLooseObject(record.data);
    if (object.type !== "blob") {
      throw new Error(`git object ${record.oid} is a ${object.type}, not a blob`);
    }
    let reader = new BlobReader(store, record.oid, object.payload.length,
        [{ oid: record.oid, offset: 0, line: 0 }], undefined);
    reader.#cache.set(0, object.payload);
    return reader;
  }

  /** The payload's byte length. */
  readonly size: number;

  readonly #store: ChunkStore;
  readonly #oid: GitOid;
  readonly #chunks: readonly GitBlobChunk[];
  #newlines: number | undefined;
  readonly #cache = new Map<number, Uint8Array>();  // chunk index -> payload, oldest first

  /** @internal Use `BlobReader.open()`. */
  constructor(store: ChunkStore, oid: GitOid, size: number, chunks: readonly GitBlobChunk[],
              newlines: number | undefined) {
    this.#store = store;
    this.#oid = oid;
    this.size = size;
    this.#chunks = chunks;
    this.#newlines = newlines;
  }

  /** The payload's total number of `\n` bytes. For an inline row, counted on first access. */
  get newlines(): number {
    return this.#newlines ??= countNewlines(this.#chunk(0));
  }

  /** The `length` bytes at `offset` (borrowed; see the class doc). Throws if out of bounds. */
  read(offset: number, length: number): Uint8Array {
    this.#checkRange(offset, length);
    if (length === 0) return new Uint8Array();
    let index = this.#chunkAt(offset);
    let chunk = this.#chunk(index);
    let start = offset - this.#chunks[index].offset;
    if (start + length <= chunk.length) return chunk.subarray(start, start + length);
    let out = new Uint8Array(length);
    let filled = 0;
    for (let piece of this.#pieces(offset, offset + length)) {
      out.set(piece, filled);
      filled += piece.length;
    }
    return out;
  }

  /**
   * The payload, or the byte range given, in order, in non-empty pieces of at most one chunk
   * each (borrowed; see the class doc). Throws at once if the range is out of bounds.
   */
  pieces(range?: { offset: number, length: number }): Iterable<Uint8Array> {
    let { offset, length } = range ?? { offset: 0, length: this.size };
    this.#checkRange(offset, length);
    return this.#pieces(offset, offset + length);
  }

  /**
   * The byte offset at which 0-based line `line` starts, for 0 <= line <= newlines: 0 for line
   * 0, else just past the line'th `\n`. (Line `newlines` is the one after the last `\n`, which
   * starts at `size` when the payload ends with one.)
   */
  lineStart(line: number): number {
    if (!Number.isSafeInteger(line) || line < 0 || line > this.newlines) {
      throw new RangeError(`line ${line} is out of range for blob ${this.#oid} ` +
          `(${this.newlines} newlines)`);
    }
    if (line === 0) return 0;
    // The line'th newline is in the *last* chunk whose `line` is below it. (Several chunks may
    // share one `line` value, where one line spans them all, so the last chunk with
    // `line <= n` would be the wrong one.) chunks[0].line is 0, so there is one.
    let lo = 0;
    let hi = this.#chunks.length - 1;
    while (lo < hi) {
      let mid = (lo + hi + 1) >> 1;
      if (this.#chunks[mid].line < line) lo = mid; else hi = mid - 1;
    }
    let chunk = this.#chunk(lo);
    let pos = -1;
    for (let k = line - this.#chunks[lo].line; k > 0; k--) {
      pos = chunk.indexOf(NEWLINE, pos + 1);
      if (pos < 0) throw this.#corrupt();
    }
    return this.#chunks[lo].offset + pos + 1;
  }

  *#pieces(start: number, end: number): Generator<Uint8Array> {
    if (start === end) return;
    for (let index = this.#chunkAt(start), pos = start; pos < end; index++) {
      let chunkOffset = this.#chunks[index].offset;
      let chunk = this.#chunk(index);
      let piece = chunk.subarray(pos - chunkOffset, Math.min(chunk.length, end - chunkOffset));
      pos += piece.length;
      yield piece;
    }
  }

  #checkRange(offset: number, length: number): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 ||
        length < 0 || offset + length > this.size) {
      throw new RangeError(`byte range ${offset}+${length} is out of bounds for blob ` +
          `${this.#oid} of ${this.size} bytes`);
    }
  }

  // The index of the chunk holding byte `offset` (offset < size): the last chunk starting at or
  // before it.
  #chunkAt(offset: number): number {
    let lo = 0;
    let hi = this.#chunks.length - 1;
    while (lo < hi) {
      let mid = (lo + hi + 1) >> 1;
      if (this.#chunks[mid].offset <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  #chunkSize(index: number): number {
    let next = this.#chunks[index + 1];
    return (next?.offset ?? this.size) - this.#chunks[index].offset;
  }

  // A chunk's inflated payload, through the LRU cache. A chunk must be an inline blob of exactly
  // the size the index implies; anything else is storage corruption.
  #chunk(index: number): Uint8Array {
    let cached = this.#cache.get(index);
    if (cached !== undefined) {
      // A detached buffer reads as empty; fail loudly rather than return wrong bytes.
      if (cached.length !== this.#chunkSize(index)) {
        throw new Error(`a borrowed view of blob ${this.#oid} was transferred`);
      }
      this.#cache.delete(index);
      this.#cache.set(index, cached);
      return cached;
    }
    let record = this.#store.get(this.#chunks[index].oid);
    if (record === undefined || isChunkedBlobRecord(record)) throw this.#corrupt();
    let object = decodeLooseObject(record.data);
    if (object.type !== "blob" || object.payload.length !== this.#chunkSize(index)) {
      throw this.#corrupt();
    }
    this.#cache.set(index, object.payload);
    if (this.#cache.size > CHUNK_CACHE_SIZE) {
      this.#cache.delete(this.#cache.keys().next().value!);
    }
    return object.payload;
  }

  #corrupt(): Error {
    return new Error(`corrupt chunked blob ${this.#oid}`);
  }
}

/**
 * A byte stream of a blob's payload, or of the byte range given: a `type: "bytes"` stream with
 * `highWaterMark: 0`, which yields one piece per pull, *copied* from the reader's borrowed
 * output (see BlobReader). Every byte stream over a blob is made here, so that no code enqueues
 * borrowed reader output. `onPull`, if given, runs before each piece is read; if it throws, the
 * stream errors with what it threw (for revocation).
 */
export function blobByteStream(reader: BlobReader, range?: { offset: number, length: number },
                               onPull?: () => void): ReadableStream<Uint8Array> {
  let pieces = reader.pieces(range)[Symbol.iterator]();
  return new ReadableStream({
    type: "bytes",
    pull(controller) {
      onPull?.();
      let next = pieces.next();
      if (next.done) {
        controller.close();
        controller.byobRequest?.respond(0);
      } else {
        controller.enqueue(next.value.slice());
      }
    },
    cancel() {
      pieces.return?.();
    },
  }, { highWaterMark: 0 });
}

/**
 * Reads a byte stream to its end in pieces, for feeding a BlobWriter (which copies what it is
 * given). A stream that supports BYOB reads is read into one reused buffer of `pieceSize` bytes,
 * so each piece is valid only until the next is requested; any other stream (a stream that
 * arrived over Cap'n Web may be one) is read with a default reader, in whatever pieces it
 * delivers. If the consumer stops early -- it threw, say, on a length mismatch -- the stream is
 * cancelled.
 */
export async function* readStreamPieces(stream: ReadableStream<Uint8Array>,
                                        pieceSize = 64 * 1024): AsyncGenerator<Uint8Array> {
  let byob: ReadableStreamBYOBReader | undefined;
  try {
    byob = stream.getReader({ mode: "byob" });
  } catch {
    // Not a byte stream: fall through to a default reader.
  }
  let reader = byob ?? stream.getReader();
  let done = false;
  try {
    let buffer = new ArrayBuffer(pieceSize);
    for (;;) {
      let result = byob !== undefined
          ? await byob.read(new Uint8Array(buffer, 0, pieceSize))
          : await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
      if (result.done) {
        done = true;
        return;
      }
      if (byob !== undefined) buffer = result.value.buffer as ArrayBuffer;
      if (result.value.byteLength > 0) yield result.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function countNewlines(bytes: Uint8Array): number {
  let count = 0;
  for (let pos = bytes.indexOf(NEWLINE); pos >= 0; pos = bytes.indexOf(NEWLINE, pos + 1)) count++;
  return count;
}
