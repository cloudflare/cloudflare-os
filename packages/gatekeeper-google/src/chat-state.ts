// Pending Chat actions and the read-time overlay that simulates them.
//
// An action submitted for approval is not sent to Google until applyAction() runs, but every read
// through this gatekeeper reflects most queued writes: a queued message appears in the space's
// history and a queued edit shows its new text. Detailed reaction lists are simulated too, while
// aggregate reaction summaries remain provider-backed because their counts do not reveal whether
// the connected user is already included.
//
// The overlay is computed at read time rather than by mutating a cache, so rejecting an action
// simply removes it and the next read is correct again. Every function here is pure, which is
// what lets the simulation be tested without a Durable Object.

import type {
  GoogleChatListMessagesOptions, GoogleChatMembership, GoogleChatMessageInfo,
  GoogleChatNotificationSettingsPatch, GoogleChatReaction, GoogleChatUser,
} from "./chat-types";

/** One attachment held in the gatekeeper's own storage until its message is approved. */
export type ChatUploadRecord = {
  /** Key of the stored bytes. */
  blobId: string;
  filename: string;
  mimeType: string;
  size: number;
};

type ChatActionBase = { submittedAt: number };

export type ChatSendMessageAction = ChatActionBase & {
  type: "sendMessage";
  spaceName: string;
  text: string;
  /** Set when the message is a threaded reply. */
  threadName?: string;
  uploads: ChatUploadRecord[];
  /** Makes the eventual create idempotent across a retried apply. */
  requestId: string;
};

export type ChatUpdateMessageAction = ChatActionBase & {
  type: "updateMessage";
  messageName: string;
  text: string;
};

export type ChatDeleteMessageAction = ChatActionBase & {
  type: "deleteMessage";
  messageName: string;
};

export type ChatReactionAction = ChatActionBase & {
  type: "addReaction" | "removeReaction";
  messageName: string;
  emoji: string;
};

export type ChatPinAction = ChatActionBase & {
  type: "pinMessage" | "unpinMessage";
  spaceName: string;
  messageName: string;
};

export type ChatNotificationAction = ChatActionBase & {
  type: "updateNotificationSettings";
  spaceName: string;
  patch: GoogleChatNotificationSettingsPatch;
};

export type ChatLeaveSpaceAction = ChatActionBase & {
  type: "leaveSpace";
  spaceName: string;
  membershipName: string;
};

export type ChatAction =
  | ChatSendMessageAction
  | ChatUpdateMessageAction
  | ChatDeleteMessageAction
  | ChatReactionAction
  | ChatPinAction
  | ChatNotificationAction
  | ChatLeaveSpaceAction;

/** A stored action together with the id the approval queue knows it by. */
export type PendingChatAction = { id: number; action: ChatAction };

/** Prefix of the temporary name a submitted-but-uncommitted message carries. */
export const PENDING_MESSAGE_PREFIX = "pending:send:";

export function pendingMessageName(actionId: number): string {
  return `${PENDING_MESSAGE_PREFIX}${actionId}`;
}

export function isPendingMessageName(name: string): boolean {
  return name.startsWith(PENDING_MESSAGE_PREFIX);
}

/** The action id inside a pending message name, or undefined when it is not one. */
export function pendingMessageActionId(name: string): number | undefined {
  if (!isPendingMessageName(name)) return undefined;
  const id = Number(name.slice(PENDING_MESSAGE_PREFIX.length));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** The space an action affects, used to keep one space's overlay out of another's reads. */
export function chatActionSpaceName(action: ChatAction): string {
  switch (action.type) {
    case "sendMessage":
    case "pinMessage":
    case "unpinMessage":
    case "updateNotificationSettings":
    case "leaveSpace":
      return action.spaceName;
    default:
      return action.messageName.slice(0, action.messageName.indexOf("/messages/"));
  }
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
    attachments: action.uploads.map(upload => ({
      name: "",
      filename: upload.filename,
      mimeType: upload.mimeType,
      source: "uploaded" as const,
      // The bytes are held here, not in Chat, so there is nothing to download yet.
      readable: false,
    })),
    reactions: [],
    pending: true,
  };
}

/**
 * Apply every pending action that touches one already-committed message.
 *
 * Returns null when a pending delete means the message should no longer be visible.
 */
export function overlayMessage(
  info: GoogleChatMessageInfo,
  pending: readonly PendingChatAction[],
  options: { includeDeleted?: boolean } = {},
): GoogleChatMessageInfo | null {
  let result = info;
  for (const { action } of pending) {
    switch (action.type) {
      case "updateMessage":
        if (action.messageName === info.name) {
          result = { ...result, text: action.text, lastUpdateTime: new Date(action.submittedAt) };
        }
        break;
      case "deleteMessage":
        if (action.messageName === info.name) {
          if (!options.includeDeleted) return null;
          result = { ...result, deleted: true, text: "", attachments: [], reactions: [] };
        }
        break;
      // Aggregate reaction counts do not say whether the connected user is already included.
      // Leave summaries provider-backed rather than guessing a pending delta. listReactions()
      // still simulates the connected user's final desired reaction state.
      case "addReaction":
      case "removeReaction":
        break;
      default:
        break;
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
 * Queued sends appear on the final page when paging oldest-first, or the first page when paging
 * newest-first, so their simulated position matches the requested order.
 */
export function overlayMessageList(
  messages: readonly GoogleChatMessageInfo[],
  pending: readonly PendingChatAction[],
  context: {
    spaceName: string;
    self: GoogleChatUser;
    options: GoogleChatListMessagesOptions;
    exhausted: boolean;
    /** Whether this is the first provider page. Defaults to true for direct callers. */
    firstPage?: boolean;
  },
): GoogleChatMessageInfo[] {
  const includeDeleted = context.options.includeDeleted === true;
  const result: GoogleChatMessageInfo[] = [];
  for (const message of messages) {
    const overlaid = overlayMessage(message, pending, { includeDeleted });
    if (overlaid) result.push(overlaid);
  }
  const showQueued = context.options.order === "newestFirst"
    ? context.firstPage !== false
    : context.exhausted;
  if (!showQueued) return result;

  const queued = pending
    .filter((entry): entry is { id: number; action: ChatSendMessageAction } =>
      entry.action.type === "sendMessage" &&
      pendingSendMatches(entry.action, context.spaceName, context.options))
    .map(entry => pendingMessageInfo(entry.id, entry.action, context.self));
  if (queued.length === 0) return result;
  return context.options.order === "newestFirst"
    ? [...queued.toReversed(), ...result]
    : [...result, ...queued];
}

/** Overlay one page of reactions with the connected user's queued changes. */
export function overlayReactions(
  reactions: readonly GoogleChatReaction[],
  pending: readonly PendingChatAction[],
  context: {
    messageName: string;
    self: GoogleChatUser;
    /** Add synthetic reactions only after the provider has no more pages. Defaults to true. */
    exhausted?: boolean;
    /** Connected-user emoji already encountered on earlier provider pages. */
    seenOwnEmojis?: Set<string>;
  },
): GoogleChatReaction[] {
  const desired = new Map<string, { present: boolean; actionId: number }>();
  for (const { id, action } of pending) {
    if (action.type !== "addReaction" && action.type !== "removeReaction") continue;
    if (action.messageName !== context.messageName) continue;
    desired.set(action.emoji, { present: action.type === "addReaction", actionId: id });
  }

  const seenOwnEmojis = context.seenOwnEmojis ?? new Set<string>();
  const result = reactions.filter(reaction => {
    if (reaction.user?.name !== context.self.name) return true;
    const change = desired.get(reaction.emoji);
    if (!change) return true;
    if (!change.present) return false;
    if (seenOwnEmojis.has(reaction.emoji)) return false;
    seenOwnEmojis.add(reaction.emoji);
    return true;
  });

  if (context.exhausted === false) return result;
  for (const [emoji, change] of desired) {
    if (!change.present || seenOwnEmojis.has(emoji)) continue;
    seenOwnEmojis.add(emoji);
    result.push({
      name: `${context.messageName}/reactions/pending-${change.actionId}`,
      emoji,
      user: context.self,
    });
  }
  return result;
}

/** Overlay a page of pinned-message names with queued pins and unpins. */
export function overlayPins(
  pinned: readonly string[],
  pending: readonly PendingChatAction[],
  context: { spaceName: string; exhausted: boolean },
): string[] {
  const desired = new Map<string, boolean>();
  for (const { action } of pending) {
    if ((action.type === "pinMessage" || action.type === "unpinMessage") &&
        action.spaceName === context.spaceName) {
      desired.set(action.messageName, action.type === "pinMessage");
    }
  }
  const result = pinned.filter(name => desired.get(name) !== false);
  if (!context.exhausted) return result;
  const seen = new Set(result);
  for (const [name, shouldBePinned] of desired) {
    if (shouldBePinned && !seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

/** Drop the connected user's own membership once leaving the space has been queued. */
export function overlayMemberships(
  memberships: readonly GoogleChatMembership[],
  pending: readonly PendingChatAction[],
  spaceName: string,
): GoogleChatMembership[] {
  const left = pending.some(({ action }) =>
    action.type === "leaveSpace" && action.spaceName === spaceName);
  if (!left) return [...memberships];
  const leaving = new Set(pending
    .filter((entry): entry is { id: number; action: ChatLeaveSpaceAction } =>
      entry.action.type === "leaveSpace" && entry.action.spaceName === spaceName)
    .map(entry => entry.action.membershipName));
  return memberships.filter(membership => !leaving.has(membership.name));
}

/** Whether leaving `spaceName` is already queued, so further writes there would not land. */
export function hasPendingLeave(
  pending: readonly PendingChatAction[],
  spaceName: string,
): boolean {
  return pending.some(({ action }) =>
    action.type === "leaveSpace" && action.spaceName === spaceName);
}
