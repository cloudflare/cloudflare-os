import {describe, expect, it} from "vitest";
import {
  GMAIL_MAILBOX_SCOPE, gmailMessagesAllowedByScope, gmailMutationTarget, gmailRestrictedScope,
  gmailScopeAllowsMessage, groupGmailMessagesByThread,
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

  it("uses message-level mutations for restricted threads", () => {
    expect(gmailMutationTarget(gmailRestrictedScope(["m1", "m2"]), "thread"))
      .toEqual({kind: "messages", messageIds: ["m1", "m2"]});
  });

  it("uses a thread endpoint only for whole-mailbox authority", () => {
    expect(gmailMutationTarget(GMAIL_MAILBOX_SCOPE, "thread"))
      .toEqual({kind: "thread", threadId: "thread"});
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
