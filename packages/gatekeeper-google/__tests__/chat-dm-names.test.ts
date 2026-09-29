import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatApi } from "../src/chat-api";
import { describeDirectMessage } from "../src/chat-dm-names";
import type { ChatMembership, ChatSpaceInfo } from "../src/chat-types";

const dm = (id = "A"): ChatSpaceInfo => ({ id: `spaces/${id}`, type: "directMessage", supportsThreads: false });
const member = (space: string, id: string, name?: string): ChatMembership => ({
  id: `${space}/members/${id}`, state: "joined", role: "member", kind: "user",
  user: { id: `users/${id}`, type: "human", ...(name ? { name } : {}) },
});
const alice = { id: "users/2", name: "Alice", type: "human" } as const;

afterEach(() => { vi.restoreAllMocks(); });

describe("DM participants", () => {
  it("identifies and names a DM after its other joined participant, leaving group chats alone", async () => {
    const api = new ChatApi(async () => "token");
    const members = vi.spyOn(api, "listMembers").mockResolvedValue({
      items: [member("spaces/A", "1", "Owner"), member("spaces/A", "2", "Alice"),
        { ...member("spaces/A", "3", "Left"), state: "notMember" }],
    });
    const group = { ...dm("C"), type: "groupChat" as const };
    expect(await describeDirectMessage(api, group, "users/1")).toBe(group);
    expect(members).not.toHaveBeenCalled();
    expect(await describeDirectMessage(api, dm(), "users/1"))
      .toEqual({ ...dm(), name: "Alice", peer: alice });
    expect(members).toHaveBeenCalledTimes(1);
  });

  it("falls back to the People API for a nameless human peer, and leaves an ambiguous DM undescribed", async () => {
    const api = new ChatApi(async () => "token");
    const members = vi.spyOn(api, "listMembers").mockResolvedValue({
      items: [member("spaces/A", "1", "Owner"), member("spaces/A", "2")],
    });
    const profile = vi.spyOn(api, "profileName").mockResolvedValueOnce("Alice").mockResolvedValueOnce(undefined);
    expect(await describeDirectMessage(api, dm(), "users/1"))
      .toEqual({ ...dm(), name: "Alice", peer: alice });
    expect(profile).toHaveBeenCalledWith("users/2");
    expect(await describeDirectMessage(api, dm(), "users/1"))
      .toEqual({ ...dm(), peer: { id: "users/2", type: "human" } });
    members.mockResolvedValue({ items: [member("spaces/A", "2", "Alice"), member("spaces/A", "3", "Bob")] });
    expect(await describeDirectMessage(api, dm(), "users/1")).toEqual(dm());
    expect(profile).toHaveBeenCalledTimes(2);
  });

  it("follows membership pages but never scans past a DM's plausible size", async () => {
    const api = new ChatApi(async () => "token");
    const members = vi.spyOn(api, "listMembers")
      .mockResolvedValueOnce({ items: [member("spaces/A", "1", "Owner")], nextPageToken: "2" })
      .mockResolvedValueOnce({ items: [member("spaces/A", "2", "Alice")] });
    expect(await describeDirectMessage(api, dm(), "users/1"))
      .toEqual({ ...dm(), name: "Alice", peer: alice });
    expect(members).toHaveBeenLastCalledWith("spaces/A", { pageToken: "2" });
    members.mockReset().mockResolvedValue({ items: [member("spaces/A", "2", "Alice")], nextPageToken: "more" });
    expect(await describeDirectMessage(api, dm(), "users/1"))
      .toEqual({ ...dm(), name: "Alice", peer: alice });
    expect(members).toHaveBeenCalledTimes(3);
  });
});
