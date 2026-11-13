// Moving a chat, or renaming or deleting a folder, re-creates the rows involved, so the control
// that had focus is gone by the time a menu would return focus to it. These find where focus
// should go instead (see useChatOrganizer).

/** A chat row's actions button. */
export const findChatActions = (chatId: number) =>
  document.querySelector<HTMLElement>(`[data-chat-actions="${chatId}"]`);

/** A folder's header toggle. */
export const findFolderToggle = (folder: string) =>
  [...document.querySelectorAll<HTMLElement>("[data-chat-folder]")]
    .find((toggle) => toggle.dataset.chatFolder === folder) ?? null;

/** Other's toggle, for a chat that went into a hidden Other. */
export const findOtherToggle = () => document.querySelector<HTMLElement>("[data-chat-other-toggle]");
