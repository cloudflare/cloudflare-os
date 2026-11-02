// List numbering for the Word writer: the abstract definitions bulleted, numbered and task lists are
// drawn from, and one numbering instance per list. Word continues a numbered list across instances
// of the same definition unless an instance overrides its start, so each ordered list gets its own
// instance with a `w:startOverride`: two lists in a row both count from their own start, as their
// Markdown did. The document's own numbering part is kept byte for byte; definitions and instances
// are inserted with ids above any it already uses.

import { attribute, childElements } from "./xml";
import { parsePart } from "./ooxml";
import { XML_DECLARATION } from "./ooxml";

/** The kinds of list the writer lays out. */
export type ListKind = "bullet" | "ordered" | "task";

const LEVELS = 9;
const BULLETS = ["•", "◦", "▪"];
const ORDERED_FORMATS = ["decimal", "lowerLetter", "lowerRoman"];

/** The indent of a list level, and the hanging indent its marker sits in. */
export function listIndent(level: number): { left: number; hanging: number } {
  return { left: 720 + 360 * level, hanging: 360 };
}

function levelXml(kind: ListKind, level: number): string {
  const { left, hanging } = listIndent(level);
  const indent = `<w:pPr><w:ind w:left="${left}" w:hanging="${hanging}"/></w:pPr>`;
  if (kind === "ordered") {
    const format = ORDERED_FORMATS[level % ORDERED_FORMATS.length]!;
    return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>` +
      `<w:lvlText w:val="%${level + 1}."/><w:lvlJc w:val="left"/>${indent}</w:lvl>`;
  }
  if (kind === "task") {
    // The box is the paragraph's first character, so it stays editable text; the level only indents.
    return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:suff w:val="nothing"/>` +
      `<w:lvlText w:val=""/><w:lvlJc w:val="left"/>${indent}</w:lvl>`;
  }
  return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
    `<w:lvlText w:val="${BULLETS[level % BULLETS.length]}"/><w:lvlJc w:val="left"/>${indent}` +
    '<w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:hint="default"/></w:rPr></w:lvl>';
}

/**
 * The numbering of one document. `instance()` hands out a numbering id per list; `serialize()`
 * returns the part with the definitions and instances that were used.
 */
export class NumberingAllocator {
  readonly #source: string | undefined;
  readonly #abstractIds = new Map<ListKind, number>();
  readonly #nsids: Set<string>;
  readonly #abstracts: string[] = [];
  readonly #instances: string[] = [];
  /** The document's own numbering instances, by id, and the definitions they draw on. */
  readonly #abstractOf = new Map<string, string>();
  #nextAbstractId: number;
  #nextNumId: number;

  /** @param numberingXml The document's numbering part, or undefined when it has none. */
  constructor(numberingXml: string | undefined) {
    this.#source = numberingXml;
    const root = numberingXml === undefined ? undefined : parsePart(numberingXml);
    const abstracts = childElements(root, "w:abstractNum");
    this.#nextAbstractId = 1 + Math.max(-1, ...abstracts.map(element => Number(attribute(element, "w:abstractNumId") ?? -1)).filter(Number.isFinite));
    this.#nextNumId = 1 + Math.max(0, ...childElements(root, "w:num").map(element => Number(attribute(element, "w:numId") ?? 0)).filter(Number.isFinite));
    for (const instance of childElements(root, "w:num")) {
      const numId = attribute(instance, "w:numId");
      const abstractId = attribute(childElements(instance, "w:abstractNumId")[0], "w:val");
      if (numId !== undefined && abstractId !== undefined) this.#abstractOf.set(numId, abstractId);
    }
    this.#nsids = new Set(abstracts.flatMap(element => {
      const nsid = childElements(element, "w:nsid")[0];
      const value = nsid && attribute(nsid, "w:val");
      return value ? [value.toUpperCase()] : [];
    }));
  }

  /** A new numbering instance for one list; an ordered list counts from `start` at `level`. */
  instance(kind: ListKind, level = 0, start = 1): number {
    const abstractId = this.#abstract(kind);
    const numId = this.#nextNumId++;
    const override = kind === "ordered"
      ? `<w:lvlOverride w:ilvl="${level}"><w:startOverride w:val="${Math.max(0, Math.trunc(start))}"/></w:lvlOverride>`
      : "";
    this.#instances.push(`<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractId}"/>${override}</w:num>`);
    return numId;
  }

  /**
   * A new instance of the definition an existing instance draws on, counting from `start` at
   * `level`: a numbered list in the document's own List Number style that starts afresh rather
   * than continuing the last one. Undefined when the document has no such instance.
   */
  restart(numId: string, level: number, start: number): number | undefined {
    const abstractId = this.#abstractOf.get(numId);
    if (abstractId === undefined) return undefined;
    const id = this.#nextNumId++;
    this.#instances.push(`<w:num w:numId="${id}"><w:abstractNumId w:val="${abstractId}"/>` +
      `<w:lvlOverride w:ilvl="${level}"><w:startOverride w:val="${Math.max(0, Math.trunc(start))}"/></w:lvlOverride></w:num>`);
    return id;
  }

  /** Whether any list was laid out, so the part (and its relationship) is needed. */
  get used(): boolean {
    return this.#instances.length > 0;
  }

  /** The numbering part: the document's own, or a new one, with the definitions used inserted. */
  serialize(): string {
    if (this.#source === undefined) {
      return `${XML_DECLARATION}<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `${this.#abstracts.join("")}${this.#instances.join("")}</w:numbering>`;
    }
    if (!this.used) return this.#source;
    // Abstract definitions precede every instance, and instances precede w:numIdMacAtCleanup.
    let text = this.#source;
    const cleanup = /<w:numIdMacAtCleanup[\s/>]/.exec(text)?.index;
    const close = text.lastIndexOf("</w:numbering>");
    if (close === -1) throw new Error("The document's numbering part has no closing w:numbering tag.");
    const instancesAt = cleanup ?? close;
    text = text.slice(0, instancesAt) + this.#instances.join("") + text.slice(instancesAt);
    const firstInstance = /<w:num[\s>]/.exec(text)!.index;
    return text.slice(0, firstInstance) + this.#abstracts.join("") + text.slice(firstInstance);
  }

  #abstract(kind: ListKind): number {
    const known = this.#abstractIds.get(kind);
    if (known !== undefined) return known;
    const id = this.#nextAbstractId++;
    this.#abstractIds.set(kind, id);
    const levels = Array.from({ length: LEVELS }, (_, level) => levelXml(kind, level)).join("");
    this.#abstracts.push(`<w:abstractNum w:abstractNumId="${id}"><w:nsid w:val="${this.#nsid(id)}"/>` +
      `<w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`);
    return id;
  }

  /** A list-definition id Word uses to tell lists apart when pasting, unique in this document. */
  #nsid(seed: number): string {
    for (let attempt = seed; ; attempt++) {
      // Unsigned last: the OR can set the sign bit, and `w:nsid` is eight hex digits, never negative.
      const value = ((Math.imul(attempt + 1, 0x9e3779b1) | 0x10000000) >>> 0).toString(16).toUpperCase().padStart(8, "0");
      if (!this.#nsids.has(value)) {
        this.#nsids.add(value);
        return value;
      }
    }
  }
}
