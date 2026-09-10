import { describe, expect, it } from "vitest";
import type { HierarchicalListItem } from "./HierarchicalList";
import {
  getKeyboardMoveDestination,
  getRowDropTarget,
  normalizeDropDestination,
} from "./HierarchicalListDragAndDrop";

const source: HierarchicalListItem = { id: "source", name: "Source", draggable: true };
const target: HierarchicalListItem = { id: "target", name: "Target" };

const rowTarget = (
  item: HierarchicalListItem,
  clientY: number,
  options: {
    source?: HierarchicalListItem;
    parent?: HierarchicalListItem | null;
    open?: boolean;
  } = {},
) => getRowDropTarget({
  source: options.source ?? source,
  item,
  parent: options.parent ?? null,
  index: 1,
  depth: 0,
  open: options.open ?? false,
  clientY,
  rowTop: 40,
  rowHeight: 60,
});

describe("hierarchical list drag-and-drop targeting", () => {
  it("inserts before or after a row at its midpoint", () => {
    expect(rowTarget(target, 69)?.destination).toEqual({ parent: null, index: 1 });
    expect(rowTarget(target, 70)?.destination).toEqual({ parent: null, index: 2 });
  });

  it("targets the middle third of a closed folder", () => {
    const folder: HierarchicalListItem = {
      id: "folder",
      name: "Folder",
      droppable: true,
      children: [{ id: "child", name: "Child" }],
    };

    expect(rowTarget(folder, 50)?.destination).toEqual({ parent: null, index: 1 });
    expect(rowTarget(folder, 70)?.destination).toEqual({ parent: folder, index: 1 });
    expect(rowTarget(folder, 110)?.destination).toEqual({ parent: null, index: 2 });
  });

  it("inserts at the start of an expanded folder", () => {
    const folder: HierarchicalListItem = {
      id: "folder",
      name: "Folder",
      droppable: true,
      children: [{ id: "child", name: "Child" }],
    };

    expect(rowTarget(folder, 80, { open: true })?.destination).toEqual({ parent: folder, index: 0 });
  });

  it("rejects moving a folder into its descendant", () => {
    const child: HierarchicalListItem = { id: "child", name: "Child", droppable: true, children: [] };
    const folder: HierarchicalListItem = {
      id: "folder",
      name: "Folder",
      droppable: true,
      children: [child],
    };

    expect(rowTarget(child, 70, { source: folder, parent: folder })).toBeNull();
  });

  it("normalizes same-parent destinations after removing the source", () => {
    const items = [source, target];
    expect(normalizeDropDestination(items, source, { parent: null, index: 2 })).toEqual({
      parent: null,
      index: 1,
    });
    expect(normalizeDropDestination(items, target, { parent: null, index: 0 })).toEqual({
      parent: null,
      index: 0,
    });
  });

  it("derives keyboard reorder and indentation destinations", () => {
    const folder: HierarchicalListItem = {
      id: "folder",
      name: "Folder",
      droppable: true,
      children: [],
    };
    const items = [folder, source, target];

    expect(getKeyboardMoveDestination(items, source, "up")).toEqual({ parent: null, index: 0 });
    expect(getKeyboardMoveDestination(items, source, "down")).toEqual({ parent: null, index: 3 });
    expect(getKeyboardMoveDestination(items, source, "right")).toEqual({ parent: folder, index: 0 });
  });

  it("rejects keyboard unindent into a non-droppable grandparent", () => {
    const nestedSource: HierarchicalListItem = { id: "nested", name: "Nested", draggable: true };
    const parent: HierarchicalListItem = {
      id: "parent",
      name: "Parent",
      droppable: true,
      children: [nestedSource],
    };
    const grandparent: HierarchicalListItem = {
      id: "grandparent",
      name: "Grandparent",
      children: [parent],
    };

    expect(getKeyboardMoveDestination([grandparent], nestedSource, "left")).toBeNull();
    const droppableGrandparent = { ...grandparent, droppable: true };
    expect(getKeyboardMoveDestination([droppableGrandparent], nestedSource, "left")).toEqual({
      parent: droppableGrandparent,
      index: 1,
    });
  });
});
