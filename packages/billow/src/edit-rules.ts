// The rules that decide who performs an edit: the browser, or the editor itself.
//
// Plain typing and single-character deletion are left to the browser where it gets them exactly
// right (the "native path"). Everything else is done by the editor in the model (the "intercepted
// path"). These functions answer that question from the document and the selection alone, with
// no DOM, so they can be unit tested. The few facts that can only come from the DOM are passed in.
// See the `BillowEditor` class comment for how the two paths work.

import { expandEditingRange, logicalLineAt, moveByGrapheme, rangeTouchesItem } from "./editing.js";
import { nodesWithPositions, sliceDocument } from "./model.js";
import type { BillowDocument, ItemRegistry, ModelRange } from "./types.js";

export type DeleteDirection = "backward" | "forward";

export type DeleteDecision =
  | { readonly handler: "native" }
  | { readonly handler: "intercept"; readonly range: ModelRange };

const NATIVE: DeleteDecision = { handler: "native" };

function intercept(range: ModelRange): DeleteDecision {
  return { handler: "intercept", range };
}

function sameOrderedRange(left: ModelRange, right: ModelRange): boolean {
  return Math.min(left.anchor, left.focus) === Math.min(right.anchor, right.focus)
    && Math.max(left.anchor, left.focus) === Math.max(right.anchor, right.focus);
}

/**
 * What one Backspace/Delete press removes: the selection if there is one, otherwise the single
 * grapheme (not code unit) before or after the caret. The range runs from the caret outwards.
 */
export function deletionRange<Registry extends ItemRegistry>(
  document: BillowDocument<Registry>,
  selection: ModelRange,
  direction: DeleteDirection,
): ModelRange {
  if (selection.anchor !== selection.focus) return selection;
  return {
    anchor: selection.focus,
    focus: moveByGrapheme(document, selection.focus, direction === "backward" ? -1 : 1),
  };
}

/**
 * The range a Backspace/Delete press would remove, if the browser can remove exactly that
 * itself; null when the editor has to do it. The browser is only trusted for one plain,
 * single-code-unit character in a text node, and not in these cases:
 *
 * - the range is not exactly one position, or is not a whole grapheme, or touches an item;
 * - it is a newline;
 * - it is the last character of the document, right after a "\n";
 * - it is the only character of its text node and an item sits next to it.
 */
export function nativeTextDeletionRange<Registry extends ItemRegistry>(
  document: BillowDocument<Registry>,
  selection: ModelRange,
  direction: DeleteDirection,
): ModelRange | null {
  const deletion = deletionRange(document, selection, direction);
  if (deletion.anchor === deletion.focus || Math.abs(deletion.anchor - deletion.focus) !== 1) return null;
  const expanded = expandEditingRange(document, deletion);
  if (expanded.anchor !== deletion.anchor || expanded.focus !== deletion.focus) return null;
  if (rangeTouchesItem(document, deletion)) return null;
  const nodes = sliceDocument(document, deletion);
  if (nodes.length !== 1 || typeof nodes[0] !== "string" || nodes[0].includes("\n")) return null;
  const start = Math.min(deletion.anchor, deletion.focus);
  for (const { node, index, start: nodeStart, end: nodeEnd } of nodesWithPositions(document)) {
    if (typeof node !== "string" || start < nodeStart || start >= nodeEnd) continue;
    const length = node.length;
    // Chromium/WebKit add a padding break when deleting the final character
    // after LF. Native reconciliation would mistake it for another newline.
    if (index === document.length - 1 && start - nodeStart === length - 1
      && node[length - 2] === "\n") return null;
    const removesNode = length === 1;
    const besideItem = (document[index - 1] !== undefined && typeof document[index - 1] !== "string")
      || (document[index + 1] !== undefined && typeof document[index + 1] !== "string");
    // Chromium pads a newly exposed inline-flex atom with a block break.
    if (removesNode && besideItem) return null;
    break;
  }
  return deletion;
}

/**
 * Decides a single Backspace/Delete press, whether it arrives as a keydown (`target` is null)
 * or as a `beforeinput` (`target` is the range the browser says it will delete, if it said).
 * The browser keeps it only if it would delete exactly the character the editor would.
 */
export function decideCharacterDeletion<Registry extends ItemRegistry>(
  document: BillowDocument<Registry>,
  selection: ModelRange,
  direction: DeleteDirection,
  target: ModelRange | null,
): DeleteDecision {
  const nativeRange = nativeTextDeletionRange(document, selection, direction);
  const sameTarget = nativeRange !== null && (target === null || sameOrderedRange(target, nativeRange));
  return sameTarget ? NATIVE : intercept(deletionRange(document, selection, direction));
}

/**
 * Decides any other deletion (a word, a line, a selection, a drag...). These stay native unless
 * the browser's `target` includes an item, or, for a directional one, an item sits right next to
 * the caret in that direction. `selection` is the live selection, or null if there is none;
 * `direction` is null for deletions that have none.
 */
export function decideRangeDeletion<Registry extends ItemRegistry>(
  document: BillowDocument<Registry>,
  selection: ModelRange | null,
  direction: DeleteDirection | null,
  target: ModelRange | null,
): DeleteDecision {
  if (target && rangeTouchesItem(document, target)) return intercept(target);
  if (direction) {
    const adjacentItem = adjacentItemDeletionRange(document, selection, direction);
    if (adjacentItem) return intercept(adjacentItem);
  }
  return NATIVE;
}

/**
 * The item directly next to a collapsed caret in the given direction, as the range to delete.
 * Null when the selection is missing or not collapsed, or no item is adjacent that way.
 */
export function adjacentItemDeletionRange<Registry extends ItemRegistry>(
  document: BillowDocument<Registry>,
  selection: ModelRange | null,
  direction: DeleteDirection,
): ModelRange | null {
  if (!selection || selection.anchor !== selection.focus) return null;
  for (const { node, start, end } of nodesWithPositions(document)) {
    if (typeof node === "string") continue;
    if (direction === "backward" ? end === selection.focus : start === selection.focus) {
      return { anchor: selection.focus, focus: direction === "backward" ? start : end };
    }
  }
  return null;
}

/** Whether `range` is a collapsed caret placed directly after a "\n". */
export function caretFollowsNewline<Registry extends ItemRegistry>(
  document: BillowDocument<Registry>,
  range: ModelRange,
): boolean {
  if (range.anchor !== range.focus || range.focus === 0) return false;
  const previous = sliceDocument(document, { anchor: range.focus - 1, focus: range.focus });
  return previous.length === 1 && previous[0] === "\n";
}

/** What only the DOM can tell about where the browser's own caret is. Each is asked only if needed. */
export interface InsertDomFacts {
  /** The browser's selection has an endpoint inside an item's element. */
  endpointInsideItem(): boolean;
  /** The browser's selection has an endpoint inside a caret sentinel (a helper node, not real text). */
  endpointInsideCaretSentinel(): boolean;
}

/**
 * Whether the editor must perform a text insertion itself because the browser's own insertion
 * would land somewhere it cannot handle: over an item, inside an item's element, in a caret
 * sentinel, or right after a newline. Otherwise the browser types natively.
 */
export function shouldInterceptInsert<Registry extends ItemRegistry>(
  document: BillowDocument<Registry>,
  selection: ModelRange,
  dom: InsertDomFacts,
): boolean {
  return rangeTouchesItem(document, selection)
    || dom.endpointInsideItem()
    || dom.endpointInsideCaretSentinel()
    || caretFollowsNewline(document, selection);
}

/**
 * Edge of the line containing `position`, but only if that line holds items and no text
 * (Cmd/Ctrl+Arrow on such a line jumps there). Null for any other line.
 */
export function atomOnlyLineBoundary<Registry extends ItemRegistry>(
  document: BillowDocument<Registry>,
  position: number,
  direction: DeleteDirection,
): number | null {
  const line = logicalLineAt(document, position);
  if (!line.hasItem || line.hasText) return null;
  return direction === "backward" ? line.start : line.end;
}
