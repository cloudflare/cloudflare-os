/**
 * Editing native Google files through a read and write Drive binding.
 *
 * Each editor's own action definitions are reused through {@link onDriveFile}: an edit is one more
 * record in the Drive journal, whose payload is the editor's own change beside the file it is for.
 * The definition keeps its name, its kind's tag and its verdict, so a rule a user enables on a
 * Drive binding is stored under the same tag as on a file's own binding, per binding as always;
 * only the label says that it covers every file of that kind the binding reaches. The card is the
 * editor's own, with the file named first, and the change is applied to the file the record names.
 */

import {
  ActionApplyError, type ActionDefinition, type ActionJournal, type ActionPresentation,
  type ActionSubmitter,
} from "@gadgets/gatekeeper-kit/actions";
import { ActionDescriptionBuilder } from "@gadgets/gatekeeper-kit/action-description";
import type { GoogleDocsApi } from "./docs-api";
import {
  DOC_DEFINITIONS, invalidateTableChangesBehind, parseGoogleDocWriteReceipt, pendingDocKeys,
  replayGoogleDocActions,
  type DocHost, type GoogleDocAction, type GoogleDocEditAction, type GoogleDocEdits,
  type GoogleDocInvalidator, type GoogleDocPendingAction, type GoogleDocReplayQueue,
  type GoogleDocSimulationCacheHolder, type GoogleDocWriteReceipt,
} from "./doc-actions";
import {
  driveDocCopies, DriveDocCopyLimits, type DriveDocCopies, type LazyDocStore,
} from "./docs-copy";
import { closesTableGate } from "./docs-tables";
import type { DocChangeQueue, DocFreshness, DriveDocSource } from "./docs";
import type { DriveApi, DriveScopeNode } from "./drive-api";
import { isDirectChild } from "./drive-folder-scope";
import {
  GOOGLE_DOC_MIME_TYPE, GOOGLE_SHEET_MIME_TYPE, GOOGLE_SLIDES_MIME_TYPE,
} from "./drive-session";
import { obsContext } from "./observability";
import { isLiftable, type DriveWriteTargetPayload } from "./drive-writes";
import { QueuedChanges } from "./queued-changes";
import type { SheetsChangeQueue } from "./sheets";
import {
  MARKER_RETENTION_MS, retainedMarkers, SHEETS_DEFINITIONS, type MarkerEntry, type SheetsHost,
} from "./sheets-actions";
import type { GoogleSheetsApi } from "./sheets-api";
import type { SheetsAction, SheetsActions } from "./sheets-simulation";
import type { SlidesChangeQueue } from "./slides";
import { SLIDES_DEFINITIONS, type SlidesHost } from "./slides-actions";
import type { SlidesAction, SlidesActions } from "./slides-simulation";

/** An edit of one native file, as the Drive journal stores it. */
export type DriveEdit<P> = {
  /** The file, as the session that opened it found it. */
  target: DriveWriteTargetPayload;
  /** The editor's own change, as a file's own binding would store it. */
  change: P;
};

/** The edits of one editor's action map `M`, by the names its definitions have. */
export type DriveEdits<M> = { [K in keyof M]: DriveEdit<M[K]> };

/** The editors a Drive binding edits files through. */
export type DriveEditorName = "slides" | "sheets" | "docs";

/** A spreadsheet's host, which also records the changes applied to that spreadsheet. */
export type DriveSheetsHost = SheetsHost & {
  /** Records that change `id` was applied, as {@link SheetsHost.applied} then answers. */
  recordApplied(id: number): void;
};

/** What applying an edit needs of the Drive gatekeeper: each editor's host for one file. */
export type DriveEditorHosts = {
  slides(fileId: string): SlidesHost;
  sheets(fileId: string): DriveSheetsHost;
  docs(fileId: string): DocHost;
  /**
   * Proves again, inside the action set's one queue of approvals, that edit `id` of `target` may
   * still be made with `editor`: no approval ahead of it, such as a move, has taken the file out of
   * reach meanwhile. Throws a plain error for a refusal a later approval can pass, and an
   * ActionApplyError for any other.
   */
  prove(editor: DriveEditorName, target: DriveWriteTargetPayload, id: number): Promise<void>;
};

/** The part of a Drive binding's action host the edits use. */
export type DriveEditorsHost = { editors: DriveEditorHosts };

/** One editor as a Drive binding reaches it. */
type DriveEditor<H> = {
  name: DriveEditorName;
  /** The MIME type of the files it edits. */
  mimeType: string;
  /** What its files are called, in a label: "presentation". */
  noun: string;
  host(drive: DriveEditorsHost, fileId: string): H;
  /**
   * Called once change `id` to file `fileId` was applied, before the action set retires its
   * record, so that nothing between the write and the record's retirement can miss it.
   */
  applied?(drive: DriveEditorsHost, fileId: string, id: number): void;
};

/** The most the two fields that name the file take of a card, in UTF-8 bytes. */
const FILE_FIELDS_BYTES = 4 * 1024;

/**
 * `presentation` with the file named first: its ID and, when known, its name, both third-party
 * text built as fields. The card is complete only if the editor's card and the two fields are.
 */
function withFile(target: DriveWriteTargetPayload, presentation: ActionPresentation): ActionPresentation {
  let builder = new ActionDescriptionBuilder(undefined, { maxBytes: FILE_FIELDS_BYTES });
  builder.inline("File", target.fileId);
  if (target.fileName !== undefined) builder.inline("File name", target.fileName);
  let { fields = [], descriptionIsComplete } = builder.finish();
  let { descriptionIsComplete: editorComplete, ...rest } = presentation;
  return {
    ...rest,
    fields: [...fields, ...presentation.fields ?? []],
    ...(editorComplete === true && descriptionIsComplete === true
      ? { descriptionIsComplete: true } : {}),
  };
}

/**
 * `definition`, an editor's own, as an edit of the file a Drive record names. Its name, tag,
 * verdict, delivery and claim are the editor's; the label says the kind covers every file of that
 * kind the binding reaches.
 */
export function onDriveFile<P, H>(
  definition: ActionDefinition<P, H>, editor: DriveEditor<H>,
): ActionDefinition<DriveEdit<P>, DriveEditorsHost> {
  // The Drive set resolves neither: no editor declares them, and forwarding them would need a
  // reference space shared across files.
  if (definition.provides || definition.dependsOn) {
    throw new Error("An editor definition reused through Drive cannot declare references.");
  }
  let { reject } = definition;
  return {
    kind: {
      tag: definition.kind.tag,
      label: `${definition.kind.label}, in any ${editor.noun} this connection reaches`,
    },
    autoApprovable: definition.autoApprovable,
    delivery: definition.delivery,
    ...(definition.claimBeforeApply ? { claimBeforeApply: true } : {}),
    describe: async ({ target, change }, drive) =>
      withFile(target, await definition.describe(change, editor.host(drive, target.fileId))),
    apply: async ({ target, change }, drive, ctx) => {
      await drive.editors.prove(editor.name, target, ctx.id);
      let result = await definition.apply(change, editor.host(drive, target.fileId), ctx);
      editor.applied?.(drive, target.fileId, ctx.id);
      return result?.action === undefined ? undefined : { action: { target, change: result.action } };
    },
    ...(reject ? {
      reject: ({ target, change }: DriveEdit<P>, drive: DriveEditorsHost, ctx) =>
        reject(change, editor.host(drive, target.fileId), ctx),
    } : {}),
  };
}

/** Every one of `definitions` as {@link onDriveFile} makes it. */
function onDriveFiles<M, H>(
  definitions: { [K in keyof M]: ActionDefinition<M[K], H> }, editor: DriveEditor<H>,
): { [K in keyof M]: ActionDefinition<DriveEdit<M[K]>, DriveEditorsHost> } {
  return Object.fromEntries(Object.entries(definitions).map(([name, definition]) =>
    [name, onDriveFile(definition as ActionDefinition<unknown, H>, editor)])) as
    { [K in keyof M]: ActionDefinition<DriveEdit<M[K]>, DriveEditorsHost> };
}

/** The kind tag of each of `definitions`, by its name. */
function tagsOf(definitions: Record<string, { kind: { tag: string } }>): Record<string, string> {
  return Object.fromEntries(Object.entries(definitions).map(([name, { kind }]) => [name, kind.tag]));
}

const SLIDES_EDITOR: DriveEditor<SlidesHost> = {
  name: "slides", mimeType: GOOGLE_SLIDES_MIME_TYPE, noun: "presentation",
  host: (drive, fileId) => drive.editors.slides(fileId),
};

/** The Slides changes a Drive binding queues, by the names the editor's definitions have. */
export const DRIVE_SLIDES_DEFINITIONS = onDriveFiles<SlidesActions, SlidesHost>(
  SLIDES_DEFINITIONS, SLIDES_EDITOR);

const SHEETS_EDITOR: DriveEditor<SheetsHost> = {
  name: "sheets", mimeType: GOOGLE_SHEET_MIME_TYPE, noun: "spreadsheet",
  host: (drive, fileId) => drive.editors.sheets(fileId),
  applied: (drive, fileId, id) => drive.editors.sheets(fileId).recordApplied(id),
};

/** The Sheets changes a Drive binding queues, by the names the editor's definitions have. */
export const DRIVE_SHEETS_DEFINITIONS = onDriveFiles<SheetsActions, SheetsHost>(
  SHEETS_DEFINITIONS, SHEETS_EDITOR);

const DOCS_EDITOR: DriveEditor<DocHost> = {
  name: "docs", mimeType: GOOGLE_DOC_MIME_TYPE, noun: "Doc",
  host: (drive, fileId) => drive.editors.docs(fileId),
};

/**
 * The Doc edits a Drive binding queues: every edit of a Doc's own binding but the add of a tab,
 * since a Drive binding adds no tabs.
 */
export type DriveDocEdits = Omit<GoogleDocEdits, "addTab">;

const { addTab: _addTab, ...DOC_EDIT_DEFINITIONS } = DOC_DEFINITIONS;

/** The Doc edits a Drive binding queues, by the names the editor's definitions have. */
export const DRIVE_DOCS_DEFINITIONS = onDriveFiles<DriveDocEdits, DocHost>(
  DOC_EDIT_DEFINITIONS, DOCS_EDITOR);

/** Each editor, with the kind tag of each of its definitions by the definition's name. */
const EDITORS: { editor: { name: DriveEditorName; mimeType: string }; tags: Record<string, string> }[] = [
  { editor: SLIDES_EDITOR, tags: tagsOf(DRIVE_SLIDES_DEFINITIONS) },
  { editor: SHEETS_EDITOR, tags: tagsOf(DRIVE_SHEETS_DEFINITIONS) },
  { editor: DOCS_EDITOR, tags: tagsOf(DRIVE_DOCS_DEFINITIONS) },
];

/** The editor whose definition each name is, for a record of the Drive journal. */
const EDITOR_BY_NAME = new Map(EDITORS.flatMap(({ editor, tags }) =>
  Object.keys(tags).map(name => [name, editor] as const)));

/** The MIME type of the files `editor` edits. */
export function editorMimeType(editor: DriveEditorName): string {
  return EDITORS.find(entry => entry.editor.name === editor)!.editor.mimeType;
}

/** The editor of files of `mimeType`, if a Drive binding edits them. */
export function editorOfMimeType(mimeType: string | undefined): DriveEditorName | undefined {
  return EDITORS.find(entry => entry.editor.mimeType === mimeType)?.editor.name;
}

/** The editor whose changes are queued under kind tag `tag`, if any. */
export function editorOfTag(tag: string): DriveEditorName | undefined {
  return EDITORS.find(({ tags }) => Object.values(tags).includes(tag))?.editor.name;
}

/** The editor and file a Drive journal record edits, or `undefined` for any other write. */
export function editedFile(
  action: { kind: string; payload: unknown },
): { editor: DriveEditorName; target: DriveWriteTargetPayload } | undefined {
  let editor = EDITOR_BY_NAME.get(action.kind);
  return editor && { editor: editor.name, target: (action.payload as DriveEdit<unknown>).target };
}

/**
 * The change a Drive record makes to file `fileId` with `editor`, as the editor's own action, or
 * `undefined` for any other record.
 */
export function editOf<A>(
  editor: DriveEditorName, fileId: string, action: { kind: string; payload: unknown },
): A | undefined {
  let edited = editedFile(action);
  if (edited?.editor !== editor || edited.target.fileId !== fileId) return undefined;
  return { kind: action.kind, payload: (action.payload as DriveEdit<unknown>).change } as A;
}

/** A record of the Drive journal, of any kind. */
type DriveRecord = { kind: string; payload: unknown };

/** Said of an edit to a file the binding no longer reaches. */
export const EDIT_OUT_OF_SCOPE = "That file is no longer in this connection's scope.";
/** Said of an edit to a file in the trash. */
export const EDIT_IN_TRASH = "That file is in the trash, so it cannot be changed.";
/** Said of an edit to a file the connected account cannot edit. */
export const EDIT_NOT_ALLOWED = "The connected Google account cannot edit that file.";
/** The refusal of an approval while an earlier change to the same file still waits. */
export const EDIT_OUT_OF_ORDER = "Changes to one file apply in the order they were queued. " +
  "Approve or reject the earlier change to this file first.";

const logger = obsContext.createLogger({
  component: "gatekeeper.google.drive.editors", vendorId: "google",
});

/** Where a spreadsheet's state is kept, by its file ID. */
export const SHEETS_STATE_PREFIX = "driveSheets:file:";

/**
 * Where a document's receipt is kept, by its file ID: the write of an edit that landed, whose
 * marker is still to be deleted once the action set has retired the edit's record.
 */
export const DOC_RECEIPT_PREFIX = "driveDocs:receipt:";

/** How often a Doc is read again after an approval while its queue keeps moving. */
const MAX_REFRESHES = 3;

/** How many applied changes a spreadsheet's state remembers, twice the journal's capacity. */
const MAX_APPLIED = 100;

/** How many spreadsheets' states a sweep keeps beyond those it must. */
const MAX_IDLE_SHEETS = 20;

/**
 * How many documents' sources a binding keeps: each holds which copy a read approved, with the
 * fences of its fetch, and the document is in the store.
 */
const MAX_DOC_SOURCES = 4;

/**
 * What a Drive binding keeps of one spreadsheet, as its own binding keeps it for its one file: the
 * markers its batches left, the numbers of its last applied changes, and the numbers allocated for
 * its changes the journal may still hold, which keep the rest until those are decided.
 */
type SheetsFileState = {
  /** A bare ID is a marker last sent long ago. */
  markers: (MarkerEntry | number)[];
  applied: number[];
  queued: number[];
  /** When it was last written, by which a sweep drops the oldest idle states first. */
  at: number;
};

/** What {@link DriveFileEditors} needs of its Drive gatekeeper. */
export type DriveFileEditorsOptions = {
  /** The binding's storage, where each spreadsheet's state is kept. */
  kv: {
    get<T>(key: string): T | undefined;
    put<T>(key: string, value: T): void;
    delete(key: string): unknown;
    list<T>(options: { prefix: string }): Iterable<[string, T]>;
  };
  /** The Sheets API an approved change is written with. */
  sheets: GoogleSheetsApi;
  /** The Docs API an approved edit is written with, and its write marker deleted. */
  docs: GoogleDocsApi;
  /** Drive: a document's type, to explain a refused write, and a refused file's parent. */
  drive: Pick<DriveApi, "getFile" | "getScopeNodes">;
  journal: Pick<ActionJournal<DriveRecord>,
    "get" | "listPending" | "listUndecided" | "markSubmitted" | "markFailed">;
  /** Queues edit `payload` as definition `name` through `queue`. */
  submit(queue: ActionSubmitter, name: string, payload: DriveEdit<unknown>): Promise<number>;
  /** Applies and rejects a record through the action set. */
  apply(id: number): Promise<void>;
  reject(id: number): Promise<void>;
  /** Why the binding cannot make changes now, or `undefined` when it can. */
  writeRefusal(): Promise<string | undefined>;
  /** The file a write names as the binding's scope reaches it now, or `undefined` outside it. */
  locate(target: DriveWriteTargetPayload): Promise<DriveScopeNode | undefined>;
  /**
   * The store each document opened through the binding keeps its copy in, by file id; made
   * the first time it is asked for.
   */
  docStore: LazyDocStore;
  /** The caps of the binding's stored Docs. For tests. Defaults to the connection's. */
  docCaps?: { readonly count: number; readonly bytes: number };
};

/** Why an edit cannot be made now, and whether a later approval may pass that. */
type EditRefusal = { message: string; liftable: boolean };

/**
 * Why a folder binding does not reach a file one of its sessions was just refused, or
 * `undefined` where nothing shows that. `file` is the file as the refusal read it, `path` the
 * refused session's saved path, just proved, whose first folder is the binding's, and
 * `stood` the folder the last approved read of the file's stored copy stood on. In order:
 * - `"invisible"`: the connected account cannot see the file.
 * - `"trashed"`: it is in the trash.
 * - `"moved-out"`, with nothing asked: it has no parent folder or more than one, which no
 *   folder session reads (`isDirectChild`).
 * - Not shown unreached, with nothing asked: its parent is a folder of `path`, or is `stood`
 *   (the file stands where it was last read, so what moved, if anything, is a folder above
 *   it; that is not one request's to tell, and the copy's expiry ends it).
 * - Otherwise `parents` is asked for the file's parent folder, ONCE: reached where that
 *   folder is a live direct child of a folder of `path` (`isDirectChild`), and
 *   `"moved-out"` where it is not or Drive does not show it.
 * So a file moved to the binding's folder, to a folder the session passed through, or to a
 * folder directly inside one of those keeps its copy; one moved deeper elsewhere in the
 * binding cannot be told from one that left it by one request, and is answered
 * `"moved-out"`.
 */
export async function unreachedBy(
  file: DriveScopeNode | undefined, path: readonly DriveScopeNode[], stood: string | undefined,
  parents: (ids: string[]) => Promise<(DriveScopeNode | undefined)[]>,
): Promise<"invisible" | "trashed" | "moved-out" | undefined> {
  if (!file) return "invisible";
  if (file.trashed !== false) return "trashed";
  if (file.parents?.length !== 1) return "moved-out";
  let [parent] = file.parents;
  if (parent === stood || path.some(folder => folder.id === parent)) return undefined;
  let [node] = await parents([parent]);
  return node && path.some(folder => isDirectChild(node, folder)) ? undefined : "moved-out";
}

/**
 * The edits of one read and write Drive binding: one {@link QueuedChanges} per file it has opened
 * to edit or applied an edit to, and the proof an edit passes when it is queued and again when it
 * is approved. The binding keeps one for its activation, so a file's gate and lane are shared by
 * every session that opens it.
 */
export class DriveFileEditors {
  #options: DriveFileEditorsOptions;
  #files = new Map<string, QueuedChanges<DriveRecord, unknown>>();
  /**
   * Each document's writes landed, kept beside its QueuedChanges for the activation: a read
   * waiting on Google when a write lands reads again, and no session reuses a snapshot from
   * before it. `source` is the source its sessions share, held for the documents opened most
   * recently, which the map's order tells: it holds which copy a read approved, and the
   * document is in the store. `moves` counts the binding's writes that moved
   * the document's revision and are not among the writes landed: a snapshot fetched before one
   * builds no write.
   */
  #docCaches = new Map<string, {
    cache: GoogleDocSimulationCacheHolder; source?: DriveDocSource; moves: number;
  }>();

  /** The limits of the copies the binding's store keeps; one for the activation. */
  #docLimits: DriveDocCopyLimits;

  constructor(options: DriveFileEditorsOptions) {
    this.#options = options;
    this.#docLimits = new DriveDocCopyLimits({
      store: options.docStore,
      pendingDocs: () => new Set(options.journal.listUndecided().flatMap(({ action }) => {
        let edited = editedFile(action);
        return edited?.editor === "docs" ? [edited.target.fileId] : [];
      })),
      removed: (fileId, why) => logger.info("removed a Google Doc's stored copy", {
        event: `google.doc.copy.${why.event}`, fileId, reason: why.reason,
      }),
      ...(options.docCaps ? { caps: options.docCaps } : {}),
      kv: options.kv,
    });
  }

  /** The change queue of a presentation a session opened, found as `target`. */
  slides(target: DriveWriteTargetPayload, queue: ActionSubmitter): SlidesChangeQueue {
    let changes = this.#changes<SlidesAction>("slides", target.fileId);
    return {
      snapshot: read => changes.snapshot(read),
      queue: (kind, prepare) => changes.queue(
        async () => {
          // Inside the turn, so changes sent together are checked and queued in the order sent.
          await this.#requireEditable("slides", target);
          return prepare();
        },
        change => this.#options.submit(queue, kind, { target, change })),
    };
  }

  /** The change queue of a spreadsheet a session opened, found as `target`. */
  sheets(target: DriveWriteTargetPayload, queue: ActionSubmitter): SheetsChangeQueue {
    let changes = this.#changes<SheetsAction>("sheets", target.fileId);
    // Each number is noted in the step that allocates it, so a sweep keeps the spreadsheet's state
    // while the journal holds the change, a change no submission answer reached included.
    let noting: ActionSubmitter = {
      submitAction: (id, description) => {
        this.#updateSheets(target.fileId, state => ({ ...state, queued: [...state.queued, id] }));
        return queue.submitAction(id, description);
      },
    };
    return {
      snapshot: read => changes.snapshot(read),
      queue: (kind, prepare) => changes.queue(
        async () => {
          await this.#requireEditable("sheets", target);
          return prepare();
        },
        change => this.#options.submit(noting, kind, { target, change })),
      // The proof that opened the change's turn found the file editable.
      editable: () => Promise.resolve(true),
    };
  }

  /** The host an approved change to spreadsheet `fileId` is written with. */
  sheetsHost(fileId: string): DriveSheetsHost {
    return {
      api: this.#options.sheets,
      spreadsheetId: fileId,
      applied: id => this.#sheetsState(fileId).applied.includes(id),
      markers: {
        read: () => this.#sheetsState(fileId).markers
          .map(entry => typeof entry === "number" ? { id: entry, sentAt: 0 } : entry),
        write: entries => this.#updateSheets(fileId, state =>
          ({ ...state, markers: retainedMarkers(entries, Date.now()) })),
      },
      now: () => Date.now(),
      recordApplied: id => this.#updateSheets(fileId, state => ({
        ...state,
        applied: [...state.applied.filter(applied => applied !== id), id].slice(-MAX_APPLIED),
        queued: state.queued.filter(queued => queued !== id),
      })),
    };
  }

  /**
   * The change queue of a document a session opened, found as `target`. Its reads do not enter
   * the file's gate, as on a document's own binding: they overlap its approvals, and are kept
   * right by the write markers, the receipt and the writes landed.
   */
  docs(target: DriveWriteTargetPayload, queue: ActionSubmitter): DocChangeQueue {
    let { fileId } = target;
    let changes = this.#changes<{ payload: GoogleDocAction }>("docs", fileId);
    return {
      ...this.#docQueue(fileId),
      cache: this.#docCache(fileId),
      queue: prepare => changes.queue(
        async () => {
          await this.#requireEditable("docs", target);
          let { action, result } = await prepare();
          return { payload: action, result };
        },
        change => this.#options.submit(queue, change.type, { target, change })),
      afterTurns: () => changes.afterTurns(),
      // A Drive binding adds no tab, so no tab ID is ever provisional.
      adoptedTabId: tabId => tabId,
      // The read records, for the chat that queues the edit, the file its approval card shows.
      authorizesPreparation: true,
      simulates: true,
    };
  }

  /** What document `fileId`'s source learns of the binding's writes to it and of its queue. */
  #docsFreshness(fileId: string): DocFreshness {
    return {
      writes: () => this.#docCache(fileId).writes,
      newestQueued: () => Math.max(0, ...this.#docsPending(fileId).map(({ id }) => id)),
      revisionMoves: () => this.#docEntry(fileId).moves,
    };
  }

  /**
   * The source of document `fileId`, which `open` makes when the binding holds none: every session
   * this binding opens on the document reads the snapshot the last authorized read approved, so
   * their replays share one copy. A source holds which copy a read approved, and a document just
   * fetched until its read is decided; the binding keeps those of the `MAX_DOC_SOURCES`
   * documents opened most recently, and a session opened on another keeps the source it was
   * given.
   */
  docsSource(fileId: string, open: (freshness: DocFreshness) => DriveDocSource): DriveDocSource {
    let entry = this.#docEntry(fileId);
    // Insertion order is recency: the entry moves to the end, and only its source is ever cleared,
    // since a session still open on a source let go compares the writes counted in `cache`.
    this.#docCaches.delete(fileId);
    this.#docCaches.set(fileId, entry);
    entry.source ??= open(this.#docsFreshness(fileId));
    let held = [...this.#docCaches.values()].filter(({ source }) => source);
    for (let stale of held.slice(0, -MAX_DOC_SOURCES)) stale.source = undefined;
    return entry.source;
  }

  /**
   * What document `fileId`'s source needs of the store, with the file's pending edits and the
   * binding's limits: a keep brings the binding's store under its caps.
   */
  docCopies(fileId: string): DriveDocCopies {
    return driveDocCopies(this.#options.docStore, fileId,
      store => pendingDocKeys(store, fileId, this.#docsPending(fileId)), this.#docLimits);
  }

  /**
   * Told that a folder session was refused file `fileId` (`DriveFolderSessionCoreOptions.
   * refused`). Where the binding's store keeps a copy of that file and the binding does not
   * reach the file (`unreachedBy`: at most one Drive request, the file's parent folder), the
   * copy is removed with everything stored for it, and the removal logged. Nothing is asked
   * of Drive, and no table is made, where no copy of the file is stored. A copy another read
   * fetched, kept or approved under another folder or in another hour while Drive was asked
   * stays. Never throws: a failed request, and a failure of storage, is logged and leaves
   * the copy.
   *
   * It is told of EVERY id a folder session is refused, at any of the places a file is
   * proved a direct child: a folder's, a spreadsheet's and a move target's as a Doc's. No
   * copy is stored under such an id, so each costs one row read (of the storage's schema
   * where it holds no Doc table, of `doc_copy` by its key where it does) and no request. The
   * first one of an activation whose storage holds Doc tables also makes the store, as that
   * activation's first read of a Doc would.
   *
   * The copy is dropped in a transaction of its own, after the request's answer and before
   * the refusal is thrown; the refusing session holds no transaction open there.
   */
  async docRefused(
    fileId: string, file: DriveScopeNode | undefined, path: readonly DriveScopeNode[],
  ): Promise<void> {
    try {
      let seen = this.#docLimits.stored(fileId);
      if (!seen) return;
      let why = await unreachedBy(
        file, path, seen.folder, ids => this.#options.drive.getScopeNodes(ids));
      if (why) this.#docLimits.remove(fileId, seen, { event: "unreachable", reason: why });
    } catch (error) {
      logger.warn("failed to check whether the connection reaches a refused Google Doc", {
        event: "google.doc.copy.reach.failed", fileId, error,
      });
    }
  }

  /**
   * Records that a comment write of the binding's reached file `fileId`, or may have. In a
   * Google Doc one anchored to text, and a suggestion, is a batch of the document, which moves
   * its revision: the snapshot held of a document then builds no write. A suggestion also
   * changes what the text reads as, so the stored copy is marked stale and reads fetch again.
   * Does nothing for a file no session opened as a document.
   */
  commented(fileId: string, suggestion = false): void {
    let entry = this.#docCaches.get(fileId);
    if (!entry) return;
    entry.moves++;
    if (suggestion) {
      entry.cache.writes++;
      this.docCopies(fileId).wrote();
    }
  }

  /** The host an approved edit to document `fileId` is written with. */
  docsHost(fileId: string): DocHost {
    let key = `${DOC_RECEIPT_PREFIX}${fileId}`;
    let { kv } = this.#options;
    return {
      api: this.#options.docs,
      documentId: fileId,
      mimeType: async () => (await this.#options.drive.getFile(fileId)).mimeType,
      receipt: () => this.#docReceipt(fileId),
      clearReceipt: markerId => {
        if (this.#docReceipt(fileId)?.markerId !== markerId) return;
        kv.delete(key);
        // The marker is out of the document, and its deletion moved the revision.
        this.#docEntry(fileId).moves++;
      },
      saved: () => { throw new Error("A Drive binding adds no Doc tabs."); },
      // The record is the action set's to retire, once this returns: the marker is deleted only
      // after that, so that a read, and an approval tried again, find the write proven meanwhile.
      landed: (id, marker) => {
        if (marker) {
          kv.put<GoogleDocWriteReceipt>(key, { actionId: id, markerId: marker.id, tabId: marker.tabId });
        }
        this.#docCache(fileId).writes++;
        // The stored copy lacks the write, so it is marked stale where the write is counted. A
        // source fetches after a landed write whatever storage says, so this adds no request.
        this.docCopies(fileId).wrote();
      },
      // The action set fails this edit. The text edits behind it stay queued for what replays their
      // tab next: a read of that tab or a write to it, or the next approval that leaves changes
      // queued.
      unapplyable: async (id, action) => {
        if (action.type === "addTab") throw new Error("A Drive binding adds no Doc tabs.");
        this.#failTableChangesBehind(
          fileId, id, action, `Pending Google Doc edit could not be applied after edit ${id} failed`);
      },
      // The source's own rules say when its snapshot may build a write.
      heldCopy: () => this.#docEntry(fileId).source?.held(),
      spendCopy: copy => this.#docEntry(fileId).source?.spend(copy),
      // No scope check guards this fetch, so nothing of it is kept: it is stored as it is read,
      // for the length of `use`.
      tryFetched: (document, use) => this.docCopies(fileId).tryFetched(document, Date.now(), use),
    };
  }

  /**
   * Fails the table changes queued behind `edit`, edit `id` of document `fileId`, which leaves
   * the queue unapplied: they recorded their tables as it left them, and no document is in hand
   * here to replay them over. Does nothing behind an edit that changes no table's structure or
   * cell text.
   */
  #failTableChangesBehind(
    fileId: string, id: number, edit: GoogleDocEditAction, context: string,
  ): void {
    invalidateTableChangesBehind(
      this.#docQueue(fileId), closesTableGate(edit) ? edit.tabId : undefined, id, context);
  }

  /**
   * {@link #failTableChangesBehind} for edit `id` of document `fileId`, refused for good before
   * any Docs request: the file or the connection is out of reach, and a file can come back, when
   * the changes behind would be approved over a document this edit never changed.
   */
  #docEditRefused(fileId: string, id: number): void {
    let record = this.#options.journal.get(id);
    let edit = record &&
      editOf<{ payload: GoogleDocAction }>("docs", fileId, record.action)?.payload;
    if (!edit || edit.type === "addTab") return;
    this.#failTableChangesBehind(
      fileId, id, edit, `Pending Google Doc edit could not be applied after edit ${id} was refused`);
  }

  /**
   * What follows an edit to document `fileId` once the action set has retired its record: its
   * marker is deleted, and the edits queued behind it are replayed over the new revision, failing
   * any that no longer applies.
   */
  async #afterDocApplied(fileId: string, actionId: number): Promise<void> {
    let receipt = this.#docReceipt(fileId);
    if (receipt?.actionId === actionId) {
      try {
        if (receipt.tabId === undefined) throw new Error("The write receipt names no tab.");
        await this.#options.docs.deleteNamedRange(fileId, receipt.markerId, receipt.tabId);
        this.docsHost(fileId).clearReceipt(receipt.markerId);
      } catch (error) {
        logger.warn("failed to clean up Google Doc write marker", {
          event: "google.doc.write-marker.cleanup.failed", actionId, error,
        });
      }
    }
    if (this.#docsPending(fileId).length === 0) return;
    try {
      // An edit queued, or a write landed, while the request is out may have been checked against a
      // newer revision than the one it answers, so the document is read again. A queue that keeps
      // moving is left to what replays it next: a read of a tab or a write to it replays that tab's
      // edits, and the next approval that leaves changes queued replays every tab that has some.
      let freshness = this.#docsFreshness(fileId);
      for (let attempt = 0; attempt < MAX_REFRESHES; attempt++) {
        let writes = freshness.writes();
        let queued = freshness.newestQueued();
        let document = await this.#options.docs.getDocument(fileId);
        if (writes !== freshness.writes() || queued !== freshness.newestQueued()) continue;
        // No scope check guards this fetch, so nothing of it is kept: it is stored as it is
        // read, for the length of the replay.
        this.docCopies(fileId).tryFetched(document, Date.now(), copy =>
          replayGoogleDocActions(
            this.#docQueue(fileId), copy,
            `Pending Google Doc edits could not be replayed after edit ${actionId} was applied`));
        return;
      }
    } catch (error) {
      logger.warn("failed to refresh Google Doc simulation after applying action", {
        event: "google.doc.simulation.refresh.failed", error,
      });
    }
  }

  /**
   * Document `fileId`'s edits awaiting a decision, oldest first, less the one whose write the
   * receipt says landed: its content is in the document, and replaying it would show it twice.
   */
  #docsPending(fileId: string): GoogleDocPendingAction[] {
    let landed = this.#docReceipt(fileId)?.actionId;
    return this.#changes<{ payload: GoogleDocAction }>("docs", fileId).pending()
      .flatMap(({ id, action }) => id === landed ? [] : [{ id, action: action.payload }]);
  }

  /** Fails, in the journal, an edit that can no longer be replayed. */
  #docsInvalidator(): GoogleDocInvalidator {
    return ({ id }, reason) => this.#options.journal.markFailed(id, reason);
  }

  #docReceipt(fileId: string): GoogleDocWriteReceipt | undefined {
    return parseGoogleDocWriteReceipt(this.#options.kv.get<unknown>(`${DOC_RECEIPT_PREFIX}${fileId}`));
  }

  #docEntry(fileId: string) {
    let entry = this.#docCaches.get(fileId);
    if (!entry) this.#docCaches.set(fileId, entry = { cache: { writes: 0 }, moves: 0 });
    return entry;
  }

  #docCache(fileId: string): GoogleDocSimulationCacheHolder {
    return this.#docEntry(fileId).cache;
  }

  /** Document `fileId`'s edits awaiting a decision, as a replay lists and fails them. */
  #docQueue(fileId: string): GoogleDocReplayQueue {
    return {
      pending: () => this.#docsPending(fileId),
      invalidate: this.#docsInvalidator(),
    };
  }

  /**
   * Drops what no change can still need: a spreadsheet's state once the journal holds none of the
   * numbers noted in it and no marker it keeps can still land, and past those, all but the
   * spreadsheets written most recently. A Doc's receipt is kept: it outlives its edit only while
   * the marker it names is still in the document, which the next edit to that Doc deletes.
   * The connection calls it as each session starts, so it ends with the expiry pass of the
   * binding's stored Docs where one is due.
   */
  sweep(): void {
    let { kv, journal } = this.#options;
    let now = Date.now();
    let idle: [string, SheetsFileState][] = [];
    for (let [key, state] of kv.list<SheetsFileState>({ prefix: SHEETS_STATE_PREFIX })) {
      let queued = state.queued.filter(id => journal.get(id) !== undefined);
      let landing = state.markers.some(entry =>
        typeof entry !== "number" && now < entry.sentAt + MARKER_RETENTION_MS);
      if (queued.length > 0 || landing) {
        if (queued.length !== state.queued.length) kv.put(key, { ...state, queued });
      } else {
        idle.push([key, state]);
      }
    }
    // Its markers' later deletion and its applied numbers serve no change still queued.
    for (let [key] of idle.toSorted((a, b) => b[1].at - a[1].at).slice(MAX_IDLE_SHEETS)) {
      kv.delete(key);
    }
    this.tendDocCopies();
  }

  /**
   * Runs the expiry pass of the binding's stored Docs where one is due
   * (`DriveDocCopyLimits.expire`): at most once an hour, and a number compared otherwise.
   * The connection calls it at each of its entries that is no session's start: an
   * approval and a rejection, of any record. Never call it inside a transaction.
   */
  tendDocCopies(): void {
    this.#docLimits.expire();
  }

  #sheetsState(fileId: string): SheetsFileState {
    return this.#options.kv.get<SheetsFileState>(`${SHEETS_STATE_PREFIX}${fileId}`) ??
      { markers: [], applied: [], queued: [], at: 0 };
  }

  #updateSheets(fileId: string, update: (state: SheetsFileState) => SheetsFileState): void {
    this.#options.kv.put(`${SHEETS_STATE_PREFIX}${fileId}`,
      { ...update(this.#sheetsState(fileId)), at: Date.now() });
  }

  /**
   * Applies edit `actionId` in its file's turn, once the binding's access and the file are proved
   * again, or answers `undefined` for a record that is no edit. A refusal a later approval can
   * pass leaves the edit pending; any other fails it for good.
   */
  apply(actionId: number): Promise<void> | undefined {
    let edited = this.#edited(actionId);
    if (!edited) return undefined;
    let { editor, target } = edited;
    return this.#changes(editor, target.fileId).apply(actionId, async () => {
      // Before the action set claims the record: a proof cut short by a lost activation must not
      // leave a claim, which the next approval would fail as of unknown outcome.
      // It is proved again inside the action set's queue (see prove()), since an approval ahead
      // of it there, such as a move, can take the file out of reach meanwhile.
      let state = this.#options.journal.get(actionId)?.state;
      if (state === "staged" || state === "pending") {
        let refusal = await this.#refusal(editor, target);
        if (refusal) {
          if (!refusal.liftable) {
            this.#options.journal.markSubmitted(actionId);
            this.#options.journal.markFailed(actionId, refusal.message, { undispatched: true });
            if (editor === "docs") this.#docEditRefused(target.fileId, actionId);
          }
          throw new Error(refusal.message);
        }
      }
      try {
        await this.#options.apply(actionId);
        if (editor === "docs") await this.#afterDocApplied(target.fileId, actionId);
      } finally {
        // The record is retired, or failed for good: what it alone reached goes with it.
        if (editor === "docs") this.docCopies(target.fileId).sweep();
      }
    });
  }

  /** {@link DriveEditorHosts.prove}: the proof repeated as the action set applies edit `id`. */
  async prove(editor: DriveEditorName, target: DriveWriteTargetPayload, id: number): Promise<void> {
    let refusal = await this.#refusal(editor, target);
    if (!refusal) return;
    if (refusal.liftable) throw new Error(refusal.message);
    if (editor === "docs") this.#docEditRefused(target.fileId, id);
    throw new ActionApplyError(refusal.message);
  }

  /** Rejects edit `actionId` in its file's turn, or answers `undefined` for a record that is no edit. */
  reject(actionId: number): Promise<void | { restart?: boolean }> | undefined {
    let edited = this.#edited(actionId);
    if (!edited) return undefined;
    let { editor, target } = edited;
    return this.#changes(editor, target.fileId).reject(actionId, async () => {
      // Read before the action set removes the record: one already failed leaves nothing to
      // settle behind it.
      let waiting = editor === "docs"
        ? this.#docsPending(target.fileId).find(({ id }) => id === actionId)?.action : undefined;
      let result = await this.#options.reject(actionId);
      // The text edits behind it stay queued, as on a Doc's own binding, for what replays their tab
      // next: a read of that tab or a write to it, or the next approval that leaves changes queued.
      if (waiting && waiting.type !== "addTab") {
        this.#failTableChangesBehind(target.fileId, actionId, waiting,
          `Pending Google Doc edits could not be replayed after edit ${actionId} was rejected`);
      }
      // The record is gone: what it alone reached goes with it.
      if (editor === "docs") this.docCopies(target.fileId).sweep();
      return result;
    });
  }

  #edited(actionId: number) {
    let record = this.#options.journal.get(actionId);
    return record && editedFile(record.action);
  }

  /** The one {@link QueuedChanges} of file `fileId`, made the first time it is asked for. */
  #changes<C>(editor: DriveEditorName, fileId: string): QueuedChanges<DriveRecord, C> {
    let key = `${editor}:${fileId}`;
    let changes = this.#files.get(key);
    if (!changes) {
      changes = new QueuedChanges<DriveRecord, unknown>({
        journal: this.#options.journal,
        select: action => editOf(editor, fileId, action),
        outOfOrder: () => EDIT_OUT_OF_ORDER,
      });
      this.#files.set(key, changes);
    }
    return changes as QueuedChanges<DriveRecord, C>;
  }

  async #requireEditable(editor: DriveEditorName, target: DriveWriteTargetPayload): Promise<void> {
    let refusal = await this.#refusal(editor, target);
    if (refusal) throw new Error(refusal.message);
  }

  /**
   * Why an edit of `target` cannot be made now: the binding may not make changes, or the file has
   * left its scope, is in the trash, is no longer a file `editor` edits, or cannot be edited by
   * the connected account.
   */
  async #refusal(
    editor: DriveEditorName, target: DriveWriteTargetPayload,
  ): Promise<EditRefusal | undefined> {
    let refused = await this.#options.writeRefusal();
    if (refused !== undefined) return { message: refused, liftable: isLiftable(refused) };
    let file = await this.#options.locate(target);
    let message = !file || file.mimeType !== editorMimeType(editor) ? EDIT_OUT_OF_SCOPE
      : file.trashed !== false ? EDIT_IN_TRASH
      : file.canEdit !== true ? EDIT_NOT_ALLOWED
      : undefined;
    return message === undefined ? undefined : { message, liftable: false };
  }
}
