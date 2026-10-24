// @vitest-environment node
import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { ExportHandler } from "../files/server.ts";
import type { Deck, GadgetStub, Slide } from "../files/lib/protocol.ts";

// The Slides PowerPoint export end to end: ExportHandler over a stand-in gadget, the package
// unzipped and its parts read. The pptx library's own tests cover the renderer block by block;
// these cover what this blueprint adds (cover art, dot grids, the brand bar, SVG artwork with its
// browser-drawn PNG fallback) and that every block type the editor makes lands in the slide.

const decoder = new TextDecoder();

// The archive's parts by name, from its central directory (the library's writer is tested
// byte for byte in libraries/pptx).
async function unzip(stream: ReadableStream<Uint8Array>): Promise<Map<string, Uint8Array>> {
  const zip = new Uint8Array(await new Response(stream).arrayBuffer());
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.byteLength - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const parts = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = zip.subarray(start, start + size);
    parts.set(name, method === 8
      ? new Uint8Array(await new Response(new Response(raw).body!.pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer())
      : raw);
    at += 46 + nameLength + extra + comment;
  }
  return parts;
}

const text = (parts: Map<string, Uint8Array>, name: string) => {
  const part = parts.get(name);
  expect(part, name).toBeDefined();
  return decoder.decode(part);
};

function shapes(xml: string): string[] {
  return [...xml.matchAll(/<p:(sp|pic|cxnSp)>[\s\S]*?<\/p:\1>/g)].map((m) => m[0]);
}
const nameOf = (shape: string) => /name="([^"]*)"/.exec(shape)![1];
const shapeNamed = (xml: string, name: string) => {
  const found = shapes(xml).find((s) => nameOf(s) === name);
  if (!found) throw new Error(`Shape not found: ${name} in ${shapes(xml).map(nameOf).join(", ")}`);
  return found;
};

// A stand-in for the gadget's RPC stub: the deck, inlined, and the PNGs browsers have saved.
function gadgetFor(deck: Deck, rasters: Record<string, string> = {}) {
  return {
    getDeckInlined: vi.fn(async () => deck),
    getSvgRasters: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter((k) => rasters[k]).map((k) => [k, rasters[k]!]))),
  } satisfies Pick<GadgetStub, "getDeckInlined" | "getSvgRasters">;
}
const handler = () => Object.create(ExportHandler.prototype) as ExportHandler;
async function exportDeck(deck: Deck, rasters?: Record<string, string>) {
  return unzip(await handler().export(gadgetFor(deck, rasters), "pptx"));
}
const slide = (blocks: Slide["blocks"], background: Slide["background"] = { color: "#FFFFFF", inset: false }): Slide =>
  ({ id: "s", background, blocks });

const PNG_1x1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const BRAND_BAR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 12" preserveAspectRatio="none"><defs><linearGradient id="g"><stop offset="0" stop-color="#FF6633"/><stop offset=".5" stop-color="#F6821F"/><stop offset="1" stop-color="#FBAD41"/></linearGradient></defs><rect width="1200" height="12" fill="url(#g)"/></svg>';
// A valid, transparent PNG of the given size; `mark` sets one pixel, so each is distinct.
function blankPng(w: number, h: number, mark = 0): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
  const crc = (bytes: Uint8Array) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(Buffer.from(type, "ascii"), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), hv = new DataView(ihdr.buffer);
  hv.setUint32(0, w); hv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  const pixels = new Uint8Array((w * 4 + 1) * h);
  pixels[1] = mark;
  const idat = deflateSync(pixels);
  return "data:image/png;base64," + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array())]).toString("base64");
}
const ART = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10" fill="#FF6633"/></svg>';
async function sha(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("Slides export formats", () => {
  it("offers PowerPoint on the server and HTML/PDF in the browser", async () => {
    expect((await handler().getExportFormats()).map((f) => [f.id, f.mode, f.fileExtension])).toEqual([
      ["pptx", "server", ".pptx"], ["html", "browser", ".html"], ["pdf", "browser", ".pdf"],
    ]);
  });

  it("rejects unknown formats without reading the gadget", async () => {
    const gadget = gadgetFor({ slides: [] });
    await expect(handler().export(gadget, "docx")).rejects.toThrow("Unsupported slides export format: docx");
    expect(gadget.getDeckInlined).not.toHaveBeenCalled();
  });
});

describe("Slides PowerPoint export", () => {
  it("draws every block type the editor makes as native objects", async () => {
    const parts = await exportDeck({ slides: [slide([
      { id: "1", type: "sectionLabel", x: 36, y: 35, props: { text: "Results" } },
      { id: "2", type: "title", x: 35, y: 76, w: 984, props: { text: "Latency fell 38%", highlight: "38%", fontSize: 28, weight: 600 } },
      { id: "3", type: "subtitle", x: 36, y: 140, props: { text: "Across regions" } },
      { id: "4", type: "text", x: 36, y: 204, w: 400, props: { text: "Body copy", align: "center" } },
      { id: "5", type: "bulletList", x: 36, y: 260, w: 500, props: { text: "One\nTwo" } },
      { id: "6", type: "card", x: 600, y: 200, w: 260, h: 160, props: { eyebrow: "01", title: "Card", body: "Body" } },
      { id: "7", type: "box", x: 900, y: 200, w: 220, h: 100, props: { title: "Box", dashed: true } },
      { id: "8", type: "tonePill", x: 600, y: 400, props: { text: "status", tone: "ruby" } },
      { id: "9", type: "divider", x: 36, y: 500, w: 1128, props: {} },
      { id: "10", type: "shape", x: 36, y: 520, w: 100, h: 60, props: { kind: "ellipse", fill: "#F6821F" } },
      { id: "11", type: "image", x: 200, y: 520, w: 80, h: 80, props: { src: PNG_1x1, radius: 12 } },
      { id: "12", type: "arrow", x: 0, y: 0, props: { x1: 300, y1: 600, x2: 500, y2: 600, label: "req" } },
      { id: "13", type: "logo", x: 964, y: 31, w: 200, props: { text: "Acme", variant: "dark", scale: 0.75, align: "right" } },
    ])] });
    const xml = text(parts, "ppt/slides/slide1.xml");
    const names = shapes(xml).map(nameOf);
    for (const [i, type] of ["sectionLabel", "title", "subtitle", "text", "bulletList", "card", "box", "tonePill", "divider", "shape", "image", "arrow", "logo"].entries()) {
      expect(names.some((n) => n.startsWith(`Block ${i + 1} ${type}`)), type).toBe(true);
    }
    expect(xml).not.toContain("?: ");
    expect(shapeNamed(xml, "Block 1 sectionLabel")).toContain(">RESULTS</a:t>");
    expect(shapeNamed(xml, "Block 2 title")).toContain(">38%</a:t>");
    expect(shapeNamed(xml, "Block 5 bulletList")).toContain('<a:buChar char="&#x2022;"/>');
    expect(shapeNamed(xml, "Block 7 box surface")).toContain("<a:custDash>");
    expect(shapeNamed(xml, "Block 10 shape")).toContain('prst="ellipse"');
    expect(shapeNamed(xml, "Block 11 image")).toContain("<p:blipFill>");
    expect(shapeNamed(xml, "Block 12 arrow head")).toContain('prst="triangle"');
    expect(shapeNamed(xml, "Block 13 logo")).toContain(">Acme</a:t>");
    expect(shapeNamed(xml, "Block 13 logo")).toContain('algn="r"');
  });

  it("layers the cover artwork, the inset surface and the dot grid under the cover's blocks", async () => {
    const parts = await exportDeck({ slides: [
      slide([{ id: "t", type: "title", x: 33, y: 245, w: 760, props: { text: "Cover", color: "#FFFFFF" } }],
        { color: "#F6821F", inset: true, coverOrange: true, dotGrid: 0.3 }),
    ] });
    const xml = text(parts, "ppt/slides/slide1.xml");
    expect(shapes(xml).map(nameOf)).toEqual(["Block 1 image", "Block 2 shape", "Block 3 image", "Block 4 title"]);
    const art = shapeNamed(xml, "Block 1 image");
    // Background art: marked decorative, so accessibility checkers don't ask for its alt text.
    expect(art).toContain('<adec:decorative xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/>');
    expect(art).not.toContain("descr=");
    expect(shapeNamed(xml, "Block 3 image")).toContain("<adec:decorative");
    // The cover's title is the slide's title (outline, slide list, screen readers).
    expect(shapeNamed(xml, "Block 4 title")).toContain('<p:nvPr><p:ph type="title"/></p:nvPr>');
    expect(art).toContain(`<a:off x="0" y="0"/><a:ext cx="${1200 * 10160}" cy="${675 * 10160}"/>`);
    // The cover's inset surface, inset by half its 1px border.
    expect(shapeNamed(xml, "Block 2 shape")).toContain('<a:srgbClr val="FFF9EF">');
    // The background itself is not repeated under the artwork as an inset surface.
    expect(xml).not.toContain('name="Inset surface"');
    expect([...parts.keys()].filter((n) => n.startsWith("ppt/media/"))).toHaveLength(2);
  });

  it("puts a content slide's dot grid under its blocks, once per opacity", async () => {
    const parts = await exportDeck({ slides: [
      slide([{ id: "t", type: "text", x: 0, y: 0, props: { text: "a" } }], { color: "#FFFFFF", dotGrid: 0.4 }),
      slide([], { color: "#FFFFFF", dotGrid: 0.4 }),
      slide([], { color: "#FFFFFF", dotGrid: 0 }),
    ] });
    expect(shapes(text(parts, "ppt/slides/slide1.xml")).map(nameOf)).toEqual(expect.arrayContaining(["Block 1 image", "Block 2 text"]));
    expect(text(parts, "ppt/slides/slide3.xml")).not.toContain("<p:pic>");
    // The two 0.4 grids share one PNG.
    expect([...parts.keys()].filter((n) => n.startsWith("ppt/media/"))).toHaveLength(1);
  });

  // Each distinct grid is a full-slide PNG, and together they must leave the export's pixel budget
  // for the deck's own pictures: past four opacities they are drawn at 1x.
  it("draws at most 20 dot grids, however many opacities the slides use, at 1x past four", async () => {
    const size = (png: Uint8Array) => { const v = new DataView(png.buffer, png.byteOffset); return [v.getUint32(16), v.getUint32(20)]; };
    const media = (parts: Map<string, Uint8Array>) => [...parts].filter(([n]) => n.startsWith("ppt/media/")).map(([, b]) => size(b));
    const many = await exportDeck({ slides: Array.from({ length: 40 }, (_, i) => slide([], { color: "#FFFFFF", dotGrid: (i + 1) / 40 })) });
    expect(media(many)).toEqual(Array.from({ length: 20 }, () => [1200, 675]));
    const few = await exportDeck({ slides: [0.2, 0.4].map((dotGrid) => slide([], { color: "#FFFFFF", dotGrid })) });
    expect(media(few)).toEqual([[2400, 1350], [2400, 1350]]);
  }, 30_000);

  it("exports a slide at the 1000-block limit with its dot grid and the deck logo", async () => {
    const blocks = Array.from({ length: 1000 }, (_, i) => ({ id: `b${i}`, type: "shape", x: i % 1000, y: 300, w: 4, h: 4, props: {} }));
    const parts = await exportDeck({ logo: { src: PNG_1x1, position: "top-right", onCover: true }, slides: [slide(blocks, { color: "#FFFFFF", inset: false, dotGrid: 0.4 })] });
    const names = shapes(text(parts, "ppt/slides/slide1.xml")).map(nameOf);
    expect(names.slice(0, 3)).toEqual(["Block 1 image", "Block 2 image", "Block 3 shape"]);
    expect(names).toHaveLength(1002);
  });

  it("exports the content-slide brand bar as a native gradient, not a picture", async () => {
    const parts = await exportDeck({ slides: [slide([
      { id: "bar", type: "svg", x: 0, y: 663, w: 1200, h: 12, props: { markup: BRAND_BAR, fit: "stretch" } },
    ])] });
    const xml = text(parts, "ppt/slides/slide1.xml");
    const bar = shapeNamed(xml, "Block 1 brandBar");
    expect(bar).toContain("<a:gradFill");
    expect(xml).not.toContain("<p:pic>");
  });

  // Each stand-in fits the library's per-image limit, but many together would pass its limit for
  // the whole deck and fail the export: past their share, an SVG keeps only the blank stand-in.
  it("gives SVG stand-ins a share of the export's pixels, past which they fall back to blank", async () => {
    // 27 distinct 1600 x 1600 rasters would be 69.1M pixels, past the library's 64Mi (67.1M).
    const arts = Array.from({ length: 27 }, (_, i) => ART.replace("#FF6633", `#FF66${String(i).padStart(2, "0")}`));
    const rasters = Object.fromEntries(await Promise.all(arts.map(async (a, i) => [await sha(a), blankPng(1600, 1600, i + 1)])));
    const deck: Deck = { slides: arts.map((markup, i) => ({ id: `s${i}`, background: { color: "#FFFFFF", inset: false }, blocks: [{ id: "a", type: "svg", x: 0, y: 0, w: 200, h: 100, props: { markup } }] })) };
    const parts = await exportDeck(deck, rasters);
    const sizes = [...parts].filter(([n]) => n.startsWith("ppt/media/") && n.endsWith(".png")).map(([, b]) => new DataView(b.buffer, b.byteOffset).getUint32(16));
    // Nine fit in the 24M share; the rest use the 1 x 1 blank.
    expect(sizes.filter((w) => w === 1600)).toHaveLength(9);
    expect(sizes).toContain(1);
  });

  // Browsers accept a bare % in a data URL, so a hand-written one has them (width="100%").
  it("embeds an SVG data URL with a bare % in it", async () => {
    const src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="100%" height="100%"/></svg>';
    const parts = await exportDeck({ slides: [slide([{ id: "a", type: "image", x: 0, y: 0, w: 100, h: 100, props: { src } }])] });
    expect(shapeNamed(text(parts, "ppt/slides/slide1.xml"), "Block 1 image")).toContain("<asvg:svgBlip");
  });

  it("embeds SVG artwork as an SVG picture over the PNG a browser saved for it", async () => {
    const raster = PNG_1x1;
    const svgUrl = "data:image/svg+xml;base64," + btoa(ART);
    const deck: Deck = { slides: [slide([
      { id: "a", type: "svg", x: 100, y: 100, w: 200, h: 100, props: { markup: ART, background: "#FFF4E6" } },
      { id: "b", type: "image", x: 400, y: 100, w: 200, h: 100, props: { src: svgUrl } },
    ])] };
    const parts = await exportDeck(deck, { [await sha(ART)]: raster });
    const xml = text(parts, "ppt/slides/slide1.xml");
    // The SVG block's background is a native rectangle under the picture.
    expect(shapeNamed(xml, "Block 1 shape")).toContain('<a:srgbClr val="FFF4E6">');
    for (const name of ["Block 2 image", "Block 3 image"]) expect(shapeNamed(xml, name)).toContain("<asvg:svgBlip");
    const media = [...parts.keys()].filter((n) => n.startsWith("ppt/media/"));
    const pngs = media.filter((n) => n.endsWith(".png")).map((n) => parts.get(n)!);
    const savedBytes = Uint8Array.from(atob(raster.split(",")[1]!), (c) => c.charCodeAt(0));
    // The saved raster is the first picture's fallback; the data-URL image has none yet, so it
    // falls back to a transparent pixel.
    expect(pngs.some((p) => p.length === savedBytes.length && p.every((b, i) => b === savedBytes[i]))).toBe(true);
    expect(pngs).toHaveLength(2);
    // Both carry the artwork itself, decoded from the data URL for the image.
    const svgs = media.filter((n) => n.endsWith(".svg"));
    expect(svgs).toHaveLength(2);
    for (const name of svgs) expect(text(parts, name)).toContain('<rect width="20" height="10" fill="#FF6633"/>');
  });

  it("shows an empty SVG block's \"Paste SVG markup\" slot, as the HTML and PDF exports do", async () => {
    const parts = await exportDeck({ slides: [slide([
      { id: "e", type: "svg", x: 36, y: 400, w: 300, h: 200, props: { markup: "", fit: "contain", background: "#FFF4E6" } },
    ])] });
    const xml = text(parts, "ppt/slides/slide1.xml");
    const slot = shapeNamed(xml, "Block 1 image");
    expect(slot).toContain(">PASTE SVG MARKUP</a:t>");
    expect(slot).toContain(`<a:off x="${36 * 10160}" y="${400 * 10160}"/><a:ext cx="${300 * 10160}" cy="${200 * 10160}"/>`);
    expect(slot).toContain("<a:custDash>");
    expect(xml).not.toContain("<p:pic>");
  });

  it("names no company or product brand in the package", async () => {
    const parts = await exportDeck({ slides: [slide([{ id: "t", type: "title", x: 0, y: 0, props: { text: "Hi" } }])] });
    expect(text(parts, "docProps/app.xml")).not.toContain("<Company>");
    for (const [name, bytes] of parts) {
      if (name.endsWith(".xml") || name.endsWith(".rels")) expect(decoder.decode(bytes), name).not.toMatch(/cloudflare/i);
    }
  });
});

// A shape's position and size in slide pixels; the pictures on a slide; a text shape's runs as [text, colour].
const off = (shape: string) => /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(shape)!.slice(1).map((v) => Number(v) / 10160);
const pictures = (xml: string) => shapes(xml).filter((s) => s.startsWith("<p:pic>"));
const runs = (xml: string) => [...xml.matchAll(/<a:r><a:rPr[^>]*>[\s\S]*?<a:srgbClr val="([0-9A-F]{6})">[\s\S]*?<a:t xml:space="preserve">([^<]*)<\/a:t>/g)].map((m) => [m[2], m[1]]);

describe("Slides PowerPoint logos", () => {
  const COVER = { color: "#F6821F", inset: false, coverOrange: true };
  // A 4 x 1 PNG: a wide logo, so its placement in the 140 x 40 box shows.
  const WIDE_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAAD0lEQVR4nGMUMgn7z4AEABX1AZ3v9LAyAAAAAElFTkSuQmCC";

  it("puts the deck logo on every slide as a picture, under the blocks, at its corner", async () => {
    const parts = await exportDeck({
      logo: { src: WIDE_PNG, position: "top-right", onCover: true },
      slides: [
        slide([{ id: "t", type: "title", x: 33, y: 245, w: 760, props: { text: "Cover", color: "#FFFFFF" } }], COVER),
        slide([{ id: "t", type: "text", x: 36, y: 204, props: { text: "Body" } }], { color: "#FFFFFF", inset: false, dotGrid: 0.4 }),
        slide([]),
      ],
    });
    // Cover: art, logo, title. Content: dot grid, logo, text. Empty: logo.
    expect(shapes(text(parts, "ppt/slides/slide1.xml")).map(nameOf)).toEqual(["Block 1 image", "Block 2 image", "Block 3 title"]);
    expect(shapes(text(parts, "ppt/slides/slide2.xml")).map(nameOf)).toEqual(["Block 1 image", "Block 2 image", "Block 3 text"]);
    expect(shapes(text(parts, "ppt/slides/slide3.xml")).map(nameOf)).toEqual(["Block 1 image"]);
    for (const [n, index] of [[1, 2], [2, 2], [3, 1]]) {
      const logo = shapeNamed(text(parts, `ppt/slides/slide${n}.xml`), `Block ${index} image`);
      // A meaningful picture: alt text "Logo", not marked decorative.
      expect(logo).toContain('descr="Logo"');
      expect(logo).not.toContain("adec:decorative");
      // 4:1 fitted into the 140 x 40 box at x 1024, y 28, pinned top right: 140 x 35.
      expect(off(logo)).toEqual([1024, 28, 140, 35]);
      expect(text(parts, `ppt/slides/_rels/slide${n}.xml.rels`)).toMatch(/Target="\.\.\/media\/image\d+\.png"/);
    }
    // One media part for the logo, however many slides show it (plus the cover art and grid).
    expect([...parts.keys()].filter((n) => n.startsWith("ppt/media/"))).toHaveLength(3);
  });

  it("leaves the logo off cover slides when asked, and uses the given alt text and corner", async () => {
    const parts = await exportDeck({
      logo: { src: WIDE_PNG, position: "bottom-left", onCover: false, alt: "Acme & Co" },
      slides: [slide([], COVER), slide([])],
    });
    expect(text(parts, "ppt/slides/slide1.xml")).not.toContain('descr="Acme &amp; Co"');
    const logo = pictures(text(parts, "ppt/slides/slide2.xml"))[0]!;
    expect(logo).toContain('descr="Acme &amp; Co"');
    // Bottom left: pinned to the box's bottom (y 607 + 40 - 35).
    expect(off(logo)).toEqual([36, 612, 140, 35]);
  });

  it("embeds an SVG logo as an SVG picture over its browser-drawn PNG", async () => {
    const svg = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><rect width="80" height="40" fill="#123456"/></svg>');
    const parts = await exportDeck({ logo: { src: svg, position: "top-left", onCover: true }, slides: [slide([])] }, { [await sha(svg)]: PNG_1x1 });
    const logo = pictures(text(parts, "ppt/slides/slide1.xml"))[0]!;
    expect(logo).toContain("<asvg:svgBlip");
    expect(logo).toContain('descr="Logo"');
    // 2:1 in the 140 x 40 box: 80 x 40, pinned left.
    expect(off(logo)).toEqual([36, 28, 80, 40]);
    const media = [...parts.keys()].filter((n) => n.startsWith("ppt/media/"));
    expect(media.filter((n) => n.endsWith(".svg"))).toHaveLength(1);
    expect(media.filter((n) => n.endsWith(".png"))).toHaveLength(1);
  });

  it("draws a logo block with an image as that picture, and without one as the plain wordmark", async () => {
    const parts = await exportDeck({ slides: [slide([
      { id: "a", type: "logo", x: 900, y: 30, w: 200, h: 40, props: { src: WIDE_PNG, align: "right", alt: "Acme" } },
      { id: "b", type: "logo", x: 36, y: 30, props: { src: WIDE_PNG, scale: 0.5 } },
      // An older deck's wordmark with its accent stop: the stop is gone.
      { id: "c", type: "logo", x: 36, y: 600, props: { text: "Acme", variant: "dark", accentDot: true } },
      // An empty slot draws nothing.
      { id: "d", type: "logo", x: 36, y: 300, w: 140, h: 40, props: { src: "", text: "" } },
    ])] });
    const xml = text(parts, "ppt/slides/slide1.xml");
    const [a, b] = pictures(xml);
    expect(a).toContain('descr="Acme"');
    // 4:1 in 200 x 40 is 160 x 40, pinned right.
    expect(off(a!)).toEqual([940, 30, 160, 40]);
    // No size: the deck logo's 140 x 40 times the scale, pinned left and centred.
    expect(b).toContain('descr="Logo"');
    expect(off(b!)).toEqual([36, 31.25, 70, 17.5]);
    const wordmark = shapeNamed(xml, "Block 3 logo");
    expect(wordmark).toContain(">Acme</a:t>");
    expect(wordmark).not.toContain(">.</a:t>");
    expect(wordmark).not.toContain("F6821F");
    expect(shapes(xml)).toHaveLength(3);
  });

  it("colours a cover title's highlight black, where the accent would vanish, and keeps the accent on white", async () => {
    const parts = await exportDeck({ slides: [
      slide([{ id: "t", type: "title", x: 33, y: 245, w: 760, props: { text: "LeBron is the GOAT", highlight: "LeBron", color: "#FFFFFF" } }], COVER),
      slide([{ id: "t", type: "title", x: 35, y: 76, w: 984, props: { text: "Latency fell 38%", highlight: "38%", color: "#000000" } }]),
    ] });
    expect(runs(shapeNamed(text(parts, "ppt/slides/slide1.xml"), "Block 2 title"))).toEqual([["LeBron", "000000"], [" is the GOAT", "FFFFFF"]]);
    expect(runs(shapeNamed(text(parts, "ppt/slides/slide2.xml"), "Block 1 title"))).toEqual([["Latency fell ", "000000"], ["38%", "FF5F2E"]]);
  });
});
