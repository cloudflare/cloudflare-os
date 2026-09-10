import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  canInsertInto,
  insertionTargetId,
  normalizeDropDestination,
  useHierarchicalListDragAndDrop,
  type DropIndicatorPosition,
  type HierarchicalListDragAndDropController,
  type HierarchicalListDragAndDropOptions,
} from "./HierarchicalListDragAndDrop";
import {
  useHierarchicalListCoarsePointer,
  type HierarchicalListTouchInteractionOptions,
} from "./useHierarchicalListTouchInteractions";
import {
  useHierarchicalListRowInteractions,
  type HierarchicalListPrimitiveRowProps,
} from "./useHierarchicalListRowInteractions";

export type { DropIndicatorPosition } from "./HierarchicalListDragAndDrop";
export type { HierarchicalListTouchInteractionOptions } from "./useHierarchicalListTouchInteractions";
import type {
  HierarchicalListExpansionProps,
  HierarchicalListItem,
} from "./HierarchicalList.types";

/** Stable behavioral state passed to a primitive row renderer. */
export type HierarchicalListPrimitiveRowState = {
  item: HierarchicalListItem;
  parent: HierarchicalListItem | null;
  index: number;
  depth: number;
  collapsible: boolean;
  expanded: boolean;
  selected: boolean;
  draggable: boolean;
  dragging: boolean;
  insideDropTarget: boolean;
  pressed: boolean;
  coarsePointer: boolean;
  /** Toggles this branch without activating the item. No-op while `expandAll` is true. */
  toggleExpanded: () => void;
};

export type { HierarchicalListPrimitiveRowProps } from "./useHierarchicalListRowInteractions";

/** Visual props accepted by a structural primitive slot. */
type HierarchicalListPrimitiveSlotProps<T> = Pick<HTMLAttributes<T>, "className" | "style">;

/** Visual slots supplied by a consumer of the headless primitive. */
export type HierarchicalListPrimitiveSlots = {
  root?: HierarchicalListPrimitiveSlotProps<HTMLDivElement>;
  list?: HierarchicalListPrimitiveSlotProps<HTMLUListElement>;
  item?: HierarchicalListPrimitiveSlotProps<HTMLLIElement>;
  group?: HierarchicalListPrimitiveSlotProps<HTMLUListElement>;
  dropZone?: HierarchicalListPrimitiveSlotProps<HTMLDivElement>;
};

/** Props for the behavior-only hierarchical list primitive. */
export type HierarchicalListPrimitiveProps = HierarchicalListExpansionProps & {
  items: readonly HierarchicalListItem[];
  label: string;
  selectedId?: string;
  /** Forces every branch open and disables individual expansion toggles. */
  expandAll?: boolean;
  dragAndDrop?: HierarchicalListDragAndDropOptions;
  interaction?: HierarchicalListTouchInteractionOptions;
  onItemClick?: (item: HierarchicalListItem) => void;
  onSelectionClear?: () => void;
  hasLongPressAction?: (item: HierarchicalListItem) => boolean;
  onItemLongPress?: (item: HierarchicalListItem) => void;
  renderRow: (
    props: HierarchicalListPrimitiveRowProps,
    state: HierarchicalListPrimitiveRowState,
  ) => ReactNode;
  renderDropIndicator?: (indicator: DropIndicatorPosition) => ReactNode;
  renderTouchDragPreview?: (
    item: HierarchicalListItem,
    position: { x: number; y: number },
  ) => ReactNode;
  createDragImage?: (
    item: HierarchicalListItem,
    row: HTMLElement,
    event: React.DragEvent<HTMLElement>,
  ) => void;
  /** Computes the visual inset of an insertion indicator. Defaults to no inset. */
  getDropIndicatorInset?: (depth: number) => number;
  slots?: HierarchicalListPrimitiveSlots;
};

type BranchProps = Omit<HierarchicalListPrimitiveProps, keyof HierarchicalListExpansionProps | "items" | "label"> & {
  item: HierarchicalListItem;
  parent: HierarchicalListItem | null;
  index: number;
  isLast: boolean;
  depth: number;
  expandedIds: ReadonlySet<string>;
  dragController: HierarchicalListDragAndDropController;
  coarsePointer: boolean;
  rootItems: readonly HierarchicalListItem[];
  onToggle: (id: string) => void;
};

const PrimitiveDropZone = ({
  parent,
  index,
  depth,
  edge,
  controller,
  onMove,
  inset,
  slot,
}: {
  parent: HierarchicalListItem | null;
  index: number;
  depth: number;
  edge: "before" | "after";
  controller: HierarchicalListDragAndDropController;
  onMove?: HierarchicalListDragAndDropOptions["onMove"];
  inset: (depth: number) => number;
  slot?: HierarchicalListPrimitiveSlotProps<HTMLDivElement>;
}) => {
  const { draggedItem, dropTargetId, setDraggedItem, setDropTargetId, updateDropIndicator } = controller;
  if (!draggedItem || !onMove || !canInsertInto(draggedItem, parent)) return null;
  const targetId = insertionTargetId(parent, index);

  return (
    <div
      {...slot}
      aria-hidden="true"
      data-hierarchical-list-drop-zone=""
      data-edge={edge}
      data-active={dropTargetId === targetId ? "" : undefined}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setDropTargetId(targetId);
        updateDropIndicator(event.currentTarget, inset(depth), "center", true);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onMove(draggedItem, { parent, index });
        setDraggedItem(null);
        setDropTargetId(null);
      }}
    />
  );
};

const PrimitiveBranch = ({
  item,
  parent,
  index,
  isLast,
  depth,
  expandedIds,
  expandAll = false,
  selectedId,
  dragAndDrop,
  interaction,
  onItemClick,
  onSelectionClear,
  hasLongPressAction,
  onItemLongPress,
  renderRow,
  createDragImage,
  getDropIndicatorInset = () => 0,
  slots,
  dragController,
  coarsePointer,
  rootItems,
  onToggle,
}: BranchProps) => {
  const collapsible = item.children !== undefined;
  const expanded = collapsible && (expandAll || expandedIds.has(item.id));
  const selected = selectedId === item.id;
  const rowInteractions = useHierarchicalListRowInteractions({
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
  });
  const state: HierarchicalListPrimitiveRowState = {
    item,
    parent,
    index,
    depth,
    collapsible,
    expanded,
    selected,
    draggable: rowInteractions.draggable,
    dragging: rowInteractions.dragging,
    insideDropTarget: rowInteractions.insideDropTarget,
    pressed: rowInteractions.pressed,
    coarsePointer,
    toggleExpanded: () => {
      if (collapsible && !expandAll) onToggle(item.id);
    },
  };

  return (
    <li
      {...slots?.item}
      data-hierarchical-list-item=""
      data-item-id={item.id}
      data-depth={depth}
      data-expanded={collapsible ? (expanded ? "" : undefined) : undefined}
      data-collapsed={collapsible && !expanded ? "" : undefined}
      data-selected={state.selected ? "" : undefined}
      data-dragging={state.dragging ? "" : undefined}
    >
      <PrimitiveDropZone
        parent={parent}
        index={index}
        depth={depth}
        edge="before"
        controller={dragController}
        onMove={dragAndDrop?.onMove}
        inset={getDropIndicatorInset}
        slot={slots?.dropZone}
      />
      {renderRow(rowInteractions.rowProps, state)}
      {collapsible && expanded && (
        <ul {...slots?.group} data-hierarchical-list-group="">
          {item.children?.map((child, childIndex) => (
            <PrimitiveBranch
              key={child.id}
              {...{
                item: child,
                parent: item,
                index: childIndex,
                isLast: childIndex === item.children!.length - 1,
                depth: depth + 1,
                expandedIds,
                expandAll,
                selectedId,
                dragAndDrop,
                interaction,
                onItemClick,
                onSelectionClear,
                hasLongPressAction,
                onItemLongPress,
                renderRow,
                createDragImage,
                getDropIndicatorInset,
                slots,
                dragController,
                coarsePointer,
                rootItems,
                onToggle,
              }}
            />
          ))}
        </ul>
      )}
      {isLast && (
        <PrimitiveDropZone
          parent={parent}
          index={index + 1}
          depth={depth}
          edge="after"
          controller={dragController}
          onMove={dragAndDrop?.onMove}
          inset={getDropIndicatorInset}
          slot={slots?.dropZone}
        />
      )}
    </li>
  );
};

/** A headless hierarchical list that owns expansion, selection, and drag-and-drop behavior. */
export const HierarchicalListPrimitive = ({
  items,
  label,
  selectedId,
  expandAll = false,
  dragAndDrop,
  onSelectionClear,
  renderDropIndicator,
  renderTouchDragPreview,
  slots,
  ...props
}: HierarchicalListPrimitiveProps) => {
  const [internalExpandedIds, setInternalExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(props.initialExpandedIds),
  );
  const [moveAnnouncement, setMoveAnnouncement] = useState<{ id: number; text: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingFocusIdRef = useRef<string | null>(null);
  const announcementIdRef = useRef(0);
  const normalizedDragAndDrop = dragAndDrop && {
    ...dragAndDrop,
    onMove: (
      item: HierarchicalListItem,
      destination: Parameters<typeof normalizeDropDestination>[2],
    ) => {
      const focusedItemId = document.activeElement
        ?.closest("[data-hierarchical-list-item]")
        ?.getAttribute("data-item-id");
      if (focusedItemId === item.id) pendingFocusIdRef.current = item.id;
      const normalizedDestination = normalizeDropDestination(items, item, destination);
      setMoveAnnouncement({
        id: ++announcementIdRef.current,
        text: `${item.name} moved to position ${normalizedDestination.index + 1} in ${
          normalizedDestination.parent?.name ?? label
        }.`,
      });
      dragAndDrop.onMove(item, normalizedDestination);
    },
  };
  const dragController = useHierarchicalListDragAndDrop(normalizedDragAndDrop, listRef);
  const expandedIds = props.expandedIds ?? internalExpandedIds;
  const coarsePointer = useHierarchicalListCoarsePointer();

  useLayoutEffect(() => {
    const pendingFocusId = pendingFocusIdRef.current;
    if (!pendingFocusId) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-hierarchical-list-row]");
    const row = rows && [...rows].find((candidate) => candidate
      .closest("[data-hierarchical-list-item]")
      ?.getAttribute("data-item-id") === pendingFocusId);
    if (!row) return;
    row.focus();
    pendingFocusIdRef.current = null;
  });

  useEffect(() => {
    if (!selectedId || !onSelectionClear) return;
    const clearOutsideRow = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element
        && listRef.current?.contains(target)
        && target.closest("[data-hierarchical-list-row]")) return;
      onSelectionClear();
    };
    document.addEventListener("pointerdown", clearOutsideRow, true);
    return () => document.removeEventListener("pointerdown", clearOutsideRow, true);
  }, [onSelectionClear, selectedId]);

  const toggle = (id: string) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (props.onExpandedChange) props.onExpandedChange(next);
    else setInternalExpandedIds(next);
  };

  return (
    <div {...slots?.root} ref={listRef} data-hierarchical-list-root="">
      <ul {...slots?.list} aria-label={label} data-hierarchical-list="">
        {items.map((item, index) => (
          <PrimitiveBranch
            key={item.id}
            {...props}
            item={item}
            parent={null}
            index={index}
            isLast={index === items.length - 1}
            depth={0}
            expandedIds={expandedIds}
            expandAll={expandAll}
            selectedId={selectedId}
            dragAndDrop={normalizedDragAndDrop}
            onSelectionClear={onSelectionClear}
            slots={slots}
            dragController={dragController}
            coarsePointer={coarsePointer}
            rootItems={items}
            onToggle={toggle}
          />
        ))}
      </ul>
      {moveAnnouncement && (
        <span
          key={moveAnnouncement.id}
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: "hidden",
            clip: "rect(0, 0, 0, 0)",
            whiteSpace: "nowrap",
            border: 0,
          }}
        >
          {moveAnnouncement.text}
        </span>
      )}
      {dragController.draggedItem && dragController.dropIndicator
        && renderDropIndicator?.(dragController.dropIndicator)}
      {dragController.draggedItem && dragController.touchDragPosition
        && renderTouchDragPreview?.(
          dragController.draggedItem,
          dragController.touchDragPosition,
        )}
    </div>
  );
};
