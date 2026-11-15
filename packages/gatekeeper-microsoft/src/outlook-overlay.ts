// Pending changes, as reads see them: a message moved, flagged or deleted reads back that way, a
// folder or draft not yet created is listed with `pending` set, and a draft being sent says so.
// Nothing here reads Graph. Sessions read what Exchange holds and pass it through the fold, so a
// simulated change only relabels what the guard already admitted: a message a pending action moves
// into the listed folder is fetched by ID and guarded like any other.
//
// `messageStore` folds the actions pending on one message over it, oldest first, and `messageView`
// says which actions those are. A listing folds each row as it is served, so a row shows what is
// pending when its page is returned, however long before that it was read. `OutlookOverlay` is
// the same queue indexed once for what writes check and for what is not a message, and its
// `apply` and `pendingDrafts` read a message through that fold.

import type { JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import { createSimulationView, type SimulationView } from "@gadgets/gatekeeper-kit/simulation";
import { createSimulationStore, type SimulationStore } from "@gadgets/gatekeeper-kit/simulation-store";
import type { MessageInfo } from "./outlook-types";
import type { Composed, OutlookAction, OutlookActions } from "./outlook-actions";

type Pending = readonly JournalEntry<OutlookAction>[];

/** A folder a pending action creates. */
export type PendingFolder = { id: string; name: string; parentId: string };

/** A draft a pending action creates, as `MessageInfo` needs it. */
export type PendingDraft = { id: string; message: Composed; origin: OutlookActions["createDraft"]["origin"]; submittedAt: number };

/**
 * The pending actions of a binding, indexed for what writes check and for what is not a message
 * (folders, sends); `apply` and `pendingDrafts` read a message through `messageStore`. Every
 * temporary ID is resolved once, when the overlay is made, so its indexes, `apply` and
 * `pendingDrafts` read one state of the IDs however long a caller holds it across awaits.
 */
export class OutlookOverlay {
  /** Where pending moves put each message: a folder ID (real or `~N`). */
  readonly moved = new Map<string, string>();
  readonly folders: PendingFolder[] = [];
  readonly drafts = new Map<string, PendingDraft>();
  /** The latest pending edit of each draft, by its ID (real or `~N`). */
  readonly draftEdits = new Map<string, Composed>();
  readonly deletedDrafts = new Set<string>();
  /** Drafts (real or `~N`) a pending action sends, and messages composed straight to sending. */
  readonly sending = new Set<string>();
  readonly sends: OutlookActions["send"][] = [];
  /** The pending actions by the message each changes. */
  readonly #messages: SimulationView<Pending[number], string>;
  /** The folder each pending move names, by the ID its action holds, as it resolved. */
  readonly #destinations = new Map<string, string>();

  constructor(pending: Pending, resolve: (id: string) => string) {
    for (const { action } of pending) {
      switch (action.kind) {
        case "moveMessages": {
          const to = resolve(action.payload.to.id);
          this.#destinations.set(action.payload.to.id, to);
          for (const message of action.payload.messages) this.moved.set(message.id, to);
          break;
        }
        case "createFolder":
          this.folders.push({ id: action.payload.ref, name: action.payload.name, parentId: resolve(action.payload.parent.id) });
          break;
        case "createDraft":
          this.drafts.set(action.payload.ref, {
            id: action.payload.ref, message: action.payload.message, origin: action.payload.origin, submittedAt: action.payload.submittedAt,
          });
          break;
        case "updateDraft":
          this.draftEdits.set(resolve(action.payload.draftId), action.payload.message);
          break;
        case "deleteDraft":
          this.deletedDrafts.add(resolve(action.payload.draftId));
          break;
        case "send":
          if (action.payload.draft) this.sending.add(resolve(action.payload.draft.id));
          this.sends.push(action.payload);
          break;
        case "updateMessages":
        case "setAutomaticReplies":
          break;
      }
    }
    // The view indexes as it is made, so `resolve` is not kept.
    this.#messages = messageView(pending, resolve);
  }

  /** Whether reads leave a message out: a draft pending deletion. (A deleted message reads as moved to Deleted Items.) */
  hides(id: string): boolean {
    return this.deletedDrafts.has(id);
  }

  /**
   * A message as it will be once the pending changes apply. `folderName` gives a moved-to folder's
   * path. A draft pending deletion is still shown: `hides` is for the reads that list.
   */
  apply(info: MessageInfo, folderName: (folderId: string) => string): MessageInfo {
    const store = messageStore({
      destination: named => {
        const id = this.#destinations.get(named) ?? named;
        return { id, path: folderName(id) };
      },
    });
    const records = this.#messages.forTarget(info.id).filter(({ action }) => action.kind !== "deleteDraft");
    // With no deletion among them, the fold always holds a message.
    return store.fold(info.id, info, records).entity ?? info;
  }

  /** Drafts pending creation, as messages in Drafts, oldest first. */
  pendingDrafts(draftsFolder: { id: string; path: string }, mailbox: { address: string; name?: string }): MessageInfo[] {
    // Nothing moves a draft pending creation, so the destination is never asked for.
    const store = messageStore({ destination: id => ({ id, path: "" }), drafts: { folder: draftsFolder, mailbox } });
    return [...this.drafts.keys()].flatMap(ref => store.fold(ref, undefined, this.#messages.forTarget(ref)).entity ?? []);
  }
}

/**
 * The pending actions by the message each changes: a move or an update under every message it
 * names, a draft's creation under its temporary ID, and an edit, a deletion or a send of a draft
 * under the ID `resolve` gives the draft when the index is made. Folders, automatic replies and
 * messages composed straight to sending change no message a read holds, so they are under none.
 */
export function messageView(pending: Pending, resolve: (id: string) => string): SimulationView<Pending[number], string> {
  return createSimulationView(pending, action => {
    switch (action.kind) {
      case "moveMessages":
      case "updateMessages":
        return action.payload.messages.map(message => message.id);
      case "createDraft":
        return [action.payload.ref];
      case "updateDraft":
      case "deleteDraft":
        return [resolve(action.payload.draftId)];
      case "send":
        return action.payload.draft ? [resolve(action.payload.draft.id)] : [];
      default:
        return [];
    }
  });
}

/** Where a pending move puts a message: the folder as it is (a real ID, or `~N` until it is created) and its path. */
export type MoveDestination = { id: string; path: string };

/** What the message fold reads beside a message and an action. It is synchronous, so both are read ahead of it. */
export type MessageFoldOptions = {
  /**
   * The folder a pending move names, by the ID its action holds. Must answer the same for the
   * same ID for as long as the store is used, since the store remembers folds.
   */
  destination: (folderId: string) => MoveDestination;
  /**
   * Where drafts pending creation are listed and whose they are. Absent, the store folds only
   * the messages it is handed, and a draft's creation makes nothing.
   */
  drafts?: { folder: { id: string; path: string }; mailbox: { address: string; name?: string } };
};

/** The step of an action that leaves a message as it was. */
const UNCHANGED = { kind: "known-no-effect" } as const;

/** How much each `pending` says: a message shows the highest its pending actions reach. */
const RANK = { update: 1, draft: 2, move: 3, delete: 3, send: 4 } satisfies Record<NonNullable<MessageInfo["pending"]>, number>;

/** `message` marked `pending`, unless it already shows something that says more. A later move takes the place of an earlier one. */
function marked(message: MessageInfo, pending: NonNullable<MessageInfo["pending"]>): MessageInfo {
  return message.pending !== undefined && RANK[message.pending] > RANK[pending] ? message : { ...message, pending };
}

/** What a message shows beside where it is filed and what is pending on it, for comparing two readings of it. */
function shows({ folderId: _folderId, folder: _folder, pending: _pending, ...shown }: MessageInfo): string {
  return JSON.stringify(shown);
}

/**
 * A store that folds the pending actions on a message over it, as reads show it: moved, flagged,
 * edited or being sent, and gone once a pending action deletes it (a draft). A draft pending
 * creation starts as `options.drafts` places it.
 *
 * `pending` says the most a caller must know: `send`, over `move` or `delete`, over a pending
 * draft's `draft`, over `update`; an action raises it and none lowers it, but a move back. A
 * move is compared with the folder Exchange holds the message in, so one moved away and back
 * reads as never moved: pending `update` if it still shows a change an update or a draft edit
 * made, and not pending otherwise.
 */
export function messageStore(options: MessageFoldOptions): SimulationStore<string, MessageInfo, MessageInfo, Pending[number]> {
  return createSimulationStore<string, MessageInfo, MessageInfo, Pending[number]>({
    initial: message => message,
    reduce: (message, { action }, { base }) => {
      // A draft's creation makes it only where there is none.
      if (action.kind === "createDraft") {
        if (message !== undefined || !options.drafts) return UNCHANGED;
        const { ref, message: composed, origin, submittedAt } = action.payload;
        return { kind: "applied", value: pendingDraftInfo({ id: ref, message: composed, origin, submittedAt }, options.drafts.folder, options.drafts.mailbox) };
      }
      // Nothing changes a message Exchange does not hold, or a draft a pending action deleted.
      if (message === undefined) return UNCHANGED;
      switch (action.kind) {
        case "moveMessages": {
          const to = options.destination(action.payload.to.id);
          // A message Exchange does not hold has no folder to come back to: its move is a move away.
          if (to.id !== base?.folderId) {
            return { kind: "applied", value: marked({ ...message, folderId: to.id, folder: to.path }, action.payload.as === "delete" ? "delete" : "move") };
          }
          if (message.folderId === base.folderId) return UNCHANGED;
          // Back in the folder Exchange holds it in, it reads as never moved.
          const { pending, ...unmoved } = { ...message, folderId: base.folderId, folder: base.folder };
          if (pending === "send") return { kind: "applied", value: { ...unmoved, pending } };
          // The move's mark covered an update's, so whether a change is still pending is read from what the row shows.
          return { kind: "applied", value: shows(unmoved) === shows(base) ? unmoved : { ...unmoved, pending: "update" } };
        }
        case "updateMessages": {
          const { change } = action.payload;
          const categories = new Map(message.categories.map(name => [name.toLowerCase(), name]));
          for (const name of change.addCategories ?? []) categories.set(name.toLowerCase(), name);
          for (const name of change.removeCategories ?? []) categories.delete(name.toLowerCase());
          return {
            kind: "applied",
            value: marked({
              ...message,
              ...(change.isRead !== undefined ? { isRead: change.isRead } : {}),
              ...(change.flag ? { flag: change.flag.status === "flagged" && change.flag.dueAt ? { status: "flagged", dueAt: change.flag.dueAt } : { status: change.flag.status } } : {}),
              categories: [...categories.values()],
            }, "update"),
          };
        }
        case "updateDraft":
          return message.isDraft ? { kind: "applied", value: marked({ ...message, ...composedFields(action.payload.message) }, "update") } : UNCHANGED;
        case "deleteDraft":
          return { kind: "deleted" };
        case "send":
          return { kind: "applied", value: marked(message, "send") };
        default:
          return UNCHANGED;
      }
    },
  });
}

/** The fields of `MessageInfo` a composed message decides. */
function composedFields(message: Composed): Pick<MessageInfo, "subject" | "to" | "cc" | "bcc" | "importance" | "preview" | "hasAttachments"> {
  return {
    subject: message.subject,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    importance: message.importance,
    preview: preview(message.markdown),
    hasAttachments: message.attachments.length > 0,
  };
}

/** The first 255 characters of Markdown as plain text, as Outlook's `bodyPreview` is. */
export function preview(markdown: string): string {
  return markdown.replace(/[#>*_`~|[\]()-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 255);
}

function pendingDraftInfo(draft: PendingDraft, folder: { id: string; path: string }, mailbox: { address: string; name?: string }): MessageInfo {
  const at = new Date(draft.submittedAt).toISOString();
  return {
    id: draft.id,
    conversationId: draft.origin.kind === "new" ? "" : draft.origin.source.conversationId ?? "",
    folderId: folder.id,
    folder: folder.path,
    ...composedFields(draft.message),
    from: mailbox,
    senderKind: "you",
    receivedAt: at,
    isRead: true,
    isDraft: true,
    flag: { status: "notFlagged" },
    categories: [],
    webLink: "",
    pending: "draft",
  };
}
