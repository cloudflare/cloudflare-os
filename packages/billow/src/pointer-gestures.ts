import { logicalLineAt, wordBoundaryAt } from "./editing.js";
import { nearerSide, type ItemRenderer } from "./item-renderer.js";
import { documentLength, findItemRange } from "./model.js";
import type { SelectionMapping } from "./selection-mapping.js";
import type { BillowDocument, ItemRegistry, ModelRange } from "./types.js";

/** A touch that moves farther than this many CSS pixels is a scroll or drag, not a tap on an item. */
const TAP_SLOP_PX = 8;

/** What the gestures need from the editor that owns them. */
export interface PointerGestureHost<Registry extends ItemRegistry> {
  getDocument(): BillowDocument<Registry>;
  isReadOnly(): boolean;
  isDestroyed(): boolean;
  /** Moves both the model selection and the native DOM selection. */
  applySelection(range: ModelRange): void;
  /** Stops the current typing/deleting run from merging into the next edit's undo step. */
  endHistoryGroup(): void;
  /** Forgets a remembered Shift+Arrow anchor; a pointer press starts a new selection. */
  clearShiftAnchor(): void;
}

/**
 * Pointer handling for places the browser cannot handle on its own: items are inert, so native
 * hit testing, double-click and drag selection do not work on them. Everything else is left to
 * the browser. The gestures are:
 *
 * - Touch tap on an item: caret on the nearer side of the item. Touch long-press (the browser
 *   cancels the pointer): selects the whole item. Both are applied on a timeout so the
 *   browser's own handling of the same touch has finished first.
 * - Mouse press on an item: caret on the nearer side; dragging from there extends the selection.
 * - Double press on an item: selects the item; dragging extends it word by word.
 * - Triple press on a line that contains an item: selects the whole line.
 * - Press on blank padding in a read-only editor: places a caret (browsers don't for
 *   non-editable roots).
 */
export class PointerGestures<Registry extends ItemRegistry> {
  private lastPointerType = "";
  private lastPointerId: number | null = null;
  /** Touch pressed on an item and not yet released, cancelled or moved past the tap slop. */
  private pendingItemTap: { itemId: string; pointerId: number; x: number; y: number } | null = null;
  /** Drag started by a single mouse press on an item; `anchor` is the side the caret was put on. */
  private caretDrag: { anchor: number; pointerId: number } | null = null;
  /** Drag started by a double press on an item; `range` is the item itself. */
  private wordDrag: { range: ModelRange; pointerId: number } | null = null;

  constructor(
    private readonly element: HTMLElement,
    private readonly itemRenderer: ItemRenderer<Registry>,
    private readonly selectionMapping: SelectionMapping<Registry>,
    private readonly host: PointerGestureHost<Registry>,
  ) {}

  /** Forgets an in-flight touch, e.g. when the editor is destroyed before it completes. */
  cancelPending(): void {
    this.pendingItemTap = null;
  }

  handlePointerDown(event: PointerEvent): void {
    this.host.clearShiftAnchor();
    this.wordDrag = null;
    this.caretDrag = null;
    this.lastPointerType = event.pointerType;
    this.lastPointerId = event.pointerId;
    this.host.endHistoryGroup();
    if (event.pointerType === "touch" && event.button === 0) {
      const itemId = this.itemRenderer.itemIdFromNode(event.target as Node | null);
      if (itemId) {
        this.pendingItemTap = {
          itemId,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        };
        return;
      }
    }
    if (!this.host.isReadOnly() || event.button !== 0 || this.pointIntersectsContent(event.clientX, event.clientY)) return;
    // A non-editable root does not let browsers place a caret in its padding.
    // Preserve normal content clicks, but map a blank-area click to a model caret.
    event.preventDefault();
    const position = this.modelPositionAtPoint(event.clientX, event.clientY) ?? documentLength(this.host.getDocument());
    this.host.applySelection({ anchor: position, focus: position });
  }

  handlePointerMove(event: PointerEvent): void {
    const caretDrag = this.caretDrag;
    if (caretDrag && event.pointerId === caretDrag.pointerId) {
      if ((event.buttons & 1) === 0) {
        this.caretDrag = null;
        return;
      }
      event.preventDefault();
      const position = this.modelPositionAtPoint(event.clientX, event.clientY);
      if (position !== null) this.host.applySelection({ anchor: caretDrag.anchor, focus: position });
      return;
    }
    const wordDrag = this.wordDrag;
    if (wordDrag && event.pointerId === wordDrag.pointerId) {
      if ((event.buttons & 1) === 0) {
        this.wordDrag = null;
        return;
      }
      event.preventDefault();
      this.extendWordDrag(wordDrag.range, event.clientX, event.clientY);
      return;
    }
    const pending = this.pendingItemTap;
    if (pending && event.pointerId === pending.pointerId
      && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > TAP_SLOP_PX) {
      this.pendingItemTap = null;
    }
  }

  /** Handles both `pointerup` and `pointercancel`; a cancelled touch on an item is a long press. */
  handlePointerEnd(event: PointerEvent): void {
    if (this.wordDrag?.pointerId === event.pointerId) this.wordDrag = null;
    if (this.caretDrag?.pointerId === event.pointerId) this.caretDrag = null;
    const pending = this.pendingItemTap;
    if (!pending || event.pointerId !== pending.pointerId) return;
    this.pendingItemTap = null;
    const longPress = event.type === "pointercancel";
    if ((event.type !== "pointerup" && !longPress)
      || Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > TAP_SLOP_PX) return;
    const item = findItemRange(this.host.getDocument(), pending.itemId);
    if (!item) return;
    const boundaries = this.itemRenderer.measureItemBoundaries(pending.itemId);
    if (!boundaries) return;
    const focus = nearerSide(boundaries, pending.x) === "before" ? item.anchor : item.focus;
    const range = longPress
      ? item
      : { anchor: focus, focus };
    event.preventDefault();
    this.element.ownerDocument.defaultView?.setTimeout(() => {
      if (this.host.isDestroyed()) return;
      // The item may have moved or gone while waiting; only apply if it is still where it was.
      const current = findItemRange(this.host.getDocument(), pending.itemId);
      if (!current || current.anchor !== item.anchor || current.focus !== item.focus) return;
      if (!this.host.isReadOnly()) this.element.focus({ preventScroll: true });
      this.host.applySelection(range);
    }, 0);
  }

  /**
   * Left mouse press. `event.detail` is the press count: 1 single, 2 double, 3 triple.
   * Only for a mouse: touch taps are handled in `handlePointerEnd`, and pen is left to the
   * browser. Shift+press is also left to the browser.
   * `id` is the item under the pointer, if the press landed on one.
   */
  handleMouseDown(event: MouseEvent): void {
    if (this.lastPointerType !== "mouse" || event.button !== 0 || event.shiftKey) return;
    const document = this.host.getDocument();
    const id = this.itemRenderer.itemIdFromNode(event.target as Node | null);

    // Triple press: select the whole logical line, but only if it contains an item.
    if (event.detail === 3) {
      // Chromium cannot select a paragraph through an inline atom, so a third press
      // selects the logical line itself. Item-free lines keep native behavior.
      const position = (id ? findItemRange(document, id)?.anchor : undefined)
        ?? this.modelPositionAtPoint(event.clientX, event.clientY);
      const line = position === null ? null : logicalLineAt(document, position);
      if (!line?.hasItem) return;
      event.preventDefault();
      this.element.focus({ preventScroll: true });
      // `line.end` is the position of the line's "\n"; include it, unless the line is the last.
      this.host.applySelection({ anchor: line.start, focus: line.end < documentLength(document) ? line.end + 1 : line.end });
      return;
    }

    // Anything below needs an item under the pointer; presses on plain text stay native.
    if (!id) return;
    const range = findItemRange(document, id);
    if (!range) return;

    // Double press: select the item, and let a drag from here grow the selection by words.
    // Pointer capture keeps the move events coming even if the pointer leaves the editor.
    if (event.detail === 2) {
      event.preventDefault();
      this.element.focus({ preventScroll: true });
      const pointerId = this.lastPointerId;
      if (pointerId !== null) {
        this.element.setPointerCapture(pointerId);
        this.wordDrag = { range, pointerId };
      }
      this.host.applySelection(range);
      return;
    }

    // Single press: put a collapsed caret on the nearer side of the item, and let a drag from
    // there extend the selection (via `caretDrag`).
    if (event.detail !== 1) return;
    const boundaries = this.itemRenderer.measureItemBoundaries(id);
    if (!boundaries) return;
    // Inert descendants make native hit testing collapse into the editable host.
    // Compare temporary boundary geometry so a single press still picks the
    // logical side of the atom, including mixed-direction text.
    const target = nearerSide(boundaries, event.clientX) === "before" ? range.anchor : range.focus;
    event.preventDefault();
    this.element.focus({ preventScroll: true });
    this.host.applySelection({ anchor: target, focus: target });
    const pointerId = this.lastPointerId;
    if (pointerId !== null) {
      this.element.setPointerCapture(pointerId);
      this.caretDrag = { anchor: target, pointerId };
    }
  }

  handleDoubleClick(event: MouseEvent): void {
    if (event.button !== 0) return;
    const id = this.itemRenderer.itemIdFromNode(event.target as Node | null);
    const range = id ? findItemRange(this.host.getDocument(), id) : null;
    if (!range) return;
    // Browsers disagree on whether a second press may select an editable host
    // whose descendants are inert. An atom has one unambiguous model range.
    event.preventDefault();
    this.host.applySelection(range);
  }

  /** Drag after a double press on an item: keep the item selected and grow by whole words. */
  private extendWordDrag(range: ModelRange, clientX: number, clientY: number): void {
    const position = this.modelPositionAtPoint(clientX, clientY);
    if (position === null) return;
    const document = this.host.getDocument();
    if (position <= range.anchor) {
      this.host.applySelection({ anchor: range.focus, focus: wordBoundaryAt(document, position, -1) });
    } else if (position >= range.focus) {
      this.host.applySelection({ anchor: range.anchor, focus: wordBoundaryAt(document, position, 1) });
    } else {
      this.host.applySelection(range);
    }
  }

  private modelPositionAtPoint(clientX: number, clientY: number): number | null {
    const document = this.element.ownerDocument;
    // Current Chromium, Firefox and WebKit all have the standard caretPositionFromPoint. Older
    // engines (e.g. embedded WebViews) may only have the legacy caretRangeFromPoint, which
    // lib.dom marks deprecated, so it is typed locally. Either result still needs converting
    // because the DOM includes zero-length editor helpers.
    const position = document.caretPositionFromPoint?.(clientX, clientY);
    if (position) return this.selectionMapping.domToModel(position.offsetNode, position.offset);
    const legacy = document as { caretRangeFromPoint?(x: number, y: number): Range | null };
    const range = legacy.caretRangeFromPoint?.(clientX, clientY);
    return range ? this.selectionMapping.domToModel(range.startContainer, range.startOffset) : null;
  }

  private pointIntersectsContent(clientX: number, clientY: number): boolean {
    const range = this.element.ownerDocument.createRange();
    // elementFromPoint returns the editor for both text gaps and padding. Range
    // rectangles distinguish actual rendered content without layout assumptions.
    return [...this.element.childNodes].some((node) => {
      range.selectNode(node);
      return [...range.getClientRects()].some((rect) => clientX >= rect.left && clientX <= rect.right
        && clientY >= rect.top && clientY <= rect.bottom);
    });
  }
}
