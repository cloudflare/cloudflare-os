// What rewriting a Word document from Markdown would lose. A Markdown rewrite keeps headings,
// paragraphs, emphasis, links, lists and tables; this names everything else the document has, in
// words an approver understands ("3 images", "2 comments"), so a wholesale replacement is never
// approved without knowing what goes with it. The body is read a block at a time through the
// parser, so a hostile part costs no more than reading it does.

import { findMainPart, isOn, readPart, readPartText, readRelationships, streamPart } from "./ooxml";
import { attribute, descendants, textContent, type XmlElement } from "./xml";
import { openZip } from "./zip";

/** Phrases for what a Markdown rewrite of the document would drop, most significant first. */
export async function docxFeatures(bytes: Uint8Array): Promise<string[]> {
  const zip = openZip(bytes);
  const mainPart = await findMainPart(zip, "word/document.xml");
  const relationships = [...(await readRelationships(zip, mainPart)).values()];
  const found = new Tally();
  // The body's blocks sit at depth 2 (document > body > block); parsing resolves the fallback copy of a text box or picture away.
  for (const block of streamPart(await readPartText(zip, mainPart), 2)) found.visit(block, 0);
  const features: string[] = [];
  const add = (n: number, singular: string, plural = `${singular}s`): void => {
    if (n > 0) features.push(`${n} ${n === 1 ? singular : plural}`);
  };

  const comments = relationships.find(relationship => relationship.type === "comments");
  add(comments ? [...descendants(await readPart(zip, comments.target), "w:comment")].length : 0, "comment");
  if (found.trackedChanges) features.push("unaccepted tracked changes");
  add(found.count("pic:pic") + found.count("v:imagedata"), "image");
  add(found.count("c:chart"), "chart");
  add(found.count("dgm:relIds"), "SmartArt diagram");
  add(found.count("w:txbxContent"), "text box", "text boxes");
  add(found.count("w:object"), "embedded object");
  add(found.count("m:oMath"), "equation");
  add(found.count("w:footnoteReference"), "footnote");
  add(found.count("w:endnoteReference"), "endnote");
  if (relationships.some(relationship => relationship.type === "header" || relationship.type === "footer")) features.push("headers and footers");
  if (found.tableOfContents) features.push("a table of contents");
  if (found.crossReferences) features.push("cross-references");
  add(found.count("w:sdt") - found.tableOfContentsControls, "content control");
  if (found.mergedCells) features.push("merged table cells");
  if (found.nestedTables) features.push("nested tables");
  const sections = found.count("w:sectPr");
  if (sections > 1) features.push(`${sections} sections`);
  if (found.landscape) features.push("landscape pages");
  if (found.columns) features.push("multiple columns");
  if (found.colors) features.push("text colors and highlighting");
  if (found.decoration) features.push("underline, capitals or superscript formatting");
  if (found.shading) features.push("shading");
  if (found.bookmarks) features.push("bookmarks");
  if (zip.entries().some(entry => /vbaProject\.bin$/i.test(entry.name))) features.push("macros");
  if (zip.entries().some(entry => entry.name.startsWith("_xmlsignatures/"))) features.push("a digital signature");
  return features;
}

/** Field instructions that are a table of contents or a cross-reference. */
const TOC_FIELD = /^\s*TOC\b/;
const REFERENCE_FIELD = /^\s*(REF|PAGEREF|NOTEREF)\b/;

/** What one pass over the body's elements finds. */
class Tally {
  readonly #counts = new Map<string, number>();
  trackedChanges = false;
  tableOfContents = false;
  tableOfContentsControls = 0;
  crossReferences = false;
  mergedCells = false;
  nestedTables = false;
  landscape = false;
  columns = false;
  colors = false;
  decoration = false;
  shading = false;
  bookmarks = false;

  count(name: string): number {
    return this.#counts.get(name) ?? 0;
  }

  /** @param cells How many table cells enclose `element`: a table inside one is nested. */
  visit(element: XmlElement, cells: number): void {
    this.#counts.set(element.name, this.count(element.name) + 1);
    const value = attribute(element, "w:val") ?? "";
    switch (element.name) {
      case "w:ins": case "w:del": case "w:moveFrom": case "w:moveTo":
        if (attribute(element, "w:author") !== undefined) this.trackedChanges = true;
        break;
      case "w:pPrChange": case "w:rPrChange": this.trackedChanges = true; break;
      case "w:instrText": {
        const instruction = textContent(element);
        if (TOC_FIELD.test(instruction)) this.tableOfContents = true;
        if (REFERENCE_FIELD.test(instruction)) this.crossReferences = true;
        break;
      }
      case "w:fldSimple": if (TOC_FIELD.test(attribute(element, "w:instr") ?? "")) this.tableOfContents = true; break;
      case "w:docPartGallery":
        if (value === "Table of Contents") {
          this.tableOfContents = true;
          this.tableOfContentsControls++;
        }
        break;
      case "w:gridSpan": if (Number(value) >= 2) this.mergedCells = true; break;
      case "w:vMerge": this.mergedCells = true; break;
      case "w:tbl": if (cells > 0) this.nestedTables = true; break;
      case "w:pgSz": if (attribute(element, "w:orient") === "landscape") this.landscape = true; break;
      case "w:cols": if (Number(attribute(element, "w:num")) >= 2) this.columns = true; break;
      case "w:color": if (/^[0-9A-Fa-f]{6}$/.test(value) && !/^000000$/i.test(value)) this.colors = true; break;
      case "w:highlight": this.colors = true; break;
      case "w:u": if (value !== "" && value !== "none") this.decoration = true; break;
      case "w:caps": case "w:smallCaps": if (isOn(element, "w:val")) this.decoration = true; break;
      case "w:vertAlign": if (value === "superscript" || value === "subscript") this.decoration = true; break;
      case "w:shd": {
        const fill = attribute(element, "w:fill") ?? "";
        if (/^[0-9A-Fa-f]{6}$/.test(fill) && !/^FFFFFF$/i.test(fill)) this.shading = true;
        break;
      }
      case "w:bookmarkStart": if (attribute(element, "w:name") !== "_GoBack") this.bookmarks = true; break;
    }
    const inside = element.name === "w:tc" ? cells + 1 : cells;
    for (const child of element.children) if (typeof child !== "string") this.visit(child, inside);
  }
}
