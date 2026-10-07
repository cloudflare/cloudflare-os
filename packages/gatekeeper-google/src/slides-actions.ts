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
import { slideIds } from "./slides-model";
import {
  editDeck, elementIdsOf, movedOrder, requireNewSlide, textOfTarget, type Deck, type SlideLabel,
  type SlidesActions, type TextEditRecord,
} from "./slides-simulation";
import { ChangeConflict, replaceRequests } from "./slides-text";

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
    revisionId, order, complete: true,
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

function targetName(edit: TextEditRecord): string {
  if (edit.elementId === undefined) return `the speaker notes of ${slideName(edit.slide)}`;
  let element = codeSpan(edit.elementId);
  let where = edit.cell
    ? `row ${edit.cell.row + 1}, column ${edit.cell.column + 1} of table ${element}`
    : `shape ${element}`;
  return `${where} on ${slideName(edit.slide)}`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
        requests: placements.flatMap(placement =>
          replaceRequests(placement!.location, placement!.range, placement!.inserted)),
        landed: after => quietly(() => edits.every(edit =>
          textOfTarget(after.slides.get(edit.slideId) ?? {}, edit) ===
            textOfTarget(deck.slides.get(edit.slideId)!, edit))),
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
