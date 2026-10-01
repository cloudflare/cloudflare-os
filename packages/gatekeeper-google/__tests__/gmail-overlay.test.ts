import {describe, expect, it} from "vitest";
import {summarizeGmailThread, type GmailMessageInfoRaw} from "../src/google-api";
import type {GmailDecision, GmailLabelResource, PendingOverlayAction} from "../src/gmail-state";
import {
  compileListFilter, messageMayMatch, mutationLabelChanges, overlayMessageInfo,
  overlayThreadMessages, pendingLabelChanges, threadMayMatch,
  type GmailLabelChangeAction, type GmailMutationOperation, type GmailOverlay,
  type PendingLabelChange,
} from "../src/gmail-overlay";

function message(id: string, labelIds: string[], threadId = "thread"): GmailMessageInfoRaw {
  return {
    id,
    threadId,
    from: {address: "sender@example.com"},
    to: [{address: "me@example.com"}],
    cc: [],
    bcc: [],
    subject: "Subject",
    timestamp: new Date(1000),
    labelIds,
  };
}

function overlayOf(...changes: Array<Omit<PendingLabelChange, "actionId">>): GmailOverlay {
  return {
    generation: 0,
    labelChanges: changes.map((change, index) => ({actionId: index + 1, ...change})),
  };
}

function mutation(
    operation: GmailMutationOperation, messageIds: string[],
    extra: {labelId?: string; dependsOn?: number[]} = {}): GmailLabelChangeAction {
  return {type: "messageMutation", operation, target: {kind: "messages", messageIds}, ...extra};
}

function changesFor(
    actions: GmailLabelChangeAction[],
    options: {
      decisions?: Array<[number, GmailDecision]>;
      labels?: GmailLabelResource[];
    } = {}): PendingLabelChange[] {
  const pending: PendingOverlayAction<GmailLabelChangeAction>[] =
    actions.map((action, index) => ({id: index + 1, action}));
  const labels = new Map((options.labels ?? []).map(label => [label.logicalId, label]));
  return pendingLabelChanges(pending, new Map(options.decisions ?? []), id => labels.get(id));
}

const labelsOf = (
    overlay: GmailOverlay, info: GmailMessageInfoRaw, labels: GmailLabelResource[] = []) =>
  overlayMessageInfo(overlay, info, labels).labelIds;

const summarize = (overlay: GmailOverlay, messages: GmailMessageInfoRaw[]) =>
  summarizeGmailThread("thread", undefined, overlayThreadMessages(overlay, messages, []));

const filterFor = (...queries: string[]) => compileListFilter({queries, includeSpamTrash: true});

const threadOf = (...labels: string[][]) => labels.map(labelIds => ({labelIds}));

describe("pending Gmail label changes", () => {
  it.each([
    ["archive", {add: [], remove: ["INBOX"]}],
    ["trash", {add: ["TRASH"], remove: []}],
    ["markRead", {add: [], remove: ["UNREAD"]}],
    ["markUnread", {add: ["UNREAD"], remove: []}],
    ["star", {add: ["STARRED"], remove: []}],
    ["unstar", {add: [], remove: ["STARRED"]}],
  ] as const)("reads %s as the label change approval makes", (operation, change) => {
    expect(changesFor([mutation(operation, ["m1"])])).toEqual([
      {actionId: 1, target: {kind: "messages", messageIds: ["m1"]}, ...change},
    ]);
    expect(mutationLabelChanges(operation, undefined)).toEqual(change);
  });

  it("keeps submission order", () => {
    const changes = changesFor([mutation("markRead", ["m1"]), mutation("markUnread", ["m1"])]);
    expect(changes.map(change => change.actionId)).toEqual([1, 2]);
  });

  it("skips a mutation whose prerequisite was rejected", () => {
    const actions = [
      mutation("applyLabel", ["m1"], {labelId: "Label_1", dependsOn: [7]}),
      mutation("archive", ["m1"]),
    ];
    expect(changesFor(actions, {decisions: [[7, "rejected"]]}).map(change => change.actionId))
      .toEqual([2]);
    // A prerequisite that is applied, or still pending, does not invalidate the mutation.
    expect(changesFor(actions, {decisions: [[7, "applied"]]})).toHaveLength(2);
    expect(changesFor(actions)).toHaveLength(2);
  });

  it.each(["rejected", "deleted"] as const)("skips a mutation whose label was %s", status => {
    const labels: GmailLabelResource[] = [{logicalId: "provisional-label-1", name: "Gone", status}];
    expect(changesFor(
      [mutation("applyLabel", ["m1"], {labelId: "provisional-label-1"})], {labels})).toEqual([]);
  });

  it("keeps a label's logical ID, whether or not Gmail has the label yet", () => {
    const action = mutation("applyLabel", ["m1"], {labelId: "provisional-label-1"});
    const provisional: GmailLabelResource =
      {logicalId: "provisional-label-1", name: "New", status: "active"};

    expect(changesFor([action], {labels: [provisional]})[0].add).toEqual(["provisional-label-1"]);
    expect(changesFor([action], {labels: [{...provisional, providerId: "Label_9"}]})[0].add)
      .toEqual(["provisional-label-1"]);
    expect(changesFor([mutation("removeLabel", ["m1"], {labelId: "IMPORTANT"})])[0].remove)
      .toEqual(["IMPORTANT"]);
  });

  it("targets the whole thread for an action queued before mutations named messages", () => {
    expect(changesFor([{type: "archive", threadId: "t1"}, {type: "markUnread", threadId: "t2"}]))
      .toEqual([
        {actionId: 1, target: {kind: "thread", threadId: "t1"}, add: [], remove: ["INBOX"]},
        {actionId: 2, target: {kind: "thread", threadId: "t2"}, add: ["UNREAD"], remove: []},
      ]);
    expect(changesFor([{
      type: "messageMutation", operation: "trash", target: {kind: "thread", threadId: "t1"},
    }])[0].target).toEqual({kind: "thread", threadId: "t1"});
  });
});

describe("overlayMessageInfo", () => {
  it("returns the provider metadata untouched when no change names the message", () => {
    const info = message("m1", ["INBOX", "UNREAD"]);
    const overlay = overlayOf(
      {target: {kind: "messages", messageIds: ["other"]}, add: [], remove: ["INBOX"]});
    expect(overlayMessageInfo(overlay, info, [])).toBe(info);
  });

  it("adds and removes labels on exactly the named messages", () => {
    const overlay = overlayOf(
      {target: {kind: "messages", messageIds: ["m1", "m2"]}, add: [], remove: ["UNREAD"]},
      {target: {kind: "messages", messageIds: ["m2"]}, add: ["STARRED"], remove: []});

    expect(labelsOf(overlay, message("m1", ["INBOX", "UNREAD"]))).toEqual(["INBOX"]);
    expect(labelsOf(overlay, message("m2", ["INBOX", "UNREAD"]))).toEqual(["INBOX", "STARRED"]);
    expect(labelsOf(overlay, message("m3", ["INBOX", "UNREAD"]))).toEqual(["INBOX", "UNREAD"]);
  });

  it("applies changes in submission order, so the later of two opposing changes wins", () => {
    const target = {kind: "messages", messageIds: ["m1"]} as const;
    const read = {target, add: [], remove: ["UNREAD"]};
    const unread = {target, add: ["UNREAD"], remove: []};

    expect(labelsOf(overlayOf(read, unread), message("m1", []))).toEqual(["UNREAD"]);
    expect(labelsOf(overlayOf(unread, read), message("m1", ["UNREAD"]))).toEqual([]);
  });

  it("changes nothing when Gmail already shows the change", () => {
    const overlay = overlayOf(
      {target: {kind: "messages", messageIds: ["m1"]}, add: ["STARRED"], remove: ["INBOX"]});
    expect(labelsOf(overlay, message("m1", ["STARRED"]))).toEqual(["STARRED"]);
  });

  it("applies a thread-targeted change to every message of that thread only", () => {
    const overlay = overlayOf({target: {kind: "thread", threadId: "t1"}, add: ["TRASH"], remove: []});

    expect(labelsOf(overlay, message("m1", ["INBOX"], "t1"))).toEqual(["INBOX", "TRASH"]);
    expect(labelsOf(overlay, message("late-arrival", [], "t1"))).toEqual(["TRASH"]);
    expect(labelsOf(overlay, message("m2", ["INBOX"], "t2"))).toEqual(["INBOX"]);
  });

  it("removes a provider label and adds a provisional one", () => {
    const overlay = overlayOf(
      {target: {kind: "messages", messageIds: ["m1"]}, add: [], remove: ["Label_1"]},
      {target: {kind: "messages", messageIds: ["m1"]}, add: ["provisional-label-1"], remove: []});
    const labels: GmailLabelResource[] = [
      {logicalId: "Label_1", providerId: "Label_1", name: "Old", status: "active"},
      {logicalId: "provisional-label-1", name: "New", status: "active"},
    ];
    expect(labelsOf(overlay, message("m1", ["INBOX", "Label_1"]), labels))
      .toEqual(["INBOX", "provisional-label-1"]);
  });

  describe("once Gmail has a label that was provisional when the change was queued", () => {
    const target = {kind: "messages", messageIds: ["m1"]} as const;
    const apply = {target, add: ["provisional-label-1"], remove: []};
    const remove = {target, add: [], remove: ["provisional-label-1"]};
    const created: GmailLabelResource[] = [{
      logicalId: "provisional-label-1", providerId: "Label_9", name: "New", status: "active",
    }];

    it("adds the label under the ID Gmail gave it", () => {
      expect(labelsOf(overlayOf(apply), message("m1", ["INBOX"]), created))
        .toEqual(["INBOX", "Label_9"]);
    });

    it("does not add it a second time when Gmail already shows it", () => {
      expect(labelsOf(overlayOf(apply), message("m1", ["INBOX", "Label_9"]), created))
        .toEqual(["INBOX", "Label_9"]);
    });

    it("removes the label Gmail returned under its provider ID", () => {
      expect(labelsOf(overlayOf(apply, remove), message("m1", ["INBOX", "Label_9"]), created))
        .toEqual(["INBOX"]);
    });
  });
});

describe("thread summaries over patched messages", () => {
  const messages = [message("m1", ["INBOX", "UNREAD"]), message("m2", ["INBOX", "UNREAD"])];

  it("stays unread and in the inbox while any message is", () => {
    const overlay = overlayOf(
      {target: {kind: "messages", messageIds: ["m1"]}, add: [], remove: ["INBOX", "UNREAD"]});
    expect(summarize(overlay, messages)).toMatchObject({
      unread: true, labelIds: ["INBOX", "UNREAD"], messageCount: 2,
    });
  });

  it("drops a label and the unread flag once no message carries them", () => {
    const all = {kind: "messages", messageIds: ["m1", "m2"]} as const;
    const overlay = overlayOf(
      {target: all, add: [], remove: ["INBOX"]},
      {target: all, add: [], remove: ["UNREAD"]},
      {target: {kind: "messages", messageIds: ["m2"]}, add: ["STARRED"], remove: []});
    expect(summarize(overlay, messages)).toMatchObject({
      unread: false, labelIds: ["STARRED"], messageCount: 2, latestMessageId: "m2",
    });
  });
});

describe("compileListFilter", () => {
  it("requires each requested label", () => {
    expect(compileListFilter({labelIds: ["INBOX", "Label_1"], queries: [], includeSpamTrash: true}))
      .toEqual([{labelId: "INBOX", present: true}, {labelId: "Label_1", present: true}]);
  });

  it("excludes trash and spam unless the request included them", () => {
    expect(compileListFilter({queries: [], includeSpamTrash: false}))
      .toEqual([{labelId: "TRASH", present: false}, {labelId: "SPAM", present: false}]);
    expect(compileListFilter({queries: [], includeSpamTrash: true})).toEqual([]);
  });

  it.each([
    ["is:unread", {labelId: "UNREAD", present: true}],
    ["is:read", {labelId: "UNREAD", present: false}],
    ["is:starred", {labelId: "STARRED", present: true}],
    ["in:inbox", {labelId: "INBOX", present: true}],
    ["in:trash", {labelId: "TRASH", present: true}],
    ["in:spam", {labelId: "SPAM", present: true}],
  ])("recognizes %s, its negation, and other letter case", (term, predicate) => {
    expect(filterFor(term)).toEqual([predicate]);
    expect(filterFor(`-${term}`)).toEqual([{...predicate, present: !predicate.present}]);
    expect(filterFor(term.toUpperCase())).toEqual([predicate]);
    expect(filterFor(`-${term[0].toUpperCase()}${term.slice(1)}`))
      .toEqual([{...predicate, present: !predicate.present}]);
  });

  it("takes the recognized terms of a plain list and ignores the rest", () => {
    expect(filterFor("from:boss@example.com  is:unread quarterly after:2024/01/01 -in:inbox AND"))
      .toEqual([{labelId: "UNREAD", present: true}, {labelId: "INBOX", present: false}]);
  });

  it.each([
    "label:unread", "is:important", "in:anywhere", "has:attachment", "--is:unread", "+is:unread",
    "is:unread,", "x-is:unread", "subject:is:unread", "in:inbox.",
  ])("contributes nothing for %j", query => {
    expect(filterFor(query)).toEqual([]);
  });

  it("never reads a quoted span as a term", () => {
    expect(filterFor('"is:unread"')).toEqual([]);
    expect(filterFor('is:"unread"')).toEqual([]);
    expect(filterFor('subject:"report is:unread" in:inbox'))
      .toEqual([{labelId: "INBOX", present: true}]);
    // Grouping and OR inside quotes are text, not structure.
    expect(filterFor('"(a OR b)" is:starred')).toEqual([{labelId: "STARRED", present: true}]);
  });

  it.each([
    "is:unread OR is:starred",
    "is:unread or is:starred",
    "is:unread | is:starred",
    "is:unread|is:starred",
    "{is:unread is:starred}",
    "(is:unread)",
    "-(is:unread)",
    "subject:(is:unread)",
    "from:a (is:unread from:b)",
    "NOT is:unread",
    "invoice AROUND 5 is:unread",
    "subject: is:unread",
    'is:unread "unterminated',
  ])("switches off a query that is not a plain list of terms: %j", query => {
    expect(filterFor(query)).toEqual([]);
  });

  it("checks the binding's query and the caller's separately", () => {
    // The binding's OR must not cost the caller's own terms, and the reverse.
    expect(filterFor("from:a OR from:b", "is:unread")).toEqual([{labelId: "UNREAD", present: true}]);
    expect(filterFor("is:starred", "x OR y")).toEqual([{labelId: "STARRED", present: true}]);
    expect(filterFor("is:starred", "-is:unread")).toEqual([
      {labelId: "STARRED", present: true}, {labelId: "UNREAD", present: false},
    ]);
  });

  it("combines labels, the spam and trash default, and query terms", () => {
    expect(compileListFilter({
      labelIds: ["Label_1"], queries: ["is:unread"], includeSpamTrash: false,
    })).toEqual([
      {labelId: "Label_1", present: true},
      {labelId: "TRASH", present: false},
      {labelId: "SPAM", present: false},
      {labelId: "UNREAD", present: true},
    ]);
  });
});

describe("messageMayMatch", () => {
  const inbox = {labelId: "INBOX", present: true};
  const notTrash = {labelId: "TRASH", present: false};

  it("keeps a message with no conditions to fail", () => {
    expect(messageMayMatch([], [])).toBe(true);
  });

  it("drops a message exactly when a condition fails", () => {
    expect(messageMayMatch(["INBOX", "UNREAD"], [inbox, notTrash])).toBe(true);
    expect(messageMayMatch(["UNREAD"], [inbox, notTrash])).toBe(false);
    expect(messageMayMatch(["INBOX", "TRASH"], [inbox, notTrash])).toBe(false);
  });
});

describe("threadMayMatch", () => {
  const unread = {labelId: "UNREAD", present: true};
  const inbox = {labelId: "INBOX", present: true};
  const notTrash = {labelId: "TRASH", present: false};

  it("keeps a thread while each condition holds on some message", () => {
    expect(threadMayMatch(threadOf(["INBOX"], ["UNREAD"]), [unread, inbox])).toBe(true);
    expect(threadMayMatch(threadOf(["TRASH"], []), [notTrash])).toBe(true);
  });

  it("drops a thread only when one condition fails on every message", () => {
    expect(threadMayMatch(threadOf(["INBOX"], ["INBOX"]), [unread, inbox])).toBe(false);
    expect(threadMayMatch(threadOf(["TRASH"], ["TRASH", "INBOX"]), [inbox, notTrash])).toBe(false);
    // No single message satisfies both conditions, but neither condition fails everywhere.
    expect(threadMayMatch(threadOf(["INBOX", "TRASH"], []), [inbox, notTrash])).toBe(true);
  });

  it("keeps a thread with no conditions, or no messages to judge by", () => {
    expect(threadMayMatch(threadOf(["INBOX"]), [])).toBe(true);
    expect(threadMayMatch([], [inbox])).toBe(true);
  });
});
