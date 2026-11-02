import { Button, DropdownMenu, LayerCard, Text } from "@cloudflare/kumo";
import { ContextMenu } from "@cloudflare/kumo/primitives/context-menu";
import { cn } from "@cloudflare/kumo/utils";
import { CaretDownIcon, DotsSixVerticalIcon, DotsThreeIcon, FolderIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  HierarchicalListPrimitive,
  type HierarchicalListPrimitiveRowProps,
  type HierarchicalListPrimitiveRowState,
} from "./HierarchicalListPrimitive";
import type { HierarchicalListDragAndDropOptions } from "./HierarchicalListDragAndDrop";
import type { HierarchicalListTouchInteractionOptions } from "./useHierarchicalListTouchInteractions";
import type {
  HierarchicalListExpansionProps,
  HierarchicalListItem,
} from "./HierarchicalList.types";

const DRAG_PREVIEW_CLASS_NAME = cn(
  "inline-flex h-9 max-w-64 items-center gap-2 overflow-hidden rounded-lg",
  "bg-kumo-control px-3 text-sm font-medium text-kumo-default shadow-lg",
  "ring-1 ring-kumo-line",
);
const itemPadding = (depth: number) => 12 + depth * 24;
const itemIcon = (item: HierarchicalListItem) => item.icon ?? (
  item.children !== undefined
    ? <FolderIcon aria-hidden="true" size={18} className="shrink-0 text-kumo-subtle" />
    : null
);

const withActionsButton = (row: ReactNode, actionsButton: ReactNode) => actionsButton
  ? (
    <div className="group/hierarchical-list-row relative">
      {row}
      {actionsButton}
    </div>
  )
  : row;

/** Render state for an item that is being renamed inline. */
export type HierarchicalListRenameOptions = {
  /** Whether the given item is currently in rename mode. */
  isRenaming: (item: HierarchicalListItem) => boolean;
  /** Renders the inline rename control for the given item. */
  renderInput: (item: HierarchicalListItem) => ReactNode;
};

/** Props for {@link HierarchicalList}. */
export type HierarchicalListProps = HierarchicalListExpansionProps & {
  items: readonly HierarchicalListItem[];
  label: string;
  selectedId?: string;
  /** Forces every branch open and disables individual expansion toggles. */
  expandAll?: boolean;
  /** Enables item movement and its mouse and touch drag interactions. */
  dragAndDrop?: HierarchicalListDragAndDropOptions;
  /** Customizes the touch-drag threshold. */
  interaction?: HierarchicalListTouchInteractionOptions;
  /** Whether draggable rows expose a dedicated touch drag handle. */
  showTouchDragHandle?: boolean;
  onItemClick?: (item: HierarchicalListItem) => void;
  onSelectionClear?: () => void;
  renderContextMenu?: (item: HierarchicalListItem) => ReactNode;
  /** Optional inline rename rendering and state. */
  rename?: HierarchicalListRenameOptions;
  /**
   * Gives every row with `renderContextMenu` content a visible "More actions" button at its end,
   * opening the same menu. It follows its row in the Tab order and, on devices that hover, shows
   * while its row is hovered, focused, or selected.
   */
  showRowActions?: boolean;
};

/** What opened a row's actions: the row itself (its context menu) or its button. */
type ActionsSource = "row" | "button";

type StyledRowProps = {
  rowProps: HierarchicalListPrimitiveRowProps;
  state: HierarchicalListPrimitiveRowState;
  actionsOpenFrom: ActionsSource | null;
  showTouchDragHandle: boolean;
  showRowActions: boolean;
  /** Opens the row's actions from `source`, or closes them given null. */
  onActionsChange: (source: ActionsSource | null) => void;
  renderContextMenu?: (item: HierarchicalListItem) => ReactNode;
  rename?: HierarchicalListRenameOptions;
};

type OpenActions = { itemId: string; source: ActionsSource };

const StyledRow = ({
  rowProps,
  state,
  actionsOpenFrom,
  showTouchDragHandle,
  showRowActions,
  onActionsChange,
  renderContextMenu,
  rename,
}: StyledRowProps) => {
  const rowRef = useRef<HTMLButtonElement>(null);
  const actionsButtonRef = useRef<HTMLButtonElement>(null);
  const wasRenamingRef = useRef(false);
  const [actionsClosing, setActionsClosing] = useState(false);
  const actionsClosedTimerRef = useRef<number | null>(null);
  const {
    item,
    depth,
    collapsible,
    expanded,
    selected,
    pressed,
    coarsePointer,
  } = state;
  const actionsOpen = actionsOpenFrom !== null;
  const highlighted = selected || actionsOpen || pressed;
  const passiveMessage = item.appearance === "message" && !item.interactive;
  const renameRequested = rename?.isRenaming(item) ?? false;
  const renaming = renameRequested && !actionsOpen && !actionsClosing;
  // The menu a press outside closes reports it before the menu that press opens reports opening,
  // so the newer source always wins.
  const handleActionsOpenChange = (source: ActionsSource) => (open: boolean) => {
    if (actionsClosedTimerRef.current !== null) {
      window.clearTimeout(actionsClosedTimerRef.current);
      actionsClosedTimerRef.current = null;
    }
    if (!open && actionsOpen) setActionsClosing(true);
    onActionsChange(open ? source : null);
  };
  const handleActionsOpenChangeComplete = (source: ActionsSource) => (open: boolean) => {
    if (!open) {
      if (document.activeElement === document.body) {
        (source === "button" ? actionsButtonRef : rowRef).current?.focus();
      }
      // Base UI restores final focus in a microtask after this callback. Preserve the trigger until
      // the next task so rename cannot replace it before that restoration completes.
      actionsClosedTimerRef.current = window.setTimeout(() => {
        actionsClosedTimerRef.current = null;
        setActionsClosing(false);
      });
    }
  };
  useEffect(() => () => {
    if (actionsClosedTimerRef.current !== null) {
      window.clearTimeout(actionsClosedTimerRef.current);
    }
  }, []);
  useLayoutEffect(() => {
    if (wasRenamingRef.current && !renaming) {
      const active = document.activeElement;
      // Only restore focus when the user completed the rename via Enter/Escape. If focus
      // has already moved elsewhere (blur/Tab), leave it where the user put it.
      if (!active || active === document.body || rowRef.current?.contains(active)) {
        rowRef.current?.focus();
      }
    }
    wasRenamingRef.current = renaming;
  }, [renaming]);
  const contextMenu = renaming ? null : renderContextMenu?.(item);
  const actionsButtonShown = showRowActions && Boolean(contextMenu);
  const contents = (
    <>
      {item.appearance === "message" ? (
        <Text
          as="span"
          size="sm"
          variant="secondary"
          DANGEROUS_className="min-w-0 flex-1 text-left font-normal"
        >
          {item.name}
        </Text>
      ) : (
        <>
          {itemIcon(item)}
          {collapsible && (
            <CaretDownIcon
              aria-hidden="true"
              size={14}
              className={cn(
                "shrink-0 text-kumo-inactive transition-transform duration-100 ease-out motion-reduce:transition-none",
                !expanded && "-rotate-90",
              )}
            />
          )}
          {renaming ? (
            <span className="min-w-0 flex-1">
              {rename!.renderInput(item)}
            </span>
          ) : item.description ? (
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <Text as="span" size="sm" truncate DANGEROUS_className="min-w-0 shrink">
                {item.name}
              </Text>
              <Text
                as="span"
                size="sm"
                variant="secondary"
                truncate
                DANGEROUS_className="min-w-0 flex-1 font-normal"
              >
                {item.description}
              </Text>
            </span>
          ) : (
            <Text as="span" size="sm" truncate DANGEROUS_className="min-w-0 flex-1">
              {item.name}
            </Text>
          )}
          {item.metadata !== null && item.metadata !== undefined && (
            <Text
              as="span"
              size="xs"
              variant="secondary"
              truncate
              DANGEROUS_className="max-w-1/2 shrink-0 whitespace-nowrap font-normal tabular-nums"
            >
              {item.metadata}
            </Text>
          )}
        </>
      )}
      <AnimatePresence>
        {state.insideDropTarget && (
          <motion.span
            data-folder-drop-outline=""
            className="pointer-events-none absolute inset-0 z-20 rounded-lg border-[1.5px] border-kumo-brand"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
          />
        )}
      </AnimatePresence>
      {!renaming && state.draggable && showTouchDragHandle && (
        <span
          {...state.touchDragHandleProps}
          aria-hidden="true"
          className={cn(
            "absolute right-0 top-0 z-20 hidden size-11 touch-none cursor-grab items-center justify-center",
            "text-kumo-subtle active:cursor-grabbing [@media(any-pointer:coarse)]:flex",
          )}
        >
          <DotsSixVerticalIcon aria-hidden="true" size={18} />
        </span>
      )}
    </>
  );
  const touchDragHandleShown = state.draggable && showTouchDragHandle;
  const rowClassName = cn(
    rowProps.className,
    "group relative focus-visible:z-20",
    "!flex !h-auto w-full min-h-11 min-w-0 items-center justify-start gap-2 text-left",
    actionsButtonShown ? "pr-10" : "pr-3",
    !renaming && !passiveMessage && "active:!bg-kumo-recessed",
    !renaming && state.draggable && "cursor-grab active:cursor-grabbing",
    !renaming && touchDragHandleShown && actionsButtonShown && "[@media(any-pointer:coarse)]:pr-22",
    !renaming && (touchDragHandleShown !== actionsButtonShown) && "[@media(any-pointer:coarse)]:pr-11",
    highlighted && "bg-kumo-recessed",
    coarsePointer && !renaming && (
      highlighted
        ? "hover:!bg-kumo-recessed"
        : "hover:!bg-transparent data-[popup-open]:!bg-kumo-recessed"
    ),
  );
  const row = renaming || passiveMessage ? (
    <div
      data-hierarchical-list-row=""
      data-depth={depth}
      tabIndex={-1}
      className={rowClassName}
      style={{ paddingLeft: `${itemPadding(depth)}px` }}
    >
      {contents}
    </div>
  ) : (
    <Button
      ref={rowRef}
      {...rowProps as React.ComponentProps<typeof Button>}
      type="button"
      variant="ghost"
      size="base"
      aria-current={selected ? "true" : undefined}
      aria-expanded={collapsible ? expanded : undefined}
      onClick={(event) => {
        rowProps.onClick?.(event);
        if (!event.defaultPrevented && collapsible) state.toggleExpanded();
      }}
      className={rowClassName}
      style={{ ...rowProps.style, paddingLeft: `${itemPadding(depth)}px` }}
    >
      {contents}
    </Button>
  );

  if (!contextMenu) return row;

  // A sibling of the row, which is a button and so cannot contain one. It sits over the row's end
  // inset, beside its touch drag handle, and lets drag events through to the row during a drag.
  const actionsButton = actionsButtonShown && (
    <Button
      ref={actionsButtonRef}
      type="button"
      variant="ghost"
      shape="square"
      size="sm"
      icon={<DotsThreeIcon aria-hidden="true" size={16} weight="bold" />}
      aria-label={`More actions for ${item.name}`}
      data-hierarchical-list-row-actions=""
      className={cn(
        "absolute right-1.5 top-1/2 z-20 -translate-y-1/2 text-kumo-subtle",
        "[@media(any-pointer:coarse)]:size-11",
        touchDragHandleShown
          ? "[@media(any-pointer:coarse)]:right-11"
          : "[@media(any-pointer:coarse)]:right-0",
        "in-data-[drag-active]:pointer-events-none",
        "transition-opacity duration-150 ease-out motion-reduce:transition-none",
        !highlighted && cn(
          "[@media(hover:hover)]:opacity-0",
          "group-hover/hierarchical-list-row:opacity-100",
          "group-focus-within/hierarchical-list-row:opacity-100",
        ),
      )}
    />
  );
  return withActionsButton(
    <ContextMenu.Root
      open={actionsOpenFrom === "row"}
      onOpenChange={handleActionsOpenChange("row")}
      onOpenChangeComplete={handleActionsOpenChangeComplete("row")}
    >
      <ContextMenu.Trigger render={row} />
      <DropdownMenu.Content>{contextMenu}</DropdownMenu.Content>
    </ContextMenu.Root>,
    actionsButton && (
      <DropdownMenu
        open={actionsOpenFrom === "button"}
        onOpenChange={handleActionsOpenChange("button")}
        onOpenChangeComplete={handleActionsOpenChangeComplete("button")}
      >
        <DropdownMenu.Trigger render={actionsButton} />
        <DropdownMenu.Content align="end">{contextMenu}</DropdownMenu.Content>
      </DropdownMenu>
    ),
  );
};

/** A nested Kumo resource list with optional context-menu and drag-and-drop behaviors. */
export const HierarchicalList = ({
  renderContextMenu,
  rename,
  showTouchDragHandle = true,
  showRowActions = false,
  ...props
}: HierarchicalListProps) => {
  const [openActions, setOpenActions] = useState<OpenActions | null>(null);

  return (
    <LayerCard className="bg-kumo-control p-1">
      <HierarchicalListPrimitive
        {...props}
        getDropIndicatorInset={itemPadding}
        slots={{
          root: { className: "relative" },
          item: { className: "relative" },
          dropZone: {
            className: cn(
              "absolute inset-x-0 z-10 h-3",
              "data-[edge=before]:-top-1.5 data-[edge=after]:-bottom-1.5",
            ),
          },
        }}
        createDragImage={(item, row, event) => {
          if (!event.dataTransfer.setDragImage) return;
          const rect = row.getBoundingClientRect();
          const dragImage = document.createElement("div");
          dragImage.className = DRAG_PREVIEW_CLASS_NAME;
          const icon = row.querySelector("svg")?.cloneNode(true);
          if (icon) dragImage.append(icon);
          const label = document.createElement("span");
          label.className = "min-w-0 truncate";
          label.textContent = item.name;
          dragImage.append(label);
          Object.assign(dragImage.style, {
            position: "fixed",
            top: "-1000px",
            left: "-1000px",
            maxWidth: `${Math.min(rect.width, 256)}px`,
          });
          document.body.append(dragImage);
          event.dataTransfer.setDragImage(dragImage, 18, 18);
          requestAnimationFrame(() => dragImage.remove());
        }}
        renderRow={(rowProps, state) => (
          <StyledRow
            rowProps={rowProps}
            state={state}
            actionsOpenFrom={openActions?.itemId === state.item.id ? openActions.source : null}
            showTouchDragHandle={showTouchDragHandle}
            showRowActions={showRowActions}
            onActionsChange={(source) => setOpenActions(source
              ? { itemId: state.item.id, source }
              : null)}
            renderContextMenu={renderContextMenu}
            rename={rename}
          />
        )}
        renderDropIndicator={(indicator) => (
          <motion.div
            data-drop-indicator=""
            className="pointer-events-none absolute z-20 h-[1.5px] rounded-full bg-kumo-brand"
            style={{ borderRadius: 9999, transformOrigin: "center" }}
            initial={{ ...indicator, opacity: 0 }}
            animate={{ ...indicator, opacity: indicator.visible ? 1 : 0 }}
            transition={{ duration: 0.14, ease: [0.25, 0.1, 0.25, 1] }}
          />
        )}
        renderTouchDragPreview={(item, position) => (
          <div
            data-touch-drag-preview=""
            className={cn("pointer-events-none fixed z-[100]", DRAG_PREVIEW_CLASS_NAME)}
            style={{ left: position.x + 12, top: position.y + 12 }}
          >
            {itemIcon(item)}
            <span className="min-w-0 truncate">{item.name}</span>
          </div>
        )}
      />
    </LayerCard>
  );
};

export type { HierarchicalListItem } from "./HierarchicalList.types";
