// A small, non-validating XML parser for Office Open XML parts. It understands elements, attributes,
// namespaces, text, CDATA and character references, which is all OOXML uses. Everything that could
// make a hostile document expensive is refused or ignored: DOCTYPE declarations are skipped and
// their entities never expanded (so neither XXE nor "billion laughs" is possible), only the five
// predefined entities and numeric references are decoded, and nesting depth and element counts are
// bounded. Parts can be parsed whole or streamed one subtree at a time.

/** Why a part could not be parsed. */
export type XmlErrorCode = "malformed" | "limit";

/** A part that is not well-formed enough to read, or exceeds a parse limit. */
export class XmlError extends Error {
  override readonly name = "XmlError";
  constructor(readonly code: XmlErrorCode, message: string) {
    super(message);
  }
}

/**
 * An element. Its name is `prefix:local` with the prefix chosen by the caller's namespace table
 * (so `w:p` means WordprocessingML's `p` whatever prefix the file used), `{uri}local` for a
 * namespace the table does not know, or the bare local name when it has no namespace.
 */
export interface XmlElement {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlNode[];
}

/** An element or a run of character data. */
export type XmlNode = XmlElement | string;

/** How names are resolved and how large a document may be. */
export interface XmlOptions {
  /** Namespace URI to the prefix element and attribute names are reported with. */
  readonly namespaces: Readonly<Record<string, string>>;
  readonly maxDepth?: number;
  /** The most elements one parsed tree (or one streamed subtree) may hold; an attribute counts as a quarter of one, costing about that much memory. */
  readonly maxElements?: number;
  /**
   * Called as each element closes; a returned list of nodes replaces the element in its parent.
   * Lets a caller resolve wrappers such as OOXML's `mc:AlternateContent` once, at parse time.
   */
  readonly replace?: (element: XmlElement) => readonly XmlNode[] | undefined;
}

const DEFAULT_MAX_DEPTH = 256;
/** About 60 MB of tree at worst, which keeps a hostile part inside a Worker isolate's memory. */
const DEFAULT_MAX_ELEMENTS = 250_000;
/** Far more than any OOXML element declares; keeps one element from being a part's whole size in attributes. */
export const MAX_ATTRIBUTES = 1024;
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

/** Parses a whole document and returns its root element. */
export function parseXml(text: string, options: XmlOptions): XmlElement {
  const tokenizer = new XmlTokenizer(text, options);
  let root: XmlElement | undefined;
  for (let token = tokenizer.next(); token; token = tokenizer.next()) {
    if (token.kind === "open") root = buildElement(tokenizer, token, options);
  }
  if (!root) throw new XmlError("malformed", "Document has no root element");
  return root;
}

/**
 * Yields each element at `depth` (the root is depth 0) as a complete subtree, so a large part such
 * as a document body can be converted while holding only one block of it in memory at a time.
 */
export function* streamElements(text: string, depth: number, options: XmlOptions): Generator<XmlElement> {
  const tokenizer = new XmlTokenizer(text, options);
  for (let token = tokenizer.next(); token; token = tokenizer.next()) {
    if (token.kind === "open" && token.depth === depth) {
      yield* replaced(buildElement(tokenizer, token, options), options);
    }
  }
}

function replaced(element: XmlElement, options: XmlOptions): XmlElement[] {
  const replacement = options.replace?.(element);
  if (!replacement) return [element];
  return replacement.filter((node): node is XmlElement => typeof node !== "string");
}

interface MutableElement {
  name: string;
  attributes: ReadonlyMap<string, string>;
  children: XmlNode[];
}

/** Reads tokens up to the close of `open`, returning the element they make. */
function buildElement(tokenizer: XmlTokenizer, open: OpenToken, options: XmlOptions): XmlElement {
  const maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS;
  let count = 1 + (open.attributes.size >> 2);
  const root: MutableElement = { name: open.name, attributes: open.attributes, children: [] };
  if (open.selfClosing) return root;
  const stack: MutableElement[] = [root];

  while (stack.length > 0) {
    const token = tokenizer.next();
    if (!token) throw new XmlError("malformed", `Element <${root.name}> is never closed`);
    const parent = stack[stack.length - 1]!;
    if (token.kind === "text") {
      appendText(parent.children, token.text);
    } else if (token.kind === "open") {
      if ((count += 1 + (token.attributes.size >> 2)) > maxElements) throw new XmlError("limit", `Part has more than ${maxElements} elements`);
      const element: MutableElement = { name: token.name, attributes: token.attributes, children: [] };
      if (token.selfClosing) appendElement(parent, element, options);
      else stack.push(element);
    } else {
      stack.pop();
      dropIgnorableWhitespace(parent);
      if (stack.length > 0) appendElement(stack[stack.length - 1]!, parent, options);
    }
  }
  return root;
}

function appendElement(parent: MutableElement, element: MutableElement, options: XmlOptions): void {
  const replacement = options.replace?.(element);
  if (!replacement) {
    parent.children.push(element);
    return;
  }
  for (const node of replacement) {
    if (typeof node === "string") appendText(parent.children, node);
    else parent.children.push(node);
  }
}

function appendText(children: XmlNode[], text: string): void {
  const last = children.length - 1;
  if (last >= 0 && typeof children[last] === "string") children[last] += text;
  else children.push(text);
}

/**
 * Drops whitespace-only text beside child elements: it is indentation, never content, in OOXML.
 * Text in a leaf element (such as `<w:t xml:space="preserve"> </w:t>`) is kept as written.
 */
function dropIgnorableWhitespace(element: MutableElement): void {
  if (!element.children.some(child => typeof child !== "string")) return;
  element.children = element.children.filter(child => typeof child !== "string" || child.trim() !== "");
}

interface OpenToken {
  readonly kind: "open";
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly selfClosing: boolean;
  /** The element's own depth; the root is 0. */
  readonly depth: number;
}

type Token = OpenToken | { readonly kind: "close" } | { readonly kind: "text"; readonly text: string };

interface OpenElement {
  readonly rawName: string;
  /** Prefix to namespace URI, for the prefixes this element declares. */
  readonly declarations: ReadonlyMap<string, string> | undefined;
}

/** Splits a document into well-formed open, close and text tokens, resolving namespaces. */
class XmlTokenizer {
  #position = 0;
  readonly #open: OpenElement[] = [];
  #rootSeen = false;
  readonly #maxDepth: number;

  constructor(private readonly text: string, private readonly options: XmlOptions) {
    this.#maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  next(): Token | null {
    const text = this.text;
    while (this.#position < text.length) {
      if (text.charCodeAt(this.#position) !== 0x3c /* < */) {
        const token = this.#characterData();
        if (token) return token;
      } else if (text.startsWith("<?", this.#position)) {
        this.#skipPast("?>", "processing instruction");
      } else if (text.startsWith("<!--", this.#position)) {
        this.#skipPast("-->", "comment");
      } else if (text.startsWith("<![CDATA[", this.#position)) {
        const end = this.#indexOrThrow("]]>", this.#position + 9, "CDATA section");
        const data = text.slice(this.#position + 9, end);
        this.#position = end + 3;
        if (this.#open.length === 0) throw new XmlError("malformed", "CDATA outside the root element");
        return { kind: "text", text: data };
      } else if (text.startsWith("<!", this.#position)) {
        this.#skipDeclaration();
      } else if (text.startsWith("</", this.#position)) {
        return this.#closeTag();
      } else {
        return this.#openTag();
      }
    }
    if (this.#open.length > 0) throw new XmlError("malformed", `Element <${this.#open[this.#open.length - 1]!.rawName}> is never closed`);
    return null;
  }

  #characterData(): Token | null {
    const start = this.#position;
    let end = this.text.indexOf("<", start);
    if (end === -1) end = this.text.length;
    this.#position = end;
    const raw = this.text.slice(start, end);
    if (this.#open.length === 0) {
      if (raw.trim() !== "") throw new XmlError("malformed", "Text outside the root element");
      return null;
    }
    return { kind: "text", text: decodeEntities(raw) };
  }

  #openTag(): OpenToken {
    if (this.#rootSeen && this.#open.length === 0) throw new XmlError("malformed", "Document has more than one root element");
    const text = this.text;
    this.#position++;
    const rawName = this.#readName();
    const rawAttributes = new Map<string, string>();
    let declarations: Map<string, string> | undefined;

    for (;;) {
      this.#skipWhitespace();
      if (text.startsWith("/>", this.#position) || text.charCodeAt(this.#position) === 0x3e /* > */) break;
      const attributeName = this.#readName();
      const value = this.#readAttributeValue(attributeName);
      if (rawAttributes.size + (declarations?.size ?? 0) >= MAX_ATTRIBUTES) throw new XmlError("limit", `<${rawName}> has more than ${MAX_ATTRIBUTES} attributes`);
      if (attributeName === "xmlns" || attributeName.startsWith("xmlns:")) {
        declarations ??= new Map();
        declarations.set(attributeName === "xmlns" ? "" : attributeName.slice(6), value);
      } else {
        if (rawAttributes.has(attributeName)) throw new XmlError("malformed", `Attribute ${attributeName} is repeated on <${rawName}>`);
        rawAttributes.set(attributeName, value);
      }
    }

    const selfClosing = text.charCodeAt(this.#position) === 0x2f /* / */;
    this.#position += selfClosing ? 2 : 1;
    const depth = this.#open.length;
    if (depth >= this.#maxDepth) throw new XmlError("limit", `Elements nest deeper than ${this.#maxDepth}`);
    this.#rootSeen = true;

    this.#open.push({ rawName, declarations });
    const token: OpenToken = {
      kind: "open",
      name: this.#resolve(rawName, true),
      attributes: this.#resolveAttributes(rawAttributes),
      selfClosing,
      depth,
    };
    if (selfClosing) this.#open.pop();
    return token;
  }

  #closeTag(): Token {
    this.#position += 2;
    const rawName = this.#readName();
    this.#skipWhitespace();
    if (this.text.charCodeAt(this.#position) !== 0x3e /* > */) throw new XmlError("malformed", `Malformed closing tag </${rawName}>`);
    this.#position++;
    const open = this.#open.pop();
    if (!open || open.rawName !== rawName) {
      throw new XmlError("malformed", `Closing tag </${rawName}> does not match <${open?.rawName ?? "nothing"}>`);
    }
    return { kind: "close" };
  }

  #readName(): string {
    const start = this.#position;
    while (this.#position < this.text.length && isNameCharacter(this.text.charCodeAt(this.#position))) this.#position++;
    if (this.#position === start) throw new XmlError("malformed", `Expected a name at offset ${start}`);
    return this.text.slice(start, this.#position);
  }

  #readAttributeValue(attributeName: string): string {
    this.#skipWhitespace();
    if (this.text.charCodeAt(this.#position) !== 0x3d /* = */) throw new XmlError("malformed", `Attribute ${attributeName} has no value`);
    this.#position++;
    this.#skipWhitespace();
    const quote = this.text[this.#position];
    if (quote !== '"' && quote !== "'") throw new XmlError("malformed", `Attribute ${attributeName} is not quoted`);
    const end = this.#indexOrThrow(quote, this.#position + 1, "attribute value");
    const raw = this.text.slice(this.#position + 1, end);
    if (raw.includes("<")) throw new XmlError("malformed", `Attribute ${attributeName} contains "<"`);
    this.#position = end + 1;
    return decodeEntities(raw);
  }

  #resolveAttributes(raw: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
    const attributes = new Map<string, string>();
    for (const [name, value] of raw) attributes.set(this.#resolve(name, false), value);
    return attributes;
  }

  /** Maps a qualified name to the caller's prefix for its namespace. Unprefixed attributes have no namespace. */
  #resolve(rawName: string, isElement: boolean): string {
    const colon = rawName.indexOf(":");
    const prefix = colon === -1 ? "" : rawName.slice(0, colon);
    const local = colon === -1 ? rawName : rawName.slice(colon + 1);
    if (prefix === "" && !isElement) return local;
    const uri = prefix === "xml" ? XML_NAMESPACE : this.#lookupNamespace(prefix);
    if (uri === undefined || uri === "") return prefix === "" ? local : rawName;
    const known = uri === XML_NAMESPACE ? "xml" : this.options.namespaces[uri];
    return known === undefined ? `{${uri}}${local}` : `${known}:${local}`;
  }

  #lookupNamespace(prefix: string): string | undefined {
    for (let index = this.#open.length - 1; index >= 0; index--) {
      const uri = this.#open[index]!.declarations?.get(prefix);
      if (uri !== undefined) return uri;
    }
    return undefined;
  }

  #skipWhitespace(): void {
    while (this.#position < this.text.length && isWhitespace(this.text.charCodeAt(this.#position))) this.#position++;
  }

  #skipPast(terminator: string, what: string): void {
    this.#position = this.#indexOrThrow(terminator, this.#position, what) + terminator.length;
  }

  /**
   * Skips a `<!DOCTYPE ...>` (or other `<!` declaration), including any internal subset in
   * brackets. Nothing in it is interpreted: entities it declares are never expanded.
   */
  #skipDeclaration(): void {
    if (this.#rootSeen) throw new XmlError("malformed", "Declaration after the root element starts");
    const text = this.text;
    let bracketDepth = 0;
    let quote: string | undefined;
    for (let at = this.#position + 2; at < text.length; at++) {
      const char = text[at];
      if (quote) {
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === "[") {
        bracketDepth++;
      } else if (char === "]") {
        bracketDepth--;
      } else if (char === ">" && bracketDepth <= 0) {
        this.#position = at + 1;
        return;
      }
    }
    throw new XmlError("malformed", "Unterminated declaration");
  }

  #indexOrThrow(search: string, from: number, what: string): number {
    const index = this.text.indexOf(search, from);
    if (index === -1) throw new XmlError("malformed", `Unterminated ${what}`);
    return index;
  }
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** Anything but whitespace and the characters that end a name; validating XML's name grammar buys nothing here. */
function isNameCharacter(code: number): boolean {
  return !isWhitespace(code) && code !== 0x3c && code !== 0x3e && code !== 0x2f && code !== 0x3d
    && code !== 0x22 && code !== 0x27;
}

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const ENTITY_REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g;

/**
 * Decodes the predefined entities and numeric character references. Any other `&name;` is left as
 * written: a custom entity would need the DOCTYPE this parser deliberately ignores.
 */
export function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(ENTITY_REFERENCE, (_match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return PREDEFINED_ENTITIES[name]!;
    return codePointToString(decimal ? Number.parseInt(decimal, 10) : Number.parseInt(hex!, 16));
  });
}

function codePointToString(codePoint: number): string {
  const valid = codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
  return valid ? String.fromCodePoint(codePoint) : "�";
}

/** The element's child elements, optionally only those named `name`. */
export function childElements(element: XmlElement | undefined, name?: string): XmlElement[] {
  if (!element) return [];
  const out: XmlElement[] = [];
  for (const child of element.children) {
    if (typeof child !== "string" && (name === undefined || child.name === name)) out.push(child);
  }
  return out;
}

/** The first child element named `name`. */
export function firstChild(element: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!element) return undefined;
  for (const child of element.children) {
    if (typeof child !== "string" && child.name === name) return child;
  }
  return undefined;
}

/** Follows a path of child element names. */
export function childAt(element: XmlElement | undefined, ...path: readonly string[]): XmlElement | undefined {
  let current = element;
  for (const name of path) current = firstChild(current, name);
  return current;
}

/** The first element named `name` anywhere below `element`, in document order. */
export function firstDescendant(element: XmlElement | undefined, name: string): XmlElement | undefined {
  for (const found of descendants(element, name)) return found;
  return undefined;
}

/** Every element named `name` below `element`, in document order, not descending into matches. */
export function* descendants(element: XmlElement | undefined, name: string): Generator<XmlElement> {
  if (!element) return;
  for (const child of element.children) {
    if (typeof child === "string") continue;
    if (child.name === name) yield child;
    else yield* descendants(child, name);
  }
}

/** An attribute's value. */
export function attribute(element: XmlElement | undefined, name: string): string | undefined {
  return element?.attributes.get(name);
}

/** The element's character data, concatenated. */
export function textContent(element: XmlElement): string {
  let text = "";
  for (const child of element.children) text += typeof child === "string" ? child : textContent(child);
  return text;
}
