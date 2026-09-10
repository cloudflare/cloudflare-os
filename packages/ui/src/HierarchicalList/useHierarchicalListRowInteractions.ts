import type { DragEvent as ReactDragEvent, HTMLAttributes } from "react";
import {
  canDrop,
  getKeyboardMoveDestination,
  getRowDropTarget,
  insideTargetId,
  insertionTargetId,
  type HierarchicalListDragAndDropController,
  type HierarchicalListDragAndDropOptions,
} from "./HierarchicalListDragAndDrop";
import {
  useHierarchicalListTouchInteractions,
  type HierarchicalListTouchInteractionOptions,
} from "./useHierarchicalListTouchInteractions";
import type { HierarchicalListItem } from "./HierarchicalList.types";

/** Props that must be applied to the consumer-rendered row element, composing any overrides. */
export type HierarchicalListPrimitiveRowProps = HTMLAttributes<HTMLElement> & {
  draggable?: boolean;
  "data-hierarchical-list-row": string;
  "data-depth": number;
  "data-expanded"?: string;
  "data-collapsed"?: string;
  "data-selected"?: string;
  "data-pressed"?: string;
  "data-drop-target"?: "inside";
};

type RowInteractionOptions = {
  item: HierarchicalListItem;
  parent: HierarchicalListItem | null;
  index: number;
  depth: number;
  collapsible: boolean;
  expanded: boolean;
  selected: boolean;
  coarsePointer: boolean;
  rootItems: readonly HierarchicalListItem[];
  dragAndDrop?: HierarchicalListDragAndDropOptions;
  interaction?: HierarchicalListTouchInteractionOptions;
  dragController: HierarchicalListDragAndDropController;
  hasLongPressAction?: (item: HierarchicalListItem) => boolean;
  onItemLongPress?: (item: HierarchicalListItem) => void;
  onItemClick?: (item: HierarchicalListItem) => void;
  onSelectionClear?: () => void;
  createDragImage?: (
    item: HierarchicalListItem,
    row: HTMLElement,
    event: ReactDragEvent<HTMLElement>,
  ) => void;
  getDropIndicatorInset: (depth: number) => number;
};

/** Owns one primitive row's pointer, keyboard, and drag interactions. @internal */
export const useHierarchicalListRowInteractions = ({
  item,
  parent,
  index,
  depth,
  collapsible,
  expanded,
  selected,
  coarsePointer,
  rootItems,
  dragAndDrop,
  interaction,
  dragController,
  hasLongPressAction,
  onItemLongPress,
  onItemClick,
  onSelectionClear,
  createDragImage,
  getDropIndicatorInset,
}: RowInteractionOptions) => {
  const draggable = Boolean(item.draggable && dragAndDrop?.onMove);
  const longPressAction = Boolean(hasLongPressAction?.(item) && onItemLongPress);
  const { draggedItem, dropTargetId } = dragController;
  const { pressed, pointerProps, consumeSuppressedClick } = useHierarchicalListTouchInteractions({
    enabled: longPressAction || draggable,
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
  });
  const dragging = draggedItem?.id === item.id;
  const insideDropTarget = dropTargetId === insideTargetId(item)
    && Boolean(
      item.droppable
      && draggedItem
      && canDrop(draggedItem, item)
      && (dragAndDrop?.canMoveTo?.(draggedItem, item) ?? true),
    );

  const rowDropTarget = (clientY: number, row: HTMLElement) => {
    const rect = row.getBoundingClientRect();
    const target = getRowDropTarget({
      source: draggedItem,
      item,
      parent,
      index,
      depth,
      open: expanded,
      clientY,
      rowTop: rect.top,
      rowHeight: rect.height,
    });
    return target && draggedItem
      && (dragAndDrop?.canMoveTo?.(draggedItem, target.destination.parent) ?? true)
      ? target
      : null;
  };

  const rowProps: HierarchicalListPrimitiveRowProps = {
    style: draggable ? { touchAction: "none" } : undefined,
    onPointerDown: (event) => {
      if (!event.defaultPrevented) pointerProps.onPointerDown?.(event);
    },
    onPointerMove: (event) => {
      if (!event.defaultPrevented) pointerProps.onPointerMove?.(event);
    },
    onPointerUp: (event) => {
      if (!event.defaultPrevented) pointerProps.onPointerUp?.(event);
    },
    onPointerCancel: (event) => {
      if (!event.defaultPrevented) pointerProps.onPointerCancel?.(event);
    },
    "data-hierarchical-list-row": "",
    "data-depth": depth,
    "data-expanded": collapsible ? (expanded ? "" : undefined) : undefined,
    "data-collapsed": collapsible && !expanded ? "" : undefined,
    "data-selected": selected ? "" : undefined,
    "data-pressed": pressed ? "" : undefined,
    "data-drop-target": insideDropTarget ? "inside" : undefined,
    draggable: draggable && !coarsePointer || undefined,
    "aria-keyshortcuts": draggable
      ? "Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
      : undefined,
    "aria-description": draggable ? "Move with Alt plus an arrow key." : undefined,
    onClick: (event) => {
      if (event.defaultPrevented) return;
      if (consumeSuppressedClick()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      onItemClick?.(item);
    },
    onDragStart: (event) => {
      if (event.defaultPrevented || !draggable) return;
      onSelectionClear?.();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", item.id);
      createDragImage?.(item, event.currentTarget, event);
      dragController.setDropTargetId(insertionTargetId(parent, index));
      dragController.updateDropIndicator(
        event.currentTarget,
        getDropIndicatorInset(depth),
        "top",
        true,
      );
      dragController.setDraggedItem(item);
    },
    onKeyDown: (event) => {
      if (event.defaultPrevented) return;
      if (!event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        const root = event.currentTarget.closest("[data-hierarchical-list-root]");
        const rows = root
          ? [...root.querySelectorAll<HTMLElement>("[data-hierarchical-list-row]")]
          : [];
        const currentIndex = rows.indexOf(event.currentTarget);
        const nextIndex = currentIndex + (event.key === "ArrowDown" ? 1 : -1);
        const nextRow = rows[nextIndex];
        if (nextRow) {
          event.preventDefault();
          nextRow.focus();
        }
        return;
      }
      if (!draggable || !event.altKey) return;
      const direction = event.key === "ArrowUp"
        ? "up"
        : event.key === "ArrowDown"
          ? "down"
          : event.key === "ArrowLeft"
            ? "left"
            : event.key === "ArrowRight"
              ? "right"
              : null;
      if (!direction) return;
      const destination = getKeyboardMoveDestination(rootItems, item, direction);
      if (!destination || dragAndDrop?.canMoveTo?.(item, destination.parent) === false) return;
      event.preventDefault();
      dragAndDrop?.onMove(item, destination);
    },
    onDragEnd: () => {
      dragController.setDraggedItem(null);
      dragController.setDropTargetId(null);
    },
    onDragOver: (event) => {
      if (event.defaultPrevented) return;
      const target = rowDropTarget(event.clientY, event.currentTarget);
      if (!target) {
        if (draggedItem) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "none";
          dragController.setDropTargetId(null);
          dragController.updateDropIndicator(
            event.currentTarget,
            getDropIndicatorInset(depth),
            "top",
            false,
          );
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      dragController.setDropTargetId(target.id);
      dragController.updateDropIndicator(
        event.currentTarget,
        getDropIndicatorInset(target.indicatorDepth),
        target.edge,
        target.showIndicator,
      );
    },
    onDrop: (event) => {
      if (event.defaultPrevented || !draggedItem) return;
      const target = rowDropTarget(event.clientY, event.currentTarget);
      if (!target) {
        event.preventDefault();
        event.stopPropagation();
        dragController.setDropTargetId(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dragAndDrop?.onMove(draggedItem, target.destination);
      dragController.setDraggedItem(null);
      dragController.setDropTargetId(null);
    },
  };

  return { draggable, dragging, insideDropTarget, pressed, rowProps };
};
