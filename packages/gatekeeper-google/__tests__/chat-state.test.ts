// The overlay is what lets a caller stay unaware that approval sits between a write and Google.
// These tests pin the cases where getting it wrong would be visible: a queued message that never
// appears, one that appears twice, or a rejected action that leaves a ghost behind.

import { describe, expect, it } from "vitest";
import {
  ChatAction, PendingChatAction, overlayMessage, overlayMessageList, overlayReactions,
  pendingMessageActionId, pendingMessageName,
} from "../src/chat-state";
import type { GoogleChatMessageInfo, GoogleChatUser } from "../src/chat-types";

const SPACE = "spaces/AAAA";
const SELF: GoogleChatUser = { name: "users/me", displayName: "Ada", type: "human" };
const OTHER: GoogleChatUser = { name: "users/other", type: "human" };

function pending(...actions: ChatAction[]): PendingChatAction[] {
  return actions.map((action, index) => ({ id: index + 1, action }));
}

function message(name: string, text: string, extra: Partial<GoogleChatMessageInfo> = {}) {
  return {
    name: `${SPACE}/messages/${name}`,
    spaceName: SPACE,
    text,
    createTime: new Date("2024-01-01T00:00:00Z"),
    threadReply: false,
    deleted: false,
    attachments: [],
    reactions: [],
    ...extra,
  } satisfies GoogleChatMessageInfo;
}

const send: ChatAction = {
  type: "sendMessage",
  spaceName: SPACE,
  text: "queued hello",
  requestId: "r1",
  submittedAt: Date.parse("2024-02-01T00:00:00Z"),
};

describe("pending message names", () => {
  it("round-trips an action id and rejects everything else", () => {
    expect(pendingMessageActionId(pendingMessageName(7))).toBe(7);
    expect(pendingMessageActionId("spaces/AAAA/messages/BBB")).toBeUndefined();
    expect(pendingMessageActionId("pending:send:abc")).toBeUndefined();
    expect(pendingMessageActionId("pending:send:0")).toBeUndefined();
  });
});

describe("message list overlay", () => {
  const oldestFirst = { spaceName: SPACE, self: SELF, options: {} };

  it("appends a queued message only once the provider has no more pages", () => {
    const provider = [message("1", "first")];

    expect(overlayMessageList(provider, pending(send), {
      ...oldestFirst, first: true, exhausted: false,
    }).map(info => info.text)).toEqual(["first"]);

    const complete = overlayMessageList(provider, pending(send), {
      ...oldestFirst, first: false, exhausted: true,
    });
    expect(complete.map(info => info.text)).toEqual(["first", "queued hello"]);
    expect(complete[1]).toMatchObject({ name: pendingMessageName(1), pending: true, sender: SELF });
  });

  it("puts a queued message on only the first page when newest comes first", () => {
    const newestFirst = {
      spaceName: SPACE, self: SELF, options: { order: "newestFirst" as const },
    };
    expect(overlayMessageList([message("1", "newest")], pending(send), {
      ...newestFirst, first: true, exhausted: false,
    }).map(info => info.text)).toEqual(["queued hello", "newest"]);
    expect(overlayMessageList([message("2", "older")], pending(send), {
      ...newestFirst, first: false, exhausted: true,
    }).map(info => info.text)).toEqual(["older"]);
  });

  it("keeps another conversation's queued message out", () => {
    expect(overlayMessageList([], pending({ ...send, spaceName: "spaces/OTHER" }), {
      ...oldestFirst, first: true, exhausted: true,
    })).toEqual([]);
  });

  it("respects the thread and time filters the caller listed with", () => {
    const threaded: ChatAction = { ...send, threadName: `${SPACE}/threads/TTT` };
    expect(overlayMessageList([], pending(threaded), {
      ...oldestFirst, options: { threadName: `${SPACE}/threads/OTHER` },
      first: true, exhausted: true,
    })).toEqual([]);
    expect(overlayMessageList([], pending(send), {
      ...oldestFirst, options: { createdAfter: new Date("2024-03-01T00:00:00Z") },
      first: true, exhausted: true,
    })).toEqual([]);
  });

  it("shows a queued edit without changing other messages", () => {
    const edit: ChatAction = {
      type: "updateMessage",
      messageName: `${SPACE}/messages/1`,
      text: "edited",
      submittedAt: Date.now(),
    };
    const result = overlayMessageList(
      [message("1", "first"), message("2", "second")],
      pending(edit),
      { ...oldestFirst, first: true, exhausted: true });
    expect(result.map(info => info.text)).toEqual(["edited", "second"]);
  });

  it("only includes provider-deleted messages when requested", () => {
    const deleted = message("1", "", { deleted: true });
    expect(overlayMessageList([deleted], [], {
      ...oldestFirst, first: true, exhausted: true,
    })).toEqual([]);
    const [only] = overlayMessageList([deleted], [], {
      ...oldestFirst, options: { includeDeleted: true }, first: true, exhausted: true,
    });
    expect(only).toMatchObject({ deleted: true, text: "" });
  });

  // The overlay cannot recompute Chat's formatting markup, so a stale formatted body must not
  // survive an overlaid edit.
  it("drops formatted text whenever the overlay changes the body", () => {
    const formatted = message("1", "first", { formattedText: "*first*" });
    const edit: ChatAction = {
      type: "updateMessage", messageName: formatted.name, text: "edited", submittedAt: Date.now(),
    };
    const edited = overlayMessage(formatted, pending(edit));
    expect(edited.text).toBe("edited");
    expect(edited).not.toHaveProperty("formattedText");
  });

  it("never lets a queued edit put text back on a deleted message", () => {
    const edit: ChatAction = {
      type: "updateMessage",
      messageName: `${SPACE}/messages/1`,
      text: "edited",
      submittedAt: Date.now(),
    };
    expect(overlayMessage(message("1", "", { deleted: true }), pending(edit)))
      .toMatchObject({ deleted: true, text: "" });
  });
});

describe("reaction overlay", () => {
  const target = `${SPACE}/messages/1`;
  const add: ChatAction = {
    type: "addReaction", messageName: target, emoji: "🎉", submittedAt: Date.now(),
  };
  const remove: ChatAction = {
    type: "removeReaction", messageName: target, emoji: "👍", submittedAt: Date.now(),
  };
  const ownThumb = { name: `${target}/reactions/x`, emoji: "👍", user: SELF };
  const otherThumb = { name: `${target}/reactions/y`, emoji: "👍", user: OTHER };
  const emojis = (reactions: { emoji: string; user?: GoogleChatUser }[]) =>
    reactions.map(reaction => [reaction.emoji, reaction.user?.name]);

  it("leaves aggregate counts provider-backed rather than guessing the user's presence", () => {
    const info = overlayMessage(
      message("1", "first", { reactions: [{ emoji: "🎉", count: 1 }] }),
      pending(add, add, remove));
    expect(info.reactions).toEqual([{ emoji: "🎉", count: 1 }]);
  });

  it("adds and removes only the connected user's own reactions", () => {
    const result = overlayReactions([ownThumb, otherThumb], pending(add, remove), {
      messageName: target, self: SELF, exhausted: true,
    });
    expect(emojis(result)).toEqual([["👍", "users/other"], ["🎉", "users/me"]]);
  });

  it("applies removals on every page and additions only after the final page", () => {
    const context = { messageName: target, self: SELF };
    expect(emojis(overlayReactions([ownThumb, otherThumb], pending(add, remove), {
      ...context, exhausted: false,
    }))).toEqual([["👍", "users/other"]]);
    expect(emojis(overlayReactions([], pending(add, remove), { ...context, exhausted: true })))
      .toEqual([["🎉", "users/me"]]);
  });

  // The user may already have reacted in the Chat UI by the time the queued add is listed. Each
  // page drops the provider's copy and the final page adds exactly one, so the reaction shows
  // once regardless of which page the provider put it on.
  it("shows a queued reaction once even when the provider already has it", () => {
    const ownParty = { name: `${target}/reactions/z`, emoji: "🎉", user: SELF };
    const context = { messageName: target, self: SELF };
    expect(overlayReactions([ownParty], pending(add), { ...context, exhausted: false }))
      .toEqual([]);
    expect(emojis(overlayReactions([ownParty], pending(add), { ...context, exhausted: true })))
      .toEqual([["🎉", "users/me"]]);
  });
});
