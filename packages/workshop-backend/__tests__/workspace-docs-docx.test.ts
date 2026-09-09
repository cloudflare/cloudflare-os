import { describe, expect, it, vi } from "vitest";
import { DOCX_LIMITS, documentToDocx } from "../format-blueprints/workspace-docs/files/docx.js";
import { ExportHandler } from "../format-blueprints/workspace-docs/files/server.js";
import { createZip, crc32 } from "../format-blueprints/workspace-docs/files/zip.js";

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

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function uint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new Response(bytes).body!.pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(input).arrayBuffer());
}

async function readZip(stream: ReadableStream<Uint8Array>) {
  const archive = await streamBytes(stream);
  const eocdOffset = archive.byteLength - 22;
  expect(uint32(archive, eocdOffset)).toBe(0x06054b50);
  expect(uint16(archive, eocdOffset + 4)).toBe(0);
  expect(uint16(archive, eocdOffset + 6)).toBe(0);
  const entryCount = uint16(archive, eocdOffset + 10);
  expect(uint16(archive, eocdOffset + 8)).toBe(entryCount);
  const centralSize = uint32(archive, eocdOffset + 12);
  const centralOffset = uint32(archive, eocdOffset + 16);
  expect(centralOffset + centralSize).toBe(eocdOffset);

  const entries = new Map<string, ZipEntry>();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; ++index) {
    expect(uint32(archive, offset)).toBe(0x02014b50);
    const flags = uint16(archive, offset + 8);
    const method = uint16(archive, offset + 10);
    const crc = uint32(archive, offset + 16);
    const compressedSize = uint32(archive, offset + 20);
    const uncompressedSize = uint32(archive, offset + 24);
    const nameLength = uint16(archive, offset + 28);
    const extraLength = uint16(archive, offset + 30);
    const commentLength = uint16(archive, offset + 32);
    const localOffset = uint32(archive, offset + 42);
    const name = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength));

    expect(entries.has(name), name).toBe(false);
    expect(uint32(archive, localOffset)).toBe(0x04034b50);
    expect(uint16(archive, localOffset + 6)).toBe(flags);
    expect(uint16(archive, localOffset + 8)).toBe(method);
    expect(uint16(archive, localOffset + 10)).toBe(0);
    expect(uint16(archive, localOffset + 12)).toBe(33);
    expect(uint32(archive, localOffset + 14)).toBe(0);
    expect(uint32(archive, localOffset + 18)).toBe(0);
    expect(uint32(archive, localOffset + 22)).toBe(0);
    const localNameLength = uint16(archive, localOffset + 26);
    const localExtraLength = uint16(archive, localOffset + 28);
    expect(decoder.decode(archive.subarray(localOffset + 30, localOffset + 30 + localNameLength))).toBe(name);

    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    const descriptorOffset = dataOffset + compressedSize;
    expect(uint32(archive, descriptorOffset)).toBe(0x08074b50);
    expect(uint32(archive, descriptorOffset + 4)).toBe(crc);
    expect(uint32(archive, descriptorOffset + 8)).toBe(compressedSize);
    expect(uint32(archive, descriptorOffset + 12)).toBe(uncompressedSize);

    const bytes = await inflate(compressed);
    expect(bytes.byteLength).toBe(uncompressedSize);
    expect(crc32(bytes)).toBe(crc);
    entries.set(name, {bytes, compressedSize, crc, flags, localOffset, method, uncompressedSize});
    offset += 46 + nameLength + extraLength + commentLength;
  }
  expect(offset).toBe(eocdOffset);
  return {archive, entries};
}

function text(entries: Map<string, ZipEntry>, name: string): string {
  const entry = entries.get(name);
  expect(entry, name).toBeDefined();
  return decoder.decode(entry!.bytes);
}

function block(html: string, id = "block") {
  return {id, html, version: 1};
}

function handler(): ExportHandler {
  return Object.create(ExportHandler.prototype) as ExportHandler;
}

function binaryString(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${btoa(binaryString(bytes))}`;
}

function setUint32be(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint32(offset, value, false);
}

function pngChunk(kind: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(data.length + 12);
  setUint32be(bytes, 0, data.length);
  bytes.set(encoder.encode(kind), 4);
  bytes.set(data, 8);
  setUint32be(bytes, data.length + 8, crc32(bytes.subarray(4, data.length + 8)));
  return bytes;
}

function png(width: number, height: number, ancillaryBytes = 0): Uint8Array {
  const header = new Uint8Array(13);
  setUint32be(header, 0, width);
  setUint32be(header, 4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const ancillary = new Uint8Array(ancillaryBytes);
  if (ancillaryBytes) ancillary.set(encoder.encode("Comment\0"));
  const chunks = [pngChunk("IHDR", header)];
  if (ancillaryBytes) chunks.push(pngChunk("tEXt", ancillary));
  chunks.push(pngChunk("IDAT", Uint8Array.from([0])), pngChunk("IEND", new Uint8Array()));
  const bytes = new Uint8Array(8 + chunks.reduce((total, chunk) => total + chunk.length, 0));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff,
    0xff, 0xda, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xd9,
  ]);
}

function gif(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...encoder.encode("GIF89a"), width & 0xff, width >> 8, height & 0xff, height >> 8, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, width & 0xff, width >> 8, height & 0xff, height >> 8, 0x00, 0x02, 0x01, 0x00, 0x00,
    0x3b,
  ]);
}

function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(48);
  bytes.set(encoder.encode("RIFF"), 0);
  new DataView(bytes.buffer).setUint32(4, 40, true);
  bytes.set(encoder.encode("WEBPVP8X"), 8);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  bytes.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  bytes.set(encoder.encode("VP8 "), 30);
  new DataView(bytes.buffer).setUint32(34, 10, true);
  bytes.set([0, 0, 0, 0x9d, 0x01, 0x2a, width & 0xff, width >> 8, height & 0xff, height >> 8], 38);
  return bytes;
}

function runContaining(xml: string, value: string): string {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
      `<w:r>(?:(?!</w:r>)[\\s\\S])*?<w:t[^>]*>${escaped}</w:t>(?:(?!</w:r>)[\\s\\S])*</w:r>`).exec(xml);
  expect(match, value).not.toBeNull();
  return match![0];
}

describe("Workspace Docs streaming ZIP32", () => {
  it("emits deterministic descriptor-based entries with valid CRCs, offsets, and sizes", async () => {
    expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("streamed "));
        controller.enqueue(encoder.encode("content"));
        controller.close();
      },
    });
    const first = await readZip(createZip([
      {name: "plain.txt", data: "hello"},
      {name: "nested/utf8-\u2603.txt", data: chunks},
    ]));
    const second = await readZip(createZip([
      {name: "plain.txt", data: "hello"},
      {name: "nested/utf8-\u2603.txt", data: "streamed content"},
    ]));

    expect([...first.entries.keys()]).toEqual(["plain.txt", "nested/utf8-\u2603.txt"]);
    expect(text(first.entries, "plain.txt")).toBe("hello");
    expect(text(first.entries, "nested/utf8-\u2603.txt")).toBe("streamed content");
    expect(first.archive).toEqual(second.archive);
    for (const entry of first.entries.values()) {
      expect(entry.flags).toBe(0x0808);
      expect(entry.method).toBe(8);
      expect(entry.compressedSize).toBeGreaterThan(0);
    }
  });
});

describe("Workspace Docs DOCX package", () => {
  it("emits required parts, content types, and a complete internal relationship graph", async () => {
    const {entries} = await readZip(await documentToDocx({
      title: "Package",
      blocks: [block('<ol><li><a href="https://example.com?a=1&amp;b=2">link</a></li></ol>')],
    }));
    expect([...entries.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "docProps/app.xml",
      "word/document.xml",
      "word/styles.xml",
      "word/numbering.xml",
      "word/_rels/document.xml.rels",
    ]);
    const types = text(entries, "[Content_Types].xml");
    for (const part of ["/word/document.xml", "/word/styles.xml", "/word/numbering.xml", "/docProps/core.xml", "/docProps/app.xml"]) {
      expect(types).toContain(`PartName="${part}"`);
    }
    const rootRels = text(entries, "_rels/.rels");
    for (const target of ["word/document.xml", "docProps/core.xml", "docProps/app.xml"]) {
      expect(rootRels).toContain(`Target="${target}"`);
      expect(entries.has(target)).toBe(true);
    }
    const documentRels = text(entries, "word/_rels/document.xml.rels");
    for (const target of ["styles.xml", "numbering.xml"]) {
      expect(documentRels).toContain(`Target="${target}"`);
      expect(entries.has(`word/${target}`)).toBe(true);
    }
    expect(documentRels).toContain('Target="https://example.com/?a=1&amp;b=2" TargetMode="External"');
  });

  it("generates byte-identical DOCX packages for the same semantic snapshot", async () => {
    const image = dataUrl("image/png", png(2, 1));
    const document = {
      title: "Deterministic",
      lastModified: 1_700_000_000_000,
      blocks: [block(`<ol><li><a href="https://example.com">link</a><img src="${image}" alt="image"></li></ol>`)],
    };
    expect(await streamBytes(await documentToDocx(document))).toEqual(await streamBytes(await documentToDocx(document)));
  });

  it("exports empty, malformed, v2, and legacy snapshots as valid documents", async () => {
    for (const document of [
      {},
      {blocks: "not-an-array", legacyContent: "<p>Legacy fallback</p>"},
      {blocks: [null, block("<p>V2 block</p>")]},
      {blocks: [block("<p>before<b>bold<p>after<unknown>visible")]},
    ]) {
      const {entries} = await readZip(await documentToDocx(document));
      const xml = text(entries, "word/document.xml");
      expect(xml).toContain("<w:body><w:p>");
      expect(xml).toContain("<w:sectPr>");
      expect(xml).toContain("</w:body></w:document>");
    }
    const legacy = await readZip(await documentToDocx({blocks: null, legacyContent: "<p>Old document</p>"}));
    expect(text(legacy.entries, "word/document.xml")).toContain("Old document");

    const optionalEnds = await readZip(await documentToDocx({blocks: [block("<p>one<p>two")] }));
    const optionalXml = text(optionalEnds.entries, "word/document.xml");
    expect(optionalXml.match(/<w:p>/g)).toHaveLength(2);
    expect(optionalXml).toContain(">one</w:t>");
    expect(optionalXml).toContain(">two</w:t>");

    const emptyBlocks = await readZip(await documentToDocx({blocks: [block("<p>A</p><p></p><h2> </h2><div></div><p>B</p>")]}));
    expect(text(emptyBlocks.entries, "word/document.xml").match(/<w:p>/g)).toHaveLength(4);

    const isolatedBlocks = await readZip(await documentToDocx({blocks: [
      block("<script>unterminated", "first"), block("<p>still visible</p>", "second"),
    ]}));
    expect(text(isolatedBlocks.entries, "word/document.xml")).toContain("still visible");
  });

  it("uses the persisted title and valid modified time without inventing an author or body title", async () => {
    const {entries} = await readZip(await documentToDocx({
      title: "R&D <Plan>",
      lastModified: 1_700_000_000_000,
      blocks: [block("<p>Body only</p>")],
    }));
    const core = text(entries, "docProps/core.xml");
    expect(core).toContain("<dc:title>R&amp;D &lt;Plan&gt;</dc:title>");
    expect(core).toContain('<dcterms:modified xsi:type="dcterms:W3CDTF">2023-11-14T22:13:20.000Z</dcterms:modified>');
    expect(core).not.toMatch(/creator|author/i);
    expect(text(entries, "word/document.xml")).not.toContain("R&amp;D");

    const invalid = await readZip(await documentToDocx({lastModified: "not-a-date"}));
    expect(text(invalid.entries, "docProps/core.xml")).not.toContain("dcterms:modified");
  });

  it("maps paragraphs, titles, and headings to stable semantic styles", async () => {
    const html = '<p>normal</p><h1 class="doc-title">title</h1><h1>one</h1><h2>two</h2>' +
      "<h3>three</h3><h4>four</h4><h5>five</h5><h6>six</h6><div>division</div>";
    const {entries} = await readZip(await documentToDocx({blocks: [block(html)]}));
    const xml = text(entries, "word/document.xml");
    for (const [style, value] of [
      ["Normal", "normal"], ["Title", "title"], ["Heading1", "one"], ["Heading2", "two"],
      ["Heading3", "three"], ["Heading3", "four"], ["Heading3", "five"], ["Heading3", "six"],
      ["Normal", "division"],
    ]) {
      expect(xml).toContain(`<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${value}</w:t>`);
    }
    const styles = text(entries, "word/styles.xml");
    for (const id of ["Normal", "Title", "Heading1", "Heading2", "Heading3", "Quote", "CodeBlock", "Hyperlink"]) {
      expect(styles).toContain(`w:styleId="${id}"`);
    }
    expect(styles).toContain('<w:sz w:val="22"/>');
    expect(styles).toContain('w:line="360" w:lineRule="auto"');
  });

  it("preserves semantic emphasis, nested CSS inheritance, and explicit formatting resets", async () => {
    const html = '<p><b>bold<span style="font-weight:normal">reset</span></b>' +
      '<i>italic<span style="font-style:normal">upright</span></i><u>under</u><s>strike</s>' +
      '<span style="text-decoration:underline line-through"><span>nested</span>' +
      '<span style="text-decoration:none">plain</span></span>' +
      '<span style="color:rgba(255,0,0,0);background-color:#f000">clear</span>' +
      '<span style="background-color:#ff0000"><span style="background-color:rgba(0,0,0,0)">unshaded</span></span></p>';
    const {entries} = await readZip(await documentToDocx({blocks: [block(html)]}));
    const xml = text(entries, "word/document.xml");
    expect(runContaining(xml, "bold")).toContain("<w:b/>");
    expect(runContaining(xml, "reset")).toContain('<w:b w:val="0"/>');
    expect(runContaining(xml, "italic")).toContain("<w:i/>");
    expect(runContaining(xml, "upright")).toContain('<w:i w:val="0"/>');
    expect(runContaining(xml, "under")).toContain('<w:u w:val="single"/>');
    expect(runContaining(xml, "strike")).toContain("<w:strike/>");
    expect(runContaining(xml, "nested")).toContain('<w:u w:val="single"/>');
    expect(runContaining(xml, "nested")).toContain("<w:strike/>");
    expect(runContaining(xml, "plain")).toContain('<w:u w:val="none"/>');
    expect(runContaining(xml, "plain")).toContain('<w:strike w:val="0"/>');
    expect(runContaining(xml, "clearunshaded")).not.toMatch(/w:color|w:shd/);

    const inherited = await readZip(await documentToDocx({blocks: [block(
        '<p><span style="font-weight:bold;font-size:20px;color:#123456">' +
        '<span style="font-weight:unset;font-size:unset;color:unset">inherited</span></span></p>')]}));
    const inheritedRun = runContaining(text(inherited.entries, "word/document.xml"), "inherited");
    expect(inheritedRun).toContain("<w:b/>");
    expect(inheritedRun).toContain('<w:sz w:val="30"/>');
    expect(inheritedRun).toContain('<w:color w:val="123456"/>');
  });

  it("converts font, size, color, shading, alignment, indentation, and line height", async () => {
    const html = '<p style="text-align:center;margin-left:16px;text-indent:8px;line-height:2">' +
      '<span style="font-family:Georgia, serif;font-size:16px;color:rgb(17, 34, 51);background-color:#fff3a3">styled</span>' +
      '<font face="Courier New" size="5" color="#abc">font</font>' +
      '<span style="text-align:right;margin-left:100px">inline</span></p>' +
      '<div style="line-height:2;margin-left:40px;margin-left:0"><p style="line-height:normal;margin:0 0 0 8px;margin-left:16px;margin-left:bogus">cascade</p><p style="margin-left:16px;margin-left:auto">auto</p><p style="padding-left:16px;padding-left:auto">pad</p></div>';
    const {entries} = await readZip(await documentToDocx({blocks: [block(html)]}));
    const xml = text(entries, "word/document.xml");
    expect(xml).toContain('<w:spacing w:line="480" w:lineRule="auto"/>');
    expect(xml).toContain('<w:ind w:left="240" w:firstLine="120"/>');
    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(xml).not.toContain('w:val="right"');
    expect(xml).toContain(">inline</w:t>");
    expect(xml).toContain('<w:pPr><w:pStyle w:val="Normal"/><w:ind w:left="240"/></w:pPr><w:r><w:t xml:space="preserve">cascade</w:t>');
    expect(xml).toContain('<w:spacing w:line="480" w:lineRule="auto"/><w:ind w:left="0"/></w:pPr><w:r><w:t xml:space="preserve">auto</w:t>');
    expect(xml).toContain('<w:spacing w:line="480" w:lineRule="auto"/><w:ind w:left="240"/></w:pPr><w:r><w:t xml:space="preserve">pad</w:t>');
    const styled = runContaining(xml, "styled");
    expect(styled).toContain('w:ascii="Georgia"');
    expect(styled).toContain('<w:sz w:val="24"/>');
    expect(styled).toContain('<w:color w:val="112233"/>');
    expect(styled).toContain('w:fill="FFF3A3"');
    const font = runContaining(xml, "font");
    expect(font).toContain('w:ascii="Courier New"');
    expect(font).toContain('<w:sz w:val="36"/>');
    expect(font).toContain('<w:color w:val="AABBCC"/>');
  });

  it("escapes XML, decodes entities, replaces invalid text, and preserves significant whitespace and breaks", async () => {
    const html = "<p>  A &amp; &lt; B   C<br>line\nbreak&nbsp;x &copy; &mdash; &hellip; " +
      "&CounterClockwiseContourIntegral; &NotEqualTilde;\u0001\ud800</p>";
    const {entries} = await readZip(await documentToDocx({blocks: [block(html)]}));
    const xml = text(entries, "word/document.xml");
    expect(xml).toContain('<w:t xml:space="preserve">A &amp; &lt; B C</w:t>');
    expect(xml).toContain("<w:r><w:br/></w:r>");
    expect(xml).toContain("line break\u00a0x © — … ∳ ≂̸\ufffd\ufffd");
    expect(xml).toContain("© — … ∳ ≂̸");
    expect(xml).not.toMatch(/&amp;(?:copy|mdash|hellip|CounterClockwiseContourIntegral|NotEqualTilde);/);
    expect(xml).not.toContain("\u0001");
    expect(xml).not.toContain("\ud800");
  });

  it("keeps empty lines as empty paragraphs and drops only the final break of a block", async () => {
    const {entries} = await readZip(await documentToDocx({blocks: [block(
        "<p>one<br></p><p><br></p><p>two<br> <b>three</b></p><p>four<br><br></p>")]}));
    const xml = text(entries, "word/document.xml");
    expect(xml.match(/<w:p>/g)).toHaveLength(4);
    expect(xml).toContain('<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr></w:p>');
    expect(xml.match(/<w:br\/>/g)).toHaveLength(2);
    expect(xml).toContain(">one</w:t></w:r></w:p>");
    expect(xml).toContain('<w:r><w:br/></w:r><w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">three</w:t>');
    expect(xml).toContain(">four</w:t></w:r><w:r><w:br/></w:r></w:p>");
  });

  it("recovers unclosed headings and anchors the way the browser parser does", async () => {
    const {entries} = await readZip(await documentToDocx({blocks: [block(
        '<h1>Title<h2>Sub</h2><p>Body</p><p><a href="https://a.example">one<a href="https://b.example">two</a>three</p>')]}));
    const xml = text(entries, "word/document.xml");
    expect(xml).toContain('<w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">Title</w:t>');
    expect(xml).toContain('<w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t xml:space="preserve">Sub</w:t>');
    expect(xml).toContain('<w:pStyle w:val="Normal"/></w:pPr><w:r><w:t xml:space="preserve">Body</w:t>');
    expect(xml).toMatch(/<w:hyperlink r:id="rId3"[^>]*><w:r>[^]*?>one<\/w:t><\/w:r><\/w:hyperlink><w:hyperlink r:id="rId4"[^>]*><w:r>[^]*?>two<\/w:t><\/w:r><\/w:hyperlink><w:r><w:t xml:space="preserve">three<\/w:t>/);
  });

  it("maps quotes, code blocks, inline code, and horizontal rules", async () => {
    const html = '<blockquote>quoted</blockquote><pre>\n a  b\n\tc\n</pre><p>use <code>code</code></p><hr>' +
      "<ul><li><hr></li><li>item<hr></li></ul>";
    const {entries} = await readZip(await documentToDocx({blocks: [block(html)]}));
    const xml = text(entries, "word/document.xml");
    expect(xml).toContain('<w:pStyle w:val="Quote"/>');
    expect(xml).toContain('<w:pStyle w:val="CodeBlock"/>');
    expect(xml).toContain('<w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr><w:r><w:t xml:space="preserve"> a  b</w:t>' +
      '<w:br/><w:tab/><w:t xml:space="preserve">c</w:t></w:r></w:p>');
    expect(runContaining(xml, "code")).toContain('w:ascii="Courier New"');
    expect(xml.match(/<w:bottom w:val="single"/g)).toHaveLength(3);
    expect(xml.match(/<w:p>/g)).toHaveLength(7);
    expect(xml).toContain('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:pBdr>');
    expect(xml).toContain('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D9D9D9"/></w:pBdr><w:spacing w:before="330" w:after="330"/><w:ind w:left="420"/>');
  });

  it("preserves paragraph structure inside semantic quotes", async () => {
    const {entries} = await readZip(await documentToDocx({blocks: [block(
        "<blockquote><p>first</p><p>second</p><ul><li>third</li></ul></blockquote>")]}));
    const xml = text(entries, "word/document.xml");
    expect(xml.match(/<w:p>/g)).toHaveLength(3);
    expect(xml.match(/<w:pStyle w:val="Quote"\/>/g)).toHaveLength(3);
    expect(xml).toContain('<w:ilvl w:val="0"/><w:numId w:val="1"/>');
    expect(xml).not.toContain("<w:br/>");
  });

  it("preserves semantic quote paragraphs inside list items", async () => {
    const {entries} = await readZip(await documentToDocx({blocks: [block(
        "<ol><li><section><blockquote><p>first</p><p>second</p></blockquote></section></li>" +
        "<li><div><ul><li><p>nested</p><p>continued</p></li></ul></div></li></ol>")]}));
    const xml = text(entries, "word/document.xml");
    expect(xml.match(/<w:p>/g)).toHaveLength(5);
    expect(xml.match(/<w:pStyle w:val="Quote"\/>/g)).toHaveLength(2);
    expect(xml.match(/<w:numPr>/g)).toHaveLength(3);
    expect(xml.match(/<w:ilvl w:val="0"\/><w:numId w:val="1"\/>/g)).toHaveLength(2);
    expect(xml).toContain('<w:ilvl w:val="1"/><w:numId w:val="2"/>');
    expect(xml).toContain('<w:pStyle w:val="Quote"/><w:ind w:left="420"/>');
    expect(xml).toContain('<w:pStyle w:val="Normal"/><w:ind w:left="840"/>');
    expect(xml).not.toContain("<w:br/>");
  });

  it("maps editor indentation blockquotes to indentation without quote styling", async () => {
    const html = '<blockquote style="margin: 0 0 0 40px; border: none; padding: 0px;">indented</blockquote>' +
      '<blockquote style="margin: 0 0 0 40px; border: none; padding: 0px;">outer' +
      '<blockquote style="margin: 0 0 0 40px; border: none; padding: 0px;">inner</blockquote></blockquote>' +
      '<blockquote style="margin-left:60px;border-left:none">custom</blockquote>' +
      '<blockquote style="margin-left:40px">quoted indent</blockquote>' +
      '<blockquote style="border:none;border-left:3px solid red">bordered again</blockquote>' +
      '<blockquote style="margin-left:40px;border:none;border:bogus">still indented</blockquote>' +
      '<blockquote style="margin-left:40px;border-left:red solid 2px;border:2px">width only</blockquote>' +
      "<blockquote>quoted</blockquote>";
    const {entries} = await readZip(await documentToDocx({blocks: [block(html)]}));
    const xml = text(entries, "word/document.xml");
    expect(runContaining(xml, "indented")).toBeDefined();
    expect(xml).toContain('<w:pStyle w:val="Normal"/><w:ind w:left="600"/>');
    expect(xml).toContain('<w:pStyle w:val="Normal"/><w:ind w:left="1200"/>');
    expect(xml).toContain('<w:pStyle w:val="Normal"/><w:ind w:left="900"/>');
    expect(xml).toContain('<w:pStyle w:val="Quote"/><w:ind w:left="600"/>');
    expect(xml.match(/<w:pStyle w:val="Quote"/g)).toHaveLength(3);
    expect(xml.match(/<w:pStyle w:val="Normal"\/><w:ind w:left="600"\/>/g)).toHaveLength(4);
  });

  it("creates native mixed nested lists and separate numbering instances for restarts", async () => {
    const html = "<ol><li>one<ul><li>bullet<ol><li>deep</li></ol></li></ul></li><li>two</li></ol>" +
      "<ol><li>restart</li></ol>";
    const {entries} = await readZip(await documentToDocx({blocks: [block(html)]}));
    const xml = text(entries, "word/document.xml");
    const numbering = text(entries, "word/numbering.xml");
    expect(numbering.match(/<w:abstractNum /g)).toHaveLength(2);
    expect(numbering.match(/<w:num w:numId=/g)).toHaveLength(4);

    const emptyLists = await readZip(await documentToDocx({blocks: [block("<ol></ol><ul> </ul><p>text</p>")]}));
    expect(emptyLists.entries.has("word/numbering.xml")).toBe(false);
    expect(numbering).toContain('<w:num w:numId="1"><w:abstractNumId w:val="1"/>');
    expect(numbering).toContain('<w:num w:numId="2"><w:abstractNumId w:val="0"/>');
    expect(numbering).toContain('<w:num w:numId="4"><w:abstractNumId w:val="1"/>');
    expect(numbering).toContain('<w:lvlText w:val="&#x25E6;"/>');
    expect(numbering).not.toContain('<w:lvlText w:val="o"/>');
    expect(xml).toContain('<w:ilvl w:val="0"/><w:numId w:val="1"/>');
    expect(xml).toContain('<w:ilvl w:val="1"/><w:numId w:val="2"/>');
    expect(xml).toContain('<w:ilvl w:val="2"/><w:numId w:val="3"/>');
    expect(xml).toContain('<w:ilvl w:val="0"/><w:numId w:val="4"/>');
    expect(xml).not.toMatch(/<w:t[^>]*>[\u2022\u25aa]|<w:t[^>]*>\d+\. /);
  });

  it("preserves ordered-list start, item value overrides, and type formats", async () => {
    const {entries} = await readZip(await documentToDocx({blocks: [block(
        '<ol start="4"><li>four</li><li value="7">seven</li><li>eight</li></ol>' +
        '<ol type="a"><li>a</li></ol><ol type="I"><li>I</li></ol>')]}));
    const xml = text(entries, "word/document.xml");
    const numbering = text(entries, "word/numbering.xml");
    expect(numbering).toContain('<w:num w:numId="1"><w:abstractNumId w:val="1"/>' +
      '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="4"/></w:lvlOverride></w:num>');
    expect(numbering).toContain('<w:num w:numId="2"><w:abstractNumId w:val="1"/>' +
      '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="7"/></w:lvlOverride></w:num>');
    expect(numbering).toContain('<w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="multilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/>');
    expect(numbering).toContain('<w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num>');
    expect(numbering).toContain('<w:numFmt w:val="upperRoman"/>');
    expect(numbering).toContain('<w:num w:numId="4"><w:abstractNumId w:val="5"/></w:num>');
    expect(numbering).not.toContain('w:abstractNumId="0"');
    expect(xml.match(/<w:numId w:val="1"\/>/g)).toHaveLength(1);
    expect(xml.match(/<w:numId w:val="2"\/>/g)).toHaveLength(2);
  });

  it("preserves inline content order around nested lists", async () => {
    const {entries} = await readZip(await documentToDocx({blocks: [block(
        "<ul><li>before<ul><li>nested</li></ul>after</li></ul>")]}));
    const xml = text(entries, "word/document.xml");
    const positions = ["before", "nested", "after"].map((value) => xml.indexOf(`>${value}</w:t>`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(positions[1]).toBeLessThan(positions[2]);
    expect(xml.match(/<w:numPr>/g)).toHaveLength(2);
    expect(xml).toContain('<w:ind w:left="420"/>');
  });

  it("creates and deduplicates only safe external hyperlink relationships", async () => {
    const html = '<p><a href="https://example.com/p?a=1&amp;b=two">one</a>' +
      '<a href="https://example.com/p?a=1&amp;b=two">two</a>' +
      '<a href="mailto:test@example.com">mail</a><a href="tel:+15551212">phone</a>' +
      '<a href="/relative">relative</a><a href="#fragment">fragment</a>' +
      '<a href="javascript:alert(1)">active</a><a href="data:text/html,hi">data</a></p>';
    const {entries} = await readZip(await documentToDocx({blocks: [block(html)]}));
    const xml = text(entries, "word/document.xml");
    const rels = text(entries, "word/_rels/document.xml.rels");
    expect(rels.match(/relationships\/hyperlink/g)).toHaveLength(3);
    expect(rels).toContain('Target="https://example.com/p?a=1&amp;b=two" TargetMode="External"');
    expect(rels).toContain('Target="mailto:test@example.com" TargetMode="External"');
    expect(rels).toContain('Target="tel:+15551212" TargetMode="External"');
    expect(xml.match(/r:id="rId3"/g)).toHaveLength(1);
    for (const visible of ["relative", "fragment", "active", "data"]) expect(xml).toContain(visible);
    expect(xml.match(/<w:hyperlink /g)).toHaveLength(3);
  });

  it("embeds validated PNG, JPEG, GIF, and WebP images with dimensions, deduplication, clamping, and alt text", async () => {
    const pngUrl = dataUrl("image/png", png(1000, 500));
    const jpegUrl = dataUrl("image/jpeg", jpeg(64, 32));
    const gifUrl = dataUrl("image/gif", gif(20, 10));
    const webpUrl = dataUrl("image/webp", webp(30, 15));
    const html = `<p><img src="${pngUrl}" alt="A &amp; B" style="width:800px;width:bogus">` +
      `<img src="${pngUrl}" alt="repeat" width="50%"><img src="${jpegUrl}" alt="jpeg">` +
      `<img src="${gifUrl}" alt="gif"><img src="${webpUrl}" alt="webp"></p>`;
    const {entries} = await readZip(await documentToDocx({blocks: [block(html)]}));
    expect([...entries.keys()].filter((name) => name.startsWith("word/media/"))).toEqual([
      "word/media/image1.png", "word/media/image2.jpg", "word/media/image3.gif", "word/media/image4.webp",
    ]);
    const types = text(entries, "[Content_Types].xml");
    for (const [extension, mime] of [["png", "image/png"], ["jpg", "image/jpeg"], ["gif", "image/gif"], ["webp", "image/webp"]]) {
      expect(types).toContain(`Extension="${extension}" ContentType="${mime}"`);
    }
    const xml = text(entries, "word/document.xml");
    expect(xml).toContain('<wp:extent cx="6583680" cy="3291840"/>');
    expect(xml).toContain('<wp:extent cx="3291840" cy="1645920"/>');
    expect(xml).toContain('descr="A &amp; B"');
    expect(xml.match(/r:embed="rId3"/g)).toHaveLength(2);
    expect(text(entries, "word/_rels/document.xml.rels").match(/relationships\/image/g)).toHaveLength(4);

    const tallUrl = dataUrl("image/png", png(1, 16384));
    const tall = await readZip(await documentToDocx({blocks: [block(`<img src="${tallUrl}" alt="tall">`)]}));
    expect(text(tall.entries, "word/document.xml")).toContain('cy="8869680"');
  });

  it("accepts the editor JPEG alias and embeds images larger than the parser buffer", async () => {
    const jpgUrl = dataUrl("image/jpg", jpeg(2, 1));
    const largeUrl = dataUrl("image/png", png(1, 1, 2_400_000));
    expect(largeUrl.length).toBeGreaterThan(3 * 1024 * 1024);
    const {entries} = await readZip(await documentToDocx({blocks: [block(
        `<p><img src="${jpgUrl}" alt="&copy;"><img src="${largeUrl}" alt="large">` +
        `<img src="${largeUrl}" alt="repeated"></p>`)]}));
    expect(entries.has("word/media/image1.jpg")).toBe(true);
    expect(entries.has("word/media/image2.png")).toBe(true);
    expect(entries.has("word/media/image3.png")).toBe(false);
    expect(text(entries, "[Content_Types].xml")).toContain('Extension="jpg" ContentType="image/jpeg"');
    expect(text(entries, "word/document.xml")).toContain('descr="©"');
  });

  it("does not count literal data URLs in text or unrelated attributes as images", async () => {
    const urls = Array.from({length: DOCX_LIMITS.images + 1}, () => "data:image/png;base64,AAAA").join(" ");
    const largeUnused = `data:image/png;base64,${"A".repeat(DOCX_LIMITS.imageBytes * 2)}`;
    const {entries} = await readZip(await documentToDocx({blocks: [block(
        `<p data-unused="${largeUnused}">${urls}</p>`)]}));
    expect(text(entries, "word/document.xml")).toContain(urls);
    expect([...entries.keys()].some((name) => name.startsWith("word/media/"))).toBe(false);
  });

  it("keeps supported hyperlinks on embedded images", async () => {
    const source = dataUrl("image/png", png(10, 10));
    const {entries} = await readZip(await documentToDocx({blocks: [block(
        `<p><a href="https://example.com/image"><img src="${source}" alt="linked"></a></p>`)]}));
    const xml = text(entries, "word/document.xml");
    const rels = text(entries, "word/_rels/document.xml.rels");
    expect(xml).toContain('<a:hlinkClick r:id="rId4"/>');
    expect(rels).toContain('Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"');
    expect(rels).toContain('Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"');
  });

  it("replaces invalid, signature-mismatched, and external images with visible safe text", async () => {
    const mismatch = dataUrl("image/jpeg", png(10, 10));
    const badGif = `data:image/gif;base64,${btoa("GIF8zz\x01\x00\x01\x00\x00\x00\x00\x3b")}`;
    const html = `<p><img src="${mismatch}" alt="wrong signature"><img src="${badGif}" alt="bad gif">` +
      '<img src="https://example.com/image.png" alt="external"><img src="data:image/png;base64,%%%">' +
      '<img src="blob:https://example.com/id" alt="blob"></p>';
    const {entries} = await readZip(await documentToDocx({blocks: [block(html)]}));
    const xml = text(entries, "word/document.xml");
    for (const value of ["wrong signature", "bad gif", "external", "[Image unavailable]", "blob"]) expect(xml).toContain(value);
    expect([...entries.keys()].some((name) => name.startsWith("word/media/"))).toBe(false);
    expect(text(entries, "word/_rels/document.xml.rels")).not.toContain("relationships/image");
  });

  it("flattens incidental table rows to paragraphs and cells to tabs while flattening unknown tags", async () => {
    const html = '<table><thead style="color:red"><tr><td>A</td><td><b>B</b></td></tr><tbody><tr><td></td><td>D</td></tr>' +
      "<tr><td>E<td><i>F</i><tr><td>G</td></tr><tr><td><p>H1</p><p>H2<br></p><p>H3</p></td><td><div>I</div></td></tr></tbody></table>" +
      '<section><custom>visible</custom><!-- hidden --><script>bad()</script><style>.bad{}</style></section>' +
      "<article>article</article><aside>aside</aside>";
    const {entries} = await readZip(await documentToDocx({blocks: [block(html)]}));
    const xml = text(entries, "word/document.xml");
    expect(xml.match(/<w:tab\/>/g)).toHaveLength(4);
    for (const value of ["A", "B", "D", "E", "F", "G", "H1", "H2", "I", "visible", "article", "aside"]) expect(xml).toContain(`>${value}</w:t>`);
    expect(xml).toContain('>H1</w:t></w:r><w:r><w:br/></w:r><w:r><w:t xml:space="preserve">H2</w:t></w:r><w:r><w:br/></w:r>' +
      '<w:r><w:t xml:space="preserve">H3</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t xml:space="preserve">I</w:t></w:r></w:p>');
    expect(runContaining(xml, "B")).toContain("<w:b/>");
    expect(runContaining(xml, "F")).toContain("<w:i/>");
    expect(runContaining(xml, "G")).not.toContain("<w:i/>");
    expect(runContaining(xml, "D")).not.toContain("<w:color");
    expect(xml).toContain('<w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:tab/></w:r><w:r><w:t xml:space="preserve">D</w:t>');
    expect(xml).not.toContain("bad()");
    expect(xml).not.toContain(".bad{}");
    expect(xml.match(/<w:p>/g)).toHaveLength(8);
  });

  it("bounds the work done for oversized text runs, separators, and inline styles", async () => {
    const chunk = 64 * 1024;
    const long = "x".repeat(chunk - 1) + "\ud83d\ude00" + "y".repeat(chunk);
    const style = "color:#123456;" + "a:b;".repeat(1_000_000);
    const {entries} = await readZip(await documentToDocx({blocks: [block(`<p style="${style}">${long}</p>`)]}));
    const xml = text(entries, "word/document.xml");
    expect(xml.match(/<w:t xml:space="preserve">/g)).toHaveLength(3);
    expect(xml).toContain('x</w:t><w:t xml:space="preserve">\ud83d\ude00y');
    expect(xml).not.toContain("\ufffd");
    expect(xml.match(/<w:r>/g)).toHaveLength(1);
    expect(xml).toContain('<w:r><w:rPr><w:color w:val="123456"/></w:rPr><w:t xml:space="preserve">xxx');

    const flood = await readZip(await documentToDocx({blocks: [block(`<pre>${"\n".repeat(300_000)}\t\t${"a\n".repeat(200_000)}</pre>`)]}));
    const floodXml = text(flood.entries, "word/document.xml");
    expect(floodXml.match(/<w:r>/g)).toHaveLength(1);
    expect(floodXml.match(/<w:br\/>/g)).toHaveLength(300_000 - 1 + 200_000 - 1);
    expect(floodXml.match(/<w:tab\/>/g)).toHaveLength(2);
  });

  it("skips hidden elements, collapsed details, and links that wrap no content", async () => {
    const anchors = Array.from({length: 1000}, (_, index) => `<a href="https://example.com/${index}"></a>`).join("");
    const html = `<p hidden>draft</p><p><span style="display: none">secret</span>${anchors}shown` +
      '<span style="display:none !important">also secret</span><span style="display:none;display:inline">reshown</span>' +
      '<span style="display:none!important;display:inline">still secret</span>' +
      `<a href="https://example.com/kept">kept</a><a href="https://example.com/${"\u4e2d".repeat(3000)}">wide</a></p>` +
      "<dl><dt>term<dd>definition<dt><b>bold term</dt></dl>" +
      "<details><summary>Summary</summary><p>collapsed secret</p></details><details open><summary>Open</summary><p>expanded</p></details>";
    const {entries} = await readZip(await documentToDocx({blocks: [block(html)]}));
    const xml = text(entries, "word/document.xml");
    for (const value of ["draft", "secret"]) expect(xml).not.toContain(value);
    for (const value of ["shownreshown", "wide", "Summary", "Open", "expanded"]) expect(xml).toContain(`>${value}</w:t>`);
    expect(text(entries, "word/_rels/document.xml.rels").match(/relationships\/hyperlink/g)).toHaveLength(1);
    expect(runContaining(xml, "definition")).not.toContain("<w:b/>");
    expect(xml.match(/<w:p>/g)).toHaveLength(7);
  });

  it("gives editor images their own paragraph while other images stay inline", async () => {
    const source = dataUrl("image/png", png(4, 2));
    const {entries} = await readZip(await documentToDocx({blocks: [block(
        `<p>before<img class="doc-image" src="${source}" alt="block">after<img src="${source}" alt="inline">end` +
        `<img src="${source}" alt="gone" style="width:0%"><img src="${source}" alt="gone" width="0"></p>`)]}));
    const xml = text(entries, "word/document.xml");
    expect(xml.match(/<w:p>/g)).toHaveLength(3);
    expect(xml).toContain('descr="block"></wp:docPr>');
    expect(xml).toMatch(/>after<\/w:t><\/w:r><w:r><w:drawing>[\s\S]*descr="inline"[\s\S]*>end<\/w:t>/);
    expect(xml).not.toContain("gone");
    expect(xml.match(/<w:drawing>/g)).toHaveLength(2);
  });

  it("ignores self-closing foreign elements without rejecting surrounding content", async () => {
    const html = "<p>before</p><svg/><svg><path/></svg><math/><p>after</p>";
    const {entries} = await readZip(await documentToDocx({blocks: [block(html)]}));
    const xml = text(entries, "word/document.xml");
    expect(xml).toContain(">before</w:t>");
    expect(xml).toContain(">after</w:t>");
  });

  it("fails before returning a stream when parser or media limits are exceeded", async () => {
    const deep = "<div>".repeat(DOCX_LIMITS.depth + 1) + "deep";
    await expect(documentToDocx({blocks: [block(deep)]})).rejects.toThrow("nesting exceeds");

    const links = Array.from({length: DOCX_LIMITS.hyperlinks + 1}, (_, index) => `<a href="https://example.com/${index}">x</a>`).join("");
    await expect(documentToDocx({blocks: [block(`<p>${links}</p>`)]})).rejects.toThrow("hyperlink count exceeds");

    const image = dataUrl("image/png", png(1, 1));
    const images = `<p>${`<img src="${image}" alt="x">`.repeat(DOCX_LIMITS.images + 1)}</p>`;
    await expect(documentToDocx({blocks: [block(images)]})).rejects.toThrow("image count exceeds");

    const oversized = `data:image/png;base64,${"A".repeat(DOCX_LIMITS.imageBytes * 4 / 3 + 4)}`;
    await expect(documentToDocx({blocks: [block(`<img src="${oversized}">`)]})).rejects.toThrow("per-image export limit");

    // Exactly at the limit, with Base64 padding, is still allowed.
    const exact = `data:image/png;base64,${png(1, 1, DOCX_LIMITS.imageBytes - 70).toBase64()}`;
    expect(exact.endsWith("=")).toBe(true);
    await expect(documentToDocx({blocks: [block(`<img src="${exact}">`)]})).resolves.toBeInstanceOf(ReadableStream);
  });
});

describe("Workspace Docs export handler", () => {
  it("declares exact DOCX metadata while retaining Markdown, HTML, and PDF declarations", async () => {
    await expect(handler().getExportFormats()).resolves.toEqual([
      {id: "markdown", label: "Markdown", mode: "server", contentType: "text/markdown", fileExtension: ".md"},
      {
        id: "docx",
        label: "Word Document",
        mode: "server",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileExtension: ".docx",
      },
      {id: "html", label: "HTML", mode: "browser", contentType: "text/html", fileExtension: ".html"},
      {id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf"},
    ]);
  });

  it("keeps Markdown behavior and rejects unknown server export IDs clearly", async () => {
    const gadget = {getDocument: vi.fn(async () => ({blocks: [block("<h1>Hi</h1><p>there</p>")]}))};
    const markdown = await handler().export(gadget as never, "markdown");
    await expect(new Response(markdown).text()).resolves.toBe("# Hi\n\nthere\n");
    await expect(handler().export(gadget as never, "other")).rejects.toThrow("Unsupported document export format: other");
    expect(gadget.getDocument).toHaveBeenCalledTimes(1);
  });

  it("awaits the snapshot and completes HTML parsing before exposing a capability-free stream", async () => {
    let release!: (document: unknown) => void;
    const pending = new Promise((resolve) => { release = resolve; });
    const document = {title: "Materialized", blocks: [block("<p>original</p>")]};
    const gadget = {getDocument: vi.fn(() => pending)};
    let settled = false;
    const exporting = handler().export(gadget as never, "docx").then((stream) => {
      settled = true;
      return stream;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release(document);
    const stream = await exporting;

    document.blocks[0].html = "<p>changed after parsing</p>";
    gadget.getDocument.mockImplementation(() => { throw new Error("borrowed capability reused"); });
    const {entries} = await readZip(stream);
    const xml = text(entries, "word/document.xml");
    expect(xml).toContain("original");
    expect(xml).not.toContain("changed after parsing");
    expect(gadget.getDocument).toHaveBeenCalledTimes(1);

    const invalid = {getDocument: vi.fn(async () => ({blocks: [block("<div>".repeat(DOCX_LIMITS.depth + 1))]}))};
    await expect(handler().export(invalid as never, "docx")).rejects.toThrow("nesting exceeds");
  });
});
