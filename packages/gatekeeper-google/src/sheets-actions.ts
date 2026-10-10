/**
 * Approval-backed Google Sheets changes: how each is described, and how an approved one is written.
 *
 * Sheets has no revision to pin a write to, so a write is guarded instead. Apply reads the
 * spreadsheet afresh, plans the batch against it, and checks a digest of what the batch overwrites
 * (the cells it writes as entered, and the title and size of each sheet it writes to) against the
 * one taken when it was queued, of those cells as they were to be by then: with what the changes
 * queued before it enter, which must therefore have been applied. A change that no longer applies,
 * or whose cells a collaborator has edited, fails without writing. The guard leaves a window: a
 * collaborator's edit landing between that read and the write is overwritten.
 *
 * Every write is one atomic `batchUpdate`, which also creates a marker, a developer metadata
 * entry with an ID and token minted when the change was queued. Google refuses a second entry with
 * the same ID, so a batch carrying it commits at most once, and finding the marker proves the
 * batch landed. A batch whose response was lost is looked for by its marker, guarded again, and
 * resent only exactly as first sent. Once a send's outcome is unknown, the change either is found
 * to have landed or is recorded as unknown, and is never planned again.
 *
 * Markers cost no write of their own: each batch deletes those of earlier batches, so the latest
 * one lingers, visible only to this app's Google Cloud project, until the next change applies. A
 * batch's own marker is recorded before it is sent, so one whose activation dies mid-apply is
 * deleted too.
 */

import {
  ActionApplyError, ActionOutcomeUnknownError, APPLY_OUTCOME_UNKNOWN_MESSAGE, defineActions,
  type ActionDefinition,
} from "@gadgets/gatekeeper-kit/actions";
import {
  buildDescription, plainInline, sanitizeTitle,
} from "@gadgets/gatekeeper-kit/action-description";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import { obsContext } from "./observability";
import { SheetsWriteRefused, type GoogleSheetsApi } from "./sheets-api";
import { cellName, isFormula, rectName } from "./sheets-model";
import { guardDigest, planSheet } from "./sheets-plan";
import type { PlannedChange, SheetBatch, SheetsActions } from "./sheets-simulation";
import type { SheetCellInput } from "./sheets-types";
import { ChangeConflict } from "./slides-text";

const logger = obsContext.createLogger({ component: "gatekeeper.google.sheets", vendorId: "google" });

/** What an approved change is written with, and where the markers it leaves are kept. */
export type SheetsHost = {
  api: GoogleSheetsApi;
  spreadsheetId: string;
  /** Whether the change with this action ID was applied. */
  applied(id: number): boolean;
  /** IDs of markers earlier batches left, which the next batch deletes. */
  markers: { read(): number[]; write(ids: number[]): void };
};

// What a user may let apply without asking: a batch that only enters literal values and clears
// cells. A formula can compute anything from the spreadsheet, so any batch with one needs approval.
const EDIT_SHEET_VALUES: ActionKind = { tag: "editSheetValues", label: "Sheet value edits" };

/** The kind a batch is queued as, so approving a kind approves no more than it says. */
export function batchKind(
  changes: readonly ({ op: "writeCells"; values: SheetCellInput[][] } | { op: "clearRange" })[],
): "editSheetValues" | "updateSheet" {
  let literal = changes.every(change =>
    change.op === "clearRange" || change.values.every(row => !row.some(isFormula)));
  return literal ? "editSheetValues" : "updateSheet";
}

// Sending a batch: the first send, and resends once an answer was lost.
const MAX_ATTEMPTS = 3;
const MARKER_KEY = "gadgets.write";

function sheetName(sheets: Record<string, string>, sheetId: number): string {
  let title = sheets[sheetId];
  return title === undefined ? `sheet ${sheetId}` : `"${plainInline(title, 60)}"`;
}

// Characters a title can hold that do not show, or show as something else, in prose: everything
// but letters, marks, digits, punctuation, symbols and the plain space, and the quotes around it.
const UNCLEAR_IN_PROSE = /[^\p{L}\p{M}\p{N}\p{P}\p{S} ]|"/u;

// The title of a change's sheet when `sheetName` cannot show it exactly. Titles are how an
// approver tells sheets apart, and "Sheet_1" would otherwise read as Google's default "Sheet1",
// or "Sales" followed by a zero-width space as "Sales".
function inexactTitle(sheets: Record<string, string>, sheetId: number): string | undefined {
  let title = sheets[sheetId];
  return title !== undefined && (plainInline(title, 60) !== title || UNCLEAR_IN_PROSE.test(title))
    ? title : undefined;
}

// A line separator other than \n, which a viewer may break a line at though the kit keeps it.
const SEPARATOR = /[\u2028\u2029]/g;

// JSON, with the line separators JSON leaves as they are escaped, so the text stays on one line.
function oneLine(value: unknown): string {
  return JSON.stringify(value).replace(SEPARATOR, c => `\\u${c.charCodeAt(0).toString(16)}`);
}

/**
 * The batch's requests, planned against a fresh read, if what it overwrites is as it was when it
 * was queued. Throws `ChangeConflict` for a change that no longer applies.
 */
async function guarded(host: SheetsHost, batch: SheetBatch): Promise<unknown[] | undefined> {
  let unapplied = batch.guard.after.find(id => !host.applied(id));
  if (unapplied !== undefined) {
    throw new ChangeConflict(`it overwrites cells change ${unapplied} writes, which was not applied`);
  }
  let metadata = await host.api.getMetadata(host.spreadsheetId);
  let { requests } = planSheet({ sheets: metadata.sheets, cells: new Map() }, batch.changes);
  let entered = await host.api.readEntered(
    host.spreadsheetId, batch.changes.map(({ sheetId, rect }) => ({ sheetId, rect })));
  let digest = await guardDigest(metadata.sheets, batch.changes, entered);
  return digest === batch.guard.sha256 ? requests : undefined;
}

// Whether the spreadsheet holds this batch's marker. A failed lookup counts as not yet.
async function markerFound(host: SheetsHost, { id, token }: SheetBatch["marker"]): Promise<boolean> {
  try {
    return (await host.api.getDeveloperMetadata(host.spreadsheetId, id))?.metadataValue === token;
  } catch (error) {
    logger.warn("could not look up a Sheets write marker", { event: "sheets.apply.marker.failed", error });
    return false;
  }
}

/** Writes `batch`, as the module comment describes. */
async function write(host: SheetsHost, batch: SheetBatch): Promise<void> {
  let requests: unknown[] | undefined;
  try {
    requests = await guarded(host, batch);
  } catch (error) {
    if (error instanceof ChangeConflict) {
      throw new ActionApplyError(`This change no longer applies: ${error.message}.`);
    }
    throw error;
  }
  if (!requests) {
    throw new ActionApplyError(
      "This change no longer applies: cells it overwrites, or a sheet it writes to, changed since " +
      "it was queued.");
  }

  let { marker } = batch;
  let stale = host.markers.read().filter(id => id !== marker.id);
  let sent = [
    {
      createDeveloperMetadata: {
        developerMetadata: {
          metadataId: marker.id, metadataKey: MARKER_KEY, metadataValue: marker.token,
          location: { spreadsheet: true }, visibility: "PROJECT",
        },
      },
    },
    // Deleting a marker that is already gone succeeds, and changes nothing.
    ...stale.map(metadataId => ({
      deleteDeveloperMetadata: { dataFilter: { developerMetadataLookup: { metadataId } } },
    })),
    ...requests,
  ];
  // Recorded before the first send, so the marker is deleted by a later batch whatever becomes of
  // this one; deleting one never created changes nothing.
  host.markers.write([...host.markers.read().filter(id => id !== marker.id), marker.id]);
  let landed = () => host.markers.write(host.markers.read().filter(id => !stale.includes(id)));

  try {
    await host.api.batchUpdate(host.spreadsheetId, sent);
    return landed();
  } catch (error) {
    if (error instanceof SheetsWriteRefused) {
      // Nothing was applied. A 401, 403 or 429 may pass, so the action stays pending.
      if (error.status !== 400) throw error;
      if (await markerFound(host, marker)) return landed();
      throw new ActionApplyError(
        "Google Sheets refused this change as invalid [http=400]. It may write to a protected range " +
        "or outside a sheet's grid.");
    }
    logger.warn("Sheets write outcome unknown", { event: "sheets.apply.lost", error });
  }

  // The batch may have been committed, or may still be. Only it is ever sent again: Google commits
  // its marker, and so the batch, at most once.
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    if (await markerFound(host, marker)) return landed();
    // A collaborator's edit since the first read means the batch can no longer be resent, though
    // it may still land.
    let unchanged = await guarded(host, batch).then(Boolean, () => false);
    if (!unchanged) break;
    try {
      await host.api.batchUpdate(host.spreadsheetId, sent);
      return landed();
    } catch (error) {
      // Refused, perhaps because the first send has committed its marker since.
      if (error instanceof SheetsWriteRefused) break;
      logger.warn("Sheets write resend outcome unknown", { event: "sheets.apply.lost", error });
    }
  }
  if (await markerFound(host, marker)) return landed();
  throw new ActionOutcomeUnknownError(APPLY_OUTCOME_UNKNOWN_MESSAGE);
}

type Field = (label: string, text: string, kind: "inline" | "verbatim") => void;

/** One line naming what a change does; `field` adds what the approver must see exactly. */
function describeChange(change: PlannedChange, sheets: Record<string, string>, field: Field): string {
  let where = `In ${sheetName(sheets, change.sheetId)}`;
  let title = inexactTitle(sheets, change.sheetId);
  if (title !== undefined) field("Sheet", title, "inline");
  let cells = rectName(change.rect);
  if (change.op === "clearRange") return `${where}, clear the contents of ${cells}, keeping their formatting`;
  field("Values", change.values.map(oneLine).join("\n"), "verbatim");
  // One formula per line: one with a line break of its own is quoted, so it cannot pass for others.
  let formulas = change.values.flatMap((row, r) => row.flatMap((value, c) => isFormula(value)
    ? [`${cellName(change.rect.startRow + r, change.rect.startColumn + c)}: ` +
      (/[\r\n\u2028\u2029]/.test(value) ? oneLine(value) : value)]
    : []));
  if (formulas.length > 0) field("Formulas", formulas.join("\n"), "verbatim");
  return `${where}, set ${cells} to the values below`;
}

/** A batch's definition, the same for each kind but in the `kind` a user may auto-approve. */
function sheetBatch(kind?: ActionKind): ActionDefinition<SheetBatch, SheetsHost> {
  return {
    ...(kind ? { kind, autoApprovable: true } : {}),
    delivery: "continue-with-simulation",
    claimBeforeApply: true,
    describe: ({ changes, sheets }) => {
      let ids = [...new Set(changes.map(change => change.sheetId))];
      let fields: [string, string, "inline" | "verbatim"][] = [];
      let lines = changes.map((change, i) => {
        let label = changes.length === 1 ? "" : `Change ${i + 1}: `;
        return describeChange(change, sheets, (name, text, shape) => fields.push([`${label}${name}`, text, shape]));
      });
      let builder = buildDescription(lines.length === 1
        ? `${lines[0]}.`
        : `Makes ${lines.length} changes, all or none of which are applied:\n\n` +
          lines.map((line, i) => `${i + 1}. ${line}`).join("\n"));
      for (let [label, text, shape] of fields) builder[shape](label, text);
      return {
        title: sanitizeTitle(ids.length === 1 ? `Edit ${sheetName(sheets, ids[0])}` : `Edit ${ids.length} sheets`),
        ...builder.finish(),
        implementsRevert: false,
      };
    },
    apply: (batch, host) => write(host, batch),
  };
}

/** The Sheets change set, bound once per spreadsheet's journal. */
export const SHEETS_ACTIONS = defineActions<SheetsHost, SheetsActions>({
  editSheetValues: sheetBatch(EDIT_SHEET_VALUES),
  updateSheet: sheetBatch(),
}, { fence: "none", vendorId: "google" });
