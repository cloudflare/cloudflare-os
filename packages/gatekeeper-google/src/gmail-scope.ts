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

/** Exact message IDs a mutation applies to. */
export type GmailMessagesTarget = {kind: "messages"; messageIds: string[]};

/**
 * What a stored mutation applies to. New actions always name exact messages; `thread` survives
 * only in actions queued by earlier versions, which Gmail applies to the thread as it is then.
 */
export type GmailMutationTarget = {kind: "thread"; threadId: string} | GmailMessagesTarget;

/**
 * Resolve a thread mutation to exact message IDs, fixed when the action is submitted: the
 * thread's messages admitted by `scope`, in thread order, through `lastMessageId` when given.
 * Never a thread-wide endpoint, which would also reach messages arriving before approval.
 */
export function gmailThreadMutationTarget(
    scope: GmailCapabilityScope, threadMessageIds: readonly string[],
    lastMessageId?: string): GmailMessagesTarget {
  const admitted = gmailMessagesAllowedByScope(
    scope, [...new Set(threadMessageIds)].map(id => ({id}))).map(message => message.id);
  if (admitted.length === 0) throw new Error("This Gmail thread capability admits no messages.");
  if (lastMessageId === undefined) return {kind: "messages", messageIds: admitted};
  const end = admitted.indexOf(lastMessageId);
  if (end < 0) {
    throw new Error("lastMessageId is not a message of this thread available to this capability.");
  }
  return {kind: "messages", messageIds: admitted.slice(0, end + 1)};
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
