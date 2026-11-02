// A presentation package as the writer and editor see it: an ordered slide list kept in step with
// presentation.xml, its relationships and content types; the layouts slides can be made from; and
// cleanup that leaves no part, relationship or reference dangling, since PowerPoint answers any of
// those with a repair prompt. presentation.xml is edited as text rather than reserialized, so
// everything in it this code does not understand (sections, custom shows, extensions) survives.

import { addNotesMaster, defaultPackage, SLIDE_HEIGHT, SLIDE_WIDTH, BODY_SIZES } from "./pptx-default";
import { CONTENT_TYPE, OpcPackage, PackageError, REL, relativeTarget, type PackageRelationship } from "./pptx-package";
import { escapeText, isoSeconds, parsePart, XML_DECLARATION } from "./ooxml";
import { parseRaw, rawChild, rawChildren, RawXmlError, type RawElement } from "./raw-xml";
import { attribute, childAt, childElements, descendants, firstChild, textContent, type XmlElement } from "./xml";

/** A shape's position and size, in EMU. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly cx: number;
  readonly cy: number;
}

/** A placeholder a layout offers, with the `type` and `idx` a slide must repeat to inherit from it. */
export interface LayoutPlaceholder {
  /** The placeholder type; "obj" when the layout leaves it out. */
  readonly type: string;
  readonly idx: string | undefined;
  readonly box: Box | undefined;
  /** The first-level font size the placeholder sets for itself, in hundredths of a point. */
  readonly size?: number;
}

/** A slide layout: its part, type, name and placeholders. */
export interface LayoutInfo {
  readonly part: string;
  /** The layout's `type`, "cust" when it has none. */
  readonly type: string;
  readonly name: string;
  readonly placeholders: readonly LayoutPlaceholder[];
  /** The `idx` of the layout's slide number placeholder, when it has one. */
  readonly slideNumber: string | undefined;
}

/** A slide as presentation.xml lists it: its slide ID, relationship id and part name. */
export interface SlideRef {
  readonly id: number;
  readonly rId: string;
  readonly part: string;
}

/** The layouts the writer uses, resolved against what a deck actually has. */
export interface LayoutChoice {
  readonly title: LayoutInfo;
  readonly content: LayoutInfo;
  readonly sectionHeader: LayoutInfo;
  /** Two content areas side by side; undefined when the deck has no such layout. */
  readonly twoContent: LayoutInfo | undefined;
  /** Two columns, each with a heading; undefined when the deck has no such layout. */
  readonly comparison: LayoutInfo | undefined;
  readonly titleOnly: LayoutInfo;
  readonly blank: LayoutInfo;
}

/** PowerPoint's English layout names, and the layout types that serve for each in a deck that names them otherwise. */
const LAYOUT_ALIASES: Record<string, readonly string[]> = {
  "title slide": ["title"],
  "title and content": ["obj", "tx"],
  "section header": ["secHead"],
  "two content": ["twoObj", "twoColTx"],
  "comparison": ["twoTxTwoObj"],
  "title only": ["titleOnly"],
  "blank": ["blank"],
  "picture with caption": ["picTx"],
  "content with caption": ["objTx"],
};

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

const PRESENTATION_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const RELATIONSHIPS_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const FURNITURE = new Set(["dt", "ftr", "hdr", "sldNum", "sldImg"]);

/** Main-part content types a template or macro-enabled deck may have; all become a presentation. */
const MAIN_CONTENT_TYPES = new Set([
  CONTENT_TYPE.presentation,
  "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml",
  "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
  "application/vnd.ms-powerpoint.template.macroEnabled.main+xml",
  "application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml",
]);

/** The last segment of a relationship type URI: `.../relationships/slide` → `slide`. */
export function relKind(type: string): string {
  return type.slice(type.lastIndexOf("/") + 1);
}

/** A presentation package opened for writing or editing. */
export class Deck {
  #layouts: LayoutInfo[] | undefined;

  private constructor(readonly pkg: OpcPackage, readonly presentationPart: string) {}

  /** A new deck in the default design, with no slides. */
  static create(): Deck {
    return new Deck(defaultPackage(), "ppt/presentation.xml");
  }

  /** An existing deck or template. Throws `PackageError` when it isn't a presentation this code can edit. */
  static async open(bytes: Uint8Array): Promise<Deck> {
    const pkg = await OpcPackage.open(bytes);
    const main = pkg.relationships("").find(relationship => relKind(relationship.type) === "officeDocument" && !relationship.external);
    const part = main ? pkg.target("", main) : undefined;
    if (!part || !pkg.has(part) || !MAIN_CONTENT_TYPES.has(pkg.contentType(part) as never)) {
      throw new PackageError("The file isn't a PowerPoint presentation.");
    }
    const text = pkg.text(part)!;
    // presentation.xml is edited as text, which needs the prefixes PowerPoint itself writes.
    if (!/<p:presentation[\s>]/.test(text) || !text.includes(PRESENTATION_NS) || !text.includes(RELATIONSHIPS_NS)) {
      throw new PackageError("The presentation uses XML prefixes this editor doesn't support. Open and save it in PowerPoint, then try again.");
    }
    return new Deck(pkg, part);
  }

  /** presentation.xml as text, which the slide list and other edits splice. */
  get presentationXml(): string {
    return this.pkg.text(this.presentationPart)!;
  }

  set presentationXml(xml: string) {
    this.pkg.set(this.presentationPart, xml);
  }

  /** The slide size in EMU; the writer's default when the deck doesn't say. */
  slideSize(): { cx: number; cy: number } {
    const match = /<p:sldSz\b[^>]*?\bcx="(\d+)"[^>]*?\bcy="(\d+)"/.exec(this.presentationXml);
    return match ? { cx: Number(match[1]), cy: Number(match[2]) } : { cx: SLIDE_WIDTH, cy: SLIDE_HEIGHT };
  }

  /** The slides in presentation order. */
  slides(): SlideRef[] {
    const relationships = new Map(this.pkg.relationships(this.presentationPart).map(relationship => [relationship.id, relationship]));
    const slides: SlideRef[] = [];
    const seen = new Set<string>();
    for (const entry of rawChildren(this.#slideList(this.presentationXml), "p:sldId")) {
      const id = Number(entry.attributes.get("id"));
      const rId = entry.attributes.get("r:id");
      const relationship = rId ? relationships.get(rId) : undefined;
      if (!relationship || relationship.external) continue;
      const part = this.pkg.target(this.presentationPart, relationship);
      // A part the list names twice is one slide, under its first entry.
      if (this.pkg.has(part) && !seen.has(part)) slides.push({ id, rId: rId!, part });
      seen.add(part);
    }
    return slides;
  }

  /** Every master's layouts, masters in presentation order and layouts in each master's order. */
  layouts(): LayoutInfo[] {
    if (this.#layouts) return this.#layouts;
    const layouts: LayoutInfo[] = [];
    for (const master of this.masters()) {
      const masterXml = parsePart(this.pkg.text(master)!);
      const masterBoxes = new Map<string, Box>();
      for (const placeholder of placeholders(masterXml)) if (placeholder.box) masterBoxes.set(placeholder.type, placeholder.box);
      const relationships = new Map(this.pkg.relationships(master).map(relationship => [relationship.id, relationship]));
      const listed = childElements(childAt(masterXml, "p:sldLayoutIdLst"), "p:sldLayoutId").map(entry => relationships.get(attribute(entry, "r:id") ?? ""));
      for (const relationship of listed) {
        if (!relationship || relKind(relationship.type) !== "slideLayout" || relationship.external) continue;
        const part = this.pkg.target(master, relationship);
        const text = this.pkg.text(part);
        if (text === undefined) continue;
        const root = parsePart(text);
        layouts.push({
          part,
          type: attribute(root, "type") ?? "cust",
          name: attribute(firstChild(root, "p:cSld"), "name") ?? "",
          slideNumber: [...descendants(root, "p:ph")].find(ph => attribute(ph, "type") === "sldNum")?.attributes.get("idx"),
          // A layout placeholder without a position takes the master's for its type; content
          // placeholders inherit the master's body.
          placeholders: placeholders(root).map(placeholder => ({
            ...placeholder,
            box: placeholder.box ?? masterBoxes.get(placeholder.type === "obj" || placeholder.type === "subTitle" ? "body" : placeholder.type === "ctrTitle" ? "title" : placeholder.type),
          })),
        });
      }
    }
    if (layouts.length === 0) throw new PackageError("The presentation has no slide layouts to make slides from.");
    return (this.#layouts = layouts);
  }

  /** The slide masters, in the order presentation.xml lists them. */
  masters(): string[] {
    const relationships = new Map(this.pkg.relationships(this.presentationPart).map(relationship => [relationship.id, relationship]));
    const listed = [...this.presentationXml.matchAll(/<p:sldMasterId\b[^>]*\br:id="([^"]+)"/g)].map(match => relationships.get(match[1]!));
    return listed.flatMap(relationship => relationship && !relationship.external && this.pkg.has(this.pkg.target(this.presentationPart, relationship))
      ? [this.pkg.target(this.presentationPart, relationship)] : []);
  }

  /** The first slide master, which new slides' notes and body sizes come from. */
  master(): string {
    const part = this.masters()[0];
    if (!part) throw new PackageError("The presentation has no slide master.");
    return part;
  }

  /** Font sizes of the master's body levels, in hundredths of a point. */
  bodySizes(): number[] {
    const style = childAt(parsePart(this.pkg.text(this.master())!), "p:txStyles", "p:bodyStyle");
    return BODY_SIZES.map((fallback, index) => {
      const size = Number(attribute(firstChild(firstChild(style, `a:lvl${index + 1}pPr`), "a:defRPr"), "sz"));
      return Number.isFinite(size) && size >= 600 ? size : fallback;
    });
  }

  /**
   * The layouts for a title slide, a content slide, a title-only slide and a blank one: by layout
   * type first, then by PowerPoint's English names, then the nearest that has the placeholders.
   */
  chooseLayouts(): LayoutChoice {
    const layouts = this.layouts();
    const byType = (...types: string[]) => types.map(type => layouts.find(layout => layout.type === type)).find(Boolean);
    const byName = (pattern: RegExp) => layouts.find(layout => pattern.test(layout.name));
    const has = (layout: LayoutInfo, ...types: string[]) => layout.placeholders.some(placeholder => types.includes(placeholder.type));
    const content = byType("obj", "tx") ?? byName(/^title and (content|text)$/i) ??
      layouts.find(layout => has(layout, "title") && has(layout, "obj", "body")) ?? layouts.find(layout => has(layout, "obj", "body")) ?? layouts[0]!;
    const titleOnly = byType("titleOnly") ?? byName(/^title only$/i) ?? content;
    const contentAreas = (layout: LayoutInfo) => layout.placeholders.filter(placeholder => placeholder.type === "obj" || placeholder.type === "body").length;
    return {
      title: byType("title") ?? byName(/^title slide$/i) ?? content,
      content,
      sectionHeader: byType("secHead") ?? byName(/^section header$/i) ?? titleOnly,
      twoContent: byType("twoObj", "twoColTx") ?? byName(/^two content$/i) ?? layouts.find(layout => has(layout, "title") && contentAreas(layout) === 2),
      comparison: byType("twoTxTwoObj") ?? byName(/^comparison$/i),
      titleOnly,
      blank: byType("blank") ?? byName(/^blank$/i) ?? titleOnly,
    };
  }

  /**
   * The layout a `<!-- layout: ... -->` directive names: by the deck's own layout names, then by
   * what PowerPoint calls the layout's type, then by the type itself (`twoObj`). Undefined when
   * nothing matches.
   */
  findLayout(name: string): LayoutInfo | undefined {
    const wanted = normalizeName(name);
    const layouts = this.layouts();
    return layouts.find(layout => normalizeName(layout.name) === wanted) ??
      (LAYOUT_ALIASES[wanted] ?? []).map(type => layouts.find(layout => layout.type === type)).find(Boolean) ??
      layouts.find(layout => layout.type.toLowerCase() === wanted.replace(/ /g, ""));
  }

  /**
   * Adds a slide at `index` (0-based; the end when omitted). `build` gets the new part's name and
   * returns its XML; it relates hyperlinks itself through `this.pkg`. Returns the part name.
   */
  insertSlide(layout: LayoutInfo, build: (part: string) => string, index?: number): string {
    const part = this.pkg.freeName("ppt/slides/slide", ".xml");
    this.pkg.relate(part, REL.slideLayout, layout.part);
    this.pkg.set(part, build(part), CONTENT_TYPE.slide);
    const rId = this.pkg.relate(this.presentationPart, REL.slide, part);
    const slides = this.slides();
    const id = Math.max(255, ...slides.map(slide => slide.id), ...this.#sectionIds()) + 1;
    const entries = this.#slideEntries();
    entries.splice(index ?? entries.length, 0, `<p:sldId id="${id}" r:id="${rId}"/>`);
    this.#writeSlideEntries(entries);
    // A deck with sections lists every slide in one; a new slide joins the section of the slide before it.
    this.#addToSection(id, index === undefined || index >= slides.length ? slides.at(-1)?.id : index > 0 ? slides[index - 1]!.id : undefined);
    return part;
  }

  /** Adds speaker notes to a slide. `build` gets the notes part's name and returns its XML. */
  addNotes(slidePart: string, build: (part: string) => string): void {
    const master = this.notesMaster();
    const part = this.pkg.freeName("ppt/notesSlides/notesSlide", ".xml");
    this.pkg.relate(part, REL.notesMaster, master);
    this.pkg.relate(part, REL.slide, slidePart);
    this.pkg.set(part, build(part), CONTENT_TYPE.notesSlide);
    this.pkg.relate(slidePart, REL.notesSlide, part);
  }

  /** The deck's notes master, adding one (with its theme) when it has none. */
  notesMaster(): string {
    const existing = this.#notesMasterRelationship();
    if (existing) return this.pkg.target(this.presentationPart, existing);
    const master = addNotesMaster(this.pkg);
    this.pkg.relate(this.presentationPart, REL.notesMaster, master);
    this.#listNotesMaster();
    return master;
  }

  #notesMasterRelationship(): PackageRelationship | undefined {
    return this.pkg.relationships(this.presentationPart).find(relationship =>
      relKind(relationship.type) === "notesMaster" && !relationship.external && this.pkg.has(this.pkg.target(this.presentationPart, relationship)));
  }

  /** Lists the notes master in presentation.xml, which some producers (python-pptx) leave out. */
  #listNotesMaster(): void {
    const relationship = this.#notesMasterRelationship();
    if (!relationship) return;
    const xml = this.presentationXml;
    if (new RegExp(`<p:notesMasterId\\s+r:id="${relationship.id}"`).test(xml)) return;
    const list = `<p:notesMasterIdLst><p:notesMasterId r:id="${relationship.id}"/></p:notesMasterIdLst>`;
    const without = xml.replace(/<p:notesMasterIdLst\s*\/>|<p:notesMasterIdLst\s*>[\s\S]*?<\/p:notesMasterIdLst>/, "");
    this.presentationXml = /<\/p:sldMasterIdLst>/.test(without)
      ? without.replace(/<\/p:sldMasterIdLst>/, `</p:sldMasterIdLst>${list}`)
      : without.replace(/(<p:presentation\b[^>]*>)/, `$1${list}`);
  }

  /** Removes the slide at `index` (0-based) with everything only it used. */
  removeSlide(index: number): void {
    const slides = this.slides();
    const slide = slides[index];
    if (!slide) throw new RangeError(`No slide at index ${index}`);
    const entries = this.#slideEntries().filter(entry => /\br:id="([^"]+)"/.exec(entry)?.[1] !== slide.rId);
    this.#writeSlideEntries(entries);
    let xml = this.presentationXml;
    // Custom shows name slides by relationship; sections by slide ID.
    xml = xml.replace(new RegExp(`<p:sld\\s+r:id="${slide.rId}"\\s*/>`, "g"), "");
    xml = xml.replace(new RegExp(`<p14:sldId\\s+id="${slide.id}"\\s*/>`, "g"), "");
    this.presentationXml = xml;
    this.pkg.setRelationships(this.presentationPart, this.pkg.relationships(this.presentationPart).filter(relationship => relationship.id !== slide.rId));
    this.pkg.delete(slide.part);
    this.collectGarbage();
  }

  /**
   * Copies the slide at `index` (0-based) to `insertAt` (0-based position in the new deck): its
   * own parts (notes, charts, SmartArt, embedded objects) are copied, while layout and media parts
   * are shared, as PowerPoint does. Comments stay with the original. Returns the new part name.
   */
  duplicateSlide(index: number, insertAt: number): string {
    const slides = this.slides();
    const source = slides[index];
    if (!source) throw new RangeError(`No slide at index ${index}`);
    const copies = new Map<string, string>();
    const part = this.#copyPart(source.part, "ppt/slides/slide", copies);
    // A notes slide points back at its slide: the copy's at the copy.
    const notes = this.notesPart(part);
    if (notes) {
      this.pkg.setRelationships(notes, this.pkg.relationships(notes).map(relationship =>
        relKind(relationship.type) === "slide" && !relationship.external && this.pkg.target(notes, relationship) === source.part
          ? { ...relationship, target: relativeTarget(notes, part) } : relationship));
    }
    const rId = this.pkg.relate(this.presentationPart, REL.slide, part);
    const id = Math.max(255, ...slides.map(slide => slide.id), ...this.#sectionIds()) + 1;
    const entries = this.#slideEntries();
    entries.splice(insertAt, 0, `<p:sldId id="${id}" r:id="${rId}"/>`);
    this.#writeSlideEntries(entries);
    const order = this.slides();
    this.#addToSection(id, insertAt > 0 ? order[insertAt - 1]!.id : undefined);
    return part;
  }

  /** Moves the slide at `from` to position `to` (both 0-based). */
  moveSlide(from: number, to: number): void {
    const entries = this.#slideEntries();
    const [entry] = entries.splice(from, 1);
    if (!entry) throw new RangeError(`No slide at index ${from}`);
    entries.splice(to, 0, entry);
    this.#writeSlideEntries(entries);
    const id = Number(/\bid="(\d+)"/.exec(entry)?.[1]);
    if (!/<p14:sectionLst\b/.test(this.presentationXml)) return;
    this.presentationXml = this.presentationXml.replace(new RegExp(`<p14:sldId\\s+id="${id}"\\s*/>`, "g"), "");
    const order = this.slides();
    this.#addToSection(id, to > 0 ? order[to - 1]!.id : undefined);
  }

  /** Copies `part` and the parts only it uses, keeping relationship ids so references inside stay valid. */
  #copyPart(part: string, prefix: string | undefined, copies: Map<string, string>): string {
    const existing = copies.get(part);
    if (existing) return existing;
    const extension = part.slice(part.lastIndexOf("."));
    const name = this.pkg.freeName(prefix ?? part.slice(0, part.length - extension.length).replace(/\d+$/, ""), extension);
    copies.set(part, name);
    const data = this.pkg.bytes(part)!;
    const isXml = /\.xml$/i.test(part);
    let content: Uint8Array | string = data;
    if (isXml) {
      // A slide's creation ID identifies it to co-authoring; a copy needs its own. Its comments stay
      // with the original (the relationship is dropped below), so the commentRel naming them goes too.
      content = this.pkg.text(part)!
        .replace(/<p14:creationId\s+val="\d+"\s*\/>/g, () => `<p14:creationId val="${creationId(name)}"/>`)
        .replace(/<p:ext\s+uri="\{6950BFC3-D8DA-4A85-94F7-54DA5524770B\}"\s*>[\s\S]*?<\/p:ext>/g, "");
    }
    const override = this.pkg.contentType(part);
    this.pkg.set(name, content);
    if (override && override !== this.pkg.contentType(name)) this.pkg.setOverride(name, override);
    const relationships = this.pkg.relationships(part).flatMap((relationship): PackageRelationship[] => {
      const kind = relKind(relationship.type);
      if (relationship.external) return [relationship];
      // Comments belong to the slide they were made on.
      if (kind === "comments") return [];
      const target = this.pkg.target(part, relationship);
      if (SHARED_PARTS.has(kind) || !target.startsWith("ppt/") || !this.pkg.has(target)) return [{ ...relationship, target: relativeTarget(name, target) }];
      return [{ ...relationship, target: relativeTarget(name, this.#copyPart(target, undefined, copies)) }];
    });
    this.pkg.setRelationships(name, relationships);
    return name;
  }

  /**
   * Deletes every part under `ppt/` no relationship chain from the package reaches, then every
   * relationship left pointing at a missing part, with the hyperlinks that used it.
   */
  collectGarbage(): void {
    for (;;) {
      const reachable = new Set<string>();
      const queue = [""];
      while (queue.length) {
        const source = queue.pop()!;
        for (const relationship of this.pkg.relationships(source)) {
          if (relationship.external) continue;
          const target = this.pkg.target(source, relationship).toLowerCase();
          if (reachable.has(target)) continue;
          reachable.add(target);
          queue.push(this.pkg.names().find(name => name.toLowerCase() === target) ?? target);
        }
      }
      const unreachable = this.pkg.names().filter(name =>
        name.startsWith("ppt/") && !name.endsWith(".rels") && !reachable.has(name.toLowerCase()));
      // A relationships part whose source is gone goes with it.
      const orphans = this.pkg.names().filter(name => {
        const match = /^(.*?)_rels\/([^/]+)\.rels$/.exec(name);
        return match !== null && match[2] !== "" && !this.pkg.has(`${match[1]}${match[2]}`);
      });
      if (unreachable.length === 0 && orphans.length === 0) break;
      for (const name of [...unreachable, ...orphans]) this.pkg.delete(name);
    }
    for (const source of this.pkg.names()) {
      if (source.endsWith(".rels") || source.endsWith("[Content_Types].xml")) continue;
      const relationships = this.pkg.relationships(source);
      const dangling = relationships.filter(relationship => !relationship.external && !this.pkg.has(this.pkg.target(source, relationship)));
      if (dangling.length === 0) continue;
      let xml = this.pkg.text(source)!;
      for (const relationship of dangling) {
        // A jump to a deleted slide: drop the link, keep the text.
        xml = xml.replace(new RegExp(`<a:(hlinkClick|hlinkHover)\\b[^>]*?r:id="${relationship.id}"[^>]*?(?:/>|>[\\s\\S]*?</a:\\1>)`, "g"), "");
      }
      this.pkg.set(source, xml);
      this.pkg.setRelationships(source, relationships.filter(relationship => !dangling.includes(relationship)));
    }
  }

  /** The text of a slide's title placeholder, or "". */
  slideTitle(part: string): string {
    const text = this.pkg.text(part);
    if (text === undefined) return "";
    for (const shape of descendants(childAt(parsePart(text), "p:cSld", "p:spTree"), "p:sp")) {
      const type = attribute(childAt(shape, "p:nvSpPr", "p:nvPr", "p:ph"), "type");
      if (type === "title" || type === "ctrTitle") return shapeText(shape);
    }
    return "";
  }

  /** Where a slide's layout puts the placeholder a slide shape inherits from (matched by index, else type). */
  layoutPlaceholderBox(slidePart: string, type: string, idx: string | undefined): Box | undefined {
    const relationship = this.pkg.relationships(slidePart).find(candidate => relKind(candidate.type) === "slideLayout" && !candidate.external);
    const part = relationship && this.pkg.target(slidePart, relationship);
    const layout = this.layouts().find(candidate => candidate.part === part);
    const placeholders = layout?.placeholders ?? [];
    return (idx !== undefined ? placeholders.find(placeholder => placeholder.idx === idx) : undefined)?.box ??
      placeholders.find(placeholder => placeholder.type === type)?.box;
  }

  /** The notes slide of a slide, if it has one. */
  notesPart(slidePart: string): string | undefined {
    const relationship = this.pkg.relationships(slidePart).find(candidate => relKind(candidate.type) === "notesSlide" && !candidate.external);
    const part = relationship && this.pkg.target(slidePart, relationship);
    return part && this.pkg.has(part) ? part : undefined;
  }

  /** Writes fresh document properties: title, author, dates, and the slide count. */
  writeProperties(options: { title?: string; author?: string; modifiedAt?: Date }): void {
    const core = "docProps/core.xml", app = "docProps/app.xml";
    const date = isoSeconds(options.modifiedAt ?? new Date());
    const author = escapeText(options.author ?? "");
    this.pkg.set(core, `${XML_DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `${options.title ? `<dc:title>${escapeText(options.title)}</dc:title>` : ""}<dc:creator>${author}</dc:creator><cp:lastModifiedBy>${author}</cp:lastModifiedBy>` +
      `<cp:revision>1</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">${date}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${date}</dcterms:modified></cp:coreProperties>`,
    CONTENT_TYPE.coreProperties);
    const slides = this.slides();
    const { cx, cy } = this.slideSize();
    const format = cx * 9 === cy * 16 ? "Widescreen" : cx * 3 === cy * 4 ? "On-screen Show (4:3)" : "Custom";
    this.pkg.set(app, `${XML_DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      `<TotalTime>0</TotalTime><PresentationFormat>${format}</PresentationFormat>` +
      `<Slides>${slides.length}</Slides><Notes>${slides.filter(slide => this.notesPart(slide.part)).length}</Notes><HiddenSlides>0</HiddenSlides>` +
      "<ScaleCrop>false</ScaleCrop><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged>" +
      "<AppVersion>16.0000</AppVersion></Properties>", CONTENT_TYPE.extendedProperties);
    // A template's thumbnail shows the template, not this deck.
    const rels = this.pkg.relationships("").filter(relationship => relKind(relationship.type) !== "thumbnail" &&
      relKind(relationship.type) !== "core-properties" && relKind(relationship.type) !== "extended-properties");
    for (const relationship of this.pkg.relationships("")) {
      if (relKind(relationship.type) === "thumbnail" && !relationship.external) this.pkg.delete(this.pkg.target("", relationship));
    }
    this.pkg.setRelationships("", [...rels,
      { id: freeId(rels), type: REL.coreProperties, target: core },
      { id: freeId(rels, 1), type: REL.extendedProperties, target: app }]);
  }

  /**
   * Makes a template an ordinary presentation: the presentation content type, no macros, no slides.
   * The masters, layouts, theme and everything else they use stay.
   */
  clearForTemplate(): void {
    this.pkg.setOverride(this.presentationPart, CONTENT_TYPE.presentation);
    const relationships = this.pkg.relationships(this.presentationPart);
    const macros = relationships.filter(relationship => relKind(relationship.type) === "vbaProject");
    if (macros.length) this.pkg.setRelationships(this.presentationPart, relationships.filter(relationship => !macros.includes(relationship)));
    for (let index = this.slides().length - 1; index >= 0; index--) this.removeSlide(index);
    // Custom shows and sections only made sense for the template's own slides.
    this.presentationXml = this.presentationXml
      .replace(/<p:custShowLst\s*\/>|<p:custShowLst\s*>[\s\S]*?<\/p:custShowLst>/, "")
      .replace(/<p:ext\s+uri="\{521415D9-36F7-43E2-AB2F-B90AF26B5E84\}"\s*>[\s\S]*?<\/p:ext>/, "");
    this.collectGarbage();
  }

  async toBytes(modifiedAt?: Date): Promise<Uint8Array> {
    // An empty slide list is schema-valid, but PowerPoint writes none; match it.
    this.presentationXml = this.presentationXml.replace(/<p:sldIdLst\s*\/>|<p:sldIdLst\s*>\s*<\/p:sldIdLst>/, "");
    this.#listNotesMaster();
    return await this.pkg.toBytes(modifiedAt);
  }

  /** The `p:sldIdLst` element of presentation.xml with its offsets, if it has one. */
  #slideList(xml: string): RawElement | undefined {
    try {
      return rawChild(parseRaw(xml), "p:sldIdLst");
    } catch (error) {
      if (error instanceof RawXmlError) throw new PackageError(`The presentation's XML can't be edited: ${error.message}`);
      throw error;
    }
  }

  #slideEntries(): string[] {
    const xml = this.presentationXml;
    return rawChildren(this.#slideList(xml), "p:sldId").map(entry => xml.slice(entry.start, entry.end));
  }

  #writeSlideEntries(entries: readonly string[]): void {
    const list = `<p:sldIdLst>${entries.join("")}</p:sldIdLst>`;
    const xml = this.presentationXml;
    const existing = this.#slideList(xml);
    if (existing) {
      this.presentationXml = xml.slice(0, existing.start) + list + xml.slice(existing.end);
      return;
    }
    // sldIdLst comes after the master lists and before the slide size.
    const anchor = /<\/p:handoutMasterIdLst>|<\/p:notesMasterIdLst>|<\/p:sldMasterIdLst>/g;
    let last: RegExpExecArray | undefined;
    for (let match = anchor.exec(xml); match; match = anchor.exec(xml)) last = match;
    if (last) {
      const end = last.index + last[0].length;
      this.presentationXml = xml.slice(0, end) + list + xml.slice(end);
    } else {
      this.presentationXml = xml.replace(/<p:sldSz\b/, `${list}<p:sldSz`);
    }
  }

  #sectionIds(): number[] {
    return [...this.presentationXml.matchAll(/<p14:sldId\s+id="(\d+)"/g)].map(match => Number(match[1]));
  }

  #addToSection(id: number, afterId: number | undefined): void {
    const xml = this.presentationXml;
    if (!/<p14:sectionLst\b/.test(xml)) return;
    const entry = `<p14:sldId id="${id}"/>`;
    if (afterId !== undefined && xml.includes(`<p14:sldId id="${afterId}"/>`)) {
      this.presentationXml = xml.replace(`<p14:sldId id="${afterId}"/>`, `<p14:sldId id="${afterId}"/>${entry}`);
      return;
    }
    // First slide: the first section's list, which may be empty.
    this.presentationXml = xml.replace(/<p14:sldIdLst\s*\/>|<p14:sldIdLst\s*>/, match => match.endsWith("/>") ? `<p14:sldIdLst>${entry}</p14:sldIdLst>` : `${match}${entry}`);
  }
}

/** Parts a copied slide shares with the original rather than copying. */
const SHARED_PARTS = new Set(["slideLayout", "slideMaster", "notesMaster", "handoutMaster", "theme", "image", "media", "video", "audio", "slide", "commentAuthors", "font"]);

/** A creation ID for a copied slide: any 32-bit value unlikely to repeat; derived from its part name so output is deterministic. */
function creationId(name: string): number {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash;
}

function freeId(relationships: readonly { id: string }[], skip = 0): string {
  const used = new Set(relationships.map(relationship => relationship.id));
  let index = 1;
  for (let found = 0; ; index++) {
    if (used.has(`rId${index}`)) continue;
    if (found++ === skip) return `rId${index}`;
  }
}

function placeholders(root: XmlElement): LayoutPlaceholder[] {
  const out: LayoutPlaceholder[] = [];
  for (const shape of descendants(childAt(root, "p:cSld", "p:spTree"), "p:sp")) {
    const ph = childAt(shape, "p:nvSpPr", "p:nvPr", "p:ph");
    if (!ph) continue;
    const type = attribute(ph, "type") ?? "obj";
    if (FURNITURE.has(type)) continue;
    const xfrm = childAt(shape, "p:spPr", "a:xfrm");
    const off = firstChild(xfrm, "a:off"), ext = firstChild(xfrm, "a:ext");
    const box = off && ext ? { x: Number(attribute(off, "x")), y: Number(attribute(off, "y")), cx: Number(attribute(ext, "cx")), cy: Number(attribute(ext, "cy")) } : undefined;
    const size = Number(attribute(childAt(shape, "p:txBody", "a:lstStyle", "a:lvl1pPr", "a:defRPr"), "sz"));
    out.push({
      type, idx: attribute(ph, "idx"), box: box && Object.values(box).every(Number.isFinite) && box.cx > 0 && box.cy > 0 ? box : undefined,
      ...(Number.isFinite(size) && size >= 600 ? { size } : {}),
    });
  }
  return out;
}

function shapeText(shape: XmlElement): string {
  return childElements(firstChild(shape, "p:txBody"), "a:p")
    .map(paragraph => [...descendants(paragraph, "a:t")].map(textContent).join(""))
    .filter(Boolean).join(" ");
}

