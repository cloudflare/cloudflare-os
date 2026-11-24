import { documentLength, nodesWithPositions } from "./model.js";
import type { BillowDocument, ItemRegistry, ModelRange } from "./types.js";

function graphemeBoundaries<Registry extends ItemRegistry>(document: BillowDocument<Registry>): number[] {
  const boundaries = [0];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { node, start, end } of nodesWithPositions(document)) {
    if (typeof node !== "string") {
      boundaries.push(end);
      continue;
    }
    for (const segment of segmenter.segment(node)) {
      const segmentEnd = start + segment.index + segment.segment.length;
      if (boundaries.at(-1) !== segmentEnd) boundaries.push(segmentEnd);
    }
  }
  return boundaries;
}

export function moveByGrapheme<Registry extends ItemRegistry>(document: BillowDocument<Registry>, position: number, direction: -1 | 1): number {
  const boundaries = graphemeBoundaries(document);
  if (direction < 0) {
    for (let index = boundaries.length - 1; index >= 0; index -= 1) {
      if (boundaries[index]! < position) return boundaries[index]!;
    }
    return 0;
  }
  return boundaries.find((boundary) => boundary > position) ?? documentLength(document);
}

export function expandEditingRange<Registry extends ItemRegistry>(document: BillowDocument<Registry>, range: ModelRange): ModelRange {
  const start = Math.min(range.anchor, range.focus);
  const end = Math.max(range.anchor, range.focus);
  const boundaries = graphemeBoundaries(document);
  let expandedStart = 0;
  for (const boundary of boundaries) {
    if (boundary > start) break;
    expandedStart = boundary;
  }
  if (range.anchor === range.focus) {
    return expandedStart === range.anchor
      ? range
      : { anchor: expandedStart, focus: expandedStart };
  }
  const expandedEnd = boundaries.find((boundary) => boundary >= end) ?? documentLength(document);
  return range.anchor <= range.focus
    ? { anchor: expandedStart, focus: expandedEnd }
    : { anchor: expandedEnd, focus: expandedStart };
}

export function rangeTouchesItem<Registry extends ItemRegistry>(document: BillowDocument<Registry>, range: ModelRange): boolean {
  const start = Math.min(range.anchor, range.focus);
  const end = Math.max(range.anchor, range.focus);
  for (const { node, start: nodeStart, end: nodeEnd } of nodesWithPositions(document)) {
    if (typeof node !== "string" && start <= nodeStart && end >= nodeEnd) return true;
  }
  return false;
}

// Created lazily and reused: pointer drags call wordBoundaryAt on every move event.
let wordSegmenter: Intl.Segmenter | undefined;
function getWordSegmenter(): Intl.Segmenter {
  return wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
}

/** The start (direction -1) or end (direction 1) of the word containing `position`. */
export function wordBoundaryAt<Registry extends ItemRegistry>(
  document: BillowDocument<Registry>,
  position: number,
  direction: -1 | 1,
): number {
  for (const { node, start: nodeStart, end: nodeEnd } of nodesWithPositions(document)) {
    if (typeof node !== "string" || position < nodeStart || position > nodeEnd) continue;
    const localPosition = position - nodeStart;
    for (const segment of getWordSegmenter().segment(node)) {
      const segmentEnd = segment.index + segment.segment.length;
      if (localPosition >= segment.index && localPosition < segmentEnd) {
        return nodeStart + (direction < 0 ? segment.index : segmentEnd);
      }
    }
  }
  return position;
}

/** Where Ctrl/Alt+Arrow word movement lands. Items count as words, so it steps over them in one go. */
export function wordMoveTarget<Registry extends ItemRegistry>(
  document: BillowDocument<Registry>,
  position: number,
  direction: -1 | 1,
): number {
  const units: Array<{ start: number; end: number; word: boolean }> = [];
  for (const { node, start: nodeStart, end: nodeEnd } of nodesWithPositions(document)) {
    if (typeof node !== "string") {
      units.push({ start: nodeStart, end: nodeEnd, word: true });
      continue;
    }
    for (const segment of getWordSegmenter().segment(node)) {
      const start = nodeStart + segment.index;
      units.push({ start, end: start + segment.segment.length, word: Boolean(segment.isWordLike) });
    }
  }
  if (direction > 0) {
    const next = units.find((unit) => unit.word && unit.end > position);
    return next ? next.end : documentLength(document);
  }
  const previous = [...units].reverse().find((unit) => unit.word && unit.start < position);
  return previous ? previous.start : 0;
}

/** A line is the run between newlines; `end` is the position of its newline (or the document end). */
export type LogicalLine = { start: number; end: number; hasItem: boolean; hasText: boolean };

/** The line containing `position`. A position on a newline belongs to the line that newline ends. */
export function logicalLineAt<Registry extends ItemRegistry>(
  document: BillowDocument<Registry>,
  position: number,
): LogicalLine {
  const lines: LogicalLine[] = [];
  let current: LogicalLine = { start: 0, end: 0, hasItem: false, hasText: false };
  for (const { node, start: nodeStart } of nodesWithPositions(document)) {
    if (typeof node !== "string") {
      current.hasItem = true;
      continue;
    }
    let segmentStart = 0;
    for (let index = node.indexOf("\n"); index !== -1; index = node.indexOf("\n", index + 1)) {
      if (index > segmentStart) current.hasText = true;
      lines.push({ ...current, end: nodeStart + index });
      current = { start: nodeStart + index + 1, end: 0, hasItem: false, hasText: false };
      segmentStart = index + 1;
    }
    if (segmentStart < node.length) current.hasText = true;
  }
  lines.push({ ...current, end: documentLength(document) });
  return lines.find((line) => position <= line.end) ?? lines[lines.length - 1]!;
}

export function documentsEqual<Registry extends ItemRegistry>(left: BillowDocument<Registry>, right: BillowDocument<Registry>): boolean {
  if (left.length !== right.length) return false;
  return left.every((node, index) => {
    const other = right[index];
    if (other === undefined || typeof node !== typeof other) return false;
    if (typeof node === "string") return node === other;
    return typeof other !== "string"
      && node.id === other.id
      && node.itemType === other.itemType
      && Object.is(node.data, other.data);
  });
}
