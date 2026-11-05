// Open Packaging Conventions, for writing: a package held as its parts, with the content-type table
// and relationship parts kept as data so the PowerPoint writer and editor can add, drop and
// rewire parts without leaving a dangling reference (which Office answers with a repair prompt).
// Part names are ZIP entry names: no leading slash, case as written.

import { escapeAttribute, parsePart, relationshipsPartName, resolvePartName, XML_DECLARATION } from "./ooxml";
import { decodeText } from "./text";
import { attribute, childElements } from "./xml";
import { openZip, type ZipLimits } from "./zip";
import { writeZip } from "./zip-write";

/** One relationship, with its target as written (relative to the source part, or external). */
export interface PackageRelationship {
  readonly id: string;
  /** The full type URI. */
  readonly type: string;
  readonly target: string;
  readonly external?: boolean;
}

/** Relationship type URIs, by their last segment. */
export const REL = {
  officeDocument: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  coreProperties: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
  extendedProperties: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
  slide: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
  slideLayout: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout",
  slideMaster: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster",
  notesSlide: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide",
  notesMaster: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster",
  theme: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme",
  presProps: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps",
  viewProps: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps",
  tableStyles: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles",
  hyperlink: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
} as const;

/** Content types the writer emits. */
export const CONTENT_TYPE = {
  relationships: "application/vnd.openxmlformats-package.relationships+xml",
  xml: "application/xml",
  presentation: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  slide: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
  slideLayout: "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
  slideMaster: "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
  notesSlide: "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml",
  notesMaster: "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml",
  theme: "application/vnd.openxmlformats-officedocument.theme+xml",
  presProps: "application/vnd.openxmlformats-officedocument.presentationml.presProps+xml",
  viewProps: "application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml",
  tableStyles: "application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml",
  coreProperties: "application/vnd.openxmlformats-package.core-properties+xml",
  extendedProperties: "application/vnd.openxmlformats-officedocument.extended-properties+xml",
} as const;

const CONTENT_TYPES_PART = "[Content_Types].xml";

/** A package's parts, content types and relationships, editable and writable. */
export class OpcPackage {
  readonly #parts = new Map<string, Uint8Array | string>();
  readonly #defaults = new Map<string, string>();
  readonly #overrides = new Map<string, string>();

  /** An empty package: only the XML and relationship defaults every package has. */
  static empty(): OpcPackage {
    const pkg = new OpcPackage();
    pkg.#defaults.set("rels", CONTENT_TYPE.relationships);
    pkg.#defaults.set("xml", CONTENT_TYPE.xml);
    return pkg;
  }

  /** Reads every part of an existing package. */
  static async open(bytes: Uint8Array, limits?: Partial<ZipLimits>): Promise<OpcPackage> {
    const zip = openZip(bytes, limits);
    const pkg = new OpcPackage();
    for (const entry of zip.entries()) {
      if (entry.name.endsWith("/")) continue;
      pkg.#parts.set(entry.name, await zip.readBytes(entry.name));
    }
    const types = pkg.#parts.get(CONTENT_TYPES_PART);
    if (types === undefined) throw new PackageError("The file isn't an Office document: it has no content types.");
    const root = parsePart(typeof types === "string" ? types : decodeText(types));
    for (const element of childElements(root)) {
      const local = element.name.slice(element.name.indexOf("}") + 1);
      const contentType = attribute(element, "ContentType");
      if (!contentType) continue;
      if (local === "Default" && attribute(element, "Extension")) {
        pkg.#defaults.set(attribute(element, "Extension")!.toLowerCase(), contentType);
      } else if (local === "Override" && attribute(element, "PartName")) {
        pkg.#overrides.set(attribute(element, "PartName")!.replace(/^\//, ""), contentType);
      }
    }
    pkg.#parts.delete(CONTENT_TYPES_PART);
    return pkg;
  }

  /** Whether the package has a part of this name, compared case-insensitively. */
  has(name: string): boolean {
    return this.#find(name) !== undefined;
  }

  /** Every part name, in the order they were added or read. */
  names(): string[] {
    return [...this.#parts.keys()];
  }

  /** A part as text, or undefined when there is none. */
  text(name: string): string | undefined {
    const key = this.#find(name);
    if (key === undefined) return undefined;
    const data = this.#parts.get(key)!;
    return typeof data === "string" ? data : decodeText(data);
  }

  /** A part as bytes (text parts encoded as UTF-8), or undefined when there is none. */
  bytes(name: string): Uint8Array | undefined {
    const key = this.#find(name);
    if (key === undefined) return undefined;
    const data = this.#parts.get(key)!;
    return typeof data === "string" ? new TextEncoder().encode(data) : data;
  }

  /** Writes a part, with its own content type override when it has one. */
  set(name: string, data: Uint8Array | string, contentType?: string): void {
    const key = this.#find(name) ?? name;
    this.#parts.set(key, data);
    if (contentType !== undefined) this.#overrides.set(key, contentType);
  }

  /** Removes a part, its override and its relationships part. */
  delete(name: string): void {
    const key = this.#find(name);
    if (key === undefined) return;
    this.#parts.delete(key);
    for (const override of this.#overrides.keys()) {
      if (override.toLowerCase() === key.toLowerCase()) this.#overrides.delete(override);
    }
    const rels = relationshipsPartName(key);
    if (this.has(rels)) this.delete(rels);
  }

  /** The content type a part is served as. */
  contentType(name: string): string | undefined {
    const key = this.#find(name) ?? name;
    for (const [part, type] of this.#overrides) if (part.toLowerCase() === key.toLowerCase()) return type;
    const extension = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
    return this.#defaults.get(extension);
  }

  /** Declares a part's content type by override, replacing any it has. */
  setOverride(name: string, contentType: string): void {
    this.#overrides.set(this.#find(name) ?? name, contentType);
  }

  /** Declares the content type of parts with `extension`, unless the package already declares one. */
  setDefault(extension: string, contentType: string): void {
    if (!this.#defaults.has(extension.toLowerCase())) this.#defaults.set(extension.toLowerCase(), contentType);
  }

  /** The relationships whose source is `partName` ("" for the package). */
  relationships(partName: string): PackageRelationship[] {
    const text = this.text(relationshipsPartName(partName));
    if (text === undefined) return [];
    const out: PackageRelationship[] = [];
    for (const element of childElements(parsePart(text))) {
      const id = attribute(element, "Id"), type = attribute(element, "Type"), target = attribute(element, "Target");
      if (!id || !type || target === undefined) continue;
      out.push({ id, type, target, ...(attribute(element, "TargetMode") === "External" ? { external: true } : {}) });
    }
    return out;
  }

  /** Replaces the relationships of `partName`, dropping the part when there are none. */
  setRelationships(partName: string, relationships: readonly PackageRelationship[]): void {
    const name = relationshipsPartName(partName);
    if (relationships.length === 0) {
      this.delete(name);
      return;
    }
    this.set(name, relationshipsXml(relationships));
  }

  /** The part an internal relationship of `partName` points to. */
  target(partName: string, relationship: PackageRelationship): string {
    return resolvePartName(partName, relationship.target);
  }

  /** Adds a relationship from `source` to `target` (a part name or an external URL), returning its id. */
  relate(source: string, type: string, target: string, external = false): string {
    const existing = this.relationships(source);
    const used = new Set(existing.map(relationship => relationship.id));
    let index = existing.length + 1;
    while (used.has(`rId${index}`)) index++;
    const id = `rId${index}`;
    this.setRelationships(source, [...existing, { id, type, target: external ? target : relativeTarget(source, target), ...(external ? { external } : {}) }]);
    return id;
  }

  /** A part name not yet in use: `ppt/slides/slide` + n + `.xml`, with the lowest free n ≥ 1. */
  freeName(prefix: string, suffix: string): string {
    for (let index = 1; ; index++) {
      const name = `${prefix}${index}${suffix}`;
      if (!this.has(name)) return name;
    }
  }

  /** Writes the package as a ZIP: content types first, as Office does. */
  async toBytes(modifiedAt?: Date): Promise<Uint8Array> {
    const entries = [{ name: CONTENT_TYPES_PART, data: this.#contentTypesXml() }];
    for (const [name, data] of this.#parts) entries.push({ name, data: data as string });
    return await writeZip(entries, modifiedAt);
  }

  #contentTypesXml(): string {
    const defaults = [...this.#defaults].map(([extension, type]) =>
      `<Default Extension="${escapeAttribute(extension)}" ContentType="${escapeAttribute(type)}"/>`);
    // An override for a part that is gone would make Office report the package as damaged.
    const overrides = [...this.#overrides]
      .filter(([name]) => this.#find(name) !== undefined)
      .map(([name, type]) => `<Override PartName="/${escapeAttribute(encodePartName(name))}" ContentType="${escapeAttribute(type)}"/>`);
    return `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.join("")}${overrides.join("")}</Types>`;
  }

  /** The stored name for `name`, matched case-insensitively as OPC requires. */
  #find(name: string): string | undefined {
    if (this.#parts.has(name)) return name;
    const lower = name.toLowerCase();
    for (const key of this.#parts.keys()) if (key.toLowerCase() === lower) return key;
    return undefined;
  }
}

/** A package that can't be read or rewritten. The message is safe to show the agent. */
export class PackageError extends Error {
  override readonly name = "PackageError";
}

/**
 * The relative URI from `source`'s folder to `target`, as relationships write it. Both are part
 * names as the package stores them: no leading slash, folders separated by `/`.
 */
export function relativeTarget(source: string, target: string): string {
  const from = source.split("/").slice(0, -1);
  const to = target.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return [...Array.from({ length: from.length - common }, () => ".."), ...to.slice(common)].map(encodePartName).join("/");
}

function encodePartName(name: string): string {
  return name.split("/").map(segment => segment === ".." ? segment : encodeURI(segment).replace(/[?#]/g, encodeURIComponent)).join("/");
}

function relationshipsXml(relationships: readonly PackageRelationship[]): string {
  const items = relationships.map(relationship =>
    `<Relationship Id="${escapeAttribute(relationship.id)}" Type="${escapeAttribute(relationship.type)}" ` +
    `Target="${escapeAttribute(relationship.target)}"${relationship.external ? ' TargetMode="External"' : ""}/>`);
  return `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join("")}</Relationships>`;
}

