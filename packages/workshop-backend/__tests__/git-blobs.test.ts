import {createHash} from "node:crypto";
import {expect, it, vi} from "vitest";
import {makeMockStorage} from "./mock-storage";
import {makeOverseerStorage} from "../src/storage-schema/overseer-storage";
import {assertWholeTextFits, isTextBlob, MAX_WHOLE_TEXT_BYTES, MAX_WHOLE_TEXT_LINES, UnreadableContentError, WorkspaceGitCache} from "../src/git-cache";
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

it("refuses a chunked blob read as a commit without reading its chunks", async () => {
  const {git, storage} = fixture();
  const ref = await git.writeBlob(new Uint8Array(4 * 1024 * 1024).fill(7));
  const get = storage.gitObjects.get.bind(storage.gitObjects);
  const reads: string[] = [];
  storage.gitObjects.get = (oid: string) => {
    reads.push(oid);
    return get(oid);
  };
  expect(() => git.readCommitLog(ref.oid)).toThrow("is a blob, but a commit was expected");
  expect(reads).toEqual([ref.oid]);
});

it("reports a storage failure without publishing a reference, and a retry has the same identity", async () => {
  const {git, storage} = fixture();
  const put = vi.spyOn(storage.gitObjects, "put").mockImplementation(() => {
    throw new Error("storage failed");
  });
  expect(() => git.writeBlob(Uint8Array.of(17))).toThrow("storage failed");
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

it("asks for room before storing a blob over CHUNK_MAX_SIZE, and before each new chunk", async () => {
  const storage = makeOverseerStorage(makeMockStorage());
  const asked: number[] = [];
  let refuseAfter = Infinity;
  const git = new WorkspaceGitCache(storage, {async pull() {throw new Error("unexpected pull");}},
    byteLength => {
      if (asked.length >= refuseAfter) throw new Error("no room");
      asked.push(byteLength);
    });
  // Varied bytes, so the blob cuts into several distinct chunks.
  const large = Uint8Array.from({length: 3 * 1024 * 1024}, (_, i) => (i * 2654435761) >>> 24);
  git.writeBlob(Uint8Array.of(1));
  expect(asked).toEqual([]);
  const ref = git.writeBlob(large);
  expect(asked[0]).toBe(large.byteLength);
  expect(asked.length).toBeGreaterThan(2);
  expect(git.readBlob(ref.oid, ref.byteLength)).toEqual(large);

  const before = [...storage.gitObjects.list()].length;
  asked.length = 0;
  refuseAfter = 0;
  expect(() => git.writeBlob(large.toReversed())).toThrow("no room");
  let cancelled: unknown;
  const refused = new ReadableStream<Uint8Array>({
    pull: controller => controller.enqueue(large.toReversed()),
    cancel: reason => { cancelled = reason; },
  });
  await expect(git.writeBlobStream(refused, large.byteLength)).rejects.toThrow("no room");
  expect(cancelled).toBeInstanceOf(Error);
  expect([...storage.gitObjects.list()]).toHaveLength(before);
  // A small blob is never refused, streamed or not, of known length or not.
  const small = Uint8Array.of(4, 5, 6);
  expect((await git.writeBlobStream(new Blob([small]).stream(), small.byteLength)).byteLength).toBe(3);
  expect((await git.writeBlobStream(new Blob([small.toReversed()]).stream())).byteLength).toBe(3);
  expect(asked).toEqual([]);
  // A stream of unknown length is refused at the chunk that finds no room.
  refuseAfter = 2;
  await expect(git.writeBlobStream(new Blob([large.toReversed()]).stream())).rejects.toThrow("no room");
  expect(asked).toHaveLength(2);
});

// Its bytes and its text together would crowd the Durable Object, so a new read of a file over
// MAX_WHOLE_TEXT_BYTES, or of more than MAX_WHOLE_TEXT_LINES, is refused as whole text, unread,
// while windowed reads still stream it. The readers replay and folding use still read it, to
// apply edits saved before the limit.
it.each([
  // Long rows, so only the bytes are over the limit.
  ["bytes", "x".repeat(99_999) + "\n", Math.ceil((MAX_WHOLE_TEXT_BYTES + 1) / 100_000)],
  // Short rows, within the bytes but over the lines.
  ["lines", "1\n", MAX_WHOLE_TEXT_LINES + 1],
] as const)("refuses new whole-text reads of a file over the limit on its %s", async (_, row, count) => {
  const {git} = fixture();
  const text = row.repeat(count);
  const ref = await git.writeBlobStream(new Blob([text]).stream(), text.length);
  const commit = await git.writeFilesAsCommit(new Map([["rows.csv", ref]]), options);
  const refusal = `rows.csv is ${text.length} bytes in ${count} lines, too large to read or edit as whole text`;
  await expect(git.readTextBlob(ref.oid, undefined, "rows.csv")).rejects.toThrow(refusal);
  await expect(git.readTextBlob(ref.oid, undefined, "rows.csv")).rejects.toBeInstanceOf(UnreadableContentError);
  await expect(git.readFileAtCommitIfExists(commit, "rows.csv", {limited: true})).rejects.toThrow(refusal);
  const file = await git.openFileAtCommit(commit, "rows.csv");
  expect(() => assertWholeTextFits(file!.reader, "rows.csv")).toThrow(refusal);
  // Unlimited, as replay reads it.
  expect((await git.readFileAtCommitIfExists(commit, "rows.csv"))?.length).toBe(text.length);
  expect(git.readLocalFileAtCommitIfExists(commit, "rows.csv")?.length).toBe(text.length);
});

it("reads a file of as many lines as MAX_WHOLE_TEXT_LINES whole", async () => {
  const {git} = fixture();
  const text = "1\n".repeat(MAX_WHOLE_TEXT_LINES);
  const ref = await git.writeBlobStream(new Blob([text]).stream());
  await expect(git.readTextBlob(ref.oid, undefined, "rows.csv")).resolves.toBe(text);
});

// A blob it can't read is a failure to report, not a binary file: a merge would take a side whole.
it("tells binary from text a piece at a time, and throws for a piece it can't read", async () => {
  const {git, storage} = fixture();
  const piece = "a row of text\n".repeat(100_000);
  const text = await git.writeBlobStream(new Blob([piece, piece]).stream());
  const binary = await git.writeBlobStream(new Blob([piece, "\0", piece]).stream());
  expect(isTextBlob(await git.openBlob(text.oid))).toBe(true);
  expect(isTextBlob(await git.openBlob(binary.oid))).toBe(false);
  const record = storage.gitObjects.get(text.oid)!;
  if (!("chunks" in record)) throw new Error("expected a chunked blob");
  const reader = await git.openBlob(text.oid);
  storage.gitObjects.delete(record.chunks.at(-1)!.oid);
  expect(() => isTextBlob(reader)).toThrow();
});
