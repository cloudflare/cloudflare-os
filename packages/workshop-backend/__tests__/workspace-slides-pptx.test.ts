import { describe, expect, it, vi } from "vitest";
import { ExportHandler } from "../format-blueprints/workspace-slides/files/server.js";
import { deckToPptx } from "../format-blueprints/workspace-slides/files/pptx.js";
import { createZip, crc32 } from "../format-blueprints/workspace-slides/files/zip.js";

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

describe("Workspace Slides ZIP32", () => {
  it("writes deterministic descriptor-based deflate entries with valid CRCs", async () => {
    expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("streamed "));
        controller.enqueue(encoder.encode("content"));
        controller.close();
      },
    });

    const zip = await readZip(createZip([
      {name: "plain.txt", data: "hello"},
      {name: "nested/utf8-\u2603.txt", data: chunks},
    ]));

    expect(zip.names).toEqual(["plain.txt", "nested/utf8-\u2603.txt"]);
    expect(partText(zip, "plain.txt")).toBe("hello");
    expect(partText(zip, "nested/utf8-\u2603.txt")).toBe("streamed content");
  });

  it("rejects unsupported entry data through the ZIP reader", async () => {
    const reader = createZip([{name: "failure.txt", data: {unsupported: true}}]).getReader();
    await expect(reader.read()).resolves.toMatchObject({done: false}); // Local header.
    await expect(reader.read()).resolves.toMatchObject({done: false}); // Entry name.
    await expect(reader.read()).rejects.toThrow("ZIP entry data must be text, bytes, or a byte stream");
  });
});

describe("Workspace Slides PPTX package", () => {
  it("emits a deterministic, complete OOXML package and internal relationship graph", async () => {
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
    const repeat = await readZip(deckToPptx(deck));

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
    expect(repeat.archive).toEqual(zip.archive);

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
  it("converts CSS pixels, assigns deterministic IDs, and preserves expanded-block z-order", async () => {
    const deck = oneSlide([
      block("shape", {fill: "#123456"}, {x: 1.25, y: 2.5, w: 3, h: 4}),
      block("title", {text: "Sized", fontSize: 20, letterSpacing: "2px", lineHeight: 1.25}, {x: 5, y: 6, w: 100, h: 30}),
      block("card", {eyebrow: "top", title: "Card", body: "Body"}, {x: 10, y: 20, w: 200, h: 160}),
      block("shape", {fill: "#654321"}, {x: 30, y: 40, w: 50, h: 60}),
    ]);
    const first = await readZip(deckToPptx(deck));
    const second = await readZip(deckToPptx(deck));
    const xml = partText(first, "ppt/slides/slide1.xml");
    expect(partText(second, "ppt/slides/slide1.xml")).toBe(xml);

    expect(shapeByName(xml, "Block 1 shape")).toContain(
      '<a:off x="12700" y="25400"/><a:ext cx="30480" cy="40640"/>',
    );
    const title = shapeByName(xml, "Block 2 title");
    expect(title).toContain('<a:off x="50800" y="60960"/><a:ext cx="1016000" cy="304800"/>');
    expect(title).toContain('sz="1600"');
    expect(title).toContain('spc="160"');
    expect(title).toContain('<a:latin typeface="Arial"/>');
    expect(title).not.toContain('typeface="Inter"');
    expect(title).toContain('<a:spcPct val="125000"/>');

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

    expect(shapeByName(xml, "Block 1 logo wordmark")).toContain('<a:bodyPr wrap="none"');
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
    expect(title).toContain('<a:spcPct val="125000"/>');
    const aligned = shapeByName(xml, "Block 6 text");
    expect(aligned).toContain('<a:pPr algn="r"');
    expect(aligned).toContain('<a:spcPct val="200000"/>');
    expect(aligned).toContain('sz="1280"');

    const bullets = shapeByName(xml, "Block 7 bulletList");
    for (const item of ["one", "two", "three", "four", "five", "six"]) {
      expect(bullets).toContain(`>${item}</a:t>`);
    }
    expect(bullets).not.toContain(">seven</a:t>");
    expect(occurrences(bullets, '<a:buChar char="&#x25CF;"/>')).toBe(6);
    expect(shapeByName(xml, "Block 9 box surface")).toContain('<a:prstDash val="dash"/>');
    expect(shapeByName(xml, "Block 10 tonePill")).toContain(">STATUS</a:t>");
    expect(shapeByName(xml, "Block 11 divider")).toContain('<a:alpha val="25000"/>');

    const ellipse = shapeByName(xml, "Block 12 shape");
    expect(ellipse).toContain('<a:prstGeom prst="ellipse">');
    expect(ellipse).toContain('<a:srgbClr val="123456"><a:alpha val="25098"/>');
    expect(ellipse).toContain('<a:ln w="20320" cap="rnd"><a:solidFill><a:srgbClr val="ABCDEF"><a:alpha val="50000"/>');
    expect(shapeByName(xml, "Block 13 shape")).toContain('<a:gd name="adj" fmla="val 20000"/>');
    const arrow = shapeByName(xml, "Block 16 arrow");
    expect(arrow).toContain('<a:prstDash val="dash"/>');
    expect(arrow).toContain('<a:tailEnd type="triangle" w="sm" len="sm"/>');
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
    const brandBar = '<svg viewBox="0 0 1200 12"><stop stop-color="#FF6633"/>' +
      '<stop stop-color="#F6821F"/><stop stop-color="#FBAD41"/></svg>';
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

  it("uses visible native placeholders for unavailable images, arbitrary SVG, and unknown blocks", async () => {
    const zip = await readZip(deckToPptx(oneSlide([
      block("image", {}),
      block("image", {src: "https://example.com/image.png"}),
      block("image", {src: "data:image/png;base64,AAAA"}),
      block("image", {src: dataUrl("jpeg", jpegWithoutScan(2, 4))}),
      block("image", {src: "data:image/gif;base64,R0lGODlh"}),
      block("svg", {markup: "<svg><circle/></svg>", background: "#fff4e6"}),
      block("not-a-real-block", {}),
    ])));
    const xml = partText(zip, "ppt/slides/slide1.xml");

    for (const placeholder of [
      "No image",
      "Remote image not included",
      "Malformed image data",
      "Unsupported or malformed image",
      "SVG not included in PowerPoint export",
      "?: not-a-real-block",
    ]) expect(xml).toContain(placeholder);
    expect(occurrences(xml, "Malformed image data")).toBe(2);
    expect(xml).not.toContain("<p:pic>");
    expect(zip.names.some(name => name.startsWith("ppt/media/"))).toBe(false);
    expect(partText(zip, "ppt/slides/_rels/slide1.xml.rels")).not.toContain("/image");
    for (const name of zip.names.filter(entryName => entryName.endsWith(".rels"))) {
      expect(partText(zip, name)).not.toContain("TargetMode");
    }
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

  it("reports aggregate text and line-break limits", () => {
    const millionCharacters = "x".repeat(1_000_000);
    expect(() => deckToPptx(oneSlide(Array.from({length: 8}, () =>
      block("text", {text: millionCharacters})))))
      .toThrow("Deck text is too large for PowerPoint export (maximum 8000000 characters total)");

    const tenThousandLines = "x\n".repeat(10_000);
    expect(() => deckToPptx(oneSlide(Array.from({length: 6}, () =>
      block("text", {text: tenThousandLines})))))
      .toThrow("Deck text has too many line breaks for PowerPoint export (maximum 50000 total)");
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
