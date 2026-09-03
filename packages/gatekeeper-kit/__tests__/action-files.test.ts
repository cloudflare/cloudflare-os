import { describe, expect, it } from "vitest";
import {
  ACTION_FILE_CHUNK_BYTES,
  ActionFileStore,
  type ActionFileReference,
  type ActionFileStoreOptions,
} from "../src/action-files";
import { fakeKv, type FakeKv } from "./fake-kv";

// This suite runs in Node, while the package intentionally excludes Node globals from its types.
const nodeBuffer = (globalThis as typeof globalThis & {
  Buffer: { from(value: Uint8Array): Uint8Array };
}).Buffer;

const OPTIONS: ActionFileStoreOptions = {
  filePrefix: "test:file:",
  allocationPrefix: "test:allocation:",
  maxFileBytes: 3 * ACTION_FILE_CHUNK_BYTES,
  maxTotalBytes: 6 * ACTION_FILE_CHUNK_BYTES,
};

function actionFiles(overrides: Partial<ActionFileStoreOptions> = {}): {
  store: ActionFileStore;
  kv: FakeKv;
} {
  const kv = fakeKv();
  const storage = { kv, transactionSync<T>(callback: () => T): T { return callback(); } };
  return { store: new ActionFileStore(storage, { ...OPTIONS, ...overrides }), kv };
}

function chunkKeys(kv: FakeKv, file: ActionFileReference): string[] {
  return kv.keys().filter(key => key.includes(`${file.handle}:chunk:`));
}

function bytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 251);
}

// `toEqual` walks a typed array element by element, which is too slow for multi-MiB inputs.
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

describe("ActionFileStore", () => {
  it.each([
    ["empty", 0],
    ["one chunk", 17],
    ["multiple chunks", ACTION_FILE_CHUNK_BYTES + 17],
  ])("round trips an %s file", async (_name, length) => {
    const { store } = actionFiles();
    const input = bytes(length);

    const file = await store.capture(input);

    expect(file.size).toBe(length);
    expect(file.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(bytesEqual(await store.read(file), input)).toBe(true);
  });

  it.each([
    ["Uint8Array", bytes(32)],
    ["Buffer", nodeBuffer.from(bytes(32))],
  ])("snapshots %s chunks before yielding to caller mutation", async (_type, input) => {
    const { store } = actionFiles();
    const expected = Uint8Array.from(input);

    const capture = store.capture(input);
    input.fill(255);

    expect(await store.read(await capture)).toEqual(expected);
  });

  it.each(["missing", "extra", "truncated", "wrong type", "corrupted"])(
    "rejects %s chunks before returning bytes",
    async corruption => {
      const { store, kv } = actionFiles();
      const file = await store.capture(bytes(ACTION_FILE_CHUNK_BYTES + 17));
      const keys = chunkKeys(kv, file);

      if (corruption === "missing") kv.delete(keys[1]);
      if (corruption === "extra") kv.put(`test:file:${file.handle}:chunk:0002`, new Uint8Array());
      if (corruption === "truncated") kv.put(keys[0], kv.get<Uint8Array>(keys[0])!.slice(1));
      if (corruption === "wrong type") kv.put(keys[0], "not bytes");
      if (corruption === "corrupted") {
        const chunk = kv.get<Uint8Array>(keys[0])!;
        chunk[0] ^= 0xff;
        kv.put(keys[0], chunk);
      }

      await expect(store.read(file)).rejects.toThrow(/incomplete or corrupted/);
      store.delete(file);
      expect(chunkKeys(kv, file)).toEqual([]);
    },
  );

  it("rejects a reference that disagrees with its manifest", async () => {
    const { store } = actionFiles();
    const file = await store.capture(bytes(3));

    await expect(store.read({ ...file, digest: "0".repeat(64) }))
      .rejects.toThrow(/incomplete or corrupted/);
  });

  it("fails obsolete references closed with resubmission guidance", async () => {
    const { store } = actionFiles();

    await expect(store.read({ size: 1, digest: "0".repeat(64) } as ActionFileReference))
      .rejects.toThrow(/reject and resubmit/i);
  });

  it("enforces per-file and aggregate byte limits without partial writes", async () => {
    const { store, kv } = actionFiles({ maxFileBytes: 4, maxTotalBytes: 5 });

    await expect(store.capture(bytes(5))).rejects.toThrow(/larger than 4 bytes/);
    expect(kv.keys()).toEqual([]);

    await store.capture(bytes(3));
    await store.capture(bytes(2));
    const keysAtLimit = kv.keys();
    await expect(store.capture(bytes(1))).rejects.toThrow(/aggregate storage limit/);
    expect(kv.keys()).toEqual(keysAtLimit);
  });

  it.each(["invalid", -1])("fails closed when aggregate accounting is %j, even after a delete", async total => {
    const { store, kv } = actionFiles();
    const file = await store.capture(bytes(1));
    kv.put("test:allocation:totalBytes", total);

    store.delete(file);

    expect(kv.get("test:allocation:totalBytes")).toBe(total);
    await expect(store.capture(bytes(1))).rejects.toThrow(/accounting is invalid/);
    expect(kv.keys()).toEqual(["test:allocation:totalBytes"]);
  });

  it("deletes every chunk idempotently and releases its allocation", async () => {
    const { store, kv } = actionFiles();
    const file = await store.capture(bytes(ACTION_FILE_CHUNK_BYTES + 1));

    store.delete(file);
    store.delete(file);

    expect(kv.keys().some(key => key.includes(file.handle))).toBe(false);
    expect(kv.get("test:allocation:totalBytes")).toBe(0);
    await expect(store.read(file)).rejects.toThrow(/incomplete or corrupted/);
  });

  it("releases accounting when the manifest is missing", async () => {
    const { store, kv } = actionFiles();
    const file = await store.capture(bytes(3));
    kv.delete(`test:file:${file.handle}:manifest`);

    store.delete(file);

    expect(kv.keys().some(key => key.includes(file.handle))).toBe(false);
    expect(kv.get("test:allocation:totalBytes")).toBe(0);
  });

  it("prunes stale unreferenced files while retaining referenced and young files", async () => {
    const { store, kv } = actionFiles();
    const retained = await store.capture(bytes(1));
    const orphaned = await store.capture(bytes(2));
    const young = await store.capture(bytes(3));

    const youngAllocation = kv.get<{ createdAt: number }>(`test:allocation:${young.handle}`)!;
    youngAllocation.createdAt = Date.now() + 60_000;
    kv.put(`test:allocation:${young.handle}`, youngAllocation);
    store.pruneUnreferenced(new Set([retained.handle]), Date.now() + 1);

    await expect(store.read(retained)).resolves.toEqual(bytes(1));
    await expect(store.read(young)).resolves.toEqual(bytes(3));
    expect(kv.keys().some(key => key.includes(orphaned.handle))).toBe(false);
    expect(kv.get("test:allocation:totalBytes")).toBe(4);
  });

  it("preserves Gmail's deployed storage key layout", async () => {
    const { store, kv } = actionFiles({
      filePrefix: "gmail:forwardSnapshot:",
      allocationPrefix: "gmail:forwardSnapshotAllocation:",
    });
    const file = await store.capture(bytes(ACTION_FILE_CHUNK_BYTES + 1));

    expect(kv.keys()).toEqual([
      `gmail:forwardSnapshot:${file.handle}:chunk:0000`,
      `gmail:forwardSnapshot:${file.handle}:chunk:0001`,
      `gmail:forwardSnapshot:${file.handle}:manifest`,
      `gmail:forwardSnapshotAllocation:${file.handle}`,
      "gmail:forwardSnapshotAllocation:totalBytes",
    ]);
  });

  it("reads and deletes a seeded Gmail v1 snapshot", async () => {
    const { store, kv } = actionFiles({
      filePrefix: "gmail:forwardSnapshot:",
      allocationPrefix: "gmail:forwardSnapshotAllocation:",
    });
    const file = {
      handle: "00000000-0000-4000-8000-000000000001",
      size: 3,
      digest: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    };
    kv.put(`gmail:forwardSnapshot:${file.handle}:manifest`, { ...file, version: 1, chunks: 1 });
    kv.put(`gmail:forwardSnapshot:${file.handle}:chunk:0000`, Uint8Array.from([1, 2, 3]));
    kv.put(`gmail:forwardSnapshotAllocation:${file.handle}`, {
      version: 1, size: 3, chunks: 1, createdAt: 1,
    });
    kv.put("gmail:forwardSnapshotAllocation:totalBytes", 3);

    await expect(store.read(file)).resolves.toEqual(Uint8Array.from([1, 2, 3]));
    store.delete(file);
    expect(kv.keys()).toEqual(["gmail:forwardSnapshotAllocation:totalBytes"]);
    expect(kv.get("gmail:forwardSnapshotAllocation:totalBytes")).toBe(0);
  });

  it.each([
    [{ maxFileBytes: 0 }, /maxFileBytes must be a positive integer/],
    [{ maxTotalBytes: 0 }, /maxTotalBytes must be a positive integer/],
  ] as const)("rejects invalid limits %#", (overrides, error) => {
    expect(() => actionFiles(overrides)).toThrow(error);
  });
});
