import {
  CARET_SENTINEL_TEXT,
  impliesLineBreakBefore,
  isCaretSentinel,
  isTrailingNewlineSentinel,
  normalizedDomLength,
} from "./dom-normalization.js";
import { documentLength } from "./model.js";
import type { BillowDocument, ItemRegistry, ModelRange } from "./types.js";

type DomPoint = { node: Node; offset: number };

type ItemDomRange = { element: HTMLElement; start: number; end: number };

/**
 * Converts between DOM selection points (node + offset) and model positions.
 *
 * `modelToDom` picks a point the browser can actually place a caret at, preferring a caret
 * sentinel over the boundary of an item. `domToModel` measures what precedes a point using the
 * same rules as `readEditorDom`, so DOM reading and position mapping agree (see
 * `impliesLineBreakBefore`). Points inside an item are mapped to one of its two edges, because
 * item content is inert and its DOM offsets cannot be trusted.
 */
export class SelectionMapping<Registry extends ItemRegistry> {
  constructor(
    private readonly element: HTMLElement,
    private readonly getDocument: () => BillowDocument<Registry>,
    private readonly isTrackedItemElement: (node: Node) => node is HTMLElement,
  ) {}

  modelToDom(position: number): DomPoint {
    let offset = position;
    const children = [...this.element.childNodes];
    if (position === documentLength(this.getDocument()) && isTrailingNewlineSentinel(children.at(-1) ?? null)) {
      return { node: this.element, offset: children.length - 1 };
    }
    if (position === documentLength(this.getDocument()) && isCaretSentinel(children.at(-1) ?? null)) {
      return { node: children.at(-1)!.firstChild!, offset: CARET_SENTINEL_TEXT.length };
    }
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (child.nodeType === Node.TEXT_NODE) {
        const length = child.textContent?.length ?? 0;
        if (offset < length) return { node: child, offset };
        if (offset === length) {
          const next = children[index + 1];
          if (next && isCaretSentinel(next)) return { node: next.firstChild!, offset: CARET_SENTINEL_TEXT.length };
          return { node: child, offset };
        }
        offset -= length;
      } else if (isCaretSentinel(child)) {
        if (offset === 0) return { node: child.firstChild!, offset: CARET_SENTINEL_TEXT.length };
      } else {
        if (offset === 0) return { node: this.element, offset: index };
        offset -= 1;
      }
    }
    return { node: this.element, offset: children.length };
  }

  domToModel(node: Node, domOffset: number): number | null {
    if (node !== this.element && !this.element.contains(node)) return null;
    if (node === this.element) return this.domPointLength(this.element, node, domOffset);
    let direct = node;
    while (direct.parentNode !== this.element && direct.parentNode) direct = direct.parentNode;
    const children = [...this.element.childNodes];
    const index = children.indexOf(direct as ChildNode);
    if (index < 0) return null;
    const before = this.domNodeStart(index);
    if (isCaretSentinel(direct)) return before;
    if (this.isTrackedItemElement(direct)) {
      return before + (domOffset > 0 ? 1 : 0);
    }
    return this.domPointLength(this.element, node, domOffset) ?? before;
  }

  domSelectionToModel(selection: Selection): ModelRange | null {
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !focusNode) return null;
    let anchor = this.domToModel(anchorNode, selection.anchorOffset);
    let focus = this.domToModel(focusNode, selection.focusOffset);
    if (anchor === null || focus === null) return null;
    const anchorItem = this.itemRangeAt(anchorNode);
    const focusItem = this.itemRangeAt(focusNode);

    // Chromium can relocate the fixed end of a Shift+Arrow range into the
    // editable item host as the moving end leaves it. Snap only such endpoints
    // outward so the inert atom remains one model unit and direction is retained.
    if (anchorItem && focusItem && anchorItem.element !== focusItem.element) {
      if (anchorItem.start < focusItem.start) {
        anchor = anchorItem.start;
        focus = focusItem.end;
      } else {
        anchor = anchorItem.end;
        focus = focusItem.start;
      }
    } else if (anchorItem && !focusItem) {
      if (focus <= anchorItem.start) anchor = anchorItem.end;
      else if (focus >= anchorItem.end) anchor = anchorItem.start;
    } else if (focusItem && !anchorItem) {
      if (anchor <= focusItem.start) focus = focusItem.end;
      else if (anchor >= focusItem.end) focus = focusItem.start;
    }
    return { anchor, focus };
  }

  private domPointLength(parent: Node, target: Node, targetOffset: number): number | null {
    const children = [...parent.childNodes];
    let length = 0;
    for (let index = 0; index < children.length; index += 1) {
      if (parent === target && index === targetOffset) return length;
      const child = children[index]!;
      if (impliesLineBreakBefore(children, index)) length += 1;
      if (child === target) {
        if (child.nodeType === Node.TEXT_NODE) {
          return length + Math.min(targetOffset, child.textContent?.length ?? 0);
        }
        return length + (this.domPointLength(child, target, targetOffset) ?? 0);
      }
      if (child.contains(target)) {
        const nested = this.domPointLength(child, target, targetOffset);
        return nested === null ? null : length + nested;
      }
      length += this.domNodeLength(child);
    }
    return parent === target ? length : null;
  }

  private domNodeStart(index: number): number {
    const children = [...this.element.childNodes];
    let length = 0;
    for (let childIndex = 0; childIndex < index; childIndex += 1) {
      if (impliesLineBreakBefore(children, childIndex)) length += 1;
      length += this.domNodeLength(children[childIndex]!);
    }
    // The line break before the node itself belongs to the position just before it.
    if (children[index] && impliesLineBreakBefore(children, index)) length += 1;
    return length;
  }

  private itemRangeAt(node: Node): ItemDomRange | null {
    if (node === this.element || !this.element.contains(node)) return null;
    let direct = node;
    while (direct.parentNode !== this.element && direct.parentNode) direct = direct.parentNode;
    if (!this.isTrackedItemElement(direct)) return null;
    const children = [...this.element.childNodes];
    const index = children.indexOf(direct);
    if (index < 0) return null;
    // DOM offsets cannot be trusted inside renderer-owned content, so derive the
    // atom's exact range solely from canonical root siblings.
    const start = this.domNodeStart(index);
    return { element: direct, start, end: start + 1 };
  }

  private domNodeLength(node: Node): number {
    return this.isTrackedItemElement(node) ? 1 : normalizedDomLength(this.getDocument(), node, true);
  }
}
