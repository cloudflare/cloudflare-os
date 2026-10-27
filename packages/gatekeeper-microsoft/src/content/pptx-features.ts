// What rewriting a deck from Markdown would lose: everything the Markdown writer can't produce, so an
// agent asked to rewrite a deck wholesale can say what will go, or edit in place instead.

import { parsePart } from "./ooxml";
import { relKind } from "./pptx-deck";
import { OpcPackage } from "./pptx-package";
import { attribute, childAt, descendants, textContent } from "./xml";

/** Layout types the Markdown writer makes slides from; a slide on any other loses its arrangement. */
const WRITTEN_LAYOUTS = new Set(["title", "obj", "tx", "titleOnly", "blank"]);

/**
 * Lists what a Markdown rewrite of the deck would drop, as short phrases ("3 images", "charts",
 * "speaker notes"); empty when nothing would be. Throws `PackageError` or `ZipError` for a file
 * that isn't an Office package.
 */
export async function pptxFeatures(bytes: Uint8Array): Promise<string[]> {
  const pkg = await OpcPackage.open(bytes);
  const main = pkg.relationships("").find(relationship => relKind(relationship.type) === "officeDocument" && !relationship.external);
  if (!main) return [];
  const presentation = pkg.target("", main);
  const slides = pkg.relationships(presentation).filter(relationship => relKind(relationship.type) === "slide" && !relationship.external)
    .map(relationship => pkg.target(presentation, relationship)).filter(part => pkg.has(part));

  const images = new Set<string>();
  const found = new Set<string>();
  for (const slide of slides) {
    const xml = pkg.text(slide) ?? "";
    for (const relationship of pkg.relationships(slide)) {
      const kind = relKind(relationship.type);
      const target = relationship.external ? relationship.target : pkg.target(slide, relationship);
      if (kind === "image") images.add(target);
      else if (kind === "chart" || kind === "chartEx") found.add("charts");
      else if (kind === "diagramData") found.add("SmartArt");
      else if (kind === "video" || kind === "audio" || kind === "media") found.add("videos or audio");
      else if (kind === "oleObject" || kind === "package") found.add("embedded objects");
      else if (kind === "comments") found.add("comments");
      else if (kind === "notesSlide" && !relationship.external && hasNotesText(pkg.text(target) ?? "")) found.add("speaker notes");
      else if (kind === "slideLayout" && !relationship.external) {
        const layout = attribute(parsePart(pkg.text(target) ?? "<p:sldLayout/>"), "type") ?? "cust";
        if (!WRITTEN_LAYOUTS.has(layout)) found.add("custom layouts");
      }
    }
    if (/<p:timing\b/.test(xml)) found.add("animations");
    if (/<p:transition\b/.test(xml)) found.add("transitions");
    if (/<p:oleObj\b/.test(xml)) found.add("embedded objects");
    if (/<p:sld\b[^>]*\bshow="(0|false)"/.test(xml)) found.add("hidden slides");
  }
  const order = ["charts", "SmartArt", "videos or audio", "animations", "transitions", "speaker notes", "custom layouts", "embedded objects", "comments", "hidden slides"];
  return [
    ...(images.size ? [`${images.size} ${images.size === 1 ? "image" : "images"}`] : []),
    ...order.filter(feature => found.has(feature)),
  ];
}

/** Whether a notes slide's notes placeholder holds any text. */
function hasNotesText(xml: string): boolean {
  for (const shape of descendants(parsePart(xml), "p:sp")) {
    if (attribute(childAt(shape, "p:nvSpPr", "p:nvPr", "p:ph"), "type") !== "body") continue;
    if ([...descendants(shape, "a:t")].some(text => textContent(text).trim())) return true;
  }
  return false;
}
