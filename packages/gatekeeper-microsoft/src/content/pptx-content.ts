// Slide content as the layout engine sees it: a slide's Markdown blocks as body paragraphs, tables,
// code and pictures, measured (from character counts, conservatively, since PowerPoint keeps the
// autofit scale a file records instead of recomputing it on open) and spread over as many slides
// as it needs.

import { plainText, type MdBlock, type MdInline } from "./markdown-parse";
import type { Box } from "./pptx-deck";
import { BODY_MARGINS } from "./pptx-default";
import { IMAGE_TOKEN, type ImageReference } from "./pptx-images";

/** How a body paragraph is marked; a continuation is a list item's later paragraph, indented without a marker. */
export type ParagraphKind = "plain" | "bullet" | "number" | "task" | "heading" | "continuation";

/** One body paragraph, at a list `level` (0 outside lists). */
export interface Paragraph {
  readonly inlines: readonly MdInline[];
  readonly kind: ParagraphKind;
  readonly level: number;
  readonly number?: number;
  readonly checked?: boolean;
  readonly quote?: boolean;
  /** A line of a code block nested where only text can go. */
  readonly code?: boolean;
}

/** A table, laid out as a PowerPoint table. */
export type TableItem = {
  readonly kind: "table";
  readonly align: readonly ("left" | "center" | "right" | null)[];
  readonly header: readonly (readonly MdInline[])[];
  readonly rows: readonly (readonly (readonly MdInline[])[])[];
};

/** A picture from an image line. */
export type ImageItem = {
  readonly kind: "image";
  readonly ref: string;
  readonly alt: string;
  /** Pixel size, for the aspect ratio. */
  readonly width: number;
  readonly height: number;
  /** A ceiling on its height, in EMU, once it has been shrunk to share a slide. */
  readonly maxHeight?: number;
};

/** One unit of slide content: a run of text paragraphs, a table, a code block or a picture. */
export type Item =
  | { readonly kind: "text"; readonly paragraphs: readonly Paragraph[] }
  | TableItem
  | { readonly kind: "code"; readonly lines: readonly string[] }
  | ImageItem;

/** The deepest list level PowerPoint supports (0-based). */
export const MAX_LEVEL = 8;

/** A text inline with the given emphasis. */
export function text(value: string, style: { bold?: boolean; italic?: boolean; code?: boolean } = {}): MdInline {
  return { kind: "text", text: value, style: { bold: !!style.bold, italic: !!style.italic, strike: false, code: !!style.code } };
}

/** The image a token paragraph stands for, if it is one. */
export function imageOf(block: MdBlock, images: readonly ImageReference[]): ImageReference | undefined {
  if (block.kind !== "paragraph") return undefined;
  const match = IMAGE_TOKEN.exec(plainText(block.inlines).trim());
  return match ? images[Number(match[1])] : undefined;
}

/** Blocks as items: runs of text blocks become one text item; tables, code and images stand alone. */
export function items(blocks: readonly MdBlock[], images: readonly ImageReference[], sizeOf: (ref: string) => { width: number; height: number }): Item[] {
  const out: Item[] = [];
  let run: Paragraph[] = [];
  const flush = () => {
    if (run.length) out.push({ kind: "text", paragraphs: run });
    run = [];
  };
  for (const block of blocks) {
    const image = imageOf(block, images);
    if (image) {
      flush();
      out.push({ kind: "image", ref: image.ref, alt: image.alt, ...sizeOf(image.ref) });
    } else if (block.kind === "code") {
      flush();
      out.push({ kind: "code", lines: block.text.replace(/\n+$/, "").split("\n") });
    } else if (block.kind === "table") {
      flush();
      const width = block.header.length;
      const fit = (row: readonly (readonly MdInline[])[]) => Array.from({ length: width }, (_, index) => row[index] ?? []);
      out.push({ kind: "table", align: block.align, header: block.header, rows: block.rows.map(fit) });
    } else {
      run.push(...paragraphs(block, 0, false));
    }
  }
  flush();
  return out;
}

/** A block as body paragraphs; tables and code inside lists and quotes are flattened to lines. */
export function paragraphs(block: MdBlock, level: number, quote: boolean): Paragraph[] {
  const flag = quote ? { quote: true } : {};
  const kind = level ? "continuation" as const : "plain" as const;
  switch (block.kind) {
    case "paragraph":
      return [{ inlines: block.inlines, kind, level, ...flag }];
    case "heading":
      return [{ inlines: block.inlines, kind: "heading", level: 0, ...flag }];
    case "quote":
      return block.blocks.flatMap(child => paragraphs(child, level, true));
    case "code":
      return block.text.replace(/\n+$/, "").split("\n").map(line => ({ inlines: line ? [text(line, { code: true })] : [], kind, level, code: true, ...flag }));
    case "table":
      return [block.header, ...block.rows].map(row => ({ inlines: row.flatMap((cell, index) => index ? [text(" | "), ...cell] : [...cell]), kind, level, ...flag }));
    case "rule":
      return [];
    case "list":
      return block.items.flatMap((item, index): Paragraph[] => {
        const itemLevel = Math.min(level, MAX_LEVEL);
        const [lead, ...more] = item.blocks;
        const marker = item.checked !== undefined
          ? { kind: "task" as const, checked: item.checked }
          : block.ordered ? { kind: "number" as const, number: block.start + index } : { kind: "bullet" as const };
        const head: Paragraph = { inlines: lead?.kind === "paragraph" ? lead.inlines : [], level: itemLevel, ...marker, ...flag };
        const rest = lead?.kind === "paragraph" ? more : item.blocks;
        return [head, ...rest.flatMap(child => paragraphs(child, child.kind === "list" ? Math.min(level + 1, MAX_LEVEL) : itemLevel, quote)
          .map(paragraph => paragraph.kind === "plain" && child.kind !== "list" ? { ...paragraph, kind: "continuation" as const, level: itemLevel } : paragraph))];
      });
  }
}

// ---- Measuring ----

/** EMU per point. */
export const PT = 12700;
/** A text box's left plus right inset, in EMU. */
export const INSET_X = 91440 * 2;
/** A text box's top plus bottom inset, in EMU. */
export const INSET_Y = 45720 * 2;
/** The space between stacked items, in EMU. */
export const GAP = 137160;
/** An average character's width as a fraction of the font size, erring wide. */
export const CHAR_WIDTH = 0.52;
const CODE_CHAR_WIDTH = 0.6;
const LINE_HEIGHT = 1.2;

/** How many lines `value` wraps to in a box `widthPt` wide at `sizePt`. */
export function lineCount(value: string, widthPt: number, sizePt: number, charWidth = CHAR_WIDTH): number {
  const perLine = Math.max(1, Math.floor(widthPt / (sizePt * charWidth)));
  return value.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(line.length / perLine)), 0);
}

/** The text sizes content is measured at. */
export interface Metrics {
  /** Body sizes by level, in hundredths of a point. */
  readonly sizes: readonly number[];
}

/** A paragraph's font size, in hundredths of a point. */
export function paragraphSize(paragraph: Paragraph, metrics: Metrics): number {
  const size = metrics.sizes[paragraph.kind === "plain" || paragraph.kind === "heading" ? 0 : Math.min(paragraph.level, MAX_LEVEL)]!;
  return paragraph.code ? Math.round(size * 0.85) : size;
}

/** A paragraph's left margin, in EMU. */
function marginOf(paragraph: Paragraph): number {
  if (paragraph.kind === "plain" || paragraph.kind === "heading") return paragraph.quote ? 457200 : 0;
  return BODY_MARGINS[paragraph.level]! + (paragraph.kind === "number" ? 171450 : 0);
}

/** The height of paragraphs in a box `width` wide, in EMU, at `scale` (with PowerPoint's line spacing reduction). */
function textHeight(paragraphs: readonly Paragraph[], width: number, metrics: Metrics, scale = 1): number {
  const spacing = scale < 0.85 ? 0.9 : 1;
  let points = 0;
  for (const paragraph of paragraphs) {
    const size = paragraphSize(paragraph, metrics) / 100 * scale;
    const widthPt = (width - INSET_X - marginOf(paragraph)) / PT;
    const value = plainText(paragraph.inlines) + (paragraph.kind === "task" ? "☐ " : "");
    const lines = lineCount(value, widthPt, size, paragraph.code ? CODE_CHAR_WIDTH : paragraph.kind === "heading" ? CHAR_WIDTH * 1.06 : CHAR_WIDTH);
    const before = (paragraph.kind === "heading" ? 12 : paragraph.level === 0 ? 10 : 5) * scale;
    points += lines * size * LINE_HEIGHT * spacing + before;
  }
  return Math.ceil(points * PT + INSET_Y);
}

/** The largest autofit scale at which text fits `area`: 1 when it fits as is, down to `floor`. */
export function fitScale(paragraphs: readonly Paragraph[], area: Box, metrics: Metrics, floor = 0.7): number | undefined {
  for (const scale of [1, 0.9, 0.8, 0.7, 0.6, 0.5]) {
    if (scale < floor) break;
    if (textHeight(paragraphs, area.cx, metrics, scale) <= area.cy) return scale;
  }
  return undefined;
}

/** A table's column widths and row heights, in EMU, and its font size in hundredths of a point. */
export interface TableLayout {
  readonly widths: number[];
  readonly heights: number[];
  readonly size: number;
}

/** Column widths in proportion to their content, filling `width`, and the row heights that follow. */
export function tableLayout(item: TableItem, width: number): TableLayout {
  const columns = item.header.length;
  const size = columns <= 4 ? 1800 : columns <= 6 ? 1600 : columns <= 8 ? 1400 : 1200;
  const all = [item.header, ...item.rows];
  const weights = Array.from({ length: columns }, (_, column) =>
    Math.min(40, Math.max(4, ...all.map(row => plainText(row[column] ?? []).length))));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  // Every column gets at least 8% of the width, so a short header isn't crushed.
  const shares = weights.map(weight => Math.max(0.08, weight / total));
  const shareTotal = shares.reduce((sum, share) => sum + share, 0);
  const widths = shares.map(share => Math.floor(width * share / shareTotal));
  widths[columns - 1]! += width - widths.reduce((sum, value) => sum + value, 0);
  const heights = all.map((row, index) => {
    const lines = Math.max(1, ...row.map((cell, column) => lineCount(plainText(cell), (widths[column]! - INSET_X) / PT, size / 100, index === 0 ? CHAR_WIDTH * 1.08 : CHAR_WIDTH)));
    return Math.ceil((lines * size / 100 * LINE_HEIGHT) * PT + INSET_Y * 1.5);
  });
  return { widths, heights, size };
}

/** A code block's font size, in hundredths of a point: smaller the more lines it has. */
export function codeSize(lines: number): number {
  return lines <= 10 ? 1600 : lines <= 16 ? 1400 : lines <= 24 ? 1200 : 1100;
}

const CODE_INSET_X = 137160 * 2;
const CODE_INSET_Y = 91440 * 2;

function codeHeight(lines: readonly string[], width: number, size = codeSize(lines.length)): number {
  const count = lineCount(lines.join("\n"), (width - CODE_INSET_X) / PT, size / 100, CODE_CHAR_WIDTH);
  return Math.ceil(count * size / 100 * LINE_HEIGHT * PT + CODE_INSET_Y);
}

/** A picture's box within `area`: as large as fits with its aspect ratio kept, centered across. */
export function imageBox(item: ImageItem, area: Box, maxHeight = area.cy): Box {
  const ratio = item.height / item.width;
  let cx = area.cx, cy = cx * ratio;
  const limit = Math.min(maxHeight, item.maxHeight ?? Number.POSITIVE_INFINITY, area.cy);
  if (cy > limit) {
    cy = limit;
    cx = cy / ratio;
  }
  return { x: area.x + (area.cx - cx) / 2, y: area.y, cx: Math.round(cx), cy: Math.round(cy) };
}

/** The height `item` takes at `width`, in EMU. */
export function itemHeight(item: Item, width: number, metrics: Metrics, areaHeight = Number.POSITIVE_INFINITY): number {
  switch (item.kind) {
    case "text": return Math.ceil(textHeight(item.paragraphs, width, metrics) * 1.06);
    case "table": return tableLayout(item, width).heights.reduce((sum, height) => sum + height, 0);
    case "code": return codeHeight(item.lines, width);
    case "image": return imageBox(item, { x: 0, y: 0, cx: width, cy: areaHeight }).cy;
  }
}

/** The leading part of `item` that fits in `height`, and the rest; undefined when not even one unit fits. */
function splitItem(item: Item, height: number, area: Box, metrics: Metrics, force: boolean): [Item, Item | undefined] | undefined {
  if (item.kind === "image") {
    // A picture shrinks to the room left when that keeps it a reasonable size.
    return force || height >= area.cy * 0.35 ? [{ ...item, maxHeight: height }, undefined] : undefined;
  }
  const fits = (candidate: Item) => itemHeight(candidate, area.cx, metrics, area.cy) <= height;
  let units: number;
  let take: (count: number) => [Item, Item | undefined];
  switch (item.kind) {
    case "text": {
      units = item.paragraphs.length;
      take = count => {
        // A sub-heading stays with what follows it.
        while (count > 1 && count < units && item.paragraphs[count - 1]!.kind === "heading") count--;
        return [{ kind: "text", paragraphs: item.paragraphs.slice(0, count) },
          count < units ? { kind: "text", paragraphs: item.paragraphs.slice(count) } : undefined];
      };
      break;
    }
    case "table":
      units = item.rows.length;
      take = count => [{ ...item, rows: item.rows.slice(0, count) }, count < units ? { ...item, rows: item.rows.slice(count) } : undefined];
      break;
    case "code":
      units = item.lines.length;
      take = count => [{ kind: "code", lines: item.lines.slice(0, count) }, count < units ? { kind: "code", lines: item.lines.slice(count) } : undefined];
      break;
  }
  let count = 0;
  while (count < units && fits(take(count + 1)[0])) count++;
  if (count === 0) return force ? take(1) : undefined;
  return take(count);
}

/** The content of one slide. */
export interface Page {
  readonly items: Item[];
  /** Autofit scale for a page holding only text, when it needs shrinking. */
  readonly scale?: number;
}

/** Content spread over as many slides as it needs, each fitting `area`. */
export function paginate(content: readonly Item[], area: Box, metrics: Metrics): Page[] {
  const only = content[0];
  if (content.length === 1 && only?.kind === "text") {
    const scale = fitScale(only.paragraphs, area, metrics);
    if (scale !== undefined) return [scale < 1 ? { items: [only], scale } : { items: [only] }];
  }
  const pages: Page[] = [];
  let page: Item[] = [];
  let used = 0;
  const queue = [...content];
  while (queue.length) {
    const item = queue.shift()!;
    const gap = page.length ? GAP : 0;
    const height = itemHeight(item, area.cx, metrics, area.cy);
    if (used + gap + height <= area.cy) {
      page.push(item);
      used += gap + height;
      continue;
    }
    const room = area.cy - used - gap;
    // Split into the room left when it's worth using; otherwise start a fresh slide.
    const split = room >= area.cy * 0.25 ? splitItem(item, room, area, metrics, false) : undefined;
    if (split) {
      page.push(split[0]);
      if (split[1]) queue.unshift(split[1]);
      pages.push({ items: page });
      page = [];
      used = 0;
    } else if (page.length) {
      pages.push({ items: page });
      page = [];
      used = 0;
      queue.unshift(item);
    } else {
      const [head, tail] = splitItem(item, area.cy, area, metrics, true)!;
      pages.push({ items: [head] });
      if (tail) queue.unshift(tail);
    }
  }
  if (page.length) pages.push({ items: page });
  return pages.map(candidate => {
    const single = candidate.items[0];
    if (candidate.items.length !== 1 || single?.kind !== "text") return candidate;
    const scale = fitScale(single.paragraphs, area, metrics, 0.6) ?? 0.6;
    return scale < 1 ? { ...candidate, scale } : candidate;
  });
}

/**
 * Content that must fit one area with no further slides (a column of a two-column slide): text
 * alone shrinks as far as it needs; mixed content is stacked as it is.
 */
export function fitPage(content: readonly Item[], area: Box, metrics: Metrics): Page {
  const only = content[0];
  if (content.length === 1 && only?.kind === "text") {
    const scale = fitScale(only.paragraphs, area, metrics, 0.5) ?? 0.5;
    return scale < 1 ? { items: [only], scale } : { items: [only] };
  }
  return { items: [...content] };
}
