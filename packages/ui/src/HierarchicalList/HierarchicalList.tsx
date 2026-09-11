import { Button, DropdownMenu, LayerCard, Text } from "@cloudflare/kumo";
import { ContextMenu } from "@cloudflare/kumo/primitives/context-menu";
import { Drawer } from "@cloudflare/kumo/primitives/drawer";
import { Menu } from "@cloudflare/kumo/primitives/menu";
import { cn } from "@cloudflare/kumo/utils";
import { CaretDownIcon, FolderIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import React, { useRef, useState, type ReactNode } from "react";
import {
  HierarchicalListPrimitive,
  type HierarchicalListPrimitiveRowProps,
  type HierarchicalListPrimitiveRowState,
} from "./HierarchicalListPrimitive";
import type { HierarchicalListDragAndDropOptions } from "./HierarchicalListDragAndDrop";
import {
  useHierarchicalListActionDrawer,
  type HierarchicalListActionPresentationOptions,
  type HierarchicalListTouchInteractionOptions,
} from "./useHierarchicalListTouchInteractions";
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

/** Touch behavior and responsive action presentation settings for the styled list. */
export type HierarchicalListInteractionOptions = HierarchicalListTouchInteractionOptions
  & HierarchicalListActionPresentationOptions;

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
  /** Customizes touch gesture thresholds and the action-drawer breakpoint. */
  interaction?: HierarchicalListInteractionOptions;
  onItemClick?: (item: HierarchicalListItem) => void;
  onSelectionClear?: () => void;
  renderContextMenu?: (item: HierarchicalListItem) => ReactNode;
  /** Optional inline rename rendering and state. */
  rename?: HierarchicalListRenameOptions;
};

type StyledRowProps = {
  rowProps: HierarchicalListPrimitiveRowProps;
  state: HierarchicalListPrimitiveRowState;
  actionsOpen: boolean;
  useActionDrawer: boolean;
  onActionsOpenChange: (open: boolean) => void;
  renderContextMenu?: (item: HierarchicalListItem) => ReactNode;
  rename?: HierarchicalListRenameOptions;
};

const StyledRow = ({
  rowProps,
  state,
  actionsOpen,
  useActionDrawer,
  onActionsOpenChange,
  renderContextMenu,
  rename,
}: StyledRowProps) => {
  const drawerPopupRef = useRef<HTMLDivElement>(null);
  const {
    item,
    depth,
    collapsible,
    expanded,
    selected,
    pressed,
    coarsePointer,
  } = state;
  const highlighted = selected || actionsOpen || pressed;
  const contextMenu = renderContextMenu?.(item);
  const renaming = rename?.isRenaming(item) ?? false;
  const row = (
    <Button
      {...rowProps as React.ComponentProps<typeof Button>}
      type="button"
      variant="ghost"
      size="base"
      aria-current={selected ? "true" : undefined}
      aria-expanded={collapsible ? expanded : undefined}
      onClick={(event) => {
        if (renaming) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        rowProps.onClick?.(event);
        if (!event.defaultPrevented && collapsible) state.toggleExpanded();
      }}
      className={cn(
        rowProps.className,
        "group relative focus-visible:z-20",
        "!flex !h-auto w-full min-h-11 min-w-0 justify-start gap-2 pr-3 text-left",
        !renaming && "active:!bg-kumo-recessed",
        state.draggable && "cursor-grab active:cursor-grabbing",
        state.draggable && "touch-none",
        highlighted && "bg-kumo-recessed",
        coarsePointer && (
          highlighted
            ? "hover:!bg-kumo-recessed"
            : "hover:!bg-transparent data-[popup-open]:!bg-kumo-recessed"
        ),
      )}
      style={{ ...rowProps.style, paddingLeft: `${itemPadding(depth)}px` }}
    >
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
        <span
          className="min-w-0 flex-1"
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {rename!.renderInput(item)}
        </span>
      ) : (
        <Text as="span" size="sm" truncate DANGEROUS_className="min-w-0 flex-1">
          {item.name}
        </Text>
      )}
      {item.metadata && (
        <Text
          as="span"
          size="xs"
          variant="secondary"
          truncate
          DANGEROUS_className="min-w-0 max-w-1/2 shrink tabular-nums"
        >
          {item.metadata}
        </Text>
      )}
      <AnimatePresence>
        {state.insideDropTarget && (
          <motion.span
            data-folder-drop-outline=""
            className="pointer-events-none absolute inset-0 z-20 rounded-lg border-[1.5px] border-black"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
          />
        )}
      </AnimatePresence>
    </Button>
  );

  if (!contextMenu) return row;
  if (!useActionDrawer) {
    return (
      <ContextMenu.Root open={actionsOpen} onOpenChange={onActionsOpenChange}>
        <ContextMenu.Trigger render={row} />
        <DropdownMenu.Content>{contextMenu}</DropdownMenu.Content>
      </ContextMenu.Root>
    );
  }

  return (
    <>
      {row}
      <Drawer.Root open={actionsOpen} onOpenChange={onActionsOpenChange}>
        <Drawer.Portal>
          <Drawer.Backdrop
            onClick={() => onActionsOpenChange(false)}
            className={cn(
              "fixed inset-0 z-40 bg-kumo-recessed",
              "[opacity:calc(0.8*(1-var(--drawer-swipe-progress)))]",
              "transition-opacity duration-300 ease-out motion-reduce:transition-none",
              "data-ending-style:opacity-0 data-starting-style:opacity-0",
            )}
          />
          <Drawer.Viewport className="pointer-events-none fixed inset-0 z-50 flex items-end">
            <Drawer.Popup
              ref={drawerPopupRef}
              className={cn(
                "pointer-events-auto w-full rounded-t-2xl bg-kumo-control px-2 pt-2",
                "pb-[max(0.5rem,env(safe-area-inset-bottom))] text-kumo-default shadow-xl",
                "ring-1 ring-kumo-line",
                "[transform:translateY(var(--drawer-swipe-movement-y))]",
                "transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
                "motion-reduce:transition-none data-swiping:transition-none",
                "data-ending-style:translate-y-full data-starting-style:translate-y-full",
              )}
            >
              <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-kumo-line" />
              <Drawer.Title className="px-2 pb-2 text-xs text-kumo-subtle">
                {item.name}
              </Drawer.Title>
              <Menu.Root open={actionsOpen} modal={false} onOpenChange={onActionsOpenChange}>
                <Menu.Trigger className="sr-only" tabIndex={-1} aria-hidden="true" />
                <Menu.Portal container={drawerPopupRef}>
                  <Menu.Positioner className="!static !block !w-full !transform-none" sideOffset={0}>
                    <Menu.Popup className="flex w-full flex-col gap-1">
                      {contextMenu}
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.Root>
    </>
  );
};

/** A nested Kumo resource list with optional context-menu and drag-and-drop behaviors. */
export const HierarchicalList = ({
  renderContextMenu,
  rename,
  ...props
}: HierarchicalListProps) => {
  const [contextMenuId, setContextMenuId] = useState<string | null>(null);
  const useActionDrawer = useHierarchicalListActionDrawer(props.interaction);

  return (
    <LayerCard className="p-1">
      <HierarchicalListPrimitive
        {...props}
        hasLongPressAction={renderContextMenu && useActionDrawer
          ? (item) => Boolean(renderContextMenu(item)) && !rename?.isRenaming(item)
          : undefined}
        onItemLongPress={renderContextMenu && useActionDrawer
          ? (item) => setContextMenuId(item.id)
          : undefined}
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
            actionsOpen={contextMenuId === state.item.id}
            useActionDrawer={useActionDrawer}
            onActionsOpenChange={(open) => setContextMenuId(open ? state.item.id : null)}
            renderContextMenu={renderContextMenu}
            rename={rename}
          />
        )}
        renderDropIndicator={(indicator) => (
          <motion.div
            data-drop-indicator=""
            className="pointer-events-none absolute z-20 h-[1.5px] rounded-full bg-black"
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
