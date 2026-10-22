import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  BlobReader,
  BlobWriter,
  CHUNK_GEAR_TABLE,
  CHUNK_MAX_SIZE,
  CHUNK_MIN_SIZE,
  ContentChunker,
  blobByteStream,
  isChunkedBlobRecord,
  type ChunkStore,
  type PendingBlob,
} from "../src/git-chunked-blob";
import { encodeLooseObject, gitObjectOid } from "../src/git-codec";
import type { GitChunkedBlobRecord, GitObjectRecord } from "../src/storage-schema/overseer-storage";

const MiB = 1024 * 1024;
const NL = 0x0a;

// Deterministic pseudo-random bytes (xorshift32, top byte of each state).
function randomBytes(size: number, seed: number): Uint8Array {
  let out = new Uint8Array(size);
  let s = seed >>> 0;
  for (let i = 0; i < size; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = s >>> 24;
  }
  return out;
}

function noNewlines(bytes: Uint8Array): Uint8Array {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === NL) bytes[i] = 0x0b;
  return bytes;
}

function sha1(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength)
      .equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

function concat(parts: Uint8Array[]): Uint8Array {
  let out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (let part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

class MapStore implements ChunkStore {
  rows = new Map<string, GitObjectRecord>();
  puts = 0;
  get(oid: string) { return this.rows.get(oid); }
  put(record: GitObjectRecord) {
    this.puts++;
    this.rows.set(record.oid, record);
  }
}

function cutsOf(data: Uint8Array, split?: number): number[] {
  let chunker = new ContentChunker();
  let cuts: number[] = [];
  let step = split ?? data.length;
  for (let pos = 0; pos < data.length; pos += step) {
    cuts.push(...chunker.push(data.subarray(pos, pos + step)));
  }
  let end = chunker.finish();
  if (end !== undefined) cuts.push(end);
  return cuts;
}

function chunkHashes(data: Uint8Array): string[] {
  let hashes: string[] = [];
  let start = 0;
  for (let cut of cutsOf(data)) {
    hashes.push(sha1(data.subarray(start, cut)));
    start = cut;
  }
  return hashes;
}

// Writes a blob to a store, stores its record as #putObject would, and opens it.
function store(data: Uint8Array): { store: MapStore, blob: PendingBlob, reader: BlobReader } {
  let s = new MapStore();
  let writer = new BlobWriter(s, data.length);
  writer.write(data);
  let blob = writer.finish();
  let record: GitObjectRecord = blob.record ??
      { oid: blob.oid, data: encodeLooseObject("blob", blob.payload) };
  s.put(record);
  return { store: s, blob, reader: BlobReader.open(s, record) };
}

function chunkedRecord(blob: PendingBlob): GitChunkedBlobRecord {
  if (blob.record === undefined) throw new Error("expected a chunked blob");
  return blob.record;
}

// Checks lineStart and newlines against a naive scan of the whole payload.
function checkLines(payload: Uint8Array, options: { expectChunked?: boolean } = {}) {
  let { reader, blob } = store(payload);
  if (options.expectChunked !== undefined) {
    expect(blob.record !== undefined).toBe(options.expectChunked);
  }
  let starts = [0];
  for (let i = 0; i < payload.length; i++) if (payload[i] === NL) starts.push(i + 1);
  expect(reader.newlines).toBe(starts.length - 1);
  for (let line = 0; line < starts.length; line++) {
    expect(reader.lineStart(line), `line ${line}`).toBe(starts[line]);
  }
  return { reader, blob };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  let parts: Uint8Array[] = [];
  for await (let part of stream) parts.push(part);
  return concat(parts);
}

describe("ContentChunker", () => {
  it("has the golden gear table", () => {
    expect(CHUNK_GEAR_TABLE[0]).toBe(0x6d56a94b);
    expect(CHUNK_GEAR_TABLE[255]).toBe(0x8dd16c8f);
    expect(createHash("sha256").update(new Uint8Array(CHUNK_GEAR_TABLE.buffer)).digest("hex"))
        .toBe("cbf0219e5bdb21b0791fedd28179d044acf11a69bb6754727665b5903e270ebb");
  });

  it("cuts a fixed input at golden offsets (if this changes, the storage format changed)", () => {
    expect(cutsOf(randomBytes(4 * MiB, 1))).toEqual([
      286131, 360883, 644373, 833577, 1342956, 1445533, 1709785, 2038841, 2195680, 2474360,
      2540602, 2989785, 3093352, 3397798, 3660803, 3948797, 4194304,
    ]);
  });

  it("keeps every chunk but the last within [CHUNK_MIN_SIZE, CHUNK_MAX_SIZE]", () => {
    let data = randomBytes(8 * MiB + 3, 2);
    let cuts = cutsOf(data);
    let start = 0;
    for (let [i, cut] of cuts.entries()) {
      let size = cut - start;
      expect(size, `chunk ${i}`).toBeLessThanOrEqual(CHUNK_MAX_SIZE);
      if (i < cuts.length - 1) expect(size, `chunk ${i}`).toBeGreaterThan(CHUNK_MIN_SIZE);
      start = cut;
    }
    expect(start).toBe(data.length);
    // A constant input never matches a mask, so every cut is forced at CHUNK_MAX_SIZE.
    expect(cutsOf(new Uint8Array(3 * MiB + 5).fill(0x78)))
        .toEqual([MiB, 2 * MiB, 3 * MiB, 3 * MiB + 5]);
  });

  it("cuts the same however the input is split", () => {
    let data = randomBytes(2 * MiB, 3);
    let whole = cutsOf(data);
    expect(cutsOf(data, 1)).toEqual(whole);
    expect(cutsOf(data, 4093)).toEqual(whole);
    expect(cutsOf(data, CHUNK_MIN_SIZE)).toEqual(whole);
  });

  it("reports no final chunk for empty input", () => {
    expect(new ContentChunker().finish()).toBeUndefined();
  });

  // Edit locality is probabilistic, not guaranteed: with these fixed seeds it holds exactly.
  describe("edit locality", () => {
    let original = randomBytes(16 * MiB, 4);
    let originalHashes = new Set(chunkHashes(original));
    let changed = (edited: Uint8Array) => {
      let hashes = chunkHashes(edited);
      return { total: hashes.length, changed: hashes.filter(h => !originalHashes.has(h)).length };
    };

    it("an insertion in the middle changes at most 3 chunks", () => {
      let mid = 8 * MiB + 12345;
      let result = changed(concat([original.subarray(0, mid), randomBytes(100, 5),
                                   original.subarray(mid)]));
      expect(result.changed).toBeLessThanOrEqual(3);
      expect(result.total).toBeGreaterThan(40);
    });

    it("a deletion in the middle changes at most 3 chunks", () => {
      let mid = 8 * MiB + 54321;
      let result = changed(concat([original.subarray(0, mid), original.subarray(mid + 100)]));
      expect(result.changed).toBeLessThanOrEqual(3);
    });

    it("an edit at the very start changes at most 3 chunks", () => {
      let edited = original.slice();
      edited.set(randomBytes(100, 6), 0);
      expect(changed(edited).changed).toBeLessThanOrEqual(3);
      expect(changed(concat([randomBytes(7, 7), original])).changed).toBeLessThanOrEqual(3);
    });
  });
});

describe("BlobWriter", () => {
  for (let size of [0, 1, CHUNK_MAX_SIZE, CHUNK_MAX_SIZE + 1, 3.5 * MiB, 20 * MiB]) {
    it(`names a ${size}-byte blob by its whole-blob oid`, async () => {
      let data = randomBytes(size, size + 1);
      let expected = await gitObjectOid("blob", data);
      for (let declare of [true, false]) {
        let s = new MapStore();
        let writer = new BlobWriter(s, declare ? size : undefined);
        for (let pos = 0; pos < size; pos += 300_007) writer.write(data.subarray(pos, pos + 300_007));
        let blob = writer.finish();
        expect(blob.oid).toBe(expected);
        expect(blob.size).toBe(size);
        if (size <= CHUNK_MAX_SIZE) {
          expect(blob.record).toBeUndefined();
          expect(sameBytes(blob.payload!, data)).toBe(true);
          expect(s.puts).toBe(0);
        } else {
          let record = chunkedRecord(blob);
          expect(record.oid).toBe(expected);
          expect(record.chunks[0].offset).toBe(0);
          expect(record.chunks.length).toBeGreaterThan(1);
          expect(s.rows.has(expected)).toBe(false);  // the index row is the caller's
          for (let chunk of record.chunks) {
            let row = s.rows.get(chunk.oid)!;
            expect(isChunkedBlobRecord(row)).toBe(false);
          }
        }
      }
    });
  }

  it("throws when the content overruns or falls short of its declared size", () => {
    let writer = new BlobWriter(new MapStore(), 10);
    writer.write(new Uint8Array(6));
    expect(() => writer.write(new Uint8Array(5))).toThrow("larger than its declared size");
    let short = new BlobWriter(new MapStore(), 2 * MiB);
    short.write(new Uint8Array(MiB + 7));
    expect(() => short.finish()).toThrow("smaller than its declared size");
  });

  it("copies what it is given, so callers may reuse their buffers", async () => {
    let data = randomBytes(3 * MiB, 8);
    let s = new MapStore();
    let writer = new BlobWriter(s, data.length);
    let scratch = new Uint8Array(65536);
    for (let pos = 0; pos < data.length; pos += scratch.length) {
      scratch.set(data.subarray(pos, pos + scratch.length));
      writer.write(scratch.subarray(0, Math.min(scratch.length, data.length - pos)));
      scratch.fill(0xee);
    }
    let blob = writer.finish();
    expect(blob.oid).toBe(await gitObjectOid("blob", data));
    s.put(blob.record!);
    let reader = BlobReader.open(s, blob.record!);
    expect(sameBytes(reader.read(0, reader.size), data)).toBe(true);
  });
});

describe("BlobReader", () => {
  let data = randomBytes(3.5 * MiB, 9);
  let sample = store(data);
  let chunks = chunkedRecord(sample.blob).chunks;

  it("reads ranges at the start, across chunk boundaries, and at the end", () => {
    expect(chunks.length).toBeGreaterThan(3);
    let ranges: [number, number][] = [[0, 0], [0, 1], [0, 100], [data.length - 1, 1],
                                      [data.length, 0], [data.length - 1000, 1000],
                                      [0, data.length]];
    for (let chunk of chunks.slice(1)) {
      ranges.push([chunk.offset - 1, 2], [chunk.offset - 10, 20], [chunk.offset, 5]);
    }
    ranges.push([chunks[1].offset - 5, chunks[3].offset - chunks[1].offset + 10]);
    for (let [offset, length] of ranges) {
      expect(sameBytes(sample.reader.read(offset, length), data.subarray(offset, offset + length)),
             `${offset}+${length}`).toBe(true);
      expect(sameBytes(concat([...sample.reader.pieces({ offset, length })]),
                       data.subarray(offset, offset + length))).toBe(true);
    }
    let pieces = [...sample.reader.pieces()];
    expect(pieces).toHaveLength(chunks.length);
    expect(sameBytes(concat(pieces), data)).toBe(true);
  });

  it("rejects out-of-bounds ranges", () => {
    for (let [offset, length] of [[-1, 1], [0, data.length + 1], [data.length, 1], [1.5, 1],
                                  [0, -1], [NaN, 0]]) {
      expect(() => sample.reader.read(offset, length)).toThrow(RangeError);
      expect(() => sample.reader.pieces({ offset, length })).toThrow(RangeError);
    }
    expect(() => sample.reader.lineStart(-1)).toThrow(RangeError);
    expect(() => sample.reader.lineStart(sample.reader.newlines + 1)).toThrow(RangeError);
  });

  it("detects a chunk of the wrong size or type as corruption", () => {
    let { store: s, blob: written } = store(randomBytes(3 * MiB, 17));
    let record = chunkedRecord(written);
    s.rows.set(record.chunks[1].oid, { oid: record.chunks[1].oid,
                                       data: encodeLooseObject("blob", new Uint8Array(3)) });
    let corrupt = BlobReader.open(s, record);
    expect(corrupt.read(0, 10)).toHaveLength(10);
    expect(() => corrupt.read(record.chunks[1].offset, 1))
        .toThrow(`corrupt chunked blob ${record.oid}`);
    s.rows.delete(record.chunks[2].oid);
    expect(() => corrupt.read(record.chunks[2].offset, 1)).toThrow("corrupt chunked blob");
  });

  it("refuses to open an inline non-blob", () => {
    let s = new MapStore();
    expect(() => BlobReader.open(s, { oid: "t", data: encodeLooseObject("tree", new Uint8Array()) }))
        .toThrow("is a tree, not a blob");
  });

  describe("lineStart", () => {
    it("handles a newline-free file of several chunks", () => {
      let { blob, reader } = checkLines(noNewlines(randomBytes(2 * MiB, 10)),
                                        { expectChunked: true });
      let record = chunkedRecord(blob);
      expect(record.chunks.length).toBeGreaterThanOrEqual(4);
      expect(record.chunks.every(chunk => chunk.line === 0)).toBe(true);
      expect(reader.lineStart(0)).toBe(0);
    });

    it("handles one long line spanning several chunks between short ones", () => {
      let text = new TextEncoder();
      let { blob } = checkLines(concat([
        text.encode("short\nlines\nbefore\n"),
        noNewlines(randomBytes(3 * MiB, 11)),
        text.encode("\nand\nafter\n\n"),
        noNewlines(randomBytes(100, 12)),
      ]), { expectChunked: true });
      let lines = chunkedRecord(blob).chunks.map(chunk => chunk.line);
      expect(lines.filter(line => line === 3).length).toBeGreaterThan(2);
    });

    it("handles newlines that are exactly a chunk's last byte and a chunk's first byte", () => {
      // A constant input is cut only where forced, at multiples of CHUNK_MAX_SIZE; neither edit
      // below moves a cut (a chunk's first bytes are not hashed, and a cut after its last byte
      // is where the forced one is anyway).
      let payload = new Uint8Array(3 * MiB + 100).fill(0x78);
      payload[MiB - 1] = NL;
      payload[2 * MiB] = NL;
      payload[2 * MiB + 7] = NL;
      let { blob } = checkLines(payload, { expectChunked: true });
      expect(chunkedRecord(blob).chunks.map(({ offset, line }) => ({ offset, line }))).toEqual([
        { offset: 0, line: 0 }, { offset: MiB, line: 1 }, { offset: 2 * MiB, line: 1 },
        { offset: 3 * MiB, line: 3 },
      ]);
    });

    it("handles a file ending in a newline, whose last line is empty and starts at size", () => {
      let payload = concat([randomBytes(2 * MiB, 13), new Uint8Array([NL])]);
      let { reader } = checkLines(payload, { expectChunked: true });
      expect(reader.lineStart(reader.newlines)).toBe(payload.length);
    });

    it("handles an inline record", () => {
      checkLines(new TextEncoder().encode("one\ntwo\n\nthree"), { expectChunked: false });
      checkLines(randomBytes(500_000, 14), { expectChunked: false });
      let { reader } = checkLines(new Uint8Array(), { expectChunked: false });
      expect(reader.size).toBe(0);
      expect([...reader.pieces()]).toEqual([]);
    });
  });
});

describe("blobByteStream", () => {
  it("streams a blob of repeated chunks without disturbing the reader's cache", async () => {
    let block = randomBytes(MiB, 15);
    let data = concat([block, block, block, block, block, block]);
    let { reader, blob } = store(data);
    let oids = chunkedRecord(blob).chunks.map(chunk => chunk.oid);
    expect(new Set(oids).size).toBeLessThan(oids.length);  // some chunk repeats

    expect(sameBytes(await drain(blobByteStream(reader)), data)).toBe(true);
    // The pieces handed out were copies: the cached chunks behind them (the last few, so read
    // the end first) are intact.
    expect(sameBytes(reader.read(data.length - 100, 100), data.subarray(data.length - 100)))
        .toBe(true);
    expect(sameBytes(concat([...reader.pieces()]), data)).toBe(true);

    let range = { offset: MiB - 3, length: 2 * MiB + 6 };
    expect(sameBytes(await drain(blobByteStream(reader, range)),
                     data.subarray(range.offset, range.offset + range.length))).toBe(true);
    expect(sameBytes(reader.read(range.offset, range.length),
                     data.subarray(range.offset, range.offset + range.length))).toBe(true);
  });

  it("streams an inline blob without disturbing its reader", async () => {
    let data = randomBytes(1000, 18);
    let { reader } = store(data);
    expect(sameBytes(await drain(blobByteStream(reader)), data)).toBe(true);
    expect(sameBytes(reader.read(0, data.length), data)).toBe(true);
  });

  it("streams an empty blob, and errors with what the pull hook throws", async () => {
    expect(await drain(blobByteStream(store(new Uint8Array()).reader))).toHaveLength(0);
    let { reader } = store(randomBytes(3 * MiB, 16));
    let pulls = 0;
    let stream = blobByteStream(reader, undefined, () => {
      if (++pulls === 2) throw new Error("revoked");
    });
    await expect(drain(stream)).rejects.toThrow("revoked");
  });
});
