import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useKumoToastManager } from "@cloudflare/kumo";
import type { RpcStub } from "capnweb";
import type { AiChatMetadata, Overseer } from "@gadgets/workshop-shared/api";
import { logRpcFailure, rpcFailureDescription } from "../../rpcErrors";
import { findChatActions, findFolderToggle, findOtherToggle } from "./chatListFocus";
import { chatFolderNames } from "./chatOrganization";
import {
  DEFAULT_CHAT_LIST_VIEW,
  readChatListView,
  subscribeToChatListView,
  writeChatListView,
  type ChatListView,
} from "./chatListViewStore";

// The name being edited: a new folder for a chat, or an existing folder's.
type Naming = { newFolderFor: AiChatMetadata } | { folder: string };

// Where focus goes after a change: the first of `targets` that's on screen, once `shown` says the
// list has the change.
type FocusRequest = {
  targets: (() => HTMLElement | null)[];
  shown: (chats: readonly AiChatMetadata[]) => boolean;
};

const showsNow = () => true;

// Focus follows a moved chat to its new place, or to Other's toggle when that place is a hidden
// Other.
const focusChat = (chatId: number, placed: (chat: AiChatMetadata) => boolean): FocusRequest => ({
  targets: [() => findChatActions(chatId), findOtherToggle],
  shown: (chats) => chats.some((chat) => chat.id === chatId && placed(chat)),
});

/**
 * Pins and folders for one workspace's chat list, which the workspace keeps on each chat's
 * metadata (see AiChatMetadata.pinned and .folder), plus how this person has the list collapsed.
 * `chats` is the whole list, filters aside. A null `viewStorageKey` (no signed-in user or
 * workspace yet) collapses nothing and ignores collapsing.
 */
export const useChatOrganizer = (
  overseer: RpcStub<Overseer>,
  chats: readonly AiChatMetadata[],
  viewStorageKey: string | null,
) => {
  const view = useSyncExternalStore(
    subscribeToChatListView,
    () => (viewStorageKey === null ? DEFAULT_CHAT_LIST_VIEW : readChatListView(viewStorageKey)),
  );
  const [naming, setNaming] = useState<Naming | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const focusedRequest = useRef<FocusRequest | null>(null);
  const toasts = useKumoToastManager();

  // A change re-creates the rows it moves, so the control that started it is gone, and focus has
  // to be put somewhere. That can't happen when the change resolves: its new metadata comes
  // separately, a little before or after, so this waits until the list shows it.
  useEffect(() => {
    if (!focusRequest || focusedRequest.current === focusRequest || !focusRequest.shown(chats)) {
      return;
    }
    focusedRequest.current = focusRequest;
    focusRequest.targets.map((find) => find()).find((target) => target !== null)?.focus();
  }, [focusRequest, chats]);

  const updateView = (change: (current: ChatListView) => ChatListView) => {
    if (viewStorageKey !== null) writeChatListView(viewStorageKey, change(view));
  };
  const openFolder = (folder: string) => updateView((current) => ({
    ...current,
    collapsedFolders: current.collapsedFolders.filter((name) => name !== folder),
  }));

  const save = async (what: string, change: () => Promise<unknown>, focus: FocusRequest) => {
    try {
      await change();
      setFocusRequest(focus);
    } catch (error) {
      logRpcFailure(`Failed to ${what}:`, error);
      toasts.add({
        title: `Couldn't ${what}`,
        description: rpcFailureDescription(error),
        variant: "error",
      });
      // Nothing moved, so focus goes where the list has it now.
      setFocusRequest({ ...focus, shown: showsNow });
    }
  };

  /** Files the chat under a folder, out of Pinned so it visibly moves, and opens the folder. */
  const moveToFolder = (chat: AiChatMetadata, folder: string) => {
    openFolder(folder);
    return save(
      "move the conversation",
      // Only unpins a chat this person saw pinned, so it can't undo someone else's pin.
      () => overseer.setChatPlacement(chat.id, { folder, ...(chat.pinned && { pinned: false }) }),
      focusChat(chat.id, (moved) => moved.folder === folder && !moved.pinned),
    );
  };

  return {
    view,
    folderNames: chatFolderNames(chats),
    /** The chat a new folder is being named for, if any. */
    newFolderFor: naming && "newFolderFor" in naming ? naming.newFolderFor : null,
    /** The folder being renamed, if any. */
    renamingFolder: naming && "folder" in naming ? naming.folder : null,
    pin: (chatId: number) => save(
      "pin the conversation",
      () => overseer.setChatPlacement(chatId, { pinned: true }),
      focusChat(chatId, (chat) => chat.pinned === true),
    ),
    unpin: (chatId: number) => save(
      "unpin the conversation",
      () => overseer.setChatPlacement(chatId, { pinned: false }),
      focusChat(chatId, (chat) => !chat.pinned),
    ),
    moveToFolder,
    removeFromFolder: (chatId: number) => save(
      "move the conversation",
      () => overseer.setChatPlacement(chatId, { folder: null }),
      focusChat(chatId, (chat) => chat.folder === undefined),
    ),
    startNewFolder: (chat: AiChatMetadata) => setNaming({ newFolderFor: chat }),
    startRenamingFolder: (folder: string) => setNaming({ folder }),
    /** Ends naming. A null or blank name, or an unchanged one, changes nothing. */
    finishNaming: async (name: string | null) => {
      setNaming(null);
      if (!naming) return;
      const trimmed = name?.trim();
      if ("newFolderFor" in naming) {
        const chat = naming.newFolderFor;
        if (trimmed) return moveToFolder(chat, trimmed);
        setFocusRequest(focusChat(chat.id, showsNow));
        return;
      }
      const { folder } = naming;
      if (!trimmed || trimmed === folder) {
        setFocusRequest({ targets: [() => findFolderToggle(folder)], shown: showsNow });
        return;
      }
      if (view.collapsedFolders.includes(folder)) {
        updateView((current) => ({
          ...current,
          collapsedFolders: [...current.collapsedFolders.filter((n) => n !== folder), trimmed],
        }));
      }
      return save("rename the folder", () => overseer.renameChatFolder(folder, trimmed), {
        targets: [() => findFolderToggle(trimmed), () => findFolderToggle(folder)],
        shown: (list) => !list.some((chat) => chat.folder === folder),
      });
    },
    /** Deletes a folder for everyone in the workspace. Its chats stay, out of any folder. */
    deleteFolder: (folder: string) => save(
      "delete the folder",
      () => overseer.renameChatFolder(folder, null),
      {
        // Its chats go to Other, so focus follows them there.
        targets: [
          ...chats.filter((chat) => chat.folder === folder && !chat.pinned)
            .map((chat) => () => findChatActions(chat.id)),
          findOtherToggle,
        ],
        shown: (list) => !list.some((chat) => chat.folder === folder),
      },
    ),
    toggleFolder: (folder: string) => updateView((current) => ({
      ...current,
      collapsedFolders: current.collapsedFolders.includes(folder)
        ? current.collapsedFolders.filter((name) => name !== folder)
        : [...current.collapsedFolders, folder],
    })),
    setOtherHidden: (hidden: boolean) =>
      updateView((current) => ({ ...current, otherHidden: hidden })),
  };
};

/** The chat list's pins, folders and collapsed parts, and the ways to change them. */
export type ChatOrganizer = ReturnType<typeof useChatOrganizer>;
