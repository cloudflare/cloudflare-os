// A position-keeping XML tree for editing a part in place. Every element remembers where its tags
// sit in the source text, so an edit is a set of splices on that text: whatever an edit does not
// touch keeps its exact bytes, attribute order, namespace declarations and whitespace, which is
// what lets a tracked change in one paragraph leave the rest of a document as Word wrote it.

import { decodeEntities, MAX_ATTRIBUTES } from "./xml";

/** An element and the source offsets of its tags. */
export interface RawElement {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  /** Offset of the start tag's `<`. */
  readonly start: number;
  /** Offset just past the start tag's `>`. */
  readonly openEnd: number;
  /** Offset of the end tag's `<`, or `openEnd` for a self-closed element. */
  closeStart: number;
  /** Offset just past the element. */
  end: number;
  readonly children: RawNode[];
  readonly parent: RawElement | undefined;
}

/** Character data, decoded, with its source span. */
export interface RawText {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** A node of a position-keeping tree. */
export type RawNode = RawElement | RawText;

/** Whether `node` is an element rather than text. */
export function isElement(node: RawNode): node is RawElement {
  return "name" in node;
}

/** Thrown for text that isn't well-formed enough to edit. */
export class RawXmlError extends Error {
  override readonly name = "RawXmlError";
}

const MAX_DEPTH = 256;
/** The same bound as `xml.ts`, an attribute again counting as a quarter of an element: every node here also keeps its offsets and parent. */
const MAX_ELEMENTS = 250_000;

/** Parses `text` into a tree whose nodes point back into it. Refuses DTDs, as every reader here does. */
export function parseRaw(text: string): RawElement {
  const stack: RawElement[] = [];
  let root: RawElement | undefined;
  let index = 0;
  let count = 0;
  while (index < text.length) {
    const open = text.indexOf("<", index);
    const textEnd = open === -1 ? text.length : open;
    if (textEnd > index && stack.length > 0) {
      stack.at(-1)!.children.push({ text: decodeEntities(text.slice(index, textEnd)), start: index, end: textEnd });
    }
    if (open === -1) break;
    if (text.startsWith("<?", open)) {
      index = after(text, "?>", open);
    } else if (text.startsWith("<!--", open)) {
      index = after(text, "-->", open);
    } else if (text.startsWith("<![CDATA[", open)) {
      const end = after(text, "]]>", open);
      stack.at(-1)?.children.push({ text: text.slice(open + 9, end - 3), start: open, end });
      index = end;
    } else if (text.startsWith("<!", open)) {
      throw new RawXmlError("Document type declarations are not allowed.");
    } else if (text.startsWith("</", open)) {
      const end = after(text, ">", open);
      const name = text.slice(open + 2, end - 1).trim();
      const element = stack.pop();
      if (!element || element.name !== name) throw new RawXmlError(`Unexpected closing tag </${name}>.`);
      element.closeStart = open;
      element.end = end;
      index = end;
    } else {
      const end = tagEnd(text, open);
      const selfClosing = text[end - 2] === "/";
      const inner = text.slice(open + 1, end - (selfClosing ? 2 : 1));
      const nameMatch = /^[^\s/>]+/.exec(inner);
      if (!nameMatch) throw new RawXmlError("A tag has no name.");
      const attributes = parseAttributes(inner.slice(nameMatch[0].length));
      if ((count += 1 + (attributes.size >> 2)) > MAX_ELEMENTS) throw new RawXmlError(`The part has more than ${MAX_ELEMENTS} elements.`);
      const parent = stack.at(-1);
      const element: RawElement = { name: nameMatch[0], attributes, start: open, openEnd: end, closeStart: end, end, children: [], parent };
      if (parent) parent.children.push(element);
      else if (root) throw new RawXmlError("The part has more than one root element.");
      else root = element;
      if (!selfClosing) {
        if (stack.length >= MAX_DEPTH) throw new RawXmlError("The part is nested too deeply.");
        stack.push(element);
      }
      index = end;
    }
  }
  if (!root || stack.length > 0) throw new RawXmlError("The part is incomplete.");
  return root;
}

function after(text: string, terminator: string, from: number): number {
  const at = text.indexOf(terminator, from);
  if (at === -1) throw new RawXmlError("The part is incomplete.");
  return at + terminator.length;
}

/** The offset past a start tag's `>`, skipping any `>` inside quoted attribute values. */
function tagEnd(text: string, open: number): number {
  let quote: string | undefined;
  for (let index = open + 1; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index + 1;
    }
  }
  throw new RawXmlError("The part is incomplete.");
}

/** Scans `name = "value"` pairs by hand: a regex would backtrack quadratically over a long tag with no `=`. */
function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let at = 0;
  const skipWhitespace = (): void => {
    while (at < source.length && /\s/.test(source[at]!)) at++;
  };
  for (skipWhitespace(); at < source.length; skipWhitespace()) {
    const nameStart = at;
    while (at < source.length && !/[\s=]/.test(source[at]!)) at++;
    const name = source.slice(nameStart, at);
    skipWhitespace();
    if (name === "" || source[at] !== "=") throw new RawXmlError(`A tag's attributes are malformed near "${source.slice(nameStart, nameStart + 20)}".`);
    at++;
    skipWhitespace();
    const quote = source[at];
    if (quote !== '"' && quote !== "'") throw new RawXmlError(`Attribute ${name} is not quoted.`);
    const end = source.indexOf(quote, at + 1);
    if (end === -1) throw new RawXmlError(`Attribute ${name} is not closed.`);
    if (attributes.size >= MAX_ATTRIBUTES) throw new RawXmlError(`A tag has more than ${MAX_ATTRIBUTES} attributes.`);
    attributes.set(name, decodeEntities(source.slice(at + 1, end)));
    at = end + 1;
  }
  return attributes;
}

/** Child elements, optionally only those named `name`. */
export function rawChildren(element: RawElement | undefined, name?: string): RawElement[] {
  return (element?.children ?? []).filter((child): child is RawElement => isElement(child) && (name === undefined || child.name === name));
}

/** The first child element named `name`. */
export function rawChild(element: RawElement | undefined, name: string): RawElement | undefined {
  return rawChildren(element, name)[0];
}

/** Every element named `name` below `element`, in document order, not descending into matches. */
export function* rawDescendants(element: RawElement | undefined, name: string): Generator<RawElement> {
  for (const child of rawChildren(element)) {
    if (child.name === name) yield child;
    else yield* rawDescendants(child, name);
  }
}

/** The element's own character data, concatenated. */
export function elementText(element: RawElement): string {
  return element.children.map(child => isElement(child) ? "" : child.text).join("");
}

/** A replacement of `[start, end)` in the source. */
export interface Splice {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Applies non-overlapping splices. An insertion (an empty range) at the point where a replacement
 * starts goes before it; two insertions at one point keep the order they were given in.
 */
export function applySplices(text: string, splices: readonly Splice[]): string {
  const ordered = splices.map((splice, order) => ({ ...splice, order }))
    .toSorted((a, b) => a.start - b.start || Number(a.end > a.start) - Number(b.end > b.start) || a.order - b.order);
  let out = "";
  let at = 0;
  for (const splice of ordered) {
    if (splice.start < at) throw new RawXmlError("Edits overlap.");
    out += text.slice(at, splice.start) + splice.text;
    at = splice.end;
  }
  return out + text.slice(at);
}
