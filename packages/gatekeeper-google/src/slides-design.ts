/**
 * `updateSlides()` changes: their replay over slides as Google returns them, and the requests that
 * make each.
 *
 * Each change rewrites the slide's JSON as Google documents the request doing, and returns that
 * request, so the read a queued change previews and the batch its approval writes come from the
 * same code. A change that would need what only Google can work out to be shown, such as how a
 * merged table cell grows, is refused instead. What Google renders is never simulated: a new
 * element shows what the change sets, an image keeps the box it was asked for rather than the one
 * Google fits it to, and text does not reflow.
 */

import type { RestPageElement, RestSlide } from "./slides-api";
import {
  paragraphStyleChange, pointsDimension, reshaped, restFillOf, shapePropertiesChange,
  textStyleChange, restyled,
} from "./slides-format";
import {
  EMU_PER_POINT, localBox, matrixFor, matrixOf, placementOf, transformOf, type Placement,
} from "./slides-geometry";
import type { SlideBounds } from "./slides-read-types";
import type { Deck } from "./slides-simulation";
import { editSlide, locate, textSlot, type Located, type TextSlot } from "./slides-target";
import {
  ChangeConflict, changeRange, fixedRange, isGraphemeBoundary, paragraphAt, paragraphRange,
  projectedText, providerRange, restTextOf, richTextOf, spliceText, styledText, type RichText,
} from "./slides-text";
import type { SlideChange, SlideTextTarget } from "./slides-types";

type Minted<C> = C extends { ref?: string } ? Omit<C, "ref"> & { id: string } : C;

/**
 * A change as queued. An element it creates has the ID the gatekeeper minted for it, which later
 * changes address it by, and text it addresses by range, or replaces whole, carries what that text
 * was when the change was queued, which it must still be.
 */
export type DesignChange = Minted<SlideChange> & { before?: string };

/**
 * What one change did: the requests that do it, the text it addressed before and after, and the
 * element it created or deleted.
 */
export type DesignStep = {
  requests: unknown[];
  previous?: string;
  text?: string;
  created?: string;
  deleted?: string;
};

/** `createParagraphBullets` presets, by the name agents give them. */
const BULLET_PRESETS = {
  bullet: "BULLET_DISC_CIRCLE_SQUARE",
  checkbox: "BULLET_CHECKBOX",
  numbered: "NUMBERED_DIGIT_ALPHA_ROMAN",
};

// Google nests list items nine levels deep.
const MAX_NESTING_LEVEL = 8;

// Points of indentation a nesting level, as Google sets them on list items and leaves them when it
// removes a bullet.
const LEVEL_INDENT = 36;

// How far a read-back placement may be from the one asked for: under the reads' rounding.
const PLACEMENT_TOLERANCE = 0.005;

/**
 * Applies `changes` in order. Returns the edited deck, and what each change did: null for one on a
 * slide the deck does not hold. Throws `ChangeConflict`.
 */
export function designDeck(
  deck: Deck, changes: readonly DesignChange[],
): { deck: Deck; steps: (DesignStep | null)[] } {
  let edited = new Map<string, RestSlide>();
  let created = new Set<string>();
  let steps = changes.map((change, i) => {
    try {
      if (!deck.order.includes(change.slideId)) {
        throw new ChangeConflict(`slide "${change.slideId}" no longer exists`);
      }
      let slide = edited.get(change.slideId);
      if (!slide) {
        let held = deck.slides.get(change.slideId);
        if (!held) return null;
        edited.set(change.slideId, slide = structuredClone(held));
      }
      let step = applyDesign(slide, change, created);
      if (step.created) created.add(step.created);
      return step;
    } catch (error) {
      if (!(error instanceof ChangeConflict)) throw error;
      throw new ChangeConflict(`change ${i + 1} (${change.op}): ${error.message}`);
    }
  });
  return {
    deck: edited.size === 0 ? deck : { order: deck.order, slides: new Map([...deck.slides, ...edited]) },
    steps,
  };
}

function applyDesign(
  slide: RestSlide, change: DesignChange, created: ReadonlySet<string>,
): DesignStep {
  switch (change.op) {
    case "editText": {
      let { requests, previous, text } = editSlide(slide, change);
      return { requests, previous, text };
    }
    case "formatText":
      return formatText(slide, change);
    case "formatParagraphs":
      return formatParagraphs(slide, change);
    case "createShape":
      return createShape(slide, change);
    case "updateShape":
      return { requests: [updateShape(elementOn(slide, change.elementId).element, change)] };
    case "setBounds":
      return setBounds(slide, change, created);
    case "deleteElement":
      return deleteElement(slide, change.elementId);
    case "setAltText":
      return setAltText(slide, change);
    case "arrange":
      return arrange(slide, change);
    case "insertImage":
      return insertImage(slide, change);
    case "replaceImage":
      return replaceImage(slide, change);
    case "createTable":
      return createTable(slide, change);
    case "insertTableRows":
    case "insertTableColumns":
      return insertTableLines(slide, change);
    case "deleteTableRows":
    case "deleteTableColumns":
      return deleteTableLines(slide, change);
    case "formatTableCells":
      return formatTableCells(slide, change);
  }
}

function elementOn(slide: RestSlide, id: string): Located {
  let found = locate(slide.pageElements, id);
  if (!found) throw new ChangeConflict(`the slide has no element "${id}"`);
  return found;
}

// Grouped elements are drawn, moved and stacked with their group, so they are changed through it.
function topLevelOn(slide: RestSlide, id: string): RestPageElement {
  let { element, group } = elementOn(slide, id);
  if (group) {
    throw new ChangeConflict(
      `element "${id}" is inside group "${group.objectId}"; change the group instead`);
  }
  return element;
}

function requireNewElement(slide: RestSlide, id: string): void {
  if (locate(slide.pageElements, id)) throw new ChangeConflict(`the slide already has an element "${id}"`);
}

/** The text a change addresses, and the projected range of it. */
type Addressed = { slot: TextSlot; rich: RichText; text: string; start: number; end: number };

function addressed(slide: RestSlide, target: SlideTextTarget & { before?: string }): Addressed {
  let slot = textSlot(slide, target);
  let rich = richTextOf(slot.body);
  let text = projectedText(rich.segments);
  let { range } = target;
  if (!range) return { slot, rich, text, ...changeRange(text, { find: target.find }) };
  if (target.before !== undefined && text !== target.before) {
    throw new ChangeConflict("the text has changed since this change was made");
  }
  if (range.end > text.length) {
    throw new ChangeConflict(`the range ends past the end of the text, at ${text.length}`);
  }
  if (!isGraphemeBoundary(text, range.start) || !isGraphemeBoundary(text, range.end)) {
    throw new ChangeConflict("the range starts or ends inside a character");
  }
  return { slot, rich, text, start: range.start, end: range.end };
}

function formatText(
  slide: RestSlide, change: Extract<DesignChange, { op: "formatText" }>,
): DesignStep {
  let { slot, rich, text, start, end } = addressed(slide, change);
  if (start === end) throw new ChangeConflict("there is no text to format");
  let style = textStyleChange(change.format);
  let { startIndex, endIndex } = providerRange(rich.segments, start, end);
  slot.write(restTextOf(styledText(rich, start, end, style)));
  return {
    requests: [{
      updateTextStyle: {
        ...slot.location, style: style.style, fields: style.fields.join(","),
        textRange: fixedRange(startIndex, endIndex),
      },
    }],
    previous: text,
    text,
  };
}

function formatParagraphs(
  slide: RestSlide, change: Extract<DesignChange, { op: "formatParagraphs" }>,
): DesignStep {
  let { slot, rich, text, start, end } = addressed(slide, change);
  let first = paragraphAt(text, start);
  let last = end > start ? paragraphAt(text, end - 1) : first;
  let range = providerRange(rich.segments, paragraphRange(text, first)[0], paragraphRange(text, last)[1]);
  // Through the last paragraph's newline, so an empty paragraph has a range too.
  let textRange = fixedRange(range.startIndex, range.endIndex + 1);
  let touched = (i: number) => i >= first && i <= last;
  let requests: unknown[] = [];
  let next = rich;
  let style = paragraphStyleChange(change);
  if (style.fields.length > 0) {
    requests.push({
      updateParagraphStyle: { ...slot.location, style: style.style, fields: style.fields.join(","), textRange },
    });
    next = {
      ...next,
      paragraphs: next.paragraphs.map((paragraph, i) => {
        if (!touched(i)) return paragraph;
        let { style: _, ...rest } = paragraph;
        let restyledStyle = restyled(paragraph.style, style);
        return restyledStyle ? { ...rest, style: restyledStyle } : rest;
      }),
    };
  }
  if (change.bullets === "none") {
    requests.push({ deleteParagraphBullets: { ...slot.location, textRange } });
    next = {
      ...next,
      paragraphs: next.paragraphs.map((paragraph, i) => {
        let { bullet, ...rest } = paragraph;
        if (!touched(i) || !bullet) return paragraph;
        // Google keeps the item's nesting as both indents.
        let indent = pointsDimension(LEVEL_INDENT * (bullet.nestingLevel ?? 0));
        return { ...rest, style: { ...rest.style, indentStart: indent, indentFirstLine: indent } };
      }),
    };
  } else if (change.bullets) {
    // Google adds them to that list if its preset matches, which the list does not say.
    if (first > 0 && next.paragraphs[first - 1].bullet) {
      throw new ChangeConflict(
        "the paragraph before is a list item, whose list Google may continue; include it");
    }
    requests.push({
      createParagraphBullets: { ...slot.location, textRange, bulletPreset: BULLET_PRESETS[change.bullets] },
    });
    // Its own ID, so replay never takes it for a list the paragraph left, whose items may remain.
    next = bulleted(next, first, last, `${slot.location.objectId}.${crypto.randomUUID()}`);
  }
  slot.write(restTextOf(next));
  return { requests, previous: text, text: projectedText(next.segments) };
}

/**
 * Makes paragraphs `first` to `last` items of a new list, as `createParagraphBullets` does: each is
 * nested by the tabs it starts with, which are removed.
 */
function bulleted(rich: RichText, first: number, last: number, listId: string): RichText {
  // Last to first, so removing a paragraph's tabs leaves the offsets of those before it in `text`.
  let text = projectedText(rich.segments);
  let next = rich;
  for (let i = last; i >= first; i--) {
    let [from, to] = paragraphRange(text, i);
    let tabs = text.slice(from, to).match(/^\t*/)![0].length;
    if (tabs > MAX_NESTING_LEVEL) {
      throw new ChangeConflict(
        `a paragraph starts with ${tabs} tabs; lists nest at most ${MAX_NESTING_LEVEL + 1} deep`);
    }
    if (tabs > 0) next = spliceText(next, from, from + tabs, "");
    let paragraph = next.paragraphs[i];
    next.paragraphs[i] = {
      ...paragraph,
      // Google indents an item a level more than its nesting, hanging its bullet half a level out.
      style: {
        ...paragraph.style,
        indentStart: pointsDimension(LEVEL_INDENT * (tabs + 1)),
        indentFirstLine: pointsDimension(LEVEL_INDENT * (tabs + 0.5)),
      },
      // Google omits a zero nesting level, as it omits every zero-valued field.
      bullet: { listId, ...(tabs > 0 ? { nestingLevel: tabs } : {}) },
    };
  }
  return next;
}

/** The size and transform Google takes for an element placed at `bounds`, unrotated. */
function placed(bounds: SlideBounds): Pick<RestPageElement, "size" | "transform"> {
  return {
    size: { width: pointsDimension(bounds.width), height: pointsDimension(bounds.height) },
    transform: { scaleX: 1, scaleY: 1, translateX: bounds.x, translateY: bounds.y, unit: "PT" },
  };
}

function createShape(
  slide: RestSlide, change: Extract<DesignChange, { op: "createShape" }>,
): DesignStep {
  let { slideId, id, shapeType, bounds, text, format, fill, outline } = change;
  requireNewElement(slide, id);
  let element: RestPageElement = { objectId: id, ...placed(bounds), shape: { shapeType } };
  // Google adds an element in front of the slide's others.
  (slide.pageElements ??= []).push(element);
  let requests: unknown[] = [{
    createShape: { objectId: id, shapeType, elementProperties: { pageObjectId: slideId, ...placed(bounds) } },
  }];
  if (text) requests.push(...editSlide(slide, { slideId, elementId: id, replace: text }).requests);
  if (format) {
    requests.push(...formatText(slide, { op: "formatText", slideId, elementId: id, format }).requests);
  }
  if (fill !== undefined || outline !== undefined) {
    requests.push(updateShape(element, {
      ...(fill !== undefined ? { fill } : {}), ...(outline !== undefined ? { outline } : {}),
    }));
  }
  return { requests, created: id };
}

function updateShape(
  element: RestPageElement, change: Parameters<typeof shapePropertiesChange>[0],
): unknown {
  let shape = element.shape;
  if (!shape) throw new ChangeConflict(`element "${element.objectId}" is not a shape`);
  let { properties, fields } = shapePropertiesChange(change);
  shape.shapeProperties = reshaped(shape.shapeProperties, properties);
  return {
    updateShapeProperties: {
      objectId: element.objectId, shapeProperties: properties, fields: fields.join(","),
    },
  };
}

function setBounds(
  slide: RestSlide, change: Extract<DesignChange, { op: "setBounds" }>, created: ReadonlySet<string>,
): DesignStep {
  let { elementId } = change;
  // Google may size an element it creates otherwise than asked, so a box planned from the asked
  // one could land elsewhere.
  if (created.has(elementId)) {
    throw new ChangeConflict(
      "an element created in the same batch cannot be moved; give it the bounds it should have");
  }
  let element = topLevelOn(slide, elementId);
  let box = localBox(element);
  let matrix = element.transform && matrixOf(element.transform);
  let current = matrix && box && placementOf(matrix, box);
  if (!matrix || !box || !current) throw new ChangeConflict("Google reports no position for it");
  let bounds = { ...current.bounds, ...change.bounds };
  let resized = change.bounds?.width !== undefined || change.bounds?.height !== undefined ||
    change.rotation !== undefined;
  let next;
  if (!resized) {
    // A move only translates, leaving the rest of the transform, shear included, exactly as it was.
    next = {
      ...matrix,
      tx: matrix.tx + (bounds.x - current.bounds.x) * EMU_PER_POINT,
      ty: matrix.ty + (bounds.y - current.bounds.y) * EMU_PER_POINT,
    };
  } else {
    if (element.table) throw new ChangeConflict("a table can only be moved");
    if (current.shear > 1e-6) {
      throw new ChangeConflict("the element is skewed, which resizing or rotating it would undo");
    }
    let rotation = change.rotation ?? current.rotation;
    let target: Placement = { bounds, rotation: (rotation % 360 + 360) % 360, flipped: current.flipped };
    next = matrixFor(box, target, matrix);
    let landed = placementOf(next, box);
    let missed = !landed || (Object.keys(bounds) as (keyof SlideBounds)[])
      .some(key => Math.abs(landed.bounds[key] - bounds[key]) > PLACEMENT_TOLERANCE);
    if (missed) {
      throw new ChangeConflict("it is a line, which has no width or height across it to set");
    }
  }
  // Google takes no shear for a video, which every rotation but a half turn needs. A half turn
  // leaves rounding error where its shear is zero, so that is cleared.
  if (element.video) {
    let scale = Math.hypot(next.a, next.b, next.c, next.d);
    if (Math.abs(next.b) > 1e-9 * scale || Math.abs(next.c) > 1e-9 * scale) {
      throw new ChangeConflict("Google Slides cannot place a video rotated or skewed");
    }
    next = { ...next, b: 0, c: 0 };
  }
  element.transform = transformOf(next);
  return {
    requests: [{
      updatePageElementTransform: { objectId: elementId, applyMode: "ABSOLUTE", transform: transformOf(next) },
    }],
  };
}

function deleteElement(slide: RestSlide, id: string): DesignStep {
  let { element, siblings, group } = elementOn(slide, id);
  // Google then deletes the group too, and does not say what becomes of the element left in it.
  if (group && siblings.length <= 2) {
    throw new ChangeConflict(
      `deleting it would leave group "${group.objectId}" with one element; delete the group instead`);
  }
  siblings.splice(siblings.indexOf(element), 1);
  return { requests: [{ deleteObject: { objectId: id } }], deleted: id };
}

function setAltText(
  slide: RestSlide, change: Extract<DesignChange, { op: "setAltText" }>,
): DesignStep {
  let { elementId, title, description } = change;
  let { element } = elementOn(slide, elementId);
  if (element.elementGroup) throw new ChangeConflict("a group has no alt text");
  // Empty alt text is refused before this, since Google may keep the old text for it.
  if (title !== undefined) element.title = title;
  if (description !== undefined) element.description = description;
  return {
    requests: [{
      updatePageElementAltText: {
        objectId: elementId,
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
      },
    }],
  };
}

function arrange(slide: RestSlide, change: Extract<DesignChange, { op: "arrange" }>): DesignStep {
  let element = topLevelOn(slide, change.elementId);
  let rest = slide.pageElements!.filter(other => other !== element);
  slide.pageElements = change.to === "front" ? [...rest, element] : [element, ...rest];
  return {
    requests: [{
      updatePageElementsZOrder: {
        pageElementObjectIds: [change.elementId],
        operation: change.to === "front" ? "BRING_TO_FRONT" : "SEND_TO_BACK",
      },
    }],
  };
}

function insertImage(
  slide: RestSlide, change: Extract<DesignChange, { op: "insertImage" }>,
): DesignStep {
  let { slideId, id, url, bounds } = change;
  requireNewElement(slide, id);
  let placement = bounds ? placed(bounds) : {};
  (slide.pageElements ??= []).push({ objectId: id, ...placement, image: { sourceUrl: url } });
  return {
    requests: [{
      createImage: { objectId: id, url, elementProperties: { pageObjectId: slideId, ...placement } },
    }],
    created: id,
  };
}

function replaceImage(
  slide: RestSlide, change: Extract<DesignChange, { op: "replaceImage" }>,
): DesignStep {
  let { element } = elementOn(slide, change.elementId);
  if (!element.image) throw new ChangeConflict(`element "${change.elementId}" is not an image`);
  element.image = { ...element.image, sourceUrl: change.url };
  return {
    requests: [{
      replaceImage: { imageObjectId: change.elementId, url: change.url, imageReplaceMethod: "CENTER_CROP" },
    }],
  };
}

type Table = NonNullable<RestPageElement["table"]>;
type Cell = NonNullable<NonNullable<Table["tableRows"]>[number]["tableCells"]>[number];

function emptyCell(row: number, column: number): Cell {
  return {
    location: { rowIndex: row, columnIndex: column },
    text: restTextOf({ segments: [], paragraphs: [{}] }),
  };
}

function createTable(
  slide: RestSlide, change: Extract<DesignChange, { op: "createTable" }>,
): DesignStep {
  let { slideId, id, rows, columns, bounds, cells = [] } = change;
  requireNewElement(slide, id);
  let placement = bounds ? placed(bounds) : {};
  let tableRows = Array.from({ length: rows }, (_row, row) => ({
    tableCells: Array.from({ length: columns }, (_cell, column) => emptyCell(row, column)),
  }));
  (slide.pageElements ??= []).push({ objectId: id, ...placement, table: { rows, columns, tableRows } });
  let requests: unknown[] = [{
    createTable: { objectId: id, elementProperties: { pageObjectId: slideId, ...placement }, rows, columns },
  }];
  cells.forEach((line, row) => line.forEach((replace, column) => {
    if (replace) {
      requests.push(...editSlide(slide, { slideId, elementId: id, cell: { row, column }, replace }).requests);
    }
  }));
  return { requests, created: id };
}

function tableOn(slide: RestSlide, id: string): Table {
  let { table } = elementOn(slide, id).element;
  if (!table) throw new ChangeConflict(`element "${id}" is not a table`);
  return table;
}

type Axis = "row" | "column";

function startOf(cell: Cell, axis: Axis): number {
  return (axis === "row" ? cell.location?.rowIndex : cell.location?.columnIndex) ?? 0;
}

function spanOf(cell: Cell, axis: Axis): number {
  return (axis === "row" ? cell.rowSpan : cell.columnSpan) ?? 1;
}

function cellsOf(table: Table): Cell[] {
  return (table.tableRows ?? []).flatMap(row => row.tableCells ?? []);
}

function isMerged(cell: Cell): boolean {
  return spanOf(cell, "row") > 1 || spanOf(cell, "column") > 1;
}

// Whether a cell's rows or columns overlap `[from, to)`, or lie within it.
function overlaps(cell: Cell, axis: Axis, from: number, to: number): boolean {
  return startOf(cell, axis) < to && startOf(cell, axis) + spanOf(cell, axis) > from;
}

function within(cell: Cell, axis: Axis, from: number, to: number): boolean {
  return startOf(cell, axis) >= from && startOf(cell, axis) + spanOf(cell, axis) <= to;
}

// A merged cell whose rows or columns overlap `[from, to)`.
function mergedAcross(table: Table, axis: Axis, from: number, to: number): Cell | undefined {
  return cellsOf(table).find(cell => isMerged(cell) && overlaps(cell, axis, from, to));
}

function cellName(cell: Cell): string {
  return `row ${startOf(cell, "row")}, column ${startOf(cell, "column")}`;
}

// Puts every cell's location back in step with where it now is.
function reindexed(table: Table): void {
  table.tableRows?.forEach((row, rowIndex) => row.tableCells?.forEach(cell => {
    cell.location = { ...cell.location, rowIndex };
  }));
}

function insertTableLines(
  slide: RestSlide,
  change: Extract<DesignChange, { op: "insertTableRows" | "insertTableColumns" }>,
): DesignStep {
  let { elementId, at, count = 1 } = change;
  let table = tableOn(slide, elementId);
  let axis: Axis = change.op === "insertTableRows" ? "row" : "column";
  let size = (axis === "row" ? table.rows : table.columns) ?? 0;
  if (at > size) throw new ChangeConflict(`the table has ${size} ${axis}s`);
  // Google documents no rule for how a merged cell beside new rows or columns grows.
  let merged = mergedAcross(table, axis, at - 1, at + 1);
  if (merged) {
    throw new ChangeConflict(`the ${axis} beside them holds a merged cell, at ${cellName(merged)}`);
  }
  let reference = at < size ? at : size - 1;
  if (axis === "row") {
    let columns = table.columns ?? 0;
    table.tableRows = (table.tableRows ?? []).toSpliced(at, 0, ...Array.from({ length: count }, () => ({
      tableCells: Array.from({ length: columns }, (_, column) => emptyCell(0, column)),
    })));
    table.rows = size + count;
    reindexed(table);
    return {
      requests: [{
        insertTableRows: {
          tableObjectId: elementId, cellLocation: { rowIndex: reference, columnIndex: 0 },
          insertBelow: at === size, number: count,
        },
      }],
    };
  }
  table.tableRows?.forEach((row, rowIndex) => {
    let cells = row.tableCells ?? [];
    for (let cell of cells) {
      let column = startOf(cell, "column");
      if (column >= at) cell.location = { ...cell.location, columnIndex: column + count };
    }
    let position = cells.findIndex(cell => startOf(cell, "column") >= at + count);
    row.tableCells = cells.toSpliced(position < 0 ? cells.length : position, 0,
      ...Array.from({ length: count }, (_, k) => emptyCell(rowIndex, at + k)));
  });
  table.columns = size + count;
  return {
    requests: [{
      insertTableColumns: {
        tableObjectId: elementId, cellLocation: { rowIndex: 0, columnIndex: reference },
        insertRight: at === size, number: count,
      },
    }],
  };
}

function deleteTableLines(
  slide: RestSlide,
  change: Extract<DesignChange, { op: "deleteTableRows" | "deleteTableColumns" }>,
): DesignStep {
  let { elementId, at, count = 1 } = change;
  let table = tableOn(slide, elementId);
  let axis: Axis = change.op === "deleteTableRows" ? "row" : "column";
  let size = (axis === "row" ? table.rows : table.columns) ?? 0;
  if (at + count > size) throw new ChangeConflict(`the table has ${size} ${axis}s`);
  if (count >= size) throw new ChangeConflict(`that is every ${axis}; delete the table instead`);
  let merged = mergedAcross(table, axis, at, at + count);
  if (merged) throw new ChangeConflict(`a merged cell, at ${cellName(merged)}, is in them`);
  let requests = Array.from({ length: count }, () => axis === "row"
    ? { deleteTableRow: { tableObjectId: elementId, cellLocation: { rowIndex: at, columnIndex: 0 } } }
    : { deleteTableColumn: { tableObjectId: elementId, cellLocation: { rowIndex: 0, columnIndex: at } } });
  if (axis === "row") {
    table.tableRows = (table.tableRows ?? []).toSpliced(at, count);
    table.rows = size - count;
    reindexed(table);
  } else {
    for (let row of table.tableRows ?? []) {
      row.tableCells = (row.tableCells ?? []).flatMap(cell => {
        let column = startOf(cell, "column");
        if (column < at) return [cell];
        if (column < at + count) return [];
        return [{ ...cell, location: { ...cell.location, columnIndex: column - count } }];
      });
    }
    table.columns = size - count;
  }
  return { requests };
}

function formatTableCells(
  slide: RestSlide, change: Extract<DesignChange, { op: "formatTableCells" }>,
): DesignStep {
  let { elementId, fill, contentAlignment } = change;
  let table = tableOn(slide, elementId);
  let rows = table.rows ?? 0;
  let columns = table.columns ?? 0;
  let range = change.range ?? { row: 0, column: 0, rowSpan: rows, columnSpan: columns };
  let { row, column, rowSpan = 1, columnSpan = 1 } = range;
  if (row + rowSpan > rows || column + columnSpan > columns) {
    throw new ChangeConflict(`the range runs past the table's ${rows} rows and ${columns} columns`);
  }
  let touched = (cell: Cell) =>
    overlaps(cell, "row", row, row + rowSpan) && overlaps(cell, "column", column, column + columnSpan);
  let cut = cellsOf(table).find(cell => touched(cell) &&
    !(within(cell, "row", row, row + rowSpan) && within(cell, "column", column, column + columnSpan)));
  if (cut) throw new ChangeConflict(`the range cuts through the merged cell at ${cellName(cut)}`);
  let properties = {
    ...(fill !== undefined ? { tableCellBackgroundFill: restFillOf(fill) } : {}),
    ...(contentAlignment !== undefined ? { contentAlignment: contentAlignment.toUpperCase() } : {}),
  };
  for (let cell of cellsOf(table)) {
    if (touched(cell)) cell.tableCellProperties = { ...cell.tableCellProperties, ...properties };
  }
  return {
    requests: [{
      updateTableCellProperties: {
        objectId: elementId,
        tableRange: { location: { rowIndex: row, columnIndex: column }, rowSpan, columnSpan },
        tableCellProperties: properties,
        fields: Object.keys(properties).join(","),
      },
    }],
  };
}
