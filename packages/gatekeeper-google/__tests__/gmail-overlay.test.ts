import {describe, expect, it} from "vitest";
import {summarizeGmailThread, type GmailMessageInfoRaw} from "../src/google-api";
import type {GmailDecision, GmailLabelResource, PendingOverlayAction} from "../src/gmail-state";
import {
  compileListFilter, messageMayMatch, mutationLabelChanges, overlayMessageInfo,
  overlayThreadMessages, pendingLabelChanges, pendingOutbound, threadMayMatch,
  type GmailLabelChangeAction, type GmailMutationOperation, type GmailOutboundOverlayAction,
  type GmailOverlay, type PendingLabelChange, type PendingSentMessage,
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
    sent: [],
    hiddenMessageIds: new Set(),
  };
}

// Mail queued for sending and draft messages on their way out, with no label changes.
function outboundOverlay(
    actions: GmailOutboundOverlayAction[],
    options: {decisions?: Array<[number, GmailDecision]>; now?: number} = {}): GmailOverlay {
  return {
    ...overlayOf(),
    ...pendingOutbound(
      actions.map((action, index) => ({id: index + 1, action})),
      new Map(options.decisions ?? []), options.now ?? 0),
  };
}

const envelope = {
  from: "Me <me@example.com>",
  to: ["sender@example.com"],
  cc: ["Carol <carol@example.com>"],
  bcc: ["hidden@example.com"],
  subject: "Re: Subject",
};

function reply(
    messageId: string, submittedAt: number, threadId = "thread"): GmailOutboundOverlayAction {
  return {type: "send", spec: {...envelope, messageId}, threadId, submittedAt};
}

const everyPending = () => true;

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

const summarize = (
    overlay: GmailOverlay, messages: GmailMessageInfoRaw[],
    admitsPending: (sent: PendingSentMessage) => boolean = everyPending) =>
  summarizeGmailThread(
    "thread", undefined, overlayThreadMessages(overlay, "thread", messages, [], admitsPending));

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

describe("pending Gmail sends", () => {
  it("shows a queued message under the ID its send returned, sent when it was submitted", () => {
    const {sent, hiddenMessageIds} = outboundOverlay([reply("<reply@gadgets.invalid>", 5000, "t1")]);

    expect(sent).toEqual([{
      actionId: 1,
      rfcMessageId: "<reply@gadgets.invalid>",
      threadId: "t1",
      info: {
        id: "<reply@gadgets.invalid>",
        from: {address: "me@example.com", name: "Me"},
        to: [{address: "sender@example.com"}],
        cc: [{address: "carol@example.com", name: "Carol"}],
        bcc: [{address: "hidden@example.com"}],
        subject: "Re: Subject",
        timestamp: new Date(5000),
        labelIds: ["SENT"],
      },
    }]);
    expect(hiddenMessageIds.size).toBe(0);
  });

  it("gives new mail and forwards no thread", () => {
    const [sent] = outboundOverlay([
      {type: "send", spec: {...envelope, messageId: "<new@gadgets.invalid>"}, submittedAt: 1},
    ]).sent;
    expect(sent).not.toHaveProperty("threadId");
  });

  it("dates a send stored before sends recorded their submission at the time of the read", () => {
    const [sent] = outboundOverlay(
      [{type: "send", spec: {...envelope, messageId: "<old@gadgets.invalid>"}}], {now: 9000}).sent;
    expect(sent.info.timestamp).toEqual(new Date(9000));
  });

  it("puts a sent draft in the draft's thread and hides the draft's message", () => {
    const {sent, hiddenMessageIds} = outboundOverlay([{
      type: "draftSend",
      approved: {...envelope, threadId: "t1", messageId: "draft-message"},
      messageId: "<draft@gadgets.invalid>",
      expectedProviderMessageId: "draft-message",
      submittedAt: 7000,
    }]);

    expect(sent).toMatchObject([{
      rfcMessageId: "<draft@gadgets.invalid>",
      threadId: "t1",
      supersedesMessageId: "draft-message",
      info: {id: "<draft@gadgets.invalid>", timestamp: new Date(7000), labelIds: ["SENT"]},
    }]);
    expect([...hiddenMessageIds]).toEqual(["draft-message"]);
  });

  it("hides the message Gmail gave the draft after the send was submitted", () => {
    // Approving the write queued ahead of the send replaces the draft's message, and only
    // `expectedProviderMessageId` is brought up to date.
    const {sent, hiddenMessageIds} = outboundOverlay([{
      type: "draftSend",
      approved: {...envelope, threadId: "t1", messageId: "first-revision"},
      messageId: "<draft@gadgets.invalid>",
      expectedProviderMessageId: "second-revision",
      dependsOn: [4],
    }], {decisions: [[4, "applied"]]});

    expect(sent[0].supersedesMessageId).toBe("second-revision");
    expect([...hiddenMessageIds]).toEqual(["second-revision"]);
  });

  it("hides nothing for a draft Gmail does not have yet", () => {
    const {sent, hiddenMessageIds} = outboundOverlay([{
      type: "draftSend",
      approved: {...envelope, threadId: "t1"},
      messageId: "<draft@gadgets.invalid>",
      dependsOn: [4],
    }]);

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty("supersedesMessageId");
    expect(hiddenMessageIds.size).toBe(0);
  });

  it("hides the message of a draft that is being deleted, once Gmail's ID for it is known", () => {
    const {sent, hiddenMessageIds} = outboundOverlay([
      {type: "draftDelete", expectedProviderMessageId: "draft-message"},
      {type: "draftDelete", dependsOn: [4]},
    ]);

    expect(sent).toEqual([]);
    expect([...hiddenMessageIds]).toEqual(["draft-message"]);
  });

  it("skips a draft action whose prerequisite was rejected", () => {
    const actions: GmailOutboundOverlayAction[] = [
      {
        type: "draftSend",
        approved: {...envelope, messageId: "draft-message"},
        messageId: "<draft@gadgets.invalid>",
        dependsOn: [4],
      },
      {type: "draftDelete", expectedProviderMessageId: "other-draft-message", dependsOn: [4]},
    ];

    const rejected = outboundOverlay(actions, {decisions: [[4, "rejected"]]});
    expect(rejected.sent).toEqual([]);
    expect(rejected.hiddenMessageIds.size).toBe(0);
    expect(outboundOverlay(actions, {decisions: [[4, "applied"]]}).sent).toHaveLength(1);
  });

  it("hides the draft of a send that returned no ID, without a message to open", () => {
    const {sent, hiddenMessageIds} = outboundOverlay([
      {type: "draftSend", approved: {...envelope, messageId: "draft-message"}},
    ]);

    expect(sent).toEqual([]);
    expect([...hiddenMessageIds]).toEqual(["draft-message"]);
  });
});

describe("thread messages with pending sends", () => {
  const original = message("m1", ["INBOX", "UNREAD"]);
  const ids = (overlay: GmailOverlay, messages: GmailMessageInfoRaw[], threadId = "thread") =>
    overlayThreadMessages(overlay, threadId, messages, [], everyPending).map(item => item.id);

  it("appends a pending reply after the thread's messages", () => {
    const overlay = outboundOverlay([reply("<reply@gadgets.invalid>", 5000)]);

    expect(overlayThreadMessages(overlay, "thread", [original], [], everyPending)).toEqual([
      original,
      {
        id: "<reply@gadgets.invalid>",
        threadId: "thread",
        from: {address: "me@example.com", name: "Me"},
        to: [{address: "sender@example.com"}],
        cc: [{address: "carol@example.com", name: "Carol"}],
        bcc: [{address: "hidden@example.com"}],
        subject: "Re: Subject",
        timestamp: new Date(5000),
        labelIds: ["SENT"],
      },
    ]);
  });

  it("leaves out mail sent into another thread, and new mail with no thread", () => {
    const overlay = outboundOverlay([
      reply("<elsewhere@gadgets.invalid>", 5000, "other"),
      {type: "send", spec: {...envelope, messageId: "<new@gadgets.invalid>"}, submittedAt: 6000},
    ]);
    expect(ids(overlay, [original])).toEqual(["m1"]);
  });

  it("orders pending replies by when they were submitted", () => {
    const overlay = outboundOverlay([
      reply("<second@gadgets.invalid>", 7000), reply("<first@gadgets.invalid>", 6000),
    ]);
    expect(ids(overlay, [original]))
      .toEqual(["m1", "<first@gadgets.invalid>", "<second@gadgets.invalid>"]);
  });

  it("shows only the pending mail the reading capability admits", () => {
    const overlay = outboundOverlay([
      reply("<mine@gadgets.invalid>", 5000), reply("<other@gadgets.invalid>", 6000),
    ]);
    const admitted = overlayThreadMessages(
      overlay, "thread", [original], [], sent => sent.rfcMessageId === "<mine@gadgets.invalid>");

    expect(admitted.map(item => item.id)).toEqual(["m1", "<mine@gadgets.invalid>"]);
    expect(overlayThreadMessages(overlay, "thread", [original], [], () => false))
      .toEqual([original]);
  });

  it("replaces a draft's message with the message it is being sent as", () => {
    const draft = {...message("draft-message", ["DRAFT"]), timestamp: new Date(2000)};
    const overlay = outboundOverlay([{
      type: "draftSend",
      approved: {...envelope, threadId: "thread", messageId: "draft-message"},
      messageId: "<draft@gadgets.invalid>",
      submittedAt: 5000,
    }]);

    expect(ids(overlay, [original, draft])).toEqual(["m1", "<draft@gadgets.invalid>"]);
    // The draft is hidden wherever it turns up, though the sent message joins one thread only.
    expect(ids(overlay, [{...draft, threadId: "other"}], "other")).toEqual([]);
  });

  it("patches labels on Gmail's messages next to a pending reply", () => {
    const overlay = {
      ...outboundOverlay([reply("<reply@gadgets.invalid>", 5000)]),
      labelChanges: overlayOf(
        {target: {kind: "messages", messageIds: ["m1"]}, add: [], remove: ["INBOX", "UNREAD"]},
      ).labelChanges,
    };
    expect(overlayThreadMessages(overlay, "thread", [original], [], everyPending)
      .map(item => item.labelIds)).toEqual([[], ["SENT"]]);
  });
});

describe("thread summaries with pending sends", () => {
  const original = {...message("m1", ["INBOX", "UNREAD"]), timestamp: new Date(1000)};
  const draft = {...message("draft-message", ["DRAFT"]), timestamp: new Date(2000)};

  it("counts a pending reply as the thread's newest message", () => {
    const overlay = {
      ...outboundOverlay([reply("<reply@gadgets.invalid>", 5000)]),
      labelChanges: overlayOf(
        {target: {kind: "messages", messageIds: ["m1"]}, add: [], remove: ["UNREAD"]},
      ).labelChanges,
    };

    expect(summarize(overlay, [original])).toEqual({
      id: "thread",
      subject: "Subject",
      messageCount: 2,
      latestMessageId: "<reply@gadgets.invalid>",
      timestamp: new Date(5000),
      participants: [
        {address: "sender@example.com"},
        {address: "me@example.com"},
        {address: "carol@example.com", name: "Carol"},
        {address: "hidden@example.com"},
      ],
      unread: false,
      labelIds: ["INBOX", "SENT"],
    });
  });

  it("keeps a message that arrived after the reply was submitted as the newest", () => {
    const overlay = outboundOverlay([reply("<reply@gadgets.invalid>", 5000)]);
    const later = {...message("m2", ["INBOX", "UNREAD"]), timestamp: new Date(6000)};

    expect(summarize(overlay, [original, later])).toMatchObject({
      messageCount: 3, latestMessageId: "m2", timestamp: new Date(6000),
    });
  });

  it("summarizes a sent draft in place of the draft's message", () => {
    const overlay = outboundOverlay([{
      type: "draftSend",
      approved: {...envelope, threadId: "thread", messageId: "draft-message"},
      messageId: "<draft@gadgets.invalid>",
      submittedAt: 5000,
    }]);

    expect(summarize(overlay, [original, draft])).toMatchObject({
      messageCount: 2,
      latestMessageId: "<draft@gadgets.invalid>",
      labelIds: ["INBOX", "UNREAD", "SENT"],
    });
  });

  it("drops a draft that is being deleted from the summary", () => {
    const overlay = outboundOverlay(
      [{type: "draftDelete", expectedProviderMessageId: "draft-message"}]);

    expect(summarize(overlay, [original, draft])).toMatchObject({
      messageCount: 1, latestMessageId: "m1", labelIds: ["INBOX", "UNREAD"],
    });
  });

  it("leaves a pending reply out of a summary whose capability does not admit it", () => {
    const overlay = outboundOverlay([reply("<reply@gadgets.invalid>", 5000)]);

    expect(summarize(overlay, [original], () => false)).toMatchObject({
      messageCount: 1, latestMessageId: "m1", labelIds: ["INBOX", "UNREAD"],
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
