import {createHash} from "node:crypto";
import {expect, it, vi} from "vitest";
import {makeMockStorage} from "./mock-storage";
import {makeOverseerStorage} from "../src/storage-schema/overseer-storage";
import {WorkspaceGitCache} from "../src/git-cache";
import {buildPackStream, decodeLooseObject, decodePackStream} from "../src/git-codec";

function fixture() {
  const storage = makeOverseerStorage(makeMockStorage());
  const cache = new WorkspaceGitCache(storage, {async pull() {throw new Error("unexpected pull");}});
  return {storage, git: cache, cache};
}
const options = {parents: [], author: {name: "Test", email: "test@example.com"},
  message: "files", timestamp: new Date(0)};

it("stores raw bytes and remote blobs in the same ordinary Git object collection", async () => {
  const {git, cache, storage} = fixture();
  const bytes = Uint8Array.of(0, 255, 42);
  const ref = await git.writeBlob(bytes);
  const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  expect(ref).toEqual({oid, byteLength: bytes.length});
  expect(decodeLooseObject(storage.gitObjects.get(oid)!.data)).toEqual({type: "blob", payload: bytes});
  expect(await cache.putFromGatekeeper(7, "blob", bytes)).toBe(oid);
  expect(await git.writeBlob(bytes)).toEqual(ref);
  expect([...storage.gitObjects.list()]).toHaveLength(1);
  expect(cache.readLocalObject(oid)).toEqual({type: "blob", payload: bytes});
  expect(git.readBlob(oid, ref.byteLength)).toEqual(bytes);
});

it("stores a blob of any size, chunked, and reads it back", async () => {
  const {git, storage} = fixture();
  const bytes = new Uint8Array(20 * 1024 * 1024);
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
  }
  const ref = await git.writeBlob(bytes);
  expect(ref).toEqual({oid: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    byteLength: bytes.length});
  // An index row plus chunk rows, every one of them far within storage's 8 MiB row cap.
  const records = [...storage.gitObjects.list()];
  expect(records.length).toBeGreaterThan(20);
  for (const record of records) {
    if ("data" in record) expect(record.data.byteLength).toBeLessThan(1.1 * 1024 * 1024);
  }
  expect(storage.gitObjects.get(ref.oid)).toHaveProperty("chunks");
  expect(git.blobSize(ref.oid)).toBe(bytes.length);
  const reader = git.openLocalBlob(ref.oid)!;
  const read = new Uint8Array(reader.size);
  let filled = 0;
  for (const piece of reader.pieces()) {
    read.set(piece, filled);
    filled += piece.length;
  }
  expect(Buffer.from(read).equals(Buffer.from(bytes))).toBe(true);
  // Reads are never refused for size: the whole blob is assembled.
  expect(Buffer.from(git.readBlob(ref.oid, bytes.length)).equals(Buffer.from(bytes))).toBe(true);
  expect(() => git.readBlob(ref.oid, bytes.length + 1)).toThrow("length does not match");
  git.assertBlob(ref.oid, bytes.length);
  expect(() => git.assertBlob(ref.oid, 1)).toThrow("length does not match");
});

it("reports a storage failure without publishing a reference, and a retry has the same identity", async () => {
  const {git, storage} = fixture();
  const put = vi.spyOn(storage.gitObjects, "put").mockImplementation(() => {
    throw new Error("storage failed");
  });
  await expect(git.writeBlob(Uint8Array.of(17))).rejects.toThrow("storage failed");
  expect([...storage.gitObjects.list()]).toEqual([]);
  put.mockRestore();
  const ref = await git.writeBlob(Uint8Array.of(17));
  expect(await git.writeBlob(Uint8Array.of(17))).toEqual(ref);
});

it("requires an existing blob with the declared length, not an upload-specific grant", async () => {
  const {git} = fixture();
  const ref = await git.writeBlob(Uint8Array.of(1, 2));
  expect(git.readBlob(ref.oid, 2)).toEqual(Uint8Array.of(1, 2));
  expect(() => git.readBlob(ref.oid, 3)).toThrow("length does not match");
  expect(() => fixture().git.readBlob(ref.oid)).toThrow("Unknown Git blob");
  const commit = await git.writeFilesAsCommit(new Map(), options);
  expect(() => git.readBlob(commit)).toThrow("not a blob");
  await expect(git.writeFilesAsCommit(new Map([["bad.bin", {...ref, byteLength: 3}]]), options))
    .rejects.toThrow("length does not match");
});

it("commits binary and empty files as ordinary blobs and exports a byte-exact pack", async () => {
  const {git, cache} = fixture();
  const bytes = Uint8Array.of(0, 255, 42), ref = await git.writeBlob(bytes);
  const empty = await git.writeBlob(new Uint8Array());
  const commit = await git.writeFilesAsCommit(new Map([["image.bin", ref], ["empty.bin", empty]]), options);
  expect(await cache.fileBytesAtCommit(commit, "image.bin")).toEqual(ref);
  expect(await cache.fileBytesAtCommit(commit, "empty.bin")).toEqual(empty);
  const pack = buildPackStream(2, (async function* () {
    yield await cache.ensureObject(ref.oid, {type: "blob"});
    yield await cache.ensureObject(empty.oid, {type: "blob"});
  })());
  const received = [];
  for await (const object of decodePackStream(pack, {
    maxPackSize: 1024, maxObjectSize: 1024, resolveBase: () => undefined,
  })) received.push(object);
  expect(received).toEqual([{oid: ref.oid, type: "blob", payload: bytes},
    {oid: empty.oid, type: "blob", payload: new Uint8Array()}]);
});

it("decodes UTF-8 blobs by content and preserves old blob contents across replacements", async () => {
  const {git, cache} = fixture();
  const text = "\ufeffhello😀\n", bytes = new TextEncoder().encode(text);
  const ref = await git.writeBlob(bytes);
  const commit = await git.writeFilesAsCommit(new Map([["a.txt", ref]]), options);
  expect(git.readCommitFiles(commit)).toEqual(new Map([["a.txt", text]]));
  expect(await cache.readFileAtCommit(commit, "a.txt")).toBe(text);
  const replacement = await git.writeBlob(Uint8Array.of(0, 255));
  const next = await git.writeChangedFilesAsCommit(new Map([["a.txt", replacement]]),
    {...options, treeBase: commit, parents: [commit]});
  expect(() => git.readCommitFiles(next)).toThrow("not a text file");
  expect(git.readBlob(ref.oid)).toEqual(bytes);
  expect(await cache.fileBytesAtCommit(commit, "a.txt")).toEqual(ref);
});
