// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { organizeChats } from "./chatOrganization";
import { chatOrganizerStorageKey } from "./chatOrganizerStore";
import { useChatOrganizer, type ChatOrganizer } from "./useChatOrganizer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const chats = [1, 2, 3].map((id) => ({ id }));
const roots: Root[] = [];

// Mounts the hook and returns a getter for its latest value.
const mount = (storageKey: string | null) => {
  let latest: ChatOrganizer | undefined;
  const Probe = () => {
    latest = useChatOrganizer(storageKey);
    return null;
  };
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() => root.render(<Probe />));
  return () => latest!;
};

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  localStorage.clear();
});

describe("useChatOrganizer", () => {
  it("shares an arrangement between lists of the same workspace and user, and no further", () => {
    const key = chatOrganizerStorageKey("user-1", "workspace-1");
    const first = mount(key);
    const second = mount(key);
    const otherWorkspace = mount(chatOrganizerStorageKey("user-1", "workspace-2"));

    act(() => first().pin(2));

    expect(organizeChats(chats, second().organization)?.pinned).toEqual([{ id: 2 }]);
    expect(organizeChats(chats, otherWorkspace().organization)).toBeNull();
  });

  it("names a new folder, keeping the default when the name is left blank", () => {
    const organizer = mount(chatOrganizerStorageKey("user-1", "workspace-1"));

    act(() => organizer().createFolder(3));
    const [folder] = organizer().organization.folders;
    expect(organizer().renamingFolderId).toBe(folder.id);
    expect(organizeChats(chats, organizer().organization)?.folders[0].chats).toEqual([{ id: 3 }]);

    act(() => organizer().finishRenamingFolder(folder.id, "   "));
    expect(organizer().renamingFolderId).toBeNull();
    expect(organizer().organization.folders[0].name).toBe("Untitled folder");

    act(() => organizer().startRenamingFolder(folder.id));
    act(() => organizer().finishRenamingFolder(folder.id, " Board deck "));
    expect(organizer().organization.folders[0].name).toBe("Board deck");
  });

  it("opens a collapsed folder when a chat is moved into it", () => {
    const organizer = mount(chatOrganizerStorageKey("user-1", "workspace-1"));
    act(() => organizer().createFolder());
    const [folder] = organizer().organization.folders;
    act(() => organizer().toggleFolder(folder.id));
    expect(organizer().organization.folders[0].collapsed).toBe(true);

    act(() => organizer().moveToFolder(2, folder.id));
    expect(organizer().organization.folders[0].collapsed).toBe(false);
  });

  it("reads unreadable stored data as an unarranged list", () => {
    const key = chatOrganizerStorageKey("user-1", "workspace-1");
    localStorage.setItem(key, "{not json");
    expect(organizeChats(chats, mount(key)().organization)).toBeNull();
  });

  it("ignores changes until it knows whose list it is", () => {
    const organizer = mount(null);
    act(() => {
      organizer().pin(1);
      organizer().createFolder();
    });
    expect(organizer().organization.folders).toEqual([]);
    expect(organizer().renamingFolderId).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});
