import { useState, useSyncExternalStore } from "react";
import {
  EMPTY_ORGANIZATION,
  PINNED,
  addFolder,
  placeChat,
  removeFolder,
  updateFolder,
  type ChatOrganization,
} from "./chatOrganization";
import {
  readChatOrganization,
  subscribeToChatOrganization,
  writeChatOrganization,
} from "./chatOrganizerStore";

const NEW_FOLDER_NAME = "Untitled folder";

/**
 * One workspace's chat arrangement and the ways to change it. A null `storageKey` (no signed-in
 * user or workspace yet) reads as unarranged and ignores changes.
 */
export const useChatOrganizer = (storageKey: string | null) => {
  const organization = useSyncExternalStore(
    subscribeToChatOrganization,
    () => (storageKey === null ? EMPTY_ORGANIZATION : readChatOrganization(storageKey)),
  );
  // The folder whose name is being edited; a new folder starts here.
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);

  const update = (change: (current: ChatOrganization) => ChatOrganization) => {
    if (storageKey !== null) writeChatOrganization(storageKey, change(readChatOrganization(storageKey)));
  };

  return {
    organization,
    renamingFolderId,
    pin: (chatId: number) => update((o) => placeChat(o, chatId, PINNED)),
    /** Moves the chat into a folder, opening the folder so the chat stays in view. */
    moveToFolder: (chatId: number, folderId: string) => update((o) =>
      updateFolder(placeChat(o, chatId, folderId), folderId, (folder) => ({ ...folder, collapsed: false }))),
    /** Unpins the chat or takes it out of its folder. */
    moveToOther: (chatId: number) => update((o) => placeChat(o, chatId, null)),
    /** Creates a folder, optionally moving a chat into it, and starts naming it. */
    createFolder: (chatId?: number) => {
      if (storageKey === null) return;
      const id = crypto.randomUUID();
      update((o) => {
        const added = addFolder(o, { id, name: NEW_FOLDER_NAME });
        return chatId === undefined ? added : placeChat(added, chatId, id);
      });
      setRenamingFolderId(id);
    },
    startRenamingFolder: (folderId: string) => setRenamingFolderId(folderId),
    /** Ends naming; a null or blank name keeps the current one. */
    finishRenamingFolder: (folderId: string, name: string | null) => {
      const trimmed = name?.trim();
      if (trimmed) update((o) => updateFolder(o, folderId, (folder) => ({ ...folder, name: trimmed })));
      setRenamingFolderId(null);
    },
    deleteFolder: (folderId: string) => update((o) => removeFolder(o, folderId)),
    toggleFolder: (folderId: string) =>
      update((o) => updateFolder(o, folderId, (folder) => ({ ...folder, collapsed: !folder.collapsed }))),
    setOtherHidden: (hidden: boolean) => update((o) => ({ ...o, otherHidden: hidden })),
  };
};

export type ChatOrganizer = ReturnType<typeof useChatOrganizer>;
