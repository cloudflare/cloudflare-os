// @vitest-environment jsdom

import { DropdownMenu } from "@cloudflare/kumo";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HierarchicalList,
  type HierarchicalListDropDestination,
  type HierarchicalListItem,
} from ".";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const items: HierarchicalListItem[] = [
  {
    id: "collection",
    name: "Engineering",
    metadata: "2 skills",
    droppable: true,
    children: [
      { id: "review", name: "Review code", draggable: true },
      { id: "deploy", name: "Deploy service", draggable: true },
    ],
  },
];

const press = (target: HTMLElement) => {
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    act(() => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })));
  }
};

const pressEscape = (target: Element) => act(() => target.dispatchEvent(new KeyboardEvent(
  "keydown",
  { key: "Escape", bubbles: true, cancelable: true },
)));

const actionItems: HierarchicalListItem[] = [
  {
    id: "folder",
    name: "Folder",
    draggable: true,
    droppable: true,
    children: [{ id: "child", name: "Child", draggable: true }],
  },
  { id: "plain", name: "Plain" },
  { id: "last", name: "Last", draggable: true },
];

const actionMenu = (item: HierarchicalListItem) => (item.id === "plain"
  ? null
  : <DropdownMenu.Item>{`Rename ${item.name}`}</DropdownMenu.Item>);

describe("HierarchicalList", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  const render = (element: React.ReactNode) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(element));
  };

  const buttonFor = (name: string) => Array.from(container!.querySelectorAll("button"))
    .find((button) => button.textContent?.includes(name));

  const rowFor = (name: string) => buttonFor(name);

  const actionsFor = (name: string) => container!.querySelector<HTMLButtonElement>(
    `button[aria-label="More actions for ${name}"]`,
  );

  const dataTransfer = () => ({
    effectAllowed: "none",
    dropEffect: "none",
    setData: vi.fn<(format: string, data: string) => void>(),
  });

  const dispatchDrag = (
    target: HTMLElement,
    type: string,
    transfer: ReturnType<typeof dataTransfer>,
    clientY = 0,
  ) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    act(() => target.dispatchEvent(event));
  };

  const setRect = (
    element: Element,
    { top, left = 0, width = 400, height = 40 }: {
      top: number;
      left?: number;
      width?: number;
      height?: number;
    },
  ) => {
    element.getBoundingClientRect = () => DOMRect.fromRect({ x: left, y: top, width, height });
  };

  const dispatchTouchPointer = (
    target: HTMLElement,
    type: string,
    clientX: number,
    clientY: number,
    pointerId = 1,
  ) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
    Object.defineProperties(event, {
      isPrimary: { value: true },
      pointerId: { value: pointerId },
      pointerType: { value: "touch" },
    });
    act(() => target.dispatchEvent(event));
  };

  it("expands branches and selects leaf items", () => {
    const onItemClick = vi.fn<(item: HierarchicalListItem) => void>();
    render(
      <HierarchicalList
        items={items}
        label="Skills"
        selectedId="collection"
        onItemClick={onItemClick}
      />,
    );

    expect(container?.querySelector("ul")?.getAttribute("aria-label")).toBe("Skills");
    expect(buttonFor("Review code")).toBeUndefined();
    expect(buttonFor("Engineering")?.getAttribute("aria-current")).toBe("true");
    expect(buttonFor("Engineering")?.getAttribute("aria-expanded")).toBe("false");

    act(() => buttonFor("Engineering")?.click());

    const skillButton = buttonFor("Review code");
    expect(skillButton).toBeDefined();
    expect(buttonFor("Engineering")?.getAttribute("aria-expanded")).toBe("true");
    expect(skillButton?.hasAttribute("aria-expanded")).toBe(false);
    expect(rowFor("Review code")?.draggable).toBe(false);
    act(() => skillButton?.focus());
    act(() => skillButton?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    })));
    expect(document.activeElement).toBe(buttonFor("Deploy service"));
    act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    })));
    expect(document.activeElement).toBe(skillButton);
    act(() => skillButton?.click());
    expect(onItemClick).toHaveBeenCalledWith(items[0].children?.[0]);
  });

  it("renders numeric zero metadata", () => {
    render(
      <HierarchicalList
        items={[{ id: "empty", name: "Empty collection", metadata: 0 }]}
        label="Collections"
      />,
    );

    expect(rowFor("Empty collection")?.textContent).toContain("Empty collection0");
  });

  it("scrolls from draggable rows and reorders from their touch handles", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn<() => void>(),
      removeEventListener: vi.fn<() => void>(),
    })));
    const onMove = vi.fn<(
      item: HierarchicalListItem,
      destination: HierarchicalListDropDestination,
    ) => void>();
    const onItemClick = vi.fn<(item: HierarchicalListItem) => void>();
    const touchItems: HierarchicalListItem[] = [
      { id: "source", name: "Source", draggable: true },
      { id: "target", name: "Target" },
    ];
    render(
      <HierarchicalList
        items={touchItems}
        label="Files"
        dragAndDrop={{ onMove }}
        interaction={{ touchDragThresholdPx: 16 }}
        onItemClick={onItemClick}
      />,
    );
    const source = rowFor("Source")!;
    const handle = source.querySelector<HTMLElement>(
      "[data-hierarchical-list-touch-drag-handle]",
    )!;
    const target = rowFor("Target")!;
    setRect(container!.firstElementChild!, { top: 0 });
    setRect(source, { top: 0 });
    setRect(target, { top: 40 });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn<(x: number, y: number) => Element | null>(() => target),
    });

    expect(source.draggable).toBe(true);
    expect(source.style.touchAction).not.toBe("none");
    expect(handle.style.touchAction).toBe("none");
    expect(handle.getAttribute("aria-hidden")).toBe("true");
    const rowMove = new MouseEvent("pointermove", {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 30,
    });
    Object.defineProperties(rowMove, {
      isPrimary: { value: true },
      pointerType: { value: "touch" },
    });
    dispatchTouchPointer(source, "pointerdown", 10, 10);
    act(() => source.dispatchEvent(rowMove));
    expect(rowMove.defaultPrevented).toBe(false);
    expect(container!.querySelector("[data-touch-drag-preview]")).toBeNull();
    dispatchTouchPointer(source, "pointercancel", 30, 30);

    dispatchTouchPointer(handle, "pointerdown", 10, 10);
    dispatchTouchPointer(handle, "pointermove", 20, 20);
    expect(container!.querySelector("[data-touch-drag-preview]")).toBeNull();
    dispatchTouchPointer(handle, "pointermove", 30, 30);
    expect(container!.querySelector("[data-touch-drag-preview]")?.textContent).toContain("Source");
    expect(container!.querySelector<HTMLElement>("[data-touch-drag-preview]")?.parentElement
      ?.style.pointerEvents).toBe("none");
    dispatchTouchPointer(handle, "pointercancel", 30, 30);
    expect(container!.querySelector("[data-touch-drag-preview]")).toBeNull();
    expect(onMove).not.toHaveBeenCalled();

    dispatchTouchPointer(handle, "pointerdown", 10, 10);
    dispatchTouchPointer(handle, "pointermove", 30, 30);
    dispatchTouchPointer(handle, "pointerup", 20, 60, 2);
    expect(container!.querySelector("[data-touch-drag-preview]")?.textContent).toContain("Source");
    dispatchTouchPointer(handle, "pointermove", 20, 60);
    dispatchTouchPointer(handle, "pointerup", 20, 60);

    expect(onMove).toHaveBeenCalledWith(touchItems[0], { parent: null, index: 1 });
    expect(container!.querySelector("[data-touch-drag-preview]")).toBeNull();
    act(() => handle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    act(() => source.click());
    expect(onItemClick).toHaveBeenCalledWith(touchItems[0]);
  });

  it("starts native mouse dragging from a visible touch handle on hybrid devices", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn<() => void>(),
      removeEventListener: vi.fn<() => void>(),
    })));
    render(
      <HierarchicalList
        items={[{ id: "source", name: "Source", draggable: true }]}
        label="Files"
        dragAndDrop={{ onMove: () => {} }}
      />,
    );
    const source = rowFor("Source")!;
    const handle = source.querySelector<HTMLElement>(
      "[data-hierarchical-list-touch-drag-handle]",
    )!;
    const transfer = dataTransfer();

    dispatchDrag(handle, "dragstart", transfer);

    expect(transfer.setData).toHaveBeenCalledWith("text/plain", "source");
  });

  it("does not dispatch touch drops outside the originating list", () => {
    const onMove = vi.fn<(
      item: HierarchicalListItem,
      destination: HierarchicalListDropDestination,
    ) => void>();
    render(
      <HierarchicalList
        items={[
          { id: "source", name: "Source", draggable: true },
          { id: "target", name: "Target" },
        ]}
        label="Files"
        dragAndDrop={{ onMove }}
        interaction={{ touchDragThresholdPx: 8 }}
      />,
    );
    const source = rowFor("Source")!;
    const handle = source.querySelector<HTMLElement>(
      "[data-hierarchical-list-touch-drag-handle]",
    )!;
    const target = rowFor("Target")!;
    setRect(source, { top: 0 });
    setRect(target, { top: 40 });
    const unrelatedTarget = document.createElement("div");
    const unrelatedDrop = vi.fn<() => void>();
    unrelatedTarget.addEventListener("drop", unrelatedDrop);
    document.body.append(unrelatedTarget);
    let hitTarget: Element = target;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn<(x: number, y: number) => Element | null>(() => hitTarget),
    });

    dispatchTouchPointer(handle, "pointerdown", 10, 10);
    dispatchTouchPointer(handle, "pointermove", 30, 30);
    hitTarget = unrelatedTarget;
    dispatchTouchPointer(handle, "pointerup", 30, 60);

    expect(unrelatedDrop).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
    unrelatedTarget.remove();
  });

  it("clears touch drag feedback when the source row is removed", () => {
    const renderList = (listItems: readonly HierarchicalListItem[]) => (
      <HierarchicalList
        items={listItems}
        label="Files"
        dragAndDrop={{ onMove: () => {} }}
        interaction={{ touchDragThresholdPx: 8 }}
      />
    );
    render(renderList([{ id: "source", name: "Source", draggable: true }]));
    const source = rowFor("Source")!;
    const handle = source.querySelector<HTMLElement>(
      "[data-hierarchical-list-touch-drag-handle]",
    )!;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn<(x: number, y: number) => Element | null>(() => source),
    });
    dispatchTouchPointer(handle, "pointerdown", 10, 10);
    dispatchTouchPointer(handle, "pointermove", 30, 30);
    expect(container!.querySelector("[data-touch-drag-preview]")).not.toBeNull();

    act(() => root!.render(renderList([])));

    expect(container!.querySelector("[data-touch-drag-preview]")).toBeNull();
  });

  it("opens an item's action menu from a right click", () => {
    render(
      <HierarchicalList
        items={[{ id: "skill", name: "Review code" }]}
        label="Skills"
        renderContextMenu={() => <DropdownMenu.Item>Delete</DropdownMenu.Item>}
      />,
    );

    const row = rowFor("Review code")!;
    act(() => row.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));

    expect(document.body.textContent).toContain("Delete");
    expect(container?.querySelectorAll("button")).toHaveLength(1);
  });

  it("opens an item's action drawer from a long press on touch devices", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn<() => void>(),
      removeEventListener: vi.fn<() => void>(),
    })));
    render(
      <HierarchicalList
        items={[{ id: "skill", name: "Review code" }]}
        label="Skills"
        interaction={{ actionDrawerMaxWidthPx: 800 }}
        renderContextMenu={() => <DropdownMenu.Item>Delete</DropdownMenu.Item>}
      />,
    );

    const pointerDown = new MouseEvent("pointerdown", { bubbles: true, clientX: 20, clientY: 30 });
    Object.defineProperties(pointerDown, {
      isPrimary: { value: true },
      pointerType: { value: "touch" },
    });
    act(() => rowFor("Review code")?.dispatchEvent(pointerDown));
    act(() => vi.advanceTimersByTime(499));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    act(() => vi.advanceTimersByTime(1));

    expect(document.body.textContent).toContain("Delete");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("does not cancel a long press when a different touch ends", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn<() => void>(),
      removeEventListener: vi.fn<() => void>(),
    })));
    render(
      <HierarchicalList
        items={[{ id: "skill", name: "Review code" }]}
        label="Skills"
        renderContextMenu={() => <DropdownMenu.Item>Delete</DropdownMenu.Item>}
      />,
    );
    const row = rowFor("Review code")!;

    dispatchTouchPointer(row, "pointerdown", 20, 30, 1);
    dispatchTouchPointer(row, "pointercancel", 25, 35, 2);
    act(() => vi.advanceTimersByTime(500));

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("opens an item's action drawer from a context-menu event on narrow layouts", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn<() => void>(),
      removeEventListener: vi.fn<() => void>(),
    })));
    render(
      <HierarchicalList
        items={[{ id: "skill", name: "Review code" }]}
        label="Skills"
        renderContextMenu={() => <DropdownMenu.Item>Delete</DropdownMenu.Item>}
      />,
    );
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    const row = rowFor("Review code")!;

    act(() => row.focus());
    act(() => row.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(document.body.textContent).toContain("Delete");
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.className).toContain("max-h-[calc(100dvh-1rem)]");
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.parentElement?.className).toContain("overflow-y-auto");
    const label = document.getElementById(menu.getAttribute("aria-labelledby")!);
    expect(label?.textContent).toBe("Review code");
    const menuItem = document.querySelector<HTMLElement>('[role="menuitem"]')!;
    act(() => menuItem.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    })));

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("does not restore drawer focus over an action's destination", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn<() => void>(),
      removeEventListener: vi.fn<() => void>(),
    })));
    const destination = document.createElement("button");
    destination.textContent = "Dialog control";
    document.body.append(destination);
    render(
      <HierarchicalList
        items={[{ id: "skill", name: "Review code" }]}
        label="Skills"
        renderContextMenu={() => (
          <DropdownMenu.Item onClick={() => destination.focus()}>Edit</DropdownMenu.Item>
        )}
      />,
    );
    const row = rowFor("Review code")!;
    act(() => row.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })));
    const menuItem = document.querySelector<HTMLElement>('[role="menuitem"]')!;

    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      act(() => menuItem.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
      })));
    }

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).not.toBe(row);
    destination.remove();
  });

  it("positions drop indicators in the scrolled list content", () => {
    render(
      <HierarchicalList
        items={[{ id: "source", name: "Source", draggable: true }]}
        label="Files"
        dragAndDrop={{ onMove: () => {} }}
      />,
    );
    const listRoot = container!.querySelector<HTMLElement>("[data-hierarchical-list-root]")!;
    const source = rowFor("Source")!;
    listRoot.scrollTop = 100;
    listRoot.scrollLeft = 25;
    setRect(listRoot, { top: 20, left: 10, width: 300 });
    setRect(source, { top: 50, left: 30, width: 200 });

    dispatchDrag(source, "dragstart", dataTransfer());

    const indicator = container!.querySelector<HTMLElement>("[data-drop-indicator]")!;
    expect(indicator.style.left).toBe("57px");
    expect(indicator.style.top).toBe("129.25px");
    expect(indicator.style.width).toBe("180px");
  });

  describe("row actions button", () => {
    it("is offered only when opted in, on rows that have menu content", () => {
      render(<HierarchicalList items={actionItems} label="Files" renderContextMenu={actionMenu} />);
      expect(actionsFor("Folder")).toBeNull();
      act(() => root!.unmount());

      root = createRoot(container!);
      act(() => root!.render(
        <HierarchicalList items={actionItems} label="Files" renderContextMenu={actionMenu} showRowActions />,
      ));

      expect(actionsFor("Folder")).not.toBeNull();
      expect(actionsFor("Last")).not.toBeNull();
      expect(actionsFor("Plain")).toBeNull();
      expect(rowFor("Folder")!.contains(actionsFor("Folder"))).toBe(false);
    });

    it("opens the row's menu without selecting or toggling the row, and Escape refocuses it", () => {
      const onItemClick = vi.fn<(item: HierarchicalListItem) => void>();
      const onSelectionClear = vi.fn<() => void>();
      render(
        <HierarchicalList
          items={actionItems}
          label="Files"
          selectedId="last"
          onItemClick={onItemClick}
          onSelectionClear={onSelectionClear}
          renderContextMenu={actionMenu}
          showRowActions
        />,
      );
      const trigger = actionsFor("Folder")!;
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");

      act(() => trigger.focus());
      press(trigger);

      expect(document.querySelector('[role="menu"]')?.textContent).toBe("Rename Folder");
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(onItemClick).not.toHaveBeenCalled();
      expect(onSelectionClear).not.toHaveBeenCalled();
      expect(rowFor("Folder")!.getAttribute("aria-expanded")).toBe("false");
      expect(rowFor("Child")).toBeUndefined();

      pressEscape(document.querySelector('[role="menuitem"]')!);

      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it("opens the same items as the row's context menu", () => {
      render(
        <HierarchicalList items={actionItems} label="Files" renderContextMenu={actionMenu} showRowActions />,
      );
      act(() => rowFor("Last")!.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      })));
      const contextItems = [...document.querySelectorAll('[role="menuitem"]')]
        .map((menuItem) => menuItem.textContent);
      pressEscape(document.querySelector('[role="menuitem"]')!);
      expect(document.querySelector('[role="menu"]')).toBeNull();

      press(actionsFor("Last")!);

      expect([...document.querySelectorAll('[role="menuitem"]')]
        .map((menuItem) => menuItem.textContent)).toEqual(contextItems);
      expect(contextItems).toEqual(["Rename Last"]);
    });

    it("replaces the row's open context menu with its own", () => {
      render(
        <HierarchicalList items={actionItems} label="Files" renderContextMenu={actionMenu} showRowActions />,
      );
      act(() => rowFor("Last")!.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      })));
      expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);

      press(actionsFor("Last")!);

      expect(actionsFor("Last")!.getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
      expect(document.querySelector('[role="menu"]')?.textContent).toBe("Rename Last");
    });

    it("follows its row in the tab order and stays out of arrow-key row navigation", () => {
      render(
        <HierarchicalList
          items={actionItems}
          label="Files"
          initialExpandedIds={["folder"]}
          renderContextMenu={actionMenu}
          showRowActions
        />,
      );
      const focusable = [...container!.querySelectorAll<HTMLElement>("button, [tabindex]")]
        .filter((element) => element.tabIndex >= 0);
      const folderRow = rowFor("Folder")!;
      expect(focusable[focusable.indexOf(folderRow) + 1]).toBe(actionsFor("Folder"));

      act(() => folderRow.focus());
      act(() => folderRow.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      })));

      expect(document.activeElement).toBe(rowFor("Child"));
    });

    it("leaves dragging and keyboard moves to the rows", () => {
      const onMove = vi.fn<(
        item: HierarchicalListItem,
        destination: HierarchicalListDropDestination,
      ) => void>();
      render(
        <HierarchicalList
          items={actionItems}
          label="Files"
          dragAndDrop={{ onMove }}
          renderContextMenu={actionMenu}
          showRowActions
        />,
      );
      const listRoot = container!.querySelector<HTMLElement>("[data-hierarchical-list-root]")!;
      const source = rowFor("Last")!;
      const target = rowFor("Plain")!;
      setRect(source, { top: 80 });
      setRect(target, { top: 40 });
      const transfer = dataTransfer();

      // The button sits over its row's end, so it must let a drag through to the row while the
      // list's root marks a drag as active.
      const actions = actionsFor("Last")!;
      expect(listRoot.contains(actions)).toBe(true);
      expect(actions.classList.contains("in-data-[drag-active]:pointer-events-none")).toBe(true);

      expect(listRoot.hasAttribute("data-drag-active")).toBe(false);
      dispatchDrag(source, "dragstart", transfer);
      expect(listRoot.hasAttribute("data-drag-active")).toBe(true);
      dispatchDrag(target, "dragover", transfer, 42);
      dispatchDrag(target, "drop", transfer, 42);

      expect(onMove).toHaveBeenLastCalledWith(actionItems[2], { parent: null, index: 1 });
      expect(listRoot.hasAttribute("data-drag-active")).toBe(false);

      act(() => source.focus());
      act(() => source.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowUp",
        altKey: true,
        bubbles: true,
        cancelable: true,
      })));

      expect(onMove).toHaveBeenCalledTimes(2);
      expect(onMove).toHaveBeenLastCalledWith(actionItems[2], { parent: null, index: 1 });
    });

    it("opens the action drawer on narrow layouts and returns the focus to the button", () => {
      vi.stubGlobal("matchMedia", vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn<() => void>(),
        removeEventListener: vi.fn<() => void>(),
      })));
      const onItemClick = vi.fn<(item: HierarchicalListItem) => void>();
      render(
        <HierarchicalList
          items={actionItems}
          label="Files"
          onItemClick={onItemClick}
          renderContextMenu={actionMenu}
          showRowActions
        />,
      );
      const trigger = actionsFor("Last")!;
      expect(trigger.getAttribute("aria-expanded")).toBe("false");

      press(trigger);

      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(document.querySelector('[role="menu"]')?.textContent).toBe("Rename Last");
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(onItemClick).not.toHaveBeenCalled();

      pressEscape(document.querySelector('[role="menuitem"]')!);

      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("does not suppress clicks when an item has no context actions", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn<() => void>(),
      removeEventListener: vi.fn<() => void>(),
    })));
    const item: HierarchicalListItem = { id: "skill", name: "Review code" };
    const onItemClick = vi.fn<(item: HierarchicalListItem) => void>();
    render(
      <HierarchicalList
        items={[item]}
        label="Skills"
        onItemClick={onItemClick}
        renderContextMenu={() => null}
      />,
    );

    const row = rowFor("Review code")!;
    dispatchTouchPointer(row, "pointerdown", 20, 30);
    act(() => vi.advanceTimersByTime(500));
    act(() => row.click());

    expect(onItemClick).toHaveBeenCalledWith(item);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
