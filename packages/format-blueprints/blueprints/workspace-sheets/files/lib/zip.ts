// Minimal streaming ZIP writer: DEFLATE entries with data descriptors, so
// sizes and CRCs are written after each entry has streamed through.
//
// Only the 32-bit ZIP format is implemented. The platform caps exports well
// below 4 GiB, so the ZIP64 thresholds are unreachable here.

const encoder = new TextEncoder();
const UTF8_DATA_DESCRIPTOR_FLAGS = 0x0808;
const DEFLATE_METHOD = 8;
const DOS_TIME = 0;
const DOS_DATE = 33; // 1980-01-01

/** The bytes of one entry: a string (encoded as UTF-8) or a stream of chunks. */
export type ZipEntryData = string | ReadableStream<Uint8Array>;

/** One file to write into the archive. */
export interface ZipEntry {
  name: string;
  data: ZipEntryData;
}

/** What the central directory records about an entry once it has streamed through. */
interface CentralEntry {
  name: Uint8Array;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC32_TABLE.length; ++i) {
  let value = i;
  for (let bit = 0; bit < 8; ++bit) {
    value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[i] = value >>> 0;
}

export function crc32(bytes: Uint8Array, previous = 0): number {
  let value = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; ++i) value = CRC32_TABLE[(value ^ bytes[i]) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function record(size: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(size);
  write(new DataView(bytes.buffer));
  return bytes;
}

function localHeader(nameLength: number): Uint8Array {
  return record(30, (view) => {
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, UTF8_DATA_DESCRIPTOR_FLAGS, true);
    view.setUint16(8, DEFLATE_METHOD, true);
    view.setUint16(10, DOS_TIME, true);
    view.setUint16(12, DOS_DATE, true);
    view.setUint16(26, nameLength, true);
  });
}

function dataDescriptor(crc: number, compressedSize: number, uncompressedSize: number): Uint8Array {
  return record(16, (view) => {
    view.setUint32(0, 0x08074b50, true);
    view.setUint32(4, crc, true);
    view.setUint32(8, compressedSize, true);
    view.setUint32(12, uncompressedSize, true);
  });
}

function centralHeader(entry: CentralEntry): Uint8Array {
  return record(46, (view) => {
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, UTF8_DATA_DESCRIPTOR_FLAGS, true);
    view.setUint16(10, DEFLATE_METHOD, true);
    view.setUint16(12, DOS_TIME, true);
    view.setUint16(14, DOS_DATE, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.compressedSize, true);
    view.setUint32(24, entry.uncompressedSize, true);
    view.setUint16(28, entry.name.length, true);
    view.setUint32(42, entry.localOffset, true);
  });
}

function endOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number): Uint8Array {
  return record(22, (view) => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, entryCount, true);
    view.setUint16(10, entryCount, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
  });
}

function byteStream(data: ZipEntryData): ReadableStream<Uint8Array> {
  if (typeof data !== "string") return data;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(data));
      controller.close();
    },
  });
}

async function* generateZip(entries: Iterable<ZipEntry>): AsyncGenerator<Uint8Array, void, unknown> {
  const centralEntries: CentralEntry[] = [];
  let offset = 0;
  const emit = (bytes: Uint8Array) => {
    offset += bytes.byteLength;
    return bytes;
  };

  for (const {name: rawName, data} of entries) {
    const name = encoder.encode(rawName);
    const localOffset = offset;
    yield emit(localHeader(name.byteLength));
    yield emit(name);

    let crc = 0;
    let compressedSize = 0;
    let uncompressedSize = 0;
    const measured = byteStream(data).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        uncompressedSize += chunk.byteLength;
        crc = crc32(chunk, crc);
        controller.enqueue(chunk);
      },
    }));
    for await (const chunk of measured.pipeThrough(new CompressionStream("deflate-raw"))) {
      compressedSize += chunk.byteLength;
      yield emit(chunk);
    }

    yield emit(dataDescriptor(crc, compressedSize, uncompressedSize));
    centralEntries.push({name, crc, compressedSize, uncompressedSize, localOffset});
  }

  const centralOffset = offset;
  for (const entry of centralEntries) {
    yield emit(centralHeader(entry));
    yield emit(entry.name);
  }
  yield emit(endOfCentralDirectory(centralEntries.length, offset - centralOffset, centralOffset));
}

/**
 * Streams a ZIP archive of `entries`, each `{name, data}` where `data` is a
 * string or a `ReadableStream<Uint8Array>`. Entries are compressed one at a
 * time, in order, as the returned stream is read.
 */
export function createZip(entries: Iterable<ZipEntry>): ReadableStream<Uint8Array> {
  const iterator = generateZip(entries);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await iterator.next();
      if (result.done) controller.close();
      else controller.enqueue(result.value);
    },
    // Settles once the generator has finished closing, as the returned promise did in the
    // untyped original; the stream's `cancel` contract is `Promise<void>`. `reason` keeps the
    // stream API's own (untyped) parameter type, which is what the generator's `return` takes.
    async cancel(reason) {
      await iterator.return(reason);
    },
  });
}
