// Editing a Word package in place: parts are replaced or added by name, and everything else is
// copied through with its bytes unchanged, so a document's custom XML, embedded media, signatures
// of parts the edit didn't touch, and anything this module doesn't understand all survive. The
// relationships and content-type parts are edited as text, adding to or removing from what is there.

import { REL_TYPE } from "./docx-xml";
import { attribute, childElements } from "./xml";
import { escapeAttribute, parsePart, readPartText, relationshipsPartName, XML_DECLARATION } from "./ooxml";
import { writeZip, type ZipWriteEntry } from "./zip-write";
import type { ZipArchive } from "./zip";

/** The content types of the Word parts this module writes. */
export const CONTENT_TYPES = {
  document: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  template: "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
  macroDocument: "application/vnd.ms-word.document.macroEnabled.main+xml",
  macroTemplate: "application/vnd.ms-word.template.macroEnabledTemplate.main+xml",
  styles: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
  numbering: "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
  settings: "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml",
  fontTable: "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml",
  theme: "application/vnd.openxmlformats-officedocument.theme+xml",
  core: "application/vnd.openxmlformats-package.core-properties+xml",
  app: "application/vnd.openxmlformats-officedocument.extended-properties+xml",
  relationships: "application/vnd.openxmlformats-package.relationships+xml",
} as const;

/** One part's relationships, as text that new relationships are appended to. */
export class RelationshipsEditor {
  #text: string;
  readonly #ids: Set<string>;
  readonly #targets = new Map<string, string>();
  #changed = false;

  /** @param text The `.rels` part, or undefined when the source part has none yet. */
  constructor(text: string | undefined) {
    this.#text = text ?? `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    this.#changed = text === undefined;
    const elements = childElements(parsePart(this.#text), "pr:Relationship");
    this.#ids = new Set(elements.flatMap(element => attribute(element, "Id") ?? []));
    for (const element of elements) {
      const type = attribute(element, "Type") ?? "";
      const target = attribute(element, "Target");
      if (type.endsWith("/hyperlink") && attribute(element, "TargetMode") === "External" && target !== undefined) {
        this.#targets.set(target, attribute(element, "Id")!);
      }
    }
  }

  /** The id of an external hyperlink to `url`, reusing one the part already has. */
  hyperlink(url: string): string {
    return this.#targets.get(url) ?? this.add("hyperlink", url, true);
  }

  /** Adds a relationship and returns its id. `type` is a full URI, or the last segment of a Transitional one. */
  add(type: string, target: string, external = false): string {
    let index = this.#ids.size + 1;
    while (this.#ids.has(`rId${index}`)) index++;
    const id = `rId${index}`;
    this.#ids.add(id);
    if (external && type === "hyperlink") this.#targets.set(target, id);
    const element = `<Relationship Id="${id}" Type="${type.includes("://") ? type : `${REL_TYPE}/${type}`}" Target="${escapeAttribute(target)}"${external ? ' TargetMode="External"' : ""}/>`;
    this.#text = insertBeforeClose(this.#text, "Relationships", element);
    this.#changed = true;
    return id;
  }

  /** Removes the relationship `id`, if there is one. */
  remove(id: string): void {
    if (!this.#ids.delete(id)) return;
    for (const [target, owner] of this.#targets) if (owner === id) this.#targets.delete(target);
    this.#text = this.#text.replace(elementPattern("Relationship", "Id", id), "");
    this.#changed = true;
  }

  get changed(): boolean {
    return this.#changed;
  }

  toString(): string {
    return this.#text;
  }
}

/** `[Content_Types].xml`, as text that overrides are added to, changed in or removed from. */
export class ContentTypesEditor {
  #text: string;
  #changed = false;

  constructor(text: string) {
    this.#text = text;
  }

  /** The content type a part is declared with by override, if any. */
  override(partName: string): string | undefined {
    const element = this.#overrides().find(candidate => sameName(attribute(candidate, "PartName"), partName));
    return attribute(element, "ContentType");
  }

  /** Declares `partName` as `contentType`, replacing any override it already has. */
  setOverride(partName: string, contentType: string): void {
    const existing = this.override(partName);
    if (existing === contentType) return;
    const override = `<Override PartName="/${escapeAttribute(partName)}" ContentType="${contentType}"/>`;
    if (existing !== undefined) {
      this.#text = this.#text.replace(elementPattern("Override", "PartName", `/${partName}`, "i"), override);
    } else {
      this.#text = insertBeforeClose(this.#text, "Types", override);
    }
    this.#changed = true;
  }

  /** Drops the override of a part that is gone, which Office would otherwise report as damage. */
  removeOverride(partName: string): void {
    if (this.override(partName) === undefined) return;
    this.#text = this.#text.replace(elementPattern("Override", "PartName", `/${partName}`, "i"), "");
    this.#changed = true;
  }

  get changed(): boolean {
    return this.#changed;
  }

  toString(): string {
    return this.#text;
  }

  #overrides() {
    return childElements(parsePart(this.#text)).filter(element => element.name.endsWith("Override"));
  }
}

function sameName(declared: string | undefined, partName: string): boolean {
  return declared !== undefined && declared.replace(/^\//, "").toLowerCase() === partName.toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The one element named `localName` (any prefix) whose `attributeName` is `value`, self-closed or empty. */
function elementPattern(localName: string, attributeName: string, value: string, flags = ""): RegExp {
  return new RegExp(`<((?:[\\w.-]+:)?${localName})\\b[^>]*\\b${attributeName}="${escapeRegExp(escapeAttribute(value))}"[^>]*(?:/>|>\\s*</\\1\\s*>)`, flags);
}

/** Inserts `content` before the root's closing tag, whatever prefix the root uses. */
function insertBeforeClose(text: string, localName: string, content: string): string {
  const pattern = new RegExp(`</(?:[\\w.-]+:)?${localName}\\s*>(?![\\s\\S]*</(?:[\\w.-]+:)?${localName}\\s*>)`);
  const match = pattern.exec(text);
  if (match) return text.slice(0, match.index) + content + text.slice(match.index);
  // A self-closed empty root.
  const empty = new RegExp(`<((?:[\\w.-]+:)?${localName})\\b([^>]*?)\\s*/>`).exec(text);
  if (!empty) throw new Error(`The package's ${localName} part is malformed.`);
  return text.slice(0, empty.index) + `<${empty[1]}${empty[2]}>${content}</${empty[1]}>` + text.slice(empty.index + empty[0].length);
}

/** A package opened for editing: changed parts are held as text, deleted ones skipped, the rest copied byte for byte. */
export class PackageEditor {
  readonly #zip: ZipArchive;
  readonly #replaced = new Map<string, string | Uint8Array>();
  readonly #deleted = new Set<string>();
  /** Replaced parts' names as first given, keyed in lower case as OPC compares them. */
  readonly #names = new Map<string, string>();

  constructor(zip: ZipArchive) {
    this.#zip = zip;
  }

  has(name: string): boolean {
    const key = name.toLowerCase();
    return this.#replaced.has(key) || (!this.#deleted.has(key) && this.#zip.has(name));
  }

  async text(name: string): Promise<string | undefined> {
    const replaced = this.#replaced.get(name.toLowerCase());
    if (typeof replaced === "string") return replaced;
    return this.has(name) && this.#zip.has(name) ? readPartText(this.#zip, name) : undefined;
  }

  set(name: string, data: string | Uint8Array): void {
    this.#replaced.set(name.toLowerCase(), data);
    this.#deleted.delete(name.toLowerCase());
    this.#names.set(name.toLowerCase(), name);
  }

  /** Leaves a part, and its relationships part, out of the written package. */
  delete(name: string): void {
    this.#replaced.delete(name.toLowerCase());
    this.#deleted.add(name.toLowerCase());
    const rels = relationshipsPartName(name);
    if (this.#zip.has(rels)) this.delete(rels);
  }

  /** The package, entries in their original order and new parts after them. */
  async write(modifiedAt: Date): Promise<Uint8Array> {
    const entries: ZipWriteEntry[] = [];
    const written = new Set<string>();
    for (const entry of this.#zip.entries()) {
      const key = entry.name.toLowerCase();
      if (written.has(key) || this.#deleted.has(key) || entry.name.endsWith("/")) continue;
      written.add(key);
      entries.push({ name: entry.name, data: this.#replaced.get(key) ?? await this.#zip.readBytes(entry.name) });
    }
    for (const [key, data] of this.#replaced) {
      if (!written.has(key)) entries.push({ name: this.#names.get(key)!, data });
    }
    return writeZip(entries, modifiedAt);
  }
}
