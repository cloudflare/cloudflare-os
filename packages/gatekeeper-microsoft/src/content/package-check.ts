// What an Office file the agent passes as bytes may hold. Such a file is shown to the approver as
// its text, if at all, and its upload can be approved automatically, so it gets the limits a file
// written here has by construction: no macros or ActiveX, nothing fetched from elsewhere when it is
// opened (a remote template, linked picture or workbook link), no DDE, no imported HTML or RTF
// chunk (whose fields this can't read), and no formula `checkFormula` refuses. Links people click
// stay allowed, as a written file may have them.
//
// Office finds a part by its content type and the relationship that points at it, never by its
// name, so the check does too: a macro project is one whatever it is called. Every XML part is then
// read with the namespace-aware parser, so a field or formula is found whatever prefix binds it and
// however its text is written.

import { readPartText, resolvePartName } from "./ooxml";
import { checkFormula, FormulaError } from "./xlsx-write";
import { attribute, childElements, parseXml, textContent, XmlError, type XmlElement, type XmlOptions } from "./xml";
import { openZip, ZipError, type ZipArchive } from "./zip";

/** Extensions of Office packages this checks; any other bytes pass through. */
const OFFICE_PACKAGES = new Set(["docx", "xlsx", "pptx", "ppsx", "dotx", "potx", "xltx"]);

/** Content types of parts that run code or reach elsewhere whenever the file is opened. */
const REFUSED_CONTENT_TYPES: readonly [RegExp, string][] = [
  [/^application\/vnd\.ms-office\.vbaProject$/i, "macros"],
  [/^application\/vnd\.ms-excel\.(intl)?macrosheet\+xml$/i, "macros"],
  [/^application\/vnd\.ms-office\.activeX/i, "ActiveX controls"],
  [/^application\/vnd\.openxmlformats-officedocument\.oleObject$/i, "embedded objects"],
  [/^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.externalLink\+xml$/i, "links to other workbooks"],
  [/^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.(connections|queryTable)\+xml$/i, "external data connections"],
];

/** Relationship types (by last segment) that reach such a part, should its content type be mislabeled. */
const REFUSED_RELATIONSHIPS: Readonly<Record<string, string>> = {
  vbaProject: "macros", xlMacrosheet: "macros", xlIntlMacrosheet: "macros", control: "ActiveX controls", oleObject: "embedded objects",
  externalLink: "links to other workbooks", connections: "external data connections", queryTable: "external data connections",
  aFChunk: "imported HTML or RTF content",
};

/** Word fields that run a program or fetch content from elsewhere. */
const REFUSED_FIELD = /^\s*(DDE|DDEAUTO|INCLUDETEXT|INCLUDEPICTURE|IMPORT|LINK)\b/i;

const CONTENT_TYPES_PART = "[Content_Types].xml";

/**
 * Both Markup Compatibility branches are read: Word takes whichever its version supports, so a
 * field in either would run.
 */
const PARSE_OPTIONS: XmlOptions = {
  namespaces: {
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main": "w",
    "http://purl.oclc.org/ooxml/wordprocessingml/main": "w",
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main": "s",
    "http://purl.oclc.org/ooxml/spreadsheetml/main": "s",
    "http://schemas.openxmlformats.org/package/2006/relationships": "pr",
    "http://schemas.openxmlformats.org/package/2006/content-types": "ct",
  },
};

/** Throws an error the agent can act on when `bytes`, an Office file named by `ext`, holds what a written file can't. */
export async function checkOfficePackage(ext: string, bytes: Uint8Array): Promise<void> {
  if (!OFFICE_PACKAGES.has(ext)) return;
  const unreadable = (cause: unknown): Error => new Error(`Those bytes aren't a readable ${ext} file.`, { cause });
  const refuse = (what: string): never => {
    throw new Error(`That ${ext} file has ${what}, which files uploaded here can't have. Remove them, or write the file from ${ext.startsWith("xl") ? "rows or CSV" : "Markdown"} instead.`);
  };
  try {
    const zip = openZip(bytes);
    const contentTypes = await readContentTypes(zip);
    for (const { name } of zip.entries()) {
      if (name.endsWith("/")) continue;
      const contentType = contentTypes(name);
      for (const [pattern, what] of REFUSED_CONTENT_TYPES) if (pattern.test(contentType)) refuse(what);
      if (!isXml(name, contentType)) continue;
      const root = parseXml(await readPartText(zip, name), PARSE_OPTIONS);
      if (name.toLowerCase().endsWith(".rels")) checkRelationships(root, refuse);
      if (hasRefusedField(root)) refuse("DDE or fields that fetch content from elsewhere");
      checkFormulas(root, ext);
    }
  } catch (error) {
    if (error instanceof XmlError && error.code === "limit") throw new Error(`That ${ext} file is too large or too deeply nested to check, so it can't be uploaded here.`, { cause: error });
    if (error instanceof ZipError || error instanceof XmlError) throw unreadable(error);
    throw error;
  }
}

/** The content type of each part, as `[Content_Types].xml` declares it: by override, else by extension. */
async function readContentTypes(zip: ZipArchive): Promise<(name: string) => string> {
  if (!zip.has(CONTENT_TYPES_PART)) throw new ZipError("not-found", "The package has no content types part");
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const element of childElements(parseXml(await readPartText(zip, CONTENT_TYPES_PART), PARSE_OPTIONS))) {
    const contentType = attribute(element, "ContentType") ?? "";
    const extension = attribute(element, "Extension");
    const partName = attribute(element, "PartName");
    if (element.name === "ct:Default" && extension !== undefined) defaults.set(extension.toLowerCase(), contentType);
    else if (element.name === "ct:Override" && partName !== undefined) overrides.set(resolvePartName("", partName).toLowerCase(), contentType);
  }
  return name => overrides.get(name.toLowerCase()) ?? defaults.get(name.slice(name.lastIndexOf(".") + 1).toLowerCase()) ?? "";
}

/** A part is read as XML when it is declared XML, or named as one in case it is declared as nothing. */
function isXml(name: string, contentType: string): boolean {
  return /\+xml$|^(application|text)\/xml$/i.test(contentType) || /\.(xml|rels)$/i.test(name);
}

function checkRelationships(root: XmlElement, refuse: (what: string) => never): void {
  for (const relationship of childElements(root, "pr:Relationship")) {
    const type = attribute(relationship, "Type") ?? "";
    const kind = type.slice(type.lastIndexOf("/") + 1);
    if (Object.hasOwn(REFUSED_RELATIONSHIPS, kind)) refuse(REFUSED_RELATIONSHIPS[kind]!);
    if (attribute(relationship, "TargetMode") === "External" && kind !== "hyperlink") {
      refuse(`content it fetches from elsewhere when opened (${kind || "an external link"})`);
    }
  }
}

/**
 * Whether a part has a refused Word field. A field's instruction can be split across runs, and
 * fields nest, so instruction text is joined in document order and broken at every field boundary.
 */
function hasRefusedField(root: XmlElement): boolean {
  let instructions = "";
  const visit = (element: XmlElement): void => {
    for (const child of element.children) {
      if (typeof child === "string") continue;
      if (child.name === "w:instrText") instructions += textContent(child);
      else if (child.name === "w:fldChar") instructions += "\n";
      else if (child.name === "w:fldSimple") instructions += `\n${attribute(child, "w:instr") ?? ""}\n`;
      visit(child);
    }
  };
  visit(root);
  return instructions.split("\n").some(line => REFUSED_FIELD.test(line));
}

/** Every formula and defined name in a SpreadsheetML part, held to what a written workbook may have. */
function checkFormulas(root: XmlElement, ext: string): void {
  const visit = (element: XmlElement): void => {
    for (const child of element.children) {
      if (typeof child === "string") continue;
      if (child.name === "s:f" || child.name === "s:definedName") {
        const formula = textContent(child);
        if (formula.trim() === "") continue;
        try {
          checkFormula(formula);
        } catch (error) {
          if (error instanceof FormulaError) throw new Error(`That ${ext} file has a formula files uploaded here can't have. ${error.message}`, { cause: error });
          throw error;
        }
      }
      visit(child);
    }
  };
  visit(root);
}
