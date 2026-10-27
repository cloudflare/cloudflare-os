// Structural checks for a PowerPoint package: the things PowerPoint answers with a repair prompt.
// Every part parses, every part has a content type and every content type override a part, every
// relationship and r:id reference resolves, slide/master/layout IDs are unique and in range, slides
// and layouts pair with their masters, notes link both ways, and placeholders match their layout.
// Not imported by production code.

import { expect } from "vitest";
import { parsePart } from "../../src/content/ooxml";
import { relKind } from "../../src/content/pptx-deck";
import { OpcPackage } from "../../src/content/pptx-package";
import { attribute, childAt, childElements, descendants, type XmlElement } from "../../src/content/xml";
import { openZip } from "../../src/content/zip";

export interface ValidatedDeck {
  readonly pkg: OpcPackage;
  readonly presentation: string;
  /** Slide part names in presentation order. */
  readonly slides: string[];
}

function placeholderKey(ph: XmlElement): { type: string; idx: string | undefined } {
  return { type: attribute(ph, "type") ?? "obj", idx: attribute(ph, "idx") };
}

export async function validatePptx(bytes: Uint8Array): Promise<ValidatedDeck> {
  const zip = openZip(bytes);
  const names = zip.entries().map(entry => entry.name).filter(name => !name.endsWith("/"));
  expect(names[0], "[Content_Types].xml comes first").toBe("[Content_Types].xml");
  expect(new Set(names.map(name => name.toLowerCase())).size, "no duplicate entries").toBe(names.length);

  const pkg = await OpcPackage.open(bytes);
  const problems: string[] = [];
  for (const name of pkg.names()) {
    if (!pkg.contentType(name)) problems.push(`${name} has no content type`);
    if (/\.(xml|rels)$/i.test(name)) {
      try {
        parsePart(pkg.text(name)!);
      } catch (error) {
        problems.push(`${name} doesn't parse: ${String(error)}`);
      }
    }
  }
  const types = parsePart(await zip.readText("[Content_Types].xml"));
  for (const override of childElements(types)) {
    const part = attribute(override, "PartName");
    if (part && !pkg.has(decodeURI(part.slice(1)))) problems.push(`override for missing part ${part}`);
  }

  // Relationships: every internal target exists; every r:* reference names a relationship.
  for (const name of ["", ...pkg.names().filter(candidate => !candidate.endsWith(".rels"))]) {
    const relationships = pkg.relationships(name);
    const ids = new Set(relationships.map(relationship => relationship.id));
    if (ids.size !== relationships.length) problems.push(`${name} has duplicate relationship ids`);
    for (const relationship of relationships) {
      if (!relationship.external && !pkg.has(pkg.target(name, relationship))) problems.push(`${name} → missing ${relationship.target}`);
      if (relKind(relationship.type) === "hyperlink" && !relationship.external && !relationship.target.startsWith("#")) {
        problems.push(`${name} has an internal hyperlink to ${relationship.target}`);
      }
    }
    if (name && name.endsWith('.xml')) {
      for (const match of pkg.text(name)!.matchAll(/\br:(?:id|embed|link|pict|dm|lo|qs|cs)="([^"]*)"/g)) {
        if (match[1] && !ids.has(match[1])) problems.push(`${name} references missing relationship ${match[1]}`);
      }
    }
  }

  const main = pkg.relationships("").find(relationship => relKind(relationship.type) === "officeDocument")!;
  const presentation = pkg.target("", main);
  expect(pkg.contentType(presentation)).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml");
  const root = parsePart(pkg.text(presentation)!);
  const presentationRels = new Map(pkg.relationships(presentation).map(relationship => [relationship.id, relationship]));

  // IDs: slides from 256, masters and layouts from 2^31, layouts and masters sharing one space.
  const slideIds = childElements(childAt(root, "p:sldIdLst"), "p:sldId");
  const slides: string[] = [];
  const seenSlideIds = new Set<number>();
  for (const entry of slideIds) {
    const id = Number(attribute(entry, "id"));
    if (!(id >= 256 && id < 2147483648)) problems.push(`slide id ${id} out of range`);
    if (seenSlideIds.has(id)) problems.push(`duplicate slide id ${id}`);
    seenSlideIds.add(id);
    const relationship = presentationRels.get(attribute(entry, "r:id") ?? "");
    if (!relationship || relKind(relationship.type) !== "slide") problems.push(`slide id ${id} has no slide relationship`);
    else slides.push(pkg.target(presentation, relationship));
  }
  const slideRels = [...presentationRels.values()].filter(relationship => relKind(relationship.type) === "slide");
  if (slideRels.length !== slides.length) problems.push(`${slideRels.length} slide relationships for ${slides.length} listed slides`);

  const masterIds = new Set<number>();
  const masters = childElements(childAt(root, "p:sldMasterIdLst"), "p:sldMasterId");
  if (masters.length === 0) problems.push("no slide master");
  for (const entry of masters) {
    const id = Number(attribute(entry, "id"));
    if (!(id >= 2147483648)) problems.push(`master id ${id} out of range`);
    if (masterIds.has(id)) problems.push(`duplicate master/layout id ${id}`);
    masterIds.add(id);
    const master = pkg.target(presentation, presentationRels.get(attribute(entry, "r:id") ?? "")!);
    const masterXml = parsePart(pkg.text(master)!);
    const masterRels = new Map(pkg.relationships(master).map(relationship => [relationship.id, relationship]));
    for (const layoutId of childElements(childAt(masterXml, "p:sldLayoutIdLst"), "p:sldLayoutId")) {
      const value = Number(attribute(layoutId, "id"));
      if (!(value >= 2147483648)) problems.push(`layout id ${value} out of range`);
      if (masterIds.has(value)) problems.push(`duplicate master/layout id ${value}`);
      masterIds.add(value);
      const layout = pkg.target(master, masterRels.get(attribute(layoutId, "r:id") ?? "")!);
      const back = pkg.relationships(layout).filter(relationship => relKind(relationship.type) === "slideMaster");
      if (back.length !== 1 || pkg.target(layout, back[0]!) !== master) problems.push(`${layout} doesn't point back to ${master}`);
    }
  }

  // Slides: one layout each, matching placeholders, unique shape ids, notes linked both ways.
  let anyNotes = false;
  for (const slide of slides) {
    const xml = parsePart(pkg.text(slide)!);
    const relationships = pkg.relationships(slide);
    const layouts = relationships.filter(relationship => relKind(relationship.type) === "slideLayout");
    if (layouts.length !== 1) {
      problems.push(`${slide} has ${layouts.length} layouts`);
      continue;
    }
    const layout = pkg.target(slide, layouts[0]!);
    const layoutPlaceholders = [...descendants(parsePart(pkg.text(layout)!), "p:ph")].map(placeholderKey);
    for (const ph of descendants(xml, "p:ph")) {
      const { type, idx } = placeholderKey(ph);
      const titleLike = type === "title" || type === "ctrTitle";
      const matched = layoutPlaceholders.some(candidate => titleLike
        ? candidate.type === type
        : (idx === undefined || candidate.idx === idx) && (candidate.type === type || (type === "obj" && candidate.type === "body") || (type === "body" && candidate.type === "obj")));
      if (!matched) problems.push(`${slide} placeholder ${type}/${idx} isn't on ${layout}`);
    }
    const shapeIds = [...descendants(childAt(xml, "p:cSld", "p:spTree"), "p:cNvPr")].map(element => attribute(element, "id"));
    if (new Set(shapeIds).size !== shapeIds.length) problems.push(`${slide} has duplicate shape ids`);
    const notes = relationships.filter(relationship => relKind(relationship.type) === "notesSlide");
    if (notes.length > 1) problems.push(`${slide} has ${notes.length} notes slides`);
    for (const relationship of notes) {
      anyNotes = true;
      const part = pkg.target(slide, relationship);
      const back = pkg.relationships(part);
      if (!back.some(candidate => relKind(candidate.type) === "slide" && pkg.target(part, candidate) === slide)) problems.push(`${part} doesn't point back to ${slide}`);
      if (!back.some(candidate => relKind(candidate.type) === "notesMaster")) problems.push(`${part} has no notes master`);
    }
  }
  if (anyNotes && childElements(childAt(root, "p:notesMasterIdLst"), "p:notesMasterId").length !== 1) problems.push("notes without a notesMasterIdLst");

  // Element order PowerPoint is strict about.
  for (const name of pkg.names().filter(candidate => candidate.endsWith('.xml'))) {
    const text = pkg.text(name)!;
    for (const rPr of text.match(/<a:(?:rPr|defRPr|endParaRPr)\b[^>]*[^/]>[\s\S]*?<\/a:(?:rPr|defRPr|endParaRPr)>/g) ?? []) {
      if (/<a:(hlinkClick|latin|cs)\b[\s\S]*<a:solidFill/.test(rPr) || /<a:hlinkClick\b[\s\S]*<a:(latin|ea|cs)\b/.test(rPr)) problems.push(`${name}: rPr children out of order: ${rPr.slice(0, 120)}`);
    }
    // presentation.xml's children in schema order.
    if (name === presentation) {
      const order = ["sldMasterIdLst", "notesMasterIdLst", "handoutMasterIdLst", "sldIdLst", "sldSz", "notesSz", "custShowLst", "defaultTextStyle", "extLst"];
      const seen = childElements(root).map(element => element.name.replace(/^p:/, "")).filter(local => order.includes(local));
      const sorted = [...seen].toSorted((a, b) => order.indexOf(a) - order.indexOf(b));
      if (seen.join() !== sorted.join()) problems.push(`presentation.xml children out of order: ${seen.join(", ")}`);
    }
  }

  expect(problems).toEqual([]);
  return { pkg, presentation, slides };
}

/** A slide's placeholders and text boxes as `type: text` lines, for asserting what landed where. */
export function slideShapes(pkg: OpcPackage, slide: string): string[] {
  const out: string[] = [];
  for (const shape of descendants(childAt(parsePart(pkg.text(slide)!), "p:cSld", "p:spTree"), "p:sp")) {
    const ph = childAt(shape, "p:nvSpPr", "p:nvPr", "p:ph");
    const kind = ph ? attribute(ph, "type") ?? "obj" : "box";
    const text = childElements(childAt(shape, "p:txBody"), "a:p")
      .map(paragraph => [...descendants(paragraph, "a:t")].map(element => element.children.join("")).join("")).join(" / ");
    out.push(`${kind}: ${text}`);
  }
  return out;
}

/** The layout type a slide uses. */
export function slideLayoutType(pkg: OpcPackage, slide: string): string {
  const relationship = pkg.relationships(slide).find(candidate => relKind(candidate.type) === "slideLayout")!;
  return /<p:sldLayout\b[^>]*\btype="([^"]+)"/.exec(pkg.text(pkg.target(slide, relationship))!)?.[1] ?? "cust";
}
