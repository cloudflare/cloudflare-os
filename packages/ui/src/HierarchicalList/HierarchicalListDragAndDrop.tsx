import { useEffect, useRef, useState, type RefObject } from "react";
import type { HierarchicalListItem } from "./HierarchicalList.types";

const EDGE_SIZE_PX = 72;
const MAX_PX_PER_FRAME = 14;

/** An insertion position after the moved item has been removed from its original parent. */
export type HierarchicalListDropDestination = {
  /** Parent that will contain the item, or `null` for the root list. */
  parent: HierarchicalListItem | null;
  /** Insertion index after the moved item has been removed from its previous parent. */
  index: number;
};

type RawDropDestination = {
  parent: HierarchicalListItem | null;
  index: number;
};

type DragPosition = { x: number; y: number };

type DragAutoScrollOptions = {
  enabled?: boolean;
  position: DragPosition | null;
  onScroll?: (position: DragPosition) => void;
};

/** Optional drag-and-drop behavior for a hierarchical list. */
export type HierarchicalListDragAndDropOptions = {
  /** Enables edge-triggered scrolling during mouse and touch dragging. */
  autoScroll?: boolean;
  /** Applies a move to the supplied post-removal destination. */
  onMove: (item: HierarchicalListItem, destination: HierarchicalListDropDestination) => void;
};

type DropIndicatorEdge = "top" | "center" | "bottom";

/** Calculated list-relative geometry supplied to an indicator renderer. */
export type DropIndicatorPosition = {
  left: number;
  top: number;
  width: number;
  visible: boolean;
};

/** Mutable drag session state shared by primitive rows. @internal */
export type HierarchicalListDragAndDropController = {
  draggedItem: HierarchicalListItem | null;
  dropIndicator: DropIndicatorPosition | null;
  dropTargetId: string | null;
  touchDragPosition: DragPosition | null;
  setDraggedItem: (item: HierarchicalListItem | null) => void;
  setDropTargetId: (id: string | null) => void;
  setTouchDragPosition: (position: DragPosition | null) => void;
  updateDropIndicator: (
    element: HTMLElement,
    inset: number,
    edge: DropIndicatorEdge,
    visible: boolean,
  ) => void;
};

const containsItem = (item: HierarchicalListItem, id: string): boolean =>
  item.children?.some((child) => child.id === id || containsItem(child, id)) ?? false;

/** Returns whether a source can move inside a destination item. @internal */
export const canDrop = (
  source: HierarchicalListItem,
  destination: HierarchicalListItem,
): boolean => source.id !== destination.id && !containsItem(source, destination.id);

/** Returns whether a source can be inserted among a parent's children. @internal */
export const canInsertInto = (
  source: HierarchicalListItem,
  parent: HierarchicalListItem | null,
): boolean => !parent || (
  (Boolean(parent.droppable) || Boolean(parent.children?.some((child) => child.id === source.id)))
  && parent.id !== source.id
  && !containsItem(source, parent.id)
);

/** Builds the stable internal identity of an insertion target. @internal */
export const insertionTargetId = (parent: HierarchicalListItem | null, index: number) =>
  `between:${parent?.id ?? "root"}:${index}`;

/** Builds the stable internal identity of an inside-item target. @internal */
export const insideTargetId = (item: HierarchicalListItem) => `inside:${item.id}`;

const findItemPosition = (
  items: readonly HierarchicalListItem[],
  id: string,
  parent: HierarchicalListItem | null = null,
): { parent: HierarchicalListItem | null; index: number } | null => {
  for (const [index, item] of items.entries()) {
    if (item.id === id) return { parent, index };
    const nested = item.children && findItemPosition(item.children, id, item);
    if (nested) return nested;
  }
  return null;
};

type HierarchicalListKeyboardMove = "up" | "down" | "left" | "right";

/** Returns a pre-removal destination for one keyboard movement step. @internal */
export const getKeyboardMoveDestination = (
  items: readonly HierarchicalListItem[],
  source: HierarchicalListItem,
  direction: HierarchicalListKeyboardMove,
): RawDropDestination | null => {
  const position = findItemPosition(items, source.id);
  if (!position) return null;
  const siblings = position.parent?.children ?? items;

  if (direction === "up") {
    return position.index > 0 ? { parent: position.parent, index: position.index - 1 } : null;
  }
  if (direction === "down") {
    return position.index < siblings.length - 1
      ? { parent: position.parent, index: position.index + 2 }
      : null;
  }
  if (direction === "left") {
    if (!position.parent) return null;
    const parentPosition = findItemPosition(items, position.parent.id);
    if (!parentPosition || !canInsertInto(source, parentPosition.parent)) return null;
    return { parent: parentPosition.parent, index: parentPosition.index + 1 };
  }

  const previousSibling = siblings[position.index - 1];
  return previousSibling?.droppable && canDrop(source, previousSibling)
    ? { parent: previousSibling, index: previousSibling.children?.length ?? 0 }
    : null;
};

/** Converts a DOM drop position into the public post-removal insertion position. @internal */
export const normalizeDropDestination = (
  items: readonly HierarchicalListItem[],
  source: HierarchicalListItem,
  destination: RawDropDestination,
): HierarchicalListDropDestination => {
  const sourcePosition = findItemPosition(items, source.id);
  if (
    sourcePosition
    && sourcePosition.parent?.id === destination.parent?.id
    && sourcePosition.index < destination.index
  ) {
    return { ...destination, index: destination.index - 1 };
  }
  return destination;
};

type RowDropTarget = {
  id: string;
  destination: RawDropDestination;
  indicatorDepth: number;
  edge: "top" | "bottom";
  showIndicator: boolean;
};

/** Resolves pointer geometry into before, inside, or after movement semantics. @internal */
export const getRowDropTarget = ({
  source,
  item,
  parent,
  index,
  depth,
  open,
  clientY,
  rowTop,
  rowHeight,
}: {
  source: HierarchicalListItem | null;
  item: HierarchicalListItem;
  parent: HierarchicalListItem | null;
  index: number;
  depth: number;
  open: boolean;
  clientY: number;
  rowTop: number;
  rowHeight: number;
}): RowDropTarget | null => {
  if (!source) return null;
  const verticalRatio = rowHeight > 0 ? (clientY - rowTop) / rowHeight : 0.5;
  const insideFolder = open
    ? verticalRatio >= 1 / 3
    : verticalRatio >= 1 / 3 && verticalRatio <= 2 / 3;
  if (item.droppable && canDrop(source, item) && insideFolder) {
    return {
      id: insideTargetId(item),
      destination: { parent: item, index: open ? 0 : item.children?.length ?? 0 },
      indicatorDepth: depth + 1,
      edge: "bottom",
      showIndicator: false,
    };
  }
  if (!canInsertInto(source, parent)) return null;

  const after = verticalRatio >= 0.5;
  const destinationIndex = index + (after ? 1 : 0);
  return {
    id: insertionTargetId(parent, destinationIndex),
    destination: { parent, index: destinationIndex },
    indicatorDepth: depth,
    edge: after ? "bottom" : "top",
    showIndicator: true,
  };
};

/** Bridges touch pointer movement to the primitive's shared drag event path. @internal */
export const dispatchTouchDragEvent = (
  type: "dragover" | "drop",
  clientX: number,
  clientY: number,
) => {
  const target = document.elementFromPoint(clientX, clientY);
  if (!target) return;
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      effectAllowed: "move",
      dropEffect: "move",
      setData() {},
      setDragImage() {},
    },
  });
  target.dispatchEvent(event);
};

const scrollableAncestorAtPoint = (position: DragPosition) => {
  let element = document.elementFromPoint(position.x, position.y) as HTMLElement | null;
  while (element) {
    const overflowY = getComputedStyle(element).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll")
      && element.scrollHeight > element.clientHeight
    ) return element;
    element = element.parentElement;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
};

const edgeScrollDelta = (clientY: number, top: number, bottom: number) => {
  const edge = Math.min(EDGE_SIZE_PX, (bottom - top) / 4);
  if (edge <= 0) return 0;
  if (clientY < top + edge) {
    const progress = (top + edge - clientY) / edge;
    return -Math.ceil(MAX_PX_PER_FRAME * Math.min(1, progress) ** 2);
  }
  if (clientY > bottom - edge) {
    const progress = (clientY - (bottom - edge)) / edge;
    return Math.ceil(MAX_PX_PER_FRAME * Math.min(1, progress) ** 2);
  }
  return 0;
};

/** Continuously scrolls the nearest vertical scroll container while a drag is near its edge. */
const useDragAutoScroll = ({
  enabled = true,
  position,
  onScroll,
}: DragAutoScrollOptions) => {
  const positionRef = useRef(position);
  const onScrollRef = useRef(onScroll);
  const active = position !== null;
  positionRef.current = position;
  onScrollRef.current = onScroll;

  useEffect(() => {
    if (!enabled || !position) return;
    let frameId = 0;

    const autoScroll = () => {
      const currentPosition = positionRef.current;
      if (!currentPosition) return;
      const scrollable = scrollableAncestorAtPoint(currentPosition);
      if (scrollable) {
        const rect = scrollable === document.scrollingElement
          ? { top: 0, bottom: window.innerHeight }
          : scrollable.getBoundingClientRect();
        const delta = edgeScrollDelta(currentPosition.y, rect.top, rect.bottom);
        if (delta !== 0) {
          const previousScrollTop = scrollable.scrollTop;
          scrollable.scrollTop += delta;
          if (scrollable.scrollTop !== previousScrollTop) onScrollRef.current?.(currentPosition);
        }
      }
      frameId = requestAnimationFrame(autoScroll);
    };

    frameId = requestAnimationFrame(autoScroll);
    return () => cancelAnimationFrame(frameId);
  }, [active, enabled]);
};

/** Owns the active drag session and indicator geometry for a primitive list. @internal */
export const useHierarchicalListDragAndDrop = (
  options: HierarchicalListDragAndDropOptions | undefined,
  listRef: RefObject<HTMLDivElement | null>,
): HierarchicalListDragAndDropController => {
  const [draggedItem, setDraggedItemState] = useState<HierarchicalListItem | null>(null);
  const [dragPosition, setDragPosition] = useState<DragPosition | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicatorPosition | null>(null);
  const [touchDragPosition, setTouchDragPosition] = useState<DragPosition | null>(null);

  const setDraggedItem = (item: HierarchicalListItem | null) => {
    setDraggedItemState(item);
    if (!item) {
      setDropIndicator(null);
      setDragPosition(null);
      setTouchDragPosition(null);
    }
  };

  const updateDropIndicator: HierarchicalListDragAndDropController["updateDropIndicator"] = (
    element,
    inset,
    edge,
    visible,
  ) => {
    if (!visible) {
      setDropIndicator((current) => current ? { ...current, visible: false } : null);
      return;
    }

    const list = listRef.current;
    if (!list) return;
    const listRect = list.getBoundingClientRect();
    const targetRect = element.getBoundingClientRect();
    const edgeY = edge === "top"
      ? targetRect.top
      : edge === "bottom"
        ? targetRect.bottom
        : targetRect.top + targetRect.height / 2;
    const left = targetRect.left - listRect.left + inset;
    setDropIndicator({
      left,
      top: edgeY - listRect.top - 0.75,
      width: Math.max(0, targetRect.right - listRect.left - 8 - left),
      visible,
    });
  };

  useDragAutoScroll({
    enabled: options?.autoScroll ?? false,
    position: dragPosition,
    onScroll: (position) => dispatchTouchDragEvent("dragover", position.x, position.y),
  });

  useEffect(() => {
    if (!draggedItem) return;
    const updatePosition = (event: DragEvent) => {
      setDragPosition({ x: event.clientX, y: event.clientY });
    };
    document.addEventListener("dragover", updatePosition, true);
    return () => document.removeEventListener("dragover", updatePosition, true);
  }, [draggedItem]);

  const updateTouchDragPosition = (position: DragPosition | null) => {
    setTouchDragPosition(position);
    setDragPosition(position);
  };

  return {
    draggedItem,
    dropIndicator,
    dropTargetId,
    touchDragPosition,
    setDraggedItem,
    setDropTargetId,
    setTouchDragPosition: updateTouchDragPosition,
    updateDropIndicator,
  };
};
