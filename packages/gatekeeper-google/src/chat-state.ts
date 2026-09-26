// Pending Chat actions and the read-time overlay that simulates them.
//
// An action submitted for approval is not sent to Google until applyAction() runs, but every read
// through this gatekeeper reflects the queued writes: a queued message appears in the space's
// history, a queued edit shows its new text, and the connected user's queued reactions appear in
// (or vanish from) the detailed reaction list. Aggregate
// reaction counts stay provider-backed, because a count does not say whether the connected user
// is already included in it.
//
// The overlay is computed at read time rather than by mutating a cache, so rejecting an action
// simply removes it and the next read is correct again. Every function here is pure and takes the
// paging position it needs as arguments, which is what lets the simulation be tested without a
// Durable Object and keeps a page's result independent of what earlier pages returned.

import type {
  ChatListMessagesOptions, ChatMessageInfo, ChatReaction, ChatUser,
} from "./chat-types";
import { chatTimeInWindow } from "./chat-api";

type ChatActionBase = { submittedAt: number };

export type ChatSendMessageAction = ChatActionBase & {
  type: "sendMessage";
  spaceName: string;
  text: string;
  /** Set when the message is a threaded reply. */
  threadName?: string;
  /** A top-level send in a conversation that supports threading. */
  startsThread?: boolean;
  /** Makes the eventual create idempotent across a retried apply. */
  requestId: string;
};

export type ChatUpdateMessageAction = ChatActionBase & {
  type: "updateMessage";
  messageName: string;
  /** Needed to scope an edit whose target still has a temporary message ID. */
  spaceName?: string;
  text: string;
};

export type ChatReactionAction = ChatActionBase & {
  type: "addReaction" | "removeReaction";
  messageName: string;
  emoji: string;
};

export type ChatAction =
  | ChatSendMessageAction
  | ChatUpdateMessageAction
  | ChatReactionAction;

/** A stored action together with the id the approval queue knows it by. */
export type PendingChatAction = { id: number; action: ChatAction };

/** Prefix of the temporary name a submitted-but-uncommitted message carries. */
const PENDING_MESSAGE_PREFIX = "pending:send:";
const PENDING_THREAD_PREFIX = "pending:thread:";

export function pendingMessageName(actionId: number): string {
  return `${PENDING_MESSAGE_PREFIX}${actionId}`;
}

/** The action id inside a pending message name, or undefined when it is not one. */
export function pendingMessageActionId(name: string): number | undefined {
  return pendingActionId(name, PENDING_MESSAGE_PREFIX);
}

/** The temporary thread name anchored to a queued root message. */
export function pendingThreadName(actionId: number): string {
  return `${PENDING_THREAD_PREFIX}${actionId}`;
}

/** The root send action id inside a temporary thread name. */
export function pendingThreadActionId(name: string): number | undefined {
  return pendingActionId(name, PENDING_THREAD_PREFIX);
}

function pendingActionId(name: string, prefix: string): number | undefined {
  if (!name.startsWith(prefix)) return undefined;
  const id = Number(name.slice(prefix.length));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** The space an action affects, used to keep one space's overlay out of another's reads. */
export function chatActionSpaceName(action: ChatAction): string {
  if (action.type === "sendMessage") return action.spaceName;
  if (action.type === "updateMessage" && action.spaceName) return action.spaceName;
  return action.messageName.slice(0, action.messageName.indexOf("/messages/"));
}

/** How a queued message looks while it waits to be committed. */
export function pendingMessageInfo(
  id: number,
  action: ChatSendMessageAction,
  self: ChatUser,
): ChatMessageInfo {
  const threadName = action.threadName ?? (action.startsThread ? pendingThreadName(id) : undefined);
  return {
    id: pendingMessageName(id),
    spaceId: action.spaceName,
    ...(threadName !== undefined ? { threadId: threadName } : {}),
    sender: self,
    text: action.text,
    createdAt: new Date(action.submittedAt),
    isReply: action.threadName !== undefined,
    deleted: false,
    attachments: [],
    reactions: [],
    pending: true,
  };
}

/** Apply every pending edit that targets a message, whether or not its post has completed. */
export function overlayMessage(
  info: ChatMessageInfo,
  pending: readonly PendingChatAction[],
): ChatMessageInfo {
  let result = info;
  for (const { action } of pending) {
    // Edited text must not resurface on a record the provider has deleted.
    if (action.type === "updateMessage" && action.messageName === info.id && !result.deleted) {
      result = { ...result, text: action.text, editedAt: new Date(action.submittedAt) };
    }
  }
  return result;
}

/** Whether a queued message belongs in a listing with these filters. */
function pendingSendMatches(
  id: number,
  action: ChatSendMessageAction,
  spaceName: string,
  options: ChatListMessagesOptions,
  threadName?: string,
): boolean {
  if (action.spaceName !== spaceName) return false;
  const target = action.threadName ?? (action.startsThread ? pendingThreadName(id) : undefined);
  return (threadName === undefined || target === threadName) &&
    chatTimeInWindow(new Date(action.submittedAt), options);
}

/**
 * Overlay one page of a space's messages.
 *
 * Queued sends are the newest messages, so they join the final page when paging oldest-first and
 * the first page when paging newest-first.
 */
export function overlayMessageList(
  messages: readonly ChatMessageInfo[],
  pending: readonly PendingChatAction[],
  context: {
    spaceName: string;
    self: ChatUser;
    options: ChatListMessagesOptions;
    threadName?: string;
    /** Whether this is the first provider page. */
    first: boolean;
    /** Whether the provider has no page after this one. */
    exhausted: boolean;
  },
): ChatMessageInfo[] {
  const result = messages
    .map(message => overlayMessage(message, pending))
    .filter(message => !message.deleted);
  const newestFirst = context.options.order === "newestFirst";
  if (newestFirst ? !context.first : !context.exhausted) return result;

  const queued = pending.flatMap(({ id, action }) =>
    action.type === "sendMessage" &&
      pendingSendMatches(id, action, context.spaceName, context.options, context.threadName)
      ? [overlayMessage(pendingMessageInfo(id, action, context.self), pending)]
      : []);
  return newestFirst ? [...queued.toReversed(), ...result] : [...result, ...queued];
}

/**
 * Overlay one page of reactions with the connected user's queued changes.
 *
 * Any emoji the connected user has a queued change for is removed from the provider's pages
 * wherever it appears, and the ones queued to be present are appended once, on the final page.
 * Dropping the provider's copy even when the queued change is an add keeps each page independent
 * of the others: no page needs to know whether an earlier one already showed that reaction.
 */
export function overlayReactions(
  reactions: readonly ChatReaction[],
  pending: readonly PendingChatAction[],
  context: { messageName: string; self: ChatUser; exhausted: boolean },
): ChatReaction[] {
  const desired = new Map<string, { present: boolean; actionId: number }>();
  for (const { id, action } of pending) {
    if ((action.type === "addReaction" || action.type === "removeReaction") &&
        action.messageName === context.messageName) {
      desired.set(action.emoji, { present: action.type === "addReaction", actionId: id });
    }
  }
  const result = reactions.filter(reaction =>
    reaction.user?.id !== context.self.id || !desired.has(reaction.emoji));
  if (!context.exhausted) return result;
  for (const [emoji, change] of desired) {
    if (change.present) {
      result.push({
        id: `${context.messageName}/reactions/pending-${change.actionId}`,
        emoji,
        user: context.self,
      });
    }
  }
  return result;
}
