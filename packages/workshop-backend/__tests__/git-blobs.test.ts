import {createHash} from "node:crypto";
import {expect, it, vi} from "vitest";
import {makeMockStorage} from "./mock-storage";
import {makeOverseerStorage} from "../src/storage-schema/overseer-storage";
import {GitStore} from "../src/git-store";
import {MAX_GIT_OBJECT_SIZE, WorkspaceGitCache} from "../src/git-cache";
import {buildPackStream, decodeLooseObject, decodePackStream} from "../src/git-codec";

function fixture() {
  const storage = makeOverseerStorage(makeMockStorage());
  const git = new GitStore(storage.gitObjects);
  const cache = new WorkspaceGitCache(storage, {async pull() {throw new Error("unexpected pull");}});
  return {storage, git, cache};
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

it("accepts the bounded raw upload limit and rejects larger payloads before storing anything", async () => {
  const {git, storage} = fixture();
  await expect(git.writeBlob(new Uint8Array(MAX_GIT_OBJECT_SIZE + 1))).rejects.toThrow("too large");
  expect([...storage.gitObjects.list()]).toEqual([]);
  const bytes = new Uint8Array(MAX_GIT_OBJECT_SIZE);
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, bytes.length)));
  }
  const ref = await git.writeBlob(bytes);
  expect(ref.byteLength).toBe(MAX_GIT_OBJECT_SIZE);
  expect(storage.gitObjects.get(ref.oid)!.data.byteLength).toBeLessThan(8 * 1024 * 1024);
  expect(createHash("sha256").update(git.readBlob(ref.oid)).digest("hex"))
    .toBe(createHash("sha256").update(bytes).digest("hex"));
});

it("reports a storage-size failure without publishing a reference, and a retry has the same identity", async () => {
  const {git, storage} = fixture();
  const put = vi.spyOn(storage.gitObjects, "put").mockImplementation(() => {
    throw new Error("SQLITE_TOOBIG");
  });
  await expect(git.writeBlob(Uint8Array.of(17))).rejects.toThrow("too large");
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
  expect(await git.readCommitFiles(commit)).toEqual(new Map([["a.txt", text]]));
  expect(await cache.readFileAtCommit(commit, "a.txt")).toBe(text);
  const replacement = await git.writeBlob(Uint8Array.of(0, 255));
  const next = await git.writeChangedFilesAsCommit(new Map([["a.txt", replacement]]),
    {...options, treeBase: commit, parents: [commit]});
  await expect(git.readCommitFiles(next)).rejects.toThrow("not a text file");
  expect(git.readBlob(ref.oid)).toEqual(bytes);
  expect(await cache.fileBytesAtCommit(commit, "a.txt")).toEqual(ref);
});
