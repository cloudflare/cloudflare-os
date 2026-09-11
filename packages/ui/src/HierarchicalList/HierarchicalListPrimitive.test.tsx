// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HierarchicalListDropDestination } from "./HierarchicalListDragAndDrop";
import {
  HierarchicalListPrimitive,
  type HierarchicalListPrimitiveRowProps,
  type HierarchicalListPrimitiveRowState,
} from "./HierarchicalListPrimitive";
import type { HierarchicalListItem } from "./HierarchicalList.types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const items: HierarchicalListItem[] = [{
  id: "folder",
  name: "Folder",
  children: [{ id: "document", name: "Document" }],
}];

const disclosureRow = (
  rowProps: HierarchicalListPrimitiveRowProps,
  state: HierarchicalListPrimitiveRowState,
) => (
  <button
    {...rowProps}
    onClick={(event) => {
      rowProps.onClick?.(event);
      if (!event.defaultPrevented) state.toggleExpanded();
    }}
  >
    {state.item.name}
  </button>
);

describe("HierarchicalListPrimitive", () => {
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

  it("renders caller-owned row markup and styling with stable state attributes", () => {
    render(
      <HierarchicalListPrimitive
        items={items}
        label="Custom resources"
        selectedId="folder"
        renderRow={(rowProps, { item, depth, selected, expanded }) => (
          <article
            {...rowProps}
            className="caller-markup"
            data-render-depth={depth}
          >
            {item.name}:{selected ? "selected" : "idle"}:{expanded ? "open" : "closed"}
          </article>
        )}
      />,
    );

    const row = container!.querySelector<HTMLElement>("[data-hierarchical-list-row]")!;
    expect(row.className).toContain("caller-markup");
    expect(row.getAttribute("data-selected")).toBe("");
    expect(row.getAttribute("data-collapsed")).toBe("");
    expect(row.getAttribute("data-depth")).toBe("0");
    expect(row.textContent).toBe("Folder:selected:closed");
    expect(container!.querySelector("[data-item-id='folder']")?.getAttribute("data-depth")).toBe("0");
    expect(container!.textContent).not.toContain("Document");
  });

  it("owns uncontrolled expansion and reports controlled expansion", () => {
    const onExpandedChange = vi.fn<(ids: ReadonlySet<string>) => void>();
    render(
      <HierarchicalListPrimitive
        items={items}
        label="Resources"
        renderRow={disclosureRow}
      />,
    );
    act(() => container!.querySelector<HTMLElement>("[data-item-id='folder'] [data-hierarchical-list-row]")!.click());
    expect(container!.textContent).toContain("Document");

    act(() => root!.render(
      <HierarchicalListPrimitive
        items={items}
        label="Resources"
        expandedIds={new Set()}
        onExpandedChange={onExpandedChange}
        renderRow={disclosureRow}
      />,
    ));
    act(() => container!.querySelector<HTMLElement>("[data-item-id='folder'] [data-hierarchical-list-row]")!.click());
    expect(onExpandedChange).toHaveBeenCalledOnce();
    expect([...onExpandedChange.mock.calls[0][0]]).toEqual(["folder"]);
    expect(container!.textContent).not.toContain("Document");
  });

  it("keeps activation separate from expansion", () => {
    const onItemClick = vi.fn<(item: HierarchicalListItem) => void>();
    render(
      <HierarchicalListPrimitive
        items={items}
        label="Resources"
        onItemClick={onItemClick}
        renderRow={(rowProps, { item }) => <button {...rowProps}>{item.name}</button>}
      />,
    );

    act(() => container!.querySelector<HTMLButtonElement>("button")!.click());
    expect(onItemClick).toHaveBeenCalledWith(items[0]);
    expect(container!.textContent).not.toContain("Document");
  });

  it("does not toggle expansion state for leaf items", () => {
    const onExpandedChange = vi.fn<(ids: ReadonlySet<string>) => void>();
    render(
      <HierarchicalListPrimitive
        items={[{ id: "leaf", name: "Leaf" }]}
        label="Resources"
        expandedIds={new Set()}
        onExpandedChange={onExpandedChange}
        renderRow={disclosureRow}
      />,
    );

    act(() => container!.querySelector<HTMLButtonElement>("button")!.click());
    expect(onExpandedChange).not.toHaveBeenCalled();
  });

  it("does not mutate hidden expansion state while expandAll is active", () => {
    render(
      <HierarchicalListPrimitive
        items={items}
        label="Resources"
        expandAll
        renderRow={disclosureRow}
      />,
    );
    expect(container!.textContent).toContain("Document");
    act(() => container!.querySelector<HTMLElement>("[data-item-id='folder'] button")!.click());

    act(() => root!.render(
      <HierarchicalListPrimitive items={items} label="Resources" renderRow={disclosureRow} />,
    ));
    expect(container!.textContent).not.toContain("Document");
  });

  it("provides drag-and-drop behavior to custom row elements", () => {
    const movableItems: HierarchicalListItem[] = [
      { id: "source", name: "Source", draggable: true },
      { id: "target", name: "Target" },
    ];
    const onMove = vi.fn<(
      item: HierarchicalListItem,
      destination: HierarchicalListDropDestination,
    ) => void>();
    render(
      <HierarchicalListPrimitive
        items={movableItems}
        label="Movable resources"
        dragAndDrop={{ onMove }}
        renderRow={(rowProps, { item }) => <button {...rowProps}>{item.name}</button>}
      />,
    );

    const [source, target] = Array.from(container!.querySelectorAll("button"));
    expect(source.style.touchAction).toBe("none");
    source.getBoundingClientRect = () => DOMRect.fromRect({ y: 0, width: 300, height: 40 });
    target.getBoundingClientRect = () => DOMRect.fromRect({ y: 40, width: 300, height: 40 });
    const transfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn<(format: string, data: string) => void>(),
    };
    const dispatchDrag = (element: Element, type: string, clientY: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      act(() => element.dispatchEvent(event));
    };

    dispatchDrag(source, "dragstart", 10);
    expect(source.closest("[data-hierarchical-list-item]")?.getAttribute("data-dragging")).toBe("");
    dispatchDrag(target, "dragover", 70);
    dispatchDrag(target, "drop", 70);

    expect(onMove).toHaveBeenCalledWith(movableItems[0], { parent: null, index: 1 });
  });

  it("keeps keyboard focus on an item moved to another branch", () => {
    const folder: HierarchicalListItem = {
      id: "folder",
      name: "Folder",
      droppable: true,
      children: [],
    };
    const movable: HierarchicalListItem = { id: "movable", name: "Movable", draggable: true };
    const Example = () => {
      const [tree, setTree] = React.useState<readonly HierarchicalListItem[]>([folder, movable]);
      return (
        <HierarchicalListPrimitive
          items={tree}
          label="Resources"
          initialExpandedIds={[folder.id]}
          dragAndDrop={{
            onMove: (item, destination) => {
              if (destination.parent?.id !== folder.id) return;
              setTree([{ ...folder, children: [item] }]);
            },
          }}
          renderRow={(rowProps, { item }) => <button {...rowProps}>{item.name}</button>}
        />
      );
    };
    render(<Example />);

    const movableRow = [...container!.querySelectorAll("button")]
      .find((button) => button.textContent === "Movable")!;
    act(() => movableRow.focus());
    act(() => movableRow.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    })));

    expect(document.activeElement?.textContent).toBe("Movable");
    expect(document.activeElement?.closest("[data-item-id='folder']")).not.toBeNull();
    expect(container!.querySelector('[role="status"]')?.textContent).toBe(
      "Movable moved to position 1 in Folder.",
    );
  });

  it("focuses a collapsed destination when the moved item becomes hidden", () => {
    const folder: HierarchicalListItem = {
      id: "folder",
      name: "Folder",
      droppable: true,
      children: [],
    };
    const movable: HierarchicalListItem = { id: "movable", name: "Movable", draggable: true };
    const Example = () => {
      const [tree, setTree] = React.useState<readonly HierarchicalListItem[]>([folder, movable]);
      return (
        <HierarchicalListPrimitive
          items={tree}
          label="Resources"
          dragAndDrop={{
            onMove: (item, destination) => {
              if (destination.parent?.id !== folder.id) return;
              setTree([{ ...folder, children: [item] }]);
            },
          }}
          renderRow={disclosureRow}
        />
      );
    };
    render(<Example />);

    const movableRow = [...container!.querySelectorAll("button")]
      .find((button) => button.textContent === "Movable")!;
    act(() => movableRow.focus());
    act(() => movableRow.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    })));

    expect(container!.querySelector("[data-item-id='movable']")).toBeNull();
    expect(document.activeElement?.textContent).toBe("Folder");
    act(() => (document.activeElement as HTMLButtonElement).click());
    expect(container!.querySelector("[data-item-id='movable']")).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("Folder");
  });

  it("uses primary coarse-pointer capability for native dragging", () => {
    const matchMedia = vi.fn<(query: string) => {
      matches: boolean;
      addEventListener: () => void;
      removeEventListener: () => void;
    }>((query) => ({
      matches: query === "(pointer: coarse)",
      addEventListener: vi.fn<() => void>(),
      removeEventListener: vi.fn<() => void>(),
    }));
    vi.stubGlobal("matchMedia", matchMedia);
    const draggableItem: HierarchicalListItem = {
      id: "touch-item",
      name: "Touch item",
      draggable: true,
    };
    render(
      <HierarchicalListPrimitive
        items={[draggableItem]}
        label="Resources"
        dragAndDrop={{ onMove: () => {} }}
        renderRow={(rowProps, state) => (
          <button
            {...rowProps}
            data-coarse-pointer={state.coarsePointer ? "" : undefined}
          >
            {state.item.name}
          </button>
        )}
      />,
    );

    const row = container!.querySelector<HTMLButtonElement>("button")!;
    expect(row.draggable).toBe(false);
    expect(row.getAttribute("data-coarse-pointer")).toBe("");
    expect(matchMedia).toHaveBeenCalledWith("(pointer: coarse)");
  });

  it("handles touch gestures when the primary pointer is fine", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(any-pointer: coarse)",
      addEventListener: vi.fn<() => void>(),
      removeEventListener: vi.fn<() => void>(),
    })));
    const item: HierarchicalListItem = {
      id: "hybrid-item",
      name: "Hybrid item",
      draggable: true,
    };
    const onItemLongPress = vi.fn<(pressedItem: HierarchicalListItem) => void>();
    render(
      <HierarchicalListPrimitive
        items={[item]}
        label="Resources"
        dragAndDrop={{ onMove: () => {} }}
        hasLongPressAction={() => true}
        onItemLongPress={onItemLongPress}
        interaction={{ longPressDelayMs: 100 }}
        renderRow={(rowProps, { item: rowItem }) => (
          <button {...rowProps}>{rowItem.name}</button>
        )}
      />,
    );
    const row = container!.querySelector("button")!;
    expect(row.draggable).toBe(true);
    const pointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      clientX: 20,
      clientY: 30,
    });
    Object.defineProperties(pointerDown, {
      isPrimary: { value: true },
      pointerType: { value: "touch" },
    });

    act(() => row.dispatchEvent(pointerDown));
    act(() => vi.advanceTimersByTime(100));
    expect(onItemLongPress).toHaveBeenCalledWith(item);
  });

  it("reports a long press", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(pointer: coarse)" || query.startsWith("(max-width:"),
      addEventListener: vi.fn<() => void>(),
      removeEventListener: vi.fn<() => void>(),
    })));
    const item: HierarchicalListItem = { id: "touch-item", name: "Touch item" };
    const onItemLongPress = vi.fn<(pressedItem: HierarchicalListItem) => void>();
    render(
      <HierarchicalListPrimitive
        items={[item]}
        label="Resources"
        hasLongPressAction={() => true}
        onItemLongPress={onItemLongPress}
        interaction={{ longPressDelayMs: 100 }}
        renderRow={(rowProps, { item: rowItem }) => (
          <button {...rowProps}>{rowItem.name}</button>
        )}
      />,
    );

    const event = new MouseEvent("pointerdown", {
      bubbles: true,
      clientX: 20,
      clientY: 30,
    });
    Object.defineProperties(event, {
      isPrimary: { value: true },
      pointerType: { value: "touch" },
    });
    act(() => container!.querySelector("button")!.dispatchEvent(event));
    act(() => vi.advanceTimersByTime(100));

    expect(onItemLongPress).toHaveBeenCalledWith(item);
  });

  it("lets row slots cancel internal click and keyboard behavior", () => {
    const folder: HierarchicalListItem = {
      id: "folder",
      name: "Folder",
      draggable: true,
      children: [{ id: "child", name: "Child" }],
    };
    const onItemClick = vi.fn<(item: HierarchicalListItem) => void>();
    const onMove = vi.fn<(
      item: HierarchicalListItem,
      destination: HierarchicalListDropDestination,
    ) => void>();
    const onClick = vi.fn<(event: React.MouseEvent<HTMLElement>) => void>((event) => {
      event.preventDefault();
    });
    const onKeyDown = vi.fn<(event: React.KeyboardEvent<HTMLElement>) => void>((event) => {
      event.preventDefault();
    });
    render(
      <HierarchicalListPrimitive
        items={[folder, { id: "target", name: "Target" }]}
        label="Resources"
        dragAndDrop={{ onMove }}
        onItemClick={onItemClick}
        renderRow={(rowProps, { item }) => (
          <button
            {...rowProps}
            onClick={(event) => {
              onClick(event);
              rowProps.onClick?.(event);
            }}
            onKeyDown={(event) => {
              onKeyDown(event);
              rowProps.onKeyDown?.(event);
            }}
          >
            {item.name}
          </button>
        )}
      />,
    );

    const row = [...container!.querySelectorAll("button")]
      .find((button) => button.textContent === "Folder")!;
    act(() => row.click());
    act(() => row.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    })));

    expect(onClick).toHaveBeenCalledOnce();
    expect(onKeyDown).toHaveBeenCalledOnce();
    expect(onItemClick).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
    expect(container!.textContent).not.toContain("Child");
  });

  it("clears drag state even when a row slot cancels drag end", () => {
    const item: HierarchicalListItem = { id: "source", name: "Source", draggable: true };
    render(
      <HierarchicalListPrimitive
        items={[item]}
        label="Resources"
        dragAndDrop={{ onMove: () => {} }}
        renderRow={(rowProps, { item: rowItem }) => (
          <button
            {...rowProps}
            onDragEnd={(event) => {
              event.preventDefault();
              rowProps.onDragEnd?.(event);
            }}
          >
            {rowItem.name}
          </button>
        )}
      />,
    );
    const row = container!.querySelector("button")!;
    const dragStart = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStart, "dataTransfer", {
      value: {
        effectAllowed: "none",
        setData: vi.fn<(format: string, data: string) => void>(),
      },
    });

    act(() => row.dispatchEvent(dragStart));
    expect(row.closest("[data-hierarchical-list-item]")?.getAttribute("data-dragging")).toBe("");
    act(() => row.dispatchEvent(new Event("dragend", { bubbles: true, cancelable: true })));
    expect(row.closest("[data-hierarchical-list-item]")?.hasAttribute("data-dragging")).toBe(false);
  });

  it("suppresses only the click immediately following a long press", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn<() => void>(),
      removeEventListener: vi.fn<() => void>(),
    })));
    const item: HierarchicalListItem = { id: "touch-item", name: "Touch item" };
    const onItemClick = vi.fn<(clickedItem: HierarchicalListItem) => void>();
    render(
      <HierarchicalListPrimitive
        items={[item]}
        label="Resources"
        hasLongPressAction={() => true}
        onItemLongPress={() => {}}
        onItemClick={onItemClick}
        interaction={{ longPressDelayMs: 100 }}
        renderRow={(rowProps, { item: rowItem }) => (
          <button {...rowProps}>{rowItem.name}</button>
        )}
      />,
    );
    const row = container!.querySelector("button")!;
    const pointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      clientX: 20,
      clientY: 30,
    });
    Object.defineProperties(pointerDown, {
      isPrimary: { value: true },
      pointerType: { value: "touch" },
    });

    act(() => row.dispatchEvent(pointerDown));
    act(() => vi.advanceTimersByTime(100));
    act(() => row.click());
    expect(onItemClick).not.toHaveBeenCalled();
    act(() => row.click());
    expect(onItemClick).toHaveBeenCalledOnce();
    expect(onItemClick).toHaveBeenCalledWith(item);
  });

  it("auto-scrolls in both directions from desktop row drag events", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn<(callback: FrameRequestCallback) => number>(
      (callback) => frames.push(callback),
    ));
    vi.stubGlobal("cancelAnimationFrame", vi.fn<(id: number) => void>());
    const scrollContainer = document.createElement("div");
    scrollContainer.style.overflowY = "auto";
    scrollContainer.scrollTop = 100;
    Object.defineProperties(scrollContainer, {
      clientHeight: { value: 200 },
      scrollHeight: { value: 1000 },
    });
    scrollContainer.getBoundingClientRect = () => DOMRect.fromRect({ width: 300, height: 200 });
    container = scrollContainer;
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn<(x: number, y: number) => Element | null>(() => scrollContainer),
    });
    const draggableItem: HierarchicalListItem = {
      id: "source",
      name: "Source",
      draggable: true,
    };
    act(() => root?.render(
      <HierarchicalListPrimitive
        items={[draggableItem]}
        label="Resources"
        dragAndDrop={{ onMove: () => {}, autoScroll: true }}
        renderRow={(rowProps, { item }) => <button {...rowProps}>{item.name}</button>}
      />,
    ));
    const row = container.querySelector("button")!;
    const transfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn<(format: string, data: string) => void>(),
    };
    const dragStart = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: transfer });
    act(() => row.dispatchEvent(dragStart));
    const dragOver = (clientY: number) => {
      const event = new MouseEvent("dragover", {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY,
      });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      act(() => row.dispatchEvent(event));
    };

    dragOver(1);
    act(() => frames.shift()?.(0));
    expect(scrollContainer.scrollTop).toBeLessThan(100);

    scrollContainer.scrollTop = 100;
    dragOver(199);
    act(() => frames.shift()?.(0));
    expect(scrollContainer.scrollTop).toBeGreaterThan(100);
  });
});
