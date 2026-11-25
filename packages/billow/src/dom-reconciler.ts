import {
  CARET_SENTINEL_TEXT,
  createCaretSentinel,
  createTrailingNewlineSentinel,
  isCaretSentinel,
  isHtmlElement,
  isTrailingNewlineSentinel,
  readEditorDom,
} from "./dom-normalization.js";
import { documentLength } from "./model.js";
import type { BillowDocument, ItemRegistry, ModelRange } from "./types.js";
import { ItemRenderer } from "./item-renderer.js";

/**
 * Both directions between the model and the editor's DOM.
 *
 * `render` makes the DOM match the document, reusing existing text nodes and caret sentinels
 * instead of recreating them. `readDocument` does the reverse after a native edit, and
 * `isCanonicalDom` tells whether the DOM still has the shape `render` would produce.
 *
 * It reaches back into the editor through callbacks (the current document, placeholder text,
 * and `applySelection`) because the editor owns that state and also constructs this class.
 * Note that `render` finishes by calling `applySelection`, so rendering also moves the caret.
 */
export class DomReconciler<Registry extends ItemRegistry> {
  constructor(
    private readonly element: HTMLElement,
    private readonly itemRenderer: ItemRenderer<Registry>,
    private readonly getDocument: () => BillowDocument<Registry>,
    private readonly getPlaceholder: () => string | undefined,
    private readonly applySelection: (selection: ModelRange) => void,
  ) {}

  readDocument(): BillowDocument<Registry> {
    return readEditorDom(this.element, this.getDocument(), (node) => this.isTrackedItemElement(node));
  }

  /**
   * Whether every child of the editor is something `render` could have put there, in a place it
   * would have put it. Checked child by child:
   * - a text node is always fine;
   * - the trailing-newline `<br>` is fine only as the last child, and only if the document
   *   really ends with "\n";
   * - a caret sentinel is fine only in the places `render` creates one (see below), and only
   *   if it still holds just the zero-width space;
   * - anything else must be the live element of an item, and each item may appear only once.
   *   That rejects stray `<div>`/`<br>` nodes and duplicated item elements left by native edits.
   */
  isCanonicalDom(): boolean {
    const document = this.getDocument();
    const ids = new Set<string>();
    const children = [...this.element.childNodes];
    return children.every((node, index) => {
      if (node.nodeType === Node.TEXT_NODE) return true;
      if (isTrailingNewlineSentinel(node)) return index === children.length - 1 && this.documentEndsWithNewline();
      if (isCaretSentinel(node)) {
        const previous = children[index - 1];
        const next = children[index + 1];
        // The four places `render` puts a caret sentinel; keep in sync with `render` below.
        // Between two items:
        const betweenItems = Boolean(previous && next
          && this.isTrackedItemElement(previous) && this.isTrackedItemElement(next));
        // Before an item that is the first thing in the document:
        const atStart = index === 0
          && Boolean(next && this.isTrackedItemElement(next))
          && typeof document[0] !== "string";
        // Before an item that starts a line (the text before it ends with "\n"):
        const atLineStart = previous?.nodeType === Node.TEXT_NODE
          && previous.textContent?.endsWith("\n")
          && Boolean(next && this.isTrackedItemElement(next));
        // At the very end, when the document is empty or ends with an item:
        const atEnd = index === children.length - 1
          && (documentLength(document) === 0 || typeof document.at(-1) !== "string");
        return (atStart || atLineStart || betweenItems || atEnd)
          && node.textContent === CARET_SENTINEL_TEXT;
      }
      if (!isHtmlElement(node) || !node.dataset.billowItem || ids.has(node.dataset.billowItem)) return false;
      ids.add(node.dataset.billowItem);
      return this.isTrackedItemElement(node);
    });
  }

  /**
   * Rebuilds the editor's children to match the document, then places the selection.
   * `reuseExisting` is false only for the first render, when the element's current children
   * are not ours to keep.
   *
   * Phases: (1) pick up existing text nodes and caret sentinels to reuse; (2) build
   * `desiredNodes`, the exact list of children in order; (3) release items that left the
   * document; (4) apply that list to the DOM, touching only what is not already in place.
   */
  render(selection: ModelRange, reuseExisting = true): void {
    const document = this.getDocument();
    // Phase 1: nodes from the previous render, handed out in order as the loop below needs them.
    const reusableTextNodes = (reuseExisting ? [...this.element.childNodes] : [])
      .filter((node): node is Text => node.nodeType === Node.TEXT_NODE);
    const reusableCaretSentinels = (reuseExisting ? [...this.element.childNodes] : [])
      .filter((node): node is HTMLElement => isCaretSentinel(node));
    let textIndex = 0;
    let caretSentinelIndex = 0;
    // Phase 2 starts here: the children we want, in order, and the item IDs among them.
    const desiredNodes: ChildNode[] = [];
    const desiredItemIds = new Set<string>();
    // A caret sentinel also carries the placeholder text when the whole document is empty.
    const appendCaretSentinel = (): void => {
      const sentinel = reusableCaretSentinels[caretSentinelIndex++] ?? createCaretSentinel(this.element.ownerDocument);
      sentinel.setAttribute("aria-hidden", "true");
      // A reused sentinel may hold text typed into it; reset it to just the zero-width space.
      sentinel.textContent = CARET_SENTINEL_TEXT;
      const placeholder = this.getPlaceholder();
      if (documentLength(document) === 0 && placeholder !== undefined) {
        sentinel.setAttribute("data-billow-placeholder", placeholder);
      } else {
        sentinel.removeAttribute("data-billow-placeholder");
      }
      desiredNodes.push(sentinel);
    };
    for (let index = 0; index < document.length; index += 1) {
      const node = document[index]!;
      if (typeof node === "string") {
        const text = reusableTextNodes[textIndex++] ?? this.element.ownerDocument.createTextNode("");
        text.data = node;
        desiredNodes.push(text);
        continue;
      }
      const previous = document[index - 1];
      // Atom-only line boundaries need a real text caret box. Mixed boundaries
      // continue to use their neighboring text so mobile handles are not trapped.
      if (index === 0 || typeof previous !== "string" || previous.endsWith("\n")) {
        appendCaretSentinel();
      }
      desiredItemIds.add(node.id);
      desiredNodes.push(this.itemRenderer.reconcile(node));
    }
    // End of the document: a final "\n" gets a `<br>` so the empty last line shows; a document
    // that is empty or ends with an item gets a caret sentinel so there is somewhere to type.
    if (this.documentEndsWithNewline()) {
      const sentinel = [...this.element.childNodes].find(isTrailingNewlineSentinel) as HTMLElement | undefined
        ?? createTrailingNewlineSentinel(this.element.ownerDocument);
      desiredNodes.push(sentinel);
    } else if (documentLength(document) === 0 || typeof document.at(-1) !== "string") {
      appendCaretSentinel();
    }
    // Phase 3: items no longer in the document give up their elements.
    this.itemRenderer.releaseExcept(desiredItemIds);
    // Phase 4: make `element.childNodes` equal `desiredNodes`. A node already at its index is
    // left alone; the rest are inserted or moved there, and leftovers at the end are removed.
    desiredNodes.forEach((node, index) => {
      const current = this.element.childNodes[index];
      if (current !== node) this.element.insertBefore(node, current ?? null);
    });
    while (this.element.childNodes.length > desiredNodes.length) {
      this.element.lastChild?.remove();
    }
    this.applySelection(selection);
  }

  isTrackedItemElement(node: Node): node is HTMLElement {
    return isHtmlElement(node) && this.itemRenderer.isTrackedElement(node);
  }

  private documentEndsWithNewline(): boolean {
    const lastNode = this.getDocument().at(-1);
    return typeof lastNode === "string" && lastNode.endsWith("\n");
  }
}
