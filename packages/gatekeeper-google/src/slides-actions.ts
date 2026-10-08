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
} from "@gadgets/gatekeeper-kit/actions";
import {
  buildDescription, codeSpan, plainInline, sanitizeTitle,
} from "@gadgets/gatekeeper-kit/action-description";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import { SlidesWriteRefused, type GoogleSlidesApi, type RestSlide } from "./slides-api";
import { designDeck, type DesignChange, type DesignStep } from "./slides-design";
import { CREATES } from "./slides-design-input";
import { slideIds } from "./slides-model";
import type { SlideBounds } from "./slides-read-types";
import {
  editDeck, movedOrder, requireNewSlide, type Deck, type SlideLabel, type SlidesActions,
  type TextEditRecord,
} from "./slides-simulation";
import { elementIdsOf, textOfTarget, type TextAddress } from "./slides-target";
import { ChangeConflict } from "./slides-text";
import type { ShapeOutline, TextFormatChange } from "./slides-types";

/** What an approved change is written with. */
export type SlidesHost = { api: GoogleSlidesApi; presentationId: string };

// Text edits, the one kind of Slides change a user may let apply without asking.
const EDIT_SLIDES_TEXT: ActionKind = { tag: "editSlidesText", label: "Slide text edits" };

// Planning against a fresh read, and resending a batch whose response was lost.
const MAX_ATTEMPTS = 3;

/** A fresh read: the revision to pin a write to, the slide order, and the slides it fetched. */
type Fresh = Deck & { revisionId: string };

type Plan = {
  requests: unknown[];
  /** Whether a read taken after a lost response shows the write landed. */
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
  let pages = await Promise.all(ids.filter(id => order.includes(id))
    .map(id => host.api.getSlide(host.presentationId, id)));
  return {
    revisionId, order,
    slides: new Map(pages.map(page => [page.objectId!, page] as [string, RestSlide])),
  };
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
  } catch {
    landed = false;
  }
  if (!landed) throw new ActionOutcomeUnknownError(APPLY_OUTCOME_UNKNOWN_MESSAGE);
}

function quietly(check: () => boolean): boolean {
  try {
    return check();
  } catch (error) {
    if (error instanceof ChangeConflict) return false;
    throw error;
  }
}

function slideName({ number, title }: SlideLabel): string {
  return title ? `slide ${number} ("${plainInline(title, 60)}")` : `slide ${number}`;
}

/** Names an element: by its ID, as a `noun`, unless the batch describing it creates it. */
type ElementName = (id: string, noun?: string) => string;

const byId: ElementName = (id, noun = "element") => `${noun} ${codeSpan(id)}`;

function targetName(edit: TextEditRecord): string {
  if (edit.elementId === undefined) return `the speaker notes of ${slideName(edit.slide)}`;
  return `${addressName(edit, byId)} on ${slideName(edit.slide)}`;
}

function addressName(address: TextAddress, element: ElementName): string {
  if (address.elementId === undefined) return "the speaker notes";
  if (!address.cell) return element(address.elementId, "shape");
  let { row, column } = address.cell;
  return `row ${row + 1}, column ${column + 1} of ${element(address.elementId, "table")}`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
  valued(format.fontFamily, "font", () => "the font below");
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

const idsOn = (deck: Deck, slideId: string) => new Set(elementIdsOf(slideOf(deck, slideId).pageElements));

/**
 * Whether a read taken after a lost response shows a design batch landed. Only what the batch
 * would have changed counts: an element it created that survives it, an element it deleted that
 * was there before it, and text it left reading differently. A batch with none of those, such as
 * one that only formats or moves elements, cannot be shown to have landed.
 */
function designLanded(
  changes: readonly DesignChange[], steps: readonly (DesignStep | null)[],
  before: Deck, planned: Deck, after: Deck,
): boolean {
  let checks = changes.flatMap((change, i) => {
    let { created, deleted } = steps[i]!;
    let ids = idsOn(after, change.slideId);
    let evidence: boolean[] = [];
    if (created && idsOn(planned, change.slideId).has(created)) evidence.push(ids.has(created));
    if (deleted && idsOn(before, change.slideId).has(deleted)) evidence.push(!ids.has(deleted));
    if (change.op === "editText") {
      let text = textIfThere(slideOf(planned, change.slideId), change);
      if (text !== undefined && text !== textIfThere(slideOf(before, change.slideId), change)) {
        evidence.push(textIfThere(slideOf(after, change.slideId), change) === text);
      }
    }
    return evidence;
  });
  return checks.length > 0 && checks.every(Boolean);
}

/** The Slides change set, bound once per presentation's journal. */
export const SLIDES_ACTIONS = defineActions<SlidesHost, SlidesActions>({
  editText: {
    kind: EDIT_SLIDES_TEXT,
    autoApprovable: true,
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: ({ edits }) => {
      let builder = buildDescription(edits.length === 1
        ? `Edits the text of ${targetName(edits[0])}.`
        : `Makes ${edits.length} text edits, all or none of which are applied:\n\n` +
          edits.map((edit, i) => `${i + 1}. ${capitalized(targetName(edit))}`).join("\n"));
      edits.forEach((edit, i) => {
        let label = edits.length === 1 ? "" : `Edit ${i + 1}: `;
        if (edit.find === undefined) {
          builder.verbatim(`${label}Current text`, edit.before ?? "");
          builder.verbatim(`${label}New text`, edit.replace);
        } else {
          builder.verbatim(`${label}Find`, edit.find);
          builder.verbatim(`${label}Replace with`, edit.replace);
        }
      });
      return {
        title: sanitizeTitle(edits.length === 1
          ? `Edit text on ${slideName(edits[0].slide)}`
          : `Edit text in ${edits.length} places`),
        ...builder.finish(),
        implementsRevert: false,
      };
    },
    apply: ({ edits }, host) => write(host, [...new Set(edits.map(edit => edit.slideId))], fresh => {
      let { deck, placements } = editDeck(fresh, edits);
      return {
        requests: placements.flatMap(placement => placement!.requests),
        landed: after => quietly(() => edits.every(edit =>
          textOfTarget(after.slides.get(edit.slideId) ?? {}, edit) ===
            textOfTarget(deck.slides.get(edit.slideId)!, edit))),
      };
    }),
  },

  updateSlides: {
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
        landed: after => quietly(() => designLanded(changes, steps, fresh, deck, after)),
      };
    }),
  },

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
        landed: later => quietly(() =>
          movedOrder(later.order, ids, after).every((id, i) => later.order[i] === id)),
      };
    }),
  },
}, { fence: "none", vendorId: "google" });
