// Test-only builders for ZIP archives and minimal Word and PowerPoint packages, so the converter
// tests construct exactly the markup they exercise instead of checking in binary fixtures. Not
// imported by production code.

import { crc32 } from "../../src/content/zip";

/** One entry to write. The overrides let a test produce archives a real writer never would. */
export interface FixtureEntry {
  readonly name: string;
  readonly data: string | Uint8Array;
  readonly method?: "store" | "deflate";
  /** Raw general-purpose flags; bit 11 (UTF-8 names) is added for non-ASCII names unless this is set. */
  readonly flags?: number;
  /** The uncompressed size to declare instead of the real one. */
  readonly declaredSize?: number;
  readonly crc?: number;
  /** Raw name bytes, to write a name in code page 437. */
  readonly nameBytes?: Uint8Array;
}

const encoder = new TextEncoder();

/** Builds a single-disk ZIP archive. Entries are deflated unless they say otherwise. */
export async function buildZip(entries: readonly FixtureEntry[]): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const method = entry.method === "store" ? 0 : 8;
    const stored = method === 0 ? data : await deflateRaw(data);
    const name = entry.nameBytes ?? encoder.encode(entry.name);
    const flags = entry.flags ?? (/^[\x20-\x7e]*$/.test(entry.name) ? 0 : 1 << 11);
    const header = {
      flags, method, crc: entry.crc ?? crc32(data), compressedSize: stored.length,
      size: entry.declaredSize ?? data.length, name,
    };
    const local = concat([localHeader(header), name, stored]);
    centrals.push(concat([centralHeader(header, offset), name]));
    locals.push(local);
    offset += local.length;
  }
  const central = concat(centrals);
  return concat([...locals, central, endOfCentralDirectory(entries.length, central.length, offset)]);
}

interface HeaderFields {
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly name: Uint8Array;
}

function localHeader(fields: HeaderFields): Uint8Array {
  const view = new DataView(new ArrayBuffer(30));
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, fields.flags, true);
  view.setUint16(8, fields.method, true);
  view.setUint16(12, 0x21, true);
  view.setUint32(14, fields.crc, true);
  view.setUint32(18, fields.compressedSize, true);
  view.setUint32(22, fields.size, true);
  view.setUint16(26, fields.name.length, true);
  return new Uint8Array(view.buffer);
}

function centralHeader(fields: HeaderFields, localOffset: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(46));
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, fields.flags, true);
  view.setUint16(10, fields.method, true);
  view.setUint16(14, 0x21, true);
  view.setUint32(16, fields.crc, true);
  view.setUint32(20, fields.compressedSize, true);
  view.setUint32(24, fields.size, true);
  view.setUint16(28, fields.name.length, true);
  view.setUint32(42, localOffset, true);
  return new Uint8Array(view.buffer);
}

function endOfCentralDirectory(count: number, size: number, offset: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(22));
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  return new Uint8Array(view.buffer);
}

/** Deflates with the platform's raw-deflate compressor. */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const PACKAGE_RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A relationship to declare: internal targets are relative to the source part. */
export interface FixtureRelationship {
  readonly id: string;
  /** The type URI's last segment, such as `hyperlink`. */
  readonly type: string;
  readonly target: string;
  readonly external?: boolean;
}

function relationshipsXml(relationships: readonly FixtureRelationship[]): string {
  const items = relationships.map(({ id, type, target, external }) =>
    `<Relationship Id="${id}" Type="${REL_TYPE}/${type}" Target="${escapeXml(target)}"${external ? ' TargetMode="External"' : ""}/>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_RELS}">${items.join("")}</Relationships>`;
}

/** Escapes text for an XML attribute or element. */
export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The parts of a minimal Word package; XML fragments go inside the part's root element. */
export interface DocxFixture {
  /** The contents of `w:body`. */
  readonly body: string;
  /** The contents of `w:styles`. */
  readonly styles?: string;
  /** The contents of `w:numbering`. */
  readonly numbering?: string;
  /** The contents of `w:footnotes`. */
  readonly footnotes?: string;
  readonly relationships?: readonly FixtureRelationship[];
}

const WORD_NAMESPACES = `xmlns:w="${W}" xmlns:r="${R}" xmlns:a="${A}" xmlns:wp="${WP}"`;

/** Builds a Word package with the parts the fixture names, related from the main document. */
export async function buildDocx(fixture: DocxFixture): Promise<Uint8Array> {
  const relationships = [...(fixture.relationships ?? [])];
  const entries: FixtureEntry[] = [
    { name: "[Content_Types].xml", data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: "_rels/.rels", data: relationshipsXml([{ id: "rId1", type: "officeDocument", target: "word/document.xml" }]) },
    { name: "word/document.xml", data: `<?xml version="1.0" encoding="UTF-8"?><w:document ${WORD_NAMESPACES}><w:body>${fixture.body}</w:body></w:document>` },
  ];
  const part = (name: string, root: string, content: string | undefined, type: string) => {
    if (content === undefined) return;
    entries.push({ name: `word/${name}`, data: `<w:${root} ${WORD_NAMESPACES}>${content}</w:${root}>` });
    relationships.push({ id: `rIdPart${entries.length}`, type, target: name });
  };
  part("styles.xml", "styles", fixture.styles, "styles");
  part("numbering.xml", "numbering", fixture.numbering, "numbering");
  part("footnotes.xml", "footnotes", fixture.footnotes, "footnotes");
  entries.push({ name: "word/_rels/document.xml.rels", data: relationshipsXml(relationships) });
  return buildZip(entries);
}

/** A run of text, optionally with run properties. */
export function run(text: string, properties = ""): string {
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

/** A paragraph of runs, optionally with paragraph properties. */
export function paragraph(content: string, properties = ""): string {
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}${content}</w:p>`;
}

/** One slide of a fixture presentation. */
export interface SlideFixture {
  /** The contents of `p:spTree`. */
  readonly shapes: string;
  /** The contents of the notes slide's body placeholder `p:txBody`, if the slide has notes. */
  readonly notes?: string;
  readonly relationships?: readonly FixtureRelationship[];
  readonly hidden?: boolean;
}

const SLIDE_NAMESPACES = `xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"`;

/**
 * Builds a presentation. Slide parts are named in array order (slide1.xml, ...), while
 * `order` (indexes into `slides`) sets the presentation order, to show the two are independent.
 */
export async function buildPptx(slides: readonly SlideFixture[], order: readonly number[] = slides.map((_, index) => index)): Promise<Uint8Array> {
  const entries: FixtureEntry[] = [
    { name: "_rels/.rels", data: relationshipsXml([{ id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" }]) },
  ];
  const presentationRelationships: FixtureRelationship[] = [];
  slides.forEach((slide, index) => {
    const number = index + 1;
    const relationships = [...(slide.relationships ?? [])];
    presentationRelationships.push({ id: `rIdSlide${number}`, type: "slide", target: `slides/slide${number}.xml` });
    entries.push({
      name: `ppt/slides/slide${number}.xml`,
      data: `<p:sld ${SLIDE_NAMESPACES}${slide.hidden ? ' show="0"' : ""}><p:cSld><p:spTree>${slide.shapes}</p:spTree></p:cSld></p:sld>`,
    });
    if (slide.notes !== undefined) {
      relationships.push({ id: "rIdNotes", type: "notesSlide", target: `../notesSlides/notesSlide${number}.xml` });
      entries.push({
        name: `ppt/notesSlides/notesSlide${number}.xml`,
        data: `<p:notes ${SLIDE_NAMESPACES}><p:cSld><p:spTree>` +
          `${shape('<p:ph type="sldImg"/>', "")}${shape('<p:ph type="body" idx="1"/>', slide.notes)}` +
          `</p:spTree></p:cSld></p:notes>`,
      });
    }
    entries.push({ name: `ppt/slides/_rels/slide${number}.xml.rels`, data: relationshipsXml(relationships) });
  });
  const slideIds = order.map((index, position) => `<p:sldId id="${256 + position}" r:id="rIdSlide${index + 1}"/>`).join("");
  entries.push(
    { name: "ppt/presentation.xml", data: `<p:presentation ${SLIDE_NAMESPACES}><p:sldIdLst>${slideIds}</p:sldIdLst></p:presentation>` },
    { name: "ppt/_rels/presentation.xml.rels", data: relationshipsXml(presentationRelationships) },
  );
  return buildZip(entries);
}

/** A text shape: `placeholder` is the `p:nvPr` content (such as `<p:ph type="title"/>`), `body` the `p:txBody` paragraphs. */
export function shape(placeholder: string, body: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="1" name="Shape"/><p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/>${body}</p:txBody></p:sp>`;
}

/** A DrawingML paragraph of plain runs. */
export function slideParagraph(text: string, properties = "", runProperties = ""): string {
  return `<a:p>${properties ? `<a:pPr ${properties}/>` : ""}<a:r><a:rPr lang="en-US" ${runProperties}/><a:t>${escapeXml(text)}</a:t></a:r></a:p>`;
}
