import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatApi, chatMessageInfoFromRaw, chatMessageParts, chatMessagesListFilter,
  chatMessagesSearchFilter, chatMembershipFromRaw,
  chatSpaceId, chatSpaceInfoFromRaw, chatSpacesListFilter, chatSpacesSearchQuery, chatThreadParts,
  chatUserName, validateChatEmoji, validateChatSpaceId,
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

  // `.` and `..` pass the documented character set but are collapsed out of the URL path by the
  // fetch layer, so messages/.. would reach spaces.get instead of messages.get.
  it.each([".", ".."])("rejects the dot segment %s as an id", dots => {
    expect(() => chatMessageParts(`spaces/AAAA/messages/${dots}`)).toThrow(/Invalid Google Chat message ID/);
    expect(() => chatThreadParts(`spaces/AAAA/threads/${dots}`)).toThrow(/Invalid Google Chat thread ID/);
    expect(() => chatUserName(dots)).toThrow(/Invalid Google Chat user reference/);
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
      since: new Date("2024-01-01T00:00:00Z"),
      before: new Date("2024-02-01T00:00:00Z"),
      threadName: "spaces/AAAA/threads/TTT",
    })).toBe(
      'createTime > "2023-12-31T23:59:59.999Z" AND createTime < "2024-02-01T00:00:00.000Z" AND ' +
      "thread.name = spaces/AAAA/threads/TTT");
    expect(chatMessagesListFilter({})).toBeUndefined();
  });

  it("combines every message search field with AND", () => {
    expect(chatMessagesSearchFilter({
      text: "quarterly report",
      spaceIds: ["spaces/AAAA", "spaces/BBBB"],
      senders: ["users/123", "person@example.com"],
      mentions: ["users/456"],
      since: new Date("2024-03-01T00:00:00Z"),
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
});

describe("Chat response mapping", () => {
  it("maps a space", () => {
    expect(chatSpaceInfoFromRaw({
      name: "spaces/AAAA",
      displayName: "Project",
      spaceType: "SPACE",
      spaceThreadingState: "THREADED_MESSAGES",
      spaceUri: "https://chat.google.com/room/AAAA",
      spaceDetails: { description: "Planning" },
      createTime: "2024-01-01T00:00:00Z",
      membershipCount: { joinedDirectHumanUserCount: 7 },
    })).toEqual({
      id: "spaces/AAAA",
      name: "Project",
      url: "https://chat.google.com/room/AAAA",
      type: "space",
      supportsThreads: true,
      description: "Planning",
      createdAt: new Date("2024-01-01T00:00:00Z"),
      memberCount: 7,
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
      id: "spaces/AAAA/messages/BBB",
      spaceId: "spaces/AAAA",
      threadId: "spaces/AAAA/threads/TTT",
      sender: { id: "users/123", name: "Ada", type: "human" },
      text: "hello",
      isReply: true,
      deleted: false,
      reactions: [{ emoji: "🎉", count: 2 }],
    });
    expect(info.attachments).toEqual([{
      id: "spaces/AAAA/messages/BBB/attachments/CCC",
      filename: "notes.pdf",
      mimeType: "application/pdf",
      source: "uploaded",
      readable: true,
    }]);
  });

  it.each([
    ["SPACE", "THREADED_MESSAGES", true],
    ["SPACE", "GROUPED_MESSAGES", true],
    ["SPACE", "UNTHREADED_MESSAGES", false],
    ["SPACE", undefined, false],
    ["DIRECT_MESSAGE", "THREADED_MESSAGES", false],
    ["GROUP_CHAT", "THREADED_MESSAGES", false],
  ])("reports API thread support for %s / %s", (spaceType, spaceThreadingState, supported) => {
    expect(chatSpaceInfoFromRaw({name: "spaces/AAAA", spaceType, spaceThreadingState})
      .supportsThreads).toBe(supported);
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

  it("reports a deleted message as deleted, with any residual text withheld", () => {
    expect(chatMessageInfoFromRaw({
      name: "spaces/AAAA/messages/BBB",
      createTime: "2024-01-02T03:04:05Z",
      text: "meeting at noon",
      deletionMetadata: { deletionType: "CREATOR" },
    })).toMatchObject({ deleted: true, text: "" });
  });

  it("rejects app-authored private messages", () => {
    expect(() => chatMessageInfoFromRaw({
      name: "spaces/AAAA/messages/PRIVATE",
      createTime: "2024-01-02T03:04:05Z",
      text: "only one space member may see this",
      privateMessageViewer: { name: "users/123" },
    })).toThrow(/not available through this connection/);
  });

  it("maps a membership", () => {
    expect(chatMembershipFromRaw({
      name: "spaces/AAAA/members/111",
      state: "JOINED",
      role: "ROLE_MANAGER",
      member: { name: "users/123", displayName: "Ada", type: "HUMAN" },
    })).toMatchObject({ state: "joined", role: "manager" });
  });
});

describe("Chat provider error handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubResponse(status: number, body: unknown): ChatApi {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify(body), { status }));
    return new ChatApi(async () => "token");
  }

  it("enforces half-open windows and thread scope even if the provider ignores its filters", async () => {
    const since = new Date("2024-01-01T00:00:00Z");
    const before = new Date("2024-01-02T00:00:00Z");
    const threadName = "spaces/AAAA/threads/TTT";
    const messages = [
      {name: "spaces/AAAA/messages/early", createTime: new Date(+since - 1).toISOString()},
      {name: "spaces/AAAA/messages/start", createTime: since.toISOString()},
      {name: "spaces/AAAA/messages/end", createTime: before.toISOString()},
      {name: "spaces/AAAA/messages/sibling", createTime: since.toISOString(), thread: {name: "spaces/AAAA/threads/OTHER"}},
      {name: "spaces/OTHER/messages/foreign", createTime: since.toISOString()},
    ].map(message => ({thread: {name: threadName}, ...message}));
    const api = stubResponse(200, {messages, nextPageToken: "next"});
    const page = await api.listMessages("spaces/AAAA", {since, before, threadName});
    expect(page.items.map(message => message.id)).toEqual(["spaces/AAAA/messages/start"]);
    expect(page.nextPageToken).toBe("next");
    await expect(api.listMessages("spaces/AAAA", {since: before, before: since}))
      .rejects.toThrow(/since must be earlier/);
    await expect(api.listMessages("spaces/AAAA", {threadName: "spaces/OTHER/threads/TTT"}))
      .rejects.toThrow(/different conversation/);
  });

  // Google answers a lookup that names no real account with 400, not 404. Both are the same
  // negative answer to "is there a DM / membership for X?", so both must map to null — a caller
  // following the documented contract would otherwise crash on the most common probe.
  it("answers null for a user reference that names no account", async () => {
    const api = stubResponse(400, { error: { status: "INVALID_ARGUMENT" } });
    expect(await api.findDirectMessage("nobody@example.com")).toBeNull();
    expect(await api.getMembership("spaces/AAAA", "nobody@example.com")).toBeNull();
  });

  // Chat error prose can quote message text back, so only the closed google.rpc code enum may
  // travel — a fabricated status string must not reach the error message.
  it("surfaces the canonical rpc code and nothing else from an error body", async () => {
    await expect(stubResponse(400, { error: { status: "FAILED_PRECONDITION" } })
      .getMessage("spaces/AAAA/messages/BBB"))
      .rejects.toThrow(/messages\.get failed \[http=400 FAILED_PRECONDITION\]/);
    await expect(stubResponse(400, { error: { status: "user text could leak here" } })
      .getMessage("spaces/AAAA/messages/BBB"))
      .rejects.toThrow(/messages\.get failed \[http=400\]$/);
  });
});
