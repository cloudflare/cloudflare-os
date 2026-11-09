import { describe, expect, it } from "vitest";
import { chatFolderNames, countChatStatuses, organizeChats } from "./chatOrganization";

type Chat = { id: number; pinned?: boolean; folder?: string };

// Newest first, as the chat list orders them.
const chats: Chat[] = [
  { id: 1, folder: "Vendors" },
  { id: 2, pinned: true },
  { id: 3 },
  { id: 4, folder: "Board deck" },
  { id: 5, folder: "Board deck", pinned: true },
  { id: 6, folder: "Board deck" },
];
const ids = (list: Chat[]) => list.map((chat) => chat.id);

describe("organizeChats", () => {
  it("leaves an unarranged list alone, so it renders exactly as before", () => {
    expect(organizeChats<Chat>([{ id: 1 }, { id: 2 }])).toBeNull();
  });

  it("keeps the sections while a first folder is being named", () => {
    expect(organizeChats<Chat>([{ id: 1 }], true)).toEqual({ pinned: [], folders: [], other: [{ id: 1 }] });
  });

  it("splits chats into Pinned, folders in name order, and Other, keeping recency order", () => {
    const sections = organizeChats(chats)!;
    expect(ids(sections.pinned)).toEqual([2, 5]);
    expect(sections.folders.map(({ name, chats: inFolder }) => [name, ids(inFolder)])).toEqual([
      ["Board deck", [4, 6]],
      ["Vendors", [1]],
    ]);
    expect(ids(sections.other)).toEqual([3]);
  });

  it("shows a pinned chat only under Pinned, while it stays among its folder's names", () => {
    const onlyPinned: Chat[] = [{ id: 1, folder: "Vendors", pinned: true }, { id: 2 }];
    expect(organizeChats(onlyPinned)!.folders).toEqual([]);
    expect(chatFolderNames(onlyPinned)).toEqual(["Vendors"]);
  });
});

describe("chatFolderNames", () => {
  it("names each folder once, in name order", () => {
    expect(chatFolderNames(chats)).toEqual(["Board deck", "Vendors"]);
  });
});

describe("countChatStatuses", () => {
  it("counts a chat that is working and has pending changes once, as working, like its row", () => {
    const agent = { type: "agent" as const, id: "model", name: "Model" };
    expect(countChatStatuses([
      { activeAgent: agent },
      { activeAgent: agent, proposedChangeWorkpieces: [7] },
      { proposedChangeWorkpieces: [8, 9] },
      { proposedChangeWorkpieces: [] },
      {},
    ])).toEqual({ working: 2, pending: 1 });
  });
});
