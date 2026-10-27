// Open Packaging Conventions plumbing shared by the Office converters and writers: the namespace
// table every part is parsed with, relationship parts, part-name resolution, XML escaping, and the
// declaration and timestamps written parts share.

import { DocumentConversionError } from "./errors";
import {
  attribute, childElements, firstChild, parseXml, streamElements, type XmlElement, type XmlNode, type XmlOptions,
} from "./xml";
import type { ZipArchive } from "./zip";

/** What the Word and PowerPoint converters return. */
export interface ConvertedMarkdown {
  readonly markdown: string;
  /** Things the conversion left out or approximated, phrased for the reader. */
  readonly warnings: string[];
  /** True when the output budget ran out and later content was dropped. */
  readonly truncated: boolean;
}

/** Options for the Word and PowerPoint converters. */
export interface OfficeConversionOptions {
  /** Stop converting once the output passes this many characters. */
  readonly maxChars?: number;
}

/**
 * The prefixes converters match names with, for both the Transitional namespaces Office writes by
 * default and the Strict (ISO/IEC 29500 Strict) ones it writes when asked. A file may bind any
 * prefix to these URIs; parsing reports the canonical prefix regardless.
 */
const NAMESPACES: Readonly<Record<string, string>> = {
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main": "w",
  "http://purl.oclc.org/ooxml/wordprocessingml/main": "w",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships": "r",
  "http://purl.oclc.org/ooxml/officeDocument/relationships": "r",
  "http://schemas.openxmlformats.org/drawingml/2006/main": "a",
  "http://purl.oclc.org/ooxml/drawingml/main": "a",
  "http://schemas.openxmlformats.org/presentationml/2006/main": "p",
  "http://purl.oclc.org/ooxml/presentationml/main": "p",
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main": "s",
  "http://purl.oclc.org/ooxml/spreadsheetml/main": "s",
  "http://schemas.openxmlformats.org/drawingml/2006/picture": "pic",
  "http://purl.oclc.org/ooxml/drawingml/picture": "pic",
  "http://schemas.openxmlformats.org/drawingml/2006/chart": "c",
  "http://purl.oclc.org/ooxml/drawingml/chart": "c",
  "http://schemas.openxmlformats.org/drawingml/2006/diagram": "dgm",
  "http://purl.oclc.org/ooxml/drawingml/diagram": "dgm",
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing": "wp",
  "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing": "wp",
  "http://schemas.openxmlformats.org/officeDocument/2006/math": "m",
  "http://purl.oclc.org/ooxml/officeDocument/math": "m",
  "http://schemas.openxmlformats.org/markup-compatibility/2006": "mc",
  "http://schemas.openxmlformats.org/package/2006/relationships": "pr",
  "urn:schemas-microsoft-com:vml": "v",
  "urn:schemas-microsoft-com:office:office": "o",
};

const PARSE_OPTIONS: XmlOptions = { namespaces: NAMESPACES, replace: resolveAlternateContent };

/**
 * Markup Compatibility (ECMA-376 Part 3) lets a producer offer alternatives: `mc:AlternateContent`
 * holds `mc:Choice` branches for consumers that understand newer markup and an `mc:Fallback`.
 * Exactly one branch is meant to be read, or text such as a text box's would appear twice. The
 * converters only extract text, which both branches carry, so the first branch is taken.
 */
function resolveAlternateContent(element: XmlElement): readonly XmlNode[] | undefined {
  if (element.name !== "mc:AlternateContent") return undefined;
  const branch = firstChild(element, "mc:Choice") ?? firstChild(element, "mc:Fallback");
  return branch?.children ?? [];
}

/** Parses a whole part. */
export function parsePart(text: string): XmlElement {
  return parseXml(text, PARSE_OPTIONS);
}

/** Streams a part's elements at `depth` (the root is 0) one subtree at a time. */
export function streamPart(text: string, depth: number): Generator<XmlElement> {
  return streamElements(text, depth, PARSE_OPTIONS);
}

/** Reads and parses a part, or returns undefined when the package has no such part. */
export async function readPart(zip: ZipArchive, partName: string): Promise<XmlElement | undefined> {
  if (!zip.has(partName)) return undefined;
  return parsePart(await readPartText(zip, partName));
}

/** A part's text. XML may be UTF-16 with a byte order mark, though Office writes UTF-8. */
export async function readPartText(zip: ZipArchive, partName: string): Promise<string> {
  return zip.readText(partName);
}

/** One relationship from a part's `.rels`. */
export interface Relationship {
  readonly id: string;
  /**
   * The relationship type's last path segment (`styles`, `hyperlink`, `slide`, ...). Transitional
   * and Strict type URIs differ only before it.
   */
  readonly type: string;
  /** For an internal relationship, the resolved part name; for an external one, the target as written. */
  readonly target: string;
  readonly external: boolean;
}

/** A part's relationships by id, empty if the part has none. */
export type Relationships = ReadonlyMap<string, Relationship>;

/** Reads the relationships whose source is `partName` (the package itself when it is ""). */
export async function readRelationships(zip: ZipArchive, partName: string): Promise<Relationships> {
  const root = await readPart(zip, relationshipsPartName(partName));
  const relationships = new Map<string, Relationship>();
  for (const element of childElements(root, "pr:Relationship")) {
    const id = attribute(element, "Id");
    const type = attribute(element, "Type");
    const target = attribute(element, "Target");
    if (!id || !type || target === undefined) continue;
    const external = attribute(element, "TargetMode") === "External";
    relationships.set(id, {
      id,
      type: type.slice(type.lastIndexOf("/") + 1),
      target: external ? target : resolvePartName(partName, target),
      external,
    });
  }
  return relationships;
}

/** The first internal relationship of `type`, if any. */
export function findRelationship(relationships: Relationships, type: string): Relationship | undefined {
  for (const relationship of relationships.values()) {
    if (relationship.type === type && !relationship.external) return relationship;
  }
  return undefined;
}

/** `word/document.xml` → `word/_rels/document.xml.rels`; the package's own is `_rels/.rels`. */
export function relationshipsPartName(partName: string): string {
  const slash = partName.lastIndexOf("/");
  return `${partName.slice(0, slash + 1)}_rels/${partName.slice(slash + 1)}.rels`;
}

/**
 * Resolves a relationship target against its source part, as a ZIP entry name: targets are
 * relative URIs (possibly percent-encoded, possibly climbing with `..`), or absolute from the
 * package root.
 */
export function resolvePartName(sourcePart: string, target: string): string {
  const base = target.startsWith("/") ? [] : sourcePart.split("/").slice(0, -1);
  const segments = [...base];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(safeDecodeUri(segment));
  }
  return segments.join("/");
}

function safeDecodeUri(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The package's main part (`word/document.xml`, `ppt/presentation.xml`, ...), found through the
 * package relationship rather than by its conventional name, which producers need not use.
 */
export async function findMainPart(zip: ZipArchive, conventionalName: string): Promise<string> {
  const relationships = await readRelationships(zip, "");
  const main = findRelationship(relationships, "officeDocument")?.target ?? conventionalName;
  if (!zip.has(main)) throw new DocumentConversionError("corrupt", "The file has no main document part");
  return main;
}

/** ST_OnOff: an element such as `<w:b/>` is on unless its value says otherwise. */
export function isOn(element: XmlElement | undefined, valueAttribute: string): boolean {
  if (!element) return false;
  const value = attribute(element, valueAttribute);
  return value === undefined || !(value === "0" || value === "false" || value === "off");
}

/** The XML declaration every written part starts with. */
export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * `xml` with the relationships namespace declared on its root element when an edit gave a part
 * that never needed it an `r:` attribute: a slide or document without a picture or link may not
 * declare the prefix, and an undeclared prefix is a malformed part.
 */
export function withRelationshipsNs(xml: string): string {
  if (!/\sr:[A-Za-z]+="/.test(xml) || /\sxmlns:r="/.test(xml)) return xml;
  return xml.replace(/<([A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*(?=[\s/>])/, root => `${root} xmlns:r="${RELATIONSHIPS_NS}"`);
}

/** An ISO 8601 timestamp to the second, as core properties and revision marks use. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A character XML 1.0 forbids (a C0 control but tab, newline and return; a lone surrogate; U+FFFE/F). */
// oxlint-disable-next-line no-control-regex -- the characters XML 1.0 can't hold
export const INVALID_XML_CHAR = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const INVALID_XML = new RegExp(INVALID_XML_CHAR.source, "g");

/** Text as XML character data. Characters XML can't hold are dropped. */
export function escapeText(text: string): string {
  return text.replace(INVALID_XML, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Text as a double-quoted XML attribute value. */
export function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;").replace(/\t/g, "&#9;");
}
