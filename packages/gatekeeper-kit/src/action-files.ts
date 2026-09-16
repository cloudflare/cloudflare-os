import type { KvScannable } from "./kv";
import { requirePositiveInt } from "./positive-int";

/** Bytes per stored action-file chunk, leaving headroom below the 2 MiB KV value limit. */
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
  createdAt: number;
};

const HANDLE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRUPTED = "The stored queued-action file is incomplete or corrupted.";

/**
 * Stores queued-action files as bounded, integrity-checked Durable Object KV chunks.
 *
 * Each file is a manifest plus 1 MiB chunks under `filePrefix`, and an allocation record under
 * `allocationPrefix` that feeds the aggregate `totalBytes` counter. A capture writes all of them
 * in one transaction and a delete removes them in one, so the store's own records are trusted as
 * consistent; storage that has been edited behind its back is outside its guarantees.
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
    this.#maxTotalBytes = requirePositiveInt("maxTotalBytes", options.maxTotalBytes);
  }

  /**
   * Captures exact file bytes and returns bounded integrity metadata.
   * @param bytes File bytes to retain.
   * @returns A reference suitable for a queued-action payload.
   */
  async capture(bytes: Uint8Array): Promise<ActionFileReference> {
    const size = bytes.byteLength;
    if (size > this.#maxFileBytes) {
      throw new Error(
        `Cannot retain a queued-action file larger than ${this.#maxFileBytes} bytes.`);
    }

    // WebCrypto snapshots its input synchronously, and each chunk is copied (`slice()` on a Node
    // Buffer would alias) before the await, so caller mutation afterwards cannot skew either.
    const digest = sha256(bytes);
    const chunks: Uint8Array[] = [];
    for (let start = 0; start < size; start += ACTION_FILE_CHUNK_BYTES) {
      chunks.push(Uint8Array.from(bytes.subarray(start, start + ACTION_FILE_CHUNK_BYTES)));
    }
    const file: ActionFileReference = { handle: crypto.randomUUID(), size, digest: await digest };

    this.#storage.transactionSync(() => {
      const total = this.#storage.kv.get<unknown>(this.#totalKey) ?? 0;
      if (!Number.isSafeInteger(total) || (total as number) < 0) {
        throw new Error("Stored queued-action file accounting is invalid.");
      }
      if ((total as number) + size > this.#maxTotalBytes) {
        throw new Error(
          "Queued-action files exceed the safe aggregate storage limit. " +
          "Resolve existing actions before adding another.");
      }
      this.#storage.kv.put<ActionFileAllocation>(this.#allocationKey(file.handle), {
        version: 1, size, chunks: chunks.length, createdAt: Date.now(),
      });
      this.#storage.kv.put<ActionFileManifest>(this.#manifestKey(file.handle), {
        ...file, version: 1, chunks: chunks.length,
      });
      chunks.forEach((chunk, index) => this.#storage.kv.put(this.#chunkKey(file.handle, index), chunk));
      this.#storage.kv.put(this.#totalKey, (total as number) + size);
    });
    return file;
  }

  /**
   * Reassembles a captured file after checking its manifest, chunks, size, and digest.
   * @param file Stored file reference.
   * @returns The exact captured bytes.
   */
  async read(file: ActionFileReference): Promise<Uint8Array> {
    if (!validReference(file)) {
      throw new Error(
        "This queued action uses an obsolete file reference. Reject and resubmit it.");
    }
    const manifest = this.#storage.kv.get<unknown>(this.#manifestKey(file.handle));
    if (!validManifest(manifest) || manifest.handle !== file.handle ||
        manifest.size !== file.size || manifest.digest !== file.digest) {
      throw new Error(CORRUPTED);
    }

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
    if (offset !== manifest.size || await sha256(bytes) !== manifest.digest) {
      throw new Error(CORRUPTED);
    }
    return bytes;
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

  #delete(handle: string): void {
    this.#storage.transactionSync(() => {
      const allocation = this.#storage.kv.get<unknown>(this.#allocationKey(handle));
      for (const [key] of this.#storage.kv.list({ prefix: this.#chunkPrefix(handle) })) {
        this.#storage.kv.delete(key);
      }
      this.#storage.kv.delete(this.#manifestKey(handle));
      this.#storage.kv.delete(this.#allocationKey(handle));

      // The allocation record is the accounting unit: without one, nothing was ever counted. A
      // counter that is already invalid is left as is, so capture() keeps failing closed on it.
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

async function sha256(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
