import type { AiChatMetadata } from "@gadgets/workshop-shared/api";

export type ChatFolder = {
  id: string;
  name: string;
  collapsed?: boolean;
};

/** The place of a pinned chat in ChatOrganization.places. Folder ids are UUIDs, so never equal it. */
export const PINNED = "pinned";

/** How one user has arranged one workspace's chat list. */
export type ChatOrganization = {
  folders: ChatFolder[];
  /**
   * Each arranged chat's place: PINNED or a folder id. A chat with no place is in Other. Chat ids
   * are never reused, so a place left behind by a deleted chat is inert.
   */
  places: Partial<Record<number, string>>;
  otherHidden?: boolean;
};

export const EMPTY_ORGANIZATION: ChatOrganization = { folders: [], places: {} };

/** A chat list split into Pinned, each folder, and Other, keeping the input order in each. */
export type OrganizedChats<C> = {
  pinned: C[];
  folders: { folder: ChatFolder; chats: C[] }[];
  other: C[];
};

/**
 * Splits `chats` by the user's arrangement, or returns null when nothing is pinned and there are no
 * folders, so an unarranged list renders exactly as it did before the feature existed.
 */
export const organizeChats = <C extends { id: number }>(
  chats: readonly C[],
  organization: ChatOrganization,
): OrganizedChats<C> | null => {
  const folderChats = new Map(organization.folders.map((folder) => [folder.id, [] as C[]]));
  const pinned: C[] = [];
  const other: C[] = [];
  for (const chat of chats) {
    const place = organization.places[chat.id];
    if (place === PINNED) pinned.push(chat);
    else ((place !== undefined ? folderChats.get(place) : undefined) ?? other).push(chat);
  }
  if (pinned.length === 0 && organization.folders.length === 0) return null;
  return {
    pinned,
    folders: organization.folders.map((folder) => ({ folder, chats: folderChats.get(folder.id)! })),
    other,
  };
};

/**
 * Counts the chats whose rows would say Working (an agent is running) or, failing that, Pending
 * changes, so a collapsed section can still show that something inside needs a look.
 */
export const countChatStatuses = (
  chats: readonly Pick<AiChatMetadata, "activeAgent" | "proposedChangeWorkpieces">[],
) => {
  let working = 0;
  let pending = 0;
  for (const chat of chats) {
    if (chat.activeAgent) working++;
    else if (chat.proposedChangeWorkpieces?.length) pending++;
  }
  return { working, pending };
};

/** The folder holding the chat, if any. */
export const folderOfChat = (organization: ChatOrganization, chatId: number) =>
  organization.folders.find((folder) => folder.id === organization.places[chatId]);

/** Gives a chat one place (PINNED or a folder id), or returns it to Other with null. */
export const placeChat = (
  organization: ChatOrganization,
  chatId: number,
  place: string | null,
): ChatOrganization => {
  const places = { ...organization.places };
  if (place === null) delete places[chatId];
  else places[chatId] = place;
  return { ...organization, places };
};

/** Adds an empty folder at the end. */
export const addFolder = (organization: ChatOrganization, folder: ChatFolder): ChatOrganization =>
  ({ ...organization, folders: [...organization.folders, folder] });

export const updateFolder = (
  organization: ChatOrganization,
  folderId: string,
  change: (folder: ChatFolder) => ChatFolder,
): ChatOrganization => ({
  ...organization,
  folders: organization.folders.map((folder) => (folder.id === folderId ? change(folder) : folder)),
});

/** Deletes a folder. Its chats go back to Other; no chat is ever deleted with it. */
export const removeFolder = (organization: ChatOrganization, folderId: string): ChatOrganization => ({
  ...organization,
  folders: organization.folders.filter((folder) => folder.id !== folderId),
  places: Object.fromEntries(Object.entries(organization.places).filter(([, place]) => place !== folderId)),
});
