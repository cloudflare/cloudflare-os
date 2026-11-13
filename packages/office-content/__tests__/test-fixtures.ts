// Test-only builders for ZIP archives and minimal Word, PowerPoint and Excel packages, so the converter
// tests construct exactly the markup they exercise instead of checking in binary fixtures. Not
// imported by production code.

import { crc32 } from "../src/zip";

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
  const stream = new Blob([data.slice().buffer]).stream().pipeThrough(new CompressionStream("deflate-raw"));
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

const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/** The parts of a minimal Excel package; XML fragments go inside the part's root element. */
export interface XlsxFixture {
  /** Each sheet's `sheetData` contents, and the `state` its `sheet` element carries, if any. */
  readonly sheets: readonly { readonly name: string; readonly rows: string; readonly state?: string }[];
  /** The contents of `sst`. */
  readonly strings?: string;
  /** The contents of `styleSheet`. */
  readonly styles?: string;
  readonly date1904?: boolean;
}

/** Builds an Excel package with the parts the fixture names, related from the workbook. */
export async function buildXlsx(fixture: XlsxFixture): Promise<Uint8Array> {
  const relationships: FixtureRelationship[] = [];
  const entries: FixtureEntry[] = [
    { name: "_rels/.rels", data: relationshipsXml([{ id: "rId1", type: "officeDocument", target: "xl/workbook.xml" }]) },
  ];
  const sheets = fixture.sheets.map((sheet, index) => {
    relationships.push({ id: `rIdSheet${index}`, type: "worksheet", target: `worksheets/sheet${index + 1}.xml` });
    entries.push({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      // `cols` puts other elements at the depth rows are read from, as real sheets do.
      data: `<worksheet xmlns="${S}"><cols><col min="1" max="1"/></cols><sheetData>${sheet.rows}</sheetData></worksheet>`,
    });
    const state = sheet.state ? ` state="${sheet.state}"` : "";
    return `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}"${state} r:id="rIdSheet${index}"/>`;
  });
  const part = (name: string, root: string, content: string | undefined, type: string) => {
    if (content === undefined) return;
    entries.push({ name: `xl/${name}`, data: `<${root} xmlns="${S}">${content}</${root}>` });
    relationships.push({ id: `rIdPart${entries.length}`, type, target: name });
  };
  part("sharedStrings.xml", "sst", fixture.strings, "sharedStrings");
  part("styles.xml", "styleSheet", fixture.styles, "styles");
  entries.push({
    name: "xl/workbook.xml",
    data: `<workbook xmlns="${S}" xmlns:r="${R}">${fixture.date1904 ? '<workbookPr date1904="1"/>' : ""}<sheets>${sheets.join("")}</sheets></workbook>`,
  });
  entries.push({ name: "xl/_rels/workbook.xml.rels", data: relationshipsXml(relationships) });
  return buildZip(entries);
}

/** One worksheet of a styled fixture workbook; XML fragments go inside `worksheet`. */
export interface StyledSheetFixture {
  readonly name: string;
  /** What precedes `sheetData`: `sheetViews`, `sheetFormatPr`, `cols`. */
  readonly before?: string;
  /** The contents of `sheetData`. */
  readonly rows: string;
  /** What follows `sheetData`: `mergeCells`, `hyperlinks`, `drawing`, ... */
  readonly after?: string;
  readonly relationships?: readonly FixtureRelationship[];
}

/** The parts of an Excel package with styling; XML fragments go inside the part's root element. */
export interface StyledXlsxFixture {
  readonly sheets: readonly StyledSheetFixture[];
  /** The contents of `styleSheet`. */
  readonly styles?: string;
  /** The contents of `a:clrScheme` in the theme part. */
  readonly themeColors?: string;
  readonly date1904?: boolean;
  /** Further parts, such as a drawing and its relationships, by entry name. */
  readonly parts?: Readonly<Record<string, string>>;
}

/** Builds an Excel package whose sheets carry views, columns, merges, links and their own relationships. */
export async function buildStyledXlsx(fixture: StyledXlsxFixture): Promise<Uint8Array> {
  const relationships: FixtureRelationship[] = [];
  const entries: FixtureEntry[] = [
    { name: "_rels/.rels", data: relationshipsXml([{ id: "rId1", type: "officeDocument", target: "xl/workbook.xml" }]) },
  ];
  const sheets = fixture.sheets.map((sheet, index) => {
    const number = index + 1;
    relationships.push({ id: `rIdSheet${number}`, type: "worksheet", target: `worksheets/sheet${number}.xml` });
    entries.push({
      name: `xl/worksheets/sheet${number}.xml`,
      data: `<worksheet xmlns="${S}" xmlns:r="${R}">${sheet.before ?? ""}<sheetData>${sheet.rows}</sheetData>${sheet.after ?? ""}</worksheet>`,
    });
    if (sheet.relationships) {
      entries.push({ name: `xl/worksheets/_rels/sheet${number}.xml.rels`, data: relationshipsXml(sheet.relationships) });
    }
    return `<sheet name="${escapeXml(sheet.name)}" sheetId="${number}" r:id="rIdSheet${number}"/>`;
  });
  if (fixture.styles !== undefined) {
    entries.push({ name: "xl/styles.xml", data: `<styleSheet xmlns="${S}">${fixture.styles}</styleSheet>` });
    relationships.push({ id: "rIdStyles", type: "styles", target: "styles.xml" });
  }
  if (fixture.themeColors !== undefined) {
    entries.push({
      name: "xl/theme/theme1.xml",
      data: `<a:theme xmlns:a="${A}"><a:themeElements><a:clrScheme name="Fixture">${fixture.themeColors}</a:clrScheme></a:themeElements></a:theme>`,
    });
    relationships.push({ id: "rIdTheme", type: "theme", target: "theme/theme1.xml" });
  }
  for (const [name, data] of Object.entries(fixture.parts ?? {})) entries.push({ name, data });
  entries.push({
    name: "xl/workbook.xml",
    data: `<workbook xmlns="${S}" xmlns:r="${R}">${fixture.date1904 ? '<workbookPr date1904="1"/>' : ""}<sheets>${sheets.join("")}</sheets></workbook>`,
  });
  entries.push({ name: "xl/_rels/workbook.xml.rels", data: relationshipsXml(relationships) });
  return buildZip(entries);
}

/** A relationships part's XML, for a fixture part that needs its own (a drawing's charts). */
export function fixtureRelationships(relationships: readonly FixtureRelationship[]): string {
  return relationshipsXml(relationships);
}

/** Parts a layout test needs beyond `DocxFixture`'s; XML fragments go inside the part's root element. */
export interface DocxLayoutFixture extends DocxFixture {
  /** The contents of `a:themeElements`. */
  readonly theme?: string;
  /** The contents of `w:settings`. */
  readonly settings?: string;
  /** The contents of `w:hdr`, related from the main document as `rIdHeader`. */
  readonly header?: string;
  /** The contents of `w:ftr`, related from the main document as `rIdFooter`. */
  readonly footer?: string;
  /** Files under `word/`, such as `media/image1.png`, for the fixture's relationships to target. */
  readonly files?: Readonly<Record<string, Uint8Array>>;
}

/** Builds a Word package like `buildDocx`, with a theme, settings, a header, a footer and media as well. */
export async function buildLayoutDocx(fixture: DocxLayoutFixture): Promise<Uint8Array> {
  const relationships = [...(fixture.relationships ?? [])];
  const entries: FixtureEntry[] = [
    { name: "_rels/.rels", data: relationshipsXml([{ id: "rId1", type: "officeDocument", target: "word/document.xml" }]) },
    { name: "word/document.xml", data: `<w:document ${WORD_NAMESPACES}><w:body>${fixture.body}</w:body></w:document>` },
  ];
  const part = (name: string, xml: string | undefined, type: string, id = `rIdPart${entries.length}`) => {
    if (xml === undefined) return;
    entries.push({ name: `word/${name}`, data: xml });
    relationships.push({ id, type, target: name });
  };
  const word = (root: string, content: string | undefined) => content === undefined ? undefined : `<w:${root} ${WORD_NAMESPACES}>${content}</w:${root}>`;
  part("styles.xml", word("styles", fixture.styles), "styles");
  part("numbering.xml", word("numbering", fixture.numbering), "numbering");
  part("settings.xml", word("settings", fixture.settings), "settings");
  part("header1.xml", word("hdr", fixture.header), "header", "rIdHeader");
  part("footer1.xml", word("ftr", fixture.footer), "footer", "rIdFooter");
  part("theme/theme1.xml", fixture.theme === undefined ? undefined : `<a:theme xmlns:a="${A}"><a:themeElements>${fixture.theme}</a:themeElements></a:theme>`, "theme");
  for (const [name, data] of Object.entries(fixture.files ?? {})) entries.push({ name: `word/${name}`, data });
  entries.push({ name: "word/_rels/document.xml.rels", data: relationshipsXml(relationships) });
  return buildZip(entries);
}

/** One slide of a fixture deck: a `SlideFixture` that may also state its own background. */
export interface DeckSlideFixture extends SlideFixture {
  /** The slide's `p:bg` element. */
  readonly background?: string;
  /** Extra attributes for the slide's root element, such as `showMasterSp="0"`. */
  readonly attributes?: string;
  /** The slide's `p:clrMapOvr` contents. */
  readonly colorMapOverride?: string;
}

/** The parts of a presentation with one layout, one master and a theme, as the slide reader needs. */
export interface DeckFixture {
  readonly slides: readonly DeckSlideFixture[];
  /** The contents of the layout's and the master's `p:spTree`. */
  readonly layoutShapes?: string;
  readonly masterShapes?: string;
  /** The master's `p:bg` element. */
  readonly masterBackground?: string;
  /** The contents of the master's `p:txStyles`. */
  readonly textStyles?: string;
  /** The contents of the presentation's `p:defaultTextStyle`. */
  readonly defaultTextStyle?: string;
  /** The slide size in EMU; PowerPoint's 4:3 default when absent. */
  readonly size?: { readonly cx: number; readonly cy: number };
  /** The contents of `ppt/tableStyles.xml`'s root. */
  readonly tableStyles?: string;
  /** Further parts, such as media. */
  readonly parts?: readonly FixtureEntry[];
  /** The layout's relationships besides the one to its master. */
  readonly layoutRelationships?: readonly FixtureRelationship[];
}

const THEME_COLORS = [
  ["dk1", "000000"], ["lt1", "FFFFFF"], ["dk2", "1F497D"], ["lt2", "EEECE1"], ["accent1", "4F81BD"], ["accent2", "C0504D"],
  ["accent3", "9BBB59"], ["accent4", "8064A2"], ["accent5", "4BACC6"], ["accent6", "F79646"], ["hlink", "0000FF"], ["folHlink", "800080"],
] as const;

/**
 * Builds a presentation whose slides all use one layout on one master, with the Office 2007 theme
 * colors, Cambria as the major font and Calibri as the minor.
 */
export async function buildDeck(fixture: DeckFixture): Promise<Uint8Array> {
  const tree = (shapes = "") => `<p:spTree>${shapes}</p:spTree>`;
  const presentationRelationships: FixtureRelationship[] = [
    { id: "rIdMaster", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
  ];
  const entries: FixtureEntry[] = [
    { name: "_rels/.rels", data: relationshipsXml([{ id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" }]) },
    {
      name: "ppt/theme/theme1.xml",
      data: `<a:theme xmlns:a="${A}"><a:themeElements><a:clrScheme name="Office">` +
        THEME_COLORS.map(([slot, hex]) => `<a:${slot}><a:srgbClr val="${hex}"/></a:${slot}>`).join("") +
        `</a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Cambria"/></a:majorFont>` +
        `<a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme>` +
        `<a:fmtScheme><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
        `<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>` +
        `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>` +
        `</a:themeElements></a:theme>`,
    },
    {
      name: "ppt/slideMasters/slideMaster1.xml",
      data: `<p:sldMaster ${SLIDE_NAMESPACES}><p:cSld>${fixture.masterBackground ?? ""}${tree(fixture.masterShapes)}</p:cSld>` +
        `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" hlink="hlink"/>` +
        `<p:txStyles>${fixture.textStyles ?? ""}</p:txStyles></p:sldMaster>`,
    },
    {
      name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      data: relationshipsXml([
        { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
        { id: "rId2", type: "theme", target: "../theme/theme1.xml" },
      ]),
    },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: `<p:sldLayout ${SLIDE_NAMESPACES}><p:cSld>${tree(fixture.layoutShapes)}</p:cSld></p:sldLayout>` },
    {
      name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      data: relationshipsXml([
        { id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" },
        ...(fixture.layoutRelationships ?? []),
      ]),
    },
    ...(fixture.parts ?? []),
  ];
  if (fixture.tableStyles !== undefined) {
    entries.push({ name: "ppt/tableStyles.xml", data: `<a:tblStyleLst xmlns:a="${A}">${fixture.tableStyles}</a:tblStyleLst>` });
    presentationRelationships.push({ id: "rIdTableStyles", type: "tableStyles", target: "tableStyles.xml" });
  }
  fixture.slides.forEach((slide, index) => {
    const number = index + 1;
    presentationRelationships.push({ id: `rIdSlide${number}`, type: "slide", target: `slides/slide${number}.xml` });
    entries.push({
      name: `ppt/slides/slide${number}.xml`,
      data: `<p:sld ${SLIDE_NAMESPACES}${slide.hidden ? ' show="0"' : ""} ${slide.attributes ?? ""}>` +
        `<p:cSld>${slide.background ?? ""}${tree(slide.shapes)}</p:cSld>` +
        `${slide.colorMapOverride === undefined ? "" : `<p:clrMapOvr>${slide.colorMapOverride}</p:clrMapOvr>`}</p:sld>`,
    }, {
      name: `ppt/slides/_rels/slide${number}.xml.rels`,
      data: relationshipsXml([
        { id: "rIdLayout", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
        ...(slide.relationships ?? []),
      ]),
    });
  });
  const size = fixture.size ?? { cx: 9144000, cy: 6858000 };
  entries.push(
    {
      name: "ppt/presentation.xml",
      data: `<p:presentation ${SLIDE_NAMESPACES}><p:sldIdLst>` +
        fixture.slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rIdSlide${index + 1}"/>`).join("") +
        `</p:sldIdLst><p:sldSz cx="${size.cx}" cy="${size.cy}"/>` +
        `<p:defaultTextStyle>${fixture.defaultTextStyle ?? ""}</p:defaultTextStyle></p:presentation>`,
    },
    { name: "ppt/_rels/presentation.xml.rels", data: relationshipsXml(presentationRelationships) },
  );
  return buildZip(entries);
}

/**
 * A shape with geometry: `placeholder` is the `p:nvPr` content, `properties` the `p:spPr` content
 * (such as `transform(...)` and a fill), `body` the `p:txBody` content after `a:bodyPr`, or
 * undefined for a shape with no text.
 */
export function drawnShape(options: { placeholder?: string; properties?: string; body?: string; listStyle?: string; style?: string }): string {
  const body = options.body === undefined ? "" : `<p:txBody><a:bodyPr/><a:lstStyle>${options.listStyle ?? ""}</a:lstStyle>${options.body}</p:txBody>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="1" name="Shape"/><p:cNvSpPr/><p:nvPr>${options.placeholder ?? ""}</p:nvPr></p:nvSpPr>` +
    `<p:spPr>${options.properties ?? ""}</p:spPr>${options.style ? `<p:style>${options.style}</p:style>` : ""}${body}</p:sp>`;
}

/** An `a:xfrm` placing a shape, in EMU. */
export function transform(x: number, y: number, cx: number, cy: number, attributes = ""): string {
  return `<a:xfrm ${attributes}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
}
