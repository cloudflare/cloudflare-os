// How one person has the chat list collapsed: which folders, and whether Other is hidden. Unlike
// pins and folders, which belong to the workspace, this is a view preference, so like the app's
// other view preferences it stays in this browser.

const STORAGE_PREFIX = "gadgets:chat-list-view:v1";

/** The storage key for one user's view of one workspace's chat list. */
export const chatListViewStorageKey = (userId: string, workspaceId: string) =>
  `${STORAGE_PREFIX}:${userId}:${workspaceId}`;

/** Which parts of the chat list are collapsed. Folders are named as in AiChatMetadata.folder. */
export type ChatListView = { collapsedFolders: string[]; otherHidden: boolean };

/** Nothing collapsed. */
export const DEFAULT_CHAT_LIST_VIEW: ChatListView = { collapsedFolders: [], otherHidden: false };

// The session's views, which also give useSyncExternalStore a stable snapshot. A view whose save
// failed still applies here until reload.
const views = new Map<string, ChatListView>();
const listeners = new Set<() => void>();

const parse = (raw: string | null): ChatListView => {
  if (raw === null) return DEFAULT_CHAT_LIST_VIEW;
  try {
    const value = JSON.parse(raw) as Partial<ChatListView> | null;
    return {
      collapsedFolders: Array.isArray(value?.collapsedFolders)
        ? value.collapsedFolders.filter((name): name is string => typeof name === "string")
        : [],
      otherHidden: value?.otherHidden === true,
    };
  } catch {
    return DEFAULT_CHAT_LIST_VIEW;
  }
};

/** The saved view for `key`, or nothing collapsed. */
export const readChatListView = (key: string): ChatListView => {
  let view = views.get(key);
  if (!view) {
    view = parse(localStorage.getItem(key));
    views.set(key, view);
  }
  return view;
};

/** Applies a view, and saves it if this browser's storage allows. */
export const writeChatListView = (key: string, view: ChatListView) => {
  views.set(key, view);
  try {
    localStorage.setItem(key, JSON.stringify(view));
  } catch {
    // Storage full or blocked: like the app's other view preferences, it lasts until reload.
  }
  for (const listener of listeners) listener();
};

/** Calls `listener` whenever a view changes, until the returned function is called. */
export const subscribeToChatListView = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
