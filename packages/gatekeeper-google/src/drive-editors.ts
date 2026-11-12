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

import type {
  ActionDefinition, ActionJournal, ActionPresentation, ActionSubmitter,
} from "@gadgets/gatekeeper-kit/actions";
import { ActionDescriptionBuilder } from "@gadgets/gatekeeper-kit/action-description";
import type { DriveScopeNode } from "./drive-api";
import { GOOGLE_SLIDES_MIME_TYPE } from "./drive-session";
import { isLiftable, type DriveWriteTargetPayload } from "./drive-writes";
import { QueuedChanges } from "./queued-changes";
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
export type DriveEditorName = "slides";

/** What applying an edit needs of the Drive gatekeeper: each editor's host for one file. */
export type DriveEditorHosts = {
  slides(fileId: string): SlidesHost;
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
      let result = await definition.apply(change, editor.host(drive, target.fileId), ctx);
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

/** Each editor, with the kind tag of each of its definitions by the definition's name. */
const EDITORS: { editor: { name: DriveEditorName; mimeType: string }; tags: Record<string, string> }[] = [
  { editor: SLIDES_EDITOR, tags: tagsOf(DRIVE_SLIDES_DEFINITIONS) },
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

/** What {@link DriveFileEditors} needs of its Drive gatekeeper. */
export type DriveFileEditorsOptions = {
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
};

/** Why an edit cannot be made now, and whether a later approval may pass that. */
type EditRefusal = { message: string; liftable: boolean };

/**
 * The edits of one read and write Drive binding: one {@link QueuedChanges} per file it has opened
 * to edit or applied an edit to, and the proof an edit passes when it is queued and again when it
 * is approved. The binding keeps one for its activation, so a file's gate and lane are shared by
 * every session that opens it.
 */
export class DriveFileEditors {
  #options: DriveFileEditorsOptions;
  #files = new Map<string, QueuedChanges<DriveRecord, unknown>>();

  constructor(options: DriveFileEditorsOptions) {
    this.#options = options;
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
      let state = this.#options.journal.get(actionId)?.state;
      if (state === "staged" || state === "pending") {
        let refusal = await this.#refusal(editor, target);
        if (refusal) {
          if (!refusal.liftable) {
            this.#options.journal.markSubmitted(actionId);
            this.#options.journal.markFailed(actionId, refusal.message, { undispatched: true });
          }
          throw new Error(refusal.message);
        }
      }
      await this.#options.apply(actionId);
    });
  }

  /** Rejects edit `actionId` in its file's turn, or answers `undefined` for a record that is no edit. */
  reject(actionId: number): Promise<void | { restart?: boolean }> | undefined {
    let edited = this.#edited(actionId);
    if (!edited) return undefined;
    return this.#changes(edited.editor, edited.target.fileId)
      .reject(actionId, () => this.#options.reject(actionId));
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
