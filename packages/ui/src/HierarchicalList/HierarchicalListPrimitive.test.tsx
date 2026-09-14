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
    expect(row.tabIndex).toBe(0);
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

  it("clears a selected item with an empty ID from outside interaction", () => {
    const onSelectionClear = vi.fn<() => void>();
    render(
      <HierarchicalListPrimitive
        items={[{ id: "", name: "Inbox" }]}
        label="Resources"
        selectedId=""
        onSelectionClear={onSelectionClear}
        renderRow={(rowProps, { item }) => <button {...rowProps}>{item.name}</button>}
      />,
    );

    act(() => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));

    expect(onSelectionClear).toHaveBeenCalledOnce();
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
    expect(source.style.touchAction).not.toBe("none");
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
          items={[...tree]}
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
          items={[...tree]}
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

  it("keeps focus on an empty-ID item after a deferred move", () => {
    vi.useFakeTimers();
    const folder: HierarchicalListItem = {
      id: "folder",
      name: "Folder",
      droppable: true,
      children: [],
    };
    const movable: HierarchicalListItem = { id: "", name: "Movable", draggable: true };
    const Example = () => {
      const [tree, setTree] = React.useState<readonly HierarchicalListItem[]>([folder, movable]);
      return (
        <HierarchicalListPrimitive
          items={[...tree]}
          label="Resources"
          initialExpandedIds={[folder.id]}
          dragAndDrop={{
            onMove: (item, destination) => {
              if (destination.parent?.id !== folder.id) return;
              setTimeout(() => setTree([{ ...folder, children: [item] }]), 0);
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
    expect(document.activeElement).toBe(movableRow);

    act(() => vi.advanceTimersByTime(0));

    expect(document.activeElement?.textContent).toBe("Movable");
    expect(document.activeElement?.closest("[data-item-id='folder']")).not.toBeNull();
  });

  it("does not restore focus after the user tabs away from a deferred move", () => {
    vi.useFakeTimers();
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
        <>
          <HierarchicalListPrimitive
            items={tree}
            label="Resources"
            initialExpandedIds={[folder.id]}
            dragAndDrop={{
              onMove: (item, destination) => {
                if (destination.parent?.id !== folder.id) return;
                setTimeout(() => setTree([{ ...folder, children: [item] }]), 0);
              },
            }}
            renderRow={(rowProps, { item }) => <button {...rowProps}>{item.name}</button>}
          />
          <button>Outside</button>
        </>
      );
    };
    render(<Example />);
    const movableRow = [...container!.querySelectorAll("button")]
      .find((button) => button.textContent === "Movable")!;
    const outside = [...container!.querySelectorAll("button")]
      .find((button) => button.textContent === "Outside")!;
    act(() => movableRow.focus());
    act(() => movableRow.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    })));

    act(() => movableRow.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    })));
    act(() => outside.focus());
    act(() => vi.advanceTimersByTime(0));

    expect(document.activeElement).toBe(outside);
  });

  it("clears deferred focus restoration when a move fails", async () => {
    const folder: HierarchicalListItem = {
      id: "folder",
      name: "Folder",
      droppable: true,
      children: [],
    };
    const movable: HierarchicalListItem = { id: "movable", name: "Movable", draggable: true };
    const renderList = (tree: readonly HierarchicalListItem[]) => (
      <HierarchicalListPrimitive
        items={tree}
        label="Resources"
        initialExpandedIds={[folder.id]}
        dragAndDrop={{ onMove: () => Promise.reject(new Error("Move failed")) }}
        renderRow={(rowProps, { item }) => <button {...rowProps}>{item.name}</button>}
      />
    );
    render(renderList([folder, movable]));
    const movableRow = [...container!.querySelectorAll("button")]
      .find((button) => button.textContent === "Movable")!;
    act(() => movableRow.focus());
    act(() => movableRow.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    })));
    await act(() => Promise.resolve());

    expect(container!.querySelector('[role="status"]')).toBeNull();

    act(() => root!.render(renderList([{ ...folder, children: [movable] }])));

    expect(document.activeElement?.textContent).not.toBe("Movable");
  });

  it("announces an asynchronous move only after it succeeds", async () => {
    let resolveMove: (() => void) | undefined;
    const move = new Promise<void>((resolve) => {
      resolveMove = resolve;
    });
    render(
      <HierarchicalListPrimitive
        items={[
          { id: "source", name: "Source", draggable: true },
          { id: "target", name: "Target" },
        ]}
        label="Resources"
        dragAndDrop={{ onMove: () => move }}
        renderRow={(rowProps, { item }) => <button {...rowProps}>{item.name}</button>}
      />,
    );
    const source = [...container!.querySelectorAll("button")]
      .find((button) => button.textContent === "Source")!;
    act(() => source.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      bubbles: true,
      cancelable: true,
    })));
    expect(container!.querySelector('[role="status"]')).toBeNull();

    await act(async () => {
      resolveMove?.();
      await move;
    });

    expect(container!.querySelector('[role="status"]')?.textContent).toBe(
      "Source moved to position 2 in Resources.",
    );
  });

  it("abandons deferred focus restoration when the moved item disappears", () => {
    const folder: HierarchicalListItem = {
      id: "folder",
      name: "Folder",
      droppable: true,
      children: [],
    };
    const movable: HierarchicalListItem = { id: "movable", name: "Movable", draggable: true };
    const renderList = (tree: readonly HierarchicalListItem[]) => (
      <HierarchicalListPrimitive
        items={tree}
        label="Resources"
        initialExpandedIds={[folder.id]}
        dragAndDrop={{ onMove: () => {} }}
        renderRow={(rowProps, { item }) => <button {...rowProps}>{item.name}</button>}
      />
    );
    render(renderList([folder, movable]));
    const movableRow = [...container!.querySelectorAll("button")]
      .find((button) => button.textContent === "Movable")!;
    act(() => movableRow.focus());
    act(() => movableRow.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    })));

    act(() => root!.render(renderList([folder])));
    act(() => root!.render(renderList([{ ...folder, children: [movable] }])));

    expect(document.activeElement?.textContent).not.toBe("Movable");
  });

  it("prevents browser shortcuts when an Alt+Arrow move is unavailable", () => {
    const onMove = vi.fn<(
      item: HierarchicalListItem,
      destination: HierarchicalListDropDestination,
    ) => void>();
    render(
      <HierarchicalListPrimitive
        items={[{ id: "item", name: "Item", draggable: true }]}
        label="Resources"
        dragAndDrop={{ onMove }}
        renderRow={(rowProps, { item }) => <button {...rowProps}>{item.name}</button>}
      />,
    );
    const row = container!.querySelector("button")!;

    for (const key of ["ArrowLeft", "ArrowRight"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => row.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    }
    expect(onMove).not.toHaveBeenCalled();
  });

  it("leaves modified navigation and screen-reader arrow chords alone", () => {
    const onMove = vi.fn<(
      item: HierarchicalListItem,
      destination: HierarchicalListDropDestination,
    ) => void>();
    render(
      <HierarchicalListPrimitive
        items={[
          { id: "source", name: "Source", draggable: true },
          { id: "target", name: "Target" },
        ]}
        label="Resources"
        dragAndDrop={{ onMove }}
        renderRow={(rowProps, { item }) => <button {...rowProps}>{item.name}</button>}
      />,
    );
    const source = [...container!.querySelectorAll("button")]
      .find((button) => button.textContent === "Source")!;
    act(() => source.focus());
    for (const modifiers of [{ metaKey: true }, { altKey: true, ctrlKey: true }]) {
      const event = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        ...modifiers,
        bubbles: true,
        cancelable: true,
      });
      act(() => source.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
    expect(document.activeElement).toBe(source);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("clears insertion feedback over an invalid row", () => {
    const child: HierarchicalListItem = { id: "child", name: "Child" };
    const source: HierarchicalListItem = {
      id: "source",
      name: "Source",
      draggable: true,
      droppable: true,
      children: [child],
    };
    render(
      <HierarchicalListPrimitive
        items={[source, { id: "target", name: "Target" }]}
        label="Resources"
        expandAll
        dragAndDrop={{ onMove: () => {} }}
        renderRow={(rowProps, { item }) => <button {...rowProps}>{item.name}</button>}
        renderDropIndicator={(indicator) => (
          <span data-indicator-visible={indicator.visible ? "" : undefined} />
        )}
      />,
    );
    const sourceRow = [...container!.querySelectorAll("button")]
      .find((button) => button.textContent === "Source")!;
    const childRow = [...container!.querySelectorAll("button")]
      .find((button) => button.textContent === "Child")!;
    sourceRow.getBoundingClientRect = () => DOMRect.fromRect({ width: 300, height: 40 });
    childRow.getBoundingClientRect = () => DOMRect.fromRect({ y: 40, width: 300, height: 40 });
    const transfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn<(format: string, data: string) => void>(),
    };
    const dragStart = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: transfer });
    act(() => sourceRow.dispatchEvent(dragStart));
    expect(container!.querySelector("[data-indicator-visible]")).not.toBeNull();
    const dragOver = new MouseEvent("dragover", {
      bubbles: true,
      cancelable: true,
      clientY: 60,
    });
    Object.defineProperty(dragOver, "dataTransfer", { value: transfer });

    act(() => childRow.dispatchEvent(dragOver));

    expect(container!.querySelector("[data-indicator-visible]")).toBeNull();
  });

  it("provides a default hit area after the last root item", () => {
    const source: HierarchicalListItem = { id: "source", name: "Source", draggable: true };
    const folder: HierarchicalListItem = {
      id: "folder",
      name: "Folder",
      droppable: true,
      children: [],
    };
    const onMove = vi.fn<(
      item: HierarchicalListItem,
      destination: HierarchicalListDropDestination,
    ) => void>();
    render(
      <HierarchicalListPrimitive
        items={[source, folder]}
        label="Resources"
        expandAll
        dragAndDrop={{ onMove }}
        renderRow={(rowProps, { item }) => <button {...rowProps}>{item.name}</button>}
      />,
    );
    const sourceRow = [...container!.querySelectorAll("button")]
      .find((button) => button.textContent === "Source")!;
    const transfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn<(format: string, data: string) => void>(),
    };
    const dragStart = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: transfer });
    act(() => sourceRow.dispatchEvent(dragStart));
    const afterZone = container!.querySelector<HTMLElement>(
      "[data-item-id='folder'] [data-edge='after']",
    )!;
    expect(afterZone.style.height).toBe("12px");
    const drop = new MouseEvent("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: transfer });

    act(() => afterZone.dispatchEvent(drop));

    expect(onMove).toHaveBeenCalledWith(source, { parent: null, index: 1 });
  });

  it("keeps native mouse dragging on devices with a coarse primary pointer", () => {
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
    expect(row.draggable).toBe(true);
    expect(row.getAttribute("data-coarse-pointer")).toBe("");
    expect(matchMedia).toHaveBeenCalledWith("(pointer: coarse)");
    const dragStart = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStart, "dataTransfer", {
      value: {
        effectAllowed: "none",
        setData: vi.fn<(format: string, data: string) => void>(),
      },
    });
    act(() => row.dispatchEvent(dragStart));
    expect(row.closest("[data-hierarchical-list-item]")?.getAttribute("data-dragging")).toBe("");
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

  it("does not suppress a new click after a long press is cancelled", () => {
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
    const pointerDown = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperties(pointerDown, {
      isPrimary: { value: true },
      pointerType: { value: "touch" },
    });

    act(() => row.dispatchEvent(pointerDown));
    act(() => vi.advanceTimersByTime(100));
    act(() => row.dispatchEvent(new Event("pointercancel", { bubbles: true })));
    act(() => row.click());

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

  it("auto-scrolls at viewport and clipping-ancestor edges", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn<(callback: FrameRequestCallback) => number>(
      (callback) => frames.push(callback),
    ));
    vi.stubGlobal("cancelAnimationFrame", vi.fn<(id: number) => void>());
    const clippingAncestor = document.createElement("div");
    clippingAncestor.style.overflowY = "hidden";
    const scrollContainer = document.createElement("div");
    scrollContainer.style.overflowY = "auto";
    Object.defineProperties(scrollContainer, {
      clientHeight: { value: 1000 },
      scrollHeight: { value: 2000 },
    });
    clippingAncestor.append(scrollContainer);
    document.body.append(clippingAncestor);
    container = scrollContainer;
    root = createRoot(container);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn<(x: number, y: number) => Element | null>(() => scrollContainer),
    });
    scrollContainer.getBoundingClientRect = () => DOMRect.fromRect({ width: 300, height: 1000 });
    clippingAncestor.getBoundingClientRect = () => DOMRect.fromRect({ width: 300, height: 400 });
    act(() => root?.render(
      <HierarchicalListPrimitive
        items={[{ id: "source", name: "Source", draggable: true }]}
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

    dragOver(399);
    act(() => frames.shift()?.(0));
    expect(scrollContainer.scrollTop).toBeGreaterThan(0);

    scrollContainer.scrollTop = 0;
    clippingAncestor.style.overflowY = "visible";
    dragOver(window.innerHeight - 1);
    act(() => frames.shift()?.(0));
    expect(scrollContainer.scrollTop).toBeGreaterThan(0);
  });
});
