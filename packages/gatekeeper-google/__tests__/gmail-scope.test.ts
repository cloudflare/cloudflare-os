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
