import {
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type PointerEventHandler,
} from "react";
import {
  dispatchTouchDragEvent,
  insertionTargetId,
  type HierarchicalListDragAndDropController,
} from "./HierarchicalListDragAndDrop";
import type { HierarchicalListItem } from "./HierarchicalList.types";

const LONG_PRESS_DELAY_MS = 500;
const DRAG_MOVE_TOLERANCE_PX = 8;

/** Optional threshold for touch dragging. */
export type HierarchicalListTouchInteractionOptions = {
  /** Pointer travel that starts touch dragging and cancels long press. Defaults to 8px. */
  touchDragThresholdPx?: number;
};

/** Styled action presentation settings. */
export type HierarchicalListActionPresentationOptions = {
  /** Maximum width at which item actions use a drawer. Defaults to 639px. */
  actionDrawerMaxWidthPx?: number;
};

/** Props that activate touch reordering when applied to a dedicated drag handle. */
export type HierarchicalListTouchDragHandleProps = HTMLAttributes<HTMLElement> & {
  "data-hierarchical-list-touch-drag-handle": string;
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
  const longPressPointerIdRef = useRef<number | null>(null);
  const touchDragStartRef = useRef<{ x: number; y: number } | null>(null);
  const touchDragRootRef = useRef<HTMLElement | null>(null);
  const touchPointerIdRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const touchDraggingRef = useRef(false);
  const [pressed, setPressed] = useState(false);

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
    longPressStartRef.current = null;
    longPressPointerIdRef.current = null;
  };
  useEffect(() => cancelLongPress, []);
  useEffect(() => {
    if (enabled && longPressAction) return;
    cancelLongPress();
    setPressed(false);
  }, [enabled, longPressAction]);

  const rowPointerProps: {
    onPointerDown?: PointerEventHandler<HTMLElement>;
    onPointerMove?: PointerEventHandler<HTMLElement>;
    onPointerUp?: PointerEventHandler<HTMLElement>;
    onPointerCancel?: PointerEventHandler<HTMLElement>;
  } = enabled ? {
      onPointerDown: (event) => {
        if (event.pointerType !== "touch" || !event.isPrimary || !longPressAction) return;
        cancelLongPress();
        setPressed(true);
        longPressStartRef.current = { x: event.clientX, y: event.clientY };
        longPressPointerIdRef.current = event.pointerId;
        longPressTimerRef.current = setTimeout(() => {
          suppressClickRef.current = true;
          longPressStartRef.current = null;
          onItemLongPress?.(item);
          longPressTimerRef.current = null;
        }, LONG_PRESS_DELAY_MS);
      },
      onPointerMove: (event) => {
        if (event.pointerType !== "touch" || event.pointerId !== longPressPointerIdRef.current) return;
        const start = longPressStartRef.current;
        if (!start || (
          Math.abs(event.clientX - start.x)
            <= Math.max(0, interaction?.touchDragThresholdPx ?? DRAG_MOVE_TOLERANCE_PX)
          && Math.abs(event.clientY - start.y)
            <= Math.max(0, interaction?.touchDragThresholdPx ?? DRAG_MOVE_TOLERANCE_PX)
        )) return;
        setPressed(false);
        cancelLongPress();
      },
      onPointerUp: (event) => {
        if (event.pointerId !== longPressPointerIdRef.current) return;
        setPressed(false);
        cancelLongPress();
      },
      onPointerCancel: (event) => {
        if (event.pointerId !== longPressPointerIdRef.current) return;
        suppressClickRef.current = false;
        setPressed(false);
        cancelLongPress();
      },
    } : {};

  const clearTouchDrag = () => {
    touchDragStartRef.current = null;
    touchDragRootRef.current = null;
    touchPointerIdRef.current = null;
    if (!touchDraggingRef.current) return;
    touchDraggingRef.current = false;
    dragController.setTouchDragPosition(null);
    dragController.setDraggedItem(null);
    dragController.setDropTargetId(null);
  };
  const consumeSuppressedClick = () => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  };
  const touchDragHandleProps: HierarchicalListTouchDragHandleProps = {
    "data-hierarchical-list-touch-drag-handle": "",
    style: { touchAction: "none" },
    onTouchStart: (event) => event.stopPropagation(),
    onPointerDown: (event) => {
      if (event.pointerType !== "touch" || !event.isPrimary || !draggable) return;
      event.stopPropagation();
      touchDragStartRef.current = { x: event.clientX, y: event.clientY };
      touchDragRootRef.current = event.currentTarget.closest("[data-hierarchical-list-root]");
      touchPointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove: (event) => {
      if (event.pointerType !== "touch" || event.pointerId !== touchPointerIdRef.current) return;
      if (touchDraggingRef.current) {
        event.preventDefault();
        dragController.setTouchDragPosition({ x: event.clientX, y: event.clientY });
        dispatchTouchDragEvent(
          "dragover",
          event.clientX,
          event.clientY,
          touchDragRootRef.current,
        );
        return;
      }
      const start = touchDragStartRef.current;
      if (!start || (
        Math.abs(event.clientX - start.x)
          <= Math.max(0, interaction?.touchDragThresholdPx ?? DRAG_MOVE_TOLERANCE_PX)
        && Math.abs(event.clientY - start.y)
          <= Math.max(0, interaction?.touchDragThresholdPx ?? DRAG_MOVE_TOLERANCE_PX)
      )) return;
      event.preventDefault();
      touchDraggingRef.current = true;
      onSelectionClear?.();
      dragController.setDropTargetId(insertionTargetId(parent, index));
      dragController.updateDropIndicator(
        event.currentTarget.closest<HTMLElement>("[data-hierarchical-list-item]")
          ?.querySelector<HTMLElement>("[data-hierarchical-list-row]") ?? event.currentTarget,
        getDropIndicatorInset(depth),
        "top",
        true,
      );
      dragController.setTouchDragPosition({ x: event.clientX, y: event.clientY });
      dragController.setDraggedItem(item);
    },
    onPointerUp: (event) => {
      if (event.pointerId !== touchPointerIdRef.current) return;
      if (touchDraggingRef.current) {
        event.preventDefault();
        suppressClickRef.current = true;
        dispatchTouchDragEvent("drop", event.clientX, event.clientY, touchDragRootRef.current);
      }
      clearTouchDrag();
    },
    onPointerCancel: (event) => {
      if (event.pointerId !== touchPointerIdRef.current) return;
      suppressClickRef.current = false;
      clearTouchDrag();
    },
    onClick: (event) => {
      if (!consumeSuppressedClick()) return;
      event.preventDefault();
      event.stopPropagation();
    },
  };

  return { pressed, rowPointerProps, touchDragHandleProps, consumeSuppressedClick };
};
