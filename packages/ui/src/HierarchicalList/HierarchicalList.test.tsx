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
      <HierarchicalList items={items} label="Skills" onItemClick={onItemClick} />,
    );

    expect(container?.querySelector("ul")?.getAttribute("aria-label")).toBe("Skills");
    expect(buttonFor("Review code")).toBeUndefined();

    act(() => buttonFor("Engineering")?.click());

    const skillButton = buttonFor("Review code");
    expect(skillButton).toBeDefined();
    expect(skillButton?.className).toContain("w-full");
    expect(skillButton?.className).toContain("focus-visible:z-20");
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

  it("reports valid drops and rejects drops into descendants", () => {
    const onMove = vi.fn<(
      item: HierarchicalListItem,
      destination: HierarchicalListDropDestination,
    ) => void>();
    const nestedItems: HierarchicalListItem[] = [
      {
        id: "source",
        name: "Source",
        draggable: true,
        droppable: true,
        children: [{ id: "child", name: "Child", droppable: true, children: [] }],
      },
      { id: "destination", name: "Destination", droppable: true, children: [] },
    ];
    render(
      <HierarchicalList items={nestedItems} label="Files" expandAll dragAndDrop={{ onMove }} />,
    );

    const source = rowFor("Source")!;
    const child = rowFor("Child")!;
    const destination = rowFor("Destination")!;
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn<(format: string, data: string) => void>(),
    };
    const dispatchDrag = (target: HTMLElement, type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      act(() => target.dispatchEvent(event));
    };

    dispatchDrag(source, "dragstart");
    dispatchDrag(child, "dragover");
    dispatchDrag(child, "drop");
    expect(onMove).not.toHaveBeenCalled();

    dispatchDrag(destination, "dragover");
    dispatchDrag(destination, "drop");
    expect(onMove).toHaveBeenCalledWith(nestedItems[0], {
      parent: nestedItems[1],
      index: 0,
    });
  });

  it("uses the row midpoint for before and after insertion", () => {
    const onMove = vi.fn<(
      item: HierarchicalListItem,
      destination: HierarchicalListDropDestination,
    ) => void>();
    const reorderItems: HierarchicalListItem[] = [
      { id: "source", name: "Source", draggable: true },
      { id: "target", name: "Target" },
    ];
    render(<HierarchicalList items={reorderItems} label="Files" dragAndDrop={{ onMove }} />);
    const source = rowFor("Source")!;
    const target = rowFor("Target")!;
    setRect(container!.firstElementChild!, { top: 0 });
    setRect(source, { top: 0 });
    setRect(target, { top: 40 });
    const transfer = dataTransfer();

    dispatchDrag(source, "dragstart", transfer);
    dispatchDrag(target, "dragover", transfer, 59);
    dispatchDrag(target, "drop", transfer, 59);
    expect(onMove).not.toHaveBeenCalled();
    expect(container!.querySelector('[role="status"]')).toBeNull();

    dispatchDrag(source, "dragstart", transfer);
    dispatchDrag(target, "dragover", transfer, 60);
    dispatchDrag(target, "drop", transfer, 60);
    expect(onMove).toHaveBeenLastCalledWith(reorderItems[0], { parent: null, index: 1 });
  });

  it("uses thirds of a closed folder for before, inside, and after", () => {
    const onMove = vi.fn<(
      item: HierarchicalListItem,
      destination: HierarchicalListDropDestination,
    ) => void>();
    const folderItems: HierarchicalListItem[] = [
      { id: "source", name: "Source", draggable: true },
      { id: "folder", name: "Folder", droppable: true, children: [] },
    ];
    render(<HierarchicalList items={folderItems} label="Files" dragAndDrop={{ onMove }} />);
    const source = rowFor("Source")!;
    const folder = rowFor("Folder")!;
    setRect(container!.firstElementChild!, { top: 0 });
    setRect(source, { top: 0, height: 60 });
    setRect(folder, { top: 60, height: 60 });
    const transfer = dataTransfer();

    const dropAt = (clientY: number) => {
      dispatchDrag(source, "dragstart", transfer);
      dispatchDrag(folder, "dragover", transfer, clientY);
      dispatchDrag(folder, "drop", transfer, clientY);
    };

    dropAt(70);
    expect(onMove).not.toHaveBeenCalled();
    dispatchDrag(source, "dragstart", transfer);
    dispatchDrag(folder, "dragover", transfer, 90);
    expect(container!.querySelector("[data-folder-drop-outline]")?.className)
      .toContain("border-kumo-brand");
    dispatchDrag(folder, "drop", transfer, 90);
    expect(onMove).toHaveBeenLastCalledWith(folderItems[0], { parent: folderItems[1], index: 0 });
    dropAt(110);
    expect(onMove).toHaveBeenLastCalledWith(folderItems[0], { parent: null, index: 1 });
  });

  it("only inserts into an expanded folder directly below its row", () => {
    const onMove = vi.fn<(
      item: HierarchicalListItem,
      destination: HierarchicalListDropDestination,
    ) => void>();
    const folderItems: HierarchicalListItem[] = [
      { id: "source", name: "Source", draggable: true },
      {
        id: "folder",
        name: "Folder",
        droppable: true,
        children: [{ id: "child", name: "Child" }],
      },
    ];
    render(
      <HierarchicalList items={folderItems} label="Files" expandAll dragAndDrop={{ onMove }} />,
    );
    const source = rowFor("Source")!;
    const folder = rowFor("Folder")!;
    const child = rowFor("Child")!;
    setRect(container!.firstElementChild!, { top: 0 });
    setRect(source, { top: 0 });
    setRect(folder, { top: 40 });
    setRect(child, { top: 80 });
    const transfer = dataTransfer();

    dispatchDrag(source, "dragstart", transfer);
    dispatchDrag(folder, "dragover", transfer, 75);
    dispatchDrag(folder, "drop", transfer, 75);
    expect(onMove).toHaveBeenLastCalledWith(folderItems[0], {
      parent: folderItems[1],
      index: 0,
    });

    dispatchDrag(source, "dragstart", transfer);
    dispatchDrag(child, "dragover", transfer, 101);
    dispatchDrag(child, "drop", transfer, 101);
    expect(onMove).toHaveBeenLastCalledWith(folderItems[0], {
      parent: folderItems[1],
      index: 1,
    });
  });

  it("moves one persistent fixed-thickness indicator between insertion targets", () => {
    const movementItems: HierarchicalListItem[] = [
      { id: "source", name: "Source", draggable: true },
      { id: "target", name: "Target" },
    ];
    render(
      <HierarchicalList
        items={movementItems}
        label="Files"
        dragAndDrop={{ onMove: () => {} }}
      />,
    );
    const source = rowFor("Source")!;
    const target = rowFor("Target")!;
    setRect(container!.firstElementChild!, { top: 0 });
    setRect(source, { top: 0 });
    setRect(target, { top: 40 });
    const transfer = dataTransfer();

    dispatchDrag(source, "dragstart", transfer);
    const indicator = container!.querySelector<HTMLElement>("[data-drop-indicator]");
    const dropZones = container!.querySelectorAll<HTMLElement>("[data-hierarchical-list-drop-zone]");
    expect(indicator).not.toBeNull();
    expect(indicator?.className).toContain("h-[1.5px]");
    expect(indicator?.className).toContain("bg-kumo-brand");
    expect(dropZones.length).toBeGreaterThan(0);
    expect([...dropZones].every((zone) => zone.className.includes("absolute"))).toBe(true);
    expect([...dropZones].every((zone) => !zone.className.includes("-my-"))).toBe(true);

    dispatchDrag(target, "dragover", transfer, 59);
    expect(container!.querySelectorAll("[data-drop-indicator]")).toHaveLength(1);
    expect(container!.querySelector("[data-drop-indicator]")).toBe(indicator);

    dispatchDrag(target, "dragover", transfer, 60);
    expect(container!.querySelectorAll("[data-drop-indicator]")).toHaveLength(1);
    expect(container!.querySelector("[data-drop-indicator]")).toBe(indicator);
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
    expect(source.className).toContain("hover:!bg-transparent");
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
    expect(source.closest("[data-hierarchical-list-item]")?.getAttribute("data-dragging")).toBe("");
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

  it("keeps rows natively draggable without disabling their touch scrolling", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
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

    const row = rowFor("Source")!;
    expect(row.draggable).toBe(true);
    expect(row.className).not.toContain("touch-none");
    expect(row.style.touchAction).not.toBe("none");
    expect(row.style.paddingLeft).toBe("12px");
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
        interaction={{ longPressDelayMs: 100, actionDrawerMaxWidthPx: 800 }}
        renderContextMenu={() => <DropdownMenu.Item>Delete</DropdownMenu.Item>}
      />,
    );

    const pointerDown = new MouseEvent("pointerdown", { bubbles: true, clientX: 20, clientY: 30 });
    Object.defineProperties(pointerDown, {
      isPrimary: { value: true },
      pointerType: { value: "touch" },
    });
    act(() => rowFor("Review code")?.dispatchEvent(pointerDown));
    act(() => vi.advanceTimersByTime(99));
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
        interaction={{ longPressDelayMs: 100 }}
        renderContextMenu={() => <DropdownMenu.Item>Delete</DropdownMenu.Item>}
      />,
    );
    const row = rowFor("Review code")!;

    dispatchTouchPointer(row, "pointerdown", 20, 30, 1);
    dispatchTouchPointer(row, "pointercancel", 25, 35, 2);
    act(() => vi.advanceTimersByTime(100));

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
    expect(document.querySelector("[aria-hidden='true'][data-popup-open]")).toBeNull();

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
