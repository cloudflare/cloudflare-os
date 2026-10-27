// Structural checks for a written or edited Word package: what Word's own validator objects to and
// what makes it offer to "repair" a file. Every part parses; content types and relationships cover
// every part; properties appear in schema order; ids are unique; and every style, numbering and
// relationship a part refers to exists.

import { expect } from "vitest";
import { parsePart } from "../../src/content/ooxml";
import { attribute, childElements, descendants, firstChild, type XmlElement } from "../../src/content/xml";
import { openZip } from "../../src/content/zip";

const ORDERS: Record<string, readonly string[]> = {
  "w:pPr": ["pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl", "numPr", "suppressLineNumbers", "pBdr", "shd",
    "tabs", "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi",
    "adjustRightInd", "snapToGrid", "spacing", "ind", "contextualSpacing", "mirrorIndents", "suppressOverlap", "jc", "textDirection",
    "textAlignment", "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr", "sectPr", "pPrChange"],
  "w:rPr": ["ins", "del", "moveFrom", "moveTo", "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline",
    "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz", "szCs",
    "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath"],
  "w:tblPr": ["tblStyle", "tblpPr", "tblOverlap", "bidiVisual", "tblStyleRowBandSize", "tblStyleColBandSize", "tblW", "jc", "tblCellSpacing",
    "tblInd", "tblBorders", "shd", "tblLayout", "tblCellMar", "tblLook", "tblCaption", "tblDescription"],
  "w:trPr": ["cnfStyle", "divId", "gridBefore", "gridAfter", "wBefore", "wAfter", "cantSplit", "trHeight", "tblHeader", "tblCellSpacing", "jc", "hidden", "ins", "del", "trPrChange"],
  "w:tcPr": ["cnfStyle", "tcW", "gridSpan", "hMerge", "vMerge", "tcBorders", "shd", "noWrap", "tcMar", "textDirection", "tcFitText", "vAlign", "hideMark"],
  "w:sectPr": ["headerReference|footerReference", "footnotePr", "endnotePr", "type", "pgSz", "pgMar", "paperSrc", "pgBorders", "lnNumType", "pgNumType",
    "cols", "formProt", "vAlign", "noEndnote", "titlePg", "textDirection", "bidi", "rtlGutter", "docGrid", "printerSettings", "sectPrChange"],
  "w:style": ["name", "aliases", "basedOn", "next", "link", "autoRedefine", "hidden", "uiPriority", "semiHidden", "unhideWhenUsed", "qFormat",
    "locked", "personal", "personalCompose", "personalReply", "rsid", "pPr", "rPr", "tblPr", "trPr", "tcPr", "tblStylePr"],
  "w:tblStylePr": ["pPr", "rPr", "tblPr", "trPr", "tcPr"],
  "w:lvl": ["start", "numFmt", "lvlRestart", "pStyle", "isLgl", "suff", "lvlText", "lvlPicBulletId", "legacy", "lvlJc", "pPr", "rPr"],
  "w:abstractNum": ["nsid", "multiLevelType", "tmpl", "name", "styleLink", "numStyleLink", "lvl"],
  "w:numbering": ["numPicBullet", "abstractNum", "num", "numIdMacAtCleanup"],
  "w:num": ["abstractNumId", "lvlOverride"],
  "w:lvlOverride": ["startOverride", "lvl"],
  "w:numPr": ["ilvl", "numId"],
  "w:styles": ["docDefaults", "latentStyles", "style"],
  "w:tbl": ["tblPr", "tblGrid", "tr"],
  "w:tr": ["tblPrEx", "trPr", "tc"],
  "w:tblBorders": ["top", "left", "start", "bottom", "right", "end", "insideH", "insideV"],
  "w:tcBorders": ["top", "left", "start", "bottom", "right", "end", "insideH", "insideV", "tl2br", "tr2bl"],
  "w:pBdr": ["top", "left", "bottom", "right", "between", "bar"],
};

function checkOrder(element: XmlElement, path: string): void {
  const order = ORDERS[element.name];
  if (order) {
    let previous = -1;
    for (const child of childElements(element)) {
      const local = child.name.slice(child.name.indexOf(":") + 1);
      const index = order.findIndex(entry => entry.split("|").includes(local));
      if (index === -1) continue;
      expect(index, `${path}/${element.name}: ${local} is out of order`).toBeGreaterThanOrEqual(previous);
      previous = index;
    }
  }
  const first = childElements(element)[0];
  if (element.name === "w:p" && firstChild(element, "w:pPr")) expect(first?.name, `${path}: pPr must come first`).toBe("w:pPr");
  if (element.name === "w:r" && firstChild(element, "w:rPr")) expect(first?.name, `${path}: rPr must come first`).toBe("w:rPr");
  if (element.name === "w:tc") {
    if (firstChild(element, "w:tcPr")) expect(first?.name).toBe("w:tcPr");
    expect(childElements(element).at(-1)?.name, `${path}: a cell must end with a paragraph`).toBe("w:p");
  }
  for (const child of childElements(element)) checkOrder(child, `${path}/${element.name}`);
}

/** Every structural check, returning the parsed main parts for further assertions. */
export async function validateDocx(bytes: Uint8Array, options: { missingStyles?: readonly string[] } = {}): Promise<{ document: XmlElement; styles: XmlElement; numbering: XmlElement | undefined; parts: Map<string, string> }> {
  const zip = openZip(bytes);
  const parts = new Map<string, string>();
  for (const entry of zip.entries()) {
    if (/\.(xml|rels)$/i.test(entry.name)) parts.set(entry.name, await zip.readText(entry.name));
  }
  const parsed = new Map([...parts].map(([name, text]) => [name, parsePart(text)]));
  expect([...parts.keys()][0], "[Content_Types].xml should lead the package").toBe("[Content_Types].xml");

  // Content types cover every part.
  const types = parsed.get("[Content_Types].xml")!;
  const defaults = new Set(childElements(types).filter(element => element.name.endsWith("Default")).map(element => attribute(element, "Extension")!.toLowerCase()));
  const overrides = new Map(childElements(types).filter(element => element.name.endsWith("Override"))
    .map(element => [attribute(element, "PartName")!.replace(/^\//, "").toLowerCase(), attribute(element, "ContentType")!]));
  for (const entry of zip.entries()) {
    if (entry.name === "[Content_Types].xml" || entry.name.endsWith("/")) continue;
    const extension = entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase();
    expect(overrides.has(entry.name.toLowerCase()) || defaults.has(extension), `no content type for ${entry.name}`).toBe(true);
  }
  for (const name of overrides.keys()) expect(zip.has(name), `override for missing part ${name}`).toBe(true);

  // Relationships resolve, and their ids are unique.
  for (const [name, root] of parsed) {
    if (!name.endsWith(".rels")) continue;
    const ids = childElements(root, "pr:Relationship").map(element => attribute(element, "Id"));
    expect(new Set(ids).size, `duplicate relationship ids in ${name}`).toBe(ids.length);
    const source = name.replace(/_rels\/([^/]*)\.rels$/, "$1");
    const directory = source.slice(0, source.lastIndexOf("/") + 1);
    for (const relationship of childElements(root, "pr:Relationship")) {
      if (attribute(relationship, "TargetMode") === "External") continue;
      const target = attribute(relationship, "Target")!;
      const resolved = target.startsWith("/") ? target.slice(1) : normalize(directory + target);
      expect(zip.has(resolved), `${name} points at missing ${resolved}`).toBe(true);
    }
  }

  const document = parsed.get("word/document.xml")!;
  const styles = parsed.get("word/styles.xml")!;
  const numbering = parsed.get("word/numbering.xml");
  for (const [name, root] of [["document", document], ["styles", styles], ["numbering", numbering]] as const) {
    if (root) checkOrder(root, name);
  }
  const body = firstChild(document, "w:body")!;
  const blocks = childElements(body);
  expect(blocks.at(-1)?.name, "the body ends with its section properties").toBe("w:sectPr");
  if (blocks.length > 1) expect(blocks.at(-2)?.name, "a paragraph precedes the section properties").toBe("w:p");
  blocks.forEach((block, index) => {
    if (block.name === "w:tbl") expect(blocks[index + 1]?.name, "tables must not touch").not.toBe("w:tbl");
  });

  // Ids are unique, and everything referred to exists.
  const styleIds = childElements(styles, "w:style").map(style => attribute(style, "w:styleId")!);
  expect(new Set(styleIds).size, "duplicate style ids").toBe(styleIds.length);
  for (const type of ["paragraph", "character", "table", "numbering"]) {
    const defaultsOfType = childElements(styles, "w:style").filter(style => (attribute(style, "w:type") ?? "paragraph") === type && ["1", "true"].includes(attribute(style, "w:default") ?? ""));
    expect(defaultsOfType.length, `more than one default ${type} style`).toBeLessThanOrEqual(1);
  }
  for (const reference of ["w:pStyle", "w:rStyle", "w:tblStyle", "w:basedOn", "w:next"]) {
    for (const root of [document, styles]) {
      for (const element of descendants(root, reference)) {
        const id = attribute(element, "w:val")!;
        if (!options.missingStyles?.includes(id)) expect(styleIds, `${reference} refers to a missing style`).toContain(id);
      }
    }
  }
  const numIds = childElements(numbering, "w:num").map(num => attribute(num, "w:numId")!);
  const abstractIds = childElements(numbering, "w:abstractNum").map(abstract => attribute(abstract, "w:abstractNumId")!);
  expect(new Set(numIds).size, "duplicate numIds").toBe(numIds.length);
  expect(new Set(abstractIds).size, "duplicate abstractNumIds").toBe(abstractIds.length);
  for (const num of childElements(numbering, "w:num")) expect(abstractIds).toContain(attribute(firstChild(num, "w:abstractNumId"), "w:val"));
  for (const numId of descendants(document, "w:numId")) {
    const value = attribute(numId, "w:val")!;
    if (value !== "0") expect(numIds, `numId ${value} is not defined`).toContain(value);
  }
  const revisionIds = ["w:ins", "w:del", "w:moveFrom", "w:moveTo"].flatMap(name => Array.from(descendants(document, name), element => attribute(element, "w:id")));
  expect(new Set(revisionIds).size, "duplicate revision ids").toBe(revisionIds.length);
  const documentRelationships = new Set(childElements(parsed.get("word/_rels/document.xml.rels"), "pr:Relationship").map(element => attribute(element, "Id")));
  for (const text of [parts.get("word/document.xml")!]) {
    for (const match of text.matchAll(/\br:(?:id|embed|link)="([^"]+)"/g)) expect(documentRelationships, `missing relationship ${match[1]}`).toContain(match[1]);
  }
  return { document, styles, numbering, parts };
}

function normalize(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment && segment !== ".") segments.push(decodeURIComponent(segment));
  }
  return segments.join("/");
}
