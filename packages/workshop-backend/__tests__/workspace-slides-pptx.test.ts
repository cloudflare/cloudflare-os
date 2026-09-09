import { describe, expect, it, vi } from "vitest";
import { ExportHandler } from "../format-blueprints/workspace-slides/files/server.js";
import { deckToPptx } from "../format-blueprints/workspace-slides/files/pptx.js";
import { crc32 } from "../format-blueprints/workspace-slides/files/zip.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

function handler(): ExportHandler {
  return Object.create(ExportHandler.prototype) as ExportHandler;
}

describe("Workspace Slides PPTX package", () => {
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
  });
});

describe("Workspace Slides PPTX rendering", () => {
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
    expect(title).toContain('<a:off x="50800" y="60960"/><a:ext cx="1016000" cy="304800"/>');
    expect(title).toContain('sz="1600"');
    expect(title).toContain('spc="160"');
    expect(title).toContain('<a:latin typeface="Arial"/>');
    expect(title).not.toContain('typeface="Inter"');
    expect(title).toContain('<a:spcPct val="108696"/>'); // line-height 1.25 over Arial's natural 1.15.

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
      block("logo", {text: "Workspace", variant: "dark", scale: 0.62}, {x: 1013, y: 40}),
      block("sectionLabel", {text: "A LONG SECTION LABEL"}, {x: 36, y: 35}),
      block("text", {text: "x ".repeat(60), fontSize: 19, lineHeight: 1.6}, {x: 36, y: 204, w: 760}),
      block("text", {text: "Next block", fontSize: 19, lineHeight: 1.6}, {x: 36, y: 252, w: 760}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    const wordmark = shapeByName(xml, "Block 1 logo wordmark");
    expect(wordmark).toContain('<a:bodyPr wrap="none"');
    // "Workspace" in Arial Bold is 5.335em; at 24px * 0.62 the box must hold it (Google Slides
    // ignores wrap="none" and breaks anything wider than its box onto a second line).
    const wordmarkWidth = Number(/<a:ext cx="(\d+)"/.exec(wordmark)![1]);
    expect(wordmarkWidth).toBeGreaterThanOrEqual(Math.round(5.335 * 24 * 0.62 * 10160));
    // Natural line spacing, so the first-line baseline is Arial's 0.905em below the box top in
    // every consumer; the box is raised so that baseline lands where the browser's line-height-1
    // layout puts it (0.83em), and the dot's bottom sits 1px above it, like the browser's.
    expect(wordmark).toContain('<a:spcPct val="100000"/>');
    const fontPx = 24 * 0.62;
    const baseline = 40 + fontPx * 0.83;
    expect(wordmark).toContain(`<a:off x="${1013 * 10160}" y="${Math.round((baseline - fontPx * 0.905) * 10160)}"/>`);
    const dot = shapeByName(xml, "Block 1 logo accent dot");
    const dotY = Number(/<a:off x="\d+" y="(\d+)"/.exec(dot)![1]);
    expect(dotY + 6 * 0.62 * 10160).toBeCloseTo((baseline - 0.62) * 10160, -2);
    // Tracking after the last glyph as Chrome does, then the 3px flex gap.
    const dotX = Number(/<a:off x="(\d+)"/.exec(dot)![1]);
    expect(dotX).toBeCloseTo((1013 + (5.335 - 9 * 0.02) * fontPx + 3 * 0.62) * 10160, -2);
    expect(shapeByName(xml, "Block 2 sectionLabel")).toContain('<a:bodyPr wrap="none"');
    expect(shapeByName(xml, "Block 3 text")).toContain('<a:bodyPr wrap="square"');
    expect(shapeByName(xml, "Block 3 text")).toContain('<a:off x="365760" y="2072640"/>');
    expect(shapeByName(xml, "Block 4 text")).toContain('<a:off x="365760" y="2560320"/>');
  });

  it("renders every block type and its typography, fills, strokes, dashes, and radius", async () => {
    const blocks = [
      block("sectionLabel", {text: "section"}),
      block("logo", {text: "Workspace", variant: "dark"}),
      block("gadgetsMark", {size: "small"}),
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
      "Block 1 sectionLabel", "Block 2 logo wordmark", "Block 3 gadgetsMark hexagon",
      "Block 4 title", "Block 5 subtitle", "Block 6 text", "Block 7 bulletList",
      "Block 8 card surface", "Block 9 box surface", "Block 10 tonePill",
      "Block 11 divider", "Block 12 shape", "Block 13 shape", "Block 14 image",
      "Block 15 svg", "Block 16 arrow",
    ]) expect(xml, name).toContain(`name="${name}"`);

    expect(shapeByName(xml, "Block 1 sectionLabel")).toContain(">SECTION</a:t>");
    const title = shapeByName(xml, "Block 4 title");
    expect(occurrences(title, '<a:srgbClr val="FF5F2E">')).toBe(2);
    expect(title).toContain("HOT");
    expect(title).toContain("&amp; cold");
    expect(title).toContain('sz="1600" b="1" spc="160"');
    expect(title).toContain('<a:spcPct val="108696"/>');
    const aligned = shapeByName(xml, "Block 6 text");
    expect(aligned).toContain('<a:pPr algn="r"');
    expect(aligned).toContain('<a:spcPct val="173913"/>');
    expect(aligned).toContain('sz="1280"');

    const bullets = shapeByName(xml, "Block 7 bulletList");
    for (const item of ["one", "two", "three", "four", "five", "six"]) {
      expect(bullets).toContain(`>${item}</a:t>`);
    }
    expect(bullets).not.toContain(">seven</a:t>");
    expect(occurrences(bullets, '<a:buChar char="&#x25CF;"/>')).toBe(6);
    // The browser's dash is a fixed 6px; PowerPoint's preset scales with the stroke, so 6px is
    // expressed relative to the 1px border (600%) and to the 3px arrow (200%).
    expect(shapeByName(xml, "Block 9 box surface")).toContain('<a:custDash><a:ds d="600000" sp="600000"/></a:custDash>');
    // The pill is an intrinsic inline-block; the wrapper's w/h do not size it.
    expect(shapeByName(xml, "Block 10 tonePill")).toContain(`cy="${24 * 10160}"`);
    // A point-up hexagon: the preset (pointing sideways) laid out long-axis horizontal and rotated,
    // with the browser's 10-unit stroke scaled to the 48px icon.
    const hexagon = shapeByName(xml, "Block 3 gadgetsMark hexagon");
    expect(hexagon).toContain('<a:xfrm rot="5400000">');
    expect(hexagon).toContain(`<a:ext cx="${Math.round(74 * 48 / 86 * 10160)}" cy="${Math.round(68 * 48 / 86 * 10160)}"/>`);
    expect(hexagon).toContain(`<a:ln w="${Math.round(10 * 48 / 86 * 10160)}" cap="rnd">`);
    expect(hexagon).toContain("<a:round/>");
    expect(shapeByName(xml, "Block 10 tonePill")).toContain(">STATUS</a:t>");
    expect(shapeByName(xml, "Block 11 divider")).toContain('<a:alpha val="25000"/>');

    const ellipse = shapeByName(xml, "Block 12 shape");
    expect(ellipse).toContain('<a:prstGeom prst="ellipse">');
    expect(ellipse).toContain('<a:srgbClr val="123456"><a:alpha val="25098"/>');
    expect(ellipse).toContain('<a:ln w="20320" cap="rnd"><a:solidFill><a:srgbClr val="ABCDEF"><a:alpha val="50000"/>');
    expect(shapeByName(xml, "Block 13 shape")).toContain('<a:gd name="adj" fmla="val 20000"/>');
    const arrow = shapeByName(xml, "Block 16 arrow");
    expect(arrow).toContain('<a:custDash><a:ds d="200000" sp="200000"/></a:custDash>');
    expect(arrow).toContain('<a:tailEnd type="triangle" w="sm" len="sm"/>');
  });

  it("highlights terms across line breaks and coalesces overlapping matches into single runs", async () => {
    const zip = await readZip(deckToPptx(oneSlide([
      block("title", {text: "foo\nbar & baz", highlight: "foo\nbar, o\nb, ar &, , foo\nbar"}),
    ])));
    const title = shapeByName(partText(zip, "ppt/slides/slide1.xml"), "Block 1 title");
    const runs = [...title.matchAll(/<a:br\/>|<a:r>([\s\S]*?)<\/a:r>/g)].map(match => {
      if (match[0] === "<a:br/>") return "<br>";
      const text = /<a:t xml:space="preserve">([\s\S]*?)<\/a:t>/.exec(match[1])![1];
      return (match[1].includes('<a:srgbClr val="FF5F2E">') ? "*" : "") + text;
    });
    expect(runs).toEqual(["*foo", "<br>", "*bar &amp;", " baz"]);
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
    expect(occurrences(text, "<a:br/>")).toBe(3);
    expect(occurrences(text, "\ufffd")).toBe(3);
    expect(text).toContain("\ud83d\ude42  ");
    expect(text).not.toContain("\u0001");
    expect(text).not.toContain("\r");
    expect(shapeByName(xml, "Block 2 image")).toContain(
      'descr="A &amp; &lt; &gt; &quot; &apos;"',
    );
  });

  it("renders solid, inset, and cover backgrounds plus the brand bar as native shapes", async () => {
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
    const bar = shapeByName(solid, "Block 1 svg");
    expect(bar).toContain('<a:off x="0" y="6736080"/><a:ext cx="12192000" cy="121920"/>');
    expect(bar).toContain('<a:gradFill rotWithShape="1">');
    expect(solid).not.toContain("SVG not included");

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

  it("uses visible native placeholders for unavailable images, empty or invalid SVG, and unknown blocks", async () => {
    const zip = await readZip(deckToPptx(oneSlide([
      block("image", {}),
      block("image", {src: "https://example.com/image.png"}),
      block("image", {src: "data:image/png;base64,AAAA"}),
      block("image", {src: dataUrl("jpeg", jpegWithoutScan(2, 4))}),
      block("image", {src: "data:image/gif;base64,R0lGODlh"}),
      block("svg", {markup: "", background: "#fff4e6"}),
      block("svg", {markup: "<div>not svg</div>"}),
      block("not-a-real-block", {}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    for (const placeholder of [
      "No image",
      "Remote image not included",
      "Malformed image data",
      "Unsupported or malformed image",
      "Paste SVG markup",
      "Invalid SVG",
      "?: not-a-real-block",
    ]) expect(xml).toContain(placeholder);
    expect(occurrences(xml, "Malformed image data")).toBe(2);
    expect(xml).not.toContain("<a:gradFill");
    expect(xml).not.toContain("<p:pic>");
    expect(zip.names.some(name => name.startsWith("ppt/media/"))).toBe(false);
    expect(partText(zip, "ppt/slides/_rels/slide1.xml.rels")).not.toContain("/image");
    for (const name of zip.names.filter(entryName => entryName.endsWith(".rels"))) {
      expect(partText(zip, name)).not.toContain("TargetMode");
    }
  });

  it("embeds authored SVG verbatim as svgBlip pictures, letterboxed by its viewBox", async () => {
    const chart = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">' +
      '<script>alert(1)</script><text x="0" y="50">Q3 &amp; Q4</text></svg>';
    // Brand-bar size and palette, but not its structure (an extra rect): the seed decks' plain
    // bar is the only SVG replaced natively.
    const notBrandBar = '<svg viewBox="0 0 1200 12"><defs><linearGradient id="g"><stop stop-color="#FF6633"/>' +
      '<stop stop-color="#F6821F"/><stop stop-color="#FBAD41"/></linearGradient></defs>' +
      '<rect width="1200" height="12" fill="url(#g)"/><rect width="10" height="12" fill="#fff"/></svg>';
    const zip = await readZip(deckToPptx(oneSlide([
      block("svg", {markup: chart, fit: "contain", background: "#fff4e6"}, {x: 0, y: 0, w: 400, h: 400}),
      block("svg", {markup: chart, fit: "stretch"}, {x: 0, y: 0, w: 400, h: 400}),
      block("svg", {markup: '<svg width="300" height="100px"><rect/></svg>'}, {x: 0, y: 0, w: 300, h: 300}),
      block("svg", {markup: "<svg><rect/></svg>"}, {x: 0, y: 0, w: 300, h: 100}),
      block("svg", {markup: notBrandBar}, {x: 0, y: 663, w: 1200, h: 12}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    // Byte-for-byte: the exporter neither validates nor rewrites the markup.
    expect(zip.names.filter(name => name.startsWith("ppt/media/"))).toEqual([
      "ppt/media/image1.svg", "ppt/media/image2.svg", "ppt/media/image3.svg", "ppt/media/image4.svg",
    ]);
    expect(partText(zip, "ppt/media/image1.svg")).toBe(chart);
    expect(partText(zip, "[Content_Types].xml")).toContain('<Default Extension="svg" ContentType="image/svg+xml"/>');
    expect(partText(zip, "ppt/slides/_rels/slide1.xml.rels")).toContain('Target="../media/image1.svg"');

    const contain = shapeByName(xml, "Block 1 svg");
    expect(contain).toContain('<asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId2"/>');
    expect(contain).toContain('<a:blip r:embed="rId2" cstate="print">');
    expect(contain).toContain(`<a:off x="0" y="${100 * 10160}"/><a:ext cx="${400 * 10160}" cy="${200 * 10160}"/>`);
    expect(shapeByName(xml, "Block 1 svg background")).toContain('<a:srgbClr val="FFF4E6">');
    expect(shapeByName(xml, "Block 2 svg")).toContain(`<a:off x="0" y="0"/><a:ext cx="${400 * 10160}" cy="${400 * 10160}"/>`);
    expect(shapeByName(xml, "Block 2 svg")).toContain('r:embed="rId2"');
    expect(shapeByName(xml, "Block 3 svg")).toContain(`<a:off x="0" y="${100 * 10160}"/><a:ext cx="${300 * 10160}" cy="${100 * 10160}"/>`);
    expect(shapeByName(xml, "Block 4 svg")).toContain(`<a:off x="0" y="0"/><a:ext cx="${300 * 10160}" cy="${100 * 10160}"/>`);
    expect(shapeByName(xml, "Block 5 svg")).toContain("<p:blipFill>");
    expect(xml).not.toContain("<a:gradFill");
    expect(xml).not.toContain("SVG not included");
  });

  it("embeds the first <svg> element from wrapped markup and SVG files uploaded through the image control", async () => {
    const inner = '<svg viewBox="0 0 10 20"><rect width="10" height="20"/></svg>';
    const uploaded = `data:image/svg+xml;base64,${base64(encoder.encode(inner))}`;
    const nested = '<svg viewBox="0 0 4 4" data-x="a>b"><svg><rect/></svg><svg/></svg>';
    const zip = await readZip(deckToPptx(oneSlide([
      // A wrapper, a trailer and a sibling element: only the first <svg> is what the browser shows.
      block("svg", {markup: `<div class="wrap">${inner}</div><p>trailer</p><svg><circle/></svg>`}, {x: 0, y: 0, w: 200, h: 200}),
      block("svg", {markup: `${nested}<svg><text>sibling</text></svg>`}),
      block("svg", {markup: '<svg width="8" height="4"/><svg><text>sibling</text></svg>'}),
      block("svg", {markup: "<svg><rect/>"}),
      block("image", {src: uploaded, fit: "contain", radius: 50}, {x: 0, y: 0, w: 200, h: 200}),
      block("image", {src: uploaded, fit: "cover", radius: 50}, {x: 0, y: 0, w: 200, h: 200}),
      block("image", {src: `data:image/svg+xml;base64,${base64(encoder.encode("<p>not svg</p>"))}`}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    // The wrapper markup is dropped, and the pasted and uploaded copies of the element share a part.
    expect(zip.names.filter(name => name.startsWith("ppt/media/"))).toEqual([
      "ppt/media/image1.svg", "ppt/media/image2.svg", "ppt/media/image3.svg", "ppt/media/image4.svg",
    ]);
    expect(partText(zip, "ppt/media/image1.svg")).toBe(inner);
    expect(partText(zip, "ppt/media/image2.svg")).toBe(nested);
    expect(partText(zip, "ppt/media/image3.svg")).toBe('<svg width="8" height="4"/>');
    expect(partText(zip, "ppt/media/image4.svg")).toBe("<svg><rect/>");
    expect(shapeByName(xml, "Block 1 svg")).toContain(`<a:off x="${50 * 10160}" y="0"/><a:ext cx="${100 * 10160}" cy="${200 * 10160}"/>`);
    // A letterboxed picture never reaches the block's rounded corners, so only a filling one is rounded.
    const contain = shapeByName(xml, "Block 5 image");
    expect(contain).toContain(`<a:off x="${50 * 10160}" y="0"/>`);
    expect(contain).toContain('<a:prstGeom prst="rect">');
    const cover = shapeByName(xml, "Block 6 image");
    expect(cover).toContain('<a:srcRect l="0" t="25000" r="0" b="25000"/>');
    expect(cover).toContain('<a:prstGeom prst="roundRect">');
    expect(xml).toContain("Malformed image data");
  });

  it("parses SVG dimensions in linear time and consults the source cache before scanning", () => {
    const hostile = `<svg viewBox="${"1".repeat(100_000)}"><rect/></svg>`;
    let started = performance.now();
    deckToPptx(oneSlide([block("svg", {markup: hostile})]));
    expect(performance.now() - started).toBeLessThan(500);

    // One 4 MB source referenced from every block on a slide: scanned and decoded once, not per
    // reference (its padding makes it a malformed PNG, so the cached result is a placeholder).
    const unpadded = dataUrl("png", pngFixture(1, 1)).replace(/=+$/, "");
    const source = unpadded + "A".repeat(4 * 1024 * 1024 + (4 - unpadded.length % 4) % 4);
    started = performance.now();
    deckToPptx(oneSlide(Array.from({length: 1000}, () => block("image", {src: source}))));
    expect(performance.now() - started).toBeLessThan(2000);
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
    // Omitted endpoints are absent SVG attributes, i.e. 0: from (0,0) to (600,400).
    expect(shapeByName(xml, "Block 4 arrow")).toContain(`<a:off x="0" y="0"/><a:ext cx="${600 * 10160}" cy="${400 * 10160}"/>`);
    // The pill stays intrinsic despite the 300x100 wrapper.
    expect(shapeByName(xml, "Block 5 tonePill")).toContain(`cy="${24 * 10160}"`);
    expect(shapeByName(xml, "Block 5 tonePill")).not.toContain(`cx="${300 * 10160}"`);
    // An overfull box centres its stack, overflowing above and below alike.
    const titleHeight = 16 * 1.3 + 2;
    const bodyHeight = 2 * 14 * 1.45 + 2;
    const contentHeight = titleHeight + 6 + bodyHeight;
    expect(shapeByName(xml, "Block 6 box title")).toContain(`y="${Math.round((100 + (40 - contentHeight) / 2) * 10160)}"`);
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

  it("collapses whitespace in inline-only props and shrinks card text to its surface", async () => {
    const zip = await readZip(deckToPptx(oneSlide([
      block("box", {title: "One\ntwo", body: "line\n\n  break"}, {w: 220, h: 110}),
      block("card", {eyebrow: "eye\nbrow", title: "Card\ttitle", body: "kept\nbreak"}, {w: 280, h: 260}),
      block("sectionLabel", {text: "two\nlines"}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    const box = shapeByName(xml, "Block 1 box body");
    expect(box).toContain(">line break</a:t>");
    expect(box).not.toContain("<a:br/>");
    expect(shapeByName(xml, "Block 1 box title")).toContain(">One two</a:t>");
    expect(shapeByName(xml, "Block 2 card eyebrow")).toContain(">EYE BROW</a:t>");
    expect(shapeByName(xml, "Block 2 card title")).toContain(">Card title</a:t>");
    const body = shapeByName(xml, "Block 2 card body");
    expect(body).toContain("<a:br/>"); // card bodies are pre-wrap in the browser
    for (const part of ["eyebrow", "title", "body"]) {
      expect(shapeByName(xml, `Block 2 card ${part}`)).toContain("<a:normAutofit/>");
    }
    expect(shapeByName(xml, "Block 3 sectionLabel")).toContain(">TWO LINES</a:t>");
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
    expect(shapeByName(xml, "Block 1 card body")).toContain(`<a:off x="${20 * 10160}" y="${32 * 10160}"/>`);
    // Box body is vertically centred on its own height (14px line * 1.45 + 2, plus the 6px gap).
    const bodyHeight = 14 * 1.45 + 2;
    const bodyY = 300 + Math.max(14, (110 - (6 + bodyHeight)) / 2) + 6;
    expect(shapeByName(xml, "Block 2 box body")).toContain(`y="${Math.round(bodyY * 10160)}"`);
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
      '<a:off x="-254000" y="-304800"/><a:ext cx="1" cy="1"/>',
    );
    expect(xml).not.toMatch(/NaN|Infinity/);
    for (const match of xml.matchAll(/\b(?:x|y|cx|cy)="(-?\d+)"/g)) {
      expect(Math.abs(Number(match[1]))).toBeLessThanOrEqual(2147483647);
    }
  });
});

describe("Workspace Slides PPTX resource limits", () => {
  it("reports actionable slide-count and blocks-per-slide errors", () => {
    expect(() => deckToPptx({
      slides: Array.from({length: 501}, () => ({blocks: []})),
    })).toThrow("Deck has 501 slides; PowerPoint export supports at most 500");
    expect(() => deckToPptx(oneSlide(Array.from({length: 1001}, () => null))))
      .toThrow("Slide 1 has 1001 blocks; the export limit is 1000 per slide");
  });

  it("exports many references to one large text block without holding the deck text twice", async () => {
    // Structured-clone decks can alias one block object many times; the export must not build
    // per-character ropes over the resulting 7.9 MB of text.
    const shared = block("text", {text: "lorem ipsum & dolor <sit> amet ".repeat(3_225)}, {w: 760});
    expect(shared.props.text.length).toBeGreaterThan(99_000);
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
    const entries = (count: number) => Array.from({length: count}, (_, index) => `t${index}`).join(",");
    const title = (highlight: string) => oneSlide([block("title", {text: "t1", highlight})]);
    const error = "Slide 1, block 1 has too many comma-separated title highlight entries (maximum 128)";
    expect(() => deckToPptx(title(entries(128)))).not.toThrow();
    expect(() => deckToPptx(title(entries(129)))).toThrow(error);
    expect(() => deckToPptx(title(",".repeat(999_999)))).toThrow(error);
  });

  it("bounds highlight search work per title and per deck", () => {
    const terms = (count: number) => Array.from({length: count}, (_, index) => `term${index}`).join(",");
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

describe("Workspace Slides export handler", () => {
  it("publishes the exact HTML, PDF, and PowerPoint export metadata", async () => {
    await expect(handler().getExportFormats()).resolves.toEqual([
      {id: "html", label: "HTML", mode: "browser", contentType: "text/html", fileExtension: ".html"},
      {id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf"},
      {
        id: "pptx",
        label: "PowerPoint",
        mode: "server",
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        fileExtension: ".pptx",
      },
    ]);
  });

  it("rejects unknown IDs without reading the gadget", async () => {
    const gadget = {getDeck: vi.fn()};
    await expect(handler().export(gadget as never, "keynote")).rejects.toThrow(
      "Unsupported slides export format: keynote",
    );
    expect(gadget.getDeck).not.toHaveBeenCalled();
  });

  it("resolves and materializes getDeck before returning the PPTX stream", async () => {
    const deck = oneSlide([block("title", {text: "Materialized before streaming"})]);
    const gadget = {getDeck: vi.fn(async () => deck)};
    const stream = await handler().export(gadget as never, "pptx");
    expect(gadget.getDeck).toHaveBeenCalledTimes(1);

    gadget.getDeck.mockImplementation(async () => {
      throw new Error("borrowed capability reused during stream consumption");
    });
    const zip = await readZip(stream);
    expect(partText(zip, "ppt/slides/slide1.xml")).toContain("Materialized before streaming");
    expect(gadget.getDeck).toHaveBeenCalledTimes(1);
  });
});
