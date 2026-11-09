import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { PngLayout } from "../src/pdf-images";
import { ImageDataError, pngFromDeflated } from "../src/pdf-png";
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
