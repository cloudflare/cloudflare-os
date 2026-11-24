import type { BillowDocument, BillowNode, ItemDefinition, ItemNode, ItemRegistry, ModelRange } from "./types.js";

export const SERIALIZATION_VERSION = 1;

export function getItemDefinition(registry: ItemRegistry, itemType: string): ItemDefinition<any, any, any> {
  if (!Object.hasOwn(registry, itemType)) throw new TypeError(`Unknown item type: ${itemType}`);
  const definition = registry[itemType];
  if (!definition) throw new TypeError(`Unknown item type: ${itemType}`);
  return definition;
}

function orderedRange(range: ModelRange): [number, number] {
  return range.anchor <= range.focus
    ? [range.anchor, range.focus]
    : [range.focus, range.anchor];
}

function assertRange<Registry extends ItemRegistry>(document: BillowDocument<Registry>, range: ModelRange): [number, number] {
  const length = documentLength(document);
  const [start, end] = orderedRange(range);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > length) {
    throw new RangeError("Selection is outside the document");
  }
  return [start, end];
}

export function normalizeDocument<Registry extends ItemRegistry>(document: BillowDocument<Registry>): BillowDocument<Registry> {
  if (!Array.isArray(document)) throw new TypeError("Invalid document");
  const nodes: BillowNode<Registry>[] = [];
  for (const node of document) {
    if (typeof node === "string") {
      if (!node) continue;
      const previous = nodes.at(-1);
      if (typeof previous === "string") nodes[nodes.length - 1] = previous + node;
      else nodes.push(node);
      continue;
    }
    if (node.type !== "item" || typeof node.id !== "string" || !node.id || typeof node.itemType !== "string" || !node.itemType) {
      throw new TypeError("Invalid item node");
    }
    nodes.push({ type: "item", id: node.id, itemType: node.itemType, data: node.data } as ItemNode<Registry>);
  }
  return nodes;
}

/**
 * Positions in a document count one per UTF-16 code unit of text and exactly one
 * per item, so an item always occupies a single position regardless of how it renders.
 */
export function nodeLength<Registry extends ItemRegistry>(node: BillowNode<Registry>): number {
  return typeof node === "string" ? node.length : 1;
}

export function documentLength<Registry extends ItemRegistry>(document: BillowDocument<Registry>): number {
  return document.reduce((length, node) => length + nodeLength(node), 0);
}

export interface PositionedNode<Registry extends ItemRegistry> {
  readonly node: BillowNode<Registry>;
  readonly index: number;
  /** Model position before the node. */
  readonly start: number;
  /** Model position after the node (`start + nodeLength(node)`). */
  readonly end: number;
}

/** Walks the document, yielding each node with the model positions it spans. */
export function* nodesWithPositions<Registry extends ItemRegistry>(
  document: BillowDocument<Registry>,
): Generator<PositionedNode<Registry>, void, undefined> {
  let start = 0;
  for (let index = 0; index < document.length; index += 1) {
    const node = document[index]!;
    const end = start + nodeLength(node);
    yield { node, index, start, end };
    start = end;
  }
}

export function documentToPlainText<Registry extends ItemRegistry>(document: BillowDocument<Registry>, registry: Registry): string {
  return document.map((node) => {
    if (typeof node === "string") return node;
    const definition = getItemDefinition(registry, node.itemType);
    return definition.toPlainText(node.data);
  }).join("");
}

/** The one-position range an item occupies, or null if no item has that id. */
export function findItemRange<Registry extends ItemRegistry>(
  document: BillowDocument<Registry>,
  id: string,
): ModelRange | null {
  for (const { node, start, end } of nodesWithPositions(document)) {
    if (typeof node !== "string" && node.id === id) return { anchor: start, focus: end };
  }
  return null;
}

export function sliceDocument<Registry extends ItemRegistry>(document: BillowDocument<Registry>, range: ModelRange): BillowDocument<Registry> {
  const [start, end] = assertRange(document, range);
  const nodes: BillowNode<Registry>[] = [];
  for (const { node, start: nodeStart, end: nodeEnd } of nodesWithPositions(document)) {
    if (typeof node === "string") {
      const from = Math.max(start, nodeStart) - nodeStart;
      const to = Math.min(end, nodeEnd) - nodeStart;
      if (to > from) nodes.push(node.slice(from, to));
    } else if (start <= nodeStart && end >= nodeEnd) {
      // An item is atomic: it is kept only when the range covers it entirely.
      nodes.push(node);
    }
  }
  return normalizeDocument(nodes);
}

export function replaceDocumentRange<Registry extends ItemRegistry>(
  document: BillowDocument<Registry>,
  range: ModelRange,
  replacement: BillowDocument<Registry>,
): BillowDocument<Registry> {
  const [start, end] = assertRange(document, range);
  const before = sliceDocument(document, { anchor: 0, focus: start });
  const after = sliceDocument(document, { anchor: end, focus: documentLength(document) });
  return normalizeDocument([...before, ...normalizeDocument(replacement), ...after]);
}

export function serializeDocument<Registry extends ItemRegistry>(document: BillowDocument<Registry>, registry: Registry): unknown {
  return {
    version: SERIALIZATION_VERSION,
    nodes: normalizeDocument(document).map((node) => {
      if (typeof node === "string") return { type: "text", text: node };
      const definition = getItemDefinition(registry, node.itemType);
      return { type: "item", itemType: node.itemType, data: definition.serialize ? definition.serialize(node.data) : node.data };
    }),
  };
}

let nextId = 0;
export function defaultCreateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    try {
      return crypto.randomUUID();
    } catch {
      // Restricted WebViews can expose randomUUID while disallowing its use.
    }
  }
  nextId += 1;
  return `billow-item-${Date.now().toString(36)}-${nextId.toString(36)}`;
}

/** How many times a custom `createId` may return an ID that is already taken before giving up. */
const MAX_UNIQUE_ID_ATTEMPTS = 100;

export function createUniqueId(createId: () => string, usedIds: Set<string>): string {
  for (let attempt = 0; attempt < MAX_UNIQUE_ID_ATTEMPTS; attempt += 1) {
    const id = createId();
    if (typeof id !== "string" || !id) throw new TypeError("createId must return a non-empty string");
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
  throw new TypeError("createId could not produce a unique item ID");
}

export function deserializeDocument<Registry extends ItemRegistry>(
  value: unknown,
  registry: Registry,
  createId: () => string = defaultCreateId,
): BillowDocument<Registry> {
  if (!value || typeof value !== "object") throw new TypeError("Invalid serialized document");
  const input = value as { version?: unknown; nodes?: unknown };
  if (input.version !== SERIALIZATION_VERSION || !Array.isArray(input.nodes)) {
    throw new TypeError("Unsupported serialized document");
  }
  const usedIds = new Set<string>();
  const nodes: BillowNode<Registry>[] = input.nodes.map((raw): BillowNode<Registry> => {
    if (!raw || typeof raw !== "object") throw new TypeError("Invalid serialized node");
    const node = raw as { type?: unknown; text?: unknown; itemType?: unknown; data?: unknown };
    if (node.type === "text" && typeof node.text === "string") return node.text;
    if (node.type !== "item" || typeof node.itemType !== "string") throw new TypeError("Invalid serialized node");
    const definition = getItemDefinition(registry, node.itemType);
    const id = createUniqueId(createId, usedIds);
    return {
      type: "item",
      id,
      itemType: node.itemType,
      data: definition.deserialize ? definition.deserialize(node.data) : node.data,
    } as ItemNode<Registry>;
  });
  return normalizeDocument(nodes);
}
