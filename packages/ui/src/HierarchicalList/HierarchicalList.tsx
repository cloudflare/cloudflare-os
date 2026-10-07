import { Button, DropdownMenu, LayerCard, Text } from "@cloudflare/kumo";
import { ContextMenu } from "@cloudflare/kumo/primitives/context-menu";
import { Drawer } from "@cloudflare/kumo/primitives/drawer";
import { Menu } from "@cloudflare/kumo/primitives/menu";
import { cn } from "@cloudflare/kumo/utils";
import { CaretDownIcon, DotsSixVerticalIcon, DotsThreeIcon, FolderIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import React, { useEffect, useId, useRef, useState, type ReactNode } from "react";
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

const withActionsButton = (row: ReactNode, actionsButton: ReactNode) => actionsButton
  ? (
    <div className="group/hierarchical-list-row relative">
      {row}
      {actionsButton}
    </div>
  )
  : row;

/** Touch behavior and responsive action presentation settings for the styled list. */
export type HierarchicalListInteractionOptions = HierarchicalListTouchInteractionOptions
  & HierarchicalListActionPresentationOptions;

/** Props for {@link HierarchicalList}. */
export type HierarchicalListProps = HierarchicalListExpansionProps & {
  items: readonly HierarchicalListItem[];
  label: string;
  selectedId?: string;
  /** Forces every branch open and disables individual expansion toggles. */
  expandAll?: boolean;
  /** Enables item movement and its mouse and touch drag interactions. */
  dragAndDrop?: HierarchicalListDragAndDropOptions;
  /** Customizes the touch-drag threshold and action-drawer breakpoint. */
  interaction?: HierarchicalListInteractionOptions;
  onItemClick?: (item: HierarchicalListItem) => void;
  onSelectionClear?: () => void;
  renderContextMenu?: (item: HierarchicalListItem) => ReactNode;
  /**
   * Gives every row with `renderContextMenu` content a visible "More actions" button at its end,
   * opening the same menu. It follows its row in the Tab order and, on devices that hover, shows
   * while its row is hovered, focused, or selected.
   */
  showRowActions?: boolean;
};

/** What opened a row's actions: the row itself (context menu or long press) or its button. */
type ActionsSource = "row" | "button";

type StyledRowProps = {
  rowProps: HierarchicalListPrimitiveRowProps;
  state: HierarchicalListPrimitiveRowState;
  actionsOpenFrom: ActionsSource | null;
  useActionDrawer: boolean;
  showRowActions: boolean;
  /** Opens the row's actions from `source`, or closes them given null. */
  onActionsChange: (source: ActionsSource | null) => void;
  renderContextMenu?: (item: HierarchicalListItem) => ReactNode;
};

type OpenActions = { itemId: string; drawer: boolean; source: ActionsSource };

const StyledRow = ({
  rowProps,
  state,
  actionsOpenFrom,
  useActionDrawer,
  showRowActions,
  onActionsChange,
  renderContextMenu,
}: StyledRowProps) => {
  const drawerPopupRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const actionsButtonRef = useRef<HTMLButtonElement>(null);
  const restoreDrawerFocusRef = useRef(true);
  // Where the drawer returns the focus when it closes, the source being cleared by then.
  const drawerOpenerRef = useRef<ActionsSource>("row");
  const drawerTitleId = useId();
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
  const contextMenu = renderContextMenu?.(item);
  const actionsButtonShown = showRowActions && Boolean(contextMenu);
  // The menu a press outside closes reports it before the menu that press opens reports opening,
  // so the newer source always wins.
  const onMenuOpenChange = (source: ActionsSource) => (open: boolean) => onActionsChange(open ? source : null);
  useEffect(() => {
    if (!actionsOpenFrom || !useActionDrawer) return;
    restoreDrawerFocusRef.current = true;
    drawerOpenerRef.current = actionsOpenFrom;
    const trackFocusDestination = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof Node
        && !drawerPopupRef.current?.contains(target)
        && !rowRef.current?.contains(target)
        && !actionsButtonRef.current?.contains(target)
      ) restoreDrawerFocusRef.current = false;
    };
    document.addEventListener("focusin", trackFocusDestination, true);
    return () => document.removeEventListener("focusin", trackFocusDestination, true);
  }, [actionsOpenFrom, useActionDrawer]);
  const coarsePointerEndInset = state.draggable && actionsButtonShown
    ? "[@media(any-pointer:coarse)]:pr-22"
    : (state.draggable || actionsButtonShown) && "[@media(any-pointer:coarse)]:pr-11";
  const row = (
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
      onContextMenu={(event) => {
        rowProps.onContextMenu?.(event);
        if (event.defaultPrevented || !useActionDrawer || !contextMenu) return;
        event.preventDefault();
        onActionsChange("row");
      }}
      className={cn(
        rowProps.className,
        "group relative focus-visible:z-20",
        "!flex !h-auto w-full min-h-11 min-w-0 justify-start gap-2 text-left active:!bg-kumo-recessed",
        actionsButtonShown ? "pr-10" : "pr-3",
        state.draggable && "cursor-grab active:cursor-grabbing",
        coarsePointerEndInset,
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
      <Text as="span" size="sm" truncate DANGEROUS_className="min-w-0 flex-1">
        {item.name}
      </Text>
      {item.metadata !== null && item.metadata !== undefined && (
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
            className="pointer-events-none absolute inset-0 z-20 rounded-lg border-[1.5px] border-kumo-brand"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
          />
        )}
      </AnimatePresence>
      {state.draggable && (
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
      {...useActionDrawer && {
        "aria-haspopup": "dialog" as const,
        "aria-expanded": actionsOpen,
        onClick: () => onActionsChange("button"),
      }}
      className={cn(
        "absolute right-1.5 top-1/2 z-20 -translate-y-1/2 text-kumo-subtle",
        "[@media(any-pointer:coarse)]:size-11",
        state.draggable
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
  if (!useActionDrawer) {
    return withActionsButton(
      <ContextMenu.Root open={actionsOpenFrom === "row"} onOpenChange={onMenuOpenChange("row")}>
        <ContextMenu.Trigger render={row} />
        <DropdownMenu.Content>{contextMenu}</DropdownMenu.Content>
      </ContextMenu.Root>,
      actionsButton && (
        <DropdownMenu
          open={actionsOpenFrom === "button"}
          onOpenChange={onMenuOpenChange("button")}
        >
          <DropdownMenu.Trigger render={actionsButton} />
          <DropdownMenu.Content align="end">{contextMenu}</DropdownMenu.Content>
        </DropdownMenu>
      ),
    );
  }

  return (
    <>
      {withActionsButton(row, actionsButton)}
      <Drawer.Root
        open={actionsOpen}
        onOpenChange={(open) => onActionsChange(open ? actionsOpenFrom ?? "row" : null)}
        onOpenChangeComplete={(open) => {
          if (
            !open
            && restoreDrawerFocusRef.current
            && (document.activeElement === document.body
              || drawerPopupRef.current?.contains(document.activeElement))
          ) {
            (drawerOpenerRef.current === "button" ? actionsButtonRef : rowRef).current?.focus();
          }
        }}
      >
        <Drawer.Portal>
          <Drawer.Backdrop
            onClick={() => onActionsChange(null)}
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
                "pointer-events-auto flex max-h-[calc(100dvh-1rem)] w-full flex-col overflow-hidden",
                "rounded-t-2xl bg-kumo-control px-2 pt-2",
                "pb-[max(0.5rem,env(safe-area-inset-bottom))] text-kumo-default shadow-xl",
                "ring-1 ring-kumo-line",
                "[transform:translateY(var(--drawer-swipe-movement-y))]",
                "transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
                "motion-reduce:transition-none data-swiping:transition-none",
                "data-ending-style:translate-y-full data-starting-style:translate-y-full",
              )}
            >
              <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-kumo-line" />
              <Drawer.Title id={drawerTitleId} className="px-2 pb-2 text-xs text-kumo-subtle">
                {item.name}
              </Drawer.Title>
              <Menu.Root
                open={actionsOpen}
                modal={false}
                onOpenChange={(open) => onActionsChange(open ? actionsOpenFrom ?? "row" : null)}
              >
                <Menu.Portal container={drawerPopupRef}>
                  <Menu.Positioner
                    className="!static !block !min-h-0 !w-full !flex-1 !transform-none overflow-y-auto overscroll-contain"
                    sideOffset={0}
                  >
                    <Menu.Popup
                      aria-labelledby={drawerTitleId}
                      className="flex w-full flex-col gap-1"
                    >
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
  showRowActions = false,
  ...props
}: HierarchicalListProps) => {
  const [openActions, setOpenActions] = useState<OpenActions | null>(null);
  const useActionDrawer = useHierarchicalListActionDrawer(props.interaction);

  useEffect(() => {
    if (openActions && openActions.drawer !== useActionDrawer) setOpenActions(null);
  }, [openActions, useActionDrawer]);

  return (
    <LayerCard className="p-1">
      <HierarchicalListPrimitive
        {...props}
        hasLongPressAction={renderContextMenu && useActionDrawer
          ? (item) => Boolean(renderContextMenu(item))
          : undefined}
        onItemLongPress={renderContextMenu && useActionDrawer
          ? (item) => setOpenActions({ itemId: item.id, drawer: true, source: "row" })
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
            actionsOpenFrom={openActions?.itemId === state.item.id
              && openActions.drawer === useActionDrawer
              ? openActions.source
              : null}
            useActionDrawer={useActionDrawer}
            showRowActions={showRowActions}
            onActionsChange={(source) => setOpenActions(source
              ? { itemId: state.item.id, drawer: useActionDrawer, source }
              : null)}
            renderContextMenu={renderContextMenu}
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
