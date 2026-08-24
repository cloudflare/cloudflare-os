/** Explicit authority carried by every Gmail thread and message capability. */
export type GmailCapabilityScope =
  | {kind: "mailbox"}
  | {kind: "restricted"; admittedMessageIds: readonly string[]};

export const GMAIL_MAILBOX_SCOPE: GmailCapabilityScope = {kind: "mailbox"};

/** Construct a fail-closed restricted scope with stable, de-duplicated message IDs. */
export function gmailRestrictedScope(messageIds: Iterable<string>): GmailCapabilityScope {
  return {kind: "restricted", admittedMessageIds: [...new Set(messageIds)]};
}

export function gmailScopeAllowsMessage(scope: GmailCapabilityScope, messageId: string): boolean {
  return scope.kind === "mailbox" || scope.admittedMessageIds.includes(messageId);
}

/** Never returns a sibling omitted from an explicitly restricted capability. */
export function gmailMessagesAllowedByScope<T extends {id: string}>(
    scope: GmailCapabilityScope, messages: readonly T[]): T[] {
  if (scope.kind === "mailbox") return [...messages];
  const admitted = new Set(scope.admittedMessageIds);
  return messages.filter(message => admitted.has(message.id));
}

export type GmailMutationTarget =
  | {kind: "thread"; threadId: string}
  | {kind: "messages"; messageIds: string[]};

/** Restricted capabilities always resolve to message endpoints, never a thread-wide endpoint. */
export function gmailMutationTarget(
    scope: GmailCapabilityScope, threadId: string): GmailMutationTarget {
  if (scope.kind === "mailbox") return {kind: "thread", threadId};
  if (scope.admittedMessageIds.length === 0) {
    throw new Error("This restricted Gmail thread capability admits no messages.");
  }
  return {kind: "messages", messageIds: [...scope.admittedMessageIds]};
}

/** Group matching messages into restricted thread capabilities without duplicate message IDs. */
export function groupGmailMessagesByThread<T extends {id: string; threadId: string}>(
    messages: readonly T[]): Array<{threadId: string; messages: T[]}> {
  const grouped = new Map<string, T[]>();
  const seenMessages = new Set<string>();
  for (const message of messages) {
    if (seenMessages.has(message.id)) continue;
    seenMessages.add(message.id);
    const existing = grouped.get(message.threadId);
    if (existing) existing.push(message);
    else grouped.set(message.threadId, [message]);
  }
  return [...grouped].map(([threadId, threadMessages]) => ({threadId, messages: threadMessages}));
}
