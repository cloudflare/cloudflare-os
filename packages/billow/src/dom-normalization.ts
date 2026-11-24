import { normalizeDocument } from "./model.js";
import type { BillowDocument, BillowNode, ItemRegistry } from "./types.js";

// Reading the editor's DOM back into the model, including whatever shapes the browser leaves
// behind after a native edit (extra <div>/<p> blocks, stray <br>s, duplicated item elements).
//
// The editor puts two kinds of helper nodes in the DOM that are not part of the document:
// - a "caret sentinel": a `<span data-billow-caret>` holding a zero-width space, placed where
//   there would otherwise be no text for a caret to sit in: before an item at the start of a
//   line (document start, after a newline) or after another item, at the end after an item,
//   and in an empty document (where it also carries the placeholder);
// - a "trailing newline sentinel": a `<br data-billow-trailing-newline>` after a final "\n",
//   so the empty last line is rendered.
// Both have zero length in the model.

/** The zero-width space a caret sentinel is made of. */
export const CARET_SENTINEL_TEXT = "\u200b";

export function isHtmlElement(node: Node | null): node is HTMLElement {
  return Boolean(node && node.nodeType === 1 && (node as Element).namespaceURI === "http://www.w3.org/1999/xhtml");
}

function isBlockDomNode(node: Node | null): node is HTMLElement {
  return isHtmlElement(node) && /^(DIV|P)$/.test(node.tagName);
}

export function isTrailingNewlineSentinel(node: Node | null): boolean {
  return isHtmlElement(node) && node.tagName === "BR" && node.hasAttribute("data-billow-trailing-newline");
}

export function isCaretSentinel(node: Node | null): boolean {
  return isHtmlElement(node) && node.tagName === "SPAN" && node.hasAttribute("data-billow-caret");
}

/** A new caret sentinel: an empty-looking span holding just the zero-width space. */
export function createCaretSentinel(ownerDocument: Document): HTMLElement {
  const sentinel = ownerDocument.createElement("span");
  sentinel.setAttribute("data-billow-caret", "");
  sentinel.textContent = CARET_SENTINEL_TEXT;
  return sentinel;
}

/** A new trailing newline sentinel: the `<br>` that keeps the empty last line after a final "\n" visible. */
export function createTrailingNewlineSentinel(ownerDocument: Document): HTMLElement {
  const sentinel = ownerDocument.createElement("br");
  sentinel.setAttribute("data-billow-trailing-newline", "");
  return sentinel;
}

/**
 * Native edits can split a line into `<div>`/`<p>` children. The model has no blocks,
 * so a boundary between a block and its sibling counts as one "\n". Every place that
 * converts between the DOM and model positions must use this same rule.
 */
export function impliesLineBreakBefore(siblings: readonly Node[], index: number): boolean {
  return index > 0 && (isBlockDomNode(siblings[index]!) || isBlockDomNode(siblings[index - 1]!));
}

/** An empty block holds a lone `<br>` only so it has height; it is not a newline. */
export function isEmptyBlockPlaceholderBreak(node: Node): boolean {
  return isBlockDomNode(node.parentNode) && node.parentNode.childNodes.length === 1;
}

export function normalizedDomLength<Registry extends ItemRegistry>(
  document: BillowDocument<Registry>,
  root: Node,
  includeRoot = false,
): number {
  const knownIds = new Set(document.flatMap((node) => typeof node === "string" ? [] : [node.id]));
  const measure = (node: Node): number => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
    if (!isHtmlElement(node)) return measureChildren(node);
    if (isTrailingNewlineSentinel(node)) return 0;
    if (isCaretSentinel(node)) return (node.textContent ?? "").replace(CARET_SENTINEL_TEXT, "").length;
    if (node.dataset.billowItem && knownIds.has(node.dataset.billowItem)) return 1;
    if (node.tagName === "BR") return isEmptyBlockPlaceholderBreak(node) ? 0 : 1;
    return measureChildren(node);
  };
  const measureChildren = (parent: Node): number => {
    const children = [...parent.childNodes];
    return children.reduce((length, child, index) => length
      + (impliesLineBreakBefore(children, index) ? 1 : 0)
      + measure(child), 0);
  };
  return includeRoot ? measure(root) : measureChildren(root);
}

/**
 * Turns the editor's current DOM back into a document, after a native edit changed it.
 *
 * Text is read from the DOM, but items never are: an item element is recognized by its ID and
 * replaced by the item node already in `document`, because item data lives only in the model.
 * `isTrackedItem` says whether an element is the editor's own live element for that ID; any
 * other element carrying a known ID, and any repeat of an ID already seen, is dropped.
 *
 * Everything else is flattened to text: each `<br>` is a "\n" (except a placeholder one) and a
 * block boundary adds a "\n" (see `impliesLineBreakBefore`). The helper nodes described at the
 * top of this file contribute nothing.
 */
export function readEditorDom<Registry extends ItemRegistry>(
  element: HTMLElement,
  document: BillowDocument<Registry>,
  isTrackedItem: (node: Node) => boolean,
): BillowDocument<Registry> {
  const knownItems = new Map(document
    .filter((node): node is Extract<BillowNode<Registry>, { type: "item" }> => typeof node !== "string")
    .map((node) => [node.id, node]));
  const nodes: BillowNode<Registry>[] = [];
  const seenItemIds = new Set<string>();
  const appendText = (text: string): void => {
    if (text) nodes.push(text);
  };
  const visit = (node: Node): void => {
    // Text: read as is.
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent ?? "");
      return;
    }
    // Comments, SVG and other non-HTML nodes carry no document content.
    if (!isHtmlElement(node)) return;
    // Helper nodes: the `<br>` adds nothing; a caret sentinel may hold text the user typed into
    // it, so keep that and drop only the zero-width space.
    if (isTrailingNewlineSentinel(node)) return;
    if (isCaretSentinel(node)) {
      appendText((node.textContent ?? "").replace(CARET_SENTINEL_TEXT, ""));
      return;
    }
    // Item elements: use the existing item node, never anything read from the DOM. An element
    // that is not our live one, or whose item was already seen, is dropped.
    const id = node.dataset.billowItem;
    if (id && knownItems.has(id)) {
      if (!isTrackedItem(node) || seenItemIds.has(id)) return;
      seenItemIds.add(id);
      nodes.push(knownItems.get(id)!);
      return;
    }
    // Line breaks.
    if (node.tagName === "BR") {
      if (!isEmptyBlockPlaceholderBreak(node)) appendText("\n");
      return;
    }
    // Any other element (`<div>`, `<span>`, an item element with an unknown ID, ...): read its children.
    visitChildren(node);
  };
  const visitChildren = (parent: Node): void => {
    const children = [...parent.childNodes];
    children.forEach((child, index) => {
      if (impliesLineBreakBefore(children, index)) appendText("\n");
      visit(child);
    });
  };
  visitChildren(element);
  return normalizeDocument(nodes);
}
