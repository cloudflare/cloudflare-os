import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatApi } from "../src/chat-api";
import { describeConversation } from "../src/chat-names";
import type { ChatMembership, ChatSpaceInfo } from "../src/chat-types";

const dm = (id = "A"): ChatSpaceInfo => ({ id: `spaces/${id}`, type: "directMessage", supportsThreads: false });
const group = (extra: Partial<ChatSpaceInfo> = {}): ChatSpaceInfo =>
  ({ id: "spaces/G", type: "groupChat", supportsThreads: true, ...extra });
const member = (space: string, id: string, name?: string): ChatMembership => ({
  id: `${space}/members/${id}`, state: "joined", role: "member", kind: "user",
  user: { id: `users/${id}`, type: "human", ...(name ? { name } : {}) },
});
const alice = { id: "users/2", name: "Alice", type: "human" } as const;

afterEach(() => { vi.restoreAllMocks(); });

describe("DM participants", () => {
  it("identifies and names a DM after its other joined participant, leaving spaces alone", async () => {
    const api = new ChatApi(async () => "token");
    const members = vi.spyOn(api, "listMembers").mockResolvedValue({
      items: [member("spaces/A", "1", "Owner"), member("spaces/A", "2", "Alice"),
        { ...member("spaces/A", "3", "Left"), state: "notMember" }],
    });
    const space = { ...dm("C"), type: "space" as const };
    expect(await describeConversation(api, space, "users/1")).toBe(space);
    expect(members).not.toHaveBeenCalled();
    expect(await describeConversation(api, dm(), "users/1"))
      .toEqual({ ...dm(), name: "Alice", peer: alice });
    expect(members).toHaveBeenCalledTimes(1);
  });

  it("falls back to the People API for a nameless human peer, and leaves an ambiguous DM undescribed", async () => {
    const api = new ChatApi(async () => "token");
    const members = vi.spyOn(api, "listMembers").mockResolvedValue({
      items: [member("spaces/A", "1", "Owner"), member("spaces/A", "2")],
    });
    const profiles = vi.spyOn(api, "profileNames")
      .mockResolvedValueOnce(new Map([["users/2", "Alice"]])).mockResolvedValueOnce(new Map());
    expect(await describeConversation(api, dm(), "users/1"))
      .toEqual({ ...dm(), name: "Alice", peer: alice });
    expect(profiles).toHaveBeenCalledWith(["users/2"]);
    expect(await describeConversation(api, dm(), "users/1"))
      .toEqual({ ...dm(), peer: { id: "users/2", type: "human" } });
    members.mockResolvedValue({ items: [member("spaces/A", "2", "Alice"), member("spaces/A", "3", "Bob")] });
    expect(await describeConversation(api, dm(), "users/1")).toEqual(dm());
    expect(profiles).toHaveBeenCalledTimes(2);
  });

  it("follows membership pages but never scans past a bounded number", async () => {
    const api = new ChatApi(async () => "token");
    const members = vi.spyOn(api, "listMembers")
      .mockResolvedValueOnce({ items: [member("spaces/A", "1", "Owner")], nextPageToken: "2" })
      .mockResolvedValueOnce({ items: [member("spaces/A", "2", "Alice")] });
    expect(await describeConversation(api, dm(), "users/1"))
      .toEqual({ ...dm(), name: "Alice", peer: alice });
    expect(members).toHaveBeenLastCalledWith("spaces/A", { pageToken: "2" });
    members.mockReset().mockResolvedValue({ items: [member("spaces/A", "2", "Alice")], nextPageToken: "more" });
    expect(await describeConversation(api, dm(), "users/1"))
      .toEqual({ ...dm(), name: "Alice", peer: alice });
    expect(members).toHaveBeenCalledTimes(3);
  });
});

describe("Group chat names", () => {
  it("labels an unnamed group chat with its first other participants, looking up the nameless in one batch", async () => {
    const api = new ChatApi(async () => "token");
    vi.spyOn(api, "listMembers").mockResolvedValue({
      items: [member("spaces/G", "1", "Owner"), member("spaces/G", "2", "Alice"), member("spaces/G", "3"),
        member("spaces/G", "4"), member("spaces/G", "5", "Eve"), member("spaces/G", "6", "Frank")],
    });
    const profiles = vi.spyOn(api, "profileNames").mockResolvedValue(new Map([["users/3", "Bob"]]));
    expect(await describeConversation(api, group(), "users/1"))
      .toEqual({ ...group(), name: "Alice, Bob, and 3 more" });
    expect(profiles).toHaveBeenCalledExactlyOnceWith(["users/3", "users/4"]);
  });

  it("counts members beyond a truncated listing, and lists a small chat in full", async () => {
    const api = new ChatApi(async () => "token");
    const members = vi.spyOn(api, "listMembers").mockResolvedValue({
      items: [member("spaces/G", "1", "Owner"), member("spaces/G", "2", "Alice"), member("spaces/G", "3", "Bob")],
    });
    vi.spyOn(api, "profileNames").mockResolvedValue(new Map());
    expect(await describeConversation(api, group(), "users/1")).toEqual({ ...group(), name: "Alice and Bob" });
    expect(await describeConversation(api, group({ memberCount: 400 }), "users/1"))
      .toEqual({ ...group({ memberCount: 400 }), name: "Alice, Bob, and 397 more" });
    members.mockClear();
    const named = group({ name: "Launch" });
    expect(await describeConversation(api, named, "users/1")).toBe(named);
    expect(members).not.toHaveBeenCalled();
  });

  it("stays unnamed when nobody can be named", async () => {
    const api = new ChatApi(async () => "token");
    vi.spyOn(api, "listMembers").mockResolvedValue({
      items: [member("spaces/G", "1", "Owner"), member("spaces/G", "2"), member("spaces/G", "3")],
    });
    vi.spyOn(api, "profileNames").mockResolvedValue(new Map());
    expect(await describeConversation(api, group(), "users/1")).toEqual(group());
  });
});
