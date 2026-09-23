import { describe, expect, it } from "vitest";
import {
  chatMessageInfoFromRaw, chatMessageParts, chatMessagesListFilter, chatMessagesSearchFilter,
  chatMembershipFromRaw, chatSpaceEventsFilter, chatSpaceEventsFromRaw, chatSpaceId,
  chatSpaceInfoFromRaw, chatSpacesListFilter, chatSpacesSearchQuery, chatThreadParts,
  chatThreadPartsInSpace, chatUserName, validateChatEmoji, validateChatSpaceId,
} from "../src/chat-api";

// Every identifier below is interpolated into a request path or a filter string, so the checks
// have to happen before the value can reach Google, not after.
describe("Chat identifier validation", () => {
  it("accepts the documented resource name shapes", () => {
    expect(chatSpaceId("spaces/AAAA1234")).toBe("AAAA1234");
    expect(chatMessageParts("spaces/AAAA/messages/BBB.CCC"))
      .toEqual({ spaceId: "AAAA", messageId: "BBB.CCC" });
    expect(chatThreadParts("spaces/AAAA/threads/TTT"))
      .toEqual({ spaceId: "AAAA", threadId: "TTT" });
  });

  it.each([
    "spaces/../../evil",
    "spaces/AAAA/messages/BBB",
    "AAAA1234",
    "spaces/",
  ])("rejects %s as a space name", value => {
    expect(() => chatSpaceId(value)).toThrow();
  });

  it("rejects a space id that could escape its path segment", () => {
    expect(() => validateChatSpaceId("a/b")).toThrow(/Invalid Google Chat space ID/);
    expect(() => validateChatSpaceId("a b")).toThrow(/Invalid Google Chat space ID/);
  });

  it("requires a thread to belong to the bound conversation", () => {
    expect(chatThreadPartsInSpace("spaces/AAAA", "spaces/AAAA/threads/TTT"))
      .toEqual({ spaceId: "AAAA", threadId: "TTT" });
    expect(() => chatThreadPartsInSpace("spaces/AAAA", "spaces/OTHER/threads/TTT"))
      .toThrow(/different Google Chat conversation/);
  });

  it("normalizes a user reference given either way", () => {
    expect(chatUserName("users/123")).toBe("users/123");
    expect(chatUserName("person@example.com")).toBe("users/person@example.com");
    expect(() => chatUserName("users/a/b")).toThrow(/Invalid Google Chat user reference/);
  });

  // The reaction API takes a Unicode emoji or a custom-emoji resource; this gatekeeper offers
  // only the former, so a shortcode has to fail loudly rather than be posted as literal text.
  it("accepts a Unicode emoji and rejects a shortcode", () => {
    expect(validateChatEmoji("🎉")).toBe("🎉");
    expect(() => validateChatEmoji(":tada:")).toThrow(/Unicode emoji/);
    expect(() => validateChatEmoji('a" OR user.name = "users/me')).toThrow(/Invalid reaction/);
  });
});

describe("Chat filter construction", () => {
  it("filters a space listing by type", () => {
    expect(chatSpacesListFilter(["space", "directMessage"]))
      .toBe('spaceType = "SPACE" OR spaceType = "DIRECT_MESSAGE"');
    expect(chatSpacesListFilter([])).toBeUndefined();
    expect(chatSpacesListFilter(undefined)).toBeUndefined();
  });

  // Non-admin space search only ever matches named spaces, so the query always pins spaceType.
  it("builds a non-admin space search query", () => {
    expect(chatSpacesSearchQuery("Project review"))
      .toBe('spaceType = "SPACE" AND displayName:"Project review"');
    expect(() => chatSpacesSearchQuery("   ")).toThrow(/display name/);
  });

  it("builds a message list filter from the time window and thread", () => {
    expect(chatMessagesListFilter({
      createdAfter: new Date("2024-01-01T00:00:00Z"),
      createdBefore: new Date("2024-02-01T00:00:00Z"),
      threadName: "spaces/AAAA/threads/TTT",
    })).toBe(
      'createTime > "2024-01-01T00:00:00.000Z" AND createTime < "2024-02-01T00:00:00.000Z" AND ' +
      "thread.name = spaces/AAAA/threads/TTT");
    expect(chatMessagesListFilter({})).toBeUndefined();
  });

  it("combines every message search field with AND", () => {
    expect(chatMessagesSearchFilter({
      text: "quarterly report",
      spaceNames: ["spaces/AAAA", "spaces/BBBB"],
      senders: ["users/123", "person@example.com"],
      mentions: ["users/456"],
      createdAfter: new Date("2024-03-01T00:00:00Z"),
      unreadOnly: true,
      hasAttachment: true,
      hasLink: true,
    })).toBe(
      '"quarterly report" AND (space.name = "spaces/AAAA" OR space.name = "spaces/BBBB") AND ' +
      '(sender.name = "users/123" OR sender.name = "users/person@example.com") AND ' +
      '(annotations.user_mentions.user.name:"users/456") AND ' +
      'createTime >= "2024-03-01T00:00:00.000Z" AND is_unread() AND attachment:* AND has_link()');
  });

  // Search text is caller-supplied prose. Quoting it is what keeps a stray quote from ending the
  // phrase and starting a second filter term.
  it("escapes quotes and backslashes in search text", () => {
    expect(chatMessagesSearchFilter({ text: 'say "hi" \\ bye' }))
      .toBe('"say \\"hi\\" \\\\ bye"');
  });

  it("refuses a message search with nothing to filter on", () => {
    expect(() => chatMessagesSearchFilter({})).toThrow(/at least one filter/);
  });

  it("builds an event filter with the provider event-type strings", () => {
    expect(chatSpaceEventsFilter({
      types: ["messageCreated", "reactionCreated"],
      startTime: new Date("2024-05-01T00:00:00Z"),
    })).toBe(
      'startTime="2024-05-01T00:00:00.000Z" AND ' +
      '(eventTypes:"google.workspace.chat.message.v1.created" OR ' +
      'eventTypes:"google.workspace.chat.reaction.v1.created")');
    expect(() => chatSpaceEventsFilter({ types: [] })).toThrow(/at least one event type/);
  });
});

describe("Chat response mapping", () => {
  it("maps a space", () => {
    expect(chatSpaceInfoFromRaw({
      name: "spaces/AAAA",
      displayName: "Project",
      spaceType: "SPACE",
      spaceUri: "https://chat.google.com/room/AAAA",
      spaceDetails: { description: "Planning" },
      createTime: "2024-01-01T00:00:00Z",
      membershipCount: { joinedDirectHumanUserCount: 7 },
      externalUserAllowed: false,
    })).toEqual({
      name: "spaces/AAAA",
      displayName: "Project",
      url: "https://chat.google.com/room/AAAA",
      type: "space",
      description: "Planning",
      createTime: new Date("2024-01-01T00:00:00Z"),
      memberCount: 7,
      externalUsersAllowed: false,
    });
  });

  it("maps a message with attachments and reactions", () => {
    const info = chatMessageInfoFromRaw({
      name: "spaces/AAAA/messages/BBB",
      sender: { name: "users/123", displayName: "Ada", type: "HUMAN" },
      createTime: "2024-01-02T03:04:05Z",
      text: "hello",
      thread: { name: "spaces/AAAA/threads/TTT" },
      space: { name: "spaces/AAAA" },
      threadReply: true,
      attachment: [{
        name: "spaces/AAAA/messages/BBB/attachments/CCC",
        contentName: "notes.pdf",
        contentType: "application/pdf",
        source: "UPLOADED_CONTENT",
        attachmentDataRef: { resourceName: "media/xyz" },
      }],
      emojiReactionSummaries: [{ emoji: { unicode: "🎉" }, reactionCount: 2 }],
    });
    expect(info).toMatchObject({
      name: "spaces/AAAA/messages/BBB",
      spaceName: "spaces/AAAA",
      threadName: "spaces/AAAA/threads/TTT",
      sender: { name: "users/123", displayName: "Ada", type: "human" },
      text: "hello",
      threadReply: true,
      deleted: false,
      reactions: [{ emoji: "🎉", count: 2 }],
    });
    expect(info.attachments).toEqual([{
      name: "spaces/AAAA/messages/BBB/attachments/CCC",
      filename: "notes.pdf",
      mimeType: "application/pdf",
      source: "uploaded",
      readable: true,
    }]);
  });

  // A Drive-backed attachment has no Chat media reference, so it must never be advertised as
  // readable through this gatekeeper.
  it("marks a Drive attachment unreadable", () => {
    const info = chatMessageInfoFromRaw({
      name: "spaces/AAAA/messages/BBB",
      createTime: "2024-01-02T03:04:05Z",
      attachment: [{
        contentName: "sheet",
        contentType: "application/vnd.google-apps.spreadsheet",
        source: "DRIVE_FILE",
        driveDataRef: { driveFileId: "FILE1" },
      }],
    });
    expect(info.attachments[0]).toMatchObject({
      source: "drive", driveFileId: "FILE1", readable: false,
    });
  });

  it("reports a deleted message as deleted", () => {
    expect(chatMessageInfoFromRaw({
      name: "spaces/AAAA/messages/BBB",
      createTime: "2024-01-02T03:04:05Z",
      deletionMetadata: { deletionType: "CREATOR" },
    }).deleted).toBe(true);
  });

  it("maps a membership", () => {
    expect(chatMembershipFromRaw({
      name: "spaces/AAAA/members/111",
      state: "JOINED",
      role: "ROLE_MANAGER",
      member: { name: "users/123", displayName: "Ada", type: "HUMAN" },
    })).toMatchObject({ state: "joined", role: "manager" });
  });

  // Subscribing to one event type implicitly subscribes to its batch form, so the batch payload
  // has to arrive as ordinary events rather than as a second shape callers must understand.
  it("flattens a batch event into one event per item", () => {
    const events = chatSpaceEventsFromRaw({
      name: "spaces/AAAA/spaceEvents/EEE",
      eventTime: "2024-06-01T00:00:00Z",
      eventType: "google.workspace.chat.message.v1.batchCreated",
      messageBatchCreatedEventData: {
        messages: [
          { message: { name: "spaces/AAAA/messages/1", createTime: "2024-06-01T00:00:00Z" } },
          { message: { name: "spaces/AAAA/messages/2", createTime: "2024-06-01T00:00:01Z" } },
        ],
      },
    });
    expect(events).toHaveLength(2);
    expect(events.map(event => event.type)).toEqual(["messageCreated", "messageCreated"]);
    expect(events.map(event => event.message?.name))
      .toEqual(["spaces/AAAA/messages/1", "spaces/AAAA/messages/2"]);
  });

  it("drops an event whose type it does not model", () => {
    expect(chatSpaceEventsFromRaw({
      name: "spaces/AAAA/spaceEvents/EEE",
      eventTime: "2024-06-01T00:00:00Z",
      eventType: "google.workspace.chat.something.v1.happened",
    })).toEqual([]);
  });
});
