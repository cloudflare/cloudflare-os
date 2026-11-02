import { describe, expect, it, vi } from "vitest";
import { deckToPptx, LOGO_DEFAULT_TEXT } from "@gadgets/bundled-blueprints/libraries/pptx/server";
import { crc32 } from "@gadgets/bundled-blueprints/libraries/zip/server";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function commaSeparatedTerms(prefix: string, count: number): string {
  return Array.from({length: count}, (_, index) => `${prefix}${index}`).join(",");
}

type ZipEntry = {
  bytes: Uint8Array;
  compressedSize: number;
  crc: number;
  flags: number;
  localOffset: number;
  method: number;
  uncompressedSize: number;
};

type ParsedZip = {
  archive: Uint8Array;
  entries: Map<string, ZipEntry>;
  names: string[];
};

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function uint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new Response(bytes).body!.pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(input).arrayBuffer());
}

async function readZip(stream: ReadableStream<Uint8Array>): Promise<ParsedZip> {
  const archive = await streamBytes(stream);
  expect(archive.byteLength).toBeGreaterThanOrEqual(22);

  // The writer does not emit a ZIP comment, so the EOCD must be the exact archive suffix.
  const eocdOffset = archive.byteLength - 22;
  expect(uint32(archive, eocdOffset)).toBe(0x06054b50);
  expect(uint16(archive, eocdOffset + 4)).toBe(0);
  expect(uint16(archive, eocdOffset + 6)).toBe(0);
  const entryCount = uint16(archive, eocdOffset + 10);
  expect(uint16(archive, eocdOffset + 8)).toBe(entryCount);
  const centralSize = uint32(archive, eocdOffset + 12);
  const centralOffset = uint32(archive, eocdOffset + 16);
  expect(uint16(archive, eocdOffset + 20)).toBe(0);
  expect(centralOffset + centralSize).toBe(eocdOffset);

  const metadata: Array<Omit<ZipEntry, "bytes"> & {name: string}> = [];
  const seenNames = new Set<string>();
  let centralCursor = centralOffset;
  for (let index = 0; index < entryCount; ++index) {
    expect(uint32(archive, centralCursor)).toBe(0x02014b50);
    expect(uint16(archive, centralCursor + 4)).toBe(20);
    expect(uint16(archive, centralCursor + 6)).toBe(20);
    const flags = uint16(archive, centralCursor + 8);
    const method = uint16(archive, centralCursor + 10);
    expect(flags).toBe(0x0808);
    expect(method).toBe(8);
    expect(uint16(archive, centralCursor + 12)).toBe(0);
    expect(uint16(archive, centralCursor + 14)).toBe(33);
    const crc = uint32(archive, centralCursor + 16);
    const compressedSize = uint32(archive, centralCursor + 20);
    const uncompressedSize = uint32(archive, centralCursor + 24);
    const nameLength = uint16(archive, centralCursor + 28);
    const extraLength = uint16(archive, centralCursor + 30);
    const commentLength = uint16(archive, centralCursor + 32);
    expect(extraLength).toBe(0);
    expect(commentLength).toBe(0);
    expect(uint16(archive, centralCursor + 34)).toBe(0);
    expect(uint16(archive, centralCursor + 36)).toBe(0);
    expect(uint32(archive, centralCursor + 38)).toBe(0);
    const localOffset = uint32(archive, centralCursor + 42);
    const name = decoder.decode(archive.subarray(
      centralCursor + 46,
      centralCursor + 46 + nameLength,
    ));
    expect(name.length).toBeGreaterThan(0);
    expect(seenNames.has(name), `duplicate ZIP entry ${name}`).toBe(false);
    seenNames.add(name);
    metadata.push({name, compressedSize, crc, flags, localOffset, method, uncompressedSize});
    centralCursor += 46 + nameLength;
  }
  expect(centralCursor).toBe(eocdOffset);
  expect(centralCursor - centralOffset).toBe(centralSize);

  const entries = new Map<string, ZipEntry>();
  let localCursor = 0;
  for (let index = 0; index < metadata.length; ++index) {
    const entry = metadata[index];
    expect(entry.localOffset).toBe(localCursor);
    expect(uint32(archive, localCursor)).toBe(0x04034b50);
    expect(uint16(archive, localCursor + 4)).toBe(20);
    expect(uint16(archive, localCursor + 6)).toBe(entry.flags);
    expect(uint16(archive, localCursor + 8)).toBe(entry.method);
    expect(uint16(archive, localCursor + 10)).toBe(0);
    expect(uint16(archive, localCursor + 12)).toBe(33);
    expect(uint32(archive, localCursor + 14)).toBe(0);
    expect(uint32(archive, localCursor + 18)).toBe(0);
    expect(uint32(archive, localCursor + 22)).toBe(0);
    const localNameLength = uint16(archive, localCursor + 26);
    const localExtraLength = uint16(archive, localCursor + 28);
    expect(localExtraLength).toBe(0);
    const localName = decoder.decode(archive.subarray(
      localCursor + 30,
      localCursor + 30 + localNameLength,
    ));
    expect(localName).toBe(entry.name);

    const dataOffset = localCursor + 30 + localNameLength;
    const descriptorOffset = dataOffset + entry.compressedSize;
    expect(uint32(archive, descriptorOffset)).toBe(0x08074b50);
    expect(uint32(archive, descriptorOffset + 4)).toBe(entry.crc);
    expect(uint32(archive, descriptorOffset + 8)).toBe(entry.compressedSize);
    expect(uint32(archive, descriptorOffset + 12)).toBe(entry.uncompressedSize);
    localCursor = descriptorOffset + 16;
    expect(localCursor).toBe(index + 1 < metadata.length
      ? metadata[index + 1].localOffset
      : centralOffset);

    const bytes = await inflate(archive.subarray(dataOffset, descriptorOffset));
    expect(bytes.byteLength).toBe(entry.uncompressedSize);
    expect(crc32(bytes)).toBe(entry.crc);
    entries.set(entry.name, {...entry, bytes});
  }
  expect(localCursor).toBe(centralOffset);
  return {archive, entries, names: metadata.map(entry => entry.name)};
}

function partText(zip: ParsedZip, name: string): string {
  const entry = zip.entries.get(name);
  expect(entry, name).toBeDefined();
  return decoder.decode(entry!.bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function bigEndian32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function zlibStored(bytes: Uint8Array): Uint8Array {
  expect(bytes.byteLength).toBeLessThanOrEqual(0xffff);
  const length = bytes.byteLength;
  return concat(
    new Uint8Array([0x78, 0x01, 0x01, length & 0xff, length >>> 8, ~length & 0xff, ~length >>> 8 & 0xff]),
    bytes,
    bigEndian32(adler32(bytes)),
  );
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = encoder.encode(type);
  return concat(bigEndian32(data.byteLength), typeBytes, data, bigEndian32(crc32(concat(typeBytes, data))));
}

function pngFixture(width: number, height: number, completeRaster = true): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, standard compression/filtering, no interlace.
  const raster = completeRaster
    ? new Uint8Array(height * (1 + width * 4))
    : new Uint8Array([0, 0, 0, 0, 0]);
  return concat(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlibStored(raster)),
    pngChunk("IEND", new Uint8Array()),
  );
}

function jpegFixture(width: number, height: number): Uint8Array {
  const app0 = new Uint8Array([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const frame = new Uint8Array([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    height >>> 8, height & 0xff, width >>> 8, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
  const scan = new Uint8Array([
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
    0x00,
  ]);
  return concat(new Uint8Array([0xff, 0xd8]), app0, frame, scan, new Uint8Array([0xff, 0xd9]));
}

function jpegWithoutScan(width: number, height: number): Uint8Array {
  const complete = jpegFixture(width, height);
  return concat(complete.subarray(0, complete.byteLength - 17), new Uint8Array([0xff, 0xd9]));
}

function base64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const a = bytes[offset];
    const hasB = offset + 1 < bytes.byteLength;
    const hasC = offset + 2 < bytes.byteLength;
    const b = hasB ? bytes[offset + 1] : 0;
    const c = hasC ? bytes[offset + 2] : 0;
    result += alphabet[a >>> 2] + alphabet[(a & 3) << 4 | b >>> 4] +
      (hasB ? alphabet[(b & 15) << 2 | c >>> 6] : "=") +
      (hasC ? alphabet[c & 63] : "=");
  }
  return result;
}

function dataUrl(type: "png" | "jpeg", bytes: Uint8Array): string {
  return `data:image/${type};base64,${base64(bytes)}`;
}

function block(type: string, props: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {type, x: 0, y: 0, props, ...extra};
}

function oneSlide(blocks: unknown[] = [], background: Record<string, unknown> = {inset: false}) {
  return {slides: [{id: "slide", background, blocks}]};
}

function shapeByName(xml: string, name: string): string {
  for (const match of xml.matchAll(/<p:(sp|pic|cxnSp)>[\s\S]*?<\/p:\1>/g)) {
    if (match[0].includes(`name="${name}"`)) return match[0];
  }
  throw new Error(`Shape not found: ${name}`);
}

function occurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

function xmlAttributes(source: string): Record<string, string> {
  return Object.fromEntries([...source.matchAll(/([\w:]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
}

function shapeVerticalBounds(shape: string) {
  const offset = xmlAttributes(/<a:off ([^>]*)\/>/.exec(shape)![1]);
  const extent = xmlAttributes(/<a:ext ([^>]*)\/>/.exec(shape)![1]);
  return {y: Number(offset.y), height: Number(extent.cy)};
}

function relationshipSource(name: string): string {
  if (name === "_rels/.rels") return "";
  const marker = "/_rels/";
  const markerOffset = name.indexOf(marker);
  expect(markerOffset).toBeGreaterThan(0);
  return `${name.slice(0, markerOffset)}/${name.slice(markerOffset + marker.length, -".rels".length)}`;
}

function resolveRelationship(source: string, target: string): string {
  const slash = source.lastIndexOf("/");
  const parts = slash < 0 ? [] : source.slice(0, slash).split("/");
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

describe("PPTX package", () => {
  it("emits a complete OOXML package and internal relationship graph", async () => {
    const png = pngFixture(4, 2);
    const jpeg = jpegFixture(2, 4);
    const deck = {
      slides: [
        {id: "first", background: {inset: false}, blocks: [
          block("title", {text: "First"}),
          block("image", {src: dataUrl("png", png), alt: "PNG"}),
        ]},
        {id: "second", background: {inset: false}, blocks: [
          block("title", {text: "Second"}),
          block("image", {src: dataUrl("jpeg", jpeg), alt: "JPEG"}),
        ]},
      ],
    };
    const zip = await readZip(deckToPptx(deck));

    expect(zip.names).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "docProps/app.xml",
      "ppt/presentation.xml",
      "ppt/_rels/presentation.xml.rels",
      "ppt/presProps.xml",
      "ppt/viewProps.xml",
      "ppt/tableStyles.xml",
      "ppt/slideMasters/slideMaster1.xml",
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      "ppt/slideLayouts/slideLayout1.xml",
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      "ppt/theme/theme1.xml",
      "ppt/slides/slide1.xml",
      "ppt/slides/_rels/slide1.xml.rels",
      "ppt/slides/slide2.xml",
      "ppt/slides/_rels/slide2.xml.rels",
      "ppt/media/image1.png",
      "ppt/media/image2.jpeg",
    ]);

    const contentTypes = partText(zip, "[Content_Types].xml");
    const defaults = Object.fromEntries([...contentTypes.matchAll(/<Default\b([^>]*)\/>/g)]
      .map(match => {
        const attributes = xmlAttributes(match[1]);
        return [attributes.Extension, attributes.ContentType];
      }));
    expect(defaults).toEqual({
      rels: "application/vnd.openxmlformats-package.relationships+xml",
      xml: "application/xml",
      png: "image/png",
      jpeg: "image/jpeg",
    });
    const overrides = Object.fromEntries([...contentTypes.matchAll(/<Override\b([^>]*)\/>/g)]
      .map(match => {
        const attributes = xmlAttributes(match[1]);
        return [attributes.PartName, attributes.ContentType];
      }));
    expect(overrides).toEqual({
      "/docProps/core.xml": "application/vnd.openxmlformats-package.core-properties+xml",
      "/docProps/app.xml": "application/vnd.openxmlformats-officedocument.extended-properties+xml",
      "/ppt/presentation.xml": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
      "/ppt/presProps.xml": "application/vnd.openxmlformats-officedocument.presentationml.presProps+xml",
      "/ppt/viewProps.xml": "application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml",
      "/ppt/tableStyles.xml": "application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml",
      "/ppt/slideMasters/slideMaster1.xml": "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
      "/ppt/slideLayouts/slideLayout1.xml": "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
      "/ppt/theme/theme1.xml": "application/vnd.openxmlformats-officedocument.theme+xml",
      "/ppt/slides/slide1.xml": "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
      "/ppt/slides/slide2.xml": "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
    });
    for (const name of zip.names) {
      if (name === "[Content_Types].xml") continue;
      const extension = name.slice(name.lastIndexOf(".") + 1);
      expect(overrides[`/${name}`] || defaults[extension], `content type for ${name}`).toBeDefined();
    }

    const graph = new Map<string, string[]>();
    for (const relationshipsName of zip.names.filter(name => name.endsWith(".rels"))) {
      const source = relationshipSource(relationshipsName);
      if (source) expect(zip.entries.has(source), `relationship owner ${source}`).toBe(true);
      const ids = new Set<string>();
      const targets: string[] = [];
      for (const match of partText(zip, relationshipsName).matchAll(/<Relationship\b([^>]*)\/>/g)) {
        const attributes = xmlAttributes(match[1]);
        expect(ids.has(attributes.Id), `duplicate relationship ${attributes.Id} in ${relationshipsName}`).toBe(false);
        ids.add(attributes.Id);
        expect(attributes.TargetMode).toBeUndefined();
        expect(attributes.Target).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
        const target = resolveRelationship(source, attributes.Target);
        expect(zip.entries.has(target), `${relationshipsName} -> ${target}`).toBe(true);
        targets.push(target);
      }
      if (source) {
        for (const reference of partText(zip, source).matchAll(/\br:(?:id|embed|link)="([^"]+)"/g)) {
          expect(ids.has(reference[1]), `${source} references ${reference[1]}`).toBe(true);
        }
      }
      graph.set(source, targets);
    }

    const reached = new Set<string>();
    const queue = [""];
    while (queue.length) {
      for (const target of graph.get(queue.shift()!) || []) {
        if (reached.has(target)) continue;
        reached.add(target);
        queue.push(target);
      }
    }
    for (const name of zip.names.filter(entryName => entryName !== "[Content_Types].xml" && !entryName.endsWith(".rels"))) {
      expect(reached.has(name), `relationship graph reaches ${name}`).toBe(true);
    }

    const presentation = partText(zip, "ppt/presentation.xml");
    expect(presentation).toContain('<p:sldId id="256" r:id="rId5"/><p:sldId id="257" r:id="rId6"/>');
    expect(presentation).toContain('<p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>');
    const presentationRels = partText(zip, "ppt/_rels/presentation.xml.rels");
    expect(presentationRels).toContain('Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"');
    expect(presentationRels).toContain('Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"');
    // A usable grid: PowerPoint's default 1/12 inch, not an 85-inch spacing that makes snapping useless.
    expect(partText(zip, "ppt/viewProps.xml")).toContain('<p:gridSpacing cx="76200" cy="76200"/>');
  });
});

// A text box's top in EMU. CSS splits a line's leading around its glyphs (Arial ascent + descent =
// 1.117em); PowerPoint (measured in PowerPoint for the web) sets a single line's half-leading plus
// 0.2em per 1em of extra line-height above the first line, so top-anchored boxes are raised by that.
const textTop = (y: number, fontSize: number, lineHeight: number) =>
  Math.round((y - ((1 - 1.117) / 2 + 0.2 * (lineHeight - 1)) * fontSize) * 10160);

describe("PPTX rendering", () => {
  it("converts CSS pixels, assigns sequential IDs, and preserves expanded-block z-order", async () => {
    const deck = oneSlide([
      block("shape", {fill: "#123456"}, {x: 1.25, y: 2.5, w: 3, h: 4}),
      block("title", {text: "Sized", fontSize: 20, letterSpacing: "2px", lineHeight: 1.25}, {x: 5, y: 6, w: 100, h: 30}),
      block("card", {eyebrow: "top", title: "Card", body: "Body"}, {x: 10, y: 20, w: 200, h: 160}),
      block("shape", {fill: "#654321"}, {x: 30, y: 40, w: 50, h: 60}),
    ]);
    const zip = await readZip(deckToPptx(deck));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    expect(shapeByName(xml, "Block 1 shape")).toContain(
      '<a:off x="12700" y="25400"/><a:ext cx="30480" cy="40640"/>',
    );
    const title = shapeByName(xml, "Block 2 title");
    expect(title).toContain(`<a:off x="50800" y="${textTop(6, 20, 1.25)}"/><a:ext cx="1016000" cy="304800"/>`);
    expect(title).toContain('sz="1600"');
    expect(title).toContain('spc="160"');
    expect(title).toContain('<a:latin typeface="Arial"/>');
    expect(title).not.toContain('typeface="Inter"');
    expect(title).toContain('<a:spcPct val="104167"/>'); // line-height 1.25 over single spacing's 1.2em.

    const shapes = [...xml.matchAll(/<p:cNvPr id="(\d+)" name="([^"]*)"/g)]
      .map(match => ({id: Number(match[1]), name: match[2]}));
    expect(shapes).toEqual([
      {id: 1, name: ""},
      {id: 2, name: "Block 1 shape"},
      {id: 3, name: "Block 2 title"},
      {id: 4, name: "Block 3 card surface"},
      {id: 5, name: "Block 3 card eyebrow"},
      {id: 6, name: "Block 3 card title"},
      {id: 7, name: "Block 3 card body"},
      {id: 8, name: "Block 4 shape"},
    ]);
    expect(new Set(shapes.map(shape => shape.id)).size).toBe(shapes.length);
  });

  it("keeps intrinsic labels on one line without changing authored positions", async () => {
    const zip = await readZip(deckToPptx(oneSlide([
      block("sectionLabel", {text: "A LONG SECTION LABEL"}, {x: 36, y: 35}),
      block("text", {text: "x ".repeat(60), fontSize: 19, lineHeight: 1.6}, {x: 36, y: 204, w: 760}),
      block("text", {text: "Next block", fontSize: 19, lineHeight: 1.6}, {x: 36, y: 252, w: 760}),
      block("tonePill", {text: "A LONG PILL LABEL"}, {x: 500, y: 35}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    const label = shapeByName(xml, "Block 1 sectionLabel");
    expect(label).toContain('<a:bodyPr wrap="none"');
    // Sized from Arial's advance widths, since Google Slides ignores wrap="none" and breaks anything
    // wider than its box onto a second line: 20 tracked 10px semibold glyphs need about 121px.
    expect(Number(/<a:ext cx="(\d+)"/.exec(label)![1])).toBeGreaterThanOrEqual(Math.round(115 * 10160));
    expect(shapeByName(xml, "Block 2 text")).toContain('<a:bodyPr wrap="square"');
    expect(shapeByName(xml, "Block 2 text")).toContain(`<a:off x="365760" y="${textTop(204, 19, 1.6)}"/>`);
    expect(shapeByName(xml, "Block 3 text")).toContain(`<a:off x="365760" y="${textTop(252, 19, 1.6)}"/>`);
    expect(shapeByName(xml, "Block 4 tonePill")).toContain('<a:bodyPr wrap="none"');
  });

  it("renders every supported block type and its typography, fills, strokes, dashes, and radius", async () => {
    const blocks = [
      block("sectionLabel", {text: "section"}),
      block("text", {text: "Tracked", fontSize: 20, letterSpacing: "2px"}),
      block("text", {text: "Plain"}),
      block("title", {
        text: "HOT & cold HOT", highlight: "HOT", fontSize: 20,
        weight: 700, color: "#112233", letterSpacing: "2px", lineHeight: 1.25,
      }),
      block("subtitle", {text: "Subtitle", fontSize: 18}),
      block("text", {text: "Aligned", fontSize: 16, align: "right", lineHeight: 2}),
      block("bulletList", {text: "one\ntwo\nthree\nfour\nfive\nsix\nseven", treatment: "compact"}),
      block("card", {eyebrow: "eye", title: "Card", body: "Body"}),
      block("box", {title: "Box", body: "Body", dashed: true}),
      block("tonePill", {tone: "ruby", text: "status"}),
      block("divider", {color: "#112233", opacity: 0.25}, {w: 100, h: 2}),
      block("shape", {
        kind: "ellipse", fill: "#12345680", stroke: "#abcdef", strokeWidth: 2, opacity: 0.5,
      }, {w: 100, h: 50}),
      block("shape", {kind: "rect", fill: "#ffffff", radius: 10}, {w: 100, h: 50}),
      block("image", {alt: "missing"}),
      block("svg", {markup: "<svg><path/></svg>", background: "#fff4e6"}),
      block("arrow", {x1: 10, y1: 20, x2: 100, y2: 50, color: "ruby", label: "go", dashed: true, width: 3}),
    ];
    const zip = await readZip(deckToPptx(oneSlide(blocks)));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    for (const name of [
      "Block 1 sectionLabel", "Block 2 text", "Block 3 text",
      "Block 4 title", "Block 5 subtitle", "Block 6 text", "Block 7 bulletList",
      "Block 8 card surface", "Block 9 box surface", "Block 10 tonePill",
      "Block 11 divider", "Block 12 shape", "Block 13 shape", "Block 14 image",
      "Block 16 arrow",
    ]) expect(xml, name).toContain(`name="${name}"`);
    expect(xml).not.toContain('name="Block 15 svg"');

    expect(shapeByName(xml, "Block 1 sectionLabel")).toContain(">SECTION</a:t>");
    expect(shapeByName(xml, "Block 2 text")).toContain('sz="1600" b="0" spc="160"');
    const title = shapeByName(xml, "Block 4 title");
    expect(occurrences(title, '<a:srgbClr val="FF5F2E">')).toBe(2);
    expect(title).toContain("HOT");
    expect(title).toContain("&amp; cold");
    expect(title).toContain('sz="1600" b="1" spc="160"');
    expect(title).toContain('<a:spcPct val="104167"/>');
    const aligned = shapeByName(xml, "Block 6 text");
    expect(aligned).toContain('<a:pPr algn="r"');
    expect(aligned).toContain('<a:spcPct val="166667"/>');
    expect(aligned).toContain('sz="1280"');

    const bullets = shapeByName(xml, "Block 7 bulletList");
    for (const item of ["one", "two", "three", "four", "five", "six"]) {
      expect(bullets).toContain(`>${item}</a:t>`);
    }
    expect(bullets).not.toContain(">seven</a:t>");
    expect(occurrences(bullets, '<a:buChar char="&#x2022;"/>')).toBe(6);
    // The browser's dash is a fixed 6px; PowerPoint's preset scales with the stroke, so 6px is
    // expressed relative to the 1px border (600%) and to the 3px arrow (200%).
    expect(shapeByName(xml, "Block 9 box surface")).toContain('<a:custDash><a:ds d="600000" sp="600000"/></a:custDash>');
    // The pill is an intrinsic inline-block; the wrapper's w/h do not size it. Its height is the
    // 5px vertical padding around one 11px line at the 1.4 line-height the page sets on <body>.
    expect(shapeByName(xml, "Block 10 tonePill")).toContain(`cy="${Math.round((10 + 11 * 1.4) * 10160)}"`);
    expect(shapeByName(xml, "Block 10 tonePill")).toContain(">STATUS</a:t>");
    expect(shapeByName(xml, "Block 11 divider")).toContain('<a:alpha val="25000"/>');

    const ellipse = shapeByName(xml, "Block 12 shape");
    expect(ellipse).toContain('<a:prstGeom prst="ellipse">');
    expect(ellipse).toContain('<a:srgbClr val="123456"><a:alpha val="25098"/>');
    expect(ellipse).toContain('<a:ln w="20320" cap="rnd"><a:solidFill><a:srgbClr val="ABCDEF"><a:alpha val="50000"/>');
    expect(shapeByName(xml, "Block 13 shape")).toContain('<a:gd name="adj" fmla="val 20000"/>');
    const arrow = shapeByName(xml, "Block 16 arrow");
    expect(arrow).toContain('<a:custDash><a:ds d="200000" sp="200000"/></a:custDash>');
    // The browser's marker is a 9w x 6w triangle (w = stroke width), larger than any PowerPoint line
    // end, so the head is a native triangle shape and the line stops at its base.
    expect(arrow).not.toContain("<a:tailEnd");
    const head = shapeByName(xml, "Block 16 arrow head");
    expect(head).toContain('<a:prstGeom prst="triangle">');
    expect(head).toContain(`<a:ext cx="${6 * 3 * 10160}" cy="${9 * 3 * 10160}"/>`);
  });

  it("highlights terms in order across line breaks, as the browser's sequential wrapping does", async () => {
    const runs = async (text: string, highlight: string) => {
      const zip = await readZip(deckToPptx(oneSlide([block("title", {text, highlight})])));
      const title = shapeByName(partText(zip, "ppt/slides/slide1.xml"), "Block 1 title");
      return [...title.matchAll(/<a:br>[\s\S]*?<\/a:br>|<a:r>([\s\S]*?)<\/a:r>/g)].map(match => {
        if (match[0].startsWith("<a:br>")) return "<br>";
        const run = /<a:t xml:space="preserve">([\s\S]*?)<\/a:t>/.exec(match[1])![1];
        return (match[1].includes('<a:srgbClr val="FF5F2E">') ? "*" : "") + run;
      });
    };
    // A match inside an earlier highlight changes nothing; one across its edge ("ar & b") is
    // impossible once the browser has wrapped "bar" in a span.
    expect(await runs("foo\nbar & baz", "foo\nbar, o\nb, baz, , ar & b"))
      .toEqual(["*foo", "<br>", "*bar", " &amp; ", "*baz"]);
    expect(await runs("foobar", "foo,foobar")).toEqual(["*foo", "bar"]);
    expect(await runs("foobar", "foobar,foo")).toEqual(["*foobar"]);
  });

  it("normalizes and escapes text and attributes without losing whitespace or line breaks", async () => {
    const png = pngFixture(1, 1);
    const unusual = "  A & < > \" '\t\r\nB\rC\nD\u0001\ud800X\udc00 \ud83d\ude42  ";
    const zip = await readZip(deckToPptx(oneSlide([
      block("text", {text: unusual}, {w: 400, h: 200}),
      block("image", {
        src: dataUrl("png", png),
        alt: "A & < > \" '",
        fit: "fill",
      }, {w: 20, h: 20}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");
    const text = shapeByName(xml, "Block 1 text");

    expect(text).toContain('<a:t xml:space="preserve">  A &amp; &lt; &gt; " \'\t</a:t>');
    expect(occurrences(text, "<a:br>")).toBe(3);
    // Each break carries the text's size, or an empty line would take the master's 18pt.
    expect(occurrences(text, '<a:br><a:rPr lang="en-US" sz="1520"')).toBe(3);
    expect(occurrences(text, "\ufffd")).toBe(3);
    expect(text).toContain("\ud83d\ude42  ");
    expect(text).not.toContain("\u0001");
    expect(text).not.toContain("\r");
    expect(shapeByName(xml, "Block 2 image")).toContain(
      'descr="A &amp; &lt; &gt; &quot; &apos;"',
    );
  });

  it("renders solid, inset, and cover backgrounds while omitting the former brand-bar SVG", async () => {
    const brandBar = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 12" preserveAspectRatio="none">' +
      '<defs><linearGradient id="g"><stop stop-color="#FF6633"/><stop offset=".5" stop-color="#F6821F"/>' +
      '<stop offset="1" stop-color="#FBAD41"/></linearGradient></defs><rect width="1200" height="12" fill="url(#g)"/></svg>';
    const zip = await readZip(deckToPptx({slides: [
      {id: "solid", background: {color: "#123456", inset: false}, blocks: [
        block("svg", {markup: brandBar}, {x: 0, y: 663, w: 1200, h: 12}),
      ]},
      {id: "inset", background: {color: "#abcdef", inset: true}, blocks: []},
      {id: "cover", background: {color: "#f6821f", inset: false, coverOrange: true}, blocks: []},
    ]}));
    const solid = partText(zip, "ppt/slides/slide1.xml");
    const inset = partText(zip, "ppt/slides/slide2.xml");
    const cover = partText(zip, "ppt/slides/slide3.xml");

    expect(solid).toContain('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="123456">');
    expect(solid).not.toContain('name="Inset surface"');
    expect(solid).not.toContain('name="Block 1 svg"');
    expect(solid).not.toContain("<a:gradFill");

    expect(inset).toContain('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="ABCDEF">');
    expect(inset).toContain('name="Inset surface"');
    expect(cover).toContain('name="Cover gradient"');
    expect(cover).not.toContain("<a:custGeom>");
  });

  it("embeds structural PNG/JPEG data, deduplicates media, and applies contain/cover/fill geometry", async () => {
    const png = pngFixture(4, 2);
    const jpeg = jpegFixture(2, 4);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(uint32be(png, 16)).toBe(4);
    expect(uint32be(png, 20)).toBe(2);
    expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...jpeg.subarray(-2)]).toEqual([0xff, 0xd9]);

    const zip = await readZip(deckToPptx(oneSlide([
      block("image", {src: dataUrl("png", png), fit: "contain", alt: "contain & image"}, {x: 10, y: 20, w: 200, h: 200}),
      block("image", {src: dataUrl("png", png), fit: "cover", alt: "cover"}, {x: 300, y: 20, w: 100, h: 100}),
      block("image", {src: dataUrl("jpeg", jpeg), fit: "fill", alt: "fill"}, {x: 500, y: 20, w: 100, h: 100}),
    ])));
    expect(zip.names.filter(name => name.startsWith("ppt/media/"))).toEqual([
      "ppt/media/image1.png",
      "ppt/media/image2.jpeg",
    ]);
    expect(zip.entries.get("ppt/media/image1.png")!.bytes).toEqual(png);
    expect(zip.entries.get("ppt/media/image2.jpeg")!.bytes).toEqual(jpeg);

    const xml = partText(zip, "ppt/slides/slide1.xml");
    const contain = shapeByName(xml, "Block 1 image");
    expect(contain).toContain('descr="contain &amp; image"');
    expect(contain).toContain('<a:blip r:embed="rId2"');
    expect(contain).toContain('<a:off x="101600" y="711200"/><a:ext cx="2032000" cy="1016000"/>');
    expect(contain).not.toContain("<a:srcRect");
    const cover = shapeByName(xml, "Block 2 image");
    expect(cover).toContain('<a:blip r:embed="rId2"');
    expect(cover).toContain('<a:srcRect l="25000" t="0" r="25000" b="0"/>');
    expect(cover).toContain('<a:off x="3048000" y="203200"/><a:ext cx="1016000" cy="1016000"/>');
    const fill = shapeByName(xml, "Block 3 image");
    expect(fill).toContain('<a:blip r:embed="rId3"');
    expect(fill).toContain('<a:off x="5080000" y="203200"/><a:ext cx="1016000" cy="1016000"/>');
    expect(fill).not.toContain("<a:srcRect");

    const relationships = partText(zip, "ppt/slides/_rels/slide1.xml.rels");
    expect(occurrences(relationships, 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"')).toBe(2);
    expect(relationships).not.toContain("TargetMode");
  });

  it("pins a contained image where its objectPosition says, as CSS object-position does", async () => {
    const landscape = dataUrl("png", pngFixture(4, 2));
    const portrait = dataUrl("png", pngFixture(2, 4));
    const zip = await readZip(deckToPptx(oneSlide([
      block("image", {src: portrait, fit: "contain", objectPosition: "right top"}, {x: 0, y: 0, w: 100, h: 100}),
      block("image", {src: portrait, fit: "contain", objectPosition: "left bottom"}, {x: 0, y: 0, w: 100, h: 100}),
      block("image", {src: landscape, fit: "contain", objectPosition: "right bottom"}, {x: 0, y: 0, w: 100, h: 100}),
      block("image", {src: landscape, fit: "contain"}, {x: 0, y: 0, w: 100, h: 100}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");
    const off = (index: number) => /<a:off x="(\d+)" y="(\d+)"\/>/.exec(shapeByName(xml, `Block ${index} image`))!.slice(1).map(Number);
    expect(off(1)).toEqual([50 * 10160, 0]);
    expect(off(2)).toEqual([0, 0]);
    expect(off(3)).toEqual([0, 50 * 10160]);
    expect(off(4)).toEqual([0, 25 * 10160]);
  });

  it("rounds a contained image where the rounded corners of its block reach it", async () => {
    const square = dataUrl("png", pngFixture(2, 2));
    const landscape = dataUrl("png", pngFixture(4, 2));
    const portrait = dataUrl("png", pngFixture(2, 4));
    const zip = await readZip(deckToPptx(oneSlide([
      block("image", {src: square, fit: "contain", radius: 20}, {w: 100, h: 100}),
      block("image", {src: landscape, radius: 20}, {w: 200, h: 100}),
      block("image", {src: landscape, fit: "contain", radius: 20}, {w: 100, h: 100}),
      block("image", {src: portrait, fit: "contain", radius: 20}, {w: 100, h: 100}),
      // Letterboxed by 5px, under the 20px radius: the box's corner arc still cuts the picture.
      block("image", {src: landscape, fit: "contain", radius: 20}, {w: 100, h: 60}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");
    // The arc crosses the picture's edge 20 - sqrt(20² - 15²) = 6.77px from its corner (of 50px).
    expect(shapeByName(xml, "Block 5 image")).toContain(`<a:gd name="adj" fmla="val ${Math.round((20 - Math.sqrt(175)) / 50 * 100000)}"/>`);
    for (const index of [1, 2]) {
      const picture = shapeByName(xml, `Block ${index} image`);
      expect(picture).toContain('<a:prstGeom prst="roundRect">');
      expect(picture).toContain('<a:gd name="adj" fmla="val 20000"/>');
    }
    for (const index of [3, 4]) {
      expect(shapeByName(xml, `Block ${index} image`)).toContain('<a:prstGeom prst="rect">');
    }
  });

  it("uses placeholders for unavailable raster images and unknown blocks, but omits SVG", async () => {
    const zip = await readZip(deckToPptx(oneSlide([
      block("image", {}),
      block("image", {src: "https://example.com/image.png"}),
      block("image", {src: "data:image/png;base64,AAAA"}),
      block("image", {src: dataUrl("jpeg", jpegWithoutScan(2, 4))}),
      block("image", {src: "data:image/gif;base64,R0lGODlh"}),
      block("image", {src: `data:image/svg+xml;base64,${base64(encoder.encode("<svg/>"))}`}),
      block("svg", {markup: "", background: "#fff4e6"}),
      block("svg", {markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"><rect/></svg>', background: "#123456"}),
      block("not-a-real-block", {}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    // Placeholder labels are uppercased, as the browser's text-transform shows them.
    for (const placeholder of [
      "NO IMAGE",
      "REMOTE IMAGE NOT INCLUDED",
      "MALFORMED IMAGE DATA",
      "UNSUPPORTED OR MALFORMED IMAGE",
      "?: not-a-real-block",
    ]) expect(xml).toContain(placeholder);
    expect(occurrences(xml, "MALFORMED IMAGE DATA")).toBe(2);
    // SVG is absent whether supplied as an image data URL or as a native SVG block.
    expect(xml).not.toContain("SVG not included");
    expect(xml).not.toContain("Paste SVG markup");
    for (const name of ["Block 6 image", "Block 7 svg", "Block 8 svg"]) {
      expect(xml).not.toContain(`name="${name}"`);
    }
    expect(xml).not.toContain("<a:gradFill");
    expect(xml).not.toContain("<p:pic>");
    expect(xml).not.toContain("svgBlip");
    expect(zip.names.some(name => name.startsWith("ppt/media/"))).toBe(false);
    expect(partText(zip, "[Content_Types].xml")).not.toContain("svg");
    expect(partText(zip, "ppt/slides/_rels/slide1.xml.rels")).not.toContain("/image");
    for (const name of zip.names.filter(entryName => entryName.endsWith(".rels"))) {
      expect(partText(zip, name)).not.toContain("TargetMode");
    }
  });

  it("rejects a JPEG that declares a second frame header", async () => {
    const jpeg = jpegFixture(2, 4);
    // SOI and APP0 are the first 20 bytes; a 9000x9000 SOF0 ahead of the real one could carry the
    // dimensions a consumer trusts while the pixel limits were checked against the other.
    const twoFrames = concat(jpeg.subarray(0, 20), new Uint8Array([
      0xff, 0xc0, 0x00, 0x11, 0x08, 9_000 >>> 8, 9_000 & 0xff, 9_000 >>> 8, 9_000 & 0xff,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    ]), jpeg.subarray(20));
    const zip = await readZip(deckToPptx(oneSlide([block("image", {src: dataUrl("jpeg", twoFrames)})])));
    expect(partText(zip, "ppt/slides/slide1.xml")).toContain("MALFORMED IMAGE DATA");
    expect(zip.names.some(name => name.startsWith("ppt/media/"))).toBe(false);
  });

  it("omits SVG markup and SVG image data without parsing their contents", async () => {
    const largeMarkup = `<svg>${"<not-even-valid".repeat(100_000)}</svg>`;
    const largeDataUrl = `data:image/svg+xml;base64,${"?".repeat(1_000_000)}`;
    const zip = await readZip(deckToPptx(oneSlide([
      block("svg", {markup: largeMarkup}),
      block("image", {src: largeDataUrl}),
      block("image", {src: "DATA:IMAGE/SVG+XML,<svg/>"}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    expect(xml).not.toContain('name="Block 1 svg"');
    expect(xml).not.toContain('name="Block 2 image"');
    expect(xml).not.toContain('name="Block 3 image"');
    expect(xml).not.toContain("SVG not included");
    expect(zip.names.some(name => name.startsWith("ppt/media/"))).toBe(false);
  });

  it("consults the source cache before scanning a repeated raster source", () => {
    // One 4 MB source referenced from every block on a slide: scanned and decoded once, not per
    // reference (its padding makes it a malformed PNG, so the cached result is a placeholder).
    const unpadded = dataUrl("png", pngFixture(1, 1)).replace(/=+$/, "");
    const source = unpadded + "A".repeat(4 * 1024 * 1024 + (4 - unpadded.length % 4) % 4);
    const started = performance.now();
    deckToPptx(oneSlide(Array.from({length: 1000}, () => block("image", {src: source}))));
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("emits schema-valid DrawingML for hairline dashes and half-pixel positions", async () => {
    const zip = await readZip(deckToPptx(oneSlide([
      block("arrow", {x1: 0, y1: 0, x2: 100, y2: 0, dashed: true, width: 0.0001}),
      block("shape", {kind: "rect", fill: "#ffffff"}, {x: 48.5, y: 240.25, w: 10.25, h: 20.5}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    // A 1-EMU line's 6px dash is billions of percent; ST_PositivePercentage is a 32-bit integer.
    expect(shapeByName(xml, "Block 1 arrow")).toContain('<a:custDash><a:ds d="2147483647" sp="2147483647"/></a:custDash>');
    // Fractional pixel positions must round to integer EMUs.
    expect(xml).not.toMatch(/\b(?:x|y|cx|cy)="-?\d+\.\d+"/);
  });

  it("sizes cards and boxes without authored dimensions to their content, like the browser", async () => {
    const zip = await readZip(deckToPptx(oneSlide([
      block("card", {eyebrow: "eye", title: "Card", body: "Body"}, {x: 100, y: 100}),
      block("box", {title: "Box", body: "Body copy"}, {x: 100, y: 400}),
      block("box", {title: "Box"}, {x: 100, y: 500, w: 220}),
      block("card", {eyebrow: "", title: "", body: "word ".repeat(400)}, {x: 1100, y: 0}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    // Padding 20 around eyebrow (10px * 1.2), title (18 * 1.3) and body (15 * 1.5, with 2px of
    // slack for its own box) with 12px flex gaps; the width is the widest line ("Card" at 18px
    // semibold) plus padding. Surfaces are drawn inset by half their 1px border, as CSS draws a
    // border inside the box, so each outer dimension shows here 1px smaller.
    const cardHeight = 40 + 12 + 12 + 23.4 + 12 + (22.5 + 2);
    const card = shapeByName(xml, "Block 1 card surface");
    expect(card).toContain(`cy="${Math.round((cardHeight - 1) * 10160)}"`);
    // The title's -0.02em tracking is emitted in hundredths of a point (-29), and measured as such.
    expect(card).toContain(`cx="${Math.round((40 + (2.278 * 18 - 3 * 0.29 / 0.8) * 1.02 - 1) * 10160)}"`);
    expect(shapeByName(xml, "Block 1 card body")).toContain(`cy="${Math.round((22.5 + 2) * 10160)}"`);
    // Padding 14 around title (16 * 1.3), the 6px margin and body (14 * 1.45).
    const box = shapeByName(xml, "Block 2 box surface");
    expect(box).toContain(`cy="${Math.round((28 + 20.8 + 6 + 20.3 - 1) * 10160)}"`);
    expect(box).toContain(`cx="${Math.round((28 + 4.669 * 14 * 1.02 - 1) * 10160)}"`);
    // An authored width is kept; the content-driven height has no body margin.
    const sized = shapeByName(xml, "Block 3 box surface");
    expect(sized).toContain(`cx="${219 * 10160}"`);
    expect(sized).toContain(`cy="${Math.round((28 + 20.8 - 1) * 10160)}"`);
    // width: auto stops at the slide's edge, and the body wraps within it.
    expect(shapeByName(xml, "Block 4 card surface")).toContain(`cx="${99 * 10160}"`);
  });

  it("lays out blocks without authored sizes as the browser does", async () => {
    const zip = await readZip(deckToPptx(oneSlide([
      block("title", {text: "word ".repeat(80), fontSize: 28}, {x: 36, y: 76}),
      block("text", {text: "short\nlonger line", fontSize: 20}, {x: 100, y: 0}),
      block("bulletList", {text: "a   b\tc\none"}, {x: 0, y: 300}),
      block("arrow", {x2: 600, y2: 400, color: "ruby"}),
      block("tonePill", {text: "STATUS"}, {x: 100, y: 100, w: 300, h: 100}),
      block("box", {title: "Title", body: "Body copy that wraps onto several lines"}, {x: 100, y: 100, w: 220, h: 40}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    // width: auto shrink-to-fits up to the slide's right edge (1200 - x), never a fixed default.
    expect(shapeByName(xml, "Block 1 title")).toContain(`<a:ext cx="${(1200 - 36) * 10160}"`);
    // The widest line ("longer line", 4613 Arial units) plus the 2% one-line slack.
    const text = shapeByName(xml, "Block 2 text");
    expect(Number(/<a:ext cx="(\d+)"/.exec(text)![1])).toBe(Math.round(4.613 * 20 * 1.02 * 10160));
    // Items collapse inner whitespace like the browser's white-space: normal.
    expect(shapeByName(xml, "Block 3 bulletList")).toContain(">a b c</a:t>");
    // Omitted endpoints are absent SVG attributes, i.e. 0: from (0,0) to (600,400). The line stops
    // at the head's base, 8 stroke widths (16px) short of the end point.
    const back = 16 / Math.hypot(600, 400);
    expect(shapeByName(xml, "Block 4 arrow")).toContain(`<a:off x="0" y="0"/><a:ext cx="${Math.round(600 * (1 - back) * 10160)}" cy="${Math.round(400 * (1 - back) * 10160)}"/>`);
    // The pill stays intrinsic despite the 300x100 wrapper.
    expect(shapeByName(xml, "Block 5 tonePill")).toContain(`cy="${Math.round((10 + 11 * 1.4) * 10160)}"`);
    expect(shapeByName(xml, "Block 5 tonePill")).not.toContain(`cx="${300 * 10160}"`);
    // An overfull box centres its stack, overflowing above and below alike.
    const titleHeight = 16 * 1.3;
    const bodyHeight = 2 * 14 * 1.45;
    const contentHeight = titleHeight + 6 + bodyHeight;
    expect(shapeByName(xml, "Block 6 box title")).toContain(`y="${textTop(100 + (40 - contentHeight) / 2, 16, 1.3)}"`);
  });

  it("exports a safe blank slide for empty or malformed decks", async () => {
    for (const value of [null, {}, {slides: []}, {slides: "not an array"}]) {
      const zip = await readZip(deckToPptx(value));
      expect(zip.names.filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toEqual([
        "ppt/slides/slide1.xml",
      ]);
      const xml = partText(zip, "ppt/slides/slide1.xml");
      expect(xml).toContain("<p:spTree>");
      expect(xml).not.toMatch(/NaN|Infinity/);
    }
  });

  it("sizes auto-height text by word wrapping with tracking, and lets consumers grow it", async () => {
    const zip = await readZip(deckToPptx(oneSlide([
      // Three words of ~55px in a 100px box: advance-width division says 2 lines, wrapping says 3.
      block("text", {text: "wwww wwww wwww", fontSize: 19, lineHeight: 1.6}, {w: 100}),
      // Two 44.5px words fit one 100px line untracked; 2px tracking pushes the second word down.
      block("title", {text: "aaaa aaaa", fontSize: 20, letterSpacing: "2px"}, {w: 100}),
      block("title", {text: "aaaa aaaa", fontSize: 20, letterSpacing: "0px"}, {w: 100}),
      block("text", {text: "fixed"}, {w: 100, h: 40}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    const wrapped = shapeByName(xml, "Block 1 text");
    expect(wrapped).toContain(`cy="${Math.round((3 * 19 * 1.6 + 2) * 10160)}"`);
    expect(wrapped).toContain("<a:spAutoFit/>");
    expect(shapeByName(xml, "Block 2 title")).toContain(`cy="${Math.round((2 * 20 * 1.08 + 2) * 10160)}"`);
    expect(shapeByName(xml, "Block 3 title")).toContain(`cy="${Math.round((20 * 1.08 + 2) * 10160)}"`);
    expect(shapeByName(xml, "Block 4 text")).toContain("<a:noAutofit/>");
  });

  it("accepts named and functional CSS colors and falls back for unknown ones", async () => {
    const zip = await readZip(deckToPptx(oneSlide([
      block("shape", {fill: "red", stroke: "Navy", strokeWidth: 1}, {w: 10, h: 10}),
      block("shape", {fill: "rgb(0, 128, 255)"}, {w: 10, h: 10}),
      block("shape", {fill: "rgba(100% 0% 0% / 0.5)"}, {w: 10, h: 10}),
      block("shape", {fill: "rebeccapurple"}, {w: 10, h: 10}),
      block("text", {text: "fallback", color: "rgb(1,2)"}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    const named = shapeByName(xml, "Block 1 shape");
    expect(named).toContain('<a:solidFill><a:srgbClr val="FF0000">');
    expect(named).toContain('<a:ln w="10160" cap="rnd"><a:solidFill><a:srgbClr val="000080">');
    expect(shapeByName(xml, "Block 2 shape")).toContain('<a:srgbClr val="0080FF">');
    expect(shapeByName(xml, "Block 3 shape")).toContain('<a:srgbClr val="FF0000"><a:alpha val="50000"/>');
    expect(shapeByName(xml, "Block 4 shape")).toContain("<a:noFill/>");
    expect(shapeByName(xml, "Block 5 text")).toContain('<a:srgbClr val="000000">'); // the text default
  });

  it.each([
    {label: "long title", eyebrow: "", title: "A long card heading that wraps over many lines. ".repeat(6), body: "Body", height: 100},
    {label: "long eyebrow and multiline body", eyebrow: "A long eyebrow ".repeat(12), title: "Card title", body: "Body copy\n".repeat(10), height: 60},
    {label: "empty title and long body", eyebrow: "Eyebrow", title: "", body: "Long body copy ".repeat(40), height: 100},
    {label: "less height than padding", eyebrow: "Eyebrow", title: "Title", body: "Body", height: 24},
  ])("lays out an overfull fixed-height card like the browser, shrinking only its body: $label", async ({eyebrow, title, body, height}) => {
    const zip = await readZip(deckToPptx(oneSlide([
      block("card", {eyebrow, title, body}, {x: 100, y: 100, w: 280, h: height}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");
    // The drawn surface is inset by half its 1px border; the text lays out in the outer box.
    const drawn = shapeVerticalBounds(shapeByName(xml, "Block 1 card surface"));
    expect(drawn).toEqual({y: 100.5 * 10160, height: (height - 1) * 10160});
    const padding = Math.min(20, height / 2);
    // The browser's flex column keeps the eyebrow and title at full size (overflow is clipped):
    // each starts where the one before it ends, plus the 12px gap.
    let y = 100 + padding;
    for (const [part, text, fontSize, lineHeight] of [["eyebrow", eyebrow, 10, 1.2], ["title", title, 18, 1.3]] as const) {
      if (!text) continue;
      const shape = shapeByName(xml, `Block 1 card ${part}`);
      const box = shapeVerticalBounds(shape);
      expect(box.y).toBe(textTop(y, fontSize, lineHeight));
      const lines = Math.round(box.height / 10160 / (fontSize * lineHeight));
      expect(box.height / 10160).toBeCloseTo(lines * fontSize * lineHeight, 2);
      expect(shape).toContain("<a:noAutofit/>");
      y += box.height / 10160 + 12;
    }
    if (!title) y += 12;
    // The body takes the room left above the bottom padding, and a stored font scale fits it there.
    const shape = shapeByName(xml, "Block 1 card body");
    const box = shapeVerticalBounds(shape);
    expect(box.y).toBe(textTop(y, 15, 1.5));
    expect(box.y + box.height).toBeLessThanOrEqual(Math.max(textTop(y, 15, 1.5) + 1, textTop(100 + height - padding, 15, 1.5) + 1));
    expect(shape).toMatch(/<a:normAutofit fontScale="\d+"\/>/);
    const exportedText = [...shape.matchAll(/<a:br>|<a:t[^>]*>([^<]*)<\/a:t>/g)]
      .map(match => match[1] ?? "\n").join("");
    expect(exportedText).toBe(body);
  });

  it("collapses whitespace in inline-only props and shrinks card text to its surface", async () => {
    const zip = await readZip(deckToPptx(oneSlide([
      block("box", {title: "One\ntwo", body: "line\n\n  break"}, {w: 220, h: 110}),
      block("card", {eyebrow: "eye\nbrow", title: "Card\ttitle", body: "kept\nbreak"}, {w: 280, h: 260}),
      block("sectionLabel", {text: "two\nlines"}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    const box = shapeByName(xml, "Block 1 box body");
    expect(box).toContain(">line break</a:t>");
    expect(box).not.toContain("<a:br>");
    expect(shapeByName(xml, "Block 1 box title")).toContain(">One two</a:t>");
    expect(shapeByName(xml, "Block 2 card eyebrow")).toContain(">EYE BROW</a:t>");
    expect(shapeByName(xml, "Block 2 card title")).toContain(">Card title</a:t>");
    const body = shapeByName(xml, "Block 2 card body");
    expect(body).toContain("<a:br>"); // card bodies are pre-wrap in the browser
    // Only the body shrinks, and this one fits its card as it is.
    expect(shapeByName(xml, "Block 2 card body")).toContain("<a:normAutofit/>");
    for (const part of ["eyebrow", "title"]) expect(shapeByName(xml, `Block 2 card ${part}`)).toContain("<a:noAutofit/>");
    expect(shapeByName(xml, "Block 3 sectionLabel")).toContain(">TWO LINES</a:t>");
  });

  it("stops shrinking an overfull card body at 60% and lets it overflow instead", async () => {
    const xml = partText(await readZip(deckToPptx(oneSlide([
      block("card", {eyebrow: "Overflow", title: "Too much", body: "A paragraph that cannot fit. ".repeat(60)}, {x: 0, y: 0, w: 280, h: 200}),
      block("card", {title: "Slightly over", body: "Body copy that wraps a little. ".repeat(6)}, {x: 300, y: 0, w: 280, h: 160}),
    ]))), "ppt/slides/slide1.xml");

    expect(shapeByName(xml, "Block 1 card body")).toContain('<a:normAutofit fontScale="60000"/>');
    const mild = /<a:normAutofit fontScale="(\d+)"\/>/.exec(shapeByName(xml, "Block 2 card body"));
    expect(Number(mild?.[1])).toBeGreaterThan(60000);
    expect(Number(mild?.[1])).toBeLessThan(100000);
    expect(xml).not.toContain("lnSpcReduction");
  });

  it("keeps the full half-leading for centred text in a drawn surface", async () => {
    const xml = partText(await readZip(deckToPptx(oneSlide([
      block("tonePill", {text: "STATUS"}, {x: 100, y: 100}),
    ]))), "ppt/slides/slide1.xml");
    // PowerPoint centres the whole line box, leading included: the pill's insets take
    // 2 * (1.4 - 1.117) / 2 * 11px at the bottom so the glyphs sit where CSS centres them.
    expect(shapeByName(xml, "Block 1 tonePill")).toContain(`bIns="${Math.round((1.4 - 1.117) * 11 * 10160)}"`);
  });

  it("sizes the bullet relative to its text so its disc is the browser's 6px dot", async () => {
    const xml = partText(await readZip(deckToPptx(oneSlide([
      block("bulletList", {text: "one\ntwo"}),
      block("bulletList", {text: "one", treatment: "compact"}, {y: 300}),
    ]))), "ppt/slides/slide1.xml");
    // PowerPoint for the web ignores buSzPts, so the size is a percentage of the 19px (primary) or
    // 17px (compact) text: 6px over Arial's 0.2476em U+2022 disc.
    for (const [name, fontSize] of [["Block 1 bulletList", 19], ["Block 2 bulletList", 17]] as const) {
      const bullets = shapeByName(xml, name);
      expect(bullets).toContain(`<a:buSzPct val="${Math.round(6 / 0.2476 / fontSize * 100) * 1000}"/>`);
      expect(bullets).not.toContain("buSzPts");
      expect(bullets).toContain(`marL="${18 * 10160}" indent="-${18 * 10160}"`);
    }
  });

  it("gives empty card and box titles no height, like the browser's empty element", async () => {
    const zip = await readZip(deckToPptx(oneSlide([
      block("card", {eyebrow: "", title: "", body: "Body"}, {x: 0, y: 0, w: 280, h: 260}),
      block("box", {title: "", body: "Body"}, {x: 0, y: 300, w: 220, h: 110}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    expect(xml).not.toContain('name="Block 1 card title"');
    expect(xml).not.toContain('name="Block 2 box title"');
    // Card padding (20) plus the single remaining flex gap (12).
    expect(shapeByName(xml, "Block 1 card body")).toContain(`<a:off x="${20 * 10160}" y="${textTop(32, 15, 1.5)}"/>`);
    // Box body is vertically centred on its own height (14px line * 1.45, plus the 6px gap).
    const bodyHeight = 14 * 1.45;
    const bodyY = 300 + (110 - (6 + bodyHeight)) / 2 + 6;
    expect(shapeByName(xml, "Block 2 box body")).toContain(`y="${textTop(bodyY, 14, 1.45)}"`);
  });

  it("clamps non-finite, negative, and extreme drawing geometry", async () => {
    const zip = await readZip(deckToPptx(oneSlide([
      block("shape", {fill: "#000000"}, {x: 1e300, y: -1e300, w: 1e300, h: -10}),
      block("shape", {fill: "#ffffff"}, {x: Number.NaN, y: Number.POSITIVE_INFINITY, w: Number.NaN, h: Number.NEGATIVE_INFINITY}),
      block("arrow", {x1: -10, y1: Number.NaN, x2: Number.POSITIVE_INFINITY, y2: 1e300}),
      block("title", {text: "finite", fontSize: Number.POSITIVE_INFINITY}, {x: -25, y: -30, w: -1, h: -2}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    expect(shapeByName(xml, "Block 1 shape")).toContain(
      '<a:off x="2147483647" y="-2147483647"/><a:ext cx="2147483647" cy="1"/>',
    );
    expect(shapeByName(xml, "Block 2 shape")).toContain(
      '<a:off x="0" y="0"/><a:ext cx="2032000" cy="2032000"/>',
    );
    expect(shapeByName(xml, "Block 4 title")).toContain(
      `<a:off x="-254000" y="${textTop(-30, 42, 1.08)}"/><a:ext cx="1" cy="1"/>`,
    );
    expect(xml).not.toMatch(/NaN|Infinity/);
    for (const match of xml.matchAll(/\b(?:x|y|cx|cy)="(-?\d+)"/g)) {
      expect(Math.abs(Number(match[1]))).toBeLessThanOrEqual(2147483647);
    }
  });

  it("makes each slide's first title block its title placeholder, for the outline and screen readers", async () => {
    const zip = await readZip(deckToPptx({slides: [
      {background: {inset: false}, blocks: [
        block("text", {text: "intro"}),
        block("title", {text: "First"}, {w: 400}),
        block("title", {text: "Second"}, {y: 100, w: 400}),
      ]},
      {background: {inset: false}, blocks: [block("text", {text: "no title"})]},
    ]}));
    const xml = partText(zip, "ppt/slides/slide1.xml");
    const first = shapeByName(xml, "Block 2 title");
    expect(first).toContain('<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr>');
    // Everything is set on the shape itself, so the master's 32pt title style changes nothing.
    expect(first).toContain('sz="3360" b="1"'); // the 42px default, not the master's 32pt
    expect(first).toContain("<a:bodyPr wrap=\"square\"");
    expect(shapeByName(xml, "Block 3 title")).toContain('<p:cNvSpPr txBox="1"/><p:nvPr/>');
    expect(occurrences(xml, "<p:ph ")).toBe(1);
    expect(partText(zip, "ppt/slides/slide2.xml")).not.toContain("<p:ph ");
  });

  it("marks adapter-supplied background pictures decorative instead of giving them alt text", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const xml = partText(await readZip(deckToPptx(oneSlide([
      block("image", {src: png, alt: "", decorative: true}, {w: 10, h: 10}),
      block("image", {src: png, alt: "A chart"}, {w: 10, h: 10}),
    ]))), "ppt/slides/slide1.xml");
    const art = shapeByName(xml, "Block 1 image");
    expect(art).toContain('<a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><adec:decorative xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/></a:ext>');
    expect(art).not.toContain("descr=");
    expect(shapeByName(xml, "Block 2 image")).toContain('descr="A chart"/>');
  });

  it("names an empty image's slot with the adapter's emptyText", async () => {
    const xml = partText(await readZip(deckToPptx(oneSlide([
      block("image", {src: "", emptyText: "Paste SVG markup"}, {w: 300, h: 200}),
      block("image", {src: ""}, {w: 300, h: 200}),
      block("image", {src: "https://example.test/a.png", emptyText: "Paste SVG markup"}, {w: 300, h: 200}),
    ]))), "ppt/slides/slide1.xml");
    expect(shapeByName(xml, "Block 1 image")).toContain(">PASTE SVG MARKUP</a:t>");
    expect(shapeByName(xml, "Block 2 image")).toContain(">NO IMAGE</a:t>");
    // A source that couldn't be embedded still says why.
    expect(shapeByName(xml, "Block 3 image")).toContain(">REMOTE IMAGE NOT INCLUDED</a:t>");
  });

  it("sets an arrow label on the browser's baseline, 8px above the midpoint", async () => {
    const xml = partText(await readZip(deckToPptx(oneSlide([
      block("arrow", {x1: 100, y1: 200, x2: 300, y2: 200, label: "go"}),
    ]))), "ppt/slides/slide1.xml");
    // A 12px line at line-height 1 has its baseline (1 - 1.117) / 2 + 0.905 em below its top; the
    // box is raised like every top-anchored text box.
    const top = 200 - 8 - ((1 - 1.117) / 2 + 0.905) * 12;
    expect(shapeByName(xml, "Block 1 arrow label")).toContain(`y="${textTop(top, 12, 1)}"`);
  });

  it("sizes the unknown-block badge to its text, as the browser's badge ignores w and h", async () => {
    const xml = partText(await readZip(deckToPptx(oneSlide([
      block("mystery", {}, {x: 10, y: 20, w: 500, h: 300}),
    ]))), "ppt/slides/slide1.xml");
    const badge = shapeByName(xml, "Block 1 mystery");
    expect(badge).toContain(">?: mystery</a:t>");
    expect(badge).toContain(`cy="${Math.round((12 + 12 * 1.4) * 10160)}"`);
    expect(badge).not.toContain(`cx="${500 * 10160}"`);
  });
});

describe("PPTX resource limits", () => {
  it("reports actionable slide-count and blocks-per-slide errors", () => {
    expect(() => deckToPptx({
      slides: Array.from({length: 501}, () => ({blocks: []})),
    })).toThrow("Deck has 501 slides; PowerPoint export supports at most 500");
    expect(() => deckToPptx(oneSlide(Array.from({length: 1001}, () => null))))
      .toThrow("Slide 1 has 1001 blocks; the export limit is 1000 per slide");
  });

  it("rejects every authored quota before invoking adapters or preparing earlier slides", () => {
    const prepare = vi.fn(() => { throw new Error("prepared before quota validation"); });
    const early = {get background() { return prepare(); }, blocks: [block("text", {text: "early"})]};
    const adapt = vi.fn(() => undefined);
    const cases = [
      {deck: {slides: [early, ...Array.from({length: 500}, () => ({blocks: []}))]}, message: "Deck has 501 slides"},
      {deck: {slides: [early, {blocks: Array(1001).fill(null)}]}, message: "Slide 2 has 1001 blocks"},
      {deck: {slides: [early, ...Array.from({length: 10}, () => ({blocks: Array(1000).fill(null)}))]}, message: "Deck has more than 10000 blocks"},
    ];
    for (const {deck, message} of cases) {
      expect(() => deckToPptx(deck, adapt)).toThrow(message);
      expect(adapt).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    }
  });

  it("bounds adapted arrays across the whole deck before preparing blocks", () => {
    const prepare = vi.fn(() => { throw new Error("prepared before adapted quota validation"); });
    const expensive = {type: "text", get props() { return prepare(); }};
    const replacement = Array.from({length: 2000}, () => expensive);
    expect(() => deckToPptx(oneSlide([null, null]), () => replacement))
      .toThrow("Slide 1 has more than 2000 adapted blocks, the PowerPoint export limit.");
    expect(() => deckToPptx({slides: Array.from({length: 11}, () => ({blocks: [null]}))}, () => replacement))
      .toThrow("Deck has more than 20000 adapted blocks, the PowerPoint export limit.");
    expect(prepare).not.toHaveBeenCalled();
    const oversized = Array.from({length: 2001});
    Object.defineProperty(oversized, 0, {get: prepare});
    expect(() => deckToPptx(oneSlide([null]), () => oversized))
      .toThrow("Slide 1 has more than 2000 adapted blocks");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("exports adapter replacements in source z-order, preserving undefined and removing empty arrays", async () => {
    const kept = block("text", {text: "kept"});
    const replaced = block("custom", {});
    const removed = block("removed", {});
    const zip = await readZip(deckToPptx(oneSlide([kept, replaced, removed, block("text", {text: "last"})]), source => {
      if (source === removed) return [];
      if (source === replaced) return [block("text", {text: "replacement"}), block("shape", {fill: "#123456"})];
      return undefined;
    }));
    const xml = partText(zip, "ppt/slides/slide1.xml");
    expect(shapeByName(xml, "Block 1 text")).toContain("kept</a:t>");
    expect(shapeByName(xml, "Block 2 text")).toContain("replacement</a:t>");
    expect(shapeByName(xml, "Block 3 shape")).toContain('<a:srgbClr val="123456">');
    expect(shapeByName(xml, "Block 4 text")).toContain("last</a:t>");
    expect(xml).not.toContain("?:");
  });

  it("exports many references to one large text block without holding the deck text twice", async () => {
    // Structured-clone decks can alias one block object many times; the export must not build
    // per-character ropes over the resulting 7.9 MB of text.
    const shared = block("text", {text: "lorem ipsum & dolor <sit> amet ".repeat(3_225)}, {w: 760});
    expect(String(shared.props.text).length).toBeGreaterThan(99_000);
    const zip = await readZip(deckToPptx(oneSlide(Array.from({length: 79}, () => shared))));
    const xml = partText(zip, "ppt/slides/slide1.xml");
    expect(occurrences(xml, "&amp; dolor &lt;sit&gt; amet")).toBe(79 * 3_225);
  });

  it("reports aggregate text and line-break limits", () => {
    const largeText = "x".repeat(900_000);
    expect(() => deckToPptx(oneSlide(Array.from({length: 9}, () =>
      block("text", {text: largeText})))))
      .toThrow("Deck text is too large for PowerPoint export (maximum 8000000 characters total)");

    const tenThousandLines = "x\n".repeat(10_000);
    expect(() => deckToPptx(oneSlide(Array.from({length: 6}, () =>
      block("text", {text: tenThousandLines})))))
      .toThrow("Deck text has too many line breaks for PowerPoint export (maximum 50000 total)");
  });

  it("bounds comma-separated highlight parsing before allocating every entry", () => {
    const entries = (count: number) => commaSeparatedTerms("t", count);
    const title = (highlight: string) => oneSlide([block("title", {text: "t1", highlight})]);
    const error = "Slide 1, block 1 has too many comma-separated title highlight entries (maximum 128)";
    expect(() => deckToPptx(title(entries(128)))).not.toThrow();
    expect(() => deckToPptx(title(entries(129)))).toThrow(error);
    expect(() => deckToPptx(title(",".repeat(999_999)))).toThrow(error);
  });

  it("bounds highlight search work per title and per deck", () => {
    const terms = (count: number) => commaSeparatedTerms("term", count);
    expect(() => deckToPptx(oneSlide([block("title", {text: "x".repeat(1_000_000), highlight: terms(9)})])))
      .toThrow("Slide 1, block 1 title highlights are too complex for PowerPoint export.");
    const titles = (count: number) => Array.from({length: count}, () =>
      block("title", {text: "x".repeat(100_000), highlight: terms(64)}));
    expect(() => deckToPptx(oneSlide(titles(5)))).not.toThrow();
    expect(() => deckToPptx(oneSlide(titles(6))))
      .toThrow("Deck title highlights are too complex for PowerPoint export.");
  });

  it("bounds highlight text runs per title and per deck before creating the stream", () => {
    expect(() => deckToPptx(oneSlide([block("title", {text: "ab".repeat(50_000), highlight: "a"})])))
      .toThrow("Slide 1, block 1 title highlights would create too many PowerPoint text runs (maximum 4096 transitions)");
    const atLimit = "a" + "ba".repeat(2_048); // 4096 highlight transitions.
    expect(() => deckToPptx(oneSlide([block("title", {text: atLimit, highlight: "a"})]))).not.toThrow();
    expect(() => deckToPptx(oneSlide([block("title", {text: atLimit + "b", highlight: "a"})])))
      .toThrow("(maximum 4096 transitions)");
    const titles = (count: number) => Array.from({length: count}, () => block("title", {text: atLimit, highlight: "a"}));
    expect(() => deckToPptx(oneSlide(titles(8)))).not.toThrow();
    expect(() => deckToPptx(oneSlide(titles(9))))
      .toThrow("Deck title highlights would create too many PowerPoint text runs (maximum 32768 transitions total)");
  });

  it("rejects image dimensions beyond the declared raster limit", () => {
    const oversized = pngFixture(8_193, 1, false);
    expect(() => deckToPptx(oneSlide([
      block("image", {src: dataUrl("png", oversized)}),
    ]))).toThrow("each image dimension must be at most 8192px");
  });

  it("rejects aggregate image pixels before creating the stream", () => {
    const images = Array.from({length: 5}, (_, index) => block("image", {
      src: dataUrl("png", pngFixture(4_096, 4_092 + index, false)),
    }));
    expect(() => deckToPptx(oneSlide(images))).toThrow(
      "Deck images exceed the 67108864-pixel aggregate limit",
    );
  });
});

describe("PPTX SVG pictures", () => {
  const svg = '<svg viewBox="0 0 40 20" onload="alert(1)"><script>alert(2)</script><rect width="40" height="20" fill="#f00"/></svg>';

  it("embeds svgMarkup as an SVG picture over its PNG fallback", async () => {
    const png = dataUrl("png", pngFixture(4, 2));
    const zip = await readZip(deckToPptx(oneSlide([
      block("image", {src: png, svgMarkup: svg, fit: "contain", radius: 0}, {w: 400, h: 200}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");
    const picture = shapeByName(xml, "Block 1 image");
    // The PNG is the blip every viewer reads; the SVG rides in the Office 2016 extension.
    const embeds = [...picture.matchAll(/r:embed="(rId\d+)"/g)].map(match => match[1]);
    expect(embeds).toHaveLength(2);
    expect(picture).toContain('<a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">');
    expect(picture).toContain(`<asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="${embeds[1]}"/>`);

    const rels = partText(zip, "ppt/slides/_rels/slide1.xml.rels");
    const target = (id: string) => new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]
      ?? new RegExp(`Target="([^"]+)"[^>]*Id="${id}"`).exec(rels)![1];
    expect(target(embeds[0]!)).toMatch(/\.png$/);
    expect(target(embeds[1]!)).toMatch(/\.svg$/);
    expect(partText(zip, "[Content_Types].xml")).toContain('<Default Extension="svg" ContentType="image/svg+xml"/>');

    // The SVG is made standalone (namespace added) and stripped of script and event handlers.
    const svgPart = [...zip.names].find(name => name.endsWith(".svg"))!;
    const stored = partText(zip, svgPart);
    expect(stored).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(stored).not.toContain("script");
    expect(stored).not.toContain("onload");
    // Contained by the SVG's own 2:1 aspect, not the fallback's.
    expect(picture).toContain(`<a:ext cx="${400 * 10160}" cy="${200 * 10160}"/>`);
  });

  it("strips every form of script and event handler from the SVG part", async () => {
    const png = dataUrl("png", pngFixture(4, 2));
    const hostile = '<svg viewBox="0 0 40 20" onload=alert(1)><g/onfocus="alert(0)"/><rect onclick="a"onmouseover=\'b\' width="40"/>' +
      '<svg:script href="x.js"/><script>alert(2)</script ><rect height="20"/><script>alert(3)';
    const zip = await readZip(deckToPptx(oneSlide([
      block("image", {src: png, svgMarkup: hostile}, {w: 400, h: 200}),
    ])));
    const stored = partText(zip, [...zip.names].find(name => name.endsWith(".svg"))!);
    expect(stored).not.toMatch(/script|alert|\son|"on/i);
    expect(stored).toContain('<rect height="20"/>');
    expect(stored).toContain('width="40"');
  });

  // Attributes exist only in tags: text that reads like one, or a `>` inside a quoted value, changes nothing.
  it("strips handlers and links from tags only, leaving the SVG's text as written", async () => {
    const png = dataUrl("png", pngFixture(4, 2));
    const svg = '<svg viewBox="0 0 40 20"><text>Join onboarding = fun, see href=x and src="y"</text>' +
      '<!-- onload="kept" --><rect title="a>b" onload="alert(1)" width="40"/></svg>';
    const zip = await readZip(deckToPptx(oneSlide([block("image", {src: png, svgMarkup: svg}, {w: 400, h: 200})])));
    const stored = partText(zip, [...zip.names].find(name => name.endsWith(".svg"))!);
    expect(stored).toContain('<text>Join onboarding = fun, see href=x and src="y"</text>');
    expect(stored).toContain('<!-- onload="kept" -->');
    expect(stored).not.toContain("alert");
    expect(stored).toContain('width="40"');
  });

  it("keeps only fragment and image-data links in the SVG part", async () => {
    const png = dataUrl("png", pngFixture(4, 2));
    const linked = '<svg viewBox="0 0 40 20"><use href="#a"/><image xlink:href="https://tracker.example/p.png"/>' +
      `<image href='${png}'/><a href=javascript:alert(1)><rect width="40"/></a></svg>`;
    const zip = await readZip(deckToPptx(oneSlide([block("image", {src: png, svgMarkup: linked}, {w: 400, h: 200})])));
    const stored = partText(zip, [...zip.names].find(name => name.endsWith(".svg"))!);
    expect(stored).toContain('<use href="#a"/>');
    expect(stored).toContain(`<image href='${png}'/>`);
    expect(stored).not.toMatch(/tracker|javascript/);
  });

  // An icon-heavy deck: every distinct SVG adds its own part.
  it("exports hundreds of distinct SVG pictures", async () => {
    const png = dataUrl("png", pngFixture(4, 2));
    const icons = Array.from({length: 300}, (_, i) =>
      block("image", {src: png, svgMarkup: `<svg viewBox="0 0 40 20"><rect width="${i % 40}" height="${Math.floor(i / 40)}"/></svg>`}, {w: 40, h: 20}));
    const zip = await readZip(deckToPptx(oneSlide(icons)));
    expect([...zip.names].filter(name => name.endsWith(".svg"))).toHaveLength(300);
  });

  it("disarms animations that would write a link", async () => {
    const png = dataUrl("png", pngFixture(4, 2));
    const animated = '<svg viewBox="0 0 40 20"><a><set attributeName="href" to="https://x.example/"/>' +
      "<animate attributeName='xlink:href' values='https://y.example/'/><rect width=\"40\"/></a>" +
      '<animate attributeName="opacity" from="0" to="1"/></svg>';
    const zip = await readZip(deckToPptx(oneSlide([block("image", {src: png, svgMarkup: animated}, {w: 400, h: 200})])));
    const stored = partText(zip, [...zip.names].find(name => name.endsWith(".svg"))!);
    expect(stored).not.toMatch(/attributeName\s*=\s*["'](xlink:)?href/);
    expect(stored).toContain('attributeName="opacity"');
  });

  it("strips outside CSS references from the SVG part, keeping its <style> and fragment fills", async () => {
    const png = dataUrl("png", pngFixture(4, 2));
    const styled = '<svg viewBox="0 0 40 20"><style>@import url(https://tracker.example/a.css); .a{fill:url(#g)}' +
      ' .b{background:u\\72l("https://tracker.example/b.png")}</style><style><![CDATA[@import "https://tracker.example/c.css";]]></style>' +
      `<rect class="a" fill="url(#g)" style="background:url(&quot;https://tracker.example/d.png&quot;)" mask='url(https://tracker.example/m.svg#m)'/>` +
      `<rect style="background:url(${png})"/></svg>`;
    const zip = await readZip(deckToPptx(oneSlide([block("image", {src: png, svgMarkup: styled}, {w: 400, h: 200})])));
    const stored = partText(zip, [...zip.names].find(name => name.endsWith(".svg"))!);
    expect(stored).not.toMatch(/tracker|@import/);
    expect(stored).toContain(".a{fill:url(#g)}");
    expect(stored).toContain('fill="url(#g)"');
    expect(stored).toContain('style="background:none"');
    expect(stored).toContain('mask="none"');
    expect(stored).toContain(`style="background:url(${png})"`);
    expect(stored.match(/<style>/g)).toHaveLength(2);
  });

  it("sanitizes hostile SVG in linear time", () => {
    const flood = "<svg>" + "<script ".repeat(200_000) + ' onx="'.repeat(200_000) + "<style>".repeat(200_000) + ' x="url('.repeat(200_000);
    const started = Date.now();
    deckToPptx(oneSlide([block("image", {src: dataUrl("png", pngFixture(4, 2)), svgMarkup: flood})]));
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stretches a fill-fit SVG by dropping its aspect lock, and shares repeated sources", async () => {
    const png = dataUrl("png", pngFixture(4, 2));
    const zip = await readZip(deckToPptx(oneSlide([
      block("image", {src: png, svgMarkup: svg, fit: "fill"}, {w: 300, h: 300}),
      block("image", {src: png, svgMarkup: svg, fit: "fill"}, {w: 300, h: 300}),
    ])));
    const svgParts = zip.names.filter(name => name.endsWith(".svg"));
    expect(svgParts).toHaveLength(1);
    expect(partText(zip, svgParts[0]!)).toContain('preserveAspectRatio="none"');
  });
});

describe("PPTX logo and brand bar", () => {
  it("draws a logo as one plain wordmark text box, with no accent stop", async () => {
    const zip = await readZip(deckToPptx(oneSlide([
      block("logo", {variant: "dark"}, {x: 10, y: 20}),
      // `accentDot` is from older decks, and ignored either way.
      block("logo", {text: "Acme\n  Co", variant: "light", accentDot: true, scale: 2}),
      block("logo", {text: "  ", variant: "dark"}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");
    const dark = shapeByName(xml, "Block 1 logo");
    expect(dark).toContain('<a:bodyPr wrap="none"');
    expect(dark).toContain(`>${LOGO_DEFAULT_TEXT}</a:t>`);
    expect(dark).toContain('sz="1920" b="1"');
    expect(dark).not.toContain("F6821F");
    expect(dark.match(/<a:r>/g)).toHaveLength(1);
    const light = shapeByName(xml, "Block 2 logo");
    expect(light).toContain(">Acme Co</a:t>");
    expect(light).not.toContain(">.</a:t>");
    expect(light).toContain('sz="3840"');
    expect(light).toContain('<a:srgbClr val="FFFFFF">');
    // An emptied wordmark draws nothing.
    expect(xml).not.toContain('name="Block 3 logo"');
  });

  it("draws the brand bar as a native three-stop gradient", async () => {
    const zip = await readZip(deckToPptx(oneSlide([block("brandBar", {}, {x: 0, y: 663, w: 1200, h: 12})])));
    const bar = shapeByName(partText(zip, "ppt/slides/slide1.xml"), "Block 1 brandBar");
    expect(bar).toContain("<a:gradFill");
    for (const color of ["FF6633", "F6821F", "FBAD41"]) expect(bar).toContain(`<a:srgbClr val="${color}">`);
    expect(bar).toContain(`<a:off x="0" y="${663 * 10160}"/><a:ext cx="${1200 * 10160}" cy="${12 * 10160}"/>`);
  });

  it("names no company in the document properties", async () => {
    const zip = await readZip(deckToPptx(oneSlide()));
    expect(partText(zip, "docProps/app.xml")).not.toContain("<Company>");
    expect(partText(zip, "docProps/core.xml")).not.toMatch(/cloudflare/i);
  });
});
