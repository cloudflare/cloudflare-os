// The overlay is what lets a caller stay unaware that approval sits between a write and Google.
// These tests pin the cases where getting it wrong would be visible: a queued message that never
// appears, one that appears twice, or a rejected action that leaves a ghost behind.

import { describe, expect, it } from "vitest";
import {
  ChatAction, PendingChatAction, hasPendingLeave, overlayMemberships, overlayMessage,
  overlayMessageList, overlayNotificationSettings, overlayPins, overlayReactions,
  pendingMessageActionId, pendingMessageName,
} from "../src/chat-state";
import type { GoogleChatMessageInfo, GoogleChatUser } from "../src/chat-types";

const SPACE = "spaces/AAAA";
const SELF: GoogleChatUser = { name: "users/me", displayName: "Ada", type: "human" };

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
  uploads: [],
  requestId: "r1",
  submittedAt: Date.parse("2024-02-01T00:00:00Z"),
};

describe("pending message names", () => {
  it("round-trips an action id", () => {
    expect(pendingMessageActionId(pendingMessageName(7))).toBe(7);
    expect(pendingMessageActionId("spaces/AAAA/messages/BBB")).toBeUndefined();
  });
});

describe("message list overlay", () => {
  it("appends a queued message only once the provider has no more pages", () => {
    const provider = [message("1", "first")];
    const context = { spaceName: SPACE, self: SELF, options: {} };

    expect(overlayMessageList(provider, pending(send), { ...context, exhausted: false })
      .map(info => info.text)).toEqual(["first"]);

    const complete = overlayMessageList(provider, pending(send), { ...context, exhausted: true });
    expect(complete.map(info => info.text)).toEqual(["first", "queued hello"]);
    expect(complete[1]).toMatchObject({
      name: pendingMessageName(1), pending: true, sender: SELF,
    });
  });

  it("puts a queued message first when the caller asked for newest first", () => {
    expect(overlayMessageList([message("1", "first")], pending(send), {
      spaceName: SPACE, self: SELF, options: { order: "newestFirst" }, exhausted: true,
    }).map(info => info.text)).toEqual(["queued hello", "first"]);
  });

  it("keeps another conversation's queued message out", () => {
    expect(overlayMessageList([], pending({ ...send, spaceName: "spaces/OTHER" }), {
      spaceName: SPACE, self: SELF, options: {}, exhausted: true,
    })).toEqual([]);
  });

  it("respects the thread and time filters the caller listed with", () => {
    const threaded: ChatAction = { ...send, threadName: `${SPACE}/threads/TTT` };
    expect(overlayMessageList([], pending(threaded), {
      spaceName: SPACE, self: SELF, options: { threadName: `${SPACE}/threads/OTHER` },
      exhausted: true,
    })).toEqual([]);
    expect(overlayMessageList([], pending(send), {
      spaceName: SPACE, self: SELF,
      options: { createdAfter: new Date("2024-03-01T00:00:00Z") },
      exhausted: true,
    })).toEqual([]);
  });

  it("shows a queued edit and hides a queued delete", () => {
    const edit: ChatAction = {
      type: "updateMessage",
      messageName: `${SPACE}/messages/1`,
      text: "edited",
      submittedAt: Date.now(),
    };
    const remove: ChatAction = {
      type: "deleteMessage", messageName: `${SPACE}/messages/2`, submittedAt: Date.now(),
    };
    const result = overlayMessageList(
      [message("1", "first"), message("2", "second")],
      pending(edit, remove),
      { spaceName: SPACE, self: SELF, options: {}, exhausted: true });
    expect(result.map(info => info.text)).toEqual(["edited"]);
  });

  it("keeps a queued delete visible when the caller asked for deleted messages", () => {
    const remove: ChatAction = {
      type: "deleteMessage", messageName: `${SPACE}/messages/1`, submittedAt: Date.now(),
    };
    const [only] = overlayMessageList([message("1", "first")], pending(remove), {
      spaceName: SPACE, self: SELF, options: { includeDeleted: true }, exhausted: true,
    });
    expect(only).toMatchObject({ deleted: true, text: "" });
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

  it("counts a queued reaction in the summary", () => {
    const info = overlayMessage(
      message("1", "first", { reactions: [{ emoji: "🎉", count: 1 }] }), pending(add));
    expect(info?.reactions).toEqual([{ emoji: "🎉", count: 2 }]);
  });

  it("drops a summary that a queued removal empties", () => {
    const info = overlayMessage(
      message("1", "first", { reactions: [{ emoji: "👍", count: 1 }] }), pending(remove));
    expect(info?.reactions).toEqual([]);
  });

  it("adds and removes the connected user's own reaction in the detailed list", () => {
    const existing = [
      { name: `${target}/reactions/x`, emoji: "👍", user: SELF },
      { name: `${target}/reactions/y`, emoji: "👍", user: { name: "users/other", type: "human" as const } },
    ];
    const result = overlayReactions(existing, pending(add, remove), {
      messageName: target, self: SELF,
    });
    expect(result.map(reaction => [reaction.emoji, reaction.user?.name])).toEqual([
      ["👍", "users/other"],
      ["🎉", "users/me"],
    ]);
  });

  it("applies removals on every page and additions only after the final page", () => {
    const seenOwnEmojis = new Set<string>();
    const firstPage = overlayReactions([
      { name: `${target}/reactions/x`, emoji: "👍", user: SELF },
      { name: `${target}/reactions/y`, emoji: "👍", user: { name: "users/other", type: "human" as const } },
    ], pending(add, remove), {
      messageName: target, self: SELF, exhausted: false, seenOwnEmojis,
    });
    expect(firstPage.map(reaction => [reaction.emoji, reaction.user?.name]))
      .toEqual([["👍", "users/other"]]);

    const finalPage = overlayReactions([], pending(add, remove), {
      messageName: target, self: SELF, exhausted: true, seenOwnEmojis,
    });
    expect(finalPage.map(reaction => [reaction.emoji, reaction.user?.name]))
      .toEqual([["🎉", "users/me"]]);
  });
});

describe("pin overlay", () => {
  const first = `${SPACE}/messages/1`;
  const second = `${SPACE}/messages/2`;

  it("adds a queued pin at the end of the last page and removes a queued unpin everywhere", () => {
    const actions = pending(
      { type: "pinMessage", spaceName: SPACE, messageName: second, submittedAt: Date.now() },
      { type: "unpinMessage", spaceName: SPACE, messageName: first, submittedAt: Date.now() },
    );
    expect(overlayPins([first], actions, { spaceName: SPACE, exhausted: false })).toEqual([]);
    expect(overlayPins([first], actions, { spaceName: SPACE, exhausted: true })).toEqual([second]);
  });

  it("does not pin the same message twice", () => {
    const actions = pending({
      type: "pinMessage", spaceName: SPACE, messageName: first, submittedAt: Date.now(),
    });
    expect(overlayPins([first], actions, { spaceName: SPACE, exhausted: true })).toEqual([first]);
  });
});

describe("settings and membership overlay", () => {
  it("shows queued notification changes", () => {
    expect(overlayNotificationSettings({ level: "all", muted: false }, pending({
      type: "updateNotificationSettings",
      spaceName: SPACE,
      patch: { muted: true },
      submittedAt: Date.now(),
    }), SPACE)).toEqual({ level: "all", muted: true });
  });

  it("removes only the connected user's membership once leaving is queued", () => {
    const mine = {
      name: `${SPACE}/members/me`, state: "joined" as const, role: "member" as const, member: SELF,
    };
    const theirs = {
      name: `${SPACE}/members/other`, state: "joined" as const, role: "member" as const,
    };
    const actions = pending({
      type: "leaveSpace", spaceName: SPACE, membershipName: mine.name, submittedAt: Date.now(),
    });
    expect(overlayMemberships([mine, theirs], actions, SPACE)).toEqual([theirs]);
    expect(hasPendingLeave(actions, SPACE)).toBe(true);
    expect(hasPendingLeave(actions, "spaces/OTHER")).toBe(false);
  });
});
