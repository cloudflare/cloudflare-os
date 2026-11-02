// The Slides deck as a PowerPoint file: the shared pptx library draws the
// blocks, and this adapts the house-style pieces it has no native block for
// (the orange cover, the dot grid, the brand bar, SVG artwork, logos).

import { deckToPptx } from "@gadgets/bundled-blueprints/libraries/pptx/server";
import { COVER_ORANGE_PNG } from "./branding.ts";
import { dotGridOpacity, type PptxAssets } from "./brand-rasters.ts";
import { highlightColorFor } from "./highlight.ts";
import { deckLogoBox, logoAlt, logoBlockBox, logoShowsOn } from "./logo.ts";
import type { Block, Deck, DeckLogo, Slide } from "./protocol.ts";

/**
 * A block handed to the pptx library, which validates every field itself: deck blocks, plus the
 * internal ones this adapter makes (`brandBar`, and images carrying `svgMarkup`).
 */
interface ExportBlock {
  id?: string;
  type?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  props: Record<string, unknown>;
}

// The content-slide brand bar (client BOTTOM_BAR_SVG): exported as a native gradient.
function isBrandBarSvg(raw: string): boolean {
  return /viewBox=["']0 0 1200 12["']/.test(raw) && raw.includes("#FF6633") && raw.includes("#F6821F") && raw.includes("#FBAD41");
}
function svgDataUrlMarkup(src: string): string | null {
  const comma = src.indexOf(",");
  if (comma < 0) return null;
  const head = src.slice(0, comma), body = src.slice(comma + 1);
  try {
    if (/;base64/i.test(head)) return new TextDecoder().decode(Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0)));
    // A bare % (as in width="100%") is taken as itself.
    return decodeURIComponent(body.replace(/%(?![0-9a-f]{2})/gi, "%25"));
  } catch {
    return null;
  }
}
// Deck blocks the PowerPoint renderer has no native equivalent for, turned
// into blocks it does draw. Returns undefined to keep the block as it is.
export function adaptBlockForPptx(block: unknown, assets: PptxAssets): ExportBlock[] | undefined {
  if (block === null || typeof block !== "object") return undefined;
  const b = block as Partial<Block>;
  const props: Record<string, unknown> = b.props !== null && typeof b.props === "object" ? b.props : {};
  const x = Number(b.x) || 0, y = Number(b.y) || 0;
  if (b.type === "svg") {
    const w = b.w ?? 600, h = b.h ?? 337.5;
    const raw = String(props.markup || "").trim();
    const out: ExportBlock[] = [];
    // An empty block shows the editor's "Paste SVG markup" slot, in HTML and PDF too.
    if (!raw) return [{ type: "image", x, y, w, h, props: { src: "", emptyText: "Paste SVG markup" } }];
    if (props.background) out.push({ type: "shape", x, y, w, h, props: { kind: "rect", fill: props.background, strokeWidth: 0, radius: 2 } });
    if (isBrandBarSvg(raw)) out.push({ type: "brandBar", x, y, w, h, props: {} });
    else out.push({ type: "image", x, y, w, h, props: { src: assets.svgRasters?.get(String(props.markup)) || assets.blank, svgMarkup: raw, fit: props.fit === "stretch" ? "fill" : "contain", radius: 0, alt: "" } });
    return out;
  }
  if (b.type === "image" && typeof props.src === "string" && props.src.slice(0, 18).toLowerCase() === "data:image/svg+xml") {
    const markup = svgDataUrlMarkup(props.src);
    if (markup) return [{ ...b, props: { ...props, src: assets.svgRasters?.get(props.src) || assets.blank, svgMarkup: markup } }];
  }
  // A logo with an image is that picture, fitted into its box; without one
  // the library draws the wordmark.
  if (b.type === "logo" && typeof props.src === "string" && props.src) {
    const box = logoBlockBox({ x, y, w: b.w, h: b.h, props });
    return logoPicture(box, props.src, props.alt, assets);
  }
  return undefined;
}
// A logo as a picture (SVG with its PNG fallback): fitted into `box` and
// pinned where the browser's object-position pins it, never decorative.
function logoPicture(box: ReturnType<typeof logoBlockBox>, src: string, alt: unknown, assets: PptxAssets): ExportBlock[] {
  const image: ExportBlock = {
    type: "image",
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    props: { src, fit: "contain", objectPosition: box.objectPosition, radius: 0, alt: logoAlt(alt) },
  };
  return adaptBlockForPptx(image, assets) ?? [image];
}
// The deck logo's picture on `slide`, if it shows there.
function deckLogoBlocks(logo: DeckLogo | null | undefined, slide: Slide, assets: PptxAssets): ExportBlock[] {
  return logoShowsOn(logo, slide) ? logoPicture(deckLogoBox(logo.position), logo.src, logo.alt, assets) : [];
}
// Titles with highlighted words carry the colour the browser gives them on
// this slide's background (lib/highlight.ts), for the library to use.
function withHighlightColors(slide: Slide): Slide {
  if (!slide.blocks.some((b) => b.type === "title" && b.props?.highlight)) return slide;
  return {
    ...slide,
    blocks: slide.blocks.map((b) => b.type === "title" && b.props?.highlight
      ? { ...b, props: { ...b.props, highlightColor: highlightColorFor(slide.background, String(b.props.color || "#2B0B05")) } }
      : b),
  };
}
// The deck's PowerPoint file. Cover slides get the orange artwork as a
// full-slide picture under the inset surface (when on) and the dot grid;
// every other slide's dot grid is a picture under its blocks. The deck logo
// goes on top of those, under the blocks, on every slide it shows on. These
// pictures are drawn with the slide's first block where it has one, so they
// don't count against the 1000 blocks a slide may have, only against the
// higher limit on blocks once adapted, which they add only a few to.
export function deckToSlidesPptx(deck: Deck, assets: PptxAssets): ReadableStream<Uint8Array> {
  const covers = new Map<unknown, { image: ExportBlock; first: Block | undefined; inset: boolean; dots: ExportBlock | null; logo: ExportBlock[] }>();
  const underFirst = new Map<unknown, ExportBlock[]>();
  const slides = deck.slides.map((source: Slide) => {
    const slide = withHighlightColors(source);
    const dotAlpha = dotGridOpacity(slide);
    const dots: ExportBlock | null = dotAlpha && assets.dotGrids.has(dotAlpha) ? {
      type: "image",
      x: 0,
      y: 0,
      w: 1200,
      h: 675,
      props: { src: assets.dotGrids.get(dotAlpha), fit: "fill", radius: 0, alt: "", decorative: true },
    } : null;
    const logo = deckLogoBlocks(deck.logo, slide, assets);
    if (!slide.background?.coverOrange) {
      const under = dots ? [dots, ...logo] : logo;
      if (!under.length) return slide;
      if (!slide.blocks.length) return { ...slide, blocks: under };
      underFirst.set(slide.blocks[0], under);
      return slide;
    }
    const image: ExportBlock = {
      id: "pptx-cover",
      type: "image",
      x: 0,
      y: 0,
      w: 1200,
      h: 675,
      props: { src: COVER_ORANGE_PNG, fit: "fill", radius: 0, alt: "", decorative: true },
    };
    covers.set(image, { image, first: slide.blocks[0], inset: slide.background.inset !== false, dots, logo });
    return {
      ...slide,
      background: { ...slide.background, coverOrange: false, inset: false },
      blocks: [image, ...slide.blocks.slice(1)],
    };
  });
  return deckToPptx({ ...deck, slides }, (block) => {
    const cover = covers.get(block);
    if (!cover) {
      const under = underFirst.get(block);
      return under ? [...under, ...adaptBlockForPptx(block, assets) ?? [block as ExportBlock]] : adaptBlockForPptx(block, assets);
    }
    const blocks: ExportBlock[] = [cover.image];
    if (cover.inset) blocks.push({
      type: "shape",
      x: 16,
      y: 16,
      w: 1168,
      h: 643,
      props: { kind: "rect", fill: "#fff9ef", stroke: "#f2e3d5", strokeWidth: 1, radius: 16 },
    });
    if (cover.dots) blocks.push(cover.dots);
    blocks.push(...cover.logo);
    if (cover.first) blocks.push(...adaptBlockForPptx(cover.first, assets) ?? [cover.first]);
    return blocks;
  });
}
