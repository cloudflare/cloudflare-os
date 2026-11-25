import type { KvScannable } from "./kv";
import { requirePositiveInt } from "./positive-int";

/** Bytes per stored action-file chunk, well under Durable Object storage's 8 MB key-and-value limit. */
export const ACTION_FILE_CHUNK_BYTES = 1024 * 1024;

/** Bounded integrity metadata stored with a queued action instead of its file bytes. */
export type ActionFileReference = {
  /** Opaque handle for private Durable Object storage. */
  readonly handle: string;
  /** Exact file size in bytes. */
  readonly size: number;
  /** SHA-256 digest of the file bytes. */
  readonly digest: string;
};

/** Storage keys and byte limits for an action-file store. */
export type ActionFileStoreOptions = {
  /** Prefix for manifests and chunks. */
  readonly filePrefix: string;
  /** Disjoint prefix for allocation records and aggregate accounting. */
  readonly allocationPrefix: string;
  /** Maximum bytes in one file. */
  readonly maxFileBytes: number;
  /** Maximum aggregate file bytes retained by this store. */
  readonly maxTotalBytes: number;
};

/** Transactional Durable Object storage used by an action-file store. */
export type ActionFileStorage = {
  /** Synchronous KV storage for file records. */
  readonly kv: KvScannable;
  /** Runs file writes and accounting changes atomically. */
  transactionSync<T>(callback: () => T): T;
};

type ActionFileManifest = ActionFileReference & {
  version: 1;
  chunks: number;
};

type ActionFileAllocation = {
  version: 1;
  size: number;
  chunks: number;
  /** When the capture began, which for a streamed capture is before its last chunk was stored. */
  createdAt: number;
};

const HANDLE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRUPTED = "The stored queued-action file is incomplete or corrupted.";

/** Chunk keys carry four-digit indices, which sort in index order only up to this many chunks. */
const MAX_CHUNKS = 10_000;

/**
 * Stores queued-action files as bounded, integrity-checked Durable Object KV chunks.
 *
 * Each file is a manifest plus 1 MiB chunks under `filePrefix`, and an allocation record under
 * `allocationPrefix` that feeds the aggregate `totalBytes` counter. `capture()` writes all of them
 * in one transaction. `captureStream()` writes each chunk with its allocation and counter in one,
 * and the manifest last, so a file is read only once it is whole. A delete removes them in one
 * transaction, so the store's own records are trusted as consistent; storage that has been edited
 * behind its back is outside its guarantees.
 */
export class ActionFileStore {
  readonly #storage: ActionFileStorage;
  readonly #filePrefix: string;
  readonly #allocationPrefix: string;
  readonly #totalKey: string;
  readonly #maxFileBytes: number;
  readonly #maxTotalBytes: number;

  /**
   * Creates an action-file store.
   * @param storage Transactional Durable Object storage.
   * @param options Storage keys and byte limits.
   */
  constructor(storage: ActionFileStorage, options: ActionFileStoreOptions) {
    this.#storage = storage;
    this.#filePrefix = options.filePrefix;
    this.#allocationPrefix = options.allocationPrefix;
    this.#totalKey = `${this.#allocationPrefix}totalBytes`;
    this.#maxFileBytes = requirePositiveInt("maxFileBytes", options.maxFileBytes);
    if (this.#maxFileBytes > MAX_CHUNKS * ACTION_FILE_CHUNK_BYTES) {
      throw new Error(`maxFileBytes must be at most ${MAX_CHUNKS * ACTION_FILE_CHUNK_BYTES}.`);
    }
    this.#maxTotalBytes = requirePositiveInt("maxTotalBytes", options.maxTotalBytes);
  }

  /**
   * Captures exact file bytes and returns bounded integrity metadata.
   * @param bytes File bytes to retain.
   * @returns A reference suitable for a queued-action payload.
   */
  async capture(bytes: Uint8Array): Promise<ActionFileReference> {
    const size = bytes.byteLength;
    this.#refuseOver(size);

    // WebCrypto snapshots its input synchronously, and each chunk is copied (`slice()` on a Node
    // Buffer would alias) before the await, so caller mutation afterwards cannot skew either.
    const digest = crypto.subtle.digest("SHA-256", bytes);
    const chunks: Uint8Array[] = [];
    for (let start = 0; start < size; start += ACTION_FILE_CHUNK_BYTES) {
      chunks.push(Uint8Array.from(bytes.subarray(start, start + ACTION_FILE_CHUNK_BYTES)));
    }
    const file: ActionFileReference = { handle: crypto.randomUUID(), size, digest: hex(await digest) };

    this.#storage.transactionSync(() => {
      const total = this.#totalWith(size);
      this.#storage.kv.put<ActionFileAllocation>(this.#allocationKey(file.handle), {
        version: 1, size, chunks: chunks.length, createdAt: Date.now(),
      });
      this.#storage.kv.put<ActionFileManifest>(this.#manifestKey(file.handle), {
        ...file, version: 1, chunks: chunks.length,
      });
      chunks.forEach((chunk, index) => this.#storage.kv.put(this.#chunkKey(file.handle, index), chunk));
      this.#storage.kv.put(this.#totalKey, total);
    });
    return file;
  }

  /**
   * Captures a stream's bytes as they arrive, storing a chunk at a time. Beside the piece the stream
   * last gave, whose size is the stream's to choose, it holds one chunk of its own and a copy of the
   * rest of a piece that spills into the next chunk. A piece is copied when the capture reads it,
   * not when it is enqueued, so a producer must leave an enqueued piece unchanged until then or
   * enqueue a copy; with `highWaterMark: 0`, reusing a buffer in the next `pull()` is safe.
   * Until it resolves, the chunks stored so far count toward `maxTotalBytes` under an allocation
   * dated when the capture began, which `pruneUnreferenced()` may delete, failing the capture.
   * If the stream errors, gives more than `maxFileBytes` or anything but `Uint8Array` chunks, or
   * would take the store past `maxTotalBytes`, the capture fails and keeps nothing, and the stream
   * is cancelled without the failure waiting for the cancel to settle. Needs workerd's
   * `crypto.DigestStream`; without it, the capture rejects and leaves `content` unlocked.
   * @param content File bytes to retain.
   * @returns A reference suitable for a queued-action payload.
   */
  async captureStream(content: ReadableStream<Uint8Array>): Promise<ActionFileReference> {
    const handle = crypto.randomUUID();
    const startedAt = Date.now();
    const digest = new crypto.DigestStream("SHA-256");
    const hashing = digest.getWriter();
    // Locked last, so a digest that cannot be set up leaves the source as it was given.
    const reader = content.getReader();
    let size = 0;
    let chunks = 0;
    let chunk = new Uint8Array(ACTION_FILE_CHUNK_BYTES);
    let filled = 0;
    const store = async (bytes: Uint8Array): Promise<void> => {
      await hashing.write(bytes);
      this.#storeChunk(handle, startedAt, chunks++, bytes);
    };
    try {
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        const given: unknown = read.value;
        if (!(given instanceof Uint8Array)) {
          throw new TypeError("A queued-action file stream must give Uint8Array chunks.");
        }
        size += given.byteLength;
        this.#refuseOver(size);
        // Copied into chunks of our own, and the rest of a piece that spills into the next chunk is
        // copied before the capture first yields, so a producer reusing the buffer cannot skew it.
        let piece = given;
        for (let offset = 0; offset < piece.byteLength;) {
          const taken = Math.min(ACTION_FILE_CHUNK_BYTES - filled, piece.byteLength - offset);
          chunk.set(piece.subarray(offset, offset + taken), filled);
          filled += taken;
          offset += taken;
          if (filled === ACTION_FILE_CHUNK_BYTES) {
            if (piece === given && offset < piece.byteLength) {
              piece = new Uint8Array(piece.subarray(offset));
              offset = 0;
            }
            await store(chunk);
            chunk = new Uint8Array(ACTION_FILE_CHUNK_BYTES);
            filled = 0;
          }
        }
      }
      // Storage clones a view's whole buffer, so the last chunk is copied to its own length.
      if (filled > 0) await store(chunk.slice(0, filled));
      await hashing.close();
      const file: ActionFileReference = { handle, size, digest: hex(await digest.digest) };
      this.#storeManifest(file, startedAt, chunks);
      return file;
    } catch (error) {
      try {
        this.#delete(handle);
      } finally {
        // Started, not awaited, and even when cleanup fails: the producer's cancel may never
        // settle, and neither the refusal nor the freed chunks wait on it. A stream that failed by
        // itself refuses the cancel. The unfinished digest is left to be collected: aborting it
        // would reject its `digest` unheard.
        reader.cancel(error).catch(() => {});
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Reassembles a captured file after checking its manifest, chunks, size, and digest. It holds
   * every stored chunk and the reassembled file at once, about twice the file's size, so a large
   * file is read with `readStream()` instead.
   * @param file Stored file reference.
   * @returns The exact captured bytes.
   */
  async read(file: ActionFileReference): Promise<Uint8Array> {
    const manifest = this.#manifest(file);

    const entries = [...this.#storage.kv.list<unknown>({ prefix: this.#chunkPrefix(file.handle) })]
      .toSorted(([left], [right]) => left.localeCompare(right));
    if (entries.length !== manifest.chunks) throw new Error(CORRUPTED);

    const bytes = new Uint8Array(manifest.size);
    let offset = 0;
    for (const [index, [key, chunk]] of entries.entries()) {
      const expectedSize = Math.min(ACTION_FILE_CHUNK_BYTES, manifest.size - offset);
      if (key !== this.#chunkKey(file.handle, index) || !(chunk instanceof Uint8Array) ||
          chunk.byteLength !== expectedSize) {
        throw new Error(CORRUPTED);
      }
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== manifest.size ||
        hex(await crypto.subtle.digest("SHA-256", bytes)) !== manifest.digest) {
      throw new Error(CORRUPTED);
    }
    return bytes;
  }

  /**
   * Streams a captured file a stored chunk at a time, so it is never held whole, refusing first,
   * as `read()` does, a reference its manifest disagrees with or a chunk stored after the last its
   * manifest names. Each chunk's size is checked as it is read, and the whole file's digest before
   * the final chunk is given: a stream that errors gave an incomplete or corrupted file, and never
   * its final chunk, so a consumer that commits on the last byte, such as a resumable upload,
   * commits nothing. A chunk is read only when the consumer asks for one. Needs workerd's
   * `crypto.DigestStream`.
   * @param file Stored file reference.
   * @returns The exact captured bytes, streamed.
   */
  async readStream(file: ActionFileReference): Promise<ReadableStream<Uint8Array>> {
    const manifest = this.#manifest(file);
    const extra = this.#storage.kv.list({
      prefix: this.#chunkPrefix(file.handle), limit: 1,
      ...manifest.chunks > 0 ? { startAfter: this.#chunkKey(file.handle, manifest.chunks - 1) } : {},
    });
    if ([...extra].length > 0) throw new Error(CORRUPTED);

    const digest = new crypto.DigestStream("SHA-256");
    const hashing = digest.getWriter();
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull: async controller => {
        let chunk: Uint8Array | undefined;
        if (index < manifest.chunks) {
          const stored = this.#storage.kv.get<unknown>(this.#chunkKey(manifest.handle, index));
          const expectedSize = Math.min(
            ACTION_FILE_CHUNK_BYTES, manifest.size - index * ACTION_FILE_CHUNK_BYTES);
          if (!(stored instanceof Uint8Array) || stored.byteLength !== expectedSize) {
            throw new Error(CORRUPTED);
          }
          chunk = stored;
          await hashing.write(chunk);
          index++;
          if (index < manifest.chunks) {
            controller.enqueue(chunk);
            return;
          }
        }
        await hashing.close();
        if (hex(await digest.digest) !== manifest.digest) throw new Error(CORRUPTED);
        if (chunk) controller.enqueue(chunk);
        controller.close();
      },
    }, { highWaterMark: 0 });
  }

  /**
   * Deletes a file's chunks and releases its aggregate allocation. Invalid references are ignored.
   * @param file File reference to delete, if present.
   */
  delete(file: ActionFileReference | undefined): void {
    if (validReference(file)) this.#delete(file.handle);
  }

  /**
   * Deletes old allocations not referenced by a live action or another consumer-owned resource.
   * @param referencedHandles Handles that remain live.
   * @param createdBefore Delete unreferenced allocations created at or before this timestamp.
   */
  pruneUnreferenced(referencedHandles: ReadonlySet<string>, createdBefore: number): void {
    const orphaned: string[] = [];
    for (const [key, value] of this.#storage.kv.list<unknown>({ prefix: this.#allocationPrefix })) {
      const handle = key.slice(this.#allocationPrefix.length);
      if (validAllocation(value) && value.createdAt <= createdBefore &&
          HANDLE_PATTERN.test(handle) && !referencedHandles.has(handle)) {
        orphaned.push(handle);
      }
    }
    for (const handle of orphaned) this.#delete(handle);
  }

  #manifestKey(handle: string): string {
    return `${this.#filePrefix}${handle}:manifest`;
  }

  #allocationKey(handle: string): string {
    return `${this.#allocationPrefix}${handle}`;
  }

  #chunkPrefix(handle: string): string {
    return `${this.#filePrefix}${handle}:chunk:`;
  }

  #chunkKey(handle: string, index: number): string {
    return `${this.#chunkPrefix(handle)}${String(index).padStart(4, "0")}`;
  }

  #refuseOver(size: number): void {
    if (size > this.#maxFileBytes) {
      throw new Error(
        `Cannot retain a queued-action file larger than ${this.#maxFileBytes} bytes.`);
    }
  }

  /** The aggregate counter once `size` more bytes count, refusing what would pass the limit. */
  #totalWith(size: number): number {
    const total = this.#storage.kv.get<unknown>(this.#totalKey) ?? 0;
    if (!Number.isSafeInteger(total) || (total as number) < 0) {
      throw new Error("Stored queued-action file accounting is invalid.");
    }
    if ((total as number) + size > this.#maxTotalBytes) {
      throw new Error(
        "Queued-action files exceed the safe aggregate storage limit. " +
        "Resolve existing actions before adding another.");
    }
    return (total as number) + size;
  }

  /** The manifest of a whole capture, which `file` must agree with. */
  #manifest(file: ActionFileReference): ActionFileManifest {
    if (!validReference(file)) {
      throw new Error(
        "This queued action uses an obsolete file reference. Reject and resubmit it.");
    }
    const manifest = this.#storage.kv.get<unknown>(this.#manifestKey(file.handle));
    if (!validManifest(manifest) || manifest.handle !== file.handle ||
        manifest.size !== file.size || manifest.digest !== file.digest) {
      throw new Error(CORRUPTED);
    }
    return manifest;
  }

  /**
   * The allocation a streamed capture begun at `startedAt` has written so far, which has `chunks`
   * chunks of `size` bytes in all, or a new one for a capture that has written none.
   */
  #captured(handle: string, startedAt: number, chunks: number, size: number): ActionFileAllocation {
    if (chunks === 0) return { version: 1, size: 0, chunks: 0, createdAt: startedAt };
    const allocation = this.#storage.kv.get<unknown>(this.#allocationKey(handle));
    if (allocation === undefined) {
      throw new Error("The queued-action file was deleted while it was being captured.");
    }
    if (!validAllocation(allocation) || allocation.chunks !== chunks || allocation.size !== size) {
      throw new Error(CORRUPTED);
    }
    return allocation;
  }

  /** Stores chunk `index` of a streamed capture, whose earlier chunks are all whole, and counts it. */
  #storeChunk(handle: string, startedAt: number, index: number, chunk: Uint8Array): void {
    this.#storage.transactionSync(() => {
      const allocation = this.#captured(handle, startedAt, index, index * ACTION_FILE_CHUNK_BYTES);
      const total = this.#totalWith(chunk.byteLength);
      this.#storage.kv.put<ActionFileAllocation>(this.#allocationKey(handle), {
        ...allocation, size: allocation.size + chunk.byteLength, chunks: index + 1,
      });
      this.#storage.kv.put(this.#chunkKey(handle, index), chunk);
      this.#storage.kv.put(this.#totalKey, total);
    });
  }

  /** Completes a streamed capture of `chunks` stored chunks, which an empty file starts as well. */
  #storeManifest(file: ActionFileReference, startedAt: number, chunks: number): void {
    this.#storage.transactionSync(() => {
      const allocation = this.#captured(file.handle, startedAt, chunks, file.size);
      if (chunks === 0) {
        this.#storage.kv.put(this.#totalKey, this.#totalWith(0));
        this.#storage.kv.put<ActionFileAllocation>(this.#allocationKey(file.handle), allocation);
      }
      this.#storage.kv.put<ActionFileManifest>(this.#manifestKey(file.handle), {
        ...file, version: 1, chunks,
      });
    });
  }

  #delete(handle: string): void {
    this.#storage.transactionSync(() => {
      const allocation = this.#storage.kv.get<unknown>(this.#allocationKey(handle));
      // An allocation counts every chunk the store has written, a capture cut short included, so
      // those go by key and a large file is not read back to be deleted. The scan then reads only
      // chunks it does not count, which exist only in storage edited behind the store's back, and
      // takes them all from a damaged allocation claiming more chunks than the key format holds.
      if (validAllocation(allocation) && allocation.chunks <= MAX_CHUNKS) {
        for (let index = 0; index < allocation.chunks; index++) {
          this.#storage.kv.delete(this.#chunkKey(handle, index));
        }
      }
      for (const [key] of this.#storage.kv.list({ prefix: this.#chunkPrefix(handle) })) {
        this.#storage.kv.delete(key);
      }
      this.#storage.kv.delete(this.#manifestKey(handle));
      this.#storage.kv.delete(this.#allocationKey(handle));

      // The allocation record is the accounting unit: without one, nothing was ever counted. A
      // counter that is already invalid is left as is, so a capture keeps failing closed on it.
      const total = this.#storage.kv.get<unknown>(this.#totalKey);
      if (validAllocation(allocation) && Number.isSafeInteger(total) && (total as number) >= 0) {
        this.#storage.kv.put(this.#totalKey, Math.max(0, (total as number) - allocation.size));
      }
    });
  }
}

function validReference(value: unknown): value is ActionFileReference {
  if (!value || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  return typeof file.handle === "string" && HANDLE_PATTERN.test(file.handle) &&
    Number.isSafeInteger(file.size) && (file.size as number) >= 0 &&
    typeof file.digest === "string" && /^[0-9a-f]{64}$/.test(file.digest);
}

function validChunkCount(record: { size: number; chunks: unknown }): boolean {
  return record.chunks === Math.ceil(record.size / ACTION_FILE_CHUNK_BYTES);
}

function validManifest(value: unknown): value is ActionFileManifest {
  if (!validReference(value)) return false;
  const manifest = value as ActionFileManifest;
  return manifest.version === 1 && validChunkCount(manifest);
}

function validAllocation(value: unknown): value is ActionFileAllocation {
  if (!value || typeof value !== "object") return false;
  const allocation = value as ActionFileAllocation;
  return allocation.version === 1 &&
    Number.isSafeInteger(allocation.size) && allocation.size >= 0 && validChunkCount(allocation) &&
    Number.isSafeInteger(allocation.createdAt) && allocation.createdAt >= 0;
}

function hex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
