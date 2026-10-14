import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ByteStore, BYTE_CHUNK_SIZE } from "../src/byte-store";
import { makeMockStorage } from "./mock-storage";
import { makeOverseerStorage } from "../src/storage-schema/overseer-storage";
import { GitStore } from "../src/git-store";
import { WorkspaceGitCache } from "../src/git-cache";
import { buildPackStream, parseGitCommitRefs, parseGitTree, decodeLooseObject } from "../src/git-codec";
import type { ByteValue } from "@gadgets/workshop-shared/byte-change";

function fixture() {
  const storage = makeOverseerStorage(makeMockStorage());
  let flushes = 0;
  const store = new ByteStore(storage.byteObjects, storage.byteChunks, storage.byteUploads,
    async () => { ++flushes; }, storage.byteGrants, storage.gitByteBlobs);
  return {storage, store, flushes: () => flushes};
}
function stream(bytes: Uint8Array, fail = false) {
  let sent = false;
  return new ReadableStream<Uint8Array>({pull(c) { if (!sent) { sent = true; c.enqueue(bytes); } else if (fail) c.error(new Error("disconnect")); else c.close(); }});
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const oid = (bytes: Uint8Array) => createHash("sha1")
  .update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
const read = (body: ReadableStream<Uint8Array>) => new Response(body).bytes();

it("resumes persisted offsets after a disconnect, verifies retries and returns a stable finished receipt", async () => {
  const {store, storage} = fixture(), data = new Uint8Array(BYTE_CHUNK_SIZE * 2 + 31).map((_, i) => i % 251);
  await store.begin("lease-a", "upload", data.length, hash(data));
  await expect(store.write("lease-a", "upload", 0, stream(data.subarray(0, BYTE_CHUNK_SIZE), true), () => {})).rejects.toThrow("disconnect");
  expect(store.status("lease-a", "upload").offset).toBe(BYTE_CHUNK_SIZE);
  const resumed = new ByteStore(storage.byteObjects, storage.byteChunks, storage.byteUploads,
    async () => {}, storage.byteGrants, storage.gitByteBlobs);
  await resumed.write("lease-a", "upload", 0, stream(data.subarray(0, BYTE_CHUNK_SIZE)), () => {});
  await expect(resumed.write("lease-a", "upload", 0, stream(new Uint8Array(BYTE_CHUNK_SIZE)), () => {})).rejects.toThrow("changed durable");
  await resumed.write("lease-a", "upload", BYTE_CHUNK_SIZE, stream(data.subarray(BYTE_CHUNK_SIZE)), () => {});
  const ref = await resumed.finish("lease-a", "upload", () => {});
  expect(ref).toEqual({oid: oid(data), byteLength: data.byteLength});
  expect(await resumed.finish("lease-a", "upload", () => {})).toEqual(ref);
  expect(await read(resumed.read(ref))).toEqual(data);
  expect(resumed.isFinishedFor("lease-b", ref)).toBe(false);
  expect(() => resumed.status("lease-b", "upload")).toThrow();
  await expect(read(resumed.read(ref, 0, ref.byteLength, () => { throw new Error("revoked"); }))).rejects.toThrow("revoked");
});

it("keeps large replacements immutable, references compact and streaming buffers bounded", async () => {
  const {store} = fixture(), data = new Uint8Array(16 * 1024 * 1024).fill(17);
  const original = await store.import("kernel", data);
  const replacement = data.slice(); replacement.set([0, 255], BYTE_CHUNK_SIZE - 1);
  const value: ByteValue = {base: await store.import("kernel", replacement)};
  const ref = store.resolve(value);
  expect(JSON.stringify(value).length).toBeLessThan(500);
  let total = 0;
  for await (const chunk of store.read(ref)) { expect(chunk.length).toBeLessThanOrEqual(BYTE_CHUNK_SIZE); total += chunk.length; }
  expect(total).toBe(data.length);
  expect(await read(store.read(ref, BYTE_CHUNK_SIZE - 3, 6))).toEqual(new Uint8Array([17, 17, 0, 255, 17, 17]));
  expect(await read(store.read(original, BYTE_CHUNK_SIZE - 3, 6))).toEqual(new Uint8Array(6).fill(17));
});

it("resumes non-aligned partial blocks without publishing staged bytes", async () => {
  const {store, storage} = fixture(), data = new Uint8Array(BYTE_CHUNK_SIZE + 19).map((_, i) => i % 251);
  await store.begin("a", "partial", data.length, hash(data));
  await store.write("a", "partial", 0, stream(data.subarray(0, 4193)), () => {});
  expect(() => store.reference(oid(data))).toThrow(/Unknown/);
  const resumed = new ByteStore(storage.byteObjects, storage.byteChunks, storage.byteUploads,
    async () => {}, storage.byteGrants, storage.gitByteBlobs);
  await resumed.write("a", "partial", 0, stream(data.subarray(0, 4193)), () => {});
  await resumed.write("a", "partial", 4193, stream(data.subarray(4193)), () => {});
  const ref = await resumed.finish("a", "partial", () => {});
  expect(await read(resumed.read(ref))).toEqual(data);
  expect(resumed.readSmall(ref, data.length)).toEqual(data);
  await expect(resumed.write("a", "partial", 0, stream(data), () => {})).rejects.toThrow(/offset or length/);
  expect(await read(resumed.read(ref))).toEqual(data);
});

it("distinguishes empty bytes from deletion and rejects a wrong digest", async () => {
  const {store} = fixture();
  const empty = await store.import("a", new Uint8Array());
  expect(empty.byteLength).toBe(0);
  expect(await read(store.read(empty))).toEqual(new Uint8Array());
  await store.begin("a", "bad", 1, hash(new Uint8Array([1])));
  await store.write("a", "bad", 0, stream(new Uint8Array([2])), () => {});
  await expect(store.finish("a", "bad", () => {})).rejects.toThrow("digest mismatch");
  expect(() => store.reference(oid(Uint8Array.of(2)))).toThrow(/Unknown/);
});

it("commits byte-backed blobs with real Git identities and streams a pack", async () => {
  const {store, storage} = fixture();
  const bytes = new Uint8Array([0, 255, 42]), ref = await store.import("a", bytes);
  const git = new GitStore(storage.gitObjects, store, storage.gitByteBlobs);
  const empty = await git.writeFilesAsCommit(new Map(), {parents: [], author: {name: "Test", email: "test@example.com"}, message: "empty", timestamp: new Date()});
  const commit = await git.writeChangedFilesAsCommit(new Map([["image.bin", {base: ref}]]), {treeBase: empty, parents: [empty], author: {name: "Test", email: "test@example.com"}, message: "bytes", timestamp: new Date()});
  const root = parseGitCommitRefs(decodeLooseObject(storage.gitObjects.get(commit)!.data).payload).tree;
  const blob = parseGitTree(decodeLooseObject(storage.gitObjects.get(root)!.data).payload)[0].oid;
  expect(blob).toBe(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"));
  const cache = new WorkspaceGitCache(storage, {async pull() {throw new Error("unexpected pull");}}, store);
  const object = await cache.packObject(blob, {type: "blob"});
  const chunks = [];
  for await (const chunk of buildPackStream(1, (async function* () {yield object;})())) chunks.push(chunk);
  expect(chunks.reduce((n, chunk) => n + chunk.length, 0)).toBeGreaterThan(bytes.length);
  expect(storage.gitObjects.get(blob)).toBeUndefined();
});

it("decodes byte-backed text by content and keeps identical Git blob mappings stable", async () => {
  const {store, storage} = fixture();
  const git = new GitStore(storage.gitObjects, store, storage.gitByteBlobs);
  const text = "\ufeffhello😀\n", payload = new TextEncoder().encode(text);
  const options = {parents: [], author: {name: "Test", email: "test@example.com"}, message: "text", timestamp: new Date(0)};
  const first = await store.import("a", payload);
  const firstRoot = storage.gitByteBlobs.get(first.oid)!.bytes;
  const second = await store.import("b", payload);
  const commit = await git.writeFilesAsCommit(new Map([["a.txt", {base: first}]]), options);
  expect(await git.readCommitFiles(commit)).toEqual(new Map([["a.txt", text]]));
  expect(await git.writeFilesAsCommit(new Map([["a.txt", {base: second}]]), options)).toBe(commit);
  expect(second).toEqual(first);
  expect(storage.gitByteBlobs.get(first.oid)?.bytes).toEqual(firstRoot);
  for (const data of [Uint8Array.of(0), Uint8Array.of(255)]) {
    const ref = await store.import("a", data);
    const binary = await git.writeFilesAsCommit(new Map([["a.bin", {base: ref}]]), options);
    await expect(git.readCommitFiles(binary)).rejects.toThrow(/not a text file/);
  }
});
