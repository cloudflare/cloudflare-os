import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatApi } from "../src/chat-api";
import { nameDirectMessage } from "../src/chat-dm-names";
import type { ChatMembership, ChatSpaceInfo } from "../src/chat-types";

const dm = (id = "A"): ChatSpaceInfo => ({ id: `spaces/${id}`, type: "directMessage", supportsThreads: false });
const member = (space: string, id: string, name?: string): ChatMembership => ({
  id: `${space}/members/${id}`, state: "joined", role: "member",
  member: { id: `users/${id}`, type: "human", ...(name ? { name } : {}) },
});

afterEach(() => { vi.restoreAllMocks(); });

describe("DM participant names", () => {
  it("names an unnamed DM after its other joined participant, leaving other spaces alone", async () => {
    const api = new ChatApi(async () => "token");
    const members = vi.spyOn(api, "listMembers").mockResolvedValue({
      items: [member("spaces/A", "1", "Owner"), member("spaces/A", "2", "Alice"),
        { ...member("spaces/A", "3", "Left"), state: "notMember" }],
    });
    const named = { ...dm("B"), name: "Existing name" };
    const group = { ...dm("C"), type: "groupChat" as const };
    expect(await nameDirectMessage(api, named, "users/1")).toBe(named);
    expect(await nameDirectMessage(api, group, "users/1")).toBe(group);
    expect(members).not.toHaveBeenCalled();
    expect(await nameDirectMessage(api, dm(), "users/1")).toEqual({ ...dm(), name: "Alice" });
    expect(members).toHaveBeenCalledTimes(1);
  });

  it("leaves a DM unnamed when Chat omits the peer's name or the peer is ambiguous", async () => {
    const api = new ChatApi(async () => "token");
    const members = vi.spyOn(api, "listMembers").mockResolvedValue({
      items: [member("spaces/A", "1", "Owner"), member("spaces/A", "2")],
    });
    expect(await nameDirectMessage(api, dm(), "users/1")).toEqual(dm());
    members.mockResolvedValue({ items: [member("spaces/A", "2", "Alice"), member("spaces/A", "3", "Bob")] });
    expect(await nameDirectMessage(api, dm(), "users/1")).toEqual(dm());
  });

  it("follows membership pages but never scans past a DM's plausible size", async () => {
    const api = new ChatApi(async () => "token");
    const members = vi.spyOn(api, "listMembers")
      .mockResolvedValueOnce({ items: [member("spaces/A", "1", "Owner")], nextPageToken: "2" })
      .mockResolvedValueOnce({ items: [member("spaces/A", "2", "Alice")] });
    expect(await nameDirectMessage(api, dm(), "users/1")).toEqual({ ...dm(), name: "Alice" });
    expect(members).toHaveBeenLastCalledWith("spaces/A", { pageToken: "2" });
    members.mockReset().mockResolvedValue({ items: [member("spaces/A", "2", "Alice")], nextPageToken: "more" });
    expect(await nameDirectMessage(api, dm(), "users/1")).toEqual({ ...dm(), name: "Alice" });
    expect(members).toHaveBeenCalledTimes(3);
  });
});
