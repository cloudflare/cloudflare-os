import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  ACTION_FILE_CHUNK_BYTES,
  ActionFileStore,
  type ActionFileReference,
  type ActionFileStoreOptions,
} from "../../src/action-files";

// Streaming needs workerd's `crypto.DigestStream`, and a capture that fails part-way leans on real
// storage rolling back a throwing `transactionSync`, which the Node fake does not model.

const CHUNK = ACTION_FILE_CHUNK_BYTES;
const TOTAL_KEY = "test:allocation:totalBytes";

const OPTIONS: ActionFileStoreOptions = {
  filePrefix: "test:file:",
  allocationPrefix: "test:allocation:",
  maxFileBytes: 3 * CHUNK,
  maxTotalBytes: 6 * CHUNK,
};

let stores = 0;

/** Runs `body` against a store over a fresh Durable Object's own storage. */
function withStore<R>(
  body: (store: ActionFileStore, storage: DurableObjectStorage) => Promise<R>,
  overrides: Partial<ActionFileStoreOptions> = {},
): Promise<R> {
  const host = env.STORAGE_HOST.getByName(`action-files-${stores++}`);
  return runInDurableObject(host, (_instance, state) =>
    body(new ActionFileStore(state.storage, { ...OPTIONS, ...overrides }), state.storage));
}

function bytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 251);
}

// `toEqual` walks a typed array element by element, which is too slow for multi-MiB inputs.
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/**
 * `input` as a stream of `pieceBytes`-sized pieces. It queues nothing ahead, so `onPull` runs only
 * once the capture has dealt with every piece before and asks for the next.
 */
function source(
  input: Uint8Array, pieceBytes: number,
  hooks: { onPull?: (piece: number) => void; cancelled?: unknown[] } = {},
): ReadableStream<Uint8Array> {
  let offset = 0;
  let piece = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      hooks.onPull?.(piece++);
      if (offset >= input.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(input.slice(offset, offset + pieceBytes));
      offset += pieceBytes;
    },
    cancel(reason) {
      hooks.cancelled?.push(reason);
    },
  }, { highWaterMark: 0 });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads `stream` until it ends or errors, returning what it gave before that. */
async function readUntilError(
  stream: ReadableStream<Uint8Array>,
): Promise<{ given: number; error?: unknown }> {
  const reader = stream.getReader();
  let given = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { given };
      given += value.byteLength;
    }
  } catch (error) {
    return { given, error };
  }
}

/** Every key the store holds, other than its aggregate counter. */
function fileKeys(storage: DurableObjectStorage): string[] {
  return [...storage.kv.list({ prefix: "test:" })].map(([key]) => key).filter(key => key !== TOTAL_KEY);
}

function chunkKey(file: ActionFileReference, index: number): string {
  return `test:file:${file.handle}:chunk:${String(index).padStart(4, "0")}`;
}

describe("ActionFileStore streams", () => {
  it.each([
    ["empty", 0, 1],
    ["one-piece", 17, 17],
    ["chunk-straddling", 2 * CHUNK + 17, 700_000],
  ])("captures a %s stream as capture() would, and reads it back either way", async (_name, length, piece) => {
    await withStore(async store => {
      const input = bytes(length);

      const streamed = await store.captureStream(source(input, piece));
      const whole = await store.capture(input);

      expect(streamed.size).toBe(length);
      expect(streamed.digest).toBe(whole.digest);
      expect(bytesEqual(await drain(await store.readStream(streamed)), input)).toBe(true);
      expect(bytesEqual(await store.read(streamed), input)).toBe(true);
      expect(bytesEqual(await drain(await store.readStream(whole)), input)).toBe(true);
    });
  });

  it("keeps a piece's bytes as given though its producer reuses the buffer mid-capture", async () => {
    const host = env.STORAGE_HOST.getByName(`action-files-${stores++}`);
    await runInDurableObject(host, async (_instance, state) => {
      const input = bytes(2 * CHUNK + 17);
      const reused = Uint8Array.from(input);
      let transactions = 0;
      // The first chunk is stored while the rest of the one piece still waits to be copied.
      const store = new ActionFileStore({
        kv: state.storage.kv,
        transactionSync<T>(callback: () => T): T {
          if (transactions++ === 0) reused.fill(0xff);
          return state.storage.transactionSync(callback);
        },
      }, OPTIONS);
      const once = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(reused);
          controller.close();
        },
      }, { highWaterMark: 0 });

      const file = await store.captureStream(once);

      expect(bytesEqual(await store.read(file), input)).toBe(true);
    });
  });

  it("refuses a stream past maxFileBytes, keeping nothing and cancelling the source", async () => {
    await withStore(async (store, storage) => {
      const cancelled: unknown[] = [];

      await expect(store.captureStream(source(bytes(3 * CHUNK), CHUNK / 2, { cancelled })))
        .rejects.toThrow(/larger than/);

      expect(cancelled).toHaveLength(1);
      expect(fileKeys(storage)).toEqual([]);
      expect(storage.kv.get(TOTAL_KEY)).toBe(0);
    }, { maxFileBytes: 2 * CHUNK + 5 });
  });

  it("cancels the source of a refused capture even when its cleanup fails", async () => {
    const host = env.STORAGE_HOST.getByName(`action-files-${stores++}`);
    await runInDurableObject(host, async (_instance, state) => {
      let transactions = 0;
      // The first transaction stores the first chunk; the second is the refusal's cleanup.
      const store = new ActionFileStore({
        kv: state.storage.kv,
        transactionSync<T>(callback: () => T): T {
          if (++transactions === 2) throw new Error("cleanup failed");
          return state.storage.transactionSync(callback);
        },
      }, { ...OPTIONS, maxFileBytes: CHUNK + 5 });
      const cancelled: unknown[] = [];

      await expect(store.captureStream(source(bytes(2 * CHUNK), CHUNK, { cancelled })))
        .rejects.toThrow(/cleanup failed/);

      expect(cancelled).toHaveLength(1);
    });
  });

  it("refuses and frees its chunks without waiting for a source whose cancel never settles", async () => {
    await withStore(async (store, storage) => {
      const release = Promise.withResolvers<void>();
      let given = 0;
      let cancelled = false;
      const stalling = new ReadableStream<Uint8Array>({
        pull(controller) {
          given++;
          controller.enqueue(bytes(CHUNK));
        },
        cancel() {
          cancelled = true;
          return release.promise;
        },
      }, { highWaterMark: 0 });

      // A capture that waits on the cancel never settles, and the test fails on its timeout.
      await expect(store.captureStream(stalling)).rejects.toThrow(/larger than/);

      expect(cancelled).toBe(true);
      expect(given).toBe(3);
      expect(fileKeys(storage)).toEqual([]);
      expect(storage.kv.get(TOTAL_KEY)).toBe(0);
      release.resolve();
    }, { maxFileBytes: 2 * CHUNK });
  });

  it("refuses a stream past maxTotalBytes and releases only what it had counted", async () => {
    await withStore(async (store, storage) => {
      const kept = await store.capture(bytes(CHUNK));
      const keptKeys = fileKeys(storage);

      await expect(store.captureStream(source(bytes(2 * CHUNK), CHUNK)))
        .rejects.toThrow(/aggregate storage limit/);

      expect(fileKeys(storage)).toEqual(keptKeys);
      expect(storage.kv.get(TOTAL_KEY)).toBe(CHUNK);
      expect(bytesEqual(await store.read(kept), bytes(CHUNK))).toBe(true);
    }, { maxTotalBytes: 2 * CHUNK });
  });

  it("fails with the source's own error, keeping nothing", async () => {
    await withStore(async (store, storage) => {
      let given = 0;
      const broken = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (given++ === 3) throw new Error("source broke");
          controller.enqueue(bytes(CHUNK / 2));
        },
      });

      await expect(store.captureStream(broken)).rejects.toThrow("source broke");

      expect(fileKeys(storage)).toEqual([]);
      expect(storage.kv.get(TOTAL_KEY)).toBe(0);
    });
  });

  it("fails a capture whose allocation is pruned while it is being written", async () => {
    await withStore(async (store, storage) => {
      // The first piece fills a chunk, which is stored before the second is asked for.
      const pruning = source(bytes(2 * CHUNK), CHUNK, {
        onPull: piece => {
          if (piece === 1) store.pruneUnreferenced(new Set(), Date.now() + 1);
        },
      });

      await expect(store.captureStream(pruning)).rejects.toThrow(/deleted while/);

      expect(fileKeys(storage)).toEqual([]);
      expect(storage.kv.get(TOTAL_KEY)).toBe(0);
    });
  });

  it("dates a streamed capture's allocation from when the capture began", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      await withStore(async store => {
        // The first chunk is stored at 2,000, and a sweep with cutoff 1,500 follows it: one dated
        // by its first chunk would survive it.
        const late = source(bytes(2 * CHUNK), CHUNK, {
          onPull: piece => {
            if (piece === 0) now.mockReturnValue(2_000);
            if (piece === 1) store.pruneUnreferenced(new Set(), 1_500);
          },
        });

        await expect(store.captureStream(late)).rejects.toThrow(/deleted while/);
      });
    } finally {
      now.mockRestore();
    }
  });

  it("never gives the final chunk of a file that fails its digest", async () => {
    await withStore(async (store, storage) => {
      const file = await store.capture(bytes(2 * CHUNK + 17));
      const first = storage.kv.get<Uint8Array>(chunkKey(file, 0))!;
      first[0] ^= 0xff;
      storage.kv.put(chunkKey(file, 0), first);

      const read = await readUntilError(await store.readStream(file));

      expect(String(read.error)).toMatch(/incomplete or corrupted/);
      expect(read.given).toBe(2 * CHUNK);
    });
  });

  it("streams the file it verified, though the caller's reference changes afterwards", async () => {
    await withStore(async store => {
      const input = bytes(2 * CHUNK + 17);
      // Assignable though the API type is readonly, as any caller's own object would be.
      const reference: { handle: string; size: number; digest: string } = { ...await store.capture(input) };
      const other = await store.capture(bytes(2 * CHUNK + 17).fill(0xbb));

      const stream = await store.readStream(reference);
      reference.handle = other.handle;

      expect(bytesEqual(await drain(stream), input)).toBe(true);
    });
  });

  it.each(["missing", "truncated", "wrong type"])(
    "errors at a %s chunk before giving the rest",
    async corruption => {
      await withStore(async (store, storage) => {
        const file = await store.capture(bytes(2 * CHUNK + 17));
        const key = chunkKey(file, 1);

        if (corruption === "missing") storage.kv.delete(key);
        if (corruption === "truncated") storage.kv.put(key, storage.kv.get<Uint8Array>(key)!.slice(1));
        if (corruption === "wrong type") storage.kv.put(key, "not bytes");

        const read = await readUntilError(await store.readStream(file));

        expect(String(read.error)).toMatch(/incomplete or corrupted/);
        expect(read.given).toBe(CHUNK);
      });
    },
  );

  it("refuses up front a file with an extra chunk or a reference its manifest disagrees with", async () => {
    await withStore(async (store, storage) => {
      const extra = await store.capture(bytes(17));
      storage.kv.put(chunkKey(extra, 1), new Uint8Array(1));
      const other = await store.capture(bytes(17));

      await expect(store.readStream(extra)).rejects.toThrow(/incomplete or corrupted/);
      await expect(store.readStream({ ...other, digest: "0".repeat(64) }))
        .rejects.toThrow(/incomplete or corrupted/);
      await expect(store.readStream({ size: 1, digest: "0".repeat(64) } as ActionFileReference))
        .rejects.toThrow(/reject and resubmit/i);
    });
  });
});
