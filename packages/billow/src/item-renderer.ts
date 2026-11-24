import type {
  BillowDocument,
  BillowNode,
  ItemDefinition,
  ItemPresentation,
  ItemRegistry,
} from "./types.js";
import { createCaretSentinel, isHtmlElement } from "./dom-normalization.js";
import { getItemDefinition, nodesWithPositions } from "./model.js";

type ItemNode<Registry extends ItemRegistry> = Extract<BillowNode<Registry>, { type: "item" }>;

/** Caret rectangles on each side of an item, as the browser would lay them out. */
export type ItemBoundaries = { before: DOMRectReadOnly; after: DOMRectReadOnly; sameLine: boolean };

function centerX(rect: DOMRectReadOnly): number {
  return rect.left + rect.width / 2;
}

/**
 * Horizontal distance a caret would travel crossing the item, signed in screen direction:
 * positive when "after" lies to the right of "before" (left-to-right text), negative in RTL runs.
 */
export function crossingDistance(boundaries: ItemBoundaries): number {
  return centerX(boundaries.after) - centerX(boundaries.before);
}

/** Which side of the item a pointer at `clientX` is closer to. Ties go to "before". */
export function nearerSide(boundaries: ItemBoundaries, clientX: number): "before" | "after" {
  return Math.abs(clientX - centerX(boundaries.before)) <= Math.abs(clientX - centerX(boundaries.after))
    ? "before"
    : "after";
}
type RenderedItem = {
  host: HTMLElement;
  mount: HTMLElement;
  definition: ItemDefinition<any, any, any>;
  data: unknown;
};

/**
 * Owns the DOM element of every item in the document, keyed by item ID.
 *
 * Each item is a `host` span (`data-billow-item`, user-select disabled) containing an inert
 * `mount` span that the registry's `render` fills. `reconcile` reuses an existing element when
 * the item's data is unchanged, calls `update` when the definition has one, and otherwise
 * re-renders from scratch. Elements are released (the definition's `destroy` is called) when
 * their item leaves the document.
 *
 * Errors thrown by a definition are not swallowed: a failed render or update is cleaned up
 * and rethrown, so the editor's own rollback sees it.
 */
export class ItemRenderer<Registry extends ItemRegistry> {
  private readonly renderedItems = new Map<string, RenderedItem>();
  private selectedItemIds = new Set<string>();

  constructor(
    private readonly element: HTMLElement,
    private readonly registry: Registry,
    private readonly getPresentation: () => ItemPresentation<Registry>,
    private readonly reportError: (error: unknown, itemId: string) => void,
  ) {}

  reconcile(node: ItemNode<Registry>): HTMLElement {
    const definition = getItemDefinition(this.registry, node.itemType);
    const existing = this.renderedItems.get(node.id);
    if (existing && existing.definition === definition && Object.is(existing.data, node.data)) return existing.host;
    if (existing && existing.definition === definition && definition.update) {
      this.update(existing, node.id, definition, node.data);
      return existing.host;
    }
    const rendered = this.createRenderedItem(node.id, node.itemType, definition, node.data);
    if (existing) this.releaseReplaced(node.id, rendered);
    this.renderedItems.set(node.id, rendered);
    return rendered.host;
  }

  rerender(node: ItemNode<Registry>): boolean {
    const existing = this.renderedItems.get(node.id);
    if (!existing) return false;
    const definition = getItemDefinition(this.registry, node.itemType);
    if (existing.definition === definition && definition.update) {
      this.update(existing, node.id, definition, node.data);
      return true;
    }
    const rendered = this.createRenderedItem(node.id, node.itemType, definition, node.data);
    this.releaseReplaced(node.id, rendered);
    existing.host.replaceWith(rendered.host);
    this.renderedItems.set(node.id, rendered);
    return true;
  }

  refresh(document: BillowDocument<Registry>, ids?: readonly string[]): void {
    const selectedIds = ids ? new Set(ids) : null;
    for (const node of document) {
      if (typeof node !== "string" && (!selectedIds || selectedIds.has(node.id))) this.rerender(node);
    }
  }

  setSelection(document: BillowDocument<Registry>, range: { anchor: number; focus: number } | null): void {
    const selected = new Set<string>();
    if (range && range.anchor !== range.focus) {
      const start = Math.min(range.anchor, range.focus);
      const end = Math.max(range.anchor, range.focus);
      for (const { node, start: nodeStart, end: nodeEnd } of nodesWithPositions(document)) {
        if (typeof node !== "string" && start < nodeEnd && end > nodeStart) selected.add(node.id);
      }
    }
    this.selectedItemIds = selected;
    for (const [id, rendered] of this.renderedItems) {
      this.applySelectedState(rendered.host, selected.has(id));
    }
  }

  releaseExcept(ids: ReadonlySet<string>): void {
    for (const id of [...this.renderedItems.keys()]) {
      if (!ids.has(id)) this.release(id);
    }
  }

  releaseMissing(document: BillowDocument<Registry>): void {
    const currentIds = new Set(document.flatMap((node) => typeof node === "string" ? [] : [node.id]));
    for (const [id, rendered] of this.renderedItems) {
      if (!currentIds.has(id) || !this.element.contains(rendered.host)) this.release(id);
    }
  }

  isTrackedElement(node: Node): node is HTMLElement {
    if (!isHtmlElement(node)) return false;
    const id = node.dataset.billowItem;
    return Boolean(id && this.renderedItems.get(id)?.host === node);
  }

  itemIdFromNode(node: Node | null): string | null {
    let current = node;
    while (current && current !== this.element) {
      if (this.isTrackedElement(current)) return current.dataset.billowItem ?? null;
      current = current.parentNode;
    }
    return null;
  }

  /**
   * Measures where the caret sits on each side of an item. Item content is inert, so the
   * browser cannot report this directly: two zero-width caret spans are inserted around the
   * item, measured, and removed again before returning, so the DOM is unchanged afterwards.
   */
  measureItemBoundaries(id: string): ItemBoundaries | null {
    const rendered = this.renderedItems.get(id);
    if (!rendered || !rendered.host.isConnected) return null;
    // Step 1: find the rectangle of a nearby text character, to borrow its vertical position
    // and height. Prefers the first character after the item, else the last one before it, in
    // each case skipping over neighbouring items. A "\n" has no glyph box, so it is no use.
    const adjacentTextRect = (): DOMRectReadOnly | null => {
      const measure = (node: Node, fromEnd: boolean): DOMRectReadOnly | null => {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent) return null;
        const offset = fromEnd ? node.textContent.length - 1 : 0;
        if (node.textContent[offset] === "\n") return null;
        const range = this.element.ownerDocument.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        return range.getClientRects()[0] ?? null;
      };
      let sibling = rendered.host.nextSibling;
      while (sibling && isHtmlElement(sibling) && sibling.hasAttribute("data-billow-item")) sibling = sibling.nextSibling;
      const after = sibling ? measure(sibling, false) : null;
      if (after) return after;
      sibling = rendered.host.previousSibling;
      while (sibling && isHtmlElement(sibling) && sibling.hasAttribute("data-billow-item")) sibling = sibling.previousSibling;
      return sibling ? measure(sibling, true) : null;
    };
    const textRect = adjacentTextRect();
    // Step 2: put a zero-width caret span on each side of the item. The browser lays them out
    // like a real caret position, which is what is measured. (Removed again in step 4.)
    const before = createCaretSentinel(this.element.ownerDocument);
    const after = createCaretSentinel(this.element.ownerDocument);
    rendered.host.before(before);
    rendered.host.after(after);
    // Step 3: measure. Keep each span's horizontal position and width, but if there is
    // neighbouring text, take its vertical position and height so the result describes a
    // caret on the text line rather than a box shaped by the item. `sameLine` is whether the
    // two edges overlap vertically, i.e. the item has not wrapped across two lines.
    const beforeRect = before.getBoundingClientRect();
    const afterRect = after.getBoundingClientRect();
    const alignToText = (rect: DOMRect): DOMRectReadOnly => textRect
      ? new this.element.ownerDocument.defaultView!.DOMRect(rect.x, textRect.y, rect.width, textRect.height)
      : rect;
    const rects = {
      before: alignToText(beforeRect),
      after: alignToText(afterRect),
      sameLine: beforeRect.top < afterRect.bottom && afterRect.top < beforeRect.bottom,
    };
    // Step 4: leave the DOM as it was found.
    before.remove();
    after.remove();
    return rects;
  }

  releaseAll(): void {
    const errors: unknown[] = [];
    for (const id of [...this.renderedItems.keys()]) {
      try {
        this.release(id);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Multiple item cleanup failures");
  }

  private createRenderedItem(
    id: string,
    itemType: string,
    definition: ItemDefinition<any, any, any>,
    data: unknown,
  ): RenderedItem {
    const host = this.element.ownerDocument.createElement("span");
    host.dataset.billowItem = id;
    host.dataset.billowItemType = itemType;
    host.removeAttribute("contenteditable");
    host.draggable = false;
    const mount = this.element.ownerDocument.createElement("span");
    mount.dataset.billowInertContent = "";
    mount.inert = true;
    host.append(mount);
    const context = this.createContext(mount, id);
    try {
      const rendered = definition.render(data, context);
      if (rendered !== undefined) mount.replaceChildren(typeof rendered === "string"
        ? this.element.ownerDocument.createTextNode(rendered)
        : rendered);
      this.applyItemState(host, id, definition, data, context);
    } catch (error) {
      try {
        definition.destroy?.(mount, data);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Item rendering and cleanup failed");
      }
      throw error;
    }
    return { host, mount, definition, data };
  }

  private update(
    rendered: RenderedItem,
    id: string,
    definition: ItemDefinition<any, any, any>,
    data: unknown,
  ): void {
    const context = this.createContext(rendered.mount, id);
    const previousData = rendered.data;
    const restoreDom = captureDom(rendered.mount);
    try {
      definition.update!(rendered.mount, previousData, data, context);
      this.applyItemState(rendered.host, id, definition, data, context);
      rendered.data = data;
    } catch (error) {
      restoreDom();
      rendered.data = previousData;
      throw error;
    }
  }

  private applyItemState(
    item: HTMLElement,
    id: string,
    definition: ItemDefinition<any, any, any>,
    data: unknown,
    context: ReturnType<ItemRenderer<Registry>["createContext"]>,
  ): void {
    const attributes = {
      role: "img",
      "aria-label": definition.getLabel?.(data) ?? definition.toPlainText(data),
      ...definition.getAccessibilityAttributes?.(data, context),
    };
    item.style.setProperty("user-select", "none");
    item.style.setProperty("-webkit-user-select", "none");
    this.applySelectedState(item, this.selectedItemIds.has(id));
    for (const name of item.getAttributeNames()) {
      if (name === "role" || name.startsWith("aria-")) item.removeAttribute(name);
    }
    for (const [name, value] of Object.entries(attributes)) {
      if ((name === "role" || name.startsWith("aria-")) && value !== null && value !== undefined) item.setAttribute(name, value);
    }
  }

  private createContext(mount: HTMLElement, id: string) {
    return {
      document: this.element.ownerDocument,
      itemId: id,
      element: mount,
      presentation: this.getPresentation(),
      reportError: (error: unknown) => this.reportError(error, id),
    };
  }

  /**
   * Releases the item that `replacement` is about to take over. If the old item's `destroy`
   * throws, the replacement is destroyed too, so a failed swap leaks nothing.
   */
  private releaseReplaced(id: string, replacement: RenderedItem): void {
    try {
      this.release(id);
    } catch (error) {
      try {
        replacement.definition.destroy?.(replacement.mount, replacement.data);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Item replacement and cleanup failed");
      }
      throw error;
    }
  }

  private release(id: string): void {
    const rendered = this.renderedItems.get(id);
    if (!rendered) return;
    rendered.definition.destroy?.(rendered.mount, rendered.data);
    this.renderedItems.delete(id);
    this.selectedItemIds.delete(id);
  }

  private applySelectedState(item: HTMLElement, selected: boolean): void {
    item.toggleAttribute("data-billow-selected", selected);
    item.removeAttribute("contenteditable");
  }
}

function captureDom(root: Node): () => void {
  const snapshots = new Map<Node, { children: readonly ChildNode[]; data?: string; attributes?: readonly [string, string][] }>();
  const visit = (node: Node): void => {
    const children = [...node.childNodes];
    snapshots.set(node, {
      children,
      ...(node.nodeType === Node.TEXT_NODE ? { data: (node as Text).data } : {}),
      ...(node.nodeType === Node.ELEMENT_NODE
        ? { attributes: [...(node as Element).attributes].map(({ name, value }) => [name, value] as const) }
        : {}),
    });
    children.forEach(visit);
  };
  visit(root);
  return () => {
    for (const [node, snapshot] of snapshots) {
      if (snapshot.data !== undefined) (node as Text).data = snapshot.data;
      if (snapshot.attributes && node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
        for (const [name, value] of snapshot.attributes) element.setAttribute(name, value);
      }
      if (node.nodeType === Node.ELEMENT_NODE) (node as Element).replaceChildren(...snapshot.children);
    }
  };
}
