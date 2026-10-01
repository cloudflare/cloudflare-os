// Pending Gmail message state and the read-time overlay that simulates it.
//
// A label change or a send submitted for approval does not reach Gmail until applyAction() runs,
// but every read through this gatekeeper reflects it: a message shows its labels as they will be,
// a thread summary is recomputed from its patched messages, a list drops entries the change moved
// out of it, and mail waiting to be sent can be opened and appears in the thread it replies to.
// The draft and label-definition overlays live in gmail-state.ts; this is message and thread
// state.
//
// The overlay is computed at read time from the pending actions, so approving or rejecting an
// action needs no cleanup: the next read sees Gmail's real state, or stops adjusting for it. It
// changes or hides what Gmail returned and never adds a message of Gmail's that Gmail did not
// return, so a restricted binding can only see less than Gmail would show it, never more. The one
// thing it adds is mail the binding is sending itself, which the binding wrote.
//
// Every function here is pure, which lets the simulation be tested without a Durable Object.

import {emailRecipientToAddress} from "./google-api";
import type {GmailMessageInfoRaw} from "./google-api";
import type {GmailMutationTarget} from "./gmail-scope";
import type {GmailDecision, GmailLabelResource, PendingOverlayAction} from "./gmail-state";

/** The label changes a caller can make to messages. */
export type GmailMutationOperation =
  | "archive" | "trash" | "markRead" | "markUnread" | "star" | "unstar"
  | "applyLabel" | "removeLabel";

/**
 * Every mutation is a label change; trash and untrash add and remove the `TRASH` label. Apply and
 * the overlay share this table, so what a read shows is what approval does.
 */
export function mutationLabelChanges(
    operation: GmailMutationOperation, labelId: string | undefined): {add: string[]; remove: string[]} {
  switch (operation) {
    case "archive": return {add: [], remove: ["INBOX"]};
    case "trash": return {add: ["TRASH"], remove: []};
    case "markRead": return {add: [], remove: ["UNREAD"]};
    case "markUnread": return {add: ["UNREAD"], remove: []};
    case "star": return {add: ["STARRED"], remove: []};
    case "unstar": return {add: [], remove: ["STARRED"]};
    case "applyLabel": return {add: [labelId!], remove: []};
    case "removeLabel": return {add: [], remove: [labelId!]};
  }
}

/** The stored actions that change message labels, reduced to what the overlay reads. */
export type GmailLabelChangeAction =
  | {
      type: "messageMutation";
      operation: GmailMutationOperation;
      target: GmailMutationTarget;
      /** The label's logical ID, for `applyLabel` and `removeLabel`. */
      labelId?: string;
      dependsOn?: number[];
    }
  // Queued by earlier versions and still applyable; each reaches its whole thread.
  | {type: "archive" | "trash" | "markRead" | "markUnread"; threadId: string};

/**
 * A pending label change. Its label IDs are logical, as the action stored them: a label keeps its
 * logical ID for life, while the ID Gmail knows it by appears only once its creation is applied.
 */
export type PendingLabelChange = {
  actionId: number;
  target: {kind: "messages"; messageIds: readonly string[]} | {kind: "thread"; threadId: string};
  add: readonly string[];
  remove: readonly string[];
};

/**
 * A message this binding has queued for sending, as reads show it until Gmail has it. Reads never
 * build the email to show this much: it comes from the stored action alone.
 */
export type PendingSentMessage = {
  actionId: number;
  /** The `GmailMessageId` the outbound method returned. It names the message until Gmail does. */
  rfcMessageId: string;
  /**
   * The thread the message will join: a reply's source thread, or a draft's own. New mail and
   * forwards have none, because Gmail assigns their thread when it sends them.
   */
  threadId?: string;
  /** For a draft send: the draft's message in Gmail, which the sent message replaces. */
  supersedesMessageId?: string;
  /** Its `id` is `rfcMessageId`, its only label `SENT`, its timestamp when it was submitted. */
  info: Omit<GmailMessageInfoRaw, "threadId">;
};

/** The pending actions that message and thread reads reflect. */
export type GmailOverlay = {
  /** `store.actionGeneration()` when this overlay was loaded. */
  generation: number;
  /** In submission order, which is the approval order the simulation predicts. */
  labelChanges: readonly PendingLabelChange[];
  /** In submission order. */
  sent: readonly PendingSentMessage[];
  /**
   * Gmail's messages that pending actions do away with, which reads leave out: the message of a
   * draft that is being sent or deleted.
   */
  hiddenMessageIds: ReadonlySet<string>;
};

/**
 * Reduce pending actions, in submission order, to the label changes reads should show.
 *
 * An action that can no longer be applied is left out, by the rule `overlayGmailLabels` uses: a
 * prerequisite was rejected, or its label was rejected or deleted.
 */
export function pendingLabelChanges(
    pending: readonly PendingOverlayAction<GmailLabelChangeAction>[],
    decisions: ReadonlyMap<number, GmailDecision>,
    labelResource: (logicalId: string) => GmailLabelResource | undefined): PendingLabelChange[] {
  const changes: PendingLabelChange[] = [];
  for (const {id, action} of pending) {
    if (action.type !== "messageMutation") {
      changes.push({
        actionId: id,
        target: {kind: "thread", threadId: action.threadId},
        ...mutationLabelChanges(action.type, undefined),
      });
      continue;
    }
    if ((action.dependsOn ?? []).some(dependency => decisions.get(dependency) === "rejected")) {
      continue;
    }
    const resource = action.labelId === undefined ? undefined : labelResource(action.labelId);
    if (resource?.status === "rejected" || resource?.status === "deleted") continue;
    changes.push({
      actionId: id,
      target: action.target,
      ...mutationLabelChanges(action.operation, action.labelId),
    });
  }
  return changes;
}

type OutboundEnvelope = {
  from: string;
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  subject: string;
};

/** The stored actions that send mail or dispose of a draft, reduced to what the overlay reads. */
export type GmailOutboundOverlayAction =
  | {
      type: "send";
      spec: OutboundEnvelope & {messageId: string};
      /** A reply's source thread. */
      threadId?: string;
      submittedAt?: number;
    }
  | {
      type: "draftSend";
      /** The draft as it was when its send was submitted; `messageId` is its message in Gmail. */
      approved: OutboundEnvelope & {threadId?: string; messageId?: string};
      /** The `GmailMessageId` the send returned. */
      messageId?: string;
      expectedProviderMessageId?: string;
      submittedAt?: number;
      dependsOn?: number[];
    }
  | {type: "draftDelete"; expectedProviderMessageId?: string; dependsOn?: number[]};

/**
 * Reduce pending actions, in submission order, to the mail reads should show as sent and the
 * draft messages they should stop showing.
 *
 * An action whose prerequisite was rejected can never be applied, and is left out, as it is from
 * the draft overlay. `now` is the timestamp of a send stored before sends recorded their own.
 *
 * A draft's message is known by the ID Gmail gave it, and Gmail gives it a new one each time the
 * draft is written. `approved.messageId` is the ID from when the send was submitted and is never
 * updated; `expectedProviderMessageId` is brought up to date when the write queued directly ahead
 * of this action is applied. So the latter wins, and a draft Gmail does not have yet hides
 * nothing.
 */
export function pendingOutbound(
    pending: readonly PendingOverlayAction<GmailOutboundOverlayAction>[],
    decisions: ReadonlyMap<number, GmailDecision>,
    now: number): Pick<GmailOverlay, "sent" | "hiddenMessageIds"> {
  const sent: PendingSentMessage[] = [];
  const hiddenMessageIds = new Set<string>();
  for (const {id, action} of pending) {
    if (action.type !== "send" &&
        (action.dependsOn ?? []).some(dependency => decisions.get(dependency) === "rejected")) {
      continue;
    }
    if (action.type === "draftDelete") {
      if (action.expectedProviderMessageId) hiddenMessageIds.add(action.expectedProviderMessageId);
      continue;
    }
    const supersedesMessageId = action.type === "draftSend"
      ? action.expectedProviderMessageId ?? action.approved.messageId
      : undefined;
    if (supersedesMessageId) hiddenMessageIds.add(supersedesMessageId);
    const rfcMessageId = action.type === "send" ? action.spec.messageId : action.messageId;
    // A draft send queued before sends returned an ID has none to be opened by.
    if (rfcMessageId === undefined) continue;
    const envelope = action.type === "send" ? action.spec : action.approved;
    const threadId = action.type === "send" ? action.threadId : action.approved.threadId;
    sent.push({
      actionId: id,
      rfcMessageId,
      ...(threadId !== undefined ? {threadId} : {}),
      ...(supersedesMessageId ? {supersedesMessageId} : {}),
      info: {
        id: rfcMessageId,
        from: emailRecipientToAddress(envelope.from),
        to: envelope.to.map(emailRecipientToAddress),
        cc: envelope.cc.map(emailRecipientToAddress),
        bcc: envelope.bcc.map(emailRecipientToAddress),
        subject: envelope.subject,
        timestamp: new Date(action.submittedAt ?? now),
        labelIds: ["SENT"],
      },
    });
  }
  return {sent, hiddenMessageIds};
}

/**
 * A message's metadata with each pending change that names it applied, in submission order.
 *
 * `labels` says which labels Gmail has by now, and under which ID: message metadata carries that
 * ID, so a change's logical ID becomes it here, and stays provisional for a label Gmail lacks.
 * Pass the label resources the result is rendered with, read once `info` has been fetched. The
 * overlay is loaded before that fetch, and a label created during it must not be patched under
 * its old provisional ID next to the provider ID Gmail just returned.
 */
export function overlayMessageInfo<
    Info extends {id: string; threadId?: string; labelIds: string[]}>(
    overlay: GmailOverlay, info: Info, labels: readonly GmailLabelResource[]): Info {
  const providerId = (logicalId: string) =>
    labels.find(label => label.logicalId === logicalId)?.providerId ?? logicalId;
  let labelIds = info.labelIds;
  for (const change of overlay.labelChanges) {
    const targeted = change.target.kind === "thread"
      ? change.target.threadId === info.threadId
      : change.target.messageIds.includes(info.id);
    if (!targeted) continue;
    const remove = change.remove.map(providerId);
    const kept = labelIds.filter(id => !remove.includes(id));
    labelIds = [...kept, ...change.add.map(providerId).filter(id => !kept.includes(id))];
  }
  return labelIds === info.labelIds ? info : {...info, labelIds};
}

/**
 * The mail waiting to be sent into a thread, oldest first. `admitsPending` says which of it the
 * reading capability may show.
 */
export function pendingThreadMessages(
    overlay: GmailOverlay, threadId: string,
    admitsPending: (sent: PendingSentMessage) => boolean): PendingSentMessage[] {
  return overlay.sent
    .filter(sent => sent.threadId === threadId && admitsPending(sent))
    .toSorted((a, b) => a.info.timestamp.getTime() - b.info.timestamp.getTime());
}

/**
 * A thread's messages as reads should show them; its summary is computed from these.
 *
 * `messages` are Gmail's, in thread order. The ones a pending action does away with are left
 * out. The mail waiting to be sent into the thread follows them, which is where Gmail will put
 * it once it is sent.
 */
export function overlayThreadMessages(
    overlay: GmailOverlay, threadId: string, messages: readonly GmailMessageInfoRaw[],
    labels: readonly GmailLabelResource[],
    admitsPending: (sent: PendingSentMessage) => boolean): GmailMessageInfoRaw[] {
  return [
    ...messages.filter(message => !overlay.hiddenMessageIds.has(message.id)),
    ...pendingThreadMessages(overlay, threadId, admitsPending)
      .map(sent => ({...sent.info, threadId})),
  ].map(message => overlayMessageInfo(overlay, message, labels));
}

/** A label condition a list's results must satisfy, from the filters Gmail was asked for. */
export type LabelPredicate = {labelId: string; present: boolean};

// The search terms whose answer is exactly one label, and so can be re-checked after the overlay.
// Custom-label terms (`label:name`) are not here: Gmail matches label names loosely.
const QUERY_LABEL_TERMS: ReadonlyMap<string, LabelPredicate> = new Map([
  ["is:unread", {labelId: "UNREAD", present: true}],
  ["is:read", {labelId: "UNREAD", present: false}],
  ["is:starred", {labelId: "STARRED", present: true}],
  ["in:inbox", {labelId: "INBOX", present: true}],
  ["in:trash", {labelId: "TRASH", present: true}],
  ["in:spam", {labelId: "SPAM", present: true}],
]);

/**
 * The terms of a query that is a plain list, every one of which a result must satisfy; undefined
 * for any query that might combine its terms another way.
 *
 * Anything that could make a term optional, negate it, or turn it into another operator's value
 * disqualifies the whole query: grouping, `OR` (and `|`), `NOT`, `AROUND`, an operator left
 * without a value, or an unbalanced quote. Gmail's grammar is not documented precisely enough to
 * do better, and a query read too cautiously only costs pruning. A quoted span stays inside its
 * term, quotes included, so it never reads as a recognized term.
 */
function plainQueryTerms(query: string): string[] | undefined {
  const terms: string[] = [];
  let term = "";
  let quoted = false;
  for (const char of query) {
    if (char === '"') quoted = !quoted;
    if (!quoted && "(){}|".includes(char)) return undefined;
    if (!quoted && /\s/.test(char)) {
      if (term) terms.push(term);
      term = "";
    } else {
      term += char;
    }
  }
  if (quoted) return undefined;
  if (term) terms.push(term);
  return terms.some(item => /^(?:or|not|around)$/i.test(item) || item.endsWith(":"))
    ? undefined
    : terms;
}

/**
 * The label conditions a list's results must still satisfy once pending changes are applied.
 *
 * `queries` are the parts Gmail was asked to match together (the binding's restriction and the
 * caller's search), each checked on its own as a plain list of terms. Only conditions understood
 * exactly are returned, so pruning on them never hides a result that belongs in the list; a term
 * such as `from:` or a date cannot change when labels do, so Gmail's verdict on it stands.
 */
export function compileListFilter(input: {
  labelIds?: readonly string[];
  queries: readonly string[];
  /** Whether the request asked Gmail to include spam and trash, which it leaves out by default. */
  includeSpamTrash: boolean;
}): LabelPredicate[] {
  const predicates: LabelPredicate[] =
    (input.labelIds ?? []).map(labelId => ({labelId, present: true}));
  if (!input.includeSpamTrash) {
    predicates.push({labelId: "TRASH", present: false}, {labelId: "SPAM", present: false});
  }
  for (const query of input.queries) {
    for (const term of plainQueryTerms(query) ?? []) {
      const negated = term.startsWith("-");
      const predicate = QUERY_LABEL_TERMS.get((negated ? term.slice(1) : term).toLowerCase());
      if (predicate) {
        predicates.push(negated ? {...predicate, present: !predicate.present} : predicate);
      }
    }
  }
  return predicates;
}

function satisfies(labelIds: readonly string[], predicate: LabelPredicate): boolean {
  return labelIds.includes(predicate.labelId) === predicate.present;
}

/** Whether a message with these labels can still belong in a list with these conditions. */
export function messageMayMatch(
    labelIds: readonly string[], predicates: readonly LabelPredicate[]): boolean {
  return predicates.every(predicate => satisfies(labelIds, predicate));
}

/**
 * Whether a thread can still belong in a list with these conditions: false only when some
 * condition fails on every one of its messages.
 *
 * Gmail does not document whether a thread matches when one message satisfies the whole query or
 * when each term is satisfied by some message. This rule is sound under either reading.
 */
export function threadMayMatch(
    messages: readonly {labelIds: readonly string[]}[],
    predicates: readonly LabelPredicate[]): boolean {
  if (messages.length === 0) return true;
  return !predicates.some(predicate =>
    messages.every(message => !satisfies(message.labelIds, predicate)));
}
