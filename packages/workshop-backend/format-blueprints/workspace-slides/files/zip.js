const encoder = new TextEncoder();
const ZIP32_MAX = 0xffffffff;
const ZIP32_MAX_ENTRIES = 0xffff;
const UTF8_DATA_DESCRIPTOR_FLAGS = 0x0808;
const DEFLATE_METHOD = 8;
const DOS_TIME = 0;
const DOS_DATE = 33; // 1980-01-01

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC32_TABLE.length; ++i) {
  let value = i;
  for (let bit = 0; bit < 8; ++bit) {
    value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[i] = value >>> 0;
}

export function crc32(bytes, previous = 0) {
  let value = (previous ^ 0xffffffff) >>> 0;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function record(size, write) {
  const bytes = new Uint8Array(size);
  write(new DataView(bytes.buffer));
  return bytes;
}

function localHeader(nameLength) {
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

function dataDescriptor(crc, compressedSize, uncompressedSize) {
  return record(16, (view) => {
    view.setUint32(0, 0x08074b50, true);
    view.setUint32(4, crc, true);
    view.setUint32(8, compressedSize, true);
    view.setUint32(12, uncompressedSize, true);
  });
}

function centralHeader(entry) {
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

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
  return record(22, (view) => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, entryCount, true);
    view.setUint16(10, entryCount, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
  });
}

function byteStream(value) {
  if (value && typeof value.getReader === "function") return value;
  let bytes;
  if (typeof value === "string") bytes = encoder.encode(value);
  else if (value instanceof Uint8Array) bytes = value;
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new TypeError("ZIP entry data must be text, bytes, or a byte stream.");
  }
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function asBytes(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError("ZIP entry streams must contain byte chunks.");
}

function checkedSize(value, label) {
  if (value > ZIP32_MAX) throw new Error(`ZIP32 ${label} exceeds 4 GiB.`);
  return value;
}

async function* generateZip(entries) {
  const centralEntries = [];
  let offset = 0;

  const emit = (bytes) => {
    checkedSize(offset + bytes.byteLength, "archive size");
    offset += bytes.byteLength;
    return bytes;
  };

  for (const sourceEntry of entries) {
    if (centralEntries.length >= ZIP32_MAX_ENTRIES) {
      throw new Error("ZIP32 entry count exceeds 65,535.");
    }
    const name = encoder.encode(String(sourceEntry.name));
    if (name.byteLength === 0) throw new Error("ZIP entry names must not be empty.");
    if (name.byteLength > ZIP32_MAX_ENTRIES) {
      throw new Error("ZIP entry name exceeds 65,535 UTF-8 bytes.");
    }

    const localOffset = offset;
    yield emit(localHeader(name.byteLength));
    yield emit(name);

    let crc = 0;
    let compressedSize = 0;
    let uncompressedSize = 0;
    const rawData = typeof sourceEntry.data === "function"
      ? await sourceEntry.data()
      : sourceEntry.data;
    const measured = byteStream(rawData).pipeThrough(new TransformStream({
      transform(chunk, controller) {
        const bytes = asBytes(chunk);
        uncompressedSize = checkedSize(uncompressedSize + bytes.byteLength, "entry size");
        crc = crc32(bytes, crc);
        controller.enqueue(bytes);
      },
    }));
    const compressed = measured.pipeThrough(new CompressionStream("deflate-raw"));
    const reader = compressed.getReader();
    let completed = false;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          completed = true;
          break;
        }
        const bytes = asBytes(result.value);
        compressedSize = checkedSize(compressedSize + bytes.byteLength, "compressed entry size");
        yield emit(bytes);
      }
    } finally {
      if (!completed) await reader.cancel();
      reader.releaseLock();
    }

    yield emit(dataDescriptor(crc, compressedSize, uncompressedSize));
    centralEntries.push({name, crc, compressedSize, uncompressedSize, localOffset});
  }

  const centralOffset = offset;
  for (const entry of centralEntries) {
    yield emit(centralHeader(entry));
    yield emit(entry.name);
  }
  const centralSize = offset - centralOffset;
  checkedSize(centralSize, "central directory size");
  yield emit(endOfCentralDirectory(centralEntries.length, centralSize, centralOffset));
}

export function createZip(entries) {
  const iterator = generateZip(entries);
  return new ReadableStream({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return iterator.return(reason);
    },
  });
}
