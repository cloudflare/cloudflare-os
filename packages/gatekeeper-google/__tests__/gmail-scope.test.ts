import {describe, expect, it} from "vitest";
import {
  GMAIL_MAILBOX_SCOPE, gmailMessagesAllowedByScope, gmailRestrictedScope,
  gmailScopeAllowsMessage, gmailThreadMutationTarget, groupGmailMessagesByThread,
} from "../src/gmail-scope";

describe("restricted Gmail capability scope", () => {
  it("never exposes a nonmatching sibling from the same thread", () => {
    const scope = gmailRestrictedScope(["matching"]);
    expect(gmailMessagesAllowedByScope(scope, [
      {id: "matching", body: "allowed"},
      {id: "sibling", body: "secret"},
    ])).toEqual([{id: "matching", body: "allowed"}]);
    expect(gmailScopeAllowsMessage(scope, "sibling")).toBe(false);
  });

  it("mutates only the admitted messages of a restricted thread, in thread order", () => {
    expect(gmailThreadMutationTarget(gmailRestrictedScope(["m3", "m1"]), ["m1", "m2", "m3"]))
      .toEqual({kind: "messages", messageIds: ["m1", "m3"]});
  });

  it("names every current message for whole-mailbox authority, never the thread", () => {
    expect(gmailThreadMutationTarget(GMAIL_MAILBOX_SCOPE, ["m1", "m2", "m1"]))
      .toEqual({kind: "messages", messageIds: ["m1", "m2"]});
  });

  it("stops at lastMessageId so later messages are untouched", () => {
    expect(gmailThreadMutationTarget(GMAIL_MAILBOX_SCOPE, ["m1", "m2", "m3"], "m2"))
      .toEqual({kind: "messages", messageIds: ["m1", "m2"]});
    expect(gmailThreadMutationTarget(gmailRestrictedScope(["m1", "m3"]), ["m1", "m2", "m3"], "m1"))
      .toEqual({kind: "messages", messageIds: ["m1"]});
  });

  it("rejects a lastMessageId outside the thread or the capability", () => {
    expect(() => gmailThreadMutationTarget(GMAIL_MAILBOX_SCOPE, ["m1"], "elsewhere"))
      .toThrow(/lastMessageId/);
    expect(() => gmailThreadMutationTarget(gmailRestrictedScope(["m1"]), ["m1", "m2"], "m2"))
      .toThrow(/lastMessageId/);
  });

  describe("when lastMessageId is a message this binding sent", () => {
    // The reply was submitted at 5000. `late` reached the thread after that, and Gmail files the
    // delivered reply after it, though the thread has shown the reply since 5000.
    const appearedAt = new Map([["m1", 1000], ["m2", 2000], ["late", 6000], ["reply", 5000]]);

    it("targets what Gmail had when a still-pending reply was submitted, and not the reply", () => {
      expect(gmailThreadMutationTarget(
        GMAIL_MAILBOX_SCOPE, ["m1", "m2", "late"], {submittedAt: 5000, appearedAt}))
        .toEqual({kind: "messages", messageIds: ["m1", "m2"]});
    });

    it("includes a message Gmail timestamped at the moment of submission", () => {
      expect(gmailThreadMutationTarget(
        GMAIL_MAILBOX_SCOPE, ["m1", "m2"], {submittedAt: 2000, appearedAt}))
        .toEqual({kind: "messages", messageIds: ["m1", "m2"]});
    });

    it("keeps the same cutoff once the reply is delivered, and adds the reply", () => {
      expect(gmailThreadMutationTarget(
        GMAIL_MAILBOX_SCOPE, ["m1", "m2", "late", "reply"], {submittedAt: 5000, appearedAt}))
        .toEqual({kind: "messages", messageIds: ["m1", "m2", "reply"]});
    });

    it("includes an earlier reply this binding sent, though Gmail dates it at its delivery", () => {
      // Submitted at 4000 and shown in the thread from then, but delivered after the boundary.
      expect(gmailThreadMutationTarget(GMAIL_MAILBOX_SCOPE, ["m1", "earlier", "late"], {
        submittedAt: 5000, appearedAt: new Map([...appearedAt, ["earlier", 4000]]),
      })).toEqual({kind: "messages", messageIds: ["m1", "earlier"]});
    });

    it("reaches only the messages a restricted capability admits", () => {
      const boundary = {submittedAt: 5000, appearedAt};

      expect(gmailThreadMutationTarget(
        gmailRestrictedScope(["m2", "late"]), ["m1", "m2", "late", "reply"], boundary))
        .toEqual({kind: "messages", messageIds: ["m2"]});
      expect(gmailThreadMutationTarget(
        gmailRestrictedScope(["m2", "reply"]), ["m1", "m2", "late", "reply"], boundary))
        .toEqual({kind: "messages", messageIds: ["m2", "reply"]});
    });

    it("leaves out a message whose timestamp is unknown", () => {
      expect(gmailThreadMutationTarget(
        GMAIL_MAILBOX_SCOPE, ["m1", "unknown"], {submittedAt: 5000, appearedAt}))
        .toEqual({kind: "messages", messageIds: ["m1"]});
    });

    it("refuses when nothing Gmail has is at or before the reply", () => {
      expect(() => gmailThreadMutationTarget(
        GMAIL_MAILBOX_SCOPE, ["late"], {submittedAt: 5000, appearedAt}))
        .toThrow(/has been delivered/);
      // A restricted capability that admits only the pending reply itself.
      expect(() => gmailThreadMutationTarget(
        gmailRestrictedScope([]), ["m1"], {submittedAt: 5000, appearedAt}))
        .toThrow(/has been delivered/);
    });

    it("stops at Gmail's copy by position when the send recorded no submission time", () => {
      // The caller resolves such a receipt to the reply's Gmail ID, and the existing rule applies.
      expect(gmailThreadMutationTarget(GMAIL_MAILBOX_SCOPE, ["m1", "m2", "reply", "late"], "reply"))
        .toEqual({kind: "messages", messageIds: ["m1", "m2", "reply"]});
    });
  });

  it("rejects a thread with no admitted messages", () => {
    expect(() => gmailThreadMutationTarget(gmailRestrictedScope(["gone"]), ["m1"]))
      .toThrow(/admits no messages/);
  });

  it("groups matching messages without adding siblings", () => {
    expect(groupGmailMessagesByThread([
      {id: "m1", threadId: "t1"},
      {id: "m2", threadId: "t2"},
      {id: "m3", threadId: "t1"},
    ])).toEqual([
      {threadId: "t1", messages: [{id: "m1", threadId: "t1"}, {id: "m3", threadId: "t1"}]},
      {threadId: "t2", messages: [{id: "m2", threadId: "t2"}]},
    ]);
  });

  it("groups matches across provider pages once and de-duplicates message IDs", () => {
    const pages = [
      [{id: "m1", threadId: "t1"}, {id: "m2", threadId: "t2"}],
      [{id: "m3", threadId: "t1"}, {id: "m2", threadId: "t2"}],
    ];
    expect(groupGmailMessagesByThread(pages.flat())).toEqual([
      {threadId: "t1", messages: [{id: "m1", threadId: "t1"}, {id: "m3", threadId: "t1"}]},
      {threadId: "t2", messages: [{id: "m2", threadId: "t2"}]},
    ]);
  });
});
