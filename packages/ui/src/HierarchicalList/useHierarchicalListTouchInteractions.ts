import { useEffect, useRef, useState, type PointerEventHandler } from "react";
import {
  dispatchTouchDragEvent,
  insertionTargetId,
  type HierarchicalListDragAndDropController,
} from "./HierarchicalListDragAndDrop";
import type { HierarchicalListItem } from "./HierarchicalList.types";

const LONG_PRESS_DELAY_MS = 500;
const DRAG_MOVE_TOLERANCE_PX = 8;

/** Optional thresholds for touch gestures. */
export type HierarchicalListTouchInteractionOptions = {
  /** Delay before a touch press opens item actions. Defaults to 500ms. */
  longPressDelayMs?: number;
  /** Pointer travel that starts touch dragging and cancels long press. Defaults to 8px. */
  touchDragThresholdPx?: number;
};

/** Styled action presentation settings. */
export type HierarchicalListActionPresentationOptions = {
  /** Maximum width at which item actions use a drawer. Defaults to 639px. */
  actionDrawerMaxWidthPx?: number;
};

const useMediaQuery = (queryText: string) => {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia(queryText);
    const update = () => setMatches(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [queryText]);

  return matches;
};

/** Whether item actions should use the narrow-layout drawer presentation. */
export const useHierarchicalListActionDrawer = (
  options?: HierarchicalListActionPresentationOptions,
) => useMediaQuery(
  `(max-width: ${Math.max(0, options?.actionDrawerMaxWidthPx ?? 639)}px)`,
);

/** Whether the primary pointer has coarse precision. */
export const useHierarchicalListCoarsePointer = () => useMediaQuery("(pointer: coarse)");

/** Coordinates long press and touch dragging for one row. */
export const useHierarchicalListTouchInteractions = ({
  enabled,
  item,
  parent,
  index,
  depth,
  draggable,
  longPressAction,
  dragController,
  getDropIndicatorInset,
  onItemLongPress,
  onSelectionClear,
  interaction,
}: {
  enabled: boolean;
  item: HierarchicalListItem;
  parent: HierarchicalListItem | null;
  index: number;
  depth: number;
  draggable: boolean;
  longPressAction: boolean;
  dragController: HierarchicalListDragAndDropController;
  getDropIndicatorInset: (depth: number) => number;
  onItemLongPress?: (item: HierarchicalListItem) => void;
  onSelectionClear?: () => void;
  interaction?: HierarchicalListTouchInteractionOptions;
}) => {
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const touchDraggingRef = useRef(false);
  const [pressed, setPressed] = useState(false);

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
    longPressStartRef.current = null;
  };
  useEffect(() => cancelLongPress, []);

  const pointerProps: {
    onPointerDown?: PointerEventHandler<HTMLElement>;
    onPointerMove?: PointerEventHandler<HTMLElement>;
    onPointerUp?: PointerEventHandler<HTMLElement>;
    onPointerCancel?: PointerEventHandler<HTMLElement>;
  } = enabled ? {
      onPointerDown: (event) => {
        if (event.pointerType !== "touch" || !event.isPrimary) return;
        cancelLongPress();
        if (longPressAction) setPressed(true);
        longPressStartRef.current = { x: event.clientX, y: event.clientY };
        if (longPressAction) {
          longPressTimerRef.current = setTimeout(() => {
            suppressClickRef.current = true;
            longPressStartRef.current = null;
            onItemLongPress?.(item);
            longPressTimerRef.current = null;
          }, Math.max(0, interaction?.longPressDelayMs ?? LONG_PRESS_DELAY_MS));
        }
      },
      onPointerMove: (event) => {
        if (event.pointerType !== "touch" || !event.isPrimary) return;
        if (touchDraggingRef.current) {
          event.preventDefault();
          dragController.setTouchDragPosition({ x: event.clientX, y: event.clientY });
          dispatchTouchDragEvent("dragover", event.clientX, event.clientY);
          return;
        }
        const start = longPressStartRef.current;
        if (!start || (
          Math.abs(event.clientX - start.x)
            <= Math.max(0, interaction?.touchDragThresholdPx ?? DRAG_MOVE_TOLERANCE_PX)
          && Math.abs(event.clientY - start.y)
            <= Math.max(0, interaction?.touchDragThresholdPx ?? DRAG_MOVE_TOLERANCE_PX)
        )) return;
        setPressed(false);
        cancelLongPress();
        if (!draggable) return;
        event.preventDefault();
        touchDraggingRef.current = true;
        onSelectionClear?.();
        dragController.setDropTargetId(insertionTargetId(parent, index));
        dragController.updateDropIndicator(
          event.currentTarget,
          getDropIndicatorInset(depth),
          "top",
          true,
        );
        dragController.setTouchDragPosition({ x: event.clientX, y: event.clientY });
        dragController.setDraggedItem(item);
      },
      onPointerUp: (event) => {
        if (touchDraggingRef.current) {
          event.preventDefault();
          dispatchTouchDragEvent("drop", event.clientX, event.clientY);
          touchDraggingRef.current = false;
          dragController.setTouchDragPosition(null);
          dragController.setDraggedItem(null);
          dragController.setDropTargetId(null);
        }
        setPressed(false);
        cancelLongPress();
      },
      onPointerCancel: () => {
        if (touchDraggingRef.current) {
          touchDraggingRef.current = false;
          dragController.setTouchDragPosition(null);
          dragController.setDraggedItem(null);
          dragController.setDropTargetId(null);
        }
        setPressed(false);
        cancelLongPress();
      },
    } : {};

  const consumeSuppressedClick = () => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  };

  return { pressed, pointerProps, consumeSuppressedClick };
};
