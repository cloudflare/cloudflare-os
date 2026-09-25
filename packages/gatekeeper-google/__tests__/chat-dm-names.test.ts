import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatApi } from "../src/chat-api";
import { ChatDmNames, readChatProfileNames } from "../src/chat-dm-names";
import type { ChatMembership, ChatSpaceInfo } from "../src/chat-types";

const dm = (id = "A"): ChatSpaceInfo => ({ id: `spaces/${id}`, type: "directMessage", supportsThreads: false });
const member = (space: string, id: string, name?: string): ChatMembership => ({
  id: `${space}/members/${id}`, state: "joined", role: "member",
  member: { id: `users/${id}`, type: "human", ...(name ? { name } : {}) },
});
const profile = (id: string, name: string) => ({
  requestedResourceName: `people/${id}`, person: {
    resourceName: `people/${id}`, names: [{ displayName: name, metadata: { primary: true, source: { type: "PROFILE" } } }],
  },
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("DM participant names", () => {
  it("keeps named spaces and group chats cheap, and prefers Chat's peer name over the owner's", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const api = new ChatApi(async () => "token");
    const members = vi.spyOn(api, "listMembers").mockResolvedValue({
      items: [member("spaces/A", "1", "Owner"), member("spaces/A", "2", "Alice")],
    });
    const names = new ChatDmNames(api, async () => "token");
    const self = vi.fn(async () => "users/1");
    const named = { ...dm("B"), name: "Existing name" };
    const group = { ...dm("C"), type: "groupChat" as const };
    expect(await names.resolve([named, group], self)).toEqual([{ info: named }, { info: group }]);
    expect(self).not.toHaveBeenCalled();
    expect(members).not.toHaveBeenCalled();
    expect(await names.resolve([dm()], self)).toEqual([{ info: { ...dm(), name: "Alice" } }]);
    await names.resolve([dm()], self);
    expect(members).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("walks membership pages, batches only missing human names, and caches the completed DM labels", async () => {
    const api = new ChatApi(async () => "token");
    const members = vi.spyOn(api, "listMembers").mockImplementation(async (space, options) => {
      if (!options?.pageToken) return { items: [member(space, "1", "Owner")], nextPageToken: "peer" };
      return { items: [member(space, space === "spaces/A" ? "2" : "3")] };
    });
    const fetcher = vi.fn(async (input: string) => {
      const url = new URL(input);
      expect(url.searchParams.get("personFields")).toBe("names");
      expect(url.searchParams.get("sources")).toBe("READ_SOURCE_TYPE_PROFILE");
      expect(url.searchParams.getAll("resourceNames")).toEqual(["people/2", "people/3"]);
      return Response.json({ responses: [profile("3", "Bob"), profile("2", "Alice")] });
    });
    vi.stubGlobal("fetch", fetcher);
    const names = new ChatDmNames(api, async () => "token");
    const spaces = [dm(), dm("B")];
    expect(await names.resolve(spaces, async () => "users/1")).toEqual([
      { info: { ...dm(), name: "Alice" }, profile: { id: "users/2", name: "Alice" } },
      { info: { ...dm("B"), name: "Bob" }, profile: { id: "users/3", name: "Bob" } },
    ]);
    await names.resolve(spaces, async () => "users/1");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(members).toHaveBeenCalledTimes(4);
    expect(spaces).toEqual([dm(), dm("B")]);
  });

  it("retries unavailable labels after a short delay and refreshes successful names after expiry", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const api = new ChatApi(async () => "token");
    vi.spyOn(api, "listMembers").mockResolvedValue({ items: [member("spaces/A", "2")] });
    let name: string | undefined;
    const fetcher = vi.fn(async () => name
      ? Response.json({ responses: [profile("2", name)] }) : new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetcher);
    const names = new ChatDmNames(api, async () => "token");
    expect(await names.resolve([dm()], async () => "users/1")).toEqual([{ info: dm() }]);
    name = "Alice";
    expect(await names.resolve([dm()], async () => "users/1")).toEqual([{ info: dm() }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 31_000;
    expect((await names.resolve([dm()], async () => "users/1"))[0].info.name).toBe("Alice");
    name = "Renamed";
    now += 301_000;
    expect((await names.resolve([dm()], async () => "users/1"))[0].info.name).toBe("Renamed");
  });

  it("does not cross account caches or reuse cached names for observer verification", async () => {
    const api = new ChatApi(async () => "token");
    vi.spyOn(api, "listMembers").mockResolvedValue({ items: [member("spaces/A", "2")] });
    let ownerName = "Alice";
    vi.stubGlobal("fetch", async (_input: string, init: RequestInit) => Response.json({ responses: [
      profile("2", new Headers(init.headers).get("Authorization") === "Bearer owner" ? ownerName : "Other view"),
    ] }));
    const owner = new ChatDmNames(api, async () => "owner");
    const other = new ChatDmNames(api, async () => "other");
    expect((await owner.resolve([dm()], async () => "users/1"))[0].info.name).toBe("Alice");
    expect((await other.resolve([dm()], async () => "users/3"))[0].info.name).toBe("Other view");
    ownerName = "Renamed";
    expect((await readChatProfileNames(["users/2"], async () => "owner")).get("users/2")).toBe("Renamed");
  });

  it("rejects misassociated profile responses, skips contact labels, and leaves DM discovery usable", async () => {
    const api = new ChatApi(async () => "token");
    vi.spyOn(api, "listMembers").mockResolvedValue({ items: [member("spaces/A", "2")] });
    vi.stubGlobal("fetch", async () => Response.json({ responses: [{
      ...profile("2", "Wrong person"), person: profile("3", "Wrong person").person,
    }] }));
    await expect(readChatProfileNames(["users/2"], async () => "token")).rejects.toThrow(/mismatched/);
    expect(await new ChatDmNames(api, async () => "token").resolve([dm()], async () => "users/1"))
      .toEqual([{ info: dm() }]);
    vi.stubGlobal("fetch", async () => Response.json({ responses: [{
      ...profile("2", ""), person: { resourceName: "people/2", names: [
        { displayName: "Private nickname", metadata: { primary: true, source: { type: "CONTACT" } } },
      ] },
    }] }));
    expect((await readChatProfileNames(["users/2"], async () => "token")).size).toBe(0);
  });

  it("does not guess a peer from ambiguous or looping membership pages", async () => {
    const api = new ChatApi(async () => "token");
    const members = vi.spyOn(api, "listMembers").mockResolvedValue({
      items: [member("spaces/A", "2", "Alice"), member("spaces/A", "3", "Bob")],
    });
    const names = new ChatDmNames(api, async () => "token");
    expect(await names.resolve([dm()], async () => "users/1")).toEqual([{ info: dm() }]);
    members.mockResolvedValue({ items: [member("spaces/B", "2", "Alice")], nextPageToken: "repeated" });
    expect(await names.resolve([dm("B")], async () => "users/1")).toEqual([{ info: dm("B") }]);
    expect(members).toHaveBeenCalledTimes(3);
  });

  it("shares overlapping lookups rather than duplicating membership requests", async () => {
    const api = new ChatApi(async () => "token");
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const members = vi.spyOn(api, "listMembers").mockImplementation(async () => {
      await waiting;
      return { items: [member("spaces/A", "2", "Alice")] };
    });
    const names = new ChatDmNames(api, async () => "token");
    const first = names.resolve([dm()], async () => "users/1");
    const second = names.resolve([dm()], async () => "users/1");
    await vi.waitFor(() => expect(members).toHaveBeenCalledTimes(1));
    release();
    expect(await first).toEqual(await second);
    expect(members).toHaveBeenCalledTimes(1);
  });

  it("stops cold scans at the shared deadline and leaves skipped DMs eligible for the next call", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const api = new ChatApi(async () => "token");
    const members = vi.spyOn(api, "listMembers").mockImplementation(async space => {
      now += 600;
      return { items: [member(space, "2", "Alice")] };
    });
    const names = new ChatDmNames(api, async () => "token");
    const spaces = Array.from({ length: 10 }, (_, index) => dm(String(index)));
    const deadline = now + 3000;
    const first = await names.resolve(spaces, async () => "users/1", deadline);
    expect(first.filter(entry => entry.info.name)).toHaveLength(4);
    // The picker's next provider page uses the same deadline, not a fresh three seconds.
    await names.resolve([dm("next-page")], async () => "users/1", deadline);
    expect(members).toHaveBeenCalledTimes(4);
    expect((await names.resolve([spaces[4]], async () => "users/1"))[0].info.name).toBe("Alice");
    expect(members).toHaveBeenCalledTimes(5);
  });

  it("aborts optional membership requests without retry backoff", async () => {
    const fetcher = vi.fn((_input: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    const names = new ChatDmNames(new ChatApi(async () => "token"), async () => "token");
    expect(await names.resolve([dm()], async () => "users/1", Date.now() + 1020)).toEqual([{ info: dm() }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
  });
});
