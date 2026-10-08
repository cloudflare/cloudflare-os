/**
 * What a queued Google Slides change addresses on a slide: an element, wherever it is nested, and
 * the text of a shape, a table cell, or the speaker notes, with the text edit that rewrites it.
 */

import type { RestPageElement, RestSlide, RestText } from "./slides-api";
import type { TextEditRecord } from "./slides-simulation";
import {
  ChangeConflict, changeRange, narrowChange, projectedText, providerRange, replaceRequests,
  restTextOf, richTextOf, spliceText, type IndexRange, type TextLocation,
} from "./slides-text";

/**
 * Where one edit landed: the provider range it replaces with `inserted`, the requests that do it,
 * and the text before and after it.
 */
export type EditPlacement = {
  range: IndexRange; inserted: string; requests: unknown[]; previous: string; text: string;
};

/** Where a shape's, cell's or notes' text is, and how to put replayed text back. */
export type TextSlot = {
  location: TextLocation; body: RestText | undefined; write(body: RestText): void;
};

/** An element, the list holding it, and the group that list belongs to, if any. */
export type Located = {
  element: RestPageElement; siblings: RestPageElement[]; group?: RestPageElement;
};

/** Finds the element `id` among `elements` or inside their groups. */
export function locate(
  elements: RestPageElement[] | undefined, id: string, group?: RestPageElement,
): Located | undefined {
  for (let element of elements ?? []) {
    if (element.objectId === id) {
      return { element, siblings: elements ?? [], ...(group ? { group } : {}) };
    }
    let found = locate(element.elementGroup?.children, id, element);
    if (found) return found;
  }
  return undefined;
}

/** Every element ID on a slide, groups' children included. */
export function elementIdsOf(elements: RestPageElement[] | undefined): string[] {
  return (elements ?? []).flatMap(element => [
    ...(element.objectId ? [element.objectId] : []),
    ...elementIdsOf(element.elementGroup?.children),
  ]);
}

/** Names an edit's target, for prefixing a conflict. */
export function editTarget(edit: Omit<TextEditRecord, "slide">): string {
  if (edit.elementId === undefined) return `the speaker notes of slide "${edit.slideId}"`;
  if (edit.cell) {
    return `row ${edit.cell.row}, column ${edit.cell.column} of table "${edit.elementId}"`;
  }
  return `element "${edit.elementId}"`;
}

/** The text `edit` addresses on `slide`. Throws `ChangeConflict` when it is not there. */
export function textSlot(slide: RestSlide, edit: Omit<TextEditRecord, "slide">): TextSlot {
  let { elementId, cell } = edit;
  if (elementId === undefined) {
    let notes = slide.slideProperties?.notesPage;
    let id = notes?.notesProperties?.speakerNotesObjectId;
    if (!notes || !id) throw new ChangeConflict("the slide has no speaker notes");
    // Absent until someone first writes notes; inserting text at its ID creates it.
    let shape = notes.pageElements?.find(element => element.objectId === id)?.shape;
    return {
      location: { objectId: id },
      body: shape?.text,
      write: text => {
        if (shape) shape.text = text;
        else (notes.pageElements ??= []).push({ objectId: id, shape: { shapeType: "TEXT_BOX", text } });
      },
    };
  }
  let element = locate(slide.pageElements, elementId)?.element;
  if (!element) throw new ChangeConflict(`the slide has no element "${elementId}"`);
  if (cell) {
    let table = element.table;
    if (!table) throw new ChangeConflict(`element "${elementId}" is not a table`);
    let found = table.tableRows?.flatMap(row => row.tableCells ?? []).find(candidate =>
      (candidate.location?.rowIndex ?? 0) === cell.row &&
      (candidate.location?.columnIndex ?? 0) === cell.column);
    if (!found) {
      throw new ChangeConflict(
        `table "${elementId}" has no cell starting at row ${cell.row}, column ${cell.column}`);
    }
    return {
      location: { objectId: elementId, cellLocation: { rowIndex: cell.row, columnIndex: cell.column } },
      body: found.text,
      write: text => { found.text = text; },
    };
  }
  if (element.table) throw new ChangeConflict(`element "${elementId}" is a table; give a cell`);
  let shape = element.shape;
  if (!shape) throw new ChangeConflict(`element "${elementId}" has no editable text`);
  return { location: { objectId: elementId }, body: shape.text, write: text => { shape.text = text; } };
}

/** Applies one edit to `slide` in place, returning where it landed. Throws `ChangeConflict`. */
export function editSlide(slide: RestSlide, edit: Omit<TextEditRecord, "slide">): EditPlacement {
  let slot = textSlot(slide, edit);
  let rich = richTextOf(slot.body);
  let previous = projectedText(rich.segments);
  let found = changeRange(previous, edit);
  let { start, end, text } = narrowChange(rich.segments, found.start, found.end, edit.replace);
  let range = providerRange(rich.segments, start, end);
  let edited = spliceText(rich, start, end, text);
  slot.write(restTextOf(edited));
  return {
    range, inserted: text, requests: replaceRequests(slot.location, rich, edited, start, end, text),
    previous, text: projectedText(edited.segments),
  };
}

/** The current text an edit addresses. Throws `ChangeConflict` when it is not there. */
export function textOfTarget(slide: RestSlide, edit: Omit<TextEditRecord, "slide">): string {
  return projectedText(richTextOf(textSlot(slide, edit).body).segments);
}
