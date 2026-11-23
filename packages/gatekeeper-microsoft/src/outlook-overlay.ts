// Pending changes, as reads see them: a message moved, flagged or deleted reads back that way, a
// folder or draft not yet created is listed with `pending` set, and a draft being sent says so.
// Nothing here reads Graph. Sessions read what Exchange holds and pass it through `apply`, so a
// simulated change only relabels what the guard already admitted: a message a pending action moves
// into the listed folder is fetched by ID and guarded like any other.

import type { JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import type { MessageInfo } from "./outlook-types";
import type { Composed, OutlookAction, OutlookActions } from "./outlook-actions";

type Pending = readonly JournalEntry<OutlookAction>[];

/** A folder a pending action creates. */
export type PendingFolder = { id: string; name: string; parentId: string };

/** A draft a pending action creates, as `MessageInfo` needs it. */
export type PendingDraft = { id: string; message: Composed; origin: OutlookActions["createDraft"]["origin"]; submittedAt: number };

/** The pending actions of a binding, indexed for reads. */
export class OutlookOverlay {
  /** Where pending moves put each message: a folder ID (real or `~N`). */
  readonly moved = new Map<string, string>();
  /** Messages pending deletion, which reads leave out unless they list Deleted Items. */
  readonly deleted = new Set<string>();
  readonly updates = new Map<string, OutlookActions["updateMessages"]["change"][]>();
  readonly folders: PendingFolder[] = [];
  readonly drafts = new Map<string, PendingDraft>();
  /** The latest pending edit of each draft, by its ID (real or `~N`). */
  readonly draftEdits = new Map<string, Composed>();
  readonly deletedDrafts = new Set<string>();
  /** Drafts (real or `~N`) a pending action sends, and messages composed straight to sending. */
  readonly sending = new Set<string>();
  readonly sends: OutlookActions["send"][] = [];

  constructor(pending: Pending, resolve: (id: string) => string) {
    for (const { action } of pending) {
      switch (action.kind) {
        case "moveMessages":
          for (const message of action.payload.messages) {
            this.moved.set(message.id, resolve(action.payload.to.id));
            if (action.payload.as === "delete") this.deleted.add(message.id);
            else this.deleted.delete(message.id);
          }
          break;
        case "updateMessages":
          for (const message of action.payload.messages) {
            this.updates.set(message.id, [...(this.updates.get(message.id) ?? []), action.payload.change]);
          }
          break;
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
        case "setAutomaticReplies":
          break;
      }
    }
  }

  /** Whether reads leave a message out: a draft pending deletion. (A deleted message reads as moved to Deleted Items.) */
  hides(id: string): boolean {
    return this.deletedDrafts.has(id);
  }

  /** A message as it will be once the pending changes apply. `folderName` gives a moved-to folder's path. */
  apply(info: MessageInfo, folderName: (folderId: string) => string): MessageInfo {
    let result = info;
    const movedTo = this.moved.get(info.id);
    if (movedTo !== undefined && movedTo !== info.folderId) {
      result = { ...result, folderId: movedTo, folder: folderName(movedTo), pending: this.deleted.has(info.id) ? "delete" : "move" };
    }
    for (const change of this.updates.get(info.id) ?? []) {
      const categories = new Map(result.categories.map(name => [name.toLowerCase(), name]));
      for (const name of change.addCategories ?? []) categories.set(name.toLowerCase(), name);
      for (const name of change.removeCategories ?? []) categories.delete(name.toLowerCase());
      result = {
        ...result,
        ...(change.isRead !== undefined ? { isRead: change.isRead } : {}),
        ...(change.flag ? { flag: change.flag.status === "flagged" && change.flag.dueAt ? { status: "flagged", dueAt: change.flag.dueAt } : { status: change.flag.status } } : {}),
        categories: [...categories.values()],
        pending: result.pending ?? "update",
      };
    }
    const edit = this.draftEdits.get(info.id);
    if (edit && info.isDraft) result = { ...result, ...composedFields(edit), pending: result.pending ?? "update" };
    if (this.sending.has(info.id)) result = { ...result, pending: "send" };
    return result;
  }

  /** Drafts pending creation, as messages in Drafts. */
  pendingDrafts(draftsFolder: { id: string; path: string }, mailbox: { address: string; name?: string }): MessageInfo[] {
    return [...this.drafts.values()]
      .filter(draft => !this.deletedDrafts.has(draft.id))
      .map(draft => this.apply(pendingDraftInfo(draft, draftsFolder, mailbox), () => draftsFolder.path));
  }
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
