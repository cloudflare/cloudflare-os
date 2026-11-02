// Test-only images: real PNGs drawn pixel by pixel, and the smallest JPEG and GIF headers the size
// readers accept. Not imported by production code.

import { deflateSync } from "node:zlib";
import { crc32 } from "../../src/content/zip";

/** A PNG `width`×`height`, each pixel colored by `paint`. */
export function makePng(width: number, height: number, paint: (x: number, y: number) => readonly [number, number, number]): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      raw.set([r, g, b], y * (width * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array(4 + data.length);
    body.set(new TextEncoder().encode(type));
    body.set(data, 4);
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(body, 4);
    view.setUint32(8 + data.length, crc32(body));
    return out;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A bar chart, the kind of picture a deck carries: four bars rising, on white with a baseline. */
export function chartPng(width = 960, height = 540): Uint8Array {
  const bars = [0.35, 0.5, 0.62, 0.81];
  const colors: readonly (readonly [number, number, number])[] = [[47, 111, 222], [14, 147, 132], [224, 162, 27], [194, 65, 123]];
  return makePng(width, height, (x, y) => {
    const base = height * 0.88;
    if (Math.abs(y - base) < 2 && x > width * 0.08 && x < width * 0.92) return [120, 128, 140];
    const slot = Math.floor((x - width * 0.12) / (width * 0.2));
    const within = (x - width * 0.12) % (width * 0.2);
    if (slot >= 0 && slot < 4 && within < width * 0.13 && y < base && y > base - bars[slot]! * height * 0.8) return colors[slot]!;
    return [255, 255, 255];
  });
}

/** A photo-like gradient, wider than tall. */
export function photoPng(width = 800, height = 600): Uint8Array {
  return makePng(width, height, (x, y) => [Math.round(30 + 120 * (x / width)), Math.round(80 + 100 * (y / height)), Math.round(160 + 60 * (1 - x / width))]);
}

/** The start of a JPEG: SOI, a JFIF APP0 segment, then a baseline frame header declaring the size. */
export function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

export function gifHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0, 0, 0x3b]);
}
