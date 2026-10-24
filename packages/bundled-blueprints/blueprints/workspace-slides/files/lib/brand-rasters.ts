// PowerPoint pictures for artwork the renderer can't draw natively. SVG
// blocks export as pictures: an SVG (crisp in PowerPoint 365 / 2019+ and
// Keynote) with a transparent PNG fallback.

import { crc32 } from "@gadgets/bundled-blueprints/libraries/zip/server";
import type { Deck, Slide } from "./protocol.ts";

/** The rasters every export shares, built once per isolate. */
export interface BrandRasters {
  blank: string;
}

/**
 * Everything `deckToSlidesPptx` needs that takes async work to build: the shared rasters, a dot
 * grid PNG per opacity the deck uses, and (from the exporter) the browser-drawn PNG stand-in for
 * each SVG source.
 */
export interface PptxAssets extends BrandRasters {
  dotGrids: Map<number, string>;
  svgRasters?: Map<string, string>;
}

async function encodePng(W: number, H: number, rgba: Uint8Array): Promise<string> {
  const stride = W * 4 + 1;
  const raw = new Uint8Array(stride * H);
  for (let y = 0; y < H; y++) raw.set(rgba.subarray(y * W * 4, (y + 1) * W * 4), y * stride + 1);
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const chunk = (type: string, data: Uint8Array) => {
    const b = new Uint8Array(12 + data.length);
    const v = new DataView(b.buffer);
    v.setUint32(0, data.length);
    for (let k = 0; k < 4; k++) b[4 + k] = type.charCodeAt(k);
    b.set(data, 8);
    v.setUint32(8 + data.length, crc32(b.subarray(4, 8 + data.length)));
    return b;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, W);
  hv.setUint32(4, H);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let at = 0;
  for (const p of parts) { png.set(p, at); at += p.length; }
  let s = "";
  for (let k = 0; k < png.length; k += 32768) s += String.fromCharCode(...png.subarray(k, k + 32768));
  return "data:image/png;base64," + btoa(s);
}
const hexRgb = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
async function buildBrandRasters(): Promise<BrandRasters> {
  return {
    // Fallback for SVGs no browser has rasterized yet (see saveSvgRaster):
    // viewers without SVG support show nothing there.
    blank: await encodePng(1, 1, new Uint8Array(4)),
  };
}
// The slide dot grid (client DotGrid): #fff7ef dots of radius 1.5px on a
// 38×36 grid offset by 30,18, drawn at `K`× over the whole slide.
async function dotGridPng(alpha: number, K: number): Promise<string> {
  const W = 1200 * K, H = 675 * K, r = 1.5 * K;
  const px = new Uint8Array(W * H * 4);
  const rgb = hexRgb("#FFF7EF");
  // Transparent pixels carry the dot colour too: a viewer that scales the
  // picture without premultiplying alpha (LibreOffice) would otherwise blend
  // each dot's edge toward black and draw dark rings.
  for (let o = 0; o < px.length; o += 4) { px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; }
  for (let cy = 0; cy <= 675 + 36; cy += 36) {
    for (let cx = 11 - 38; cx <= 1200 + 38; cx += 38) {
      const X = cx * K, Y = cy * K;
      for (let y = Math.max(0, Math.floor(Y - r)); y < Math.min(H, Math.ceil(Y + r)); y++) {
        for (let x = Math.max(0, Math.floor(X - r)); x < Math.min(W, Math.ceil(X + r)); x++) {
          let hit = 0;
          for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
            const dx = x + (sx + 0.5) / 4 - X, dy = y + (sy + 0.5) / 4 - Y;
            if (dx * dx + dy * dy <= r * r) hit++;
          }
          if (!hit) continue;
          const o = (y * W + x) * 4;
          px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2];
          px[o + 3] = Math.round(hit / 16 * alpha * 255);
        }
      }
    }
  }
  return encodePng(W, H, px);
}
// Drawn once per opacity and scale, then reused by every export.
const dotGrids = new Map<string, Promise<string>>();
function cachedDotGridPng(alpha: number, K: number): Promise<string> {
  const key = `${alpha}@${K}`;
  let png = dotGrids.get(key);
  if (!png) {
    png = dotGridPng(alpha, K).catch((e) => { dotGrids.delete(key); throw e; });
    dotGrids.set(key, png);
  }
  return png;
}
// A deck with many dot grid opacities gets them at 1×, so together they use
// under a quarter of the PowerPoint library's total image pixels, leaving the
// rest for the deck's own pictures.
const MAX_SHARP_DOT_GRIDS = 4;
// Everything deckToSlidesPptx needs that takes async work to build.
export async function pptxAssets(deck: Deck): Promise<PptxAssets> {
  const assets: PptxAssets = { ...await brandRasters(), dotGrids: new Map() };
  const opacities = new Set((deck.slides || []).map(dotGridOpacity).filter((a) => a > 0));
  const K = opacities.size > MAX_SHARP_DOT_GRIDS ? 1 : 2;
  for (const a of opacities) assets.dotGrids.set(a, await cachedDotGridPng(a, K));
  return assets;
}
// The dot grid's opacity, in steps of 0.05: each distinct opacity is a full-slide PNG to draw
// and embed, so a deck can't make the export draw more than 20.
export function dotGridOpacity(slide: Slide | null | undefined): number {
  const a = Number(slide?.background?.dotGrid);
  return Number.isFinite(a) && a > 0 ? Math.max(1, Math.round(Math.min(1, a) * 20)) / 20 : 0;
}
let brandRastersPromise: Promise<BrandRasters> | null = null;
function brandRasters(): Promise<BrandRasters> {
  if (!brandRastersPromise) brandRastersPromise = buildBrandRasters().catch((e) => { brandRastersPromise = null; throw e; });
  return brandRastersPromise;
}
