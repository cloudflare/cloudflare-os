/**
 * Approval-backed Google Slides changes: how each is described, and how an approved one is written.
 *
 * Every write is one `batchUpdate`, planned against a fresh read and pinned to that read's
 * revision, so Google applies it only to the presentation it was planned against. A change that
 * no longer applies fails without writing. The one hard case is a write whose response was lost:
 * it may have been committed, so it is resent only exactly as first sent, at the same revision,
 * which Google can commit at most once. If that is refused, a read decides whether it landed, and
 * otherwise the outcome is unknown and never retried.
 */

import {
  ActionApplyError, ActionOutcomeUnknownError, APPLY_OUTCOME_UNKNOWN_MESSAGE, defineActions,
  type ActionDefinition,
} from "@gadgets/gatekeeper-kit/actions";
import {
  buildDescription, codeSpan, plainInline, sanitizeTitle,
} from "@gadgets/gatekeeper-kit/action-description";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import { obsContext } from "./observability";
import { SlidesWriteRefused, type GoogleSlidesApi, type RestSlide } from "./slides-api";
import { designDeck, type DesignChange, type DesignStep } from "./slides-design";
import { CREATES } from "./slides-design-input";
import { slideIds } from "./slides-model";
import type { SlideBounds } from "./slides-read-types";
import {
  movedOrder, requireNewSlide, type Deck, type DesignBatch, type SlideLabel, type SlidesActions,
} from "./slides-simulation";
import { elementIdsOf, locate, textOfTarget, type TextAddress } from "./slides-target";
import { ChangeConflict, projectedText, richTextOf } from "./slides-text";
import type { ShapeOutline, TextFormatChange } from "./slides-types";

const logger = obsContext.createLogger({ component: "gatekeeper.google.slides", vendorId: "google" });

/** What an approved change is written with. */
export type SlidesHost = { api: GoogleSlidesApi; presentationId: string };

// What a user may let apply without asking: a batch that only edits text, or one that only changes
// how existing text and elements look, in shapes and table cells alike. Setting a link or font does
// not count, since Google keeps the whole string, and anything that creates or deletes, changes a
// table's rows, columns or cell fills, or sets alt text needs approval.
const EDIT_SLIDES_TEXT: ActionKind = { tag: "editSlidesText", label: "Slide text edits" };
const FORMAT_SLIDES: ActionKind = { tag: "formatSlides", label: "Slide formatting and layout" };
const FORMATTING = new Set<DesignChange["op"]>([
  "formatText", "formatParagraphs", "updateShape", "setBounds", "arrange",
]);

/** The kind a batch is queued as, so approving a kind approves no more than it says. */
export function batchKind(changes: readonly DesignChange[]): "editText" | "formatSlides" | "updateSlides" {
  if (changes.every(change => change.op === "editText")) return "editText";
  let formats = changes.every(change => FORMATTING.has(change.op) &&
    !(change.op === "formatText" && (change.format.link || change.format.fontFamily)));
  return formats ? "formatSlides" : "updateSlides";
}

// Planning against a fresh read, and resending a batch whose response was lost.
const MAX_ATTEMPTS = 3;

/** A fresh read: the revision to pin a write to, the slide order, and the slides it fetched. */
type Fresh = Deck & { revisionId: string };

type Plan = {
  requests: unknown[];
  /** Whether a read taken after a lost response shows the write landed; a throw means it does not. */
  landed(after: Fresh): boolean;
};

async function readFresh(host: SlidesHost, ids: readonly string[]): Promise<Fresh> {
  let outline = await host.api.getOutline(host.presentationId);
  let { revisionId } = outline;
  if (!revisionId) {
    throw new ActionApplyError(
      "Google Slides did not report this presentation's revision, which it does only for an " +
      "account that can edit it.");
  }
  let order = slideIds(outline);
  // Read after the outline: a slide changed since then has also moved the revision this write is
  // pinned to, so Google refuses it rather than applying it against what changed.
  let slides = await host.api.getSlides(host.presentationId, ids, order);
  return { revisionId, order, slides };
}

function noLongerApplies(error: unknown): never {
  if (error instanceof ChangeConflict) {
    throw new ActionApplyError(`This change no longer applies: ${error.message}.`);
  }
  throw error;
}

/** Writes the plan for `ids`, as the module comment describes. */
async function write(
  host: SlidesHost, ids: readonly string[], plan: (fresh: Fresh) => Plan,
): Promise<void> {
  // Set once a dispatch's outcome is unknown; from then on only this batch is ever sent.
  let sent: (Plan & { revisionId: string }) | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let current = sent;
    if (!current) {
      let fresh = await readFresh(host, ids);
      let planned: Plan;
      try {
        planned = plan(fresh);
      } catch (error) {
        noLongerApplies(error);
      }
      if (planned.requests.length === 0) return;
      current = { ...planned, revisionId: fresh.revisionId };
    }
    try {
      await host.api.batchUpdate(host.presentationId, current.requests, current.revisionId);
      return;
    } catch (error) {
      if (!(error instanceof SlidesWriteRefused)) {
        sent = current;
        continue;
      }
      if (sent) break;
      // Nothing was applied. A 401, 403 or 429 may pass, so the action stays pending.
      if (error.status !== 400) throw error;
      let { revisionId } = await host.api.getOutline(host.presentationId);
      if (revisionId === current.revisionId) {
        throw new ActionApplyError("Google Slides refused this change as invalid [http=400].");
      }
      // A stale revision: someone edited the presentation since the read. Plan again.
    }
  }
  if (!sent) {
    throw new Error("The presentation kept changing while this change was applied. Try again.");
  }
  let landed: boolean;
  try {
    landed = sent.landed(await readFresh(host, ids));
  } catch (error) {
    // Unknown either way: the write may have landed, so it is never planned again.
    logger.warn("could not confirm a lost Slides write", { event: "slides.apply.confirm.failed", error });
    landed = false;
  }
  if (!landed) throw new ActionOutcomeUnknownError(APPLY_OUTCOME_UNKNOWN_MESSAGE);
}

function slideName({ number, title }: SlideLabel): string {
  return title ? `slide ${number} ("${plainInline(title, 60)}")` : `slide ${number}`;
}

/** Names an element: by its ID, as a `noun`, unless the batch describing it creates it. */
type ElementName = (id: string, noun?: string) => string;

const byId: ElementName = (id, noun = "element") => `${noun} ${codeSpan(id)}`;

function addressName(address: TextAddress, element: ElementName): string {
  if (address.elementId === undefined) return "the speaker notes";
  if (!address.cell) return element(address.elementId, "shape");
  let { row, column } = address.cell;
  return `row ${row + 1}, column ${column + 1} of ${element(address.elementId, "table")}`;
}

function boundsName({ x, y, width, height }: SlideBounds): string {
  return `${width} × ${height} pt at (${x}, ${y})`;
}

type Field = (label: string, text: string) => void;

// The formatting set, naming in a field what the approver must see verbatim.
function formatNames(format: TextFormatChange, field: Field): string[] {
  let names: string[] = [];
  for (let key of ["bold", "italic", "underline", "strikethrough", "smallCaps"] as const) {
    let value = format[key];
    let name = key === "smallCaps" ? "small caps" : key;
    if (value !== undefined) names.push(value === null ? `default ${name}` : value ? name : `not ${name}`);
  }
  let valued = (value: unknown, name: string, shown: (value: never) => string) => {
    if (value !== undefined) names.push(value === null ? `default ${name}` : shown(value as never));
  };
  if (format.fontFamily) field("Font", format.fontFamily);
  if (format.link) field("Link", format.link);
  // A font is set at regular weight, which unbolds the text unless the change makes it bold.
  valued(format.fontFamily, "font", () =>
    format.bold === undefined ? "the font below, not bold" : "the font below");
  valued(format.fontSize, "size", (size: number) => `${size} pt`);
  valued(format.color, "colour", (color: string) => `colour ${color}`);
  valued(format.highlight, "highlight", (color: string) => `highlight ${color}`);
  valued(format.link, "link", () => "linked to the URL below");
  valued(format.baseline, "baseline", (baseline: string) =>
    baseline === "none" ? "no superscript or subscript" : baseline);
  return names;
}

function fillName(fill: string): string {
  return fill === "none" ? "no fill" : `fill ${fill}`;
}

function outlineName(outline: ShapeOutline | "none"): string {
  if (outline === "none") return "no outline";
  return `an outline${outline.color ? ` ${outline.color}` : ""}` +
    `${outline.weight ? ` ${outline.weight} pt wide` : ""}`;
}

function paragraphNames(change: DesignChange & { op: "formatParagraphs" }): string[] {
  let names: string[] = [];
  let set = (value: unknown, unset: string, shown: () => string) => {
    if (value !== undefined) names.push(value === null ? unset : shown());
  };
  set(change.alignment, "default alignment", () => `aligned ${change.alignment}`);
  set(change.lineSpacing, "default line spacing", () => `line spacing ${change.lineSpacing}%`);
  set(change.spaceAbove, "default space above", () => `${change.spaceAbove} pt above`);
  set(change.spaceBelow, "default space below", () => `${change.spaceBelow} pt below`);
  if (change.bullets !== undefined) {
    let bullets = { bullet: "bulleted", checkbox: "a checklist", numbered: "numbered", none: "no bullets" };
    names.push(bullets[change.bullets]);
  }
  return names;
}

function lineCount(noun: string, at: number, count: number): string {
  return count === 1 ? `${noun} ${at + 1}` : `${noun}s ${at + 1} to ${at + count}`;
}

/** One line naming what a change does; `field` adds what the approver must see verbatim. */
function describeChange(
  change: DesignChange, element: ElementName, field: Field,
): string {
  switch (change.op) {
    case "editText":
      if (change.find === undefined) {
        field("Current text", change.before ?? "");
        field("New text", change.replace);
      } else {
        field("Find", change.find);
        field("Replace with", change.replace);
      }
      return `edit the text of ${addressName(change, element)}`;
    case "formatText":
    case "formatParagraphs": {
      let part = "all of the text";
      if (change.find !== undefined || change.range) {
        part = "the text below";
        field("Text", change.range
          ? (change.before ?? "").slice(change.range.start, change.range.end) : change.find!);
      }
      let target = `${part} of ${addressName(change, element)}`;
      if (change.op === "formatParagraphs") {
        return `format the paragraphs of ${target}: ${paragraphNames(change).join(", ")}`;
      }
      return `format ${target}: ${formatNames(change.format, field).join(", ")}`;
    }
    case "createShape": {
      if (change.text) field("Text", change.text);
      let extras = [
        ...(change.text ? ["the text below"] : []),
        ...(change.format ? [formatNames(change.format, field).join(", ")] : []),
        ...(change.fill !== undefined ? [fillName(change.fill)] : []),
        ...(change.outline !== undefined ? [outlineName(change.outline)] : []),
      ];
      return `add a ${change.shapeType} shape, ${boundsName(change.bounds)}` +
        (extras.length > 0 ? `, with ${extras.join("; ")}` : "");
    }
    case "updateShape": {
      let names = [
        ...(change.fill !== undefined ? [fillName(change.fill)] : []),
        ...(change.outline !== undefined ? [outlineName(change.outline)] : []),
        ...(change.contentAlignment !== undefined ? [`text at the ${change.contentAlignment}`] : []),
      ];
      return `give ${element(change.elementId, "shape")} ${names.join(", ")}`;
    }
    case "setBounds": {
      let names = (["x", "y", "width", "height"] as const)
        .flatMap(key => change.bounds?.[key] === undefined ? [] : [`${key} ${change.bounds[key]}`]);
      if (change.rotation !== undefined) names.push(`rotation ${change.rotation}°`);
      return `move or resize ${element(change.elementId)} to ${names.join(", ")}`;
    }
    case "deleteElement":
      return `delete ${element(change.elementId)}`;
    case "setAltText":
      if (change.title !== undefined) field("Alt-text title", change.title);
      if (change.description !== undefined) field("Alt-text description", change.description);
      return `set the alt text of ${element(change.elementId)}`;
    case "arrange":
      return change.to === "front"
        ? `bring ${element(change.elementId)} in front of the other elements`
        : `send ${element(change.elementId)} behind the other elements`;
    case "insertImage":
      field("Image URL", change.url);
      return "add an image downloaded from the URL below, " +
        (change.bounds ? `fitted in ${boundsName(change.bounds)}` : "at its own size");
    case "replaceImage":
      field("Image URL", change.url);
      return `replace the picture of ${element(change.elementId, "image")} with one downloaded ` +
        "from the URL below";
    case "createTable":
      if (change.cells?.some(line => line.some(Boolean))) field("Cells", JSON.stringify(change.cells));
      return `add a table of ${change.rows} rows and ${change.columns} columns` +
        (change.bounds ? `, ${boundsName(change.bounds)}` : "");
    case "insertTableRows":
    case "insertTableColumns": {
      let noun = change.op === "insertTableRows" ? "row" : "column";
      let count = change.count ?? 1;
      return `insert ${count} ${noun}${count === 1 ? "" : "s"} before ${noun} ${change.at + 1} of ` +
        element(change.elementId, "table");
    }
    case "deleteTableRows":
    case "deleteTableColumns": {
      let noun = change.op === "deleteTableRows" ? "row" : "column";
      let lines = lineCount(noun, change.at, change.count ?? 1);
      return `delete ${lines} of ${element(change.elementId, "table")}`;
    }
    case "formatTableCells": {
      let { range } = change;
      let cells = range
        ? `the cells from row ${range.row + 1}, column ${range.column + 1}, ` +
          `${range.rowSpan ?? 1} by ${range.columnSpan ?? 1}`
        : "every cell";
      let names = [
        ...(change.fill !== undefined ? [fillName(change.fill)] : []),
        ...(change.contentAlignment !== undefined ? [`text at the ${change.contentAlignment}`] : []),
      ];
      return `give ${cells} of ${element(change.elementId, "table")} ${names.join(", ")}`;
    }
  }
}

// One line per change, and the fields to show verbatim after them.
function describeDesign(
  changes: DesignChange[], slides: Record<string, SlideLabel>,
): { lines: string[]; fields: [label: string, text: string][] } {
  let created = new Map<string, string>();
  let fields: [string, string][] = [];
  let element: ElementName = (id, noun) => created.get(id) ?? byId(id, noun);
  let lines = changes.map((change, i) => {
    let label = changes.length === 1 ? "" : `Change ${i + 1}: `;
    let line = describeChange(change, element, (name, text) => fields.push([`${label}${name}`, text]));
    let noun = CREATES[change.op];
    if (noun && "id" in change) created.set(change.id, `the ${noun} change ${i + 1} adds`);
    return `On ${slideName(slides[change.slideId])}, ${line}`;
  });
  return { lines, fields };
}

// The text `address` names, or undefined if it is not there.
function textIfThere(slide: RestSlide, address: TextAddress): string | undefined {
  try {
    return textOfTarget(slide, address);
  } catch (error) {
    if (error instanceof ChangeConflict) return undefined;
    throw error;
  }
}

const slideOf = (deck: Deck, slideId: string): RestSlide => deck.slides.get(slideId) ?? {};

/** Rows or columns a change inserts or deletes. */
type TableLines = { elementId: string; axis: "row" | "column"; insert: boolean; at: number; count: number };

function tableLinesOf(change: DesignChange): TableLines | undefined {
  switch (change.op) {
    case "insertTableRows": case "insertTableColumns": case "deleteTableRows": case "deleteTableColumns": {
      let { op, elementId, at, count = 1 } = change;
      return { elementId, at, count, axis: op.endsWith("Rows") ? "row" : "column", insert: op.startsWith("insert") };
    }
  }
  return undefined;
}

/**
 * Where the text `address` names is once `later` changes have inserted and deleted rows and
 * columns of its table, or undefined if they delete its cell.
 */
function addressAfter(address: TextAddress, later: readonly DesignChange[]): TextAddress | undefined {
  let { cell } = address;
  if (!cell) return address;
  for (let change of later) {
    let lines = tableLinesOf(change);
    if (!lines || lines.elementId !== address.elementId) continue;
    let { axis, insert, at, count } = lines;
    let index: number = cell[axis];
    if (insert) {
      if (at <= index) index += count;
    } else if (at + count <= index) {
      index -= count;
    } else if (at <= index) {
      return undefined;
    }
    cell = { ...cell, [axis]: index };
  }
  return { ...address, cell };
}

/**
 * A table's size and cells, row by row: where each starts, its spans and its text, or undefined
 * if the slide has no table `id`. Neither its size nor its cells' text alone tells it from a table
 * a collaborator changed some other way, such as by merging cells.
 */
function cellsOf(slide: RestSlide, id: string): string | undefined {
  let table = locate(slide.pageElements, id)?.element.table;
  // Google omits a zero index, and a span of 1 may be omitted too.
  return table && JSON.stringify([table.rows ?? 0, table.columns ?? 0, table.tableRows?.map(row =>
    row.tableCells?.map(cell => [
      cell.location?.rowIndex ?? 0, cell.location?.columnIndex ?? 0, cell.rowSpan ?? 1,
      cell.columnSpan ?? 1, projectedText(richTextOf(cell.text).segments),
    ]))]);
}

/**
 * Whether a read taken after a lost response shows a design batch landed. Only what the batch
 * would have changed counts, where it would leave it: which elements exist, the cells of a table
 * it adds or deletes rows or columns of, and text, found where later changes to its table move it.
 * A batch with none of those, such as one that only formats or moves elements, cannot be shown
 * to have landed.
 */
function designLanded(
  changes: readonly DesignChange[], steps: readonly (DesignStep | null)[],
  before: Deck, planned: Deck, after: Deck,
): boolean {
  let checks = changes.flatMap((change, i) => {
    let evidence: boolean[] = [];
    let witness = <T>(read: (slide: RestSlide) => T | undefined) => {
      let value = read(slideOf(planned, change.slideId));
      if (value !== undefined && value !== read(slideOf(before, change.slideId))) {
        evidence.push(read(slideOf(after, change.slideId)) === value);
      }
    };
    let { created, deleted } = steps[i]!;
    for (let id of [created, deleted]) {
      if (id) witness(slide => locate(slide.pageElements, id) !== undefined);
    }
    const moved = change.op === "editText" && addressAfter(change, changes.slice(i + 1));
    if (moved) witness(slide => textIfThere(slide, moved));
    const lines = tableLinesOf(change);
    if (lines) witness(slide => cellsOf(slide, lines.elementId));
    return evidence;
  });
  return checks.length > 0 && checks.every(Boolean);
}

/** A design batch's definition, the same for each kind but in the `kind` a user may auto-approve. */
function designBatch(kind?: ActionKind): ActionDefinition<DesignBatch, SlidesHost> {
  return {
    ...(kind ? { kind, autoApprovable: true } : {}),
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: ({ changes, slides }) => {
      let ids = [...new Set(changes.map(change => change.slideId))];
      let { lines, fields } = describeDesign(changes, slides);
      let builder = buildDescription(lines.length === 1
        ? `${lines[0]}.`
        : `Makes ${lines.length} changes, all or none of which are applied:\n\n` +
          lines.map((line, i) => `${i + 1}. ${line}`).join("\n"));
      for (let [label, text] of fields) builder.verbatim(label, text);
      return {
        title: sanitizeTitle(ids.length === 1
          ? `Change ${slideName(slides[ids[0]])}`
          : `Change ${ids.length} slides`),
        ...builder.finish(),
        implementsRevert: false,
      };
    },
    apply: ({ changes }, host) => write(host, [...new Set(changes.map(change => change.slideId))], fresh => {
      let { deck, steps } = designDeck(fresh, changes);
      return {
        requests: steps.flatMap(step => step!.requests),
        landed: after => designLanded(changes, steps, fresh, deck, after),
      };
    }),
  };
}

/** The Slides change set, bound once per presentation's journal. */
export const SLIDES_ACTIONS = defineActions<SlidesHost, SlidesActions>({
  editText: designBatch(EDIT_SLIDES_TEXT),
  formatSlides: designBatch(FORMAT_SLIDES),
  updateSlides: designBatch(),

  duplicateSlide: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: ({ slide }) => ({
      title: sanitizeTitle(`Duplicate ${slideName(slide)}`),
      description: `Adds a copy of ${slideName(slide)}, with its speaker notes, right after it.`,
      descriptionIsComplete: true,
      implementsRevert: false,
    }),
    apply: ({ slideId, newSlideId, objectIds }, host) => write(host, [slideId], fresh => {
      requireNewSlide(fresh.order, newSlideId);
      let source = fresh.slides.get(slideId);
      if (!source) throw new ChangeConflict(`slide "${slideId}" no longer exists`);
      // Google refuses a key naming no object, and the source may have lost elements since.
      let present = new Set(elementIdsOf(source.pageElements));
      let ids = Object.fromEntries(Object.entries(objectIds).filter(([id]) => present.has(id)));
      return {
        requests: [{ duplicateObject: { objectId: slideId, objectIds: { ...ids, [slideId]: newSlideId } } }],
        landed: after => after.order.includes(newSlideId),
      };
    }),
  },

  deleteSlide: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: ({ slide }) => ({
      title: sanitizeTitle(`Delete ${slideName(slide)}`),
      description: `Deletes ${slideName(slide)}, with its content and speaker notes.`,
      descriptionIsComplete: true,
      implementsRevert: false,
    }),
    apply: ({ slideId }, host) => write(host, [], fresh => {
      if (!fresh.order.includes(slideId)) throw new ChangeConflict(`slide "${slideId}" no longer exists`);
      return {
        requests: [{ deleteObject: { objectId: slideId } }],
        landed: after => !after.order.includes(slideId),
      };
    }),
  },

  moveSlides: {
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: ({ slides, afterSlide }) => {
      let names = slides.map(slideName).join(", ");
      let where = afterSlide ? `to follow ${slideName(afterSlide)}` : "to the start of the presentation";
      return {
        title: sanitizeTitle(slides.length === 1 ? `Move ${names}` : `Move ${slides.length} slides`),
        description: `Moves ${names} ${where}, keeping their order.`,
        descriptionIsComplete: true,
        implementsRevert: false,
      };
    },
    apply: ({ slideIds: ids, after }, host) => write(host, [], fresh => {
      let moved = movedOrder(fresh.order, ids, after);
      let unchanged = moved.every((id, i) => fresh.order[i] === id);
      let moving = new Set(ids);
      return {
        requests: unchanged ? [] : [{
          updateSlidesPosition: {
            // Google wants them in presentation order, and the index before the move.
            slideObjectIds: fresh.order.filter(id => moving.has(id)),
            insertionIndex: after === null ? 0 : fresh.order.indexOf(after) + 1,
          },
        }],
        landed: later => movedOrder(later.order, ids, after).every((id, i) => later.order[i] === id),
      };
    }),
  },
}, { fence: "none", vendorId: "google" });
