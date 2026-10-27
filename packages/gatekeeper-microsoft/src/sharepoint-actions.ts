// Every change this gatekeeper can make, as the kit's action set: what each action stores, how the
// approver sees it, and how it is applied and reverted. Nothing here runs before approval; sessions
// stage actions, and the facet applies them when the user approves.
//
// Changes to existing objects carry a version fence. A replace or delete is applied only if the
// file's content is unchanged since the change was proposed (Graph accepts the content tag, `cTag`,
// in `If-Match`), so a colleague's edit in between is never overwritten or binned; a list item
// update is fenced on the item's eTag the same way. A rename or move is not fenced by default:
// it does not lose anyone's work.

import {
  ActionApplyError,
  ActionOutcomeUnknownError,
  defineActions,
  type ActionDefinition,
  type ActionPresentation,
  type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, plainInline, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import type { ActionFileReference } from "@gadgets/gatekeeper-kit/action-files";
import { diffTextLines, type GitDiffHunk } from "@gadgets/gatekeeper-kit/git-diff";
import type { ProvisionalIds } from "@gadgets/gatekeeper-kit/simulation";
import { isProvisional, realId } from "./binding";
import { GraphApiError, isOutcomeUnknown, type GraphApi } from "./graph-api";
import { ITEM_SELECT, parseDriveItem, parseListItem, parseVersion, parsePage } from "./graph-parse";
import { VENDOR_ID } from "./microsoft-env";
import { obsContext } from "./observability";
import { extensionOf } from "./sharepoint-content";
import { OutsideScopeError, decodeItemRef, encodeItemRef, type ItemRef, type ListRef } from "./sharepoint-scope";
import type { CellValue, FieldValue } from "./types";
import { columnIndex, columnLetters } from "./workbook-ranges";

/**
 * Text up to this size is shown to the approver in full; past it, by size and digest. It is also
 * what one action's texts may hold together: a journal record is one Durable Object value, capped
 * at 128 KiB.
 */
const MAX_SHOWN_TEXT_BYTES = 64 * 1024;

/** A file or folder an action changes, as it was read when the action was proposed. */
export type ItemTarget = {
  ref: ItemRef;
  name: string;
  kind: "file" | "folder";
  /** Where it is, for the approver: "Engineering › Documents › Specs". */
  location: string;
  /** Its path relative to the top of the binding, for simulated reads. */
  path: string;
  webUrl?: string;
};

/** The folder an action creates something in: a real one, or one an earlier pending action creates. */
export type FolderTarget = {
  /** An encoded item reference, or a temporary `~N`. */
  id: string;
  driveId: string;
  name: string;
  location: string;
  /** Its path relative to the top of the binding, for simulated reads. */
  path: string;
};

/** A list an action changes. */
export type ListTarget = ListRef & { name: string; webUrl?: string };

/** The Office format a file's content was written in from Markdown or rows, for the approver. */
export type WrittenAs = "word" | "powerpoint" | "excel";

/** How a written file was made, shown to the approver beside its source text. */
export type Writing = {
  as: WrittenAs;
  /** The name of the file whose look it took. */
  template?: string;
};

/** One paragraph or slide an in-place edit changed, as Markdown before and after. */
export type EditChange = { before?: string; after?: string; slide?: number; notes?: boolean };

/** What each kind of action stores. */
export type SharePointActions = {
  createFolder: { ref: string; parent: FolderTarget; name: string; submittedAt: number; createdId?: string; appliedAt?: number };
  uploadFile: {
    ref: string;
    parent: FolderTarget;
    name: string;
    file: ActionFileReference;
    mimeType: string;
    /** The content as text, when it is text short enough to show the approver in full: for a written file, its source. */
    text?: string;
    writing?: Writing;
    submittedAt: number;
    /** The content tag the file was left with: an undo deletes it only while it is still that content. */
    cTag?: string;
    createdId?: string;
    appliedAt?: number;
  };
  replaceFile: {
    target: ItemTarget;
    file: ActionFileReference;
    mimeType: string;
    text?: string;
    /** The text the file held when the change was proposed, for the approver's diff. */
    previousText?: string;
    writing?: Writing;
    /** What the file had that a rewrite from Markdown or rows can't keep: "3 images", "comments". */
    loses?: string[];
    /** For an in-place edit, what it changed, instead of the whole content. */
    edit?: { kind: "document" | "presentation"; changes: EditChange[]; trackChanges?: boolean; /** Changes past the record's size budget, counted. */ more?: number };
    /** The content version the change is based on; the apply is refused if it has moved. */
    ifMatch?: string;
    /** The version the replace superseded, recorded when applied: what a revert restores. */
    previousVersionId?: string;
    /** The content tag the write left: an undo restores the earlier version only over that content. */
    cTag?: string;
    submittedAt: number;
    appliedAt?: number;
  };
  rename: {
    target: ItemTarget;
    name: string;
    ifMatch?: string;
    /** The file's content tag once renamed: an undo across formats restores the old name only to that content. */
    cTag?: string;
    submittedAt: number;
    appliedAt?: number;
  };
  move: {
    target: ItemTarget;
    /** Where it was, which a revert moves it back to. */
    from: { id: string; location: string };
    to: FolderTarget;
    ifMatch?: string;
    submittedAt: number;
    appliedAt?: number;
  };
  deleteItem: { target: ItemTarget; ifMatch?: string; submittedAt: number; appliedAt?: number };
  createListItem: {
    ref: string;
    list: ListTarget;
    fields: Record<string, FieldValue>;
    /** Display names of the fields, for the approver. */
    labels: Record<string, string>;
    submittedAt: number;
    createdId?: string;
    /** The item's tag as created: its undo deletes it only while it is still that version. */
    createdETag?: string;
    appliedAt?: number;
  };
  updateListItem: {
    list: ListTarget;
    itemId: string;
    title?: string;
    fields: Record<string, FieldValue>;
    labels: Record<string, string>;
    /** The values these fields held when the change was proposed: what a revert writes back. */
    before: Record<string, FieldValue>;
    ifMatch?: string;
    /** The item's tag once changed: an undo writes the old values back only over that version. */
    appliedETag?: string;
    submittedAt: number;
    appliedAt?: number;
  };
  deleteListItem: { list: ListTarget; itemId: string; title?: string; ifMatch?: string; submittedAt: number; appliedAt?: number };
  updateCells: {
    target: ItemTarget;
    /** The worksheet's name, for the approver, and its ID, which the write addresses: a rename in between doesn't misdirect it. */
    worksheet: string;
    sheetId: string;
    /** The range on the worksheet, normalized: "B2:D4". */
    address: string;
    values: CellValue[][];
    /** The range's formulas (or values) when the change was proposed, for the approver. */
    before: CellValue[][];
    /**
     * The range's formulas as Excel holds them once written, which differ from `values` wherever it
     * read something into them (a date typed as text becomes its serial number, a formula is
     * uppercased, "50%" becomes 0.5): what an undo must still find there.
     */
    applied?: CellValue[][];
    ifMatch?: string;
    previousVersionId?: string;
    submittedAt: number;
    appliedAt?: number;
  };
  copyFile: {
    ref: string;
    source: ItemTarget;
    parent: FolderTarget;
    name: string;
    /** The source's size and type, for showing the copy while it waits. */
    size?: number;
    mimeType?: string;
    submittedAt: number;
    /** The content tag the file was left with: an undo deletes it only while it is still that content. */
    cTag?: string;
    createdId?: string;
    appliedAt?: number;
  };
};

/** One staged action, as the journal holds it. */
export type SharePointAction = TaggedAction<SharePointActions>;

/** What apply handlers may do. */
export type SharePointActionHost = {
  refs: ProvisionalIds<string>;
  /** Runs a write as the connection. Writes are not replayed on a credential refresh unless marked so. */
  graph<T>(op: (api: GraphApi) => Promise<T>, options?: { replayable?: boolean }): Promise<T>;
  /** Proves an item is inside the binding now. @throws OutsideScopeError when it is not, or is gone. */
  inScope(ref: ItemRef): Promise<void>;
  readFile(file: ActionFileReference): Promise<Uint8Array>;
  releaseFile(file: ActionFileReference): void;
  invalidate(): Promise<void>;
};

/** The real folder an action writes into, once any temporary ID it named has been created. */
function folderRef(host: SharePointActionHost, parent: FolderTarget): ItemRef {
  return decodeItemRef(realId(host.refs, parent.id, "The folder this goes in")) as ItemRef;
}

/**
 * Refuses, finally, an item that has left the binding since the change was proposed. A move
 * changes neither the content tag nor the eTag, so the version fence alone would let an approved
 * change land on a file someone has since moved out of a bound folder.
 */
async function requireInScope(host: SharePointActionHost, ref: ItemRef, what: string): Promise<void> {
  try {
    await host.inScope(ref);
  } catch (error) {
    if (!(error instanceof OutsideScopeError)) throw error;
    throw new ActionApplyError(`${what} no longer exists, or is no longer inside what this connection covers, so nothing was changed.`);
  }
}

/** The refusal for a version fence that failed. */
function changedSince(what: string): ActionApplyError {
  return new ActionApplyError(`${what} changed after this was proposed, so it was not applied. Ask the agent to ` +
    "read it again and propose the change afresh.");
}

/** Maps Graph's refusals of a write onto terminal failures; anything else is retried. */
function refusal(error: unknown, what: string): never {
  if (error instanceof GraphApiError) {
    if (error.isConflict) throw changedSince(what);
    if (error.isNameConflict) throw new ActionApplyError(`Something named the same is already there, so ${what.toLowerCase()} was not changed.`);
    if (error.status === 404) throw new ActionApplyError(`${what} no longer exists, or you no longer have access to it.`);
    if (error.status === 403) throw new ActionApplyError(`You don't have permission to change ${what.toLowerCase()} in SharePoint.`);
    if (error.status === 423) throw new ActionApplyError(`${what} is locked, probably because someone has it open. Try again later.`);
    if (error.status === 400 || error.status === 507) throw new ActionApplyError(`SharePoint refused the change: ${error.message}`);
  }
  throw error;
}

const logger = obsContext.createLogger({ component: "gatekeeper.microsoft.sharepoint.actions", vendorId: VENDOR_ID });

/**
 * Has Excel calculate a workbook this gatekeeper wrote, which saves its formulas' results into the
 * file. Without them, previews, the PDF view, search and anything else that reads the file without
 * opening it in Excel shows formula cells empty. Best effort: Excel still calculates on open.
 */
async function calculateWorkbook(host: Pick<SharePointActionHost, "graph">, ref: ItemRef): Promise<void> {
  try {
    await host.graph(api => api.request("POST", `/drives/${ref.driveId}/items/${ref.itemId}/workbook/application/calculate`, {
      body: { calculationType: "Full" },
    }), { replayable: true });
  } catch (error) {
    logger.warn("failed to calculate a written workbook", { event: "workbook.calculate.failed", error });
  }
}

/** How long an approval waits for SharePoint to finish a copy. */
const COPY_WAIT_MS = 45_000;

/**
 * Waits for a copy to finish, and returns the new file's ID. One still running at the deadline, or
 * whose progress can't be read, is an unknown outcome, not a failure: SharePoint has accepted the
 * copy, which lands regardless, so a replay would make a second one.
 */
async function awaitCopy(host: SharePointActionHost, monitor: string, landing: ItemRef & { name: string }): Promise<string> {
  const deadline = Date.now() + COPY_WAIT_MS;
  for (let wait = 500; ; wait = Math.min(wait * 2, 4_000)) {
    let progress: Awaited<ReturnType<GraphApi["copyProgress"]>>;
    try {
      progress = await host.graph(api => api.copyProgress(monitor), { replayable: true });
      // Finished without saying where: the copy is under its name in the folder it went to.
      if (progress.status === "completed" && !progress.resourceId) {
        const found = await host.graph(api => api.find<{ id?: unknown }>(`/drives/${landing.driveId}/items/${landing.itemId}:/${pathSegment(landing.name)}`,
          { query: { $select: "id" } }), { replayable: true });
        if (typeof found?.id === "string") return found.id;
        throw new ActionOutcomeUnknownError("SharePoint says the copy finished, but it couldn't be found in the folder. Check there before asking for it again.");
      }
    } catch (error) {
      if (error instanceof ActionOutcomeUnknownError) throw error;
      throw new ActionOutcomeUnknownError("SharePoint accepted the copy, but whether it has finished couldn't be checked. It will appear " +
        "in the folder when the copy finishes; check there before asking for it again.", { cause: error });
    }
    if (progress.status === "completed" && progress.resourceId) return progress.resourceId;
    if (progress.status === "failed") {
      throw new ActionApplyError(`SharePoint couldn't copy the file${progress.error ? `: ${progress.error}` : "."}`);
    }
    if (Date.now() + wait > deadline) {
      throw new ActionOutcomeUnknownError("SharePoint was still copying the file when this stopped waiting. It will appear " +
        "in the folder when the copy finishes; check there before asking for it again.");
    }
    await new Promise(resolve => setTimeout(resolve, wait));
  }
}

/** `name` as a path segment Graph's `:/path:` syntax accepts: `encodeURIComponent` leaves the quote OData delimits with. */
export function pathSegment(name: string): string {
  return encodeURIComponent(name).replace(/'/g, "%27");
}

/** A Markdown-free label for a value in prose. */
function label(text: string): string {
  return plainInline(text, 80);
}

/** The approver's view of a text file's new content, or of its bytes when it is not text. */
function addContent(builder: ReturnType<typeof buildDescription>, name: string, payload: { file: ActionFileReference; mimeType: string; text?: string }): void {
  if (payload.text !== undefined) builder.verbatim("Content", payload.text);
  else builder.file("Content", { name, mediaType: payload.mimeType, size: payload.file.size, sha256: payload.file.digest, origin: "agent" });
}

const FORMAT_NAMES: Record<WrittenAs, string> = { word: "a Word document", powerpoint: "a PowerPoint deck", excel: "an Excel workbook" };

/** How a written file was made, in a sentence. */
function writingNote(writing: Writing): string {
  const source = writing.as === "excel" ? "rows" : "Markdown";
  return `Written from the ${source} below as ${FORMAT_NAMES[writing.as]}` +
    (writing.template ? `, in the style of ${label(writing.template)}.` : ".");
}

/** "a, b and c". */
function joinWords(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** The most changed paragraphs or slides shown to an approver in full. */
const MAX_SHOWN_CHANGES = 40;

/** The most changed cells listed for an approver. */
const MAX_SHOWN_CELLS = 200;

/**
 * A rendered description whose preview left some of the change out: `descriptionIsComplete` is
 * dropped, as the builder drops it for its own truncation, so the approval surface says so.
 */
function omitting<T extends { descriptionIsComplete?: true }>(rendered: T, omitted: boolean): T {
  if (!omitted) return rendered;
  const { descriptionIsComplete: _complete, ...rest } = rendered;
  return rest as T;
}

/** An in-place edit's changes, each paragraph or slide as removed and added lines. */
function addEditChanges(builder: ReturnType<typeof buildDescription>, edit: NonNullable<SharePointActions["replaceFile"]["edit"]>): void {
  const count = edit.changes.length + (edit.more ?? 0);
  const what = edit.kind === "document" ? "paragraph" : "slide";
  builder.prose(`Changes ${count} ${what}${count === 1 ? "" : "s"} in place; everything else in the file stays as it is.` +
    (edit.trackChanges ? " The changes are recorded as tracked changes, to review and accept in Word." : ""));
  const lines: string[] = [];
  for (const change of edit.changes.slice(0, MAX_SHOWN_CHANGES)) {
    if (lines.length > 0) lines.push("");
    if (change.slide !== undefined) lines.push(`@@ slide ${change.slide}${change.notes ? " notes" : ""} @@`);
    if (change.before !== undefined) for (const line of change.before.split("\n")) lines.push(`-${line}`);
    if (change.after !== undefined) for (const line of change.after.split("\n")) lines.push(`+${line}`);
  }
  const shown = Math.min(edit.changes.length, MAX_SHOWN_CHANGES);
  if (count > shown) lines.push("", `… and ${count - shown} more`);
  builder.verbatim("Changes", lines.join("\n"));
}

const utf8Length = (text: string): number => new TextEncoder().encode(text).byteLength;

/**
 * The texts a replace shows the approver, within the record's budget: both sides of the diff when
 * they fit together, else the new text alone, else neither (the file is then shown by size and digest).
 */
export function shownTexts(text: string | undefined, previousText?: string): { text?: string; previousText?: string } {
  if (text === undefined || utf8Length(text) > MAX_SHOWN_TEXT_BYTES) return {};
  if (previousText === undefined || utf8Length(text) + utf8Length(previousText) > MAX_SHOWN_TEXT_BYTES) return { text };
  return { text, previousText };
}

/** The leading changes of an in-place edit that fit the record's budget, and how many were left out. */
export function shownChanges(changes: readonly EditChange[]): { changes: EditChange[]; more?: number } {
  let bytes = 0;
  let kept = 0;
  for (const change of changes) {
    bytes += utf8Length(change.before ?? "") + utf8Length(change.after ?? "");
    if (bytes > MAX_SHOWN_TEXT_BYTES) break;
    kept++;
  }
  return { changes: changes.slice(0, kept), ...(kept < changes.length ? { more: changes.length - kept } : {}) };
}

/** A cell's value as an approver reads it. */
function cellText(value: CellValue | undefined): string {
  return value === null || value === undefined || value === "" ? "(empty)" : String(value);
}

/** The A1 address of the cell `row` rows and `column` columns from the range's top-left cell. */
export function cellAt(address: string, row: number, column: number): string {
  const match = /^([A-Z]{1,3})([0-9]+)/.exec(address)!;
  return `${columnLetters(columnIndex(match[1]!) + column)}${Number(match[2]) + row}`;
}

/** A field table of list item values, in the order given, under each column's display name. */
function addFieldValues(builder: ReturnType<typeof buildDescription>, fields: Record<string, FieldValue>,
                        labels: Record<string, string>, before?: Record<string, FieldValue>): void {
  for (const [name, value] of Object.entries(fields)) {
    const title = labels[name] ?? name;
    const shown = value === null ? "(empty)" : Array.isArray(value) ? value.join(", ") : String(value);
    if (before !== undefined && name in before) {
      const old = before[name];
      const was = old === null || old === undefined ? "(empty)" : Array.isArray(old) ? old.join(", ") : String(old);
      builder.inline(`${title} (was)`, was);
    }
    builder.inline(title, shown);
  }
}

/** Hunks as the unified diff text people read in code review: `@@` headers, then `-`, `+` and ` ` lines. */
function unifiedDiff(hunks: readonly GitDiffHunk[]): string {
  const marks = { context: " ", added: "+", removed: "-" } as const;
  return hunks.map(hunk => [hunk.header, ...hunk.lines.map(line => `${marks[line.kind]}${line.text}`)].join("\n")).join("\n");
}

/** Every kind's definition. */
export const definitions = {
  createFolder: {
    kind: { tag: "sharepoint.files.create", label: "Create SharePoint files and folders" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    // Under "fail" conflict behavior a replay after a crash is refused as a duplicate name, which is
    // indistinguishable from someone else's folder of that name. Claimed instead, never adopted.
    claimBeforeApply: true,
    describe: payload => {
      const builder = buildDescription(`Create a folder named ${label(payload.name)} in ${label(payload.parent.location)}.`);
      builder.inline("Name", payload.name);
      builder.inline("In", payload.parent.location);
      return {
        title: sanitizeTitle(`Create folder "${payload.name}" in SharePoint`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    provides: payload => [payload.ref],
    dependsOn: payload => isProvisional(payload.parent.id) ? [payload.parent.id] : [],
    apply: async (payload, host) => {
      const parent = folderRef(host, payload.parent);
      await requireInScope(host, parent, "The folder this goes in");
      let id: string;
      try {
        id = await host.graph(async api => parseDriveItem(await api.request<unknown>("POST", `/drives/${parent.driveId}/items/${parent.itemId}/children`, {
          body: { name: payload.name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" },
        })).id);
      } catch (error) {
        refusal(error, "The folder");
      }
      host.refs.bind(payload.ref, encodeItemRef({ driveId: parent.driveId, itemId: id }));
      return { action: { ...payload, createdId: id, appliedAt: Date.now() } };
    },
  },

  uploadFile: {
    kind: { tag: "sharepoint.files.create", label: "Create SharePoint files and folders" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    // Graph's upload is not idempotent under "fail" conflict behavior: a replay after a crash would
    // be refused as a duplicate name, indistinguishable from someone else's file. Claimed instead.
    claimBeforeApply: true,
    describe: payload => {
      const builder = buildDescription(`Upload a new file named ${label(payload.name)} to ${label(payload.parent.location)}.`);
      builder.inline("Name", payload.name);
      builder.inline("In", payload.parent.location);
      if (payload.writing) builder.prose(writingNote(payload.writing));
      addContent(builder, payload.name, payload);
      return {
        title: sanitizeTitle(`Upload "${payload.name}" to SharePoint`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    provides: payload => [payload.ref],
    dependsOn: payload => isProvisional(payload.parent.id) ? [payload.parent.id] : [],
    apply: async (payload, host) => {
      const parent = folderRef(host, payload.parent);
      await requireInScope(host, parent, "The folder this goes in");
      const bytes = await host.readFile(payload.file);
      let id: string;
      let cTag: string | undefined;
      try {
        const created = await host.graph(async api => parseDriveItem(await api.request<unknown>("PUT",
          `/drives/${parent.driveId}/items/${parent.itemId}:/${pathSegment(payload.name)}:/content`, {
            query: { "@microsoft.graph.conflictBehavior": "fail", $select: ITEM_SELECT },
            rawBody: bytes,
            contentType: payload.mimeType,
          })));
        id = created.id;
        cTag = created.cTag;
      } catch (error) {
        refusal(error, "The file");
      }
      host.refs.bind(payload.ref, encodeItemRef({ driveId: parent.driveId, itemId: id }));
      host.releaseFile(payload.file);
      if (payload.writing?.as === "excel") {
        await calculateWorkbook(host, { driveId: parent.driveId, itemId: id });
        cTag = await contentTagLeft(host, { driveId: parent.driveId, itemId: id });
      }
      return { action: { ...payload, createdId: id, ...(cTag ? { cTag } : {}), appliedAt: Date.now() } };
    },
    reject: async (payload, host) => host.releaseFile(payload.file),
  },

  replaceFile: {
    kind: { tag: "sharepoint.files.edit", label: "Edit SharePoint files" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    // The PUT itself moves the content tag a replay would fence on, so a crash after it would
    // replay into a false "changed since proposed". Claimed instead.
    claimBeforeApply: true,
    describe: payload => {
      const builder = buildDescription(`Replace the content of ${label(payload.target.name)} in ${label(payload.target.location)}. ` +
        "SharePoint keeps the current content as an earlier version." +
        (payload.ifMatch ? " This is applied only if nobody has changed the file since it was proposed." : ""));
      builder.inline("File", payload.target.webUrl ?? `${payload.target.location} › ${payload.target.name}`);
      if (payload.edit) {
        addEditChanges(builder, payload.edit);
        return {
          title: sanitizeTitle(`Edit "${payload.target.name}" in SharePoint`),
          ...omitting(builder.finish(), (payload.edit.more ?? 0) > 0 || payload.edit.changes.length > MAX_SHOWN_CHANGES),
          implementsRevert: true,
        } satisfies ActionPresentation;
      }
      if (payload.writing) builder.prose(writingNote(payload.writing));
      if (payload.loses && payload.loses.length > 0) {
        builder.prose(`The current file has ${joinWords(payload.loses)}, which the new content doesn't keep. ` +
          "The current file stays in its version history.");
      }
      if (payload.previousText !== undefined && payload.text !== undefined) {
        const diff = diffTextLines(payload.previousText, payload.text);
        builder.prose(`${diff.additions} line${diff.additions === 1 ? "" : "s"} added, ${diff.deletions} removed.`);
        if (diff.hunks.length > 0) builder.verbatim("Changes", unifiedDiff(diff.hunks));
      }
      addContent(builder, payload.target.name, payload);
      return {
        title: sanitizeTitle(`${payload.writing || payload.loses ? "Rewrite" : "Edit"} "${payload.target.name}" in SharePoint`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    apply: async (payload, host) => {
      const { driveId, itemId } = payload.target.ref;
      await requireInScope(host, payload.target.ref, "The file");
      const bytes = await host.readFile(payload.file);
      let previousVersionId: string | undefined;
      let cTag: string | undefined;
      try {
        // The bytes were checked as the format the name said at proposal, and a rename leaves the
        // content tag alone: a file since renamed into another format isn't given them.
        const current = await host.graph(api => api.get<{ name?: unknown }>(`/drives/${driveId}/items/${itemId}`, { query: { $select: "name" } }), { replayable: true });
        if (typeof current.name !== "string" || extensionOf(current.name) !== extensionOf(payload.target.name)) {
          throw new ActionApplyError("The file has been renamed into another format since this was proposed, so it wasn't replaced. Ask the agent to read it again.");
        }
        // The current version, recorded first: it is what a revert restores.
        previousVersionId = await host.graph(async api => parsePage(
          await api.get<unknown>(`/drives/${driveId}/items/${itemId}/versions`, { query: { $top: 1 } }),
          parseVersion, "version").items[0]?.id, { replayable: true });
        const written = await host.graph(api => api.request<{ cTag?: unknown }>("PUT", `/drives/${driveId}/items/${itemId}/content`, {
          rawBody: bytes, contentType: payload.mimeType, ...(payload.ifMatch ? { ifMatch: payload.ifMatch } : {}),
        }));
        if (typeof written?.cTag === "string") cTag = written.cTag;
      } catch (error) {
        if (error instanceof ActionApplyError) throw error;
        refusal(error, "The file");
      }
      host.releaseFile(payload.file);
      if (payload.writing?.as === "excel") {
        await calculateWorkbook(host, payload.target.ref);
        // Calculating rewrote the file; what an undo must find is the content that left.
        cTag = await contentTagLeft(host, payload.target.ref);
      }
      return { action: { ...payload, ...(previousVersionId ? { previousVersionId } : {}), ...(cTag ? { cTag } : {}), appliedAt: Date.now() } };
    },
    reject: async (payload, host) => host.releaseFile(payload.file),
  },

  rename: {
    kind: { tag: "sharepoint.files.organize", label: "Rename and move SharePoint files" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Rename the ${payload.target.kind} ${label(payload.target.name)} in ${label(payload.target.location)}.`);
      builder.inline("From", payload.target.name);
      builder.inline("To", payload.name);
      return {
        title: sanitizeTitle(`Rename "${payload.target.name}" to "${payload.name}" in SharePoint`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    apply: async (payload, host) => {
      const { driveId, itemId } = payload.target.ref;
      const what = payload.target.kind === "folder" ? "The folder" : "The file";
      await requireInScope(host, payload.target.ref, what);
      let cTag: string | undefined;
      try {
        if (payload.target.kind !== "folder") {
          // The new name was checked against the file's format at proposal: one since renamed into
          // another format isn't given a name that would pass its bytes off as an unchecked Office file.
          const current = await host.graph(api => api.get<{ name?: unknown }>(`/drives/${driveId}/items/${itemId}`, { query: { $select: "name" } }), { replayable: true });
          if (typeof current.name !== "string" || extensionOf(current.name) !== extensionOf(payload.target.name)) {
            throw new ActionApplyError("The file has been renamed into another format since this was proposed, so it wasn't renamed. Ask the agent to read it again.");
          }
        }
        const renamed = await host.graph(api => api.request<{ cTag?: unknown }>("PATCH", `/drives/${driveId}/items/${itemId}`, {
          body: { name: payload.name }, ...(payload.ifMatch ? { ifMatch: payload.ifMatch } : {}),
        }), { replayable: true });
        if (typeof renamed?.cTag === "string") cTag = renamed.cTag;
      } catch (error) {
        if (error instanceof ActionApplyError) throw error;
        refusal(error, what);
      }
      return { action: { ...payload, ...(cTag ? { cTag } : {}), appliedAt: Date.now() } };
    },
  },

  move: {
    kind: { tag: "sharepoint.files.organize", label: "Rename and move SharePoint files" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Move the ${payload.target.kind} ${label(payload.target.name)} to ${label(payload.to.location)}.` +
        (payload.target.kind === "folder" ? " Everything in it moves too, and keeps its permissions only if they were set on it directly." : ""));
      builder.inline("Name", payload.target.name);
      builder.inline("From", payload.from.location);
      builder.inline("To", payload.to.location);
      return {
        title: sanitizeTitle(`Move "${payload.target.name}" in SharePoint`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    dependsOn: payload => isProvisional(payload.to.id) ? [payload.to.id] : [],
    apply: async (payload, host) => {
      const { driveId, itemId } = payload.target.ref;
      const what = payload.target.kind === "folder" ? "The folder" : "The file";
      const destination = folderRef(host, payload.to);
      await requireInScope(host, payload.target.ref, what);
      await requireInScope(host, destination, "The folder it goes to");
      try {
        await host.graph(api => api.request("PATCH", `/drives/${driveId}/items/${itemId}`, {
          body: { parentReference: { id: destination.itemId } }, ...(payload.ifMatch ? { ifMatch: payload.ifMatch } : {}),
        }), { replayable: true });
      } catch (error) {
        refusal(error, what);
      }
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },

  deleteItem: {
    kind: { tag: "sharepoint.files.delete", label: "Delete SharePoint files" },
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Delete the ${payload.target.kind} ${label(payload.target.name)} from ${label(payload.target.location)}` +
        (payload.target.kind === "folder" ? ", with everything in it" : "") +
        ". It goes to the site's recycle bin, where it can be restored from SharePoint for 93 days." +
        (payload.ifMatch ? " This is applied only if nobody has changed it since it was proposed." : ""));
      builder.inline(payload.target.kind === "folder" ? "Folder" : "File", payload.target.webUrl ?? `${payload.target.location} › ${payload.target.name}`);
      return {
        title: sanitizeTitle(`Delete "${payload.target.name}" from SharePoint`),
        ...builder.finish(),
        implementsRevert: false,
      } satisfies ActionPresentation;
    },
    apply: async (payload, host) => {
      const { driveId, itemId } = payload.target.ref;
      const what = payload.target.kind === "folder" ? "The folder" : "The file";
      await requireInScope(host, payload.target.ref, what);
      try {
        await host.graph(api => api.request("DELETE", `/drives/${driveId}/items/${itemId}`, {
          ...(payload.ifMatch ? { ifMatch: payload.ifMatch } : {}),
          // A replay after the first attempt deleted it finds nothing, which is the goal.
          allow: [404],
        }), { replayable: true });
      } catch (error) {
        refusal(error, what);
      }
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },

  updateCells: {
    kind: { tag: "sharepoint.files.edit", label: "Edit SharePoint files" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    // The write moves the content tag the fence compares, so a replay after a crash would be refused
    // as "changed since proposed". Claimed instead.
    claimBeforeApply: true,
    describe: payload => {
      const builder = buildDescription(`Set ${payload.address} on the worksheet ${label(payload.worksheet)} of ` +
        `${label(payload.target.name)} in ${label(payload.target.location)}. Every other cell, formula, format and sheet ` +
        "stays as it is, and SharePoint keeps the current workbook as an earlier version." +
        (payload.ifMatch ? " This is applied only if nobody has changed the workbook since it was proposed." : ""));
      builder.inline("Workbook", payload.target.webUrl ?? `${payload.target.location} › ${payload.target.name}`);
      builder.inline("Range", `${payload.worksheet}!${payload.address}`);
      const rows: string[] = [];
      payload.values.forEach((row, rowIndex) => row.forEach((value, columnOffset) => {
        const before = payload.before[rowIndex]?.[columnOffset];
        if (cellText(before) !== cellText(value)) rows.push(`${cellAt(payload.address, rowIndex, columnOffset)}: ${cellText(before)} → ${cellText(value)}`);
      }));
      if (rows.length === 0) builder.prose("Every cell already holds what this writes.");
      else builder.list(`${rows.length} cell${rows.length === 1 ? "" : "s"} change`, rows.length > MAX_SHOWN_CELLS ? [...rows.slice(0, MAX_SHOWN_CELLS), `… and ${rows.length - MAX_SHOWN_CELLS} more`] : rows);
      return {
        title: sanitizeTitle(`Edit cells ${payload.address} in "${payload.target.name}" in SharePoint`),
        ...omitting(builder.finish(), rows.length > MAX_SHOWN_CELLS),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    apply: async (payload, host) => {
      const { driveId, itemId } = payload.target.ref;
      await requireInScope(host, payload.target.ref, "The workbook");
      let previousVersionId: string | undefined;
      let applied: CellValue[][] | undefined;
      try {
        // The workbook API has no If-Match, so the fence is checked just before the write. It is the
        // content tag a read saw, or the eTag an agent passed as `ifUnchanged`, as Graph's If-Match takes either.
        if (payload.ifMatch) {
          const current = await host.graph(async api => parseDriveItem(await api.get<unknown>(`/drives/${driveId}/items/${itemId}`,
            { query: { $select: ITEM_SELECT } })), { replayable: true });
          if (current.cTag !== payload.ifMatch && current.eTag !== payload.ifMatch) throw changedSince("The workbook");
        }
        previousVersionId = await host.graph(async api => parsePage(
          await api.get<unknown>(`/drives/${driveId}/items/${itemId}/versions`, { query: { $top: 1 } }),
          parseVersion, "version").items[0]?.id, { replayable: true });
        const written = await host.graph(api => api.request<{ formulas?: unknown }>("PATCH",
          `/drives/${driveId}/items/${itemId}/workbook/worksheets/${encodeURIComponent(payload.sheetId)}/range(address='${payload.address}')`, {
            body: { formulas: payload.values.map(row => row.map(value => value ?? "")) },
          }));
        applied = cellGrid(written?.formulas, payload.values);
      } catch (error) {
        refusal(error, "The workbook");
      }
      return { action: { ...payload, ...(applied ? { applied } : {}), ...(previousVersionId ? { previousVersionId } : {}), appliedAt: Date.now() } };
    },
  },

  copyFile: {
    kind: { tag: "sharepoint.files.create", label: "Create SharePoint files and folders" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    // A replayed copy would make a second file, or be refused as a duplicate name. Claimed instead.
    claimBeforeApply: true,
    describe: payload => {
      const builder = buildDescription(`Copy ${label(payload.source.name)} from ${label(payload.source.location)} to ` +
        `${label(payload.parent.location)}${payload.name !== payload.source.name ? ` as ${label(payload.name)}` : ""}. ` +
        "The copy keeps the file's content, formatting and properties.");
      builder.inline("From", payload.source.webUrl ?? `${payload.source.location} › ${payload.source.name}`);
      builder.inline("To", `${payload.parent.location} › ${payload.name}`);
      return {
        title: sanitizeTitle(`Copy "${payload.source.name}" to "${payload.parent.name}" in SharePoint`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    provides: payload => [payload.ref],
    dependsOn: payload => isProvisional(payload.parent.id) ? [payload.parent.id] : [],
    apply: async (payload, host) => {
      const parent = folderRef(host, payload.parent);
      const { driveId, itemId } = payload.source.ref;
      await requireInScope(host, payload.source.ref, "The file");
      await requireInScope(host, parent, "The folder it goes to");
      let createdId: string;
      try {
        // The copy's name was checked against the source's format at proposal, and the copy takes
        // the source's current bytes: a source since renamed into another format isn't copied under
        // a name that would pass them off as an unchecked Office file.
        const current = await host.graph(api => api.get<{ name?: unknown }>(`/drives/${driveId}/items/${itemId}`, { query: { $select: "name" } }), { replayable: true });
        if (typeof current.name !== "string" || extensionOf(current.name) !== extensionOf(payload.source.name)) {
          throw new ActionApplyError("The file has been renamed into another format since this was proposed, so it wasn't copied. Ask the agent to read it again.");
        }
        const monitor = await host.graph(api => api.startCopy(`/drives/${driveId}/items/${itemId}/copy`,
          { parentReference: { driveId: parent.driveId, id: parent.itemId }, name: payload.name },
          { "@microsoft.graph.conflictBehavior": "fail" }));
        createdId = await awaitCopy(host, monitor, { driveId: parent.driveId, itemId: parent.itemId, name: payload.name });
      } catch (error) {
        refusal(error, "The file");
      }
      host.refs.bind(payload.ref, encodeItemRef({ driveId: parent.driveId, itemId: createdId }));
      const cTag = await contentTagLeft(host, { driveId: parent.driveId, itemId: createdId });
      return { action: { ...payload, createdId, ...(cTag ? { cTag } : {}), appliedAt: Date.now() } };
    },
  },

  createListItem: {
    kind: { tag: "sharepoint.lists.edit", label: "Add and edit SharePoint list items" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    // Graph has no idempotency key for list items: a replay would add a second item.
    claimBeforeApply: true,
    describe: payload => {
      const builder = buildDescription(`Add an item to the list ${label(payload.list.name)}.`);
      addFieldValues(builder, payload.fields, payload.labels);
      return {
        title: sanitizeTitle(`Add an item to "${payload.list.name}" in SharePoint`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    provides: payload => [payload.ref],
    apply: async (payload, host) => {
      let created: { id: string; eTag?: string };
      try {
        created = await host.graph(async api => listItemTag(await api.request<unknown>("POST",
          `/sites/${payload.list.siteId}/lists/${payload.list.listId}/items`, { body: { fields: payload.fields } })));
      } catch (error) {
        // Nothing identifies the row for a retry to find, so one that may have been added isn't added again.
        if (isOutcomeUnknown(error)) throw new ActionOutcomeUnknownError("SharePoint may have added the item before the connection dropped. Check the list before trying again.");
        refusal(error, "The list");
      }
      host.refs.bind(payload.ref, created.id);
      return { action: { ...payload, createdId: created.id, ...(created.eTag ? { createdETag: created.eTag } : {}), appliedAt: Date.now() } };
    },
  },

  updateListItem: {
    kind: { tag: "sharepoint.lists.edit", label: "Add and edit SharePoint list items" },
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Change ${Object.keys(payload.fields).length === 1 ? "a value" : "values"} of ` +
        `${payload.title ? `the item ${label(payload.title)}` : `item ${payload.itemId}`} in the list ${label(payload.list.name)}.` +
        (payload.ifMatch ? " This is applied only if nobody has changed the item since it was proposed." : ""));
      addFieldValues(builder, payload.fields, payload.labels, payload.before);
      return {
        title: sanitizeTitle(`Edit ${payload.title ? `"${payload.title}"` : `item ${payload.itemId}`} in "${payload.list.name}"`),
        ...builder.finish(),
        implementsRevert: true,
      } satisfies ActionPresentation;
    },
    dependsOn: payload => isProvisional(payload.itemId) ? [payload.itemId] : [],
    apply: async (payload, host) => {
      const itemId = host.refs.requireResolved(payload.itemId);
      let appliedETag: string | undefined;
      try {
        const updated = await host.graph(api => api.request<Record<string, unknown>>("PATCH",
          `/sites/${payload.list.siteId}/lists/${payload.list.listId}/items/${itemId}/fields`, {
            body: payload.fields, ...(payload.ifMatch ? { ifMatch: payload.ifMatch } : {}),
          }), { replayable: true });
        const tag = updated?.["@odata.etag"];
        if (typeof tag === "string") appliedETag = tag;
      } catch (error) {
        refusal(error, "The item");
      }
      return { action: { ...payload, ...(appliedETag ? { appliedETag } : {}), appliedAt: Date.now() } };
    },
  },

  deleteListItem: {
    kind: { tag: "sharepoint.lists.delete", label: "Delete SharePoint list items" },
    delivery: "continue-with-simulation",
    describe: payload => {
      const builder = buildDescription(`Delete ${payload.title ? `the item ${label(payload.title)}` : `item ${payload.itemId}`} ` +
        `from the list ${label(payload.list.name)}. It goes to the site's recycle bin.`);
      if (payload.title) builder.inline("Item", payload.title);
      builder.inline("List", payload.list.webUrl ?? payload.list.name);
      return {
        title: sanitizeTitle(`Delete ${payload.title ? `"${payload.title}"` : `item ${payload.itemId}`} from "${payload.list.name}"`),
        ...builder.finish(),
        implementsRevert: false,
      } satisfies ActionPresentation;
    },
    dependsOn: payload => isProvisional(payload.itemId) ? [payload.itemId] : [],
    apply: async (payload, host) => {
      const itemId = host.refs.requireResolved(payload.itemId);
      try {
        await host.graph(api => api.request("DELETE", `/sites/${payload.list.siteId}/lists/${payload.list.listId}/items/${itemId}`, {
          ...(payload.ifMatch ? { ifMatch: payload.ifMatch } : {}), allow: [404],
        }), { replayable: true });
      } catch (error) {
        refusal(error, "The item");
      }
      return { action: { ...payload, appliedAt: Date.now() } };
    },
  },
} satisfies { [K in keyof SharePointActions]: ActionDefinition<SharePointActions[K], SharePointActionHost> };

/** The action set, bound per binding to its journal and host. */
export const actions = defineActions<SharePointActionHost, SharePointActions>(definitions, {
  // Every kind acts as one Microsoft 365 user. Fenced on their stable (tenant, object) ID rather than
  // the connection generation, so a reconnect of the same user does not strand pending changes.
  fence: "authority",
  retainApplied: true,
  isResolvedReference: (host, ref) => host.refs.isResolved(ref),
  afterResolve: host => host.invalidate(),
  vendorId: VENDOR_ID,
});

/** The outcome `revertAction` reports. */
export type RevertOutcome = void | { message?: string; canRetry?: boolean; restart?: boolean };

/** A list item's ID and tag, the latter from whichever of its two spellings Graph sent. */
function listItemTag(body: unknown): { id: string; eTag?: string } {
  const item = parseListItem(body);
  const annotated = (body as Record<string, unknown>)["@odata.etag"];
  const eTag = item.eTag ?? (typeof annotated === "string" ? annotated : undefined);
  return { id: item.id, ...(eTag ? { eTag } : {}) };
}

/** `formulas` as Excel returned them for a write of `values`, when it returned a grid of the same shape. */
function cellGrid(formulas: unknown, values: CellValue[][]): CellValue[][] | undefined {
  if (!Array.isArray(formulas) || formulas.length !== values.length) return undefined;
  const grid: CellValue[][] = [];
  for (const [index, row] of formulas.entries()) {
    if (!Array.isArray(row) || row.length !== values[index]!.length) return undefined;
    grid.push(row.map(cell => cell === null || typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean" ? cell : String(cell)));
  }
  return grid;
}

/** A file's current content tag, or undefined when Graph doesn't give one. */
async function contentTag(host: SharePointActionHost, ref: ItemRef): Promise<string | undefined> {
  const current = await host.graph(api => api.find<{ cTag?: unknown }>(`/drives/${ref.driveId}/items/${ref.itemId}`, { query: { $select: "cTag" } }), { replayable: true });
  return typeof current?.cTag === "string" ? current.cTag : undefined;
}

/**
 * The content tag a write left, read once the write is done and its bytes released: a failed read
 * can't fail the write, so the tag goes unrecorded and the undo that would need it refuses instead.
 */
async function contentTagLeft(host: SharePointActionHost, ref: ItemRef): Promise<string | undefined> {
  try {
    return await contentTag(host, ref);
  } catch (error) {
    logger.warn("couldn't read the content tag a write left", { event: "sharepoint.content-tag.unread", error });
    return undefined;
  }
}

/**
 * Why a file this action created can't be deleted by its undo: edited since, its content was never
 * part of the action, and unrecorded, nobody can say. Nothing when it is still as the action left it.
 */
async function editedSince(host: SharePointActionHost, ref: ItemRef, left: string | undefined, name: string): Promise<{ message: string; canRetry: false } | undefined> {
  if (left === undefined) return { message: `SharePoint didn't say which version "${name}" was created at, so it wasn't deleted. Delete it in SharePoint if you need to.`, canRetry: false };
  const current = await contentTag(host, ref);
  if (current === undefined || current === left) return undefined;
  return { message: `"${name}" has been changed since it was created, so it wasn't deleted. Delete it in SharePoint if you need to.`, canRetry: false };
}

/**
 * Undoes an applied action: a created file, folder or item is deleted, a replaced file's previous
 * version restored, a rename or move put back, and a list item's old values written back. Deletions
 * cannot be undone through Graph, which has no recycle bin restore.
 */
export async function revert(action: SharePointAction, host: SharePointActionHost): Promise<RevertOutcome> {
  switch (action.kind) {
    case "createFolder":
    case "uploadFile": {
      const { payload } = action;
      if (payload.createdId === undefined) return { message: "It was never created, so there is nothing to undo.", canRetry: false };
      const parent = folderRef(host, payload.parent);
      const left = await leftBinding(host, { driveId: parent.driveId, itemId: payload.createdId }, "What was created");
      if (left) return left;
      if (action.kind === "createFolder") {
        // What others have put in it since was never part of this action.
        const current = await host.graph(api => api.find<{ folder?: { childCount?: unknown } }>(`/drives/${parent.driveId}/items/${payload.createdId}`,
          { query: { $select: "folder" } }), { replayable: true });
        if (current === null) return;
        if (typeof current.folder?.childCount === "number" && current.folder.childCount > 0) {
          return { message: `The folder "${payload.name}" isn't empty anymore, so it wasn't deleted. Move what's in it out first.`, canRetry: true };
        }
      } else {
        const edited = await editedSince(host, { driveId: parent.driveId, itemId: payload.createdId }, action.payload.cTag, payload.name);
        if (edited) return edited;
      }
      await host.graph(api => api.request("DELETE", `/drives/${parent.driveId}/items/${payload.createdId}`, { allow: [404] }),
        { replayable: true });
      return;
    }
    case "replaceFile": {
      const { payload } = action;
      if (payload.previousVersionId === undefined) {
        return { message: "SharePoint kept no earlier version of this file to restore.", canRetry: false };
      }
      const { driveId, itemId } = payload.target.ref;
      const left = await leftBinding(host, payload.target.ref, "The file");
      if (left) return left;
      // Restoring a version replaces the whole file, so it happens only over the content this write left.
      if (payload.cTag === undefined) {
        return { message: `SharePoint didn't say which version this edit left "${payload.target.name}" at, so it wasn't restored. Restore it from the file's version history in SharePoint if you need to.`, canRetry: false };
      }
      const current = await host.graph(api => api.get<{ cTag?: unknown }>(`/drives/${driveId}/items/${itemId}`, { query: { $select: "cTag" } }), { replayable: true });
      if (current.cTag !== payload.cTag) {
        return { message: `"${payload.target.name}" has changed since this edit, so the earlier version wasn't restored. Restore it from the file's version history in SharePoint if you need to.`, canRetry: false };
      }
      await host.graph(api => api.request("POST", `/drives/${driveId}/items/${itemId}/versions/${payload.previousVersionId}/restoreVersion`),
        { replayable: true });
      return;
    }
    case "rename": {
      const { payload } = action;
      const { driveId, itemId } = payload.target.ref;
      const left = await leftBinding(host, payload.target.ref, "It");
      if (left) return left;
      if (payload.target.kind !== "folder" && extensionOf(payload.target.name) !== extensionOf(payload.name)) {
        // Restoring a name in another format gives the file's bytes that format's reading, which
        // they were checked for only as they were when renamed: changed since, they stay as named.
        const current = await host.graph(api => api.get<{ cTag?: unknown }>(`/drives/${driveId}/items/${itemId}`, { query: { $select: "cTag" } }), { replayable: true });
        if (payload.cTag === undefined || current.cTag !== payload.cTag) {
          return { message: `The content of "${payload.name}" has changed since it was renamed, so its old name wasn't restored. Ask the agent to rename it instead.`, canRetry: false };
        }
      }
      await host.graph(api => api.request("PATCH", `/drives/${driveId}/items/${itemId}`, { body: { name: payload.target.name } }),
        { replayable: true });
      return;
    }
    case "move": {
      const { driveId, itemId } = action.payload.target.ref;
      const from = decodeItemRef(action.payload.from.id);
      if ("provisional" in from) return { message: "The folder it came from no longer exists.", canRetry: false };
      const left = (await leftBinding(host, action.payload.target.ref, "It")) ?? (await leftBinding(host, from, "The folder it came from"));
      if (left) return left;
      await host.graph(api => api.request("PATCH", `/drives/${driveId}/items/${itemId}`, {
        body: { parentReference: { id: from.itemId } },
      }), { replayable: true });
      return;
    }
    case "updateCells": {
      // Only the range is put back, and only while it still holds what this wrote: restoring a
      // version would replace the whole workbook, edits made elsewhere since included.
      const { payload } = action;
      const { driveId, itemId } = payload.target.ref;
      const left = await leftBinding(host, payload.target.ref, "The workbook");
      if (left) return left;
      const range = `/drives/${driveId}/items/${itemId}/workbook/worksheets/${encodeURIComponent(payload.sheetId)}/range(address='${payload.address}')`;
      const current = await host.graph(api => api.get<{ formulas?: unknown }>(range, { query: { $select: "formulas" } }), { replayable: true });
      const written = (payload.applied ?? payload.values).map(row => row.map(value => cellText(value)));
      const holds = Array.isArray(current.formulas) && current.formulas.length === written.length
        && current.formulas.every((row, rowIndex) => Array.isArray(row) && row.length === written[rowIndex]!.length
          && row.every((cell, columnIndex) => cellText(cell as CellValue) === written[rowIndex]![columnIndex]));
      if (!holds) {
        return { message: `${payload.worksheet}!${payload.address} has changed since this edit, so it wasn't put back. Ask the agent to read it and change it instead.`, canRetry: false };
      }
      await host.graph(api => api.request("PATCH", range, { body: { formulas: payload.before.map(row => row.map(value => value ?? "")) } }), { replayable: true });
      return;
    }
    case "copyFile": {
      const { payload } = action;
      if (payload.createdId === undefined) return { message: "It was never copied, so there is nothing to undo.", canRetry: false };
      const parent = folderRef(host, payload.parent);
      const left = await leftBinding(host, { driveId: parent.driveId, itemId: payload.createdId }, "The copy");
      if (left) return left;
      const edited = await editedSince(host, { driveId: parent.driveId, itemId: payload.createdId }, payload.cTag, payload.name);
      if (edited) return edited;
      await host.graph(api => api.request("DELETE", `/drives/${parent.driveId}/items/${payload.createdId}`, { allow: [404] }),
        { replayable: true });
      return;
    }
    case "deleteItem":
      return { message: "Deleted files can't be restored automatically. Restore it from the site's recycle bin in SharePoint.", canRetry: false };
    case "createListItem": {
      const { payload } = action;
      if (payload.createdId === undefined) return { message: "It was never created, so there is nothing to undo.", canRetry: false };
      // Deleted only as created: edited since, its values were never part of this action.
      if (payload.createdETag === undefined) {
        return { message: "SharePoint didn't say which version the item was created at, so it wasn't deleted. Delete it in SharePoint if you need to.", canRetry: false };
      }
      const path = `/sites/${payload.list.siteId}/lists/${payload.list.listId}/items/${payload.createdId}`;
      const current = await host.graph(api => api.find<unknown>(path), { replayable: true });
      if (current === null) return;
      if (listItemTag(current).eTag !== payload.createdETag) {
        return { message: "The item has been changed since it was created, so it wasn't deleted. Delete it in SharePoint if you need to.", canRetry: false };
      }
      await host.graph(api => api.request("DELETE", path, { allow: [404] }), { replayable: true });
      return;
    }
    case "updateListItem": {
      const { payload } = action;
      const itemId = host.refs.resolve(payload.itemId);
      // Fenced on the version the change left: edited since, the later edits stay.
      if (payload.appliedETag === undefined) {
        return { message: "SharePoint didn't say which version this change left, so it wasn't undone. Change the item in SharePoint if you need to.", canRetry: false };
      }
      try {
        await host.graph(api => api.request("PATCH", `/sites/${payload.list.siteId}/lists/${payload.list.listId}/items/${itemId}/fields`, {
          body: payload.before, ifMatch: payload.appliedETag,
        }), { replayable: true });
      } catch (error) {
        if (error instanceof GraphApiError && error.status === 412) {
          return { message: "The item has been changed since, so it wasn't put back. Change it in SharePoint if you need to.", canRetry: false };
        }
        throw error;
      }
      return;
    }
    case "deleteListItem":
      return { message: "Deleted list items can't be restored automatically. Restore it from the site's recycle bin in SharePoint.", canRetry: false };
  }
}

/** The temporary IDs an action provides, for working out which pending actions build on it. */
export function providedRefs(action: SharePointAction): string[] {
  switch (action.kind) {
    case "createFolder":
    case "uploadFile":
    case "copyFile":
    case "createListItem":
      return [action.payload.ref];
    default:
      return [];
  }
}

/** The temporary IDs an action depends on. */
export function dependedRefs(action: SharePointAction): string[] {
  switch (action.kind) {
    case "createFolder":
    case "uploadFile":
    case "copyFile":
      return isProvisional(action.payload.parent.id) ? [action.payload.parent.id] : [];
    case "move":
      return isProvisional(action.payload.to.id) ? [action.payload.to.id] : [];
    case "updateListItem":
    case "deleteListItem":
      return isProvisional(action.payload.itemId) ? [action.payload.itemId] : [];
    default:
      return [];
  }
}

/** File handles pending actions still hold, for sweeping captured bytes nothing references. */
export function fileHandles(action: SharePointAction): string[] {
  return action.kind === "uploadFile" || action.kind === "replaceFile" ? [action.payload.file.handle] : [];
}

/** The bytes as text to show the approver in full, or undefined when they are binary or too long. */
export function showableText(bytes: Uint8Array, mimeType: string): string | undefined {
  if (bytes.byteLength > MAX_SHOWN_TEXT_BYTES || !/^text\/|^application\/(json|xml|csv)|\+xml$|\+json$/.test(mimeType)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Why an undo is refused when what it would touch has left the binding since the change applied:
 * an item keeps its ID wherever it is moved, so the ID alone would reach outside what the connection
 * covers. Undefined while it is still inside.
 */
async function leftBinding(host: SharePointActionHost, ref: ItemRef, what: string): Promise<{ message: string; canRetry: false } | undefined> {
  try {
    await host.inScope(ref);
    return undefined;
  } catch (error) {
    if (!(error instanceof OutsideScopeError)) throw error;
    return { message: `${what} is no longer inside what this connection covers, so it was left as it is.`, canRetry: false };
  }
}
