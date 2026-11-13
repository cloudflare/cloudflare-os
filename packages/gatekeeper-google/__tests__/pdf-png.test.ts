import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { PngLayout } from "../src/pdf-images";
import { ImageDataError, pngFromDeflated, pngFromSamples } from "../src/pdf-png";
import { byteStream } from "./workers-ai-fixture";

/** A PNG's header fields, its image data inflated, and whether every chunk's checksum holds. */
async function readPng(png: ReadableStream<Uint8Array>) {
  let bytes = new Uint8Array(await new Response(png).arrayBuffer());
  let view = new DataView(bytes.buffer);
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let types: string[] = [], data: Uint8Array[] = [], header: number[] = [];
  for (let at = 8; at < bytes.byteLength;) {
    let length = view.getUint32(at);
    let type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    let body = bytes.subarray(at + 8, at + 8 + length);
    expect(view.getUint32(at + 8 + length)).toBe(crc32(bytes.subarray(at + 4, at + 8 + length)));
    types.push(type);
    if (type === "IDAT") data.push(body);
    if (type === "IHDR") header = [view.getUint32(at + 8), view.getUint32(at + 12), ...body.subarray(8)];
    at += 12 + length;
  }
  return { types, header, rows: new Uint8Array(inflateSync(Buffer.concat(data))) };
}

/** PNG's checksum, bit by bit. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return ~crc >>> 0;
}

const SIZE = { width: 5, height: 4 };
/** Four rows of five RGB pixels. */
const SAMPLES = Uint8Array.from({ length: 60 }, (_, i) => (i * 37) % 256);
const RGB: PngLayout = { colorType: 2, bitDepth: 8, rowBytes: 15, filtered: false };
/** More image data than any PNG here holds. */
const ROOM = 1 << 20;

/** Bytes that do not deflate. */
function noise(length: number): Uint8Array {
  let bytes = new Uint8Array(length);
  for (let i = 0, x = 88172645; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[i] = x;
  }
  return bytes;
}

describe("pngFromDeflated", () => {
  it("adds a filter byte to each row of plain samples, however they are cut into chunks", async () => {
    let deflated = new Uint8Array(deflateSync(SAMPLES));
    for (let sizes of [[deflated.byteLength], [1], [2, 7], [16]]) {
      let png = await readPng(pngFromDeflated(byteStream(deflated, sizes).stream, SIZE, RGB, ROOM));
      expect(png.header).toEqual([5, 4, 8, 2, 0, 0, 0]);
      expect(png.types[0]).toBe("IHDR");
      expect(png.types.at(-1)).toBe("IEND");
      expect(png.types.slice(1, -1).every(type => type === "IDAT")).toBe(true);
      expect(png.rows.byteLength).toBe(4 * 16);
      for (let row = 0; row < 4; row++) {
        expect(png.rows[row * 16]).toBe(0);
        expect(png.rows.subarray(row * 16 + 1, row * 16 + 16)).toEqual(SAMPLES.subarray(row * 15, row * 15 + 15));
      }
    }
  });

  it("frames rows that already carry filter bytes without touching them", async () => {
    let filtered = Uint8Array.from({ length: 4 * 6 }, (_, i) => (i % 6 === 0 ? 2 : i * 11 % 256));
    let deflated = new Uint8Array(deflateSync(filtered));
    let layout: PngLayout = { colorType: 0, bitDepth: 8, rowBytes: 5, filtered: true };
    let png = await readPng(pngFromDeflated(byteStream(deflated, [9]).stream, SIZE, layout, ROOM));
    expect(png.header).toEqual([5, 4, 8, 0, 0, 0, 0]);
    expect(png.rows).toEqual(filtered);
    // The data is the PDF's own bytes: nothing was inflated and deflated again.
    let again = new Uint8Array(await new Response(
      pngFromDeflated(byteStream(deflated, [9]).stream, SIZE, layout, ROOM)).arrayBuffer());
    expect(Buffer.from(again).includes(Buffer.from(deflated.subarray(0, 9)))).toBe(true);
  });

  it("says in the PNG's header how many bits a sample has, whatever the samples are", async () => {
    // Rows of five pixels, from one bit a pixel to six bytes.
    for (let [colorType, bitDepth, rowBytes] of [[0, 1, 1], [0, 2, 2], [0, 4, 3], [0, 16, 10], [2, 16, 30]] as const) {
      let samples = noise(4 * rowBytes);
      let rows = new Uint8Array(4 * (rowBytes + 1));
      for (let row = 0; row < 4; row++) {
        rows.set(samples.subarray(row * rowBytes, (row + 1) * rowBytes), row * (rowBytes + 1) + 1);
      }
      for (let filtered of [false, true]) {
        let deflated = new Uint8Array(deflateSync(filtered ? rows : samples));
        let layout: PngLayout = { colorType, bitDepth, rowBytes, filtered };
        let png = await readPng(pngFromDeflated(byteStream(deflated).stream, SIZE, layout, ROOM));
        expect(png.header).toEqual([5, 4, bitDepth, colorType, 0, 0, 0]);
        expect(png.rows).toEqual(rows);
      }
    }
  });

  it("fails in its own words when plain rows do not inflate, and releases the data", async () => {
    let whole = new Uint8Array(deflateSync(SAMPLES));
    for (let data of [
      Uint8Array.from({ length: 400_000 }, (_, i) => i % 251),
      // Cut short of its last row, and whole but for bytes that are not deflated data before its end.
      whole.subarray(0, whole.byteLength - 6), Uint8Array.of(...whole.subarray(0, 20), 255, 255, ...whole.subarray(20)),
    ]) {
      let source = byteStream(data, [50]);
      await expect(readPng(pngFromDeflated(source.stream, SIZE, RGB, ROOM)))
        .rejects.toBeInstanceOf(ImageDataError);
      // Data that ended before it failed has nothing left to release.
      if (data.byteLength > 100_000) expect(source.state.cancelled).toBe(true);
    }
  });

  // Node inflates on another thread, so under load a turn can pass before it answers, and the
  // bytes held apart are then fed in too soon. workerd, where this runs, answers at once: the
  // workerd tests pin this without a retry.
  it("takes plain rows that are whole, whatever a line end makes of the data after them", { retry: 3 }, async () => {
    let size = { width: 100, height: 300 };
    let layout: PngLayout = { colorType: 0, bitDepth: 8, rowBytes: 100, filtered: false };
    // Samples that deflate, and ones that do not and so end right before the data's checksum.
    for (let samples of [Uint8Array.from({ length: 30_000 }, (_, i) => (i * i) % 251), noise(30_000)]) {
      let whole = new Uint8Array(deflateSync(samples));
      for (let data of [
        // A length that counts the line end before "endstream" into the data.
        Uint8Array.of(...whole, 10), Uint8Array.of(...whole, 13, 10),
        // A length found by searching, where the data's own last bytes read as a line end.
        whole.subarray(0, -1), whole.subarray(0, -2),
      ]) {
        for (let sizes of [[data.byteLength], [1], [4096], [data.byteLength - 1, 1], [data.byteLength - 3, 1]]) {
          let png = await readPng(pngFromDeflated(byteStream(data, sizes).stream, size, layout, ROOM));
          expect(png.rows.byteLength).toBe(300 * 101);
          for (let row = 0; row < 300; row += 13) {
            expect(png.rows.subarray(row * 101, row * 101 + 101))
              .toEqual(Uint8Array.of(0, ...samples.subarray(row * 100, row * 100 + 100)));
          }
        }
      }
    }
  });

  it("fails as soon as plain rows are more than the image has, inflating no further", async () => {
    // 64 MiB of rows, where the image has 60 bytes of them.
    let bomb = byteStream(new Uint8Array(deflateSync(new Uint8Array(64 << 20))), [4096]);
    await expect(readPng(pngFromDeflated(bomb.stream, SIZE, RGB, ROOM)))
      .rejects.toBeInstanceOf(ImageDataError);
    // The data was let go with most of it unread.
    expect(bomb.state.cancelled).toBe(true);

    let extra = new Uint8Array(deflateSync(Uint8Array.of(...SAMPLES, 1)));
    await expect(readPng(pngFromDeflated(byteStream(extra).stream, SIZE, RGB, ROOM)))
      .rejects.toBeInstanceOf(ImageDataError);
  });

  it("fails when plain rows are fewer than the image has", async () => {
    let short = new Uint8Array(deflateSync(SAMPLES.subarray(0, 59)));
    await expect(readPng(pngFromDeflated(byteStream(short).stream, SIZE, RGB, ROOM)))
      .rejects.toBeInstanceOf(ImageDataError);
  });

  it("fails once it holds more image data than it may", async () => {
    // More rows than are deflated in one step, so that the data is not all drawn in before the
    // limit is met, whatever the order the runtime answers in.
    let size = { width: 1000, height: 600 };
    let layout: PngLayout = { colorType: 0, bitDepth: 8, rowBytes: 1000, filtered: false };
    let rows = new Uint8Array(deflateSync(noise(600_000)));
    expect((await readPng(pngFromDeflated(byteStream(rows).stream, size, layout, 1_000_000))).rows)
      .toHaveLength(600_600);
    for (let filtered of [false, true]) {
      let source = byteStream(rows, [4096]);
      await expect(readPng(pngFromDeflated(source.stream, size, { ...layout, filtered }, 50_000)))
        .rejects.toBeInstanceOf(ImageDataError);
      expect(source.state.cancelled).toBe(true);
    }
  });

  it("passes on the data's own failure as it is", async () => {
    let brokeOff = new Error("The Drive file changed while it was being read; read it again.");
    let deflated = new Uint8Array(deflateSync(noise(60)));
    for (let filtered of [false, true]) {
      let sent = false;
      let data = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) throw brokeOff;
          sent = true;
          controller.enqueue(deflated.subarray(0, 20));
        },
      }, { highWaterMark: 0 });
      await expect(readPng(pngFromDeflated(data, SIZE, { ...RGB, filtered }, ROOM))).rejects.toBe(brokeOff);
    }
  });

  it("cancels the data at once when it is cancelled, even while the data is waited for", async () => {
    let deflated = new Uint8Array(deflateSync(noise(60_000)));
    for (let filtered of [false, true]) {
      let state = { cancelled: false, pulls: 0 };
      // Gives the first of the data, then nothing more.
      let source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (state.pulls++ === 0) controller.enqueue(deflated.subarray(0, 30_000));
        },
        cancel() { state.cancelled = true; },
      }, { highWaterMark: 0 });
      let size = { width: 100, height: 600 };
      let layout: PngLayout = { colorType: 0, bitDepth: 8, rowBytes: 100, filtered };
      let reader = pngFromDeflated(source, size, layout, ROOM).getReader();
      // Reads what the first of the data makes, up to a read that waits on the rest.
      let waiting: Promise<ReadableStreamReadResult<Uint8Array>>;
      for (;;) {
        waiting = reader.read();
        let pause = new Promise<"waited">(resolve => setTimeout(resolve, 20, "waited"));
        if (await Promise.race([waiting, pause]) === "waited") break;
      }
      await reader.cancel();
      expect(state.cancelled).toBe(true);
      expect((await waiting).done).toBe(true);
    }
  });
});

/** Four rows of five grey pixels. */
const GREY_SAMPLES = Uint8Array.from({ length: 20 }, (_, i) => (i * 53 + 7) % 256);
const GREY: PngLayout = { colorType: 0, bitDepth: 8, rowBytes: 5, filtered: false };
/** A page of 1,200 rows of a thousand grey pixels: more rows than are deflated in four steps. */
const PAGE = { width: 1000, height: 1200 };
const PAGE_GREY: PngLayout = { colorType: 0, bitDepth: 8, rowBytes: 1000, filtered: false };
/** Bytes of rows deflated in one step: the source's `DEFLATE_STEP_BYTES`. */
const STEP = 256 * 1024;

/** `bytes` as a stream that gives `size` of them when asked and no sooner, and counts what it gave. */
function countedStream(bytes: Uint8Array, size: number) {
  let state = { given: 0, cancelled: false };
  let stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.given >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.slice(state.given, state.given + size));
      state.given = Math.min(bytes.byteLength, state.given + size);
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, state };
}

/** Waits until `state` has stood still for a while: what was being fed in has all been. */
async function settled(state: { given: number }) {
  for (let before = -1; before !== state.given;) {
    before = state.given;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

/**
 * A compression stream as workerd's are: it takes every write at once, whether or not anything
 * reads what comes of it, where Node's holds a write back until what it made has been read.
 * What it makes is deflate's stored blocks, one a write, so a reader inflates it to what was fed.
 */
class EagerDeflate {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  constructor() {
    // The data's checksum, Adler-32, in its two halves.
    let low = 1, high = 0, begun = false;
    let whole = new TransformStream<Uint8Array, Uint8Array>({
      transform(fed, controller) {
        // A stored block holds 65,535 bytes at most, and the first follows the data's header.
        expect(fed.byteLength).toBeLessThan(65536);
        let at = begun ? 0 : 2;
        begun = true;
        let out = new Uint8Array(at + 5 + fed.byteLength);
        let view = new DataView(out.buffer);
        if (at > 0) view.setUint16(0, 0x7801);
        view.setUint16(at + 1, fed.byteLength, true);
        view.setUint16(at + 3, ~fed.byteLength & 0xffff, true);
        out.set(fed, at + 5);
        for (let byte of fed) {
          low = (low + byte) % 65521;
          high = (high + low) % 65521;
        }
        controller.enqueue(out);
      },
      flush(controller) {
        let out = Uint8Array.of(1, 0, 0, 0xff, 0xff, 0, 0, 0, 0);
        new DataView(out.buffer).setUint32(5, (high << 16 | low) >>> 0);
        controller.enqueue(begun ? out : Uint8Array.of(0x78, 0x01, ...out));
      },
    }, { highWaterMark: Infinity }, { highWaterMark: Infinity });
    this.readable = whole.readable;
    this.writable = whole.writable;
  }
}

/**
 * Reads a page's PNG piece by piece, holding the samples it draws to a step at each: none for
 * a PNG nobody reads, a step for the first of the image data, and a step more for a later read
 * at most. `whole` says that a step is fed in whole whatever is read, which an eager stream does.
 */
async function readByStep(whole: boolean) {
  let samples = noise(PAGE.width * PAGE.height);
  // Pieces of ten rows, of which a step ends inside one.
  let chunk = 10_000;
  let source = countedStream(samples, chunk);
  let reader = pngFromSamples(source.stream, PAGE, PAGE_GREY, ROOM * 2).getReader();
  // Nothing is read for a PNG nobody reads, nor for its signature and header.
  await settled(source.state);
  expect(source.state.given).toBe(0);
  let pieces = [(await reader.read()).value!, (await reader.read()).value!];
  expect(pieces[0]).toHaveLength(8);
  expect(String.fromCharCode(...pieces[1]!.subarray(4, 8))).toBe("IHDR");
  await settled(source.state);
  expect(source.state.given).toBe(0);
  // The first of the image data takes one step of rows, with the piece of samples the step
  // ended in, and no more follows while nothing is read.
  pieces.push((await reader.read()).value!);
  expect(String.fromCharCode(...pieces[2]!.subarray(4, 8))).toBe("IDAT");
  await settled(source.state);
  expect(source.state.given).toBeGreaterThan(whole ? STEP - chunk : 0);
  expect(source.state.given).toBeLessThanOrEqual(STEP + chunk);
  // From there on a read takes a step more at most.
  for (;;) {
    let before = source.state.given;
    let piece = await reader.read();
    if (piece.done) break;
    pieces.push(piece.value);
    if (source.state.given === before) continue;
    await settled(source.state);
    expect(source.state.given - before).toBeLessThanOrEqual(STEP + chunk);
  }
  expect(source.state.given).toBe(samples.byteLength);
  let png = await readPng(new Blob(pieces).stream());
  expect(png.rows).toHaveLength(PAGE.height * 1001);
  for (let row = 0; row < PAGE.height; row += 97) {
    expect(png.rows.subarray(row * 1001, row * 1001 + 1001))
      .toEqual(Uint8Array.of(0, ...samples.subarray(row * 1000, row * 1000 + 1000)));
  }
}

describe("pngFromSamples", () => {
  it("makes a PNG whose data inflates to each row behind a filter byte", async () => {
    let png = await readPng(pngFromSamples(byteStream(GREY_SAMPLES).stream, SIZE, GREY, ROOM));
    expect(png.header).toEqual([5, 4, 8, 0, 0, 0, 0]);
    expect(png.types[0]).toBe("IHDR");
    expect(png.types.at(-1)).toBe("IEND");
    expect(png.types.length).toBeGreaterThan(2);
    expect(png.types.slice(1, -1).every(type => type === "IDAT")).toBe(true);
    expect(png.rows.byteLength).toBe(4 * 6);
    for (let row = 0; row < 4; row++) {
      expect(png.rows[row * 6]).toBe(0);
      expect(png.rows.subarray(row * 6 + 1, row * 6 + 6)).toEqual(GREY_SAMPLES.subarray(row * 5, row * 5 + 5));
    }
  });

  it("takes a row to be as many bytes as the layout says, which is not the image's width", async () => {
    // Rows of five RGB pixels, of twenty one-bit pixels and of five sixteen-bit ones: fifteen
    // bytes, three and ten.
    let layouts: [PngLayout, number, number[]][] = [
      [RGB, 5, [5, 4, 8, 2, 0, 0, 0]],
      [{ colorType: 0, bitDepth: 1, rowBytes: 3, filtered: false }, 20, [20, 4, 1, 0, 0, 0, 0]],
      [{ colorType: 0, bitDepth: 16, rowBytes: 10, filtered: false }, 5, [5, 4, 16, 0, 0, 0, 0]],
    ];
    for (let [layout, width, header] of layouts) {
      let { rowBytes } = layout;
      let samples = Uint8Array.from({ length: 4 * rowBytes }, (_, i) => (i * 37 + 11) % 256);
      let size = { width, height: 4 };
      for (let sizes of [[samples.byteLength], [1], [rowBytes], [rowBytes - 1, 2], [rowBytes + 1]]) {
        let png = await readPng(pngFromSamples(byteStream(samples, sizes).stream, size, layout, ROOM));
        expect(png.header).toEqual(header);
        expect(png.rows.byteLength).toBe(4 * (rowBytes + 1));
        for (let row = 0; row < 4; row++) {
          expect(png.rows.subarray(row * (rowBytes + 1), (row + 1) * (rowBytes + 1)))
            .toEqual(Uint8Array.of(0, ...samples.subarray(row * rowBytes, (row + 1) * rowBytes)));
        }
      }
      // A row fewer and a row more are counted in the layout's bytes too.
      let short = byteStream(samples.subarray(0, 3 * rowBytes), [7]).stream;
      await expect(readPng(pngFromSamples(short, size, layout, ROOM))).rejects.toBeInstanceOf(ImageDataError);
      let long = byteStream(Uint8Array.of(...samples, ...samples.subarray(0, rowBytes)), [7]).stream;
      await expect(readPng(pngFromSamples(long, size, layout, ROOM))).rejects.toBeInstanceOf(ImageDataError);
    }
  });

  it("makes the same image data of samples cut anywhere as of samples that come whole", async () => {
    let samples = noise(PAGE.width * 40);
    let size = { width: PAGE.width, height: 40 };
    let whole = await readPng(pngFromSamples(byteStream(samples).stream, size, PAGE_GREY, ROOM));
    expect(whole.rows.byteLength).toBe(40 * 1001);
    for (let row = 0; row < 40; row++) {
      expect(whole.rows.subarray(row * 1001, row * 1001 + 1001))
        .toEqual(Uint8Array.of(0, ...samples.subarray(row * 1000, row * 1000 + 1000)));
    }
    // Pieces that end inside a row, on a row's last byte, and one byte at a time around a row's end.
    for (let sizes of [[1], [7], [333, 667], [999, 1, 1, 999], [1001], [2500], [39_999, 1]]) {
      let png = await readPng(pngFromSamples(byteStream(samples, sizes).stream, size, PAGE_GREY, ROOM));
      expect(png.header).toEqual(whole.header);
      expect(Buffer.from(png.rows).equals(Buffer.from(whole.rows))).toBe(true);
    }
  });

  it("fails when the samples are a row more than the image has, or a row fewer", async () => {
    let rows = Uint8Array.from({ length: 25 }, (_, i) => (i * 29) % 256);
    for (let samples of [rows, rows.subarray(0, 15), rows.subarray(0, 21), rows.subarray(0, 19), new Uint8Array(0)]) {
      for (let sizes of [[samples.byteLength || 1], [3]]) {
        await expect(readPng(pngFromSamples(byteStream(samples, sizes).stream, SIZE, GREY, ROOM)))
          .rejects.toBeInstanceOf(ImageDataError);
      }
    }
    // Rows past the image's are not waited for to their end.
    let endless = countedStream(new Uint8Array(64 << 20), 4096);
    await expect(readPng(pngFromSamples(endless.stream, SIZE, GREY, ROOM))).rejects.toBeInstanceOf(ImageDataError);
    expect(endless.state.cancelled).toBe(true);
    expect(endless.state.given).toBeLessThan(1 << 20);
  });

  it("fails once it holds more image data than it may, and cancels the samples", async () => {
    // Samples that do not deflate, so the image data is about as large as they are.
    let samples = noise(PAGE.width * PAGE.height);
    let fits = await readPng(pngFromSamples(byteStream(samples).stream, PAGE, PAGE_GREY, 2_000_000));
    expect(fits.rows).toHaveLength(PAGE.height * 1001);
    let source = countedStream(samples, 4096);
    await expect(readPng(pngFromSamples(source.stream, PAGE, PAGE_GREY, 50_000)))
      .rejects.toBeInstanceOf(ImageDataError);
    expect(source.state.cancelled).toBe(true);
    // The limit was met with most of the samples unread.
    expect(source.state.given).toBeLessThan(samples.byteLength / 2);
  });

  // Node deflates on another thread, so under load a turn can pass before it answers, and a
  // second step is then fed in for one read.
  it("reads the samples a step at a time, and only as the PNG is read", { retry: 3 }, async () => {
    await readByStep(false);
  });

  it("reads the samples a step at a time when every write is taken at once, as workerd takes them", async () => {
    vi.stubGlobal("CompressionStream", EagerDeflate);
    try {
      await readByStep(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("passes on the samples' own failure as it is", async () => {
    let brokeOff = new Error("The page's pixels are gone.");
    let sent = false;
    let samples = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) throw brokeOff;
        sent = true;
        controller.enqueue(GREY_SAMPLES.subarray(0, 7));
      },
    }, { highWaterMark: 0 });
    await expect(readPng(pngFromSamples(samples, SIZE, GREY, ROOM))).rejects.toBe(brokeOff);
  });

  it("cancels the samples at once when it is cancelled, even while they are waited for", async () => {
    let samples = noise(PAGE.width * PAGE.height);
    let state = { cancelled: false, pulls: 0, reason: undefined as unknown };
    // Gives the first of the samples, then nothing more.
    let source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.pulls++ === 0) controller.enqueue(samples.subarray(0, 300_000));
      },
      cancel(reason) {
        state.cancelled = true;
        state.reason = reason;
      },
    }, { highWaterMark: 0 });
    let reader = pngFromSamples(source, PAGE, PAGE_GREY, ROOM * 2).getReader();
    // Reads what the first of the samples makes, up to a read that waits on the rest.
    let waiting: Promise<ReadableStreamReadResult<Uint8Array>>;
    for (;;) {
      waiting = reader.read();
      let pause = new Promise<"waited">(resolve => setTimeout(resolve, 20, "waited"));
      if (await Promise.race([waiting, pause]) === "waited") break;
    }
    expect(state.cancelled).toBe(false);
    let stopped = new Error("The text was cancelled.");
    await reader.cancel(stopped);
    expect(state.cancelled).toBe(true);
    expect(state.reason).toBe(stopped);
    expect((await waiting).done).toBe(true);
  });
});
