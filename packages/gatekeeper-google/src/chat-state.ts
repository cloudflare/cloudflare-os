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
  GoogleChatListMessagesOptions, GoogleChatMessageInfo, GoogleChatReaction, GoogleChatUser,
} from "./chat-types";

type ChatActionBase = { submittedAt: number };

export type ChatSendMessageAction = ChatActionBase & {
  type: "sendMessage";
  spaceName: string;
  text: string;
  /** Set when the message is a threaded reply. */
  threadName?: string;
  /** Makes the eventual create idempotent across a retried apply. */
  requestId: string;
};

export type ChatUpdateMessageAction = ChatActionBase & {
  type: "updateMessage";
  messageName: string;
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

export function pendingMessageName(actionId: number): string {
  return `${PENDING_MESSAGE_PREFIX}${actionId}`;
}

/** The action id inside a pending message name, or undefined when it is not one. */
export function pendingMessageActionId(name: string): number | undefined {
  if (!name.startsWith(PENDING_MESSAGE_PREFIX)) return undefined;
  const id = Number(name.slice(PENDING_MESSAGE_PREFIX.length));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** The space an action affects, used to keep one space's overlay out of another's reads. */
export function chatActionSpaceName(action: ChatAction): string {
  return action.type === "sendMessage"
    ? action.spaceName
    : action.messageName.slice(0, action.messageName.indexOf("/messages/"));
}

/** How a queued message looks while it waits to be committed. */
export function pendingMessageInfo(
  id: number,
  action: ChatSendMessageAction,
  self: GoogleChatUser,
): GoogleChatMessageInfo {
  return {
    name: pendingMessageName(id),
    spaceName: action.spaceName,
    ...(action.threadName !== undefined ? { threadName: action.threadName } : {}),
    sender: self,
    text: action.text,
    createTime: new Date(action.submittedAt),
    threadReply: action.threadName !== undefined,
    deleted: false,
    attachments: [],
    reactions: [],
    pending: true,
  };
}

/**
 * Apply every pending edit that targets one already-committed message.
 *
 * Whenever the overlay changes the body, `formattedText` is dropped rather than left stale: the
 * overlay cannot recompute Chat's formatting markup.
 */
export function overlayMessage(
  info: GoogleChatMessageInfo,
  pending: readonly PendingChatAction[],
): GoogleChatMessageInfo {
  let result = info;
  for (const { action } of pending) {
    // Edited text must not resurface on a record the provider has deleted.
    if (action.type === "updateMessage" && action.messageName === info.name && !result.deleted) {
      result = { ...result, text: action.text, lastUpdateTime: new Date(action.submittedAt) };
      delete result.formattedText;
    }
  }
  return result;
}

/** Whether a queued message belongs in a listing with these filters. */
function pendingSendMatches(
  action: ChatSendMessageAction,
  spaceName: string,
  options: GoogleChatListMessagesOptions,
): boolean {
  if (action.spaceName !== spaceName) return false;
  if (options.threadName !== undefined && action.threadName !== options.threadName) return false;
  if (options.createdAfter && action.submittedAt <= options.createdAfter.valueOf()) return false;
  if (options.createdBefore && action.submittedAt >= options.createdBefore.valueOf()) return false;
  return true;
}

/**
 * Overlay one page of a space's messages.
 *
 * Queued sends are the newest messages, so they join the final page when paging oldest-first and
 * the first page when paging newest-first.
 */
export function overlayMessageList(
  messages: readonly GoogleChatMessageInfo[],
  pending: readonly PendingChatAction[],
  context: {
    spaceName: string;
    self: GoogleChatUser;
    options: GoogleChatListMessagesOptions;
    /** Whether this is the first provider page. */
    first: boolean;
    /** Whether the provider has no page after this one. */
    exhausted: boolean;
  },
): GoogleChatMessageInfo[] {
  const result = messages
    .map(message => overlayMessage(message, pending))
    .filter(message => context.options.includeDeleted || !message.deleted);
  const newestFirst = context.options.order === "newestFirst";
  if (newestFirst ? !context.first : !context.exhausted) return result;

  const queued = pending.flatMap(({ id, action }) =>
    action.type === "sendMessage" && pendingSendMatches(action, context.spaceName, context.options)
      ? [pendingMessageInfo(id, action, context.self)]
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
  reactions: readonly GoogleChatReaction[],
  pending: readonly PendingChatAction[],
  context: { messageName: string; self: GoogleChatUser; exhausted: boolean },
): GoogleChatReaction[] {
  const desired = new Map<string, { present: boolean; actionId: number }>();
  for (const { id, action } of pending) {
    if ((action.type === "addReaction" || action.type === "removeReaction") &&
        action.messageName === context.messageName) {
      desired.set(action.emoji, { present: action.type === "addReaction", actionId: id });
    }
  }
  const result = reactions.filter(reaction =>
    reaction.user?.name !== context.self.name || !desired.has(reaction.emoji));
  if (!context.exhausted) return result;
  for (const [emoji, change] of desired) {
    if (change.present) {
      result.push({
        name: `${context.messageName}/reactions/pending-${change.actionId}`,
        emoji,
        user: context.self,
      });
    }
  }
  return result;
}
