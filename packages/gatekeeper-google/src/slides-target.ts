/**
 * What a queued Google Slides change addresses on a slide: an element, wherever it is nested, and
 * the text of a shape, a table cell, or the speaker notes, with the text edit that rewrites it.
 */

import type { RestPageElement, RestSlide, RestText, RestTextStyle } from "./slides-api";
import {
  ChangeConflict, changeRange, narrowChange, projectedText, providerRange, replaceRequests,
  restTextOf, richTextOf, spliceText, type IndexRange, type TextLocation,
} from "./slides-text";
import type { SlideTextEdit } from "./slides-types";

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

/** The text of a shape, a table cell, or, with no element, a slide's speaker notes. */
export type TextAddress = Pick<SlideTextEdit, "slideId" | "elementId" | "cell">;

/** A text edit as queued: replacing all of the text, it carries what that text was then. */
export type TextEdit = SlideTextEdit & { before?: string };

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

/** The text `address` names on `slide`. Throws `ChangeConflict` when it is not there. */
export function textSlot(slide: RestSlide, address: TextAddress): TextSlot {
  let { elementId, cell } = address;
  if (elementId === undefined) {
    let notes = slide.slideProperties?.notesPage;
    let id = notes?.notesProperties?.speakerNotesObjectId;
    if (!notes || !id) throw new ChangeConflict("the slide has no speaker notes");
    // Absent until someone first writes notes; inserting text at its ID creates it.
    let shape = notes.pageElements?.find(element => element.objectId === id)?.shape;
    let held = shape && shapeText(shape);
    return {
      location: { objectId: id },
      body: held?.body,
      write: text => {
        if (held) held.write(text);
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
  return { location: { objectId: elementId }, ...shapeText(shape) };
}

type Shape = NonNullable<RestPageElement["shape"]>;

/**
 * A shape's text, and how to put replayed text back. Google turns a shape's autofit off at the
 * first request that may change how its text fits, applying the scale it shrank the text by to
 * the font sizes the text sets, and its line spacing reduction to the line spacings its paragraphs
 * set. So the text is read as that leaves it, and is written back with the autofit off. Google
 * says nothing of sizes or spacings the text inherits, so those are left as they are.
 */
function shapeText(shape: Shape): Pick<TextSlot, "body" | "write"> {
  let fit = shape.shapeProperties?.autofit;
  let scale = fit?.fontScale ?? 1;
  let reduction = fit?.lineSpacingReduction ?? 0;
  if (scale === 1 && reduction === 0) return { body: shape.text, write: text => { shape.text = text; } };
  return {
    body: shape.text && unfitted(shape.text, scale, reduction),
    write: text => {
      shape.text = text;
      shape.shapeProperties = { ...shape.shapeProperties, autofit: { autofitType: "NONE" } };
    },
  };
}

function unfitted(body: RestText, scale: number, reduction: number): RestText {
  let sized = (style: RestTextStyle | undefined) => style?.fontSize?.magnitude
    ? { ...style, fontSize: { ...style.fontSize, magnitude: style.fontSize.magnitude * scale } }
    : style;
  return {
    ...body,
    textElements: body.textElements?.map(element => {
      let { textRun, autoText, paragraphMarker } = element;
      if (textRun) return { ...element, textRun: { ...textRun, style: sized(textRun.style) } };
      if (autoText) return { ...element, autoText: { ...autoText, style: sized(autoText.style) } };
      if (!paragraphMarker) return element;
      let { style, bullet } = paragraphMarker;
      return {
        ...element,
        paragraphMarker: {
          style: style?.lineSpacing ? { ...style, lineSpacing: style.lineSpacing - reduction } : style,
          bullet: bullet && { ...bullet, bulletStyle: sized(bullet.bulletStyle) },
        },
      };
    }),
  };
}

/** Applies one edit to `slide` in place, returning where it landed. Throws `ChangeConflict`. */
export function editSlide(slide: RestSlide, edit: TextEdit): EditPlacement {
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

/** The current text `address` names. Throws `ChangeConflict` when it is not there. */
export function textOfTarget(slide: RestSlide, address: TextAddress): string {
  return projectedText(richTextOf(textSlot(slide, address).body).segments);
}
