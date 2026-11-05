import { describe, expect, it } from "vitest";
import {
  EMPTY_ORGANIZATION,
  PINNED,
  addFolder,
  countChatStatuses,
  organizeChats,
  placeChat,
  removeFolder,
  type ChatOrganization,
} from "./chatOrganization";

// Newest first, as the chat list orders them.
const chats = [1, 2, 3, 4, 5].map((id) => ({ id }));
const ids = (list: { id: number }[]) => list.map((chat) => chat.id);

const arranged: ChatOrganization = {
  folders: [{ id: "board", name: "Board deck" }, { id: "vendors", name: "Vendors" }],
  places: { 2: PINNED, 4: "board", 1: "vendors", 5: "board" },
};

describe("organizeChats", () => {
  it("leaves an unarranged list alone, so it renders exactly as before", () => {
    expect(organizeChats(chats, EMPTY_ORGANIZATION)).toBeNull();
    // A pin left by a chat that no longer exists does not arrange the list either.
    expect(organizeChats(chats, { folders: [], places: { 99: PINNED } })).toBeNull();
  });

  it("splits chats into Pinned, each folder in order, and Other, keeping recency order", () => {
    const sections = organizeChats(chats, arranged)!;
    expect(ids(sections.pinned)).toEqual([2]);
    expect(sections.folders.map(({ folder, chats: inFolder }) => [folder.name, ids(inFolder)])).toEqual([
      ["Board deck", [4, 5]],
      ["Vendors", [1]],
    ]);
    expect(ids(sections.other)).toEqual([3]);
  });

  it("keeps an empty folder visible", () => {
    const sections = organizeChats(chats, addFolder(EMPTY_ORGANIZATION, { id: "new", name: "New folder" }))!;
    expect(sections.folders).toEqual([{ folder: { id: "new", name: "New folder" }, chats: [] }]);
    expect(ids(sections.other)).toEqual([1, 2, 3, 4, 5]);
  });

  it("shows a chat whose folder is gone in Other", () => {
    const sections = organizeChats(chats, { ...arranged, folders: [arranged.folders[0]] })!;
    expect(ids(sections.other)).toEqual([1, 3]);
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

describe("arranging chats", () => {
  it("gives each chat a single place", () => {
    const moved = placeChat(arranged, 2, "vendors");
    const sections = organizeChats(chats, moved)!;
    expect(ids(sections.pinned)).toEqual([]);
    expect(ids(sections.folders[1].chats)).toEqual([1, 2]);

    expect(ids(organizeChats(chats, placeChat(moved, 2, null))!.other)).toEqual([2, 3]);
  });

  it("returns a deleted folder's chats to Other without touching anything else", () => {
    const sections = organizeChats(chats, removeFolder(arranged, "board"))!;
    expect(sections.folders.map(({ folder }) => folder.id)).toEqual(["vendors"]);
    expect(ids(sections.pinned)).toEqual([2]);
    expect(ids(sections.other)).toEqual([3, 4, 5]);
  });
});
